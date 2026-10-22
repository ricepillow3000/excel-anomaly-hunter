"""API security checks CI runs on every push: what a generic scanner (ZAP) can't know about this engine."""
import json

import anthropic
import pytest
from test_fix import BODY, gemini_stub
from werkzeug.serving import WSGIRequestHandler

from anomaly_hunter import server
from anomaly_hunter.ai import client
from anomaly_hunter.server import create_app

CANARY = "AIzaCANARY-not-a-real-key-123"  # if this ever shows up in a response, the key leaked
APP = create_app()
ROUTES = sorted({(r.rule.replace("<path:filename>", "taskpane.html"), m)
                 for r in APP.url_map.iter_rules() for m in r.methods - {"HEAD", "OPTIONS"}})


@pytest.mark.parametrize("path,method", ROUTES)
def test_every_route_refuses_other_websites(path, method):
    """New routes are covered automatically: the list comes from Flask, not from this file."""
    c = APP.test_client()
    for h in ({"Origin": "https://evil.example"}, {"Origin": "null"}, {"Host": "evil.example:5055"}):
        assert c.open(path, method=method, headers=h, json={}).status_code == 403, h


# shapes the fuzzer can't generate (it sends well-formed JSON): not JSON, the wrong JSON type, nested past Python's
# parser (was a 500 on every route), a number past Python's 4300-digit limit
HOSTILE = ["{bad", "[]", "null", '"x"', "[" * 100000 + "]" * 100000, '{"columns":["A"],"rows":[[' + "9" * 5000 + "]]}"]


@pytest.mark.parametrize("path", sorted({p for p, m in ROUTES if m == "POST"}))
def test_every_post_route_answers_a_hostile_body_with_a_clear_4xx(path, monkeypatch):
    """New routes are covered automatically, like the test above."""
    monkeypatch.setattr(client, "api_key_configured", lambda: True)  # AI routes check the body before the key
    c = APP.test_client()
    for raw in HOSTILE:
        r = c.post(path, data=raw, content_type="application/json")
        assert 400 <= r.status_code < 500 and r.is_json, (path, raw[:20], r.status_code)


@pytest.mark.parametrize("path", ["/../pyproject.toml", "/%2e%2e/pyproject.toml", "/..%2fpyproject.toml",
                                  "/../backend/anomaly_hunter/ai/client.py", "/C:/Windows/win.ini"])
def test_no_file_outside_the_pane_is_served(path):
    r = APP.test_client().get(path)
    assert r.status_code in (400, 404) and b"dependencies" not in r.data and b"GEMINI" not in r.data


@pytest.mark.parametrize("status", [400, 401, 403, 404, 429, 500])
def test_the_key_never_comes_back_even_when_google_echoes_it(monkeypatch, tmp_path, status):
    gemini_stub(monkeypatch, tmp_path, status=status, error=f"API key not valid: {CANARY}")
    c = create_app().test_client()
    responses = [c.post("/key", json={"key": CANARY}), c.post("/fix", json=BODY), c.get("/health"), c.post("/fix", json={})]
    client.KEY_FILE.write_text(CANARY, encoding="utf-8")  # a key that is saved, whatever Google said
    responses += [c.post("/fix", json=BODY), c.get("/health"), c.post("/key", json={"key": "bad key!"})]
    for r in responses:
        assert CANARY not in r.get_data(as_text=True) and CANARY not in str(r.headers)


def test_a_claude_error_never_echoes_the_providers_text(monkeypatch):
    # 2026-10-15 audit: the Gemini path answers in our own words, but a Claude error went to the pane as-is
    import httpx2
    req = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    errors = [anthropic.APIConnectionError(message=f"proxy said {CANARY}", request=req),
              anthropic.APIError(f"upstream said {CANARY}", req, body={"detail": CANARY})]
    monkeypatch.setattr(client, "api_key_configured", lambda: True)
    for err in errors:
        def boom(*a, **k):
            raise err
        monkeypatch.setattr(client, "suggest_fix", boom)
        r = create_app().test_client().post("/fix", json=BODY)
        assert r.status_code in (502, 503) and r.get_json()["error"]
        assert CANARY not in r.get_data(as_text=True)


