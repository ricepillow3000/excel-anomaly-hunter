# Security and launch checklist

Each item is either enforced, with the code and the test that keep it so, or does not apply, with the reason.
Last full run: 2026-10-15, against the real HTTPS engine, the relay harness and Chromium. Re-check with
`python tools/check.py --e2e` (`e2e/all.sh` runs the launch checks in `e2e/launch.mjs`).

## Measured on 2026-10-15 (Linux container, 4 cores, the real HTTPS engine)
- **Flood:** 4,000 requests from 100 threads (scans, malformed and 20k-deep bodies, forbidden hosts). Every answer was
  right (200/400/400/403), with 0 client errors. `/health` answered 1,401 of 1,401 checks during it: median 22 ms, worst 2 s.
- **Heavy load:** 16 scans of 120k cells at once all returned 200 in 45 s, and each found the same 20 planted typos.
  Three 2M-cell scans at once all returned 200 in 116 s (peak memory 2.5 GB); `/health` never failed.
- **Slow clients:** 300 slowloris connections held open left `/health` at 15 ms; the engine dropped all 300 after its
  60 s timeout, and its threads went back to 7. Before the fix, one silent connection froze it.
- **After the storm:** the e2e sheet still gave exactly its 5 planted rows. Memory levels off at about 850 MB under
  repeated 2M-cell scans; it does not keep growing.
- **The 2-of-500 failure:** 5 fresh 500-row credit sheets over HTTPS. All 972 of 972 defect rows were flagged, and
  0 of 1,528 clean rows.
- **Launch:** the pane was ready in 264-319 ms at 320, 360 and 500 px wide, with no sideways scroll. The main button
  ends at 114 px of 600, every control is named, and there were no page errors.

What this product is: an Excel task pane served by a local engine on 127.0.0.1 (one user, this PC). It is not a public
website. There are no accounts, logins, sessions, payments, uploads or webhooks. The one thing on the internet is the
AI relay, a Cloudflare Worker that only invited users can call.

