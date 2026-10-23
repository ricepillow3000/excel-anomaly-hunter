"""AH-49: the fairness report compares amounts too - a wage, a salary, an income, a score - not only yes/no outcomes. A gap
counts only when one group's median is 1.25x the rest's AND a rank test (Mann-Whitney for two groups, Kruskal-Wallis
then each group against the rest for 3+) holds after the same correction the yes/no tests get; the sentences are the
yes/no ones, quoting medians. Never on an ID, a date, a code or a column worked out from the group. Synthetic sheets."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def fair(cols, rows):
    return scan(cols, rows)[5]


def amounts(f, col):
    return [t for t in f["tests"] if t["column"] == col and t["measure"] == "amount"]


def test_a_wage_gap_between_two_groups_is_named_with_its_medians():
    rng = np.random.default_rng(1)
    rows = [[f"E{i}", ["Female", "Male"][i % 2], round(float(rng.lognormal(np.log(18 if i % 2 == 0 else 24), 0.35)), 2),
             int(rng.integers(8, 18))] for i in range(400)]
    f = fair(["Employee", "Gender", "Hourly wage", "Education"], rows)
    t = amounts(f, "Gender")
    assert len(t) == 1 and t[0]["verdict"] == "gap", t
    assert t[0]["text"].startswith("Gender Male: median Hourly wage ") and " for Female - a real gap, check why" in t[0]["text"], t[0]["text"]
    assert not any("Education" in x["test"] for x in f["tests"] if x["measure"] == "amount"), "years of schooling is no amount"


def test_pure_noise_reads_even_or_no_clear_difference_in_95_of_100_sheets():
    # the bar is 19 of 20; measured on 100 sheets so one unlucky draw of 20 (2 there, 2 in all 100) decides nothing
    calm = 0
    for seed in range(100):
        rng = np.random.default_rng(100 + seed)
        rows = [[f"R{i}", ["Female", "Male"][int(rng.integers(0, 2))], ["North", "South", "East", "West"][int(rng.integers(0, 4))],
                 round(float(rng.lognormal(10.5, 0.6)), 0), int(rng.integers(0, 101))] for i in range(600)]
        f = fair(["Respondent", "Sex", "Region", "Income", "Test score"], rows)
        tests = [t for t in f["tests"] if t["measure"] == "amount"]
        assert tests, f["tests"]
        calm += all(t["verdict"] == "even" for t in tests)
    assert calm >= 95, calm


def test_a_real_but_small_difference_is_never_a_gap():
    rng = np.random.default_rng(3)
    rows = [[f"E{i}", ["Female", "Male"][i % 2], round(float(rng.lognormal(np.log(100000 if i % 2 else 95000), 0.1)), 0)] for i in range(6000)]
    t = amounts(fair(["Employee", "Sex", "Salary"], rows), "Sex")
    assert len(t) == 1 and t[0]["verdict"] == "even" and "close across groups" in t[0]["text"], t


def test_the_group_that_stands_out_among_three_is_named_against_the_rest():
    rng = np.random.default_rng(4)
    races = ["White", "Black", "Asian"]
    rows = [[f"A{i}", races[i % 3], round(float(rng.lognormal(np.log(40000 if i % 3 == 1 else 55000), 0.3)), 0)] for i in range(900)]
    t = amounts(fair(["Applicant", "Race", "Loan amount"], rows), "Race")
    assert len(t) == 1 and t[0]["verdict"] == "gap" and t[0]["text"].startswith("Race Black: median Loan amount "), t
    assert "for the other groups - a real gap, check why" in t[0]["text"], t[0]["text"]


def test_a_code_or_a_column_worked_out_from_the_group_is_never_compared():
    # a 1-5 score is a code, a 3-step pay scale a lookup; a country's average income joined onto each person is the
    # country's, the same for everyone in it: comparing it across countries measures nothing that happened to people
    rng = np.random.default_rng(5)
    countries = [f"C{k}" for k in range(10)]
    rows = [[f"P{i}", ["Female", "Male"][i % 2], countries[i % 10], ["Prof", "AssocProf", "AsstProf"][i % 3],
             [120000, 90000, 70000][i % 3], int(rng.integers(1, 6)), 20000 + 3000 * (i % 10)] for i in range(600)]
    f = fair(["Person", "Sex", "Country", "Rank", "Rank pay scale", "Score", "Country average income"], rows)
    said = [(t["column"], t["test"]) for t in f["tests"] if t["measure"] == "amount"]
    assert ("Country", "median Country average income") not in said and not any("Score" in x or "pay scale" in x for _, x in said), said


def test_groups_under_20_rows_are_left_out_and_named():
    rng = np.random.default_rng(6)
    rows = [[f"E{i}", ["Female", "Male"][i % 2], round(float(rng.lognormal(3, 0.3)), 2)] for i in range(400)]
    for i in range(10):
        rows[i][1] = "Non-binary"
    t = amounts(fair(["Employee", "Gender", "Wage"], rows), "Gender")
    assert len(t) == 1 and "Non-binary" not in t[0]["groups"] and "too few to compare: Non-binary (10 rows)" in t[0]["text"], t


def test_an_amount_the_group_is_cut_from_is_never_compared_across_it():
    # police killings' county_bucket is the county's income quintile: "county_bucket 1: median h_income 29,707 vs 50,280"
    # restated how the buckets were cut. And a loan's term in months is no amount, whatever its name (Loan_Amount_Term)
    rng = np.random.default_rng(7)
    inc = rng.lognormal(10.7, 0.4, 600)
    edges = np.quantile(inc, [0.2, 0.4, 0.6, 0.8])
    rows = [[f"V{i}", ["Female", "Male"][i % 2], int(np.searchsorted(edges, inc[i])) + 1, round(float(inc[i]), 0),
             [360, 180, 300, 240, 120, 84, 60, 36, 480, 350][i % 10]] for i in range(600)]
    f = fair(["Victim", "gender", "county_bucket", "h_income", "Loan_Amount_Term"], rows)
    said = [(t["column"], t["test"]) for t in f["tests"] if t["measure"] == "amount"]
    assert ("gender", "median h_income") in said and not any(c == "county_bucket" for c, _ in said), said
    assert not any("Term" in x for _, x in said), said


def test_an_amount_is_never_compared_across_a_bucket_cut_from_another_amount():
    # police killings' county_bucket is the county's income quintile; each victim's tract income follows it loosely
    rng = np.random.default_rng(8)
    county = rng.lognormal(10.8, 0.3, 600)
    edges = np.quantile(county, [0.2, 0.4, 0.6, 0.8])
    rows = [[f"V{i}", ["Female", "Male"][i % 2], int(np.searchsorted(edges, county[i])) + 1, round(float(county[i] * rng.lognormal(0, 0.3)), 0)]
            for i in range(600)]
    said = [(t["column"], t["test"]) for t in fair(["Victim", "gender", "county_bucket", "h_income"], rows)["tests"] if t["measure"] == "amount"]
    assert ("gender", "median h_income") in said and not any(c == "county_bucket" for c, _ in said), said


@pytest.mark.parametrize("sd", [0.05, None])
def test_the_starkest_gap_two_groups_apart_with_no_overlap_is_named(sd):
    # AH-49 review: the guard against groups cut from the amount read two groups with no overlap (women paid 30,000-
    # 45,000, men 46,000-70,000) as a cut, and the plainest pay gap there is had no amount test at all
    rng = np.random.default_rng(2)
    pay = (lambda i: round(float(rng.lognormal(np.log(18 if i % 2 == 0 else 24), sd)), 2)) if sd else \
        (lambda i: int(rng.integers(30000, 45000) if i % 2 == 0 else rng.integers(46000, 70000)))
    rows = [[f"E{i}", ["Female", "Male"][i % 2], pay(i)] for i in range(400)]
    t = amounts(fair(["Employee", "Sex", "Salary"], rows), "Sex")
    assert len(t) == 1 and t[0]["verdict"] == "gap" and t[0]["text"].startswith("Sex Male: median Salary "), t


def test_an_amount_is_never_compared_across_numbered_groups_cut_from_it_whatever_their_name():
    # a cut with no cut word in its name: "income_group" 1-5, each the next fifth of the incomes
    rng = np.random.default_rng(9)
    inc = rng.lognormal(10.7, 0.4, 600)
    edges = np.quantile(inc, [0.2, 0.4, 0.6, 0.8])
    rows = [[f"V{i}", ["Female", "Male"][i % 2], int(np.searchsorted(edges, inc[i])) + 1, round(float(inc[i]), 0)] for i in range(600)]
    said = [(t["column"], t["test"]) for t in fair(["Victim", "gender", "income_group", "income"], rows)["tests"] if t["measure"] == "amount"]
    assert not any(c == "income_group" for c, _ in said), said
