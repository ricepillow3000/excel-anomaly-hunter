"""Blind round 38's last wrong gaps (AH-65, AH-66). A survey's later questions routed by an earlier answer written as a
number code ("race White: 81% missing Q29_1 vs 71% - a real gap": Q29 is asked only of those who do not always vote,
Q26 = 2, 3 or 4), a flag rate that was only blanks where a source never recorded a column ("State TX: 0.9% rows flagged
vs 25%": Race was left blank for whole states), and a team member's number blank for every individual event ("gender
Women: 79% missing grp_id vs 71%"). Synthetic sheets only, shaped like those tables."""
import numpy as np

from anomaly_hunter.agents.scan_agent import scan


def fair(cols, rows):
    return scan(cols, rows)[5]


def gaps(f):
    return [t["text"] for t in f["tests"] if t["verdict"] == "gap"]


def voters(n=3000, seed=21, skip=None):
    # 45 earlier questions, then how often they vote (Q26, 1 = always) and their party (Q30): Q29_* is asked only of those
    # who do not always vote, Q31 only of Republicans (1), Q33 only of the rest (3-5). White respondents vote more often
    # and lean Republican more, so their rows are routed past more often
    rng = np.random.default_rng(seed)
    cols = ["RespId"] + [f"P{k}" for k in range(1, 46)] + ["Q26", "Q29_1", "Q29_2", "Q29_3", "Q30", "Q31", "Q33", "race", "gender"]
    rows = []
    for i in range(n):
        race = str(rng.choice(["White", "Black", "Hispanic"], p=[0.6, 0.2, 0.2]))
        sex = str(rng.choice(["Male", "Female"]))
        q26 = int(rng.choice([1, 2, 3, 4], p=[0.85, 0.05, 0.05, 0.05] if race == "White" else [0.65, 0.12, 0.12, 0.11]))
        q30 = int(rng.choice([1, 2, 3, 4, 5], p=[0.4, 0.25, 0.2, 0.05, 0.1] if race == "White" else [0.15, 0.5, 0.2, 0.05, 0.1]))
        early = [int(rng.integers(1, 5)) for _ in range(45)]
        q29 = [int(rng.choice([1, 2])) if q26 != 1 else "" for _ in range(3)]
        if skip and q26 != 1 and rng.random() < skip.get(race, 0):
            q29[0] = ""  # a real skip among the asked
        rows.append([f"R{i}"] + early + [q26] + q29 + [q30, int(rng.choice([1, 2])) if q30 == 1 else "",
                                                     int(rng.choice([1, 2])) if q30 >= 3 else "", race, sex])
    return cols, rows


def test_a_later_question_routed_by_a_number_coded_answer_is_counted_where_it_was_asked():
    f = fair(*voters())
    assert not gaps(f), gaps(f)  # every asked row answered: nothing left to compare
    f = fair(*voters(skip={"Black": 0.03, "White": 0.03, "Hispanic": 0.03}))  # a few skips, as many in every group
    t = next(t for t in f["tests"] if t["column"] == "race" and t["test"] == "missing Q29_1")
    assert t["verdict"] != "gap" and t["text"].endswith("; counted where it was asked (Q26: 2, 3, 4)"), t["text"]
    assert not gaps(f), gaps(f)


def test_a_real_skip_gap_among_those_a_number_coded_answer_asked_is_still_found():
    f = fair(*voters(skip={"Black": 0.3, "White": 0.03, "Hispanic": 0.03}))
    t = next(t for t in f["tests"] if t["column"] == "race" and t["test"] == "missing Q29_1")
    assert t["verdict"] == "gap" and t["text"].startswith("race Black:") and "counted where it was asked (Q26: 2, 3, 4)" in t["text"], t["text"]


STATES = ["AL", "CA", "GA", "NV", "NY", "OH", "OK", "PA", "TX", "VA"]


