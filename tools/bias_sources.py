"""Re-measure the public tables behind backend/anomaly_hunter/ai/bias_rules.json (docs/bias/FINDINGS.md).
Usage: python tools/bias_sources.py [--check] [--data DIR]
Each file is pinned by the commit in its URL and by its SHA-256. It is downloaded into its own new, empty temp folder
(or read from DIR/<name>/<file> with --data), checked, and read as plain text with pandas: nothing in it is ever run.
The raw tables are never committed (size, licences): only the rules this computes. --check exits 1 when a fresh
measurement differs from the committed JSON. Needs the internet (raw.githubusercontent.com) unless --data is given."""
import hashlib
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "backend" / "anomaly_hunter" / "ai" / "bias_rules.json"
RAW = "https://raw.githubusercontent.com/"
SOURCES = {
    "adult": {"title": "UCI Adult, US census 1994 (Becker and Kohavi)", "licence": "CC BY 4.0 (UCI); mirror has no licence of its own",
              "url": RAW + "jbrownlee/Datasets/d20fcb6402ae34e653d4513b00f39257bb37ed7f/adult-all.csv",
              "sha256": "21e0ea2f925a00338929a8c86c27354c72ac1c79819bcca81c7d91c3d64218c2"},
    "adult_test": {"title": "UCI Adult, its original test part as UCI writes it", "licence": "CC BY 4.0 (UCI)",
                   "url": RAW + "jbrownlee/Datasets/d20fcb6402ae34e653d4513b00f39257bb37ed7f/adult-test.csv",
                   "sha256": "72567b94f5c1a6f8501377dd80f93892c3848ff071cf91ba47e00b0785a28074"},
    "german": {"title": "Statlog German Credit (Hofmann), labels spelled out", "licence": "CC BY 4.0 (UCI); mirror README: public domain",
               "url": RAW + "stedy/Machine-Learning-with-R-datasets/ff933238d9c30da179b7e3ad4b6ca938d67efc53/credit.csv",
               "sha256": "5c9906df163beb8c7d9c497146d3bdf210c4816401f32b488d6c10fcbff0d048"},
    "insurance": {"title": "Medical costs teaching table (Lantz, Machine Learning with R), simulated from US census figures",
                  "licence": "none stated; mirror README: public domain",
                  "url": RAW + "stedy/Machine-Learning-with-R-datasets/ff933238d9c30da179b7e3ad4b6ca938d67efc53/insurance.csv",
                  "sha256": "505c1cbc2e63d0363bac59501563df2530aadf4cdb9cfee226f4ef32f5468281"},
    "compas": {"title": "ProPublica COMPAS, Broward County 2013-2014 (Machine Bias, 2016)",
               "licence": "no licence file; published by ProPublica for analysis",
               "url": RAW + "propublica/compas-analysis/bafff5da3f2e45eca6c2d5055faad269defd135a/compas-scores-two-years.csv",
               "sha256": "c451db85908b2f7fef1d83203bedf6b71ecda0d5af468d82ae62178f91d0cc7d"},
}
ADULT_COLS = ("age workclass fnlwgt education education_num marital occupation relationship race sex capital_gain "
              "capital_loss hours country income").split()
# the column words each topic covers (as engine/fairness.py splits a header); a rule is shown only for a topic the
# sheet has, and only on a sheet with a demographic column at all
TOPICS = {"sex": ["sex", "gender"], "race": ["race", "ethnicity", "ethnic"], "age": ["age", "dob", "birth", "birthday", "birthdate"],
          "marital": ["marital"], "employment": ["employment", "employed", "job", "occupation", "workclass"],
          "housing": ["housing", "tenure"], "smoker": ["smoker", "smoking", "smokes"],
          "place": ["location", "city", "state", "zip", "zipcode", "postal", "postcode", "country", "region", "neighborhood",
                    "neighbourhood", "county"]}
NAMES = {"Asian-Pac-Islander": "Asian or Pacific Islander people", "Black": "Black people", "White": "White people",
         "Married-civ-spouse": "married people", "Never-married": "never-married people", "Self-emp-inc": "the self-employed (incorporated)", "Private": "private-sector workers", "Male": "men", "Female": "women",
         "under 30": "people under 30", "45-59": "people aged 45-59", "60 and over": "people 60 and over", "30-44": "people aged 30-44",
         "rent": "renters", "own": "home owners", "for free": "people housed for free"}
