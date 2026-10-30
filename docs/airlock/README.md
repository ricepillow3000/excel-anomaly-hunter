# The airlock: get a sheet into Excel exactly as it was typed

Chaos audit, 2026-10-30 (AH-74..AH-78). A 55-row test sheet (`chaos_dataset.csv`, synthetic, answer key in its last
three columns) showed three ways a sheet is damaged before any check runs. This folder is the way in that keeps every
cell as typed, and the formulas that flag (never fix) what the engine also flags.

| File | What it is | How it was checked |
|---|---|---|
| `Airlock.pq` | Power Query M: imports a CSV as raw text, profiles each column at run time, writes an Audit column | Parsed by `@microsoft/powerquery-parser` 2.0.0. Not run in Excel: no Excel in the build container. A line-by-line Python copy of its rules gives the Audit column below |
| Formulas below | Plain Excel formulas for the same three checks | Recalculated by LibreOffice 24.2 on the chaos sheet: every row below is its real output |
| `chaos_dataset.csv` | The 55-row test sheet with its answer key | `backend/tests/test_chaos_dataset.py` scores the engine on it at strengths 5 and 10 |

## Why Excel falls into the three traps

1. **Leading zeros.** Opening a `.csv` (double-click, or File > Open) types every cell before you see it. `02134` looks
   like a number, so Excel stores 2134 and the zero is gone. A formula like `=LEN(A2)` then measures the damaged value.
   The add-in's own loader did the same (`pd.to_numeric`), so an ID that lost its zeros looked like every other ID.
2. **Dates.** Excel reads `03/04/2024` in the PC's regional order: 3 April in London, 4 March in New York. A date
   that cannot fit that order (`31/12/2023` on a US PC) stays text, so one column can end up holding dates read two
   ways. The add-in's loader chose day-first for a whole column because one cell had a day over 12, and kept no record
   of how each date was written.
3. **The CFO bonus.** A check that looks at one column at a time sees 400,000 far above the other bonuses and guesses
   a typo (/100). The row itself says otherwise: 1,150,000 + 400,000 = 1,550,000, exactly its TotalComp. Changing any
   one of those cells would break the row's own arithmetic, so a fix there cannot be right.

## Step by step: import as raw text

1. Turn off Excel's own conversion (Microsoft 365): File > Options > Data > **Automatic Data Conversion**. Untick
   "Remove leading zeros and convert to a number", "Convert continuous letters and numbers to a date" and "Convert
   digits surrounding the letter E", and tick "notify me of any automatic data conversions".
2. Turn off Power Query's type guessing: Data > Get Data > Query Options > Global > Data Load > Type Detection >
   **Never detect column types and headers for unstructured sources**.
3. Data > Get Data > From Other Sources > **Blank Query** > Advanced Editor. Paste `Airlock.pq` and set `Path` to your
   file. Do not use From Text/CSV for this: its wizard adds a "Changed Type" step that converts the cells again.
4. Close & Load. The sheet you get has every source column as text, exactly as in the file, plus `Airlock Audit` (one
   sentence per problem) and `Airlock Level` (`Error`, `Check` = worth a look, or empty). Nothing in the source columns
   is ever changed. Refresh re-reads the file and judges it again.
5. Scan that sheet with the add-in. It reads text cells as typed, so its own checks see `02134` and `31/12/2023`.

Paste sheets in as text too: format the target columns as Text (`@`) **before** pasting. A cell formatted afterwards
keeps the number Excel already made.

## How the airlock adapts to any sheet

Nothing in `Airlock.pq` names a column or an industry. It loops over whatever headers the file has
(`Table.ColumnNames`) and measures each column's own filled cells:

| It measures | So a column is | And a cell is flagged when |
|---|---|---|
| share of digit-only cells, any with a leading zero | a **code** (zeros are part of the value) | its length is under the width 90% of the column share: lost leading zeros? |
| share of cells that read as numbers | **numeric** (90%+) | it is text in that column |
| share of `YYYY-MM-DD` cells, slash dates and which part is over 12 | a **date** column and its order | it is written another way, could be read either way, or is in the minority order |
| median and MAD (median distance from the median) | its own scale | it is more than K = 6 robust spreads from the median |
| C = A + B or C = A x B on 90% of rows (no blank or 0 term), among the first 15 number columns | linked by **row arithmetic** | it breaks the rule. An outlier the rule confirms is only "worth a check" |
| share of filled cells | **filled** (95%+) | it is blank |
| the commonest spelling per lower-case form | a **label** column | the same word is typed with other capitals or spaces |
| whole rows | | it is an exact copy of an earlier row (unless half the sheet repeats) |

