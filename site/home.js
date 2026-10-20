// The home page's sample workspace (three scan states, filters, a detail box per flagged row) and the live SHA-256.
// Without this script the page still shows the findings and links to the release page for the checksum.
const ws = document.getElementById("preview");
const tabs = [...ws.querySelectorAll('[role="tab"]')];
const counts = [...ws.querySelectorAll(".typology .n")];
ws.querySelector(".tabs").hidden = false;

let tick;
const STAGES = ["READING SHEET DATA", "CHECKING TOTALS AND PRODUCTS", "COMPARING LABELS", "TESTING COLUMN LIMITS", "SCORING ROWS"];
function show(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute("aria-selected", on);
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
  }
  const state = tab.id.slice(2);
  ws.dataset.state = state;
  for (const n of counts) n.textContent = state === "found" ? n.dataset.n : state === "clean" ? "0" : "·";
  closeMatrix();
  clearInterval(tick);
  if (state === "busy") {
    let i = 0;
    const ticker = document.getElementById("ticker");
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
  const box = document.getElementById(btn.getAttribute("aria-controls"));
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
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && open) { const b = open.btn; closeMatrix(); b.focus(); } });
document.addEventListener("click", (e) => { if (open && !open.box.contains(e.target) && !e.target.closest("tr[data-kind]")) closeMatrix(); });
window.addEventListener("resize", closeMatrix);

// GitHub publishes each release file's SHA-256; showing it here keeps the number from going stale between releases.
fetch("https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((d) => {
    const exe = (d.assets || []).find((a) => a.name === "AnomalyHunter.exe");
    const hash = /^sha256:([0-9a-f]{64})$/.exec((exe && exe.digest) || "");
    if (!hash) return;
    document.getElementById("sha").textContent = hash[1];
    const tag = /^v\d+\.\d+\.\d+$/.test(d.tag_name) ? d.tag_name : "Latest";
    const date = /^\d{4}-\d{2}-\d{2}/.exec(d.published_at || "");
    const mb = Number.isFinite(exe.size) && exe.size > 0 ? Math.round(exe.size / 1e6) + " MB" : ""; // a size that isn't a number read "NaN MB"
    document.getElementById("rel").textContent = [tag + (date ? ", " + date[0] : ""), mb, "free"].filter(Boolean).join(" · ");
  })
  .catch(() => {});  // offline or rate-limited: the release-page link stays

// The hero's light: a faint navy glow sits under the pointer and a gold one follows a moment later, like a lamp
// being carried. Only with a mouse and when motion is welcome; otherwise both rest near the headline.
const hero = document.querySelector(".hero");
if (hero && matchMedia("(hover: hover) and (pointer: fine)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
  let tx = 50, ty = 22, gx = tx, gy = ty, raf = 0;
  const step = () => {
    gx += (tx - gx) * 0.08; gy += (ty - gy) * 0.08;
    hero.style.setProperty("--hx", gx + "%"); hero.style.setProperty("--hy", gy + "%");
    raf = Math.abs(tx - gx) + Math.abs(ty - gy) > 0.05 ? requestAnimationFrame(step) : 0;
  };
  hero.addEventListener("pointermove", (e) => {
    const r = hero.getBoundingClientRect();
    tx = ((e.clientX - r.left) / r.width) * 100; ty = ((e.clientY - r.top) / r.height) * 100;
    hero.style.setProperty("--gx", tx + "%"); hero.style.setProperty("--gy", ty + "%");
    if (!raf) raf = requestAnimationFrame(step);
  });
}
