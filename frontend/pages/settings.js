import { $, show, turnOn } from "../utils/dom.js";
import { keySaid, saveKey } from "../features/ai.js";
import { forgetWorkbook } from "../features/forget.js";
import { act } from "../hooks/use-action.js";
import { clearAll } from "../features/memory.js";
import { sayLastScan } from "../features/scan.js";

// One /key at a time: a double click on Save sent two, and each Google key is tried with Google for up to 15 s (AH-87).
// Not act(): it would put "AI help is on/off" over the words the engine sent back about the key
let sending = false;
const once = (fn) => async () => {
  if (sending) return;
  sending = true;
  const buttons = [$("save-key"), $("remove-key")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } finally {
    sending = false;
    turnOn(buttons);
  }
};

// Settings: the optional free AI key (stored only on this PC by the back end), and what the workbook keeps.
export function initSettings() {
  $("save-key").onclick = once(async () => {
    if ($("ai-key").value.trim()) await saveKey($("ai-key").value);
    else keySaid("Paste a key in the box first, then click Save key."); // an empty Save is not a Remove
  });
  $("remove-key").onclick = once(() => saveKey(""));
  $("forget-ai").addEventListener("click", () => { // AH-143: every fix Ask AI remembers on this PC, in every workbook
    clearAll();
    $("forget-ai-state").textContent = "Done. Ask AI no longer knows any fix you accepted before.";
  });
  $("forget-book").onclick = act(async () => {
    $("forget-state").textContent = "";
    const gone = await forgetWorkbook();
    show("undo-auto", false); // its list is gone with the rest
    sayLastScan(); // AH-157: the last check's numbers went too
    $("forget-state").textContent = gone.length
      ? `Removed from this workbook: ${gone.join("; ")}. Your cells are as they were. Save the workbook to keep the change in the file; the next scan saves the setting that opens this pane again.`
      : "This workbook holds nothing Arcas saved.";
  });
}
