import numpy as np

from anomaly_hunter.server import create_app


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
    assert set(body["suggested_limits"]) == {"order", "Amount", "Price"}


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


def test_suggest_limits_route():
    columns, rows = make_clean_payload()
    resp = client().post("/suggest-limits", json={"columns": columns, "rows": rows})
    assert resp.status_code == 200
    body = resp.get_json()
    assert set(body) == {"order", "Amount", "Price"}
    for bounds in body.values():
        assert len(bounds) == 4


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
