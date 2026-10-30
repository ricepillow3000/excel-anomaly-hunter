// The website (site/): every link lands, nothing loads from outside, the scripts degrade safely. node tools/test_site.mjs
// adds the browser half with --browser (Playwright + Chromium; tools/check.py runs it with --e2e). No real network:
// GitHub's API is answered by stand-ins, and the support form must build its link without sending anything.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const PAGES = ["index.html", "privacy.html", "support.html"];
const SCRIPTS = ["boot.js", "motion.js", "field.js", "home.js", "support.js", "transition.js"];
const REPO = "https://github.com/ricepillow3000/excel-anomaly-hunter";
const API = "https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest";
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const html = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
const ids = (src) => [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
// one fixed pattern for every attribute, filtered by name: semgrep blocks a RegExp built from a variable (ReDoS)
const attr = (src, name) => [...src.matchAll(/\s([a-z-]+)="([^"]*)"/g)].filter((m) => m[1] === name).map((m) => m[2]);

// every page is one a visitor can reach: an old mock left in site/ (tool-preview.html) was served to anyone who guessed it
const linked = new Set(PAGES.flatMap((p) => attr(html[p], "href")).map((h) => h.split("#")[0]).filter((h) => h && !/^[a-z]+:/.test(h)));
for (const f of fs.readdirSync(SITE).filter((f) => f.endsWith(".html"))) assert.ok(PAGES.includes(f) && linked.has(f), `${f} is not linked from the site`);

for (const p of PAGES) {
  const src = html[p];
  const own = ids(src);
  assert.deepEqual(own.filter((id, i) => own.indexOf(id) !== i), [], `${p}: duplicate ids`);
  // every local link and file resolves, and every #anchor exists on the page it points to
  for (const ref of [...attr(src, "href"), ...attr(src, "src"), ...attr(src, "srcset").map((s) => s.split(" ")[0])]) {
    if (/^(https?:|mailto:)/.test(ref)) continue;
    const [file, anchor] = ref.split("#");
    const target = file || p;
    assert.ok(fs.existsSync(path.join(SITE, target)), `${p}: ${ref} points to a missing file`);
    if (anchor) assert.ok(ids(read(target)).includes(anchor), `${p}: ${ref} points to a missing anchor`);
  }
  for (const name of ["aria-controls", "aria-labelledby", "for"]) for (const id of attr(src, name)) assert.ok(own.includes(id), `${p}: ${name}="${id}" names no element`);
  // nothing loads from outside: fonts, styles, scripts and images are our own files; the CSP makes the browser hold to it
  for (const tag of src.match(/<(script|link|img)\b[^>]*>/g)) {
    const url = (/\s(?:src|href)="([^"]*)"/.exec(tag) || [])[1] || "";
    assert.ok(!/^(https?:)?\/\//.test(url), `${p}: loads ${url} from outside`);
  }
  assert.ok(!/<script>|<style|\sstyle="|\son[a-z]+="/.test(src), `${p}: inline script or style (the CSP would block it)`);
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${new URL(API).origin}; base-uri 'none'; form-action 'none'">`), `${p}: CSP missing or changed`);
  // axe 4.10, 2026-10-20: an empty header cell is read as nothing; the announcement line sat outside every landmark
  assert.ok(!/<th[^>]*><\/th>/.test(src), `${p}: an empty <th>`);
  assert.ok(/<aside class="notice-bar" aria-label="Announcement">/.test(src), `${p}: the announcement line is not a landmark`);
  // page transitions (AH-73): one swappable container a page, and every script on every page (the document never
  // reloads, so a page reached by a transition runs only what the first page loaded)
  assert.equal(src.match(/<main\b[^>]*>/g).join(), `<main id="page" data-page="${{ "index.html": "home", "privacy.html": "privacy", "support.html": "support" }[p]}">`, `${p}: not one <main id="page">`);
  assert.deepEqual(attr(src, "src").filter((s) => s.endsWith(".js")), SCRIPTS, `${p}: does not load every script once`);
}
// a box that scrolls sideways must take keyboard focus, or a keyboard user can't read its end
assert.ok(/<code class="line" tabindex="0">/.test(html["index.html"]), "the PowerShell line scrolls but can't be focused");

// motion (AH-83): content rises in as a .reveal-item, never scrubbed by the scroll (the old data-scrub hooks are gone), and
// every group of them that cascades is marked data-reveal-group
for (const p of PAGES) assert.ok(!/data-scrub/.test(html[p]), `${p}: a data-scrub hook is left`);
for (const p of ["index.html", "privacy.html"]) assert.ok(/class="[^"]*\breveal-item\b/.test(html[p]) && /\sdata-reveal-group[\s>]/.test(html[p]), `${p}: no reveal items in a group`);
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
// only transform, translate and opacity are ever animated: the GPU composites them without a layout or a paint (AH-85)
{
  const flat = (v) => { let x = v; while (/\([^()]*\)/.test(x)) x = x.replace(/\([^()]*\)/g, ""); return x; };
  const moved = [...css.matchAll(/(?:^|[;{\s])transition(?:-property)?\s*:\s*([^;}]+)/g)].flatMap((m) => flat(m[1]).split(",").map((t) => t.trim().split(/\s+/)[0]));
  for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) moved.push(...[...m[1].matchAll(/\{([^{}]*)\}/g)].flatMap((b) => [...b[1].matchAll(/([a-z-]+)\s*:/g)].map((d) => d[1])));
  assert.ok(moved.length >= 6, `styles.css: the animated properties were not found (${moved})`);
  for (const prop of moved) assert.ok(["transform", "translate", "opacity"].includes(prop), `styles.css animates ${prop}, which the GPU cannot composite alone`);
}
for (const url of css.match(/url\([^)]*\)/g)) assert.ok(/^url\("(data:|assets\/)/.test(url), `styles.css loads ${url}`);
const used = PAGES.map((p) => html[p]).join("") + SCRIPTS.map(read).join("");
const classes = new Set(used.match(/class="[^"]*"/g).flatMap((c) => c.slice(7, -1).split(/\s+/)));
for (const c of new Set(css.replace(/url\([^)]*\)/g, "").match(/\.[a-zA-Z_][\w-]*/g))) assert.ok(classes.has(c.slice(1)), `styles.css styles ${c}, which no page uses`);

for (const f of SCRIPTS) {
  const src = read(f);
  new vm.Script(src, { filename: f }); // a syntax error throws here
  // dynamic values reach the page only as text: GitHub's answer and what people type are never parsed as HTML
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), `${f}: writes HTML`);
  // reading the GPU's pixels back stalls the page (and Chromium warns); the field only ever draws (AH-72)
  assert.ok(!/readPixels|getImageData|toDataURL/.test(src), `${f}: reads pixels back`);
  for (const url of src.match(/https?:\/\/[^"'`\s)]+/g) || []) assert.ok(url === API || url.startsWith(REPO + "/issues/new"), `${f}: talks to ${url}`);
}
console.log(`website static check passed (${PAGES.length} pages, ${SCRIPTS.length} scripts)`);
if (!process.argv.includes("--browser")) process.exit(0);

// ---- in a browser: the pages served as they are on the web, each at a desktop and a phone width ----
const req = createRequire(import.meta.url);
const pw = await import(process.env.PLAYWRIGHT || "playwright").catch(() => import(pathToFileURL(req.resolve("playwright", { paths: [process.env.NODE_PATH || ""] })).href));
const { chromium } = pw.default || pw;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".woff2": "font/woff2" };
const server = http.createServer((q, s) => {
  const f = path.join(SITE, decodeURIComponent(new URL(q.url, "http://x").pathname).replace(/^\/$/, "/index.html"));
  if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" }); s.end(fs.readFileSync(f));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
// Headless Chromium composites in software, so it reads the first WebGL frame any page shows back from SwiftShader and
// logs "GPU stall due to ReadPixels" four times, once per browser process, though the page never calls readPixels (the
// static check above keeps it that way). A blank page shows one first, outside the console check. Measured 2026-10-30:
// --use-angle=swiftshader also silences it but sends all compositing through SwiftShader, 43 s to 230 s (AH-72)
{
  const warm = await browser.newPage();
  const said = new Promise((ok) => { let n = 0; warm.on("console", (m) => { if (/ReadPixels/.test(m.text()) && ++n === 4) ok(); }); });
  await warm.evaluate(() => { const c = document.body.appendChild(document.createElement("canvas")), gl = c.getContext("webgl2");
    const f = () => { gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); requestAnimationFrame(f); }; f(); });
  await Promise.race([said, new Promise((ok) => setTimeout(ok, 5000))]);
  await warm.close();
}
const release = { tag_name: "v0.1.102", published_at: "2026-10-20T05:15:43Z", assets: [{ name: "AnomalyHunter.exe", size: 81256476, digest: "sha256:" + "ab".repeat(32) }] };
const json = (body, status = 200) => (r) => r.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });

// Headless Chromium draws WebGL with SwiftShader, so field.js shows its one still picture there (AH-85). The checks of the
// field's own motion (its pointer bend, its scroll-linked shape, its inversion on the band) name a GPU instead
const GPU = () => { const get = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (k) { return k === 0x1F01 || k === 0x9246 ? "ANGLE (a test GPU)" : get.call(this, k); }; };
async function open(file, { width = 1280, height = 900, api = json(release), motion = "no-preference", until = "networkidle", init = null, gpu = false, js = true, setup = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, javaScriptEnabled: js });
  const page = await ctx.newPage();
  if (gpu) await page.addInitScript(GPU);
  if (init) await page.addInitScript(init);
  const problems = [], outside = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/^Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("response", (r) => { if (r.url().startsWith(BASE) && r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); }); // console hides these above
  page.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("data:")) outside.push(r.url()); });
  await page.route("https://api.github.com/**", api);
  await page.route(/^https:\/\/(?!api\.github\.com)/, (r) => r.abort()); // a page must never reach anywhere else
  if (setup) await setup(page);
  await page.goto(BASE + file, { waitUntil: until });
  return { ctx, page, problems, outside };
}
const done = async ({ ctx, problems, outside }, label, allowed = []) => {
  assert.deepEqual(problems, [], `${label}: console errors`);
  assert.deepEqual(outside.filter((u) => !allowed.includes(u)), [], `${label}: requests outside the site`);
  await ctx.close();
};

