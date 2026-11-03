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
| The live relay, from outside | Enforced | `relay/live-probe.mjs` sends a dozen stranger requests to the deployed Worker (no invite, path/method/size/CORS tricks) and needs all refused with the relay's own JSON and no CORS grant. Proven against the real `worker.js` locally (12/12) and against an open fake relay (0/12, so it can fail). Runs from GitHub (`relay-live.yml`: relay changes, daily, Run workflow) because the dev sandbox can't reach workers.dev. |
| Exposed environment | Enforced | `/health` returns only `status`, `version`, `ai_available` and `ai_provider`. Engine errors say "details in server.log", never a stack trace (`test_an_engine_bug_is_logged_not_leaked`). The Server header is "Arcas" with no versions. `.env*`, `.dev.vars*`, `invite-code.txt` and `relay/tokens.json` are gitignored. |
| Unsigned webhooks | N/A | None. |
| Front-end payment checks | N/A | No payments. |
| IDOR / BOLA | N/A | One user per engine, no object IDs. Relay caps are keyed by the invite's name (`tokens[sha256(code)]`), and `relay/new-invite.mjs` keeps one live code per name, so one invite can't spend another's allowance. |
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
| Meta description, Open Graph image, robots.txt, sitemap.xml | Pane: N/A. Site: description only | The pane is served only to this PC inside Excel; search engines can't reach 127.0.0.1. The public site's three pages each carry a meta description; no Open Graph image, robots.txt or sitemap (three pages, all linked from each other). |
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
| Images in WebP or AVIF | N/A | Every image is under 3 KB and in the format its reader requires: Office's ribbon and manifest need PNG (`frontend/assets/mark-*.png`), the site's only images are two PNG favicons, its logo is inline SVG, the grain is SVG. WebP would save bytes nobody downloads twice. |
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

Left for John (not code): a Cloudflare WAF rate rule against floods of stranger requests to the relay (they are
refused before Google, but count toward the Workers free plan's daily requests); whether to keep the developer-only
Claude path (`ANTHROPIC_API_KEY`) in the exe.
