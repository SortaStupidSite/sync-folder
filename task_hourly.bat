@echo off
cd /d %~dp0

echo ============================
echo Pulling latest from git...
echo ============================

git fetch --all
git reset --hard origin/main
git pull

./connect.bat

echo.
echo ============================
echo Starting Node script...
echo ============================

node watcher.js SimlinkCopy