"""Score a loaded DataFrame: 4 detector votes + hygiene facts -> severity, bucket, reason per row.
Shared by CLI and server."""
import re

import numpy as np

from anomaly_hunter.detectors import clustering_detector, isolation_detector, limits_detector, sequence_detector
from anomaly_hunter.load import EXCEL_ERROR, _blank

def summary_rows(df):
    """Rows that summarise the data instead of being data -> bool array: fully blank rows, rows labelled
    Total/Subtotal/Mean/... that are sparser than a normal row ("Total Wine" the vendor is a full row), and
    unlabelled rows whose numbers equal the sum of the rows above them."""
    cols = [c for c in df.columns if c != "source_file"]
    count = (~df[cols].apply(_blank)).sum(axis=1).to_numpy()
    nums = [c for c in cols if df[c].dtype.kind in "fi"]
    rows_with = lambda key: df.index.isin(df.attrs.get(key, ()))  # set by load, before coercion
    sparse = count < np.median(count)  # a totals row leaves the label/date/text cells empty
    # "Total" + sparse; "Average"/"Mean" only if half empty ("Average" can be a rating in a normal row)
    mask = (count == 0) | (rows_with("total_rows") & sparse) | (rows_with("stat_rows") & (count <= np.median(count) / 2))
    x = df[nums].to_numpy(dtype=float)
    run = np.vstack([np.zeros(len(nums)), np.nancumsum(x, axis=0)])  # run[i] = sum of rows before i
    start = 0
    for i in np.flatnonzero(mask | sparse):  # only sparse rows can be unlabelled totals
        if mask[i]:
            start = i + 1
            continue
        above = run[i] - run[start]
        have = ~np.isnan(x[i]) & (above != 0)
        if i - start >= 2 and sparse[i] and have.any() and (np.abs(x[i][have] - above[have]) <= 0.005 * np.abs(above[have])).all():
            mask[i], start = True, i + 1
    return mask


def duplicates(df):
    """Row equal to an earlier row in every column but source_file."""
    cols = [c for c in df.columns if c != "source_file"]
    seen, out = {}, []
    for i, key in enumerate(map(tuple, df[cols].astype(str).to_numpy())):
        j = seen.setdefault(key, i)
        src = f" ({df['source_file'].iloc[j]})" if "source_file" in df else ""  # CLI path only
        out.append([f"Duplicate of row {j + 2}{src}"] if j != i else [])
    return out


def type_errors(n, errors_log, column_types):
    out = [[] for _ in range(n)]
    for i, col, raw in errors_log:
        kind = "date" if column_types[col] == "date" else "number"
        out[i].append(f"Excel error {raw} in {col}" if EXCEL_ERROR.match(str(raw).strip()) else f'Text "{raw}" in {kind} column {col}')
    return out


# stand-ins for a missing value. Not "NA" (a ticker, a country) or "None" (a real category)
PLACEHOLDER = re.compile(r"error|unknown|n/a|null|\?|-", re.I)


def placeholders(df, column_types, skip):
    """ERROR / UNKNOWN / N/A / NULL / ? / - or an Excel error left in a text column. Not when it's half the column or
    more: then it's the sheet's own convention."""
    out = [[] for _ in range(len(df))]
    for col, t in column_types.items():
        if t != "text":
            continue
        v = df[col].astype(str).str.strip()
        err = v.str.match(EXCEL_ERROR)
        hit = (v.str.fullmatch(PLACEHOLDER) | err) & ~skip
        if hit.any() and hit.sum() < 0.5 * (~_blank(df[col]) & ~skip).sum():
            for i in df.index[hit]:
                out[i].append(f"Excel error {v[i]} in {col}" if err[i] else f'Placeholder "{v[i]}" in column {col}')
    return out


def blanks(df, column_types, skip, errors_log, threshold=0.95):
    """Blank cell in a column that is >= 95% filled (summary rows not counted)."""
    out = [[] for _ in range(len(df))]
    wrong = {}  # text/errors already named as such are not blanks
    for i, c, _ in errors_log:
        wrong.setdefault(c, []).append(i)
    for col in column_types:
        b = _blank(df[col]) & ~skip & ~df.index.isin(wrong.get(col, []))  # empty text cells too, not only converted ones
        if b.any() and 1 - b.sum() / max(1, (~skip).sum()) >= threshold:
            for i in df.index[b]:
                out[i].append(f"Blank cell in column {col}, which is otherwise filled")
    return out


