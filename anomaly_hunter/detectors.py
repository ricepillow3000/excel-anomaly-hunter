"""Robust cutoff + three detectors. Each returns {ran, sit_out_reason, votes, magnitude, reasons}."""
import numpy as np
import pandas as pd
from pyod.models.ecod import ECOD

from anomaly_hunter.load import numbers

K = 6  # vote when |score - median| > K * spread


def spread(v):
    """Robust spread: 1.4826*MAD, else 1.2533*mean abs dev, else 0."""
    v = np.asarray(v, dtype=float)
    v = v[~np.isnan(v)]
    if not len(v):
        return 0.0
    d = np.abs(v - np.median(v))
    if np.median(d) > 0:
        return 1.4826 * np.median(d)
    return 1.2533 * d.mean() if d.mean() > 0 else 0.0


def robust_vote(scores, k=K):
    """(votes, magnitude). NaN never votes. Constant series never votes."""
    s = np.asarray(scores, dtype=float)
    ok = ~np.isnan(s)
    sd = spread(s)
    if not ok.any() or sd == 0:
        return np.zeros(len(s), bool), np.zeros(len(s))
    dist = np.where(ok, np.abs(s - np.median(s[ok])) / sd, 0.0)
    return ok & (dist > k), dist


def _result(n, why=None):
    return {"ran": why is None, "sit_out_reason": why, "votes": np.zeros(n, bool),
            "magnitude": np.zeros(n), "reasons": [[] for _ in range(n)]}


def _crossed(v, lo, hi):
    """Limit v crosses, else None. None bound = no limit that side."""
    if lo is not None and v < lo:
        return lo
    if hi is not None and v > hi:
        return hi
    return None


BEYOND = 4  # a typo sits this many times past every other value in the column


def column_stats(x):
    """What likely_value needs about a column, computed once: sorted |non-zero values|, their log median, signs."""
    x = x[~np.isnan(x)]
    mags = np.sort(np.abs(x[x != 0]))
    return {"n": len(x), "nonneg": int((x >= 0).sum()), "mags": mags, "logmed": np.median(np.log10(mags)) if len(mags) else 0.0,
            "whole": bool((x == np.round(x)).mean() >= 0.95)}


def likely_value(v, st, lo, hi):
    """The typo behind v, if one is obvious: extra/missing 0s (x10^k, |k|<=3: % typed as 85 for 0.85, g for kg)
    or a flipped sign - one slip, not both - landing inside the baseline [lo, hi]. None when unsure. Never "corrects"
    a value that is merely the biggest of a wide column: v must be >= BEYOND times past every other value."""
    mags = st["mags"]
    if lo is None or hi is None or v == 0 or len(mags) < 2:
        return None
    m = abs(v)
    k = int(round(np.log10(m) - st["logmed"]))
    if k > 0:  # the biggest / smallest of the OTHER values
        far = m >= BEYOND * (mags[-2] if mags[-1] == m else mags[-1])
    else:
        far = m * BEYOND <= (mags[1] if mags[0] == m else mags[0])
    flip = v < 0 and st["nonneg"] >= 0.95 * (st["n"] - 1)  # sign flip only where negatives are rare (v itself is one)
    for c in ([v / 10 ** k] if 1 <= abs(k) <= 3 and far else []) + ([-v] if flip else []):
        if lo <= c <= hi and (c == round(c) or not st["whole"]):  # 999 in a 1-5 count column is not "likely 0.999"
            return float(f"{c:.10g}")
    return None


def _sentinel(v):
    """0, -1 and all-9 numbers (99, -999, 9999.0): what people type for "missing"."""
    return v in (0, -1) or (v == int(v) and abs(v) >= 99 and set(str(int(abs(v)))) == {"9"})


