@echo off
rem Starts the GGJIRA Router on this machine, without Docker or a VM (runbook section 33).
rem Config: router.config.json here, or GGJIRA_ROUTER_CONFIG. Without it the Router opens the
rem setup wizard. Extra arguments go to "router serve", e.g.  run-router.bat --port 8788
setlocal
cd /d "%~dp0"
title GGJIRA Router
call :prerequisites || goto :failed

if not defined GGJIRA_ROUTER_CONFIG set "GGJIRA_ROUTER_CONFIG=router.config.json"
if not exist "%GGJIRA_ROUTER_CONFIG%" (
  echo No %GGJIRA_ROUTER_CONFIG% yet: the Router starts in setup mode.
  echo Open the /ui/ address printed below and enter the setup token, then restart this window.
  echo.
)
node --import tsx src\cli.ts router serve %*
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo The Router stopped with an error. Read the lines above (runbook section 33).
pause
exit /b 1

:prerequisites
where node >nul 2>nul || (
  echo Node.js 24 or later is required: https://nodejs.org/
  exit /b 1
)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do (
  if %%v LSS 24 (
    echo Node.js 24 or later is required; this is Node.js %%v.
    exit /b 1
  )
)
if not exist node_modules\tsx (
  echo Installing dependencies ^(first run only^)...
  call npm install || exit /b 1
)
exit /b 0
