# Side Panel: Design Spec

Date: 2026-10-01
Status: draft, built directly (small surface, architecture fixed by brainstorm decisions 1-4)
Sub-project: 3 of 6. Depends on sub-project 2 (the local server at `127.0.0.1:5055`).

## Purpose

An Office.js task-pane add-in for Excel. The pane is the dashboard: it reads the active sheet, sends it to the local server's `/scan`, and shows overall file health plus the flagged rows — highlighting them live in the sheet. No AI triage yet (sub-project 4) — this is "what did the engine find," not "is it useful-weird or broken-weird."

Out of scope: Claude triage (4), Route Monitor (5), Power BI export (6), and anything that changes/moves/sorts/fills/deletes the analyst's original data — per brainstorm decision 4, only highlighting a cell, adding a note, and copying a row to an "Anomalies" sheet are auto-safe actions this sub-project performs. Nothing else is built yet to need approval, but the undo contract below is built now so sub-project 4's riskier actions have something to plug into.

## Flow

1. Pane loads, calls `GET /health`. If it fails, show "Start the local engine" with the exact command (`anomaly-hunter-server`), not a crash.
2. Analyst clicks **Scan Active Sheet**. The pane reads the used range (header row + data), posts `{columns, rows, limits, order_by}` to `POST /scan`.
3. First scan on a workbook: no saved limits yet, so `limits` is omitted. The server returns `suggested_limits`. The pane shows them as an editable table (per-column baseline/weird low/high) before applying.
4. Analyst edits or accepts the suggested limits, clicks **Save limits**. The pane writes them to `Office.context.document.settings` (persisted in the workbook file itself, per brainstorm decision 7 — "a second run needs no re-entry") and re-scans with `limits` now populated.
5. Results render: health ring (% rows with no finding), counts by bucket (Duplicates / Irregularities / Behavioral) and severity, a sortable flagged-rows list with each row's reason.
6. Each flagged row's full-row range gets a fill color by severity (same palette as the CLI's `report.py`: Noted/Low/Medium/High). Before changing a cell's fill, the pane reads and stores its current fill color.
7. **Clear highlights** restores every changed cell to its stored original fill — the undo contract from brainstorm decision 4 ("a highlight must restore the analyst's original cell formatting when it is undone").

## Limits storage format

`Office.context.document.settings` key `"anomalyHunterLimits"`, JSON: `{"column": [baseline_low, baseline_high, weird_low, weird_high], ...}` — same shape `/scan` expects, so the pane just passes the saved object straight through.

## Error handling

- Local server unreachable at any point (not just startup): show the same "start the engine" message, never a silent failure or a raw fetch error.
- `/scan` returns a 4xx/5xx: show its `error` message in the pane, don't attempt to render partial results.
- Used range has no data rows (header only, or empty sheet): show "add data starting at A1" instead of calling the server.

## Testing

- `computeHealthSummary(scanResponse)` and `diffLimitsForSave(edited, suggested)` style pure functions (no Office.js, no fetch) get a plain-Node self-check, same pattern as the engine/server's tests — no UI framework, no mocking Office.js.
- Manual: `npm run build` compiles clean, `office-addin-manifest validate` passes. Actually clicking through Excel is a manual step — no Windows-desktop-Excel automation tool is available to drive that from here.

## Packaging

Scaffolded with `generator-office` (task pane, JavaScript, Excel host) under `panel/` in this repo, matching the stack already proven to scaffold/build/validate cleanly in this environment. The pane calls `fetch("http://127.0.0.1:5055/...")` directly — no bundler proxy needed since the server already sets permissive CORS headers for localhost.
