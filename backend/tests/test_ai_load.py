"""The AI client under load: requests trimmed to fit, Google's busy spells retried, one call at a time, and
finished answers kept in a folder so a repeat never reaches Google. (John's 'agent 1' and 'agent 2'.)"""
import io
import json
import threading
import urllib.error

import pytest

from anomaly_hunter.ai import client

FIX = {"explanation": "Use 50.", "changes": [{"cell": "C3", "new": "50"}]}
WIRE = []  # the raw bytes of each request fake_google received: what the relay's 8 KB limit counts


def fake_google(monkeypatch, *answers, fix=FIX):
    """Stand-in for urlopen: each call takes the next answer - 200, an HTTP status, (status, body, headers) or an
    exception. -> list of the request bodies sent."""
    sent, todo = [], list(answers)
    WIRE.clear()

    def urlopen(req, timeout=None, **kw):
        WIRE.append(req.data)
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
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ())  # the main model alone: its own retries (AH-145 backups below)
    waits = []
    monkeypatch.setattr(client, "_sleep", waits.append)
    sent = fake_google(monkeypatch, 503, 503, TimeoutError(), 502, 200)
    assert client._ask("fix it").explanation == "Use 50."
    assert len(sent) == 5 and waits == pytest.approx([2.5, 4.5, 8.5, 16.5], abs=0.5)  # 2, 4, 8, 16 s + up to 1 s jitter


def test_what_retrying_cannot_help_fails_at_once(monkeypatch):
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ())  # the main model alone: its own retries (AH-145 backups below)
    for answer, words in [((429, '{"error": {"message": "Quota exceeded: GenerateRequestsPerDayPerProjectPerModel"}}'), "(?i)today"),
                          (400, "error 400"), (401, "did not accept"), (403, "did not accept"), (413, "too large")]:
        sent = fake_google(monkeypatch, answer)
        with pytest.raises(ValueError, match=words):
            client._ask("fix it")
        assert len(sent) == 1, answer


def test_retrying_stops_at_the_deadline_and_honours_retry_after(monkeypatch):
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ())  # the main model alone: its own retries (AH-145 backups below)
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
    assert len(WIRE) == len(sent) == 2 and all(len(raw) <= client.BUDGET for raw in WIRE)
    assert "value 31-20" in sent[0]["messages"][0]["content"]


def test_a_japanese_word_check_is_sent_as_utf8_and_needs_fewer_requests(monkeypatch):
    # every non-ASCII letter went out as a 6-byte \uXXXX escape: this sheet took 4 requests (2026-10-16)
    fake_google(monkeypatch, fix={"odd": []})
    hits, partial = client.odd_text({f"列{j}": [f"東京都の支店{k}号" for k in range(40)] for j in range(12)})
    assert hits == [] and not partial and 1 <= len(WIRE) < 4
    assert all(len(raw) <= client.BUDGET and b"\\u" not in raw and "東京都".encode() in raw for raw in WIRE)


def test_a_lone_surrogate_is_sent_as_a_question_mark_not_an_error(monkeypatch):
    # valid JSON from the pane can hold one ("\ud800"); a strict UTF-8 encode would turn it into a 502
    fake_google(monkeypatch, fix={"odd": []})
    assert client.odd_text({"Item": ["Pen", "Desk\ud800"]}) == ([], False)
    assert b"Desk?" in WIRE[0] and WIRE[0].decode("utf-8")


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
        assert len(client._wire(prompt, schema, name)) <= client.BUDGET
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


def _sent(prompt):
    """The {column: values} a word-check prompt carries."""
    return json.loads(prompt.split("\n")[1])


def test_a_word_check_never_splits_a_column_that_fits_one_request(monkeypatch):
    # a column split across requests was judged without the rest of its values: "different from the rest of that
    # column" can't be answered from 5 of its 50 (299 split columns on 150 random sheets, 2026-10-16 council)
    log = []
    monkeypatch.setattr(client, "_ask", _odd_ask(log))
    client.odd_text(VALUES)
    seen = [c for p in log for c in _sent(p)]
    assert sorted(seen) == sorted(VALUES) and len(log) <= 6
    assert all(list(_sent(p)) == [c for c in VALUES if c in _sent(p)] for p in log)  # sheet order inside each


