# Route Monitor: Design Spec

Date: 2026-10-01
Status: draft, built directly — scope narrowed from the brainstorm sketch with the user's sign-off (see Scope note)
Sub-project: 5 of 6. Depends on sub-projects 2 (local server) and 3 (side panel).

## Purpose

Live anomaly watch: while the analyst edits the active sheet, Route Monitor re-scans in the background and shows a feed of rows as they become newly flagged or stop being flagged — "anomalies appearing/resolving in real time," per the user's own framing when choosing this scope over a static flow-diagram alternative.

## Scope note

The brainstorm sketch (`docs/design/dashboard-sketch-v1.png`) describes a fuller "Error/Trigger Dashboard" — SLA-risk/severity/timing cards, four trigger boxes, an AI agent picking an action per trigger. None of that is specified anywhere beyond the sketch, and building it would be a second large feature, not "live view of workbook edits." This spec builds only the live-watch mechanism the user asked for: a reactive feed, not the card/trigger dashboard. Flagging this narrowing explicitly rather than silently deciding it.

## Mechanism

1. **Toggle:** "Watch this sheet" checkbox in a new Route Monitor section. Off by default — watching costs nothing when off, and turning it on requires saved limits already existing (live mode never shows the limits editor mid-edit; if none are saved, the toggle shows "Scan once first to set limits").
2. **Subscribe:** `sheet.onChanged.add(handler)` (Excel JS API, `Excel.Worksheet.onChanged`). Every edit — a keystroke committed, a paste, a row insert/delete — fires this.
3. **Debounce:** each event resets a 1.5s timer. Only when 1.5s passes with no further edits does a rescan actually run — editing itself never blocks, and a burst of edits (paste, fill-down) costs one rescan, not one per cell.
4. **Rescan:** reuses the existing `/scan` call with the saved limits — same local, free, offline detection as a manual scan. AI triage is never triggered automatically by live mode; that stays an explicit button press, so live mode never spends Claude API calls on every edit.
5. **Diff and feed:** compares the new scan's per-row severity against the previous scan's, by row position. A row that went from not-flagged to flagged is "newly flagged" (feed entry, severity + reason); flagged to not-flagged is "resolved." The feed is newest-first, capped at 25 entries (consistent with the flagged-rows list cap elsewhere in the panel).
6. **Re-highlight:** after each rescan, cell highlights update the same way a manual scan's do (`applyHighlights`), so the sheet itself stays visually current.
7. **Unsubscribe:** turning the toggle off calls `eventResult.remove()` and clears the debounce timer — no background work continues after the analyst turns it off, and switching worksheets or closing the pane also stops it.

## Known simplification

The diff matches rows **by position** (row 12 this scan vs. row 12 last scan), not by identity. Inserting or deleting a row mid-sheet will misattribute a run of "newly flagged"/"resolved" entries to the wrong rows for one cycle — acceptable for a feed whose purpose is "something changed around here," not a row-level audit trail; the next cycle's highlights are still correct since those are keyed off the then-current scan, not the diff.

## Out of scope

The SLA/severity/timing card grid and the four trigger boxes from the sketch (undecided, not part of this ask). Sub-project 6 (Power BI export) — separate piece.

## Testing

`diffFlaggedRows(previous, current)` is a pure function (no Excel/fetch) — plain-Node self-check alongside the existing `computeHealthSummary` one. The debounce/subscribe wiring itself is Office.js-only and, like the rest of the panel, has no automated test here — no Windows-desktop-Excel driver is available in this environment.
