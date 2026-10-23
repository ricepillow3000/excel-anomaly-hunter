# Anomaly Hunter: map for whoever changes this code next

Excel add-in: a task pane (`frontend/`) talks to a local HTTPS engine (`backend/anomaly_hunter/`, 127.0.0.1:5055) that
flags wrong cells and suggests fixes. Optional AI help goes to Google directly or through the invite relay (`relay/`).

## Work comes from the agent dashboard
This repo's tickets are the `AH-` rows of `90-System/agent_dashboard.md` in John's vault (`second-brain-vault`; live
board https://claude.ai/artifact/L89gYPxD8feZu5PeN6cUrs). Log a request there as tickets, lock one, then work it; the
gates below still decide when it is done.

## Before every commit: one command
`python tools/check.py` runs every gate, fastest first, and stops at the first red layer (`--e2e` adds the browser
test, `--keep-going` runs them all). Needs `pip install -e ".[dev]" -c constraints.txt` and node. All green = what CI checks
(both accuracy benches run there too), except Semgrep (see the rules below). Never commit with a red layer, and never get a gate green by loosening it.

## Security first: read `docs/security/SECURITY-LESSONS.md`
Every input is an attack until proven harmless (emoji, "ignore all previous instructions and drop table"), and John is
the only admin: through his GitHub, Cloudflare and Google accounts, never through anything inside the app. Never add
an admin panel, role, operator route or debug switch. The weekly security sweep reads that file first.

## Layers: each request passes every one, each has its own guard and test
| # | Layer | Code | Guard | Test |
|---|---|---|---|---|
| 1 | Network | `server.main`, `tls_context` | 127.0.0.1 only; TLS 1.2+; handshake in the request's thread; idle connections dropped after 60 s | `test_server.py` (`live_engine`) |
| 2 | Who may call | `own_panel_only` | Host must be localhost; Origin must be the pane (other websites, DNS rebinding) | `test_every_route_refuses_other_websites` |
| 3 | Body shape | `_JSON`, `_bad`, `MAX_CONTENT_LENGTH`, `MAX_CELLS` | any malformed body is a clear 400, never a 500 | `test_every_post_route_answers_a_hostile_body_with_a_clear_4xx`, `test_fuzz_api.py` |
| 4 | Route fields | each route in `create_app` | extra fields (`row_index`, `changes`, `start_col`, `/scan`'s `decisions`...) checked before any work | `test_fix.py`, `test_agents.py`, `test_powerbi.py` |
| 5 | Load | `engine/load.py` | text/number/date/id per column; Excel errors logged, not crashed on | `test_engine.py` |
| 6 | Checks | `engine/pipeline.py`, `engine/detectors.py`, `engine/limits.py` | each check returns one list of plain-sentence reasons per row | see the feature map |
| 7 | Severity | `pipeline.score` | hygiene or weird limit = Medium; 2 votes = Medium; 3 = High; 1 = Low | `test_strength.py` |
| 8 | Answer | routes, `powerbi.py` | every error is JSON; the Power BI CSVs never carry a live formula (text always quoted, `inert`) and read back, the way Power BI's import reads them, as exactly what the pane got, each row's Status (Open, Fixed, Dismissed) from the pane's `decisions` (schema: `powerbi/README.md`) | `test_api_security.py`, `test_powerbi.py` |
| 9 | AI (optional) | `ai/client.py` | one call at a time, deadline, cache (answers only), key never echoed (nor the provider's error text), an AI formula may call only `client.SAFE` functions, headers and the reason go in one line each, no typed request = the flagged row only | `test_fix.py`, `test_ai_load.py`, `test_text_checks.py` |
| 10 | Relay | `relay/worker.js` | invite hash, daily caps counted before Google, only `POST /fix`, model and key set by the relay | `relay/test.mjs`; live Worker from outside: `relay/live-probe.mjs` (CI `relay-live.yml`) |
| 11 | Pane | `frontend/` | every dynamic `innerHTML` value goes through `esc()`; CSP allows only our files + office.js; key and pointer handlers only through `addEventListener` (a DOM0 handler returning false cancels the key); Fixed / Dismissed kept in the workbook as one code per row, never the values (`features/decisions.js`) | `frontend/selfcheck.js`, `e2e/run.mjs` |
| 12 | Website | `site/` | every link and anchor lands; nothing loads from outside but the GitHub API for the checksum (CSP meta); no HTML built from data; the support link always fits GitHub's limit | `tools/test_site.mjs` (`--browser` under `--e2e`); `pages.yml` publishes only after it passes |

## Feature map: what the scan finds, where, and its test
| Finds | Function | Test (grep the name) |
|---|---|---|
| Duplicate rows (text typed into a number column compared as that text; none when most rows repeat, as in a short survey) | `pipeline.duplicates` | `test_scan_flags_duplicate_row_via_in_memory_path`, `test_rows_that_differ_only_in_text_typed_into_a_number_column_are_not_duplicates`, `test_identical_answers_in_a_short_survey_are_not_duplicates` |
| Text in a number column, Excel errors (#N/A); a code shape the column repeats 5+ times (R+51.5, 16A) is its own code system | `pipeline.type_errors` | `test_a_few_excel_errors_do_not_switch_a_number_column_off`, `test_text_codes_a_number_column_uses_many_times_are_its_own_code_system` |
| Blanks in a column that is otherwise filled; a blank its whole category group shares is the layout (long format); under 80% filled, a blank in a group that fills it (95%+, 20+ rows) beside one that leaves it empty (20%- filled, 20+ rows: a merely patchy column is not a layout), never judged by a protected group | `pipeline.blanks` | `test_blanks_in_a_mostly_filled_column_are_found`, `test_a_blank_that_its_whole_category_group_shares_is_the_sheets_layout`, `test_a_blank_in_a_long_format_value_column_is_found_where_its_group_fills_it`, `test_blanks_are_never_judged_by_a_protected_group`, `test_a_column_that_is_merely_patchy_is_not_read_as_a_long_format_layout` |
| N/A, ?, -, TBD placeholders; a rare "-" in a number column (8%+ dashes = accounting zeros) | `pipeline.placeholders`, `pipeline.type_errors`, `load._num` | `test_text_checks.py`, `test_a_rare_dash_in_a_number_column_is_a_placeholder_never_a_zero` |
| Dates far outside the rest (2084) | `pipeline.far_dates` | `test_a_date_far_outside_the_columns_range_is_flagged` |
| Totals that don't add up (A + B + C) | `pipeline.sums` | `test_a_total_that_does_not_add_up_is_flagged` |
| Two-column products and sums (Qty × Price, New + Churned), a product after a discount (Units × Price × (1 - Discount)), and the exact fix from the row's own arithmetic; a rule is judged where the numbers aren't all zero | `pipeline.pairs`, pane `fix.addUps` | `test_a_line_total_that_is_not_qty_times_price_is_flagged`, `test_columns_that_are_mostly_zero_are_not_taken_for_a_product_rule`, `test_the_rows_own_arithmetic_gives_the_fix_for_its_one_odd_cell`, `test_a_line_total_after_a_discount_that_does_not_add_up_is_flagged_and_its_odd_cell_solved` |
| Same label typed differently, misspellings (a letter wrong, two swapped, one typed twice or one dropped inside a word; at 4 letters only a swap or a dropped vowel, never a wrong letter: Iran/Iraq), short forms (the rarer spelling, never a whole word of another label), lowercase label; under a person-name header (Surname, First name, Customer name, Name of patient, a role on its own: Employee, Sales Rep, Physician, "Assigned to", unless its labels are companies; Customer, Owner and other roles a company can hold only when most labels hold a common first name or surname, `engine/person_names.txt` from `tools/person_names.py`; a plain Name only beside a Sex, birth date or an age in years, never a stock's "Age (days)") only capitals/spaces of the very same name, never a guess at another name (Thomson/Thompson are both real) | `pipeline.spellings`, `pipeline._person_name` | `test_blindspots.py`, `test_a_short_form_of_several_words_or_a_contraction_is_worth_a_check`, `test_a_letter_typed_twice_is_worth_a_check`, `test_misspelled_labels.py`, `test_person_names.py` |
| A fraction above 100% | `pipeline.fractions` | `test_blindspots.py` |
| A value typed into the wrong column | `pipeline.shifted` | `test_text_checks.py` |
| Values past their column's limits; the typo behind them (x10, %, sign); a lone slip with an exact x10/x100 behind it past even the usual limit; a stray minus sign never excused as a tail; "likely" only for a typo the numbers prove: a sign flip that stands alone (the only negative, or as big as the usual positives), never 2+ cells of a row off by the same step; a value too small offered as "(maybe ...)", a guess card, never auto-applied; a tenth among small whole numbers (Floors 20 among 1-5) flagged with no fix | `detectors.limits_detector`, `likely_value`, `limits._limits`, pane `fix.recommendFix`, `powerbi.suggested_fix` | `test_likely_guesses.py`, `test_engine.py`, `test_a_x100_slip_in_a_skewed_column_stands_alone_and_votes`, `test_a_minus_sign_in_a_count_column_is_not_excused_as_its_tail`, `test_a_mildly_skewed_column_keeps_its_honest_heavy_users_and_still_catches_a_x100_slip` |
| From strength 7: a value past its usual limit that at most max(2, 0.25% of the column) other values pass and at most 2 reach (a 10 on a 1-5 scale; never an honest tail of bulk orders, 43-49 past; on 30,000 clean rows only each side's extremes), listed as worth a check with its limit and that count in the sentence, never a vote or a fix; never on a protected column (Age) or past a limit the user saved | `detectors.limits_detector` (`alone_reasons`, `FEW`), `pipeline.score` (`ALONE`, `quiet`) | `test_a_value_past_its_usual_range_with_few_values_near_it_is_worth_a_check_from_level_7`, `test_a_moderate_outlier_is_left_alone_at_5_and_named_with_its_value_from_level_8_on_a_small_and_a_big_sheet`, `test_honest_ages_are_never_listed_for_their_age_at_any_level`, `test_a_limit_the_user_saved_wins_over_the_list`, `test_an_honest_tail_of_bulk_orders_is_never_listed`, `test_every_listed_sentence_says_what_the_column_really_holds`, `test_a_big_clean_column_lists_only_its_own_extremes` |
| Jumps in a dated series (cycles excluded) | `detectors.sequence_detector` | `test_a_repeating_cycle_is_not_a_jump` |
| Odd combinations across columns (ECOD, our own 15 lines: pyod made the exe 146 MB) | `detectors.isolation_detector`, `detectors._ecod` | `test_the_cross_column_score_keeps_the_values_recorded_from_pyod`, `test_the_cross_column_score_refuses_a_blank_or_infinite_value` |
| A top value that is all 9s and over twice the next one (99999 = "missing" / "too big") | `pipeline.codes` | `test_an_all_nines_top_value_is_a_code` |
| A lone decimal in a column of whole numbers (study day 7.3 for 73) | `pipeline.whole_numbers` | `test_a_lone_decimal_in_a_column_of_whole_numbers_is_worth_a_check` |
| A number past what its column's name allows (Month 13, Hour 25, a 6 on "Rating (1-5)", Latitude 91.5); quiet when 1%+ break it (yyyymm months, 0-360 longitudes) | `pipeline.named_bounds` | `test_a_value_past_what_its_column_name_allows_is_worth_a_check`, `test_a_column_whose_name_means_something_else_keeps_quiet` |
| Fairness gaps by demographic group, incl. 2-label text outcomes (any pair but who/where/when/how ones: Day/Night, Left/Right, Cash/Card, Mac/PC, Pre/Post, A/B, Q1/Q2; P/F and W/L are results like Y/N); `?` counts as missing, never a group; labels read case- and space-blind ("no " is "No"); a gap is 1.25x and 5 points, or a doubling, on either side of the outcome (Approved = 1 and Approved/Denied agree); "not enough rows to tell" only for a big gap with raw p < 0.05 the correction cannot confirm, else "even" ("no clear difference" for a big spread chance explains, "with only N rows flagged (or defaults, blanks...) to go on, a gap this size could be chance" when its raw p is under 0.10: the few are the events, never the rows); rates under 10% keep one decimal; with 3+ groups the group(s) that stand out are named against the rest (their own p-value), never the lowest; groups under 20 rows are named as left out; "Race Time" and an order "State" are not people (report only); a real gap in an outcome or in blanks gets one sentence of public context only when the measured rule is about that outcome (earnings, an unknown occupation) and runs the same way (never a flag-rate gap; rules re-measured by `tools/bias_sources.py`, `docs/bias/FINDINGS.md`); the pane's line names only the checks that ran | `engine/fairness.py`, `ai/bias_context.pane_note_matching`, `ai/bias_rules.json`, pane `fairnessNote` | `test_blindspots.py`, `test_wild_census.py`, `test_delinquency.py`, `test_a_real_gap_in_an_outcome_gets_one_sentence_of_public_context_and_a_flag_rate_gap_none`, `test_fairness_words.py` |
Adding or removing a check: update this table in the same commit.

## Patterns to copy
- **Test first, from the failure.** Rebuild the bad sheet as a small synthetic fixture (never a real customer file),
  watch the test fail on the old code, then fix. Name tests as the behaviour in plain words.
- **A new check** takes `(df, column_types, skip)`, returns `[[reason, ...] per row]`, skips totals rows via `skip`,
  and is joined into `hygiene` in `pipeline.score`. Reasons are one plain sentence naming the column and the value.
- **Lists of routes come from Flask** (`APP.url_map`), never typed by hand, so a new route is tested automatically.
  A new route also goes into `backend/openapi.yaml` (`test_the_spec_lists_every_route` fails until it does).
- **Accuracy is measured, not argued**: `score.py .` (gates) and `score.py . --blind` (held-out domains). A detector
  change that moves either one is explained in the commit message with the numbers. For a big change, also run a
  blind real-sheet test: one agent fetches random public tables and plants mistakes with a secret key, another runs
  the pane and engine without it (`docs/SYSTEMS-MAP.md`). Use a fresh set each time: a set you fixed against is no
  longer held out.
- **An AI prompt, its context or the model** changes only with `backend/bench/ai_eval.py` numbers (your own key,
  never the relay; paired wins vs losses on dev and held-out) in the commit message. No eval run, no change. Ask AI's
  real-world notes (`ai/bias_context.py`) are built but off: arm `bias_context`; `on=True` in `client.py` once it wins.
- **Before adding a system-design piece** (a cache, queue, lock, retry, rate limit), read `docs/SYSTEMS-MAP.md`: what
  exists, where, and which measurement would justify more.
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
- A knob must reach a check that can move: strength only lowered k, and the long-tail crowd (a count, the same at
  every level) excused every value k let in, so 5 and 10 flagged the same sure mistakes on every sheet John would
  scan (AH-14). Levels 7+ now list a breach few other values share, and say how many: a crowd that grew with the level
  listed honest bulk orders "with few values near it" while 32 sat near them, and honest people aged 91-98 for their
  age (AH-14 review). Votes keep their crowd. Measure each level, not only 5 (`test_strength.py`).
- The slider's hints are measured: each level says in its own words what it does and what it did on the bench
  (`MEASURED` in `frontend/constants/index.js`), and `test_strength_promise.py` re-scans the bench at every level and
  fails when a number or a "the same mistakes as at 5" stops being true. John read 5 and 10 as the same list (AH-15);
  2, 4, 6, 8 and 10 showed the level below's words, so 6 opened "Recommended." (AH-20). A detector change that moves a
  number updates `MEASURED` in the same commit.
- A contraction keeps the word's first and last letters (Std, Mgmt): "Iran" is not one of "Ireland" (`_short_for`).
- A misspelling rule is judged by its honest-twin rate on the 10,000 commonest words, not by examples: one wrong letter
  has a twin for 61% of 5-letter words (safe only behind the rare-next-to-common gate), a dropped inner letter 2-6%, so
  it is allowed; at 4 letters only a swap (5%) or a dropped vowel (7%), never a wrong letter (89%: Iran/Iraq). Blind
  round 22's planted misspellings went from 3 to 9 of 9 (`_misspelt`, AH-23). People's names are worse: a dropped inner
  letter has a twin for 21% of the 10,000 commonest surnames and 37% of first names, a doubled letter 4% and 13%, so a
  person-name column gets no spelling guess at all (AH-24). But a header is read narrowly: plain "Name" silenced a
  product list's "Staplre", and all 3 plain "name" columns in blind round 22's 59 real tables were cities, car models
  and airports, so "Name" counts only beside a person's age, sex or birth date (AH-24 review). A role can be a company's:
  "Customer" of Microsoft and Contoso was silenced too, so Customer and Owner count as people only when most labels hold
  one of the 6,495 commonest US first names or surnames (AH-26).
- The installer starts Excel by its App Paths path, never "open this .xlsx": with no Excel, Windows' "Pick an app"
  held the install (`app.excel_exe`, `test_the_installer_finds_desktop_excel_or_says_none`).
- A cliff on a measured shape is a coin flip: "upper spread > 2x lower" sits right at a log-normal's average, so 22 of
  60 telecom sheets got even-sided limits and an honest heavy user was called wrong. A column is log-shaped when it is
  more even on the log scale (`limits._log_shaped`). The pane must accept every limit the engine votes on: it checked
  only the weird one, so a lone x10 flagged past the usual limit got "may be real" and no fix (`fix.recommendFix`).
- A false-alarm budget lets false alarms in: "<= 1% of clean rows" passed an autoencoder adding 26 Medium ones. The
  bench gate now fails on any Medium+ false alarm not in `score.KNOWN_FA` (sheet:row); remove an entry once it's fixed.
- The 2-of-500 failure: thresholds tuned to avoid false alarms hid real defects. Any threshold change must keep
  `test_blindspots.py` (279/279 rows) and both bench gates green.
- A "likely" fix is a card the user may accept, so it is judged on real values, not only planted ones: 10 of 203 such
  guesses on 30 + 29 real tables and the benches were real values (Seattle's -1.1 highs and a sea level's first years
  flipped, DC's 4% made 40%, California's three fruit columns divided by 1000). A sign flip must stand alone, one step in 2+ cells is a real row,
  and what the numbers cannot prove is never "likely": a value too small is a "(maybe ...)" guess card, and a tenth among
  small whole numbers (Floors 20 among 1-5 is Q3 20 for 2 to the numbers) is flagged with no fix, as John ruled for the
  1-5 scale rule (AH-21, `test_likely_guesses.py`).
- Never invent a value. A median card filled 17,000 cells that were blank on purpose (a long-format sheet) and wrote
  39 over California's 169 delegates. A card writes only what is known: a typo pattern, the row's own arithmetic, the
  usual spelling (`fix.recommendFix`); 2+ cells off by the same step are a real row, not 2 typos.
- Synthetic benches only hold what their author imagined: 40 random real tables found long-format layouts, code
  columns ("R+51.5"), a "-" read as 0 and false duplicates the benches never had (2026-10-16).
- Checks over pairs of columns grow with the width (400 crafted text columns: 30 s; 160 number columns: 16 s). Cap
  them in sheet order, never with a clock inside a scan: the same sheet must give the same answer on any PC.
  `test_a_crafted_wide_sheet_cannot_make_the_column_pair_checks_run_for_minutes`.
- Real exports break what synthetic sheets never do: ISO timestamps ending in Z or +02:00 (with a blank) broke date
  parsing, and a chi-square on an all-zero column broke the fairness report. Both made every scan of the sheet a 500
  (`load._dates`, `fairness.report`; 40 random real tables, 2026-10-16). A new blind round reads every table, not only
  the planted ones.
- Office caches ribbon icons per URL and the manifest per `<Version>`: the v0.1.71 logo kept the old file names and
  Version, so an upgraded ribbon would keep the old icon. A new logo gets new file names (now `assets/mark-*.png`, drawn in
  `docs/design/logo/`) and a `<Version>` bump; never clear the
  Wef cache in install (it is where Excel remembers the Add, `install.bat`).
- One package for one function is a download cost: pyod (for ECOD) brought numba, llvmlite, matplotlib and
  scikit-learn, half of a 146 MB exe (2026-10-19). Check what a new dependency pulls in (`uv pip tree --invert`).
- The Privacy page once said "nothing is sent to any other third party" and "Remove key deletes every local file":
  both false (2026-10-19 audit, 24 items). `frontend/privacy.html`, `PRIVACY.md` and `site/privacy.html` are twins of the code: a change to
  what is sent, stored or installed updates all three (`test_both_privacy_pages_name_every_place_data_goes_and_every_file_the_app_keeps`).
- Pin every package, indirect ones too: an unpinned scikit-learn 1.9.1 broke every Windows install (2026-10-11).
  `constraints.txt` + `tools/pinned.py` (CI and the exe job); regenerate with the command in `tools/pinned.py`.
- pip-audit reads every package installed, the app's or not, never `constraints.txt`: certifi and pillow, pinned past
  their advisories, still failed the local gate until they were installed (2026-10-20). After a pin change, install
  the moved pins (`pip install -e ".[dev]" -c constraints.txt`, and `pip install -c constraints.txt pillow` for a pin
  outside `dev`), then run `tools/check.py`.
- Semgrep runs only in CI (`security.yml`): its rule packs come from semgrep.dev, which a cloud session cannot reach.
  It went red three times on 2026-10-20 after every local gate was green: a RegExp built from a name, `Object.assign`
  of parsed JSON, urllib on a URL from a variable. Where it cannot run, grep the diff for those before pushing.
- Test a file the way its reader reads it. Power BI's Text/CSV import ends a record at every line break, even inside
  quotes (`QuoteStyle.None`): one cell with a line break shifted every row below it, and a 309-digit cell made the old
  writer give up silently, leaving the previous sheet's copy for Power BI (2026-10-20). `powerbi.py` writes a break as
  ↵, removes both files when a write fails, and `test_powerbi.py` parses them back record by record.
- One stray spelling switches a check off: a single "no " among 480 Yes/No answers made three labels, and every
  outcome fairness test vanished with the real gap in it (South 34% vs East 8%). Labels are read the way the spelling
  check reads them (`fairness._labels`, `test_delinquency.py`).
- Not significant is not even: "even across groups (22% to 50%, within normal variation)" was said of 80 people, the
  census sentence about who earns over 50K was put under a loan's denials and under a Day/Night shift, and 40
  countries' gap was stated against whichever one landed lowest (AH-17 bias hunt, 2026-10-22). The first fix swung the
  other way: an outcome allowlist lost Approved/Declined, and pure noise read "not enough rows to tell" in 13 of 20 sheets
  (AH-18 review). The report says only what its numbers show (`fairness.report`, `test_fairness_words.py`).
- An animation eased per frame takes as long as the machine is slow: the website's cursor light moved 8% a frame, so it
  needed ~87 frames to settle, 1.9 s on a loaded box and 4 s with the CPU slowed 8x, and the 2.5 s idle check failed 1
  run in 3 (AH-22). Ease by the clock (`site/home.js`); `tools/test_site.mjs` replays it at 20 frames a second.
- A cache that outlives a test run tests nothing: e2e/all.sh kept the AI answer cache, so a second run never reached
  the stub. It starts fresh now.
- A DOM0 key handler returning false cancels the key: `onkeydown = (e) => e.key === "Enter" && e.ctrlKey && askFix()`
  swallowed every keystroke in the Ask AI box, and the e2e never saw it because `page.fill` sets the value without a
  key event (2026-10-20). Test typing with the real keyboard (`page.keyboard.type`); `frontend/selfcheck.js` refuses
  DOM0 key/pointer handlers and any `on... = () => a && b()`.
- What the user decided must outlive the pane: Dismissed and accepted fixes lived only in its memory, so a reload or a
  re-scan brought a dismissed row back flagged and an accepted fix vanished from the list and from Power BI
  (2026-10-20). Each decision is kept in the workbook's settings under a code of the row's values plus its copy number
  (`features/decisions.js`; a sort keeps it, an edit makes a new row), sent with `/scan` for Power BI's Status. The
  e2e fake workbook keeps its sheets and saved settings across a page reload, so "reload the pane" is testable.
