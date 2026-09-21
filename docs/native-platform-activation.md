# Native Platform Activation — جرد الـAPIs وخطة التفعيل

**الهدف:** إطفاء شاشات «قيد التفعيل» في وحدة العمليات بربطها بمسارات القراءة
الموجودة فعلًا في الـBackend — قراءة فقط، بلا أي مسار كتابة، وبلا أي API جديد.

**قاعدة الجرد:** كل صف أدناه تحقق منه من مصدر الـBackend (`server.js` /
الخدمات) مباشرة — لا افتراضات. كل الشاشات الست المطلوبة لها مسار قراءة قائم
ومعتمد، فلا حاجة لأي توسعة Backend في هذه المرحلة.

## ① جرد الشاشات

| الشاشة | الـAPI الموجود | شكل البيانات (من المصدر) | تُربط مباشرة؟ | الناقص |
|---|---|---|---|---|
| **الفرق** | `GET /api/teams` (server.js:11349) | `{success, teams:[{id,name,center,team_type,sort_order,is_active,requiredPersonnel,operational_starts?}]}` | ✅ نعم | — |
| **الجاهزية** | `GET /api/staffing/state` (server.js:7416) ← `deriveTeamReadiness` | `{success, shiftId, domain, entities, teams:{الاسم→{status:ready\|missing\|offline\|pending, reason, activeCount, requiredPersonnel, center, members[], effectiveRoster[], absentees[], vacant, vehicleId, vehicleStatus, vehicleOk, supportVehicleIds[], lastDecision}}, workforce:{totalStaff,totalRequired,supporters,absentees,scheduledStaff,requiredTeams,readyTeams,missingTeams,offlineTeams,pendingTeams,totalCars,readinessRate,operationalReadinessRate}}` | ✅ نعم | — |
| **المركبات** | `GET /api/vehicles/board` (server.js:7857) | `{success, shiftId, counters:{active,reserve,breakdown,out_of_service,unset}, vehicles:[{id,name,status,reason,since,inWorkshop,teamId,supportingTeamId}], unassigned:[...], support:[{vehicleId,name,homeTeamId,targetTeamId,since}]}` | ✅ نعم | — |
| سجل المركبات (إثراء) | `GET /api/vehicles/registry` (server.js:7721) | `{success, vehicles:[{id,plate_number,call_sign,vehicle_type,model_year,category,designation,admin_status,owner_center_id,sort_order,is_active,created_at,notes}]}` | ✅ نعم | — |
| مراكز المركبات (إثراء) | `GET /api/vehicles/centers` (server.js:7741) | `{success, centers:[{id,name}]}` | ✅ نعم | — |
| **الأحداث التشغيلية** | `GET /api/timeline` (server.js:9036) | `{success, data:[{title,desc,type,date,time}]}` | ✅ نعم | — |
| **مركز القرار** | `GET /api/smart-operator/assessment` (server.js:7633) ← `decisionEngine.assess` | `{success, data:{generatedAt, shift:{id,type,date,status}\|null, shiftPhase:early\|mid\|late\|final\|unknown, readiness:{percent,status:stable\|attention\|critical}, risks:[{code,severity:critical\|warning\|info,team,title,detail}], recommendations:[{code,priority,title,action,target}], proactive:[{code,text}], summary, supportCount}}` | ✅ نعم | — |
| **الخريطة** | `GET /api/center-geo` (server.js:9565) | `{success, data:{اسم المركز:{center:[lat,lng], radius}}}` | ✅ نعم (MapKit iOS 16) | — |
| المناوبة الحالية (سياق) | `GET /api/current-shift` (server.js:2893) | `{success, shift:{id,status,...}\|{id:null,status:'none'}, serverNow, prepShift}` | ✅ نعم | — |
| النماذج/التصعيدات | `GET /api/escalations` · `GET /api/incidents` | `{success, records:[...]}` (FormsService، يفلتر بـform_type) | ✅ نعم (فك مرن) | — |

## ② النتيجة

- **6/6 شاشات عمليات** لها مسار قراءة قائم — لا شاشة تحتاج Backend جديدًا.
- **نبض العمليات في Home** (Executive Pulse) يُشتق من طلبين قائمين:
  `vehicles/board` (العدّادات) + `staffing/state` (`workforce`) — بلا API جديد.
- **لا شاشة تبقى «قيد التفعيل»** بعد هذه المرحلة داخل وحدة العمليات.

## ③ قواعد التنفيذ الملزمة

1. قراءة فقط — لا مسار كتابة واحد في التطبيق الأصلي لهذه المرحلة.
2. فكّ ترميز دفاعي: كل الحقول Optional ما عدا ما يضمنه الخادم صراحة
   (`success`، الحاويات الرئيسية).
3. لا بيانات وهمية ولا Placeholder data — الشاشة إما بيانات حقيقية أو حالة
   فشل/فارغة صادقة (`EMSErrorView` / `EMSEmptyView`).
4. نفس نمط الوحدة القائم: `ViewModel @MainActor` + `LoadState`
   (loading/loaded/failed) + `retry` + `refreshable` + `.emsPage`.
5. الخريطة بصيغة MapKit المتوافقة مع iOS 16
   (`Map(coordinateRegion:annotationItems:annotationContent:)`).
6. لا تعديل على `server.js` ولا أي خدمة Backend في هذه المرحلة.

## ④ خطة الملفات

- `Models/OpsDTO.swift` — DTOs الوحدة كاملة (فك دفاعي).
- `Features/Operations/OpsTeamsView.swift`
- `Features/Operations/OpsReadinessView.swift`
- `Features/Operations/OpsVehiclesView.swift`
- `Features/Operations/OpsEventsView.swift`
- `Features/Operations/OpsMapView.swift`
- `Features/Operations/DecisionCenterView.swift`
- تعديل `Features/Operations/OperationsHomeView.swift` — ربط الـNavigation.
- تعديل `Features/Home/…` — بطاقة «نبض العمليات» الحية.
- تعديل `EMSOperationsTests.swift` — اختبارات فك الـDTOs.
- تسجيل كل ملف جديد في `project.pbxproj` (4 مواضع لكل ملف) + حراسة
  `scripts/native-ios-audit.js` قبل كل commit.

## ⑤ حالة التفعيل (مُنفذ)

- **الشاشات المفعَّلة:** 6/6 — الفرق، الجاهزية، المركبات، الأحداث التشغيلية،
  مركز القرار، الخريطة. لا شاشة بقيت على «قيد التفعيل».
- **الـAPIs المرتبطة:** 7 قراءة فقط (`teams`، `staffing/state`،
  `vehicles/board`، `timeline`، `center-geo`، `current-shift`،
  `smart-operator/assessment`).
- **شاشات تحتاج Backend جديدًا:** لا شيء داخل نطاق هذه المرحلة.
- **نبض العمليات في الرئيسية:** عدّادات حية (مركبات + جاهزية) لحاملي
  صلاحيات العمليات — فشلها لا يكسر الرئيسية.
- **SHA النهائي:** `6dd9c92` على `feature/native-ios-app`.
- لم يُبنَ على Mac/Xcode بعد — البناء والاختبار الحقيقي على الجهاز هما
  الحكم النهائي على هذه المرحلة.
