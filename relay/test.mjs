// Abuse tests for the relay, run on this PC with a stand-in Google and an in-memory counter: node relay/test.mjs
import assert from "node:assert";
import worker, { Counter, dayKey } from "./worker.js";
import { canary } from "./canary.mjs";

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

// the day the caps count follows Google's own reset (midnight US Pacific, summer and winter time), not UTC
assert.equal(dayKey(new Date("2026-10-13T06:59:00Z")), "2026-10-12", "summer: still the Pacific day before");
assert.equal(dayKey(new Date("2026-10-13T07:00:00Z")), "2026-10-13", "summer: Pacific midnight = 07:00 UTC");
assert.equal(dayKey(new Date("2026-12-01T07:30:00Z")), "2026-11-30", "winter: Pacific midnight = 08:00 UTC");
assert.equal(dayKey(new Date("2026-12-01T08:00:00Z")), "2026-12-01");

// never an uncaught throw (Cloudflare would answer with its own HTML page): Google unreachable, or a broken TOKENS secret
env.COUNTER = namespace();
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new TypeError("network down"); };
const down = await call(good);
assert.equal(down.status, 502, "Google unreachable");
assert.ok((await down.json()).error, "still a JSON error");
globalThis.fetch = realFetch;
// a Google that never answers (AH-87 audit): the invite's fix is already counted, so the relay gives up on its own
// clock and says so in its JSON, instead of holding the request until Cloudflare or the engine cuts it off
env.COUNTER = namespace();
const realTimeout = AbortSignal.timeout, asked = [];
AbortSignal.timeout = (ms) => { // 90 s played back in 30 ms, aborted the way the real one is (Node's own timer is unref'd)
  asked.push(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException("The operation timed out.", "TimeoutError")), 30);
  return c.signal;
};
let hung = 0;
globalThis.fetch = (url, init) => new Promise((_, fail) => {
  hung++;
  assert.ok(init.signal instanceof AbortSignal, "every call to Google carries a deadline");
  init.signal.addEventListener("abort", () => fail(init.signal.reason));
});
const slow = await call(good);
AbortSignal.timeout = realTimeout;
globalThis.fetch = realFetch;
assert.equal(slow.status, 504, "Google did not answer in time");
assert.match((await slow.json()).error, /in time/, "in the relay's own words");
assert.deepEqual(asked, [90_000], "90 s, the engine's own cap on one call to Google");
assert.equal(hung, 1, "a call that timed out is not tried again: the engine's 240 s would run out first");
const broken = await worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" }, body: "{}" }),
  { ...env, TOKENS: "{bad" });
assert.equal(broken.status, 500, "a mistyped TOKENS secret");
assert.ok((await broken.json()).error);
// the daily-cap counter itself failing (a Durable Object outage): our own JSON, and Google is never called (AH-13)
const sentBefore = sent.length;
const noCounter = await worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" },
  body: JSON.stringify(good) }), { ...env, COUNTER: { idFromName: () => "caps", get: () => ({ fetch: async () => { throw new Error("DO down"); } }) } });
assert.equal(noCounter.status, 503, "the cap counter is down");
assert.ok((await noCounter.json()).error, "still a JSON error");
assert.equal(sent.length, sentBefore, "and nothing reached Google");

// if the [vars] caps are ever lost, the fallbacks are the real quota (10 / 20), never looser
googleStatus = 200;
const bare = { GEMINI_KEY: env.GEMINI_KEY, TOKENS: env.TOKENS, COUNTER: namespace() };
const bareCall = () => worker.fetch(new Request("https://relay.example/fix", {
  method: "POST", headers: { Authorization: "Bearer inv_ana" }, body: JSON.stringify(good) }), bare);
for (let i = 0; i < 10; i++) assert.equal((await bareCall()).status, 200, `fallback cap: call ${i + 1} of 10`);
assert.equal((await bareCall()).status, 429, "fallback per-invite cap is 10");
// a daily cap of 0 switches the relay off (2026-10-15 audit: `+"0" || 20` read 0 as unset and allowed 20)
const off = { ...bare, COUNTER: namespace(), DAILY_TOTAL: "0" };
const before = sent.length;
const offCall = await worker.fetch(new Request("https://relay.example/fix", {
  method: "POST", headers: { Authorization: "Bearer inv_ana" }, body: JSON.stringify(good) }), off);
