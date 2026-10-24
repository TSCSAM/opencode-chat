@echo off
setlocal
title OpenCode Chat

rem Portable launcher: everything is relative to the folder this file sits in.
rem Move the folder, rename it, put it on another drive - it still works.
set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"

if not exist "%APP%\server.mjs" (
  echo.
  echo   server.mjs was not found next to this file.
  echo.
  echo   Keep "Start OpenCode Chat.cmd" inside the app folder
  echo   ^(or make a shortcut to it^) and run it again.
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

if not exist "node_modules\@opencode\client" (
  echo.
  echo   First run - installing dependencies. This takes a minute...
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo   Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo   Building the app...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   Build failed.
    pause
    exit /b 1
  )
)

rem Where new chats point by default: this very folder.
rem Drop another folder onto this file to use that one instead.
set "TARGET=%APP%"
if not "%~1"=="" (
  if exist "%~1\" (set "TARGET=%~1") else (for %%I in ("%~1") do set "TARGET=%%~dpI")
)
if "%TARGET:~-1%"=="\" set "TARGET=%TARGET:~0,-1%"

echo.
echo   App:     %APP%
echo   Project: %TARGET%
echo.

node server.mjs --prod --open --dir="%TARGET%"
if errorlevel 1 (
  echo.
  echo   Failed to start. Read the message above.
  pause
)
