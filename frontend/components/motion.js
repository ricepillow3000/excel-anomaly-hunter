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
// nothing is laid out again. Reduced motion: none.
// While it turns the card takes no click: its buttons move under the pointer, and a click aimed at one 50 ms into the
// turn landed on Accept and wrote a fix (AH-127). Keys still reach them, so no `inert`.
// AH-149: the hinge sits at the height of the row it came from (y, from the card's top), so the page swings out of what
// was pressed; and a turn started while one runs (Next row pressed quickly) goes on from the angle the card has reached,
// in the time that is left, where it snapped back to 80deg and swung again
const FROM = 80, TURN_MS = 600;
let turning = null;
export function turnIn(el, y = null) {
  if (!el || still() || !el.animate) return;
  let angle = FROM, seen = 0;
  if (turning?.playState === "running" && turning.effect?.target === el) {
    const p = turning.effect.getComputedTiming().progress ?? 0; // eased: the keyframes run straight from 80deg to 0
    angle = FROM * (1 - p);
    seen = Number(getComputedStyle(el).opacity);
  }
  for (const a of el.getAnimations({ subtree: true })) a.cancel();
  if (y !== null) el.style.transformOrigin = `0 ${Math.round(y)}px`;
  const ms = Math.max(120, (TURN_MS * angle) / FROM);
  const turn = (turning = el.animate([{ transform: `perspective(1200px) rotateY(${angle}deg)`, opacity: seen }, { offset: 0.35, opacity: 1 },
    { transform: "perspective(1200px) rotateY(0deg)", opacity: 1 }], { duration: ms, easing: TURN }));
  el.style.pointerEvents = "none";
  // finished or cancelled; a turn cancelled by a newer one leaves the lock to that one
  turn.finished.catch(() => {}).then(() => turning === turn && (el.style.pointerEvents = ""));
  // the shade lives on ::after: without pseudo-element animation it would fade the card itself, so it is left out
  if ("pseudoElement" in KeyframeEffect.prototype) el.animate([{ opacity: angle / FROM }, { opacity: 0 }], { duration: ms, easing: TURN, pseudoElement: "::after" });
}

// A row's head and its card's title are one thing (AH-149): where the browser has view transitions, the head flies to
// the title's place as the card opens, and back on Back. Named only for the transition, so no two elements ever share
// the name; the card's turn and its no-click lock run as before. Reduced motion or no view transitions: update() alone.
// -> once the page shows the new state
export async function morph(from, update, to) {
  if (!from || still() || !document.startViewTransition) return void update();
  from.style.viewTransitionName = "row-title";
  let named = null;
  const vt = document.startViewTransition(() => {
    from.style.viewTransitionName = "";
    update();
    named = to();
    if (named) named.style.viewTransitionName = "row-title";
  });
  vt.ready.catch(() => {}); // skipped (another started, the pane hidden): nothing to wait for
  vt.finished.catch(() => {}).then(() => { from.style.viewTransitionName = ""; if (named) named.style.viewTransitionName = ""; });
  await vt.updateCallbackDone;
}

// The list's rows arrive one after another, 30 ms apart (AH-149, the website's rows): opacity only, so nothing moves and
// a row is where it lands from its first frame; the first at once, the ninth and later together, 450 ms in all
export function stagger(els) {
  if (still()) return;
  [...els].forEach((el, k) => el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 210, delay: Math.min(k, 8) * 30, easing: EASE, fill: "backwards" }));
}

// The summary's flagged numbers count up once (AH-149): 700 ms, ending on the number itself. Each is a .count whose own
// text stays the final number (styles: the count is drawn over it from a counter, ending where it ends, so the words
// after it never move)
export function countUp(el) {
  if (still()) return;
  for (const c of el.querySelectorAll(".count")) {
    const to = Number(c.textContent.replace(/,/g, ""));
    // under 10 it is shown as itself: counting 5 from 0 drew "0 of 300 rows look wrong." above 5 flagged rows (review r1)
    if (!Number.isSafeInteger(to) || to < 10 || !c.animate) continue;
    c.classList.add("counting");
    const run = c.animate([{ "--n": 0 }, { "--n": to }], { duration: 700, easing: EASE, fill: "forwards" });
    run.finished.catch(() => {}).then(() => { c.classList.remove("counting"); run.cancel(); });
  }
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