BANDS = ([-np.inf, 30, 45, 60, np.inf], ["under 30", "30-44", "45-59", "60 and over"])  # the fairness report's age bands
pct = lambda v: f"{100 * v:.1f}%"
num = lambda v: f"{v:,.0f}"
name = lambda g: NAMES.get(str(g), str(g))


def fetch(key, folder):
    """The pinned file, checked against its SHA-256."""
    src = SOURCES[key]
    path = Path(folder) / key / src["url"].rsplit("/", 1)[1]
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=False)  # a new, empty folder for each download
        with urllib.request.urlopen(src["url"], timeout=60) as r:  # noqa: S310 - https constant above
            path.write_bytes(r.read())
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != src["sha256"]:
        raise SystemExit(f"{key}: SHA-256 differs from the pinned one - not measured")
    return path


def band(age):
    return pd.cut(pd.to_numeric(age), BANDS[0], right=False, labels=BANDS[1])


def rates(df, group, hit, least=0):
    """{group: (rows, rate)} for groups of at least `least` rows."""
    t = df.assign(_h=hit).groupby(group, observed=True)["_h"].agg(["size", "mean"])
    return {k: (int(n), float(m)) for k, (n, m) in t.iterrows() if n >= least}


def ends(r):
    hi, lo = max(r, key=lambda k: r[k][1]), min(r, key=lambda k: r[k][1])
    return hi, lo


def spread(x, groups):
    x = pd.to_numeric(x)
    return {k: (int(len(s)), float(s.median()), float(s.quantile(.25)), float(s.quantile(.75))) for k, s in x.groupby(groups, observed=True)}


def past_own_fence(x, groups, k=1.5):
    """How many values sit past their own group's Tukey fence (k x IQR beyond the middle half)."""
    x = pd.to_numeric(x)
    q1, q3 = x.groupby(groups, observed=True).transform(lambda s: s.quantile(.25)), x.groupby(groups, observed=True).transform(lambda s: s.quantile(.75))
    return int(((x < q1 - k * (q3 - q1)) | (x > q3 + k * (q3 - q1))).sum()), len(x)


