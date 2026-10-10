import { STRENGTH, STRENGTH_KEY } from "../constants/index.js";
import { state } from "../hooks/use-state.js";
import { $ } from "../utils/dom.js";

// The 0-10 slider: how hard to look. Our own, not <input type=range>: in Excel's pane the native one was switched off
// during every re-check, so a press on it fell through to the page and started a text drag (the "stop sign").
// This one is never disabled, follows the pointer anywhere on the track (press, drag, release), and works by keyboard.
// Letting go saves the level in the workbook and checks the sheet again; while a check runs, the newest level waits.
export const strengthHint = (s) => STRENGTH.filter(([at]) => at <= s).pop()[1];

// Pure: whatever the workbook holds -> a level 0-10 (a missing or broken setting = 5, the recommended one)
export const asStrength = (v) => (Number.isInteger(v) && v >= 0 && v <= 10 ? v : 5);

// Pure: pointer x on a track [left, left + width] -> the nearest level 0-10
export const levelAt = (x, left, width) => Math.round(Math.min(1, Math.max(0, (x - left) / width)) * 10);

let level = 5;
export const strength = () => level;

function show(s) {
  level = s;
  const el = $("strength");
  el.setAttribute("aria-valuenow", s);
  el.setAttribute("aria-valuetext", `${s} of 10`);
  el.style.setProperty("--pct", `${s * 10}%`);
  $("strength-val").textContent = `${s} of 10`;
  $("strength-hint").textContent = strengthHint(s);
}

export function initStrength(rescan) {
  const el = $("strength");
  let pressed = null, queued = false, running = false; // pressed = the level when the press began
  show(asStrength(Office.context.document.settings.get(STRENGTH_KEY)));

  // One re-check at a time; a level chosen meanwhile gets exactly one more check, with the newest level
  async function recheck() {
    if (running) return void (queued = true);
    running = true;
    try {
      do {
        queued = false;
        while (state.working) await new Promise((ok) => setTimeout(ok, 150)); // a check the user started: wait for it
        await rescan();
      } while (queued);
    } finally {
      running = false;
    }
  }
  function commit() {
    Office.context.document.settings.set(STRENGTH_KEY, level);
    Office.context.document.settings.saveAsync();
    if (state.lastScan) recheck();
  }
  const follow = (e) => {
    const r = el.getBoundingClientRect();
    show(levelAt(e.clientX, r.left, r.width));
  };

  el.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no native drag - the pointer belongs to the slider
    el.setPointerCapture(e.pointerId);
    el.focus();
    pressed = level;
    follow(e); // a press anywhere on the track jumps there, then the thumb follows the drag
  };
  el.onpointermove = (e) => pressed !== null && follow(e);
  el.onpointerup = el.onpointercancel = () => {
    if (pressed === null) return;
    const before = pressed;
    pressed = null;
    if (level !== before) commit();
  };
  el.onkeydown = (e) => {
    const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 2, PageDown: -2 }[e.key];
    const to = e.key === "Home" ? 0 : e.key === "End" ? 10 : step === undefined ? null : Math.min(10, Math.max(0, level + step));
    if (to === null) return;
    e.preventDefault();
    if (to !== level) (show(to), commit());
  };
}
