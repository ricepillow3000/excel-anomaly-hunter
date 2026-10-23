"""Score a loaded DataFrame: 3 detector votes + hygiene facts -> severity, bucket, reason per row.
Shared by CLI and server."""
import collections
import itertools
import re

import numpy as np
import pandas as pd

from anomaly_hunter.engine import fairness
from anomaly_hunter.engine.detectors import _result, isolation_detector, limits_detector, sequence_detector
from anomaly_hunter.engine.load import EXCEL_ERROR, PLACEHOLDER, _blank, numbers

def summary_rows(df):
    """Rows that summarise the data instead of being data -> bool array: fully blank rows, rows labelled
    Total/Subtotal/Mean/... that are sparser than a normal row ("Total Wine" the vendor is a full row), and
    unlabelled rows whose numbers equal the sum of the rows above them."""
    if df.empty:  # headers only: nothing to summarise (np.median of nothing warns)
        return np.zeros(len(df), dtype=bool)
    cols = [c for c in df.columns if c != "source_file"]
    count = (~df[cols].apply(_blank)).sum(axis=1).to_numpy()
    nums = [c for c in cols if df[c].dtype.kind in "fi"]
    # no text filled in (a date may be: a month-end subtotal is dated) - on a sheet with no text, no date either
    labels = [c for c in cols if c not in nums and df[c].dtype.kind != "M"] or [c for c in cols if c not in nums]
    unlabelled = df[labels].apply(_blank).all(axis=1).to_numpy()
    rows_with = lambda key: df.index.isin(df.attrs.get(key, ()))  # set by load, before coercion
    sparse = count < np.median(count)  # a totals row leaves the label/date/text cells empty
    # "Total" + sparse; "Average"/"Mean" only if half empty ("Average" can be a rating in a normal row)
    mask = (count == 0) | (rows_with("total_rows") & sparse) | (rows_with("stat_rows") & (count <= np.median(count) / 2))
    x = df[nums].to_numpy(dtype=float)
    run = np.vstack([np.zeros(len(nums)), np.nancumsum(x, axis=0)])  # run[i] = sum of rows before i
    start = 0
    for i in np.flatnonzero(mask | sparse):  # only sparse rows can be unlabelled totals
        if mask[i]:
            start = i + 1
            continue
        above = run[i] - run[start]
        have = ~np.isnan(x[i]) & (above != 0)
        if i - start >= 2 and sparse[i] and unlabelled[i] and have.any() and (np.abs(x[i][have] - above[have]) <= 0.005 * np.abs(above[have])).all():
            mask[i], start = True, i + 1
    return mask


def duplicates(df, errors_log=()):
    """Row equal to an earlier row in every column but source_file. Text typed into a number or date column is compared as
    that text: loading had blanked it, so "R+33.2" and "D+6.3" rows looked equal (513 false duplicates, 2026-10-16)."""
    cols = [c for c in df.columns if c != "source_file"]
    cells, at = df[cols].astype(str).to_numpy(copy=True), {c: k for k, c in enumerate(cols)}
    for i, c, raw in errors_log:
        cells[i, at[c]] = f"text:{raw}"
    seen, out = {}, []
    keys = list(map(tuple, cells))
    # when most rows repeat, a repeat is the data: 4 agree/disagree answers from 1,529 voters gave 199 different rows,
    # and 1,330 were "Duplicate of row N" (real survey, 2026-10-16). A double entry repeats a row that is otherwise unique
    if len(set(keys)) < 0.5 * len(keys):
        return [[] for _ in keys]
    for i, key in enumerate(keys):
        j = seen.setdefault(key, i)
        src = f" ({df['source_file'].iloc[j]})" if "source_file" in df else ""  # CLI path only
        out.append([f"Duplicate of row {j + 2}{src}"] if j != i else [])
    return out


def _short(t):
    """Cell text quoted in a reason, at most 60 characters: a 32k-character cell keeps the reason readable."""
    t = str(t)
    return t if len(t) <= 60 else t[:57] + "..."


MISSING = re.compile(r"na|nan|none|missing", re.I)


def _shape(raw):
    """R+51.5 -> a+9.9, 16A -> 9a: the pattern of a code, not its value."""
    return re.sub(r"[^\W\d_]+", "a", re.sub(r"\d+", "9", str(raw).strip()))


def type_errors(n, errors_log, column_types):
    """Text in a number or date column. A text shape the column repeats 5+ times is its own code system (partisan lean
    "R+51.5", district "16A": 8,000 false rows on one real sheet, 2026-10-16), not a slip; placeholders and missing-value
    words (N/A, -, NA) never are. The cells stay in errors_log: they are text, for duplicates and blanks alike."""
    out = [[] for _ in range(n)]
    code = lambda raw: not (EXCEL_ERROR.match(str(raw).strip()) or PLACEHOLDER.fullmatch(str(raw).strip())
                            or MISSING.fullmatch(str(raw).strip()))
    shapes = collections.Counter((col, _shape(raw)) for _, col, raw in errors_log if code(raw))
    for i, col, raw in errors_log:
        kind, text = "date" if column_types[col] == "date" else "number", str(raw).strip()
        if code(raw) and shapes[col, _shape(raw)] >= 5:
            continue
        raw = _short(raw)
        out[i].append(f"Excel error {raw} in {col}" if EXCEL_ERROR.match(text) else f'Placeholder "{raw}" in column {col}'
                      if PLACEHOLDER.fullmatch(text) else f'Text "{raw}" in {kind} column {col}')
    return out


