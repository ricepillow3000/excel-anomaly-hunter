// Anomaly Hunter task pane. Talks to local engine at same origin. Plain JS, no build.
const SERVER = "https://127.0.0.1:5055";
const KEY = "anomalyHunterLimits"; // limits saved inside the workbook
const COLOR = { High: "#FFC7CE", Medium: "#FFEB9C", Low: "#FFFFCC", Noted: "#FFF8DC" };
const CAP = 25; // ponytail: list cap so big sheets don't flood the pane
const PANELS = ["empty-state", "limits-editor", "results", "fix-view", "error-state"];

// ==== How the pane is wired: five layers in a line, like a circuit, plus a monitor watching them ====
//   L1 Scan -> L2 Flag -> L3 Highlight -> L4 Suggest (click a row: fix, Apply, Undo) -> L5 Ask AI
//   L6 Route Monitor: each layer reports to it; it draws where every issue goes and which sources answered.
// Each button enters at one layer; a layer only works on what the layer before handed it.
// Everything that reads or writes the sheet goes through `circuit`: one action at a time, in click
// order - a scan, an auto-rescan, an Apply and an Undo can never interleave.
// Before a new scan, the layers below it stand down (resetDownstream).

// State, by the layer that owns it:
let lastScan = null; // L1: {columns, rows, startRow, startCol, sheet, calc} the scan read
let lastRows = null; // L1: the engine's verdict per row
let editorSheet = null; // L1: sheet data the limits editor rescans
let triageRows = []; // L2: the flagged rows shown (what triage reads)
let painted = null; // L3: {sheet, startRow, startCol, width, colors: {row: old color}} - what Clear highlights puts back
let picker = null; // L4: onSelectionChanged handle - clicking a highlighted row opens its fix
let fix = null; // L4: {i, changes} for the row open in the fix view
let undos = {}; // L4: row index -> cells to restore, while an applied fix hasn't been undone
let triaged = {}; // L5: row_index -> AI triage verdict, shown in the fix view
let aiAvailable = false; // L5
let watch = null; // Route Monitor: {handle, sheet} - re-runs L1-L3 when the watched sheet changes
let watchTimer = null;

let line = Promise.resolve(); // the circuit: each action waits for the one before it
const circuit = (fn) => (...args) => {
  const run = line.then(() => fn(...args));
  line = run.catch((e) => console.error(e)); // one failed action never stops the next
  return run; // ...but its caller still hears about it
};

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => ($(id).style.display = on ? "block" : "none");
let view = null; // which of PANELS is showing
const only = (id) => ((view = id), PANELS.forEach((p) => show(p, p === id)));
const serverUp = (up) => (show("main-ui", up), show("server-down", !up));

if (typeof Office !== "undefined") {
  // guarded: selfcheck.js loads this file in plain Node
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Excel) return;
    show("sideload-msg", false);
    show("app-body");
    // sheet-touching buttons go through the circuit; Ask AI / triage only talk to the engine
    $("scan").onclick = () => {
      $("scan").disabled = true;
      $("scan").textContent = "Scanning…";
      resetDownstream();
      circuit(runScan)().catch(() => {});
    };
    $("retry-health").onclick = checkHealth;
    $("save-limits").onclick = () => (resetDownstream(), circuit(saveLimitsAndRescan)().catch(() => {}));
    $("edit-limits").onclick = circuit(editSavedLimits);
    $("clear-highlights").onclick = circuit(clearHighlights);
    $("run-triage").onclick = runTriage;
    $("watch-toggle").onchange = (e) => circuit(onWatchToggle)(e.target.checked).catch(() => {}); // on/off as clicked
    $("fix-back").onclick = () => (only("results"), monitor.home(), monitor.caption("Back to the list. Click a row to follow it."));
    $("fix-ask").onclick = askFix;
    $("fix-research").onclick = researchFix;
    $("web-use").onclick = () => (($("fix-intent").value = $("web-use").dataset.intent), $("fix-intent").focus());
    // Apply/Undo act on the fix that was on screen when clicked, even if Scan or Ask AI changes it meanwhile
    $("fix-apply").onclick = () => fix && circuit(applyFix)(fix, fix.changes, fix.sheet).catch(() => {});
    $("fix-undo").onclick = () => fix && circuit(undoFix)(fix).catch(() => {});
    $("fix-intent").onkeydown = (e) => e.key === "Enter" && e.ctrlKey && askFix();
    Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
      await ctx.sync();
      $("sheet-name").textContent = sheet.name;
    });
    checkHealth();
  });
}

async function checkHealth() {
  try {
    const r = await fetch(`${SERVER}/health`);
    if (!r.ok) throw new Error();
    aiAvailable = !!(await r.json()).ai_available;
    $("ai-toggle").disabled = $("run-triage").disabled = $("fix-ask").disabled = $("fix-research").disabled = !aiAvailable;
    monitor.ready(aiAvailable);
    serverUp(true);
  } catch {
    serverUp(false);
  }
}

async function post(path, body, seconds = 120) { // a stuck engine never freezes the circuit for good
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(seconds * 1000),
  }).catch((e) => {
    if (e.name === "TimeoutError") throw new Error(`The local engine took over ${seconds}s - try again.`);
    serverUp(false);
    throw new Error("Local engine not reachable.");
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw new Error("The engine is older than this panel - re-run install.bat to restart it.");
  if (!r.ok) throw new Error(j.error || "The local engine returned an error.");
  return j;
}

const getLimits = () =>
  new Promise((ok) => Office.context.document.settings.refreshAsync(() => ok(Office.context.document.settings.get(KEY) || null)));

function saveLimits(limits) {
  Office.context.document.settings.set(KEY, limits);
  Office.context.document.settings.saveAsync();
}

// A scan reads at most this many cells (~250k rows x 8 columns, about a minute): Excel refuses one read over 5M cells,
// and the engine's time and memory grow with it. Only the bottom is cut, so row numbers never shift.
const maxCells = () => globalThis.MAX_CELLS || 2e6;

async function readSheet(name) {
  return Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets;
    const sheet = (name ? ws.getItem(name) : ws.getActiveWorksheet()).load("name");
    const used = sheet.getUsedRange().load("rowIndex, columnIndex, rowCount, columnCount");
    await ctx.sync();
    const n = Math.min(used.rowCount, Math.floor(maxCells() / used.columnCount));
    const g = sheet.getRangeByIndexes(used.rowIndex, used.columnIndex, n, used.columnCount).load("values, formulas, numberFormat");
    await ctx.sync();
    const t = tableFromGrid(g.values, g.numberFormat, used.rowIndex, used.columnIndex, g.formulas);
    // cut = [last sheet row read, last sheet row with data]
    return t && { ...t, sheet: sheet.name, cut: n < used.rowCount && [used.rowIndex + n, used.rowIndex + used.rowCount] };
  });
}

