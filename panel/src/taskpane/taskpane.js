/* global console, document, Excel, Office, fetch, module */

const SERVER = "http://127.0.0.1:5055";
const SETTINGS_KEY = "anomalyHunterLimits";
const SEVERITY_COLOR = { High: "#FFC7CE", Medium: "#FFEB9C", Low: "#FFFFCC", Noted: "#FFF8DC" };

let lastHighlight = null; // {sheetName, startRow, startCol, numColumns, rowCount, originalColors}
let lastScan = null; // {columns, rows, startRow, startCol} — the data a scan was run on
let lastFlaggedForTriage = []; // the capped, rendered flagged rows, with row_index + values
let lastScanSeverities = null; // [{severity}, ...] from the most recent scan, manual or watch
let aiAvailable = false;
let watchEventResult = null;
let watchTimer = null;

if (typeof Office !== "undefined") {
  // ponytail: guarded so this file can also be `require`d from plain Node for the self-check below
  Office.onReady((info) => {
    if (info.host === Office.HostType.Excel) {
      document.getElementById("sideload-msg").style.display = "none";
      document.getElementById("app-body").style.display = "block";
      document.getElementById("scan").onclick = runScan;
      document.getElementById("retry-health").onclick = checkHealth;
      document.getElementById("save-limits").onclick = saveLimitsAndRescan;
      document.getElementById("edit-limits").onclick = showLimitsEditorFromSaved;
      document.getElementById("clear-highlights").onclick = clearHighlights;
      document.getElementById("run-triage").onclick = runTriage;
      document.getElementById("watch-toggle").onchange = onWatchToggleChanged;
      showActiveSheetName();
      checkHealth();
    }
  });
}

async function showActiveSheetName() {
  await Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    sheet.load("name");
    await context.sync();
    document.getElementById("sheet-name").textContent = sheet.name;
  });
}

async function checkHealth() {
  try {
    const resp = await fetch(`${SERVER}/health`);
    if (!resp.ok) throw new Error("not ok");
    const body = await resp.json();
    aiAvailable = !!body.ai_available;
    document.getElementById("ai-toggle").disabled = !aiAvailable;
    document.getElementById("run-triage").disabled = !aiAvailable;
    document.getElementById("server-down").style.display = "none";
    document.getElementById("main-ui").style.display = "block";
  } catch (e) {
    document.getElementById("main-ui").style.display = "none";
    document.getElementById("server-down").style.display = "block";
  }
}

function getSavedLimits() {
  return new Promise((resolve) => {
    Office.context.document.settings.refreshAsync(() => {
      resolve(Office.context.document.settings.get(SETTINGS_KEY) || null);
    });
  });
}

function saveLimits(limits) {
  Office.context.document.settings.set(SETTINGS_KEY, limits);
  Office.context.document.settings.saveAsync();
}

async function readActiveSheetData() {
  return Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    const used = sheet.getUsedRange();
    used.load("values, rowIndex, columnIndex");
    await context.sync();
    return { data: used.values, startRow: used.rowIndex, startCol: used.columnIndex };
  });
}

function hideAllPanels() {
  ["empty-state", "limits-editor", "results", "error-state"].forEach(
    (id) => (document.getElementById(id).style.display = "none")
  );
}

function showError(message) {
  hideAllPanels();
  document.getElementById("error-state").style.display = "block";
  document.getElementById("error-text").textContent = message;
}

async function runScan() {
  const btn = document.getElementById("scan");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    const { data, startRow, startCol } = await readActiveSheetData();
    if (!data || data.length < 2 || !Array.isArray(data[0])) {
      hideAllPanels();
      const empty = document.getElementById("empty-state");
      empty.style.display = "block";
      empty.querySelector("p").textContent =
        "Not enough data — add a header row plus at least one data row, starting at A1.";
      return;
    }
    const columns = data[0];
    const rows = data.slice(1);
    const savedLimits = await getSavedLimits();
    await scanAndRender(columns, rows, savedLimits, startRow, startCol);
  } catch (e) {
    console.error(e);
    showError("Scan failed: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan Active Sheet";
  }
}

