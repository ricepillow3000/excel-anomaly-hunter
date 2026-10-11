// Check the pane inside REAL Excel: CSP header, a click through every feature, zero CSP violations / console errors.
// Re-run after Office or WebView2 updates (Microsoft changes office.js whenever it likes).
// 1. Close Excel. 2. PowerShell: $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9229'; start excel
// 3. Open a workbook with data and open the pane. 4. node e2e/real-excel.mjs   (exit 1 = something is wrong)
// Scans and opens rows like a user; it never accepts a fix, so the workbook is not changed (Remove highlights at the end).
const pane = (await (await fetch("http://127.0.0.1:9229/json")).json()).find((t) => t.url.includes("taskpane.html"));
if (!pane) throw new Error("No Anomaly Hunter pane found - open it in Excel first (Excel started with the debug port).");
const ws = new WebSocket(pane.webSocketDebuggerUrl);
let id = 0, header = "(no document seen)";
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((ok) => { pending.set(++id, ok); ws.send(JSON.stringify({ id, method, params })); });
const run = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data), p = msg.params;
  if (msg.id && pending.has(msg.id)) return pending.get(msg.id)(msg);
  if (msg.method === "Network.responseReceived" && p.type === "Document")
    header = p.response.headers["content-security-policy"] ?? p.response.headers["Content-Security-Policy"] ?? "(none)";
  if (msg.method === "Runtime.exceptionThrown") errors.push(p.exceptionDetails.exception?.description);
  // CSP messages are judged below from the violation events, which say which file caused them
  if (msg.method === "Log.entryAdded" && p.entry.level === "error" && !p.entry.text.includes("Content Security Policy")) errors.push(p.entry.text + (p.entry.url ? " " + p.entry.url : ""));
};
await new Promise((ok) => (ws.onopen = ok));
for (const d of ["Network", "Log", "Runtime", "Page"]) await send(`${d}.enable`);
// listen before any page script runs, so office.js boot-time violations count too
await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__csp = []; document.addEventListener("securitypolicyviolation",
  e => __csp.push({ directive: e.effectiveDirective, file: e.sourceFile, at: e.lineNumber + ":" + e.columnNumber }))` });
await send("Page.reload", { ignoreCache: true });
await new Promise((ok) => setTimeout(ok, 8000));
const steps = (await run(`(async () => {
  const $ = (id) => document.getElementById(id), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = {};
  const until = async (ok, s) => { for (let i = 0; i < s * 4 && !ok(); i++) await sleep(250); return !!ok(); };
  log.loaded = !$("app-body").hidden && !$("main-ui").hidden;
  $("scan").click();
  // rows show before the scan finishes writing highlights; buttons stay off (clicks ignored) until it is done
  const idle = () => !$("scan").disabled;
  log.scan = await until(() => !$("results").hidden && idle(), 60);
  const rows = () => document.querySelectorAll("#flagged-list li button");
  log.rows = rows().length;
  for (let i = 0; i < Math.min(rows().length, 3); i++) {  // open a few rows, back each time
    await until(idle, 30); rows()[i].click();
    log["row" + i] = await until(() => !$("fix-view").hidden, 15);
    await sleep(1500); $("fix-back").click(); await sleep(500);
  }
  await until(idle, 30);
  const start = $("strength-val").textContent, down = !start.startsWith("0 ");  // one step and back: the user's level is kept
  $("strength").dispatchEvent(new KeyboardEvent("keydown", { key: down ? "ArrowLeft" : "ArrowRight", bubbles: true }));
  await sleep(4000);
  $("strength").dispatchEvent(new KeyboardEvent("keydown", { key: down ? "ArrowRight" : "ArrowLeft", bubbles: true }));
  await sleep(4000);
  log.slider = $("strength-val").textContent === start && !$("results").hidden;
  $("settings").open = true; await sleep(300);
  log.settings = $("ai-state").textContent.length > 0;
  $("settings").open = false;
  await until(idle, 30); $("clear-highlights").click(); await sleep(2000);
  return log;
})()`)).result.value;
const csp = (await run("window.__csp")).result.value;
// Known and harmless: office.js parses a store-license token as XML; a catalog add-in has none, so Chromium builds a
// <parsererror> with inline styles in a document that is never shown. Repro: new DOMParser().parseFromString("not xml <", "text/xml")
const microsoft = (v) => v.directive === "style-src-attr" && v.file?.startsWith("https://appsforoffice.microsoft.com/lib/1/hosted/");
const unexpected = csp.filter((v) => !microsoft(v));
const want = "default-src 'self'; script-src 'self' https://appsforoffice.microsoft.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const failed = [
  header !== want && "CSP header on the pane: " + header,
  ...Object.entries(steps).filter(([, v]) => v === false).map(([k]) => "step failed: " + k),
  steps.rows === 0 && "the scan flagged no rows - use a workbook with data problems",
  ...unexpected.map((v) => "CSP violation: " + JSON.stringify(v)),
  ...errors.map((e) => "console error: " + e),
].filter(Boolean);
console.log("steps", JSON.stringify(steps));
console.log(`CSP: header ${header === want ? "ok" : "WRONG"}, ${csp.length - unexpected.length} known office.js violation(s), ${unexpected.length} unexpected`);
console.log(failed.length ? "FAIL\n  " + failed.join("\n  ") : "PASS - the pane works in real Excel under the CSP");
ws.close();
process.exit(failed.length ? 1 : 0);
