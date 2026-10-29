// Launch checks on the REAL pane served by the engine, in Chromium with fake-office.js standing in for Excel:
// load time, no sideways scroll at task-pane widths, the main button above the fold, every image and control named.
// Run by e2e/all.sh (which starts the engine on :5055), or alone against a running engine: cd e2e && node launch.mjs
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { trustArgs } from "./trust.mjs";
const pw = await import(process.env.PLAYWRIGHT || "playwright")
  .catch(() => import(pathToFileURL(createRequire(import.meta.url).resolve("playwright", { paths: [process.env.NODE_PATH || ""] })).href));
const { chromium } = pw.chromium ? pw : pw.default;
const DIR = fileURLToPath(new URL(".", import.meta.url));
const ok = (c, m) => { if (!c) { console.error("FAIL:", m); process.exitCode = 1; } else console.log("ok -", m); };

const args = trustArgs(DIR);
const browser = await chromium.launch({ args }).catch(() => chromium.launch({ channel: "msedge", args }));
for (const width of [320, 360, 500]) { // Office's task pane: 320 px at its narrowest
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // a console error names the file that failed: "Failed to load resource: net::ERR_TOO_MANY_RETRIES" came 4 times on
  // 23 Oct with no name, under other test runs' load, and never on a quiet rerun (AH-43)
  page.on("console", (m) => m.type() === "error" && errors.push(m.location().url ? `${m.text()} (${m.location().url})` : m.text()));
  // every unhandled promise rejection and uncaught error, heard by the page itself before any of the pane's scripts run,
  // as in run.mjs (AH-58)
  await page.exposeFunction("__unhandled", (kind, what) => errors.push(`${kind}: ${what}`));
  await page.addInitScript(() => {
    addEventListener("unhandledrejection", (e) => __unhandled("unhandledrejection", String(e.reason?.stack || e.reason)));
    addEventListener("error", (e) => __unhandled("error", String(e.error?.stack || e.message)));
  });
  await page.route("https://appsforoffice.microsoft.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(DIR + "fake-office.js", "utf8") }));
  const t0 = Date.now();
  await page.goto("https://127.0.0.1:5055/taskpane.html");
  await page.evaluate(() => __load("Sales", [["Item", "Units"], ["Pen", 5], ["Pad", 7]], []));
  await page.waitForSelector("#main-ui", { state: "visible" });
  const ready = Date.now() - t0;
  const m = await page.evaluate(() => {
    const scan = document.getElementById("scan").getBoundingClientRect();
    const named = (el) => (el.getAttribute("aria-label") || el.textContent || el.getAttribute("title") || "").trim() ||
      el.labels?.length; // <label for=...> or a wrapping <label>, as screen readers see it
    const visible = (el) => el.offsetParent !== null;
    return {
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      scanBottom: scan.bottom, fold: innerHeight,
      noAlt: [...document.images].filter((i) => !i.hasAttribute("alt")).length,
      unnamed: [...document.querySelectorAll("button, input, select, textarea")].filter((e) => visible(e) && !named(e)).map((e) => e.id || e.outerHTML.slice(0, 60)),
      load: Math.round(performance.getEntriesByType("navigation")[0].loadEventEnd),
    };
  });
  ok(ready < 2000, `${width}px: pane ready in ${ready} ms (page load ${m.load} ms), under 2 s`);
  ok(m.sideways <= 0, `${width}px: no sideways scroll (${m.sideways} px)`);
  ok(m.scanBottom <= m.fold, `${width}px: "Find problems" button above the fold (bottom ${Math.round(m.scanBottom)} of ${m.fold} px)`);
  ok(m.noAlt === 0, `${width}px: every image has alt text (${m.noAlt} without)`);
  ok(m.unnamed.length === 0, `${width}px: every visible control has a name - ${m.unnamed}`);
  ok(errors.length === 0, `${width}px: no page errors, unhandled rejections or uncaught errors ${errors}`);
  await page.close();
}
await browser.close();
