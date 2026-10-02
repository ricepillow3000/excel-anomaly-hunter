"""Hygiene checks: facts, not votes — duplicates, type errors, blanks."""


def duplicates(df):
    """A row identical to an earlier row in every column except source_file."""
    compare_cols = [c for c in df.columns if c != "source_file"]
    n = len(df)
    is_dup = [False] * n
    reasons = [[] for _ in range(n)]
    seen = {}
    for i in range(n):
        key = tuple(df.iloc[i][compare_cols].fillna("<NA>").astype(str))
        if key in seen:
            first = seen[key]
            is_dup[i] = True
            reasons[i].append(f"Duplicate of row {first + 2} ({df.iloc[first]['source_file']})")
        else:
            seen[key] = i
    return is_dup, reasons


def type_errors(n, errors_log):
    """errors_log: list of (row_index, column, raw_value) from load.py."""
    flagged = [False] * n
    reasons = [[] for _ in range(n)]
    for idx, col, raw in errors_log:
        flagged[idx] = True
        reasons[idx].append(f'Text "{raw}" in number column {col}')
    return flagged, reasons


def blanks(df, column_types, threshold=0.95):
    """A blank cell in a column that is at least `threshold` filled overall."""
    n = len(df)
    flagged = [False] * n
    reasons = [[] for _ in range(n)]
    for col in column_types:
        blank = df[col].isna()
        if blank.sum() == 0 or (1 - blank.mean()) < threshold:
            continue
        for i in df.index[blank]:
            flagged[i] = True
            reasons[i].append(f"Blank cell in column {col}, which is otherwise filled")
    return flagged, reasons
