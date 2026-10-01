# Anomaly Hunter Engine: Design Spec

Date: 2026-10-01
Status: approved in brainstorming (parts 1 and 2), awaiting written-spec review
Sub-project: 1 of 6 (engine + openpyxl report). See `docs/design/brainstorm-notes.md` for the full project and the decisions log.

## Purpose

A command-line Python engine that reads CSV or Excel files, finds anomalies, and writes a formatted `report.xlsx` that explains each one in plain words. It never modifies its input files.

Later sub-projects (local server, side panel, Claude triage, Route Monitor, Power BI export) only display or act on what this engine produces. Detection quality is therefore built and proven here first.

## Usage

```
anomaly-hunter scan FILE [FILE ...] [--limits limits.csv] [--order-by COLUMN] [--out report.xlsx]
```

- `FILE`: one or more `.csv` or `.xlsx` files. For `.xlsx`, the first sheet is read.
- `--limits`: path to the limits file. Default `limits.csv` in the current directory.
- `--order-by`: column that orders the rows for the sequence detector. Default: auto-detect (see Sequence detector).
- `--out`: report path. Default `report.xlsx`. The engine refuses to write to a path that is one of the input files.

Exit codes: `0` report written; `2` limits file was missing and suggestions were written instead; `1` error (message names the cause).

## Pipeline

1. **Load** (`load.py`)
2. **Limits** (`limits.py`)
3. **Detect** (`detectors.py`)
4. **Hygiene checks** (`hygiene.py`)
5. **Combine** (`combine.py`)
6. **Report** (`report.py`)

`cli.py` wires the steps together with `argparse`. Each module is a set of pure functions over pandas DataFrames, testable on its own.

### 1. Load

- Read every input file with pandas. Add a `source_file` column holding the file name.
- Concatenate with `pd.concat`. Files with different columns are unioned; missing cells stay blank, and the Summary sheet warns which files lacked which columns.
- Classify each column:
  - **number**: at least 90% of non-blank cells parse as numbers.
  - **date**: at least 90% of non-blank cells parse as dates.
  - **text**: everything else.
- For number columns, cells that fail to parse become missing values for the detectors and are reported by the hygiene checks.
- An unreadable file stops the run with exit code 1 and a message naming the file.

### 2. Limits

File format, one row per number column:

```
column,baseline_low,baseline_high,weird_low,weird_high
Price,20,80,0,10000
```

A blank cell means "no limit on that side".

- **No limits file:** write suggested limits for every number column and exit with code 2. The message tells the analyst to review the file and run again.
  - `baseline = median ± 3 × spread`
  - `weird = median ± 6 × spread`
  - `spread` is the robust spread defined under Shared rule. Suggestions are rounded to 3 significant figures.
- **Limits file exists:** use it as written. The engine never overrides the analyst's numbers.
  - A column listed in the file but absent from the data produces a warning and is skipped.
  - A number column missing from the file gets no limits; the other detectors still run on it.

### Shared rule: robust cutoff

Every detector turns rows into a "how weird" score and votes yes when the score is far from the middle:

```
vote = |score - median(score)| > K × spread(score)
K = 6
spread = 1.4826 × MAD (median absolute deviation)
```

- If MAD is 0, use `1.2533 × mean absolute deviation` instead.
- If that is also 0, the series is constant and the detector casts no votes on it.

Both constants put the spread on the same scale as a standard deviation for normal data. `K` is one named constant in `detectors.py`.

PyOD's `contamination` setting, which always flags a fixed share of rows, is not used for voting.

### 3. Detectors

There are four detectors. Each returns, per row:
- a vote (yes or no),
- a magnitude: how many spreads past the cutoff the row is, used for sorting,
- a reason string, which names the column involved where possible.

**Limits detector**
- A breach of a **weird** limit is a vote. The magnitude is the distance past the limit, divided by the column's spread.
- A breach of a **baseline** limit alone is not a vote. It marks the row as **Noted**.
- Example reason: `Price weird limit is 10,000; this is 48,000`.

**Sequence detector**
- Runs only when the rows have an order.
- The order column is `--order-by` if given. Otherwise it is the first date column.
- With no order column, the detector sits out, and the Summary sheet says so.
- Rows are sorted by the order column (stable sort) before scoring.
- For each number column, it computes:
  - the 1st, 2nd and 3rd differences (`diff()`, applied once, twice and three times);
  - the trend residual: value minus the centered rolling median, window 7.
- Each of these four series goes through the shared cutoff.
- A spike makes the differences jump at several neighbouring rows. So a difference series that crosses the cutoff at row t blames only one row: the row in t-3 to t with the largest absolute trend residual.
- Example reason: `Revenue jumped sharply on 2026-03-14 (3rd-order change)`.

**Isolation detector**
- PyOD `ECOD`, fitted on all number columns.
- Before fitting, each column is robust-scaled (median 0, spread 1). Missing values are filled with the column median, for the model only.
- The shared cutoff is applied to `decision_scores_`.
- The reason names the column with the largest absolute robust z-score for that row.
- Example reason: `Unusual combination of values, mainly Discount`.

**Clustering detector**
- scikit-learn `DBSCAN` on the same robust-scaled number columns.
- `min_samples = max(5, 2 × number of number columns)`.
- `eps`: for each row, take the distance to its `min_samples`-th nearest neighbour. `eps` is the shared cutoff applied to those distances, i.e. `median + K × spread`.
- Rows labelled `-1` (noise) get a vote.
- Example reason: `Does not belong to any group of similar rows`.

