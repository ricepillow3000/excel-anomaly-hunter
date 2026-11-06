"""The product is called Arcas (AH-101, John 2026-11-03): the SignPath code signing form asks for one name, and it must
be the name the website, the download and the signed exe show. Every name a person reads says Arcas. The old name
stays only where an installed copy or an old link depends on it: the install folder, the certificate Windows trusts,
the Power BI shortcuts and clash columns, the pane's saved settings keys, the Run value, the old exe an update removes,
and URLs (the GitHub repo keeps its name)."""
import ast
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from anomaly_hunter import app
from test_plain_words import md_prose, page_text, sources

ROOT = Path(__file__).resolve().parents[2]
OLD = re.compile(r"anomaly[\s_-]?hunter", re.IGNORECASE)
# where the old name stays, and why: each one is a name something already installed or linked depends on
KEPT = [
    (r"https?://\S+", "a URL: the repo, its website and the relay keep their names"),
    (r"[\w.]*github\.(?:com|io)/[\w./?=&%-]*", "a link's text that spells its URL"),
    (r"%LOCALAPPDATA%[\\/]AnomalyHunter", "the install folder, as it is on disk"),
    (r"your AnomalyHunter folder", "the install folder, named as it is on disk"),
    (r"Anomaly Hunter local CA", "the certificate Windows already trusts"),
    (r"anomaly-hunter(?:-flags)?\.pbids", "the Power BI shortcuts' file names"),
    (r"Anomaly Hunter (?:Severity|Excel Row|Bucket|Reason|Status|Suggested fix|Columns)\b", "a Power BI clash column"),
    (r"\banomalyHunter[A-Z]\w*", "the pane's settings keys, saved in workbooks and on the PC"),
    (r"\banomaly_hunter\b", "the Python package"),
    (r"\bANOMALY_HUNTER_RELAY\b", "the developer setting's name, as ai/client.py reads it from the environment"),
]
# the exe's old name, only where an update looks for it: a release made before the rename
LEGACY = {"site/home.js": "AnomalyHunter.exe"}


def left(text, where=""):
    for pattern, _ in KEPT:
        text = re.sub(pattern, "", text)
    if LEGACY.get(where):
        text = text.replace(LEGACY[where], "")
    return OLD.findall(text)


