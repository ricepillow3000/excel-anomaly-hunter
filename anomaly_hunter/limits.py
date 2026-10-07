"""limits.csv: read analyst's, or suggest one. Baseline = median +/- 3 spread, weird = +/- 6."""
import pandas as pd

from anomaly_hunter.detectors import spread

COLS = ["column", "baseline_low", "baseline_high", "weird_low", "weird_high"]


def _num(v):
    return None if pd.isna(v) or not str(v).strip() else float(v)


def read_limits(path, number_columns):
    """-> ({col: (b_lo, b_hi, w_lo, w_hi)}, warnings). Blank cell = no limit."""
    t = pd.read_csv(path, dtype=str).reindex(columns=COLS)
    ok = t["column"].isin(number_columns)
    warnings = [f"limits.csv names column '{c}', not found in the data - skipped" for c in t["column"][~ok]]
    return {r[0]: tuple(map(_num, r[1:])) for r in t[ok].itertuples(index=False)}, warnings


def suggest_limits_dict(df, number_columns):
    """{col: (b_lo, b_hi, w_lo, w_hi)} at 3 sig figs. All-blank column skipped."""
    out = {}
    for c in number_columns:
        x = df[c].dropna()
        if len(x):
            med, sd = float(x.median()), spread(x)
            v = [float(f"{med + k * sd:.3g}") for k in (-3, 3, -6, 6)]
            if (x >= 0).mean() >= 0.95:  # counts/prices: a negative is weird, so lows stop at 0
                v[0], v[2] = max(v[0], 0.0), max(v[2], 0.0)
            out[c] = tuple(v)
    return out


def suggest_limits(df, number_columns, out_path):
    rows = [(c, *b) for c, b in suggest_limits_dict(df, number_columns).items()]
    pd.DataFrame(rows, columns=COLS).to_csv(out_path, index=False)
