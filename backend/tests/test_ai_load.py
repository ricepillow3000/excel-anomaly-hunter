"""The AI client under load: requests trimmed to fit, Google's busy spells retried, one call at a time, and
finished answers kept in a folder so a repeat never reaches Google. (John's 'agent 1' and 'agent 2'.)"""
import io
import json
import threading
import urllib.error

import pytest

from anomaly_hunter.ai import client

FIX = {"explanation": "Use 50.", "changes": [{"cell": "C3", "new": "50"}]}


def fake_google(monkeypatch, *answers, fix=FIX):
    """Stand-in for urlopen: each call takes the next answer - 200, an HTTP status, (status, body, headers) or an
    exception. -> list of the request bodies sent."""
    sent, todo = [], list(answers)

    def urlopen(req, timeout=None, **kw):
        sent.append(json.loads(req.data))
        a = todo.pop(0) if todo else 200
        if isinstance(a, Exception):
            raise a
        if isinstance(a, tuple):
            raise urllib.error.HTTPError(req.full_url, a[0], "x", a[2] if len(a) > 2 else {}, io.BytesIO(a[1].encode()))
        if a != 200:
            raise urllib.error.HTTPError(req.full_url, a, "x", {}, io.BytesIO(b"{}"))
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": json.dumps(fix)}}]}).encode())
    monkeypatch.setattr(client.urllib.request, "urlopen", urlopen)
    client.KEY_FILE.write_text("AIzaTest", encoding="utf-8")  # gitleaks:allow - made-up test key
    return sent


def test_google_busy_spells_are_retried_until_it_answers(monkeypatch):
    waits = []
    monkeypatch.setattr(client, "_sleep", waits.append)
    sent = fake_google(monkeypatch, 503, 503, TimeoutError(), 502, 200)
    assert client._ask("fix it").explanation == "Use 50."
    assert len(sent) == 5 and waits == pytest.approx([2.5, 4.5, 8.5, 16.5], abs=0.5)  # 2, 4, 8, 16 s + up to 1 s jitter


def test_what_retrying_cannot_help_fails_at_once(monkeypatch):
    for answer, words in [((429, '{"error": {"message": "Quota exceeded: GenerateRequestsPerDayPerProjectPerModel"}}'), "(?i)today"),
                          (400, "error 400"), (401, "did not accept"), (403, "did not accept"), (413, "too large")]:
        sent = fake_google(monkeypatch, answer)
        with pytest.raises(ValueError, match=words):
            client._ask("fix it")
        assert len(sent) == 1, answer


