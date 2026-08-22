@echo off
chcp 65001 >nul
cd /d "C:\projects\Ambulance Dispatch"
echo تشغيل منصة الجنوب محليًا على المنفذ 3002 ...
echo لإيقاف الخادم: Ctrl+C في هذه النافذة
echo.
npm run dev
pause
