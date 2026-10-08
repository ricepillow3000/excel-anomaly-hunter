// Browser test of the REAL pane against the REAL engine, with fake-office.js standing in for Excel.
// Run via e2e/all.sh (needs node + playwright with chromium, and the repo's .venv). Modes: flow ai nokey.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
const pw = await import(process.env.PLAYWRIGHT || "playwright") // local install, else the global one
  .catch(() => import(pathToFileURL(createRequire(import.meta.url).resolve("playwright", { paths: [process.env.NODE_PATH || ""] })).href));
const { chromium } = pw.chromium ? pw : pw.default;
const DIR = fileURLToPath(new URL(".", import.meta.url));
const mode = process.argv[2] || "flow";
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok -", m); };

// 300 sales orders + planted problems: Units -5 (row 11), Units 9999 (row 22), a double entry (row 51),
// "east " (row 81), a blank Units (row 121). Row 11 also wears the user's own green fill.
const rows = [["OrderDate", "Region", "Units", "UnitCost", "Total"]];
for (let i = 0; i < 300; i++) { const u = 40 + ((i * 7) % 23), c = 1.99 + (i % 4); rows.push([46028 + i, ["East", "West", "Central"][i % 3], u, c, +(u * c).toFixed(2)]); }
rows[10][2] = -5; rows[21][2] = 9999; rows[50] = [...rows[49]]; rows[80][1] = "east "; rows[120][2] = "";

// Playwright's own Chromium if installed, else the Edge every Windows PC has
const browser = await chromium.launch().catch(() => chromium.launch({ channel: "msedge" }));
const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.stack));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
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
  const fills = await page.evaluate(() => ["A11", "A22", "A51", "A81", "A121", "A2"].map((a) => __cell("Sales", a).fill));
  ok(fills.slice(0, 5).every((f) => f === "#FFEB9C") && fills[5] === null, "flagged rows highlighted, clean rows not - " + fills);

  // 2) open a row, Apply, Undo
  await openRow(11);
  ok((await text("#fix-title")) === "Row 11: probably wrong", "fix view titled in words");
  ok((await text("#fix-reason")) === "Units is -5, below its usual limit of 0", "reason in plain words");
  ok((await text("#fix-changes")).startsWith("C11: -5 → "), "preview old -> new");
  await page.click("#fix-apply"); await idle();
  ok((await cell("C11")).v !== -5 && (await page.isVisible("#fix-undo")) && (await text("#fix-apply")) === "Applied", "Apply writes the cell");
  await page.click("#fix-undo"); await idle();
  ok((await cell("C11")).v === -5 && !(await page.isVisible("#fix-undo")), "Undo puts it back");

  // 3) clicking a highlighted row in the sheet opens it too
  await page.click("#fix-back");
  await page.evaluate(() => __userSelect("Sales", "B22"));
  await page.waitForFunction(() => document.getElementById("fix-title").textContent.startsWith("Row 22"), null, { timeout: 10000 }).catch(() => {});
  ok((await text("#fix-title")).startsWith("Row 22"), "sheet click opens the row");
  await idle();

  // 4) Remove highlights puts back exactly what was there (the user's green row 11 too)
  await page.click("#fix-back");
  await page.click("#clear-highlights"); await idle();
  const after = await page.evaluate(() => ["A11", "A22", "B22", "A51"].map((a) => __cell("Sales", a).fill));
  ok(after[0] === "#00B050" && after[1] === null && after[2] === "#00B0F0" && after[3] === null, "Remove highlights restores the old fills, cell by cell on a two-color row - " + after);
  ok((await text("#notice")).startsWith("Highlights removed"), "and says so");

  // 5) ...also after the pane was closed and reopened (no memory of what it painted)
  await find();
  await page.evaluate(() => { painted = null; __fill("Sales", "A30", "#00B050"); });
  await page.click("#clear-highlights"); await idle();
  const cleared = await page.evaluate(() => ["A22", "A51", "A30"].map((a) => __cell("Sales", a).fill));
  ok(cleared[0] === null && cleared[1] === null && cleared[2] === "#00B050", "reopened pane: only OUR colors are removed - " + cleared);

  // 6) limits: plain words, bad input refused, saving rescans, "Back to automatic" resets
  const openStrict = () => page.locator("details.more").first().evaluate((d) => (d.open = true));
  await openStrict();
  await page.click("#edit-limits");
  const units = page.locator('#limits-rows .limits-row[data-column="Units"] input');
  await units.nth(0).fill("200"); await units.nth(1).fill("100"); await page.click("#save-limits");
  ok((await text("#limits-error")).includes('"Flag below" is bigger than "Flag above"') && (await page.isVisible("#limits-editor")), "low above high is refused");
  await units.nth(0).fill("-10"); await units.nth(1).fill("10000"); await page.click("#save-limits"); await idle();
  ok(!(await text("#flagged-list")).includes("Units is 9999"), "saved limits are used at once");
  ok(await page.evaluate(() => Object.keys(__settings.anomalyHunterLimits).join() === "Units"), "only the changed column is saved");
  await openStrict();
  await page.click("#edit-limits"); await page.click("#auto-limits"); await idle();
  ok(await page.evaluate(() => __settings.anomalyHunterLimits === undefined) && (await text("#flagged-list")).includes("Units is 9999"), "Back to automatic");

  // 7) rescans don't stack click-watchers; a second sheet takes the watcher over
  await find(); await find();
  ok(await page.evaluate(() => __handlers("Sales")) === 1, "rescans don't stack selection handlers");
  await page.evaluate((rows) => __load("Other", rows, [0]), rows);
  await find();
  ok(await page.evaluate(() => __handlers("Sales") === 0 && __handlers("Other") === 1), "watcher moved to the newly checked sheet");

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
  await page.fill("#fix-intent", "use the average Units for East");
  await page.click("#fix-ask");
  await page.waitForFunction(() => document.getElementById("fix-label").textContent === "AI's fix", null, { timeout: 30000 });
  ok((await text("#fix-changes")).startsWith("C11: -5 → =AVERAGEIFS("), "AI's fix previewed - " + (await text("#fix-changes")));
  ok((await cell("C11")).v === -5, "nothing written before Apply");
  await page.click("#fix-apply"); await idle();
  ok(String((await cell("C11")).f).startsWith("=AVERAGEIFS("), "Apply writes the AI formula");
}

if (mode === "nokey") {
  await find();
  await openRow(11);
  ok(!(await page.isVisible("#ai-box")) && (await page.isVisible("#ai-off")), "without a key: no Ask AI, a pointer to the free setup");
  await page.click("#settings summary");
  await page.fill("#ai-key", "<script>"); await page.click("#save-key");
  await page.waitForFunction(() => document.getElementById("ai-state").textContent.includes("doesn't look like an API key"));
  ok(true, "junk key refused");
}

const real = errors.filter((e) => !(mode === "nokey" && e.includes("status of 400"))); // the junk key gets the engine's 400 on purpose
ok(real.length === 0, "no page errors " + JSON.stringify(real));
await browser.close();
