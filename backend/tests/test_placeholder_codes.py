"""Blind round 36 (now a tuning set): a placeholder word a column writes hundreds of times is its own code for "no value",
not a slip on each row: water points' facility_type "Unknown" 797 times and country "NULL" 436 times, a survey's
"N/A" (hasn't tried it) 173 times, each a Medium "Placeholder" (AH-45). Like R's NA (AH-27) and blanks spread through a
sheet (AH-28), from max(20, 1% of the column) it is one note for the column; a rare one is still each worth fixing.
Synthetic sheets only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def points(n, word, every, seed=2):
    rng = np.random.default_rng(seed)
    kinds = ["Tap", "Well", "Borehole", "Spring"]
    rows = [[f"W{i:05d}", kinds[int(rng.integers(0, 4))], round(float(rng.uniform(-5, 15)), 4)] for i in range(n)]
    for i in range(3, n, every):
        rows[i][1] = word
    return ["row_id", "facility_type", "lat_deg"], rows


def said(out, word):
    return [(i, o["severity"], o["reason"]) for i, o in enumerate(out) if word in o["reason"]]


@pytest.mark.parametrize("word", ["Unknown", "NULL", "N/A", "TBD"])
def test_a_placeholder_the_column_writes_hundreds_of_times_is_one_note_for_the_column(word):
    cols, rows = points(4000, word, 25)  # 160 of 4,000: 4%, under the 8% that makes it a category
    out = scan(cols, rows, fair=False)[1]
    got = said(out, f'"{word}"')
    assert len(got) == 1 and got[0][0] == 3 and got[0][1] == "Low", got[:3]
    assert got[0][2].endswith(f'facility_type is "{word}" (no value) in 160 of 4000 rows'), got[0]


def test_a_rare_placeholder_is_still_each_worth_fixing():
    cols, rows = points(4000, "Unknown", 1500)  # 3 of 4,000
    out = scan(cols, rows, fair=False)[1]
    got = said(out, '"Unknown"')
    assert [i for i, *_ in got] == [3, 1503, 3003] and all(s == "Medium" and 'Placeholder "Unknown" in column facility_type' in r for _, s, r in got), got


def test_twenty_placeholders_in_a_big_column_are_still_each_a_slip():
    cols, rows = points(20000, "TBD", 1000)  # 20 of 20,000: 0.1%, under 1% of the column
    out = scan(cols, rows, fair=False)[1]
    assert len(said(out, '"TBD"')) == 20 and all(s == "Medium" for _, s, _ in said(out, '"TBD"'))


def test_a_block_of_placeholders_is_still_each_a_slip():
    # 100 "Unknown" in the first 400 of 4,000 rows: a paste gone wrong, like a block of blanks (AH-28)
    cols, rows = points(4000, "Kiosk", 4000)
    for i in range(0, 400, 4):
        rows[i][1] = "Unknown"
    out = scan(cols, rows, fair=False)[1]
    got = said(out, '"Unknown"')
    assert len(got) == 100 and all(s == "Medium" for _, s, _ in got), got[:2]


def test_a_surveys_na_written_through_a_rating_column_is_one_note():
    # a survey's 1-5 rating of Italy's cuisine: "N/A" (hasn't tried it) 67 times among 1,264 answers, each a Medium row
    rng = np.random.default_rng(5)
    rows = [[f"R{i:04d}", int(rng.integers(1, 6))] for i in range(1264)]
    for i in range(7, 1264, 19):
        rows[i][1] = "N/A"
    out = scan(["RespondentID", "Rate Italy (1-5)"], rows, fair=False)[1]
    got = said(out, '"N/A"')
    assert len(got) == 1 and got[0][1] == "Low" and got[0][2].endswith('is "N/A" (no value) in 67 of 1264 rows'), got[:3]


def test_a_few_placeholders_in_a_number_column_are_still_each_named():
    rng = np.random.default_rng(5)
    rows = [[f"R{i:04d}", int(rng.integers(1, 6))] for i in range(1264)]
    for i in (10, 400, 900):
        rows[i][1] = "N/A"
    out = scan(["RespondentID", "Rate Italy (1-5)"], rows, fair=False)[1]
    assert [i for i, *_ in said(out, '"N/A"')] == [10, 400, 900]


def test_a_logs_error_level_is_a_category_never_no_value():
    # AH-45 review: a log's Level INFO/WARN/ERROR with ERROR on 3% of rows read 'Level is "ERROR" (no value) in 91 of
    # 3000 rows', untrue: ERROR keeps the rare-word flag it always had, and is never said to be no value
    rng = np.random.default_rng(8)
    rows = [[f"T{i}", ["INFO", "WARN"][int(rng.integers(0, 2))], f"msg {i}"] for i in range(3000)]
    for i in range(5, 3000, 33):
        rows[i][1] = "ERROR"
    out = scan(["Time", "Level", "Message"], rows, fair=False)[1]
    assert not any("no value" in o["reason"] for o in out), [o["reason"] for o in out if "no value" in o["reason"]][:1]
