import { STRENGTH, STRENGTH_KEY } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $ } from "../utils/dom.js";

// The 0-10 slider: how hard to look. Saved in the workbook; letting go of it checks the sheet again at the new level.
export const strengthHint = (s) => STRENGTH.filter(([at]) => at <= s).pop()[1];

// Pure: whatever the workbook holds -> a level 0-10 (a missing or broken setting = 5, the recommended one)
export const asStrength = (v) => (Number.isInteger(v) && v >= 0 && v <= 10 ? v : 5);

export const strength = () => asStrength(+$("strength").value);

function show(s) {
  $("strength").value = s;
  $("strength-val").textContent = s;
  $("strength-hint").textContent = strengthHint(s);
}

export function initStrength(rescan) {
  show(asStrength(Office.context.document.settings.get(STRENGTH_KEY)));
  $("strength").oninput = () => show(strength()); // while dragging: the words follow, nothing runs yet
  $("strength").onchange = () => { // let go: save it and, once a sheet was checked, check it again
    Office.context.document.settings.set(STRENGTH_KEY, strength());
    Office.context.document.settings.saveAsync();
    // the slider is off while the sheet is re-checked, which drops keyboard focus: hand it back so arrows keep working
    if (state.lastScan) rescan().then(() => $("strength").focus());
  };
}
