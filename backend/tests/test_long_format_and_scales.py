"""AH-16 part 1 (Council B's AH-17 stress hunt): two real mistakes no level could see. A blank in a long-format Value
column that its own group fills (the column as a whole is only 2/3 filled, under the 80% bar), and a 10 typed for a 1 on a
1-5 scale with no scale in the header. Synthetic sheets only."""
import numpy as np

from anomaly_hunter.agents.scan_agent import scan

FLAG = ("Low", "Medium", "High")
COUNTRIES = ["Chile", "Peru", "Kenya", "Ghana", "Spain", "Italy", "Japan", "Korea", "Egypt", "Nepal", "Laos", "Fiji"]


def long_format(seed=1):
    """12 countries x 10 years x 3 indicators: Value is filled for GDP and Population, Pct for Unemployment (the layout)."""
    rng = np.random.default_rng(seed)
    rows = []
    for c in COUNTRIES:
        gdp, pop = rng.uniform(20, 900), rng.uniform(5, 120)
        for y in range(2015, 2025):
            gdp *= 1 + rng.normal(0.02, 0.01)
            pop *= 1.01
            rows += [[c, y, "GDP (bn)", round(gdp, 1), None], [c, y, "Population (m)", round(pop, 2), None],
                     [c, y, "Unemployment", None, round(float(rng.uniform(0.03, 0.12)), 3)]]
    return ["Country", "Year", "Indicator", "Value", "Pct"], rows


def test_a_blank_in_a_long_format_value_column_is_found_where_its_group_fills_it():
    cols, rows = long_format()
    rows[102][3] = None  # a GDP row: GDP fills Value everywhere else
    out = scan(cols, rows, fair=False)[1]
    hit = [i for i, r in enumerate(out) if "Blank cell" in r["reason"]]
    assert hit == [102], [out[i]["reason"] for i in hit]
    assert "Blank cell in column Value, which is otherwise filled for Indicator GDP (bn)" in out[102]["reason"]
    assert out[102]["severity"] == "Medium" and not out[102].get("likely"), "a blank is said, never filled with a made-up value"
    # the layout itself is never a blank: no Unemployment row is flagged for its empty Value, nor any GDP row for its Pct
    assert not any("Blank cell" in r["reason"] for i, r in enumerate(out) if i != 102)


def test_blanks_are_never_judged_by_a_protected_group():
    # a column filled for one gender and empty for the other: judging a person's blank by their gender group is the kind
    # of group judgement the fairness rules forbid, so a blank in the filled group is not flagged by the group rule
    rng = np.random.default_rng(3)
    rows = [[f"E{i:03d}", "M" if i % 2 else "F", round(float(rng.normal(50, 8)), 1), ("Corporal" if i % 2 else None)] for i in range(300)]
    rows[151][3] = None  # an M row left blank
    out = scan(["Employee", "Gender", "Score", "Service Rank"], rows, fair=False)[1]
    assert not any("Blank cell in column Service Rank" in r["reason"] for r in out)


def survey(seed=2, n=220):
    rng = np.random.default_rng(seed)
    return ["Respondent", "Q3", "Q4"], [[f"R{i:04d}", int(rng.choice([1, 2, 3, 3, 4, 4, 4, 5])), int(rng.integers(1, 6))] for i in range(n)]


def test_a_x10_on_a_one_to_five_scale_is_worth_a_check_with_its_guess():
    cols, rows = survey()
    rows[137][1] = 10  # a 1 with an extra 0, on a 1-5 scale with no scale in the header
    out = scan(cols, rows, fair=False)[1]
    r = out[137]
    assert r["severity"] == "Low" and "Q3 10 is outside the 1 to 5 range its other values use" in r["reason"], r
    assert r["maybe"] == {"Q3": 1.0}, "the guess is offered for the user to confirm"
    assert not r["exact"] and "Q3" not in r["likely"], "never an exact fix: auto-fix and the typo card leave it alone"
    assert [i for i, o in enumerate(out) if o["severity"] in FLAG] == [137]


def test_a_one_off_large_count_on_a_small_scale_is_not_called_a_typo():
    rng = np.random.default_rng(4)
    for col, odd in (("Children", 12), ("Floors", 15)):  # a big family, a tall building: not 10x a value on the scale
        rows = [[f"H{i:03d}", int(rng.integers(0, 6))] for i in range(200)]
        rows[50][1] = odd
        out = scan(["Household", col], rows, fair=False)[1]
        assert "range its other values use" not in out[50]["reason"], (col, out[50]["reason"])
    # two values above the scale are a real part of the column, not one slip
    cols, rows = survey()
    rows[10][1], rows[20][1] = 10, 20
    out = scan(cols, rows, fair=False)[1]
    assert not any("range its other values use" in r["reason"] for r in out)
    # a 0-10 scale (NPS) is not a 1-5 one: 70 there is left to the column's limits
    rows = [[f"R{i}", int(rng.integers(0, 11))] for i in range(200)]
    rows[5][1] = 70
    out = scan(["Respondent", "NPS"], rows, fair=False)[1]
    assert "range its other values use" not in out[5]["reason"]


