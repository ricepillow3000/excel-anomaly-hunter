"""Robust cutoff + three detectors. Each returns {ran, sit_out_reason, votes, magnitude, reasons}."""
import re
import warnings

import numpy as np
import pandas as pd
from scipy.stats import skew

from anomaly_hunter.engine.fairness import _words
from anomaly_hunter.engine.load import numbers

K = 6  # vote when |score - median| > K * spread


BIG = 1e12  # spreads from the median: far past any limit, and finite (x / a subnormal spread overflows to infinity)


def spread(v):
    """Robust spread: 1.4826*MAD, else 1.2533*mean abs dev, else 0."""
    v = np.asarray(v, dtype=float)
    v = v[~np.isnan(v)]
    if not len(v):
        return 0.0
    d = np.abs(v - np.median(v))
    if np.median(d) > 1e-9 * np.median(np.abs(v)):  # 2.99 - 1.99 != 1 exactly: float noise is not spread
        return 1.4826 * np.median(d)
    return 1.2533 * d.mean() if d.mean() > 0 else 0.0


def robust_vote(scores, k=K):
    """(votes, magnitude). NaN never votes. Constant series never votes."""
    s = np.asarray(scores, dtype=float)
    ok = ~np.isnan(s)
    sd = spread(s)
    if not ok.any() or sd == 0:
        return np.zeros(len(s), bool), np.zeros(len(s))
    with np.errstate(over="ignore"):  # a subnormal spread (5e-324) makes infinity: capped, it still votes (fuzz, 2026-10-16)
        dist = np.minimum(np.where(ok, np.abs(s - np.median(s[ok])) / sd, 0.0), BIG)
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


def _alone_top(sv):
    """(top, next) when a column's top value stands alone above its top run, with an exact x10/x100/x1000 behind it that
    lands in the column's middle (10th-90th percentile); else None. A two-kind column (tuitions 2k-14k and 15k-60k) gets
    log-scale limits of 500,000 and 23 million, so a public 10,563 typed as 105,630 - 1.8x the max - passed every limit
    (blind round 23). An honest tail climbs to its top in steps: the top's gap over the next value (log) is at least 1.5x
    and 8 times the climb of the next 10 values. Simulated on 11 shapes (log-normal 0.3-1.5, Pareto 1.2-3, gamma, uniform,
    two kinds) at 60-20,000 rows: 0 honest columns said alone; 57-67% of x10 slips past a two-kind column's max caught."""
    # a measured column (50+ different values): on a scale or a small count (a 10 among 1-5) the top's company is ties, and
    # its x10 is the rule John dropped (AH-16); the column's name already says it (named_bounds), as worth a check
    if len(sv) < 100 or sv[0] < 0 or sv[-12] <= 0 or sv[-1] <= sv[-2] or len(np.unique(sv)) < 50:
        return None
    gap, climb = np.log(sv[-1] / sv[-2]), np.log(sv[-2] / sv[-12])
    p10, p90 = np.quantile(sv, [0.1, 0.9])
    if gap >= np.log(1.5) and gap >= 8 * climb and any(p10 <= sv[-1] / 10 ** k <= p90 for k in (1, 2, 3)):
        return float(sv[-1]), float(sv[-2])
    return None


