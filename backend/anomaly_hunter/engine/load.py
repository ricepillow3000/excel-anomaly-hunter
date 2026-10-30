"""Files or panel rows -> DataFrame. Classify columns number/date/text, coerce in place."""
import re
from pathlib import Path

import pandas as pd


class LoadError(Exception):
    pass


def numbers(column_types):
    return [c for c, t in column_types.items() if t == "number"]


def _blank(s):
    return s.isna() | (s.astype(str).str.strip() == "")


# header ends with an identifier word: "SKU", "Employee ID", "Claim #", "Acct No.", "Zip Code", "MRN" (whole words:
# "Mean" is not "ean", "Barcode" is not "code")
ID_NAME = re.compile(r"(#|(^|[^a-z])(id|no\.?|num(ber)?|code|sku|zip|postal|mrn|acct|account|ssn|upc|ean))\s*$", re.I)


def _is_id(name, num):
    """Whole numbers that label rows instead of measuring them: ID-like header, or >=20 near-sequential unique values.
    Only 0s and 1s is a yes/no flag, never an ID, whatever the header ("Delinquent_Account": 0/1, not an account number)."""
    if not len(num) or (num != num.round()).any() or set(num.unique()) <= {0, 1}:
        return False
    # "No" is a row number - unless its numbers repeat: nitric oxide "NO" readings were skipped as an ID (2026-10-16)
    if ID_NAME.search(str(name)) and not (re.search(r"(^|[^a-z])no\.?\s*$", str(name), re.I) and num.nunique() < 0.95 * len(num)):
        return True
    u = num.drop_duplicates().sort_values()
    return len(num) >= 20 and len(u) >= 0.95 * len(num) and u.diff().median() <= 2


TZ = re.compile(r"(\d:\d\d(?::\d\d(?:\.\d+)?)?)\s*(?:Z|[+-]\d\d:?\d\d)$")  # a time, then its zone: "08:30:00+02:00"


def _dates(s, wide=False):
    """Parse dates; years outside 1900-2200 don't count (cost code "03-100" parses as the year 100). Day-first is decided
    once for the column - a 13/01 anywhere (and no 01/13) means 01/02 is the 1st of February, not January 2nd."""
    # A timestamp's own offset ("...T00:00:00Z", "+02:00") is dropped: the date as written. A UTC column with a blank came
    # back as plain objects and mixed offsets made pandas raise: every scan of a real clinical export failed (2026-10-16).
    # utc=True then no zone covers the rest ("GMT"): pandas never gets two kinds of timestamp to merge.
    text = s.astype(str)
    # a cell a date fits in (64 characters) and no more: dateutil reads a long run of digits in quadratic time, and every
    # text cell is asked whether it is a date. One 400,000-digit cell took 13 s of a 16 s scan (AH-32 review, AH-52)
    # ...measured without its padding: a fixed-width export writes "2024-01-05" and 70 spaces, and pandas reads it (AH-52
    # review, Council A). A run of 400,000 spaces strips to nothing, a run of digits stays as long as it is
    # The parser gets the cell without its padding too: 400,000 spaces handed to dateutil took a second
    bare = text.str.strip()
    fits = bare.str.len() <= 64
    if not fits.all() or (bare.str.len() < text.str.len()).any():
        s = s.where(~s.map(lambda v: isinstance(v, str)), bare).where(fits)
        text = bare.where(fits, "")
    timed = text.str.contains(":", regex=False)  # only a time can carry a zone: the regex runs on those cells alone
    if timed.any():
        s = s.copy()
        s[timed] = text[timed].str.replace(TZ, r"\1", regex=True)
    when = lambda x, **kw: pd.to_datetime(x, errors="coerce", format="mixed", utc=True, **kw).dt.tz_localize(None)
    parts = text.str.extract(r"^\s*(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}").astype(float)
    dayfirst = bool((parts[0] > 12).any() and not (parts[1] > 12).any())
    dmy = parts[0].notna()  # only those cells: dayfirst would also flip ISO dates (2024-01-05 -> May 1)
    d = when(s.where(~dmy)).fillna(when(s.where(dmy), dayfirst=dayfirst))
    if not wide:
        return d.where(d.dt.year.between(1900, 2200))
    # wide: also a cell that writes its year in full (1862-06-07, June 7, 1862) from 1000 to 2999, for the far-date check
    # of a text column: Excel keeps a date before 1900 as text (AH-32)
    # ...with its day too: a lot code "1045-03" (plant, month) is no date, and its odd "2950-04" was a far "2950-04-01"
    # (AH-32 review)
    # Only a cell a date fits in (40 characters), and month words bounded and anchored: the unanchored "[a-z]{3,} +\d"
    # re-scanned a run of letters from every start, 16,000 letters took 4 s a cell, and a crafted cell hung the scan
    short = text.str.strip().str.len() <= 40
    t = text.where(short, "")
    day = t.str.contains(r"\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}") | t.str.contains(
        r"\b\d{1,2}(?:st|nd|rd|th)?,? +[a-z]{3,9}\b|\b[a-z]{3,9}\.? +\d{1,2}(?:st|nd|rd|th)?\b", case=False)
    full = short & t.str.contains(r"(?<!\d)[12]\d{3}(?!\d)") & day
    return d.where(d.dt.year.between(1900, 2200) | (full & d.dt.year.between(1000, 2999)))


