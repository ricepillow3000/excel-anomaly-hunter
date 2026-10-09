import { $ } from "../utils/dom.js";
import { saveKey } from "../features/ai.js";

// Settings: the optional free AI key (stored only on this PC by the back end).
export function initSettings() {
  $("save-key").onclick = () => saveKey($("ai-key").value);
  $("remove-key").onclick = () => saveKey("");
}
