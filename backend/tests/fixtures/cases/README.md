# Case study excerpts (AH-133)

Excerpts of three public tables from FiveThirtyEight (github.com/fivethirtyeight/data). The repository's README says
"Unless otherwise noted, our data sets are available under the Creative Commons Attribution 4.0 International License"
(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/), and none of these folders says otherwise (read 2026-11-05).
Each excerpt's `.json` beside it records the source address, the licence, the rows taken, the engine's sentences when
it was made, and what was checked by hand. `backend/tests/test_site_cases.py` scans each excerpt again and holds the
home page's case studies (site/index.html, `#cases`) to what the engine says.

| File | Source | What it is |
|---|---|---|
| `classic-rock-release-year.csv` | https://github.com/fivethirtyeight/data/tree/master/classic-rock (classic-rock-song-list.csv) | Data: FiveThirtyEight, CC BY 4.0. An excerpt: 120 of 2,229 rows (source sheet rows 512-571 and 1472-1531), each line as in the source; no cell changed. |
| `mad-men-div0.csv` | https://github.com/fivethirtyeight/data/tree/master/mad-men (show-data.csv) | Data: FiveThirtyEight, CC BY 4.0. An excerpt: the last 120 of 248 rows (source sheet rows 130-249). The source's accented names are Mac Roman bytes; three names (Chloë Sevigny, Lauren Vélez, Alexander Skarsgård) were re-encoded to UTF-8, and no other cell changed. |
| `daily-show-media.csv` | https://github.com/fivethirtyeight/data/tree/master/daily-show-guests (daily_show_guests.csv) | Data: FiveThirtyEight, CC BY 4.0. An excerpt: 99 rows from 2002 of 2,693 (source sheet rows 501-599), each line as in the source; no cell changed. |