def test_invite_code_is_only_ever_sent_over_https(monkeypatch):
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    for url, ok in [("https://anomaly-hunter-relay.example.workers.dev", True), ("http://relay.example", False),
                    ("file:///C:/x", False), ("ftp://relay.example", False), ("", False)]:
        monkeypatch.setattr(client, "RELAY_URL", url)
        assert (client.provider() == "relay") is ok, url


def test_a_scan_never_sends_anything_to_google_even_with_a_key_saved(monkeypatch):
    # PRIVACY.md: "Nothing is sent anywhere unless you turn on AI help" - and then only on a click. Until 2026-10-16
    # this held only because of how the code was laid out: every check is offline pandas, the AI is for meaning.
    client.KEY_FILE.write_text(CANARY, encoding="utf-8")
    client.INVITE_FILE.write_text("inv_" + "a" * 24, encoding="utf-8")
    monkeypatch.setattr(client, "RELAY_URL", "https://relay.example")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    calls = []
    monkeypatch.setattr(client.urllib.request, "urlopen", lambda *a, **k: calls.append(a) or 1 / 0)
    monkeypatch.setattr(anthropic, "Anthropic", lambda *a, **k: calls.append(a) or 1 / 0)
    rows = [["Pen", "East", 10 + k % 3, "F" if k % 2 else "M"] for k in range(60)] + [["Pen", "Londn", 500, "M"], ["Desk", "", "12O", "F"]]
    r = APP.test_client().post("/scan", json={"columns": ["Item", "Region", "Units", "Sex"], "rows": rows, "limits": {}})
    assert r.status_code == 200 and r.get_json()["rows"] and calls == []


