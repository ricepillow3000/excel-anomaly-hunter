"""The one-file Windows app, Arcas.exe. No Python needed on the PC.
  Arcas.exe              install or repair: copy itself to %LOCALAPPDATA%\\AnomalyHunter, trust the local HTTPS
                         cert (Windows asks once), list the add-in in Excel, start the engine now and at every logon,
                         open Excel. Same steps as install.bat, without Python or a console.
  Arcas.exe serve        the engine only (what Windows starts at logon)
  Arcas.exe scan F...    no-Excel mode, same options as `arcas scan`
  Arcas.exe uninstall"""
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from anomaly_hunter import cli, powerbi, practice, sealed, server

APP = "Arcas.exe"  # built by packaging/AnomalyHunter.spec; the docstring above is the usage a wrong command shows
# Before AH-101 the app was AnomalyHunter.exe. The folder, the Run value and the certificate keep their old names, so an
# update installed over an old install finds them; only the old exe is stopped and removed.
LEGACY = "AnomalyHunter.exe"
RUN_VALUE = "AnomalyHunter"  # the Run value's name: the same name, so an update overwrites the old entry
ID = "a64b585c-34c7-4447-b3ae-9aa8b3294bcf"  # the add-in's Id in manifest.xml
CATALOG = "{3f9a1c2e-7b4d-4e8a-9c61-5d2e8f0b7a13}"  # same trusted catalog as install.bat: an Add made there carries over
CAT = rf"Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{CATALOG}"
DEV = r"Software\Microsoft\Office\16.0\WEF\Developer"
RUN = r"Software\Microsoft\Windows\CurrentVersion\Run"
# AH-136: listed under Settings > Apps > Installed apps, where people look for a program to remove; the per-user key
# needs no administrator prompt and runs the installed copy's own uninstall
UNINSTALL = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Arcas"
SITE = "https://ricepillow3000.github.io/excel-anomaly-hunter/"
QUIET = 0x08000000  # CREATE_NO_WINDOW: no black window flashing up for a tool
# install.bat and site/support.html say the same words (test_product_name.py)
NOT_ADMIN = ("Arcas could not finish. Your Windows account is not an administrator on this PC. "
             "Ask the person who looks after your computers to install it for you.")


def _system32():
    """Windows' own System32 folder, asked from Windows (not an environment variable anyone can set)."""
    if os.name != "nt":
        return Path(r"C:\Windows\System32")
    import ctypes
    buf = ctypes.create_unicode_buffer(260)
    ctypes.windll.kernel32.GetSystemDirectoryW(buf, 260)
    return Path(buf.value)


WIN = _system32()  # tools run by full path: never a same-named file nearby


def say(text, error=False):
    """A Windows message box - the app has no console. Elsewhere (tests): print."""
    if os.name != "nt":
        return print(text, file=sys.stderr if error else sys.stdout)
    import ctypes
    ctypes.windll.user32.MessageBoxW(None, text, "Arcas", 0x10 if error else 0x40)


def fail(text):
    say(text, error=True)
    return 1


def ask(text):
    """OK / Cancel box -> True for OK."""
    import ctypes
    return ctypes.windll.user32.MessageBoxW(None, text, "Arcas", 0x31) == 1


def tool(*args):
    """Run a Windows tool from System32, hidden -> its exit code."""
    return subprocess.run([str(WIN / args[0]), *args[1:]], capture_output=True, check=False, creationflags=QUIET).returncode  # noqa: S603


def excel_open():
    out = subprocess.run([str(WIN / "tasklist.exe"), "/fi", "imagename eq EXCEL.EXE"], capture_output=True, text=True, check=False,  # noqa: S603
                         creationflags=QUIET).stdout
    return "EXCEL.EXE" in out.upper()


