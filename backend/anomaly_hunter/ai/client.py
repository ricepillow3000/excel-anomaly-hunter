"""AI fix for one flagged row: free Google Gemini key (pasted in the pane, or GEMINI_API_KEY) or a Claude key
(ANTHROPIC_API_KEY). Key stays on this PC (never in the panel or the workbook). The AI only proposes cell writes;
the user previews them and nothing changes until Apply."""
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

import anthropic
from openpyxl.utils import column_index_from_string, get_column_letter
from pydantic import BaseModel, ValidationError

MODEL = "claude-opus-5"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"  # OpenAI-compatible
GEMINI_MODEL = "gemini-3.8-flash"  # free tier, no credit card (aistudio.google.com)
KEY_FILE = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local") / "AnomalyHunter" / "gemini-key.txt"
# John's relay (relay/worker.js): invited users send an invite code there and never hold his Gemini key.
# "" = not deployed yet: invite codes turn nothing on. Set to the Worker's https URL after `npx wrangler deploy`.
RELAY_URL = os.environ.get("ANOMALY_HUNTER_RELAY", "")
INVITE_FILE = KEY_FILE.with_name("invite-code.txt")


def gemini_key():
    return os.environ.get("GEMINI_API_KEY") or (KEY_FILE.read_text(encoding="utf-8").strip() if KEY_FILE.exists() else "")


def invite_code():
    return INVITE_FILE.read_text(encoding="utf-8").strip() if INVITE_FILE.exists() else ""


def provider():
    """Which AI answers: your own free Gemini key first, then John's relay with an invite code, then Claude, else None."""
    return ("gemini" if gemini_key() else "relay" if RELAY_URL and invite_code() else
            "claude" if os.environ.get("ANTHROPIC_API_KEY") else None)


def api_key_configured():
    return provider() is not None


def check_key(key):
    """Ask Google (its models list) whether a pasted key works and may use GEMINI_MODEL -> (ok, words for the pane).
    ok None = Google couldn't be asked (offline): the key is kept and Ask AI will say whether it works."""
    url = GEMINI_URL.rsplit("/chat/completions", 1)[0] + "/models"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"}), timeout=15) as r:
            ids = {str(m.get("id", "")).removeprefix("models/") for m in json.load(r).get("data", [])}
    except urllib.error.HTTPError as e:
        if e.code in (400, 401, 403):
            return False, "Google did not accept this key - copy the whole key again from aistudio.google.com."
        return None, f"Saved. Google answered with error {e.code} while testing it - Ask AI will tell you if it works."
    except (OSError, ValueError, AttributeError):  # offline, timeout, or an answer that isn't the expected list
        return None, "Saved. Couldn't reach Google to test the key - check the internet connection."
    if GEMINI_MODEL not in ids:
        return True, f"Saved - the key works, but it can't use {GEMINI_MODEL}, so Ask AI won't work yet. Tell the developer."
    return True, "Key works. AI help is on."


# ---- Fix one flagged row from a plain-English request. Claude proposes cell writes; the panel shows
# them old -> new and writes nothing until the user clicks Apply (with Undo). ----

MAX_CHANGES = 50
CELL = re.compile(r"[A-Z]{1,3}[1-9][0-9]{0,6}")
REFS = re.compile(r"(?<![A-Z0-9_.!:])\$?([A-Z]{1,3})(?:\$?(\d+))?(?::\$?([A-Z]{1,3})(?:\$?(\d+))?)?(?![A-Z0-9_(!])")


class CellChange(BaseModel):
    cell: str  # A1-style, e.g. "D7"
    new: str  # formula ("=MEDIAN(D2:D45)") or a plain value, entered as if typed


class Fix(BaseModel):
    explanation: str
    changes: list[CellChange]


# formulas that reach outside the workbook - a prompt-injected sheet could use them to send data out.
# "[Book.xlsx]Sheet!" = another workbook ("]" then a sheet name and "!"); Table1[Units] is this workbook's own table
OUTSIDE = re.compile(r"WEBSERVICE|IMAGE\s*\(|HYPERLINK|RTD\s*\(|CALL\s*\(|REGISTER|FILTERXML|://|\][^\[\]]*!|\|", re.IGNORECASE)


