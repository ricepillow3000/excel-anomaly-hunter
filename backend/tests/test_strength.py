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
    assert _one_edit("pencl", "pencil") and _one_edit("pecnil", "pencil") and _one_edit("pencel", "pencil")
    assert not _one_edit("east", "east") and not _one_edit("pen", "pencil")
    items = ["Pencil"] * 12 + ["Binder"] * 10 + ["Desk"] * 6 + ["Pencl"]
    codes = ["A101"] * 12 + ["A102"] + ["B200"] * 16  # codes one digit apart are different things
    region = ["East"] * 14 + ["West"] * 15  # two real words one letter apart, both common
    rows = [[k + 1, items[k], codes[k], region[k], 10 + k % 5] for k in range(29)]
    out = scan(["Order", "Item", "Code", "Region", "Units"], rows)[1]
    assert out[28]["maybe"] == {"Item": "Pencil"} and "misspelling" in out[28]["reason"]
    assert not any("misspelling" in r["reason"] for r in out[:28]), "codes and East/West are not misspellings"


@pytest.mark.parametrize("bad", [11, -1, "5", True, 2.5])
def test_strength_must_be_0_to_10(bad):
    columns, rows = make_clean_payload()
    assert client().post("/scan", json={"columns": columns, "rows": rows, "strength": bad}).status_code == 400