def measure(folder):
    """-> (rules, numbers): rules as the app reads them, numbers for docs/bias/FINDINGS.md."""
    read = lambda k, **kw: pd.read_csv(fetch(k, folder), dtype=str, keep_default_na=False, **kw)
    a = read("adult", header=None, names=ADULT_COLS)
    t = read("adult_test", header=None, names=ADULT_COLS)
    g = read("german")
    ins = read("insurance")
    c = read("compas")
    n_a, n_g, n_i, n_c = len(a), len(g), len(ins), len(c)
    rich = a.income.str.strip().str.rstrip(".") == ">50K"
    a["band"], g["band"], ins["band"] = band(a.age), band(g.age), band(ins.age)
    g["sex"] = np.where(g.personal_status == "female", "female", "male")
    bad = g.default == "2"  # Statlog: 1 = good, 2 = bad credit
    census = f"in public US census data (UCI Adult, {num(n_a)} people)"
    credit = f"in public German credit data (Statlog, {num(n_g)} loans)"
    costs = f"in a public medical-cost teaching table ({num(n_i)} people, simulated from US census figures)"
    gap = "a gap between groups is common in real data and is not by itself a data error."
    look = "so a gap like this is common in real data: check how the rows were collected and what else differs between the groups, never change a value toward its group."
    nums, rules = {}, []

    def outcome(rid, topic, r, what, where, pane_where=None):
        hi, lo = ends(r)
        fact = f"{where} {pct(r[hi][1])} of {name(hi)} and {pct(r[lo][1])} of {name(lo)} {what}"
        rule = {"id": rid, "topic": topic, "kind": "outcome", "text": fact[0].upper() + fact[1:] + ": " + gap}
        if pane_where is not False:
            rule.update(pane_for="outcome", pane=f"For comparison, {fact}, {look}")
        rules.append(rule)

    r = rates(a, "sex", rich); nums["adult income >50K by sex"] = r
    outcome("sex_outcome", "sex", r, "earn over 50K", census)
    r = rates(a, "race", rich, 1000); nums["adult income >50K by race (groups of 1,000+)"] = rates(a, "race", rich)
    outcome("race_outcome", "race", r, "earn over 50K", census)
    r = rates(a, "band", rich); nums["adult income >50K by age band"] = r
    outcome("age_outcome", "age", r, "earn over 50K", census)
    r = rates(a, "marital", rich, 1000); nums["adult income >50K by marital status"] = rates(a, "marital", rich)
    outcome("marital_outcome", "marital", r, "earn over 50K", census)
    r = rates(a[a.workclass != "?"], "workclass", rich[a.workclass != "?"], 1000); nums["adult income >50K by workclass"] = rates(a, "workclass", rich)
    outcome("employment_outcome", "employment", r, "earn over 50K", census, False)
    r = rates(g, "housing", bad); nums["german bad credit by housing"] = r
    outcome("housing_outcome", "housing", r, "have bad credit", credit, False)
    nums["german bad credit by sex"], nums["german bad credit by age band"] = rates(g, "sex", bad), rates(g, "band", bad)
    nums["german bad credit by employment length"] = rates(g, "employment_length", bad)
    r = rates(ins, "region", ins.smoker.eq("yes")); nums["insurance smokers by region"] = r
    hi, lo = ends(r)
    fact = f"{costs} {pct(r[hi][1])} of people in the {hi} and {pct(r[lo][1])} in the {lo} smoke"
    rules.append({"id": "place_outcome", "topic": "place", "kind": "outcome", "text": fact[0].upper() + fact[1:] + ": " + gap,
                  "pane_for": "outcome", "pane": f"For comparison, {fact}, {look}"})
    recid = c.two_year_recid == "1"
    nums["compas re-arrest within 2 years by race"], nums["compas by sex"], nums["compas by age_cat"] = \
        rates(c, "race", recid), rates(c, "sex", recid), rates(c, "age_cat", recid)

    s = spread(g.amount, g.sex); nums["german credit amount by sex (rows, median, q1, q3)"] = s
    f, m = s["female"], s["male"]
    rules.append({"id": "sex_spread", "topic": "sex", "kind": "spread",
                  "text": f"In public German credit data (Statlog, {num(n_g)} loans) the median loan is {num(f[1])} for women and {num(m[1])} for men, "
                          f"and the middle half of each group overlaps widely ({num(f[2])}-{num(f[3])} and {num(m[2])}-{num(m[3])}): a value outside "
                          "its group's usual range is common and real."})
    s = spread(ins.charges, ins.band); nums["insurance charges by age band"] = s
    y, o = s["under 30"], s["60 and over"]
    rules.append({"id": "age_spread", "topic": "age", "kind": "spread",
                  "text": f"In a public medical-cost teaching table ({num(n_i)} people, simulated from US census figures) the median yearly cost is "
                          f"{num(y[1])} under 30 and {num(o[1])} at 60 and over: amounts that rise with age are real, not typos."})
    s = spread(ins.charges, ins.smoker); nums["insurance charges by smoker"] = s
    rules.append({"id": "smoker_spread", "topic": "smoker", "kind": "spread",
                  "text": f"In a public medical-cost teaching table ({num(n_i)} people) smokers' median yearly cost is {num(s['yes'][1])}, "
                          f"{s['yes'][1] / s['no'][1]:.1f} times non-smokers' {num(s['no'][1])}: a situation can change amounts this much in real data."})
    nums["adult hours by sex"] = spread(a.hours, a.sex)
    nums["insurance charges by sex"], nums["insurance charges by region"] = spread(ins.charges, ins.sex), spread(ins.charges, ins.region)
    nums["compas priors by race"] = spread(c.priors_count, c.race)

    fences = {"german amount by sex": past_own_fence(g.amount, g.sex), "compas priors by race": past_own_fence(c.priors_count, c.race),
              "insurance charges by smoker": past_own_fence(ins.charges, ins.smoker)}
    nums["values past their own group's 1.5 IQR fence"] = fences
    share = lambda k: pct(fences[k][0] / fences[k][1])
    rules.append({"id": "far_from_group", "topic": "any", "kind": "far",
                  "text": f"In public tables (German credit {num(n_g)} loans, COMPAS {num(n_c)} people, medical costs {num(n_i)} people) "
                          f"{share('german amount by sex')}, {share('compas priors by race')} and {share('insurance charges by smoker')} of values sit "
                          "past their own group's usual range (1.5 IQR) and are real records: unusual for its group is not a typo."})
    x = pd.to_numeric(ins.charges)
    move = float(((x - x.groupby(ins.smoker).transform("median")).abs() / x).median())
    nums["insurance: median move if each charge were set to its smoker group's median"] = move
    rules.append({"id": "group_median_move", "topic": "any", "kind": "far",
                  "text": f"Setting each cost in a public medical-cost table ({num(n_i)} people) to its smoker group's median would move a typical "
                          f"real value by {move:.0%}: a group's average is never a fix for one person's value."})

    q = {col: int(a[col].eq("?").sum()) for col in ("workclass", "occupation", "country")}
    nums["adult '?' cells"] = q
    rules.append({"id": "question_mark", "topic": "any", "kind": "hygiene",
                  "text": f"In UCI Adult '?' means unknown in {pct(q['workclass'] / n_a)} of workclass, {pct(q['occupation'] / n_a)} of occupation and "
                          f"{pct(q['country'] / n_a)} of country cells: a '?' is a missing value, never a group and never a value to fill from a group."})
    labels = t.income.value_counts().to_dict()
    nums["adult test part income labels"] = labels
    rules.append({"id": "label_spellings", "topic": "any", "kind": "hygiene",
                  "text": f"UCI Adult's own test part ({num(len(t))} rows) writes every label with a leading space and its income labels with a dot "
                          f"(' >50K.'), the main part without: case, space and dot variants are one label, not different groups."})
    age, hrs, gain = pd.to_numeric(a.age), pd.to_numeric(a.hours), pd.to_numeric(a.capital_gain)
    caps = {"age 90": int(age.eq(90).sum()), "age 89": int(age.eq(89).sum()), "hours 99": int(hrs.eq(99).sum()), "capital gain 99999": int(gain.eq(99999).sum())}
    nums["adult top codes"] = caps
    rules.append({"id": "top_codes", "topic": "any", "kind": "hygiene",
                  "text": f"In UCI Adult the top values are caps: {caps['age 90']} people are exactly 90 (only {caps['age 89']} are 89), {caps['hours 99']} work "
                          f"exactly 99 hours and {caps['capital gain 99999']} have capital gain 99999: a cap is a recorded code, not a typing slip."})
    miss = a.occupation.eq("?")
    r = rates(a, "band", miss); nums["adult occupation unknown by age band"] = r
    hi, lo = ends(r)
    fact = f"in UCI Adult occupation is unknown for {pct(r[hi][1])} of {name(hi)} and {pct(r[lo][1])} of {name(lo)}"
    rules.append({"id": "age_missing", "topic": "age", "kind": "missing", "text": fact[0].upper() + fact[1:] + ": blanks that gather in one group are often how the data were collected.",
                  "pane_for": "missing", "pane": f"For comparison, {fact}, so blanks that gather in one group are often how the data were collected: check why before filling any."})
    r = rates(a, "sex", miss); nums["adult occupation unknown by sex"] = r
    hi, lo = ends(r)
    fact = f"in UCI Adult occupation is unknown for {pct(r[hi][1])} of {name(hi)} and {pct(r[lo][1])} of {name(lo)}"
    rules.append({"id": "sex_missing", "topic": "sex", "kind": "missing", "text": fact[0].upper() + fact[1:] + ": blanks that gather in one group are often how the data were collected.",
                  "pane_for": "missing", "pane": f"For comparison, {fact}, so blanks that gather in one group are often how the data were collected: check why before filling any."})
    nums["adult occupation unknown by race"] = rates(a, "race", miss)
    nums["rows"] = {"adult": n_a, "adult_test": len(t), "german": n_g, "insurance": n_i, "compas": n_c}
    return rules, nums


def build(folder):
    rules, nums = measure(folder)
    sources = {k: {kk: v[kk] for kk in ("title", "url", "sha256", "licence")} | {"rows": nums["rows"][k]} for k, v in SOURCES.items()}
    return {"about": "Measured by tools/bias_sources.py from pinned public tables (docs/bias/FINDINGS.md). Each rule describes a real gap "
                     "so it is not mistaken for a typo; none is ever an expectation to correct a value toward.",
            "topics": TOPICS, "sources": sources, "rules": rules}, nums


def main(argv):
    data = next((argv[i + 1] for i, a in enumerate(argv) if a == "--data"), None)
    with tempfile.TemporaryDirectory(prefix="bias-sources-") as tmp:
        out, nums = build(data or tmp)
    text = json.dumps(out, indent=1, ensure_ascii=False) + "\n"
    for k, v in nums.items():
        print(f"{k}: {v}")
    if "--check" in argv:
        same = OUT.exists() and OUT.read_text(encoding="utf-8") == text
        print("bias_rules.json matches a fresh measurement" if same else "bias_rules.json differs from a fresh measurement")
        return 0 if same else 1
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(text.encode())} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
