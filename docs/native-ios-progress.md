# Native iOS — سجل التقدم

> يُحدَّث في نهاية كل مرحلة (القسم 46 من المواصفة). الحالات: ✅ منجز · 🚧 جارٍ · ⬜ لم يبدأ.

## Phase 0 — فحص المستودع وAPI Mapping ✅ (2026-09-17)
- حُصرت كل مسارات `/api/my/*` الـ19 + auth الثلاثة، وأشكال استجاباتها الحرفية من `my-portal-service.js`.
- وُثّقت في `docs/native-ios-architecture.md` (قسم 3) + القرارات D1-D10.
- فرع العمل: `feature/native-ios-app` من قمة `main` (`1b8213f`).

## Phase 1 — Foundation + Design System ✅ (2026-09-17, commit `30b10ec`)
- هيكل `ios-native/` كامل + `project.pbxproj` يدوي (objectVersion 56، هدف iOS 16.0، bundle `online.emsoperations.app`).
- APIClient موحد (actor، Bearer تلقائي، تحديث 401 مرة واحدة ثم إعادة، timeout 20، أخطاء عربية).
- EMSTheme (Navy/Teal/Emerald) + مكونات: Card/Button/StatusPill/InfoRow/Skeleton/Error/Empty/Background/PageModifier.

## Phase 2 — Authentication + Keychain + Face ID ✅ (`30b10ec`)
- KeychainService (service `online.emsoperations.app.session`) + AuthService (login/refresh/restore/logout).
- SessionStore مركزي + BiometricGate (Face ID بوابة استعادة فقط — لا يستبدل مصادقة الخادم).
- LoginView/LoginViewModel بهوية داكنة RTL.

## Phase 3 — Home + Current Shift ✅ (`94fef06`)
- HomeView: بطاقة اليوم + اختصارات مشروطة بخريطة `/api/my/sections`.
- CurrentShiftView + ShiftMatesView (قيادة/عمليات/فرقة، الهاتف حسب صلاحية الخادم).

## Phase 4 — Schedule + Shift Changes ✅ (`94fef06`)
- ScheduleView شهري (month/year) + ScheduleChangesView (Before/After + سبب التغيير + المصدر).

## Phase 5 — Notifications + APNs + Deep Links ✅ (`30b10ec` + `94fef06`)
- NotificationsView (قراءة/إقرار) + PushService (تسجيل الجهاز بعد الدخول فقط، token hex).
- DeepLinkRouter: `schedule_change` → سجل تغييرات جدولي · غيره → إشعاراتي.
- entitlements: `aps-environment development` (يُقلب production عند التوزيع).

## Phase 6 — Completion + Reports + Vehicle + Inventory + Profile ✅ (`94fef06`)
- CompletionView: حالات no_assignment/not_field_team + بنود الجلسة + تأكيد (D10 — الفك مرن بانتظار التثبيت على الجهاز).
- ReportsView (عدّادات يوم/أسبوع/شهر + حسب الفرقة + الملاحظة التوضيحية)، VehicleView، InventoryView، ProfileView (+Face ID toggle + خروج).
- AssignmentsView (تكليفاتي — فك مرن لشكل periods).

## Phase 7 — Offline + Error Handling + Performance 🚧 (جزئي)
- منجز: رسائل أخطاء عربية موحدة، حالات تحميل/خطأ/فراغ في كل شاشة، شارة «غير متصل» في الرئيسية، لا polling.
- متبقٍ: تخزين آخر قراءة محليًا (cache) للعرض دون اتصال.

## Phase 8 — Testing + Physical iPhone 🚧
- منجز: `EMSOperationsTests` — 12 اختبار وحدة (فك DTOs/snake_case/DeepLink/رسائل الأخطاء).
- منجز: `scripts/native-ios-audit.js` (لا أسرار، لا WebView، اكتمال pbxproj) — نظيف 33 ملف Swift.
- متبقٍ (على Mac المالك): أول `xcodebuild`، اختيار Team، Build على iPhone حقيقي، اختبار APNs فعلي.

## Phase 9 — Documentation + Final audit 🚧
- المعمارية + API mapping + التقدم موثقة. يتبقى دليل تشغيل Mac للمالك.

## Commits
- `6df58cf` docs: native iOS architecture, API mapping, and progress tracker
- `30b10ec` feat: native iOS foundation — app shell, API client, auth/session, keychain, Face ID, push service, design system
- `94fef06` feat: native iOS screens — login, home, shift, mates, schedule, changes, notifications, completion, vehicle, inventory, reports, profile
- `4dfe75c` build: native iOS Xcode project (iOS 16, APNs entitlements), app icon assets, unit tests, audit guard script

## ملاحظات تنفيذ
- البيئة الحالية للمطور: Windows — كتابة المشروع كاملة هنا؛ **لم يُجمَّع بعد**؛ أول `xcodebuild` على Mac المالك.
- لا Push إلى `main` ولا Render — فرع مستقل فقط.
- Capacitor (`ios/`) لم يُمس — يبقى شبكة أمان حتى اعتماد النسخة الأصلية على الجهاز.
