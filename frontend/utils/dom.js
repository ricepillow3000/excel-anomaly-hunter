import { VIEWS } from "../constants/index.js";
import { state } from "../hooks/use-state.js";

export const $ = (id) => document.getElementById(id);
export const show = (id, on = true) => ($(id).hidden = !on);
export const only = (id) => ((state.view = id), VIEWS.forEach((v) => show(v, v === id))); // switch page
// Buttons turned back on show their own colours at once (AH-149 review r2): they faded back from their off colours over
// the hover's .3 s, so Find problems read as still off once the results were in. The colours are taken with no
// transition (styles: [data-turning-on]); a hover or a press still eases as before
export function turnOn(buttons) {
  const root = document.documentElement;
  root.setAttribute("data-turning-on", "");
  buttons.forEach((b) => (b.disabled = false));
  void root.offsetWidth; // the style is worked out here, while transitions are off
  root.removeAttribute("data-turning-on");
}