## Security
| Item | Status | Where / evidence |
|---|---|---|
| XSS | Enforced | Every dynamic value written with `innerHTML` goes through `esc()` (`frontend/utils/text.js`); saved limits pass `asNumber()`. The CSP allows scripts only from our own files and office.js (`server.CSP`, exact string tested in `test_safe_headers_on_every_answer`). Semgrep `p/xss` runs in CI. |
| CSRF | Enforced | Host must be localhost and Origin must be the pane, before any body is read (`own_panel_only`). Covers every route automatically (`test_every_route_refuses_other_websites`). A cross-site `text/plain` "simple" POST is not parsed as JSON (400). |
| Insecure file uploads | N/A | There is no upload route; the pane sends cell values as JSON. `/key` writes one fixed file name, and only `[A-Za-z0-9_.-]` passes. |
| Path traversal | Enforced | Werkzeug `safe_join` serves only `frontend/`. `../`, `%2e%2e`, `%5c`, backslash, double-encoding, `....//`, `/etc/passwd` and `/.git/config` were all refused live (`test_no_file_outside_the_pane_is_served`). |
| SSRF | N/A by design | The engine only calls constants: Google's URL, or the relay URL this PC sets (HTTPS only, `client.provider`). Nothing in a request chooses a URL. AI-suggested formulas that reach outside the workbook (WEBSERVICE, external links) are dropped (`test_suggest_fix_drops_formulas_that_reach_outside_the_workbook`). |
| Broken password resets, passwords, default credentials | N/A | No accounts. The only secrets are the user's own Google key (stored in `%LOCALAPPDATA%`, never echoed: `test_the_key_never_comes_back_even_when_google_echoes_it`) and relay invite codes (only SHA-256 hashes stored in the Worker). |
| Weak session management, JWT secrets | N/A | No sessions, cookies or tokens. The relay uses a 144-bit invite code per user, revocable. |
| Permissive CORS | Enforced | No `Access-Control-Allow-Origin` on any answer; a preflight from another site gets 403. |
| Rate limits | Enforced where it costs money | Relay: per-invite and total daily caps, counted before Google is called. A 500-call parallel burst let exactly the cap through (`relay/test.mjs`). Engine: one user on 127.0.0.1, one AI call at a time (`client._LOCK`), answers cached. |
| The live relay, from outside | Enforced | `relay/live-probe.mjs` sends a dozen stranger requests to the deployed Worker (no invite, path/method/size/CORS tricks) and needs all refused with the relay's own JSON and no CORS grant. Proven against the real `worker.js` locally (12/12) and against an open fake relay (0/12, so it can fail). Runs from GitHub (`relay-live.yml`: relay changes, daily, Run workflow) because the dev sandbox can't reach workers.dev. |
| Exposed environment | Enforced | `/health` returns only `status`, `ai_available` and `ai_provider`. Engine errors say "details in server.log", never a stack trace (`test_an_engine_bug_is_logged_not_leaked`). The Server header is "Anomaly Hunter" with no versions. `.env*`, `.dev.vars*`, `invite-code.txt` and `relay/tokens.json` are gitignored. |
| Unsigned webhooks | N/A | None. |
| Front-end payment checks | N/A | No payments. |
| IDOR / BOLA | N/A | One user per engine, no object IDs. Relay caps are keyed by the invite's hash, so one invite can't spend another's allowance. |
| API + user input | Enforced | Every body is checked by `_bad` and route checks; malformed, deep or huge bodies get 400 on every route (`test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, derived from Flask's routes). Schemathesis fuzzes every route (`test_fuzz_api.py`). The Power BI CSV neutralises formula cells (`_inert`). |
| Exposed logs | Enforced | `server.log` lives in `%LOCALAPPDATA%\AnomalyHunter`, outside the served folder. Relay logs are off (`wrangler.toml [observability] enabled = false`). |
| Exposed source maps | N/A | No build step and no source maps (`grep sourceMappingURL frontend` is empty). The pane's own code is served, by design, to the one local user. |
| Denial of service | Enforced | A connection that never says hello no longer freezes the engine (`test_one_silent_connection_does_not_freeze_the_engine`). Body capped at 256 MB and 2M cells; a 1 GB declared body gets 413 before it is read. Overload results are below. |
| TLS | Enforced | 127.0.0.1 only (refused on the LAN IP); TLS 1.0 and 1.1 refused; certificate name-constrained to localhost (`test_cert_chain_only_vouches_for_localhost`). |
| Known-vulnerable dependencies | Enforced | `pip-audit` in CI and `tools/check.py`; dependencies pinned in `pyproject.toml`. |

## Launch
| Item | Status | Where / evidence |
|---|---|---|
| Loads under 2 s | Measured | 264-319 ms (`e2e/launch.mjs`). No framework and no build: plain ES modules from 127.0.0.1. |
| Mobile breakpoints | Measured at task-pane widths | Office's task pane is 320 px at its narrowest. `launch.mjs` checks for no sideways scroll at 320, 360 and 500 px. |
| CTA above the fold | Measured | "Find problems in this sheet" is checked to be fully visible at 600 px high. |
| Sticky CTA | N/A | The pane is one short screen. Once results show, the list is the next step and each row opens its own card. |
| Alt text on every image | Measured | `launch.mjs` counts `<img>` without `alt`. Icons load through `<link>` and the manifest. Every visible control must have a name. |
| Form error states | Enforced | Limits editor: "Flag below is bigger than Flag above" is refused in place. Key form: a junk key is refused, and an empty Save asks for a key (`e2e/run.mjs`). |
| Favicon set | Enforced | 16/32/64/80 px icons in `frontend/assets/`, the sizes Office's ribbon asks for (`manifest.xml`). |
| Custom 404 | Deliberate | Any unknown path answers JSON `{"error": ...}`, like every other error (ZAP flagged Werkzeug's HTML page). The pane never navigates, so a user never meets a 404 page. |
| Meta description, Open Graph image, robots.txt, sitemap.xml | N/A | Not a public site: it is served only to this PC inside Excel, and search engines can't reach 127.0.0.1. |
| Thank-you pages | N/A | No sign-up or purchase. Confirmations are inline: "Accepted", "Key saved", "Highlights removed". |
| Cookie banner | N/A | No cookies. The only stored setting is the auto-fix on/off choice (`localStorage`, strictly necessary, never sent anywhere). |
| Analytics | Not installed, deliberately | The pane promises that numbers and whole rows never leave the PC, and the CSP blocks third-party scripts. Adding analytics is the owner's decision; it would need a privacy note and a CSP change. |
| Privacy policy, contact details | Done | `PRIVACY.md` says what stays on the PC (every file it keeps), what AI help sends and where, what the relay keeps (a daily count per invite, no data), and that Google's free tier may use it. Linked from the README and the pane's AI help section. Contact: the repo's public GitHub Issues - no personal details invented. |
