"""AH-30 (blind round 23, now a tuning set): a race time that is laps x average lap time was never learnt as a rule,
because the average is rounded to the cent and laps multiply its rounding (16 laps x 0.005 s = 0.08 s, past the rule's
1-cent tolerance), so a qualifying time of 26.1 s typed 261 - inside the column's 17-492 s - went unflagged. And a
percentage is not a share of a whole by its name (AH-30 review). Synthetic sheets only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


@pytest.mark.parametrize("col, lo, hi, real", [
    # AH-30 review: a percentage is not a share of a whole by its name; each of these passes 0-100 for real
    ("Attendance %", 55, 99, [104.2, 101.7]), ("Utilization %", 40, 98, [112.0]), ("Markup %", 20, 95, [180.0]),
    ("ROI %", 1, 60, [310.0]), ("% increase", 0, 40, [-6.0, 150.0]), ("Inflation %", 0.5, 9, [-0.4]),
    ("CPU %", 2, 95, [340.0]), ("Debt % of GDP", 10, 95, [236.0]), ("Occupancy %", 40, 99, [103.0]),
    ("Speed (% of limit)", 60, 99, [131.0]), ("Efficiency %", 70, 99, [310.0]), ("Coverage %", 0, 99, [100.5])])
def test_a_percentage_column_is_never_said_to_be_past_what_it_can_be(col, lo, hi, real):
    rng = np.random.default_rng(43)
    vals = [round(float(v), 1) for v in rng.uniform(lo, hi, 400)] + real
    out = scan(["Id", col], [[f"r{i}", v] for i, v in enumerate(vals)], fair=False)[1]
    assert not any("can be (0 to 100)" in o["reason"] for o in out), (col, [o["reason"] for o in out if "can be" in o["reason"]])


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
