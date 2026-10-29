"""Fairness checks (John's Responsible-AI blueprint, 2026-10-14): protected columns are found by their names, kept out of
the "is this person unusual" model, and every scan tests subgroups for gaps - in how often rows are flagged (false
alarms land on one group), in blanks (a model trained on the sheet learns that group less well) and in any yes/no
outcome column (a valid disparity to know about, never a value to "fix"). Advisory only: nothing here changes a cell."""
import re

import numpy as np
import pandas as pd
from scipy.stats import chi2_contingency, kruskal, mannwhitneyu

from anomaly_hunter.engine.load import NO_VALUE_WORD, PLACEHOLDER

PROXY = "location (can stand in for race or income)"
DEMOGRAPHIC = {"age", "dob", "birth", "birthday", "birthdate", "gender", "sex", "race", "ethnicity", "ethnic", "religion",
               "marital", "nationality", "citizenship", "disability", "disabled", "pregnancy", "pregnant", "veteran"}
LOCATION = {"location", "city", "state", "zip", "zipcode", "postal", "postcode", "country", "region", "neighborhood",
            "neighbourhood", "county"}
MIN_GROUP = 20  # smaller groups prove nothing either way
MAX_TESTS = 400  # each test is a crosstab (~5.6 ms): a crafted 40 x 40 sheet took 9 s per scan (2026-10-16)
ALPHA = 0.01    # after a Bonferroni correction over every test of the scan: noise is not called bias
HINT = 0.05     # a raw p-value this small, not confirmed after the correction: "not enough rows to tell"
NEAR = 0.10     # a big spread with a raw p-value between HINT and this is near the line: chance could explain it, but
# "within normal variation" claimed more than its numbers show (raw p 0.054 on 80 people, AH-20)
RATIO = 1.25    # the four-fifths rule, for a rate where higher is worse (1 / 0.8)


def _words(name):
    """'Marital_Status' -> ['marital', 'status']; 'ZipCode' -> ['zip', 'code']; 'DateOfBirth' -> ['date', 'of', 'birth']"""
    return [w.lower() for w in re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])", re.sub(r"[^A-Za-z]+", " ", str(name)))]


def protected(columns):
    """{column: why it is protected} for headers naming a demographic, or a location that can stand in for one."""
    out = {}
    for c in columns:
        w = set(_words(c))
        if w & DEMOGRAPHIC:
            out[c] = "demographic"
        elif w & LOCATION:
            out[c] = PROXY
    return out


def _groups(df, col, types, place=False):
    """The column's subgroups (label per row, None = left out): its values, or age bands for a number column. place: a
    location, whose numbered codes (a state's) may be many."""
    s = df[col]
    if types.get(col) == "number":
        x = pd.to_numeric(s, errors="coerce")
        # a demographic written as numbered codes (race 1/2/3, female 0/1, a state's code) is its codes: banded like
        # ages, race 1, 2, 3 read "race 1-2: 51% vs 18% for 3 and over" (AH-39). Only an age is banded
        if not _aged(col):
            v = x.dropna()
            if not len(v) or (v != v.round()).any() or v.nunique() > (60 if place else 10):
                return None  # counts or measurements (Females 4,000-60,000 a year), never a person's category
            return x.map(lambda n: None if pd.isna(n) else f"{n:g}")
        edges = [-np.inf, 30, 45, 60, np.inf]
        labels = pd.cut(x, edges, right=False, duplicates="drop")  # [30, 45) = "30-44"
        return labels.map(lambda b: None if pd.isna(b) else _band(b))
    if types.get(col) == "text":
        v = _labels(s, 50)  # category-like: groups under 20 rows drop out
        return None if v is None else v.where(v.notna() & ~_unknown(v), None)
    return None


REFUSAL = re.compile(r"(?i)prefer(?:red)? not to|decline[sd]? to|rather not")


def _unknown(s):
    """Labels that say no value (NA, N/A, Unknown, Not stated, Blank...): never a group of people, counted as missing as
    "?" is. "artist_ethnicity NA: 43% missing artist_race vs 0.1% - a real gap" was the same unknown artists counted
    twice, tate's "gender NA: 24% missing yearOfBirth" the anonymous and the collectives (AH-66 review 2). "None" and
    "Nil" stay: a religion of None is an answer."""
    v = s.astype(str).str.strip()
    return v.str.fullmatch(NO_VALUE_WORD) & ~v.str.casefold().isin(["none", "nil"]) & s.notna()


def _many(df, col, types):
    """A text column of too many labels to compare as groups (a nationality of 89): -> how many, else 0. Never an age or
    a birth date ("birthday: 3064 different values" on congress terms, AH-63 review 2): it is an age, not labels; a place
    of birth is still a place."""
    w = set(_words(col))
    if types.get(col) != "text" or w & AGED and not w & (LOCATION | PLACES) or _aged(col):
        return 0
    k = df[col].astype(str).str.strip().where(~_missing(df[col])).dropna().str.split().str.join(" ").str.casefold().nunique()
    return k if k > 50 else 0


def _labels(s, most):
    """Text cells as their labels, or None past `most` labels. "no " and "NO" are the label "No", written the way the
    column writes it most: one stray "no " among 480 Yes/No made the outcome three labels, and every outcome test
    went away with the real gap in it (2026-10-20). Blank and "?" are no label: a blank is not a kind of person."""
    v = s.astype(str).str.strip().where(~_missing(s))
    if not v.notna().any():  # nothing but blanks: no labels (and no text for .str to work on - the fuzzer's 500)
        return v.astype(object)
    key = v.str.split().str.join(" ").str.casefold()
    if key.nunique() > most:
        return None
    counts = v.value_counts()  # most common first: each label is shown as its most common spelling
    usual = pd.Series(counts.index, index=counts.index.str.split().str.join(" ").str.casefold()).groupby(level=0).first()
    return key.map(usual)


def _maybe(v):
    """{rare label: the usual label it is one slip from}: "Femlae" (1 row) beside 400 Female. Never folded into it: "Blank"
    beside Black is an export's unknown race and "Nigerien" a person from Niger (AH-39 review), so a rare label stays its
    own group, too few to compare, and is named with what it may be. The spelling check's own rule decides, and like it
    never names a word that says no value: "Blank (2 rows, maybe Black)" gave a race to people whose race is unknown (AH-50)."""
    from anomaly_hunter.engine.pipeline import _misspelt  # here: pipeline imports this module
    counts = v.value_counts()
    big = [k for k, n in counts.items() if n >= 5]
    out = {}
    for k, n in counts.items():
        if n <= 2 and not NO_VALUE_WORD.fullmatch(str(k)) and (usual := next((u for u in big if counts[u] >= 5 * n and _misspelt(str(k).casefold(), str(u).casefold())), None)):
            out[str(k)] = str(usual)
    return out


def _band(b):
    lo, hi = b.left, b.right
    if np.isinf(lo):
        return f"under {hi:g}"
    if np.isinf(hi):
        return f"{lo:g} and over"
    return f"{lo:g}-{hi - 1:g}" if float(lo).is_integer() and float(hi).is_integer() else f"{lo:g}-{hi:g}"


