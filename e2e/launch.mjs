// Launch checks on the REAL pane served by the engine, in Chromium with fake-office.js standing in for Excel:
// load time, no sideways scroll at task-pane widths, the main button above the fold, every image and control named.
// Run by e2e/all.sh (which starts the engine on :5055), or alone against a running engine: cd e2e && node launch.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { trustArgs } from "./trust.mjs";
const pw = await import(process.env.PLAYWRIGHT || "playwright")
  .catch(() => import(pathToFileURL(createRequire(import.meta.url).resolve("playwright", { paths: [process.env.NODE_PATH || ""] })).href));
const { chromium } = pw.chromium ? pw : pw.default;
const DIR = fileURLToPath(new URL(".", import.meta.url));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok -", m); };

const args = trustArgs(DIR);
const browser = await chromium.launch({ args }).catch(() => chromium.launch({ channel: "msedge", args }));
for (const width of [320, 360, 500]) { // Office's task pane: 320 px at its narrowest
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // a console error names the file that failed: "Failed to load resource: net::ERR_TOO_MANY_RETRIES" came 4 times on
  // 23 Oct with no name, under other test runs' load, and never on a quiet rerun (AH-43)
  page.on("console", (m) => m.type() === "error" && errors.push(m.location().url ? `${m.text()} (${m.location().url})` : m.text()));
  // every unhandled promise rejection and uncaught error, heard by the page itself before any of the pane's scripts run,
  // as in run.mjs (AH-58)
  await page.exposeFunction("__unhandled", (kind, what) => errors.push(`${kind}: ${what}`));
  await page.addInitScript(() => {
    addEventListener("unhandledrejection", (e) => __unhandled("unhandledrejection", String(e.reason?.stack || e.reason)));
    addEventListener("error", (e) => __unhandled("error", String(e.error?.stack || e.message)));
  });
  await page.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
  const t0 = Date.now();
  await page.goto("https://127.0.0.1:5055/taskpane.html");
  await page.evaluate(() => __load("Sales", [["Item", "Units"], ["Pen", 5], ["Pad", 7]], []));
  await page.waitForSelector("#main-ui", { state: "visible" });
  const ready = Date.now() - t0;
  const m = await page.evaluate(() => {
    const scan = document.getElementById("scan").getBoundingClientRect();
    const named = (el) => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim() ||
      el.labels?.length; // <label for=...> or a wrapping <label>, as screen readers see it
    const visible = (el) => el.offsetParent !== null;
    return {
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scanBottom: scan.bottom, fold: innerHeight,
      noAlt: [...document.images].filter((i) => !i.hasAttribute("alt")).length,
      unnamed: [...document.querySelectorAll("button, input, select, textarea")].filter((e) => visible(e) && !named(e)).map((e) => e.id || e.outerHTML.slice(0, 60)),
      load: Math.round(performance.getEntriesByType("navigation")[0].loadEventEnd),
    };
  });
  ok(ready < 2000, `${width}px: pane ready in ${ready} ms (page load ${m.load} ms), under 2 s`);
  ok(m.sideways <= 0, `${width}px: no sideways scroll (${m.sideways} px)`);
  ok(m.scanBottom <= m.fold, `${width}px: "Find problems" button above the fold (bottom ${Math.round(m.scanBottom)} of ${m.fold} px)`);
  ok(m.noAlt === 0, `${width}px: every image has alt text (${m.noAlt} without)`);
  ok(m.unnamed.length === 0, `${width}px: every visible control has a name - ${m.unnamed}`);
  // AH-149 review: "Recommended" stood under the slider's left side, a band of empty space stood over the first view,
  // and each option's row was 80 px tall
  await page.waitForFunction(() => [...document.querySelectorAll("[data-enter]")].every((e) => !e.style.opacity && !e.style.transform), null, { timeout: 5000 });
  const lay = await page.evaluate(() => {
    const s = document.getElementById("strength").getBoundingClientRect(), w = document.querySelector(".slider-scale span:nth-child(2)").getBoundingClientRect();
    return { tick: s.left + s.width / 2, word: w.left + w.width / 2, status: document.getElementById("status").getBoundingClientRect().height,
      rows: [...document.querySelectorAll(".settings-band details.more")].map((d) => Math.round(d.getBoundingClientRect().height)) };
  });
  ok(Math.abs(lay.word - lay.tick) <= 12, `${width}px: "Recommended" is centred under the slider's 5 tick (word ${lay.word.toFixed(1)}, tick ${lay.tick.toFixed(1)})`);
  ok(lay.status < 1, `${width}px: before the first scan, with nothing to say, the progress and notice line holds no space (${lay.status} px)`);
  ok(lay.rows.length === 4 && lay.rows.every((h) => h >= 44 && h <= 52), `${width}px: each closed option row is 44 to 52 px tall - ${lay.rows}`);
  ok(errors.length === 0, `${width}px: no page errors, unhandled rejections or uncaught errors ${errors}`);
  await page.close();
}

