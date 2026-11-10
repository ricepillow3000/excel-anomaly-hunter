// Browser test of the REAL pane against the REAL engine, with fake-office.js standing in for Excel.
// Run via e2e/all.sh (needs node + playwright with chromium, and the repo's .venv). Modes: flow ai nokey.
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
const DOWN_AT_START = "Arcas has stopped. Wait half a minute and press Try again. If that doesn't work, open your Downloads folder, double-click Arcas.exe, then press Try again.";
const dropMidway = async (r) => { await new Promise((go) => setTimeout(go, 300)); await r.abort("connectionreset"); }; // sent, then the engine is gone
const scans = []; // every /scan body the pane sent: the slider's level and the Power BI switch must reach the engine
page.on("request", (r) => r.url().endsWith("/scan") && scans.push(JSON.parse(r.postData())));
// every POST the pane makes, in order ([path, body]), and every /scan answer as the engine sent it: each control must
// call exactly the engine it says it does, and show exactly what the engine answered (AH-11)
const calls = [];
page.on("request", (r) => r.method() === "POST" && calls.push([new URL(r.url()).pathname, JSON.parse(r.postData() || "null")]));
const replies = [];
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
// the recorder itself can fail: a planted rejection and a planted throw are both heard, then forgotten
await failing(/e2e recorder probe/, async () => {
  await page.evaluate(() => { Promise.reject(new Error("e2e recorder probe")); setTimeout(() => { throw new Error("e2e recorder probe"); }); });
  await page.waitForTimeout(300);
});
ok(unhandled.length === 2 && unhandled.some((u) => u.startsWith("unhandledrejection")) && unhandled.some((u) => u.startsWith("error")), "the page's recorder hears an unhandled rejection and an uncaught error - " + JSON.stringify(unhandled));
errors.splice(0, Infinity, ...errors.filter((e) => !/e2e recorder probe/.test(e))); unhandled.length = 0;
const text = (sel) => page.textContent(sel);
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
    new MutationObserver((_, mo) => { mo.disconnect(); __arrive = [...document.getElementById("flagged-list").children].slice(0, 12).map((li) => li.getAnimations().map((a) => [a.effect.getTiming().delay, Object.keys(a.effect.getKeyframes()[0]).filter((k) => !["offset", "easing", "composite", "computedOffset"].includes(k))])); })
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
  await page.click("#scan");
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
  await idle();
  ok(await page.isVisible("#results"), "results after ONE click");
  { const box = await page.evaluate(() => { const r = document.querySelector("#flagged-list button").getBoundingClientRect(); return [r.left, r.width, r.height]; });
    const gone = await page.evaluate(() => document.getElementById("scan-skeleton")?.offsetParent === null && !document.getElementById("main-ui").hasAttribute("data-scanning"));
    const held = await shown();
    ok(gone && Math.abs(box[0] - sk.box[0]) < 0.5 && Math.abs(box[1] - sk.box[1]) < 0.5 && Math.abs(box[2] - sk.box[2]) <= 3 && held.length === 1 && held[0] >= 440,
      `the skeleton goes when the results land, its first row where the real first row is (skeleton ${sk.box.map(Math.round)}, real ${box.map(Math.round)}), shown ${held.map(Math.round)} ms`); }
  await shot("landed");
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
    ok(h.hint === "Recommended. Plus unusual mixes of values across columns." && !h.open && h.summary === "How we tested this level"
      && /^We tested it on \d+ practice sheets with \d+ mistakes hidden in them\. It found .* rows that were fine/.test(h.tested),
      "AH-149 review: under the slider, what the level does in one short line; what it did on the bench under \"How we tested this level\", closed - " + JSON.stringify(h)); }
  ok((await page.getAttribute("#strength", "aria-valuetext")) === "5 of 10, Recommended", "AH-149: the slider tells a screen reader its level's word - " + (await page.getAttribute("#strength", "aria-valuetext")));
  ok(since(c0) === "/scan" && calls[c0][1].strength === 5 && calls[c0][1].power_bi === false, "Find problems sends exactly one /scan, at the slider's level - " + since(c0));
  { const m = await matchesEngine(); ok(m.ok, "the list is exactly what the engine answered: each flagged row, its severity in words and its reason - " + m.why); }
  ok((await text("#summary")).startsWith("5 of 300 rows look wrong."), "summary in plain words - " + (await text("#summary")));
  ok(/^Done in \d+ seconds?\.$/.test(await text("#notice")), "says when it is done - " + (await text("#notice")));
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
    await page.mouse.move(1, 1); await page.focus("#strength-tested summary"); await page.keyboard.press("Tab"); await page.waitForTimeout(600); // from the control before the list: since the AH-149 review, "How we tested this level"
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
    await watchVt();
    await back(); await vtDone();
    const home = await page.evaluate(() => ({ vt: __vt.some(Boolean), names: [...document.querySelectorAll(".row-head, #fix-title")].map((e) => getComputedStyle(e).viewTransitionName).filter((n) => n !== "none") }));
    ok(home.vt && !home.names.length && (await page.isVisible("#results")), `AH-149: Back flies the title home to row ${r} - ` + JSON.stringify(home));
  }

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
  await page.click("#fix-apply"); await idle();
  ok((await cell("C11")).v !== -5 && (await page.isVisible("#fix-undo")) && (await text("#fix-apply")) === "Accepted", "Accept writes the cell");
  ok(since(c1) === "/check" && calls[c1][1].row_index === 9, "Accept asks the engine once, /check for that row (never a full /scan) - " + since(c1));
  ok(await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).includes("fixed")), "Accept keeps the decision in the workbook");
  ok((await wrote()) === "Sales!C11", "Accept wrote exactly the one targeted cell, nothing else - " + (await wrote()));
  ok((await text("#fix-status")).includes("looks right now"), "checker re-scanned the fixed row - " + (await text("#fix-status")));
  ok(await page.evaluate(() => document.getElementById("fix-status").classList.contains("tick")), "AH-149: a fix that checks out gets a check mark, once");
  ok((await cell("C11")).fill === "#00B050" && (await cell("E11")).fill === "#00B050", "fixed row: highlight gone, the user's own green back");
  ok(await page.isVisible("#fix-next") && !(await page.isVisible("#fix-dismiss")), "then Undo / Next row");
  await back();
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

  // 4) Remove highlights puts back exactly what was there (the user's green row 11 too)
  await back();
  ok((await text("#flagged-list")).includes("Dismissed"), "the dismissed row is marked in the list");
  await page.click("#clear-highlights"); await idle();
  const after = await page.evaluate(() => ["A11", "A22", "B22", "A51"].map((a) => __cell("Sales", a).fill));
  ok(after[0] === "#00B050" && after[1] === null && after[2] === "#00B0F0" && after[3] === null, "Remove highlights restores the old fills, cell by cell on a two-color row - " + after);
  ok((await text("#notice")).startsWith("Highlights removed"), "and says so");

  // 5) ...also after the pane was closed and reopened (no memory of what it painted)
  await find();
  // ...and a whole row painted by a pane from before AH-40, in Excel's very colors
  await page.evaluate(() => { __state.painted = null; __fill("Sales", "A30", "#00B050"); __fill("Sales", "D40", "#FFC7CE"); for (const c of "ABCDE") __fill("Sales", c + "60", "#FFEB9C"); });
  await page.click("#clear-highlights"); await idle();
  const cleared = await page.evaluate(() => ["C11", "A51", "B81", "A30", "D40", "A60", "E60"].map((a) => __cell("Sales", a).fill));
  ok(cleared.slice(0, 3).every((f) => f === null) && cleared[3] === "#00B050", "reopened pane: only OUR colors are removed - " + cleared);
  ok(cleared[4] === "#FFC7CE", "a single cell in Excel's own 'Bad' style (same pink) is the user's, and stays");
  ok(cleared[5] === null && cleared[6] === null, "a whole row an older pane painted is ours too, and goes");

  // 6) limits: plain words, bad input refused, saving rescans, "Back to automatic" resets
  const openStrict = () => page.locator("details.more:has(#edit-limits)").evaluate((d) => (d.open = true));
  await openStrict();
  await page.click("#edit-limits");
  const units = page.locator('#limits-rows .limits-row[data-column="Units"] input');
  await contrast("the limits editor");
  await units.nth(0).fill("200"); await units.nth(1).fill("100"); await page.click("#save-limits");
  ok((await text("#limits-error")).includes('"Flag below" is bigger than "Flag above"') && (await page.isVisible("#limits-editor")), "low above high is refused");
  await units.nth(0).fill("-10"); await units.nth(1).fill("10000"); await page.click("#save-limits"); await idle();
  ok(!(await text("#flagged-list")).includes("Units is 7777"), "saved limits are used at once");
  ok(await page.evaluate(() => Object.keys(__settings.anomalyHunterLimits).join() === "Units"), "only the changed column is saved");
  await openStrict();
  await page.click("#edit-limits"); await page.click("#auto-limits"); await idle();
  ok(await page.evaluate(() => __settings.anomalyHunterLimits === undefined) && (await text("#flagged-list")).includes("Units is 7777"), "Back to automatic");

  // 6b) the strength slider, driven by a real mouse: press the thumb, drag, let go -> re-check; 0 = basics only,
  // saved in the workbook; 5 brings everything back
  // a mouse can only drag what is on screen: bring the slider into view first, as a person scrolls up to it
  const track = async () => { await page.locator("#strength").scrollIntoViewIfNeeded(); const b = await page.locator("#strength").boundingBox(); return { x: (v) => b.x + (b.width * v) / 10, y: b.y + b.height / 2 }; };
  const slide = async (from, to) => { const t = await track(); await page.mouse.move(t.x(from), t.y); await page.mouse.down(); await page.mouse.move(t.x(to), t.y, { steps: 8 }); await page.mouse.up(); };
  const level = () => page.getAttribute("#strength", "aria-valuenow");
  const listed5 = (await page.$$("#flagged-list li")).length;
  const s0 = scans.length;
  await watchSkeleton();
  await slide(5, 0); await idle();
  ok((await shown()).length === 1, "a slider re-check shows the scan skeleton too (no hold: it never waits for it) - " + (await shown()).map(Math.round));
  await page.waitForTimeout(800); // room for a second, unwanted re-scan to show up
  ok(scans.slice(s0).map((b) => b.strength).join() === "0", "a drag to 0 causes exactly one re-scan, at 0 - " + scans.slice(s0).map((b) => b.strength));
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
  await page.focus("#strength"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  ok((await level()) === "5", "arrow keys move it one step at a time");
  // capped wait: a pane that never checks 5 must fail the named check below, not stop the run on a timeout
  await page.waitForFunction(() => __state.lastStrength === 5 && !document.getElementById("scan").disabled, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800); await idle();
  // the design (pages/strength.js): one check at a time, and a level chosen meanwhile gets exactly one more check, with
  // the newest level. The first key starts a check at 7 at once; the next two only queue one more, at 5; 6 is never checked
  ok(scans.slice(s2).map((b) => b.strength).join() === "7,5" && (await page.evaluate(() => __settings.anomalyHunterStrength)) === 5,
    "three quick arrow keys: the check the first key started, then exactly one more at the newest level (5), and 5 saved - " + scans.slice(s2).map((b) => b.strength));
  { const m = await matchesEngine(); ok(m.ok, "at 5 the list is exactly what the engine answered at 5 - " + m.why); }
  ok((await page.$$("#flagged-list li")).length === listed5 && (await text("#strength-val")) === "5 of 10" && (await page.evaluate(() => __state.lastStrength)) === 5,
    "back to 5: the same rows as before");
  // AH-127: two slider steps while a check runs gave the sheet three checks, 5, 7 and 7: the second step queued a
  // re-check at the level the first one's re-check had already used
  const s3 = scans.length;
  await page.click("#scan");
  await page.focus("#strength"); await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
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
  const book = await page.evaluate(() => JSON.stringify(__settings.anomalyHunterDecisions));
  ok(/^\{"Sales":\{("[0-9a-z]{1,11}\.\d+":"(fixed|dismissed)",?){2}\}\}$/.test(book), "only codes, never a cell value - " + book);
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" });
  ok((await cell("C11")).v !== -5, "the reloaded pane sees the same workbook (the fix is in the cell)");
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
  const BOOK = ["anomalyHunterLimits", "anomalyHunterStrength", "anomalyHunterAutoUndo", "anomalyHunterAcceptUndo", "anomalyHunterDecisions", "Office.AutoShowTaskpaneWithDocument"];
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
  await page.reload(); await page.waitForSelector("#main-ui", { state: "visible" });
  ok((await held()).length === 0 && (await sheetNow()) === cellsBefore, "after a reload the workbook holds none of them, and every cell is as it was");
  await find();
  ok((await tag(22)) === "Probably wrong" && (await text("#strength-val")) === "5 of 10" && (await text("#flagged-list")).includes("Units is 7777"),
    `the next scan: row 22 is no longer Dismissed, the slider is back at 5, the automatic limits are used - ${await tag(22)}`);
  await page.locator("details.more:has(#forget-book)").evaluate((d) => (d.open = true));
  await page.click("#forget-book"); await idle(); // the scan saved the pane's opening setting again: only that goes now
  ok((await text("#forget-state")) === "Removed from this workbook: the setting that opens this pane with the file. Your cells are as they were. Save the workbook to keep the change in the file; the next scan saves the setting that opens this pane again.",
    "a second Forget names only what was there - " + (await text("#forget-state")));

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
  await page.focus("#strength");
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
  ok((await text("#notice")) === "Something went wrong: " + BROKE && !(await page.evaluate(() => document.getElementById("clear-highlights").disabled)),
    "an engine error is said in plain words, and the pane is usable again - " + (await text("#notice")));

  // 7c) the engine goes down mid-scan (the request is sent, then the connection drops): plain words that name the file
  // most people have (the exe; install.bat only in a source folder or an invite kit), and the pane is usable again
  await failing(DROPPED, async () => { await page.route("**/scan", dropMidway, { times: 1 }); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === "Something went wrong: " + DOWN && !(await page.evaluate(() => document.getElementById("scan").disabled)),
    "the engine down mid-scan: said in plain words, buttons back - " + (await text("#notice")));
  // an engine from before a route existed answers 404 with no words of ours: told to update, naming the exe too
  await failing(/status of 404|out of date/, async () => { await page.route("**/scan", (r) => r.fulfill({ status: 404, body: "" }), { times: 1 }); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === "Something went wrong: the checker is out of date. Close Excel, then run the newest Arcas.exe (from a source folder: install.bat).",
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

  // 8) an empty sheet gets a plain message, not an error
  await page.evaluate(() => __load("Empty", [["only a header"]]));
  await page.click("#scan"); await idle();
  ok((await text("#notice")).startsWith("Not enough data here."), "empty sheet explained");

  // 8b) AH-111: a sheet with nothing wrong says so and shows no list. Under "No problems found in 60 rows." it showed
  // "Worst first. Click a row to see what's wrong...", an empty framed list and Remove highlights. The next scan that
  // flags rows brings them back
  const listBits = () => page.evaluate(() => ["list-hint", "flagged-list", "clear-highlights", "list-title"].map((id) => document.getElementById(id)?.checkVisibility() ? id : "").filter(Boolean).join());
  await page.evaluate(() => __load("Clean", [["Item", "Units", "Cost"], ...Array.from({ length: 60 }, (_, k) => [["Pen", "Pad", "Ink"][k % 3], 40 + ((k * 7) % 23), +(1.99 + (k % 4)).toFixed(2)])]));
  await find();
  ok((await text("#summary")) === "No problems found in 60 rows." && (await listBits()) === "", "a clean sheet: the summary alone, no hint, no empty list, no Remove highlights - " + (await listBits()));
  ok(await page.evaluate(() => document.getElementById("summary").classList.contains("tick") && getComputedStyle(document.getElementById("summary"), "::after").animationIterationCount === "1"),
    "AH-149: a sheet with no problem ends on a check mark, drawn once");
  await page.evaluate(() => __activate("Sales")); await find();
  ok((await listBits()) === "list-hint,flagged-list,clear-highlights,list-title", "the next scan that flags rows shows the list again - " + (await listBits()));

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
    const list = await page.evaluate(() => ({ buttons: document.querySelectorAll("#flagged-list button").length, more: [...document.querySelectorAll("#flagged-list .more-rows")].map((li) => li.textContent) }));
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
        dismissed: () => !document.getElementById("fix-title").textContent.startsWith("Row 22:") && __state.decided[20] === "dismissed" }[check];
      let t0 = 0;
      document.addEventListener("click", () => (t0 = performance.now()), { capture: true, once: true });
      const f = () => (t0 && seen() ? done(performance.now() - t0) : t0 && performance.now() - t0 > 3000 ? done(Infinity) : requestAnimationFrame(f));
      requestAnimationFrame(f);
      document.querySelector(sel).click();
    }), [sel, check]);
    // the card's buttons stay where they are drawn when its fix arrives late
    await page.evaluate(() => (window.__slow = 300));
    await page.evaluate(() => { window.__btn = []; const f = () => { const b = document.getElementById("fix-dismiss"); if (b.checkVisibility() && document.getElementById("fix-view").checkVisibility()) __btn.push(b.offsetTop); if (!window.__btnStop) requestAnimationFrame(f); }; window.__btnStop = false; requestAnimationFrame(f); });
    await page.click('#flagged-list button:has-text("Row 22 ")'); await idle();
    await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent);
    await page.waitForTimeout(300);
    const at = await page.evaluate(() => { window.__btnStop = true; return __btn; });
    ok(at.length > 10 && Math.max(...at) === Math.min(...at), `AH-149: the card's buttons stay where they are when its fix arrives ${300 * 2} ms late - ${at.length} frames, ${Math.min(...at)} to ${Math.max(...at)} px`);
    const w0 = await page.evaluate(() => __log.length);
    const ms = await pressed("#fix-apply", "writing");
    const others = await page.evaluate(() => ({ scan: document.getElementById("scan").disabled, faded: [...document.querySelectorAll("#main-ui button")].filter((b) => b.checkVisibility() && getComputedStyle(b).opacity !== "1").map((b) => b.id || b.textContent) }));
    ok(ms < 100 && !others.scan && !others.faded.length, `AH-149: Accept says "Writing to your sheet…" on its card in ${Math.round(ms)} ms, only the card's buttons off, nothing faded - ` + JSON.stringify(others));
    await idle();
    ok((await page.evaluate((n) => __log.length - n, w0)) === 1 && (await text("#fix-status")).startsWith("Accepted"), "and once Excel has it, the card says what the sheet holds - " + (await text("#fix-status")));
    await page.click("#fix-undo"); await idle();
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
    const secs = await page.waitForFunction(() => /^Step 2 of 3: checking 300 rows… 2 s$/.test(document.getElementById("busy-line").textContent), null, { timeout: 8000 }).then(() => true, () => false);
    await idle();
    ok(secs, "AH-149: while the engine checks, the progress line counts the seconds it has taken"); }

  // 9) the engine down when the pane opens: the pane says so, and Try again brings it back once it answers.
  // Every /health is refused until the pane has said so, not only the first: with { times: 1 } any other request for
  // /health that reached the route before the pane's own (CI's Edge, PR #72) took the one refusal, the pane's call got
  // the real engine and opened as usual, and the wait for #server-down ran out at 30 s (AH-69). Then the route goes, and
  // Try again meets the engine
  let refused = 0;
  const down = (r) => (refused++, r.abort("connectionrefused"));
  await failing(DROPPED, async () => {
    await page.route("**/health", down);
    await page.reload(); await page.waitForSelector("#server-down", { state: "visible" }).catch(() => {});
  });
  const opened = await page.evaluate(() => ["app-body", "main-ui", "server-down"].map((id) => `${id} ${document.getElementById(id).hidden ? "hidden" : "shown"}`).join(", "));
  await page.unroute("**/health", down);
  ok(refused >= 1 && (await page.isVisible("#server-down")) && (await text("#server-down")).replace(/\s+/g, " ").trim() === DOWN_AT_START + " Try again" && !(await page.isVisible("#main-ui")),
    `the engine down at start: said in plain words - ${refused} /health refused; ${opened}`);
  await page.click("#retry-health"); await page.waitForSelector("#main-ui", { state: "visible", timeout: 10000 }).catch(() => {});
  ok(await page.isVisible("#main-ui"), "Try again opens the pane once the engine answers");
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
  await page.click("#retry-health"); await page.waitForSelector("#main-ui", { state: "visible", timeout: 10000 }).catch(() => {});
  ok(await page.isVisible("#main-ui"), "and Try again opens the pane once the engine answers");
}

