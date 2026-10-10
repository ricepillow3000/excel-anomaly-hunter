import { state } from "./use-state.js";
import { busy, notice } from "../components/progress.js";
import { setApplied } from "../components/fix-preview.js";
import { setAi } from "../features/ai.js";

// Wrap a sheet action: buttons off while it runs, a plain message if it fails, buttons back on after.
export const act = (fn) => async (...args) => {
  if (state.working) return;
  state.working = true;
  document.querySelectorAll("#main-ui button").forEach((b) => (b.disabled = true)); // the slider stays live: it queues its own re-check
  notice("");
  try {
    await fn(...args);
  } catch (e) {
    console.error(e);
    notice("Something went wrong: " + e.message);
  } finally {
    state.working = false;
    busy(null);
    document.querySelectorAll("#main-ui button").forEach((b) => (b.disabled = false));
    setAi(state.aiAvailable); // Ask AI stays off without a key
    if (state.fix) setApplied(!!state.undos[state.fix.i]);
  }
};
