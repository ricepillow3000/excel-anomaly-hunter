# Motion on the website (AH-83, AH-84, AH-85)

How the site moves, and how to change it. The real code is in `site/styles.css` (tokens and states), `site/boot.js`
(the first mark), `site/motion.js` (entrance, reveal, scroll fallback), `site/field.js` (the background) and
`site/transition.js` (page changes). `tools/test_site.mjs --browser` checks every promise below.

## Rules

1. Only `transform`, `translate` and `opacity` are animated. The GPU composites them without a layout or a paint.
   The static half of `tools/test_site.mjs` fails on any other property in a `transition` or `@keyframes`.
2. One curve: `--ease-out: cubic-bezier(.16, 1, .3, 1)`, a fast start and a long, soft landing. It drives the hero's
   entrance, the reveal, the hairlines, the scan meter, the page curtain, the browser's own page crossfade and the
   field's fade-in. Linear is used once, on purpose: the depth drift of labels and headlines, because a parallax has to
   move in step with the scroll bar.
3. Content moves once, by the clock, when it is seen (an IntersectionObserver, never a scroll listener). Decoration
   moves with the scroll bar, as a pure function of the scroll position: stop and it stops, scroll back and it
   reverses.
4. Nothing is ever hidden without JavaScript, and nothing shows and then vanishes when the scripts arrive.
5. With `prefers-reduced-motion: reduce` nothing moves and nothing is hidden (`document.getAnimations()` is empty).

## The tokens (one source of truth)

```css
:root {
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --enter-dur: 900ms; --enter-step: 90ms; --enter-shift: 120px; /* the hero's entrance */
  --reveal-dur: 700ms;  /* how long an item takes to rise into place */
  --reveal-rise: 24px;  /* the slide distance: how far below its place an item waits (20 to 30 px reads best) */
  --stagger: 50ms;      /* the stagger speed: the gap between items of one group that rise together */
  --stagger-cap: 6;     /* after this many steps, later items start together, so a long list never drags */
}
```

`motion.js` and `transition.js` read these with `getComputedStyle`, so changing a value here changes the CSS and the
JavaScript at once. To make the cascade slower, raise `--stagger` (for example to `80ms`); to make the slide longer,
raise `--reveal-rise` (for example to `30px`).

## The reveal item

### HTML

Mark each block with `class="reveal-item"` and the parent whose children should cascade with `data-reveal-group`.
An item's group is its nearest `data-reveal-group` parent; items with none form one group per page.

```html
<ol class="num-grid" data-reveal-group>
  <li class="reveal-item"><h3>Reconciliation</h3><p>Totals that don't add up.</p></li>
  <li class="reveal-item"><h3>Keying errors</h3><p>A figure typed ten times too large.</p></li>
  <li class="reveal-item"><h3>Consistency</h3><p>The same label typed different ways.</p></li>
</ol>
```

### The first mark (blocking, in `<head>`)

```html
<script src="boot.js"></script>
```

```js
// boot.js: runs before the first paint, so pending items are hidden from the very first frame (no flash)
(() => {
  const html = document.documentElement;
  html.setAttribute("data-js", ""); // stays for the whole visit; the CSS hides items only under it
  // if the reveal script never ran (blocked, failed to load), show everything: never stuck hidden.
  // (the site checks window.AH, which motion.js defines)
  addEventListener("load", () => { if (!window.revealReady) html.removeAttribute("data-js"); });
})();
```

### CSS

```css
@media (prefers-reduced-motion: no-preference) {
  /* waiting: --reveal-rise below its place, see-through, already on its own GPU layer */
  html[data-js] .reveal-item:not([data-revealed]) {
    opacity: 0;
    transform: translate3d(0, var(--reveal-rise), 0);
    will-change: transform, opacity;
  }
  /* seen: rise into place after the item's own delay --d, set by the script */
  html[data-js] .reveal-item[data-revealed] {
    transition: opacity var(--reveal-dur) var(--ease-out) var(--d, 0ms),
                transform var(--reveal-dur) var(--ease-out) var(--d, 0ms);
  }
  /* landed: let the layer go */
  html[data-js] .reveal-item[data-revealed]:not([data-settled]) { will-change: transform, opacity; }
}
@media print { .reveal-item { opacity: 1 !important; transform: none !important; } }
```

