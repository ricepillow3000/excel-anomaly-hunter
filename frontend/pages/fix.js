import { SEV } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, only } from "../utils/dom.js";
import { rowFromAddress } from "../utils/sheet.js";
import { act } from "../hooks/use-action.js";
import { busy } from "../components/progress.js";
import { showFix } from "../components/fix-preview.js";
import { plainReason } from "../features/scan.js";
import { recommendFix } from "../features/fix.js";

// One row: what's wrong, the suggested fix (Apply / Undo), and Ask AI.
export function onSelect(e) {
  if (state.working || !state.lastScan || (state.view !== "results" && state.view !== "fix-view")) return; // never yank the user out of the limits editor
  const i = rowFromAddress(e.address, state.lastScan.startRow);
  if (i !== null && SEV[state.lastRows[i]?.severity] && !(state.fix && state.fix.i === i)) act(() => openFix(i, false))();
}

export async function openFix(i, selectInSheet) {
  const { columns, rows, startRow, startCol, sheet } = state.lastScan;
  const r = state.lastRows[i];
  if (!r || !SEV[r.severity]) return;
  busy("Opening row…");
  const f = (state.fix = { i, sheet, changes: [], calc: null });
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
  const data = rows.map((row, k) => (/^Totals\/summary row/.test(state.lastRows[k].reason) ? row.map(() => "") : row));
  const rec = recommendFix(columns, data, i, state.lastLimits, r.reason, startRow, startCol, r.likely, f.calc);
  if (state.fix === f) await showFix(f, "Suggested fix", rec);
}
