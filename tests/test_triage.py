import anthropic

from anomaly_hunter import triage
from anomaly_hunter.server import create_app


def client():
    return create_app().test_client()


def test_build_prompt_includes_row_values_and_engine_reason():
    prompt = triage._build_prompt(
        ["id", "amount"],
        [{"row_index": 5, "values": [1, 999999], "severity": "High", "bucket": "Irregularities", "reason": "weird limit"}],
    )
    assert "row_index 5" in prompt
    assert "999999" in prompt
    assert "weird limit" in prompt
    assert "add_note" in prompt and "copy_to_anomalies_sheet" in prompt


def test_triage_route_503_when_key_not_configured(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: False)
    resp = client().post("/triage", json={"columns": ["a"], "flagged": [{"row_index": 0, "values": [1]}]})
    assert resp.status_code == 503
    assert "ANTHROPIC_API_KEY" in resp.get_json()["error"]


def test_triage_route_returns_mocked_results(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: True)
    fake_result = {
        "row_index": 0,
        "verdict": "broken-weird",
        "reason": "Looks like a typo.",
        "safe_action": "add_note",
        "suggested_action_detail": "Flag for review.",
    }
    monkeypatch.setattr(triage, "triage_rows", lambda columns, flagged: [fake_result])

    resp = client().post("/triage", json={"columns": ["a"], "flagged": [{"row_index": 0, "values": [1]}]})
    assert resp.status_code == 200
    assert resp.get_json() == {"results": [fake_result]}


class _FakeResponse:
    request = None
    status_code = 401
    headers = {}


def test_triage_route_maps_auth_error_to_503(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: True)

    def raise_auth_error(columns, flagged):
        raise anthropic.AuthenticationError("bad key", response=_FakeResponse(), body=None)

    monkeypatch.setattr(triage, "triage_rows", raise_auth_error)
    resp = client().post("/triage", json={"columns": ["a"], "flagged": [{"row_index": 0, "values": [1]}]})
    assert resp.status_code == 503
    assert "Invalid ANTHROPIC_API_KEY" in resp.get_json()["error"]


def test_triage_route_rejects_malformed_body(monkeypatch):
    monkeypatch.setattr(triage, "api_key_configured", lambda: True)
    resp = client().post("/triage", json={"columns": "not-a-list", "flagged": []})
    assert resp.status_code == 400