def limits_detector(df, column_types, limits):
    """Weird-limit breach = vote. Baseline-only breach = noted, no vote. likely[i] = {col: probable typo fix}."""
    n = len(df)
    r = {**_result(n), "noted": np.zeros(n, bool), "noted_reasons": [[] for _ in range(n)], "likely": [{} for _ in range(n)]}
    for col in numbers(column_types):
        if not limits.get(col):
            continue
        b_lo, b_hi, w_lo, w_hi = limits[col]
        x = df[col].to_numpy(dtype=float)
        sd, st = spread(x) or 1.0, None  # st: column_stats, built on the first breach only
        # a value repeated in >= 0.1% of rows (and 5+ times) is a tariff/category (JFK rate code 2, the 5.76 toll),
        # not a typo: noted, never weird. Except "missing" codes, which repeat too: 0, -1, 99, 999, 9999...
        vals, cnt = np.unique(x[~np.isnan(x)], return_counts=True)
        common = {v for v in vals[cnt >= max(5, 0.001 * len(x))] if not _sentinel(v)}
        for i, v in enumerate(x):
            if np.isnan(v):
                continue
            if v not in common and (lim := _crossed(v, w_lo, w_hi)) is not None:
                r["votes"][i] = True
                r["magnitude"][i] = max(r["magnitude"][i], abs(v - lim) / sd)
                fix = likely_value(v, st := st or column_stats(x), b_lo, b_hi)
                if fix is not None:
                    r["likely"][i][col] = fix
                r["reasons"][i].append(f"{col} weird limit is {lim:g}; this is {v:g}" + (f" (likely {fix:g})" if fix is not None else ""))
            elif (lim := _crossed(v, b_lo, b_hi)) is not None:
                r["noted"][i] = True
                r["noted_reasons"][i].append(f"{col} baseline limit is {lim:g}; this is {v:g}")
    return r


def sequence_detector(df, column_types, order_by=None):
    """Rows sorted by order column. Vote on spikes vs rolling-median trend and on 1st/2nd/3rd differences."""
    n = len(df)
    by = order_by or next((c for c, t in column_types.items() if t == "date"), None)
    if by is None:
        return _result(n, "no order column")
    if n < 30:
        return _result(n, "fewer than 30 rows")
    # many rows per date = transactions (100k taxi trips: 94% of its votes were false alarms), not one series
    if df[by].nunique() < 0.5 * df[by].notna().sum():
        return _result(n, f"not a time series (many rows share each {by})")
    r, order = _result(n), df[by]
    idx = order.sort_values(kind="mergesort").index.to_numpy()
    # a series is evenly spaced (order 1..n, days, months 28-31): 70% of steps within 10% of the usual step.
    # Timestamped trips (unique seconds) pass the gate above but arrive at random gaps.
    gap = order.sort_values().diff().dropna()
    gap = gap.dt.total_seconds() if gap.dtype.kind == "m" else gap.astype(float)
    if (abs(gap - gap.median()) <= 0.1 * gap.median()).mean() < 0.7:
        return _result(n, f"not a time series ({by} is not evenly spaced)")

    def hit(pos, mag, what):
        i = idx[pos]
        r["votes"][i] = True
        r["magnitude"][i] = max(r["magnitude"][i], mag)
        if (why := f"{what} near {order.iloc[i]}") not in r["reasons"][i]:
            r["reasons"][i].append(why)

    for col in numbers(column_types):
        s = pd.Series(df[col].to_numpy(dtype=float)[idx])
        v = s.dropna()
        if len(v) and (v >= 0).mean() >= 0.95 and (v == 0).mean() >= 0.05:  # weekend / closed-day zeros are not spikes
            s = s.where(s != 0)
        trend = (s - s.rolling(7, center=True, min_periods=1).median()).to_numpy()
        votes, mag = robust_vote(trend)
        for p in np.where(votes)[0]:
            hit(p, mag[p], f"{col} is unusual relative to its local trend")
        d = s
        for k in (1, 2, 3):
            d = d.diff()
            votes, mag = robust_vote(d.to_numpy())
            for p in np.where(votes)[0]:
                # blame biggest trend gap in last 4 rows, not the diff's own row
                w = trend[max(0, p - 3):p + 1]
                b = p if np.isnan(w).all() else max(0, p - 3) + int(np.nanargmax(np.abs(w)))
                hit(b, mag[p], f"{col} jumped sharply")  # 1st/2nd/3rd differences see the same jump: one reason
    return r


def _scaled(df, cols):
    """Median-fill NaN, then (x - median) / spread per column."""
    out = {}
    for c in cols:
        x = df[c].to_numpy(dtype=float)
        med = np.nanmedian(x) if (~np.isnan(x)).any() else 0.0
        out[c] = (np.where(np.isnan(x), med, x) - med) / (spread(x) or 1.0)
    return pd.DataFrame(out)


def _skip(n, cols):
    return "fewer than 30 rows" if n < 30 else None if cols else "no numeric columns"


def isolation_detector(df, column_types):
    """ECOD outlier score on scaled numbers."""
    n, cols = len(df), numbers(column_types)
    if why := _skip(n, cols):
        return _result(n, why)
    x = _scaled(df, cols)
    votes, mag = robust_vote(ECOD().fit(x.to_numpy()).decision_scores_)
    worst = x.abs().to_numpy().argmax(axis=1)
    reasons = [[f"Unusual combination of values, mainly {cols[w]}"] if v else [] for v, w in zip(votes, worst)]
    return {**_result(n), "votes": votes, "magnitude": mag, "reasons": reasons}

