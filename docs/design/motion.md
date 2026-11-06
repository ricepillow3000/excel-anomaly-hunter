# Motion on the website (AH-83, AH-84, AH-85, AH-89 to AH-93, AH-138)

How the site moves, and how to change it. The real code is in `site/styles.css` (tokens and states), `site/boot.js`
(the first mark), `site/motion.js` (entrance, reveal, glide, the wheel's catch-up, scroll fallback), `site/home.js` (the
sample sheet's skeleton, page turn, detail box, tab mark, the download's skeleton and the Copy button), `site/field.js`
(the background) and `site/transition.js` (page changes and the phone's menu). `tools/test_site.mjs --browser` checks every promise below.

## Rules

1. Only `transform`, `translate` and `opacity` are animated. The GPU composites them without a layout or a paint.
   The static half of `tools/test_site.mjs` fails on any other property in a `transition` or `@keyframes` (the Copy
   button's icon blur is the one exception, below).
2. Two curves. `--ease-out: cubic-bezier(.16, 1, .3, 1)`, a fast start and a long, soft landing, drives everything that
   arrives: the bar's and the hero's entrance, the reveal, the card lift, the hairlines, the scan meter, the filters'
   fill, the raised cell, the page curtain, the browser's own page crossfade and the field's fade-in.
   `--ease-in-out: cubic-bezier(.65, 0, .35, 1)`, soft at both ends, drives what starts from rest and must not jerk:
   the glide, the page turn, the skeleton's band of light and the tab mark's slide. Linear is used once, on purpose: the
   depth drift of labels and headlines, because a parallax has to move in step with the scroll bar. No curve overshoots:
   every `cubic-bezier` keeps both control points' y within [0, 1] (no spring, no bounce; a static test holds it).
3. Content moves once, by the clock, when it is seen (an IntersectionObserver, never a scroll listener). Decoration
   moves with the scroll bar, as a pure function of the scroll position: stop and it stops, scroll back and it
   reverses.
4. Nothing is ever hidden without JavaScript, and nothing shows and then vanishes when the scripts arrive.
5. With `prefers-reduced-motion: reduce` nothing moves and nothing is hidden (`document.getAnimations()` is empty).

## The tokens (one source of truth)

```css
:root {
  --ease-out: cubic-bezier(.16, 1, .3, 1);
  --ease-in-out: cubic-bezier(.65, 0, .35, 1); /* the glide, the page turn, the skeleton's light */
  --enter-dur: 1400ms; --enter-step: 160ms; --enter-shift: 120px; /* the hero's entrance */
  --enter-bar-step: 75ms; --enter-lead: 120ms; /* the bar's blocks start 75 ms apart, the hero 120 ms after them (350 ms
     put a slow phone's headline past its 2.5 s budget) */
  --reveal-dur: 1100ms; /* how long an item takes to rise into place */
  --reveal-rise: 24px;  /* the slide distance: how far below its place an item waits (20 to 30 px reads best) */
  --stagger: 90ms;      /* the stagger speed: the gap between items of one group that rise together */
  --stagger-cap: 6;     /* after this many steps, later items start together, so a long list never drags */
  --lift-dur: 1200ms; --ease-lift: cubic-bezier(.33, 1, .68, 1); /* the checks' heading turned face up */
  --skeleton-dur: 1300ms; --land-step: 30ms; --land-fade: 280ms; /* the sample sheet loading (rows land 30 ms apart) */
  --turn-dur: 700ms; --fill-dur: 350ms; --podium-dur: 250ms; /* page turn, filter and button fill, raised cell */
  /* AH-138 */
  --stagger-row: 30ms;   /* list rows: a table's rows, a list's items, a ledger's cells (data-reveal-group="rows") */
  --press: .97; --press-dur: 120ms;       /* a press settles to 97% */
  --pop-in: 200ms; --pop-out: 160ms; --pop-from: .95; /* a popover: in from .95 at its trigger, out 20% faster */
  --slide-dur: 300ms; --stretch: 1.12;    /* the tab mark's slide, 12% wider at its half way */
  --scroll-weight: 150ms;                 /* the wheel's catch-up time constant */
  --pulse-dur: 600ms;                     /* a success's ring, once */
}
```

`motion.js`, `home.js` and `transition.js` read these with `getComputedStyle`, so changing a value here changes the CSS
and the JavaScript at once, and `tools/test_site.mjs` reads the same lines from `styles.css` for its time bounds. To make
the cascade slower, raise `--stagger` (for example to `120ms`); to make the slide longer, raise `--reveal-rise` (for
example to `30px`).

Why these values: John, 2026-11-02, "when loading into the website, the transition feels very fast, which seems like
I'm rushing the user" and "the transitions for all the titles, descriptions, and buttons are not too fast". The
entrance went from 900 to 1400 ms with steps of 160 ms (was 90), the reveal from 700 to 1100 ms and the stagger from 50
to 90 ms (AH-90). The last hero block now starts at 350 + 3 x 160 = 830 ms and rests by 2.23 s.

## The first load: the bar, then the hero (AH-90)

John, 2026-11-02: "the Anomaly Hunter title slides in from the left, and the products, checks, privacy and security,
support and download slide in from the right... the very top where it says free for Windows... slides in from the left
side." On the first load only (`data-ah="enter"`), `motion.js` flies in, `--enter-bar-step` apart: the notice line's
text and the brand from the left, then the five links from the right, leftmost first (rightmost first ran a waiting link over its settled neighbour); the hero's blocks follow
`--enter-lead` later, in page order, `--enter-step` apart. Each is a WAAPI animation of `--enter-dur` on `--ease-out`,
from `--enter-shift` away and see-through. The bar clips its own overflow (`overflow-x: clip`), so a link sliding in
from past the edge never makes the page scroll sideways. The bar stays mounted across page changes, so it never plays
again; its links stay plain links that land at once.

## The reveal item

### HTML

Mark each block with `class="reveal-item"` and the parent whose children should cascade with `data-reveal-group`.
An item's group is its nearest `data-reveal-group` parent; items with none form one group per page. A group of list
rows (a table's rows, a list's items, a ledger's cells) is `data-reveal-group="rows"` and steps `--stagger-row` (30 ms)
apart; headings, ledes and blocks keep `--stagger` (90 ms) (AH-138). On the home page: the checks table's `tbody`, the
proof figures, both IT ledgers and the install steps' `ol`; on support.html the questions; on privacy.html and
terms.html the contents lists.

```html
<!-- the checks table (AH-98): each row rises in its turn; a table row can be a reveal item, and its .rule hairline is
     placed against the row (position: relative on the tr) -->
<table class="checks-table">
  <tbody data-reveal-group="rows">
    <tr class="reveal-item"><th scope="row"><span class="rule" aria-hidden="true"></span>Reconciliation</th><td>Totals that don't add up.</td></tr>
    <tr class="reveal-item"><th scope="row"><span class="rule" aria-hidden="true"></span>Keying errors</th><td>A figure typed ten times too large.</td></tr>
  </tbody>
</table>
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
  const ms = (name) => parseFloat(css.getPropertyValue(name)); // the tokens are written in ms: "90ms" reads as 90
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
      el.style.setProperty("--d", delay + "ms");    // the cascade: 0, 90, 180 ... ms
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

A reveal item inside a block that is still waiting for its entrance (support.html's answers and form fields) starts
rising when that block is a quarter of the way in, never unseen inside a block that is still see-through. The footer's
items reveal like the rest; `transition.js` keeps their reveal when it updates the footer for a new page.

### The card lift (AH-91)

John, 2026-11-02: the checks' heading "has that premium animation... as if it was face down and then it is being
lifted up like a deck of cards". A `.reveal-item.lift` waits as `perspective(900px) rotateX(-95deg)` hinged on its
bottom edge (`transform-origin: 50% 100%`, `backface-visibility: hidden`: tipped just past flat, its back never shows)
and turns up to face the reader over `--lift-dur` on `--ease-lift` (a cubic ease-out: on `--ease-out` 80% of the turn
happened in the first 300 ms and read as a snap), through the same IntersectionObserver as every
reveal, so it plays when the glide brings it into view. It moves `transform` only: the `data-depth` drift keeps the
`translate` property. In perspective the waiting heading reaches past the screen's edge, so the dark band clips its
own sideways overflow.

### What the tests hold it to

At 1440 x 900 (`tools/test_site.mjs`): before scrolling, a row of the checks table below the fold has opacity 0,
`translateY` equal to `--reveal-rise` and `will-change: transform, opacity`; after it is scrolled into view the table's 8
rows (all 8 on one screen: rows padded 16 and 20 px, AH-98) rest at opacity 1
with no transform, with transition delays 0, 30, 60, 90, 120, 150, 180, 180 ms (list rows, AH-138; the headline, fact
and lede above them 0, 90, 180); once landed `will-change` is `auto`;
the observer has unobserved them and a trip away and back does not hide them; a Chromium trace of the reveal has no
Layout event from the scroll to the last `transitionend`. With JavaScript off, or `motion.js` failing to load, every
block is shown in place. With the deferred scripts 1.6 s late, no block ever goes from visible to hidden.

The rest of the promises, all in `tools/test_site.mjs --browser`:

- Entrance: 60 ms after load the hero's headline is left of its place and the sheet below it, the notice line and the
  brand left, the five links right; everything at rest by `--enter-lead` + 4 x `--enter-step` + `--enter-dur` + 150 ms
  (2.54 s), also at 20 frames a second; the bar's entrance never replays on a page change.
- Skeleton: below the fold the sheet waits with bars inside their cells and no light moving; framed on screen it plays
  one sweep, and the attribute is gone 1.3 to 2.4 s later with every value coloured again; CLS 0; a press ends it at
  once; none under reduced motion or on a visit back. Scrolled by hand to 30% in view it still waits, at 70% it plays;
  after "See a sample scan" it is still waiting when the glide arrives and is gone 1.2 to 2.6 s after.
- Download: with GitHub's answer 1.2 s away, the list shows its bars (the exact fallback markup still inside `#sha`
  and `#rel`) until the answer, good or a 403; an instant answer still shows them for 650 to 1200 ms; none on a visit
  back.
- Glide: at 1440 x 900 and 1280 x 900, 300 ms after the click the scroll is strictly between start and end; it arrives
  in 1.5 to 3 s with the sheet and its button centred below the bar and the checks below the fold, focus on the sheet,
  and no frame asked for afterwards; on to the checks in 2.3 to 3.7 s, the heading seen part-turned on the way and at
  rest after; a wheel ends a glide; with reduced motion the link jumps.
- Filters: the pressed filter is filled, a hovered one's fill is seen part-way and then whole; a click leaves exactly
  one `aria-hidden`, `inert` copy with no ids, turning at 300 ms and gone within a second, while the real rows already
  show the new filter and the real panel has no transform; none under reduced motion.
- Podium: at 1440 and 390 px every coloured cell, hovered, is scaled 1.05 to 1.2, raised, under the pointer, inside its
  scrolling frame, its shadow at opacity 1.

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
/* depth: zero where the element sits mid-screen, linear in the scroll (a parallax); --depth is .03, since at .05 a
   two-line headline near the top of the screen came 26 px down onto the lede under it (AH-132) */
@keyframes drift { from { translate: 0 calc(var(--depth) * (-50vh - 50%)); } to { translate: 0 calc(var(--depth) * (50vh + 50%)); } }
```

Where `CSS.supports("animation-timeline: view()")` is false, `motion.js` sets `data-scroll="js"` and plays the same
keyframes itself: one passive scroll listener asks for at most one `requestAnimationFrame`, and that frame poses every
decoration (a few sums each, written only when a pose changes, so those held at an end of their range cost nothing),
through two custom properties the CSS turns into transforms. It posed only those an IntersectionObserver reported near
the screen, but an observer sees an element where its own drift has moved it, and the IT headline kept a far-end pose
after a trip to the page's end and back (AH-98):

```css
html[data-scroll="js"] .rule { transform: scaleX(var(--p, 1)); }
html[data-scroll="js"] [data-depth] { translate: 0 var(--drift, 0px); }
```

The fallback uses the timeline's own geometry (view progress inset by the page's `scroll-padding-top`) and the same
cubic-bezier, so its poses match the CSS ones (worst measured difference 0.003 in `scaleX`, 0.03 px in drift). No frame
is requested once the scrolling stops. Content is never scroll-linked. The WebGL field behind the page also follows
the scroll, through the same frame. It moves at full strength in the hero and on the navy band; under the prose, lists
and tables of the other sections it fades out on a still layer of plain paper (`.calm::before`, z-index -1 in its wrap,
96 px past the block above and below, and sideways as far as the screen allows up to 96 px, masked to nothing over that
reach; 32 px left pale rectangles with straight edges, AH-138 review), so no contour line crosses body text (AH-98). That layer
never moves or redraws, and works the same on a software renderer, where the field is one still picture.

## The sample sheet (AH-89, AH-92)

**The skeleton.** John, 2026-11-02: "a skeleton loader... perfectly aligns with the geometric shapes in design
placements of our website... Do not make it too long, but also don't make it too short, but make it very noticeable."
The skeleton is the real table, so it is aligned by construction. While `#preview[data-loading]`, every value keeps its
place with no colour (`color: transparent`, never a layout change) and an `::after` bar sits over the exact box of its
text (measured by `home.js` into `--sk-x/y/w/h`): each cell, each count and each key line. CLS stays 0. It waits until
the sheet is 60% on screen, or covers 60% of a screen it is taller than (a phone), read from the layout each time an
IntersectionObserver reports a step; if the sheet is entering, until its entrance is a third of the way. While a glide
runs it waits for the glide to end (AH-99, John 2026-11-02: at 30% it played on the way down and had mostly finished
by the time the visitor arrived): `motion.js` sends `ah:glide-start` and `ah:glide-end` on `document` and answers
`AH.gliding()`, and the end, on arrival or cut short by a wheel, asks the same question again. Then one band of light (an `::after` moved by `transform` in the `sweep` keyframes, which exist only while it
plays) crosses it in `--skeleton-dur`, and the rows land `--land-step` apart: a row's bars fade over `--land-fade` as it
settles its last 5 px. About 2.2 s in all, once a visit. A press anywhere on the sheet ends it at once. Never over
values someone may already have seen (late scripts, a visit back), never with reduced motion or without `motion.js`.

**The download's facts.** While GitHub's answer is really on its way (not kept from earlier in the visit), the list
`dl.anchor` gets `data-loading`: bars over the SHA-256 and the release line, a band of light crossing the list. Never
inside `#sha` or `#rel`, whose markup is all the answer may change. At least 700 ms, so it never flashes; at most 6 s,
then the page's own defaults stay.

**The filters' fill.** John: "when I hover over it, it turns to navy blue but not instantly... fills up blue from the
left side to the right side at a relatively fast pace". A colour can't move on the GPU, so the fill is a `::before`
growing by `scaleX` from the left over `--fill-dur`. It lies over the label in `mix-blend-mode: difference`: `#E3D3AC`
less the paper (`#EFECE4`) is the navy `#0C1938` exactly, and less the navy text it is a light gold, so the label reads
at every frame, half on paper and half on navy. The pressed filter stays filled. The tabs get the same sweep as a gold
line under them on hover; the chosen tab's line is one shared mark that slides from tab to tab (AH-138, below).

**The page turn.** John: "when I click it... on the right side of the sample sheet... it is being turned like a page".
A copy of the visible panel (ids stripped, `aria-hidden`, `inert`, each row's opacity frozen as it was) is laid over
it; the real panel takes the new state at once (the tests read the dimmed rows straight after a click, and the detail
box is placed from the real rows, so the real panel never moves); the copy turns away, `rotateY(0)` to `-100deg` around
its left edge in `perspective(2400px)` over `--turn-dur` on `--ease-in-out`, a shade deepening on it, clipped to the
sheet, and is removed when it is gone, at the next click, or when the page leaves.

**The podium.** John: "when I hover over the highlighted data... it enlarges up, not too much, but at a fairly
noticeable size... like stepping up to a podium". A coloured cell steps up 3 px and grows 13% over its neighbours in
`--podium-dur`; a shadow layer under it fades in (its `opacity`; the `box-shadow` itself never moves).

## The glide (AH-91)

John, 2026-11-02: "When pressing the See sample button... it seems like I'm being teleported... I want it to very
leisurely and smoothly scroll me down automatically to the sample page... I only want it to scroll to see the sales
spreadsheet", and a button under it that goes on to the checks, "slow enough where you can see everything unfold".
`a[data-glide]` links scroll with one `requestAnimationFrame` loop that runs for the glide only, by the clock, on
`--ease-in-out`: `data-glide="frame"` centres the sheet and the "See every check" button under it in the room below the
sticky bar, with the checks still below the fold (1.6 to 2.4 s by distance; on a phone, where it cannot fit, the
sheet's top goes to the top); `data-glide="top"` puts the checks' section just under the bar (2.4 to 3.2 s). A wheel, a
touch, a key or a press ends it where it is. The checks table's "Row 22" links are `data-glide="frame"` too: they frame
the sample's own row (AH-98). Each glide sends `ah:glide-start` and `ah:glide-end` (detail `{ target,
arrived }`) on `document`, and `AH.gliding()` is true while one runs: the sheet's skeleton waits for it. On arrival the target takes focus without scrolling and the address gets
its `#hash` through `history.pushState`, never `location.hash`, which would fire the anchor rule above and show every
item at once. With reduced motion the link jumps as any anchor does; without JavaScript it is a plain anchor. The bar's
and the notice line's links are not glides: they still land at once.

## Loading order

1. HTML, `styles.css` and the font (preloaded, `font-display: swap`) block the first paint; `boot.js` is 0.5 KB.
2. The headings and text paint first. The bar's and the hero's blocks are held for their entrance by `data-ah` and
   fly in from `motion.js` (WAAPI, on the compositor); if the scripts are later than 1.4 s, `boot.js` shows the blocks
   and the entrance is skipped rather than replayed over them. The 1.4 s is a deadline for the entrance's start; the
   entrance itself rests by about 2.2 s.
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
- The glide and the wheel's catch-up are the `requestAnimationFrame` loops outside the scroll reader and the field: a
  scroll position cannot be animated by CSS or WAAPI. Each asks for frames only while it runs.
- The Copy button's two icons crossfade with a blur (`filter`, AH-138): the static test allows `filter` only in a rule
  whose every selector is a `.copy-btn`'s `.ico`, and in no other transition and no keyframes. Two 16 px icons, for 200 ms.
- The field's pointer bend (`field.js`) chases a moving target, so it is an exponential approach with a 220 ms time
  constant by the clock, not a fixed-length curve.
- The old hand-coded expo, cubic and quadratic curves in `motion.js` and the curtain's `cubic-bezier(.77, 0, .18, 1)`
  are gone.

## AH-138: John's motion list (2026-11-06)

John: "ease-out for entrances; dropdowns 150-250 ms; list rows stagger 30 ms; buttons scale to 0.97 on press; a moving
knob stretches 12%; stagger when details settle; arcs for object movement; a pulse confirms success; ease-in-out for
on-screen movement; popovers start at scale 0.95, come in from their trigger and go out to it; no spring or bounce;
never tween what the hand drives; exits about 20% shorter than entrances; the new state comes in as the old leaves;
masks for reveals and colour changes; icons crossfade with scale and blur; rubber band past drag limits; one shared
element reused across shared objects; and a heavy wheel scroll". Nothing of it plays under `prefers-reduced-motion`.

| Rule | Where it lives on the site |
|---|---|
| Ease-out for entrances | `--ease-out` on every arrival: the entrance, the reveal, the popovers, the press, the fills, the pulse |
| Ease-in-out on screen | `--ease-in-out` on what moves across the screen from rest: the glide, the page turn, the tab mark |
| Dropdowns 150 to 250 ms | `--pop-in` 200 ms: the phone's menu and a row's detail box (the menu took 350 ms before) |
| Exits 20% shorter | `--pop-out` 160 ms (0.8 of `--pop-in`); the button fill goes back in 0.8 of `--fill-dur`; the Copy icons return over `--pop-out` |
| Popovers from their trigger, from 0.95 | the menu grows from the Menu button's centre (`--menu-x`, set by `transition.js`) and shrinks back there while `data-closing` keeps it drawn and inert; the detail box grows from its row's button's centre and a copy of it (no ids, `aria-hidden`, `inert`) shrinks back there while the box itself is already hidden |
| Stagger when details settle | the detail box's head and each line of its details settle 4 px up, `--stagger-row` apart |
| List rows stagger 30 ms | `data-reveal-group="rows"` steps `--stagger-row`; the skeleton's rows land `--land-step` (30 ms) apart |
| Buttons scale to 0.97 | every element with a pressed look settles to `--press` over `--press-dur`, the gold line kept in every mode |
| Masks for colour changes | a button's hover colour is a layer drawn across by `scaleX` from the left (the main button's navy under its label, the outlined buttons' difference fill over theirs, as the filters'); the hairlines and fills already draw by `scaleX` from an edge |
| Masks for reveals | the hairlines (`span.rule`) and the filters' and tabs' lines draw from an edge by `scaleX`; the page curtain is a moving clip |
| The new state comes in as the old leaves | the page turn (the old panel's copy turns away over the new one), the detail box (its copy leaves as the real box is gone), the curtain |
| One shared element | the tabs' gold line is one `span.tab-mark`, the same node for every tab, posed by `translate` and `scaleX` |
| A moving knob stretches 12% | the tab mark, half way between two tabs, is the two widths' average times `--stretch` |
| Arcs for object movement | only where something travels in two directions: the tab mark between tabs on two lines (text at 200%), lifted a fifth of the rise at its half way. Nothing else on the site moves along two axes at once |
| A pulse confirms success | the Copy button's gold ring, once, `--pulse-dur`; the forms' result box, a ring a few pixels out each time it appears (CSS alone: an element that starts being drawn starts its animation) |
| Icons crossfade with scale and blur | the Copy button's copy icon and check (opacity, scale .6, blur 4 px) |
| No spring, no bounce | every `cubic-bezier` keeps y1 and y2 within [0, 1] (static test); the wheel's catch-up is an exponential approach that never passes its target |
| A heavy wheel | below |
| Never tween what the hand drives | touch and pen scroll the page 1:1 (the wheel's catch-up is for a fine pointer that hovers only); there is no drag on the site |
| Rubber band past drag limits | there is no drag on the site, and a finger's scroll is the browser's own, with its own overscroll at the ends |

### The heavy wheel

A mouse wheel moves a target (a notch's `deltaY`, lines times 16 px, pages times the screen) and the page eases after it
by the clock: each frame `y += (target - y) (1 - e^(-dt / --scroll-weight))`, `dt` capped at 64 ms, so it is slightly
behind, fluid, and never passes the target. Within half a pixel it lands and asks for no more frames. `motion.js` does it
only where `(hover: hover) and (pointer: fine)` matches and never under reduced motion; it leaves the wheel to the
browser for a zoom (Ctrl, Cmd), a sideways or Shift wheel, a wheel over a field (`textarea`, `select`, `input`,
`contenteditable`) or over any box that can still scroll that way, and on a page too short to scroll. A key, a press, a
touch, a glide, a page change, or a scroll it did not make (the scrollbar, find, an anchor; more than 2 px from where it
put the page) ends it where it is. The wheel that ends a glide only ends it: it scrolls nothing. `AH.smoothing()` is true
while it catches up. Decoration stays a pure function of `scrollY`: it follows the page wherever the page is.

What the tests hold it to (`tools/test_site.mjs`, the AH-138 block): 400 px of wheel from rest is on its way 50 ms later,
rises every frame, never passes its target, arrives within 1.5 s, and no frame is asked for in the second after; PageDown
ends it; with reduced motion, and on a touch phone, the wheel scrolls the browser's way; over the support form's full
message box the box scrolls and the page does not. The same block holds the press (0.97 held, 1 let go, the line in
every mode), the main button's fill (seen part way, then whole; no layer under reduced motion), the menu and the detail
box (from .95 at their trigger, out in 0.8 of the time, drawn while leaving, then gone), the tab mark (one node, 250 to
350 ms, its widest at the average times 1.12, at rest under the chosen tab; none moving under reduced motion), the
Copy button (hidden without a script; it copies the line, crossfades with a blur, pulses once and says Copy again 2 s
later; refused, it selects the line and says to press Ctrl+C) and a group of blocks still 90 ms apart.

### Fix round 1 (a blind design review, 2026-11-06)

- The page turn's copy is a still picture: `[data-turn] * { animation: none !important }`, and `turn()` writes each scan
  meter's pose and each cell's marks onto the copy, so the bar no longer refills under "100%" while the page turns.
- The phone's menu lies over the page under the bar (`position: absolute` in the bar's wrap, the bar's own paper and a
  hairline under it): opening it moves nothing below, and "Checks" lands on the checks.
- A detail box carries a still shadow (`box-shadow`, never animated), so it reads as lying over the sheet.
- An answer that opens (`<details>`: the questions, "Want to check the file first?") settles its blocks 6 px up and in,
  `--stagger-row` apart, over `--pop-in` (`motion.js`, on `toggle`); closing is at once; none under reduced motion.
- The main button's navy covers its 2 px border too; a filter clears the other rows' marks; the Copy label keeps the
  width of "Copied"; a tap shows no browser highlight over the gold pressed line.

### Fix round 2 (a second blind design review, 2026-11-06)

- The phone's menu closes as a popover does: on a press outside it and its button, and once the page has scrolled more
  than 8 px from where it opened, each time through the same exit. Its links are 44 px targets, and the open sheet has a
  still shadow.
- Not taken: the review asked a page change by a link to open at the very top with the notice line shown. The header
  stays mounted over the curtain, so it dropped 36 px at the swap; the first review praised that it stays put, so a page
  change keeps the header where it was (S4 holds that, from the bottom, from 400 px and from 10 px).
- The page turn's copy grows to a taller new panel's height, so After fixes' lower rows stay under it until it passes.
- The phone's download bar also hides while the contact form is on screen or focus is in a form.
- The notice line balances its two lines on a phone, so "Download" is never alone; at 1280 x 720 the hero starts higher,
  its buttons and note 8 px or more inside the screen.

