import { SEV } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, only, show } from "../utils/dom.js";
import { rowFromAddress } from "../utils/sheet.js";
import { act } from "../hooks/use-action.js";
import { busy, notice } from "../components/progress.js";
import { showAccepted, showFix } from "../components/fix-preview.js";
import { plainReason } from "../features/scan.js";
import { recommendFix, suggestTypo } from "../features/fix.js";
import { fillRow } from "../features/highlight.js";
import { listRows } from "./results.js";
import { saveDecisions } from "../features/decisions.js";
import { fadeIn, morph, turnIn } from "../components/motion.js";
import { plainError } from "../utils/errors.js";

// One row's card: what's wrong, the suggested fix (Accept / Dismiss, then Undo / Next row), and Ask AI.
export function onSelect(e) {
  if (state.working || !state.lastScan || (state.view !== "results" && state.view !== "fix-view")) return; // never yank the user out of the limits editor
  const i = rowFromAddress(e.address, state.lastScan.startRow);
  // a dismissed row stays quiet when clicked in the sheet (the list still opens it); a fixed one offers Undo
  const open = (SEV[state.lastRows[i]?.severity] && !state.decided[i]) || state.undos[i];
  if (i !== null && open && !(state.fix && state.fix.i === i)) act(() => openFix(i, false))();
}

export async function openFix(i, selectInSheet, from = null) { // from: the list's button pressed, if one was
  const { columns, rows, startRow, startCol, sheet } = state.lastScan;
  const r = state.lastRows[i], u = state.undos[i]; // u: its fix was accepted - the card offers Undo
  if (r && !SEV[r.severity] && !u && state.decided[i] === "fixed") return selectFixed(i); // fixed before: nothing to undo here
  if (!r || (!SEV[r.severity] && !u)) return;
  const f = (state.fix = { i, sheet, changes: [], calc: null });
  const at = from?.getBoundingClientRect();
  await morph(from?.querySelector(".row-head"), () => {
    $("fix-title").textContent = `Row ${startRow + i + 2}: ${SEV[r.severity]?.toLowerCase() ?? "fixed"}`;
    $("fix-reason").textContent = plainReason(r.reason) || (u ? "Checked again after your fix: it looks right." : "Flagged by the checker.");
    $("fix-intent").value = "";
    $("fix-status").textContent = "";
    $("fix-status").classList.remove("tick");
    $("fix-care").textContent = "";
    show("fix-care", false);
    show("fix-label");
    $("fix-ask").textContent = "Ask AI";
    $("fix-changes").innerHTML = "";
    $("fix-explanation").textContent = "";
    only("fix-view");
    busy("Opening row…"); // over the card, in the space it holds: said over the list, it pushed the list down as it left
    // the card turns in like a page, here and on Next row; from a row of the list, hinged at that row's height
    const view = $("fix-view");
    turnIn(view, at ? at.top + at.height / 2 - view.getBoundingClientRect().top : null);
  }, () => $("fix-title"));
  if (state.fix !== f) return;
  await Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItem(sheet);
    const range = ws.getRangeByIndexes(startRow + 1 + i, startCol, 1, columns.length).load("formulas");
    if (selectInSheet) (ws.activate(), range.select());
    await ctx.sync();
    f.calc = range.formulas[0]; // a cell holding a formula is never typed over
  });
  if (u) return showAccepted(f, u);
  let rec = recommendFix(columns, rows, i, state.lastLimits, r.reason, startRow, startCol, r.likely, f.calc, r.maybe, r.formula);
  if (state.fix === f) rec = await suggestTypo(f, r, rec).catch(() => rec); // no typo found or engine busy: the advice stays
  const label = !rec.changes.length ? "What to check" : rec.typo ? "Possible typo: check it before you accept"
    : rec.guess ? "Best guess: check it before you accept" : "Suggested fix";
  if (state.fix === f) await showFix(f, label, rec);
}

// A row fixed before this scan that looks right now, with no Undo kept for it (Forget, an edit or a sort since, a cell
// too long to keep, or a formula's old value, which only the pane that made the fix held): the list selects it.
async function selectFixed(i) {
  const { columns, startRow, startCol, sheet } = state.lastScan;
  await Excel.run(async (ctx) => {
    const ws = ctx.workbook.worksheets.getItem(sheet);
    ws.activate();
    ws.getRangeByIndexes(startRow + 1 + i, startCol, 1, columns.length).select();
    await ctx.sync();
  });
  notice(`Row ${startRow + i + 2} was fixed and looks right now. There is nothing to undo here: its old values are no longer kept.`);
}

// Dismiss = leave this row as it is: its highlight goes, like a dismissed Grammarly underline. Then the next row.
// Kept in the workbook under the row's code, so the row stays dismissed after a reload or a re-scan.
// AH-149: the pane answers at once: the row is Dismissed and the next card turns in while Excel takes the highlight off
// (it waited for Excel first, a beat on every Dismiss). If keeping it or taking the highlight off fails, the row is put
// back as it was, its card with it, and the card says so
export async function dismissFix() {
  const f = state.fix;
  if (!f) return;
  const was = state.decided[f.i] || null, code = state.codes[f.i];
  state.decided[f.i] = "dismissed";
  const kept = (async () => {
    saveDecisions(f.sheet, [[code, "dismissed"]]);
    await fillRow(f.i, false);
  })();
  const [saved, moved] = await Promise.allSettled([kept, nextFix()]);
  if (saved.status === "rejected") return putBack(f, was, code, saved.reason);
  if (moved.status === "rejected") throw moved.reason;
}

async function putBack(f, was, code, e) {
  if (was) state.decided[f.i] = was;
  else delete state.decided[f.i];
  saveDecisions(f.sheet, [[code, was]]);
  await fillRow(f.i, true).catch(() => {}); // whatever came off goes back on
  await openFix(f.i, false);
  $("fix-status").textContent = `Row ${state.lastScan.startRow + f.i + 2} was not dismissed, so it is back on your list. ${plainError(e)}`;
}

// Back to the list: the card's title flies home to its row (AH-149), or the list fades in where that can't be
export function backToList() {
  const i = state.fix?.i;
  state.fix = null;
  return morph($("fix-title"), () => { listRows(); fadeIn($("results")); },
    () => $("flagged-list").children[state.order.indexOf(i)]?.querySelector(".row-head"));
}

// The next row in the list (worst first) nobody accepted or dismissed yet - selected in the sheet, card open.
export async function nextFix() {
  const order = state.order, at = order.indexOf(state.fix?.i);
  const next = [...order.slice(at + 1), ...order.slice(0, at + 1)].find((i) => !state.decided[i]);
  if (next !== undefined) return openFix(next, true);
  state.fix = null;
  listRows();
  notice("All flagged rows are done. Click Find problems to check the whole sheet again.");
}
