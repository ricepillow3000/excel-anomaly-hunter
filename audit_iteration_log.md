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
