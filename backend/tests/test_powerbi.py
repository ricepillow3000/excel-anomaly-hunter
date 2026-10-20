"""The Power BI copy (latest-scan.csv, latest-flags.csv) is the scan the pane got, cell for cell, in a file Power BI's
own Text/CSV import reads the same way (2026-10-20). The rules each value follows are written out here, apart from
the code, as powerbi/README.md documents them: a test that only re-ran the writer would prove nothing."""
import datetime
import json
import re
import subprocess
import unicodedata
from pathlib import Path

import pytest

from anomaly_hunter import powerbi
from anomaly_hunter.server import create_app

ROOT = Path(__file__).resolve().parents[2]
BOM = "﻿"
FORMULA = tuple("=+-@\t\r\n＝＋－＠")
RESULTS = ["Severity", "Bucket", "Reason", "Suggested Fix", "Magnitude"]
FLAGS = ["Scanned At", "Sheet", "Excel Row", *RESULTS]


def fields(line):
    """One CSV record -> [(value, was it quoted)]: RFC 4180, by hand, so a quoted "" and an empty field differ."""
    out, i = [], 0
    while True:
        if line[i:i + 1] == '"':
            j, v = i + 1, []
            while True:
                k = line.index('"', j)
                v.append(line[j:k])
                if line[k + 1:k + 2] == '"':
                    v.append('"')
                    j = k + 2
                    continue
                i = k + 1
                break
            out.append(("".join(v), True))
        else:
            k = line.find(",", i)
            k = len(line) if k < 0 else k
            out.append((line[i:k], False))
            i = k
        if i >= len(line):
            return out
        assert line[i] == ",", (line, i)
        i += 1


def read(path):
    """-> records as [(value, quoted)], read the way Power BI's generated query (QuoteStyle.None) reads: a record ends
    at every line break, quoted or not. Also proves the file is UTF-8 with a BOM and ends each record with CRLF."""
    raw = Path(path).read_bytes()
    body = raw.decode("utf-8")  # strict: never a half-encoded character
    assert body.startswith(BOM), "no BOM: Power BI would read the file as Windows-1252"
    lines = body[1:].split("\r\n")
    assert lines[-1] == "" and not any("\r" in ln or "\n" in ln for ln in lines), "a line break inside a record"
    return [fields(ln) for ln in lines[:-1]]


def as_text(v):
    """The documented text rule: line breaks become ↵, NUL and a lone surrogate become ?, then = + - @ tab (or their
    full-width forms) at the start get a leading apostrophe."""
    v = re.sub(r"\r\n|\r|\n", "↵", str(v)).replace("\x00", "?")
    v = "".join("?" if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in v)
    return "'" + v if v.startswith(FORMULA) else v


def same(cell, v):
    """A CSV field holds sheet value v under the documented rules (blank, TRUE/FALSE, number, text)."""
    got, quoted = cell
    if v is None or v == "":
        return got == "" and not quoted  # an empty field: Power BI reads null
    if isinstance(v, bool):
        return (got, quoted) == ("TRUE" if v else "FALSE", False)
    if isinstance(v, int):
        try:
            float(v)
        except OverflowError:  # no float holds it: its digits, as text
            return (got, quoted) == (str(v), True)
        return not quoted and int(got) == v
    if isinstance(v, float):
        return not quoted and float(got) == v and "e" not in got
    return quoted and got == as_text(v)


# Every kind of cell a real export throws at a CSV, plus planted mistakes so the flags table has rows to carry
LONG = "Very long note " * 400  # 6,000 characters
NASTY = ["Café ☕", "naïve — “quotes”", 'say "hi", then go', "line one\nline two", "crlf\r\nbreak", "cr\ronly",
         "=HYPERLINK(\"http://evil\",\"x\")", "+1 555", "-dash start", "@SUM(A1)", "\tleading tab", "＝1+1", "a;=cmd|' /C calc'!A0",
         "👩‍👩‍👧 family", "‏RTL mark", "​zero width", "ab\ud800", "nul\x00char", LONG, " ", "#N/A", "N/A", "日本語"]


def sheet(n=60):
    columns = ["ID", "Région ✓", "Note", "Units", "Price", "Total", "Date", "Active", "Big", "=Header", "Severity", "Excel Row"]
    rows = []
    for k in range(n):
        u, p = 10 + k % 7, [2.5, 4.0, 9.99][k % 3]
        rows.append([f"ID{k:03d}", ["East", "West", "North"][k % 3], NASTY[k % len(NASTY)], u, p, round(u * p, 2),
                     f"2026-0{1 + k % 9}-{10 + k % 18:02d}" + (" 13:45:00" if k % 5 == 0 else ""), k % 2 == 0,
                     [10 ** 15, 2 ** 53 + 1, 1e300, -1e-300, 0.1 + 0.2, -0.0, 12345678901234567890][k % 7],
                     k * 1.5, "keep", 7])
    rows[4][3] = 140            # x10 typo: 14 -> 140 (its Total, 56, says 14)
    rows[9][1] = "east "        # a capitals/spaces slip
    rows[14][5] = 999.0         # a total that does not add up
    rows[20] = list(rows[19])   # a double entry
    rows[25][3] = ""            # a blank in a full column
    rows[30][3] = "#DIV/0!"     # an Excel error
    rows[33][8] = 10 ** 309     # no float holds it
    rows[35][3] = None          # a blank sent as null
    return columns, rows


