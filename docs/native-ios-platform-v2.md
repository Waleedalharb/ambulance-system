# EMS OPERATIONS — Native iOS Platform v2

> التحويل من «تطبيق موظف» إلى **Native Mobile Client لمنصة EMS OPERATIONS**.
> الفرع: `feature/native-ios-app` · القاعدة: `a39bad5` · التاريخ: 2026-09-17.
> الـBackend وقاعدة البيانات هما مصدر الحقيقة الوحيد — التطبيق عميل عرض وإجراء فوق الـAPIs القائمة.

## 1) Architecture

```
EMSOperations/
├── App/                     نقطة الدخول + التوجيه الجذري + AppDelegate (APNs)
├── Core/
│   ├── AppEnvironment.swift بيئات dev/prod (لا أسرار في الكود)
│   ├── Logging/             OSLog مقسّم (auth/network/push/navigation/session/operations)
│   ├── Networking/          APIClient موحد (Bearer، تحديث 401 مرة واحدة، timeout 20، أخطاء عربية)
│   ├── Authentication/      AuthService — login/refresh/logout عبر الخادم الحالي
│   ├── Session/             SessionStore — حالة الجلسة + ملكية PermissionStore
│   ├── Security/            KeychainService (التوكنات) + BiometricGate (Face ID بوابة استعادة)
│   ├── Permissions/         PermissionStore + PermissionMapper (خرائط نقية قابلة للاختبار)
│   ├── Notifications/       PushService — APNs native (تسجيل بعد المصادقة فقط)
│   ├── DeepLinks/           DeepLinkRouter مركزي (kind → وجهة)
│   ├── Storage/             SafeCache — JSON في Caches مع TTL، عرض دون اتصال فقط
│   └── Network/             NetworkMonitor — Online/Poor/Offline عبر NWPathMonitor
├── DesignSystem/            EMSTheme + مكونات موحدة (Card/Button/Pill/Row/Skeleton/Error/Empty)
├── Features/
│   ├── Login/               دخول Native (لا WebView)
│   ├── Home/                Operational Home ديناميكي + تكليفاتي
│   ├── Shift/               مناوبتي التفصيلية
│   ├── ShiftMates/          زملائي (قيادة/عمليات/فرقة، الهاتف حسب staff.phone_view خادميًا)
│   ├── Schedule/            الجدول الشهري
│   ├── ScheduleChanges/     سجل تغييرات جدولي (Before/After)
│   ├── NotificationsCenter/ إشعاراتي (قراءة/إقرار)
│   ├── Completion/          التكميل (بنود الجلسة + تأكيد)
│   ├── Vehicle/ · Inventory/ · Reports/
│   ├── Operations/          ★ أساس وحدة العمليات (فرق/جاهزية/مركبات/أحداث/قرار/خريطة)
│   └── Profile/             ملفي + Face ID toggle + خروج
├── Models/                  DTOs مطابقة لاستجابات الخادم (فك مرن للحقول غير الثابتة)
└── Resources/               Info.plist · entitlements · Assets (الأيقونة المعتمدة)
```

القاعدة: **Core ≠ Features**، وبوابة الموظف Module وليست التطبيق.

## 2) Permission-driven Navigation

المصدر الوحيد: `GET /api/auth/me/permissions` → `{role, role_label, permissions[], permissions_star, permissions_granted, permissions_revoked}` (permission-service.mePayload).

| القدرة | المفتاح |
|---|---|
| بوابة الموظف | `ops.my_portal` |
| وحدة العمليات | أي من `ops.execute/completion/dispatch/reports/report_detail/deployments/forms/team_exit/vehicles/alerts` |
| مؤشرات المساهمة | `indicators.contribution` |
| جوالات الموظفين | `staff.phone_view` (يُطبق خادميًا أيضًا) |
| المدير | `permissions_star = true` ('*') |

التبويبات: الرئيسية (للجميع) · العمليات (مشروط) · الجدول + الإشعارات (بوابة الموظف) · حسابي.
**إخفاء تبويب ليس حماية** — الخادم يفرض الصلاحية في كل طلب (401/403/NO_EMPLOYEE مُعالجة برسائل عربية).
حساب بلا بوابة موظف (403/NO_EMPLOYEE) يرى بطاقة هوية مؤسسية بدل خطأ.

