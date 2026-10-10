import { state } from "../hooks/use-state.js";
import { $, only } from "../utils/dom.js";
import { esc, asNumber } from "../utils/text.js";
import { getLimits, saveLimits } from "../services/excel.js";
import { runScan } from "../features/scan.js";

// "Exact limits per column (advanced)": plain "flag below / flag above" per number column.
export function openLimitsEditor() {
  $("limits-error").textContent = "";
  const box = $("limits-rows");
  box.innerHTML = '<div class="limits-row limits-head"><div>Column</div><div>Flag below</div><div>Flag above</div></div>';
  for (const [col, b] of Object.entries(state.lastLimits)) {
    const row = document.createElement("div");
    row.className = "limits-row";
    row.dataset.column = col;
    row.innerHTML = `<div>${esc(col)}</div><input type="number" aria-label="${esc(col)}: flag below" value="${asNumber(b[2])}">` +
      `<input type="number" aria-label="${esc(col)}: flag above" value="${asNumber(b[3])}">`;
    box.appendChild(row);
  }
  only("limits-editor");
}

export async function saveLimitsAndRescan() {
  const limits = (await getLimits()) || {}; // columns changed before stay changed
  let bad = null; // [column, input]: low above high - nothing is saved
  document.querySelectorAll("#limits-rows .limits-row[data-column]").forEach((row) => {
    const ins = [...row.querySelectorAll("input")];
    const [lo, hi] = ins.map((x) => (x.value === "" ? null : parseFloat(x.value)));
    const [noteLo, noteHi, wasLo, wasHi] = state.lastLimits[row.dataset.column] || [];
    if (lo === (wasLo ?? null) && hi === (wasHi ?? null)) return; // unchanged: keeps following the data
    // the "noted" band (shown nowhere) stays inside the new flag limits; moved wholly past it, it becomes the flag band
    // (else it ends up low > high and the engine refuses every scan)
    const b = [noteLo ?? null, noteHi ?? null, lo, hi].map((v, k) =>
      k === 0 && lo !== null && v !== null ? Math.max(v, lo) : k === 1 && hi !== null && v !== null ? Math.min(v, hi) : v);
    if (b[0] !== null && b[1] !== null && b[0] > b[1]) [b[0], b[1]] = [lo, hi];
    limits[row.dataset.column] = b;
    if (!bad && lo !== null && hi !== null && lo > hi) bad = [row.dataset.column, ins[0]];
  });
  if (bad) {
    $("limits-error").textContent = `${bad[0]}: "Flag below" is bigger than "Flag above".`;
    return bad[1].focus();
  }
  saveLimits(Object.keys(limits).length ? limits : null);
  await runScan();
}
