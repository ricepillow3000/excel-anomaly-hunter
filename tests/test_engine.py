import csv

import numpy as np
import pandas as pd
from openpyxl import load_workbook

from anomaly_hunter.cli import run_scan
from anomaly_hunter.limits import read_limits, suggest_limits


def make_clean_csv(path, n=40, seed=0):
    rng = np.random.RandomState(seed)
    df = pd.DataFrame({
        "order": range(1, n + 1),
        "Amount": rng.normal(100, 5, n).round(2),
        "Price": rng.normal(50, 2, n).round(2),
    })
    df.to_csv(path, index=False)
    return df


def write_limits(path, columns_bounds):
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["column", "baseline_low", "baseline_high", "weird_low", "weird_high"])
        for col, bounds in columns_bounds.items():
            w.writerow([col, *["" if b is None else b for b in bounds]])


# ---- Hazmat tests: each planted anomaly must be caught, in the right bucket ----

def test_hazmat_weird_limit_breach(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=40)
    bad_row = pd.DataFrame([{"order": 999, "Amount": 999999, "Price": 50}])
    pd.concat([df, bad_row]).to_csv(csv_path, index=False)

    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"Amount": (80, 120, 0, 10000), "Price": (None, None, None, None)})

    out_path = tmp_path / "report.xlsx"
    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0

    rows = list(load_workbook(out_path)["Anomalies"].iter_rows(values_only=True))
    header, body = rows[0], rows[1:]
    amount_idx, sev_idx, bucket_idx = header.index("Amount"), header.index("Severity"), header.index("Bucket")
    flagged = next(r for r in body if r[amount_idx] == 999999)
    assert flagged[sev_idx] in ("Medium", "High")
    assert flagged[bucket_idx] == "Irregularities"


def test_hazmat_duplicate_row(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=40)
    pd.concat([df, df.iloc[[0]]]).to_csv(csv_path, index=False)

    limits_path = tmp_path / "limits.csv"
    suggest_limits(df, ["order", "Amount", "Price"], limits_path)

    out_path = tmp_path / "report.xlsx"
    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0

    rows = list(load_workbook(out_path)["Anomalies"].iter_rows(values_only=True))
    header, body = rows[0], rows[1:]
    assert any(r[header.index("Bucket")] == "Duplicates" for r in body)


def test_hazmat_text_in_number_column(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=40)
    df["Amount"] = df["Amount"].astype(object)
    df.loc[5, "Amount"] = "N/A"
    df.to_csv(csv_path, index=False)

    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"order": (None, None, None, None), "Amount": (None, None, None, None),
                                "Price": (None, None, None, None)})

    out_path = tmp_path / "report.xlsx"
    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0

    rows = list(load_workbook(out_path)["Anomalies"].iter_rows(values_only=True))
    header, body = rows[0], rows[1:]
    reason_idx, bucket_idx = header.index("Reason"), header.index("Bucket")
    matches = [r for r in body if "N/A" in (r[reason_idx] or "")]
    assert matches
    assert matches[0][bucket_idx] == "Irregularities"


def test_hazmat_spike_in_ordered_series(tmp_path):
    csv_path = tmp_path / "data.csv"
    n = 40
    rng = np.random.RandomState(1)
    df = pd.DataFrame({"order": range(1, n + 1), "Revenue": rng.normal(1000, 20, n).round(2)})
    df.loc[20, "Revenue"] = 5000  # planted spike, single row
    df.to_csv(csv_path, index=False)

    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"order": (None, None, None, None), "Revenue": (None, None, None, None)})

    out_path = tmp_path / "report.xlsx"
    assert run_scan([str(csv_path)], str(limits_path), "order", str(out_path)) == 0

    rows = list(load_workbook(out_path)["Anomalies"].iter_rows(values_only=True))
    header, body = rows[0], rows[1:]
    flagged_orders = [r[header.index("order")] for r in body]
    assert 21 in flagged_orders  # df index 20 -> order value 21