def _padded(s):
    """A column of digit codes written to a fixed width with their leading zeros (ZIP "02134", an EmployeeID "000101")
    -> that width, else 0. The pane sends a Text-formatted cell as its string, and read as a number "02134" became 2134:
    a code that lost its zeros ("2134") went unseen and the fairness report named groups "2134" and "7102", values no
    cell holds (chaos audit, AH-75). 90% of the cells digits, 90% of those one width of 3+, 2+ of them led by a 0: a
    quantity is no fixed width (one "007" among counts stays a number), and a Month or Hour typed "01"-"12" (width 2)
    keeps the bounds its name sets."""
    v = s[~_blank(s)].astype(str).str.strip()
    v = v[~v.str.fullmatch(NO_VALUE)]
    digits = v[v.str.fullmatch(r"\d+")]
    if not len(v) or len(digits) < 0.9 * len(v):
        return 0
    w = digits.str.len()
    width = int(w.mode().iloc[0])
    led = (w == width) & digits.str.startswith("0")
    return width if width >= 3 and (w == width).mean() >= 0.9 and led.sum() >= 2 else 0


# stand-ins for a missing value. Not "NA" (a ticker, a country) or "None" (a real category)
# ...except in a number or date column, where NA, NaN, null and None are what a program writes for "no value" (R, pandas,
# JSON): a missing cell, like a blank. Read as text, R's NA made ~3,960 false Medium rows in blind round 23 (AH-27)
NO_VALUE = re.compile(r"\s*(na|nan|null|none)\s*", re.I)
PLACEHOLDER = re.compile(r"error|unknown|n/a|null|tbd|\?|-", re.I)
# a word that says the value is not known. Never guessed to be another label: Race "Blank" read as a misspelling of
# "Black" gave a race to people whose race is unknown (AH-39 review, AH-50). A typo of one ("Unknwn") is still a typo
NO_VALUE_WORD = re.compile(r"\s*(blank|blanks|empty|missing|unknown|unk|none|nil|null|na|n/a|n\.a\.|nan|tbd|tba|tbc|\?+|-+"
                           r"|(?:not|un)[ -]?(?:known|stated|specified|applicable|available|recorded|reported|given)"
                           r"|undefined|unspecified|no answer|no data|no response|prefer not to say)\s*", re.I)
EXCEL_ERROR = re.compile(r"#(N/A|DIV/0!|REF!|VALUE!|NAME\?|NUM!|NULL!|SPILL!|CALC!)$")
# money / percent typed as text, the WHOLE cell: "$1,234.00", "12%", "(500)" = -500. Commas must be thousands groups.
MONEY = re.compile(r"(\()?([-+])?[$€£]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%)?(\))?")


