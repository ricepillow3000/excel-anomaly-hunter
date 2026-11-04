"""AH-88 (John, 2026-11-02: "Make sure that the sales scanning clean sheet and findings are all accurate, no hallucinated
data... the sample sheet is perfectly accurate"). The website's sample sheet (site/index.html, figure#preview) claims to
be the engine's own result. It was typed by hand, and drifted: rows 11 and 22 left UnitCost uncoloured though the pane
colours it, row 22's quote dropped a part of the engine's reason, row 31 counted 19 "East" rows of 20, the rows worth a
check showed a card text the pane never says, and the "Clean sheet" tab said "No problems found in 60 rows." of a sheet
on which the engine still lists 4 rows worth a check. This test rebuilds the sheet, scans it the way the pane does
(POST /scan, strength 5, dates as yyyy-mm-dd) and reads the page back cell by cell, word by word."""
import datetime
import json
import math
import re
import shutil
import subprocess
from html.parser import HTMLParser
from pathlib import Path

from anomaly_hunter.engine.detectors import CYCLES
from anomaly_hunter.server import create_app

ROOT = Path(__file__).resolve().parents[2]
PAGE = ROOT / "site" / "index.html"
APP = create_app().test_client()
COLUMNS = ["OrderDate", "Region", "Units", "UnitCost", "Total"]
LETTERS = "ABCDE"


def sample(planted=True):
    """THIS GENERATOR IS THE SAMPLE. The page shows 13 of its 60 rows (sheet rows 2-61, the header in row 1); every
    number on it must come from here and from the engine's scan of it. The same generator as the practice workbook
    (anomaly_hunter/practice.py) and the e2e sheet (e2e/run.mjs), one day per row. Planted: row 11 Units -5 (a minus
    sign), row 22 Units 7777 (far too big), row 31 Region "east " (typed differently)."""
    rows = []
    for k in range(60):  # k = sheet row - 2
        units, cost = 40 + (k * 7) % 23, 1.99 + k % 4
        rows.append([(datetime.date(2026, 1, 6) + datetime.timedelta(days=k)).isoformat(), ["East", "West", "Central"][k % 3],
                     units, cost, round(units * cost, 2)])
    if planted:
        rows[11 - 2][2], rows[22 - 2][2], rows[31 - 2][1] = -5, 7777, "east "
    return rows


def scan(rows):
    """Exactly what the pane sends (frontend/features/scan.js runScan): order_by null, the slider's default 5."""
    r = APP.post("/scan", json={"columns": COLUMNS, "rows": rows, "limits": None, "order_by": None, "strength": 5})
    assert r.status_code == 200, r.get_json()
    return r.get_json()


# ---- the page, read as a tree (stdlib only) ----
VOID = {"meta", "link", "br", "img", "input", "hr", "source", "area", "base", "col", "embed", "param", "track", "wbr"}


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.kids, self.parent = tag, dict(attrs), [], parent

    def text(self):
        return "".join(k if isinstance(k, str) else k.text() for k in self.kids).replace("\xa0", " ")

    def classes(self):
        return set((self.attrs.get("class") or "").split())

    def all(self, tag=None, cls=None, **attrs):
        out = []
        for k in self.kids:
            if isinstance(k, Node):
                if (tag is None or k.tag == tag) and (cls is None or cls in k.classes()) and all(k.attrs.get(a.replace("_", "-")) == v for a, v in attrs.items()):
                    out.append(k)
                out += k.all(tag, cls, **attrs)
        return out

    def one(self, tag=None, cls=None, **attrs):
        found = self.all(tag, cls, **attrs)
        assert len(found) == 1, f"{len(found)} <{tag} class={cls} {attrs}> on the page"
        return found[0]


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.cur = Node("#root", {}, None)

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.kids.append(n)
        if tag not in VOID:
            self.cur = n

    def handle_startendtag(self, tag, attrs):
        self.cur.kids.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.kids.append(data)


