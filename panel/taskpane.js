// Anomaly Hunter task pane. Talks to local engine at same origin. Plain JS, no build.
const SERVER = "https://127.0.0.1:5055";
const KEY = "anomalyHunterLimits"; // limits saved inside the workbook
const COLOR = { High: "#FFC7CE", Medium: "#FFEB9C", Low: "#FFFFCC", Noted: "#FFF8DC" };
const CAP = 25; // ponytail: list cap so big sheets don't flood the pane
const PANELS = ["empty-state", "limits-editor", "results", "fix-view", "error-state"];

let lastScan = null; // {columns, rows, startRow, startCol, sheet} the scan ran on
let lastRows = null; // last scan result rows, for Route Monitor diff
let lastHighlight = null; // what Clear highlights restores
let editorSheet = null; // sheet data the limits editor rescans
let triageRows = [];
let aiAvailable = false;
let watch = null; // sheet.onChanged handle
let watchTimer = null;
let picker = null; // onSelectionChanged handle: clicking a highlighted row opens its fix
let triaged = {}; // row_index -> AI triage verdict, shown in the fix view
let fix = null; // {i, changes} for the row open in the fix view
let undos = {}; // row index -> cells to restore, while an applied fix hasn't been undone

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
    $("scan").onclick = runScan;
    $("retry-health").onclick = checkHealth;
    $("save-limits").onclick = saveLimitsAndRescan;
    $("edit-limits").onclick = editSavedLimits;
    $("clear-highlights").onclick = clearHighlights;
    $("run-triage").onclick = runTriage;
    $("watch-toggle").onchange = onWatchToggle;
    $("fix-back").onclick = () => only("results");
    $("fix-ask").onclick = askFix;
    $("fix-apply").onclick = applyFix;
    $("fix-undo").onclick = undoFix;
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
    $("ai-toggle").disabled = $("run-triage").disabled = $("fix-ask").disabled = !aiAvailable;
    serverUp(true);
  } catch {
    serverUp(false);
  }
}

async function post(path, body) {
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
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

async function readSheet() {
  return Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
    const used = sheet.getUsedRange().load("values, numberFormat, rowIndex, columnIndex");
    await ctx.sync();
    const d = used.values;
    if (!d || d.length < 2) return null; // need header + 1 row
    // Excel hands dates over as serial numbers; send real dates so the engine finds its time axis
    const isDate = d[1].map((_, j) => isDateFormat(used.numberFormat[1][j]));
    const rows = d.slice(1).map((r) => r.map((v, j) => (isDate[j] && typeof v === "number" ? excelDate(v) : v)));
    return { columns: d[0], rows, startRow: used.rowIndex, startCol: used.columnIndex, sheet: sheet.name };
  });
}

// Pure: number format shows a date? (ignore [colors/locales] and "quoted text", e.g. "[Red]0.00")
const isDateFormat = (f) => /[dy]/i.test(String(f).replace(/\[[^\]]*\]|"[^"]*"/g, ""));
// Pure: Excel serial day -> "yyyy-mm-dd" (25569 = 1970-01-01)
const excelDate = (n) => new Date(Math.round((n - 25569) * 864e5)).toISOString().slice(0, 10);

const scanBody = (s, limits) => ({ columns: s.columns, rows: s.rows, limits, order_by: null });

async function runScan() {
  const btn = $("scan");
  btn.disabled = true;
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
    showError("Scan failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan Active Sheet";
  }
}

async function scanAndRender(s, limits) {
  const body = await post("/scan", scanBody(s, limits));
  if (!limits) return renderLimitsEditor(body.suggested_limits, s); // first scan: review limits first
  lastScan = s;
  lastRows = body.rows;
  triaged = {};
  undos = {};
  await applyHighlights(body.rows, s);
  renderResults(body, s.startRow);
  await watchSelection(s.sheet);
  // a scanned workbook reopens with this pane already open (Office autoopen; manifest TaskpaneId)
  Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true);
  Office.context.document.settings.saveAsync();
}

function showError(msg) {
  only("error-state");
  $("error-text").textContent = msg;
}

