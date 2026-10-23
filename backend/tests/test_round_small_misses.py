"""AH-32: blind rounds 23 and 36's small misses, each rebuilt as a synthetic sheet shaped like the real table: a Tour de
France winner, a Nobel laureate and a champion are people (their names get no spelling guess); "Frnace" among 68
countries and "Chiken Bowl" among 51 items went unchecked past the 50-label cap; "Month-to-mnoth" was never read as a
word for its hyphens; a Nobel laureate born in 2862 sat in a column of 1800s dates the loader read as text."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

GUESS = ("misspelling of", "short form of", "lowercase where")


@pytest.mark.parametrize("col", ["Winner", "Champion", "Laureate", "Rider"])
def test_a_winner_champion_laureate_or_rider_is_a_person(col):
    labels = ["Thompson"] * 30 + [o for o in ("Jones", "Brown", "Garcia", "Miller") for _ in range(12)] + ["Thomson"]
    out = scan(["Year", col, "Points"], [[1900 + i, w, 10 + i % 7] for i, w in enumerate(labels)], fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (col, out[-1]["reason"])


def labels_sheet(n_labels, rare, usual, seed=1):
    rng = np.random.default_rng(seed)
    names = [usual] + [f"Place{k:03d}" for k in range(n_labels - 1)]
    rows = [[f"R{i}", names[int(rng.integers(0, n_labels))], round(float(rng.uniform(1, 9)), 2)] for i in range(40 * n_labels)]
    rows += [[f"R{i}", usual, 5.0] for i in range(40 * n_labels, 40 * n_labels + 30)]
    rows[11][1] = rare
    return rows


@pytest.mark.parametrize("n, rare, usual", [(68, "Frnace", "France"), (51, "Chiken Bowl", "Chicken Bowl")])
def test_a_misspelling_among_more_than_50_labels_that_repeat_is_still_caught(n, rare, usual):
    out = scan(["Id", "company_location", "rating"], labels_sheet(n, rare, usual), fair=False)[1]
    assert f'"{rare}" looks like a misspelling of "{usual}"' in out[11]["reason"], out[11]


def test_a_free_text_column_with_a_new_label_on_most_rows_is_still_left_alone():
    rows = [[f"R{i}", f"note number {i} about the order", 1.0] for i in range(300)]
    rows += [[f"R{300 + i}", "note number 5 about the order", 1.0] for i in range(10)]
    rows[20][1] = "note nubmer 5 about the order"
    out = scan(["Id", "Notes", "x"], rows, fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS)


@pytest.mark.parametrize("rare", ["Month-to-mnoth", "Mnoth-to-month", "Month-to-motnh"])
def test_a_slip_inside_a_hyphenated_label_is_caught(rare):
    rng = np.random.default_rng(2)
    rows = [[f"C{i}", ["Month-to-month", "One year", "Two year"][int(rng.integers(0, 3))], round(float(rng.uniform(20, 110)), 2)] for i in range(600)]
    rows[93][1] = rare
    out = scan(["customerID", "Contract", "MonthlyCharges"], rows, fair=False)[1]
    assert f'"{rare}" looks like a misspelling of "Month-to-month"' in out[93]["reason"], out[93]


@pytest.mark.parametrize("col, born, typo", [("birth_date", 1880, "2862-06-07"), ("born", 1850, "2887-01-26")])
def test_a_far_date_in_a_column_of_dates_before_1900_is_caught(col, born, typo):
    rng = np.random.default_rng(3)
    rows = [[1901 + i // 3, f"Person {i}", f"{born + int(rng.integers(0, 90))}-{int(rng.integers(1, 13)):02d}-{int(rng.integers(1, 29)):02d}"]
            for i in range(300)]
    rows[30][2] = typo
    out = scan(["prize_year", "full_name", col], rows, fair=False)[1]
    assert "is far outside the column's dates" in out[30]["reason"] and out[30]["cells"] == [col], out[30]
    assert sum("far outside" in o["reason"] for o in out) == 1


def test_a_cost_code_that_parses_as_the_year_100_is_still_no_date():
    rows = [[f"R{i}", f"{i % 12 + 1:02d}-{100 + i % 50}", 5.0] for i in range(200)]
    out = scan(["Id", "Cost code", "x"], rows, fair=False)[1]
    assert not any("far outside" in o["reason"] or "date" in o["reason"] for o in out)


def test_a_short_word_inside_a_hyphenated_label_is_judged_by_its_own_length():
    # round 22's volcano regions: "Russia-SW" beside "Russia-SE" is another region, not a slip
    rows = [[f"V{i}", ["Russia-SE", "Japan-N", "Chile-C"][i % 3], 1000 + i] for i in range(300)]
    rows[40][1] = rows[41][1] = "Russia-SW"
    out = scan(["Volcano", "Region", "Elevation"], rows, fair=False)[1]
    assert not any("misspelling" in o["reason"] for o in out), [o["reason"] for o in out if "misspelling" in o["reason"]]
