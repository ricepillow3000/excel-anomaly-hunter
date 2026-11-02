// The home page's sample workspace (three scan states, filters, a detail box per flagged row) and the live SHA-256.
// Without this script the page still shows the findings and links to the release page for the checksum.
// Every page loads it once (AH-73): it sets up the workspace of the page it finds, again each time transition.js swaps
// the home page in ("ah:page"), and lets go of it when that page leaves ("ah:leave"): its ticker and its listeners on
// the document go with it, so a visit back never stacks a second set.
// The sheet's motion (AH-89, AH-92, John 2026-11-02): it loads once a visit as a skeleton of itself, a click on a filter
// or a tab turns the old view away like a page, and the timings are the tokens in styles.css :root.
(() => {
  const API = "https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest";
  const STAGES = ["READING SHEET DATA", "CHECKING TOTALS AND PRODUCTS", "COMPARING LABELS", "TESTING COLUMN LIMITS", "SCORING ROWS"];
  const html = document.documentElement;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const tokens = getComputedStyle(html);
  const ms = (n, d) => { const v = tokens.getPropertyValue(n).trim(); return v ? (parseFloat(v) || 0) * (/[^m]s$/.test(v) ? 1000 : 1) : d; };
  const SHIMMER = ms("--skeleton-dur", 1300), STEP = ms("--land-step", 32), FADE = ms("--land-fade", 280), TURN = ms("--turn-dur", 700);
  const INOUT = tokens.getPropertyValue("--ease-in-out").trim() || "cubic-bezier(.65, 0, .35, 1)";
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

  // The sheet loads as a skeleton of itself (AH-89). It waits, bars where the values will be, until the sheet is 30%
  // on screen (and its entrance, if it is coming in, is a third of the way), then one band of light crosses it in
  // --skeleton-dur and the rows land one by one, --land-step apart. Never over values someone may already have seen
  // (scripts that came late, a visit back), never with reduced motion or without motion.js; a press anywhere on the
  // sheet ends it at once. Returns what lets it go.
  function skeleton(ws) {
    if (landed || !moving() || !window.IntersectionObserver) return () => {};
    const entrance = ws.getAnimations().find((a) => a.playState === "running" || a.playState === "pending");
    const r = ws.getBoundingClientRect();
    if (!entrance && r.top < html.clientHeight && r.bottom > 0) return () => {};
    const rows = [...ws.querySelectorAll(".grid tbody tr")], marks = [...ws.querySelectorAll(".typology .n, .key span")];
    const cells = [...ws.querySelectorAll(".grid tbody tr > *"), ...marks];
    let timers = [], io = null, done = false;
    const later = (f, t) => timers.push(setTimeout(f, t));
    const end = () => {
      if (done) return;
      done = landed = true;
      if (io) io.disconnect();
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
    io = new IntersectionObserver((es) => {
      const e = es[es.length - 1], root = e.rootBounds;
      if (!e.isIntersecting || (e.intersectionRatio < 0.3 && (!root || e.intersectionRect.height < 0.3 * root.height))) return;
      io.disconnect(); io = null;
      const a = ws.getAnimations().find((x) => x.playState === "running" || x.playState === "pending"), t = a && a.effect.getComputedTiming();
      later(play, a ? Math.max(0, t.delay + t.duration / 3 - (a.currentTime || 0)) : 0);
    }, { threshold: [0, 0.15, 0.3, 0.5] });
    measure(cells);
    ws.setAttribute("data-loading", "");
    io.observe(ws);
    ws.addEventListener("pointerdown", end, true); ws.addEventListener("keydown", end, true);
    return end;
  }

  function mount(root) {
    const ws = root.querySelector("#preview");
    if (!ws) return;
    if (mounted) mounted.off();
    const byId = (id) => root.querySelector("#" + CSS.escape(id));
    const bye = new AbortController(), on = { signal: bye.signal };
    const tabs = [...ws.querySelectorAll('[role="tab"]')];
    const counts = [...ws.querySelectorAll(".typology .n")];
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

    let tick;
    function show(tab) {
      for (const t of tabs) {
        const sel = t === tab;
        t.setAttribute("aria-selected", sel);
        t.tabIndex = sel ? 0 : -1;
        byId(t.getAttribute("aria-controls")).hidden = !sel;
      }
      const state = tab.id.slice(2);
      ws.dataset.state = state;
      // "clean" is the sheet with the three suggested fixes in: four rows are still worth a check there (AH-88)
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
    ws.querySelector(".tabs").addEventListener("keydown", (e) => {  // arrow keys move between tabs, as in any tab list
      const i = tabs.indexOf(document.activeElement);
      if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); pick(next);
    });

    for (const b of ws.querySelectorAll(".typology button")) {
      b.addEventListener("click", () => {
        const change = () => {
          if (ws.dataset.state !== "found") show(tabs[0]);
          for (const o of ws.querySelectorAll(".typology button")) o.setAttribute("aria-pressed", o === b);
          ws.dataset.filter = b.dataset.kind;
          closeMatrix();
        };
        if (ws.dataset.state === "found" && ws.dataset.filter === b.dataset.kind) change(); else turn(change);
      });
    }

    const main = ws.querySelector("#p-found");
    let open = null;
    function closeMatrix() {
      if (!open) return;
      open.btn.setAttribute("aria-expanded", "false");
      open.box.hidden = true;
      open = null;
    }
    function openMatrix(btn) {
      const box = byId(btn.getAttribute("aria-controls"));
      const same = open && open.btn === btn;
      closeMatrix();
      if (same) return;
      const row = btn.closest("tr").getBoundingClientRect(), top = main.getBoundingClientRect().top;
      box.style.top = row.bottom - top + "px";
      box.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      open = { btn, box };
      // the box is a dialog that sits after the whole table in the page: without this a keyboard or screen-reader user
      // reached it only after every other row; Escape and Close bring focus back to the row
      box.querySelector(".m-close").focus();
    }
    for (const btn of ws.querySelectorAll(".rowbtn")) {
      btn.addEventListener("click", (e) => { e.stopPropagation(); openMatrix(btn); });
      btn.closest("tr").addEventListener("click", () => openMatrix(btn));
    }
    for (const c of ws.querySelectorAll(".m-close")) c.addEventListener("click", () => { const b = open && open.btn; closeMatrix(); if (b) b.focus(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { const b = open.btn; closeMatrix(); b.focus(); } }, on);
    document.addEventListener("click", (e) => { if (open && !open.box.contains(e.target) && !e.target.closest("tr[data-kind]")) closeMatrix(); }, on);
    window.addEventListener("resize", closeMatrix, on);

    const unask = checksum(root);
    mounted = { root, off: () => { clearInterval(tick); bye.abort(); unload(); unask(); if (turning) turning(); mounted = null; } };
  }

  // GitHub publishes each release file's SHA-256; showing it here keeps the number from going stale between releases.
  // While the answer is really on its way (not kept from earlier in the visit), the facts it fills show the skeleton's
  // bars on their parent list (AH-89: never inside #sha or #rel, whose markup is all GitHub's answer may change), for
  // at least 700 ms so they never flash, and at most 6 s, then the page's own defaults stay
  function checksum(root) {
    const dl = root.querySelector("dl.anchor"), sha = root.querySelector("#sha"), rel = root.querySelector("#rel");
    const asked = release || (release = fetch(API, { headers: { Accept: "application/vnd.github+json" } })
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
      const exe = (d.assets || []).find((a) => a.name === "AnomalyHunter.exe");
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