// Pure: the honest line for a sheet too big to read at once
const cutNote = ([last, total]) =>
  `Too large to scan at once: checked down to row ${last.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}. Rows below ${last.toLocaleString("en-US")} were NOT checked.`;

// Pure: used-range values -> {columns, rows, startRow, startCol}, or null if there's no header + data row.
// Header = first row that is mostly filled, so title rows above it ("Cost Report - Period 9") are skipped.
function tableFromGrid(values, formats, rowIndex, colIndex, formulas) {
  const filled = (r) => r.filter((v) => v !== "" && v !== null).length;
  const widest = Math.max(0, ...values.slice(0, 20).map(filled));
  const h = values.findIndex((r, k) => k < 10 && filled(r) >= Math.max(Math.min(2, widest), 0.6 * widest));
  if (h < 0 || h + 1 >= values.length) return null; // need header + 1 row
  // Excel hands dates over as serial numbers; send real dates so the engine finds its time axis
  const isDate = formats ? formats[h + 1].map(isDateFormat) : [];
  const rows = values.slice(h + 1).map((r) => r.map((v, j) => (isDate[j] && typeof v === "number" ? excelDate(v) : v)));
  const calc = formulas && formulas.slice(h + 1); // each data row's formulas ("=B2-C2"), so a fix never types over one
  const columns = []; // name duplicate headers like the engine does ("Dept", "Dept.1", skipping taken names): limits and fixes are keyed by these
  values[h].forEach((c) => {
    let name = String(c);
    for (let k = 1; columns.includes(name); k++) name = `${c}.${k}`;
    columns.push(name);
  });
  return { columns, rows, startRow: rowIndex + h, startCol: colIndex, calc };
}

// Pure: number format shows a date? (ignore [colors/locales] and "quoted text", e.g. "[Red]0.00")
const isDateFormat = (f) => /[dy]/i.test(String(f).replace(/\[[^\]]*\]|"[^"]*"/g, ""));
// Pure: Excel serial day -> "yyyy-mm-dd" (25569 = 1970-01-01)
const excelDate = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);

const scanBody = (s, limits) => ({ columns: s.columns, rows: s.rows, limits, order_by: null });

// ---- L1 Scan: read the sheet, ask the engine. Then hand on to L2 Flag and L3 Highlight. ----

// Scan (or Save limits) pressed: the layers below stand down before anything is read
function resetDownstream() {
  clearTimeout(watchTimer); // a pending auto-rescan would just repeat this scan
  fix = null; // the open fix (and any AI answer still on its way) belongs to the old scan
}

async function runScan() {
  const btn = $("scan");
  btn.textContent = "Scanning…";
  try {
    const s = await readSheet();
    if (!s) {
      only("empty-state");
      $("empty-state").querySelector("p").textContent =
        "Not enough data - add a header row plus at least one data row, starting at A1.";
      return;
    }
    await scanAndRender(s, await getLimits());
  } catch (e) {
    // limits saved before they were checked: back to the editor with the engine's reason, not a dead end
    if (e.message.startsWith("Limits for")) return editSavedLimits().then(() => ($("limits-error").textContent = e.message));
    showError("Scan failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan Active Sheet";
  }
}

async function scanAndRender(s, limits) {
  const body = await post("/scan", scanBody(s, limits)); // L1
  if (!limits) return renderLimitsEditor(body.suggested_limits, s); // first scan: review limits first
  lastScan = s;
  lastRows = body.rows;
  triaged = {};
  undos = {};
  renderResults(body, s.startRow); // L2 Flag
  monitor.scanned(body.rows, s, "Scan"); // L6
  await applyHighlights(body.rows, s); // L3 Highlight
  await watchSelection(s.sheet); // L4 Suggest: clicks on the scanned sheet now open fixes
  // a scanned workbook reopens with this pane already open (Office autoopen; manifest TaskpaneId)
  Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true);
  Office.context.document.settings.saveAsync();
}

function showError(msg) {
  only("error-state");
  $("error-text").textContent = msg;
}

// ---- Route Monitor: rescan 1.5s after edits stop, feed new/resolved rows ----

async function onWatchToggle(on) {
  const status = $("watch-status");
  if (!on) {
    await stopWatching();
    status.textContent = "Not watching.";
  } else if (watch) {
    return; // already watching
  } else if (!(await getLimits())) {
    $("watch-toggle").checked = false;
    status.textContent = "Scan once first to set limits before watching.";
  } else {
    try {
      await Excel.run(async (ctx) => {
        const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
        const handle = sheet.onChanged.add(onSheetChanged);
        await ctx.sync();
        watch = { handle, sheet: sheet.name };
      });
      status.textContent = "Watching - rescans ~1.5s after you stop editing.";
    } catch (err) {
      $("watch-toggle").checked = false;
      status.textContent = "Could not start watching: " + err.message;
    }
  }
}

async function stopWatching() {
  clearTimeout(watchTimer);
  const w = watch;
  watch = null;
  await removeHandler(w && w.handle);
}

// an Office event handler must be removed in the context that added it
async function removeHandler(h) {
  if (!h) return;
  await Excel.run(h.context, async (ctx) => {
    h.remove();
    await ctx.sync();
  });
}

function onSheetChanged() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(circuit(rescan), 1500); // debounce: a paste = one scan, not one per cell
}

async function rescan() { // L1-L3 again on the WATCHED sheet (not whichever sheet is active), results go to the feed
  try {
    if (!watch) return; // switched off while this was queued
    const s = await readSheet(watch.sheet);
    const limits = await getLimits();
    if (!s || !limits) return;
    const body = await post("/scan", scanBody(s, limits)); // free + local; AI triage never auto-runs
    const diffs = diffFlaggedRows(lastRows, body.rows);
    lastScan = s; // L1 data and verdicts change together
    lastRows = body.rows;
    triaged = {}; // verdicts were for the old values
    renderResults(body, s.startRow, false); // L2: list refreshed in place - an open fix view stays open
    const news = diffs.filter((d) => d.kind === "new").length;
    monitor.scanned(body.rows, s, `Auto-rescan: ${news} new, ${diffs.length - news} resolved`); // L6
    await applyHighlights(body.rows, s); // L3
    renderWatchFeed(diffs, s.startRow);
  } catch (e) {
    console.error("watch rescan failed", e);
  }
}

