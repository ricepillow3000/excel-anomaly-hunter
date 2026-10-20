// The website (site/): every link lands, nothing loads from outside, the scripts degrade safely. node tools/test_site.mjs
// adds the browser half with --browser (Playwright + Chromium; tools/check.py runs it with --e2e). No real network:
// GitHub's API is answered by stand-ins, and the support form must build its link without sending anything.
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site");
const PAGES = ["index.html", "privacy.html", "support.html"];
const SCRIPTS = ["home.js", "support.js"];
const REPO = "https://github.com/ricepillow3000/excel-anomaly-hunter";
const API = "https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest";
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const html = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
const ids = (src) => [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const attr = (src, name) => [...src.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) => m[1]);

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
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ${new URL(API).origin}; base-uri 'none'; form-action 'none'">`), `${p}: CSP missing or changed`);
  // axe 4.10, 2026-10-20: an empty header cell is read as nothing; the announcement line sat outside every landmark
  assert.ok(!/<th[^>]*><\/th>/.test(src), `${p}: an empty <th>`);
  assert.ok(/<aside class="notice-bar" aria-label="Announcement">/.test(src), `${p}: the announcement line is not a landmark`);
}
// a box that scrolls sideways must take keyboard focus, or a keyboard user can't read its end
assert.ok(/<code class="line" tabindex="0">/.test(html["index.html"]), "the PowerShell line scrolls but can't be focused");

const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g, "");
for (const url of css.match(/url\([^)]*\)/g)) assert.ok(/^url\("(data:|assets\/)/.test(url), `styles.css loads ${url}`);
const used = PAGES.map((p) => html[p]).join("") + SCRIPTS.map(read).join("");
const classes = new Set(used.match(/class="[^"]*"/g).flatMap((c) => c.slice(7, -1).split(/\s+/)));
for (const c of new Set(css.replace(/url\([^)]*\)/g, "").match(/\.[a-zA-Z_][\w-]*/g))) assert.ok(classes.has(c.slice(1)), `styles.css styles ${c}, which no page uses`);

for (const f of SCRIPTS) {
  const src = read(f);
  new vm.Script(src, { filename: f }); // a syntax error throws here
  // dynamic values reach the page only as text: GitHub's answer and what people type are never parsed as HTML
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), `${f}: writes HTML`);
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
const release = { tag_name: "v0.1.102", published_at: "2026-10-20T05:15:43Z", assets: [{ name: "AnomalyHunter.exe", size: 81256476, digest: "sha256:" + "ab".repeat(32) }] };
const json = (body, status = 200) => (r) => r.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });

async function open(file, { width = 1280, api = json(release), motion = "no-preference" } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: motion });
  const page = await ctx.newPage();
  const problems = [], outside = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type()) && !/^Failed to load resource/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("response", (r) => { if (r.url().startsWith(BASE) && r.status() >= 400) problems.push(`${r.status()} ${r.url()}`); }); // console hides these above
  page.on("request", (r) => { if (!r.url().startsWith(BASE) && !r.url().startsWith("data:")) outside.push(r.url()); });
  await page.route("https://api.github.com/**", api);
  await page.route(/^https:\/\/(?!api\.github\.com)/, (r) => r.abort()); // a page must never reach anywhere else
  await page.goto(BASE + file, { waitUntil: "networkidle" });
  return { ctx, page, problems, outside };
}
const done = async ({ ctx, problems, outside }, label, allowed = []) => {
  assert.deepEqual(problems, [], `${label}: console errors`);
  assert.deepEqual(outside.filter((u) => !allowed.includes(u)), [], `${label}: requests outside the site`);
  await ctx.close();
};

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

// the sample workspace: tabs, arrow keys, filters, and a detail box per flagged row
{
  const t = await open("index.html");
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
  // the cursor light follows the pointer, then stops asking for frames: no loop runs while nothing moves
  await p.evaluate(() => { window.frames_ = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => (window.frames_++, raf(f)); });
  await p.mouse.move(200, 300); await p.mouse.move(900, 500, { steps: 8 });
  await p.waitForTimeout(2500);
  const settled = await p.evaluate(() => window.frames_); await p.waitForTimeout(1000);
  assert.ok(settled > 0 && (await p.evaluate(() => window.frames_)) === settled, "the cursor light keeps a frame loop running when idle");
  // the scroll bleeds: alabaster at the top, navy past the hero, wine at the download band, and back on the way up
  const backdrop = () => p.evaluate(() => { const b = document.querySelector(".backdrop"); return [getComputedStyle(b).backgroundColor, getComputedStyle(b, "::after").opacity]; });
  assert.deepEqual(await backdrop(), ["rgb(247, 245, 240)", "0"]);
  await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop)); await p.waitForTimeout(100);
  assert.deepEqual(await backdrop(), ["rgb(12, 25, 56)", "0"]);
  await p.evaluate(() => scrollTo(0, document.body.scrollHeight)); await p.waitForTimeout(100);
  assert.deepEqual((await backdrop())[1], "1");
  // ... and the banner has assembled, scrubbed by the same scroll
  assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".wm-panel-l")).opacity), "1");
  await p.evaluate(() => scrollTo(0, 0)); await p.waitForTimeout(100);
  assert.deepEqual(await backdrop(), ["rgb(247, 245, 240)", "0"]);
  assert.equal(await p.textContent("#sha"), "ab".repeat(32));
  assert.equal(await p.textContent("#rel"), "v0.1.102, 2026-10-20 · 81 MB · free");
  await done(t, "workspace", [API]);
}
{ // with reduced motion: no cursor light, the banner sits finished
  const t = await open("index.html", { motion: "reduce" });
  await t.page.mouse.move(300, 300); await t.page.mouse.move(800, 400, { steps: 4 });
  assert.equal(await t.page.evaluate(() => document.querySelector(".hero").style.cssText), "");
  assert.equal(await t.page.evaluate(() => getComputedStyle(document.querySelector(".wm-bar")).animationName), "none");
  await done(t, "reduced motion", [API]);
}

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
for (const width of [1280, 390]) {
  const t = await open("support.html", { width });
  const p = t.page;
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
  await done(t, `support form at ${width}px`);
}
await browser.close();
server.close();
console.log("website browser check passed");
