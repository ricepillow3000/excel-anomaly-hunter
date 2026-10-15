"""Blind held-out benchmark: 14 business domains written without looking at the detector.
Same format as datasets.py: {name, grid, header, planted [{row, col, kind, true}], totals, idcols}.
Extra keys: dup_sources = grid rows that a planted duplicate_row copies (the original, not an error).
Planted kinds: decimal_x10/x100/x1000, sign_flip, percent_as_whole, excel_error, blank, text_variant,
duplicate_row (true None), date_far, sum_mismatch, abbreviation."""
import math
import numpy as np
from datasets import sheet, day

x10 = lambda v: round(v * 10, 4) if isinstance(v, float) else v * 10
x100 = lambda v: round(v * 100, 4) if isinstance(v, float) else v * 100
x1000 = lambda v: round(v * 1000, 4) if isinstance(v, float) else v * 1000
neg = lambda v: -v
pct = lambda v: round(v * 100, 2)
off37 = lambda v: round(v * 1.37, 2)
far = lambda yr: (lambda v: yr + str(v)[4:])


class Pick:
    """Chooses distinct data rows for plants, at least 3 rows apart, optionally where the column meets a condition."""

    def __init__(self, R, rows, header):
        self.R, self.rows, self.header, self.used = R, rows, header, set()

    def __call__(self, col=None, cond=None, gap=3):
        j = self.header.index(col) if col else None
        n = len(self.rows)
        for _ in range(20000):
            r = int(self.R.randint(2, n - 2))
            if any(abs(r - u) < gap for u in self.used):
                continue
            if cond is not None and not cond(self.rows[r][j]):
                continue
            self.used.add(r)
            return r
        raise RuntimeError(f"no row for {col}")


def dup(rows, r, col):
    """Make data row r an exact copy of row r-1 (call before computing totals)."""
    rows[r] = list(rows[r - 1])
    return (r, col, "duplicate_row", lambda v: v)


def mk(name, header, rows, plants, **kw):
    d = sheet(name, header, rows, plants, **kw)
    d["dup_sources"] = []
    for p in d["planted"]:
        if p["kind"] == "duplicate_row":
            p["true"] = None
            d["dup_sources"].append(p["row"] - 1)
    return d