def test_retrying_stops_at_the_deadline_and_honours_retry_after(monkeypatch):
    clock, waits = [0.0], []
    monkeypatch.setattr(client.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(client, "_sleep", lambda s: (waits.append(s), clock.__setitem__(0, clock[0] + s)))
    sent = fake_google(monkeypatch, (429, "{}", {"Retry-After": "7"}), *[503] * 50)
    with pytest.raises(ValueError, match="busy"):
        client._ask("fix it")
    assert waits[0] == 7 and sum(waits) <= client.DEADLINE and len(sent) <= 1 + len(client.WAITS)


def test_the_relay_is_never_retried_by_the_engine(monkeypatch):
    """Each relay call counts against an invited user's daily fixes: the relay retries Google itself, once counted."""
    sent = fake_google(monkeypatch, 502)
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    with pytest.raises(ValueError):
        client._ask("fix it")
    assert len(sent) == 1


def test_every_request_fits_the_relay_and_the_flagged_cell_is_sent_whole(monkeypatch):
    sent = fake_google(monkeypatch)
    wide = [f"Column {j}" for j in range(60)]
    client.suggest_fix(wide, [[f"value {j}-{k}" for j in range(60)] for k in range(40)], 20, 0, 0, "Column 31 too high", "")
    client.suggest_fix(["Notes", "Units"], [["word " * 6000, k] for k in range(40)], 20, 0, 0, "Units too high", "")
    for body in sent:
        assert len(json.dumps(body).encode()) <= client.BUDGET
    assert "value 31-20" in sent[0]["messages"][0]["content"]


def test_the_ai_may_not_rewrite_a_cell_it_only_saw_part_of(monkeypatch):
    fake_google(monkeypatch, fix={"explanation": "x", "changes": [{"cell": "A22", "new": "short"}, {"cell": "B22", "new": "5"}]})
    out = client.suggest_fix(["Notes", "Units"], [["word " * 6000, k] for k in range(40)], 20, 0, 0, "Units too high", "")
    assert out["changes"] == [{"cell": "B22", "new": "5"}] and "A22" in out["explanation"]  # Notes was cut to fit: left alone


def test_a_flagged_cell_too_big_for_any_request_says_so(monkeypatch):
    sent = fake_google(monkeypatch)
    with pytest.raises(ValueError, match="too big"):
        client.suggest_fix(["A", "B"], [["x" * 20000, "y"]], 0, 0, 0, "A odd", "")
    assert sent == []  # nothing went to Google


def _odd_ask(log, fail_after=None):
    def ask(prompt, out, schema, name, deadline=None):
        log.append(prompt)
        body = {"model": client.GEMINI_MODEL, "messages": [{"role": "user", "content": prompt}],
                "response_format": {"type": "json_schema", "json_schema": {"name": name, "schema": schema}}}
        assert len(json.dumps(body).encode()) <= client.BUDGET
        if fail_after is not None and len(log) > fail_after:
            raise ValueError("Google AI is busy right now - try again in a few minutes.")
        cols = [c for c in VALUES if f'"{c}"' in prompt]
        return out(odd=[{"column": c, "value": VALUES[c][0], "why": "odd"} for c in cols])
    return ask


VALUES = {f"Col{j}": [f"category value {k}" for k in range(50)] for j in range(30)}


def test_a_big_word_check_goes_in_batches_and_merges(monkeypatch):
    log = []
    monkeypatch.setattr(client, "_ask", _odd_ask(log))
    hits, partial = client.odd_text(VALUES)
    assert len(log) > 1 and not partial and {h["column"] for h in hits} == set(VALUES)


def test_a_word_check_cut_short_by_google_keeps_what_was_finished(monkeypatch):
    log = []
    monkeypatch.setattr(client, "_ask", _odd_ask(log, fail_after=1))
    hits, partial = client.odd_text(VALUES)
    assert partial and hits and len(hits) < len(VALUES)
    monkeypatch.setattr(client, "_ask", _odd_ask([], fail_after=0))
    with pytest.raises(ValueError, match="busy"):  # nothing finished at all: say so
        client.odd_text(VALUES)


def test_finished_answers_are_kept_and_a_repeat_never_reaches_google(monkeypatch):
    sent = fake_google(monkeypatch)
    assert client._ask("fix row 5").explanation == client._ask("fix row 5").explanation == "Use 50."
    assert len(sent) == 1  # the repeat came from the folder of finished answers
    files = list(client._cache_dir().glob("*.json"))
    assert len(files) == 1 and "fix row 5" not in files[0].read_text(encoding="utf-8")  # the answer, never the prompt
    client._ask("fix row 6")
    assert len(sent) == 2


def test_the_finished_answers_folder_stays_small(monkeypatch):
    monkeypatch.setattr(client, "CACHE_MAX", 3)
    fake_google(monkeypatch)
    for k in range(6):
        client._ask(f"fix row {k}")
    assert len(list(client._cache_dir().glob("*.json"))) == 3


def test_one_ai_call_at_a_time(monkeypatch):
    inside, release = threading.Event(), threading.Event()

    def slow(req, timeout=None, **kw):
        inside.set()
        release.wait(5)
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": json.dumps(FIX)}}]}).encode())
    fake_google(monkeypatch)
    monkeypatch.setattr(client.urllib.request, "urlopen", slow)
    first = threading.Thread(target=client._ask, args=("fix row 1",))
    first.start()
    inside.wait(5)
    with pytest.raises(ValueError, match="other request"):
        client._ask("fix row 2")
    release.set()
    first.join(5)


def test_a_relay_call_may_wait_until_the_deadline_not_just_90_seconds(monkeypatch):
    """The relay itself tries Google 3 times and Gemini has taken over 90 s: a slow success must not be thrown away
    after the invite's call was already counted (Council 2026-10-12, B2)."""
    seen = []
    real = fake_google(monkeypatch)
    wrapped = client.urllib.request.urlopen
    monkeypatch.setattr(client.urllib.request, "urlopen", lambda req, timeout=None, **kw: (seen.append(timeout), wrapped(req, timeout))[1])
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    client._ask("fix it")
    assert real and seen[0] > 90


@pytest.mark.parametrize("status,body,words", [
    (429, '{"error": "used up for today"}', "used up for today"),
    (401, '{"error": "bad code"}', "bad code Ask John for a new invite code."),
    (500, "<html>1101</html>", "The AI relay answered with error 500"),
])
def test_the_relay_words_reach_the_user(monkeypatch, status, body, words):
    fake_google(monkeypatch, (status, body))
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    with pytest.raises(ValueError) as e:
        client._ask("fix it")
    assert words in str(e.value)


def test_a_claude_call_is_bounded_by_the_deadline_and_not_retried_by_the_sdk(monkeypatch):
    """SDK defaults are a 10-minute timeout and 2 retries, all while the one-call lock is held (Council B4)."""
    made = {}

    class FakeAnthropic:
        def __init__(self, **kw):
            made.update(kw)
            self.messages = self

        def parse(self, **kw):
            return type("R", (), {"parsed_output": client.Fix(explanation="x", changes=[]), "stop_reason": "end_turn"})()
    monkeypatch.setattr(client.anthropic, "Anthropic", FakeAnthropic)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    assert client.provider() == "claude"
    client._ask("fix it")
    assert made.get("max_retries") == 0 and 0 < made.get("timeout", 0) <= client.DEADLINE


def test_a_cut_off_google_answer_is_retried_then_answers(monkeypatch):
    # stress test 2026-10-16: http.client.IncompleteRead is neither an OSError nor a ValueError - it escaped as an HTTP
    # 500 in Werkzeug's words. A connection cut mid-answer is like a reset: tried again with the user's own key
    import http.client
    monkeypatch.setattr(client, "_sleep", lambda s: None)
    sent = fake_google(monkeypatch, http.client.IncompleteRead(b"x", 980), 200)
    assert client._ask("fix it").explanation == "Use 50." and len(sent) == 2


def test_a_cut_off_relay_answer_is_never_retried_and_says_so_in_our_words(monkeypatch):
    import http.client
    sent = fake_google(monkeypatch, http.client.IncompleteRead(b"x", 980))
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    with pytest.raises(ValueError, match="came back incomplete"):
        client._ask("fix it")
    assert len(sent) == 1  # the invite's fix was counted once already


def test_after_a_timeout_the_next_try_may_wait_until_the_deadline(monkeypatch):
    # stress test 2026-10-16: every own-key try was cut at 90 s, so a 100 s answer never came back - 3 requests reached
    # Google (each one counts against the free quota) and the user got nothing
    clock, seen = [0.0], []
    monkeypatch.setattr(client.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(client, "_sleep", lambda s: clock.__setitem__(0, clock[0] + s))
    fake_google(monkeypatch, TimeoutError(), 200)
    wrapped = client.urllib.request.urlopen

    def timed(req, timeout=None, **kw):
        seen.append(timeout)
        clock[0] += timeout if len(seen) == 1 else 100  # the first try times out; the second answers after 100 s
        return wrapped(req, timeout)
    monkeypatch.setattr(client.urllib.request, "urlopen", timed)
    assert client._ask("fix it").explanation == "Use 50."
    assert seen[0] == 90 and seen[1] > 100
