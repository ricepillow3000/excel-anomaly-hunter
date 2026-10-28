"""AH-56: blind round 37's honesty fixes, each rebuilt as a synthetic sheet shaped like the real table (never the table
itself): a rare 1 in a yes/no column, a percent typed as text quoted as a number the user never typed, survey answers
left blank one Medium per cell, and a wide sheet's blanks read as a long-format layout."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

FLAG = ("Low", "Medium", "High")


def flagged(out, sev=FLAG):
    return [i for i, o in enumerate(out) if o["severity"] in sev]


def paintings(n=403, seed=9):
    # Bob Ross's paintings: 30 yes/no columns, some on nearly every painting, MOON on 3 of 403
    rng = np.random.default_rng(seed)
    rates = [0.9, 0.6, 0.4, 0.2, 0.1, 0.05, 0.02, 0.0075, 0.005, 0.0025] * 3
    cols = ["EPISODE", "TITLE"] + [f"E{k}" for k in range(len(rates) - 1)] + ["MOON"]
    rows = [[f"S{i // 13 + 1:02d}E{i % 13 + 1:02d}", f"Painting {i}"] + [int(rng.random() < r) for r in rates[:-1]] + [int(i in (50, 200, 333))]
            for i in range(n)]
    return cols, rows


@pytest.mark.parametrize("strength", [5, 10])
def test_a_rare_1_in_a_yes_no_column_is_no_value_past_a_limit(strength):
    out = scan(*paintings(), fair=False, strength=strength)[1]
    assert not any("weird limit" in o["reason"] or "baseline limit" in o["reason"] for o in out), \
        [o["reason"] for o in out if "limit" in o["reason"]][:3]
    assert flagged(out, ("Medium", "High")) == []


@pytest.mark.parametrize("bad", [10, -1])
def test_a_10_or_a_minus_1_typed_into_a_yes_no_column_is_still_past_its_limit(bad):
    cols, rows = paintings()
    rows[77][5] = bad
    out = scan(cols, rows, fair=False)[1]
    assert f"E3 weird limit is {1 if bad > 1 else 0}; this is {bad}" in out[77]["reason"] and out[77]["severity"] == "Medium", out[77]


def test_a_2_typed_into_a_yes_no_column_is_still_flagged():
    cols, rows = paintings()
    rows[77][13] = 2  # E11: a rare yes
    out = scan(cols, rows, fair=False)[1]
    assert out[77]["severity"] in FLAG, out[77]


def changes():
    rng = np.random.default_rng(12)
    rows = [[f"Paper {i}", int(rng.integers(50000, 900000)), f"{int(rng.integers(-30, 31)):+d}%"] for i in range(300)]
    rows[10][2], rows[20][2] = "-100%", "+2200%"
    return ["Newspaper", "Circulation", "Change 2004-2013"], rows


def test_a_percent_typed_as_text_is_quoted_as_typed_beside_the_number_it_holds():
    # Pulitzer's circulation change: "+22%" was said as 0.22 and "-100%" as -1
    out = scan(*changes(), fair=False)[1]
    assert "this is 22 (+2200% as typed)" in out[20]["reason"], out[20]["reason"]
    assert "this is -1 (-100% as typed)" in out[10]["reason"], out[10]["reason"]


def survey(n=1000, seed=4, dropouts=(), skips=0.03):
    rng = np.random.default_rng(seed)
    qs = ["How worried are you about earthquakes?", "Do you think the Big One will occur in your lifetime?",
          "Have you ever experienced an earthquake?", "Have you taken any precautions for an earthquake?",
          "How familiar are you with the San Andreas Fault line?", "How familiar are you with the Yellowstone Supervolcano?"]
    ans = ["Not at all", "Somewhat", "Very", "Extremely"]
    cols = ["RespondentID"] + qs + ["Age", "What is your gender?", "US Region"]
    rows = [[f"R{i:05d}"] + [ans[int(rng.integers(0, 4))] if rng.random() > skips else "" for _ in qs]
            + [str(rng.choice(["18 - 29", "30 - 44", "45 - 59", "60"])), str(rng.choice(["Male", "Female"])),
               str(rng.choice(["Pacific", "Mountain", "East North Central", "South Atlantic"]))] for i in range(n)]
    for i in dropouts:  # a respondent who stopped after the first questions
        rows[i][3:] = [""] * (len(cols) - 3)
    return cols, rows


def test_a_respondent_who_stopped_the_survey_is_one_note_for_the_row_not_a_medium_for_each_question():
    cols, rows = survey(skips=0, dropouts=(100, 400, 700))
    out = scan(cols, rows, fair=False)[1]
    for i in (100, 400, 700):
        assert out[i]["severity"] == "Low" and "of the 10 usually filled cells in this row are blank" in out[i]["reason"], out[i]
        assert "Blank cell" not in out[i]["reason"]
    assert flagged(out) == [100, 400, 700]


def test_a_survey_question_some_respondents_skip_is_one_note_not_a_medium_each():
    # the religion survey: 1-12% of a question left blank, spread out, under 20 a column
    cols, rows = survey(skips=0.015)
    out = scan(cols, rows, fair=False)[1]
    assert flagged(out, ("Medium", "High")) == [], [out[i]["reason"] for i in flagged(out, ("Medium", "High"))][:3]
    said = [o["reason"] for o in out if "is unanswered in" in o["reason"]]
    assert 1 <= len(said) <= 6 and all("a survey question a respondent may skip" in s for s in said), said


def test_a_blank_respondent_id_in_a_survey_is_still_a_slip():
    cols, rows = survey(skips=0)
    rows[300][0] = ""
    out = scan(cols, rows, fair=False)[1]
    assert "Blank cell in column RespondentID, which is otherwise filled" in out[300]["reason"] and out[300]["severity"] == "Medium"


def test_a_few_yes_no_columns_with_question_marks_do_not_make_an_orders_sheet_a_survey():
    rng = np.random.default_rng(5)
    rows = [[f"O{i}", str(rng.choice(["Ann", "Bo", "Cy"])), round(float(rng.uniform(5, 500)), 2), str(rng.choice(["Yes", "No"])),
             str(rng.choice(["Yes", "No"])), str(rng.choice(["Yes", "No"]))] for i in range(1000)]
    for i in (100, 500, 900):
        rows[i][2] = ""
    out = scan(["Order ID", "Customer", "Amount", "Paid?", "Shipped?", "Gift wrap?"], rows, fair=False)[1]
    for i in (100, 500, 900):
        assert "Blank cell in column Amount, which is otherwise filled" in out[i]["reason"] and out[i]["severity"] == "Medium", out[i]


def test_a_follow_up_question_routed_by_an_earlier_answer_is_no_slip_where_it_was_not_asked():
    # sleeping alone: "where do you sleep" is asked only of couples who sleep apart; blanks for "Never" are routing
    rng = np.random.default_rng(6)
    how = ["Never", "Once a year or less", "Once a month or less", "A few times per week", "Every night"]
    rows = []
    for i in range(1000):
        h = how[0] if rng.random() < 0.55 else how[int(rng.integers(1, 5))]
        where = "" if h == "Never" else str(rng.choice(["Couch", "Guest room", "Child's room"]))
        rows.append([f"R{i}", str(rng.choice(["Married", "In a relationship"])), h, where, str(rng.choice(["Male", "Female"]))])
    out = scan(["RespondentID", "Which of the following best describes your current relationship status?",
                "When both you and your partner are at home, how often do you sleep in separate beds?",
                "When you're not sleeping in the same bed as your partner, where do you typically sleep?", "Gender"], rows, fair=False)[1]
    assert flagged(out) == [], [out[i]["reason"] for i in flagged(out)][:3]


def comics(n=1500, seed=8):
    # DC's characters: HAIR left blank for many characters whatever their eyes, and for every one of a group with no eyes
    rng = np.random.default_rng(seed)
    eyes = ["Brown Eyes"] * 6 + ["Blue Eyes"] * 5 + ["Green Eyes"] * 2 + ["Photocellular Eyes"]
    rows = []
    for i in range(n):
        e = str(rng.choice(eyes))
        hair = "" if e == "Photocellular Eyes" or rng.random() < (0.04 if e == "Brown Eyes" else 0.5) else str(rng.choice(["Black Hair", "Brown Hair", "Blond Hair"]))
        rows.append([f"Character {i}", e, hair, int(rng.integers(1, 500))])
    return ["name", "EYE", "HAIR", "APPEARANCES"], rows


def test_a_wide_sheets_blanks_are_not_read_as_a_long_format_layout_by_any_other_column():
    out = scan(*comics(), fair=False)[1]
    assert not any("otherwise filled for EYE" in o["reason"] for o in out), [o["reason"] for o in out if "otherwise filled for" in o["reason"]][:3]


def test_rows_where_an_export_writes_na_for_no_value_are_no_unfinished_records():
    # round 23's kids spending: R writes NA in three money columns of the same 102 rows - its convention, one note a column
    rng = np.random.default_rng(3)
    rows = [[str(rng.choice(["Alabama", "Alaska", "Arizona"])), "PK12ed", 1997 + i % 20] + [round(float(rng.uniform(1e5, 9e6)), 1) for _ in range(3)]
            for i in range(2000)]
    for i in range(0, 2000, 20):
        rows[i][3:] = ["NA"] * 3
    out = scan(["state", "variable", "year", "raw", "inf_adj", "inf_adj_perchild"], rows, fair=False)[1]
    assert not any("unfinished record" in o["reason"] for o in out)
