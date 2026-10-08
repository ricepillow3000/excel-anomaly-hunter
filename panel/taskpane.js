// Anomaly Hunter task pane. Talks to the local engine at the same origin. Plain JS, no build.
// One path for anyone: Find problems -> rows to check (highlighted in the sheet) -> click one -> Apply fix / Undo.
const SERVER = "https://127.0.0.1:5055";
const KEY = "anomalyHunterLimits"; // limits the user changed, saved inside the workbook
const SEV = { High: "Very likely wrong", Medium: "Probably wrong", Low: "Worth a check" }; // Noted = fine, not shown
const COLOR = { High: "#FFC7CE", Medium: "#FFEB9C", Low: "#FFFFCC" };
const CAP = 50; // rows listed in the pane; all of them are highlighted in the sheet
const CHUNK = 500; // rows highlighted per Excel call: big enough to be quick, small enough that Excel never freezes
const READ_CELLS = 200000; // cells read per Excel call, so the progress bar moves and no single call is huge
const VIEWS = ["empty-state", "results", "limits-editor", "fix-view"];

let lastScan = null; // {columns, rows, startRow, startCol, sheet, cut} what the last scan read
let lastRows = null; // the engine's verdict per row
let lastLimits = {}; // the limits that scan used: {col: [noteLo, noteHi, flagLo, flagHi]}
let painted = null; // {sheet, startRow, startCol, width, colors: {row: old fill}} - what Remove highlights puts back
let picker = null; // {sheet, handle}: clicking a highlighted row in the sheet opens its fix
let fix = null; // the row open in the fix view: {i, sheet, calc, changes}
let undos = {}; // row -> cells to put back, while an applied fix isn't undone
let aiAvailable = false;
let working = false; // one sheet action at a time; while one runs the buttons are disabled, never silently queued

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => ($(id).hidden = !on);
let view = null;
const only = (id) => ((view = id), VIEWS.forEach((v) => show(v, v === id)));
const notice = (msg) => ($("notice").textContent = msg || "");
const n = (x) => x.toLocaleString("en-US");

// Progress line under the button. pct = 0..1 for real progress, null while the engine works (no fake numbers).
function busy(text, pct = null) {
  show("busy", !!text);
  $("busy-text").textContent = text || "";
  $("busy-bar").classList.toggle("unknown", pct === null);
  $("busy-bar").style.width = pct === null ? "" : `${Math.round(pct * 100)}%`;
}

// Wrap a sheet action: buttons off while it runs, a plain message if it fails, buttons back on after.
const act = (fn) => async (...args) => {
  if (working) return;
  working = true;
  document.querySelectorAll("#main-ui button").forEach((b) => (b.disabled = true));
  notice("");
  try {
    await fn(...args);
  } catch (e) {
    console.error(e);
    notice("Something went wrong: " + e.message);
  } finally {
    working = false;
    busy(null);
    document.querySelectorAll("#main-ui button").forEach((b) => (b.disabled = false));
    setAi(aiAvailable); // Ask AI stays off without a key
    if (fix) setApplied(!!undos[fix.i]);
  }
};

if (typeof Office !== "undefined") {
  // guarded: selfcheck.js loads this file in plain Node
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Excel) return;
    show("sideload-msg", false);
    show("app-body");
    $("scan").onclick = act(runScan);
    $("retry-health").onclick = checkHealth;
    $("clear-highlights").onclick = act(clearHighlights);
    $("edit-limits").onclick = openLimitsEditor;
    $("cancel-limits").onclick = () => only(lastScan ? "results" : "empty-state");
    $("save-limits").onclick = act(saveLimitsAndRescan);
    $("auto-limits").onclick = act(async () => (saveLimits(null), await runScan()));
    $("fix-back").onclick = () => ((fix = null), only("results"));
    $("fix-apply").onclick = act(() => fix && applyFix(fix, fix.changes, fix.sheet));
    $("fix-undo").onclick = act(() => fix && undoFix(fix));
    $("fix-ask").onclick = askFix;
    $("fix-intent").onkeydown = (e) => e.key === "Enter" && e.ctrlKey && askFix();
    $("save-key").onclick = () => saveKey($("ai-key").value);
    $("remove-key").onclick = () => saveKey("");
    Excel.run(async (ctx) => {
      const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
      await ctx.sync();
      $("sheet-name").textContent = sheet.name;
    });
    only("empty-state");
    checkHealth();
  });
}

