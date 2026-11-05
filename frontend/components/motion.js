// The pane's entrance, in the website's motion (AH-72, motion.js there): marked blocks fly in once, the brand and labels
// from the left (data-enter="left"), the Scan button and the slider from below (data-enter="bottom"), staggered in
// page order and all at rest within 1.6 s. The header moves when the pane opens; the rest when the main view first
// appears (after the engine answers), so nothing waits for it: e2e/launch.mjs wants the pane ready in under 2 s.
// Eased by the clock (performance.now), never per frame: the old pane light moved 8% a frame and took as long as the
// machine was slow (AH-22). Reduced motion: no entrance at all.
import { initField } from "./field.js";

// Unhurried (AH-94): John found the old 620 ms "rushing the user"; the last block starts by 600 ms and lands by 1.6 s,
// still inside launch.mjs's 2 s (it measures when the main view is shown and usable, not when it stops moving)
const DUR = 1000, STEP = 120, MAX_DELAY = 600;
const LEFT = 40, RISE = 28;

function enter(els) {
  const items = [...els].map((el, k) => ({ el, from: el.dataset.enter, delay: Math.min(k * STEP, MAX_DELAY) }));
  if (!items.length) return;
  let t0 = 0, done = false;
  const pose = (it, t) => {
    const k = Math.min(1, Math.max(0, (t - it.delay) / DUR));
    if (k >= 1) { it.el.style.transform = ""; it.el.style.opacity = ""; return true; }
    const d = Math.pow(2, -10 * k); // expo out: quick, then a soft landing
    it.el.style.transform = it.from === "left" ? `translate3d(${(-LEFT * d).toFixed(2)}px, 0, 0)` : `translate3d(0, ${(RISE * d).toFixed(2)}px, 0)`;
    it.el.style.opacity = (1 - Math.pow(1 - Math.min(1, k / 0.5), 2)).toFixed(3);
    return false;
  };
  const finish = () => { if (done) return; done = true; for (const it of items) pose(it, Infinity); };
  const frame = (now) => {
    if (done) return;
    if (!t0) t0 = now;
    if (items.map((it) => pose(it, now - t0)).every(Boolean)) finish(); else requestAnimationFrame(frame);
  };
  for (const it of items) pose(it, 0); // the start pose before the next paint: no flash of the final layout
  requestAnimationFrame(frame);
  // a hidden pane gets no frames: never leave a block half-way (or invisible) because of that
  setTimeout(finish, MAX_DELAY + DUR + 200);
}

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.16, 1, .3, 1)"; // the pane's --ease
// a page swings at an even pace: on --ease the whole turn was over in the first 150 ms and read as a jump
const TURN = "cubic-bezier(.25, .8, .25, 1)";

// The fix card turns in like a page (AH-94, the website's tabs): hinged on its left edge, it swings from 80deg to flat
// while a shade on it lifts. Finite (600 ms) and transform/opacity only, so Playwright's "stable element" wait ends and
// nothing is laid out again; a turn already running is cancelled first (Next row clicked quickly). Reduced motion: none.
// While it turns the card takes no click: its buttons move under the pointer, and a click aimed at one 50 ms into the
// turn landed on Accept and wrote a fix (AH-127). Keys still reach them, so no `inert`.
let turning = null;
export function turnIn(el) {
  if (!el || still() || !el.animate) return;
  for (const a of el.getAnimations({ subtree: true })) a.cancel();
  const turn = (turning = el.animate([{ transform: "perspective(1200px) rotateY(80deg)", opacity: 0 }, { offset: 0.35, opacity: 1 },
    { transform: "perspective(1200px) rotateY(0deg)", opacity: 1 }], { duration: 600, easing: TURN }));
  el.style.pointerEvents = "none";
  // finished or cancelled; a turn cancelled by a newer one leaves the lock to that one
  turn.finished.catch(() => {}).then(() => turning === turn && (el.style.pointerEvents = ""));
  // the shade lives on ::after: without pseudo-element animation it would fade the card itself, so it is left out
  if ("pseudoElement" in KeyframeEffect.prototype) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 600, easing: TURN, pseudoElement: "::after" });
}

// Back to the list: a short fade, no movement (under 400 ms, so the list is there as soon as it is wanted)
export function fadeIn(el) {
  if (!el || still() || !el.animate) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: EASE });
}

export function initMotion() {
  const calm = still();
  initField(document.querySelector(".pane-hero"), calm);
  if (calm) return;
  enter(document.querySelectorAll("header [data-enter]"));
  const main = document.getElementById("main-ui");
  if (!main) return;
  const watch = new MutationObserver(() => {
    if (main.hidden) return;
    watch.disconnect();
    enter(main.querySelectorAll("[data-enter]"));
  });
  watch.observe(main, { attributes: true, attributeFilter: ["hidden"] });
}
