# Systems map: which system-design pieces this app uses, where, and when the rest would be needed

The app is **one user's PC**: an Excel pane, a local engine on 127.0.0.1, an optional AI relay (one Cloudflare Worker),
and GitHub CI that builds and releases the Windows exe. Pieces made for many servers or many users don't apply here, and
adding them would only add code that can break. Every verdict below was **measured on 2026-10-16**:
- **Stress test:** 20 experiments on the real engine (latency up to 2M cells, 300 scans in a row, concurrency, floods,
  a faked failing Google, the relay's caps, TLS). Synthetic sheets only.
- **Blind test:** 40 random real public tables with 206 planted mistakes, run through the real pane and engine by an
  agent that never saw the answer key. It found the accuracy bugs fixed in PR #18.
- **Council:** three reviewers (minimal, accuracy, reliability + security) argued every item; the verdicts are below.
- **Second blind test:** 30 more random real tables nobody had tuned against (209 planted), main vs this work:
  planted caught 155 -> 162; Medium+ false alarms on planted sheets 1,622 -> 237 (after two more fixes it found);
  exact fixes 55 -> 48 (the lost ones were medians that happened to land within 1% of the truth).

Add a piece only when its "add it when" signal shows up in a measurement, and say which one in the commit.

## Failure handling
| Piece | Here | Where | Add more when |
|---|---|---|---|
| Timeouts | pane: 300 s for a scan, an Accept re-check, AI; 120 s otherwise. Engine: an idle socket is dropped at 60 s; an AI request has 240 s in all | `services/api.js`, `server.py`, `ai/client.py` | a measured call takes over half its timeout on a slow PC |
| Retries + exponential backoff + jitter | own-key Google calls: 2, 4, 8, 16, 30 s plus up to 1 s; `Retry-After` honoured; a "per day" 429 stops at once. After a timeout, the next try may wait until the deadline | `client._wait`, `client._call` | never for the relay (each call counts toward the invite's day) |
| Idempotency | a scan has no side effects except replacing `latest-scan.csv`. A repeated AI question is answered from the cache, never asked again | `client._ask` | an action that charges or writes twice |
| Circuit breaker | not needed: one AI call at a time, each with a deadline | | many calls per second to a dependency that's down |
| Health check | `/health` (status, version, AI); the installer waits for it; the pane checks it at start; CI smoke-tests it | `server.py`, `app.py`, `build-exe.yml` | |
| Back pressure | the pane sends one action at a time; one AI call at a time (a second gets "still working"); size caps (2M cells, 256 MB). No scan lock: concurrent scans give no throughput but are correct (24/24 identical), and need two workbooks | `hooks/use-action.js`, `client._LOCK`, `server.MAX_CELLS` | users report "busy" or memory errors with two workbooks |
| Rate limiting | relay: daily caps per invite and in total, counted before Google. Engine: none needed (a refused request costs 2 ms; `/health` p99 19 ms under a 2,000-request flood) | `relay/worker.js` | the engine is ever reachable from outside the PC |
| Logging | `server.log`: errors only (Werkzeug's per-request lines are off; a 60 KB URL wrote 60 KB each, about 600 MB a minute in a flood). Never keys or cell values on purpose | `server.py` | a support question the log can't answer |

## Inside one process
| Piece | Here | Where | Add more when |
|---|---|---|---|
| Race conditions, thread safety | no shared mutable state but two locks; same sheet = same answer, 8 at once = serial | `test_server.py`, stress test | a new module-level cache or RNG |
| Pessimistic lock | one AI call at a time (non-blocking); one Power BI file write at a time | `client._LOCK`, `server._CSV_LOCK` | |
| Optimistic lock (compare-and-set) | Accept, Undo and auto-fix write only if the row is still what the scan read | `features/fix.js`, `autofix.js` | |
| Deadlock | can't happen: two locks, never held together, the AI one never waits | | a second lock held while taking another |
| Memory leak / GC | none: +0.3 MB per 100 scans; a 2M scan peaks at 813 MB and settles at ~400 MB; longest GC pause 0.39 s | stress test | the engine is seen growing over days |
| Slow paths (query optimisation) | checks over pairs of columns are capped in sheet order (wrong-column: first 100 category columns; products and fractions: first 64 number columns; fairness: 400 tests); labels over 60 characters are never compared. A typo hunt stops after 10 s | `pipeline.shifted`, `pairs`, `fairness.MAX_TESTS`, `checker.BUDGET` | a real sheet is measured slow (2M cells take 31 s here) |

## Speed
| Piece | Here | Where | Add more when |
|---|---|---|---|
| Tail latency (P99) | P99 / P50 at most 1.3x: 1k 0.44 s, 100k 2.2 s, 2M 32 s (pane waits 300 s) | stress test | P99 passes half the pane's timeout on a slow PC |
| Caching | finished AI answers (500 files, answers never prompts); pane icons cached a day; pane code never cached (stale JS once hid a bug) | `client._ask`, `server.no_cache` | the same scan is measured repeating |
| Cache invalidation | the AI cache key includes provider, model and prompt: a new model never reads an old answer | `client._ask` | |
| N+1 calls | every Excel loop batches `context.sync()` (10 syncs read 2M cells) | `services/excel.js`, `highlight.js` | a new per-row Excel call |
| Database indexing, connection pooling | not applicable: no database; every answer closes its connection | | a database |
| Cold start | 2.6 s to the first `/health`; the exe unpacks in 10-30 s once at logon | stress test, `app.py` | |

## Delivery
| Piece | Here | Where | Add more when |
|---|---|---|---|
| CI/CD | every push: tests, fuzzing, accuracy benches, Semgrep, Bandit, ZAP, pip-audit. Main: build the exe, install it on a fresh Windows PC, release | `.github/workflows/` | |
| Dependency hell | every package, indirect ones too, is pinned in `constraints.txt` and checked by `tools/pinned.py` (an unpinned scikit-learn 1.9.1 broke every Windows install, 2026-10-11) | `constraints.txt`, `tools/pinned.py` | regenerate when pyproject changes (see `tools/pinned.py`) |
| Build caching | pip cache keyed on `pyproject.toml` + `constraints.txt` | workflows | builds get slow |
| Versioning | release tags `v0.1.<run>`; the pane shows the engine's version. No API versioning: the engine serves its own pane, so they can't disagree | `server.version`, `build-exe.yml` | someone else's code calls the engine |
| Rollback | every release stays downloadable; installing an older exe replaces the newer one | GitHub Releases, `app.install` | |
| Blue-green, rolling | not applicable: one PC; an update stops the old engine, swaps the file and waits for `/health` | `app.install` | a server many people use |
| Docker, Kubernetes, Helm, Terraform | not applicable to a Windows desktop app; CI uses Docker for ZAP; `relay/wrangler.toml` is the relay's infrastructure as code | | a hosted multi-user service |

## Security
| Piece | Here | Where |
|---|---|---|
| Encryption in transit | TLS 1.2+ only (ECDHE suites), a certificate good only for localhost/127.0.0.1; HTTPS to Google and the relay | `server.tls_context`, `make_cert` |
| Encryption at rest | not added: the files live in the user's own Windows profile (`PRIVACY.md` lists them, including the plain-text Power BI copy of the last sheet) | `PRIVACY.md` |
| SQL injection's relatives | no SQL; formula injection (CSV text always quoted, AI formulas allow-listed) and prompt injection are guarded | `server._inert`, `client.SAFE` |
| DDoS | the engine listens on 127.0.0.1 only and refuses other websites; the relay sits behind Cloudflare with daily caps | `own_panel_only`, `relay/worker.js` |
| DNS | DNS rebinding refused (Host must be localhost) | `own_panel_only` |

## Not applicable at this size (and the signal that would change that)
| Pieces | Why not here | Needed when |
|---|---|---|
| Load balancer, reverse proxy, API gateway | one engine per PC; Cloudflare already fronts the relay | more than one server |
| Message queues, pub/sub, event-driven, dead-letter queues | every action is one request and its answer | work that outlives a request or many consumers |
| WebSockets, SSE, long polling | a scan is one request with a progress bar | live updates from a server |
| Sharding, partitioning, replication, read replicas | no database; a sheet is at most 2M cells in memory | data that doesn't fit one machine |
| Leader election, service discovery, distributed locks, sagas, distributed transactions, CAP, eventual consistency, multi-region | one process; the relay's counter is a single Cloudflare Durable Object (one writer, consistent) | several servers sharing state |
| Auto-scaling, vertical scaling, serverless, cost | the relay is serverless (no cold starts to speak of) and capped; the engine is the user's own CPU | a bill that grows with users |
| Metrics, alerts, distributed tracing, on-call | one live probe of the relay in CI (`relay-live.yml`); incidents are written up as tests and lessons (CLAUDE.md, SECURITY-LESSONS.md) | users John can't hear from directly |
| Clock skew | certificate valid from a day back; deadlines use a monotonic clock; the relay's day is Pacific time on Cloudflare's clock | machines comparing their own times |
| HTTP/2, HTTP/3 | loopback, one request at a time; Cloudflare speaks them to the relay | many requests per page over the internet |

## Residual risks accepted (2026-10-16)
- A crafted workbook can still make a scan slow through per-column overhead (~25 ms per column): 16,000 columns would
  take minutes of the user's own CPU. Real wide sheets (300-1,000 columns) take seconds. A column limit would refuse
  real survey exports.
- `latest-scan.csv` is written on every scan, Power BI or not. Making it opt-in is John's call.
