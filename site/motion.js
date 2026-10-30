// The site's motion (AH-72): an entrance on load, then motion tied to the scroll bar. Markup hooks:
//   data-enter="left|bottom"  flies in once on load, in page order, all at rest by 1.3 s
//   data-scrub="left|rise|rule|depth"  moves with the scroll: slides in from the left, rises, draws across (a hairline),
//                                       or drifts at its own rate (data-depth) for layered depth
//   data-band  the dark band, so the field behind the page (field.js) can invert its lines there
// Every scroll pose is a pure function of scrollY and the cached layout, set in a frame that only scroll, resize and
// the entrance ask for: stop scrolling and everything stops where it is; scroll back and it reverses exactly. No
// smoothing toward a target, so no frame loop runs while nothing moves (the idle check in tools/test_site.mjs).
// Time-based parts (the entrance, the field's pointer) are eased by the clock, never per frame: per frame, the old
// cursor light glided for 4.5 s on a busy machine (AH-22).
// AH-73's page transitions call AH.start(root, wait) on the incoming page, or dispatch "ah:page" with { detail: { root, wait } }:
// the entrance then waits that many ms, hidden at its first pose, so the new page's headlines fly in as the curtain opens.
(() => {
  const html = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const DUR = 900, STEP = 90, LAST = 400, SAFETY = 1400; // entrance: 4 * 90 + 900 = 1.26 s, inside the 1.4 s promise
  const subs = [];
  let items = [], scope = document, band = null, raf = 0, t0 = 0, lead = 0, entering = false, safety = 0, observer = null, vw = 0, vh = 0, maxY = 0;

  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const request = () => { if (!raf) raf = requestAnimationFrame(frame); };

  // offsets from the offsetParent chain ignore transforms, so the layout can be read while elements are mid-move
  const place = (el) => { let top = 0, left = 0; for (let e = el; e; e = e.offsetParent) { top += e.offsetTop; left += e.offsetLeft; } return { top, left }; };

  function measure() {
    vw = html.clientWidth; vh = html.clientHeight; maxY = Math.max(0, html.scrollHeight - vh);
    // on a phone the label sits right above its headline: different drift rates would push one into the other
    const deep = vw > 760;
    for (const it of items) {
      const { top, left } = place(it.el), h = it.el.offsetHeight, range = vh * 0.3;
      // left-to-right stagger from the element's own place: a row of four steps in like a sentence
      let s0 = top - vh + (left / vw) * 0.12 * vh, s1 = s0 + range;
      // whatever sits at the end of the page finishes by the last scroll position (the download's logo, AH-71)
      if (s1 > maxY) { s1 = maxY; s0 = s1 - range; }
      it.s0 = s0; it.s1 = s1;
      it.rate = deep && it.depth ? it.depth : 0;
      // the drift is zero where the element is centred (or at the nearest scroll the page allows): at rest on load
      it.ref = Math.min(maxY, Math.max(0, top + h / 2 - vh / 2));
    }
    const b = scope.querySelector("[data-band]"); // the incoming page's, while the outgoing one is still leaving
    band = b ? [place(b).top, place(b).top + b.offsetHeight] : null;
  }

  function apply(it, y, t) {
    let x = 0, dy = 0, o = 1, sx = 1;
    if (it.enter && t < Infinity) {
      const k = clamp((t - it.delay) / DUR);
      if (k < 1) {
        const d = Math.pow(2, -10 * k); // expo out: quick, then a long soft landing
        if (it.enter === "left") x -= 120 * d; else dy += 120 * d;
        o = 1 - Math.pow(1 - clamp(k / 0.5), 2);
      }
    }
    if (it.reveal) {
      const p = y >= it.s1 ? 1 : y <= it.s0 ? 0 : (y - it.s0) / (it.s1 - it.s0);
      if (p < 1) {
        const d = Math.pow(1 - p, 3);
        if (it.reveal === "left") x -= 64 * d; else if (it.reveal === "rise") dy += 64 * d; else sx = 1 - d;
        // readable once mostly in: full opacity by 60% of the way
        if (it.reveal !== "rule") o = Math.min(o, clamp(p / 0.6));
      }
    }
    if (it.rate) dy += it.rate * (y - it.ref);
    const tf = x || dy || sx !== 1 ? `translate3d(${x.toFixed(2)}px, ${dy.toFixed(2)}px, 0)` + (sx !== 1 ? ` scaleX(${sx.toFixed(4)})` : "") : "";
    const op = o < 1 ? o.toFixed(3) : "";
    if (tf !== it.tf) it.el.style.transform = it.tf = tf;
    if (op !== it.op) it.el.style.opacity = it.op = op;
  }

  function frame(now) {
    raf = 0;
    const y = still ? 0 : window.scrollY;
    if (!still) {
      if (entering && !t0) t0 = now;
      const t = entering ? now - t0 : Infinity;
      if (entering && t >= lead + LAST + DUR) finish(); else for (const it of items) apply(it, y, t);
    }
    let more = entering;
    const state = { now, y, vw, vh, band: band && !still ? [band[0] - y, band[1] - y] : null };
    for (const f of subs) more = f(state) === true || more;
    if (more) request();
  }

  function finish() { // the entrance ends here even when frames stall (a background tab gets none)
    entering = false; clearTimeout(safety);
    const y = window.scrollY;
    for (const it of items) apply(it, y, Infinity);
  }

  const relayout = () => { measure(); request(); };

  function start(root = document, wait = 0) {
    stop();
    scope = root;
    lead = still ? 0 : Math.max(0, +wait || 0);
    if (!still) {
      let n = 0;
      items = [...root.querySelectorAll("[data-enter], [data-scrub]")].map((el) => {
        const tokens = (el.dataset.scrub || "").split(/\s+/);
        const it = { el, enter: el.dataset.enter || "", reveal: ["left", "rise", "rule"].find((k) => tokens.includes(k)) || "",
          depth: tokens.includes("depth") ? parseFloat(el.dataset.depth) || 0.06 : 0, tf: null, op: null, delay: 0 };
        if (it.enter) it.delay = lead + Math.min(n++ * STEP, LAST);
        el.style.willChange = "transform, opacity";
        return it;
      });
      measure();
      entering = items.some((it) => it.enter);
      t0 = 0;
      for (const it of items) apply(it, window.scrollY, entering ? 0 : Infinity); // the first pose, before the mark lifts
      if (entering) safety = setTimeout(finish, lead + SAFETY);
      addEventListener("scroll", request, { passive: true });
    } else measure();
    html.removeAttribute("data-ah");
    addEventListener("resize", relayout);
    // a font swap, an opened answer or a tab panel moves everything below it
    if (window.ResizeObserver) { observer = new ResizeObserver(relayout); observer.observe(document.body); }
    request();
  }

  function stop() {
    cancelAnimationFrame(raf); raf = 0; clearTimeout(safety); entering = false;
    removeEventListener("scroll", request); removeEventListener("resize", relayout);
    if (observer) observer.disconnect();
    for (const it of items) { it.el.style.transform = ""; it.el.style.opacity = ""; it.el.style.willChange = ""; }
    items = [];
  }

  window.AH = { start, stop, request, still, onFrame: (f) => { subs.push(f); request(); } };
  document.addEventListener("ah:page", (e) => start((e.detail && e.detail.root) || document, e.detail && e.detail.wait));
  start();
})();
