# Native iOS — Platform Parity Inventory

**الغاية (§12 من وثيقة FULL PLATFORM PARITY):** جرد كامل للمنصة القائمة من
المستودع — كل وحدة، قدرتها على الويب، مساراتها، عملياتها R/C/U/D، إجراءاتها
التشغيلية، صلاحياتها، وما يقابلها حاليًا في التطبيق الأصلي وحالته.

**مصادر الجرد (مستودع `feature/native-ios-app`):**
- `server.js` — 416 مسارًا (15,207 سطرًا)، فُحصت كلها مع حراساتها.
- `config/permissions.js` — 33 مفتاح صلاحية + 5 أدوار تشغيلية + 3 تقنية.
- `public/*.html` — 35 صفحة ويب قائمة.
- `ios-native/EMSOperations/Features/**` — الشاشات الأصلية الحالية.

**رموز الحالة الأصلية:**
- ✅ مبني — التدفق يعمل من التطبيق فعليًا.
- ◐ جزئي — قراءة فقط، أو جزء من التدفق.
- ⛔ غير موجود — لا شاشة أصلية بعد.

**قاعدة:** القراءات العملياتية محروسة بـ`authenticate` فقط (قرار ① ربط
العمليات)؛ مفاتيح `ops.*`/`schedule.*` تحرس التنفيذ. `admin = '*'`.

---

## 1. المصادقة والجلسة

| الحقل | القيمة |
|---|---|
| **Module** | المصادقة والجلسة (auth) |
| **Web Capability** | دخول/خروج، تحديث توكن، نسيت كلمة المرور (رمز → إعادة تعيين)، تغيير كلمة المرور، جلسات المستخدم |
| **Existing API** | `POST /api/auth/login` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `POST /api/auth/forgot-password` · `POST /api/auth/verify-reset-code` · `POST /api/auth/reset-password` · `POST /api/auth/change-password` · `GET /api/auth/me` · `GET /api/auth/me/permissions` · `GET /api/auth/sessions` |
| **Read** | `me`، `me/permissions`، `sessions` (admin) |
| **Create** | login/refresh/logout/forgot/reset/change-password |
| **Update / Delete** | — |
| **Operational Actions** | استعادة كلمة المرور عبر الرمز، إبطال الجلسة عند الخروج |
| **Permissions** | عامة (بلا حارس) ما عدا `sessions` → `authorize(['admin'])` |
| **Native Screen** | `LoginView` + `SessionStore` + `AuthService` + `Keychain` + `BiometricGate` |
| **Native Status** | ✅ مبني بالكامل — دخول/خروج/تحديث/Face ID + استعادة كلمة المرور (٣ خطوات عبر الرمز — `ForgotPasswordView`) + تغييرها من «ملفي» (`ChangePasswordSheet`) · جلسات المستخدم sessions (admin) لم تُبنَ — إدارة ويب |

## 2. الصلاحيات والأدوار

| الحقل | القيمة |
|---|---|
| **Module** | إدارة الصلاحيات (permissions) |
| **Web Capability** | كتالوج الصلاحيات، منح/سحب/مسح فردي، قائمة المستخدمين وصلاحياتهم (`admin-users.html`) |
| **Existing API** | `GET /api/permissions/catalog` · `GET /api/permissions/user/:userId` · `GET /api/permissions/users` · `POST /api/permissions/grant` · `POST /api/permissions/revoke` · `POST /api/permissions/clear` |
| **Read** | catalog / user / users |
| **Create** | grant / revoke |
| **Update** | revoke→grant (استبدال) |
| **Delete** | clear |
| **Operational Actions** | منح فردي فوق الدور، سحب فردي، مسح كامل المنح |
| **Permissions** | كلها `admin.users_manage` |
| **Native Screen** | `PermissionStore` + `PermissionMapper` (استهلاك داخلي للصلاحيات) — لا شاشة إدارة |
| **Native Status** | ✅ مبني — استهلاك + إدارة (`AdminPermissionsView`: كتالوج/مستخدمون/تفاصيل/منح/سحب/إعادة — موديول في مركز الإدارة بـadmin.users_manage) |

## 3. بوابة الموظف التشغيلية (my-ems)

| الحقل | القيمة |
|---|---|
| **Module** | بوابة الموظف (`my-ems.html` ← 19 مسار `/api/my/*`) |
| **Web Capability** | ملفي، جدولي الشهري، تكليفاتي، بلاغات فرقتي، مركبتي، عهدتي، فحص المناوبة (تكميل الموظف)، زملائي، إشعاراتي، تغييرات جدولي، أقسامي، تسجيل جهاز Push |
| **Existing API** | `GET /api/my/profile` · `GET /api/my/schedule` · `GET /api/my/assignments` · `GET /api/my/team-incidents` · `GET /api/my/sections` · `GET /api/my/vehicle` · `GET /api/my/inventory` · `GET /api/my/check-session` · `POST /api/my/check-session/items` · `POST .../no-change` · `POST .../vehicle-fields` · `POST .../confirm` · `GET /api/my/shift-mates` · `GET /api/my/notifications` · `POST /api/my/notifications/:id/read` · `POST .../ack` · `POST /api/my/push/register` · `POST /api/my/push/unregister` · `GET /api/my/schedule-changes` |
| **Read** | كل GET أعلاه |
| **Create** | check-session items/confirm/no-change/vehicle-fields · notifications read/ack · push register/unregister |
| **Update / Delete** | — |
| **Operational Actions** | تأكيد فحص المناوبة، إقرار الإشعار (Ack)، تسجيل الجهاز للإشعارات |
| **Permissions** | `ops.my_portal` (منح فردي حصرًا) |
| **Native Screen** | `ProfileView` · `ScheduleView` · `AssignmentsView` · `ReportsView`(بلاغات فرقتي) · `VehicleView` · `InventoryView` · `CompletionView`(فحص المناوبة) · `ShiftMatesView` · `NotificationsView` · `ScheduleChangesView` + `PushService` |
| **Native Status** | ✅ مبني بالكامل (v1–v5) |

## 4. الرئيسية ولوحة القيادة

| الحقل | القيمة |
|---|---|
| **Module** | الرئيسية التشغيلية (home) |
| **Web Capability** | ملخص حي: المناوبة، الفريق، نبض العمليات، إجراءات سريعة، تنبيهات (`index.html` + `operations-dashboard.html`) |
| **Existing API** | `GET /api/dashboard` · `GET /api/data` · `GET /api/current-shift` · `GET /api/staffing/state` · `GET /api/vehicles/board` · `GET /api/last-update` · `GET /api/sse` (بث) |
| **Read** | كلها قراءات (`POST /api/dashboard` → admin لحفظ تخطيط) |
| **Create/Update/Delete** | — |
| **Operational Actions** | بث حي SSE على الويب |
| **Permissions** | `authenticate` (قراءة) |
| **Native Screen** | `HomeView` + `HomeViewModel` (نبض العمليات الحي) + `NetworkMonitor` + `SafeCache` |
| **Native Status** | ✅ مبني — ⛔ بث SSE (التطبيق يعتمد pull-to-refresh) |

## 5. الإشعارات

