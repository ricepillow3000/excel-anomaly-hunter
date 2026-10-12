# Council Paper 2 (revised): Reverse Proxy and Relay Architecture

**Expert 2 of 5.** Scope: relay/worker.js, relay/wrangler.toml, relay/new-invite.mjs, relay/test.mjs, and the relay path in backend/anomaly_hunter/ai/client.py. This was read-only. I edited nothing, deployed nothing and did not call the live relay. Every claim below was checked against code or against a page opened in this session.

## Abstract
A Cloudflare Worker on workers.dev is the right zero-cost reverse proxy and key custodian for this tool. It holds the Gemini key, checks invite codes before doing anything costly, fixes the model, caps calls exactly in one SQLite Durable Object, and never forwards Google's error bodies. After the debate, four relay gaps remain:
1. The relay has no bound on Google's wait and no JSON on failure. This merges QA-F2 and QA-F3.
2. The day boundary is wrong. This is the agreed fix shared with SEC-1, RL-1 and QA-G6.
3. The "nothing logged" promise is not true.
4. The second machine can silently wipe the invite list.

I also add one amendment to SEC-2: rotating the key must include deleting the old one.

## Current state (verified)
- **Auth runs first.** It returns 404 or 401 (worker.js:23-27) before the body, the Durable Object or Google is touched.
- **Body checks.** The body must be 8 KB or less, valid JSON, one message, with response_format (worker.js:29-38).
- **Counter before Google.** The counter is charged before the call to Google (worker.js:41-45, 69-84).
- **Retries.** Google 5xx answers get 3 tries (worker.js:48-57). Google's error bodies are dropped (worker.js:58-64).
- **Client.** The client never retries the relay (client.py:243-248). Its timeout is capped at 90 s, even on the relay path (client.py:238).
- **Pane.** The pane waits up to 300 s (frontend/features/ai.js).

## Findings
1. **Topology.** A Custom Domain needs "An active Cloudflare zone", which would mean buying a domain. Cloudflare calls workers.dev "intended for personal or hobby projects that aren't business-critical", which fits an invite-only tool.
2. **Limits.** The Free plan gives 10 ms CPU, 128 MB per isolate, a 100 MB request body and 100,000 requests a day. Past that daily limit Cloudflare returns Error 1027, and the limit resets at midnight UTC. "There is no hard limit on duration for HTTP-triggered Workers" and "no set time limit on individual subrequests".
3. **Counter consistency.** Durable Object storage is "transactional and strongly consistent (serializable)", and input gates hold back other events while storage runs. Free-plan Durable Objects must be SQLite-backed (wrangler.toml:14), with 100k requests and 100k rows written per day.
4. **No Google timeout and no catch (worker.js:47-57).** Cloudflare says to wrap a failing fetch in try/catch, because an uncaught exception becomes Error 1101. `signal` is a documented RequestInit option ("the request can be canceled by triggering an abort"), and setTimeout and AbortController are supported.
5. **Logging.** The `[observability]` `enabled` setting "Defaults to `true` for all new Workers", and Free-plan logs are kept for 3 days. Redaction of the Authorization header comes only from a 2021 blog post, and the current docs do not confirm it (UNVERIFIED). That is one more reason to switch logging off.
6. **Secrets.** `wrangler secret put` "creates a new version of the Worker and deploys it immediately", and secret values cannot be read back. new-invite.mjs:22 starts from `{}` when tokens.json is missing, and line 42 uploads the whole list.

## Debate
**vs Security (SEC):**
- **SEC-6 is marked DONE but should read "accepted, UNVERIFIED".** The DDoS page says unmetered L3-7 protection is on every plan, but it never mentions Workers or workers.dev.
- **SEC-2 rotates the key without deleting the old one.** Re-running `wrangler secret put` alone leaves a leaked key working. Google's rotation flow ends with "Delete the previous key", so I add that step as R2-5.
- **Concession:** SEC-13 is right. "Version URLs are not generated for Workers that implement a Durable Object". I withdraw my preview_urls reasoning in R2-14.

