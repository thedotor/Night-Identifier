@echo off
setlocal

cd /d "%~dp0"

REM Builds the standalone installer (frontend\release\Night-Identifier-Setup.exe).
REM Run it again after any change; the slow backend build is skipped when the backend didn't change.
REM   Build Installer.bat -ForceBackend   rebuilds the backend regardless

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-installer.ps1" %*
if errorlevel 1 goto :error

echo.
choice /m "Run the installer now (this upgrades an existing install in place)"
if errorlevel 2 goto :eof
start "" "frontend\release\Night-Identifier-Setup.exe"
goto :eof

:error
echo.
echo The build failed. See the messages above.
pause
exit /b 1
