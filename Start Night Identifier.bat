@echo off
setlocal

cd /d "%~dp0"

REM Some terminal/dev-tool setups leave this set, which breaks Electron's
REM own GUI launch (it makes Electron run as plain Node instead). Clearing
REM it here is cheap insurance and harmless if it was never set.
set ELECTRON_RUN_AS_NODE=

if not exist "node_modules" (
    echo Installing dependencies for the first time, this may take a minute...
    call npm install
    if errorlevel 1 goto :error
)
if not exist "frontend\node_modules" (
    echo Installing frontend dependencies for the first time, this may take a minute...
    call npm install --prefix frontend
    if errorlevel 1 goto :error
)

echo Starting Night Sky Object Identifier...
echo (closing this window will stop the app)
echo.
call npm run dev
if errorlevel 1 goto :error

goto :eof

:error
echo.
echo Something went wrong starting the app. See the messages above.
pause
