import pytest

from anomaly_hunter.agents.checker import check, slips, suggest
from anomaly_hunter.agents.scan_agent import scan
from test_server import client, make_clean_payload


def planted():
    columns, rows = make_clean_payload(n=40)
    rows[7][1] = 999999  # Amount ~100 everywhere else
    return columns, rows


def test_scan_agent_flags_the_planted_row():
    columns, rows = planted()
    _, out, suggested, used, _ = scan(columns, rows)
    assert out[7]["severity"] in ("Medium", "High")
    assert used == suggested  # nothing saved by the user -> limits come from the data


def test_checker_passes_a_real_fix_and_catches_a_bad_one():
    columns, rows = planted()
    used = scan(columns, rows)[3]
    good = check(columns, rows, used, 7, [{"col": 1, "value": 100}])
    assert good["clean"] is True
    bad = check(columns, rows, used, 7, [{"col": 1, "value": 999999}])
    assert bad["clean"] is False and bad["reason"]
    assert rows[7][1] == 999999  # the checker never touches the caller's table


def test_slips_are_one_typing_mistake_away():
    got = slips(89.5)
    assert got[98.5] == "two digits swapped"
    assert got[8.95] == "the decimal point in the wrong place" and got[-89.5] == "the sign flipped"
    assert got[9.5] == "an extra digit"


def test_suggest_offers_only_the_one_slip_that_makes_the_row_normal():
    columns, rows = make_clean_payload(n=40)
    rows[7][1] = 1300.0  # typed for 100: of every one-slip value only 100 lands in Amount's usual range
    used = scan(columns, rows)[3]
    assert suggest(columns, rows, used, 7, "Amount") == {"value": 100.0, "kind": "an extra digit"}
    assert suggest(columns, rows, used, 7, "order") == {}  # an id column has no usual range: nothing to offer
    assert suggest(columns, rows, used, 7, "nope") == {}


def test_suggest_route():
    columns, rows = make_clean_payload(n=40)
    rows[7][1] = 10.03  # typed for 100.3: decimal point slipped
    used = scan(columns, rows)[3]
    resp = client().post("/suggest", json={"columns": columns, "rows": rows, "limits": used, "row_index": 7, "column": "Amount"})
    assert resp.status_code == 200 and resp.get_json() == {"value": 100.3, "kind": "the decimal point in the wrong place"}
    bad = client().post("/suggest", json={"columns": columns, "rows": rows, "row_index": 7, "column": 5})
    assert bad.status_code == 400


def test_check_route():
    columns, rows = planted()
    used = scan(columns, rows)[3]
    body = {"columns": columns, "rows": rows, "limits": used, "row_index": 7, "changes": [{"col": 1, "value": 100}]}
    resp = client().post("/check", json=body)
    assert resp.status_code == 200 and resp.get_json()["clean"] is True


@pytest.mark.parametrize("bad", [
    {"row_index": 99},  # outside the table
    {"changes": [{"col": 9, "value": 1}]},  # no such column
    {"changes": [{"col": 1, "value": [1]}]},  # not a cell value
    {"changes": []},  # nothing to check
])
def test_check_route_rejects_bad_input(bad):
    columns, rows = planted()
    body = {"columns": columns, "rows": rows, "row_index": 7, "changes": [{"col": 1, "value": 100}], **bad}
    assert client().post("/check", json=body).status_code == 400
