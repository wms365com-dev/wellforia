@echo off
setlocal

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not available in PATH.
  pause
  exit /b 1
)

echo.
echo Current branch and status:
git status --short --branch
echo.

set /p COMMIT_MSG=Enter commit message for GitHub push: 
if "%COMMIT_MSG%"=="" set "COMMIT_MSG=Update Railway web app"

echo.
echo Staging files...
git add .
if errorlevel 1 (
  echo Failed to stage files.
  pause
  exit /b 1
)

echo.
echo Creating commit...
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo No new commit created. This may mean there were no changes to commit.
)

echo.
echo Pushing to GitHub main...
git push origin main
if errorlevel 1 (
  echo Push failed.
  pause
  exit /b 1
)

echo.
echo Push complete.
pause
exit /b 0
