// The site has no server, so its two forms send nothing: each builds a prefilled GitHub "new issue" link.
// The person reads it on GitHub and presses Submit there (public, needs a GitHub account).
// The support form (support.html) shows its link; the contact form (the home page, AH-133) opens it in a new tab and
// then shows our own thank-you page, thanks.html. Each link opens one of the repo's issue forms
// (.github/ISSUE_TEMPLATE/support_request.yml, contact.yml), which adds its label and the public warning itself, and
// fills its fields by their ids: a labels= parameter needs triage rights askers lack.
// Every page loads it once (AH-73): it wires the forms of the page it finds, and again each time transition.js swaps
// a page in ("ah:page"); the old form's listener leaves with the old page.
(() => {
  const NEW = "https://github.com/ricepillow3000/excel-anomaly-hunter/issues/new?template=";
  // Measured 2026-10-20: GitHub answers 414 past 8,190 characters, and a signed-out person's login page keeps the way
  // back only while the link still fits once encoded again (7,600 plain characters, 4,600 of emoji); past that, all
  // they typed is lost. So the long field is cut, at a whole character, until the encoded link fits with room to spare.
  const FITS = 7000;
  // one builder for both forms: the short fields as typed, the long one last, cut to fit
  function prefilled(template, fields, [key, long]) {
    const q = encodeURIComponent;
    const link = (text) => NEW + template + fields.map(([k, v]) => `&${k}=${q(v)}`).join("") + `&${key}=${q(text)}`;
    const all = [...long];
    let keep = all.length, url = link(long);
    while (q(url).length > FITS && keep) { keep = Math.floor(keep * 0.9); url = link(all.slice(0, keep).join("")); }
    return { url, cut: keep !== all.length };
  }

  const FORMS = [
    { form: "ticket", missing: "missing", result: "result", ready: "ready", cut: "cut", open: "open", thanks: "thanks",
      needed: [["summary", "a short summary"], ["details", "what happened"], ["clean", "the box that says it contains no key or private data"]],
      link: (v) => prefilled("support_request.yml", [["title", "[Support]: " + v("summary")], ["category", v("topic")], ["version", v("version")]], ["details", v("details")]) },
    { form: "note", missing: "c-missing", result: "c-result", ready: "c-ready", cut: "c-cut", open: "c-open", next: "thanks.html",
      needed: [["c-name", "a name"], ["c-message", "a message"]],
      link: (v) => prefilled("contact.yml", [["title", `[Contact]: ${v("c-topic")} from ${v("c-name")}`], ["name", v("c-name")], ["topic", v("c-topic")]], ["message", v("c-message")]) },
  ];

  function wire(root, F) {
    const form = root.querySelector("#" + F.form);
    if (!form) return;
    const $ = (id) => root.querySelector("#" + id);
    const missing = $(F.missing);
    const v = (id) => { const s = $(id).value.trim(); return s.toWellFormed ? s.toWellFormed() : s; }; // a lone surrogate would make encodeURIComponent throw
    const empty = (id) => ($(id).type === "checkbox" ? !$(id).checked : !v(id));
    // AH-114: on a phone with its keyboard open (390 x 420) the message sat under the button, off the screen, focus stayed
    // on the button and no field said it was the one missing. Each missing field now says so and is described by the
    // message, which moves to just under the first of them, and that field takes focus; a field lets go once it is filled
    const mark = (id, bad) => { const el = $(id);
      if (bad) { el.setAttribute("aria-invalid", "true"); el.setAttribute("aria-describedby", F.missing); }
      else { el.removeAttribute("aria-invalid"); el.removeAttribute("aria-describedby"); } };
    const recheck = () => {
      for (const [id] of F.needed) if ($(id).hasAttribute("aria-invalid") && !empty(id)) mark(id, false);
      if (!F.needed.some(([id]) => $(id).hasAttribute("aria-invalid"))) missing.hidden = true;
    };
    form.addEventListener("input", recheck);
    form.addEventListener("change", recheck);
    // AH-126: once the link to GitHub is followed, say what happens next (nothing reaches John until Submit is pressed on
    // GitHub), as a status a screen reader announces; preparing the question again takes it back. The contact form says
    // it on a page of its own (AH-133), reached the way a link reaches a page (transition.js), or loaded if that can't
    const thanks = F.thanks && $(F.thanks);
    const onward = () => { if (document.dispatchEvent(new CustomEvent("ah:go", { detail: F.next, cancelable: true }))) location.assign(F.next); };
    $(F.open).addEventListener("click", () => { if (thanks) thanks.hidden = false; else if (F.next) setTimeout(onward); });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (thanks) thanks.hidden = true;
      const need = F.needed.filter(([id]) => empty(id));
      for (const [id] of F.needed) mark(id, need.some(([n]) => n === id));
      missing.hidden = !need.length;
      $(F.result).hidden = true;
      if (need.length) {
        missing.textContent = "Please add " + need.map(([, w]) => w).join(", ") + ".";
        const first = $(need[0][0]);
        first.closest(".field, .confirm").after(missing);
        first.focus();
        missing.scrollIntoView({ block: "nearest" });
        return;
      }
      const { url, cut } = F.link(v);
      $(F.cut).hidden = !cut;
      // the link is described by what the box says above it, the cut note too when it shows (a hidden one would be read)
      $(F.open).setAttribute("aria-describedby", cut ? `${F.ready} ${F.cut}` : F.ready);
      $(F.open).href = url;
      // the contact form opens GitHub itself, in a new tab with no way back to this one, then shows the thank-you page.
      // A cut message, or a browser that keeps the tab from opening, gets the link to press instead, as the support form
      if (F.next && !cut) {
        const tab = window.open(url, "_blank");
        if (tab) { tab.opener = null; onward(); return; }
      }
      $(F.result).hidden = false;
      $(F.open).focus();
    });
  }

  const mount = (root) => { for (const F of FORMS) wire(root, F); };
  document.addEventListener("ah:page", (e) => mount((e.detail && e.detail.root) || document));
  mount(document);
})();
