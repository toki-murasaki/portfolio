@echo off
cd /d "%~dp0"

echo.
echo === git stash ===
git stash
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] git stash failed. Aborting.
    pause
    exit /b 1
)

echo.
echo === git pull --rebase ===
git pull --rebase
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] git pull --rebase failed. Aborting.
    git stash pop
    pause
    exit /b 1
)

echo.
echo === git stash pop ===
git stash pop
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] git stash pop failed. Aborting.
    pause
    exit /b 1
)

echo.
echo === git add ===
git add .

echo.
echo === git commit ===
git commit -m "update"

echo.
echo === git push ===
git push

echo.
pause