@pytest.fixture
def scanned(tmp_path):
    columns, rows = sheet()
    out = tmp_path / "latest-scan.csv"
    r = create_app(out).test_client().post("/scan", json={"columns": columns, "rows": rows, "power_bi": True,
                                                           "start_row": 3, "sheet": "Données ✓"})
    assert r.status_code == 200 and r.get_json()["power_bi_saved"] is True
    return columns, rows, r.get_json()["rows"], out


def test_the_power_bi_copy_holds_every_cell_and_every_verdict_the_pane_got(scanned):
    columns, rows, verdicts, out = scanned
    table = read(out)
    header = [v for v, q in table[0]]
    assert all(q for _, q in table[0])
    # a sheet's own "Severity" and "Excel Row" keep their names; ours step aside, and nothing is written twice
    assert header == ["Anomaly Hunter Excel Row", *map(as_text, columns), "Anomaly Hunter Severity", *RESULTS[1:]]
    assert len(set(header)) == len(header)
    assert len(table) == 1 + len(rows), "one record per data row, even with line breaks in cells"
    w = len(columns)
    for i, (rec, row, v) in enumerate(zip(table[1:], rows, verdicts, strict=True)):
        assert len(rec) == len(header), i
        assert rec[0] == (str(3 + 2 + i), False), "Excel Row = the pane's Row N"
        for j, value in enumerate(row):
            assert same(rec[1 + j], value), (i, columns[j], value, rec[1 + j])
        sev, bucket, reason, fix, mag = rec[1 + w:]
        assert same(sev, v["severity"]) and same(bucket, v["bucket"]) and same(reason, v["reason"]), i
        assert not mag[1] and float(mag[0]) == v["magnitude"], i
        assert (fix == ("", False)) == (v["severity"] not in ("High", "Medium", "Low") or not fix[0]), i


def test_the_flags_table_has_one_record_per_flagged_row_and_never_changes_shape(scanned):
    columns, rows, verdicts, out = scanned
    flags = read(out.with_name("latest-flags.csv"))
    assert [v for v, _ in flags[0]] == FLAGS
    hits = [i for i, v in enumerate(verdicts) if v["severity"] in ("High", "Medium", "Low")]
    assert len(hits) >= 8 and len(flags) == 1 + len(hits)
    full = {int(r[0][0]): r for r in read(out)[1:]}
    w = len(columns)
    for rec, i in zip(flags[1:], hits, strict=True):
        at, name, row = rec[:3]
        assert datetime.datetime.fromisoformat(at[0]).tzinfo is not None and at[1], "a time Power BI reads, with its zone"
        assert name == ("Données ✓", True) and row == (str(5 + i), False)
        assert rec[3:] == full[5 + i][1 + w:], "the same verdict as the full table"
        assert same(rec[3], verdicts[i]["severity"]) and same(rec[5], verdicts[i]["reason"])
    # every planted mistake is there (rows 4, 9, 14, 19/20, 25, 30, 35)
    assert {4, 9, 14, 20, 25, 30, 35} <= set(hits), hits


def test_no_text_in_the_power_bi_copy_can_run_as_a_formula(scanned):
    *_, out = scanned
    for path in (out, out.with_name("latest-flags.csv")):
        for rec in read(path):
            for value, quoted in rec:
                assert quoted or re.fullmatch(r"|TRUE|FALSE|-?\d+|-?\d+\.\d+(E[+-]\d+)?|-?\d(\.\d+)?E[+-]\d+", value), value
                assert not (quoted and unicodedata.normalize("NFKC", value).startswith(FORMULA)), value


def test_the_suggested_fix_is_what_the_panes_card_offers(scanned):
    """The card's own code (fix.recommendFix, run by node) and the CSV agree on every flagged row: same cells, same
    new values. A value the card holds back (2+ cells off by the same step) is held back here too."""
    columns, rows, verdicts, out = scanned
    flagged = [i for i, v in enumerate(verdicts) if v["severity"] in ("High", "Medium", "Low")]
    limits = create_app().test_client().post("/scan", json={"columns": columns, "rows": rows}).get_json()["limits"]
    cards = card_changes(columns, rows, verdicts, flagged, limits)
    for i in flagged:
        text = powerbi.suggested_fix(columns, rows[i], verdicts[i])
        got = {(m[1], m[2]) for m in re.finditer(r'(?:^|; )(.+?): (?:"[^"]*"|\S+) → "?(.*?)"?(?: \(a guess\))?(?=; |$)', text)}
        assert got == cards[i], (i, text, cards[i])
    assert any(cards[i] for i in flagged), "the sheet has fixes to compare"


