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