// ---- Route Monitor: rescan 1.5s after edits stop, feed new/resolved rows ----

async function onWatchToggle(e) {
  const status = $("watch-status");
  if (!e.target.checked) {
    await stopWatching();
    status.textContent = "Not watching.";
  } else if (!(await getLimits())) {
    e.target.checked = false;
    status.textContent = "Scan once first to set limits before watching.";
  } else {
    try {
      await Excel.run(async (ctx) => {
        watch = ctx.workbook.worksheets.getActiveWorksheet().onChanged.add(onSheetChanged);
        await ctx.sync();
      });
      status.textContent = "Watching - rescans ~1.5s after you stop editing.";
    } catch (err) {
      e.target.checked = false;
      status.textContent = "Could not start watching: " + err.message;
    }
  }
}

async function stopWatching() {
  clearTimeout(watchTimer);
  const w = watch;
  watch = null;
  await removeHandler(w);
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
  watchTimer = setTimeout(rescan, 1500); // debounce: a paste = one scan, not one per cell
}

async function rescan() {
  try {
    const s = await readSheet();
    const limits = await getLimits();
    if (!s || !limits) return;
    const body = await post("/scan", scanBody(s, limits)); // free + local; AI triage never auto-runs
    lastScan = s;
    triaged = {}; // verdicts were for the old values
    await applyHighlights(body.rows, s);
    renderWatchFeed(diffFlaggedRows(lastRows, body.rows), s.startRow);
    lastRows = body.rows;
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

function renderLimitsEditor(limits, s) {
  editorSheet = s;
  const box = $("limits-rows");
  box.innerHTML =
    '<div class="limits-row limits-head"><div>Column</div><div>Base lo</div><div>Base hi</div><div>Weird lo</div><div>Weird hi</div></div>';
  for (const [col, bounds] of Object.entries(limits)) {
    const row = document.createElement("div");
    row.className = "limits-row";
    row.dataset.column = col;
    row.innerHTML = `<div>${esc(col)}</div>` + bounds.map((v) => `<input type="number" value="${v ?? ""}">`).join("");
    box.appendChild(row);
  }
  only("limits-editor");
}

async function saveLimitsAndRescan() {
  const limits = {};
  document.querySelectorAll("#limits-rows .limits-row[data-column]").forEach((row) => {
    limits[row.dataset.column] = [...row.querySelectorAll("input")].map((i) => (i.value === "" ? null : parseFloat(i.value)));
  });
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

// ---- Highlights: remember fill, color by severity, Clear restores ----

async function applyHighlights(rows, s) {
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
    const fills = rows.map((_, i) =>
      sheet.getRangeByIndexes(s.startRow + 1 + i, s.startCol, 1, s.columns.length).format.fill.load("color"));
    await ctx.sync();
    // ponytail: one color per row; a row with mixed old fills restores only the first
    const colors = fills.map((f) => f.color);
    rows.forEach((r, i) => {
      if (COLOR[r.severity]) fills[i].color = COLOR[r.severity];
    });
    await ctx.sync();
    lastHighlight = { sheetName: sheet.name, ...s, colors };
  });
}

async function clearHighlights() {
  const h = lastHighlight;
  if (!h) return;
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(h.sheetName);
    h.colors.forEach((c, i) => {
      const fill = sheet.getRangeByIndexes(h.startRow + 1 + i, h.startCol, 1, h.columns.length).format.fill;
      if (c) fill.color = c;
      else fill.clear();
    });
    await ctx.sync();
  });
  lastHighlight = null;
}

// ---- AI triage: explicit button only. Safe actions need a human click. ----

async function runTriage() {
  if (!aiAvailable || !$("ai-toggle").checked || !triageRows.length) return;
  const btn = $("run-triage");
  btn.disabled = true;
  btn.textContent = "Triaging…";
  try {
    (await post("/triage", { columns: lastScan.columns, flagged: triageRows })).results.forEach(renderTriage);
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
        await approve(t.row_index, t.safe_action, t.suggested_action_detail);
        b.textContent = "Applied";
      } catch (e) {
        console.error(e);
        b.disabled = false;
        b.textContent = "Failed - retry";
      }
    };
    block.appendChild(b);
  }
  li.appendChild(block);
}

