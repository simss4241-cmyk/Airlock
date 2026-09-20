@echo off
REM Airlock launcher. %~dp0 keeps this working wherever the folder lives.
cd /d "%~dp0"

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

REM Only start a server if nothing is already listening. Starting one unconditionally left
REM a second node process that lost the race for the port and just sat there doing nothing.
REM
REM Ask WHO is on the port, not merely whether it is busy. This used to be a
REM Get-NetTCPConnection check, which cannot tell one app from another — and Airlock is a
REM fork of Glimmer, which defaulted to the same 8100. Whichever started first owned both
REM desktop shortcuts: this script saw a listening socket, announced "Airlock server is
REM already running", and then opened Glimmer in a window titled Glimmer. Glimmer has since
REM moved to 8101, but a socket check that cannot name what answered was the real bug.
REM
REM   0 = Airlock is already up    1 = nothing there, start it    2 = someone else has it
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost:8100/api/whoami' -TimeoutSec 3; if ($r.app -eq 'airlock') { exit 0 } else { exit 2 } } catch { if ($_.Exception.Response.StatusCode.value__) { exit 2 } exit 1 }"

REM Batch "if errorlevel N" means "N or greater", so test high to low.
if errorlevel 2 goto occupied
if errorlevel 1 goto startserver
echo Airlock server is already running.
goto focus

:startserver
echo Starting Airlock on http://localhost:8100
start "" /min cmd /c "node server.js"
REM Give the server a moment before pointing a browser at it.
timeout /t 2 /nobreak >nul
goto focus

:occupied
echo.
echo   Port 8100 is held by something that is not Airlock.
echo   Close it and run this again, or start Airlock elsewhere with:
echo.
echo       set PORT=8102 ^&^& node server.js
echo.
exit /b 1

:focus
REM Reuse an existing Airlock app window when one is already open. Exit 4 means the window
REM exists but Windows refused to raise it — still a reason not to open a duplicate.
REM Checks run high-to-low because batch "if errorlevel N" means "N or greater".
powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0tools\focus_airlock.ps1"
if errorlevel 5 goto newwindow
if errorlevel 4 exit /b 0
if errorlevel 1 goto newwindow
exit /b 0

:newwindow
start "" msedge --app=http://localhost:8100
