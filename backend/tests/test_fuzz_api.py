"""Schemathesis attacks every route with generated input, valid and invalid, from backend/openapi.yaml.
No input may crash the engine (5xx), get an undocumented answer, or slip past the checks (invalid input must be refused).
More examples / another seed: FUZZ_EXAMPLES=500 pytest backend/tests/test_fuzz_api.py --hypothesis-seed=7"""
import os
from pathlib import Path

import pytest
import schemathesis
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from schemathesis.checks import not_a_server_error
from schemathesis.specs.openapi.checks import (content_type_conformance, negative_data_rejection,
                                               response_schema_conformance, status_code_conformance)

from anomaly_hunter.ai import client
from anomaly_hunter.server import create_app

SPEC = Path(__file__).resolve().parents[1] / "openapi.yaml"
APP = create_app()
schema = schemathesis.openapi.from_path(SPEC)
schema.app = APP  # in-process: no network, no real server, no real key


def test_the_spec_lists_every_route():
    """A new route must be added to openapi.yaml, or the attack tools would never reach it."""
    raw = schema.raw_schema["paths"]
    spec = {(p, m.upper()) for p, ops in raw.items() for m in ops}
    real = {(r.rule, m) for r in APP.url_map.iter_rules() if r.endpoint != "static" for m in r.methods - {"HEAD", "OPTIONS"}}
    assert spec == real


@schema.parametrize()
@pytest.mark.filterwarnings("error::RuntimeWarning")  # odd maths (mean of nothing, overflow) surfaces as a 500 the fuzzer reports
@settings(max_examples=int(os.environ.get("FUZZ_EXAMPLES", 40)), deadline=None, suppress_health_check=list(HealthCheck))
def test_no_input_breaks_the_engine(case, monkeypatch):
    # AI calls are stubbed: this attacks the engine's own input handling, never Google, and spends no quota
    monkeypatch.setattr(client, "check_key", lambda key: (True, "Key works."))
    monkeypatch.setattr(client, "api_key_configured", lambda: True)
    monkeypatch.setattr(client, "suggest_fix", lambda *a, **k: {"explanation": "stub", "changes": []})
    monkeypatch.setattr(client, "odd_text", lambda values: ([{"column": c, "value": v[0], "why": "stub"} for c, v in values.items()], False))
    response = case.call()
    assert response.status_code != 403, "the origin gate refused the attack - it would test nothing"
    case.validate_response(response, checks=[not_a_server_error, status_code_conformance, content_type_conformance,
                                             response_schema_conformance, negative_data_rejection])


# Each body here once crashed or fooled the engine when the fuzzer found it; it must stay a clean 400.
FOUND = [
    ("/check", {"columns": [0.0], "rows": [[None]], "row_index": 0, "changes": [{"col": 0}]}),  # change with no value: 500
]


def test_what_the_fuzzer_found_stays_fixed():
    c = APP.test_client()
    for path, body in FOUND:
        r = c.post(path, json=body)
        assert r.status_code == 400 and "error" in r.get_json(), (path, body, r.status_code)


# Random bodies rarely give every row exactly as many cells as there are columns, so most are refused before they
# reach the engine. This attack always sends well-formed sheets with nasty cells, through all three engine routes.
CELL = st.one_of(st.none(), st.booleans(), st.integers(-10**15, 10**15), st.floats(allow_nan=False, allow_infinity=False),
                 st.text(max_size=12), st.sampled_from(["", " ", "1,234", "$5", "12%", "(7)", "2024-01-31", "31/12/2024",
                                                        "Total", "N/A", "=SUM(A1:A3)", "-0", "1e5", "0x1F", " "]))


@st.composite
def sheets(draw):
    width = draw(st.integers(1, 5))
    columns = draw(st.lists(st.one_of(st.text(max_size=8), st.integers(0, 99)), min_size=width, max_size=width))
    return columns, draw(st.lists(st.lists(CELL, min_size=width, max_size=width), max_size=40))


@pytest.mark.filterwarnings("error::RuntimeWarning")
@settings(max_examples=int(os.environ.get("FUZZ_EXAMPLES", 40)), deadline=None, suppress_health_check=list(HealthCheck))
@given(sheets(), st.integers(0, 10), st.data())
def test_any_well_formed_sheet_scans_checks_and_suggests(sheet, strength, data):
    columns, rows = sheet
    c, base = APP.test_client(), {"columns": columns, "rows": rows, "strength": strength}
    r = c.post("/scan", json=base)
    assert r.status_code == 200, r.get_json()
    if rows:
        i, col = data.draw(st.integers(0, len(rows) - 1)), data.draw(st.integers(0, len(columns) - 1))
        r = c.post("/check", json={**base, "row_index": i, "changes": [{"col": col, "value": data.draw(CELL)}]})
        assert r.status_code == 200, r.get_json()
        r = c.post("/suggest", json={**base, "row_index": i, "column": str(columns[col])})
        assert r.status_code == 200, r.get_json()
