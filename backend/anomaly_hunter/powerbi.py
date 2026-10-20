"""The Power BI copy of a scan: two CSV files on this PC that Power BI Desktop opens (anomaly-hunter.pbids,
anomaly-hunter-flags.pbids). Written only when the pane's "Save each scan for Power BI" is on. The schema is documented
in powerbi/README.md and pinned by backend/tests/test_powerbi.py.
  latest-scan.csv   one row per data row: Excel Row, every column of the sheet, then Severity, Bucket, Reason,
                    Suggested Fix, Magnitude (the sheet's own columns change with the sheet)
  latest-flags.csv  one row per flagged row, the same 8 columns whatever the sheet, so a report built on it keeps
                    refreshing when another sheet is scanned"""
import csv
import datetime
import json
import math
import os
import re
from pathlib import Path

import numpy as np

RESULTS = ("Severity", "Bucket", "Reason", "Suggested Fix", "Magnitude")
FLAGS = ("Scanned At", "Sheet", "Excel Row", *RESULTS)
FLAGGED = ("High", "Medium", "Low")  # "Noted" = fine, as in the pane
# OWASP CSV injection: text starting with these runs as a formula when the CSV is opened in Excel
FORMULA_START = tuple("=+-@\t\r\n＝＋－＠")
# Power BI's Text/CSV import puts QuoteStyle.None in the query it makes, which ends a row at every line break, quoted
# or not: one cell holding a line break would shift every row below it. A break is written as this mark instead.
BREAK = "↵"
_BREAKS = re.compile(r"\r\n|\r|\n")
_ADDS = re.compile(r"^(.+) (\S+) does not add up: ((.+?) [×+] (.+)) = \S+$")  # the pane's fix.addUps


class _Raw:
    """A number or TRUE/FALSE: written unquoted so Power BI types it (csv.QUOTE_STRINGS quotes only real text)."""
    __slots__ = ("t",)

    def __init__(self, t):
        self.t = t

    def __str__(self):
        return self.t


def inert(v):
    """A leading apostrophe keeps a formula-looking text cell as text (numbers untouched). Partial protection:
    OWASP notes Excel may drop it after a save and reopen."""
    return "'" + v if isinstance(v, str) and v.startswith(FORMULA_START) else v


def text(v):
    """Text as the CSV holds it: line breaks as BREAK, NUL as "?" (a lone surrogate becomes "?" when the file is
    encoded), then a formula-looking start made inert."""
    return inert(_BREAKS.sub(BREAK, str(v)).replace("\x00", "?"))


def field(v):
    """One cell -> what csv.writer gets: None (an empty field), an unquoted number or TRUE/FALSE, or quoted text."""
    if v is None or v == "":
        return None  # a blank is an empty field: Power BI reads null, not an empty text
    if isinstance(v, bool):
        return _Raw("TRUE" if v else "FALSE")
    if isinstance(v, int):
        try:
            float(v)
        except OverflowError:  # a 309-digit whole number: no number in Power BI holds it, so it goes as its digits
            return text(str(v))
        return _Raw(str(v))
    if isinstance(v, float):
        return _Raw(repr(v).replace("e", "E"))  # the shortest form that reads back exactly; E like Excel writes it
    return text(v)


def _shown(v):
    """A number the way the pane shows it (JavaScript's String): 100 not 100.0, 0.00001 not 1e-05, 1e-7 not 1e-07."""
    if isinstance(v, int) or v == 0:
        return str(int(v))  # -0 is "0" too
    if 1e-6 <= abs(v) < 1e21:
        return np.format_float_positional(v, trim="-")
    return re.sub(r"e([+-])0*(\d)", r"e\1\2", repr(v))


def _typo_kind(v, fix):
    """The pane's typoKind, as a key: one slip is a flipped sign or a power of ten."""
    if v * fix < 0:
        return "sign"
    r = abs(v / fix) if fix else (math.nan if v == 0 else math.inf)
    k = math.log10(r) if r > 0 else -math.inf
    return str(math.floor(k + 0.5) if math.isfinite(k) else k)  # Math.round: halves go up


