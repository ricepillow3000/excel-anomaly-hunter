"""Read an analyst-edited limits.csv, or suggest one when none exists."""
from pathlib import Path

import pandas as pd

from anomaly_hunter.detectors import spread

LIMITS_COLUMNS = ["column", "baseline_low", "baseline_high", "weird_low", "weird_high"]


def _sig_round(value, sig=3):
    if value == 0:
        return 0.0
    from math import floor, log10
    digits = sig - int(floor(log10(abs(value)))) - 1
    return round(value, digits)


def _blank_to_none(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    if isinstance(value, str) and value.strip() == "":
        return None
    return float(value)


def read_limits(path, number_columns):
    """Returns (limits: {column: (b_low, b_high, w_low, w_high)}, warnings: [str])."""
    table = pd.read_csv(path, dtype=str)
    limits = {}
    warnings = []
    for _, row in table.iterrows():
        col = row["column"]
        if col not in number_columns:
            warnings.append(f"limits.csv names column '{col}', not found in the data — skipped")
            continue
        limits[col] = (
            _blank_to_none(row.get("baseline_low")),
            _blank_to_none(row.get("baseline_high")),
            _blank_to_none(row.get("weird_low")),
            _blank_to_none(row.get("weird_high")),
        )
    return limits, warnings


def suggest_limits_dict(df, number_columns):
    """{column: (baseline_low, baseline_high, weird_low, weird_high)}, 3-sig-fig suggestions.

    baseline = median +/- 3*spread, weird = median +/- 6*spread. A column with
    no valid values is omitted.
    """
    suggestions = {}
    for col in number_columns:
        values = df[col].to_numpy(dtype=float)
        valid = values[~pd.isna(values)]
        if len(valid) == 0:
            continue
        med = float(pd.Series(valid).median())
        sd = spread(valid)
        suggestions[col] = (
            _sig_round(med - 3 * sd),
            _sig_round(med + 3 * sd),
            _sig_round(med - 6 * sd),
            _sig_round(med + 6 * sd),
        )
    return suggestions


def suggest_limits(df, number_columns, out_path):
    """Write a suggested limits.csv from suggest_limits_dict's values."""
    suggestions = suggest_limits_dict(df, number_columns)
    rows = [
        {"column": col, "baseline_low": b[0], "baseline_high": b[1], "weird_low": b[2], "weird_high": b[3]}
        for col, b in suggestions.items()
    ]
    out = pd.DataFrame(rows, columns=LIMITS_COLUMNS)
    out.to_csv(out_path, index=False)
    return Path(out_path)
