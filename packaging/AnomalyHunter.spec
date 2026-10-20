# One-file build: python -m PyInstaller packaging/AnomalyHunter.spec  ->  dist/AnomalyHunter.exe (Windows)
# The bundle carries Python, every package and the pane (frontend/); the PC needs nothing installed.
# Build on Windows for Windows (PyInstaller does not cross-compile): .github/workflows/build-exe.yml does it.
import sys
from pathlib import Path

ROOT = Path(SPECPATH).parent
a = Analysis(
    [str(ROOT / "packaging" / "entry.py")],
    pathex=[str(ROOT / "backend")],
    datas=[(str(ROOT / "frontend"), "frontend")],
    excludes=["tkinter", "IPython", "pytest", "schemathesis"],  # not used at run time
)
exe = EXE(
    PYZ(a.pure), a.scripts, a.binaries, a.datas,
    name="AnomalyHunter",
    console=False,  # no black window: messages are Windows message boxes, the engine logs to server.log
    icon=str(ROOT / "packaging" / "AnomalyHunter.ico"),  # 16/32 hand-drawn, 48/64/256 from the master (docs/design/logo/README.md)
    upx=False,  # UPX-packed files trip antivirus false alarms
)