def column_stats(x):
    """What likely_value needs about a column, computed once: sorted |non-zero values|, their log median, signs."""
    x = x[~np.isnan(x)]
    mags = np.sort(np.abs(x[x != 0]))
    return {"n": len(x), "nonneg": int((x >= 0).sum()), "mags": mags, "logmed": np.median(np.log10(mags)) if len(mags) else 0.0,
            "whole": bool((x == np.round(x)).mean() >= 0.95), "pos": np.sort(x[x > 0])}


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
    # sign flip only where negatives are rare (v itself is one): 2% returns (Online Retail) are refunds, not slips. And a
    # slip stands alone: the only negative, or as big as the column's usual positives (10th percentile up). Seattle's
    # real -1.1 highs and a sea level's -0.44 sat beside other small negatives, under every positive (AH-21: 5 of 5 flips
    # on real values had this shape, 0 of 41 right ones; an airport's -44.5 beside 3 real territories still flips)
    pos = st["pos"]
    flip = v < 0 and st["nonneg"] >= 0.99 * (st["n"] - 1) and (
        st["n"] - st["nonneg"] == 1 or (len(pos) > 0 and m >= pos[int(0.1 * (len(pos) - 1))]))
    for c in ([v / 10 ** k] if 1 <= abs(k) <= 3 and far else []) + ([-v] if flip else []):
        if lo <= c <= hi and (c == round(c) or not st["whole"]):  # 999 in a 1-5 count column is not "likely 0.999"
            return float(c) if c == -v else float(f"{c:.10g}")  # a flipped sign is exact: rounding made it "missing zeros"
    return None


# a quantity that can itself go below zero: a loss month among profits, a sub-zero high, an overdrawn balance. There a lone
# negative looks exactly like a minus typed by mistake, so its flip is a guess the user confirms, never "likely" (AH-25,
# from Council A's AH-21 review). On Hand, Units, Spend and Weight cannot go negative: a lone minus there is a slip.
# Try 2 (Council A's review): P/L, TMAX, Chg, YoY, Var, an elevation, a latitude, a yield, a spread, an error or a score to
# par still said "likely"; Low stock, High price, Net weight, Return qty, Change given, Income and Temp ID said "maybe"
TEMP = {"temp", "temps", "temperature", "temperatures", "celsius", "fahrenheit", "tmax", "tmin", "tavg", "dewpoint", "dew",
        "windchill", "chill", "tempmax", "tempmin", "feelslike", "feelslikemax", "feelslikemin"}  # tempmax: Visual Crossing
SIGNED = TEMP | {"profit", "profits", "earnings", "margin", "margins", "gain", "gains", "loss", "losses", "pnl", "balance",
                 "balances", "return", "change", "changes", "chg", "delta", "diff", "difference", "variance", "var", "yoy",
                 "growth", "surplus", "deficit", "cashflow", "ebit", "ebitda", "elevation", "altitude", "latitude",
                 "longitude", "lat", "lon", "lng", "yield", "yields", "interest", "spread", "spreads", "anomaly",
                 "anomalies", "error", "errors", "residual", "residuals", "adjustment", "adjustments"}
# ...unless the header says it counts or names something else: Return qty, Change given, Temp ID (a temporary worker's),
# Error count
NOT_SIGNED = {"qty", "quantity", "units", "count", "counts", "items", "orders", "given", "id", "code", "codes", "type",
              "reason", "date", "agency", "worker", "workers", "staff", "employee", "employees", "contract",
              "absolute", "abs"}  # Absolute error, Abs diff: never below zero (AH-25 review 2)
# "Net" is signed with a money or flow word (Net income, Net change, Net cash flow), never alone with Weight or Units
NET_WITH = {"income", "change", "flow", "cashflow", "cash", "balance", "gain", "gains", "loss", "losses", "migration",
            "amount", "position", "worth", "value", "result", "profit", "earnings", "margin", "total"}
# High and Low are a weather sheet's on their own (Highs, Lows), never a stock's beside Open and Close, nor a Low stock
PRICES = {"open", "close", "volume", "adj", "price", "bid", "ask"}


