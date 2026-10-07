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
    """Whole numbers that label rows instead of measuring them: ID-like header, or >=20 near-sequential unique values."""
    if not len(num) or (num != num.round()).any():
        return False
    if ID_NAME.search(str(name)):
        return True
    u = num.drop_duplicates().sort_values()
    return len(num) >= 20 and len(u) >= 0.95 * len(num) and u.diff().median() <= 2


def _dates(s):
    """Parse dates; years outside 1900-2200 don't count (cost code "03-100" parses as the year 100). Day-first is decided
    once for the column - a 13/01 anywhere (and no 01/13) means 01/02 is the 1st of February, not January 2nd."""
    parts = s.astype(str).str.extract(r"^\s*(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}").astype(float)
    dayfirst = bool((parts[0] > 12).any() and not (parts[1] > 12).any())
    dmy = parts[0].notna()  # only those cells: dayfirst would also flip ISO dates (2024-01-05 -> May 1)
    d = pd.to_datetime(s.where(~dmy), errors="coerce", format="mixed").fillna(
        pd.to_datetime(s.where(dmy), errors="coerce", format="mixed", dayfirst=dayfirst))
    return d.where(d.dt.year.between(1900, 2200))


EXCEL_ERROR = re.compile(r"#(N/A|DIV/0!|REF!|VALUE!|NAME\?|NUM!|NULL!|SPILL!|CALC!)$")
# money / percent typed as text, the WHOLE cell: "$1,234.00", "12%", "(500)" = -500. Commas must be thousands groups.
MONEY = re.compile(r"(\()?([-+])?[$€£]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%)?(\))?")


def _num(s):
    """Cells -> numbers (NaN where not a number). Plain numbers as pandas reads them, plus money/percent text."""
    num = pd.to_numeric(s.mask(s.astype(str).str.strip() == "-", 0), errors="coerce")  # "-" is how accounting format shows 0
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
    if not len(s):
        return "text"
    num, err = _num(s), s.astype(str).str.strip().str.match(EXCEL_ERROR)
    # Excel errors (#DIV/0!) are broken numbers, not a sign the column is text - as long as most cells are numbers
    if num.notna().mean() >= 0.5 and num[~err].notna().mean() >= 0.9:
        return "id" if _is_id(s.name, num.dropna()) else "number"
    if _dates(s).notna().mean() >= 0.9:
        return "date"
    return "text"


def _coerce(df, cols):
    """-> (types, errors_log). errors_log = (row, col, raw) for text stuck in a number or date column."""
    # remember summary labels before coercion erases them ("Total" in a date column becomes NaT)
    # just the few labelled row numbers: pandas copies attrs on every operation
    for key, rx in (("total_rows", TOTAL), ("stat_rows", STAT)):
        df.attrs[key] = frozenset(df.index[df[cols].apply(lambda s, rx=rx: s.astype(str).str.match(rx)).any(axis=1)])
    types, errors = {c: _kind(df[c]) for c in cols}, []
    for c, t in types.items():
        if t in ("number", "id"):
            num = _num(df[c])
            num = num.where(num.abs() < 1e100)  # "inf", 1e160: no real measurement - and they break the math downstream
            bad = num.isna() & ~_blank(df[c])
            if t == "number":  # text in a measurement is an error...
                errors += [(i, c, df.at[i, c]) for i in df.index[bad]]
                df[c] = num
            else:  # ...but an ID like "A-17" among numbers is fine: keep it as it is
                df[c] = num.astype(object).where(~bad, df[c]) if bad.any() else num
        elif t == "date":  # text in a date column is an error too, not a "blank"
            d = _dates(df[c])
            errors += [(i, c, df.at[i, c]) for i in df.index[d.isna() & ~_blank(df[c])]]
            df[c] = d
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