# two labels are an outcome unless they say who, where or when: a shift (Day/Night), a hand (Left/Right) or a department
# (A/B) is not a result, and reading one as an outcome put "Gender F: 60% Shift Night - a real gap" in the pane (AH-17).
# A list of outcomes lost real ones (Approved/Declined, Defaulted/Paid, Delinquent/Current: AH-18 review), so only
# these pairs, and one-letter or numbered codes (A/B, Q1/Q2, 2024/2025), are left out.
NOT_OUTCOMES = [{"day", "night"}, {"am", "pm"}, {"morning", "evening"}, {"morning", "afternoon"}, {"weekday", "weekend"},
                {"left", "right"}, {"north", "south"}, {"east", "west"}, {"urban", "rural"}, {"indoor", "outdoor"},
                {"inside", "outside"}, {"inbound", "outbound"}, {"internal", "external"}, {"domestic", "international"},
                {"online", "offline"}, {"front", "back"}, {"upper", "lower"}, {"before", "after"}, {"old", "new"},
                # AH-20: a shift, a way to pay, a sales channel, a device, a term and a survey round say when, how or
                # where, never how it went. Full-time/Part-time stays an outcome: an employer decides it (a hiring gap)
                {"morning", "night"}, {"cash", "card"}, {"retail", "wholesale"}, {"mac", "pc"}, {"spring", "fall"},
                {"spring", "autumn"}, {"pre", "post"},
                # AH-39 (blind round 36): a meal is when, a chamber where, a party who ("Female 40% time Lunch")
                {"lunch", "dinner"}, {"breakfast", "lunch"}, {"breakfast", "dinner"}, {"house", "senate"},
                {"democrat", "republican"}, {"democratic", "republican"}, {"dem", "rep"}]


def _is_outcome(a, b):
    """Two labels (casefolded) that can be a result: anything but a who/where/when pair or a code."""
    if {a, b} in NOT_OUTCOMES:
        return False
    if len(a) == 1 and len(b) == 1 and a.isalpha() and b.isalpha() and {a, b} not in ({"y", "n"}, {"t", "f"}, {"p", "f"}, {"w", "l"}):
        return False  # A/B, X/Y: codes; Y/N, T/F, P/F (pass/fail) and W/L (won/lost) are results
    # Lottery A / Lottery B, Plan A / Plan B: the same words but a last letter or number, a choice like bare A/B (AH-53 review)
    sa, sb = a.rsplit(" ", 1), b.rsplit(" ", 1)
    if len(sa) == len(sb) == 2 and sa[0] == sb[0] and all(len(x[1]) == 1 or x[1].isdigit() for x in (sa, sb)):
        return False
    digits = lambda w: any(ch.isdigit() for ch in w)
    if digits(a) and digits(b) and {a, b} != {"0", "1"} and not (a[:1] in "<>≤≥=" or b[:1] in "<>≤≥="):
        return False  # Q1/Q2, 2024/2025, Grade 3/Grade 4; "<=50K"/">50K" is a result
    return True


def _polarity(label):
    """+1 when a counted label is the higher or yes side (">50K", "Yes", "1"), -1 when it is the lower or no side, 0 unsure."""
    w = str(label).strip().casefold()
    if w.startswith((">", "≥")) or w in ("= 1", "yes", "y", "true", "high", "over", "above"):
        return 1
    if w.startswith(("<", "≤")) or w in ("= 0", "no", "n", "false", "low", "under", "below"):
        return -1
    return 0


def _outcomes(df, types, skip):
    """Yes/no columns that are not protected -> {test name: (rate of the "yes" per row, what "yes" is in words, the column,
    the counted label)}: 0/1 numbers (delinquent, defaulted, churned), and text with exactly two labels that can be a
    result (_is_outcome; census income "<=50K" / ">50K": the rarer label is the one counted)."""
    out = {}
    for c, t in types.items():
        if c in skip:
            continue
        if t == "number":
            x = pd.to_numeric(df[c], errors="coerce")
            if x.notna().any() and set(x.dropna().unique()) == {0, 1}:
                out[f"{c} rate"] = (x.eq(1).where(x.notna()), f"{c} = 1", c, "= 1")
        elif t == "text":
            v = _labels(df[c], 2)
            counts = v.value_counts() if v is not None else ()
            if len(counts) == 2 and _is_outcome(*(str(k).casefold() for k in counts.index)):
                yes = counts.index[-1]
                out[f"{c} {yes} rate"] = (v.eq(yes).where(v.notna()), f"{c} {yes}", c, yes)
    return out


# AH-49: an amount a decision or a test gives a person - pay, an income, a price, a loan, a score. Not every number: a
# patient's cholesterol or a person's height differs by sex for reasons no one decided
AMOUNT = {"wage", "wages", "salary", "salaries", "pay", "income", "incomes", "earnings", "bonus", "compensation", "price",
          "premium", "loan", "amount", "score", "scores", "grade", "grades", "gpa"}
# a group cut by an amount (police killings' county_bucket: the county's income quintile) is that amount's rank: an
# amount compared across it says how the cut was made
CUTS = {"bucket", "quintile", "quartile", "decile", "percentile", "tercile", "tier", "bracket"}
NOT_AMOUNT = {"term", "id", "code", "number", "no", "count", "year", "years", "month", "months", "day", "days", "date"}  # Loan_Amount_Term


def _amounts(df, types, skip):
    """Amount columns that are not protected -> {test name: (the values, what in words, the column)}: a number column
    named as one (AMOUNT), with 10+ different values (a 1-5 score or a 3-step pay scale is a code) and none below 0."""
    out = {}
    for c, t in types.items():
        if t != "number" or c in skip or not set(_words(c)) & AMOUNT or set(_words(c)) & NOT_AMOUNT:
            continue
        x = pd.to_numeric(df[c], errors="coerce")
        v = x.dropna()
        if len(v) >= 2 * MIN_GROUP and v.nunique() >= 10 and (v >= 0).all():
            out[f"median {c}"] = (x, f"median {c}", c)
    return out


def _say(m):
    """A median in words: 48,250 and 12.75, as a person would write them."""
    return f"{m:,.0f}" if abs(m) >= 1000 else f"{m:.4g}"


def _amount_test(g, x, base):
    """One amount compared across a column's groups: groups under MIN_GROUP rows left out and named; none when every
    group holds one value (the column is a lookup of the group: a country's average income joined onto its people)."""
    ok = g.notna() & x.notna()
    sizes = g[ok].value_counts()
    sizes = sizes[sizes > 0]  # age bands nobody falls in (Swiss ages written in decades) are no group
    small = {str(k): int(n) for k, n in sizes.items() if n < MIN_GROUP}
    vals = {str(k): x[ok & (g == k)].to_numpy(dtype=float) for k in sizes.index if sizes[k] >= MIN_GROUP}
    if len(vals) < 2:
        return {**base, "p": None, "groups": {}, "small": small} if len(vals) + len(small) >= 2 else None
    if all(np.ptp(v) == 0 for v in vals.values()) or np.ptp(np.concatenate(list(vals.values()))) == 0:
        return None
    # ...nor when the groups are cut from the amount itself: police killings' county_bucket is the county's income
    # quintile, and "bucket 1: median income 29,707 vs 50,280" restated the cut. Sorted by the amount, the groups then
    # follow one another in runs, changing about once per group; any real groups interleave all the way
    # A cut is numbered in the order of its ranges (1 to 5); two groups apart with no overlap are the starkest gap there
    # is: women paid 30,000-45,000 and men 46,000-70,000 had no amount test at all (AH-49 review)
    allv = np.concatenate(list(vals.values()))
    lab = np.concatenate([np.full(len(v), k) for k, v in enumerate(vals.values())])[np.argsort(allv, kind="stable")]
    codes = pd.to_numeric(pd.Series(list(vals)), errors="coerce")
    meds = pd.Series([np.median(v) for v in vals.values()])
    ranked = len(vals) >= 3 and codes.notna().all() and abs(codes.corr(meds, method="spearman")) == 1
    if ranked and (lab[1:] != lab[:-1]).sum() <= 2 * (len(vals) - 1) + 0.01 * len(allv):
        return None
    p = mannwhitneyu(*vals.values()).pvalue if len(vals) == 2 else kruskal(*vals.values()).pvalue
    return {**base, "p": float(p), "small": small, "vals": vals,
            "groups": {k: [len(v), round(float(np.median(v)), 4)] for k, v in vals.items()}}