def _num(s):
    """Cells -> numbers (NaN where not a number). Plain numbers as pandas reads them, plus money/percent text."""
    # "-" is how accounting format shows 0 in an exported sheet - when it's the column's convention (8%+ of its cells, the
    # placeholder rule). Excel hands the pane an accounting zero as 0, so a rarer "-" was typed for a missing value: 5 of
    # 6 missed placeholders on 40 real sheets, each silently summed as 0 (2026-10-16)
    dash = s.astype(str).str.strip() == "-"
    src = s.mask(dash, 0) if dash.sum() >= 0.08 * (~_blank(s)).sum() else s
    num = pd.to_numeric(src, errors="coerce")
    # ...and read exactly: pandas' own parser is off in the 15th digit (-0.013338153250515461 came back -0.0133381532505154),
    # so a reason quoted a value no cell holds (AH-40)
    if num.dtype.kind == "f":  # whole numbers it reads exactly, and keeps as integers
        num[num.notna()] = src[num.notna()].astype(float)
    m = s[num.isna()].astype(str).str.strip().str.extract(f"^{MONEY.pattern}$")
    ok = m[2].notna() & (m[0].isna() == m[5].isna())  # parentheses come in pairs
    v = (m[2].str.replace(",", "") + m[3].fillna("")).astype(float)
    v = v.where(m[1] != "-", -v).where(m[0].isna(), -v) / m[4].notna().map({True: 100, False: 1})
    return num.fillna(v.where(ok))


# a row labelled like a summary. "Total"-words are almost never data; "Average" can be a category (a rating)
TOTAL = re.compile(r"\s*(sub\s*-?\s*total|grand\s+total|totals?)\b", re.I)
STAT = re.compile(r"\s*(sum|mean|median|average|avg)\b", re.I)


def _kind(s):
    """number / id / date / text: 90% of non-blank cells must parse. id = number column that's an identifier."""
    s = s[~_blank(s)]
    s = s[s.astype(str).str.strip() != "-"]  # an accounting dash counts as 0 in a number column, but says nothing about the type
    s = s[~s.astype(str).str.fullmatch(NO_VALUE)]  # nor does a missing value
    if not len(s):
        return "text"
    if _padded(s):  # a code, never a quantity: an ID when it labels rows, else a label (a ZIP, a branch) to group by
        num = pd.to_numeric(s, errors="coerce").dropna()
        return "id" if _is_id(s.name, num) or (len(s) >= 20 and s.nunique() >= 0.95 * len(s)) else "text"
    num, err = _num(s), s.astype(str).str.strip().str.match(EXCEL_ERROR)
    # Excel errors (#DIV/0!) are broken numbers, not a sign the column is text - as long as most cells are numbers
    if num.notna().mean() >= 0.5 and num[~err].notna().mean() >= 0.9:
        return "id" if _is_id(s.name, num.dropna()) else "number"
    if _dates(s).notna().mean() >= 0.9:
        return "date"
    return "text"


# a negative code for "no value": the export writes it in place of an answer or a reading (AH-62)
CODES = (-1, -9, -99, -999, -9999, -99999)


def _code(num):
    """A negative code the column writes 5+ times: its "no value", never a slip (AH-62). Round 38: a survey's -1 (skipped,
    5 to 5,529 times in 110 columns) made 972 Medium rows and 267 "likely 1" cards, and a turbine table's -9999 (1,375
    times) 1,368 Medium rows and limits of -5,200 to 5,400 that hid a hub height of 800 among 60-115. A small code (-1, -9)
    is the column's only negative, on an answer scale (20 whole values or fewer) and beside more than a sign (-1/0/1 and
    -1/1 are scales): a -1 among sales of ~500 is still a slip to catch (test_engine's sentinels). A large one sits far
    below the rest (-999 beside real depths to -500 is no code). -> (code, its cells) or None."""
    x = num.dropna()
    for code in CODES:
        hit = x == code
        rest = x[~hit]
        if hit.sum() < 5 or len(rest) < 5:
            continue
        small = code > -99 and (rest.min() < 0 or set(rest.unique()) <= {0, 1} or rest.nunique() > 20 or (rest != rest.round()).any())
        if small or code <= -99 and rest.min() <= code / 2:
            continue
        return code, hit.index[hit]
    return None


class _Shared(dict):
    """Set once, never changed: pandas deep-copies a frame's attrs on every operation, and copying 638 row numbers per
    column each time made a 20,000-row R export scan 2x slower (6 s -> 15 s, AH-27 build). Copies share this one."""
    def __deepcopy__(self, memo):
        return self


