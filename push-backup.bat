@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed or not available in PATH.
  exit /b 1
)

git rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo This folder is not a Git repository.
  exit /b 1
)

set "MESSAGE=%*"
if "%MESSAGE%"=="" (
  for /f "tokens=1-3 delims=/ " %%a in ("%date%") do set "TODAY=%%a-%%b-%%c"
  set "NOW=%time::=-%"
  set "NOW=!NOW:.=-!"
  set "NOW=!NOW: =0!"
  set "MESSAGE=Backup changes !TODAY! !NOW!"
)

echo.
echo Checking changes...
git status --short

echo.
echo Staging changes...
git add -A

git diff --cached --quiet
if not errorlevel 1 (
  echo No changes to commit.
  exit /b 0
)

echo.
echo Committing: %MESSAGE%
git commit -m "%MESSAGE%"
if errorlevel 1 exit /b 1

echo.
echo Pushing to GitHub...
git push
if errorlevel 1 exit /b 1

echo.
echo Backup pushed successfully.
endlocal
