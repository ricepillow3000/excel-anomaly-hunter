# Council Paper 4 (revised): Data Formatting and Payload Validation for Large Excel Data

## Abstract
This paper looks at how the localhost Flask engine and the Cloudflare relay accept, size-limit, validate and write out spreadsheet data. I re-read the code and ran in-process probes with the project's .venv (pandas 3.0.6). No files were edited and the live relay was not called. Every claim is checked against Flask, Werkzeug, OWASP, MDN, Cloudflare, pandas and Python docs that I opened this session.

After the debate there are four engine gaps left, all in `server.py` and all a few lines each:
1. No body-size cap.
2. The 2M-cell limit is only enforced in the pane.
3. CSV formula injection in `latest-scan.csv`.
4. **New this round:** a cell holding a lone UTF-16 surrogate turns a successful scan into a 500 when the Power BI CSV is on.

I dropped my two relay and AI-budget items. One concedes to the other experts. The other turned out to add a crash.

## Current state (verified)
- **Content-type and body shape are checked.** Every POST route calls `get_json(silent=True)`, and `_bad` turns a missing or wrong body into a 400 (server.py:43-68). The per-route checks are in place, and Schemathesis runs `negative_data_rejection` and `status_code_conformance` (test_fuzz_api.py:43-44).
- **AI requests are JSON with `ensure_ascii=True`** (client.py:228). Python documents that this "guaranteed to have all incoming non-ASCII and non-printable characters escaped". So the 7000-byte budget is also the UTF-16 length the relay measures.
- **report.xlsx is protected; the CSV is not.** report.xlsx turns formulas back into text. The CSV writes cells unchanged (server.py:119-122). The probe wrote `=cmd|' /C calc'!A0` and `@SUM(1+1)` as-is.
- **The fuzz suite never exercises the CSV path.** It builds `create_app()` with no CSV file (test_fuzz_api.py:19), so the CSV-writing code never runs under fuzzing.

## Findings
**F1. No body cap (GAP).** Flask's `MAX_CONTENT_LENGTH` defaults to `None`, meaning "no limit is enforced at the Flask application level"; my probe confirms it is `None` here. Werkzeug says `get_data` "is only safe to do if the max_content_length is set". OWASP API4 asks for a "maximum size of data on all incoming parameters and payloads". With a lowered cap, the probe returned `413 application/json` through the existing handler.

**F2. The cell cap is client-only (GAP).** `maxCells()` (sheet.js:3) runs in the pane only. OWASP says "Client-side validation is bypassable" and to "Validate on the server even when the browser checks the same fields". OWASP API4 also asks for a "maximum number of elements in arrays".

**F3. CSV injection (GAP).** OWASP lists `=`, `+`, `-`, `@`, tab, CR, **LF** and **full-width `＝＋－＠`** as dangerous leading characters. My draft missed LF and the full-width forms. The fix is to prefix a single quote. In the probe, a prefix applied only to strings left the number `-5` untouched and produced `'=cmd|x` and `'＝SUM(1)`.

**F4. A lone surrogate crashes the CSV write (GAP, new).** I posted `"ab\ud800"`, which is valid JSON, to `/scan`:
- With the CSV on (as in the real run, server.py:319), the scan returned **500**.
- With the CSV off, it returned **200**.

`to_csv(..., encoding="utf-8-sig")` raises `UnicodeEncodeError`. That is not an `OSError`, so the `except OSError` at server.py:124 never catches it. The scan's own answer is lost, and a `.tmp` file may be left behind.

The fix is pandas' `errors` argument ("Specifies how encoding and decoding errors are to be handled"). With `errors="replace"`, the probe wrote `ab?` and no crash. UNVERIFIED: whether Excel itself ever hands Office.js a lone surrogate. Any local caller or crafted workbook can.

## Debate
- **vs Security (SEC-11, "reject MAX_CONTENT_LENGTH").** I disagree. The argument that a cap "would risk breaking real large sheets" does not apply to 256 MB: a measured 2M-cell, 10-column sheet is 20.6 MB of JSON, so that leaves about 12x headroom. The origin gate does stop browsers, but the remaining callers (a buggy pane build, local tools, the CLI) should get a clean 413, not a swapped-out engine. Werkzeug itself makes the cap a precondition for `get_data` being safe. It is one line. I agree with SEC-8 and against QA-G5: Semgrep `p/secrets` already runs in CI (security.yml:33).
- **vs Reverse Proxy (R2-14) and QA (QA-R6).** I concede. Auth runs before the body is read (worker.js:24-27), the body is capped at 100 MB by the platform, and the daily caps bound abuse. My relay byte-count item is now REJECT.

  I do challenge **R2-1**. Cloudflare's fetch page documents only `cache` in the options, and the web-standards page does not say that `fetch` honours `signal`. So the AbortController half rests on something unverified. Ship the try/catch half first: it is the same as QA-F2 and can be tested with a stub in test.mjs. Add the timeout only after `wrangler dev` shows it works. The relay's abort time must also stay below the client's 90 s timeout (client.py:238).
- **vs Rate Limits (RL-1).** RL-1 relies on `toLocaleDateString(..., {timeZone})`. Cloudflare's web-standards page lists Intl but says nothing about timeZone support. SEC-1/R2-2's fixed UTC-8 offset needs no unverified API and errs toward resetting late. Prefer it. Four experts filed the same fix; Topic 3 should own it.
- **vs QA (QA-R3).** This is the same rebuttal as SEC-11. QA should also note that its own fuzz harness builds the app without the CSV (test_fuzz_api.py:19), which is why F4 went unseen. The new test needs the CSV on. **QA-F3** conflicts with R2-1. If the relay aborts at 75 s, raising the client timeout above 90 s does not change any result. Pick one owner.
- **Self-corrections.**
  - My optional `ensure_ascii=False` item is **withdrawn**. The probe shows `json.dumps('\ud800', ensure_ascii=False).encode()` raises `UnicodeEncodeError`, so it would add a crash path to every AI call. The ASCII escaping is a guard, not waste.
  - My CSV trigger set was incomplete (F3).

## Recommendations (smallest changes)
1. **server.py `create_app`:** set `app.config["MAX_CONTENT_LENGTH"] = 256 * 1024 * 1024`. Optionally add `"413"` to the POST responses in openapi.yaml. Add one test.
2. **server.py `_bad`:** set `MAX_CELLS = 2_000_000`, and return a 400 when `len(rows) * len(columns) > MAX_CELLS`. Add one test.
3. **server.py:119-122:** prefix `'` on string cells and headers that start with any OWASP trigger, and add `errors="replace"` to `to_csv`. Run one test with the CSV enabled.

## References
- https://flask.palletsprojects.com/en/stable/config/
- https://werkzeug.palletsprojects.com/en/stable/request_data/
- https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption
- https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- https://community.owasp.org/attacks/CSV_Injection
- https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.to_csv.html
- https://docs.python.org/3/library/json.html
- https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/length
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/runtime-apis/web-standards/
- https://developers.cloudflare.com/workers/runtime-apis/fetch/
