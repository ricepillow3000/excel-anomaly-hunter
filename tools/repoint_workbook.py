# Copy a workbook, pointing its Anomaly Hunter add-in record from the old \panel folder to \frontend.
# Workbooks saved before 2026-10-09 remember the add-in at ...\excel-anomaly-hunter\panel; Excel trusts only the
# registered catalog folder (\frontend), so it silently skips them and the pane stops auto-opening.
# usage: py tools\repoint_workbook.py <source.xlsx> <destination.xlsx>   (never writes the source)
import sys
import zipfile

src, dst = sys.argv[1], sys.argv[2]
assert src.lower() != dst.lower(), "write a copy, never the original"
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
