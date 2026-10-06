@echo off
rem Double-click: engine starts, Excel opens with the add-in loaded. Close the server window to turn OFF.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo No .venv here. One-time setup: python -m venv .venv ^&^& .venv\Scripts\python -m pip install -e .
    pause & exit /b 1
)
start "Anomaly Hunter Server - close this window to turn OFF" /min ".venv\Scripts\python.exe" -m anomaly_hunter.server
ping -n 4 127.0.0.1 >nul
call npx --yes office-addin-dev-settings@3.1.2 sideload panel\manifest.xml
if errorlevel 1 (
    echo Sideload failed - Excel did NOT get the add-in. Is node/npx installed and on PATH?
    pause & exit /b 1
)
echo Running. Excel should be opening. Close the "Anomaly Hunter Server" window to turn OFF.
ping -n 6 127.0.0.1 >nul