def test_safe_headers_on_every_answer():
    c = APP.test_client()
    for r in (c.get("/health"), c.get("/taskpane.html"), c.get("/assets/mark-16.png"), c.post("/scan", data="x"), c.get("/nope")):
        assert r.headers["X-Content-Type-Options"] == "nosniff"
        # exact string: loosening it (say 'unsafe-inline' or a new host) must be a deliberate, re-tested change
        assert r.headers["Content-Security-Policy"] == (
            "default-src 'self'; script-src 'self' https://appsforoffice.microsoft.com; object-src 'none'; "
            "base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    assert WSGIRequestHandler.version_string(None) == "Anomaly Hunter"  # the real server's Server header (ZAP checks it live)


def test_every_error_is_json_never_a_framework_html_page():
    """ZAP's active scan: 404/405 came back as Werkzeug's HTML page - unlike every other answer, and it names the framework."""
    c = APP.test_client()
    for r in (c.get("/WEB-INF/web.xml"), c.get("/nope.php?x=1"), c.get("/scan"), c.delete("/health"), c.put("/key")):
        assert r.status_code in (404, 405) and r.is_json and isinstance(r.get_json().get("error"), str), (r.status_code, r.data[:80])
        assert b"<html" not in r.data.lower() and b"werkzeug" not in r.data.lower()


SHEET = {"columns": ["Item", "Units"], "rows": [[f"Pen {k}", 10 + k % 5] for k in range(30)]}


def test_power_bi_csv_never_carries_a_live_formula(tmp_path):
    """OWASP CSV injection: a cell starting = + - @ (or tab/CR, or full-width forms) runs as a formula when the
    CSV is opened in Excel. Partial protection: OWASP notes the apostrophe may not survive a save and reopen."""
    out = tmp_path / "s.csv"
    rows = SHEET["rows"] + [["=cmd|' /C calc'!A0", 12], ["@SUM(1)", 11], ["＝1+1", 10], ["-5 items", 13]]
    r = create_app(scan_csv=out).test_client().post("/scan", json={**SHEET, "rows": rows, "power_bi": True})
    assert r.status_code == 200
    text = out.read_text(encoding="utf-8-sig")
    assert "'=cmd" in text and "'@SUM" in text and "'＝1+1" in text and "\n=cmd" not in text
    assert '\n2,"Pen 0",10,' in text  # numbers stay numbers (no apostrophe, no quotes); text is quoted


def test_a_semicolon_before_a_formula_never_splits_the_power_bi_csv(tmp_path):
    # 2026-10-15 audit: _inert only guards the start of a field. Excel in a ";" locale (DE, FR, NL) splits an
    # unquoted "Pen;=cmd|..." into a second cell that starts with "=" and runs. Quoted text can't be split.
    out = tmp_path / "s.csv"
    rows = SHEET["rows"] + [["Pen;=cmd|' /C calc'!A0", 12]]
    r = create_app(scan_csv=out).test_client().post("/scan", json={**SHEET, "rows": rows, "power_bi": True})
    assert r.status_code == 200
    text = out.read_text(encoding="utf-8-sig")
    assert "\"Pen;=cmd|' /C calc'!A0\"" in text and "\nPen;" not in text
    assert "\"Pen;=cmd|' /C calc'!A0\",12," in text  # numbers stay numbers


def test_an_odd_character_never_turns_a_scan_into_a_500(tmp_path):
    raw = json.dumps({**SHEET, "rows": SHEET["rows"] + [["ab\ud800", 12]], "power_bi": True})  # a lone surrogate, valid JSON
    r = create_app(scan_csv=tmp_path / "s.csv").test_client().post("/scan", data=raw, content_type="application/json")
    assert r.status_code == 200


def test_a_number_too_big_for_a_float_never_turns_a_scan_into_a_500(tmp_path):
    # a 309-digit whole number is a valid (flagged) value, but the Power BI CSV's DataFrame can't hold it as a float
    rows = SHEET["rows"] + [["Pen", 10 ** 309]]
    r = create_app(scan_csv=tmp_path / "s.csv").test_client().post("/scan", json={**SHEET, "rows": rows, "power_bi": True})
    assert r.status_code == 200


def test_a_huge_body_is_refused_before_it_is_read():
    app = create_app()
    app.config["MAX_CONTENT_LENGTH"] = 1000
    r = app.test_client().post("/scan", data=json.dumps({**SHEET, "rows": SHEET["rows"] * 5}), content_type="application/json")
    assert r.status_code == 413 and r.is_json and "error" in r.get_json()
    assert create_app().config["MAX_CONTENT_LENGTH"] == 256 * 1024 * 1024  # a 20 MB real sheet still fits


def test_more_cells_than_the_pane_ever_sends_is_a_clear_400(monkeypatch):
    monkeypatch.setattr(server, "MAX_CELLS", 10)
    r = APP.test_client().post("/scan", json={"columns": ["a"], "rows": [[k] for k in range(11)]})
    assert r.status_code == 400 and "too many cells" in r.get_json()["error"]


def test_every_workflow_action_is_pinned_to_a_commit():
    # 2026-10-15 audit: the release job (contents: write) publishes the exe every new user downloads. A tag like
    # @v8 can be moved to other code; a 40-hex commit can't. Bump one by re-resolving its tag with git ls-remote.
    import pathlib
    import re
    workflows = pathlib.Path(__file__).resolve().parents[2] / ".github" / "workflows"
    uses = [(f.name, m) for f in sorted(workflows.glob("*.yml")) for m in re.findall(r"uses:\s*(\S+)", f.read_text())]
    assert uses, "no workflow steps found"
    loose = [(name, u) for name, u in uses if not re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", u)]
    assert not loose, loose


def test_every_gate_tools_check_runs_also_runs_in_ci():
    # council review 2026-10-16: main's ruleset needs 0 approvals and the accuracy benches (no harmful fix, no new
    # Medium+ false alarm) ran only in tools/check.py on a PC - an agent's PR could merge fixes that overwrite good cells
    import pathlib
    import sys
    root = pathlib.Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "tools"))
    import check
    ci = " ".join(" ".join(f.read_text().split()) for f in (root / ".github" / "workflows").glob("*.yml"))
    words = {"-m pytest": "pytest", "-m ruff": "ruff", "-m pip_audit": "pip-audit"}
    missing = []
    for name, cmd in check.LAYERS:
        if name == "CI workflows parse":  # GitHub parses them itself: a broken file shows as a failed run
            continue
        step = " ".join(cmd[1:] if cmd[0] == check.PY else cmd)
        for a, b in words.items():
            step = step.replace(a, b)
        if step not in ci:
            missing.append(step)
    assert not missing, missing


