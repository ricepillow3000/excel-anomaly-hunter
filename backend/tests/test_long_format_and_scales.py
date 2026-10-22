"""AH-16 part 1 (Council B's AH-17 stress hunt): a blank in a long-format Value column that its own group fills (the
column as a whole is only 2/3 filled, under the 80% bar) - found where its group fills it, never where a column is merely
patchy. The 1-5 scale rule was dropped (John, 2026-10-22); its count headers stay as a guard. Synthetic sheets only."""
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


def test_a_column_that_is_merely_patchy_is_not_read_as_a_long_format_layout():
    # blind round 22 (real planets table): distance 96% filled for one method, half for another, and the only group that
    # "left it empty" was 1 of 5 rows (plus a 1-row method). That is a patchy column, not a layout: 23 real gaps were
    # called "otherwise filled for method ..." Medium. The empty group is layout evidence only with 20+ rows of its own
    rng = np.random.default_rng(22)
    rows = []
    for method, n, filled in (("Radial", 560, 0.96), ("Transit", 400, 0.56), ("Pulsar", 5, 0.2), ("Pulsation", 1, 0.0)):
        for i in range(n):
            keep = (i < round(n * filled)) if n < 20 else rng.random() < filled
            rows.append([method, int(rng.integers(1, 4)), round(float(rng.lognormal(4, 1)), 2) if keep else None, int(rng.integers(1995, 2015))])
    out = scan(["method", "number", "distance", "year"], rows, fair=False)[1]
    assert not any("otherwise filled for" in r["reason"] for r in out), [r["reason"] for r in out if "otherwise filled for" in r["reason"]][:3]


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


# Rule R ("Q3 10 is outside the 1 to 5 range ... maybe 1 with an extra 0") was dropped (John, 2026-10-22, AH-16): three
# reviews in a row found real counts it offered a tenth for - children, then "Q4 How many children", then "Q4 Household
# size", "Q2 Nights stayed", "Q6 Siblings". These headers stay as a guard: a 10 among small numbers is never given a
# tenth as its guess, whatever the header says
COUNTS = ["Children", "Kids", "Rooms", "Floors", "Bedrooms", "Pets", "Cars", "Household members", "Staff",
          "Q4 How many children", "Q4. How many children live here?", "Q7 Number of cars", "Q9 No. of pets", "Years of experience",
          "Experience (years)", "Goals scored", "Feedback count", "Recommendations made", "Agreements signed", "Score count",
          "Total score", "Times rated", "Q2 # of visits", "Rating count", "NumberOfRatings", "Age", "Stars",
          # Council A, AH-16 try 3: counts under a survey item's number
          "Q4 Household size", "Q3 Family size", "Q8 Party size", "Q3 Guests", "Q2 Nights stayed", "Q4 Trips", "Q5 Pages read",
          "Q6 Siblings"]
ANSWERS = ["Q3", "Q12", "q_3", "Rating", "Score", "Satisfaction", "Q3. How satisfied are you?", "Likelihood to recommend"]


def test_a_ten_among_small_numbers_is_never_offered_a_tenth_as_its_guess():
    rng = np.random.default_rng(6)
    for col in COUNTS + ANSWERS:
        for low in (0, 1):
            for odd in (10, 20, 30):
                rows = [[f"H{i:03d}", int(rng.choice([low, low, 1, 2, 2, 3, 4, 5]))] for i in range(80)] + [["H999", odd]]
                r = scan(["Household", col], rows, fair=False)[1][-1]
                assert not r.get("maybe") and "extra 0" not in r["reason"] and "range its other values use" not in r["reason"], (col, low, odd, r)


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