def _coerce(df, cols):
    """-> (types, errors_log). errors_log = (row, col, raw) for text stuck in a number or date column."""
    # remember summary labels before coercion erases them ("Total" in a date column becomes NaT)
    # just the few labelled row numbers: pandas copies attrs on every operation
    for key, rx in (("total_rows", TOTAL), ("stat_rows", STAT)):
        df.attrs[key] = frozenset(df.index[df[cols].apply(lambda s, rx=rx: s.astype(str).str.match(rx)).any(axis=1)])
    types, errors = {c: _kind(df[c]) for c in cols}, []
    no_value = {}  # column -> (rows, the word as most often written): how its export says "no value"
    for c, t in types.items():
        said = df[c].astype(str).str.fullmatch(NO_VALUE) if t in ("number", "id", "date") else None
        if said is not None and said.any():
            no_value[c] = (frozenset(df.index[said]), df[c][said].astype(str).str.strip().mode()[0])  # comparable, unlike an array
            df[c] = df[c].mask(said, "")
    df.attrs["no_value"] = _Shared(no_value)
    typed = {}  # column -> {row: the cell as typed}, for a percent typed as text: "+22%" is held as 0.22 (AH-56)
    codes = {}  # column -> (rows, the code): a negative code the column writes for "no value", held as a blank (AH-62)
    # column -> its width: digit codes kept as typed, "02134" never 2134 (AH-75)
    padded = {c: w for c, t in types.items() if t in ("id", "text") and (w := _padded(df[c]))}
    for c, t in types.items():
        if c in padded:
            continue
        if t in ("number", "id"):
            pct = df[c].astype(str).str.contains("%", regex=False)
            if t == "number" and pct.any():
                typed[c] = {i: str(df.at[i, c]).strip() for i in df.index[pct]}
            num = _num(df[c])
            num = num.where(num.abs() < 1e100)  # "inf", 1e160: no real measurement - and they break the math downstream
            bad = num.isna() & ~_blank(df[c])
            if t == "number":  # text in a measurement is an error...
                errors += [(i, c, df.at[i, c]) for i in df.index[bad]]
                if found := _code(num):
                    codes[c] = (frozenset(found[1]), found[0])
                    num = num.mask(num.index.isin(found[1]))
                df[c] = num
            else:  # ...but an ID like "A-17" among numbers is fine: keep it as it is
                df[c] = num.astype(object).where(~bad, df[c]) if bad.any() else num
        elif t == "date":  # text in a date column is an error too, not a "blank"
            # ...but a date written in full from 1000 to 2999 is a date: deaths since 1791 among a column of 1900s dates
            # were 176 "text" cells, whose shape excused a year 2955 typo as the column's own code (round 37, AH-55)
            d = _dates(df[c], wide=True)
            errors += [(i, c, df.at[i, c]) for i in df.index[d.isna() & ~_blank(df[c])]]
            df[c] = d
    df.attrs["typed"] = _Shared(typed)
    df.attrs["codes"] = _Shared(codes)
    df.attrs["padded"] = _Shared(padded)
    return types, errors


def _read(p):
    p = Path(p)
    # keep_default_na=False: keep literal "N/A" text so type-error check sees it
    kw = {"dtype": str, "keep_default_na": False, "na_values": []}
    try:
        if p.suffix.lower() == ".csv":
            df = pd.read_csv(p, **kw)
        elif p.suffix.lower() in (".xlsx", ".xlsm"):
            df = pd.read_excel(p, sheet_name=0, **kw)
        else:
            raise ValueError(f"unsupported extension {p.suffix}")
    except Exception as e:
        raise LoadError(f"Could not read {p.name}: {e}") from e
    return df.assign(source_file=p.name)


def load_inputs(paths):
    """Read + stack files (union of columns). -> (df, types, errors_log, warnings)."""
    frames = [_read(p) for p in paths]
    df = pd.concat(frames, ignore_index=True, sort=False)
    warnings = [f"{Path(p).name} is missing columns: {', '.join(m)}"
                for f, p in zip(frames, paths) if (m := [c for c in df.columns if c not in f.columns])]
    return df, *_coerce(df, [c for c in df.columns if c != "source_file"]), warnings


def load_from_records(columns, rows):
    """Panel rows -> (df, types, errors_log). Stringify first so it matches the file path."""
    cols = []
    for c in map(str, columns):  # dedupe headers pandas-style (Name, Name.1), skipping names already taken: dup label breaks df[c]
        name, k = c, 0
        while name in cols:
            k += 1
            name = f"{c}.{k}"
        cols.append(name)
    df = pd.DataFrame([["" if v is None else str(v) for v in r] for r in rows], columns=cols)
    return df, *_coerce(df, cols)