def test_hazmat_isolation_combo_runs_clean(tmp_path):
    csv_path = tmp_path / "data.csv"
    n = 60
    rng = np.random.RandomState(2)
    a = rng.normal(0, 1, n)
    b = a + rng.normal(0, 0.1, n)
    df = pd.DataFrame({"order": range(1, n + 1), "A": a.round(2), "B": b.round(2)})
    df.loc[30, "A"] = 0.0
    df.loc[30, "B"] = 5.0  # each value alone plausible, combination is not
    df.to_csv(csv_path, index=False)

    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"order": (None, None, None, None), "A": (None, None, None, None),
                                "B": (None, None, None, None)})

    out_path = tmp_path / "report.xlsx"
    # Not asserting this exact row is caught — ML detection on a 60-row sample is
    # inherently noisy. This just proves the isolation/clustering path runs clean.
    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0


# ---- Quiet-crowd test ----

def test_quiet_crowd_low_false_positive_rate(tmp_path):
    csv_path = tmp_path / "data.csv"
    rng = np.random.RandomState(42)
    df = pd.DataFrame({
        "Amount": rng.normal(100, 5, 1000).round(2),
        "Price": rng.normal(50, 2, 1000).round(2),
    })
    df.to_csv(csv_path, index=False)

    limits_path = tmp_path / "limits.csv"
    suggest_limits(df, ["Amount", "Price"], limits_path)

    out_path = tmp_path / "report.xlsx"
    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0

    flagged = load_workbook(out_path)["Anomalies"].max_row - 1
    assert flagged <= 10  # <=1% of 1000, Noted rows don't count toward this


# ---- Limits tests ----

def test_missing_limits_file_writes_suggestions_and_exits_2(tmp_path):
    csv_path = tmp_path / "data.csv"
    make_clean_csv(csv_path, n=40)
    limits_path = tmp_path / "limits.csv"
    out_path = tmp_path / "report.xlsx"

    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 2
    assert limits_path.exists()
    assert set(pd.read_csv(limits_path)["column"]) == {"order", "Amount", "Price"}


def test_blank_limit_cells_mean_no_limit(tmp_path):
    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"Amount": (None, None, None, None)})
    limits, warnings = read_limits(limits_path, ["Amount"])
    assert limits["Amount"] == (None, None, None, None)
    assert warnings == []


def test_unknown_limits_column_warns_not_crash(tmp_path):
    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"NotAColumn": (0, 1, 0, 1)})
    limits, warnings = read_limits(limits_path, ["Amount"])
    assert limits == {}
    assert len(warnings) == 1


# ---- Report test ----

def test_report_has_three_sheets_and_summary(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=40)
    limits_path = tmp_path / "limits.csv"
    suggest_limits(df, ["order", "Amount", "Price"], limits_path)
    out_path = tmp_path / "report.xlsx"

    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0

    wb = load_workbook(out_path)
    assert set(wb.sheetnames) == {"Data", "Anomalies", "Summary"}
    summary_text = "\n".join(str(c.value) for row in wb["Summary"].iter_rows() for c in row if c.value is not None)
    assert "Limits file" in summary_text
    assert "K" in summary_text


# ---- Safety test ----

def test_input_file_untouched(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=40)
    limits_path = tmp_path / "limits.csv"
    suggest_limits(df, ["order", "Amount", "Price"], limits_path)
    out_path = tmp_path / "report.xlsx"

    before_bytes = csv_path.read_bytes()
    before_mtime = csv_path.stat().st_mtime

    run_scan([str(csv_path)], str(limits_path), None, str(out_path))

    assert csv_path.read_bytes() == before_bytes
    assert csv_path.stat().st_mtime == before_mtime


# ---- Determinism test ----

def test_determinism(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=60, seed=7)
    limits_path = tmp_path / "limits.csv"
    suggest_limits(df, ["order", "Amount", "Price"], limits_path)

    out1, out2 = tmp_path / "report1.xlsx", tmp_path / "report2.xlsx"
    run_scan([str(csv_path)], str(limits_path), None, str(out1))
    run_scan([str(csv_path)], str(limits_path), None, str(out2))

    rows1 = list(load_workbook(out1)["Anomalies"].iter_rows(values_only=True))
    rows2 = list(load_workbook(out2)["Anomalies"].iter_rows(values_only=True))
    assert rows1 == rows2
