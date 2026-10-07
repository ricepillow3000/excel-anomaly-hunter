// Browser test of the REAL panel against the REAL engine, with fake-office.js standing in for Excel.
// Run via ./e2e/all.sh (needs: node + playwright with chromium, the repo's .venv). Modes: ai oldengine layout layers monitor nokey.
import { createRequire } from "node:module";
const pw = await import(process.env.PLAYWRIGHT || "playwright") // local install, else the global one
  .catch(() => import(createRequire(import.meta.url).resolve("playwright", { paths: [process.env.NODE_PATH || ""] })));
const { chromium } = pw.chromium ? pw : pw.default;
import fs from "node:fs";
const DIR = new URL(".", import.meta.url).pathname;
const mode = process.argv[2] || "ai";
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok -", m); };

// 40 sales orders + planted anomalies: Units -5 (sheet row 11), Units 9999 (row 22)
const rows = [["OrderDate", "Region", "Units", "UnitCost"]];
for (let i = 0; i < 40; i++) rows.push([46028 + i, ["East", "West", "Central"][i % 3], 40 + ((i * 7) % 23), 1.99 + (i % 4)]);
rows[10][2] = -5; rows[21][2] = 9999;
const med = (xs) => { const v = [...xs].sort((a, b) => a - b), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const unitsWithout = (sheetRow) => rows.slice(1).filter((_, k) => k + 2 !== sheetRow).map((r) => r[2]);
const REC11 = String(med(unitsWithout(11))), REC22 = String(med(unitsWithout(22)));
console.log("expected medians: row 11 ->", REC11, " row 22 ->", REC22);

const browser = await chromium.launch();
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack));
page.on("console", async (m) => m.type() === "error" && errors.push(m.text() + " | " + (await Promise.all(m.args().map((a) => a.evaluate((x) => (x && x.stack) || String(x)).catch(() => "?")))).join(" ")));
await page.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
await page.goto("https://127.0.0.1:5055/taskpane.html");
await page.evaluate((rows) => __load("Sales", rows, [0]), rows);
await page.waitForSelector("#main-ui", { state: "visible" });
const vis = (id) => page.isVisible("#" + id);
const text = (sel) => page.textContent(sel);
const cell = (a) => page.evaluate((a) => __cell("Sales", a), a);

const scanned = async () => { await page.click("#scan"); await page.click("#save-limits"); await page.waitForSelector("#results", { state: "visible" }); };
const recShown = () => page.waitForFunction(() => document.querySelector("#fix-result").style.display === "block" && document.querySelector("#fix-label").textContent === "Recommended fix");

