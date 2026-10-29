"""AH-64: blind round 38's fixes, each rebuilt as a small synthetic sheet shaped like the real table (never the table
itself): a skipped answer hidden under a survey's dropouts, a camelCase month header, a second spelling the source
writes many times, a daily cycle in hourly counts read as jumps, and rounding in a total of many parts."""
import time

import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.pipeline import _bounds

FLAG = ("Low", "Medium", "High")
SERIES = ("unusual relative to its local trend", "jumped sharply")


def flagged(out, sev=FLAG):
    return [i for i, o in enumerate(out) if o["severity"] in sev]


def survey(n=400, seed=38, dropouts=()):
    rng = np.random.default_rng(seed)
    qs = ["How worried are you about earthquakes?", "Do you think the Big One will occur in your lifetime?",
          "Have you ever experienced an earthquake?", "Have you taken any precautions for an earthquake?",
          "How familiar are you with the San Andreas Fault line?", "How familiar are you with the Yellowstone Supervolcano?"]
    ans = ["Not at all", "Somewhat", "Very", "Extremely"]
    cols = ["RespondentID"] + qs + ["Age", "What is your gender?", "US Region"]
    rows = [[f"R{i:05d}"] + [ans[int(rng.integers(0, 4))] for _ in qs]
            + [str(rng.choice(["18 - 29", "30 - 44", "45 - 59", "60"])), str(rng.choice(["Male", "Female"])),
               str(rng.choice(["Pacific", "Mountain", "East North Central", "South Atlantic"]))] for i in range(n)]
    for i in dropouts:  # a respondent who stopped after the first two questions
        rows[i][3:] = [""] * (len(cols) - 3)
    return cols, rows


def test_a_skipped_answer_among_many_dropouts_keeps_its_own_note_on_its_own_row_and_cell():
    # round 38: 60 dropouts passed the spread-through-the-sheet bar in every question they left, so the columns were one
    # "blank in 61 of 400 rows" note each, and the one respondent who skipped a question had no row of their own
    drop = [int(i) for i in np.linspace(2, 397, 60)]
    cols, rows = survey(dropouts=drop)
    skip = next(i for i in range(200, 400) if i not in drop)
    rows[skip][4] = ""
    out = scan(cols, rows, fair=False)[1]
    for i in drop:
        assert out[i]["severity"] == "Low" and "unfinished record" in out[i]["reason"], out[i]
    assert out[skip]["severity"] == "Low" and "unanswered in 1 of 400 rows" in out[skip]["reason"], out[skip]
    assert out[skip]["cells"] == [cols[4]], out[skip]["cells"]
    assert not any("spread through the sheet" in o["reason"] for o in out)
    assert flagged(out) == sorted(drop + [skip])


def months(col, bad=13, n=200):
    return scan(["Id", col], [[f"P{i}", bad if i == 77 else 1 + i % 12] for i in range(n)], fair=False)[1]


@pytest.mark.parametrize("col", ["birthMonth", "deathMonth", "startMonth"])
def test_a_camel_case_month_header_is_a_month(col):
    out = months(col)
    assert f"{col} 13 is outside what {col} can be (1 to 12)" in out[77]["reason"], out[77]["reason"]


@pytest.mark.parametrize("col", ["monthsActive", "tenureMonths", "dayOfMonth"])
def test_a_camel_case_count_of_months_or_day_of_the_month_keeps_quiet(col):
    assert not any("outside what" in o["reason"] for o in months(col))


def test_a_second_spelling_the_source_writes_many_times_is_one_note_for_the_column():
    rng = np.random.default_rng(3)
    labels = ["Collins Glass"] * 200 + ["Collins glass"] * 150 + ["Cocktail glass"] * 250 + ["Highball glass"] * 200
    rng.shuffle(labels)
    rows = [[f"Drink {i}", g, int(rng.integers(2, 9))] for i, g in enumerate(labels)]
    out = scan(["Drink", "Glass", "Ingredients"], rows, fair=False)[1]
    said = [(i, o["reason"]) for i, o in enumerate(out) if "Collins" in o["reason"]]
    assert len(said) == 1, said[:3]
    i, reason = said[0]
    assert '"Collins glass" 150 times' in reason and '"Collins Glass" 200 times' in reason, reason
    assert out[i]["severity"] == "Low" and out[i]["cells"] == ["Glass"] and not out[i].get("likely"), out[i]
    assert flagged(out) == [i]


def test_a_rare_second_spelling_is_still_flagged_on_each_of_its_rows():
    rows = [[f"Drink {i}", ["Cocktail glass", "Highball glass", "Collins Glass", "Old-fashioned glass"][i % 4], 2 + i % 7]
            for i in range(400)]
    for i in (41, 201, 361):
        rows[i][1] = "Collins glass"
    out = scan(["Drink", "Glass", "Ingredients"], rows, fair=False)[1]
    for i in (41, 201, 361):
        assert '"Collins glass" looks like "Collins Glass" (same word, different capitals/spaces)' in out[i]["reason"], out[i]
    assert flagged(out) == [41, 201, 361]


def hourly(days=30, seed=38):
    # a city's bike counts by the hour: a smooth daily curve, peaking in the afternoon, plus noise
    rng = np.random.default_rng(seed)
    t0 = np.datetime64("2026-03-01T00:00")
    return [[str(t0 + np.timedelta64(h, "h")), round(60 + 240 * np.exp(-((h % 24 - 15) / 4) ** 2) + rng.normal(0, 6))]
            for h in range(24 * days)]


@pytest.mark.parametrize("level", [3, 5, 10])
def test_a_daily_cycle_in_hourly_counts_is_not_a_jump(level):
    out = scan(["Hour", "Riders"], hourly(), fair=False, strength=level)[1]
    found = [i for i, o in enumerate(out) if any(w in o["reason"] for w in SERIES)]
    assert found == [], (level, len(found), [out[i]["reason"] for i in found[:3]])


@pytest.mark.parametrize("level", [3, 5, 10])
def test_one_hour_typed_ten_times_over_in_a_daily_cycle_is_still_a_jump(level):
    rows = hourly()
    rows[363][1] *= 10  # 3 am on day 16: a quiet hour
    out = scan(["Hour", "Riders"], rows, fair=False, strength=level)[1]
    assert any(w in out[363]["reason"] for w in SERIES), (level, out[363])


def test_a_total_of_many_parts_rounded_to_its_own_digit_adds_up_and_a_real_slip_does_not():
    # round 38: ten parts written to 1 decimal, the total to 1 decimal from the unrounded parts, missed by up to 0.55
    rng = np.random.default_rng(38)
    rows = []
    for i in range(200):
        p = rng.uniform(0, 100, 10)
        rows.append([f"Site {i}"] + [round(float(x), 1) for x in p] + [round(float(p.sum()), 1)])
    rows[77][-1] = round(rows[77][-1] + 37, 1)
    out = scan(["Site"] + [f"Zone {k}" for k in range(1, 11)] + ["Total"], rows, fair=False)[1]
    assert flagged(out) == [77], [out[i]["reason"] for i in flagged(out)][:3]
    assert "Total" in out[77]["reason"] and "does not add up" in out[77]["reason"], out[77]


def test_the_header_splitting_stays_linear_on_a_100000_character_header():
    for h in ("aB" * 50000, "a" * 100000, "A" * 100000, "birth" + "Month" * 20000):
        start = time.perf_counter()
        _bounds(h)
        assert time.perf_counter() - start < 0.5, h[:20]
