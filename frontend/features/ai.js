import { state } from "../hooks/use-state.js";
import { $, show } from "../utils/dom.js";
import { post } from "../services/api.js";
import { showFix } from "../components/fix-preview.js";
import { checkFix } from "./fix.js";
import { plainReason } from "./scan.js";

// Ask AI: the API client in the workflow (the engine forwards to Gemini). Optional; fixes work without it.
export function setAi(on) {
  state.aiAvailable = !!on;
  show("ai-box", state.aiAvailable);
  show("ai-off", !state.aiAvailable);
  show("odd-box", state.aiAvailable);
  $("fix-ask").disabled = !state.aiAvailable || !!state.fix?.asking;
  $("ai-state").textContent = state.aiAvailable ? "AI help is on." : "AI help is off. It's optional - fixes work without it.";
}

export async function saveKey(key) {
  try {
    const out = await post("/key", { key: key.trim() });
    $("ai-key").value = ""; // the key never stays on screen
    setAi(out.ai_available);
    // the engine tested the key with Google: "Key works", or why it was saved untested
    $("ai-state").textContent = out.message || (out.ai_available ? "Saved. AI help is on." : "Key removed. AI help is off.");
  } catch (e) {
    $("ai-state").textContent = e.message;
  }
}

export async function askFix() { // talks to the engine only; the sheet is touched later, by Apply
  if (!state.fix || !state.aiAvailable || $("fix-ask").disabled) return;
  const f = state.fix, btn = $("fix-ask");
  f.asking = btn.disabled = true;
  btn.textContent = "AI is thinking… (usually a few seconds; slower when Google is busy)";
  $("fix-status").textContent = "";
  try {
    const { columns, rows, startRow, startCol } = state.lastScan;
    const out = await post("/fix", {
      columns, rows, row_index: f.i, start_row: startRow, start_col: startCol,
      reason: state.lastRows[f.i].reason, intent: $("fix-intent").value, formulas: f.calc,
    }, 300);
    const v = await checkFix(f, out.changes).catch(() => null); // Agent 3 looks first; null = a formula, judged after Accept
    if (v) out.explanation += v.clean ? " Checked: with this fix the row looks right."
      : ` Checked: with this fix the row would still look unusual - ${plainReason(v.reason)}.`;
    if (state.fix === f) await showFix(f, "AI's fix", out); // else: the user moved to another row meanwhile
  } catch (e) {
    if (state.fix === f) $("fix-status").textContent = "AI could not help: " + e.message;
  } finally {
    f.asking = false;
    if (state.fix === f) (btn.disabled = !state.aiAvailable), (btn.textContent = "Ask AI");
  }
}

// The AI word check: a value that is a different KIND of thing from the rest of its column ("London" among products).
// The engine sends only each text column's distinct words. Worth a look, not proof: nothing is changed in the sheet.
export async function checkWords() {
  const { columns, rows, startRow } = state.lastScan;
  const item = (text) => Object.assign(document.createElement("li"), { textContent: text }); // AI text is never HTML
  try {
    const { odd, partial } = await post("/odd-text", { columns, rows }, 300);
    $("odd-list").replaceChildren(...(odd.length ? odd.map((o) => item(`Row ${startRow + o.row + 2}: ${o.column} "${o.value}" - ${o.why}`))
      : [item(partial ? "Nothing out of place so far." : "Nothing looks out of place.")]),
    ...(partial ? [item("Google got busy before every word was checked. Click again to check the rest - the finished part is kept.")] : []));
  } catch (e) { // Google busy (it often is), no key...: said right here, like Ask AI does
    $("odd-list").replaceChildren(item("AI could not check: " + e.message));
  }
}