| الحقل | القيمة |
|---|---|
| **Module** | الإشعارات (notifications) |
| **Web Capability** | مركز إشعارات، إرسال إشعار، سجل الإشعارات، تعقّب التسليم/القراءة، APNs push |
| **Existing API** | `GET /api/notifications` · `GET /api/notifications/log` · `POST /api/notifications` · `POST /api/notifications/send` · `POST /api/notifications/read` · `POST /api/notifications/:id/read` · `POST /api/notifications/:id/delivered` + مسارات `/api/my/notifications*` و`/api/my/push/*` |
| **Read** | notifications / log |
| **Create** | إنشاء + إرسال |
| **Update** | read/delivered |
| **Delete** | — |
| **Operational Actions** | إرسال إشعار جماعي/فردي (admin/director)، تتبع التسليم |
| **Permissions** | الإرسال `authorize(['admin','director'])`؛ القراءة `authenticate` |
| **Native Screen** | `NotificationsView` (بوابة الموظف) + `AdminNotificationsView` (إرسال موجه admin/director + سجل الإرسال وتعقّب التسليم — في مركز الإدارة) + `PushService` + `DeepLinkRouter` |
| **Native Status** | ✅ مكتمل (إشعارات الموظف + إرسال النظام + السجل) — Deep Links تغطي kind=schedule_change الوحيد المُرسل سيرفريًا حاليًا + السقوط الآمن لإشعاراتي |

## 6. الجداول (schedule / roster)

| الحقل | القيمة |
|---|---|
| **Module** | الجداول — العرض والتحرير الكامل (`index.html` تبويب الجداول + `smart-schedule.html`) |
| **Web Capability** | عرض شهري/يومي/فريق/موظف/مركز، تعديل خلية، استيراد Excel، توليد ذكي، استبدال، تراجع/إعادة، تحديث جماعي ومسودات، مزامنة، تصدير PDF، سجل تدقيق، إدارة موظفي الجدول، مسح (حساس)، الجدول الشهري الرسمي |
| **Existing API** | `GET /api/shift-roster` · `GET /api/shift-roster/:id` · `GET /api/shift-roster/months` · `GET /api/shift-roster/stats` · `GET /api/shift-roster/audit-log` · `GET /api/shift-roster/drafts` · `GET /api/shift-roster/employee-schedule/:employeeId` · `POST /api/shift-roster/validate` · `PUT /api/shift-roster/cell` · `POST /api/shift-roster` · `PUT/DELETE /api/shift-roster/:id` · `POST /api/shift-roster/import` · `POST /api/shift-roster/export` · `POST /api/shift-roster/swap` · `POST /api/shift-roster/undo` · `POST /api/shift-roster/redo` · `POST /api/shift-roster/bulk-update` · `POST /api/shift-roster/draft` · `POST /api/shift-roster/audit-log` · `POST /api/shift-roster/clear` · `POST /api/shift-roster/clear-all` · `GET/POST/DELETE /api/schedule/employees` · `GET/POST /api/schedule/files` · `POST /api/schedule/official-import` · `GET /api/schedule/pdf` · `GET /api/schedule/metrics` · `POST /api/upload-monthly-table` · `GET /api/get-monthly-table` · `GET /api/check-monthly-table` · `DELETE /api/monthly-table` · `POST /api/shift-schedule/generate` · `POST /api/shift-schedule/update` |
| **Read** | roster + months/stats/audit-log/drafts/employee-schedule + schedule/employees/files/metrics + monthly-table |
| **Create** | import / draft / generate / roster rows |
| **Update** | cell / bulk-update / swap / undo/redo / roster rows / schedule/files / shift-schedule/update |
| **Delete** | roster row / schedule/employees / monthly-table (clear) |
| **Operational Actions** | استيراد رسمي، توليد ذكي، تحقق تعارضات (`validate`)، تصدير PDF، تراجع/إعادة |
| **Permissions** | `schedule.view` (قراءة+validate) · `schedule.edit_cell` · `schedule.employees` · `schedule.import` · `schedule.bulk_update` · `schedule.swap` · `schedule.sync` · `schedule.export` · `schedule.clear` — كلها منح فردية حصرًا؛ التوليد/التحديث `authorize(['admin','director'])` |
| **Native Screen** | `ScheduleView` (جدول الموظف الشهري — قراءة) + مجال الجداول الإداري `Features/ScheduleOps/` (`ScheduleHubView` خمسة أوجه عرض · `ScheduleCellSheet` تحرير · `ScheduleHistoryView` تدقيق · `ScheduleAdvancedView` عمليات متقدمة) — التصميم: `docs/native-schedule-parity.md` |
| **Native Status** | ✅ عرض شهر/يوم/فريق/موظف/مركز ✅ تعديل خلية (PUT /cell) ✅ إضافة/حذف سجل (validate → تأكيد) ✅ تبديل (swap) ✅ سجل تدقيق قبل/بعد ✅ تصدير PDF (تنزيل ثنائي + مشاركة) ✅ تصدير JSON (مشاركة) ✅ مسودات/تراجع/إعادة (إعادة تطبيق عبر bulk-update بعد تأكيد) ✅ توليد ذكي (admin/director) ✅ مسح بالمدى/كامل (تأكيد مزدوج) — ⛔ استيراد Excel (`import`/`official-import`/`schedule/files`): **قرار مالك (2026-09-19) — Web-only نهائيًا حاليًا؛ لا يُبنى Import في iOS ولا يُطلب endpoint جديد له** · ⛔ الجدول الشهري الرسمي (`monthly-table`) والمزامنة (`schedule.sync`) و`shift-schedule/update` لم تُنقل بعد · التحديث الحي يعتمد pull-to-refresh (لا SSE في Native) |

## 7. التكميل (completion / staffing)

| الحقل | القيمة |
|---|---|
| **Module** | التكميل — شاشة تكميل المناوبة (`index.html` + `check-review.html` + `radio-completion.html`) |
| **Web Capability** | تكميل الفرق (حالة جاهز/ناقص/خارج الخدمة + سبب)، دعم خارجي/تطوعي، تفعيل أوفرلاب، غياب/تأخر، ملاحظات الفريق، مراجعة التكميل، الدعم المتاح، مرشحو التطوع، مؤشرات الكادر |
| **Existing API** | `POST /api/shift-completion` · `GET /api/shift-completion/:shiftId/:teamName` · `GET /api/completion/latest` · `GET /api/staffing/state` · `GET /api/staffing/available-support` · `GET /api/staffing/volunteer-candidates` · `GET /api/staffing/indicators` · `GET /api/staffing/timeline` · `POST /api/staffing/activation` · `POST /api/staffing/activation/end` · `POST /api/staffing/volunteer` · `GET/POST /api/shift-events/:shiftId` · `DELETE /api/shift-events/:shiftId/:eventId` · `GET/POST /api/shift-absences/:shiftId` · `DELETE /api/shift-absences/:shiftId/:absenceId` · `GET/POST /api/shift-notes/:shiftId` · `DELETE /api/shift-notes/:shiftId/:noteId` · `GET /api/staffing-recommendations` · `GET /api/staffing-levels` · `GET /api/staffing-alerts` · `GET /api/ops/readiness/today` · `GET /api/ops/readiness/teams` · `GET /api/ops/readiness/session/:id` |
| **Read** | state / latest / available-support / volunteer-candidates / indicators / timeline / readiness |
| **Create** | shift-completion / activation / volunteer / events / absences / notes |
| **Update** | إنهاء تفعيل (activation/end) |
| **Delete** | event / absence / note |
| **Operational Actions** | قرار حالة الفريق، إسناد دعم، تطوع، تفعيل أوفرلاب، تسجيل غياب/تأخر |
| **Permissions** | التنفيذ `ops.completion` · التطوع `ops.volunteers` · القراءة `authenticate` |
| **Native Screen** | `OpsReadinessView` (قراءة الحالة والعدّادات) · `CompletionView` (فحص الموظف — مسار مختلف) · `Features/CompletionOps/` (`CompletionOpsView` قرارات الفرق وأحداث الأشخاص · `CompletionSupportView` حوض الدعم والتطوع · `CompletionRecordsView` أحداث/غيابات/ملاحظات المناوبة) |
| **Native Status** | ✅ قرارات الفرق (ready/missing/offline — جدول قرار مستقل) ✅ أحداث الأشخاص (غياب/تأخر/وصول/تصحيح late_void·absence_void·arrival_void/دعم خارجي/إنهاء دعم) ✅ تفعيل/إنهاء تفعيل (activation) ✅ تطوع (مرشحون سيرفريون + ops.volunteers) ✅ حوض الدعم ✅ سجلات المناوبة (أحداث/غيابات/ملاحظات — استبدال جماعي خام يحفظ حقول الويب category/priority/resolved + حذف فردي) — الختم سيرفري (OV-S6-01) والعميل يعرض corrected عند التصحيح · ⛔ مراجعة التكميل (check-review) و`staffing/timeline` و`staffing/indicators` و`staffing-recommendations` لم تُنقل بعد |

