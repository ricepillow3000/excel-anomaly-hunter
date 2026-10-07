import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from anomaly_hunter import triage
from anomaly_hunter.server import create_app

COLS = ["OrderDate", "Region", "Units"]
ROWS = [["2026-01-06", "East", 95], ["2026-01-07", "West", -5], ["2026-01-08", "East", 50]]
BODY = {"columns": COLS, "rows": ROWS, "row_index": 1, "start_row": 0, "start_col": 0,
        "reason": "Units below weird low 0", "intent": "make it the median of Units"}


def post(body):
    return create_app().test_client().post("/fix", json=body)


def test_col_letter():
    assert [triage.col_letter(n) for n in (0, 25, 26, 27, 701, 702)] == ["A", "Z", "AA", "AB", "ZZ", "AAA"]


def test_fix_prompt_gives_claude_real_sheet_addresses():
    p = triage._fix_prompt(COLS, ROWS, 1, 0, 0, "Units below weird low 0", "make it the median")
    assert "Data range: A1:C4 (row 1 = headers)" in p
    assert "A=OrderDate, B=Region, C=Units" in p
    assert "Flagged row 3: A3='2026-01-07', B3='West', C3=-5" in p
    assert "row 2: " in p and "row 4: " in p  # neighbours, not the flagged row twice
    assert p.count("C3=-5") == 1
    assert "make it the median" in p and "Units below weird low 0" in p
    # data that starts at C5 instead of A1
    p = triage._fix_prompt(COLS, ROWS, 0, 4, 2, "", "  ")
    assert "Data range: C5:E8 (row 5 = headers)" in p and "Flagged row 6: C6=" in p
    assert "Recommend the single best fix" in p  # blank request = recommended fix


def test_fix_route_validates_before_calling_claude(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: True)
    monkeypatch.setattr(triage, "suggest_fix", lambda *a: 1 / 0)  # must never be reached
    for bad in ({**BODY, "row_index": 3}, {**BODY, "row_index": -1}, {**BODY, "row_index": True},
                {**BODY, "start_col": "A"}, {**BODY, "intent": "x" * 2001}, {**BODY, "intent": 5},
                {**BODY, "rows": [[1]]}, [1]):
        assert post(bad).status_code == 400, bad


def test_fix_route_503_without_key(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: False)
    r = post(BODY)
    assert r.status_code == 503 and "ANTHROPIC_API_KEY" in r.get_json()["error"]


def test_fix_route_passes_request_through(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: True)
    seen = {}
    fake = {"explanation": "Median of Units.", "changes": [{"cell": "C3", "new": "=MEDIAN(C2:C4)"}]}
    monkeypatch.setattr(triage, "suggest_fix", lambda *a: seen.setdefault("args", a) and fake)
    r = post({**BODY, "intent": None})
    assert r.status_code == 200 and r.get_json() == fake
    assert seen["args"] == (COLS, ROWS, 1, 0, 0, "Units below weird low 0", "")


def stub_api(monkeypatch, content, stop="end_turn"):
    """Local stand-in for the Claude API: the real SDK talks to it. -> (server, list of request bodies)."""
    sent = []

    class Stub(BaseHTTPRequestHandler):
        def do_POST(self):
            sent.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
            out = json.dumps({"id": "msg_1", "type": "message", "role": "assistant", "model": triage.MODEL,
                              "content": content, "stop_reason": stop, "stop_sequence": None,
                              "usage": {"input_tokens": 1, "output_tokens": 1}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", f"http://127.0.0.1:{srv.server_port}")
    return srv, sent


def test_suggest_fix_through_real_sdk(monkeypatch):
    """Real anthropic SDK request + structured-output parse."""
    answer = {"explanation": "Use the median.", "changes": [
        {"cell": "c3", "new": "=MEDIAN(C2:C4)"}, {"cell": "$C$4", "new": "50"},
        {"cell": "Sheet1!C3", "new": "1"}, {"cell": "C0", "new": "1"}]}
    srv, sent = stub_api(monkeypatch, [{"type": "text", "text": json.dumps(answer)}])
    try:
        out = triage.suggest_fix(COLS, ROWS, 1, 0, 0, "low", "median please")
    finally:
        srv.shutdown()
    # lower-cased and $-anchored addresses are normalised; sheet-qualified and row 0 are dropped
    assert out == {"explanation": "Use the median.",
                   "changes": [{"cell": "C3", "new": "=MEDIAN(C2:C4)"}, {"cell": "C4", "new": "50"}]}
    assert sent[0]["model"] == triage.MODEL
    assert sent[0]["output_config"]["format"]["type"] == "json_schema"
    assert "median please" in sent[0]["messages"][0]["content"]


def test_fix_route_explains_refusal_and_cut_off_answers(monkeypatch):
    for content, stop, msg in (([], "refusal", "no usable answer"),
                               ([{"type": "text", "text": '{"explanation": "cu'}], "max_tokens", "incomplete")):
        srv, _ = stub_api(monkeypatch, content, stop)
        try:
            r = post(BODY)
        finally:
            srv.shutdown()
        assert r.status_code == 502 and msg in r.get_json()["error"], r.get_json()
