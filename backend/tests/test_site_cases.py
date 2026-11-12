"""AH-133 (John, 2026-11-05: "case studies"). The three case studies (on cases.html since AH-159) quote what Arcas said about real public
tables, FiveThirtyEight's (CC BY 4.0). A quote on a website drifts the way the sample did (test_site_sample.py), so
this re-scans each committed excerpt the way the pane sends it (POST /scan, every cell as trimmed text, strength 5) and
reads each card back: every row the pane would list is quoted, in the pane's own words and with its label, and nothing
else is; the facts each card states are read from the excerpt itself; each card credits its source and licence."""
import csv
import html
import json
import re
from pathlib import Path

from anomaly_hunter.server import create_app
from test_site_sample import plain_reason

ROOT = Path(__file__).resolve().parents[2]
CASES = Path(__file__).resolve().parent / "fixtures" / "cases"
PAGE = ROOT / "site" / "cases.html"  # their own page since AH-159
APP = create_app().test_client()
SEV = {"High": "very likely wrong", "Medium": "probably wrong", "Low": "worth a check"}  # frontend/constants SEV, as a clause
NAMES = ("classic-rock-release-year", "mad-men-div0", "daily-show-media")


def excerpt(name):
    with open(CASES / f"{name}.csv", encoding="utf-8", newline="") as fh:
        rows = list(csv.reader(fh))
    return rows[0], [[c.strip() for c in r] for r in rows[1:]]


def scan(name):
    columns, rows = excerpt(name)
    r = APP.post("/scan", json={"columns": columns, "rows": rows, "limits": None, "order_by": None, "strength": 5})
    assert r.status_code == 200, r.get_json()
    return {i + 2: r for i, r in enumerate(r.get_json()["rows"]) if r["severity"] in SEV}  # Noted is never listed


def cards():
    src = PAGE.read_text(encoding="utf-8")
    section = re.search(r'<section\b[^>]*\sid="cases".*?</section>', src, re.S)
    assert section, 'cases.html has no section id="cases"'
    found = {m[1]: m[2] for m in re.finditer(r'<article class="case[^"]*" data-case="([\w-]+)"[^>]*>(.*?)</article>', section[0], re.S)}
    assert sorted(found) == sorted(NAMES), sorted(found)
    return found


def text(s):
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", s)).split())


def quotes(card):
    """[(rows, label, words)] from each <li data-rows="13 34 88">Rows 13, 34 and 88, probably wrong: <q>...</q></li>"""
    out = []
    for m in re.finditer(r'<li data-rows="([\d ]+)">([^<]*)<q>(.*?)</q></li>', card, re.S):
        rows = [int(n) for n in m[1].split()]
        out.append((rows, text(m[2]), text(m[3])))
    assert out, "a card quotes nothing"
    return out


def test_every_case_study_quotes_every_row_the_pane_lists_on_its_excerpt_in_the_panes_own_words():
    for name, card in cards().items():
        said = scan(name)
        quoted = {}
        for rows, label, words in quotes(card):
            ns = ", ".join(map(str, rows[:-1])) + (" and " if len(rows) > 1 else "") + str(rows[-1])
            for n in rows:
                assert n in said, f"{name}: row {n} is quoted but the pane lists nothing there"
                r = said[n]
                assert words == plain_reason(r["reason"]), f"{name}: row {n} says {plain_reason(r['reason'])!r}, the page {words!r}"
                assert label == f"{'Rows' if len(rows) > 1 else 'Row'} {ns}, {SEV[r['severity']]}:", f"{name}: {label!r}"
                quoted[n] = words
        # never one finding shown as the only one (the Daily Show excerpt's occupations are flagged too)
        assert sorted(quoted) == sorted(said), f"{name}: rows the pane lists but the card leaves out: {sorted(set(said) - set(quoted))}"


def test_each_case_study_credits_its_source_and_licence_and_says_how_much_of_the_table_was_scanned():
    for name, card in cards().items():
        meta = json.loads((CASES / f"{name}.json").read_text(encoding="utf-8"))
        _, rows = excerpt(name)
        assert meta["excerpt_rows"] == len(rows), name
        assert "CC BY 4.0" in meta["licence"] and meta["source_page"].startswith("https://github.com/fivethirtyeight/data/tree/master/")
        credit = re.search(r'<p class="case-credit">(.*?)</p>', card, re.S)
        assert credit and f'<a href="{meta["source_page"]}">' in credit[1] and text(credit[1]).startswith("Data: FiveThirtyEight, CC BY 4.0"), name
        assert f"{len(rows)} of its {meta['full_rows']:,} rows" in text(card), name
    readme = (CASES / "README.md").read_text(encoding="utf-8")
    for name in NAMES:
        assert f"{name}.csv" in readme
    assert "CC BY 4.0" in readme and "re-encoded" in readme  # the Mad Men names, Mac Roman to UTF-8


def test_what_each_case_study_says_is_wrong_is_read_from_its_own_excerpt():
    found = cards()
    # classic rock: every other Elton John song with a year is from 1970 to 1975; Levon's is 1071; Bullfrog Blues holds
    # the website's name where its year goes, while its own Year? says a year was found
    cols, rows = excerpt("classic-rock-release-year")
    c = {k: cols.index(k) for k in ("Song Clean", "ARTIST CLEAN", "Release Year", "Year?")}
    elton = [(r[c["Song Clean"]], r[c["Release Year"]]) for r in rows if r[c["ARTIST CLEAN"]] == "Elton John"]
    assert ("Levon", "1071") in elton and len(elton) > 5
    assert all(1970 <= int(y) <= 1975 for s, y in elton if y and s != "Levon")
    bull = rows[96 - 2]
    assert (bull[c["Song Clean"]], bull[c["Release Year"]], bull[c["Year?"]]) == ("Bullfrog Blues", "SONGFACTS.COM", "1")
    rock = text(found["classic-rock-release-year"])
    assert "every other Elton John song in the table is from 1970 to 1975" in rock and "unknown" in rock
    assert "1971" not in rock  # a guess the table cannot prove
    # Mad Men: the three #DIV/0! rows are the three whose Years Since is 0
    cols, rows = excerpt("mad-men-div0")
    y, s = cols.index("Years Since"), cols.index("Score/Y")
    assert [n for n, r in enumerate(rows, 2) if r[s] == "#DIV/0!"] == [n for n, r in enumerate(rows, 2) if r[y] == "0"] == [119, 120, 121]
    assert "which is 0 for all three" in text(found["mad-men-div0"]) and "unknown" in text(found["mad-men-div0"])
    # Daily Show: the lowercase "media" rows, and Media the usual spelling
    cols, rows = excerpt("daily-show-media")
    g = cols.index("Group")
    groups = [r[g] for r in rows]
    assert [n for n, v in enumerate(groups, 2) if v == "media"] == [13, 34, 88] and groups.count("Media") > 3
    assert "The right value is Media" in text(found["daily-show-media"])
