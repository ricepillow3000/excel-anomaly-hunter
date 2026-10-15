# Audit iteration log: the "two-row" failure and the fairness protocol

The test sheet is `Delinquency_prediction_dataset_2.xlsx`: 500 customers and 19 columns. It is kept out of this public repo; its defects are rebuilt as a synthetic fixture in `backend/tests/test_blindspots.py`.

Each iteration records the hypothesis, the code change, and the test result. Read this before changing direction.

## Ground truth (QA Lead): what "cleaned perfectly" means

| Defect | Cells |
|---|---|
| Blank Income | 39 |
| Blank Credit_Score | 2 |
| Blank Loan_Balance | 29 |
| Credit_Utilization above 100% (1.002-1.026; the rest are 0.05-0.97) | 4 |
| Employment_Status `employed` (the column also has `Employed`) | 77 |
| Employment_Status `EMP` (an abbreviation of `Employed`) | 81 |
| Employment_Status `retired` (lowercase; every other label is capitalised) | 87 |
| **Total** | **319 cells in 279 distinct rows** |

These are deliberately **not** anomalies:
- `Missed_Payments` equals the number of "Missed" months in only 14% of rows. It is counted over a different period, so it is not a rule.
- `Account_Tenure` against `Age` has unknown units.
- Subgroup gaps in delinquency rate are real, valid data. They are reported, never "fixed".

**Pass criteria:**
1. All 279 truth rows are flagged, with the right reason.
2. 0 of the 221 clean rows are flagged Medium or High.
3. The fairness report names the protected columns and tests them with significance.
4. Existing gates stay green: pytest, bench GATES with harm 0, pane selfcheck, and e2e.

## The 5-agent Council

- **Python Architect.** The loop does not stop after two rows. Every row is scored, but each check has a gate the real defects never pass:
  - `blanks()` flags only in columns at least 95% filled. Income is 92.2% filled and Loan_Balance 94.2%, so 68 blanks were skipped. Only Credit_Score (99.6%) got through, and those are the 2 rows found.
  - `spellings()` flags a capitals variant only when the usual spelling is at least 3x as common. `Employed` has 82 rows and `employed` 77.
  - Nothing knows abbreviations (`EMP`), or a column's capitalisation convention.
  - The number limits are median plus 6 spreads, which never reaches a 1.03 in a 0-1 ratio column. There is no notion of "a fraction cannot exceed 100%".
- **Data Auditor.** The file itself is clean to read: no merged cells, formulas or text-typed numbers, one header row, and IDs that all match `CUST\d{4}`. The blindspot is entirely in detection thresholds, not parsing.
  - The defects are of three kinds: optional-looking blanks in required fields, one categorical column with four spellings of two categories, and a bounded ratio just over its bound.
- **Bias & Ethics Lead**, turning slides 4 and 5 into code:
  - *Exclude protected demographics.* Find protected and proxy columns from their headers: age, birth date, gender, sex, race, ethnicity, religion, marital status, nationality, disability, and location, city, state, zip and postal as geographic proxies.
    - They are still checked for data quality (a blank Age is an error).
    - They are never used to judge whether a person is "unusual" in the multivariate outlier model, so a 74-year-old is not flagged for being 74.
  - *Monthly bias tests on demographic subgroups.* For each protected column, numeric ones in age bands, compare subgroups on three things:
    - flag rate, which covers the "monitor false-positive rates" slide;
    - blank rate per column, because missing data skewed toward one group biases any model trained on it;
    - the rate of any 0/1 outcome column (Delinquent_Account).
    - Report a gap only when it passes the four-fifths rule *and* a significance test (p < 0.01 after a Bonferroni correction), so noise is not called bias.
  - *Explainability.* Every finding is one plain sentence.
  - *Human oversight for severe actions.* Bias findings are advisory: never auto-fixed, never hidden.
- **UX Engineer.** The report gets one new "Fairness" sheet with one row per test and a plain verdict ("even" or "gap - check"). The pane gets one line under the summary.
  - New reasons follow existing wording: `Employment_Status "EMP" looks like a short form of "Employed"`.
  - Abbreviation and lowercase-label findings are "worth a check" (Low). Capitals variants and blanks stay "probably wrong" (Medium).
