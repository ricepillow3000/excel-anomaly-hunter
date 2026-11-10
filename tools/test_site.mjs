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
const PAGES = ["index.html", "privacy.html", "support.html", "terms.html", "thanks.html"];
// the thank-you page the home page's contact form leads to (AH-133): a page of the site like the others, but kept out of
// search (noindex) and out of the sitemap, and reached only through the form, so no link points to it
const NOINDEX = ["thanks.html"];
const INDEXED = PAGES.filter((p) => !NOINDEX.includes(p));
// the page GitHub Pages shows for a missing address (AH-126): no script, kept out of search (noindex) and out of the
// sitemap, and every link on it root-absolute, since it is served at whatever depth the missing address had
const MISSING = "404.html";
const SCRIPTS = ["boot.js", "motion.js", "field.js", "home.js", "support.js", "transition.js", "count.js"];
const REPO = "https://github.com/ricepillow3000/excel-anomaly-hunter";
const API = "https://api.github.com/repos/ricepillow3000/excel-anomaly-hunter/releases/latest";
// where GitHub Pages publishes each page (pages.yml uploads site/ whole): the canonical, og:url and sitemap.xml say these
const SITE_URL = "https://ricepillow3000.github.io/excel-anomaly-hunter/";
const PUBLIC = { "index.html": SITE_URL, "privacy.html": SITE_URL + "privacy.html", "support.html": SITE_URL + "support.html", "terms.html": SITE_URL + "terms.html", "thanks.html": SITE_URL + "thanks.html" };
// the CSP of every page. img-src names GoatCounter for the visit counter's one pixel (count.js, AH-126), which sends
// nothing until John sets his code there; the 404 page loads no script, so it keeps the stricter policy
const CSP = (counter) => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:${counter ? " https://*.goatcounter.com" : ""}; font-src 'self'; connect-src 'self' ${new URL(API).origin}; base-uri 'none'; form-action 'none'`;
const ROOT_PATH = new URL(SITE_URL).pathname; // "/excel-anomaly-hunter/"
const read = (f) => fs.readFileSync(path.join(SITE, f), "utf8");
const html = Object.fromEntries(PAGES.map((p) => [p, read(p)]));
const TITLE = Object.fromEntries(PAGES.map((p) => [p, (/<title>([^<]*)<\/title>/.exec(html[p]) || [])[1]]));
const ids = (src) => [...src.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
// one fixed pattern for every attribute, filtered by name: semgrep blocks a RegExp built from a variable (ReDoS)
const attr = (src, name) => [...src.matchAll(/\s([a-z-]+)="([^"]*)"/g)].filter((m) => m[1] === name).map((m) => m[2]);

// every page is one a visitor can reach: an old mock left in site/ (tool-preview.html) was served to anyone who guessed it
const linked = new Set(PAGES.flatMap((p) => attr(html[p], "href")).map((h) => h.split("#")[0]).filter((h) => h && !/^[a-z]+:/.test(h)));
for (const f of fs.readdirSync(SITE).filter((f) => f.endsWith(".html") && f !== MISSING)) assert.ok(PAGES.includes(f) && (linked.has(f) || NOINDEX.includes(f)), `${f} is not linked from the site`);
// ... and the thank-you page is the one the contact form goes to
assert.ok(/"thanks\.html"/.test(read("support.js")), "support.js never leads to thanks.html");

for (const p of PAGES) {
  const src = html[p];
  const own = ids(src);
  assert.deepEqual(own.filter((id, i) => own.indexOf(id) !== i), [], `${p}: duplicate ids`);
  // every local link and file resolves, and every #anchor exists on the page it points to
  for (const ref of [...attr(src, "href"), ...attr(src, "src"), ...attr(src, "srcset").map((s) => s.split(" ")[0])]) {
    if (/^(https?:|mailto:|tel:)/.test(ref)) continue; // a tel: link (the privacy page's phone, AH-125) is no file
    const [file, anchor] = ref.split("#");
    const target = file || p;
    assert.ok(fs.existsSync(path.join(SITE, target)), `${p}: ${ref} points to a missing file`);
    if (anchor) assert.ok(ids(read(target)).includes(anchor), `${p}: ${ref} points to a missing anchor`);
  }
  for (const name of ["aria-controls", "aria-labelledby", "aria-describedby", "for"]) for (const id of attr(src, name).flatMap((v) => v.split(" "))) assert.ok(own.includes(id), `${p}: ${name}="${id}" names no element`);
  // nothing loads from outside: fonts, styles, scripts and images are our own files; the CSP makes the browser hold to it
  // (the one exception, <link rel="canonical">, loads nothing: it names the page's own public address, checked below)
  for (const tag of src.match(/<(script|link|img)\b[^>]*>/g)) {
    const url = (/\s(?:src|href)="([^"]*)"/.exec(tag) || [])[1] || "";
    if (/^<link rel="canonical" href="[^"]*">$/.test(tag) && url === PUBLIC[p]) continue;
    assert.ok(!/^(https?:)?\/\//.test(url), `${p}: loads ${url} from outside`);
  }
  assert.ok(!/<script>|<style|\sstyle="|\son[a-z]+="/.test(src), `${p}: inline script or style (the CSP would block it)`);
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP(true)}">`), `${p}: CSP missing or changed`);
  // axe 4.10, 2026-10-20: an empty header cell is read as nothing; the announcement line sat outside every landmark
  assert.ok(!/<th[^>]*><\/th>/.test(src), `${p}: an empty <th>`);
  assert.ok(/<aside class="notice-bar" aria-label="Announcement">/.test(src), `${p}: the announcement line is not a landmark`);
  assert.ok(/<body[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<a class="skip-link" href="#page">Skip to content<\/a>/.test(src), `${p}: "Skip to content" is not the first thing in <body>`);
  // page transitions (AH-73): one swappable container a page, and every script on every page (the document never
  // reloads, so a page reached by a transition runs only what the first page loaded)
  assert.equal(src.match(/<main\b[^>]*>/g).join(), `<main id="page" data-page="${{ "index.html": "home", "privacy.html": "privacy", "support.html": "support", "terms.html": "terms", "thanks.html": "thanks" }[p]}">`, `${p}: not one <main id="page">`);
  assert.deepEqual(attr(src, "src").filter((s) => s.endsWith(".js")), SCRIPTS, `${p}: does not load every script once`);
}
// a box that scrolls sideways must take keyboard focus, or a keyboard user can't read its end
assert.ok(/<code class="line" tabindex="0">/.test(html["index.html"]), "the PowerShell line scrolls but can't be focused");
// ... and so must the sample's tables, which scroll sideways on a phone: a named region a keyboard can reach (AH-126)
{
  const boxes = html["index.html"].match(/<div class="scroll"[^>]*>/g) || [];
  assert.ok(boxes.length === 2 && boxes.every((b) => /\stabindex="0"/.test(b) && /\srole="region"/.test(b) && /\saria-label="[^"]{8,}"/.test(b)), `a sample table's scroll box is not a named region with tabindex="0": ${boxes}`);
}

// ---- John's website lists (AH-126, 2026-11-04) ----
const missing = read(MISSING);
const ALL = [...PAGES, MISSING];
const allHtml = { ...html, [MISSING]: missing };
const metaOf = (src, key, name) => [...src.matchAll(/<meta ([a-z]+)="([^"]+)" content="([^"]*)">/g)].filter((m) => m[1] === key && m[2] === name).map((m) => m[3]);
const pngSize = (f) => { const b = fs.readFileSync(path.join(SITE, f)); assert.equal(b.toString("latin1", 1, 4), "PNG", `${f} is not a PNG`); return [b.readUInt32BE(16), b.readUInt32BE(20), b.length]; };
// the 404 page: its own title and description, noindex, the exact CSP with no counter, the skip link first, the site's
// look (the stylesheet and font by root-absolute paths), and links home, to the download, support and privacy
{
  const src = missing, own = ids(src);
  assert.ok(/^Arcas\b.{10,}$/.test((/<title>([^<]*)<\/title>/.exec(src) || [])[1] || ""), "404.html: no title of its own");
  assert.ok((metaOf(src, "name", "description")[0] || "").length >= 30, "404.html: no description");
  assert.deepEqual(metaOf(src, "name", "robots"), ["noindex"], "404.html: not noindex");
  assert.ok(src.includes(`<meta http-equiv="Content-Security-Policy" content="${CSP(false)}">`), "404.html: CSP missing or changed");
  assert.ok(!/<script\b|<link rel="canonical"|\son[a-z]+="|\sstyle="|<style/.test(src), "404.html: a script, an inline style or a canonical");
  assert.ok(/<body[^>]*>\s*<a class="skip-link" href="#page">Skip to content<\/a>/.test(src), "404.html: the skip link is not first in <body>");
  assert.equal(src.match(/<main\b[^>]*>/g).join(), '<main id="page" data-page="missing">', "404.html: not one <main id=\"page\">");
  assert.deepEqual(own.filter((id, i) => own.indexOf(id) !== i), [], "404.html: duplicate ids");
  for (const ref of [...attr(src, "href"), ...attr(src, "src")]) {
    if (/^(https:|tel:)/.test(ref) || ref === "#page") continue;
    assert.ok(ref.startsWith(ROOT_PATH), `404.html: ${ref} is not root-absolute (the page is served at any depth)`);
    const [file, anchor] = ref.slice(ROOT_PATH.length).split("#");
    assert.ok(fs.existsSync(path.join(SITE, file || "index.html")), `404.html: ${ref} points to a missing file`);
    if (anchor) assert.ok(ids(read(file || "index.html")).includes(anchor), `404.html: ${ref} points to a missing anchor`);
  }
  for (const href of ["", "index.html#download", "support.html", "privacy.html", "styles.css"]) assert.ok(attr(src, "href").includes(ROOT_PATH + href), `404.html: no link to ${ROOT_PATH + href}`);
}
// every page's footer: Privacy, Terms, Support and the public repository, and the note that the site tracks no one
for (const p of ALL) {
  const foot = (/<footer[\s\S]*<\/footer>/.exec(allHtml[p]) || [""])[0], hrefs = attr(foot, "href").map((h) => (h.startsWith(ROOT_PATH) ? h.slice(ROOT_PATH.length) : h));
  for (const want of ["privacy.html", "terms.html", "support.html", REPO]) assert.ok(hrefs.includes(want), `${p}: the footer does not link ${want}`);
  assert.ok(foot.includes("No cookies, no tracking of you."), `${p}: the footer lacks "No cookies, no tracking of you."`);
}
// the phone's menu: a Menu button right before the links it opens; styles.css hides those links only once JavaScript
// has marked the page (boot.js's data-js), so with no script they show
for (const p of PAGES) assert.ok(html[p].includes('<button class="menu-btn" type="button" aria-expanded="false" aria-controls="main-nav">Menu</button><nav class="links" id="main-nav" aria-label="Main">'), `${p}: no Menu button before the links`);
// the home page: the hero's main button goes to the download, and the phone's download bar waits hidden for home.js
assert.ok(/<div class="hero-cta"><a class="btn btn-primary" href="#download">Download for Windows<\/a>/.test(html["index.html"]), "the hero has no main download button");
assert.ok(/<div class="dock" id="dock" hidden><a class="btn btn-primary" href="#download">Download for Windows<\/a><\/div>/.test(html["index.html"]), "the home page has no hidden download bar");
for (const p of PAGES.filter((p) => p !== "index.html")) assert.ok(!html[p].includes('id="dock"'), `${p}: a download bar off the home page`);
// what to do when the checksum differs
assert.ok(html["index.html"].includes("If they differ, delete the file and download it again."), "the checksum step does not say what to do when the hashes differ");
const EMAIL = "john4000.nguyen@gmail.com", MAILTO = `<a href="mailto:${EMAIL}">${EMAIL}</a>`;
// the support page: John's name, phone (a tel: link) and his one email address (a mailto: link, AH-134), and the thank-you once the link to
// GitHub is followed, announced as a status; the ready text describes the link
{
  const src = html["support.html"];
  assert.ok(src.includes('<a href="tel:+17702659930">(770) 265-9930</a>') && /John Nguyen/.test(src), "support.html: no contact block with John Nguyen and his phone");
  assert.ok(src.includes(MAILTO), "support.html: John's email is not a mailto link in the contact block");
  assert.ok(/<span id="ready">Ready\./.test(src) && /<a [^>]*id="open"[^>]*aria-describedby="ready"/.test(src), "support.html: the link to GitHub is not described by its ready text");
  assert.ok(/<p id="thanks" role="status" hidden>Thanks\./.test(src), "support.html: no hidden thank-you status");
}
// the visit counter: our own few lines, inert until John puts his GoatCounter code in COUNTER, and never GoatCounter's script
{
  const src = read("count.js");
  // empty until John signs up, then his code (docs/security-and-launch-checklist.md, AH-126): the shape of a host's first part
  assert.ok(/^\s*const COUNTER = "[a-z0-9-]{0,63}";$/m.test(src), "count.js: COUNTER is not one string constant holding an empty or a GoatCounter code");
  assert.ok(src.includes('"https://" + COUNTER + ".goatcounter.com/count?p=" + encodeURIComponent(location.pathname)'), "count.js: the pixel is not the page's path alone");
  for (const p of ALL) assert.ok(!/gc\.zgo\.at|goatcounter\.com\/count\.js/.test(allHtml[p]), `${p}: loads GoatCounter's own script`);
}
// compressed images (John's website list, AH-126): every picture the site ships stays small, so a phone on slow 4G
// pays for none of them; the largest today is the 512 px icon at 19 KB
for (const f of fs.readdirSync(path.join(SITE, "assets")).filter((f) => /\.(png|jpe?g|webp|gif|svg)$/.test(f))) {
  const kb = fs.statSync(path.join(SITE, "assets", f)).size / 1024;
  assert.ok(kb <= 32, `assets/${f} is ${Math.round(kb)} KB: compress it to 32 KB or less`);
}
// Open Graph: one 1200 x 630 card, named on every page with its size and words, and the large Twitter card
{
  const [w, h, bytes] = pngSize("assets/og-card.png");
  assert.ok(w === 1200 && h === 630 && bytes <= 120 * 1024, `assets/og-card.png is ${w} x ${h}, ${Math.round(bytes / 1024)} KB`);
  for (const p of PAGES) {
    const src = html[p], img = SITE_URL + "assets/og-card.png";
    for (const [key, name, value] of [["property", "og:image", img], ["property", "og:image:width", "1200"], ["property", "og:image:height", "630"], ["name", "twitter:card", "summary_large_image"], ["name", "twitter:image", img]])
      assert.deepEqual(metaOf(src, key, name), [value], `${p}: ${name} is not ${value}`);
    assert.ok((metaOf(src, "property", "og:image:alt")[0] || "").length >= 20, `${p}: no og:image:alt`);
  }
}
// the icons: 32 and 64 for tabs, 180 for an iPhone's home screen, 192 for Android, 512 for an install prompt
{
  for (const [f, n] of [["crest2-32.png", 32], ["crest2-64.png", 64], ["crest2-180.png", 180], ["crest2-192.png", 192], ["crest2-512.png", 512]]) {
    const [w, h] = pngSize("assets/" + f);
    assert.ok(w === n && h === n, `assets/${f} is ${w} x ${h}, not ${n} x ${n}`);
  }
  for (const p of ALL) {
    const at = p === MISSING ? ROOT_PATH : "";
    assert.ok(allHtml[p].includes(`<link rel="apple-touch-icon" href="${at}assets/crest2-180.png">`) && allHtml[p].includes(`<link rel="icon" href="${at}assets/crest2-192.png" sizes="192x192">`), `${p}: no 180 apple-touch-icon or 192 icon`);
  }
}
// every image is described or marked as decoration, every inline drawing is hidden from readers or named, no
// placeholder is left in what a user reads, and every outside link goes to a host the site already uses
{
  const HOSTS = ["github.com", "aistudio.google.com", "988lifeline.org", "findahelpline.com", "signpath.io", "signpath.org", "ricepillow3000.github.io", "www.goatcounter.com",
    "www.linkedin.com", "app.joinhandshake.com", // John's profiles beside his photo (AH-133): plain links, nothing loaded from them
    "creativecommons.org"]; // the case studies' licence (AH-133)
  // on github.com: this project's own pages, and the FiveThirtyEight tables the case studies credit (AH-133)
  const OURS = ["/ricepillow3000", "/fivethirtyeight/data/tree/master/"];
  const PLACEHOLDER = /lorem|ipsum|\bTODO\b|\bTBD\b|example\.com|Your Name|placeholder text|\bXXX\b/i;
  const SAID = ["N/A and TBD placeholders"]; // the Completeness check finds a "TBD" left in a sheet: it names it, it is not one
  for (const p of ALL) {
    const src = allHtml[p];
    // AH-133: an alt says what the picture shows, in words: never a file name, nor "image" or "photo" alone
    for (const tag of src.match(/<img\b[^>]*>/g) || []) {
      const alt = (/\salt="([^"]*)"/.exec(tag) || [])[1];
      assert.ok((alt && alt.trim().split(/\s+/).length >= 3 && !/\.(png|jpe?g|webp|gif|svg)\b/i.test(alt) && !/^(an? )?(image|photo|picture|logo|icon)$/i.test(alt.trim()))
        || (alt === "" && /\saria-hidden="true"/.test(tag)), `${p}: an image with no meaningful alt: ${tag}`);
    }
    for (const tag of src.match(/<svg\b[^>]*>/g) || []) assert.ok(/\saria-hidden="true"/.test(tag) || /\saria-label="[^"]+"/.test(tag), `${p}: an inline svg neither hidden nor named: ${tag.slice(0, 80)}`);
    let text = src.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, " ").replace(/<(?![^>]*\s(?:alt|aria-label|placeholder|title|content)=)[^>]*>/g, " ");
    for (const ok of SAID) text = text.split(ok).join(" ");
    const hit = PLACEHOLDER.exec(text);
    assert.ok(!hit, `${p}: a placeholder left in what a user reads: "${hit && hit[0]}"`);
    for (const href of attr(src, "href").filter((h) => /^https?:/.test(h))) {
      const u = new URL(href);
      assert.ok(u.protocol === "https:" && HOSTS.includes(u.host) && (u.host !== "github.com" || OURS.some((o) => u.pathname.startsWith(o))), `${p}: links outside the allowed hosts: ${href}`);
    }
  }
}
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
// AH-125: the privacy policy is one click from every page, in the footer as well as the header
for (const p of PAGES) assert.ok(/<footer[\s\S]*<a href="privacy\.html"[^>]*>[\s\S]*<\/footer>/.test(html[p]), `${p}: the footer does not link the privacy page`);

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
// only transform, translate and opacity are ever animated: the GPU composites them without a layout or a paint (AH-85).
// One exception (AH-138): the Copy button's two icons crossfade with a blur, so filter may move in a rule whose every
// selector is a .copy-btn's .ico, and in no other transition and no keyframes
{
  const flat = (v) => { let x = v; while (/\([^()]*\)/.test(x)) x = x.replace(/\([^()]*\)/g, ""); return x; };
  const ICO = /^\.copy-btn(?:\[[a-z-]+\])? \.ico$/;
  const moved = [], blurred = [];
  for (const [, sel, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const props = [...body.matchAll(/(?:^|[;{\s])transition(?:-property)?\s*:\s*([^;}]+)/g)].flatMap((m) => flat(m[1]).split(",").map((t) => t.trim().split(/\s+/)[0]));
    const icon = sel.split(",").every((x) => ICO.test(x.trim().replace(/\s+/g, " ")));
    for (const prop of props) { if (prop === "filter" && icon) blurred.push(sel.trim()); else moved.push(prop); }
  }
  const frames = [];
  for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) frames.push(...[...m[1].matchAll(/\{([^{}]*)\}/g)].flatMap((b) => [...b[1].matchAll(/([a-z-]+)\s*:/g)].map((d) => d[1])));
  moved.push(...frames);
  assert.ok(moved.length >= 6, `styles.css: the animated properties were not found (${moved})`);
  for (const prop of moved) assert.ok(["transform", "translate", "opacity"].includes(prop), `styles.css animates ${prop}, which the GPU cannot composite alone`);
  // the exception is used where it is meant, and filter moves nowhere else (a transition elsewhere or a keyframe fails above)
  assert.ok(blurred.length >= 1 && !frames.includes("filter"), `styles.css: the Copy button's icon blur is not the one filter that moves (${blurred})`);
}
// AH-138 fix round 1: a tap never flashes the browser's own box over our pressed look, and the paper under the text
// feathers out over 96 px on a wide screen (32 px left straight edges where the contour lines stopped)
{
  const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [m[1].split(",").map((x) => x.trim()), m[2]]);
  const tap = rules.find(([sel, body]) => ["a", "button", "summary", '[role="tab"]'].every((x) => sel.includes(x)) && /-webkit-tap-highlight-color\s*:\s*transparent/.test(body));
  assert.ok(tap, "styles.css: no -webkit-tap-highlight-color: transparent on a, button, summary and [role=\"tab\"]");
  const calm = rules.filter(([sel]) => sel.includes(".calm::before")).map(([, body]) => body)[0] || "";
  assert.ok(/inset:\s*-96px/.test(calm) && /#000 96px/.test(calm) && /calc\(100% - 96px\)/.test(calm), `styles.css: .calm::before does not feather over 96 px (${calm.trim()})`);
}
// AH-138 (John, 2026-11-06): no spring and no bounce: every curve keeps both control points' y within [0, 1], so nothing
// overshoots its place; the new tokens are there, a popover's exit is 20% shorter than its entrance, and the entrance is
// a dropdown's 150 to 250 ms
{
  const curves = [...css.matchAll(/cubic-bezier\(([^)]*)\)/g)].map((m) => m[1].split(",").map(Number));
  assert.ok(curves.length >= 3, "styles.css: no cubic-bezier curves found");
  for (const [x1, y1, x2, y2] of curves) assert.ok([x1, y1, x2, y2].every(Number.isFinite) && y1 >= 0 && y1 <= 1 && y2 >= 0 && y2 <= 1, `styles.css: cubic-bezier(${x1}, ${y1}, ${x2}, ${y2}) overshoots (a bounce)`);
  const num = (n) => { assert.ok(/^\d*\.?\d+$/.test(TOKENS[n] || ""), `styles.css: ${n} is not a number (${TOKENS[n]})`); return parseFloat(TOKENS[n]); };
  assert.deepEqual([msOf("--stagger-row"), msOf("--land-step"), num("--press"), msOf("--press-dur"), num("--pop-from"), msOf("--slide-dur"), num("--stretch"), msOf("--scroll-weight"), msOf("--pulse-dur")],
    [30, 30, 0.97, 120, 0.95, 300, 1.12, 150, 600], "styles.css: the AH-138 tokens");
  const pin = msOf("--pop-in"), pout = msOf("--pop-out");
  assert.ok(pin >= 150 && pin <= 250 && Math.abs(pout - 0.8 * pin) < 0.5, `styles.css: a popover enters in ${pin} ms (150 to 250) and leaves in ${pout} ms (0.8 of it)`);
}
for (const url of css.match(/url\([^)]*\)/g)) assert.ok(/^url\("(data:|assets\/)/.test(url), `styles.css loads ${url}`);
const used = PAGES.map((p) => html[p]).join("") + read(MISSING) + SCRIPTS.map(read).join("");
const classes = new Set(used.match(/class="[^"]*"/g).flatMap((c) => c.slice(7, -1).split(/\s+/)));
for (const c of new Set(css.replace(/url\([^)]*\)/g, "").match(/\.[a-zA-Z_][\w-]*/g))) assert.ok(classes.has(c.slice(1)), `styles.css styles ${c}, which no page uses`);

// AH-117: a negative letter-spacing (h1 -.02em, h2, the brand...) is one of the looks John listed as generated; type keeps
// the spacing its designer drew
for (const m of css.matchAll(/letter-spacing\s*:\s*([^;}]+)/g)) assert.ok(!/^-/.test(m[1].trim()), `styles.css: a negative letter-spacing (${m[1].trim()})`);
// AH-120: everything that acts as a button shows it is pressed; a hover alone said nothing to a finger on a phone
{
  const selectors = [...css.matchAll(/([^{}]+)\{/g)].flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/\s+/g, " ")));
  for (const sel of [".btn", ".links .btn-trim", ".typology button", ".tabs button", ".rowbtn", ".m-close", ".faq summary", ".menu-btn", ".copy-btn"])
    assert.ok(selectors.includes(sel + ":active"), `styles.css: no pressed (:active) look for ${sel}`);
}
// AH-119: each page names itself to search engines and to a shared link: its own title (Arcas first, then what the page
// is), a description, a canonical at its public address, and the basic Open Graph tags (the 1200 x 630 card since AH-126,
// checked above). sitemap.xml lists exactly the indexable pages at those addresses, never the 404 or the thank-you page.
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
    assert.deepEqual(meta(src, "name", "twitter:card"), ["summary_large_image"], `${p}: no twitter:card`);
  }
  const map = read("sitemap.xml");
  assert.ok(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">[\s\S]*<\/urlset>\s*$/.test(map), "sitemap.xml is not a sitemap");
  const body = map.replace(/<!--[\s\S]*?-->/g, "").replace(/^<\?xml[^>]*\?>\s*<urlset[^>]*>|<\/urlset>\s*$/g, "");
  assert.ok(/^(\s*<url>\s*<loc>[^<]+<\/loc>\s*<\/url>)*\s*$/.test(body), "sitemap.xml holds more than <url><loc> entries");
  assert.deepEqual([...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), INDEXED.map((p) => PUBLIC[p]), "sitemap.xml does not list exactly the indexable pages at their canonical addresses");
  // every indexable page is open to search; the thank-you page (and 404.html, above) is noindex and out of the sitemap
  for (const p of PAGES) assert.deepEqual(meta(html[p], "name", "robots"), NOINDEX.includes(p) ? ["noindex"] : [], `${p}: robots is not ${NOINDEX.includes(p) ? "noindex" : "unset"}`);
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
// AH-129: what the home page claims holds. The install lists the add-in through \\localhost\C$, an admin share, so a
// standard account cannot install it; the fallback size went stale (81 MB for a 75 MB file) while home.js writes the
// live one; the hero promised that nothing changes until you accept it, but Auto-fix (off at first) writes by itself
{
  const home = html["index.html"], said = (re) => ((re.exec(home) || [])[1] || "").replace(/<[^>]+>/g, "");
  const scope = said(/<dt>Who can install it<\/dt><dd>([\s\S]*?)<\/dd>/);
  assert.ok(!/no administrator rights/i.test(home) && /must be an administrator on this PC/.test(scope), `the install scope says "${scope}"`);
  assert.ok(!/\d\s*MB/.test(said(/<dd id="rel">([\s\S]*?)<\/dd>/)), "the release line's fallback names a size that goes stale (home.js writes the live one)");
  const hero = said(/<section class="hero"[\s\S]*?<p>([\s\S]*?)<\/p>/);
  assert.ok(/until you click Accept/.test(hero) && /Auto-fix/.test(hero), `the hero leaves out Auto-fix: "${hero}"`);
  assert.ok(/further down/.test(said(/<span class="note">([\s\S]*?)<\/span>/)) && !/at the end of the page/.test(home), "the hero note says the download is at the end of the page");
  const version = (/<input id="version"[^>]*placeholder="([^"]*)"/.exec(html["support.html"]) || [])[1];
  assert.ok(version !== undefined && !/\d/.test(version), `the support form's version placeholder names a version that goes stale: "${version}"`);
}
// ---- John's website list of 2026-11-05 (AH-133): who makes Arcas with his photo and profiles, a contact form with our
// own thank-you page, five questions, measured proof instead of reviews, structured data for search, and alt text ----
{
  const home = html["index.html"], text = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  // one fixed pattern for every section, picked by id: semgrep blocks a RegExp built from a variable
  const sections = Object.fromEntries([...home.matchAll(/<section\b[^>]*\sid="([\w-]+)"[\s\S]*?<\/section>/g)].map((m) => [m[1], m[0]]));
  const section = (id) => sections[id] || "";
  // who makes it: his photo, two sizes of one small WebP, its box reserved (width and height) and loaded only near the
  // screen; his phone; LinkedIn, Handshake and GitHub as plain links, each an inline drawing named by its link
  const maker = section("maker");
  assert.ok(maker, 'the home page has no section id="maker"');
  const img = (/<img\b[^>]*>/.exec(maker) || [""])[0];
  for (const want of ['src="assets/john-240.webp"', 'srcset="assets/john-240.webp 1x, assets/john-480.webp 2x"', 'width="240"', 'height="300"', 'alt="John Nguyen, who makes Arcas"', 'loading="lazy"', 'decoding="async"'])
    assert.ok(img.includes(want), `the maker's photo lacks ${want}: ${img}`);
  for (const [f, w, h] of [["john-240.webp", 240, 300], ["john-480.webp", 480, 600]]) {
    const b = fs.readFileSync(path.join(SITE, "assets", f));
    assert.ok(b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP", `assets/${f} is not a WebP`);
    // a lossy WebP (VP8) carries its size at bytes 26-29; a VP8X container would mean extra chunks (EXIF, XMP, ICC)
    assert.equal(b.toString("latin1", 12, 16), "VP8 ", `assets/${f} carries more than the picture (metadata chunks)`);
    assert.deepEqual([b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff], [w, h], `assets/${f} is not ${w} x ${h}`);
    assert.ok(!/Exif|<x:xmpmeta|GPS/.test(b.toString("latin1")), `assets/${f} carries EXIF, XMP or GPS data`);
  }
  assert.ok(/Made in the United States by John Nguyen/.test(text(maker)), "the maker section does not say where Arcas is made, and by whom");
  // John's own story leads the section, in his words and only his facts (AH-136, John 2026-11-05): his first business
  // class, its weekly Excel exercises, cells that got worse the longer he worked; then what Arcas does about it
  const story = (/<div class="story">([\s\S]*?)<\/div>/.exec(maker) || ["", ""])[1];
  for (const said of ["It started on my first day of business class.", "the longer I stayed on a sheet, the lower the quality of my cells",
    "Fatigue is part of being human", "suggests a fix you can accept or dismiss"]) assert.ok(text(story).includes(said), `John's story lacks: ${said}`);
  assert.ok(maker.indexOf('class="story"') < maker.indexOf("Made in the United States"), "John's story is not above his byline");
  assert.ok(maker.includes('<a href="tel:+17702659930">(770) 265-9930</a>'), "the maker section has no tap-to-call phone");
  const PROFILES = [["LinkedIn", "https://www.linkedin.com/in/johnnguyen3000/"], ["Handshake", "https://app.joinhandshake.com/profiles/74fwhv"], ["GitHub", "https://github.com/ricepillow3000"]];
  const links = [...maker.matchAll(/<a class="btn btn-plain" href="(https:[^"]+)" aria-label="([^"]+)">(<svg\b[^>]*>)[\s\S]*?<\/svg>([^<]*)<\/a>/g)];
  assert.deepEqual(links.map((m) => [m[4], m[1]]), PROFILES, "the maker's profile links are not LinkedIn, Handshake and GitHub, in that order, at John's addresses");
  for (const m of links) assert.ok(m[2] === `John Nguyen on ${m[4]}` && /\saria-hidden="true"/.test(m[3]) && !/\starget=/.test(m[0]), `a profile link is not named for its site or its drawing is not hidden: ${m[0].slice(0, 160)}`);
  // AH-134: John's one email address beside his phone, a mailto link, and never any other address on any page
  assert.ok(maker.includes(MAILTO), "the maker section has no mailto link to John's email");
  for (const p of ALL) for (const a of allHtml[p].match(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi) || []) assert.equal(a, EMAIL, `${p}: an email address that is not John's`);
  // the contact form: a button near the top glides to it; name, what it is about, a message; the reply time beside it
  // and beside the support form
  assert.ok(/<div class="hero-cta">[\s\S]*?<a class="btn [^"]+" href="#contact" data-glide="top">Contact John<\/a>[\s\S]*?<\/div>/.test(home), "the hero has no Contact John button that glides to the form");
  const card = (/<section class="form-card[^"]*" id="contact"[\s\S]*?<\/section>/.exec(home) || [""])[0];
  assert.ok(card, "the home page has no contact form card");
  for (const [id, tag] of [["c-name", "input"], ["c-topic", "select"], ["c-message", "textarea"]]) assert.ok(card.includes(`<${tag} id="${id}"`), `the contact form has no ${tag}#${id}`);
  assert.deepEqual([...card.matchAll(/<option>([^<]+)<\/option>/g)].map((m) => m[1]), ["A question", "A problem", "An idea"], "the contact form's choices");
  for (const p of ["index.html", "support.html"]) assert.ok(html[p].includes('<p class="reply">John replies within 2 business days.</p>'), `${p}: no "John replies within 2 business days." beside the form`);
  assert.ok(!/no reply-time promise/.test(html["support.html"]), "support.html still says there is no reply-time promise");
  // the form's link opens the repository's contact issue form, whose fields are the ones support.js fills
  const yml = fs.readFileSync(path.join(SITE, "..", ".github", "ISSUE_TEMPLATE", "contact.yml"), "utf8");
  for (const id of ["name", "topic", "message"]) assert.ok([...yml.matchAll(/\n\s+id: (\w+)\n/g)].some((m) => m[1] === id), `contact.yml has no field id ${id}`);
  for (const o of ["A question", "A problem", "An idea"]) assert.ok(yml.includes(`        - ${o}\n`), `contact.yml's topic lacks "${o}"`);
  const sjs = read("support.js");
  assert.ok(sjs.includes(`"${REPO}/issues/new?template="`) && sjs.includes('prefilled("contact.yml", [["title", ') && sjs.includes('["name", v("c-name")], ["topic", v("c-topic")]], ["message", v("c-message")])'), "support.js does not build the contact issue's link from its name, topic and message");
  // the thank-you page: says where the message is, that it is public there, the reply time, and leads back
  const thanks = text((/<main[\s\S]*<\/main>/.exec(html["thanks.html"]) || [""])[0]);
  // AH-135: GitHub names its button Create, not Submit, and may first ask to sign in: the page says what a person meets
  for (const want of ["GitHub", "public", "John replies within 2 business days", "the green button at the bottom", "sign in", "Nothing reaches John until you do"]) assert.ok(thanks.includes(want), `thanks.html does not say "${want}"`);
  assert.ok(/<a class="btn btn-primary" href="index\.html">/.test(html["thanks.html"]), "thanks.html does not lead back home");
  // five questions on the home page, in the support page's markup (no script: <details> opens itself), none of them a
  // copy of a support answer
  const faq = section("faq");
  const qs = [...faq.matchAll(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>\s*<div class="a">([\s\S]*?)<\/div>\s*<\/details>/g)].map((m) => [text(m[1]), text(m[2])]);
  assert.equal(qs.length, 5, `the home page has ${qs.length} questions, not 5`);
  const supportAnswers = [...html["support.html"].matchAll(/<div class="a">([\s\S]*?)<\/div>/g)].map((m) => text(m[1]));
  for (const [q, a] of qs) assert.ok(!supportAnswers.includes(a), `"${q}" copies a support answer word for word`);
  // structured data: inline data blocks the browser never runs (so the CSP needs no change), each valid JSON, saying
  // what the page says
  const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const of = (type) => blocks.find((b) => b["@type"] === type) || assert.fail(`no ${type} block on the home page`);
  for (const p of PAGES.filter((p) => p !== "index.html")) assert.ok(!/application\/ld\+json/.test(html[p]), `${p}: structured data off the home page`);
  const app = of("SoftwareApplication");
  assert.deepEqual([app.name, app.operatingSystem, app.applicationCategory, app.offers && app.offers.price, app.downloadUrl, app.license],
    ["Arcas", "Windows", "BusinessApplication", "0", REPO + "/releases/latest/download/Arcas.exe", REPO + "/blob/main/LICENSE"], "the SoftwareApplication block");
  assert.ok(home.includes(`href="${app.downloadUrl}"`), "the SoftwareApplication's download is not the page's download");
  const person = of("Person");
  assert.deepEqual([person.name, person.image, person.email, person.sameAs], ["John Nguyen", SITE_URL + "assets/john-480.webp", "mailto:" + EMAIL, PROFILES.map(([, u]) => u)], "the Person block");
  const faqLd = of("FAQPage").mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
  assert.deepEqual(faqLd, qs, "the FAQPage block does not say what the questions on the page say, word for word");
  // proof instead of reviews: each number is read from the stress test's own record, so it cannot drift from it
  const proof = section("proof"), doc = fs.readFileSync(path.join(SITE, "..", "docs", "proof", "2026-11-05-stress-test.md"), "utf8");
  const benches = [...doc.matchAll(/^\| Planted mistakes found, (\w+) bench \((\d+) sheets[^|]*\| (\d+) of (\d+), (\d+) Medium\+ false alarms in ([\d,]+) clean rows \|$/gm)];
  const bench = (name) => { const m = benches.find((b) => b[1] === name);
    assert.ok(m, `docs/proof/2026-11-05-stress-test.md has no ${name} bench row`); return m.slice(2); };
  const [iSheets, iFound, iPlanted, iFalse, iClean] = bench("industry"), [bSheets, bFound, bPlanted, bFalse, bClean] = bench("blind");
  const items = [...proof.matchAll(/<div class="reveal-item">(?:<span class="rule" aria-hidden="true"><\/span>)?<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>\s*<\/div>/g)].map((m) => [text(m[1]), text(m[2]), m[2]]);
  assert.deepEqual(items.map(([n]) => n), [`${iFound} of ${iPlanted}`, `${bFound} of ${bPlanted}`, `${Math.max(+iFalse, +bFalse)}`, "Free", "On your PC"], "the proof strip's figures");
  // in plain words since AH-148 ("bench" and "tuned on" were the engine room's words): the figures still the record's
  assert.ok(items[0][1].includes(`found in ${iSheets} test sheets`) && items[1][1].includes(`found in ${bSheets} more test sheets it had never seen`), "the proof strip's benches");
  assert.ok(items[2][1].includes(`${iClean} and ${bClean} clean rows`), "the proof strip's clean rows");
  const PROOF = REPO + "/blob/main/docs/proof/2026-11-05-stress-test.md";
  for (const [i, href] of [[0, PROOF], [1, PROOF], [2, PROOF], [3, REPO + "/blob/main/LICENSE"], [4, "privacy.html"]]) assert.ok(items[i][2].includes(`href="${href}"`), `proof item ${i + 1} does not link ${href}`);
}
// ---- AH-135, a usability review for a person with few computer skills: a way to reach John with no GitHub account,
// the install in the order a person meets it, the IT section named for who reads it, and plain names for the checks ----
{
  const home = html["index.html"], sup = html["support.html"], text = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  const TEL = '<a href="tel:+17702659930">(770) 265-9930</a>';
  const sections = Object.fromEntries([...home.matchAll(/<section\b[^>]*\sid="([\w-]+)"[\s\S]*?<\/section>/g)].map((m) => [m[1], m[0]]));
  // the thank-you page: one more step, said as a person meets it, and a way round GitHub
  const th = (/<main[\s\S]*<\/main>/.exec(html["thanks.html"]) || [""])[0];
  assert.equal(text((/<h1\b[^>]*>([\s\S]*?)<\/h1>/.exec(th) || [])[1] || ""), "One more step to send your message", "thanks.html's heading");
  assert.ok(text(th).includes("A new tab opened on GitHub. If it asks you to sign in, make a free account or sign in, and your message will be waiting. Then press the green button at the bottom to send it. Nothing reaches John until you do."), "thanks.html does not say what to do in the new tab");
  assert.ok(th.includes(`Rather not make an account? Email John at ${MAILTO} or call ${TEL}.`), "thanks.html has no way to reach John without an account");
  // both forms: Email John instead beside the GitHub button (a mailto link support.js fills from the form), and one
  // line that says what GitHub is
  const HELP = "GitHub is a free website where John keeps Arcas and answers questions. No account? Use Email John instead.";
  for (const [p, form, id] of [["index.html", "note", "c-email"], ["support.html", "ticket", "email"]]) {
    const f = (/<form id="(\w+)"[\s\S]*?<\/form>/.exec(html[p].slice(html[p].indexOf(`<form id="${form}"`))) || [""])[0];
    assert.ok(f, `${p}: no form #${form}`);
    // a fixed pattern, the id compared after (a RegExp built from a name is what Semgrep refuses, CLAUDE.md)
    const pair = /<button class="btn btn-primary[^"]*" type="submit">[^<]+<\/button>\s*<a class="btn btn-plain" id="([\w-]+)" href="mailto:([^"]+)">Email John instead<\/a>/.exec(f);
    assert.ok(pair && pair[1] === id && pair[2] === EMAIL, `${p}: no Email John instead beside the GitHub button`);
    assert.ok(text(f).includes(HELP), `${p}: the form does not say what GitHub is`);
    assert.ok(/This is public/.test(f), `${p}: the public-data warning is gone`);
  }
  const sjs = read("support.js");
  assert.ok(sjs.includes(`EMAIL = "${EMAIL}"`) && sjs.includes("`mailto:${EMAIL}?subject=${q(subject)}&body=") && /MAIL_FITS = 1800\b/.test(sjs), "support.js does not build a mailto link that fits a mail app's limit");
  // the support form: a phone call near the top, the version optional, the box said in plain words
  const card = (/<section class="form-card"[\s\S]*?<\/section>/.exec(sup) || [""])[0];
  assert.ok(card.indexOf(`Rather talk? Call John at ${TEL} or email ${MAILTO}.`) > -1 && card.indexOf("Rather talk?") < card.indexOf('<form id="ticket"'), "support.html: no call or email line above the form");
  assert.ok(/<label for="version">Engine version \(optional\)<\/label>/.test(card) && /<input id="version"[^>]*>\s*<span class="hint">[^<]*John can help you find it[^<]*<\/span>/.test(card), "support.html: the engine version is not marked optional with help");
  assert.ok(/<label class="confirm[^"]*"><input id="clean" type="checkbox" required><span>I did not paste real numbers from work, or any key or code John gave me\.<\/span><\/label>/.test(card), "support.html: the required box's words");
  // the install: who may install it first, the browser's warning under the download, the steps in the order a person
  // meets them, and the checksum and Unblock in a closed box under them (the published hash stays in the facts list:
  // home.js fills it from GitHub's answer under that list's skeleton)
  const dl = sections["download"] || "";
  assert.ok(text((/<p class="sec-lede[^"]*">([\s\S]*?)<\/p>/.exec(dl) || [])[1] || "").startsWith("On a work computer, ask your IT team first. Arcas installs only on a Windows account that is an administrator on that PC."), "the install's first line");
  const stage = (/<div class="stage[\s\S]*?<\/div>/.exec(dl) || [""])[0];
  assert.ok(/Download for Windows<\/a>\s*<p class="[^"]+">Your browser may say Arcas\.exe isn't commonly downloaded\. Click the three dots beside it, then Keep, then Keep anyway\. It says this because the file is new and not signed yet\.<\/p>/.test(stage), "no browser warning under the download button");
  const steps = [...((/<div class="steps[\s\S]*?<\/ol>/.exec(dl) || [""])[0]).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map((m) => text(m[1]));
  assert.equal(steps.length, 4, `the install has ${steps.length} steps, not 4`);
  assert.ok(/Downloads/.test(steps[0]) && /Windows protected your PC/.test(steps[1]) && /More info/.test(steps[1]) && /Run anyway/.test(steps[1]), `the first steps: ${steps.slice(0, 2)}`);
  assert.ok(steps[2].includes("Windows names it Anomaly Hunter local CA, Arcas's old name. It only lets Excel talk to Arcas on this computer. Click Yes. If you click No, the install stops, and you can run it again."), `the certificate step: ${steps[2]}`);
  assert.ok(/Start here/.test(steps[3]) && /Find problems/.test(steps[3]) && /Practice/.test(steps[3]), `the last step: ${steps[3]}`);
  assert.ok(!/past Windows' checks/.test(dl), "the steps' heading still says past Windows' checks");
  const check = (/<details class="[^"]*">\s*<summary>Want to check the file first\? \(optional\)<\/summary>[\s\S]*?<\/details>/.exec(dl) || [""])[0];
  assert.ok(check && dl.indexOf(check) > dl.indexOf("</ol>") && check.includes("Get-FileHash .\\Arcas.exe -Algorithm SHA256") && check.includes("If they differ, delete the file and download it again.") && /SHA-256/.test(check) && /Unblock/.test(check), "the checksum and Unblock are not in a closed box under the steps");
  // the home page's questions: how to tell which Excel you have, and what leaves the PC, in plain words
  const faq = sections["faq"] || "";
  assert.ok(text(faq).includes("To check, open Excel and click File > Account. If it says Microsoft 365 under Product information, you have the right Excel. Click About Excel: the first line ends with 64-bit or 32-bit."), "the FAQ does not say how to check which Excel you have");
  assert.ok(text(faq).includes("No, not when it checks your sheet. Arcas does all its checking on your own computer and sends nothing. Part of your sheet leaves your computer only when you click Ask AI or Check words with AI. Then it goes to Google, through John's own server first unless you saved your own Google key. The privacy page lists exactly what goes."), "the FAQ's data answer");
  // a phone can't install it: said under the hero's download, on narrow screens only
  assert.ok(/<div class="hero-cta">[\s\S]*?<\/div>\s*<p class="phone-only">Arcas runs on a Windows computer\. Open this page on that computer to download it\.<\/p>/.test(home), "no phone line under the hero's download");
  assert.ok(/\.phone-only\s*\{\s*display:\s*none;?\s*\}/.test(css) && /@media \(max-width: 760px\)[\s\S]*\.phone-only\s*\{\s*display:\s*block;?\s*\}/.test(css), "the phone line is not shown on narrow screens only");
  // the uninstall in numbered steps, its command as it was
  const un = (/<details[^>]*id="uninstall"[\s\S]*?<\/details>/.exec(sup) || [""])[0];
  // AH-136: first where people look, Settings' Installed apps, which now lists Arcas; the command only for an older install
  assert.ok(/<ol>\s*<li>Open Settings, then Apps, then Installed apps\.<\/li>\s*<li>Find Arcas in the list, click the three dots beside it, then Uninstall\.<\/li>\s*<\/ol>/.test(un), "the uninstall does not start with Settings > Apps > Installed apps");
  assert.ok(!/not listed in Windows/.test(un) && /the app file too/.test(un) && un.indexOf("Installed apps") < un.indexOf("Windows key and R"), "the uninstall still says Arcas is not in Installed apps, or puts the command first");
  assert.ok(/<ol>\s*<li>Press the Windows key and R together\.<\/li>\s*<li>Copy the line below and paste it into the box that opens\.<\/li>\s*<li>Press Enter\.<\/li>\s*<\/ol>/.test(un) && un.includes('<code>"%LOCALAPPDATA%\\AnomalyHunter\\Arcas.exe" uninstall</code>'), "the uninstall is not three numbered steps with its command");
  // the installer's message for a standard account, answered on the support page under its own words
  const ADMIN = "Arcas could not finish. Your Windows account is not an administrator on this PC. Ask the person who looks after your computers to install it for you.";
  assert.ok([...sup.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].some((m) => text(m[1]).includes(ADMIN)), "support.html has no question for the installer's administrator message");
  // the hero says what changes and what is further down
  assert.ok(text((/<span class="note">([\s\S]*?)<\/span>/.exec(home) || [])[1] || "") === "Free · for Windows with desktop Excel · download and install steps further down", "the hero's note");
  assert.ok(text((/<section class="hero"[\s\S]*?<p>([\s\S]*?)<\/p>/.exec(home) || [])[1] || "").endsWith("Nothing in your sheet changes until you click Accept. An optional Auto-fix can tidy stray capitals and spaces for you."), "the hero's promise");
  // the IT section is named for who reads it, and says a person can skip it
  const it = sections["it"] || "";
  assert.equal(text((/<h2\b[^>]*>([\s\S]*?)<\/h2>/.exec(it) || [])[1] || ""), "For your IT team", "the IT section's heading");
  assert.ok(text(it).includes("You don't need this part to use Arcas. Share it with whoever looks after your computers."), "the IT section does not say a person can skip it");
  assert.deepEqual([...it.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]), ["Price", "Who can install it", "Internet use", "What leaves this PC"], "the IT section's items");
  // the sample's filters and the checks table in plain names
  assert.deepEqual([...home.matchAll(/<button type="button" data-kind="(\w+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]),
    [["all", "All findings"], ["recon", "Totals that don't add up"], ["keying", "Typing slips"], ["label", "Same word, typed two ways"], ["time", "Odd jumps over time"]], "the sample's filters");
  for (const old of ["Reconciliation breaks", "Keying errors<span", "Label mismatches", "Temporal outliers"]) assert.ok(!home.includes(old), `the home page still says ${old}`);
  // the maker's phone and email come before his photo on a phone, or the photo stays small: here it stays a third wide
  assert.ok(/@media \(max-width: 760px\)[\s\S]*\.maker img\s*\{[^}]*width:\s*min\(33%, 240px\)/.test(css), "the maker's photo fills a phone's width");
}
// ---- AH-148 (John, 2026-11-09): "feel more immersive, alive, less AI and human... while keeping technical data simple and
// easy to read". The type and the page's details, held to the font file itself where a number comes from it ----
// a WOFF2 file's tables (its header, its table directory, one Brotli stream: the W3C WOFF2 format), so a figure styles.css
// takes from the font is read from the font, never typed twice
const WOFF2_TAGS = "cmap head hhea hmtx maxp name OS/2 post cvt  fpgm glyf loca prep CFF  VORG EBDT EBLC gasp hdmx kern LTSH PCLT VDMX vhea vmtx BASE GDEF GPOS GSUB EBSC JSTF MATH CBDT CBLC COLR CPAL SVG  sbix acnt avar bdat bloc bsln cvar fdsc feat fmtx fvar gvar hsty just lcar mort morx opbd prop trak Zapf Silf Glat Gloc Feat Sill".match(/.{4}\s?/g).map((t) => t.slice(0, 4));
function woff2(file) {
  const b = fs.readFileSync(path.join(SITE, file)), dir = [];
  assert.equal(b.toString("latin1", 0, 4), "wOF2", `${file} is not a WOFF2 file`);
  let at = 48;
  const u128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const x = b[at++]; v = v * 128 + (x & 127); if (!(x & 128)) return v; } return v; };
  for (let i = 0, n = b.readUInt16BE(12); i < n; i++) {
    const f = b[at++], tag = (f & 63) === 63 ? b.toString("latin1", at, (at += 4)) : WOFF2_TAGS[f & 63], len = u128();
    dir.push([tag, (["glyf", "loca"].includes(tag) ? f >> 6 === 0 : f >> 6 !== 0) ? u128() : len]);
  }
  const data = zlib.brotliDecompressSync(b.subarray(at, at + b.readUInt32BE(20))), tables = {};
  let o = 0;
  for (const [tag, len] of dir) { tables[tag] = data.subarray(o, o + len); o += len; }
  return tables;
}
{
  const font = woff2("assets/plus-jakarta-sans.woff2"), upm = font.head.readUInt16BE(18), os2 = font["OS/2"];
  const features = (t) => { const list = t.readUInt16BE(6); return new Set([...Array(t.readUInt16BE(list))].map((_, i) => t.toString("latin1", list + 2 + i * 6, list + 6 + i * 6))); };
  const [ascent, descent, gap, xHeight] = [os2.readInt16BE(68) / upm, -os2.readInt16BE(70) / upm, os2.readInt16BE(72) / upm, os2.readInt16BE(86) / upm];
  assert.ok(os2.readUInt16BE(62) & 128, "the font does not say to use its typographic metrics (OS/2 USE_TYPO_METRICS)");
  // a selector list split at its top-level commas only (":is(:hover, :focus-visible)" is one selector)
  const split = (list) => { const out = [""]; let depth = 0; for (const c of list) { if (c === "," && !depth) out.push(""); else { depth += c === "(" ? 1 : c === ")" ? -1 : 0; out[out.length - 1] += c; } } return out.map((x) => x.trim().replace(/\s+/g, " ")); };
  const rules = [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((m) => [split(m[1]), m[2]]);
  const bodyOf = (sel) => rules.filter(([sels]) => sels.includes(sel)).map(([, b]) => b).join(";");
  const has = (sel, re, what) => assert.ok(re.test(bodyOf(sel)), `styles.css: ${sel} has no ${what}`);
  // kerning: the font has kern pairs (GPOS), and the page asks for them, with optical sizing where a font has it
  assert.ok(features(font.GPOS).has("kern"), "the font has no kern feature");
  has("*", /font-kerning:\s*normal !important/, "font-kerning: normal, kept past every font shorthand"); has("body", /font-optical-sizing:\s*auto/, "font-optical-sizing: auto");
  // optical centre: a button's label is trimmed to its capitals and baseline (the browser check measures the icon)
  for (const sel of [".btn", ".m-close", ".menu-btn", ".copy-btn", ".tabs button"]) has(sel, /text-box:\s*trim-both cap alphabetic/, "text-box: trim-both cap alphabetic");
  // tabular numbers: the font has them, and the figures that stand in columns or change in place use them (the browser
  // check reads them computed, past any font shorthand)
  assert.ok(features(font.GSUB).has("tnum"), "the font has no tnum feature");
  // no layout shift when the font arrives: two faces of Arial and its metric twins, scaled to the font, second in --sans,
  // each override the font's own metric divided by its size-adjust
  const fb = rules.filter(([sels, b]) => sels[0] === "@font-face" && /font-family:\s*"Plus Jakarta Sans Fallback"/.test(b)).map(([, b]) => b);
  assert.equal(fb.length, 2, "styles.css: no regular and bold \"Plus Jakarta Sans Fallback\" faces");
  for (const b of fb) {
    const got = Object.fromEntries([...b.matchAll(/([a-z-]+):\s*([\d.]+)%/g)].map((m) => [m[1], parseFloat(m[2]) / 100]));
    const pct = (k) => { assert.ok(Number.isFinite(got[k]), `styles.css: a fallback face has no ${k}`); return got[k]; };
    const size = pct("size-adjust");
    assert.ok(/src:\s*local\("Arial[^"]*"\)/.test(b) && /local\("Liberation Sans[^"]*"\)/.test(b) && size > 0.9 && size < 1.15, `styles.css: a fallback face is not Arial's family at a measured size (${b.trim()})`);
    assert.ok(Math.abs(pct("ascent-override") * size - ascent) < 0.001 && Math.abs(pct("descent-override") * size - descent) < 0.001 && Math.abs(pct("line-gap-override") * size - gap) < 0.001,
      `styles.css: a fallback face's overrides are not the font's ascent ${ascent}, descent ${descent} and line gap ${gap} over its size-adjust`);
  }
  assert.equal(TOKENS["--sans"].split(",")[1].trim(), '"Plus Jakarta Sans Fallback"', "styles.css: --sans does not fall back to the metric-matched face first");
  // x-height: the system's mono font scaled to the font's own x-height, kept after every font shorthand that would reset it
  for (const sel of ["code", ".in-sample .val", ".anchor code"]) assert.equal(parseFloat((/font-size-adjust:\s*([\d.]+)/.exec(bodyOf(sel)) || [])[1]), xHeight, `styles.css: ${sel} is not scaled to the font's x-height ${xHeight}`);
  assert.ok(!/var\(--fs--2\)/.test(bodyOf(".steps .line")), "styles.css: the PowerShell line is still at the smallest step");
  // widows and the measure
  has("p", /text-wrap:\s*pretty/, "text-wrap: pretty"); has("li", /text-wrap:\s*pretty/, "text-wrap: pretty"); has("dd", /text-wrap:\s*pretty/, "text-wrap: pretty"); has(".faq summary", /text-wrap:\s*pretty/, "text-wrap: pretty");
  has("h3", /text-wrap:\s*balance/, "text-wrap: balance"); has(".checks-table tbody th", /text-wrap:\s*balance/, "text-wrap: balance");
  has(".prose h2", /line-height:\s*1\.05/, "line-height: 1.05");
  // OKLCH: the brand colours stay exact hex (the difference fills' arithmetic needs them), the tints are mixed in OKLCH
  // where the browser can, with the same mixes in hex where it cannot
  const plain = Object.fromEntries([...(/:root\s*\{([^}]*)\}/.exec(css) || ["", ""])[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  for (const [k, v] of [["--paper", "#F7F5F0"], ["--paper-2", "#EFECE4"], ["--ink", "#0C1938"], ["--wine", "#6B1E2E"], ["--gold", "#997D3A"], ["--gold-hi", "#C9A85A"]]) assert.equal(plain[k], v, `styles.css: ${k}`);
  assert.ok(css.includes("background: #E3D3AC; mix-blend-mode: difference") && css.includes("background: #EBDCB8; mix-blend-mode: difference"), "styles.css: the difference fills are not the exact hex");
  const mixed = /@supports \(color: color-mix\(in oklch, red, blue\)\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
  assert.ok(mixed, "styles.css: no @supports block that mixes the tints in OKLCH");
  const mixes = Object.fromEntries([...mixed[1].matchAll(/(--[a-z-]+):\s*(color-mix\(in oklch,[^;]*);/g)].map((m) => [m[1], m[2]]));
  for (const k of ["--tint-hover", "--tint-flag-hover", "--tint-bar", "--shade-from", "--shade-to"]) {
    assert.ok(/^(#[0-9A-F]{6}|rgba\([^)]*\))$/.test(plain[k] || ""), `styles.css: ${k} has no plain colour for a browser without color-mix (${plain[k]})`);
    assert.ok(mixes[k], `styles.css: ${k} is not mixed in OKLCH`);
    assert.ok(css.includes(`var(${k})`), `styles.css: ${k} is never used`);
  }
  assert.ok(!/#D9D3C4|rgba\(12, 25, 56, \.08\), rgba\(12, 25, 56, \.45\)\)/.test(css.replace(/--shade-from:[^;]*;\s*--shade-to:[^;]*;/, "")), "styles.css: a derived tint is still written by hand where it is used");
  // the safe area on every edge a phone's notch or home bar can cover
  has(".notice-bar p", /padding:[^;]*max\(var\(--margin\), env\(safe-area-inset-right, 0px\)\)[^;]*max\(var\(--margin\), env\(safe-area-inset-left, 0px\)\)/, "padding inside the safe area");
  has(".skip-link", /left:\s*max\(var\(--margin\), env\(safe-area-inset-left, 0px\)\)/, "left inside the safe area");
  has(".foot", /padding-block:[^;]*env\(safe-area-inset-bottom, 0px\)/, "padding above the home bar");
  // affordance: a link says it is one on hover and on keyboard focus; the filters say what they do
  has(".toc a:is(:hover, :focus-visible)", /text-decoration:\s*underline/, "underline");
  has("a:is(:hover, :focus-visible)", /text-decoration-thickness:\s*2px/, "thicker underline");
  has(".links a:is(:hover, :focus-visible)", /border-bottom-color:\s*var\(--ink\)/, "bar");
  const home = html["index.html"];
  assert.ok(home.includes('<span class="label">Show findings by type</span>'), "the filters' label does not say they filter");
  // plain words in the site's own copy (the engine's and the pane's words stay theirs, held by test_site_sample.py): a
  // detail box names its checks as the filters do
  const said = [...home.matchAll(/<dt>Checks?<\/dt><dd>([^<]*)<\/dd>/g)].map((m) => m[1]);
  assert.deepEqual(said, ["Totals that don't add up, typing slips", "Totals that don't add up, typing slips, odd jumps over time", "Same word, typed two ways", ...Array(4).fill("Odd jumps over time")], "the detail boxes' checks are not the filters' plain names");
}
// ---- AH-148 fix round 1, a blind design review: the sample's caption read like a note to a developer, a "≠" asked a
// reader to know the sign, "John's relay" named neither John nor a relay to a stranger, and the questions looked like
// a data table (a "Question / Answer" bar, an "Open" box on each row, an empty answer column) ----
{
  const home = html["index.html"], words = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const cap = words((/<figcaption class="ws-foot" id="ws-cap">([\s\S]*?)<\/figcaption>/.exec(home) || ["", ""])[1]);
  assert.ok(cap.split(/[.:;] /).length <= 3 && cap.split(". ").length <= 2 && !/test|source/.test(cap), `the sample's caption is not two short plain sentences: "${cap}"`);
  for (const fact of ["engine's own", "level 5 of 10", "recommended", "Click a flagged row", "the row's own numbers", "the column's usual spelling"]) assert.ok(cap.includes(fact), `the sample's caption no longer says "${fact}"`);
  for (const p of PAGES) assert.ok(!html[p].includes("≠"), `${p}: a "≠" a reader must know the sign to read`);
  assert.ok(!/John's relay/.test(home) && (home.match(/John's server on Cloudflare/g) || []).length === 3 && /John Nguyen, who makes and runs Arcas/.test(home), "the home page says \"John's relay\" where a stranger reads it");
  for (const p of ["index.html", "support.html"]) assert.ok(!/faq-head/.test(html[p]), `${p}: the questions still have a "Question / Answer" bar`);
  assert.ok(!/faq-head/.test(css), "styles.css: the questions' header bar is still styled");
  const after = [...css.matchAll(/([^{}]*\.faq[^{}]*summary::after[^{}]*)\{([^}]*)\}/g)];
  assert.ok(after.length && after.every((m) => !/content:\s*"[^"]/.test(m[2])), "styles.css: a question's marker is a word (Open, Close), not a chevron");
}
console.log(`website static check passed (${PAGES.length} pages, ${SCRIPTS.length} scripts)`);
if (!process.argv.includes("--browser")) process.exit(0);

// ---- in a browser: the pages served as they are on the web, each at a desktop and a phone width ----
const req = createRequire(import.meta.url);
const pw = await import(process.env.PLAYWRIGHT || "playwright").catch(() => import(pathToFileURL(req.resolve("playwright", { paths: [process.env.NODE_PATH || ""] })).href));
const { chromium } = pw.default || pw;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };
// GitHub Pages serves the site under /excel-anomaly-hunter/ and answers any missing path there with 404.html and a 404
// status (AH-126); this server does both, and keeps serving the pages at its root as the checks above always had them
const server = http.createServer((q, s) => {
  const f = path.join(SITE, decodeURIComponent(new URL(q.url, "http://x").pathname).replace(/^\/excel-anomaly-hunter(?=\/)/, "").replace(/\/$/, "/index.html"));
  if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    const missing = path.join(SITE, "404.html");
    if (!fs.existsSync(missing)) { s.writeHead(404); return s.end(); }
    s.writeHead(404, { "Content-Type": "text/html" }); return s.end(fs.readFileSync(missing));
  }
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
async function open(file, { width = 1280, height = 900, api = json(release), motion = "no-preference", until = "networkidle", init = null, gpu = false, js = true, setup = null, colors = "none", url = null, touch = false } = {}) {
  // touch: a phone a finger drives (a coarse pointer that cannot hover), for AH-138's wheel that must leave it alone
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, javaScriptEnabled: js, forcedColors: colors, hasTouch: touch, isMobile: touch });
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
  await page.goto(url || BASE + file, { waitUntil: until });
  return { ctx, page, problems, outside };
}
const done = async ({ ctx, problems, outside }, label, allowed = []) => {
  assert.deepEqual(problems, [], `${label}: console errors`);
  assert.deepEqual(outside.filter((u) => !allowed.includes(u)), [], `${label}: requests outside the site`);
  await ctx.close();
};

// ---- John's website lists (AH-126, 2026-11-04): the 404 page, the phone's menu, the home page's download bar, the hero's
// download above the fold, the support form's thank-you, the visit counter that sends nothing until John sets it up, and
// no cookie anywhere. Each check collects what it finds and the group fails once with all of it ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const { contrastProblems } = await import(pathToFileURL(path.join(SITE, "..", "e2e", "contrast.mjs")).href);
  // the 404 page: Pages serves it, with a 404 status, for any missing path under the site's own; every link on it is
  // root-absolute, so it works at any depth (/excel-anomaly-hunter/a/b/c too), and it reads at 320 px with text at 200%
  for (const at of ["excel-anomaly-hunter/no-such-page", "excel-anomaly-hunter/a/b/c.html"]) for (const [width, size] of [[320, "200%"], [1280, "100%"]]) {
    let status = 0;
    const t = await open("", { width, height: 800, motion: "reduce", url: BASE + at, setup: (p) => p.on("response", (r) => { if (r.url() === BASE + at) status = r.status(); }) });
    const p = t.page;
    t.problems.splice(0, t.problems.length, ...t.problems.filter((x) => x !== `404 ${BASE + at}`));
    await p.evaluate((size) => { document.documentElement.style.fontSize = size; }, size);
    const r = await p.evaluate(() => ({ title: document.title, h1: (document.querySelector("h1") || {}).textContent || "", robots: (document.querySelector('meta[name="robots"]') || {}).content || "",
      hrefs: [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")), scripts: document.scripts.length, font: getComputedStyle(document.body).fontFamily }));
    want(status === 404, `AH-126 404 at /${at}: answered ${status}, not 404`);
    want(/^Arcas\b/.test(r.title) && r.h1.length > 5 && r.robots === "noindex" && r.scripts === 0, `AH-126 404 at /${at}: ${JSON.stringify(r)}`);
    want(/Plus Jakarta Sans/.test(r.font), `AH-126 404 at /${at}: the site's styles did not load (${r.font})`);
    for (const href of ["/excel-anomaly-hunter/", "/excel-anomaly-hunter/index.html#download", "/excel-anomaly-hunter/support.html", "/excel-anomaly-hunter/privacy.html"])
      want(r.hrefs.includes(href), `AH-126 404 at /${at}: no link to ${href}`);
    for (const href of r.hrefs.filter((h) => h.startsWith("/"))) {
      const got = await p.request.get(BASE + href.slice(1).split("#")[0]);
      want(got.status() === 200, `AH-126 404 at /${at}: ${href} answers ${got.status()}`);
    }
    const over = await overflow(p);
    want(over <= 0, `AH-126 404 at /${at}, ${width}px text ${size}: scrolls ${over} px sideways`);
    const bad = await p.evaluate(contrastProblems);
    want(!bad.length, `AH-126 404 at /${at}, ${width}px: contrast ${JSON.stringify(bad)}`);
    await done(t, `404 page at /${at}, ${width}px`);
  }
  // the phone's menu (375 x 667): the links wait behind a Menu button, which opens them, closes on Escape (focus back on
  // it) and on a link; open, nothing scrolls sideways and the links are next on the keyboard. Wider, the links show and
  // the button does not; with no JavaScript the links show
  for (const file of PAGES) {
    const t = await open(file, { width: 375, height: 667, motion: "reduce" });
    const p = t.page;
    const menu = () => p.evaluate(() => { const b = document.querySelector(".menu-btn"), n = document.getElementById("main-nav"), r = b && b.getBoundingClientRect();
      return { btn: !!b && b.getClientRects().length > 0, size: r ? [Math.round(r.width), Math.round(r.height)] : [], expanded: b ? b.getAttribute("aria-expanded") : null,
        links: !!n && n.getClientRects().length > 0 && n.getBoundingClientRect().height > 0, focus: document.activeElement === b ? "button" : document.activeElement.closest && document.activeElement.closest("#main-nav") ? "nav" : document.activeElement.tagName,
        anims: document.getAnimations().length }; });
    const m0 = await menu();
    want(m0.btn && m0.expanded === "false" && !m0.links && m0.size[0] >= 24 && m0.size[1] >= 24, `AH-126 menu on ${file} at 375px, at load: ${JSON.stringify(m0)}`);
    if (!m0.btn) { await done(t, `menu on ${file}`, [API]); continue; }
    await p.click(".menu-btn");
    const m1 = await menu();
    want(m1.expanded === "true" && m1.links && m1.anims === 0, `AH-126 menu on ${file} at 375px, opened: ${JSON.stringify(m1)}`);
    want((await overflow(p)) <= 0, `AH-126 menu on ${file} at 375px: scrolls sideways when open`);
    const bad = await p.evaluate(contrastProblems);
    want(!bad.length, `AH-126 menu on ${file} at 375px, open: contrast ${JSON.stringify(bad)}`);
    await p.focus(".menu-btn"); await p.keyboard.press("Tab");
    want((await menu()).focus === "nav", `AH-126 menu on ${file}: Tab from the open menu's button does not reach its links`);
    await p.keyboard.press("Escape");
    const m2 = await menu();
    want(m2.expanded === "false" && !m2.links && m2.focus === "button", `AH-126 menu on ${file}: Escape ${JSON.stringify(m2)}`);
    await p.keyboard.press("Enter");
    want((await menu()).expanded === "true", `AH-126 menu on ${file}: Enter on the button does not open it`);
    await p.click('#main-nav a[href$="#checks"]');
    await p.waitForTimeout(300);
    want((await menu()).expanded === "false", `AH-126 menu on ${file}: a link click leaves it open`);
    await done(t, `menu on ${file} at 375px`, [API]);
  }
  for (const [width, js] of [[1280, true], [375, false]]) {
    const t = await open("index.html", { width, motion: "reduce", js, until: "load" });
    const m = await t.page.evaluate(() => ({ btn: document.querySelector(".menu-btn") ? document.querySelector(".menu-btn").getClientRects().length > 0 : null, links: document.getElementById("main-nav") ? document.getElementById("main-nav").getClientRects().length > 0 : false }));
    want(m.btn === false && m.links, `AH-126 menu at ${width}px${js ? "" : " with no JavaScript"}: ${JSON.stringify(m)}`);
    await done(t, `menu at ${width}px js ${js}`, js ? [API] : []);
  }
  // the hero's download is in the first screen, on a small phone and a small laptop
  for (const [width, height] of [[375, 667], [1280, 720]]) {
    const t = await open("index.html", { width, height, motion: "reduce" });
    const r = await t.page.evaluate(() => { const a = document.querySelector(".hero-cta .btn-primary"); if (!a) return null; const b = a.getBoundingClientRect();
      return { href: a.getAttribute("href"), text: a.textContent.trim(), top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: innerWidth, h: innerHeight }; });
    want(r && r.href === "#download" && r.top >= 0 && r.left >= 0 && r.bottom <= r.h && r.right <= r.w, `AH-126 the hero's download at ${width} x ${height} is not fully in the first screen: ${JSON.stringify(r)}`);
    await done(t, `hero download at ${width} x ${height}`, [API]);
  }
  // the home page's download bar on a phone: hidden at load, shown once the hero's download has scrolled away, hidden
  // again while the download section shows; it moves nothing (CLS 0), the footer clears it, and it never shows wider
  for (const [width, motion] of [[375, "reduce"], [375, "no-preference"], [1280, "no-preference"]]) {
    const t = await open("index.html", { width, height: 667, motion, init: () => {
      window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); } });
    const p = t.page;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    const dock = () => p.evaluate(() => { const d = document.getElementById("dock"); if (!d) return null; const r = d.getBoundingClientRect();
      return { hidden: d.hidden, shown: d.getClientRects().length > 0, bottom: Math.round(r.bottom), top: Math.round(r.top), h: innerHeight, height: Math.round(r.height) }; });
    const d0 = await dock();
    want(d0 && d0.hidden && !d0.shown, `AH-126 download bar at ${width}px (${motion}), at load: ${JSON.stringify(d0)}`);
    await p.evaluate(() => { const a = document.querySelector(".hero-cta .btn-primary") || document.querySelector(".hero-copy"); let top = 0; for (let e = a; e; e = e.offsetParent) top += e.offsetTop; scrollTo(0, top + a.offsetHeight + 200); });
    await p.waitForTimeout(600);
    const d1 = await dock();
    if (width > 760) want(d1 && d1.hidden, `AH-126 download bar at ${width}px: shown on a wide screen ${JSON.stringify(d1)}`);
    else {
      want(d1 && !d1.hidden && d1.shown && d1.bottom === d1.h && d1.top < d1.h, `AH-126 download bar at ${width}px (${motion}), past the hero: ${JSON.stringify(d1)}`);
      if (motion === "reduce") {
        const bad = await p.evaluate(contrastProblems);
        want(!bad.length, `AH-126 download bar: contrast ${JSON.stringify(bad)}`);
        want(await p.evaluate(() => !!document.querySelector('#dock a[href="#download"]')), "AH-126 download bar: its link does not go to the download");
      }
      await p.evaluate(() => document.getElementById("download").scrollIntoView({ block: "center" }));
      await p.waitForTimeout(600);
      const d2 = await dock();
      want(d2 && d2.hidden, `AH-126 download bar at ${width}px (${motion}), over the download section: ${JSON.stringify(d2)}`);
      await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(600);
      const end = await p.evaluate(() => { const d = document.getElementById("dock") || { hidden: true }, f = document.querySelector(".foot");
        return { pad: parseFloat(getComputedStyle(f).paddingBottom), dock: d.hidden ? 0 : d.getBoundingClientRect().height, text: f.querySelector("nav").getBoundingClientRect().bottom, top: d.hidden ? innerHeight : d.getBoundingClientRect().top }; });
      want(end.text <= end.top, `AH-126 download bar at ${width}px (${motion}): it covers the footer at the end of the page ${JSON.stringify(end)}`);
    }
    const cls = await p.evaluate(() => window.__cls);
    want(cls === 0, `AH-126 download bar at ${width}px (${motion}): layout shift ${cls}`);
    await done(t, `download bar at ${width}px ${motion}`, [API]);
  }
  // the support page: John's name and phone beside the form; after the link to GitHub is followed, a thank-you that says
  // what happens next, announced (role="status"); the ready text describes the link
  {
    const t = await open("support.html", { width: 390, height: 844, motion: "reduce" });
    const p = t.page;
    const tel = await p.evaluate(() => [...document.querySelectorAll('a[href^="tel:"]')].map((a) => [a.getAttribute("href"), a.textContent, a.getClientRects().length > 0]));
    // AH-135: twice, the line above the form and the contact block under it, both John's number and both shown
    want(JSON.stringify(tel) === JSON.stringify([["tel:+17702659930", "(770) 265-9930", true], ["tel:+17702659930", "(770) 265-9930", true]]), `AH-126 support: the phone links ${JSON.stringify(tel)}`);
    want(await p.evaluate(() => /John Nguyen/.test(document.getElementById("page").textContent)), "AH-126 support: John Nguyen is not named");
    await p.fill("#summary", "x"); await p.fill("#details", "y"); await p.check("#clean");
    await p.click('button[type="submit"]');
    const thanks = () => p.evaluate(() => { const s = document.getElementById("thanks"), a = document.getElementById("open");
      return { exists: !!s, hidden: s ? s.hidden : null, shown: s ? s.getClientRects().length > 0 : false, role: s && s.getAttribute("role"), text: s ? s.textContent : "",
        described: ((a && a.getAttribute("aria-describedby")) || "").split(" ").map((id) => (document.getElementById(id) || {}).textContent || "?" + id).join(" | ") }; });
    const a = await thanks();
    want(a.exists && a.hidden && !a.shown && a.role === "status" && /^Ready\./.test(a.described), `AH-126 support: before the link is followed ${JSON.stringify(a)}`);
    await p.evaluate(() => document.getElementById("open").addEventListener("click", (e) => e.preventDefault())); // no tab to GitHub here
    await p.click("#open");
    const b = await thanks();
    want(!b.hidden && b.shown && /^Thanks\./.test(b.text) && /GitHub/.test(b.text), `AH-126 support: after the link is followed ${JSON.stringify(b)}`);
    const bad = await p.evaluate(contrastProblems);
    want(!bad.length, `AH-126 support thank-you: contrast ${JSON.stringify(bad)}`);
    await p.click('button[type="submit"]');
    want((await thanks()).hidden, "AH-126 support: the thank-you stays after the question is prepared again");
    await done(t, "support contact and thank-you");
  }
  // the visit counter (count.js): with no code set, nothing leaves for GoatCounter. With a code (put in here, never in the
  // file), on the real address, one image request per page view to that code's host, its only field the page's path, no
  // referrer; none on 127.0.0.1, with Do Not Track or with Global Privacy Control
  {
    const gif = Buffer.from("R0lGODlhAQABAAAAACw=", "base64");
    const visit = async ({ code, url = null, init = null, file = "index.html" }) => {
      const hits = [];
      const t = await open(file, { motion: "reduce", init, url, setup: async (p) => {
        await p.route(/^https:\/\/ricepillow3000\.github\.io\/excel-anomaly-hunter\//, (r) => { const f = path.join(SITE, new URL(r.request().url()).pathname.replace(/^\/excel-anomaly-hunter/, "").replace(/\/$/, "/index.html"));
          return fs.existsSync(f) ? r.fulfill({ status: 200, contentType: TYPES[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: "" }); });
        // the code is set here, never in the file: the same checks hold before and after John puts his own code there
        await p.route(/\/count\.js$/, (r) => { const src = read("count.js"), set = src.replace(/const COUNTER = "[a-z0-9-]*";/, `const COUNTER = "${code}";`);
          if (!set.includes(`const COUNTER = "${code}";`)) miss.push("AH-126 counter: count.js has no COUNTER constant to set"); return r.fulfill({ status: 200, contentType: "text/javascript", body: set }); });
        await p.route(/goatcounter\.com/, (r) => { hits.push({ url: r.request().url(), type: r.request().resourceType(), referer: r.request().headers().referer || "" }); return r.fulfill({ status: 200, contentType: "image/gif", body: gif }); });
      } });
      await t.page.waitForTimeout(500);
      const cookie = await t.page.evaluate(() => document.cookie);
      await t.ctx.close();
      return { hits, problems: t.problems, cookie };
    };
    const SITE_INDEX = SITE_URL;
    const none = await visit({ code: "", url: SITE_INDEX });
    want(none.hits.length === 0 && !none.problems.length, `AH-126 counter with no code: ${JSON.stringify(none)}`);
    const one = await visit({ code: "arcas-test", url: SITE_INDEX });
    const u = one.hits[0] ? new URL(one.hits[0].url) : null;
    want(one.hits.length === 1 && u && u.origin === "https://arcas-test.goatcounter.com" && u.pathname === "/count" && [...u.searchParams.keys()].join() === "p" && u.searchParams.get("p") === "/excel-anomaly-hunter/"
      && one.hits[0].type === "image" && one.hits[0].referer === "" && !one.problems.length, `AH-126 counter with a code: ${JSON.stringify(one)}`);
    const terms = await visit({ code: "arcas-test", url: SITE_URL + "terms.html" });
    want(terms.hits.length === 1 && new URL(terms.hits[0].url).searchParams.get("p") === "/excel-anomaly-hunter/terms.html", `AH-126 counter on terms.html: ${JSON.stringify(terms)}`);
    for (const [label, opts] of [["on 127.0.0.1", {}], ["with Do Not Track", { url: SITE_INDEX, init: () => Object.defineProperty(Navigator.prototype, "doNotTrack", { get: () => "1" }) }],
      ["with Global Privacy Control", { url: SITE_INDEX, init: () => Object.defineProperty(Navigator.prototype, "globalPrivacyControl", { get: () => true }) }]]) {
      const r = await visit({ code: "arcas-test", ...opts });
      want(r.hits.length === 0, `AH-126 counter ${label}: ${JSON.stringify(r.hits)}`);
    }
  }
  // no cookie banner is needed because no page sets a cookie: none in the document, no Set-Cookie on any answer
  for (const file of [...PAGES, "excel-anomaly-hunter/no-such-page"]) {
    const set = [];
    const t = await open(file, { motion: "reduce", setup: (p) => p.on("response", async (r) => { const h = await r.allHeaders().catch(() => ({})); if (h["set-cookie"]) set.push(r.url()); }) });
    t.problems.splice(0, t.problems.length, ...t.problems.filter((x) => !x.startsWith("404 " + BASE + "excel-anomaly-hunter/")));
    const cookie = await t.page.evaluate(() => document.cookie);
    want(cookie === "" && !set.length, `AH-126 ${file}: a cookie (${JSON.stringify(cookie)}, Set-Cookie on ${set})`);
    await done(t, `no cookie on ${file}`, [API]);
  }
  assert.deepEqual(miss, [], `John's website lists (AH-126):\n${miss.join("\n")}`);
  console.log("AH-126: the 404 page at any depth (404 status, 320 px at 200%, contrast), the phone's menu on every page, the hero's download in the first screen at 375 x 667 and 1280 x 720, the home page's download bar (CLS 0), the support page's phone and thank-you, the counter silent without a code and one bare pixel with one, no cookie on any page");
}
// ---- John's website list of 2026-11-05 (AH-133): the contact form opens a prefilled GitHub issue in a new tab, cut off
// from this one, then shows our own thank-you page without reloading; a blocked tab or a long message gets the link to
// press instead; the photo loads only near the screen, at the size the screen needs, in a box kept from the start; the
// structured data parses in the browser with no CSP report and says what the questions say ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const { contrastProblems } = await import(pathToFileURL(path.join(SITE, "..", "e2e", "contrast.mjs")).href);
  const stub = (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>GitHub stand-in</title><p>new issue</p>" });
  const contact = async ({ width, motion, blocked = false, message = "It stops at row 3000.\nWhat now? & = + % # ?" }) => {
    const t = await open("index.html", { width, height: 844, motion, init: blocked ? () => { window.open = () => null; } : null,
      setup: (p) => p.context().route(/^https:\/\/github\.com\//, stub) });
    const p = t.page, label = `AH-133 contact at ${width}px (${motion}${blocked ? ", tab blocked" : ""})`;
    const popups = [];
    t.ctx.on("page", (q) => popups.push(q));
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    // "Contact John" in the hero glides to the form (reduced motion: the anchor jumps, landing a fraction of a pixel up)
    await p.click('.hero-cta a[href="#contact"]');
    await p.waitForFunction(() => { const r = document.getElementById("contact").getBoundingClientRect(); return r.top > -1 && r.top < innerHeight / 2 && !(window.AH && window.AH.gliding()); }, null, { timeout: 5000 })
      .catch(() => want(false, `${label}: Contact John did not bring the form to the screen`));
    await p.evaluate(() => { window.__kept = "same document"; });
    // an empty send: focus on the first missing field, each missing field marked and described, the message beside it
    await p.click('#note button[type="submit"]');
    const look = () => p.evaluate(() => { const m = document.getElementById("c-missing"), r = m.getBoundingClientRect();
      return { focus: document.activeElement.id, text: m.hidden ? "" : m.textContent, shown: !m.hidden && r.top >= 0 && r.bottom <= innerHeight,
        invalid: ["c-name", "c-message"].filter((id) => document.getElementById(id).getAttribute("aria-invalid") === "true").join(),
        described: ["c-name", "c-message"].filter((id) => document.getElementById(id).getAttribute("aria-describedby") === "c-missing").join() }; });
    const e = await look();
    want(JSON.stringify(e) === JSON.stringify({ focus: "c-name", text: "Please add a name, a message.", shown: true, invalid: "c-name,c-message", described: "c-name,c-message" }), `${label}: an empty send ${JSON.stringify(e)}`);
    if (motion === "reduce") { const bad = await p.evaluate(contrastProblems); want(!bad.length, `${label}: contrast with the message shown ${JSON.stringify(bad)}`); }
    // typed with the keyboard, as a person types (a DOM0 handler once swallowed every key, CLAUDE.md)
    const name = '"><img src=x onerror=alert(1)> Ana';
    await p.keyboard.type(name);
    await p.selectOption("#c-topic", "An idea");
    await p.focus("#c-message"); await p.fill("#c-message", message);
    want((await look()).invalid === "", `${label}: a filled field stays marked`);
    const popup = t.ctx.waitForEvent("page", { timeout: 3000 }).catch(() => null);
    await p.click('#note button[type="submit"]');
    let link = "";
    if (!blocked && [...message].length < 400) {
      const q = await popup;
      want(!!q, `${label}: no new tab opened`);
      if (q) { await q.waitForLoadState().catch(() => {}); link = q.url(); want(await q.evaluate(() => window.opener === null).catch(() => false), `${label}: the GitHub tab can reach back to the site (window.opener)`); }
    } else {
      await p.waitForTimeout(400);
      const r = await p.evaluate(() => ({ result: !document.getElementById("c-result").hidden, cut: !document.getElementById("c-cut").hidden, focus: document.activeElement.id, href: document.getElementById("c-open").href,
        target: document.getElementById("c-open").target, rel: document.getElementById("c-open").rel, at: location.pathname }));
      want(r.result && r.focus === "c-open" && r.target === "_blank" && r.rel === "noopener" && r.at === "/index.html" && popups.length === 0 && r.cut === !blocked, `${label}: the link to press ${JSON.stringify({ ...r, popups: popups.length })}`);
      link = r.href;
      if (!blocked) want(encodeURIComponent(link).length <= 7000, `${label}: a ${link.length}-character link`);
      await p.click("#c-open");
    }
    if (link) {
      const u = new URL(link);
      want(u.origin + u.pathname === REPO + "/issues/new" && [...u.searchParams.keys()].join() === "template,title,name,topic,message" && u.searchParams.get("template") === "contact.yml"
        && u.searchParams.get("title") === `[Contact]: An idea from ${name}` && u.searchParams.get("name") === name && u.searchParams.get("topic") === "An idea"
        && (message.startsWith(u.searchParams.get("message")) && (blocked || [...message].length < 400 ? u.searchParams.get("message") === message : u.searchParams.get("message").length < message.length)),
        `${label}: the GitHub link ${link.slice(0, 300)}`);
    }
    // then our own thank-you page, brought in the way a link brings a page: the same document, never a reload
    await p.waitForURL((u) => u.pathname === "/thanks.html", { timeout: 4000 }).catch(() => want(false, `${label}: no thank-you page after sending`));
    await p.waitForFunction(() => document.querySelectorAll("main").length === 1, null, { timeout: 3000 }).catch(() => {});
    const th = await p.evaluate(() => ({ kept: window.__kept, page: document.getElementById("page").dataset.page, h1: document.querySelector("h1").textContent, robots: (document.querySelector('meta[name="robots"]') || {}).content || "",
      canonical: document.querySelector('link[rel="canonical"]').href, xss: document.querySelectorAll("img[src=x]").length }));
    want(th.kept === "same document" && th.page === "thanks" && th.h1 === "One more step to send your message" && th.canonical === SITE_URL + "thanks.html" && th.xss === 0, `${label}: the thank-you page ${JSON.stringify(th)}`);
    await done(t, label, [API]);
  };
  await contact({ width: 390, motion: "reduce" });
  await contact({ width: 1280, motion: "no-preference" });
  await contact({ width: 1280, motion: "reduce", blocked: true });
  await contact({ width: 390, motion: "reduce", message: "😀🧾".repeat(500) }); // 2,000 characters of emoji: cut to fit
  // the photo: not fetched at the top of the page; near the screen, the 240 px file on a 1x screen and the 480 px one on
  // a 2x screen, in the 240 x 300 box it had before it came (no layout shift)
  for (const dpr of [1, 2]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: dpr, reducedMotion: "reduce" });
    const p = await ctx.newPage();
    await p.route("https://api.github.com/**", json(release)); await p.route(/^https:\/\/(?!api\.github\.com)/, (r) => r.abort());
    await p.addInitScript(() => { window.__cls = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true }); });
    await p.goto(BASE + "index.html", { waitUntil: "networkidle" });
    const got = () => p.evaluate(() => performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /john-\d+\.webp/.test(n)).map((n) => n.split("/").pop()));
    want((await got()).length === 0, `AH-133 photo at ${dpr}x: fetched at the top of the page ${await got()}`);
    const box0 = await p.$eval("#maker img", (i) => [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)]);
    await p.$eval("#maker", (m) => m.scrollIntoView({ block: "center" }));
    await p.waitForFunction(() => { const i = document.querySelector("#maker img"); return i.complete && i.naturalWidth > 0; }, null, { timeout: 5000 }).catch(() => {});
    const r = await p.$eval("#maker img", (i) => ({ w: i.naturalWidth, // density-corrected: 480 px at 2x reads as 240
      box: [Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)] }));
    const cls = await p.evaluate(() => window.__cls);
    want(JSON.stringify(await got()) === JSON.stringify([dpr === 1 ? "john-240.webp" : "john-480.webp"]) && r.w === 240 && JSON.stringify(box0) === "[240,300]" && JSON.stringify(r.box) === "[240,300]" && cls === 0,
      `AH-133 photo at ${dpr}x: ${JSON.stringify({ files: await got(), ...r, before: box0, cls })}`);
    await ctx.close();
  }
  // structured data: the browser parses each block, runs none of them (no CSP report), and the FAQ block's words are the
  // ones the page shows, each answer opening from the keyboard; the profile links are links a finger can hit
  {
    const t = await open("index.html", { width: 390, motion: "reduce", init: () => { window.__csp = []; document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI)); } });
    const p = t.page;
    const r = await p.evaluate(() => {
      const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent));
      const shown = [...document.querySelectorAll("#faq details")].map((d) => [d.querySelector("summary").textContent.trim(), d.querySelector(".a").textContent.replace(/\s+/g, " ").trim()]);
      const ld = (blocks.find((b) => b["@type"] === "FAQPage") || { mainEntity: [] }).mainEntity.map((q) => [q.name, q.acceptedAnswer.text]);
      const prof = [...document.querySelectorAll(".profiles a")].map((a) => { const b = a.getBoundingClientRect(); return [a.textContent.trim(), Math.round(b.width) >= 24 && Math.round(b.height) >= 24, a.target]; });
      return { types: blocks.map((b) => b["@type"]).join(), same: JSON.stringify(shown) === JSON.stringify(ld), shown: shown.length, csp: window.__csp, prof };
    });
    want(r.types === "SoftwareApplication,Person,FAQPage" && r.same && r.shown === 5 && !r.csp.length, `AH-133 structured data: ${JSON.stringify(r)}`);
    want(JSON.stringify(r.prof) === JSON.stringify([["LinkedIn", true, ""], ["Handshake", true, ""], ["GitHub", true, ""]]), `AH-133 profile links: ${JSON.stringify(r.prof)}`);
    await p.focus("#faq details:nth-of-type(3) summary"); await p.keyboard.press("Enter");
    want(await p.$eval("#faq details:nth-of-type(3)", (d) => d.open), "AH-133 a home question does not open from the keyboard");
    const bad = await p.evaluate(contrastProblems);
    want(!bad.length, `AH-133 an open question: contrast ${JSON.stringify(bad)}`);
    await done(t, "AH-133 structured data", [API]);
  }
  assert.deepEqual(miss, [], `John's website list of 2026-11-05 (AH-133):\n${miss.join("\n")}`);
  console.log("AH-133: the contact form (glide, errors, new tab with no way back, our thank-you page in the same document, a blocked tab and a long message given the link), the photo loaded near the screen at 1x and 2x with CLS 0, the structured data parsed with no CSP report and the questions word for word, the profile links");
}
// ---- AH-135: Email John instead, on both forms. It checks the same fields first, then hands the visitor's own email app
// a message filled from the form (a mailto link, cut to fit what mail apps take, and said so), and never leaves the page
// for the thank-you page; the GitHub route is untouched ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const { contrastProblems } = await import(pathToFileURL(path.join(SITE, "..", "e2e", "contrast.mjs")).href);
  // the click is let through to the link's own handler, then stopped before the browser hands it to a mail app
  const catcher = () => { window.__mail = []; document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest('a[href^="mailto:"]');
    if (a) { window.__mail.push(e.defaultPrevented ? "stopped" : a.href); e.preventDefault(); } }); };
  for (const [file, width, fill, id, missing, subject, body, cutId] of [
    ["index.html", 390, async (p, long) => { await p.fill("#c-name", "Ana & Bo"); await p.selectOption("#c-topic", "A problem"); await p.fill("#c-message", long ? "😀🧾".repeat(1500) : "It stops at row 3000.\nWhat now? & = + % # ?"); },
      "c-email", "Please add a name, a message.", "[Contact]: A problem from Ana & Bo", "Name: Ana & Bo\r\nTopic: A problem\r\n\r\nIt stops at row 3000.\r\nWhat now? & = + % # ?", "c-mail-cut"],
    ["support.html", 1280, async (p, long) => { await p.fill("#summary", "Scan stops"); await p.fill("#version", "v0.1.102"); await p.fill("#details", long ? "😀🧾".repeat(1500) : "Line 1\nline 2 & ?"); await p.check("#clean"); },
      "email", "Please add a short summary, what happened, the box that says it contains no key or private data.", "[Support]: Scan stops", "Topic: Something isn't working\r\nEngine version: v0.1.102\r\n\r\nLine 1\r\nline 2 & ?", "mail-cut"]]) {
    const t = await open(file, { width, motion: "reduce", init: catcher });
    const p = t.page, label = `AH-135 Email John instead on ${file} at ${width}px`;
    const look = () => p.evaluate(([m, c]) => ({ mail: window.__mail.slice(), at: location.pathname, focus: document.activeElement.id, missing: document.getElementById(m).hidden ? "" : document.getElementById(m).textContent,
      cut: !document.getElementById(c).hidden, result: !document.getElementById(m === "missing" ? "result" : "c-result").hidden }), [file === "index.html" ? "c-missing" : "missing", cutId]);
    await p.click("#" + id);
    let r = await look();
    want(JSON.stringify(r.mail) === '["stopped"]' && r.missing === missing && r.focus !== id && !r.result, `${label}: an empty form ${JSON.stringify(r)}`);
    await fill(p, false);
    await p.click("#" + id);
    r = await look();
    const u = r.mail[1] ? new URL(r.mail[1]) : null;
    want(u && u.protocol === "mailto:" && u.pathname === EMAIL && u.searchParams.get("subject") === subject && u.searchParams.get("body") === body && r.at === "/" + file && !r.cut && !r.result && r.missing === "",
      `${label}: the email ${JSON.stringify(r)} subject ${u && u.searchParams.get("subject")} body ${JSON.stringify(u && u.searchParams.get("body"))}`);
    await fill(p, true);
    await p.click("#" + id);
    r = await look();
    const v = r.mail[2] ? new URL(r.mail[2]) : null;
    want(v && r.mail[2].length <= 1800 && r.cut && v.searchParams.get("body").length > 100 && !/[\uD800-\uDBFF]$/.test(v.searchParams.get("body")) && r.at === "/" + file, `${label}: a long message ${JSON.stringify({ ...r, mail: r.mail.map((m) => m.length) })}`);
    const bad = await p.evaluate(contrastProblems);
    want(!bad.length, `${label}: contrast with the cut note shown ${JSON.stringify(bad)}`);
    await p.waitForTimeout(300);
    want((await p.evaluate(() => location.pathname)) === "/" + file, `${label}: the page left for ${await p.evaluate(() => location.pathname)}`);
    await done(t, label, [API]);
  }
  assert.deepEqual(miss, [], `Email John instead (AH-135):\n${miss.join("\n")}`);
  console.log("AH-135: Email John instead on both forms (the same fields checked first, a mailto filled from the form, cut to 1,800 characters and said so, the page kept)");
}
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
    // AH-132: at 320 px the sample's tabs wrapped, "After fixes" alone on a second line and each tab 22 px tall; at 100%
    // text they share one line, each 24 px or more
    if (file === "index.html" && size === "100%") {
      const tabs = await t.page.$$eval('[role="tab"]', (b) => b.map((x) => { const r = x.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }));
      if (new Set(tabs.map(([top]) => top)).size > 1 || tabs.some(([, w, h]) => w < 24 || h < 24)) short.push(`AH-132 index.html at ${width}px: the sample's tabs are not one line of 24 px targets (top, width, height: ${JSON.stringify(tabs)})`);
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
    const states = file === "index.html" ? ["t-found", "t-busy", "t-clean", "m11", "contact"] : file === "support.html" ? ["", "submit"] : [""];
    for (const state of states) {
      if (state.startsWith("t-")) await p.click("#" + state);
      if (state === "m11") { await p.click("#t-found"); await p.click('.rowbtn[aria-controls="m11"]'); }
      if (state === "submit") await p.click('button[type="submit"]');
      if (state === "contact") { await p.click('#note button[type="submit"]'); await p.$$eval("#faq details", (ds) => ds.forEach((d) => { d.open = true; })); }
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
    // a hidden element is never drawn (AH-132): .result's display: grid outranked the hidden attribute, so support.html
    // showed "Ready. Open it on GitHub" on every load, while the .hidden property, all this file read, said it was hidden
    const drawn = await p.$$eval("[hidden]", (es) => es.filter((e) => getComputedStyle(e).display !== "none").map((e) => e.id || e.className || e.tagName));
    assert.deepEqual(drawn, [], `${file} at ${width}px: hidden, but drawn`);
    // every link in the bar, the announcement line and the footer is visible and lands on its page and anchor
    const links = await p.$$eval("header a, footer a, .notice-bar a", (as) => as.map((a) => a.getAttribute("href")));
    for (const [i, href] of links.entries()) {
      if (/^https?:/.test(href)) continue;
      await p.goto(BASE + file);
      const a = p.locator("header a, footer a, .notice-bar a").nth(i);
      // on a phone the header's links wait behind the Menu button (AH-126): opened first, as a visitor would
      if (await p.locator(".menu-btn").isVisible() && await a.evaluate((el) => !!el.closest("#main-nav"))) await p.click(".menu-btn");
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
// in exactly the site's own flat colors (the banner navy, the spear, bar and drape one gold, the emblem paper: AH-103), the logo, its
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
const GOLD = "rgb(153, 125, 58)"; // --gold #997D3A, flat: no lit face (AH-103)
const WHOLE = { parts: "spear,bar,drape,banner,emblem", banner: "rgb(12, 25, 56)", spear: GOLD, bar: GOLD, drape: GOLD, emblem: "rgb(247, 245, 240)",
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
  // ... and Home and End go to the first and the last tab, as the WAI-ARIA tabs pattern says; End no longer scrolls the
  // page to its bottom (AH-132: the list knew only the arrows)
  const y0 = await p.evaluate(() => scrollY);
  await p.keyboard.press("Home"); assert.deepEqual([(await state()).focus, (await state()).state], ["t-found", "found"], "Home in the tab list");
  await p.keyboard.press("End"); assert.deepEqual([(await state()).focus, (await state()).state, await p.evaluate(() => scrollY)], ["t-clean", "clean", y0], "End in the tab list");
  // a filter on After fixes filters the corrected sheet, with the counts it shows there: "Temporal outliers 4" jumped
  // back to the findings and lit 5 rows, row 22 among them (AH-129)
  const litIn = (id) => p.$$eval(`#${id} .grid tbody tr:not(.skip)`, (rs) => rs.filter((r) => getComputedStyle(r).opacity === "1").map((r) => r.querySelector("th").textContent).join());
  await p.click('.typology button[data-kind="time"]');
  assert.deepEqual([(await state()).state, (await state()).counts, await litIn("p-clean")], ["clean", "4 0 0 0 4", "5,21,41,57"], "a filter on After fixes");
  await p.click('.typology button[data-kind="label"]'); assert.equal(await litIn("p-clean"), "", "the label filter on After fixes");
  assert.equal(await key(), "Probably wrong: 0 | Worth a check: 4", "the key stays the corrected sheet's");
  await p.click("#t-found"); // the filter carries over to the findings
  assert.equal(await key(), "Probably wrong: 3 | Worth a check: 4", "the key back on the findings");
  const lit = () => litIn("p-found");
  assert.equal(await lit(), "31");
  await p.click('.typology button[data-kind="time"]'); assert.equal(await lit(), "5,21,22,41,57");
  await p.click('.typology button[data-kind="all"]');
  // open moves focus into the box (it is a dialog); Escape and Close give it back to the row; a click outside closes it
  await p.focus('.rowbtn[aria-controls="m11"]'); await p.keyboard.press("Enter");
  assert.deepEqual(await state(), { state: "found", counts: "7 2 2 1 5", open: "m11", focus: "m-close" });
  await p.keyboard.press("Escape"); assert.deepEqual([(await state()).open, await p.evaluate(() => document.activeElement.textContent)], ["", "11"]);
  // Tab out of the box closes it, and focus goes on where Tab took it: the box stayed open, floating over the rows,
  // with focus already past it (AH-132)
  await p.keyboard.press("Enter"); assert.equal((await state()).open, "m11");
  await p.keyboard.press("Tab");
  assert.deepEqual(await p.evaluate(() => [[...document.querySelectorAll(".matrix")].filter((m) => !m.hidden).length, !!document.activeElement.closest(".matrix"), document.activeElement !== document.body]), [0, false, true], "Tab out of a detail box");
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
// a row's detail box stays inside the sheet (AH-132): opened under its row, the boxes of rows 22, 31, 41 and 57 ran
// past the findings' bottom, over the caption and "See every check", whose clicks then did nothing (row 57's box ended
// 246 px past the findings at 1280 px). Each opens above its row where it would pass the bottom
for (const width of [1280, 390]) {
  const t = await open("index.html", { width, motion: "reduce" });
  const p = t.page, out = [];
  for (const m of ["m11", "m22", "m31", "m5", "m21", "m41", "m57"]) {
    await p.click(`.rowbtn[aria-controls="${m}"]`);
    const r = await p.evaluate((m) => { const b = document.getElementById(m).getBoundingClientRect(), s = document.getElementById("p-found").getBoundingClientRect(), n = document.querySelector(".next-up a").getBoundingClientRect();
      return { inside: b.top >= s.top - 0.5 && b.bottom <= s.bottom + 0.5 && b.left >= s.left - 0.5 && b.right <= s.right + 0.5, covers: b.bottom > n.top && b.top < n.bottom && b.right > n.left && b.left < n.right,
        box: [Math.round(b.top - s.top), Math.round(b.bottom - s.top)], sheet: Math.round(s.height) }; }, m);
    if (!r.inside || r.covers) out.push(`${m}: ${JSON.stringify(r)}`);
    await p.keyboard.press("Escape");
  }
  assert.deepEqual(out, [], `index.html at ${width}px: a detail box leaves the sheet`);
  await done(t, `detail boxes at ${width}px`, [API]);
}
console.log("sample: every row's detail box opens inside the findings and off the button under them, at 1280 and 390 px");
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
  assert.deepEqual(pending, { on: true, sha: fallback, rel: "Latest, free", bar: '""', color: "rgba(0, 0, 0, 0)" }, `API ${name}: the facts while the answer is on its way`);
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
    const c = await glideTo(p, 'a[data-glide="top"][href="#checks"]', "#checks");
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
    const c = await cell.boundingBox(); await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await p.waitForTimeout(50);
    // measured once the 250 ms lift and its shadow have ended, not after a fixed 350 ms: on a busy box the shadow read
    // 0.9938 at 350 ms (AH-136's gate). subtree takes in the ::before that carries the shadow
    await cell.evaluate((td) => Promise.all(td.getAnimations({ subtree: true }).map((a) => a.finished)));
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
{ // the headlines' drift never runs into the text under them (AH-132): near the top of the screen a headline drifted
  // 26 px down, its glyphs 4 px into the lede and onto the fact, whose gold hairline then read as its underline. At
  // 1440 x 900, every 40 px down the page, each headline's lines stay 4 px or more above the lines of its lede, its fact
  // and the download's stage
  const t = await open("index.html", { width: 1440, height: 900 });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  const worst = await p.evaluate(async () => {
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms)), frame = () => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const H = document.documentElement.scrollHeight;
    for (let y = 0; y < H; y += 400) { scrollTo(0, y); await wait(120); } // every block revealed, then at rest
    await wait(1600);
    const lines = (e) => { const r = document.createRange(); r.selectNodeContents(e); return [...r.getClientRects()].filter((x) => x.width > 0); };
    let worst = { gap: Infinity };
    for (let y = 0; y < H; y += 40) {
      scrollTo(0, y); await frame();
      for (const h of document.querySelectorAll("h2[data-depth]")) {
        const hb = h.getBoundingClientRect();
        if (hb.bottom < 0 || hb.top > innerHeight) continue;
        const own = lines(h);
        for (const s of h.parentElement.querySelectorAll(":scope > .sec-lede, :scope > .fact, :scope > .stage")) for (const b of lines(s)) for (const a of own)
          if (a.left < b.right && b.left < a.right && b.top - a.bottom < worst.gap) worst = { gap: Math.round((b.top - a.bottom) * 10) / 10, y, headline: h.id, under: s.className.split(" ")[0] };
      }
    }
    return worst;
  });
  assert.ok(worst.gap >= 4, `a headline's drift runs into the text under it: ${JSON.stringify(worst)}`);
  console.log(`headline drift at 1440 x 900: the closest a headline came to the text under it was ${worst.gap} px (${worst.headline} over its ${worst.under}, scrolled to ${worst.y})`);
  await done(t, "headline drift", [API]);
}
{ // no WebGL: no canvas, the paper's CSS texture is the background, and the console stays clean
  const t = await open("index.html", { init: () => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (k, o) { return /webgl/.test(k) ? null : get.call(this, k, o); }; } });
  assert.deepEqual(await t.page.evaluate(() => [document.documentElement.dataset.gl, !!document.getElementById("field")]), ["off", false]);
  await done(t, "no WebGL", [API]);
}

// ---- the reveal (AH-83): content waits below its place, see-through, and rises into place once, the first time it
// scrolls into view; a group's items start --stagger (90 ms) apart, a group of list rows' --stagger-row (30 ms, AH-138),
// up to --stagger-cap steps; only opacity and transform move, so the reveal runs with no layout at all ----
const tokens = (p) => p.evaluate(() => { const c = getComputedStyle(document.documentElement), g = (n) => c.getPropertyValue(n).trim();
  return { ease: g("--ease-out"), rise: parseFloat(g("--reveal-rise")), dur: parseFloat(g("--reveal-dur")), stagger: parseFloat(g("--stagger")), row: parseFloat(g("--stagger-row")), cap: parseFloat(g("--stagger-cap")) }; });
const revealed = (p, sel) => p.$$eval(sel, (es) => es.map((e) => { const c = getComputedStyle(e), m = new DOMMatrix(c.transform);
  return { op: c.opacity, tf: c.transform, x: m.e, y: m.f, will: c.willChange, delay: Math.round(parseFloat(c.transitionDelay) * 1000), ease: c.transitionTimingFunction,
    dur: Math.round(parseFloat(c.transitionDuration) * 1000), revealed: e.hasAttribute("data-revealed"), settled: e.hasAttribute("data-settled") }; }));
let reveal = null;
{
  const t = await open("index.html", { width: 1440, init: () => { window.__unobserved = []; const un = IntersectionObserver.prototype.unobserve;
    IntersectionObserver.prototype.unobserve = function (el) { window.__unobserved.push(el); return un.call(this, el); }; } });
  const p = t.page, GRID = ".checks-table tbody > .reveal-item"; // the checks table's 8 rows (AH-98; they were 8 cards)
  const tok = await tokens(p);
  // John's 2026-11-02 timings (AH-90): an unhurried cascade, 90 ms apart, each item 1.1 s; list rows 30 ms apart (AH-138)
  assert.ok(tok.ease === "cubic-bezier(.16, 1, .3, 1)" && tok.stagger === 90 && tok.row === 30 && tok.dur === 1100 && tok.rise >= 20 && tok.rise <= 30 && tok.cap >= 1, `the motion tokens: ${JSON.stringify(tok)}`);
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
  // (b) at rest, in place, with transition delays 0, 30, 60 ms ... in page order (the table's rows are list rows,
  // data-reveal-group="rows", AH-138), held at the cap after it
  const after = await revealed(p, GRID);
  const want = after.map((x, i) => Math.min(i, tok.cap) * tok.row);
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
{ // a jump lands on its target at rest (AH-132): privacy.html's contents links landed on a section still waiting 24 px
  // low and see-through, which then rose under the reader. Right after the jump the section is shown, in place, and
  // 1.3 s later it has not moved
  const t = await open("privacy.html", { width: 1280 });
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  const look = () => p.evaluate(() => { const e = document.getElementById("use"), c = getComputedStyle(e); return { top: Math.round(e.getBoundingClientRect().top), opacity: c.opacity, transform: c.transform }; });
  await p.click('.toc a[href="#use"]');
  await p.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
  const at = await look();
  await p.waitForTimeout(1300);
  const later = await look();
  assert.deepEqual(at, { ...later, opacity: "1", transform: "none" }, `privacy.html's #use right after the jump (${JSON.stringify(at)}) and 1.3 s later (${JSON.stringify(later)})`);
  assert.equal(later.top, await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)), "privacy.html's #use is not under the bar's edge");
  await done(t, "a jump on privacy.html", [API]);
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
  assert.equal(await t.page.textContent("#rel"), "Latest, free", `API ${name}`);
  await done(t, `API ${name}`, [API]);
}
{ // GitHub takes the call and never answers (AH-124): the page gives the request up on its own clock (6 s, the
  // skeleton's own limit) and shows the same defaults as when GitHub is down. It waited on the dead request for good,
  // so the next visit in the same tab reused it and never asked again
  const t = await open("index.html", { api: () => {}, until: "load" });
  const gaveUp = await t.page.waitForEvent("requestfailed", { predicate: (r) => r.url() === API, timeout: 9000 }).then(() => true, () => false);
  assert.ok(gaveUp, "API never answers: the page still waits on it after 9 s");
  assert.equal(await t.page.$eval("#sha", (c) => c.innerHTML), fallback, "API never answers");
  assert.equal(await t.page.textContent("#rel"), "Latest, free", "API never answers");
  const cleared = await t.page.waitForFunction(() => !document.querySelector("dl.anchor[data-loading]"), null, { timeout: 1000 }).then(() => true, () => false);
  assert.ok(cleared, "API never answers: the skeleton stays"); // it goes on the same 6 s clock, a moment after the request
  await done(t, "API never answers", [API]);
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
// GitHub's answer never moves the facts (AH-132): the hash took 2 to 4 lines where the link to the release page took 1
// or 2, so the facts grew 20 to 41 px when it came. The checksum's box keeps the hash's height from the start
for (const width of [1440, 761, 390, 320]) {
  const heights = [];
  for (const api of [json(release), json("", 503)]) {
    const t = await open("index.html", { width, motion: "reduce", api });
    heights.push(await t.page.$eval("#sha", (c) => Math.round(c.getBoundingClientRect().height * 10) / 10));
    await done(t, `the checksum's box at ${width}px`, [API]);
  }
  assert.equal(heights[1], heights[0], `at ${width}px the checksum's box is ${heights[1]} px tall without GitHub's answer and ${heights[0]} px with it`);
}

// the support form: nothing is sent; it builds a link to the repo's issue form with exactly what was typed
async function supportForm(p) {
  // what is drawn, never the .hidden property: the "Ready" box showed from the first load while .hidden said true (AH-132)
  const look = () => p.evaluate(() => { const shown = (id) => getComputedStyle(document.getElementById(id)).display !== "none";
    return { missing: shown("missing") ? document.getElementById("missing").textContent : "", ready: shown("result"), cut: shown("cut"), href: document.getElementById("open").href, focus: document.activeElement.id }; });
  const submit = async () => { await p.click('button[type="submit"]'); return look(); };
  assert.equal((await look()).ready, false, 'the "Ready" box shows before anything is typed');
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
  // AH-126 added the terms page, the 404 page, the phone's open menu, the home page's download bar and the support
  // form's thank-you
  const LOST = "excel-anomaly-hunter/no-such-page";
  for (const width of [1280, 390]) for (const file of [...PAGES, LOST]) {
    const t = await open(file, { width, motion: "reduce" });
    if (file === LOST) t.problems.splice(0, t.problems.length, ...t.problems.filter((x) => x !== `404 ${BASE + LOST}`));
    const phone = width <= 760 ? ["menu"] : [];
    // AH-133: the home page's contact form with its message shown, and every question open
    const states = file === "index.html" ? ["all", "recon", "keying", "label", "time", "busy", "clean", "contact", "faq", ...phone, ...(width <= 760 ? ["dock"] : [])] : file === "support.html" ? ["empty", "sent", "thanks", ...phone] : file === LOST ? ["page"] : ["page", ...phone];
    for (const state of states) {
      if (state === "contact") await t.page.click('#note button[type="submit"]');
      if (state === "faq") await t.page.$$eval("#faq details", (ds) => ds.forEach((d) => { d.open = true; }));
      if (file === "index.html" && !["menu", "dock", "contact", "faq"].includes(state)) await t.page.click(["busy", "clean"].includes(state) ? `#t-${state}` : `.typology [data-kind="${state}"]`);
      if (state === "sent") { await t.page.fill("#summary", "x"); await t.page.fill("#details", "y"); await t.page.check("#clean"); }
      if (file === "support.html" && state !== "menu") await t.page.click('button[type="submit"]');
      if (state === "thanks") { await t.page.evaluate(() => document.getElementById("open").addEventListener("click", (e) => e.preventDefault())); await t.page.click("#open"); }
      if (state === "menu") { await t.page.evaluate(() => scrollTo(0, 0)); await t.page.click(".menu-btn"); }
      if (state === "dock") { await t.page.click(".menu-btn"); await t.page.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop)); await t.page.waitForFunction(() => !document.getElementById("dock").hidden); }
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
// a link to the page you are on never reloads it (AH-132): transition.js left it to the browser, so "Privacy & security"
// on privacy.html reloaded the document (a white frame, the entrance again, the scroll and the page's state gone), and
// ten clicks 60 ms apart gave about four reloads. It takes the reader to the page's top instead. Every page whose bar
// marks it (terms.html is reached from the footer and has no mark in the bar; transition.js treats its link the same)
for (const file of PAGES.filter((f) => /<header[\s\S]*aria-current="page"[\s\S]*<\/header>/.test(read(f)))) {
  const t = await open(file);
  const p = t.page;
  await p.waitForTimeout(ENTERED);
  await p.evaluate(() => { window.__marker = 1; scrollTo(0, 600); });
  await p.waitForTimeout(300);
  await press(p, 'header a[aria-current="page"]');
  await p.waitForFunction(() => scrollY === 0, null, { timeout: 3000 }).catch(() => {});
  const once = await p.evaluate(() => ({ marker: window.__marker, mains: document.querySelectorAll("main").length, y: scrollY }));
  const b = await p.locator('header a[aria-current="page"]').boundingBox();
  for (let k = 0; k < 10; k++) { await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); await p.waitForTimeout(60); }
  await p.waitForTimeout(800);
  const ten = await p.evaluate(() => ({ marker: window.__marker, mains: document.querySelectorAll("main").length, y: scrollY, at: location.pathname }));
  assert.deepEqual([once, ten], [{ marker: 1, mains: 1, y: 0 }, { marker: 1, mains: 1, y: 0, at: "/" + file }], `${file}: its own link in the bar, once and then ten times quickly`);
  await done(t, `${file}'s own link`, [API]);
}
// ---- AH-138 (John, 2026-11-06): the motion list. The page eases after a mouse wheel (never after a finger, never under
// reduced motion), a press settles to 0.97, a button's hover fill is drawn across by a mask, the phone's menu and a row's
// detail box are popovers from their trigger, the tabs' one gold mark slides and stretches from tab to tab, the Copy
// button crossfades its icons and pulses once, and list rows stagger 30 ms while a group of blocks keeps 90. Each check
// collects what it finds and the group fails once with all of it ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const settle = (p, sel) => p.$eval(sel, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  const frames = async (p, ms) => { await p.evaluate(() => { window.__frames = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => (window.__frames++, raf(f)); });
    await p.waitForTimeout(ms); return p.evaluate(() => window.__frames); };
  const tok = (p) => p.evaluate(() => { const c = getComputedStyle(document.documentElement), n = (k) => parseFloat(c.getPropertyValue(k));
    return { popIn: n("--pop-in"), popOut: n("--pop-out"), from: n("--pop-from"), row: n("--stagger-row"), stagger: n("--stagger"), press: n("--press"), stretch: n("--stretch") }; });
  // (a) the heavy wheel: 400 px of wheel from rest, the page on its way at 50 ms, rising every frame and never past its
  // target, there within 1.5 s, then no frame asked for
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    await p.evaluate(() => scrollTo(0, 600)); await p.waitForTimeout(300);
    await p.mouse.move(16, 450);
    const y0 = await p.evaluate(() => { window.__ys = []; window.__on = []; addEventListener("wheel", () => {
      setTimeout(() => { window.__y50 = scrollY; }, 50);
      const look = () => { window.__ys.push(scrollY); window.__on.push(window.AH.smoothing()); if (window.AH.smoothing() || window.__ys.length < 3) requestAnimationFrame(look); else window.__end = performance.now(); };
      window.__t0 = performance.now(); requestAnimationFrame(look); }, { once: true, passive: true }); return scrollY; });
    await p.mouse.wheel(0, 400);
    await p.waitForFunction(() => window.__end, null, { timeout: 3000 }).catch(() => {});
    const w = await p.evaluate(() => ({ y50: window.__y50, ys: window.__ys, ms: window.__end - window.__t0, y: scrollY, on: window.__on.some(Boolean) }));
    want(w.y50 > y0 && w.y50 < y0 + 400, `AH-138 wheel: 50 ms after 400 px of wheel the page is at ${w.y50} (from ${y0}): it jumped or never moved`);
    want(w.on && w.ys.every((y, i) => i === 0 || y >= w.ys[i - 1]) && Math.max(...w.ys) <= y0 + 400, `AH-138 wheel: not a steady catch-up that stops at its target: ${w.ys.join(" ")}`);
    want(w.ms <= 1500 && Math.abs(w.y - (y0 + 400)) <= 1, `AH-138 wheel: at ${w.y} after ${Math.round(w.ms)} ms (want ${y0 + 400} within 1.5 s)`);
    await p.waitForTimeout(300); // the last scroll's own event, as after a glide
    const f = await frames(p, 1000);
    want(f === 0, `AH-138 wheel: ${f} frames asked for in the second after the catch-up`);
    // a key ends the catch-up where it is (PageDown then scrolls as the browser does)
    await p.mouse.wheel(0, 400); await p.waitForTimeout(40);
    const mid = await p.evaluate(() => window.AH.smoothing());
    await p.keyboard.press("PageDown");
    want(mid && !(await p.evaluate(() => window.AH.smoothing())), `AH-138 wheel: PageDown during the catch-up (${mid ? "catching up" : "not catching up"}) did not end it`);
    await done(t, "AH-138 wheel", [API]);
  }
  // ... and none with reduced motion, nor for a finger: the browser's own scroll, 1:1
  for (const [motion, touch] of [["reduce", false], ["no-preference", true]]) {
    const t = await open("index.html", touch ? { width: 390, height: 844, touch } : { width: 1440, height: 900, motion });
    const p = t.page, label = `AH-138 wheel ${touch ? "on a touch phone" : "with reduced motion"}`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate(() => scrollTo(0, 600)); await p.waitForTimeout(300);
    await p.mouse.move(16, 400);
    await p.evaluate(() => { window.__on = false; const look = () => { window.__on = window.__on || window.AH.smoothing(); if (!window.__stop) requestAnimationFrame(look); }; requestAnimationFrame(look); });
    const y0 = await p.evaluate(() => scrollY);
    await p.mouse.wheel(0, 400); await p.waitForTimeout(400);
    const r = await p.evaluate(() => { window.__stop = true; return { on: window.__on, y: scrollY }; });
    want(!r.on && r.y > y0, `${label}: ${JSON.stringify({ y0, ...r })}`);
    await done(t, label, [API]);
  }
  // ... and a box that can scroll takes the wheel itself: the support form's message, full of lines
  {
    const t = await open("support.html", { width: 1280, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    await p.fill("#details", Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n"));
    await p.evaluate(() => { const d = document.getElementById("details"); d.scrollTop = 0; d.scrollIntoView({ block: "center" }); }); await p.waitForTimeout(1500);
    const b = await p.locator("#details").boundingBox();
    await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    const y0 = await p.evaluate(() => scrollY);
    await p.mouse.wheel(0, 100); await p.waitForTimeout(400);
    const r = await p.evaluate(() => ({ box: document.getElementById("details").scrollTop, y: scrollY, on: window.AH.smoothing(), overflows: document.getElementById("details").scrollHeight > document.getElementById("details").clientHeight }));
    want(r.overflows && r.box > 0 && r.y === y0 && !r.on, `AH-138 wheel over a full text box: ${JSON.stringify({ y0, ...r })}`);
    await done(t, "AH-138 wheel over a text box", [API]);
  }
  // (b) a press settles to 0.97 and back, the gold line held in every mode; (c) the main button's hover fill is drawn
  // across by its ::before, and under reduced motion there is no layer: the colours swap at once
  for (const motion of ["no-preference", "reduce"]) {
    const t = await open("index.html", { width: 1440, height: 900, motion });
    const p = t.page, sel = ".hero-cta .btn-primary", label = `AH-138 the hero's download (${motion})`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate((sel) => document.querySelector(sel).addEventListener("click", (e) => e.preventDefault()), sel);
    const look = () => p.$eval(sel, (el) => { const c = getComputedStyle(el), b = getComputedStyle(el, "::before");
      return { scale: c.transform === "none" ? 1 : new DOMMatrix(c.transform).a, tf: c.transform, outline: `${c.outlineStyle} ${c.outlineWidth}`, fill: b.content === "none" ? null : new DOMMatrix(b.transform).a, fillMoves: b.transitionDuration }; });
    const box = await p.locator(sel).boundingBox();
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const sweep = [];
    for (let i = 0; i < 8; i++) { sweep.push((await look()).fill); await p.waitForTimeout(40); }
    await settle(p, sel);
    const hovered = await look();
    await p.mouse.down();
    await settle(p, sel);
    const held = await look();
    await p.mouse.up();
    await settle(p, sel);
    const free = await look();
    if (motion === "reduce") {
      want(held.tf === "none" && held.outline === "solid 2px" && hovered.fill === null && sweep.every((v) => v === null), `${label}: pressed ${JSON.stringify(held)}, hovered ${JSON.stringify(hovered)}`);
    } else {
      want(Math.abs(held.scale - 0.97) <= 0.005 && held.outline === "solid 2px" && Math.abs(free.scale - 1) <= 0.001, `${label}: pressed ${JSON.stringify(held)}, let go ${JSON.stringify(free)}`);
      want(sweep.some((v) => v > 0.02 && v < 0.98) && hovered.fill === 1, `${label}: the hover fill does not sweep in: ${sweep.map((v) => (v === null ? "none" : v.toFixed(2))).join(" ")} then ${hovered.fill}`);
    }
    await done(t, label, [API]);
  }
  // (d) the phone's menu: a dropdown from the Menu button, in over --pop-in from .95 and see-through, out over 0.8 of
  // that back to .95, drawn and out of reach while it leaves, then gone
  {
    const t = await open("index.html", { width: 375, height: 667 });
    const p = t.page, k = await tok(p);
    await p.waitForTimeout(ENTERED);
    const read = () => p.evaluate(() => { const n = document.getElementById("main-nav"), b = document.querySelector(".menu-btn"), a = n.getAnimations()[0], nr = n.getBoundingClientRect(), br = b.getBoundingClientRect();
      const kf = a ? a.effect.getKeyframes() : [], o = getComputedStyle(n).transformOrigin.split(" ").map(parseFloat);
      return { name: a ? a.animationName : "", dur: a ? a.effect.getComputedTiming().duration : 0, first: kf[0] ? [kf[0].opacity, kf[0].transform] : [], last: kf.length ? [kf.at(-1).opacity, kf.at(-1).transform] : [],
        x: nr.left + o[0], btn: [br.left, br.right], drawn: n.getClientRects().length > 0, closing: n.hasAttribute("data-closing"), inert: n.inert, expanded: b.getAttribute("aria-expanded") }; });
    await p.click(".menu-btn");
    const o = await read();
    await settle(p, "#main-nav");
    const x = await read(); // the origin read where it sits once the links are at rest (scaled, their box is not)
    want(o.expanded === "true" && o.name === "pop-in" && o.first[0] === "0" && o.first[1] === "scale(0.95)" && o.dur >= 150 && o.dur <= 250 && x.x >= x.btn[0] && x.x <= x.btn[1], `AH-138 menu opening: ${JSON.stringify({ ...o, x: x.x, btn: x.btn })}`);
    await p.click(".menu-btn");
    const c = await read();
    want(c.expanded === "false" && c.closing && c.drawn && c.inert && Math.abs(c.dur - 0.8 * o.dur) <= 10 && c.last[0] === "0" && c.last[1] === "scale(0.95)", `AH-138 menu closing: ${JSON.stringify(c)}`);
    await p.waitForFunction(() => !document.getElementById("main-nav").hasAttribute("data-closing"), null, { timeout: 1000 }).catch(() => {});
    const g = await read();
    want(!g.drawn && !g.closing && !g.inert, `AH-138 menu closed: ${JSON.stringify(g)}`);
    await done(t, "AH-138 menu", [API]);
  }
  // (e) a row's detail box: from .95 at its row's button, its lines settling 30 ms apart; closed, the box is hidden at once
  // and one copy no reader can reach shrinks back over 0.8 of the opening's length, then is gone
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page, k = await tok(p);
    await p.waitForTimeout(ENTERED);
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
    await p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 }).catch(() => {});
    await p.click('.rowbtn[aria-controls="m22"]');
    const o = await p.evaluate(() => { const box = document.getElementById("m22"), a = box.getAnimations()[0], kf = a ? a.effect.getKeyframes() : [];
      return { first: kf[0] ? [kf[0].opacity, kf[0].transform] : [], dur: a ? a.effect.getComputedTiming().duration : 0, head: (document.querySelector("#m22 .m-head").getAnimations()[0] || { effect: { getTiming: () => ({ delay: -1 }) } }).effect.getTiming().delay,
        pairs: [...box.querySelectorAll("dt")].map((dt) => { const [x] = dt.getAnimations(), [y] = dt.nextElementSibling.getAnimations(); return x && y && x.effect.getTiming().delay === y.effect.getTiming().delay ? x.effect.getTiming().delay : -1; }) }; });
    want(o.first[0] === "0" && o.first[1] === "scale(0.95)" && o.dur === k.popIn && o.head === 0 && JSON.stringify(o.pairs) === JSON.stringify(o.pairs.map((_, i) => i * k.row)) && o.pairs.length === 5, `AH-138 detail box opening: ${JSON.stringify(o)}`);
    await settle(p, "#m22");
    const at = await p.evaluate(() => { const box = document.getElementById("m22"), r = box.getBoundingClientRect(), b = document.querySelector('.rowbtn[aria-controls="m22"]').getBoundingClientRect(), [x, y] = getComputedStyle(box).transformOrigin.split(" ").map(parseFloat);
      return { dx: Math.round((r.left + x - (b.left + b.width / 2)) * 10) / 10, dy: Math.round((r.top + y - (b.top + b.height / 2)) * 10) / 10 }; });
    want(Math.abs(at.dx) <= 2 && Math.abs(at.dy) <= 2, `AH-138 detail box: grows from ${JSON.stringify(at)} off its button's centre`);
    await p.click("#m22 .m-close");
    const c = await p.evaluate(() => { const box = document.getElementById("m22"), cs = [...document.querySelectorAll("[data-pop-copy]")], a = cs[0] && cs[0].getAnimations()[0], kf = a ? a.effect.getKeyframes() : [];
      return { hidden: box.hidden && !box.getClientRects().length, n: cs.length, aria: cs.map((x) => x.getAttribute("aria-hidden")).join(), inert: cs.every((x) => x.inert), role: cs.some((x) => x.hasAttribute("role")),
        ids: cs.reduce((n, x) => n + (x.id ? 1 : 0) + x.querySelectorAll("[id]").length, 0), boxes: [...document.querySelectorAll(".matrix")].filter((m) => !m.hidden).length,
        dur: a ? a.effect.getComputedTiming().duration : 0, last: kf.length ? [kf.at(-1).opacity, kf.at(-1).transform] : [] }; });
    want(c.hidden && c.n === 1 && c.aria === "true" && c.inert && !c.role && c.ids === 0 && c.boxes === 0 && Math.abs(c.dur - 0.8 * o.dur) <= 10 && c.last[0] === "0" && c.last[1] === "scale(0.95)", `AH-138 detail box closing: ${JSON.stringify(c)}`);
    await p.waitForFunction(() => !document.querySelector("[data-pop-copy]"), null, { timeout: 1000 }).catch(() => want(false, "AH-138 detail box: its closing copy was never removed"));
    await done(t, "AH-138 detail box", [API]);
  }
  // (f) one tab mark: the same node for every tab, sliding over --slide-dur, wider than either tab on the way and widest
  // at the half way (the two widths' average times --stretch), at rest exactly under the chosen tab; with reduced motion
  // it is there at once
  for (const motion of ["no-preference", "reduce"]) {
    const t = await open("index.html", { width: 1440, height: 900, motion });
    const p = t.page, k = await tok(p), label = `AH-138 tab mark (${motion})`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
    await p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 }).catch(() => {});
    const w = await p.evaluate(() => { window.__mark = document.querySelector(".tab-mark"); window.__ws = [];
      const look = () => { window.__ws.push(new DOMMatrix(getComputedStyle(window.__mark).transform).a); if (window.__ws.length < 60) requestAnimationFrame(look); }; requestAnimationFrame(look);
      return { n: document.querySelectorAll(".tab-mark").length, w0: document.getElementById("t-found").offsetWidth, w1: document.getElementById("t-clean").offsetWidth }; });
    await p.click("#t-clean");
    const s = await p.evaluate(() => { const m = document.querySelector(".tab-mark"), a = m.getAnimations()[0], kf = a ? a.effect.getKeyframes() : [];
      return { same: m === window.__mark, n: document.querySelectorAll(".tab-mark").length, anims: m.getAnimations().length, dur: a ? a.effect.getComputedTiming().duration : 0, peak: kf[1] ? new DOMMatrix(kf[1].transform).a : 0, hidden: m.getAttribute("aria-hidden"), focusable: m.tabIndex >= 0 }; });
    await settle(p, ".tabs");
    await p.waitForFunction(() => window.__ws.length >= 60, null, { timeout: 3000 }).catch(() => {});
    const r = await p.evaluate(() => { const m = document.querySelector(".tab-mark").getBoundingClientRect(), b = document.getElementById("t-clean").getBoundingClientRect(); return { dl: m.left - b.left, dw: m.width - b.width, ws: window.__ws }; });
    const avg = (w.w0 + w.w1) / 2 * k.stretch, top = Math.max(...r.ws);
    want(w.n === 1 && s.same && s.n === 1 && s.hidden === "true" && !s.focusable, `${label}: not one shared mark ${JSON.stringify({ ...w, ...s })}`);
    if (motion === "reduce") want(s.anims === 0, `${label}: it moves (${s.anims} animations)`);
    else want(s.dur >= 250 && s.dur <= 350 && Math.abs(s.peak / avg - 1) <= 0.03 && top > Math.max(w.w0, w.w1), `${label}: slide ${JSON.stringify({ dur: s.dur, peak: s.peak, avg, top, w0: w.w0, w1: w.w1 })}`);
    want(Math.abs(r.dl) <= 1 && Math.abs(r.dw) <= 1, `${label}: at rest it is ${JSON.stringify({ dl: r.dl, dw: r.dw })} off the chosen tab`);
    await done(t, label, [API]);
  }
  // (g) the Copy button: hidden with no script; it copies the PowerShell line, says Copied, crossfades its icons with a
  // scale and a blur, pulses once and is Copy again 2 s later; refused the clipboard, it selects the line and says to press
  // Ctrl+C, with no pulse
  {
    const t = await open("index.html", { width: 1280, js: false, until: "load" });
    want(await t.page.evaluate(() => { const b = document.querySelector(".copy-btn"); return !!b && b.hidden && !b.getClientRects().length; }), "AH-138 Copy: shown with no script");
    await done(t, "AH-138 Copy with no script");
  }
  for (const refused of [false, true]) {
    const t = await open("index.html", { width: 1280, init: refused ? () => { Object.defineProperty(navigator.clipboard, "writeText", { value: () => Promise.reject(new Error("refused")) }); } : null });
    const p = t.page, label = `AH-138 Copy${refused ? " with the clipboard refused" : ""}`;
    if (!refused) await t.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE.slice(0, -1) });
    await p.waitForTimeout(ENTERED);
    await p.click(".check-file summary");
    await settle(p, ".check-file");
    await p.evaluate(() => { const b = document.querySelector(".copy-btn"), [a, c] = b.querySelectorAll(".ico"); window.__pulses = 0; window.__icons = [];
      b.addEventListener("animationstart", (e) => { if (e.animationName === "pulse") window.__pulses++; });
      const pose = (el) => { const s = getComputedStyle(el); return [+s.opacity, s.transform === "none" ? 1 : new DOMMatrix(s.transform).a, parseFloat((/blur\(([\d.]+)px\)/.exec(s.filter) || [0, 0])[1])]; };
      b.addEventListener("click", () => { const look = () => { window.__icons.push([pose(a), pose(c)]); if (window.__icons.length < 40) requestAnimationFrame(look); }; requestAnimationFrame(look); }); });
    const shown = await p.evaluate(() => { const b = document.querySelector(".copy-btn"), r = b.getBoundingClientRect(); return { hidden: b.hidden, w: r.width, h: r.height }; });
    want(!shown.hidden && shown.w >= 24 && shown.h >= 24, `${label}: not shown as a 24 px target ${JSON.stringify(shown)}`);
    const t0 = Date.now();
    await p.click(".copy-btn");
    await p.waitForTimeout(700);
    const r = await p.evaluate(async (refused) => { const b = document.querySelector(".copy-btn"), code = b.previousElementSibling, [a, c] = b.querySelectorAll(".ico");
      return { label: b.textContent.trim(), done: b.hasAttribute("data-done"), line: code.textContent, picked: getSelection().toString(), pulses: window.__pulses, icons: window.__icons,
        rest: [getComputedStyle(a).opacity, getComputedStyle(c).opacity], clip: refused ? "" : await navigator.clipboard.readText().catch(() => "?") }; }, refused);
    if (refused) want(r.label === "Press Ctrl+C" && r.picked === r.line && !r.done && r.pulses === 0, `${label}: ${JSON.stringify({ ...r, icons: r.icons.length })}`);
    else {
      const mid = r.icons.some(([x, y]) => x[0] > 0 && x[0] < 1 && y[0] > 0 && y[0] < 1 && x[2] > 0 && y[2] > 0 && x[1] < 1 && y[1] < 1);
      want(r.clip === r.line && r.line === "Get-FileHash .\\Arcas.exe -Algorithm SHA256" && r.label === "Copied" && r.done && mid && r.rest[0] === "0" && r.rest[1] === "1" && r.pulses === 1, `${label}: ${JSON.stringify({ ...r, icons: r.icons.slice(0, 12) })}`);
      await p.waitForFunction(() => document.querySelector(".copy-btn").textContent.trim() === "Copy", null, { timeout: 3000 }).catch(() => {});
      const back = Date.now() - t0;
      want(back >= 1900 && back <= 2900 && !(await p.evaluate(() => document.querySelector(".copy-btn").hasAttribute("data-done"))), `AH-138 Copy: back to Copy after ${back} ms`);
    }
    await done(t, label, [API]);
  }
  // ... and open at 320 px with text at 200%, it scrolls nothing sideways and stays a 24 px target
  {
    const t = await open("index.html", { width: 320, height: 800, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => { document.documentElement.style.fontSize = "200%"; document.querySelector(".check-file").open = true; });
    await p.waitForTimeout(100);
    const r = await p.evaluate(() => { const b = document.querySelector(".copy-btn").getBoundingClientRect(); return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth, w: b.width, h: b.height, right: b.right }; });
    want(r.over <= 0 && r.w >= 24 && r.h >= 24 && r.right <= 320, `AH-138 Copy at 320 px with text at 200%: ${JSON.stringify(r)}`);
    await done(t, "AH-138 Copy at 320 px", [API]);
  }
  // (h) a group of blocks keeps --stagger: the checks' headline, fact and lede rise 0, 90 and 180 ms apart (the table's
  // rows, list rows, are held to 30 ms in the reveal check above)
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page, k = await tok(p);
    await p.waitForTimeout(ENTERED);
    await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop - 200)); await p.waitForTimeout(200);
    const d = await p.$$eval("#checks > .wrap > .reveal-item", (es) => es.map((e) => Math.round(parseFloat(getComputedStyle(e).transitionDelay) * 1000)));
    want(JSON.stringify(d) === JSON.stringify([0, k.stagger, 2 * k.stagger]) && k.stagger === 90, `AH-138 a group of blocks: delays ${d} (want 0, 90, 180)`);
    await done(t, "AH-138 a group of blocks", [API]);
  }
  assert.deepEqual(miss, [], `John's motion list (AH-138):\n${miss.join("\n")}`);
  console.log("AH-138: the heavy wheel (on its way at 50 ms, steady, never past its target, there within 1.5 s, then idle; a key ends it; none under reduced motion or for a finger; a full text box keeps its wheel), the press to 0.97 and the main button's mask fill (none under reduced motion), the menu and a row's detail box as popovers from their trigger (exits 0.8 of their entrances), one tab mark that slides and stretches, the Copy button's crossfade, pulse and Ctrl+C fallback, blocks still 90 ms apart");
}
// ---- AH-138 fix round 1 (a blind design review, 2026-11-06): the turning page's scan meter frozen where it was, the
// phone's menu over the page (never pushing it down, so "Checks" lands on the checks), no tap flash, the release link's
// words whole, a filter that clears the other rows' marks, the main button's fill to its edge, a Copy button that keeps
// its size, a wider feather under the text, a phone's hint that the sample scrolls sideways, short pages that fill the
// screen, answers that settle in turn, and a detail box raised off the sheet ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const settle = (p, sel) => p.$eval(sel, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  const still = async (p) => { let y = await p.evaluate(() => scrollY), t = Date.now(), since = Date.now();
    while (Date.now() - t < 4000) { await p.waitForTimeout(50); const z = await p.evaluate(() => scrollY); if (z !== y) { y = z; since = Date.now(); } else if (Date.now() - since >= 300) break; } };
  // 1. Scanning, then After fixes: the turning copy's meter holds the pose the real meter had at the click
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
    await p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 }).catch(() => {});
    await p.click("#t-busy"); await p.waitForTimeout(1200);
    await p.evaluate(() => document.getElementById("t-clean").addEventListener("click", () => { window.__meter = new DOMMatrix(getComputedStyle(document.querySelector("#p-busy .meter span")).transform).a; }, { capture: true, once: true }));
    await p.click("#t-clean");
    const look = () => p.evaluate(() => { const s = document.querySelector("[data-turn] .meter span");
      return s ? { at: window.__meter, a: new DOMMatrix(getComputedStyle(s).transform).a, running: s.getAnimations().filter((x) => x.playState === "running").length } : null; });
    const r0 = await look(); await p.waitForTimeout(150); const r1 = await look();
    want(r0 && r1 && !r0.running && !r1.running && Math.abs(r0.a - r0.at) <= 0.01 && Math.abs(r1.a - r0.at) <= 0.01, `R1 the turning page's meter: ${JSON.stringify([r0, r1])}`);
    await done(t, "R1 turning meter", [API]);
  }
  // 2. the phone's menu lies over the page: opening it moves nothing below, and its "Checks" lands on the checks
  {
    const t = await open("index.html", { width: 390, height: 844 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    const top = () => p.evaluate(() => document.getElementById("page").getBoundingClientRect().top);
    const y0 = await top();
    await p.click(".menu-btn"); await settle(p, "#main-nav");
    const y1 = await top();
    want(Math.abs(y1 - y0) <= 0.5, `R2 opening the phone's menu moves the page ${y1 - y0} px`);
    await p.click('#main-nav a[href$="#checks"]');
    await p.waitForFunction(() => !window.AH.gliding(), null, { timeout: 4000 }).catch(() => {});
    await still(p);
    const r = await p.evaluate(() => ({ checks: document.getElementById("checks").getBoundingClientRect().top, bar: document.querySelector(".bar").getBoundingClientRect().bottom, y: scrollY }));
    want(Math.abs(r.checks - Math.max(0, r.bar)) <= 2, `R2 "Checks" from the phone's menu lands off the checks: ${JSON.stringify(r)}`);
    await done(t, "R2 phone menu over the page", [API]);
  }
  // 4. the release page link's words are never split, on a phone and at 320 px with text at 200%
  for (const [width, size] of [[390, "100%"], [320, "200%"]]) {
    const t = await open("index.html", { width, height: 800, motion: "reduce", api: json({ message: "API rate limit exceeded" }, 403) });
    const p = t.page;
    const r = await p.evaluate((size) => { document.documentElement.style.fontSize = size;
      const a = document.querySelector("#sha a"), text = a.firstChild, split = [];
      for (const m of text.textContent.matchAll(/\S+/g)) { const q = document.createRange(); q.setStart(text, m.index); q.setEnd(text, m.index + m[0].length);
        const lines = new Set([...q.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))); if (lines.size > 1) split.push(m[0]); }
      return { text: text.textContent, split, over: document.documentElement.scrollWidth - document.documentElement.clientWidth }; }, size);
    want(r.text === "shown on the release page" && !r.split.length && r.over <= 0, `R4 the release link at ${width} px, text ${size}: ${JSON.stringify(r)}`);
    await done(t, `R4 release link at ${width}px`, [API]);
  }
  // 5. a filter clears the other rows' marks (their values stay, at the same .7): row 5's jump is a plain cell under
  // "Totals that don't add up", row 11 keeps its fill
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    await p.click('.typology button[data-kind="recon"]');
    const r = await p.evaluate(() => { const c = (sel) => { const s = getComputedStyle(document.querySelector(sel)); return { bg: s.backgroundColor, shadow: s.boxShadow, outline: s.outlineStyle, color: s.color, weight: s.fontWeight }; };
      return { plain: c("#p-found tbody tr:first-child td:nth-child(6)"), r5: c("#r5 td.q"), r11: c("#r11 td.flag"), sq: getComputedStyle(document.querySelector("#r5 td.why i")).visibility, sq11: getComputedStyle(document.querySelector("#r11 td.why i")).visibility,
        text: document.querySelector("#r5 td.q").textContent, op: getComputedStyle(document.getElementById("r5")).opacity }; });
    want(JSON.stringify(r.r5) === JSON.stringify(r.plain) && r.sq === "hidden" && r.text === "304.39" && r.op === "0.7", `R5 row 5 under "Totals that don't add up": ${JSON.stringify(r)}`);
    want(r.r11.bg === "rgb(107, 30, 46)" && r.sq11 === "visible", `R5 row 11 under "Totals that don't add up" lost its marks: ${JSON.stringify(r.r11)}`);
    await done(t, "R5 filters clear the other rows' marks", [API]);
  }
  // 6. hovered and at rest, a button's fill reaches its very edge: no wine rim on the main button
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    for (const sel of [".hero-cta .btn-primary", ".hero-cta .btn-ghost"]) {
      const b = await p.locator(sel).boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await settle(p, sel); await p.waitForTimeout(50);
      const { px } = png(await p.screenshot({ clip: { x: Math.round(b.x) + 1, y: Math.round(b.y) + 1, width: 1, height: 1 } }));
      want(Math.abs(px[0] - 12) <= 6 && Math.abs(px[1] - 25) <= 6 && Math.abs(px[2] - 56) <= 6, `R6 ${sel} hovered: the pixel inside its corner is rgb(${[...px.slice(0, 3)].join(", ")}), not navy`);
    }
    await done(t, "R6 button fill to the edge", [API]);
  }
  // 7. the Copy button keeps its width when it says Copied
  {
    const t = await open("index.html", { width: 1280 });
    const p = t.page;
    await t.ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE.slice(0, -1) });
    await p.waitForTimeout(ENTERED);
    await p.click(".check-file summary"); await settle(p, ".check-file");
    const w0 = await p.$eval(".copy-btn", (b) => b.getBoundingClientRect().width);
    await p.click(".copy-btn");
    await p.waitForFunction(() => document.querySelector(".copy-btn").textContent.trim() === "Copied", null, { timeout: 2000 }).catch(() => {});
    await settle(p, ".copy-btn");
    const w1 = await p.$eval(".copy-btn", (b) => [b.getBoundingClientRect().width, b.textContent.trim()]);
    want(w1[1] === "Copied" && Math.abs(w1[0] - w0) <= 0.5, `R7 the Copy button goes from ${w0} to ${w1[0]} px wide when it says ${w1[1]}`);
    await done(t, "R7 Copy button width", [API]);
  }
  // 9. a phone says the sample scrolls sideways; a wide screen does not need to
  for (const width of [390, 1440]) {
    const t = await open("index.html", { width, height: 844, motion: "reduce" });
    const r = await t.page.evaluate(() => { const e = document.querySelector(".swipe"); return e ? { text: e.textContent.trim(), shown: e.getClientRects().length > 0, display: getComputedStyle(e).display } : null; });
    want(r && r.text === "Swipe the table sideways to see each order's date and region." && (width <= 760 ? r.shown : r.display === "none"), `R9 the swipe hint at ${width} px: ${JSON.stringify(r)}`);
    await done(t, `R9 swipe hint at ${width}px`, [API]);
  }
  // 10. a short page fills the screen to its footer; the home page keeps its height. thanks.html is 1,136 px tall at
  // 1440 px wide, so it is read on a screen taller than that
  for (const [file, height] of [["404.html", 900], ["thanks.html", 1300]]) {
    const t = await open(file, { width: 1440, height, motion: "reduce" });
    const r = await t.page.evaluate(() => ({ foot: document.querySelector("footer").getBoundingClientRect().bottom, h: innerHeight, scroll: document.documentElement.scrollHeight - innerHeight }));
    want(Math.abs(r.foot - r.h) <= 1 && r.scroll <= 0, `R10 ${file} at 1440 x ${height} does not end at the screen's bottom: ${JSON.stringify(r)}`);
    await done(t, `R10 ${file} fills the screen`, file === "404.html" ? [] : [API]);
  }
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const r = await t.page.evaluate(() => { const a = document.documentElement.scrollHeight; document.body.style.display = "block"; const b = document.documentElement.scrollHeight; document.body.style.display = ""; return { flex: getComputedStyle(document.body).display, a, b }; });
    want(r.flex === "flex" && Math.abs(r.a - r.b) <= 1, `R10 the home page's height changes with the filled screen: ${JSON.stringify(r)}`);
    await done(t, "R10 home page height", [API]);
  }
  // 11. an answer that opens settles in turn, its blocks --stagger-row apart; with reduced motion it shows at once
  for (const motion of ["no-preference", "reduce"]) {
    for (const [file, sel] of [["index.html", "#faq details:first-of-type"], ["index.html", ".check-file"], ["support.html", ".faq details:nth-of-type(7)"]]) {
      const t = await open(file, { width: 1440, height: 900, motion });
      const p = t.page, k = await p.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--stagger-row")));
      if (motion !== "reduce") await p.waitForTimeout(ENTERED);
      await p.$eval(sel, (d) => d.scrollIntoView({ block: "center" })); await p.waitForTimeout(motion === "reduce" ? 100 : 1500);
      await p.click(`${sel} > summary`);
      await p.waitForTimeout(30);
      const r = await p.$eval(sel, (d) => { const box = d.querySelector(":scope > summary + *");
        return { open: d.open, kids: [...box.children].map((c) => { const a = c.getAnimations()[0]; return a ? a.effect.getTiming().delay : null; }), from: (() => { const a = box.firstElementChild.getAnimations()[0]; const f = a && a.effect.getKeyframes()[0]; return f ? [f.opacity, f.transform] : null; })() }; });
      if (motion === "reduce") want(r.open && r.kids.every((x) => x === null), `R11 ${file} ${sel} with reduced motion: ${JSON.stringify(r)}`);
      else want(r.open && JSON.stringify(r.kids) === JSON.stringify(r.kids.map((_, i) => i * k)) && r.from && r.from[0] === "0" && /translate/.test(r.from[1]), `R11 ${file} ${sel} opening: ${JSON.stringify(r)}`);
      await done(t, `R11 ${file} ${sel} (${motion})`, [API]);
    }
  }
  // 12. the row detail box is raised off the sheet: a still shadow under it
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    await t.page.click('.rowbtn[aria-controls="m22"]');
    const sh = await t.page.$eval("#m22", (b) => getComputedStyle(b).boxShadow);
    want(sh && sh !== "none", `R12 the detail box has no shadow (${sh})`);
    await done(t, "R12 detail box shadow", [API]);
  }
  assert.deepEqual(miss, [], `AH-138 fix round 1:\n${miss.join("\n")}`);
  console.log("AH-138 fix round 1: the turning page's meter frozen, the phone's menu over the page and its Checks landing on the checks, the release link's words whole at 390 and 320 px (200%), a filter clearing the other rows' marks, the button fills to their edge, the Copy button's width kept, the phone's swipe hint, short pages to the screen's bottom, answers settling 30 ms apart, the detail box's shadow");
}
// ---- AH-138 fix round 2 (a second blind design review, 2026-11-06): the phone's menu closes like a popover (a press
// outside it, or a scroll) and its links are 44 px targets; the phone's download bar never covers the contact form; the
// turning copy covers the taller After fixes panel until it passes; a page change by a link lands at the top; the hero's
// buttons and note fit a 1280 x 720 screen; the notice line never leaves "Download" alone ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const settle = (p, sel) => p.$eval(sel, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  const menu = (p) => p.evaluate(() => { const n = document.getElementById("main-nav"); return { expanded: document.querySelector(".menu-btn").getAttribute("aria-expanded"), drawn: n.getClientRects().length > 0, closing: n.hasAttribute("data-closing"),
    links: [...n.querySelectorAll("a")].map((a) => Math.round(a.getBoundingClientRect().height * 10) / 10), bottom: n.getBoundingClientRect().bottom }; });
  // 1. the phone's menu: 44 px links; a press outside it closes it (with its exit), and so does a scroll
  {
    const t = await open("index.html", { width: 390, height: 844 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    await p.click(".menu-btn"); await settle(p, "#main-nav");
    const m0 = await menu(p);
    want(m0.expanded === "true" && m0.links.length === 5 && m0.links.every((h) => h >= 44), `S1 the phone menu's links: ${JSON.stringify(m0)}`);
    await p.mouse.click(200, Math.min(830, m0.bottom + 80));
    const m1 = await menu(p);
    await p.waitForFunction(() => !document.getElementById("main-nav").hasAttribute("data-closing"), null, { timeout: 1000 }).catch(() => {});
    const m2 = await menu(p);
    want(m1.expanded === "false" && !m2.drawn && !m2.closing, `S1 a press outside the open menu: ${JSON.stringify([m1, m2])}`);
    if ((await menu(p)).expanded !== "true") await p.click(".menu-btn");
    await settle(p, "#main-nav");
    await p.evaluate(() => scrollTo(0, scrollY + 600)); await p.waitForTimeout(300);
    await p.waitForFunction(() => !document.getElementById("main-nav").hasAttribute("data-closing"), null, { timeout: 1000 }).catch(() => {});
    const m3 = await menu(p);
    want(m3.expanded === "false" && !m3.drawn, `S1 a scroll of 600 px with the menu open: ${JSON.stringify(m3)}`);
    await done(t, "S1 phone menu closes", [API]);
  }
  // 2. the phone's download bar never lies over the contact form's button
  {
    const t = await open("index.html", { width: 390, height: 844 });
    const p = t.page, sel = '#note button[type="submit"]';
    await p.waitForTimeout(ENTERED);
    // the button low on the screen, where the bar would lie (the review's frame), and then in the middle
    for (const low of [true, false]) {
    await p.$eval(sel, (b, low) => { if (!low) return b.scrollIntoView({ block: "center" }); let top = 0; for (let e = b; e; e = e.offsetParent) top += e.offsetTop; scrollTo(0, top + b.offsetHeight - innerHeight + 30); }, low);
    await p.waitForTimeout(800);
    const r = await p.$eval(sel, (b) => { const x = b.getBoundingClientRect(), at = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
      return { dock: document.getElementById("dock").hidden, hit: !!at && (at === b || b.contains(at)), on: at ? at.tagName + "." + at.className : null }; });
    want(r.dock && r.hit, `S2 the download bar over the contact form (${low ? "low" : "mid"} screen): ${JSON.stringify(r)}`);
    }
    await done(t, "S2 dock and the contact form", [API]);
  }
  // 3. Scanning, then After fixes: the turning copy covers the taller new panel's lower rows until it passes them
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
    await p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 }).catch(() => {});
    await p.click("#t-busy"); await p.waitForTimeout(1200);
    await p.evaluate(() => { window.__cover = [];
      const look = (ms) => { const cell = document.querySelector("#p-clean tbody tr:last-child td:nth-child(6)"), c = document.querySelector("[data-turn]");
        cell.scrollIntoView({ block: "center" });
        const r = cell.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, b = c && c.getBoundingClientRect();
        window.__cover.push({ ms, row: cell.parentElement.querySelector("th").textContent, covered: !!b && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom && getComputedStyle(c).opacity === "1" }); };
      document.getElementById("t-clean").addEventListener("click", () => { for (const ms of [0, 60, 150]) setTimeout(() => look(ms), ms); }, { capture: true, once: true }); });
    await p.click("#t-clean");
    await p.waitForTimeout(300);
    await p.waitForFunction(() => !document.querySelector("[data-turn]"), null, { timeout: 2000 }).catch(() => {});
    const r = await p.evaluate(() => { const cell = document.querySelector("#p-clean tbody tr:last-child td:nth-child(6)"); cell.scrollIntoView({ block: "center" }); const x = cell.getBoundingClientRect(), at = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2);
      return { cover: window.__cover, reach: at === cell || cell.contains(at) }; });
    want(r.cover.length === 3 && r.cover.every((c) => c.row === "57" && c.covered) && r.reach, `S3 After fixes' row 57 during the turn: ${JSON.stringify(r)}`);
    await done(t, "S3 turning copy covers the new panel", [API]);
  }
  // 4. a page change by a link keeps the header where it was: it stays mounted over the curtain, and opening the new page
  // at its very top dropped it 36 px at the swap (tried in fix round 2, kept out): from the bottom by the footer, from
  // 400 px by the header, and from 10 px, where the notice line is still part shown, the bar's top is the same after
  {
    const t = await open("privacy.html", { width: 1440, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    // a real pointer press where the link is: Playwright's locator click first scrolls a sticky header's link "into
    // view", to the page's top, which no visitor's click does (it read as a 36 px drop on main too)
    const press = async (sel) => { const bb = await p.locator(sel).boundingBox(); await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); };
    const bar = () => p.evaluate(() => Math.round(document.querySelector(".bar").getBoundingClientRect().top * 10) / 10);
    const keep = async (label, before) => { await p.waitForFunction(() => !document.documentElement.hasAttribute("data-moving"), null, { timeout: 3000 }).catch(() => {}); await p.waitForTimeout(300);
      const after = await bar();
      want(Math.abs(after - before) <= 0.5, `S4 ${label}: the bar's top went from ${before} to ${after}`); };
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(400);
    let before = await bar();
    await press('footer a[href="terms.html"]'); await p.waitForURL(/terms\.html$/); await keep("the footer's Terms from the bottom of privacy.html", before);
    await p.evaluate(() => scrollTo(0, 400)); await p.waitForTimeout(400);
    before = await bar();
    await press('header a[href="support.html"]'); await p.waitForURL(/support\.html$/); await keep("the header's Support from 400 px down terms.html", before);
    await p.evaluate(() => scrollTo(0, 10)); await p.waitForTimeout(400);
    before = await bar();
    await press('header a[href="privacy.html"]'); await p.waitForURL(/privacy\.html$/); await keep("the header's Privacy from 10 px down support.html", before);
    await done(t, "S4 a page change keeps the header where it was", [API]);
  }
  // 5. on a 1280 x 720 laptop the hero's buttons and the note under them fit, 8 px to spare
  {
    const t = await open("index.html", { width: 1280, height: 720, motion: "reduce" });
    const r = await t.page.evaluate(() => ({ note: document.querySelector(".hero .note").getBoundingClientRect().bottom, cta: document.querySelector(".hero-cta").getBoundingClientRect().bottom, h: innerHeight }));
    want(r.note <= r.h - 8 && r.cta <= r.h - 8, `S5 the hero at 1280 x 720: ${JSON.stringify(r)}`);
    await done(t, "S5 hero at 1280 x 720", [API]);
  }
  // 6. on a phone the notice line's last line holds more than "Download", on every page
  for (const file of [...PAGES, MISSING]) {
    const t = await open(file, { width: 390, height: 844, motion: "reduce" });
    const r = await t.page.evaluate(() => { const p = document.querySelector(".notice-bar p"), a = p.querySelector("a"), top = (x) => Math.round(x.getBoundingClientRect().top);
      const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let dot = null; for (let n = w.nextNode(); n; n = w.nextNode()) if (!a.contains(n) && n.textContent.includes("·")) dot = n;
      const q = document.createRange(), i = dot.textContent.lastIndexOf("·"); q.setStart(dot, i); q.setEnd(dot, i + 1);
      // the link's words, not its box: on a phone its box reaches 12 px above them (a 44 px target, AH-148)
      const words = document.createRange(); words.selectNodeContents(a);
      return { dot: Math.round(q.getBoundingClientRect().top), link: top(words), lines: new Set([...(() => { const all = document.createRange(); all.selectNodeContents(p); return all.getClientRects(); })()].map((x) => Math.round(x.top))).size }; });
    want(Math.abs(r.dot - r.link) <= 6, `S6 ${file} at 390 px: "Download" alone on the notice line's last line ${JSON.stringify(r)}`);
    await done(t, `S6 notice line on ${file}`, file === MISSING ? [] : [API]);
  }
  assert.deepEqual(miss, [], `AH-138 fix round 2:\n${miss.join("\n")}`);
  console.log("AH-138 fix round 2: the phone menu's 44 px links, closed by a press outside or a scroll; the download bar off the contact form; the turning copy over the taller After fixes panel; page changes landing at the top; the hero at 1280 x 720 with 8 px to spare; the notice line never leaving Download alone");
}
// ---- AH-146 and AH-147 (John, 2026-11-07, two iPhone recordings). AH-146: on iPhone Safari the phone's menu showed its
// links only while it popped in, then lost them under the bar's overflow clip while the button stayed dark (Chromium never
// clipped it, so no check saw it): on a phone the bar clips nothing, and nothing ever scrolls sideways for it. AH-147: the
// sample's Scanning tab looped its three words and refilled its bar forever ("at 100% it is still scanning and jumping
// from step 3 to 2"): it now plays the pane's three words once, the bar filling once, then turns to the findings ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const STAGES = JSON.parse(/const STAGES = (\[[^\]]*\]);/.exec(read("home.js"))[1]);
  // AH-146: the phone's bar clips nothing; the open menu's links are there to press a second later
  {
    const t = await open("index.html", { width: 390, height: 844 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    const o = await p.$eval(".bar", (b) => [getComputedStyle(b).overflowX, getComputedStyle(b).overflowY]);
    want(o.join() === "visible,visible", `AH-146 the phone's bar clips (${o})`);
    await p.click(".menu-btn"); await p.waitForTimeout(1000);
    const r = await p.evaluate(() => ({ expanded: document.querySelector(".menu-btn").getAttribute("aria-expanded"),
      hit: [...document.querySelectorAll("#main-nav a")].map((a) => { const x = a.getBoundingClientRect(), at = document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2); return !!at && (at === a || a.contains(at)); }) }));
    want(r.expanded === "true" && r.hit.length === 5 && r.hit.every(Boolean), `AH-146 the open menu a second later: ${JSON.stringify(r)}`);
    await done(t, "AH-146 phone menu stays", [API]);
  }
  // ... and with the bar unclipped, no frame of a fresh load scrolls sideways (the links slid in from past the right edge on
  // a wide screen; on a phone they wait in the closed menu, and the brand and the notice line come from the left)
  for (const [width, size] of [[320, "100%"], [390, "100%"], [320, "200%"]]) {
    // open() takes no argument for its init script, so this context is made here, the same way
    const ctx = await browser.newContext({ viewport: { width, height: 800 } });
    const p = await ctx.newPage();
    await p.route("https://api.github.com/**", json(release)); await p.route(/^https:\/\/(?!api\.github\.com)/, (r) => r.abort());
    await p.addInitScript((size) => { window.__wide = 0; const look = () => { const d = document.documentElement;
      if (d) { if (size !== "100%") d.style.fontSize = size; window.__wide = Math.max(window.__wide, d.scrollWidth - d.clientWidth); }
      if (performance.now() < 3000) requestAnimationFrame(look); }; requestAnimationFrame(look); }, size);
    await p.goto(BASE + "index.html", { waitUntil: "load" });
    await p.waitForFunction(() => performance.now() >= 3000, null, { timeout: 10000 });
    const wide = await p.evaluate(() => window.__wide);
    want(wide <= 0, `AH-146 a fresh load at ${width} px, text ${size}, scrolled ${wide} px sideways in its first 3 s`);
    await ctx.close();
  }
  // AH-147: the Scanning tab plays the pane's words once, each once and in order, the bar filling once and full when it
  // says 100%; nothing loops; then the sheet turns to the findings and nothing more moves
  const scanRun = async (motion) => {
    const t = await open("index.html", { width: 1440, height: 900, motion });
    const p = t.page, label = `AH-147 Scanning (${motion})`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
    await p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 }).catch(() => {});
    const arm = () => p.evaluate(() => { const tk = document.getElementById("ticker"), span = document.querySelector("#p-busy .meter span");
      window.__texts = []; window.__meter = []; window.__loops = 0; window.__anims = 0; window.__run = true; window.__go = false;
      document.getElementById("t-busy").addEventListener("click", () => { window.__go = true; }, { capture: true, once: true });
      if (window.__mo) window.__mo.disconnect();
      window.__mo = new MutationObserver(() => window.__texts.push(tk.textContent)); window.__mo.observe(tk, { childList: true, characterData: true, subtree: true });
      const look = () => { const m = getComputedStyle(span).transform; if (window.__go) window.__meter.push([m === "none" ? 1 : new DOMMatrix(m).a, tk.textContent]);
        const all = document.getAnimations(); window.__anims = Math.max(window.__anims, all.length);
        window.__loops += all.filter((a) => a.effect && a.effect.getComputedTiming().iterations === Infinity).length;
        if (window.__run) setTimeout(look, 16); };
      look(); });
    await arm();
    await p.click("#t-busy");
    const end = await p.waitForFunction(() => document.getElementById("t-found").getAttribute("aria-selected") === "true" && !document.getElementById("p-found").hidden, null, { timeout: 3500 }).then(() => true, () => false);
    const r = await p.evaluate(() => { window.__run = false; return { texts: window.__texts, meter: window.__meter, loops: window.__loops, anims: window.__anims, focus: document.activeElement.id,
      busy: [...document.querySelectorAll("#p-busy .stages li")].map((li) => [li.getAttribute("aria-current"), li.hasAttribute("data-done")]) }; });
    const run = r.meter;
    const full = run.find(([, x]) => x === STAGES[1]);
    want(end && r.focus === "t-found", `${label}: not on the findings within 3.5 s (${end}, focus ${r.focus})`);
    want(JSON.stringify(r.texts) === JSON.stringify(STAGES), `${label}: the ticker said ${JSON.stringify(r.texts)}`);
    want(r.loops === 0, `${label}: ${r.loops} samples saw an animation that never ends`);
    const climb = run.slice(0, run.findIndex(([, x]) => x === STAGES[2]) + 1);
    want(climb.every(([a], i) => i === 0 || a >= climb[i - 1][0] - 0.001) && full && Math.abs(full[0] - 1) <= 0.01, `${label}: the bar ${climb.map(([a, x]) => a.toFixed(2) + (x === STAGES[1] ? "*" : "")).join(" ")}`);
    if (motion === "reduce") want(r.anims === 0, `${label}: ${r.anims} animations under reduced motion`);
    if (motion !== "reduce") {
      await p.waitForTimeout(900);
      await p.evaluate(() => { window.__frames = 0; const raf = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (f) => (window.__frames++, raf(f)); });
      await p.waitForTimeout(1000);
      const f = await p.evaluate(() => window.__frames);
      want(f === 0, `${label}: ${f} frames asked for in the second after the run`);
      // chosen again, it starts again from the first word
      await arm(); await p.click("#t-busy"); await p.waitForTimeout(100);
      const again = await p.evaluate(() => ({ texts: window.__texts.slice(), now: document.getElementById("ticker").textContent }));
      want(again.texts[0] === STAGES[0] && again.now === STAGES[0], `${label}: chosen again it does not start over: ${JSON.stringify(again)}`);
      await p.waitForFunction(() => document.getElementById("t-found").getAttribute("aria-selected") === "true", null, { timeout: 3500 }).catch(() => {});
      // left for After fixes mid-run, it never jumps to the findings afterwards
      await p.click("#t-busy"); await p.waitForTimeout(600); await p.click("#t-clean"); await p.waitForTimeout(4000);
      const stay = await p.evaluate(() => [document.getElementById("t-clean").getAttribute("aria-selected"), document.getElementById("p-clean").hidden]);
      want(stay[0] === "true" && stay[1] === false, `${label}: After fixes chosen mid-run did not stay: ${stay}`);
      await p.evaluate(() => { window.__run = false; });
    }
    await done(t, label, [API]);
  };
  await scanRun("no-preference");
  await scanRun("reduce");
  assert.deepEqual(miss, [], `AH-146 and AH-147:\n${miss.join("\n")}`);
  console.log("AH-146: the phone's bar clips nothing, the open menu's links there a second later, no sideways scroll in the first 3 s at 320 and 390 px (and 320 px at 200%); AH-147: Scanning plays the pane's three words once, the bar filling once and full at 100%, nothing looping, then the findings and no more frames; chosen again it starts over; After fixes chosen mid-run stays; with reduced motion the same words and no animation");
}
console.log(`page transitions: ${measured.moving} ms of motion on screen (${measured.swap} ms in the page, ${measured.duration} ms from the click), both pages in ${measured.both} of ${measured.ofFrames} frames, ` +
  `the whitest of ${measured.frames} screencast frames ${(measured.white * 100).toFixed(2)}% white; seeked to its middle (${measured.mid.t} ms, the seek took ${measured.mid.spent} ms) the old page shows ${measured.mid.old.toFixed(1)} px and the new ${measured.mid.new.toFixed(1)} px of ${measured.mid.width}, ` +
  `overlap ${measured.mid.overlap.toFixed(1)} px (worst frame ${measured.overlap.toFixed(1)} px), the edge ${measured.mid.seam.toFixed(1)} px off the boundary; ` +
  `at 20 frames a second: middle ${measured.slow.mid.t} ms, ${measured.slow.mid.old.toFixed(1)} / ${measured.slow.mid.new.toFixed(1)} px, overlap ${measured.slow.mid.overlap.toFixed(1)} px (worst frame ${measured.slow.overlap.toFixed(1)} px), edge ${measured.slow.mid.seam.toFixed(1)} px off, both pages in ${measured.slow.both} of ${measured.slow.ofFrames} frames`);
