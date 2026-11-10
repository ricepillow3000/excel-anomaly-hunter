// Anomaly Hunter AI relay (Cloudflare Worker). Lets people John invites use HIS Gemini key without ever having it:
// the key lives only here, as an encrypted Worker secret (GEMINI_KEY). Their engines send their invite code instead.
// Layers that actually protect the key and the free quota (anything on a user's PC could be pulled off it, so
// nothing secret is shipped there):
//   1. invite codes: only their SHA-256 hashes are stored (secret TOKENS = {"<hash>": "name"}); revoke = remove one
//   2. a daily cap per invite code AND one daily cap for everyone together, counted in a Durable Object
//   3. one route, POST /fix, JSON only, at most 8 KB; the model, the answer format and its length are set HERE
//   4. no request or answer is ever logged - only "who, how many today"
// AH-151: a request with no Authorization header at all is the public tier, so every user has AI help with no key or
// invite: its own model (PUBLIC_MODELS) and caps, per network and for everyone, counted apart from the invites'. A
// network (an IPv4 address, an IPv6 /64) is counted under HMAC-SHA-256(GEMINI_KEY, day + network): no IP is stored,
// nobody without the key can reverse it, and it changes every day
// ponytail: a cell can still carry a free-text prompt - the caps, not the shape check, are what bound abuse.
const MODEL = "gemini-3.8-flash";
// Google's free tier gives flash-lite ~500 requests a day per project, gemini-3.8-flash ~20 (2026-11-09)
const PUBLIC_MODEL = "gemini-3.5-flash-lite";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_BODY = 8 * 1024;
// one call to Google may take this long: the invite's fix is already counted, so a hung Google must not hold the
// request until Cloudflare or the engine cuts it (AH-87 audit). 90 s = the engine's own cap on one call (ai/client.py
// min(90, left)); Gemini took 3.8 s to 90 s+ for the same request (2026-10-11)
const GOOGLE_WAIT_MS = 90_000;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A [vars] cap that is missing or not a number falls back to the real quota; "0" means off, not "unset"
// (2026-10-15 audit: `+"0" || 20` turned a switched-off relay back on at 20 a day)
const cap = (v, fallback) => (v !== undefined && v !== "" && Number.isFinite(+v) ? +v : fallback);

