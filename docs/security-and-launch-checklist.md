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
Worker that invited users call with their code and anyone else calls as its capped free tier (AH-151), and the public website (`site/`, three static pages on GitHub Pages).
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
| Rate limits | Enforced where it costs money | Relay: per-invite and total daily caps, and for the free tier per network, per IPv6 /48 and in total, counted before Google is called; 15 a minute per network or invite before the counter (Workers Rate Limiting); a Google "busy" gives its count back (AH-158). `relay/test.mjs` fires parallel bursts of 6; `relay/load.mjs` fires 2,200 requests at once from 220 networks and 5 invites over two days and lets exactly the caps through, with no 5xx. Engine: one user on 127.0.0.1, one AI call at a time (`client._LOCK`), answers cached. |
| The live relay, from outside | Enforced | `relay/live-probe.mjs` sends a dozen stranger requests to the deployed Worker (no invite, path/method/size/CORS tricks) and needs all refused with the relay's own JSON and no CORS grant. Proven against the real `worker.js` locally (12/12) and against an open fake relay (0/12, so it can fail). Runs from GitHub (`relay-live.yml`: relay changes, daily, Run workflow) because the dev sandbox can't reach workers.dev. With the secret `RELAY_CANARY_INVITE` set it also makes one real call (`relay/canary.mjs`) and needs a 200 the engine can read: refusals alone never showed a revoked Gemini key or a retired model (AH-108). Proven offline against the real `worker.js`: a 401 invite and Google's 403 fail it. |
| Exposed environment | Enforced | `/health` returns only `status`, `version`, `ai_available` and `ai_provider`. Engine errors say "details in server.log", never a stack trace (`test_an_engine_bug_is_logged_not_leaked`). The Server header is "Arcas" with no versions. `.env*`, `.dev.vars*`, `invite-code.txt` and `relay/tokens.json` are gitignored. |
| Unsigned webhooks | N/A | None. |
| Front-end payment checks | N/A | No payments. |
| IDOR / BOLA | N/A | One user per engine, no object IDs. Relay caps are keyed by the invite's name (`tokens[sha256(code)]`), and `relay/new-invite.mjs` keeps one live code per name, so one invite can't spend another's allowance. |
| API + user input | Enforced | Every body is checked by `_bad` and route checks; malformed, deep or huge bodies get 400 on every route (`test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, derived from Flask's routes). Schemathesis fuzzes every route (`test_fuzz_api.py`). The Power BI CSV neutralises formula cells (`powerbi.inert`). |
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
| Don't collect unnecessary data | Enforced | The engine and the pane send nothing until a person asks AI, and then only what PRIVACY.md lists (`test_ask_ai_sends_no_more_rows_than_both_privacy_pages_say`); a scan opens no connection (`test_a_scan_never_opens_a_connection_off_this_pc`). John holds no data about users; the relay keeps a daily count per invite name. |
| Audit your third-party SDKs | Enforced | No analytics or tracker anywhere; office.js is the only third-party script; no npm dependencies; Python dependencies pinned and audited (`pip-audit`, every push and weekly). |
| Remove dark patterns | Enforced | Auto-fix and Power BI start off (`e2e/run.mjs`); the support form's checkbox starts unticked; Remove key sits beside Save; no confirm-shaming. |
| Remove hidden fees | Fixed in AH-87 | Nothing is priced. "Free" is true for Google's free tier; the key box and the privacy pages now add that a key from a Google project with billing turned on may be charged by Google. |
| Remove fake reviews | Enforced | No testimonials, ratings or user counts anywhere (grep of site/, frontend/, README). |
| Remove unsupported claims | Fixed in AH-87 | "A scan never leaves your PC" is now a test; the website's sample is checked against the engine's own answer (`test_site_sample.py`); the site's "what goes out" lines now name Check words, the relay and the key check; README's one-off measurements are dated and "works on any sheet" is gone; unmeasured timings removed. |
| Add accessibility alt text | Fixed in AH-87 | Every `<img>` is decorative with `alt=""` beside visible text; every inline SVG is now `aria-hidden` or labelled (9 in the pane's privacy and support pages were not), checked by a static test. |
| Fix your color contrast ratio | Fixed in AH-87 | Input borders (1.7:1 to over 3:1), fixed and dismissed rows (2.7:1 to over 4.5:1), the site's filtered sample rows (1.8:1 to over 4.5:1) and placeholders now pass; a test measures the rendered colours. |
| Add keyboard navigation | Fixed in AH-87 | Focus styles everywhere, buttons not clickable divs, roving tabs and Escape on the site's sample (tested); added: a "Skip to content" link on every site page (the first Tab), tested. |
| Add your business details | Done | "Made by one person, John"; MIT licence in his name; contact through public GitHub Issues, and since AH-125 and AH-126 his name, John Nguyen, and his phone, (770) 265-9930, on the privacy pages and both support pages. No address is needed for a free, non-commercial project, and none is invented. |
| Get age consent for kids' data | N/A | No accounts, no sign-up, nothing collected about anyone; a business Excel tool. |
| Add an unsubscribe link to your emails | N/A | No emails are sent and no addresses collected (John's own address is shown for people to write to, AH-134). |
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
| Add rate limiting | Enforced | Relay: per-invite, per-network, per-/48 and total daily caps counted before Google, and 15 a minute per network or invite (`relay/test.mjs`; `relay/load.mjs`, 2,200 requests at once let exactly the caps through, AH-158). Engine: one AI call at a time, answers cached. |
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

## John's 20 before-going-public protections (AH-124, 2026-11-04)
John listed 20 things an app should have before strangers use it. A Researcher checked each one against the code and
its tests. 7 were already proven, 6 don't apply to an app with no database, no payments and no server of its own, and
the 8 gaps were built, each with a test that failed first and passes now.

| Item | Status | Where / evidence |
|---|---|---|
| 1. Rate limiting | Proven | The relay counts each invite's and everyone's daily calls before Google is asked (`relay/worker.js` caps and the `Counter`; a minute's limit per network or invite before it, AH-158; `relay/test.mjs` and the 2,200-request `relay/load.mjs`). The engine runs one AI call at a time (`test_ai_load.py`). The engine itself listens only on 127.0.0.1 for one person. A Cloudflare WAF rule against stranger floods is John's to add, and needs a custom domain (`docs/security/AH-158-hold-up-under-use.md`). |
| 2. API limits | Proven | Bodies up to 256 MB and 2 million cells (`MAX_CONTENT_LENGTH`, `MAX_CELLS` in `server.py`), an AI request of about 7 KB, at most 8 KB at the relay, 10 calls an invite and 20 for everyone a day (`test_api_security.py`, `relay/test.mjs`). |
| 3. Error handling | Proven, and the words fixed | Every error is JSON in our own words (`test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, `test_an_unexpected_engine_error_answers_in_our_own_words`). The words themselves were fixed under item 5. |
| 4. Loading states | Proven | The pane's scan skeleton (`e2e/run.mjs`, first scan), the website's download facts while GitHub answers (`tools/test_site.mjs`), "Asking AI…" on the Ask AI button. |
| 5. Kind error wording | Built | The engine's and the relay's errors reach the pane word for word, and some were cold ("Engine error - details in server.log", "Bad request.", "The AI relay is misconfigured"). They now say what happened and what to do, and name server.log's folder in full (`%LOCALAPPDATA%\AnomalyHunter\server.log`). `test_every_error_the_engine_or_the_relay_can_show_a_user_is_plain_and_kind` reads every `error` and `message` of the engine's answers, every error ai/client.py raises and every error the relay answers, and holds them to the pane's plain-words rules. It failed on 44 places in the old code. The relay's new words go live at its next deploy. |
| 6. Empty states | Proven | A sheet with only a header, a clean sheet (the summary alone, no empty list), and no key yet (`e2e/run.mjs`, steps 8 and 8b and the nokey run). |
| 7. Failed requests | Proven | The engine down at start, mid-scan, mid-Accept and mid-AI call; an engine too old; a failed save; GitHub's API down or answering junk (`e2e/run.mjs`, `relay/test.mjs`, `tools/test_site.mjs`). |
| 8. Timeouts | Proven, and the website fixed | The pane gives up on `/health` after 10 s and a request after 120 s, the engine on Google after 90 s, the relay on Google after 90 s. The website's call to GitHub for the checksum had no limit: a GitHub that never answered kept it waiting for good. It now gives up at 6 s and shows its usual defaults ("API never answers" in `tools/test_site.mjs`). |
| 9. Duplicate submissions | Built (tests) | A double-click on Find problems sends one `/scan`, two clicks on Accept faster than the pane can redraw write one cell and send one `/check`, two on Ask AI send one `/fix` (`e2e/run.mjs` steps 8c and the ai run). Save key and Remove key were already tested. No fix was needed: every action already turns its buttons off before its first wait. |
| 10. Duplicate payments | N/A | Nothing is sold; there is no payment code. |
| 11. Slow database queries | N/A | No database. The relay keeps one Durable Object key, read and written once a call. |
| 12. Database indexes | N/A | No database. |
| 13. Pagination | Built (test) | The list shows the 50 surest rows and one "+ N more" line. A sheet with 5,208 rows flagged shows exactly 50 rows, "+ 5,158 more", and no task in the pane over 2 s (`e2e/run.mjs` step 8d). |
| 14. Compression | N/A by choice | GitHub Pages gzips the website, its one font is a 27 KB woff2 and its PNGs are under 2 KB each. Arcas.exe is not packed with UPX, because antivirus tools flag packed files. |
| 15. Upload limits | Proven | See item 2. A body over the limit is a 413 in JSON (`test_api_security.py`). |
| 16. Caching | Proven where it helps | A finished AI answer is kept, so asking the same again never reaches Google (`test_ai_load.py`). A repeated scan is worked out again on purpose: the sheet may have changed (`docs/SYSTEMS-MAP.md`). |
| 17. Uptime monitoring | Built | The daily `relay-live.yml` now also checks the website's three pages and the Arcas.exe download link (redirects followed, each a 2xx, a 20 s limit and one retry), so a broken deploy or a release without its exe fails a run John sees (`test_the_daily_probe_checks_the_public_website_and_the_download_link`). |
| 18. Error logging | Proven, and the key kept out | Engine errors go to `server.log` with their details, the last run's kept as `server.log.1`. A Claude error that quoted the key went into server.log whole: every record is now written with each key and invite code on this PC blanked (`test_a_key_the_provider_echoes_never_reaches_server_log_or_the_answer`). |
| 19. Simultaneous users | Built (test) | Eight scans of the same sheet at once through the real threaded HTTPS engine: all 200, each the very rows one scan alone gives, no exception in the log (`test_eight_people_scanning_the_same_sheet_at_once_all_get_the_same_whole_answer`). No fix was needed. |
| 20. Backup restores | Built | `relay/restore-test.mjs` makes an invite list with two invites, loses it, restores it from the backup copy, loads it the way the relay loads `TOKENS`, and checks both invites work and the caps still count. It runs with `node relay/test.mjs` in the gate and in CI. The steps John runs against Cloudflare are in `docs/RUNBOOK.md`, "Restoring the invite list". |