def _missing(s):
    """Blank, or a stand-in for blank ("?", "N/A", "unknown"): census rows give "?" for an unknown occupation. A number
    or a yes/no is never text, so its blank is its NaN: the text pass on nonvoters' 110 number columns was most of the
    report's time (AH-65)."""
    if pd.api.types.is_numeric_dtype(s) or pd.api.types.is_bool_dtype(s):
        return s.isna()
    v = s.astype(str).str.strip()
    return s.isna() | (v == "") | v.str.fullmatch(PLACEHOLDER)


# "Race" in "Race Time" or "Race Number" is a running race, and "State" in "Order State" is a status, not a place: both
# were read as people (AH-17 bias hunt). The words that make a header about the thing, not the person:
NOT_PEOPLE = {"race": {"time", "times", "pace", "distance", "lap", "laps", "split", "splits", "finish", "position", "rank", "result",
                       "results", "entry", "course", "track", "number", "no", "id", "date", "day", "name", "type", "series", "event"},
              "state": {"order", "ticket", "account", "task", "job", "payment", "shipment", "delivery", "approval", "workflow",
                        "process", "machine", "item", "invoice", "case", "request", "subscription", "build", "run"}}
# ...and "black" or "white" that names a chess side, a piece or a player's attribute: tt_chess's black_id (9,311 usernames)
# was read as a race and listed as left out (AH-63 review 2)
SIDE = {"id", "rating", "elo", "player", "name", "username", "moves", "move", "pieces", "piece", "rank", "score", "time"}
NOT_PEOPLE |= {"black": SIDE, "white": SIDE}
# ...and an unnamed "State" whose labels are all steps of a process (Pending, Shipped) is a status too
STATUS = {"pending", "open", "closed", "shipped", "delivered", "returned", "cancelled", "canceled", "active", "inactive", "done",
          "new", "in progress", "approved", "rejected", "paid", "unpaid", "draft", "complete", "completed", "failed", "processing",
          "on hold", "refunded", "submitted", "resolved", "archived"}


# AH-39: who the sheet is about. A blind sweep of 39 public tables never used before found the report claiming "a real
# gap" about Texas cities' missing house sales, reading a town's share of old houses as people's ages and a cat's sex
# as a person's, and missing people columns named female, nonwhite, colour, maritl or nativeBorn.
OTHER_NAMES = {"female", "females", "male", "males", "nonwhite", "nwhite", "white", "black", "hispanic", "latino", "latina", "afam",
               "minority", "maritl", "married", "citizen", "immigrant", "foreign", "native",
               "lgbt", "lgbtq", "lgbtqi", "lgbtqia"}  # "LGBTQ?" on a sheet of candidates (blind round 38, AH-63)
RACE_LABELS = {"white", "black", "asian", "hispanic", "latino", "latina", "other", "mixed", "native", "indian", "pacific islander",
               "native american", "american indian", "african american", "caucasian", "multiracial", "non-white", "nonwhite"}
COLOUR = {"colour", "color"}  # a race only when its labels are races: a car's Red / Silver is not
ANIMALS = {"species", "breed", "genus", "animal", "animals", "pet", "pets", "dog", "dogs", "cat", "cats", "bird", "birds", "penguin",
           "penguins", "fish", "horse", "horses", "cattle", "cow", "cows", "livestock", "strain", "litter", "mouse", "mice", "rat", "rats"}
# a header that says its rows are people (plain "name" is not: products, cities and animals have names too)
PERSON = {"customer", "customers", "patient", "patients", "employee", "employees", "staff", "student", "students", "applicant",
          "applicants", "passenger", "passengers", "athlete", "athletes", "respondent", "respondents", "participant", "participants",
          "person", "persons", "people", "voter", "voters", "member", "members", "client", "clients", "worker", "workers", "player",
          "players", "resident", "residents", "mother", "father", "firstname", "surname", "lastname", "fullname", "borrower", "tenant",
          "actor", "actress", "artist", "author", "character", "winner", "laureate", "champion", "rider", "driver", "victim",
          "suspect", "defendant", "officer", "subject", "child", "children", "kid", "kids", "senator", "candidate", "ceo"}
AGED = {"age", "dob", "birth", "birthday", "birthdate"}
# an animal has a sex and an age, never these: a sheet with an animal word in a header is about people only with one of
# them, or with a header that names its rows as people (a survey's "Dog owner" beside Respondent and Gender, AH-39 review).
# Not a rider's or an owner's header: a horse table's sex is the horse's
PERSON_ONLY = {"gender", "race", "ethnicity", "ethnic", "religion", "marital", "maritl", "married", "nationality", "citizenship",
               "citizen", "veteran", "disability", "disabled", "hispanic", "latino", "latina", "nonwhite", "minority", "immigrant"}
ROWS_ARE_PEOPLE = {"respondent", "respondents", "participant", "participants", "patient", "patients", "customer", "customers",
                   "employee", "employees", "student", "students", "applicant", "applicants", "person", "persons", "people",
                   "voter", "voters", "passenger", "passengers", "client", "clients", "resident", "residents", "borrower", "tenant"}
PLACES = {"place", "town", "birthplace", "hometown", "village"}
AGE_WORDS = {"age", "ages", "years", "yrs", "year", "yr", "in", "at", "of", "the", "group", "band", "range", "cat", "category",
             "current", "dob", "birth", "birthday", "birthdate", "date", "day"}


def _aged(col):
    """A person's age or birth date by its header: plain ("Age", "age_years", "Date of birth") or a person's ("Patient
    age"), never a thing's ("HouseAge", "Account age")."""
    w = set(_words(col))
    # ...never a day or a month of one alone: Lahman's birthDay (1-31) was read as a person's age, 12 tests (round 38, AH-63)
    if w & {"day", "month"} and not w & {"date", "year", "dob", "birthdate", "age"}:
        return False
    return bool(w & AGED) and (w - AGE_WORDS <= PERSON or _identity(col))  # "What is your age?" (AH-53)


# AH-53 (blind round 37): a header that asks or states something is an answer column. 29 opinion questions that mention a
# religion ("How comfortable would you be seeing someone who practices a different religion from you: ...") and a statement
# with "sex" in it ('To what extent do you agree ... "our sex life has improved"') were read as who people are, and 48
# "real gap" sentences followed. A short question that asks who someone is stays one: "What is your present religion,
# if any?", "What is your gender?", "Which race best describes you?"
ASKS = {"how", "what", "which", "who", "when", "where", "why", "do", "does", "did", "are", "is", "was", "were", "would", "could",
        "should", "have", "has", "had", "to", "please", "if", "will", "can"}
OPINION = {"agree", "disagree", "comfortable", "comfortably", "feel", "feeling", "think", "believe", "opinion", "important",
           "likely", "often", "familiar", "satisfied", "prefer", "affect", "affects", "worried", "support", "oppose", "approve",
           "matter", "matters", "talk", "talking", "discuss", "discussing", "seeing", "see", "should", "fair", "unfair"}
# ...a self-identification question names who someone is in any shape: "Do you have a disability?", "Are you a veteran?",
# "Religion: which one?", "Are you Hispanic or Latino?" (Council A's AH-53 review: all four were silenced)
IDENTITY = DEMOGRAPHIC | {"denomination", "ethnic", "hispanic", "latino", "latina", "orientation", "transgender", "citizen",
                          "citizens", "lgbt", "lgbtq", "lgbtqi", "lgbtqia"}  # "Are you a U.S. citizen?" (AH-53 review 2)
