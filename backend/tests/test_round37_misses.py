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