async function scanAndRender(columns, rows, limits, startRow, startCol) {
  let resp;
  try {
    resp = await fetch(`${SERVER}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns, rows, limits, order_by: null }),
    });
  } catch (e) {
    document.getElementById("main-ui").style.display = "none";
    document.getElementById("server-down").style.display = "block";
    return;
  }

  const body = await resp.json();
  if (!resp.ok) {
    showError(body.error || "The local engine returned an error.");
    return;
  }

  if (!limits && body.suggested_limits) {
    hideAllPanels();
    renderLimitsEditor(body.suggested_limits, columns, rows, startRow, startCol);
    return;
  }

  lastScan = { columns, rows, startRow, startCol };
  lastScanSeverities = body.rows.map((r) => ({ severity: r.severity }));
  await applyHighlights(body.rows, startRow, startCol, columns.length);
  renderResults(body, startRow);
}

async function onWatchToggleChanged(e) {
  const status = document.getElementById("watch-status");
  if (e.target.checked) {
    const saved = await getSavedLimits();
    if (!saved) {
      e.target.checked = false;
      status.textContent = "Scan once first to set limits before watching.";
      return;
    }
    try {
      await startWatching();
      status.textContent = "Watching — rescans ~1.5s after you stop editing.";
    } catch (err) {
      e.target.checked = false;
      status.textContent = "Could not start watching: " + err.message;
    }
  } else {
    await stopWatching();
    status.textContent = "Not watching.";
  }
}

async function startWatching() {
  await Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    watchEventResult = sheet.onChanged.add(onSheetChanged);
    await context.sync();
  });
}

async function stopWatching() {
  if (watchTimer) {
    clearTimeout(watchTimer);
    watchTimer = null;
  }
  if (watchEventResult) {
    const toRemove = watchEventResult;
    watchEventResult = null;
    await Excel.run(async (context) => {
      toRemove.remove();
      await context.sync();
    });
  }
}

function onSheetChanged() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = setTimeout(runWatchRescan, 1500);
}

async function runWatchRescan() {
  watchTimer = null;
  try {
    const { data, startRow, startCol } = await readActiveSheetData();
    if (!data || data.length < 2 || !Array.isArray(data[0])) return;
    const columns = data[0];
    const rows = data.slice(1);
    const savedLimits = await getSavedLimits();
    if (!savedLimits) return;

    const resp = await fetch(`${SERVER}/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns, rows, limits: savedLimits, order_by: null }),
    });
    if (!resp.ok) return;
    const body = await resp.json();

    lastScan = { columns, rows, startRow, startCol };
    await applyHighlights(body.rows, startRow, startCol, columns.length);

    const diffs = diffFlaggedRows(lastScanSeverities, body.rows);
    lastScanSeverities = body.rows.map((r) => ({ severity: r.severity }));
    renderWatchFeed(diffs, startRow);
  } catch (e) {
    console.error("watch rescan failed", e);
  }
}

// Pure logic, no Office.js/fetch — easy to self-check from plain Node.
function diffFlaggedRows(previous, current) {
  const changes = [];
  current.forEach((row, i) => {
    const wasFlagged = !!(previous && previous[i] && previous[i].severity);
    const isFlagged = !!row.severity;
    if (isFlagged && !wasFlagged) {
      changes.push({ rowIndex: i, kind: "new", severity: row.severity, reason: row.reason });
    } else if (!isFlagged && wasFlagged) {
      changes.push({ rowIndex: i, kind: "resolved", severity: previous[i].severity, reason: "" });
    }
  });
  return changes;
}

function renderWatchFeed(diffs, startRow) {
  if (diffs.length === 0) return;
  const feed = document.getElementById("watch-feed");
  const CAP = 25; // ponytail: same cap convention as the flagged-rows list
  diffs.forEach((d) => {
    const li = document.createElement("li");
    const sheetRow = startRow + d.rowIndex + 2;
    if (d.kind === "new") {
      li.className = `sev-${d.severity.toLowerCase()}`;
      li.innerHTML =
        `<div class="row-head"><span>Row ${sheetRow} — newly flagged</span><span>${d.severity}</span></div>` +
        `<div class="reason">${escapeHtml(d.reason)}</div>`;
    } else {
      li.className = "feed-resolved";
      li.innerHTML = `<div class="row-head"><span>Row ${sheetRow} — resolved</span></div>`;
    }
    feed.insertBefore(li, feed.firstChild);
  });
  while (feed.children.length > CAP) {
    feed.removeChild(feed.lastChild);
  }
}