## 8. دورة المناوبة (shifts lifecycle)

| الحقل | القيمة |
|---|---|
| **Module** | المناوبات — بدء/إنهاء/اعتماد/أرشفة/استعادة + لوحات (يومية/أسبوعية/شهرية/تنفيذية) |
| **Web Capability** | بدء مناوبة، إنهاء، تسليم واعتماد، أرشفة واستعادة، تعديل بيانات، طوارئ (أرشفة/حذف/تعديل قسري)، سلامة ولقطات، مؤشرات وتقارير، مقارنة مناوبات، بحث |
| **Existing API** | `GET /api/current-shift` · `GET /api/shifts` · `GET /api/shifts/:id` · `GET /api/shifts/:id/detail` · `GET /api/shifts/:id/timeline` · `GET /api/shifts/:id/metrics` · `GET /api/shifts/:id/health-score` · `GET /api/shifts/:id/export` · `GET /api/shifts/daily-dashboard` · `GET /api/shifts/weekly-dashboard` · `GET /api/shifts/monthly-dashboard` · `GET /api/shifts/executive-dashboard` · `GET /api/shifts/search` · `GET /api/shifts/alerts` · `POST /api/start-new-shift` · `POST /api/shift/:id/end` · `POST /api/shift/:id/handover-approve` · `POST /api/shift/:id/archive` · `POST /api/shift/:id/restore` · `POST /api/update-shift-data` · `POST /api/shift-save` · `POST /api/shift-archive` · `DELETE /api/shifts/:id` · `POST /api/shifts/alerts/:id/acknowledge` · `POST /api/shifts/alerts/calculate` · `POST /api/shifts/:id/metrics/calculate` · `POST /api/shifts/metrics/calculate-all` · `POST /api/shifts/reports/generate` · `POST /api/shifts/compare` · `GET /api/shifts/comparison/:id` · `POST /api/shifts/export` · `GET/POST /api/shifts/audit-trail` · `GET /api/emergency/active-shifts` · `POST /api/emergency/archive-shift` · `POST /api/emergency/delete-shift` · `POST /api/emergency/edit-shift` |
| **Read** | كل GET أعلاه |
| **Create** | start-new-shift / reports/generate / compare |
| **Update** | end / handover-approve / update-shift-data / shift-save / alerts ack / metrics calculate / emergency edit |
| **Delete** | `DELETE /api/shifts/:id` (admin) · emergency delete (admin) |
| **Operational Actions** | دورة حياة كاملة + طوارئ + اعتماد تسليم |
| **Permissions** | `shift.lifecycle` (بدء/إنهاء/تحديث) · `shift.approve` (تسليم) · أرشفة/طوارئ/تقارير `admin`/`director` · التنبيهات `ops.alerts` · القراءة `authenticate` |
| **Native Screen** | `CurrentShiftView` + `ShiftLifecycleView` (بدء/إنهاء/اعتماد تسليم + طوارئ — موديول «دورة المناوبة» في غرفة العمليات) |
| **Native Status** | ✅ دورة الحياة والطوارئ — مؤجل: اللوحات (daily/weekly/monthly/executive) والمؤشرات والمقارنة والبحث المتقدم (شاشات تحليلية ثقيلة تحتاج قرار تصميم مستقل) |

## 9. البلاغات والتوزيع (dispatch / reports)

| الحقل | القيمة |
|---|---|
| **Module** | البلاغات — توزيع، تراجع، تفصيلية، CAD (`index.html` + `report-entry.html` + `cad-report-prototype.html`) |
| **Web Capability** | تسجيل/توزيع بلاغ على الفرق، تراجع (undo)، بلاغات تفصيلية (إدخال/حذف)، بلاغات CAD (إنشاء/إلغاء طاقم/استعادة/اقتراح مكان/رصد مستشفى)، بلاغات فرق الجنوب، تحديد موقع بلاغ |
| **Existing API** | `GET /api/cad-reports` · `GET /api/cad-reports/south-teams` · `POST /api/cad-reports` · `POST /api/report` · `POST /api/undo` · `GET/POST /api/report-entry` · `DELETE /api/report-entry/:id` · `DELETE /api/report-entry` (admin) · `GET /api/incidents/lookup` · `POST /api/cad-reports/:number/crews/:unit/cancel` · `POST .../restore` · `GET /api/cad-reports/:number/place-suggestion` · `POST /api/cad-reports/hospital-sighting` · `POST /api/locate-report` · `GET /api/analytics/incidents` · `GET /api/analytics/incident-detail` · `GET /api/analytics/patterns` · `GET /api/analytics/coverage` · `GET /api/analytics/recommendations` |
| **Read** | cad-reports / south-teams / report-entry / incidents/lookup / analytics |
| **Create** | report / cad-reports / report-entry / locate-report / hospital-sighting |
| **Update** | crews cancel/restore |
| **Delete** | report-entry/:id |
| **Operational Actions** | توزيع بلاغ على فريق، تراجع عن توزيع، إلغاء/استعادة طاقم CAD |
| **Permissions** | `ops.dispatch` (توزيع+طواقم) · `ops.report_revert` (تراجع) · `ops.report_detail` (تفصيلية) · `ops.reports` (اقتراح مكان) · `ops.forms` (lookup) |
| **Native Screen** | `OpsEventsView` (الخط الزمني فقط) · `ReportsView` (بلاغات فرقتي للموظف) · `DispatchOpsView` (ملخص المناوبة + توزيع + تراجع + طواقم CAD + بلاغات تفصيلية) |
| **Native Status** | ✅ مكتمل عمليًا — توزيع (`ops.dispatch`)، تراجع (`ops.report_revert`)، إلغاء/استعادة طواقم CAD بسبب اختياري، بلاغات تفصيلية إدخال/حذف (`ops.report_detail`)؛ العدّادات والخطورة مشتقة سيرفريًا وتُعرض كما هي. ⛔ متبقٍ: `locate-report`، `place-suggestion` (`ops.reports`)، `hospital-sighting`، `incidents/lookup`، طبقة `analytics/*` التاريخية (خريطة الذاكرة H1–H4)، `south-teams`، مسح الكل `DELETE /api/report-entry` (admin) |

