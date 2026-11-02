"""The website's sample scan is the engine's own answer, not a picture of one (AH-87).

site/index.html says of its 60-row sample: "The findings are the engine's own result on it". Nothing checked that: row
22's sentence had lost the engine's "Units breaks its usual pattern near 2026-01-26", and row 31's detail said "East"
was in 19 other rows (it is in 20). This rebuilds the sheet, checks every row the page shows against it, scans it as
the pane does (dates as the pane sends them, the level the page names) and holds the page to what came back: the
flagged rows, their severity words, each sentence in the pane's plain words, each fix, the counts and the filters.
"""
import datetime
import json
import re
import subprocess
from html.parser import HTMLParser
from pathlib import Path

from anomaly_hunter.server import create_app

ROOT = Path(__file__).resolve().parents[2]
PAGE = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
COLUMNS = ["OrderDate", "Region", "Units", "UnitCost", "Total"]


def sample():
    """The 60 orders: the rows of e2e/run.mjs's sales sheet (a date a day from 2026-01-06, East/West/Central in turn,
    Units 40-62, UnitCost 1.99-4.99, Total = Units x UnitCost), with 3 planted errors: Units -5 (row 11), Units 7777
    (row 22) and "east " (row 31). Dates as the pane sends them (sheet.js excelDate: yyyy-mm-dd)."""
    rows = []
    for i in range(60):
        u, c = 40 + (i * 7) % 23, round(1.99 + i % 4, 2)
        day = datetime.date(1899, 12, 30) + datetime.timedelta(days=46028 + i)  # Excel's serial 46028
        rows.append([day.isoformat(), ["East", "West", "Central"][i % 3], u, c, round(u * c, 2)])
    rows[9][2], rows[20][2], rows[29][1] = -5, 7777, "east "
    return rows


class Sample(HTMLParser):
    """The sample's table rows and detail boxes, as text."""

    def __init__(self):
        super().__init__()
        self.rows, self.boxes, self.where, self.cell, self.text = [], {}, [], None, ""

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        self.where.append((tag, a))
        if tag == "tr" and "skip" not in a.get("class", "") and self.inside("tbody"):
            self.rows.append({"kind": a.get("data-kind", ""), "cells": [], "classes": []})
        elif tag == "div" and "matrix" in a.get("class", ""):
            self.box = self.boxes.setdefault(a["id"], {"head": "", "dl": [], "said": ""})
        if tag in ("th", "td") and self.rows and self.inside("tbody"):
            self.cell, self.text = a.get("class", ""), ""
        elif tag in ("b", "dt", "dd", "p") and self.inside_box():
            self.text = ""

    def handle_endtag(self, tag):
        _, a = self.where.pop()
        if tag in ("th", "td") and self.cell is not None:
            self.rows[-1]["cells"].append(self.text.replace("\xa0", " "))
            self.rows[-1]["classes"].append(self.cell)
            self.cell = None
        elif self.inside_box() and tag in ("b", "dt", "dd", "p"):
            if tag == "b" and self.inside_tag("div", "m-head"):
                self.box["head"] = self.text
            elif tag in ("dt", "dd"):
                self.box["dl"].append(self.text)
            elif tag == "p" and "m-said" in a.get("class", ""):
                self.box["said"] = self.text

    def handle_data(self, data):
        self.text += data

    def inside(self, tag):
        return any(t == tag for t, _ in self.where)

    def inside_tag(self, tag, cls):
        return any(t == tag and cls in a.get("class", "") for t, a in self.where)

    def inside_box(self):
        return self.inside_tag("div", "matrix")


def pane(reasons):
    """The pane's own words for each engine reason (features/scan.js plainReason) and its severity words (SEV)."""
    script = ("const [s, k] = await Promise.all(process.argv.slice(1).map((u) => import(u)));"
              "const rs = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));"
              "process.stdout.write(JSON.stringify({ said: rs.map(s.plainReason), sev: k.SEV }));")
    done = subprocess.run(["node", "--input-type=module", "-e", script, (ROOT / "frontend/features/scan.js").as_uri(),
                           (ROOT / "frontend/constants/index.js").as_uri()], input=json.dumps(reasons),
                          capture_output=True, text=True, check=True, encoding="utf-8")
    return json.loads(done.stdout)