// ---- motion (AH-72): helpers to read what the page shows ----
// a PNG from page.screenshot as RGBA rows (8-bit, not interlaced, which is what Chromium writes)
function png(buf) {
  let i = 8, w = 0, h = 0, ch = 4; const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString("latin1", i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ch = { 2: 3, 6: 4 }[data[9]]; }
    if (type === "IDAT") idat.push(data);
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(w * h * 4), row = w * ch, prev = Buffer.alloc(row), cur = Buffer.alloc(row);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (row + 1)], src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    for (let x = 0; x < row; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      cur[x] = (src[x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 255;
    }
    for (let x = 0; x < w; x++) for (let k = 0; k < 4; k++) px[(y * w + x) * 4 + k] = k < ch ? cur[x * ch + k] : 255;
    cur.copy(prev);
  }
  return { w, h, px };
}
// the field's own pixels: everything else hidden for a moment over a plain colour. The page's own grain scrolls with
// it, so a screenshot of the page could never show whether the field itself held still
async function fieldShot(p, bg = "#fff") {
  await p.evaluate((bg) => { document.body.style.visibility = "hidden"; document.body.style.background = bg; document.getElementById("field").style.visibility = "visible"; }, bg);
  const shot = await p.locator("#field").screenshot();
  await p.evaluate(() => { document.body.style.visibility = document.body.style.background = document.getElementById("field").style.visibility = ""; });
  return shot;
}
// every hooked element's computed pose, and whether it is at rest
const poses = (p, sel) => p.$$eval(sel, (es) => es.map((e) => { const c = getComputedStyle(e); return { tf: c.transform, tr: c.translate, op: c.opacity }; }));
const atRest = (ps) => ps.every((x) => x.tf === "none" && x.tr === "none" && x.op === "1");
// every motion hook: the entrance, the reveal, the scroll-linked decoration
const HOOKED = "[data-enter], .reveal-item, .rule, [data-depth]";

