# AH-158: Arcas holds up when people use it

John asked (2026-11-10): once people use Arcas, it must not break or be abused. Rate limits so nobody can spam the AI,
secrets kept on the server, caching, slow work kept off the request, and a load test before launch, all as free as
possible. Arcas has no accounts, no database and only one server of its own: the Cloudflare Worker that passes Ask AI
to Google (`relay/`). The engine runs on each person's own PC at 127.0.0.1. So most of the work was on the relay.

## John's 7 items

**1. Rate limits, so nobody can spam the AI.** Applies, and now tighter. Every request is counted before Google is
asked: 10 a day per invite and 20 in all, and for the free tier 15 a day per network, 45 a day per IPv6 /48 (new: one
cheap server can own 65,536 networks in a /48) and 400 in all (`relay/worker.js`:93, Counter :165-198). New: a network
or an invite gets at most 15 calls a minute, checked before the counter and before Google, by Cloudflare's free
Workers Rate Limiting (`BURST`, `relay/wrangler.toml` `[[ratelimits]]`, `relay/worker.js`:106). 15 is a network's
whole day, so a word check (about 6 calls in a row) or a few PCs behind one office router never meet it. New: when
Google says "busy this minute", the request did no work, so its count is given back (`relay/worker.js`:149). Before,
400 requests at once from 400 networks could use up the free tier's whole day in a minute, mostly as "busy" answers.
Tests: `relay/test.mjs` (the AH-158 blocks), 20 new mutants in `tools/mutations.json`, all killed.

**2. Login (Clerk, Firebase).** Does not apply. There are no accounts, so there is nothing to log in to. The invite
code is the login: the relay keeps only its SHA-256 and refuses any other code with a 401 before reading the body
(`relay/worker.js`:61-69, `relay/test.mjs` "unknown invite code"). The free tier has no login on purpose (AH-151); its
caps are its guard.

**3. Secrets on the server.** Applies, and holds. Google's key for the relay lives only as a Cloudflare secret
(`GEMINI_KEY`), never in the repo or on a PC. The relay adds it itself and never sends Google's error text back
(`relay/test.mjs` "the relay adds the key", "Google's error text is not passed on"). A person's own Google key stays on
their PC, sealed with Windows' DPAPI, and goes only to Google (`test_on_windows_the_saved_key_and_invite_code_are_sealed_and_never_plain_text`).
`tools/secret_history.py` reads the whole git history for keys on every check.

**4. Database rules (row-level security).** Does not apply. There is no database. The one thing the relay stores is
today's counts, and each person's count is kept apart: by invite name, or by a keyed hash of the day and the network
(never the IP). One invite or network can never spend another's share (`relay/test.mjs` "Ben still has his own
allowance", "another network still has its own share").

**5. Caching (Redis).** Applies on the PC, not on the relay. The engine keeps finished AI answers on the PC, so asking
the same thing again never reaches Google (`test_finished_answers_are_kept_and_a_repeat_never_reaches_google`). A shared
cache on the relay would have to store people's sheet rows (which the privacy pages promise it never does), and two
people almost never send the same rows, so it would almost never hit. No Redis.

**6. Slow work off the request (async jobs).** Does not apply. There are no emails, PDFs or other jobs to send away.
The one slow thing is the AI call, and it already has deadlines: 90 s at the relay, 240 s in all at the engine, one call
at a time per PC. A scan runs on the person's own PC.

**7. A load test before launch.** Done for both parts. `relay/load.mjs` runs in `tools/check.py` and CI. It sends 2,200
requests at once through the real relay code, with a counter that takes one request at a time like a real Durable
Object, and a stand-in Google. Exactly the caps get through, each one reaches Google once, every refusal is our own
JSON 429 with its limit, and nothing answers 5xx. With the one-at-a-time gate taken out, the test fails (too many let
through), so it does test the race.

| Load test (2026-11-10, Linux, 4 cores) | Result |
|---|---|
| Relay day 1: 1,000 free-tier requests from 200 networks + 100 invite requests, all at once | 420 served (400 free, 20 invite), exactly the totals; 1,922 requests a second; p50 402 ms, p99 493 ms (time waiting in the one-at-a-time counter) |
| Relay day 2: 4 IPv6 /48s, 12 IPv4 networks and 2 invites, past every own limit | 380 served: each /48 exactly 45, each IPv4 network exactly 15 a minute, each invite exactly 10; 2,247 requests a second; p50 345 ms, p99 473 ms |
| Engine: 100 threads x 40 requests to `/health` (each a new TLS connection) | 4,000 of 4,000 answered, 0 errors, 280 a second; p50 348 ms, p99 537 ms |
| Engine: 16 scans of 120,000 cells at once, `/health` asked every 50 ms meanwhile | 16 of 16 answered 200 in 45 s, each the same 20 rows; `/health` 58 of 58, p50 606 ms, p99 2.7 s, 0 errors |

The engine was started as the tests start it (`live_engine`). Its tests for this are
`test_eight_people_scanning_the_same_sheet_at_once_all_get_the_same_whole_answer`,
`test_one_silent_connection_does_not_freeze_the_engine` and
`test_a_connection_that_goes_quiet_is_dropped_and_never_holds_a_thread`. The numbers match the 2026-10-15 run in
`docs/security-and-launch-checklist.md` (16 scans in 45 s).

## John's call

- **Redeploy the relay** so the new limits are live: in `relay/`, `npx wrangler@4.151.1 deploy`. wrangler 4.151.1 reads
  the new binding (`env.BURST (15 requests/60s) Rate Limit` in a dry run). Until then the live relay has none of this.
- **A Cloudflare WAF or rate-limiting rule** needs a custom domain: `workers.dev` cannot take zone rules. Only worth it
  if floods show up.
- **The Workers free plan allows 100,000 requests a day for the whole account.** Every request counts, refused ones
  too. A flood past that takes the relay down for invites as well (Error 1027) until the next day. The minute limit
  keeps a flood from reaching the counter (the Durable Object has its own daily free limit), but cannot stop a request
  from counting toward the 100,000. The paid Workers plan or a custom domain with a WAF rule are the ways past it.
- The minute limit is counted by Cloudflare in each of its locations and is only roughly exact; the daily caps stay
  the exact ones.
