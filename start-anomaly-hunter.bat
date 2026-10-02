@echo off
rem Plug in and go: double-click this, Excel opens with the add-in already loaded.
rem No Insert > My Add-ins, no npm commands typed by hand.
rem To turn OFF: close the "Anomaly Hunter Server" window this opens.
cd /d "%~dp0"
echo Starting Anomaly Hunter...
start "Anomaly Hunter Server - close this window to turn OFF" /min ".venv\Scripts\python.exe" -m anomaly_hunter.server
ping -n 4 127.0.0.1 >nul
pushd panel
call npx office-addin-dev-settings sideload dist\manifest.xml >nul 2>&1
popd
echo Anomaly Hunter is running - Excel should be opening now.
echo To turn it OFF: close the "Anomaly Hunter Server" window.
ping -n 6 127.0.0.1 >nul
