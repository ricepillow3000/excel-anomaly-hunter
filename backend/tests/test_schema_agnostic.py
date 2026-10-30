"""AH-78 (John, 2026-10-30): no logic may be built for named fields or one industry; the engine must fit any schema
by reading the data itself. Proof, on generated sheets only: an 8-column ledger and a 40-column sensor log whose
headers mean nothing (c01, c02...), each with planted structural mistakes, are scanned by the same code with no
setting changed. Every plant is found, no clean row is called Medium or worse at the default level (at most 1% at
level 10, the strictest), the limits each column is judged by
come from that column alone (scale a column x1000 and its limits scale x1000, its flags stay), and the flags do not
depend on what the headers say. The checks that DO read a header (Month 13, Age 310, the fairness report's people
columns, a signed Profit) are listed in CLAUDE.md's feature map; meaningless headers switch them off here on purpose."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

FLAG = ("Medium", "High")


def sheet(kind, seed, n=240):
    """-> (columns, rows, plants {row: what}). Column kinds are drawn at random; only their shapes matter."""
    rng = np.random.default_rng(seed)
    width = {"ledger": 8, "sensor": 40}[kind]
    # every sheet carries the shapes the plants need; the rest of the width is drawn at random
    kinds = ["code", "date", "label", "amount", "amount", "sum"] + list(rng.choice(
        ["amount", "reading", "count", "label", "product"], width - 6))
    cols, data = [], []
    amounts = []
    for j, k in enumerate(kinds):
        if k == "code":
            v = [f"{x:06d}" for x in rng.permutation(np.arange(1, 900000))[:n]]
        elif k == "date":
            start = np.datetime64("2021-01-01")
            v = [str(start + np.timedelta64(int(d), "D")) for d in np.sort(rng.integers(0, 1400, n))]
        elif k == "label":
            words = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"][: rng.integers(3, 6)]
            v = list(rng.choice(words, n))
        elif k == "amount":
            v = [round(float(x), 2) for x in np.exp(rng.normal(np.log(rng.uniform(50, 5000)), 0.35, n))]
            amounts.append(j)
        elif k == "reading":
            v = [round(float(x), 3) for x in rng.normal(rng.uniform(-40, 400), rng.uniform(0.5, 9), n)]
        elif k == "count":
            v = [int(x) for x in rng.poisson(rng.uniform(5, 60), n)]
        elif k == "sum":  # the sum of the two amounts before it, to the cent
            a, b = amounts[-2], amounts[-1]
            v = [round(data[a][i] + data[b][i], 2) for i in range(n)]
        else:  # product: a count of units times the first amount, to the cent
            units = [int(x) for x in rng.integers(1, 40, n)]
            cols.append(f"c{len(cols) + 1:02d}"); data.append(units)
            v = [round(units[i] * data[amounts[0]][i], 2) for i in range(n)]
        cols.append(f"c{len(cols) + 1:02d}"); data.append(v)
    rows = [[data[j][i] for j in range(len(cols))] for i in range(n)]
    pos = {k: kinds.index(k) for k in ("code", "date", "label", "sum")}
    sumc = pos["sum"] + sum(1 for k in kinds[:pos["sum"]] if k == "product")  # product kinds add a units column
    amt = [j for j, c in enumerate(cols) if j < sumc and isinstance(rows[0][j], float)][-1]
    code = pos["code"]; date = pos["date"]; label = pos["label"]
    picks = rng.choice(np.arange(5, n - 5), 8, replace=False)
    plants = {}
    i = picks[0]; rows[i][amt] = "see note"; plants[i] = "text in a number column"
    i = picks[1]; rows[i][label] = None; plants[i] = "blank in a filled column"
    i = picks[2]; rows[i][sumc] = "#REF!"; plants[i] = "Excel error"
    i = picks[3]; rows[i][sumc] = round(rows[i][sumc] + 900.0, 2); plants[i] = "total that does not add up"
    # a zero-led code ("004213") typed without its zeros: most random codes have none to lose, so start from one that does
    i = picks[4]; rows[i][code] = ("00" + rows[i][code][2:]).lstrip("0") or "0"; plants[i] = "code that lost its leading zeros"
    i = picks[5]; y, m, d = rows[i][date].split("-"); rows[i][date] = f"{int(d):02d}/{int(m):02d}/{y}"
    plants[i] = "date in another form"
    i = picks[6]; rows[i][label] = rows[i][label].lower(); plants[i] = "label typed in other capitals"
    i = picks[7]; rows[i] = list(rows[picks[7] - 1]); plants[i] = "duplicate row"
    return cols, rows, plants


CASES = [(kind, seed) for kind in ("ledger", "sensor") for seed in (78, 79, 80)]


@pytest.mark.parametrize("kind,seed", CASES)
@pytest.mark.parametrize("strength", [5, 10])
def test_any_schema_its_planted_mistakes_are_found_with_no_code_change(kind, seed, strength):
    cols, rows, plants = sheet(kind, seed)
    out = scan(cols, rows, strength=strength, fair=False)[1]
    missed = {i: what for i, what in plants.items() if out[i]["severity"] not in FLAG}
    assert not missed, {i: (what, out[i]["reason"]) for i, what in missed.items()}
    false = {i: r["reason"] for i, r in enumerate(out) if i not in plants and r["severity"] in FLAG}
    # level 10 is the strictest on purpose: it may call an honest top value of a column Medium (MEASURED in
    # frontend/constants: 3 of 2,724 fine bench rows). The default level calls none
    assert len(false) <= (0 if strength <= 5 else 0.01 * (len(rows) - len(plants))), false


@pytest.mark.parametrize("kind,seed", CASES)
def test_the_flags_do_not_depend_on_what_the_headers_say(kind, seed):
    cols, rows, _ = sheet(kind, seed)
    other = [f"v{j + 1:02d}" for j in range(len(cols))]
    a = scan(cols, rows, fair=False)[1]
    b = scan(other, rows, fair=False)[1]
    rename = dict(zip(cols, other))
    assert [r["severity"] for r in a] == [r["severity"] for r in b]
    assert [[rename[c] for c in r["cells"]] for r in a] == [r["cells"] for r in b]


@pytest.mark.parametrize("kind,seed", CASES)
def test_each_columns_limits_come_from_its_own_values_and_scale_with_them(kind, seed):
    cols, rows, _ = sheet(kind, seed)
    j = next(j for j, v in enumerate(rows[0]) if isinstance(v, float) and all(isinstance(r[j], float) for r in rows)
             and all(r[j] > 0 for r in rows))
    base = scan(cols, rows, fair=False)
    scaled_rows = [list(r) for r in rows]
    for r in scaled_rows:
        r[j] = r[j] * 1000
    scaled = scan(cols, scaled_rows, fair=False)
    lo, hi = base[2][cols[j]][2], base[2][cols[j]][3]
    slo, shi = scaled[2][cols[j]][2], scaled[2][cols[j]][3]
    assert slo == pytest.approx(lo * 1000, rel=0.02) and shi == pytest.approx(hi * 1000, rel=0.02), (lo, hi, slo, shi)
    for k, c in enumerate(cols):  # every other column keeps the limits it had: each is judged alone
        if k != j and c in base[2]:
            assert scaled[2][c] == base[2][c]
