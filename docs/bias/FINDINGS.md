# What real bias looks like in tables (measured 2026-10-20)

Why this exists: Ask AI and the fairness report started from zero. They knew nothing about what real group
differences look like, so a real gap between groups could pass for a data error, or a fix could drift toward a
group's average. These numbers, measured from public tables, are what `backend/anomaly_hunter/ai/bias_rules.json`
holds. The rules describe real gaps so they are not mistaken for typos. They are never an expectation to "correct"
someone's value toward their group: that is the one rule that is always on (`bias_context.PROTECT`).

Re-measure: `python tools/bias_sources.py` (writes the JSON) or `--check` (exit 1 if a fresh measurement differs).
No model is trained; every number is a count, a rate, a median or a quartile.

## Sources (pinned; the raw tables are not in this repo)

| Name | Rows | File (commit-pinned URL) | SHA-256 | Licence |
|---|---|---|---|---|
| UCI Adult, US census 1994 | 48,842 | `jbrownlee/Datasets@d20fcb6` `adult-all.csv` (5.3 MB) | `21e0ea2f...` | CC BY 4.0 (UCI); the mirror has no licence of its own |
| UCI Adult, original test part | 16,281 | `jbrownlee/Datasets@d20fcb6` `adult-test.csv` (2.0 MB) | `72567b94...` | CC BY 4.0 (UCI) |
| Statlog German Credit, labels spelled out | 1,000 | `stedy/Machine-Learning-with-R-datasets@ff93323` `credit.csv` (134 KB) | `5c9906df...` | CC BY 4.0 (UCI); mirror README calls its data public domain |
| Medical costs teaching table (Lantz, Machine Learning with R) | 1,338 | `stedy/Machine-Learning-with-R-datasets@ff93323` `insurance.csv` (54 KB) | `505c1cbc...` | none stated; mirror README: public domain. Simulated from US census figures, not real people |
| ProPublica COMPAS, Broward County 2013-2014 | 7,214 | `propublica/compas-analysis@bafff5d` `compas-scores-two-years.csv` (2.5 MB) | `c451db85...` | no licence file; published by ProPublica for analysis of its "Machine Bias" story |

Full commit SHAs and hashes are in `tools/bias_sources.py` and in the JSON's `sources`. Each rule lists the tables it
is measured from in its own `sources`, and names them in its sentence (`test_every_rule_names_the_pinned_public_tables_it_was_measured_from`, AH-37). Only GitHub was reachable
from the machine that measured this (UCI, Kaggle, data.gov and census.gov were blocked), so mirrors on GitHub were
used; each has the original's columns (Adult 15, Statlog German credit 20 plus the outcome).

## 1. Outcome rates differ a lot between groups, in real data

UCI Adult, share earning over 50K (48,842 people):

| Group | People | Over 50K |
|---|---|---|
| Men / women | 32,650 / 16,192 | 30.4% / 10.9% |
| White / Asian or Pacific Islander / Black | 41,762 / 1,519 / 4,685 | 25.4% / 26.9% / 12.1% |
| Under 30 / 30-44 / 45-59 / 60 and over | 14,515 / 18,687 / 11,585 / 4,055 | 5.1% / 29.5% / 38.3% / 24.3% |
| Married (civilian spouse) / never married | 22,379 / 16,117 | 44.6% / 4.5% |
| Self-employed, incorporated / private sector | 1,695 / 33,906 | 55.3% / 21.8% |

German credit, share with bad credit (1,000 loans): women 35.2% (310) vs men 27.7% (690); under 30 36.9% (371)
vs 45-59 24.7% (150); renters 39.1% (179) and people housed for free 40.7% (108) vs owners 26.1% (713); employed under
a year 40.7% (172) vs 4-7 years 22.4% (174).

COMPAS, re-arrest within two years (7,214 people): African-American 51.4% (3,696) vs Caucasian 39.4% (2,454); men
47.3% (5,819) vs women 35.7% (1,395); under 25 56.5% (1,529) vs over 45 31.6% (1,576). ProPublica's own point is
that these labels come from policing, so a gap here describes the records, not the people. The rules quote Adult
for race and use COMPAS only for the share of values far from their group (section 3).

