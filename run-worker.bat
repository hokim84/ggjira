@echo off
rem Starts a GGJIRA Worker on this machine, without Docker or a VM (runbook section 33).
rem Worker home: GGJIRA_WORKER_HOME, else data\worker in this folder (ADR 0065).
rem It holds worker.config.json, the credential, clones and logs. The first run asks for the Router
rem address, the LLM CLI, a pairing code (Router web UI > Workers > Add) and repository folders.
rem Ctrl+C once: finish the current job and stop. Twice: stop now.
setlocal
cd /d "%~dp0"
title GGJIRA Worker
call :prerequisites || goto :failed

node --import tsx src\cli.ts worker start %*
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo The Worker stopped with an error. Read the lines above (runbook sections 18 and 33).
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
