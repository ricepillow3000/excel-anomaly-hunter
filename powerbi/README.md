# Power BI

Everything stays on this PC: Power BI Desktop reads two CSV files the engine writes after each scan. Nothing is
uploaded (Power BI's cloud would need a Microsoft tenant and a Pro licence, and would send the sheet to Microsoft).

## Turn it on and open it
1. In the pane: **Power BI (optional) > Save each scan for Power BI** (off by default: no copy of the sheet is kept).
2. Scan. The engine writes, in `%LOCALAPPDATA%\AnomalyHunter`:
   - `latest-scan.csv`: the whole sheet plus each row's result;
   - `latest-flags.csv`: only the flagged rows, with the same 8 columns whatever the sheet.
3. Double-click a shortcut (needs Power BI Desktop): `anomaly-hunter.pbids` opens `latest-scan.csv`,
   `anomaly-hunter-flags.pbids` opens `latest-flags.csv`. Click **Load**.
   - Installed with AnomalyHunter.exe: both shortcuts sit in `%LOCALAPPDATA%\AnomalyHunter`.
   - From a source folder or kit (`install.bat`): both sit in this `powerbi` folder.
4. After each new scan: **Refresh** in Power BI.

Turning the option off deletes both files at the next scan. If a file can't be written (open and locked in another
program, a full disk), both are removed, so Power BI never shows an older sheet as this one, and the pane says so.

Build reports on `latest-flags.csv` when you scan different sheets: its columns never change. A report on
`latest-scan.csv` has that sheet's own columns, so scanning a sheet with other columns breaks its refresh (open the
shortcut again for a new report).

## Schema (written by `backend/anomaly_hunter/powerbi.py`, pinned by `backend/tests/test_powerbi.py`)

`latest-scan.csv`: one record per data row, in the sheet's order.

| Column | Holds |
|---|---|
| Excel Row | the row number in Excel, as the pane says "Row N" |
| *every column of the sheet* | the cell as the pane read it (dates as `2026-01-31` or `2026-01-31 13:45:00`) |
| Severity | `High`, `Medium`, `Low` (flagged), `Noted` (past a usual limit, fine), or empty |
| Bucket | `Irregularities`, `Duplicates`, `Behavioral`, or empty |
| Reason | the engine's reasons, joined with `; ` (what the pane shows, before its plain-words rewording) |
| Suggested Fix | the values the pane's card offers, as `Units: 140 → 14; Region: "east " → "East"`; a guessed spelling ends in `(a guess)`. Empty when the card writes nothing (a blank, an unexplained extreme, 2+ cells off by the same step). The card also never types over a formula; this column doesn't know which cells hold one |
| Magnitude | how far past its limit the value is (0 for most rows) |

A sheet's own column with one of these names keeps its name; ours becomes `Anomaly Hunter Severity` (and so on).

`latest-flags.csv`: one record per flagged row (High, Medium or Low), in the sheet's order:
`Scanned At` (ISO time with its zone, e.g. `2026-10-20T14:03:05+02:00`), `Sheet`, `Excel Row`, then Severity, Bucket,
Reason, Suggested Fix and Magnitude as above.

How every value is written (both files):
- UTF-8 with a byte-order mark (without it Power BI reads Windows-1252 and garbles accents and emoji); records end in CRLF.
- Text is always in double quotes (a `"` inside is doubled). Numbers, `TRUE` and `FALSE` are never quoted. A blank cell
  is an empty field, which Power BI reads as null.
- Numbers are written exactly (shortest form that reads back to the same value), with `E` for an exponent (`1E+300`).
  A whole number too big for any number Power BI holds (over ~1.8E+308) is written as its digits, as text.
- A line break inside a cell is written as `↵`: Power BI's own Text/CSV import ends a record at every line break, even
  inside quotes (`QuoteStyle.None`), so a real break would shift every row below it.
- Text that starts with `=` `+` `-` `@`, a tab, or their full-width forms gets a leading `'`, so opening the file in
  Excel never runs it as a formula (OWASP CSV injection). A NUL or a broken character (a lone surrogate) becomes `?`.

## What is verified here, and what John verifies on Windows
Verified by tests on every commit: a hostile sheet (accents, emoji, quotes, commas, `\n`, `\r\n` and `\r` inside cells,
formula starts, 6,000-character text, blanks, Excel errors, dates, 1E+300, 2^53+1, a 309-digit number) scanned with
Power BI on, then both files parsed back the way Power BI's generated query reads them: every row, every cell, every
Severity, Bucket and Reason equals what the pane got; the Suggested Fix equals the card's own `recommendFix`; the
browser test checks `latest-flags.csv` lists exactly the pane's rows. The `.pbids` files are checked for shape only.

Not verifiable without Power BI Desktop (John, on his PC, about 10 minutes):
1. Install with AnomalyHunter.exe; turn on the Power BI option; scan the Practice sheet in `Start here.xlsx`.
2. Double-click `%LOCALAPPDATA%\AnomalyHunter\anomaly-hunter.pbids`. Check: it opens Power BI with the file
   preselected; the preview shows the header row as headers; `Excel Row` matches the pane's row numbers; accents read
   correctly; Severity is empty (not the text "null") on clean rows.
3. Same with `anomaly-hunter-flags.pbids`: one row per row the pane lists.
4. Scan again after fixing a row; **Refresh**: the fixed row leaves `latest-flags.csv`.
5. Windows set to a comma-decimal region (German, French...): Power BI reads `2.5` by the PC's locale. If numbers come in
   wrong, set **File > Options > Regional settings > Locale for import** to English (United States).

Not shipped: a Power BI template (`.pbit`) with a ready-made report. It is a zip of Power BI's own model and layout
files that only Power BI Desktop can validate, and an unvalidated one could fail to open on every PC. To make one: open
`anomaly-hunter-flags.pbids`, build the report (for example a card per Severity, a bar of Bucket, a table of Excel Row,
Reason and Suggested Fix). The query holds the full path of your PC's CSV, so for other PCs make it a parameter first:
**Transform data > Manage parameters > New** (`CsvPath`, text), then in the query's Source step replace the path with
`CsvPath`. Then **File > Export > Power BI template**, and test it on a second PC: opening it must ask for `CsvPath`
(each PC's `%LOCALAPPDATA%\AnomalyHunter\latest-flags.csv`) and load that PC's last scan.
