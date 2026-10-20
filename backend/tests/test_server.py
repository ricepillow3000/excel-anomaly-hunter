import ipaddress
import re
import socket
import threading

import numpy as np
import pytest
from cryptography import x509
from cryptography.x509 import DNSName, IPAddress
from cryptography.x509.verification import PolicyBuilder, Store, VerificationError
from werkzeug.serving import make_server

from anomaly_hunter.server import _already_running, create_app, make_cert, tls_context, version


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


def live_engine(folder):
    """A real HTTPS engine on a free port, built like main() runs it: threaded, our TLS context. Use this, not a bare
    make_server (single-threaded by default: one stuck client then blocks it whatever the TLS code does)."""
    make_cert(folder)
    srv = make_server("127.0.0.1", 0, create_app(), threaded=True, ssl_context=tls_context(folder / "cert.pem", folder / "key.pem"))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def test_already_running_trusts_only_our_engine(tmp_path):
    srv = live_engine(tmp_path)
    try:
        assert _already_running(tmp_path, srv.server_port)  # real TLS handshake against our CA
        make_cert(tmp_path / "other")
        assert not _already_running(tmp_path / "other", srv.server_port)  # different CA = not us
    finally:
        srv.shutdown()


def test_one_silent_connection_does_not_freeze_the_engine(tmp_path):
    # TLS handshakes ran in Werkzeug's one accept loop: a client that connected and never said hello (a port scan,
    # a stuck probe) hung every scan until it hung up
    srv = live_engine(tmp_path)
    silent = socket.create_connection(("127.0.0.1", srv.server_port))
    try:
        assert _already_running(tmp_path, srv.server_port)  # answers within its 2 s timeout
    finally:
        silent.close()
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
    icon = c.get("/assets/mark-32.png")
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


def test_health_names_the_engine_version_and_its_date(tmp_path):
    """2026-10-15: a laptop still ran a 3-day-old engine and scored a credit sheet 2 of 279 rows; nothing showed it."""
    assert re.fullmatch(r"dev [0-9a-f]{7,} \(\d{4}-\d\d-\d\d\)", client().get("/health").get_json()["version"])
    (tmp_path / "version.txt").write_text("v0.1.30 (2026-10-15)\n")  # the exe build writes the release tag
    assert version(tmp_path) == "v0.1.30 (2026-10-15)"
    assert version(tmp_path / "nowhere") == "dev"  # no git, no version file: still answers


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


def test_every_link_and_file_the_pane_pages_use_is_served():
    # the pane's Privacy and Support links, and every file its pages load, must open from the engine (a missing one
    # is a blank page in Excel's pane with nothing on screen to say why); same-page anchors must exist too
    from pathlib import Path
    pane = Path(__file__).resolve().parents[2] / "frontend"
    c = client()
    for page in ("taskpane.html", "privacy.html", "support.html"):
        html = (pane / page).read_text(encoding="utf-8")
        r = c.get(f"/{page}")
        assert r.status_code == 200 and "text/html" in r.content_type and r.headers["Content-Security-Policy"], page
        links = re.findall(r'(?:href|src)="([^"]+)"', html) + [s.split()[0] for s in re.findall(r'srcset="([^"]+)"', html)]
        for link in {u for u in links if not re.match(r"https?://", u)}:
            target, _, anchor = link.partition("#")
            if target:
                assert c.get(f"/{target}").status_code == 200, (page, link)
            if anchor:
                assert f'id="{anchor}"' in (pane / (target or page)).read_text(encoding="utf-8"), (page, link)
    assert {"privacy.html", "support.html"} <= set(re.findall(r'href="([a-z]+\.html)"', (pane / "taskpane.html").read_text(encoding="utf-8")))


def test_each_scan_overwrites_the_power_bi_csv(tmp_path):
    import pandas as pd
    out = tmp_path / "latest-scan.csv"
    c = create_app(out).test_client()
    columns, rows = make_clean_payload(n=40)
    for n in (40, 30):  # second scan replaces the first, never appends
        assert c.post("/scan", json={"columns": columns, "rows": rows[:n], "power_bi": True}).status_code == 200
        got = pd.read_csv(out, encoding="utf-8-sig")
        assert len(got) == n and list(got.columns) == ["Excel Row", *columns, "Severity", "Bucket", "Reason",
                                                       "Suggested Fix", "Magnitude"]  # powerbi/README.md's schema
    assert not (tmp_path / "latest-scan.csv.tmp").exists()
    # the user's own "Severity" column is kept; ours gets a clear name instead of overwriting it
    rows = [[f"T{i}", 10 + i % 5, "Open"] for i in range(40)]
    assert c.post("/scan", json={"columns": ["Ticket", "Amount", "Severity"], "rows": rows, "power_bi": True}).status_code == 200
    got = pd.read_csv(out, encoding="utf-8-sig")
    assert (got["Severity"] == "Open").all() and "Anomaly Hunter Severity" in got.columns


