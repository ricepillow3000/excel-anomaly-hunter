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
// where GitHub Pages publishes each page (pages.yml uploads site/ whole): the canonical, og:url and sitemap.xml say these
const SITE_URL = "https://ricepillow3000.github.io/excel-anomaly-hunter/";
const PUBLIC = { "index.html": SITE_URL, "privacy.html": SITE_URL + "privacy.html", "support.html": SITE_URL + "support.html" };
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const html = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
const TITLE = Object.fromEntries(PAGES.map((p) => [p, (/<title>([^<]*)<\/title>/.exec(html[p]) || [])[1]]));
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
  // (the one exception, <link rel="canonical">, loads nothing: it names the page's own public address, checked below)
  for (const tag of src.match(/<(script|link|img)\b[^>]*>/g)) {
    const url = (/\s(?:src|href)="([^"]*)"/.exec(tag) || [])[1] || "";
    if (/^<link rel="canonical" href="[^"]*">$/.test(tag) && url === PUBLIC[p]) continue;
    assert.ok(!/^(https?:)?\/\//.test(url), `${p}: loads ${url} from outside`);
  }
  assert.ok(!/<script>|<style|\sstyle="|\son[a-z]+="/.test(src), `${p}: inline script or style (the CSP would block it)`);
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${new URL(API).origin}; base-uri 'none'; form-action 'none'">`), `${p}: CSP missing or changed`);
  // axe 4.10, 2026-10-20: an empty header cell is read as nothing; the announcement line sat outside every landmark
  assert.ok(!/<th[^>]*><\/th>/.test(src), `${p}: an empty <th>`);
  assert.ok(/<aside class="notice-bar" aria-label="Announcement">/.test(src), `${p}: the announcement line is not a landmark`);
  assert.ok(/<body[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<a class="skip-link" href="#page">Skip to content<\/a>/.test(src), `${p}: "Skip to content" is not the first thing in <body>`);
  // page transitions (AH-73): one swappable container a page, and every script on every page (the document never
  // reloads, so a page reached by a transition runs only what the first page loaded)
  assert.equal(src.match(/<main\b[^>]*>/g).join(), `<main id="page" data-page="${{ "index.html": "home", "privacy.html": "privacy", "support.html": "support" }[p]}">`, `${p}: not one <main id="page">`);
  assert.deepEqual(attr(src, "src").filter((s) => s.endsWith(".js")), SCRIPTS, `${p}: does not load every script once`);
}
// a box that scrolls sideways must take keyboard focus, or a keyboard user can't read its end
assert.ok(/<code class="line" tabindex="0">/.test(html["index.html"]), "the PowerShell line scrolls but can't be focused");
// SignPath's free open-source signing (AH-100) asks for "Code signing policy" on the home and download pages, with the
// sentence its releases will carry; until the exe is signed the page must say it is not, never claim a signature
{
  const home = html["index.html"];
  const sec = (/<section\b[^>]*\sid="code-signing"[^>]*>([\s\S]*?)<\/section>/.exec(home) || [])[1];
  assert.ok(sec, 'the home page has no section id="code-signing"');
  const text = sec.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  assert.equal((/<h2\b[^>]*>([\s\S]*?)<\/h2>/.exec(sec) || [])[1], "Code signing policy", 'the code signing section\'s heading is not "Code signing policy"');
  assert.ok(text.includes("Free code signing provided by SignPath.io, certificate by SignPath Foundation"), "the code signing section lacks SignPath's attribution sentence");
  assert.ok(/Arcas\.exe is not code-signed/.test(text), "the code signing section does not say the exe is not code-signed yet");
  const sig = (/<dt>Signature<\/dt><dd>([\s\S]*?)<\/dd>/.exec(home) || [])[1] || "";
  assert.ok(/Not code-signed yet/.test(sig) && /<a href="#code-signing">Code signing policy<\/a>/.test(sig), "the download facts' Signature does not say not code-signed yet with a link to the code signing policy");
  for (const p of PAGES) assert.ok(/<footer[\s\S]*<a href="(index\.html)?#code-signing">Code signing policy<\/a>[\s\S]*<\/footer>/.test(html[p]), `${p}: the footer does not link the code signing policy`);
}

// motion (AH-83): content rises in as a .reveal-item, never scrubbed by the scroll (the old data-scrub hooks are gone), and
// every group of them that cascades is marked data-reveal-group
for (const p of PAGES) assert.ok(!/data-scrub/.test(html[p]), `${p}: a data-scrub hook is left`);
for (const p of ["index.html", "privacy.html"]) assert.ok(/class="[^"]*\breveal-item\b/.test(html[p]) && /\sdata-reveal-group[\s>]/.test(html[p]), `${p}: no reveal items in a group`);
const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
// the motion tokens as styles.css writes them (:root), in ms: the browser checks below take their bounds from these, so a
// slower feel (AH-90, John 2026-11-02) moves the bound with it and the check still tests the same promise
const TOKENS = Object.fromEntries([...css.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const msOf = (n) => { assert.ok(/^\d+ms$/.test(TOKENS[n] || ""), `styles.css: ${n} is not a time in ms (${TOKENS[n]})`); return parseFloat(TOKENS[n]); };
// the last of the hero's blocks starts --enter-lead after the bar's, at most 4 steps in, and lasts --enter-dur
const ENTERED = msOf("--enter-lead") + 4 * msOf("--enter-step") + msOf("--enter-dur") + 150;
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

// AH-117: a negative letter-spacing (h1 -.02em, h2, the brand...) is one of the looks John listed as generated; type keeps
// the spacing its designer drew
for (const m of css.matchAll(/letter-spacing\s*:\s*([^;}]+)/g)) assert.ok(!/^-/.test(m[1].trim()), `styles.css: a negative letter-spacing (${m[1].trim()})`);
// AH-120: everything that acts as a button shows it is pressed; a hover alone said nothing to a finger on a phone
{
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/\s+/g, " ")));
  for (const sel of [".btn", ".links .btn-trim", ".typology button", ".tabs button", ".rowbtn", ".m-close", ".faq summary"])
    assert.ok(selectors.includes(sel + ":active"), `styles.css: no pressed (:active) look for ${sel}`);
}
// AH-119: each page names itself to search engines and to a shared link: its own title (Arcas first, then what the page
// is), a description, a canonical at its public address, and the basic Open Graph tags (no og:image: the only images are
// the 32 and 64 px marks, under the 200 px a card needs). sitemap.xml lists exactly the three pages at those addresses.
// No robots.txt: a project site lives under /excel-anomaly-hunter/ and crawlers read robots.txt only at the domain's
// root, so one here would do nothing; the sitemap is what gets submitted to a search console
{
  const meta = (src, key, name) => [...src.matchAll(/<meta ([a-z]+)="([^"]+)" content="([^"]*)">/g)].filter((m) => m[1] === key && m[2] === name).map((m) => m[3]);
  const titles = PAGES.map((p) => (/<title>([^<]*)<\/title>/.exec(html[p]) || [])[1] || "");
  assert.equal(new Set(titles).size, PAGES.length, `the pages share a title: ${titles}`);
  for (const [i, p] of PAGES.entries()) {
    const src = html[p], title = titles[i];
    assert.ok(/^Arcas\b.{20,}$/.test(title) && !/[–—]| - /.test(title), `${p}: the title "${title}" does not say Arcas, then what the page is`);
    const desc = meta(src, "name", "description");
    assert.ok(desc.length === 1 && desc[0].length >= 50, `${p}: no description`);
    assert.deepEqual([...src.matchAll(/<link rel="canonical" href="([^"]*)">/g)].map((m) => m[1]), [PUBLIC[p]], `${p}: the canonical is not ${PUBLIC[p]}`);
    for (const [prop, want] of [["og:title", title], ["og:description", desc[0]], ["og:url", PUBLIC[p]], ["og:type", "website"], ["og:site_name", "Arcas"]])
      assert.deepEqual(meta(src, "property", prop), [want], `${p}: ${prop} is not "${want}"`);
    assert.deepEqual(meta(src, "name", "twitter:card"), ["summary"], `${p}: no twitter:card`);
  }
  const map = read("sitemap.xml");
  assert.ok(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">[\s\S]*<\/urlset>\s*$/.test(map), "sitemap.xml is not a sitemap");
  const body = map.replace(/<!--[\s\S]*?-->/g, "").replace(/^<\?xml[^>]*\?>\s*<urlset[^>]*>|<\/urlset>\s*$/g, "");
  assert.ok(/^(\s*<url>\s*<loc>[^<]+<\/loc>\s*<\/url>)*\s*$/.test(body), "sitemap.xml holds more than <url><loc> entries");
  assert.deepEqual([...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), PAGES.map((p) => PUBLIC[p]), "sitemap.xml does not list exactly the three pages at their canonical addresses");
  assert.ok(!fs.existsSync(path.join(SITE, "robots.txt")), "robots.txt under a project site's path is never read");
}

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
// a box with no GPU (a cloud session, a CI runner): Chromium 141 (Playwright 1.56) falls back to software WebGL by itself
// and warns about it on every page ("Automatic fallback to software WebGL has been deprecated"), which failed the console
// check before any page was looked at (2026-11-02). This flag is that same fallback, asked for: no other renderer, no
// slower compositing (unlike --use-angle=swiftshader above), and a no-op on a PC with a GPU
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
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
// a release since AH-101 carries the same file twice: Arcas.exe, and AnomalyHunter.exe for links posted before the rename
const release = { tag_name: "v0.1.102", published_at: "2026-10-20T05:15:43Z", assets: ["Arcas.exe", "AnomalyHunter.exe"].map((name) => ({ name, size: 81256476, digest: "sha256:" + "ab".repeat(32) })) };
const fallback = `<a href="${REPO}/releases/latest">shown on the release page</a>`;
const json = (body, status = 200) => (r) => r.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });

