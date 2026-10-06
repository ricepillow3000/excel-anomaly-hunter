# excel-anomaly-hunter
Excel add-in that flags abnormal rows and tells useful-weird from broken-weird. Never deletes data.

**Run (Windows, Python 3.10+, Node for `npx`):**
```
python -m venv .venv
.venv\Scripts\python -m pip install -e .
start-anomaly-hunter.bat
```
Excel opens with the panel loaded. First run installs local HTTPS certs (accept the prompt once).
AI triage: set `ANTHROPIC_API_KEY` before starting. No-Excel mode: `anomaly-hunter scan data.csv`.

**Layout:** `anomaly_hunter/` engine + local server (127.0.0.1:5055) · `panel/` task pane, plain JS, no build · `powerbi/` Power BI Desktop source · `docs/` design notes.

**Test:** `pip install -e .[dev]` then `pytest` and `node panel/selfcheck.js`.
