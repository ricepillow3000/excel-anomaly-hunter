// The site's motion (AH-72, AH-83, AH-84). Every timing comes from the tokens in styles.css :root (--ease-out, --enter-*,
// --reveal-*, --stagger, --stagger-cap), read here with getComputedStyle: one place to change the feel of the whole
// site. Only transform and opacity ever move, so the browser composites them on the GPU (docs/design/motion.md).
// Markup hooks:
//   data-enter="left|bottom"  the hero's blocks fly in once on load, in page order, all at rest by 1.3 s. WAAPI, so
//                             they run by the clock on the compositor, never per frame (AH-22: the old per-frame
//                             cursor light glided for 4.5 s on a busy machine)
//   class="reveal-item"       content that rises into place once, the first time it scrolls into view (an
//                             IntersectionObserver, never a scroll listener); items of the nearest data-reveal-group
//                             that arrive together start --stagger apart, at most --stagger-cap steps
//   span.rule, data-depth     decoration tied to the scroll bar: a hairline drawn across, a label drifting at its own
//                             rate. styles.css plays them on a scroll timeline (animation-timeline: view()); a browser
//                             without one gets the same pure function of scrollY from the one scroll reader below,
//                             for the decorations on screen only, written through --p and --drift
//   data-band                 the dark band, so the field behind the page (field.js) can invert its lines there
// Nothing smooths toward a target: stop scrolling and everything stops where it is, scroll back and it reverses
// exactly, and no frame is asked for while nothing moves (the idle checks in tools/test_site.mjs).
// AH-73's page transitions dispatch "ah:page" with { detail: { root, wait } }: the new page's entrance and reveals
// wait that many ms, hidden at their first pose, so they start as the curtain's edge passes halfway.
(() => {
  const html = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tokens = getComputedStyle(html);
  const token = (n) => tokens.getPropertyValue(n).trim();
  const ms = (n) => { const v = token(n); return (parseFloat(v) || 0) * (/[^m]s$/.test(v) ? 1000 : 1); };
  const EASE = token("--ease-out") || "cubic-bezier(.16, 1, .3, 1)";
  const ENTER = ms("--enter-dur"), STEP = ms("--enter-step"), SHIFT = parseFloat(token("--enter-shift")) || 0;
  const LAST = 4 * STEP; // the fifth block and later start together: 4 * 90 + 900 = 1.26 s, inside boot.js's 1.4 s
  const REVEAL = ms("--reveal-dur"), STAGGER = ms("--stagger"), CAP = parseFloat(token("--stagger-cap")) || 0, RISE = parseFloat(token("--reveal-rise")) || 0;
  const SEEN = 0.15; // how much of an item must be on screen (above the bottom 8%) before it rises

  // the same curve as CSS's cubic-bezier(): at(x) is the progress at time x, when(y) the time a progress is reached
  const ease = (([x1, y1, x2, y2]) => {
    const b = (s, p1, p2) => 3 * (1 - s) * (1 - s) * s * p1 + 3 * (1 - s) * s * s * p2 + s * s * s;
    const solve = (v, p1, p2) => { let lo = 0, hi = 1; for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (b(m, p1, p2) < v) lo = m; else hi = m; } return (lo + hi) / 2; };
    return { at: (x) => (x <= 0 ? 0 : x >= 1 ? 1 : b(solve(x, x1, x2), y1, y2)), when: (y) => (y <= 0 ? 0 : y >= 1 ? 1 : b(solve(y, y1, y2), x1, x2)) };
  })((/cubic-bezier\(([^)]*)\)/.exec(EASE) || [0, ".16, 1, .3, 1"])[1].split(",").map(Number));

  // a scroll timeline in CSS, or this file plays the decoration (data-scroll="js" switches styles.css over)
  const timelines = !!(window.CSS && CSS.supports && CSS.supports("animation-timeline: view()"));
  html.dataset.scroll = timelines ? "css" : "js";

  const subs = [];
  let scope = document, band = null, raf = 0, observer = null, io = null, tail = null, onScreen = null, later = 0, vw = 0, vh = 0, inset = 0;
  let anims = [], decor = [], waiting = [];

  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const request = () => { if (!raf) raf = requestAnimationFrame(frame); };
  // offsets from the offsetParent chain ignore transforms, so the layout can be read while elements are mid-move
  const place = (el) => { let top = 0; for (let e = el; e; e = e.offsetParent) top += e.offsetTop; return top; };

  function measure() {
    vw = html.clientWidth; vh = html.clientHeight;
    inset = parseFloat(getComputedStyle(html).scrollPaddingTop) || 0; // view()'s default inset is the scroll-padding (the sticky bar)
    for (const it of decor) { it.top = place(it.el); it.h = it.el.offsetHeight; it.col = parseFloat(getComputedStyle(it.el).getPropertyValue("--col")) || 0; }
    const b = scope.querySelector("[data-band]"); // the incoming page's, while the outgoing one is still leaving
    band = b ? [place(b), place(b) + b.offsetHeight] : null;
  }

  // the fallback's pose: styles.css's keyframes as a function of the view() timeline's cover progress v (0 as the
  // element's top meets the bottom of the screen, 1 as its bottom passes under the sticky bar)
  function pose(it, y) {
    const v = (y + vh - it.top) / (vh - inset + it.h);
    if (it.rule) { // drawn across from cover (10 + 4 x col)% to (50 + 4 x col)%: a row of hairlines draws like a sentence
      const a = 0.1 + it.col * 0.04, p = ease.at(clamp((v - a) / 0.4)).toFixed(4);
      if (p !== it.p) it.el.style.setProperty("--p", it.p = p);
    } else { // on a phone the label sits right above its headline: a drift of its own would push one into the other
      const d = (vw > 760 ? it.depth * (vh + it.h) * (clamp(v) - 0.5) : 0).toFixed(2) + "px";
      if (d !== it.p) it.el.style.setProperty("--drift", it.p = d);
    }
  }

  function frame(now) {
    raf = 0;
    const y = still ? 0 : window.scrollY;
    for (const it of decor) if (it.on) pose(it, y);
    let more = false;
    const state = { now, y, vw, vh, band: band && !still ? [band[0] - y, band[1] - y] : null };
    for (const f of subs) more = f(state) === true || more;
    if (more) request();
  }

  // ---- the entrance: the hero's blocks from the left or from below, by the clock ----
  function enter(root, lead) {
    [...root.querySelectorAll("[data-enter]")].forEach((el, n) => {
      const from = el.dataset.enter === "left" ? `translate3d(${-SHIFT}px, 0, 0)` : `translate3d(0, ${SHIFT}px, 0)`;
      anims.push(el.animate([{ transform: from, opacity: 0 }, { transform: "translate3d(0, 0, 0)", opacity: 1 }],
        { duration: ENTER, delay: lead + Math.min(n * STEP, LAST), easing: EASE, fill: "backwards" }));
    });
  }

  // ---- the reveal: content rises into place once, the first time it is seen ----
  // A batch is what one look at the screen revealed. It lets go of will-change all at once, when its last item has
  // landed: will-change: transform going back to auto lays the page out (Chromium), once a batch that way, and never
  // while anything is still rising (tools/test_site.mjs traces it)
  const landing = new WeakMap();
  document.addEventListener("transitionend", (e) => { const f = landing.get(e.target); if (f && e.propertyName === "opacity") { landing.delete(e.target); f(); } });
  function reveal(list) { // [[element, delay in ms], ...]
    const batch = list.filter(([el]) => !el.hasAttribute("data-revealed"));
    if (!batch.length) return;
    let left = batch.length, timer = 0;
    const settle = () => { clearTimeout(timer); for (const [el] of batch) { landing.delete(el); el.setAttribute("data-settled", ""); } };
    for (const [el, delay] of batch) {
      for (const o of [io, tail]) if (o) o.unobserve(el); // once: scrolling away and back never hides it again
      el.style.setProperty("--d", delay + "ms");
      el.setAttribute("data-revealed", "");
      landing.set(el, () => { if (--left === 0) settle(); });
    }
    if (still) settle(); // nothing moves: styles.css never hid it
    else timer = setTimeout(settle, Math.max(...batch.map(([, d]) => d)) + REVEAL + 150); // when a transitionend never comes (a hidden tab)
  }
  // items that come into view together start STAGGER apart, in page order, per group
  function cascade(list) {
    const groups = new Map(), out = [];
    for (const el of list) {
      const g = (el.parentElement && el.parentElement.closest("[data-reveal-group]")) || scope;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(el);
    }
    for (const items of groups.values()) {
      items.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      items.forEach((el, i) => out.push([el, Math.min(i, CAP) * STAGGER]));
    }
    return out;
  }
  function seen(entries) {
    const past = [], now = [];
    for (const e of entries) {
      const r = e.rootBounds;
      // past the screen's top already (a reload further down, an #anchor): there at once, never rising on the way back up
      if (r && !e.isIntersecting && e.boundingClientRect.bottom <= r.top) past.push([e.target, 0]);
      // a block taller than the screen can never be 15% in view: then 15% of the screen will do
      else if (!r || (e.isIntersecting && (e.intersectionRatio >= SEEN || e.intersectionRect.height >= SEEN * r.height))) now.push(e.target);
    }
    reveal([...past, ...cascade(now)]);
  }
  // a jump past blocks (an #anchor, a restored scroll, the End key) crosses no threshold, so the observer never reports
  // them: once a scroll ends, the ones left above the screen are simply there
  function sweep() { reveal(waiting.filter((el) => !el.hasAttribute("data-revealed") && el.getBoundingClientRect().bottom <= 0).map((el) => [el, 0])); }
  // an #anchor reveals its target at once, and what comes before it: a jump must land on something visible
  function anchor() {
    let el = null;
    try { const id = decodeURIComponent(location.hash.slice(1)); el = id ? document.getElementById(id) : null; } catch { el = null; }
    if (!el || !scope.contains(el)) return;
    const own = el.closest(".reveal-item");
    const before = waiting.filter((x) => x !== own && !el.contains(x) && x.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
    reveal([...before.map((x) => [x, 0]), ...cascade([...(own ? [own] : []), ...el.querySelectorAll(".reveal-item:not([data-revealed])")])]);
  }
  function reveals(root, lead) {
    const items = waiting = [...root.querySelectorAll(".reveal-item:not([data-revealed])")];
    if (still || !window.IntersectionObserver) { reveal(items.map((el) => [el, 0])); return; } // no observer: all of it, now
    const begin = () => {
      const threshold = [0, 0.05, 0.1, SEEN], end = html.scrollHeight - html.clientHeight * 0.08;
      io = new IntersectionObserver(seen, { threshold, rootMargin: "0px 0px -8% 0px" });
      // the last blocks of a page may never get above the screen's bottom 8% (an observer sees the waiting, lowered
      // pose): those are watched against the whole screen
      tail = new IntersectionObserver(seen, { threshold });
      for (const el of items) (place(el) + RISE + SEEN * el.offsetHeight > end ? tail : io).observe(el);
      addEventListener("scrollend", sweep);
      anchor();
    };
    if (lead) later = setTimeout(begin, lead); else begin();
  }
  addEventListener("hashchange", anchor);

  // ---- the decoration's fallback: only where CSS has no scroll timeline ----
  function decorate(root) {
    decor = [...root.querySelectorAll(".rule, [data-depth]")].map((el) => ({ el, rule: el.classList.contains("rule"), depth: parseFloat(el.dataset.depth) || 0, on: true, p: null }));
    if (!decor.length) return;
    const byEl = new Map(decor.map((it) => [it.el, it]));
    // the ones on screen (and half a screen around it) are posed each frame; the rest keep their last pose
    onScreen = new IntersectionObserver((es) => { for (const e of es) byEl.get(e.target).on = e.isIntersecting; request(); }, { rootMargin: "50% 0px" });
    for (const it of decor) onScreen.observe(it.el);
  }

  const relayout = () => { measure(); for (const it of decor) it.on = true; request(); };

  function start(root = document, wait = 0) {
    stop();
    scope = root;
    const lead = still ? 0 : Math.max(0, +wait || 0);
    // the entrance plays while boot.js's mark still hides the blocks (or on a page a transition brings in): scripts that
    // came after its 1.4 s timer find the blocks already showing, and they stay put rather than vanish and fly in
    if (!still && (root !== document || html.getAttribute("data-ah") === "enter")) enter(root, lead);
    html.removeAttribute("data-ah");
    reveals(root, lead);
    if (!still && !timelines) decorate(root);
    measure();
    if (!still) addEventListener("scroll", request, { passive: true });
    addEventListener("resize", relayout);
    // a font swap, an opened answer or a tab panel moves everything below it
    if (window.ResizeObserver) { observer = new ResizeObserver(relayout); observer.observe(document.body); }
    request();
  }

  function stop() {
    cancelAnimationFrame(raf); raf = 0; clearTimeout(later);
    removeEventListener("scroll", request); removeEventListener("resize", relayout); removeEventListener("scrollend", sweep);
    for (const o of [observer, io, tail, onScreen]) if (o) o.disconnect();
    observer = io = tail = onScreen = null;
    for (const a of anims) a.cancel();
    anims = []; decor = []; waiting = [];
  }

  window.AH = { start, stop, request, still, ease, onFrame: (f) => { subs.push(f); request(); } };
  document.addEventListener("ah:page", (e) => start((e.detail && e.detail.root) || document, e.detail && e.detail.wait));
  start();
})();
