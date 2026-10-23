"""AH-38 (blind round 23, now a tuning set): "a lone decimal in a column of whole numbers" said "Weight 72.5 is not a
whole number - every other weight is" of 69 honest half-kilo weights among 15,553 athletes: the rule allowed 0.5% of a
column, so a big column's own half-kilos read as slips, and the sentence was untrue for each. A slip is lone: at most 2
decimals in the column, and the sentence says how many. Synthetic only, shaped like that table."""
import numpy as np

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