Opacity, not `display: none`, so the text is always in the page: Ctrl+F finds it and screen readers read it.

### Vanilla JS

A standalone version of what `site/motion.js` does (the site's copy adds the hero entrance, page transitions and the
scroll fallback).

```js
(() => {
  window.revealReady = true; // tells the first mark's load check that the reveal is running
  const css = getComputedStyle(document.documentElement);
  const ms = (name) => parseFloat(css.getPropertyValue(name)); // the tokens are written in ms: "50ms" reads as 50
  const STAGGER = ms("--stagger");                              // stagger speed: change --stagger in the CSS
  const CAP = parseFloat(css.getPropertyValue("--stagger-cap"));
  const DUR = ms("--reveal-dur");                               // slide distance: change --reveal-rise in the CSS
  const items = [...document.querySelectorAll(".reveal-item")];
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let io = null, tail = null;

  // one batch = the items one look at the screen revealed; they let go of will-change together when the last lands
  // (will-change: transform going back to auto lays the page out once, so once a batch and never mid-reveal)
  function reveal(batch) { // [[element, delay], ...]
    let left = batch.length;
    const settle = () => batch.forEach(([el]) => el.setAttribute("data-settled", ""));
    for (const [el, delay] of batch) {
      for (const o of [io, tail]) if (o) o.unobserve(el); // once: scrolling away and back never hides it again
      el.style.setProperty("--d", delay + "ms");    // the cascade: 0, 50, 100 ... ms
      el.setAttribute("data-revealed", "");
      el.addEventListener("transitionend", function landed(e) {
        if (e.propertyName !== "opacity") return;
        el.removeEventListener("transitionend", landed);
        if (--left === 0) settle();
      });
    }
    setTimeout(settle, Math.max(...batch.map(([, d]) => d)) + DUR + 150); // if a transitionend never comes
  }

  // the items that came into view together, per group, in page order, STAGGER apart, held at the cap
  function cascade(els) {
    const groups = new Map();
    for (const el of els) {
      const g = el.parentElement.closest("[data-reveal-group]") || document;
      groups.set(g, [...(groups.get(g) || []), el]);
    }
    return [...groups.values()].flatMap((g) => g.map((el, i) => [el, Math.min(i, CAP) * STAGGER]));
  }

  // reduced motion or no observer: everything at once (the CSS hides nothing under reduced motion anyway)
  if (still || !("IntersectionObserver" in window)) { reveal(items.map((el) => [el, 0])); return; }
  const look = (entries) => {
    const seen = entries.filter((e) => e.isIntersecting && (e.intersectionRatio >= 0.15 || e.intersectionRect.height >= 0.15 * e.rootBounds.height)).map((e) => e.target);
    const past = entries.filter((e) => !e.isIntersecting && e.boundingClientRect.bottom <= e.rootBounds.top).map((e) => [e.target, 0]);
    if (seen.length || past.length) reveal([...past, ...cascade(seen)]);
  };
  const threshold = [0, 0.05, 0.1, 0.15];
  io = new IntersectionObserver(look, { threshold, rootMargin: "0px 0px -8% 0px" }); // rise once above the bottom 8%
  tail = new IntersectionObserver(look, { threshold }); // the page's last blocks may never get that high
  const end = document.documentElement.scrollHeight - innerHeight * 0.08;
  const top = (el) => el.getBoundingClientRect().top + scrollY; // the waiting pose already includes the rise
  items.forEach((el) => (top(el) + 0.15 * el.offsetHeight > end ? tail : io).observe(el));
})();
```

Items already on screen at load get the observer's first report and rise at once, still staggered. Items above the
screen are shown at once. A jump straight past blocks (an `#anchor`, a restored scroll, the End key) crosses no
threshold, so the observer never reports them: `site/motion.js` shows the ones left above the screen when the scroll
ends (`scrollend`, once a gesture, not a scroll listener), and reveals an `#anchor`'s target, and everything before it,
straight away on load and on `hashchange`, so a jump always lands on something visible. The last blocks of a page,
which may never get above the bottom 8% of the screen, are watched against the whole screen instead.

### What the tests hold it to

