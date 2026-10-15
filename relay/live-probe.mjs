// Attack the LIVE relay from outside, the way a stranger would: no invite code, tricks on the path, the method, the
// size and CORS. Every request must be refused before the invite check passes, so none reaches Google or counts
// against the daily caps. A dozen requests, no load. Run: node relay/live-probe.mjs [relay URL] (CI: relay-live.yml)
const R = process.argv[2] || "https://anomaly-hunter-relay.john4000-nguyen.workers.dev";
const J = { "Content-Type": "application/json" };
const fix = JSON.stringify({ messages: [{ role: "user", content: "say hi" }], response_format: { type: "json_object" } });
const big = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(20000) }], response_format: { type: "json_object" } });
const evil = { Origin: "https://evil.example" };

const probes = [
  ["GET / (only POST /fix exists)", "/", { method: "GET" }, 404],
  ["GET /fix", "/fix", { method: "GET" }, 404],
  ["OPTIONS /fix: CORS preflight from a website", "/fix", { method: "OPTIONS", headers: { ...evil, "Access-Control-Request-Method": "POST" } }, 404],
  ["POST /fix/ (path trick)", "/fix/", { method: "POST", headers: J, body: fix }, 404],
  ["POST /FIX (case trick)", "/FIX", { method: "POST", headers: J, body: fix }, 404],
  ["POST /fix?x=../admin, no code", "/fix?x=../admin", { method: "POST", headers: J, body: fix }, 401],
  ["POST /fix, no invite code", "/fix", { method: "POST", headers: J, body: fix }, 401],
  ["POST /fix, empty Bearer", "/fix", { method: "POST", headers: { ...J, Authorization: "Bearer " }, body: fix }, 401],
  ["POST /fix, a guessed invite", "/fix", { method: "POST", headers: { ...J, Authorization: `Bearer inv_${"0".repeat(24)}` }, body: fix }, 401],
  ["POST /fix, a 4 KB junk code", "/fix", { method: "POST", headers: { ...J, Authorization: `Bearer ${"A".repeat(4096)}` }, body: fix }, 401],
  ["POST /fix, 20 KB body, no code", "/fix", { method: "POST", headers: J, body: big }, 401],
  ["POST /fix from a website, fake code", "/fix", { method: "POST", headers: { ...J, ...evil, Authorization: "Bearer inv_fake" }, body: fix }, 401],
];

let pass = 0;
for (const [name, path, init, want] of probes) {
  let line;
  try {
    const r = await fetch(R + path, { ...init, signal: AbortSignal.timeout(20000) });
    const text = (await r.text()).slice(0, 80);
    // refused with OUR JSON (never Google's text), and no website is ever allowed to read the answer (CORS)
    const ours = (() => { try { return typeof JSON.parse(text).error === "string"; } catch { return false; } })();
    const ok = r.status === want && ours && !r.headers.get("access-control-allow-origin");
    pass += ok;
    line = `${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} -> ${r.status} ${text} (CORS: ${r.headers.get("access-control-allow-origin") || "none"})`;
  } catch (e) {
    line = `FAIL  ${name.padEnd(46)} -> ${e.name}: ${e.message}`;
  }
  console.log(line);
}
console.log(`${pass}/${probes.length} refused correctly`);
process.exit(pass === probes.length ? 0 : 1);
