"""A synthetic loan book in the shape of the delinquency sheets this tool is judged on (the real file stays out of this
public repo): borrowers with age, gender, region, income, a loan that is income x debt ratio, days past due and a
yes/no delinquent flag. Honest group differences are built in (the South is delinquent more often; incomes rise with
age): they are facts about the borrowers, never mistakes. The planted mistakes sit at known rows."""
import random

COLS = ["Borrower_ID", "Age", "Gender", "Region", "Income", "Debt_Ratio", "Loan_Amount", "Days_Past_Due", "Delinquent"]
REGIONS = ["North", "South", "East", "West"]


def sheet(n=480, seed=11):
    """-> (rows, {kind: {row index: words its reason must hold}}, {row index: (column, the value before the mistake)})"""
    r = random.Random(seed)
    rows = []
    for k in range(n):
        age = r.randint(21, 75)
        region = REGIONS[k % 4]
        income = round(r.lognormvariate(10.6 + (0.25 if 40 <= age < 60 else 0), 0.35) / 100) * 100  # ~40k, more mid-career
        ratio = round(r.uniform(0.05, 0.6), 3)
        late = r.random() < (0.32 if region == "South" else 0.1)  # an honest gap: the South's loans go bad more often
        dpd = r.randint(30, 120) if late else (r.randint(1, 20) if r.random() < 0.1 else 0)
        rows.append([f"B{k:05d}", age, r.choice(["Female", "Male"]), region, income, ratio, round(income * ratio, 2), dpd,
                     "Yes" if dpd >= 30 else "No"])
    planted, was = {}, {}

    def plant(kind, i, col, value, says):
        was[i] = (col, rows[i][COLS.index(col)])
        rows[i][COLS.index(col)] = value
        planted.setdefault(kind, {})[i] = says

    plant("income x10", 17, "Income", rows[17][4] * 10, "Income")
    plant("ratio typed as a percent", 41, "Debt_Ratio", round(rows[41][5] * 100, 1), "Debt_Ratio")
    plant("loan sign flipped", 66, "Loan_Amount", -rows[66][6], "Loan_Amount")
    plant("blank days past due", 90, "Days_Past_Due", "", "Blank cell in column Days_Past_Due")
    plant("age x10", 123, "Age", 230 if rows[123][1] == 23 else rows[123][1] * 10, "Age")
    plant("gender lowercase", 150, "Gender", rows[150][2].lower(), "Gender")
    plant("delinquent capitals", 177, "Delinquent", rows[177][8].lower() + " ", "Delinquent")
    plant("region misspelt", 205, "Region", {"North": "Noth", "South": "Souht", "East": "Eats", "West": "Wset"}[rows[205][3]], "Region")
    plant("excel error", 240, "Income", "#N/A", "#N/A")
    rows[300] = list(rows[299])  # a double entry
    planted["duplicate"] = {300: "Duplicate of row"}
    return rows, planted, was