def test_numbers_spanning_huge_ranges_still_scan():
    rows = [[f"r{i}", 1e-100 if i < 10 else 1e99] for i in range(21)]
    assert scan({"columns": ["Name", "Amt"], "rows": rows}).status_code == 200


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


def test_a_body_nested_too_deep_is_a_clear_400():
    # too deep for Python's JSON parser: a RecursionError, which Flask's silent=True did not catch -> 500
    r = scan(None, '{"columns":["A"],"rows":[' + "[" * 100000 + "]" * 100000 + "]}")
    assert r.status_code == 400 and r.get_json()["error"]


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


def test_a_flood_of_long_urls_leaves_the_log_small_but_engine_errors_still_reach_it(tmp_path, caplog):
    # stress test 2026-10-16: Werkzeug logged every request line in full, a refused one too - a 60 KB URL wrote 60 KB to
    # server.log (about 600 MB a minute at flood rate, until a restart). A web page's <img> GET carries no Origin, so it
    # isn't refused either. Only errors are kept: the log is the engine's own error log (PRIVACY.md)
    import logging
    import ssl as _ssl
    import urllib.request
    srv = live_engine(tmp_path)
    ctx = _ssl.create_default_context(cafile=str(tmp_path / "ca.pem"))
    caplog.set_level(logging.DEBUG)
    try:
        for origin in (None, "https://evil.example"):
            for _ in range(5):
                req = urllib.request.Request(f"https://127.0.0.1:{srv.server_port}/health?" + "a" * 60000,
                                             headers={"Origin": origin} if origin else {})
                try:
                    urllib.request.urlopen(req, context=ctx, timeout=5).read()  # noqa: S310 - our own test engine
                except urllib.error.HTTPError:
                    pass
    finally:
        srv.shutdown()
    assert sum(len(r.getMessage()) for r in caplog.records if r.name == "werkzeug") < 2000
    app = create_app()
    app.logger.error("an engine error")  # the app's own errors are untouched
    assert any(r.getMessage() == "an engine error" for r in caplog.records)


def test_two_scans_at_once_publish_one_whole_power_bi_file_never_an_error(tmp_path, monkeypatch, caplog):
    # stress test 2026-10-16: two workbooks scanning together shared one temp file: one replace found it gone
    # ("could not write") and a file could mix both sheets. One write at a time
    import time
    import pandas as pd
    real = pd.DataFrame.to_csv

    def slow(self, *a, **k):
        out = real(self, *a, **k)
        time.sleep(0.3)  # both scans sit between writing the temp file and replacing the real one
        return out
    monkeypatch.setattr(pd.DataFrame, "to_csv", slow)
    csv_path = tmp_path / "latest-scan.csv"
    app = create_app(csv_path)
    sheets = [make_clean_payload(n=40, seed=s) for s in (1, 2)]
    threads = [threading.Thread(target=lambda c=c, r=r: app.test_client().post("/scan", json={"columns": c, "rows": r, "power_bi": True}))
               for c, r in sheets]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert not any("could not write" in r.getMessage() for r in caplog.records)
    body = csv_path.read_text(encoding="utf-8-sig")
    assert body.count("\n") == 41 and not list(tmp_path.glob("*.tmp"))


def test_the_power_bi_copy_is_kept_only_when_turned_on_and_removed_when_turned_off(tmp_path):
    # John, 2026-10-16: the plain-text copy of the whole sheet was written on every scan, Power BI or not. Opt-in now:
    # the pane's "Save each scan for Power BI" (off unless turned on) sends power_bi; off removes an old copy too
    out = tmp_path / "latest-scan.csv"
    out.write_text("an old copy of a sheet", encoding="utf-8")
    c = create_app(out).test_client()
    columns, rows = make_clean_payload(n=40)
    assert c.post("/scan", json={"columns": columns, "rows": rows}).status_code == 200
    assert not out.exists()
    assert c.post("/scan", json={"columns": columns, "rows": rows, "power_bi": True}).status_code == 200 and out.exists()
    assert c.post("/scan", json={"columns": columns, "rows": rows, "power_bi": False}).status_code == 200 and not out.exists()
    assert c.post("/scan", json={"columns": columns, "rows": rows, "power_bi": "yes"}).status_code == 400
