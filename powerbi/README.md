# Power BI

`install.bat` writes `anomaly-hunter.pbids` here with this PC's path to `%LOCALAPPDATA%\AnomalyHunter\latest-scan.csv`.
The engine overwrites that CSV after every scan from the Excel panel (your columns + Severity, Bucket, Reason, Magnitude).

Use: double-click `anomaly-hunter.pbids` (needs Power BI Desktop), then **Refresh** after each new scan.