Swap an 8-column ledger for a 40-column sensor log and every one of those numbers is measured again from the new
columns; the four settings at the top (K, Share, MaxRuleColumns, RuleRows) are the same for every column.
`backend/tests/test_schema_agnostic.py` checks the same promise in the engine itself, on generated 8- and 40-column
sheets with meaningless headers.

What the Audit column says on `chaos_dataset.csv` (answer key removed; the Python copy of the rules):

```
row 2:  [Error] Department "finance" is written "Finance" 11 times (same word, different capitals or spaces)
row 7:  [Check] Worth a check: AnnualSalary "1150000" is far from the column's usual 76850, but the row's own
        arithmetic (TotalComp = AnnualSalary + Bonus) confirms it; (and the same for Bonus and TotalComp)
row 8:  [Error] HireDate "31/12/2023" is not written YYYY-MM-DD like the rest of the column
row 12: [Error] Blank in Department, a column that is otherwise filled
row 14: [Error] HireDate "45292" is a number in a column of YYYY-MM-DD dates (an Excel date serial?)
row 20: [Error] PostalCode "2134" is 4 characters where the column writes 5: lost its leading zeros?
row 21: [Error] Duplicate of row 4 (an exact copy)
row 23: [Error] Text "seventy thousand" in number column AnnualSalary
row 44: [Error] Excel error #REF! in TotalComp
row 50: [Error] TotalComp 96920 does not match TotalComp = AnnualSalary + Bonus (87920)
row 54: [Error] EmployeeID "123" is 3 characters where the column writes 6: lost its leading zeros?
```

All 10 planted mistakes are an Error, the CFO's real pay is only a Check, and the other 4 honest edge cases (two
non-Western names with hyphens and accents, a mononym, a non-binary part-timer of 71) and all 40 clean rows say nothing.

## The same checks as Excel formulas

For a sheet loaded as text (A = ID, F = ZIP, H = HireDate, J/K/L = AnnualSalary/Bonus/TotalComp, data in rows 2-56).
Change the letters and the last row for your sheet. The helper cells measure the column; nothing is typed in by hand.
In Excel 2019 and older, enter the four helpers with Ctrl+Shift+Enter; TEXTJOIN needs Excel 2019 or later.

| Helper | Formula |
|---|---|
| N2, the ID width | `=MODE(IF($A$2:$A$56<>"",LEN($A$2:$A$56)))` |
| O2, the ZIP width | `=MODE(IF($F$2:$F$56<>"",LEN($F$2:$F$56)))` |
| P2, the salary median | `=MEDIAN(IF(ISNUMBER(--$J$2:$J$56),--$J$2:$J$56))` |
| Q2, the salary MAD | `=MEDIAN(IF(ISNUMBER(--$J$2:$J$56),ABS(--$J$2:$J$56-$P$2)))` |

Lost leading zeros (one per code column; a cell Excel already made a number says so):

```
=IF(A2="","",IF(ISNUMBER(A2),"ID stored as a number (its zeros may be gone)",IF(LEN(A2)<$N$2,"ID "&A2&" is "&LEN(A2)&" of "&$N$2&" characters: lost leading zeros?","")))
```

Date mask. It never uses `--H2` or `DATEVALUE` on the text: those make Excel read `03/04/2024` in the PC's order, the
very guess this check exists to catch. It checks the calendar with YEAR/MONTH/DAY, not TEXT(), because TEXT's format
codes change with Excel's language.

