"""AH-21: a "likely" fix is a card the user may accept, so it must be one the numbers prove. Blind round 22 and the
held-out tables found 8 "likely" guesses on real values: Seattle's sub-zero highs and a sea-level series' first years
given sign flips, California's fruit exports (3 cells, one step) given "/1000", DC's real 4% given "x10". A probe found
"Floors 20 among 1-5" given "likely 2". Synthetic sheets only, shaped like those tables."""
import numpy as np

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
    assert out[4]["severity"] in ("Medium", "High"), "still flagged: it is far past the column"
    assert not out[4].get("likely") and "(likely" not in out[4]["reason"], out[4]


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
    return scan(["iata", "latitude"], [[f"A{i:04d}", float(v)] for i, v in enumerate(lat)], fair=False)[1]


def test_a_flipped_sign_as_big_as_the_columns_values_is_still_likely_beside_real_negatives():
    out = airports()
    assert out[1641]["likely"] == {"latitude": 44.48507333} and "(likely 44.4851)" in out[1641]["reason"], out[1641]


def test_real_small_negatives_beside_a_slip_are_not_flipped():
    # the territories' -14.3, -7.3 and -13.5 sit below every positive latitude, beside other negatives: real places
    assert [i for i, _ in likely_on(airports(), "latitude")] == [1641]
