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


def test_every_privacy_page_says_how_a_kits_invite_code_is_kept_and_all_that_accepts_undo_keeps():
    """AH-130: the kit's code was said to be copied (it now is sealed, as a pasted one is, and the kit's own file stays
    plain), Accept's Undo record keeps the old number formats and what Accept wrote as well as the old values, the kit's
    uninstall clears Excel's add-in cache like the app's, and a developer setting can send invite calls elsewhere."""
    promises = (
        "It saves the kit's invite code in the folder above, sealed like a code you paste",
        "The kit folder keeps its own invite-code.txt as plain text",
        "Like the app's uninstall, it also deletes Excel's add-in cache",
        "the old values and number formats of the cells you changed with Accept, and what Accept wrote in them",
        "ANOMALY_HUNTER_RELAY",
        "if Windows still holds it, it stays until the next update or uninstall",
    )
    for page in PAGES:
        said = words(page)
        assert [p for p in promises if p not in said] == [], page
        assert "copies the kit's invite code" not in said, page
    assert "site/privacy.html" in words("PRIVACY.md")  # its twins, both named
    hint = words("frontend/taskpane.html")
    assert "the old values and number formats of the cells you changed with Accept, and what Accept wrote (for Undo)" in hint
    assert '"ANOMALY_HUNTER_RELAY"' in (ROOT / "backend/anomaly_hunter/ai/client.py").read_text(encoding="utf-8")


def test_both_support_pages_answer_invite_kit_users_the_certificate_question_and_where_the_log_is():
    """AH-130: the checker, update and uninstall answers named only Arcas.exe, which a kit has not; nothing said what to
    do when Windows asks about the certificate (a No stops the install) or where the log every engine error names is."""
    from anomaly_hunter import server
    bat = (ROOT / "install.bat").read_text(encoding="utf-8")
    app = (ROOT / "backend/anomaly_hunter/app.py").read_text(encoding="utf-8")
    assert '"%~1"=="/u"' in bat and 'rd /s /q "%LOCALAPPDATA%\\Microsoft\\Office\\16.0\\Wef"' in bat  # the kit's uninstall, as said
    assert "Windows didn't trust the certificate" in app and "return fail(" in app  # a No ends the install
    for page in ("frontend/support.html", "site/support.html"):
        said = words(page)
        missing = [p for p in (
            "With an invite kit, double-click install.bat in the kit folder instead",
            "run install.bat /u in the kit folder, then delete the kit folder",
            "Like the app's uninstall, it also clears Excel's add-in cache",
            f'a certificate from "{server.CERT_NAME}". Click Yes',
            "It works only for localhost and 127.0.0.1 on this PC", "the key that made it is never saved", "uninstall removes it",
            "If you click No, the install stops",
            'Some PCs show "Open File - Security Warning" instead: click Run',
            f"%LOCALAPPDATA%\\{server.HOME.name}", "server.log is this run's, server.log.1 the run before",
            "It can quote values from your sheet",
        ) if p not in said]
        assert missing == [], page
    assert "nothing is sent until" not in words("site/support.html") and "nothing is posted until you press Submit there" in words("site/support.html")
