@echo off
cd /d "C:\projects\Ambulance Dispatch"
set "REGION_COMMAND_ENABLED=true"
if not exist logs mkdir logs
start "ems-platform" /min cmd /c "node server.js >> logs\server-console.log 2>&1"
exit /b 0