def _signed(col, columns=()):
    """Profit, Net Income, P&L, P/L, Cash flow, Change, Balance, temp_max, TMAX, "High (°F)", Highs, Latitude, Yield, Spread,
    Error, Score to par: a column whose quantity can be negative."""
    name, w = str(col).casefold(), _words(col)
    ws = set(w) | set(re.findall(r"[a-z]+", name))  # PnL, YoY whole as well as split (pn + l, yo + y)
    if "°" in name or "+/-" in name or "over/under" in name.replace(" ", "") or w == ["p", "l"]:  # P/L, P L
        return True
    if "cash" in ws and "flow" in ws or "net" in ws and ws & NET_WITH or "par" in ws and ws & {"to", "vs", "score"} \
            or "operating" in ws and "income" in ws:  # an operating loss
        return True
    if ws & NOT_SIGNED:
        return False
    if ws & SIGNED:
        return True
    if ws & {"high", "highs", "low", "lows"}:  # alone (Highs, Daily High, High (C)), on a sheet that is not a stock's prices
        return len(set(w) - {"daily", "c", "f"}) == 1 and not any(set(_words(c)) & PRICES for c in columns if c != col)
    return False


def _sentinel(v):
    """0, -1 and all-9 numbers (99, -999, 9999.0): what people type for "missing"."""
    return v in (0, -1) or (v == int(v) and abs(v) >= 99 and set(str(int(abs(v)))) == {"9"})


FEW = (2, 0.0025)  # the level-7+ list: a value past its usual limit that at most max(2, 0.25% of the column) others pass,
# and at most 2 others reach


