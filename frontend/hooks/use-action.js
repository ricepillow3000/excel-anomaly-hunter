import { state } from "./use-state.js";
import { busy, notice } from "../components/progress.js";
import { setApplied } from "../components/fix-preview.js";
import { setAi } from "../features/ai.js";
import { plainError } from "../utils/errors.js";

// Wrap a sheet action: buttons off while it runs, a plain message if it fails, buttons back on after.
export const act = (fn) => async (...args) => {
  if (state.working) return;
  state.working = true;
  document.querySelectorAll("#main-ui button").forEach((b) => (b.disabled = true)); // the slider stays live: it queues its own re-check
  notice("");
  try {
    await fn(...args);
  } catch (e) {
    notice(plainError(e)); // our own sentence, or plain words for Excel's code (AH-110); the detail goes to the console
  } finally {
    state.working = false;
    busy(null);
    document.querySelectorAll("#main-ui button").forEach((b) => (b.disabled = false));
    setAi(state.aiAvailable); // Ask AI stays off without a key
    if (state.fix) setApplied(!!state.undos[state.fix.i]);
  }
};

// One click does one thing (AH-127): the second click of a double-click lands on whatever the first one drew there. After
// Undo, Dismiss stands where Undo was, so a double-click on Undo dismissed the row too; Forget ran twice and ended on
// "holds nothing"; Dismiss's second click accepted the next card's fix. So a click the browser counts as the 2nd or 3rd
// of a run (event.detail > 1) never reaches a button. Enter and Space press a button with detail 0, so keys still work.
export function oneClickEach() {
  document.addEventListener("click", (e) => {
    if (e.detail > 1 && e.target.closest?.("button")) e.stopImmediatePropagation();
  }, true);
}
