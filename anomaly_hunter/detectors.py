"""Robust cutoff + four detectors. Each returns {ran, sit_out_reason, votes, magnitude, reasons}."""
import numpy as np
import pandas as pd
from pyod.models.ecod import ECOD
from sklearn.cluster import DBSCAN
from sklearn.neighbors import NearestNeighbors

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
        for i, v in enumerate(x):
            if np.isnan(v):
                continue
            if (lim := _crossed(v, w_lo, w_hi)) is not None:
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
    r, order = _result(n), df[by]
    idx = order.sort_values(kind="mergesort").index.to_numpy()

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


MAX_DISTINCT = 100_000  # above this, grouping alone takes ~20s+ and GBs: it sits out and says why


def clustering_detector(df, column_types):
    """DBSCAN noise rows. eps = robust cutoff on k-th neighbor distance."""
    n, cols = len(df), numbers(column_types)
    if why := _skip(n, cols):
        return _result(n, why)
    x = _scaled(df, cols).to_numpy()
    ms = max(5, 2 * len(cols))
    # Same answer, once per DISTINCT row: real sheets repeat values (107 patterns in 10k sales rows) and DBSCAN on the
    # copies grows with rows squared (200k rows: 9 GB, never finished). Each pattern weighs as many rows as share it.
    xu, inv, cnt = np.unique(x, axis=0, return_inverse=True, return_counts=True)
    inv = inv.ravel()
    if len(xu) > MAX_DISTINCT:
        return _result(n, f"too many different rows to group ({len(xu):,}; limit {MAX_DISTINCT:,})")
    # k-th nearest OTHER row: walk each pattern's neighbours adding up rows until k = min(ms, n-1) are passed
    dist, idx = NearestNeighbors(n_neighbors=min(ms + 1, len(xu))).fit(xu).kneighbors(xu)
    w = cnt[idx] - (idx == np.arange(len(xu))[:, None])  # a pattern's own other copies sit at distance 0
    kth = dist[np.arange(len(xu)), np.argmax(np.cumsum(w, axis=1) >= min(ms, n - 1), axis=1)]
    kth = np.round(kth, 9)[inv]  # equal distances can differ in the last bit by path; a 1e-16 "spread" would shrink eps
    votes = DBSCAN(eps=max(np.median(kth) + K * spread(kth), 1e-9), min_samples=ms).fit_predict(xu, sample_weight=cnt)[inv] == -1
    # ponytail: magnitude = kth distance in spread units, sort key only
    mag = np.where(votes, kth / (spread(kth) or 1.0), 0.0)
    return {**_result(n), "votes": votes, "magnitude": mag,
            "reasons": [["Does not belong to any group of similar rows"] if v else [] for v in votes]}