def suggested_fix(columns, row, verdict):
    """The values the pane's card offers for this row (fix.recommendFix), as "Column: old → new" parts: a capitals/
    spaces variant, the row's own arithmetic, an obvious typo (x10, a sign), a possible misspelling marked "(a guess)".
    Like the card, 2+ cells off by the same step are a real row, not 2 typos: none of them is offered. The card also
    never types over a formula; this file doesn't know which cells hold one."""
    likely, maybe = verdict.get("likely") or {}, verdict.get("maybe") or {}
    reason = verdict.get("reason") or ""
    parts = re.sub(r"^Flagged by \d+ of \d+: ", "", reason).split("; ")
    summed = {c for p in parts if (m := _ADDS.match(p)) for c in (m[1], m[4], m[5])}
    out, slips = [], {}  # slips: kind -> the parts it made
    for c, v in zip(columns, row, strict=True):
        new = likely.get(c)
        is_num = isinstance(v, (int, float)) and not isinstance(v, bool)
        if isinstance(new, str) and isinstance(v, str):
            out.append(f'{c}: "{v}" → "{new}"')
        elif isinstance(maybe.get(c), str) and isinstance(v, str):
            out.append(f'{c}: "{v}" → "{maybe[c]}" (a guess)')
        elif new is not None and is_num and (c in summed or f"{c} weird limit is" in reason):
            out.append(f"{c}: {_shown(v)} → {_shown(new)}")
            if c not in summed:
                slips.setdefault(_typo_kind(v, new), []).append(out[-1])
    for same in slips.values():
        if len(same) >= 2:
            out = [p for p in out if p not in same]
    return "; ".join(out)


def _header(columns):
    """Header names as the CSV holds them, never two alike: a sheet's own "Severity" keeps its name, and ours becomes
    "Anomaly Hunter Severity" (then "Anomaly Hunter Severity 2"...)."""
    names = []
    for c in columns:
        name, n = text(c), 2
        while name in names:
            name, n = f"{text(c)} {n}", n + 1
        names.append(name)
    ours = []
    for r in ("Excel Row", *RESULTS):
        name, n = r if r not in names else f"Anomaly Hunter {r}", 2
        while name in names or name in ours:
            name, n = f"Anomaly Hunter {r} {n}", n + 1
        ours.append(name)
    return [ours[0], *names, *ours[1:]]


def tables(columns, rows, out, start_row=0, sheet="", now=None):
    """-> (scan table, flags table): lists of rows, the header first, cells as csv.writer gets them."""
    now = now or datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    full, flags = [_header(columns)], [list(FLAGS)]
    for i, (row, v) in enumerate(zip(rows, out, strict=True)):
        hit = v["severity"] in FLAGGED
        result = [v["severity"], v["bucket"], v["reason"], suggested_fix(columns, row, v) if hit else "", v["magnitude"]]
        excel_row = start_row + 2 + i  # the pane's "Row N": the header sits in sheet row start_row + 1
        full.append([field(excel_row), *map(field, row), *map(field, result)])
        if hit:
            flags.append([field(now), field(sheet), field(excel_row), *map(field, result)])
    return full, flags


def paths(scan_csv):
    return Path(scan_csv), Path(scan_csv).with_name("latest-flags.csv")


def remove(scan_csv):
    """Power BI off: no copy of the sheet is kept, nor a half-written one."""
    for p in paths(scan_csv):
        for q in (p, Path(f"{p}.tmp")):
            q.unlink(missing_ok=True)


def write(scan_csv, columns, rows, out, start_row=0, sheet=""):
    """Both files, each written whole to a .tmp first and then swapped in, so Power BI never reads half a file.
    UTF-8 with a BOM: without it Power BI reads the file as Windows-1252 and every accent or emoji comes out garbled."""
    try:
        made = list(zip(paths(scan_csv), tables(columns, rows, out, start_row, sheet), strict=True))
        for p, table in made:
            # errors="replace": one odd character (a lone surrogate) becomes "?" instead of failing the copy
            with open(f"{p}.tmp", "w", encoding="utf-8-sig", errors="replace", newline="") as f:
                csv.writer(f, quoting=csv.QUOTE_STRINGS).writerows(table)
        for p, _ in made:
            os.replace(f"{p}.tmp", p)
    except BaseException:
        remove(scan_csv)  # never a stale copy of an older sheet that Power BI would show as this scan
        raise


SHORTCUTS = {"anomaly-hunter.pbids": "latest-scan.csv", "anomaly-hunter-flags.pbids": "latest-flags.csv"}


def shortcuts(data, folder):
    """Write the Power BI Desktop shortcuts (.pbids: one data source each, the most a .pbids may hold) into `folder`,
    each pointing at its CSV in `data` (this PC's %LOCALAPPDATA%\\AnomalyHunter). -> the files written."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    made = []
    for name, csv_name in SHORTCUTS.items():
        spec = {"version": "0.1", "connections": [{"details": {"protocol": "file", "address": {
            "path": str(Path(data) / csv_name)}}, "options": {}, "mode": "Import"}]}
        (folder / name).write_text(json.dumps(spec, indent=2), encoding="utf-8")  # ASCII: a non-English path is escaped
        made.append(folder / name)
    return made


if __name__ == "__main__":  # install.bat: python -m anomaly_hunter.powerbi DATA_FOLDER SHORTCUT_FOLDER
    import sys
    shortcuts(sys.argv[1], sys.argv[2])
