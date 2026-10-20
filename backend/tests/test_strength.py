import sys
from pathlib import Path

import pytest

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.pipeline import _one_edit, knobs
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
