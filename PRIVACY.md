# What leaves your PC

Anomaly Hunter is a free Excel add-in made by one person, John, in his spare time. It is not a company, and it is not
affiliated with Microsoft, Google, Cloudflare, Anthropic or GitHub. This file and the pane's Privacy page
(`frontend/privacy.html`) say the same thing; both describe what the code does.

A scan runs on your PC and sends nothing to the internet. Your sheet's data leaves your PC only when you click
**Ask AI** or **Check words with AI**. There are no accounts, no analytics and no tracking, and the add-in sets no cookies.

## Always on this PC
- **The scan.** Excel hands the sheet to the engine at `https://127.0.0.1:5055`. It answers only this PC. Websites
  can't call it (it checks where each request comes from); other programs on this PC can, like any local service.
- **Files** in `%LOCALAPPDATA%\AnomalyHunter`:

  | File | What it holds |
  |---|---|
  | `AnomalyHunter.exe` | a copy of the app, so the engine can start when you log on |
  | `server.log` | the engine's messages and errors; it starts empty each time the engine starts; an error can quote a value from your sheet |
  | `ai-cache` | up to 500 AI answers, so the same question isn't asked twice; an answer can quote your cells |
  | `gemini-key.txt`, `invite-code.txt` | your Google AI key or invite code, if you added one |
  | `ca.pem`, `cert.pem`, `key.pem` | the certificate the engine uses for HTTPS on this PC |
  | `addin\manifest.xml` | the file that lists Anomaly Hunter in Excel |
  | `Start here.xlsx` | the practice workbook |
  | `anomaly-hunter.pbids`, `anomaly-hunter-flags.pbids` | shortcuts that open latest-scan.csv and latest-flags.csv in Power BI; they hold only those files' paths |
  | `latest-scan.csv` | **only if you turn on "Save each scan for Power BI"** (off unless you turn it on): a plain-text copy of every cell of the last sheet you scanned, with each row's number, result and suggested fix. Each scan replaces it; after you turn the option off, the next scan deletes it |
  | `latest-flags.csv` | **only with the same option on**: the sheet's name, the time of the scan, and the number, result and suggested fix of each flagged row (results and fixes can quote your cells). Kept and deleted together with latest-scan.csv |
- **Elsewhere:** if you installed AnomalyHunter.exe, it unpacks itself into a temporary folder in `%TEMP%` each time it starts; if the engine is
  stopped by force, that folder can be left behind. Install removes the "downloaded from the internet" mark from its
  own copy of the app, so Windows doesn't warn at every logon.
- **An invite kit** (shared by John by a Google Drive or OneDrive link) runs from its own folder: `install.bat`
  downloads the Python packages it needs from PyPI, the Python package site (PyPI sees your IP address), and keeps
  them in a `.venv` folder there, with the Power BI shortcuts in its `powerbi` folder. It copies the kit's invite code
  into the folder above. A kit has no AnomalyHunter.exe, `addin\manifest.xml` or Start here.xlsx: Excel lists the
  add-in from the kit's `frontend` folder. Uninstall a kit with `install.bat /u`, then delete the kit folder.
- **In your workbook:** the limits you changed, the strength slider, a list of the last auto-fixes with their old
  values and a copy of each fixed row (so Undo works), and a setting that opens the pane with that file. Highlights are fill colours in your cells.
  A fix changes your cells only when you click **Accept**, or when auto-fix runs, if you turned it on.
- **In the pane:** the auto-fix and Power BI switches, in Excel's storage for the pane on this PC.
- **Install** also adds a startup entry, a trusted add-in folder for Excel, and a certificate in your Windows account
  that works only for `localhost` and `127.0.0.1` (the key that made it is never saved).

## Only if you use AI help
AI help works only after you paste a Google AI key or an invite code, or install an invite kit from John (or a
developer sets `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` on the PC). Even then,
nothing from your sheet is sent until you click a button. When you save a Google key, the engine asks Google once
whether the key works; that call carries the key and no sheet data.
- **Ask AI (fix a row):** sends the column names, the row you asked about, up to 5 rows above and 5 below it, the
  formulas in that row, the cell addresses, the reason it was flagged, and anything you type in the request box. On a
  wide sheet only the columns nearest the flagged cell go. Long cells are cut to 200 characters, except the flagged cell.
- **Check words with AI:** sends the names of your text columns that have 2 to 50 different values, and those values (up to
  60 characters each). It never sends whole rows or numbers. These values can include names of people or places.
- **Where it goes:**
  - With your own Google key: straight to Google's Gemini API.
  - With an invite code: to John's relay on Cloudflare, which passes it to Google with John's key.
    - The relay keeps one counter for today: how many AI calls each invite made, under the name John gave that
      invite, plus the total. It saves no request and no answer; its saved logs are switched off.
    - The list of invites (a scrambled copy of each code and a name) stays until John removes it.
    - Cloudflare sees your IP address as the request passes. The relay's key never reaches your PC.
  - With neither, but with `ANTHROPIC_API_KEY` set on your PC (a developer setting): to Anthropic's Claude.
- **Google's free tier may use what you send to improve its products.** Invite codes always use John's free key; with
  your own key it depends on your Google plan. Don't ask AI about private or personal data.

## Who else sees something
- **Google** receives what AI help sends, under Google's own terms.
- **Cloudflare and John's relay**, only with an invite code (see above).
- **Anthropic**, only in the developer case above.
- **PyPI**, only for an invite kit: `install.bat` downloads Python packages from it, so it sees your IP address.
- **GitHub** hosts the download, so it sees your IP address when you download. Anything you post in an issue is public.
- **Microsoft:** Excel loads Microsoft's Office script for the pane, and Windows may check the downloaded file.
  Microsoft's privacy terms apply.
- The pane loads only its own files and Microsoft's Office script; its Content Security Policy blocks everything
  else. The fonts are on your PC.
- Nothing is sold, and nothing is used for ads or tracking.

## Your control
- **Remove key** (in the pane) deletes the key and invite code saved in `%LOCALAPPDATA%\AnomalyHunter`. Scans and
  fixes keep working. An invite kit keeps its own copy, and running its install.bat again turns AI help back on, so
  also delete `invite-code.txt` from the kit folder. A `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` setting keeps AI help on.
- **Delete** `ai-cache` or `server.log` in the folder above whenever you like.
- **Uninstall:** `"%LOCALAPPDATA%\AnomalyHunter\AnomalyHunter.exe" uninstall`. It removes the startup entry, the
  add-in listing, the certificate and the files in that folder, except the app file itself (delete it afterwards). It
  also deletes Excel's add-in cache (the Wef folder), so other web add-ins may need to be added again and may forget
  their settings. It never touches your workbooks, so settings a scan saved inside a workbook stay there.
- **Your invite:** ask John, the way you got it, to remove it.
- **A GitHub issue:** you can edit or delete your own; John can delete it if you ask. Copies made while it was public
  may remain. John holds no other data about you.

## No warranty, changes, contact
Anomaly Hunter is free and comes with no warranty. It can miss mistakes and flag correct values; check important data
yourself. Its code is open source under the MIT License ([LICENSE](LICENSE)). When this file changes, its history is on GitHub. Questions or problems: the pane's Support page, or
https://github.com/ricepillow3000/excel-anomaly-hunter/issues (public, needs a free GitHub account; never post your AI
key, your invite code or real data).
