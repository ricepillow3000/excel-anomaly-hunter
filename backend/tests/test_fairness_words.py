"""AH-18: the fairness report says only what its numbers show. Each case is a synthetic sheet from the AH-17 bias hunt
(known truth, planted by seed): too few rows is never "even", a column is an outcome only when it is one, the public
context matches the outcome and its direction, the group that stands out is named against the rest, a doubled small
rate is a real gap, small groups left out are named, and a race time or an order state is not a person."""
import random

import numpy as np
import pandas as pd
import pytest
from scipy.stats import chi2_contingency

from anomaly_hunter.agents import scan_agent
from anomaly_hunter.engine import fairness
from anomaly_hunter.engine.load import load_from_records


def people(n, rates, seed, col="Sex", outcome="Approved", groups=("F", "M"), label=None):
    """n people, group = groups[i % len], outcome 0/1 with rates[group] (label: (yes, no) text instead of 1/0)."""
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        g = groups[i % len(groups)]
        hit = rng.random() < rates[g]
        rows.append([f"P{i:05d}", g, round(float(rng.normal(500, 80))), (label[0] if hit else label[1]) if label else int(hit)])
    return ["Person ID", col, "Score", outcome], rows


def report(cols, rows):
    return scan_agent.scan(cols, rows)[-1]


def test_a_gap_too_few_rows_can_prove_is_not_enough_rows_to_tell_never_even():
    # AH-17 W1: 80 people, 15% vs 40% planted (22% vs 50% drawn) was "even across groups (22% to 50%, within normal variation)"
    cols, rows = people(80, {"F": 0.15, "M": 0.4}, 80)
    t = next(t for t in report(cols, rows)["tests"] if t["test"] == "Approved rate")
    assert t["verdict"] == "unclear" and "even" not in t["text"] and "not enough rows to tell" in t["text"], t["text"]
    drawn = sorted(np.mean([r[3] for r in rows if r[1] == g]) for g in "FM")
    assert f"({drawn[0]:.0%} to {drawn[1]:.0%})" in t["text"] and drawn[1] >= 1.25 * drawn[0] + 0.05  # the sheet does show a gap
    # a difference that is small as well as unproven is still within normal variation
    t = next(t for t in report(*people(500, {"F": 0.3, "M": 0.3}, 7))["tests"] if t["test"] == "Approved rate")
    assert t["verdict"] == "even" and "within normal variation" in t["text"]


def test_every_test_says_which_kind_of_check_it_is():
    # the pane names only the checks that ran (frontend/selfcheck.js): it needs each test's kind
    cols, rows = people(500, {"F": 0.3, "M": 0.3}, 7)
    rows[3][2] = 5000.0  # a x10 slip, so rows are flagged
    for i in range(0, 60, 2):
        rows[i][2] = ""  # blanks
    out = report(cols, rows)
    assert {t["test"]: t["measure"] for t in out["tests"]} == {"flag rate": "flag", "missing Score": "missing", "Approved rate": "outcome"}


@pytest.mark.parametrize("yes, no", [("Approved", "Denied"), ("Yes", "No"), ("Pass", "Fail"), (">50K", "<=50K"), ("Hired", "Not hired"),
                                     ("True", "False"), ("Defaulted", "Repaid")])
def test_a_two_label_column_of_opposites_is_an_outcome(yes, no):
    cols, rows = people(600, {"F": 0.3, "M": 0.3}, 3, outcome="Result", label=(yes, no))
    assert any(t["test"].startswith("Result ") and t["measure"] == "outcome" for t in report(cols, rows)["tests"])


@pytest.mark.parametrize("col, labels", [("Shift", ("Night", "Day")), ("Dept", ("A", "B")), ("Product Type", ("Hardware", "Software")),
                                         ("Hand", ("Left", "Right"))])
def test_a_two_label_column_that_is_not_an_outcome_is_not_tested_as_one(col, labels):
    # AH-17 W3: "Shift" Day/Night by Gender was "a real gap, check why" with a census sentence about earning over 50K
    cols, rows = people(1000, {"F": 0.6, "M": 0.27}, 4, col="Gender", outcome=col, label=labels)
    tests = report(cols, rows)["tests"]
    assert not any(t["test"].startswith(col + " ") for t in tests), [t["text"] for t in tests]


def test_public_context_is_shown_only_for_an_income_gap_in_the_measured_direction():
    # the census sentence measures who earns over 50K (men more than women); it fits that outcome, that way round only
    cols, rows = people(1000, {"Male": 0.45, "Female": 0.25}, 10, col="Gender", outcome="Loan Status", groups=("Female", "Male"),
                        label=("Denied", "Approved"))
    t = next(t for t in report(cols, rows)["tests"] if t["test"] == "Loan Status Denied rate")
    assert t["verdict"] == "gap" and "context" not in t, t.get("context")  # a loan, not earnings
    cols, rows = people(1000, {"Male": 0.4, "Female": 0.2}, 11, col="Sex", outcome="Income", groups=("Female", "Male"), label=(">50K", "<=50K"))
    t = next(t for t in report(cols, rows)["tests"] if t["test"] == "Income >50K rate")
    assert t["verdict"] == "gap" and "30.4% of men" in t["context"]  # earnings, men higher: as measured
    cols, rows = people(1000, {"Male": 0.2, "Female": 0.4}, 12, col="Sex", outcome="Income", groups=("Female", "Male"), label=(">50K", "<=50K"))
    t = next(t for t in report(cols, rows)["tests"] if t["test"] == "Income >50K rate")
    assert t["verdict"] == "gap" and "context" not in t, t.get("context")  # the other way round: the census says nothing about it


