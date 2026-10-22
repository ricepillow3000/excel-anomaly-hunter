import random
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.pipeline import _one_edit, knobs, summary_rows
from test_server import client, make_clean_payload

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bench"))
import datasets  # noqa: E402  the bench's planted sheets

SHEETS = [(s["grid"][s["header"]], s["grid"][s["header"] + 1:]) for s in datasets.make()]
flagged = lambda out: {i for i, r in enumerate(out) if r["severity"] in ("Low", "Medium", "High")}


def test_strength_5_is_todays_engine():
    assert knobs(5) == (5, 6.0) and knobs() == knobs(5)
    for cols, rows in SHEETS:
        assert scan(cols, rows)[1] == scan(cols, rows, strength=5)[1]


def test_a_row_flagged_at_one_level_stays_flagged_at_the_next():
    for cols, rows in SHEETS:
        prev = None
        for s in range(11):
            now = flagged(scan(cols, rows, strength=s)[1])
            assert prev is None or prev <= now, f"{cols}: level {s} dropped rows {sorted(prev - now)}"
            prev = now


def test_level_0_is_basics_and_obvious_typos_only():
    columns, rows = make_clean_payload(n=40)
    rows[3][1] = 1000.0  # x10 of a typical ~100: an obvious typo
    rows[9][1] = 160.0  # far out, but no typo explains it
    rows[12] = list(rows[11])  # a double entry
    rows[20][1] = -40.0  # a negative amount where there are none: basic
    out = scan(columns, rows, strength=0)[1]
    assert out[3]["severity"] and out[3]["likely"]["Amount"] == 100.0
    assert out[20]["severity"], "a negative where none belong is a basic"
    assert out[12]["reason"].startswith("Duplicate of row")
    assert out[9]["severity"] in (None, "Noted"), "level 0 doesn't judge plain outliers"
    assert scan(columns, rows, strength=5)[1][9]["severity"] in ("Low", "Medium", "High")


def test_misspellings_one_letter_off_the_usual_word():
    assert _one_edit("pecnil", "pencil") and _one_edit("pencel", "pencil")  # two letters swapped, one letter wrong
    assert not _one_edit("pencil", "pencil") and not _one_edit("pencl", "pencil")  # an added/dropped letter is a
    # different word too often (Laptop/Laptops, Sara/Sarah, Jon/John) - not offered
    items = ["Pencil"] * 12 + ["Binder"] * 10 + ["Desks"] * 6 + ["Pecnil"]
    codes = ["A101"] * 12 + ["A102"] + ["B200"] * 16  # codes one digit apart are different things
    region = ["North"] * 14 + ["South"] * 15  # real words, both common
    rows = [[k + 1, items[k], codes[k], region[k], 10 + k % 5] for k in range(29)]
    out = scan(["Order", "Item", "Code", "Region", "Units"], rows)[1]
    assert out[28]["maybe"] == {"Item": "Pencil"} and "misspelling" in out[28]["reason"]
    assert out[28]["severity"] == "Low", "a possible misspelling alone is 'worth a check', not 'probably wrong'"
    assert not any("misspelling" in r["reason"] for r in out[:28]), "codes and real words are not misspellings"


@pytest.mark.parametrize("rare, usual", [("Jon", "John"), ("Sara", "Sarah"), ("Ann", "Anna"), ("Mark", "Mary"),
                                         ("Laptop", "Laptops"), ("Phone", "Phones")])
def test_names_and_plurals_are_not_misspellings(rare, usual):
    words = [usual] * 10 + ["Other"] * 10 + [rare]
    out = scan(["Name", "Units"], [[w, 10 + k % 3] for k, w in enumerate(words)])[1]
    assert not any("misspelling" in r["reason"] for r in out), f"{rare} / {usual}"


@pytest.mark.parametrize("bad", [11, -1, "5", True, 2.5])
def test_strength_must_be_0_to_10(bad):
    columns, rows = make_clean_payload()
    assert client().post("/scan", json={"columns": columns, "rows": rows, "strength": bad}).status_code == 400


def test_the_slider_reaches_the_engine_through_the_scan_route_and_each_end_looks_differently():
    # the pane sends "How hard to look" as strength: a level that never reached the engine would pass every in-process
    # test above. Over the bench sheets: 0 < 5 < 10 flags (strictly, so the levels really differ), 0 runs the basics only
    c, got = client(), {}
    for s in (0, 5, 10):
        bodies = [c.post("/scan", json={"columns": cols, "rows": rows, "strength": s}).get_json() for cols, rows in SHEETS]
        got[s] = sum(len(flagged(b["rows"])) for b in bodies)
        dets = [b["summary"]["detectors"] for b in bodies]
        if s == 0:
            assert all(d["sequence"] == "sat out: strength below 3" and d["isolation"] == "sat out: strength below 5" for d in dets)
            reasons = " ".join(r["reason"] for b in bodies for r in b["rows"])
            assert "Unusual combination" not in reasons and "local trend" not in reasons, "0 = basics, no statistics"
        if s == 10:
            assert not any("strength below" in v for d in dets for v in d.values())
    assert got[0] < got[5] < got[10], got


