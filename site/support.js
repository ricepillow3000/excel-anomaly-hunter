// The site has no server, so the form sends nothing: it builds a prefilled GitHub "new issue" link and shows it.
// The person reads it on GitHub and presses Submit there (public, needs a GitHub account).
// The link opens the repo's issue form (.github/ISSUE_TEMPLATE/support_request.yml), which adds the support label and
// the public warning itself, and fills its fields by their ids: a labels= parameter needs triage rights askers lack.
// Every page loads it once (AH-73): it wires the form of the page it finds, and again each time transition.js swaps
// the support page in ("ah:page"); the old form's listener leaves with the old page.
(() => {
  const ISSUES = "https://github.com/ricepillow3000/excel-anomaly-hunter/issues/new?template=support_request.yml";
  // Measured 2026-10-20: GitHub answers 414 past 8,190 characters, and a signed-out person's login page keeps the way
  // back only while the link still fits once encoded again (7,600 plain characters, 4,600 of emoji); past that, all
  // they typed is lost. So the details are cut, at a whole character, until the encoded link fits with room to spare.
  const FITS = 7000;

  function mount(root) {
    const form = root.querySelector("#ticket");
    if (!form) return;
    const $ = (id) => root.querySelector("#" + id);
    const missing = $("missing");
    const v = (id) => { const s = $(id).value.trim(); return s.toWellFormed ? s.toWellFormed() : s; }; // a lone surrogate would make encodeURIComponent throw
    const NEEDED = [["summary", "a short summary"], ["details", "what happened"], ["clean", "the box that says it contains no key or private data"]];
    const empty = (id) => (id === "clean" ? !$(id).checked : !v(id));
    // AH-114: on a phone with its keyboard open (390 x 420) the message sat under the button, off the screen, focus stayed
    // on the button and no field said it was the one missing. Each missing field now says so and is described by the
    // message, which moves to just under the first of them, and that field takes focus; a field lets go once it is filled
    const mark = (id, bad) => { const el = $(id);
      if (bad) { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", "missing"); }
      else { el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby"); } };
    const recheck = () => {
      for (const [id] of NEEDED) if ($(id).hasAttribute("aria-invalid") && !empty(id)) mark(id, false);
      if (!NEEDED.some(([id]) => $(id).hasAttribute("aria-invalid"))) missing.hidden = true;
    };
    form.addEventListener("input", recheck);
    form.addEventListener("change", recheck);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const need = NEEDED.filter(([id]) => empty(id));
      for (const [id] of NEEDED) mark(id, need.some(([n]) => n === id));
      missing.hidden = !need.length;
      $("result").hidden = !!need.length;
      if (need.length) {
        missing.textContent = "Please add " + need.map(([, w]) => w).join(", ") + ".";
        const first = $(need[0][0]);
        first.closest(".field, .confirm").after(missing);
        first.focus();
        missing.scrollIntoView({ block: "nearest" });
        return;
      }
      const q = encodeURIComponent;
      const link = (details) => `${ISSUES}&title=${q("[Support]: " + v("summary"))}&category=${q(v("topic"))}&version=${q(v("version"))}&details=${q(details)}`;
      const all = [...v("details")];
      let keep = all.length, url = link(v("details"));
      while (q(url).length > FITS && keep) { keep = Math.floor(keep * 0.9); url = link(all.slice(0, keep).join("")); }
      $("cut").hidden = keep === all.length;
      $("open").href = url;
      $("open").focus();
    });
  }

  document.addEventListener("ah:page", (e) => mount((e.detail && e.detail.root) || document));
  mount(document);
})();
