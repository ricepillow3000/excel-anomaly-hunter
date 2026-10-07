"""Held-out sheets (skeptic): negative controls, heavy tails, ID look-alikes, header/total edge cases, formulas.
Kinds that must NEVER get a value-changing fix: real_outlier. Columns in `protect` must never be written."""
import numpy as np
from datasets import sheet, day


def make(seed):
    R = np.random.RandomState(seed)
    out = []

    # P&L / GL: ~40% negative signed amounts; variance mixed sign; one x100 slip
    n = 100
    rows = []
    for k in range(n):
        amt = round(float(R.normal(0, 1)) * 900 + (300 if R.rand() < .6 else -300), 2)
        bud = round(float(R.uniform(-2000, 4000)), 2)
        rows.append([day(k), ["Revenue", "COGS", "Opex", "Accrual"][k % 4], amt, bud, round(bud - amt, 2)])
    d = sheet(f"pnl_signed_s{seed}", ["Date", "Line", "Amount", "Budget", "Variance"], rows,
              [(33, "Amount", "decimal_x100", lambda v: round(v * 100, 2))])
    d["formulas"] = {"Variance": True}
    d["protect"] = ["Variance"]
    out.append(d)

    # Heavy tail: lognormal sigma 1.2 claims + a true whale (must not be 'corrected')
    n = 150
    rows = [["C%05d" % k, day(k), ["Auto", "Home", "Commercial"][k % 3], round(float(R.lognormal(8, 1.2)), 2)] for k in range(n)]
    out.append(sheet(f"heavy_tail_s{seed}", ["Claim", "Date", "Line", "Paid"], rows,
                     [(40, "Paid", "real_outlier", lambda v: round(v * 60, 2)),
                      (90, "Paid", "decimal_x1000", lambda v: round(v * 1000, 2))]))

    # ID look-alikes that are measurements + real IDs
    n = 80
    rows = [[int(R.randint(1000000, 9999999)), 2019 + k % 7, int(R.randint(100000, 900000)), int(R.choice([2134, 10001, 60601, 94105])),
             k + 1, int(R.uniform(150000, 650000))] for k in range(n)]
    out.append(sheet(f"id_lookalikes_s{seed}", ["MRN", "Year", "Impressions", "ZIP", "Reading", "Price"], rows,
                     [(20, "Price", "decimal_x10", lambda v: v * 10)], idcols=["MRN", "ZIP"]))

    # Wide financial summary: header row of years; an unlabelled sum row
    metrics = ["Revenue", "COGS", "Gross Profit", "SG&A", "R&D", "EBITDA", "D&A", "EBIT", "Interest", "Taxes", "Net Income", "Capex"]
    rows = [[m] + [round(float(R.uniform(100, 900)), 1) for _ in range(5)] for m in metrics]
    d = sheet(f"wide_years_s{seed}", ["($mm)", 2022, 2023, 2024, 2025, 2026], rows, [],
              title=[["Acme Corp - Income Statement Summary"]],
              totals=[[""] + [round(sum(r[j] for r in rows), 1) for j in range(1, 6)]])
    out.append(d)
    return out