for (const width of [1280, 390]) {
  for (const file of PAGES) {
    const t = await open(file, { width });
    const p = t.page;
    assert.equal(await p.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${file} at ${width}px scrolls sideways`);
    // every link in the bar, the announcement line and the footer is visible and lands on its page and anchor
    const links = await p.$$eval("header a, footer a, .notice-bar a", (as) => as.map((a) => a.getAttribute("href")));
    for (const [i, href] of links.entries()) {
      if (/^https?:/.test(href)) continue;
      await p.goto(BASE + file);
      const a = p.locator("header a, footer a, .notice-bar a").nth(i);
      assert.ok(await a.isVisible(), `${file} at ${width}px: ${href} is hidden`);
      await a.click();
      const want = new URL(href, BASE + file);
      await p.waitForURL((u) => u.pathname === want.pathname || (want.pathname === "/index.html" && u.pathname === "/"));
      if (want.hash) assert.ok(await p.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }, want.hash.slice(1)), `${file}: ${href} does not scroll to its anchor`);
    }
    await done(t, `${file} at ${width}px`, [API]); // the links lead to the home page, which asks GitHub for the checksum
  }
}

// the download's logo: the original Spear and Banner (docs/design/logo/mark-80.svg; John brought it back on 2026-10-30)
// directly above the Download button, shown whole: its five parts present and drawn inside the logo's box, each painted
// in exactly the original's colors (the banner navy, the spear and bar in body and lit gold, the emblem paper), the logo, its
// parts and the stage around it opaque and every part in place by the end of the page (AH-72's scroll motion must finish
// there), and with no animation at all when motion is unwelcome
const logo = (page) => page.evaluate(() => {
  const l = document.querySelector("#download .logo"), b = document.querySelector('#download a[href$="AnomalyHunter.exe"]');
  const r = l.getBoundingClientRect(), q = b.getBoundingClientRect();
  const names = ["spear", "bar", "drape", "banner", "emblem"], part = (n) => l.querySelector(`[data-part="${n}"]`);
  const drawn = names.filter((n) => { const g = part(n), s = g && g.getBoundingClientRect();
    return s && s.width > 0 && s.height > 0 && s.left >= r.left && s.right <= r.right && s.top >= r.top && s.bottom <= r.bottom; });
  // the fills a part paints (a stroke-only line says fill none); <use> copies the finial's halves with their own fill
  const fills = (n) => [...new Set([...part(n).querySelectorAll("path, rect, circle, use")].map((e) => getComputedStyle(e).fill))].filter((f) => f !== "none").sort().join(" ");
  const up = []; for (let e = l.parentElement; e && e.id !== "download"; e = e.parentElement) up.push(e);
  const parts = [...up, l, ...l.querySelectorAll("*")].map((c) => getComputedStyle(c));
  return { parts: drawn.join(), banner: fills("banner"), spear: fills("spear"), bar: fills("bar"), drape: fills("drape"), emblem: fills("emblem"),
    above: r.width >= 64 && r.height >= 64 && r.bottom <= q.top && q.top - r.bottom <= 64 && r.left < q.right && q.left < r.right,
    shown: parts.every((c) => c.opacity === "1" && c.visibility === "visible" && c.display !== "none"),
    placed: parts.slice(up.length).every((c) => c.transform === "none"), animated: parts.some((c) => c.animationName !== "none") };
});
const GOLD = "rgb(156, 122, 53) rgb(184, 149, 74)"; // #9C7A35 body, #B8954A lit
const WHOLE = { parts: "spear,bar,drape,banner,emblem", banner: "rgb(12, 25, 56)", spear: GOLD, bar: GOLD, drape: "rgb(156, 122, 53)", emblem: "rgb(244, 241, 234)",
  above: true, shown: true, placed: true };
// brought to the middle of the screen, the banner and the blade are what the eye gets there: nothing covers them
const onTop = (page) => page.evaluate(async () => {
  const l = document.querySelector("#download .logo"); l.scrollIntoView({ block: "center" });
  await new Promise((go) => setTimeout(go, 300));
  const at = (x, y) => { const e = document.elementFromPoint(x, y); return e && l.contains(e) ? e.closest("[data-part]").dataset.part : String(e && e.tagName); };
  const ban = l.querySelector('[data-part="banner"]').getBoundingClientRect(), sp = l.querySelector('[data-part="spear"]').getBoundingClientRect();
  return [at(ban.left + 3, ban.top + ban.height * 0.6), at(sp.left + sp.width / 2, sp.top + sp.height * 0.15)].join();
});

// the sample workspace: tabs, arrow keys, filters, and a detail box per flagged row
{
  const t = await open("index.html", { gpu: true });
  const p = t.page;
  const state = () => p.evaluate(() => ({ state: document.getElementById("preview").dataset.state, counts: [...document.querySelectorAll(".typology .n")].map((n) => n.textContent).join(" "),
    open: [...document.querySelectorAll(".matrix")].filter((m) => !m.hidden).map((m) => m.id).join(), focus: document.activeElement.id || document.activeElement.className }));
  assert.equal((await state()).counts, "7 2 2 1 5");
  await p.click("#t-busy"); assert.equal((await state()).state, "busy");
  await p.click("#t-clean"); assert.deepEqual(await state(), { state: "clean", counts: "0 0 0 0 0", open: "", focus: "t-clean" });
  await p.keyboard.press("ArrowRight"); assert.equal((await state()).focus, "t-found");
  await p.keyboard.press("ArrowLeft"); assert.equal((await state()).focus, "t-clean");
  await p.click('.typology button[data-kind="label"]'); // a filter brings the findings back
  assert.equal((await state()).state, "found");
  const lit = () => p.$$eval(".grid tbody tr:not(.skip)", (rs) => rs.filter((r) => getComputedStyle(r).opacity === "1").map((r) => r.querySelector("th").textContent).join());
  assert.equal(await lit(), "31");
  await p.click('.typology button[data-kind="time"]'); assert.equal(await lit(), "5,21,22,41,57");
  await p.click('.typology button[data-kind="all"]');
  // open moves focus into the box (it is a dialog); Escape and Close give it back to the row; a click outside closes it
  await p.focus('.rowbtn[aria-controls="m11"]'); await p.keyboard.press("Enter");
  assert.deepEqual(await state(), { state: "found", counts: "7 2 2 1 5", open: "m11", focus: "m-close" });
  await p.keyboard.press("Escape"); assert.deepEqual([(await state()).open, await p.evaluate(() => document.activeElement.textContent)], ["", "11"]);
  await p.click('tr[data-kind="label"] td.why'); assert.equal((await state()).open, "m31");
  await p.click("#m31 dl"); assert.equal((await state()).open, "m31");
  await p.click("#m31 .m-close"); assert.deepEqual([(await state()).open, await p.evaluate(() => document.activeElement.textContent)], ["", "31"]);
  await p.click('.rowbtn[aria-controls="m22"]'); await p.click("h1"); assert.equal((await state()).open, "");
  await p.click('.rowbtn[aria-controls="m5"]'); await p.click('.rowbtn[aria-controls="m5"]'); assert.equal((await state()).open, "");
  // the Scanning ticker stops when its tab is left
  await p.click("#t-busy"); await p.click("#t-found");
  const ticker = await p.textContent("#ticker"); await p.waitForTimeout(1000); assert.equal(await p.textContent("#ticker"), ticker);
  // the field's bend follows the pointer (field.js; it replaced the hero's cursor light), then stops asking for frames:
  // no loop runs while nothing moves
  await p.evaluate(() => { window.frames_ = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => (window.frames_++, raf(f)); });
  await p.mouse.move(200, 300); await p.mouse.move(900, 500, { steps: 8 });
  await p.waitForTimeout(2500);
  const settled = await p.evaluate(() => window.frames_); await p.waitForTimeout(1000);
  assert.ok(settled > 0 && (await p.evaluate(() => window.frames_)) === settled, "the cursor light keeps a frame loop running when idle");
  // ... and on a busy machine too (AH-22): with a frame only every 50 ms (20 a second, what a loaded box gave), it settles
  // in the same 2.5 s. It eased 8% a frame, so it needed ~90 frames whatever the frame rate: 1.5 s at 60 fps, 4.5 s at 20
  await p.evaluate(() => { window.frames_ = 0; window.requestAnimationFrame = (f) => (window.frames_++, setTimeout(() => f(performance.now()), 50)); });
  await p.mouse.move(300, 200); await p.mouse.move(1000, 450, { steps: 8 });
  await p.waitForTimeout(2500);
  const slow = await p.evaluate(() => window.frames_); await p.waitForTimeout(1000);
  assert.ok(slow > 0 && (await p.evaluate(() => window.frames_)) === slow, `at 20 frames a second the cursor light was still moving after 2.5 s (${slow} frames)`);
  // the page's rhythm: paper at the top, the dark band at the checks, the download's panel at the bottom, and back on
  // the way up. Read from the section under the middle of the screen at its left edge, as a visitor sees it
  const behind = () => p.evaluate(() => { let e = document.elementFromPoint(2, innerHeight / 2);
    while (e && getComputedStyle(e).backgroundColor === "rgba(0, 0, 0, 0)") e = e.parentElement;
    return getComputedStyle(e || document.body).backgroundColor; });
  assert.equal(await behind(), "rgb(247, 245, 240)");
  await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop)); await p.waitForTimeout(100);
  assert.equal(await behind(), "rgb(12, 25, 56)");
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(100);
  assert.equal(await behind(), "rgb(239, 236, 228)");
  // ... and the logo above the Download button is whole once its stage has risen into place: five parts drawn, in their
  // colors, opaque and in place
  await p.waitForSelector("#download .stage[data-settled]", { state: "attached", timeout: 3000 });
  const whole = await logo(p); delete whole.animated;
  assert.deepEqual(whole, WHOLE);
  assert.equal(await onTop(p), "banner,spear");
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(100);
  assert.equal(await behind(), "rgb(247, 245, 240)");
  assert.equal(await p.textContent("#sha"), "ab".repeat(32));
  assert.equal(await p.textContent("#rel"), "v0.1.102, 2026-10-20 · 81 MB · free");
  await done(t, "workspace", [API]);
}
{ // with reduced motion: no cursor light, no entrance, no scroll motion, one still frame of the field; the logo sits finished
  const t = await open("index.html", { motion: "reduce" });
  const hooked = HOOKED;
  assert.ok(atRest(await poses(t.page, hooked)), "an element moves on load under reduced motion");
  assert.equal(await t.page.evaluate(() => document.documentElement.dataset.gl), "on");
  const still = await fieldShot(t.page);
  await t.page.mouse.move(300, 300); await t.page.mouse.move(800, 400, { steps: 4 });
  assert.equal(await t.page.evaluate(() => document.querySelector(".hero").style.cssText), "");
  for (const y of [1400, 2600]) {
    await t.page.evaluate((y) => scrollTo(0, y), y); await t.page.waitForTimeout(300);
    assert.ok(atRest(await poses(t.page, hooked)), `an element moves at scroll ${y} under reduced motion`);
    assert.ok((await fieldShot(t.page)).equals(still), `the field moves at scroll ${y} under reduced motion`);
  }
  assert.equal(await t.page.evaluate(() => document.getAnimations().length), 0, "an animation runs under reduced motion");
  assert.deepEqual(await logo(t.page), { ...WHOLE, animated: false });
  assert.equal(await onTop(t.page), "banner,spear");
  assert.equal(await t.page.evaluate(() => document.querySelector("#download .logo").getAnimations({ subtree: true }).length), 0, "the logo moves under reduced motion");
  await done(t, "reduced motion", [API]);
}

// the entrance (AH-72): the headlines and the text fly in from the left, the sample workspace rises, all at rest within
// 1.4 s, timed by the clock: also with a frame only every 50 ms (a loaded machine, AH-22)
for (const slow of [false, true]) {
  const label = `entrance${slow ? " at 20 frames a second" : ""}`;
  const t = await open("index.html", { until: "domcontentloaded", init: slow ? () => { window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 50); } : null });
  const t0 = Date.now(), p = t.page;
  await p.waitForTimeout(60);
  const early = await p.evaluate(() => ({ head: new DOMMatrix(getComputedStyle(document.querySelector(".hero-head")).transform).e,
    fig: new DOMMatrix(getComputedStyle(document.getElementById("preview")).transform).f }));
  assert.ok(early.head < 0 && early.fig > 0, `${label}: nothing is on its way in just after load (${JSON.stringify(early)})`);
  await p.waitForTimeout(1600 - (Date.now() - t0));
  assert.ok(atRest(await poses(p, "[data-enter]")), `${label}: not at rest by 1.6 s`);
  assert.equal(await p.evaluate(() => document.documentElement.hasAttribute("data-ah")), false, `${label}: the page is still marked for the entrance`);
  await done(t, label, [API]);
}

// the scroll-linked decoration (AH-84) is the scroll position's alone: the hairlines drawn across (scaleX) and the labels'
// and headlines' drift (translate). At a spot where a row of hairlines is partly drawn it holds exactly still when the
// scrolling stops, and comes back exactly the same after a trip to the bottom and back; a little further down it is
// further along, step by step. Content is no longer scrubbed: it rises in once (the reveal, below). The field behind is
// a function of the scroll too (with a GPU), so its pixels must hold and return the same way
const decoration = (p) => p.$$eval(".rule, [data-depth]", (es) => es.map((e) => {
  const c = getComputedStyle(e);
  // the drift as px: Chromium gives a translate as calc(a% + b px), a% of the element's own height
  const terms = c.translate === "none" ? [] : c.translate.replace(/calc\(|\)/g, "").replace(/ - /g, " -").replace(/ \+ /g, " ").trim().split(/\s+/).slice(1);
  const y = terms.reduce((s, v) => s + (v.endsWith("%") ? (parseFloat(v) / 100) * e.offsetHeight : parseFloat(v) || 0), 0);
  // a headline's own transform is its reveal's, not the decoration's
  const rule = e.classList.contains("rule");
  return { rule, sx: rule && c.transform !== "none" ? new DOMMatrix(c.transform).a : 1, y: Math.round(y * 1000) / 1000, tf: rule ? c.transform : null, tr: c.translate };
}));
const layoutTop = (p, sel) => p.evaluate((sel) => { let t = 0; for (let e = document.querySelector(sel); e; e = e.offsetParent) t += e.offsetTop; return t; }, sel);
async function scrollLinked(p, label, field) {
  const snap = async () => ({ deco: JSON.stringify(await decoration(p)), field: field ? (await fieldShot(p)).toString("base64") : "" });
  const go = async (y) => { await p.evaluate((y) => scrollTo(0, y), y); await p.waitForTimeout(400); };
  const vh = await p.evaluate(() => innerHeight);
  // a quarter of the way through the screen: the checks' first row of hairlines, their second row, the three steps
  const spots = [];
  for (const sel of [".num-grid li:nth-child(1) .rule", ".num-grid li:nth-child(5) .rule", ".steps li:nth-child(1) .rule"]) spots.push(Math.round((await layoutTop(p, sel)) - vh * 0.75));
  for (const y of spots) {
    await go(0); await go(y);
    const a = await snap();
    assert.ok(JSON.parse(a.deco).some((x) => x.rule && x.sx > 0 && x.sx < 1), `${label}, scroll ${y}: no hairline is partly drawn`);
    await p.waitForTimeout(700);
    assert.deepEqual(await snap(), a, `${label}, scroll ${y}: still moving 700 ms after the scrolling stopped`);
    await go(await p.evaluate(() => document.documentElement.scrollHeight)); await go(y);
    assert.deepEqual(await snap(), a, `${label}, scroll ${y}: not the same after a trip to the bottom and back`);
  }
  // step by step: the second hairline of the first row draws further, and the IT headline drifts further, at each of
  // three nearby positions
  const sxs = [], ys = [];
  for (const y of [spots[0] - 20, spots[0], spots[0] + 20]) { await go(y); sxs.push((await decoration(p)).filter((x) => x.rule)[1].sx); }
  const it = await p.evaluate(() => Math.round(document.getElementById("it").offsetTop - innerHeight * 0.6));
  const at = await p.evaluate(() => [...document.querySelectorAll(".rule, [data-depth]")].indexOf(document.querySelector("#it .sec-title")));
  for (const y of [it - 20, it, it + 20]) { await go(y); ys.push((await decoration(p))[at].y); }
  assert.ok(sxs.every((x) => x > 0 && x < 1) && sxs[0] < sxs[1] && sxs[1] < sxs[2], `${label}: the hairline does not follow the scroll: ${sxs}`);
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2] && Math.abs(ys[1]) < 40, `${label}: the headline's drift does not follow the scroll: ${ys}`);
  return { spots, sxs, ys };
}
let decoCss = null;
{
  // no visitor's pointer here: Playwright's mouse rests at 0,0 and Chromium sends a mousemove there after load, which
  // reached field.js in some runs and bent the corner (5752 inked pixels against 5812). The pointer is tested above
  const t = await open("index.html", { gpu: true, init: () => addEventListener("pointermove", (e) => e.stopImmediatePropagation(), true) });
  const p = t.page;
  await p.waitForTimeout(1600); // the entrance is over
  assert.deepEqual(await p.evaluate(() => [document.documentElement.dataset.gl, document.documentElement.dataset.scroll]), ["on", "css"], "the field has no WebGL context, or the decoration no scroll timeline");
  await p.waitForSelector('#field[data-state="settled"]', { state: "attached", timeout: 5000 }); // faded in, nothing easing
  const top = png(await fieldShot(p));
  const ink = top.px.filter((v, i) => i % 4 === 0 && v < 235).length;
  assert.ok(ink > 0.005 * top.w * top.h && ink < 0.25 * top.w * top.h, `the field is not a fine drawing (${ink} of ${top.w * top.h} pixels inked)`);
  decoCss = await scrollLinked(p, "scroll timeline", true);
  await p.evaluate((y) => scrollTo(0, y), decoCss.spots[0]); await p.waitForTimeout(400);
  decoCss.poses = await decoration(p);
  // the field inverts on the dark band: over black, its paper lines show inside the band's rows and nowhere else
  await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop - innerHeight / 2)); await p.waitForTimeout(400);
  const band = png(await fieldShot(p, "#000"));
  const lit = (y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < band.w; x++) { const i = (y * band.w + x) * 4; n += band.px[i + 1] > 12 && band.px[i + 1] - band.px[i + 2] < 20; } return n; }; // cream, not the gold level (its blue is far under its green)
  const half = Math.round(band.h / 2);
  assert.ok(lit(half + 4, band.h) > 0.005 * band.w * (band.h - half) && lit(0, half - 4) < 0.001 * band.w * half, "the field does not invert on the dark band");
  await done(t, "scroll motion", [API]);
}
{ // a browser with no scroll timeline: motion.js plays the same decoration from its one scroll reader, the same poses as
  // the CSS timeline's, and asks for no frame once the scrolling stops
  const t = await open("index.html", { init: () => { const has = CSS.supports.bind(CSS); CSS.supports = (...a) => (/animation-timeline/.test(a.join(" ")) ? false : has(...a)); } });
  const p = t.page;
  await p.waitForTimeout(1600);
  assert.equal(await p.evaluate(() => document.documentElement.dataset.scroll), "js");
  const js = await scrollLinked(p, "scroll reader", false);
  await p.evaluate((y) => scrollTo(0, y), decoCss.spots[0]); await p.waitForTimeout(400);
  const same = (await decoration(p)).map((x, i) => [Math.abs(x.sx - decoCss.poses[i].sx), Math.abs(x.y - decoCss.poses[i].y)]);
  assert.ok(same.every(([a, b]) => a < 0.01 && b < 1), `the scroll reader's poses differ from the scroll timeline's: ${JSON.stringify(same)}`);
  await p.evaluate(() => { window.frames_ = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => (window.frames_++, raf(f)); });
  await p.waitForTimeout(1000);
  assert.equal(await p.evaluate(() => window.frames_), 0, "the scroll reader asks for frames while nothing moves");
  console.log(`scroll-linked decoration: hairline scaleX ${decoCss.sxs.map((x) => x.toFixed(4)).join(" < ")} and drift ${decoCss.ys.map((x) => x.toFixed(2)).join(" < ")} px at three nearby positions (timeline); scroll reader ${js.sxs.map((x) => x.toFixed(4)).join(" < ")}, worst difference from the timeline ${Math.max(...same.map((x) => x[0])).toFixed(4)} scaleX, ${Math.max(...same.map((x) => x[1])).toFixed(3)} px`);
  await done(t, "scroll reader", [API]);
}
{ // no WebGL: no canvas, the paper's CSS texture is the background, and the console stays clean
  const t = await open("index.html", { init: () => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k, o) { return /webgl/.test(k) ? null : get.call(this, k, o); }; } });
  assert.deepEqual(await t.page.evaluate(() => [document.documentElement.dataset.gl, !!document.getElementById("field")]), ["off", false]);
  await done(t, "no WebGL", [API]);
}

