"""AH-75 (chaos audit, 2026-10-30): a 55-row HR sheet whose EmployeeID ("000101"...) and PostalCode ("02134", "07102"...)
the pane sent as typed text. One EmployeeID was "123" and one PostalCode "2134", leading zeros lost: neither was flagged,
and the fairness report named PostalCode groups "2134" and "7102", values no cell holds. Synthetic sheets only."""
import numpy as np
import pytest

from anomaly_hunter.engine.load import load_from_records
from anomaly_hunter.server import create_app

APP = create_app().test_client()
ZIPS = ["02134", "07102", "78701", "98101", "60601"]


def scan(cols, rows, strength=5):
    r = APP.post("/scan", json={"columns": cols, "rows": rows, "strength": strength})
    assert r.status_code == 200
    return r.get_json()


def hr(n=55):
    rng = np.random.default_rng(3)
    cols = ["EmployeeID", "Name", "Gender", "Department", "PostalCode", "Salary", "HireDate"]
    rows = [[f"{101 + i:06d}", f"Person {i}", ["Female", "Male"][i % 2], ["Sales", "Ops", "IT"][i % 3], ZIPS[i % 5],
             int(50000 + rng.integers(0, 20000)), f"20{15 + i % 9}-{1 + i % 12:02d}-{1 + i % 27:02d}"] for i in range(n)]
    return cols, rows


@pytest.mark.parametrize("strength", [5, 10])
def test_a_code_that_lost_its_leading_zeros_is_flagged_and_quoted_as_typed(strength):
    cols, rows = hr()
    rows[10][0], rows[20][4] = "123", "2134"
    out = scan(cols, rows, strength)
    got = out["rows"]
    assert 'EmployeeID "123" is 3 digits where the column writes 6: did it lose its leading zeros?' in got[10]["reason"]
    assert 'PostalCode "2134" is 4 digits where the column writes 5: did it lose its leading zero?' in got[20]["reason"]
    for i, col in ((10, "EmployeeID"), (20, "PostalCode")):
        assert got[i]["severity"] == "Medium" and got[i]["bucket"] == "Irregularities" and col in got[i]["cells"]
        # flag only: padding is a guess about the source, and a card never writes into an ID column
        assert col not in got[i].get("likely", {}) and col not in got[i].get("maybe", {}) and col not in got[i].get("exact", {})
    # no other row is about either code column, and a code column has no limits: it is no quantity
    assert not [i for i, r in enumerate(got) if i not in (10, 20) and {"EmployeeID", "PostalCode"} & set(r.get("cells", []))]
    assert "EmployeeID" not in out["suggested_limits"] and "PostalCode" not in out["suggested_limits"]
    # every value a reason or the report quotes is one a cell holds: "07102", never "7102"
    said = " ".join(r["reason"] for r in got) + " ".join(t["text"] for t in out["fairness"]["tests"])
    assert "7102" not in said.replace("07102", "") and "000101" not in said.replace('"000101"', "")


def test_digit_codes_are_never_called_misspellings_of_each_other():
    # a branch code of digits: "02143" beside 40 "02134" is two digits swapped, a different branch, never a misspelling
    cols = ["Branch", "Region", "Amount"]
    rows = [["02134" if i % 4 else "01720", ["North", "South"][i % 2], 100 + i % 9] for i in range(60)]
    rows[7][0], rows[13][0], rows[29][0] = "02143", "02135", "021134"
    for strength in (5, 10):
        got = scan(cols, rows, strength)["rows"]
        assert not [r for r in got if "misspelling" in r["reason"] or "short form" in r["reason"] or r.get("maybe", {}).get("Branch")]
        assert not [r for r in got if r.get("likely", {}).get("Branch") or r.get("exact", {}).get("Branch")]
    df, types, _ = load_from_records(cols, rows)
    assert types["Branch"] == "text" and list(df["Branch"][:3]) == ["01720", "02134", "02134"]


def test_fairness_names_zip_groups_as_typed():
    out = scan(*hr())
    zips = next(t for t in out["fairness"]["tests"] if t["column"] == "PostalCode")
    assert "02134" in zips["text"] and "07102" in zips["text"]
    assert not [g for g in ("2134", "7102") if f"{g} (" in zips["text"].replace(f"0{g} (", "")]
    assert set(zips["groups"]) <= set(ZIPS)


@pytest.mark.parametrize("strength", [5, 10])
def test_honest_zero_padded_codes_flag_nothing_new(strength):
    got = scan(*hr(), strength)["rows"]
    assert not [r for r in got if {"EmployeeID", "PostalCode"} & set(r.get("cells", []))]
    if strength == 5:
        assert not [r for r in got if r["severity"]]


def test_codes_excel_already_stripped_load_as_numbers_as_before():
    # number-formatted cells reach the pane as numbers: their zeros were gone before we saw them, nothing to compare
    cols, rows = hr()
    for r in rows:
        r[0], r[4] = int(r[0]), int(r[4])
    _, types, _ = load_from_records(cols, rows)
    assert types["EmployeeID"] == "id" and types["PostalCode"] == "number"
    got = scan(cols, rows)["rows"]
    assert not [r for r in got if "leading zero" in r["reason"]]


def test_a_number_column_with_a_stray_padded_value_stays_a_number():
    # one "007" among quantities is not a code system, and a month typed "01"-"12" keeps what its name allows
    cols = ["Item", "Qty", "Month"]
    rows = [[f"item {i}", str(1 + i % 40), f"{1 + i % 12:02d}"] for i in range(60)]
    rows[5][1], rows[9][2] = "007", "13"
    _, types, _ = load_from_records(cols, rows)
    assert types["Qty"] == "number" and types["Month"] == "number"
    got = scan(cols, rows)["rows"]
    assert "Month 13 is outside what" in got[9]["reason"]