assert.equal(offCall.status, 429, "a total cap of 0 refuses");
assert.equal(sent.length, before, "and never reaches Google");

// AH-108: the daily canary's one real call. Its body must pass this very worker's checks and reach Google, and it
// fails on a refused invite, on Google's error and on an answer the engine could not read. The invite never shows.
{
  const secret = "inv_SECRETcanaryMadeUpForTheTest";
  const cenv = { GEMINI_KEY: "AQ.the-secret", TOKENS: JSON.stringify({ [await hash(secret)]: "canary" }), COUNTER: namespace(),
    DAILY_PER_INVITE: "10", DAILY_TOTAL: "20" };
  const through = (e) => (url, init) => worker.fetch(new Request(url, init), e);
  googleStatus = 200;
  const before = sent.length;
  const fine = await canary("https://relay.example", secret, through(cenv));
  assert.ok(fine.ok, fine.line);
  assert.equal(sent.length, before + 1, "one call reached Google");
  assert.deepEqual(Object.keys(sent.at(-1).body.response_format.json_schema.schema.properties), ["explanation", "changes"],
    "the engine's own answer shape is asked for");
  assert.ok(!JSON.stringify(sent.at(-1).body).includes(secret), "the invite is never in the body");
  const refused = await canary("https://relay.example", "inv_SECRETswitchedOffCanary", through(cenv));
  assert.ok(!refused.ok && /401/.test(refused.line), refused.line);
  googleStatus = 403; // a revoked Gemini key: the relay answers 502 in its own words
  const broken = await canary("https://relay.example", secret, through({ ...cenv, COUNTER: namespace() }));
  assert.ok(!broken.ok && /502/.test(broken.line), broken.line);
  googleStatus = 200;
  for (const [what, answer] of [["not JSON", "<html>"], ["no choices", "{}"], ["cut off", '{"choices":[{"finish_reason":"length","message":{"content":"{\\"expl"}}]}'],
    ["not the fix shape", '{"choices":[{"message":{"content":"{\\"hello\\":1}"}}]}']]) {
    const odd = await canary("https://relay.example", secret, async () => new Response(answer, { status: 200 }));
    assert.ok(!odd.ok, `${what}: ${odd.line}`);
  }
  const echo = await canary("https://relay.example", secret, async () => new Response(JSON.stringify({ error: `bad ${secret}` }), { status: 401 }));
  assert.ok(!echo.ok && !echo.line.includes(secret), "an answer that quotes the invite is printed without it");
  const down = await canary("https://relay.example", secret, async () => { throw new TypeError("fetch failed"); });
  assert.ok(!down.ok && !down.line.includes(secret), down.line);
}
// AH-125 ("uploads not stored"): what a /fix sends is passed to Google and never kept. The relay's only storage is the
// counter's one object "c" ({day, total, by: {invite name: calls}}), and the only bindings it reads are its secrets, its
// caps and that counter: no KV, R2 or D1 a request could land in (test_privacy_promises.py reads wrangler.toml)
{
  const puts = [], counted = [], read = new Set();
  const store = new Map(), obj = new Counter({ storage: {
    get: async (k) => store.get(k), put: async (k, v) => (puts.push([k, JSON.stringify(v)]), store.set(k, v)) } });
  const ns = { idFromName: () => "caps", get: () => ({ fetch: async (u, init) => (counted.push(init.body), obj.fetch(new Request(u, init))) }) };
  const watched = new Proxy({ ...env, COUNTER: ns }, { get: (t, k) => (read.add(String(k)), t[k]) });
  const marker = "MARKER-7c1f-" + crypto.randomUUID();
  const upload = { messages: [{ role: "user", content: `Fix row 7: A7='${marker}', the customer's own words` }], response_format: { type: "json_schema" } };
  googleStatus = 200;
  const before = sent.length;
  const done = await worker.fetch(new Request("https://relay.example/fix", { method: "POST",
    headers: { Authorization: "Bearer inv_ana" }, body: JSON.stringify(upload) }), watched);
  assert.equal(done.status, 200);
  assert.ok(JSON.stringify(sent.at(-1).body).includes(marker) && sent.length === before + 1, "the request reached Google once");
  assert.ok(puts.length === 1 && puts.every(([k]) => k === "c"), "the counter writes its one object only - " + JSON.stringify(puts));
  assert.deepEqual(Object.keys(JSON.parse(puts[0][1])).sort(), ["by", "day", "total"], "the stored object is the day's counts");
  assert.deepEqual(JSON.parse(puts[0][1]).by, { Ana: 1 }, "counted under the invite's name, never its code");
  for (const kept of [...puts.map(([, v]) => v), ...counted]) {
    assert.ok(!kept.includes(marker) && !kept.includes("Fix row") && !kept.includes("inv_ana"), "nothing the request said is stored - " + kept);
  }
  assert.deepEqual([...read].filter((k) => !["TOKENS", "COUNTER", "DAILY_PER_INVITE", "DAILY_TOTAL", "GEMINI_KEY", "MODELS"].includes(k)), [],
    "the relay reads no other binding - " + [...read]);
}
// AH-145: one free model's day used up, or it overloaded for hours, while others answered (each model has its own
// quota). With MODELS listing backups, the relay asks the next one at once, counted against the day's total first;
// without them (the default), it answers as before
{
  const perDay = '{"error":{"message":"Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier, project 1234"}}';
  const perMinute = '{"error":{"message":"Quota exceeded for metric GenerateRequestsPerMinutePerProjectPerModel-FreeTier, project 1234"}}';
  const menv = (extra) => ({ ...env, COUNTER: namespace(), DAILY_PER_INVITE: "3", DAILY_TOTAL: "5", ...extra });
  const ask = (e) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" },
    body: JSON.stringify(good) }), e);
  const models = (from) => sent.slice(from).map((s) => s.body.model);
  googleStatus = 200;
  for (const first of [429, 503, 502]) {
    googleBody = perDay;
    const e = menv({ MODELS: "gemini-3.8-flash, gemini-3.6-flash,gemini-3.5-flash" });
    googleQueue.push(first);
    const from = sent.length;
    const r = await ask(e);
    assert.equal(r.status, 200, `${first}: the next model answered`);
    assert.equal(r.headers.get("X-Model"), "gemini-3.6-flash", "the engine is told a backup answered (the pane says so)");
    assert.deepEqual(models(from), ["gemini-3.8-flash", "gemini-3.6-flash"], `${first}: in the listed order, at once`);
    assert.deepEqual(sent.at(-1).body.messages, sent.at(-2).body.messages, "the same request");
    for (let i = 0; i < 2; i++) {
      const main = await ask(e);
      assert.ok(main.status === 200 && main.headers.get("X-Model") === null, "the main model's answer names no model");
    }
    assert.equal((await ask(e)).status, 429, "the backup call counted against the day's total (5), not Ana's 3: 2 + 1 + 1 + 1");
  }
  googleBody = perMinute; // too many this minute: another model would not help the next minute, so no switch
  let e = menv({ MODELS: "gemini-3.8-flash,gemini-3.6-flash" });
  googleQueue.push(429);
  let from = sent.length;
  let r = await ask(e);
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /minute/);
  assert.deepEqual(models(from), ["gemini-3.8-flash"]);
  googleBody = perDay; // the day's total reached: the backup is never asked uncounted
  e = menv({ MODELS: "gemini-3.8-flash,gemini-3.6-flash", DAILY_TOTAL: "1" });
  googleQueue.push(429);
  from = sent.length;
  r = await ask(e);
  assert.match((await r.json()).error, /used up for today/);
  assert.deepEqual(models(from), ["gemini-3.8-flash"]);
  googleQueue.push(429, 429); // every listed model used up: said once, as before
  e = menv({ MODELS: "gemini-3.8-flash,gemini-3.6-flash" });
  from = sent.length;
  r = await ask(e);
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /used up for today/);
  assert.deepEqual(models(from), ["gemini-3.8-flash", "gemini-3.6-flash"]);
  // no MODELS (today's relay): one model, the same words as before
  e = menv({});
  googleQueue.push(429);
  from = sent.length;
  r = await ask(e);
  assert.equal((await r.json()).error, "The shared free AI is used up for today. It resets at midnight US Pacific time.");
  assert.deepEqual(models(from), ["gemini-3.8-flash"]);
  googleQueue.push(503, 503, 503);
  from = sent.length;
  r = await ask(e);
  assert.equal(r.status, 502);
  assert.deepEqual(models(from), ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.8-flash"], "busy: 3 tries of the one model, as before");
  googleBody = JSON.stringify({ error: { message: "project 1234 key AQ.secret" } });
}
console.log("relay abuse tests passed");

// the backup of the invite list, restored and loaded the way the worker loads it (AH-124)
await import("./restore-test.mjs");