Medical costs (simulated): smokers are 25.0% of people in the southeast (364) and 17.8% in the northwest (325).

What it means for the app: gaps of 2x to 10x between groups are ordinary in real tables. The fairness report
already says "a real gap, check why"; it now adds the closest measured benchmark, so the user is not led to think
the gap itself is a typo.

## 2. Money columns: group medians differ, the ranges overlap

| Table | Column by group | Median | Middle half (Q1-Q3) |
|---|---|---|---|
| German credit | loan amount, women / men | 1,959 / 2,444 | 1,248-3,606 / 1,442-4,266 |
| Medical costs | yearly cost, smokers / non-smokers | 34,456 / 7,345 (4.7x) | 20,826-41,019 / 3,986-11,363 |
| Medical costs | yearly cost, under 30 / 60 and over | 3,214 / 14,255 | 2,135-15,007 / 13,391-28,061 |
| Medical costs | yearly cost, by region | 8,799 to 10,058 | wide and overlapping |
| UCI Adult | hours per week, women / men | 40 / 40 | 30-40 / 40-48 |

A situation (smoking, age) moves amounts far more than sex does, and every group's range overlaps the others.

## 3. A value far from its own group's median is usually genuine

Published tables, taken as recorded. Share of values past their own group's Tukey fence (1.5 times the middle
half beyond it):

| Table | Values | Past their group's fence |
|---|---|---|
| German credit, loan amount by sex | 1,000 | 75 (7.5%) |
| COMPAS, prior offences by race | 7,214 | 645 (8.9%) |
| Medical costs, yearly cost by smoker | 1,338 | 46 (3.4%) |

Setting each medical cost to its smoker group's median would move a typical real value by 41%. A group's average is
not a fix: it erases the person. This is why the protective rule says a fix may come only from the row's own
arithmetic, a clear typing slip, or the user's request.

## 4. Label hygiene seen in real files

- `?` means unknown in Adult: 2,799 workclass (5.7%), 2,809 occupation (5.8%) and 857 native-country (1.8%) cells.
  The fairness report already counts `?` as missing, never as a group.
- Blanks gather by group for honest reasons: occupation is unknown for 18.4% of people 60 and over vs 2.3% aged
  30-44, and for 7.9% of women vs 4.7% of men. By race it stays between 5.6% and 7.6%.
- The same census table is written two ways: the test part (16,281 rows) has a space after every comma and labels
  with a dot (`' >50K.'`, `' <=50K.'`); the main file has neither. Merged, two outcomes become four labels. The
  fairness report already reads labels case- and space-blind.
- Caps are codes: in Adult 55 people are exactly 90 (only 2 are 89), 137 work exactly 99 hours, and 244 have
  capital gain 99999. COMPAS has 307 blank screening-to-arrest days (4.3%).
- Case varies between files of the same kind: the medical-cost table writes `female` and `southeast`; Adult writes
  `Female`.

## How the rules are used

- Fairness report (on now, rule-based): a gap in an outcome or in blanks, on a column whose words match a rule
  topic (sex, race, age, marital status), gets one sentence: "For comparison, ... so a gap like this is
  common in real data: check how the rows were collected and what else differs between the groups, never change a
  value toward its group." Never on a flag-rate gap: that one is about our own checks.
  Never on a place gap either: the only regional figure measured here (smokers by region) comes from a simulated
  teaching table and is no benchmark for a real sheet's regions, so a place gap gets no sentence rather than a
  misleading one.
- Ask AI (built, off): on a sheet with a demographic column, up to 6 lines after the flagged row's reason, the
  protective rule first. If the request is too big, the measured rules leave first, then rows (the rows are the
  evidence); the protective rule never leaves. It goes in only after `backend/bench/ai_eval.py` arm `bias_context`
  wins on dev and held-out.
- Every line comes from the JSON or the code, never from the sheet: headers and the reason only choose which lines.
