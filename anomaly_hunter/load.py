"""Files or panel rows -> DataFrame. Classify columns number/date/text, coerce in place."""
from pathlib import Path

import pandas as pd


class LoadError(Exception):
    pass


def numbers(column_types):
    return [c for c, t in column_types.items() if t == "number"]


def _blank(s):
    return s.isna() | (s.astype(str).str.strip() == "")


def _kind(s):
    """number / date / text: 90% of non-blank cells must parse."""
    s = s[~_blank(s)]
    if not len(s):
        return "text"
    if pd.to_numeric(s, errors="coerce").notna().mean() >= 0.9:
        return "number"
    if pd.to_datetime(s, errors="coerce", format="mixed").notna().mean() >= 0.9:
        return "date"
    return "text"


def _coerce(df, cols):
    """-> (types, errors_log). errors_log = (row, col, raw) for text stuck in a number column."""
    types, errors = {c: _kind(df[c]) for c in cols}, []
    for c, t in types.items():
        if t == "number":
            num = pd.to_numeric(df[c], errors="coerce")
            errors += [(i, c, df.at[i, c]) for i in df.index[num.isna() & ~_blank(df[c])]]
            df[c] = num
        elif t == "date":
            df[c] = pd.to_datetime(df[c], errors="coerce")
    return types, errors


def _read(p):
    p = Path(p)
    # keep_default_na=False: keep literal "N/A" text so type-error check sees it
    kw = {"dtype": str, "keep_default_na": False, "na_values": []}
    try:
        if p.suffix.lower() == ".csv":
            df = pd.read_csv(p, **kw)
        elif p.suffix.lower() in (".xlsx", ".xlsm"):
            df = pd.read_excel(p, sheet_name=0, **kw)
        else:
            raise ValueError(f"unsupported extension {p.suffix}")
    except Exception as e:
        raise LoadError(f"Could not read {p.name}: {e}") from e
    return df.assign(source_file=p.name)


def load_inputs(paths):
    """Read + stack files (union of columns). -> (df, types, errors_log, warnings)."""
    frames = [_read(p) for p in paths]
    df = pd.concat(frames, ignore_index=True, sort=False)
    warnings = [f"{Path(p).name} is missing columns: {', '.join(m)}"
                for f, p in zip(frames, paths) if (m := [c for c in df.columns if c not in f.columns])]
    return df, *_coerce(df, [c for c in df.columns if c != "source_file"]), warnings


def load_from_records(columns, rows):
    """Panel rows -> (df, types, errors_log). Stringify first so it matches the file path."""
    cols, seen = [], {}
    for c in map(str, columns):  # dedupe headers pandas-style (Name, Name.1): dup label breaks df[c]
        seen[c] = seen.get(c, -1) + 1
        cols.append(f"{c}.{seen[c]}" if seen[c] else c)
    df = pd.DataFrame([["" if v is None else str(v) for v in r] for r in rows], columns=cols)
    return df, *_coerce(df, cols)
