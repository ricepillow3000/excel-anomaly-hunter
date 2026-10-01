# Anomaly Hunter: brainstorm notes

Working notes from the design phase. This is not the spec. The approved spec will live in `docs/superpowers/specs/`.

## The idea

A bouncer sees a hundred normal people, then one person in a hazmat suit. Anomaly Hunter learns what "normal" looks like in an Excel sheet and flags what breaks it.

The hard part is not finding the anomaly. It is deciding whether the anomaly is **useful-weird** (a real signal) or **broken-weird** (a typo, an import error, a duplicate). Abnormal data is not automatically useless.

## Decisions so far (2026-10-01)

1. **Form factor:** an Excel add-in with a side panel (Office.js).
2. **Brain:** hybrid. Detection runs locally. Claude triages only the flagged rows: useful-weird vs broken-weird, a one-sentence reason, a suggested action. It reads and proposes and never edits cells on its own. AI can be switched off.
3. **Limits:** the analyst sets hard numbers per column. Each column has a baseline range (outside it = noted) and a weird range (outside it = flagged).

## Ideas added 2026-10-01 (second round)

- **Detection methods:**
  - First, second and third derivatives (rate of change, acceleration, jerk) on ordered data.
  - Score clustering.
  - Trend analysis.
  - Rule-based models (the per-column limits above).
  - Unsupervised detection with scikit-learn and PyOD.
- **Data tooling:** pandas for manipulation and concatenating sources; CSV files as an easy input; openpyxl for anomaly formatting.
- **Power BI:** wanted as part of the reporting and detection story. How it integrates with Excel is still open.
- **Goal:** reduce friction and stop the user's workflow from collapsing.
- **UI:** see `dashboard-sketch-v1.png`.
  - The left nav has Dashboard, Route Monitor and an Active Anomalies table with four columns: Anomalies, Behavioral, Duplicates, Irregularities.
  - Dashboard: main feeds, sheet analytics, settings.
  - Error / Trigger Dashboard: three cards (Data / SLA at Risk, Data / Severity Breakdown, Timing Patterns) and four trigger boxes.
  - Clicking a trigger makes the AI agent pick the best action. A right-side tab explains the action and has an approve button.
  - Route Monitor: a visual map of how data is sorted, rearranged, cleaned or deleted, with the AI agents visible as data comes in.

## Open conflicts to resolve

- The sketch says an action is approved automatically if the user does nothing. Decision 2 says agents never act on their own.
- pandas, scikit-learn, PyOD and openpyxl are Python. An Office.js panel runs JavaScript. A Python engine has to run somewhere.
- openpyxl edits saved files, not the workbook that is open in Excel.
- Power BI shows data; the Python engine is what detects. How the two connect is undecided.
- Derivatives only make sense for ordered data, such as a time or sequence column.
