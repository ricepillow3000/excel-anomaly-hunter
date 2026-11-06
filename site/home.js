// The home page's sample workspace (three scan states, filters, a detail box per flagged row) and the live SHA-256.
// Without this script the page still shows the findings and links to the release page for the checksum.
// Every page loads it once (AH-73): it sets up the workspace of the page it finds, again each time transition.js swaps
// the home page in ("ah:page"), and lets go of it when that page leaves ("ah:leave"): its ticker and its listeners on
// the document go with it, so a visit back never stacks a second set.
// The sheet's motion (AH-89, AH-92, John 2026-11-02): it loads once a visit as a skeleton of itself, a click on a filter
// or a tab turns the old view away like a page, and the timings are the tokens in styles.css :root. AH-138 (John
// 2026-11-06): a row's detail box is a popover from its row's button, the tabs' gold line is one mark that slides from tab
// to tab, and the PowerShell line has a Copy button.
(() => {
  const API = "https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest";
  // the pane's own progress line for this 60-row sheet (frontend/features/scan.js; test_site_sample.py holds them to it):
  // its 305 cells are one slice of READ_CELLS, so the pane goes from the first words straight to 100% (it never says 40%)
  const STAGES = ["Step 1 of 3: reading your sheet…", "Step 1 of 3: reading your sheet… 100%", "Step 2 of 3: checking 60 rows…"];
  const html = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tokens = getComputedStyle(html);
  const ms = (n, d) => { const v = tokens.getPropertyValue(n).trim(); return v ? (parseFloat(v) || 0) * (/[^m]s$/.test(v) ? 1000 : 1) : d; };
  const SHIMMER = ms("--skeleton-dur", 1300), STEP = ms("--land-step", 30), FADE = ms("--land-fade", 280), TURN = ms("--turn-dur", 700);
  const INOUT = tokens.getPropertyValue("--ease-in-out").trim() || "cubic-bezier(.65, 0, .35, 1)";
  const EASE = tokens.getPropertyValue("--ease-out").trim() || "cubic-bezier(.16, 1, .3, 1)";
  const POP_IN = ms("--pop-in", 200), POP_OUT = ms("--pop-out", 160), ROW = ms("--stagger-row", 30), SLIDE = ms("--slide-dur", 300);
  const num = (n, d) => parseFloat(tokens.getPropertyValue(n)) || d;
  const FROM = num("--pop-from", 0.95), STRETCH = num("--stretch", 1.12);
  const SHOWN = 700, GIVE_UP = 6000; // the download's skeleton: long enough never to flash, never longer than a slow answer
  let mounted = null; // { root, off }
  let release = null; // GitHub's answer, asked once a visit to the site and kept while it is good
  let answered = null; // the asked answer once it has come back (a visit back shows it at once, no skeleton)
  let landed = false; // the sheet's skeleton plays once a visit
  const moving = () => !still && !!window.AH && html.hasAttribute("data-js");

  // A skeleton bar the size of the element's text, where the text is: --sk-x/y/w/h, from the padding box (an absolute
  // ::after's origin). Read from the layout once, before the bars show and again as they start, after any font swap
  function measure(els) {
    const range = document.createRange();
    for (const el of els) {
      const texts = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent.trim()) texts.push(n);
      if (!texts.length) { el.style.setProperty("--sk-w", "0px"); continue; }
      const last = texts[texts.length - 1];
      range.setStart(texts[0], 0); range.setEnd(last, last.length);
      const t = range.getBoundingClientRect(), b = el.getBoundingClientRect();
      const set = (k, v) => el.style.setProperty(k, Math.round(v * 10) / 10 + "px");
      set("--sk-x", t.left - b.left - el.clientLeft); set("--sk-w", t.width);
      set("--sk-y", t.top - b.top - el.clientTop + t.height * 0.18); set("--sk-h", t.height * 0.64);
    }
  }

  // The sheet loads as a skeleton of itself (AH-89). It waits, bars where the values will be, until the sheet is 60%
  // on screen, or covers 60% of a screen it is taller than (a phone), and its entrance, if it is coming in, is a third of
  // the way; then one band of light crosses it in --skeleton-dur and the rows land one by one, --land-step apart. While
  // a glide runs ("See a sample scan", motion.js) it waits for the glide to end: at 30% it played on the way down and
  // had mostly finished by the time the visitor arrived (AH-99, John 2026-11-02). Never over values someone may already have seen
  // (scripts that came late, a visit back), never with reduced motion or without motion.js; a press anywhere on the
  // sheet ends it at once. Returns what lets it go.
  function skeleton(ws) {
    if (landed || !moving() || !window.IntersectionObserver) return () => {};
    const entrance = ws.getAnimations().find((a) => a.playState === "running" || a.playState === "pending");
    const r = ws.getBoundingClientRect();
    if (!entrance && r.top < html.clientHeight && r.bottom > 0) return () => {};
    const rows = [...ws.querySelectorAll("#p-found .grid tbody tr")], marks = [...ws.querySelectorAll(".typology .n, .key span")];
    const cells = [...ws.querySelectorAll("#p-found .grid tbody tr > *"), ...marks];
    let timers = [], io = null, done = false, armed = false;
    const later = (f, t) => timers.push(setTimeout(f, t));
    const end = () => {
      if (done) return;
      done = landed = true;
      if (io) io.disconnect();
      document.removeEventListener("ah:glide-end", check);
      timers.forEach(clearTimeout); timers = [];
      ws.removeAttribute("data-loading");
      for (const el of [...rows, ...marks]) el.removeAttribute("data-in");
      ws.removeEventListener("pointerdown", end, true); ws.removeEventListener("keydown", end, true);
    };
    // each row in turn, the counts and the key with the first rows; the attribute goes when the last bar has faded
    const land = () => {
      rows.forEach((tr, i) => later(() => tr.setAttribute("data-in", ""), i * STEP));
      marks.forEach((el, i) => later(() => el.setAttribute("data-in", ""), i * STEP));
      later(end, (Math.max(rows.length, marks.length) - 1) * STEP + Math.max(FADE, 360) + 40);
    };
    const play = () => { landed = true; measure(cells); ws.setAttribute("data-loading", "play"); later(land, SHIMMER); };
    // read from the layout, so a glide's end (which crosses no threshold) can ask too
    const seen = () => {
      const b = ws.getBoundingClientRect(), h = html.clientHeight, shown = Math.min(b.bottom, h) - Math.max(b.top, 0);
      return shown > 0 && (shown >= 0.6 * b.height || shown >= 0.6 * h);
    };
    function check() {
      if (done || armed || (window.AH.gliding && window.AH.gliding()) || !seen()) return;
      armed = true;
      if (io) io.disconnect();
      io = null;
      document.removeEventListener("ah:glide-end", check);
      const a = ws.getAnimations().find((x) => x.playState === "running" || x.playState === "pending"), t = a && a.effect.getComputedTiming();
      later(play, a ? Math.max(0, t.delay + t.duration / 3 - (a.currentTime || 0)) : 0);
    }
    io = new IntersectionObserver(check, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) });
    document.addEventListener("ah:glide-end", check);
    measure(cells);
    ws.setAttribute("data-loading", "");
    io.observe(ws);
    ws.addEventListener("pointerdown", end, true); ws.addEventListener("keydown", end, true);
    return end;
  }

  // The phone's download bar (AH-126): on a phone only, once the hero's download has scrolled off the top and while the
  // download section is not on screen, its hidden goes and it rises in from the bottom edge (transform and opacity, by
  // the clock, nothing under reduced motion); it hides at once. Two IntersectionObservers, never a scroll listener, so
  // nothing runs while the page is still. Returns what lets it go.
  function dock(root) {
    const bar = root.querySelector("#dock"), cta = root.querySelector(".hero-cta .btn-primary"), dl = root.querySelector("#download");
    if (!bar || !cta || !dl || !window.IntersectionObserver) return () => {};
    const phone = matchMedia("(max-width: 760px)");
    let past = false, near = false, rise = null;
    const set = () => {
      const on = phone.matches && past && !near;
      if (on === !bar.hidden) return;
      bar.hidden = !on;
      if (rise) { rise.cancel(); rise = null; }
      if (on && !still && bar.animate) rise = bar.animate([{ transform: "translate3d(0, 100%, 0)", opacity: 0 }, { transform: "translate3d(0, 0, 0)", opacity: 1 }], { duration: ms("--fill-dur", 350), easing: tokens.getPropertyValue("--ease-out").trim() || "ease-out" });
    };
    const io = new IntersectionObserver((seen) => {
      for (const e of seen) if (e.target === cta) past = !e.isIntersecting && e.boundingClientRect.top < 0; else near = e.isIntersecting;
      set();
    });
    io.observe(cta); io.observe(dl);
    phone.addEventListener("change", set);
    return () => { io.disconnect(); phone.removeEventListener("change", set); if (rise) rise.cancel(); bar.hidden = true; };
  }

  function mount(root) {
    const ws = root.querySelector("#preview");
    if (!ws) return;
    if (mounted) mounted.off();
    const byId = (id) => root.querySelector("#" + CSS.escape(id));
    const bye = new AbortController(), on = { signal: bye.signal };
    const tabs = [...ws.querySelectorAll('[role="tab"]')];
    const counts = [...ws.querySelectorAll(".typology .n, .key .kcount")];
    ws.querySelector(".tabs").hidden = false;
    const unload = skeleton(ws);

    // John, 2026-11-02: "when I click it... on the right side of the sample sheet... it is being turned like a page"
    // (AH-92). A copy of the panel as it stands (ids stripped, hidden from readers and the keyboard, each row's opacity
    // frozen as it was) is laid over it; the real panel takes the new state at once (the filters' dimming is read
    // straight after a click, and openMatrix measures the real rows, so the real panel never moves); the copy turns away
    // from its left edge, a shade deepening on it, and is removed when it is gone, at the next click, or when the page
    // leaves
    let turning = null;
    function turn(apply) {
      if (turning) turning();
      const panel = ws.querySelector(".ws-main > .panel:not([hidden])");
      if (!moving() || !panel || !panel.animate) return apply();
      const copy = panel.cloneNode(true), real = [...panel.querySelectorAll("tr")], fake = [...copy.querySelectorAll("tr")];
      real.forEach((tr, i) => { fake[i].style.opacity = getComputedStyle(tr).opacity; });
      // a still picture: each mark as the old filter drew it (the new one applies to the real rows at once) and each scan
      // meter where it was (styles.css stops every animation inside the copy, AH-138 review)
      const sel = "td.flag, td.q, td.mended, td.why i, .meter span", marked = [...panel.querySelectorAll(sel)], faked = [...copy.querySelectorAll(sel)];
      marked.forEach((el, i) => { const c = getComputedStyle(el), f = faked[i].style;
        for (const k of ["backgroundColor", "color", "fontWeight", "boxShadow", "visibility", "transform"]) f[k] = c[k]; });
      for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
      for (const el of [copy, ...copy.querySelectorAll("[data-in]")]) el.removeAttribute("data-in");
      copy.removeAttribute("role"); copy.removeAttribute("aria-labelledby");
      copy.setAttribute("aria-hidden", "true"); copy.inert = true; copy.setAttribute("data-turn", "");
      const s = copy.style;
      s.top = panel.offsetTop + "px"; s.left = panel.offsetLeft + "px"; s.width = panel.offsetWidth + "px"; s.height = panel.offsetHeight + "px";
      const shade = document.createElement("div");
      shade.setAttribute("data-turn-shade", "");
      copy.append(shade);
      panel.parentElement.append(copy);
      apply();
      const timing = { duration: TURN, easing: INOUT, fill: "forwards" };
      const anims = [copy.animate([{ transform: "perspective(2400px) rotateY(0deg)" }, { transform: "perspective(2400px) rotateY(-100deg)" }], timing),
        shade.animate([{ opacity: 0 }, { opacity: 1 }], timing)];
      const gone = () => { for (const a of anims) a.cancel(); copy.remove(); if (turning === gone) turning = null; };
      turning = gone;
      anims[0].finished.then(gone, () => {});
    }

    // One gold mark for the chosen tab (AH-138, John 2026-11-06: "one shared element (layout id) reused across shared
    // objects", "a moving knob stretches 12%", "arcs for object movement"): the same <span class="tab-mark"
    // aria-hidden="true"> moves to every tab, posed as translate(x, y) scaleX(width) from a 1 px line, where the chosen
    // tab's own line is (its ::after steps aside, styles.css). Between two tabs it slides over --slide-dur on
    // --ease-in-out, stretched at the half way to the two widths' average times --stretch and centred between them; on
    // two lines (text at 200% wraps the tabs) the half way also lifts it only a fifth of the rise, so it travels an arc.
    // With reduced motion it is there at once
    const strip = ws.querySelector(".tabs");
    let mark = strip.querySelector(".tab-mark"), slide = null, at = null;
    if (!mark) { mark = document.createElement("span"); mark.className = "tab-mark"; mark.setAttribute("aria-hidden", "true"); strip.append(mark); }
    strip.setAttribute("data-mark", "");
    const poseOf = (t) => ({ x: t.offsetLeft, y: t.offsetTop + t.offsetHeight - 3, w: t.offsetWidth }); // the ::after's place: the 3 px under the tab
    const posed = (q) => `translate(${q.x}px, ${q.y}px) scaleX(${q.w})`;
    function markTo(tab, move) {
      const to = poseOf(tab);
      let from = at;
      if (slide) { const m = new DOMMatrix(getComputedStyle(mark).transform); from = { x: m.e, y: m.f, w: m.a }; slide.cancel(); slide = null; }
      mark.style.transform = posed(to);
      at = to;
      if (!move || !from || !moving() || !mark.animate || (Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5 && Math.abs(from.w - to.w) < 0.5)) return;
      const w = ((from.w + to.w) / 2) * STRETCH, c = (from.x + from.w / 2 + to.x + to.w / 2) / 2;
      const mid = { x: c - w / 2, y: from.y + 0.2 * (to.y - from.y), w };
      const a = slide = mark.animate([{ transform: posed(from) }, { transform: posed(mid), offset: 0.5 }, { transform: posed(to) }], { duration: SLIDE, easing: INOUT });
      a.finished.then(() => { if (slide === a) slide = null; }, () => {});
    }
    const chosen = () => tabs.find((t) => t.getAttribute("aria-selected") === "true") || tabs[0];
    markTo(chosen(), false);
    // a font swap, text at 200% or a narrower screen moves the tabs: the mark follows at once
    const sized = window.ResizeObserver ? new ResizeObserver(() => markTo(chosen(), false)) : null;
    if (sized) for (const el of [strip, ...tabs]) sized.observe(el);

    let tick;
    function show(tab) {
      for (const t of tabs) {
        const sel = t === tab;
        t.setAttribute("aria-selected", sel);
        t.tabIndex = sel ? 0 : -1;
        byId(t.getAttribute("aria-controls")).hidden = !sel;
      }
      markTo(tab, true);
      const state = tab.id.slice(2);
      ws.dataset.state = state;
      // "clean" is the sheet with the three suggested fixes in: four rows are still worth a check there (AH-88), and the
      // key under the filters says so too (it read "Probably wrong: 3" over the corrected sheet, AH-98)
      for (const n of counts) n.textContent = state === "found" ? n.dataset.n : state === "clean" ? n.dataset.after : "·";
      closeMatrix();
      clearInterval(tick);
      if (state === "busy") {
        let i = 0;
        const ticker = byId("ticker");
        ticker.textContent = STAGES[0];
        tick = setInterval(() => { ticker.textContent = STAGES[++i % STAGES.length]; }, 900);
      }
    }
    const pick = (tab) => { if (tab.getAttribute("aria-selected") === "true") show(tab); else turn(() => show(tab)); };
    for (const t of tabs) t.addEventListener("click", () => pick(t));
    // the arrows, Home and End move between tabs, as in any tab list (WAI-ARIA tabs; Home and End since AH-132, and End
    // no longer scrolls the page to its bottom)
    ws.querySelector(".tabs").addEventListener("keydown", (e) => {
      const i = tabs.indexOf(document.activeElement), to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 };
      if (i < 0 || !Object.hasOwn(to, e.key)) return;
      e.preventDefault();
      const next = tabs[(to[e.key] + tabs.length) % tabs.length];
      next.focus(); pick(next);
    });

    for (const b of ws.querySelectorAll(".typology button")) {
      b.addEventListener("click", () => {
        // on After fixes a filter filters the corrected sheet's rows, by the counts shown there: it jumped back to the
        // findings, so "Temporal outliers 4" lit 5 rows (AH-129); only Scanning, which has no rows, goes to the findings
        const change = () => {
          if (ws.dataset.state === "busy") show(tabs[0]);
          for (const o of ws.querySelectorAll(".typology button")) o.setAttribute("aria-pressed", o === b);
          ws.dataset.filter = b.dataset.kind;
          closeMatrix();
        };
        if (ws.dataset.state !== "busy" && ws.dataset.filter === b.dataset.kind) change(); else turn(change);
      });
    }

    // A row's detail box is a popover from its row's button (AH-138, John 2026-11-06: "popovers start at scale 0.95, come
    // in from their trigger and go out to it", "stagger when details settle"): with motion it grows from --pop-from at
    // the button's centre over --pop-in, its head and then each line of its details settling 4 px up, --stagger-row
    // apart. Closed, the box itself is hidden at once (what the keyboard, a reader and the tests meet), and a copy of it
    // (no ids, no role, hidden from readers, inert) shrinks back to the button over --pop-out: removed when done, at the
    // next open, or when the page leaves
    const main = ws.querySelector("#p-found");
    let open = null, leaving = null;
    const unleave = () => { if (leaving) leaving(); };
    function leave(box, origin) {
      unleave();
      const copy = box.cloneNode(true);
      for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
      copy.removeAttribute("role"); copy.removeAttribute("aria-label"); copy.classList.remove("matrix");
      copy.setAttribute("aria-hidden", "true"); copy.inert = true; copy.setAttribute("data-pop-copy", "");
      copy.style.transformOrigin = origin;
      box.after(copy);
      const a = copy.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `scale(${FROM})` }], { duration: POP_OUT, easing: EASE, fill: "forwards" });
      const gone = () => { a.cancel(); copy.remove(); if (leaving === gone) leaving = null; };
      leaving = gone;
      a.finished.then(gone, () => {});
    }
    function settle(box) {
      box.animate([{ opacity: 0, transform: `scale(${FROM})` }, { opacity: 1, transform: "none" }], { duration: POP_IN, easing: EASE });
      const rise = (els, delay) => { for (const el of els) if (el) el.animate([{ opacity: 0, transform: "translate3d(0, 4px, 0)" }, { opacity: 1, transform: "none" }], { duration: POP_IN, delay, easing: EASE, fill: "backwards" }); };
      const lines = [...box.querySelectorAll("dl > *")];
      rise([box.querySelector(".m-head")], 0);
      for (let i = 0; i < lines.length; i += 2) rise(lines.slice(i, i + 2), (i / 2) * ROW);
      rise([box.querySelector(".m-said")], (lines.length / 2) * ROW);
    }
    function closeMatrix(swap) {
      if (!open) return;
      const { btn, box, origin } = open;
      for (const a of box.getAnimations({ subtree: true })) a.cancel();
      if (swap !== true && moving() && box.animate && !main.hidden) leave(box, origin); // another box opening at once needs none
      btn.setAttribute("aria-expanded", "false");
      box.hidden = true;
      open = null;
    }
    function openMatrix(btn) {
      const box = byId(btn.getAttribute("aria-controls"));
      const same = open && open.btn === btn;
      closeMatrix(!same);
      if (same) return;
      unleave();
      // under its row, or above it where it would pass the findings' bottom: under them, rows 22 to 57 covered the
      // caption and "See every check", whose clicks then did nothing (AH-132). Taller than the room on either side (a
      // narrow phone), it sits on the findings' bottom
      const row = btn.closest("tr").getBoundingClientRect(), sheet = main.getBoundingClientRect();
      box.hidden = false;
      const h = box.offsetHeight, under = row.bottom - sheet.top, over = row.top - sheet.top - h;
      box.style.top = (under + h <= sheet.height ? under : over >= 0 ? over : Math.max(0, sheet.height - h)) + "px";
      btn.setAttribute("aria-expanded", "true");
      const b = btn.getBoundingClientRect(), r = box.getBoundingClientRect(), px = (v) => Math.round(v * 10) / 10 + "px";
      const origin = px(b.left + b.width / 2 - r.left) + " " + px(b.top + b.height / 2 - r.top);
      box.style.transformOrigin = origin;
      open = { btn, box, origin };
      if (moving() && box.animate) settle(box);
      // the box is a dialog that sits after the whole table in the page: without this a keyboard or screen-reader user
      // reached it only after every other row; Escape and Close bring focus back to the row
      box.querySelector(".m-close").focus();
    }
    for (const btn of ws.querySelectorAll(".rowbtn")) {
      btn.addEventListener("click", (e) => { e.stopPropagation(); openMatrix(btn); });
      btn.closest("tr").addEventListener("click", () => openMatrix(btn));
    }
    for (const c of ws.querySelectorAll(".m-close")) c.addEventListener("click", () => { const b = open && open.btn; closeMatrix(); if (b) b.focus(); });
    // Tab out of the box closes it and lets focus go where Tab took it: it stayed open, floating over the rows (AH-132). A
    // press on the box's own text moves focus to nothing (relatedTarget null) and a press on its row's button toggles
    // it: neither is leaving
    ws.addEventListener("focusout", (e) => { const to = e.relatedTarget; if (open && to && open.box.contains(e.target) && !open.box.contains(to) && to !== open.btn) closeMatrix(); }, on);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { const b = open.btn; closeMatrix(); b.focus(); } }, on);
    document.addEventListener("click", (e) => { if (open && !open.box.contains(e.target) && !e.target.closest("tr[data-kind]")) closeMatrix(); }, on);
    window.addEventListener("resize", closeMatrix, on);

    const unask = checksum(root), undock = dock(root);
    copier(root, on);
    mounted = { root, off: () => { clearInterval(tick); bye.abort(); unload(); unask(); undock(); if (turning) turning(); unleave(); if (sized) sized.disconnect(); if (slide) slide.cancel(); mounted = null; } };
  }

  // The PowerShell line's Copy button (AH-138, John 2026-11-06: "a pulse confirms success", "icons crossfade with scale
  // and blur"): shown only with this script. It copies the line right before it, read from the page, never typed twice;
  // copied, it says so (its label is a live region a screen reader announces), its copy icon gives way to a check and a
  // ring pulses once (styles.css), and 2 s later it is Copy again. With no clipboard, or a refused one, the line's text is
  // selected and the label says to press Ctrl+C
  function copier(root, on) {
    const b = root.querySelector(".copy-btn"), code = b && b.previousElementSibling, label = b && b.querySelector(".copy-said");
    if (!b || !label || !code || !code.matches("code.line")) return;
    let timer = 0;
    const say = (t) => { label.textContent = t; };
    const back = () => { clearTimeout(timer); b.removeAttribute("data-done"); say("Copy"); };
    const done = () => { back(); getComputedStyle(b, "::after").animationName; b.setAttribute("data-done", ""); say("Copied"); timer = setTimeout(back, 2000); };
    const fail = () => {
      back();
      const r = document.createRange(), sel = getSelection();
      r.selectNodeContents(code); sel.removeAllRanges(); sel.addRange(r);
      say("Press Ctrl+C"); timer = setTimeout(back, 4000);
    };
    b.addEventListener("click", () => {
      const c = navigator.clipboard;
      if (c && typeof c.writeText === "function") c.writeText(code.textContent).then(done, fail); else fail();
    }, on);
    on.signal.addEventListener("abort", () => clearTimeout(timer));
    b.hidden = false;
  }

  // AbortSignal.timeout is missing from Safari before 16 and Chrome before 103; a timer does the same there
  function deadline(ms) {
    if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), ms);
    return stop.signal;
  }

  // GitHub publishes each release file's SHA-256; showing it here keeps the number from going stale between releases.
  // While the answer is really on its way (not kept from earlier in the visit), the facts it fills show the skeleton's
  // bars on their parent list (AH-89: never inside #sha or #rel, whose markup is all GitHub's answer may change), for
  // at least 700 ms so they never flash, and at most 6 s, then the page's own defaults stay
  function checksum(root) {
    const dl = root.querySelector("dl.anchor"), sha = root.querySelector("#sha"), rel = root.querySelector("#rel");
    // a GitHub that takes the call and never answers is given up at the skeleton's own limit (AH-124): the request was
    // kept waiting for good, and the next visit in the same tab reused it instead of asking again
    const asked = release || (release = fetch(API, { headers: { Accept: "application/vnd.github+json" }, signal: deadline(GIVE_UP) })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status))));
    let timers = [];
    const off = () => { timers.forEach(clearTimeout); timers = []; if (dl) dl.removeAttribute("data-loading"); };
    if (dl && sha && rel && answered !== asked && moving()) {
      const t0 = performance.now();
      measure([sha, rel]);
      dl.setAttribute("data-loading", "");
      const done = () => timers.push(setTimeout(off, Math.max(0, SHOWN - (performance.now() - t0))));
      asked.then(done, done);
      timers.push(setTimeout(off, GIVE_UP));
    }
    asked.then(() => { answered = asked; }, () => {});
    asked.then((d) => {
      // Arcas.exe since AH-101; a release made before the rename has only the old name
      const named = (n) => (d.assets || []).find((a) => a && a.name === n);
      const exe = named("Arcas.exe") || named("AnomalyHunter.exe");
      const hash = /^sha256:([0-9a-f]{64})$/.exec((exe && exe.digest) || "");
      if (!hash) return;
      sha.textContent = hash[1];
      const tag = /^v\d+\.\d+\.\d+$/.test(d.tag_name) ? d.tag_name : "Latest";
      const date = /^\d{4}-\d{2}-\d{2}/.exec(d.published_at || "");
      const mb = Number.isFinite(exe.size) && exe.size > 0 ? Math.round(exe.size / 1e6) + " MB" : ""; // a size that isn't a number read "NaN MB"
      rel.textContent = [tag + (date ? ", " + date[0] : ""), mb, "free"].filter(Boolean).join(" · ");
    }).catch(() => { if (release === asked) release = null; });  // offline or rate-limited: the release-page link stays, and the next visit asks again
    return off;
  }

  document.addEventListener("ah:leave", (e) => { if (mounted && e.detail && e.detail.root === mounted.root) mounted.off(); });
  document.addEventListener("ah:page", (e) => mount((e.detail && e.detail.root) || document));
  mount(document);
})();
