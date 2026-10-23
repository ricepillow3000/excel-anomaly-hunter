"""AH-31 (blind round 23, now a tuning set, and round 22's tables): the dated-series check called 49-64% of a smooth
real series' months unusual at level 5 (CO2 ppm, a jobs report), each far past its vote line. On a smooth line the
local median is the value itself, so the gaps from it are ~0 and every bend of the curve looked like a jump; and the
first and last months were read against a one-sided window. A jump moves a value further than the series usually
moves in one row; the trend window shrinks evenly at both ends. Real jumps, spikes and level shifts, from one to a
fifth of the months, are found as before (try 1 capped the votes instead and lost them, AH-31 review). Synthetic only."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

SERIES = ("unusual relative to its local trend", "jumped sharply")


def seasonal(n=800, seed=31):
    # monthly CO2-like: the reading with its yearly swing, and the smooth trend column such files carry beside it
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    trend = 315 + 0.11 * t + 0.0001 * t ** 2
    return [[f"{1958 + m // 12}-{m % 12 + 1:02d}-15", round(float(trend[m] + 3 * np.sin(2 * np.pi * m / 12) + rng.normal(0, 0.1)), 2),
             round(float(trend[m]), 2)] for m in range(n)]


def employment(n=120, seed=34):
    # 8 smooth monthly payroll columns with a recession dip, like a jobs report
    rng = np.random.default_rng(seed)
    base = rng.uniform(500, 140000, 8)
    rows = []
    for m in range(n):
        shape = 1 + 0.002 * m - 0.05 * np.exp(-((m - 45) / 8) ** 2)
        rows.append([f"{2006 + m // 12}-{m % 12 + 1:02d}-01"] + [round(float(b * shape * (1 + rng.normal(0, 0.0005))), 1) for b in base])
    return rows


def sheet(name):
    return (["Date", "Average", "Trend"], seasonal()) if name == "co2" else (["month"] + [f"s{j}" for j in range(8)], employment())


def listed(out):
    return [i for i, o in enumerate(out) if any(w in o["reason"] for w in SERIES)]


@pytest.mark.parametrize("level", [3, 5, 10])
@pytest.mark.parametrize("name", ["co2", "jobs"])
def test_a_smooth_series_is_not_called_unusual_month_after_month(name, level):
    # main listed 37/133/318 of these 800 CO2 months at levels 3/5/10, and 11/18/30 of the 120 jobs months, from the
    # first and last months on. The recession's sharp turn (months 40-56) may be worth a check; a smooth stretch never
    cols, rows = sheet(name)
    found = listed(scan(cols, rows, fair=False, strength=level)[1])
    smooth = [i for i in found if not (name == "jobs" and 40 <= i <= 56)]
    assert len(smooth) <= 0.01 * len(rows), (name, level, len(found), smooth[:10])


@pytest.mark.parametrize("name", ["co2", "jobs"])
def test_the_first_and_last_months_of_a_smooth_series_are_not_jumps(name):
    # read against a one-sided window, they were the series' strongest votes: 10-38x the line
    cols, rows = sheet(name)
    found = set(listed(scan(cols, rows, fair=False, strength=10)[1]))
    assert not found & {0, 1, 2, len(rows) - 3, len(rows) - 2, len(rows) - 1}, sorted(found)


@pytest.mark.parametrize("level", [3, 5, 10])
def test_a_real_jump_in_a_seasonal_series_is_still_found(level):
    rows = seasonal()
    rows[400][1] = round(rows[400][1] + 25, 2)
    out = scan(["Date", "Average", "Trend"], rows, fair=False, strength=level)[1]
    assert 400 in listed(out), (level, out[400])


@pytest.mark.parametrize("level", [3, 5, 10])
def test_a_level_shift_in_a_smooth_series_is_still_found(level):
    # every month from 400 on is 20 higher: no single value is far from its neighbours after the shift
    rows = seasonal()
    for m in range(400, len(rows)):
        rows[m][1] = round(rows[m][1] + 20, 2)
    found = listed(scan(["Date", "Average", "Trend"], rows, fair=False, strength=level)[1])
    assert any(397 <= i <= 403 for i in found), (level, found)


# what main 0a7232e finds on these sheets: no level may find fewer (AH-31 review, rule d)
MAIN = {(0.01, 5): 12, (0.05, 5): 58, (0.10, 5): 119, (0.20, 5): 138, (0.01, 10): 12, (0.05, 10): 59, (0.10, 10): 120, (0.20, 10): 187}


@pytest.mark.parametrize("share, level", sorted(MAIN))
def test_a_sheet_with_many_real_jumps_keeps_every_one_main_found(share, level):
    # Council A's probe (AH-31 review): capped, 120 real jumps in 1,200 months were cut to 9 at level 5
    rng, m = np.random.default_rng(7), 1200
    t = np.arange(m)
    s = 100 + 0.05 * t + 5 * np.sin(2 * np.pi * t / 12) + rng.normal(0, 0.3, m)
    jumps = sorted(int(j) for j in rng.choice(np.arange(20, m - 20), int(share * m), replace=False))
    s[jumps] += 12  # well inside the column's own range
    rows = [[f"{1900 + k // 12}-{k % 12 + 1:02d}-01", round(float(v), 2)] for k, v in enumerate(s)]
    out = scan(["Month", "Value"], rows, fair=False, strength=level)[1]
    assert sum(1 for j in jumps if out[j]["severity"]) >= MAIN[share, level], (share, level)


@pytest.mark.parametrize("level", [5, 10])
@pytest.mark.parametrize("at", [0, 1, 2, -3, -2, -1])
def test_a_jump_in_the_first_or_last_rows_is_still_found(level, at):
    # AH-31 try 2 review: the evenly shrinking window leaves the very first value no neighbour on one side, and a +12
    # (40 noise sds) in row 1 of a monthly series went unseen at every level; main found it through the one-sided window
    rng = np.random.default_rng(12)
    m = 600
    t = np.arange(m)
    v = 100 + 0.05 * t + 5 * np.sin(2 * np.pi * t / 12) + rng.normal(0, 0.3, m)
    v[at] += 12
    rows = [[f"{1900 + k // 12}-{k % 12 + 1:02d}-01", round(float(x), 2)] for k, x in enumerate(v)]
    out = scan(["Month", "Value"], rows, fair=False, strength=level)[1]
    assert out[at]["severity"] in ("Low", "Medium", "High"), (at, level, out[at])