def refers_to_itself(cell, text):
    """Would writing `text` into `cell` make a circular reference? (=MEDIAN(C2:C41) or =SUM(C:C) into C11)"""
    if not text.startswith("="):
        return False
    col, row = re.fullmatch(r"([A-Z]+)(\d+)", cell).groups()
    c, r = column_index_from_string(col), int(row)
    for a, r1, b, r2 in REFS.findall(re.sub(r'"[^"]*"', '""', text.upper())):  # ignore "text in quotes"
        if not r1 and not b:
            continue  # a bare word like TRUE or a function name, not a reference
        cols = sorted((column_index_from_string(a), column_index_from_string(b or a)))  # C41:C2 is the same range as C2:C41
        rows_hit = not r1 or min(int(r1), int(r2 or r1)) <= r <= max(int(r1), int(r2 or r1))  # no row = whole column
        if cols[0] <= c <= cols[1] and rows_hit:
            return True
    return False


def _fix_prompt(columns, rows, i, start_row, start_col, reason, intent, formulas=None):
    letters = [get_column_letter(1 + start_col + j) for j in range(len(columns))]
    top = start_row + 1  # 1-based sheet row of the header
    line = lambda k: f"row {top + 1 + k}: " + ", ".join(f"{c}{top + 1 + k}={v!r}" for c, v in zip(letters, rows[k]))
    near = [line(k) for k in range(max(0, i - 5), min(len(rows), i + 6)) if k != i]
    calc = [f"{c}{top + 1 + i} {f}" for c, f in zip(letters, formulas or []) if isinstance(f, str) and f.startswith("=")]
    return (
        "You fix one flagged row in an Excel sheet. Answer with cell writes the user will preview and approve.\n"
        "The user could be in any field - finance, healthcare, supply chain, construction, research... Infer it from "
        "the headers and values and follow that field's conventions and units.\n"
        f"Data range: {letters[0]}{top}:{letters[-1]}{top + len(rows)} (row {top} = headers).\n"
        "Columns: " + ", ".join(f"{c}={h}" for c, h in zip(letters, columns)) + "\n"
        f"Flagged {line(i)}\n"
        + (f"Formulas in that row: {'; '.join(calc)} - fix their inputs rather than overwrite them, unless asked.\n" if calc else "")
        + f"Why it was flagged: {reason or 'unknown'}\n"
        "Nearby rows for context:\n" + "\n".join(near) + "\n\n"
        f"User's request: {intent.strip() or 'Recommend the single best fix for this flagged row.'}\n\n"
        "Rules: each change is one cell (A1 style, e.g. D7) and the exact text to enter in it - an Excel formula "
        "(English function names, comma separators, start with =) or a plain value. Prefer a formula when the value "
        "should follow the data. A formula must never refer to the cell it is written into (circular reference): to put "
        "the median of column D into D7, write =MEDIAN(D2:D6,D8:D45), not =MEDIAN(D2:D45). Write only inside the data range. Change only what the request needs; never overwrite the "
        "header row unless asked. If the request can't be done by writing cells (delete/sort/move rows, VBA), "
        "return no changes and explain the manual steps. 'explanation' = 1-3 plain-English sentences for a "
        "non-expert. Don't claim certainty you don't have.")


def _in_table(cell, start_row, start_col, n_rows, n_cols):
    """Is an A1 cell in the header row or a data row of the table? (a prompt-injected cell can't steer writes elsewhere)"""
    col, row = re.fullmatch(r"([A-Z]+)(\d+)", cell).groups()
    return start_col < column_index_from_string(col) <= start_col + n_cols and start_row < int(row) <= start_row + 1 + n_rows


FIX_SCHEMA = {"type": "object", "required": ["explanation", "changes"], "properties": {
    "explanation": {"type": "string"},
    "changes": {"type": "array", "items": {"type": "object", "required": ["cell", "new"],
                                           "properties": {"cell": {"type": "string"}, "new": {"type": "string"}}}}}}


