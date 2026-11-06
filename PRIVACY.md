# What leaves your PC

Arcas is a free Excel add-in made by one person, John, in his spare time. It is not a company, and it is not
affiliated with Microsoft, Google, Cloudflare, Anthropic or GitHub. This file, the pane's Privacy page
(`frontend/privacy.html`) and the website's (`site/privacy.html`) say the same thing; all three describe what the code does.

Arcas is made and run by John Nguyen (GitHub: ricepillow3000). To reach him, use the pane's Support page, which
opens a question form on GitHub, email john4000.nguyen@gmail.com, or call (770) 265-9930. An email to John goes to his Gmail, so Google's terms apply to it.

A scan runs on your PC and sends nothing to the internet. Your sheet's data leaves your PC only when you click
**Ask AI** or **Check words with AI**. There are no accounts and no cookies, and the add-in has no analytics and no tracking. Only this project's website may count its page views, with GoatCounter (see who else sees something).

## Always on this PC
- The scan runs in the engine at `https://127.0.0.1:5055`: Excel hands it the sheet, and it answers only this PC. Websites
  can't call it (it checks where each request comes from); other programs on this PC can, like any local service.
- Files in `%LOCALAPPDATA%\AnomalyHunter`:

  | File | What it holds |
  |---|---|
  | `Arcas.exe` | a copy of the app, so the engine can start when you log on. An update over an install made before the app was renamed Arcas deletes the old app file; if Windows still holds it, it stays until the next update or uninstall |
  | `server.log`, `server.log.1` | the engine's messages and errors; server.log starts empty each time the engine starts, and server.log.1 keeps the run before (each start replaces it); an error can quote a value from your sheet |
  | `ai-cache` | up to 500 AI answers, so the same question isn't asked twice; an answer can quote your cells |
  | `gemini-key.txt`, `invite-code.txt` | your Google AI key or invite code, if you added one; each is sealed with Windows' own encryption (DPAPI) for your Windows account, so a copy of the file is no use on another account, though a program running as you could still open it |
  | `ca.pem`, `cert.pem`, `key.pem` | the certificate the engine uses for HTTPS on this PC |
  | `addin\manifest.xml` | the file that lists Arcas in Excel |
  | `Start here.xlsx` | the practice workbook |
  | `anomaly-hunter.pbids`, `anomaly-hunter-flags.pbids` | shortcuts that open latest-scan.csv and latest-flags.csv in Power BI; they hold only those files' paths |
  | `latest-scan.csv` | **only if you turn on "Save each scan for Power BI"** (off unless you turn it on): a plain-text copy of every cell of the last sheet you scanned, with each row's number, result and suggested fix. Each scan replaces it; after you turn the option off, the next scan deletes it |
  | `latest-flags.csv` | **only with the same option on**: the sheet's name, the time of the scan, and the number, result, suggested fix and status (Open, Fixed or Dismissed) of each flagged row and each row you fixed or dismissed (results and fixes can quote your cells). Kept and deleted together with latest-scan.csv |
- If you installed Arcas.exe, it unpacks itself into a temporary folder in `%TEMP%` each time it starts; if the engine is
  stopped by force, that folder can be left behind. Install removes the "downloaded from the internet" mark from its
  own copy of the app, so Windows doesn't warn at every logon.
- An invite kit (shared by John by a Google Drive or OneDrive link) runs from its own folder: `install.bat`
  downloads the Python packages it needs from PyPI, the Python package site (PyPI sees your IP address), and keeps
  them in a `.venv` folder there, with the Power BI shortcuts in its `powerbi` folder. It saves the kit's invite code
  in the folder above, sealed like a code you paste. The kit folder keeps its own invite-code.txt as plain text, as John made it. A kit has no Arcas.exe, `addin\manifest.xml` or Start here.xlsx: Excel lists the
  add-in from the kit's `frontend` folder. Uninstall a kit with `install.bat /u`, then delete the kit folder.
  Like the app's uninstall, it also deletes Excel's add-in cache (the Wef folder), so other web add-ins may need to be added again.
- Your workbook keeps the limits you changed, the strength slider, a list of the last auto-fixes with their old
  values and a copy of each fixed row (so Undo works), the old values and number formats of the cells you changed with **Accept**, and what Accept wrote in them (so
  Undo still works after the pane is closed and opened again), a short code for each row you fixed or dismissed (worked out
  from the row's values, never the values themselves, so the row is still Fixed or Dismissed when the pane opens
  again), and a setting that opens the pane with that file. Highlights are fill colours in your cells.
  A fix changes your cells only when you click **Accept**, or when auto-fix runs, if you turned it on.
- The pane saves the auto-fix switch (`anomalyHunterAutoFix`) and the Power BI switch (`anomalyHunterPowerBi`) in
  Excel's storage for the pane (its localStorage) on this PC. Ask AI's memory (`anomalyHunterAiMemory`) is saved there
  too: up to 200 fixes you accepted with **Accept**, in any workbook, each with its column name, the kind of fix, and
  the old and new values. Undo takes a fix back out.
- Install also adds a startup entry, a trusted add-in folder for Excel, and a certificate in your Windows account
  that works only for `localhost` and `127.0.0.1` (the key that made it is never saved).

## Only if you use AI help
AI help works only after you paste a Google AI key or an invite code, or install an invite kit from John (or a
developer sets `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` on the PC). Even then,
nothing from your sheet is sent until you click a button. When you save a Google key, the engine asks Google once
whether the key works; that call carries the key and no sheet data. A key from a Google project with billing turned on
can be charged by Google for what AI help uses; without billing, the free tier costs nothing.
- **Ask AI** (fix a row) sends the column names, the row you asked about, up to 5 rows above and 5 below it, the
  formulas in that row, the cell addresses, the reason it was flagged, and anything you type in the request box. On a
  wide sheet only the columns nearest the flagged cell go. Long cells are cut to 200 characters, except the flagged cell.
  It also sends up to 5 fixes you accepted before in a column with the same name as the flagged one, from Ask AI's
  memory: each one's column name, the kind of fix, and the old and new values.
