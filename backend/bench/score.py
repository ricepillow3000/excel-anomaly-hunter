"""Industry benchmark: the REAL panel (via node) + engine on 15 industry sheets (finance GL, IB comps, quant prices,
supply chain, healthcare, construction, HR, marketing, sales, real estate, insurance, manufacturing, education, energy,
logistics) + held-out traps (signed P&L, heavy-tailed claims, ID look-alikes, year headers), with planted problems
whose true values are known. Usage: python backend/bench/score.py . [--detail] [--main-seed N] [--seeds a,b,c]
Exit 1 when a gate fails: a crash, a harmful fix (writes into an ID/formula column or "corrects" a real outlier),
a flagged totals row, a misread header, or Medium+ false alarms above 1% of clean rows."""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))  # works with \ paths on Windows too
sys.path.insert(0, sys.argv[1]); sys.path.insert(0, HERE)
from anomaly_hunter.server import create_app
import datasets, datasets2
arg = lambda k, dflt: next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == k), dflt)
SEEDS = [int(x) for x in arg("--seeds", "11,12,13").split(",")]
make = lambda: datasets.make(int(arg("--main-seed", 7))) + [d for sd in SEEDS for d in datasets2.make(sd)]

REPO, DETAIL = __import__("os").path.abspath(sys.argv[1]), "--detail" in sys.argv
BRIDGE = os.path.join(HERE, "bridge.js")
node = lambda jobs: json.loads(subprocess.run(["node", BRIDGE, REPO + "/frontend"], input=json.dumps(jobs),
                                              capture_output=True, text=True, check=True).stdout)
app = create_app().test_client()
scan = lambda t, lim: app.post("/scan", json={"columns": t["columns"], "rows": t["rows"], "limits": lim, "order_by": None}).get_json()
flag = lambda r: r["severity"] not in (None, "Noted")


def colname(t, cell):
    import re
    letters = re.match(r"[A-Z]+", cell).group()
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    k = n - 1 - t["startCol"]
    return str(t["columns"][k]) if 0 <= k < len(t["columns"]) else None


def close(a, b):
    try:
        a, b = float(a), float(b)
    except (TypeError, ValueError):
        return False
    return abs(a - b) <= max(1e-9, 0.01 * abs(b))


tot = {"harm": 0, "planted": 0, "caught": 0, "restored": 0, "fa_med": 0, "fa_low": 0, "clean": 0, "totals_flagged": 0, "totals": 0,
       "hdr_ok": 0, "sheets": 0, "crash": 0, "id_flags": 0}