## 10. المركبات (vehicles)

| الحقل | القيمة |
|---|---|
| **Module** | المركبات — لوحة، سجل، إسناد، دعم، أحداث (`index.html` + `admin-vehicles.html`) |
| **Web Capability** | لوحة الأسطول، تعيين/إنهاء/تبديل إسناد، دعم مركبة لفريق، تسجيل أحداث (عطل/ورشة/عودة)، تاريخ المركبة، سجل مرجعي (إضافة/تعديل — admin)، مؤشرات |
| **Existing API** | `GET /api/vehicles/board` · `GET /api/vehicles/state` · `GET /api/vehicles/registry` · `GET /api/vehicles/centers` · `GET /api/vehicles/:id/history` · `GET /api/vehicles/indicators` · `GET /api/vehicles/timeline` · `POST /api/vehicles/events` · `POST /api/vehicles/assignment` · `POST /api/vehicles/assignment/end` · `POST /api/vehicles/assignment/switch` · `POST /api/vehicles/support` · `POST /api/vehicles/support/end` · `POST /api/vehicles/registry` · `PUT /api/vehicles/registry/:id` |
| **Read** | board / state / registry / centers / history / indicators / timeline |
| **Create** | events / assignment / support / registry (admin) |
| **Update** | assignment end/switch · support/end · registry (admin) |
| **Delete** | — (قانون append-only — لا حذف إطلاقًا) |
| **Operational Actions** | إسناد مركبة لفريق، تبديل، دعم، تسجيل حالة ميكانيكية |
| **Permissions** | `ops.vehicles` (تنفيذ) · registry `admin` · قراءة `authenticate` |
| **Native Screen** | `OpsVehiclesView` (لوحة + إسناد/تبديل/دعم/حالة) · `VehicleHistoryView` (التاريخ عبر المناوبات) · `VehicleRegistryView` (السجل المرجعي — admin) · `VehicleView` (مركبة الموظف) |
| **Native Status** | ✅ مكتمل عمليًا — تغيير الحالة (سبب إلزامي عند breakdown/out_of_service)، إسناد/إنهاء/تبديل، دعم/إنهاء دعم (`ops.vehicles`)، تاريخ المركبة، سجل مرجعي إضافة/تعديل (admin حصرًا — `isAdmin`). ⛔ متبقٍ: أحداث الورشة (عقد تعريفي بلا مسار خادم)، مؤشرات `vehicles/indicators` و`timeline` التفصيلية، `vehicles/centers` |

## 11. التمركز والخريطة (deployments / map)

| الحقل | القيمة |
|---|---|
| **Module** | التمركزات — مواقع الوحدات، خطط الذروة، مهام الذروة، الخريطة (`index.html` + `history-map.html`) |
| **Web Capability** | تمركز وحدات على الخريطة، عناوين المواقع، خطط ذروة (إنشاء/تعديل/حذف)، مهمة ذروة وحلّها، إحداثيات المراكز، مواقع الخريطة، خريطة تاريخية |
| **Existing API** | `GET/POST /api/unit-locations` · `POST /api/unit-location-addresses` · `GET /api/map-locations` · `GET /api/center-geo` · `GET/POST /api/peak-plans` · `PUT/DELETE /api/peak-plans/:id` · `POST /api/peak-mission` · `POST /api/peak-resolve` · `DELETE /api/peak-mission/:id` · `GET /api/peak-data` · `GET /api/peak-plans` |
| **Read** | unit-locations / map-locations / center-geo / peak-plans / peak-data |
| **Create** | unit-locations / peak-plans / peak-mission |
| **Update** | peak-plans/:id / peak-resolve |
| **Delete** | peak-plans/:id / peak-mission/:id |
| **Operational Actions** | تمركز وحدة، إطلاق مهمة ذروة، حلّ مهمة |
| **Permissions** | `ops.deployments` (تنفيذ) · القراءة `authenticate` |
| **Native Screen** | `OpsMapView` (مراكز على الخريطة — قراءة) · `PositioningOpsView` (تمركز الوحدات + خطط الذروة + المهام والتنبيهات) |
| **Native Status** | ✅ مكتمل عمليًا — تمركز/تعديل الوحدات، خطط الذروة (إنشاء/تعديل/ختم وصول ومغادرة سيرفري/حذف)، مهام الذروة (إنشاء/حلّ التنبيه/حذف admin-director)، كلها بصلاحية `ops.deployments`. ⛔ متبقٍ: `map-locations` وخريطة `history-map` التاريخية |

## 12. النماذج (forms)

| الحقل | القيمة |
|---|---|
| **Module** | النماذج التشغيلية — بلاغات، تصعيدات، حالات إلكترونية، تقارير يومية، مناوبات كبار، إسعاف جوي، ملاحظات التحكم، إجازات مجدولة |
| **Web Capability** | فتح نموذج، حقول وتحقق، رفع مرفقات، إرسال، حالة، سجل، حذف (`workflow-prototype`/`report-entry`… ضمن index) |
| **Existing API** | `GET/POST /api/incidents` · `DELETE /api/incidents/:id` · `GET/POST /api/escalations` · `DELETE /api/escalations/:id` · `GET/POST /api/e-cases` · `DELETE /api/e-cases/:id` · `GET/POST /api/daily-reports` · `DELETE /api/daily-reports/:id` · `GET/POST /api/senior-shifts` · `DELETE /api/senior-shifts/:id` · `GET /api/air-ambulance` · `POST /api/save-air-ambulance` · `DELETE /api/delete-air-ambulance/:id` · `DELETE /api/clear-air-ambulance` · `GET /api/control-notes` · `POST /api/save-control-notes` · `DELETE /api/control-notes` · `GET /api/vacations` · `POST /api/save-vacations` · `DELETE /api/vacations` |
| **Read** | incidents / escalations / e-cases / daily-reports / senior-shifts / air-ambulance / control-notes / vacations |
| **Create** | نفس المسارات POST |
| **Update** | — (حذف وإعادة إنشاء) |
| **Delete** | :id لكل نموذج + clear-air-ambulance |
| **Operational Actions** | تسجيل نموذج تشغيلي بأنواعه، متابعة، حذف |
| **Permissions** | `ops.forms` (كل الإنشاء/الحذف) · القراءة `authenticate` · بعض الحذف `admin` |
| **Native Screen** | `FormsOpsView` (خمسة أنواع: حوادث/تصعيدات/حالات إلكترونية/تقارير يومية/مناوبات كبار — بحث CAD إلزامي للأنواع المرتبطة ببلاغ) |
| **Native Status** | ✅ مكتمل للأنواع الخمسة (`ops.forms`): قراءة + إنشاء + حذف؛ الحوادث/التصعيدات/الحالات الإلكترونية عبر بوابة `incidents/lookup` نفسها (لا حفظ بلا بلاغ متحقق). ⛔ متبقٍ: الإسعاف الجوي (`air-ambulance`)، ملاحظات التحكم (`control-notes` — حذف admin)، الإجازات المجدولة (`vacations` — ضمن مجال الإجازات §24)، مرفقات النماذج، إرسال WhatsApp |

## 13. سير العمل (workflow)

