"""AH-23: misspelled labels that blind round 22 planted in real tables and both engines missed (6 of 9): a letter dropped
inside a word (parietl, Grmany, Stratovolcno, Nuclear Enrgy) and 4-letter slips (japn, rian). Synthetic sheets only.
The twin risk is measured on the 10,000 commonest English words: dropping one inner letter gives another common word for
2.2% (vowel) / 5.8% (consonant) of 5-letter words, a 4-letter vowel drop 7.2%, a 4-letter swap 4.9% - against 60.8% for
the one-wrong-letter rule the engine already used at 5 letters (kept safe by the same rare-next-to-common gate)."""
import pytest

from anomaly_hunter.agents.scan_agent import scan


def column(usual, odd, others, n=40):
    """n rows of the usual label, 25 of each other label, and the odd spelling once."""
    labels = [usual] * n + [o for o in others for _ in range(25)] + [odd]
    return [[f"r{i}", w, 10 + i % 7] for i, w in enumerate(labels)]


@pytest.mark.parametrize("col, usual, odd, others", [
    ("Lobe", "parietal", "parietl", ["frontal", "temporal"]),                                      # fmri region
    ("Country", "Germany", "Grmany", ["France", "Japan", "Canada", "Great Britain", "USA"]),        # healthexp
    ("Type", "Stratovolcano", "Stratovolcno", ["Shield volcano", "Caldera", "Cinder cone"]),       # volcano types
    ("Source", "Nuclear Energy", "Nuclear Enrgy", ["Fossil Fuels", "Renewables"]),                 # a word of a multi-word label
])
def test_a_letter_dropped_inside_a_word_is_worth_a_check(col, usual, odd, others):
    rows = column(usual, odd, others)
    out = scan(["Id", col, "Units"], rows, fair=False)[1]
    r = out[-1]
    assert r["severity"] == "Low" and f'{col} "{odd}" looks like a misspelling of "{usual}"' in r["reason"], r
    assert r["maybe"] == {col: usual} and not r.get("exact"), "a guess the user confirms, never auto-fixed"
    assert not any("misspelling" in o["reason"] for o in out[:-1])


@pytest.mark.parametrize("col, usual, odd, others", [
    ("origin", "japan", "japn", ["usa", "europe"]),                       # a vowel dropped from a 5-letter label
    ("weather", "rain", "rian", ["sun", "fog", "snow", "drizzle"]),       # two neighbours swapped in a 4-letter label
])
def test_a_four_letter_slip_of_a_common_label_is_worth_a_check(col, usual, odd, others):
    out = scan(["Id", col, "Units"], column(usual, odd, others), fair=False)[1]
    assert out[-1]["maybe"] == {col: usual} and "looks like a misspelling" in out[-1]["reason"], out[-1]


@pytest.mark.parametrize("rare, usual", [
    ("Niger", "Nigeria"), ("Austria", "Australia"), ("Mali", "Malawi"), ("Iran", "Ireland"),   # 2+ letters apart
    ("Iran", "Iraq"), ("Mark", "Mary"), ("Peru", "Pero"),               # a wrong letter in 4: a different word as often as not
    ("Jon", "John"), ("Ann", "Anna"), ("Sara", "Sarah"), ("Clark", "Clarke"),   # a dropped first/last letter, or 3 letters
    ("Phone Case", "Phones Case"), ("Laptop Bag", "Laptops Bag"),       # a word's last letter (plural) in a longer label
    ("Chad", "Chard"),                                                  # a consonant dropped from a 5-letter word
    ("AB12", "AB123"), ("X-ray", "X-rays"),                             # codes and plurals
])
def test_honest_near_twins_are_not_misspellings(rare, usual):
    out = scan(["Id", "Label", "Units"], column(usual, rare, ["Other label", "Something else"]), fair=False)[1]
    assert not any("misspelling" in o["reason"] for o in out), (rare, usual, out[-1]["reason"])


def test_two_common_near_twins_are_both_labels():
    # Austria and Australia, Gambia and Zambia, Hungary and Hungry: when both are common, neither is a slip
    labels = ["Austria"] * 20 + ["Australia"] * 20 + ["Niger"] * 15 + ["Nigeria"] * 15 + ["Japan"] * 9 + ["Japn"] * 9
    out = scan(["Id", "Country", "Units"], [[f"r{i}", w, i % 9] for i, w in enumerate(labels)], fair=False)[1]
    assert not any("misspelling" in o["reason"] for o in out)
