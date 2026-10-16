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
# a postal code names a place whatever the loader made of it: "Zip Code" loads as an ID, "ZipCode" as a number
POSTAL = {"zip", "zipcode", "postal", "postcode"}
LOCATION = {"location", "city", "state", "country", "region", "neighborhood", "neighbourhood", "county"} | POSTAL
MIN_GROUP = 20  # smaller groups prove nothing either way
MAX_TESTS = 400  # each test is a crosstab (~5.6 ms): a crafted 40 x 40 sheet took 9 s per scan (2026-10-16)
ALPHA = 0.01    # after a Bonferroni correction over every test of the scan: noise is not called bias
RATIO = 1.25    # the four-fifths rule, for a rate where higher is worse (1 / 0.8)


def _words(name):
    """'Marital_Status' -> ['marital', 'status']; 'ZipCode' -> ['zip', 'code']; 'DateOfBirth' -> ['date', 'of', 'birth']"""
    return [w.lower() for w in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", re.sub(r"[^A-Za-z]+", " ", str(name)))]


def protected(types):
    """{column: why it is protected} for headers naming a demographic, or a location that can stand in for one."""
    out = {}
    for c, t in types.items():
        w = set(_words(c))
        if w & DEMOGRAPHIC:
            out[c] = "demographic"
        # a place is text or a code: MASS Cars93's "MPG.city" (miles per gallon) was banded into quarters and bias-tested
        # as a location (blind real tables, 2026-10-16)
        elif w & POSTAL or (w & LOCATION and t in ("text", "id")):
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
        v = s.astype(str).str.strip().where(~_missing(s))  # "?" is no group: a blank is not a kind of person
        return v.where(v.notna(), None) if v.nunique() <= 50 else None  # category-like: groups under 20 rows drop out
    return None


def _band(b):
    lo, hi = b.left, b.right
    if np.isinf(lo):
        return f"under {hi:g}"
    if np.isinf(hi):
        return f"{lo:g} and over"
    return f"{lo:g}-{hi - 1:g}" if float(lo).is_integer() and float(hi).is_integer() else f"{lo:g}-{hi:g}"


def _outcomes(df, types, skip):
    """Yes/no columns that are not protected -> {test name: (rate of the "yes" per row, what "yes" is in words)}: 0/1
    numbers (delinquent, defaulted, churned), and text with exactly two labels (census income "<=50K" / ">50K": the
    rarer label is the one counted)."""
    out = {}
    for c, t in types.items():
        if c in skip:
            continue
        if t == "number":
            x = pd.to_numeric(df[c], errors="coerce")
            if x.notna().any() and set(x.dropna().unique()) == {0, 1}:
                out[f"{c} rate"] = (x.eq(1).where(x.notna()), f"{c} = 1")
        elif t == "text":
            v = df[c].astype(str).str.strip().where(~_missing(df[c]))
            counts = v.value_counts()
            if len(counts) == 2:
                yes = counts.index[-1]
                out[f"{c} {yes} rate"] = (v.eq(yes).where(v.notna()), f"{c} {yes}")
    return out


def _missing(s):
    """Blank, or a stand-in for blank ("?", "N/A", "unknown"): census rows give "?" for an unknown occupation."""
    v = s.astype(str).str.strip()
    return s.isna() | (v == "") | v.str.fullmatch(PLACEHOLDER)


def report(df, types, rows):
    """{protected: {col: why}, tests: [{column, test, groups: {label: [rows, rate]}, p, verdict, text}]}.
    verdict "gap" = one subgroup's rate is 1.25x another's (four-fifths rule) AND the difference is significant."""
    prot = {c: why for c, why in protected(types).items() if c in df.columns}
    flagged = pd.Series([r["severity"] in ("High", "Medium", "Low") for r in rows], index=df.index)
    missing = {c: _missing(df[c]) for c in df.columns if c not in prot}
    measures = {"flag rate": (flagged, "rows flagged"),
                **{f"missing {c}": (b, f"missing {c}") for c, b in missing.items() if b.sum() >= 5},
                **_outcomes(df, types, prot)}
    tests, left = [], MAX_TESTS
    for col, why in prot.items():
        g = _groups(df, col, types)
        if g is None:
            continue
        for name, (hit, what) in list(measures.items())[:left]:
            left -= 1
            ok = g.notna() & hit.notna()
            table = pd.crosstab(g[ok], hit[ok].astype(bool))
            table = table[table.sum(axis=1) >= MIN_GROUP]
            # every group the same (none hit, or all): nothing to test, and chi-square raises on it - Cars93's missing
            # values all sat in groups under 20 rows, and every scan of it was a 500 (blind real tables, 2026-10-16)
            if len(table) < 2 or table.shape[1] < 2 or (table.sum(axis=0) == 0).any():
                continue
            rates = table[True] / table.sum(axis=1)
            tests.append({"column": col, "kind": why, "test": name, "what": what, "p": float(chi2_contingency(table)[1]),
                          "groups": {str(k): [int(table.loc[k].sum()), round(float(v), 4)] for k, v in rates.items()}})
    for t in tests:
        rates, what = {k: v[1] for k, v in t["groups"].items()}, t.pop("what")
        hi, lo = max(rates, key=rates.get), min(rates, key=rates.get)
        big, real = rates[hi] >= RATIO * rates[lo] and rates[hi] - rates[lo] >= 0.05, t["p"] * len(tests) < ALPHA
        t["verdict"] = "gap" if big and real else "even"
        span = f"{rates[lo]:.0%} to {rates[hi]:.0%}"
        t["text"] = (f"{t['column']} {hi}: {rates[hi]:.0%} {what} vs {rates[lo]:.0%} for {lo} - a real gap, check why" if big and real
                     else f"{t['column']}: {what} close across groups ({span} - a real difference, but small)" if real
                     else f"{t['column']}: {what} even across groups ({span}, within normal variation)")
    return {"protected": prot, "tests": tests}
