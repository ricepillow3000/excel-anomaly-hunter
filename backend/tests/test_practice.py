"""The installer's "Start here" workbook: the steps are what the user reads first, and the Practice sheet really has
the 5 problems the steps promise - found by a scan, nothing else flagged."""
import openpyxl

from anomaly_hunter import practice
from anomaly_hunter.agents import scan_agent


def test_start_here_opens_on_the_steps_and_practice_has_exactly_the_promised_problems(tmp_path):
    wb = openpyxl.load_workbook(practice.make(tmp_path / "Start here.xlsx"))
    assert wb.sheetnames == ["Start here", "Practice"] and wb.active.title == "Start here"
    steps = [c.value for c in wb["Start here"]["A"] if c.value]
    assert any("SHARED FOLDER" in s for s in steps) and any("Find problems" in s for s in steps)
    grid = [list(r) for r in wb["Practice"].iter_rows(values_only=True)]
    out = scan_agent.scan(grid[0], [[("" if v is None else v) for v in r] for r in grid[1:]])[1]
    assert {i + 2 for i, r in enumerate(out) if r["severity"] in ("High", "Medium", "Low")} == set(practice.PLANTED)
