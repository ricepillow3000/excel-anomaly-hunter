# Anomaly Hunter: map for whoever changes this code next

Excel add-in: a task pane (`frontend/`) talks to a local HTTPS engine (`backend/anomaly_hunter/`, 127.0.0.1:5055) that
flags wrong cells and suggests fixes. Optional AI help goes to Google directly or through the invite relay (`relay/`).

## Before every commit: one command
`python tools/check.py` runs every gate, fastest first, and stops at the first red layer (`--e2e` adds the browser
test, `--keep-going` runs them all). Needs `pip install -e ".[dev]"` and node. All green = what CI checks plus both
accuracy benches. Never commit with a red layer, and never get a gate green by loosening it.

## Layers: each request passes every one, each has its own guard and test
| # | Layer | Code | Guard | Test |
|---|---|---|---|---|
| 1 | Network | `server.main`, `tls_context` | 127.0.0.1 only; TLS 1.2+; handshake in the request's thread; idle connections dropped after 60 s | `test_server.py` (`live_engine`) |
| 2 | Who may call | `own_panel_only` | Host must be localhost; Origin must be the pane (other websites, DNS rebinding) | `test_every_route_refuses_other_websites` |
| 3 | Body shape | `_JSON`, `_bad`, `MAX_CONTENT_LENGTH`, `MAX_CELLS` | any malformed body is a clear 400, never a 500 | `test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, `test_fuzz_api.py` |
| 4 | Route fields | each route in `create_app` | extra fields (`row_index`, `changes`, `start_col`...) checked before any work | `test_fix.py`, `test_agents.py` |
| 5 | Load | `engine/load.py` | text/number/date/id per column; Excel errors logged, not crashed on | `test_engine.py` |
| 6 | Checks | `engine/pipeline.py`, `engine/detectors.py`, `engine/limits.py` | each check returns one list of plain-sentence reasons per row | see the feature map |
| 7 | Severity | `pipeline.score` | hygiene or weird limit = Medium; 2 votes = Medium; 3 = High; 1 = Low | `test_strength.py` |
| 8 | Answer | routes, `_inert` | every error is JSON; the Power BI CSV never carries a live formula | `test_api_security.py` |
| 9 | AI (optional) | `ai/client.py` | one call at a time, deadline, cache (answers only), key never echoed, formulas reaching outside the sheet dropped | `test_fix.py`, `test_ai_load.py`, `test_text_checks.py` |
| 10 | Relay | `relay/worker.js` | invite hash, daily caps counted before Google, only `POST /fix`, model and key set by the relay | `relay/test.mjs`; live Worker from outside: `relay/live-probe.mjs` (CI `relay-live.yml`) |
| 11 | Pane | `frontend/` | every dynamic `innerHTML` value goes through `esc()`; CSP allows only our files + office.js | `frontend/selfcheck.js`, `e2e/run.mjs` |

## Feature map: what the scan finds, where, and its test
| Finds | Function | Test (grep the name) |
|---|---|---|
| Duplicate rows | `pipeline.duplicates` | `test_scan_flags_duplicate_row_via_in_memory_path` |
| Text in a number column, Excel errors (#N/A) | `pipeline.type_errors` | `test_a_few_excel_errors_do_not_switch_a_number_column_off` |
| Blanks in a column that is otherwise filled | `pipeline.blanks` | `test_blanks_in_a_mostly_filled_column_are_found` |
| N/A, ?, -, TBD placeholders | `pipeline.placeholders` | `test_text_checks.py` |
| Dates far outside the rest (2084) | `pipeline.far_dates` | `test_a_date_far_outside_the_columns_range_is_flagged` |
| Totals that don't add up (A + B + C) | `pipeline.sums` | `test_a_total_that_does_not_add_up_is_flagged` |
| Two-column products and sums (Qty × Price, New + Churned), a product after a discount (Units × Price × (1 - Discount)), and the exact fix from the row's own arithmetic | `pipeline.pairs`, pane `fix.addUps` | `test_a_line_total_that_is_not_qty_times_price_is_flagged`, `test_the_rows_own_arithmetic_gives_the_fix_for_its_one_odd_cell`, `test_a_line_total_after_a_discount_that_does_not_add_up_is_flagged_and_its_odd_cell_solved` |
| Same label typed differently, misspellings, short forms, lowercase label | `pipeline.spellings` | `test_blindspots.py`, `test_a_short_form_of_several_words_or_a_contraction_is_worth_a_check` |
| A fraction above 100% | `pipeline.fractions` | `test_blindspots.py` |
| A value typed into the wrong column | `pipeline.shifted` | `test_text_checks.py` |
| Values past their column's limits; the typo behind them (x10, %, sign); a lone slip with an exact x10/x100 behind it past even the usual limit; a stray minus sign never excused as a tail | `detectors.limits_detector`, `likely_value`, `limits._limits` | `test_engine.py`, `test_a_x100_slip_in_a_skewed_column_stands_alone_and_votes`, `test_a_minus_sign_in_a_count_column_is_not_excused_as_its_tail` |
| Jumps in a dated series (cycles excluded) | `detectors.sequence_detector` | `test_a_repeating_cycle_is_not_a_jump` |
| Odd combinations across columns | `detectors.isolation_detector` | `test_engine.py` |
| A top value that is all 9s and over twice the next one (99999 = "missing" / "too big") | `pipeline.codes` | `test_an_all_nines_top_value_is_a_code` |
| Fairness gaps by demographic group, incl. 2-label text outcomes; `?` counts as missing, never a group | `engine/fairness.py` | `test_blindspots.py`, `test_wild_census.py` |
Adding or removing a check: update this table in the same commit.

## Patterns to copy
- **Test first, from the failure.** Rebuild the bad sheet as a small synthetic fixture (never a real customer file),
  watch the test fail on the old code, then fix. Name tests as the behaviour in plain words.
- **A new check** takes `(df, column_types, skip)`, returns `[[reason, ...] per row]`, skips totals rows via `skip`,
  and is joined into `hygiene` in `pipeline.score`. Reasons are one plain sentence naming the column and the value.
- **Lists of routes come from Flask** (`APP.url_map`), never typed by hand, so a new route is tested automatically.
  A new route also goes into `backend/openapi.yaml` (`test_the_spec_lists_every_route` fails until it does).
- **Accuracy is measured, not argued**: `score.py .` (gates) and `score.py . --blind` (held-out domains). A detector
  change that moves either one is explained in the commit message with the numbers.
- **Comments say why** (the incident or measurement), not what.

## Rules learned the hard way (each one is now a test)
- Werkzeug's `make_server` is single-threaded by default: start test servers only with `live_engine()`.
- `request.get_json(silent=True)` doesn't catch `RecursionError`: the `_JSON` provider turns it into a 400.
- Float maths isn't exact (`2.99 - 1.99 != 1`): a spread below 1e-9 of the values is noise (`detectors.spread`).
- Least squares is bent by one x10 typo: exact pair checks (`pairs`) back up `sums`.
- A limit must not cut through a run of honest values in a signed column (`limits._end_of_run`); in a positive
  column, 0 and "15x below typical" stay hard bounds.
- A new detection changes what the pane shows (a reason, a fix card, what strength 0 lists): after a detector change
  run `python tools/check.py --e2e`, not just pytest. CI's Windows `new-user` job caught one that pytest couldn't.
- A real slip stands alone; a long tail is crowded (census hours 1-99, survey weights): a value past the weird limit
  votes only when few other values lie between it and halfway back to the median (`limits_detector.in_tail`), and a
  50%+ zero column is judged on its amounts (`limits._limits`). `test_wild_census.py`.
- A contraction keeps the word's first and last letters (Std, Mgmt): "Iran" is not one of "Ireland" (`_short_for`).
- The installer starts Excel by its App Paths path, never "open this .xlsx": with no Excel, Windows' "Pick an app"
  held the install (`app.excel_exe`, `test_the_installer_finds_desktop_excel_or_says_none`).
- The 2-of-500 failure: thresholds tuned to avoid false alarms hid real defects. Any threshold change must keep
  `test_blindspots.py` (279/279 rows) and both bench gates green.
