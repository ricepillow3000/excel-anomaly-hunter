# Council Paper 1 (revised): API Security and DDoS Mitigation

## Abstract
I re-read worker.js, wrangler.toml, new-invite.mjs, server.py, client.py, test.mjs, security.yml and .gitignore at commit 4791d89, then re-checked every claim against sources opened in this round. The verdict has not changed: most controls are already in place, and floods against a free workers.dev Worker cost availability, not money. Contesting the other papers changed four things:
1. **My day-boundary fix was wrong.** A fixed UTC-8 offset does not stop the relay going over Google's daily quota. Only an exact Pacific-time day does.
2. **"Nothing is logged" is false.** Workers observability is on by default, so I co-sign R2-3.
3. **I concede MAX_CONTENT_LENGTH to P4-G1.**
4. **SEC-2 is narrowed.** A paid Gemini project serves requests only while it has prepaid credit, so a leaked key's damage is bounded. The console check is still worth doing.

## Current state (verified)
**Relay:**
- Auth runs before any work (worker.js:23-27).
- Each invite code carries 144 bits (new-invite.mjs:21). OWASP asks for at least 64 bits and estimates about 585 years to guess a 64-bit ID.
- Only SHA-256 hashes of the codes are stored.
- The body is capped at 8 KB, must be JSON and must hold exactly one message (worker.js:29-38).
- The Durable Object caps are counted before Google is called (worker.js:40-45).
- The upstream URL and model are fixed in the Worker.
- Google's error bodies are never forwarded.

**Engine:**
- Bound to 127.0.0.1.
- A Host and Origin gate runs before any body is read (server.py:80-84).
- CSP, nosniff and no-store headers; every error is JSON.
- AI answers are schema-validated, and formulas that reach outside the workbook are blocked.

**Repo:** no secret file is tracked. `git ls-files` finds no `*.zip`, `invite-code.txt` or `tokens.json`.

## Findings (OWASP API Top 10 2023)
- **API2 (authentication): done.**
- **API4 and API6 (resource consumption, business-flow abuse): mostly done, two flaws remain.**
  - The day key at worker.js:75 is the UTC date, but Google's requests-per-day quota "reset[s] at midnight Pacific time" and is counted per project.
  - The fallback caps at worker.js:43 are `|| 25` and `|| 200`, while the real quota is 20/day (QA-G7). OWASP API4 says to "configure spending limits for all service providers".
- **Floods:**
  - Workers Free allows 100,000 requests/day. Past that, Cloudflare returns Error 1027 until midnight UTC.
  - No overage price is listed for the Free plan.
  - Cloudflare lists "Standard, unmetered DDoS protection (layers 3-7)" for the Free plan. Whether that covers workers.dev is UNVERIFIED.
  - Conclusion: accept the residual risk.
- **Denial of wallet:**
  - The relay's Google project should stay unbilled. On the Paid tier, Gemini "will only serve requests if you have a positive" Prepay balance.
  - Google advises adding API restrictions to keys, rotating them and monitoring usage.
- **API8 (misconfiguration):** observability defaults to `true` for all new Workers, and Free-plan logs are kept for 3 days. That contradicts the promise at worker.js:8. Which headers are kept or redacted is UNVERIFIED.
- **API7, API9, API10:** done. Version URLs are not generated for a Worker that implements a Durable Object.

## Debate
**vs Reverse Proxy and Relay (topic 2):**
- *R2-2, and my own SEC-1 draft: the fixed UTC-8 offset is wrong.* In summer the relay day [08:00Z, 08:00Z) is out of step with the Google day [07:00Z, 07:00Z). Unused allowance from the previous relay day can be spent between 07:00 and 08:00Z, and then the new relay day gives 20 more. That is up to 40 in one Google day. The window shrinks from 7 hours to 1, but my claim that the offset "never" went over was false. Only an exact `America/Los_Angeles` day closes the gap.
- *R2-1: I contest the AbortController part.* Cloudflare's fetch page does not document a `signal` option (UNVERIFIED). HTTP Workers have "no hard limit on duration". A 75 s abort would throw away slow answers that succeed, which conflicts with QA-F3. Keep only the try/catch (QA-F2). Uncaught exceptions really do become Error 1101 ("Worker threw a JavaScript exception").
- *R2-3: co-signed.* Wrangler docs say `enabled` "defaults to true for all new Workers".

