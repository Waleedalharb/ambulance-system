# SYSTEM_ARCHITECTURE — معمارية منصة الجنوب

> وثيقة مرجعية لأي مطور جديد. كل ما فيها مستخرج من الكود الفعلي.
> آخر تحديث: 2026-07-26 (بعد إغلاق مرحلة توحيد التوقيت والمشروع الواحد).

## ١) المشروع الوحيد (Single Source of Truth)

- المسار الوحيد المعتمد: `C:\projects\Ambulance Dispatch`
- أي نسخة أخرى (`workspace\ambulance-dispatch-live-ARCHIVE` وغيرها) أرشيف قراءة فقط — يُمنع تشغيلها.
- خادم واحد: `server.js` على المنفذ `3002` (افتراضي `process.env.PORT || 3002`).

## ٢) مصادر الحقيقة الوحيدة

| المجال | المصدر الوحيد | الملف |
|---|---|---|
| البيانات (الفرق، الموظفون، المناوبات، الأحداث التشغيلية، سير العمل) | قاعدة SQLite بنمط WAL | `ambulance.db` عبر `db.js` — الافتراضي `STORAGE_PATH/ambulance.db` (قرص `/data` على Render عبر `RENDER_DISK_PATH`، محليًا `data/`) مع ترحيل تلقائي لمرة واحدة من `database.db` القديمة في الجذر؛ `DB_PATH` لتجاوز الاختبارات |
| التاريخ والوقت (عرض + منطق كشف المناوبة) | طبقة TimeRiyadh (UMD: متصفح + Node) — التخزين UTC دائمًا، العرض Asia/Riyadh عبر `Intl.DateTimeFormat` فقط | `public/js/time-riyadh.js` + سياسة `TIME-POLICY.md` + حارس `scripts/guard-time-riyadh.js` |
| الجداول (تعيين الموظفين للمناوبات) | ملف الجدولة + مزامنته إلى قاعدة البيانات | `data/schedule-employees.json` (`SCHEDULE_FILE` لتجاوز الاختبارات) + `services/roster-sync-service.js` |
| حالة القوى البشرية (جاهزية الفرق: غياب/تأخر/دعم) | أحداث Timeline فقط — تُشتق الحالة من الأحداث ولا تُحسب محليًا أبدًا | `services/staffing-events-service.js` (`deriveTeamReadiness`) + جدول `operational_events` |
| التكميل | يقرأ/يكتب عبر أحداث القوى، صفر كتابة في الجداول القائمة | `services/completion-service.js` |
| المركبات | أحداث المركبات (تعيين/نقل/دعم/إنهاء دعم) | `services/vehicle-events-service.js` |
| سير العمل الرسمي (الوثيقة) | `services/workflow-service.js` — المسودة حية (تُقرأ من المصدر عند كل فتح)، التجميد عند الاعتماد فقط (Snapshot + مرجع `SRCA-SR-OPS-YYYY-NNNNNN` + بصمة SHA-256) | `services/workflow-service.js` |
| PDF الوثيقة المعتمدة | يُولَّد مرة واحدة عند الاعتماد ويُحفظ | `services/workflow-pdf-service.js` → `data/archives/workflows/` |
| التحديث اللحظي للواجهات | ناقل الأحداث SSE | `services/event-bus.js` |
| ترتيب الفرق (فرز رقمي: جنوب 1..19 ثم سريع 1..4) | مركزي واحد لكل الشاشات والـ PDF | `services/team-order.js` |

## ٣) قلب النظام: OperationsEngine

```
Frontend (public/*.html)  →  server.js (Express API)  →  OperationsEngine (ops-engine.js)
                                                              ↓
                                                    StorageAdapter (storage-adapter.js)
                                                              ↓
                                                    SQLite (database.db — WAL)
```

- `ops-engine.js` — «قلب المنصة»: لا وصول مباشر لـ SQLite/JSON من الـ endpoints أو الـ managers.
- `managers.js` — منطق النطاق (ShiftManager / ReportManager / CompletionManager)؛ لا يتحدث مع SQLite مباشرة.
- `shift-archive-engine.js` — أرشفة المناوبات.

## ٤) الخدمات (services/)

| الخدمة | الدور |
|---|---|
| `event-bus.js` | SSE — بث التحديثات اللحظية لكل الشاشات |
| `shift-service.js` | دورة المناوبة (بدء/إنهاء/أرشفة) |
| `staffing-events-service.js` | أحداث القوى + اشتقاق جاهزية الفرق (مصدر «باقي X فرق» الوحيد) |
| `vehicle-events-service.js` | أحداث المركبات |
| `completion-service.js` | صفحة التكميل — تفويض كامل لخدمة الأحداث |
| `workflow-service.js` | دورة اعتماد سير العمل (مسودة حية → اعتماد → قفل → إصدارات V1/V2) |
| `workflow-pdf-service.js` | توليد PDF الرسمي (4 أعمدة + ختم + QR) |
| `report-service.js` | البلاغات/التقارير |
| `roster-sync-service.js` | مزامنة الجدولة إلى القاعدة |
| `operational-events-core.js` | نواة جدول الأحداث التشغيلية |
| `archive-service.js` | الأرشيف العام |
| `indicator-service.js` | المؤشرات |
| `positioning-service.js` | التموضع |
| `notes-service.js` / `forms-service.js` | الملاحظات / النماذج |
| `team-order.js` | الفرز الرقمي المركزي للفرق |

## ٥) تدفق البيانات النموذجي

1. المشرف يسجّل غيابًا من صفحة التكميل → `completion-service` → `staffing-events-service` يكتب حدثًا في `operational_events`.
2. `deriveTeamReadiness` يشتق الحالة الجديدة للفرقة → `event-bus` يبثها عبر SSE → كل الشاشات تتحدث لحظيًا (الواجهة تعرض فقط ولا تحسب).
3. عداد «باقي X فرق» وسير العمل يقرآن من **نفس** مصدر الاشتقاق (مصدر حقيقة واحد — لا يوجد حسابان).
4. عند الاعتماد: `workflow-service` يلتقط Snapshot نهائية → `workflow-pdf-service` يولّد PDF → يُحفظ في `data/archives/workflows/` → تُقفل النسخة نهائيًا (أي تعديل لاحق = إصدار جديد V2 يُبقي V1 كما هي).

## ٦) قواعد التسليم (ملزمة)

1. **أي تعديل على أي ملف = تشغيل الانحدار** `scripts/regression-test.js` على بيئة معزولة (`DB_PATH`+`SCHEDULE_FILE` مؤقتان + منفذ مستقل) قبل التسليم — بلا استثناء (قرار المالك). المرجع: 202/213.
2. **حارس التوقيت** `node scripts/guard-time-riyadh.js` يجب أن يمر (exit 0) قبل أي commit — المنصة ميلادية حصرًا، والهجري نمط محظور.
3. ممنوع commit نهائيًا إلا بأمر صريح من المالك.
4. اختبارات الانحدار لا تكتب في الأرشيف الحقيقي — بعد كل جولة تحقق أن `data/archives/workflows/` يحتوي الوثائق الرسمية فقط.
