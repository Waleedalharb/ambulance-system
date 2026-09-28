# EMS OPERATIONS — Native iOS Architecture

> المشروع: Native iOS Client (SwiftUI) فوق EMS Backend القائم.
> الفرع: `feature/native-ios-app` · البنية: `ios-native/`
> القاعدة: الـBackend والويب وقاعدة البيانات **لا تُعاد كتابتها** — التطبيق Client صرف.
> مشروع Capacitor (`ios/`) يبقى شبكة أمان انتقالية ولا يُحذف في هذه المرحلة.

## 1) المعمارية

```
EMS Backend (Production: https://emsoperations.online)
   REST APIs (Bearer JWT)          Push Gateway (APNs)
        │                                │
        ▼                                ▼
┌─────────────────────────────────────────────┐
│           EMSOperations (SwiftUI)           │
│  App → RootView (Session-gated)             │
│  ├─ Authentication  (AuthService/Keychain)  │
│  ├─ Networking      (APIClient موحد)        │
│  ├─ Notifications   (PushService/APNs)      │
│  ├─ Security        (Keychain/Face ID)      │
│  ├─ DesignSystem    (EMSTheme/Components)   │
│  └─ Features        (Login/Home/Shift/...)  │
└─────────────────────────────────────────────┘
```

مبادئ ملزمة:
- لا Business Logic في التطبيق — كل الحساب في الخادم (نفس فلسفة `my-ems.js`).
- الهوية من التوكن — لا يُرسل employee_id من العميل إطلاقًا.
- الصلاحيات تُطبَّق خادميًا (الخادم يخفي الجوال بلا `staff.phone_view`) — التطبيق يعرض ما يصله فقط.
- لا WebView كواجهة رئيسية في أي شاشة.

## 2) قرارات هندسية موثقة

| # | القرار | البديل المرفوض وسببه |
|---|---|---|
| D1 | iOS 16.0 كحد أدنى (NavigationStack) | iOS 15 يفرض NavigationView القديم — لا قاعدة أجهزة عندنا تحتاجه |
| D2 | بلا حزم طرف ثالث — URLSession + Swift Concurrency فقط | Alamofire/Combine يضيفان اعتمادية بلا حاجة |
| D3 | التوكنات + هوية المستخدم في Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) | UserDefaults غير آمن للجلسة؛ وFace ID يُطلب عند فتح الجلسة إن فعّله المستخدم (البوابة منطقية لا قيد Keychain — أبسط وأوثق عند إعادة التثبيت) |
| D4 | تحديث تلقائي واحد عند 401 عبر `/api/auth/refresh` ثم إعادة الطلب مرة واحدة | إعادة محاولات متسلسلة تخفي انتهاء الجلسة الحقيقي |
| D5 | Launch عبر `UILaunchScreen` في Info.plist (لون الهوية + الشعار) | Storyboard إضافي بلا فائدة في SwiftUI |
| D6 | Deep Link عبر `DeepLinkRouter` مركزي (NotificationCenter) يترجم `data.kind` إلى وجهة | ربط كل شاشة بالإشعارات مباشرة يكرر المنطق |
| D7 | بيئة APNs من `#if DEBUG` (development/production) — مطابق لحقل `push_devices.environment` | إدخال المستخدم للبيئة خطأ تشغيلي |
| D8 | `project.pbxproj` مكتوب يدويًا بصيغة Xcode 14 المتوافقة (objectVersion 56) — يُفتح مباشرة في Xcode 15/16 | XcodeGen/Tuist يفرضان تثبيت أداة على جهاز المالك |
| D9 | الأيقونات تُعاد من `ios/App/App/Assets.xcassets/AppIcon.appiconset` (أصول معتمدة من المالك) | توليد أيقونات جديدة يكسر الهوية المعتمدة |
| D10 | شاشة التكميل تقرأ الحالة وتنفذ البنود عبر نفس مسارات الويب حرفيًا؛ التحقق النهائي من تفاصيل الحمولة يتم على الجهاز (الخادم مصدر الحقيقة) | نسخ منطق التكميل داخل iOS ممنوع |

## 3) API Mapping (الفعلي من `server.js` + `services/my-portal-service.js`)

كل مسارات `/api/my/*`: `Authorization: Bearer <accessToken>` + صلاحية `ops.my_portal`.
أخطاء موحدة: `401` جلسة · `403` صلاحية · `404 {code:"NO_EMPLOYEE"}` بلا ملف موظف.

