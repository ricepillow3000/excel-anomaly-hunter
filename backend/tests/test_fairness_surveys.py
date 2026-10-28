"""AH-53 (blind round 37): the fairness report fits a survey. Opinion questions that mention religion or sex were read as
who people are ('How comfortable would you be seeing someone who practices a different religion from you: ... Not so
comfortable: 34% missing ... - a real gap, check why'), a survey's routing (atheists are not asked about services) was
"a real gap, check why", a second header row ("Response") was named as a group and unnamed columns were quoted as ".2",
and a table of Ferris wheels got a report by country because a column counted passengers per cabin. Synthetic sheets
only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.fairness import _people
from anomaly_hunter.engine.load import load_from_records

RELIGION = "What is your present religion, if any?"
OPINION = "How comfortable would you be seeing someone who practices a different religion from you: Tell someone you'll pray"
SERVICES = "Do you attend religious services"


def fair(cols, rows):
    return scan(cols, rows)[5]


def survey(n=600, seed=1):
    rng = np.random.default_rng(seed)
    faiths = ["Protestant", "Roman Catholic", "Atheist", "Jewish", "Agnostic"]
    feel = ["Very comfortable", "Somewhat comfortable", "Not so comfortable", "Not at all comfortable"]
    rows = []
    for i in range(n):
        faith = faiths[int(rng.integers(0, 5))]
        # atheists are routed past it; a few others skip it too
        services = "" if faith == "Atheist" or rng.random() < 0.01 else ["Weekly", "Monthly", "Rarely", "Never"][int(rng.integers(0, 4))]
        rows.append([f"R{i}", faith, feel[int(rng.integers(0, 4))], services, ["Male", "Female"][int(rng.integers(0, 2))],
                     ["18-29", "30-44", "45-60", "> 60"][int(rng.integers(0, 4))]])
    return ["RespondentID", RELIGION, OPINION, SERVICES, "Gender", "Age"], rows


def test_an_opinion_question_that_mentions_a_religion_is_never_a_group_of_people():
    cols, rows = survey()
    f = fair(cols, rows)
    assert OPINION not in f["protected"] and RELIGION in f["protected"], f["protected"]
    assert not any(t["column"] == OPINION for t in f["tests"]), [t["text"] for t in f["tests"] if t["column"] == OPINION][:2]


@pytest.mark.parametrize("header, identity", [
    ("What is your present religion, if any?", True), ("What is your gender?", True), ("Which race best describes you?", True),
    ("What is your age?", True), ("Gender:", True), ("Q3: Sex", True),
    ("Q12: What is your race/ethnicity? (select one)", True), ("Gender identity (please specify)", True),
    ("Please indicate your gender:", True),
    ("How comfortable are you talking about race at work?", False), ("Do you think gender affects pay?", False),
    ('To what extent do you agree with the following statement: "our sex life has improved"', False),
    ("Is your religion important to you?", False), ("How often do you: Bring up your religion, unprompted, in conversation", False)])
def test_a_short_question_naming_who_someone_is_is_a_group_and_an_opinion_question_is_not(header, identity):
    rng = np.random.default_rng(2)
    labels = ["Alpha", "Beta", "Gamma"]
    rows = [[f"R{i}", labels[int(rng.integers(0, 3))], ["Female", "Male"][i % 2]] for i in range(300)]
    df, types, _ = load_from_records(["RespondentID", header, "Gender of respondent"], [list(r) for r in rows])
    assert (header in _people(df, types)) is identity, _people(df, types)


def test_a_question_the_survey_never_asked_one_group_is_its_routing_never_a_gap():
    # atheists are routed past "Do you attend religious services": every one of their rows is blank
    cols, rows = survey()
    f = fair(cols, rows)
    said = [t for t in f["tests"] if SERVICES in t["test"]]
    assert all("real gap" not in t["text"] and "Atheist" not in t["groups"] for t in said), [t["text"] for t in said]
    assert all("not asked of Atheist" in t["text"] for t in said if t["column"] == RELIGION), [t["text"] for t in said]
    assert any(t["column"] == RELIGION for t in said), "the asked groups are still compared"


def test_a_real_gap_in_blanks_beside_the_routing_is_still_measured():
    # the asked groups still differ: Jewish respondents leave the services question blank half the time
    cols, rows = survey(n=1500, seed=3)
    rng = np.random.default_rng(4)
    for r in rows:
        if r[1] == "Jewish" and rng.random() < 0.5:
            r[3] = ""
    said = [t for t in fair(cols, rows)["tests"] if t["column"] == RELIGION and SERVICES in t["test"]]
    assert any(t["verdict"] == "gap" and "Jewish" in t["text"] and "not asked of Atheist" in t["text"] for t in said), [t["text"] for t in said]


def test_a_second_header_row_and_unnamed_columns_are_never_named():
    # a survey export: row 1 under the headers says "Response" / the option of a check-all-that-apply column, and those
    # columns have no header at all
    rng = np.random.default_rng(5)
    cols = ["StartDate", "Which of the following best describes your current relationship status?", "Gender", "Age",
            "Why do you sleep apart? Please select all that apply.", "", ""]
    rows = [["", "Response", "Response", "Response", "One of us snores", "One of us is sick", "We argued"]]
    for i in range(800):
        age = ["18-29", "30-44", "45-60", "> 60"][int(rng.integers(0, 4))]
        rows.append([f"7/{1 + i % 28}/14", ["Married", "Single"][i % 2], ["Male", "Female"][int(rng.integers(0, 2))], age,
                     "One of us snores" if rng.random() < 0.3 else "", "One of us is sick" if rng.random() < (0.5 if age == "> 60" else 0.1) else "",
                     "We argued" if rng.random() < 0.2 else ""])
    f = fair(cols, rows)
    text = " ".join(t["text"] for t in f["tests"])
    assert "Response" not in text and "missing .1" not in text and "missing .2" not in text and "missing  " not in text, text[:600]
    assert all(t["test"] not in ("missing ", "missing .1") for t in f["tests"])


def test_a_table_of_things_with_a_country_is_no_people_sheet():
    # Ferris wheels by country: "passengers_per_cabin" counts passengers, it does not say the rows are people
    rng = np.random.default_rng(6)
    countries = ["China", "USA", "Japan", "UK", "Dubai"]
    rows = [[f"Wheel {i}", int(rng.integers(50, 250)), countries[i % 5], ["Ride park", "City"][i % 2], int(rng.integers(4, 40)),
             int(rng.integers(6, 40)), "" if rng.random() < 0.3 else int(rng.integers(1, 30))] for i in range(200)]
    f = fair(["name", "height", "country", "location", "number_of_cabins", "passengers_per_cabin", "ride_duration_minutes"], rows)
    assert f["protected"] == {} and f["tests"] == [], (f["protected"], [t["text"] for t in f["tests"]][:2])


@pytest.mark.parametrize("cols", [["Customer ID", "Country", "Amount"], ["player_id", "birth_country", "Goals"], ["Patient", "Region", "Bill"]])
def test_a_header_naming_its_rows_as_people_still_makes_a_place_a_people_column(cols):
    rng = np.random.default_rng(7)
    rows = [[f"P{i}", ["France", "Italy", "Spain"][i % 3], round(float(rng.uniform(5, 90)), 2)] for i in range(300)]
    df, types, _ = load_from_records(cols, [list(r) for r in rows])
    assert cols[1] in _people(df, types), _people(df, types)


def test_a_column_blank_for_nearly_everyone_is_sparse_never_routed():
    # Thanksgiving's "Other (please specify)": 93-98% blank in every region and 100% in one is no routing to name
    rng = np.random.default_rng(8)
    regions = ["Mountain", "Pacific", "New England", "South Atlantic"]
    rows = [[f"R{i}", regions[i % 4], ["Male", "Female"][i % 2],
             "" if i % 4 == 0 or rng.random() < 0.95 else "Tamales"] for i in range(800)]
    said = " ".join(t["text"] for t in fair(["RespondentID", "US Region", "Gender", "Main dish - Other (please specify)"], rows)["tests"])
    assert "not asked of" not in said, said[:400]


def test_a_first_row_of_real_data_is_never_taken_for_a_second_header():
    # the Tour de France's first winner has a team, a town and a nickname nobody else has
    rng = np.random.default_rng(9)
    rows = [[1903, "Garin", "La Francaise", "Arvier", "Le petit ramoneur", "Italy", int(rng.integers(20, 40))]]
    rows += [[1904 + i, f"Rider {i}", ["Peugeot", "Alcyon", "Bianchi"][i % 3], ["Paris", "Lyon", "Gent"][i % 3], "",
              ["France", "Belgium", "Italy"][i % 3], int(rng.integers(20, 40))] for i in range(120)]
    from anomaly_hunter.engine.fairness import _subheader
    df, types, _ = load_from_records(["year", "winner_name", "team", "birth_town", "nickname", "nationality", "age"], [list(r) for r in rows])
    assert not _subheader(df, types).any()


def hiring(question, labels, low):
    # a hiring sheet: one group hired 15% of the time, the rest 45% (Council A's AH-53 review probe)
    rng = np.random.default_rng(3)
    rows = []
    for i in range(600):
        g = labels[i % len(labels)]
        rows.append([f"Applicant {i}", g, "Hired" if rng.random() < (0.15 if g == low else 0.45) else "Rejected", int(rng.integers(20, 60))])
    return fair(["Applicant ID", question, "Decision", "Age"], rows)


@pytest.mark.parametrize("question, labels, low", [
    ("Do you have a disability?", ["Yes", "No", "No", "No"], "Yes"),
    ("Are you a veteran?", ["Yes", "No", "No", "No"], "Yes"),
    ("Religion: which one?", ["Christian", "Muslim", "Jewish", "None"], "Muslim"),
    ("What is your race or ethnicity, as you would describe it in your own words?", ["White", "Black", "Asian", "Hispanic"], "Black"),
    ("Are you Hispanic or Latino?", ["Yes", "No", "No", "No"], "Yes"),
    ("Which of the following best describes your sexual orientation?", ["Straight", "Gay", "Bisexual", "Straight"], "Gay"),
    ("Do you consider yourself to have a disability?", ["Yes", "No", "No", "No"], "Yes"),
    # AH-53 review 3 (Council A's probe): the rest of the self-identification forms it tried keep their gap too
    ("Do you identify as transgender?", ["Yes", "No", "No", "No"], "Yes"), ("Are you a protected veteran?", ["Yes", "No", "No", "No"], "Yes"),
    ("Marital status:", ["Married", "Single", "Divorced"], "Single"), ("Sexual orientation", ["Straight", "Gay", "Bisexual"], "Gay"),
    ("What is your citizenship status?", ["Citizen", "Permanent resident", "Visa"], "Visa"),
    ("Do you consider yourself to be a person with a disability?", ["Yes", "No", "No", "No"], "Yes")])
def test_a_self_identification_question_is_a_group_and_never_an_outcome(question, labels, low):
    # AH-53 review (Council A): EEO-style yes/no questions were silenced as "opinion", and measured as outcomes instead
    f = hiring(question, labels, low)
    assert question in f["protected"], f["protected"]
    assert any(t["column"] == question and t["verdict"] == "gap" for t in f["tests"]), [t["text"] for t in f["tests"]][:4]
    assert not any(question in t["test"] for t in f["tests"]), [t["text"] for t in f["tests"] if question in t["test"]][:2]


@pytest.mark.parametrize("labels", [["Lottery A", "Lottery B"], ["Plan A", "Plan B"], ["Option 1", "Option 2"]])
def test_two_labels_that_differ_only_by_a_letter_or_number_are_a_choice_never_an_outcome(labels):
    rng = np.random.default_rng(10)
    rows = [[f"R{i}", ["Male", "Female"][i % 2], labels[int(rng.random() < (0.6 if i % 2 else 0.3))]] for i in range(600)]
    f = fair(["RespondentID", "Gender", "Which would you choose?"], rows)
    assert not any("Which would you choose?" in t["test"] for t in f["tests"]), [t["text"] for t in f["tests"]]


def test_an_orientation_column_is_a_people_column_only_with_its_labels():
    rng = np.random.default_rng(11)
    people = [[f"R{i}", ["Straight", "Gay/Bisexual", "Other"][int(rng.integers(0, 3))], ["Yes", "No"][int(rng.random() < 0.4)]] for i in range(600)]
    df, types, _ = load_from_records(["RespondentID", "orientation", "Employed"], [list(r) for r in people])
    assert "orientation" in _people(df, types)
    pages = [[f"P{i}", ["Portrait", "Landscape"][i % 2], ["Yes", "No"][int(rng.random() < 0.4)], ["Male", "Female"][i % 2]] for i in range(600)]
    df, types, _ = load_from_records(["Page", "orientation", "Printed", "Author gender"], [list(r) for r in pages])
    assert "orientation" not in _people(df, types)


def test_a_road_segments_straight_or_other_orientation_is_no_people_column():
    # AH-53 review 2 (Council A): Straight / Other are road shapes as often as orientations; try 2 read the sheet as
    # people and said "Orientation Other: 44% Status Closed vs 6.5% for Straight - a real gap, check why"
    rng = np.random.default_rng(14)
    rows = []
    for i in range(400):
        o = ["Straight", "Other"][int(rng.random() < 0.3)]
        rows.append([f"Seg {i}", o, int(rng.integers(50, 900)), "Closed" if rng.random() < (0.44 if o == "Other" else 0.065) else "Open"])
    f = fair(["Segment", "Orientation", "Length m", "Status"], rows)
    assert f["protected"] == {} and f["tests"] == [], (f["protected"], [t["text"] for t in f["tests"]][:2])


def test_a_us_citizen_question_is_a_group_and_never_an_outcome():
    f = hiring("Are you a U.S. citizen?", ["Yes", "Yes", "Yes", "No"], "No")
    assert "Are you a U.S. citizen?" in f["protected"], f["protected"]
    assert any(t["column"] == "Are you a U.S. citizen?" and t["verdict"] == "gap" for t in f["tests"]), [t["text"] for t in f["tests"]][:3]
    assert not any("citizen" in t["test"] for t in f["tests"])


@pytest.mark.parametrize("head", ["How many citizens live in the district?", "What share of citizens voted?"])
def test_a_question_about_citizens_that_asks_no_one_who_they_are_is_no_group_of_people(head):
    # AH-53 review 3 (Council A): "citizen" made a district's size band a people column and a grants sheet a people sheet
    rng = np.random.default_rng(1)
    rows = []
    for i in range(300):
        band = ["Under 1,000", "1,000-5,000", "Over 5,000"][i % 3]
        rows.append([f"District {i}", band, "Funded" if rng.random() < (0.7 if band == "Over 5,000" else 0.2) else "Not funded", int(rng.integers(1, 90))])
    f = fair(["District", head, "Grant", "Parks"], rows)
    assert f["protected"] == {} and f["tests"] == [], (f["protected"], [t["text"] for t in f["tests"]][:2])
