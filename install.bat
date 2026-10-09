@echo off
rem Anomaly Hunter installer. Per user, no admin. Double-click = install or repair. "install.bat /u" = uninstall.
rem Result: Anomaly Hunter listed in Excel's Add-ins (Shared Folder); engine starts hidden at every logon.
setlocal
cd /d "%~dp0"
set "ID=a64b585c-34c7-4447-b3ae-9aa8b3294bcf"
set "DEV=HKCU\Software\Microsoft\Office\16.0\WEF\Developer"
set "CAT=HKCU\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs\{3f9a1c2e-7b4d-4e8a-9c61-5d2e8f0b7a13}"
set "RUN=HKCU\Software\Microsoft\Windows\CurrentVersion\Run"
set "AH=%LOCALAPPDATA%\AnomalyHunter"
set "CN=Anomaly Hunter local CA"
set "PY=%~dp0.venv\Scripts\python.exe"
set "PYW=%~dp0.venv\Scripts\pythonw.exe"
set "P=%~dp0frontend"

rem Excel caches add-ins; cache can only be cleared while Excel is closed.
tasklist /fi "imagename eq EXCEL.EXE" 2>nul | findstr /i "EXCEL.EXE" >nul && (echo Close Excel first, then run this again. & pause & exit /b 1)
call :stop
if /i "%~1"=="/u" goto uninstall

echo [1/5] Engine: Python 3.14 + packages (first run takes a few minutes)...
if exist "%PY%" ("%PY%" -c "import sys; sys.exit(sys.version_info[:2] != (3, 14))" || rd /s /q .venv)
if not exist "%PY%" py -3.14 -m venv .venv
if not exist "%PY%" (echo Python 3.14 not found. Install it from python.org, then run this again. & pause & exit /b 1)
"%PY%" -m pip install -q --disable-pip-version-check -e . || (echo Package install failed - see above. & pause & exit /b 1)

echo [2/5] HTTPS certificate that only works for 127.0.0.1. Windows asks once - click Yes.
"%PY%" -m anomaly_hunter.server --cert
set RC=%errorlevel%
if not %RC%==0 if not %RC%==3 (echo Certificate step failed. & pause & exit /b 1)
certutil -user -store Root "%CN%" >nul 2>&1 || set RC=3
if %RC%==3 (
    certutil -user -delstore Root "%CN%" >nul 2>&1
    certutil -user -addstore Root "%AH%\ca.pem" >nul || (del "%AH%\cert.pem" & echo Certificate not trusted - click Yes on the Windows prompt. Run this again. & pause & exit /b 1)
)

echo [3/5] Listing Anomaly Hunter in Excel (Add-ins, Shared Folder)...
rem A trusted catalog is a real install: survives restarts, reopens with saved workbooks.
rem (The old "developer" registry entry is debug-only - Office drops it from saved workbooks.)
rem Catalogs must be a share path, so use this PC's own admin share: \\localhost\C$\...\frontend
reg delete "%DEV%" /v %ID% /f >nul 2>&1
reg delete "%DEV%\%ID%" /f >nul 2>&1
set "UNC=\\localhost\%P:~0,1%$%P:~2%"
if not exist "%UNC%\manifest.xml" (echo Cannot reach %UNC% - the C$ admin share is off on this PC. & pause & exit /b 1)
reg add "%CAT%" /v Id /t REG_SZ /d "{3f9a1c2e-7b4d-4e8a-9c61-5d2e8f0b7a13}" /f >nul
reg add "%CAT%" /v Url /t REG_SZ /d "%UNC%" /f >nul
reg add "%CAT%" /v Flags /t REG_DWORD /d 1 /f >nul
rd /s /q "%LOCALAPPDATA%\Microsoft\Office\16.0\Wef" 2>nul

rem Power BI: double-click powerbi\anomaly-hunter.pbids. It opens the file every scan overwrites (this PC's path).
"%PY%" -c "import json,os; p=os.path.join(os.environ['AH'],'latest-scan.csv'); json.dump({'version':'0.1','connections':[{'details':{'protocol':'file','address':{'path':p}},'options':{},'mode':'Import'}]}, open(r'powerbi\anomaly-hunter.pbids','w'), indent=2)" || (echo Power BI file step failed. & pause & exit /b 1)

echo [4/5] Engine starts hidden at every logon...
reg add "%RUN%" /v AnomalyHunter /t REG_SZ /d "\"%PYW%\" -m anomaly_hunter.server" /f >nul
start "" "%PYW%" -m anomaly_hunter.server

echo [5/5] Checking the engine answers over trusted HTTPS...
set N=0
:wait
"%SystemRoot%\System32\curl.exe" -s -f --ssl-no-revoke https://127.0.0.1:5055/health 2>nul | findstr "status" >nul && goto up
set /a N+=1
if %N% geq 60 (echo Engine did not answer. Log: "%AH%\server.log" & pause & exit /b 1)
ping -n 2 127.0.0.1 >nul
goto wait
:up
echo.
echo Installed. ONE TIME in Excel: Home ^> Add-ins ^> More Add-ins ^> SHARED FOLDER ^> Anomaly Hunter ^> Add.
echo After that: Anomaly Hunter button in every workbook, survives restarts, scanned workbooks reopen with it.
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\excel.exe" >nul 2>&1 && start excel
pause
exit /b 0

:uninstall
reg delete "%RUN%" /v AnomalyHunter /f >nul 2>&1
reg delete "%DEV%" /v %ID% /f >nul 2>&1
reg delete "%DEV%\%ID%" /f >nul 2>&1
reg delete "%CAT%" /f >nul 2>&1
certutil -user -delstore Root "%CN%" >nul 2>&1
rd /s /q "%AH%" 2>nul
rd /s /q "%LOCALAPPDATA%\Microsoft\Office\16.0\Wef" 2>nul
echo Uninstalled. Delete this folder to remove the files too.
pause
exit /b 0

:stop
rem kill a running engine so it restarts on the fresh install
powershell -NoProfile -Command "Get-CimInstance Win32_Process | ? { $_.Name -in 'pythonw.exe','python.exe' -and $_.CommandLine -match 'anomaly_hunter' } | %% { Stop-Process -Id $_.ProcessId -Force }"
exit /b 0
