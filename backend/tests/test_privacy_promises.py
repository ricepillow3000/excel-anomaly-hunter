"""The three privacy pages keep up with what the code does (AH-87): what the pane keeps and how to clear it, the relay's
terms as configured, and a cost Google can charge. The twins' rule (test_fix.py) checks they name every place and file;
this checks the rest of what they promise, and that the pane's and the website's sections stay word for word the same.
"""
import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PAGES = ("PRIVACY.md", "frontend/privacy.html", "site/privacy.html")


def words(page):
    return " ".join(re.sub(r"<[^>]+>|`|\*\*", "", (ROOT / page).read_text(encoding="utf-8")).replace("&gt;", ">").split())


def test_every_privacy_page_says_what_the_pane_keeps_how_to_clear_it_and_the_relays_terms_as_configured():
    caps = tomllib.loads((ROOT / "relay" / "wrangler.toml").read_text(encoding="utf-8"))["vars"]
    promises = (
        "anomalyHunterAutoFix", "anomalyHunterPowerBi", "localStorage",  # both of the pane's own keys, by name
        "Forget what this workbook saved", "Options > Saved in this workbook", "It changes no cell",
        # the relay's counter is the last day's until the next day's first call replaces it (relay/worker.js Counter)
        "for the last day anyone used it", "The first call of a new day replaces it",
        f"{caps['DAILY_PER_INVITE']} AI calls per invite and {caps['DAILY_TOTAL']} for everyone together a day",
        "John can turn off any invite at any time", "no promise it is up",
        "billing turned on can be charged by Google",
        # AH-104: the key and the invite code are sealed for this Windows account, and what that does not stop is said
        "sealed with Windows' own encryption (DPAPI) for your Windows account", "a program running as you could still open it",
        "server.log.1 keeps the run before",  # AH-106: the last run's log outlives the next start
    )
    for page in PAGES:
        said = words(page)
        assert [p for p in promises if p not in said] == [], page
        assert "one counter for today" not in said, page


def test_the_panes_privacy_sections_and_the_websites_are_word_for_word_the_same():
    def sections(page):
        src = (ROOT / page).read_text(encoding="utf-8")
        return {m[1]: " ".join(re.sub(r"<[^>]+>", "", m[2]).split())
                for m in re.finditer(r'<section[^>]*\sid="(\w+)"[^>]*>(.*?)</section>', src, re.DOTALL)}
    pane, site = sections("frontend/privacy.html"), sections("site/privacy.html")
    assert set(pane) == {"intro", "collect", "use", "share", "rights", "security", "changes"}
    assert {k: v for k, v in site.items() if k != "site"} == pane