// ---- the reveal (AH-83): content waits below its place, see-through, and rises into place once, the first time it
// scrolls into view; a group's items start --stagger (50 ms) apart, up to --stagger-cap steps; only opacity and transform
// move, so the reveal runs with no layout at all ----
const tokens = (p) => p.evaluate(() => { const c = getComputedStyle(document.documentElement), g = (n) => c.getPropertyValue(n).trim();
  return { ease: g("--ease-out"), rise: parseFloat(g("--reveal-rise")), dur: parseFloat(g("--reveal-dur")), stagger: parseFloat(g("--stagger")), cap: parseFloat(g("--stagger-cap")) }; });
const revealed = (p, sel) => p.$$eval(sel, (es) => es.map((e) => { const c = getComputedStyle(e), m = new DOMMatrix(c.transform);
  return { op: c.opacity, tf: c.transform, x: m.e, y: m.f, will: c.willChange, delay: Math.round(parseFloat(c.transitionDelay) * 1000), ease: c.transitionTimingFunction,
    dur: Math.round(parseFloat(c.transitionDuration) * 1000), revealed: e.hasAttribute("data-revealed"), settled: e.hasAttribute("data-settled") }; }));
let reveal = null;
{
  const t = await open("index.html", { width: 1440, init: () => { window.__unobserved = []; const un = IntersectionObserver.prototype.unobserve;
    IntersectionObserver.prototype.unobserve = function (el) { window.__unobserved.push(el); return un.call(this, el); }; } });
  const p = t.page, GRID = ".num-grid > .reveal-item";
  const tok = await tokens(p);
  assert.ok(tok.ease === "cubic-bezier(.16, 1, .3, 1)" && tok.stagger === 50 && tok.rise >= 20 && tok.rise <= 30 && tok.cap >= 1, `the motion tokens: ${JSON.stringify(tok)}`);
  // (a) before any scrolling: the checks below the fold wait one --reveal-rise down, see-through, on their own layer
  const before = await revealed(p, GRID);
  assert.equal(await p.evaluate(() => document.documentElement.hasAttribute("data-js")), true, "boot.js did not mark the page");
  assert.ok(before.length === 8 && before.every((x) => x.op === "0" && x.x === 0 && x.y === tok.rise && /transform/.test(x.will) && /opacity/.test(x.will) && !x.revealed),
    `the checks before they are seen: ${JSON.stringify(before[0])}`);
  // scrolled into view in one step once the hero's entrance is over, traced: the window runs from the scroll to the last
  // item's transitionend
  await p.waitForFunction(() => document.getAnimations().every((a) => a.timeline !== document.timeline), null, { timeout: 3000 });
  await p.evaluate(() => { let n = 0; addEventListener("transitionend", (e) => { if (e.propertyName === "opacity" && e.target.matches(".num-grid > .reveal-item") && ++n === 8) console.timeStamp("reveal-end"); }, true); });
  await browser.startTracing(p, { categories: ["devtools.timeline"] });
  await p.evaluate(() => { const g = document.querySelector(".num-grid"); let top = 0; for (let e = g; e; e = e.offsetParent) top += e.offsetTop;
    console.timeStamp("reveal-start"); scrollTo(0, top - 120); });
  await p.waitForTimeout(100);
  const rising = await revealed(p, GRID);
  await p.waitForFunction(() => document.querySelectorAll(".num-grid > [data-settled]").length === 8, null, { timeout: 4000 });
  await p.waitForTimeout(300);
  const events = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const mark = (m) => events.find((e) => e.name === "TimeStamp" && e.args && e.args.data && e.args.data.message === m);
  const s0 = mark("reveal-start"), s1 = mark("reveal-end"), last = Math.max(...events.map((e) => e.ts || 0));
  assert.ok(s0 && s1, "the trace has no reveal window");
  const count = (name, to) => events.filter((e) => e.name === name && e.pid === s0.pid && e.tid === s0.tid && e.ts >= s0.ts && e.ts <= to).length;
  // (b) at rest, in place, with transition delays 0, 50, 100 ms ... in page order, held at the cap after it
  const after = await revealed(p, GRID);
  const want = after.map((x, i) => Math.min(i, tok.cap) * tok.stagger);
  assert.ok(rising.every((x) => x.revealed) && rising.some((x) => +x.op < 1 || x.y > 0), `the checks did not rise in: ${JSON.stringify(rising[7])}`);
  assert.ok(after.every((x) => x.op === "1" && x.tf === "none"), `the checks are not at rest: ${JSON.stringify(after)}`);
  assert.deepEqual(after.map((x) => x.delay), want, "the checks' transition delays");
  assert.ok(want.length > tok.cap, "the checks never reach the stagger's cap");
  assert.ok(after.every((x) => x.ease === "cubic-bezier(0.16, 1, 0.3, 1), cubic-bezier(0.16, 1, 0.3, 1)" && x.dur === tok.dur), `the reveal's curve or length: ${after[0].ease} ${after[0].dur}`);
  // (c) settled: the layer is let go
  assert.ok(after.every((x) => x.settled && x.will === "auto"), `will-change after the reveal: ${after.map((x) => x.will)}`);
  // (d) revealed once: unobserved, and a trip away and back does not hide it again
  assert.equal(await p.evaluate(() => [...document.querySelectorAll(".num-grid > .reveal-item")].filter((e) => window.__unobserved.includes(e)).length), 8, "the observer still watches a revealed check");
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop)); await p.waitForTimeout(50);
  assert.ok((await revealed(p, GRID)).every((x) => x.op === "1" && x.tf === "none"), "a check hid again after a trip away and back");
  reveal = { delays: after.map((x) => x.delay), layout: count("Layout", s1.ts), paint: count("Paint", s1.ts), layoutAll: count("Layout", last), paintAll: count("Paint", last), ms: Math.round((s1.ts - s0.ts) / 1000) };
  // composite only: no layout from the scroll to the last transitionend; letting go of will-change afterwards lays the
  // page out once a batch (two here: the checks' headline and lede above the grid are one look, the grid another at most)
  assert.equal(reveal.layout, 0, `the reveal laid the page out ${reveal.layout} times`);
  assert.ok(reveal.layoutAll <= 2, `settling the reveal laid the page out ${reveal.layoutAll} times`);
  await done(t, "reveal", [API]);
}
{ // an #anchor lands on something visible: the target's items are revealed at once, and those above it are already there
  const t = await open("index.html#download", { width: 1440, until: "load" });
  const p = t.page;
  await p.waitForTimeout(150);
  const r = await p.evaluate(() => ({ stage: document.querySelector("#download .stage").hasAttribute("data-revealed"), above: document.querySelector("#it .sec-title").hasAttribute("data-revealed"),
    below: document.querySelector(".steps .aside").hasAttribute("data-revealed") }));
  assert.ok(r.stage && r.above, `index.html#download: ${JSON.stringify(r)}`);
  await p.evaluate(() => { location.hash = "#checks"; }); await p.waitForTimeout(50);
  assert.ok(await p.evaluate(() => [...document.querySelectorAll("#checks .reveal-item")].every((e) => e.hasAttribute("data-revealed"))), "a jump to #checks left its items hidden");
  await done(t, "reveal at an anchor", [API]);
}
// no JavaScript at all, or motion.js failing to arrive: every block is shown, in place, and all the text can be read
const readable = (p) => p.evaluate(() => {
  const hooked = [...document.querySelectorAll(".reveal-item, [data-enter]")].map((e) => getComputedStyle(e)).filter((c) => c.opacity !== "1" || c.transform !== "none").length;
  let hidden = 0, texts = 0;
  for (const e of document.body.querySelectorAll("*")) {
    if (![...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) || !e.getClientRects().length) continue;
    texts++;
    let o = 1; for (let a = e; a && a !== document.documentElement; a = a.parentElement) o *= +getComputedStyle(a).opacity;
    if (o < 1 || getComputedStyle(e).visibility !== "visible") hidden++;
  }
  return { hooked, hidden, texts, js: document.documentElement.hasAttribute("data-js") };
});
for (const file of ["index.html", "privacy.html"]) {
  const t = await open(file, { width: 1440, js: false, until: "load" });
  const r = await readable(t.page);
  assert.ok(r.hooked === 0 && r.hidden === 0 && r.texts > 50 && !r.js, `${file} with JavaScript off: ${JSON.stringify(r)}`);
  await done(t, `${file} with JavaScript off`);
}
{
  const t = await open("index.html", { width: 1440, until: "load", setup: (page) => page.route(/\/motion\.js$/, (r) => r.abort()) });
  await t.page.waitForTimeout(1500); // boot.js's own timer has lifted the entrance's mark
  const r = await readable(t.page);
  assert.ok(r.hooked === 0 && r.hidden === 0 && !r.js, `index.html without motion.js: ${JSON.stringify(r)}`);
  await done(t, "index.html without motion.js", [API]);
}
// no flash: with every deferred script 1.6 s late (after boot.js's 1.4 s timer), a block never shows and then hides
// again. The hero is held for its entrance, then shown by boot.js's timer, and stays (the late entrance is skipped);
// content below the fold waits hidden from the first paint, never visible first
{
  const t = await open("index.html", { width: 1440, until: "load",
    setup: (page) => page.route(/\/(motion|field|home|support|transition)\.js$/, async (r) => { await new Promise((ok) => setTimeout(ok, 1600)); await r.continue(); }),
    init: () => {
      const log = window.__flash = { hero: [], item: [], at: {} };
      const look = () => {
        for (const [k, sel] of [["hero", ".hero-head"], ["item", "#it .sec-title"]]) { const e = document.querySelector(sel); if (e) { const o = getComputedStyle(e).opacity; if (log[k][log[k].length - 1] !== o) log[k].push(o); } }
      };
      const loop = () => { look(); if (!log.stop) requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
      for (const ev of ["DOMContentLoaded", "load"]) addEventListener(ev, () => { look(); log.at[ev] = getComputedStyle(document.querySelector("#it .sec-title")).opacity; if (ev === "load") setTimeout(() => { log.stop = true; }, 600); });
    } });
  await t.page.waitForTimeout(800);
  const f = await t.page.evaluate(() => window.__flash);
  const rises = (xs) => xs.every((v, i) => i === 0 || +v >= +xs[i - 1]);
  assert.ok(rises(f.hero) && rises(f.item) && f.item.every((v) => v === "0") && f.at.DOMContentLoaded === "0" && f.at.load === "0", `a flash with late scripts: ${JSON.stringify(f)}`);
  await done(t, "late scripts", [API]);
}
// the page as a visitor gets it at 1440 x 900, with the field as a software renderer draws it (one still picture): its
// first paints, no layout shift over a full scroll, and no long task in 3 s of wheel scrolling
let perf = null;
{
  const t = await open("index.html", { width: 1440, init: () => {
    const m = window.__perf = { cls: 0, shifts: 0, long: [], lcp: 0, lcpOf: "" };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { m.cls += e.value; m.shifts++; } }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) m.long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { m.lcp = e.startTime; m.lcpOf = e.element ? e.element.tagName.toLowerCase() + "." + e.element.className : ""; } }).observe({ type: "largest-contentful-paint", buffered: true });
  } });
  const p = t.page;
  await p.waitForSelector('#field[data-state="settled"]', { state: "attached", timeout: 5000 });
  await p.waitForTimeout(1600);
  const t0 = await p.evaluate(() => performance.now());
  await p.mouse.move(720, 450);
  for (let i = 0; i < 60; i++) { await p.mouse.wheel(0, i < 30 ? 160 : -160); await p.waitForTimeout(50); }
  const t1 = await p.evaluate(() => performance.now());
  await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(1200);
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  const m = await p.evaluate(() => ({ ...window.__perf, fcp: (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime, soft: !!document.getElementById("field") }));
  perf = { ...m, scroll: Math.round(t1 - t0), during: m.long.filter(([s]) => s >= t0 && s <= t1) };
  assert.ok(m.soft, "no field on the software renderer");
  assert.equal(perf.cls, 0, `layout shift over a full scroll: ${perf.cls} in ${perf.shifts} shifts`);
  assert.deepEqual(perf.during, [], `long tasks in ${perf.scroll} ms of wheel scrolling`);
  await done(t, "performance", [API]);
}
console.log(`reveal: transition delays ${reveal.delays.join(", ")} ms; from the scroll to the last transitionend (${reveal.ms} ms) ${reveal.layout} Layout and ${reveal.paint} Paint events (to the trace's end, settle included: ${reveal.layoutAll} Layout, ${reveal.paintAll} Paint)`);
console.log(`performance at 1440 x 900: FCP ${Math.round(perf.fcp)} ms, LCP ${Math.round(perf.lcp)} ms (${perf.lcpOf}), CLS ${perf.cls.toFixed(3)} over a full scroll, ${perf.during.length} long tasks in ${perf.scroll} ms of wheel scrolling (${perf.long.length} in the whole visit${perf.long.length ? ": " + JSON.stringify(perf.long) : ""})`);

