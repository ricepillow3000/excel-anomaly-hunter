// Load test for the relay, on this PC with a stand-in Google: node relay/load.mjs (AH-158)
// The abuse tests fired bursts of 6. Here 1,100 requests arrive at once, twice (two "days"), through the real worker.js,
// a Counter fed one request at a time the way a Durable Object's input gate feeds it, and a counting stand-in for the
// BURST binding at wrangler.toml's own limit. Exactly the caps get through, every call let through reaches Google
// once, every refusal is our JSON 429 tagged with its limit, and nothing answers 5xx.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import worker, { Counter } from "./worker.js";

const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
const vars = Object.fromEntries([...toml.matchAll(/^(\w+) = "(\d+)"/gm)].map(([, k, n]) => [k, +n]));
const v = (name) => vars[name];
const MINUTE = +toml.match(/simple = \{ limit = (\d+), period = 60 \}/)[1];
const PER_NET = v("PUBLIC_DAILY_PER_NETWORK"), PUB_TOTAL = v("PUBLIC_DAILY_TOTAL"), PER_48 = v("PUBLIC_DAILY_PER_48");
const PER_INVITE = v("DAILY_PER_INVITE"), INV_TOTAL = v("DAILY_TOTAL");

const sha = async (t) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const later = () => new Promise((ok) => setImmediate(ok));

// a Durable Object: one fetch at a time (its input gate), with storage that yields between get and put, so a counter
// that let two requests in at once would be caught over-counting here
function namespace() {
  const store = new Map();
  const obj = new Counter({ storage: { get: async (k) => (await later(), store.get(k)), put: async (k, v) => (await later(), store.set(k, v)) } });
  let gate = Promise.resolve();
  const fetch = (u, init) => (gate = gate.then(() => obj.fetch(new Request(u, init)), () => obj.fetch(new Request(u, init))));
  return { idFromName: () => "caps", get: () => ({ fetch }) };
}

// BURST: Cloudflare's fixed one-minute window per key, at the toml's limit; each wave is its own minute
const minute = new Map();
const BURST = { limit: async ({ key }) => { minute.set(key, (minute.get(key) || 0) + 1); return { success: minute.get(key) <= MINUTE }; } };

let google = 0;
globalThis.fetch = async () => {
  google++;
  await new Promise((ok) => setTimeout(ok, 1 + Math.random() * 4)); // Google answers after 1-5 ms
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"explanation":"x","changes":[]}' } }] }), { status: 200 });
};

// the day the caps count: "next day" moves the clock 24 h
let shift = 0;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [RealDate.now() + shift])); }
  static now() { return RealDate.now() + shift; }
};

const invites = ["Ana", "Ben", "Cy", "Di", "Ed"];
const env = { GEMINI_KEY: "AQ.load-test-not-a-key", COUNTER: namespace(), BURST, MODELS: "gemini-3.8-flash", PUBLIC_MODELS: "gemini-3.5-flash-lite",
  TOKENS: JSON.stringify(Object.fromEntries(await Promise.all(invites.map(async (n) => [await sha(`inv_${n}`), n])))),
  ...Object.fromEntries(["PUBLIC_DAILY_PER_NETWORK", "PUBLIC_DAILY_TOTAL", "PUBLIC_DAILY_PER_48", "DAILY_PER_INVITE", "DAILY_TOTAL"].map((n) => [n, String(v(n))])) };
const body = JSON.stringify({ messages: [{ role: "user", content: "Fix row 7" }], response_format: { type: "json_schema", json_schema: { name: "fix", schema: {} } } });

async function wave(name, sends) { // sends: [{ip} | {invite}] in arrival order, all fired at once
  minute.clear();
  const g = google, t0 = performance.now();
  const out = await Promise.all(sends.map(async (s) => {
    const t = performance.now();
    const r = await worker.fetch(new Request("https://relay.example/fix", { method: "POST", body,
      headers: s.invite ? { Authorization: `Bearer inv_${s.invite}` } : { "CF-Connecting-IP": s.ip } }), env);
    const said = r.status === 200 ? null : await r.json();
    if (r.status === 200) await r.text();
    return { ...s, status: r.status, said, ms: performance.now() - t };
  }));
  const secs = (performance.now() - t0) / 1000, ms = out.map((o) => o.ms).sort((a, b) => a - b);
  const served = out.filter((o) => o.status === 200).length;
  assert.deepEqual([...new Set(out.map((o) => o.status))].filter((s) => ![200, 429].includes(s)), [], `${name}: only 200 or our 429, never 5xx`);
  for (const o of out.filter((x) => x.status === 429)) assert.ok(typeof o.said.error === "string" && o.said.error, `${name}: a refusal in our words`);
  assert.equal(google - g, served, `${name}: every call let through reached Google once, and no other`);
  console.log(`${name}: ${out.length} requests, ${served} served, in ${secs.toFixed(2)} s = ${Math.round(out.length / secs)} requests/s;` +
    ` latency p50 ${ms[Math.floor(ms.length / 2)].toFixed(1)} ms, p99 ${ms[Math.floor(ms.length * 0.99)].toFixed(1)} ms`);
  return out;
}
const tally = (out, key) => out.reduce((m, o) => m.set(key(o), (m.get(key(o)) || 0) + (o.status === 200)), new Map());
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const start = performance.now();

