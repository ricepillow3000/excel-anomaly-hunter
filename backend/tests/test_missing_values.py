"""Blind round 23 (30 real tables): R and tidyverse exports write every missing number as the text "NA", so about 3,960
cells (measles 877, olympics 813, NFL 638...) were each "Text in a number column", Medium (AH-27); and honest blanks
spread through a column were one Medium per row (Netflix cast and country 1,225, Titanic Age 176, AH-28). Synthetic
sheets only, shaped like those tables."""
import numpy as np

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.load import load_from_records


def _sheet(n, missing, every, seed=1, col="Age"):
    """n passengers; `missing` written into col every `every` rows (an R export's NA, or a blank)."""
    rng = np.random.default_rng(seed)
    rows = [[f"P{i:04d}", ["S", "C", "Q"][i % 3], round(float(rng.uniform(1, 80)), 1), round(float(rng.uniform(5, 90)), 2)]
            for i in range(n)]
    for i in range(3, n, every):
        rows[i][2] = missing
    return ["Passenger", "Embarked", col, "Fare"], rows


def flagged(out, word):
    return [i for i, r in enumerate(out) if r["severity"] and word in r["reason"]]


# AH-27: NA, NaN, null and None are what a program writes for "no value"; in a number or date column they are missing,
# like a blank, never text typed into the column. A person's placeholder (N/A, TBD, ?, -) is still named as one.
def test_an_r_exports_na_in_a_number_column_is_a_missing_value_not_text():
    for word in ("NA", "NaN", "nan", "null", "NULL", "None", " NA "):
        cols, rows = _sheet(400, word, 9)  # 45 of 400: 11%, so the column used to be read as text
        df, types, errors = load_from_records(cols, rows)
        assert types["Age"] == "number", (word, types)
        assert np.isnan(df["Age"][3]) and not [e for e in errors if e[1] == "Age"], word
        _, out, *_ = scan(cols, rows, fair=False)
        assert not flagged(out, "Text"), (word, [out[i]["reason"] for i in flagged(out, "Text")][:3])


def test_a_lone_na_in_a_filled_number_column_is_still_flagged_as_a_blank():
    cols, rows = _sheet(200, 1.0, 1000)
    rows[57][2] = "NA"
    _, out, *_ = scan(cols, rows, fair=False)
    assert out[57]["severity"] == "Medium" and out[57]["reason"] == "Blank cell in column Age, which is otherwise filled", out[57]


def test_an_na_in_a_date_column_is_a_missing_date():
    rows = [[f"D{i}", f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}", i * 3.5] for i in range(300)]
    for i in range(5, 300, 8):
        rows[i][1] = "NA"
    df, types, errors = load_from_records(["Id", "Visit", "Dose"], rows)
    assert types["Visit"] == "date" and df["Visit"].isna().sum() == 37 and not errors


def test_a_persons_placeholder_in_a_number_column_is_still_named():
    cols, rows = _sheet(200, 1.0, 1000)
    rows[40][2] = "N/A"
    _, out, *_ = scan(cols, rows, fair=False)
    assert out[40]["reason"] == 'Placeholder "N/A" in column Age', out[40]


# AH-28: many blanks spread through a column are how the data is (an unknown age, a film with no cast listed), not one
# slip per row: one note for the column. A few blanks, or a block of them, are still flagged one by one.
def test_many_blanks_spread_through_a_column_get_one_note_for_the_column():
    cols, rows = _sheet(891, "", 5)  # Titanic: 178 of 891 ages unknown, 80% filled
    _, out, *_ = scan(cols, rows, fair=False)
    assert not flagged(out, "Blank cell"), [out[i]["reason"] for i in flagged(out, "Blank cell")][:3]
    noted = flagged(out, "is blank in")
    assert noted == [3], noted
    assert out[3]["severity"] == "Low" and out[3]["reason"] == "Age is blank in 178 of 891 rows, spread through the sheet", out[3]


def test_an_r_export_with_many_na_gets_one_note_too():
    cols, rows = _sheet(2000, "NA", 12, col="Weight")
    _, out, *_ = scan(cols, rows, fair=False)
    assert not flagged(out, "Blank cell") and not flagged(out, "Text") and flagged(out, '(no value)') == [3]
    assert out[3]["reason"] == 'Weight is "NA" (no value) in 167 of 2000 rows', out[3]


def test_an_export_that_writes_na_in_a_block_is_one_note_too():
    # the Tour de France's winners: the first 8 years were scored on points, so their times are NA, on purpose
    cols, rows = _sheet(70, 1.0, 10000, col="Time")
    for i in range(2, 10):
        rows[i][2] = "NA"
    _, out, *_ = scan(cols, rows, fair=False)
    assert not flagged(out, "Blank cell") and flagged(out, "(no value)") == [2], [o["reason"] for o in out[:12]]
    assert out[2]["severity"] == "Low" and 'Time is "NA" (no value) in 8 of 70 rows' in out[2]["reason"], out[2]


def test_an_empty_cell_where_the_export_writes_na_for_no_value_is_still_flagged():
    # blind round 23: 638 bye weeks written "NA" and one attendance deleted: R never leaves a cell empty
    cols, rows = _sheet(2000, "NA", 12, col="Attendance")
    rows[1001][2] = ""
    _, out, *_ = scan(cols, rows, fair=False)
    assert flagged(out, "Blank cell in column Attendance") == [1001], flagged(out, "Blank cell")
    assert flagged(out, "(no value)") == [3]


def test_a_few_blanks_are_still_flagged_one_by_one():
    cols, rows = _sheet(891, 1.0, 10000)
    for i in (100, 400, 800):
        rows[i][2] = ""
    _, out, *_ = scan(cols, rows, fair=False)
    assert flagged(out, "Blank cell in column Age") == [100, 400, 800]


def test_a_block_of_blanks_is_still_flagged_one_by_one():
    # 40 rows in a row without an age: a paste or an export that stopped, not how the data is
    cols, rows = _sheet(891, 1.0, 10000)
    for i in range(500, 540):
        rows[i][2] = ""
    _, out, *_ = scan(cols, rows, fair=False)
    assert flagged(out, "Blank cell in column Age") == list(range(500, 540))


def test_a_few_deletions_spread_through_a_big_sheet_are_still_flagged_one_by_one():
    # 20 values gone from a 20,000-row column (0.1%) met "20+ in every fifth" and became one Low note on the first, so the
    # other 19 rows went unflagged (Council B, AH-27/28 review). Honest unknowns are a share of the column (Titanic's Age
    # 20%, Netflix's cast 9% and country 6.5%); a handful in a big sheet is still each a slip
    rng = np.random.default_rng(5)
    rows = [[f"r{i}", round(float(rng.uniform(10, 90)), 1), int(rng.integers(1, 9))] for i in range(20000)]
    gone = sorted(int(i) for i in rng.choice(20000, 20, replace=False))
    for i in gone:
        rows[i][1] = ""
    out = scan(["Id", "Amount", "Units"], rows, fair=False)[1]
    assert all("Blank cell in column Amount" in out[i]["reason"] for i in gone), [out[i]["reason"] for i in gone][:3]
