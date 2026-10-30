"""AH-76 (chaos audit, 2026-10-30): an HR sheet's HireDate written "YYYY-MM-DD", one cell typed "31/12/2023". It was read as
2023-12-31 without a word, though a date typed in another form is read by guessing its order (03/04/2024 is April 3rd in
London, March 4th in New York). A number in the same column (45292) was flagged, but as 'Text "45292"', with nothing
said about the Excel date serial it may be. Synthetic sheets only."""
import numpy as np
import pytest

from anomaly_hunter.engine.load import load_from_records
from anomaly_hunter.server import create_app

APP = create_app().test_client()


def scan(cols, rows, strength=5):
    r = APP.post("/scan", json={"columns": cols, "rows": rows, "strength": strength})
    assert r.status_code == 200
    return r.get_json()["rows"]


def hr(n=55, form=lambda y, m, d: f"{y}-{m:02d}-{d:02d}"):
    rng = np.random.default_rng(5)
    cols = ["EmployeeID", "Name", "Department", "Salary", "HireDate"]
    rows = [[f"E{101 + i}", f"Person {i}", ["Sales", "Ops", "IT"][i % 3], int(50000 + rng.integers(0, 20000)),
             form(2015 + i % 9, 1 + i % 12, 1 + i % 28)] for i in range(n)]
    return cols, rows


def about(got, col="HireDate"):
    return [i for i, r in enumerate(got) if col in r.get("cells", [])]


@pytest.mark.parametrize("strength", [5, 10])
def test_a_date_typed_in_another_form_is_flagged_never_silently_converted(strength):
    cols, rows = hr()
    rows[30][4] = "31/12/2023"
    got = scan(cols, rows, strength)
    assert 'HireDate "31/12/2023" is written day-first where the column writes YYYY-MM-DD (read as 2023-12-31)' in got[30]["reason"]
    assert got[30]["severity"] == "Medium" and got[30]["cells"] == ["HireDate"] and about(got) == [30]
    assert "HireDate" not in got[30].get("likely", {}) and "HireDate" not in got[30].get("maybe", {})
    assert got[30]["reason"].count("HireDate") == 1  # one sentence for the cell, never a second about its text


def test_a_date_whose_day_and_month_could_swap_names_both_readings():
    cols, rows = hr()
    rows[12][4] = "03/04/2024"
    got = scan(cols, rows)
    assert 'HireDate "03/04/2024" is written with the year last where the column writes YYYY-MM-DD: it could be ' \
           '2024-04-03 or 2024-03-04' in got[12]["reason"]
    assert got[12]["severity"] == "Medium" and about(got) == [12]


def test_a_column_that_mixes_day_first_and_month_first_flags_the_minority():
    # a day-first column (13/01 and up) with two month-first dates pasted in from a US export (01/13 and up)
    cols, rows = hr(form=lambda y, m, d: f"{d:02d}/{m:02d}/{y}")
    rows[8][4], rows[40][4] = "12/25/2021", "06/30/2019"
    df, types, errors = load_from_records(cols, rows)
    assert types["HireDate"] == "date" and not errors
    # the column reads day-first, as most of its dates must be read: 03/07/2018 is the 3rd of July
    assert rows[30][4] == "03/07/2018" and df["HireDate"][30].strftime("%Y-%m-%d") == "2018-07-03" and df["HireDate"][8].strftime("%Y-%m-%d") == "2021-12-25"
    got = scan(cols, rows)
    for i, read in ((8, "2021-12-25"), (40, "2019-06-30")):
        r = got[i]["reason"]
        assert f'HireDate "{rows[i][4]}" is written month-first where ' in r and "of the column's dates can only be day-first" in r
        assert r.endswith(f"(read as {read})") and r.count("HireDate") == 1 and got[i]["severity"] == "Medium"
    assert about(got) == [8, 40]


@pytest.mark.parametrize("form", [lambda y, m, d: f"{y}-{m:02d}-{d:02d}", lambda y, m, d: f"{d:02d}/{m:02d}/{y}",
                                  lambda y, m, d: f"{m}/{d}/{y}", lambda y, m, d: f"{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} {d}, {y}",
                                  lambda y, m, d: f"{y}-{m:02d}-{d:02d} {8 + d % 9:02d}:30:00",
                                  lambda y, m, d: f"{y}-{m:02d}-{d:02d}" if d % 3 else f"{y}-{m:02d}-{d:02d} 00:00:00"],
                         ids=["iso", "day-first", "month-first", "month name", "pane date-time", "pane date and date-time"])
def test_a_column_written_in_one_form_flags_nothing_new(form):
    for strength in (5, 10):
        got = scan(*hr(form=form), strength)
        assert about(got) == [], [got[i]["reason"] for i in about(got)]


def test_a_column_of_many_forms_is_one_note_not_a_flag_a_row():
    forms = [lambda y, m, d: f"{y}-{m:02d}-{d:02d}", lambda y, m, d: f"{d:02d}/{m:02d}/{y}", lambda y, m, d: f"{d:02d}.{m:02d}.{y}"]
    cols, rows = hr()
    for i, r in enumerate(rows):  # three exports pasted together, each in its own form
        r[4] = forms[i % 3](2015 + i % 9, 1 + i % 12, 13 + i % 15)
    got = scan(cols, rows)
    noted = about(got)
    assert len(noted) == 1 and got[noted[0]]["severity"] == "Low"
    assert "HireDate writes its dates in 3 forms: " in got[noted[0]]["reason"]


def test_a_number_in_a_date_column_names_the_excel_date_it_may_be():
    cols, rows = hr()
    rows[20][4], rows[21][4] = 45292, 45292.5
    got = scan(cols, rows)
    assert 'HireDate 45292 is a number in a column of dates (an Excel date serial for 2024-01-01?)' in got[20]["reason"]
    assert got[20]["severity"] == "Medium" and not got[20].get("likely") and not got[20].get("maybe")
    assert 'Text "45292.5" in date column HireDate' in got[21]["reason"]  # a serial is a whole day; a fraction is a time
    # Excel's 1900 date system: serial 1 is 1900-01-01, and it counts a 1900-02-29 that never was
    for serial, day in ((1, "1900-01-01"), (59, "1900-02-28"), (61, "1900-03-01"), (2958465, "9999-12-31")):
        rows[20][4] = serial
        assert f"(an Excel date serial for {day}?)" in scan(cols, rows)[20]["reason"]
