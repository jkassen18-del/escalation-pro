@echo off
setlocal
set REPO=C:\Users\Jamal\Documents\escalation-pro
set MSG=feat: docker + postgres sql backend + render cloud deployment

:retry
del /f "%REPO%\.git\index.lock" 2>nul
git -C "%REPO%" add -A
if errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto retry
)
echo Staged OK
git -C "%REPO%" commit -m "%MSG%"
if errorlevel 1 (
  echo COMMIT FAILED
  exit /b 1
)
echo COMMITTED OK
git -C "%REPO%" log --oneline -3
