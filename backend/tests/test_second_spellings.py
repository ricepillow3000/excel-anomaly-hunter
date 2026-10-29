"""AH-67: a capital/space variant the source writes many times is its own second spelling, one note for the column; a
slip of a row or three is still flagged on each row. The bar is measured on the round 22, 23, 36, 37, 38 and raw59
sheets: every in-style variant written 4+ times there is the source's (wildlife strikes' ARRIVAL 7 and APPROACH 21,
cocktails' Highball Glass 75 beside 302, a fish survey's Channel catfish 96 beside 658); one written 2-4 times stays a slip to check.
Synthetic sheets only."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

FLAG = ("Low", "Medium", "High")


def glasses(variant, times, usual=302, seed=67):
    rng = np.random.default_rng(seed)
    labels = ["Highball glass"] * usual + [variant] * times + ["Cocktail glass"] * 450 + ["Old-fashioned glass"] * 213 + ["Shot glass"] * 98
    rng.shuffle(labels)
    return ["Drink", "Glass", "Ingredients"], [[f"Drink {i}", g, int(rng.integers(2, 9))] for i, g in enumerate(labels)]


def test_a_second_spelling_written_a_quarter_as_often_as_the_usual_one_is_one_note():
    # cocktails (round 38): "Highball Glass" 75 beside "Highball glass" 302 stayed a Medium on all 75 rows (0.25 was
    # under AH-64's one-third bar; "Collins glass" 144 beside 269 was one note)
    cols, rows = glasses("Highball Glass", 75)
    out = scan(cols, rows, fair=False)[1]
    said = [(i, o) for i, o in enumerate(out) if "Highball" in o["reason"]]
    assert len(said) == 1, [o["reason"] for _, o in said[:3]]
    i, o = said[0]
    assert '"Highball Glass" 75 times' in o["reason"] and '"Highball glass" 302 times' in o["reason"], o["reason"]
    assert o["severity"] == "Low" and o["cells"] == ["Glass"] and not o.get("likely"), o
    assert [k for k, x in enumerate(out) if x["severity"] in FLAG] == [i]


@pytest.mark.parametrize("times", [5, 7, 21])
def test_an_in_style_variant_written_5_times_or_more_is_the_sources_own_spelling(times):
    # wildlife strikes: ARRIVAL 7 times, APPROACH 21 beside thousands, each a Medium row on main
    cols, rows = glasses("Highball Glass", times, usual=3000)
    out = scan(cols, rows, fair=False)[1]
    said = [o for o in out if "Highball" in o["reason"]]
    assert len(said) == 1 and f'"Highball Glass" {times} times' in said[0]["reason"], [o["reason"] for o in said[:3]]


@pytest.mark.parametrize("times", [1, 2, 3])
def test_a_variant_of_a_row_or_three_is_still_flagged_on_each_of_its_rows(times):
    cols, rows = glasses("Highball Glass", times, usual=300)
    out = scan(cols, rows, fair=False)[1]
    rows_with = [i for i, r in enumerate(rows) if r[1] == "Highball Glass"]
    for i in rows_with:
        assert '"Highball Glass" looks like "Highball glass" (same word, different capitals/spaces)' in out[i]["reason"], out[i]
        assert out[i]["severity"] == "Medium" and out[i]["likely"] == {"Glass": "Highball glass"}, out[i]
    assert [i for i, o in enumerate(out) if o["severity"] in FLAG] == rows_with


def test_a_variant_off_the_columns_style_is_still_flagged_however_common():
    # "employed" 77 beside "Employed" 82 (test_blindspots): lowercase where the labels are capitalised
    cols, rows = glasses("highball glass", 75)
    out = scan(cols, rows, fair=False)[1]
    rows_with = [i for i, r in enumerate(rows) if r[1] == "highball glass"]
    assert all('"highball glass" looks like "Highball glass"' in out[i]["reason"] for i in rows_with)
