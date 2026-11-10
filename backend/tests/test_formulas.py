"""AH-152: a scan never read formulas, so a Total typed over its =Qty*Price, or one row's =C31*D32 among =C2*D2 ...
=C40*D40, went unseen whenever the numbers happened to agree. The pane now sends each cell's R1C1 formula (Excel's
own "inconsistent formula" check is the model): where 80%+ of a column's filled cells (5+) share one formula, a typed
value or another formula in it is flagged. Synthetic sheets only."""
import pytest

from anomaly_hunter.server import create_app

APP = create_app().test_client()
COLS = ["Item", "Qty", "Price", "Total"]
SAME = "=RC[-2]*RC[-1]"  # Total = Qty x Price, the same text on every row in R1C1


def sheet(n=40):
    rows = [[f"Item {i}", 2 + i % 7, 5 + i % 4, (2 + i % 7) * (5 + i % 4)] for i in range(n)]
    return rows, [[None, None, None, SAME] for _ in rows]


def scan(rows, formulas, strength=5):
    r = APP.post("/scan", json={"columns": COLS, "rows": rows, "strength": strength, "formulas": formulas})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["rows"]


def flagged(out):
    return {i: r["reason"] for i, r in enumerate(out) if r["severity"]}


def test_a_typed_number_among_a_columns_formulas_is_flagged_on_its_own_cell():
    rows, formulas = sheet()
    formulas[29][3] = None  # typed over: 250 happens to equal Qty x Price today, so the values alone say nothing
    rows[29][3] = rows[29][1] * rows[29][2]
    out = scan(rows, formulas)
    assert flagged(out) == {29: f"Total {rows[29][3]} is a typed number where the column's other rows use a formula"}
    assert out[29]["severity"] == "Medium" and out[29]["cells"] == ["Total"]
    assert out[29]["formula"] == {"Total": SAME}, "the card's fix: the column's own formula, known, never invented"


def test_a_reference_one_row_off_is_flagged_as_a_different_formula():
    rows, formulas = sheet()
    formulas[29][3] = "=RC[-2]*R[1]C[-1]"  # =B31*C32 among =B2*C2 ... (one row off)
    rows[29][3] = rows[29][1] * rows[30][2]
    out = scan(rows, formulas)
    assert "Total uses a different formula from the other rows of its column" in out[29]["reason"]
    # the product check also says it does not add up (Qty x the next row's Price), naming its three cells
    assert out[29]["severity"] in ("Medium", "High") and "Total" in out[29]["cells"]
    assert out[29]["formula"] == {"Total": SAME}
    assert set(flagged(out)) == {29}


def test_a_totals_row_with_its_own_sum_is_left_out():
    rows, formulas = sheet()
    rows.append(["Total", None, None, sum(r[3] for r in rows)])
    formulas.append([None, None, None, "=SUM(R[-40]C:R[-1]C)"])
    out = scan(rows, formulas)
    assert flagged(out) == {} and out[40]["reason"] == "Totals/summary row - not checked"


def test_a_column_whose_formulas_are_mixed_under_80_percent_says_nothing():
    rows, formulas = sheet()
    for i in range(0, 40, 3):  # 14 of 40 another formula: no one formula is the column's own
        formulas[i][3] = "=RC[-1]*RC[-2]"
    assert flagged(scan(rows, formulas)) == {}


def test_a_column_of_all_different_formulas_says_nothing():
    rows, formulas = sheet()
    for i, r in enumerate(formulas):
        r[3] = f"={rows[i][1]}*{rows[i][2]}"  # each row its own constant formula
    formulas[5][3] = None
    assert flagged(scan(rows, formulas)) == {}


def test_too_few_formulas_say_nothing():
    rows, formulas = sheet(6)
    formulas[2][3] = None  # 5 of 6 share one formula: needs 5 and 80%, so this one counts
    assert set(flagged(scan(rows, formulas))) == {2}
    rows, formulas = sheet(5)
    formulas[2][3] = None  # 4 of 5: too few to call a formula the column's own
    assert flagged(scan(rows, formulas)) == {}


def test_no_formulas_sent_is_the_scan_of_today():
    rows, _ = sheet()
    rows[29][3] = 9999  # a value slip: found from the values, the same with or without formulas
    without = APP.post("/scan", json={"columns": COLS, "rows": rows}).get_json()["rows"]
    assert flagged(without) and all(r["formula"] == {} for r in without if r["severity"])
    assert scan(rows, None) == without
    assert scan(rows, [[None] * 4 for _ in rows]) == without


def test_a_formula_as_long_as_excel_allows_is_taken():
    # AH-155: only 8,193 characters was sent, so a cap cut to 8,191 refused Excel's longest formula with every test green
    rows, formulas = sheet()
    formulas[0][3] = "=" + "1" * 8191
    assert len(formulas[0][3]) == 8192
    assert APP.post("/scan", json={"columns": COLS, "rows": rows, "formulas": formulas}).status_code == 200


@pytest.mark.parametrize("bad", ["=A1", {}, 7, True, "short", "long", "narrow", [["=A1", None, None, 5]],
                                 [[None, None, None, ["=A1"]]], [[None, None, None, "A1*2"]], [[None, None, None, "=" + "1" * 8192]],
                                 [None]])
def test_formulas_are_checked_before_the_scan(bad):
    rows, formulas = sheet()
    if bad == "short":
        bad = formulas[:-1]
    elif bad == "long":
        bad = formulas + [[None] * 4]
    elif bad == "narrow":
        bad = [r[:3] for r in formulas]
    elif isinstance(bad, list):
        bad = bad + formulas[1:]
    r = APP.post("/scan", json={"columns": COLS, "rows": rows, "formulas": bad})
    assert r.status_code == 400 and "formulas" in r.get_json()["error"], r.get_json()