def py_strings(path):
    """Every string a Python file holds (docstrings too: the app shows its own as the usage message)."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return [(n.lineno, n.value) for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)]


def visible():
    """(file:line, text) for what a person reads: pages, pane scripts, README and PRIVACY (the plain-words reader),
    and the rest that shows a name: Power BI's README, the support form, the manifest, the installers' messages."""
    for path, texts, _ in sources():
        for line, text in texts:
            yield path.relative_to(ROOT).as_posix(), line, text
    for line, text in md_prose((ROOT / "powerbi/README.md").read_text(encoding="utf-8")):
        yield "powerbi/README.md", line, text
    for name in (".github/ISSUE_TEMPLATE/support_request.yml",):
        for line, text in enumerate((ROOT / name).read_text(encoding="utf-8").splitlines(), 1):
            yield name, line, text
    texts, _ = page_text(re.sub(r"<!--.*?-->", "", (ROOT / "frontend/manifest.xml").read_text(encoding="utf-8"), flags=re.DOTALL))
    for line, text in texts:
        yield "frontend/manifest.xml", line, text
    for m in re.finditer(r'DefaultValue="([^"]*)"', (ROOT / "frontend/manifest.xml").read_text(encoding="utf-8")):
        yield "frontend/manifest.xml", 0, m[1]
    for line, text in enumerate((ROOT / "install.bat").read_text(encoding="utf-8").splitlines(), 1):
        if text.lstrip().lower().startswith("echo"):
            yield "install.bat", line, text
    # the strings the engine and the app show: the app's message boxes and usage, Start here, the CLI, the Server header
    for name in ("app.py", "practice.py", "cli.py", "server.py", "engine/report.py"):
        path = ROOT / "backend/anomaly_hunter" / name
        for line, text in py_strings(path):
            if name == "app.py" and text in (app.LEGACY, app.RUN_VALUE):
                continue  # the old exe an update removes, and the Run value an update overwrites
            if name == "server.py" and text == "AnomalyHunter":
                continue  # the install folder's name
            yield f"backend/anomaly_hunter/{name}", line, text


def test_the_old_product_name_appears_only_where_an_install_or_a_link_depends_on_it():
    found = [f"{where}:{line}: {text.strip()[:140]!r}" for where, line, text in visible() if left(text, where)]
    assert found == [], f"{len(found)} places still say the old name:\n" + "\n".join(found)


def test_the_guard_catches_the_old_name_and_lets_the_kept_ones_through():
    assert left("Open the Anomaly Hunter panel.") and left("Double-click AnomalyHunter.exe again")
    assert not left(r'paste "%LOCALAPPDATA%\AnomalyHunter\Arcas.exe" uninstall')
    assert not left("https://github.com/ricepillow3000/excel-anomaly-hunter/releases/latest/download/Arcas.exe")
    assert not left("anomaly-hunter.pbids, Anomaly Hunter Severity, Anomaly Hunter local CA, anomalyHunterAutoFix")
    assert not left('find((a) => a.name === "AnomalyHunter.exe")', "site/home.js")


def text(name):
    return (ROOT / name).read_text(encoding="utf-8")


def title(name):
    return re.search(r"<title>(.*?)</title>", text(name), re.DOTALL)[1].strip()


def test_every_place_that_names_the_product_says_arcas():
    ns = {"o": "http://schemas.microsoft.com/office/appforoffice/1.1", "bt": "http://schemas.microsoft.com/office/officeappbasictypes/1.0"}
    manifest = ET.fromstring(text("frontend/manifest.xml"))
    assert manifest.find("o:DisplayName", ns).get("DefaultValue") == "Arcas"
    assert [s.get("DefaultValue") for s in manifest.iter(f"{{{ns['bt']}}}String") if s.get("id") == "Name"] == ["Arcas"]
    assert title("frontend/taskpane.html") == "Arcas"
    # the website's titles say Arcas first, then what the page is (AH-119: "Arcas" alone named no page in a search)
    assert [title(f"site/{p}.html").split(":")[0] for p in ("index", "privacy", "support")] == ["Arcas", "Arcas privacy", "Arcas support"]
    assert title("frontend/privacy.html") == "Arcas, Privacy" and title("frontend/support.html") == "Arcas, Support"
    assert 'aria-label="Arcas home"' in text("site/index.html")
    pane = text("frontend/taskpane.html")
    assert "<h1>Arcas</h1>" in pane and re.search(r'class="pf-brand">.*</span>Arcas</div>', pane)
    assert text("README.md").splitlines()[0] == "# Arcas"
    build = text(".github/workflows/build-exe.yml")
    assert '--title "Arcas ${TAG#v}"' in build
    spec = text("packaging/AnomalyHunter.spec")
    assert 'name="Arcas"' in spec and app.APP == "Arcas.exe"
    # what Windows shows in the file's Properties, and what SignPath reads from the signed file
    for field, value in (("ProductName", "Arcas"), ("FileDescription", "Arcas"), ("CompanyName", "ricepillow3000"),
                         ("OriginalFilename", "Arcas.exe")):
        assert f'StringStruct("{field}", "{value}")' in spec, field


def test_old_download_links_keep_working_after_the_rename():
    # a release carries the same file under both names: every link posted before AH-101 ends in AnomalyHunter.exe
    build = text(".github/workflows/build-exe.yml")
    assert "cp dist/Arcas.exe dist/AnomalyHunter.exe" in build
    assert re.search(r"gh release create \"\$TAG\" dist/Arcas\.exe dist/AnomalyHunter\.exe", build)
    for page in ("site/index.html", "README.md", "frontend/support.html"):
        assert "releases/latest/download/Arcas.exe" in text(page), page
        assert "releases/latest/download/AnomalyHunter.exe" not in text(page), page


def test_stopping_the_engines_stops_the_old_exe_and_the_new_one(monkeypatch):
    ran = []
    monkeypatch.setattr(app, "tool", lambda *a: ran.append(a) or 0)
    app.stop_engines()
    command = ran[0][-1]
    assert "'Arcas.exe'" in command and "'AnomalyHunter.exe'" in command and "anomaly_hunter" in command


def fake_pc(tmp_path, monkeypatch):
    """A PC with the old install in its folder and the new file in Downloads; Windows' own tools stubbed."""
    home, downloads = tmp_path / "AnomalyHunter", tmp_path / "Downloads"
    home.mkdir()
    downloads.mkdir()
    (home / "AnomalyHunter.exe").write_bytes(b"old")
    (downloads / "Arcas.exe").write_bytes(b"new")
    stopped = []
    monkeypatch.setattr(app.server, "HOME", home)
    monkeypatch.setattr(sys, "executable", str(downloads / "Arcas.exe"))
    monkeypatch.setattr(app, "excel_open", lambda: False)
    monkeypatch.setattr(app, "stop_engines", lambda: stopped.append(1))
    monkeypatch.setattr(app, "tool", lambda *a: 0)
    monkeypatch.setattr(app, "say", lambda *a, **k: None)
    monkeypatch.setattr(app.time, "sleep", lambda s: None)
    return home, stopped