// GitHub's API down, rate-limited or answering junk: the release-page link stays, and nothing odd is shown
const fallback = `<a href="${REPO}/releases/latest">shown on the release page</a>`;
const junk = {
  "a 403": json({ message: "API rate limit exceeded" }, 403), "no network": (r) => r.abort(), "not JSON": json("<html>"), "null": json("null"),
  "assets not a list": json({ assets: "x" }), "a list of nulls": json({ assets: [null, 7] }), "an uppercase digest": json({ assets: [{ name: "AnomalyHunter.exe", size: 1, digest: "sha256:" + "A".repeat(64) }] }),
  "markup in the digest": json({ tag_name: "<img src=x onerror=alert(1)>", assets: [{ name: "AnomalyHunter.exe", size: 1, digest: `sha256:${"a".repeat(64)}<img src=x>` }] }),
};
for (const [name, api] of Object.entries(junk)) {
  const t = await open("index.html", { api });
  assert.equal(await t.page.$eval("#sha", (c) => c.innerHTML), fallback, `API ${name}: the checksum fallback is gone`);
  assert.equal(await t.page.textContent("#rel"), "Latest, about 81 MB, free", `API ${name}`);
  await done(t, `API ${name}`, [API]);
}
{ // a good digest with odd neighbours: the hash shows, the rest only when it has the right shape (no "NaN MB")
  const t = await open("index.html", { api: json({ tag_name: "<img src=x onerror=alert(1)>", published_at: 5, assets: [{ name: "AnomalyHunter.exe", size: "<b>", digest: "sha256:" + "c".repeat(64) }] }) });
  assert.equal(await t.page.$eval("#sha", (c) => c.innerHTML), "c".repeat(64));
  assert.equal(await t.page.textContent("#rel"), "Latest · free");
  assert.equal(await t.page.$$eval("#rel *, #sha *", (x) => x.length), 0);
  await done(t, "API odd neighbours", [API]);
}

