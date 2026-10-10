// Abuse tests for the relay, run on this PC with a stand-in Google and an in-memory counter: node relay/test.mjs
import assert from "node:assert";
import worker, { Counter } from "./worker.js";

const hash = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");

// a Durable Object stub: one Counter, requests handled one at a time (as Cloudflare does)
function namespace() {
  const store = new Map(), obj = new Counter({ storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) } });
  let queue = Promise.resolve();
  return { idFromName: () => "caps", get: () => ({ fetch: (u, init) => (queue = queue.then(() => obj.fetch(new Request(u, init)))) }) };
}

const sent = [];
let googleStatus = 200;
globalThis.fetch = async (url, init) => {
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return googleStatus === 200
    ? new Response(JSON.stringify({ choices: [{ message: { content: '{"explanation":"x","changes":[]}' } }] }), { status: 200 })
    : new Response(JSON.stringify({ error: { message: "project 1234 key AQ.secret" } }), { status: googleStatus });
};

const env = { GEMINI_KEY: "AQ.the-secret", TOKENS: JSON.stringify({ [await hash("inv_ana")]: "Ana", [await hash("inv_ben")]: "Ben" }),
  COUNTER: namespace(), DAILY_PER_INVITE: "3", DAILY_TOTAL: "5" };
const good = { messages: [{ role: "user", content: "Fix row 7" }], response_format: { type: "json_schema" } };
const call = (body, code = "inv_ana", path = "/fix") => worker.fetch(new Request(`https://relay.example${path}`, {
  method: "POST", headers: code ? { Authorization: `Bearer ${code}` } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }), env);

assert.equal((await call(good, null)).status, 401, "no invite code");
assert.equal((await call(good, "inv_guess")).status, 401, "unknown invite code");
assert.equal((await call(good, "inv_ana", "/v1/anything")).status, 404, "only /fix");
assert.equal((await call("x".repeat(9000))).status, 413, "over 8 KB");
assert.equal((await call("{not json")).status, 400, "not JSON");
assert.equal((await call({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }], response_format: {} })).status, 400, "one message only");
assert.equal(sent.length, 0, "nothing above reached Google");

const r = await call(good);
assert.equal(r.status, 200);
assert.equal(sent[0].headers.Authorization, "Bearer AQ.the-secret", "the relay adds the key");
assert.equal(sent[0].body.model, "gemini-3.8-flash", "the relay picks the model");
assert.ok(!JSON.stringify(await r.json()).includes("the-secret"), "the key never comes back");

// caps: Ana 3 a day; everyone together 5 a day - fired in parallel, the counter still never lets one too many through
const burst = await Promise.all(Array.from({ length: 6 }, () => call(good, "inv_ana")));
assert.equal(burst.filter((x) => x.status === 200).length, 2, "Ana's 3rd is her last (1 already used)");
assert.equal(burst.filter((x) => x.status === 429).length, 4);
assert.equal((await call(good, "inv_ben")).status, 200, "Ben still has his own allowance");
assert.equal((await call(good, "inv_ben")).status, 200);
assert.equal((await call(good, "inv_ben")).status, 429, "the shared total (5) is reached");
assert.equal(sent.length, 5, "exactly 5 requests reached Google");

// Google's own error: status only, never its body (which can name the project or key)
env.COUNTER = namespace();
googleStatus = 400;
const bad = await call(good);
assert.equal(bad.status, 502);
assert.ok(!JSON.stringify(await bad.json()).includes("AQ."), "Google's error text is not passed on");
console.log("relay abuse tests passed");