- **QA Lead.** Pass criteria are above. Every fix is test-first on a synthetic copy of the defect, and the bench gates guard against false alarms elsewhere.

## Iterations

### Iteration 0: baseline (reproduce)
- **Hypothesis:** the tool misses most of the sheet.
- **Change:** none, current `main` (`c35814f`).
- **Result:**
  - CLI: `anomaly-hunter scan` writes report.xlsx with **2 flagged rows** (117 and 380, blank Credit_Score).
  - Pane path (`tableFromGrid` then `/scan`): the same 2 rows.
  - Detectors: limits ran, isolation ran, sequence sat out (no order column).
  - **Caught 2 / 279 rows (0.7%).**

### Iteration 1: the two gates that hid most defects
- **Hypothesis (Architect):** the 95%-filled gate on blanks and the 3x gate on capitals variants hide 147 of the 279 rows.
- **Change:** `pipeline.blanks` threshold 0.95 -> 0.80 (mostly-empty optional columns stay quiet). `pipeline.spellings` now flags every spelling but the right one. The right one is written in the column's style (capitalised or not), then the most common. Auto-fix still needs the right spelling to be 5x as common.
- **Result:** caught **129 / 279** on both paths (pane and CLI), with **0 false flags**. Blanks 70/70 and `employed` 77/77.
  - Still missed: `EMP` 71, `retired` 77, ratio over 100% 4. The few `EMP`/`retired` hits are rows that were flagged for a blank.
- **Next:** short forms, a lowercase label in a capitalised column, and a 0-1 ratio above 1.

### Iteration 2: short forms, a lowercase label, ratios over 100%
- **Hypothesis (Data Auditor):** the 150 rows still missed are three label/bound patterns no check knows.
- **Change:**
  - In `pipeline.spellings`, a 2-4 letter label that starts exactly one other label (5+ rows, 2+ letters longer) is "worth a check: looks like a short form of 'Employed'".
  - A label written all lowercase where the column's 3+ other labels are capitalised is "worth a check: is lowercase". Both are offered as a fix the user confirms, never auto-fixed.
  - New `pipeline.fractions`: in a column of fractions (98%+ of values between 0 and 1, mostly not whole numbers), a value above 1 is "worth a check: above 100%".
- **Result:** caught **279 / 279** on both paths, with **0 false flags** (129 Medium, 150 Low). Bench GATES still pass (51/51, harm 0, Medium+ false alarms 0).
- **Regression found:** the API fuzzer crashed on a text column with no labels at all (the mean of an empty list).

### Iteration 3: fuzzer regression
- **Hypothesis (QA Lead):** the new column-style check divides by an empty label list.
- **Change:** the column style is counted with plain Python (`sum(...) >= len(labels) / 2`), which is safe for 0 labels.
- **Result:** pytest 195 passed + 1 known xfail (the fuzzer is green again), and still 279/279 with 0 false flags.