// One IPv6 subscriber gets a whole /64 (billions of addresses): an IPv6 address is counted by its /64 prefix, written
// out in full first ("::" drops groups of 0; a dotted IPv4 tail is two groups); an IPv4 address as it is
export function network(ip) {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const groups = (s) => (s ? s.split(":") : []);
  const size = (g) => g.length + (g.at(-1)?.includes(".") ? 1 : 0);
  const h = groups(head), t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(8 - size(h) - size(t)).fill("0"), ...t];
  return all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== "/fix" || req.method !== "POST") return json(404, { error: "This address only takes Ask AI requests from Arcas." });
    // no header at all, never an empty one: a broken invite fails closed (401), it never falls into the public tier
    const pub = !req.headers.has("Authorization");
    let who;
    if (!pub) {
      const code = req.headers.get("Authorization").replace(/^Bearer /, "");
      let tokens;
      try {
        tokens = JSON.parse(env.TOKENS || "{}");
      } catch { // a mistyped TOKENS upload: our own JSON, not Cloudflare's HTML error page
        return json(500, { error: "The shared AI has a setup problem on John's side. Let John know, and try again later." });
      }
      who = code && tokens[await sha256(code)];
      if (!who) return json(401, { error: "This invite code isn't valid (or was switched off)." });
    }

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: "That request is too large for the shared AI. Try a smaller selection." });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "The shared AI couldn't read that request. Update Arcas to the newest version, then try again." });
    }
    const prompt = body?.messages?.[0]?.content;
    if (typeof prompt !== "string" || !prompt || body.messages.length !== 1 || !body.response_format) return json(400, { error: "The shared AI couldn't read that request. Update Arcas to the newest version, then try again." });
    const ip = req.headers.get("CF-Connecting-IP"); // Cloudflare always sets it: without it there is no network to count
    if (pub && !ip) return json(400, { error: "The free AI couldn't read that request. Try again later." });

    // count first: a request that would go over a cap never reaches Google
    // fallbacks = the real quota (if the [vars] are ever lost, never looser); switch the relay off by emptying TOKENS
    // again: a backup model's call (AH-145), counted against the day's total only: the invite's fix is already counted
    // public: its own caps (fallbacks = the design's, never looser; PUBLIC_DAILY_TOTAL "0" switches the tier off)
    const caps = pub ? { pub, perUser: cap(env.PUBLIC_DAILY_PER_NETWORK, 15), total: cap(env.PUBLIC_DAILY_TOTAL, 400) }
      : { perUser: cap(env.DAILY_PER_INVITE, 10), total: cap(env.DAILY_TOTAL, 20) };
    const take = async (again) => (await (await env.COUNTER.get(env.COUNTER.idFromName("caps")).fetch("https://caps/take", {
      method: "POST", body: JSON.stringify({ who, ...caps, again }),
    })).json());
    let ok;
    try { // the counter down (a Durable Object outage): our own JSON, and Google is never called (AH-13 sweep)
      if (pub) who = await hmac(env.GEMINI_KEY, dayKey() + network(ip)); // too many groups throws: refused, never counted
      ok = await take(false);
    } catch {
      return json(503, { error: "The shared AI can't count today's fixes right now. Try again in a minute." });
    }
    if (!ok.allowed) return json(429, { error: ok.why, ...(pub ? { limit: "day" } : {}) });

    // AH-145: MODELS = the model, then backups (each has its own day's free quota and its own crowd); unset = MODEL alone
    const listed = String((pub ? env.PUBLIC_MODELS : env.MODELS) || "").split(",").map((m) => m.trim()).filter(Boolean);
    const models = listed.length ? listed : [pub ? PUBLIC_MODEL : MODEL];
    try {
      let out, said = "", m = 0;
      for (let k = 0; ; k++) { // Google busy for a moment: try again HERE, so the invite's fix is counted only once
        out = await fetch(GEMINI, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GEMINI_KEY}` },
          body: JSON.stringify({ model: models[m], messages: [{ role: "user", content: prompt }], response_format: body.response_format, max_tokens: 4096 }),
          signal: AbortSignal.timeout(GOOGLE_WAIT_MS),
        });
        if (out.ok) break;
        said = await out.text(); // read, never sent on
        // the day's quota gone or overloaded: the next model at once, never back to this one, counted before Google
        if (m + 1 < models.length && ([502, 503].includes(out.status) || (out.status === 429 && /perday/i.test(said)))
          && (await take(true).catch(() => ({}))).allowed) {
          m++;
          continue;
        }
        if (![500, 502, 503, 504].includes(out.status) || k >= 2) break;
        await new Promise((ok) => setTimeout(ok, [1000, 3000][k]));
      }
      // Google's answer goes back as is; on its errors only our own words (its body could echo the key's project)
      // a backup's answer says so (AH-145): the engine keeps it under that model and the pane tells the user
      if (out.ok) return new Response(out.body, { status: 200, headers: { "Content-Type": "application/json", ...(m ? { "X-Model": models[m] } : {}) } });
      if (out.status !== 429) return json(502, { error: `Google AI answered with error ${out.status}. Try again in a few minutes.` });
      // a 429 is either "too many this minute" or "today's free quota is gone" - Google's text says which (read, never sent on)
      const daily = /perday/i.test(said);
      return json(429, { error: daily ? "The shared free AI is used up for today. It resets at midnight US Pacific time."
        : "The shared AI is busy right now. Try again in a minute." });
    } catch (e) { // Google unreachable (network, DNS) or silent: our own JSON, never an uncaught throw
      // a timeout is not tried again: 3 x 90 s would outlast the engine's 240 s for the whole request
      if (e?.name === "TimeoutError") return json(504, { error: "Google AI did not answer in time. Try again in a minute." });
      return json(502, { error: "Couldn't reach Google AI. Try again in a minute." });
    }
  },
};

// The caps' day = Google's quota day: it resets at midnight US Pacific time (summer and winter time), not UTC
export const dayKey = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

// One counter object for all caps: day -> {total, per invite} and, once the public tier is used that day,
// {pub, per network hash}. Single-threaded by design, so counts never race.
export class Counter {
  constructor(state) {
    this.state = state;
  }
  async fetch(req) {
    const { who, perUser, total, again, pub } = await req.json();
    const day = dayKey();
    const c = (await this.state.storage.get("c")) || {};
    const today = c.day === day ? c : { day, total: 0, by: {} };
    const [n, by] = pub ? ["pub", "nets"] : ["total", "by"];
    today[n] ||= 0;
    today[by] ||= {};
    if (today[n] >= total) return json(200, { allowed: false, why: pub ? "The free AI has used up today's requests for everyone. It resets at midnight US Pacific time."
      : "Today's shared AI limit is used up. It resets at midnight US Pacific time." });
    if (!again && (today[by][who] || 0) >= perUser) return json(200, { allowed: false, why: pub ? "The free AI has used today's requests for your network. They reset at midnight US Pacific time."
      : "You've used today's AI fixes for this invite. They reset at midnight US Pacific time." });
    today[n] += 1;
    if (!again) today[by][who] = (today[by][who] || 0) + 1;
    await this.state.storage.put("c", today);
    return json(200, { allowed: true });
  }
}
