# Power BI Export: Design Spec

Date: 2026-10-01
Status: draft, built directly — resolves the brainstorm's own open conflict ("Power BI shows data; the engine detects; how the two connect is undecided")
Sub-project: 6 of 6. Depends on sub-project 2 (local server).

## Purpose

Let Power BI read the most recent scan's scored rows as a data source, so an analyst can build Power BI visuals on top of what Anomaly Hunter found, without re-running any detection logic in Power BI itself.

## The architectural reality this spec resolves

The engine has no data of its own to query — it only ever scores whatever the Office.js panel hands it in a `/scan` POST, read live from the open workbook. There is no file and no database sitting between Excel and the engine. So a "live connector" can't mean Power BI querying Excel's live state directly (Power BI has no access to an open workbook's in-memory state, and Office.js is the only thing that can read it) — it has to mean the **local server caches the last scan's result**, and Power BI pulls *that* cache. Concretely: the panel pushes data in via `/scan` (already built); this sub-project adds a `GET /latest-scan` the server can be pulled from.

## Known limitation — stated up front, not discovered later

Power BI Desktop can call `GET /latest-scan` directly and refresh on demand. **Power BI Service's scheduled cloud refresh cannot reach `127.0.0.1` on the analyst's laptop without an on-premises data gateway** — a separate piece of infrastructure this spec does not set up. So this is a Power BI **Desktop, manual-refresh** connector, not a live cloud dashboard. The user confirmed this tradeoff before asking for this scope.

## Server changes

- `create_app()` gains `app.config["last_scan"] = None`, scoped per app instance (not a bare module global) so tests stay isolated.
- `/scan` additionally builds a flat, one-record-per-row structure after scoring — the original column values plus `Severity`, `Bucket`, `Reason`, `Magnitude` — and stores it in `app.config["last_scan"]`. The existing `/scan` response shape is unchanged; this is purely an added side effect.
- New `GET /latest-scan`: returns the cached flat array directly as the top-level JSON value (not wrapped in an object) — Power Query's `Json.Document` turns a bare array straight into a list of records with `Table.FromRecords`, no extra drill-down step. Returns 404 with a clear message if no scan has run yet in this server process.

## Power BI side

`powerbi/anomaly-hunter.pbids` — a Power BI Data Source file pointed at `http://127.0.0.1:5055/latest-scan`. Double-clicking it should open Power BI Desktop with the connection pre-filled; the analyst still has to hit **Refresh** to pull the current cache (and again after every scan they want reflected). This file is **unverified** — there is no Power BI installation in this environment to open it against, so treat first use as a smoke test; the fallback is always available and simpler to trust: Power BI Desktop → Get Data → Web → paste `http://127.0.0.1:5055/latest-scan`.

## Out of scope

Cloud/scheduled refresh (needs a gateway — separate infrastructure, not requested). A published Power BI report or dataset. Any change to what the engine detects — this sub-project only exposes what sub-project 1 already produces.

## Testing

- `GET /latest-scan` before any scan → 404.
- `POST /scan` then `GET /latest-scan` → flat array, one object per input row, with the original column keys plus `Severity`/`Bucket`/`Reason`/`Magnitude`.
- Two Flask test-client instances (two `create_app()` calls) don't share a cache — confirms the per-app scoping, not a module global.