// Pure: rows clean->flagged = "new", flagged->clean = "resolved". Diff by row position.
function diffFlaggedRows(prev, cur) {
  const out = [];
  cur.forEach((r, i) => {
    const was = prev && prev[i] && prev[i].severity;
    if (r.severity && !was) out.push({ rowIndex: i, kind: "new", severity: r.severity, reason: r.reason });
    else if (!r.severity && was) out.push({ rowIndex: i, kind: "resolved", severity: was, reason: "" });
  });
  return out;
}

function renderWatchFeed(diffs, startRow) {
  const feed = $("watch-feed");
  diffs.forEach((d) => {
    const isNew = d.kind === "new";
    feed.prepend(rowItem(startRow + d.rowIndex + 2, isNew && d.severity, d.reason, isNew ? " - newly flagged" : " - resolved"));
  });
  while (feed.children.length > CAP) feed.lastChild.remove();
}

function rowItem(sheetRow, severity, reason, note = "") {
  const li = document.createElement("li");
  li.className = severity ? `sev-${severity.toLowerCase()}` : "feed-resolved";
  li.innerHTML =
    `<div class="row-head"><span>Row ${sheetRow}${note}</span><span>${severity || ""}</span></div>` +
    (reason ? `<div class="reason">${esc(reason)}</div>` : "");
  return li;
}

// ---- Limits editor ----

// Pure: a saved limit as an input value - a number or nothing (a tampered workbook can't put markup in the page)
const asNumber = (v) => (v === null || v === "" || !Number.isFinite(Number(v)) ? "" : Number(v));

function renderLimitsEditor(limits, s) {
  editorSheet = s;
  $("limits-error").textContent = "";
  const box = $("limits-rows");
  box.innerHTML =
    '<div class="limits-row limits-head"><div>Column</div><div>Base lo</div><div>Base hi</div><div>Weird lo</div><div>Weird hi</div></div>';
  for (const [col, bounds] of Object.entries(limits)) {
    const row = document.createElement("div");
    row.className = "limits-row";
    row.dataset.column = col;
    row.innerHTML = `<div>${esc(col)}</div>` + bounds.map((v) => `<input type="number" value="${asNumber(v)}">`).join("");
    box.appendChild(row);
  }
  only("limits-editor");
}

async function saveLimitsAndRescan() {
  const limits = {};
  let bad = null; // [column, input]: low above high - the editor stays open and nothing is saved
  document.querySelectorAll("#limits-rows .limits-row[data-column]").forEach((row) => {
    const ins = [...row.querySelectorAll("input")];
    const b = (limits[row.dataset.column] = ins.map((i) => (i.value === "" ? null : parseFloat(i.value))));
    const k = [0, 2].find((k) => b[k] !== null && b[k + 1] !== null && b[k] > b[k + 1]);
    if (!bad && k !== undefined) bad = [row.dataset.column, ins[k]];
  });
  if (bad) {
    $("limits-error").textContent = `Limits for ${bad[0]}: the low value is above the high value.`;
    return bad[1].focus();
  }
  saveLimits(limits);
  try {
    await scanAndRender(editorSheet, limits);
  } catch (e) {
    showError("Scan failed: " + e.message);
  }
}

async function editSavedLimits() {
  try {
    const s = await readSheet();
    const saved = (await getLimits()) || {};
    const shown = {};
    s.columns.forEach((c, i) => {
      if (s.rows.some((r) => typeof r[i] === "number")) shown[c] = saved[c] || [null, null, null, null];
    });
    renderLimitsEditor(shown, s);
  } catch (e) {
    showError("Could not load limits: " + e.message);
  }
}

// ---- L3 Highlight: color flagged rows. Each painting first puts back the last one, so the colors it
// remembers are always the sheet's own - Clear highlights restores exactly what was there. ----

async function applyHighlights(rows, s) {
  await Excel.run(async (ctx) => {
    await unpaint(ctx);
    const sheet = ctx.workbook.worksheets.getItem(s.sheet);
    // only the rows we colour are touched: 100k rows with 15k flagged = 15k Excel objects, not 100k
    const flagged = rows.flatMap((r, i) => (COLOR[r.severity] ? [i] : []));
    const fills = flagged.map((i) => sheet.getRangeByIndexes(s.startRow + 1 + i, s.startCol, 1, s.columns.length).format.fill.load("color"));
    await ctx.sync();
    const colors = {}; // ponytail: one color per row; a row with mixed old fills restores only the first
    flagged.forEach((i, k) => {
      colors[i] = fills[k].color;
      fills[k].color = COLOR[rows[i].severity];
    });
    await ctx.sync();
    painted = { sheet: s.sheet, startRow: s.startRow, startCol: s.startCol, width: s.columns.length, colors };
  });
}

// Put back the remembered fills - only on rows still wearing one of OUR colors (rows inserted or deleted
// since, or recolored by the user, are left alone). The record is dropped only once that has worked.
async function unpaint(ctx) {
  const p = painted;
  if (!p) return;
  const sheet = ctx.workbook.worksheets.getItemOrNullObject(p.sheet).load("isNullObject");
  await ctx.sync();
  if (sheet.isNullObject) return void (painted = null); // that sheet was deleted: nothing left to restore
  const idx = Object.keys(p.colors).map(Number);
  const fills = idx.map((i) => sheet.getRangeByIndexes(p.startRow + 1 + i, p.startCol, 1, p.width).format.fill.load("color"));
  await ctx.sync();
  const ours = new Set(Object.values(COLOR));
  fills.forEach((fill, k) => {
    if (!ours.has(String(fill.color).toUpperCase())) return;
    if (p.colors[idx[k]]) fill.color = p.colors[idx[k]];
    else fill.clear();
  });
  await ctx.sync();
  painted = null;
}

async function clearHighlights() {
  await Excel.run(unpaint);
}

// ---- AI triage: explicit button only. Safe actions need a human click. ----

async function runTriage() {
  if (!aiAvailable || !$("ai-toggle").checked || !triageRows.length) return;
  const btn = $("run-triage");
  btn.disabled = true;
  btn.textContent = "Triaging…";
  try {
    const s = lastScan;
    const out = await post("/triage", { columns: s.columns, flagged: triageRows }, 300);
    if (s === lastScan) out.results.forEach(renderTriage); // a scan ran meanwhile: these verdicts are for old values
  } catch (e) {
    showError("AI triage failed: " + e.message);
  } finally {
    btn.disabled = !aiAvailable;
    btn.textContent = "Triage flagged rows";
  }
}

