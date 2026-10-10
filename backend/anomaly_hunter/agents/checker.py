"""Agent 3: check a fix. Put it into a copy of the table and scan again with the SAME limits, so the row is judged
exactly like the first time - by every check, not only the one that flagged it."""
from anomaly_hunter.agents.scan_agent import scan


def check(columns, rows, limits, i, changes):
    """changes = [{"col": column index, "value": new cell}] in row i -> {clean, severity, reason} for that row."""
    rows = list(rows)
    rows[i] = list(rows[i])  # the caller's table is never touched
    for c in changes:
        rows[i][c["col"]] = c["value"]
    verdict = scan(columns, rows, limits)[1][i]
    return {"clean": verdict["severity"] in (None, "Noted"), "severity": verdict["severity"], "reason": verdict["reason"]}
