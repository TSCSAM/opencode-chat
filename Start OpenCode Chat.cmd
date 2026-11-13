@echo off
setlocal
title OpenCode Chat

rem Portable launcher: the app source lives in app\ next to this file.
rem Move the folder, rename it, put it on another drive - it still works.
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "APP=%ROOT%\app"

if not exist "%APP%\server\server.mjs" (
  echo.
  echo   app\server\server.mjs was not found next to this file.
  echo.
  echo   Keep "Start OpenCode Chat.cmd" in the project folder, with the
  echo   app and docs folders beside it, and run it again.
  echo.
  echo   Looked in: %APP%
  echo.
  pause
  exit /b 1
)

cd /d "%APP%"
if errorlevel 1 (
  echo   Cannot open folder: %APP%
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

set "NEEDS_INSTALL=0"
if exist "%APP%\tools\check-deps.mjs" (
  for /f %%B in ('node "%APP%\tools\check-deps.mjs"') do set "NEEDS_INSTALL=%%B"
) else if not exist "node_modules\@opencode\client" (
  set "NEEDS_INSTALL=1"
)
if "%NEEDS_INSTALL%"=="1" (
  echo.
  echo   First run or dependency update - downloading required files...
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo   Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem Build when there is no bundle yet, or when the sources are newer than the
rem bundle. The check lives in a subroutine so that %NEEDS_BUILD% is expanded
rem at execution time instead of when the block is parsed.
call :check_build
if "%NEEDS_BUILD%"=="1" goto build
goto build_done

:build
echo   Building the app...
call npm run build
if errorlevel 1 (
  echo.
  echo   Build failed.
  pause
  exit /b 1
)

:build_done
rem Where new chats point by default: the project folder that contains app\.
rem Drop another folder onto this file to use that one instead.
set "TARGET=%ROOT%"
if not "%~1"=="" (
  if exist "%~1\" (set "TARGET=%~1") else (for %%I in ("%~1") do set "TARGET=%%~dpI")
)
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

echo.
echo   App:     %APP%
echo   Project: %TARGET%
echo.

rem Start the server hidden and detached, then let this console window close.
rem The app's Exit button stops both the server and the OpenCode engine.
if exist "%APP%\tools\launch.mjs" (
  node "%APP%\tools\launch.mjs" --dir="%TARGET%"
) else (
  node "%APP%\server\server.mjs" --prod --open --dir="%TARGET%"
)
if errorlevel 1 (
  echo.
  echo   Failed to start. Read the message above.
  pause
)
exit /b 0

rem ---------------------------------------------------------------------------
rem Sets NEEDS_BUILD to 1 when app\dist\index.html is missing or older than the
rem newest file under app\src. The check is a tiny Node script so launching the
rem app does not depend on PowerShell.
:check_build
set "NEEDS_BUILD=0"
if not exist "%APP%\tools\build-check.mjs" goto :eof
for /f %%B in ('node "%APP%\tools\build-check.mjs"') do set "NEEDS_BUILD=%%B"
goto :eof
