# Local Server: Design Spec

Date: 2026-10-01
Status: draft, built directly (no written-spec review cycle — small surface, architecture already fixed by brainstorm decision 5)
Sub-project: 2 of 6. See `docs/design/brainstorm-notes.md` decision 5 for why this exists as a local server rather than Pyodide/xlwings Lite/`=PY()`.

## Purpose

A small HTTP server on the analyst's own machine that wraps the `anomaly_hunter` engine (sub-project 1) for the Office.js side panel (sub-project 3). The panel sends it the active sheet's data over `localhost` and gets back per-row severity/bucket/reason plus summary stats — no file I/O, no CLI.

Out of scope: the side panel itself (3), Claude triage (4), Route Monitor (5), Power BI export (6), and anything that writes back to the workbook — the server only scores data it's handed.

## Framework choice

Flask, not FastAPI. Both are "already covers it" for a JSON API; Flask's dependency tree is smaller (no starlette/pydantic/anyio), which matters for brainstorm decision 5's "a one-click launcher should keep the start-the-engine step small."

## Endpoints

All JSON. The server binds `127.0.0.1` only — never `0.0.0.0` — since it runs on the analyst's own machine and should not be reachable from the network.

### `GET /health`
Returns `{"status": "ok"}`. Lets the panel detect whether the local engine is running before trying `/scan`.

### `POST /scan`
Request:
```json
{
  "columns": ["order", "Amount", "Price"],
  "rows": [[1, 100.2, 50.1], [2, 101.0, 49.8]],
  "limits": {"Amount": [80, 120, 0, 10000]},
  "order_by": null
}
```
- `limits`: optional. Omitted or `null` means "no limits file yet" — the response includes `suggested_limits` instead of scoring weird/baseline breaches for limits, matching the CLI's exit-2 behavior but returning it as data instead of exiting.
- `order_by`: optional column name for the sequence detector; omitted means auto-detect the first date column, same as the CLI.

Response:
```json
{
  "rows": [
    {"severity": "High", "bucket": "Behavioral", "reason": "...", "magnitude": 7.1},
    {"severity": null, "bucket": null, "reason": ""}
  ],
  "summary": {
    "severity_counts": {"High": 1, "Medium": 0, "Low": 0, "Noted": 0},
    "bucket_counts": {"Duplicates": 0, "Irregularities": 0, "Behavioral": 1},
    "detectors": {"limits": "ran", "sequence": "sat out: no order column", "isolation": "ran", "clustering": "ran"},
    "warnings": []
  },
  "suggested_limits": null
}
```
`rows` is positional, same order and length as the request's `rows` — the panel matches it back to sheet rows by index.

### `POST /suggest-limits`
Request: `{"columns": [...], "rows": [[...], ...]}`. Response: `{"column": [baseline_low, baseline_high, weird_low, weird_high], ...}` (nulls for "no limit on that side"), for the panel to show as editable starting values. Same math as the CLI's `limits.suggest_limits`.

## Error handling

| Situation | Response |
|---|---|
| Malformed JSON / missing `columns` or `rows` | 400, `{"error": "..."}` |
| `rows` entries don't match `columns` length | 400, `{"error": "..."}` |
| Unhandled exception during scoring | 500, `{"error": "..."}` — never a raw traceback to the client |

## In-memory load path

`load.py` gets one addition: `load_from_records(columns, rows)`, which does what `load_inputs` does minus file reading — build a DataFrame from the given columns/rows (no `source_file` column, since there's exactly one in-memory source) and classify columns exactly like the file path, so `/scan` reuses the same classification, coercion, and error-log logic the CLI already has tests for.

## Testing

Flask's own test client (`app.test_client()`), no real socket needed:
- `/health` returns 200.
- `/scan` with a clean small table returns one result per row, no anomalies.
- `/scan` with a planted outlier flags it, same as the engine-level hazmat test.
- `/scan` with `limits: null` returns `suggested_limits` populated.
- Malformed request body returns 400, not a 500/traceback.

## Packaging

Add `flask` to `anomaly_hunter`'s runtime dependencies. Console script `anomaly-hunter-server = anomaly_hunter.server:main`, binds `127.0.0.1:5055` by default (port is arbitrary but fixed, so the panel has one thing to try first).

## Local distribution update (2026-10-01)

The user wanted "one button, on/off" with nothing to install beyond the repo itself — not yet a public deployment (see the Power BI sub-project's note on that separate, larger decision). Resolved by collapsing the dev-server + API split into one process:

- `create_app()` also serves `panel/dist` (the production webpack build) as static files at the same origin as the API, via Flask's `static_folder`/`static_url_path=""`.
- `main()` runs over HTTPS using the same dev certs `office-addin-dev-certs` already installed (`~/.office-addin-dev-certs/localhost.{crt,key}`) — Office Add-ins require HTTPS even for a local source, dev or not.
- `panel/webpack.config.js`'s `urlProd` now points at `https://127.0.0.1:5055/` instead of the generator's placeholder, so `npm run build`'s manifest and the panel's own `SERVER` constant agree on one origin.
- `start-anomaly-hunter.bat` at the repo root is the literal one-button on/off: double-click to start, close the window to stop. The **API + panel serving** needs only this one Python process — no npm/node.
- The one remaining manual step for any new machine or after `npm stop` removes the dev-sideload registration: Excel → Insert → My Add-ins → Upload My Add-in → `panel/dist/manifest.xml`. This is the real end-user sideload path (not the `office-addin-debugging` dev shortcut), which is also the honest test of what an actual recruiter/user would do — no tool here can click through it, so it's unverified until a human does it once.

### Correction (2026-10-01, later same day): sideload is also automated, and that *does* need node

The user asked to remove the one remaining manual Excel click too ("plug in go"). `start-anomaly-hunter.bat` now also runs `npx office-addin-dev-settings sideload panel/dist/manifest.xml` — a registry-based sideload that needs no Excel UI interaction. This is a real, inescapable **runtime** dependency on Node/npx, not just a build-time one — the line above claiming "no npm/node needed at runtime" was wrong the moment that got added; corrected here rather than silently. Caught by code review. Acceptable while this stays a dev-machine tool (Node is already installed here); a true zero-node experience for someone else's machine would need either Excel's manual Insert-My-Add-ins path (no node, but one human click) or a packaged installer that bundles the sideload step — neither built, since the user's ask was specifically for *this* machine's friction, not distribution to a third party yet.

Also hardened per the same review pass: `server.py`'s `main()` no longer silently falls back to plain HTTP when dev certs are missing (the panel is hardcoded to `https://`, so that silently broke everything) — it now auto-installs the certs via the same npx toolchain, and refuses to start with a clear message if that fails. `start-anomaly-hunter.bat` now checks `panel/dist/manifest.xml` exists before starting, and checks the sideload command's real exit code instead of swallowing its output and printing success unconditionally.
