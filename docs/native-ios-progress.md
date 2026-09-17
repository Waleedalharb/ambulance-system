# Native iOS — سجل التقدم

> يُحدَّث في نهاية كل مرحلة (القسم 46 من المواصفة). الحالات: ✅ منجز · 🚧 جارٍ · ⬜ لم يبدأ.

## Phase 0 — فحص المستودع وAPI Mapping ✅ (2026-09-17)
- حُصرت كل مسارات `/api/my/*` الـ19 + auth الثلاثة، وأشكال استجاباتها الحرفية من `my-portal-service.js`.
- وُثّقت في `docs/native-ios-architecture.md` (قسم 3) + القرارات D1-D10.
- فرع العمل: `feature/native-ios-app` من قمة `main` (`1b8213f`).

## Phase 1 — Foundation + Design System 🚧
- [ ] هيكل `ios-native/` + `project.pbxproj` (D8).
- [ ] APIClient موحد (تحديث 401 تلقائي، D4).
- [ ] EMSTheme + مكونات (Card/Button/Status/Loading/Error/Empty/Skeleton).

## Phase 2 — Authentication + Keychain + Face ID ⬜
## Phase 3 — Home + Current Shift ⬜
## Phase 4 — Schedule + Shift Changes + Shift Mates ⬜
## Phase 5 — Notifications + APNs + Deep Links ⬜
## Phase 6 — Completion + Reports + Vehicle + Inventory + Profile ⬜
## Phase 7 — Offline + Error Handling + Performance ⬜
## Phase 8 — Testing + Physical iPhone ⬜ (على جهاز المالك)
## Phase 9 — Documentation + Final audit ⬜

## ملاحظات تنفيذ
- البيئة الحالية للمطور: Windows — كتابة المشروع كاملة هنا؛ أول `xcodebuild` على Mac المالك.
- لا Push إلى `main` ولا Render — فرع مستقل فقط.
