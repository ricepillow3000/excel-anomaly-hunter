"""The AI eval's own guards, with no key and no network: it never reaches the relay or Claude, never prints a key,
never answers from the cache, and scores the labels the way score.py does."""
import io
import json
import os
import sys
import urllib.error
from pathlib import Path

import pytest

from anomaly_hunter.ai import client

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bench"))
import ai_eval

REPO = str(Path(__file__).resolve().parents[2])
KEY = "AIzaFAKE-eval-key-123"  # gitleaks:allow - made-up test key
CASE = {"id": "t:units", "kind": "decimal_x10", "columns": ["Region", "Units"], "rows": [["East", 5], ["West", 6], ["East", 5], ["West", 500]],
        "i": 3, "start_row": 0, "start_col": 0, "reason": "Units weird limit is 20; this is 500 (likely 50)", "intent": "",
        "limits": {}, "cell": "B5", "true": 50, "raw": 500}
ODD1 = [({"Item": ["Pen", "Desk", "London"]}, {"London"}, set(), {"Desk"})]


@pytest.fixture
def run(monkeypatch, tmp_path):
    """ai_eval.main on one fix case (and optionally one word check) against a fake Google -> (exit code, urls, out)."""
    for name in ("_body", "_fix_prompt", "_odd_prompt", "provider", "gemini_key"):
        monkeypatch.setattr(client, name, getattr(client, name))  # main swaps these in its own process: put them back
    monkeypatch.setattr(client.urllib.request, "urlopen", client.urllib.request.urlopen)
    urls, todo, hooks, jobs = [], [], [], ai_eval.jobs

    def google(req, timeout=None, **kw):
        urls.append(req.full_url)
        for hook in hooks:
            hook()
        if todo:
            raise todo.pop(0)
        name = json.loads(req.data)["response_format"]["json_schema"]["name"]
        ans = {"odd": [{"column": "Item", "value": "London", "why": "a city"}]} if name == "odd" else \
            {"explanation": "x10 typo.", "changes": [{"cell": "B5", "new": "50"}]}
        return io.BytesIO(json.dumps({"model": "gemini-test", "choices": [{"message": {"content": json.dumps(ans)}, "finish_reason": "stop"}]}).encode())

    def go(*flags, odd=(), fail=(), hook=None):
        monkeypatch.setattr(client.urllib.request, "urlopen", google)
        monkeypatch.setattr(ai_eval, "jobs", lambda s, r: jobs(s, r, fix=[CASE], odd=list(odd)))
        todo[:], hooks[:] = list(fail), [hook] if hook else []
        code = ai_eval.main([REPO, "--out", str(tmp_path / "results.jsonl"), *flags])
        return code, urls, (tmp_path / "results.jsonl").read_text(encoding="utf-8") if (tmp_path / "results.jsonl").exists() else ""
    return go


def test_the_ai_eval_dry_run_sends_nothing_and_counts_requests_and_bytes(run, monkeypatch, capsys):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    code, urls, results = run("--dry-run", odd=ODD1)
    out = capsys.readouterr().out
    assert code == 0 and urls == [] and results == ""
    assert "2 requests per run x 3 runs = 6" in out and "Dry run: nothing was sent." in out
    code, urls, _ = run()  # a real key but no --yes: only the estimate
    assert code == 0 and urls == [] and "Add --yes" in capsys.readouterr().out


def test_the_ai_eval_refuses_the_relay_and_invite_codes(run, monkeypatch, capsys):
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    assert client.provider() == "relay"  # the app would use the relay here; the eval must not
    code, urls, _ = run("--yes")
    assert code == 2 and urls == [] and "Nothing was sent" in capsys.readouterr().out


