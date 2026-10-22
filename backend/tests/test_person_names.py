"""AH-24: a column of people's names is full of honest one-slip twins (Thomson/Thompson, Philips/Phillips, Mathew/Matthew).
Measured on the 10,000 commonest US surnames and first names: one inner letter dropped gives another real name for 21%
of surnames and 37% of first names (4.8% of common words), a letter typed twice for 4% and 13% (0.3% of words). So under
a person-name header no misspelling, short form or lowercase guess is offered; capitals/spaces of the very same name
still are. Synthetic sheets only."""
import pytest

from anomaly_hunter.agents.scan_agent import scan

GUESS = ("misspelling of", "short form of", "lowercase where")


def column(usual, odd, others, n=30):
    labels = [usual] * n + [o for o in others for _ in range(12)] + [odd]
    return [[f"r{i}", w, 10 + i % 7] for i, w in enumerate(labels)]


@pytest.mark.parametrize("col, usual, odd", [
    ("Surname", "Thompson", "Thomson"),            # a letter dropped inside the name: both are surnames
    ("Last name", "Phillips", "Philips"),          # a doubled letter typed once
    ("First Name", "Matthew", "Mathew"),
    ("Name", "Katherine", "Kathrine"),
    ("Customer name", "Robinson", "Robison"),
    ("FirstName", "Samantha", "Sam"),              # a short form is a nickname of its own
    ("Family name", "Smith", "mcdonald"),          # its capitals cannot be guessed: McDonald, not "Mcdonald"
    ("Family name", "Smith", "de Vries"),          # a lowercase particle is how the name is written
])
def test_a_person_name_column_is_never_offered_a_spelling_guess(col, usual, odd):
    out = scan(["Id", col, "Units"], column(usual, odd, ["Jones", "Brown", "Garcia", "Miller"]), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (col, out[-1]["reason"])
    assert not out[-1].get("maybe"), out[-1]


def test_the_same_name_typed_with_other_capitals_or_spaces_is_still_flagged():
    out = scan(["Id", "Surname", "Units"], column("Smith", "smith ", ["Jones", "Brown", "Garcia", "Miller"]), fair=False)[1]
    assert 'looks like "Smith" (same word, different capitals/spaces)' in out[-1]["reason"], out[-1]


@pytest.mark.parametrize("col, usual, odd", [
    ("Country", "Germany", "Grmany"),              # a label column, not a person
    ("City", "Seattle", "Seatle"),
    ("Product name", "Stapler", "Staplre"),        # a "name" that is not a person's
    ("Company name", "Microsoft", "Microsft"),
    ("Team name", "Warriors", "Warrors"),
])
def test_a_misspelling_in_a_column_that_is_not_peoples_names_is_still_caught(col, usual, odd):
    out = scan(["Id", col, "Units"], column(usual, odd, ["Alpha label", "Second label", "Third label"]), fair=False)[1]
    assert f'{col} "{odd}" looks like a misspelling of "{usual}"' in out[-1]["reason"], out[-1]
