"""AH-29 (blind round 23, now a tuning set): a value typed x10 that lands past the column's maximum but inside its very wide
limits went unflagged. A column of two kinds (public tuitions 2k-14k, private 15k-60k) has log-scale limits of 500,000
and 23 million, so a public 10,563 typed as 105,630 - 1.8x the column's max, nothing between - passed; a price index of
38 states (15-381) let 1,225.6 through at level 5. A slip stands alone above the column's top run; an honest heavy tail
climbs to its top in steps. Synthetic sheets only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

ALONE = "stands alone above"


def tuition(seed=29):
    rng = np.random.default_rng(seed)
    pub = np.round(np.exp(rng.normal(np.log(6000), 0.45, 1600)), 0).clip(480, 14000)
    pri = np.round(rng.uniform(15000, 60000, 1300), 0)
    t = np.concatenate([pub, pri])
    rng.shuffle(t)
    return [[f"C{i:04d}", "Public" if v < 14500 else "Private", float(v)] for i, v in enumerate(t)]


def price_index(seed=30):
    rng = np.random.default_rng(seed)
    rows = []
    for s in range(38):  # 44 years of months, from 15-45 in 1975: most states end at 120-230, two climb to ~380
        base, end = rng.uniform(15, 45), rng.uniform(300, 381) if s < 2 else rng.uniform(120, 230)
        for m in range(528):
            rows.append([f"S{s:02d}", m, round(float(base * (end / base) ** (m / 527) * rng.uniform(0.99, 1.01)), 2)])
    return rows


@pytest.mark.parametrize("strength", [5, 10])
def test_a_slip_past_the_max_of_a_two_kind_column_is_flagged(strength):
    rows = tuition()
    i = next(k for k, r in enumerate(rows) if 10000 < r[2] < 11000)
    rows[i][2] *= 10
    r = scan(["name", "type", "in_state_tuition"], rows, fair=False, strength=strength)[1][i]
    assert r["severity"] in ("Low", "Medium", "High") and "in_state_tuition" in r["reason"], r


@pytest.mark.parametrize("strength", [5, 10])
def test_a_slip_past_the_max_of_a_long_price_index_is_flagged(strength):
    rows = price_index()
    i = next(k for k, r in enumerate(rows) if 110 < r[2] < 130)
    rows[i][2] = round(rows[i][2] * 10, 2)
    assert rows[i][2] > 1.5 * max(r[2] for k, r in enumerate(rows) if k != i)
    r = scan(["state", "month", "price_index"], rows, fair=False, strength=strength)[1][i]
    assert r["severity"] in ("Low", "Medium", "High") and "price_index" in r["reason"], r


@pytest.mark.parametrize("shape", ["lognormal", "pareto", "two_kinds"])
def test_an_honest_top_value_is_never_said_to_stand_alone(shape):
    rng = np.random.default_rng(31)
    for seed in range(20):
        rng = np.random.default_rng(100 + seed)
        x = {"lognormal": lambda: np.exp(rng.normal(6, 1.0, 3000)), "pareto": lambda: (rng.pareto(2, 3000) + 1) * 100,
             "two_kinds": lambda: np.array([r[2] for r in tuition(seed)])}[shape]()
        out = scan(["Id", "Amount"], [[f"r{i}", round(float(v), 2)] for i, v in enumerate(x)], fair=False)[1]
        assert not any(ALONE in o["reason"] for o in out), (shape, seed)
