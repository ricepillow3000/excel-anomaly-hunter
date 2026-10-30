"""AH-77 (chaos audit, 2026-10-30): the 55-row Chaos Dataset (docs/airlock/chaos_dataset.csv, synthetic) hides 10
mistakes (5 structural, 5 Excel formatting), 5 honest edge cases (non-Western names, a mononym, a CFO's real pay, a
non-binary part-timer of 71) and 40 clean rows; its last three columns are the answer key, never scanned. The first
run scored F2 0.71: it offered to write 4,000 over a real 400,000 bonus, read "02134" as 2134 and "31/12/2023" as a
date without a word. The score here makes those the worst outcomes there are:

    HA-F2 = 5 TP / (5 TP + 4 FN + FP + 10 (H + A))

F-beta with beta = 2 (a missed mistake costs 4 false alarms) plus, in the denominator, H = fixes offered that are not
the true value and A = cells the engine read as something other than what was typed without saying so, each as
costly as 10 false alarms. Only Medium or worse counts as a flag; a row's planted column must be among the cells the
pane colours. A harmful fix or a silent change also fails on its own, whatever the score."""
import csv
import math
import os
import re

import pandas as pd
import pytest

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.load import load_from_records

HERE = os.path.dirname(os.path.abspath(__file__))
CSV = os.path.join(HERE, "..", "..", "docs", "airlock", "chaos_dataset.csv")
FLAG = ("Medium", "High")
TRUTH = {"S4": {"TotalComp": 87920}, "F5": {"Department": "Finance"}}  # the only fixes whose true value is known
POLICY = {"V5"}  # a part-timer's 16 h among 37.5-45 h: whether it may be Medium is John's call (AH-81)


def chaos():
    rows = list(csv.reader(open(CSV, encoding="utf-8", newline="")))
    head, body = rows[0], rows[1:]
    k = head.index("Answer_Type")
    return head[:k], [r[:k] for r in body], [dict(zip(head[k:], r[k:])) for r in body]


def planted_column(key, cols):
    word = key["Answer_Planted"].split(" ")[1] if key["Answer_Planted"] else ""
    return word if word in cols else None


def faithful(typed, read):
    """Did the engine read the cell as typed? A number must be the digits typed (no zero lost), a date the ISO date typed."""
    if isinstance(read, str):
        return read.strip() == typed.strip()
    if isinstance(read, pd.Timestamp):
        return bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?", typed.strip())) and read.strftime("%Y-%m-%d") == typed.strip()[:10]
    if read is None or (isinstance(read, float) and math.isnan(read)) or read is pd.NaT:
        return False
    return bool(re.fullmatch(r"-?(0|[1-9]\d*)(\.\d+)?", typed.strip())) and float(typed) == float(read)


def audit(strength):
    cols, rows, keys = chaos()
    out = scan(cols, rows, strength=strength, fair=False)[1]
    df = load_from_records(cols, rows)[0]
    tp, fn, fp, harm, silent, wrong = 0, 0, 0, [], [], {}
    for i, (r, key) in enumerate(zip(out, keys)):
        code = key["Answer_Planted"][:2]
        flagged = r["severity"] in FLAG
        if key["Answer_Type"] in ("TRUE_ERROR", "FORMAT_ANOMALY"):
            col = planted_column(key, cols)
            if flagged and (col is None or col in r["cells"]):
                tp += 1
            else:
                fn += 1; wrong[code] = (r["severity"], r["reason"])
        elif flagged:
            fp += 1; wrong[code or f"clean row {i + 2}"] = (r["severity"], r["reason"])
        for kind in ("likely", "maybe", "exact"):
            for c, v in (r.get(kind) or {}).items():
                if TRUTH.get(code, {}).get(c) != v:
                    harm.append((i + 2, c, v))
        for j, c in enumerate(cols):
            typed = rows[i][j]
            if typed.strip() and not faithful(typed, df.iat[i, j]) and not (r["severity"] and c in r["cells"]):
                silent.append((i + 2, c, typed, df.iat[i, j]))
    h, a = len(harm), len(silent)
    return dict(tp=tp, fn=fn, fp=fp, harm=harm, silent=silent, wrong=wrong,
                score=5 * tp / (5 * tp + 4 * fn + fp + 10 * (h + a)), out=out, keys=keys)


@pytest.mark.parametrize("strength", [5, 10])
def test_the_chaos_dataset_scores_one_with_no_harmful_fix_and_no_silent_change(strength):
    got = audit(strength)
    assert got["harm"] == [], got["harm"]
    assert got["silent"] == [], got["silent"][:10]
    assert got["fn"] == 0 and got["tp"] == 10, got["wrong"]
    assert set(got["wrong"]) <= POLICY, got["wrong"]
    assert got["score"] >= 5 * 10 / (5 * 10 + len(POLICY)), got["score"]


@pytest.mark.parametrize("strength", [5, 10])
def test_the_cfos_real_pay_is_worth_a_check_never_a_fix(strength):
    got = audit(strength)
    i = next(k for k, key in enumerate(got["keys"]) if key["Answer_Planted"].startswith("V4"))
    r = got["out"][i]
    assert r["severity"] == "Low" and not r["likely"] and not r["maybe"] and not r["exact"], r
    assert "TotalComp" in r["reason"], r["reason"]


@pytest.mark.xfail(strict=True, reason="AH-81, John decides: may a lone part-timer's 16 h among 37.5-45 h be Medium?")
@pytest.mark.parametrize("strength", [5, 10])
def test_a_part_timers_honest_hours_are_not_called_medium(strength):
    got = audit(strength)
    i = next(k for k, key in enumerate(got["keys"]) if key["Answer_Planted"].startswith("V5"))
    assert got["out"][i]["severity"] not in FLAG
