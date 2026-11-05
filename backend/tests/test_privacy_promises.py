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


def test_every_privacy_page_names_who_runs_arcas_and_how_to_reach_him():
    # AH-125 (John, "so we don't get sued"): a privacy policy names who is responsible for it and how to reach them.
    # A phone and the support page, never an email address (a public inbox fills with spam and phishing)
    for page in PAGES:
        said = words(page)
        assert "Arcas is made and run by John Nguyen (GitHub: ricepillow3000)" in said, page
        assert "(770) 265-9930" in said and "support page" in said.lower(), page
        assert not re.search(r"[\w.+-]+@[\w-]+\.[\w.]+|mailto:", (ROOT / page).read_text(encoding="utf-8")), page
    for page in PAGES[1:]:  # the phone is a link a phone can call
        assert '<a href="tel:+17702659930">(770) 265-9930</a>' in (ROOT / page).read_text(encoding="utf-8"), page


def test_every_privacy_page_says_a_crisis_request_goes_nowhere():
    # AH-125: ai/care.py answers words of someone in crisis itself; the pages say so, under what AI help sends
    for page in PAGES:
        assert "If what you type to Ask AI reads as someone in crisis, the pane shows helpline numbers instead and sends nothing to the AI" in words(page), page


def test_the_relay_stores_no_upload_keeps_no_logs_and_has_no_public_bucket():
    # AH-125 ("uploads not stored publicly, no public storage buckets"): the relay's only storage is the Durable Object
    # that holds the day's counter (relay/worker.js Counter); no KV, R2 or D1 binding exists for a request to land in,
    # and Workers' saved logs (on by default) are off. relay/test.mjs checks the counter never holds a request's words
    conf = tomllib.loads((ROOT / "relay" / "wrangler.toml").read_text(encoding="utf-8"))
    assert conf["observability"]["enabled"] is False
    assert [b["class_name"] for b in conf["durable_objects"]["bindings"]] == ["Counter"]
    stores = ("kv_namespaces", "r2_buckets", "d1_databases", "queues", "vectorize", "analytics_engine_datasets",
              "hyperdrive", "logpush", "tail_consumers", "services")
    assert [s for s in stores if s in conf] == []
    assert "logs" not in conf.get("observability", {}) or conf["observability"]["logs"].get("enabled") is False


def test_every_privacy_page_says_the_website_alone_may_count_page_views_and_what_the_counter_sends():
    # AH-126 (John, 2026-11-04): the website may count page views with GoatCounter (site/count.js, silent until John sets
    # his code there). The pages said "no analytics and no tracking" of everything and named no counter among the third
    # parties, which the counter would make false for the website; the add-in itself still has neither
    for page in PAGES:
        said, src = words(page), (ROOT / page).read_text(encoding="utf-8")
        assert "There are no accounts and no cookies, and the add-in has no analytics and no tracking" in said, page
        assert "no accounts, no analytics and no tracking" not in said, page
        assert "never the add-in, the pane or the engine" in said and "the page's address" in said, page
        assert "no cookie, no referrer, no title, no screen size" in said and "Do Not Track or Global Privacy Control" in said, page
        assert "https://www.goatcounter.com/help/privacy" in src, page
    site = words("site/privacy.html")
    assert "runs no analytics" not in site and "no cookies or analytics" not in site
    # what the pages promise is what the code does: the path alone, no referrer, silent with no code, under DNT and GPC
    js = (ROOT / "site" / "count.js").read_text(encoding="utf-8")
    assert re.search(r'^\s*const COUNTER = "[a-z0-9-]{0,63}";$', js, re.M)  # empty until John sets his code
    assert '".goatcounter.com/count?p=" + encodeURIComponent(location.pathname)' in js and 'referrerPolicy = "no-referrer"' in js
    assert 'doNotTrack === "1"' in js and "globalPrivacyControl" in js
    # ... and the pane and the engine never reach it: only the privacy page's link names it outside the website
    named = [p.relative_to(ROOT).as_posix() for d in ("frontend", "backend/anomaly_hunter") for p in (ROOT / d).rglob("*")
             if p.is_file() and p.suffix in (".html", ".js", ".py", ".css", ".xml") and "node_modules" not in p.parts
             and "goatcounter" in p.read_text(encoding="utf-8", errors="ignore").lower()]
    assert named == ["frontend/privacy.html"], named


def test_both_support_pages_give_johns_phone_beside_the_question_form():
    # AH-126: the pane's support page said its buttons were "the only public ways to reach John" once the privacy pages
    # also gave his phone (AH-125), and the website's support page named neither him nor the phone
    for page in ("frontend/support.html", "site/support.html"):
        src = (ROOT / page).read_text(encoding="utf-8")
        assert '<a href="tel:+17702659930">(770) 265-9930</a>' in src and "John" in src, page
        assert not re.search(r"[\w.+-]+@[\w-]+\.[a-z]{2,}|mailto:", src, re.I), page
    assert "The only public ways to reach John are the buttons on this page and his phone, (770) 265-9930" in words("frontend/support.html")
    assert "Arcas is made and run by John Nguyen" in words("site/support.html")
