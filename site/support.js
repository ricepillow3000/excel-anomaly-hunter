// The site has no server, so the form sends nothing: it builds a prefilled GitHub "new issue" link and shows it.
// The person reads it on GitHub and presses Submit there (public, needs a GitHub account).
// The link opens the repo's issue form (.github/ISSUE_TEMPLATE/support_request.yml), which adds the support label and
// the public warning itself, and fills its fields by their ids: a labels= parameter needs triage rights askers lack.
const ISSUES = "https://github.com/ricepillow3000/excel-anomaly-hunter/issues/new?template=support_request.yml";
// Measured 2026-10-20: GitHub answers 414 past 8,190 characters, and a signed-out person's login page keeps the way
// back only while the link still fits once encoded again (7,600 plain characters, 4,600 of emoji); past that, all
// they typed is lost. So the details are cut, at a whole character, until the encoded link fits with room to spare.
const FITS = 7000;
const form = document.getElementById("ticket");
const missing = document.getElementById("missing");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = (id) => { const s = document.getElementById(id).value.trim(); return s.toWellFormed ? s.toWellFormed() : s; }; // a lone surrogate would make encodeURIComponent throw
  const need = [["summary", "a short summary"], ["details", "what happened"]].filter(([id]) => !v(id)).map(([, w]) => w);
  if (!document.getElementById("clean").checked) need.push("the box that says it contains no key or private data");
  missing.hidden = !need.length;
  document.getElementById("result").hidden = !!need.length;
  if (need.length) { missing.textContent = "Please add " + need.join(", ") + "."; return; }
  const q = encodeURIComponent;
  const link = (details) => `${ISSUES}&title=${q("[Support]: " + v("summary"))}&category=${q(v("topic"))}&version=${q(v("version"))}&details=${q(details)}`;
  const all = [...v("details")];
  let keep = all.length, url = link(v("details"));
  while (q(url).length > FITS && keep) { keep = Math.floor(keep * 0.9); url = link(all.slice(0, keep).join("")); }
  document.getElementById("cut").hidden = keep === all.length;
  document.getElementById("open").href = url;
  document.getElementById("open").focus();
});
