"""The scan answers from the rows it is sent, and Ask AI sees only the flagged row's own neighbourhood (AH-12).

A scan that pretended (a canned answer, a cached verdict, flags tied to row positions) or an AI prompt that carried more
than the sheet's own context would pass every test that only checks the happy path, so these test the claims head on."""
import random
import re

import pytest

from anomaly_hunter.ai import client
from anomaly_hunter.server import create_app

COLS = ["Region", "Product", "Units", "Price"]


def sheet(n=40, seed=3):
    """A plain orders table with no duplicates, no dates and no planted problem."""
    rnd = random.Random(seed)
    return [[rnd.choice(["East", "West", "North", "South"]), f"Item {k:03}", rnd.randint(40, 60), round(rnd.uniform(9, 11), 2)]
            for k in range(n)]


def scan(cols, rows):
    r = create_app().test_client().post("/scan", json={"columns": cols, "rows": rows, "limits": None})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["rows"]


def flagged(out):
    return {i for i, r in enumerate(out) if r["severity"] in ("High", "Medium", "Low")}


def test_changing_one_cell_changes_the_answer_for_that_row():
    rows = sheet()
    before = scan(COLS, rows)
    assert flagged(before) == set()  # nothing to find in a clean table
    for value, word in ((5000, "Units"), (-50, "Units")):
        bad = [list(r) for r in rows]
        bad[17][2] = value
        after = scan(COLS, bad)
        assert flagged(after) == {17}, (value, after[17])
        assert word in after[17]["reason"] and str(value) in after[17]["reason"]
    # and putting the cell back gives the clean answer again: nothing is remembered between scans
    assert scan(COLS, rows) == before


def test_shuffled_rows_give_the_same_answer_for_the_same_row_values():
    rows = sheet(60)
    rows[11][2], rows[42][3] = 4800, -10.5  # two planted slips
    out = scan(COLS, rows)
    assert flagged(out) == {11, 42}
    order = list(range(len(rows)))
    random.Random(9).shuffle(order)
    moved = scan(COLS, [rows[k] for k in order])
    for new, old in enumerate(order):  # the same values get the same verdict, wherever the row now sits
        assert (moved[new]["severity"], moved[new]["reason"]) == (out[old]["severity"], out[old]["reason"]), rows[old]


def test_no_answer_is_canned_unrelated_sheets_share_no_reason():
    orders = sheet()
    orders[5][2] = 9000
    patients = [[f"P{k:03}", 30 + k % 40, round(36.4 + (k % 7) / 10, 1)] for k in range(40)]
    patients[20][2] = 381.0  # a temperature typed x10
    a = scan(COLS, orders)
    b = scan(["Patient", "Age", "Temp C"], patients)
    ra = {r["reason"] for r in a if r["reason"]}
    rb = {r["reason"] for r in b if r["reason"]}
    assert ra and rb and not ra & rb
    assert all("Units" in x or "Price" in x or "Region" in x or "Product" in x for x in ra)  # each names its own sheet's columns
    assert all("Temp C" in x or "Age" in x or "Patient" in x for x in rb)
    assert flagged(a) == {5} and flagged(b) == {20}


def test_an_empty_sheet_and_a_one_row_sheet_each_get_a_clear_answer():
    c = create_app().test_client()
    empty = c.post("/scan", json={"columns": COLS, "rows": []})
    assert empty.status_code == 200
    body = empty.get_json()
    assert body["rows"] == [] and body["summary"]["severity_counts"] == {} and "error" not in body
    one = c.post("/scan", json={"columns": COLS, "rows": [["East", "Item 001", 50, 10.0]]})
    assert one.status_code == 200
    rows = one.get_json()["rows"]
    assert len(rows) == 1 and rows[0]["severity"] is None  # one row has nothing to be compared with: no invented flag
    none = c.post("/scan", json={"columns": [], "rows": []})
    assert none.status_code == 400 and none.get_json()["error"]


# ---- Ask AI: the prompt carries only the sheet's own context ----

ASK_COLS = ["Code", "Region", "Units"]
# Every line a fix prompt may hold: our fixed words, or one of our labels with the sheet's own data after it. Matched
# whole (no catch-all, no empty prefix: "" would let any line through, as Agent 2 showed in review, 2026-10-22);
# a blank line is allowed only when it is truly empty.
OUR_LINES = [re.compile(x) for x in (
    r"You fix one flagged row in an Excel sheet\. Answer with cell writes the user will preview and approve\.",
    r"The user could be in any field - finance, healthcare, supply chain, construction, research\.\.\. Infer it from the "
    r"headers and values and follow that field's conventions and units\.",
    r"Data range: [A-Z]+\d+:[A-Z]+\d+ \(row \d+ = headers\)\.",
    r"Columns: [A-Z]+=.*", r"Flagged row \d+: [A-Z]+\d+=.*", r"row \d+: [A-Z]+\d+=.*", r"Formulas in that row: .*",
    r"Why it was flagged: .*", r"Nearby rows for context:", r"\(left out to keep the request small\)", r"User's request: .*",
    r"Rules: each change is one cell .*")]


