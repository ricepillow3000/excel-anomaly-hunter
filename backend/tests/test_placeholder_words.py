"""AH-50 (from AH-39's review): a word that says a value is not known (Blank, Unknown, None, Missing, TBD, Not stated)
is never guessed to be another label. Race "Blank" beside "Black" read 'looks like a misspelling of "Black"' and, in
the fairness report, "Blank (2 rows, maybe Black)": a race given to people whose race is unknown. A real typo, a typo of
a placeholder ("Unknwn") and a demonym ("Nigerien", honest as a "maybe") keep their guess. Synthetic sheets only."""
import pytest

from anomaly_hunter.agents.scan_agent import scan


def column(col, usual, rare, n=300):
    rows = [[f"E{i}", usual[i % len(usual)], 1000 + i] for i in range(n)]
    rows[7][1] = rows[8][1] = rare
    return scan(["Employee", col, "Salary"], rows, fair=False)[1]


@pytest.mark.parametrize("col, usual, rare", [("Race", ["White", "Black", "Asian"], "Blank"),
                                              ("Status", ["Known", "Pending"], "Unknown"),
                                              ("Answer", ["Mission", "Office"], "Missing"),
                                              ("Code", ["TBC1", "Ready"], "TBD"),
                                              ("Ethnicity", ["Not Hispanic", "Hispanic"], "Not stated")])
def test_a_word_that_says_no_value_is_never_guessed_to_be_another_label(col, usual, rare):
    out = column(col, usual, rare)
    said = out[7]["reason"]
    assert "looks like a misspelling" not in said and "looks like a short form" not in said and not out[7].get("maybe"), out[7]


@pytest.mark.parametrize("col, usual, rare, guess", [("Status", ["Unknown", "Known"], "Unknwn", "Unknown"),
                                                     ("Nationality", ["Nigerian", "Ghanaian"], "Nigerien", "Nigerian"),
                                                     ("Dept", ["Finance", "Sales"], "Fiance", "Finance")])
def test_a_real_typo_and_a_demonym_keep_their_guess(col, usual, rare, guess):
    out = column(col, usual, rare)
    assert out[7].get("maybe") == {col: guess}, out[7]
