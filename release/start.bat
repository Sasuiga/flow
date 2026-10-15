@echo off
title flow - Bank Statement Workbench
cd /d "%~dp0"
rem 要改目录选择器的根目录：取消下行注释并修改（不填=当前用户主目录）
rem set FLOW_DOC_ROOT=C:\flow-data
echo Starting flow service...
rem 日志留给启动失败时看。最小化窗口标题必须是第一个带引号的参数，否则 start 会把路径当成窗口标题。
start "flow" /D "%~dp0" /min cmd /c "node\node.exe main.js > flow.log 2>&1"
set N=0
:waitloop
timeout /t 1 >nul
set /a N+=1
node\node.exe -e "fetch('http://127.0.0.1:4120/api/health').then(function(){process.exit(0)}).catch(function(){process.exit(1)})"
if not errorlevel 1 goto ready
if %N% GEQ 20 goto failed
goto waitloop
:ready
start "" http://localhost:4120
echo.
echo  flow started:  http://localhost:4120
echo  (Keep the minimized "flow" window open while using the app.)
echo  (To stop the service, close that minimized window.)
pause
exit /b 0
:failed
echo.
echo  flow did not start. The service window closed because Node exited.
echo  Log: %~dp0flow.log
echo ----------------------------------------
type flow.log
echo ----------------------------------------
pause
exit /b 1
