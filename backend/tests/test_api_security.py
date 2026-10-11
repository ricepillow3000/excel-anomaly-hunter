"""API security checks CI runs on every push: what a generic scanner (ZAP) can't know about this engine."""
import pytest
from test_fix import BODY, gemini_stub

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
    for r in (c.get("/health"), c.get("/taskpane.html"), c.post("/scan", data="x"), c.get("/nope")):
        assert r.headers["X-Content-Type-Options"] == "nosniff" and r.headers["Server"] == "Anomaly Hunter"
