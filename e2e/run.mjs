// Browser test of the REAL pane against the REAL engine, with fake-office.js standing in for Excel.
// Run via e2e/all.sh (needs node + playwright with chromium, and the repo's .venv). Modes: flow ai nokey.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
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
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const scans = []; // every /scan body the pane sent: the slider's level and the Power BI switch must reach the engine
page.on("request", (r) => r.url().endsWith("/scan") && scans.push(JSON.parse(r.postData())));
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
const text = (sel) => page.textContent(sel);
const cell = (a) => page.evaluate((a) => __cell("Sales", a), a);
const idle = () => page.waitForFunction(() => !document.getElementById("scan").disabled);
const find = async () => { await page.click("#scan"); await idle(); await page.waitForSelector("#results", { state: "visible" }); };
const openRow = async (r) => { await page.click(`#flagged-list button:has-text("Row ${r} ")`); await idle(); await page.waitForFunction(() => document.getElementById("fix-changes").children.length || document.getElementById("fix-explanation").textContent); };

if (mode === "flow") {
  // 1) one click, no stop at a limits table; buttons are off while it works, so nothing queues silently
  await page.click("#scan");
  ok(await page.evaluate(() => document.getElementById("clear-highlights").disabled), "buttons are disabled while it works");
  await idle();
  ok(await page.isVisible("#results"), "results after ONE click");
  ok((await text("#summary")).startsWith("5 of 300 rows look wrong."), "summary in plain words - " + (await text("#summary")));
  ok(/^Done in \d+ seconds?\.$/.test(await text("#notice")), "says when it is done - " + (await text("#notice")));
  const listed = await page.$$eval("#flagged-list button", (bs) => bs.slice(0, 5).map((b) => b.innerText.split("\n")[0]));
  ok(["11", "22", "51", "81", "121"].every((r) => listed.some((l) => l.startsWith(`Row ${r}`))), "all 5 planted problems listed first - " + listed);
  ok(!(await text("#flagged-list")).includes("weird limit"), "no jargon in the list");
  ok((await text("#fairness-note")).startsWith("Fairness: Region is never used") && (await page.$$("#fairness-list li")).length > 0,
    "fairness: the protected column is named, every check is listed under All fairness checks");
  const fills = await page.evaluate(() => ["A11", "A22", "A51", "A81", "A121", "A2"].map((a) => __cell("Sales", a).fill));
  ok(fills.slice(0, 5).every((f) => f === "#FFEB9C") && fills[5] === null, "flagged rows highlighted, clean rows not - " + fills);

  // 2) open a row's card, Accept (Agent 3 checks it again, highlight goes), Undo
  await openRow(11);
  ok((await text("#fix-title")) === "Row 11: probably wrong", "fix view titled in words");
  ok((await text("#fix-reason")) === "Total 170.43 does not add up: Units × UnitCost = -14.95 · Units is -5, below its usual limit of 0",
    "reason in plain words - " + (await text("#fix-reason")));
  ok((await text("#fix-changes")).startsWith("C11: -5 → "), "preview old -> new");
  ok(await page.isVisible("#fix-dismiss") && !(await page.isVisible("#fix-next")), "card asks: Accept or Dismiss");
  const logged = await page.evaluate(() => __log.length); // every cell value Excel was asked to write, in order
  const wrote = () => page.evaluate((n) => __log.slice(n).map((w) => `${w[1]}!${w[2]}`).join(), logged);
  await page.click("#fix-apply"); await idle();
  ok((await cell("C11")).v !== -5 && (await page.isVisible("#fix-undo")) && (await text("#fix-apply")) === "Accepted", "Accept writes the cell");
  ok((await wrote()) === "Sales!C11", "Accept wrote exactly the one targeted cell, nothing else - " + (await wrote()));
  ok((await text("#fix-status")).includes("looks right now"), "checker re-scanned the fixed row - " + (await text("#fix-status")));
  ok((await cell("A11")).fill === "#00B050", "fixed row: highlight gone, the user's own green back");
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
  ok((await cell("C11")).v === -5 && !(await page.isVisible("#fix-undo")) && (await cell("A11")).fill === "#FFEB9C", "Undo puts it back, highlight too");
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
  const beforeDismiss = await page.evaluate(() => __log.length);
  await page.click("#fix-dismiss"); await idle();
  ok((await cell("C22")).v === 7777 && (await cell("A22")).fill === null && (await cell("B22")).fill === "#00B0F0", "Dismiss keeps the value and removes only our highlight");
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
  await page.evaluate(() => { __state.painted = null; __fill("Sales", "A30", "#00B050"); __fill("Sales", "D40", "#FFC7CE"); });
  await page.click("#clear-highlights"); await idle();
  const cleared = await page.evaluate(() => ["A22", "A51", "A30", "D40"].map((a) => __cell("Sales", a).fill));
  ok(cleared[0] === null && cleared[1] === null && cleared[2] === "#00B050", "reopened pane: only OUR colors are removed - " + cleared);
  ok(cleared[3] === "#FFC7CE", "a single cell in Excel's own 'Bad' style (same pink) is the user's, and stays");

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
  await slide(5, 0); await idle();
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
  await page.click("#scan");
  ok((await page.evaluate(() => document.getElementById("scan").disabled)), "a check is running");
  await slide(0, 8);
  ok((await level()) === "8", "the thumb drags while a check runs");
  await page.waitForFunction(() => !document.getElementById("scan").disabled && __settings.anomalyHunterStrength === 8);
  await page.waitForTimeout(400); await idle();
  ok((await page.evaluate(() => __state.lastStrength)) === 8 && scans.at(-1).strength === 8, "the queued re-check ran with the newest level (8)");
  await page.focus("#strength"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft"); await page.keyboard.press("ArrowLeft");
  ok((await level()) === "5", "arrow keys move it one step at a time");
  await page.waitForTimeout(400); await idle();
  ok((await page.$$("#flagged-list li")).length === listed5 && (await text("#strength-val")) === "5 of 10" && (await page.evaluate(() => __state.lastStrength)) === 5,
    "back to 5: the same rows as before");

  // 6c) auto-fix (step 3): off by default; on = only the capitals/spaces slip, never numbers; Undo auto-fixes puts it back
  ok(!(await page.evaluate(() => document.getElementById("auto-fix").checked)), "auto-fix is off by default");
  ok(!(await page.evaluate(() => document.getElementById("power-bi").checked)), "the Power BI copy is off by default: no copy of the sheet is kept");
  await page.evaluate(() => { const c = document.getElementById("auto-fix"); c.checked = true; c.dispatchEvent(new Event("change")); });
  await page.click("#scan"); await idle();
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
  await powerBi(true); await find();
  ok(scans.at(-1).power_bi === true && scans.at(-1).sheet === "Sales" && scans.at(-1).start_row === 0, "Power BI on: sent with where the table sits");
  const paneRows = await page.$$eval("#flagged-list button", (bs) => bs.map((b) => +/^Row (\d+)/.exec(b.innerText)[1]).sort((a, b) => a - b));
  const flagsCsv = records(FLAGS), scanCsv = records(CSV);
  const csvRows = flagsCsv.slice(1).map((r) => +r[2]).sort((a, b) => a - b);
  ok(flagsCsv[0].join() === "Scanned At,Sheet,Excel Row,Severity,Bucket,Reason,Suggested Fix,Magnitude" && flagsCsv.slice(1).every((r) => r[1] === "Sales"),
    "latest-flags.csv has its fixed columns and the sheet's name");
  ok(paneRows.length > 0 && JSON.stringify(csvRows) === JSON.stringify(paneRows), `latest-flags.csv holds exactly the rows the pane lists (${paneRows})`);
  const r11 = scanCsv.find((r) => r[0] === "11");
  ok(scanCsv.length === 301 && scanCsv[0].slice(0, 6).join() === "Excel Row,OrderDate,Region,Units,UnitCost,Total" && r11[3] === "-5"
    && r11[6] === "Medium" && /Units: -5 → /.test(r11[9]), "latest-scan.csv: every row, Excel's row numbers, row 11's -5 and its suggested fix - " + r11);
  await powerBi(false); await find();
  ok(!fs.existsSync(CSV) && !fs.existsSync(FLAGS), "Power BI turned off: the next scan deletes both copies");

  // 6e) the footer's Privacy and Support links open their pages from the engine
  for (const link of ["Privacy", "Support"]) {
    const [pop] = await Promise.all([page.waitForEvent("popup"), page.click(`#pane-footer .pf-links a:has-text("${link}")`)]);
    await pop.waitForLoadState();
    const status = await pop.evaluate(() => performance.getEntriesByType("navigation")[0].responseStatus);
    ok(status === 200 && (await pop.title()) === `Anomaly Hunter, ${link}`, `${link} link opens its page (HTTP ${status})`);
    await pop.close();
  }

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

  // 8) an empty sheet gets a plain message, not an error
  await page.evaluate(() => __load("Empty", [["only a header"]]));
  await page.click("#scan"); await idle();
  ok((await text("#notice")).startsWith("Not enough data here."), "empty sheet explained");
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
  ok(odd.length === 100 && odd.every((t) => /^Row \d+: Region "Central" - <img src=x onerror=/.test(t)), `each row with the odd word listed (${odd.length}) - ${odd[0]}`);
  ok(!(await page.$("#odd-list img")) && !(await page.evaluate(() => window.__pwned)) && !odd.some((t) => t.includes("Atlantis")),
    "the AI's words are text, never markup; a word the AI made up is dropped");
  const sent = fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").map(JSON.parse).find((l) => l.prompt.includes("distinct values"));
  ok(sent && sent.prompt.includes('"Region"') && !/7777|170\.43|Units|2026-/.test(sent.prompt), "Check words sends the text column's words only, no numbers, dates or rows");
}

if (mode === "nokey") {
  await find();
  await openRow(11);
  ok(!(await page.isVisible("#ai-box")) && (await page.isVisible("#ai-off")), "without a key: no Ask AI, a pointer to the free setup");
  await page.click("#settings summary");
  await page.fill("#ai-key", "<script>"); await page.click("#save-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent.includes("doesn't look like an API key"));
  ok(true, "junk key refused");
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
  await page.click("#remove-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent === "Key removed. AI help is off.");
  ok(!(await page.isVisible("#ai-box")) && (await page.isVisible("#ai-off")) && !fs.existsSync(DIR + "cert/invite-code.txt"),
    "Remove key: AI help off, the code deleted from this PC");
}

if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pane-${mode}.png`, fullPage: true }); // proof for people
const real = errors.filter((e) => !(mode === "nokey" && e.includes("status of 400"))); // the junk key gets the engine's 400 on purpose
ok(real.length === 0, "no page errors " + JSON.stringify(real));
await browser.close();
