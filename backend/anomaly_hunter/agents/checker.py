"""Agent 3: check a fix. Put it into a copy of the table and scan again with the SAME limits, so the row is judged
exactly like the first time - by every check, not only the one that flagged it."""
from anomaly_hunter.agents.scan_agent import scan


def check(columns, rows, limits, i, changes, strength=5):
    """changes = [{"col": column index, "value": new cell}] in row i -> {clean, severity, reason} for that row.
    strength = the one the first scan used, so the row is judged by the same checks."""
    rows = list(rows)
    rows[i] = list(rows[i])  # the caller's table is never touched
    for c in changes:
        rows[i][c["col"]] = c["value"]
    verdict = scan(columns, rows, limits, strength=strength)[1][i]
    return {"clean": verdict["severity"] in (None, "Noted"), "severity": verdict["severity"], "reason": verdict["reason"]}


def slips(v):
    """Values one typing slip away from v -> {value: what slipped}: two neighbouring digits swapped, an extra digit,
    the decimal point in the wrong place (x10^k, |k| <= 3), the sign flipped. A dropped digit is not tried: it could
    have been any of ten."""
    s, sign, out = f"{abs(v):.10g}", -1 if v < 0 else 1, {}

    def add(c, kind):
        c = float(f"{c:.10g}")
        if c != v:
            out.setdefault(c, kind)

    if "e" not in s:
        for k in range(len(s) - 1):
            if s[k] != s[k + 1] and (s[k] + s[k + 1]).isdigit():
                add(sign * float(s[:k] + s[k + 1] + s[k] + s[k + 2:]), "two digits swapped")
        for k in range(len(s)):
            if s[k].isdigit() and (t := s[:k] + s[k + 1:]) not in ("", "."):
                add(sign * float(t), "an extra digit")
    for e in (-3, -2, -1, 1, 2, 3):
        add(v * 10 ** e, "the decimal point in the wrong place")
    if v:
        add(-v, "the sign flipped")
    return out


MAX_CELLS = 300_000  # ponytail: every candidate costs a full re-scan (~1 s at this size); bigger sheets get no typo hunt


def suggest(columns, rows, limits, i, col, strength=5):
    """For a row that is only unusual (nothing past a limit): the ONE value a typing slip away from its `col` cell that
    lands inside the column's usual range AND makes the whole row look normal again -> {value, kind}. A median would
    always "pass" and invent data, so none is offered; two candidates that both pass = no way to know which: {}."""
    if col not in columns or len(rows) * len(columns) > MAX_CELLS:
        return {}
    j = columns.index(col)
    v, lim = rows[i][j], (limits or {}).get(col)
    if type(v) not in (int, float) or not lim or lim[0] is None or lim[1] is None:
        return {}
    nums = [r[j] for r in rows if type(r[j]) in (int, float)]
    whole = sum(float(x).is_integer() for x in nums) >= 0.95 * len(nums)  # counts: 1.2 units is no fix
    ok = [(c, kind) for c, kind in slips(v).items() if lim[0] <= c <= lim[1] and (not whole or c.is_integer())
          and check(columns, rows, limits, i, [{"col": j, "value": c}], strength)["clean"]]
    return {"value": ok[0][0], "kind": ok[0][1]} if len(ok) == 1 else {}
