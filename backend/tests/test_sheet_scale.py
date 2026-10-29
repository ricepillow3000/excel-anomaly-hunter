"""AH-59: the scan's sense of too-far-off scales with the sheet. John's rule: a $5 miss in a billion-dollar ledger is
rounding noise, a $5 miss in petty cash is a real mistake; and the same sheet in dollars, thousands or millions gets the
same flags. Synthetic sheets only, shaped like a ledger, a petty-cash book and a sales list."""
import numpy as np

from anomaly_hunter.agents.scan_agent import scan

ADDS = "does not add up"


def ledger(lo, hi, seed=59):
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(200):
        a, b, c = (round(float(v), 2) for v in rng.uniform(lo, hi, 3))
        rows.append([f"L{i:03d}", a, b, c, round(a + b + c, 2)])
    return ["Entry", "A", "B", "C", "Total"], rows


def lines(qty_hi, price_lo, price_hi, seed=60):
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(200):
        q, p = int(rng.integers(1, qty_hi)), round(float(rng.uniform(price_lo, price_hi)), 2)
        rows.append([f"O{i:03d}", q, p, round(q * p, 2)])
    return ["Order", "Qty", "Price", "Line"], rows


def test_a_five_dollar_miss_on_a_billion_dollar_total_is_rounding_noise():
    cols, rows = ledger(2e8, 4e8)  # three parts of ~300 million: totals near a billion
    rows[50][4] = round(rows[50][4] + 5.00, 2)
    rows[120][4] = round(rows[120][4] + 1e6, 2)  # a million off: the rule is learnt on this ledger and still bites
    out = scan(cols, rows, fair=False)[1]
    assert ADDS not in out[50]["reason"], (rows[50], out[50])
    assert ADDS in out[120]["reason"], (rows[120], out[120])


def test_a_five_dollar_miss_in_petty_cash_is_flagged():
    cols, rows = ledger(2, 80)  # totals of roughly 10 to 200
    rows[50][4] = round(rows[50][4] + 5.00, 2)
    r = scan(cols, rows, fair=False)[1][50]
    assert ADDS in r["reason"] and "Total" in r["reason"], (rows[50], r)


def test_a_five_dollar_miss_on_a_billion_dollar_line_is_rounding_noise():
    cols, rows = lines(20, 5e7, 1.5e8)  # Qty x Price: lines up to ~3 billion
    rows[70][3] = round(rows[70][3] + 5.00, 2)
    rows[120][3] = round(rows[120][3] + 1e6, 2)  # a million off: the rule is learnt on these lines and still bites
    out = scan(cols, rows, fair=False)[1]
    assert ADDS not in out[70]["reason"], (rows[70], out[70])
    assert ADDS in out[120]["reason"], (rows[120], out[120])


def test_a_five_dollar_miss_on_a_petty_cash_line_is_flagged():
    cols, rows = lines(8, 2, 25)  # Qty x Price: lines of roughly 10 to 200
    rows[70][3] = round(rows[70][3] + 5.00, 2)
    r = scan(cols, rows, fair=False)[1][70]
    assert ADDS in r["reason"] and "Line" in r["reason"], (rows[70], r)


def sales(seed=61):
    rng = np.random.default_rng(seed)
    regions = ["North", "South", "East", "West"]
    rows = []
    for i in range(200):
        q, p = int(rng.integers(1, 51)), round(float(rng.uniform(4, 90)), 2)
        rows.append([f"S{i:03d}", str(rng.choice(regions)), q, p, round(q * p, 2), int(rng.integers(1, 29))])
    rows[20][4] = round(rows[20][4] * 3 + 17.0, 2)  # a Line that is not Qty x Price, by a lot
    rows[60][3] = round(rows[60][3] * 10, 2)        # a Price typed x10, its Line kept from the real price
    rows[100][3] = -rows[100][3]                    # a sign slip on a Price, its Line kept positive
    rows[140][3] = None                             # a blank Price
    rows[180][4] = round(rows[180][4] + 250.0, 2)   # a Line 250 off
    return ["Sale", "Region", "Qty", "Price", "Line", "Day"], rows, {20, 60, 100, 140, 180}


def scaled(rows, k):
    # the money columns (Price, Line) in another unit, still written to the cent; Qty is a count and stays
    return [[*r[:3], None if r[3] is None else round(r[3] * k, 2), round(r[4] * k, 2), r[5]] for r in rows]


def test_the_same_mistakes_are_found_whatever_the_size_of_the_money():
    cols, rows, planted = sales()
    seen = {}
    for k in (1, 1_000, 1_000_000):
        out = scan(cols, scaled(rows, k), fair=False)[1]
        seen[k] = {i: o["severity"] for i, o in enumerate(out) if o["severity"]}
    assert planted <= {i for i, s in seen[1].items() if s in ("Low", "Medium", "High")}, seen[1]
    assert seen[1_000] == seen[1], (seen[1], seen[1_000])
    assert seen[1_000_000] == seen[1], (seen[1], seen[1_000_000])
