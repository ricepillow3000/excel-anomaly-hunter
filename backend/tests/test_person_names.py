"""AH-24: a column of people's names is full of honest one-slip twins (Thomson/Thompson, Philips/Phillips, Mathew/Matthew).
Measured on the 10,000 commonest US surnames and first names: one inner letter dropped gives another real name for 21%
of surnames and 37% of first names (4.8% of common words), a letter typed twice for 4% and 13% (0.3% of words). So under
a person-name header no misspelling, short form or lowercase guess is offered; capitals/spaces of the very same name
still are. Synthetic sheets only."""
import pytest

from anomaly_hunter.agents.scan_agent import scan

GUESS = ("misspelling of", "short form of", "lowercase where")


def column(usual, odd, others, n=30, extra=lambda i: 10 + i % 7):
    labels = [usual] * n + [o for o in others for _ in range(12)] + [odd]
    return [[f"r{i}", w, extra(i)] for i, w in enumerate(labels)]


PEOPLE = ["Jones", "Brown", "Garcia", "Miller"]


@pytest.mark.parametrize("col, usual, odd", [
    ("Surname", "Thompson", "Thomson"),            # a letter dropped inside the name: both are surnames
    ("Last name", "Phillips", "Philips"),          # a doubled letter typed once
    ("First Name", "Matthew", "Mathew"),
    ("Customer name", "Robinson", "Robison"),
    ("FirstName", "Samantha", "Sam"),              # a short form is a nickname of its own
    ("Family name", "Smith", "mcdonald"),          # its capitals cannot be guessed: McDonald, not "Mcdonald"
    ("Family name", "Smith", "de Vries"),          # a lowercase particle is how the name is written
    # a header that is only a role holds people too (Council A, AH-24 try 1: each of these still offered a guess)
    ("Employee", "Thompson", "Thomson"),
    ("Sales Rep", "Phillips", "Philips"),
    ("Patient", "Matthews", "Mathews"),
    ("Driver", "Davidson", "Davison"),
    ("Author", "Thompson", "Thomson"),
    ("Customer", "Thompson", "Thomson"),
    ("Emp Name", "Thompson", "Thomson"),
    ("Name of patient", "Matthews", "Mathews"),
    ("Name (Last, First)", "Phillips", "Philips"),
])
def test_a_person_name_column_is_never_offered_a_spelling_guess(col, usual, odd):
    out = scan(["Id", col, "Units"], column(usual, odd, ["Jones", "Brown", "Garcia", "Miller"]), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (col, out[-1]["reason"])
    assert not out[-1].get("maybe"), out[-1]


@pytest.mark.parametrize("other", ["Age", "Sex", "Date of birth"])
def test_a_plain_name_column_beside_a_persons_age_or_sex_is_peoples_names(other):
    out = scan(["Id", "Name", other], column("Katherine", "Kathrine", PEOPLE, extra=lambda i: 20 + i % 50 if other == "Age"
               else ("F", "M")[i % 2] if other == "Sex" else f"19{50 + i % 40}-0{1 + i % 9}-1{i % 9}"), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), out[-1]["reason"]


def test_the_same_name_typed_with_other_capitals_or_spaces_is_still_flagged():
    out = scan(["Id", "Surname", "Units"], column("Smith", "smith ", ["Jones", "Brown", "Garcia", "Miller"]), fair=False)[1]
    assert 'looks like "Smith" (same word, different capitals/spaces)' in out[-1]["reason"], out[-1]


@pytest.mark.parametrize("col, usual, odd", [
    ("Country", "Germany", "Grmany"),              # a label column, not a person
    ("City", "Seattle", "Seatle"),
    ("Product name", "Stapler", "Staplre"),        # a "name" that is not a person's
    ("Company name", "Microsoft", "Microsft"),
    ("Team name", "Warriors", "Warrors"),
    # a plain "Name" is not enough on its own: products, cities, car models and airports are named too (Council A,
    # AH-24 try 1: all 3 plain "name" columns in blind round 22's 59 real tables were not people)
    ("Name", "Stapler", "Staplre"),
    ("Name", "Office Chair", "Ofice Chair"),
    ("Name", "Seattle", "Seatle"),
    # a customer that is a company is checked like a company name
    ("Customer", "Microsoft Corp", "Microsft Corp"),
])
def test_a_misspelling_in_a_column_that_is_not_peoples_names_is_still_caught(col, usual, odd):
    others = ["Acme Inc", "Globex LLC", "Initech Ltd"] if col == "Customer" else ["Alpha label", "Second label", "Third label"]
    out = scan(["Id", col, "Units"], column(usual, odd, others), fair=False)[1]
    assert f'{col} "{odd}" looks like a misspelling of "{usual}"' in out[-1]["reason"], out[-1]


@pytest.mark.parametrize("col", ["2024", "#", ""])
def test_a_text_column_whose_header_has_no_letters_is_still_checked_and_never_breaks_the_scan(col):
    out = scan(["Id", col, "Units"], column("Germany", "Grmany", ["Alpha label", "Second label", "Third label"]), fair=False)[1]
    assert 'looks like a misspelling of "Germany"' in out[-1]["reason"], out[-1]


# AH-26 (Council A's notes on AH-24 try 2): roles the list missed, companies with no Inc or Ltd, and an age that is not a
# person's
@pytest.mark.parametrize("col", ["Physician", "Nurse", "Assignee", "Assigned to", "Salesperson", "Athlete", "Coach",
                                 "Instructor", "Reviewer"])
def test_a_role_header_the_first_list_missed_holds_people_too(col):
    out = scan(["Id", col, "Units"], column("Thompson", "Thomson", PEOPLE), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (col, out[-1]["reason"])


@pytest.mark.parametrize("col, people", [
    ("Customer", ["Jones", "Brown", "Garcia", "Miller"]),            # surnames
    ("Owner", ["Ann Jones", "Bob Brown", "Maria Garcia", "Li Wei"]),   # full names, one not in a US list
    ("Client", ["Jones, Ann", "Brown, Bob", "Garcia, Maria", "Okafor, Chidi"]),
])
def test_a_customer_or_owner_column_of_peoples_names_stays_quiet(col, people):
    out = scan(["Id", col, "Units"], column("Thompson", "Thomson", people), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (col, out[-1]["reason"])


@pytest.mark.parametrize("other", ["Age (days)", "Age in days", "Stock age", "Age (hours)", "Age_weeks"])
def test_a_plain_name_beside_an_age_that_is_not_a_persons_is_still_checked(other):
    out = scan(["Id", "Name", other], column("Stapler", "Staplre", ["Desk Lamp", "Office Chair", "Monitor Arm"],
               extra=lambda i: i % 90), fair=False)[1]
    assert 'Name "Staplre" looks like a misspelling of "Stapler"' in out[-1]["reason"], (other, out[-1])


@pytest.mark.parametrize("other", ["Age (years)", "Age in years", "Patient age", "AGE"])
def test_a_plain_name_beside_a_persons_age_in_years_is_still_peoples_names(other):
    out = scan(["Id", "Name", other], column("Katherine", "Kathrine", PEOPLE, extra=lambda i: 20 + i % 50), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (other, out[-1]["reason"])


# AH-26 review (Council B): a list of common US names decided whether a Customer column held people, so the same honest
# twin was left alone in a US roster (Thomson/Thompson) and called a misspelling in a Nigerian or Indian one: 0 of 200
# synthetic Nigerian rosters and every Indian first-name column read as companies. A person's name is a person's name
@pytest.mark.parametrize("col, usual, odd, others", [
    ("Customer", "Adeola", "Adeolu", ["Okafor", "Eze", "Nwosu", "Balogun"]),
    ("Client", "Oluwaseun", "Oluwasen", ["Chinedu", "Ngozi", "Emeka", "Tunde"]),
    ("Owner", "Ananya", "Anaya", ["Priya", "Rohan", "Kavya", "Arjun"]),
])
def test_names_from_outside_a_us_list_are_peoples_names_too(col, usual, odd, others):
    out = scan(["Id", col, "Units"], column(usual, odd, others), fair=False)[1]
    assert not any(g in o["reason"] for o in out for g in GUESS), (col, out[-1]["reason"])