| الحقل | القيمة |
|---|---|
| **Module** | سير العمل — إعداد، إصدار، اعتماد، تدقيق، PDF (`workflow.html`) |
| **Web Capability** | إعداد سير عمل للمناوبة، تعديل نسخة، اعتماد، إعادة إصدار، سجل تدقيق، تصدير PDF |
| **Existing API** | `POST /api/workflow/prepare` · `GET /api/workflow/shift/:shiftId` · `GET /api/workflow/version/:id` · `PUT /api/workflow/version/:id` · `GET /api/workflow/version/:id/audit` · `POST /api/workflow/version/:id/approve` · `POST /api/workflow/version/:id/reissue` · `GET /api/workflow/version/:id/pdf` |
| **Read** | shift / version / audit / pdf |
| **Create** | prepare |
| **Update** | version / reissue |
| **Delete** | — |
| **Operational Actions** | اعتماد سير العمل (القيادة الميدانية)، إعادة إصدار بعد التعديل |
| **Permissions** | `workflow.view` · `workflow.manage` · `workflow.approve` · audit `admin` |
| **Native Screen** | `WorkflowOpsView` (نسخ المناوبة + إعداد/تحرير/اعتماد/إعادة إصدار + PDF) |
| **Native Status** | ✅ مكتمل عمليًا — إعداد مسودة (`workflow.manage`)، تحرير القائمة البيضاء الخمس + راجعها، اعتماد (`workflow.approve`)، إعادة إصدار بسبب اختياري، تنزيل PDF للمعتمدة. ⛔ متبقٍ: سجل التدقيق `version/:id/audit` (admin)، عرض اللقطة الكاملة (snapshot) داخل النسخة، الإرسال/الاستلام (sent/acknowledged — لا مسارات كتابة لها في الخادم) |

## 14. الأحداث والخط الزمني (events / timeline)

| الحقل | القيمة |
|---|---|
| **Module** | الأحداث التشغيلية — الخط الزمني العام + خطوط الكادر/المركبات |
| **Web Capability** | خط زمني للمناوبة، أحداث كادر/مركبات، سجل أحداث (`index.html` تبويب الأحداث) |
| **Existing API** | `GET /api/timeline` · `POST /api/timeline` (admin) · `GET /api/staffing/timeline` · `GET /api/vehicles/timeline` · `GET /api/shifts/:id/timeline` · `GET/POST /api/shift-events/:shiftId` · `DELETE /api/shift-events/:shiftId/:eventId` |
| **Read** | timeline / staffing/timeline / vehicles/timeline / shifts/:id/timeline |
| **Create** | timeline (admin) / shift-events |
| **Update / Delete** | shift-events/:eventId |
| **Operational Actions** | تسجيل حدث تشغيلي يدوي |
| **Permissions** | القراءة `authenticate` · الكتابة admin / `ops.completion` |
| **Native Screen** | `OpsEventsView` بأربعة أقسام: عام (`/api/timeline`) + الكادر (`/api/staffing/timeline` بسجلات التأخير والتغطية) + المركبات (`/api/vehicles/timeline`) + المناوبة (`/api/shifts/:id/timeline` + أحداث يدوية `shift-events` إضافة/حذف بصلاحية ops.completion) |
| **Native Status** | ✅ عام والكادر والمركبات والمناوبة — مؤجل: الكتابة في الخط العام `POST /api/timeline` (كتابة JSON كاملة قديمة — خطر استبدال الكل؛ لا تُبنى أصلًا دون قرار) |

## 15. الأرشيف والسلامة (archive)

| الحقل | القيمة |
|---|---|
| **Module** | الأرشيف — أرشفة، لقطات، سلامة، تحقق، سجل تدقيق |
| **Web Capability** | أرشفة مناوبة، لقطة كاملة، فحص سلامة، تحقق من الأرشيف، سجل تدقيق الأرشيف، إعادة أرشفة |
| **Existing API** | `GET /api/shifts/archive` · `GET /api/shifts/:id/archive-log` · `GET /api/shifts/:id/verify-archive` · `GET /api/shift-snapshot/:shiftId` · `GET /api/shift-integrity/:shiftId` · `POST /api/shift/:id/archive` · `POST /api/shift/:id/restore` · `POST /api/shift-archive` · `POST /api/shifts/:id/rearchive` · `GET/POST /api/audit-log` · `GET/POST /api/shifts/audit-trail` |
| **Read** | archive / snapshot / integrity / verify-archive / audit-log |
| **Create** | archive / rearchive / restore |
| **Update / Delete** | — |
| **Operational Actions** | أرشفة رسمية، استعادة من الأرشيف، تحقق سلامة |
| **Permissions** | أرشيف حساس `archive.sensitive` · أرشفة/استعادة `admin`/`director` · audit-log `authenticate` |
| **Native Screen** | `ArchiveOpsView` (قائمة + فلاتر سيرفرية + تحقق سلامة بخمسة فحوصات + سجل الأرشفة + أرشفة/استعادة/إعادة أرشفة مقيدة بالدور) — موديول «الأرشيف» في `OperationsHomeView` |
| **Native Status** | ✅ مكتمل (قائمة/تحقق/سجل/أرشفة/استعادة/إعادة أرشفة) — مؤجل: عرض `shift-snapshot`/`shift-integrity` (حمولة كبيرة) و`POST /api/shift-archive` وaudit-log العام |

## 16. العهد والأصول (assets)

| الحقل | القيمة |
|---|---|
| **Module** | العهد والأصول (`assets-*.html` — 7 صفحات) |
| **Web Capability** | سجل الأصول، بطاقة جهاز، بحث، لوحة، استيراد (staging→اعتماد)، دورات جرد، جلسات جرد (عناصر/مكتشف/تقديم/اعتماد/إعادة فتح/مراجعة)، فروقات، نقل عهدة، توثيق مفقود، حل مجموعات تسلسلية، تقارير (عهدة/دورة/فروقات) |
| **Existing API** | 25 مسارًا تحت `/api/assets*` (انظر routes: import/stage+preview+approve · inventory/cycles+sessions · discrepancies · reports/custody+cycle+discrepancies · transfer · resolve-review · document-missing · resolve-serial-group) |
| **Read** | assets / :id / dashboard / preview / cycles / sessions/:id / discrepancies / reports |
| **Create** | stage / cycles / sessions items / discovered |
| **Update** | activate / close / submit / approve / reopen / resolve-review / document-missing / transfer |
| **Delete** | — |
| **Operational Actions** | دورة جرد كاملة، اعتماد استيراد، نقل عهدة |
| **Permissions** | `assets.view` (قراءة) · `assets.manage` (إدارة) · `assets.inventory` (تنفيذ الجرد — منح فردي) |
| **Native Screen** | `InventoryView` (عهدة الموظف) + `AssetsHomeView` (موديول «العهد والأصول»: لوحة/سجل/فروقات/جرد) + `AssetCardView` (بطاقة الجهاز + نقل/حسم/توثيق فقد) + `InventorySessionView` (تسجيل نتائج/مكتشف/إرسال + اعتماد/إعادة فتح) |
| **Native Status** | ✅ إدارة العهد والجرد — مؤجل: تصدير CSV للتقارير (custody/cycle/discrepancies بصيغة csv) ومعاينة صفوف الاستيراد التفصيلية (تُعرض الإجماليات فقط) |

## 17. المستشفيات (hospitals)