def test_every_eval_request_goes_to_google_even_if_the_key_is_removed_mid_run(run, monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    code, urls, _ = run("--yes", "--runs", "2", odd=ODD1, hook=lambda: os.environ.pop("GEMINI_API_KEY", None))
    assert code == 0 and len(urls) == 4 and set(urls) == {client.GEMINI_URL}


def test_the_key_never_appears_in_eval_output(run, monkeypatch, capsys):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    echo = urllib.error.HTTPError(client.GEMINI_URL, 400, "x", {}, io.BytesIO(f'{{"error": "API key not valid: {KEY}"}}'.encode()))
    code, urls, results = run("--yes", "--runs", "2", odd=ODD1, fail=[echo])
    out, err = capsys.readouterr()
    assert code == 0 and urls and results
    assert KEY not in out + err + results and "AIzaFAKE" not in out + err + results


def test_two_eval_runs_send_two_requests_and_a_rerun_sends_none(run, monkeypatch, capsys):
    monkeypatch.setenv("GEMINI_API_KEY", KEY)
    code, urls, results = run("--yes", "--runs", "2")
    assert code == 0 and len(urls) == 2  # the answer cache is skipped: every run asks Google
    assert [json.loads(x)["answer"]["changes"] for x in results.splitlines()] == [[{"cell": "B5", "new": "50"}]] * 2
    assert "right 1/1 cases" in capsys.readouterr().out
    urls.clear()
    assert run("--yes", "--runs", "2")[1] == []  # finished cases with the same prompt are not asked again
    run("--yes", "--runs", "3", "--max-requests", "0")
    assert urls == [] and "Stopped at --max-requests 0" in capsys.readouterr().out


def test_the_scorer_gives_full_marks_to_the_labelled_answers_and_calls_a_median_in_a_blank_invented():
    hand = {c["id"]: c for c in ai_eval.hand_cases()}
    assert all(c["flagged"] for c in hand.values())  # the real engine flags every hand-made row
    good = {"hand:inject_cell": [{"cell": "C22", "new": "50"}], "hand:blank_unknown": [], "hand:honest_ceo": [],
            "hand:formula_row": [{"cell": "B22", "new": "50"}], "hand:typed_median": [{"cell": "C22", "new": "=MEDIAN(C2:C21,C23:C41)"}],
            "hand:typed_every_row": [{"cell": "B5", "new": "Central"}, {"cell": "B26", "new": "Central"}]}
    for cid, changes in good.items():
        assert ai_eval.right(hand[cid], changes) and not ai_eval.invented(hand[cid], changes), cid
    median = [{"cell": "C22", "new": "50"}]  # a plausible value nothing in the sheet supports
    assert ai_eval.invented(hand["hand:blank_unknown"], median) and ai_eval.checked_clean(hand["hand:blank_unknown"], median)
    assert not ai_eval.right(hand["hand:formula_row"], [{"cell": "B22", "new": "50"}, {"cell": "D22", "new": "125"}])  # overwrote the formula
    assert not ai_eval.right(hand["hand:typed_median"], [{"cell": "C22", "new": "=MEDIAN(C2:C41)"}])  # circular
    tv = {**CASE, "kind": "text_variant", "raw": " east", "cell": "A3"}
    assert ai_eval.right(tv, [{"cell": "A3", "new": "East"}]) and not ai_eval.right(tv, [{"cell": "A3", "new": "West"}])
    assert ai_eval.right({**CASE, "kind": "excel_error"}, []) and ai_eval.invented({**CASE, "kind": "excel_error"}, [{"cell": "B5", "new": "0"}])


def test_every_golden_case_is_flagged_and_fits_one_request():
    jobs = ai_eval.jobs("dev", REPO)
    fix = [c for c, _ in jobs if "odd" not in c]
    assert len({c["kind"] for c in fix if not c["id"].startswith("hand:")}) >= 15 and len(fix) >= 40
    for case, job in jobs:
        prompts = ai_eval._prompts(job)  # raises if the case is too big to send
        assert prompts and all(len(client._wire(p, client.ODD_SCHEMA if "odd" in case else client.FIX_SCHEMA,
                                                "odd" if "odd" in case else "fix")) <= client.BUDGET for p in prompts), case["id"]
