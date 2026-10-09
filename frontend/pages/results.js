import { SEV, CAP } from "../constants/index.js";
import { $, show, only } from "../utils/dom.js";
import { n } from "../utils/text.js";
import { cutNote } from "../utils/sheet.js";
import { act } from "../hooks/use-action.js";
import { rowItem } from "../components/row-item.js";
import { flaggedRows, summaryOf } from "../features/scan.js";
import { openFix } from "./fix.js";

// Results show up: the summary, the color legend and the rows to check.
export function renderResults(rows, s) {
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
  $("flagged-list").replaceChildren(...flagged.slice(0, CAP).map((r) => rowItem(r, s.startRow, act(() => openFix(r.i, true)))));
  if (flagged.length > CAP) {
    const li = document.createElement("li");
    li.className = "more-rows";
    li.textContent = `+ ${n(flagged.length - CAP)} more, all highlighted in the sheet. Fix these first, then click Find problems again.`;
    $("flagged-list").appendChild(li);
  }
}