function renderLimitsEditor(suggested, columns, rows, startRow, startCol) {
  const container = document.getElementById("limits-rows");
  container.innerHTML = "";
  const head = document.createElement("div");
  head.className = "limits-row limits-head";
  head.innerHTML =
    "<div>Column</div><div>Base lo</div><div>Base hi</div><div>Weird lo</div><div>Weird hi</div>";
  container.appendChild(head);

  Object.entries(suggested).forEach(([col, bounds]) => {
    const row = document.createElement("div");
    row.className = "limits-row";
    row.dataset.column = col;
    const label = document.createElement("div");
    label.textContent = col;
    row.appendChild(label);
    bounds.forEach((val) => {
      const input = document.createElement("input");
      input.type = "number";
      input.value = val === null || val === undefined ? "" : val;
      row.appendChild(input);
    });
    container.appendChild(row);
  });

  const editor = document.getElementById("limits-editor");
  editor.dataset.columns = JSON.stringify(columns);
  editor.dataset.rows = JSON.stringify(rows);
  editor.dataset.startRow = startRow;
  editor.dataset.startCol = startCol;
  editor.style.display = "block";
}

function readLimitsFromEditor() {
  const limits = {};
  document.querySelectorAll("#limits-rows .limits-row:not(.limits-head)").forEach((row) => {
    const inputs = [...row.querySelectorAll("input")];
    limits[row.dataset.column] = inputs.map((inp) =>
      inp.value === "" ? null : parseFloat(inp.value)
    );
  });
  return limits;
}

async function saveLimitsAndRescan() {
  const editor = document.getElementById("limits-editor");
  const columns = JSON.parse(editor.dataset.columns);
  const rows = JSON.parse(editor.dataset.rows);
  const startRow = parseInt(editor.dataset.startRow, 10);
  const startCol = parseInt(editor.dataset.startCol, 10);
  const limits = readLimitsFromEditor();

  saveLimits(limits);
  await scanAndRender(columns, rows, limits, startRow, startCol);
}

async function showLimitsEditorFromSaved() {
  try {
    const { data, startRow, startCol } = await readActiveSheetData();
    const columns = data[0];
    const rows = data.slice(1);
    const saved = (await getSavedLimits()) || {};
    const numberCols = columns.filter((_, i) => rows.some((r) => typeof r[i] === "number"));
    const shown = {};
    numberCols.forEach((col) => {
      shown[col] = saved[col] || [null, null, null, null];
    });
    hideAllPanels();
    renderLimitsEditor(shown, columns, rows, startRow, startCol);
  } catch (e) {
    showError("Could not load limits: " + e.message);
  }
}

async function applyHighlights(resultRows, startRow, startCol, numColumns) {
  await Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    sheet.load("name");

    const ranges = resultRows.map((_, i) =>
      sheet.getRangeByIndexes(startRow + 1 + i, startCol, 1, numColumns)
    );
    ranges.forEach((r) => r.format.fill.load("color"));
    await context.sync();

    // ponytail: captures one color per row (not per cell) — correct when the
    // row's pre-scan fill was uniform or empty, which covers the common case;
    // a row with several different pre-existing colors restores only the first.
    const originalColors = ranges.map((r) => r.format.fill.color);

    resultRows.forEach((r, i) => {
      if (r.severity && SEVERITY_COLOR[r.severity]) {
        ranges[i].format.fill.color = SEVERITY_COLOR[r.severity];
      }
    });
    await context.sync();

    lastHighlight = {
      sheetName: sheet.name,
      startRow,
      startCol,
      numColumns,
      rowCount: resultRows.length,
      originalColors,
    };
  });
}

