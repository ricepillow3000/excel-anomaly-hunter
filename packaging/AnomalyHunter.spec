# One-file build: python -m PyInstaller packaging/AnomalyHunter.spec  ->  dist/Arcas.exe (Windows)
# The bundle carries Python, every package and the pane (frontend/); the PC needs nothing installed.
# Build on Windows for Windows (PyInstaller does not cross-compile): .github/workflows/build-exe.yml does it.
# (This file keeps its old name: README, build-exe.yml, test_bias_context.py and test_product_name.py read it by path.
# The exe is Arcas, AH-101.)
import re
import sys
from pathlib import Path

from PyInstaller.utils.win32.versioninfo import (FixedFileInfo, StringFileInfo, StringStruct, StringTable, VarFileInfo,
                                                 VarStruct, VSVersionInfo)

ROOT = Path(SPECPATH).parent
a = Analysis(
    [str(ROOT / "packaging" / "entry.py")],
    pathex=[str(ROOT / "backend")],
    # the measured bias rules are data, not code: PyInstaller only bundles them when told (bias_context reads them beside itself)
    datas=[(str(ROOT / "frontend"), "frontend"), (str(ROOT / "backend" / "anomaly_hunter" / "ai" / "bias_rules.json"), "anomaly_hunter/ai")],
    excludes=["tkinter", "IPython", "pytest", "schemathesis"],  # not used at run time
)
# the pane's dev-only lint (tools/check.py runs it): in the bundle, the engine would serve it at /selfcheck.js
a.datas = [d for d in a.datas if d[0].replace("\\", "/") != "frontend/selfcheck.js"]

# The file's Properties (and what SignPath reads from the signed file): the product's name, and the release tag the build
# step stamps into frontend/version.txt ("v0.1.123 (2026-11-03)"); a local build without that file is 0.1.0
stamp = ROOT / "frontend" / "version.txt"
tag = re.search(r"v(\d+)\.(\d+)\.(\d+)", stamp.read_text(encoding="utf-8") if stamp.exists() else "")
numbers = (*(int(n) for n in tag.groups()), 0) if tag else (0, 1, 0, 0)
dotted = ".".join(map(str, numbers[:3]))
owner = next(line for line in (ROOT / "LICENSE").read_text(encoding="utf-8").splitlines() if line.startswith("Copyright"))
version = VSVersionInfo(
    ffi=FixedFileInfo(filevers=numbers, prodvers=numbers),
    kids=[
        StringFileInfo([StringTable("040904B0", [
            StringStruct("CompanyName", "ricepillow3000"),
            StringStruct("FileDescription", "Arcas"),
            StringStruct("FileVersion", dotted),
            StringStruct("InternalName", "Arcas"),
            StringStruct("LegalCopyright", owner),
            StringStruct("OriginalFilename", "Arcas.exe"),
            StringStruct("ProductName", "Arcas"),
            StringStruct("ProductVersion", dotted),
        ])]),
        VarFileInfo([VarStruct("Translation", [0x0409, 1200])]),
    ],
)

exe = EXE(
    PYZ(a.pure), a.scripts, a.binaries, a.datas,
    name="Arcas",
    console=False,  # no black window: messages are Windows message boxes, the engine logs to server.log
    icon=str(ROOT / "packaging" / "AnomalyHunter.ico"),  # 16-64 the small drawing, 256 the large one (docs/design/logo/README.md)
    version=version,
    upx=False,  # UPX-packed files trip antivirus false alarms
)
