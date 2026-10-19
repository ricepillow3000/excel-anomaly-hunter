# Algorithm debate: how Anomaly Hunter decides a cell is wrong

Written 2026-10-16 (JOHN desktop). A design record, not new code. It compares three ways to catch
tabular anomalies, says why the shipped approach wins, and records why the 4 `decimal_x10` misses on the
blind bench are left as "Noted" rather than forced to "Medium".

Measured state at `47f0da9`: main bench 51/51 caught, 0 harmful fixes, 0 Medium+ false alarms / 2724 clean cells;
blind bench 197/201 caught, 1 Medium+ false alarm / 6954 clean cells. Gates pass.

## The three approaches

### A. Declarative schema validation (Great Expectations / pandera style)
Author writes expectations per column (`between`, `in_set`, `not_null`, `dtype`, `unique`).
- **Pros:** fast, deterministic, zero false positives *for the rules written*, explainable.
- **Cons:** recall is only as wide as the rules someone remembered to write. A spreadsheet arrives with no
  schema and unknown headers (finance one day, clinical vitals the next). It catches nothing it wasn't told
  to expect — exactly the "2 of hundreds" failure mode. Useless as a drop-in "scan any sheet" button.

### B. Pure statistical / ML outlier model (ECOD, Isolation Forest, autoencoder)
Fit an unsupervised model to the sheet, flag the low-probability cells/rows.
- **Pros:** needs no schema; finds odd combinations a human rule-writer never listed (`detectors.isolation_detector`).
- **Cons:** no notion of *why*, so no fix and no plain-English reason. Calibration is the killer: this repo
  already measured an autoencoder adding **26 Medium false alarms** under a "<=1% of clean rows" budget
  (CLAUDE.md, "A false-alarm budget lets false alarms in"). A model alone cannot tell "50 story points" (maybe
  real) from "128 -> 1280 systolic" (certainly a typo); it only knows "rare".

### C. Hybrid: deterministic hygiene rules + a voted statistical layer, with confidence calibration — **SHIPPED**
`engine/pipeline.py` runs ~15 named hygiene checks (duplicates, blanks, type errors, far dates, sum/pair
arithmetic, spellings, >100% fractions, shifted cells, all-9s codes, lone decimals, limits) plus the statistical
detectors (`detectors.py`: limits / sequence / isolation, PyOD ECOD). `pipeline.score` **votes**: hygiene or a
weird-limit hit = Medium; 2 votes = Medium; 3 = High; 1 = Low; a single soft signal = Noted.
- **Pros:** schema-free *and* explainable. Every flag carries a plain sentence naming the column and value, and
  often an exact fix from the row's own arithmetic (`pipeline.pairs`). The vote is what holds false positives at
  ~0: a lone weak signal lands at "Noted" (visible, low-confidence) instead of crying wolf at "Medium".
- **Cons:** a real error that produces only one weak signal and lands in a plausible range stays at "Noted"
  rather than "Medium" (see the 4 misses below). That is the deliberate price of ~0 false positives.

## Verdict: C

A and B each fail the product in opposite directions — A has no recall on unseen sheets, B has no precision
or explanation. C is the only one that can be a one-button "scan any sheet" tool and still be trusted enough
to auto-suggest fixes. The vote + "Noted/Low/Medium/High" ladder *is* the algorithm's edge; it is not a
rough draft of a binary classifier. This matches the repo's standing rule: accuracy is measured with
`score.py` gates, and any threshold change must keep `test_blindspots.py` (279/279) and both benches green.

## The 4 blind `decimal_x10` misses — why they stay "Noted"

| Sheet | Column | Typed (x10) | True | Surfaced as |
|---|---|---|---|---|
| ad_campaigns_s21 | CPC | 18.8 | 1.88 | None |
| ad_campaigns_s22 | CPC | 13.4 | 1.34 | Noted |
| product_backlog_s22 | Story Points | 50 | 5 | Noted |
| product_backlog_s23 | Story Points | 50 | 5 | Noted |

Three of four are already shown to the user as "Noted — check this". The same CPC-x10 pattern is caught at
Medium in other seeds and missed here: the signal is distribution-dependent, not a code gap. CPC 18.8 and a
50-point story are both values a real sheet could legitimately hold, and they sit inside the column's plausible
range, so no limit, pair, or arithmetic check fires with confidence.

To promote these to "Medium" we would have to flag *any* value that is ~10x a dense cluster but still within
range — which, across 6954 clean cells, re-introduces the false alarms the "autoencoder 26 FA" and "2-of-500"
lessons already charged us for. The precision/recall frontier is here. Leaving them at "Noted" (seen, low
confidence) is the correct calibration, not a defect. Revisit only with a *new* held-out real-sheet set and a
change that keeps both bench gates at 0 new Medium+ false alarms — per `docs/SYSTEMS-MAP.md`.
