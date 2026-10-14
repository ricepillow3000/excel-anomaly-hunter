"""The one-file Windows app (AnomalyHunter.exe, built by packaging/AnomalyHunter.spec). No Python needed on the PC.
  AnomalyHunter.exe              install or repair: copy itself to %LOCALAPPDATA%\\AnomalyHunter, trust the local
                                 HTTPS cert (Windows asks once), list the add-in in Excel, start the engine now and
                                 at every logon, open Excel. Same steps as install.bat, without Python or a console.
  AnomalyHunter.exe serve        the engine only (what Windows starts at logon)
  AnomalyHunter.exe scan F...    no-Excel mode, same options as `anomaly-hunter scan`
  AnomalyHunter.exe uninstall"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from anomaly_hunter import cli, practice, server

APP = "AnomalyHunter.exe"
ID = "a64b585c-34c7-4447-b3ae-9aa8b3294bcf"  # the add-in's Id in manifest.xml
CATALOG = "{3f9a1c2e-7b4d-4e8a-9c61-5d2e8f0b7a13}"  # same trusted catalog as install.bat: an Add made there carries over
CAT = rf"Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{CATALOG}"
DEV = r"Software\Microsoft\Office\16.0\WEF\Developer"
RUN = r"Software\Microsoft\Windows\CurrentVersion\Run"
QUIET = 0x08000000  # CREATE_NO_WINDOW: no black window flashing up for a tool


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
    ctypes.windll.user32.MessageBoxW(None, text, "Anomaly Hunter", 0x10 if error else 0x40)


def fail(text):
    say(text, error=True)
    return 1


def ask(text):
    """OK / Cancel box -> True for OK."""
    import ctypes
    return ctypes.windll.user32.MessageBoxW(None, text, "Anomaly Hunter", 0x31) == 1


def tool(*args):
    """Run a Windows tool from System32, hidden -> its exit code."""
    return subprocess.run([str(WIN / args[0]), *args[1:]], capture_output=True, check=False, creationflags=QUIET).returncode  # noqa: S603


def excel_open():
    out = subprocess.run([str(WIN / "tasklist.exe"), "/fi", "imagename eq EXCEL.EXE"], capture_output=True, text=True, check=False,  # noqa: S603
                         creationflags=QUIET).stdout
    return "EXCEL.EXE" in out.upper()


def stop_engines():
    """Stop any running engine (this app's, or install.bat's pythonw), never this process or its one-file launcher."""
    keep = f"{os.getpid()},{os.getppid()}"
    tool(r"WindowsPowerShell\v1.0\powershell.exe", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process | ? { ($_.Name -in 'pythonw.exe','python.exe' -and $_.CommandLine -match 'anomaly_hunter')"
         f" -or ($_.Name -eq '{APP}' -and $_.ProcessId -notin @({keep})) }} | % {{ Stop-Process -Id $_.ProcessId -Force }}")


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
    invite = me.with_name("invite-code.txt")  # an invite kit from John: AI help with nothing to paste
    if invite.exists():
        shutil.copy2(invite, home / "invite-code.txt")

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
        return fail(f"Can't reach {unc} - the C$ admin share is off on this PC.")
    reg_delete(DEV, ID)
    reg_delete(rf"{DEV}\{ID}")
    reg_set(CAT, "Id", CATALOG)
    reg_set(CAT, "Url", unc)
    reg_set(CAT, "Flags", 1)

    # Power BI: double-click this file; it opens the CSV every scan overwrites
    pbids = home / "anomaly-hunter.pbids"
    pbids.write_text(json.dumps({"version": "0.1", "connections": [{"details": {"protocol": "file", "address": {
        "path": str(home / "latest-scan.csv")}}, "options": {}, "mode": "Import"}]}, indent=2), encoding="utf-8")

    reg_set(RUN, "AnomalyHunter", f'"{exe}" serve')  # engine at every logon
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
    for target in (start, "excel.exe"):  # Excel by the name Windows registers for it (App Paths), if .xlsx isn't Excel's
        try:
            os.startfile(target)  # noqa: S606 - our own workbook, or Excel itself
            break
        except OSError:
            continue  # no desktop Excel registered: the message below still says what to do
    say("Anomaly Hunter is installed.\n\nExcel is opening a \"Start here\" workbook: follow its 5 steps to add Anomaly "
        "Hunter to Excel (first time only), then try it on the Practice sheet.\n\nIn Excel: Home > Add-ins > More Add-ins "
        "> SHARED FOLDER > Anomaly Hunter > Add.")
    return 0


def uninstall():
    stop_engines()
    for key, name in ((RUN, "AnomalyHunter"), (DEV, ID)):
        reg_delete(key, name)
    reg_delete(rf"{DEV}\{ID}")
    reg_delete(CAT)
    tool("certutil.exe", "-user", "-delstore", "Root", server.CERT_NAME)
    me = Path(sys.executable).resolve()
    for p in server.HOME.glob("*"):  # everything but this running file
        if p.is_dir():
            shutil.rmtree(p, ignore_errors=True)
        elif p.resolve() != me:
            try:
                p.unlink()
            except OSError:  # a just-stopped engine may hold its file a moment longer: left for the user to delete
                pass
    shutil.rmtree(Path(os.environ["LOCALAPPDATA"], r"Microsoft\Office\16.0\Wef"), ignore_errors=True)
    say(f"Anomaly Hunter is uninstalled. You can delete {APP} now.")
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
