@echo off
rem Starts the GGJIRA Router and one Worker on this machine, each in its own window, without
rem Docker or a VM (runbook section 33). Close a window or press Ctrl+C in it to stop that part.
setlocal
cd /d "%CD%"

if not defined GGJIRA_ROUTER_CONFIG set "GGJIRA_ROUTER_CONFIG=router.config.json"
set "PORT=8787"
for /f "usebackq delims=" %%p in (`node -p "try { require(require('path').resolve(process.env.GGJIRA_ROUTER_CONFIG)).http?.port ?? 8787 } catch { 8787 }" 2^>nul`) do set "PORT=%%p"
set "HEALTH=http://127.0.0.1:%PORT%/health"

curl.exe -sf -o nul "%HEALTH%" && (
  echo A Router already answers on port %PORT%; starting only the Worker.
  goto :worker
)
start "GGJIRA Router" /d "%CD%" cmd /c "%~dp0run-router.bat"
echo Waiting for the Router on port %PORT%...
for /l %%i in (1,1,60) do (
  curl.exe -sf -o nul "%HEALTH%" && goto :worker
  ping -n 2 127.0.0.1 >nul
)
echo The Router did not answer on %HEALTH% within 60 seconds. Check the Router window.
pause
exit /b 1

:worker
curl.exe -s "%HEALTH%" | findstr /c:"\"mode\":\"setup\"" >nul && (
  echo The Router is in setup mode: finish the wizard in the browser, restart the Router window,
  echo then pair the Worker with a code from the web UI ^(Workers ^> Add^).
)
start "GGJIRA Worker" /d "%CD%" cmd /c "%~dp0run-worker.bat"
echo Router: http://127.0.0.1:%PORT%/ui/
exit /b 0