# a sexual orientation by its labels: a page's or a photo's orientation (Portrait, Landscape) is no person's, and a road
# segment's Straight / Other is no one's (AH-53 review 2): at least one label must name an orientation and nothing else
ADDRESSED = {"you", "your", "yours", "yourself"}  # a question put to the person the row is about
# ...and one that counts things is never who someone is: "How many citizens live in your district?" (John, AH-53 try 5)
COUNTS = re.compile(r"(?i)%|\b(?:how many|how much|share|percent|percentage|proportion|number of|rate of|count of|total)\b")
NAMES_ORIENTATION = {"gay", "lesbian", "bisexual", "heterosexual", "homosexual", "asexual", "pansexual", "queer", "gay/bisexual",
                     "gay or lesbian"}
ORIENTATIONS = {"straight", "gay", "lesbian", "bisexual", "heterosexual", "homosexual", "asexual", "pansexual", "queer",
                "other", "gay/bisexual", "gay or lesbian", "prefer not to say", "prefer not to answer", "no answer",
                "decline to state"}


def _asked(col):
    """A header that asks or states something (a survey's question), not one that names a column: "Gender", "Q3: Sex" and
    "Gender:" are names."""
    s, w = str(col), _words(col)
    w = w[1:] if w and re.fullmatch(r"q\d*", w[0]) else w  # "Q3: Sex"
    return (len(w) > 6 or "?" in s and len(w) > 2 or ":" in s and len(w) > 4 or any(q in s for q in "\"\u201c\u201d")
            or bool(w) and w[0] in ASKS and len(w) > 2 or bool(set(w) & {"agree", "disagree"}))


def _who(col):
    """A question that asks who someone is, by John's rules (AH-53 try 5): it names who someone is with no opinion word
    (_identity), asks about the person (you, your, this person, the respondent) or is 4 words or fewer ("Hispanic or
    Latino?", "Of Hispanic origin?"), and counts nothing (how many, share, percent...)."""
    w = _words(col)
    person = set(w) & (ADDRESSED | {"respondent", "respondents"}) or "this person" in " ".join(w)
    return _identity(col) and bool(person or len(w) <= 4) and not COUNTS.search(str(col))


def _identity(col):
    """A question that asks who someone is: a word of who someone is, no opinion word ("Is your religion important to
    you?", "How comfortable ... a different religion"), up to 15 words ("What is your race or ethnicity, as you would
    describe it in your own words?" is 13)."""
    w = _words(col)
    if len(w) > 15 or set(w) & OPINION or not set(w) & IDENTITY:
        return False
    if set(w) & IDENTITY <= AGED:  # an age must be the person's: "What is your age?", never "the age cutoff at your kids' table"
        return any(word in ("your", "which", "what") and set(w[k + 1:k + 3]) & AGED for k, word in enumerate(w))
    return True


ROWLIKE = {"id", "name", "names", "number", "no", "code", "key", "ref", "first", "last", "full", "given", "family"}


def _names_rows(col):
    """A header that names its rows as people: "Customer ID", "Patient", "player_id", "Respondent" - never a count about
    people ("passengers_per_cabin" made a table of Ferris wheels a people sheet, AH-53)."""
    w = set(_words(col))
    return len(_words(col)) <= 3 and bool(w & PERSON) and w - ROWLIKE <= PERSON


def _unnamed(col):
    """A column with no header of its own: "", ".2" (a second blank header, deduplicated), "Unnamed: 3" - never quoted
    in a sentence ("Age > 60: 89% missing .2", AH-53)."""
    base = re.sub(r"\.\d+$", "", str(col)).strip()
    return not re.search(r"[A-Za-z0-9]", base) or bool(re.fullmatch(r"(?i)unnamed:? ?\d+", base))


def _subheader(df, types):
    """The first data row when it is a second header row: a survey export's "Response" under each question. At least 3
    of its cells, half of those filled, are in category columns where that value never comes again ("too few to
    compare: Response (1 row)", AH-53)."""
    if len(df) < 2 * MIN_GROUP:
        return pd.Series(False, index=df.index)
    first, filled, alone = df.iloc[0], 0, []
    for c, t in types.items():
        v = str(first.get(c, "")).strip()
        if t != "text" or not v or v.lower() == "nan":
            continue
        filled += 1
        rest = df[c].iloc[1:].astype(str).str.strip()
        if rest.nunique() <= 50 and not (rest == v).any():
            alone.append(v)
    # ...and one of those labels heads 3+ columns ("Response"): a first row of real data (the Tour de France's 1903
    # winner) has values of its own in a few columns too, never one label over three
    mask = pd.Series(False, index=df.index)
    mask.iloc[0] = len(alone) >= 3 and len(alone) >= filled / 2 and max(map(alone.count, alone)) >= 3
    return mask


TOTALS = re.compile(r"(?i)total|all|overall|both sexes|all (?:races|persons|people|groups)|total population")


RESPONDENTS = {"respondent", "respondents", "participant", "participants", "interviewee", "responder"}


def _personal(col):
    """A column of a person's own answer or life: a question or statement put to them, a birth or a death, a demographic."""
    return _asked(col) or bool(set(_words(col)) & (AGED | DEMOGRAPHIC | {"death", "died", "deceased", "born"}))


def _hosted(df, occasion, place):
    """The place is the occasion's: each occasion (3+ of them) has one place, and there are 2+ places."""
    d = pd.DataFrame({"o": df[occasion].astype(str).str.strip(), "p": df[place].astype(str).str.strip()})[~(_missing(df[occasion]) | _missing(df[place]))]
    per = d.groupby("o")["p"].nunique()
    return len(per) >= 3 and d["p"].nunique() >= 2 and (per == 1).mean() >= 0.98


