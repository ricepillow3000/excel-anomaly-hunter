"""AH-52: dateutil reads a long run of digits in quadratic time, and the loader asks it to parse every text cell of a
column as a date: one 400,000-digit cell took 13 s of a 16 s scan (AH-32 review's long-input probe). A cell longer than
any date (64 characters) is never parsed as one. Synthetic cells only."""
import time

import pandas as pd
import pytest

from anomaly_hunter.agents.scan_agent import scan
from anomaly_hunter.engine.load import _kind


@pytest.mark.parametrize("cell", ["7" * 400_000, "12-" * 133_000, "1/" * 200_000, " " * 400_000, " " * 200 + "7" * 400_000 + " " * 200,
                                  " " * 400_000 + "2024-03-05"],
                         ids=["digits", "digits and dashes", "1/1/1", "spaces", "digits padded", "a date after 400k spaces"])
@pytest.mark.parametrize("column", ["text", "dates"])
def test_a_crafted_long_cell_scans_in_under_a_second(cell, column):
    rows = [[f"R{i}", f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}" if column == "dates" else ["North", "South"][i % 2], i] for i in range(60)]
    rows[5][1] = cell
    t = time.perf_counter()
    scan(["Id", "Value", "n"], rows, fair=False)
    assert time.perf_counter() - t < 1.0


def test_a_date_with_a_long_timestamp_is_still_a_date():
    # the longest honest dates: an ISO timestamp with nanoseconds and a zone, a weekday written out
    rows = [[f"R{i}", f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}T08:30:00.123456789+02:00" if i % 2 else
             f"Wednesday, September {1 + i % 28}, 2024 08:30:00 PM", i] for i in range(60)]
    assert _kind(pd.Series([r[1] for r in rows], name="When")) == "date"


def test_a_date_column_padded_to_a_fixed_width_stays_a_date():
    # AH-52 review (Council A): a fixed-width export pads "2024-01-05" with 70 spaces to its 80-character field; the cap
    # measured the padding and the column became text, losing its far-date and series checks
    cells = [f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}".ljust(80) for i in range(200)]
    assert _kind(pd.Series(cells, name="Shipped")) == "date"


def test_a_date_before_1900_padded_to_a_fixed_width_is_still_read_for_the_far_date_check():
    rows = [[f"P{i}", f"{1850 + i % 40}-{1 + i % 12:02d}-{1 + i % 28:02d}".ljust(60), i] for i in range(200)]
    rows[30][1] = "2862-06-07".ljust(60)
    out = scan(["Person", "born", "n"], rows, fair=False)[1]
    assert "is far outside the column's dates" in out[30]["reason"], out[30]["reason"]
