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
Also: totals that don't add up (Total != Fare + Tip + Tax), dates far outside the rest (2084 in a 2018 sheet).
Tested on 100k real NYC taxi trips (1.7M cells): 8 s per scan, under 1% false alarms on clean rows.

**Power BI:** after a scan, double-click `powerbi\anomaly-hunter.pbids` (written by `install.bat`), Refresh after each scan.

**Use it:** click **Find problems in this sheet**. A progress line shows each step; rows to check are highlighted
(orange = probably wrong, pale yellow = worth a quick check) and listed worst first. Click a row (in the list or the
sheet) for a **suggested fix**, free and instant (e.g. a number past its limits -> the median of the rest of its
column). You see old -> new, nothing changes until **Apply fix**, and **Undo** puts it back. **Remove highlights**
puts the sheet's colors back as they were. "How strict should it be?" lets you change each column's limits.

**AI help (optional, free):** under "AI help" in the pane, paste a free Google Gemini key from
https://aistudio.google.com/apikey (Google account, no credit card). Then **Ask AI** writes a different fix from a
plain-English request. Only the row asked about and a few rows around it go to Google (its free tier may use them to
improve its products - don't use it on private data). A Claude key (`ANTHROPIC_API_KEY`) also works.
No-Excel mode: `anomaly-hunter scan data.csv`.

**Layout:** `anomaly_hunter/` engine + local server (127.0.0.1:5055) · `panel/` task pane, plain JS, no build, one path (Find problems -> highlight -> fix one row); one sheet action at a time, buttons disabled meanwhile · `powerbi/` Power BI Desktop source · `docs/` design notes.

**Test:** `pip install -e .[dev]` then `pytest` and `node panel/selfcheck.js`. Industry benchmark (15 fields + held-out
traps, real panel + engine, pass/fail gates): `python bench/score.py .` Browser test (real panel + engine, fake Excel;
needs node + playwright; stop the installed engine first, it uses port 5055): `e2e/all.sh`
