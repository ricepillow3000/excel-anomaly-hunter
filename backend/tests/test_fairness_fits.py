"""AH-39: the fairness report fits the sheet it is given. A blind sweep of 39 public tables never used before (Rdatasets:
census extracts, arrests, mortgages, births, housing, cars, animals) found it claiming "a real gap" about Texas cities'
missing house sales, reading a town's share of old houses as people's ages, a cat's sex as a person's, a race coded
1/2/3 as the bands "1-2" and "3 and over", and a person's sex or race as the outcome measured across another group
("sex female: 100% female = 1 vs 0.0% for male"); and it missed people columns named female, nonwhite, colour or
maritl. Synthetic sheets only, shaped like those tables."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan


def fair(cols, rows):
    return scan(cols, rows)[5]


def test_a_sheet_with_no_people_claims_nothing_about_its_places():
    # Texas house sales by city: a few small cities leave sales blank. Cities are not people here
    rng = np.random.default_rng(1)
    cities = [f"City{k}" for k in range(40)]
    rows = [[c, 2000 + y, m, "" if (k < 6 and rng.random() < 0.4) else int(rng.integers(20, 900)), int(rng.integers(100, 9000))]
            for k, c in enumerate(cities) for y in range(15) for m in range(1, 13)]
    f = fair(["city", "year", "month", "sales", "listings"], rows)
    assert f["protected"] == {} and f["tests"] == [], f["protected"]


def test_a_towns_share_of_old_houses_is_not_an_age():
    rng = np.random.default_rng(2)
    rows = [[round(float(rng.uniform(0, 89)), 2), round(float(rng.uniform(3, 100)), 1), round(float(rng.uniform(0.3, 397)), 2),
             round(float(rng.uniform(5, 50)), 1)] for _ in range(506)]
    f = fair(["crim", "age", "black", "medv"], rows)
    assert f["protected"] == {}, f["protected"]


@pytest.mark.parametrize("kind", ["penguins", "dogs"])
def test_an_animals_sex_is_not_a_persons(kind):
    rng = np.random.default_rng(3)
    if kind == "penguins":
        cols = ["species", "island", "sex", "body_mass_g"]
        rows = [[["Adelie", "Gentoo", "Chinstrap"][i % 3], ["Biscoe", "Dream"][i % 2], ["male", "female"][i % 2], int(rng.integers(2700, 6300))]
                for i in range(344)]
    else:
        cols = ["breed", "sex", "weight", "age", "adopted"]
        rows = [[["Collie", "Pug", "Boxer"][i % 3], ["M", "F"][i % 2], round(float(rng.uniform(5, 40)), 1), int(rng.integers(0, 15)),
                 ["yes", "no"][int(rng.random() < (0.3 if i % 2 else 0.6))]] for i in range(400)]
    f = fair(cols, rows)
    assert f["protected"] == {}, f["protected"]


@pytest.mark.parametrize("extra", ["Dog owner", "Pet owner", "Fish per week", "Cat person"])
def test_a_people_survey_that_mentions_an_animal_is_still_about_people(extra):
    # AH-39 review: an animal word anywhere silenced a survey of respondents and its real 30% vs 60% gap
    rng = np.random.default_rng(13)
    rows = [[f"R{i}", ["Female", "Male"][i % 2], ["Yes", "No"][int(rng.integers(0, 2))], int(rng.random() < (0.3 if i % 2 else 0.6))]
            for i in range(600)]
    f = fair(["Respondent", "Gender", extra, "Satisfied"], rows)
    assert "Gender" in f["protected"] and any(t["column"] == "Gender" and t["verdict"] == "gap" for t in f["tests"]), f


def test_a_gender_column_is_a_persons_even_beside_an_animal_word():
    # animals have a sex, never a gender, a race or a marital status
    rows = [[["Female", "Male"][i % 2], ["Yes", "No"][i % 3 == 0], int(i % 2 == 0 and i % 5 < 3)] for i in range(600)]
    f = fair(["Gender", "Pet owner", "Approved"], rows)
    assert "Gender" in f["protected"], f["protected"]


def test_people_columns_under_other_names_are_found_and_never_an_outcome():
    # a wage extract: female, nonwhite and married as 0/1, as econometrics tables write them
    rng = np.random.default_rng(4)
    rows = []
    for i in range(526):
        fem, nw, mar = int(rng.random() < 0.48), int(rng.random() < 0.1), int(rng.random() < 0.6)
        rows.append([round(float(rng.lognormal(1.6, 0.5)), 2), int(rng.integers(6, 18)), nw, fem, mar,
                     int(rng.random() < (0.35 if fem else 0.12))])
    f = fair(["wage", "educ", "nonwhite", "female", "married", "partTime"], rows)
    assert set(f["protected"]) == {"nonwhite", "female", "married"}, f["protected"]
    tested = {t["test"] for t in f["tests"]}
    assert not any(c in name for name in tested for c in ("nonwhite", "female", "married")), tested
    assert any(t["column"] == "female" and t["test"] == "partTime rate" and t["verdict"] == "gap" for t in f["tests"]), f["tests"]


def test_a_race_written_under_another_name_is_a_group_and_never_an_outcome():
    # arrests: "colour" holds White / Black; it is the people's race, never what happened to them
    rng = np.random.default_rng(5)
    rows = [[["Yes", "No"][int(rng.random() < (0.25 if i % 4 == 0 else 0.15))], ["Black", "White"][int(i % 4 != 0)], 1997 + i % 6,
             int(rng.integers(15, 60)), ["Male", "Female"][int(rng.random() < 0.1)]] for i in range(5226)]
    f = fair(["released", "colour", "year", "age", "sex"], rows)
    assert "colour" in f["protected"], f["protected"]
    assert not any("colour" in t["test"] for t in f["tests"]), [t["text"] for t in f["tests"] if "colour" in t["test"]]


def test_a_car_colour_is_not_a_race():
    rows = [[["Red", "Blue", "Silver", "Black", "White"][i % 5], 2000 + i % 20, 5000 + 37 * i] for i in range(400)]
    assert fair(["colour", "year", "price"], rows)["protected"] == {}


def test_a_demographic_written_as_numbered_codes_is_read_as_its_codes_never_banded():
    # birth weights: race 1, 2 or 3, as the study coded it - "race 1-2: 51% vs 18% for 3 and over" banded codes like ages
    rng = np.random.default_rng(6)
    rows = [[int(rng.integers(14, 45)), [1, 2, 3][i % 3], int(rng.random() < (0.5 if i % 3 == 0 else 0.2)), int(rng.integers(1500, 4900))]
            for i in range(600)]
    f = fair(["age", "race", "smoke", "bwt"], rows)
    groups = {g for t in f["tests"] if t["column"] == "race" for g in t["groups"]}
    assert groups == {"1", "2", "3"}, groups


def test_a_sheet_that_names_its_people_keeps_its_places():
    # people with a region: the region can stand in for race or income, so it is checked
    rng = np.random.default_rng(7)
    rows = [[f"Person {i}", ["North", "South", "East", "West"][i % 4], int(rng.integers(18, 80)), int(rng.random() < 0.2)] for i in range(800)]
    f = fair(["Customer name", "Region", "Age", "Defaulted"], rows)
    assert set(f["protected"]) == {"Region", "Age"}, f["protected"]


def test_a_location_beside_people_columns_under_other_names_is_kept():
    rows = [[["MA", "NY", "TX"][i % 3], i % 2, 30 + i % 40, int(i % 7 == 0)] for i in range(600)]
    assert set(fair(["state", "female", "age", "ui"], rows)["protected"]) == {"state", "female", "age"}


# blind round 36 (now a tuning set): the same misreads on more real tables
def test_a_sex_coded_0_1_is_read_as_sex_0_and_sex_1_never_banded():
    rng = np.random.default_rng(8)
    rows = [[int(rng.integers(29, 77)), i % 2, int(rng.random() < (0.75 if i % 2 == 0 else 0.45))] for i in range(303)]
    f = fair(["age", "sex", "target"], rows)
    t = next(t for t in f["tests"] if t["column"] == "sex" and t["test"] == "target rate")
    assert set(t["groups"]) == {"0", "1"} and t["text"].startswith("sex 0: ") and " for 1 - " in t["text"], t["text"]


@pytest.mark.parametrize("cols, pair", [(["sex", "smoker", "time", "total_bill"], ("Lunch", "Dinner")),
                                         (["gender", "age", "chamber", "terms"], ("house", "senate"))])
def test_a_when_or_where_pair_is_not_an_outcome(cols, pair):
    rng = np.random.default_rng(9)
    rows = [[["Female", "Male"][i % 2], int(rng.integers(20, 80)) if cols[1] == "age" else ["Yes", "No"][i % 3 == 0],
             pair[int(rng.random() < (0.4 if i % 2 == 0 else 0.2))], round(float(rng.uniform(3, 50)), 2)] for i in range(500)]
    f = fair(cols, rows)
    assert not any(cols[2] in t["test"] for t in f["tests"]), [t["text"] for t in f["tests"] if cols[2] in t["test"]]


def test_married_is_a_persons_marital_status_never_an_outcome():
    rng = np.random.default_rng(10)
    rows = [[["Male", "Female"][i % 2], ["Yes", "No"][int(rng.random() < (0.7 if i % 2 else 0.3))], ["Y", "N"][int(rng.random() < 0.3)]]
            for i in range(614)]
    f = fair(["Gender", "Married", "Loan_Status"], rows)
    assert "Married" in f["protected"] and not any("Married" in t["test"] for t in f["tests"]), f["tests"]


def test_a_measure_that_is_a_function_of_the_group_is_never_tested_against_it():
    # person_of_color is worked out from subject_race: "White: 0.0% person_of_color = 1 vs 83%" is a definition
    # (biopics: only its 24 Multi racial subjects were mixed)
    races = ["White"] * 500 + ["African American"] * 120 + ["Hispanic"] * 60 + ["Asian"] * 40 + ["Multi racial"] * 24
    rows = [[r, int(r != "White" and (r != "Multi racial" or i % 2)), ["Male", "Female"][i % 2]] for i, r in enumerate(races)]
    f = fair(["subject_race", "person_of_color", "subject_sex"], rows)
    assert not any(t["column"] == "subject_race" and "person_of_color" in t["test"] for t in f["tests"]), f["tests"]


def test_a_question_about_an_age_cutoff_is_not_a_persons_age():
    rows = [[["18 - 29", "30 - 44", "45 - 59", "60+"][i % 4], ["Male", "Female"][i % 2], [10, 12, 14, 16, 18, 21][i % 6]] for i in range(800)]
    f = fair(["Age", "What is your gender?", "What's the age cutoff at your \"kids' table\" at Thanksgiving?"], rows)
    assert set(f["protected"]) == {"Age", "What is your gender?"}, f["protected"]


def test_a_label_typed_wrong_once_is_left_out_with_the_label_it_may_be():
    # "Femlae" named as a group read as a kind of person (blind round 36); folded into Female it was a guess about a person
    # (AH-39 review: "Blank" was folded into Black). Left out as too few, with what it may be
    rng = np.random.default_rng(11)
    rows = [[["Female", "Male"][i % 2], int(rng.random() < 0.3)] for i in range(600)]
    rows[17][0] = "Femlae"
    f = fair(["Gender", "Churned"], rows)
    assert not any("Femlae" in t.get("groups", {}) for t in f["tests"]), f["tests"]
    assert all("too few to compare: Femlae (1 row, maybe Female)" in t["text"] for t in f["tests"] if t["column"] == "Gender"), [t["text"] for t in f["tests"]]


@pytest.mark.parametrize("col, big, rare", [("Nationality", ["Nigerian", "Ghanaian"], "Nigerien"), ("Race", ["White", "Black"], "Blank")])
def test_a_real_rare_group_one_letter_from_a_usual_one_is_never_counted_in_it(col, big, rare):
    # AH-39 review: 2 people from Niger were counted as Nigerian, and 2 unknown races ("Blank") as Black
    rng = np.random.default_rng(12)
    rows = [[f"E{i}", big[i % 2], int(rng.random() < 0.4)] for i in range(600)]
    rows[7][1] = rows[8][1] = rare
    f = fair(["Employee", col, "Promoted"], rows)
    tests = [t for t in f["tests"] if t["column"] == col]
    assert tests and all(t["groups"][g][0] == sum(r[1] == g for r in rows) for t in tests for g in t["groups"]), [t["groups"] for t in tests]
    # ...a real group is named as too few; "Blank" says no value, so it is no group at all (AH-66 review 2)
    assert all((rare not in t["text"]) if rare == "Blank" else (f"{rare} (2 rows" in t["text"]) for t in tests), [t["text"] for t in tests]


@pytest.mark.parametrize("col, big, rare, said", [("Race", ["White", "Black"], "Blank", None),
                                                  ("Nationality", ["Nigerian", "Ghanaian"], "Nigerien", "Nigerien (2 rows, maybe Nigerian)")])
def test_a_word_that_says_no_value_is_never_named_as_a_group_it_may_be(col, big, rare, said):
    # AH-50: "Blank (2 rows, maybe Black)" gave a race to people whose race is unknown; a demonym keeps its honest "maybe".
    # AH-66 review 2: a word that says no value is no group at all, counted as missing (said None: never named)
    rng = np.random.default_rng(12)
    rows = [[f"E{i}", big[i % 2], int(rng.random() < 0.4)] for i in range(600)]
    rows[7][1] = rows[8][1] = rare
    tests = [t for t in fair(["Employee", col, "Promoted"], rows)["tests"] if t["column"] == col]
    assert tests and all((rare not in t["text"]) if said is None else (said in t["text"]) for t in tests), [t["text"] for t in tests]
    assert not any(f"{rare} (2 rows, maybe" in t["text"] for t in tests if ", maybe" not in (said or "")), [t["text"] for t in tests]


def test_a_place_of_birth_is_a_place_never_an_age():
    rows = [[["Paris", "Rome", "Oslo"][i % 3], ["female", "male"][i % 2], 1900 + i % 90, int(i % 5 == 0)] for i in range(600)]
    f = fair(["birth_city", "gender", "birth_year", "laureate"], rows)
    assert f["protected"].get("birth_city", "").startswith("location") and "birth_year" in f["protected"], f["protected"]


def test_native_born_is_a_persons_origin():
    # the General Social Survey's nativeBorn (yes/no): where a person was born, a protected origin
    rng = np.random.default_rng(13)
    rows = [[["female", "male"][i % 2], ["yes", "no"][int(rng.random() < 0.12)], int(rng.integers(0, 11))] for i in range(900)]
    f = fair(["gender", "nativeBorn", "vocab"], rows)
    assert f["protected"].get("nativeBorn") == "demographic", f["protected"]


def test_a_long_question_with_a_race_word_in_it_is_not_a_race():
    # "Will you shop any Black Friday sales on Thanksgiving Day?" (blind round 36) is a question, never a person's race
    rows = [[["Male", "Female"][i % 2], ["Yes", "No"][i % 3 == 0]] for i in range(600)]
    f = fair(["What is your gender?", "Will you shop any Black Friday sales on Thanksgiving Day?"], rows)
    assert set(f["protected"]) == {"What is your gender?"}, f["protected"]