def page():
    t = Tree()
    t.feed(PAGE.read_text(encoding="utf-8"))
    return t.root.one("figure", id="preview"), t.root


def quoted(s):
    """The words inside the outer quotes: 'In the pane: "Region "east " looks like..."' -> 'Region "east " looks like...'"""
    return s[s.index('"') + 1:s.rindex('"')]


# ---- the pane's own words, ported from frontend/ (and checked against the real files below when node is here) ----
def js(v):
    """A number as JavaScript's String() writes it (57.0 -> "57")."""
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)


def plain_reason(reason):  # frontend/features/scan.js plainReason
    s = re.sub(r"^Flagged by \d+ of \d+: ", "", reason or "")
    s = re.sub(r"(\S[^;]*?) weird limit is ([^;\s]+); this is ([^;\s]+)",
               lambda m: f"{m[1]} is {m[3]}, {'below' if float(m[3]) < float(m[2]) else 'above'} its usual limit of {m[2]}", s)
    s = re.sub(r"Unusual combination of values, mainly (.+?)(?=;|$)", r"Unusual mix of values, mostly in \1", s)
    return s.replace(" is unusual relative to its local trend near", " breaks its usual pattern near").replace(" 00:00:00", "").replace("; ", " · ")


def add_ups(reason):  # frontend/features/fix.js addUps
    out = []
    for part in re.sub(r"^Flagged by \d+ of \d+: ", "", reason).split("; "):
        if m := re.fullmatch(r"(.+) (\S+) does not add up: ((.+?) [×+] (.+)) = \S+", part):
            out.append({"text": m[0], "total": f"{m[1]} {m[2]}", "rule": m[3], "cols": [m[1], m[4], m[5]]})
    return out


KNOWN = (r" does not add up: ", r" weird limit is ", r" is unusual relative to its local trend near ", r" jumped sharply near ", r" looks like ")


def recommend_fix(row, sheet_row, r):
    """frontend/features/fix.js recommendFix for the parts these reasons have (a sum the row's own numbers solve, the usual
    spelling, or nothing to write). Any other part means the port no longer covers the row: it fails, never guesses."""
    reason, likely = r["reason"], r.get("likely") or {}
    parts = re.sub(r"^Flagged by \d+ of \d+: ", "", reason).replace("; this is ", " this is ").split("; ")
    assert all(any(k in p for k in KNOWN) for p in parts) and not r.get("maybe"), f"the port does not cover: {reason}"
    sums, changes, typos, solved = add_ups(reason), [], [], set()
    for j, c in enumerate(COLUMNS):
        v, cell = row[j], f"{LETTERS[j]}{sheet_row}"
        if isinstance(likely.get(c), str) and isinstance(v, str):
            changes.append((cell, likely[c]))
            typos.append(f'{c} says "{v}" where the rest of the column says "{likely[c]}": same word, different capitals/spaces')
        elif isinstance(v, (int, float)) and likely.get(c) not in (None, -v) and (s := next((s for s in sums if c in s["cols"]), None)):
            changes.append((cell, js(likely[c])))
            solved.add(c)
            typos.append(f"{c} is {js(v)}, but the row's own numbers say {js(likely[c])} ({s['total']} = {s['rule']})")
    notes = [f"{'; '.join(typos)}. Check it against the source before applying."] if typos else []
    notes += [f"{s['text']}, so one of these numbers is wrong. Check them against the source." for s in sums if not set(s["cols"]) & solved]
    notes = notes or ["Nothing here is clearly broken, but the values are unusual together. Check them against the source; if they're right, leave them."]
    return {"explanation": " ".join(notes), "changes": changes, "label": "Suggested fix" if changes else "What to check"}


