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
        "anomalyHunterAutoFix", "anomalyHunterPowerBi", "anomalyHunterAiMemory", "localStorage",  # the pane's own keys, by name
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


EMAIL = "john4000.nguyen@gmail.com"
MAILTO = f'<a href="mailto:{EMAIL}">{EMAIL}</a>'

def test_every_privacy_page_names_who_runs_arcas_and_how_to_reach_him():
    # AH-125 (John, "so we don't get sued"): a privacy policy names who is responsible for it and how to reach them.
    # A phone and the support page, and since AH-134 (John, 2026-11-05: "add my official email") his one email address,
    # never any other (AH-125 had kept every address out: a public inbox fills with spam, a risk John chose to take)
    for page in PAGES:
        said, src = words(page), (ROOT / page).read_text(encoding="utf-8")
        assert "Arcas is made and run by John Nguyen (GitHub: ricepillow3000)" in said, page
        assert "(770) 265-9930" in said and "support page" in said.lower() and EMAIL in said, page
        assert set(re.findall(r"[\w.+-]+@[\w-]+\.[a-z]{2,}", src, re.I)) == {EMAIL}, page
        assert "An email to John goes to his Gmail, so Google's terms apply to it" in said, page
    for page in PAGES[1:]:  # the phone is a link a phone can call, the email one that opens a new email
        src = (ROOT / page).read_text(encoding="utf-8")
        assert '<a href="tel:+17702659930">(770) 265-9930</a>' in src and MAILTO in src, page


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
        assert '<a href="tel:+17702659930">(770) 265-9930</a>' in src and "John" in src and MAILTO in src, page
        assert set(re.findall(r"[\w.+-]+@[\w-]+\.[a-z]{2,}", src, re.I)) == {EMAIL}, page
    assert f"The only public ways to reach John are the buttons on this page, his email, {EMAIL}, and his phone, (770) 265-9930" in words("frontend/support.html")


def test_every_message_form_assigns_john_so_his_phone_is_pinged():
    # AH-134 (John, 2026-11-05: "make it so that the message appears as a text for me"): a message from the website lands
    # as a GitHub issue; each issue form assigns it to John, and the GitHub app on his phone sends a push alert for every
    # issue assigned to him. A form set in the template applies for anyone, unlike an assignees= link parameter
    for form in ("contact.yml", "support_request.yml"):
        src = (ROOT / ".github" / "ISSUE_TEMPLATE" / form).read_text(encoding="utf-8")
        assert re.search(r'^assignees: \["ricepillow3000"\]$', src, re.M), form
    assert "Arcas is made and run by John Nguyen" in words("site/support.html")


def test_every_privacy_page_says_the_websites_forms_send_nothing_and_the_profile_links_load_nothing():
    # AH-133 (John, 2026-11-05): the home page gained a contact form and links to John's LinkedIn, Handshake and GitHub.
    # The form sends nothing itself (support.js opens a prefilled public GitHub issue the visitor submits there), and the
    # profiles are plain links: tools/test_site.mjs holds the page to both. The three twins say so in the same words
    said = (
        "The website's contact form and support form send nothing themselves: each opens a public GitHub issue filled in "
        "with what you typed, which you submit on GitHub yourself, or, with Email John instead, a new email in your own "
        "email app, which you send yourself",  # AH-135: the forms' second way, for a visitor with no GitHub account
        "The links to John's LinkedIn, Handshake and GitHub profiles are plain links: nothing loads from LinkedIn, "
        "Handshake or GitHub until you click one, and then that site's own terms apply",
    )
    for page in PAGES:
        assert [s for s in said if s not in words(page)] == [], page


def test_every_privacy_page_says_arcas_is_listed_in_installed_apps_and_removes_its_own_file():
    # AH-136: the installer now writes a per-user Installed apps entry (app.UNINSTALL) and an uninstall from there deletes
    # the running app file too; the twins name what is installed and what uninstall removes, so they say both
    for page in PAGES:
        said = words(page)
        assert "Settings > Apps > Installed apps" in said and "its Installed apps entry" in said, page
        assert "the app file too" in said and "except the app file itself" not in said, page


