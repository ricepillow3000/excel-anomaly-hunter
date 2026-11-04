# Security and launch checklist

Each item is either enforced, with the code and the test that keep it so, or does not apply, with the reason.
Last full run: 2026-10-15 (John's later lists re-checked 2026-11-04, AH-102), against the real HTTPS engine, the relay harness and Chromium. Re-check with
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

What this product is: an Excel task pane served by a local engine on 127.0.0.1 (one user, this PC). There are no
accounts, logins, sessions, payments, uploads or webhooks. Two things are on the internet: the AI relay, a Cloudflare
Worker that only invited users can call, and the public website (`site/`, three static pages on GitHub Pages).
John's full 75-item speed, legal and security list is answered item by item at the end (AH-87, 2026-11-02).

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
| The live relay, from outside | Enforced | `relay/live-probe.mjs` sends a dozen stranger requests to the deployed Worker (no invite, path/method/size/CORS tricks) and needs all refused with the relay's own JSON and no CORS grant. Proven against the real `worker.js` locally (12/12) and against an open fake relay (0/12, so it can fail). Runs from GitHub (`relay-live.yml`: relay changes, daily, Run workflow) because the dev sandbox can't reach workers.dev. With the secret `RELAY_CANARY_INVITE` set it also makes one real call (`relay/canary.mjs`) and needs a 200 the engine can read: refusals alone never showed a revoked Gemini key or a retired model (AH-108). Proven offline against the real `worker.js`: a 401 invite and Google's 403 fail it. |
| Exposed environment | Enforced | `/health` returns only `status`, `version`, `ai_available` and `ai_provider`. Engine errors say "details in server.log", never a stack trace (`test_an_engine_bug_is_logged_not_leaked`). The Server header is "Arcas" with no versions. `.env*`, `.dev.vars*`, `invite-code.txt` and `relay/tokens.json` are gitignored. |
| Unsigned webhooks | N/A | None. |
| Front-end payment checks | N/A | No payments. |
| IDOR / BOLA | N/A | One user per engine, no object IDs. Relay caps are keyed by the invite's name (`tokens[sha256(code)]`), and `relay/new-invite.mjs` keeps one live code per name, so one invite can't spend another's allowance. |
| API + user input | Enforced | Every body is checked by `_bad` and route checks; malformed, deep or huge bodies get 400 on every route (`test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, derived from Flask's routes). Schemathesis fuzzes every route (`test_fuzz_api.py`). The Power BI CSV neutralises formula cells (`_inert`). |
| Exposed logs | Enforced | `server.log` lives in `%LOCALAPPDATA%\AnomalyHunter`, outside the served folder. Relay logs are off (`wrangler.toml [observability] enabled = false`). |
| Exposed source maps | N/A | No build step and no source maps (`grep sourceMappingURL frontend` is empty). The pane's own code is served, by design, to the one local user. |
| Denial of service | Enforced | A connection that never says hello no longer freezes the engine (`test_one_silent_connection_does_not_freeze_the_engine`). Body capped at 256 MB and 2M cells; a 1 GB declared body gets 413 before it is read. Overload results are below. |
| TLS | Enforced | 127.0.0.1 only (refused on the LAN IP); TLS 1.0 and 1.1 refused; certificate name-constrained to localhost (`test_cert_chain_only_vouches_for_localhost`). |
| Known-vulnerable dependencies | Enforced | `pip-audit` in CI and `tools/check.py`, on what is installed and on every pin in `constraints.txt` (`--strict`: a name PyPI doesn't know fails); every package, indirect ones too, pinned in `constraints.txt` (`tools/pinned.py`). |

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
| Meta description, Open Graph, robots.txt, sitemap.xml | Pane: N/A. Site: done in AH-119 | The pane is served only to this PC inside Excel; search engines can't reach 127.0.0.1. Each site page has its own title, description, canonical link and Open Graph tags, and `site/sitemap.xml` lists the three. No Open Graph image (the only images are 32 and 64 px marks, too small for a card) and no robots.txt (crawlers read it only at a domain's root). |
| Thank-you pages | N/A | No sign-up or purchase. Confirmations are inline: "Accepted", "Key saved", "Highlights removed". |
| Cookie banner | N/A | No cookies anywhere (pane, engine, relay, site; GitHub Pages sets none). Two `localStorage` choices, `anomalyHunterAutoFix` and `anomalyHunterPowerBi`, strictly necessary and never sent anywhere; the site stores nothing. |
| Analytics | Not installed, deliberately | The pane promises that numbers and whole rows never leave the PC, and the CSP blocks third-party scripts. Adding analytics is the owner's decision; it would need a privacy note and a CSP change. |
| Privacy policy, contact details | Done | `PRIVACY.md` says what stays on the PC (every file it keeps), what AI help sends and where, what the relay keeps (a daily count per invite, no data), and that Google's free tier may use it. Linked from the README and the pane's AI help section. Contact: the repo's public GitHub Issues - no personal details invented. |

## John's 75-item list (AH-87, 2026-11-02)
Every item, in John's order: **Enforced** (code + the test that keeps it), **Measured**, **Fixed in AH-87** (with its
test), or **N/A** with the reason. This app has no server crowds hit, no database, no accounts and no payments: the
engine runs on each user's own PC beside their Excel, so items written for a web service are answered for what exists.

### Speed
| Item | Status | Where / evidence |
|---|---|---|
| Images in WebP or AVIF | N/A | Every image is under 3 KB and in the format its reader requires: Office's ribbon and manifest need PNG (`frontend/assets/crest2-*.png`), the site's only images are two PNG favicons, its logo is inline SVG, the grain is SVG. WebP would save bytes nobody downloads twice. |
| Prevent duplicate API calls | Enforced (fixed in AH-87) | Every pane action runs through `act()`, which ignores a second click while one is in flight (`hooks/use-action.js`); Ask AI has its own guard; the engine's AI lock answers "still working" and its cache never asks Google the same question twice. Save key and Remove key were outside it: now inside (`e2e/run.mjs`: a double click sends one `/key`). |
| Debounce search and autocomplete inputs | N/A | There is no search or autocomplete input. The strength slider, the one live control, commits on release and folds rapid changes into one re-check (`pages/strength.js`). |
| Paginate API results | N/A (deliberate) | `/scan` answers one entry per row because the pane highlights every flagged cell by its position; it travels over loopback, capped at 2M cells (`MAX_CELLS`); measured 2M-cell P99 32 s (`docs/SYSTEMS-MAP.md`). The pane lists 50 rows and says how many more are highlighted. |
| Serve static files through a CDN | Enforced where it applies | The site is published to GitHub Pages, served through its CDN (`pages.yml`); office.js comes from Microsoft's CDN; the pane is served from 127.0.0.1 by design. |
| Move slow tasks to a background job queue | N/A (justified) | One scan is one request with a progress bar; `docs/SYSTEMS-MAP.md` keeps queues out until work outlives a request. |
| Fix N+1 queries | N/A (no database); Office.js batched | Sheet reads go in 200,000-cell slices, one sync each; highlights in 500-row chunks (`services/excel.js`, `features/highlight.js`). |
| Brotli or gzip compression | Site: by the host. Engine: N/A | GitHub Pages compresses at its edge (CSS 36 KB to 9 KB, JS 47 KB to 17 KB gzipped); the engine answers over loopback, where compressing costs CPU and saves nothing. |
| Cache frequently accessed data with Redis | N/A; the caches that exist are enforced | No Redis or database. AI answers cached on disk (sha256 of provider, model and prompt, 500 files, answers only); icons cached for a day. |
| Remove unused dependencies | Fixed in AH-87 | Pillow (imported by nothing) removed; pydantic and werkzeug (imported directly) declared. `test_every_package_the_app_imports_is_declared_and_every_declared_one_is_used`. The pane and site have no npm dependencies. |
| Set timeouts for external API calls | Fixed in AH-87 | Engine calls: 15 s key check, the AI deadline (240 s, at most 90 s a call), 2 s and 5 s local checks. Added: the relay's call to Google (90 s, then its own JSON 504; `relay/test.mjs`) and the pane's startup health check (10 s; `e2e/run.mjs`). |
| Stream AI responses token by token | N/A | Answers are structured JSON a checker reads whole before the pane may show them (Agent 3 checks a fix first); half an answer can't be shown or cached. |
| Update the UI before the server responds | Enforced | Buttons disable at once, a step and a real percentage show while reading, "AI is thinking..." on Ask AI. Sheet writes are deliberately not optimistic: they happen only if the row is still what the scan read. |
| Lazy load images below the screen | N/A | The site has no `<img>`; the pane's two 32 px logos are at the top with fixed sizes. The site's heavy part (the WebGL field) already loads after the words (AH-85). |
| Run independent requests in parallel | Enforced | At startup the sheet name and the health check overlap; settings are read locally from the workbook, not fetched. |
| Add database indexes / connection pooling / servers close to the database | N/A | No database. |
| Trace slow backend requests with OpenTelemetry | N/A (privacy) | Traces would leave the PC (PRIVACY.md: no analytics, no tracking). Timings come from the stress runs above and `docs/SYSTEMS-MAP.md`. |
| Render pages on the server or at build time | Enforced | The site is three hand-written static HTML pages; no HTML is built from data (layer 12). |
| Load third-party scripts after the page | Enforced | The site loads no third-party script (CSP `script-src 'self'`); its own scripts are `defer` except a 1 KB boot script that must run first. office.js must load before `Office.onReady`; the pane's own code is a deferred module. |
| Split JavaScript by page | N/A (by design) | The site's page changes never unload the document, so every page needs the same 6 scripts (47 KB); the pane is 25 native ES modules. |
| Virtualize long lists | Enforced | The results list shows 50 rows at most plus "+ N more, all highlighted in the sheet" (`components/results.js`). |
| Select only the columns you need | Enforced | The scan reads values only, over the used range; number formats for 12 rows; formulas only for the row a fix card opens. |
| Prevent unnecessary re-renders | Enforced | One `replaceChildren` of at most 50 rows per change; no framework, no per-keystroke rendering. |
| Browser caching for static files | Enforced, deliberately mixed | Icons cached a day; pane code `no-store` because stale JS once hid a bug, and Office caches the manifest by `<Version>`; the site's caching is GitHub Pages' own. |
| Load balance across instances | N/A | One engine per PC for one person; the relay runs on Cloudflare Workers, which spreads load itself. |
| Self-host fonts and limit font weights | Enforced | One self-hosted variable woff2 (27 KB, SIL OFL), preloaded, `font-display: swap`; no Google Fonts. |
| Track real user speed with a monitoring tool | N/A (privacy) | No analytics or tracking by promise (PRIVACY.md) and by CSP. Adding one is John's decision, with a privacy note and a CSP change. |
| Test on slow phones and networks | Fixed in AH-87 | `tools/test_site.mjs --browser` now loads the home page at a phone size with the CPU slowed 4x and a slow 4G network, and checks the words show and every reveal finishes; the pane loads over loopback (`e2e/launch.mjs`, under 2 s at 320-500 px). |

### Legal, privacy and accessibility
| Item | Status | Where / evidence |
|---|---|---|
| Privacy policy | Enforced | `PRIVACY.md`, `frontend/privacy.html`, `site/privacy.html`, linked from every site page, the pane's footer and its AI help; kept twins by `test_both_privacy_pages_name_every_place_data_goes_and_every_file_the_app_keeps`. |
| Terms of service | Done (fixed in AH-87) | The MIT License is the terms for the free download (with its no-warranty clause, repeated in every site footer). The invite relay's terms were missing: the privacy pages now say an invite can be revoked, its daily caps, no uptime promise, for Excel-fix help only. |
| Refund policy | N/A | Nothing is sold. |
| Cookie policy and cookie consent banner | N/A | No cookies anywhere (see Cookie banner above); two strictly necessary `localStorage` choices that never leave the PC need no consent. |
| Check your form consents | Fixed in AH-87 | The key box and the site's support form already said what happens next to them; the Ask AI box and "Check words with AI" now say, right beside them, what is sent and to whom (Google, or John's relay with an invite code). |
| Don't collect unnecessary data | Enforced | The engine and the pane send nothing until a person asks AI, and then only what PRIVACY.md lists (`test_ask_ai_sends_no_more_rows_than_privacy_md_says`); a scan opens no connection (`test_a_scan_never_opens_a_connection_off_this_pc`). John holds no data about users; the relay keeps a daily count per invite name. |
| Audit your third-party SDKs | Enforced | No analytics or tracker anywhere; office.js is the only third-party script; no npm dependencies; Python dependencies pinned and audited (`pip-audit`, every push and weekly). |
| Remove dark patterns | Enforced | Auto-fix and Power BI start off (`e2e/run.mjs`); the support form's checkbox starts unticked; Remove key sits beside Save; no confirm-shaming. |
| Remove hidden fees | Fixed in AH-87 | Nothing is priced. "Free" is true for Google's free tier; the key box and the privacy pages now add that a key from a Google project with billing turned on may be charged by Google. |
| Remove fake reviews | Enforced | No testimonials, ratings or user counts anywhere (grep of site/, frontend/, README). |
| Remove unsupported claims | Fixed in AH-87 | "A scan never leaves your PC" is now a test; the website's sample is checked against the engine's own answer (`test_site_sample.py`); the site's "what goes out" lines now name Check words, the relay and the key check; README's one-off measurements are dated and "works on any sheet" is gone; unmeasured timings removed. |
| Add accessibility alt text | Fixed in AH-87 | Every `<img>` is decorative with `alt=""` beside visible text; every inline SVG is now `aria-hidden` or labelled (9 in the pane's privacy and support pages were not), checked by a static test. |
| Fix your color contrast ratio | Fixed in AH-87 | Input borders (1.7:1 to over 3:1), fixed and dismissed rows (2.7:1 to over 4.5:1), the site's filtered sample rows (1.8:1 to over 4.5:1) and placeholders now pass; a test measures the rendered colours. |
| Add keyboard navigation | Fixed in AH-87 | Focus styles everywhere, buttons not clickable divs, roving tabs and Escape on the site's sample (tested); added: a "Skip to content" link on every site page (the first Tab), tested. |
| Add your business details | Done | "Made by one person, John"; MIT licence in his name; contact through public GitHub Issues. No address or phone is needed for a free, non-commercial project, and none is invented. |
| Get age consent for kids' data | N/A | No accounts, no sign-up, nothing collected about anyone; a business Excel tool. |
| Add an unsubscribe link to your emails | N/A | No emails are sent and no addresses collected. |
| License any stock images you use | Done (fixed in AH-87) | No stock images: the logo is John's own drawing (`docs/design/logo/`), the grain is generated. The font's SIL OFL text now ships beside the font in the pane and the exe, as it already did on the site. |
| Add a data deletion request option | Fixed in AH-87 | Remove key, the uninstaller and asking John (for an invite) were documented; added a "Forget what this workbook saved" button for what a scan keeps inside a workbook (decisions, limits, undo list), and the relay counter's lifetime is stated truthfully. |

### Security
| Item | Status | Where / evidence |
|---|---|---|
| Hide my API keys | Enforced | The Google key lives on the user's PC (now 0600 off Windows) and goes only to Google; the relay's key is a Cloudflare secret; none in the tree or the history (`tools/secret_history.py`); never echoed (`test_the_key_never_comes_back_even_when_google_echoes_it`). |
| Check my env variables | Fixed in AH-87 | The engine reads LOCALAPPDATA, its relay URL and the two AI keys; FLASK_DEBUG could turn on the debugger, now impossible (`test_an_environment_variable_can_never_turn_on_the_debugger`). CI uses no secrets but its own token; every workflow is `contents: read` but the release and Pages jobs. |
| Protect my admin routes | Enforced | There are none, by rule (G1): 7 routes and the static pane, none admin, debug or operator; the relay answers only `POST /fix` (`test_every_route_refuses_other_websites`, `relay/live-probe.mjs`). |
| Add proper authentication / check user access | Enforced | Engine: Host must be localhost and Origin the pane, on every route. Relay: the SHA-256 of the invite must be on John's list before the body is read; caps per invite name. No accounts to authenticate. |
| Sanitize my forms | Enforced | Every field checked on the server (key shape, limits as numbers with low <= high, Ask AI text 2,000 characters, sheet names, decisions); the Ask AI box now also stops at 2,000 in the pane. |
| Protect against XSS | Enforced | Every dynamic `innerHTML` value through `esc()` (now every interpolation in the row list too); no eval or string timers; strict CSP on the pane (exact string tested) and the site (meta). |
| Add rate limiting | Enforced | Relay: per-invite and total daily caps counted before Google (`relay/test.mjs`, a 500-call burst lets exactly the cap through). Engine: one AI call at a time, answers cached. |
| Secure my API endpoints | Enforced | Body capped (256 MB, 2M cells), JSON parse errors are 400s, every route checks its fields, every error is our JSON (`test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, Schemathesis). |
| Check my CORS settings | Enforced | No `Access-Control-Allow-Origin` anywhere; a cross-site preflight is a 403 on every route (`test_a_cross_site_preflight_is_refused_on_every_route`). |
| Add security headers | Enforced (one added) | Engine: CSP, `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'`, `Cache-Control`, and now `Referrer-Policy: no-referrer` (`test_safe_headers_on_every_answer`). No HSTS on purpose (it would pin other local servers). Site: CSP meta; GitHub Pages sets the headers it allows. |
| Turn off debug mode | Fixed in AH-87 | No debug mode however the engine starts; the relay's logs are off; the exe has no console. |
| Update my dependencies / remove unused packages | Enforced | Every package pinned (`tools/pinned.py`), audited by pip-audit on every push and weekly; unused Pillow removed; CI's ZAP image pinned by digest and the deploy tool (wrangler) by version. |
| Check for exposed files | Enforced | The engine serves only `frontend/` (`test_no_file_outside_the_pane_is_served`); Pages publishes only `site/`; no source maps, `.env` or backups in either. |
| Secure my database | N/A; local files enforced | No database. The relay keeps one counter in a Durable Object; local secret files are now written readable only by their owner. |
| Hash passwords properly | N/A | No passwords. Invite codes (144 random bits) are stored only as SHA-256: a slow hash adds nothing to a code that can't be guessed. |
| Check Git history for leaked secrets | Enforced (added in AH-87) | `tools/secret_history.py` reads every added line of all 425 commits and every file ever added: no secret, only the tests' marked fakes. A gate in `tools/check.py` and in CI. |
| Run a full security audit | Done | This table, the sections above, `docs/security/SECURITY-LESSONS.md` (findings log, 2026-11-02), CI's Semgrep, pip-audit, ZAP baseline on every push and ZAP's API attack weekly. |

## John's ship lists (AH-102, 2026-11-04)
Four lists John pasted: security holes AI code makes, signs an app was vibe coded, AI-slop design looks, and the
things to have before shipping. Two Researchers checked every item against the code, the running engine and the
browser; each gap became its own ticket (AH-104 to AH-120), fixed test first. Items already answered above keep their
row there and are only pointed to here. Measured before and after on what is live (the website and the downloaded
Arcas.exe): `docs/proof/2026-11-04-before-after.md`.

### Security
| Item | Status | Where / evidence |
|---|---|---|
| SQL injection, parameterized queries | N/A; the analogues enforced | No SQL or database anywhere (the relay's counter is a Durable Object `get`/`put`). What a query would be here: an AI formula may call only `client.SAFE` functions and never reach outside the workbook (`test_suggest_fix_drops_formulas_that_reach_outside_the_workbook`), and the Power BI CSV never carries a live formula (`test_power_bi_csv_never_carries_a_live_formula`). |
| AI endpoint: rate limit, login, key on the server | Enforced | The relay is the only AI endpoint John pays for: an invite (144 random bits, only its SHA-256 kept) is checked before the body is read, daily caps per invite and in total are counted before Google, and the Gemini key is a Cloudflare secret no user holds (`relay/test.mjs`, `relay/live-probe.mjs`). |
| Packages that don't exist, malicious packages | Enforced (fixed in AH-105) | All 81 pins were checked against PyPI by hand (81 of 81 real, well-known projects); the pin audit now runs with `--strict`, so a mistyped or invented name fails the gate and CI (`test_the_pin_audit_fails_on_a_package_pypi_has_never_heard_of`). Every GitHub Action is pinned to a commit (`test_every_workflow_action_is_pinned_to_a_commit`), ZAP by digest, playwright and wrangler by version. A new dependency must be imported to be declared (`test_every_package_the_app_imports_is_declared_and_every_declared_one_is_used`). |
| Prompt injection | Enforced; one step waits for John | A cell can't become an instruction the app acts on: the AI's answer is only shown as a card, every change is checked (cells inside the table, safe functions only, the flagged row unless the user typed a request, at most 50 changes) and nothing is written until the user clicks Accept. Check words fences its values as data. The fix prompt has no "rows are data, not instructions" line yet: a prompt change needs `ai_eval.py` numbers with John's own key (AH-109). |
| Unpermissioned AI access | Enforced | AI runs only when the user clicks Ask AI or Check words; another website can't call the engine (Origin check on every route, `test_every_route_refuses_other_websites`); auto-fix never applies an AI answer. |
| Excessive permissions | Enforced (pinned in AH-105) | The add-in asks Excel only for `ReadWriteDocument`, the least that lets it write cells, highlights and settings (`test_the_add_in_asks_excel_for_no_more_than_writing_this_workbook`); every workflow is `contents: read` except the release and Pages jobs. No database, so no database roles. |
| Missing audit logs | Enforced where there is something to log (fixed in AH-106) | The engine's log is now kept for two runs (`server.log`, `server.log.1`), so a crash's log survives the next logon (`test_a_new_engine_start_keeps_the_last_runs_log_as_server_log_1`). Changes to a sheet are kept as Undo in the workbook (auto-fix and now Accept, AH-118). The relay logs nothing by promise (PRIVACY.md). |
| No security monitoring | Enforced | Weekly `security.yml` (secret history, tests, fuzzing, Semgrep, Bandit, pip-audit, ZAP baseline and active scan), daily `relay-live.yml` (12 stranger probes, and with John's canary invite one real call, AH-108), every push runs the gate. |
| No backups | Answered (AH-107) | `docs/RUNBOOK.md` says what can be lost and how to keep it: `relay/tokens.json` lives only on John's PC (keep a second private copy), the code and releases are on GitHub, a user's cell changes have Undo, the local CA key is never kept by design. |
| Exposed internal dashboards | N/A | None: 7 engine routes and the static pane, the relay answers only `POST /fix`. Cloudflare, GitHub and Google consoles sit behind John's own accounts. |
| Missing security headers | Enforced | See "Add security headers" above (`test_safe_headers_on_every_answer`). |
| Insecure cookie settings, secure session cookies | N/A | No cookies anywhere. |
| Unencrypted sensitive data | Fixed in AH-104 | The Google key and the invite code were plain text in `%LOCALAPPDATA%`. They are now sealed with Windows DPAPI for the user's own account (`anomaly_hunter/sealed.py`), a file from an older version is read and sealed at its first read, and a file this account can't open reads as "no key", never an error (`test_on_windows_the_saved_key_and_invite_code_are_sealed_and_never_plain_text` and four more). A fresh Windows PC in CI updates from the last pre-Arcas release with a plain invite and must report it working and sealed afterwards (`build-exe.yml`). The TLS leaf key stays a file: Python's ssl reads only files, and its CA is name-constrained to localhost. |
| Poor tenant isolation | Enforced | One engine per PC; the relay's caps are keyed by the invite's name, one code per name. |
| Unreviewed AI code | Enforced by the gate | Every change passes `tools/check.py` (13 layers) and CI before it merges, each ticket is judged against its written "done" by the pod's Orchestrator, and every rule learned the hard way is a test (CLAUDE.md). |
| Mass assignment, field tampering | Enforced | No body is ever bound to an object: each route reads the fields it knows and checks their type and range (`test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, Schemathesis). |
| Command injection | N/A by construction | Every process is started from an argument list with no shell, and no part of any command comes from a user, a sheet, a file or the network (installer's System32 tools by full path, PowerShell built from constants and process ids). |
| Insecure deserialization | N/A by construction | No pickle, marshal, `yaml.load`, `eval` or `new Function`; the AI cache is JSON read through pydantic; workbook settings are rebuilt as null-prototype objects (`decisions.js`, `autofix.js`, `undo-store.js`). |
| Misconfigured OAuth | N/A | No OAuth. |
| Hide API keys, purge Git secrets | Enforced | See "Hide my API keys" and "Check Git history" above (`tools/secret_history.py` reads every commit). |
| Public DB key, row level security | N/A | No database. |
| Server-side auth, lock record access | Enforced | See "Add proper authentication" above. |
| Hash passwords, rate limit login, bot protection | N/A; the invite is the login | No passwords. An invite is 144 random bits, stored only as a hash, so guessing one is hopeless; the website's support form posts nowhere (it builds a GitHub issue link). A Cloudflare rate rule against floods is John's (below). |
| Validate all input, escape user content | Enforced | See "Sanitize my forms" and "Protect against XSS" above. |
| Restrict file uploads | N/A | No uploads. |
| Trim API responses | Enforced | `/health` gives four fields, errors are our own sentences, the Server header has no version (`test_an_unexpected_engine_error_answers_in_our_own_words`). |
| Force HTTPS | Enforced | The engine speaks only TLS 1.2+ on 127.0.0.1, the invite is sent only over https (`test_invite_code_is_only_ever_sent_over_https`), GitHub Pages serves the site over https, and no page links to http://. |
| Scan dependencies | Enforced | pip-audit on every push and weekly, on what is installed and on every pin. |

### Signs an app was vibe coded
| Item | Status | Where / evidence |
|---|---|---|
| Purple gradients, gradient backgrounds | Absent | Every colour is navy, wine, gold or paper (16 to 21 hex values a stylesheet); gradients are only masks and the skeleton's light, never a coloured background. |
| Too much padding, floating elements | Kept on purpose | Section padding is 64 px on a phone; the only lifted elements are the list rows and the sample's cells on hover, which John asked for (AH-92, AH-94). |
| Keyboards covering input fields | Absent as measured | At 390 x 420 (a phone with its keyboard open) every support field scrolls into view when focused, and a failed submit now focuses the first missing field with its message beside it (AH-114). |
| Buttons too small | Fixed in AH-115 | Every control that isn't a link inside a sentence is at least 24 x 24 px (WCAG 2.2 AA): the pane's summaries were 18 px, its footer links 16, the site's footer links 21 and the notice bar's Download 17. A sweep in `e2e/launch.mjs` and `tools/test_site.mjs` measures each one. |
| No caching | Enforced | See "Browser caching" and "Cache frequently accessed data" above. |
| Text too small | Fixed in AH-116 | The sample's and the limits table's heads were 10.5 to 10.9 px; nothing a user reads is under 12 px now, measured on every page. |
| Loading spinners everywhere | Absent | No spinner: a scan shows a skeleton built from the list's own rows, the site's sample a skeleton of its own table. |
| Emojis in buttons and icons | Absent | No emoji in any file or rendered text (scanned). |
| Tapping twice does it twice | Enforced | Every pane action ignores a second click while one runs (`hooks/use-action.js`; `e2e/run.mjs`: a double click sends one request). |
| New users land on an empty screen | Fixed in AH-111 | The first screen says what to click and what the sheet needs. A clean scan used to leave an empty list box, a stale "Click a row" hint and Remove highlights under "No problems found": now it shows the summary alone (`e2e/run.mjs` 8b). |
| Scaling text breaks the UI | Fixed in AH-112 | At 200% text or 160 px wide the website scrolled sideways (by up to 267 px) and the pane's privacy and support pages cut words off. Long words, links and code now wrap; tested on every page at 160 px and at 320 px with 200% text. |
| Dark and light mode switches break the UI | Absent; High Contrast fixed in AH-113 | Every page is light by design (`color-scheme: light`), so a dark setting changes nothing. Windows High Contrast did break it: the Find problems button turned into plain text, the slider vanished and the sample's two kinds of marks looked the same. Each now keeps a system-colour border or its own colours, tested with forced colours on. |
| Raw error text shown to the user | Fixed in AH-110 | The pane showed Office's own words ("Something went wrong: InvalidOperationInCellEditMode"). Every error is now said in plain words, "Excel is busy editing a cell. Press Enter or Esc, then try again.", with the detail in the console (`utils/errors.js`, `e2e/run.mjs` 7d). |
| No animations when tapping buttons | Fixed in AH-120 | Only the slider had a pressed look. Every button, summary and button-like link now has one, with no movement under reduced motion; `frontend/selfcheck.js` and `tools/test_site.mjs` check each has an `:active` rule. |
| User preferences wiped on an update | Enforced (proved in AH-104) | Settings keys, the install folder and the page's address kept their names through the Arcas rename; the CI update test now saves an invite under the old release and needs it working after the update. |

### AI-slop looks
| Item | Status | Where / evidence |
|---|---|---|
| Tags and pills, squircles | Absent | Every corner is square (`border-radius: 0`). |
| Excessive italics | Absent | No italic text is rendered. |
| Instrument Serif | Absent | One self-hosted font, Plus Jakarta Sans. |
| Negative kerning | Fixed in AH-117 | 19 negative letter-spacings (headings, the strength value) are gone; `frontend/selfcheck.js` and `tools/test_site.mjs` refuse a new one. |
| Over-detailed UI, overly detailed diagrams | Kept, John's design | The contour field, grain and the sample's tabs were John's motion brief (AH-88 to AH-94); the field fades under text. No diagrams. |
| Overusing dividers, containers with borders | Kept to the rule | No `<hr>`; borders are hairlines on tables and notices, which the design asks for ("a notice is a hairline box", layer 11). |
| Multiple colour shades and opacities | Kept small | One palette of tokens; opacity only 0, 0.5 and 1 apart from a disabled control. |
| Verbose or redundant text | Fixed where found | The pane said what Ask AI sends twice: the second copy now carries the free-tier warning instead. `test_plain_words.py` refuses dashes, "just", "simply" and the other AI tells. |
| Code breadcrumbs | Kept where they are facts | The privacy pages name the files and settings keys the app keeps, as a promise a test holds them to; the Code signing policy names the workflow that builds the exe, as SignPath asks. |
| Section numbering, eyebrows | Absent (fixed in AH-117) | No numbered headings; the pane's support page had "Answers" and "Contact" above its headings: gone, and refused by `frontend/selfcheck.js`. |
| Dithering, ASCII images | Absent | None. |
| Excessive monofonts | Kept to data | Monospace only for code, cell values and file names. |
| All caps subtitles | Absent | Capitals only on table and column heads, by rule. |
| Periods in titles | Fixed in AH-117 | Six site headings ended with a period (the pane's had none); `test_plain_words.py` now fails on any heading that does. |

### Before shipping
| Item | Status | Where / evidence |
|---|---|---|
| Layout that works on mobile | Measured | Pane at 160 to 500 px, site at 390 px and a slow phone (see Launch above). |
| Loading indicators, skeleton loaders | Enforced | A step, a real percentage and a skeleton during a scan; "AI is thinking..." on Ask AI. |
| Helpful empty states | Fixed in AH-111 | See "New users land on an empty screen". |
| Error messages that explain | Fixed in AH-110, AH-114 | See "Raw error text"; the support form names each missing field and focuses it. |
| Server-side validation, permission checks | Enforced | See Security above. |
| Password recovery, confirmation emails | N/A | No accounts and no email. |
| Keyboard navigation, labels on every field, alt text | Enforced | See "Add keyboard navigation" and "Add accessibility alt text" above; every field has a label or a name. |
| Unique page titles and descriptions | Fixed in AH-119 | Each site page has its own title, description, canonical link and sharing tags (`tools/test_site.mjs`). |
| A sitemap | Fixed in AH-119 | `site/sitemap.xml` lists the three pages. No robots.txt: the site lives under `/excel-anomaly-hunter/` and crawlers read robots.txt only at a domain's root. |
| Privacy information | Enforced | PRIVACY.md and its two twins, held to the code by tests. |
| HTTPS everywhere | Enforced | See "Force HTTPS". |
| Analytics tracking | Not added, deliberately | The privacy promise is that nothing is tracked. What John can read without tracking anyone: GitHub's own traffic page (Insights, Traffic) for the site and repo, and each release's download count. |
| Error monitoring | Enforced without tracking | No crash reporting from users' PCs (privacy); the daily relay check, and with the canary a real call, tells John when AI help breaks (AH-108); users report through GitHub Issues. |
| Production environment variables | Enforced | See "Check my env variables". |
| Backups, rollback plan | Done in AH-107 | `docs/RUNBOOK.md`. |
| Optimistic rendering, tooltips on icon buttons | Enforced; N/A | Buttons react at once (see "Update the UI before the server responds"); there are no icon-only buttons, every control shows its words. |

Left for John (not code): a Cloudflare WAF rate rule against floods of stranger requests to the relay (they are
refused before Google, but count toward the Workers free plan's daily requests); whether to keep the developer-only
Claude path (`ANTHROPIC_API_KEY`) in the exe; an own-key `ai_eval.py` run so the fix prompt can say rows are data (AH-109);
a canary invite saved as the repository secret `RELAY_CANARY_INVITE` (AH-108); a second private copy of `relay/tokens.json`.
