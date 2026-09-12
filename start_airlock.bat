@echo off
REM Airlock launcher. %~dp0 keeps this working wherever the folder lives.
cd /d "%~dp0"

if not exist "node_modules\" (
    echo Installing dependencies...
    call npm install
)

REM Only start a server if nothing is already listening. Starting one unconditionally left
REM a second node process that lost the race for the port and just sat there doing nothing.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 8100 -State Listen -ErrorAction SilentlyContinue) { exit 0 } exit 1"
if errorlevel 1 (
    echo Starting Airlock on http://localhost:8100
    start "" /min cmd /c "node server.js"
    REM Give the server a moment before pointing a browser at it.
    timeout /t 2 /nobreak >nul
) else (
    echo Airlock server is already running.
)

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
