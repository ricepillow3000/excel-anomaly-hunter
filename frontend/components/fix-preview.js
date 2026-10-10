import { state } from "../hooks/use-state.js";
import { $, show } from "../utils/dom.js";
import { esc } from "../utils/text.js";
import { readCells } from "../services/excel.js";

// Preview a fix as cell: old -> new. Nothing is written until Apply.
export async function showFix(f, label, out) {
  const olds = await readCells(f.sheet, out.changes.map((c) => c.cell));
  if (state.fix !== f) return;
  if (state.undos[f.i]) return void ($("fix-status").textContent = "AI answered, but a fix is already applied. Click Undo, then Ask AI again.");
  f.changes = out.changes;
  $("fix-label").textContent = label;
  $("fix-explanation").textContent = out.explanation;
  $("fix-changes").innerHTML = changeList(out.changes, olds);
  show("fix-apply", out.changes.length > 0);
  $("fix-dismiss").textContent = out.changes.length ? "Dismiss" : "Looks right"; // no fix offered: the only question left
  setApplied(!!state.undos[f.i]);
}

// A row whose fix was accepted, opened again: what changed (old -> new) and Undo
export function showAccepted(f, u) {
  f.changes = u.changes;
  $("fix-label").textContent = "Accepted fix";
  $("fix-explanation").textContent = "Undo puts the old values back.";
  $("fix-changes").innerHTML = changeList(u.changes, u.writes.map((w) => w.value));
  show("fix-apply");
  setApplied(true);
}

const changeList = (changes, olds) => changes
  .map((c, k) => `<li><b>${esc(c.cell)}</b>: <span class="old">${esc(olds[k])}</span> &rarr; <span class="new">${esc(c.new)}</span></li>`)
  .join("");

// An accepted fix must be undone before another one is accepted, so Undo always gets back to the original.
// The card's buttons: Accept / Dismiss before, Undo / Next row after.
export function setApplied(applied) {
  $("fix-apply").disabled = applied || state.working;
  $("fix-apply").textContent = applied ? "Accepted" : "Accept";
  show("fix-undo", applied);
  show("fix-dismiss", !applied);
  show("fix-next", applied);
}
