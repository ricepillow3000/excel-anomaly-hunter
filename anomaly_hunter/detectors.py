"""Shared robust-cutoff helpers and the four anomaly detectors."""
import numpy as np
import pandas as pd
from pyod.models.ecod import ECOD
from sklearn.cluster import DBSCAN
from sklearn.neighbors import NearestNeighbors

K = 6  # shared cutoff: vote when |score - median| > K * spread


def spread(values):
    """Robust spread: 1.4826*MAD, falling back to 1.2533*mean-abs-dev, then 0."""
    values = np.asarray(values, dtype=float)
    values = values[~np.isnan(values)]
    if len(values) == 0:
        return 0.0
    med = np.median(values)
    mad = np.median(np.abs(values - med))
    if mad > 0:
        return 1.4826 * mad
    mean_abs_dev = np.mean(np.abs(values - med))
    if mean_abs_dev > 0:
        return 1.2533 * mean_abs_dev
    return 0.0


def robust_vote(scores, k=K):
    """Vote + magnitude per the shared cutoff rule. `scores` may contain NaN."""
    scores = np.asarray(scores, dtype=float)
    valid = ~np.isnan(scores)
    votes = np.zeros(len(scores), dtype=bool)
    magnitude = np.zeros(len(scores), dtype=float)
    if valid.sum() == 0:
        return votes, magnitude
    med = np.median(scores[valid])
    sd = spread(scores[valid])
    if sd == 0:
        return votes, magnitude  # constant series casts no votes
    dist = np.abs(scores - med) / sd
    magnitude = np.where(valid, dist, 0.0)
    votes = valid & (dist > k)
    return votes, magnitude


def _numeric_columns(column_types):
    return [c for c, t in column_types.items() if t == "number"]


def limits_detector(df, column_types, limits):
    """A weird-limit breach is a vote; a baseline-only breach is "noted" (not a vote)."""
    n = len(df)
    votes = np.zeros(n, dtype=bool)
    magnitude = np.zeros(n, dtype=float)
    reasons = [[] for _ in range(n)]
    noted = np.zeros(n, dtype=bool)
    noted_reasons = [[] for _ in range(n)]

    for col in _numeric_columns(column_types):
        bounds = limits.get(col)
        if not bounds:
            continue
        baseline_low, baseline_high, weird_low, weird_high = bounds
        values = df[col].to_numpy(dtype=float)
        col_spread = spread(values) or 1.0
        valid = ~np.isnan(values)

        weird_breach = np.zeros(n, dtype=bool)
        if weird_low is not None:
            weird_breach |= valid & (values < weird_low)
        if weird_high is not None:
            weird_breach |= valid & (values > weird_high)

        baseline_breach = np.zeros(n, dtype=bool)
        if baseline_low is not None:
            baseline_breach |= valid & (values < baseline_low)
        if baseline_high is not None:
            baseline_breach |= valid & (values > baseline_high)

        # ponytail: plain `:g` formatting, not the example's comma-grouped "10,000" — cosmetic only
        for i in np.where(weird_breach)[0]:
            limit = weird_low if (weird_low is not None and values[i] < weird_low) else weird_high
            votes[i] = True
            magnitude[i] = max(magnitude[i], abs(values[i] - limit) / col_spread)
            reasons[i].append(f"{col} weird limit is {limit:g}; this is {values[i]:g}")

        for i in np.where(baseline_breach & ~weird_breach)[0]:
            limit = baseline_low if (baseline_low is not None and values[i] < baseline_low) else baseline_high
            noted[i] = True
            noted_reasons[i].append(f"{col} baseline limit is {limit:g}; this is {values[i]:g}")

    return {
        "votes": votes,
        "magnitude": magnitude,
        "reasons": reasons,
        "noted": noted,
        "noted_reasons": noted_reasons,
    }