function renderTriage(t) {
  const li = document.querySelector(`#flagged-list li[data-row-index="${t.row_index}"]`);
  if (!li) return;
  triaged[t.row_index] = t;
  const safe = t.safe_action !== "none";
  const block = document.createElement("div");
  block.className = "ai-block";
  block.innerHTML =
    `<div class="verdict ${esc(t.verdict)}">${esc(t.verdict)}</div><div>${esc(t.reason)}</div>` +
    `<div class="action-detail">${esc(t.suggested_action_detail)}${safe ? "" : " (manual - not applied automatically)"}</div>`;
  if (safe) {
    const b = document.createElement("button");
    b.className = "approve-btn";
    b.textContent = t.safe_action === "add_note" ? "Approve: add note" : "Approve: copy to Anomalies sheet";
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      b.textContent = "Applying…";
      try {
        await circuit(approve)(t.row_index, t.safe_action, t.suggested_action_detail); // rejects if it failed
        b.textContent = "Applied";
      } catch {
        b.disabled = false; // the circuit already logged why
        b.textContent = "Failed - retry";
      }
    };
    block.appendChild(b);
  }
  li.appendChild(block);
}

// Pure: Text format for cells that would otherwise run as a formula ("=WEBSERVICE(...)" copied from the sheet or the AI)
const textFormats = (vals) => vals.map((v) => (typeof v === "string" && /^\s*[=+\-@]/.test(v) ? "@" : "General"));
const writeAsIs = (range, vals) => ((range.numberFormat = [textFormats(vals)]), (range.values = [vals]));

async function approve(i, action, detail) {
  const { columns, rows, startRow, startCol } = lastScan;
  await Excel.run(async (ctx) => {
    const wb = ctx.workbook;
    if (action === "add_note") {
      // note goes in the column right of the data, never over a value
      wb.worksheets.getItem(lastScan.sheet).getRangeByIndexes(startRow + 1 + i, startCol + columns.length, 1, 1).values = [[`AI note: ${detail}`]];
      return ctx.sync();
    }
    let sheet = wb.worksheets.getItemOrNullObject("Anomalies").load("isNullObject");
    await ctx.sync();
    if (sheet.isNullObject) {
      sheet = wb.worksheets.add("Anomalies");
      writeAsIs(sheet.getRangeByIndexes(0, 0, 1, columns.length + 1), [...columns, "Reason"]);
    }
    const used = sheet.getUsedRangeOrNullObject().load("rowCount");
    await ctx.sync();
    writeAsIs(sheet.getRangeByIndexes(used.isNullObject ? 0 : used.rowCount, 0, 1, rows[i].length + 1), [...rows[i], detail]);
    await ctx.sync();
  });
}

// ---- L4 Suggest: click a flagged row (pane list or the sheet) -> instant recommended fix, previewed
// old -> new; Apply writes it, Undo puts it back. L5 Ask AI: describe a different fix in plain English. ----

async function watchSelection(sheetName) {
  if (picker && picker.sheet === sheetName) return;
  const old = picker;
  picker = null;
  await removeHandler(old && old.handle).catch(() => {}); // old sheet deleted: nothing to remove
  try {
    await Excel.run(async (ctx) => {
      const handle = ctx.workbook.worksheets.getItem(sheetName).onSelectionChanged.add(onSelect);
      await ctx.sync();
      picker = { sheet: sheetName, handle };
    });
  } catch (e) {
    console.error("could not watch selection", e); // list clicks still work
  }
}

async function onSelect(e) {
  if (!lastScan || (view !== "results" && view !== "fix-view")) return; // never yank the user out of the limits editor
  const i = rowFromAddress(e.address, lastScan.startRow);
  if (i !== null && !(view === "fix-view" && fix && fix.i === i)) circuit(openFix)(i, false); // openFix ignores clean rows
}

// Pure: "C7", "B7:D7", "Sheet1!C7", "7:7" -> 0-based data row index (header at startRow), or null.
// A selection spanning several rows (dragging down a column) is not a click on a row -> null.
function rowFromAddress(address, startRow) {
  const m = /^(?:.*!)?\$?[A-Z]*\$?(\d+)(?::\$?[A-Z]*\$?(\d+))?$/i.exec(String(address));
  if (!m || (m[2] && m[2] !== m[1])) return null;
  const i = Number(m[1]) - startRow - 2;
  return i >= 0 ? i : null;
}

async function openFix(i, selectInSheet) {
  if (!lastScan) return;
  const { columns, rows, startRow, startCol, sheet } = lastScan;
  const r = lastRows[i];
  if (!r || !r.severity) return; // list item left over from before a Route Monitor rescan
  const f = (fix = { i, changes: [], sheet }); // the fix remembers its sheet: Apply/Undo write there, whatever happens later
  monitor.investigate(i); // L6
  $("fix-title").textContent = `Fix row ${startRow + i + 2} - ${r.severity}`;
  $("fix-values").textContent = columns.map((c, j) => `${c}: ${rows[i][j]}`).join(" · ");
  const t = triaged[i];
  $("fix-reason").textContent = (r.reason || "Flagged by the engine.") + (t ? ` AI: ${t.verdict} - ${t.reason}` : "");
  $("fix-intent").value = "";
  $("fix-status").textContent = "";
  show("fix-nokey", !aiAvailable);
  show("fix-result", false);
  show("fix-web", false);
  only("fix-view");
  if (selectInSheet)
    await Excel.run(async (ctx) => {
      ctx.workbook.worksheets.getItem(sheet).activate();
      ctx.workbook.worksheets.getItem(sheet).getRangeByIndexes(startRow + 1 + i, startCol, 1, columns.length).select();
      await ctx.sync();
    }).catch((e) => console.error("select row failed", e));
  // instant, local recommendation - no AI, no key needed
  // totals rows don't count toward the median or the "naturally wide" test
  const data = rows.map((row, k) => (/^Totals\/summary row/.test(lastRows[k].reason) ? row.map(() => "") : row));
  const rec = recommendFix(columns, data, i, await getLimits(), r.reason, startRow, startCol, r.likely, lastScan.calc?.[i]);
  if (fix === f) await showFix(f, "Recommended fix", rec);
}

