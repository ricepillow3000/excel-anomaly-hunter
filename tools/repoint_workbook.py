# Copy a workbook, pointing its Anomaly Hunter add-in record from the old \panel folder to \frontend.
# Workbooks saved before 2026-10-09 remember the add-in at ...\excel-anomaly-hunter\panel; Excel trusts only the
# registered catalog folder (\frontend), so it silently skips them and the pane stops auto-opening.
# usage: py tools\repoint_workbook.py <source.xlsx> <destination.xlsx>   (never writes the source)
import os
import sys
import zipfile
from pathlib import Path

src, dst = sys.argv[1], sys.argv[2]
# an if, not an assert (python -O drops asserts). A dst that exists is asked of the file system: a hard link or a
# Windows 8.3 short name is the source under another name (AH-13 review); one that doesn't exist yet is compared by path
same = os.path.samefile(src, dst) if os.path.exists(dst) else Path(src).resolve() == Path(dst).resolve() or src.lower() == dst.lower()
if same:
    sys.exit("write a copy, never the original")
n = 0
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        data = zin.read(item.filename)
        if item.filename.startswith("xl/webextensions/webextension") and item.filename.endswith(".xml"):
            new = data.replace(rb"excel-anomaly-hunter\panel", rb"excel-anomaly-hunter\frontend")
            n += new != data
            data = new
        zout.writestr(item, data)
print(f"{dst}: {n} add-in record(s) repointed")