async function checkHealth() {
  try {
    const r = await fetch(`${SERVER}/health`);
    if (!r.ok) throw new Error();
    setAi((await r.json()).ai_available);
    show("main-ui");
    show("server-down", false);
  } catch {
    show("main-ui", false);
    show("server-down");
  }
}

function setAi(on) {
  aiAvailable = !!on;
  show("ai-box", aiAvailable);
  show("ai-off", !aiAvailable);
  $("fix-ask").disabled = !aiAvailable || !!fix?.asking;
  $("ai-state").textContent = aiAvailable ? "AI help is on." : "AI help is off. It's optional - fixes work without it.";
}

async function saveKey(key) {
  try {
    const out = await post("/key", { key: key.trim() });
    $("ai-key").value = ""; // the key never stays on screen
    setAi(out.ai_available);
    $("ai-state").textContent = out.ai_available ? "Saved. AI help is on." : "Key removed. AI help is off.";
  } catch (e) {
    $("ai-state").textContent = e.message;
  }
}

async function post(path, body, seconds = 120) { // a stuck engine never leaves the pane waiting forever
  const r = await fetch(SERVER + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(seconds * 1000),
  }).catch((e) => {
    if (e.name === "TimeoutError") throw new Error(`the checker took over ${seconds} seconds. Try again.`);
    throw new Error("the checker isn't running. Double-click install.bat, then try again.");
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 && !j.error) throw new Error("the checker is out of date. Close Excel and double-click install.bat.");
  if (!r.ok) throw new Error(j.error || "the checker returned an error.");
  return j;
}

const getLimits = () =>
  new Promise((ok) => Office.context.document.settings.refreshAsync(() => ok(Office.context.document.settings.get(KEY) || null)));

function saveLimits(limits) {
  if (limits) Office.context.document.settings.set(KEY, limits);
  else Office.context.document.settings.remove(KEY);
  Office.context.document.settings.saveAsync();
}

// A scan reads at most this many cells: Excel refuses one read over 5M cells, and the engine's time grows with it.
// Only the bottom is cut, so row numbers never shift.
const maxCells = () => globalThis.MAX_CELLS || 2e6;

// Values only, in slices (formulas are read per row when a fix opens; number formats only for the top rows,
// where the header and first data row are). This was 3x the data in one call - the freeze on big sheets.
async function readSheet(onSlice) {
  return Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet().load("name");
    const used = sheet.getUsedRange().load("rowIndex, columnIndex, rowCount, columnCount");
    await ctx.sync();
    const { rowIndex: r0, columnIndex: c0, columnCount: w } = used;
    const total = Math.min(used.rowCount, Math.floor(maxCells() / w));
    const top = sheet.getRangeByIndexes(r0, c0, Math.min(total, 12), w).load("numberFormat");
    const step = Math.max(1, Math.floor(READ_CELLS / w)), values = [];
    for (let k = 0; k < total; k += step) {
      const part = sheet.getRangeByIndexes(r0 + k, c0, Math.min(step, total - k), w).load("values");
      await ctx.sync();
      for (const row of part.values) values.push(row);
      onSlice(values.length / total);
    }
    await ctx.sync();
    const t = tableFromGrid(values, top.numberFormat, r0, c0, null);
    return t && { ...t, sheet: sheet.name, cut: total < used.rowCount && [r0 + total, r0 + used.rowCount] };
  });
}

// ---- Find problems: read, check, list, highlight ----

async function runScan() {
  const t0 = Date.now();
  fix = null;
  if (view !== "results") only(lastScan ? "results" : "empty-state"); // no fix view left without its row
  busy("Step 1 of 3: reading your sheet…", 0);
  const s = await readSheet((p) => busy(`Step 1 of 3: reading your sheet… ${Math.round(p * 100)}%`, p));
  if (!s) {
    only("empty-state");
    return notice("Not enough data here. Put a row of column names on top, with at least one row of data below it.");
  }
  busy(`Step 2 of 3: checking ${n(s.rows.length)} rows…`);
  const body = await post("/scan", { columns: s.columns, rows: s.rows, limits: await getLimits(), order_by: null }, 300);
  lastScan = s;
  lastRows = body.rows;
  lastLimits = body.limits || {};
  undos = {};
  $("sheet-name").textContent = s.sheet;
  renderResults(body.rows, s);
  await paint(body.rows, s);
  await watchSelection(s.sheet);
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  notice(`Done in ${secs} second${secs === 1 ? "" : "s"}.`);
  // a checked workbook reopens with this pane open (Office autoopen; manifest TaskpaneId)
  Office.context.document.settings.set("Office.AutoShowTaskpaneWithDocument", true);
  Office.context.document.settings.saveAsync();
}