**Small data guard:** with fewer than 30 rows, the sequence, isolation and clustering detectors sit out. Only limits and hygiene checks run, and the Summary sheet says so.

**Determinism:** every random seed is fixed, so the same input always produces the same report.

### 4. Hygiene checks

These are facts, not votes. A row with a hygiene finding is at least **Medium** (see Combine).

- **Duplicates.** A row identical to an earlier row in every column except `source_file`.
  - The first occurrence is not flagged; later copies are.
  - Reason: `Duplicate of row 12 (sales_jan.csv)`.
- **Type errors.** Text in a number column. Reason: `Text "N/A" in number column Price`.
- **Blanks.** A blank cell in a column that is at least 95% filled.

### 5. Combine

Severity:

| Condition | Severity |
|---|---|
| Baseline limit breach only, no votes | Noted |
| 1 vote | Low |
| 2 votes | Medium |
| 3 or more votes | High |

- A weird limit breach is always at least Medium.
- A hygiene finding is at least Medium.
- A row with no breach, no votes and no hygiene finding is not an anomaly.

Bucket (the Active Anomalies table in the dashboard sketch):
- **Duplicates:** duplicate rows.
- **Irregularities:** type errors, blanks, and weird limit breaches.
- **Behavioral:** votes from the sequence, isolation or clustering detectors.

A row that falls into several buckets is listed under the first that applies, in the order Duplicates, Irregularities, Behavioral. All of its reasons are kept.

Ordering: by severity (High first), then by the largest magnitude.

The reason text joins the reasons of every detector that fired. The count is out of the detectors that actually ran, so it reads "of 1" when the small data guard applies. For example:

```
Flagged by 3 of 4: Price weird limit is 10,000, this is 48,000; Revenue jumped sharply on 2026-03-14; unusual combination, mainly Discount
```

### 6. Report

openpyxl writes `report.xlsx` with three sheets.

- **Data**
  - The combined input rows, plus columns `Severity`, `Bucket` and `Reason`.
  - Rows are filled by severity: Noted light yellow, Low yellow, Medium orange, High red.
  - The specific cell that triggered a finding gets an Excel note with its reason.
- **Anomalies:** only the flagged rows, in the Combine order, with the same extra columns plus `Row` (the row number in the Data sheet) and `source_file`.
- **Summary**
  - Counts by bucket and by severity.
  - Which detectors ran and which sat out, with the reason why.
  - Every warning from load and limits.
  - The limits file used and the value of `K`.

The input files are opened read-only and never written.

## Error handling summary

| Situation | Behavior |
|---|---|
| Unreadable input file | Exit 1, message names the file |
| `--out` equals an input path | Exit 1 before any work |
| No limits file | Write suggestions, exit 2 |
| Limits column not in data | Warning, skipped |
| Fewer than 30 rows | ML detectors sit out, noted in Summary |
| No order column | Sequence detector sits out, noted in Summary |
| Constant column | No votes from that column |

## Testing (test-first, pytest)

All tests use synthetic data generated with fixed seeds inside the tests.

1. **Hazmat tests.** A clean dataset with planted anomalies, each of which must be caught and land in the right bucket:
   - a single spike in an ordered series (Behavioral, blamed on the correct row, not its neighbour);
   - a duplicate row (Duplicates);
   - `"N/A"` in a number column (Irregularities);
   - a row whose values are each normal but whose combination is not (Behavioral via isolation);
   - a weird limit breach (Irregularities, at least Medium).
2. **Quiet-crowd test.** 1,000 rows of clean normal data, scanned with the engine's own suggested limits, produce at most 1% of rows at Low or above. Noted rows don't count, because baseline breaches are expected in about 0.3% of normal values per column.
3. **Limits tests.**
   - A missing file writes suggestions and exits 2.
   - Blank cells mean no limit.
   - An unknown column warns and does not crash.
4. **Report test.** Open the output with openpyxl and check the three sheets, the severity fills, the cell notes and the Summary contents.
5. **Safety test.** The input files' bytes and modification times are unchanged after a scan.
6. **Determinism test.** Two runs on the same input produce identical Anomalies sheets.

## Packaging

- `pyproject.toml`, package `anomaly_hunter`, console script `anomaly-hunter`.
- Runtime dependencies: pandas, numpy, scikit-learn, pyod, openpyxl.
- Dev dependency: pytest.
- Python 3.10 or newer. Checked on PyPI 2026-10-01:
  - PyOD 3.6.6 requires numba;
  - numba 0.68.0 supports Python 3.10 to 3.15.

```
anomaly_hunter/
  __init__.py
  cli.py
  load.py
  limits.py
  detectors.py
  hygiene.py
  combine.py
  report.py
tests/
```

## Out of scope for this sub-project

- Local server, side panel, live highlighting, and the approve / undo flow (sub-projects 2 and 3).
- Claude triage, useful-weird vs broken-weird (sub-project 4).
- Route Monitor (sub-project 5) and Power BI export (sub-project 6).
- Per-group trends, e.g. derivatives per store.
- Text-column anomaly detection beyond hygiene checks.
- Reading sheets other than the first in an `.xlsx`.
