"""API security checks CI runs on every push: what a generic scanner (ZAP) can't know about this engine."""
import json

import pytest
from test_fix import BODY, gemini_stub
from werkzeug.serving import WSGIRequestHandler

from anomaly_hunter import server
from anomaly_hunter.ai import client
from anomaly_hunter.server import create_app

CANARY = "AIzaCANARY-not-a-real-key-123"  # if this ever shows up in a response, the key leaked
APP = create_app()
ROUTES = sorted({(r.rule.replace("<path:filename>", "taskpane.html"), m)
                 for r in APP.url_map.iter_rules() for m in r.methods - {"HEAD", "OPTIONS"}})


@pytest.mark.parametrize("path,method", ROUTES)
def test_every_route_refuses_other_websites(path, method):
    """New routes are covered automatically: the list comes from Flask, not from this file."""
    c = APP.test_client()
    for h in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Host": "evil.example:5055"}):
        assert c.open(path, method=method, headers=h, json={}).status_code == 403, h


# shapes the fuzzer can't generate (it sends well-formed JSON): not JSON, the wrong JSON type, nested past Python's
# parser (was a 500 on every route), a number past Python's 4300-digit limit
HOSTILE = ["{bad", "[]", "null", '"x"', "[" * 100000 + "]" * 100000, '{"columns":["A"],"rows":[[' + "9" * 5000 + "]]}"]


@pytest.mark.parametrize("path", sorted({p for p, m in ROUTES if m == "POST"}))
def test_every_post_route_answers_a_hostile_body_with_a_clear_4xx(path, monkeypatch):
    """New routes are covered automatically, like the test above."""
    monkeypatch.setattr(client, "api_key_configured", lambda: True)  # AI routes check the body before the key
    c = APP.test_client()
    for raw in HOSTILE:
        r = c.post(path, data=raw, content_type="application/json")
        assert 400 <= r.status_code < 500 and r.is_json, (path, raw[:20], r.status_code)


@pytest.mark.parametrize("path", ["/../pyproject.toml", "/%2e%2e/pyproject.toml", "/..%2fpyproject.toml",
                                  "/../backend/anomaly_hunter/ai/client.py", "/C:/Windows/win.ini"])
def test_no_file_outside_the_pane_is_served(path):
    r = APP.test_client().get(path)
    assert r.status_code in (400, 404) and b"dependencies" not in r.data and b"GEMINI" not in r.data


@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500])
def test_the_key_never_comes_back_even_when_google_echoes_it(monkeypatch, tmp_path, status):
    gemini_stub(monkeypatch, tmp_path, status=status, error=f"API key not valid: {CANARY}")
    c = create_app().test_client()
    responses = [c.post("/key", json={"key": CANARY}), c.post("/fix", json=BODY), c.get("/health"), c.post("/fix", json={})]
    client.KEY_FILE.write_text(CANARY, encoding="utf-8")  # a key that is saved, whatever Google said
    responses += [c.post("/fix", json=BODY), c.get("/health"), c.post("/key", json={"key": "bad key!"})]
    for r in responses:
        assert CANARY not in r.get_data(as_text=True) and CANARY not in str(r.headers)


def test_invite_code_is_only_ever_sent_over_https(monkeypatch):
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    for url, ok in [("https://anomaly-hunter-relay.example.workers.dev", True), ("http://relay.example", False),
                    ("file:///C:/x", False), ("ftp://relay.example", False), ("", False)]:
        monkeypatch.setattr(client, "RELAY_URL", url)
        assert (client.provider() == "relay") is ok, url


def test_safe_headers_on_every_answer():
    c = APP.test_client()
    for r in (c.get("/health"), c.get("/taskpane.html"), c.get("/assets/icon-16.png"), c.post("/scan", data="x"), c.get("/nope")):
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        # exact string: loosening it (say 'unsafe-inline' or a new host) must be a deliberate, re-tested change
        assert r.headers["Content-Security-Policy"] == (
            "default-src 'self'; script-src 'self' https://appsforoffice.microsoft.com; object-src 'none'; "
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    assert WSGIRequestHandler.version_string(None) == "Anomaly Hunter"  # the real server's Server header (ZAP checks it live)


def test_every_error_is_json_never_a_framework_html_page():
    """ZAP's active scan: 404/405 came back as Werkzeug's HTML page - unlike every other answer, and it names the framework."""
    c = APP.test_client()
    for r in (c.get("/WEB-INF/web.xml"), c.get("/nope.php?x=1"), c.get("/scan"), c.delete("/health"), c.put("/key")):
        assert r.status_code in (404, 405) and r.is_json and isinstance(r.get_json().get("error"), str), (r.status_code, r.data[:80])
        assert b"<html" not in r.data.lower() and b"werkzeug" not in r.data.lower()


SHEET = {"columns": ["Item", "Units"], "rows": [[f"Pen {k}", 10 + k % 5] for k in range(30)]}


def test_power_bi_csv_never_carries_a_live_formula(tmp_path):
    """OWASP CSV injection: a cell starting = + - @ (or tab/CR, or full-width forms) runs as a formula when the
    CSV is opened in Excel. Partial protection: OWASP notes the apostrophe may not survive a save and reopen."""
    out = tmp_path / "s.csv"
    rows = SHEET["rows"] + [["=cmd|' /C calc'!A0", 12], ["@SUM(1)", 11], ["＝1+1", 10], ["-5 items", 13]]
    r = create_app(scan_csv=out).test_client().post("/scan", json={**SHEET, "rows": rows})
    assert r.status_code == 200
    text = out.read_text(encoding="utf-8-sig")
    assert "'=cmd" in text and "'@SUM" in text and "'＝1+1" in text and "\n=cmd" not in text
    assert "\nPen 0,10," in text  # numbers stay numbers (no apostrophe)


def test_an_odd_character_never_turns_a_scan_into_a_500(tmp_path):
    raw = json.dumps({**SHEET, "rows": SHEET["rows"] + [["ab\ud800", 12]]})  # a lone surrogate, valid JSON
    r = create_app(scan_csv=tmp_path / "s.csv").test_client().post("/scan", data=raw, content_type="application/json")
    assert r.status_code == 200


def test_a_number_too_big_for_a_float_never_turns_a_scan_into_a_500(tmp_path):
    # a 309-digit whole number is a valid (flagged) value, but the Power BI CSV's DataFrame can't hold it as a float
    rows = SHEET["rows"] + [["Pen", 10 ** 309]]
    r = create_app(scan_csv=tmp_path / "s.csv").test_client().post("/scan", json={**SHEET, "rows": rows})
    assert r.status_code == 200


def test_a_huge_body_is_refused_before_it_is_read():
    app = create_app()
    app.config["MAX_CONTENT_LENGTH"] = 1000
    r = app.test_client().post("/scan", data=json.dumps({**SHEET, "rows": SHEET["rows"] * 5}), content_type="application/json")
    assert r.status_code == 413 and r.is_json and "error" in r.get_json()
    assert create_app().config["MAX_CONTENT_LENGTH"] == 256 * 1024 * 1024  # a 20 MB real sheet still fits


def test_more_cells_than_the_pane_ever_sends_is_a_clear_400(monkeypatch):
    monkeypatch.setattr(server, "MAX_CELLS", 10)
    r = APP.test_client().post("/scan", json={"columns": ["a"], "rows": [[k] for k in range(11)]})
    assert r.status_code == 400 and "too many cells" in r.get_json()["error"]