// A clean sheet with limits, so the pane can show its results and its limits editor (no row is flagged on it)
const CLEAN = [["Item", "Units", "Cost"], ...Array.from({ length: 60 }, (_, k) => [["Pen", "Pad", "Ink"][k % 3], 40 + ((k * 7) % 23), +(1.99 + (k % 4)).toFixed(2)])];
const PAGES = ["taskpane.html", "privacy.html", "support.html"];
// a page as a person reads it: the pane opened (and, with scan, after a scan), every section unfolded
async function open(ctx, file, { scan = false, limits = false } = {}) {
  const page = await ctx.newPage();
  await page.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
  await page.goto("https://127.0.0.1:5055/" + file);
  if (file === "taskpane.html") {
    await page.evaluate((rows) => __load("Sales", rows, []), CLEAN);
    await page.waitForSelector("#main-ui", { state: "visible" });
    if (scan) { await page.click("#scan"); await page.waitForSelector("#results", { state: "visible" }); await page.waitForFunction(() => !document.getElementById("scan").disabled); }
    if (limits) { await page.$$eval("#results details", (ds) => ds.forEach((d) => (d.open = true))); await page.click("#edit-limits"); await page.waitForSelector("#limits-editor", { state: "visible" }); }
    // the entrance (components/motion.js) is over: nothing measured mid-move
    await page.waitForFunction(() => [...document.querySelectorAll("[data-enter]")].every((e) => !e.style.opacity && !e.style.transform), null, { timeout: 5000 });
  }
  await page.$$eval("details", (ds) => ds.forEach((d) => (d.open = true)));
  return page;
}

// AH-112: at page zoom (a 320 px pane at 200% is 160 CSS px wide) and at 200% text, nothing is cut and nothing scrolls
// sideways. legal.css clipped the whole page (html, body overflow-x: clip): the uninstall code and long links were cut
// off at the edge, and the pane's "Strictest" and its aistudio link ran past it
{
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 160, height: 700 }, reducedMotion: "reduce" });
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 700 }, reducedMotion: "reduce" });
  for (const [c, how] of [[ctx, "160 px wide"], [ctx2, "320 px wide, text at 200%"]]) for (const file of PAGES) for (const scan of file === "taskpane.html" ? [false, true] : [false]) {
    const page = await open(c, file, { scan });
    if (c === ctx2) await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; }); // CSSOM: the CSP allows it
    await page.waitForTimeout(100);
    const m = await page.evaluate(() => {
      const shown = (e) => e.checkVisibility() && e.getBoundingClientRect().width > 0;
      const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : "");
      const cut = [...document.querySelectorAll("body *")].filter((e) => {
        if (!shown(e) || !e.textContent.trim()) return false;
        const ox = getComputedStyle(e).overflowX;
        return ox !== "visible" && e.scrollWidth > e.clientWidth + 1; // hidden/clip cuts it, auto/scroll makes it scroll sideways
      }).map((e) => `${name(e)} ${e.scrollWidth}>${e.clientWidth} "${e.textContent.trim().slice(0, 30)}"`);
      const vw = document.documentElement.clientWidth;
      const past = [...document.querySelectorAll("body *")].filter((e) => shown(e) && [...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())
        && e.getBoundingClientRect().right > vw + 1).map((e) => `${name(e)} right ${Math.round(e.getBoundingClientRect().right)} "${e.textContent.trim().slice(0, 30)}"`);
      return { sideways: document.documentElement.scrollWidth - vw, cut: cut.slice(0, 6), past: past.slice(0, 6) };
    });
    ok(m.sideways <= 0 && !m.cut.length && !m.past.length, `${file}${scan ? " after a scan" : ""} at ${how}: no sideways scroll, nothing cut - ` + JSON.stringify(m));
    await page.close();
  }
  await ctx.close(); await ctx2.close();
}

