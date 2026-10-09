import { state } from "../hooks/use-state.js";
import { $, show } from "../utils/dom.js";
import { post } from "../services/api.js";
import { showFix } from "../components/fix-preview.js";

// Ask AI: the API client in the workflow (the engine forwards to Gemini). Optional; fixes work without it.
export function setAi(on) {
  state.aiAvailable = !!on;
  show("ai-box", state.aiAvailable);
  show("ai-off", !state.aiAvailable);
  $("fix-ask").disabled = !state.aiAvailable || !!state.fix?.asking;
  $("ai-state").textContent = state.aiAvailable ? "AI help is on." : "AI help is off. It's optional - fixes work without it.";
}

export async function saveKey(key) {
  try {
    const out = await post("/key", { key: key.trim() });
    $("ai-key").value = ""; // the key never stays on screen
    setAi(out.ai_available);
    $("ai-state").textContent = out.ai_available ? "Saved. AI help is on." : "Key removed. AI help is off.";
  } catch (e) {
    $("ai-state").textContent = e.message;
  }
}

export async function askFix() { // talks to the engine only; the sheet is touched later, by Apply
  if (!state.fix || !state.aiAvailable || $("fix-ask").disabled) return;
  const f = state.fix, btn = $("fix-ask");
  f.asking = btn.disabled = true;
  btn.textContent = "AI is thinking… (up to a minute)";
  $("fix-status").textContent = "";
  try {
    const { columns, rows, startRow, startCol } = state.lastScan;
    const out = await post("/fix", {
      columns, rows, row_index: f.i, start_row: startRow, start_col: startCol,
      reason: state.lastRows[f.i].reason, intent: $("fix-intent").value, formulas: f.calc,
    }, 300);
    if (state.fix === f) await showFix(f, "AI's fix", out); // else: the user moved to another row meanwhile
  } catch (e) {
    if (state.fix === f) $("fix-status").textContent = "AI could not help: " + e.message;
  } finally {
    f.asking = false;
    if (state.fix === f) (btn.disabled = !state.aiAvailable), (btn.textContent = "Ask AI");
  }
}