if (mode === "ai") { // engine started with a Claude key pointed at stub_claude.py
  await find();
  ok(await page.isVisible("#ai-box") || !(await page.isVisible("#ai-off")), "AI help is on when a key is set");
  await openRow(11);
  ok(await page.isVisible("#ai-box") && !(await page.isVisible("#ai-off")), "Ask AI shown when a key is set");
  // typed with the real keyboard: page.fill sets the value without a single key event, and so hid that the box
  // cancelled every key (2026-10-20). Focus left on the slider or Find problems (both act on a key) must not matter:
  // keys inside a text field never start a scan, and Ctrl+Enter asks AI, which sends only /fix and /check.
  const posts = []; // every POST the page makes, by path
  page.on("request", (r) => r.method() === "POST" && posts.push(new URL(r.url()).pathname));
  const level = await page.getAttribute("#strength", "aria-valuenow");
  await page.focus("#strength");
  await page.click("#fix-intent");
  await page.keyboard.type("use the average Units");
  await page.keyboard.press("Enter");
  await page.keyboard.type("for East");
  // a space then Backspace leave the text as it was, wherever the caret ended up
  for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " ", "Backspace"]) await page.keyboard.press(k);
  await page.focus("#scan");
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
  const asked = fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").map(JSON.parse).filter((l) => l.prompt.includes("Flagged row")).at(-1);
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
  const asks = () => fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").length;
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
  // the next ask clears it, and a real fix brings Accept back
  await page.fill("#fix-intent", ""); await page.click("#fix-intent");
  await page.keyboard.type("use the average Units"); await page.keyboard.press("Enter"); await page.keyboard.type("for East");
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 });
  ok(!(await page.isVisible("#fix-care")) && (await page.isVisible("#fix-apply")), "the next ask clears the helpline message and offers Accept again");
  // the AI call fails: the engine's own words for a provider error, or the engine gone mid-call. Said on the card, the
  // button comes back, the typed request stays
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: AI_BROKE }) }), AI_BROKE],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => {
      await page.route("**/fix", fail, { times: 1 }); await page.click("#fix-ask");
      await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 }).catch(() => {});
    });
    ok((await text("#fix-status")) === "AI could not help: " + words && !(await page.isDisabled("#fix-ask")) && (await page.inputValue("#fix-intent")) === typed,
      `Ask AI when ${how}: said on the card, Ask AI back, the request kept - ` + (await text("#fix-status")));
  }

  // AH-149: three requests to start from, each one Ask AI already answers: a press fills the box and sends nothing
  { posts.length = 0;
    const tries = await page.$$eval("#fix-tries .try", (bs) => bs.map((b) => b.textContent));
    await page.click('#fix-tries .try:has-text("Is this a typo?")'); await page.waitForTimeout(400);
    ok(tries.join("|") === "Explain this row in simple words|What should this value be?|Is this a typo?" && (await page.inputValue("#fix-intent")) === "Is this a typo?"
      && posts.length === 0 && (await page.evaluate(() => document.activeElement.id)) === "fix-intent", "a request to start from fills the Ask AI box, sends nothing and leaves the caret in the box - " + posts);
    await page.fill("#fix-intent", typed); }

  // the AI key box (Options > AI help) takes typed keys too; Enter in it sends nothing
  await page.click("#settings summary");
  posts.length = 0;
  await page.click("#ai-key");
  await page.keyboard.type("AIzaTypedKey_123");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  ok((await page.inputValue("#ai-key")) === "AIzaTypedKey_123" && posts.length === 0, "the AI key box takes typed keys; Enter there sends nothing - " + posts);
  await page.fill("#ai-key", "");
  await page.click("#settings summary");

  // Check words with AI: only the text columns' distinct words go; the AI's answer is shown as text, never as markup,
  // and a word it makes up (not in the column) is dropped. The stub answers with markup in "why" and a made-up word.
  await back();
  posts.length = 0;
  await page.click("#odd-check"); await idle();
  ok(posts.join() === "/odd-text", "Check words with AI sends only /odd-text - " + posts);
  const odd = await page.$$eval("#odd-list li", (lis) => lis.map((li) => li.textContent));
  ok(odd.length === 100 && odd.every((t) => /^Row \d+, column [A-Z]+ \(Region\): "Central"\. The AI says: <img src=x onerror=/.test(t)), `each row with the odd word listed (${odd.length}) - ${odd[0]}`);
  ok(!(await page.$("#odd-list img")) && !(await page.evaluate(() => window.__pwned)) && !odd.some((t) => t.includes("Atlantis")),
    "the AI's words are text, never markup; a word the AI made up is dropped");
  const sent = fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").map(JSON.parse).find((l) => l.prompt.includes("distinct values"));
  ok(sent && sent.prompt.includes('"Region"') && !/7777|170\.43|Units|2026-/.test(sent.prompt), "Check words sends the text column's words only, no numbers, dates or rows");
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: AI_BROKE }) }), AI_BROKE],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => { await page.route("**/odd-text", fail, { times: 1 }); await page.click("#odd-check"); await idle(); });
    ok((await text("#odd-list")) === "AI could not check: " + words && !(await page.isDisabled("#odd-check")), `Check words when ${how}: said in plain words - ` + (await text("#odd-list")));
  }
  // AH-149 review: "AI could not check" was set at 15 px among 12 px hints and read as a heading; and the empty
  // progress-and-notice line held a band of space over the summary once Check words had cleared "Done"
  { const m = await page.evaluate(() => ({ odd: getComputedStyle(document.querySelector("#odd-list li")).fontSize, body: getComputedStyle(document.body).fontSize,
      status: document.getElementById("status").getBoundingClientRect().height, notice: document.getElementById("notice").textContent }));
    ok(m.odd === m.body, `Check words' answer, or why it could not check, is at body size - ${m.odd} (body ${m.body})`);
    ok(m.notice === "" && m.status < 1, `with nothing to say and nothing running, the progress and notice line holds no space over the summary - ${m.status} px`); }
}

