# خطة تطوير الوكيل الذكي — AI Monitor v2.0

## الهدف
وكيل ذاتي الشفاء (Self-Healing Agent) يراقب كل طبقات النظام ويصلح الأخطاء تلقائياً بدون تدخل بشري.

## المراحل

### Stage 1: Frontend Error Reporter ⏳
**الملفات:** `public/js/frontend-monitor.js` (جديد), `server.js` (تعديل)
**الوصف:** كود في المتصفح يلتقط كل أخطاء JavaScript ويرسلها للسيرفر
**التفاصيل:**
- `window.onerror` — SyntaxError, ReferenceError, TypeError
- `window.addEventListener('error')` — أخطاء الموارد (صور, CSS)
- `window.addEventListener('unhandledrejection')` — Promises مرفوضة
- `console.error` override — تتبع أخطاء console
- API endpoint: `POST /api/frontend-errors` — يستقبل ويسجل
- جدول SQLite: `frontend_errors`

### Stage 2: AI Monitor Enhancement (Logic & Data Checks) ⏳
**الملفات:** `ai-monitor.js` (تعديل)
**الوصف:** فحوصات منطقية دورية فوق الفحوصات التقنية الحالية
**القواعد الجديدة:**
- Rule 8: فحص تواريخ المناوبات (هل التاريخ يتوافق مع نوع المناوبة؟)
- Rule 9: فحص `staffCount` vs عدد المسعفين المسندين
- Rule 10: فحص مناوبات معلقة (started بدون endTime > 24h)
- Rule 11: فحص `currentShiftId` يشير لمنوبة موجودة
- Rule 12: فحص بلاغات بدون مركز أو فريق
- Rule 13: فحص تكرار البيانات (duplicate shifts, duplicate reports)
- Rule 14: فحص حجم قاعدة البيانات (>50MB → تنبيه)
- Rule 15: فحص بلاغات قديمة جداً (>90 يوم → اقتراح أرشفة)

### Stage 3: Auto-Fix Engine ⏳
**الملفات:** `auto-fix-engine.js` (جديد), `ai-monitor.js` (تعديل)
**الوصف:** محرك إصلاح تلقائي للبيانات التالفة
**القواعد:**
- Fix 1: تصحيح `shiftDate` للمناوبات الليلية (يجب أن يكون تاريخ البدء لا النهاية)
- Fix 2: إكمال `staffCount` من عدد المسعفين الحاضرين لو كان صفر
- Fix 3: إغلاق المناوبات المعلقة تلقائياً (>24h)
- Fix 4: حذف البلاغات التجريبية (فارغة أو بعنوان "test")
- Fix 5: دمج مناوبات مكررة لنفس اليوم ونفس النوع
- Fix 6: تصحيح `currentShiftId` لو يشير لمنوبة محذوفة
- Fix 7: مسح الـ cache القديم في localStorage (>30 يوم)

### Stage 4: Dashboard Enhancement ⏳
**الملفات:** `public/admin-dashboard.html` (تعديل)
**الوصف:** تحديث لوحة المراقبة لتعرض:
- Frontend Errors (أخطاء المتصفح)
- Auto-Fix Log (سجل الإصلاحات التلقائية)
- Data Integrity Score (درجة صحة البيانات)
- Quick Actions: "تشغيل فحص شامل", "تشغيل إصلاح شامل"

### Stage 5: Integration & Testing ⏳
**الوصف:** ربط كل الأجزاء واختبارها
**الاختبارات:**
- إنشاء خطأ JavaScript في المتصفح → هل وصل للسيرفر؟
- إنشاء مناوبة بتاريخ غلط → هل صُحح تلقائياً؟
- إنشاء مناوبة معلقة → هل أُغلقت تلقائياً؟

## ملاحظات التنفيذ
- كل Stage يُنفذ بالكامل قبل الانتقال للتالي
- النسخة الجديدة: `v19-2026-07-06`
- لا حاجة لـ subagents — الملفات تتداخل والتسلسل ضروري
