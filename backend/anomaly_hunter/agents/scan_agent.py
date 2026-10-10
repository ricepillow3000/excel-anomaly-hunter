"""Agent 1: find the problems. Table in -> a verdict per row. Limits are suggested from the data; limits the user
saved win, column by column. ponytail: no parallel helpers - every check needs whole-column statistics, so splitting
a big sheet would change the answers. 100k rows x 17 columns take ~8 s; add helpers when a real sheet is too slow."""
from anomaly_hunter.engine.limits import suggest_limits_dict
from anomaly_hunter.engine.load import load_from_records, numbers
from anomaly_hunter.engine.pipeline import knobs, score


def scan(columns, rows, limits=None, order_by=None, strength=5):
    """-> (DataFrame, verdict per row, suggested limits, limits used, detector status). strength 0-10, see knobs()."""
    df, types, errors = load_from_records(columns, rows)
    suggested = suggest_limits_dict(df, numbers(types), knobs(strength)[1])
    used = {**suggested, **(limits or {})}
    out, status = score(df, types, errors, used, order_by, strength)
    return df, out, suggested, used, status
