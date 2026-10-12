# Council Paper 3 (revised): Rate-Limit Throttling Strategies for the Anomaly Hunter Relay

## Abstract
I checked the throttling in `relay/worker.js` and `backend/anomaly_hunter/ai/client.py` against the code and against Cloudflare, Google, IETF, OWASP and MDN pages that I opened during this session. Most of it is already correct. The atomic per-invite and total daily caps are DONE, and so are the client's backoff with jitter, Retry-After handling, deadline and single-flight lock. Three gaps remain:
- **The day boundary.** The relay counts days in UTC, but Google resets at midnight Pacific.
- **The cap fallbacks.** If the config values are missing, the code falls back to 25 per invite and 200 in total. Both are much looser than the real quota of 20 a day.
- **The timeout order on the relay path.** The client gives up before the relay has finished a call it already counted.

I reject every enterprise rate-limiting pattern I examined. None of them helps a localhost engine talking to a relay on workers.dev that is allowed 20 calls a day.

## Current state (re-read in code this session)
- **Order of checks** (worker.js:23-45): 404, then auth (401), then size and shape checks, and only then the Durable Object `take`. A request that fails any earlier step never reaches the counter or Google.
- **Caps** (worker.js:69-84): one Counter object refuses a call once the total reaches `total` or the invite reaches `perUser`. wrangler.toml:21-22 sets these to 10 and 20.
- **Fallbacks** (worker.js:43): `+env.DAILY_PER_INVITE || 25` and `+env.DAILY_TOTAL || 200`.
- **Relay retries:** worker.js:48-57 retries Google 5xx up to 3 times with 1 s and 3 s waits.
- **Relay 429s:** worker.js:62-64 tells the user "per day" or "per minute" in its own words.
- **Client** (client.py:161-189, 243-262):
  - Waits 2, 4, 8, 16 and 30 s plus jitter, honours a delay-seconds Retry-After, and stops at a 240 s deadline.
  - Does not retry a per-day 429.
  - Allows one call at a time (`_LOCK`, :166/:202).
  - Never retries the relay (`test_the_relay_is_never_retried_by_the_engine`).
  - Each try waits at most 90 s (:238), on the relay path as well.

## Findings
1. **The day boundary (GAP, RL-1).**
   - worker.js:75 keys the day with `toISOString().slice(0,10)`, which is a UTC date. Google's rate-limits page says "Requests per day (RPD) quotas reset at midnight Pacific time" and "Rate limits are applied per project".
   - `DAILY_TOTAL` is 20, the same as Google's daily limit. So the relay can let up to 40 calls through in one Google day.
   - The second 20 get Google's per-day 429 but still use up invite slots, because the counter is charged at worker.js:41-45, before Google is called.
   - Users are also told two reset times: "midnight UTC" (worker.js:78-79) and "Pacific" (worker.js:63, client.py:256).
   - **Is `Intl` available in Workers?** Cloudflare says "All of the standard built-in objects supported by the current Google Chrome stable release are supported". Its exception list (eval, new Function, some WebAssembly calls, Date.now timing) does not name `Intl`.
   - Whether Workers has the time-zone data that `America/Los_Angeles` needs is still UNVERIFIED. If it is missing, `toLocaleDateString` would throw inside Counter and stop the whole relay. So the change must be checked once with `npx wrangler dev` before deploying.
   - In Node, `2026-10-13T06:59Z` gives `2026-10-12` and `07:00Z` gives `2026-10-13`, as expected.
   - **Deploy timing:** `en-CA` keeps the same YYYY-MM-DD format. Deploying between 07:00 and 24:00 UTC, when the UTC and Pacific dates agree, means the stored counter is not reset.
2. **The cap fallbacks (GAP, RL-10, adopted from QA-G7).**
   - MDN lists `0` as falsy, and `||` "returns y" when the left side is falsy. So if the `[vars]` block is missing or a value is mistyped, the caps loosen to 25 and 200.
   - Setting a cap to "0" to switch the relay off also silently gives 25 or 200 instead. I checked this in Node: `+"0"||25` is `25`.
   - relay/test.mjs:28 always sets both vars, so the fallback path is never tested.
3. **Timeout order on the relay path (GAP, RL-11, consensus between QA-F3 and R2-1).**
   - Cloudflare says there is "no hard limit on duration for HTTP-triggered Workers", but work "may be canceled once the client disconnects".
   - The client gives each try at most 90 s (client.py:238), while Gemini has taken more than 90 s (client.py:264).
   - So a slow answer can be thrown away after the invite's slot has already been charged.
