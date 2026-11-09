// Page transitions (AH-73, John 2026-10-30): the three pages feel like one canvas. A click on a link to another of them
// fetches that page (already fetched on hover, focus or touch), and only its <main id="page"> is swapped: the notice
// bar, the header, the field behind (field.js) and the footer stay mounted, and get the new page's links and current
// state. The two pages share the screen side by side, split by one moving vertical edge drawn as a 2px gold line: the
// new page is uncovered from the right as the old one is covered from the left, each clipped to its side of the edge,
// so text is never drawn over text. The old page drifts left and dims a little, the new one settles from the right, all
// by the clock (WAAPI, 800 ms, on the site's --ease-out); the new page's own entrance starts as the edge passes halfway,
// through motion.js ("ah:page"). The clip-path that keeps the two pages apart is the one property here that is not a
// transform or an opacity: no other can split the screen along a moving edge (docs/design/motion.md). The document
// never unloads, so there is no white frame between pages. Back and Forward run the same transition the other way and
// return to the scroll position kept in history.state. Anything that is not a plain click on one of the three pages (a
// modifier key, a new tab, a download, another site, a #hash on this page) is left to the browser; a page that does
// not come back whole is opened the ordinary way, and a link to the page already shown takes the reader to its top
// (AH-132). With reduced motion the page is swapped in one step. Page scripts
// set themselves up on "ah:page" and let go on "ah:leave" (home.js, support.js).
(() => {
  const html = document.documentElement;
  const PAGES = ["index.html", "privacy.html", "support.html", "terms.html", "thanks.html"];
  // A crossfade drew both headlines half-opaque in one place at 300 ms, a smudge that read as a glitch (AH-73 review,
  // 1440 x 900 screenshots, 2026-10-30). A curtain keeps both pages moving at once with never a pixel of one over the
  // other: one edge, and the drift and dim on the same curve so the clips stay true to the edge in every frame. The
  // curve is the site's own --ease-out (AH-83): a fast start and a long landing, like every other motion here. The new
  // page's entrance starts when the edge is halfway across (81 ms on that curve), read from the curve itself: started
  // later than the edge, the right of the screen showed an empty page (AH-73, 450 ms)
  const EASE = getComputedStyle(html).getPropertyValue("--ease-out").trim() || "cubic-bezier(.16, 1, .3, 1)";
  const DUR = 800, DRIFT = 0.06, DIM = 0.6, HALF = window.AH && window.AH.ease ? Math.round(DUR * window.AH.ease.when(0.5)) : 80;
  const dir = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
  const pageOf = (u) => {
    if (u.origin !== location.origin) return null;
    const d = u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1), f = u.pathname.slice(d.length) || "index.html";
    return d === dir && PAGES.includes(f) ? f : null;
  };
  let current = pageOf(location), index = 0, seq = 0, run = null;
  if (!current || !document.getElementById("page") || !window.fetch || !window.DOMParser) return;

  // Where each history entry was scrolled to lives in its state; the browser's own restoration would move the old
  // page before it leaves. A reload (or a return from another site) still comes back to its place.
  const st = history.state;
  if (st && st.ah === 1 && Number.isInteger(st.i)) {
    index = st.i;
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav && nav.type !== "navigate" && typeof st.y === "number" && !location.hash) addEventListener("load", () => scrollTo(0, st.y), { once: true });
  } else history.replaceState({ ah: 1, i: 0, y: Math.round(scrollY) }, "");
  history.scrollRestoration = "manual";
  addEventListener("pagehide", () => { history.scrollRestoration = "auto"; });
  addEventListener("pageshow", (e) => { if (e.persisted) history.scrollRestoration = "manual"; });
  const save = () => history.replaceState({ ah: 1, i: index, y: Math.round(scrollY) }, "");

  // each page fetched once a visit; a failed fetch is forgotten so the click after it can try again
  const cache = new Map();
  function load(u) {
    const key = u.href.split("#")[0];
    if (!cache.has(key)) {
      const got = fetch(key, { credentials: "same-origin" })
        .then((r) => (r.ok && /^text\/html/.test(r.headers.get("content-type") || "") ? r.text() : Promise.reject(r.status)))
        .then((text) => new DOMParser().parseFromString(text, "text/html"));
      got.catch(() => cache.delete(key));
      cache.set(key, got);
    }
    return cache.get(key).catch(() => null);
  }

  const linkOf = (el) => (el && el.closest ? el.closest("a[href]") : null);
  function target(a) {
    if (!a || a.hasAttribute("download") || (a.target && a.target !== "_self")) return null;
    const u = new URL(a.getAttribute("href"), location.href), p = pageOf(u);
    return p && p !== current ? u : null; // this page's own #hash links and reloads behave as always
  }
  // a link to the page already shown, with no #hash ("Privacy & security" on privacy.html): the browser reloaded the
  // document for it, a white frame, the entrance again and the scroll and the page's state gone, about four times in ten
  // quick clicks (AH-132). It goes back to the page's top instead
  function here(a) {
    if (a.hasAttribute("download") || (a.target && a.target !== "_self")) return false;
    const u = new URL(a.getAttribute("href"), location.href);
    return !u.hash && u.search === location.search && pageOf(u) === current;
  }
  const warm = (e) => { const u = target(linkOf(e.target)); if (u) load(u); };
  document.addEventListener("pointerover", warm, { passive: true });
  document.addEventListener("focusin", warm);
  document.addEventListener("touchstart", warm, { passive: true });

  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = linkOf(e.target);
    if (!a) return;
    save(); // the place to come back to, for a #hash link on this page too
    if (here(a)) {
      e.preventDefault();
      scrollTo({ top: 0, behavior: (window.AH ? window.AH.still : matchMedia("(prefers-reduced-motion: reduce)").matches) ? "auto" : "smooth" });
      return;
    }
    const u = target(a);
    if (!u) return;
    e.preventDefault();
    go(u, true, null, false);
  });

  // a page a script sends the reader to (the contact form's thank-you page, AH-133) changes the way a click on a link
  // does; one this script cannot bring in is left to the sender, which then loads it the ordinary way
  document.addEventListener("ah:go", (e) => {
    const u = new URL(e.detail, location.href);
    if (!pageOf(u) || pageOf(u) === current) return;
    e.preventDefault();
    save();
    go(u, true, null, false);
  });

  addEventListener("popstate", (e) => {
    const s = e.state, u = new URL(location.href), p = pageOf(u);
    if (!p) return;
    const y = s && typeof s.y === "number" ? s.y : null;
    if (p === current) { // a #hash entry on this page: restoration is manual, so put the scroll back here
      seq++;
      if (y !== null) scrollTo(0, y); else { const el = find(document, u.hash); if (el) el.scrollIntoView(); }
      return;
    }
    const back = s && Number.isInteger(s.i) ? s.i < index : true;
    if (s && Number.isInteger(s.i)) index = s.i;
    go(u, false, y, back);
  });

  async function go(u, push, y, back) {
    const n = ++seq;
    const doc = await load(u);
    if (n !== seq) return; // a later click or Back won
    const src = doc && doc.getElementById("page");
    if (!src) { if (push) location.assign(u.href); else location.reload(); return; }
    if (push) { save(); history.pushState({ ah: 1, i: ++index, y: 0 }, "", u.href); }
    swap(doc, src, u, y, back);
  }

  function find(root, hash) {
    let id = "";
    try { id = decodeURIComponent((hash || "").slice(1)); } catch { return null; }
    return id ? [...root.querySelectorAll("[id]")].find((el) => el.id === id) || null : null;
  }

  // The header, notice bar and footer stay the same elements: only what differs (a link's target, aria-current, a
  // footer link's words) is changed in place, so nothing in them moves or flickers. What motion.js wrote on them (the
  // footer's reveal, AH-93) is kept: dropped, the footer went see-through on every page change
  const KEEP = new Set(["data-revealed", "data-settled", "style"]);
  function morph(a, b) {
    if (a.isEqualNode(b)) return;
    if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName || a.childNodes.length !== b.childNodes.length) { a.replaceWith(document.importNode(b, true)); return; }
    if (a.nodeType !== 1) { a.nodeValue = b.nodeValue; return; }
    for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && !KEEP.has(name)) a.removeAttribute(name);
    for (const { name, value } of [...b.attributes]) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
    const ak = [...a.childNodes], bk = [...b.childNodes];
    ak.forEach((k, i) => morph(k, bk[i]));
  }

  function swap(doc, src, u, y, back) {
    if (run) run.end();
    const old = document.getElementById("page"), next = document.importNode(src, true);
    // the old page's moving parts keep the pose they have now while it leaves: an entrance (WAAPI, which motion.js
    // cancels below), a reveal mid-rise (a CSS transition) and the scroll-linked decoration (a scroll timeline would
    // replay on a pinned page). Read before anything moves, written inline over all three
    const frozen = [...old.querySelectorAll("[data-enter], .reveal-item, .rule, [data-depth]")].map((el) => { const c = getComputedStyle(el); return [el, c.transform, c.translate, c.opacity]; });
    for (const [el, tf, tr, op] of frozen) { const s = el.style; s.transition = s.animation = "none"; s.transform = tf; s.translate = tr; s.opacity = op; }
    const r = old.getBoundingClientRect(), notice = document.querySelector(".notice-bar");
    // while the pages trade places the browser must not "anchor" the scroll to a node of the leaving page (it moved
    // the new page to 738 px instead of its top); also lifts the field over the moving pages (styles.css)
    html.setAttribute("data-moving", "");

    document.title = doc.title;
    // the head tags that say which page this is (AH-119): a link copied from the address bar after a page change shares
    // the new page's canonical address and card, never the first page's
    for (const [sel, at] of [['meta[name="description"]', "content"], ['link[rel="canonical"]', "href"], ['meta[property="og:title"]', "content"],
      ['meta[property="og:description"]', "content"], ['meta[property="og:url"]', "content"]]) {
      const theirs = doc.querySelector(sel), mine = document.querySelector(sel);
      if (theirs && mine) mine.setAttribute(at, theirs.getAttribute(at));
      else if (theirs) document.head.append(document.importNode(theirs, true));
      else if (mine) mine.remove();
    }
    if (doc.body.id) document.body.id = doc.body.id; else document.body.removeAttribute("id");
    for (const sel of [".notice-bar", "header.bar", "footer.foot"]) {
      const a = document.querySelector(sel), b = doc.querySelector(sel);
      if (a && b) morph(a, b);
    }

    // the old page lets go of its timers, then is pinned where it is on screen, out of the flow, for its exit
    document.dispatchEvent(new CustomEvent("ah:leave", { detail: { root: old } }));
    old.removeAttribute("id");
    old.setAttribute("aria-hidden", "true");
    old.inert = true;
    const s = old.style;
    s.position = "fixed"; s.top = r.top + "px"; s.left = r.left + "px"; s.width = r.width + "px"; s.margin = "0"; s.pointerEvents = "none";
    old.after(next); // the new page is in the document before the old one leaves it: no frame without a page
    current = pageOf(u);

    // where the new page opens: its saved place (Back, Forward), its #anchor, or its top with the header where it was. A
    // second blind review (AH-138) asked for the very top, the notice line shown, but the header, which stays mounted
    // over the curtain, then dropped 36 px at the swap; the first review praised that it stays put, so it does
    const anchor = y === null ? find(next, u.hash) || find(document, u.hash) : null;
    if (y !== null) scrollTo(0, y);
    else if (anchor) anchor.scrollIntoView();
    else scrollTo(0, Math.min(scrollY, notice ? notice.offsetTop + notice.offsetHeight : 0)); // a sticky bar's offsetTop is where it is stuck
    history.replaceState({ ah: 1, i: index, y: Math.round(scrollY) }, "");

    const still = window.AH ? window.AH.still : matchMedia("(prefers-reduced-motion: reduce)").matches;
    // motion.js starts on the new page (the old one keeps the poses frozen above); its entrance and reveals wait,
    // hidden, until the edge is halfway across
    document.dispatchEvent(new CustomEvent("ah:page", { detail: { root: next, wait: still ? 0 : HALF } }));

    const h = next.querySelector("h1");
    if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }

    if (still) { old.remove(); html.removeAttribute("data-moving"); return; }
    // Forward, the edge runs from the right side to the left; Back, from the left to the right. With e the eased progress
    // and W the width, the edge is at W(1 - e) (Forward), the old page moves by -DRIFT W e and the new one by
    // DRIFT W (1 - e); each clip, in its page's own frame, is then (1 - DRIFT) W e or (1 - DRIFT) W (1 - e): linear in e,
    // so keyframes on one curve keep both clips on the edge at every frame
    const W = r.width, far = (1 - DRIFT) * W, d = DRIFT * W, k = back ? -1 : 1;
    const side = (l, rt) => `inset(0px ${rt}px 0px ${l}px)`;
    const seam = document.createElement("div");
    seam.id = "seam";
    seam.setAttribute("aria-hidden", "true");
    document.body.append(seam);
    const timing = { duration: DUR, easing: EASE };
    const anims = [
      old.animate([{ transform: "translate3d(0px, 0, 0)", clipPath: side(0, 0), opacity: 1 },
        { transform: `translate3d(${-d * k}px, 0, 0)`, clipPath: back ? side(far, 0) : side(0, far), opacity: DIM }], { ...timing, fill: "forwards" }),
      next.animate([{ transform: `translate3d(${d * k}px, 0, 0)`, clipPath: back ? side(0, far) : side(far, 0) },
        { transform: "translate3d(0px, 0, 0)", clipPath: side(0, 0) }], { ...timing, fill: "backwards" }),
      seam.animate([{ transform: `translate3d(${back ? -1 : W - 1}px, 0, 0)` }, { transform: `translate3d(${back ? W - 1 : -1}px, 0, 0)` }], { ...timing, fill: "both" }),
    ];
    const me = {
      end() { // also when frames stall (a background tab) or another click comes first
        if (run !== me) return;
        run = null; clearTimeout(me.timer);
        for (const a of anims) a.cancel();
        old.remove(); seam.remove();
        html.removeAttribute("data-moving");
      },
    };
    run = me;
    // the old page leaves when all three animations have finished; the timer only if they never do (frames stalled, a
    // background tab). 300 ms past the end: a loaded box started the motion 170 ms late and drew a frame every 80 ms,
    // so the animations finished at 1050 to 1150 ms, against tools/test_site.mjs's 1160 ms, and a timer at that very
    // mark lost to its own jitter. By then --ease-out has moved the edge more than 99.5% of the way
    me.timer = setTimeout(me.end, DUR + 300);
    Promise.all(anims.map((a) => a.finished)).then(me.end, () => {});
  }
})();

