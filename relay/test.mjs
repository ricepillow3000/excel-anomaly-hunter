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
const googleQueue = []; // statuses for the next calls, then googleStatus
let googleBody = JSON.stringify({ error: { message: "project 1234 key AQ.secret" } }); // Google's error text
globalThis.fetch = async (url, init) => {
  sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  const status = googleQueue.length ? googleQueue.shift() : googleStatus;
  return status === 200
    ? new Response(JSON.stringify({ choices: [{ message: { content: '{"explanation":"x","changes":[]}' } }] }), { status: 200 })
    : new Response(googleBody, { status });
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
assert.equal(sent.at(-1).body.messages.length, 1);
const n400 = sent.length;
await call(good);
assert.equal(sent.length - n400, 1, "a 400 is not retried");

// Google busy for a moment: the relay tries again itself, and the invite's fix is counted once
env.COUNTER = namespace();
googleStatus = 200;
googleQueue.push(503, 503);
let n = sent.length;
assert.equal((await call(good)).status, 200, "two busy answers, then Google answered");
assert.equal(sent.length - n, 3, "3 tries reached Google");
assert.equal((await call(good)).status, 200);
assert.equal((await call(good)).status, 200);
assert.equal((await call(good)).status, 429, "Ana's 3 fixes: the retried one counted once");
env.COUNTER = namespace();
googleQueue.push(503, 503, 503);
n = sent.length;
assert.equal((await call(good)).status, 502, "still busy after 3 tries: give up");
assert.equal(sent.length - n, 3, "never more than 3 tries");

// Google's 429 means two different things: too many this minute (wait a minute) or today's free quota is gone
env.COUNTER = namespace();
googleStatus = 429;
googleBody = '{"error":{"message":"Quota exceeded for metric GenerateRequestsPerMinutePerProjectPerModel-FreeTier, project 1234"}}';
let busy = await call(good);
assert.equal(busy.status, 429);
let words = (await busy.json()).error;
assert.match(words, /minute/, "a per-minute limit says: try again in a minute");
assert.ok(!words.includes("1234"), "Google's text is not passed on");
googleBody = '{"error":{"message":"Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier, project 1234"}}';
busy = await call(good);
words = (await busy.json()).error;
assert.match(words, /today/i, "a per-day limit says: used up for today");
assert.ok(!words.includes("1234") && !/minute/.test(words));
console.log("relay abuse tests passed");