if (mode === "nokey") {
  await find();
  await openRow(11);
  ok(!(await page.isVisible("#ai-box")) && (await page.isVisible("#ai-off")), "without a key: no Ask AI, a pointer to the free setup");
  await page.click("#settings summary");
  await page.fill("#ai-key", "<script>"); await page.click("#save-key");
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
  ok((await page.isVisible("#ai-box")) && !(await page.isVisible("#ai-off")) && JSON.parse(health).ai_provider === "relay",
    "invite code saved: AI help is on, through the relay - " + (await text("#ai-state")));
  ok((await page.inputValue("#ai-key")) === "" && !(await page.content()).includes(code) && !health.includes(code)
    && fs.readFileSync(DIR + "cert/invite-code.txt", "utf8") === code, "the code is kept on this PC only: never on screen, never in an answer");
  const c5 = calls.length;
  await page.dblclick("#remove-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent === "Key removed. AI help is off.");
  await page.waitForTimeout(500);
  ok(since(c5) === "/key" && calls[c5][1].key === "", "Remove key, double-clicked, sends exactly one /key, with an empty key - " + since(c5));
  ok(!(await page.isVisible("#ai-box")) && (await page.isVisible("#ai-off")) && !fs.existsSync(DIR + "cert/invite-code.txt"),
    "Remove key: AI help off, the code deleted from this PC");
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
    ok((await text("#ai-state")) === words && !(await page.isVisible("#ai-box")) && (await page.inputValue("#ai-key")) === code,
      `Save key when ${how}: said in plain words, AI help stays off, the key kept in its box to try again - ` + (await text("#ai-state")));
  }
  await page.fill("#ai-key", "");
}

if (mode === "flow") {
  // AH-94: under reduced motion the same states come without movement: no entrance, the skeleton without its light, a
  // hovered row filled but not lifted, the card shown without a turn, the list back without a fade
  {
    const calm = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 }, reducedMotion: "reduce" });
    const heard = [];
    calm.on("pageerror", (e) => heard.push(e.message));
    await calm.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
    await calm.goto("https://127.0.0.1:5055/taskpane.html");
    await calm.evaluate((rows) => __load("Sales", rows, [0]), rows);
    await calm.waitForSelector("#main-ui", { state: "visible" });
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
}

if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pane-${mode}.png`, fullPage: true }); // proof for people
const real = errors.filter((e) => !(mode === "nokey" && e.includes("status of 400"))); // the junk key gets the engine's 400 on purpose
ok(real.length === 0, "no page errors " + JSON.stringify(real));
ok(unhandled.length === 0, "no unhandled promise rejection or uncaught error on the page in this mode - " + JSON.stringify(unhandled));
await browser.close();