// the support form: nothing is sent; it builds a link to the repo's issue form with exactly what was typed
async function supportForm(p) {
  const submit = async () => { await p.click('button[type="submit"]'); return p.evaluate(() => ({ missing: document.getElementById("missing").hidden ? "" : document.getElementById("missing").textContent,
    ready: !document.getElementById("result").hidden, cut: !document.getElementById("cut").hidden, href: document.getElementById("open").href, focus: document.activeElement.id })); };
  let r = await submit();
  assert.deepEqual([r.missing, r.ready], ["Please add a short summary, what happened, the box that says it contains no key or private data.", false]);
  const cases = [
    { summary: '"><script>alert(1)</script> & ?x=1#y', version: "v0.1.102 (2026-10-20)", details: "Line 1\nemoji 😀🧾 & = + % # ?\n\"><img src=x onerror=alert(1)>", topic: 1 },
    { summary: "plain", version: "", details: "a".repeat(4000), topic: 3 },
    { summary: "😀".repeat(60), version: "v".repeat(60), details: "😀🧾".repeat(1000), topic: 0 },
  ];
  for (const c of cases) {
    await p.selectOption("#topic", { index: c.topic });
    await p.fill("#summary", c.summary); await p.fill("#version", c.version); await p.fill("#details", c.details);
    await p.check("#clean");
    r = await submit();
    const typed = await p.evaluate(() => Object.fromEntries(["topic", "summary", "version", "details"].map((id) => [id, document.getElementById(id).value.trim()])));
    const u = new URL(r.href);
    assert.equal(u.origin + u.pathname, REPO + "/issues/new");
    assert.deepEqual([...u.searchParams.keys()], ["template", "title", "category", "version", "details"]);
    assert.equal(u.searchParams.get("template"), "support_request.yml");
    assert.equal(u.searchParams.get("title"), "[Support]: " + typed.summary);
    assert.equal(u.searchParams.get("category"), typed.topic);
    assert.equal(u.searchParams.get("version"), typed.version);
    // GitHub answers 414 past about 8,000 characters, and its login page drops a way back that is too long once encoded
    assert.ok(encodeURIComponent(r.href).length <= 7000, `a ${r.href.length}-character link`);
    const details = u.searchParams.get("details");
    if (r.cut) assert.ok(details.length < typed.details.length && typed.details.startsWith(details) && !/[\uD800-\uDBFF]$/.test(details), "cut, but not at a whole character");
    else assert.equal(details, typed.details);
    assert.deepEqual([r.missing, r.ready, r.focus], ["", true, "open"]);
  }
  assert.ok(r.cut, "the long emoji text was not cut to fit");
  assert.equal(await p.$$eval("img[src=x], #result script", (x) => x.length), 0);
  await p.uncheck("#clean");
  r = await submit();
  assert.deepEqual([r.missing, r.ready], ["Please add the box that says it contains no key or private data.", false]);
  // the FAQ opens and closes from the keyboard
  await p.focus("details:nth-of-type(2) summary"); await p.keyboard.press("Enter");
  assert.ok(await p.$eval("details:nth-of-type(2)", (d) => d.open));
}
for (const width of [1280, 390]) {
  const t = await open("support.html", { width });
  await supportForm(t.page);
  await done(t, `support form at ${width}px`);
}
// ---- page transitions (AH-73): one document, the old and the new page moving at once, never a white frame ----
// per frame: how many <main>s are in the page and how many of them animate; when the click came, when the new page
// went in and when the old one left (a MutationObserver sees the moment, a frame loop what the eye gets)
// and, in every frame with both pages, the part of the screen each one shows (its box, moved by its transform, less its
// clip-path): the curtain must never draw one page over the other (AH-73 review: a crossfade put both headlines in one
// place at 300 ms). The middle of the motion is not a sampled frame: under load the frame nearest it fell at 450 ms,
// where the old page rightly shows only 23% (AH-73 gate). In the first frame the curtain moves, its three animations are
// paused, seeked to where the edge is at half the width (a bisection on currentTime, measured as drawn), read, put back
// on the clock (the time they had plus the time the seek took) and played on, all in one task, so the same check holds
// at any frame rate
const watch = (p) => p.evaluate(() => {
  const w = window.__watch = { frames: 0, both: 0, anims: 0, moving: 0, together: 0, click: 0, added: 0, removed: 0, stop: false, overlap: -Infinity, mid: null };
  document.addEventListener("click", () => { w.click = performance.now(); }, { capture: true, once: true });
  const shown = (m) => { // [left, right] on screen, inside the window
    const r = m.getBoundingClientRect(), c = /^inset\(([^)]*)\)$/.exec(getComputedStyle(m).clipPath);
    const v = c ? c[1].trim().split(/\s+/).map(parseFloat) : [0];
    const [, right, , left] = [v[0], v[1] ?? v[0], v[2] ?? v[0], v[3] ?? v[1] ?? v[0]];
    return [Math.max(0, r.left + left), Math.min(innerWidth, r.right - right)];
  };
  const edgeOf = (o, n) => (o[0] < n[0] ? (o[1] + n[0]) / 2 : (n[1] + o[0]) / 2);
  const middle = (mains) => {
    const all = document.getAnimations().filter((x) => x.effect && x.effect.target && (x.effect.target.tagName === "MAIN" || x.effect.target.id === "seam"));
    const was = all.map((x) => x.currentTime), dur = all[0].effect.getComputedTiming().endTime, half = innerWidth / 2;
    const at = (t) => { for (const x of all) x.currentTime = t; const [o, n] = mains.map(shown); return { o, n, edge: edgeOf(o, n) }; };
    const t0 = performance.now();
    for (const x of all) x.pause();
    const falls = at(dur * 0.1).edge > at(dur * 0.9).edge; // Forward the edge runs right to left, Back left to right
    let lo = 0, hi = dur, t = dur / 2, got = at(t);
    for (let i = 0; i < 40 && Math.abs(got.edge - half) > 0.25; i++) {
      if ((got.edge > half) === falls) lo = t; else hi = t;
      t = (lo + hi) / 2; got = at(t);
    }
    const s = document.getElementById("seam").getBoundingClientRect(), { o, n } = got;
    const mid = { t: Math.round(t), edge: got.edge, old: o[1] - o[0], new: n[1] - n[0], overlap: Math.min(o[1], n[1]) - Math.max(o[0], n[0]),
      seam: Math.abs(s.left + s.width / 2 - got.edge), width: innerWidth, seeks: all.length };
    const spent = performance.now() - t0; // back on the clock: the seek must not lengthen the motion (the 1160 ms check)
    all.forEach((x, i) => { x.currentTime = was[i] + spent; x.play(); });
    mid.spent = Math.round(spent * 10) / 10;
    return mid;
  };
  const f = () => { const mains = [...document.querySelectorAll("main")], m = mains.length; w.frames++; if (m === 2) w.both++;
    const ms = document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.tagName === "MAIN"), a = ms.length;
    for (const x of ms) if (x.startTime !== null && !w.moving) w.moving = x.startTime; // when the browser began moving them
    w.anims = Math.max(w.anims, a);
    if (m === 2 && a === 2) {
      if (!w.mid && ms.every((x) => x.startTime !== null)) w.mid = middle(mains);
      const [o, n] = mains.map(shown);
      w.overlap = Math.max(w.overlap, Math.min(o[1], n[1]) - Math.max(o[0], n[0]));
    }
    if (!w.stop) requestAnimationFrame(f); };
  requestAnimationFrame(f);
  new MutationObserver((rs) => { for (const r of rs) {
    for (const n of r.addedNodes) if (n.tagName === "MAIN") { w.added = performance.now(); w.together = Math.max(w.together, document.querySelectorAll("main").length); }
    for (const n of r.removedNodes) if (n.tagName === "MAIN") w.removed = performance.now(); } }).observe(document.body, { childList: true });
});
const settle = (p) => p.waitForFunction(() => document.querySelectorAll("main").length === 1 && window.__watch && window.__watch.removed > 0);
const stopWatch = (p) => p.evaluate(() => { window.__watch.stop = true; return window.__watch; });
// what the screen showed, frame by frame, through Chromium's screencast; the share of pure-white pixels in a frame
async function screencast(p) {
  const cdp = await p.context().newCDPSession(p), frames = [];
  cdp.on("Page.screencastFrame", (f) => { frames.push(f.data); cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); });
  await cdp.send("Page.startScreencast", { format: "png", maxWidth: 720, maxHeight: 450, everyNthFrame: 1 });
  return { frames, stop: async () => { await cdp.send("Page.stopScreencast"); await cdp.detach(); } };
}
const whiteShare = (b64) => { const { w, h, px } = png(Buffer.from(b64, "base64")); let n = 0;
  for (let i = 0; i < px.length; i += 4) n += px[i] > 250 && px[i + 1] > 250 && px[i + 2] > 250; return n / (w * h); };
