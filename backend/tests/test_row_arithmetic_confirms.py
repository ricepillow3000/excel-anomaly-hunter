"""AH-74 (chaos audit, 2026-10-30): a 55-row HR sheet's one honest top earner, AnnualSalary 1150000 + Bonus 400000 =
TotalComp 1550000, was Medium "Flagged by 1 of 2" with "Bonus ... (likely 4000)": the pane offered to write 4000 over a
real bonus, a fix that would break the row's own sum. A value in a cell of a rule that holds on its row is confirmed by
that row: any change to one cell would break the rule, so it gets no fix and no vote, only a "worth a check" (Low).
A planted slip breaks its row's rule and keeps its vote and its fix. Synthetic sheets only, shaped like that one."""
import numpy as np
import pytest

from anomaly_hunter.server import create_app
from anomaly_hunter.powerbi import suggested_fix

app = create_app().test_client()


def run(cols, rows, strength):
    """As the pane does it (and score.py): one scan for the limits, one with them."""
    post = lambda lim: app.post("/scan", json={"columns": cols, "rows": rows, "limits": lim, "order_by": None,
                                               "strength": strength}).get_json()
    return post({k: list(v) for k, v in post(None)["suggested_limits"].items()})


def hr(seed=74):
    g = np.random.default_rng(seed)
    rows = []
    for i in range(55):
        pay, bonus = float(np.round(g.uniform(40000, 150000), -3)), float(np.round(g.uniform(1500, 9000), -2))
        rows.append([f"E{i:03d}", ["Sales", "Ops", "IT", "Finance"][i % 4], pay, bonus, pay + bonus])
    rows[10][2:] = [1150000.0, 400000.0, 1550000.0]  # the CFO: real, and the row adds up
    rows[30][3] = 60000.0  # a planted x10 in a bonus of 6000: TotalComp no longer adds up
    rows[30][4] = rows[30][2] + 6000
    return ["EmployeeID", "Department", "AnnualSalary", "Bonus", "TotalComp"], rows, 10, 30


def orders(seed=75):
    g = np.random.default_rng(seed)
    rows = []
    for i in range(60):
        qty, price = int(g.integers(1, 21)), float(np.round(g.uniform(5, 200), 2))
        rows.append([f"O{i:04d}", qty, price, round(qty * price, 2)])
    rows[12][1:] = [500, 180.0, 90000.0]  # a real bulk order: Qty, Unit Price and Line Total all agree
    rows[40][2] = round(rows[40][2] * 100, 2)  # a planted x100 in a price
    return ["OrderID", "Qty", "Unit Price", "Line Total"], rows, 12, 40


@pytest.mark.parametrize("strength", [5, 10])
@pytest.mark.parametrize("sheet, col, rule", [(hr, "AnnualSalary", "TotalComp = AnnualSalary + Bonus"),
                                               (orders, "Qty", "Line Total = Qty × Unit Price")])
def test_an_outlier_its_rows_own_arithmetic_confirms_gets_no_fix_and_no_vote(sheet, col, rule, strength):
    cols, rows, honest, planted = sheet()
    out = run(cols, rows, strength)["rows"]
    r = out[honest]
    assert r["severity"] == "Low", r
    assert "weird limit is" not in r["reason"] and "likely" not in r["reason"] and "maybe" not in r["reason"], r
    assert f"but the row adds up ({rule})" in r["reason"] and r["reason"].startswith(("Flagged by 1 of", col)), r
    assert col in r["cells"], r
    assert r["likely"] == {} and r["maybe"] == {}, r
    assert suggested_fix(cols, rows[honest], r) == "", r
    p = out[planted]
    assert p["severity"] in ("Medium", "High") and "does not add up" in p["reason"], p
    slip = cols[3] if sheet is hr else cols[2]
    assert p["likely"].get(slip) == (6000 if sheet is hr else round(rows[planted][2] / 100, 2)), p
    assert suggested_fix(cols, rows[planted], p), p


def budget(n, head, seed=11):
    """AH-150: a total the header does not name. Least squares needs 20 rows a column (80 here) and _totals read only a
    header word, so at 60 rows a Budget off by 100 was missed and, at 60 and 100, a real Travel of -123 whose row adds up
    got a Medium "likely 123" card that would break the row's own sum."""
    g = np.random.default_rng(seed)
    rows = []
    for i in range(n):
        a, b, c = int(g.integers(1000, 5001)), int(g.integers(500, 901)), int(g.integers(50, 301))
        rows.append([["Sales", "Ops", "IT", "HR"][i % 4], a, b, c, a + b + c])
    rows[12][4] += 100  # a planted slip: the total no longer adds up
    rows[25][3] = -rows[25][3]  # a real refund, and the row adds up
    rows[25][4] = rows[25][1] + rows[25][2] + rows[25][3]
    return ["Dept", "Salaries", "Rent", "Travel", head], rows


@pytest.mark.parametrize("n", [60, 100])
@pytest.mark.parametrize("head", ["Total", "Budget", "Field4"])
def test_a_total_the_header_does_not_name_is_found_by_its_arithmetic_and_confirms_its_rows(n, head):
    cols, rows = budget(n, head)
    out = run(cols, rows, 5)["rows"]
    slip = out[12]
    assert slip["severity"] in ("Medium", "High") and f"{head} {rows[12][4]} does not add up" in slip["reason"], slip
    real = out[25]
    assert real["severity"] == "Low" and "likely" not in real["reason"], real
    assert f"but the row adds up ({head} = Salaries + Rent + Travel)" in real["reason"], real
    assert real["likely"] == {} and real["maybe"] == {}, real
    assert suggested_fix(cols, rows[25], real) == "", real