def test_a_sheet_that_fits_one_request_sends_todays_exact_prompt(monkeypatch):
    log = []
    monkeypatch.setattr(client, "_ask", _odd_ask(log))
    small = {"Item": ["Pen", "Desk", "London", "x" * 61], "Region": ["East", "West"], "Notes": ["y" * 70]}
    client.odd_text(small)
    assert log == [client._odd_prompt({"Item": ["Pen", "Desk", "London"], "Region": ["East", "West"]})]


def test_a_column_too_big_for_one_request_is_still_checked_in_parts(monkeypatch):
    log = []
    monkeypatch.setattr(client, "_ask", _odd_ask(log))
    big = {"Small": ["a", "b"], "Big": [f"{'w' * 50} {k}" for k in range(300)], "Tail": ["c", "d"]}
    client.odd_text(big)
    parts = [v for p in log for v in _sent(p).get("Big", [])]
    assert sorted(parts) == sorted(big["Big"]) and len(log) > 1
    assert sum("Small" in _sent(p) for p in log) == sum("Tail" in _sent(p) for p in log) == 1


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


@pytest.mark.parametrize("error", [{"message": "x"}, ["busy"], 5, None, True, ""])
def test_a_relay_error_that_is_not_text_is_said_in_our_own_words(monkeypatch, error):
    # AH-150: the relay's "error" went to the pane as it came: a dict or a list was a crash, not words
    fake_google(monkeypatch, (502, json.dumps({"error": error})))
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    with pytest.raises(ValueError) as e:
        client._ask("fix it")
    assert str(e.value) == "The AI relay answered with error 502. Try again later."


def test_the_relays_words_reach_the_user_as_one_short_line_with_no_invite_code_in_it(monkeypatch):
    # AH-150: any length, line breaks, and the invite code itself if the relay ever echoed it, went to the pane verbatim
    invite = "inv_" + "a" * 24
    fake_google(monkeypatch, (429, json.dumps({"error": f"Used up for today.\nYour code {invite} " + "x" * 500})))
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text(invite, encoding="utf-8")
    with pytest.raises(client.Limit) as e:
        client._ask("fix it")
    said = str(e.value)
    assert said.startswith("Used up for today. Your code [the AI key] xxx") and len(said) <= 200
    assert "\n" not in said and invite not in said and e.value.limit == "day"


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


def test_a_column_whose_name_alone_is_too_big_for_a_request_is_left_out_and_the_rest_still_checked(monkeypatch):
    # AH-13 sweep: a 5,000-emoji header could never fit, so its every part went over the relay's 8 KB and the first
    # request failed the whole word check ("too large") - one odd header switched the check off for every column
    log = []
    monkeypatch.setattr(client, "_ask", _odd_ask(log))  # it asserts each request fits the budget
    huge = "🦀" * 5000
    hits, partial = client.odd_text({huge: ["Pen", "Desk", "London"], "Col0": ["category value 0", "category value 1"]})
    assert log and not partial and all(huge not in p for p in log)
    assert [h["column"] for h in hits] == ["Col0"]


def _old_widest(columns, rows, i, reason, intent):
    """The rule before AH-140, kept here to hold the new one to it: every column count from n-1 down, one by one."""
    hits = [j for j, c in enumerate(columns) if str(c) and str(c) in (reason or "")]
    flagged = max(hits, key=lambda j: len(str(columns[j])), default=0)
    nearest = sorted(range(len(columns)), key=lambda j: abs(j - flagged))
    for ctx, n in [(c, len(columns)) for c in (5, 2, 0)] + [(0, n) for n in range(len(columns) - 1, 0, -1)]:
        prompt = client._fix_prompt(columns, rows, i, 0, 0, reason, intent, None, ctx=ctx, keep=sorted(nearest[:n]),
                                    cut=set(), flagged=flagged)
        if client._fits(prompt):
            return prompt


