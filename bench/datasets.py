"""15 industry sheets as Excel would hand them to the panel (used-range values, dates as yyyy-mm-dd).
Each: grid (2D list), header (grid row index of the header), planted [{row, col, kind, true}],
totals [grid rows that are total/summary rows], idcols [columns that are identifiers]."""
import datetime as dt
import numpy as np

D0 = dt.date(2026, 1, 5)
day = lambda k: (D0 + dt.timedelta(days=int(k))).isoformat()


def sheet(name, header, rows, plants, title=(), totals=(), idcols=()):
    """rows: list of lists. plants: [(data_row, col, kind, new_value)] applied in place; true = old value.
    totals: list of rows appended at the end (summary rows)."""
    rows = [list(r) for r in rows]
    planted = []
    off = len(title) + 1
    for r, col, kind, new in plants:
        j = header.index(col)
        old = rows[r][j]
        rows[r][j] = new(old) if callable(new) else new
        planted.append({"row": off + r, "col": col, "kind": kind, "true": old})
    grid = [list(t) + [""] * (len(header) - len(t)) for t in title] + [header] + rows
    tot = []
    for t in totals:
        tot.append(len(grid))
        grid.append(t)
    return {"name": name, "grid": grid, "header": len(title), "planted": planted, "totals": tot, "idcols": list(idcols)}