def summary_of(rows):  # frontend/features/scan.js summaryOf
    sure = sum(r["severity"] in ("High", "Medium") for r in rows)
    maybe = sum(r["severity"] == "Low" for r in rows)
    more = f" {maybe}{' more' if sure else ''} {'is' if maybe == 1 else 'are'} worth a quick check." if maybe else ""
    if not sure and not maybe:
        return f"No problems found in {len(rows)} rows."
    return (f"{sure} of {len(rows)} rows look wrong." if sure else f"Nothing clearly wrong in {len(rows)} rows.") + more


def kinds(reason):
    """The page's four filters, read off the engine's reason."""
    return {k for k, rx in (("recon", " does not add up: "), ("keying", " weird limit is "), ("label", " looks like "),
                            ("time", r" jumped sharply near | is unusual relative to its local trend near ")) if re.search(rx, reason)}


def fixed_sheet():
    """The sheet after the pane's three suggested fixes are accepted (the "After fixes" tab)."""
    rows = sample()
    planted = scan(rows)["rows"]
    for i, r in enumerate(planted):
        for cell, new in recommend_fix(rows[i], i + 2, r)["changes"] if r["severity"] in ("High", "Medium") else []:
            j = LETTERS.index(cell[0])
            rows[i][j] = float(new) if isinstance(rows[i][j], (int, float)) else new
    return rows


def test_the_sample_sheet_on_the_website_is_the_engines_real_result_cell_by_cell():
    ws, _ = page()
    rows, body = sample(), scan(sample())
    out = body["rows"]
    flagged = {i + 2: r for i, r in enumerate(out) if r["severity"]}
    table = ws.one("div", id="p-found").one("table", cls="grid")
    head = [th.text() for th in table.one("thead").all("th")]
    assert head == ["Row", *COLUMNS, "Finding"]
    shown = {}
    for tr in table.one("tbody").all("tr"):
        if "skip" in tr.classes():
            continue
        n = int(tr.one("th").text())
        tds = tr.all("td")
        shown[n] = tr
        want = rows[n - 2]
        got = [td.text() for td in tds[:5]]
        assert got[:2] == want[:2], f"row {n}: {got} vs {want}"
        assert [float(x) for x in got[2:]] == want[2:], f"row {n}: {got} vs {want}"
        # the colours: Medium (or High) fills the cells the reasons name, Low outlines them; nothing else is coloured
        r = flagged.get(n)
        fill = {head[k + 1] for k, td in enumerate(tds[:5]) if "flag" in td.classes()}
        ring = {head[k + 1] for k, td in enumerate(tds[:5]) if "q" in td.classes()}
        sev = r["severity"] if r else None
        assert fill == (set(r["cells"]) if sev in ("High", "Medium") else set()), f"row {n}: filled {fill}, the pane colours {r and r['cells']}"
        assert ring == (set(r["cells"]) if sev == "Low" else set()), f"row {n}: outlined {ring}, the pane colours {r and r['cells']}"
        assert set((tr.attrs.get("data-kind") or "").split()) == (kinds(r["reason"]) if r else set()), f"row {n}: data-kind"
    assert len(shown) == 13 and set(flagged) <= set(shown), f"the page shows rows {sorted(shown)}; the engine flags {sorted(flagged)}"
    assert {n for n, tr in shown.items() if tr.attrs.get("data-kind")} == set(flagged)
    # the counts: the filters and the key
    for b in ws.one("nav", cls="typology").all("button"):
        k, n = b.attrs["data-kind"], int(b.one("span", cls="n").attrs["data-n"])
        assert n == sum(k == "all" or k in kinds(r["reason"]) for r in flagged.values()), f"the {k} count"
        assert b.one("span", cls="n").text() == str(n)
    key = [s.text() for s in ws.one("p", cls="key").all("span")]
    assert key == [f"Probably wrong: {sum(r['severity'] in ('High', 'Medium') for r in flagged.values())}",
                   f"Worth a check: {sum(r['severity'] == 'Low' for r in flagged.values())}"]
    assert table.attrs["aria-label"] == f"Sample sales sheet with {['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][len(flagged)]} flagged rows"
    top = ws.one("div", cls="ws-top").one("span").text()
    assert top == f"{len(rows)} rows · {len(COLUMNS)} columns"


