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
    assert body["suggested_limits"] is None
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


def test_latest_scan_404_before_any_scan():
    resp = client().get("/latest-scan")
    assert resp.status_code == 404
    assert "error" in resp.get_json()


def test_latest_scan_reflects_last_scan():
    c = client()  # one app instance for both calls — the cache lives on app.config
    columns, rows = make_clean_payload(n=40)
    c.post("/scan", json={"columns": columns, "rows": rows, "limits": None, "order_by": None})

    resp = c.get("/latest-scan")
    assert resp.status_code == 200
    body = resp.get_json()
    assert isinstance(body, list)
    assert len(body) == len(rows)
    assert set(columns) | {"Severity", "Bucket", "Reason", "Magnitude"} == set(body[0])


def test_latest_scan_does_not_leak_across_app_instances():
    c1 = client()
    columns, rows = make_clean_payload(n=40)
    c1.post("/scan", json={"columns": columns, "rows": rows, "limits": None, "order_by": None})

    c2 = client()  # a fresh app instance — must not see c1's cached scan
    resp = c2.get("/latest-scan")
    assert resp.status_code == 404