def make(seed=7):
    R = np.random.RandomState(seed)
    out = []

    # 1 Finance - general ledger
    n = 120
    rows = [[day(k // 3), int(R.choice([4000, 4100, 5000, 5100, 6200])), "Entry %d" % k,
             round(float(abs(R.normal(1200, 300))), 2)] for k in range(n)]
    out.append(sheet("finance_gl", ["Date", "Account", "Description", "Amount"], rows,
                     [(10, "Amount", "decimal_x100", lambda v: round(v * 100, 2)),
                      (40, "Amount", "sign_flip", lambda v: -v),
                      (70, "Amount", "excel_error", "#N/A")],
                     totals=[["Total", "", "", round(sum(r[3] for r in rows), 2)]], idcols=["Account"]))

    # 2 Investment banking comps
    n = 30
    rows = []
    for k in range(n):
        rev = float(R.uniform(500, 5000)); ebitda = rev * float(R.uniform(0.12, 0.3)); ev = ebitda * float(R.uniform(8, 14))
        rows.append(["Co %d" % k, "T%02d" % k, round(ev * 0.85, 1), round(ev, 1), round(rev, 1), round(ebitda, 1), round(ev / ebitda, 2)])
    out.append(sheet("ib_comps", ["Company", "Ticker", "Market Cap ($mm)", "EV ($mm)", "Revenue ($mm)", "EBITDA ($mm)", "EV/EBITDA"], rows,
                     [(5, "Revenue ($mm)", "decimal_x1000", lambda v: round(v * 1000, 1)),
                      (12, "EV/EBITDA", "decimal_x10", lambda v: round(v * 10, 2)),
                      (20, "EV/EBITDA", "excel_error", "#DIV/0!")],
                     title=[["Comparable Companies Analysis"], ["($ in millions)"]],
                     totals=[["Mean", "", "", "", "", "", 10.9], ["Median", "", "", "", "", "", 10.7]]))

    # 3 Quant - daily prices / returns
    n = 250
    px = 100 * np.exp(np.cumsum(R.normal(0.0004, 0.012, n)))
    rows = [[day(k), round(float(px[k]), 2), round(float(px[k] / px[k - 1] - 1) if k else 0.0, 5), int(R.normal(1e6, 2e5))] for k in range(n)]
    out.append(sheet("quant_returns", ["Date", "Close", "Return", "Volume"], rows,
                     [(60, "Close", "decimal_x10", lambda v: round(v * 10, 2)),
                      (120, "Return", "percent_x100", lambda v: round(v * 100, 3)),
                      (200, "Close", "blank", "")]))

    # 4 Supply chain inventory
    n = 80
    rows = [[100200 + k, "Part %d" % k, ["East", "West", "Central"][k % 3], int(R.randint(50, 400)), int(R.randint(20, 60)),
             int(R.randint(5, 30)), round(float(R.uniform(2, 40)), 2)] for k in range(n)]
    out.append(sheet("supply_inventory", ["SKU", "Description", "Warehouse", "On Hand", "Reorder Point", "Lead Time (days)", "Unit Cost"], rows,
                     [(7, "On Hand", "negative", lambda v: -v),
                      (25, "Lead Time (days)", "decimal_x10", lambda v: v * 10),
                      (50, "Unit Cost", "decimal_x100", lambda v: round(v * 100, 2)),
                      (33, "Warehouse", "text_variant", "east "),
                      (66, "Warehouse", "text_variant", "WEST")], idcols=["SKU"]))

    # 5 Healthcare vitals
    n = 150
    rows = [[int(R.randint(1000000, 9999999)), day(k // 5), int(R.randint(18, 90)), int(R.normal(75, 10)), int(R.normal(122, 14)),
             round(float(R.normal(98.4, 0.6)), 1), int(R.normal(105, 18))] for k in range(n)]
    out.append(sheet("healthcare_vitals", ["MRN", "Admit Date", "Age", "Heart Rate", "Systolic BP", "Temp (F)", "Glucose (mg/dL)"], rows,
                     [(15, "Age", "decimal_x10", lambda v: v * 10),
                      (60, "Temp (F)", "unit_c_in_f", lambda v: round((v - 32) * 5 / 9, 1)),
                      (90, "Glucose (mg/dL)", "unit_mmol", lambda v: round(v / 18, 1)),
                      (120, "Heart Rate", "excel_error", "#VALUE!")], idcols=["MRN"]))

    # 6 Construction budget (title rows, subtotals)
    rows = []
    for k in range(40):
        b = float(R.uniform(5000, 80000)); a = b * float(R.uniform(0.7, 1.15))
        rows.append(["%02d-%03d" % (3 + k // 10, 100 + k), "Line item %d" % k, round(b, 0), round(a, 0), round(b - a, 0), round(float(R.uniform(0.1, 1)), 2)])
    out.append(sheet("construction_budget", ["Cost Code", "Item", "Budget", "Actual", "Variance", "% Complete"], rows,
                     [(8, "% Complete", "percent_x100", lambda v: round(v * 100)),
                      (22, "Actual", "decimal_x10", lambda v: v * 10)],
                     title=[["Project: Riverside Medical Office Building"], ["Cost Report - Period 9"], [""]],
                     totals=[["", "Subtotal", round(sum(r[2] for r in rows)), round(sum(r[3] for r in rows)), "", ""],
                             ["", "Grand Total", round(sum(r[2] for r in rows)), round(sum(r[3] for r in rows)), "", ""]]))

    # 7 HR payroll
    n = 90
    rows = [[5000 + k, ["Sales", "Ops", "Finance", "IT"][k % 4], day(-int(R.randint(100, 3000))), int(R.normal(68000, 12000)),
             round(float(R.normal(40, 2)), 1)] for k in range(n)]
    out.append(sheet("hr_payroll", ["Employee ID", "Department", "Hire Date", "Salary", "Hours"], rows,
                     [(11, "Salary", "decimal_x10", lambda v: v * 10),
                      (45, "Hours", "decimal_x10", lambda v: v * 10),
                      (70, "Department", "text_variant", "sales")], idcols=["Employee ID"]))

    # 8 Marketing campaigns
    n = 60
    rows = []
    for k in range(n):
        imp = int(R.uniform(20000, 90000)); clk = int(imp * R.uniform(0.01, 0.04))
        rows.append([day(k), ["Search", "Social", "Email"][k % 3], round(float(R.uniform(300, 1500)), 2), imp, clk, round(clk / imp, 4)])
    out.append(sheet("marketing", ["Date", "Channel", "Spend", "Impressions", "Clicks", "CTR"], rows,
                     [(14, "CTR", "percent_x100", lambda v: round(v * 100, 2)),
                      (40, "Spend", "decimal_x1000", lambda v: round(v * 1000, 2))]))

    # 9 Sales orders
    n = 44
    rows = [[day(k), ["East", "West", "Central"][k % 3], ["Pen", "Binder", "Desk"][k % 3], int(R.randint(20, 95)), round(float(R.choice([1.99, 4.99, 19.99])), 2)] for k in range(n)]
    out.append(sheet("sales_orders", ["OrderDate", "Region", "Item", "Units", "UnitCost"], rows,
                     [(9, "Units", "negative", lambda v: -v), (30, "Units", "decimal_x100", lambda v: v * 100)]))

    # 10 Real estate
    n = 70
    rows = []
    for k in range(n):
        sq = int(R.uniform(900, 3500)); price = int(sq * R.uniform(180, 320))
        rows.append([70000 + k * 7, ["Austin", "Dallas", "Houston"][k % 3], sq, int(R.randint(2, 5)), price])
    out.append(sheet("real_estate", ["Property ID", "City", "Sq Ft", "Beds", "Price"], rows,
                     [(18, "Sq Ft", "decimal_div100", lambda v: round(v / 100)), (52, "Price", "decimal_x10", lambda v: v * 10)], idcols=["Property ID"]))

    # 11 Insurance claims
    n = 100
    rows = [["CLM-%05d" % k, day(k), ["Auto", "Home", "Life"][k % 3], round(float(R.lognormal(8, 0.5)), 2), int(R.randint(5, 60))] for k in range(n)]
    out.append(sheet("insurance_claims", ["Claim #", "Loss Date", "Policy Type", "Claim Amount", "Days to Settle"], rows,
                     [(30, "Days to Settle", "negative", lambda v: -v), (75, "Claim Amount", "decimal_x100", lambda v: round(v * 100, 2))]))

    # 12 Manufacturing QC
    n = 200
    rows = [["B%04d" % k, day(k // 4), round(float(R.normal(212, 3)), 1), round(float(R.normal(30, 1.5)), 2), round(float(abs(R.normal(0.02, 0.006))), 4)] for k in range(n)]
    out.append(sheet("manufacturing_qc", ["Batch", "Date", "Temperature", "Pressure", "Defect Rate"], rows,
                     [(50, "Defect Rate", "percent_x100", lambda v: round(v * 100, 2)), (150, "Pressure", "decimal_x10", lambda v: round(v * 10, 2))]))

    # 13 Education grades
    n = 60
    rows = [[2026000 + k, int(R.normal(78, 9)), int(R.normal(75, 10)), int(R.normal(80, 8))] for k in range(n)]
    out.append(sheet("education_grades", ["Student ID", "Midterm", "Project", "Final"], rows,
                     [(12, "Final", "decimal_x10", lambda v: v * 10), (40, "Midterm", "blank", "")], idcols=["Student ID"]))

    # 14 Energy meter
    n = 365
    rows = [[day(k), round(float(800 + 200 * np.sin(k / 58) + R.normal(0, 25)), 1), round(float(R.normal(55, 5)), 1)] for k in range(n)]
    out.append(sheet("energy_meter", ["Date", "kWh", "Peak kW"], rows,
                     [(100, "kWh", "decimal_x10", lambda v: round(v * 10, 1)), (250, "kWh", "negative", lambda v: -v)]))

    # 15 Logistics shipments
    n = 90
    rows = [[880000 + k, day(k), round(float(R.uniform(50, 900)), 1), int(R.uniform(100, 2500)), round(float(R.uniform(200, 3000)), 2)] for k in range(n)]
    out.append(sheet("logistics", ["Shipment ID", "Ship Date", "Weight (kg)", "Distance (km)", "Freight Cost"], rows,
                     [(20, "Weight (kg)", "unit_g_in_kg", lambda v: round(v * 1000)), (61, "Freight Cost", "excel_error", "#REF!")], idcols=["Shipment ID"]))
    return out
