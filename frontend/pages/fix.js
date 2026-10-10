import { SEV } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, only } from "../utils/dom.js";
import { rowFromAddress } from "../utils/sheet.js";
import { act } from "../hooks/use-action.js";
import { busy, notice } from "../components/progress.js";
import { showAccepted, showFix } from "../components/fix-preview.js";
import { plainReason } from "../features/scan.js";
import { recommendFix, suggestTypo } from "../features/fix.js";
import { fillRow } from "../features/highlight.js";
import { listRows } from "./results.js";

// One row's card: what's wrong, the suggested fix (Accept / Dismiss, then Undo / Next row), and Ask AI.
export function onSelect(e) {
  if (state.working || !state.lastScan || (state.view !== "results" && state.view !== "fix-view")) return; // never yank the user out of the limits editor
  const i = rowFromAddress(e.address, state.lastScan.startRow);
  // a dismissed row stays quiet when clicked in the sheet (the list still opens it); a fixed one offers Undo
  const open = (SEV[state.lastRows[i]?.severity] && !state.handled.has(i)) || state.undos[i];
  if (i !== null && open && !(state.fix && state.fix.i === i)) act(() => openFix(i, false))();
}

export async function openFix(i, selectInSheet) {
  const { columns, rows, startRow, startCol, sheet } = state.lastScan;
  const r = state.lastRows[i], u = state.undos[i]; // u: its fix was accepted - the card offers Undo
  if (!r || (!SEV[r.severity] && !u)) return;
  busy("Opening row…");
  const f = (state.fix = { i, sheet, changes: [], calc: null });
  $("fix-title").textContent = `Row ${startRow + i + 2}: ${SEV[r.severity]?.toLowerCase() ?? "fixed"}`;
  $("fix-reason").textContent = plainReason(r.reason) || (u ? "Checked again after your fix: it looks right." : "Flagged by the checker.");
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
  if (u) return showAccepted(f, u);
  // totals rows don't count toward the median or the "naturally wide" test
  const data = rows.map((row, k) => (/^Totals\/summary row/.test(state.lastRows[k].reason) ? row.map(() => "") : row));
  let rec = recommendFix(columns, data, i, state.lastLimits, r.reason, startRow, startCol, r.likely, f.calc, r.maybe);
  if (state.fix === f) rec = await suggestTypo(f, r, rec).catch(() => rec); // no typo found or engine busy: the advice stays
  const label = !rec.changes.length ? "What to check" : rec.typo ? "Possible typo - check it before you accept"
    : rec.guess ? "Best guess - check it before you accept" : "Suggested fix";
  if (state.fix === f) await showFix(f, label, rec);
}

// Dismiss = leave this row as it is: its highlight goes, like a dismissed Grammarly underline. Then the next row.
export async function dismissFix() {
  const f = state.fix;
  if (!f) return;
  state.handled.add(f.i);
  await fillRow(f.i, false);
  await nextFix();
}

// The next row in the list (worst first) nobody accepted or dismissed yet - selected in the sheet, card open.
export async function nextFix() {
  const order = state.order, at = order.indexOf(state.fix?.i);
  const next = [...order.slice(at + 1), ...order.slice(0, at + 1)].find((i) => !state.handled.has(i));
  if (next !== undefined) return openFix(next, true);
  state.fix = null;
  listRows();
  notice("All flagged rows are done. Click Find problems to check the whole sheet again.");
}