COUNTS = ["Children", "Kids", "Rooms", "Floors", "Bedrooms", "Pets", "Cars", "Household members", "Staff",
          # Council A, AH-16 reconvene 2: answer-like words inside a header that counts (a survey export says "Q4. How many
          # children live here?"), and a word that only contains one ("scored", "Recommendations", "Agreements")
          "Q4 How many children", "Q4. How many children live here?", "Q7 Number of cars", "Q9 No. of pets", "Years of experience",
          "Experience (years)", "Goals scored", "Feedback count", "Recommendations made", "Agreements signed", "Score count",
          "Total score", "Times rated", "Q2 # of visits", "Rating count", "NumberOfRatings", "Age", "Stars"]


def test_a_real_count_is_never_called_a_slip_on_a_small_range():
    # Council A's review (AH-16 reconvene 1): 80 households with 0-5 children and one real family of 10 got "maybe 1 with
    # an extra 0", and the card offered to write 1. A 10, 20 or 30 is a real count as often as a slip: only an answer
    # (Q3, a rating, a score) is on a range where 10 can only be a typo. Each header is tried on answers 1-5 too, so the
    # header alone must refuse it (counts from 0 are refused by the range as well)
    rng = np.random.default_rng(6)
    for col in COUNTS:
        for low in (0, 1):
            for odd in (10, 20, 30):
                rows = [[f"H{i:03d}", int(rng.choice([low, low, 1, 2, 2, 3, 4, 5]))] for i in range(80)] + [["H999", odd]]
                out = scan(["Household", col], rows, fair=False)[1]
                assert "range its other values use" not in out[-1]["reason"] and not out[-1].get("maybe"), (col, low, odd, out[-1])
    # ...while an answer-like header is: a rating, a satisfaction score, a survey item however it is written
    for col in ("Rating", "Satisfaction", "Q12", "Score", "q_3", "Q 7", "Q3. How satisfied are you?", "Likelihood to recommend",
                "OverallRating", "Agree (strongly)"):
        cols, rows = survey()
        rows[137][1] = 10
        out = scan(["Respondent", col, "Q4"], rows, fair=False)[1]
        assert f"{col} 10 is outside the 1 to 5 range its other values use" in out[137]["reason"], (col, out[137])


def test_an_answer_range_starts_at_1_so_a_column_with_zeros_is_left_alone():
    # a count runs from 0 (no children, no goals); a survey's answers from 1. Even under an answer-like header, a column
    # holding 0s is not called a 1-5 range: its 10 is left to the column's limits
    rng = np.random.default_rng(8)
    rows = [[f"R{i:03d}", int(rng.choice([0, 1, 2, 3, 4, 5]))] for i in range(120)] + [["R999", 10]]
    out = scan(["Respondent", "Score"], rows, fair=False)[1]
    assert "range its other values use" not in out[-1]["reason"] and not out[-1].get("maybe"), out[-1]


def test_a_column_whose_name_gives_its_range_gets_one_reason_for_one_cell():
    # "Rating (1-5)" with a 10: named_bounds already says it ("outside what Rating (1-5) can be"); a second sentence about
    # the same cell said the same thing twice (Council A, AH-16 reconvene 1)
    cols, rows = survey()
    rows[137][1] = 10
    out = scan(["Respondent", "Rating (1-5)", "Q4"], rows, fair=False)[1]
    said = [p for p in out[137]["reason"].replace("Flagged by 1 of 2: ", "").split("; ") if "Rating (1-5) 10" in p]
    assert len(said) == 1 and "outside what Rating (1-5) can be" in said[0], out[137]["reason"]


def test_a_crafted_wide_sheet_cannot_make_the_blank_check_run_for_minutes():
    # the blank check grouped every text column against every column with a blank: 64 label columns x 1,500 number
    # columns (313k cells, under the server's 2M) took 168 s at 87% filled and 140 s at 50% (AH-16 build, 2026-10-22).
    # Counted per group for all columns at once, the answer is the same and the time is seconds
    import time

    import pandas as pd

    from anomaly_hunter.engine import pipeline
    from anomaly_hunter.engine.load import load_from_records
    for every in (2, 8):  # 50% filled: the group rule; 87% filled: the layout exclusion
        cols = [f"L{j}" for j in range(64)] + [f"N{j}" for j in range(400)]
        rows = [[["a", "b", "c"][(i + j) % 3] for j in range(64)] + [None if (i + j) % every == 0 else float(i) for j in range(400)]
                for i in range(200)]
        df, types, errors = load_from_records(cols, rows)
        t = time.perf_counter()
        pipeline.blanks(df, types, pd.Series(np.zeros(len(df), bool), index=df.index), errors)
        assert time.perf_counter() - t < 10, every