def spellings(df, column_types, skip):
    """Same category typed differently ("Sales" / "sales " / "SALES") - breaks SUMIFS and pivots silently.
    Only case/space differences, only in category-like columns (<= 50 distinct), only when the usual
    spelling is >= 3x as common. -> (reasons per row, {col: usual spelling} per row)."""
    out, fix = [[] for _ in range(len(df))], [{} for _ in range(len(df))]
    for col, t in column_types.items():
        if t != "text":
            continue
        s = df[col][~skip].dropna().astype(str)
        s = s[(s.str.strip() != "") & ~s.str.lstrip().str[:1].isin(list("=+-@"))]  # formula-like text is never a "spelling"
        if s.nunique() > 50:
            continue
        for _, grp in s.groupby(s.map(lambda v: " ".join(v.split()).casefold())):
            counts = grp.value_counts()
            for raw, c in counts.iloc[1:].items():
                if counts.iloc[0] >= 3 * c:
                    for i in grp.index[grp == raw]:
                        out[i].append(f'{col} "{raw}" looks like "{counts.index[0]}" (same word, different capitals/spaces)')
                        fix[i][col] = counts.index[0]
    return out, fix


def score(df, column_types, errors_log, limits, order_by):
    """-> (rows, status). Severity = votes: 1 Low, 2 Medium, 3+ High. Weird limit or hygiene hit = at least Medium.
    Totals/summary rows are left out of every check (their numbers would distort the rest) and say so."""
    n, skip = len(df), summary_rows(df)
    empty = df[[c for c in df.columns if c != "source_file"]].apply(_blank).all(axis=1).to_numpy()  # before totals are blanked
    df = df.copy()
    if nums := [c for c, t in column_types.items() if t in ("number", "id")]:  # (pandas 3 fails on an empty column list)
        df.loc[skip, nums] = np.nan
    errors_log = [e for e in errors_log if not skip[e[0]]]
    lim = limits_detector(df, column_types, limits)
    dets = {"limits": lim, "sequence": sequence_detector(df, column_types, order_by),
            "isolation": isolation_detector(df, column_types), "clustering": clustering_detector(df, column_types)}
    ran = [d for d in dets.values() if d["ran"]]
    dup, typ, blank = duplicates(df), type_errors(n, errors_log, column_types), blanks(df, column_types, skip, errors_log)
    hole = placeholders(df, column_types, skip)
    spell, spell_fix = spellings(df, column_types, skip)
    rows = []
    for i in range(n):
        if skip[i]:
            rows.append({"severity": None, "bucket": None, "reason": "" if empty[i] else "Totals/summary row - not checked",
                         "magnitude": 0.0})
            continue
        voted = [d for d in ran if d["votes"][i]]
        hygiene = dup[i] + typ[i] + blank[i] + hole[i] + spell[i]
        if not voted and not hygiene:
            noted = lim["noted_reasons"][i]
            rows.append({"severity": "Noted" if noted else None, "bucket": None,
                         "reason": "; ".join(noted), "magnitude": 0.0})
            continue
        v, weird = len(voted), bool(lim["votes"][i])
        rows.append({
            "severity": "High" if v >= 3 else "Medium" if v == 2 or weird or hygiene else "Low",
            "bucket": "Duplicates" if dup[i] else "Irregularities" if weird or typ[i] or blank[i] or hole[i] or spell[i] else "Behavioral",
            "reason": (f"Flagged by {v} of {len(ran)}: " if v else "") + "; ".join(dict.fromkeys(hygiene + [r for d in voted for r in d["reasons"][i]])),  # dedupe, keep order
            "magnitude": float(max((d["magnitude"][i] for d in voted), default=0.0)),
            "likely": {**lim["likely"][i], **spell_fix[i]},
        })
    status = {k: "ran" if d["ran"] else f"sat out: {d['sit_out_reason']}" for k, d in dets.items()}
    return rows, status
