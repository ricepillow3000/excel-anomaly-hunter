"""AH-62 (blind round 38): a negative code a column writes 5+ times is its "no value". A survey export wrote -1 for a
skipped answer (5 to 5,529 times in 110 columns): 972 Medium rows and 267 "-1 (likely 1)" cards. A turbine table wrote
-9999 for an unknown hub height 1,375 times: 1,368 Medium rows, and limits of -5,200 to 5,400 that let a hub height of 800
among 60-115 through. And a sign flip is "likely" only for the column's one negative: 6 real disinvestments in one column
each got a card. Synthetic sheets only, shaped like those tables."""
import numpy as np

from anomaly_hunter.agents.scan_agent import scan

SURE = ("Medium", "High")


def likely_on(out, col):
    return [(i, r["likely"][col]) for i, r in enumerate(out) if col in (r.get("likely") or {})]


def survey(n=600, codes=50, seed=1):
    # a poll export: answers 1-4, -1 where the respondent skipped the question
    rng = np.random.default_rng(seed)
    rows = [[f"R{i}", int(rng.integers(1, 5)), int(rng.integers(1, 5)), int(rng.integers(18, 90))] for i in range(n)]
    coded = sorted(rng.choice(n, codes, replace=False).tolist())
    for i in coded:
        rows[i][1] = -1
    return ["RespId", "Q2_1", "Q3_1", "ppage"], rows, coded


def test_a_minus_1_a_survey_writes_50_times_is_its_code_for_no_answer_never_a_slip_or_a_sign_flip():
    cols, rows, coded = survey()
    out = scan(cols, rows, fair=False)[1]
    assert [i for i in coded if out[i]["severity"] in SURE] == [], [out[i]["reason"] for i in coded if out[i]["severity"] in SURE][:3]
    assert likely_on(out, "Q2_1") == [] and not any("Q2_1" in (r.get("maybe") or {}) for r in out)
    said = [r["reason"] for r in out if "the column's code for no value" in r["reason"]]
    assert said == ["Q2_1 -1 is written 50 times: the column's code for no value"], said


def turbines(n=20000, codes=1400, seed=2):
    rng = np.random.default_rng(seed)
    rows = [[3000000 + i, int(rng.choice([60, 65, 70, 78, 80, 84, 90, 95, 100, 105, 115])), round(float(rng.uniform(47, 150)), 1)] for i in range(n)]
    coded = sorted(rng.choice(n, codes, replace=False).tolist())
    for i in coded:
        rows[i][1] = -9999
    slip = next(i for i in range(n // 2, n) if i not in coded)
    rows[slip][1] = rows[slip][1] * 10  # 80 typed 800
    return ["case_id", "t_hh", "t_rd"], rows, coded, slip


def test_a_minus_9999_written_1400_times_is_no_value_and_the_hub_height_typed_x10_is_found_again():
    cols, rows, coded, slip = turbines()
    out = scan(cols, rows, fair=False)[1]
    assert [i for i in coded if out[i]["severity"] in SURE] == [], [out[i]["reason"] for i in coded if out[i]["severity"] in SURE][:3]
    assert not [i for i, _ in likely_on(out, "t_hh") if i in coded]
    assert out[slip]["severity"] in SURE and "t_hh" in out[slip]["reason"], out[slip]
    assert sum("t_hh -9999 is written 1400 times: the column's code for no value" in r["reason"] for r in out) == 1


def test_a_lone_minus_1_among_positives_is_still_flagged():
    cols, rows, _ = survey(codes=0)
    rows[300][1] = -1
    out = scan(cols, rows, fair=False)[1]
    assert out[300]["severity"] in SURE and "Q2_1" in out[300]["reason"], out[300]
    assert not any("code for no value" in r["reason"] for r in out)


def test_a_minus_1_on_a_minus_1_0_1_scale_is_a_value_not_a_code():
    rng = np.random.default_rng(3)
    rows = [[f"R{i}", int(rng.choice([-1, 0, 1])), int(rng.integers(1, 100))] for i in range(600)]
    out = scan(["RespId", "Sentiment", "Score"], rows, fair=False)[1]
    assert not any("code for no value" in r["reason"] for r in out)
    assert [i for i, r in enumerate(out) if "Sentiment" in r["reason"]] == []


def test_a_minus_999_beside_real_values_almost_as_deep_is_no_code():
    rng = np.random.default_rng(4)
    rows = [[f"W{i}", -float(rng.integers(1, 800))] for i in range(400)]
    for i in range(0, 400, 50):
        rows[i][1] = -999.0
    out = scan(["Well", "Depth"], rows, fair=False)[1]
    assert not any("code for no value" in r["reason"] for r in out)


def test_a_sign_flip_is_likely_only_for_the_columns_one_negative():
    # BEA's gross investment: 6 real negatives among thousands of positives, each "likely" the positive
    rng = np.random.default_rng(5)
    rows = [[f"C{i % 40}", 1947 + i % 71, round(float(rng.lognormal(7, 1.5)), 3)] for i in range(6000)]
    for i, v in zip((2840, 2851, 3692, 3703, 3905, 3916), (-175.914, -59.678, -175.914, -59.678, -194.0, -134.0)):
        rows[i][2] = v
    out = scan(["category", "year", "gross_inv"], rows, fair=False)[1]
    assert likely_on(out, "gross_inv") == [], likely_on(out, "gross_inv")