def test_every_installed_package_is_pinned_by_constraints_txt(tmp_path, monkeypatch):
    # council review 2026-10-16: ~45 indirect packages were unpinned - scikit-learn 1.9.1, pulled in by pyod, broke every
    # Windows install (2026-10-11), and any new release (or a hijacked one) would ship to every user unreviewed
    import pathlib
    import shutil
    import sys
    root = pathlib.Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(root / "tools"))
    import pinned
    assert pinned.problems() == []
    shutil.copy(root / "pyproject.toml", tmp_path)
    (tmp_path / "constraints.txt").write_text("\n".join(line for line in (root / "constraints.txt").read_text().splitlines()
                                                         if not line.startswith("numpy==")))
    monkeypatch.setattr(pinned, "ROOT", tmp_path)
    assert any(p.startswith("numpy ") and "not pinned" in p for p in pinned.problems())


@pytest.mark.parametrize("key", ["AIzaGOODkey123", "inv_" + "a" * 24, ""])
def test_a_key_that_cannot_be_saved_gets_our_own_words_never_a_500(monkeypatch, tmp_path, key):
    # AH-13 sweep: a full disk, a locked file or a folder where the key file goes made /key a 500 in Werkzeug's words
    monkeypatch.setattr(client, "check_key", lambda k: (True, "Key works."))
    (tmp_path / "blocked").mkdir()
    monkeypatch.setattr(client, "KEY_FILE", tmp_path / "blocked")  # a folder: every write or unlink of it fails
    monkeypatch.setattr(client, "INVITE_FILE", tmp_path / "blocked")
    r = create_app().test_client().post("/key", json={"key": key})
    assert r.status_code == 503 and "this PC" in r.get_json()["error"] and "internal error" not in r.get_json()["error"]


def test_an_unexpected_engine_error_answers_in_our_own_words(monkeypatch):
    # a bug anywhere still answers like the rest of the engine, never Werkzeug's "The server encountered an internal error"
    monkeypatch.setattr(client, "provider", lambda: 1 / 0)
    r = create_app().test_client().get("/health")
    assert r.status_code == 500 and r.get_json() == {"error": "Engine error - details in server.log"}


def test_the_workbook_repointer_never_writes_over_its_source_even_with_asserts_off(tmp_path):
    # AH-13 sweep: its only guard was an assert, which python -O removes: the same path in and out truncated the
    # workbook while it was being read
    import subprocess
    import sys
    import zipfile
    from pathlib import Path
    book = tmp_path / "Book.xlsx"
    with zipfile.ZipFile(book, "w") as z:
        z.writestr("xl/webextensions/webextension1.xml", b"C:\\excel-anomaly-hunter\\panel")
    before = book.read_bytes()
    tool = Path(__file__).resolve().parents[2] / "tools" / "repoint_workbook.py"
    for same in (str(book), str(book).upper()):
        r = subprocess.run([sys.executable, "-O", str(tool), str(book), same], capture_output=True, text=True, timeout=60)
        assert r.returncode != 0 and "copy" in (r.stdout + r.stderr) and book.read_bytes() == before, same


def test_the_workbook_repointer_never_writes_over_its_source_through_a_hard_link(tmp_path):
    # AH-13 reconvene 1 (Agent 2's review): a hard link, or a Windows 8.3 short name, is the same file under another
    # name, so comparing paths let it through and python -O truncated the source (BadZipFile). Asked of the file system now.
    import os
    import subprocess
    import sys
    import zipfile
    from pathlib import Path
    book = tmp_path / "Book.xlsx"
    with zipfile.ZipFile(book, "w") as z:
        z.writestr("xl/webextensions/webextension1.xml", b"C:\\excel-anomaly-hunter\\panel")
    before = book.read_bytes()
    link = tmp_path / "link.xlsx"
    os.link(book, link)
    tool = Path(__file__).resolve().parents[2] / "tools" / "repoint_workbook.py"
    r = subprocess.run([sys.executable, "-O", str(tool), str(book), str(link)], capture_output=True, text=True, timeout=60)
    assert r.returncode != 0 and "copy" in (r.stdout + r.stderr) and book.read_bytes() == before
    zipfile.ZipFile(book).testzip()  # still a whole workbook
    copy = tmp_path / "Copy.xlsx"  # a real copy (a new file) still works
    r = subprocess.run([sys.executable, "-O", str(tool), str(book), str(copy)], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and b"excel-anomaly-hunter\\frontend" in zipfile.ZipFile(copy).read("xl/webextensions/webextension1.xml")