def candidates(seed=31):
    # a primary's candidates, sorted by state: the source recorded each candidate's race for some states only (NV, NY, OH
    # half blank), so the scan flags those blanks, and by State the flag rate looked like "TX: 0.9% vs 25%"
    rng = np.random.default_rng(seed)
    cols = ["Candidate", "State", "Primary Status", "Primary %", "Race", "Veteran?"]
    rows = []
    for st in STATES:
        for i in range(90 if st != "TX" else 120):
            race = "" if st in ("NV", "NY", "OH") and rng.random() < 0.5 else str(rng.choice(["White", "Nonwhite"]))
            rows.append([f"{st} candidate {i}", st, str(rng.choice(["Advanced", "Lost"])), round(float(rng.uniform(5, 60)), 1),
                         race, str(rng.choice(["Yes", "No"]))])
    return cols, rows


def test_a_flag_rate_by_state_that_is_only_blanks_where_a_source_kept_a_column_is_never_a_gap():
    f = fair(*candidates())
    assert not [t for t in f["tests"] if t["measure"] == "flag" and t["verdict"] == "gap"], gaps(f)


def test_a_real_flag_rate_gap_from_wrong_values_is_still_found_and_says_what_it_counts():
    # line totals mistyped on women's orders far more often: the scan flags their rows more, a gap to report; and a few
    # blank phones are counted under their column, so the sentence says it counts the rows flagged for a value
    rng = np.random.default_rng(32)
    cols, rows = ["Customer", "Gender", "Units", "Price", "Total", "Phone"], []
    for i in range(2000):
        sex = str(rng.choice(["Female", "Male"]))
        units, price = int(rng.integers(1, 20)), round(float(rng.uniform(2, 90)), 2)
        total = round(units * price, 2)
        if rng.random() < (0.05 if sex == "Female" else 0.005):
            total = round(total + float(rng.choice([1, -1])) * round(float(rng.uniform(5, 40)), 2), 2)
        rows.append([f"C{i}", sex, units, price, total, "" if i % 300 == 7 else f"555-{i:04d}"])
    t = next(t for t in fair(cols, rows)["tests"] if t["column"] == "Gender" and t["test"] == "flag rate")
    assert t["verdict"] == "gap" and t["text"].startswith("Gender Female:") and "rows flagged for a value" in t["text"], t["text"]


def medals(seed=33, guide_gap=False):
    # medal rows of a games: an individual event has 3 rows (Gold, Silver, Bronze), a team event 3 teams of 4 numbered
    # members (grp_id 1-4); women entered fewer team events, so they had more blank grp_id, the event's layout
    rng = np.random.default_rng(seed)
    cols, rows = ["gender", "event", "medal", "athlete", "grp_id", "classification"], []
    k = 0
    for e in range(300):
        sex = "Men" if e % 5 < 3 else "Women"
        team = rng.random() < (0.3 if sex == "Men" else 0.15)
        for medal in ["Gold", "Silver", "Bronze"]:
            for member in range(1, 5) if team else [None]:
                k += 1
                blank = rng.random() < ((0.3 if sex == "Women" else 0.05) if guide_gap else 0.02)
                rows.append([sex, f"{sex} event {e}{' team' if team else ''}", medal, f"Athlete {k}", member if team else "NA",
                             "" if blank else str(rng.choice(["T11", "T12", "T13"]))])
    return cols, rows


def test_a_team_members_number_blank_for_every_individual_event_is_the_events_layout_never_a_gap():
    f = fair(*medals())
    said = [t["text"] for t in f["tests"] if t["test"] == "missing grp_id"]
    assert not [s for s in said if "a real gap" in s], said


def test_a_real_gap_in_blanks_beside_an_events_layout_is_still_found():
    f = fair(*medals(guide_gap=True))
    t = next(t for t in f["tests"] if t["column"] == "gender" and t["test"] == "missing classification")
    assert t["verdict"] == "gap" and t["text"].startswith("gender Women:"), t["text"]


def test_a_persons_own_id_never_explains_their_blanks():
    # a panel: each member on 6 terms under an id whose header names no person (congress terms' bioguide), Income blank
    # for all of a member's terms, far more often for women. Every member's rows are all blank or all filled, like an
    # event's, but who someone is never gates their own blanks
    rng = np.random.default_rng(34)
    cols, rows = ["bioguide", "Sex", "Term", "Income"], []
    for p in range(400):
        sex = str(rng.choice(["F", "M"]))
        none = rng.random() < (0.4 if sex == "F" else 0.1)
        rows += [[f"P{p:03d}", sex, v, "" if none else round(float(rng.normal(50000, 9000)), 0)] for v in range(1, 7)]
    t = next((t for t in fair(cols, rows)["tests"] if t["column"] == "Sex" and t["test"] == "missing Income"), None)
    assert t and t["verdict"] == "gap" and t["text"].startswith("Sex F:") and "counted where" not in t["text"], t


