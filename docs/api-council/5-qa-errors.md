# Council Paper 5 (revised): API Quality Assurance and Error Handling

## Abstract
I audited the Excel Anomaly Hunter API read-only: the Flask engine (`backend/anomaly_hunter/server.py`), the AI client (`ai/client.py`), the Cloudflare relay (`relay/worker.js`), the tests and the CI. I re-ran everything this session: `pytest -q backend/tests` gives 186 passed and 1 xfailed, `node relay/test.mjs` passes, and `node frontend/selfcheck.js` passes. Error handling on the engine is solid. Three real defects remain, all on the AI path:
1. The Claude call has no timeout.
2. The relay can throw uncaught exceptions.
3. On the relay path, the client gives up before the relay's own retries can finish.

Three cheap gaps also remain: the self-check is not in CI, the relay's fallback caps are wrong, and the relay's error words have no test. Each fix is a few lines. After the debate I dropped two of my own items. gitleaks in CI duplicates existing scanning. The day-boundary fix is owned by topic 3.

## Current state (verified)
- **One error shape.** Every engine error is `{"error": ...}`. `server.py:96-98` turns every HTTPException into JSON. Flask passes uncaught exceptions to the 500 handler as an `InternalServerError`, which is a subclass of HTTPException. This is tested by `test_every_error_is_json_never_a_framework_html_page`.
- **Generic 500s, details in the log only** (`server.py:113-115, 223-225, 238-240`). This matches OWASP's Error Handling Cheat Sheet: send a generic message and log the details on the server.
- **Retries at one layer only, with capped backoff, jitter, Retry-After and a 240 s deadline** (`client.py:161-189, 249-262`). The engine never retries the relay (`test_the_relay_is_never_retried_by_the_engine`). AWS warns that independent retries at each layer can multiply load by 243x.
- **Claude SDK errors are mapped** (`server.py:137-142`). I checked that `APITimeoutError` is a subclass of `APIConnectionError` in the installed anthropic 1.11.0, so a timeout already comes back as a JSON 503.
- **CI token is least-privilege** (`security.yml:11-12`).

## Findings
**F1. The Claude call has no timeout.** `client.py:221` uses SDK defaults. Anthropic's docs say requests "time out after 10 minutes" and timeouts are "retried twice by default". `_ask` holds `_LOCK` for the whole call (`client.py:202-207`), but the pane gives up at 300 s. So every other AI request then gets "AI is still working" for up to about 30 minutes. Fix: `anthropic.Anthropic(timeout=max(1, deadline - time.monotonic()), max_retries=0)`. The 503 mapping already exists.

**F2. Relay exceptions are uncaught.** `worker.js:49` (Google fetch) and `:25` (`JSON.parse(env.TOKENS)`) have no try/catch. Cloudflare says an uncaught exception gives the client "an error page" with code 1101, and it advises wrapping fetch in try/catch and returning a 5xx. The invite's call is already counted by then (`:41-45`). This is merged with the catch half of R2-1.

**F3. The relay-path timeout is shorter than the relay's work.** The client cuts each relay call at 90 s (`client.py:238`) and never retries it. Meanwhile the relay may make 3 Google tries plus 4 s of waits (`worker.js:48-57`), and Gemini latency of 90 s or more has been measured (`client.py:264`). Cloudflare says "There is no set time limit on individual subrequests" and "No limit" on HTTP duration. AWS sets timeouts from the downstream's latency percentiles. Fix: on the relay path, set the timeout to the remaining deadline (at most 240 s, below the pane's 300 s).

**G4.** CI never runs `frontend/selfcheck.js`.

**G7.** `worker.js:43` falls back to `|| 25` and `|| 200`, against the real 10 and 20 (`wrangler.toml:21-22`).

**G8.** No engine test covers the relay's error words, the 401 "Ask John" hint, or a non-JSON (1101) body (`client.py:243-248`).

## Debate
**Topic 1 (Security), SEC-8 vs my G5: I concede.** GitHub secret scanning "runs automatically for free" on public repositories over the "entire Git history", and push protection for users "is enabled by default" for public repositories. Semgrep `p/secrets` already runs in CI. A gitleaks job runs after the push, so it is too late for a public repo anyway. G5 becomes REJECT.

**SEC-6 is mislabelled.** It is marked DONE, but Cloudflare's DDoS page never mentions Workers or workers.dev. It should read "accepted residual, UNVERIFIED for workers.dev", not DONE.

**Topic 2 (Relay), R2-1: I accept the try/catch and challenge the 75 s abort timer.** A single 75 s budget across all 3 Google tries is below Gemini's measured 90 s+ latency. It would turn slow successes into 504s after the invite's slot is spent, which is the same loss F3 fixes on the client side. AWS's guidance is to set the timeout from the downstream's latency, not below it. A hung Google call is already bounded: the engine stops at its 240 s deadline, and Cloudflare says that when the client disconnects, the request's tasks "may be canceled". Whether Workers' fetch honours `AbortSignal` is unverified by R2 itself. Verdict: catch only, no timer.

**Topic 3 (Rate limits), RL-1: I agree on the GAP and drop my duplicate G6, but prefer SEC-1/R2-2's fixed offset.** The fix is `new Date(Date.now() - 8*3600e3)`. It needs no `Intl` `timeZone` support, which none of us could verify in workerd. During daylight time it resets one hour after Google, never before, so it is always on the safe side. It is also easy to test by stubbing `Date.now`. QA addition: `worker.js:77` resets the count whenever the stored day differs from the new key. Deploying while the UTC date is ahead of the Pacific date, between 00:00 and 08:00 UTC, would hand out one extra batch of 20. Deploy after 08:00 UTC.

**Topic 4 (Payload), P4-G1: the 256 MB cap does not bound RAM.** I measured `json.loads` on an 8.4 MB body of tiny cells and it used 38.4 MB, about 4.6x. Integers and distinct strings cost more. A 256 MB body therefore means more than 1 GB of Python objects before `_bad` or the cell cap in P4-G2 runs. I accept G1 and G2 together as cheap, clean 413 and 400 answers instead of a MemoryError 500, and I drop my R3 reject. But the code comment must not claim memory safety. P4-G2's cell check runs after parsing, so it bounds pandas but not the JSON parse. On P4-G4 versus my R6: it is low risk, and I don't object to bundling it into the same relay deploy as F2, G7 and RL-1, so I drop R6 as owned by topic 4.

## Rejected
- **RFC 9457 problem+json.** It is optional, there is one client, and the error shape is already consistent.
- **Production WSGI server.** Waitress has no native TLS and the pane needs HTTPS.
- **Finer status codes.** The pane shows only the error text.
- **SHA-pinning actions.** The workflow holds no secrets and has a read-only token.
- **gitleaks CI job.** See the Debate section.
- **75 s relay abort timer.** See the Debate section.

## References
- https://platform.claude.com/docs/en/api/sdks/python
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/
- https://developers.cloudflare.com/ddos-protection/
- https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter
- https://docs.python.org/3/library/urllib.request.html
- https://flask.palletsprojects.com/en/stable/errorhandling/
- https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection
- https://docs.github.com/en/billing/concepts/product-billing/github-actions
- https://www.rfc-editor.org/rfc/rfc9457.html
- https://docs.pylonsproject.org/projects/waitress/en/stable/
- https://docs.github.com/en/actions/reference/security/secure-use
