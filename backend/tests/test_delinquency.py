"""The delinquency standard (2026-10-20): on a loan book, every slip is found with the row's own fix where one is known,
no borrower is flagged for who they are, the fairness report names the real gap between groups and calls the rest
even, and the Power BI copy carries exactly the flags the pane shows. Synthetic sheet: delinquency_sheet.py."""
import random

import pytest
from delinquency_sheet import COLS, sheet
from test_powerbi import read, same

from anomaly_hunter.agents import scan_agent
from anomaly_hunter.server import create_app

FLAGGED = ("High", "Medium", "Low")
PROTECTED = ("Age", "Gender", "Region")


@pytest.fixture(scope="module")
def book():
    rows, planted, was = sheet()
    df, out, *_, fair = scan_agent.scan(COLS, rows)
    return rows, planted, was, out, fair


def test_every_slip_in_a_loan_book_is_found_and_no_borrower_is_flagged_for_nothing(book):
    rows, planted, _, out, _ = book
    want = {i: says for kind in planted.values() for i, says in kind.items()}
    assert {i for i, v in enumerate(out) if v["severity"] in FLAGGED} == set(want)
    for i, says in want.items():
        assert says in out[i]["reason"], (i, out[i]["reason"])
    # 30-120 days past due on a delinquent loan is the loan book's news, not a slip
    late = [i for i, r in enumerate(rows) if r[COLS.index("Delinquent")] == "Yes" and i not in want]
    assert len(late) > 50 and not any(out[i]["severity"] for i in late if out[i]["severity"] != "Noted")


def test_a_ratio_is_judged_by_the_rows_own_arithmetic_and_its_slip_gets_the_exact_value_back(book):
    # Loan_Amount = Income x Debt_Ratio: a ratio typed as a percent, an income with an extra zero and a flipped sign
    # are each solved from the other two cells, never a median
    rows, planted, was, out, _ = book
    for i in (17, 41, 66):
        col, before = was[i]
        assert out[i]["likely"][col] == pytest.approx(before, rel=1e-9), (i, col, out[i]["likely"])
    assert "above 100%" in out[41]["reason"]
    ratio = COLS.index("Debt_Ratio")
    assert not any("Debt_Ratio" in v["reason"] for i, v in enumerate(out) if i not in (17, 41, 66)), "honest ratios stay quiet"
    assert all(0 < r[ratio] < 1 for i, r in enumerate(rows) if i != 41)


def test_who_a_borrower_is_never_decides_whether_they_look_unusual():
    # Age, Gender and Region are checked for slips like any column, but never feed the "unusual mix" model: giving
    # every clean borrower other (valid) demographics changes no verdict, even at the strictest level
    rows, planted, _ = sheet()
    fixed = {i for kind in planted.values() for i in kind} | {299}  # 299/300 are the double entry: kept whole
    r, other = random.Random(4), [list(row) for row in rows]
    for i, row in enumerate(other):
        if i not in fixed:
            row[1], row[2], row[3] = r.randint(21, 75), r.choice(["Female", "Male"]), r.choice(["North", "South", "East", "West"])
    for s in (5, 10):
        a, b = scan_agent.scan(COLS, rows, strength=s)[1], scan_agent.scan(COLS, other, strength=s)[1]
        for i in range(len(rows)):
            assert a[i]["severity"] == b[i]["severity"], (s, i, a[i]["reason"], b[i]["reason"])
            if i not in fixed:
                assert a[i]["reason"] == b[i]["reason"], (s, i)
        for v in a:
            assert not any(f"mainly {c}" in v["reason"] for c in PROTECTED), v["reason"]


def test_the_fairness_report_names_the_real_gap_and_calls_the_rest_even(book):
    *_, fair = book
    assert fair["protected"] == {"Age": "demographic", "Gender": "demographic",
                                 "Region": "location (can stand in for race or income)"}
    tests = {(t["column"], t["test"]): t for t in fair["tests"]}
    gap = tests[("Region", "Delinquent Yes rate")]
    assert gap["verdict"] == "gap" and gap["text"].startswith("Region South:"), gap["text"]
    for c in PROTECTED:  # flags never land as a gap on a group; 1% vs 3% of 240 rows is "not enough rows to tell", not "even" (AH-18)
        t = tests[(c, "flag rate")]
        assert t["verdict"] == "even" or t["verdict"] == "unclear" and "not enough rows to tell" in t["text"], t["text"]
    assert tests[("Gender", "Delinquent Yes rate")]["verdict"] == "even" and tests[("Age", "Delinquent Yes rate")]["verdict"] == "even"


def test_one_stray_spelling_of_a_yes_no_outcome_never_switches_its_fairness_test_off():
    # a single "no " among 480 Yes/No answers made the column three labels, and every outcome test silently went
    # away, the South's real 34% vs 8% gap with it (2026-10-20). "no " is the label "No", as the spelling check says
    rows, *_ = sheet()
    assert rows[177][COLS.index("Delinquent")] == "no "
    fair = scan_agent.scan(COLS, rows)[-1]
    assert {t["column"] for t in fair["tests"] if t["test"] == "Delinquent Yes rate"} == set(PROTECTED)


def test_the_power_bi_copy_of_a_loan_book_carries_exactly_the_panes_flags(tmp_path):
    rows, *_ = sheet()
    out = tmp_path / "latest-scan.csv"
    got = create_app(out).test_client().post("/scan", json={"columns": COLS, "rows": rows, "power_bi": True,
                                                             "sheet": "Loans"}).get_json()
    verdicts = got["rows"]
    hits = [i for i, v in enumerate(verdicts) if v["severity"] in FLAGGED]
    flags = read(out.with_name("latest-flags.csv"))[1:]
    assert [int(f[2][0]) for f in flags] == [i + 2 for i in hits]
    for f, i in zip(flags, hits, strict=True):
        assert same(f[3], verdicts[i]["severity"]) and same(f[4], verdicts[i]["bucket"]) and same(f[5], verdicts[i]["reason"])
    full = read(out)[1:]
    assert len(full) == len(rows) and [same(r[-6], v["severity"]) for r, v in zip(full, verdicts, strict=True)] == [True] * len(rows)


def test_a_text_column_of_nothing_but_blanks_never_breaks_the_fairness_report():
    # the fuzzer found it while labels were being read case-blind (2026-10-20): no text at all made it a 500
    for blank in ("", None, "?"):
        out = create_app().test_client().post("/scan", json={"columns": ["Gender", "Notes", "Score"],
                                                              "rows": [["F", blank, 1], ["M", blank, 2]] * 30})
        assert out.status_code == 200, out.get_json()