| الحقل | القيمة |
|---|---|
| **Module** | المستشفيات ومراقبتها |
| **Web Capability** | سجل المستشفيات، مراقبة (ملخص/تاريخ)، تأكيد تنبيه |
| **Existing API** | `GET /api/hospitals` · `POST /api/hospitals` (admin) · `GET /api/hospital-monitor/summary` · `GET /api/hospital-monitor/history` · `POST /api/hospital-monitor/alerts/:alertId/ack` |
| **Read** | hospitals / summary / history |
| **Create** | hospitals (admin) |
| **Update** | alerts ack |
| **Delete** | — |
| **Operational Actions** | تأكيد تنبيه مراقبة مستشفى |
| **Permissions** | ack `ops.alerts` · القراءة `authenticate` |
| **Native Screen** | `HospitalsOpsView` (موديول «المستشفيات» في غرفة العمليات: مراقبة — ملخص/تنبيهات مع إقرار ops.alerts/تاريخ رحلة — + السجل) |
| **Native Status** | ✅ مراقبة وسجل — مؤجل: كتابة سجل المستشفيات `POST /api/hospitals` (كتابة JSON كاملة قديمة بخطر استبدال الكل — لا تُبنى دون قرار) |

## 18. الذكاء والمشغل الذكي (AI / smart operator)

| الحقل | القيمة |
|---|---|
| **Module** | الذكاء — مساعد، قاعدة معرفة، مشغل ذكي (`ai-dashboard.html` + `smart-operator.html` + `admin-knowledge.html`) |
| **Web Capability** | محادثة AI (v1/v2/agent)، تاريخ وإحصاءات، قاعدة معرفة (رفع/معالجة/حذف/إدارة)، أسئلة بلا إجابة (حل/تجاهل)، تقييم المشغل الذكي، ذاكرة القرار وأنماطه، «اسأل» |
| **Existing API** | `POST /api/ai/chat` · `GET /api/ai/history` · `GET /api/ai/stats` · `POST /api/ai/v2/chat` · `POST /api/ai/v2/feedback` · `GET/POST /api/ai/v2/knowledge` · `DELETE /api/ai/v2/knowledge/:id` · `GET /api/ai/v2/unanswered` · `POST .../resolve` · `POST .../dismiss` · `GET /api/ai/v2/stats` · `POST /api/agent/chat` · `GET /api/kb/documents` · `POST /api/kb/upload` · `POST /api/kb/process/:id` · `DELETE /api/kb/documents/:id` · `GET /api/smart-operator/assessment` · `GET /api/smart-operator/memory` · `GET /api/smart-operator/memory/patterns` · `POST /api/smart-operator/ask` |
| **Read** | history / stats / knowledge / unanswered / memory / patterns / assessment |
| **Create** | chat / ask / feedback / knowledge / kb upload |
| **Update** | resolve / dismiss / kb process |
| **Delete** | knowledge/:id / kb/:id |
| **Operational Actions** | سؤال المشغل الذكي، معالجة أسئلة بلا إجابة |
| **Permissions** | AI/kb إدارة `admin`/`director` · smart-operator `authenticate` |
| **Native Screen** | `DecisionCenterView` (تقييم + «اسأل المشغل الذكي» + ذاكرة القرار + أنماطها — قراءة/سؤال) |
| **Native Status** | ✅ التقييم و«اسأل» والذاكرة والأنماط — مؤجل: محادثة AI (v1/v2/agent) وقاعدة المعرفة وأسئلة بلا إجابة (إدارة admin/director — واجهة محادثة وإدارة معرفة ثقيلة، تحتاج قرار تصميم مستقل) |

## 19. الدردشة (chat)

| الحقل | القيمة |
|---|---|
| **Module** | الدردشة الداخلية (`chat.html`) |
| **Web Capability** | محادثات جماعية وخاصة، رسائل، مشاركون (إضافة/حذف/مغادرة)، رفع مرفق، متصلون الآن، قراءة رسائل |
| **Existing API** | `GET /api/chat/conversations` · `GET /api/chat/conversations/:id/messages` · `GET /api/chat/online` · `GET /api/chat/users` · `POST /api/chat/conversations` · `POST /api/chat/conversations/private` · `POST /api/chat/conversations/:id/messages` · `POST /api/chat/conversations/:id/participants` · `POST /api/chat/upload` · `PUT /api/chat/messages/:id/read` · `PUT /api/chat/conversations/:id/leave` · `DELETE /api/chat/conversations/:id` · `DELETE /api/chat/conversations/:id/participants/:user_id` |
| **Read** | conversations / messages / online / users |
| **Create** | conversations / private / messages / upload |
| **Update** | read / leave |
| **Delete** | conversation / participant |
| **Operational Actions** | محادثة خاصة، مرفقات، إدارة مشاركين |
| **Permissions** | `authenticate` (نظام داخلي عام) |
| **Native Screen** | تبويب «المحادثات» في MainTabView: `ChatView` (قائمة + إنشاء مجموعة/خاصة + متصلون) + `ChatConversationView` (رسائل/إرسال/تعليم مقروء) + إدارة المشاركين/مغادرة/أرشفة |
| **Native Status** | ✅ محادثات ورسائل ومشاركون ومرفقات (`POST /api/chat/upload` multipart + رسالة `file_url` — commit `e844bfc`) — مؤجل: تحديث لحظي عبر SSE/WebSocket (حاليًا تحديث بالسحب وإعادة الفتح) |

## 20. الإدارة (admin)

| الحقل | القيمة |
|---|---|
| **Module** | الإدارة — مستخدمون، موظفون، فرق، تعيينات، رموز، إعدادات، مراقبة تقنية (`admin-*.html` — 6 صفحات) |
| **Web Capability** | إدارة مستخدمين وأدوار، موظفون (CRUD + نقل + نمط + جوال + توثيق + استيراد جوالات)، فرق (CRUD)، تعيينات فرق (CRUD)، رموز مناوبات (CRUD)، رموز جداول (CRUD + قفل سري + تدقيق)، أنماط مناوبات، إعدادات (ساعات شهرية/ثيم/هوية)، مراقبة تقنية (صحة/إحصاءات/تنبيهات/سجلات/إصلاح/تدمير)، سجل تدقيق، استخدام القرص |
| **Existing API** | `GET/POST /api/users` · `POST /api/users/:id/role` · `GET/POST/PUT/DELETE /api/employees*` (+transfer/pattern/phone/verify-phone/phones/import/search/profile) · `GET/POST/PUT/DELETE /api/teams*` · `GET/POST/PUT/DELETE /api/team-assignments*` · `GET/POST/PUT/DELETE /api/shift-codes*` · `GET/POST/PUT /api/schedule-symbols*` (+lock/unlock/secret/audit/status) · `GET/PUT /api/shift-patterns*` · `GET/PUT /api/settings/monthly-required-hours` · `GET/POST /api/references` · `GET /api/theme-settings` + upload/remove · `GET /api/admin/stats` · `GET /api/admin/monitor/*` · `POST /api/admin/auto-fix` · `POST /api/admin/destroy-db` · `GET/POST /api/audit-log` · `GET /api/disk-usage` |
| **Read** | users / employees / teams / assignments / codes / symbols / settings / monitor / audit-log |
| **Create** | نفسها POST |
| **Update** | نفسها PUT |
| **Delete** | employees / teams / codes / symbols(status) |
| **Operational Actions** | نقل موظف، توثيق جوال، قفل رموز سري، مراقبة وإصلاح تلقائي |
| **Permissions** | `admin.users_manage` · `employees.manage` · `symbols.manage` · `admin.settings` · `admin.tech` · `data.delete` + أدوار admin/director |
| **Native Screen** | `AdminHubView` (من «ملفي» لحامل canAccessAdmin) + `AdminUsersView` + `AdminEmployeesView` + `AdminRefsView` + `AdminSymbolsView` + `AdminSystemView` |
| **Native Status** | ✅ مكتمل (مستخدمون/أدوار/إنشاء حساب · موظفون CRUD+توثيق جوال+نقل+نمط · فرق/رموز/أنماط · رموز جداول بقفل سري · ساعات شهرية/قرص/تدقيق) — مؤجل: استيراد جوالات جماعي، theme upload، admin/monitor العميق، auto-fix/destroy-db (تخريبية لا تُدار من تطبيق) |

