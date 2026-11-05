# Stress test of the whole of Arcas (AH-123, 2026-11-05)

John asked (2026-11-04): every website claim traced to a source, every sample cell the engine's own, every button and
animation working under stress, the download current, no dead code, the scanner flagging only real problems, one click
doing one thing, levels 1 to 10 really different, the bias check adapting, AI help and the privacy pages accurate.

Five read-only Researchers audited it (website claims and sample, website motion and buttons, the Excel tool, code
cleanliness, privacy and support). Every real problem they found was fixed test first: the test was run on the old code
and failed, then passed on the new one. Tickets AH-127 to AH-132.

## What the audits measured (before any fix)

| Check | Result |
|---|---|
| Planted mistakes found, industry bench (27 sheets) | 51 of 51, 0 Medium+ false alarms in 2,724 clean rows |
| Planted mistakes found, blind bench (42 sheets, never tuned on) | 199 of 201, 0 Medium+ false alarms in 6,954 clean rows |
| Chaos Dataset, harm-weighted F2 at levels 1 / 5 / 10 | 1.000 / 0.980 / 0.980, 0 harmful fixes, 0 silent changes |
| Wrong-cell highlights on 5 fresh sheets, levels 0-10 | 0 |
| Same sheet, columns shuffled or headers made meaningless | same flags (only the header rules the feature map names move) |
| 20 pure-noise people sheets (180 fairness tests) | 179 even, 1 unclear, 0 gap |
| Slider: a mid-size outlier (6 robust spreads) found in 10 sheets | level 1: 0, level 5: 7, level 10: 10 |
| Slider: rows listed on the industry bench | level 1: 44, level 5: 76, level 10: 150 |
| Website: interactions driven at 1440, 1280, 768 and 390 px | about 2,150, 0 console or page errors |
| Website: frames while scrolling, gliding and turning pages | median 16.7 ms, worst 50 ms, layout shift 0 |
| Download button | redirects to the latest release, v0.1.276, a valid Windows program whose SHA-256 matches the page |
| Dead modules, unused imports, uncalled functions | none (vulture, ruff, a fresh pin compile equal to constraints.txt) |
| Privacy statements checked against the code | 25 true, 4 incomplete, 1 a policy no code can show (invites use John's free key), 0 false |

## What was wrong, and what it does now

| Problem found | Before | After | Test |
|---|---|---|---|
| A double-click on Undo | undid the fix and dismissed the row (Dismiss is drawn where Undo was), 3 of 3 | undoes once, dismisses nothing | e2e/run.mjs, a real double-click |
| A double-click on Forget | ran twice, ended on "holds nothing Arcas saved" | runs once, says what it removed | e2e/run.mjs |
| A click while the next card turns in | landed on Accept and wrote a fix | the turning card takes no click | e2e/run.mjs |
| Two slider steps during a scan | 3 scans (5, 7, 7) | 2 scans (5, 7) | e2e/run.mjs |
| An obvious pay gap (0.67x, raw p 3e-22) | "not enough rows to tell" in 5 of 10 sheets | "a real gap", the right group, 10 of 10 | test_fairness_amounts.py |
| A low approval rate among 4 groups | could name a high group ("Asian: 62% vs 41%") | names the low group | test_fairness_amounts.py |
| "(likely X)" sentence vs the fix card | disagreed on 3 of 104 (1500 said "likely 150", card 15) | always the same value | test_likely_guesses.py, every bench sheet |
| A header two columns share | said "Units.1" | "Units (column E)" | frontend/selfcheck.js |
| Website: "No administrator rights needed" | false: the install uses the admin-only C$ share | says the account must be an administrator | tools/test_site.mjs |
| Website: "about 81 MB" when GitHub doesn't answer | stale (the file is 75 MB) | no number that can go stale | tools/test_site.mjs |
| Website: "Repeating cycles are left alone" | beside 4 flags caused by the sample's own 4-day price cycle | names the cycles left alone, and the 4 boxes say the price peaks every 4 days | test_site_sample.py |
| Website: the scan ticker's "40%" | a number the tool never shows for this sheet | only what the tool shows | test_site_sample.py |
| Website: a filter on "After fixes" | jumped back to the findings and lit 5 rows | filters the fixed sheet | tools/test_site.mjs |
| Support form | showed "Ready. Open it on GitHub" before anything was typed | hidden until the form is filled | tools/test_site.mjs, every hidden element on every page |
| A link to the page you are on | reloaded the whole page (white frame, scroll lost) | scrolls to the top, no reload | tools/test_site.mjs, 10 quick clicks |
| A sample row's detail box | spilled over "See every check" | stays inside the sheet | tools/test_site.mjs |
| Invite kit install | copied the invite code as plain text while the privacy page said it was sealed | sealed with Windows DPAPI at install | test_api_security.py |
| Support pages | told invite-kit users to run an Arcas.exe they don't have; no word on the certificate question or the log | answers for kits, the certificate, and where the log is | test_privacy_promises.py |
| Invite kit size | 5.15 MB (it carried the docs and agent skills) | 0.78 MB | test_api_security.py |
| Old planning docs, dead test branches, stale comments | about 1,500 lines | removed | every gate |

## Measured and not shipped

A note for a label typed once ("Yse" among Yes/No) was built and measured on 217 real public tables: it added 28
notes and none was a real slip (24 were a survey's second header row). It was taken out. A narrower version (an
anagram of a usual label) needs John's call and a fresh blind round.

The fairness change was re-run on the same 217 real tables: every report is word for word the same as before.

## Gate

`tools/check.py --keep-going --e2e` on the combined branch: see the pull request for the layer list. Both accuracy
benches give the same numbers before and after (51/51 and 199/201, 0 Medium+ false alarms).