// Pure: the rows worth a look - surest first, then biggest - each with its data-row index ("Noted" = fine)
const RANK = { High: 0, Medium: 1, Low: 2 };
const flaggedRows = (rows) => rows.map((r, i) => ({ ...r, i })).filter((r) => SEV[r.severity])
  .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.magnitude - a.magnitude);

// Pure: the summary sentence
function summaryOf(rows) {
  const sure = rows.filter((r) => r.severity === "High" || r.severity === "Medium").length;
  const maybe = rows.filter((r) => r.severity === "Low").length;
  const more = maybe ? ` ${n(maybe)}${sure ? " more" : ""} ${maybe === 1 ? "is" : "are"} worth a quick check.` : "";
  if (!sure && !maybe) return `No problems found in ${n(rows.length)} rows.`;
  return (sure ? `${n(sure)} of ${n(rows.length)} rows look wrong.` : `Nothing clearly wrong in ${n(rows.length)} rows.`) + more;
}

// Pure: the engine's reason in plain words, for the list and the fix view
function plainReason(reason) {
  return String(reason || "")
    .replace(/^Flagged by \d+ of \d+: /, "")
    .replace(/(\S[^;]*?) weird limit is ([^;\s]+); this is ([^;\s]+)/g, (_, c, lim, v) => `${c} is ${v}, ${+v < +lim ? "below" : "above"} its usual limit of ${lim}`)
    .replace(/Unusual combination of values, mainly (.+?)(?=;|$)/g, "Unusual mix of values, mostly in $1")
    .replace(/ is unusual relative to its local trend near/g, " breaks its usual pattern near")
    .replace(/ 00:00:00/g, "")
    .split("; ").join(" · ");
}

function renderResults(rows, s) {
  only("results");
  const flagged = flaggedRows(rows);
  $("summary").textContent = summaryOf(rows);
  const counts = flagged.reduce((c, r) => ((c[r.severity] = (c[r.severity] || 0) + 1), c), {});
  $("legend").replaceChildren(...Object.keys(SEV).filter((k) => counts[k]).map((k) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch sev-${k}"></span>${SEV[k]}: ${n(counts[k])}`;
    return li;
  }));
  show("cut-note", !!s.cut);
  if (s.cut) $("cut-note").textContent = cutNote(s.cut);
  show("list-title", flagged.length > 0);
  $("flagged-list").replaceChildren(...flagged.slice(0, CAP).map((r) => {
    const li = document.createElement("li");
    li.className = `sev-${r.severity}`;
    const b = document.createElement("button");
    b.innerHTML = `<span class="row-head"><span class="swatch"></span>Row ${s.startRow + r.i + 2}<span class="sev">${SEV[r.severity]}</span></span>` +
      `<span class="row-why">${esc(plainReason(r.reason))}</span>`;
    b.onclick = act(() => openFix(r.i, true));
    li.appendChild(b);
    return li;
  }));
  if (flagged.length > CAP) {
    const li = document.createElement("li");
    li.className = "more-rows";
    li.textContent = `+ ${n(flagged.length - CAP)} more, all highlighted in the sheet. Fix these first, then click Find problems again.`;
    $("flagged-list").appendChild(li);
  }
}

// ---- Highlights: color the flagged rows, CHUNK rows per Excel call. The old fill of each row is remembered,
// so Remove highlights puts back exactly what was there. ----

