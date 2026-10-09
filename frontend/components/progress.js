import { $, show } from "../utils/dom.js";

export const notice = (msg) => ($("notice").textContent = msg || "");

// Progress line under the button. pct = 0..1 for real progress, null while the engine works (no fake numbers).
export function busy(text, pct = null) {
  show("busy", !!text);
  $("busy-text").textContent = text || "";
  $("busy-bar").classList.toggle("unknown", pct === null);
  $("busy-bar").style.width = pct === null ? "" : `${Math.round(pct * 100)}%`;
}
