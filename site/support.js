// The site has no server, so the form sends nothing: it builds a prefilled GitHub "new issue" link and shows it.
// The person reads it on GitHub and presses Submit there (public, needs a GitHub account).
const ISSUES = "https://github.com/ricepillow3000/excel-anomaly-hunter/issues/new";
const form = document.getElementById("ticket");
const missing = document.getElementById("missing");
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const v = (id) => document.getElementById(id).value.trim();
  const need = [["summary", "a short summary"], ["details", "what happened"]].filter(([id]) => !v(id)).map(([, w]) => w);
  if (!document.getElementById("clean").checked) need.push("the box that says it contains no key or private data");
  missing.hidden = !need.length;
  document.getElementById("result").hidden = !!need.length;
  if (need.length) { missing.textContent = "Please add " + need.join(", ") + "."; return; }
  const body = [`**What is this about?** ${v("topic")}`, `**Engine version** ${v("version") || "not given"}`, "", "**What happened**", v("details")]
    .join("\n").slice(0, 6000); // GitHub drops very long links
  const url = `${ISSUES}?labels=support&title=${encodeURIComponent("[Support]: " + v("summary"))}&body=${encodeURIComponent(body)}`;
  document.getElementById("open").href = url;
  document.getElementById("open").focus();
});
