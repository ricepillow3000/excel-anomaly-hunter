# excel-anomaly-hunter
Excel add-in that flags abnormal rows and tells useful-weird from broken-weird. Never deletes data.

**Install (Windows, desktop Excel, Python 3.14):** download, close Excel, double-click `install.bat`.
Click **Yes** once when Windows asks to trust the local certificate (it covers only 127.0.0.1).
Then once in Excel: **Home > Add-ins > More Add-ins > SHARED FOLDER > Anomaly Hunter > Add**. Done: the
**Anomaly Hunter** button is on the Home tab in every workbook (survives restarts), scanned workbooks reopen with
the panel open, and the engine starts hidden at each logon. Re-run to repair; `install.bat /u` uninstalls.
Windows-only per-user install (trusted shared-folder catalog), not a store add-in.

**Works on any analyst's sheet** (finance, banking, quant, supply chain, healthcare, construction, HR, marketing, real
estate, insurance, manufacturing, education, energy, logistics...): it skips title rows, totals rows and ID columns
(SKU, MRN, account no.), and names the mistakes every field makes - extra/missing zeros, % typed as 85 for 0.85, flipped
signs, "Sales" vs "sales ", #N/A / #DIV/0! cells, blanks, duplicates - plus anything statistically out of line.

**Fix a flagged row:** after a scan, click a highlighted row (in the sheet or in the pane's list). A **recommended
fix** shows up at once (no AI needed): e.g. a number past its limits -> the median of the rest of its column. Want
something else? Type it in plain English ("replace the -5 with the average Units for East") and **Ask AI** writes the
Excel formula. Either way you see old -> new, nothing changes until you click **Apply**, and **Undo** puts it back.

AI triage + fixes: set `ANTHROPIC_API_KEY` before installing. No-Excel mode: `anomaly-hunter scan data.csv`.

**Layout:** `anomaly_hunter/` engine + local server (127.0.0.1:5055) · `panel/` task pane, plain JS, no build · `powerbi/` Power BI Desktop source · `docs/` design notes.

**Test:** `pip install -e .[dev]` then `pytest` and `node panel/selfcheck.js`. Industry benchmark (15 fields + held-out
traps, real panel + engine, pass/fail gates): `python bench/score.py .`
