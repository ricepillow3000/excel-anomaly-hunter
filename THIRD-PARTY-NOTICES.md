# Third-party notices

Arcas itself is MIT licensed (see `LICENSE`). It also uses other people's work. Some of it is
redistributed inside `Arcas.exe`, and BSD-3-Clause section 2 and Apache-2.0 section 4(d) both ask for
the notices to travel with a binary, so they are listed here.

This file is written by hand and checked by `backend/tests/test_legal_pages.py`, which fails if a
runtime dependency in `pyproject.toml` is missing from the table below. Add a dependency, add a row.

## Bundled inside Arcas.exe

CPython itself is bundled by PyInstaller, under the Python Software Foundation License.

| Package | Version | Licence |
|---|---|---|
| pandas | 3.0.6 | BSD-3-Clause |
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| scipy | 1.18.1 | BSD-3-Clause |
| openpyxl | 3.1.5 | MIT |
| flask | 3.1.3 | BSD-3-Clause |
| werkzeug | 3.1.9 | BSD-3-Clause |
| pydantic | 2.14.1 | MIT |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| defusedxml | 0.7.1 | Python Software Foundation License |

Exact versions are pinned in `pyproject.toml` and `constraints.txt`. Each package's own full licence
text ships inside its installed distribution, which PyInstaller collects into the executable.

## Loaded at runtime, not redistributed

- **Office.js** (`office.js`), loaded by the Excel pane from Microsoft's own content delivery network.
  It is Microsoft's, used under Microsoft's terms, and no copy of it is included in this repository or
  in `Arcas.exe`.

## Fonts

- **Plus Jakarta Sans**, Copyright 2020 The Plus Jakarta Sans Project Authors, under the SIL Open Font
  License 1.1. The full licence text ships beside the font file, at
  `site/assets/OFL-PlusJakartaSans.txt` and `frontend/assets/OFL-PlusJakartaSans.txt`.
  The `"Plus Jakarta Sans Fallback"` family in `site/styles.css` is a `local()` alias of fonts already
  on the reader's computer with `size-adjust` applied, so no font software is redistributed under a
  reserved name.

## Data used in the case studies

- The example sheets on `site/cases.html` are excerpts of **FiveThirtyEight** data, used under
  **CC BY 4.0**, attributed on that page with a link to the source folder and to the licence. The page
  states which rows were used and at what strength, which is the indication of changes CC BY asks for.

## Images and artwork

The crest, the icons and the grain texture are John Nguyen's own work. The photograph is his own. No
stock images are used.

## Not affiliated

Arcas is not affiliated with, endorsed by, or sponsored by Microsoft, Google, Cloudflare, Anthropic or
GitHub. Microsoft and Excel are trademarks of Microsoft Corporation. Arcas reads and writes Microsoft
Excel files and runs as an Excel add-in; saying so is a description of what it does, not a claim of any
relationship with Microsoft.
