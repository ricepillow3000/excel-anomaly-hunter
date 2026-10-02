@echo off
rem Plug in and go: double-click this, Excel opens with the add-in already loaded.
rem No Insert > My Add-ins, no npm commands typed by hand.
rem To turn OFF: close the "Anomaly Hunter Server" window this opens.
cd /d "%~dp0"

if not exist "panel\dist\manifest.xml" (
    echo panel\dist\manifest.xml is missing. Run "npm run build" inside panel\ first, then retry.
    pause
    exit /b 1
)

echo Starting Anomaly Hunter...
start "Anomaly Hunter Server - close this window to turn OFF" /min ".venv\Scripts\python.exe" -m anomaly_hunter.server
ping -n 4 127.0.0.1 >nul

pushd panel
call npx office-addin-dev-settings sideload dist\manifest.xml
set SIDELOAD_RESULT=%errorlevel%
popd

if not "%SIDELOAD_RESULT%"=="0" (
    echo Sideload failed - exit code %SIDELOAD_RESULT%. Excel did NOT get the add-in loaded.
    echo Check that node/npx is installed and on PATH, then retry.
    pause
    exit /b 1
)

echo Anomaly Hunter is running - Excel should be opening now.
echo To turn it OFF: close the "Anomaly Hunter Server" window.
ping -n 6 127.0.0.1 >nul