def test_check_and_suggest_judge_a_fix_at_the_level_the_scan_used(monkeypatch):
    # Accept's re-check and the typo hunt must judge at the slider's level, or a fix "looks right" at 5 that 9 flags
    from anomaly_hunter import server
    seen = []
    monkeypatch.setattr(server.checker, "check", lambda *a: seen.append(("check", a[-1])) or {"clean": True, "severity": None, "reason": ""})
    monkeypatch.setattr(server.checker, "suggest", lambda *a: seen.append(("suggest", a[-1])) or {})
    columns, rows = make_clean_payload()
    c = client()
    for s in (0, 9, None):
        base = {"columns": columns, "rows": rows, "row_index": 1, **({} if s is None else {"strength": s})}
        assert c.post("/check", json={**base, "changes": [{"col": 1, "value": 100.0}]}).status_code == 200
        assert c.post("/suggest", json={**base, "column": "Amount"}).status_code == 200
    assert seen == [("check", 0), ("suggest", 0), ("check", 9), ("suggest", 9), ("check", 5), ("suggest", 5)]


def _deliveries(n, z):
    """A normal column (Delivery Days ~ 20 +/- 2) next to a label and another number, one value z spreads out."""
    rng = np.random.RandomState(0)
    days, cost = np.round(20 + 2 * rng.standard_normal(n), 1), np.round(500 + 40 * rng.standard_normal(n), 2)
    rows = [[k + 1, ["North", "South", "East"][k % 3], float(days[k]), float(cost[k])] for k in range(n)]
    rows[n // 2][2] = round(20 + 2 * z, 1)
    return ["Shipment", "Region", "Delivery Days", "Cost"], rows, n // 2


@pytest.mark.parametrize("n", [300, 3000])
def test_a_moderate_outlier_is_left_alone_at_5_and_named_with_its_value_from_level_8_on_a_small_and_a_big_sheet(n):
    # "5 scans exactly like 10" (John, AH-14): a value 5 spreads out was never called out by its value at any level on
    # 3,000 rows - the other values between it and the median excused it as the column's tail, whatever the level
    cols, rows, i = _deliveries(n, 5)
    at = {s: scan(cols, rows, strength=s, fair=False)[1][i] for s in range(11)}
    assert at[5]["severity"] in (None, "Noted")
    for s in (8, 9, 10):
        assert at[s]["severity"] in ("Low", "Medium", "High"), (s, at[s])
        assert "Delivery Days 30 is" in at[s]["reason"] or "Delivery Days weird limit" in at[s]["reason"], (s, at[s])
    assert not at[10].get("likely"), "no typo explains 30: nothing to write"


def test_a_value_past_its_usual_range_with_few_values_near_it_is_worth_a_check_from_level_7():
    # the engine already notes it ("Noted" = hidden); a stricter level is a promise to show it, with its real limit
    cols, rows, i = _deliveries(300, 4.6)
    assert scan(cols, rows, strength=6, fair=False)[1][i]["severity"] in (None, "Noted")
    _, out, _, used, _, _ = scan(cols, rows, strength=7, fair=False)
    r = out[i]
    assert r["severity"] == "Low", r
    assert f"Delivery Days 29.2 is above its usual limit of {used['Delivery Days'][1]:g}" in r["reason"]
    assert not r["likely"], "worth a check, never a made-up value"


def test_the_stricter_levels_keep_every_row_the_level_below_flagged_on_the_new_checks():
    for n, z in ((300, 4.6), (300, 5), (3000, 5)):
        cols, rows, _ = _deliveries(n, z)
        prev = set()
        for s in range(11):
            now = flagged(scan(cols, rows, strength=s, fair=False)[1])
            assert prev <= now, (n, z, s, sorted(prev - now))
            prev = now


def test_the_scan_reports_the_k_its_level_used():
    columns, rows = make_clean_payload()
    for s in (0, 5, 10):
        body = client().post("/scan", json={"columns": columns, "rows": rows, "strength": s}).get_json()
        assert body["summary"]["k"] == knobs(s)[1]


# ---- AH-14 reconvene 1 (Council A's review): the level-7+ list ----
# the listing's sentence, in this change's words and in the reviewed ones ("with few values near it", which states no count)
ALONE = re.compile(r"(?:^|; |: )([^;:]+?) (-?[\d.e+]+) is (above|below) its usual limit of (-?[\d.e+]+), "
                   r"(?:with few values near it|and (no|\d+) other values? (?:is|are) too)")


def listed(out):
    """(row, column, value, limit, side, how many others it says) for every level-7+ listing"""
    return [(i, m[1], float(m[2]), float(m[4]), m[3], None if m[5] is None else 0 if m[5] == "no" else int(m[5]))
            for i, r in enumerate(out) for m in ALONE.finditer(r["reason"] or "")]


def test_honest_ages_are_never_listed_for_their_age_at_any_level():
    # Council B's AH-17 hunt (B1): 1,000 staff, 2% honest people aged 85-98; level 10 listed ten of them "for their Age"
    rng = np.random.default_rng(1)
    rows = [[f"E{i:04d}", int(np.clip(rng.normal(42, 13), 18, 99)) if i % 50 else int(rng.integers(85, 99)), "F" if i % 2 else "M",
             round(float(rng.normal(55000, 9000))), int(rng.integers(0, 2))] for i in range(1000)]
    for s in range(11):
        out = scan(["Employee ID", "Age", "Sex", "Salary", "Remote"], rows, strength=s, fair=False)[1]
        assert not [r["reason"] for r in out if r["severity"] in ("Low", "Medium", "High") and "Age" in r["reason"]], s


def test_a_limit_the_user_saved_wins_over_the_list():
    # Council A: the user saved "flag above 200" for Score, and 78 was still listed from the data's own band
    rng = np.random.default_rng(2)
    rows = [[k + 1, ["N", "S"][k % 2], round(float(rng.normal(50, 8)), 1)] for k in range(300)]
    rows[150][2] = 78.0
    cols = ["Item", "Area", "Score"]
    _, out, suggested, *_ = scan(cols, rows, strength=7, fair=False)
    assert any(i == 150 for i, *_ in listed(out)), "precondition: the data's own band lists 78"
    saved = {"Score": [suggested["Score"][0], suggested["Score"][1], None, 200.0]}  # what the pane saves for "flag above 200"
    for s in range(11):
        assert not listed(scan(cols, rows, saved, strength=s, fair=False)[1]), s


def _orders(n=2000, seed=1):
    """John's kind of sheet: sales lines, 3% honest bulk orders (Qty 21-60), every total right."""
    rng = random.Random(seed)
    prices = {"Stapler": 12.5, "Notebook": 3.25, "Monitor": 189.0, "Keyboard": 45.0, "Desk Lamp": 29.99, "Headset": 59.0}
    rows = []
    for i in range(n):
        p = rng.choice(list(prices))
        q = rng.randint(21, 60) if rng.random() < 0.03 else rng.randint(1, 20)
        rows.append([10001 + i, ["North", "South", "East", "West"][i % 4], p, q, prices[p], round(q * prices[p], 2)])
    return ["Order ID", "Region", "Product", "Qty", "Unit Price", "Line Total"], rows


def test_an_honest_tail_of_bulk_orders_is_never_listed():
    # Council A: at 8-10 every row the list added on John's kind of sheet was an honest bulk order ("Qty 49 ... with few
    # values near it", with 32 values between it and halfway back to the median)
    cols, rows = _orders()
    for s in (7, 8, 9, 10):
        assert not listed(scan(cols, rows, strength=s, fair=False)[1]), s


def test_a_lone_x10_in_a_rating_column_is_listed_from_level_7():
    # the stress hunt's survey: Q3 typed 10 for 1 on a 1-5 scale, only noted at every level before
    rng = random.Random(2)
    rows = [[f"R{i:04d}", rng.choice([2, 3, 3, 4, 4, 4, 5]), rng.choice([1, 2, 3, 4, 5])] for i in range(220)]
    rows[137][1] = 10
    at7 = scan(["Respondent", "Q3", "Q4"], rows, strength=7, fair=False)[1]
    assert [x[:3] for x in listed(at7)] == [(137, "Q3", 10.0)], listed(at7)
    assert not listed(scan(["Respondent", "Q3", "Q4"], rows, strength=6, fair=False)[1])


def test_every_listed_sentence_says_what_the_column_really_holds():
    # "with few values near it" was shown with 32 values near it: the sentence now states a count, checked here
    sheets = [_orders()[0:2], _deliveries(300, 4.6)[:2], _deliveries(3000, 5)[:2], _deliveries(300, 5)[:2]] + \
             [(s["grid"][s["header"]], s["grid"][s["header"] + 1:]) for s in datasets.make()]
    seen = 0
    for cols, rows in sheets:
        for s in (7, 10):
            df, out, *_ = scan([str(c) for c in cols], rows, strength=s, fair=False)
            for i, col, v, lim, side, others in listed(out):
                x = pd.to_numeric(df[col][~summary_rows(df)], errors="coerce").dropna()  # a totals row is never one of the values
                past = int(((x > lim) if side == "above" else (x < lim)).sum()) - 1
                assert past == others and float(df[col][i]) == v, (col, v, lim, past, others)
                seen += 1
    assert seen >= 3, seen


def test_a_big_clean_column_lists_only_its_own_extremes():
    # 30,000 clean normal rows: every value past the usual limit had under 0.25% of company, and 129 honest rows were
    # listed at level 7 (measured on the first fix of the review); a value must also be one of its side's 3 extremes
    rng = np.random.default_rng(5)
    rows = [[i, ["N", "S", "E"][i % 3], round(float(rng.normal(20, 2)), 2), round(float(rng.normal(500, 40)), 2)] for i in range(30000)]
    got = listed(scan(["ID", "Region", "Delivery Days", "Cost"], rows, strength=7, fair=False)[1])
    assert len(got) <= 12, len(got)  # 2 columns x 2 sides x at most 3
