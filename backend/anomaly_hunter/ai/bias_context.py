"""Real-world context for the AI fix and the fairness report (John, 2026-10-20): both knew nothing about what real group
differences look like, so a real gap could pass for a data error, or a fix could be pulled toward a group's average.
Rule-based, no model: the rules are measured from pinned public tables by tools/bias_sources.py into bias_rules.json
(docs/bias/FINDINGS.md). They describe real gaps so they are not mistaken for typos; they are never expectations to
correct a value toward. Every line comes from our own file, never from the sheet: sheet text (headers, the reason)
only picks which of our lines apply."""
import json
from functools import cache
from pathlib import Path

from anomaly_hunter.engine.fairness import _words, protected

RULES = Path(__file__).with_name("bias_rules.json")
# a policy, not a measurement: always the first line, never trimmed, even if the rules file is missing
PROTECT = ("Never propose a value derived from a person's group (sex, race, age, religion, marital status and the like): "
           "a fix may come only from the row's own arithmetic, a clear typing slip, or the user's own request; a value "
           "that is unusual for its group is not an error for that reason.")
HEAD = "Real-world notes (this add-in's own measured rules, not from the sheet):"
MAX_LINES = 6  # the protective rule and up to 5 measured ones
MAX_BYTES = 1500  # of the notes block: the table rows are the evidence, these are background


@cache
def _load():
    """The rules file, or no rules: a missing or broken file costs the context, never the scan or the fix."""
    try:
        data = json.loads(RULES.read_text(encoding="utf-8"))
        return {str(t): {str(w) for w in ws} for t, ws in data["topics"].items()}, [r for r in data["rules"] if isinstance(r, dict)]
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return {}, []


def _topics(column):
    topics, _ = _load()
    w = set(_words(column))
    return {t for t, ws in topics.items() if w & ws}


def rules_for(columns, reason=""):
    """The lines for a sheet with these headers and a row flagged for `reason`: [] unless a column names a demographic
    (fairness.protected; a location alone is a sales sheet as often as a people sheet), else the protective rule first,
    then the rules for the flagged column's topic, the rules about values far from their group, the other topics the
    sheet has (amounts first: most flags are about an amount), and the hygiene rules ('?', label spellings, top
    codes) - as many as fit MAX_LINES and MAX_BYTES."""
    cols = [str(c) for c in columns]
    if "demographic" not in protected(cols).values():
        return []
    _, rules = _load()
    present = set().union(*(_topics(c) for c in cols))
    said = _topics(" ".join(str(reason or "").split()))  # the topics the reason names (it names the flagged column)
    kind = {"spread": 0, "outcome": 1, "missing": 2}
    rank = lambda r: ((0, 0) if r.get("topic") in said else (1, 0) if r.get("kind") == "far"
                      else (2, kind.get(r.get("kind"), 3)) if r.get("topic") in present else (3, 0))
    picked = [r for r in rules if r.get("topic") in present or r.get("topic") == "any"]
    out, size = [PROTECT], len(PROTECT.encode())
    for r in sorted(picked, key=rank):  # stable: the file's order within a rank
        line = " ".join(str(r.get("text", "")).splitlines())  # one line each
        if line and len(out) < MAX_LINES and size + len(line.encode()) <= MAX_BYTES:
            out.append(line)
            size += len(line.encode())
    return out


def block(lines):
    """The notes as they go into the prompt: a head line, then one line per rule."""
    return HEAD + "\n" + "".join(f"- {line}\n" for line in lines) if lines else ""


def with_rules(build, fits, on=True):
    """A fix-prompt builder (client._fix_prompt) that adds the notes after the flagged row and its reason. If the request
    is too big, the measured rules go first, last-ranked first; the protective rule stays, and only then does the caller
    (client.suggest_fix) drop rows and columns - the rows are the evidence, the notes are background. on=False = the
    builder unchanged, so the app's prompt stays byte-for-byte what was measured until ai_eval.py says otherwise."""
    if not on:
        return build

    def fix_prompt(columns, rows, i, start_row, start_col, reason, intent, *a, **k):
        lines = rules_for(columns, reason)
        for n in range(len(lines), 0, -1):
            prompt = build(columns, rows, i, start_row, start_col, reason, intent, *a, **k, notes=block(lines[:n]))
            if n == 1 or fits(prompt):
                return prompt
        return build(columns, rows, i, start_row, start_col, reason, intent, *a, **k)
    return fix_prompt


def pane_note(column, kind):
    """One plain sentence of public context for a fairness gap on `column` (kind "outcome" or "missing"), or None."""
    topics = _topics(column)
    return next((str(r["pane"]) for r in _load()[1] if r.get("pane_for") == kind and r.get("topic") in topics and r.get("pane")), None)
