import ipaddress
import ssl
import threading

import numpy as np
import pytest
from cryptography import x509
from cryptography.x509 import DNSName, IPAddress
from cryptography.x509.verification import PolicyBuilder, Store, VerificationError
from werkzeug.serving import make_server

from anomaly_hunter.server import _already_running, create_app, make_cert


def test_cert_chain_only_vouches_for_localhost(tmp_path):
    assert make_cert(tmp_path) is True  # new -> installer must trust ca.pem
    assert make_cert(tmp_path) is False  # still valid -> no new trust prompt
    assert sorted(p.name for p in tmp_path.iterdir()) == ["ca.pem", "cert.pem", "key.pem"]  # CA key never saved
    ca = x509.load_pem_x509_certificate((tmp_path / "ca.pem").read_bytes())
    leaf = x509.load_pem_x509_certificate((tmp_path / "cert.pem").read_bytes())
    verifier = lambda name: PolicyBuilder().store(Store([ca])).build_server_verifier(name).verify(leaf, [])
    verifier(DNSName("localhost"))
    verifier(IPAddress(ipaddress.ip_address("127.0.0.1")))
    with pytest.raises(VerificationError):
        verifier(DNSName("example.com"))
    nc = ca.extensions.get_extension_for_class(x509.NameConstraints)
    assert nc.critical and len(nc.value.permitted_subtrees) == 2  # CA can't vouch for any other site

    (tmp_path / "cert.pem").write_text("garbage")  # corrupt -> self-heals instead of blocking install
    assert make_cert(tmp_path) is True
    assert make_cert(tmp_path / "x", days=30) is True and make_cert(tmp_path / "x") is True  # < 60 days -> renew


def test_already_running_trusts_only_our_engine(tmp_path):
    make_cert(tmp_path)
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.load_cert_chain(tmp_path / "cert.pem", tmp_path / "key.pem")
    srv = make_server("127.0.0.1", 0, create_app(), ssl_context=ctx)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        assert _already_running(tmp_path, srv.server_port)  # real TLS handshake against our CA
        make_cert(tmp_path / "other")
        assert not _already_running(tmp_path / "other", srv.server_port)  # different CA = not us
    finally:
        srv.shutdown()


def test_other_websites_cannot_drive_engine():
    c = client()
    assert c.get("/health", headers={"Origin": "https://evil.example"}).status_code == 403
    assert c.get("/health", headers={"Host": "evil.example:5055"}).status_code == 403  # DNS rebinding
    assert c.get("/health", headers={"Origin": "https://127.0.0.1:5055"}).status_code == 200


def make_clean_payload(n=40, seed=0):
    rng = np.random.RandomState(seed)
    columns = ["order", "Amount", "Price"]
    rows = [
        [i + 1, round(float(a), 2), round(float(p), 2)]
        for i, (a, p) in enumerate(zip(rng.normal(100, 5, n), rng.normal(50, 2, n)))
    ]
    return columns, rows


def client():
    return create_app().test_client()


def test_ribbon_icons_are_cacheable_but_panel_code_is_not():
    # Office drops ribbon icons served with no-store/no-cache, so icons must be
    # cacheable while the panel's HTML/JS and API stay no-store (stale-JS guard).
    c = client()
    icon = c.get("/assets/icon-32.png")
    assert icon.status_code == 200
    assert "no-store" not in icon.headers["Cache-Control"]
    assert "no-cache" not in icon.headers["Cache-Control"]
    assert c.get("/taskpane.html").headers["Cache-Control"] == "no-store"
    assert c.get("/health").headers["Cache-Control"] == "no-store"


def test_health():
    resp = client().get("/health")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "ok"
    assert body["ai_available"] is False  # ANTHROPIC_API_KEY unset in the test environment


def test_scan_clean_data_no_anomalies():
    columns, rows = make_clean_payload()
    resp = client().post("/scan", json={"columns": columns, "rows": rows, "limits": None, "order_by": None})
    assert resp.status_code == 200
    body = resp.get_json()
    assert len(body["rows"]) == len(rows)
    assert body["suggested_limits"] is not None
    assert set(body["suggested_limits"]) == {"Amount", "Price"}  # "order" 1..n is an identifier, not a measurement


