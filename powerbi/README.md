# Power BI

`install.bat` writes `anomaly-hunter.pbids` here with this PC's path to `%LOCALAPPDATA%\AnomalyHunter\latest-scan.csv`.
The engine overwrites that CSV after every scan from the Excel panel (your columns + Severity, Bucket, Reason, Magnitude).

Use: in the pane, turn on **Power BI (optional) > Save each scan for Power BI** (off by default: no copy of the sheet is kept), scan, then double-click `anomaly-hunter.pbids` (needs Power BI Desktop) and **Refresh** after each new scan.
