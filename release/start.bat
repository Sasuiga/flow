@echo off
title flow - Bank Statement Workbench
cd /d "%~dp0"
rem 要改目录选择器的根目录：取消下行注释并修改（不填=当前用户主目录）
rem set FLOW_DOC_ROOT=C:\flow-data
echo Starting flow service...
start /min node\node.exe main.js
timeout /t 2 >nul
start "" http://localhost:4120
echo.
echo  flow started:  http://localhost:4120
echo  (Keep the minimized "flow" window open while using the app.)
echo  (To stop the service, close that minimized window.)
pause