async function paint(rows, s) {
  await unpaint();
  const flagged = rows.flatMap((r, i) => (COLOR[r.severity] ? [i] : []));
  const p = { sheet: s.sheet, startRow: s.startRow, startCol: s.startCol, width: s.columns.length, colors: {} };
  painted = p; // recorded before painting: a failure halfway still lets Remove highlights undo what got done
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItem(s.sheet);
    for (let k = 0; k < flagged.length; k += CHUNK) {
      busy(`Step 3 of 3: highlighting rows to check… ${n(k)} of ${n(flagged.length)}`, k / flagged.length);
      const part = flagged.slice(k, k + CHUNK);
      const ranges = part.map((i) => sheet.getRangeByIndexes(s.startRow + 1 + i, s.startCol, 1, p.width));
      const fills = ranges.map((r) => r.format.fill.load("color"));
      await ctx.sync();
      // a row whose cells have different fills reads as null: keep every cell's own color
      const mixed = part.flatMap((i, m) => (fills[m].color === null ? [[i, ranges[m].getCellProperties({ format: { fill: { color: true } } })]] : []));
      if (mixed.length) await ctx.sync();
      part.forEach((i, m) => (p.colors[i] = fills[m].color));
      mixed.forEach(([i, props]) => (p.colors[i] = props.value[0].map((c) => c.format.fill.color)));
      part.forEach((i, m) => (fills[m].color = COLOR[rows[i].severity]));
      await ctx.sync();
    }
  });
}

// Put back the remembered fills - only on rows still wearing one of OUR colors (a row the user recolored since
// is left alone).
async function unpaint() {
  const p = painted;
  if (!p) return;
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getItemOrNullObject(p.sheet).load("isNullObject");
    await ctx.sync();
    if (sheet.isNullObject) return; // that sheet was deleted: nothing left to restore
    const idx = Object.keys(p.colors).map(Number);
    const ours = new Set(Object.values(COLOR));
    for (let k = 0; k < idx.length; k += CHUNK) {
      busy(`Removing highlights… ${n(k)} of ${n(idx.length)}`, k / idx.length);
      const part = idx.slice(k, k + CHUNK);
      const fills = part.map((i) => sheet.getRangeByIndexes(p.startRow + 1 + i, p.startCol, 1, p.width).format.fill.load("color"));
      await ctx.sync();
      const put = (fill, old) => (old && String(old).toUpperCase() !== "#FFFFFF" ? (fill.color = old) : fill.clear());
      fills.forEach((fill, m) => {
        if (!ours.has(String(fill.color).toUpperCase())) return;
        const old = p.colors[part[m]];
        if (!Array.isArray(old)) return put(fill, old);
        old.forEach((c, j) => put(sheet.getRangeByIndexes(p.startRow + 1 + part[m], p.startCol + j, 1, 1).format.fill, c));
      });
      await ctx.sync();
    }
  });
  painted = null;
}

// No record of what was painted (the pane was reopened): on each row that starts with one of our three colors,
// clear just the cells in a row that wear it (what painting covered), never the user's own fills.
async function clearOurColors() {
  await Excel.run(async (ctx) => {
    const sheet = ctx.workbook.worksheets.getActiveWorksheet();
    const used = sheet.getUsedRangeOrNullObject().load("rowIndex, columnIndex, rowCount, columnCount");
    await ctx.sync();
    if (used.isNullObject) return;
    const { rowIndex: r0, columnIndex: c0, rowCount: total, columnCount: w } = used;
    const ours = new Set(Object.values(COLOR));
    const step = Math.max(1, Math.floor(READ_CELLS / w));
    for (let k = 0; k < total; k += step) {
      busy(`Removing highlights… ${Math.round((100 * k) / total)}%`, k / total);
      const props = sheet.getRangeByIndexes(r0 + k, c0, Math.min(step, total - k), w).getCellProperties({ format: { fill: { color: true } } });
      await ctx.sync();
      let queued = 0;
      for (const [m, row] of props.value.entries()) {
        const color = String(row[0].format.fill.color).toUpperCase();
        if (!ours.has(color)) continue;
        let run = 1;
        while (run < w && String(row[run].format.fill.color).toUpperCase() === color) run++;
        sheet.getRangeByIndexes(r0 + k + m, c0, 1, run).format.fill.clear();
        if (++queued % CHUNK === 0) await ctx.sync();
      }
      await ctx.sync();
    }
  });
}

async function clearHighlights() {
  if (painted) await unpaint();
  else await clearOurColors();
  notice("Highlights removed. Your data was not changed.");
}

// ---- Limits: plain "flag below / flag above" per number column ----