def test_scan_flags_planted_outlier():
    columns, rows = make_clean_payload(n=40)
    rows.append([999, 999999, 50])
    resp = client().post("/scan", json={
        "columns": columns,
        "rows": rows,
        "limits": {"Amount": [80, 120, 0, 10000]},
        "order_by": None,
    })
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["limits"]["Amount"] == [80, 120, 0, 10000]  # the saved limit wins over the suggestion
    last = body["rows"][-1]
    assert last["severity"] in ("Medium", "High")
    assert last["bucket"] == "Irregularities"


def test_scan_handles_duplicate_and_blank_column_headers():
    # Regression: a real user's spreadsheet had repeated/blank header cells.
    # load_from_records built the DataFrame with duplicate column labels, so
    # df[name] returned a DataFrame instead of a Series and any Series-only
    # call (.str, .isna() chains) crashed with "'DataFrame' object has no
    # attribute 'str'". Found against a real user's own file, not synthetic data.
    columns = ["Notes", "Amount", "Notes", ""]
    rows = [["a", 10, "x", ""], ["b", 11, "y", ""], ["c", 9, "z", ""]]
    resp = client().post("/scan", json={"columns": columns, "rows": rows, "limits": None, "order_by": None})
    assert resp.status_code == 200
    assert len(resp.get_json()["rows"]) == len(rows)


def test_scan_flags_duplicate_row_via_in_memory_path():
    # Regression: hygiene.duplicates() used to assume a source_file column,
    # which load_from_records (the server's in-memory path) never adds —
    # caught live via a real Excel click-through, not by any prior test here.
    columns, rows = make_clean_payload(n=40)
    rows.append(list(rows[4]))  # exact duplicate of row index 4
    resp = client().post("/scan", json={"columns": columns, "rows": rows, "limits": None, "order_by": None})
    assert resp.status_code == 200
    last = resp.get_json()["rows"][-1]
    assert last["bucket"] == "Duplicates"
    assert "Duplicate of row" in last["reason"]


def test_scan_rejects_malformed_body():
    resp = client().post("/scan", json={"columns": ["a", "b"], "rows": [[1]]})
    assert resp.status_code == 400
    assert "error" in resp.get_json()


def test_scan_rejects_non_json_body():
    resp = client().post("/scan", data="not json", content_type="text/plain")
    assert resp.status_code == 400


def test_each_scan_overwrites_the_power_bi_csv(tmp_path):
    import pandas as pd
    out = tmp_path / "latest-scan.csv"
    c = create_app(out).test_client()
    columns, rows = make_clean_payload(n=40)
    for n in (40, 30):  # second scan replaces the first, never appends
        assert c.post("/scan", json={"columns": columns, "rows": rows[:n]}).status_code == 200
        got = pd.read_csv(out, encoding="utf-8-sig")
        assert len(got) == n and list(got.columns) == [*columns, "Severity", "Bucket", "Reason", "Magnitude"]
    assert not (tmp_path / "latest-scan.csv.tmp").exists()


# ---- Batch 1: bad input gets a clear 400, never a crash; odd values never crash a scan ----

GOOD = [[f"n{i}", 50 + i % 7] for i in range(40)]


def scan(body, raw=None):
    c = create_app().test_client()
    return c.post("/scan", data=raw, content_type="application/json") if raw else c.post("/scan", json=body)


@pytest.mark.parametrize("raw", [
    '{"columns":["A"],"rows":[[NaN]]}', '{"columns":["A"],"rows":[[Infinity]]}', '{"columns":["A"],"rows":[[{"x":1}]]}',
    '{"columns":["A"],"rows":[[[1,2]]]}', '{"columns":["A","B"],"rows":[["a",1]],"limits":"x"}',
    '{"columns":["A","B"],"rows":[["a",1]],"limits":[1,2]}', '{"columns":["A","B"],"rows":[["a",1]],"limits":{"B":[1,2,3]}}',
    '{"columns":["A","B"],"rows":[["a",1]],"limits":{"B":["1",2,3,4]}}', '{"columns":["A","B"],"rows":[["a",1]],"order_by":"Nope"}',
    '{"columns":["A","B"],"rows":[["a",1]],"order_by":["A"]}', '{"columns":["A","B"],"rows":[["a",1]],"limits":{"B":[150,50,200,20]}}'])