```
=IF(H2="","",IF(ISNUMBER(H2),"HireDate is a number (an Excel serial?), not text YYYY-MM-DD",
 IF(AND(LEN(H2)=10,MID(H2,5,1)="-",MID(H2,8,1)="-"),
  IF(IFERROR(AND(YEAR(DATE(LEFT(H2,4),MID(H2,6,2),RIGHT(H2,2)))=--LEFT(H2,4),
   MONTH(DATE(LEFT(H2,4),MID(H2,6,2),RIGHT(H2,2)))=--MID(H2,6,2),
   DAY(DATE(LEFT(H2,4),MID(H2,6,2),RIGHT(H2,2)))=--RIGHT(H2,2)),FALSE),"","HireDate "&H2&" is not a real calendar date"),
 IF(AND(ISNUMBER(--H2),ISERROR(FIND("/",H2)),ISERROR(FIND("-",H2)),ISERROR(FIND(":",H2))),
  "HireDate "&H2&" is a number (an Excel serial?), not YYYY-MM-DD",
 IF(IFERROR(AND(--LEFT(H2,FIND("/",H2)-1)<=12,--MID(H2,FIND("/",H2)+1,FIND("/",H2,FIND("/",H2)+1)-FIND("/",H2)-1)<=12),FALSE),
  "HireDate "&H2&" is not YYYY-MM-DD, and day and month could swap","HireDate "&H2&" is not YYYY-MM-DD")))))
```

Cross-column check: the row's arithmetic first, then the outlier, which the arithmetic can confirm:

```
=IFERROR(IF(ABS(--J2+--K2-L2)>0.005,"TotalComp "&L2&" does not equal AnnualSalary + Bonus ("&(--J2+--K2)&")",
 IF(ABS(--J2-$P$2)/(1.4826*$Q$2)>6,"Worth a check: AnnualSalary "&J2&" is far from the usual "&$P$2&", but AnnualSalary + Bonus = TotalComp confirms it","")),
 "a term of TotalComp = AnnualSalary + Bonus is not a number")
```

Audit column: `=TEXTJOIN("; ",TRUE,S2:V2)` over the check columns. What LibreOffice computed on the chaos sheet:

```
row 7:  Worth a check: AnnualSalary 1150000 is far from the usual 76850, but AnnualSalary + Bonus = TotalComp confirms it
row 8:  HireDate 31/12/2023 is not YYYY-MM-DD
row 14: HireDate 45292 is a number (an Excel serial?), not YYYY-MM-DD
row 20: ZIP 2134 is 4 of 5 characters: lost leading zeros?
row 23: a term of TotalComp = AnnualSalary + Bonus is not a number
row 44: a term of TotalComp = AnnualSalary + Bonus is not a number
row 50: TotalComp 96920 does not equal AnnualSalary + Bonus (87920)
row 54: ID 123 is 3 of 6 characters: lost leading zeros?
```

and on two more test dates: `03/04/2024` "is not YYYY-MM-DD, and day and month could swap", `2023-02-30` "is not a
real calendar date". To restore a code only after a person has checked it, write it to a new column, never over the
source: `=TEXT(A2,REPT("0",$N$2))`.

## The score: harm-weighted F2

    HA-F2 = 5 TP / (5 TP + 4 FN + FP + 10 (H + A))

- TP = planted mistakes flagged Medium or worse on their own cell; FN = planted mistakes missed; FP = honest rows
  flagged Medium or worse ("worth a check" is not a false alarm).
- H = harmful fixes: a fix card whose value is not the true value. A = silent alterations: a cell the engine read as
  something other than what was typed (a lost zero, a date read in a guessed order) with no flag on that cell.
- It is F-beta with beta = 2 (a miss costs as much as 4 false alarms) with H and A added to the denominator at 10
  false alarms each. Any H or A also fails the test on its own: a score is no excuse for one harmful fix.

On the chaos sheet before the fixes: TP 7, FN 3, FP 2, H 1, A 75 (53 IDs, 21 ZIPs, 1 date) = **0.043**.
`test_chaos_dataset.py` requires H = 0, A = 0, FN = 0 at strengths 5 and 10. The one row still left to a decision is
the part-timer (AH-81, John decides), kept as a strict expected failure so the test flips the day it changes.

A test can prove these sheets, not every sheet. The claim is what was measured: the chaos sheet, the generated 8- and
40-column sheets, the two bench gates and the blind real-sheet rounds, each run again on every change.
