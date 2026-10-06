"""Claude triage of flagged rows: useful-weird vs broken-weird.
Key stays server-side (never panel, never workbook). Claude only proposes; 2 safe actions may auto-apply."""
import os
from typing import Literal

import anthropic
from pydantic import BaseModel

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
