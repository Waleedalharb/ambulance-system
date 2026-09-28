# Native Schedule Parity — تصميم مجال الجداول (المجال 7)

**الغاية:** تكافؤ وظيفي كامل لنظام الجداول القائم — بلا محرك جدولة ثانٍ،
وبلا اختراع قواعد. كل حكم (تعارض/صلاحية/تحقق) يصدر من الـBackend ويُعرض كما هو.

**مصدر الحقيقة للفحص:** `server.js` (9613–9678 · 10052–10320 · 11407–12558 ·
13341–13461) + `db.js` (ShiftRoster/ShiftAuditLog/ShiftRosterDrafts) +
`config/permissions.js`.

---

## ① نموذج القراءة (مُتحقق من المصدر)

| المسار | الصلاحية | الشكل |
|---|---|---|
| `GET /api/shift-roster?month&year` | `schedule.view` | `{success, roster:[{id, employee_id, team_id, shift_date, shift_code, month, year, created_at, employee_name, employee_code, team_name}]}` — مرتبة (التاريخ، الفريق، الموظف) |
| `GET /api/shift-roster/months` | `schedule.view` | `{success, months:["YYYY-MM"…]}` تصاعديًا |
| `GET /api/shift-roster/stats?month&year` | `schedule.view` | `{success, total_shifts, employees_count, shift_code_breakdown{}, team_coverage{}, conflicts_count}` |
| `GET /api/shift-roster/:id` | `schedule.view` | `{success, entry}` |
| `GET /api/shift-roster/employee-schedule/:employeeId?month&year` | `schedule.view` | `{success, schedule:[{date, shift_code, shift_name, team_name, team_id}]}` — 403 لدور `user` يعرض غيره |
| `GET /api/shift-roster/audit-log?employee_id\|date_from+date_to\|limit` | `schedule.view` | `{success, entries:[{id, roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code, old_team_id, new_team_id, changed_by, changed_by_name, change_type: edit\|swap\|bulk\|delete\|add, reason, created_at}]}` |
| `GET /api/shift-roster/drafts` | `schedule.view` | `{success, drafts:[{id, draft_data_json, operation_type, created_by, created_by_name, created_at, applied_at, reverted_at}]}` — مسودات المستخدم نفسه |
| `GET /api/shift-codes` | `authenticate` | قائمة الرموز المعتمدة (لمنتقي التحرير) |
| `GET /api/teams` · `GET /api/employees` | `authenticate` | أسماء الفرق/المراكز/الموظفين للعروض |
| `GET /api/schedule/metrics?from&to` | `schedule.view` | مؤشرات الساعات من `ScheduleMetricsService` (لا حساب في العميل) |
| `GET /api/shift-schedule/month?month&year` | `authenticate` | الجدول المولّد (المحرك البديل): `{success, schedule, byDate:{day[],night[],off[],leave[]}, alerts}` |
| `GET /api/check-monthly-table` | `authenticate` | `{exists: bool}` |

## ② نموذج الكتابة (مُتحقق — لا يُختصر لقراءة)

| الإجراء | المسار | الصلاحية | سلوك الخادم الملزم |
|---|---|---|---|
| تعديل خلية (موظف+يوم+رمز) | `PUT /api/shift-roster/cell` `{employeeCode,date,shiftCode}` | `schedule.edit_cell` | تحقق ISO/موظف/رمز (404/400) ← upsert خلية واحدة فقط ← revision+audit+إشعار الموظف+broadcast ← `{success, entry}` |
| إضافة سجل | `POST /api/shift-roster` | `schedule.employees` | validateBody ← إنشاء ← audit+notify |
| تحديث سجل كامل | `PUT /api/shift-roster/:id` | `schedule.employees` | 404 إن فقد ← audit+notify |
| حذف سجل | `DELETE /api/shift-roster/:id` | `schedule.employees` | 404 إن فقد ← audit+notify |
| تحقق مسبق | `POST /api/shift-roster/validate` `{changes[]}` | `schedule.view` | `{valid, conflicts:[{type: missing_fields\|invalid_code\|duplicate\|invalid_team, message}]}` |
| تحديث جماعي | `POST /api/shift-roster/bulk-update` `{changes[]}` | `schedule.bulk_update` | معاملة ذرية ← `{updated, conflicts[], audit_log}` |
| تبديل موظفَين | `POST /api/shift-roster/swap` `{roster_id_1,roster_id_2}` | `schedule.swap` | معاملة ← audit مزدوج ← `{swapped[2]}` |
| مسودة | `POST /api/shift-roster/draft` | `schedule.bulk_update` | حفظ حزمة تغييرات |
| تراجع/إعادة | `POST /api/shift-roster/undo` · `/redo` | `schedule.bulk_update` | **ملاحظة صادقة:** يدير سجل المسودات (علامة reverted) ويعيد آخر مسودة للعميل ليعيد تطبيقها — ليس تراجعًا سيرفريًا عن الصفوف. Native: عرض المسودة المُعادة ثم إعادة تطبيقها عبر `bulk-update` (نفس دلالة الويب) |
| استيراد | `POST /api/shift-roster/import` `{employees,roster,confirmOverwriteManual?}` | `schedule.import` | 409 تعارض يدوي (بلا كتابة) · 422 EMPTY_PERIODS_GUARD · نجاح بإحصاءات المزامنة |
| استيراد رسمي | `POST /api/schedule/official-import` | `schedule.import` | نفس المعالج |
| مزامنة الملفات | `POST /api/schedule/files` | `schedule.sync` | كتابة ملفات الجدولة |
| تصدير JSON | `POST /api/shift-roster/export` `{format,month,year,filters?}` | `schedule.export` | `{download_url, data[], format}` |
| تصدير PDF | `GET /api/schedule/pdf?center\|group&month` | `schedule.export` | **PDF ثنائي حقيقي** (A4 أفقي RTL بترويسة رسمية) — 404 بلا بيانات |
| الجدول الشهري (Excel) | `POST /api/upload-monthly-table` (multipart) · `GET get-monthly-table` · `DELETE /api/monthly-table` | import / clear | ملف Excel خام |
| توليد ذكي | `POST /api/shift-schedule/generate` `{year,month,mode: normal\|alternative}` | دور `admin`/`director` | يحذف ويعيد بناء `shift_schedule_auto` + تنبيهات، معاملة |
| تعديل مولّد | `POST /api/shift-schedule/update` | دور `admin`/`director` | تحديث سجل `shift_schedule_auto` |
| مسح | `POST /api/shift-roster/clear` · `/clear-all` | `schedule.clear` (يدوية حصرًا) | حذف فعلي — تأكيد مزدوج إلزامي في Native |