// Pure: a saved limit as an input value - a number or nothing (a tampered workbook can't put markup in the page)
const asNumber = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? "" : Number(v));

function openLimitsEditor() {
  $("limits-error").textContent = "";
  const box = $("limits-rows");
  box.innerHTML = '<div class="limits-row limits-head"><div>Column</div><div>Flag below</div><div>Flag above</div></div>';
  for (const [col, b] of Object.entries(lastLimits)) {
    const row = document.createElement("div");
    row.className = "limits-row";
    row.dataset.column = col;
    row.innerHTML = `<div>${esc(col)}</div><input type="number" aria-label="${esc(col)}: flag below" value="${asNumber(b[2])}">` +
      `<input type="number" aria-label="${esc(col)}: flag above" value="${asNumber(b[3])}">`;
    box.appendChild(row);
  }
  only("limits-editor");
}

async function saveLimitsAndRescan() {
  const limits = (await getLimits()) || {}; // columns changed before stay changed
  let bad = null; // [column, input]: low above high - nothing is saved
  document.querySelectorAll("#limits-rows .limits-row[data-column]").forEach((row) => {
    const ins = [...row.querySelectorAll("input")];
    const [lo, hi] = ins.map((x) => (x.value === "" ? null : parseFloat(x.value)));
    const [noteLo, noteHi, wasLo, wasHi] = lastLimits[row.dataset.column] || [];
    if (lo === (wasLo ?? null) && hi === (wasHi ?? null)) return; // unchanged: keeps following the data
    // the "noted" band (shown nowhere) stays inside the new flag limits
    limits[row.dataset.column] = [noteLo ?? null, noteHi ?? null, lo, hi].map((v, k) =>
      k === 0 && lo !== null && v !== null ? Math.max(v, lo) : k === 1 && hi !== null && v !== null ? Math.min(v, hi) : v);
    if (!bad && lo !== null && hi !== null && lo > hi) bad = [row.dataset.column, ins[0]];
  });
  if (bad) {
    $("limits-error").textContent = `${bad[0]}: "Flag below" is bigger than "Flag above".`;
    return bad[1].focus();
  }
  saveLimits(Object.keys(limits).length ? limits : null);
  await runScan();
}

// ---- Fix one row: click it (in the list or the sheet) -> suggested fix, previewed old -> new; Apply / Undo ----

async function watchSelection(sheetName) {
  if (picker && picker.sheet === sheetName) return;
  const old = picker;
  picker = null;
  if (old) await Excel.run(old.handle.context, async (ctx) => (old.handle.remove(), ctx.sync())).catch(() => {}); // old sheet gone: nothing to remove
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

function onSelect(e) {
  if (working || !lastScan || (view !== "results" && view !== "fix-view")) return; // never yank the user out of the limits editor
  const i = rowFromAddress(e.address, lastScan.startRow);
  if (i !== null && SEV[lastRows[i]?.severity] && !(fix && fix.i === i)) act(() => openFix(i, false))();
}

async function openFix(i, selectInSheet) {
  const { columns, rows, startRow, startCol, sheet } = lastScan;
  const r = lastRows[i];
  if (!r || !SEV[r.severity]) return;
  busy("Opening row…");
  const f = (fix = { i, sheet, changes: [], calc: null });
  $("fix-title").textContent = `Row ${startRow + i + 2}: ${SEV[r.severity].toLowerCase()}`;
  $("fix-reason").textContent = plainReason(r.reason) || "Flagged by the checker.";
  $("fix-intent").value = "";
  $("fix-status").textContent = "";
  $("fix-ask").textContent = "Ask AI";
  $("fix-changes").innerHTML = "";
  $("fix-explanation").textContent = "";
  only("fix-view");
  await Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItem(sheet);
    const range = ws.getRangeByIndexes(startRow + 1 + i, startCol, 1, columns.length).load("formulas");
    if (selectInSheet) (ws.activate(), range.select());
    await ctx.sync();
    f.calc = range.formulas[0]; // a cell holding a formula is never typed over
  });
  // totals rows don't count toward the median or the "naturally wide" test
  const data = rows.map((row, k) => (/^Totals\/summary row/.test(lastRows[k].reason) ? row.map(() => "") : row));
  const rec = recommendFix(columns, data, i, lastLimits, r.reason, startRow, startCol, r.likely, f.calc);
  if (fix === f) await showFix(f, "Suggested fix", rec);
}

