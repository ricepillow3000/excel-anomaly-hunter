# Arcas
Excel add-in that flags abnormal rows and tells unusual-but-fine rows from broken ones. It never deletes data.
Your sheet is checked on your own PC. Nothing leaves it unless you turn on AI help: see [What leaves your PC](PRIVACY.md).
Website: [ricepillow3000.github.io/excel-anomaly-hunter](https://ricepillow3000.github.io/excel-anomaly-hunter/) (`site/`, published by `.github/workflows/pages.yml`).
Free and open source under the [MIT License](LICENSE).
Questions or problems: [open an issue](https://github.com/ricepillow3000/excel-anomaly-hunter/issues).

## Install (Windows + desktop Excel, nothing else needed)
1. **[Download Arcas.exe](https://github.com/ricepillow3000/excel-anomaly-hunter/releases/latest/download/Arcas.exe)**
   (one file, about 81 MB, everything inside). If your browser says it "isn't commonly downloaded": click **...** > **Keep** > **Keep anyway**.
2. **Double-click it.** A blue "Windows protected your PC" box appears: click **More info**, then **Run anyway**. (The file
   isn't code-signed yet, so Windows doesn't know it: [Code signing policy](https://ricepillow3000.github.io/excel-anomaly-hunter/#code-signing). Some PCs ask "Open File - Security Warning" instead: click **Run**.)
3. Click **Yes** when Windows asks to trust the certificate (it covers only 127.0.0.1, this PC).
4. Excel opens a **Start here** workbook. Follow its 5 clicks, once: **Home > Add-ins > More Add-ins > SHARED FOLDER >
   Arcas > Add**. Then try **Find problems** on its Practice sheet: it finds the 5 problems hidden there.

The **Arcas** button is now on the Home tab in every workbook (survives restarts), scanned workbooks reopen
with the panel open, and the engine starts hidden at each logon. Double-click it again to repair;
`Arcas.exe uninstall` removes it. (From a checkout with Python 3.14: `install.bat` does the same, `/u` uninstalls.)
Every build on `main` is installed and used on a fresh Windows PC with no Python before it becomes that download link.
Build the file: `pip install -e ".[exe]" -c constraints.txt` then `python -m PyInstaller packaging/AnomalyHunter.spec`
on Windows -> `dist/Arcas.exe`.
Windows-only per-user install (trusted shared-folder catalog), not a store add-in.
Why one file and not Docker or Kubernetes, and the free ways to make sharing smoother: [docs/SHARING.md](docs/SHARING.md).

## What it checks
It is built for analysts' sheets, whatever the field (finance, healthcare, supply chain, HR and others). It skips title
rows, totals rows and ID columns (SKU, MRN, account no.), and names the mistakes every field makes: extra/missing zeros,
% typed as 85 for 0.85, flipped signs, "Sales" vs "sales ", #N/A / #DIV/0! cells, blanks and duplicates, plus anything
statistically out of line.
It also finds totals that don't add up (Total != Fare + Tip + Tax), dates far outside the rest (2084 in a 2018 sheet), one label
written several ways ("Employed" / "employed" / "EMP", "retired" among capitalised labels), ratios above 100%.

## Fairness
Columns naming a demographic (Age, Gender, Race, Marital status...) or a location that can stand in for one
(City, State, Zip...) are checked for typos and blanks like any column, but never used to decide which rows are unusual. Every
scan tests their groups for gaps in how often rows are flagged, in blanks, and in any yes/no outcome column (four-fifths
rule + a significance test, so noise is not called bias). One line in the pane, a Fairness sheet in report.xlsx.
Advisory only: it never changes a cell.
One-off measurements, each on the engine of its day, with data that is not in this repo: on 2026-10-07, 100k real
NYC 2018 taxi trips (1.7M cells) took 8 s a scan with 0.53% false alarms on clean rows; on 2026-10-14, the UCI Adult
census (48,842 people) had every '?' left for an unknown job, every 99999 code and every duplicate found (3,896 rows),
no real person called probably wrong (7 worth a check), and its well-known gaps (30% of men vs 11% of women earn over
$50K) reported as gaps. They are not re-run; the benches in `backend/bench` are (`score.py`).

## Power BI
In the pane, turn on **Power BI (optional) > Save each scan for Power BI** (off by default), scan, then double-click `anomaly-hunter.pbids` (the whole sheet) or `anomaly-hunter-flags.pbids` (the flagged rows and the ones you fixed or dismissed; its columns never change); Refresh after each scan. Both sit in `%LOCALAPPDATA%\AnomalyHunter` (Arcas.exe) or `powerbi\` (`install.bat`). Schema and the steps to check it in Power BI Desktop: [`powerbi/README.md`](powerbi/README.md).

## Use it
Click **Find problems in this sheet**. A progress line shows each step; the cells to check are highlighted
(orange = probably wrong, pale yellow = worth a quick check) and listed worst first. Click a row (in the list or the
sheet) for a suggestion card. It needs no AI and no internet (e.g. 900 -> 90, "looks like a typo"; a misspelling's fix,
or a typo the numbers cannot prove, is labelled a best guess). You see old -> new and choose: **Accept** writes it, then the checker scans the table again and the row's
highlight goes once it looks right (**Undo** puts it back); **Dismiss** leaves the row as it is and opens the next one.
A row that is only unusual gets a fix only when one typing slip (digits swapped, extra digit, decimal point, sign)
explains it and makes the row normal again; otherwise the card says so and asks "Looks right?". Nothing is written into
a row that changed since the scan. **Remove highlights** puts the sheet's colors back as they were.

## How hard to look (0-10 slider)
0 = basics only (misspellings, totals that don't add up, duplicates, blanks,
obvious typos); 5 = recommended; 10 = anything slightly unusual (more rows to check, some of them fine). Letting go
re-checks the sheet; the level is saved in the workbook. Exact per-column limits are under "advanced".

## Auto-fix (optional, off by default)
It fixes only capitals/spaces slips ("east " where the column says "East", one spelling clearly the usual one) by
itself after each check. It never changes numbers and never guesses. **Undo auto-fixes** puts
them back (kept in the workbook).

## AI help (optional, free)
Under "AI help" in the pane, paste a free Google Gemini key from
https://aistudio.google.com/apikey (Google account, no credit card). Then **Ask AI** writes a different fix from a
plain-English request. Only the row asked about and a few rows around it go to Google (its free tier may use them to
improve its products, so don't use it on private data). A Claude key (`ANTHROPIC_API_KEY`) also works.
An invite kit (a zip from the author) needs no key: its `install.bat` switches AI help on by itself.
Making kits: `node relay/new-invite.mjs "Name"` (see `relay/wrangler.toml` for the shared relay and its daily caps).
No-Excel mode: `arcas scan data.csv` (the older `anomaly-hunter scan` still works).

## Layout
- `frontend/` the Excel pane, plain JS modules, no build: `pages/` (home, results, fix, limits, settings), `features/` (scan, highlight, fix, ai), `components/`, `hooks/` (shared state, one-action-at-a-time), `services/` (back end + Excel calls), `utils/`, `constants/`, `styles/`. Entry: `app.js`.
- `backend/anomaly_hunter/` the local server (127.0.0.1:5055): `server.py` (routes), `engine/` (detection), `ai/client.py` (Gemini / Claude); `backend/tests/`, `backend/bench/`.
- `e2e/` browser tests · `powerbi/` Power BI source · `docs/` design notes.

## Test
`pip install -e ".[dev]" -c constraints.txt` then `python tools/check.py` runs every gate in layers, fastest first: security lint, pane
self-check, relay abuse tests, engine tests + fuzzing, both accuracy benchmarks, dependency audit (`--e2e` adds the browser
test). Industry benchmark alone (15 fields + held-out traps, real pane + engine, pass/fail gates): `python backend/bench/score.py .`;
`--blind` scores 14 more domains written without reading the detector. Browser test (real panel + engine, fake Excel; needs
node + playwright; stop the installed engine first, it uses port 5055): `e2e/all.sh`. Code map, layers and patterns for the
next change: `CLAUDE.md`. Security and launch items with evidence: `docs/security-and-launch-checklist.md`.