def make(seed):
    R = np.random.RandomState(seed)
    out = []
    s = f"_s{seed}"

    # 1 Data analytics - web sessions per day by channel
    chans = ["Organic Search", "Paid Search", "Email", "Social", "Direct"]
    base = dict(zip(chans, [4200, 2600, 950, 1400, 1900]))
    bnc = dict(zip(chans, [0.38, 0.45, 0.32, 0.58, 0.41]))
    cr = dict(zip(chans, [0.028, 0.034, 0.041, 0.012, 0.031]))
    rows = []
    for dd in range(40):
        wk = 1 + 0.12 * math.sin(2 * math.pi * dd / 7)
        for c in chans:
            ses = int(base[c] * wk * R.normal(1, 0.08))
            conv = int(R.binomial(ses, cr[c]))
            rows.append([day(dd), c, ses, round(float(np.clip(bnc[c] + R.normal(0, 0.03), 0.15, 0.85)), 3), conv,
                         round(conv * float(R.normal(86, 9)), 2)])
    H = ["Date", "Channel", "Sessions", "Bounce Rate", "Conversions", "Revenue"]
    P = Pick(R, rows, H)
    out.append(mk("web_sessions" + s, H, rows, [
        (P("Bounce Rate"), "Bounce Rate", "percent_as_whole", pct),
        (P("Revenue", lambda v: v >= 500), "Revenue", "decimal_x100", x100),
        (P("Channel", lambda v: v == "Paid Search"), "Channel", "text_variant", "paid search"),
        (P(), "Conversions", "excel_error", "#DIV/0!"),
        (P(), "Date", "date_far", far("2084"))]))

    # 2 Product management - feature backlog
    feats = ["Bulk export", "SSO login", "Dark mode", "Audit log", "CSV import", "Webhooks", "Usage alerts", "Role permissions",
             "Invoice PDF", "Search filters", "Mobile push", "API rate limits", "Two-factor auth", "Saved views", "Comment threads",
             "Slack integration"]
    areas = ["for billing", "in dashboard", "for admins", "in reports", "for API", "in mobile app"]
    combos = [f"{f} {a}" for f in feats for a in areas]
    R.shuffle(combos)
    owners = ["Priya Patel", "Marcus Chen", "Elena Rossi", "Sam Okafor", "Jordan Lee", "Aisha Khan"]
    rows = []
    for k in range(96):
        pts = int(R.choice([1, 2, 3, 5, 8, 13], p=[.1, .2, .25, .25, .15, .05]))
        rows.append(["PRD-%d" % (1040 + k), combos[k],
                     str(R.choice(["Backlog", "In Progress", "In Review", "Done"], p=[.35, .25, .15, .25])),
                     str(R.choice(["Low", "Medium", "High", "Critical"], p=[.25, .4, .25, .1])), pts,
                     max(0.5, round(pts * float(R.uniform(0.6, 1.1)) * 2) / 2), str(R.choice(owners))])
    H = ["Ticket ID", "Feature", "Status", "Priority", "Story Points", "Estimate (days)", "Owner"]
    P = Pick(R, rows, H)
    out.append(mk("product_backlog" + s, H, rows, [
        (P("Priority", lambda v: v == "High"), "Priority", "abbreviation", "Hi"),
        (P("Status", lambda v: v == "In Progress"), "Status", "abbreviation", "In Prog"),
        (P("Story Points", lambda v: v in (5, 8)), "Story Points", "decimal_x10", x10),
        (P(), "Owner", "blank", ""),
        (P("Estimate (days)", lambda v: v >= 2), "Estimate (days)", "sign_flip", neg)], idcols=["Ticket ID"]))

    # 3 Supply chain / procurement - PO lines (title row + totals row)
    sups = ["Acme Industrial", "Northwind Supply", "Globex Parts", "Initech Components", "Umbrella Packaging", "Stark Fasteners"]
    cat = {sp: [("SKU-%d%03d" % (i + 1, q), round(float(R.uniform(1.8, 85)), 2)) for q in range(8)] for i, sp in enumerate(sups)}
    rows, po, t = [], 245100, 0.0
    while len(rows) < 150:
        sp = str(R.choice(sups)); od = int(t); sd = od + int(R.randint(3, 13))
        for q in R.choice(8, size=int(R.randint(1, 5)), replace=False):
            sku, price = cat[sp][int(q)]
            qty = int(R.choice([10, 20, 25, 40, 50, 75, 100, 150, 200, 250]))
            rows.append(["PO-%d" % po, sp, sku, qty, price, round(qty * price, 2), day(od), day(sd)])
        po += 1; t += float(R.uniform(0.3, 1.2))
    rows = rows[:150]
    H = ["PO Number", "Supplier", "SKU", "Qty", "Unit Price", "Line Total", "Order Date", "Ship Date"]
    P = Pick(R, rows, H)
    pl = [dup(rows, P(), "PO Number")]
    pl += [(P(), "Line Total", "sum_mismatch", off37),
           (P("Unit Price", lambda v: v >= 3), "Unit Price", "decimal_x100", x100),
           (P(), "Ship Date", "date_far", far("1902"))]
    out.append(mk("procurement_po" + s, H, rows, pl, title=[["Purchase Order Lines - Q1 FY2026"]],
                  totals=[["Total", "", "", sum(r[3] for r in rows), "", round(sum(r[5] for r in rows), 2), "", ""]],
                  idcols=["PO Number", "SKU"]))

    # 4 Retail inventory - SKU x store
    stores = ["Downtown", "Airport", "Riverside Mall", "Northgate"]
    nouns = ["Water Bottle", "Phone Case", "Notebook", "Sunglasses", "Headphones", "Travel Pillow", "Snack Bar", "Umbrella",
             "Charger", "Lip Balm", "Socks", "Mug"]
    rows = []
    for q in range(55):
        rp = int(R.randint(15, 61)); uc = round(float(R.uniform(2.5, 65)), 2)
        prod = f"{R.choice(['Classic', 'Pro', 'Mini', 'Eco', 'Deluxe'])} {nouns[q % len(nouns)]}"
        for st in stores:
            rows.append([400100 + q, prod, st, int(rp * R.uniform(0.6, 4)), rp, uc])
    H = ["SKU", "Product", "Store", "On Hand", "Reorder Point", "Unit Cost"]
    P = Pick(R, rows, H)
    out.append(mk("retail_inventory" + s, H, rows, [
        (P("On Hand", lambda v: v >= 20), "On Hand", "sign_flip", neg),
        (P(), "Unit Cost", "decimal_x1000", x1000),
        (P("Store", lambda v: v == "Airport"), "Store", "text_variant", "airport"),
        (P(), "Reorder Point", "excel_error", "#N/A")], idcols=["SKU"]))

    # 5 SaaS metrics - monthly
    rows, mrr = [], 118000.0
    for m in range(48):
        new = round(mrr * float(R.uniform(0.045, 0.06)))
        ch = -round(mrr * float(R.uniform(0.015, 0.03)))
        rate = round(-ch / mrr, 4)
        mrr = mrr + new + ch
        rows.append(["%d-%02d-01" % (2022 + m // 12, m % 12 + 1), round(mrr), new, ch, new + ch, rate])
    H = ["Month", "MRR", "New MRR", "Churned MRR", "Net New MRR", "Churn %"]
    P = Pick(R, rows, H)
    top = max(r[2] for r in rows)
    out.append(mk("saas_metrics" + s, H, rows, [
        (P("Churn %"), "Churn %", "percent_as_whole", pct),
        (P(), "Net New MRR", "sum_mismatch", lambda v: round(v * 1.37)),
        (P("New MRR", lambda v: v >= 0.6 * top), "New MRR", "decimal_x10", x10),
        (P(), "Month", "date_far", far("2084"))]))

    # 6 Customer support tickets
    med = {"Low": 10, "Normal": 5, "High": 2, "Urgent": 0.6}
    rows = []
    for k in range(260):
        pr = str(R.choice(list(med), p=[.3, .45, .2, .05]))
        rows.append(["TCK-%d" % (58000 + k), day(k // 4), str(R.choice(["Email", "Chat", "Phone", "Web Form"], p=[.4, .3, .15, .15])), pr,
                     max(0.1, round(float(R.lognormal(math.log(med[pr]), 0.5)), 1)), int(R.choice([1, 2, 3, 4, 5], p=[.05, .07, .15, .33, .40]))])
    H = ["Ticket ID", "Created", "Channel", "Priority", "First Response (hrs)", "CSAT"]
    P = Pick(R, rows, H)
    pl = [dup(rows, P(), "Ticket ID")]
    pl += [(P("First Response (hrs)", lambda v: v >= 3), "First Response (hrs)", "decimal_x100", x100),
           (P(), "CSAT", "blank", ""),
           (P("Priority", lambda v: v == "High"), "Priority", "text_variant", "HIGH"),
           (P(), "Created", "date_far", far("1902"))]
    out.append(mk("support_tickets" + s, H, rows, pl, idcols=["Ticket ID"]))

    # 7 Project management - task tracker (title rows + totals row)
    mods = ["General Ledger", "Payables", "Receivables", "Payroll", "Inventory", "Reporting", "Procurement", "Fixed Assets"]
    acts = ["Requirements", "Data mapping", "Configuration", "Integration build", "Unit testing", "UAT", "Training", "Cutover"]
    names = ["Priya Patel", "Marcus Chen", "Elena Rossi", "Sam Okafor", "Jordan Lee", "Aisha Khan", "Tom Brennan"]
    rows = []
    for k in range(64):
        mi, ai = divmod(k, 8)
        st = mi * 4 + ai * 9 + int(R.randint(0, 4)); dur = int(R.randint(5, 26))
        comp = round(float(np.clip((85 - st) / dur + R.normal(0, 0.08), 0, 1)), 2)
        bud = round(float(R.uniform(4000, 45000)), -2)
        rows.append(["T-%03d" % (k + 1), f"{mods[mi]}: {acts[ai]}", str(R.choice(names)), day(st), day(st + dur), comp, bud,
                     round(bud * comp * float(R.uniform(0.85, 1.2)))])
    H = ["Task ID", "Task", "Assignee", "Start", "End", "% Complete", "Budget", "Actual"]
    P = Pick(R, rows, H)
    out.append(mk("project_tasks" + s, H, rows, [
        (P("% Complete", lambda v: 0.2 <= v <= 0.95), "% Complete", "percent_as_whole", pct),
        (P("Actual", lambda v: v >= 15000), "Actual", "decimal_x10", x10),
        (P(), "End", "date_far", far("2084")),
        (P("Assignee", lambda v: v == "Marcus Chen"), "Assignee", "text_variant", "marcus chen"),
        (P(), "Budget", "excel_error", "#REF!")],
        title=[["Project: ERP Migration - Task Tracker"], ["Status as of 2026-03-31"]],
        totals=[["Total", "", "", "", "", "", sum(r[6] for r in rows), sum(r[7] for r in rows)]], idcols=["Task ID"]))

    # 8 Banking transactions
    accts = [4410023817, 4410051296, 4410078843, 4410090412]
    bal = {a: round(float(R.uniform(9000, 16000)), 2) for a in accts}
    rows = []
    for k in range(240):
        a = accts[int(R.randint(0, 4))]
        ty = str(R.choice(["Deposit", "Withdrawal", "Transfer", "Fee", "Card Payment"], p=[.25, .4, .15, .05, .15]))
        amt = {"Deposit": lambda: R.uniform(250, 3200), "Withdrawal": lambda: -R.uniform(20, 900),
               "Transfer": lambda: -R.uniform(100, 1500), "Fee": lambda: -R.choice([2.5, 5, 12, 35]),
               "Card Payment": lambda: -R.uniform(5, 250)}[ty]()
        amt = round(float(amt), 2)
        bal[a] = round(bal[a] + amt, 2)
        rows.append([90011000 + k, day(k // 4), a, ty, amt, bal[a]])
    H = ["Txn ID", "Date", "Account No.", "Type", "Amount", "Balance"]
    P = Pick(R, rows, H)
    pl = [dup(rows, P(), "Txn ID")]
    pl += [(P(), "Balance", "sign_flip", neg),
           (P(), "Balance", "decimal_x10", x10),
           (P("Type", lambda v: v == "Withdrawal"), "Type", "text_variant", "withdrawal"),
           (P(), "Amount", "excel_error", "#VALUE!")]
    out.append(mk("bank_transactions" + s, H, rows, pl, idcols=["Txn ID", "Account No."]))

    # 9 Clinical trial vitals - 40 subjects x 4 visits
    visits = ["Screening", "Week 4", "Week 8", "Week 12"]
    rows = []
    for sj in range(40):
        bs, bd, bh, bw = R.normal(128, 12), R.normal(82, 7), R.normal(72, 8), R.uniform(54, 112)
        for v in visits:
            rows.append(["S-%04d" % (1001 + sj), v, int(round(bs + R.normal(0, 6))), int(round(bd + R.normal(0, 4))),
                         int(round(bh + R.normal(0, 5))), round(float(bw + R.normal(0, 1.2)), 1)])
    H = ["Subject ID", "Visit", "Systolic (mmHg)", "Diastolic (mmHg)", "Heart Rate (bpm)", "Weight (kg)"]
    P = Pick(R, rows, H)
    out.append(mk("clinical_vitals" + s, H, rows, [
        (P(), "Systolic (mmHg)", "decimal_x10", x10),
        (P(), "Diastolic (mmHg)", "blank", ""),
        (P("Visit", lambda v: v == "Week 8"), "Visit", "text_variant", "week 8"),
        (P(), "Weight (kg)", "sign_flip", neg),
        (P(), "Heart Rate (bpm)", "excel_error", "#N/A")], idcols=["Subject ID"]))

    # 10 E-commerce orders
    prices = {"Electronics": (80, 600), "Home": (20, 200), "Apparel": (15, 90), "Beauty": (8, 60), "Toys": (10, 80)}
    oid = 2310000 + np.cumsum(R.randint(1, 5, 300))
    rows = []
    for k in range(300):
        c = str(R.choice(list(prices), p=[.2, .25, .25, .15, .15]))
        u = int(R.choice([1, 2, 3, 4, 5, 6], p=[.45, .25, .13, .08, .05, .04]))
        pr = round(float(R.uniform(*prices[c])), 2)
        dc = float(R.choice([0, 0, 0, 0.05, 0.1, 0.15, 0.2, 0.25]))
        rows.append([int(oid[k]), day(k // 5), c, u, pr, dc, round(u * pr * (1 - dc), 2)])
    H = ["Order ID", "Order Date", "Category", "Units", "Unit Price", "Discount", "Order Total"]
    P = Pick(R, rows, H)
    out.append(mk("ecommerce_orders" + s, H, rows, [
        (P("Discount", lambda v: v >= 0.1), "Discount", "percent_as_whole", pct),
        (P(), "Order Total", "sum_mismatch", off37),
        (P("Category", lambda v: v == "Electronics"), "Category", "abbreviation", "Elec"),
        (P("Unit Price", lambda v: v >= 15), "Unit Price", "decimal_x100", x100),
        (P(), "Order Date", "date_far", far("2084"))], idcols=["Order ID"]))

    # 11 Ad campaigns (title row + totals row)
    themes = ["Spring Sale", "Brand Awareness", "Retargeting", "Product Launch", "Webinar Promo", "Free Trial", "Holiday Push",
              "Lead Gen", "App Install"]
    auds = ["Lookalike", "In-market", "Past Buyers", "SMB Owners", "Students", "Parents", "Tech Pros", "Broad"]
    plat = {"Google Ads": (0.035, 1.6), "Meta": (0.012, 0.75), "LinkedIn": (0.006, 4.2), "TikTok": (0.009, 0.55)}
    rows = []
    for th in themes:
        for au in auds:
            pf = str(R.choice(list(plat)))
            imp = int(R.lognormal(math.log(150000), 0.6))
            clk = int(imp * plat[pf][0] * R.uniform(0.75, 1.3))
            sp = round(clk * plat[pf][1] * float(R.uniform(0.8, 1.25)), 2)
            rows.append([f"{th} - {au}", pf, imp, clk, round(clk / imp, 4), sp, round(sp / clk, 2)])
    H = ["Campaign", "Platform", "Impressions", "Clicks", "CTR", "Spend", "CPC"]
    P = Pick(R, rows, H)
    si, sc, ss = sum(r[2] for r in rows), sum(r[3] for r in rows), round(sum(r[5] for r in rows), 2)
    out.append(mk("ad_campaigns" + s, H, rows, [
        (P("CTR", lambda v: v >= 0.012), "CTR", "percent_as_whole", pct),
        (P("CPC", lambda v: v >= 1.2), "CPC", "decimal_x10", x10),
        (P(), "Spend", "sign_flip", neg),
        (P("Platform", lambda v: v == "Meta"), "Platform", "text_variant", "Meta "),
        (P(), "Clicks", "excel_error", "#REF!")],
        title=[["Paid Media Performance - Q1 2026"]],
        totals=[["Total", "", si, sc, round(sc / si, 4), ss, round(ss / sc, 2)]]))

    # 12 Fleet / transport - 12 vehicles x 18 days
    veh = ["TRK-%03d" % (201 + v) for v in range(12)]
    vb = {v: (float(R.uniform(220, 480)), float(R.uniform(0.27, 0.38))) for v in veh}
    rows = []
    for dd in range(18):
        fp = 1.68 + 0.04 * math.sin(dd / 3)
        for v in veh:
            km = round(vb[v][0] * float(R.uniform(0.7, 1.3)), 1)
            lit = round(km * vb[v][1] * float(R.normal(1, 0.04)), 1)
            rows.append([v, day(dd), km, lit, round(lit * fp, 2)])
    H = ["Vehicle ID", "Date", "Km Driven", "Fuel (L)", "Fuel Cost"]
    P = Pick(R, rows, H)
    pl = [dup(rows, P(), "Vehicle ID")]
    pl += [(P("Km Driven", lambda v: v >= 200), "Km Driven", "decimal_x10", x10),
           (P(), "Fuel (L)", "blank", ""),
           (P(), "Fuel Cost", "decimal_x1000", x1000),
           (P(), "Date", "date_far", far("1902"))]
    out.append(mk("fleet_trips" + s, H, rows, pl, idcols=["Vehicle ID"]))

    # 13 Agriculture - field yields
    crops = {"Wheat": (4.1, 0.5), "Corn": (10.2, 1.1), "Soybean": (3.1, 0.35), "Barley": (3.9, 0.45), "Canola": (2.3, 0.3)}
    rows = []
    for k in range(84):
        c = str(R.choice(list(crops), p=[.3, .25, .2, .15, .1]))
        rows.append(["F-%03d" % (101 + k), c, round(float(R.uniform(6, 120)), 1), round(float(R.normal(*crops[c])), 2),
                     int(R.normal(540, 90)), day(200 + int(R.randint(0, 60)))])
    H = ["Field ID", "Crop", "Hectares", "Yield (t/ha)", "Rainfall (mm)", "Harvest Date"]
    P = Pick(R, rows, H)
    out.append(mk("agriculture_fields" + s, H, rows, [
        (P("Crop", lambda v: v == "Soybean"), "Crop", "abbreviation", "Soy"),
        (P("Crop", lambda v: v == "Corn"), "Crop", "text_variant", "corn"),
        (P("Yield (t/ha)", lambda v: 3 <= v <= 6), "Yield (t/ha)", "decimal_x10", x10),
        (P(), "Rainfall (mm)", "sign_flip", neg),
        (P(), "Hectares", "excel_error", "#VALUE!")], idcols=["Field ID"]))

    # 14 Telecom - customer bills (Monthly Bill = Plan Fee + Add-ons + Taxes & Fees)
    plans = {"Basic": (25, 2.0), "Standard": (45, 8.0), "Premium": (70, 22.0), "Unlimited": (95, 55.0)}
    ids = np.sort(R.choice(np.arange(7700000, 7799999), 280, replace=False))
    rows = []
    for k in range(280):
        pn = str(R.choice(list(plans), p=[.3, .35, .2, .15]))
        fee, gb = plans[pn]
        add = int(R.choice([0, 0, 0, 5, 10, 15]))
        tax = round((fee + add) * float(R.choice([0.08, 0.105, 0.12])), 2)
        rows.append([int(ids[k]), pn, round(float(R.lognormal(math.log(gb), 0.45)), 1), int(R.lognormal(math.log(380), 0.55)),
                     fee, add, tax, round(fee + add + tax, 2)])
    H = ["Customer ID", "Plan", "Data (GB)", "Minutes", "Plan Fee", "Add-ons", "Taxes & Fees", "Monthly Bill"]
    P = Pick(R, rows, H)
    pl = [dup(rows, P(), "Customer ID")]
    pl += [(P(), "Monthly Bill", "sum_mismatch", off37),
           (P("Plan", lambda v: v == "Standard"), "Plan", "abbreviation", "Std"),
           (P("Minutes", lambda v: v >= 150), "Minutes", "decimal_x100", x100),
           (P(), "Data (GB)", "blank", "")]
    out.append(mk("telecom_customers" + s, H, rows, pl, idcols=["Customer ID"]))
    return out