const inView = (p, id) => p.evaluate((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; }, id);
let measured = null;
// no text over text: seeked to the middle of the motion, both pages show half the screen each, side by side, meeting at
// the gold edge, and in no frame does one page's visible part cover the other's by more than that 2px edge
const curtain = (w, label) => {
  const mid = w.mid;
  assert.ok(mid && mid.seeks === 3 && Math.abs(mid.edge - mid.width / 2) <= 1, `${label}: the curtain could not be seeked to its middle: ${JSON.stringify(mid)}`);
  assert.ok(mid.overlap <= 2 && Math.abs(mid.old - mid.width / 2) <= 4 && Math.abs(mid.new - mid.width / 2) <= 4 && mid.seam <= 2, `${label}: the two pages at the midpoint: ${JSON.stringify(mid)}`);
  assert.ok(w.overlap <= 2, `${label}: the two pages overlap by ${w.overlap.toFixed(1)} px in some frame`);
};
// a click where the link is on screen: Playwright's own click first scrolls a sticky bar's link to where the bar would
// sit unstuck (1200 to 738), which is not what a visitor does
const press = async (p, sel) => { const b = await p.locator(sel).boundingBox(); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
{
  const t = await open("index.html");
  const p = t.page;
  await p.waitForTimeout(1600);
  await p.evaluate(() => { window.__marker = 1; scrollTo(0, 1200); });
  await p.waitForTimeout(300);
  await watch(p);
  const cast = await screencast(p);
  const { x, y } = await p.locator('header a[href="privacy.html"]').boundingBox();
  await p.mouse.move(x + 4, y + 4); await p.waitForTimeout(150); // hovering fetches the page ahead
  await press(p, 'header a[href="privacy.html"]');
  await p.waitForURL((u) => u.pathname === "/privacy.html");
  await settle(p); await p.waitForTimeout(150);
  await cast.stop();
  const w = await stopWatch(p);
  const after = await p.evaluate(() => ({ marker: window.__marker, title: document.title, body: document.body.id, mains: document.querySelectorAll("main#page").length,
    page: document.getElementById("page").dataset.page, current: document.querySelector('header a[aria-current="page"]').getAttribute("href"),
    desc: document.querySelector('meta[name="description"]').content, focus: document.activeElement.tagName + (document.activeElement.closest("#page") ? " in #page" : ""),
    brand: document.querySelector("header .brand").getAttribute("href"), notice: document.querySelector(".notice-bar a").getAttribute("href"), gl: !!document.getElementById("field") }));
  assert.deepEqual(after, { marker: 1, title: "Anomaly Hunter Privacy", body: "privacy", mains: 1, page: "privacy", current: "privacy.html",
    desc: after.desc.startsWith("What Anomaly Hunter keeps") ? after.desc : "(the home page's)", focus: "H1 in #page", brand: "index.html", notice: "index.html#download", gl: true }, "the move to privacy.html");
  assert.equal(w.together, 2, "the new page did not go in while the old one was still there");
  assert.ok(w.both >= 3 && w.anims === 2, `the two pages did not move together (${w.both} frames with both, ${w.anims} moving at once)`);
  const whites = cast.frames.map(whiteShare);
  assert.ok(cast.frames.length >= 3, `the screencast caught ${cast.frames.length} frames`);
  assert.ok(Math.max(...whites) <= 0.02, `a white frame between pages: ${Math.max(...whites).toFixed(4)}`);
  measured = { white: Math.max(...whites), frames: cast.frames.length, both: w.both, ofFrames: w.frames, duration: Math.round(w.removed - w.click), swap: Math.round(w.removed - w.added), moving: Math.round(w.removed - w.moving), overlap: w.overlap, mid: w.mid };
  curtain(w, "page transitions");
  console.log(`page transitions: seeked to its middle (${w.mid.t} ms, the seek took ${w.mid.spent} ms) the curtain holds: ${JSON.stringify(w.mid)}, worst frame overlap ${w.overlap.toFixed(1)} px`);
  // 800 ms of motion; the old page leaves when the curtain has finished, at the latest by its 1100 ms safety timer even
  // when frames stall (1160 ms allowed)
  assert.ok(measured.moving >= 600 && measured.swap <= 1160, `the transition took ${measured.moving} ms on screen, ${measured.swap} ms in the page`);

  // Back: the same document, the home page where it was left, and its workspace alive again
  await p.goBack();
  await p.waitForFunction(() => document.body.id === "home" && document.querySelectorAll("main").length === 1 && !document.documentElement.hasAttribute("data-moving"));
  const back = await p.evaluate(() => ({ marker: window.__marker, y: Math.round(scrollY), title: document.title, current: document.querySelector('header a[aria-current="page"]').getAttribute("href") }));
  assert.ok(back.marker === 1 && Math.abs(back.y - 1200) <= 2 && back.title === "Excel Anomaly Hunter" && back.current === "index.html", `Back: ${JSON.stringify(back)}`);
  await p.waitForTimeout(1400);
  await p.click('.rowbtn[aria-controls="m11"]');
  assert.deepEqual(await p.evaluate(() => [document.getElementById("m11").hidden, document.activeElement.className]), [false, "m-close"], "the workspace's detail box after Back");
  await p.keyboard.press("Escape");
  await p.click('.typology button[data-kind="label"]');
  assert.equal(await p.$$eval(".grid tbody tr:not(.skip)", (rs) => rs.filter((r) => getComputedStyle(r).opacity === "1").map((r) => r.querySelector("th").textContent).join()), "31", "the filters after Back");
  assert.equal(await p.textContent("#sha"), "ab".repeat(32), "the checksum after Back");
  // the Scanning ticker stops when its page leaves
  await p.click("#t-busy");
  await p.evaluate(() => { window.__ticker = document.getElementById("ticker"); window.__watch = null; });
  await watch(p);
  await p.click('header a[href="support.html"]');
  await p.waitForURL((u) => u.pathname === "/support.html"); await settle(p); await stopWatch(p);
  const left = await p.evaluate(() => [window.__ticker.isConnected, window.__ticker.textContent]);
  await p.waitForTimeout(1000);
  assert.deepEqual(await p.evaluate(() => [window.__ticker.isConnected, window.__ticker.textContent]), left, "the ticker kept running after its page left");
  assert.equal(left[0], false);
  // no frame loop is left running once the new page has landed (AH-22's idle check, after a transition)
  await p.waitForTimeout(1600);
  await p.evaluate(() => { window.frames_ = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => (window.frames_++, raf(f)); });
  await p.waitForTimeout(1000);
  assert.equal(await p.evaluate(() => window.frames_), 0, "a frame loop runs after a transition");
  // the support form works on a page reached by a transition
  assert.equal(await p.evaluate(() => window.__marker), 1);
  await supportForm(p);
  // privacy.html, then its link to the home page's download: it lands at the anchor
  await p.click('footer a[href="privacy.html"]');
  await p.waitForURL((u) => u.pathname === "/privacy.html"); await p.waitForFunction(() => document.querySelectorAll("main").length === 1 && document.body.id === "privacy");
  await p.click('.notice-bar a[href="index.html#download"]');
  await p.waitForURL((u) => u.pathname === "/index.html" && u.hash === "#download");
  await p.waitForFunction(() => document.querySelectorAll("main").length === 1 && document.body.id === "home");
  assert.ok(await inView(p, "download"), "privacy.html to index.html#download does not land at the download");
  assert.equal(await p.evaluate(() => window.__marker), 1, "a transition reloaded the page");
  await done(t, "page transitions", [API]);
}
{ // the same curtain with a frame only every 50 ms (a loaded machine, AH-22): the motion is WAAPI's, by the clock, so the
  // two pages still move at once, side by side, and the seeked middle is the same
  const t = await open("index.html", { init: () => { window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 50); } });
  const p = t.page;
  await p.waitForTimeout(1600);
  await watch(p);
  await press(p, 'header a[href="privacy.html"]');
  await p.waitForURL((u) => u.pathname === "/privacy.html"); await settle(p);
  const w = await stopWatch(p);
  assert.ok(w.together === 2 && w.both >= 3 && w.anims === 2, `at 20 frames a second the two pages did not move together (${w.both} frames with both, ${w.anims} moving at once)`);
  curtain(w, "page transitions at 20 frames a second");
  measured.slow = { mid: w.mid, overlap: w.overlap, both: w.both, ofFrames: w.frames };
  await done(t, "page transitions at 20 frames a second", [API]);
}
{ // reduced motion: the page is swapped in one step, nothing slides, and still no white frame
  const t = await open("index.html", { motion: "reduce" });
  const p = t.page;
  await p.evaluate(() => { window.__marker = 1; });
  await watch(p);
  const cast = await screencast(p);
  await p.click('header a[href="privacy.html"]');
  await p.waitForURL((u) => u.pathname === "/privacy.html"); await settle(p); await p.waitForTimeout(300);
  await cast.stop();
  const w = await stopWatch(p);
  assert.deepEqual([w.both, w.anims, await p.evaluate(() => [window.__marker, document.title, document.getAnimations().length])], [0, 0, [1, "Anomaly Hunter Privacy", 0]], "reduced motion: a slide");
  assert.ok(atRest(await poses(p, `${HOOKED}, main`)), "reduced motion: something moved");
  assert.ok(Math.max(...cast.frames.map(whiteShare)) <= 0.02, "reduced motion: a white frame");
  await done(t, "page transitions with reduced motion", [API]);
}
{ // the next page fails to fetch: the link is followed the ordinary way and still lands
  const t = await open("index.html");
  const p = t.page;
  await p.evaluate(() => { window.__marker = 1; });
  await p.route("**/privacy.html", (r) => (r.request().resourceType() === "fetch" ? r.abort() : r.continue()));
  await p.click('header a[href="privacy.html"]');
  await p.waitForURL((u) => u.pathname === "/privacy.html"); await p.waitForLoadState("load");
  assert.deepEqual(await p.evaluate(() => [window.__marker, document.title, document.getElementById("page").dataset.page]), [undefined, "Anomaly Hunter Privacy", "privacy"], "a failed fetch did not fall back to a normal navigation");
  await done(t, "page transition with a failed fetch", [API]);
}
console.log(`page transitions: ${measured.moving} ms of motion on screen (${measured.swap} ms in the page, ${measured.duration} ms from the click), both pages in ${measured.both} of ${measured.ofFrames} frames, ` +
  `the whitest of ${measured.frames} screencast frames ${(measured.white * 100).toFixed(2)}% white; seeked to its middle (${measured.mid.t} ms, the seek took ${measured.mid.spent} ms) the old page shows ${measured.mid.old.toFixed(1)} px and the new ${measured.mid.new.toFixed(1)} px of ${measured.mid.width}, ` +
  `overlap ${measured.mid.overlap.toFixed(1)} px (worst frame ${measured.overlap.toFixed(1)} px), the edge ${measured.mid.seam.toFixed(1)} px off the boundary; ` +
  `at 20 frames a second: middle ${measured.slow.mid.t} ms, ${measured.slow.mid.old.toFixed(1)} / ${measured.slow.mid.new.toFixed(1)} px, overlap ${measured.slow.mid.overlap.toFixed(1)} px (worst frame ${measured.slow.overlap.toFixed(1)} px), edge ${measured.slow.mid.seam.toFixed(1)} px off, both pages in ${measured.slow.both} of ${measured.slow.ofFrames} frames`);
await browser.close();
server.close();
console.log("website browser check passed");