## 21. المؤشرات والتحليلات (indicators / analytics)

| الحقل | القيمة |
|---|---|
| **Module** | مؤشرات المساهمة + تحليلات البلاغات + أداء الطواقم (`contribution-stats.html` + `daily-report.html`) |
| **Web Capability** | مؤشر مساهمة الموظف (شهر/سنة)، لوحة مؤشرات، أداء الطواقم، إحصاءات القوى، تحليلات بلاغات (أنماط/تغطية/توصيات)، تقرير يومي |
| **Existing API** | `GET /api/indicators/contribution` · `GET /api/indicators/dashboard` · `GET /api/crew-performance/activity` · `GET /api/workforce-stats/:shiftId` · `GET /api/analytics/*` (5 مسارات) · `GET /api/daily-report` · `GET /api/daily-reports` |
| **Read** | كلها قراءات |
| **Create/Update/Delete** | — |
| **Operational Actions** | — |
| **Permissions** | `indicators.contribution` (المساهمة) · الباقي `authenticate` |
| **Native Screen** | `IndicatorsOpsView` (موديول «المؤشرات»: لوحة التشغيل + المساهمة الشهرية بتحفظاتها الظاهرة دائمًا + نشاط الفرق) |
| **Native Status** | ✅ لوحة/مساهمة/نشاط فرق — مؤجل: تحليلات البلاغات المتقدمة `/api/analytics/*` (5 مسارات) والتقرير اليومي `/api/daily-report` و`workforce-stats` (شاشات تحليلية ثقيلة — قرار تصميم مستقل) |

## 22. الملفات التشغيلية (ops files)

| الحقل | القيمة |
|---|---|
| **Module** | الملفات التشغيلية — رفع/تنزيل/حذف + مستندات عامة + هوية |
| **Web Capability** | رفع ملف تشغيلي، قائمة، تنزيل، حذف، مستندات (upload-doc/download-doc)، ملف الهوية |
| **Existing API** | `GET /api/ops-files` · `POST /api/ops-files` · `DELETE /api/ops-files/:id` · `GET /api/operational-files` · `POST /api/upload-operational` · `GET /api/download-operational/:id` · `DELETE /api/delete-operational/:id` · `POST /api/upload-doc` · `GET /api/download-doc/:id` · `DELETE /api/delete-doc/:id` · `GET /api/docs` · `GET /api/get-identity` · `POST /api/upload-identity` · `GET /api/download-identity` |
| **Read** | ops-files / operational-files / docs / get-identity / download |
| **Create** | upload |
| **Update / Delete** | delete :id |
| **Operational Actions** | رفع ملف تشغيلي لمناوبة |
| **Permissions** | `ops.files` (رفع/حذف — منح فردي) · القراءة `authenticate` |
| **Native Screen** | `FilesOpsView` (قائمة + تنزيل عبر ورقة النظام + حذف بـops.files — موديول «الملفات» في العمليات) |
| **Native Status** | ✅ قراءة/تنزيل/حذف/رفع multipart (`POST /api/upload-operational` بعقد multer حرفيًا — commit `c4b6370`) — مؤجل موثقًا: ملف الهوية get/upload-identity |

## 23. الإعلانات (announcements)

| الحقل | القيمة |
|---|---|
| **Module** | الإعلانات |
| **Web Capability** | عرض إعلانات، إضافة (admin)، حذف (admin) |
| **Existing API** | `GET /api/announcements` · `POST /api/announcements` · `POST /api/announcements/add` · `DELETE /api/announcements/:id` |
| **Read** | announcements |
| **Create** | announcements / add (admin) |
| **Update / Delete** | :id (admin) |
| **Operational Actions** | نشر إعلان |
| **Permissions** | القراءة `authenticate` · الكتابة `admin` |
| **Native Screen** | `MyRequestsView` (قراءة للجميع) · `RequestsAdminView` (إضافة/حذف admin عبر `/add` و`DELETE :id`) |
| **Native Status** | ✅ مبني — الكتابة الجماعية `POST /api/announcements` (JSON كامل قديم) مؤجلة موثقة |

## 24. الإجازات وطلبات الإجازة (leave)

| الحقل | القيمة |
|---|---|
| **Module** | الإجازات — طلبات + مجدولة |
| **Web Capability** | طلب إجازة، قائمة، اعتماد/تعديل، حذف، إجازات مجدولة (حفظ/حذف) |
| **Existing API** | `GET/POST /api/leave-requests` · `PUT /api/leave-requests/:id` · `POST /api/leave-requests/:id/approve` · `DELETE /api/leave-requests/:id` · `GET /api/vacations` · `POST /api/save-vacations` · `DELETE /api/vacations` |
| **Read** | leave-requests / vacations |
| **Create** | leave-requests / save-vacations |
| **Update** | leave-requests/:id / approve |
| **Delete** | leave-requests/:id / vacations |
| **Operational Actions** | اعتماد طلب إجازة |
| **Permissions** | الاعتماد `admin`/`director` · الطلب `authenticate` |
| **Native Screen** | `MyRequestsView` (تقديم/قائمة/إلغاء المعلَّق + إجازات مجدولة قراءة) · `RequestsAdminView` (اعتماد/رفض) |
| **Native Status** | ✅ مبني — `POST /api/save-vacations` كتابة JSON كاملة قديمة مؤجلة موثقة · `DELETE /api/vacations` (مسح الكل) مؤجل |

## 25. طلبات تغيير المناوبة (shift change requests)

| الحقل | القيمة |
|---|---|
| **Module** | طلبات تغيير المناوبة |
| **Web Capability** | تقديم طلب تغيير، قائمة، مراجعة (قبول/رفض) |
| **Existing API** | `GET/POST /api/shift-change-request` · `POST /api/shift-change-request/:id/review` |
| **Read** | shift-change-request (admin/director) |
| **Create** | shift-change-request |
| **Update** | review |
| **Delete** | — |
| **Operational Actions** | مراجعة طلب تغيير |
| **Permissions** | المراجعة `admin`/`director` |
| **Native Screen** | `MyRequestsView` (تقديم — قائمة الموظف غير متاحة سيرفريًا) · `RequestsAdminView` (مراجعة admin/director) |
| **Native Status** | ✅ مبني |

## 26. البنية التحتية والمتفرقات

