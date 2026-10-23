"""Blind round 36 (now a tuning set): lone slips level 5 missed, and "likely" fixes on real values (AH-47). Synthetic
sheets only, shaped like those tables: a restaurant's bills, an incident list's ages, a firm's role IDs, hotel rates,
the years programming languages appeared."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def tips(seed=244):
    # a restaurant's bills: most 5-35, the tail climbing to 50.81 (its top 11 as in the real table), 17.29 typed 172.9
    rng = np.random.default_rng(seed)
    bills = list(np.round(np.clip(np.exp(rng.normal(2.85, 0.45, 233)), 3.07, 38.9), 2))
    bills += [39.42, 40.17, 40.55, 41.19, 43.11, 44.3, 45.35, 48.17, 48.27, 48.33, 50.81]
    bills[79] = 172.9
    return ["total_bill", "tip"], [[float(b), round(float(rng.uniform(1, 6)), 2)] for b in bills]


def test_a_bill_three_times_the_next_highest_stands_alone_at_level_5():
    # 172.9 among bills up to 50.81: its gap (3.4x) is 4.8 times the climb of the next 10, under the old 8
    cols, rows = tips()
    out = scan(cols, rows, fair=False)[1]
    assert out[79]["severity"] and "total_bill 172.9 stands alone above the rest" in out[79]["reason"], out[79]


@pytest.mark.parametrize("col", ["age", "Age", "victim_age", "Age (years)", "participant_age", "actor_1_age", "Patient age"])
def test_an_age_past_120_is_outside_what_an_age_can_be(col):
    # LA riots: an age of 310 (31) in 62 rows was said nothing at level 5
    rng = np.random.default_rng(62)
    rows = [[f"P{i}", int(rng.integers(16, 70))] for i in range(62)]
    rows[52][1] = 310
    out = scan(["name", col], rows, fair=False)[1]
    assert out[52]["severity"] and f"{col} 310 is outside what {col} can be (0 to 120)" in out[52]["reason"], out[52]


@pytest.mark.parametrize("col", ["Age (days)", "age_days", "Average", "Mileage", "Age group",
                                 # AH-47 review: a thing's age is not a person's (a tree 180, a building 135, a bond 150)
                                 "Tree age", "Building age", "Account age", "Star age", "Wine age", "Bond age", "Vehicle age",
                                 "Rock age (years)", "Character age"])
def test_an_age_in_days_or_a_word_that_ends_in_age_has_no_such_bound(col):
    # one value past 120 among 1-100: a person's age would be "outside what it can be"; this column's is honest
    rng = np.random.default_rng(63)
    rows = [[f"P{i}", int(rng.integers(1, 100))] for i in range(300)]
    rows[5][1] = 180
    out = scan(["id", col], rows, fair=False)[1]
    assert not any("can be (0 to 120)" in o["reason"] for o in out), out[5]


def test_minus_one_among_ids_is_never_a_likely_one():
    # a CEO table's co_per_rol: -1 (a code for none) among role ids of 1,500-50,000 read "(likely 1)"
    rng = np.random.default_rng(9)
    rows = [[f"C{i}", int(rng.integers(1500, 60000))] for i in range(2000)]
    rows[0][1] = -1
    r = scan(["firm", "co_per_rol"], rows, fair=False)[1][0]
    assert r["severity"] and "likely" not in r["reason"] and not r.get("likely"), r


def test_a_lone_small_negative_rate_is_never_a_likely_flip():
    # a hotel's only negative rate, -6.38, among rates of 30-500: a refund or an adjustment the numbers cannot tell
    rng = np.random.default_rng(10)
    rows = [[f"B{i}", round(float(np.exp(rng.normal(4.4, 0.4))), 2)] for i in range(3000)]
    rows[7][1] = -6.38
    r = scan(["booking", "adr"], rows, fair=False)[1][7]
    assert r["severity"] and not r.get("likely"), r


def test_a_year_before_zero_is_never_a_likely_flip():
    # Babylonian numerals appeared in -2000 (2000 BC): years of 1950-2020 with a few BC ones read "(likely 2000)"
    rng = np.random.default_rng(11)
    rows = [[f"L{i}", int(rng.integers(1955, 2021))] for i in range(4000)]
    for i, y in zip((5, 9, 40, 77, 300, 1134), (-300, -600, -700, -900, -300, -2000)):
        rows[i][1] = y
    r = scan(["language", "appeared"], rows, fair=False)[1][1134]
    assert not r.get("likely"), r


def test_a_lone_minus_sign_on_a_usual_value_is_still_likely():
    rng = np.random.default_rng(12)
    rows = [[f"B{i}", round(float(np.exp(rng.normal(4.4, 0.4))), 2)] for i in range(3000)]
    rows[7][1] = -81.25
    r = scan(["booking", "adr"], rows, fair=False)[1][7]
    assert r.get("likely") == {"adr": 81.25}, r


def test_three_cells_below_zero_in_one_row_are_a_real_row_never_a_likely_flip():
    # a child-spending table's row: raw -21,820.5, inflation-adjusted -22,728.7 and per child -0.013, all below zero
    # together (blind round 23): once the small one was no longer offered a flip, the big one kept "likely 21820.5"
    rng = np.random.default_rng(13)
    rows = [[f"S{i}", round(float(np.exp(rng.normal(10, 1))), 1), 0.0, 0.0] for i in range(3000)]
    for row in rows:
        row[2], row[3] = round(row[1] * 1.04, 1), round(row[1] / 1.6e6, 6)
    rows[1907][1:] = [-21820.5, -22728.7, -0.0133382]
    r = scan(["state", "raw", "inf_adj", "inf_adj_perchild"], rows, fair=False)[1][1907]
    assert r["severity"] and not r.get("likely") and "likely" not in r["reason"], r


def test_a_lone_top_and_an_age_past_120_colour_their_own_cells():
    # AH-40: the pane colours the cells a reason names; these sentences name one column each
    cols, rows = tips()
    assert scan(cols, rows, fair=False)[1][79]["cells"] == ["total_bill"]
    rng = np.random.default_rng(62)
    ages = [[f"P{i}", int(rng.integers(16, 70))] for i in range(62)]
    ages[52][1] = 310
    assert scan(["name", "victim_age"], ages, fair=False)[1][52]["cells"] == ["victim_age"]
