@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo  === git add ===
git add .

echo.
echo  === git commit ===
git commit -m "更新"

echo.
echo  === git push ===
git push

echo.
echo  完了しました。
pause