def placeholders(df, column_types, skip):
    """ERROR / UNKNOWN / N/A / NULL / ? / - left in a text column, when that word is rare (< 8% of the column: more often
    it's a real category, like Status "Error"). Excel errors (#N/A) always: they are a broken formula, never a category."""
    out = [[] for _ in range(len(df))]
    for col, t in column_types.items():
        if t != "text":
            continue
        v = df[col].astype(str).str.strip()
        err = v.str.match(EXCEL_ERROR)
        ph, key = v.str.fullmatch(PLACEHOLDER) & ~skip, v.str.upper()
        rare = key.map(key[ph].value_counts()).fillna(0) <= max(1, 0.08 * (~_blank(df[col]) & ~skip).sum())
        hit = (err & ~skip) | (ph & rare)
        if hit.any():
            for i in df.index[hit]:
                out[i].append(f"Excel error {v[i]} in {col}" if err[i] else f'Placeholder "{v[i]}" in column {col}')
    return out


MANY = 20  # blanks in one column: from here, spread through the sheet, they are how the data is (AH-28)


def blanks(df, column_types, skip, errors_log, threshold=0.80):
    """Blank cell in a column that is >= 80% filled (summary rows not counted): a required field left empty. Mostly-empty
    columns (notes, optional extras) are left alone. Was 95%: a credit sheet's Income, 92% filled, hid 39 blanks.
    -> (blank reasons per row, notes per row): 20+ blanks found in every fifth of the sheet are one note on the first."""
    out, prot = [[] for _ in range(len(df))], fairness.protected(column_types)
    notes = [[] for _ in range(len(df))]
    wrong = {}  # text/errors already named as such are not blanks
    for i, c, _ in errors_log:
        wrong.setdefault(c, []).append(i)
    # a blank its whole category group shares is the sheet's layout (a long-format sheet fills "value" for some metrics,
    # "pct" for others: 17,852 false rows on one real sheet, 2026-10-16); a blank inside an otherwise filled group is a slip
    labels = {}
    for g, t in column_types.items():
        lab = df[g].astype(str).str.strip().where(~skip & ~_blank(df[g])) if t == "text" else None
        if lab is not None and lab.nunique() <= 50 and len(labels) < 64:  # 64: a crafted 1,000-column sheet stays fast
            labels[g] = lab
    cols = list(column_types)
    if not cols:
        return out, notes
    blank = np.column_stack([(_blank(df[c]) & ~skip & ~df.index.isin(wrong.get(c, []))).to_numpy(bool) for c in cols])
    # blanks per label per column, counted for every column at once: grouping each label column against each column
    # took 168 s on a crafted 64 x 1,500-column sheet (AH-16 build, 2026-10-22)
    groups = {}
    for g, lab in labels.items():
        code = pd.factorize(lab)[0]
        keep = np.flatnonzero(code >= 0)
        order = keep[np.argsort(code[keep], kind="stable")]
        if not len(order):
            continue
        starts = np.flatnonzero(np.r_[True, np.diff(code[order]) != 0])
        size = np.diff(np.r_[starts, len(order)])
        groups[g] = (code, size, np.add.reduceat(blank[order].astype(np.int32), starts, axis=0))
    n = max(1, (~skip).sum())
    for j, col in enumerate(cols):
        b = blank[:, j].copy()
        if b.any() and 1 - b.sum() / n >= threshold:
            for g, (code, size, per) in groups.items():
                # a group all blank before the groups above took theirs; the rest counted again on what is left
                if g == col or not ((per[:, j] == size) & (size >= 5)).any() or not (b & (code >= 0)).any():
                    continue
                now = np.bincount(code[code >= 0], weights=b[code >= 0], minlength=len(size))
                b &= ~np.isin(code, np.flatnonzero((now == size) & (size >= 5)))
            # an unknown age on 177 of 891 Titanic passengers, a film with no cast listed: one Medium per row was 1,401 rows
            # on two real tables (blind round 23). Many blanks in every fifth of the sheet are the data; a few, or a block
            # (a paste or an export that stopped), are still each a slip
            # Where the export writes "NA" for no value, those cells and the truly empty ones are judged apart: R never
            # leaves a cell empty, so an empty one among 638 bye-week NAs is a deleted value (blind round 23's NFL plant).
            # An "NA" the column writes 5+ times is its convention, like a code it repeats (type_errors), even in a block:
            # the Tour de France's first 8 years have no times, on purpose; a one-off is still a blank
            said, word = df.attrs.get("no_value", {}).get(col, (frozenset(), ""))
            coded = df.index.isin(list(said))
            for said_so in (True, False):
                part = b & (coded if said_so else ~coded)
                pos = np.flatnonzero(part)
                if len(pos) >= 5 if said_so else len(pos) >= MANY and len(set(pos * 5 // len(b))) == 5:
                    notes[df.index[pos[0]]].append(f'{col} is "{word}" (no value) in {len(pos)} of {n} rows' if said_so
                                                   else f"{col} is blank in {len(pos)} of {n} rows, spread through the sheet")
                    continue
                for i in df.index[part]:
                    out[i].append(f"Blank cell in column {col}, which is otherwise filled")
        elif b.any():
            # a long-format sheet fills Value for some indicators and Pct for others, so Value is 2/3 filled, under the bar,
            # and a blank in a GDP row went unseen (AH-17 stress hunt, 9 of 9 missed). A group that fills the column
            # (95%+, 20+ rows) next to one that leaves it empty (20% or less, 20+ rows) is the layout; a blank in the filled group
            # is a slip. Never judged by a protected group: a person's blank is not measured against their sex or race
            for g, (code, size, per) in groups.items():
                if g == col or g in prot or not 2 <= len(size) <= 20:
                    continue
                fill = 1 - per[:, j] / size
                full = np.flatnonzero((fill >= 0.95) & (size >= 20))
                # ...and the empty group is layout only with 20+ rows of its own: a real planets table's distance (96% filled
                # for one method) had only 1 of 5 Pulsar rows empty-ish, and 23 real gaps were called a slip (blind round 22)
                if len(full) and ((fill <= 0.2) & (size >= 20)).any():
                    for i in df.index[b & np.isin(code, full)]:
                        out[i].append(f"Blank cell in column {col}, which is otherwise filled for {g} {_short(labels[g][i])}")
                    break
    return out, notes


def whole_numbers(df, column_types, skip):
    """A lone decimal in a column of whole numbers: study day 7.3 typed for 73, between days 72 and 74 - no limit can
    catch it (real clinical sheet, 2026-10-16). Worth a check (Low), no fix: the slip could be anywhere in the number."""
    out = [[] for _ in range(len(df))]
    for col, t in column_types.items():
        x = df[col][~skip].dropna() if t == "number" else ()
        if len(x) < 30 or x.nunique() < 3:
            continue
        odd = (x - x.round()).abs() > 1e-9 * x.abs().clip(lower=1)  # float noise (2.99 - 1.99) is still whole
        if 1 <= odd.sum() <= max(1, 0.005 * len(x)):
            for i in x.index[odd]:
                out[i].append(f"{col} {x[i]:g} is not a whole number - every other {col} is")
    return out


BOUNDED = [(r"month", 1, 12), (r"quarter|qtr", 1, 4), (r"hour", 0, 24), (r"minute|second", 0, 59),
           (r"weekday|day of week", 0, 7), (r"lat|latitude", -90, 90), (r"lon|lng|long|longitude", -180, 180)]
SCALE = re.compile(r"\(\s*(\d+)\s*(?:-|–|to)\s*(\d+)\s*\)|\bout of (\d+)\b", re.I)


def _bounds(col):
    """What a column's name says its numbers can be: the header IS the name ("date of month" and "count per hour" are
    not), or it writes its own scale ("Rating (1-5)", "out of 10"). Long headers are questions or notes, not names."""
    h = " ".join(re.sub(r"[_.]+", " ", str(col)).split()).lower()
    if len(h) > 200:
        return None
    if m := SCALE.search(h):
        return (float(m[1]), float(m[2])) if m[1] else (0.0, float(m[3]))
    whole = re.sub(r"\([^()]*\)", "", h).strip()  # "Month (number)" is still Month
    return next(((float(lo), float(hi)) for pat, lo, hi in BOUNDED if re.fullmatch(pat, whole)), None)


def named_bounds(df, column_types, skip):
    """A number past what its column's name allows: Month 13, Hour 25, a 6 on "Rating (1-5)" - each just past the other
    values, so no limit can call it (John's "syntactically correct but contextually impossible", AI council 2026-10-16).
    Quiet when more than max(2, 1%) break the bound: then the name means something else (yyyymm months, visit month 0,
    longitudes on 0-360). 40 random real tables: 13 such columns, 0 flags. Worth a check (Low), no fix."""
    out = [[] for _ in range(len(df))]
    for col, t in column_types.items():
        b = _bounds(col) if t == "number" else None
        x = df[col][~skip].dropna() if b else ()
        bad = x[(x < b[0]) | (x > b[1])] if b else ()
        if 1 <= len(bad) <= max(2, 0.01 * len(x)):
            for i in bad.index:
                out[i].append(f"{col} {x[i]:g} is outside what {col} can be ({b[0]:g} to {b[1]:g})")
    return out


def far_dates(df, column_types, skip):
    """Date more than the column's whole 1%-99% span away from it (a 2018 sheet with 2084 in it). Birthdates spread
    over decades widen the span themselves. ponytail: misses a near miss like 2019 in a 2018 sheet - no rule knows that."""
    out = [[] for _ in range(len(df))]
    for col, t in column_types.items():
        d = df[col][~skip].dropna() if t == "date" else ()
        if len(d) < 30:
            continue
        lo, hi = d.quantile([0.01, 0.99])
        span = max(hi - lo, pd.Timedelta(days=30))
        for i in d.index[(d < lo - span) | (d > hi + span)]:
            out[i].append(f"{col} {d[i]:%Y-%m-%d} is far outside the column's dates ({lo:%Y-%m-%d} to {hi:%Y-%m-%d})")
    return out


def sums(df, column_types, skip):
    """A column that is the sum of others in >= 95% of rows (Total = Fare + Tip + Tax): the other rows don't add up.
    Least squares finds the parts; kept only when every weight is 0 or 1 (a plain sum, found once, from the total's
    side). ponytail: plain sums only - a weighted rule (tax 8.25%) or a difference written as a sum of +1s only."""
    out = [[] for _ in range(len(df))]
    cols = numbers(column_types)
    x = df[cols][~skip].dropna()
    if len(cols) < 3 or len(x) < 20 * len(cols):  # few rows: least squares "fits" anything
        return out
    a = x.to_numpy(dtype=float)
    for t, col in enumerate(cols):
        y, rest = a[:, t], np.delete(a, t, axis=1)
        w = np.linalg.lstsq(rest, y, rcond=None)[0]
        res = np.abs(y - rest @ w)
        keep = res <= np.quantile(res, 0.9)  # refit without the worst 10%: broken rows must not bend the weights
        w = np.linalg.lstsq(rest[keep], y[keep], rcond=None)[0]
        ones = np.round(w)
        if (np.abs(w - ones) > 0.02).any() or not set(ones) <= {0.0, 1.0} or ones.sum() < 2:
            continue
        got = rest @ ones
        bad = np.abs(y - got) > np.maximum(0.011, 1e-6 * np.abs(y))  # 1 cent + float slack
        if bad.mean() > 0.05:
            continue
        parts = " + ".join(c for c, o in zip(np.delete(np.array(cols, dtype=object), t), ones) if o)
        for i, v, g in zip(x.index[bad], y[bad], got[bad]):
            out[i].append(f"{col} {v:g} does not add up: {parts} = {g:.10g}")
    return out


def _decimals(x):
    """How many decimals a column is written with: the fewest that hold 95% of its values (0 = whole numbers)."""
    x = x[np.isfinite(x)]
    return next((d for d in range(7) if (np.abs(x - np.round(x, d)) < 1e-9).mean() >= 0.95), 6)


def pairs(df, column_types, skip, limits=None):
    """A column that is two others multiplied or added in >= 95% of rows (Line Total = Qty x Unit Price, Net New =
    New + Churned), or two multiplied after a 0-1 discount (Units x Unit Price x (1 - Discount)): the other rows don't
    add up. Tried pair by pair, so a x10 typo elsewhere can't bend it the way it
    bends sums' least squares, and small sheets (48 months) are checked too. To the cent, like sums; both columns must
    vary (x 1, or x a 0/1 flag, is no rule). Pairs are tried on a 64-row sample first, so a 50-column sheet stays fast.
    -> (reasons, fixes). A broken row with exactly ONE cell outside its usual range gets that cell solved from the
    other two (Units -5 with Total 170.43 = Units x 2.99 -> 57) when the answer is a usual value written like its
    column: exact, where the pane would otherwise offer the median. Two odd cells: the arithmetic can't say which."""
    out, fix = [[] for _ in range(len(df))], [{} for _ in range(len(df))]
    cols = numbers(column_types)
    a = df[cols][~skip].to_numpy(dtype=float)
    index = df.index[~skip]
    if len(cols) < 3 or len(a) < 20:
        return out, fix
    bounds = lambda j: (limits or {}).get(cols[j]) or (None, None, None, None)
    usual = lambda j, v: (bounds(j)[0] is None or v >= bounds(j)[0]) and (bounds(j)[1] is None or v <= bounds(j)[1])
    # the first 64 varying columns: pairs x fractions grows with the cube of the width (160 columns took 20 s, 2026-10-16)
    vary = [j for j in range(len(cols)) if len(np.unique(a[:, j][~np.isnan(a[:, j])])) >= 3][:64]
    near = lambda y, got: np.abs(y - got) <= np.maximum(0.011, 1e-6 * np.abs(y))  # 1 cent + float slack
    sample = a[:64]
    rules = [((p, q), f"{cols[p]} {sign} {cols[q]}", op) for (p, q), (sign, op) in
             itertools.product(itertools.combinations(vary, 2), (("×", np.multiply), ("+", np.add)))]
    # order sheets: Units x Unit Price x (1 - Discount). The fraction column is 0 to 1 in 99% of rows, so one
    # Discount typed 25 for 0.25 doesn't hide the rule it breaks
    fracs = [j for j in vary if np.nanmin(a[:, j]) >= 0 and np.nanquantile(a[:, j], 0.99) < 1]
    rules += [((p, q, f), f"{cols[p]} × {cols[q]} × (1 - {cols[f]})", lambda x, y, z: x * y * (1 - z))
              for p, q in itertools.combinations([j for j in vary if j not in fracs], 2) for f in fracs]
    for cs, said, op in rules:
        hits = near(sample, op(*(sample[:, c] for c in cs))[:, None]).mean(axis=0)
        for t in np.flatnonzero(hits >= 0.8):
            if t in cs:
                continue
            y, got = a[:, t], op(*(a[:, c] for c in cs))
            ok = ~np.isnan(y) & ~np.isnan(got)
            good = ok & near(y, got)
            # judged where the numbers aren't all zero: 0 = 0 x anything made a rule of three TV-spot columns that were 0
            # in 91% of weeks - it held in 64 of the 120 weeks with spots (real sheet, 2026-10-16)
            live = ok & ((y != 0) | (got != 0))
            if (good & (y != 0)).sum() < 20 or (good & live).sum() < 0.95 * live.sum():
                continue
            for i in np.flatnonzero(ok & ~good):
                out[index[i]].append(f"{cols[t]} {y[i]:g} does not add up: {said} = {got[i]:.10g}")
                odd = [j for j in (t, *cs) if not usual(j, a[i, j])]
                if len(odd) != 1:
                    continue
                j = odd[0]
                with np.errstate(divide="ignore", invalid="ignore"):
                    if j == t:
                        v = got[i]
                    elif op is np.add:
                        v = y[i] - a[i, cs[1] if j == cs[0] else cs[0]]
                    elif len(cs) == 3 and j == cs[2]:  # the fraction: 1 - Total / (Units x Price)
                        v = 1 - y[i] / (a[i, cs[0]] * a[i, cs[1]])
                    else:  # one factor: Total / the others
                        v = y[i] / np.prod([a[i, c] if k < 2 else 1 - a[i, c] for k, c in enumerate(cs) if c != j])
                d = _decimals(a[:, j])
                if np.isfinite(v) and abs(v - np.round(v, d)) < 0.01 * 10.0 ** -d + 1e-9 * abs(v) and usual(j, np.round(v, d)):
                    fix[index[i]][cols[j]] = float(f"{np.round(v, d):.10g}")
    return out, fix


def _one_edit(a, b):
    """a and b differ by one wrong letter, two neighbours swapped, or one letter typed twice ("NOTT DONE", "itraconazolle",
    4 of 9 blind misspellings, 2026-10-16). Any other added or dropped letter is left out on purpose: too often a different
    word (Laptop/Laptops, Sara/Sarah, Jon/John)."""
    long, short = (a, b) if len(a) > len(b) else (b, a)
    if len(long) == len(short) + 1:
        return any(long[k] == long[k - 1] and long[:k] + long[k + 1:] == short for k in range(1, len(long)))
    if a == b or len(a) != len(b):
        return False
    d = [k for k in range(len(a)) if a[k] != b[k]]
    return len(d) == 1 or (len(d) == 2 and d[1] == d[0] + 1 and a[d[0]] == b[d[1]] and a[d[1]] == b[d[0]])


def _dropped(rare, usual, vowel=False):
    """rare is usual with one letter left out inside a word ("Grmany", "parietl", "Nuclear Enrgy": 4 of 6 misspellings
    blind round 22 planted in real tables were missed, AH-23). Never a word's first or last letter (Laptop/Laptops,
    Sara/Sarah, "Phone Case"/"Phones Case": a different word or a plural) and never a space; vowel: only a, e, i, o, u.
    Measured on the 10,000 commonest English words: one inner letter dropped gives another word for 2.2% (vowel) and 5.8%
    (consonant) of 5-letter words - one wrong letter, which _one_edit allows, does for 60.8% of them."""
    if len(usual) != len(rare) + 1:
        return False
    return any(usual[:k] + usual[k + 1:] == rare and usual[k].isalpha() and usual[k - 1] != " " and usual[k + 1] != " "
               and (not vowel or usual[k] in "aeiou") for k in range(1, len(usual) - 1))


def _swapped(a, b):
    """a and b are the same letters with two neighbours swapped ("rian" for "rain")."""
    d = [k for k in range(len(a)) if len(a) == len(b) and a[k] != b[k]]
    return len(d) == 2 and d[1] == d[0] + 1 and a[d[0]] == b[d[1]] and a[d[1]] == b[d[0]]


def _misspelt(rare, usual):
    """Is rare (casefolded, 1-2 rows) a slip of usual (5+ rows, 5x as common)? 5+ letters each: one wrong letter, two
    neighbours swapped, a letter typed twice (_one_edit) or one inner letter dropped (_dropped). 4 letters: only two
    neighbours swapped (4.9% of 4-letter words have such a twin: form/from) or a vowel dropped from a 5-letter label
    ("japn" for "japan": 7.2%, plan/plain). Never one wrong letter in 4 (89%: Iran/Iraq, Mark/Mary), a consonant
    dropped (14.8%: Chad/Chard) or anything in 3 (Jon/John)."""
    word = lambda w, lo: lo <= len(w) <= 60 and w.replace(" ", "").isalpha()
    if word(rare, 5) and word(usual, 5):
        return _one_edit(rare, usual) or _dropped(rare, usual)
    if len(rare) == 4 and rare.isalpha():
        return (len(usual) == 4 and usual.isalpha() and _swapped(rare, usual)) or (
            len(usual) == 5 and usual.isalpha() and _dropped(rare, usual, vowel=True))
    return False


def _short_for(short, label):
    """Is short a short form of label (both casefolded)? See spellings()."""
    w, v = short.split(), label.split()
    if len(w) > 1:
        return len(w) == len(v) and all(b.startswith(a) for a, b in zip(w, v))
    if label.startswith(short):
        return len(short) <= 4
    # a contraction keeps the word's first and last letters (Std, Mgmt, Dept, Bldg): "Iran" is not one of "Ireland"
    rest = iter(label[1:])
    return (len(short) <= 4 and short[0] == label[0] and short[-1] == label[-1]
            and sum(ch in "aeiou" for ch in short[1:]) <= 1 and all(ch in rest for ch in short[1:]))


# a column of people's names: one-slip twins are honest there (Thomson/Thompson, Philips/Phillips, Mathew/Matthew).
# Measured on the 10,000 commonest US surnames and first names (AH-24): one inner letter dropped gives another real
# name for 21% of surnames and 37% of first names (4.8% of common words), a letter typed twice 4% and 13% (0.3%)
PERSON = {"surname", "surnames", "forename", "forenames", "firstname", "lastname", "fullname"}
# a role that is a person on its own ("Employee", "Sales Rep"): AH-24 try 1 read only "<role> name", so Employee, Patient,
# Driver, Author and Customer columns still called Thomson a misspelling of Thompson (Council A)
ROLE = {"customer", "client", "employee", "emp", "staff", "patient", "student", "pupil", "contact", "person", "member", "user",
        "owner", "manager", "author", "applicant", "candidate", "teacher", "doctor", "driver", "rep", "buyer", "player",
        "guest", "passenger", "mother", "father", "spouse", "tenant", "volunteer", "attendee", "participant", "respondent",
        "recipient", "sender", "holder",
        # AH-26 (Council A, AH-24 try 2: these still called Thomson a misspelling of Thompson)
        "physician", "nurse", "assignee", "salesperson", "athlete", "coach", "instructor", "reviewer"}
# "<this> name" is a person's; on their own these are often not ("Agent" is a browser's in a log, a "Partner" a company)
PERSON_NAME = ROLE | {"first", "last", "given", "family", "middle", "full", "maiden", "nick", "christian", "legal", "preferred",
                      "agent", "seller", "parent", "partner", "donor"}
# a customer or client that is a company: its names are checked like any label
COMPANY = {"inc", "ltd", "llc", "llp", "corp", "corporation", "co", "company", "gmbh", "plc", "group", "pty", "ag", "sa", "bv"}


# a person's age, in years: "Age", "Age (years)", "Patient age". A stock's "Age (days)" or "Stock age" is not (AH-26)
YEARS = {"age", "years", "year", "yrs", "yr", "in"}


def _person_name(col, columns, labels):
    """A column of people's names: Surname, LastName, "First name", "Customer name", "Name of patient", "Name (Last,
    First)", a role on its own ("Employee", "Sales Rep") unless its labels are companies, and a plain "Name" only beside a
    person's age, sex or birth date (Titanic): on its own it named products, cities, car models and airports (Council A:
    all 3 plain "name" columns in blind round 22's 59 real tables). "Product name", "Company name", "City" are labels."""
    w = fairness._words(col)
    if PERSON & set(w):
        return True
    named = bool(w) and w[-1] in ("name", "names") and len(w) > 1 and w[-2] in PERSON_NAME
    named |= len(w) > 1 and w[0] in ("name", "names") and (w[1] in PERSON_NAME or w[1:2] == ["of"] and w[2:3] and w[2] in PERSON_NAME)
    if named:
        return True
    if w in (["name"], ["names"]):
        def personal(c):
            cw = fairness._words(c)
            if set(cw) & {"sex", "gender", "dob", "birth", "birthday", "birthdate"}:
                return True
            return "age" in cw and (set(cw) <= YEARS or (len(cw) == 2 and cw[1] == "age" and cw[0] in ROLE))
        return any(personal(c) for c in columns if c != col)
    if w and len(w) <= 2 and (w[-1] in ROLE or w[-2:] == ["assigned", "to"]):
        companies = sum(bool(set(fairness._words(v)) & COMPANY) for v in labels)
        return companies < max(1, len(labels) / 10)
    return False


def spellings(df, column_types, skip):
    """Same category typed differently ("Sales" / "sales " / "SALES") - breaks SUMIFS and pivots silently.
    Only case/space differences, only in category-like columns (<= 50 distinct). Every spelling but the right one is
    flagged, however common ("employed" 77 times next to "Employed" 82): the right one is written like the column's other
    labels (capitalised or not), then the most common. Plus possible misspellings: a rare word (1-2 times) one slip from
    a usual one (5+ times and 5x as common): one letter wrong, two swapped, one typed twice or one dropped inside a word,
    both 5+ letters; at 4 letters only a swap or a dropped vowel (_misspelt) - no digits ("A101"/"A102" are codes), no
    short names (Mark/Mary). -> (reasons, {col: usual spelling}, misspelling reasons (worth a check, not "wrong"),
    {col: usual spelling} for misspellings - a guess, never auto-fixed, {col: usual} when 5x as common - auto-fixable)."""
    n = len(df)
    out, fix, missed = [[] for _ in range(n)], [{} for _ in range(n)], [[] for _ in range(n)]
    maybe, exact = [{} for _ in range(n)], [{} for _ in range(n)]
    for col, t in column_types.items():
        if t != "text":
            continue
        s = df[col][~skip].dropna().astype(str)
        s = s[(s.str.strip() != "") & ~s.str.lstrip().str[:1].isin(list("=+-@"))]  # formula-like text is never a "spelling"
        if s.nunique() > 50:
            continue
        keys = s.map(lambda v: " ".join(v.split()).casefold())
        capital = lambda v: v.strip()[:1].isupper()
        labels = list(s.drop_duplicates())
        caps = sum(map(capital, labels)) >= len(labels) / 2  # the column's style: most labels start with a capital
        rights, spelt = {}, {}  # label -> its right spelling; label -> {raw spelling: rows}
        for raw, c in s.value_counts().items():  # one count per column, not per label: 400 columns took 20 s (2026-10-16)
            spelt.setdefault(" ".join(raw.split()).casefold(), {})[raw] = c
        for key, counts in spelt.items():
            right = rights[key] = max(counts, key=lambda v: (capital(v) == caps and v == " ".join(v.split()), counts[v]))
            for raw, c in counts.items():
                if raw == right:
                    continue
                for i in s.index[s == raw]:
                    out[i].append(f'{col} "{_short(raw)}" looks like "{_short(right)}" (same word, different capitals/spaces)')
                    fix[i][col] = right
                    if counts[right] >= 5 * c:  # auto-fix only when the right spelling is plainly the usual one
                        exact[i][col] = right
        cnt = keys.value_counts()
        if _person_name(col, column_types, labels):  # capitals/spaces of the very same name above, never a guess at another name (AH-24)
            continue
        # over 60 characters is a note, not a label: crafted 32,000-character labels took 58 s here (council, 2026-10-16)
        for rare, c in cnt[cnt <= 2].items():
            usual = next((u for u, m in cnt.items() if m >= max(5, 5 * c) and len(u) <= 60 and len(rare) <= 60
                          and _misspelt(rare, u)), None)
            if usual is None:
                continue
            word = s[keys == usual].value_counts().index[0]  # how the usual one is usually written
            for i in keys.index[keys == rare]:
                missed[i].append(f'{col} "{_short(s[i])}" looks like a misspelling of "{_short(word)}"')
                maybe[i][col] = word
        # a short form of exactly one other label (5+ rows, 2+ letters longer): its start ("EMP" for "Employed"), each
        # word's start ("In Prog" for "In Progress"), or a contraction ("Std" for "Standard": same first letter, the rest
        # in order, at most one vowel - "Fee" is not short for "Free")
        # A whole word of another label is a label of its own: Periode "II" next to "II-III?" (blind real sheet, 123
        # correct cells offered "II-III?", 2026-10-16), "Pen" next to "Pen Set"
        tokens = collections.Counter(w for u in cnt.index for w in set(re.split(r"[\s/-]+", u)))
        whole = lambda short: tokens[short] > 1  # a word of some other label too, not only of itself
        for short in cnt.index:
            # a short form is the rarer spelling - the full label at least twice as common: "CAF" (51 rows) is not short
            # for "CONCACAF" (30), nor "VI" for "VIII" - 71 cards would have overwritten correct labels (real sheets, 2026-10-16)
            longer = [u for u, m in cnt.items() if m >= max(5, 2 * cnt[short]) and len(u) >= len(short) + 2 and _short_for(short, u)]
            if 2 <= len(short.replace(" ", "")) <= 6 and short.replace(" ", "").isalpha() and len(longer) == 1 and not whole(short):
                for i in keys.index[keys == short]:
                    missed[i].append(f'{col} "{_short(s[i])}" looks like a short form of "{_short(rights[longer[0]])}"')
                    maybe[i][col] = rights[longer[0]]
        # a label written in lowercase where the column's 3+ other labels all start with a capital ("retired" next to
        # "Employed", "Unemployed"): sorts and reads as a different label in a pivot
        if len(cnt) >= 4:
            for key, right in rights.items():
                if right.islower() and right.replace(" ", "").replace("-", "").isalpha() and all(
                        capital(r) for k, r in rights.items() if k != key):
                    for i in keys.index[keys == key]:
                        missed[i].append(f'{col} "{_short(s[i])}" is lowercase where the column\'s other labels are capitalised')
                        maybe[i][col] = right[:1].upper() + right[1:]
    return out, fix, missed, maybe, exact


def fractions(df, column_types, skip):
    """A ratio above 100% (Credit_Utilization 1.026) in a column of fractions: 98%+ of its values between 0 and 1, most
    of them not whole numbers (a 0/1 flag or a count is no fraction). Worth a check, not wrong: an over-limit card exists,
    a slip is likelier. Below 0 is the limits check's (a column that never goes negative)."""
    out = [[] for _ in range(len(df))]
    for col in numbers(column_types):
        x = df[col][~skip].dropna().astype(float)
        inside = x.between(0, 1)
        if len(x) < 20 or inside.all() or inside.mean() < 0.98 or (x[inside] == x[inside].round()).mean() > 0.5:
            continue
        for i in x.index[x > 1]:
            out[i].append(f"{col} {x[i]:g} is above 100% - the rest of the column stays between 0 and 1")
    return out


def codes(df, column_types, skip):
    """A column's top value is all 9s (999, 9999, 99999) and over twice the next one: a code for "missing" or "too big to
    record" (census capital gains stop at 41,310, then 244 people have 99999), not an amount - it wrecks every average.
    Repeats don't hide it: the code is typed the same way each time."""
    out = [[] for _ in range(len(df))]
    for col in numbers(column_types):
        x = df[col][~skip].dropna().astype(float)
        top = np.sort(x.unique())[-2:]
        if len(x) < 20 or len(top) < 2 or not top[1].is_integer() or top[1] < 999 or set(str(int(top[1]))) != {"9"} \
                or top[1] < 2 * top[0]:
            continue
        for i in x.index[x == top[1]]:
            out[i].append(f"{col} {top[1]:g} looks like a code, not a real value (all 9s, over twice the next "
                          f"highest, {top[0]:g})")
    return out


def shifted(df, column_types, skip):
    """A text value typed into the wrong column ("East" in Item): once in its own column, 3+ times in another one, and
    the two columns otherwise share under 20% of their values (Origin/Destination, Home/Away share most: left alone).
    Category-like columns only (<= 50 distinct). Placeholders (N/A, ?) are the placeholder check's. -> reasons per row
    (worth a check, never auto-fixed). Values that need MEANING to judge ("London" among products) are the AI text check's."""
    out = [[] for _ in range(len(df))]
    keys = {}
    for col, t in column_types.items():
        if t == "text":
            s = df[col][~skip].map(lambda v: " ".join(str(v).split()).casefold())
            s = s[(s != "") & ~s.str[:1].isin(list("=+-@")) & ~s.str.fullmatch(PLACEHOLDER)]
            if s.nunique() <= 50 and len(keys) < 100:  # every pair of columns: 400 crafted ones took 44 s (2026-10-16)
                keys[col] = s
    counts = {c: s.value_counts() for c, s in keys.items()}
    usual = {c: set(n.index[n >= 2]) for c, n in counts.items()}  # shared vocabulary: one-offs are suspects, not evidence
    for a, sa in keys.items():
        for v in counts[a].index[counts[a] == 1]:
            for b in keys:
                if b != a and counts[b].get(v, 0) >= 3 and len(usual[a] & usual[b]) < 0.2 * len(usual[a] | usual[b]):
                    i = sa.index[sa == v][0]
                    out[i].append(f'{a} "{_short(df[a][i])}" looks like {"an" if b[:1].lower() in "aeiou" else "a"} {b} value')
                    break
    return out


def knobs(strength=5):
    """How hard to look, 0-10 -> (level, k). k = how many robust spreads out a value must be to count as weird.
    5 = the tuned default (k 6, bench 51/51). Each step up lowers the bar ~10% and may add a check, so a row flagged
    at s stays flagged at s+1. 0: hygiene + obvious typos; 1+: values past their column's range; 3+: breaks in a
    series; 5+: odd mixes across columns; 7+: a value past its usual limit that few others pass is worth a check (Low;
    "few" = detectors.FEW, and the sentence says how many). The floor (k 3.5 at 10) stays above the baseline band of 3.
    k alone made 5 and 10 flag the same sure mistakes on every sheet John would scan (AH-14)."""
    s = min(10, max(0, int(strength)))
    return s, 6 * 0.9 ** (s - 5)


ALONE = 7  # from this level, a value past its usual limit that few others pass is listed (Low), not only noted


def score(df, column_types, errors_log, limits, order_by, strength=5, saved=()):
    """-> (rows, status). Severity = votes: 1 Low, 2 Medium, 3+ High. Weird limit or hygiene hit = at least Medium.
    Totals/summary rows are left out of every check (their numbers would distort the rest) and say so."""
    n, skip = len(df), summary_rows(df)
    empty = df[[c for c in df.columns if c != "source_file"]].apply(_blank).all(axis=1).to_numpy()  # before totals are blanked
    df = df.copy()
    if nums := [c for c, t in column_types.items() if t in ("number", "id")]:  # (pandas 3 fails on an empty column list)
        df.loc[skip, nums] = np.nan
    errors_log = [e for e in errors_log if not skip[e[0]]]
    s, k = knobs(strength)
    # saved: the columns whose limits the user set - their limits win, so nothing is listed past the data's own band
    lim = limits_detector(df, column_types, limits, typos_only=s < 1, listing=s >= ALONE,
                          quiet=set(fairness.protected(column_types)) | set(saved))
    # protected columns (Age, Gender, Location...) are checked for slips like any column (limits, blanks, spellings), but
    # never used to judge whether a person is unusual: a 74-year-old is not an anomaly for being 74 (fairness blueprint)
    judged = {c: t for c, t in column_types.items() if c not in fairness.protected(column_types)}
    dets = {"limits": lim,
            "sequence": sequence_detector(df, judged, order_by, k) if s >= 3 else _result(n, "strength below 3"),
            "isolation": isolation_detector(df, judged, k) if s >= 5 else _result(n, "strength below 5")}
    # DBSCAN cut 2026-10-07: 90s/100k rows, 81% false alarms, bench same without it
    ran = [d for d in dets.values() if d["ran"]]
    dup, typ, (blank, spread) = duplicates(df, errors_log), type_errors(n, errors_log, column_types), blanks(df, column_types, skip, errors_log)
    hole, far = placeholders(df, column_types, skip), far_dates(df, column_types, skip)
    paired, solved = pairs(df, column_types, skip, limits)
    add = [list(dict.fromkeys(s + m)) for s, m in zip(sums(df, column_types, skip), paired, strict=True)]
    code = codes(df, column_types, skip)
    spell, spell_fix, missed, spell_maybe, spell_exact = spellings(df, column_types, skip)
    missed = [m + s + f + w + b + g for m, s, f, w, b, g in zip(missed, shifted(df, column_types, skip), fractions(df, column_types, skip),
                                                                 whole_numbers(df, column_types, skip), named_bounds(df, column_types, skip),
                                                                 spread, strict=True)]  # all "worth a check" (Low)
    missed = [m + t for m, t in zip(missed, lim["top_reasons"], strict=True)]  # a lone top value (AH-29)
    if s >= ALONE:
        missed = [m + a for m, a in zip(missed, lim["alone_reasons"], strict=True)]
    rows = []
    for i in range(n):
        if skip[i]:
            rows.append({"severity": None, "bucket": None, "reason": "" if empty[i] else "Totals/summary row - not checked",
                         "magnitude": 0.0})
            continue
        voted = [d for d in ran if d["votes"][i]]
        hygiene = dup[i] + typ[i] + blank[i] + hole[i] + code[i] + far[i] + add[i] + spell[i]
        if not voted and not hygiene and not missed[i]:
            noted = lim["noted_reasons"][i]
            rows.append({"severity": "Noted" if noted else None, "bucket": None,
                         "reason": "; ".join(noted), "magnitude": 0.0})
            continue
        v, weird = len(voted), bool(lim["votes"][i])
        rows.append({  # a possible misspelling alone is "worth a check" (Low): it may be a real name
            "severity": "High" if v >= 3 else "Medium" if v == 2 or weird or hygiene else "Low",
            "bucket": "Duplicates" if dup[i] else "Irregularities" if weird or typ[i] or blank[i] or hole[i] or code[i] or far[i] or add[i] or spell[i] or missed[i] else "Behavioral",
            "reason": (f"Flagged by {v} of {len(ran)}: " if v else "") + "; ".join(dict.fromkeys(hygiene + missed[i] + [r for d in voted for r in d["reasons"][i]])),  # dedupe, keep order
            "magnitude": float(max((d["magnitude"][i] for d in voted), default=0.0)),
            "likely": {**lim["likely"][i], **solved[i], **spell_fix[i]},  # the row's own arithmetic beats a typo pattern
            "maybe": {**lim["maybe"][i], **spell_maybe[i]},  # misspelling, or a typo the numbers cannot prove: a guess the user confirms
            "exact": spell_exact[i],  # capitals/spaces where the usual spelling is 5x as common: safe to auto-fix
        })
    status = {k: "ran" if d["ran"] else f"sat out: {d['sit_out_reason']}" for k, d in dets.items()}
    return rows, status
