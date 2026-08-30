@echo off
REM ============================================================
REM ExtensionSync - Batch install extensions from the popup export
REM ============================================================
REM
REM The ExtensionSync popup's "Install Selected" saves a JSON list
REM of extension IDs to:
REM     %USERPROFILE%\Downloads\extensionsync-install.json
REM
REM This script reads that file, looks up each <id>.crx in the crx
REM folder, and batch-installs every CRX found into your Brave/Chrome
REM profile (Developer Mode / unpacked).
REM
REM Prereqs:
REM   - Node.js on PATH
REM   - Your .crx files stored as <id>.crx in one folder (e.g. C:\crx)
REM
REM Usage:
REM   install-extensions.cmd                       (uses C:\crx)
REM   install-extensions.cmd D:\my-crx            (custom crx folder)
REM   install-extensions.cmd D:\my-crx --browser chrome
REM ============================================================

setlocal

set "SCRIPT_DIR=%~dp0"
set "EXPORT=%USERPROFILE%\Downloads\extensionsync-install.json"
set "CRX_DIR=%~1"
if "%CRX_DIR%"=="" set "CRX_DIR=C:\crx"

if not exist "%SCRIPT_DIR%install-crx.js" (
  echo [ERROR] install-crx.js not found next to this script.
  exit /b 1
)

if not exist "%EXPORT%" (
  echo [ERROR] No export found at %EXPORT%
  echo          Open the ExtensionSync popup, select extensions in Search,
  echo          and click "Install Selected" first.
  exit /b 1
)

node "%SCRIPT_DIR%install-crx.js" --file "%EXPORT%" --crx-dir "%CRX_DIR%" %*
if errorlevel 1 (
  echo.
  echo Install finished with warnings. See messages above.
)

echo.
echo Next: quit all browser windows, reopen, go to chrome://extensions
echo (or brave://extensions), enable Developer mode, and reload the page.

endlocal
exit /b 0