def test_the_websites_sample_shows_exactly_what_the_engine_finds():
    rows = sample()
    page = Sample()
    page.feed(PAGE[PAGE.index('<figure class="ws" id="preview"'):PAGE.index("</figure>")])
    assert "<span>60 rows · 5 columns</span>" in PAGE and "Reading 60 rows and 5 columns" in PAGE
    caption = re.search(r'<figcaption class="ws-foot" id="ws-cap">(.*?)</figcaption>', PAGE).group(1)
    level = int(re.search(r"at level (\d+) of 10", caption).group(1))

    # every row the page shows is the sheet's own, cell for cell
    shown = {}
    for r in page.rows:
        n, cells = int(r["cells"][0]), r["cells"][1:6]
        want = rows[n - 2]
        assert cells == [want[0], want[1], str(want[2]), f"{want[3]:.2f}", f"{want[4]:.2f}"], n
        shown[n] = {"kind": set(r["kind"].split()), "why": r["cells"][6].strip(), "flag": [COLUMNS[k] for k, c in enumerate(r["classes"][1:6]) if "flag" in c]}

    out = create_app(None).test_client().post("/scan", json={
        "columns": COLUMNS, "rows": rows, "limits": None, "order_by": None, "strength": level, "power_bi": False,
        "start_row": 0, "sheet": "Sales", "decisions": None})
    assert out.status_code == 200
    got = out.get_json()["rows"]
    words = pane([r.get("reason") or "" for r in got])
    sev = words["sev"]
    flagged = {k + 2: r for k, r in enumerate(got) if r.get("severity") in sev}

    # the page lists exactly the engine's flagged rows, each with a detail box, and counts them as it does
    listed = {n for n, r in shown.items() if r["kind"]}
    assert listed == set(flagged), (listed, set(flagged))
    tally = {}
    for n, r in flagged.items():
        tally[sev[r["severity"]]] = tally.get(sev[r["severity"]], 0) + 1
    for name, count in tally.items():
        assert f"{name}: {count}</span>" in PAGE, (name, count)
    assert f'data-kind="all" aria-pressed="true">All findings<span class="n" data-n="{len(flagged)}">' in PAGE

    for n, r in flagged.items():
        said, box, row = words["said"][n - 2], page.boxes[f"m{n}"], shown[n]
        assert box["head"] == f"Row {n} · {sev[r['severity']]}", (n, box["head"])
        # the engine's sentence, word for word: in the box where the page quotes it, else in the row itself
        if box["said"]:
            assert box["said"] == f'Engine: "{said}"', (n, box["said"], said)
        else:
            assert row["why"] == said, (n, row["why"], said)
        # each fix is the engine's, and only the engine's
        fixes = {**(r.get("likely") or {}), **(r.get("exact") or {})}
        shown_fix = re.search(r"Fix: (?:(\w+) )?(\S+)$", row["why"])
        if shown_fix:
            column = shown_fix.group(1) or (r.get("cells") or [""])[0]
            want = fixes.get(column)
            assert (f"{want:g}" if isinstance(want, float) else str(want)) == shown_fix.group(2), (n, row["why"], fixes)
            assert shown_fix.group(2) in box["dl"][box["dl"].index("Proposed fix") + 1], n
        else:
            assert not fixes and "None." in box["dl"][box["dl"].index("Proposed fix") + 1], (n, fixes)
        # the cells marked wrong are cells the engine names
        assert set(row["flag"]) <= set(r.get("cells") or []), (n, row["flag"], r.get("cells"))
        # each filter holds the rows whose sentence is of its kind
        kinds = {"recon": "does not add up" in said, "keying": "usual limit" in said, "label": "looks like" in said,
                 "time": "jumped sharply" in said or "breaks its usual pattern" in said}
        assert row["kind"] == {k for k, v in kinds.items() if v}, (n, row["kind"], said)
        # the numbers a box gives are the engine's: the limit, the product, the usual spelling's count
        for dt, dd in zip(box["dl"][::2], box["dl"][1::2]):
            if dt == "Usual limit":
                limit = re.search(r"usual limit of (-?[\d.]+)", said).group(1)
                assert re.search(rf"\b{re.escape(limit)}\b", dd), (n, dd, said)
            elif dt == "Found" and "×" in dd:
                assert dd.split(" = ")[1].split(",")[0] in said, (n, dd, said)
            elif dt == "Usual spelling":
                usual = re.search(r'"(\w+)", in (\d+) other rows', dd)
                assert sum(x[1] == usual.group(1) for x in rows) == int(usual.group(2)), (n, dd)
    for kind in ("recon", "keying", "label", "time"):
        count = sum(kind in shown[n]["kind"] for n in flagged)
        assert f'data-kind="{kind}" aria-pressed="false">' in PAGE and re.search(rf'data-kind="{kind}" aria-pressed="false">[^<]*<span class="n" data-n="{count}">{count}<', PAGE), kind
