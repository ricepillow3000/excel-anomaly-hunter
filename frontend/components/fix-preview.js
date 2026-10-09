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
  $("fix-changes").innerHTML = out.changes
    .map((c, k) => `<li><b>${esc(c.cell)}</b>: <span class="old">${esc(olds[k])}</span> &rarr; <span class="new">${esc(c.new)}</span></li>`)
    .join("");
  show("fix-apply", out.changes.length > 0);
  setApplied(!!state.undos[f.i]);
}

// An applied fix must be undone before another one is applied, so Undo always gets back to the original.
export function setApplied(applied) {
  $("fix-apply").disabled = applied || state.working;
  $("fix-apply").textContent = applied ? "Applied" : "Apply fix";
  show("fix-undo", applied);
}
