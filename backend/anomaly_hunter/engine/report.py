"""report.xlsx: Data (every row, colored), Anomalies (flagged, worst first), Summary, Fairness (protected subgroups)."""
from collections import Counter

from openpyxl import Workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.comments import Comment
from openpyxl.styles import PatternFill

from anomaly_hunter.engine.detectors import K

FILL = {s: PatternFill("solid", fgColor=c) for s, c in
        {"Noted": "FFFFF2CC", "Low": "FFFFF2A8", "Medium": "FFFFCC80", "High": "FFFF8A80"}.items()}
RANK = {"High": 3, "Medium": 2, "Low": 1}


# "left out" is a column too wide to compare: never "Even", a comparison that never ran (AH-63 review 1)
VERDICT = {"gap": "Gap - check why", "unclear": "Not enough rows to tell", "left out": "Left out - too many groups"}


def _put(ws, row):
    """A control character ("\x07") is no XML character: openpyxl refused it, and the whole report with it (AH-160)."""
    ws.append([ILLEGAL_CHARACTERS_RE.sub("?", v) if isinstance(v, str) else v for v in row])


def write_report(df, rows, status, out_path, limits_path, warnings, fair=None):
    wb = Workbook()
    data = wb.active
    data.title = "Data"
    head = [*df.columns, "Severity", "Bucket", "Reason"]
    _put(data, head)
    vals = df.astype(object).where(df.notna(), None).values.tolist()
    for v, r in zip(vals, rows):
        _put(data, v + [r["severity"] or "", r["bucket"] or "", r["reason"]])
        if r["severity"]:
            for cell in data[data.max_row]:
                cell.fill = FILL[r["severity"]]
            # ponytail: one note on Reason cell, not one per triggering cell
            data.cell(data.max_row, len(head)).comment = Comment(ILLEGAL_CHARACTERS_RE.sub("?", r["reason"]), "Arcas")

    bad = wb.create_sheet("Anomalies")
    _put(bad, head + ["Row"])
    order = sorted((i for i, r in enumerate(rows) if r["severity"] in RANK),
                   key=lambda i: (-RANK[rows[i]["severity"]], -rows[i]["magnitude"]))
    for i in order:
        _put(bad, vals[i] + [rows[i]["severity"], rows[i]["bucket"], rows[i]["reason"], i + 2])

    sev, bkt = Counter(r["severity"] for r in rows), Counter(r["bucket"] for r in rows)
    lines = [["Counts by severity"], *([k, sev[k]] for k in ("High", "Medium", "Low", "Noted")),
             [], ["Counts by bucket"], *([k, bkt[k]] for k in ("Duplicates", "Irregularities", "Behavioral")),
             [], ["Detectors"], *status.items(),
             [], ["Limits file", str(limits_path)], ["K", K]]
    if warnings:
        lines += [[], ["Warnings"], *([w] for w in warnings)]
    summary = wb.create_sheet("Summary")
    for line in lines:
        _put(summary, line)

    # Fairness: which columns are protected (never used to judge who is unusual) and one line per subgroup test
    fairness = wb.create_sheet("Fairness")
    prot = (fair or {}).get("protected", {})
    _put(fairness, ["Protected columns - checked for typos and blanks, never used to decide who is unusual"])
    for col, why in prot.items():
        _put(fairness, [col, why])
    if not prot:
        _put(fairness, ["(none found by column name: age, gender, race, marital status, location, zip...)"])
    _put(fairness, [])
    _put(fairness, ["Result", "What was compared", "Finding", "Groups (rows, rate)", "p-value", "In real data"])
    for t in (fair or {}).get("tests", []):
        _put(fairness, [VERDICT.get(t["verdict"], "Even"), f"{t['column']}: {t['test']}",
                         t["text"], "; ".join(f"{g} ({n}, {r:.0%})" for g, (n, r) in t["groups"].items()),
                         "" if t["p"] is None else round(t["p"], 4), t.get("context", "")])
    for ws in wb:  # a scanned cell "=HYPERLINK(...)" or "=cmd|..." stays text: opening the report never runs it
        for row in ws.iter_rows():
            for cell in row:
                if cell.data_type == "f":
                    cell.data_type = "s"
    wb.save(out_path)
