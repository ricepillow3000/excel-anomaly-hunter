"""The wild-data test (2026-10-14): the UCI Adult census, 48,842 people. Its real defects were all caught, but 1,488
real people were called "probably wrong" - hours worked 1-99 around a usual 40, capital losses in a column that is 96%
zero, survey weights up to 8x the median. This synthetic copy has the same shapes (the real file is not in the repo)."""
import random

import pytest

from anomaly_hunter.agents import scan_agent

COLS = ["age", "workclass", "fnlwgt", "occupation", "sex", "capital-gain", "capital-loss", "hours-per-week", "income"]


def census(n=3000, seed=4):
    r = random.Random(seed)
    rows = []
    for _ in range(n):
        sex = r.choice(["Male", "Male", "Female"])
        age = r.randint(17, 90)
        hours = 40 if r.random() < 0.47 else r.choice([r.randint(1, 39), r.randint(41, 99)])  # heaped at 40, tails to 1 and 99
        gain = 0 if r.random() < 0.92 else round(r.lognormvariate(8.9, 0.9))
        loss = 0 if r.random() < 0.95 else r.choice([r.randint(155, 1200), r.randint(1400, 2600), r.randint(2600, 4356)])
        weight = round(r.lognormvariate(12.0, 0.5))  # long right tail, to ~8x the median
        rich = r.random() < (0.30 if sex == "Male" else 0.11)
        rows.append([age, r.choice(["Private", "Self-emp", "Local-gov"]), weight, r.choice(["Sales", "Tech", "Craft"]), sex,
                     min(gain, 41000), loss, hours, ">50K" if rich else "<=50K"])
    planted = {"?": set(range(0, 150, 3)), "99999": set(range(200, 230)), "slip": {300}}
    for i in planted["?"]:
        rows[i][1] = rows[i][3] = "?"
    for i in planted["99999"]:
        rows[i][5] = 99999
    rows[300][7] = 4000  # 40 hours typed with two extra zeros: a slip stands alone
    return rows, planted


@pytest.fixture(scope="module")
def scanned():
    rows, planted = census()
    df, out, *_, fair = scan_agent.scan(COLS, rows)
    return rows, planted, out, fair


def test_every_defect_found_and_no_real_person_called_wrong(scanned):
    _, planted, out, _ = scanned
    bad = set().union(*planted.values())
    assert {i for i, r in enumerate(out) if r["severity"] in ("High", "Medium")} == bad


def test_long_tails_are_the_columns_own_values(scanned):
    _, planted, out, _ = scanned
    for col in ("hours-per-week", "capital-loss", "fnlwgt"):
        assert not any(f"{col} weird limit" in r["reason"] for i, r in enumerate(out) if i not in planted["slip"]), col


def test_a_slip_still_stands_out(scanned):
    _, _, out, _ = scanned
    assert "hours-per-week weird limit" in out[300]["reason"] and out[300]["likely"]["hours-per-week"] == 40


def test_an_all_nines_top_value_is_a_code(scanned):
    _, planted, out, _ = scanned
    for i in planted["99999"]:
        assert out[i]["severity"] == "Medium" and "capital-gain 99999 looks like a code, not a real value" in out[i]["reason"]


def test_a_real_top_value_is_not_a_code():
    rows = [[k, 100 + k % 900] for k in range(200)] + [[200, 999]]  # 999 is next to 998: a price, not a code
    out = scan_agent.scan(["n", "Price"], rows)[1]
    assert "looks like a code" not in out[200]["reason"]


def test_a_two_label_text_outcome_is_tested_by_group(scanned):
    *_, fair = scanned
    t = next(t for t in fair["tests"] if t["column"] == "sex" and t["test"] == "income >50K rate")
    assert t["verdict"] == "gap" and t["text"].startswith("sex Male:") and "income >50K vs" in t["text"]


def test_a_placeholder_counts_as_missing_and_is_never_a_group(scanned):
    *_, fair = scanned
    assert any(t["test"] == "missing occupation" for t in fair["tests"])
    assert all("?" not in t["groups"] for t in fair["tests"])


def test_a_significant_but_small_difference_is_not_called_normal_variation():
    r = random.Random(1)
    rows = [[s, int(r.random() < (0.10 if s == "F" else 0.12))] for s in ["F", "M"] * 20000]
    out = scan_agent.scan(["Gender", "Churned"], rows)[-1]
    t = next(t for t in out["tests"] if t["test"] == "Churned rate")
    assert t["verdict"] == "even" and "a real difference, but small" in t["text"]


def test_a_return_is_never_flipped_where_returns_recur():
    """Audit finding #1 (Online Retail): 2% of quantities are returns (-1 to -192); "likely 144" for -144 would turn
    a refund into a sale. A minus sign is a likely slip only where negatives are rare (< 1% of the column)."""
    r = random.Random(2)
    rows = [[f"i{k}", -r.randint(1, 12) if k % 50 == 0 else r.choice([1, 2, 3, 6, 12, 24])] for k in range(3000)]
    for k, v in zip(range(25, 3000, 600), (-144, -192, -320, -223, -177)):  # a few big returns, each alone
        rows[k][1] = v
    out = scan_agent.scan(["Invoice", "Quantity"], rows)[1]
    assert not any("Quantity" in (o.get("likely") or {}) for o in out)