**vs Rate-Limit Throttling (topic 3):**
- *RL-1 has the right fix, with two caveats.*
  - Its Node test cannot prove workerd's ICU time-zone support. Cloudflare's docs confirm only that `Intl` exists, so check it once with local `wrangler dev`.
  - The claim "Deploying may reset the counter once, harmlessly" is not quite true. `en-CA` gives the same YYYY-MM-DD format as ISO. A deploy between 00:00 and 07:00Z changes the key in the middle of a Google day and gives out a fresh 20. Deploy between 07:00 and 23:59 UTC.
- *RL-2:* the binding is "eventually consistent" and per location, and Cloudflare advises against IP keys. Agreed, reject.

**vs Payload Validation (topic 4):**
- *P4-G1: I withdraw my SEC-11 reject.* Werkzeug says `get_data()` "is only safe to do if the max_content_length is set". A 256 MB cap is one line and does not refuse a measured 20.6 MB sheet. It is a robustness item, not an attack defence: the Origin gate already blocks other websites.
- *P4-G3: the method contradicts its own source.* OWASP says single-quote prefixes are "not reliable in Microsoft Excel after saving and re-opening". OWASP's Excel-safe method is a tab inside the quoted field. OWASP also warns that the prefix "may affect downstream processing", and this CSV's main consumer is Power BI. The `-` rule would also prefix text like "-5". If adopted, use a tab, skip numeric-looking text, and accept the Power BI side effect. Otherwise document the risk.
- *P4-G4:* `Content-Length` can be missing, so a header pre-check is only advisory. Only invitees who pass auth reach this line. I side with QA-R6 and R2-14: reject.

**vs QA and Error Handling (topic 5):**
- *QA-G5 (gitleaks in CI): contested.*
  - The threat it cites is a force-added kit zip. Gitleaks scans archives only with `--max-archive-depth`, and "0" (the default) disables that.
  - `inv_` codes are a custom format; whether `generic-api-key` matches them is UNVERIFIED.
  - Semgrep `p/secrets` already runs. GitHub secret scanning "runs automatically for free" over the full history, and push protection is "enabled by default".
  - If the Council wants a gate anyway, a two-line `git ls-files | grep -E '\.zip$|invite-code\.txt$|tokens\.json$' && exit 1` covers the stated threat with no dependency.
- *QA-R3 (reject the cap): superseded by P4-G1* (see above).
- *QA-G7: co-signed.* The fallback caps should fail safe.

## Recommendations
- **GAP:** SEC-1 (Pacific day, implemented once with RL-1) and SEC-2 (console check).
- **Co-signed, owned elsewhere:** R2-3, QA-F2, QA-G7, P4-G1.
- **Rejected:** WAF rules and the Rate Limiting binding, lockouts, an engine token, gitleaks in CI, relay security headers. The Waitress swap is also rejected (consensus, owned by R2-13).

## References
- https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption
- https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
- https://community.owasp.org/attacks/CSV_Injection
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/billing
- https://docs.cloud.google.com/docs/authentication/api-keys-best-practices
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/observability/logs/workers-logs/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/runtime-apis/web-standards/
- https://developers.cloudflare.com/workers/runtime-apis/fetch/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- https://developers.cloudflare.com/workers/configuration/previews/
- https://developers.cloudflare.com/ddos-protection/
- https://werkzeug.palletsprojects.com/en/stable/request_data/
- https://github.com/gitleaks/gitleaks
- https://github.com/gitleaks/gitleaks-action
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning
- https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection