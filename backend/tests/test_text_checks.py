"""A text value typed into the wrong column ("East" in Item): caught offline, as Low, naming the column it belongs to.
Columns that really share values (Origin/Destination, Home/Away) and real one-offs ("Desk") must stay quiet."""
import random

from anomaly_hunter.server import create_app

C = create_app().test_client()


def sheet(vocab, n=60, seed=1, plants=(), numbers=True):
    """vocab = {column: [values]} -> (columns, rows) with plants = [(row, column, value)] typed in."""
    r = random.Random(seed)
    cols = list(vocab) + (["Units"] if numbers else [])
    units = r.sample(range(5, 200), n)  # all different: no row is a true duplicate (the engine rightly flags those)
    rows = [[r.choice(v) for v in vocab.values()] + ([units[k]] if numbers else []) for k in range(n)]
    for i, col, value in plants:
        rows[i][cols.index(col)] = value
    return cols, rows


def flags(cols, rows):
    out = C.post("/scan", json={"columns": cols, "rows": rows}).get_json()["rows"]
    return {i: (o["severity"], o["reason"]) for i, o in enumerate(out) if o["severity"] not in (None, "Noted")}


SHIFTS = [  # (vocab, plants, expected words in the reason per planted row)
    ({"Region": ["East", "Central", "West"], "Rep": ["Jones", "Kivell", "Jardine", "Gill", "Sorvino"],
      "Item": ["Pencil", "Binder", "Pen", "Desk Lamp", "Pen Set"]},
     [(20, "Item", "East"), (30, "Rep", "Pencil")], ['Item "East" looks like a Region value', 'Rep "Pencil" looks like an Item value']),
    ({"Department": ["Sales", "Finance", "IT", "Operations"], "City": ["Boston", "Denver", "Austin"]},
     [(5, "Department", "Denver"), (44, "City", "Finance")], ["looks like a City value", "looks like a Department value"]),
    ({"Status": ["Open", "Closed", "Pending"], "Priority": ["High", "Medium", "Low"]},
     [(12, "Status", "High"), (50, "Priority", "Closed")], ["looks like a Priority value", "looks like a Status value"]),
    ({"Customer": ["Acme", "Globex", "Initech", "Umbrella"], "Rep": ["Ana", "Ben", "Chloe"]},
     [(8, "Rep", "Globex"), (33, "Customer", "Chloe")], ["looks like a Customer value", "looks like a Rep value"]),
    ({"Product": ["Laptop", "Monitor", "Keyboard", "Mouse"], "Category": ["Hardware", "Accessory", "Display"]},
     [(17, "Category", "Monitor"), (41, "Product", "Accessory")], ["looks like a Product value", "looks like a Category value"]),
]


def test_a_value_typed_into_the_wrong_column_is_caught_as_low():
    for vocab, plants, words in SHIFTS:
        cols, rows = sheet(vocab, plants=plants)
        got = flags(cols, rows)
        for (i, _, _), w in zip(plants, words, strict=True):
            assert i in got and got[i][0] == "Low" and w in got[i][1], (vocab.keys(), i, got.get(i))
        assert set(got) == {i for i, _, _ in plants}, got  # nothing else on the sheet


def test_columns_that_really_share_values_stay_quiet():
    cities = ["Boston", "Denver", "Austin", "Miami", "Seattle", "Chicago"]
    cols, rows = sheet({"Origin": cities, "Destination": cities}, plants=[(9, "Destination", "Portland")])
    rows += [["Portland", "Boston", 10], ["Portland", "Miami", 12], ["Portland", "Austin", 14]]  # Portland: 3x Origin, 1x Destination
    assert flags(cols, rows) == {}
    teams = ["Lions", "Bears", "Eagles", "Hawks", "Wolves"]
    assert flags(*sheet({"Home": teams, "Away": teams}, seed=2)) == {}


def test_a_real_one_off_and_words_only_meaning_can_judge_stay_quiet_offline():
    vocab = {"Region": ["East", "Central", "West"], "Item": ["Pencil", "Binder", "Pen", "Pen Set"]}
    cols, rows = sheet(vocab, plants=[(7, "Item", "Desk"), (15, "Item", "London"), (25, "Region", "Banana")])
    assert flags(cols, rows) == {}  # London/Banana need meaning: that is the optional AI text check, not this rule


# ---- The optional AI text check (a transformer: the user's Gemini via the existing client) ----
import json  # noqa: E402

from test_fix import gemini_stub  # noqa: E402

ODD = {"columns": ["Region", "Item", "Units"],
       "rows": [["East", "Pencil", 5], ["West", "London", 7], ["East", "Binder", 9], ["West", "Pencil", 11]]}


def test_ai_text_check_sends_only_distinct_words_and_keeps_only_real_values(monkeypatch, tmp_path):
    answer = {"odd": [{"column": "Item", "value": "London", "why": "a city, not a product"},
                      {"column": "Item", "value": "Paris", "why": "invented - not in the sheet"},  # must be dropped
                      {"column": "Nope", "value": "East", "why": "no such column"}]}  # must be dropped
    got = gemini_stub(monkeypatch, tmp_path, content=json.dumps(answer))
    (tmp_path / "gemini-key.txt").write_text("AIzaTest", encoding="utf-8")  # gitleaks:allow - made-up test key
    r = create_app().test_client().post("/odd-text", json=ODD)
    assert r.status_code == 200 and r.get_json() == {"odd": [{"row": 1, "col": 1, "column": "Item", "value": "London", "why": "a city, not a product"}]}
    prompt = got[-1][1]["messages"][0]["content"]
    assert '"London"' in prompt and '"Pencil"' in prompt and prompt.count('"Pencil"') == 1  # distinct values, once each
    assert "11" not in prompt and "Units" not in prompt  # numbers and whole rows never leave the PC


def test_ai_text_check_needs_a_key_and_skips_sheets_without_text():
    c = create_app().test_client()
    assert c.post("/odd-text", json=ODD).status_code == 503  # no AI key: says so, nothing sent
    assert c.post("/odd-text", json={"columns": ["Units"], "rows": [[1], [2]]}).get_json() == {"odd": []}
    assert c.post("/odd-text", json={"columns": []}).status_code == 400
