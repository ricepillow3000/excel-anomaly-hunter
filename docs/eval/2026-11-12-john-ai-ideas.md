# John's ideas for accurate AI on any topic, checked against Arcas (AH-161, 2026-11-12)

John asked (2026-11-12) what we think of eleven ideas for accurate, reliable AI on any spreadsheet topic. Each is
mapped below to what Arcas already does, with the file that holds it. The two that change what the AI is asked were
measured with `backend/bench/ai_eval.py` before any decision (CLAUDE.md: no eval run, no prompt change).

## Verdict per idea

| # | Idea | Arcas today | Verdict |
|---|---|---|---|
| 1 | Send lightweight schema context (headers, types, 5-10 sample rows) and let the AI infer the sheet's field first | Every request carries every shown header, the flagged row and up to 5 rows above and below it, and tells the AI to infer the field from them (`ai/client.py` `_fix_prompt`). A separate "classify the sheet" call would double the calls: the free tier is 15 a day per network, so users would get 7 fixes instead of 15 | Measured as arm `schema` (one line describing every shown column over the whole sheet): **worse**, 2 wins vs 5 losses on dev. Not adopted |
| 2 | Preserve domain terms (jargon, SKU codes, proper nouns, currency formats) | The scan already never rewrites codes it recognises (leading zeros kept as typed, person names never guessed, `engine/load.py`, `pipeline.spellings`); the AI prompt had no such rule | Measured as arm `keep_terms` (one rule sentence): see below. **Not switched on yet**: it did not clear the quality bar |
| 3 | Strict JSON schema output | Already: `response_format: json_schema` with `FIX_SCHEMA` (`ai/client.py:244`), parsed by pydantic, and the relay refuses a request without it (`relay/worker.js`). Cells are addressed by A1 name, each checked to be inside the table, shown to the AI and in the flagged row | Already built |
| 4 | Highlight changes instead of silent overwrites, with a summary and undo | Stronger than asked: nothing the AI says is written until the user presses Accept on a card showing old to new; Undo is kept in the workbook and outlives a reload (`frontend/features/undo-store.js`); the explanation names every change left out and why | Already built |
| 5 | A fixed golden dataset of tricky rows re-run on every prompt change | Several: the industry bench (51 sheets) and the blind 14-domain bench run in CI on every push (`backend/bench/score.py`); the Chaos Dataset and the any-schema proof (`test_chaos_dataset.py`, `test_schema_agnostic.py`); the AI eval's 134 dev and 103 held-out cases with known answers, including prompt-injection cells (`ai_eval.py`) | Already built |
| 6 | Never put the Gemini key in the client; keep it on a small backend that proxies | Already: the key lives only in John's Cloudflare Worker (`relay/`), a secret set with wrangler; the downloaded app never holds it, and a test reads the whole git history for keys (`tools/secret_history.py`). A FastAPI server on Railway or Cloud Run would cost money and add a server that sees user data; the Worker is free and stores no request | Already built (free, smaller) |
| 7 | Send only the selected range or needed columns; store nothing in logs or databases | Already: one flagged row plus up to 5 rows around it, the columns nearest the flagged one first, within 7,000 bytes (`BUDGET`, `client.py:250`); a cell over 200 characters is cut. The relay stores no request; it counts uses under a keyed hash of the day and network, never the IP. The PC keeps answers only, never prompts | Already built |
| 8 | Validate AI-generated formulas so unwanted functions never run | Already: an allowlist of safe functions (`SAFE`, `client.py:110`), anything reaching outside the workbook refused (`OUTSIDE`, `:106`), bare names that Excel 365 would run as a LAMBDA refused (AH-150), a full-width `＝` read as `=`; AH-160 closed a quote-in-a-sheet-name trick | Already built, tightened in AH-160 |
| 9 | Rate limits and token caps on the hosted key | Already: 15 a day per network, 45 per IPv6 /48, 400 a day for everyone, 15 a minute per network (`relay/wrangler.toml`), 8 KB a request, 4,096 answer tokens, 50 cells a fix (`MAX_CHANGES`), one row per click | Already built |
| 10 | Flash for bulk work, a heavier model only for complex formulas | Already Flash: gemini-3.8-flash with your own key, gemini-3.5-flash-lite on the free tier, each with the other as a backup when one is busy (AH-145). A heavier model has little or no free quota, and a route by task would need its own eval (`--model`) | Already built; routing not worth it on the free tier |
| 11 | Hosted key as default, optional own key field | Already: the free AI is on for everyone with no key (AH-151); Options, AI help takes your own free Google key | Already built |

## The two measured ideas

Model gemini-3.5-flash-lite (the free tier's), John's own Google key (never the relay), 3 runs on the 134 dev cases;
base's answers are the AH-153 runs of the same requests, byte for byte. Paired = the majority of runs per case.

| Arm | Right of 134 | Paired vs base | Bar (W-L) | Invented after the checks, 3 runs | Extra cells written, 3 runs | Injection obeyed |
|---|---|---|---|---|---|---|
| base (today) | 94 | | | 49 | 64 | 0 |
| keep_terms | 96 | W5 L3 | 5.7 | 32 | 46 | 0 |
| schema (1 run) | 91 | W2 L5 | 5.3 | 13 (1 run, base about 16) | 21 (1 run, base about 21) | 0 |
| schema_keep (1 run) | 90 | W3 L7 | 6.3 | 6 (1 run) | 3 (1 run) | 0 |

- `schema` and `schema_keep` lost more cases than they won on one run, so they were not run further.
- `keep_terms` is right 2 more times and invents a value a third less often (32 vs 49), but W-L is 2 against a bar
  of 5.7, so by the rule it stays off. It is the strongest candidate so far. Next step: more dev cases where a code
  or a name sits beside the flagged cell (the dev set has few), then dev and held-out again.
- The held-out split was not spent: no arm passed on dev, so held-out could not switch one on.

How to repeat: `python backend/bench/ai_eval.py . --yes --model gemini-3.5-flash-lite --split dev --arms
base,keep_terms --runs 3` with your own `GEMINI_API_KEY`.