if (mode === "monitor") { // L6 Route Monitor + web research, with screenshots of each state (e2e/rm-*.png)
  const shot = async (name) => (await page.$("#route-monitor")).screenshot({ path: DIR + `rm-${name}.png` });
  const has = (id, cls) => page.evaluate(([id, cls]) => document.getElementById(id).classList.contains(cls), [id, cls]);
  const note = (src) => text(`#rm-src-${src} .rm-note`);
  const trace = () => text("#rm-trace");
  const research = () => fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").map(JSON.parse).filter((l) => l.tools.length);
  await shot("0-idle");
  ok((await note("engine")) === "always on" && (await note("web")) === "on request", "idle: shelves say what they can do");
  await scanned();
  await shot("1-scanned");
  const counts = await page.$$eval(".rm-count", (t) => t.map((x) => +x.textContent));
  const total = counts.reduce((a, b) => a + b, 0);
  ok(total > 0 && (await text("#rm-caption")).startsWith(`${total} issue`), "scan: department counts add up to the caption - " + counts);
  ok(+(await text("#rm-Irregularities .rm-count")) >= 2, "scan: both planted Units values reach Irregularities");

  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  await recShown();
  await shot("2-investigate-row11");
  ok(await has("rm-Irregularities", "is-target") && (await text("#rm-row")) === "Row 11", "row 11: its case goes to Irregularities, the card names the row");
  ok((await text("#rm-desc")).startsWith("Row 11 → Irregularities → Engine checks"), "row 11: caption and accessible description name the path");
  ok((await trace()).includes("C11 Units = -5 · limit"), "row 11: trace line has the cell and plain numbers - " + (await trace()).slice(-120));
  ok((await page.getAttribute("#rm-route-engine", "d")).startsWith("M158 64") && await has("rm-route-engine", "is-on")
    && !(await has("rm-route-ai", "is-on")), "row 11: only the engine route is drawn, from the case");

  await page.fill("#fix-intent", "slow please, average for East");
  await page.click("#fix-ask");
  await page.waitForTimeout(700);
  await shot("3-ai-pending");
  ok(await has("rm-route-ai", "is-pending") && (await note("ai")) === "thinking…", "Ask AI: dashed route while Claude thinks");
  await page.waitForFunction(() => document.querySelector("#fix-label").textContent === "AI suggestion", null, { timeout: 15000 });
  await shot("4-ai-answered");
  ok(await has("rm-route-ai", "is-on") && !(await has("rm-route-ai", "is-pending")) && (await trace()).includes("Claude: C11 → =AVERAGEIFS"),
    "Ask AI: solid route once answered; the trace quotes the proposed value");

  await page.click("#fix-research");
  await page.waitForTimeout(500);
  ok(await has("rm-route-web", "is-pending") && (await note("web")) === "searching…", "Research: dashed route to Excel pros while searching");
  await page.waitForSelector("#fix-web", { state: "visible", timeout: 15000 });
  await shot("5-research");
  ok((await text("#web-sources")) === "exceljet.net" && (await page.getAttribute("#web-sources a", "href")).startsWith("https://exceljet.net/"),
    "Research: only the vetted source is shown - " + (await text("#web-sources")));
  ok((await text("#web-formula")) === '=COUNTIF(C:C,"<0")' && (await page.$$("#web-steps li")).length === 3, "Research: formula and steps shown");
  ok((await note("web")) === "1 source" && (await trace()).includes("Excel pros (1): Excel pros mark"), "Research: shelf and trace say what came back");
  const calls = research();
  ok(calls.length === 2 && calls[1].turns === 2 && !calls[0].prompt.includes("-5"), "Research: a paused search resumed once; no sheet values in the prompt");
  ok((await cell("C11")).v === -5, "Research writes nothing to the sheet");
  await page.click("#web-use");
  ok((await page.inputValue("#fix-intent")).startsWith("Use this approach from Excel pros: "), "Use in Ask AI fills the request box only");

  await page.fill("#fix-intent", "slow please");
  await page.click("#fix-ask");
  await page.click("#fix-back");
  ok(!(await has("rm-case", "is-active")) && (await page.getAttribute("#rm-route-ai", "d")) === "", "Back: case returns home, routes cleared");
  await page.waitForFunction(() => !document.querySelector("#fix-ask").disabled, null, { timeout: 15000 });
  ok(!(await has("rm-route-ai", "is-on")), "Back: an AI answer that lands later draws no route");

  await page.click("#flagged-list li[data-row-index] >> text=Row 22");
  await recShown();
  await shot("6-investigate-row22");
  const before = research().length;
  await page.click("#fix-research"); // a different issue: a real search that the next Scan makes stale
  await page.click("#scan"); // limits are saved now: straight to the results
  await page.waitForSelector("#results", { state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#fix-research").disabled, null, { timeout: 15000 });
  ok(research().length === before + 1 && !(await vis("fix-web")) && !(await has("rm-route-web", "is-on")), "a research answer after a new Scan is dropped");

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  await recShown();
  await page.fill("#fix-intent", "slow please");
  await page.click("#fix-ask");
  ok(await page.evaluate(() => getComputedStyle(document.getElementById("rm-route-ai")).animationName === "none"
    && getComputedStyle(document.getElementById("rm-case")).transitionDuration === "0s"), "reduced motion: nothing animates");
  await page.waitForFunction(() => !document.querySelector("#fix-ask").disabled, null, { timeout: 15000 });
  await page.setViewportSize({ width: 280, height: 900 });
  await shot("7-narrow-280");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= 280), "280px pane: no sideways scroll");
} else if (mode === "layers") {
  // 1) Clear highlights must restore the ORIGINAL fills even after several scans
  await page.evaluate(() => { __fill("Sales", "A5", "#C6EFCE"); __fill("Sales", "B5", "#C6EFCE"); });
  await scanned(); // first scan + limits
  await page.click("#scan"); await page.waitForSelector("#results", { state: "visible" }); // second scan
  await page.waitForFunction(() => !document.querySelector("#scan").disabled);
  await page.click("#clear-highlights");
  await page.waitForTimeout(300);
  const fills = await page.evaluate(() => Array.from({ length: 41 }, (_, k) => __cell("Sales", "A" + (k + 1)).fill));
  ok(fills.every((f, k) => (k === 4 ? f === "#C6EFCE" : f == null)), "Clear after 2 scans restores original fills: " + JSON.stringify(fills.filter(Boolean)));
  // 2) Route Monitor rescans the WATCHED sheet even when another sheet is active
  await page.click("#scan"); await page.waitForSelector("#results", { state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#scan").disabled);
  await page.check("#watch-toggle");
  await page.evaluate((rows) => { __load("Other", rows); __activate("Other"); }, rows.map((r) => r.map((v) => (typeof v === "number" ? v + 1 : v))));
  await page.evaluate(() => __activate("Other"));
  await page.evaluate(() => { __activate("Other"); __edit("Sales", "C30", 7777); });
  await page.waitForTimeout(2500);
  const otherFilled = await page.evaluate(() => Array.from({ length: 41 }, (_, k) => __cell("Other", "A" + (k + 1)).fill).filter(Boolean).length);
  ok(otherFilled === 0, "rescan never paints the sheet that merely happens to be active (painted " + otherFilled + ")");
  ok((await page.evaluate(() => __cell("Sales", "A30").fill)) !== null, "rescan re-checked the watched sheet: row 30 now highlighted");
  await page.uncheck("#watch-toggle");
  await page.evaluate(() => __activate("Sales"));
  // 3) a scan and a watch rescan racing still leave Clear able to restore everything
  await page.check("#watch-toggle");
  await page.evaluate(() => __edit("Sales", "D12", 3.33));
  await page.waitForTimeout(1400);
  await page.click("#scan"); // lands while the debounced rescan fires
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => !document.querySelector("#scan").disabled);
  await page.uncheck("#watch-toggle");
  await page.click("#clear-highlights"); await page.waitForTimeout(300);
  const fills2 = await page.evaluate(() => Array.from({ length: 41 }, (_, k) => __cell("Sales", "A" + (k + 1)).fill));
  ok(fills2.every((f, k) => (k === 4 ? f === "#C6EFCE" : f == null)), "scan racing a rescan: Clear still restores originals: " + JSON.stringify(fills2.filter(Boolean)));
  // 4) Apply then Scan right away: the scan sees the applied value
  await page.click("#scan"); await page.waitForSelector("#results", { state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#scan").disabled);
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  await recShown();
  await page.click("#fix-apply");
  await page.click("#scan");
  await page.waitForFunction(() => !document.querySelector("#scan").disabled && document.querySelector("#results").style.display === "block");
  const after = await page.$$eval("#flagged-list li[data-row-index]", (l) => l.map((li) => li.querySelector(".row-head span").textContent));
  ok((await cell("C11")).v !== -5 && !after.includes("Row 11"), "Apply then Scan: the scan saw the fix (row 11 no longer flagged)");
  // 5) clicking a flagged row while a scan runs opens it after the scan, with current data
  await page.click("#scan");
  await page.evaluate(() => __userSelect("Sales", "B22"));
  await page.waitForFunction(() => document.querySelector("#fix-view").style.display === "block", null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  ok((await text("#fix-title")).startsWith("Fix row 22") && (await vis("fix-view")), "row clicked during a scan opens once the scan is done");
  // 6) Apply and Undo clicked back to back run in order: the cell ends as it started
  await page.click("#fix-back");
  await page.click("#scan"); await page.waitForFunction(() => !document.querySelector("#scan").disabled && document.querySelector("#results").style.display === "block");
  await page.click("#flagged-list li[data-row-index] >> text=Row 22");
  await recShown();
  const before22 = (await cell("C22")).v;
  await page.evaluate(() => { document.querySelector("#fix-apply").click(); });
  await page.waitForSelector("#fix-undo", { state: "visible" });
  await page.evaluate(() => { document.querySelector("#fix-undo").click(); document.querySelector("#fix-undo").click(); });
  await page.waitForTimeout(500);
  ok((await cell("C22")).v === before22, "Apply then double Undo: the cell is exactly what it was");
  // 7) a late AI answer is dropped once Scan was pressed
  await page.fill("#fix-intent", "slow please, median");
  await page.click("#fix-ask");
  await page.waitForTimeout(300);
  await page.click("#scan");
  await page.waitForTimeout(4500); // the AI answer lands after the scan
  ok(await vis("results") && !(await vis("fix-view")), "late AI answer did not reopen the old fix over the new results");
  // 8) scanning another sheet puts the first sheet's highlights back
  await page.evaluate((rows) => { __load("Second", rows); __activate("Second"); }, rows);
  await page.click("#scan"); await page.waitForFunction(() => !document.querySelector("#scan").disabled && document.querySelector("#results").style.display === "block");
  const salesFills = await page.evaluate(() => Array.from({ length: 41 }, (_, k) => __cell("Sales", "A" + (k + 1)).fill));
  ok(salesFills.every((f, k) => (k === 4 ? f === "#C6EFCE" : f == null)), "scanning sheet 2 restored sheet 1: " + JSON.stringify(salesFills.filter(Boolean)));
  ok((await page.evaluate(() => __cell("Second", "C11").fill)) !== null, "and sheet 2 is highlighted");
  // 9) Undo writes back to the sheet the fix was applied on, even after the watched sheet rescanned
  await page.evaluate(() => __activate("Sales"));
  await page.click("#scan"); await page.waitForFunction(() => !document.querySelector("#scan").disabled && document.querySelector("#results").style.display === "block");
  await page.check("#watch-toggle"); // watching Sales
  await page.evaluate(() => __activate("Second"));
  await page.click("#scan"); await page.waitForFunction(() => !document.querySelector("#scan").disabled && document.querySelector("#results").style.display === "block");
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  await recShown();
  const s11 = await page.evaluate(() => [__cell("Sales", "C11").v, __cell("Second", "C11").v]);
  await page.click("#fix-apply"); await page.waitForSelector("#fix-undo", { state: "visible" });
  await page.evaluate(() => __edit("Sales", "D30", 1.11)); // watched sheet changes -> auto-rescan of Sales
  await page.waitForTimeout(2500);
  await page.click("#fix-undo"); await page.waitForTimeout(500);
  const u = await page.evaluate(() => [__cell("Sales", "C11").v, __cell("Second", "C11").v]);
  ok(u[0] === s11[0] && u[1] === s11[1], `Undo restored sheet 2 and left the watched sheet alone: ${JSON.stringify(s11)} -> ${JSON.stringify(u)}`);
  await page.uncheck("#watch-toggle");
  // 10) quick off/on/off/on of the watch box leaves exactly one watcher
  await page.evaluate(() => __activate("Second"));
  const box = page.locator("#watch-toggle");
  await box.click(); await box.click(); await box.click(); await box.click();
  await page.waitForTimeout(800);
  const n = await page.evaluate(() => __changed("Second"));
  ok(n === ((await box.isChecked()) ? 1 : 0), `watch toggled 4x quickly: ${n} watcher(s), box ${await box.isChecked() ? "on" : "off"}`);
  if (await box.isChecked()) await box.click();
  await page.waitForTimeout(300);
  // 11) a row the user recolored themselves keeps their color when highlights are cleared
  await page.click("#scan"); await page.waitForFunction(() => !document.querySelector("#scan").disabled && document.querySelector("#results").style.display === "block");
  await page.evaluate(() => __fill("Second", "A11", "#00B0F0"));
  await page.click("#clear-highlights"); await page.waitForTimeout(400);
  ok((await page.evaluate(() => __cell("Second", "A11").fill)) === "#00B0F0", "user's own recolor survives Clear highlights");
  // 12) a failed Approve says so
  await page.check("#ai-toggle"); await page.click("#run-triage");
  await page.waitForSelector(".approve-btn");
  await page.evaluate(() => __drop("Second")); // the scanned sheet disappears -> the note can't be written
  await page.click(".approve-btn"); await page.waitForTimeout(600);
  ok((await text(".approve-btn")) === "Failed - retry", "failed Approve shows 'Failed - retry': " + (await text(".approve-btn")));
} else if (mode === "layout") {
  // construction cost report: 3 title rows, header on row 4, data rows 5-44, formula column, Grand Total on row 45
  const g = [["Project: Riverside Medical Office"], ["Cost Report - Period 9"], [""],
    ["Cost Code", "Item", "Budget", "Actual", "Variance", "% Complete", "Trade"]];
  for (let k = 0; k < 40; k++) {
    const b = 20000 + ((k * 7919) % 30000), a = Math.round(b * (0.85 + ((k * 37) % 30) / 100));
    g.push([`03-${100 + k}`, `Line ${k}`, b, a, b - a, Math.round((0.2 + ((k * 13) % 80) / 100) * 100) / 100, ["Concrete", "Electrical", "Plumbing"][k % 3]]);
  }
  const R = (sheetRow) => g[sheetRow - 1];
  R(12)[5] = 85; // % typed as 85 for 0.85
  const trueActual = R(25)[3]; R(25)[3] = trueActual * 10; R(25)[4] = R(25)[2] - R(25)[3]; // x10 slip; formula result follows
  R(33)[6] = "concrete "; // spelling variant
  g.push(["", "Grand Total", g.slice(4).reduce((s, r) => s + r[2], 0), g.slice(4).reduce((s, r) => s + r[3], 0), "", "", ""]);
  await page.evaluate((g) => __load("Cost", g), g);
  await page.evaluate(() => { for (let r = 5; r <= 44; r++) __formula("Cost", "E" + r, `=C${r}-D${r}`); });
  const cost = (a) => page.evaluate((a) => __cell("Cost", a), a);
  await scanned();
  const items = await page.$$eval("#flagged-list li[data-row-index]", (l) => l.map((li) => li.querySelector(".row-head span").textContent));
  console.log("flagged:", items.join(", "));
  ok(items.includes("Row 12") && items.includes("Row 25") && items.includes("Row 33"), "flags the % typo, the x10 slip and the spelling, by their real sheet rows");
  ok(!items.includes("Row 45") && (await cost("C45")).fill === null, "Grand Total row is not flagged or highlighted");
  ok((await cost("A12")).fill !== null && (await cost("A11")).fill === null && (await cost("A1")).fill === null, "highlight lands on sheet row 12, not on the titles");
  // % typed as 85
  await page.evaluate(() => __userSelect("Cost", "F12"));
  await recShown();
  ok((await text("#fix-changes li")) === "F12: 85 → 0.85", "row 12: " + (await text("#fix-changes li")));
  ok((await text("#fix-explanation")).includes("looks like a typo for 0.85 (extra zeros - x100)"), await text("#fix-explanation"));
  await page.click("#fix-apply"); await page.waitForSelector("#fix-undo", { state: "visible" });
  ok((await cost("F12")).v === 0.85 && (await cost("F11")).v !== 0.85, "Apply wrote F12 exactly");
  await page.click("#fix-undo"); await page.waitForSelector("#fix-undo", { state: "hidden" });
  ok((await cost("F12")).v === 85, "Undo restored 85");
  // x10 slip: fix Actual, never type over the Variance formula
  await page.evaluate(() => __userSelect("Cost", "B25"));
  await recShown();
  const ch = await page.$$eval("#fix-changes li", (l) => l.map((x) => x.textContent));
  ok(ch.length === 1 && ch[0] === `D25: ${trueActual * 10} → ${trueActual}`, "row 25 fixes Actual only: " + JSON.stringify(ch));
  const ex = await text("#fix-explanation");
  ok(ex.includes("E25 is calculated by a formula") || !ch.some((c) => c.startsWith("E25")), "Variance formula is never overwritten: " + ex);
  await page.click("#fix-apply"); await page.waitForSelector("#fix-undo", { state: "visible" });
  ok((await cost("D25")).v === trueActual && (await cost("E25")).f === "=C25-D25", "Apply fixed D25, E25 formula intact");
  await page.click("#fix-undo"); await page.waitForSelector("#fix-undo", { state: "hidden" });
  // spelling
  await page.evaluate(() => __userSelect("Cost", "G33"));
  await recShown();
  ok((await text("#fix-changes li")) === "G33: concrete  → Concrete", "row 33: " + (await text("#fix-changes li")));
  await page.screenshot({ path: DIR + "fix-layout.png", fullPage: true });
} else if (mode === "nokey" || mode === "oldengine") {
  if (mode === "oldengine") await page.route("**/fix", (r) => r.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html><title>404 Not Found</title>" }));
  await scanned();
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  ok(await vis("fix-view"), mode + ": fix view opens");
  await recShown();
  ok((await text("#fix-changes li")) === `C11: -5 → ${REC11}`, mode + ": instant recommendation without AI: " + (await text("#fix-changes li")));
  ok((await text("#fix-explanation")).startsWith("Units is -5, outside its limits"), mode + ": says why in plain English");
  await page.click("#fix-apply");
  await page.waitForSelector("#fix-undo", { state: "visible" });
  ok((await cell("C11")).v === +REC11, mode + ": Apply works without AI");
  await page.click("#fix-undo");
  await page.waitForSelector("#fix-undo", { state: "hidden" });
  ok((await cell("C11")).v === -5, mode + ": Undo works without AI");
  if (mode === "nokey") {
    ok(await page.isDisabled("#fix-ask"), "no key: Ask AI disabled");
    ok(await page.isDisabled("#fix-research") && (await text("#rm-src-web .rm-note")) === "needs API key", "no key: web research disabled, and the monitor says why");
    ok(await page.evaluate(() => document.getElementById("rm-route-engine").classList.contains("is-on")), "no key: the engine route still draws");
    ok(await vis("fix-nokey") && (await text("#fix-nokey")).includes("ANTHROPIC_API_KEY"), "no key: says why, even after Apply/Undo");
  } else {
    await page.fill("#fix-intent", "anything");
    await page.click("#fix-ask");
    await page.waitForFunction(() => document.querySelector("#fix-status").textContent.length > 0);
    ok((await text("#fix-status")).includes("re-run install.bat"), "old engine: clear message - " + (await text("#fix-status")));
    ok((await text("#fix-label")) === "Recommended fix" && (await vis("fix-apply")) && !(await page.isDisabled("#fix-apply")), "old engine: recommendation stays usable");
  }
} else {
  await page.click("#scan");
  await page.waitForSelector("#limits-editor", { state: "visible" });
  ok(await page.evaluate(() => __handlers("Sales")) === 0, "no click-to-fix before limits are saved");
  await page.click("#save-limits");
  await page.waitForSelector("#results", { state: "visible" });
  const items = await page.$$eval("#flagged-list li[data-row-index]", (l) => l.map((li) => li.querySelector(".row-head span").textContent));
  console.log("flagged:", items.join(", "));
  ok(items.includes("Row 11") && items.includes("Row 22"), "both planted rows flagged");
  ok((await page.evaluate(() => __cell("Sales", "C11").fill)) !== null, "row 11 highlighted in sheet");
  ok(await page.evaluate(() => __handlers("Sales")) === 1, "one selection handler after scan");

  // 1) click in the sheet -> recommendation pops up at once
  await page.evaluate(() => __userSelect("Sales", "C22"));
  ok(await vis("fix-view") && !(await vis("results")), "clicking highlighted row 22 IN THE SHEET opens the fix view");
  await recShown();
  ok((await text("#fix-changes li")) === `C22: 9999 → ${REC22}`, "row 22 recommendation: " + (await text("#fix-changes li")));
  // 2) list click
  await page.click("#fix-back");
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  ok((await text("#fix-title")).startsWith("Fix row 11"), "list click opens row 11");
  await recShown();
  ok((await text("#fix-changes li")) === `C11: -5 → ${REC11}`, "row 11 recommendation = median of the other rows");
  await page.evaluate(() => __userSelect("Sales", "C22:C30"));
  ok((await text("#fix-title")).startsWith("Fix row 11"), "dragging down from a flagged row doesn't open it");
  ok((await text("#fix-values")).includes("Units: -5") && (await text("#fix-values")).includes("OrderDate: 2026-01-"), "shows row values, dates as dates");
  const clean = [...Array(40).keys()].map((i) => i + 2).find((r) => !items.includes("Row " + r));
  await page.evaluate((r) => __userSelect("Sales", "B" + r), clean);
  ok((await text("#fix-title")).startsWith("Fix row 11"), "clicking a clean row changes nothing");
  await page.evaluate(() => __userSelect("Sales", "A1"));
  ok((await text("#fix-title")).startsWith("Fix row 11"), "clicking the header changes nothing");
  await page.fill("#fix-intent", "half-typed");
  await page.evaluate(() => __userSelect("Sales", "D11"));
  ok((await page.inputValue("#fix-intent")) === "half-typed", "another cell of the same row keeps what you typed");
  // a behavioral-only row gets advice, not a change
  const other = items.map((t) => +t.slice(4)).find((r) => r !== 11 && r !== 22);
  if (other) {
    await page.evaluate((r) => __userSelect("Sales", "B" + r), other);
    await recShown();
    ok(!(await vis("fix-apply")) && (await text("#fix-explanation")).length > 20, `row ${other} (no limit broken): advice only - ${await text("#fix-explanation")}`);
    await page.evaluate(() => __userSelect("Sales", "C11:D11"));
    await recShown();
  }

  // 3) recommended fix: apply -> undo
  ok((await cell("C11")).v === -5, "nothing written before Apply");
  await page.screenshot({ path: DIR + "fix-recommended.png", fullPage: true });
  await page.click("#fix-apply");
  await page.waitForSelector("#fix-undo", { state: "visible" });
  ok((await cell("C11")).v === +REC11 && (await cell("C11")).f === null, "Apply wrote the recommended value");
  ok(await page.isDisabled("#fix-apply"), "Apply can't double-write");
  // Undo survives leaving and reopening the row
  await page.click("#fix-back");
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  await recShown();
  ok(await vis("fix-undo") && (await page.isDisabled("#fix-apply")), "reopened row still offers Undo, blocks a 2nd Apply");
  await page.click("#fix-undo");
  await page.waitForSelector("#fix-undo", { state: "hidden" });
  ok((await cell("C11")).v === -5 && (await cell("C11")).f === null, "Undo restored -5");

  // 4) plain English -> AI suggestion replaces the recommendation
  await page.fill("#fix-intent", "Replace the -5 with the average Units for the East region");
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.querySelector("#fix-label").textContent === "AI suggestion");
  const prompt = fs.readFileSync(DIR + "claude.log", "utf8").trim().split("\n").map(JSON.parse).at(-1);
  ok(prompt.format && prompt.prompt.includes("Data range: A1:D41"), "Claude gets the real data range + structured output");
  ok(prompt.prompt.includes("Flagged row 11: A11='2026-01-15', B11='East', C11=-5, D11=2.99"), "Claude gets the flagged row with addresses");
  ok(prompt.prompt.includes("average Units for the East region"), "Claude gets the user's words");
  ok(prompt.prompt.includes("circular reference"), "Claude is told about circular references");
  const change = await text("#fix-changes li");
  ok(change.includes("C11") && change.includes('=AVERAGEIFS(C2:C10,B2:B10,"East")'), "AI preview shows cell, old -> new: " + change);
  await page.screenshot({ path: DIR + "fix-ai.png", fullPage: true });
  await page.click("#fix-apply");
  await page.waitForSelector("#fix-undo", { state: "visible" });
  ok((await cell("C11")).f === '=AVERAGEIFS(C2:C10,B2:B10,"East")', "Apply wrote the AI formula");
  // a new suggestion while applied keeps Undo (it restores the ORIGINAL -5)
  await page.fill("#fix-intent", "Replace the -5 with the average Units for the East region");
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.querySelector("#fix-ask").textContent === "Ask AI");
  ok(await vis("fix-undo") && (await page.isDisabled("#fix-apply")), "Ask AI after Apply keeps Undo, blocks stacking a 2nd Apply");
  await page.click("#fix-undo");
  await page.waitForSelector("#fix-undo", { state: "hidden" });
  ok((await cell("C11")).v === -5, "Undo restored -5 again");
  ok((await page.evaluate(() => __log.filter((l) => l[0] === "write").map((l) => l[2]))).every((a) => a === "C11"), "only C11 was ever written");

  // 4b) a careless circular answer is dropped by the engine
  await page.fill("#fix-intent", "circular please");
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.querySelector("#fix-explanation").textContent.includes("Left out"));
  ok(!(await vis("fix-apply")), "circular formula from AI is never offered");

  // 4) a request that can't be a cell write
  await page.fill("#fix-intent", "delete this row");
  await page.press("#fix-intent", "Control+Enter");
  await page.waitForFunction(() => document.querySelector("#fix-explanation").textContent.includes("right-click"));
  ok(!(await vis("fix-apply")), "no-change answer hides Apply, explains manual steps");

  // 5) back, triage, limits editor guard, rescan
  await page.click("#fix-back");
  ok(await vis("results"), "Back returns to flagged rows");
  await page.check("#ai-toggle"); await page.click("#run-triage");
  await page.waitForSelector(".approve-btn");
  await page.click(".approve-btn");
  ok(await vis("results"), "approving a triage note doesn't open the fix view");
  await page.click("#flagged-list li[data-row-index] >> text=Row 11");
  ok((await text("#fix-reason")).includes("AI: broken-weird"), "fix view shows the AI triage verdict");
  await page.click("#fix-back");
  await page.click("#edit-limits");
  await page.waitForSelector("#limits-editor", { state: "visible" });
  await page.evaluate(() => __userSelect("Sales", "B22"));
  ok(await vis("limits-editor"), "clicking a flagged row never yanks you out of the limits editor");
  await page.click("#save-limits");
  await page.waitForSelector("#results", { state: "visible" });
  await page.click("#scan"); await page.waitForSelector("#results", { state: "visible" });
  ok(await page.evaluate(() => __handlers("Sales")) === 1, "rescans don't stack selection handlers");
  await page.evaluate(() => __userSelect("Sales", "A22"));
  await page.waitForFunction(() => document.querySelector("#fix-title").textContent.startsWith("Fix row 22"), null, { timeout: 10000 }).catch(() => {});
  ok((await text("#fix-title")).startsWith("Fix row 22"), "sheet click still works after rescans");

  // 6) scanning a second sheet moves the click-watcher to it
  await page.evaluate((rows) => __load("Other", rows, [0]), rows);
  await page.click("#scan");
  await page.waitForFunction(() => __handlers("Other") === 1, null, { timeout: 10000 }).catch(() => {});
  ok(await page.evaluate(() => __handlers("Sales") === 0 && __handlers("Other") === 1), "watcher moved to the newly scanned sheet");
}
const real = errors.filter((e) => !(mode === "oldengine" && e.startsWith("Failed to load resource: the server responded with a status of 404"))
  && !(mode === "layers" && e.includes("ItemNotFound Second"))); // test 12 deletes that sheet on purpose
ok(real.length === 0, "no page errors " + JSON.stringify(real));
await browser.close();