def athletes(head="event", seed=1):
    # Council B's probe (AH-66 review 1): gendered events of 4-8 athletes; 2 of every 5 women's events never had their
    # times recorded, men's times 5% blank at random. The events left blank are all women's: the group's own gap, never
    # the event's layout
    rng = np.random.default_rng(seed)
    rows = []
    for e in range(60):
        sex = "Women" if e % 2 else "Men"
        lost = sex == "Women" and e % 5 in (1, 3)
        for k in range(int(rng.integers(4, 9))):
            t = "" if lost or (sex == "Men" and rng.random() < 0.05) else round(float(rng.uniform(10, 60)), 2)
            rows.append([f"A{len(rows)}", sex, f"{sex}'s event {e}", t, int(rng.integers(18, 40))])
    return ["Athlete", "gender", head, "Time", "Age"], rows


def test_events_that_one_group_alone_left_blank_are_that_groups_gap_never_the_events_layout():
    for head in ("event", "Event name"):
        f = fair(*athletes(head))
        t = next(t for t in f["tests"] if t["column"] == "gender" and t["test"] == "missing Time")
        assert t["verdict"] == "gap" and t["text"].startswith("gender Women: 39% missing Time vs 5.4% for Men"), t["text"]


def artists(seed=35):
    # an anthology's artists: a person's gender and nationality left "N/A" far more often for non-white artists (an
    # unknown race is counted Non-White, as the source does). The scan flags those placeholders; leaving those rows out
    # of the flag rate must not lose the gap: it is the blanks of a column about people, by race
    rng = np.random.default_rng(seed)
    cols, rows = ["artist_name", "edition", "artist_nationality", "artist_gender", "artist_race", "artist_race_nwi", "space_ratio"], []
    for i in range(1500):
        race = str(rng.choice(["White", "Black or African American", "Asian", "N/A"], p=[0.88, 0.05, 0.05, 0.02]))
        nwi = "White" if race == "White" else "Non-White"
        unknown = rng.random() < (0.25 if nwi == "Non-White" else 0.002)
        rows.append([f"Artist {i}", int(rng.integers(1, 17)), "N/A" if unknown and rng.random() < 0.4 else str(rng.choice(["American", "French", "British"])),
                     "N/A" if unknown else str(rng.choice(["Male", "Female"], p=[0.85, 0.15])), race, nwi, round(float(rng.uniform(0.1, 3)), 3)])
    return cols, rows


def test_a_peoples_identity_left_unknown_far_more_often_for_one_race_is_a_gap_in_that_columns_blanks():
    f = fair(*artists())
    said = [t["text"] for t in f["tests"] if t["column"] == "artist_race_nwi" and t["verdict"] == "gap"]
    assert any(s.startswith("artist_race_nwi Non-White:") and "missing artist_gender" in s and "for White" in s for s in said), said


def test_an_unknown_label_that_marks_the_same_unknown_people_is_never_their_routing():
    # artists' ethnicity "NA" sits on the same rows as their gender "N/A" (57 of 58 Non-White): read as an answer that
    # routed the gender question past them, it hid "Non-White: 25% missing artist_gender vs 0.0% for White"
    cols, rows = artists()
    cols = cols + ["artist_ethnicity"]
    rows = [r + ["NA" if r[3] == "N/A" else ("Hispanic or Latino origin" if i % 20 == 0 else "Not Hispanic or Latino origin")]
            for i, r in enumerate(rows)]
    said = [t["text"] for t in fair(cols, rows)["tests"] if t["column"] == "artist_race_nwi" and t["verdict"] == "gap"]
    assert any(s.startswith("artist_race_nwi Non-White:") and "missing artist_gender" in s for s in said), said


