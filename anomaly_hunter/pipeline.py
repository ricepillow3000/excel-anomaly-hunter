"""Score a loaded DataFrame: 4 detector votes + hygiene facts -> severity, bucket, reason per row.
Shared by CLI and server."""
from anomaly_hunter.detectors import clustering_detector, isolation_detector, limits_detector, sequence_detector


def duplicates(df):
    """Row equal to an earlier row in every column but source_file."""
    cols = [c for c in df.columns if c != "source_file"]
    seen, out = {}, []
    for i, key in enumerate(map(tuple, df[cols].astype(str).to_numpy())):
        j = seen.setdefault(key, i)
        src = f" ({df['source_file'].iloc[j]})" if "source_file" in df else ""  # CLI path only
        out.append([f"Duplicate of row {j + 2}{src}"] if j != i else [])
    return out


def type_errors(n, errors_log):
    out = [[] for _ in range(n)]
    for i, col, raw in errors_log:
        out[i].append(f'Text "{raw}" in number column {col}')
    return out


def blanks(df, column_types, threshold=0.95):
    """Blank cell in a column that is >= 95% filled."""
    out = [[] for _ in range(len(df))]
    for col in column_types:
        b = df[col].isna()
        if b.any() and 1 - b.mean() >= threshold:
            for i in df.index[b]:
                out[i].append(f"Blank cell in column {col}, which is otherwise filled")
    return out


def score(df, column_types, errors_log, limits, order_by):
    """-> (rows, status). Severity = votes: 1 Low, 2 Medium, 3+ High. Weird limit or hygiene hit = at least Medium."""
    n = len(df)
    lim = limits_detector(df, column_types, limits)
    dets = {"limits": lim, "sequence": sequence_detector(df, column_types, order_by),
            "isolation": isolation_detector(df, column_types), "clustering": clustering_detector(df, column_types)}
    ran = [d for d in dets.values() if d["ran"]]
    dup, typ, blank = duplicates(df), type_errors(n, errors_log), blanks(df, column_types)
    rows = []
    for i in range(n):
        voted = [d for d in ran if d["votes"][i]]
        hygiene = dup[i] + typ[i] + blank[i]
        if not voted and not hygiene:
            noted = lim["noted_reasons"][i]
            rows.append({"severity": "Noted" if noted else None, "bucket": None,
                         "reason": "; ".join(noted), "magnitude": 0.0})
            continue
        v, weird = len(voted), bool(lim["votes"][i])
        rows.append({
            "severity": "High" if v >= 3 else "Medium" if v == 2 or weird or hygiene else "Low",
            "bucket": "Duplicates" if dup[i] else "Irregularities" if weird or typ[i] or blank[i] else "Behavioral",
            "reason": f"Flagged by {v} of {len(ran)}: " + "; ".join(dict.fromkeys(hygiene + [r for d in voted for r in d["reasons"][i]])),  # dedupe, keep order
            "magnitude": float(max((d["magnitude"][i] for d in voted), default=0.0)),
        })
    status = {k: "ran" if d["ran"] else f"sat out: {d['sit_out_reason']}" for k, d in dets.items()}
    return rows, status