def test_every_privacy_page_says_what_ask_ai_remembers_how_much_of_it_goes_and_how_to_forget_it():
    # AH-143 (John, 2026-11-06): Ask AI remembers the fixes the user accepted, on this PC, and will send up to 5 of the
    # flagged column's with each request once its memory is switched on. The numbers are the pane's (features/memory.js)
    # and the engine's (/fix). AH-145: while it is off (client.py), the pages say the fixes are not sent yet
    from anomaly_hunter.ai import client
    from anomaly_hunter.server import create_app
    off = "with_memory(_fix_prompt, _fits, on=False)" in (ROOT / "backend/anomaly_hunter/ai/client.py").read_text(encoding="utf-8")
    assert off, "Ask AI's memory is on: say in the three privacy pages and #fix-sends that the fixes are sent, then here"
    src = (ROOT / "frontend/features/memory.js").read_text(encoding="utf-8")
    kept, sent, offered = map(int, re.search(r"MAX_KEPT = (\d+), SENT = (\d+), OFFERED = (\d+)", src).groups())
    body = {"columns": ["Units"], "rows": [[1], [500]], "row_index": 1, "start_row": 0, "start_col": 0}
    one = {"h": "Units", "k": "fix", "o": "1", "n": "2"}
    assert create_app().test_client().post("/fix", json={**body, "memory": [one] * (offered + 1)}).status_code == 400
    # AH-153: the pane hands the engine up to 20; the engine picks which go to the AI, never more than the pages say
    from anomaly_hunter.ai import memory
    assert (memory.SENT, memory.OFFERED) == (sent, offered)
    many = [{**one, "o": str(k), "n": str(k + 1)} for k in range(offered)]
    assert len(memory.select(memory.rank(many, "Units weird limit is 90; this is 500", 500), "Units weird limit is 90; this is 500", 500)) == sent
    assert '"anomalyHunterAiMemory"' in (ROOT / "frontend/constants/index.js").read_text(encoding="utf-8")
    promises = (
        f"Ask AI's memory (anomalyHunterAiMemory) is saved there too: up to {kept} fixes you accepted",
        "each with its column name, the kind of fix, and the old and new values. Undo takes a fix back out",
        f"Up to {sent} fixes you accepted before in a column with the same name as the flagged one",
        "are sent with Ask AI only once the AI memory is switched on in a later update. Until then they stay on this PC",
        "Forget what the AI learned", "It removes every fix Ask AI remembers on this PC, for every workbook",
        "Uninstalling also removes them with Excel's add-in cache",
    )
    for page in PAGES:
        said = words(page)
        assert [p for p in promises if p not in said] == [], page
    hint = words("frontend/taskpane.html")
    assert (f"Up to {sent} fixes you accepted before in a column with this name (the name, the kind of fix, and the old and new "
            "values) are sent only once the AI memory is switched on in a later update") in hint
    # AH-145 (John, 2026-11-07): with your own key a busy or used-up main model hands the request to the engine's backups,
    # named on every page; the relay (deployed by John by hand) asks its one model, and the pages say invites get only it
    assert len(client.GEMINI_FALLBACKS) == 1, "the pages name one backup: name every one, then here"
    relay = tomllib.loads((ROOT / "relay" / "wrangler.toml").read_text(encoding="utf-8"))["vars"]["MODELS"]
    assert relay == client.GEMINI_MODEL, "the relay asks a backup: say so in the three privacy pages, then here"
    for page in PAGES:
        assert (f"With your own key or an invite code, Google's main Gemini model ({client.GEMINI_MODEL}) answers. With your own Google key, if that "
                "model is busy or its free requests for the day are used up, the same request goes to a backup Gemini model "
                f"({client.GEMINI_FALLBACKS[0]}), also Google's, and the pane says so. With an invite code, only the main "
                "model answers") in words(page), page
    assert f"Ask AI remembers up to {kept} fixes you accepted, on this PC and for every workbook" in hint


def test_every_privacy_page_says_where_the_free_ai_sends_what_it_counts_and_its_caps_as_configured():
    # AH-151 (John, 2026-11-09): with no key or invite of its own, Ask AI goes to the relay's public tier. The pages name
    # its model and caps from relay/wrangler.toml, and what the relay keeps of a network: a keyed hash, never the IP
    caps = tomllib.loads((ROOT / "relay" / "wrangler.toml").read_text(encoding="utf-8"))["vars"]
    assert "," not in caps["PUBLIC_MODELS"], "the free AI asks a backup: name every model in the three privacy pages, then here"
    promises = (
        "With no key or invite code of your own, AI help uses John's free AI",
        f"to John's relay on Cloudflare, which passes it to Google's {caps['PUBLIC_MODELS']} with John's key",
        "counts each network's AI calls for the day under a code made from the day and your IP address with the relay's secret key",
        "It never stores your IP address or the request",
        f"{caps['PUBLIC_DAILY_PER_NETWORK']} AI calls per network and {caps['PUBLIC_DAILY_TOTAL']} for every free user together a day",
    )
    for page in PAGES:
        said = words(page)
        assert [p for p in promises if p not in said] == [], page
        assert "AI help works only after you paste" not in said and "To turn off AI help, click" not in said, page


def test_every_privacy_page_says_the_workbook_keeps_the_numbers_of_the_last_check_and_forget_removes_them():
    """AH-157: the pane says the last check when a workbook opens again, from a record it keeps in the workbook: its
    numbers only, never a value or a reason. The three privacy pages, the pane's own hint and Forget name it."""
    kept = ("the numbers of the last check (the sheet's name, when it ran, the slider's level, and how many rows it read "
            "and flagged, never a value or a reason, so the pane can say them when the file opens again)")
    for page in PAGES:
        said = words(page)
        assert kept in said, page
        assert "the colours your highlighted cells had before, the numbers of the last check, and the setting that opens the pane with the file" in said, page
    assert '"anomalyHunterLastScan"' in (ROOT / "frontend/constants/index.js").read_text(encoding="utf-8")
    assert "the numbers of the last check (how many rows it read and flagged, never a value)" in words("frontend/taskpane.html")