async function askFix() { // L5: engine + Claude only; the sheet is touched later, by Apply (through the circuit)
  if (!fix || $("fix-ask").disabled) return; // disabled while busy or without an API key
  const f = fix;
  const btn = $("fix-ask");
  btn.disabled = true;
  btn.textContent = "Thinking… (up to a minute)";
  $("fix-status").textContent = "";
  monitor.source(f.i, "ai", "pending", "thinking…");
  try {
    const { columns, rows, startRow, startCol } = lastScan;
    const out = await post("/fix", { // outside the circuit, so it may take its time
      columns, rows, row_index: f.i, start_row: startRow, start_col: startCol,
      reason: lastRows[f.i].reason, intent: $("fix-intent").value, formulas: lastScan.calc?.[f.i],
    }, 300);
    if (fix === f) await showFix(f, "AI suggestion", out); // else: user moved to another row meanwhile
    const said = out.changes.slice(0, 2).map((c) => `${c.cell} → ${c.new}`).join(", ") || short(out.explanation);
    if (fix === f) monitor.source(f.i, "ai", "on", "answered", `Claude: ${said}`);
  } catch (e) {
    if (fix === f) $("fix-status").textContent = "Could not get a fix: " + e.message;
    if (fix === f) monitor.source(f.i, "ai", "failed", "failed");
  } finally {
    btn.disabled = !aiAvailable;
    btn.textContent = "Ask AI";
  }
}

// Web research: how Excel pros fix this kind of issue. Sends the issue, not the sheet; shows a reference, writes nothing.
async function researchFix() {
  if (!fix || $("fix-research").disabled) return; // disabled while busy or without an API key
  if (!lastRows[fix.i]?.severity) return void ($("fix-status").textContent = "This row is no longer flagged - nothing to research.");
  const f = fix, btn = $("fix-research");
  const dept = issuesOf(lastRows[f.i].reason, lastScan.columns, lastScan.calc?.[f.i])[0]?.dept || "Anomalies";
  btn.disabled = true;
  btn.textContent = "Searching… (up to a minute)";
  $("fix-status").textContent = "";
  monitor.source(f.i, "web", "pending", "searching…");
  try {
    const formula = dept === "Formulas" ? (lastScan.calc?.[f.i] || []).find((v) => String(v).startsWith("=")) || "" : "";
    const out = await post("/research", { // trimmed to what the engine accepts
      department: DEPTS[dept], reason: lastRows[f.i].reason.slice(0, 2000), columns: lastScan.columns.slice(0, 200), formula: String(formula).slice(0, 1000) }, 300);
    if (fix !== f) return; // user moved on meanwhile
    $("web-technique").textContent = out.technique + (out.partial ? " (The search ran long - this answer may be incomplete.)" : "");
    $("web-formula").textContent = out.formula;
    show("web-formula", !!out.formula);
    $("web-steps").replaceChildren(...out.steps.map((t) => Object.assign(document.createElement("li"), { textContent: t })));
    $("web-sources").replaceChildren(...(out.sources.length ? out.sources.flatMap((l, k) => (k ? [" · ", link(l)] : [link(l)])) : ["none came back"]));
    $("web-use").dataset.intent = `Use this approach from Excel pros: ${out.technique}` + (out.formula ? ` Formula: ${out.formula}` : "");
    show("fix-web");
    const n = out.sources.length;
    monitor.source(f.i, "web", "on", `${n} source${n === 1 ? "" : "s"}`, `Excel pros (${n}): ${short(out.technique)}`, out.sources);
  } catch (e) {
    if (fix === f) $("fix-status").textContent = "Could not research: " + e.message;
    if (fix === f) monitor.source(f.i, "web", "failed", "failed");
  } finally {
    btn.disabled = !aiAvailable;
    btn.textContent = "Research on the web";
  }
}

// Preview a fix as cell: old -> new. Nothing is written until Apply.
async function showFix(f, label, out) {
  const olds = await readCells(f.sheet, out.changes.map((c) => c.cell));
  if (fix !== f) return;
  f.changes = out.changes;
  $("fix-label").textContent = label;
  $("fix-explanation").textContent = out.explanation;
  $("fix-changes").innerHTML = out.changes
    .map((c, k) => `<li><b>${esc(c.cell)}</b>: <span class="old">${esc(olds[k])}</span> &rarr; <span class="new">${esc(c.new)}</span></li>`)
    .join("");
  show("fix-apply", out.changes.length > 0);
  setApplied(!!undos[f.i]);
  show("fix-result");
}

// An applied fix must be undone before another one is applied, so Undo always gets back to the original.
function setApplied(applied) {
  $("fix-apply").disabled = applied;
  $("fix-apply").textContent = applied ? "Applied - Undo first to apply another" : "Apply to sheet";
  show("fix-undo", applied);
}

