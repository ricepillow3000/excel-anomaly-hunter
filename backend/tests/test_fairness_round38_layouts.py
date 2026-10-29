"""AH-68: the last wrong "a real gap" sentences of rounds 22-38. A place's blanks where the source kept a column patchily
everywhere ("country US: 48% missing box_office vs 32%"), a contest's host read as a group of people ("host_city Dublin:
0.0% qualified TRUE vs 19%", "host_city Rotterdam: 41% missing rank" for the cancelled 2020 contest), a table of counts
by group read as people ("race_gender Asian: 0.0% missing employ_n vs 9.5%"), a column blank for nearly everyone
("SEX Male Characters: 100% missing GSM vs 99%") and a branch number read as the answer that routed a later blank.
Synthetic sheets only, shaped like those tables."""
import numpy as np

from anomaly_hunter.agents.scan_agent import scan


def fair(cols, rows):
    return scan(cols, rows)[5]


def gaps(f):
    return [t["text"] for t in f["tests"] if t["verdict"] == "gap"]


def films(seed=41):
    # biopics: the box office is unknown for 45% of US and UK films and 8% of co-productions; the source's coverage
    rng = np.random.default_rng(seed)
    cols, rows = ["title", "country", "box_office", "subject_sex", "subject_race", "year_release"], []
    for i in range(760):
        country = str(rng.choice(["US", "UK", "US/UK"], p=[0.64, 0.2, 0.16]))
        blank = rng.random() < (0.08 if country == "US/UK" else 0.46)
        rows.append([f"Film {i}", country, "" if blank else round(float(rng.lognormal(16, 1)), 0), str(rng.choice(["Male", "Female"])),
                     str(rng.choice(["White", "African American", "Other"], p=[0.7, 0.2, 0.1])), int(rng.integers(1940, 2015))])
    return cols, rows


def test_a_place_where_the_source_kept_a_column_patchily_everywhere_is_coverage_never_a_gap():
    f = fair(*films())
    assert not [t["text"] for t in f["tests"] if t["column"] == "country" and t["measure"] == "missing" and t["verdict"] == "gap"], gaps(f)


def members(seed=42):
    # congress terms: a member's middle name kept for some states' records more than others', 0% to 38% blank
    rng = np.random.default_rng(seed)
    states = [f"S{k:02d}" for k in range(30)]
    rate = {s: k / 80 for k, s in enumerate(states)}
    cols, rows = ["bioguide", "firstname", "middlename", "state", "party", "age", "sex"], []
    for i in range(6000):
        st = str(rng.choice(states))
        rows.append([f"B{i:05d}", f"Name{i % 300}", "" if rng.random() < rate[st] else f"M{i % 50}", st, str(rng.choice(["D", "R"])),
                     int(rng.integers(30, 80)), str(rng.choice(["M", "F"], p=[0.9, 0.1]))])
    return cols, rows


def test_a_middle_name_kept_more_in_some_states_records_is_coverage_never_a_gap():
    f = fair(*members())
    assert not [t["text"] for t in f["tests"] if t["column"] == "state" and t["measure"] == "missing" and t["verdict"] == "gap"], gaps(f)


def contests(seed=43):
    # a song contest: each year's host city and country, its entries; the 2020 contest was cancelled (no running order,
    # points or rank), the early ones had no semi-final (none qualified), and some hosts won more often
    rng = np.random.default_rng(seed)
    hosts = [("Dublin", "Ireland"), ("London", "United Kingdom"), ("Oslo", "Norway"), ("Rotterdam", "Netherlands"), ("Baku", "Azerbaijan"),
             ("Moscow", "Russia"), ("Stockholm", "Sweden"), ("Kyiv", "Ukraine"), ("Vienna", "Austria"), ("Lisbon", "Portugal")]
    cols, rows = ["event", "host_city", "host_country", "artist", "artist_country", "running_order", "total_points", "rank", "qualified", "winner"], []
    for y in range(1970, 2024):
        city, country = hosts[y % len(hosts)]
        cancelled = y == 2020
        n = 20 + (y - 1970) // 3
        for k in range(n):
            rows.append([f"{city} {y}", city, country, f"Artist {y}-{k}", f"Country {k % 40}", "" if cancelled and k < 4 else k + 1,
                         "" if cancelled else int(rng.integers(0, 300)), "" if cancelled else k + 1,
                         "TRUE" if y > 2004 and rng.random() < 0.5 else "FALSE", "TRUE" if k == 0 and not cancelled else "FALSE"])
    return cols, rows