def limits_detector(df, column_types, limits, typos_only=False, listing=False, quiet=()):
    """Weird-limit breach = vote. Baseline-only breach = noted, no vote. likely[i] = {col: probable typo fix}.
    typos_only (strength 0): only breaches with an obvious typo behind them, or negatives in a column that never goes
    below 0, vote. listing (strength 7+): alone_reasons[i] = breaches only noted that few other values share (FEW), said
    with their count; never for a `quiet` column (protected ones, and ones whose limits the user saved)."""
    n = len(df)
    r = {**_result(n), "noted": np.zeros(n, bool), "noted_reasons": [[] for _ in range(n)], "likely": [{} for _ in range(n)],
         "maybe": [{} for _ in range(n)],
         "alone_reasons": [[] for _ in range(n)], "top_reasons": [[] for _ in range(n)]}
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
        sv, med = np.sort(x[~np.isnan(x)]), float(np.nanmedian(x)) if len(vals) else 0.0
        crowd = max(5, 0.0005 * len(sv))
        rare_minus = (sv >= 0).sum() >= 0.99 * (len(sv) - 1)  # likely_value's own test for a minus-sign slip
        top = None if typos_only else _alone_top(sv)

        def in_tail(v):
            """Other values crowd the way back to the median (hours 1-99 around a usual 40, survey weights up to 8x
            the median): the column's own long tail, not a slip. A slip stands alone; copies of itself don't count.
            Halfway back is the nearer of the two midpoints: a low positive one on the ratio scale (Sq Ft 19 for 1915
            is 100x small - the 600 sq ft flats between don't make it normal)."""
            if v < 0 and rare_minus:  # On Hand -26 by stock of 0-21 (median 69): no column's tail crosses zero
                return False
            mid = np.sqrt(v * med) if 0 < v < med else (v + med) / 2
            a, b = sorted((v, mid))
            return np.searchsorted(sv, b, "right") - np.searchsorted(sv, a, "left") - cnt[np.searchsorted(vals, v)] >= crowd

        for i, v in enumerate(x):
            if np.isnan(v):
                continue
            weird, fix, said_before = _crossed(v, w_lo, w_hi), None, len(r["reasons"][i]) + len(r["alone_reasons"][i])
            # past the usual limit, alone, with an exact x10/x100 behind it: a typo, even under a skewed column's wide
            # weird limit (First Response 430 hrs for 4.3 by a median 4.9 - blind bench, 3 of 3 seeds only noted)
            if weird is None and v not in common and _crossed(v, b_lo, b_hi) is not None and not in_tail(v):
                if (fix := likely_value(v, st := st or column_stats(x), b_lo, b_hi)) is not None:
                    weird = _crossed(v, b_lo, b_hi)
            if v not in common and (lim := weird) is not None and not in_tail(v):
                fix = fix if fix is not None else likely_value(v, st := st or column_stats(x), b_lo, b_hi)
                negative = v < 0 and st["nonneg"] >= 0.95 * (st["n"] - 1)  # a minus sign in a column that has none
                if typos_only and fix is None and not negative:  # basics: an obvious typo or a stray minus sign
                    continue
                r["votes"][i] = True
                with np.errstate(over="ignore"):
                    r["magnitude"][i] = max(r["magnitude"][i], min(BIG, abs(v - lim) / sd))
                # a typo the numbers cannot tell from a real value is never "likely" (AH-21). A value too small (DC's real 4%
                # for 0.4; Sq Ft 19 for 1915, whose lost digits are not 00) is offered as a guess the user confirms. A tenth
                # in a column of small whole numbers is offered nothing: a real 20 floors among 1-5 is a rating 20 typed for
                # 2 to the numbers, and real counts offered a tenth is why the 1-5 scale rule was dropped (John, AH-16)
                small = fix is not None and fix != -v and abs(fix) < abs(v) and st["whole"] and \
                    st["mags"][-2 if st["mags"][-1] == abs(v) else -1] <= 10
                said = None if fix is None or small else "maybe" if (fix != -v and abs(fix) > abs(v)) or (fix == -v and _signed(col, column_types)) \
                    else "likely"
                if said:
                    r[said][i][col] = fix
                r["reasons"][i].append(f"{col} weird limit is {lim:g}; this is {v:g}" + (f" ({said} {fix:g})" if said else ""))
            elif (lim := _crossed(v, b_lo, b_hi)) is not None:
                r["noted"][i] = True
                r["noted_reasons"][i].append(f"{col} baseline limit is {lim:g}; this is {v:g}")
                # a stricter level lists it when few other values are past the same limit: the gains (a 10 on a 1-5 scale,
                # story points 50 by a usual 30) had 0-1, an honest tail of bulk orders 43-49 (AH-14 review). Counted,
                # not "near it": "with few values near it" was shown with 32 values between it and the median. Never on a
                # protected column (honest people aged 91-98 were listed for their age, AH-17) nor past a limit the user
                # saved. Listed, never a vote; its real limit, value and count: nothing invented
                if listing and col not in quiet and v not in common:
                    up = v > lim
                    others = int(len(sv) - np.searchsorted(sv, lim, "right") if up else np.searchsorted(sv, lim, "left")) - 1
                    # ...and at most FEW[0] others as far out as it: on 30,000 clean normal rows every value past the usual
                    # limit had under 0.25% of company (129 rows listed); only a column's own extremes stand that alone
                    level = int(len(sv) - np.searchsorted(sv, v, "left") if up else np.searchsorted(sv, v, "right")) - 1
                    if others <= max(FEW[0], FEW[1] * len(sv)) and level <= FEW[0]:
                        r["alone_reasons"][i].append(f"{col} {v:g} is {'above' if v > lim else 'below'} its usual limit of {lim:g}, and "
                                                     + ("no other value is too" if not others else f"{others} other value{'s are' if others > 1 else ' is'} too"))
            # AH-29, see _alone_top. Worth a check, never a vote: one real record above a column with a hard top looks the
            # same (a 45,000 wholesale order over orders up to 20,000, a CEO's 400,000 over a pay scale capped at 150,000,
            # a 450 product over prices to 200: each was Medium, "probably wrong", AH-29 review)
            if top is not None and v == top[0] and len(r["reasons"][i]) + len(r["alone_reasons"][i]) == said_before:
                r["top_reasons"][i].append(f"{col} {v:g} stands alone above the rest of the column, whose next highest is {top[1]:g}")
    # one slip changes one cell: 2+ cells of a row off by the same step (California's fruit, all "/1000", adding up
    # exactly) are a real row or another unit, so none of them is offered as a typo (the card already held them back;
    # the reason still said "likely", AH-21). The cells stay flagged
    for i in range(n):
        steps = {}
        for kind in ("likely", "maybe"):
            for col, fix in r[kind][i].items():
                v = float(df[col].iloc[i])
                if fix and v:  # likely_value never offers 0, nor a fix for 0
                    steps.setdefault("sign" if fix == -v else int(round(np.log10(abs(v / fix)))), []).append((kind, col, fix))
        for same in steps.values():
            for kind, col, fix in same if len(same) >= 2 else ():
                del r[kind][i][col]
                r["reasons"][i] = [s.replace(f" ({kind} {fix:g})", "") if s.startswith(f"{col} weird limit is") else s for s in r["reasons"][i]]
    return r