4. **What is already done (DONE):**
   - The atomic daily caps (RL-3).
   - The client backoff (RL-5).
   - An explanatory body on every relay 429. RFC 6585 says such responses "SHOULD include details" (RL-6).
5. **What I reject (REJECT):**
   - A pre-auth per-IP limiter (RL-2). A request rejected inside a Worker has already been counted as a Worker request. A WAF rule needs a zone, which means buying a domain. On the Free plan, running out of requests gives Error 1027 until midnight UTC, not a bill.
   - A per-minute throttle (RL-4).
   - A Retry-After header on relay 429s, because nothing would read it (RL-7).
   - Parsing Google's `retryDelay` field (RL-8).
   - Jitter on the relay's own retries (RL-9).

## Debate (contest notes)
- **Expert 1, SEC-1: the fixed UTC-8 offset is not "never early".**
  - In daylight time, a UTC-8 day runs from 08:00 to 08:00 UTC, while Google's day runs from 07:00 to 07:00 UTC.
  - Calls made between 07:00 and 08:00 UTC are counted against the previous relay day but land in the new Google day. The next relay day then allows 20 more, so up to 40 calls can still fall in one Google day.
  - The window is 1 hour instead of 7, but the overlap is still there.
  - **Verdict:** the exact time-zone key is better. Keep the UTC-8 offset as the fallback only if `wrangler dev` shows `Intl` time zones are unsupported.
- **Expert 1, SEC-2: agreed, and it takes over my old operational item.** Google's page confirms that leaving the Free tier requires setting up billing, and that limits are counted per project. I dropped my duplicate item.
- **Expert 2, R2-2: same objection as SEC-1.**
- **Expert 2, R2-1: a 75 s abort is shorter than Gemini's observed latency of more than 90 s** (client.py:264), so the relay would throw away answers it has already counted.
  - My position is that each inner timeout should be shorter than the one outside it. The order should be: relay's total Google budget, then the client's relay timeout, then the pane's 300 s.
  - So keep the try/catch from R2-1 and QA-F2, but set the default budget to about 180 s, and adopt QA-F3 so that the client waits up to its own deadline (240 s) on the relay path.
  - Whether Workers `fetch` honours an AbortSignal is UNVERIFIED. The web-standards page only says AbortController exists.
- **Expert 4, P4-G4: this is overstated as a resource risk.**
  - The 413 check runs after auth and before the counter, so only invitees can send oversized bodies, and they never touch the caps.
  - The engine sends ASCII-escaped JSON (client.py:228, the `ensure_ascii` default), so for every real request, length in characters equals length in bytes.
  - P4-G5 (sending UTF-8) stays safe either way, because the client enforces 7000 bytes.
  - **Verdict:** low priority, as QA-R6 says. If it is done, bundle it with RL-1 in the same deploy.
- **Expert 5, QA-G5: it duplicates SEC-8 and does not stop the risk it names.**
  - security.yml:33 already runs Semgrep with `p/secrets`.
  - GitHub says that on "Public repositories: Secret scanning runs automatically for free."
  - Whether any of these scanners recognises the custom `inv_` invite format is UNVERIFIED. The real guard is .gitignore.
  - A leaked invite is limited to 10 calls a day and can be revoked.
- **Expert 5, QA-G6: a duplicate of RL-1, which this topic owns.** It also cites the wrong line: the cap is at wrangler.toml:22, not :24.
- **Expert 5, QA-G7: adopted as RL-10**, with the kill-switch case above added.

## Recommendations
1. **RL-1, about 4 lines:**
   - worker.js:75: `new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })`.
   - worker.js:78-79: change the wording to "midnight US Pacific time".
   - test.mjs: add day-boundary assertions for a summer case and a winter case.
   - Check with `wrangler dev`, then deploy between 07:00 and 24:00 UTC.
2. **RL-10:** in worker.js:43, change the fallbacks to `|| 10` and `|| 20`. Add one test with the vars left out.
3. **RL-11:** apply QA-F3 as written, and give R2-1 a default of about 180 s.
4. **Leave everything else as it is.**

## References
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://developers.cloudflare.com/workers/runtime-apis/web-standards/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- https://developers.cloudflare.com/waf/rate-limiting-rules/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/ddos-protection/
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Logical_OR
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning
- https://ai.google.dev/gemini-api/docs/troubleshooting
- https://discuss.ai.google.dev/t/429-errors-despite-waiting-after-retrydelay/96899
- https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption
- https://www.rfc-editor.org/rfc/rfc6585#section-4
- https://www.rfc-editor.org/rfc/rfc9110.html
