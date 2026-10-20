// The pane's top light, as on the website: a faint navy glow under the pointer and a gold one (with its soft ripples)
// following a moment later, like a lamp being carried. Mouse only, and not when motion is turned down.
export function initAmbient(el) {
  if (!el || !matchMedia("(hover: hover) and (pointer: fine)").matches || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let tx = 50, ty = 30, gx = tx, gy = ty, raf = 0;
  const step = () => {
    gx += (tx - gx) * 0.08; gy += (ty - gy) * 0.08;
    el.style.setProperty("--hx", gx + "%"); el.style.setProperty("--hy", gy + "%");
    raf = Math.abs(tx - gx) + Math.abs(ty - gy) > 0.05 ? requestAnimationFrame(step) : 0;
  };
  el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 100; ty = ((e.clientY - r.top) / r.height) * 100;
    el.style.setProperty("--gx", tx + "%"); el.style.setProperty("--gy", ty + "%");
    if (!raf) raf = requestAnimationFrame(step);
  });
}