def _beat(x, p):
    """x[p] is one beat of a regular cycle: the same value recurs 3+ times, mostly at one spacing (a price that
    resets every 4 days). A one-off jump does not recur."""
    q = np.flatnonzero(np.isclose(x, x[p], rtol=1e-9, atol=0))
    g = np.diff(q)
    return len(q) >= 3 and (g == np.median(g)).mean() >= 0.5


def sequence_detector(df, column_types, order_by=None, k=K):
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
        votes, mag = robust_vote(trend, k)
        for p in np.where(votes)[0]:
            if not _beat(trend, p):
                hit(p, mag[p], f"{col} is unusual relative to its local trend")
        d = s
        for _ in (1, 2, 3):
            d = d.diff()
            votes, mag = robust_vote(d.to_numpy(), k)
            for p in np.where(votes)[0]:
                if _beat(d.to_numpy(), p):  # the cycle's own reset, not a jump
                    continue
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
        with np.errstate(over="ignore"):  # capped: _ecod refuses infinity (an engine error on a crafted sheet, 2026-10-16)
            out[c] = np.clip((np.where(np.isnan(x), med, x) - med) / (spread(x) or 1.0), -BIG, BIG)
    return pd.DataFrame(out)


def _skip(n, cols):
    return "fewer than 30 rows" if n < 30 else None if cols else "no numeric columns"


def _ecod(x):
    """ECOD (Li et al. 2022), the same maths as pyod 3.6.6: per column, -log of the share of values at or past each one,
    on the tail the column's skew points to; summed over columns. pyod brought numba, llvmlite, matplotlib and
    scikit-learn into the exe for this alone (146 MB, minutes to download, 2026-10-19)."""
    if not np.isfinite(x).all():  # pyod refused these too: a blank or infinity here is an engine bug, never a score
        raise ValueError("ECOD needs finite numbers")
    n, t = len(x), np.ascontiguousarray(x.T)  # one row per column: each sort runs on contiguous memory
    order = np.argsort(t, axis=1)
    s = np.take_along_axis(t, order, 1)
    le, ge = np.empty_like(t), np.empty_like(t)  # how many values are <= / >= each value (ties count fully)
    for j in range(len(t)):
        le[j, order[j]] = np.searchsorted(s[j], s[j], "right")
        ge[j, order[j]] = n - np.searchsorted(s[j], s[j], "left")
    left, right = -np.log(le.T / n), -np.log(ge.T / n)
    with warnings.catch_warnings():  # scipy warns on a constant column; its NaN skew means both tails, like pyod
        warnings.simplefilter("ignore", RuntimeWarning)
        sk = np.sign(np.nan_to_num(skew(x, axis=0)))
    return np.maximum(np.maximum(left, right), left * -np.sign(sk - 1) + right * np.sign(sk + 1)).sum(axis=1)


def isolation_detector(df, column_types, k=K):
    """ECOD outlier score on scaled numbers."""
    n, cols = len(df), numbers(column_types)
    if why := _skip(n, cols):
        return _result(n, why)
    x = _scaled(df, cols)
    votes, mag = robust_vote(_ecod(x.to_numpy()), k)
    worst = x.abs().to_numpy().argmax(axis=1)
    reasons = [[f"Unusual combination of values, mainly {cols[w]}"] if v else [] for v, w in zip(votes, worst)]
    return {**_result(n), "votes": votes, "magnitude": mag, "reasons": reasons}

