"""Claude triage of flagged rows: useful-weird vs broken-weird.
Key stays server-side (never panel, never workbook). Claude only proposes; 2 safe actions may auto-apply."""
import os
import re
from typing import Literal

import anthropic
from pydantic import BaseModel, ValidationError

MODEL = "claude-opus-5"


class RowTriage(BaseModel):
    row_index: int
    verdict: Literal["useful-weird", "broken-weird"]
    reason: str
    safe_action: Literal["none", "add_note", "copy_to_anomalies_sheet"]
    suggested_action_detail: str


class TriageBatch(BaseModel):
    results: list[RowTriage]


def api_key_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _build_prompt(columns, flagged):
    rows = "\n".join(
        f"- row_index {r.get('row_index')}: values={dict(zip(columns, r.get('values', [])))}, "
        f"severity={r.get('severity')}, bucket={r.get('bucket')}, engine_reason={r.get('reason')}"
        for r in flagged)
    return (
        "A statistical anomaly engine flagged these spreadsheet rows. For each row decide: "
        "USEFUL-WEIRD (real signal worth a human's attention - fraud spike, record sale, rare real event) or "
        "BROKEN-WEIRD (data-quality problem - typo, import error, duplicate, unit mismatch). "
        "Give a one-sentence reason. Don't claim certainty you don't have.\n\n"
        "Only two safe_action values may auto-apply, because neither touches original data: "
        "'add_note' (write an explanatory note) or 'copy_to_anomalies_sheet' (copy row to a separate sheet). "
        "For anything else - delete, edit a value, move rows - use safe_action='none' and put the idea "
        "in suggested_action_detail; a human does it by hand.\n\n"
        f"Rows:\n{rows}")


def triage_rows(columns, flagged):
    """-> [RowTriage dict] per flagged row. Raises anthropic typed errors; server maps them to HTTP."""
    if not flagged:
        return []
    resp = anthropic.Anthropic().messages.parse(
        model=MODEL, max_tokens=4096, output_format=TriageBatch,
        messages=[{"role": "user", "content": _build_prompt(columns, flagged)}])
    return [r.model_dump() for r in resp.parsed_output.results]


# ---- Fix one flagged row from a plain-English request. Claude proposes cell writes; the panel shows
# them old -> new and writes nothing until the user clicks Apply (with Undo). ----

MAX_CHANGES = 50
CELL = re.compile(r"[A-Z]{1,3}[1-9][0-9]{0,6}")


class CellChange(BaseModel):
    cell: str  # A1-style, e.g. "D7"
    new: str  # formula ("=MEDIAN(D2:D45)") or a plain value, entered as if typed


class Fix(BaseModel):
    explanation: str
    changes: list[CellChange]


def col_letter(n):
    """0-based column index -> Excel letters (0 -> A, 26 -> AA)."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _fix_prompt(columns, rows, i, start_row, start_col, reason, intent):
    letters = [col_letter(start_col + j) for j in range(len(columns))]
    top = start_row + 1  # 1-based sheet row of the header
    line = lambda k: f"row {top + 1 + k}: " + ", ".join(f"{c}{top + 1 + k}={v!r}" for c, v in zip(letters, rows[k]))
    near = [line(k) for k in range(max(0, i - 5), min(len(rows), i + 6)) if k != i]
    return (
        "You fix one flagged row in an Excel sheet. Answer with cell writes the user will preview and approve.\n"
        f"Data range: {letters[0]}{top}:{letters[-1]}{top + len(rows)} (row {top} = headers).\n"
        "Columns: " + ", ".join(f"{c}={h}" for c, h in zip(letters, columns)) + "\n"
        f"Flagged {line(i)}\n"
        f"Why it was flagged: {reason or 'unknown'}\n"
        "Nearby rows for context:\n" + "\n".join(near) + "\n\n"
        f"User's request: {intent.strip() or 'Recommend the single best fix for this flagged row.'}\n\n"
        "Rules: each change is one cell (A1 style, e.g. D7) and the exact text to enter in it - an Excel formula "
        "(English function names, comma separators, start with =) or a plain value. Prefer a formula when the value "
        "should follow the data (e.g. =MEDIAN(D2:D45)). Change only what the request needs; never overwrite the "
        "header row unless asked. If the request can't be done by writing cells (delete/sort/move rows, VBA), "
        "return no changes and explain the manual steps. 'explanation' = 1-3 plain-English sentences for a "
        "non-expert. Don't claim certainty you don't have.")


def suggest_fix(columns, rows, row_index, start_row, start_col, reason, intent):
    """-> {explanation, changes: [{cell, new}]}. Invalid cell addresses are dropped. Raises anthropic errors."""
    try:
        resp = anthropic.Anthropic().messages.parse(
            model=MODEL, max_tokens=16000, output_format=Fix,
            messages=[{"role": "user", "content": _fix_prompt(columns, rows, row_index, start_row, start_col, reason, intent)}])
    except ValidationError:  # answer cut off mid-JSON
        raise ValueError("Claude's answer came back incomplete - try again or shorten the request.") from None
    fix = resp.parsed_output
    if fix is None:  # refusal
        raise ValueError(f"Claude gave no usable answer (stop_reason={resp.stop_reason}).")
    changes = [{"cell": c.cell.strip().replace("$", "").upper(), "new": c.new} for c in fix.changes]
    return {"explanation": fix.explanation,
            "changes": [c for c in changes if CELL.fullmatch(c["cell"])][:MAX_CHANGES]}
