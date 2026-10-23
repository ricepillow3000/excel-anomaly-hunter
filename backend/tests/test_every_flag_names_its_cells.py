"""AH-40: every highlighted cell has its real reason. On every bench sheet, each flagged row carries plain sentences that
name real columns; the value a sentence quotes is what that row's cell holds; and the row's `cells` (what the pane
colours) are exactly the columns its sentences are about. The pane coloured the whole row, and a reason quoted a cell
through :g (1234567.89 said as 1.23457e+06)."""
import os
import re
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bench"))
import datasets  # noqa: E402
import datasets2  # noqa: E402
import datasets3  # noqa: E402

from anomaly_hunter.agents.scan_agent import scan  # noqa: E402

SHEETS = datasets.make(7) + [d for s in (11, 12, 13) for d in datasets2.make(s)] + [d for s in (21, 22, 23) for d in datasets3.make(s)]


def issues(reason):
    """A reason's sentences, as the pane splits them (fix.issuesOf)."""
    out = []
    for p in re.sub(r"^Flagged by \d+ of \d+: ", "", reason).split("; "):
        if p.startswith("this is ") and out:
            out[-1] += "; " + p
        elif p:
            out.append(p)
    return out


def named(sentence, cols):
    """The columns a sentence names, longest first, each where it stands as a whole name."""
    hits, rest = [], sentence
    for c in sorted((c for c in cols if c), key=len, reverse=True):
        pat = r"(^|[\s\"(])" + re.escape(c) + r"(?=$|[\s\",;:)])"
        if re.search(pat, rest):
            hits.append(c)
            rest = re.sub(pat, lambda m: m[1] + "\0", rest)
    return hits


def same(quoted, cell):
    """The quoted value is the cell's: a number equal to it (to 15 digits), a date on its day, a text as written (up to 60 characters)."""
    if isinstance(cell, (int, float)) and not isinstance(cell, bool):
        return float(quoted) == float(f"{cell:.15g}")  # Excel holds 15 significant digits
    t = str(cell).strip()
    if re.fullmatch(r"\d{4}-\d\d-\d\d", quoted):
        return pd.Timestamp(t).strftime("%Y-%m-%d") == quoted
    try:
        return float(quoted) == float(t)
    except ValueError:
        return quoted in {x if len(x) <= 60 else x[:57] + "..." for x in (str(cell), t)}  # "east " is quoted with its space


VALUE = r'(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|\d{4}-\d\d-\d\d|"[^"]*")'


def quoted(sentence, cols):
    """(column, value as quoted) for each cell a sentence quotes."""
    for c in sorted((c for c in cols if c), key=len, reverse=True):
        for pat in (rf"^{re.escape(c)} {VALUE} ", rf"^{re.escape(c)} weird limit is \S+; this is {VALUE}",
                    rf"^{re.escape(c)} baseline limit is \S+; this is {VALUE}"):
            if m := re.match(pat, sentence):
                return [(c, m[1].strip('"'))]
        if m := re.fullmatch(rf'(?:Text|Placeholder) "(.*)" in (?:number |date )?column {re.escape(c)}', sentence):
            return [(c, m[1])]
        if m := re.fullmatch(rf"Excel error (\S+) in {re.escape(c)}", sentence):
            return [(c, m[1])]
    return []


@pytest.mark.parametrize("level", [0, 5, 10])
def test_every_flagged_cell_has_a_reason_that_names_it_and_quotes_what_it_holds(level):
    bad = []
    for d in SHEETS:
        h = d["header"]
        cols, rows = [str(c) for c in d["grid"][h]], d["grid"][h + 1:]
        _, out, *_ = scan(cols, rows, fair=False, strength=level)
        for i, o in enumerate(out):
            if o["severity"] not in ("Low", "Medium", "High"):
                continue
            where = f"{d['name']} row {i} ({o['reason'][:120]})"
            cells, said = o.get("cells"), issues(o["reason"])
            if not cells or not set(cells) <= set(cols) or not said:
                bad.append(f"{where}: cells {cells}")
                continue
            about = set()
            for s in said:
                if s.startswith("Duplicate of row "):
                    about |= set(cols)  # the whole row is the copy
                    continue
                names = named(s, cols)
                if not names or not set(names) & set(cells):
                    bad.append(f"{where}: '{s}' names {names}, cells {cells}")
                about |= set(names) & set(cells)
                for c, v in quoted(s, cols):
                    if not same(v, rows[i][cols.index(c)]):
                        bad.append(f"{where}: '{s}' quotes {v!r}, the cell holds {rows[i][cols.index(c)]!r}")
            if about != set(cells):
                bad.append(f"{where}: cells {cells} but the sentences are about {sorted(about)}")
    assert not bad, f"{len(bad)} problems, e.g.\n" + "\n".join(bad[:15])


def test_a_reason_quotes_a_long_number_as_the_cell_holds_it():
    # :g gave 6 significant digits: a study day 12345.67 among whole numbers was said as 12345.7, a 1234567.89 slip as
    # 1.23457e+06 - a value no cell holds
    rows = [[f"S{i}", 12000 + i, 2.0 + (i % 7)] for i in range(80)]
    rows[30][1] = 12345.67
    rows[50][2] = 1234567.89
    _, out, *_ = scan(["Id", "Study day", "Dose"], rows, fair=False)
    assert "Study day 12345.67 is not a whole number" in out[30]["reason"] and out[30]["cells"] == ["Study day"], out[30]
    assert "this is 1234567.89" in out[50]["reason"] and out[50]["cells"] == ["Dose"], out[50]


def test_a_total_that_does_not_add_up_colours_the_total_and_its_parts_only():
    rows = [[f"O{i}", f"note {i}", 1 + i % 9, 2.5 + i % 4, (1 + i % 9) * (2.5 + i % 4)] for i in range(60)]
    rows[20][4] = 99.0
    _, out, *_ = scan(["Order", "Note", "Qty", "Price", "Line Total"], rows, fair=False)
    assert "does not add up" in out[20]["reason"] and out[20]["cells"] == ["Qty", "Price", "Line Total"], out[20]


def test_a_placeholder_note_and_a_series_jump_colour_their_own_cells():
    # AH-45's note for a placeholder written through a column, and AH-31's series reasons, name their cells too
    rows = [[f"W{i:05d}", ["Tap", "Well", "Borehole"][i % 3], round(1 + (i % 17) * 0.37, 4)] for i in range(4000)]
    for i in range(3, 4000, 25):
        rows[i][1] = "Unknown"
    out = scan(["row_id", "facility_type", "lat_deg"], rows, fair=False)[1]
    noted = [o for o in out if "(no value)" in o["reason"]]
    assert len(noted) == 1 and noted[0]["cells"] == ["facility_type"], noted
    series = [[f"{1990 + k // 12}-{k % 12 + 1:02d}-01", round(100 + 0.3 * k + (k % 12) * 0.5, 2)] for k in range(240)]
    series[120][1] += 40
    out = scan(["Month", "Value"], series, fair=False)[1]
    assert out[120]["severity"] and "Value" in out[120]["reason"] and out[120]["cells"] == ["Value"], out[120]