### Iteration 4: the fairness protocol (Bias & Ethics Lead, slides 4-5)
- **Hypothesis:** protected columns can be found from their names, kept out of the "who is unusual" models, and tested by subgroup with significance, without touching the defect catch.
- **Change:**
  - New `engine/fairness.py`. `protected()` finds demographic and location-proxy headers. `report()` runs a chi-square test by subgroup (age bands, or the column's labels; groups of 20+ rows) on three measures: flag rate, the blank rate of every column with 5+ blanks, and every yes/no outcome column. A gap needs a 1.25x rate ratio (the four-fifths rule), a 5-point difference, and p < 0.01 after Bonferroni.
  - In `pipeline.score`, the sequence and isolation detectors get only non-protected columns. Limits, blanks and spellings still check protected columns.
  - `scan_agent.scan` returns the report, `/scan` returns `fairness`, the CLI report gets a Fairness sheet, and the pane gets one line.
- **Result:** the first test run had 4 failures:
  - 2 were old tests expecting the 5-value scan result and 3 report sheets. They were updated, because both changes are intended.
  - 1 was my fixture: `retired` rows that also had a blank Income are Medium, not Low.
  - 1 was **a real bug**: `Delinquent_Account` was typed as an **ID** because its header ends in "Account". A 0/1 column was never checked as a number, and was invisible as an outcome.

### Iteration 5: a 0/1 column is a yes/no flag, never an ID
- **Hypothesis (Data Auditor):** `_is_id` trusts the header over the values.
- **Change:** `load._is_id` returns False when a column holds only 0s and 1s.
- **Result (final):**
  - pytest **207 passed** + 1 known xfail, including 14 new tests in `test_blindspots.py`.
  - Bench GATES pass (51/51 caught, harm 0, Medium+ false alarms 0 of 2,724 clean rows). Pane selfcheck passes. `ruff -S` is clean. Browser e2e `flow` 50/50 and `nokey` pass.
  - On the sheet, pane and CLI: **279 / 279 rows, 319 / 319 cells with the right reason, 0 false flags** (129 Medium, 150 Low).
  - The pane says "129 of 500 rows look wrong. 150 more are worth a quick check." The report's Anomalies sheet has 279 rows.
  - Fairness: Age and Location are protected, and 8 subgroup tests are all **even**: flag rate p = 0.48 and 0.55, blank Income p = 0.20 and 0.90, blank Loan_Balance p = 0.72 and 0.53, delinquency p = 0.46 and 0.66.
  - The New York (12%) vs Los Angeles (20%) delinquency difference is real in the data but not significant at about 100 rows per city, so it is reported as within normal variation, not called bias.
  - Planted-gap test: Income left blank mostly in Phoenix is reported as a **gap**.

## How the blueprint maps to code
| Slide 4/5 item | In the tool |
|---|---|
| Exclude protected demographics | Protected columns are kept out of the outlier and sequence models, but still checked for typos and blanks |
| Rebalance data to prevent bias | Not a detector's job. Instead it **reports** skew (blank-rate and outcome gaps by group) so the person training a model can rebalance |
| Explainability tools | Every flag and every fairness test is one plain sentence, plus groups, rates and p-value in the report |
| Mask personal data | Unchanged: no row data leaves the PC unless AI help is on, and then only the row asked about |
| Human oversight for severe actions | Fairness findings are advisory, never auto-fixed. Short-form and lowercase fixes are guesses the user confirms |
| Monthly bias tests on demographic subgroups | Run on **every** scan, by subgroup, with significance |
| Monitor false positive rates | The flag-rate test: if one group gets flagged more often, it is reported |

# Backtest 2026-10-14: a new user, real Excel, and wild data

Three phases, each scored 0-10 by a strict non-technical user. Below 8 means fix, rebuild and test again.

## Phase 3: wild data, the UCI Adult census
- **Dataset:** 48,842 people and 15 columns, the original UCI file (train + test, via a GitHub mirror because archive.ics.uci.edu is blocked here). It is kept out of the repo; `backend/tests/test_wild_census.py` rebuilds its shapes.
- **Ground truth:**
  - `?` for unknown workclass (2,799), occupation (2,809) and native-country (857).
  - capital-gain `99999`, a "too big to record" code: 244. The next highest value is 41,310.
  - Exact duplicate rows: 52.
  - **Total: 6,761 cells in 3,896 rows.**
- **Not defects:** hours 1-99 around a usual 40; capital losses in a 96%-zero column; survey weights (fnlwgt) up to 8x the median; age 90; the income gaps between groups (real; reported, never "fixed").

### Iteration 6: baseline
- **Result:** caught **3,896 / 3,896** on both paths, but **1,490 false flags** (1,488 Medium), 28% of all flags. Pane scan 9.0 s, CLI 14.4 s.
- The false flags are all the limits check:
  - capital-loss 876, because 96% zeros make the median 0;
  - hours-per-week 355, because 47% of people work exactly 40, so the spread is tiny;
  - capital-gain 176;
  - fnlwgt 81.
- **Fairness found the tool's own bias:** people 60 and over were flagged 27% of the time vs 8% for 30-44, partly by those hours false alarms (part-timers, retirees).
- Fairness also missed the income gap: `income` is text, `<=50K` / `>50K`, and only 0/1 numbers counted as outcomes.

### Iteration 7: a slip stands alone, a tail is crowded
- **Hypothesis:** a real error sits far from the other values. A long tail has other people all the way back to the median.
- **Change:**
  - `limits_detector`: a value past the weird limit is weird only when fewer than 5 other values (or 0.05% of rows) lie between it and halfway back to the median. Copies of itself don't count.
  - "Halfway" is the nearer of the two midpoints. A low positive value uses the ratio scale: Sq Ft 19 for 1915 is 100x small, and 600 sq ft flats in between don't make it normal.
- **Result:** false flags 1,490 -> 15. Bench 51/51 (the first try, without the ratio-scale midpoint, lost the Sq Ft case: 50/51).
  - A strict-xfail "known limitation" now passes: two product price clusters no longer flood. The test was made a normal test.

### Iteration 8: a mostly-zero column, and the all-9s code
- **Change:**
  - In `_limits`, a column that is 50%+ zero is judged on its non-zero amounts (log scale), like a long right tail. This removed the last 8 Medium false flags (capital losses of $700-1,100).
  - That also stopped 99999 from crossing the limit, so a dedicated check, `pipeline.codes`, was added: a column's top value is all 9s, has 3+ digits and is over twice the next one. It reads "capital-gain 99999 looks like a code, not a real value (all 9s, over twice the next highest, 41310)" (Medium).
- **Result:** **3,896 / 3,896 rows, 6,761 / 6,761 cells with the right reason, 0 Medium+ false flags**, and 7 Low "worth a check" (0.016% of clean rows: a 71-year-old working 2 hours with a capital loss; 99-hour weeks).

### Iteration 9: fairness on real data
- **Change:**
  - A two-label text column is an outcome; the rarer label is counted (`income >50K`).
  - `?`, N/A and unknown count as missing, and are never a group.
  - Category columns with up to 50 labels are tested (was 20; groups under 20 rows still drop out).
  - "Significant but under the four-fifths line" now says "a real difference, but small". Before, it said "within normal variation" at p = 6.5e-19, which was wrong.
- **Result:** every well-known Adult disparity is reported as a gap, for example:
  - sex: Male 30% vs Female 11% earn >50K;
  - race: Asian-Pac-Islander 27% vs Amer-Indian-Eskimo 12%;
  - age: 45-59 38% vs under 30 5%;
  - marital status: married 45% vs never-married 5%;
  - age 60 and over: 18% missing occupation vs 2% for 30-44.
- The flag-rate gap for 60+ is now 21% vs 5%. It is driven by real missing occupations (retirees), not by false alarms.
- The pane names the 3 widest gaps and lists every test under "All fairness checks".

### Iteration 10: audit finding #1 (sign flips on returns) closed
- **Found:** a regression run on Online Retail (250k rows) showed the tail rule correctly dropped 85 return rows, but 81 bigger returns (-144, -192) were still offered "likely 144". That would turn a refund into a sale.
- **Change:** a sign flip is offered only where negatives are under 1% of the column (was 5%). Retail has 2.1%.
- **Result:** 0 flips offered on retail. The famous 74,215 / -74,215 order is still flagged. Scan 29 s for 250k rows, unchanged.

### All gates after Phase 3
- pytest **218 passed** (0 xfail).
- Bench GATES pass (51/51, restored 44, harm 0, Medium+ false alarms 0 of 2,724).
- Delinquency sheet still 279/279 with 0 false flags.
- Selfcheck passes. Browser e2e flow/ai/nokey: 62 checks. The planted e2e outlier changed from 9999 to 7777: an all-9s 9999 is now rightly a "missing" code, a basic, not a plain outlier.
- ruff -S clean.

## Phase 1: download and install
- **Before:**
  - The only download was an Actions artifact: it needs a GitHub login, comes zipped, expires in 90 days, and sits 4 pages deep.
  - The CI test skipped the internet-zone warning every real download gets.
- **Change:**
  - A `release` job publishes AnomalyHunter.exe as the latest GitHub Release, on main only and only after the fresh-PC job installed and used that exact file. The README's step 1 is now one direct link.
  - The fresh-PC job puts the Mark of the Web on the file. The clicker answers "Open File - Security Warning" -> Run and SmartScreen -> More info -> Run anyway, and logs every window that appears.
- **Getting the test to see what a user sees:** 4 CI rounds. All were test bugs, not app bugs.
  1. `Start-Process` opens files with Windows' "no UI" flag. The internet-file warning can't show, so Windows reports "canceled by the user" in 3.6 s. Fix: double-click through Explorer.
  2. `Select-String` on a log that doesn't exist yet stops a stop-on-error step, despite `-ErrorAction`. Fix: Test-Path first.
  3. A window titled "Window Dialog" appeared and nobody answered it. The clicker could only press known titles. Fix: describe every new window and press Windows' own Run anyway / Run / More info.
  4. **Pass** (`5e8d9ba`). The log shows what the user sees:
     - Explorer's empty "Window Dialog" launcher;
     - **Microsoft Defender SmartScreen**: "Windows protected your PC ... prevented an unrecognized app from starting", with More info and Don't run. The clicker pressed More info, then Run anyway;
     - the certificate prompt (Yes);
     - "Anomaly Hunter is installed ... Start here" (OK).
     - **37 s from the double-click to installed, warnings included.** The internet mark is gone from the installed copy. Pane flow passes in Edge. Uninstall leaves nothing.
     - "Pick an app" appeared only because the runner has no Excel to open Start here.xlsx.
  5. **A re-run of the same app hung** (`7230c17`, a docs-only commit). That "Pick an app" was a real installer bug.
     - Asking Windows to open an .xlsx on a PC with no Excel can hold the installer until someone picks an app. The "installed" message never came, and it timed out at 310 s.
     - The passing run had only won the race.
     - Fix: `app.excel_exe()` finds desktop Excel where Windows registers it (App Paths) and starts it with the workbook. With no Excel, the message says where Start here.xlsx is. It never asks Windows to guess. Tested with a stand-in registry.
- **Found on the way and fixed:** the installed copy kept the download's internet mark. That copy runs at every logon, so Windows could warn at each boot. The installer now removes the mark from its own copy, and CI checks it.
- **Score 8/10:** one link, then one SmartScreen box (2 clicks), then one certificate Yes, then OK, in under a minute. The README names each box before it appears.
  - Not higher, because SmartScreen's Run anyway hides behind More info, and the certificate text is scary. Only code signing removes SmartScreen (Azure Trusted Signing is about $10/month): a cost decision for John.

## Phase 2: Excel integration
- **Before:** Excel opened blank. The 5 Add clicks were in a message box that was gone after one click.
- **Change:** the installer writes and opens `Start here.xlsx`:
  - the 5 Add steps stay on screen;
  - a Practice sheet holds 5 planted problems, and a test checks exactly those 5 rows are found;
  - it is checked in the fresh-PC job.
- **Still there:**
  - The 5 Add clicks remain. Only an admin-deployed or store add-in skips them.
  - CI has no Excel: the pane runs in Edge against the installed engine, and the ribbon and the Add dialog are checked on John's laptop.
- **Score 8/10:**
  - the steps stay on screen while the user clicks;
  - the first scan finds exactly the 5 problems the steps promise, in plain words;
  - the fresh-PC pane flow passes (scan, fix, Undo, Dismiss, limits, strength, auto-fix, fairness list).
  - Not higher: the 5 Add clicks are Microsoft's, and opening Start here in real Excel is confirmed on John's laptop, not in CI.
- **Seen, not this PR's:** the e2e fixture sheet gets 71 "worth a check" flags from the trend check, the same on `main`. Its prices repeat in a 4-day sawtooth, so each drop looks like a jump. Users' Practice sheet scans to exactly 5. Left as a follow-up.
