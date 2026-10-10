import { SEV } from "../constants/index.js";
import { esc } from "../utils/text.js";
import { plainReason } from "../features/scan.js";

// One row in the "Rows to check" list: a button that opens the row. done = "Fixed" / "Dismissed" / ... or null.
export function rowItem(r, startRow, onClick, done = null) {
  const li = document.createElement("li");
  li.className = done ? "done" : `sev-${r.severity}`;
  const b = document.createElement("button");
  b.innerHTML = `<span class="row-head"><span class="swatch"></span>Row ${startRow + r.i + 2}<span class="sev">${done || SEV[r.severity]}</span></span>` +
    `<span class="row-why">${esc(plainReason(r.reason) || "Looks right now.")}</span>`;
  b.onclick = onClick;
  li.appendChild(b);
  return li;
}
