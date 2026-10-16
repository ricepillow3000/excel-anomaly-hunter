# What leaves your PC

Anomaly Hunter checks your sheet on your own computer. Nothing is sent anywhere unless you turn on AI help.

## Always on this PC
- **The scan.** Excel hands the sheet to the engine at `https://127.0.0.1:5055`. That address only answers this PC, and only the Anomaly Hunter pane may call it.
- **Files it keeps** in `%LOCALAPPDATA%\AnomalyHunter`, all removed by `AnomalyHunter.exe uninstall`:

  | File | What it holds |
  |---|---|
  | `latest-scan.csv` | a plain-text copy of every cell of the last sheet you scanned, plus each row's result, for the Power BI file. Each scan replaces it; uninstalling deletes it |
  | `server.log` | the engine's own error log |
  | `ai-cache` | up to 500 finished AI answers, so the same question isn't asked twice |
  | `gemini-key.txt`, `invite-code.txt` | your AI key or invite code, if you added one |
  | `ca.pem`, `cert.pem`, `key.pem` | the certificate that works only for 127.0.0.1 |
  | `Start here.xlsx` | the practice workbook |
- **Settings** such as limits and strength are saved in the workbook you scanned. The auto-fix on/off choice is saved in the pane.
- **No analytics, no cookies, no tracking.** The pane loads only its own files and Microsoft's Office script, and its Content Security Policy blocks everything else.

## Only if you turn on AI help
AI help is off until you paste a Google AI key or an invite code under **AI help (optional, free)**.
- **Ask AI (fix a row):** sends the column names, the row you asked about, up to 5 rows around it, and the reason it was flagged.
- **Check words with AI:** sends only the distinct words in your text columns. It never sends rows or numbers.
- **Where it goes:**
  - With your own key, it goes straight to Google's Gemini API.
  - With an invite code, it goes through John's relay (a Cloudflare Worker), which passes it to Google.
    - The relay keeps only a daily count per invite code, to enforce the limit. It does not store your data.
    - The relay's key never reaches your PC.
- **Google's free tier may use what you send to improve its products.** Don't ask AI about private or personal data.
- **Turning it off:** click **Remove key** in the same section.

## Contact
Questions, problems or a privacy request: open an issue at
https://github.com/ricepillow3000/excel-anomaly-hunter/issues.