// ---- AH-148 (John, 2026-11-09): "feel more immersive, alive, less AI and human... fun to scroll and look at, while keeping
// technical data simple and easy to read for non technical people". The type as the font draws it (kerning, tabular
// figures, the mono font at the sans's x-height, labels centred on their capitals, no shift when the font arrives), a
// thumb's 44 px on a phone, a line of text no longer than 75 letters, a whole row that answers the pointer, Copy said at
// the press, a menu and a detail box that go on from where they are when cut short, one gold mark shared by a "Row 22"
// link and its row, and figures that count to their values. Each check collects what it finds; the group fails once ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  const font = woff2("assets/plus-jakarta-sans.woff2"), upm = font.head.readUInt16BE(18);
  const ASC = font["OS/2"].readInt16BE(68) / upm, DESC = -font["OS/2"].readInt16BE(70) / upm, CAP = font["OS/2"].readInt16BE(88) / upm;
  const settle = (p, sel) => p.$eval(sel, (el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
  const landed = (p) => p.waitForFunction(() => !document.getElementById("preview").hasAttribute("data-loading"), null, { timeout: 4000 }).catch(() => {});
  // (a) the type, computed: kerning on, tabular figures where they line up (past the .verdict's font shorthand), the
  // labels trimmed to their capitals, the code at the font's x-height, a § heading's lines apart; and the download
  // arrow's middle on the middle of its label's capitals, within 1 px
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    const c = await p.evaluate(([ASC, DESC, CAP]) => {
      const cs = (sel, k) => getComputedStyle(document.querySelector(sel))[k];
      const b = document.querySelector("#download .stage .btn"), text = [...b.childNodes].find((n) => n.nodeType === 3 && n.data.trim()), rg = document.createRange();
      rg.selectNodeContents(text);
      const r = rg.getBoundingClientRect(), fs = parseFloat(getComputedStyle(b).fontSize), base = r.top + r.height * ASC / (ASC + DESC), i = b.querySelector("svg path").getBoundingClientRect();
      return { kern: [...new Set(["p", ".label", ".btn", "h1", ".notice-bar p", ".grid td"].map((sel) => cs(sel, "fontKerning")))].join(), optical: cs("body", "fontOpticalSizing"),
        tnum: [":is(.matrix) dd", ".verdict", ".stages li", ".case-scope", ".typology .n", ".proof dt"].map((sel) => [sel, cs(sel, "fontVariantNumeric")]).filter(([, v]) => !/tabular-nums/.test(v)),
        trim: CSS.supports("text-box", "trim-both cap alphabetic") ? [".btn", ".m-close", ".menu-btn", ".copy-btn", ".tabs button"].map((sel) => [sel, cs(sel, "textBoxTrim"), cs(sel, "textBoxEdge")]).filter(([, a, e]) => a !== "trim-both" || !/cap alphabetic/.test(e)) : [],
        adjust: ["code.line", ".in-sample .val", "#sha", ".prose code"].filter((sel) => document.querySelector(sel)).map((sel) => [sel, cs(sel, "fontSizeAdjust")]).filter(([, v]) => !/0\.536/.test(v)),
        line: parseFloat(cs("code.line", "fontSize")), box: r.height / fs, off: Math.round(((i.top + i.height / 2) - (base - CAP * fs / 2)) * 100) / 100 };
    }, [ASC, DESC, CAP]);
    want(c.kern === "normal" && c.optical === "auto", `AH-148 kerning: font-kerning ${c.kern}, font-optical-sizing ${c.optical}`);
    want(!c.tnum.length, `AH-148 tabular figures missing: ${JSON.stringify(c.tnum)}`);
    want(!c.trim.length, `AH-148 labels not trimmed to their capitals: ${JSON.stringify(c.trim)}`);
    want(!c.adjust.length && c.line >= 13, `AH-148 x-height: ${JSON.stringify(c.adjust)}, the PowerShell line at ${c.line} px`);
    want(Math.abs(c.box - (ASC + DESC)) < 0.05 && Math.abs(c.off) <= 1, `AH-148 the download arrow is ${c.off} px off its label's capitals (text box ${c.box.toFixed(3)} em)`);
    console.log(`AH-148 type: the download arrow ${c.off} px from its label's capital middle`);
    await done(t, "AH-148 the type", [API]);
    const q = await open("privacy.html", { width: 1440, height: 900, motion: "reduce" });
    const h2 = await q.page.$eval(".prose h2", (h) => parseFloat(getComputedStyle(h).lineHeight) / parseFloat(getComputedStyle(h).fontSize));
    want(Math.abs(h2 - 1.05) < 0.01, `AH-148 a § heading's leading is ${h2.toFixed(3)}, not 1.05`);
    await done(q, "AH-148 the § headings", [API]);
  }
  // (b) no shift when the font arrives: with it held back 1.5 s the page paints in the fallback first, and the swap moves
  // nothing (the layout shifts summed at most 0.01, at 1440 and 390); and the fallback face is the font's measure: the
  // page's own text set in it is within 2% of its width in Plus Jakarta Sans, at 400 and at 800
  for (const width of [1440, 390]) {
    const t = await open("index.html", { width, height: 900, until: "domcontentloaded",
      init: () => { window.__shift = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value; }).observe({ type: "layout-shift", buffered: true }); },
      setup: (p) => p.route("**/plus-jakarta-sans.woff2", async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); }) });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready); await p.waitForTimeout(600);
    const r = await p.evaluate(() => {
      const fcp = (performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint") || {}).startTime, font = performance.getEntriesByType("resource").find((e) => /plus-jakarta-sans\.woff2$/.test(e.name));
      const text = document.querySelector("main").textContent.replace(/\s+/g, " ");
      const w = (family, weight) => { const s = document.createElement("span"); s.textContent = text; const st = s.style; st.position = "absolute"; st.whiteSpace = "nowrap"; st.visibility = "hidden"; st.font = `${weight} 20px ${family}`;
        document.body.append(s); const x = s.getBoundingClientRect().width; s.remove(); return x; };
      return { shift: window.__shift, fcp, came: font ? font.responseEnd : 0, ratio: [400, 800].map((k) => Math.round((w('"Plus Jakarta Sans Fallback", monospace', k) / w('"Plus Jakarta Sans"', k)) * 1000) / 1000) };
    });
    want(r.fcp < r.came - 500 && r.shift <= 0.01, `AH-148 the font's swap at ${width} px: painted at ${Math.round(r.fcp)} ms, the font came at ${Math.round(r.came)} ms, layout shift ${r.shift.toFixed(4)}`);
    want(r.ratio.every((x) => Math.abs(x - 1) <= 0.02), `AH-148 the fallback face is not the font's measure: the page's text is ${r.ratio} of its width at 400 and 800`);
    await done(t, `AH-148 the font's swap at ${width} px`, [API]);
  }
  // (c) a thumb's target on a phone (390 x 844): every link, button, summary and field outside a run of sentence text is
  // 44 px tall or more (a box ticked through its label is pressed on the label), in the home page's open states too; and
  // the colours the contrast check reads are all rgb() at rest (e2e/contrast.mjs parses rgb() and rgba() only; the OKLCH
  // tints show only on a hover, a turn or a skeleton)
  for (const file of PAGES) {
    const t = await open(file, { width: 390, height: 844, motion: "reduce" });
    const p = t.page;
    for (const state of file === "index.html" ? ["", "open"] : [""]) {
      if (state === "open") { await p.evaluate(() => { document.querySelector(".check-file").open = true; }); await p.click('.rowbtn[aria-controls="m11"]'); }
      const small = await p.evaluate(() => {
        const out = [], blockOf = (e) => { let a = e.parentElement; while (a && /^inline|^contents/.test(getComputedStyle(a).display)) a = a.parentElement; return a; };
        const words = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
        for (const e of document.querySelectorAll("a[href], button, summary, select, input, textarea")) {
          if (!e.getClientRects().length || getComputedStyle(e).visibility !== "visible" || e.closest("[hidden], [aria-hidden=true], .skip-link")) continue;
          const inSentence = e.tagName === "A" && getComputedStyle(e).display === "inline" && !e.closest("header, footer, .notice-bar") && words(blockOf(e)) !== words(e);
          const r = (/^(checkbox|radio)$/.test(e.type) && e.closest("label") || e).getBoundingClientRect();
          if (!inSentence && r.height < 44) out.push(`${e.tagName.toLowerCase()}${e.className ? "." + e.className.split(" ")[0] : ""} "${words(e).slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height * 10) / 10}`);
          if (!inSentence && e.tagName === "BUTTON" && words(e).length <= 1 && r.width < 44) out.push(`button "${words(e)}" ${Math.round(r.width)} px wide`);
        }
        return out;
      });
      for (const s of small) want(false, `AH-148 ${file} at 390 px${state ? " (" + state + ")" : ""}: a target under 44 px, ${s}`);
    }
    await p.mouse.move(1, 1); // at rest: the pointer off the row it opened (a hovered row takes its OKLCH tint)
    const colours = await p.evaluate(() => { const out = new Set(); for (const e of document.querySelectorAll("body *")) { const c = getComputedStyle(e); for (const k of ["color", "backgroundColor", "borderTopColor"]) if (!/^rgba?\(/.test(c[k])) out.add(`${e.tagName.toLowerCase()} ${k} ${c[k]}`); } return [...out].slice(0, 5); });
    want(!colours.length, `AH-148 ${file}: a colour at rest the contrast check cannot read: ${colours}`);
    await done(t, `AH-148 targets on ${file}`, [API]);
  }
  // (d) the measure at 1440: no line of running text holds more than 75 letters (the questions' answers, the steps'
  // aside, the checks' second column, the privacy and terms pages' text and table), counted per rendered line
  for (const [file, sel] of [["index.html", ".faq .a p, .faq .a li, .steps .aside, .checks-table tbody td:not(.in-sample)"], ["privacy.html", ".prose p, .prose li, .card td"], ["terms.html", ".prose p, .prose li"], ["support.html", ".faq .a p, .faq .a li"]]) {
    const t = await open(file, { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    await p.$$eval("details", (ds) => ds.forEach((d) => { d.open = true; }));
    const long = await p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((el) => {
      const lines = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), rg = document.createRange();
      for (let n = walk.nextNode(); n; n = walk.nextNode()) for (let i = 0; i < n.length; i++) {
        rg.setStart(n, i); rg.setEnd(n, i + 1);
        const r = rg.getClientRects()[0];
        if (!r || !r.width) continue;
        const y = r.top + r.height / 2;
        let l = lines.find((x) => Math.abs(x.y - y) < 4);
        if (!l) lines.push((l = { y, n: 0 }));
        l.n++;
      }
      return [Math.max(0, ...lines.map((l) => l.n)), el.textContent.trim().slice(0, 40)];
    }).filter(([n]) => n > 75), sel);
    for (const [n, what] of long) want(false, `AH-148 ${file}: a line of ${n} letters ("${what}...")`);
    await done(t, `AH-148 the measure on ${file}`, [API]);
  }
  // (e) a whole finding's row answers the pointer: hovered, every cell takes the tint, its flagged cells a darker wine (the
  // white figure on it 4.5:1 or more), a row with no finding none; a row a filter leaves out keeps its marks off
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p));
    const look = (row) => p.evaluate((row) => { const x = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
      const rgb = (c) => { x.clearRect(0, 0, 1, 1); x.fillStyle = "#000"; x.fillStyle = c; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data]; };
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      return [...document.querySelectorAll(`${row} > *`)].map((c) => { const s = getComputedStyle(c), bg = rgb(s.backgroundColor), fg = rgb(s.color), [a, b] = [lum(bg), lum(fg)].sort((m, n) => n - m);
        return { flag: c.classList.contains("flag"), bg: bg.join(), ratio: bg[3] ? (a + 0.05) / (b + 0.05) : 0 }; }); }, row);
    const r22 = "#r22", r4 = "#p-found tbody tr:first-child"; // row 4 has no finding
    const rest = await look(r22), plain = await look(r4);
    await p.hover("#r22 td.why"); const on = await look(r22);
    await p.hover("#p-found tbody tr:nth-child(1) td.why"); const plainOn = await look(r4);
    want(on.every((c, i) => c.bg !== rest[i].bg) && on.filter((c) => c.flag).every((c) => c.ratio >= 4.5) && on.some((c) => c.flag), `AH-148 a hovered finding's row: ${JSON.stringify({ rest, on })}`);
    want(JSON.stringify(plainOn) === JSON.stringify(plain), "AH-148 a row with no finding answers the pointer");
    await p.click('.typology button[data-kind="label"]');
    const out = await look(r22); await p.hover("#r22 td.why"); const outOn = await look(r22);
    want(JSON.stringify(outOn.filter((c) => c.flag)) === JSON.stringify(out.filter((c) => c.flag)), `AH-148 a row the filter leaves out took the flagged cells' hover: ${JSON.stringify({ out, outOn })}`);
    await done(t, "AH-148 the row hover", [API]);
    const q = await open("privacy.html", { width: 1440, height: 900, motion: "reduce" });
    await q.page.hover(".toc a"); await q.page.waitForTimeout(50);
    const toc = await q.page.$eval(".toc a", (a) => getComputedStyle(a).textDecorationLine);
    await q.page.mouse.move(1, 1); await q.page.focus(".toc a"); await q.page.keyboard.press("Shift+Tab"); await q.page.keyboard.press("Tab");
    const tocKey = await q.page.evaluate(() => [document.activeElement.matches(".toc a:focus-visible"), getComputedStyle(document.activeElement).textDecorationLine]);
    want(toc === "underline" && tocKey[0] && tocKey[1] === "underline", `AH-148 a contents link hovered (${toc}) or focused (${tocKey}) is not underlined`);
    await done(q, "AH-148 the contents' links", [API]);
  }
  // (f) Copy says Copied at the press: with a clipboard that answers 400 ms later, the label is Copied, the check in, within
  // the frame after the click; with one that refuses 400 ms later, it takes it back to the selected line and Ctrl+C
  for (const refuse of [false, true]) {
    const t = await open("index.html", { width: 1280, init: refuse ? () => { Object.defineProperty(navigator.clipboard, "writeText", { value: () => new Promise((_, no) => setTimeout(() => no(new Error("refused")), 400)) }); }
      : () => { Object.defineProperty(navigator.clipboard, "writeText", { value: () => new Promise((ok) => setTimeout(ok, 400)) }); } });
    const p = t.page, label = `AH-148 Copy with a clipboard that ${refuse ? "refuses" : "answers"} 400 ms later`;
    await p.waitForTimeout(ENTERED);
    await p.click(".check-file summary"); await settle(p, ".check-file");
    const r = await p.evaluate(async () => { const b = document.querySelector(".copy-btn"), say = () => [b.textContent.trim(), b.hasAttribute("data-done")];
      b.click(); await new Promise((ok) => requestAnimationFrame(ok)); const first = say();
      await new Promise((ok) => setTimeout(ok, 700)); return { first, later: say(), picked: getSelection().toString(), line: b.previousElementSibling.textContent }; });
    want(r.first[0] === "Copied" && r.first[1], `${label}: the frame after the click says ${JSON.stringify(r.first)}`);
    if (refuse) want(r.later[0] === "Press Ctrl+C" && !r.later[1] && r.picked === r.line, `${label}: ${JSON.stringify(r)}`);
    else want(r.later[0] === "Copied" && r.later[1], `${label}: ${JSON.stringify(r)}`);
    await done(t, label, [API]);
  }
  // (g) cut short, a popover goes on from where it is: the phone's menu opened, closed at 60 ms and opened again at 100 ms
  // never grows or brightens while it leaves, nor shrinks or fades while it comes back (it jumped back to .95 and see-through
  // and restarted); a row's detail box closed at 80 ms leaves from the pose it had, never from full
  {
    const t = await open("index.html", { width: 375, height: 667 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    const r = await p.evaluate(async () => {
      const b = document.querySelector(".menu-btn"), n = document.getElementById("main-nav"), wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const pose = () => { const c = getComputedStyle(n); return [performance.now(), c.transform === "none" ? 1 : new DOMMatrix(c.transform).a, +c.opacity]; };
      const log = [], ev = {};
      let on = true;
      const look = () => { if (n.getClientRects().length) log.push(pose()); if (on) requestAnimationFrame(look); };
      b.click(); requestAnimationFrame(look);
      await wait(60); ev.close = pose(); b.click();
      await wait(40); ev.open = pose(); b.click();
      await wait(400); on = false;
      return { log, ev, expanded: b.getAttribute("aria-expanded"), rest: pose().slice(1) };
    });
    const leaving = r.log.filter(([at]) => at > r.ev.close[0] && at < r.ev.open[0]), back = r.log.filter(([at]) => at > r.ev.open[0]);
    want(r.ev.close[2] > 0 && r.ev.close[2] < 1 && r.ev.open[2] > 0 && r.ev.open[2] < 1, `AH-148 menu: not cut mid-way (${JSON.stringify(r.ev)})`);
    want(leaving.every(([, s, o]) => s <= r.ev.close[1] + 0.005 && o <= r.ev.close[2] + 0.01), `AH-148 menu closed at 60 ms grew or brightened from ${r.ev.close.slice(1)}: ${leaving.map((x) => x.slice(1).map((v) => v.toFixed(3)).join("/")).join(" ")}`);
    want(back.length > 3 && back.every(([, s, o]) => s >= r.ev.open[1] - 0.005 && o >= r.ev.open[2] - 0.01), `AH-148 menu opened again at 100 ms shrank or faded from ${r.ev.open.slice(1)}: ${back.map((x) => x.slice(1).map((v) => v.toFixed(3)).join("/")).join(" ")}`);
    want(r.expanded === "true" && r.rest.join() === "1,1", `AH-148 menu: at rest ${JSON.stringify(r)}`);
    await done(t, "AH-148 menu cut short", [API]);
  }
  {
    const t = await open("index.html", { width: 1440, height: 900 });
    const p = t.page;
    await p.waitForTimeout(ENTERED);
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p)); await landed(p);
    const r = await p.evaluate(async () => {
      const box = document.getElementById("m22"), wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
      const pose = (el) => { const c = getComputedStyle(el); return [performance.now(), c.transform === "none" ? 1 : new DOMMatrix(c.transform).a, +c.opacity]; };
      document.querySelector('.rowbtn[aria-controls="m22"]').click();
      await wait(80);
      const cut = pose(box), log = [];
      box.querySelector(".m-close").click();
      for (let i = 0; i < 30; i++) { await new Promise((ok) => requestAnimationFrame(ok)); const c = document.querySelector("[data-pop-copy]"); if (c) log.push(pose(c)); }
      return { cut, log, left: document.querySelectorAll("[data-pop-copy]").length };
    });
    want(r.cut[2] > 0 && r.cut[2] < 1, `AH-148 detail box: not cut mid-way (${r.cut})`);
    want(r.log.length > 0 && r.log.every(([, s, o]) => s <= r.cut[1] + 0.005 && o <= r.cut[2] + 0.01) && r.left === 0, `AH-148 detail box closed at 80 ms left from more than its pose ${r.cut.slice(1)}: ${r.log.map((x) => x.slice(1).map((v) => v.toFixed(3)).join("/")).join(" ")} (${r.left} copies left)`);
    await done(t, "AH-148 detail box cut short", [API]);
  }
  // (h) one mark for a link and its row: a checks-table "Row 22" link's glide lands with the link's gold frame round the
  // sample's row 22, opacity only, 600 ms, once, then gone; none under reduced motion (the link jumps)
  for (const motion of ["no-preference", "reduce"]) {
    const t = await open("index.html", { width: 1440, height: 900, motion });
    const p = t.page, label = `AH-148 Row 22's shared mark (${motion})`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate(() => { const a = document.querySelector('.checks-table a.to-row[href="#r22"]'); scrollTo(0, a.getBoundingClientRect().top + scrollY - 400);
      window.__mark = null; document.addEventListener("ah:glide-end", () => { const m = document.querySelector(".row-mark"), a = m && m.getAnimations()[0], r = m && m.getBoundingClientRect(), row = document.getElementById("r22").getBoundingClientRect();
        window.__mark = m && { n: m.getAnimations().length, dur: a ? a.effect.getComputedTiming().duration : 0, runs: a ? a.effect.getComputedTiming().iterations : 0, hidden: m.getAttribute("aria-hidden"),
          props: a ? [...new Set(a.effect.getKeyframes().flatMap((k) => Object.keys(k)))].filter((k) => !["offset", "computedOffset", "easing", "composite"].includes(k)) : [],
          off: [r.left - row.left, r.top - row.top, r.width - row.width, r.height - row.height].map((v) => Math.round(v)) }; }); });
    await p.waitForTimeout(motion === "reduce" ? 0 : 1600);
    await p.click('.checks-table a.to-row[href="#r22"]');
    await p.waitForFunction(() => location.hash === "#r22", null, { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(900);
    const r = await p.evaluate(() => ({ at: window.__mark, after: [...document.querySelectorAll(".row-mark")].map((m) => [getComputedStyle(m).opacity, m.getAnimations().length]) }));
    if (motion === "reduce") want(!r.at && r.after.every(([o, n]) => o === "0" && n === 0), `${label}: ${JSON.stringify(r)}`);
    else want(r.at && r.at.n === 1 && r.at.dur === 600 && r.at.runs === 1 && r.at.hidden === "true" && r.at.props.join() === "opacity" && r.at.off.every((v) => Math.abs(v) <= 2) && r.after.length === 1 && r.after[0].join() === "0,0", `${label}: ${JSON.stringify(r)}`);
    await done(t, label, [API]);
  }
  // ... and pointed at or focused while the row is on screen (a screen tall enough for both), the same frame shows round
  // the row until the pointer or focus leaves; with the row off screen, nothing
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page, link = '.checks-table a.to-row[href="#r22"]';
    const mark = () => p.evaluate(() => { const m = document.querySelector(".row-mark[data-on]"), row = document.getElementById("r22").getBoundingClientRect(), r = m && m.getBoundingClientRect(); return m ? [r.left - row.left, r.top - row.top, r.width - row.width, r.height - row.height].map(Math.round) : null; });
    await p.evaluate((sel) => scrollTo(0, document.querySelector(sel).getBoundingClientRect().top + scrollY - 400), link);
    await p.hover(link); const off = await mark();
    const tall = await p.evaluate((sel) => Math.ceil(document.querySelector(sel).getBoundingClientRect().bottom + scrollY + 40), link);
    await p.setViewportSize({ width: 1440, height: tall }); await p.evaluate(() => scrollTo(0, 0)); await p.mouse.move(1, 1);
    await p.hover(link); const on = await mark();
    await p.hover("h1"); const gone = await mark();
    await p.focus(link); const focused = await mark();
    await p.evaluate(() => document.activeElement.blur()); const blurred = await mark();
    want(off === null && on && on.every((v) => Math.abs(v) <= 2) && gone === null && focused && blurred === null, `AH-148 Row 22 pointed at: off screen ${JSON.stringify(off)}, on screen ${JSON.stringify(on)}, left ${JSON.stringify(gone)}, focused ${JSON.stringify(focused)}, blurred ${JSON.stringify(blurred)}`);
    await done(t, "AH-148 Row 22 pointed at", [API]);
  }
  // (i) figures that count: the proof strip's count up once as they rise (199 of 201 from "  0 of 201", the rest of the
  // line still), each ending on exactly the page's text, which stays in the page every frame, the counting figure drawn
  // with an empty alternative text; a filter's count ticks to its new value over 250 ms when a tab changes it, its text
  // the new value at once; none of it under reduced motion
  for (const motion of ["no-preference", "reduce"]) {
    const t = await open("index.html", { width: 1440, height: 900, motion });
    const p = t.page, label = `AH-148 counting figures (${motion})`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    const finals = await p.$$eval(".proof dt", (ds) => ds.map((d) => d.textContent));
    await p.evaluate(() => { window.__dt = []; window.__alt = ""; const ds = [...document.querySelectorAll(".proof dt")];
      const look = () => { window.__dt.push(ds.map((d) => [d.textContent, d.getAttribute("data-tick")])); const k = ds.find((d) => d.hasAttribute("data-tick")); if (k && !window.__alt) window.__alt = getComputedStyle(k, "::before").content;
        if (window.__dt.length < 150) requestAnimationFrame(look); }; requestAnimationFrame(look);
      scrollTo(0, document.querySelector(".proof").getBoundingClientRect().top + scrollY - 300); });
    await p.waitForFunction(() => window.__dt.length >= 150, null, { timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(500);
    const r = await p.evaluate(() => ({ frames: window.__dt, alt: window.__alt, end: [...document.querySelectorAll(".proof dt")].map((d) => [d.textContent, d.getAttribute("data-tick")]) }));
    const ticks = (i) => r.frames.map((f) => f[i][1]).filter(Boolean);
    want(r.frames.every((f) => f.every(([text], i) => text === finals[i])) && JSON.stringify(r.end) === JSON.stringify(finals.map((x) => [x, null])), `${label}: the proof's text changed or did not end as the page's`);
    if (motion === "reduce") want(finals.every((_, i) => !ticks(i).length), `${label}: it counted`);
    else {
      const big = ticks(1);
      want(big.some((x) => /^[ \d]{3} of 201$/.test(x) && parseInt(x.replace(/ /g, ""), 10) < 199) && big.every((x) => x.length === finals[1].length && x.endsWith(" of 201")) && !ticks(2).length && !ticks(3).length,
        `${label}: 199 of 201 counted ${JSON.stringify([...new Set(big)].slice(0, 12))}, 0 ${JSON.stringify(ticks(2).slice(0, 3))}`);
      want(/\/\s*""/.test(r.alt), `${label}: the counting figure has a text a screen reader reads (${r.alt})`);
    }
    await p.evaluate((y) => scrollTo(0, y), await frameAt(p)); await landed(p);
    const c = await p.evaluate(async () => { const n = document.querySelector(".typology .n"), seen = []; let on = true;
      const look = () => { seen.push(n.getAttribute("data-tick")); if (on) requestAnimationFrame(look); };
      document.getElementById("t-clean").click(); const text = n.textContent; requestAnimationFrame(look);
      await new Promise((ok) => setTimeout(ok, 450)); on = false; return { text, seen, end: [n.textContent, n.getAttribute("data-tick")] }; });
    if (motion === "reduce") want(c.text === "4" && c.seen.every((x) => x === null), `${label}: a filter's count ${JSON.stringify(c)}`);
    else want(c.text === "4" && c.seen.some((x) => x === "6" || x === "5") && c.end.join() === "4,", `${label}: a filter's count ${JSON.stringify(c)}`);
    await done(t, label, [API]);
  }
  assert.deepEqual(miss, [], `AH-148:\n${miss.join("\n")}`);
  console.log("AH-148: kerning, tabular figures, trimmed labels, code at the x-height; no shift when the font arrives; 44 px targets on a phone; lines of 75 letters at most; the whole row answers the pointer; Copy at the press; a menu and a box cut short go on from where they are; Row 22 and its link share one mark; figures count to their values");
}
// ---- AH-148 fix round 1, a blind design review, as drawn: the case studies' cards ended 476, 446 and 561 px down; the
// questions were a table with an "Open" box a row and an empty column beside a taller form; on a 390 px phone the
// sample's Finding sat past the screen's edge, a swipe away ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    const bottoms = await p.$$eval(".cases .case", (cs) => cs.map((c) => Math.round(c.getBoundingClientRect().bottom * 10) / 10));
    want(bottoms.length === 3 && Math.max(...bottoms) - Math.min(...bottoms) <= 1, `the case studies' cards end at ${bottoms} px, not on one line`);
    // the questions: each a full-width row whose marker is a drawn chevron (no word) that turns as it opens, its answer
    // under it
    const q = await p.evaluate(() => {
      const d = document.querySelector("#faq details"), s = d.querySelector("summary"), faq = d.closest(".faq"), mark = () => getComputedStyle(s, "::after");
      const shut = [mark().content, mark().transform];
      d.open = true;
      return { shut, open: mark().transform, wide: Math.round(s.getBoundingClientRect().width - faq.clientWidth), below: d.querySelector(".a").getBoundingClientRect().top >= s.getBoundingClientRect().bottom - 1,
        head: !!faq.querySelector(".faq-head"), height: s.getBoundingClientRect().height };
    });
    want(q.shut[0] === '""' && q.shut[1] !== "none" && q.open !== q.shut[1] && q.wide === 0 && q.below && !q.head && q.height >= 44, `a question is not a full-width row with a chevron that turns: ${JSON.stringify(q)}`);
    // ... and the form, twice their height, no longer stands beside an empty column: it starts at the section's top, and
    // with every question shut the space under them beside it is under a third of its height (404 of 758 px before)
    await p.evaluate(() => document.querySelectorAll("#faq details").forEach((d) => { d.open = false; }));
    const at = await p.evaluate(() => { const f = document.querySelector("#faq .faq").getBoundingClientRect(), c = document.getElementById("contact").getBoundingClientRect(), h = document.getElementById("faq-title").getBoundingClientRect();
      return { under: Math.round(c.bottom - f.bottom), form: Math.round(c.height), top: Math.round(c.top - h.top) }; });
    want(at.under < at.form / 3 && Math.abs(at.top) <= 24, `an empty column stands beside the form: ${JSON.stringify(at)}`);
    await done(t, "AH-148 fix round 1 at 1440", [API]);
  }
  // row 11's Finding on a 390 px phone: its words inside the screen and inside the table's scrolling box, no swipe
  {
    const t = await open("index.html", { width: 390, height: 844, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    await p.evaluate(() => scrollTo(0, document.getElementById("r11").getBoundingClientRect().top + scrollY - 300));
    const r = await p.evaluate(() => { const td = document.querySelector("#r11 td.why"), rg = document.createRange(), box = td.closest(".scroll").getBoundingClientRect();
      rg.selectNodeContents(td); const w = rg.getBoundingClientRect(), at = document.elementFromPoint(w.left + 2, w.top + w.height / 2);
      return { text: td.textContent.trim(), words: [w.left, w.right, w.top, w.bottom].map(Math.round), box: [box.left, box.right].map(Math.round), screen: [innerWidth, innerHeight], seen: !!at && td.contains(at) }; });
    want(r.words[0] >= 0 && r.words[1] <= r.screen[0] && r.words[2] >= 0 && r.words[3] <= r.screen[1] && r.words[0] >= r.box[0] && r.words[1] <= r.box[1] && r.seen,
      `row 11's Finding at 390 px is off screen or under another cell: ${JSON.stringify(r)}`);
    await done(t, "AH-148 fix round 1 at 390", [API]);
  }
  assert.deepEqual(miss, [], `AH-148 fix round 1:\n${miss.join("\n")}`);
  console.log("AH-148 fix round 1: the case cards end on one line; each question a full-width row with a turning chevron, the form beside the heading; row 11's Finding on a 390 px phone's screen");
}
// ---- AH-148 fix round 2, a second blind design review: row 22's detail box lay on its flagged cells at 1440 px and
// opened above a phone's screen; at 390 px the pinned Finding cut Region to "Ce" and pushed the flagged cells a swipe
// away; "Want to check the file first?" had no sign it opens; the privacy summary's values lost their column heads on a
// phone; the download bar came back over code signing and the footer; the checksum left "e85c2d" alone on a line and
// "SHA-256" broke at its hyphen; and After fixes changed the sheet's height and columns, moving "See every check" ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  // 1. a row's detail box never covers its row's flagged cells, and its head is on screen when it opens
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const t = await open("index.html", { width, height, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    for (const m of ["m22", "m11"]) {
      await p.click(`.rowbtn[aria-controls="${m}"]`);
      const r = await p.evaluate((m) => { const box = document.getElementById(m), b = box.getBoundingClientRect(), h = box.querySelector(".m-head").getBoundingClientRect();
        const cells = [...document.querySelector(`[aria-controls="${m}"]`).closest("tr").querySelectorAll("td.flag, td.q")].map((c) => c.getBoundingClientRect());
        return { open: !box.hidden, covers: cells.filter((c) => c.left < b.right - 0.5 && c.right > b.left + 0.5 && c.top < b.bottom - 0.5 && c.bottom > b.top + 0.5).length,
          head: [h.top, h.bottom].map(Math.round), screen: innerHeight, box: [b.left, b.top, b.right, b.bottom].map(Math.round) }; }, m);
      want(r.open && r.covers === 0, `${m} at ${width} x ${height}: the detail box covers ${r.covers} of its row's flagged cells ${JSON.stringify(r)}`);
      want(r.head[0] >= 0 && r.head[1] <= r.screen, `${m} at ${width} x ${height}: the detail box's head is off screen ${JSON.stringify(r)}`);
      await p.keyboard.press("Escape");
    }
    await done(t, `AH-148 fix round 2 detail boxes at ${width}`, [API]);
  }
  // 3. the phone's sample at rest: (a) no cell's text cut by the screen, the box or a pinned cell, (b) row 11's Finding
  // whole, (c) row 11's flagged cells on screen, no swipe
  {
    const t = await open("index.html", { width: 390, height: 844, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    await p.evaluate(() => scrollTo(0, document.getElementById("r11").getBoundingClientRect().top + scrollY - 300));
    const r = await p.evaluate(() => {
      const sc = document.querySelector("#p-found .scroll"), box = sc.getBoundingClientRect(), pin = sc.querySelector("thead th").getBoundingClientRect().right;
      const whole = (b, from) => b.left >= from - 0.5 && b.right <= Math.min(box.right, innerWidth) + 0.5;
      const cut = [];
      for (const el of sc.querySelectorAll("th, td")) {
        if (!el.getClientRects().length || el.closest("thead") && el === el.parentElement.lastElementChild) continue; // the Finding's unseen head
        const rg = document.createRange(); rg.selectNodeContents(el);
        const b = rg.getBoundingClientRect(), pinned = getComputedStyle(el).position === "sticky" && el.getBoundingClientRect().left < pin;
        if (!b.width) continue;
        const from = pinned ? box.left : pin, seen = b.right > from + 0.5 && b.left < box.right - 0.5;
        if (seen && !whole(b, from)) cut.push(`${el.closest("tr").id || el.closest("tr").rowIndex}:${el.textContent.trim().slice(0, 12)} [${Math.round(b.left)}, ${Math.round(b.right)}]`);
        if (seen && el.scrollWidth > el.clientWidth + 1) cut.push(`${el.textContent.trim().slice(0, 12)} overflows its cell`);
        // ... nor a sliver of a cell showing beside a pinned one (a "⋯" row's one wide cell spans the hidden columns)
        const c = el.getBoundingClientRect();
        if (!pinned && !el.closest("tr.skip") && c.right > from + 0.5 && c.left < box.right - 0.5 && !whole(c, from)) cut.push(`${el.closest("tr").id || el.closest("tr").rowIndex}:${el.textContent.trim().slice(0, 12)} cell [${Math.round(c.left)}, ${Math.round(c.right)}]`);
      }
      const td = document.querySelector("#r11 td.why"), rg = document.createRange(); rg.selectNodeContents(td);
      const w = rg.getBoundingClientRect(), at = document.elementFromPoint(w.left + 2, w.top + w.height / 2);
      const flags = [...document.querySelectorAll("#r11 td.flag")].map((c) => { const b = c.getBoundingClientRect(), hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
        return { text: c.textContent, inside: whole(b, pin) && b.top >= 0 && b.bottom <= innerHeight, hit: !!hit && c.contains(hit) }; });
      return { cut, finding: { words: [w.left, w.right, w.top, w.bottom].map(Math.round), inside: whole(w, pin) && w.top >= 0 && w.bottom <= innerHeight, seen: !!at && td.contains(at) }, flags };
    });
    want(!r.cut.length, `3a the phone's sample cuts or covers cells at rest: ${r.cut.join("; ")}`);
    want(r.finding.inside && r.finding.seen, `3b row 11's Finding at 390 px is not whole on screen: ${JSON.stringify(r.finding)}`);
    want(r.flags.length === 3 && r.flags.every((f) => f.inside && f.hit), `3c row 11's flagged cells at 390 px are not on screen without a swipe: ${JSON.stringify(r.flags)}`);
    await done(t, "AH-148 fix round 2 phone sample", [API]);
  }
  // 4. "Want to check the file first?" wears the questions' chevron, turns it as it opens, and is a 44 px target; the
  // aside's rule beside it reaches the grid's right edge
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    const r = await p.evaluate(() => { const d = document.querySelector(".check-file"), s = d.querySelector("summary"), mark = () => getComputedStyle(s, "::after");
      const shut = [mark().content, mark().transform, mark().borderRightWidth, mark().borderBottomWidth]; d.open = true; const opened = mark().transform; d.open = false;
      const a = document.querySelector(".steps .aside").getBoundingClientRect(), g = document.querySelector(".steps"), gs = getComputedStyle(g);
      return { shut, opened, height: s.getBoundingClientRect().height, aside: Math.round(a.right), grid: Math.round(g.getBoundingClientRect().right - parseFloat(gs.paddingRight)) }; });
    want(r.shut[0] === '""' && r.shut[1] !== "none" && r.shut[2] === "2px" && r.shut[3] === "2px" && r.opened !== r.shut[1] && r.height >= 44, `4 the check-file summary has no drawn chevron that turns: ${JSON.stringify(r)}`);
    want(Math.abs(r.aside - r.grid) <= 1, `4 the aside's rule stops short of the grid's edge: ${JSON.stringify(r)}`);
    await done(t, "AH-148 fix round 2 check-file", [API]);
  }
  // 5. the privacy summary on a phone: each value under its column's head, a label no reader hears twice
  {
    const t = await open("privacy.html", { width: 390, height: 844, motion: "reduce" });
    const p = t.page;
    const heads = await p.$$eval(".card thead th", (ths) => ths.map((th) => th.textContent.trim()));
    const r = await p.$$eval(".card tbody td", (tds) => tds.map((td) => { const b = getComputedStyle(td, "::before"); return { text: td.getAttribute("data-label"), col: td.cellIndex, shown: b.display !== "none" && b.content !== "none" && b.content !== "normal", up: b.textTransform }; }));
    want(r.length === 8 && r.every((x) => x.shown && x.text === heads[x.col]), `5 the privacy summary's values on a phone have no column labels: ${JSON.stringify(r)} vs ${JSON.stringify(heads)}`);
    const said = await p.locator(".card tbody td").first().ariaSnapshot();
    want(!/where it runs/i.test(said), `5 a reader hears the privacy summary's label twice: ${said}`);
    await done(t, "AH-148 fix round 2 privacy labels", [API]);
  }
  // 6. the download bar stays down past the download section: scrolled to the footer it is hidden
  for (const [width, height] of [[390, 844], [1440, 900]]) {
    const t = await open("index.html", { width, height, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => scrollTo(0, document.getElementById("checks").offsetTop)); await p.waitForTimeout(400);
    const mid = await p.evaluate(() => document.getElementById("dock").hidden);
    await p.evaluate(() => document.getElementById("code-signing").scrollIntoView()); await p.waitForTimeout(400);
    const signing = await p.evaluate(() => document.getElementById("dock").hidden);
    await p.evaluate(() => scrollTo(0, document.documentElement.scrollHeight)); await p.waitForTimeout(400);
    const foot = await p.evaluate(() => { const d = document.getElementById("dock"); return { hidden: d.hidden, drawn: d.getClientRects().length > 0 }; });
    want(foot.hidden && !foot.drawn && signing, `6 the download bar at ${width} px shows past the download section: ${JSON.stringify({ signing, foot })}`);
    if (width <= 760) want(!mid, `6 the download bar at ${width} px no longer shows between the hero and the download`);
    await done(t, `AH-148 fix round 2 dock at ${width}`, [API]);
  }
  // 7. the checksum in two even halves (four on a phone), copied whole; SHA-256 on one line wherever it is written; "See every check" and
  // the sheet's columns the same on every tab
  for (const [width, size] of [[1440, "100%"], [390, "100%"], [320, "200%"]]) {
    const t = await open("index.html", { width, height: 900, motion: "reduce" });
    const p = t.page;
    await p.evaluate((size) => { document.documentElement.style.fontSize = size; document.querySelector(".check-file").open = true; }, size);
    const r = await p.evaluate(() => { const c = document.getElementById("sha"), rg = document.createRange(); rg.selectNodeContents(c);
      const lines = [...rg.getClientRects()].filter((x) => x.width > 1).map((x) => Math.round(x.width));
      getSelection().removeAllRanges(); getSelection().addRange(rg); const copied = getSelection().toString(); getSelection().removeAllRanges();
      return { lines, copied, sha: [...document.querySelectorAll(".nb")].filter((e) => e.textContent === "SHA-256").map((e) => e.getClientRects().length) }; });
    if (size === "100%") want(r.lines.length === (width > 760 ? 2 : 4) && r.lines.every((w) => Math.abs(w - r.lines[0]) <= 1), `7 the checksum at ${width} px is not ${width > 760 ? "two" : "four"} even lines: ${JSON.stringify(r.lines)}`);
    want(r.copied === "ab".repeat(32), `7 the checksum at ${width} px copies as ${JSON.stringify(r.copied)}`);
    want(r.sha.length === 2 && r.sha.every((n) => n === 1), `7 "SHA-256" at ${width} px (${size}) breaks over lines: ${JSON.stringify(r.sha)}`);
    await done(t, `AH-148 fix round 2 checksum at ${width}`, [API]);
  }
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const t = await open("index.html", { width, height, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    const at = () => p.evaluate(() => ({ next: Math.round((document.querySelector(".next-up a").getBoundingClientRect().top + scrollY) * 10) / 10,
      cols: [...document.querySelectorAll(".ws-main > .panel:not([hidden]) .grid thead th")].map((th) => Math.round(th.getBoundingClientRect().width * 10) / 10) }));
    const seen = {};
    for (const tab of ["found", "clean", "busy", "found"]) { await p.click(`#t-${tab}`); seen[tab] = await at(); if (tab === "busy") await p.click("#t-found"); }
    // on a wide screen only: on a phone each tab is its own height (AH-148 final pass: held at After fixes', the findings
    // ended 150 px above their caption), and a pressed tab brings its panel on screen instead
    if (width > 760) want(seen.clean.next === seen.found.next && seen.busy.next === seen.found.next, `7 "See every check" moves between tabs at ${width} px: ${JSON.stringify(seen)}`);
    want(JSON.stringify(seen.clean.cols) === JSON.stringify(seen.found.cols), `7 the sheet's columns change between Findings and After fixes at ${width} px: ${JSON.stringify(seen)}`);
    // ... and on a wide screen the verdict and its note, in the filters' column, lie under the key, never over it
    await p.click("#t-clean");
    const sum = await p.evaluate(() => { const k = document.querySelector(".typology .key").getBoundingClientRect(), s = document.querySelector(".clean-sum"), n = document.querySelector(".typology").getBoundingClientRect();
      const c = s ? s.getBoundingClientRect() : { top: -1, left: -1, right: -1, bottom: 1e9 };
      return { key: k.bottom, top: c.top, inside: c.left >= n.left - 0.5 && c.right <= n.right + 0.5 && c.bottom <= n.bottom + 0.5, wide: innerWidth > 1100 }; });
    if (sum.wide) want(sum.top >= sum.key && sum.inside, `7 the verdict and its note at ${width} px lie over the key or outside the filters' column: ${JSON.stringify(sum)}`);
    await done(t, `AH-148 fix round 2 tabs at ${width}`, [API]);
  }
  assert.deepEqual(miss, [], `AH-148 fix round 2:\n${miss.join("\n")}`);
  console.log("AH-148 fix round 2: a detail box beside or off its row's flagged cells with its head on screen (1440 and 390); the phone's sample whole at rest, row 11's Finding and flagged cells on screen; the check-file chevron and the aside's rule; the privacy summary's labels on a phone, heard once; the download bar down past the download; the checksum in two even halves, copied whole, SHA-256 unbroken; one height and one set of columns across the tabs");
}
// ---- AH-148 final pass, a third blind design review: on a phone an empty band of about 150 px sat under the sample's
// last row (every tab held at After fixes' height); a checks-table "Row 31" landed on a phone with its flagged cell a
// swipe away; the swipe hint showed on tabs with nothing to swipe, and a phone's tab changed what lay below the fold;
// "170.43 ÷ 2.99" broke over two lines in a detail box; "All findings 7" beside types adding to 10 said nothing of rows
// flagged twice; the case studies' cards had a hole mid-card; the support page's footer left "Source" alone on a line ----
{
  const miss = [];
  const want = (ok, what) => { if (!ok) miss.push(what); };
  // 1. a phone's Findings end where their last row ends: the caption under 40 px below it
  {
    const t = await open("index.html", { width: 390, height: 844, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    const gap = await p.evaluate(() => { const rows = [...document.querySelectorAll("#p-found .grid tbody tr")].filter((tr) => tr.getClientRects().length);
      return Math.round(document.getElementById("ws-cap").getBoundingClientRect().top - rows[rows.length - 1].getBoundingClientRect().bottom); });
    want(gap < 40, `1 at 390 px the sample's last row ends ${gap} px above its caption`);
    await done(t, "AH-148 final pass phone sample's height", [API]);
  }
  // 3. a checks-table "Row 31" lands with the row's flagged Region cell in view, inside the table's scrolling box beside
  // the pinned Row number, on a phone too (its table starts scrolled to its end); the row's gold mark shows on landing
  for (const [width, height, motion] of [[1440, 900, "no-preference"], [390, 844, "no-preference"], [390, 844, "reduce"]]) {
    const t = await open("index.html", { width, height, motion });
    const p = t.page, label = `3 Row 31 at ${width} px (${motion})`;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate(() => { const a = document.querySelector('.checks-table a.to-row[href="#r31"]'); scrollTo(0, a.getBoundingClientRect().top + scrollY - 300);
      window.__landed = null; document.addEventListener("ah:glide-end", () => setTimeout(() => { const m = document.querySelector(".row-mark"), r = m && m.getBoundingClientRect(), row = document.getElementById("r31").getBoundingClientRect();
        window.__landed = m ? { o: +getComputedStyle(m).opacity, top: Math.round(r.top - row.top), h: Math.round(r.height - row.height) } : null; }, 150)); });
    await p.waitForTimeout(motion === "reduce" ? 0 : 1600);
    await p.click('.checks-table a.to-row[href="#r31"]');
    await p.waitForFunction(() => location.hash === "#r31", null, { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(900);
    const r = await p.evaluate(() => { const td = document.querySelector("#r31 :is(td.flag, td.q)"), b = td.getBoundingClientRect(), sc = td.closest(".scroll"), s = sc.getBoundingClientRect(), pin = document.querySelector("#r31 > :first-child").getBoundingClientRect().right;
      return { cell: [b.left, b.right, b.top, b.bottom].map(Math.round), box: [Math.round(pin), Math.round(s.right)], text: td.textContent, screen: [innerWidth, innerHeight], landed: window.__landed }; });
    const [l, rt, tp, bt] = r.cell;
    want(l >= r.box[0] - 0.5 && rt <= r.box[1] + 0.5 && l >= 0 && rt <= r.screen[0] && tp >= 0 && bt <= r.screen[1], `${label}: row 31's flagged cell is not in view: ${JSON.stringify(r)}`);
    if (motion !== "reduce") want(r.landed && r.landed.o > 0.5 && Math.abs(r.landed.top) <= 2 && Math.abs(r.landed.h) <= 2, `${label}: row 31 carries no gold mark on landing: ${JSON.stringify(r.landed)}`);
    await done(t, `AH-148 final pass ${label}`, [API]);
  }
  // 4. the swipe hint only where there is a table to swipe, and a phone's tab brings its panel's top on screen
  for (const motion of ["reduce", "no-preference"]) {
    const t = await open("index.html", { width: 390, height: 844, motion });
    const p = t.page;
    if (motion !== "reduce") await p.waitForTimeout(ENTERED);
    await p.evaluate(() => scrollTo(0, document.querySelector(".tabs").getBoundingClientRect().bottom + scrollY - innerHeight + 60));
    await p.waitForTimeout(motion === "reduce" ? 50 : 1500);
    const drawn = () => p.evaluate(() => { const s = document.querySelector(".swipe"); return !!s && s.getClientRects().length > 0 && getComputedStyle(s).visibility === "visible"; });
    const found = await drawn();
    await p.click("#t-busy");
    await p.waitForTimeout(motion === "reduce" ? 50 : 1000);
    const busy = await drawn(), top = await p.evaluate(() => Math.round(document.getElementById("p-busy").getBoundingClientRect().top));
    await p.click("#t-clean"); await p.waitForTimeout(motion === "reduce" ? 50 : 1000);
    const clean = await drawn();
    if (motion === "reduce") want(found && !busy && !clean, `4 the swipe hint: on Findings ${found}, on Scanning ${busy}, on After fixes ${clean}`);
    want(top >= 0 && top < 844 - 100, `4 at 390 px (${motion}) Scanning's panel starts at ${top} px, off screen`);
    await done(t, `AH-148 final pass phone tabs (${motion})`, [API]);
  }
  // 5. an expression in a detail box ("170.43 ÷ 2.99", "-5 × 2.99 = -14.95") stays on one line
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const t = await open("index.html", { width, height, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    for (const m of ["m11", "m22"]) {
      await p.click(`.rowbtn[aria-controls="${m}"]`);
      const split = await p.evaluate((m) => { const out = [], walk = document.createTreeWalker(document.getElementById(m), NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) for (const x of n.textContent.matchAll(/-?\d[\d.]*(?: [×÷=] -?\d[\d.]*)+/g)) {
          const rg = document.createRange(); rg.setStart(n, x.index); rg.setEnd(n, x.index + x[0].length);
          out.push([x[0], new Set([...rg.getClientRects()].filter((r) => r.width > 0.5).map((r) => Math.round(r.top))).size]); }
        return out; }, m);
      want(split.length >= 2 && split.every(([, n]) => n === 1), `5 ${m} at ${width} px breaks an expression over lines: ${JSON.stringify(split)}`);
      await p.keyboard.press("Escape");
    }
    await done(t, `AH-148 final pass formulas at ${width}`, [API]);
  }
  // 6. under the filters, one line says a row can be counted by more than one type (All findings 7, the types 10)
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    const r = await p.evaluate(() => { const el = [...document.querySelectorAll(".typology *")].find((e) => e.children.length === 0 && /^A row can be flagged by more than one type\.$/.test(e.textContent.trim()));
      const b = el && el.getBoundingClientRect(), last = [...document.querySelectorAll(".typology button")].pop().getBoundingClientRect();
      return el ? { drawn: b.width > 0 && b.height > 0 && getComputedStyle(el).visibility === "visible", under: b.top >= last.bottom - 0.5 } : null; });
    want(r && r.drawn && r.under, `6 no line under the filters says a row can be flagged by more than one type: ${JSON.stringify(r)}`);
    await done(t, "AH-148 final pass filters' line", [API]);
  }
  // 7. the case studies' cards: no hole between their blocks' text (each under 40 px from the one before)
  {
    const t = await open("index.html", { width: 1440, height: 900, motion: "reduce" });
    const p = t.page;
    await p.evaluate(() => document.fonts.ready);
    // measured on the text, not on a block's box, which a grid row stretched
    const gaps = await p.$$eval(".cases .case", (cs) => cs.map((c) => { const k = [...c.children].map((e) => { const rg = document.createRange(); rg.selectNodeContents(e); return rg.getBoundingClientRect(); }); return k.slice(1).map((b, i) => Math.round(b.top - k[i].bottom)); }));
    want(gaps.length === 3 && gaps.every((g) => g.every((x) => x < 40)), `7 a case study's card has a hole between its blocks: ${JSON.stringify(gaps)}`);
    await done(t, "AH-148 final pass case cards", [API]);
  }
  // 8. a footer link never sits alone on its line while the others share one, on every page at 1440 and 1280
  for (const file of [...PAGES, MISSING]) {
    for (const width of [1440, 1280]) {
      const t = await open(file, { width, height: 900, motion: "reduce" });
      const rows = await t.page.$$eval(".foot nav a", (as) => { const by = {}; for (const a of as) { const k = Math.round(a.getBoundingClientRect().top); (by[k] = by[k] || []).push(a.textContent.trim()); } return Object.values(by); });
      want(rows.length === 1 || rows.every((r) => r.length > 1), `8 ${file} at ${width} px leaves a footer link alone on a line: ${JSON.stringify(rows)}`);
      await done(t, `AH-148 final pass footer ${file} at ${width}`, [API]);
    }
  }
  assert.deepEqual(miss, [], `AH-148 final pass:\n${miss.join("\n")}`);
  console.log("AH-148 final pass: a phone's findings end at their last row; Row 31 lands with its flagged cell in view and its gold mark; the swipe hint only on Findings and a phone's tab shows its panel; expressions whole in a detail box; a line under the filters on rows flagged twice; no hole in a case card; no footer link alone on a line");
}
await browser.close();
server.close();
console.log("website browser check passed");
