"""The slider's promise is measured (AH-15). frontend/constants/index.js MEASURED says what each level did on the
industry bench (27 sheets, 51 planted mistakes, 2,724 fine rows) and the pane shows it under the slider: this scans the
bench at every level and fails when a number there is not what the engine does now. A detector change that moves one
updates MEASURED (and the commit message says why), so the pane never promises numbers it no longer keeps."""
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "bench"))
import datasets  # noqa: E402
import datasets2  # noqa: E402

from anomaly_hunter.server import create_app  # noqa: E402

SURE = ("High", "Medium")
SRC = (ROOT / "frontend" / "constants" / "index.js").read_text(encoding="utf-8")


def promised():
    return json.loads(re.search(r"^export const MEASURED = (\{.*\});$", SRC, re.M).group(1))


@pytest.fixture(scope="module")
def bench():
    """Each level's numbers, and which planted rows it found: the industry bench's own sheets, read at their header."""
    app, sheets = create_app().test_client(), datasets.make(7) + [d for s in (11, 12, 13) for d in datasets2.make(s)]
    out = {}
    for level in range(11):
        found, sure, fine_low, fine_sure, planted_n, fine_n, low_planted = set(), 0, 0, 0, 0, 0, 0
        for d in sheets:
            h = d["header"]
            rows = app.post("/scan", json={"columns": [str(c) for c in d["grid"][h]], "rows": d["grid"][h + 1:],
                                           "strength": level}).get_json()["rows"]
            planted = {p["row"] - h - 1 for p in d["planted"]}
            skip = {g - h - 1 for g in list(d["totals"]) + list(d.get("dup_sources", ()))}
            for i, r in enumerate(rows):
                if i in planted:
                    planted_n += 1
                    if r["severity"] in SURE + ("Low",):
                        found.add((d["name"], i))
                    sure += r["severity"] in SURE
                    low_planted += r["severity"] == "Low"
                elif i not in skip:
                    fine_n += 1
                    fine_low += r["severity"] == "Low"
                    fine_sure += r["severity"] in SURE
        out[level] = {"numbers": [len(found), sure, fine_low, fine_sure], "found": found, "planted": planted_n, "fine": fine_n,
                      "low_planted": low_planted, "sheets": len(sheets)}
    return out


def test_the_numbers_under_the_slider_are_what_each_level_does_on_the_bench(bench):
    m = promised()
    for level in range(11):
        b = bench[level]
        assert (m["sheets"], m["planted"], m["fine"]) == (b["sheets"], b["planted"], b["fine"])
        assert m["levels"][str(level)] == b["numbers"], (level, "pane says", m["levels"][str(level)], "bench gives", b["numbers"])


def test_what_the_strict_levels_say_in_words_is_true(bench):
    # 7-10 say "the same mistakes as at 5": the very same planted rows, not only as many
    assert "Stricter: the same mistakes as at 5" in SRC and "Strictest: the same mistakes as at 5" in SRC
    for level in (7, 8, 9, 10):
        assert bench[level]["found"] == bench[5]["found"], level
    # 9-10 say "many more rows to check, most of them fine": the fine rows listed outnumber the mistakes listed as Low
    for level in (9, 10):
        assert bench[level]["numbers"][2] > max(bench[level]["low_planted"], bench[5]["numbers"][2]), level
