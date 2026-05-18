@echo off
cd /d "%~dp0"

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