def test_an_update_over_the_old_name_removes_the_old_exe(tmp_path, monkeypatch):
    home, stopped = fake_pc(tmp_path, monkeypatch)
    monkeypatch.setattr(app.server, "make_cert", lambda home: False)
    panel = tmp_path / "frontend"
    panel.mkdir()
    (panel / "manifest.xml").write_text("<x/>")
    monkeypatch.setattr(app.server, "PANEL", panel)
    app.install()  # stops at the admin share, which this PC has not: the copy is made by then
    assert stopped and (home / "Arcas.exe").read_bytes() == b"new"
    assert not (home / "AnomalyHunter.exe").exists()


def test_an_install_that_cannot_reach_the_admin_share_says_in_plain_words_the_account_is_not_an_administrator(tmp_path, monkeypatch):
    # AH-129: Excel lists the add-in through \\localhost\C$, a share Windows opens to administrators only. A standard
    # account was told "the C$ admin share is off on this PC", and the website said no administrator rights were needed.
    # AH-135: "Can't reach \\localhost\C$..." meant nothing to a person with few computer skills: the message says what
    # happened and who can help, in the support page's words, and the share's path goes to the log for whoever helps
    home, _ = fake_pc(tmp_path, monkeypatch)
    monkeypatch.setattr(app.server, "make_cert", lambda home: False)
    panel = tmp_path / "frontend"
    panel.mkdir()
    (panel / "manifest.xml").write_text("<x/>")
    monkeypatch.setattr(app.server, "PANEL", panel)
    said = []
    monkeypatch.setattr(app, "say", lambda text, error=False: said.append(text))
    assert app.install() == 1
    plain = ("Arcas could not finish. Your Windows account is not an administrator on this PC. "
             "Ask the person who looks after your computers to install it for you.")
    assert said[-1] == plain, said
    log = (home / "server.log").read_text(encoding="utf-8")
    assert "\\\\localhost\\" in log and "C$ admin share" in log, log
    bat = [line for line in (ROOT / "install.bat").read_text(encoding="utf-8").splitlines() if "%UNC%\\manifest.xml" in line]
    assert len(bat) == 1 and bat[0].split("(echo ", 1)[1].split(" & ", 1)[0] == plain and "server.log" in bat[0], bat
    assert plain in (ROOT / "site" / "support.html").read_text(encoding="utf-8")  # a question under its own words


def test_an_old_exe_still_held_a_moment_after_its_engine_stopped_is_removed_on_a_retry(tmp_path, monkeypatch):
    home, _ = fake_pc(tmp_path, monkeypatch)
    real, tries = Path.unlink, []

    def held(self, missing_ok=False):
        if self.name == "AnomalyHunter.exe" and len(tries) < 3:
            tries.append(1)
            raise PermissionError("in use")
        return real(self, missing_ok=missing_ok)
    monkeypatch.setattr(Path, "unlink", held)
    app.remove_legacy(home)
    assert len(tries) == 3 and not (home / "AnomalyHunter.exe").exists()
    (home / "AnomalyHunter.exe").write_bytes(b"old")

    def stuck(self, missing_ok=False):
        raise PermissionError("in use")
    monkeypatch.setattr(Path, "unlink", stuck)
    app.remove_legacy(home)  # held for good: left for uninstall, never a failed update
    app.remove_legacy(tmp_path / "nothing here")


def test_uninstall_removes_both_the_new_exe_and_the_old_one(tmp_path, monkeypatch):
    home, stopped = fake_pc(tmp_path, monkeypatch)
    (home / "Arcas.exe").write_bytes(b"new")
    monkeypatch.setattr(app, "reg_delete", lambda *a: None)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert app.uninstall() == 0 and stopped
    assert not (home / "Arcas.exe").exists() and not (home / "AnomalyHunter.exe").exists()


def test_the_run_value_keeps_its_name_so_an_update_replaces_the_old_entry():
    assert app.RUN_VALUE == "AnomalyHunter" and app.LEGACY == "AnomalyHunter.exe"