def test_a_label_that_says_no_value_is_never_a_group_of_people():
    # AH-66 review 2: "artist_ethnicity NA: 43% missing artist_race vs 0.1% - a real gap" was the same unknown people
    # counted twice, a group defined by its own missing identity; so was tate's "gender NA: 24% missing yearOfBirth"
    cols, rows = artists()
    cols = cols + ["artist_ethnicity"]
    rows = [r + ["NA" if r[3] == "N/A" else ("Hispanic or Latino origin" if i % 20 == 0 else "Not Hispanic or Latino origin")]
            for i, r in enumerate(rows)]
    f = fair(cols, rows)
    assert not [t["text"] for t in f["tests"] if "NA" in t.get("groups", {}) or " NA:" in t["text"]], [t["text"] for t in f["tests"]]
    said = [t["text"] for t in f["tests"] if t["column"] == "artist_race_nwi" and t["verdict"] == "gap"]
    assert any(s.startswith("artist_race_nwi Non-White:") and "missing artist_gender" in s for s in said), said


def games(seed=36):
    # athletes of 12 Games: the early Games kept no age for a quarter of their (mostly male) athletes, the later ones kept
    # every age. By host city that is which Games recorded ages, never a gap; by sex it is the men's ages that are missing
    rng = np.random.default_rng(seed)
    cities = ["Athens", "Paris", "St. Louis", "London", "Stockholm", "Antwerp", "Sydney", "Athens 2004", "Beijing", "London 2012",
              "Rio de Janeiro", "Tokyo"]
    cols, rows = ["Name", "sex", "age", "city", "medal"], []
    for k, city in enumerate(cities):
        early = k < 6
        for i in range(150):
            sex = "M" if rng.random() < (0.97 if early else 0.55) else "F"
            rows.append([f"Athlete {k}-{i}", sex, "" if early and rng.random() < 0.25 else int(rng.integers(16, 40)), city,
                         str(rng.choice(["Gold", "Silver", "Bronze", "None"]))])
    return cols, rows


def test_a_host_city_never_measures_a_peoples_column_blanks_and_the_sex_gap_stays():
    f = fair(*games())
    assert not [t["text"] for t in f["tests"] if t["column"] == "city" and t["test"] == "missing age"], f["tests"]
    t = next(t for t in f["tests"] if t["column"] == "sex" and t["test"] == "missing age")
    assert t["verdict"] == "gap" and t["text"].startswith("sex M:"), t["text"]


def test_a_people_column_of_mostly_or_only_no_value_labels_never_breaks_the_report():
    rng = np.random.default_rng(37)
    for share in (0.9, 1.0):
        rows = [[f"C{i}", "NA" if rng.random() < share else str(rng.choice(["White", "Black"])), str(rng.choice(["F", "M"])),
                 "Yes" if rng.random() < 0.3 else "No"] for i in range(600)]
        f = fair(["Customer", "race", "sex", "Churned"], rows)
        assert any(t["column"] == "sex" for t in f["tests"]), f["tests"]
        assert not any("NA" in t.get("groups", {}) for t in f["tests"]), f["tests"]


def test_those_who_declined_to_say_who_they_are_are_never_a_group_for_another_identity_columns_blanks():
    # salary survey: "gender Other or prefer not to answer: 2.2% missing race vs 0.4% - a real gap" was one refusal twice
    rng = np.random.default_rng(38)
    rows = []
    for i in range(3000):
        sex = str(rng.choice(["Woman", "Man", "Other or prefer not to answer"], p=[0.6, 0.3, 0.1]))
        race = "" if rng.random() < (0.05 if sex.startswith("Other") else 0.004) else str(rng.choice(["White", "Black", "Asian"]))
        rows.append([f"R{i}", sex, race, round(float(rng.normal(80000, 15000)), 0)])
    f = fair(["Respondent", "gender", "race", "annual_salary"], rows)
    assert not [t["text"] for t in f["tests"] if t["column"] == "gender" and t["test"] == "missing race" and t["verdict"] == "gap"], f["tests"]
    assert any(t["column"] == "gender" and "Other or prefer not to answer" in t.get("groups", {}) for t in f["tests"]), f["tests"]
