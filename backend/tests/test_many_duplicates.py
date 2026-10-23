"""AH-48 (blind round 36): a hotel bookings table with no ID column has 4,324 rows that repeat an earlier row exactly -
two bookings with the same hotel, dates, guests and rate - and each was a Medium "Duplicate of row N". Like blanks spread
through a sheet (AH-28), max(20, 1% of the rows) repeats found in every fifth of the sheet are one note: how many, and
where the first is. A few, or a block of them (a range pasted twice), are still each a slip. Synthetic sheets only."""
import numpy as np
import pytest

from anomaly_hunter.agents.scan_agent import scan

COLS = ["hotel", "arrival_month", "adults", "children", "meal", "adr"]


def bookings(n=3000, seed=6):
    rng = np.random.default_rng(seed)
    return [[["City Hotel", "Resort Hotel"][int(rng.integers(0, 2))], int(rng.integers(1, 13)), int(rng.integers(1, 4)),
             int(rng.integers(0, 3)), ["BB", "HB", "SC"][int(rng.integers(0, 3))], round(float(rng.uniform(40, 260)), 3)]
            for _ in range(n)]


def flagged(out, word):
    return [i for i, o in enumerate(out) if o["severity"] in ("Low", "Medium", "High") and word in o["reason"]]


def test_many_repeated_rows_through_a_sheet_with_no_id_are_one_note():
    rows, rng = bookings(), np.random.default_rng(7)
    copies = sorted(rng.choice(np.arange(10, 3000), 600, replace=False))
    for i in copies:
        rows[i] = list(rows[int(rng.integers(0, i))])
    out = scan(COLS, rows, fair=False)[1]
    assert not flagged(out, "Duplicate of row"), len(flagged(out, "Duplicate of row"))
    noted = flagged(out, "repeat an earlier row")
    assert len(noted) == 1 and out[noted[0]]["severity"] == "Low", [out[i]["reason"] for i in noted[:3]]
    first = noted[0]
    assert out[first]["reason"].startswith(f"{len(copies)} of 3000 rows repeat an earlier row exactly, all through the sheet - "
                                           f"the first is this one, a copy of row "), out[first]["reason"]


def test_a_few_repeated_rows_are_still_each_a_slip():
    rows = bookings()
    for i in (400, 1200, 2100, 2800, 2950):
        rows[i] = list(rows[i - 300])
    out = scan(COLS, rows, fair=False)[1]
    assert flagged(out, "Duplicate of row") == [400, 1200, 2100, 2800, 2950]
    assert all(out[i]["severity"] == "Medium" for i in (400, 1200, 2100, 2800, 2950))


def test_a_block_pasted_twice_is_still_each_a_slip():
    rows = bookings()
    rows[1000:1100] = [list(r) for r in rows[900:1000]]  # a range pasted again below itself
    out = scan(COLS, rows, fair=False)[1]
    assert flagged(out, "Duplicate of row") == list(range(1000, 1100))


def test_the_note_colours_its_whole_row():
    rows, rng = bookings(), np.random.default_rng(7)
    for i in sorted(rng.choice(np.arange(10, 3000), 600, replace=False)):
        rows[i] = list(rows[int(rng.integers(0, i))])
    out = scan(COLS, rows, fair=False)[1]
    noted = [o for o in out if "repeat an earlier row" in o["reason"]]
    assert len(noted) == 1 and noted[0]["cells"] == COLS, noted


def orders(text_id):
    rng = np.random.default_rng(5)
    rows = [[f"INV-{50001 + i}" if text_id else 50001 + i, f"2025-{1 + i // 250:02d}-{1 + i // 10 % 25:02d}", f"C{int(rng.integers(1, 400))}",
             round(float(rng.uniform(5, 900)), 2)] for i in range(3000)]
    again = [list(r) for k, r in enumerate(rows) if k // 10 % 25 == 3]  # 12 days' orders imported twice
    return sorted(rows + again, key=lambda r: (r[1], str(r[0]))), len(again)


@pytest.mark.parametrize("text_id", [False, True])
def test_orders_imported_twice_are_each_a_slip_when_an_id_tells_records_apart(text_id):
    # AH-48 review: 120 orders imported twice, sorted by date, so the copies sat all through the sheet, were one note
    # saying "nothing like an ID tells them apart" - beside an Order ID column no two different orders share
    rows, copies = orders(text_id)
    out = scan(["Order ID", "Order date", "Customer", "Amount"], rows, fair=False)[1]
    assert len(flagged(out, "Duplicate of row")) == copies and not flagged(out, "repeat an earlier row")


def test_ranges_pasted_again_in_every_fifth_of_the_sheet_are_each_a_slip():
    # AH-48 review: 5 ranges of 12 rows, each pasted below itself, one in each fifth: 60 copies, one note
    rows = bookings()
    for k in range(5):
        s = 300 + 600 * k
        rows[s + 12:s + 24] = [list(r) for r in rows[s:s + 12]]
    out = scan(COLS, rows, fair=False)[1]
    assert set(range(312, 324)) <= set(flagged(out, "Duplicate of row")) and not flagged(out, "repeat an earlier row")


def test_real_bookings_repeated_in_pairs_stay_in_the_note():
    # round 36's hotel table repeats real bookings in pairs (A B A B: 65 runs of 2), never in runs of 5
    rows, rng = bookings(), np.random.default_rng(8)
    for i in sorted(rng.choice(np.arange(10, 2990, 6), 300, replace=False)):
        rows[i + 2], rows[i + 3] = list(rows[i]), list(rows[i + 1])
    out = scan(COLS, rows, fair=False)[1]
    assert not flagged(out, "Duplicate of row") and len(flagged(out, "repeat an earlier row")) == 1
