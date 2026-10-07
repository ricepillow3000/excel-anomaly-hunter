"""limits.csv: read analyst's, or suggest one. Baseline = median +/- 3 spread, weird = +/- 6."""
import math

import numpy as np
import pandas as pd

from anomaly_hunter.detectors import spread
from anomaly_hunter.load import numbers
from anomaly_hunter.pipeline import summary_rows

COLS = ["column", "baseline_low", "baseline_high", "weird_low", "weird_high"]


def _num(v):
    return None if pd.isna(v) or not str(v).strip() else float(v)


def read_limits(path, column_types):
    """-> ({col: (b_lo, b_hi, w_lo, w_hi)}, warnings). Blank cell = no limit."""
    t = pd.read_csv(path, dtype=str).reindex(columns=COLS)
    ok = t["column"].isin(numbers(column_types))
    warnings = [f"limits.csv names column '{c}', " + ("an identifier, not a measurement" if column_types.get(c) == "id" else "not found in the data")
                + " - skipped" for c in t["column"][~ok]]
    return {r[0]: tuple(map(_num, r[1:])) for r in t[ok].itertuples(index=False)}, warnings


def _round(v, step, up):
    """Round outward to a whole number of steps, so rounding never narrows a limit."""
    return float(f"{(math.ceil if up else math.floor)(v / step) * step:.12g}") if step else v


def suggest_limits_dict(df, number_columns):
    """{col: (b_lo, b_hi, w_lo, w_hi)}, rounded outward on the spread's scale (so limits never collapse to a point),
    totals rows left out. All-blank column skipped."""
    keep = ~summary_rows(df)
    out = {}
    for c in number_columns:
        x = df.loc[keep, c].dropna()
        if len(x):
            med, sd = float(x.median()), spread(x)
            step = 10 ** math.floor(math.log10(sd)) if sd > 0 else None
            v = [_round(med + k * sd, step, k > 0) for k in (-3, 3, -6, 6)]
            if (x >= 0).mean() >= 0.95:  # counts/prices: a negative is weird, so lows stop at 0
                v[0], v[2] = max(v[0], 0.0), max(v[2], 0.0)
                if (x == 0).mean() >= 0.05:  # zero is a regular value (weekends, no-sale days), not an error
                    v[0] = v[2] = 0.0
            if len(x) >= 10 and (x > 0).all():  # all positive: >=15x below typical is weird too (sq ft 19 for 1915)
                logs = np.log10(x)
                low = 10 ** (logs.median() - max(6 * spread(logs), math.log10(15)))
                v[2] = max(v[2], _round(low, 10 ** math.floor(math.log10(low)), False))  # its own scale: 57 -> 50, not 0
                v[0] = max(v[0], v[2])  # baseline is never tighter than weird
            out[c] = tuple(v)
    return out


def suggest_limits(df, number_columns, out_path):
    rows = [(c, *b) for c, b in suggest_limits_dict(df, number_columns).items()]
    pd.DataFrame(rows, columns=COLS).to_csv(out_path, index=False)
