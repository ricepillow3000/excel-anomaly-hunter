"""AH-125: what someone types to Ask AI that reads as a person in crisis gets helpline numbers from the engine itself.
Nothing goes to Google or the relay, nothing is cached, and it works with no AI key at all."""
import pytest

from anomaly_hunter import server
from anomaly_hunter.ai import care, client
from anomaly_hunter.server import create_app

BODY = {"columns": ["OrderDate", "Region", "Units"],
        "rows": [["2026-01-06", "East", 95], ["2026-01-07", "West", -5], ["2026-01-08", "East", 50]],
        "row_index": 1, "start_row": 0, "start_col": 0, "reason": "Units below weird low 0"}

IN_CRISIS = [
    "I want to kill myself", "i'm going to end my life", "I just want to die", "I feel suicidal",
    "I keep wanting to hurt myself", "thinking about self harm", "self-harm again tonight", "selfharm",
    "I don't want to live anymore", "I don’t want to live", "there is no reason to live", "everyone would be better off dead",
    "I want to take my own life", "KILL   MYSELF", "Ｉ want to die", "I'm thinking of ending my life", "I wanna die",
    "this sheet makes me want to kill myself", "I hate my life and want to end it all", "I tried to commit suicide",
]
SPREADSHEET_TALK = [
    "kill the duplicates", "dead rows", "drop the column", "shoot me the totals", "kill row 5",
    "fill the suicide column blanks", "suicide rate by state", "die roll results", "hurt sales", "harm reduction budget",
    "remove dead stock", "the deadline column is wrong", "make the self harm column a number",
    "count suicides per 100k", "why did this kill my formula", "use the average Units for East", "",
    "this row is better off deleted", "end the list at row 40", "I want to drop this column",
]


@pytest.mark.parametrize("text", IN_CRISIS)
def test_words_of_someone_in_crisis_are_recognised(text):
    assert care.distress(text), text


@pytest.mark.parametrize("text", SPREADSHEET_TALK)
def test_spreadsheet_talk_is_never_taken_for_a_crisis(text):
    assert not care.distress(text), text


@pytest.mark.parametrize("mark", ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad"])
def test_words_of_someone_in_crisis_with_invisible_characters_in_them_are_still_recognised(mark):
    # AH-150: an invisible format character (a zero-width space, a joiner, a soft hyphen) inside or between the words
    # left the request unrecognised, and it went to the AI instead of getting the helpline message
    for text in (f"i want to kill{mark}myself", f"i want to kill {mark}myself", f"I feel sui{mark}cidal", f"I want to d{mark}ie"):
        assert care.distress(text), repr(text)


def test_the_care_message_names_the_lifeline_and_says_nothing_was_sent():
    assert "988" in care.MESSAGE and "findahelpline.com" in care.MESSAGE and "emergency" in care.MESSAGE
    assert "was not sent to the AI" in care.MESSAGE


def _no_network(monkeypatch):
    calls = []

    def refuse(*a, **k):
        calls.append(a)
        raise AssertionError("a care answer must never reach the network")
    monkeypatch.setattr(client.urllib.request, "urlopen", refuse)
    monkeypatch.setattr(client, "_call", refuse)
    return calls


def test_a_crisis_request_gets_the_care_answer_with_no_ai_call_and_nothing_cached(monkeypatch):
    calls = _no_network(monkeypatch)
    client.KEY_FILE.write_text("AIzaFakeKeyForTheTest_123")  # a key is set: still nothing is sent
    r = create_app().test_client().post("/fix", json={**BODY, "intent": "honestly I want to end my life"})
    assert r.status_code == 200 and r.get_json() == {"explanation": care.MESSAGE, "changes": [], "care": True}
    assert calls == []
    assert not client._cache_dir().exists() or list(client._cache_dir().iterdir()) == []


def test_a_crisis_request_sends_none_of_the_users_past_fixes_and_caches_nothing(monkeypatch):
    # AH-143: the past fixes the pane remembers ride along with Ask AI; a care answer still sends nothing at all
    calls = _no_network(monkeypatch)
    client.KEY_FILE.write_text("AIzaFakeKeyForTheTest_123")
    r = create_app().test_client().post("/fix", json={**BODY, "intent": "I want to die", "memory": ["Units: x: -5 -> 5"]})
    assert r.status_code == 200 and r.get_json() == {"explanation": care.MESSAGE, "changes": [], "care": True}
    assert calls == []
    assert not client._cache_dir().exists() or list(client._cache_dir().iterdir()) == []


def test_the_care_answer_needs_no_ai_key(monkeypatch):
    calls = _no_network(monkeypatch)
    assert not client.api_key_configured()
    r = create_app().test_client().post("/fix", json={**BODY, "intent": "I want to kill myself"})
    assert r.status_code == 200 and r.get_json()["care"] is True and calls == []


def test_ordinary_requests_still_go_to_the_ai_and_carry_no_care_flag(monkeypatch):
    monkeypatch.setattr(client, "api_key_configured", lambda: True)
    monkeypatch.setattr(client, "suggest_fix", lambda *a, **k: {"explanation": "ok", "changes": []})
    r = create_app().test_client().post("/fix", json={**BODY, "intent": "kill the duplicates"})
    assert r.status_code == 200 and "care" not in r.get_json()


def test_only_the_typed_request_is_read_never_the_sheet_or_the_reason(monkeypatch):
    monkeypatch.setattr(client, "api_key_configured", lambda: True)
    monkeypatch.setattr(client, "suggest_fix", lambda *a, **k: {"explanation": "ok", "changes": []})
    body = {**BODY, "columns": ["I want to kill myself", "Region", "Units"],
            "rows": [["I want to die", "East", 1]] * 3, "reason": "I want to kill myself", "intent": "fix it"}
    r = create_app().test_client().post("/fix", json=body)
    assert r.status_code == 200 and "care" not in r.get_json()


def test_a_hostile_body_with_crisis_words_is_still_a_clear_4xx(monkeypatch):
    _no_network(monkeypatch)
    c = create_app().test_client()
    for body in ({**BODY, "intent": "I want to die", "row_index": 99}, {**BODY, "intent": ["I want to die"]},
                 {**BODY, "intent": "I want to die " * 200}, {"intent": "I want to die"}):
        r = c.post("/fix", json=body)
        assert 400 <= r.status_code < 500 and r.is_json and "care" not in r.get_json(), body
    r = c.post("/fix", data="I want to die", content_type="application/json")
    assert 400 <= r.status_code < 500 and r.is_json


def test_the_care_route_answers_in_the_engines_own_json_with_the_usual_headers():
    r = create_app().test_client().post("/fix", json={**BODY, "intent": "I want to die"})
    assert r.headers.get("Referrer-Policy") == "no-referrer"
    assert server.LOG_AT not in r.get_data(as_text=True)