**vs Rate limiting (RL):**
- **RL-1 relies on Intl with an America/Los_Angeles time zone.** Cloudflare's web-standards page does not mention time zones. RL-1's own check runs in relay/test.mjs, which is Node with full ICU, so a pass there proves nothing about workerd.
- **A fixed UTC-8 offset is plain arithmetic** and gives the same result in both runtimes. During daylight time it resets one hour after Google, which is the safe side.
- **RL-1's test boundary only works for Intl.** It expects the day to change at 07:00Z, which matches Intl in daylight time. With the fixed offset the boundary is 08:00Z, so that test would fail. Pick the fixed offset and test at 08:00Z.

**vs Payload (P4):**
- **P4-G4's Content-Length pre-check is not a real bound.** A request does not have to send that header (chunked upload; not confirmed for incoming Workers requests, UNVERIFIED). Only `arrayBuffer().byteLength` measures the real size.
- **Its own risk text matches QA-R6's REJECT.** It says "Low ... not urgent".
- **Ruling:** do the byteLength-only check as an optional extra in the R2-1 redeploy, and drop the header check.
- **P4-G5 (`ensure_ascii=False`) is safe under either relay check,** because the client budget of 7000 UTF-8 bytes is below 8192 bytes.

**vs QA:**
- **Concession on QA-F3.** My draft's "524 at about 100 s" has no source in the repo or the docs. The 524 page covers origin servers and never mentions Workers, and the limits page sets no duration limit. The 90 s client cap is therefore wrong for the relay.
- **QA-F3 alone still leaves a hang with no JSON answer.** Merged design: the relay's whole Google budget is 180 s and it then answers JSON 504. The client waits for the remaining deadline (up to 240 s). The pane waits 300 s. Each layer gives up after the one inside it, so the user always gets JSON.
- **Endorsed: QA-G7.** The fallbacks of 25/200 at worker.js:43 are real. Small correction: the vars are at wrangler.toml:21-22, not 23-24.
- **Endorsed: QA-F2's TOKENS guard.** new-invite.mjs:45 tells John to hand-edit tokens.json, so a malformed secret is plausible.
- **QA-G5 vs SEC-8 is for the chair to decide.** Note that CI secret scans only see a secret after it has already been pushed.

## Recommendations (smallest changes)
1. **R2-1.** In worker.js, add one AbortController with a 180 s timer, give its `signal` to every Google fetch, and wrap the retry loop and the TOKENS parse in try/catch. The answers are JSON: 504 if the timer fired, 502 for a network error, 500 for a bad TOKENS secret. In client.py:238, the relay path uses the remaining deadline instead of the 90 s cap. Add three cases to test.mjs: a fetch that rejects, a fetch that hangs, and a bad TOKENS secret.
2. **R2-2.** Add `dayKey(ms = Date.now()) => new Date(ms - 8*3600e3).toISOString().slice(0,10)`. Change the reset wording to "midnight US Pacific time". Test the boundary at 08:00Z.
3. **R2-3.** Add `[observability]` with `enabled = false` to wrangler.toml.
4. **R2-4.** Make new-invite.mjs print a warning when tokens.json is missing.
5. **R2-5.** Add to SEC-2: rotate the key in Google Cloud, run `wrangler secret put GEMINI_KEY`, then use "Delete the previous key".

**Rejected:** a custom domain or WAF (needs a paid zone), the Rate Limiting binding ("eventually consistent", per location, 10 or 60 s windows), refunding the cap when Google fails, a Content-Length pre-check, and a reverse proxy or WSGI server in front of the 127.0.0.1 engine (Waitress "Does not support TLS natively"; SEC-12 and QA-R2 agree).

## References
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/request/
- https://developers.cloudflare.com/workers/runtime-apis/fetch/
- https://developers.cloudflare.com/workers/runtime-apis/web-standards/
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://blog.cloudflare.com/introducing-workers-dashboard-logs/
- https://developers.cloudflare.com/workers/configuration/secrets/
- https://developers.cloudflare.com/workers/configuration/previews/
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- https://developers.cloudflare.com/durable-objects/reference/glossary/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/ddos-protection/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://docs.cloud.google.com/docs/authentication/api-keys
- https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption
- https://flask.palletsprojects.com/en/stable/deploying/
- https://docs.pylonsproject.org/projects/waitress/en/stable/