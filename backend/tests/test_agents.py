import pytest

from anomaly_hunter.agents.checker import check
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
