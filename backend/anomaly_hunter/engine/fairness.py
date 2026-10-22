"""Fairness checks (John's Responsible-AI blueprint, 2026-10-14): protected columns are found by their names, kept out of
the "is this person unusual" model, and every scan tests subgroups for gaps - in how often rows are flagged (false
alarms land on one group), in blanks (a model trained on the sheet learns that group less well) and in any yes/no
outcome column (a valid disparity to know about, never a value to "fix"). Advisory only: nothing here changes a cell."""
import re

import numpy as np
import pandas as pd
from scipy.stats import chi2_contingency

from anomaly_hunter.engine.load import PLACEHOLDER

PROXY = "location (can stand in for race or income)"
DEMOGRAPHIC = {"age", "dob", "birth", "birthday", "birthdate", "gender", "sex", "race", "ethnicity", "ethnic", "religion",
               "marital", "nationality", "citizenship", "disability", "disabled", "pregnancy", "pregnant", "veteran"}
LOCATION = {"location", "city", "state", "zip", "zipcode", "postal", "postcode", "country", "region", "neighborhood",
            "neighbourhood", "county"}
MIN_GROUP = 20  # smaller groups prove nothing either way
MAX_TESTS = 400  # each test is a crosstab (~5.6 ms): a crafted 40 x 40 sheet took 9 s per scan (2026-10-16)
ALPHA = 0.01    # after a Bonferroni correction over every test of the scan: noise is not called bias
HINT = 0.05     # a raw p-value this small, not confirmed after the correction: "not enough rows to tell"
RATIO = 1.25    # the four-fifths rule, for a rate where higher is worse (1 / 0.8)