def _people(df, types):
    """protected() for the fairness report: the columns that are about people, read from their names, their labels and
    the rest of the sheet. A sheet is about people only with a column that can only be a person's (sex, race, marital
    status...: categories, never a measurement), or a header that names its rows as people (Customer, Patient); an age
    or a place alone is a house's or a sales sheet's as often (Boston's "age", Texas' cities), and an animal sheet's sex
    is no person's. Only the report uses this: the AI's context (bias_context.rules_for) and the detectors keep
    protected(), unchanged until their own measurements say otherwise (CLAUDE.md)."""
    cols = [c for c in types if c in df.columns]
    if any(set(_words(c)) & ANIMALS for c in cols) and not any(set(_words(c)) & (PERSON_ONLY | ROWS_ARE_PEOPLE) for c in cols):
        return {}
    named = {c: why for c, why in protected(cols).items() if not _unnamed(c) and (not _asked(c) or _who(c))}
    for c in cols:
        w = set(_words(c))
        # a self-identification question whose word protected() does not know by name ("Are you Hispanic or Latino?"),
        # and an orientation whose labels are people's. protected() itself, which the detectors use, is unchanged.
        # A question asks who someone is only by _who: "How many citizens live in the district?" made a grants sheet a
        # people sheet, "Over 5,000: 74% Grant Funded vs 21% - a real gap, check why" (AH-53 review 3), and try 4's
        # "you" alone lost "Hispanic or Latino?" and kept "How many citizens live in your district?" (AH-53 review 4)
        labels = set(_labels(df[c], 20).dropna().str.casefold()) if "orientation" in w and _labels(df[c], 20) is not None else set()
        if c not in named and not _unnamed(c) and (_asked(c) and _who(c) and not "orientation" in w or "orientation" in w and (
                "sexual" in w or labels <= ORIENTATIONS and bool(labels & NAMES_ORIENTATION))):
            named[c] = "demographic"
        # a short header only: "Will you shop any Black Friday sales?" is a question, not a race (blind round 36)
        if c not in named and not _asked(c) and (w & OTHER_NAMES and len(_words(c)) <= 3 or w & COLOUR and _labels(df[c], 20) is not None
                               and set(_labels(df[c], 20).dropna().str.casefold()) <= RACE_LABELS):
            named[c] = "demographic"
    out, wide = {}, set()
    for c, why in named.items():
        w = _words(c)
        if any(k in w and set(w) & NOT_PEOPLE[k] for k in NOT_PEOPLE):
            continue
        # where someone died or is buried is no group they belong to: "deathCountry Cuba: 7.4% missing deathDay - a real
        # gap" (round 38, AH-63)
        if set(w) & {"death", "died", "deceased", "burial", "buried"}:
            continue
        if "state" in w and types.get(c) == "text":
            labels = set(df[c].astype(str).str.strip().str.casefold()[~_missing(df[c])])
            if labels and labels <= STATUS:
                continue
        if set(w) & (LOCATION | PLACES):  # birth_city, placeOfBirth, birth_town: a place, never an age
            why = PROXY
        elif set(w) & AGED:
            if not _aged(c):
                continue
        elif _groups(df, c, types) is None:
            if not _many(df, c, types):
                continue  # a measurement named like a group (Boston's "black", a town's share): not a person's category
            wide.add(c)
        out[c] = why
    # ...and the sheet is about people: a person-only column (not an age, not a place), or rows named as people. A column
    # kept only to be named as left out never makes it so: a ship registry's 60 flag Nationalities made its ports gap
    # tests (AH-63 review 1)
    # ...never a table of counts by group: a people column with a total among its labels ("TOTAL", "All") makes each row a
    # figure for a group ("race_gender Asian: 0.0% missing employ_n vs 9.5% - a real gap" on employed persons by
    # industry, AH-68)
    # Its summary rows are never that ("Race: Total" under a roster, AH-68 review 1): a total or average row that leaves
    # cells empty, as the pipeline reads one, is left out, and the total must be a real share of the rows (tt_employed's
    # TOTAL rows are full rows, 17% of them)
    filled = (~df[cols].apply(_missing)).sum(axis=1)
    summary = (df.index.isin(df.attrs.get("total_rows", ())) | df.index.isin(df.attrs.get("stat_rows", ()))) & (filled < filled.median()).to_numpy()
    rest = df[~summary]
    if any(why == "demographic" and types.get(c) == "text" and (n := int(rest[c].astype(str).str.strip().str.fullmatch(TOTALS).sum())) >= 2
           and n > 0.01 * len(rest) for c, why in out.items()):
        return {}
    # ...and a place that is the same for every row of an occasion is the occasion's (a contest's host city), never a
    # group of the rows' people: "host_city Dublin: 0.0% qualified TRUE vs 19%" was the years before semi-finals (AH-68)
    occasions = [c for c in cols if types.get(c) == "text" and set(_words(c)) & OCCASIONS]
    out = {c: why for c, why in out.items() if not (why == PROXY and any(_hosted(df, o, c) for o in occasions if o != c))}
    strong = any(why == "demographic" and not set(_words(c)) & AGED and c not in wide for c, why in out.items())
    if not strong and not any(_names_rows(c) for c in cols):
        return {}
    # ...nor what makes a report appear: a "winner" sheet whose only column kept is a 60-label nationality had none on
    # main, and its left-out line would be all it said (AH-63 review 2)
    if not set(out) - wide:
        return {}
    return out


def _pct(r):
    """A rate in words: one decimal under 10% ("1.2% vs 0.4%" read "1% vs 0%", AH-18 review)."""
    return f"{r:.1%}" if r < 0.1 else f"{r:.0%}"


def _few(table, what):
    """What there is little of near the line: the hits or the misses, counted. "With these few rows" was said of 3,000
    rows with 29 flagged (Council B, AH-20 review): the few are the events, not the rows."""
    hits = int(table[True].sum())
    misses = int(table.to_numpy().sum()) - hits
    return f"with only {hits:,} {what} to go on" if hits <= misses else f"with only {misses:,} rows without {what} to go on"


def _either(a, b):
    """_big on the counted side or on the other one: Approved = 1 at 89% vs 74% is 11% vs 26% not approved, and the same
    people written Approved/Denied (Denied counted) read a gap while the 0/1 column read "small" (AH-18 review)."""
    return _big(max(a, b), min(a, b)) or _big(1 - min(a, b), 1 - max(a, b))


def _big(hi, lo):
    """A gap worth naming: the higher rate is 1.25x the lower (the four-fifths rule) and 5 points above it, or at least
    twice it. A doubling counts at any size: 2% vs 4% defaults on 20,000 people (p ~ 0) read "close across groups"
    (AH-17 bias hunt)."""
    return hi >= RATIO * lo and (hi - lo >= 0.05 or hi >= 2 * lo)


def _named(groups, maybe=None):
    return ", ".join(f"{k} ({n} row{'' if n == 1 else 's'}{f', maybe {maybe[k]}' if k in (maybe or {}) else ''})" for k, n in groups.items())


ALL_THAT_APPLY = re.compile(r"(?i)\b(?:select|check|tick|mark|choose)\s+all\s+that\s+apply\b")


LOOKUPS = {"branch", "store", "office", "site", "outlet", "depot", "warehouse", "plant", "station", "terminal"}
OCCASIONS = {"event", "events", "competition", "contest", "tournament", "match", "game", "games", "round", "stage", "heat",
             "edition", "season", "episode", "meet", "championship", "championships"}
ASKERS = 150  # the first 150 in sheet order: nonvoters' party (Q30) is its 110th column (AH-65); a crafted wide sheet stays fast


def _codes(s, blank):
    """A number column of 20 whole-number codes or fewer ("How often do you vote?" 1-4) as its labels, else None:
    nonvoters' Q29_1..Q29_10 hang on Q26 = 2, 3 or 4, and only text could gate (round 38, AH-65)."""
    v = pd.to_numeric(s, errors="coerce").where(~blank)
    seen = v.dropna()
    if seen.empty or not (seen == seen.round()).all() or seen.nunique() > 20:
        return None
    return v


def _askers(df, types, blank_of):
    """The text columns of 20 labels or fewer, and the number columns of 20 whole-number codes or fewer, a later question
    can hang on, the first ASKERS in sheet order: [(column, label codes, labels, rows per label, rows x labels)]."""
    from scipy.sparse import csr_matrix
    out, n = [], len(df)
    for q, t in types.items():
        if q not in df.columns:
            continue
        if set(_words(q)) & (LOCATION | PLACES | LOOKUPS):  # a branch or a place is a lookup, never an earlier answer (AH-68)
            continue
        lab = _labels(df[q], 20) if t == "text" else _codes(df[q], blank_of[q]) if t == "number" else None
        least = (5, 1)  # rows an answer needs to be read as routed past, and as asked
        if lab is None and t == "text" and set(_words(q)) & OCCASIONS:
            # ...or an event's name, of many labels each written 3+ times: a team member's number is blank for every
            # individual event ("gender Women: 79% missing grp_id vs 71%", round 38, AH-66). Only an occasion: by the data
            # alone a person's own id gates too (congress terms' bioguide: a member's middle name is blank on every term)
            lab, least = df[q].astype(str).str.strip().where(~blank_of[q]), (3, 3)
            if lab.dropna().value_counts().ge(3).sum() < 2:
                continue
        if lab is None or not lab.notna().any():
            continue
        if t == "number":  # in their order: "Q26: 2, 3, 4"
            codes, names = pd.factorize(lab, sort=True)
            names = [str(int(k)) for k in names]
        else:
            codes, names = pd.factorize(lab)
            names = list(names)
        on = codes >= 0
        onehot = csr_matrix((np.ones(int(on.sum())), (codes[on], np.flatnonzero(on))), shape=(len(names), n))
        out.append((q, codes, names, np.bincount(codes[on], minlength=len(names)), onehot, least))
        if len(out) == ASKERS:
            break
    return out