| الحقل | القيمة |
|---|---|
| **Module** | بنية تحتية — SSE، صحة، قرص، نسخ احتياطي، سجلات واجهة، تصدير عام، CAD overlay، توقيع/خروج فرق، إحالة/مرجعيات، كلمات مرور تشغيلية |
| **Existing API** | `GET /api/sse` · `GET /health` · `GET /api/disk-usage` · `GET /api/last-update` · `POST /api/frontend-errors` · `GET /api/export` · `GET /api/cad-overlay/package` · `GET/POST /api/signouts` · `GET /api/signouts/suggest` · `GET/POST /api/references` · `GET /api/get-password` · `POST /api/change-password` · `GET /api/data` · `GET /api/settings/monthly-required-hours` |
| **Operational Actions** | تسجيل خروج فريق (`signouts` ← `ops.team_exit`) |
| **Permissions** | `ops.team_exit` · `admin`/`director` للحساس |
| **Native Screen** | `SignoutsOpsView` (اقتراح التشكيلة · تسجيل بـops.team_exit · سجل المناوبة النشطة) — موديول «خروج الفرق» في العمليات |
| **Native Status** | ◐ جزئي — تسجيل خروج الفرق ✅ مبني · SSE/الصحة/القرص/النسخ الاحتياطي/سجلات الواجهة/CAD overlay بنية تحتية لا يلزم للعميل (موثق) |

---

## ملخص التكافؤ الحالي

| الفئة | العدد |
|---|---|
| وحدات ✅ مبنية | 25 من 26 (§1–§22، §23–§25 — بعضها بفجوات موثقة داخلية) |
| وحدات ◐ جزئية | 1 (§26 البنية التحتية — خروج الفرق مبني والباقي لا يلزم للعميل) |
| وحدات ⛔ غير موجودة | 0 |

**الفجوات الموثقة المؤجلة (قرارات واعية، ليست نقصًا مجهولًا):**
- كتابات JSON الكاملة القديمة (خطر استبدال الكل): `POST /api/timeline`، `POST /api/hospitals`،
  `POST /api/save-vacations`، `POST /api/announcements` (الجماعية) — لا تُبنى أصلًا دون قرار مالك.
- الرفع multipart: theme/هوية فقط — §22 و§19 أُغلقتا (APIClient صار يدعم multipart/form-data بأسماء RFC 5987).
- استيراد Excel للجداول (§6): **قرار مالك (2026-09-19) — Web-only**؛ iOS يعرض ويعدّل ويشغّل الجداول ويقرأ نتائج الاستيراد، والـImport نفسه من الويب فقط بلا endpoint جديد.
- شاشات تحليلية ثقيلة تحتاج قرار تصميم: لوحات دورة المناوبة (§8)، تحليلات `/api/analytics/*` (§21)،
  محادثة AI وإدارة المعرفة (§18).
- SSE/التحديث اللحظي: التطبيق يعتمد pull-to-refresh بوعي (§4/§5/§19).
- `GET /api/auth/sessions` (admin) ومسارات تخريبية (destroy-db/auto-fix) تبقى إدارة ويب.

**قواعد ثابتة لأي توسعة:** لا قاعدة بيانات ثانية · الـBackend مصدر الحقيقة ·
لا endpoint جديد إلا عند ثبوت فجوة تكافؤ حقيقية وبعد عرض التصور · الويب يبقى
يعمل · التنفيذ بمجالات وظيفية (§13) لا بعدد الشاشات.

**ملاحظة تحقق:** كل شاشات Native مكتوبة ضد الأشكال المقروءة من server.js/db.js/services
ومغطاة باختبارات فك/ترميز — لكن البناء النهائي والتحقق الحي يتم على Mac/Xcode وiPhone
فقط (لا مترجم Swift على بيئة التطوير الحالية).

---

## جولة QA التشغيلية الأولى (بعد اكتمال البناء — 2026-09-19)

فحص End-to-End على iPhone حقيقي كشف ثلاث ملاحظات، ومعالجتها:

| الملاحظة | السبب الجذري | المعالجة |
|---|---|---|
| التمركز والتوزيع: «رد غير متوقع من الخادم» | فكّ DTO صارم — بيانات production المخزنة قد تحمل تمثيلات قديمة (معرّفات رقمية، إحداثيات نصية) تُسقط الرد كاملًا | فكّ متسامح في `PositioningOpsDTO` (FlexText/FlexNum) بلا تغيير العقد — commit `92b0e82` |
| التكميل: «العنصر غير موجود» | استدعاء مسار **غير موجود** في الخادم `/api/smart-operator/current-shift` (اختلاق) بدل `/api/current-shift` الحقيقي | تصحيح المسار — commit `b695133` |
| الجدول: «تغطية جزئية 16/19» و«آخر تحديث» يبدو قديمًا | **ليست مشكلة تطبيق**: القيمتان محسوبتان سيرفريًا في `my-portal-service.getSchedule` — coverage على الأيام المنقضية (قرار ⑤)، وlastUpdate = max(created_at) لسجلات roster الشهر (المخطط بلا updated_at). التطبيق يعرض العقد بأمانة | لا تغيير — موثق |

### Native Push End-to-End (تشخيص كامل)

- **التطبيق (كامل):** AppDelegate hooks + تفويض مركز الإشعارات + طلب صلاحية alert/sound/badge + تسجيل التوكن بعد المصادقة فقط + willPresent يعرض banner/sound/badge + الضغط يوجّه عبر DeepLinkRouter + entitlement `aps-environment=development` مطابق لبناء Xcode. أُضيفت تشخيصات DEBUG المطلوبة (حالة الصلاحية وتفاصيلها، تسجيل التوكن، نتيجة الربط الخادمي بنوع الخطأ، الاستلام/العرض/الضغط) وإصلاح ربط الجهاز عند تبديل الحساب — commit `5d0857a`.
- **الخادم (origin/main):** مسارات `/api/my/push/register|unregister` و`push-gateway` سليمة — Alert Push حقيقي (`aps.alert` + sound + badge)، توجيه sandbox/production لكل جهاز، فصل التوكنات الميتة، وضع معطَّل آمن بلا مفاتيح.
- **نقطة الانقطاع الوحيدة كانت (قرار مالك، ليست كود):** نشر Render يسبق دمج فرع Push + مفاتيح `APNS_*` غير مضبوطة.
- **✅ محسومة (2026-09-19):** بعد ضبط `APNS_KEY/APNS_KEY_ID/APNS_TEAM_ID` في Render، تحقق المالك على iPhone حقيقي من السلسلة كاملة: صلاحية authorized (alert/sound/badge مفعّلة) ← تسجيل الجهاز 200 ← إشعار تغيير مناوبة ← **Native iOS Banner خارج التطبيق**. Push End-to-End مكتمل ولا يُعدَّل مساره.

### تدقيق عقود API الآلي

`scripts/api-contract-audit.js`: يستخرج 241 استدعاء API من التطبيق ويطابقها مع 414 مسارًا في server.js — **صفر فجوات حقيقية** (حالتان إيجابيتان كاذبتان من مسارات ديناميكية مؤلَّفة، ومسارا Push الموجودان في origin/main).

### قرارات نطاق معتمدة من المالك (2026-09-19)

- **الجداول في iOS:** عرض + تعديل خلايا + تعيين/نقل/تبديل وبقية عمليات الجدول حسب الصلاحيات + قراءة نتائج الاستيراد بعد تنفيذه من الويب.
- **Excel/استيراد ملفات الجداول:** منصة الويب فقط — لا يُبنى Import في التطبيق ولا يُطلب Backend endpoint جديد له.
- **الملفات (§22):** للمستندات والإعلانات والمرفقات التشغيلية فقط — ليست قناة Import للجداول.
- **الدردشة (§19):** مجمّدة (Deferred/Frozen) — لا تطوير إضافي عليها حاليًا (المرفقات المبنية في `e844bfc` تبقى كما هي بلا توسعة).