def stop_engines():
    """Stop any running engine (this app's, the exe's old name's, or install.bat's pythonw), never this process or its
    one-file launcher."""
    keep = f"{os.getpid()},{os.getppid()}"
    tool(r"WindowsPowerShell\v1.0\powershell.exe", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process | ? { ($_.Name -in 'pythonw.exe','python.exe' -and $_.CommandLine -match 'anomaly_hunter')"
         f" -or ($_.Name -in '{APP}','{LEGACY}' -and $_.ProcessId -notin @({keep})) }} | % {{ Stop-Process -Id $_.ProcessId -Force }}")


def remove_legacy(home):
    """An update over an install made before the rename: the old exe goes, so only Arcas.exe is left to start. A stopped
    engine lets go of its file a moment later; one still held is left for uninstall, never a failed update."""
    old, me = home / LEGACY, Path(sys.executable).resolve()
    for _ in range(10):
        try:
            if old.exists() and old.resolve() != me:  # never this running file (an update saved under the old name)
                old.unlink()
            return
        except OSError:
            time.sleep(0.5)


def keep_invite(me, home):
    """An invite kit from John (relay/new-invite.mjs) holds the code next to the exe: AI help with nothing to paste. It
    was copied as it was, plain text in %LOCALAPPDATA% (AH-104); it is sealed there now, and the kit is left as John
    made it (a read of it through `sealed` would seal the kit's own copy)."""
    kit = me.with_name("invite-code.txt")
    if kit.exists():
        sealed.save(home / "invite-code.txt", kit.read_text(encoding="utf-8").strip())


def reg_set(key, name, value):
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as k:
        winreg.SetValueEx(k, name, 0, winreg.REG_DWORD if isinstance(value, int) else winreg.REG_SZ, value)


def reg_delete(key, name=None):
    import winreg
    try:
        if name is None:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
        else:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, name)
    except OSError:  # already gone
        pass