def _gates(askers, blanks):
    """_gate for every measured blank at once: each asker's blanks per label, for all the columns, in one product."""
    names = list(blanks)
    if not names or not askers:
        return {}
    cols = [blanks[k][2] for k in names]
    b = np.column_stack([blanks[k][0].to_numpy(bool) for k in names]).astype(float)
    per = [(q, codes, labels, size, np.asarray(onehot @ b), least) for q, codes, labels, size, onehot, least in askers]
    index = blanks[names[0]][0].index
    return {k: _gate(per, cols[j], j, b[:, j].sum(), index) for j, k in enumerate(names)}


def _gate(per, col, j, total, index):
    """The earlier question a later one hangs on: Star Wars' "Which character shot first?" is blank for everyone who had
    seen none of the films, so women, who more often had not, were "28% missing vs 15% - a real gap" (round 38, AH-63).
    One whose answers (5+ rows each) either leave this column blank (95%+) or fill it (half the time or more: nonvoters'
    Q30 = 5 left Q33 blank 21% of the time, refusals coded -1, AH-65), those answers 90% of its answered rows, and the
    blank ones 60% of this column's blanks (Thanksgiving's 78 who do not celebrate are 73% of "How far will you
    travel?"'s blanks, the rest respondents who stopped) -> (gate, the rows asked, the answers asked)."""
    best = None
    for q, codes, names, size, counts, least in per:
        if q == col:
            continue
        share = counts[:, j] / np.maximum(size, 1)
        routed, asked = (size >= least[0]) & (share >= 0.95), (size >= least[1]) & (share <= 0.5)
        if not routed.any() or not asked.any() or size[routed | asked].sum() < 0.9 * size.sum():
            continue
        why = int(round(counts[routed, j].sum()))
        if why >= 0.6 * total and (best is None or why > best[0]):
            best = (why, q, codes, [names[k] for k in np.flatnonzero(asked)], np.flatnonzero(asked), np.flatnonzero(routed))
    if best is None:
        return None
    # -> (gate, rows asked, answers asked, rows routed past)
    return best[1], pd.Series(np.isin(best[2], best[4]), index=index), best[3], pd.Series(np.isin(best[2], best[5]), index=index)


def _coarser(g, s, blank):
    """The groups are cut from the column measured: each of its labels, and its blank, falls in one group, and it has
    more labels than there are groups (artist_race_nwi from artist_race, an unknown race counted Non-White)."""
    d = pd.DataFrame({"g": g, "s": s.astype(str).str.strip().where(~blank, "")}).dropna()
    return bool(len(d)) and d["s"].nunique() > d["g"].nunique() and d.groupby("s")["g"].nunique().max() == 1


def _nested(g, routed, asked):
    """The rows a gate routed past are one group's: 90%+ of them share a value of the group column that holds at most
    half of the rows it asked. A group most of the sheet is (Himalaya's men, 90% of the climbers) stays gated."""
    r, a = g[routed.to_numpy(bool)].dropna(), g[asked.to_numpy(bool)].dropna()
    if not len(r):
        return False
    share = r.value_counts(normalize=True)
    return share.iloc[0] >= 0.9 and (a == share.index[0]).mean() <= 0.5


def _table(codes, names, ok, hit):
    """pd.crosstab(group[ok], hit[ok].astype(bool)), counted with numpy: the same table (groups in order, a False or
    True column only when it occurs), at a tenth of the time. Nonvoters' 202 crosstabs were half the report (AH-65)."""
    c = np.bincount(codes[ok] * 2 + hit[ok].astype(bool).to_numpy(int), minlength=2 * len(names)).reshape(len(names), 2)
    keep = c.sum(axis=1) > 0
    cols = [k for k in (False, True) if c[:, int(k)].sum()]
    return pd.DataFrame(c[keep][:, [int(k) for k in cols]], index=pd.Index(np.asarray(names, dtype=object)[keep]), columns=cols)


def _coverage(blank, table, unrecorded, personal=False):
    """Blanks by place that say where the source kept the column, not what happened to people: endorsements filled in
    only for the states a group tracked ("State NV: 64% missing Trump Endorsed? vs 95%", 32 such in round 38), a state
    whose general election had not been held ("OK: 83% missing General Status vs 0.5%"), and a few candidates with no
    profile at all ("TN: 18% missing LGBTQ?", the same 4 rows blank in 5 columns). A column blank for half the rows, a
    place blank for 80%+ of its own, or blanks that are mostly whole rows left unrecorded (AH-63). Or a column the places
    leave blank as a matter of course, the middle place 10%+ blank: films' box office unknown for 46% of US and UK films
    ("country US: 48% missing box_office vs 32%"), members' middle names 0-38% blank by state; one place singled out
    against places that keep the column (Phoenix's incomes, 69% blank against 0%) stays a gap (AH-68). Not for a person's
    own answer or life (personal): a survey's question skipped more in one region, a laureate's death date, any blank on a
    survey's sheet, its rows its respondents (AH-68 review 1). Not by an answer's shape alone: a customer table's
    Approved (Yes/No) is a record, and its one state 62% blank is where the source kept it."""
    rates = table[True] / table.sum(axis=1)
    return bool(blank.mean() >= 0.5 or (rates >= 0.8).any() or (blank.sum() and unrecorded.sum() >= 0.8 * blank.sum())
                or (not personal and rates.median() >= 0.1))