def _ask(prompt):
    """The prompt -> Fix, from Gemini (free) or Claude. Failures -> ValueError with words a user can act on."""
    if provider() not in ("gemini", "relay"):
        try:
            resp = anthropic.Anthropic().messages.parse(model=MODEL, max_tokens=16000, output_format=Fix,
                                                        messages=[{"role": "user", "content": prompt}])
        except ValidationError:  # answer cut off mid-JSON
            raise ValueError("Claude's answer came back incomplete - try again or shorten the request.") from None
        if resp.parsed_output is None:  # refusal
            raise ValueError(f"Claude gave no usable answer (stop_reason={resp.stop_reason}).")
        return resp.parsed_output
    body = {"model": GEMINI_MODEL, "messages": [{"role": "user", "content": prompt}],
            "response_format": {"type": "json_schema", "json_schema": {"name": "fix", "schema": FIX_SCHEMA}}}
    relay = provider() == "relay"  # same request; the relay adds John's key, picks the model and counts the caps
    req = urllib.request.Request(RELAY_URL.rstrip("/") + "/fix" if relay else GEMINI_URL, json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "Authorization": f"Bearer {invite_code() if relay else gemini_key()}"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            text = json.load(r)["choices"][0]["message"]["content"]
        return Fix.model_validate_json(text)
    except urllib.error.HTTPError as e:
        if relay:  # the relay's own words: invalid code, today's cap reached, Google busy
            try:
                words = json.loads(e.read().decode("utf-8", "replace"))["error"]
            except (ValueError, KeyError, TypeError):
                words = f"The AI relay answered with error {e.code} - try again later."
            raise ValueError(words + (" Ask John for a new invite code." if e.code == 401 else "")) from None
        bad_key = e.code in (401, 403) or (e.code == 400 and "API key" in e.read().decode("utf-8", "replace"))  # Google: 400 "API key not valid"
        raise ValueError("The free Google AI limit is used up for now - try again in a minute. The suggested fix above still works."
                         if e.code == 429 else "Google did not accept the AI key - paste it again under AI help."
                         if bad_key else f"Google doesn't offer the AI model {GEMINI_MODEL} to this key - tell the developer."
                         if e.code == 404 else f"Google AI answered with error {e.code} - try again shortly.") from None
    except OSError:  # no connection, timeout, connection reset mid-answer
        raise ValueError("Could not reach Google AI - check the internet connection.") from None
    except (KeyError, IndexError, TypeError, ValueError):  # no answer, or not the JSON asked for
        raise ValueError("Google AI's answer came back incomplete - try again.") from None


def suggest_fix(columns, rows, row_index, start_row, start_col, reason, intent, formulas=None):
    """-> {explanation, changes: [{cell, new}]}. Invalid cell addresses are dropped. Raises ValueError / anthropic errors."""
    fix = _ask(_fix_prompt(columns, rows, row_index, start_row, start_col, reason, intent, formulas))
    changes = [{"cell": c.cell.strip().replace("$", "").upper(), "new": c.new} for c in fix.changes]
    changes = [c for c in changes if CELL.fullmatch(c["cell"])][:MAX_CHANGES]
    loops = [c["cell"] for c in changes if refers_to_itself(c["cell"], c["new"])]
    outside = [c["cell"] for c in changes if c["new"].lstrip()[:1] in "=+-@" and OUTSIDE.search(c["new"])]
    away = [c["cell"] for c in changes if not _in_table(c["cell"], start_row, start_col, len(rows), len(columns))]
    note = "".join(f" (Left out {', '.join(cells)}: {why}.)" for cells, why in (
        (loops, "the formula referred to its own cell, which Excel can't calculate"), (outside, "the formula reached outside this workbook"),
        (away, "outside the table")) if cells)
    drop = set(loops + outside + away)
    return {"explanation": fix.explanation + note, "changes": [c for c in changes if c["cell"] not in drop]}