def test_install_lists_arcas_in_installed_apps_and_uninstall_takes_it_out(tmp_path, monkeypatch):
    # AH-136 (John's usability review, 2026-11-05): people look for a program under Settings > Apps > Installed apps,
    # and Arcas was not there; the only way out was a command typed into Windows+R. The per-user Uninstall key lists it
    # (no administrator prompt) and runs the installed copy's own uninstall
    home = tmp_path / "AnomalyHunter"
    home.mkdir()
    exe = home / "Arcas.exe"
    exe.write_bytes(b"x" * 4096)
    wrote = {}
    monkeypatch.setattr(app, "reg_set", lambda key, name, value: wrote.setdefault(key, {}).__setitem__(name, value))
    monkeypatch.setattr(app.server, "version", lambda: "v0.1.300 (2026-11-05)")
    app.list_in_installed_apps(home, exe)
    entry = wrote[app.UNINSTALL]
    assert app.UNINSTALL == r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Arcas"
    assert entry["DisplayName"] == "Arcas" and entry["Publisher"] == "John Nguyen"
    assert entry["UninstallString"] == f'"{exe}" uninstall' and entry["DisplayIcon"] == f"{exe},0"
    assert entry["InstallLocation"] == str(home) and entry["DisplayVersion"] == "v0.1.300 (2026-11-05)"
    assert entry["NoModify"] == 1 and entry["NoRepair"] == 1 and entry["EstimatedSize"] >= 4
    assert entry["URLInfoAbout"] == "https://ricepillow3000.github.io/excel-anomaly-hunter/"
    # install() lists it, and uninstall() takes the whole key out again
    import inspect
    assert "list_in_installed_apps(home, exe)" in inspect.getsource(app.install)
    gone = []
    (tmp_path / "pc").mkdir()
    fake_pc(tmp_path / "pc", monkeypatch)
    monkeypatch.setattr(app, "reg_delete", lambda key, name=None: gone.append((key, name)))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "pc"))
    assert app.uninstall() == 0 and (app.UNINSTALL, None) in gone


def read_cmd(line):
    """A cmd.exe command line the way cmd reads it: '"cmd" /d /s /c "..."' -> (cmd, [each command's words]). /s takes
    the outer quotes off; & ends a command only outside quotes, and a quoted path is one word, & and spaces included."""
    import shlex
    cmd, rest = line[1:].split('" ', 1)
    assert rest.startswith('/d /s /c "') and rest.endswith('"'), rest
    lex = shlex.shlex(rest[len('/d /s /c "'):-1], posix=True, punctuation_chars="&")
    lex.escape, lex.whitespace_split = "", True  # cmd has no backslash escapes: C:\Users stays C:\Users
    words, commands = list(lex), [[]]
    for w in words:
        commands.append([]) if w == "&" else commands[-1].append(w)
    return cmd, commands


def test_the_uninstall_cleanup_runs_windows_own_cmd_and_survives_a_profile_path_with_an_ampersand_and_a_space(tmp_path, monkeypatch):
    # AH-140 audit: "cmd.exe" by bare name (CreateProcess looks in the exe's own folder first), and a user name with &
    # was cut by cmd into a second command: C:\Users\A&B\... ran "B\..."
    (tmp_path / "A&B Smith").mkdir()
    home, _ = fake_pc(tmp_path / "A&B Smith", monkeypatch)
    me = home / "Arcas.exe"
    me.write_bytes(b"new")
    monkeypatch.setattr(sys, "executable", str(me))
    monkeypatch.setattr(app, "reg_delete", lambda *a, **k: None)
    monkeypatch.setenv("LOCALAPPDATA", str(home.parent))
    started = []
    monkeypatch.setattr(app.subprocess, "Popen", lambda args, **k: started.append(args))
    assert app.uninstall() == 0 and len(started) == 1 and isinstance(started[0], str)
    cmd, line = read_cmd(started[0])
    assert cmd == str(app.WIN / "cmd.exe")
    assert line == [[str(app.WIN / "PING.EXE"), "-n", "4", "127.0.0.1", ">nul"], ["del", "/f", "/q", str(me.resolve())],
                    ["rmdir", str(home)]]


def test_an_uninstall_from_installed_apps_removes_the_running_app_file_too(tmp_path, monkeypatch):
    # Installed apps runs the installed copy, which cannot delete itself while it runs: it asks Windows' own cmd to
    # delete it, and the empty folder, a few seconds after it exits (an uninstall from Downloads leaves that file be)
    home, _ = fake_pc(tmp_path, monkeypatch)
    me = home / "Arcas.exe"
    me.write_bytes(b"new")
    monkeypatch.setattr(sys, "executable", str(me))
    monkeypatch.setattr(app, "reg_delete", lambda *a, **k: None)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    started = []
    monkeypatch.setattr(app.subprocess, "Popen", lambda args, **k: started.append(args))
    assert app.uninstall() == 0
    assert len(started) == 1
    cmd, line = read_cmd(started[0])
    assert cmd == str(app.WIN / "cmd.exe") and line[1] == ["del", "/f", "/q", str(me.resolve())] and line[2] == ["rmdir", str(home)]
    assert not (home / "AnomalyHunter.exe").exists()
    started.clear()
    monkeypatch.setattr(sys, "executable", str(tmp_path / "Downloads" / "Arcas.exe"))
    assert app.uninstall() == 0 and started == []