def report(df, types, rows):
    """{protected: {col: why}, tests: [{column, test, measure, groups: {label: [rows, rate]}, p, verdict, text, context?}]}.
    verdict "gap" = the group that stands out differs from the rest by _big AND significantly (Bonferroni over every test
    of the scan); "even" = a small difference, or a real but small one; "unclear" = a big difference too few rows can
    prove, or groups too small to compare. With 3+ groups the group named is the one that stands out against the rest
    of the rows (its own 2x2 p-value, p_group, Bonferroni over the groups too), never the lowest group: with 40 countries
    the lowest is an ordinary one that happened to land low. Groups under MIN_GROUP rows are named as left out.
    context = one sentence of measured public context (ai/bias_rules.json), only when the rule measured this outcome and
    the sheet's gap runs the same way. Never on a flag-rate gap: that one is ours."""
    from anomaly_hunter.ai.bias_context import pane_note_matching  # here, not at the top: bias_context reads this module's words
    head = _subheader(df, types)  # a second header row is no person: left out of every group and measure (AH-53)
    rows = [r for r, h in zip(rows, head) if not h]
    df = df[~head.to_numpy()]
    types = {c: t for c, t in types.items() if not _unnamed(c)}  # a column with no name is never quoted
    prot = _people(df, types)
    blank_of = {c: _missing(df[c]) for c in types if c in df.columns}  # once a column: nonvoters' 119 were read 3 times (AH-65)
    # a row flagged only for its blank cells is counted under each column's blanks, where coverage and routing are
    # judged: "State TX: 0.9% rows flagged vs 25% - a real gap" was 150 blank Race cells in the states whose candidates'
    # race the source never recorded (round 38, AH-66). A flag on a value stays the scan's own judgement of the row
    flagged = pd.Series([r["severity"] in ("High", "Medium", "Low") for r in rows], index=df.index)
    blank_at = {c: b.to_numpy(bool) for c, b in blank_of.items()}
    for i, r in enumerate(rows):
        cells = r.get("cells") or []
        if flagged.iat[i] and cells and all(c in blank_at and blank_at[c][i] for c in cells):
            flagged.iat[i] = False
    counted = "rows flagged" if flagged.sum() == sum(r["severity"] in ("High", "Medium", "Low") for r in rows) else "rows flagged for a value"
    # ...and a column about people has its blanks measured too, by the other groups: artists' gender, nationality and
    # race left "N/A" for 25% of Non-White artists and 0.03% of White ones was "Non-White: 27% rows flagged vs 0.1% - a
    # real gap", and with blank-only rows out of the flag rate it was said nowhere (AH-66 review 1)
    missing = {c: b for c, b in blank_of.items() if prot.get(c) != PROXY}  # a place's blanks are where a source kept it
    for c in prot:  # ...an unknown person's "NA" too
        if types.get(c) == "text" and c in missing:
            missing[c] = missing[c] | _unknown(df[c])
    # ...never an option of a "select all that apply" question, whose blank is an answer (not chosen): "Male: 58% missing
    # Will you watch ... Macy's Parade vs 45% - a real gap" said who watches as if it were who skipped (AH-63)
    blanks = {f"missing {c}": (b, f"missing {c}", c, "missing") for c, b in missing.items() if b.sum() >= 5 and not ALL_THAT_APPLY.search(str(c))}
    outcomes = _outcomes(df, types, prot)
    amounts = _amounts(df, types, prot)
    measures = {"flag rate": (flagged, counted, None, None), **blanks, **outcomes}
    kinds = {name: "outcome" if name in outcomes else "missing" if name in blanks else "flag" for name in measures}
    # a row left unrecorded: blank in 3+ of the columns that are 90% filled (a candidate with no profile, AH-63)
    full = [c for c, b in blank_of.items() if b.mean() <= 0.1]
    gone = sum((blank_of[c].astype(int) for c in full), pd.Series(0, index=df.index))
    unrecorded = {c: b & (gone - (b.astype(int) if c in full else 0) >= 3) for c, b in missing.items() if f"missing {c}" in blanks}
    gates = _gates(_askers(df, types, blank_of), blanks)
    # a survey's blanks are its respondents' skips, never the source's coverage (AH-68 review 1: "East South Central: 60%
    # missing Household Income vs 15%" went under a plain header)
    from anomaly_hunter.engine.pipeline import _survey  # here: pipeline imports this module
    answers = _survey(list(types)) or any(set(_words(c)) & RESPONDENTS for c in types)
    tests, left, out_of_reach = [], MAX_TESTS, []
    for col, why in prot.items():
        g = _groups(df, col, types, place=why == PROXY)
        if g is None:
            if k := _many(df, col, types):  # never dropped silently: a nationality of 89 labels (round 38, AH-63)
                out_of_reach.append({"column": col, "kind": why, "test": "groups", "measure": "groups", "p": None, "groups": {},
                                     "verdict": "left out", "text": f"{col}: {k} different values, too many to compare as groups (50 at most) - left out"})
            continue
        maybe = _maybe(g.dropna()) if types.get(col) == "text" else {}
        gcodes, gnames = pd.factorize(g, sort=True)
        for name, (hit, what, subject, label) in list(measures.items())[:left]:
            left -= 1
            if kinds[name] == "missing" and subject in prot and why == PROXY:
                continue  # host cities only say which Games kept ages: coverage by place, never a gap (AH-66 review 2)
            if kinds[name] == "missing" and subject in prot and _coarser(g, df[subject], hit):
                continue  # "Non-White: 16% missing artist_race vs 0.0% for White" is how the source coded an unknown race
            ok = g.notna() & hit.notna()
            if kinds[name] == "missing" and subject in prot:  # ...nor by those who declined to say who they are: "gender
                # Other or prefer not to answer: 2.2% missing race" is the same refusal twice (AH-66 review 2)
                ok &= ~g.astype(str).str.contains(REFUSAL)
            gate = gates.get(name) if kinds[name] == "missing" else None
            # ...but never for a group whose own rows are 90%+ of those it routes past: 2 of every 5 women's events never
            # had their times kept, and "event" read that real gap as the events' layout; artists' ethnicity "NA" (57 of
            # 58 rows Non-White) read the unknown gender of Non-White artists as routing (AH-66 review 1). Paralympics'
            # individual events, 60% men's rows, still gate grp_id; so do the climbers who did not die, 90% men as all are
            if gate and _nested(g, gate[3], gate[1]):
                gate = None
            if gate and gate[0] != col:  # an earlier answer skipped it: compared among the rows it was asked of
                ok &= gate[1]
            table = _table(gcodes, gnames, ok.to_numpy(bool), hit)
            small = {str(k): int(n) for k, n in table.sum(axis=1).items() if n < MIN_GROUP}
            table = table[table.sum(axis=1) >= MIN_GROUP]
            base = {"column": col, "kind": why, "test": name, "measure": kinds[name], "subject": subject, "label": label, "maybe": maybe}
            if gate and gate[0] != col:
                said = ", ".join(gate[2][:3]) + (f" and {len(gate[2]) - 3} more" if len(gate[2]) > 3 else "")
                base["routed"] = f"; counted where it was asked ({gate[0]}: {said})"
            if kinds[name] == "missing" and why == PROXY and len(table) >= 2 and table.shape[1] == 2 and _coverage(hit, table, unrecorded[subject], answers or _personal(subject)):
                continue
            # a column blank for 95%+ of every group: its blank is the default and its rare entries a category, never a
            # skip ("SEX Male Characters: 100% missing GSM vs 99% - a real gap", AH-68)
            if kinds[name] == "missing" and len(table) >= 2 and table.shape[1] == 2 and (table[True] >= 0.95 * table.sum(axis=1)).all():
                continue
            # a question one group never answers, every one of its rows blank, is the survey's routing (atheists are
            # not asked about services): never "a real gap, check why". Said plainly, and the asked groups compared
            if kinds[name] == "missing" and table.shape[1] == 2 and len(table) > 2:
                routed = [k for k in table.index if table.loc[k, False] == 0]
                asked = table.drop(routed)
                # ...when the groups it is asked of mostly answer it: a column blank for nearly everyone (Thanksgiving's
                # "Other (please specify)", 93-98% blank) is sparse, not routed
                if routed and len(asked) >= 2 and asked[True].sum() <= 0.2 * asked.to_numpy().sum():
                    base["routed"] = "; not asked of " + _named({str(k): int(table.loc[k].sum()) for k in routed}) + ", every row blank"
                    table = table.drop(routed)
            if len(table) < 2 and len(table) + len(small) >= 2 and hit[ok].any():  # every group, or all but one, too small
                tests.append({**base, "p": None, "groups": {}, "small": small})
                continue
            # every group the same (none hit, or all): nothing to test, and chi-square raises on it - Cars93's missing
            # values all sat in groups under 20 rows, and every scan of it was a 500 (blind real tables, 2026-10-16)
            if len(table) < 2 or table.shape[1] < 2 or (table.sum(axis=0) == 0).any():
                continue
            rates = table[True] / table.sum(axis=1)
            # groups all or nothing, some at 0% and some at 100%, holding 90%+ of the rows: the measure is worked out
            # from the group, a definition, not something that happened to people ("subject_race White: 0.0%
            # person_of_color = 1 vs 83%": only Multi racial, 24 of 487 rows, was mixed; blind round 36)
            size, pure = table.sum(axis=1), rates.isin([0.0, 1.0])
            if kinds[name] != "flag" and (rates[pure] == 0).any() and (rates[pure] == 1).any() and size[pure].sum() >= 0.9 * size.sum():
                continue
            tests.append({**base, "p": float(chi2_contingency(table)[1]), "small": small,
                          "groups": {str(k): [int(table.loc[k].sum()), round(float(v), 4)] for k, v in rates.items()}, "table": table})
        for name, (x, what, subject) in list(amounts.items())[:max(0, left)] if not set(_words(col)) & CUTS else ():
            left -= 1
            base = {"column": col, "kind": why, "test": name, "measure": "amount", "subject": subject, "label": None, "maybe": maybe}
            if (t := _amount_test(g, x, base)) is not None:
                tests.append(t)
    n = sum(t["p"] is not None for t in tests)
    for t in tests:
        if t["measure"] == "amount":
            _amount_words(t, n)
            continue
        what = measures[t["test"]][1]
        subject, label, table, small, maybe = t.pop("subject"), t.pop("label"), t.pop("table", None), t.pop("small"), t.pop("maybe")
        out = (f"; too few to compare: {_named(small, maybe)}" if small else "") + t.pop("routed", "")
        if t["p"] is None:
            t["verdict"], t["text"] = "unclear", f"{t['column']}: {what} - too few rows to compare: {_named(small, maybe)}"
            continue
        rates = {k: v[1] for k, v in t["groups"].items()}
        span = f"{_pct(min(rates.values()))} to {_pct(max(rates.values()))}"
        if len(rates) == 2:
            hi, lo = max(rates, key=rates.get), min(rates, key=rates.get)
            a, b = rates[hi], rates[lo]
            real, hint, near = t["p"] * n < ALPHA, t["p"] < HINT, t["p"] < NEAR
            said = f"{t['column']} {hi}: {_pct(a)} {what} vs {_pct(b)} for {lo}"
        else:  # the group that stands out against all the others, and any that stand out with it the same way
            pairs, K = {}, len(table)
            for k in table.index:
                two = pd.DataFrame([table.loc[k], table.drop(k).sum()])
                pairs[str(k)] = (float(chi2_contingency(two)[1]), float(two.iloc[1][True] / two.iloc[1].sum()))
            sides = {+1: [k for k in pairs if rates[k] > pairs[k][1] and pairs[k][0] * n * K < ALPHA],
                     -1: [k for k in pairs if rates[k] < pairs[k][1] and pairs[k][0] * n * K < ALPHA]}
            best = min(pairs, key=lambda x: (pairs[x][0], -abs(rates[x] - pairs[x][1])))
            # 2 high and 2 low regions: the smaller set is named, the high one on a tie ("N: 40% vs 26%" read as if N
            # alone stood out, AH-18 review)
            side = min((s for s in sides if sides[s]), key=lambda s: (len(sides[s]), -s), default=None)
            names = [k for k in map(str, table.index) if k in sides[side]] if side else [best]
            mine = table.loc[[k for k in table.index if str(k) in names]].sum()
            rest = table.loc[[k for k in table.index if str(k) not in names]].sum()
            p_k = float(chi2_contingency(pd.DataFrame([mine, rest]))[1])
            t["p_group"] = p_k
            a, b = float(mine[True] / mine.sum()), float(rest[True] / rest.sum())
            real = t["p"] * n < ALPHA and p_k * n * K < ALPHA
            hint = t["p"] < HINT and p_k * K < HINT  # picking the group that stands out is itself a choice among K
            near = t["p"] < NEAR and p_k * K < NEAR
            said = f"{t['column']} {' and '.join(names)}: {_pct(a)} {what} vs {_pct(b)} for the other groups"
        big = _either(a, b)
        # "not enough rows to tell" only where the raw evidence points to a gap (raw p < HINT) that the correction for
        # testing many things at once cannot confirm; where chance explains the spread, it is within normal variation
        # (pure noise read "not enough rows to tell" in 13 of 20 sheets with 40 groups, AH-18 review)
        t["verdict"] = "gap" if big and real else "unclear" if big and hint and not real else "even"
        t["text"] = (f"{said} - a real gap, check why" if t["verdict"] == "gap"
                     else f"{t['column']}: {what} close across groups ({span} - a real difference, but small)" if real
                     else f"{t['column']}: {what} differs across groups ({span}), but there are not enough rows to tell whether that is a real gap"
                     if t["verdict"] == "unclear"
                     else f"{t['column']}: {what} no clear difference across groups ({span}); {_few(table, what)}, a gap this size could be chance"
                     if big and near else f"{t['column']}: {what} {'no clear difference' if big else 'even'} across groups ({span}, within normal variation)") + out
        note = pane_note_matching(t["column"], t["measure"], subject, _polarity(label) if t["measure"] == "outcome" else 1,
                                  t["groups"]) if t["verdict"] == "gap" else None
        if note:
            t["context"] = note
    return {"protected": prot, "tests": tests + out_of_reach}