## 3) Operational Home

شريط حالة المناوبة (من `/api/my/shift-mates` me.state) → بطاقة مناوبة اليوم → فريقي (عدّادات فرقة/قيادة/عمليات) → نبض العمليات (مشروط بالصلاحية) → مؤشرات المساهمة (مشروطة) → إجراءات سريعة (مشروطة بـ`/api/my/sections`) → آخر 3 تنبيهات.
لا بيانات مخترعة: أي قسم بلا مصدر خادمي لا يُعرض.

## 4) APIs المستخدمة

- Auth: `POST /api/auth/login` · `POST /api/auth/refresh` · `POST /api/auth/logout` · `GET /api/auth/me/permissions`
- Portal: `GET /api/my/` profile · schedule · assignments · team-incidents · sections · vehicle · inventory · check-session (+items/confirm) · shift-mates · notifications (+read/ack) · schedule-changes
- Push: `POST /api/my/push/register` · `POST /api/my/push/unregister` (عبر logout)

## 5) APNs Flow

iOS (AppDelegate → PushService) → APNs token hex → `POST /api/my/push/register` (بعد المصادقة فقط) → push_devices في الـBackend → NotificationService/ScheduleChangeNotifier → Push Gateway القائم.
الخروج يفصل الجهاز خادميًا. entitlement: `aps-environment=development` (يُقلب عند التوزيع).
لا .p8 في Git — المفتاح Render Secret فقط.

## 6) Authentication Flow

Login → Keychain (access+refresh) → PermissionStore.load() → PushService.register.
الاستعادة: Keychain → Face ID (إن فُعّل) → APIClient يحمل Bearer.
401 → refresh واحد → إعادة واحدة → غير ذلك خروج نظيف.

## 7) Deep Links

`data.kind` → `schedule_change` ⇒ تبويب الجدول + سجل التغييرات · غيره ⇒ إشعاراتي.
الوجهات المشروطة بتبويب مخفي تُتجاهل بأمان.

## 8) Offline / Network

NetworkMonitor (Online/Poor/Offline) → شارة في الرئيسية. SafeCache يحفظ آخر profile للعرض دون اتصال (بيانات عرض، ساعة TTL للطازج، stale للانقطاع).
لا Offline Database مستقلة ولا مزامنة محلية لبيانات التشغيل (ممنوع بالمواصفة).

## 9) Testing

`EMSOperationsTests` — 19 اختبار وحدة: فك DTOs (id مرن، snake_case، check-session، assignments متسامح) · PermissionMapper (star/portal/operations/indicators/phones) · DeepLinkRouter · رسائل APIError · ترميز CheckItemRequest.
سكربت الحراسة `scripts/native-ios-audit.js`: لا أسرار · لا WebView · اكتمال pbxproj · لا Capacitor في المشروع الأصلي — **نظيف (37 ملف Swift)**.

## 10) Build Instructions (Mac)

```bash
git fetch origin && git checkout feature/native-ios-app
open ios-native/EMSOperations.xcodeproj
```
Signing → Team: WALEED ALHARBI → Bundle: online.emsoperations.app → جهاز iPhone → Run.
Push على الجهاز الحقيقي يتطلب APNs Key في Render (APNS_KEY_BASE64/APNS_KEY_ID/APNS_TEAM_ID).

## 11) Known Limitations

- لم يُجمَّع بعد على Xcode (بيئة التطوير Windows) — أول build على جهاز المالك.
- شكلا check-session/assignments مفكوكان بمرونة — يُثبَّتان بعد أول رد فعلي على الجهاز.
- وحدة العمليات = أساس ملاحة + شاشات «قيد التفعيل»؛ لا مسارات قراءة خادمية لها بعد.
- مؤشرات المساهمة تعرض بطاقة تحويل للويب حتى يُعتمد مسار Native.
- SafeCache للعرض فقط — لا إجراءات Offline.

## 12) Future Modules

Operations (فرق/جاهزية/مركبات/أحداث/قرار/خريطة) · Command Center · Management · أي دور مستقبلي يُضاف بمفتاح صلاحية + بطاقة Home — دون إعادة بناء Navigation.