- **Check words with AI** sends the names of your text columns that have 2 to 50 different values, and those values (up to
  60 characters each). It never sends whole rows or numbers. These values can include names of people or places.
- If what you type to Ask AI reads as someone in crisis, the pane shows helpline numbers instead and
  sends nothing to the AI.
- Where it goes:
  - With your own Google key: straight to Google's Gemini API.
  - With an invite code: to John's relay on Cloudflare, which passes it to Google with John's key. A developer setting
    on the PC, `ANOMALY_HUNTER_RELAY`, sends invite calls to another relay's https address instead.
    - The relay keeps one counter: for the last day anyone used it, how many AI calls each invite made, under the
      name John gave that invite, plus the total. The first call of a new day replaces it. It saves no request and no
      answer; its saved logs are switched off.
    - The list of invites (a scrambled copy of each code and a name) stays until John removes it.
    - Cloudflare sees your IP address as the request passes. The relay's key never reaches your PC.
  - With neither, but with `ANTHROPIC_API_KEY` set on your PC (a developer setting): to Anthropic's Claude.
- **Google's free tier may use what you send to improve its products.** Invite codes always use John's free key; with
  your own key it depends on your Google plan. Don't ask AI about private or personal data.

## Who else sees something
- Google receives what AI help sends, under Google's own terms.
- With an invite code, each AI request passes through John's relay on Cloudflare (see above).
- Anthropic receives what AI help sends only in the developer case above.
- PyPI sees your IP address only if you install an invite kit, when `install.bat` downloads Python packages from it.
- GitHub hosts the download, so it sees your IP address when you download. Anything you post in an issue is public.
- The website's contact form and support form send nothing themselves: each opens a public GitHub issue filled in with what you typed, which you submit on GitHub yourself, or, with Email John instead, a new email in your own email app, which you send yourself.
  The links to John's LinkedIn, Handshake and GitHub profiles are plain links: nothing loads from LinkedIn, Handshake or GitHub until you click one, and then that site's own terms apply.
- Microsoft: Excel loads Microsoft's Office script for the pane, and Windows may check the downloaded file.
  Microsoft's privacy terms apply.
- The pane loads only its own files and Microsoft's Office script; its Content Security Policy blocks everything
  else. The fonts are on your PC.
- GoatCounter: this project's website, never the add-in, the pane or the engine, may count its page views with GoatCounter once John turns the counter on. Each page view then sends GoatCounter one request with the page's address on this site and nothing else: no cookie, no referrer, no title, no screen size, and nothing at all under Do Not Track or Global Privacy Control. Like any server, GoatCounter's sees your IP address and browser with that request. [GoatCounter's privacy policy](https://www.goatcounter.com/help/privacy) says what it keeps.
- Nothing is sold, and nothing is used for ads or tracking.

## Your control
- **Remove key** (in the pane) deletes the key and invite code saved in `%LOCALAPPDATA%\AnomalyHunter`. Scans and
  fixes keep working. An invite kit keeps its own copy, and running its install.bat again turns AI help back on, so
  also delete `invite-code.txt` from the kit folder. A `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` setting keeps AI help on.
- You can delete `ai-cache`, `server.log` or `server.log.1` in the folder above whenever you like.
- **Forget what this workbook saved** (in the pane, under Options > Saved in this workbook) removes everything the pane
  saved in the open workbook: the limits, the strength slider, the auto-fix list with its old values, the old values
  Accept keeps for Undo, the code of each row you fixed or dismissed, and the setting that opens the pane with the file. It changes no cell. Save the workbook
  afterwards to keep the change in the file.
- **Forget what the AI learned** is in the pane, under Options > AI help. It removes every fix Ask AI remembers on this
  PC, for every workbook. Forget what this workbook saved leaves them, as they are not in the workbook. Uninstalling
  also removes them with Excel's add-in cache.
- To uninstall, open Settings > Apps > Installed apps, find Arcas and choose Uninstall. An Arcas installed before
  November 2026 is listed there after its next update; until then run `"%LOCALAPPDATA%\AnomalyHunter\Arcas.exe" uninstall`.
  It removes the startup entry, its Installed apps entry, the add-in listing, the certificate and the files in that
  folder, the app file too, a few seconds after it closes. It
  also deletes Excel's add-in cache (the Wef folder), so other web add-ins may need to be added again and may forget
  their settings. It never touches your workbooks, so settings a scan saved inside a workbook stay there until you use
  Forget what this workbook saved in each one.
- To remove your invite, ask John the way you got it.
- You can edit or delete your own GitHub issue; John can delete it if you ask. Copies made while it was public
  may remain. John holds no other data about you.

## No warranty, changes, contact
Arcas is free and comes with no warranty. It can miss mistakes and flag correct values; check important data
yourself. Its code is open source under the MIT License ([LICENSE](LICENSE)). When this file changes, its history is on GitHub.
The invite relay is for help with Excel fixes only. John can turn off any invite at any time, each invite has a daily
cap (as set today: 10 AI calls per invite and 20 for everyone together a day), and there is no promise it is up.
Questions or problems: the pane's Support page, or
https://github.com/ricepillow3000/excel-anomaly-hunter/issues (public, needs a free GitHub account; never post your AI
key, your invite code or real data).