// AH-113: Windows High Contrast (forced colours) repaints every background in the system's colours: the Find problems
// button (border 0) read as plain text, the slider's track and fill vanished into the page, the swatches went blank
{
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 700 }, forcedColors: "active", reducedMotion: "reduce" });
  const page = await open(ctx, "taskpane.html");
  const m = await page.evaluate(() => {
    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const canvas = getComputedStyle(document.body).backgroundColor;
    const box = document.createElement("div"); // the legend's three swatches, as results.js draws them
    box.innerHTML = ["High", "Medium", "Low"].map((k) => `<span class="swatch sev-${k}"></span>`).join("");
    document.getElementById("main-ui").append(box);
    const sw = [...box.children].map((e) => getComputedStyle(e).backgroundColor);
    box.remove();
    const scan = cs("#scan"), track = cs(".slider-track"), fill = cs(".slider-fill");
    return { canvas, scanBorder: [scan.borderTopWidth, scan.borderTopStyle], track: track.backgroundColor, fill: fill.backgroundColor, sw };
  });
  ok(parseFloat(m.scanBorder[0]) >= 1 && m.scanBorder[1] !== "none", "forced colours: the Find problems button has a visible border - " + JSON.stringify(m.scanBorder));
  ok(m.track !== m.canvas && !/rgba\(0, 0, 0, 0\)/.test(m.track) && m.fill !== m.track && m.fill !== m.canvas,
    `forced colours: the slider's track and fill show against the page - ${JSON.stringify(m)}`);
  ok(new Set(m.sw).size === 3 && !m.sw.includes(m.canvas), "forced colours: the three swatches stay three different colours - " + JSON.stringify(m.sw));
  await page.close(); await ctx.close();
}

// AH-115 and AH-116: at 320 px every control is at least 24 x 24 CSS px (WCAG 2.2 2.5.8; a link inside a sentence is
// exempt, a checkbox is judged by the label that wraps it), and no text is smaller than 12 px (the limits table's heads
// were 10.5, the pages' table heads 11). The details summaries were 18 px tall
{
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 700 }, reducedMotion: "reduce" });
  for (const [file, how] of [["taskpane.html", {}], ["taskpane.html", { scan: true }], ["taskpane.html", { scan: true, limits: true }], ["privacy.html", {}], ["support.html", {}]]) {
    const page = await open(ctx, file, how);
    const m = await page.evaluate(() => {
      const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : "") + ` "${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 24)}"`;
      const inSentence = (a) => getComputedStyle(a).display === "inline" && a.parentElement.textContent.trim().length > a.textContent.trim().length + 2;
      const small = [];
      for (const e of document.querySelectorAll("button, summary, input:not([type=hidden]), select, textarea, a[href], [role=slider]")) {
        if (!e.checkVisibility() || e.closest("[aria-hidden='true']") || (e.tagName === "A" && inSentence(e))) continue;
        const r = (e.type === "checkbox" || e.type === "radio") && e.closest("label") ? e.closest("label").getBoundingClientRect() : e.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) small.push(`${name(e)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      const tiny = [], walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const el = t.parentElement;
        if (!t.nodeValue.trim() || el.closest("[aria-hidden='true'], script, style") || !el.checkVisibility()) continue;
        const px = parseFloat(getComputedStyle(el).fontSize);
        if (px < 12) tiny.push(`${name(el)} ${px}px`);
      }
      return { small: small.slice(0, 8), tiny: [...new Set(tiny)].slice(0, 8) };
    });
    const where = `${file}${how.limits ? " (limits editor)" : how.scan ? " (after a scan)" : ""}`;
    ok(!m.small.length, `${where}: every control is at least 24 x 24 px - ${m.small}`);
    ok(!m.tiny.length, `${where}: no text under 12 px - ${m.tiny}`);
    await page.close();
  }
  await ctx.close();
}

// AH-149: a finger's height. In the pane, at its narrowest (320 px) and a wide one (500 px), every control a person
// presses is at least 44 px tall (24 is WCAG's floor, not a size to aim for): the slider was 28, the options' summaries
// 28, a checkbox's label 24, the plain buttons 40. A link inside a sentence is exempt, a checkbox goes by its label
for (const width of [320, 500]) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 700 }, reducedMotion: "reduce" });
  for (const how of [{}, { scan: true }, { scan: true, limits: true }]) {
    const page = await open(ctx, "taskpane.html", how);
    const short = await page.evaluate(() => {
      const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.classList.length ? "." + [...e.classList].join(".") : "") + ` "${(e.textContent || e.getAttribute("aria-label") || "").trim().slice(0, 24)}"`;
      const inSentence = (a) => getComputedStyle(a).display === "inline" && a.parentElement.textContent.trim().length > a.textContent.trim().length + 2;
      return [...document.querySelectorAll("button, summary, input:not([type=hidden]), select, textarea, a[href], [role=slider]")]
        .filter((e) => e.checkVisibility() && !e.closest("[aria-hidden='true']") && !(e.tagName === "A" && inSentence(e)))
        .map((e) => [e, ((e.type === "checkbox" || e.type === "radio") && e.closest("label") ? e.closest("label") : e).getBoundingClientRect().height])
        .filter(([, h]) => h < 44 - 0.5).map(([e, h]) => `${name(e)} ${Math.round(h)}px`);
    });
    ok(!short.length, `${width}px${how.limits ? " (limits editor)" : how.scan ? " (after a scan)" : ""}: every control is at least 44 px tall - ${short}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
