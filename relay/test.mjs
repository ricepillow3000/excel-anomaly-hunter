// Abuse tests for the relay, run on this PC with a stand-in Google and an in-memory counter: node relay/test.mjs
import assert from "node:assert";
import worker, { Counter, dayKey, network } from "./worker.js";
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
const good = { messages: [{ role: "user", content: "Fix row 7" }], response_format: { type: "json_schema", json_schema: { name: "fix", schema: {} } } };
const call = (body, code = "inv_ana", path = "/fix") => worker.fetch(new Request(`https://relay.example${path}`, {
  method: "POST", headers: code !== null ? { Authorization: code && `Bearer ${code}` } : {}, body: typeof body === "string" ? body : JSON.stringify(body) }), env);

// AH-151: no Authorization header at all is the public tier (below); an empty one is a missing invite code, never that
assert.equal((await call(good, "")).status, 401, "an empty Authorization header");
assert.equal((await call(good, "inv_guess")).status, 401, "unknown invite code");
assert.equal((await call(good, "inv_ana", "/v1/anything")).status, 404, "only /fix");
// AH-155: nothing sent another method, so the method check was held by no test
for (const method of ["GET", "PUT"]) {
  const r = await worker.fetch(new Request("https://relay.example/fix", { method, headers: { Authorization: "Bearer inv_ana" },
    ...(method === "GET" ? {} : { body: JSON.stringify(good) }) }), env);
  assert.equal(r.status, 404, `only POST: ${method} /fix`);
}
assert.equal((await call("x".repeat(9000))).status, 413, "over 8 KB");
assert.equal((await call("{not json")).status, 400, "not JSON");
assert.equal((await call({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }], response_format: good.response_format })).status, 400, "one message only");
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
// AH-162: with no invite the canary is the public tier, so it runs every day with no secret: no Authorization header at
// all (an empty Bearer is a 401), and it fails as the invite canary does on a refusal, Google's error and an odd answer
{
  const PUB = "gemini-3.5-flash-lite";
  const penv = (extra) => ({ GEMINI_KEY: "AQ.the-secret", TOKENS: env.TOKENS, COUNTER: namespace(),
    PUBLIC_DAILY_PER_NETWORK: "15", PUBLIC_DAILY_TOTAL: "400", PUBLIC_MODELS: PUB, ...extra });
  const asked = []; // the headers each request left the canary with
  // Cloudflare adds the caller's address to every request; the canary never sends one
  const cloudflare = (e) => (url, init) => {
    const req = new Request(url, init);
    asked.push(new Headers(req.headers));
    req.headers.set("CF-Connecting-IP", "203.0.113.162");
    return worker.fetch(req, e);
  };
  googleStatus = 200;
  for (const none of ["", undefined]) {
    const before = sent.length;
    const fine = await canary("https://relay.example", none, cloudflare(penv({})));
    assert.ok(fine.ok && fine.line.includes("with no invite (public tier)"), fine.line);
    assert.equal(asked.at(-1).has("Authorization"), false, `no Authorization header at all (invite ${JSON.stringify(none)})`);
    assert.equal(sent.length, before + 1, "one call reached Google");
    assert.equal(sent.at(-1).body.model, PUB, "on the public tier's model");
  }
  const refused = await canary("https://relay.example", "", cloudflare(penv({ PUBLIC_DAILY_TOTAL: "0" })));
  assert.ok(!refused.ok && /429/.test(refused.line), refused.line);
  googleStatus = 403; // a revoked Gemini key: the relay answers 502 in its own words
  const broken = await canary("https://relay.example", "", cloudflare(penv({})));
  assert.ok(!broken.ok && /502/.test(broken.line) && broken.line.includes("public tier"), broken.line);
  googleStatus = 200;
  for (const [what, answer] of [["not JSON", "<html>"], ["cut off", '{"choices":[{"finish_reason":"length","message":{"content":"{\\"expl"}}]}'],
    ["not the fix shape", '{"choices":[{"message":{"content":"{\\"hello\\":1}"}}]}']]) {
    const odd = await canary("https://relay.example", "", async () => new Response(answer, { status: 200 }));
    assert.ok(!odd.ok && !odd.line.includes("[invite]"), `${what}: ${odd.line}`);
  }
  const down = await canary("https://relay.example", "", async () => { throw new TypeError("fetch failed"); });
  assert.ok(!down.ok && down.line.includes("TypeError: fetch failed"), down.line);
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
  const upload = { messages: [{ role: "user", content: `Fix row 7: A7='${marker}', the customer's own words` }], response_format: { type: "json_schema", json_schema: { name: "fix", schema: {} } } };
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
  assert.deepEqual([...read].filter((k) => !["TOKENS", "COUNTER", "BURST", "DAILY_PER_INVITE", "DAILY_TOTAL", "GEMINI_KEY", "MODELS"].includes(k)), [],
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
// AH-151 (John, 2026-11-09): every user gets the free AI with no key and no invite. A request with no Authorization
// header is the public tier: its own model (PUBLIC_MODELS), its own caps per network and for everyone, counted before
// Google under a keyed hash of the day and the network (never the IP itself), apart from the invites' caps
{
  const PUB = "gemini-3.5-flash-lite";
  const penv = (extra) => ({ ...env, COUNTER: namespace(), DAILY_PER_INVITE: "3", DAILY_TOTAL: "5",
    PUBLIC_DAILY_PER_NETWORK: "15", PUBLIC_DAILY_TOTAL: "400", PUBLIC_MODELS: PUB, ...extra });
  const free = (e, ip = "203.0.113.7", body = good) => worker.fetch(new Request("https://relay.example/fix", {
    method: "POST", headers: ip ? { "CF-Connecting-IP": ip } : {}, body: JSON.stringify(body) }), e);
  const invite = (e) => worker.fetch(new Request("https://relay.example/fix", {
    method: "POST", headers: { Authorization: "Bearer inv_ana" }, body: JSON.stringify(good) }), e);
  googleStatus = 200;
  let e = penv({});
  let from = sent.length;
  const r = await free(e, "203.0.113.7", { ...good, model: "gemini-3.8-flash", max_tokens: 99999 });
  assert.equal(r.status, 200, "no Authorization: served");
  assert.equal(sent.at(-1).body.model, PUB, "on the public model, whatever the request names");
  assert.equal(sent.at(-1).body.max_tokens, 4096, "the relay caps the answer's length itself");
  assert.equal(sent.at(-1).headers.Authorization, "Bearer AQ.the-secret", "the relay adds its key");
  assert.equal(sent.length - from, 1);
  for (const [what, body] of [["over 8 KB", "x".repeat(9000)], ["not JSON", "{not json"],
    ["two messages", JSON.stringify({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }], response_format: good.response_format })],
    ["no response_format", JSON.stringify({ messages: [{ role: "user", content: "a" }] })]]) {
    const bad = await worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" }, body }), e);
    assert.ok([400, 413].includes(bad.status), `the public tier keeps the body checks: ${what}`);
  }
  assert.equal((await free(e, null)).status, 400, "no network to count it under: refused");
  assert.equal(sent.length - from, 1, "nothing refused reached Google");
  // the per-network cap: 15 a day from one network, the 16th refused in our words; another network still served
  e = penv({});
  for (let i = 0; i < 15; i++) assert.equal((await free(e)).status, 200, `network call ${i + 1} of 15`);
  from = sent.length;
  const over = await free(e);
  assert.equal(over.status, 429, "the 16th call from one network");
  const said = await over.json();
  assert.equal(said.limit, "day", "a used-up day, tagged like the engine reads it");
  assert.match(said.error, /today/, "in our own words");
  assert.equal(sent.length, from, "never reached Google");
  assert.equal((await free(e, "198.51.100.4")).status, 200, "another network still has its own share");
  // the public total for everyone together, apart from the invites' DAILY_TOTAL
  e = penv({ PUBLIC_DAILY_TOTAL: "3" });
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) assert.equal((await free(e, ip)).status, 200);
  const full = await free(e, "192.0.2.4");
  assert.equal(full.status, 429, "the public total reached");
  assert.equal((await full.json()).limit, "day");
  assert.equal((await invite(e)).status, 200, "an invite is not held back by public use");
  e = penv({ DAILY_TOTAL: "1" });
  assert.equal((await invite(e)).status, 200);
  assert.equal((await invite(e)).status, 429, "the invites' total reached");
  assert.equal((await free(e)).status, 200, "the public tier is not held back by the invites' use");
  e = penv({ PUBLIC_DAILY_TOTAL: "0" });
  from = sent.length;
  assert.equal((await free(e)).status, 429, "a public total of 0 switches the public tier off");
  assert.equal(sent.length, from);
  // if the [vars] are ever lost: the design's caps and model, never looser
  e = { GEMINI_KEY: env.GEMINI_KEY, TOKENS: env.TOKENS, COUNTER: namespace() };
  for (let i = 0; i < 15; i++) assert.equal((await free(e)).status, 200, `fallback per-network cap: call ${i + 1} of 15`);
  assert.equal((await free(e)).status, 429, "fallback per-network cap is 15");
  assert.equal(sent.at(-1).body.model, PUB, "fallback model");
  // what is stored: the day's counts, each network under HMAC-SHA-256(GEMINI_KEY, day + IP), never the IP or the request
  const puts = [], store = new Map(), obj = new Counter({ storage: { get: async (k) => store.get(k), put: async (k, v) => (puts.push([k, JSON.stringify(v)]), store.set(k, v)) } });
  const counted = [];
  e = penv({ COUNTER: { idFromName: () => "caps", get: () => ({ fetch: async (u, init) => (counted.push(init.body), obj.fetch(new Request(u, init))) }) } });
  const ip = "203.0.113.77", marker = "MARKER-" + crypto.randomUUID();
  assert.equal((await free(e, ip, { messages: [{ role: "user", content: `Fix row 7: '${marker}'` }], response_format: { type: "json_schema", json_schema: { name: "fix", schema: {} } } })).status, 200);
  for (const kept of [...puts.map(([, v]) => v), ...counted]) {
    assert.ok(!kept.includes(ip) && !kept.includes("203.0.113") && !kept.includes(marker), "no IP and no request stored - " + kept);
  }
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GEMINI_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(dayKey() + ip)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const c = JSON.parse(puts.at(-1)[1]);
  assert.deepEqual(c.nets, { [mac]: 1 }, "counted under the keyed hash of the day and the network");
  assert.ok(c.pub === 1 && c.total === 0 && Object.keys(c.by).length === 0, "apart from the invites' counts - " + puts.at(-1)[1]);
}
// AH-151 follow-up: one IPv6 subscriber gets a whole /64 (billions of addresses), so an IPv6 address is counted by its
// /64 prefix, written out in full first (an address may drop zeros with "::"); an IPv4 address is counted as it is
{
  assert.equal(network("203.0.113.7"), "203.0.113.7", "IPv4 as it is");
  assert.equal(network("2001:db8:0:1::1"), "2001:db8:0:1::/64");
  assert.equal(network("2001:0DB8:0000:0001:ffff:1:2:3"), "2001:db8:0:1::/64", "leading zeros and capitals, the same /64");
  assert.equal(network("2001:db8::1"), "2001:db8:0:0::/64", ":: in the middle fills the missing groups with 0");
  assert.equal(network("::1"), "0:0:0:0::/64");
  assert.equal(network("fe80::"), "fe80:0:0:0::/64");
  assert.equal(network("::ffff:192.0.2.1"), "0:0:0:0::/64", "a dotted IPv4 tail counts as two groups");
  assert.equal(network("2001:db8:aa:bb::"), "2001:db8:aa:bb::/64");
  const penv = { ...env, COUNTER: namespace(), PUBLIC_DAILY_PER_NETWORK: "2", PUBLIC_DAILY_TOTAL: "400", PUBLIC_MODELS: "gemini-3.5-flash-lite" };
  const free = (ip) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(good) }), penv);
  googleStatus = 200;
  assert.equal((await free("2001:db8:0:1::1")).status, 200);
  assert.equal((await free("2001:db8:0:1:ffff::2")).status, 200, "another address of the same /64");
  assert.equal((await free("2001:0db8:0:1:9::3")).status, 429, "the same /64 shares the cap, however the address is written");
  assert.equal((await free("2001:db8:0:2::1")).status, 200, "another /64 has its own share");
  assert.equal((await free("198.51.100.1")).status, 200);
  assert.equal((await free("198.51.100.2")).status, 200, "IPv4: each address its own share, as before");
  // AH-155: only the exact HMAC held this. Two addresses of one /24 are two networks, each with its whole cap of 2
  assert.equal((await free("198.51.100.1")).status, 200, "IPv4: an address's 2nd call, beside another address of its /24");
  assert.equal((await free("198.51.100.1")).status, 429, "and its 3rd is over its own cap");
}
// AH-155: every body served above was ~100 bytes, so a cap cut to 4 KB, or one byte short of 8 KB, passed. The engine
// fills its requests up to BUDGET (7,000 bytes, ai/client.py): those must be served, and 8 KB is the line
{
  const e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "10", DAILY_TOTAL: "10" };
  const sized = (n) => {
    const base = JSON.stringify({ ...good, messages: [{ role: "user", content: "" }] });
    return JSON.stringify({ ...good, messages: [{ role: "user", content: "x".repeat(n - base.length) }] });
  };
  const post = (body) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" }, body }), e);
  googleStatus = 200;
  for (const n of [7000, 8 * 1024]) {
    assert.equal(sized(n).length, n);
    assert.equal((await post(sized(n))).status, 200, `a ${n}-byte request is served`);
  }
  assert.equal((await post(sized(8 * 1024 + 1))).status, 413, "one byte over 8 KB is refused");
}
// AH-158: the cap compared characters after reading the whole body, so 8,192 "é" (16 KB) passed, and a sender that
// declared 1 MB was read to the end first. Bytes now, and a declared size over the cap is refused unread
{
  const e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "10", DAILY_TOTAL: "10" };
  const bytes = (s) => new TextEncoder().encode(s).length;
  const wide = (n) => { // n bytes of JSON whose prompt is "é" (2 bytes, 1 character), one "x" to make an odd count
    const base = bytes(JSON.stringify({ ...good, messages: [{ role: "user", content: "" }] }));
    return JSON.stringify({ ...good, messages: [{ role: "user", content: "é".repeat((n - base) >> 1) + "x".repeat((n - base) & 1) }] });
  };
  const post = (body) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" }, body }), e);
  googleStatus = 200;
  assert.equal(bytes(wide(8192)), 8192);
  assert.equal((await post(wide(8192))).status, 200, "exactly 8,192 bytes of two-byte letters are served");
  assert.ok(bytes(wide(8193)) === 8193 && wide(8193).length < 8192, "8,193 bytes, fewer than 8,192 characters");
  assert.equal((await post(wide(8193))).status, 413, "8,193 bytes are refused, however few characters they are");
  let read = false; // a request whose body is never read unless the relay asks for it
  const declared = (size, body = JSON.stringify(good)) => ({ url: "https://relay.example/fix", method: "POST",
    headers: new Headers({ Authorization: "Bearer inv_ana", "Content-Length": String(size) }), get body() { read = true; return new Response(body).body; } });
  const from = sent.length;
  const huge = await worker.fetch(declared(1024 * 1024), e);
  assert.equal(huge.status, 413, "a declared 1 MB is refused");
  assert.ok(!read && sent.length === from, "without reading a byte of it, and nothing reached Google");
  assert.equal((await worker.fetch(declared(8192, wide(8192)), e)).status, 200, "a declared 8,192 bytes is read and served");
}
// AH-158: a Google per-minute 429 did no work, yet it cost the day: 400 parallel no-auth calls from 400 IPv6 /64s
// spent the public tier's 400 for everyone in a minute, mostly as "busy" answers. What such a request counted is given
// back (its own count, the total, and each backup model's count); a per-day 429 keeps its count
{
  const perMinute = '{"error":{"message":"Quota exceeded for metric GenerateRequestsPerMinutePerProjectPerModel-FreeTier, project 1234"}}';
  const perDay = '{"error":{"message":"Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier, project 1234"}}';
  const ask = (e, who = "inv_ana") => worker.fetch(new Request("https://relay.example/fix", { method: "POST",
    headers: { Authorization: `Bearer ${who}` }, body: JSON.stringify(good) }), e);
  let e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "3", DAILY_TOTAL: "5" };
  googleStatus = 429;
  googleBody = perMinute;
  for (let i = 0; i < 5; i++) {
    const r = await ask(e);
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /busy/, `busy answer ${i + 1} of 5 reached Google, never "used today's"`);
  }
  googleStatus = 200;
  for (let i = 0; i < 3; i++) assert.equal((await ask(e)).status, 200, `Ana's full day after 5 busy answers: ${i + 1} of 3`);
  assert.equal((await ask(e)).status, 429, "and her 4th is over her day");
  assert.equal((await ask(e, "inv_ben")).status, 200, "the total was given back too: Ben has the other 2");
  assert.equal((await ask(e, "inv_ben")).status, 200);
  assert.equal((await ask(e, "inv_ben")).status, 429, "the total (5) reached");
  // a per-day 429: Google's day is gone, the count stays used
  e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "3", DAILY_TOTAL: "5" };
  googleStatus = 429;
  googleBody = perDay;
  for (let i = 0; i < 3; i++) assert.match((await (await ask(e)).json()).error, /used up for today/);
  googleStatus = 200;
  let from = sent.length;
  const kept = await ask(e);
  assert.equal(kept.status, 429, "three per-day 429s used Ana's 3");
  assert.match((await kept.json()).error, /used today's AI fixes/);
  assert.equal(sent.length, from, "never reached Google");
  // a backup model's count is given back as well: the main model's day gone, then the backup busy for the minute
  e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "2", DAILY_TOTAL: "2", MODELS: "gemini-3.8-flash,gemini-3.6-flash" };
  const realFetch = globalThis.fetch, answers = [perDay, perMinute];
  globalThis.fetch = async (url, init) => (sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }),
    new Response(answers.shift(), { status: 429 }));
  const half = await ask(e);
  globalThis.fetch = realFetch;
  assert.equal(half.status, 429);
  assert.match((await half.json()).error, /busy/, "the main model's day gone, then the backup busy for the minute");
  googleStatus = 200;
  assert.equal((await ask(e)).status, 200, "both counts given back: Ana's 1st of 2");
  assert.equal((await ask(e)).status, 200, "and her 2nd: the backup's count was given back to the total");
  // the public tier: the network's count and the total come back
  e = { ...env, COUNTER: namespace(), PUBLIC_DAILY_PER_NETWORK: "2", PUBLIC_DAILY_TOTAL: "3" };
  const free = (ip) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(good) }), e);
  googleStatus = 429;
  googleBody = perMinute;
  for (let i = 0; i < 4; i++) assert.match((await (await free("203.0.113.5")).json()).error, /busy/);
  googleStatus = 200;
  assert.equal((await free("203.0.113.5")).status, 200, "the network's full day after 4 busy answers");
  assert.equal((await free("203.0.113.5")).status, 200);
  assert.equal((await free("203.0.113.5")).status, 429, "its 3rd is over its 2");
  assert.equal((await free("203.0.113.6")).status, 200, "the public total given back: the 3rd of 3");
  assert.equal((await free("203.0.113.7")).status, 429, "the public total (3) reached");
  googleBody = JSON.stringify({ error: { message: "project 1234 key AQ.secret" } });
  // never below 0, never another day's counts
  const store = new Map(), counter = new Counter({ storage: { get: async (k) => store.get(k), put: async (k, v) => store.set(k, v) } });
  const give = (body) => counter.fetch(new Request("https://caps/give", { method: "POST", body: JSON.stringify(body) }));
  store.set("c", { day: dayKey(), total: 0, by: {} });
  await give({ who: "Ana", day: dayKey(), n: 3 });
  assert.deepEqual(store.get("c"), { day: dayKey(), total: 0, by: {} }, "nothing counted: nothing goes below 0");
  store.set("c", { day: dayKey(), total: 2, by: { Ana: 2 } });
  await give({ who: "Ana", day: "2026-01-01", n: 1 });
  assert.deepEqual(store.get("c"), { day: dayKey(), total: 2, by: { Ana: 2 } }, "a count taken another day leaves today's alone");
  await give({ who: "Ana", day: dayKey(), n: 1 });
  assert.deepEqual(store.get("c"), { day: dayKey(), total: 1, by: { Ana: 1 } }, "today's: one back to Ana and the total");
}
// AH-158: a per-network burst limit (Cloudflare's Workers Rate Limiting, BURST in wrangler.toml), asked before the
// counter and before Google, under the same keyed hash as the day's count (never the IP) or the invite's name
{
  const keys = [];
  let allow = false;
  const burst = { limit: async ({ key }) => (keys.push(key), { success: allow }) };
  const e = { ...env, COUNTER: namespace(), BURST: burst, PUBLIC_DAILY_PER_NETWORK: "1", DAILY_PER_INVITE: "1" };
  const free = (ip) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(good) }), e);
  const ask = () => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" },
    body: JSON.stringify(good) }), e);
  googleStatus = 200;
  let from = sent.length;
  for (const r of [await free("203.0.113.8"), await free("203.0.113.8"), await ask()]) {
    assert.equal(r.status, 429, "the minute's limit reached");
    const said = await r.json();
    assert.equal(said.limit, "minute", "tagged as a minute's limit");
    assert.match(said.error, /in one minute/, "in our own words");
    assert.ok(!/today/.test(said.error), "never read as a used-up day by the engine");
  }
  assert.equal(sent.length, from, "Google never asked");
  const mac = async (text) => {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GEMINI_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  assert.deepEqual(keys, [await mac(dayKey() + "203.0.113.8"), await mac(dayKey() + "203.0.113.8"), "Ana"],
    "keyed by the network's hash (never its IP) and the invite's name");
  allow = true;
  assert.equal((await free("203.0.113.8")).status, 200, "allowed: served, and nothing the limit refused was counted (its day is 1)");
  assert.equal((await ask()).status, 200, "the invite too");
  keys.length = 0;
  await free("2001:db8:5:6:7::1");
  assert.deepEqual(keys, [await mac(dayKey() + "2001:db8:5:6::/64")], "an IPv6 address by its /64's hash");
  // a counting stand-in at wrangler.toml's own limit: an honest word check (6 calls in a row) is never refused, and
  // each network has its own minute
  const toml = (await import("node:fs")).readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  const [, limit, period] = toml.match(/name = "BURST"[^]*?simple = \{ limit = (\d+), period = (\d+) \}/).map(Number);
  const day = +toml.match(/PUBLIC_DAILY_PER_NETWORK = "(\d+)"/)[1];
  assert.equal(period, 60, "a minute");
  assert.ok(limit >= 6, `a word check's 6 calls fit in the minute (${limit})`);
  assert.ok(limit <= day, `never looser than a network's whole day (${limit} <= ${day})`);
  const seen = new Map();
  const counting = { limit: async ({ key }) => { seen.set(key, (seen.get(key) || 0) + 1); return { success: seen.get(key) <= limit }; } };
  const c = { ...env, COUNTER: namespace(), BURST: counting, PUBLIC_DAILY_PER_NETWORK: "100" };
  const at = (ip) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(good) }), c);
  for (let i = 0; i < limit; i++) assert.equal((await at("198.51.100.20")).status, 200, `call ${i + 1} of ${limit} in a minute`);
  assert.equal((await at("198.51.100.20")).status, 429, "one more in the minute is refused");
  assert.equal((await at("198.51.100.21")).status, 200, "another network has its own minute");
  delete e.BURST;
  assert.equal((await free("203.0.113.9")).status, 200, "no BURST binding (an older deploy): the daily caps still hold, served");
}
// AH-158: one /48 holds 65,536 /64s (a cheap VPS hands one out), so each IPv6 /48 has its own day too:
// PUBLIC_DAILY_PER_48 (45 = 3 networks' 15), counted under its own keyed hash, beside its /64's 15. IPv4 is as before
{
  const e = { ...env, COUNTER: namespace(), PUBLIC_DAILY_PER_NETWORK: "15", PUBLIC_DAILY_TOTAL: "400" }; // PER_48 unset: 45
  const free = (ip) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(good) }), e);
  googleStatus = 200;
  for (const net of ["2001:db8:1:1", "2001:db8:1:2", "2001:db8:1:3"]) {
    for (let i = 0; i < 15; i++) assert.equal((await free(`${net}::${i + 1}`)).status, 200, `${net}::/64 call ${i + 1} of 15`);
  }
  const from = sent.length;
  const over = await free("2001:db8:1:4::1");
  assert.equal(over.status, 429, "a 4th /64 of the same /48: its 45 are used");
  assert.equal((await over.json()).limit, "day");
  assert.equal(sent.length, from, "never reached Google");
  assert.equal((await free("2001:db8:2:1::1")).status, 200, "a /64 in another /48 still served");
  for (let i = 0; i < 16; i++) await free("198.51.100.30");
  assert.equal((await free("198.51.100.31")).status, 200, "IPv4: each address its own share, as before");
  const set = { ...e, COUNTER: namespace(), PUBLIC_DAILY_PER_48: "2" };
  const at = (ip) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { "CF-Connecting-IP": ip },
    body: JSON.stringify(good) }), set);
  assert.equal((await at("2001:db8:3:1::1")).status, 200);
  assert.equal((await at("2001:db8:3:2::1")).status, 200, "the [vars] cap: the /48's 2nd");
  assert.equal((await at("2001:db8:3:3::1")).status, 429, "and its 3rd refused");
}
// AH-160: with no Content-Length (a streamed body) the relay read the whole body, 64 MB and more, before its 8 KB
// cap. It reads up to the cap and stops there; a small streamed body is still served, a letter split between pieces too
{
  const e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "10", DAILY_TOTAL: "10" };
  const stream = (pieces) => new ReadableStream({ pull(c) { const p = pieces.next(); p.done ? c.close() : c.enqueue(p.value); } });
  const post = (body) => worker.fetch(new Request("https://relay.example/fix", { method: "POST", headers: { Authorization: "Bearer inv_ana" },
    body, duplex: "half" }), e);
  let pulled = 0;
  function* sixteen() { for (let i = 0; i < 16 * 1024; i++) { pulled += 1024; yield new Uint8Array(1024).fill(120); } } // 16 MB of "x"
  googleStatus = 200;
  const from = sent.length;
  assert.equal((await post(stream(sixteen()))).status, 413, "a streamed 16 MB with no size is refused");
  assert.ok(pulled <= 12 * 1024 && sent.length === from, `read no more than the cap and a piece or two past it: ${pulled} bytes`);
  const bytes = new TextEncoder().encode(JSON.stringify({ ...good, messages: [{ role: "user", content: "Fix row 7: é" }] }));
  const cut = bytes.indexOf(0xc3) + 1; // between the two bytes of "é"
  assert.equal((await post(stream([bytes.slice(0, cut), bytes.slice(cut)].values()))).status, 200, "a small streamed body is served");
  assert.equal(sent.at(-1).body.messages[0].content, "Fix row 7: é", "read whole, the split letter too");
}
// AH-160: the answer's format is set here (layer 3), yet any response_format went to Google as sent: the public tier
// gave plain text ({type: "text"}) to whoever asked. Only a JSON schema the answer must follow is taken
{
  const e = { ...env, COUNTER: namespace(), DAILY_PER_INVITE: "20", DAILY_TOTAL: "20" };
  const post = (format, auth = { Authorization: "Bearer inv_ana" }) => worker.fetch(new Request("https://relay.example/fix", {
    method: "POST", headers: { ...auth, "CF-Connecting-IP": "203.0.113.160" }, body: JSON.stringify({ ...good, response_format: format }) }), e);
  googleStatus = 200;
  const from = sent.length;
  for (const auth of [{ Authorization: "Bearer inv_ana" }, {}]) {
    for (const format of [{ type: "text" }, { type: "json_object" }, { type: "json_schema" }, { type: "json_schema", json_schema: { name: "fix" } },
      { type: "json_schema", json_schema: { schema: "x" } }, { type: "json_schema", json_schema: { schema: [] } }, { type: "json_schema", json_schema: { schema: null } },
      { type: "text", json_schema: { schema: {} } }, "json_schema", null]) {
      const r = await post(format, auth);
      assert.equal(r.status, 400, `refused: ${JSON.stringify(format)}`);
      assert.match((await r.json()).error, /couldn't read that request/);
    }
  }
  assert.equal(sent.length, from, "none reached Google");
  for (const auth of [{ Authorization: "Bearer inv_ana" }, {}]) {
    assert.equal((await post({ type: "json_schema", json_schema: { name: "fix", schema: {} } }, auth)).status, 200, "a JSON schema is taken");
  }
}
console.log("relay abuse tests passed");

// the backup of the invite list, restored and loaded the way the worker loads it (AH-124)
await import("./restore-test.mjs");
