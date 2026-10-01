@echo off
setlocal EnableExtensions EnableDelayedExpansion
title WE API readonly proxy (8088)
cd /d "%~dp0"

rem ---- Port check ----
netstat -ano | findstr ":8088 " | findstr LISTENING >nul
if not errorlevel 1 (
  echo [INFO] Port 8088 is already in use. The service may already be running.
  echo        Check http://127.0.0.1:8088/health
  echo        To redo the first-run setup, run this script with /setup
  pause
  exit /b 1
)

rem ---- Node check ----
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node.js and try again.
  pause
  exit /b 1
)

rem ---- Dependencies: check direct packages and recover missing installs ----
rem Since 0.5.0 the only direct dependency is wallpaper-engine-api (koffi / jpeg-js
rem were removed with desktop capture). Checking its package.json also catches a
rem half-finished install where the folder exists but the package is incomplete.
if not exist "%~dp0node_modules\wallpaper-engine-api\package.json" goto :install_deps
goto :deps_ready

:install_deps
echo [SETUP] Required packages are missing; running npm install ...
call npm install
if errorlevel 1 (
  echo [ERROR] npm install failed. Check your network / npm registry.
  pause
  exit /b 1
)

:deps_ready

rem ---- First run wizard ----
if /i "%~1"=="/setup" goto :wizard
if exist "%~dp0we-api.config" goto :run

:wizard
echo.
echo ====================== First-run setup ======================
echo This service reads your Wallpaper Engine library (read-only).
echo It needs to know where Wallpaper Engine is installed.
echo.

set "DETECTED="
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Valve\Steam" /v SteamPath 2^>nul ^| findstr /i SteamPath') do set "STEAMROOT=%%b"
if defined STEAMROOT (
  if exist "!STEAMROOT!\steamapps\common\wallpaper_engine\wallpaper64.exe" set "DETECTED=!STEAMROOT!\steamapps\common\wallpaper_engine"
  if exist "!STEAMROOT!\steamapps\common\wallpaper_engine\wallpaper32.exe" set "DETECTED=!STEAMROOT!\steamapps\common\wallpaper_engine"
)
if defined DETECTED goto :confirm
for %%d in (C D E F G H) do (
  if not defined DETECTED if exist "%%d:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe" set "DETECTED=%%d:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine"
  if not defined DETECTED if exist "%%d:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\wallpaper32.exe" set "DETECTED=%%d:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine"
  if not defined DETECTED if exist "%%d:\Program Files\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe" set "DETECTED=%%d:\Program Files\Steam\steamapps\common\wallpaper_engine"
  if not defined DETECTED if exist "%%d:\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe" set "DETECTED=%%d:\Steam\steamapps\common\wallpaper_engine"
  if not defined DETECTED if exist "%%d:\Steam\steamapps\common\wallpaper_engine\wallpaper32.exe" set "DETECTED=%%d:\Steam\steamapps\common\wallpaper_engine"
)

:confirm
if not defined DETECTED goto :manual
if defined DETECTED for %%F in ("!DETECTED!") do set "DETECTED=%%~fF"
echo Wallpaper Engine found:
echo   !DETECTED!
echo.
set "ANSWER=Y"
set /p ANSWER="Use this path? [Y/n] "
if /i "!ANSWER!"=="n" goto :manual
if /i "!ANSWER!"=="no" goto :manual
set "INSTALL=!DETECTED!"
goto :workshop

:manual
echo.
echo Paste the Wallpaper Engine install path. Any of these works:
echo   1. The folder containing wallpaper64.exe / wallpaper32.exe
echo      e.g. D:\Steam\steamapps\common\wallpaper_engine
echo   2. The full path to wallpaper64.exe
echo   3. Your Steam folder - the script will look inside it
echo.
set "USERPATH="
set /p USERPATH="Path: "
if not defined USERPATH goto :manual
set "USERPATH=!USERPATH:"=!"

set "INSTALL=!USERPATH!"
if /i "!USERPATH:~-15!"=="wallpaper64.exe" for %%F in ("!USERPATH!\..") do set "INSTALL=%%~fF"
if /i "!USERPATH:~-15!"=="wallpaper32.exe" for %%F in ("!USERPATH!\..") do set "INSTALL=%%~fF"
if exist "!INSTALL!\wallpaper64.exe" goto :workshop
if exist "!INSTALL!\wallpaper32.exe" goto :workshop
if exist "!INSTALL!\steamapps\common\wallpaper_engine\wallpaper64.exe" (
  set "INSTALL=!INSTALL!\steamapps\common\wallpaper_engine"
  goto :workshop
)
if exist "!INSTALL!\steamapps\common\wallpaper_engine\wallpaper32.exe" (
  set "INSTALL=!INSTALL!\steamapps\common\wallpaper_engine"
  goto :workshop
)
echo [ERROR] wallpaper64.exe / wallpaper32.exe not found under: !INSTALL!
goto :manual

:workshop
for %%F in ("!INSTALL!") do set "INSTALL=%%~fF"
for %%F in ("!INSTALL!\..") do set "WCOMMON=%%~fF"
for %%F in ("!WCOMMON!\..") do set "WSTEAMAPPS=%%~fF"
set "WSDEF=!WSTEAMAPPS!\workshop\content\431960"
echo.
echo Subscribed-wallpaper library folder:
echo   Default: !WSDEF!
set "USERWS="
set /p USERWS="Library path [Enter = default]: "
if not defined USERWS set "USERWS=!WSDEF!"
set "USERWS=!USERWS:"=!"
if exist "!USERWS!" goto :writecfg
echo [WARN] Folder not found: !USERWS!
echo        The wallpaper list may be empty. Edit we-api.config later if needed.

:writecfg
(
  echo # WE API proxy config - generated by the first-run wizard
  echo # Desktop wallpaper sync just follows WE's current desktop wallpaper,
  echo # read-only: every type renders normally and scenes show their workshop
  echo # preview image. Nothing is sampled, rendered or written to disk.
  echo WE_INSTALL_PATH=!INSTALL!
  echo WE_WORKSHOP_PATH=!USERWS!
) > "%~dp0we-api.config"
echo.
echo Saved to we-api.config.
echo Desktop wallpaper sync needs nothing enabled: it follows WE's current wallpaper.
echo To redo this setup later, run this script with /setup

:run
echo.
echo ---- Current config ----
for /f "usebackq eol=# delims=" %%L in ("%~dp0we-api.config") do echo   %%L
echo.
echo [START] WE API readonly proxy - http://127.0.0.1:8088
echo Press Ctrl+C or close this window to stop.
echo.
rem Tip: for background (hidden-window) start, double-click 启动服务-静默.vbs
node "%~dp0server.js"
pause
exit /b
