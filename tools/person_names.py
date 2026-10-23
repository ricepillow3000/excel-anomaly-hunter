"""Write backend/anomaly_hunter/engine/person_names.txt: the commonest US first names and surnames, which tell a column
of people (Thompson, Ann Jones) from one of companies (Microsoft, Maersk Line) under a header like Customer or Owner
(AH-26). Read from two pinned public tables, checked by sha256; re-running gives the same file.

    python tools/person_names.py            # rewrite the file
    python tools/person_names.py --check    # exit 1 if the file differs from a fresh build
"""
import collections, csv, hashlib, io, sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "backend" / "anomaly_hunter" / "engine" / "person_names.txt"
RAW = "https://raw.githubusercontent.com/"
SOURCES = {
    "surnames": {"title": "US Census 2000 surnames (via FiveThirtyEight, most-common-name)", "licence": "US Census: public domain",
                 "url": RAW + "fivethirtyeight/data/4c1ff5e3aef1816ae04af63218015066e186c147/most-common-name/surnames.csv",
                 "sha256": "1498e6a40db61e5edcbd93d9dded9e5249e1a2e9db7571ecc8468c6d6e6acdf7"},
    "first": {"title": "US Social Security baby names 1880-2008 (Hadley Wickham, data-baby-names)", "licence": "SSA: public domain",
              "url": RAW + "hadley/data-baby-names/b6525579cf7d2816e77fa885299445d15a09c906/baby-names.csv",
              "sha256": "1259523fa76e5c18151a4c7612b854b22605d07127c596126940e2941ba15d3c"},
}
SURNAMES, FIRST = 5000, 2000  # the commonest of each: a roster's names are mostly among them; more only adds rare words


def fetch(key):
    s = SOURCES[key]
    body = requests.get(s["url"], timeout=120).content
    if hashlib.sha256(body).hexdigest() != s["sha256"]:
        raise SystemExit(f"{key}: the download is not the pinned file ({s['url']})")
    return body.decode("utf-8")


def build():
    sur = [r["name"].lower() for r in csv.DictReader(io.StringIO(fetch("surnames")))][:SURNAMES]
    tot = collections.Counter()
    for r in csv.DictReader(io.StringIO(fetch("first"))):
        tot[r["name"].lower()] += float(r["percent"])
    first = [n for n, _ in tot.most_common(FIRST)]
    names = sorted({n for n in sur + first if n.isalpha() and len(n) >= 2})
    head = "# made by tools/person_names.py: the commonest US surnames (Census 2000) and first names (SSA), public domain\n"
    return head + "\n".join(names) + "\n"


if __name__ == "__main__":
    text = build()
    if "--check" in sys.argv:
        same = OUT.read_text(encoding="utf-8") == text
        print("person_names.txt matches a fresh build" if same else "person_names.txt differs from a fresh build")
        sys.exit(0 if same else 1)
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"{OUT.name}: {text.count(chr(10)) - 1} names, {len(text.encode()) / 1024:.1f} KB")
