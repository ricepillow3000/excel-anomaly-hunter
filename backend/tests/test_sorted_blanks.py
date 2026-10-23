"""AH-46 (blind round 36): Marvel's characters table is sorted by APPEARANCES, most first, and Excel's sort puts blank
cells last, so its 1,093 characters with no count sit as one block at the end. Each was a Medium "Blank cell" row: the
layout of a sort, read as 1,093 slips. Blanks at the very end of a table sorted by that column are one note; a blank
in the middle, or a block at the end of a column nothing is sorted by (an export that stopped), is still each a slip.
Synthetic sheets only, shaped like that table."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def marvel(n=2000, tail=130, ascending=False, seed=3):
    rng = np.random.default_rng(seed)
    counts = sorted((int(x) + 1 for x in rng.pareto(1.2, n - tail) * 10), reverse=not ascending)
    rows = [[f"Character {i}", ["Good", "Bad", "Neutral"][int(rng.integers(0, 3))], c, int(rng.integers(1939, 2014))]
            for i, c in enumerate(counts)]
    rows += [[f"Character {n - tail + i}", ["Good", "Bad", "Neutral"][i % 3], "", int(rng.integers(1939, 2014))] for i in range(tail)]
    return ["name", "ALIGN", "APPEARANCES", "Year"], rows


def flagged(out, word):
    return [i for i, r in enumerate(out) if r["severity"] in ("Low", "Medium", "High") and word in r["reason"]]


@pytest.mark.parametrize("ascending", [False, True])
def test_blanks_at_the_end_of_a_table_sorted_by_their_column_are_one_note(ascending):
    out = scan(*marvel(ascending=ascending), fair=False)[1]
    assert not flagged(out, "Blank cell"), len(flagged(out, "Blank cell"))
    assert flagged(out, "APPEARANCES is blank") == [1870], flagged(out, "APPEARANCES is blank")
    assert out[1870]["severity"] == "Low" and out[1870]["reason"] == \
        "APPEARANCES is blank in 130 of 2000 rows, all at the end of the table, which is sorted by APPEARANCES", out[1870]


def test_a_blank_in_the_middle_of_a_sorted_column_is_still_a_slip():
    cols, rows = marvel()
    rows[700][2] = ""
    out = scan(cols, rows, fair=False)[1]
    assert flagged(out, "Blank cell in column APPEARANCES") == [700] and flagged(out, "APPEARANCES is blank") == [1870]


def test_a_block_of_blanks_at_the_end_of_a_column_nothing_is_sorted_by_is_still_each_a_slip():
    # an export that stopped: the last 40 counts missing, the rest in no order
    rng = np.random.default_rng(4)
    cols, rows = marvel()
    rows = [r[:2] + [int(rng.integers(1, 500))] + r[3:] for r in rows]
    for r in rows[-40:]:
        r[2] = ""
    out = scan(cols, rows, fair=False)[1]
    assert flagged(out, "Blank cell in column APPEARANCES") == list(range(1960, 2000))


def test_a_table_sorted_a_to_z_by_a_text_column_keeps_its_blank_tail_as_one_note():
    # Excel sorts text without regard to capitals: "amsterdam" sits between "Aarhus" and "Berlin"
    cities = sorted([f"{w}{k}" for w in ("Aarhus", "amsterdam", "Berlin", "cairo", "Delhi", "Essen", "Faro") for k in range(40)], key=str.casefold)
    rows = [[f"S{i}", c, 10 + i % 7] for i, c in enumerate(cities)] + [[f"S{280 + i}", "", 10 + i % 7] for i in range(15)]
    out = scan(["Store", "City", "Staff"], rows, fair=False)[1]
    assert not flagged(out, "Blank cell") and flagged(out, "City is blank in 15 of 295 rows, all at the end") == [280], \
        [out[i]["reason"] for i in (279, 280, 281)]


def test_a_slip_inside_the_sorted_column_still_leaves_its_blank_tail_one_note():
    # round 36's Marvel: one count typed x10 (528 as 5280) stood against the order, and every blank was a slip again
    cols, rows = marvel()
    rows[61][2] = rows[61][2] * 10
    out = scan(cols, rows, fair=False)[1]
    assert not flagged(out, "Blank cell") and flagged(out, "APPEARANCES is blank") == [1870]


def test_the_note_colours_its_own_column_only():
    out = scan(*marvel(), fair=False)[1]
    assert out[1870]["cells"] == ["APPEARANCES"], out[1870]