async function approve(i, action, detail) {
  const { columns, rows, startRow, startCol } = lastScan;
  await Excel.run(async (ctx) => {
    const wb = ctx.workbook;
    if (action === "add_note") {
      // note goes in the column right of the data, never over a value
      wb.worksheets.getActiveWorksheet().getRangeByIndexes(startRow + 1 + i, startCol + columns.length, 1, 1).values = [[`AI note: ${detail}`]];
      return ctx.sync();
    }
    let sheet = wb.worksheets.getItemOrNullObject("Anomalies").load("isNullObject");
    await ctx.sync();
    if (sheet.isNullObject) {
      sheet = wb.worksheets.add("Anomalies");
      sheet.getRangeByIndexes(0, 0, 1, columns.length + 1).values = [[...columns, "Reason"]];
    }
    const used = sheet.getUsedRangeOrNullObject().load("rowCount");
    await ctx.sync();
    sheet.getRangeByIndexes(used.isNullObject ? 0 : used.rowCount, 0, 1, rows[i].length + 1).values = [[...rows[i], detail]];
    await ctx.sync();
  });
}

// ---- Fix a flagged row: click it (pane list or the sheet), say what you want in plain English,
// Claude proposes cell writes, user previews old -> new and clicks Apply. Undo restores. ----

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
  if (i !== null && !(view === "fix-view" && fix.i === i)) openFix(i, false); // openFix ignores clean rows
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
  const { columns, rows, startRow, startCol, sheet } = lastScan;
  const r = lastRows[i];
  if (!r || !r.severity) return; // list item left over from before a Route Monitor rescan
  const f = (fix = { i, changes: [] });
  $("fix-title").textContent = `Fix row ${startRow + i + 2} - ${r.severity}`;
  $("fix-values").textContent = columns.map((c, j) => `${c}: ${rows[i][j]}`).join(" · ");
  const t = triaged[i];
  $("fix-reason").textContent = (r.reason || "Flagged by the engine.") + (t ? ` AI: ${t.verdict} - ${t.reason}` : "");
  $("fix-intent").value = "";
  $("fix-status").textContent = "";
  show("fix-nokey", !aiAvailable);
  show("fix-result", false);
  only("fix-view");
  if (selectInSheet)
    await Excel.run(async (ctx) => {
      ctx.workbook.worksheets.getItem(sheet).activate();
      ctx.workbook.worksheets.getItem(sheet).getRangeByIndexes(startRow + 1 + i, startCol, 1, columns.length).select();
      await ctx.sync();
    }).catch((e) => console.error("select row failed", e));
  // instant, local recommendation - no AI, no key needed
  const rec = recommendFix(columns, rows, i, await getLimits(), r.reason, startRow, startCol);
  if (fix === f) await showFix(f, "Recommended fix", rec);
}

async function askFix() {
  if (!fix || $("fix-ask").disabled) return; // disabled while busy or without an API key
  const f = fix;
  const btn = $("fix-ask");
  btn.disabled = true;
  btn.textContent = "Thinking… (up to a minute)";
  $("fix-status").textContent = "";
  try {
    const { columns, rows, startRow, startCol } = lastScan;
    const out = await post("/fix", {
      columns, rows, row_index: f.i, start_row: startRow, start_col: startCol,
      reason: lastRows[f.i].reason, intent: $("fix-intent").value,
    });
    if (fix === f) await showFix(f, "AI suggestion", out); // else: user moved to another row meanwhile
  } catch (e) {
    if (fix === f) $("fix-status").textContent = "Could not get a fix: " + e.message;
  } finally {
    btn.disabled = !aiAvailable;
    btn.textContent = "Ask AI";
  }
}