def pane_steps():
    """The pane's progress line (frontend/features/scan.js scan()), read from the file: step 1 as it starts, step 1 with
    its percent (a template), step 2 for a sheet of N rows (a template) and auto-fix's step."""
    src = (ROOT / "frontend/features/scan.js").read_text(encoding="utf-8")
    first = re.search(r'busy\("(Step 1 of 3: [^"]+)", 0\)', src)[1]
    pct = re.search(r"busy\(`(Step 1 of 3: [^`]+?) \$\{Math\.round\(p \* 100\)\}%`, p\)", src)[1]
    second = re.search(r"busy\(`(Step 2 of 3: [^`]*?)\$\{n\(s\.rows\.length\)\}([^`]*)`\)", src)
    auto = re.search(r'busy\("(Fixing [^"]+)"\)', src)[1]
    return first, pct, lambda rows: f"{second[1]}{rows}{second[2]}", auto


def test_the_scanning_tab_shows_the_panes_own_progress_words_for_this_sheet():
    """It showed stage names the pane never says ("Scanning: reading sheet data", "Testing each column's limits")."""
    ws, _ = page()
    first, pct, second, auto = pane_steps()
    n = len(sample())
    panel = ws.one("div", id="p-busy")
    steps = [li for li in panel.one("ol", cls="stages").all("li")]
    assert [li.text() for li in steps[:2]] == [first, second(n)]
    assert steps[2].text() == f"{auto} only with Auto-fix on" and steps[2].one("span", cls="small").text() == "only with Auto-fix on"
    assert ">Auto-fix (optional)</summary>" in (ROOT / "frontend/taskpane.html").read_text(encoding="utf-8")
    # the ticker's words (site/home.js STAGES): what the pane shows for this sheet, in its order. Step 1 as it starts, then
    # step 1 once after each slice it reads (frontend/services/excel.js readSheet: READ_CELLS cells a slice, the header
    # row read too), then step 2. It showed 0% and 40%: a sheet of 305 cells is read in one slice, so the pane says 100%
    home = (ROOT / "site/home.js").read_text(encoding="utf-8")
    stages = json.loads(re.search(r"const STAGES = (\[[^\]]*\]);", home)[1])
    cells = int(re.search(r"export const READ_CELLS = (\d+);", (ROOT / "frontend/constants/index.js").read_text(encoding="utf-8"))[1])
    total, step = n + 1, max(1, cells // len(COLUMNS))
    slices = [f"{pct} {math.floor(100 * min(k + step, total) / total + 0.5)}%" for k in range(0, total, step)]
    assert stages == [first, *slices, second(n)]
    assert panel.one("p", cls="ticker").text() == stages[0]


def test_every_finding_on_the_website_says_what_the_pane_says_and_offers_its_fix():
    ws, _ = page()
    rows, body = sample(), scan(sample())
    limits = body["limits"]
    flagged = {i + 2: r for i, r in enumerate(body["rows"]) if r["severity"]}
    for n, r in flagged.items():
        row, said, rec = rows[n - 2], plain_reason(r["reason"]), recommend_fix(rows[n - 2], n, r)
        tr = next(tr for tr in ws.one("div", id="p-found").one("table", cls="grid").one("tbody").all("tr") if tr.all("button", cls="rowbtn") and tr.one("th").text() == str(n))
        why = tr.one("td", cls="why")
        fix = why.all("b")
        short = why.text().split(" · Fix:")[0]
        # the short summary in the Finding column is literally true: the pane's own words, or the rule it breaks
        if short == "Total ≠ Units × UnitCost":
            assert round(row[2] * row[3], 2) != row[4] and f"Total {js(row[4])} does not add up: Units × UnitCost = " in r["reason"]
        else:
            assert short in said, f"row {n}: '{short}' is not what the pane says: '{said}'"
        # the fix: exactly the change the pane's card offers, or none
        assert [b.text() for b in fix] == [f"Fix: {new}" if COLUMNS[LETTERS.index(c[0])] == "Region" else f"Fix: {COLUMNS[LETTERS.index(c[0])]} {new}" for c, new in rec["changes"]], f"row {n}"
        box = ws.one("div", cls="matrix", id=f"m{n}")
        severity = {"High": "Very likely wrong", "Medium": "Probably wrong", "Low": "Worth a check"}[r["severity"]]
        assert box.one("div", cls="m-head").one("b").text() == f"Row {n} · {severity}"
        dl = dict(zip([dt.text() for dt in box.all("dt")], [dd.text() for dd in box.all("dd")]))
        assert quoted(box.one("p", cls="m-said").text()) == said, f"row {n}: the quote is not the pane's words"
        if rec["changes"]:
            (cell, new), = rec["changes"]
            col = COLUMNS[LETTERS.index(cell[0])]
            assert dl["Proposed fix"].split(",")[0] == (new if col == "Region" else f"{col} {new}")
        if (m := re.fullmatch(r"(\S+) × (\S+) = (\S+), but Total is (\S+)", dl.get("Found", ""))):
            a, b, c, t = map(float, m.groups())
            assert (a, b, t) == (row[2], row[3], row[4]) and round(a * b, 2) == c and f"Units × UnitCost = {m[3]}" in r["reason"]
            # the fix is the row's own arithmetic: Total ÷ UnitCost
            total, cost = map(float, re.fullmatch(r"Units \S+, from the row's own numbers: (\S+) ÷ (\S+)", dl["Proposed fix"]).groups())
            assert (total, cost) == (row[4], row[3]) and js(round(total / cost, 9)) == rec["changes"][0][1]
            lim = re.fullmatch(r"Units (\S+) or (more|less)", dl["Usual limit"])
            assert float(lim[1]) == limits["Units"][2 if lim[2] == "more" else 3] and f"Units weird limit is {lim[1]}" in r["reason"]
        if "Usual spelling" in dl:
            m = re.fullmatch(r'"(\w+)", in (\d+) other rows', dl["Usual spelling"])
            assert m[1] == r["likely"]["Region"] and int(m[2]) == sum(x[1] == m[1] for k, x in enumerate(rows) if k != n - 2)
            assert dl["Found"].startswith(f'Region "{row[1]}"')
        if r["severity"] == "Low":
            # nothing to write: the card says what to check, in the pane's words
            assert not rec["changes"] and dl["What to check"] == rec["explanation"], f"row {n}: {dl}"
            m = re.fullmatch(r"Total (\S+) on (\S+), a sharp jump from the dates around it", dl["Found"])
            assert float(m[1]) == row[4] and m[2] == row[0] and f"Total jumped sharply near {row[0]}" in said
            # ...and what is behind it: these four are honest rows, the peaks of the sample's own price cycle (a flat
            # UnitCost gives no flag at all), which the series check does not take out (it knows 7, 12, 24, 52, 168)
            m = re.fullmatch(r"UnitCost (\S+): the price peaks every (\d+) days, and Total jumps with it", dl["Behind it"])
            costs = [x[3] for x in rows]
            at = [k for k, c in enumerate(costs) if c == float(m[1])]
            assert float(m[1]) == row[3] == max(costs) and {b - a for a, b in zip(at, at[1:])} == {int(m[2])}, dl["Behind it"]
            assert int(m[2]) not in CYCLES
    # every detail box belongs to a flagged row, and every flagged row has one
    assert {int(m.attrs["id"][1:]) for m in ws.all("div", cls="matrix")} == set(flagged)


def test_the_after_fixes_tab_says_what_the_pane_says_once_the_three_fixes_are_in():
    """It said "No problems found in 60 rows." and "0 ANOMALIES": with the three fixes accepted the engine still lists
    rows 5, 21, 41 and 57 as worth a check (the dearest orders, sharp jumps in the dated series)."""
    ws, _ = page()
    after = scan(fixed_sheet())["rows"]
    flagged = {i + 2: r for i, r in enumerate(after) if r["severity"]}
    panel = ws.one("div", id="p-clean")
    words = panel.text()
    assert f'"{summary_of(after)}"' in words, words
    assert "No problems found" not in words or not flagged
    for b in ws.one("nav", cls="typology").all("button"):
        k = b.attrs["data-kind"]
        assert int(b.one("span", cls="n").attrs["data-after"]) == sum(k == "all" or k in kinds(r["reason"]) for r in flagged.values()), f"the {k} count after the fixes"
    named = sorted(flagged)
    assert f"rows {', '.join(map(str, named[:-1]))} and {named[-1]}" in words, words
    sure = sum(r["severity"] in ("High", "Medium") for r in flagged.values())
    assert panel.one("p", cls="verdict").text() == (f"Scan complete: {sure} probably wrong, {len(flagged) - sure} worth a check")
    # the corrected sheet itself: the same 13 rows as the findings, each cell the fixed sheet's, the cells the fixes
    # changed marked (and only those), the rows the engine still lists outlined on the cells it names, in its words
    rows, before = fixed_sheet(), sample()
    table = panel.one("table", cls="grid")
    head = [th.text() for th in table.one("thead").all("th")]
    assert head == ["Row", *COLUMNS, "Finding"]
    found = [tr.one("th").text() for tr in ws.one("div", id="p-found").one("tbody").all("tr") if "skip" not in tr.classes()]
    shown = [tr for tr in table.one("tbody").all("tr") if "skip" not in tr.classes()]
    assert [tr.one("th").text() for tr in shown] == found
    for tr in shown:
        n = int(tr.one("th").text())
        tds, want, was = tr.all("td"), rows[n - 2], before[n - 2]
        got = [td.text() for td in tds[:5]]
        assert got[:2] == want[:2] and [float(x) for x in got[2:]] == want[2:], f"after, row {n}: {got} vs {want}"
        mended = {head[k + 1] for k, td in enumerate(tds[:5]) if "mended" in td.classes()}
        changed = {COLUMNS[j] for j in range(5) if want[j] != was[j]}
        assert mended == changed, f"after, row {n}: marked {mended}, the fixes changed {changed}"
        r = flagged.get(n)
        ring = {head[k + 1] for k, td in enumerate(tds[:5]) if "q" in td.classes() or "flag" in td.classes()}
        assert ring == (set(r["cells"]) if r else set()), f"after, row {n}: outlined {ring}, the pane colours {r and r['cells']}"
        assert not r or r["severity"] == "Low" and all("q" in td.classes() for td in tds[:5] if head[tds.index(td) + 1] in r["cells"])
        # the filters filter these rows too, by the after-fixes counts (a filter here jumped back to the findings, AH-129)
        assert set((tr.attrs.get("data-kind") or "").split()) == (kinds(r["reason"]) if r else set()), f"after, row {n}: data-kind"
        why = tds[5].text()
        if r:
            assert why and why in plain_reason(r["reason"]), f"after, row {n}: '{why}'"
        elif changed:
            (col,) = changed
            new, old = want[COLUMNS.index(col)], was[COLUMNS.index(col)]
            assert why == f"Fixed: {col} {js(new)}, was " + (f'"{old}"' if isinstance(old, str) else js(old)), f"after, row {n}: '{why}'"
        else:
            assert why == "", f"after, row {n}: '{why}'"
    # the key under the filters follows the state: its after-fixes counts are the engine's on the fixed sheet
    key = ws.one("p", cls="key").all("b", cls="kcount")
    assert [int(b.attrs["data-after"]) for b in key] == [sure, len(flagged) - sure]
    assert [int(b.attrs["data-n"]) for b in key] == [int(b.text()) for b in key]


def test_the_checks_table_says_what_the_sample_shows_or_that_it_has_none():
    """The checks were 8 numbered cards with examples; they are a table (AH-98) whose third column, "In the sample above",
    names the sample's own row where it has an instance and says plainly where it has none. Every row link lands on a
    row the engine flags for that check, every number beside it is that row's, and the fact over the table counts both."""
    _, root = page()
    rows, body = sample(), scan(sample())
    flagged = {i + 2: r for i, r in enumerate(body["rows"]) if r["severity"]}
    table = root.one("table", cls="checks-table")
    assert [th.text() for th in table.one("thead").all("th")] == ["Check", "What it catches", "In the sample above"]
    checks = {tr.one("th").text(): tr.one("td", cls="in-sample") for tr in table.one("tbody").all("tr")}
    what = {tr.one("th").text(): tr.all("td")[0].text() for tr in table.one("tbody").all("tr")}
    # the cycles the series check leaves alone, named as it holds them (detectors.CYCLES) and no other: the row said
    # "Repeating cycles are left alone" over a sample whose four Temporal flags are a 4-day price cycle's peaks
    m = re.search(r"a cycle of ([\d, ]+ or \d+) rows", what["Temporal"])
    assert m and [int(x) for x in re.findall(r"\d+", m[1])] == list(CYCLES), what["Temporal"]
    assert "Repeating cycles" not in what["Temporal"]
    assert list(checks) == ["Reconciliation", "Keying errors", "Consistency", "Temporal", "Completeness", "Plausibility", "Fairness", "Ask AI (optional)"]
    assert root.one("p", cls="fact").text() == f"{len(checks)} checks · {len(flagged)} rows flagged in the sample above"
    kind = {"Reconciliation": "recon", "Keying errors": "keying", "Consistency": "label", "Temporal": "time"}
    for name, cell in checks.items():
        links = cell.all("a", cls="to-row")
        if name not in kind:  # none in this sample, said in so many words
            assert not links and cell.one("span", cls="nil").text().startswith(("None in this sample", "Not run on this sample")), name
            continue
        (a,) = links
        n = int(a.attrs["href"].removeprefix("#r"))
        assert a.text() == f"Row {n}" and n in flagged and kind[name] in kinds(flagged[n]["reason"]), f"{name}: row {n}"
        assert root.one("tr", id=f"r{n}").one("th").text() == str(n)
        checks[name] = (n, rows[n - 2], flagged[n], cell.text().removeprefix(a.text()))
    n, row, r, eg = checks["Reconciliation"]
    assert eg == f"{js(row[4])} ÷ {js(row[3])} = {js(r['likely']['Units'])}" and js(round(row[4] / row[3], 9)) == js(r["likely"]["Units"])
    n, row, r, eg = checks["Keying errors"]
    assert eg == f"Units {row[2]}, usual limit {js(body['limits']['Units'][3])}" and f"Units weird limit is {js(body['limits']['Units'][3])}; this is {row[2]}" in r["reason"]
    # the example is a value past its column's usual limit, not a x10, a percent or a sign: the words must cover it
    assert "a figure far past its column's usual range" in what["Keying errors"], what["Keying errors"]
    n, row, r, eg = checks["Consistency"]
    assert eg == f'"{row[1]}" to "{r["likely"]["Region"]}"'
    n, row, r, eg = checks["Temporal"]
    assert eg == f"a jump in Total on {row[0]}" and f"Total jumped sharply near {row[0]}" in plain_reason(r["reason"])
    # the sample has no people column: no fairness test runs and the pane shows no fairness line, so the example is the
    # engine's sentence on an illustrative people sheet, never "Region: even" (which read like this sample's result)
    assert body["fairness"] == {"protected": {}, "tests": []}
    people = [[f"P{i}", ["Female", "Male"][i % 2], 25 + i % 30, 40000 + (i * 7919) % 20000] for i in range(200)]
    for i in (5, 50, 90, 133, 170):
        people[i][3] = 999999
    f = APP.post("/scan", json={"columns": ["Name", "Gender", "Age", "Salary"], "rows": people, "strength": 5}).get_json()
    said = [t["text"] for t in f["fairness"]["tests"]]
    fair = checks["Fairness"].one("span", cls="other-sheet").one("span", cls="say").text()
    assert fair in said and fair.split(":")[0] not in COLUMNS, f"{fair} is not what the engine says: {said}"
    # the rest are general forms on another sheet, not claims about this one (a change here is a change to re-check by hand)
    assert [checks[k].one("span", cls="other-sheet").text() for k in ("Completeness", "Plausibility", "Ask AI (optional)")] == [
        "On another sheet: #N/A, a repeated row", "On another sheet: Month 13, 99999", 'A request: "Use the usual spelling"']
    # ...and those other-sheet examples are the engine's too: a small sheet with each one planted gets each one flagged
    # for it (they were only words pinned here, AH-129)
    cols, other = ["OrderID", "Month", "Region", "Units", "Total"], []
    for k in range(60):
        u = 40 + (k * 7) % 23
        other.append([f"A{1000 + k}", 1 + k % 12, ["East", "West", "Central"][k % 3], u, round(u * 2.5 + (k * 13) % 7, 2)])
    other[9][3], other[20], other[30][1], other[40][4] = "#N/A", list(other[19]), 13, 99999
    said = {i + 2: r["reason"] for i, r in enumerate(APP.post("/scan", json={"columns": cols, "rows": other, "strength": 5}).get_json()["rows"]) if r["severity"]}
    for n, words in ((11, "Excel error #N/A in Units"), (22, "Duplicate of row 21"), (32, "Month 13 is outside what Month can be"), (42, "Total 99999 looks like a code")):
        assert words in said.get(n, ""), f"row {n}: {said.get(n)}"


def test_the_python_port_of_the_panes_words_matches_the_pane():
    """The words above are ported from frontend/; this runs the pane's own functions on the same answers (node)."""
    node = shutil.which("node")
    if not node:
        return  # CI's Python job has node; a PC without it still checks everything above against the port
    rows, after = sample(), fixed_sheet()
    out, out_after = scan(rows), scan(after)
    script = """
      import { plainReason, summaryOf, fairnessNote } from "SCAN";
      import { recommendFix } from "FIX";
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const { columns, rows, out, limits, after, fair } = JSON.parse(s);
        const each = out.map((r, i) => r.severity ? [i + 2, plainReason(r.reason), recommendFix(columns, rows, i, limits, r.reason, 0, 0, r.likely, null, r.maybe)] : null).filter(Boolean);
        process.stdout.write(JSON.stringify({ each, summary: summaryOf(out), after: summaryOf(after), fair: fairnessNote(fair) }));
      });
    """.replace("SCAN", (ROOT / "frontend/features/scan.js").as_uri()).replace("FIX", (ROOT / "frontend/features/fix.js").as_uri())
    got = json.loads(subprocess.run([node, "--input-type=module", "-e", script], input=json.dumps({
        "columns": COLUMNS, "rows": rows, "out": out["rows"], "limits": out["limits"], "after": out_after["rows"], "fair": out["fairness"]}),
        capture_output=True, text=True, check=True, timeout=60).stdout)
    for n, said, rec in got["each"]:
        r = out["rows"][n - 2]
        mine = recommend_fix(rows[n - 2], n, r)
        assert said == plain_reason(r["reason"]), n
        assert rec["explanation"] == mine["explanation"] and [(c["cell"], c["new"]) for c in rec["changes"]] == mine["changes"], n
    assert got["summary"] == summary_of(out["rows"]) == "3 of 60 rows look wrong. 4 more are worth a quick check."
    assert got["after"] == summary_of(out_after["rows"])
    assert got["fair"] == ""  # no fairness line in the pane for this sheet
