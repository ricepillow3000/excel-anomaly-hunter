// The home page's sample workspace (three scan states, filters, a detail box per flagged row) and the live SHA-256.
// Without this script the page still shows the findings and links to the release page for the checksum.
// Every page loads it once (AH-73): it sets up the workspace of the page it finds, again each time transition.js swaps
// the home page in ("ah:page"), and lets go of it when that page leaves ("ah:leave"): its ticker and its listeners on
// the document go with it, so a visit back never stacks a second set.
(() => {
  const API = "https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest";
  const STAGES = ["READING SHEET DATA", "CHECKING TOTALS AND PRODUCTS", "COMPARING LABELS", "TESTING COLUMN LIMITS", "SCORING ROWS"];
  let mounted = null; // { root, off }
  let release = null; // GitHub's answer, asked once a visit to the site and kept while it is good

  function mount(root) {
    const ws = root.querySelector("#preview");
    if (!ws) return;
    if (mounted) mounted.off();
    const byId = (id) => root.querySelector("#" + CSS.escape(id));
    const bye = new AbortController(), on = { signal: bye.signal };
    const tabs = [...ws.querySelectorAll('[role="tab"]')];
    const counts = [...ws.querySelectorAll(".typology .n")];
    ws.querySelector(".tabs").hidden = false;

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
      for (const n of counts) n.textContent = state === "found" ? n.dataset.n : state === "clean" ? "0" : "·";
      closeMatrix();
      clearInterval(tick);
      if (state === "busy") {
        let i = 0;
        const ticker = byId("ticker");
        ticker.textContent = STAGES[0];
        tick = setInterval(() => { ticker.textContent = STAGES[++i % STAGES.length]; }, 900);
      }
    }
    for (const t of tabs) t.addEventListener("click", () => show(t));
    ws.querySelector(".tabs").addEventListener("keydown", (e) => {  // arrow keys move between tabs, as in any tab list
      const i = tabs.indexOf(document.activeElement);
      if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      next.focus(); show(next);
    });

    for (const b of ws.querySelectorAll(".typology button")) {
      b.addEventListener("click", () => {
        if (ws.dataset.state !== "found") show(tabs[0]);
        for (const o of ws.querySelectorAll(".typology button")) o.setAttribute("aria-pressed", o === b);
        ws.dataset.filter = b.dataset.kind;
        closeMatrix();
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

    checksum(root);
    mounted = { root, off: () => { clearInterval(tick); bye.abort(); mounted = null; } };
  }

  // GitHub publishes each release file's SHA-256; showing it here keeps the number from going stale between releases.
  function checksum(root) {
    const asked = release || (release = fetch(API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status))));
    asked.then((d) => {
      const exe = (d.assets || []).find((a) => a.name === "AnomalyHunter.exe");
      const hash = /^sha256:([0-9a-f]{64})$/.exec((exe && exe.digest) || "");
      if (!hash) return;
      root.querySelector("#sha").textContent = hash[1];
      const tag = /^v\d+\.\d+\.\d+$/.test(d.tag_name) ? d.tag_name : "Latest";
      const date = /^\d{4}-\d{2}-\d{2}/.exec(d.published_at || "");
      const mb = Number.isFinite(exe.size) && exe.size > 0 ? Math.round(exe.size / 1e6) + " MB" : ""; // a size that isn't a number read "NaN MB"
      root.querySelector("#rel").textContent = [tag + (date ? ", " + date[0] : ""), mb, "free"].filter(Boolean).join(" · ");
    }).catch(() => { if (release === asked) release = null; });  // offline or rate-limited: the release-page link stays, and the next visit asks again
  }

  document.addEventListener("ah:leave", (e) => { if (mounted && e.detail && e.detail.root === mounted.root) mounted.off(); });
  document.addEventListener("ah:page", (e) => mount((e.detail && e.detail.root) || document));
  mount(document);
})();