def card_changes(columns, rows, verdicts, which, limits):
    """{row: {(column, new value)}} from the pane's recommendFix, with the engine's likely and maybe values."""
    from openpyxl.utils import column_index_from_string
    script = ("const { recommendFix } = await import(process.argv[1]);"
              "const jobs = JSON.parse((await import('node:fs')).readFileSync(0, 'utf8'));"
              "process.stdout.write(JSON.stringify(jobs.map((j) => recommendFix(j.columns, j.rows, j.i, j.limits, j.reason, 0, 0,"
              " j.likely, null, j.maybe).changes)));")
    jobs = [{"columns": columns, "rows": rows, "i": i, "limits": limits, "reason": verdicts[i]["reason"],
             "likely": verdicts[i].get("likely"), "maybe": verdicts[i].get("maybe")} for i in which]
    done = subprocess.run(["node", "--input-type=module", "-e", script,
                           (ROOT / "frontend/features/fix.js").as_uri()], input=json.dumps(jobs), capture_output=True,
                          text=True, check=True, encoding="utf-8")
    return {i: {(columns[column_index_from_string(re.match(r"[A-Z]+", c["cell"])[0]) - 1], str(c["new"])) for c in ch}
            for i, ch in zip(which, json.loads(done.stdout), strict=True)}


def test_a_row_off_by_the_same_step_in_two_cells_gets_no_suggested_fix():
    # the card's rule (California's fruit, all three columns "likely /1000", 2026-10-16): one slip changes one cell
    v = {"severity": "Medium", "reason": "A weird limit is 50; this is 1000 (likely 100); B weird limit is 50; this is 900 (likely 90)",
         "likely": {"A": 100.0, "B": 90.0}}
    assert powerbi.suggested_fix(["A", "B"], [1000, 900], v) == ""
    v["likely"]["B"] = -900.0  # a different slip in each cell: both stay
    assert powerbi.suggested_fix(["A", "B"], [1000, 900], v) == "A: 1000 → 100; B: 900 → -900"


def test_turning_power_bi_off_removes_both_copies_at_the_next_scan(tmp_path):
    out = tmp_path / "latest-scan.csv"
    columns, rows = sheet(40)
    c = create_app(out).test_client()
    assert c.post("/scan", json={"columns": columns, "rows": rows, "power_bi": True}).get_json()["power_bi_saved"] is True
    assert out.exists() and out.with_name("latest-flags.csv").exists()
    r = c.post("/scan", json={"columns": columns, "rows": rows})
    assert r.get_json()["power_bi_saved"] is None and not list(tmp_path.iterdir())


def test_a_copy_that_cannot_be_written_never_leaves_an_older_sheets_copy_behind(tmp_path, monkeypatch):
    # an old latest-scan.csv kept after a failed write is another sheet that Power BI would show as this scan
    out = tmp_path / "latest-scan.csv"
    columns, rows = sheet(40)
    c = create_app(out).test_client()
    c.post("/scan", json={"columns": columns, "rows": rows, "power_bi": True})

    def full_disk(*a, **k):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(powerbi.os, "replace", full_disk)
    r = c.post("/scan", json={"columns": columns, "rows": rows[:20], "power_bi": True})
    assert r.status_code == 200 and r.get_json()["power_bi_saved"] is False and len(r.get_json()["rows"]) == 20
    assert not list(tmp_path.iterdir()), "no old copy, no half-written .tmp"


@pytest.mark.parametrize("bad", [{"start_row": -1}, {"start_row": 1048576}, {"start_row": "3"}, {"start_row": True},
                                 {"sheet": 5}, {"sheet": "x" * 32}])
def test_where_the_table_sits_is_checked_before_the_scan(bad):
    columns, rows = sheet(40)
    assert create_app().test_client().post("/scan", json={"columns": columns, "rows": rows, **bad}).status_code == 400


def test_the_power_bi_shortcuts_each_open_their_own_csv(tmp_path):
    data = tmp_path / "Ünïcode user" / "AnomalyHunter"
    made = powerbi.shortcuts(data, tmp_path / "powerbi")
    assert sorted(p.name for p in made) == ["anomaly-hunter-flags.pbids", "anomaly-hunter.pbids"]
    for p, csv_name in zip(sorted(made), ["latest-flags.csv", "latest-scan.csv"], strict=True):
        spec = json.loads(p.read_bytes().decode("ascii"))  # ASCII: Power BI never misreads a non-English path
        assert spec["version"] == "0.1" and len(spec["connections"]) == 1, "a .pbids holds one data source"
        conn = spec["connections"][0]
        assert conn["details"] == {"protocol": "file", "address": {"path": str(data / csv_name)}} and conn["mode"] == "Import"
    # both installers write them with this same code
    assert "powerbi.shortcuts(home, home)" in (ROOT / "backend/anomaly_hunter/app.py").read_text(encoding="utf-8")
    assert '-m anomaly_hunter.powerbi "%AH%" powerbi' in (ROOT / "install.bat").read_text(encoding="utf-8")
