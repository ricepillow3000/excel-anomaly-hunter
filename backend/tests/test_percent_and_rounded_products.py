"""AH-30 (blind round 23, now a tuning set): a percentage column let 233.4 through (drought area_pct, 0-100 everywhere
else), and a race time that is laps x average lap time was never learnt as a rule, because the average is rounded to the
cent and laps multiply its rounding (16 laps x 0.005 s = 0.08 s, past the rule's 1-cent tolerance), so a qualifying time
of 26.1 s typed 261 - inside the column's 17-492 s - went unflagged. Synthetic sheets only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def shares(col, n=400, seed=40):
    rng = np.random.default_rng(seed)
    return [[f"W{i:03d}", ("None", "D0", "D1", "D2")[i % 4], round(float(rng.uniform(0, 100)), 2)] for i in range(n)]


@pytest.mark.parametrize("col", ["area_pct", "Percent covered", "Share (%)", "PctOwned", "Coverage %"])
def test_a_percentage_past_100_is_worth_a_check(col):
    rows = shares(col)
    rows[123][2] = 101.5  # just past 100, inside any limit
    r = scan(["week", "level", col], rows, fair=False)[1][123]
    assert f"{col} 101.5 is outside what {col} can be (0 to 100)" in r["reason"], r


@pytest.mark.parametrize("col", ["% chg", "YoY %", "Growth (%)", "Margin %", "Return %", "Change in share (%)",
                                 "% of target", "Percent of normal", "Pct of budget", "Capacity used (%)"])
def test_a_percent_change_or_margin_is_not_held_to_0_to_100(col):
    rows = shares(col)
    rows[123][2] = 140.0
    rows[124][2] = -12.0
    out = scan(["week", "level", col], rows, fair=False)[1]
    assert not any("can be (0 to 100)" in o["reason"] for o in out), (col, out[123]["reason"], out[124]["reason"])


def races(seed=41):
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(256):
        laps = int(rng.choice([1, 1, 4, 8, 12, 16]))
        lap = float(rng.uniform(17, 42))
        rows.append([f"R{i:03d}", laps, round(lap, 2), round(laps * lap, 2), round(float(rng.uniform(11.9, 14.6)), 2)])
    return rows


def test_a_time_that_is_not_laps_times_the_rounded_lap_time_is_flagged():
    rows = races()
    i = next(k for k, r in enumerate(rows) if r[1] == 1 and 24 < r[3] < 28)
    rows[i][3] = round(rows[i][3] * 10, 2)  # 26.1 typed 261: inside the column's own range
    r = scan(["race", "number_laps", "avg_time_lap", "time_s", "track_length_m"], rows, fair=False)[1][i]
    assert "time_s" in r["reason"] and "does not add up" in r["reason"], r


def test_honest_rounding_of_a_lap_time_never_breaks_the_rule():
    out = scan(["race", "number_laps", "avg_time_lap", "time_s", "track_length_m"], races(), fair=False)[1]
    assert not any("does not add up" in o["reason"] for o in out), [o["reason"] for o in out if "does not add up" in o["reason"]][:3]


def test_a_line_total_stays_exact_to_the_cent():
    # Qty x Unit Price to the cent: a total off by 2 cents is still flagged (the exact rule wins where it holds)
    rng = np.random.default_rng(42)
    rows = [[f"O{i:03d}", int(q), float(p), round(int(q) * float(p), 2)] for i, (q, p) in
            enumerate(zip(rng.integers(1, 40, 200), np.round(rng.uniform(1, 90, 200), 2)))]
    rows[50][3] = round(rows[50][3] + 0.02, 2)
    r = scan(["order", "Qty", "Unit Price", "Line Total"], rows, fair=False)[1][50]
    assert "Line Total" in r["reason"] and "does not add up" in r["reason"], r