def _amount_words(t, n):
    """An amount test's verdict and sentence, the yes/no ones' shapes with medians: a gap is the named group(s)' median
    1.25x the rest's (either way) and a rank test that holds after the correction over every test of the scan; with 3+
    groups the group that stands out against the rest, by its own test, Bonferroni over the groups too (AH-49)."""
    small, maybe, vals, what = t.pop("small"), t.pop("maybe"), t.pop("vals", None), t["test"]
    t.pop("subject"), t.pop("label")
    out = f"; too few to compare: {_named(small, maybe)}" if small else ""
    if t["p"] is None:
        t["verdict"], t["text"] = "unclear", f"{t['column']}: {what} - too few rows to compare: {_named(small, maybe)}"
        return
    meds = {k: v[1] for k, v in t["groups"].items()}
    span = f"{_say(min(meds.values()))} to {_say(max(meds.values()))}"
    if len(vals) == 2:
        hi, lo = max(meds, key=meds.get), min(meds, key=meds.get)
        a, b = meds[hi], meds[lo]
        real, hint = t["p"] * n < ALPHA, t["p"] < HINT
        said = f"{t['column']} {hi}: {what} {_say(a)} vs {_say(b)} for {lo}"
    else:
        K, rest = len(vals), lambda k: np.concatenate([v for j, v in vals.items() if j != k])
        pairs = {k: (float(mannwhitneyu(vals[k], rest(k)).pvalue), float(np.median(rest(k)))) for k in vals}
        sides = {+1: [k for k in pairs if meds[k] > pairs[k][1] and pairs[k][0] * n * K < ALPHA],
                 -1: [k for k in pairs if meds[k] < pairs[k][1] and pairs[k][0] * n * K < ALPHA]}
        best = min(pairs, key=lambda k: (pairs[k][0], -abs(meds[k] - pairs[k][1])))
        side = min((s for s in sides if sides[s]), key=lambda s: (len(sides[s]), -s), default=None)
        names = [k for k in vals if k in sides[side]] if side else [best]
        mine = np.concatenate([vals[k] for k in names])
        others = np.concatenate([v for k, v in vals.items() if k not in names])
        p_k = float(mannwhitneyu(mine, others).pvalue)
        t["p_group"] = p_k
        a, b = float(np.median(mine)), float(np.median(others))
        real = t["p"] * n < ALPHA and p_k * n * K < ALPHA
        hint = t["p"] < HINT and p_k * K < HINT
        said = f"{t['column']} {' and '.join(names)}: {what} {_say(a)} vs {_say(b)} for the other groups"
    big = max(a, b) >= RATIO * min(a, b) and max(a, b) > 0
    # a real spread 1.25x wide whose group cannot be singled out is no "small" difference: ISLR's wages by race
    # (81 to 115) read "close across groups" when no one group passed its own test
    wide = max(meds.values()) >= RATIO * min(meds.values())
    t["verdict"] = "gap" if big and real else "unclear" if (big and hint and not real) or (real and wide) else "even"
    t["text"] = (f"{said} - a real gap, check why" if t["verdict"] == "gap"
                 else f"{t['column']}: {what} differs across groups ({span}), but there are not enough rows to tell whether that is a real gap"
                 if t["verdict"] == "unclear"
                 else f"{t['column']}: {what} close across groups ({span} - a real difference, but small)" if real
                 else f"{t['column']}: {what} {'no clear difference' if big or wide else 'even'} across groups ({span}, within normal variation)") + out
