"""AH-21: a "likely" fix is a card the user may accept, so it must be one the numbers prove. Blind round 22 and the
held-out tables found 8 "likely" guesses on real values: Seattle's sub-zero highs and a sea-level series' first years
given sign flips, California's fruit exports (3 cells, one step) given "/1000", DC's real 4% given "x10". A probe found
"Floors 20 among 1-5" given "likely 2". Synthetic sheets only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter import powerbi
from anomaly_hunter.agents.scan_agent import scan


def likely_on(out, col):
    return [(i, r["likely"][col]) for i, r in enumerate(out) if col in (r.get("likely") or {})]


def test_small_negatives_where_a_column_crosses_zero_are_not_sign_slips():
    # Seattle's daily highs: a few real days below 0 among thousands, right next to many highs of 0-3 degrees. The
    # sign-flip guess saw "negatives are rare" and offered 1.1 for -1.1. A slip stands alone: the only negative, or
    # as big as the column's usual values (a -44.5 latitude among 18-71)
    rng = np.random.default_rng(1)
    days = np.arange(1461)
    highs = np.round(15 + 9 * np.sin(2 * np.pi * (days - 100) / 365) + rng.normal(0, 3, len(days)), 1)
    highs = np.where(highs < 0.2, np.round(rng.uniform(0.2, 2.5, len(days)), 1), highs)
    highs[[18, 766, 767]] = [-1.1, -0.5, -1.6]
    out = scan(["date", "temp_max"], [[f"d{i}", float(h)] for i, h in enumerate(highs)], fair=False)[1]
    assert likely_on(out, "temp_max") == [], likely_on(out, "temp_max")


def test_a_series_that_starts_near_zero_keeps_its_early_negatives():
    # CSIRO's sea level: 0 in 1880, -0.44 and -0.23 the next years, rising to 9 inches; the first years were "likely" flipped
    rng = np.random.default_rng(2)
    level = np.round(np.linspace(0, 9, 134) + rng.normal(0, 0.25, 134), 3)
    level[0], level[1], level[2] = 0.0, -0.441, -0.232
    level[3:] = np.abs(level[3:])
    out = scan(["Year", "Sea level"], [[1880 + i, float(v)] for i, v in enumerate(level)], fair=False)[1]
    assert likely_on(out, "Sea level") == [], likely_on(out, "Sea level")


def test_cells_off_by_the_same_step_in_one_row_get_no_likely_guess():
    # California's fruit: fresh, processed and their total all ~1000x the other states', and adding up exactly. One slip
    # changes one cell; three cells off by the same step are a real row. The card held them back; the engine said
    # "(likely 2.7918)" in the reason anyway
    rng = np.random.default_rng(3)
    rows = []
    for i in range(50):
        fresh, proc = round(float(rng.uniform(0.5, 9)), 2), round(float(rng.uniform(0.5, 9)), 2)
        rows.append([f"S{i:02d}", fresh, proc, round(fresh + proc, 2)])
    rows[4][1:] = [2791.8, 5944.6, 8736.4]
    out = scan(["state", "fruits fresh", "fruits proc", "total fruits"], rows, fair=False)[1]
    # ...and the row adds up (fruits fresh + fruits proc = total fruits): its own arithmetic confirms the values, so they
    # are listed as worth a check (Low), no longer voted Medium as slips (AH-74)
    assert out[4]["severity"] == "Low" and "but the row adds up" in out[4]["reason"], out[4]
    assert not out[4].get("likely") and not out[4].get("maybe") and "(likely" not in out[4]["reason"], out[4]


def test_a_value_too_small_is_offered_as_a_guess_never_as_likely():
    # DC's real 4% of votes among states at 30-70%: "likely 0.4". A value typed too small may be real, or have lost
    # digits nobody can put back (Sq Ft 19 for 1915): offered as a guess the user confirms, still flagged
    rng = np.random.default_rng(4)
    rows = [[f"S{i:02d}", round(float(np.clip(rng.normal(0.5, 0.09), 0.24, 0.72)), 2)] for i in range(51)]
    rows[8][1] = 0.04
    r = scan(["state", "share_voted"], rows, fair=False)[1][8]
    assert r["severity"] in ("Medium", "High"), r
    assert not (r.get("likely") or {}).get("share_voted") and "(likely" not in r["reason"], r
    assert r["maybe"] == {"share_voted": 0.4} and "(maybe 0.4)" in r["reason"], r
    assert powerbi.suggested_fix(["state", "share_voted"], rows[8], r) == "share_voted: 0.04 → 0.4 (a guess)"


def test_a_tenth_among_small_whole_numbers_is_flagged_but_never_offered():
    # a real 20-floor building among 1-5 floors looks exactly like a rating 20 typed for 2: the numbers cannot tell, and
    # real counts offered a tenth is why the 1-5 scale rule was dropped (John, AH-16). Flagged, no fix offered
    rng = np.random.default_rng(5)
    rows = [[f"B{i:02d}", int(rng.integers(1, 6))] for i in range(60)] + [["B99", 20]]
    r = scan(["Building", "Floors"], rows, fair=False)[1][-1]
    assert r["severity"] in ("Medium", "High") and "Floors weird limit is" in r["reason"], r
    assert not r.get("likely") and not r.get("maybe") and "(likely" not in r["reason"] and "(maybe" not in r["reason"], r
    assert powerbi.suggested_fix(["Building", "Floors"], rows[-1], r) == ""


def test_a_lone_minus_sign_is_still_a_likely_typo():
    rng = np.random.default_rng(6)
    rows = [[f"r{i}", int(rng.integers(24, 34))] for i in range(60)]
    rows[30][1] = -29
    r = scan(["Id", "Units"], rows, fair=False)[1][30]
    assert r["likely"] == {"Units": 29.0} and "(likely 29)" in r["reason"], r


def airports():
    """Latitudes 18-71, three real small negatives (American Samoa -14.3, ...) and a planted -44.5 (blind round 22)."""
    rng = np.random.default_rng(7)
    lat = list(np.round(rng.uniform(18, 71, 3000), 4)) + [-14.331, -7.31, -13.48]
    lat[1641] = -44.48507333
    # (AH-25 try 2: a latitude can be negative, so its flip is now a guess; the rule this guards is the header-free one,
    # a slip as big as the column's values beside real small negatives, so the column is named neutrally)
    return scan(["iata", "reading"], [[f"A{i:04d}", float(v)] for i, v in enumerate(lat)], fair=False)[1]


def test_a_flipped_sign_as_big_as_the_columns_values_is_still_likely_beside_real_negatives():
    out = airports()
    # the guess is said to the column's own 8 decimals, never :g's 44.4851 (AH-40)
    assert out[1641]["likely"] == {"reading": 44.48507333} and "(likely 44.48507333)" in out[1641]["reason"], out[1641]


def test_real_small_negatives_beside_a_slip_are_not_flipped():
    # the territories' -14.3, -7.3 and -13.5 sit below every positive latitude, beside other negatives: real places
    assert [i for i, _ in likely_on(airports(), "reading")] == [1641]


# AH-25: a lone negative where the quantity itself can go below zero - a loss month among profits, a sub-zero day among
# highs, an overdrawn balance - looks exactly like a minus typed by mistake. The numbers cannot tell, so it is offered as
# a guess the user confirms ("maybe"), never "likely"; the cell stays flagged. Where the quantity cannot go negative (On
# Hand, Units, Spend, Weight) a lone minus is still a likely slip
def lone_negative(col, lo, hi, v, seed=8, n=36):
    rng = np.random.default_rng(seed)
    rows = [[f"M{i:02d}", round(float(rng.uniform(lo, hi)), 1)] for i in range(n)]
    rows[20][1] = v
    return rows, scan(["Month", col], rows, fair=False)[1][20]


@pytest.mark.parametrize("col, lo, hi, v", [
    ("Profit", 800, 2400, -1200),
    ("Net Income", 800, 2400, -1500),
    ("P&L", 800, 2400, -1200),
    ("Change", 50, 400, -300),
    ("Balance", 1000, 9000, -3000),
    ("temp_max", 12, 34, -15),
    ("High (°F)", 40, 95, -60),
    # try 2 (Council A's review: each of these still said "likely")
    ("P/L", 800, 2400, -1200), ("PnL", 800, 2400, -1200), ("P L", 800, 2400, -1200), ("Cash flow", 800, 2400, -1200),
    ("TMAX", 12, 34, -15), ("TMIN", 12, 34, -15), ("Highs", 12, 34, -15), ("Lows", 12, 34, -15),
    ("Chg", 50, 400, -300), ("% chg", 50, 400, -300), ("YoY %", 50, 400, -300), ("Var", 50, 400, -300),
    ("Elevation", 800, 2400, -1200), ("Latitude", 20, 60, -45), ("Yield", 2, 6, -4), ("Interest rate", 2, 6, -4),
    ("Spread", 50, 400, -300), ("Anomaly", 50, 400, -300), ("Error", 50, 400, -300), ("Forecast error", 50, 400, -300),
    ("Residual", 50, 400, -300), ("Adjustment", 50, 400, -300), ("Score to par", 2, 9, -6), ("Over/Under", 2, 9, -6),
    # review 2: Visual Crossing's daily columns, a high with its unit in brackets, an operating loss (each said "likely")
    ("tempmax", 12, 34, -15), ("tempmin", 12, 34, -15), ("feelslike", 12, 34, -15), ("High (C)", 12, 34, -15),
    ("Low (F)", 40, 95, -60), ("Daily High", 12, 34, -15), ("Operating income", 800, 2400, -1200),
])
def test_a_lone_negative_where_the_quantity_can_be_negative_is_a_guess_never_likely(col, lo, hi, v):
    rows, r = lone_negative(col, lo, hi, v)
    assert r["severity"] in ("Medium", "High"), r
    assert not (r.get("likely") or {}).get(col) and "(likely" not in r["reason"], r
    assert r["maybe"] == {col: float(-v)} and f"(maybe {-v:g})" in r["reason"], r
    assert powerbi.suggested_fix(["Month", col], rows[20], r) == f"{col}: {v:g} → {-v:g} (a guess)"


@pytest.mark.parametrize("col, lo, hi, v", [("On Hand", 20, 300, -138), ("Units", 24, 34, -29), ("Spend", 200, 9000, -3314),
                                            ("Weight (kg)", 50, 110, -70.7),
                                            # try 2: words that named a signed quantity only in other headers (Council A)
                                            ("Low stock", 20, 300, -138), ("High price", 20, 300, -138), ("High score", 20, 300, -138),
                                            ("Net weight", 50, 110, -70.7), ("Net units", 20, 300, -138), ("Return qty", 20, 300, -138),
                                            ("Returns", 20, 300, -138), ("Change given", 20, 300, -138), ("Income", 800, 2400, -1200),
                                            ("Temp ID", 200, 900, -500), ("Error count", 20, 300, -138), ("Par", 3, 5, -4),
                                            ("High school GPA", 2.0, 4.0, -3.1),
                                            # review 2: an absolute value is never below zero
                                            ("Absolute error", 50, 400, -300), ("Abs diff", 50, 400, -300)])
def test_a_lone_negative_where_the_quantity_cannot_be_negative_is_still_likely(col, lo, hi, v):
    _, r = lone_negative(col, lo, hi, v)
    assert r["likely"] == {col: float(-v)} and f"(likely {-v:g})" in r["reason"], r


def test_a_high_or_low_column_beside_open_and_close_is_a_price_and_its_lone_minus_is_still_likely():
    # a stock's High and Low never go below zero; a weather sheet's do (Highs and Lows above, alone)
    rng = np.random.default_rng(9)
    rows = []
    for i in range(36):
        o = round(float(rng.uniform(80, 120)), 2)
        rows.append([f"D{i:02d}", o, round(o + 2, 2), round(o - 2, 2), round(o + 1, 2)])
    rows[20][2] = -rows[20][2]
    r = scan(["Date", "Open", "High", "Low", "Close"], rows, fair=False)[1][20]
    assert (r.get("likely") or {}).get("High") == -rows[20][2], r
