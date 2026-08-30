# IMPORT-SAFETY-FIX-REPORT — تقرير تنفيذ Schedule Import Safety Fix (G1+G2)

**التاريخ:** 2026-08-30 · **النطاق:** تنفيذ محلي فقط — **لا Commit، لا Push، لا Deploy**
**يستند إلى:** SCHEDULE-IMPORT-HISTORICAL-DIAGNOSIS.md (معتمد PASS) — لا تعديل خارج G1/G2

---

## ١. ما تغيّر (4 ملفات، +95/−23)

### G1 — تثبيت حمولة «كتابة فوق» (`public/smart-schedule.html`)
- `saveToServer(opts)`: يقبل `opts.fixedPayload`؛ مودال 409 أصبح يعيد إرسال
  **حمولة الطلب الأول نفسها** مع `confirmOverwriteManual: true` بدل إعادة البناء
  من `employees` (التي تكون قد استُبدلت بإعادة القراءة بعد الـ409).
- `oiSaveToServer(confirmOverwrite, fixedPayload)`: نفس العقد على قناة
  official-import — الـcallback يرسل `oiSaveToServer(true, payload)` الحمولة الأولى.
- بعد نجاح الكتابة فوق: إعادة قراءة من القاعدة (`fetchEmployeesFromDBSilent` ←
  `adoptServerEmployees`) فينعكس الشهر الجديد في الواجهة فورًا من مصدر الحقيقة.

### G2 — حارس المسح الصامت (`services/roster-sync-service.js` + `server.js`)
- الخدمة: فحص مبكر **قبل أي كتابة** — حمولة الاستيراد العادي التي لا تُنتج أي مدخل
  بتاريخ صالح (`periods` ستكون فارغة) تُرفض بخطأ مصرَّح `EMPTY_PERIODS_GUARD`
  مع عدّاد المداخل المرفوضة. المسح الشامل أصبح مشروطًا بـ`explicitClear: true`.
- `handleScheduleEmployeesSave` (official-import + schedule/employees): الحارس →
  **422** برسالة عربية واضحة + `skippedEntries`. وأُعيد الترتيب: **المزامنة أولًا
  ثم JSON** — لا يُكتب JSON لحمولة مرفوضة.
- المسار القديم `/api/shift-roster/import`: نفس الحارس → 422.
- `DELETE /api/schedule/employees`: يمرّر `explicitClear: true` — المسح الصريح
  و`clear-all` يعملان كما صُمما.

### تحديث عقدة اختبار قائمة (`scripts/test-schedule-features.js`)
الانحداران الوحيدان كانا في هذا الملف: عُدته تستورد بـ`schedule: []` — وهو بالضبط
ما يمنعه G2 الآن (422 مقصود). حُدّثت الحمولة بمدخل صالح واحد لكل موظف مع بقاء
دلالة اختبار التعارض كما هي → عاد **24/24**.

## ٢. اختبار القبول — 27/27 ✅ (قاعدة معزولة طازجة، PORT 3094)

### جدول الإثبات المطلوب

| السيناريو | payload | periods | JSON | shift_roster | months API | النتيجة |
|---|---|---|---|---|---|---|
| ① استيراد 7/8/9 صحيح بلا تعارض | ✅ مداخل صالحة | `["2026-7"…"2026-9"]` | كُتب بعد النجاح | بُنيت 3 شهور | `["2026-07","2026-08","2026-09"]` | ✅ 200 |
| ② 409 → كتابة فوق بالحمولة الأصلية | ✅ نفس حمولة 2026-09 حرفيًا | `["2026-9"]` | كُتب بعد النجاح | **يحتوي 2026-09 (5 صفوف)** | **يظهر 2026-09** | ✅ 200 + manualOverwritten=1 |
| ③ حمولة بلا تواريخ صالحة | ❌ `2026-00-XX`/فارغة | — (رُفض قبل الكتابة) | **لم تُكتب** | **بلا تغيير (11 صفًا)** | بلا تغيير | ✅ **422 واضح** |
| ④ حمولة مختلطة (صالح+مشوه) | جزئية | `["2026-9"]` | كُتب | بُنى الصالح فقط | بلا تغيير | ✅ 200 + **skippedEntries=1 ظاهر** |
| ⑤ clear-all / DELETE الصريح | — | مسح مقصود | محيَّد | صفر (مقصود) | فارغة (مقصود) | ✅ 200 يعمل كما صُمم |
| ⑥ استيراد 9 لا يمس 8 | ✅ | `["2026-9"]` | — | c8: 3→3 · c7: 3→3 | بلا تغيير | ✅ |
| ⑦ تتابع 7→8→9 | ✅ | لكلٍّ فترته | — | الثلاثة حاضرة | الثلاثة ظاهرة | ✅ |
| ⑧ إعادة استيراد نفس الشهر | ✅ برموز جديدة | `["2026-9"]` | — | أُعيد بناؤه (4 N12) | بلا تغيير | ✅ |
| ⑨ تعارض manual ثم overwrite | ✅ | `["2026-9"]` | — | manual أُنهي + import جديد | يظهر 9 | ✅ overwritten=1 |
| ⑩ مصفوفة فارغة عبر القنوات الثلاث | `employees: []` | — (رُفض) | لم تُكتب | بلا تغيير | بلا تغيير | ✅ 422 ×3 |

### إثبات استحالة المسح الصامت (البند الخاص)
- `POST /api/schedule/official-import {employees: []}` → **422**، roster سليم.
- `POST /api/schedule/employees {employees: []}` → **422**، roster سليم.
- `POST /api/shift-roster/import` بتواريخ مشوهة → **422**، roster سليم.
- حمولة بمداخل مشوهة بالكامل → **422** قبل أي كتابة (الحارس يسبق المعاملة).
- `DELETE FROM shift_roster` الشامل (roster-sync-service.js:323) لم يعد reachable
  إلا عبر `explicitClear: true` — ولا يمرّره إلا `DELETE /api/schedule/employees`.
  clear-all يستخدم `db.ShiftRoster.deleteAll()` المستقل أصلًا.

## ٣. عدم الانحدار

| المجموعة | النتيجة | ملاحظة |
|---|---|---|
| test-write-channels-ssot | **15/15 ✅** | — |
| test-schedule-features | **24/24 ✅** | بعد تحديث العقدة لعقد G2 الجديد |
| hours-metrics-test | **9/9 ✅** | — |
| test-final-acceptance | 14/15 — فشل ⑤ «التكميل يعرض F001» | **مطابق قبل/بعد تعديلي (baseline عبر stash)** — قديم لا علاقة له بـG1/G2 |
| test-pdf-ssot | فشل «تسميم الخلية في JSON» | **مطابق قبل/بعد** — قديم |
| test-phone-features | ECONNREFUSED | يتطلب خادمًا خارجيًا على :3082 — بيئي، قديم |

## ٤. git status

```
M  public/smart-schedule.html        (G1)
M  services/roster-sync-service.js   (G2 الحارس)
M  server.js                         (G2 القنوات + الترتيب)
M  scripts/test-schedule-features.js (عقدة محدثة للعقد الجديد)
?? تقارير التشخيص/النشر + pi4-preview-gen.js (مستبعد) — بلا Commit/Push/Deploy
```

**متوقف للمراجعة.** بعد الاعتماد: تجربة شهر 9 على السيرفر الحقيقي مرة ثانية قبل اعتماد الإصدار.
