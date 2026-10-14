@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Book Stock Server
node server.js
pause
