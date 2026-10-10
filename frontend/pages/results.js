import { SEV, CAP } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $, show, only } from "../utils/dom.js";
import { n } from "../utils/text.js";
import { cutNote } from "../utils/sheet.js";
import { act } from "../hooks/use-action.js";
import { rowItem } from "../components/row-item.js";
import { flaggedRows, summaryOf } from "../features/scan.js";
import { openFix } from "./fix.js";

// Results show up: the summary, the color legend and the rows to check.
export function renderResults(rows, s) {
  const flagged = flaggedRows(rows);
  state.order = flagged.map((r) => r.i); // the list keeps this order while rows get fixed or dismissed
  $("summary").textContent = summaryOf(rows);
  const counts = flagged.reduce((c, r) => ((c[r.severity] = (c[r.severity] || 0) + 1), c), {});
  $("legend").replaceChildren(...Object.keys(SEV).filter((k) => counts[k]).map((k) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="swatch sev-${k}"></span>${SEV[k]}: ${n(counts[k])}`;
    return li;
  }));
  show("cut-note", !!s.cut);
  if (s.cut) $("cut-note").textContent = cutNote(s.cut);
  listRows();
}

// The rows to check, worst first, each tagged once it is fixed or dismissed (like Grammarly's list of cards)
export function listRows() {
  only("results");
  const { order, lastRows, undos, handled } = state, { startRow } = state.lastScan;
  const status = (i) => (undos[i] ? (SEV[lastRows[i].severity] ? "Fix accepted" : "Fixed") : handled.has(i) ? "Dismissed" : null);
  const done = order.filter(status).length;
  show("list-title", order.length > 0);
  $("list-title").textContent = done ? `Rows to check - ${n(done)} of ${n(order.length)} done` : "Rows to check";
  $("flagged-list").replaceChildren(...order.slice(0, CAP).map((i) => rowItem({ ...lastRows[i], i }, startRow, act(() => openFix(i, true)), status(i))));
  if (order.length > CAP) {
    const li = document.createElement("li");
    li.className = "more-rows";
    li.textContent = `+ ${n(order.length - CAP)} more, all highlighted in the sheet. Fix these first, then click Find problems again.`;
    $("flagged-list").appendChild(li);
  }
}