async function clearHighlights() {
  if (!lastHighlight) return;
  const { sheetName, startRow, startCol, numColumns, rowCount, originalColors } = lastHighlight;
  await Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getItem(sheetName);
    for (let i = 0; i < rowCount; i++) {
      const range = sheet.getRangeByIndexes(startRow + 1 + i, startCol, 1, numColumns);
      if (originalColors[i]) {
        range.format.fill.color = originalColors[i];
      } else {
        range.format.fill.clear();
      }
    }
    await context.sync();
  });
  lastHighlight = null;
}

async function runTriage() {
  if (!aiAvailable || !document.getElementById("ai-toggle").checked) return;
  if (!lastScan || lastFlaggedForTriage.length === 0) return;

  const btn = document.getElementById("run-triage");
  btn.disabled = true;
  btn.textContent = "Triaging…";
  try {
    const resp = await fetch(`${SERVER}/triage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns: lastScan.columns, flagged: lastFlaggedForTriage }),
    });
    const body = await resp.json();
    if (!resp.ok) {
      showError(body.error || "AI triage failed.");
      return;
    }
    body.results.forEach(renderTriageResult);
  } catch (e) {
    console.error(e);
    showError("AI triage failed: " + e.message);
  } finally {
    btn.disabled = !aiAvailable;
    btn.textContent = "Triage flagged rows";
  }
}

function renderTriageResult(result) {
  const li = document.querySelector(`#flagged-list li[data-row-index="${result.row_index}"]`);
  if (!li) return;

  const block = document.createElement("div");
  block.className = "ai-block";
  const verdictLine = `<div class="verdict ${result.verdict}">${escapeHtml(result.verdict)}</div>`;
  const reasonLine = `<div>${escapeHtml(result.reason)}</div>`;

  if (result.safe_action === "none") {
    block.innerHTML =
      verdictLine +
      reasonLine +
      `<div class="action-detail">${escapeHtml(result.suggested_action_detail)} (manual — not applied automatically)</div>`;
  } else {
    block.innerHTML =
      verdictLine +
      reasonLine +
      `<div class="action-detail">${escapeHtml(result.suggested_action_detail)}</div>`;
    const approveBtn = document.createElement("button");
    approveBtn.className = "approve-btn";
    approveBtn.textContent =
      result.safe_action === "add_note" ? "Approve: add note" : "Approve: copy to Anomalies sheet";
    approveBtn.onclick = async () => {
      approveBtn.disabled = true;
      approveBtn.textContent = "Applying…";
      try {
        await approveSafeAction(
          result.row_index,
          result.safe_action,
          result.suggested_action_detail
        );
        approveBtn.textContent = "Applied";
      } catch (e) {
        console.error(e);
        approveBtn.disabled = false;
        approveBtn.textContent = "Failed — retry";
      }
    };
    block.appendChild(approveBtn);
  }

  li.appendChild(block);
}

async function approveSafeAction(rowIndex, action, detail) {
  const { columns, rows, startRow, startCol } = lastScan;
  if (action === "add_note") {
    await Excel.run(async (context) => {
      const sheet = context.workbook.worksheets.getActiveWorksheet();
      const cell = sheet.getRangeByIndexes(
        startRow + 1 + rowIndex,
        startCol + columns.length,
        1,
        1
      );
      cell.values = [[`AI note: ${detail}`]];
      await context.sync();
    });
  } else if (action === "copy_to_anomalies_sheet") {
    await Excel.run(async (context) => {
      const wb = context.workbook;
      const existing = wb.worksheets.getItemOrNullObject("Anomalies");
      existing.load("isNullObject");
      await context.sync();

      let sheet = existing;
      if (existing.isNullObject) {
        sheet = wb.worksheets.add("Anomalies");
        sheet.getRange("A1").values = [[...columns, "Reason"]];
        await context.sync();
      }

      const used = sheet.getUsedRangeOrNullObject();
      used.load("rowCount, isNullObject");
      await context.sync();
      const nextRow = used.isNullObject ? 0 : used.rowCount;

      const rowValues = rows[rowIndex];
      sheet.getRangeByIndexes(nextRow, 0, 1, rowValues.length + 1).values = [
        [...rowValues, detail],
      ];
      await context.sync();
    });
  }
}

function renderResults(scanResponse, startRow) {
  hideAllPanels();
  document.getElementById("results").style.display = "block";

  const summary = computeHealthSummary(scanResponse);

  document.getElementById("stat-rows").textContent = summary.totalRows;
  document.getElementById("stat-anomalies").textContent = summary.flaggedCount;
  document.getElementById("stat-high").textContent = summary.severityCounts.High || 0;

  const ring = document.getElementById("health-ring");
  ring.style.setProperty("--pct", summary.healthPct);
  ring.style.setProperty("--ring-color", summary.healthColor);
  document.getElementById("health-pct").textContent = `${summary.healthPct}%`;
  document.getElementById("health-label").textContent = summary.healthLabel;
  document.getElementById("health-detail").textContent = summary.healthDetail;

  const bucketRow = document.getElementById("bucket-row");
  bucketRow.innerHTML = "";
  ["Duplicates", "Irregularities", "Behavioral"].forEach((bucket) => {
    const chip = document.createElement("span");
    chip.className = "bucket-chip";
    chip.textContent = `${bucket}: ${summary.bucketCounts[bucket] || 0}`;
    bucketRow.appendChild(chip);
  });

  document.getElementById("ai-row").style.display = "block";

  const list = document.getElementById("flagged-list");
  list.innerHTML = "";
  const CAP = 25; // ponytail: cap the list so one huge dataset doesn't flood the pane
  const flagged = scanResponse.rows
    .map((r, i) => ({ ...r, rowIndex: i, sheetRow: startRow + i + 2 }))
    .filter((r) => r.severity)
    .sort((a, b) => b.magnitude - a.magnitude);

  const shown = flagged.slice(0, CAP);
  shown.forEach((r) => {
    const li = document.createElement("li");
    li.className = `sev-${r.severity.toLowerCase()}`;
    li.dataset.rowIndex = r.rowIndex;
    li.innerHTML =
      `<div class="row-head"><span>Row ${r.sheetRow}</span><span>${r.severity}</span></div>` +
      `<div class="reason">${escapeHtml(r.reason)}</div>`;
    list.appendChild(li);
  });
  if (flagged.length > CAP) {
    const li = document.createElement("li");
    li.className = "more";
    li.textContent = `+ ${flagged.length - CAP} more`;
    list.appendChild(li);
  }

  // Triage only what's actually shown — matches what the analyst can act on.
  lastFlaggedForTriage = lastScan
    ? shown.map((r) => ({
        row_index: r.rowIndex,
        values: lastScan.rows[r.rowIndex],
        severity: r.severity,
        bucket: r.bucket,
        reason: r.reason,
      }))
    : [];
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Pure logic, no Office.js/fetch — easy to self-check from plain Node.
function computeHealthSummary(scanResponse) {
  const rows = scanResponse.rows;
  const totalRows = rows.length;
  const flaggedCount = rows.filter((r) => r.severity && r.severity !== "Noted").length;
  const severityCounts = scanResponse.summary.severity_counts || {};
  const bucketCounts = scanResponse.summary.bucket_counts || {};
  const healthPct = totalRows ? Math.round(((totalRows - flaggedCount) / totalRows) * 100) : 100;
  // ponytail: same fixed health-color bands as the earlier design pass
  const healthColor = healthPct >= 95 ? "#107c10" : healthPct >= 80 ? "#d29200" : "#d13438";
  let healthLabel, healthDetail;
  if (flaggedCount === 0) {
    healthLabel = "Clean";
    healthDetail = "No anomalies found.";
  } else {
    healthLabel = healthPct >= 80 ? "Mostly clean" : "Needs review";
    healthDetail = `${flaggedCount} of ${totalRows} rows flagged.`;
  }
  return {
    totalRows,
    flaggedCount,
    severityCounts,
    bucketCounts,
    healthPct,
    healthColor,
    healthLabel,
    healthDetail,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { computeHealthSummary, diffFlaggedRows };
}