for d in make():
    tot["sheets"] += 1
    try:
        fcols = [k for k, c in enumerate(d["grid"][d["header"]]) if c in d.get("formulas", {})]
        formulas = [[f"=B{r + 1}-C{r + 1}" if r > d["header"] and k in fcols else v for k, v in enumerate(row)]
                    for r, row in enumerate(d["grid"])] if fcols else None
        t = node([{"op": "table", "grid": d["grid"], "formulas": formulas}])[0]
        hdr_ok = [str(c) for c in t["columns"]] == [str(c) for c in d["grid"][d["header"]]]
        lim = scan(t, None)
        if "error" in lim:
            raise RuntimeError(lim["error"])
        limits = {k: list(v) for k, v in lim["suggested_limits"].items()}
        res = scan(t, limits)
        if "error" in res:
            raise RuntimeError(res["error"])
    except Exception as e:
        tot["crash"] += 1
        print(f"{d['name']:20s} CRASH {e}")
        continue
    rows = res["rows"]
    t["gridRows"] = [t["startRow"] + 1 + k for k in range(len(t["rows"]))]  # bench grids start at A1
    g2i = {g: k for k, g in enumerate(t["gridRows"])}
    planted = {p["row"]: p for p in d["planted"]}
    jobs, pl = [], []
    for p in d["planted"]:
        i = g2i.get(p["row"])
        if i is None:
            continue
        jobs.append({"op": "rec", "columns": t["columns"], "rows": t["rows"], "i": i, "limits": limits, "reason": rows[i]["reason"],
                     "startRow": t["startRow"], "startCol": t["startCol"], "extra": rows[i],
                     "calc": t["calc"][i] if t.get("calc") else None})
        pl.append((p, i))
    recs = node(jobs) if jobs else []
    caught = restored = 0
    lines = []
    harm = []
    for (p, i), rec in zip(pl, recs):
        c = flag(rows[i])
        cell_changes = [ch for ch in rec["changes"]]
        if p["kind"] == "text_variant":  # right fix = the column's usual spelling of the SAME word
            raw = t["rows"][i][[str(c) for c in t["columns"]].index(p["col"])]
            ok = any(ch["new"] != raw and ch["new"].casefold() == " ".join(raw.split()).casefold() for ch in cell_changes)
        elif p["kind"] == "excel_error":  # can't know the value: right advice, and no invented number
            ok = not cell_changes and any(e in rec["explanation"] for e in ("#N/A", "#DIV/0!", "#REF!", "#VALUE!"))
        elif p["kind"] == "real_outlier":  # a true extreme value: flag it, never 'correct' it
            ok = not cell_changes
        else:
            ok = any(close(ch["new"], p["true"]) for ch in cell_changes)
        for ch in cell_changes:  # harmful: writes into an ID / protected / totals column-row, or 'corrects' a real outlier
            col = colname(t, ch["cell"])
            if col in d["idcols"] or col in d.get("protect", []) or p["kind"] == "real_outlier":
                harm.append(f"{d['name']}:{ch['cell']}({col})")
        caught += c; restored += bool(ok)
        lines.append(f"    {p['kind']:15s} {p['col']:18s} flagged={rows[i]['severity']!s:6s} fix_ok={bool(ok)!s:5s} "
                     f"true={p['true']!r} rec={[ch['new'] for ch in cell_changes]} | {rec['explanation'][:90]}")
    fa_med = fa_low = clean = 0
    for k, g in enumerate(t["gridRows"]):
        if g in planted or g in d["totals"]:
            continue
        clean += 1
        if flag(rows[k]):
            if rows[k]["severity"] == "Low":
                fa_low += 1
            else:
                fa_med += 1
    tf = sum(1 for g in d["totals"] if g in g2i and flag(rows[g2i[g]]))
    idf = sum(1 for r in rows if r["reason"] and any(f"{c} " in r["reason"] or f"mainly {c}" in r["reason"] for c in d["idcols"]))
    for k, v in (("harm", len(harm)), ("planted", len(d["planted"])), ("caught", caught), ("restored", restored), ("fa_med", fa_med), ("fa_low", fa_low),
                 ("clean", clean), ("totals_flagged", tf), ("totals", len(d["totals"])), ("hdr_ok", hdr_ok), ("id_flags", idf)):
        tot[k] += v
    print(f"{d['name']:20s} hdr={'ok ' if hdr_ok else 'BAD'} caught {caught}/{len(d['planted'])} fixed {restored}/{len(d['planted'])} "
          f"false-alarm med+ {fa_med}/{clean} low {fa_low} | totals flagged {tf}/{len(d['totals'])} | id-col reasons {idf}"
          + (f" | HARMFUL {harm}" if harm else ""))
    if DETAIL:
        print("\n".join(lines))
print("TOTAL", json.dumps(tot))
gates = {"no crash": not tot["crash"], "no harmful fix": not tot["harm"], "no totals flagged": not tot["totals_flagged"],
         "headers read": tot["hdr_ok"] == tot["sheets"], "false alarms <= 1%": tot["fa_med"] <= 0.01 * tot["clean"]}
print("GATES", "pass" if all(gates.values()) else "FAIL: " + ", ".join(k for k, ok in gates.items() if not ok))
sys.exit(0 if all(gates.values()) else 1)