def sequence_detector(df, column_types, order_by=None):
    n = len(df)
    empty = {
        "ran": False,
        "sit_out_reason": None,
        "votes": np.zeros(n, dtype=bool),
        "magnitude": np.zeros(n, dtype=float),
        "reasons": [[] for _ in range(n)],
    }

    order_col = order_by
    if order_col is None:
        date_cols = [c for c, t in column_types.items() if t == "date"]
        order_col = date_cols[0] if date_cols else None

    if order_col is None:
        empty["sit_out_reason"] = "no order column"
        return empty
    if n < 30:
        empty["sit_out_reason"] = "fewer than 30 rows"
        return empty

    order = df[order_col]
    sorted_idx = order.sort_values(kind="mergesort").index.to_numpy()

    votes = np.zeros(n, dtype=bool)
    magnitude = np.zeros(n, dtype=float)
    reasons = [[] for _ in range(n)]

    for col in _numeric_columns(column_types):
        series = df[col].to_numpy(dtype=float)[sorted_idx]
        s = pd.Series(series)
        trend = s - s.rolling(window=7, center=True, min_periods=1).median()
        trend_vals = trend.to_numpy()

        tvotes, tmag = robust_vote(trend_vals)
        for pos in np.where(tvotes)[0]:
            orig = sorted_idx[pos]
            votes[orig] = True
            magnitude[orig] = max(magnitude[orig], tmag[pos])
            reasons[orig].append(f"{col} is unusual relative to its local trend near {order.iloc[orig]}")

        for order_num, d in zip((1, 2, 3), (s.diff(), s.diff().diff(), s.diff().diff().diff())):
            dvotes, dmag = robust_vote(d.to_numpy())
            for pos in np.where(dvotes)[0]:
                lo = max(0, pos - 3)
                window = trend_vals[lo:pos + 1]
                if len(window) == 0 or np.all(np.isnan(window)):
                    blame_pos = pos
                else:
                    blame_pos = lo + int(np.nanargmax(np.abs(window)))
                orig = sorted_idx[blame_pos]
                votes[orig] = True
                magnitude[orig] = max(magnitude[orig], dmag[pos])
                reasons[orig].append(f"{col} jumped sharply near {order.iloc[orig]} ({order_num}-order change)")

    return {"ran": True, "sit_out_reason": None, "votes": votes, "magnitude": magnitude, "reasons": reasons}


def _robust_scale(df, columns):
    scaled = {}
    for col in columns:
        values = df[col].to_numpy(dtype=float)
        med = np.nanmedian(values) if np.any(~np.isnan(values)) else 0.0
        sd = spread(values) or 1.0
        filled = np.where(np.isnan(values), med, values)
        scaled[col] = (filled - med) / sd
    return pd.DataFrame(scaled)


def isolation_detector(df, column_types):
    n = len(df)
    cols = _numeric_columns(column_types)
    empty = {"ran": False, "sit_out_reason": None, "votes": np.zeros(n, dtype=bool),
             "magnitude": np.zeros(n, dtype=float), "reasons": [[] for _ in range(n)]}
    if n < 30 or not cols:
        empty["sit_out_reason"] = "fewer than 30 rows" if n < 30 else "no numeric columns"
        return empty

    scaled = _robust_scale(df, cols)
    model = ECOD()
    model.fit(scaled.to_numpy())
    votes, magnitude = robust_vote(model.decision_scores_)

    reasons = [[] for _ in range(n)]
    abs_scaled = scaled.abs().to_numpy()
    for i in np.where(votes)[0]:
        worst_col = cols[int(np.argmax(abs_scaled[i]))]
        reasons[i].append(f"Unusual combination of values, mainly {worst_col}")

    return {"ran": True, "sit_out_reason": None, "votes": votes, "magnitude": magnitude, "reasons": reasons}


def clustering_detector(df, column_types):
    n = len(df)
    cols = _numeric_columns(column_types)
    empty = {"ran": False, "sit_out_reason": None, "votes": np.zeros(n, dtype=bool),
             "magnitude": np.zeros(n, dtype=float), "reasons": [[] for _ in range(n)]}
    if n < 30 or not cols:
        empty["sit_out_reason"] = "fewer than 30 rows" if n < 30 else "no numeric columns"
        return empty

    scaled = _robust_scale(df, cols).to_numpy()
    min_samples = max(5, 2 * len(cols))
    k = min(min_samples, n - 1)
    # .kneighbors() with no X excludes each point as its own neighbor; passing
    # X=scaled explicitly would count self at distance 0 and shift every rank.
    dist, _ = NearestNeighbors(n_neighbors=k).fit(scaled).kneighbors()
    kth_dist = dist[:, -1]
    eps = np.median(kth_dist) + K * spread(kth_dist)
    if eps <= 0:
        eps = 1e-9

    labels = DBSCAN(eps=eps, min_samples=min_samples).fit_predict(scaled)
    votes = labels == -1
    # ponytail: spec doesn't define a clustering magnitude; kth-neighbor distance in spread
    # units is a reasonable sort key and reuses eps's own scale.
    magnitude = np.where(votes, kth_dist / (spread(kth_dist) or 1.0), 0.0)
    reasons = [["Does not belong to any group of similar rows"] if v else [] for v in votes]

    return {"ran": True, "sit_out_reason": None, "votes": votes, "magnitude": magnitude, "reasons": reasons}
