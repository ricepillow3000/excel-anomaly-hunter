"""AH-34 / AH-41: what Ask AI's answer becomes on the card. A change the card can't show is named, never dropped
silently under an explanation that claims it; a value written where the AI was never shown the sheet is left out;
a refusal, an answer cut off at its length and a request too long to send each say so in plain words. The prompt is
unchanged (that needs ai_eval numbers on John's own key). Synthetic sheets only."""
import io
import json

import pytest

from anomaly_hunter.ai import client

COLS = ["Name", "Dept", "Salary"]
REASON = "Dept Saels looks like a misspelling of Sales"


def sheet(n=5):
    rows = [[f"P{k}", "Sales", 50000 + k] for k in range(n)]
    rows[2][1] = "Saels"
    return rows


def answer(monkeypatch, *changes, explanation="I set B4 to Sales."):
    monkeypatch.setattr(client, "_ask", lambda prompt: client.Fix(explanation=explanation, changes=[
        client.CellChange(cell=c, new=v) for c, v in changes]))


def ask(rows=None, intent="", i=2):
    return client.suggest_fix(COLS, rows or sheet(), i, 0, 0, REASON, intent)


@pytest.mark.parametrize("cell", ["Sheet1!B4", "B4:B5", "'My data'!B4"])
def test_a_change_the_card_cannot_show_is_named_in_the_explanation(monkeypatch, cell):
    # the explanation said "I set B4 to Sales" over an empty card: the AI's change was dropped without a word
    answer(monkeypatch, (cell, "Sales"))
    out = ask()
    assert out["changes"] == [] and cell in out["explanation"] and "Left out" in out["explanation"], out


def test_more_changes_than_one_fix_takes_are_counted_in_the_explanation(monkeypatch):
    cols = [f"Q{j}" for j in range(10)]  # 11 rows x 10 columns shown: 60 different cells it saw
    answer(monkeypatch, *[(f"{'ABCDEFGHIJ'[k % 10]}{2 + k // 10}", str(k)) for k in range(60)], explanation="Done.")
    out = client.suggest_fix(cols, [[r] * 10 for r in range(20)], 2, 0, 0, "Q0 is odd", "number every cell")
    assert len(out["changes"]) == client.MAX_CHANGES and "10 more" in out["explanation"], out["explanation"]


def test_two_different_values_for_one_cell_are_both_left_out_and_said(monkeypatch):
    answer(monkeypatch, ("B4", "Sales"), ("B4", "Sale"))
    out = ask()
    assert out["changes"] == [] and "B4" in out["explanation"] and "two different values" in out["explanation"], out


def test_the_same_value_twice_is_one_change(monkeypatch):
    answer(monkeypatch, ("B4", "Sales"), ("b4", "Sales"))
    assert ask()["changes"] == [{"cell": "B4", "new": "Sales"}]


def test_a_value_in_a_row_the_ai_was_never_shown_is_left_out(monkeypatch):
    # "fix this typo in every row" on 100 rows: the AI is shown the 5 rows either side, so B62 and B90 were values it
    # never saw - written blind - and C90's formula overwrote a salary it never saw
    rows = sheet(100)
    rows[60][1] = "Saels"
    answer(monkeypatch, ("B4", "Sales"), ("B6", "Sales"), ("B62", "Sales"), ("B90", "Sales"), ("C90", "=C89+1"))
    out = ask(rows, "fix this typo in every row")
    assert [c["cell"] for c in out["changes"]] == ["B4", "B6"], out
    assert "B62, B90, C90" in out["explanation"] and "Find and Replace" in out["explanation"], out["explanation"]


def test_a_column_left_out_to_fit_is_not_written_blind(monkeypatch):
    # a wide row is trimmed to the columns nearest the flagged cell: a cell in a column the AI never saw is the same
    cols = ["Email"] + [f"Note {k}" for k in range(30)] + ["Amount"]
    rows = [[f"p{r}@x.com"] + ["n" * 190] * 30 + [100 + r] for r in range(20)]
    answer(monkeypatch, ("A7", "p5@x.com"), ("AF7", "105"))
    out = client.suggest_fix(cols, rows, 5, 0, 0, "Amount 105 is past its usual limit", "fix the email")
    assert [c["cell"] for c in out["changes"]] == ["AF7"] and "A7" in out["explanation"], out


def test_the_header_row_it_was_shown_may_still_be_changed_when_asked(monkeypatch):
    answer(monkeypatch, ("B1", "Department"))
    assert ask(intent="rename the Dept header to Department")["changes"] == [{"cell": "B1", "new": "Department"}]


def google(monkeypatch, payload):
    monkeypatch.setattr(client.urllib.request, "urlopen", lambda req, timeout=None, **kw: io.BytesIO(json.dumps(payload).encode()))
    client.KEY_FILE.write_text("AIzaTest", encoding="utf-8")  # gitleaks:allow - made-up test key


@pytest.mark.parametrize("payload", [
    {"choices": [{"finish_reason": "content_filter", "message": {"role": "assistant"}}]},
    {"choices": [{"finish_reason": "content_filter", "message": {"content": None}}]},
    {"choices": [], "promptFeedback": {"blockReason": "SAFETY"}},
])
def test_a_refusal_says_the_ai_declined_never_try_again(monkeypatch, payload):
    # "came back incomplete - try again" for a refusal: trying again gets the same refusal
    google(monkeypatch, payload)
    with pytest.raises(ValueError) as e:
        ask(intent="fix it")
    assert "declined" in str(e.value) and "incomplete" not in str(e.value), e.value


def test_an_answer_cut_off_at_its_length_says_to_ask_for_less(monkeypatch):
    google(monkeypatch, {"choices": [{"finish_reason": "length", "message": {
        "content": '{"explanation": "Set B4", "changes": [{"cell": "B4", "new": "Sal'}}]})
    with pytest.raises(ValueError) as e:
        ask(intent="fix it")
    assert "too long" in str(e.value) and "fewer" in str(e.value), e.value


def test_a_good_answer_still_lands_whole(monkeypatch):
    google(monkeypatch, {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps(
        {"explanation": "A letter swap.", "changes": [{"cell": "B4", "new": "Sales"}]})}}]})
    assert ask() == {"explanation": "A letter swap.", "changes": [{"cell": "B4", "new": "Sales"}]}


def test_a_request_too_long_to_send_says_the_request_is_the_part_to_shorten(monkeypatch):
    # 2,000 Japanese letters are 6,000 bytes: the old words blamed "its longest cell"
    answer(monkeypatch)
    with pytest.raises(ValueError) as e:
        ask(intent="日" * 2000)
    assert "request" in str(e.value) and "longest cell" not in str(e.value), e.value


def test_a_refusal_through_the_relay_says_the_same(monkeypatch):
    # the relay passes Google's answer back as it is: the same words, and the invite's fix is not asked for again
    calls = []
    monkeypatch.setattr(client, "RELAY_URL", "http://127.0.0.1:9")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    monkeypatch.setattr(client.urllib.request, "urlopen", lambda req, timeout=None, **kw: calls.append(req.full_url) or io.BytesIO(
        json.dumps({"choices": [{"finish_reason": "content_filter", "message": {}}]}).encode()))
    assert client.provider() == "relay"
    with pytest.raises(ValueError) as e:
        ask(intent="fix it")
    assert "declined" in str(e.value) and calls == ["http://127.0.0.1:9/fix"], (e.value, calls)
