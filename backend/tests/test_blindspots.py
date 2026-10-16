"""The "two-row" failure (2026-10-14): a 500-row credit sheet with 319 real defects got 2 flags. This synthetic copy has
the same kinds of defect (the real file stays out of the public repo) and the fairness checks from John's blueprint."""
import random

import pytest

from anomaly_hunter.agents import scan_agent
from anomaly_hunter.engine import fairness
from anomaly_hunter.engine.load import load_from_records

COLS = ["Customer_ID", "Age", "Income", "Credit_Utilization", "Employment_Status", "Location", "Notes", "Delinquent_Account"]
LABELS = ["Employed", "Unemployed", "Self-employed", "Retired"]
CITIES = ["Chicago", "Houston", "Phoenix", "New York", "Los Angeles"]


def sheet(n=400, seed=3):
    """Clean rows, then planted defects at known rows -> (rows, {kind: set of row indexes})."""
    r = random.Random(seed)
    rows = [[f"CUST{k:04d}", r.randint(18, 74), r.randint(15000, 200000), round(r.uniform(0.05, 0.97), 4),
             r.choice(LABELS), r.choice(CITIES), "call back" if r.random() < 0.4 else "", r.choice([0, 0, 0, 0, 1])]
            for k in range(n)]
    planted = {"blank Income": set(range(0, 32, 1)),            # 8% blank: a required field, not an optional one
               "utilization over 100%": {40, 41, 42},
               "employed": set(range(50, 110, 2)), "EMP": set(range(51, 111, 2)), "retired": set(range(120, 150))}
    for i in planted["blank Income"]:
        rows[i][2] = ""
    for i, v in zip(sorted(planted["utilization over 100%"]), (1.002, 1.009, 1.026)):
        rows[i][3] = v
    for kind, label in (("employed", "employed"), ("EMP", "EMP")):
        for i in planted[kind]:
            rows[i][4] = label
    for k in range(n):  # every "Retired" is written lowercase, like the real sheet
        if rows[k][4] == "Retired":
            rows[k][4] = "retired"
    planted["retired"] = {k for k in range(n) if rows[k][4] == "retired"}
    return rows, planted


@pytest.fixture(scope="module")
def scanned():
    rows, planted = sheet()
    df, out, *_, fair = scan_agent.scan(COLS, rows)
    return rows, planted, out, fair


def reasons(out, i):
    return out[i]["reason"]


def test_blanks_in_a_mostly_filled_column_are_found(scanned):
    _, planted, out, _ = scanned
    for i in planted["blank Income"]:
        assert out[i]["severity"] == "Medium" and "Blank cell in column Income" in reasons(out, i)


def test_blanks_in_an_optional_column_are_not(scanned):
    rows, _, out, _ = scanned
    assert not any("Blank cell in column Notes" in r["reason"] for r in out)  # 40% filled: optional


def test_a_case_variant_is_flagged_even_when_nearly_as_common(scanned):
    _, planted, out, _ = scanned
    for i in planted["employed"]:
        assert out[i]["severity"] == "Medium" and '"employed" looks like "Employed"' in reasons(out, i)
        assert out[i]["likely"]["Employment_Status"] == "Employed"


def test_an_abbreviation_of_a_label_is_worth_a_check(scanned):
    _, planted, out, _ = scanned
    for i in planted["EMP"]:
        assert out[i]["severity"] == "Low" and '"EMP" looks like a short form of "Employed"' in reasons(out, i)
        assert out[i]["maybe"]["Employment_Status"] == "Employed"  # a guess: confirmed by the user, never auto-fixed
        assert not out[i]["exact"]


def test_a_lowercase_label_among_capitalised_ones_is_worth_a_check(scanned):
    _, planted, out, _ = scanned
    for i in planted["retired"]:
        assert '"retired" is lowercase' in reasons(out, i) and out[i]["maybe"]["Employment_Status"] == "Retired"
        if i not in planted["blank Income"]:  # alone it is only worth a check; with a blank Income too, probably wrong
            assert out[i]["severity"] == "Low"


def test_a_fraction_above_100_percent_is_worth_a_check(scanned):
    _, planted, out, _ = scanned
    for i in planted["utilization over 100%"]:
        assert out[i]["severity"] in ("Low", "Medium") and "above 100%" in reasons(out, i)


def test_every_planted_defect_found_and_no_clean_row_flagged(scanned):
    _, planted, out, _ = scanned
    bad = set().union(*planted.values())
    assert {i for i, r in enumerate(out) if r["severity"] in ("High", "Medium", "Low")} == bad