| المسار | الاستجابة (الحقول) |
|---|---|
| `POST /api/auth/login` `{username,password}` | `{success, accessToken, refreshToken, user:{id,username,name,role}}` |
| `POST /api/auth/refresh` `{refreshToken}` | `{success, accessToken, user:{id,username,name,role}}` |
| `POST /api/auth/logout` (Bearer) | `{success}` — يحظر التوكن ويفصل أجهزة Push |
| `GET /api/my/profile` | `{employee:{id,code,name,jobTitle}, today:{date,shiftCode,shiftName,timeStart,timeEnd,teamId,teamName,center,assignmentSource}, lastRosterUpdate}` |
| `GET /api/my/schedule?month&year` | `{month,year,coverage,elapsedDays,coveredDays,days:[{date,shiftCode,shiftName,codeStatus,teamId,teamName,center}],lastUpdate}` |
| `GET /api/my/assignments` | `{periods:[{teamId,teamName,center,from,to}]}` |
| `GET /api/my/team-incidents` | `{today:{date,count,reason},week:{start,end,count},month:{year,month,count},byTeam:[{teamId,teamName,center,from,to,count}],unmatchedUnits,note}` |
| `GET /api/my/sections` | `{sections:{profile,schedule,assignments,incidents,vehicle,inventory,check}}` |
| `GET /api/my/vehicle` | `{team,assignmentSource,vehicles:[…],available,reason}` |
| `GET /api/my/inventory` | `{team,assignmentSource,hasData,assets:{total,byStatus},lastSession:{id,status,started_at,submitted_at,approved_at,conductor_name}}` |
| `GET /api/my/shift-mates` | `{available,window:{date,side,label,source,active},me:{onShift,state,shiftCode,teamId,teamName},team:[person],leadership:[person],ops:[person]}` — person: `{id,name,jobTitle,teamName,shiftCode,phone?,isMe?}` (phone بصلاحية فقط) |
| `GET /api/my/notifications` | `{notifications:[{id,message,status,shiftDate,revisionId,createdAt,openedAt,acknowledgedAt}],unreadCount,unackedCount}` |
| `POST /api/my/notifications/:id/read` | `{success,status}` |
| `POST /api/my/notifications/:id/ack` | `{success,status}` |
| `GET /api/my/schedule-changes` | `{changes:[{id,date,oldShiftCode,newShiftCode,oldTeam,newTeam,changeType,changeLabel,reason,changedByName,createdAt,revisionId,revisionSource,revisionActor}]}` |
| `GET /api/my/check-session` | حالات: `{state:'no_assignment'|'not_field_team',…}` أو جلسة `{session,vehicle,…}` — التفاصيل تُثبَّت على الجهاز (D10) |
| `POST /api/my/check-session/items` `{item_key,result,note?,status_detail?,qty_available?}` | نتيجة البند |
| `POST /api/my/check-session/confirm` | تأكيد الجلسة |
| `POST /api/my/push/register` `{token,platform,environment,appVersion}` | `{success,registered,environment}` |
| `POST /api/my/push/unregister` `{token?}` | `{success}` |

## 4) Authentication Flow

1. Login → Keychain(`accessToken`,`refreshToken`,`user JSON`).
2. `restoreSession()`: توكن موجود → `GET /api/my/profile` تحقق حي → authenticated؛ 401 → محاولة refresh واحدة → فشل ⇒ unauthenticated (مسح الجلسة).
3. Face ID اختياري بعد أول دخول (علم في UserDefaults): عند الإقلاع بجلسة مخزنة والعلم مفعّل ⇒ بوابة Face ID قبل عرض المحتوى؛ الفشل/الإلغاء ⇒ شاشة دخول (الجلسة تبقى مخزنة).
4. Logout: `POST /api/my/push/unregister` (بذل قصوى) ← `POST /api/auth/logout` ← مسح Keychain — نفس دلالة الويب.

## 5) APNs Flow

```
didFinishLaunching → PushService.register():
  UNUserNotificationCenter.requestAuthorization → granted
  → UIApplication.registerForRemoteNotifications
didRegister → token hex → POST /api/my/push/register
  {platform:"ios", environment: DEBUG?development:production, appVersion}
didReceive response (tap) → DeepLinkRouter:
  data.kind == "schedule_change" → شاشة «سجل تغييرات جدولي»
  غير ذلك → «إشعاراتي»
logout → unregister (الخادم يفصل كل أجهزة الحساب أيضًا في /api/auth/logout)
```

الشارة (badge): يديرها الخادم في الحمولة (عدد غير المقروء لحظة الإرسال) + تحديث صامت بعد القراءة. `UIBackgroundModes: remote-notification` مفعّل.

## 6) Navigation

TabView (RTL تلقائي): الرئيسية · مناوبتي · الجدول · الإشعارات (بشارة) · حسابي.
ثانوية من الرئيسية (بطاقات مشروطة بـ`/api/my/sections`): زملائي · التكميل · بلاغات فرقتي · المركبة · العهدة · سجل تغييرات جدولي · التكليفات.

## 7) Security

- ممنوع في Git/الكود/plist: `.p8`، مفاتيح APNs، أي secret (التحقق في اختبار الحراسة).
- اللوجز عبر OSLog بفئات، بلا توكنات/كلمات مرور (مُرشّح نصي في AppLogger).
- لا ATS استثناءات — HTTPS فقط.

## 8) Local Storage

| البيانات | المكان |
|---|---|
| accessToken/refreshToken/user | Keychain |
| تفعيل Face ID، آخر بيئة | UserDefaults |
| كاش قراءة خفيف لكل شاشة (دقائق) | ذاكرة VM فقط (لا persistence في v1 — القرار موثق: البيانات التشغيلية freshness أولًا، وعرض «آخر تحديث» من الحقل القادم من الخادم) |

## 9) Testing

- `EMSOperationsTests` (XCTest): فك ترميز DTOs (عينات JSON حرفية من الخادم)، APIError mapping، Keychain round-trip، DeepLinkRouter، Session restore logic (URLProtocol وهمي).
- `scripts/native-ios-audit.js` (Node — يعمل من الجذر): حراسة المصدر (لا .p8، لا WebView، لا secrets، اكتمال الملفات المرجعية في pbxproj).
- الفيزيائي (على iPhone): قائمة القسم 40 من المواصفة — 18 بندًا.

## 10) Deployment Process (عند حينه وبموافقة المالك فقط)

1. Build على Mac من الفرع `feature/native-ios-app` (Bundle `online.emsoperations.app`, Team WALEED ALHARBI, Automatic signing).
2. aps-environment: development للاختبار المحلي، production لـTestFlight.
3. نشر Backend APNs (`feature/push-apns` أو main بعد اعتماد) على Render **بموافقة منفصلة** + متغيرات `APNS_*`.
4. Capacitor لا يُحذف إلا بمهمة Cleanup مستقلة بعد اعتماد Native نهائيًا.