def test_bad_input_is_a_clear_400(raw):
    r = scan(None, raw)
    assert r.status_code == 400 and r.get_json()["error"] and "pandas" not in r.get_json()["error"]


@pytest.mark.parametrize("cols,rows", [
    (["Name"], [["a"], ["b"], ["c"]]),  # no number column at all
    (["Name", "Amt"], GOOD[:39] + [["x", "inf"]]), (["Name", "Amt"], GOOD[:39] + [["x", "-Infinity"]]),
    (["Name", "Amt"], GOOD[:39] + [["x", 1e160]]),
    (["Dept", "Dept", "Dept.1", "Amt"], [["a", "b", "c", 50 + i % 7] for i in range(40)])])  # names collide after de-dup
def test_odd_sheets_scan_without_crashing(cols, rows):
    r = scan({"columns": cols, "rows": rows, "limits": None, "order_by": None})
    assert r.status_code == 200, r.get_json()
    import json
    json.loads(r.get_data(as_text=True), parse_constant=lambda c: pytest.fail(f"bare {c} in JSON"))  # Power BI needs strict JSON


def test_a_huge_or_infinite_value_is_flagged_as_unusable():
    for bad in ("inf", 1e160):
        rows = scan({"columns": ["Name", "Amt"], "rows": GOOD[:39] + [["x", bad]]}).get_json()["rows"]
        assert rows[39]["severity"] and "Amt" in rows[39]["reason"], rows[39]


def test_duplicate_headers_stay_distinct_after_dedup():
    from anomaly_hunter.engine.load import load_from_records
    df, _, _ = load_from_records(["Dept", "Dept", "Dept.1"], [["a", "b", "c"]])
    assert list(df.columns) == ["Dept", "Dept.1", "Dept.1.1"]  # same rule as the panel's tableFromGrid


def test_an_engine_bug_is_logged_not_leaked(monkeypatch):
    import anomaly_hunter.agents.scan_agent as srv  # the scan moved into Agent 1
    monkeypatch.setattr(srv, "score", lambda *a: (_ for _ in ()).throw(RuntimeError("pandas internal detail")))
    r = scan({"columns": ["Name", "Amt"], "rows": GOOD})
    assert r.status_code == 500 and r.get_json() == {"error": "Engine error - details in server.log"}


def test_a_huge_whole_number_is_a_value_not_a_crash():
    r = scan({"columns": ["Name", "Amt"], "rows": GOOD[:39] + [["x", int("9" * 400)]]})
    assert r.status_code == 200 and r.get_json()["rows"][39]["severity"]
    r = scan({"columns": ["Name", "Amt"], "rows": GOOD, "limits": {"Amt": [int("9" * 400), None, None, None]}})
    assert r.status_code == 400


def test_column_names_must_be_text_or_numbers_and_numeric_headers_work():
    assert scan({"columns": [{"x": 1}, "b"], "rows": [[1, 2], [2, 1]]}).status_code == 400
    rows = [[f"2024-01-{1 + i % 28:02d}", 50 + i % 7] for i in range(40)]
    r = scan({"columns": [2024, "b"], "rows": rows, "order_by": 2024})  # a year as a header, used to sort
    assert r.status_code == 200, r.get_json()


def test_first_scan_uses_suggested_limits_at_once_and_saved_limits_win():
    # no stop at a limits table: the first scan already flags past the suggested limits
    c = client()
    rows = [[f"n{i}", 50 + i % 7] for i in range(60)] + [["typo", 5000]]
    body = c.post("/scan", json={"columns": ["Name", "Amt"], "rows": rows, "limits": None}).get_json()
    assert body["rows"][60]["severity"] in ("Medium", "High") and "Amt weird limit" in body["rows"][60]["reason"]
    assert body["limits"]["Amt"] == body["suggested_limits"]["Amt"]
    body = c.post("/scan", json={"columns": ["Name", "Amt"], "rows": rows, "limits": {"Amt": [None, None, None, 9999]}}).get_json()
    assert body["limits"]["Amt"] == [None, None, None, 9999] and "weird limit" not in body["rows"][60]["reason"]