@pytest.mark.parametrize("width", [3, 40, 61, 150, 777])
def test_the_widest_ask_ai_request_that_fits_is_the_same_one_the_column_by_column_rule_chose(monkeypatch, width):
    # AH-140: the old rule rebuilt the prompt for every column count (16,000 columns: 81 s before any AI call)
    log = []
    monkeypatch.setattr(client, "_ask", lambda prompt, *a, **k: log.append(prompt) or client.Fix(explanation="x", changes=[]))
    columns = [f"Column {j} " + "w" * (j % 13) for j in range(width)]
    rows = [[f"value {j}-{k}" for j in range(width)] for k in range(12)]
    reason = f"{columns[width // 2]} too high"
    client.suggest_fix(columns, rows, 6, 0, 0, reason, "")
    assert log == [_old_widest(columns, rows, 6, reason, "")]


def test_a_very_wide_row_is_fitted_to_one_request_in_seconds(monkeypatch):
    import time
    monkeypatch.setattr(client, "_ask", lambda prompt, *a, **k: client.Fix(explanation="x", changes=[]))
    columns = [f"Column {j}" for j in range(8000)]  # column by column: ~20 s on this box
    started = time.monotonic()
    client.suggest_fix(columns, [[f"v{j}" for j in range(8000)]], 0, 0, 0, "Column 4000 too high", "")
    assert time.monotonic() - started < 3


# AH-145: gemini-3.8-flash gives a free key 20 requests a day and was overloaded for hours (503 "high demand") while
# other free models answered: each model has its own quota. With backups configured, a used-up day or an overload goes
# to the next model at once; empty, nothing changes
DAILY = (429, '{"error": {"message": "Quota exceeded for metric: GenerateRequestsPerDayPerProjectPerModel-FreeTier"}}')
MINUTE = (429, '{"error": {"message": "Quota exceeded for metric: GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}}')


@pytest.mark.parametrize("first", [DAILY, 503, 502])
def test_a_used_up_day_or_an_overload_is_answered_by_the_next_model_at_once(monkeypatch, first):
    waits = []
    monkeypatch.setattr(client, "_sleep", waits.append)
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ("gemini-backup-a", "gemini-backup-b"))
    sent = fake_google(monkeypatch, first, 200)
    assert client._ask("fix it").explanation == "Use 50."
    assert [s["model"] for s in sent] == [client.GEMINI_MODEL, "gemini-backup-a"] and waits == []
    assert {k: v for k, v in sent[1].items() if k != "model"} == {k: v for k, v in sent[0].items() if k != "model"}


def test_a_per_minute_limit_waits_for_the_same_model_and_never_switches(monkeypatch):
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ("gemini-backup-a",))
    sent = fake_google(monkeypatch, MINUTE, 200)
    assert client._ask("fix it").explanation == "Use 50."
    assert [s["model"] for s in sent] == [client.GEMINI_MODEL] * 2


def test_with_no_backup_models_a_used_up_day_and_an_overload_say_what_they_said_before(monkeypatch):
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ())  # no backup configured: the words from before AH-145
    sent = fake_google(monkeypatch, DAILY)
    with pytest.raises(ValueError) as e:
        client._ask("fix it")
    assert str(e.value) == "Today's free Google AI limit is used up. It resets at midnight Pacific time." and len(sent) == 1
    sent = fake_google(monkeypatch, *[503] * 10)
    with pytest.raises(ValueError) as e:
        client._ask("fix it")
    assert str(e.value) == "Google AI is busy right now. Try again in a few minutes."
    assert len(sent) == 1 + len(client.WAITS) and {s["model"] for s in sent} == {client.GEMINI_MODEL}


def test_when_every_model_is_used_up_for_today_the_user_hears_it_once(monkeypatch):
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ("gemini-backup-a",))
    sent = fake_google(monkeypatch, DAILY, DAILY)
    with pytest.raises(ValueError, match="used up. It resets at midnight"):
        client._ask("fix it")
    assert [s["model"] for s in sent] == [client.GEMINI_MODEL, "gemini-backup-a"]


def test_a_finished_answer_is_kept_under_the_model_that_gave_it(monkeypatch):
    key = lambda model: client.hashlib.sha256(json.dumps(["gemini", client.MODEL, model, "fix", "fix it"]).encode()).hexdigest()
    fake_google(monkeypatch)
    client._ask("fix it")  # the main model answered: the same file name as before AH-145
    assert [f.stem for f in client._cache_dir().glob("*.json")] == [key(client.GEMINI_MODEL)]
    for f in client._cache_dir().glob("*.json"):
        f.unlink()
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ("gemini-backup-a",))
    sent = fake_google(monkeypatch, 503, 200)
    client._ask("fix it")
    assert [f.stem for f in client._cache_dir().glob("*.json")] == [key("gemini-backup-a")]
    assert client._ask("fix it").explanation == "Use 50." and len(sent) == 2  # the repeat is the backup's kept answer


