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
  | `anomaly-hunter.pbids` | a shortcut that opens the Power BI file in Power BI |
  | `latest-scan.csv` | **only if you turn on "Save each scan for Power BI"** (off unless you turn it on): a plain-text copy of every cell of the last sheet you scanned, plus each row's result. Each scan replaces it; after you turn the option off, the next scan deletes it |
- **In your workbook:** the limits you changed, the strength slider, a list of the last auto-fixes with their old
  values (so Undo works), and a setting that opens the pane with that file. Highlights are fill colours in your cells.
  A fix changes your cells only when you click **Accept**, or when auto-fix runs, if you turned it on.
- **In the pane:** the auto-fix and Power BI switches, in Excel's storage for the pane on this PC.
- **Install** also adds a startup entry, a trusted add-in folder for Excel, and a certificate in your Windows account
  that works only for `localhost` and `127.0.0.1` (the key that made it is never saved).

## Only if you use AI help
AI help works only after you paste a Google AI key or an invite code, or install an invite kit from John. Even then,
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
- **GitHub** hosts the download, so it sees your IP address when you download. Anything you post in an issue is public.
- **Microsoft:** Excel loads Microsoft's Office script for the pane, and Windows may check the downloaded file.
- Nothing is sold, and nothing is used for ads or tracking.

## Your control
- **Remove key** (in the pane) deletes your key and invite code from this PC. Scans and fixes keep working.
- **Delete** `ai-cache` or `server.log` in the folder above whenever you like.
- **Uninstall:** `"%LOCALAPPDATA%\AnomalyHunter\AnomalyHunter.exe" uninstall`. It removes the startup entry, the
  add-in listing, the certificate and the files in that folder, except the app file itself (delete it afterwards). It
  also clears Excel's add-in cache, so other add-ins you added from a shared folder must be added again. It never
  touches your workbooks.
- **Your invite:** ask John, the way you got it, to remove it.
- **A GitHub issue:** you can edit or delete your own; John can delete it if you ask. Copies made while it was public
  may remain. John holds no other data about you.

## No warranty, changes, contact
Anomaly Hunter is free and comes with no warranty. It can miss mistakes and flag correct values; check important data
yourself. When this file changes, its history is on GitHub. Questions or problems: the pane's Support page, or
https://github.com/ricepillow3000/excel-anomaly-hunter/issues (public, needs a free GitHub account; never post your AI
key, your invite code or real data).