// Headless Chromium draws WebGL with SwiftShader, so field.js shows its one still picture there (AH-85). The checks of the
// field's own motion (its pointer bend, its scroll-linked shape, its inversion on the band) name a GPU instead
const GPU = () => { const get = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function (k) { return k === 0x1F01 || k === 0x9246 ? "ANGLE (a test GPU)" : get.call(this, k); }; };
async function open(file, { width = 1280, height = 900, api = json(release), motion = "no-preference", until = "networkidle", init = null, gpu = false, js = true, setup = null, colors = "none" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, javaScriptEnabled: js, forcedColors: colors });
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

// ---- reading the pages the way people with other settings read them (AH-112 to AH-116). Each check collects what it
// finds and the group fails once with all of it, so one run names every page that falls short ----
{
  const short = [];
  // AH-112: text at 200% (WCAG 1.4.4, 1.4.10) on a 320 and a 390 px phone. With the root font at 200% the sample's tabs
  // ran off the screen, privacy's github.com address and its list items pushed the page 267 px sideways, support's
  // aistudio.google.com/apikey link 192 px: nothing may scroll sideways, at 100% or at 200%, in any of the sample's states
  for (const file of PAGES) for (const width of [320, 390]) for (const size of ["100%", "200%"]) {
    const t = await open(file, { width, height: 800, motion: "reduce" });
    await t.page.evaluate((size) => { document.documentElement.style.fontSize = size; }, size);
    for (const tab of file === "index.html" ? ["t-found", "t-busy", "t-clean"] : [""]) {
      if (tab) await t.page.click("#" + tab);
      await t.page.waitForTimeout(100);
      const over = await t.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) short.push(`AH-112 ${file} at ${width}px, text ${size}${tab ? ", " + tab : ""}: scrolls ${over} px sideways`);
    }
    await done(t, `${file} at ${width}px with text at ${size}`, [API]);
  }
  // AH-113: Windows High Contrast (forced colours) drops every fill and shadow the page draws: the sample's "probably
  // wrong" cells (a wine fill) and "worth a check" cells (an inset line) looked like every other cell, the key's squares
  // vanished, and the bar's Download lost its box. Each mark must show as something the theme keeps, and the two kinds
  // must differ from each other and from a plain cell
  {
    const t = await open("index.html", { motion: "reduce", colors: "active" });
    const marks = (p) => p.evaluate(() => {
      const under = (e) => { for (let a = e.parentElement; a; a = a.parentElement) { const c = getComputedStyle(a).backgroundColor; if (!/^rgba\(.*, 0\)$/.test(c) && c !== "transparent") return c; } return "rgb(255, 255, 255)"; };
      const mark = (sel) => { const e = document.querySelector(sel), c = getComputedStyle(e), bg = under(e), drawn = (style, width, color) => style !== "none" && parseFloat(width) > 0 && color !== bg;
        return [!/, 0\)$/.test(c.backgroundColor) && c.backgroundColor !== bg ? "fill " + c.backgroundColor : "",
          drawn(c.borderTopStyle, c.borderTopWidth, c.borderTopColor) ? `border ${c.borderTopStyle} ${c.borderTopWidth}` : "", drawn(c.borderBottomStyle, c.borderBottomWidth, c.borderBottomColor) ? `underline ${c.borderBottomStyle} ${c.borderBottomWidth}` : "", drawn(c.outlineStyle, c.outlineWidth, c.outlineColor) ? `outline ${c.outlineStyle}` : ""].filter(Boolean).join(", ") || "nothing"; };
      return { flag: mark("#p-found td.flag"), check: mark("#p-found td.q"), plain: mark('#p-found tbody tr:not([data-kind]) td:not(.t):not(.why)'),
        keyFlag: mark(".key i:not(.q)"), keyCheck: mark(".key i.q"), download: mark(".links .btn-trim"), mended: mark("#p-clean td.mended"), ok: mark("#p-clean td.why i.ok") };
    });
    const m = await marks(t.page);
    for (const [k, v] of Object.entries(m)) if (k !== "plain" && v === "nothing") short.push(`AH-113 forced colours: ${k} shows no mark`);
    if (new Set([m.flag, m.check, m.mended, m.plain]).size < 4) short.push(`AH-113 forced colours: a flagged cell (${m.flag}), one worth a check (${m.check}), a fixed one (${m.mended}) and a plain one (${m.plain}) cannot all be told apart`);
    if (new Set([m.keyFlag, m.keyCheck, m.ok]).size < 3) short.push(`AH-113 forced colours: the squares for probably wrong (${m.keyFlag}), worth a check (${m.keyCheck}) and fixed (${m.ok}) are not all different`);
    if (!/border|outline/.test(m.download)) short.push(`AH-113 forced colours: the bar's Download has no box (${m.download})`);
    console.log(`forced colours: ${JSON.stringify(m)}`);
    await done(t, "forced colours", [API]);
  }
  // AH-114: the support form on a phone with its keyboard open (390 x 420): an empty submit left focus on the button and
  // its message under it, off the screen, tied to no field. Now focus goes to the first missing field, each missing field
  // says it is invalid and is described by the message, the message shows on screen beside it, and a filled field lets go
  {
    const t = await open("support.html", { width: 390, height: 420, motion: "reduce" });
    const p = t.page;
    const look = () => p.evaluate(() => { const m = document.getElementById("missing"), r = m.getBoundingClientRect(), a = document.activeElement, f = a.getBoundingClientRect();
      const on = (r) => r.top >= 0 && r.bottom <= innerHeight && r.height > 0;
      return { focus: a.id, text: m.hidden ? "" : m.textContent, shown: !m.hidden && on(r), fieldShown: on(f),
        invalid: ["summary", "details", "clean"].filter((id) => document.getElementById(id).getAttribute("aria-invalid") === "true").join(),
        described: ["summary", "details", "clean"].filter((id) => (document.getElementById(id).getAttribute("aria-describedby") || "").split(" ").includes("missing")).join() }; });
    const want = (got, exp, step) => { if (JSON.stringify(got) !== JSON.stringify(exp)) short.push(`AH-114 support form ${step}: ${JSON.stringify(got)}, want ${JSON.stringify(exp)}`); };
    await p.click('button[type="submit"]');
    want(await look(), { focus: "summary", text: "Please add a short summary, what happened, the box that says it contains no key or private data.", shown: true, fieldShown: true, invalid: "summary,details,clean", described: "summary,details,clean" }, "after an empty submit");
    await p.keyboard.type("Scan stops");
    const typed = await look();
    want([typed.invalid, typed.described], ["details,clean", "details,clean"], "once the summary is typed");
    await p.click('button[type="submit"]');
    want(await look(), { focus: "details", text: "Please add what happened, the box that says it contains no key or private data.", shown: true, fieldShown: true, invalid: "details,clean", described: "details,clean" }, "after a second submit");
    await p.keyboard.type("It stops"); await p.check("#clean");
    const filled = await look();
    want([filled.invalid, filled.described, filled.text], ["", "", ""], "once everything is filled");
    await done(t, "support form errors on a small phone");
  }
  // AH-115 and AH-116, on each page at a phone's 390 x 844 and at 1280: every control a finger or pointer presses, other
  // than a link inside a sentence, is at least 24 x 24 px (WCAG 2.2 2.5.8: the footer's links were 21 px, the notice's
  // Download 17), and no text is under 12 px (the sample's column heads were 10.88), in every state the page has
  for (const file of PAGES) for (const [width, height] of [[390, 844], [1280, 900]]) {
    const t = await open(file, { width, height, motion: "reduce" });
    const p = t.page;
    const small = await p.evaluate(() => {
      const out = [], blockOf = (e) => { let a = e.parentElement; while (a && /^inline|^contents/.test(getComputedStyle(a).display)) a = a.parentElement; return a; };
      const words = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
      for (const e of document.querySelectorAll("a[href], button, summary, select, input, textarea")) {
        if (!e.getClientRects().length || getComputedStyle(e).visibility !== "visible" || e.closest("[hidden], [aria-hidden=true], .skip-link")) continue;
        const inSentence = e.tagName === "A" && getComputedStyle(e).display === "inline" && !e.closest("header, footer, .notice-bar") && words(blockOf(e)) !== words(e);
        const r = e.getBoundingClientRect();
        if (!inSentence && (r.width < 24 || r.height < 24)) out.push(`${e.tagName.toLowerCase()}${e.className ? "." + e.className.split(" ")[0] : ""}${e.id ? "#" + e.id : ""} "${words(e).slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      return out;
    });
    for (const s of small) short.push(`AH-115 ${file} at ${width}px: a small target, ${s}`);
    const states = file === "index.html" ? ["t-found", "t-busy", "t-clean", "m11"] : file === "support.html" ? ["", "submit"] : [""];
    for (const state of states) {
      if (state.startsWith("t-")) await p.click("#" + state);
      if (state === "m11") { await p.click("#t-found"); await p.click('.rowbtn[aria-controls="m11"]'); }
      if (state === "submit") await p.click('button[type="submit"]');
      const tiny = await p.evaluate(() => {
        const out = new Map();
        for (const e of document.body.querySelectorAll("*")) {
          if (e.closest("script, style, noscript, [hidden]") || !e.getClientRects().length) continue;
          const sizes = [];
          if ([...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) sizes.push(["", getComputedStyle(e).fontSize]);
          for (const pseudo of ["::before", "::after"]) { const c = getComputedStyle(e, pseudo); if (!["none", "normal", '""'].includes(c.content) && c.display !== "none") sizes.push([pseudo, c.fontSize]); }
          for (const [pseudo, fs] of sizes) if (parseFloat(fs) < 12) { const k = `${e.tagName.toLowerCase()}${e.className && typeof e.className === "string" ? "." + e.className.split(" ")[0] : ""}${pseudo} ${fs}`; out.set(k, (out.get(k) || 0) + 1); }
        }
        return [...out].map(([k, n]) => `${k} x${n}`);
      });
      for (const s of tiny) short.push(`AH-116 ${file} at ${width}px${state ? " (" + state + ")" : ""}: text under 12 px, ${s}`);
    }
    await done(t, `targets and text size on ${file} at ${width}px`, [API]);
  }
  assert.deepEqual(short, [], `the pages fall short for some readers:\n${short.join("\n")}`);
  console.log("other readers: no sideways scroll with text at 200% (320 and 390 px), marks kept in forced colours, the support form's errors on a small phone, every target 24 px, no text under 12 px");
}

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
  const l = document.querySelector("#download .logo"), b = document.querySelector('#download a[href$="Arcas.exe"]');
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
  // "After fixes": the sheet with the three suggested fixes in, where the engine still lists 4 jumps worth a check (AH-88,
  // backend/tests/test_site_sample.py checks the numbers against the engine)
  await p.click("#t-clean"); assert.deepEqual(await state(), { state: "clean", counts: "4 0 0 0 4", open: "", focus: "t-clean" });
  // ... and the key under the filters with them: it read "Probably wrong: 3" over the corrected sheet (AH-98)
  const key = () => p.$$eval("#preview .key span", (s) => s.map((x) => x.textContent).join(" | "));
  assert.equal(await key(), "Probably wrong: 0 | Worth a check: 4", "the key after the fixes");
  await p.keyboard.press("ArrowRight"); assert.equal((await state()).focus, "t-found");
  await p.keyboard.press("ArrowLeft"); assert.equal((await state()).focus, "t-clean");
  await p.click('.typology button[data-kind="label"]'); // a filter brings the findings back
  assert.equal((await state()).state, "found");
  assert.equal(await key(), "Probably wrong: 3 | Worth a check: 4", "the key back on the findings");
  const lit = () => p.$$eval("#p-found .grid tbody tr:not(.skip)", (rs) => rs.filter((r) => getComputedStyle(r).opacity === "1").map((r) => r.querySelector("th").textContent).join());
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
// ---- the sample sheet's motion (AH-89, AH-91, AH-92; John 2026-11-02) ----
// the skeleton: the real sheet waits with no colour on its values and a bar exactly where each value will land; it plays
// once the sheet is 30% on screen (never before: the sheet starts below the fold at 1440 x 900), one band of light crosses
// it, then the rows land; the layout never moves (CLS 0), and a press on the sheet ends it at once
const bars = (p) => p.evaluate(() => {
  const sel = ["#p-found tbody tr:nth-child(5) td:nth-child(4)", "#p-found tbody tr:nth-child(5) td.why", "#p-found tbody tr:nth-child(2) th", "#preview .typology .n", "#preview .key span"];
  return sel.map((s) => { const el = document.querySelector(s), r = el.getBoundingClientRect(), a = getComputedStyle(el, "::after"), c = getComputedStyle(el);
    const box = { left: r.left + el.clientLeft + parseFloat(a.left), top: r.top + el.clientTop + parseFloat(a.top), width: parseFloat(a.width), height: parseFloat(a.height) };
    return { s, content: a.content, color: c.color, inside: box.width > 2 && box.height > 2 && box.left >= r.left - 0.5 && box.left + box.width <= r.right + 0.5 && box.top >= r.top - 0.5 && box.top + box.height <= r.bottom + 0.5 }; });
});
const loadingOf = (p) => p.evaluate(() => document.getElementById("preview").getAttribute("data-loading"));
const frameAt = (p) => p.evaluate(() => { let top = 0; for (let e = document.getElementById("preview"); e; e = e.offsetParent) top += e.offsetTop; return top - 65 - 21; });
{
  const t = await open("index.html", { width: 1440, init: () => {
    const m = window.__sk = { cls: 0, play: 0, gone: 0, sweeps: 0 };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) m.cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    addEventListener("DOMContentLoaded", () => new MutationObserver(() => { const v = document.getElementById("preview").getAttribute("data-loading");
      if (v === "play" && !m.play) { m.play = performance.now(); m.sweeps = document.getAnimations().filter((a) => a.animationName === "sweep").length; }
      if (v === null && m.play && !m.gone) m.gone = performance.now(); }).observe(document.getElementById("preview"), { attributes: true, attributeFilter: ["data-loading"] }));
  } });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  assert.equal(await loadingOf(p), "", "the sheet below the fold is not waiting as a skeleton");
  const waiting = await bars(p);
  assert.ok(waiting.every((b) => b.content === '""' && b.inside && b.color === "rgba(0, 0, 0, 0)"), `the skeleton's bars before it plays: ${JSON.stringify(waiting)}`);
  assert.equal(await p.evaluate(() => document.getAnimations().filter((a) => a.animationName === "sweep").length), 0, "the skeleton's light moves before the sheet is seen");
  await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
  await p.waitForFunction(() => window.__sk.play > 0, null, { timeout: 1000 });
  const playing = await bars(p);
  assert.ok(playing.every((b) => b.inside), `a bar is not inside its cell while it plays: ${JSON.stringify(playing)}`);
  await p.waitForFunction(() => window.__sk.gone > 0, null, { timeout: 4000 });
  const sk = await p.evaluate(() => window.__sk);
  const landed = await bars(p);
  assert.ok(sk.sweeps === 1 && sk.gone - sk.play >= 1300 && sk.gone - sk.play <= 2400, `the skeleton played ${Math.round(sk.gone - sk.play)} ms with ${sk.sweeps} sweeps`);
  assert.ok(landed.every((b) => b.content === "none" && b.color !== "rgba(0, 0, 0, 0)"), `the data did not land: ${JSON.stringify(landed)}`);
  assert.equal(sk.cls, 0, "the skeleton moved the layout");
  console.log(`skeleton: played for ${Math.round(sk.gone - sk.play)} ms (one sweep, bars inside their cells, CLS ${sk.cls})`);
  await done(t, "skeleton", [API]);
}
{ // a press on the sheet while it loads ends it at once; with reduced motion there is none (see the reduced-motion block)
  const t = await open("index.html", { width: 1440 });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
  await p.waitForFunction(() => document.getElementById("preview").getAttribute("data-loading") === "play", null, { timeout: 1000 });
  const b = await p.locator("#p-found tbody tr:nth-child(4) td:nth-child(3)").boundingBox();
  await p.mouse.click(b.x + 5, b.y + 5);
  assert.equal(await loadingOf(p), null, "a press on the sheet did not end its skeleton");
  await done(t, "skeleton ended by a press", [API]);
}
// AH-99: the skeleton waits for "See a sample scan"'s glide to land (played on the way down, it had mostly finished by
// the time the visitor arrived), and scrolled by hand it waits until the sheet is 60% in view: 30% is not enough
{
  const t = await open("index.html", { width: 1440, init: () => {
    const m = window.__arrive = { at: 0, loading: undefined, play: 0, gone: 0 };
    document.addEventListener("ah:glide-end", (e) => { if (e.detail.arrived && !m.at) { m.at = performance.now(); m.loading = document.getElementById("preview").getAttribute("data-loading"); } });
    addEventListener("DOMContentLoaded", () => new MutationObserver(() => { const v = document.getElementById("preview").getAttribute("data-loading");
      if (v === "play" && !m.play) m.play = performance.now();
      if (v === null && !m.gone) m.gone = performance.now(); }).observe(document.getElementById("preview"), { attributes: true, attributeFilter: ["data-loading"] }));
  } });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  const b = await p.locator('a[data-glide="frame"][href="#preview"]').boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await p.waitForFunction(() => window.__arrive.gone > 0, null, { timeout: 7000 });
  const m = await p.evaluate(() => window.__arrive);
  assert.ok(m.at > 0 && m.loading === "" && (m.play === 0 || m.play >= m.at), `the skeleton did not wait for the glide: ${JSON.stringify(m)}`);
  assert.ok(m.gone - m.at >= 1200 && m.gone - m.at <= 2600, `the skeleton went ${Math.round(m.gone - m.at)} ms after the glide arrived`);
  console.log(`skeleton after the glide: gone ${Math.round(m.gone - m.at)} ms after arrival`);
  await done(t, "skeleton waits for the glide", [API]);
}
{
  const t = await open("index.html", { width: 1440 });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  // the sheet's top where `share` of it shows above the bottom of the screen
  const showing = (share) => p.evaluate((f) => { const el = document.getElementById("preview"); let top = 0; for (let e = el; e; e = e.offsetParent) top += e.offsetTop;
    scrollTo(0, top - innerHeight + f * el.offsetHeight); }, share);
  await showing(0.3); await p.waitForTimeout(800);
  assert.equal(await loadingOf(p), "", "the skeleton played with 30% of the sheet in view");
  await showing(0.7);
  await p.waitForFunction(() => document.getElementById("preview").getAttribute("data-loading") === "play", null, { timeout: 1000 });
  await done(t, "skeleton waits for 60% in view", [API]);
}
// the download's facts: bars on their parent list while GitHub's answer is really on its way (never inside #sha or #rel),
// for at least 700 ms, and gone once it has come, good or junk
for (const [name, api, sha] of [["a good answer", json(release), "ab".repeat(32)], ["a 403", json({ message: "API rate limit exceeded" }, 403), null]]) {
  const slow = async (r) => { await new Promise((ok) => setTimeout(ok, 1200)); return api(r); };
  const t = await open("index.html", { api: slow, until: "domcontentloaded", init: () => {
    const m = window.__dl = { on: 0, off: 0 }; // from before the page is parsed: home.js marks the list before DOMContentLoaded
    new MutationObserver((rs) => { for (const { target: d } of rs) if (d.matches("dl.anchor")) {
      if (d.hasAttribute("data-loading") && !m.on) m.on = performance.now(); if (!d.hasAttribute("data-loading") && m.on && !m.off) m.off = performance.now(); } })
      .observe(document, { attributes: true, subtree: true, attributeFilter: ["data-loading"] });
  } });
  const p = t.page;
  await p.waitForTimeout(400);
  const pending = await p.evaluate(() => ({ on: document.querySelector("dl.anchor").hasAttribute("data-loading"), sha: document.getElementById("sha").innerHTML, rel: document.getElementById("rel").innerHTML,
    bar: getComputedStyle(document.getElementById("sha"), "::after").content, color: getComputedStyle(document.getElementById("rel")).color }));
  assert.deepEqual(pending, { on: true, sha: fallback, rel: "Latest, about 81 MB, free", bar: '""', color: "rgba(0, 0, 0, 0)" }, `API ${name}: the facts while the answer is on its way`);
  await p.waitForFunction(() => window.__dl.off > 0, null, { timeout: 4000 });
  const m = await p.evaluate(() => window.__dl);
  assert.ok(m.off - m.on >= 1150, `API ${name}: the skeleton went before the answer came (${Math.round(m.off - m.on)} ms)`);
  assert.equal(await p.$eval("#sha", (c) => c.innerHTML), sha || fallback, `API ${name}: the checksum after the skeleton`);
  assert.equal(await p.$$eval("#rel *", (x) => x.length), 0);
  await done(t, `download skeleton with ${name}`, [API]);
}
{ // an answer that comes at once still shows the bars for 700 ms: never a flash
  const t = await open("index.html", { until: "domcontentloaded", init: () => {
    const m = window.__dl = { on: 0, off: 0 }; // from before the page is parsed: home.js marks the list before DOMContentLoaded
    new MutationObserver((rs) => { for (const { target: d } of rs) if (d.matches("dl.anchor")) {
      if (d.hasAttribute("data-loading") && !m.on) m.on = performance.now(); if (!d.hasAttribute("data-loading") && m.on && !m.off) m.off = performance.now(); } })
      .observe(document, { attributes: true, subtree: true, attributeFilter: ["data-loading"] });
  } });
  await t.page.waitForFunction(() => window.__dl.off > 0, null, { timeout: 3000 });
  const m = await t.page.evaluate(() => window.__dl);
  assert.ok(m.off - m.on >= 650 && m.off - m.on <= 1200, `a quick answer's skeleton showed for ${Math.round(m.off - m.on)} ms`);
  await done(t, "download skeleton with a quick answer", [API]);
}
// the glide (AH-91): "See a sample scan" scrolls there by the clock, never a jump, and frames the sheet and the button under
// it below the sticky bar with the checks still below the fold; then the button glides on to the checks, whose heading
// turns up like a card; a wheel ends a glide where it is; no frame is asked for once it has ended
const glideTo = async (p, sel, until) => {
  const b = await p.locator(sel).boundingBox();
  await p.evaluate(() => { window.frames_ = 0; window.__ys = []; window.__lift = []; const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (f) => (window.frames_++, raf(f));
    const h = document.getElementById("checks-title"), look = () => { window.__ys.push([performance.now(), scrollY]); const m = new DOMMatrix(getComputedStyle(h).transform); window.__lift.push(m.m22); if (window.__ys.length < 400) setTimeout(look, 20); }; look(); });
  const t0 = Date.now();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await p.waitForTimeout(300);
  const mid = await p.evaluate(() => scrollY);
  await p.waitForFunction((h) => location.hash === h, until, { timeout: 4500 });
  return { mid, ms: Date.now() - t0 };
};
for (const width of [1440, 1280]) {
  const t = await open("index.html", { width });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  const y0 = await p.evaluate(() => scrollY);
  const g = await glideTo(p, 'a[data-glide="frame"][href="#preview"]', "#preview");
  const end = await p.evaluate(() => { const bar = document.querySelector(".bar").getBoundingClientRect().bottom, f = document.getElementById("preview").getBoundingClientRect(), n = document.querySelector(".next-up").getBoundingClientRect();
    return { y: scrollY, bar, top: f.top, bottom: n.bottom, checks: document.getElementById("checks").getBoundingClientRect().top, h: innerHeight, focus: document.activeElement.id }; });
  assert.ok(g.mid > y0 && g.mid < end.y, `${width}px: "See a sample scan" jumped (${y0} -> ${g.mid} at 300 ms -> ${end.y})`);
  assert.ok(g.ms >= 1500 && g.ms <= 3000, `${width}px: the glide to the sample took ${g.ms} ms`);
  assert.ok(end.top >= end.bar && end.bottom <= end.h && end.checks >= end.h && end.focus === "preview", `${width}px: the glide's end does not frame the sheet: ${JSON.stringify(end)}`);
  assert.ok(Math.abs((end.top - end.bar) - (end.h - end.bottom)) <= 2, `${width}px: the sheet is not centred below the bar: ${JSON.stringify(end)}`);
  await p.waitForTimeout(300);
  const f0 = await p.evaluate(() => window.frames_); await p.waitForTimeout(1000);
  assert.equal(await p.evaluate(() => window.frames_), f0, `${width}px: a frame loop runs after the glide`);
  if (width === 1440) {
    // on to the checks: slower, its heading lifted mid-way and at rest at the end, the section's top under the bar
    await p.waitForTimeout(2500); // the sheet's skeleton has landed
    const c = await glideTo(p, 'a[data-glide="top"]', "#checks");
    const lift = await p.evaluate(() => window.__lift);
    const at = await p.evaluate(() => ({ top: document.getElementById("checks").getBoundingClientRect().top, bar: document.querySelector(".bar").getBoundingClientRect().bottom, focus: document.activeElement.id }));
    assert.ok(c.ms >= 2300 && c.ms <= 3700, `the glide to the checks took ${c.ms} ms`);
    assert.ok(Math.abs(at.top - at.bar) <= 2 && at.focus === "checks", `the glide to the checks ends at ${JSON.stringify(at)}`);
    assert.ok(lift.some((v) => v > 0.05 && v < 0.95), `the checks' heading was never seen turning up: ${lift.map((v) => v.toFixed(2)).join(" ")}`);
    await p.waitForTimeout(1300);
    assert.equal(await p.evaluate(() => getComputedStyle(document.getElementById("checks-title")).transform), "none", "the checks' heading is not at rest");
    // a wheel ends a glide where it is: back to the top, glide, wheel, and nothing more moves
    await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
    const b = await p.locator('a[data-glide="frame"][href="#preview"]').boundingBox();
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await p.waitForTimeout(500);
    await p.mouse.wheel(0, 40); await p.waitForTimeout(300);
    const stopped = await p.evaluate(() => scrollY); await p.waitForTimeout(900);
    assert.ok(stopped > 0 && (await p.evaluate(() => scrollY)) === stopped && (await p.evaluate(() => location.hash)) === "#checks", `a wheel did not end the glide (${stopped})`);
  }
  await done(t, `glide at ${width}px`, [API]);
}
{ // reduced motion: the ordinary jump
  const t = await open("index.html", { width: 1440, motion: "reduce" });
  const p = t.page;
  await p.click('a[data-glide="frame"][href="#preview"]'); await p.waitForTimeout(50);
  assert.deepEqual(await p.evaluate(() => [location.hash, Math.round(document.getElementById("preview").getBoundingClientRect().top)]), ["#preview", 88], "reduced motion: See a sample scan does not jump");
  await done(t, "glide with reduced motion", [API]);
}
// the filters' navy fill, the page turn and the raised cell (AH-92)
{
  const t = await open("index.html", { width: 1440 });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
  await p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 });
  const fill = (k) => p.evaluate((k) => new DOMMatrix(getComputedStyle(document.querySelector(`.typology button[data-kind="${k}"]`), "::before").transform).a, k);
  assert.ok((await fill("all")) === 1 && (await fill("keying")) === 0, "the pressed filter is not filled, or another one is");
  const k = await p.locator('.typology button[data-kind="keying"]').boundingBox();
  await p.mouse.move(k.x + 30, k.y + k.height / 2);
  const sweep = [];
  for (let i = 0; i < 8; i++) { sweep.push(await fill("keying")); await p.waitForTimeout(40); }
  await p.waitForTimeout(400);
  sweep.push(await fill("keying"));
  assert.ok(sweep.some((v) => v > 0.02 && v < 0.98) && sweep.at(-1) === 1, `the navy fill does not sweep in: ${sweep.map((v) => v.toFixed(2)).join(" ")}`);
  // a click turns the old view away: one copy, hidden from readers, no ids, gone within a second, while the real rows
  // already show the new filter
  await p.mouse.click(k.x + 30, k.y + k.height / 2);
  const turn = await p.evaluate(() => { const c = [...document.querySelectorAll("[data-turn]")];
    return { n: c.length, hidden: c.map((x) => x.getAttribute("aria-hidden")).join(), inert: c.every((x) => x.inert), ids: c.reduce((s, x) => s + x.querySelectorAll("[id]").length + (x.id ? 1 : 0), 0),
      lit: [...document.querySelectorAll("#p-found .grid tbody tr:not(.skip)")].filter((r) => getComputedStyle(r).opacity === "1").map((r) => r.querySelector("th").textContent).join(),
      real: getComputedStyle(document.getElementById("p-found")).transform }; });
  assert.deepEqual(turn, { n: 1, hidden: "true", inert: true, ids: 0, lit: "11,22", real: "none" }, "the page turn's copy");
  await p.waitForTimeout(300);
  const mid = await p.evaluate(() => { const c = document.querySelector("[data-turn]"); return c ? new DOMMatrix(getComputedStyle(c).transform).m11 : null; });
  assert.ok(mid !== null && mid < 0.99, `the copy is not turning at 300 ms (${mid})`);
  await p.waitForFunction(() => !document.querySelector("[data-turn]"), null, { timeout: 1000 });
  await p.click('.typology button[data-kind="all"]'); await p.waitForTimeout(800);
  await done(t, "filters and page turn", [API]);
}
for (const width of [1440, 390]) { // a coloured cell steps up when hovered, and nothing clips it
  const t = await open("index.html", { width });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  await p.evaluate(() => document.getElementById("preview").scrollIntoView());
  await p.waitForTimeout(400);
  await p.mouse.click(5, 5); // ends the skeleton
  const n = await p.$$eval("#p-found td.flag, #p-found td.q", (x) => x.length);
  for (let i = 0; i < n; i++) {
    const cell = p.locator("#p-found td.flag, #p-found td.q").nth(i);
    // on a phone the sheet scrolls sideways in its frame: the cell is brought to the middle of it first, as a reader would
    await cell.evaluate((td) => td.scrollIntoView({ block: "center", inline: "center" })); await p.waitForTimeout(100);
    const c = await cell.boundingBox(); await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await p.waitForTimeout(350);
    const r = await cell.evaluate((td) => { const a = td.getBoundingClientRect(), s = td.closest(".scroll").getBoundingClientRect(), m = new DOMMatrix(getComputedStyle(td).transform), x = (a.left + a.right) / 2, y = a.top + 3;
      return { scale: m.a, lift: m.f, inside: a.top >= s.top && a.bottom <= s.bottom && a.left >= s.left && a.right <= s.right, top: document.elementFromPoint(x, y) === td || td.contains(document.elementFromPoint(x, y)),
        shadow: getComputedStyle(td, "::before").opacity }; });
    assert.ok(r.scale > 1.05 && r.scale < 1.2 && r.lift < 0 && r.inside && r.top && r.shadow === "1", `${width}px: coloured cell ${i} on hover: ${JSON.stringify(r)}`);
  }
  await done(t, `raised cells at ${width}px`, [API]);
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
  // no skeleton (AH-89) and no page turn (AH-92): the data shows at once and a filter simply applies
  assert.deepEqual(await t.page.evaluate(() => [document.getElementById("preview").hasAttribute("data-loading"), document.querySelector("dl.anchor").hasAttribute("data-loading")]), [false, false], "a skeleton under reduced motion");
  await t.page.evaluate(() => document.getElementById("preview").scrollIntoView()); await t.page.waitForTimeout(300);
  await t.page.click('.typology button[data-kind="recon"]');
  assert.equal(await t.page.evaluate(() => document.querySelectorAll("[data-turn]").length), 0, "a page turn under reduced motion");
  await t.page.click('.typology button[data-kind="all"]');
  assert.equal(await t.page.evaluate(() => document.getAnimations().length), 0, "an animation runs under reduced motion");
  assert.deepEqual(await logo(t.page), { ...WHOLE, animated: false });
  assert.equal(await onTop(t.page), "banner,spear");
  assert.equal(await t.page.evaluate(() => document.querySelector("#download .logo").getAnimations({ subtree: true }).length), 0, "the logo moves under reduced motion");
  await done(t, "reduced motion", [API]);
}

// the entrance (AH-72, AH-90): the bar first (the notice line and the brand from the left, the links from the right), then
// the headlines and the text fly in from the left and the sample workspace rises, all at rest by ENTERED (lead + 4 steps +
// the entrance's length, from the tokens: 2.54 s with John's 2026-11-02 timings), timed by the clock: also with a frame
// only every 50 ms (a loaded machine, AH-22)
for (const slow of [false, true]) {
  const label = `entrance${slow ? " at 20 frames a second" : ""}`;
  const t = await open("index.html", { until: "domcontentloaded", init: slow ? () => { window.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 50); } : null });
  const t0 = Date.now(), p = t.page;
  await p.waitForTimeout(60);
  const early = await p.evaluate(() => { const x = (el) => new DOMMatrix(getComputedStyle(el).transform);
    return { head: x(document.querySelector(".hero-head")).e, fig: x(document.getElementById("preview")).f,
      notice: x(document.querySelector(".notice-bar p")).e, brand: x(document.querySelector(".bar .brand")).e, links: [...document.querySelectorAll(".bar .links a")].map((a) => x(a).e) }; });
  assert.ok(early.head < 0 && early.fig > 0, `${label}: nothing is on its way in just after load (${JSON.stringify(early)})`);
  assert.ok(early.notice < 0 && early.brand < 0 && early.links.length === 5 && early.links.every((v) => v > 0), `${label}: the bar is not coming in, left then right (${JSON.stringify(early)})`);
  await p.waitForTimeout(ENTERED - (Date.now() - t0));
  assert.ok(atRest(await poses(p, "[data-enter], .notice-bar p, .bar .brand, .bar .links a")), `${label}: not at rest by ${ENTERED} ms`);
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
  // a quarter of the way through the screen: the checks table's first row's hairline, its fifth row's, the three steps
  const spots = [];
  for (const sel of [".checks-table tbody tr:nth-child(1) .rule", ".checks-table tbody tr:nth-child(5) .rule", ".steps li:nth-child(1) .rule"]) spots.push(Math.round((await layoutTop(p, sel)) - vh * 0.75));
  for (const y of spots) {
    await go(0); await go(y);
    const a = await snap();
    assert.ok(JSON.parse(a.deco).some((x) => x.rule && x.sx > 0 && x.sx < 1), `${label}, scroll ${y}: no hairline is partly drawn`);
    await p.waitForTimeout(700);
    assert.deepEqual(await snap(), a, `${label}, scroll ${y}: still moving 700 ms after the scrolling stopped`);
    await go(await p.evaluate(() => document.documentElement.scrollHeight)); await go(y);
    assert.deepEqual(await snap(), a, `${label}, scroll ${y}: not the same after a trip to the bottom and back`);
  }
  // step by step: the second hairline (the checks table's second row) draws further, and the IT headline drifts further, at each of
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
  await p.waitForTimeout(ENTERED); // the entrance is over
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
  await p.waitForTimeout(ENTERED);
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
  const p = t.page, GRID = ".checks-table tbody > .reveal-item"; // the checks table's 8 rows (AH-98; they were 8 cards)
  const tok = await tokens(p);
  // John's 2026-11-02 timings (AH-90): an unhurried cascade, 90 ms apart, each item 1.1 s
  assert.ok(tok.ease === "cubic-bezier(.16, 1, .3, 1)" && tok.stagger === 90 && tok.dur === 1100 && tok.rise >= 20 && tok.rise <= 30 && tok.cap >= 1, `the motion tokens: ${JSON.stringify(tok)}`);
  // (a) before any scrolling: the checks below the fold wait one --reveal-rise down, see-through, on their own layer
  const before = await revealed(p, GRID);
  assert.equal(await p.evaluate(() => document.documentElement.hasAttribute("data-js")), true, "boot.js did not mark the page");
  assert.ok(before.length === 8 && before.every((x) => x.op === "0" && x.x === 0 && x.y === tok.rise && /transform/.test(x.will) && /opacity/.test(x.will) && !x.revealed),
    `the checks before they are seen: ${JSON.stringify(before[0])}`);
  // scrolled into view in one step once the hero's entrance is over, traced: the window runs from the scroll to the last
  // item's transitionend
  await p.waitForFunction(() => document.getAnimations().every((a) => a.timeline !== document.timeline), null, { timeout: 3000 });
  await p.evaluate(() => { let n = 0; addEventListener("transitionend", (e) => { if (e.propertyName === "opacity" && e.target.matches(".checks-table tbody > .reveal-item") && ++n === 8) console.timeStamp("reveal-end"); }, true); });
  await browser.startTracing(p, { categories: ["devtools.timeline"] });
  await p.evaluate(() => { const g = document.querySelector(".checks-table"); let top = 0; for (let e = g; e; e = e.offsetParent) top += e.offsetTop;
    console.timeStamp("reveal-start"); scrollTo(0, top - 120); });
  await p.waitForTimeout(100);
  const rising = await revealed(p, GRID);
  await p.waitForFunction(() => document.querySelectorAll(".checks-table tbody > [data-settled]").length === 8, null, { timeout: 4000 });
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
  assert.equal(await p.evaluate(() => [...document.querySelectorAll(".checks-table tbody > .reveal-item")].filter((e) => window.__unobserved.includes(e)).length), 8, "the observer still watches a revealed check");
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(300);
  await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop)); await p.waitForTimeout(50);
  assert.ok((await revealed(p, GRID)).every((x) => x.op === "1" && x.tf === "none"), "a check hid again after a trip away and back");
  reveal = { delays: after.map((x) => x.delay), layout: count("Layout", s1.ts), paint: count("Paint", s1.ts), layoutAll: count("Layout", last), paintAll: count("Paint", last), ms: Math.round((s1.ts - s0.ts) / 1000) };
  // composite only: no layout from the scroll to the last transitionend; letting go of will-change afterwards lays the
  // page out once a batch (two here: the checks' headline and lede above the table are one look, its rows another at most)
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
// the checks table's "In the sample above" links glide to the sample's own row, framed on the screen (AH-98)
{
  const t = await open("index.html", { width: 1440 });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  await p.evaluate(() => scrollTo(0, document.querySelector(".checks-table").getBoundingClientRect().top + scrollY - 200)); await p.waitForTimeout(1600);
  const b = await p.locator('.to-row[href="#r22"]').first().boundingBox();
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await p.waitForFunction(() => location.hash === "#r22", null, { timeout: 4500 });
  const r = await p.evaluate(() => { const x = document.getElementById("r22").getBoundingClientRect(), bar = document.querySelector(".bar").getBoundingClientRect().bottom;
    return { top: Math.round(x.top), bottom: Math.round(x.bottom), bar: Math.round(bar), h: innerHeight, focus: document.activeElement.id }; });
  assert.ok(r.top > r.bar && r.bottom < r.h && r.focus === "r22", `the link to row 22 does not land on it: ${JSON.stringify(r)}`);
  await done(t, "checks table row link", [API]);
}
// the field fades under the text outside the hero and the navy band (AH-98): each prose, list and table block there lies
// on a still layer of its own section's colour that reaches past it on every side; nothing in the hero or the band does
for (const [file, must] of [["index.html", ["#it .sec-lede", "#it .it-ledger", "#download .sec-lede", "#download dl.anchor", "#download .steps"]],
  ["privacy.html", [".page-head p", ".toc", ".prose"]], ["support.html", [".page-head p"]]]) {
  const t = await open(file, { width: 1440, motion: "reduce" });
  const r = await t.page.evaluate((must) => {
    const behind = (el) => { for (let e = el.parentElement; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== "rgba(0, 0, 0, 0)") return c; } return ""; };
    const bad = [];
    for (const sel of must) for (const el of document.querySelectorAll(sel)) if (!el.closest(".calm")) bad.push(`${sel} is not calm`);
    for (const el of document.querySelectorAll(".calm")) {
      const a = getComputedStyle(el, "::before");
      if (el.closest(".hero, #checks")) bad.push(`a calm block in the hero or the band: ${el.className}`);
      if (a.content !== '""' || a.position !== "absolute" || a.zIndex !== "-1" || a.backgroundColor !== behind(el) || !(parseFloat(a.top) < 0 && parseFloat(a.left) < 0 && parseFloat(a.right) < 0 && parseFloat(a.bottom) < 0))
        bad.push(`${el.className}: ${a.content} ${a.position} ${a.zIndex} ${a.backgroundColor} on ${behind(el)}, inset ${a.top} ${a.left}`);
    }
    return bad;
  }, must);
  assert.deepEqual(r, [], `${file}: the field is not faded under the text`);
  await done(t, `${file}: the field under the text`, [API]);
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
  await p.waitForTimeout(ENTERED);
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
const junk = {
  "a 403": json({ message: "API rate limit exceeded" }, 403), "no network": (r) => r.abort(), "not JSON": json("<html>"), "null": json("null"),
  "assets not a list": json({ assets: "x" }), "a list of nulls": json({ assets: [null, 7] }), "an uppercase digest": json({ assets: [{ name: "Arcas.exe", size: 1, digest: "sha256:" + "A".repeat(64) }] }),
  "markup in the digest": json({ tag_name: "<img src=x onerror=alert(1)>", assets: [{ name: "Arcas.exe", size: 1, digest: `sha256:${"a".repeat(64)}<img src=x>` }] }),
};
for (const [name, api] of Object.entries(junk)) {
  const t = await open("index.html", { api });
  assert.equal(await t.page.$eval("#sha", (c) => c.innerHTML), fallback, `API ${name}: the checksum fallback is gone`);
  assert.equal(await t.page.textContent("#rel"), "Latest, about 81 MB, free", `API ${name}`);
  await done(t, `API ${name}`, [API]);
}
{ // a good digest with odd neighbours: the hash shows, the rest only when it has the right shape (no "NaN MB")
  const t = await open("index.html", { api: json({ tag_name: "<img src=x onerror=alert(1)>", published_at: 5, assets: [{ name: "Arcas.exe", size: "<b>", digest: "sha256:" + "c".repeat(64) }] }) });
  assert.equal(await t.page.$eval("#sha", (c) => c.innerHTML), "c".repeat(64));
  assert.equal(await t.page.textContent("#rel"), "Latest · free");
  assert.equal(await t.page.$$eval("#rel *, #sha *", (x) => x.length), 0);
  await done(t, "API odd neighbours", [API]);
}
// the exe's name (AH-101): Arcas.exe's checksum when the release has it, the old name's for a release made before the rename
for (const [name, assets, sha] of [
  ["a release made before the rename", [{ name: "AnomalyHunter.exe", size: 81256476, digest: "sha256:" + "d".repeat(64) }], "d".repeat(64)],
  ["a release with both names", [{ name: "AnomalyHunter.exe", size: 1, digest: "sha256:" + "d".repeat(64) }, { name: "Arcas.exe", size: 81256476, digest: "sha256:" + "e".repeat(64) }], "e".repeat(64)],
]) {
  const t = await open("index.html", { api: json({ tag_name: "v0.1.90", assets }) });
  assert.equal(await t.page.$eval("#sha", (c) => c.innerHTML), sha, name);
  assert.equal(await t.page.textContent("#rel"), "v0.1.90 · 81 MB · free", name);
  await done(t, `API ${name}`, [API]);
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
// ---- contrast (AH-87): every text the pages show, read in Chromium against what lies under it, clears WCAG AA (4.5:1,
// 3:1 for large text), every text box's edge 3:1, every placeholder 4.5:1. The sample's filtered-out rows were faded
// to .3 (1.8:1), and the browser's own placeholder grey was 4.2:1. At rest (reduced motion: a rising block is see-through
// on purpose for 700 ms), on every page, each filter of the sample, and the support form with its messages shown ----
{
  const { contrastProblems } = await import(pathToFileURL(path.join(SITE, "..", "e2e", "contrast.mjs")).href);
  let checked = 0;
  for (const width of [1280, 390]) for (const file of PAGES) {
    const t = await open(file, { width, motion: "reduce" });
    const states = file === "index.html" ? ["all", "recon", "keying", "label", "time", "busy", "clean"] : file === "support.html" ? ["empty", "sent"] : ["page"];
    for (const state of states) {
      if (file === "index.html") await t.page.click(["busy", "clean"].includes(state) ? `#t-${state}` : `.typology [data-kind="${state}"]`);
      if (state === "sent") { await t.page.fill("#summary", "x"); await t.page.fill("#details", "y"); await t.page.check("#clean"); }
      if (file === "support.html") await t.page.click('button[type="submit"]');
      const bad = await t.page.evaluate(contrastProblems);
      assert.deepEqual(bad, [], `${file} at ${width}px (${state}): text or edges under WCAG AA`);
      checked++;
    }
    await done(t, `contrast of ${file} at ${width}px`, [API]);
  }
  console.log(`contrast: every text, text box edge and placeholder over WCAG AA in ${checked} page states`);
}
// ---- the sample's "⋯" rows stay rows (AH-87 fix round 1): the skip link's first class, .skip, was also the separator
// rows' (tr.skip), so its position: absolute pulled all five out of the table into one box at the sample's top left,
// and no check saw it. In every filter state, at both widths, each one spans the table body and sits between the rows
// before and after it ----
for (const width of [1280, 390]) {
  const t = await open("index.html", { width, motion: "reduce" });
  for (const kind of ["all", "recon", "keying", "label", "time"]) {
    await t.page.click(`.typology [data-kind="${kind}"]`);
    const bad = await t.page.$$eval(".grid tbody", ([body]) => {
      const b = body.getBoundingClientRect(), rows = [...body.rows], out = [];
      rows.forEach((tr, k) => {
        if (!tr.classList.contains("skip")) return;
        const r = tr.getBoundingClientRect(), before = rows[k - 1]?.getBoundingClientRect(), after = rows[k + 1]?.getBoundingClientRect();
        if (getComputedStyle(tr).position !== "static" || Math.abs(r.width - b.width) > 1 || (before && r.top < before.bottom - 1) || (after && r.bottom > after.top + 1))
          out.push({ row: k, top: Math.round(r.top), width: Math.round(r.width), body: Math.round(b.width), before: before && Math.round(before.bottom), after: after && Math.round(after.top) });
      });
      return out;
    });
    assert.deepEqual(bad, [], `index.html at ${width}px, filter ${kind}: a "⋯" row is out of its place in the table`);
  }
  await done(t, `the sample's separator rows at ${width}px`, [API]);
}
console.log('sample: every "⋯" row spans the table body between its neighbours, in all 5 filter states at both widths');
// ---- the skip link (AH-87): the notice bar, the brand and five links came before the page's content on every page, for
// every keyboard visit. The first Tab lands on "Skip to content", shown while it has focus; Enter puts focus on the
// page's content. After a page transition #page is the new page's <main>, and the link still lands there ----
{
  const at = (p) => p.evaluate(() => { const a = document.activeElement, r = a.getBoundingClientRect();
    return { el: a.className || a.id || a.tagName, text: a.textContent.trim(), page: a.id === "page" ? a.dataset.page : null, shown: r.top >= 0 && r.bottom <= innerHeight && r.width > 2 }; });
  for (const [file, page] of [["index.html", "home"], ["privacy.html", "privacy"], ["support.html", "support"]]) for (const width of [1280, 390]) {
    const t = await open(file, { width });
    await t.page.keyboard.press("Tab");
    const first = await at(t.page);
    assert.deepEqual([first.el, first.text, first.shown], ["skip-link", "Skip to content", true], `${file} at ${width}px: the first Tab does not show the skip link (${JSON.stringify(first)})`);
    await t.page.keyboard.press("Enter");
    assert.equal((await at(t.page)).page, page, `${file} at ${width}px: Enter on the skip link does not put focus on the page's content`);
    await done(t, `skip link on ${file} at ${width}px`, [API]);
  }
  const t = await open("index.html");
  await t.page.click('header a[href="privacy.html"]');
  await t.page.waitForURL((u) => u.pathname === "/privacy.html");
  await t.page.waitForFunction(() => document.querySelectorAll("main").length === 1);
  await t.page.focus(".skip-link"); await t.page.keyboard.press("Enter");
  assert.equal((await at(t.page)).page, "privacy", "after a page transition the skip link does not land on the new page's content");
  await done(t, "skip link after a page transition", [API]);
  console.log("skip link: first on every page, at both widths, and after a page transition");
}
// ---- a slow phone (AH-87): every check above runs at full speed on a fast box; the "4 s with the CPU slowed 8x" of
// AH-22 was one manual run. Here the home page opens on a 390 x 844 phone with the CPU slowed 4x and a slow 4G line
// (150 ms latency, 1.6 Mbps down, 750 kbps up), is scrolled to its end a screen at a time, and must show its headline
// quickly, bring every block into place, leave nothing hidden, and log no error. The budgets are twice the slowest of 5
// runs measured on 2026-11-02 (headline first shown 1066-1205 ms, at rest 1968-2028 ms, every block in place 617-624 ms
// after the last scroll), so a slower page fails and a busy box does not ----
{
  const BUDGET = { shown: 2500, rest: 4100, settled: 1300 };
  let t0 = 0;
  const t = await open("index.html", { width: 390, height: 844, until: "commit", setup: async (p) => {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
    t0 = Date.now();
  } });
  const p = t.page;
  await p.waitForFunction(() => { const h = document.querySelector(".hero-head"); return !!h && +getComputedStyle(h).opacity > 0; }, null, { polling: "raf", timeout: 30000 });
  const shown = Date.now() - t0;
  await p.waitForFunction(() => { const c = getComputedStyle(document.querySelector(".hero-head")); return c.opacity === "1" && c.transform === "none"; }, null, { polling: "raf", timeout: 30000 });
  const rest = Date.now() - t0;
  await p.waitForLoadState("load");
  // the network really is slow: the stylesheet alone, 150 ms away at 1.6 Mbps
  const css = await p.evaluate(() => performance.getEntriesByName(new URL("styles.css", location.href).href)[0].duration);
  assert.ok(css > 300, `the slow line is not slow: styles.css came in ${Math.round(css)} ms`);
  for (let k = 0; k < 80; k++) { // a screen at a time, as a thumb scrolls
    await p.mouse.move(195, 420); await p.mouse.wheel(0, 700); await p.waitForTimeout(150);
    if (await p.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 2)) break;
  }
  assert.ok(await p.evaluate(() => innerHeight + scrollY >= document.documentElement.scrollHeight - 2), "the slow phone never reached the end of the page");
  const s1 = Date.now();
  await p.waitForFunction(() => [...document.querySelectorAll(".reveal-item, [data-enter]")].every((e) => { const c = getComputedStyle(e); return c.opacity === "1" && c.transform === "none"; }),
    null, { polling: 50, timeout: 30000 }).catch(() => {});
  const settled = Date.now() - s1, left = await readable(p);
  console.log(`slow phone (4x CPU, slow 4G, 390 x 844): headline shown at ${shown} ms and at rest at ${rest} ms, every block in place ${settled} ms after the last scroll, styles.css took ${Math.round(css)} ms`);
  assert.ok(shown <= BUDGET.shown, `slow phone: the headline first showed at ${shown} ms (budget ${BUDGET.shown})`);
  assert.ok(rest <= BUDGET.rest, `slow phone: the headline came to rest at ${rest} ms (budget ${BUDGET.rest})`);
  assert.ok(settled <= BUDGET.settled, `slow phone: the last block came into place ${settled} ms after the scroll (budget ${BUDGET.settled})`);
  assert.deepEqual([left.hooked, left.hidden], [0, 0], `slow phone: after a full scroll ${left.hooked} blocks are not in place and ${left.hidden} of ${left.texts} texts are hidden`);
  await done(t, "slow phone", [API]);
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
  await p.waitForTimeout(ENTERED);
  await p.evaluate(() => { window.__marker = 1; scrollTo(0, 1200); });
  await p.waitForTimeout(300);
  await watch(p);
  const cast = await screencast(p);
  const { x, y } = await p.locator('header a[href="privacy.html"]').boundingBox();
  await p.mouse.move(x + 4, y + 4); await p.waitForTimeout(150); // hovering fetches the page ahead
  await press(p, 'header a[href="privacy.html"]');
  await p.waitForURL((u) => u.pathname === "/privacy.html");
  // the bar stays mounted and never plays its entrance again (AH-90)
  assert.equal(await p.evaluate(() => [...document.querySelectorAll(".notice-bar p, .bar .brand, .bar .links a")].reduce((n, e) => n + e.getAnimations().length, 0)), 0, "the bar's entrance replayed on a page change");
  await settle(p); await p.waitForTimeout(150);
  await cast.stop();
  const w = await stopWatch(p);
  const after = await p.evaluate(() => ({ marker: window.__marker, title: document.title, body: document.body.id, mains: document.querySelectorAll("main#page").length,
    page: document.getElementById("page").dataset.page, current: document.querySelector('header a[aria-current="page"]').getAttribute("href"),
    desc: document.querySelector('meta[name="description"]').content, canonical: document.querySelector('link[rel="canonical"]').href,
    og: document.querySelector('meta[property="og:url"]').content, focus: document.activeElement.tagName + (document.activeElement.closest("#page") ? " in #page" : ""),
    brand: document.querySelector("header .brand").getAttribute("href"), notice: document.querySelector(".notice-bar a").getAttribute("href"), gl: !!document.getElementById("field") }));
  assert.deepEqual(after, { marker: 1, title: TITLE["privacy.html"], body: "privacy", mains: 1, page: "privacy", current: "privacy.html",
    canonical: PUBLIC["privacy.html"], og: PUBLIC["privacy.html"], desc: after.desc.startsWith("What Arcas keeps") ? after.desc : "(the home page's)", focus: "H1 in #page", brand: "index.html", notice: "index.html#download", gl: true }, "the move to privacy.html");
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
  assert.ok(back.marker === 1 && Math.abs(back.y - 1200) <= 2 && back.title === TITLE["index.html"] && back.current === "index.html", `Back: ${JSON.stringify(back)}`);
  // GitHub's answer is kept for the visit: no skeleton on the facts the second time (AH-89), nor on the sheet
  assert.deepEqual(await p.evaluate(() => [document.querySelector("dl.anchor").hasAttribute("data-loading"), document.getElementById("preview").hasAttribute("data-loading")]), [false, false], "a skeleton on a visit back");
  await p.waitForTimeout(1400);
  await p.click('.rowbtn[aria-controls="m11"]');
  assert.deepEqual(await p.evaluate(() => [document.getElementById("m11").hidden, document.activeElement.className]), [false, "m-close"], "the workspace's detail box after Back");
  await p.keyboard.press("Escape");
  await p.click('.typology button[data-kind="label"]');
  assert.equal(await p.$$eval("#p-found .grid tbody tr:not(.skip)", (rs) => rs.filter((r) => getComputedStyle(r).opacity === "1").map((r) => r.querySelector("th").textContent).join()), "31", "the filters after Back");
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
  await p.waitForTimeout(ENTERED);
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
  await p.waitForTimeout(ENTERED);
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
  assert.deepEqual([w.both, w.anims, await p.evaluate(() => [window.__marker, document.title, document.getAnimations().length])], [0, 0, [1, TITLE["privacy.html"], 0]], "reduced motion: a slide");
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
  assert.deepEqual(await p.evaluate(() => [window.__marker, document.title, document.getElementById("page").dataset.page]), [undefined, TITLE["privacy.html"], "privacy"], "a failed fetch did not fall back to a normal navigation");
  await done(t, "page transition with a failed fetch", [API]);
}
console.log(`page transitions: ${measured.moving} ms of motion on screen (${measured.swap} ms in the page, ${measured.duration} ms from the click), both pages in ${measured.both} of ${measured.ofFrames} frames, ` +
  `the whitest of ${measured.frames} screencast frames ${(measured.white * 100).toFixed(2)}% white; seeked to its middle (${measured.mid.t} ms, the seek took ${measured.mid.spent} ms) the old page shows ${measured.mid.old.toFixed(1)} px and the new ${measured.mid.new.toFixed(1)} px of ${measured.mid.width}, ` +
  `overlap ${measured.mid.overlap.toFixed(1)} px (worst frame ${measured.overlap.toFixed(1)} px), the edge ${measured.mid.seam.toFixed(1)} px off the boundary; ` +
  `at 20 frames a second: middle ${measured.slow.mid.t} ms, ${measured.slow.mid.old.toFixed(1)} / ${measured.slow.mid.new.toFixed(1)} px, overlap ${measured.slow.mid.overlap.toFixed(1)} px (worst frame ${measured.slow.overlap.toFixed(1)} px), edge ${measured.slow.mid.seam.toFixed(1)} px off, both pages in ${measured.slow.both} of ${measured.slow.ofFrames} frames`);
await browser.close();
server.close();
console.log("website browser check passed");
