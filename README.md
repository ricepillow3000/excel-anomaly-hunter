# excel-anomaly-hunter
Excel add-in that flags abnormal rows and tells useful-weird from broken-weird. Never deletes data.

**Install (Windows, desktop Excel, Python 3.14):** download, close Excel, double-click `install.bat`.
Click **Yes** once when Windows asks to trust the local certificate (it covers only 127.0.0.1).
Then once in Excel: **Home > Add-ins > More Add-ins > SHARED FOLDER > Anomaly Hunter > Add**. Done: the
**Anomaly Hunter** button is on the Home tab in every workbook (survives restarts), scanned workbooks reopen with
the panel open, and the engine starts hidden at each logon. Re-run to repair; `install.bat /u` uninstalls.
Windows-only per-user install (trusted shared-folder catalog), not a store add-in.

**Fix a flagged row:** after a scan, click a highlighted row (in the sheet or in the pane's list). The pane shows
why it was flagged and asks what you want, in plain English ("replace the -5 with the median of Units"), or leave it
blank for a recommended fix. Claude proposes exact cell formulas, you see old -> new, and nothing changes until you
click **Apply** (one-click **Undo** after).

AI triage + fixes: set `ANTHROPIC_API_KEY` before installing. No-Excel mode: `anomaly-hunter scan data.csv`.

**Layout:** `anomaly_hunter/` engine + local server (127.0.0.1:5055) · `panel/` task pane, plain JS, no build · `powerbi/` Power BI Desktop source · `docs/` design notes.

**Test:** `pip install -e .[dev]` then `pytest` and `node panel/selfcheck.js`.
