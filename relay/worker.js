// Anomaly Hunter AI relay (Cloudflare Worker). Lets people John invites use HIS Gemini key without ever having it:
// the key lives only here, as an encrypted Worker secret (GEMINI_KEY). Their engines send their invite code instead.
// Layers that actually protect the key and the free quota (anything on a user's PC could be pulled off it, so
// nothing secret is shipped there):
//   1. invite codes: only their SHA-256 hashes are stored (secret TOKENS = {"<hash>": "name"}); revoke = remove one
//   2. a daily cap per invite code AND one daily cap for everyone together, counted in a Durable Object
//   3. one route, POST /fix, JSON only, at most 8 KB; the model, the answer format and its length are set HERE
//   4. no request or answer is ever logged - only "who, how many today"
// ponytail: a cell can still carry a free-text prompt - the caps, not the shape check, are what bound abuse.
const MODEL = "gemini-3.8-flash";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_BODY = 8 * 1024;

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname !== "/fix" || req.method !== "POST") return json(404, { error: "not found" });
    const code = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    const tokens = JSON.parse(env.TOKENS || "{}");
    const who = code && tokens[await sha256(code)];
    if (!who) return json(401, { error: "This invite code isn't valid (or was switched off)." });

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: "That request is too large." });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Bad request." });
    }
    const prompt = body?.messages?.[0]?.content;
    if (typeof prompt !== "string" || !prompt || body.messages.length !== 1 || !body.response_format) return json(400, { error: "Bad request." });

    // count first: a request that would go over a cap never reaches Google
    const counter = env.COUNTER.get(env.COUNTER.idFromName("caps"));
    const ok = await (await counter.fetch("https://caps/take", {
      method: "POST", body: JSON.stringify({ who, perUser: +env.DAILY_PER_INVITE || 25, total: +env.DAILY_TOTAL || 200 }),
    })).json();
    if (!ok.allowed) return json(429, { error: ok.why });

    const out = await fetch(GEMINI, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.GEMINI_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: prompt }], response_format: body.response_format, max_tokens: 4096 }),
    });
    // Google's answer goes back as is; on its errors only the status (no body: it could echo the key's project)
    return out.ok ? new Response(out.body, { status: 200, headers: { "Content-Type": "application/json" } })
      : json(out.status === 429 ? 429 : 502, { error: out.status === 429 ? "The shared free AI limit is used up for now - try later." : `Google AI answered with error ${out.status}.` });
  },
};

// One counter object for all caps: day -> {total, per invite}. Single-threaded by design, so counts never race.
export class Counter {
  constructor(state) {
    this.state = state;
  }
  async fetch(req) {
    const { who, perUser, total } = await req.json();
    const day = new Date().toISOString().slice(0, 10);
    const c = (await this.state.storage.get("c")) || {};
    const today = c.day === day ? c : { day, total: 0, by: {} };
    if (today.total >= total) return json(200, { allowed: false, why: "Today's shared AI limit is used up - it resets at midnight UTC." });
    if ((today.by[who] || 0) >= perUser) return json(200, { allowed: false, why: "You've used today's AI fixes for this invite - they reset at midnight UTC." });
    today.total += 1;
    today.by[who] = (today.by[who] || 0) + 1;
    await this.state.storage.put("c", today);
    return json(200, { allowed: true });
  }
}
