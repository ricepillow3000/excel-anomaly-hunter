import { $ } from "../utils/dom.js";
import { saveKey } from "../features/ai.js";

// Settings: the optional free AI key (stored only on this PC by the back end).
export function initSettings() {
  $("save-key").onclick = () => $("ai-key").value.trim() ? saveKey($("ai-key").value)
    : ($("ai-state").textContent = "Paste a key in the box first, then click Save key."); // an empty Save is not a Remove
  $("remove-key").onclick = () => saveKey("");
}