ASK = {"columns": ["OrderDate", "Region", "Units"], "row_index": 1, "start_row": 0, "start_col": 0, "reason": "Units below weird low 0",
       "rows": [["2026-01-06", "East", 95], ["2026-01-07", "West", -5], ["2026-01-08", "East", 50]]}


def test_the_fix_names_its_model_only_when_a_backup_answered(monkeypatch):
    # the pane tells the user a backup answered (John, 2026-11-06): the engine says so only then
    from anomaly_hunter.server import create_app
    app = create_app().test_client()
    fake_google(monkeypatch, fix={"explanation": "Use 5.", "changes": [{"cell": "C3", "new": "5"}]})
    assert "model" not in app.post("/fix", json=ASK).get_json()
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ("gemini-backup-a",))
    fake_google(monkeypatch, 503, fix={"explanation": "Use 6.", "changes": [{"cell": "C3", "new": "6"}]})
    out = app.post("/fix", json={**ASK, "intent": "another"}).get_json()
    assert out["model"] == "gemini-backup-a" and out["changes"] == [{"cell": "C3", "new": "6"}]
    assert app.post("/fix", json={**ASK, "intent": "another"}).get_json()["model"] == "gemini-backup-a"  # kept answer, same words


def test_a_relay_answer_from_a_backup_model_is_named_and_kept_under_it(monkeypatch):
    sent = fake_google(monkeypatch)
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    real = client.urllib.request.urlopen

    def backup(req, timeout=None, **kw):  # relay/worker.js says which backup answered in X-Model
        r = real(req, timeout)
        r.headers = {"X-Model": "gemini-3.6-flash"}
        return r
    monkeypatch.setattr(client.urllib.request, "urlopen", backup)
    out = client.suggest_fix(ASK["columns"], ASK["rows"], 1, 0, 0, ASK["reason"], "")
    assert out["model"] == "gemini-3.6-flash" and len(sent) == 1
    key = client.hashlib.sha256(json.dumps(["relay", client.MODEL, "gemini-3.6-flash", "fix", sent[0]["messages"][0]["content"]]).encode()).hexdigest()
    assert [f.stem for f in client._cache_dir().glob("*.json")] == [key]


@pytest.mark.parametrize("answers,limit,words", [
    ((DAILY,), "day", "Today's free Google AI limit is used up. It resets at midnight Pacific time."),
    ((503,) * 10, "busy", "Google AI is busy right now. Try again in a few minutes."),
    ((400,), None, "Google AI answered with error 400. Try again in a few minutes."),
])
def test_a_used_up_day_or_google_busy_is_tagged_so_the_pane_can_say_it_and_the_words_stay(monkeypatch, answers, limit, words):
    # John, 2026-11-06: the pane says in its notice box when every model is used up for today or busy
    from anomaly_hunter.server import create_app
    monkeypatch.setattr(client, "GEMINI_FALLBACKS", ())  # the main model alone: its own retries
    fake_google(monkeypatch, *answers)
    r = create_app().test_client().post("/fix", json=ASK)
    assert r.status_code == 502 and r.get_json().get("error") == words and r.get_json().get("limit") == limit


@pytest.mark.parametrize("status,said,limit", [
    (429, "The shared free AI is used up for today. It resets at midnight US Pacific time.", "day"),
    (429, "You've used today's AI fixes for this invite. They reset at midnight US Pacific time.", "day"),
    (429, "The shared AI is busy right now. Try again in a minute.", "busy"),
    (502, "Google AI answered with error 503. Try again in a few minutes.", "busy"),
    (502, "Google AI answered with error 403. Try again in a few minutes.", None),
])
def test_the_relays_used_up_day_and_busy_are_tagged_too(monkeypatch, status, said, limit):
    from anomaly_hunter.server import create_app
    fake_google(monkeypatch, (status, json.dumps({"error": said})))
    client.KEY_FILE.unlink()
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    out = create_app().test_client().post("/fix", json=ASK).get_json()
    assert out["error"] == said and out.get("limit") == limit