// The phone's menu (AH-126): the Menu button opens and closes the header's links (styles.css shows the button, and hides
// the closed links, only on a phone with this script running). Escape closes it and gives focus back to the button; a
// link closes it as it is followed. Listeners on the document, so the header kept across page changes needs no new
// ones, and its own block, apart from the transitions above, so either can change alone.
// A dropdown from its button (AH-138, John 2026-11-06: "popovers start at scale 0.95, come in from their trigger and go
// out to it"): it opens from the button's centre (--menu-x, in px from the links' left edge, styles.css's
// transform-origin) and, with motion, closes back there: aria-expanded says "false" at once, while data-closing keeps the
// links drawn, out of reach (inert), for the exit's --pop-out; reopened meanwhile, the exit is dropped.
// Cut short, it goes on from where it is (AH-148, John 2026-11-09: "interruptible animation"): reopened while it shrinks,
// it grows back from that pose, and closed while it grows, it shrinks from that pose. Its opacity is its progress on
// --ease-out, so the new animation is moved to the moment of its own curve that has the same pose (AH.ease.when)
(() => {
  const html = document.documentElement;
  const shown = (nav) => { const o = parseFloat(getComputedStyle(nav).opacity); return Number.isFinite(o) ? o : 1; };
  const resume = (nav, name, at) => {
    const a = nav.getAnimations().find((x) => x.animationName === name), when = window.AH && window.AH.ease ? window.AH.ease.when : (y) => y;
    if (a && a.effect) a.currentTime = when(at) * a.effect.getComputedTiming().duration;
  };
  const still = () => (window.AH ? window.AH.still : matchMedia("(prefers-reduced-motion: reduce)").matches);
  const btn = () => document.querySelector(".menu-btn");
  let closing = null; // { nav, done }
  const drop = () => { if (closing) closing.done(); };
  // open, it closes as a popover does (AH-138 review): on a press anywhere outside it and its button, and once the page
  // has scrolled more than 8 px from where it opened (on a phone the bar scrolls away with it)
  let from = 0;
  const outside = (e) => { const b = btn(); if (b && !(e.target.closest && e.target.closest(".menu-btn, #main-nav"))) set(b, false); };
  const scrolled = () => { const b = btn(); if (b && Math.abs(scrollY - from) > 8) set(b, false); };
  const watch = (on) => { const f = on ? addEventListener : removeEventListener;
    f("pointerdown", outside, { capture: true, passive: true }); f("scroll", scrolled, { passive: true }); };
  function set(b, open) {
    const nav = document.getElementById(b.getAttribute("aria-controls"));
    const was = b.getAttribute("aria-expanded") === "true";
    if (open) {
      const back = closing && closing.nav === nav ? shown(nav) : 1; // how far a leaving menu still shows
      drop();
      b.setAttribute("aria-expanded", "true");
      if (nav && back < 1 && !still()) resume(nav, "pop-in", back);
      from = scrollY; watch(true);
      // read once the links are drawn (closed, they have no box), before the frame that shows them
      if (nav) { const r = b.getBoundingClientRect(); nav.style.setProperty("--menu-x", Math.round(r.left + r.width / 2 - nav.getBoundingClientRect().left) + "px"); }
      // its links are at rest as it opens: opened during the first load's entrance, they were still flying in from past the
      // screen's right edge inside the menu (motion.js), where a press could not reach them
      if (nav) for (const a of nav.getAnimations({ subtree: true })) if (a.effect && a.effect.target !== nav) a.finish();
      return;
    }
    watch(false);
    // the exit plays only for a menu that is open and drawn (a phone), with motion
    let had = 1;
    if (was && nav && !still() && b.getClientRects().length && nav.getClientRects().length) {
      had = shown(nav); // how far its entrance had come
      drop();
      nav.setAttribute("data-closing", "");
      nav.inert = true;
      const t = parseFloat(getComputedStyle(html).getPropertyValue("--pop-out")) || 160;
      const ended = (e) => { if (e.target === nav && e.animationName === "pop-out") me.done(); };
      const me = { nav, done() {
        if (closing !== me) return;
        closing = null; clearTimeout(me.timer); nav.removeEventListener("animationend", ended);
        nav.removeAttribute("data-closing"); nav.inert = false;
      } };
      closing = me;
      nav.addEventListener("animationend", ended);
      me.timer = setTimeout(me.done, t + 150); // if the animationend never comes (a hidden tab)
    }
    b.setAttribute("aria-expanded", "false");
    if (closing && had < 1) resume(nav, "pop-out", 1 - had);
  }
  document.addEventListener("click", (e) => {
    const b = btn(), t = e.target.closest ? e.target : null;
    if (!b || !t) return;
    if (t.closest(".menu-btn")) set(b, b.getAttribute("aria-expanded") !== "true");
    else if (t.closest("#main-nav a")) set(b, false);
  });
  document.addEventListener("keydown", (e) => {
    const b = btn();
    if (e.key !== "Escape" || !b || b.getAttribute("aria-expanded") !== "true") return;
    set(b, false);
    b.focus();
  });
})();
