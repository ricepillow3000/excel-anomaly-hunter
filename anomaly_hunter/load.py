"""Load CSV/Excel inputs, concatenate, and classify columns."""
from pathlib import Path

import pandas as pd


class LoadError(Exception):
    def __init__(self, filename, reason):
        super().__init__(f"Could not read {filename}: {reason}")
        self.filename = filename


def _is_blank(series):
    return series.isna() | (series.astype(str).str.strip() == "")


def _read_one(path):
    path = Path(path)
    try:
        # keep_default_na=False: pandas otherwise silently turns tokens like "N/A"
        # into a real NaN before we ever see the text, which is exactly the case
        # the spec's type-error example names — we need the literal text.
        if path.suffix.lower() == ".csv":
            df = pd.read_csv(path, dtype=str, keep_default_na=False, na_values=[])
        elif path.suffix.lower() in (".xlsx", ".xlsm"):
            df = pd.read_excel(path, sheet_name=0, dtype=str, keep_default_na=False, na_values=[])
        else:
            raise LoadError(path.name, f"unsupported extension {path.suffix}")
    except LoadError:
        raise
    except Exception as exc:
        raise LoadError(path.name, str(exc)) from exc
    df["source_file"] = path.name
    return df


def classify_column(series):
    """Return "number", "date", or "text" for one column of string values."""
    blank = _is_blank(series)
    non_blank = series[~blank]
    if len(non_blank) == 0:
        return "text"
    numeric = pd.to_numeric(non_blank, errors="coerce")
    if numeric.notna().mean() >= 0.9:
        return "number"
    dated = pd.to_datetime(non_blank, errors="coerce", format="mixed")
    if dated.notna().mean() >= 0.9:
        return "date"
    return "text"


def _classify_and_coerce(df, data_columns):
    """Classify each data column and coerce number/date columns in place.

    Returns (column_types, errors_log) — errors_log is a list of
    (row_index, column, raw_value) for cells that failed to parse in a
    number column, which the hygiene type-error check reads.
    """
    column_types = {c: classify_column(df[c]) for c in data_columns}
    errors_log = []
    for col, kind in column_types.items():
        if kind == "number":
            blank = _is_blank(df[col])
            numeric = pd.to_numeric(df[col], errors="coerce")
            failed = (~blank) & numeric.isna()
            for idx in df.index[failed]:
                errors_log.append((idx, col, df.at[idx, col]))
            df[col] = numeric
        elif kind == "date":
            df[col] = pd.to_datetime(df[col], errors="coerce")
    return column_types, errors_log


def load_inputs(paths):
    """Read, concatenate, and classify the given CSV/XLSX files.

    Returns (df, column_types, errors_log, warnings). `df` has number/date
    columns coerced (failed cells become NaN) plus a `source_file` column.
    `warnings` names files missing columns the union picked up from others.
    """
    frames = [_read_one(p) for p in paths]
    all_columns = []
    for f in frames:
        for c in f.columns:
            if c not in all_columns:
                all_columns.append(c)

    warnings = []
    for f, p in zip(frames, paths):
        missing = [c for c in all_columns if c not in f.columns and c != "source_file"]
        if missing:
            warnings.append(f"{Path(p).name} is missing columns: {', '.join(missing)}")

    df = pd.concat(frames, ignore_index=True, sort=False)
    df = df.reindex(columns=all_columns)

    data_columns = [c for c in all_columns if c != "source_file"]
    column_types, errors_log = _classify_and_coerce(df, data_columns)

    return df, column_types, errors_log, warnings


def _dedupe_columns(columns):
    """Rename repeats as Name, Name.1, Name.2 — same convention pandas'
    own read_csv/read_excel already apply automatically. A real spreadsheet's
    header row can repeat a name (or be blank) more than once; df[name] for a
    duplicated label returns a DataFrame instead of a Series, breaking any
    .str/.isna()-style Series-only call downstream.
    """
    seen = {}
    deduped = []
    for name in columns:
        count = seen.get(name, 0)
        seen[name] = count + 1
        deduped.append(name if count == 0 else f"{name}.{count}")
    return deduped


def load_from_records(columns, rows):
    """Build a DataFrame from in-memory columns/rows (e.g. the Office.js
    panel's active-sheet data) and classify it exactly like the file path —
    everything is stringified first so "N/A"-style text in a number column
    is still caught by the same type-error logic as the CSV/XLSX path.

    Returns (df, column_types, errors_log) — no `source_file` column and no
    warnings, since there's exactly one in-memory source.
    """
    columns = _dedupe_columns([str(c) for c in columns])
    str_rows = [["" if v is None else str(v) for v in row] for row in rows]
    df = pd.DataFrame(str_rows, columns=columns)
    column_types, errors_log = _classify_and_coerce(df, columns)
    return df, column_types, errors_log