// Preview a fix as cell: old -> new. Nothing is written until Apply.
async function showFix(f, label, out) {
  const olds = await readCells(lastScan.sheet, out.changes.map((c) => c.cell));
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
function recommendFix(columns, rows, i, limits, reason, startRow, startCol) {
  const row = startRow + 2 + i;
  const changes = [], why = [];
  reason = reason || "";
  columns.forEach((c, j) => {
    const lim = limits && limits[c];
    if (!lim) return;
    const v = rows[i][j], lo = lim[2], hi = lim[3];
    const blank = (v === "" || v === null) && reason.includes(`Blank cell in column ${c},`);
    const outside = typeof v === "number" && ((lo != null && v < lo) || (hi != null && v > hi));
    if (!(blank || outside)) return;
    const med = median(rows.filter((_, k) => k !== i).map((r) => r[j]));
    if (med === null) return;
    changes.push({ cell: `${colLetter(startCol + j)}${row}`, new: String(+med.toPrecision(10)) });
    why.push(blank ? `${c} is blank` : `${c} is ${v}, outside its limits (${lo ?? "no low"} to ${hi ?? "no high"})`);
  });
  const notes = [];
  if (changes.length) {
    const how = changes.length > 1 ? "them each with the median of the rest of its column" : "it with the median of the rest of the column";
    notes.push(`${why.join("; ")}. Replace ${how} - a typical value that ignores outliers.`);
  }
  const dup = /Duplicate of row (\d+)/.exec(reason); // engine counts from a header in row 1
  if (dup) notes.push(`This row repeats row ${+dup[1] + startRow}. If it's a double entry, delete it: right-click the row number > Delete.`);
  for (const [, raw, col] of reason.matchAll(/Text "([^"]*)" in number column ([^;]+)/g))
    notes.push(`${col} holds the text "${raw}" where a number belongs - retype it as a number.`);
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

async function applyFix() {
  const f = fix;
  if (undos[f.i]) return;
  $("fix-apply").disabled = true;
  try {
    const cells = f.changes.map((c) => c.cell);
    const olds = await readCells(lastScan.sheet, cells);
    await writeCells(lastScan.sheet, f.changes.map((c) => ({ cell: c.cell, value: c.new })));
    undos[f.i] = cells.map((cell, k) => ({ cell, value: olds[k] })); // all read before any write
    if (fix === f) {
      setApplied(true);
      $("fix-status").textContent = "Applied. Scan again to refresh the highlights.";
    }
  } catch (e) {
    $("fix-apply").disabled = false;
    $("fix-status").textContent = "Apply failed: " + e.message;
  }
}

async function undoFix() {
  const f = fix;
  try {
    await writeCells(lastScan.sheet, undos[f.i]);
    delete undos[f.i];
    if (fix === f) {
      setApplied(false);
      $("fix-status").textContent = "Undone - the cells are back to what they were.";
    }
  } catch (e) {
    $("fix-status").textContent = "Undo failed: " + e.message;
  }
}

// ---- Results dashboard ----

function renderResults(body, startRow) {
  only("results");
  const h = computeHealthSummary(body);
  $("stat-rows").textContent = h.totalRows;
  $("stat-anomalies").textContent = h.flaggedCount;
  $("stat-high").textContent = h.severityCounts.High || 0;
  $("health-ring").style.setProperty("--pct", h.healthPct);
  $("health-ring").style.setProperty("--ring-color", h.healthColor);
  $("health-pct").textContent = `${h.healthPct}%`;
  $("health-label").textContent = h.healthLabel;
  $("health-detail").textContent = h.healthDetail;
  $("bucket-row").innerHTML = ["Duplicates", "Irregularities", "Behavioral"]
    .map((b) => `<span class="bucket-chip">${b}: ${h.bucketCounts[b] || 0}</span>`).join("");

  const flagged = body.rows.map((r, i) => ({ ...r, i })).filter((r) => r.severity).sort((a, b) => b.magnitude - a.magnitude);
  const shown = flagged.slice(0, CAP);
  const list = $("flagged-list");
  list.replaceChildren(...shown.map((r) => {
    const li = rowItem(startRow + r.i + 2, r.severity, r.reason);
    li.dataset.rowIndex = r.i;
    li.onclick = () => openFix(r.i, true);
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

if (typeof module !== "undefined") module.exports = { computeHealthSummary, diffFlaggedRows, isDateFormat, excelDate, rowFromAddress, colLetter, median, recommendFix };
