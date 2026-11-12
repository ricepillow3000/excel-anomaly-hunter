// Attack the LIVE relay from outside, the way a stranger would: no invite code, tricks on the path, the method, the
// size and CORS. Every request must be refused before the invite check passes, so none reaches Google or counts
// against the daily caps. AH-151: with no Authorization header a request is the public tier, so those probes send a
// body the relay refuses before it counts (a fix-shaped one would reach Google and spend a free call).
// 13 requests, no load. Run: node relay/live-probe.mjs [relay URL] (CI: relay-live.yml)
// Then one real call that must work, with no invite through the public tier (AH-162), and with RELAY_CANARY_INVITE
// set, one more with that invite (canary.mjs, AH-108).
import { canary } from "./canary.mjs";

const R = process.argv[2] || "https://anomaly-hunter-relay.john4000-nguyen.workers.dev";
const J = { "Content-Type": "application/json" };
const fix = JSON.stringify({ messages: [{ role: "user", content: "say hi" }], response_format: { type: "json_object" } });
const shapeless = JSON.stringify({ messages: [{ role: "user", content: "say hi" }] }); // no response_format
const big = JSON.stringify({ messages: [{ role: "user", content: "x".repeat(20000) }], response_format: { type: "json_object" } });
const evil = { Origin: "https://evil.example" };
// AH-160: any answer format but a json_schema is refused before the counter (a relay from before AH-160 sent it to
// Google: a 200 here means the deploy is old)
const text = JSON.stringify({ messages: [{ role: "user", content: "say hi" }], response_format: { type: "text" } });

const probes = [
  ["GET / (only POST /fix exists)", "/", { method: "GET" }, 404],
  ["GET /fix", "/fix", { method: "GET" }, 404],
  ["OPTIONS /fix: CORS preflight from a website", "/fix", { method: "OPTIONS", headers: { ...evil, "Access-Control-Request-Method": "POST" } }, 404],
  ["POST /fix/ (path trick)", "/fix/", { method: "POST", headers: J, body: fix }, 404],
  ["POST /FIX (case trick)", "/FIX", { method: "POST", headers: J, body: fix }, 404],
  ["POST /fix?x=../admin, no code, bad shape", "/fix?x=../admin", { method: "POST", headers: J, body: shapeless }, 400],
  ["POST /fix, no code, not JSON", "/fix", { method: "POST", headers: J, body: "{not json" }, 400],
  ["POST /fix, empty Bearer", "/fix", { method: "POST", headers: { ...J, Authorization: "Bearer " }, body: fix }, 401],
  ["POST /fix, a guessed invite", "/fix", { method: "POST", headers: { ...J, Authorization: `Bearer inv_${"0".repeat(24)}` }, body: fix }, 401],
  ["POST /fix, a 4 KB junk code", "/fix", { method: "POST", headers: { ...J, Authorization: `Bearer ${"A".repeat(4096)}` }, body: fix }, 401],
  ["POST /fix, 20 KB body, no code", "/fix", { method: "POST", headers: J, body: big }, 413],
  ["POST /fix, no code, a text answer format", "/fix", { method: "POST", headers: J, body: text }, 400],
  ["POST /fix from a website, fake code", "/fix", { method: "POST", headers: { ...J, ...evil, Authorization: "Bearer inv_fake" }, body: fix }, 401],
];

let pass = 0;
for (const [name, path, init, want] of probes) {
  let line;
  try {
    const r = await fetch(R + path, { ...init, signal: AbortSignal.timeout(20000) });
    const body = await r.text(), text = body.slice(0, 80);
    // refused with OUR JSON (never Google's text), and no website is ever allowed to read the answer (CORS); read whole:
    // the public tier's words are longer than 80 characters, and a cut body never parses (AH-151 probe, 2026-11-10)
    const ours = (() => { try { return typeof JSON.parse(body).error === "string"; } catch { return false; } })();
    const ok = r.status === want && ours && !r.headers.get("access-control-allow-origin");
    pass += ok;
    line = `${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} -> ${r.status} ${text} (CORS: ${r.headers.get("access-control-allow-origin") || "none"})`;
  } catch (e) {
    line = `FAIL  ${name.padEnd(46)} -> ${e.name}: ${e.message}`;
  }
  console.log(line);
}
console.log(`${pass}/${probes.length} refused correctly`);

// AH-162: the public tier's call runs every day; refusals alone never show a revoked key or a retired model
const pub = await canary(R, "");
console.log(pub.line);
let alive = pub.ok;
const invite = process.env.RELAY_CANARY_INVITE;
if (!invite) {
  console.log("The invite canary is optional: to turn it on, make an invite named canary (node relay/new-invite.mjs " +
    "canary, upload tokens.json) and save its code as the repository secret RELAY_CANARY_INVITE.");
} else {
  const c = await canary(R, invite);
  console.log(c.line);
  alive = alive && c.ok;
}
process.exit(pass === probes.length && alive ? 0 : 1);
