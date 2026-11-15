@echo off
chcp 65001 >nul
cd /d "C:\projects\Ambulance Dispatch"
set "REGION_COMMAND_ENABLED=true"
echo تشغيل منصة الجنوب محليًا على المنفذ 3002 ...
echo لإيقاف الخادم: Ctrl+C في هذه النافذة
echo.
npm run dev
pause
