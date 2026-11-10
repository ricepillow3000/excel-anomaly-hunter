# Pre-launch evaluation, 2026-11-10 (AH-150)

For every agent who changes Arcas before the 13 December launch. What was checked, what was found, what was fixed,
the test that now holds each fix, and what is still open. Pod 2 (backend); Pod 1 holds the pane's and the website's
design (AH-148, AH-149).

## What John asked for (2026-11-09)

- The scan reads what the user is handling and highlights it for consistency, never redirecting their intent.
  Its claim is solving data fatigue, with error checking and formula checking beside it.
- Ask AI follows the rules in CLAUDE.md layer 9.
- A free AI of ours is plugged in for every user, their own key optional, with no trace of the API a user could
  exploit: everything back end, only John can see it.
- Ask AI demonstrates retrieval, post-retrieval and API pulling, for employers reading the project.
- Security first, then accuracy, then convenience. Ready to deploy, not deployed before 13 December.

## How it was checked

1. The full gate on main (d7c4889) as a baseline: 11 of 13 layers green; the 2 red ones were the machine (port 5055
   taken by a builder's e2e, a website click timing out with six builders running), green again on a quiet run.
2. Three read-only Researchers, each citing file:line: the free AI and every secret trace (712 tracked files); every
   Ask AI rule against its code and its test; the scan's promise (writes, determinism, formulas, fatigue).
3. A determinism run: 3 synthetic sheets with 15 planted errors scanned in fresh processes under 3 hash seeds:
   byte-identical output. Rows shuffled: same cells and reasons (only which copy of a duplicate is flagged moves, by
   design). Columns renamed: the header-word checks (Month 13, Rating 6) go quiet as documented, and a total under
   "Budget" was missed: finding A3.
4. Six Builders in separate worktrees, each fix test-first (the test seen red on the old code, then green).

The live website could not be reached from the cloud sandbox (github.io is blocked by its network policy); the site's
own files, which are what Pages publishes, are checked by `tools/test_site.mjs`.

## Findings and fixes

Severity: S = security, A = accuracy, C = convenience. Every row is fixed on branch `claude/lucid-sagan-yqmifw` unless
it says otherwise.

| # | Finding | Fix | Held by |
|---|---|---|---|
| S1 | The AI formula SAFE list saw only `NAME(` calls. Excel 365 calls a bare name as a LAMBDA, so `=MAP(A2,IMAGE)`, `=BYROW(...,IMPORTCSV)`, `=MAP(A2,STOCKHISTORY)`, `=REDUCE(0,A2,COPILOT)`, `=MAP(...,INDIRECT)` reached the workbook after Accept | Every name in an AI formula is checked: SAFE, a cell, range, table, sheet, or its own LET/LAMBDA name in scope; anything else is refused | `test_an_ai_formula_using_a_function_not_on_the_safe_list_is_left_out`, `test_a_formula_from_the_ai_may_name_cells_tables_sheets_and_its_own_let_and_lambda_names` |
| S2 | The care message missed a self-harm phrase with a zero-width character in it (`kill​myself`) | Invisible format characters are read both as nothing and as a space | `test_words_of_someone_in_crisis_with_invisible_characters_in_them_are_still_recognised` |
| S3 | The relay's `error` went to the pane as it came: a dict crashed, any length and line and key went on the card | One line, at most 200 characters, every secret blanked, our own words when not text | `test_a_relay_error_that_is_not_text_is_said_in_our_own_words`, `test_the_relays_words_reach_the_user_as_one_short_line_with_no_invite_code_in_it` |
| S4 | No secret leak found: every key-shaped string in the repo is a test fake; no debug route; server.log blanks secrets; the relay never forwards Google's error text | Nothing to fix | `tools/secret_history.py`, `test_api_security.py` |
| F1 | No free AI: a new user had no Ask AI until they pasted a key or an invite (`client.provider()` returned None) | AH-151: a request to the relay with no Authorization header is the public tier: gemini-3.5-flash-lite chosen by the relay, 15 a day per network (an IPv6 address by its /64) and 400 a day in total, counted before Google under HMAC-SHA-256(Google key, day + network) so no IP is stored; the engine falls back to it when nothing is set; the pane says AI help is on; the privacy twins say where it goes | `relay/test.mjs` public-tier block, `test_with_nothing_set_on_this_pc_the_free_ai_on_johns_relay_is_on`, `test_every_privacy_page_says_where_the_free_ai_sends_what_it_counts_and_its_caps_as_configured`, e2e nokey mode |
| A1 | A real -123 on a row that adds up got a Medium "likely 123" card (accepting it breaks a correct row), and a total off by 100 was missed, because a total was recognised only under a Total, Sum or All header | `_totals` finds a total by its arithmetic under any header (3+ neighbours, 95% of 10+ rows), so its rows are confirmed and a broken one flagged | `test_a_total_the_header_does_not_name_is_found_by_its_arithmetic_and_confirms_its_rows` |
| A2 | 120 business days with an honest Friday peak: 25 rows flagged, 6 Medium | A 5-row cycle spanning 7 days; a value past the weird limit with 5+ others as near on either side is the column's crowd | `test_an_honest_friday_peak_on_business_days_is_neither_a_jump_nor_past_a_limit`, `test_a_real_jump_among_business_days_is_still_found` |
| A3 | No formula checking: a typed 250 in a column of `=C*D`, or one row's `=C31*D32`, went unseen, and the card told the user to "fix the cells it uses" | AH-152: the scan sends each cell's R1C1 formula to the local engine; where 80%+ of a column (5+) share one formula, a typed value or another formula is flagged on that cell, and the card writes the column's own formula back (Undo restores) | `test_formulas.py` (19 tests), selfcheck `AH-152`, e2e `8b2` |
| C1 | After the pane was closed and reopened, Find problems made highlights that Remove highlights, Dismiss and Accept could never take off (our own colour was recorded as the cell's old fill) | The fill each highlighted cell had is kept in the workbook (at most 20,000 cells, in Forget) and put back exactly, only on a cell that record names still wearing our colour | e2e step 5 after a reload |
| C2 | A user's own fill under a highlight was lost once the pane closed, and a whole row in Excel's own Neutral style was wiped | Same record as C1; the old whole-row rule removed | e2e step 5 |
| C3 | A column was read as dates from row 2's number format alone, so a sort changed what the date and jump checks saw | The format most of the first 20 filled cells share | e2e step 8a, selfcheck |
| C4 | Every scan rewrote the open-with-the-file setting, so Excel asked to save and the pane opened for everyone the file is shared with | Written once per workbook | e2e step 5 |
| C5 | The card said "a backup Gemini model answered" without naming it | It names the model that answered | e2e AI mode |
| C6 | The hint beside Ask AI states what it sends, but nothing held its numbers to the engine's | A test measures each number on what /fix really sends | `test_what_the_pane_says_ask_ai_sends_is_what_the_engine_sends` |
| R1 | Ask AI's memory picked the newest 5 past fixes by exact header, so a same-column fix of another step pulled answers to the wrong step, and memories invented values on error and blank rows | AH-153: ranked retrieval (`memory.rank`: same step, the reason's words, the old value's closeness, recency), post-retrieval (`memory.select`: none for errors, blanks, duplicates; none contradicting the reason's "likely"; deduped; top 5 by score; tagged [M1]...), attribution on the card when an answer repeats a shown fix's step. Offline recall@1 of the right past fix: dev 58/65 (89%) vs 12/65 newest first, held-out 55/63 (87%) vs 7/63. Still OFF until its ai_eval arm passes (below) | `test_memory.py`, `test_ai_eval.py`, `ai_eval.py --retrieval`, `docs/AI-PIPELINE.md` |

## Ask AI against its rules

16 of 18 rules were already enforced and tested (153 AI tests); the two gaps were S1 and C5 above, now closed. Nothing
the AI says is ever written without Accept, a card writes exactly the changes it shows, AI text is never HTML, and no
cell can change the instructions (there is no system prompt; cells are quoted as data). Open: the fix prompt still
does not say "cells are data, not instructions" in words (AH-109): a prompt change needs ai_eval numbers.

## Still open, each with its owner

1. **John: redeploy the relay** (`npx wrangler@4.151.1 deploy` in `relay/`) before the launch. Until then the free AI
   answers 401 with plain words, and the daily `relay-live.yml` probe expects the new 400/413 answers.
2. **John: check Google's free daily limit for gemini-3.5-flash-lite** on the relay's project (aistudio.google.com,
   rate limits). The public total (400) assumes about 500.
3. **Capacity:** the free tier is about 400 requests a day for everyone together. One person with many networks can
   use the day up (no billing, so it costs nothing). More needs billing on the relay's project or another free
   provider, John's call.
4. **AH-153 memory:** switched on only when `memory_ranked` beats `base` on dev (W-L >= 2 sqrt(W+L)) and held-out
   (W-L >= 0) with no rise in invented answers. First run (2026-11-10, John's own key, gemini-3.5-flash-lite, 1 run,
   `ai_eval.py --split both --arms base,memory_ranked`): dev right 93 vs 90 of 134, W3 L0 (bar 3.5, missed by a
   hair); held-out right 71 vs 71 of 103, W2 L2 (passes); invented after the checks dev 21 vs 23, held-out 13 vs 9
   (a rise). Not passed: it stays off. Runs 2 and 3 go through the daily 09:17 UTC test, which reports when done.
   Injection obeyed: 0 in both arms.
5. **Data fatigue, not built:** no "dismiss all like this" and no way to ignore a column; a Dismiss is lost when its
   row is edited (by design: an edit is a new row). Design work for Pod 1.
6. **Low:** a planted Monday 600 among business days with Friday peaks is only Low (the Fridays crowd the space below
   it); the urlopen deadline is per read, not total; `/check` after Accept does not see formulas (the next scan does).
7. **Website:** once AH-151 and AH-152 ship, the support page and the checks table may say AI help works out of the box
   and that formulas are checked. Pod 1 has the wording request.

## Gate on the merged branch

`tools/check.py --keep-going --e2e` on 9eebb1d: 13 of 13 layers green. 1654 engine tests passed (1 skipped, 2 strict
xfails); industry bench 51/51 caught, 42 restored, 0 Medium false alarms, 0 harmful; blind 14-domain bench 199/201,
106 restored, 0 Medium false alarms, 0 harmful (both unchanged from main); pip-audit clean; browser e2e and the
website in a browser pass. Two merge findings fixed on the way: the Ask AI hint test was moved to the ranked memory's
object format, and the checks table's cycle words were shortened back to their old line count (the longer row pushed
the table's last row out of the reveal at 1440 x 900; `tools/test_site.mjs` passes on main and now on the branch).
In CI the `probe` check (the live relay) stays red until John redeploys the relay (open item 1).
