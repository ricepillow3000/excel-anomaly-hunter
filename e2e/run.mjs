// Browser test of the REAL pane against the REAL engine, with fake-office.js standing in for Excel.
// Run via e2e/all.sh (needs node + playwright with chromium, and the repo's .venv). Modes: flow ai nokey.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { trustArgs } from "./trust.mjs";
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
const DROPPED = /ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_FAILED|checker isn't running|status of 50[23]|AI error|Couldn't save that/;
const DOWN = "the checker isn't running. Double-click AnomalyHunter.exe again (from a source folder: install.bat), then try again.";
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
const cell = (a) => page.evaluate((a) => __cell("Sales", a), a);
const idle = () => page.waitForFunction(() => !document.getElementById("scan").disabled);
const find = async () => { await page.click("#scan"); await idle(); await page.waitForSelector("#results", { state: "visible" }); };
const openRow = async (r) => { await page.click(`#flagged-list button:has-text("Row ${r} ")`); await idle(); await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent); };

if (mode === "flow") {
  // 1) one click, no stop at a limits table; buttons are off while it works, so nothing queues silently
  const c0 = calls.length;
  await page.click("#scan");
  ok(await page.evaluate(() => document.getElementById("clear-highlights").disabled), "buttons are disabled while it works");
  await idle();
  ok(await page.isVisible("#results"), "results after ONE click");
  await page.waitForTimeout(800); // room for a second, unwanted scan to show up, as the slider checks give it
  ok(since(c0) === "/scan" && calls[c0][1].strength === 5 && calls[c0][1].power_bi === false, "Find problems sends exactly one /scan, at the slider's level - " + since(c0));
  { const m = await matchesEngine(); ok(m.ok, "the list is exactly what the engine answered: each flagged row, its severity in words and its reason - " + m.why); }
  ok((await text("#summary")).startsWith("5 of 300 rows look wrong."), "summary in plain words - " + (await text("#summary")));
  ok(/^Done in \d+ seconds?\.$/.test(await text("#notice")), "says when it is done - " + (await text("#notice")));
  const listed = await page.$$eval("#flagged-list button", (bs) => bs.slice(0, 5).map((b) => b.innerText.split("\n")[0]));
  ok(["11", "22", "51", "81", "121"].every((r) => listed.some((l) => l.startsWith(`Row ${r}`))), "all 5 planted problems listed first - " + listed);
  ok(!(await text("#flagged-list")).includes("weird limit"), "no jargon in the list");
  ok((await text("#fairness-note")).startsWith("Fairness: Region is never used") && (await page.$$("#fairness-list li")).length > 0,
    "fairness: the protected column is named, every check is listed under All fairness checks");
  // AH-40: exactly the cells each reason names - row 11's Units, UnitCost and Total (its total does not add up), the
  // duplicate's whole row, the "east " Region, the blank Units - and no other cell of those rows
  const fills = await page.evaluate(() => ["C11", "D11", "E11", "C22", "A51", "E51", "B81", "C121", "A2"].map((a) => __cell("Sales", a).fill));
  ok(fills.slice(0, 8).every((f) => f === "#FFEB9D") && fills[8] === null, "the named cells highlighted, clean rows not - " + fills);
  const beside = await page.evaluate(() => ["A11", "B11", "A22", "B22", "A81", "C81", "A121", "B121"].map((a) => __cell("Sales", a).fill));
  ok(beside.join() === "#00B050,#00B050,,#00B0F0,,,,", "no other cell of a flagged row is coloured; the user's own fills stay - " + beside);

  // 2) open a row's card, Accept (Agent 3 checks it again, highlight goes), Undo
  await openRow(11);
  ok((await text("#fix-title")) === "Row 11: probably wrong", "fix view titled in words");
  ok((await text("#fix-reason")) === "Total 170.43 does not add up: Units × UnitCost = -14.95 · Units is -5, below its usual limit of 0",
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
  ok((await cell("C11")).fill === "#00B050" && (await cell("E11")).fill === "#00B050", "fixed row: highlight gone, the user's own green back");
  ok(await page.isVisible("#fix-next") && !(await page.isVisible("#fix-dismiss")), "then Undo / Next row");
  await page.click("#fix-back");
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
  await page.evaluate(() => __edit("Sales", "B11", "North")); // the row changes after the scan (edited / sorted)
  await page.click("#fix-apply"); await idle();
  ok((await cell("C11")).v === -5 && (await text("#fix-status")).includes("changed since the scan"), "changed row: Accept refuses instead of writing into the wrong record");
  await page.evaluate(() => __edit("Sales", "B11", "East"));

  // 3) clicking a highlighted row in the sheet opens it too; Dismiss leaves it, unhighlighted, and opens the next
  await page.click("#fix-back");
  await page.evaluate(() => __userSelect("Sales", "B22"));
  await page.waitForFunction(() => document.getElementById("fix-title").textContent.startsWith("Row 22"), null, { timeout: 10000 }).catch(() => {});
  ok((await text("#fix-title")).startsWith("Row 22"), "sheet click opens the row");
  await idle();
  const beforeDismiss = await page.evaluate(() => __log.length), c2 = calls.length;
  await page.click("#fix-dismiss"); await idle();
  ok(calls.slice(c2).every(([p, b]) => p === "/suggest" && b.row_index !== 20) && (await page.evaluate(() => Object.values(__settings.anomalyHunterDecisions?.Sales || {}).includes("dismissed"))),
    "Dismiss asks the engine nothing about the row (the next card may look for a typo: /suggest, never for row 22) and keeps Dismissed in the workbook - " + JSON.stringify(calls.slice(c2).map(([p, b]) => [p, b?.row_index])));
  ok((await cell("C22")).v === 7777 && (await cell("C22")).fill === null && (await cell("B22")).fill === "#00B0F0", "Dismiss keeps the value and removes only our highlight");
  ok((await page.evaluate(() => __log.length)) === beforeDismiss, "Dismiss (and opening the next row) writes no cell at all");
  ok(/^Row \d+/.test(await text("#fix-title")) && !(await text("#fix-title")).startsWith("Row 22"), "and moves to the next row - " + (await text("#fix-title")));

  // 4) Remove highlights puts back exactly what was there (the user's green row 11 too)
  await page.click("#fix-back");
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
  await slide(5, 0); await idle();
  await page.waitForTimeout(800); // room for a second, unwanted re-scan to show up
  ok(scans.slice(s0).map((b) => b.strength).join() === "0", "a drag to 0 causes exactly one re-scan, at 0 - " + scans.slice(s0).map((b) => b.strength));
  { const m = await matchesEngine(); ok(m.ok, "at 0 the list is exactly what the engine answered at 0 - " + m.why); }
  // the pane says what the new level changed, counted from the engine's last two answers for this very sheet (AH-15)
  { const [b, a] = replies.slice(-2), said = await text("#level-change");
    const want = await page.evaluate(async ([rb, ra]) => { const { levelChange } = await import("./features/scan.js");
      return levelChange({ level: 5, rows: rb, hashes: __state.hashes, sheet: __state.lastScan.sheet }, { level: 0, rows: ra, hashes: __state.hashes, sheet: __state.lastScan.sheet }); }, [b.rows, a.rows]);
    ok(said.startsWith("Level 0 (was 5): ") && said === want && (await page.isVisible("#level-change")), "a slider re-check says what level 0 changed against 5 - " + said); }
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
  await page.click('#flagged-list button:has-text("Row 11 ")'); await idle();
  ok(await page.isVisible("#results") && (await text("#notice")).includes("Undo is only offered right after a fix"), "a row fixed before only selects its row, and says why there's no Undo - " + (await text("#notice")));
  await openRow(22);
  ok((await text("#fix-title")).startsWith("Row 22") && (await page.isVisible("#fix-apply")), "a dismissed row's card still opens from the list, so it can still be fixed");
  await page.click("#fix-back");
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
    ok(status === 200 && (await pop.title()) === `Anomaly Hunter, ${link}`, `${link} link opens its page (HTTP ${status})`);
    await pop.close();
  }

  // 7a) 30 scans and re-checks: what the pane keeps (listeners, page nodes) stays what is on screen (AH-13). Counted by
  // Chromium itself after a forced garbage collection, so a leaked list or a listener added per scan shows up
  const cdp = await page.context().newCDPSession(page);
  const counters = async () => { await cdp.send("HeapProfiler.collectGarbage"); return cdp.send("Memory.getDOMCounters"); };
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
  await page.route("**/scan", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Engine error - details in server.log" }) }), { times: 1 });
  const seen = errors.length;
  await page.click("#scan"); await idle();
  const planned = (e) => /status of 500|Engine error - details in server\.log/.test(e); // this step's own 500, logged on purpose
  errors.splice(seen, Infinity, ...errors.slice(seen).filter((e) => !planned(e)));
  ok((await text("#notice")) === "Something went wrong: Engine error - details in server.log" && !(await page.evaluate(() => document.getElementById("clear-highlights").disabled)),
    "an engine error is said in plain words, and the pane is usable again - " + (await text("#notice")));

  // 7c) the engine goes down mid-scan (the request is sent, then the connection drops): plain words that name the file
  // most people have (the exe; install.bat only in a source folder or an invite kit), and the pane is usable again
  await failing(DROPPED, async () => { await page.route("**/scan", dropMidway, { times: 1 }); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === "Something went wrong: " + DOWN && !(await page.evaluate(() => document.getElementById("scan").disabled)),
    "the engine down mid-scan: said in plain words, buttons back - " + (await text("#notice")));
  // an engine from before a route existed answers 404 with no words of ours: told to update, naming the exe too
  await failing(/status of 404|out of date/, async () => { await page.route("**/scan", (r) => r.fulfill({ status: 404, body: "" }), { times: 1 }); await page.click("#scan"); await idle(); });
  ok((await text("#notice")) === "Something went wrong: the checker is out of date. Close Excel, then run the newest AnomalyHunter.exe (from a source folder: install.bat).",
    "an engine too old for the pane: said in plain words - " + (await text("#notice")));
  // and mid-Accept (on the Other sheet, checked last): the cell is written, the re-check that could not run is said on the card
  await find(); await openRow(81);
  await failing(DROPPED, async () => { await page.route("**/check", dropMidway, { times: 1 }); await page.click("#fix-apply"); await idle(); });
  ok((await text("#fix-status")) === `Accepted. Couldn't check it again (${DOWN}) - click Find problems to check the sheet.` && (await page.evaluate(() => __cell("Other", "B81").v)) === "East",
    "the engine down mid-Accept: the fix is in, and the card says the re-check couldn't run - " + (await text("#fix-status")));
  await page.click("#fix-undo"); await idle(); await page.click("#fix-back");

  // 8) an empty sheet gets a plain message, not an error
  await page.evaluate(() => __load("Empty", [["only a header"]]));
  await page.click("#scan"); await idle();
  ok((await text("#notice")).startsWith("Not enough data here."), "empty sheet explained");

  // 9) the engine down when the pane opens: the pane says so, and Try again brings it back once it answers
  await failing(DROPPED, async () => {
    await page.route("**/health", (r) => r.abort("connectionrefused"), { times: 1 });
    await page.reload(); await page.waitForSelector("#server-down", { state: "visible" });
  });
  ok((await text("#server-down")).includes("The checker isn't running.") && !(await page.isVisible("#main-ui")), "the engine down at start: said in plain words");
  await page.click("#retry-health"); await page.waitForSelector("#main-ui", { state: "visible", timeout: 10000 }).catch(() => {});
  ok(await page.isVisible("#main-ui"), "Try again opens the pane once the engine answers");
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
  // the AI call fails: the engine's own words for a provider error, or the engine gone mid-call. Said on the card, the
  // button comes back, the typed request stays
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "AI error - details in server.log" }) }), "AI error - details in server.log"],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => {
      await page.route("**/fix", fail, { times: 1 }); await page.click("#fix-ask");
      await page.waitForFunction(() => document.getElementById("fix-ask").textContent === "Ask AI" && !document.getElementById("fix-ask").disabled, null, { timeout: 30000 }).catch(() => {});
    });
    ok((await text("#fix-status")) === "AI could not help: " + words && !(await page.isDisabled("#fix-ask")) && (await page.inputValue("#fix-intent")) === typed,
      `Ask AI when ${how}: said on the card, Ask AI back, the request kept - ` + (await text("#fix-status")));
  }

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
  await page.click("#fix-back");
  posts.length = 0;
  await page.click("#odd-check"); await idle();
  ok(posts.join() === "/odd-text", "Check words with AI sends only /odd-text - " + posts);
  const odd = await page.$$eval("#odd-list li", (lis) => lis.map((li) => li.textContent));
  ok(odd.length === 100 && odd.every((t) => /^Row \d+, column [A-Z]+ \(Region\): "Central" - the AI says: <img src=x onerror=/.test(t)), `each row with the odd word listed (${odd.length}) - ${odd[0]}`);
  ok(!(await page.$("#odd-list img")) && !(await page.evaluate(() => window.__pwned)) && !odd.some((t) => t.includes("Atlantis")),
    "the AI's words are text, never markup; a word the AI made up is dropped");
  const sent = fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").map(JSON.parse).find((l) => l.prompt.includes("distinct values"));
  ok(sent && sent.prompt.includes('"Region"') && !/7777|170\.43|Units|2026-/.test(sent.prompt), "Check words sends the text column's words only, no numbers, dates or rows");
  for (const [how, fail, words] of [
    ["the provider fails", (r) => r.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "AI error - details in server.log" }) }), "AI error - details in server.log"],
    ["the engine goes down mid-call", dropMidway, DOWN]]) {
    await failing(DROPPED, async () => { await page.route("**/odd-text", fail, { times: 1 }); await page.click("#odd-check"); await idle(); });
    ok((await text("#odd-list")) === "AI could not check: " + words && !(await page.isDisabled("#odd-check")), `Check words when ${how}: said in plain words - ` + (await text("#odd-list")));
  }
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
  await page.fill("#ai-key", code); await page.click("#save-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent.startsWith("Invite code saved"));
  const health = await page.evaluate(() => fetch("/health").then((r) => r.text()));
  ok((await page.isVisible("#ai-box")) && !(await page.isVisible("#ai-off")) && JSON.parse(health).ai_provider === "relay",
    "invite code saved: AI help is on, through the relay - " + (await text("#ai-state")));
  ok((await page.inputValue("#ai-key")) === "" && !(await page.content()).includes(code) && !health.includes(code)
    && fs.readFileSync(DIR + "cert/invite-code.txt", "utf8") === code, "the code is kept on this PC only: never on screen, never in an answer");
  const c5 = calls.length;
  await page.click("#remove-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent === "Key removed. AI help is off.");
  ok(since(c5) === "/key" && calls[c5][1].key === "", "Remove key sends exactly one /key, with an empty key - " + since(c5));
  ok(!(await page.isVisible("#ai-box")) && (await page.isVisible("#ai-off")) && !fs.existsSync(DIR + "cert/invite-code.txt"),
    "Remove key: AI help off, the code deleted from this PC");
  // saving fails: the PC can't keep the file (the engine's 503, AH-13), or the engine is gone. Said where the key goes,
  // and the key stays in its box to try again (cleared after a save, or when the engine refuses the key itself)
  const disk = "Couldn't save that on this PC - the disk may be full or the file in use. Details in server.log.";
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

if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pane-${mode}.png`, fullPage: true }); // proof for people
const real = errors.filter((e) => !(mode === "nokey" && e.includes("status of 400"))); // the junk key gets the engine's 400 on purpose
ok(real.length === 0, "no page errors " + JSON.stringify(real));
ok(unhandled.length === 0, "no unhandled promise rejection or uncaught error on the page in this mode - " + JSON.stringify(unhandled));
await browser.close();