// Pure: 0-based column index -> Excel letters (0 -> A, 26 -> AA)
function colLetter(n) {
  let s = "";
  for (n += 1; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Pure: how a typo turned `fix` into `v`, in words: "extra zeros", "missing zeros", "sign flipped"
function typoKind(v, fix) {
  if (v === -fix) return "sign flipped";
  const k = Math.round(Math.log10(Math.abs(v / fix)));
  return `${k > 0 ? "extra" : "missing"} zeros - ${k > 0 ? "x" : "÷"}${10 ** Math.abs(k)}`;
}

// Pure: do the positive numbers span more than 10x between their 5th and 95th percentile? (claims, deal sizes)
function spansDecade(xs) {
  const v = xs.filter((x) => typeof x === "number" && x > 0).sort((a, b) => a - b);
  return v.length >= 10 && v[Math.floor(0.95 * (v.length - 1))] > 10 * v[Math.floor(0.05 * (v.length - 1))];
}

// What Excel's own error codes mean, in plain words
const EXCEL_ERRORS = {
  "#N/A": "a lookup (VLOOKUP/XLOOKUP/MATCH) found no match", "#DIV/0!": "it divides by zero or by a blank cell",
  "#REF!": "it points at a cell or sheet that was deleted", "#VALUE!": "one of its inputs is the wrong type (text where a number belongs)",
  "#NAME?": "a function or name in it is misspelled", "#NUM!": "the math is impossible (e.g. square root of a negative)",
  "#NULL!": "two ranges in it don't overlap", "#SPILL!": "its results are blocked by cells in the way", "#CALC!": "the calculation failed",
};

// Pure: median of the numbers in a list (null if none)
function median(xs) {
  const v = xs.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Pure: instant fix for a flagged row, no AI. A number past its weird limits, or a blank in a mostly-filled
// number column -> the median of the OTHER rows' values in that column, written as a plain number (a formula
// over the column could loop back through a totals row = circular reference). Anything else -> advice only.
// limits = {col: [baseLo, baseHi, weirdLo, weirdHi]}.
// calc = this row's formulas: a cell holding a formula is never overwritten - its inputs are what's wrong.
function recommendFix(columns, rows, i, limits, reason, startRow, startCol, likely, calc) {
  const row = startRow + 2 + i;
  const changes = [], why = [], typos = [], real = [], calcCells = [], seen = new Set(); // seen: columns already explained
  reason = reason || "";
  columns.forEach((c, j) => {
    const v = rows[i][j], cell = `${colLetter(startCol + j)}${row}`;
    const lim = limits && limits[c], lo = lim && lim[2], hi = lim && lim[3];
    const variant = likely && typeof likely[c] === "string" && typeof v === "string"; // "sales" where the column says "Sales"
    const blank = !!lim && (v === "" || v === null) && reason.includes(`Blank cell in column ${c},`);
    const outside = !!lim && typeof v === "number" && ((lo != null && v < lo) || (hi != null && v > hi));
    if (!(variant || blank || outside)) return;
    seen.add(c);
    if (calc && String(calc[j]).startsWith("=")) return void calcCells.push(cell); // never type over a formula
    if (variant) {
      changes.push({ cell, new: likely[c] });
      return void typos.push(`${c} says "${v}" where the rest of the column says "${likely[c]}" - same word, different capitals/spaces`);
    }
    const typo = likely && likely[c];
    if (typo != null && outside) { // engine spotted an obvious typo: extra/missing zeros or a flipped sign
      changes.push({ cell, new: String(typo) });
      return void typos.push(`${c} is ${v} - looks like a typo for ${typo} (${typoKind(v, typo)})`);
    }
    const others = rows.filter((_, k) => k !== i).map((r) => r[j]);
    if (outside && spansDecade(others)) // wide column (claims, deal sizes): a huge value can be real - don't overwrite it
      return void real.push(`${c} is ${v}, far outside its usual range - but ${c} naturally varies more than 10x, so this may be real`);
    const med = median(others);
    if (med === null) return void seen.delete(c);
    changes.push({ cell, new: String(+med.toPrecision(10)) });
    why.push(blank ? `${c} is blank` : `${c} is ${v}, outside its limits (${lo ?? "no low"} to ${hi ?? "no high"})`);
  });
  const notes = [];
  if (calcCells.length) notes.push(`${calcCells.join(", ")} ${calcCells.length > 1 ? "are" : "is"} calculated by a formula - ` +
    "fix the cells it uses rather than typing over it.");
  if (typos.length) notes.push(`${typos.join("; ")}. Check it against the source before applying.`);
  if (real.length) notes.push(`${real.join("; ")}. Check it against the source; if it's right, leave it.`);
  if (why.length) {
    const how = why.length > 1 ? "them each with the median of the rest of its column" : "it with the median of the rest of the column";
    notes.push(`${why.join("; ")}. Replace ${how} - a typical value that ignores outliers.`);
  }
  const dup = /Duplicate of row (\d+)/.exec(reason); // engine counts from a header in row 1
  if (dup) notes.push(`This row repeats row ${+dup[1] + startRow}. If it's a double entry, delete it: right-click the row number > Delete.`);
  for (const [, raw, kind, col] of reason.matchAll(/Text "([^"]*)" in (number|date) column ([^;]+)/g))
    notes.push(`${col} holds the text "${raw}" where a ${kind} belongs - retype it as a ${kind}.`);
  for (const [, raw, col] of reason.matchAll(/Placeholder "([^"]*)" in column ([^;]+)/g))
    notes.push(`${col} says "${raw}" - a stand-in for a missing value. Fill in the real value, or leave the cell empty.`);
  // a limit crossed in a cell typed as text ("$1,000,000.00"): explained, never overwritten
  for (const { text } of issuesOf(reason, columns)) { // anything the loop above didn't explain (text cells, no limits)
    const m = /^(.+?) weird limit is (\S+); this is (\S+)/.exec(text), b = /^Blank cell in column (.+?), which/.exec(text);
    if (m && !seen.has(m[1])) notes.push(`${m[1]} is ${m[3]}, past its limit of ${m[2]}. Check it against the source; if it's right, leave it.`);
    if (b && !seen.has(b[1])) notes.push(`${b[1]} is blank where the rest of the column is filled - fill it in from the source.`);
  }
  for (const [, err, col] of reason.matchAll(/Excel error (#\S+) in ([^;]+)/g))
    notes.push(`${col} shows ${err}: ${EXCEL_ERRORS[err] || "its formula failed"}. Fix the formula or its inputs ` +
      `(or wrap it in IFERROR(...)) rather than typing a number over it.`);
  if (!notes.length)
    notes.push("Nothing here is clearly broken - the values are just unusual together. Check them against the source; if they're right, leave them.");
  return { explanation: notes.join(" "), changes };
}

async function readCells(sheetName, cells) {
  return Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(sheetName);
    const ranges = cells.map((c) => sheet.getRange(c).load("formulas"));
    await ctx.sync();
    return ranges.map((r) => r.formulas[0][0]);
  });
}

// Writes as if typed: "=..." becomes a formula, "42" a number. Old contents kept for Undo.
async function writeCells(sheetName, writes) {
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(sheetName);
    writes.forEach((w) => (sheet.getRange(w.cell).formulas = [[w.value]]));
    await ctx.sync();
  });
}

async function applyFix(f, changes, sheet) { // the fix, its changes and sheet as they were when Apply was clicked
  if (undos[f.i]) return;
  $("fix-apply").disabled = true;
  try {
    const cells = changes.map((c) => c.cell);
    const olds = await readCells(sheet, cells);
    await writeCells(sheet, changes.map((c) => ({ cell: c.cell, value: c.new })));
    undos[f.i] = { sheet, writes: cells.map((cell, k) => ({ cell, value: olds[k] })) }; // all read before any write
    if (fix === f) {
      setApplied(true);
      $("fix-status").textContent = "Applied. Scan again to refresh the highlights.";
    }
  } catch (e) {
    if (fix === f) {
      $("fix-apply").disabled = false;
      $("fix-status").textContent = "Apply failed: " + e.message;
    }
    throw e;
  }
}

async function undoFix(f) {
  const u = undos[f.i];
  if (!u) return;
  try {
    await writeCells(u.sheet, u.writes); // back on the sheet it was applied to
    delete undos[f.i];
    if (fix === f) {
      setApplied(false);
      $("fix-status").textContent = "Undone - the cells are back to what they were.";
    }
  } catch (e) {
    if (fix === f) $("fix-status").textContent = "Undo failed: " + e.message;
    throw e;
  }
}

// ---- L6 Route Monitor: a district of four departments and a library of sources. Draws only - never
// touches the sheet, never calls the engine. Nothing moves unless a layer reported something real. ----

const DEPTS = { Formulas: "Formula bugs", Duplicates: "Duplicates", Irregularities: "Irregularities", Anomalies: "Anomalies" }; // fix order
// geometry of the drawing in taskpane.html (viewBox 300x202): card corners, where a case stops, shelf centers
const CARD = { Duplicates: [8, 8], Irregularities: [158, 8], Anomalies: [8, 80], Formulas: [158, 80] };
const CORNER = { Duplicates: [142, 64], Irregularities: [158, 64], Anomalies: [142, 80], Formulas: [158, 80] };
const SHELF_X = { engine: 54, ai: 150, web: 246 };
// Pure: one line from the case (at its department's corner) down the middle street to a source shelf
const routePath = (dept, src) => `M${CORNER[dept].join(" ")}H150V152H${SHELF_X[src]}V161`;

// Pure: a row's engine reason -> its issues, each sent to one department, worst-to-fix first
// (a broken formula or a double entry explains what follows it). calc = the row's formulas.
function issuesOf(reason, columns, calc) {
  const order = Object.keys(DEPTS);
  const parts = String(reason || "").replace(/^Flagged by \d+ of \d+: /, "").split("; ").filter(Boolean);
  // "Units weird limit is 0; this is -5" is ONE issue: glue "this is ..." back onto the clause before it
  const clauses = parts.reduce((a, p) => (/^this is /.test(p) && a.length ? (a[a.length - 1] += "; " + p) : a.push(p), a), []);
  return clauses.map((text) => {
    const j = columns.indexOf((/^(.+?) weird limit/.exec(text) || [])[1]);
    const dept = /^Excel error #/.test(text) || (j >= 0 && String(calc?.[j]).startsWith("=")) ? "Formulas"
      : /^Duplicate of row/.test(text) ? "Duplicates"
      : /weird limit|^Blank cell|looks like "|^Text ".*" in (number|date) column|^Placeholder "/.test(text) ? "Irregularities" : "Anomalies";
    return { dept, text };
  }).sort((a, b) => order.indexOf(a.dept) - order.indexOf(b.dept));
}

const short = (t) => (t.length > 90 ? t.slice(0, 89) + "…" : t);

// Pure: an issue in plain words with its cell - "C11 Units = -5 · limit 0" - repeats collapsed, at most 3 lines
function plainOf(issues, columns, startCol, row) {
  const byLength = columns.map(String).map((c, j) => [c, j]).sort((x, y) => y[0].length - x[0].length);
  const texts = [...new Set(issues.map((x) => x.text.replace(/ 00:00:00/g, "").replace(/ \(\d-order change\)/, "")))];
  const lines = texts.map((t) => {
    const hit = byLength.find(([c]) => ` ${t.replace(/[,;]/g, " ")} `.includes(` ${c} `));
    const words = t.replace(/^(.+?) weird limit is (\S+); this is (.+)$/, "$1 = $3 · limit $2");
    return short((hit ? `${colLetter(startCol + hit[1])}${row} ` : "") + words);
  });
  return lines.length > 3 ? [...lines.slice(0, 2), `${lines[2]} (+${lines.length - 3} more)`] : lines;
}

// Pure: issues per department over the flagged rows (Noted rows aren't flagged)
function districtCounts(rows, columns, calc) {
  const counts = { Formulas: 0, Duplicates: 0, Irregularities: 0, Anomalies: 0 };
  let flagged = 0;
  rows.forEach((r, i) => {
    if (!r.severity || r.severity === "Noted") return;
    flagged++;
    issuesOf(r.reason, columns, calc?.[i]).forEach((x) => counts[x.dept]++);
  });
  return { counts, flagged };
}

// an https link that opens outside the pane; its text is the site's name
function link(l) {
  const a = document.createElement("a");
  a.href = /^https:\/\//.test(l.url) ? l.url : "#";
  a.target = "_blank";
  a.rel = "noopener";
  a.title = l.title || "";
  a.textContent = new URL(a.href, "https://x/").hostname.replace(/^www\./, "");
  return a;
}

const monitor = {
  row: null, // the row whose case is out; answers for any other row aren't drawn
  scanned(rows, s, how) { // L1-L3 finished: counts per department
    const { counts, flagged } = districtCounts(rows, s.columns, s.calc);
    const total = Object.values(counts).reduce((a, b) => a + b, 0), most = Math.max(1, ...Object.values(counts));
    for (const d in DEPTS) {
      const g = $(`rm-${d}`);
      g.classList.toggle("has-issues", counts[d] > 0);
      g.querySelector(".rm-count").textContent = counts[d];
      g.querySelector(".rm-bar").setAttribute("width", (118 * counts[d]) / most);
    }
    if (s.cut) {
      this.log(cutNote(s.cut));
      $("health-detail").textContent += " " + cutNote(s.cut);
    }
    this.log(`${how}: ` + (total ? Object.keys(DEPTS).filter((d) => counts[d]).map((d) => `${DEPTS[d]} ${counts[d]}`).join(", ") : "nothing flagged"));
    const open = view === "fix-view" && fix && rows[fix.i]?.severity;
    if (open) return this.investigate(fix.i, false); // a rescan under an open row: its case stays out, on fresh counts
    this.home();
    this.caption(`${total} issue${total === 1 ? "" : "s"} in ${flagged} flagged row${flagged === 1 ? "" : "s"}. Click one to follow it.`);
  },
  investigate(i, say = true) { // L4 opened a row: its case travels to the department that should fix it first
    const r = lastRows[i], row = lastScan.startRow + i + 2;
    const issues = issuesOf(r.reason, lastScan.columns, lastScan.calc?.[i]);
    this.home();
    if (r.severity === "Noted") { // below every alarm: shown for context, not sent anywhere
      this.caption(`Row ${row} is only noted - not sent to a department.`);
      return say && this.log(`Row ${row} noted: ${short(r.reason)}`);
    }
    const dept = issues[0]?.dept || "Anomalies", [x, y] = CORNER[dept], [cx, cy] = CARD[dept];
    this.row = i;
    $(`rm-${dept}`).classList.add("is-target");
    issues.forEach((t) => t.dept !== dept && $(`rm-${t.dept}`).classList.add("is-also"));
    Object.assign($("rm-row"), { textContent: `Row ${row}` }).setAttribute("x", cx + 126);
    $("rm-row").setAttribute("y", cy + 42);
    $("rm-case").classList.add("is-active");
    $("rm-case").style.transform = `translate(${x - 150}px, ${y - 72}px)`;
    for (const src in SHELF_X) $(`rm-route-${src}`).setAttribute("d", routePath(dept, src));
    const checks = /^Flagged by (\d+) of (\d+)/.exec(r.reason), engine = checks ? `${checks[1]} of ${checks[2]} checks` : "hygiene check";
    this.source(i, "engine", "on", engine);
    const also = [...new Set(issues.map((t) => DEPTS[t.dept]))].filter((d) => d !== DEPTS[dept]);
    this.caption(`Row ${row} → ${DEPTS[dept]} → Engine checks (${engine})${also.length ? `. Also: ${also.join(", ")}` : ""}`);
    if (say) plainOf(issues, lastScan.columns, lastScan.startCol, row).forEach((t, k) => this.log((k ? "" : `Row ${row}: `) + t));
  },
  source(i, src, state, note, line, links) { // a source was asked (pending), answered (on) or failed - routes only for real answers
    if (i !== this.row) return;
    const route = $(`rm-route-${src}`), shelf = $(`rm-src-${src}`);
    route.classList.toggle("is-on", state === "on" || state === "pending");
    route.classList.toggle("is-pending", state === "pending");
    shelf.classList.toggle("is-on", state === "on");
    $("rm-case").classList.toggle("is-busy", state === "pending");
    shelf.querySelector(".rm-note").textContent = note;
    if (line) this.log(line, links);
  },
  ready(ai) { // which shelves can answer at all
    for (const src of ["ai", "web"]) {
      $(`rm-src-${src}`).classList.toggle("is-off", !ai);
      $(`rm-src-${src}`).querySelector(".rm-note").textContent = ai ? "on request" : "needs API key";
    }
    $("rm-src-engine").querySelector(".rm-note").textContent = "always on";
  },
  home() { // case back on the plaza, nothing targeted, no routes, shelves back to idle
    this.row = null;
    this.ready(aiAvailable);
    $("rm-case").style.transform = "";
    $("rm-case").classList.remove("is-busy", "is-active");
    $("rm-row").textContent = "";
    document.querySelectorAll(".rm-bldg, .rm-shelf").forEach((g) => g.classList.remove("is-target", "is-also", "is-on"));
    document.querySelectorAll(".rm-route").forEach((p) => (p.classList.remove("is-on", "is-pending"), p.setAttribute("d", "")));
  },
  caption(text) {
    $("rm-caption").textContent = text;
    $("rm-desc").textContent = text; // the picture's accessible description says the same
  },
  log(text, links = []) { // newest last, six lines kept
    const li = document.createElement("li"), t = document.createElement("time"), body = document.createElement("span");
    t.textContent = new Date().toTimeString().slice(0, 8);
    body.append(text);
    links.forEach((l, k) => body.append(k ? " · " : " ", link(l)));
    li.append(t, body);
    $("rm-trace").append(li);
    while ($("rm-trace").children.length > 6) $("rm-trace").firstChild.remove();
  },
};

// ---- L2 Flag: the dashboard and the list of flagged rows ----

function renderResults(body, startRow, switchTo = true) {
  if (switchTo) only("results");
  const h = computeHealthSummary(body);
  $("stat-rows").textContent = h.totalRows;
  $("stat-anomalies").textContent = h.flaggedCount;
  $("stat-high").textContent = h.severityCounts.High || 0;
  $("health-ring").style.setProperty("--pct", h.healthPct);
  $("health-ring").style.setProperty("--ring-color", h.healthColor);
  $("health-pct").textContent = `${h.healthPct}%`;
  $("health-label").textContent = h.healthLabel;
  $("health-detail").textContent = h.healthDetail;
  // the engine's "Behavioral" bucket is the Route Monitor's "Anomalies" department: one name on screen
  $("bucket-row").innerHTML = [["Duplicates", "Duplicates"], ["Irregularities", "Irregularities"], ["Behavioral", "Anomalies"]]
    .map(([b, name]) => `<span class="bucket-chip">${name}: ${h.bucketCounts[b] || 0}</span>`).join("");

  const flagged = flaggedRows(body.rows);
  const shown = flagged.slice(0, CAP);
  const list = $("flagged-list");
  list.replaceChildren(...shown.map((r) => {
    const li = rowItem(startRow + r.i + 2, r.severity, r.reason);
    li.dataset.rowIndex = r.i;
    li.onclick = () => circuit(openFix)(r.i, true);
    return li;
  }));
  if (flagged.length > CAP) {
    const more = document.createElement("li");
    more.className = "more";
    more.textContent = `+ ${flagged.length - CAP} more`;
    list.appendChild(more);
  }
  // triage only what's shown = what the analyst can act on
  triageRows = shown.map((r) => ({ row_index: r.i, values: lastScan.rows[r.i], severity: r.severity, bucket: r.bucket, reason: r.reason }));
}

// Pure, L2: the flagged rows, worst first, each with its data-row index
const flaggedRows = (rows) => rows.map((r, i) => ({ ...r, i })).filter((r) => r.severity).sort((a, b) => b.magnitude - a.magnitude);

// Pure: health % = rows not flagged (Noted doesn't count as flagged).
function computeHealthSummary(body) {
  const total = body.rows.length;
  const flagged = body.rows.filter((r) => r.severity && r.severity !== "Noted").length;
  const pct = total ? Math.round(((total - flagged) / total) * 100) : 100;
  return {
    totalRows: total,
    flaggedCount: flagged,
    severityCounts: body.summary.severity_counts || {},
    bucketCounts: body.summary.bucket_counts || {},
    healthPct: pct,
    healthColor: pct >= 95 ? "#107c10" : pct >= 80 ? "#d29200" : "#d13438",
    healthLabel: !flagged ? "Clean" : pct >= 80 ? "Mostly clean" : "Needs review",
    healthDetail: flagged ? `${flagged} of ${total} rows flagged.` : "No anomalies found.",
  };
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

if (typeof module !== "undefined") module.exports = { textFormats, cutNote, asNumber, plainOf, routePath, issuesOf, districtCounts, flaggedRows, computeHealthSummary, diffFlaggedRows, isDateFormat, excelDate, rowFromAddress, colLetter, median, recommendFix, tableFromGrid, typoKind, spansDecade };
