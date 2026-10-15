# excel-anomaly-hunter
Excel add-in that flags abnormal rows and tells useful-weird from broken-weird. Never deletes data.

**Install (Windows, desktop Excel, nothing else needed):** download **AnomalyHunter.exe** (one file, Python and
everything inside; built by the "Build AnomalyHunter.exe" action) and double-click it. Click **Yes** once when Windows
asks to trust the local certificate (it covers only 127.0.0.1).
Then once in Excel: **Home > Add-ins > More Add-ins > SHARED FOLDER > Anomaly Hunter > Add**. Done: the
**Anomaly Hunter** button is on the Home tab in every workbook (survives restarts), scanned workbooks reopen with
the panel open, and the engine starts hidden at each logon. Double-click it again to repair;
`AnomalyHunter.exe uninstall` removes it. (From a checkout with Python 3.14: `install.bat` does the same, `/u` uninstalls.)
Build the file: `pip install -e . pyinstaller==6.22.3 pillow` then `python -m PyInstaller packaging/AnomalyHunter.spec`
on Windows -> `dist/AnomalyHunter.exe`.
Windows-only per-user install (trusted shared-folder catalog), not a store add-in.

**Works on any analyst's sheet** (finance, banking, quant, supply chain, healthcare, construction, HR, marketing, real
estate, insurance, manufacturing, education, energy, logistics...): it skips title rows, totals rows and ID columns
(SKU, MRN, account no.), and names the mistakes every field makes - extra/missing zeros, % typed as 85 for 0.85, flipped
signs, "Sales" vs "sales ", #N/A / #DIV/0! cells, blanks, duplicates - plus anything statistically out of line.
Also: totals that don't add up (Total != Fare + Tip + Tax), dates far outside the rest (2084 in a 2018 sheet), one label
written several ways ("Employed" / "employed" / "EMP", "retired" among capitalised labels), ratios above 100%.

**Fairness:** columns naming a demographic (Age, Gender, Race, Marital status...) or a location that can stand in for one
(City, State, Zip...) are checked for typos and blanks like any column, but never used to decide which rows are unusual. Every
scan tests their groups for gaps in how often rows are flagged, in blanks, and in any yes/no outcome column (four-fifths
rule + a significance test, so noise is not called bias). One line in the pane, a Fairness sheet in report.xlsx.
Advisory only: it never changes a cell.
Tested on 100k real NYC taxi trips (1.7M cells): 8 s per scan, under 1% false alarms on clean rows.

**Power BI:** after a scan, double-click `powerbi\anomaly-hunter.pbids` (written by `install.bat`), Refresh after each scan.

**Use it:** click **Find problems in this sheet**. A progress line shows each step; rows to check are highlighted
(orange = probably wrong, pale yellow = worth a quick check) and listed worst first. Click a row (in the list or the
sheet) for a suggestion card, free and instant (e.g. 900 -> 90, "looks like a typo"; a median is labelled a best
guess). You see old -> new and choose: **Accept** writes it, then the checker scans the table again and the row's
highlight goes once it looks right (**Undo** puts it back); **Dismiss** leaves the row as it is and opens the next one.
A row that is only unusual gets a fix only when one typing slip (digits swapped, extra digit, decimal point, sign)
explains it and makes the row normal again; otherwise the card says so and asks "Looks right?". Nothing is written into
a row that changed since the scan. **Remove highlights** puts the sheet's colors back as they were.

**How hard to look (0-10 slider):** 0 = basics only (misspellings, totals that don't add up, duplicates, blanks,
obvious typos); 5 = recommended; 10 = anything slightly unusual (more rows to check, some of them fine). Letting go
re-checks the sheet; the level is saved in the workbook. Exact per-column limits are under "advanced".

**Auto-fix (optional, off by default):** fixes only capitals/spaces slips ("east " where the column says "East", one
spelling clearly the usual one) by itself after each check - never numbers, never guesses. **Undo auto-fixes** puts
them back (kept in the workbook).

**AI help (optional, free):** under "AI help" in the pane, paste a free Google Gemini key from
https://aistudio.google.com/apikey (Google account, no credit card). Then **Ask AI** writes a different fix from a
plain-English request. Only the row asked about and a few rows around it go to Google (its free tier may use them to
improve its products - don't use it on private data). A Claude key (`ANTHROPIC_API_KEY`) also works.
Got an invite kit (a zip from the author)? Its `install.bat` switches AI help on by itself - no key, nothing to paste.
Making kits: `node relay/new-invite.mjs "Name"` (see `relay/wrangler.toml` for the shared relay and its daily caps).
No-Excel mode: `anomaly-hunter scan data.csv`.

**Layout:**
- `frontend/` the Excel pane, plain JS modules, no build: `pages/` (home, results, fix, limits, settings), `features/` (scan, highlight, fix, ai), `components/`, `hooks/` (shared state, one-action-at-a-time), `services/` (back end + Excel calls), `utils/`, `constants/`, `styles/`. Entry: `app.js`.
- `backend/anomaly_hunter/` the local server (127.0.0.1:5055): `server.py` (routes), `engine/` (detection), `ai/client.py` (Gemini / Claude); `backend/tests/`, `backend/bench/`.
- `e2e/` browser tests · `powerbi/` Power BI source · `docs/` design notes.

**Test:** `pip install -e .[dev]` then `python tools/check.py` - every gate in layers, fastest first: security lint, pane
self-check, relay abuse tests, engine tests + fuzzing, both accuracy benchmarks, dependency audit (`--e2e` adds the browser
test). Industry benchmark alone (15 fields + held-out traps, real pane + engine, pass/fail gates): `python backend/bench/score.py .`;
`--blind` scores 14 more domains written without reading the detector. Browser test (real panel + engine, fake Excel; needs
node + playwright; stop the installed engine first, it uses port 5055): `e2e/all.sh`. Code map, layers and patterns for the
next change: `CLAUDE.md`. Security and launch items with evidence: `docs/security-and-launch-checklist.md`.