def list_in_installed_apps(home, exe):
    for name, value in (("DisplayName", "Arcas"), ("Publisher", "John Nguyen"), ("DisplayVersion", server.version()),
                        ("DisplayIcon", f"{exe},0"), ("UninstallString", f'"{exe}" uninstall'), ("InstallLocation", str(home)),
                        ("URLInfoAbout", SITE), ("HelpLink", SITE + "support.html"),
                        ("EstimatedSize", max(1, exe.stat().st_size // 1024)), ("NoModify", 1), ("NoRepair", 1)):
        reg_set(UNINSTALL, name, value)


def excel_exe():
    """Desktop Excel's own path, where Windows registers it (App Paths), or None. Asking Windows to "open" an .xlsx
    instead shows "Pick an app" on a PC with no Excel and can hold the installer until someone picks one."""
    import winreg
    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(root, r"Software\Microsoft\Windows\CurrentVersion\App Paths\excel.exe") as k:
                path = Path(str(winreg.QueryValue(k, None)).strip('"'))
        except OSError:
            continue
        if path.name.lower() == "excel.exe" and path.exists():
            return path
    return None


def install():
    home, exe = server.HOME, server.HOME / APP
    while excel_open():  # Excel reads the add-in list when it starts
        if not ask("Please close Excel, then click OK."):
            return 1
    stop_engines()
    home.mkdir(parents=True, exist_ok=True)
    me = Path(sys.executable)
    if me.resolve() != exe.resolve():  # keep a copy of this file where Windows can start it at every logon
        for _ in range(20):  # a stopped engine lets go of the file a moment later
            try:
                shutil.copy2(me, exe)
                break
            except PermissionError:
                time.sleep(0.5)
        else:
            return fail(f"Couldn't update {exe} - restart the PC, then double-click {APP} again.")
    try:  # the copy keeps the download's "from the internet" mark; the user said Run once - not again at every logon
        os.remove(f"{exe}:Zone.Identifier")
    except OSError:
        pass  # no mark (copied from a terminal download, or not Windows)
    remove_legacy(home)
    keep_invite(me, home)

    # HTTPS that only works for 127.0.0.1: Excel only loads add-ins over https. Windows asks once - Yes.
    if server.make_cert(home) or tool("certutil.exe", "-user", "-store", "Root", server.CERT_NAME):
        tool("certutil.exe", "-user", "-delstore", "Root", server.CERT_NAME)
        if tool("certutil.exe", "-user", "-addstore", "Root", str(home / "ca.pem")):
            (home / "cert.pem").unlink(missing_ok=True)  # untrusted chain: made again next time
            return fail(f"Windows didn't trust the certificate. Double-click {APP} again and click Yes when Windows asks.")

    # Listed in Excel (Add-ins > SHARED FOLDER): a trusted catalog must be a share path, so this PC's own admin share
    addin = home / "addin"
    addin.mkdir(exist_ok=True)
    shutil.copy2(server.PANEL / "manifest.xml", addin / "manifest.xml")
    unc = rf"\\localhost\{str(addin)[0]}$" + str(addin)[2:]
    if not Path(unc, "manifest.xml").exists():
        # Windows opens the admin share to administrators only: a standard account was told the share was off (AH-129).
        # The message says it in plain words (AH-135: "Can't reach \\localhost\C$" meant nothing to most people); the
        # path, and the rarer cause, go to the log for whoever helps them
        try:
            with open(home / "server.log", "a", encoding="utf-8") as log:
                log.write(f"Install stopped: can't reach {unc}. The account isn't an administrator on this PC, or the C$ admin share is off.\n")
        except OSError:
            pass  # the message below still says what to do
        return fail(NOT_ADMIN)
    reg_delete(DEV, ID)
    reg_delete(rf"{DEV}\{ID}")
    reg_set(CAT, "Id", CATALOG)
    reg_set(CAT, "Url", unc)
    reg_set(CAT, "Flags", 1)

    # Power BI: double-click a .pbids; it opens the CSV every scan overwrites (the sheet, or its flagged rows)
    powerbi.shortcuts(home, home)

    reg_set(RUN, RUN_VALUE, f'"{exe}" serve')  # engine at every logon
    list_in_installed_apps(home, exe)
    subprocess.Popen([str(exe), "serve"], creationflags=QUIET | 0x00000008)  # noqa: S603 - DETACHED_PROCESS: outlives this window
    for _ in range(120):  # the one-file engine unpacks itself first (~10-30 s)
        if server._already_running(home):
            break
        time.sleep(0.5)
    else:
        return fail(f"The engine didn't start. Details: {home / 'server.log'}")
    # Excel opens on "Start here": the 5 clicks that add it stay on screen while the user does them (a message box is
    # gone after one click), and a Practice sheet shows what a scan finds
    start = practice.make(home / "Start here.xlsx")
    excel = excel_exe()
    if excel:  # Excel itself, given the workbook: never a "Pick an app" question, never waits on Excel
        subprocess.Popen([str(excel), str(start)], creationflags=0x00000008)  # noqa: S603 - DETACHED_PROCESS
    say("Arcas is installed.\n\n" + ("Excel is opening a \"Start here\" workbook: follow its 5 steps to add Arcas to "
        "Excel (first time only), then try it on the Practice sheet." if excel else
        f"Desktop Excel wasn't found. Once it is installed, open {start}: it shows the 5 steps.") +
        "\n\nIn Excel: Home > Add-ins > More Add-ins > SHARED FOLDER > Arcas > Add.")
    return 0


def uninstall():
    stop_engines()
    for key, name in ((RUN, RUN_VALUE), (DEV, ID)):
        reg_delete(key, name)
    reg_delete(rf"{DEV}\{ID}")
    reg_delete(CAT)
    reg_delete(UNINSTALL)
    tool("certutil.exe", "-user", "-delstore", "Root", server.CERT_NAME)
    me = Path(sys.executable).resolve()
    for p in server.HOME.glob("*"):  # everything but this running file: Arcas.exe, and the old AnomalyHunter.exe too
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.resolve() != me:
            for _ in range(10):  # a just-stopped engine lets go of its exe a moment later
                try:
                    p.unlink()
                    break
                except OSError:  # still held after 5 s: left for the user to delete
                    time.sleep(0.5)
    shutil.rmtree(Path(os.environ["LOCALAPPDATA"], r"Microsoft\Office\16.0\Wef"), ignore_errors=True)
    if me.parent == server.HOME.resolve():
        # run from Installed apps: the installed copy can't delete itself while it runs, so Windows' own cmd deletes it,
        # and the then empty folder, a few seconds after this exits (ping is cmd's way to wait). AH-140: by full path, and
        # one string with each path in quotes (a list quotes only spaces, so a user name with & split the command)
        subprocess.Popen(f'"{WIN / "cmd.exe"}" /d /s /c ""{WIN / "PING.EXE"}" -n 4 127.0.0.1 >nul & del /f /q "{me}" & '  # noqa: S603
                         f'rmdir "{server.HOME}""', creationflags=QUIET | 0x00000008)
        say("Arcas is uninstalled.")
        return 0
    say(f"Arcas is uninstalled. You can delete {me.name} now.")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    command = argv[0] if argv else "install"
    if command == "serve":
        server.HOME.mkdir(parents=True, exist_ok=True)
        if not (server.HOME / "cert.pem").exists():  # made (and trusted) at install; never swapped here for an untrusted one
            server.make_cert(server.HOME)
        sys.argv = [sys.argv[0]]
        return server.main()
    if command == "scan":
        return cli.main(argv)
    if os.name != "nt":
        return fail(f"'{command}' works on Windows only. Here: serve, or scan FILE...")
    if command == "uninstall":
        return uninstall()
    if command == "install":
        return install()
    return fail(__doc__)
