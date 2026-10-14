"""Fairness checks (John's Responsible-AI blueprint, 2026-10-14): protected columns are found by their names, kept out of
the "is this person unusual" model, and every scan tests subgroups for gaps - in how often rows are flagged (false
alarms land on one group), in blanks (a model trained on the sheet learns that group less well) and in any yes/no
outcome column (a valid disparity to know about, never a value to "fix"). Advisory only: nothing here changes a cell."""
import re

import numpy as np
import pandas as pd
from scipy.stats import chi2_contingency

PROXY = "location (can stand in for race or income)"
DEMOGRAPHIC = {"age", "dob", "birth", "birthday", "birthdate", "gender", "sex", "race", "ethnicity", "ethnic", "religion",
               "marital", "nationality", "citizenship", "disability", "disabled", "pregnancy", "pregnant", "veteran"}
LOCATION = {"location", "city", "state", "zip", "zipcode", "postal", "postcode", "country", "region", "neighborhood",
            "neighbourhood", "county"}
MIN_GROUP = 20  # smaller groups prove nothing either way
ALPHA = 0.01    # after a Bonferroni correction over every test of the scan: noise is not called bias
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
        v = s.astype(str).str.strip()
        return v.where(v != "", None) if v[v != ""].nunique() <= 20 else None
    return None


def _band(b):
    lo, hi = b.left, b.right
    if np.isinf(lo):
        return f"under {hi:g}"
    if np.isinf(hi):
        return f"{lo:g} and over"
    return f"{lo:g}-{hi - 1:g}" if float(lo).is_integer() and float(hi).is_integer() else f"{lo:g}-{hi:g}"


def _outcomes(df, types, skip):
    """Yes/no columns (only 0 and 1, both present) that are not protected: delinquent, defaulted, churned..."""
    out = {}
    for c, t in types.items():
        if c in skip or t != "number":
            continue
        x = pd.to_numeric(df[c], errors="coerce").dropna()
        if len(x) and set(x.unique()) == {0, 1}:
            out[c] = x.reindex(df.index)
    return out


def report(df, types, rows):
    """{protected: {col: why}, tests: [{column, test, groups: {label: [rows, rate]}, p, verdict, text}]}.
    verdict "gap" = one subgroup's rate is 1.25x another's (four-fifths rule) AND the difference is significant."""
    prot = {c: why for c, why in protected(types).items() if c in df.columns}
    flagged = pd.Series([r["severity"] in ("High", "Medium", "Low") for r in rows], index=df.index)
    blanks = {c: df[c].isna() | (df[c].astype(str).str.strip() == "") for c in df.columns if c not in prot}
    measures = {"flag rate": flagged, **{f"blank {c}": b for c, b in blanks.items() if b.sum() >= 5},
                **{f"{c} rate": v.eq(1).where(v.notna()) for c, v in _outcomes(df, types, prot).items()}}
    tests = []
    for col, why in prot.items():
        g = _groups(df, col, types)
        if g is None:
            continue
        for name, hit in measures.items():
            ok = g.notna() & hit.notna()
            table = pd.crosstab(g[ok], hit[ok].astype(bool))
            table = table[table.sum(axis=1) >= MIN_GROUP]
            if len(table) < 2 or table.shape[1] < 2:
                continue
            rates = table[True] / table.sum(axis=1)
            tests.append({"column": col, "kind": why, "test": name, "p": float(chi2_contingency(table)[1]),
                          "groups": {str(k): [int(table.loc[k].sum()), round(float(v), 4)] for k, v in rates.items()}})
    for t in tests:
        rates = {k: v[1] for k, v in t["groups"].items()}
        hi, lo = max(rates, key=rates.get), min(rates, key=rates.get)
        big = rates[hi] >= RATIO * rates[lo] and rates[hi] - rates[lo] >= 0.05
        t["verdict"] = "gap" if big and t["p"] * len(tests) < ALPHA else "even"
        what = "rows flagged" if t["test"] == "flag rate" else t["test"] if t["test"].startswith("blank ") else t["test"][:-5] + " = 1"
        t["text"] = (f"{t['column']} {hi}: {rates[hi]:.0%} {what} vs {rates[lo]:.0%} for {lo} - a real gap, check why"
                     if t["verdict"] == "gap" else
                     f"{t['column']}: {what} even across groups ({rates[lo]:.0%} to {rates[hi]:.0%}, within normal variation)")
    return {"protected": prot, "tests": tests}