def test_a_contests_host_is_a_property_of_the_year_never_a_group_of_people():
    f = fair(*contests())
    assert not [t["text"] for t in f["tests"] if t["column"] in ("host_city", "host_country")], [t["text"] for t in f["tests"]]


def counts(seed=44):
    # employed persons by industry, occupation and race/sex, with each industry's total: rows are figures for groups
    rng = np.random.default_rng(seed)
    cols, rows = ["industry", "occupation", "race_gender", "industry_total", "employ_n", "year"], []
    for ind in range(14):
        for occ in range(10):
            for y in (2015, 2016, 2017, 2018, 2019, 2020):
                for g in ["TOTAL", "Men", "Women", "White", "Black or African American", "Asian"]:
                    gone = g != "Asian" and occ == 9 and ind < 8  # some occupations' counts withheld, the Asian series shorter
                    rows.append([f"Industry {ind}", f"Occupation {occ}", g, "" if gone else 1000 * (ind + 1), "" if gone else int(rng.integers(1000, 90000)), y])
    return cols, rows


def test_a_table_of_counts_by_group_is_no_sheet_of_people():
    assert fair(*counts()) == {"protected": {}, "tests": []}


def characters(seed=45):
    # comic characters: GSM (a gender or sexual minority) written for 1% of them, blank for everyone else
    rng = np.random.default_rng(seed)
    cols, rows = ["name", "ALIGN", "EYE", "SEX", "GSM", "APPEARANCES"], []
    for i in range(4000):
        sex = str(rng.choice(["Male Characters", "Female Characters", "Agender Characters"], p=[0.74, 0.25, 0.01]))
        rows.append([f"Hero {i}", str(rng.choice(["Good", "Bad", "Neutral"])), str(rng.choice(["Blue", "Brown", ""])), sex,
                     "Bisexual Characters" if rng.random() < (0.004 if sex == "Male Characters" else 0.012) else "", int(rng.integers(1, 400))])
    return cols, rows


def test_a_column_blank_for_nearly_everyone_in_every_group_is_never_measured_as_missing():
    f = fair(*characters())
    assert not [t["text"] for t in f["tests"] if t["test"] == "missing GSM"], [t["text"] for t in f["tests"] if "GSM" in t["text"]]


def loans(seed=46):
    # Council B's probe: branches 5 and 6 never record Income, and most Black applicants apply there
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(1200):
        race = "Black" if rng.random() < 0.3 else "White"
        branch = int(rng.choice([5, 6]) if (race == "Black" and rng.random() < 0.7) else rng.integers(1, 5))
        rows.append([f"L{i}", race, branch, "" if branch >= 5 else int(rng.integers(20000, 90000)), "Approved" if rng.random() < 0.6 else "Denied"])
    return ["Applicant ID", "Race", "Branch", "Income", "Decision"], rows


def test_a_branch_number_is_a_lookup_never_the_answer_that_routed_a_blank():
    f = fair(*loans())
    t = next(t for t in f["tests"] if t["column"] == "Race" and t["test"] == "missing Income")
    assert t["verdict"] == "gap" and "counted where it was asked" not in t["text"], t["text"]
    cols, rows = loans()
    rows = [r[:2] + [f"Branch {r[2]}"] + r[3:] for r in rows]
    t = next(t for t in fair(cols, rows)["tests"] if t["column"] == "Race" and t["test"] == "missing Income")
    assert t["verdict"] == "gap" and "counted where it was asked" not in t["text"], t["text"]


def test_a_question_skipped_more_in_one_region_stays_a_gap_where_the_source_keeps_it_patchily():
    # a survey's rating of a cuisine, skipped by 40% of respondents everywhere and by 60% in one region: the people's own
    # answer, never the source's coverage
    rng = np.random.default_rng(47)
    regions = [f"Region {k}" for k in range(8)]
    rows = [[f"R{i}", reg, str(rng.choice(["Male", "Female"])), "" if rng.random() < (0.62 if reg == "Region 0" else 0.4) else int(rng.integers(1, 6))]
            for i, reg in ((i, str(rng.choice(regions))) for i in range(2400))]
    f = fair(["RespondentID", "Location (Census Region)", "Gender", "Please rate how much you like the traditional cuisine of Vietnam."], rows)
    t = next(t for t in f["tests"] if t["column"] == "Location (Census Region)" and t["measure"] == "missing")
    assert t["verdict"] == "gap" and t["text"].startswith("Location (Census Region) Region 0:"), t["text"]
