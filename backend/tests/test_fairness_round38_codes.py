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