Left for John (not code): deploy the relay so its new words go live (`npx wrangler@4.151.1 deploy` from `relay/`; done by John 2026-11-05, version 0004b458, and the Relay live probe passed, run 41987135974); one
real restore of the invite list against Cloudflare, dated in the runbook.

## John's 10 so-we-don't-get-sued items (AH-125, 2026-11-04)
Four were already built and tested. The other six were built, each with a test; the ones with code to fail failed
first on the old code.

| Item | Status | Where / test |
|---|---|---|
| 1. A privacy policy page | Proven | `PRIVACY.md`, the pane's `frontend/privacy.html` and the website's `site/privacy.html`, held as twins (`test_both_privacy_pages_name_every_place_data_goes_and_every_file_the_app_keeps`, `test_the_panes_privacy_sections_and_the_websites_are_word_for_word_the_same`). Every site page's footer now links it too (`tools/test_site.mjs`, "the footer does not link the privacy page"). |
| 2. What data we collect | Proven | "What stays on your PC" lists every file the app keeps; the pane's settings keys are named and Forget clears them (`test_every_privacy_page_says_what_the_pane_keeps_how_to_clear_it_and_the_relays_terms_as_configured`, `test_privacy_promises.py`). |
| 3. Where AI is used | Proven | "What AI help sends": Ask AI and Check words, what each sends, and where (`test_ask_ai_sends_no_more_rows_than_both_privacy_pages_say`). The pane says it beside the Ask AI box (`#fix-sends`). |
| 4. Third parties | Proven, PyPI added to the test | "Who else sees something" names Google, Cloudflare, Anthropic, PyPI, GitHub and Microsoft; the twins' test now holds PyPI too (`test_fix.py`, `places`). |
| 5. Our name | Built | The intro of all three pages: "Arcas is made and run by John Nguyen (GitHub: ricepillow3000)", how to reach him (the support page's GitHub form, or (770) 265-9930, a `tel:` link on the HTML pages), and since AH-134 John's one email address, a `mailto:` link, never any other (`test_every_privacy_page_names_who_runs_arcas_and_how_to_reach_him`, failed first). |
| 6. Uploads not stored publicly | Built (test) | The relay passes a request to Google and keeps only the day's counter object `c` ({day, total, by}); a unique marker sent through /fix is in no stored value and no counter call (`relay/test.mjs`, "nothing the request said is stored"; a mutation that stored the body made it fail). On the PC, the AI cache keeps answers only (`test_ai_load.py`). |
| 7. No public storage buckets | Built (test) | `relay/wrangler.toml` binds only the Counter Durable Object: no KV, R2, D1, queue or other store, and `[observability] enabled = false`, so Workers keeps no request logs (`test_the_relay_stores_no_upload_keeps_no_logs_and_has_no_public_bucket`). |
| 8. Per-user protection | Proven | The engine answers only this PC and only the pane (`test_every_route_refuses_other_websites`); each invite has its own daily cap and is stored hashed (`relay/test.mjs`); the key and the invite code are sealed for the Windows account (`test_on_windows_the_saved_key_and_invite_code_are_sealed_and_never_plain_text`). |
| 9. No fake testimonials | Built (guard) | No page had any; a test now refuses a testimonial, "trusted by", a star rating or a user count on the website, the pane's pages and README.md (`test_no_page_carries_a_testimonial_a_rating_or_a_user_count`). |
| 10. A self-harm response in the AI chat | Built | `backend/anomaly_hunter/ai/care.py`: what someone types to Ask AI (never a cell) that reads as a person thinking of suicide or self-harm gets the engine's own message with the 988 Lifeline, findahelpline.com and the emergency number. It is decided before any key check or AI call: nothing is sent to Google or the relay, nothing is cached, and it works with no key. The prompt and the model are unchanged. The pane shows it as text in `#fix-care`, with no Accept. Spreadsheet talk ("kill the duplicates", "suicide rate by state", "die roll results") never triggers it (`test_care.py`, failed first; e2e "words of someone in crisis"; `test_the_helpline_message_is_plain_and_kind`). |

Left for John (not code): nothing. The support page's "the only public ways to reach John" sentence now gives the phone
too (AH-126, `test_both_support_pages_give_johns_phone_beside_the_question_form`).

## John's website lists (AH-126, 2026-11-04)
John's 16 website items and 20 "enterprise" items. Ten were already built and tested (a Researcher checked each one);
the rest were built, each with a test in `tools/test_site.mjs` (static, or `--browser`) or `backend/tests/`. The tests
for new behaviour failed first on the old code: the 404 page, the phone's menu, the hero's download in the first screen,
the download bar, the support page's phone and thank-you, the counter, the terms page, the footers, the Open Graph card,
the icons, the scroll regions and the checksum sentence. The cookie check passed on the old code too: no page ever set
one, and it now holds that.

| Item | Status | Where / test |
|---|---|---|
| 1. No sideways scroll | Proven | Every page at 320 and 390 px, text at 100% and 200% (AH-112), the 404 page and the open menu too ("other readers", AH-126 block). |
| 2. A description on every page | Proven | `meta name="description"` on each page, the 404 page's its own (static check). |
| 3. A title of its own on every page | Proven | "Arcas" then what the page is, no two the same (static check, four pages and the 404). |
| 4. No broken links | Proven | Every local link, file and #anchor resolves; the 404 page's root-absolute links answer 200 from any depth. |
| 5. Empty states | Proven | The pane's empty sheet and clean sheet (`e2e/run.mjs`); the site's sample has its "After fixes" state. |
| 6. A mobile pass | Proven | Every page at 390 x 844 and a slow phone (4x CPU, slow 4G), targets and text sizes checked. |
| 7. A sitemap | Proven | `site/sitemap.xml`: the four pages at their canonical addresses, never the 404 page. |
| 8. Form error states | Proven | The first missing field takes focus, its message beside it (AH-114). |
| 9. Loading states | Proven | The checksum's and the sample sheet's skeletons (AH-89). |
| 10. Mobile breakpoints | Proven | 760 and 1100 px in `site/styles.css`, checked at 320, 375, 390, 1280 and 1440 px. |
| 11. A custom 404 page | Built | `site/404.html`: the site's header and footer, no script, `noindex`, the exact CSP, the skip link first, links home, to the download, support and privacy, every path root-absolute so it works at any depth. Test server answers missing paths with it and a 404. Checked at 320 px with text at 200% and for contrast. |
| 12. A mobile menu | Built | At 760 px and under, a Menu button before the links (`site/transition.js`, its own block; `styles.css` hides the closed links only under `data-js`, so with no script they show). Escape closes it and gives focus back; a link closes it; no motion under reduced motion. Tested at 375 px on every page, at 1280 px and with JavaScript off. |
| 13. A sticky download bar on phones | Built | `#dock` on the home page (`site/home.js`, `dock()`): shown only on a phone, once the hero's download has scrolled away and while the download section is off screen, rising in by transform and opacity; the footer keeps room for it and the phone's home bar. CLS 0, contrast, hidden on a wide screen. |
| 14. The main button above the fold | Built | The hero's "Download for Windows" (`.hero-cta`), fully in the first screen at 375 x 667 and 1280 x 720 (the hero starts higher on short screens). |
| 15. Contact details | Built | The support page's contact block: John Nguyen and `tel:+17702659930`, and since AH-134 (John's choice, 2026-11-05) his one email address as a `mailto:` link, never any other; the pane's support sentence gives both too. |
| 16. A thank-you after the form | Built | `#thanks` (`role="status"`, toggled with `hidden`) once the link to GitHub is followed: it says the question reaches John only after Submit on GitHub. The link is described by the ready text (`aria-describedby`). |
| 17. Terms of use | Built | `site/terms.html`: free and MIT licensed, as is with no warranty, check before you rely on it, AI can be wrong, invite codes personal and capped, privacy page for data, dated, contact through support. In the sitemap and every footer. |
| 18. Footer on every page | Built | Privacy, Terms, Support and the public repository, and "No cookies, no tracking of you.", on all five pages. |
| 19. A sharing image | Built | `site/assets/og-card.png`, 1200 x 630, 18 KB, rendered from `docs/design/logo/mark-80.svg`; `og:image` with its size and alt, `twitter:card` `summary_large_image` and `twitter:image` on every page but the 404. |
| 20. A full set of icons | Built | `crest2-180.png` (apple-touch-icon, on paper), `crest2-192.png` and `crest2-512.png` from `mark-80.svg`; the 180 and 192 linked on every page. Sizes checked from the files. |
| 21. Alt text | Built (test) | Every `<img>` described or `alt=""` with `aria-hidden`, every inline svg hidden or named, on every page. |
| 22. No placeholder text | Built (test) | No lorem, ipsum, TODO, TBD, example.com, Your Name, placeholder text or XXX in what a user reads (the checks table's "N/A and TBD placeholders" names what the app finds). |
| 23. Outside links allowlisted | Built (test) | github.com/ricepillow3000 only on GitHub, aistudio.google.com, 988lifeline.org, findahelpline.com, signpath.io, signpath.org, the site's own address and goatcounter.com's privacy page. |
| 24. Scrollable tables reachable by keyboard | Built | The sample's two `.scroll` boxes: `tabindex="0"`, `role="region"` and a name. |
| 25. What to do if the checksum differs | Built | Step 1: "If they differ, delete the file and download it again." |
| 26. Visit counting without cookies | Built, inert | `site/count.js`: one image request per page view to GoatCounter with the page's path alone, no referrer; silent with no code, on a PC's own copy, under Do Not Track and under Global Privacy Control. The CSP allows `https://*.goatcounter.com` as an image only, on the four pages that load it. Tested with the code empty (nothing sent) and with a code put in by the test (one request, only `p`). The privacy pages say so, and that the pane and the engine never contact it (`test_every_privacy_page_says_the_website_alone_may_count_page_views_and_what_the_counter_sends`). |
| 27. A cookie banner | Not needed | No page sets a cookie: `document.cookie` is empty and no answer carries Set-Cookie on every page, the 404 too (`--browser`). GoatCounter's pixel sets none either. A banner asks consent for cookies or tracking a site does; this one does neither. |
| 28. robots.txt | Skipped on purpose | Crawlers read robots.txt only at a domain's root, and this site lives under `/excel-anomaly-hunter/`, so one here would do nothing (a static check keeps it out). Add it when the site gets its own domain; until then the 404 page says `noindex` itself and the sitemap goes to a search console. |
| 29. A privacy policy | Proven | `site/privacy.html` and its twins (AH-125), in every footer. |
| 30. HTTPS and a strict CSP | Proven | GitHub Pages serves HTTPS; each page's CSP is checked word for word. |
| 31. WCAG AA contrast | Proven | 31 page states measured in the browser, the new ones included: terms, 404, the open menu, the download bar and the thank-you. |
| 32. A skip link | Proven | First on every page, the 404 too. |
| 33. Speed on a slow phone | Proven | The home page's budgets at 4x CPU and slow 4G. |
| 34. Reduced motion | Proven | Nothing moves under it, the menu and the download bar included. |
| 35. Search and sharing tags | Proven | Canonical, `og:*` and the large Twitter card on the four pages. |
| 36. Uptime monitoring | Proven | The daily `relay-live.yml` probe checks the site's pages and the download link (AH-124). |
| 37. Compressed images | Proven (test) | Every picture in `site/assets` is 32 KB or less (static check, AH-126); the font is one 27 KB woff2 subset. |
| 38. Clickable emails | Not applicable | John has no public email by choice: no page carries one (a static check refuses `mailto:` and any address); the phone is tap-to-call instead. |
| 39. Error and success messages | Proven | The form's missing-field message (8), the ready box and the thank-you (16), the checksum's "If they differ" step (25), and the pane's own words for every engine error (AH-124). |

How John's own words map to the rows: horizontal scroll 1; meta descriptions 2; favicon and favicon sets 20; page
titles and meta title per page 3; compressed images 37; clickable emails 38; broken links 4; mobile menus 12;
placeholder text 22; tested on mobile 6; empty state for mobile 5; mobile overflow 1; error and success messages 39;
404 page and custom 404 11; clickable phone 15; CTA above the fold 14; meta description per page 2; Open Graph images 19;
robots.txt 28; sitemap.xml 7; alt text 21; mobile breakpoints 10; sticky mobile CTA 13; loading states 9; form error
states 8; thank-you page 16; privacy policy 29; terms page 17; cookie banner 27; analytics install 26; real contact
address 15 (name, phone and GitHub, John's choice: no street address); public GitHub repo 18.

GoatCounter, for John (three steps):
1. Sign up at goatcounter.com and choose a code, the first part of your counter's address (`arcas` gives `arcas.goatcounter.com`).
2. Put that code in `site/count.js`: `const COUNTER = "arcas";`.
3. Push. Pages publishes the site and each visit is counted from then on; the privacy pages already say so.

Done 2026-11-05: John signed up with the code `ricepillow3000` (dashboard https://ricepillow3000.goatcounter.com), and `site/count.js` holds it.