At 1440 x 900 (`tools/test_site.mjs`): before scrolling, a check below the fold has opacity 0, `translateY` equal to
`--reveal-rise` and `will-change: transform, opacity`; after it is scrolled into view the 8 checks rest at opacity 1
with no transform, with transition delays 0, 50, 100, 150, 200, 250, 300, 300 ms; once landed `will-change` is `auto`;
the observer has unobserved them and a trip away and back does not hide them; a Chromium trace of the reveal has no
Layout event from the scroll to the last `transitionend`. With JavaScript off, or `motion.js` failing to load, every
block is shown in place. With the deferred scripts 1.6 s late, no block ever goes from visible to hidden.

## Scroll-linked decoration

Two decorations follow the scroll bar: the gold or navy hairline on top of a check or a step (`span.rule`, drawn
across with `scaleX`) and the drift of section labels and headlines (`data-depth`, moved with `translate`, so it never
fights the reveal's `transform` on the same headline). In browsers with scroll timelines, CSS does all of it:

```css
@media (prefers-reduced-motion: no-preference) {
  @supports (animation-timeline: view()) {
    html[data-js]:not([data-scroll="js"]) .rule {
      animation-name: draw; animation-fill-mode: both; animation-timing-function: var(--ease-out);
      animation-timeline: view();
      /* drawn from 10% to 50% of the way through the screen, 4% later for each column (--col): a row draws like a sentence */
      animation-range: cover calc(10% + var(--col, 0) * 4%) cover calc(50% + var(--col, 0) * 4%);
    }
  }
}
@keyframes draw { from { transform: scaleX(0); } to { transform: scaleX(1); } }
/* depth: zero where the element sits mid-screen, linear in the scroll (a parallax) */
@keyframes drift { from { translate: 0 calc(var(--depth) * (-50vh - 50%)); } to { translate: 0 calc(var(--depth) * (50vh + 50%)); } }
```

Where `CSS.supports("animation-timeline: view()")` is false, `motion.js` sets `data-scroll="js"` and plays the same
keyframes itself: one passive scroll listener asks for at most one `requestAnimationFrame`, and that frame poses only
the decorations an IntersectionObserver reports on screen (and half a screen around it), through two custom
properties the CSS turns into transforms:

```css
html[data-scroll="js"] .rule { transform: scaleX(var(--p, 1)); }
html[data-scroll="js"] [data-depth] { translate: 0 var(--drift, 0px); }
```

The fallback uses the timeline's own geometry (view progress inset by the page's `scroll-padding-top`) and the same
cubic-bezier, so its poses match the CSS ones (worst measured difference 0.003 in `scaleX`, 0.03 px in drift). No frame
is requested once the scrolling stops. Content is never scroll-linked. The WebGL field behind the page also follows
the scroll, through the same frame.

## Loading order

1. HTML, `styles.css` and the font (preloaded, `font-display: swap`) block the first paint; `boot.js` is 0.5 KB.
2. The headings and text paint first. The hero's blocks are held for their entrance by `data-ah` and fly in from
   `motion.js` (WAAPI, on the compositor); if the scripts are later than 1.4 s, `boot.js` shows the blocks and the
   entrance is skipped rather than replayed over them.
3. The deferred scripts run in order (`motion.js`, `field.js`, `home.js`, `support.js`, `transition.js`).
4. The WebGL field is the heavy part. It is built after `load`, in `requestIdleCallback` (a 200 ms timer where that is
   missing), so its shader compile never delays the text. On a software renderer (SwiftShader, llvmpipe) it draws one
   still frame at half size and never redraws on scroll: every long task of a scroll used to be a commit waiting on
   that renderer. On a real GPU it stays scroll-linked, with the pointer bend and the dark-band inversion.
5. GitHub Pages gzips the text files; the sources stay readable, with no build step.

## Exceptions, and what is left of the old timing systems

- The page curtain (`transition.js`) clips the two pages with `clip-path`. It is the one animated property that is not
  a transform or an opacity: nothing else can split the screen along a moving edge so that no text is drawn over text.
  It runs for 800 ms on `--ease-out`; the new page's entrance starts when the edge is halfway across (81 ms on that
  curve, computed from the curve), and the old page is removed when all three curtain animations have finished, with a
  timer only as a fallback.
- The field's pointer bend (`field.js`) chases a moving target, so it is an exponential approach with a 220 ms time
  constant by the clock, not a fixed-length curve.
- The old hand-coded expo, cubic and quadratic curves in `motion.js` and the curtain's `cubic-bezier(.77, 0, .18, 1)`
  are gone.
