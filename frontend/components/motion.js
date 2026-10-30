// The pane's entrance, in the website's motion (AH-72, motion.js there): marked blocks fly in once, the brand and labels
// from the left (data-enter="left"), the Scan button and the slider from below (data-enter="bottom"), staggered in
// page order and all at rest within 1 s. The header moves when the pane opens; the rest when the main view first
// appears (after the engine answers), so nothing waits for it: e2e/launch.mjs wants the pane ready in under 2 s.
// Eased by the clock (performance.now), never per frame: the old pane light moved 8% a frame and took as long as the
// machine was slow (AH-22). Reduced motion: no entrance at all.
import { initField } from "./field.js";

const DUR = 620, STEP = 70, MAX_DELAY = 360; // the last block starts by 360 ms and lands by 980 ms
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

export function initMotion() {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  initField(document.querySelector(".pane-hero"), still);
  if (still) return;
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