def _words(name):
    """'Marital_Status' -> ['marital', 'status']; 'ZipCode' -> ['zip', 'code']; 'DateOfBirth' -> ['date', 'of', 'birth']"""
    return [w.lower() for w in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", re.sub(r"[^A-Za-z]+", " ", str(name)))]


def protected(columns):
    """{column: why it is protected} for headers naming a demographic, or a location that can stand in for one."""
    out = {}
    for c in columns:
        w = set(_words(c))
        if w & DEMOGRAPHIC:
            out[c] = "demographic"
        elif w & LOCATION:
            out[c] = PROXY
    return out


def _groups(df, col, types):
    """The column's subgroups (label per row, None = left out): its values, or age bands for a number column."""
    s = df[col]
    if types.get(col) == "number":
        x = pd.to_numeric(s, errors="coerce")
        # ages: the usual bands; other numbers: quarters of the column (the top edge open, so the largest value is in)
        edges = [-np.inf, 30, 45, 60, np.inf] if "age" in _words(col) else [*x.quantile([0, .25, .5, .75]).unique(), np.inf]
        if len(edges) < 3:
            return None
        labels = pd.cut(x, edges, right=False, duplicates="drop")  # [30, 45) = "30-44"
        return labels.map(lambda b: None if pd.isna(b) else _band(b))
    if types.get(col) == "text":
        v = _labels(s, 50)  # category-like: groups under 20 rows drop out
        return None if v is None else v.where(v.notna(), None)
    return None


def _labels(s, most):
    """Text cells as their labels, or None past `most` labels. "no " and "NO" are the label "No", written the way the
    column writes it most: one stray "no " among 480 Yes/No made the outcome three labels, and every outcome test
    went away with the real gap in it (2026-10-20). Blank and "?" are no label: a blank is not a kind of person."""
    v = s.astype(str).str.strip().where(~_missing(s))
    if not v.notna().any():  # nothing but blanks: no labels (and no text for .str to work on - the fuzzer's 500)
        return v.astype(object)
    key = v.str.split().str.join(" ").str.casefold()
    if key.nunique() > most:
        return None
    counts = v.value_counts()  # most common first: each label is shown as its most common spelling
    usual = pd.Series(counts.index, index=counts.index.str.split().str.join(" ").str.casefold()).groupby(level=0).first()
    return key.map(usual)


def _band(b):
    lo, hi = b.left, b.right
    if np.isinf(lo):
        return f"under {hi:g}"
    if np.isinf(hi):
        return f"{lo:g} and over"
    return f"{lo:g}-{hi - 1:g}" if float(lo).is_integer() and float(hi).is_integer() else f"{lo:g}-{hi:g}"


# two labels are an outcome unless they say who, where or when: a shift (Day/Night), a hand (Left/Right) or a department
# (A/B) is not a result, and reading one as an outcome put "Gender F: 60% Shift Night - a real gap" in the pane (AH-17).
# A list of outcomes lost real ones (Approved/Declined, Defaulted/Paid, Delinquent/Current: AH-18 review), so only
# these pairs, and one-letter or numbered codes (A/B, Q1/Q2, 2024/2025), are left out.
NOT_OUTCOMES = [{"day", "night"}, {"am", "pm"}, {"morning", "evening"}, {"morning", "afternoon"}, {"weekday", "weekend"},
                {"left", "right"}, {"north", "south"}, {"east", "west"}, {"urban", "rural"}, {"indoor", "outdoor"},
                {"inside", "outside"}, {"inbound", "outbound"}, {"internal", "external"}, {"domestic", "international"},
                {"online", "offline"}, {"front", "back"}, {"upper", "lower"}, {"before", "after"}, {"old", "new"}]


def _is_outcome(a, b):
    """Two labels (casefolded) that can be a result: anything but a who/where/when pair or a code."""
    if {a, b} in NOT_OUTCOMES:
        return False
    if len(a) == 1 and len(b) == 1 and a.isalpha() and b.isalpha() and {a, b} not in ({"y", "n"}, {"t", "f"}):
        return False  # A/B, X/Y: codes
    digits = lambda w: any(ch.isdigit() for ch in w)
    if digits(a) and digits(b) and {a, b} != {"0", "1"} and not (a[:1] in "<>≤≥=" or b[:1] in "<>≤≥="):
        return False  # Q1/Q2, 2024/2025, Grade 3/Grade 4; "<=50K"/">50K" is a result
    return True


def _polarity(label):
    """+1 when a counted label is the higher or yes side (">50K", "Yes", "1"), -1 when it is the lower or no side, 0 unsure."""
    w = str(label).strip().casefold()
    if w.startswith((">", "≥")) or w in ("= 1", "yes", "y", "true", "high", "over", "above"):
        return 1
    if w.startswith(("<", "≤")) or w in ("= 0", "no", "n", "false", "low", "under", "below"):
        return -1
    return 0


def _outcomes(df, types, skip):
    """Yes/no columns that are not protected -> {test name: (rate of the "yes" per row, what "yes" is in words, the column,
    the counted label)}: 0/1 numbers (delinquent, defaulted, churned), and text with exactly two labels that can be a
    result (_is_outcome; census income "<=50K" / ">50K": the rarer label is the one counted)."""
    out = {}
    for c, t in types.items():
        if c in skip:
            continue
        if t == "number":
            x = pd.to_numeric(df[c], errors="coerce")
            if x.notna().any() and set(x.dropna().unique()) == {0, 1}:
                out[f"{c} rate"] = (x.eq(1).where(x.notna()), f"{c} = 1", c, "= 1")
        elif t == "text":
            v = _labels(df[c], 2)
            counts = v.value_counts() if v is not None else ()
            if len(counts) == 2 and _is_outcome(*(str(k).casefold() for k in counts.index)):
                yes = counts.index[-1]
                out[f"{c} {yes} rate"] = (v.eq(yes).where(v.notna()), f"{c} {yes}", c, yes)
    return out


def _missing(s):
    """Blank, or a stand-in for blank ("?", "N/A", "unknown"): census rows give "?" for an unknown occupation."""
    v = s.astype(str).str.strip()
    return s.isna() | (v == "") | v.str.fullmatch(PLACEHOLDER)


# "Race" in "Race Time" or "Race Number" is a running race, and "State" in "Order State" is a status, not a place: both
# were read as people (AH-17 bias hunt). The words that make a header about the thing, not the person:
NOT_PEOPLE = {"race": {"time", "times", "pace", "distance", "lap", "laps", "split", "splits", "finish", "position", "rank", "result",
                       "results", "entry", "course", "track", "number", "no", "id", "date", "day", "name", "type", "series", "event"},
              "state": {"order", "ticket", "account", "task", "job", "payment", "shipment", "delivery", "approval", "workflow",
                        "process", "machine", "item", "invoice", "case", "request", "subscription", "build", "run"}}
# ...and an unnamed "State" whose labels are all steps of a process (Pending, Shipped) is a status too
STATUS = {"pending", "open", "closed", "shipped", "delivered", "returned", "cancelled", "canceled", "active", "inactive", "done",
          "new", "in progress", "approved", "rejected", "paid", "unpaid", "draft", "complete", "completed", "failed", "processing",
          "on hold", "refunded", "submitted", "resolved", "archived"}


def _people(df, types):
    """protected() for the fairness report: the columns that are about people, read from their names and, for an
    ambiguous "State", its labels. Only the report uses this: the AI's context (bias_context.rules_for) and the
    detectors keep protected(), unchanged until their own measurements say otherwise (CLAUDE.md)."""
    out = {}
    for c, why in protected(types).items():
        if c not in df.columns:
            continue
        w = _words(c)
        if any(k in w and set(w) & NOT_PEOPLE[k] for k in NOT_PEOPLE):
            continue
        if "state" in w and types.get(c) == "text":
            labels = set(df[c].astype(str).str.strip().str.casefold()[~_missing(df[c])])
            if labels and labels <= STATUS:
                continue
        out[c] = why
    return out


def _pct(r):
    """A rate in words: one decimal under 10% ("1.2% vs 0.4%" read "1% vs 0%", AH-18 review)."""
    return f"{r:.1%}" if r < 0.1 else f"{r:.0%}"


def _either(a, b):
    """_big on the counted side or on the other one: Approved = 1 at 89% vs 74% is 11% vs 26% not approved, and the same
    people written Approved/Denied (Denied counted) read a gap while the 0/1 column read "small" (AH-18 review)."""
    return _big(max(a, b), min(a, b)) or _big(1 - min(a, b), 1 - max(a, b))


def _big(hi, lo):
    """A gap worth naming: the higher rate is 1.25x the lower (the four-fifths rule) and 5 points above it, or at least
    twice it. A doubling counts at any size: 2% vs 4% defaults on 20,000 people (p ~ 0) read "close across groups"
    (AH-17 bias hunt)."""
    return hi >= RATIO * lo and (hi - lo >= 0.05 or hi >= 2 * lo)


def _named(groups):
    return ", ".join(f"{k} ({n} row{'' if n == 1 else 's'})" for k, n in groups.items())


def report(df, types, rows):
    """{protected: {col: why}, tests: [{column, test, measure, groups: {label: [rows, rate]}, p, verdict, text, context?}]}.
    verdict "gap" = the group that stands out differs from the rest by _big AND significantly (Bonferroni over every test
    of the scan); "even" = a small difference, or a real but small one; "unclear" = a big difference too few rows can
    prove, or groups too small to compare. With 3+ groups the group named is the one that stands out against the rest
    of the rows (its own 2x2 p-value, p_group, Bonferroni over the groups too), never the lowest group: with 40 countries
    the lowest is an ordinary one that happened to land low. Groups under MIN_GROUP rows are named as left out.
    context = one sentence of measured public context (ai/bias_rules.json), only when the rule measured this outcome and
    the sheet's gap runs the same way. Never on a flag-rate gap: that one is ours."""
    from anomaly_hunter.ai.bias_context import pane_note_matching  # here, not at the top: bias_context reads this module's words
    prot = _people(df, types)
    flagged = pd.Series([r["severity"] in ("High", "Medium", "Low") for r in rows], index=df.index)
    missing = {c: _missing(df[c]) for c in df.columns if c not in prot}
    blanks = {f"missing {c}": (b, f"missing {c}", c, "missing") for c, b in missing.items() if b.sum() >= 5}
    outcomes = _outcomes(df, types, prot)
    measures = {"flag rate": (flagged, "rows flagged", None, None), **blanks, **outcomes}
    kinds = {name: "outcome" if name in outcomes else "missing" if name in blanks else "flag" for name in measures}
    tests, left = [], MAX_TESTS
    for col, why in prot.items():
        g = _groups(df, col, types)
        if g is None:
            continue
        for name, (hit, what, subject, label) in list(measures.items())[:left]:
            left -= 1
            ok = g.notna() & hit.notna()
            table = pd.crosstab(g[ok], hit[ok].astype(bool))
            small = {str(k): int(n) for k, n in table.sum(axis=1).items() if n < MIN_GROUP}
            table = table[table.sum(axis=1) >= MIN_GROUP]
            base = {"column": col, "kind": why, "test": name, "measure": kinds[name], "subject": subject, "label": label}
            if len(table) < 2 and len(table) + len(small) >= 2 and hit[ok].any():  # every group, or all but one, too small
                tests.append({**base, "p": None, "groups": {}, "small": small})
                continue
            # every group the same (none hit, or all): nothing to test, and chi-square raises on it - Cars93's missing
            # values all sat in groups under 20 rows, and every scan of it was a 500 (blind real tables, 2026-10-16)
            if len(table) < 2 or table.shape[1] < 2 or (table.sum(axis=0) == 0).any():
                continue
            rates = table[True] / table.sum(axis=1)
            tests.append({**base, "p": float(chi2_contingency(table)[1]), "small": small,
                          "groups": {str(k): [int(table.loc[k].sum()), round(float(v), 4)] for k, v in rates.items()}, "table": table})
    n = sum(t["p"] is not None for t in tests)
    for t in tests:
        what = measures[t["test"]][1]
        subject, label, table, small = t.pop("subject"), t.pop("label"), t.pop("table", None), t.pop("small")
        out = f"; too few to compare: {_named(small)}" if small else ""
        if t["p"] is None:
            t["verdict"], t["text"] = "unclear", f"{t['column']}: {what} - too few rows to compare: {_named(small)}"
            continue
        rates = {k: v[1] for k, v in t["groups"].items()}
        span = f"{_pct(min(rates.values()))} to {_pct(max(rates.values()))}"
        if len(rates) == 2:
            hi, lo = max(rates, key=rates.get), min(rates, key=rates.get)
            a, b = rates[hi], rates[lo]
            real, hint = t["p"] * n < ALPHA, t["p"] < HINT
            said = f"{t['column']} {hi}: {_pct(a)} {what} vs {_pct(b)} for {lo}"
        else:  # the group that stands out against all the others, and any that stand out with it the same way
            pairs, K = {}, len(table)
            for k in table.index:
                two = pd.DataFrame([table.loc[k], table.drop(k).sum()])
                pairs[str(k)] = (float(chi2_contingency(two)[1]), float(two.iloc[1][True] / two.iloc[1].sum()))
            sides = {+1: [k for k in pairs if rates[k] > pairs[k][1] and pairs[k][0] * n * K < ALPHA],
                     -1: [k for k in pairs if rates[k] < pairs[k][1] and pairs[k][0] * n * K < ALPHA]}
            best = min(pairs, key=lambda x: (pairs[x][0], -abs(rates[x] - pairs[x][1])))
            # 2 high and 2 low regions: the smaller set is named, the high one on a tie ("N: 40% vs 26%" read as if N
            # alone stood out, AH-18 review)
            side = min((s for s in sides if sides[s]), key=lambda s: (len(sides[s]), -s), default=None)
            names = [k for k in map(str, table.index) if k in sides[side]] if side else [best]
            mine = table.loc[[k for k in table.index if str(k) in names]].sum()
            rest = table.loc[[k for k in table.index if str(k) not in names]].sum()
            p_k = float(chi2_contingency(pd.DataFrame([mine, rest]))[1])
            t["p_group"] = p_k
            a, b = float(mine[True] / mine.sum()), float(rest[True] / rest.sum())
            real = t["p"] * n < ALPHA and p_k * n * K < ALPHA
            hint = t["p"] < HINT and p_k * K < HINT  # picking the group that stands out is itself a choice among K
            said = f"{t['column']} {' and '.join(names)}: {_pct(a)} {what} vs {_pct(b)} for the other groups"
        big = _either(a, b)
        # "not enough rows to tell" only where the raw evidence points to a gap (raw p < HINT) that the correction for
        # testing many things at once cannot confirm; where chance explains the spread, it is within normal variation
        # (pure noise read "not enough rows to tell" in 13 of 20 sheets with 40 groups, AH-18 review)
        t["verdict"] = "gap" if big and real else "unclear" if big and hint and not real else "even"
        t["text"] = (f"{said} - a real gap, check why" if t["verdict"] == "gap"
                     else f"{t['column']}: {what} close across groups ({span} - a real difference, but small)" if real
                     else f"{t['column']}: {what} differs across groups ({span}), but there are not enough rows to tell whether that is a real gap"
                     if t["verdict"] == "unclear" else f"{t['column']}: {what} {'no clear difference' if big else 'even'} across groups ({span}, within normal variation)") + out
        note = pane_note_matching(t["column"], t["measure"], subject, _polarity(label) if t["measure"] == "outcome" else 1,
                                  t["groups"]) if t["verdict"] == "gap" else None
        if note:
            t["context"] = note
    return {"protected": prot, "tests": tests}