async function askFix() { // talks to the engine only; the sheet is touched later, by Apply
  if (!fix || !aiAvailable || $("fix-ask").disabled) return;
  const f = fix, btn = $("fix-ask");
  f.asking = btn.disabled = true;
  btn.textContent = "AI is thinking… (up to a minute)";
  $("fix-status").textContent = "";
  try {
    const { columns, rows, startRow, startCol } = lastScan;
    const out = await post("/fix", {
      columns, rows, row_index: f.i, start_row: startRow, start_col: startCol,
      reason: lastRows[f.i].reason, intent: $("fix-intent").value, formulas: f.calc,
    }, 300);
    if (fix === f) await showFix(f, "AI's fix", out); // else: the user moved to another row meanwhile
  } catch (e) {
    if (fix === f) $("fix-status").textContent = "AI could not help: " + e.message;
  } finally {
    f.asking = false;
    if (fix === f) (btn.disabled = !aiAvailable), (btn.textContent = "Ask AI");
  }
}

// Preview a fix as cell: old -> new. Nothing is written until Apply.
async function showFix(f, label, out) {
  const olds = await readCells(f.sheet, out.changes.map((c) => c.cell));
  if (fix !== f) return;
  if (undos[f.i]) return void ($("fix-status").textContent = "AI answered, but a fix is already applied. Click Undo, then Ask AI again.");
  f.changes = out.changes;
  $("fix-label").textContent = label;
  $("fix-explanation").textContent = out.explanation;
  $("fix-changes").innerHTML = out.changes
    .map((c, k) => `<li><b>${esc(c.cell)}</b>: <span class="old">${esc(olds[k])}</span> &rarr; <span class="new">${esc(c.new)}</span></li>`)
    .join("");
  show("fix-apply", out.changes.length > 0);
  setApplied(!!undos[f.i]);
}

// An applied fix must be undone before another one is applied, so Undo always gets back to the original.
function setApplied(applied) {
  $("fix-apply").disabled = applied || working;
  $("fix-apply").textContent = applied ? "Applied" : "Apply fix";
  show("fix-undo", applied);
}

// Pure: a reason -> its parts ("Units weird limit is 0; this is -5" stays ONE part)
function issuesOf(reason) {
  const parts = String(reason || "").replace(/^Flagged by \d+ of \d+: /, "").split("; ").filter(Boolean);
  return parts.reduce((a, p) => (/^this is /.test(p) && a.length ? (a[a.length - 1] += "; " + p) : a.push(p), a), []).map((text) => ({ text }));
}

// Pure: text safe inside HTML and inside "attribute values" (column headers come from the sheet)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// ==== kept as-is (pure, covered by selfcheck.js) ====

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
// Pure: Excel serial day -> "yyyy-mm-dd", plus " hh:mm:ss" when it has a time (25569 = 1970-01-01).
// Dropping the time made two taxi trips on one day with equal fares look like duplicates.
const excelDate = (n) => {
  const s = new Date(Math.round((n - 25569) * 864e2) * 1e3).toISOString();
  return Number.isInteger(n) ? s.slice(0, 10) : `${s.slice(0, 10)} ${s.slice(11, 19)}`;
};

// Pure: "C7", "B7:D7", "Sheet1!C7", "7:7" -> 0-based data row index (header at startRow), or null.
// A selection spanning several rows (dragging down a column) is not a click on a row -> null.
function rowFromAddress(address, startRow) {
  const m = /^(?:.*!)?\$?[A-Z]*\$?(\d+)(?::\$?[A-Z]*\$?(\d+))?$/i.exec(String(address));
  if (!m || (m[2] && m[2] !== m[1])) return null;
  const i = Number(m[1]) - startRow - 2;
  return i >= 0 ? i : null;
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
      $("fix-status").textContent = "Applied. Click Find problems to check the sheet again.";
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


if (typeof module !== "undefined") module.exports = { esc, cutNote, asNumber, issuesOf, plainReason, summaryOf, flaggedRows, isDateFormat, excelDate, rowFromAddress, colLetter, median, recommendFix, tableFromGrid, typoKind, spansDecade };