def only_our_lines(prompt):
    """The prompt's lines that are not ours (empty = all ours)."""
    return [x for x in prompt.splitlines() if x and not any(r.fullmatch(x) for r in OUR_LINES)]


@pytest.fixture
def prompts(monkeypatch, tmp_path):
    """POST /fix with the answer step swapped for one that only records the prompt -> (post, list of prompts)."""
    seen = []
    monkeypatch.setattr(client, "KEY_FILE", tmp_path / "gemini-key.txt")
    monkeypatch.setattr(client, "INVITE_FILE", tmp_path / "invite-code.txt")
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaSECRET-key-should-never-be-in-a-prompt")  # gitleaks:allow - made-up
    client.INVITE_FILE.write_text("inv_SECRETinvitecodeneverinaprompt", encoding="utf-8")
    monkeypatch.setattr(client, "_ask", lambda p, *a, **k: seen.append(p) or client.Fix(explanation="ok", changes=[]))
    app = create_app().test_client()
    return (lambda body: app.post("/fix", json=body)), seen


def test_the_ai_prompt_holds_only_the_flagged_row_its_neighbours_the_headers_the_reason_and_the_request(prompts):
    post, seen = prompts
    rows = [[f"tok{k:02}x", "East" if k % 2 else "West", 100 + k] for k in range(30)]  # every row's Code is unique
    body = {"columns": ASK_COLS, "rows": rows, "row_index": 15, "start_row": 0, "start_col": 0,
            "reason": "Units weird limit is 120; this is 115", "intent": "use the median",
            # things that are not this row's context, in a body field the route does not read: never in the prompt
            "other_sheet": {"Salaries": [["tokSALARYx", 99999]]}, "workbook": "tokWORKBOOKx"}
    assert post(body).status_code == 200
    (p,) = seen
    shown = set(re.findall(r"tok\d\dx", p))
    assert shown == {f"tok{k:02}x" for k in range(10, 21)}  # the flagged row and 5 above and below, nothing further
    for word in ("tokSALARYx", "tokWORKBOOKx", "Salaries", "SECRET", "AIza", "inv_"):
        assert word not in p, word
    assert "Columns: A=Code, B=Region, C=Units" in p and body["reason"] in p and "User's request: use the median" in p
    assert only_our_lines(p) == []


def test_the_only_our_lines_check_can_fail():
    # the check above must catch a line we never meant to send, wherever it goes, and one that copies our labels loosely
    good = client._fix_prompt(ASK_COLS, [["a", "East", 1], ["b", "West", 2]], 1, 0, 0, "Units odd", "")
    assert only_our_lines(good) == [] and "\n\n" in good  # our own blank lines pass
    for stray in ("Something we never meant to send", "row of secrets: x", "Columns:", " ", "Rules:"):
        assert only_our_lines(good + "\n" + stray) == [stray], stray
        assert only_our_lines(stray + "\n" + good) == [stray], stray


def test_with_no_typed_request_the_ai_is_asked_only_for_the_flagged_row(prompts):
    post, seen = prompts
    rows = [[f"tok{k:02}x", "East", 100 + k] for k in range(3)]
    assert post({"columns": ASK_COLS, "rows": rows, "row_index": 1, "start_row": 0, "start_col": 0, "reason": "Units odd"}).status_code == 200
    (p,) = seen
    assert "User's request: Recommend the single best fix for this flagged row." in p
    assert set(re.findall(r"tok\d\dx", p)) == {"tok00x", "tok01x", "tok02x"}
    assert only_our_lines(p) == []


def test_the_safe_list_is_the_one_the_tests_check():
    # the parametrized test below runs once per SAFE function: an empty or gutted list would make it pass with no cases
    assert len(client.SAFE) > 150 and {"SUM", "MEDIAN", "IF", "XLOOKUP", "ROUND"} <= client.SAFE
    assert not {"WEBSERVICE", "INDIRECT", "OFFSET", "CELL", "INFO", "PY", "COPILOT", "IMPORTCSV"} & client.SAFE


@pytest.mark.parametrize("fn", sorted(client.SAFE))
def test_a_formula_from_the_ai_may_call_every_function_on_the_safe_list(fn):
    assert not client.unsafe_call(f"={fn}(C2)")


@pytest.mark.parametrize("formula", ["=WEBSERVICE(\"http://x\")", "=IMPORTCSV(\"a.csv\")", "=PY(\"1\")", "=COPILOT(\"hi\")",
                                     "=INDIRECT(\"[Other.xlsx]S!A1\")", "=OFFSET(A1,1,1)", "=CELL(\"filename\")", "=INFO(\"os\")",
                                     "=SUM(A1)+ZZZ(1)", "＝ＷＥＢＳＥＲＶＩＣＥ(1)", "=_xlfn.STOCKHISTORY(\"X\")", "+HYPERLINK(1)"])
def test_a_formula_from_the_ai_that_calls_anything_else_is_refused(formula):
    assert client.unsafe_call(formula)
