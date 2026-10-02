"""Claude triage: classify already-flagged rows as useful-weird vs broken-weird.

Reads ANTHROPIC_API_KEY from the environment per the project's own decision —
the key never reaches the browser/panel or gets saved into the workbook (see
docs/design/brainstorm-notes.md decision 2 and the open question it resolves).
Read-and-propose only: Claude never edits cells directly. Only two action
kinds are allowed to auto-apply (add_note, copy_to_anomalies_sheet) per
decision 4 — anything else comes back as text for a human to act on by hand.
"""
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


_client = None


def _get_client():
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def api_key_configured():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _build_prompt(columns, flagged):
    lines = []
    for row in flagged:
        values = dict(zip(columns, row.get("values", [])))
        lines.append(
            f"- row_index {row.get('row_index')}: values={values}, "
            f"severity={row.get('severity')}, bucket={row.get('bucket')}, "
            f"engine_reason={row.get('reason')}"
        )
    rows_text = "\n".join(lines)
    return (
        "You are triaging rows a statistical anomaly-detection engine already flagged "
        "in a spreadsheet. For each row, decide: is it USEFUL-WEIRD (a real signal worth "
        "a human's attention — a fraud spike, a record sale, a genuine rare event) or "
        "BROKEN-WEIRD (a data-quality problem — a typo, an import error, a duplicate, a "
        "unit mismatch)? Give a one-sentence reason. Don't claim certainty you don't have.\n\n"
        "You may suggest exactly two safe_action values that this tool is allowed to apply "
        "automatically, because neither touches the analyst's original data: 'add_note' "
        "(write an explanatory note, no value changes) or 'copy_to_anomalies_sheet' (copy "
        "the row to a separate sheet, original left untouched). For anything else — "
        "deleting, editing a value, moving rows — use safe_action='none' and put the idea "
        "only in suggested_action_detail; a human must do it by hand.\n\n"
        f"Rows:\n{rows_text}"
    )


def triage_rows(columns, flagged):
    """flagged: [{row_index, values, severity, bucket, reason}, ...].

    Returns a list of dicts matching RowTriage, one per input row (same
    row_index values). Raises the anthropic SDK's typed exceptions on
    failure — callers translate those to HTTP responses.
    """
    if not flagged:
        return []
    client = _get_client()
    response = client.messages.parse(
        model=MODEL,
        max_tokens=4096,
        messages=[{"role": "user", "content": _build_prompt(columns, flagged)}],
        output_format=TriageBatch,
    )
    return [r.model_dump() for r in response.parsed_output.results]