def test_protected_columns_are_found_by_name():
    assert fairness.protected(dict.fromkeys(["Customer_ID", "Age", "Marital_Status", "ZipCode", "home_city", "Employment_Status",
                                             "Gender", "Date of Birth", "Account_Tenure", "Location"], "text")) == {
        "Age": "demographic", "Marital_Status": "demographic", "ZipCode": "location (can stand in for race or income)",
        "home_city": "location (can stand in for race or income)", "Gender": "demographic", "Date of Birth": "demographic",
        "Location": "location (can stand in for race or income)"}


def test_a_location_word_protects_a_column_only_when_it_can_hold_a_place():
    # MASS Cars93 (blind real tables, 2026-10-16): "MPG.city" is miles per gallon, but "city" made it a protected
    # location, so the fairness report banded MPG into quarters and ran bias tests on it
    r = random.Random(8)
    cols = ["Model", "MPG.city", "City Fuel Economy", "City", "Location", "Zip Code", "ZipCode", "Price"]
    rows = [[f"Car {k}", r.randint(15, 46), round(r.uniform(15, 46), 1), r.choice(CITIES), r.choice(["North", "South"]),
             r.randint(10000, 99999), r.randint(10000, 99999), r.randint(7, 62)] for k in range(80)]
    _, types, _ = load_from_records(cols, rows)
    # a ZIP is a code whatever the loader makes of it: "Zip Code" loads as an ID, "ZipCode" (no break before Code) as a number
    assert (types["MPG.city"], types["City"], types["Zip Code"], types["ZipCode"]) == ("number", "text", "id", "number")
    place = "location (can stand in for race or income)"
    assert fairness.protected(types) == {"City": place, "Location": place, "Zip Code": place, "ZipCode": place}
    fair = scan_agent.scan(cols, rows)[-1]
    assert "MPG.city" not in fair["protected"] and not {"MPG.city", "City Fuel Economy"} & {t["column"] for t in fair["tests"]}


def test_protected_columns_never_make_a_person_unusual():
    """An old customer is not an anomaly: Age is checked for typos/blanks, but the outlier model never sees it."""
    r = random.Random(5)
    rows = [[r.randint(25, 45), r.randint(40000, 60000), round(r.uniform(0.2, 0.4), 3)] for _ in range(300)]
    rows[7][0] = 104  # a centenarian: rare, real
    out = scan_agent.scan(["Age", "Income", "Credit_Utilization"], rows, strength=10)[1]
    assert "Unusual combination" not in out[7]["reason"]


def test_bias_tests_report_each_protected_column_and_stay_quiet_on_noise(scanned):
    *_, fair = scanned
    cols = {t["column"] for t in fair["tests"]}
    assert {"Age", "Location"} <= cols and fair["protected"] == {"Age": "demographic",
                                                                "Location": "location (can stand in for race or income)"}
    assert {t["test"] for t in fair["tests"]} >= {"flag rate", "missing Income", "Delinquent_Account rate"}
    assert all(t["verdict"] == "even" for t in fair["tests"]), [t for t in fair["tests"] if t["verdict"] != "even"]


def test_a_real_subgroup_gap_is_reported():
    """Income left blank mostly for one city: a model trained on this sheet would learn that city's people less well."""
    rows, _ = sheet()
    for i, row in enumerate(rows):
        row[2] = "" if row[5] == "Phoenix" and i % 3 else (row[2] or 50000)
    df, out, *_, fair = scan_agent.scan(COLS, rows)
    gap = [t for t in fair["tests"] if t["column"] == "Location" and t["test"] == "missing Income"]
    assert gap and gap[0]["verdict"] == "gap" and "Phoenix" in gap[0]["text"]


def test_a_measure_only_the_dropped_small_groups_have_never_crashes_the_scan():
    # MASS Cars93 (blind real tables, 2026-10-16): every missing value sat in groups under 20 rows, so once they were
    # dropped the "missing" column was all zeros and the chi-square test raised - every scan of the sheet was a 500
    rows = [["F", 30 + k % 9, "ok"] for k in range(40)] + [["M", 31 + k % 9, "ok"] for k in range(40)] + [["X", 33, ""] for _ in range(6)]
    df, out, *_, fair = scan_agent.scan(["Gender", "Score", "Notes"], rows)
    assert len(out) == 86 and not [t for t in fair["tests"] if t["test"] == "missing Notes"]


def test_fairness_needs_no_protected_column():
    df, types, _ = load_from_records(["Units", "Price"], [[k, 9.99] for k in range(1, 60)])
    fair = fairness.report(df, types, [{"severity": None}] * len(df))
    assert fair == {"protected": {}, "tests": []}