def test_with_many_groups_the_group_that_stands_out_is_named_against_the_rest_with_its_own_p_value():
    # AH-17: 40 countries, C07 at 60% and the rest at 30% read "Country C07: 56% vs 23% for C03" - C03 is an ordinary
    # country that happened to land lowest, and the p-value tested all 40 at once
    countries = [f"C{k:02d}" for k in range(40)]
    cols, rows = people(8000, {**{c: 0.3 for c in countries}, "C07": 0.6}, 12, col="Country", groups=countries)
    t = next(t for t in report(cols, rows)["tests"] if t["test"] == "Approved rate")
    assert t["verdict"] == "gap" and t["text"].startswith("Country C07:") and "for the other groups" in t["text"], t["text"]
    assert not any(f"for C{k:02d}" in t["text"] for k in range(40))
    g = pd.Series([r[1] for r in rows]) == "C07"
    y = pd.Series([r[3] for r in rows]) == 1
    assert t["p_group"] == pytest.approx(chi2_contingency(pd.crosstab(g, y))[1], rel=1e-9)
    rest = y[~g].mean()
    assert f"vs {rest:.0%} for the other groups" in t["text"]


def test_a_doubled_small_rate_is_a_real_gap_not_a_small_difference():
    # AH-17 W2: 2% vs 4% defaults on 20,000 people (p ~ 0) read "close across groups (2% to 4% - a real difference, but small)"
    cols, rows = people(20000, {"F": 0.02, "M": 0.04}, 3, outcome="Defaulted")
    t = next(t for t in report(cols, rows)["tests"] if t["test"] == "Defaulted rate")
    assert t["verdict"] == "gap" and t["text"].startswith("Sex M:"), t["text"]


def test_small_groups_left_out_are_named():
    # AH-17: 15 rows of X, all approved, were dropped with no word; the report read as if every group was compared
    rng = np.random.default_rng(8)
    rows = [[f"P{i}", "X" if i < 15 else ("F" if i % 2 else "M"), round(float(rng.normal(50000, 8000))), int(i < 15 or rng.random() < 0.3)]
            for i in range(600)]
    t = next(t for t in report(["Person ID", "Sex", "Income", "Approved"], rows)["tests"] if t["test"] == "Approved rate")
    assert "X (15 rows)" in t["text"] and "too few to compare" in t["text"], t["text"]
    # every group too small: said, not skipped, and no verdict either way
    rows = [[f"P{i}", "F" if i % 2 else "M", 50000 + i, int(i % 3 == 0)] for i in range(30)]
    t = next(t for t in report(["Person ID", "Sex", "Income", "Approved"], rows)["tests"] if t["test"] == "Approved rate")
    assert t["verdict"] == "unclear" and "F (15 rows), M (15 rows)" in t["text"], t["text"]


def test_a_race_time_or_an_order_state_is_not_read_as_a_person():
    rng = random.Random(4)
    df, types, _ = load_from_records(["Runner", "Race Time", "Club", "Finished"],
                                     [[i, round(rng.gauss(60, 8), 1), "AB"[i % 2], int(rng.random() < 0.9)] for i in range(300)])
    assert fairness.report(df, types, [{"severity": None}] * len(df))["protected"] == {}
    df, types, _ = load_from_records(["Order", "State", "Amount"], [[i, ["Pending", "Shipped", "Returned"][i % 3], 50 + i % 9] for i in range(300)])
    assert fairness.report(df, types, [{"severity": None}] * len(df))["protected"] == {}
    # a person's race and a US state still are
    df, types, _ = load_from_records(["ID", "Race", "Applicant race", "State", "Score"],
                                     [[i, "AB"[i % 2], "CD"[i % 2], ["Texas", "Ohio", "Utah"][i % 3], i % 7] for i in range(300)])
    assert set(fairness.report(df, types, [{"severity": None}] * len(df))["protected"]) == {"Race", "Applicant race", "State"}


def test_the_excel_report_says_not_enough_rows_to_tell_never_even_for_an_unclear_test(tmp_path):
    from openpyxl import load_workbook

    from anomaly_hunter.engine.report import write_report
    cols, rows = people(80, {"F": 0.15, "M": 0.4}, 80)
    small = [[f"Q{i}", "X", 500.0, 1] for i in range(15)]  # a group too small to compare: no p-value at all
    df, out, *_, fair = scan_agent.scan(cols, rows + small)
    write_report(df, out, {}, tmp_path / "r.xlsx", None, [], fair)
    lines = [[c.value for c in r] for r in load_workbook(tmp_path / "r.xlsx")["Fairness"].iter_rows()]
    unclear = [r for r in lines if r[1] == "Sex: Approved rate"]
    assert unclear and unclear[0][0] == "Not enough rows to tell", unclear