// day 1: 1,000 public requests from 200 IPv4 networks (5 each) and 100 invite requests (20 per invite), together:
// more than either total, so the totals bind
{
  const out = await wave("day 1", shuffle([...Array.from({ length: 1000 }, (_, i) => ({ ip: `10.0.0.${i % 200}` })),
    ...Array.from({ length: 100 }, (_, i) => ({ invite: invites[i % 5] }))]));
  const pub = out.filter((o) => o.ip), inv = out.filter((o) => o.invite);
  assert.equal(pub.filter((o) => o.status === 200).length, PUB_TOTAL, `the public total, exactly ${PUB_TOTAL}`);
  assert.ok(Math.max(...tally(pub, (o) => o.ip).values()) <= PER_NET, "no network past its day");
  assert.ok(pub.filter((o) => o.status === 429).every((o) => o.said.limit === "day"), "each public refusal tagged day");
  assert.equal(inv.filter((o) => o.status === 200).length, INV_TOTAL, `the invites' total, exactly ${INV_TOTAL}`);
  assert.ok(Math.max(...tally(inv, (o) => o.invite).values()) <= PER_INVITE, "no invite past its day");
}
// day 2: under the totals, so each network's, each /48's, each minute's and each invite's own limit binds, exactly:
// 4 IPv6 /48s of 4 /64s sending 25 each, 12 IPv4 networks sending 50 each (past the minute), 2 invites sending 50 each
shift = 24 * 3600 * 1000;
{
  const v6 = Array.from({ length: 400 }, (_, i) => ({ ip: `2001:db8:${(i / 100 | 0) + 1}:${(i / 25 | 0) % 4 + 1}::${i % 25 + 1}`, n48: i / 100 | 0, n64: i / 25 | 0 }));
  const v4 = Array.from({ length: 600 }, (_, i) => ({ ip: `192.0.2.${i % 12}` }));
  const out = await wave("day 2", shuffle([...v6, ...v4, ...Array.from({ length: 100 }, (_, i) => ({ invite: invites[i % 2] }))]));
  const per = (o) => (o.status === 200 ? "served" : o.said.limit);
  const v6out = out.filter((o) => o.n48 !== undefined);
  for (const [n48, got] of tally(v6out, (o) => o.n48)) assert.equal(got, PER_48, `/48 number ${n48}: exactly its ${PER_48}`);
  for (const [, got] of tally(v6out, (o) => o.n64)) assert.ok(got <= PER_NET, "no /64 past its day");
  for (const [n64, sent] of tally(v6out.map((o) => ({ ...o, status: 200 })), (o) => o.n64)) {
    const refusedMinute = v6out.filter((o) => o.n64 === n64 && per(o) === "minute").length;
    assert.equal(refusedMinute, sent - MINUTE, `/64 number ${n64}: past the minute's ${MINUTE}, each refused for the minute`);
  }
  for (const [ip, got] of tally(out.filter((o) => o.ip?.startsWith("192.")), (o) => o.ip)) assert.equal(got, Math.min(MINUTE, PER_NET), `${ip}: exactly its minute`);
  assert.ok(out.filter((o) => o.ip?.startsWith("192.") && o.status === 429).every((o) => o.said.limit === "minute"), "IPv4 past 15 in the minute: tagged minute");
  for (const [who, got] of tally(out.filter((o) => o.invite), (o) => o.invite)) assert.equal(got, PER_INVITE, `${who}: exactly ${PER_INVITE}`);
  assert.equal(out.filter((o) => o.status === 200 && !o.invite).length, 4 * PER_48 + 12 * Math.min(MINUTE, PER_NET), "the public served, under its total");
}
const secs = (performance.now() - start) / 1000;
assert.ok(secs < 10, `under 10 s (${secs.toFixed(1)} s)`);
console.log(`relay load test passed: 2,200 requests in ${secs.toFixed(1)} s, exactly the caps let through`);
