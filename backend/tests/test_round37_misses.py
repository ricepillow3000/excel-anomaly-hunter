"""AH-55: blind round 37's misses, each rebuilt as a synthetic sheet shaped like the real table (never the table itself):
a year 2955 among dates of death since 1791, totals that do not add up on 48 and 200 rows, and a birth month of 13."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

FLAG = ("Low", "Medium", "High")


def flagged(out):
    return [i for i, o in enumerate(out) if o["severity"] in FLAG]


@pytest.mark.parametrize("col, first, typos", [("Death date", 1791, ("2955-03-14", "2971-11-02")),
                                               ("Born", 1850, ("2887-01-26",))])
def test_a_far_date_among_honest_dates_before_1900_in_a_date_column_is_caught(col, first, typos):
    # 1 date in 11 before 1900: still a date column, and its old dates were read as text, so many of one shape that the
    # rule "a shape the column repeats 5+ times is its own code" excused the typo with them
    rng = np.random.default_rng(7)
    rows = []
    for i in range(1918):
        y = int(rng.integers(first, 1900)) if i % 11 == 0 else int(rng.integers(1900, 2024))
        rows.append([f"P{i}", f"{y}-{int(rng.integers(1, 13)):02d}-{int(rng.integers(1, 29)):02d}", int(rng.integers(20, 90))])
    at = [100, 900][:len(typos)]
    for i, typo in zip(at, typos):
        rows[i][1] = typo
    out = scan(["Name", col, "Age"], rows, fair=False)[1]
    for i in at:
        assert "is far outside the column's dates" in out[i]["reason"] and out[i]["cells"] == [col], out[i]
    assert flagged(out) == at, [(i, out[i]["reason"]) for i in flagged(out)]


def test_an_honest_date_before_1900_in_a_date_column_is_a_date_not_text():
    rows = [[f"P{i}", f"{1950 + i % 70}-0{1 + i % 9}-1{i % 10}", 5] for i in range(200)]
    for i in range(0, 200, 25):
        rows[i][1] = f"18{50 + i % 40}-05-0{1 + i % 9}"
    out = scan(["Name", "Date of death", "x"], rows, fair=False)[1]
    assert flagged(out) == [], [out[i]["reason"] for i in flagged(out)]


def census(n, plant=None):
    rng = np.random.default_rng(5)
    rows = []
    for i in range(n):
        m, f, x = int(rng.integers(200, 5000)), int(rng.integers(200, 5000)), int(rng.integers(0, 12))
        rows.append([2000 + i // 4, ["North", "South", "East", "West"][i % 4], m, f, x, m + f + x])
    if plant is not None:
        rows[plant][5] += 100
    return ["Year", "Region", "Male", "Female", "Intersex", "Total"], rows


def test_a_total_of_three_columns_that_does_not_add_up_on_48_rows_is_flagged():
    # least squares needs 20 rows a number column (here 5: 100 rows); an exact sum needs no such minimum
    out = scan(*census(48, plant=20), fair=False)[1]
    assert out[20]["reason"] == "Total 7639 does not add up: Male + Female + Intersex = 7539", out[20]
    assert set(out[20]["cells"]) == {"Total", "Male", "Female", "Intersex"} and flagged(out) == [20]


def test_a_total_of_eight_age_groups_beside_a_year_and_an_area_that_does_not_add_up_is_flagged():
    rng = np.random.default_rng(5)
    cols = ["Year", "District"] + [f"Age {a}-{a + 9}" for a in range(0, 80, 10)] + ["Total", "Area km2", "Density"]
    rows = []
    for i in range(200):
        p = [int(rng.integers(50, 3000)) for _ in range(8)]
        rows.append([2010 + i % 10, f"D{i // 10}"] + p + [sum(p), round(float(rng.uniform(5, 500)), 1), round(float(rng.uniform(1, 90)), 2)])
    rows[77][10] += 40
    out = scan(cols, rows, fair=False)[1]
    assert out[77]["reason"].startswith("Total ") and "does not add up: Age 0-9 + Age 10-19 + " in out[77]["reason"], out[77]
    assert flagged(out) == [77]


@pytest.mark.parametrize("head", ["All ages", "SUM", "total_cases"])
def test_a_total_that_adds_up_on_every_row_is_quiet_whatever_its_header(head):
    cols, rows = census(48)
    out = scan(cols[:5] + [head], rows, fair=False)[1]
    assert flagged(out) == []


def test_a_total_on_a_short_sheet_is_not_judged_when_too_few_rows_could_show_the_rule():
    # 8 rows: one that does not add up among 7 that do could be a rule or chance; nothing is said
    out = scan(*census(8, plant=3), fair=False)[1]
    assert not any("does not add up" in o["reason"] for o in out)


def test_a_total_that_is_not_the_sum_of_the_columns_beside_it_is_never_called_wrong():
    # "Total score" of three tests is their weighted mean here: no exact sum, no rule, no flag
    rng = np.random.default_rng(2)
    rows = []
    for i in range(120):
        a, b, c = (int(rng.integers(40, 100)) for _ in range(3))
        rows.append([f"S{i}", a, b, c, round(0.2 * a + 0.3 * b + 0.5 * c, 1)])
    out = scan(["Student", "Test 1", "Test 2", "Test 3", "Total score"], rows, fair=False)[1]
    assert not any("does not add up" in o["reason"] for o in out)


@pytest.mark.parametrize("col", ["birth_month", "Birth month", "Start Month"])
def test_a_month_of_13_under_a_header_that_names_a_kind_of_month_is_worth_a_check(col):
    rng = np.random.default_rng(6)
    rows = [[f"P{i}", int(rng.integers(1, 13)), int(rng.integers(18, 80))] for i in range(300)]
    rows[40][1] = 13
    out = scan(["Name", col, "Age"], rows, fair=False)[1]
    assert f"{col} 13 is outside what {col} can be (1 to 12)" in out[40]["reason"], out[40]


@pytest.mark.parametrize("col", ["Months", "Months since last visit", "tenure_months", "Day of month", "Sales last month",
                                 "Per month", "3 month return"])
def test_a_count_of_months_or_something_measured_in_one_is_no_month(col):
    rng = np.random.default_rng(6)
    rows = [[f"P{i}", int(rng.integers(1, 40)), int(rng.integers(18, 80))] for i in range(300)]
    out = scan(["Name", col, "Age"], rows, fair=False)[1]
    assert not any("outside what" in o["reason"] for o in out)


def shares(col, n, top):
    rng = np.random.default_rng(n)
    rows = [[f"R{i}", round(float(rng.uniform(0, 100)), 1), int(rng.integers(1, 50))] for i in range(n)]
    rows[7][1] = top
    return scan(["Name", col, "Count"], rows, fair=False)[1]


@pytest.mark.parametrize("col", ["Percent", "cocoa_percent", "Rate (%)"])
def test_a_percentage_far_past_100_among_shares_of_a_whole_is_worth_a_check_on_a_short_sheet(col):
    # 40 rows: the limits call 200 "baseline" only, and it was found at level 10 alone, as an odd combination
    out = shares(col, 40, 200.0)
    assert f"{col} 200 is over 100, and every other {col} is a share between 0 and 100" in out[7]["reason"], out[7]
    assert out[7]["severity"] in FLAG


@pytest.mark.parametrize("col, top", [("female_bonus_percent", 100.4),  # round 36: one honest 100.4 in 48,711 rows
                                      ("Tax 5%", 200.0), ("Hourly 90th Percentile", 200.0), ("Attendance %", 200.0),
                                      ("Markup %", 200.0), ("Percent change", 200.0)])
def test_a_percentage_just_past_100_or_one_that_may_pass_it_is_no_share_slip(col, top):
    out = shares(col, 400, top)
    assert "a share between 0 and 100" not in out[7]["reason"], out[7]


def test_a_percentage_column_with_values_below_0_is_no_share():
    rng = np.random.default_rng(9)
    rows = [[f"R{i}", round(float(rng.uniform(-50, 100)), 1), 3] for i in range(100)]
    rows[7][1] = 200.0
    out = scan(["Name", "diff_percent", "x"], rows, fair=False)[1]
    assert "a share between 0 and 100" not in out[7]["reason"]


def store_totals(included, slip=None):
    # a quarterly Total beside an Adjustment column that is 0 in 96% of rows, either part of the Total or not
    rng = np.random.default_rng(12)
    rows = []
    for i in range(400):
        a, b, c = int(rng.integers(10, 900)), int(rng.integers(10, 900)), int(rng.integers(10, 900))
        adj = 0 if rng.random() < 0.96 else int(rng.integers(1, 50))
        rows.append([f"S{i}", a, b, c, adj, a + b + c + (adj if included else 0)])
    if slip is not None:
        rows[slip][5] += 300
    return ["Store", "A", "B", "C", "Adjustment", "Total"], rows


def test_a_mostly_zero_column_beside_a_total_that_leaves_it_out_flags_nothing():
    # AH-55 review (Council B): "A + B + C + Adjustment" held on the 96% of rows where Adjustment is 0, and the
    # other 16 honest rows were each a Medium "does not add up"
    out = scan(*store_totals(included=False), fair=False)[1]
    assert not [i for i, o in enumerate(out) if "does not add up" in o["reason"]], [o["reason"] for o in out if "add up" in o["reason"]][:2]


def test_a_mostly_zero_part_a_total_includes_still_lets_a_slip_be_found():
    out = scan(*store_totals(included=True, slip=200), fair=False)[1]
    assert [i for i, o in enumerate(out) if "does not add up" in o["reason"]] == [200], [o["reason"] for o in out if "add up" in o["reason"]][:3]


@pytest.mark.parametrize("share", [0.1, 0.15, 0.25])
def test_a_total_with_refunds_on_a_few_days_finds_slips_on_refund_and_ordinary_days(share):
    # AH-55 review 2 (Council A): Food + Drinks + Merch + Refunds = Total, Refunds non-zero on 10-15% of 90 days; try 2
    # left out every Refunds row and with them the whole rule: both slips were missed
    rng = np.random.default_rng(4)
    rows = []
    for i in range(90):
        a, b, c = int(rng.integers(100, 900)), int(rng.integers(100, 900)), int(rng.integers(50, 400))
        r = -int(rng.integers(10, 80)) if rng.random() < share else 0
        rows.append([f"Store {i}", a, b, c, r, a + b + c + r])
    s1, s2 = [i for i, x in enumerate(rows) if x[4]][0], [i for i, x in enumerate(rows) if not x[4]][10]
    rows[s1][5] += 37
    rows[s2][5] += 37
    out = scan(["Store", "Food", "Drinks", "Merch", "Refunds", "Total"], rows, fair=False)[1]
    found = [i for i, o in enumerate(out) if "does not add up" in o["reason"]]
    # a single Refunds day that does not add up shows Refunds is no part: the day is judged without it, and found (try 4).
    # With 2 Refunds days, 1 adding up, nothing shows which way: those days are left unjudged, never called wrong
    refund_days = sum(1 for x in rows if x[4])
    assert found == (sorted([s1, s2]) if refund_days != 2 else [s2]), (refund_days, [o["reason"] for o in out if "add up" in o["reason"]])


@pytest.mark.parametrize("nonzero", [1, 3])
def test_a_column_beside_a_total_that_is_not_0_once_or_thrice_and_no_part_of_it_flags_nothing(nonzero):
    rng = np.random.default_rng(13)
    rows = []
    for i in range(200):
        a, b, c = int(rng.integers(10, 900)), int(rng.integers(10, 900)), int(rng.integers(10, 900))
        rows.append([f"S{i}", a, b, c, int(rng.integers(1, 50)) if i < nonzero else 0, a + b + c])
    out = scan(["Store", "A", "B", "C", "Adjustment", "Total"], rows, fair=False)[1]
    assert not [i for i, o in enumerate(out) if "does not add up" in o["reason"]], [o["reason"] for o in out if "add up" in o["reason"]][:2]


def stand(n, adjustment_before_total, seed=7):
    # Food + Drinks + Merch = Total, an Adjustment column 0 on 94% of days and no part of it, a +37 slip on a plain day
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        a, b, c = int(rng.integers(100, 900)), int(rng.integers(100, 900)), int(rng.integers(50, 400))
        adj = int(rng.integers(5, 60)) if rng.random() < 0.06 else 0
        rows.append([f"Day {i}", a, b, c, adj, a + b + c] if adjustment_before_total else [f"Day {i}", a, b, c, a + b + c, adj])
    total = 5 if adjustment_before_total else 4
    slip = [i for i, r in enumerate(rows) if not r[9 - total]][5]
    rows[slip][total] += 37
    cols = ["Day", "Food", "Drinks", "Merch"] + (["Adjustment", "Total"] if adjustment_before_total else ["Total", "Adjustment"])
    return cols, rows, slip


@pytest.mark.parametrize("n", [90, 400])
@pytest.mark.parametrize("before", [True, False])
def test_a_column_that_adds_up_on_none_of_its_own_rows_is_never_named_as_a_part_of_the_total(n, before):
    # AH-55 review 3 (Council A): try 3 said "Total 1456 does not add up: Food + Drinks + Merch + Adjustment = 1419" and
    # coloured the Adjustment cell; at 400 rows least squares had it right
    cols, rows, slip = stand(n, before)
    out = scan(cols, rows, fair=False)[1]
    said = [(i, o["reason"]) for i, o in enumerate(out) if "does not add up" in o["reason"]]
    assert len(said) == 1 and said[0][0] == slip and "does not add up: Food + Drinks + Merch = " in said[0][1], said
    assert "Adjustment" not in out[slip]["cells"], out[slip]["cells"]


def test_two_refund_days_one_adding_up_are_left_unjudged_and_the_honest_one_never_called_wrong():
    rng = np.random.default_rng(21)
    rows = []
    for i in range(90):
        a, b, c = int(rng.integers(100, 900)), int(rng.integers(100, 900)), int(rng.integers(50, 400))
        r = -int(rng.integers(10, 80)) if i in (20, 60) else 0
        rows.append([f"Day {i}", a, b, c, r, a + b + c + r])
    rows[60][5] += 37
    rows[40][5] += 37
    out = scan(["Day", "Food", "Drinks", "Merch", "Refunds", "Total"], rows, fair=False)[1]
    assert [i for i, o in enumerate(out) if "does not add up" in o["reason"]] == [40], [o["reason"] for o in out if "add up" in o["reason"]]
