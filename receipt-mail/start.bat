@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Receipt Mail Server
node server.js
pause
