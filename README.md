# excel-anomaly-hunter
Excel add-in that flags abnormal rows and tells useful-weird from broken-weird. Never deletes data.

**Install (Windows, desktop Excel, Python 3.14):** download, close Excel, double-click `install.bat`.
Click **Yes** once when Windows asks to trust the local certificate (it covers only 127.0.0.1). Done: the
**Anomaly Hunter** button sits on Excel's Home tab in every workbook, and the engine starts hidden at each logon.
Re-run to repair. `install.bat /u` uninstalls. This is a per-user developer install (sideload), not a store add-in.

AI triage: set `ANTHROPIC_API_KEY` before installing. No-Excel mode: `anomaly-hunter scan data.csv`.

**Layout:** `anomaly_hunter/` engine + local server (127.0.0.1:5055) · `panel/` task pane, plain JS, no build · `powerbi/` Power BI Desktop source · `docs/` design notes.

**Test:** `pip install -e .[dev]` then `pytest` and `node panel/selfcheck.js`.