## ③ قواعد التنفيذ الملزمة

1. **الصلاحيات تُشتق من `PermissionMapper`** — مفاتيح `schedule.*` كلها منح
   فردية؛ من لا يملك المفتاح لا يرى الزر إطلاقًا (والخادم يحسم 403).
2. **الكتابة تتطلب اتصالًا** (`NetworkMonitor`) — لا ادعاء حفظ دون رد الخادم.
3. **الأخطاء تُعرض بلفظ الخادم** (409/422/400/403/404) — لا تعديل صامت للطلب.
4. **الإشعارات:** كل كتابة تُشعِر عبر `fireScheduleChangeNotify` سيرفريًا —
   Native يستهلك `/api/my/notifications` القائم (لا إشعار مكرر من العميل إطلاقًا).
5. **قبل/بعد:** من `old_shift_code/new_shift_code` + `old_team_id/new_team_id`
   في سجل التدقيق؛ أسماء الفرق تُربط من `/api/teams` (ربط عرضي لا اختراع).
6. **فجوة موثقة — استيراد Excel:** الويب يفك Excel في المتصفح ثم يرسل JSON.
   فك xlsx على iOS يتطلب مكتبة خارجية (غير موجودة في المشروع اليدوي).
   **القرار:** الاستيراد من ملف يبقى على الويب لهذه المرحلة؛ إتاحته Native
   تتطلب endpoint فكّ سيرفري (إضافة Backend تحتاج اعتماد تصور مستقل).
   لا نزيّفها بواجهة شكلية.

## ④ بنية Native (iPhone — لا نسخ HTML)

- تبويب جديد **«الجداول»** يظهر لحامل `schedule.view` (منفصل عن «الجدول»
  الشخصي لبوابة الموظف) + مدخل من غرفة العمليات.
- **`ScheduleHubView`**: منتقي شهر (من `/months`) + مقطع عرض:
  شهر / يوم / فريق / موظف / مركز — خمسة وجوه لنفس بيانات الـroster.
  - **شهر:** فرق ← موظفون ← شريط أيام الشهر أفقي (خلية لكل يوم برمزه).
  - **يوم:** منتقي تاريخ ← كل التعيينات مجمعة بالفرق.
  - **فريق:** منتقي فريق ← موظفوه × أيام الشهر.
  - **موظف:** بحث ← جدوله (employee-schedule) + سجل تدقيقه.
  - **مركز:** مراكز ← فرقها ← موظفوها (نفس مكوّن الفريق).
- **نقر خلية ← `ScheduleCellSheet`:** التعيين الحالي (الموظف/التاريخ/الرمز/
  الفريق) + الإجراءات المُصرّحة فقط:
  - تعديل الرمز (edit_cell): منتقي من `/api/shift-codes` ← تأكيد ← PUT cell
    ← عرض نتيجة الخادم ← تحديث الشهر.
  - حذف السجل (employees) بتأكيد.
  - تبديل (swap): اختيار سجل ثانٍ ← ملخص قبل/بعد ← POST swap.
  - إضافة سجل (employees): موظف+تاريخ+رمز ← `/validate` أولًا ← عرض
    conflicts إن وجدت ← POST.
- **`ScheduleHistoryView`:** سجل التدقيق (فلاتر موظف/فترة) ببطاقات قبل/بعد.
- **عمليات متقدمة** (حسب الصلاحية): تحديث جماعي عبر مسودة ← bulk-update ·
  تراجع/إعادة عبر المسودات · تصدير PDF (تنزيل ثنائي + ورقة مشاركة) ·
  تصدير JSON · توليد ذكي (admin/director) بتأكيد · مسح (schedule.clear)
  بتأكيد مزدوج.
- **APIClient:** إضافة `download(path:query:)` للثنائي (PDF/Excel) — قراءة فقط.

## ⑤ ملفات التنفيذ

- `Core/Permissions/PermissionMapper.swift` — مفاتيح schedule.* التفصيلية.
- `Core/Networking/APIClient.swift` — `download`.
- `Models/ScheduleOpsDTO.swift`
- `Features/ScheduleOps/` — Hub + Month/Day/Team/Employee/Center +
  CellSheet + History + Advanced + ViewModel مشترك.
- تسجيل pbxproj (4 مواضع/ملف) + حراسة قبل كل commit.
- اختبارات: فك DTOs + PermissionMapper الجديد.
