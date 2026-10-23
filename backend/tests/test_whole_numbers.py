"""AH-38 (blind round 23, now a tuning set): "a lone decimal in a column of whole numbers" said "Weight 72.5 is not a
whole number - every other weight is" of 69 honest half-kilo weights among 15,553 athletes: the rule allowed 0.5% of a
column, so a big column's own half-kilos read as slips, and the sentence was untrue for each. A slip is lone: at most 2
decimals in the column, and the sentence says how many. Synthetic only, shaped like that table."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def weights(n=15000, halves=69, seed=38):
    rng = np.random.default_rng(seed)
    w = np.round(rng.normal(72, 12, n)).clip(35, 160)
    w[rng.choice(n, halves, replace=False)] += 0.5
    return [[f"A{i:05d}", float(v) if v != int(v) else int(v)] for i, v in enumerate(w)]


def test_many_honest_half_kilos_are_never_called_a_lone_decimal():
    out = scan(["id", "weight"], weights(), fair=False)[1]
    said = [o["reason"] for o in out if "is not a whole number" in o["reason"]]
    assert not said, said[:3]


def test_two_decimals_in_a_big_column_of_whole_numbers_are_each_worth_a_check_and_say_so():
    rows = weights(halves=0)
    rows[100][1], rows[9000][1] = 73.4, 81.2
    out = scan(["id", "weight"], rows, fair=False)[1]
    assert out[100]["reason"] == "weight 73.4 is not a whole number - only 2 weight values are not", out[100]
    assert out[9000]["severity"] == "Low" and "81.2 is not a whole number - only 2 weight values are not" in out[9000]["reason"]


def study_days(n, slips, halves=0, seed=1):
    rng = np.random.default_rng(seed)
    d = rng.integers(1, 120, n).astype(float)
    pos = rng.choice(n, slips + halves, replace=False)
    for i in pos[:slips]:  # 73 typed 7.3: the decimal point slipped in
        v = int(rng.integers(11, 99))
        d[i] = (v if v % 10 else v + 1) / 10
    for i in pos[slips:]:
        d[i] += 0.5
    return [[f"S{i:04d}", float(v) if v != int(v) else int(v)] for i, v in enumerate(d)], sorted(int(i) for i in pos[:slips])


@pytest.mark.parametrize("n, slips", [(300, 3), (1000, 3), (1000, 5), (2000, 8)])
def test_a_few_decimal_slips_are_each_found_on_a_small_or_a_big_sheet(n, slips):
    # AH-38 review: a fixed 2 lost 3 slips on 1,000 rows and 8 on 2,000 that main found; a slip's part is its own
    rows, bad = study_days(n, slips)
    out = scan(["Subject", "Study day"], rows, fair=False)[1]
    assert [i for i, o in enumerate(out) if "is not a whole number" in o["reason"]] == bad


def test_beside_a_columns_own_halves_a_slip_is_still_found_and_said_truly():
    rows, bad = study_days(500, 2, halves=4)
    out = scan(["Subject", "Study day"], rows, fair=False)[1]
    said = [i for i, o in enumerate(out) if "is not a whole number" in o["reason"]]
    # two slips: each sentence counts them, never "the other values are whole or end in .5" (the other slip is neither)
    assert said == bad and all(out[i]["reason"].endswith("only 2 Study day values are neither whole nor end in .5") for i in bad), out[bad[0]]
    rows, bad = study_days(500, 1, halves=4)
    out = scan(["Subject", "Study day"], rows, fair=False)[1]
    assert out[bad[0]]["reason"].endswith("Study day values are whole or end in .5") and "the other" in out[bad[0]]["reason"], out[bad[0]]


def test_a_column_of_many_decimal_parts_is_never_a_whole_number_column():
    rng = np.random.default_rng(4)
    fares = [round(float(v)) if k % 40 else round(float(v), 2) for k, v in enumerate(rng.uniform(5, 60, 4000))]
    out = scan(["Trip", "Fare"], [[f"T{i}", v] for i, v in enumerate(fares)], fair=False)[1]
    assert not any("is not a whole number" in o["reason"] for o in out)
