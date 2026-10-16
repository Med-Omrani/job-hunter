@echo off
REM JobCenter: relaunch Chrome with remote debugging so the apply agent can
REM attach to your real Chrome (Google session inside) via CDP on port 9222.
REM Close Chrome first, run this, keep the window open.
set PORT=9222
set CHROME=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe
if not defined CHROME ( echo Chrome introuvable & exit /b 1 )
start "" "%CHROME%" --remote-debugging-port=%PORT%
timeout /t 6 /nobreak >nul
curl.exe -s http://localhost:%PORT%/json/version
echo.
