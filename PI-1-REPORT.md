# تقرير إثبات تنفيذ PI-1 — Place Intelligence Engine
## 2026-08-29 · تنفيذ محلي فقط · **لا Commit / Push / Deploy تم**

**المرجع:** `pi-1-directive-final.md` (الأمر المعتمد) · `pi-1-review-checklist.md` (بطاقة المراجعة) · `place-intelligence-architecture.md` (الدراسة)

---

## 1. Before → After

| | Before | After |
|---|---|---|
| التعرف على موقع البلاغ | غير موجود | محرك `PlaceIntelligenceService` بالقواعد R1–R5 |
| سجل المواقع | `map-locations.json` (12 مستشفى للعرض فقط) | سجل موحد `data/places.json` — 21 موقعًا (12 مستشفى + 9 مراكز داخلية) بـ `placesVersion=1` |
| نتيجة البلاغ | — | `placeResolution` لكل بلاغ: placeId/placeType/placeName/decision/confidence/rule/evidence/resolvedAt/engineVersion/placesVersion |
| المرشحون | — | `data/place-candidates.json` — اكتشاف learned بلا تحويل آلي إلى active |

**Before → After بالأنظمة القائمة:** Hospital Monitor · Duplicate Detection · report_times · الاحتساب · الجداول · CAD · الأرشيف · الخريطة · التنبيهات = **بدون أي تغيير** (صفر ملفات قائمة معدّلة — البند 15).

## 2. الملفات المنشأة والمعدّلة

| الملف | الحالة | الغرض |
|---|---|---|
| `services/place-intelligence-service.js` | **جديد** | المحرك: R1–R5، التطبيع العربي، المطابقة بحدود كلمة، السجل، التخزين، إعادة الحسم |
| `scripts/places-seed.js` | **جديد** | بناء بذرة السجل من المصدرين الموجودين (idempotent) |
| `scripts/place-intelligence-test.js` | **جديد** | Golden Set + التطبيع + السقوف + التخزين/إعادة الحسم — **26 اختبارًا** |
| `scripts/place-intelligence-historical-run.js` | **جديد** | تشغيل تحليلي قراءة-فقط على `incident_registry` + اكتشاف مرشحين |
| `data/places.json` | **جديد** | السجل الموحد (placesVersion=1) |
| `data/place-candidates.json` | **جديد** | تجمع المرشحين (فارغ حاليًا — لم يُكتشف مرشح) |

**ملفات معدّلة: صفر.** `haversineMeters` أُعيد استخدامها من `duplicate-detection.js` عبر `require` — لا نسخة ثانية.

## 3. بنية `places`

```text
placeId, placeType, subtype, name, nameVariants[], lat, lng, radiusM,
district, internal, source(seed|manual|learned), status(active|candidate|retired),
evidence[], createdAt, updatedAt, createdBy
```
- المستشفيات: `radiusM=200` (حرم واسع) · المراكز: `150` (الافتراضي) · `internal:true` للمراكز.
- `nameVariants`: الاسم كما ورد فقط — لا توسعة مخمّنة (Precision First).
- ⚠️ بذرة المستشفيات **للتطابق المكاني فقط**؛ `hospitalName` ورحلات المستشفيات من مخزن 1B حصريًا.

## 4. بنية `placeResolution`

```text
eventId, placeId, placeType, placeName, decision(confirmed|likely|unknown),
confidence(0-100), rule(R1-R5), evidence[{key,text,...}], resolvedAt,
engineVersion('1.0.0'), placesVersion, internalContext
```
- تُخزَّن في `data/place-resolutions.json` مفتوحة على `eventId` + `history` تدقيقي append-only.
- التصميم يسمح بتدرج تدقيق الأرشيف لاحقًا: نوع الجهة ← الجهة ← مؤكد/محتمل ← البلاغات ← التفاصيل ← الأدلة (كل مستوى قابل للاشتقاق من الحقول أعلاه: `placeType` ← `placeId` ← `decision` ← `eventId` ← `evidence`).

## 5. R1–R5 مع أمثلة فعلية (من نتائج الاختبار)

| القاعدة | مثال فعلي | الناتج |
|---|---|---|
| R1 | بلاغ على بعد 79م من مدرسة | Confirmed 94 — `confidence = 90 + 9×(1 − 79/150)` |
| R2 | اسم «مدرسة الملك خالد» في الوصف + إحداثيات داخل النطاق | Confirmed 93 — مدرستان بنفس الاسم، فازت صاحبة الإحداثي |
| R3 | اسم معروف بدون إحداثيات / خارج radiusM | Likely 70 — **ممنوع Confirmed** مهما كان التطابق النصي |
| R4 | كلمة «مدرسة» فقط في الوصف | Likely 60 — **placeType فقط، placeName=null** |
| R5 | لا أدلة / بلاغ داخل مركز تشغيلي | Unknown 0 — نتيجة مشروعة بلا تخمين |

## 6–8. Golden Set حالة بحالة + confidence + evidence

| # | الحالة | rule | decision | confidence | الدليل |
|---|---|---|---|---|---|
| G1 | مدرسة داخل 150م | R1 | confirmed | 94 | المسافة 79م · radiusM 150م |
| G2 | خارج 150م بلا دليل | R5 | unknown | 0 | لا R1 |
| G3 | مدرستان بنفس الاسم | R2 | confirmed | 93 | الإحداثي فرّق لصالح A |
| G4 | «مدرسة» فقط | R4 | likely | 60 | نوع فقط، بلا اسم |
| G5 | اسم بدون إحداثيات | R3 | likely | 70 | «لا إحداثيات — لا يجوز Confirmed» |
| G6 | اسم خارج radiusM | R3 | likely | 70 | «الإحداثيات خارج radiusM — لا يجوز Confirmed» |
| G7 | بلا دليل | R5 | unknown | 0 | — |
| G8 | مستشفى الملك فهد (بذرة حقيقية) | R1 | confirmed | 97 | المسافة ≈50م · radiusM 200م |
| G9 | مركز الشفا التشغيلي | R5 | unknown | 0 | «داخل مركز تشغيلي داخلي — ليس جهة خارجية» + internalContext |
| G10 | تضارب الاسم/الإحداثيات | R1 | confirmed | — | فاز الإحداثي + `evidence.conflict` موثق |
| G11 | غياب lat/lng | R4/R5 | likely/unknown | 60/0 | مسار نصي بسقوفه |

**النتيجة الكلية: 26/26 ✅** (Golden 11 + تطبيع/حدود كلمة 7 + سقوف 1 + بذرة حقيقية 2 [ضمن الجدول] + تخزين/اعتماد/إعادة حسم 7).

**فخ substring مثبت:** «مدرسة خالد» في النص **لا** تطابق موقع «مدرسة الملك خالد» (B4/B7).

**سقوف الثقة (مسح شامل على 8 حالات متنوعة):** لا نتيجة في النطاق المحظور 86–89 · لا Likely فوق 85 · لا Confirmed تحت 90 · Unknown=0 دائمًا (C1 ✅).

## 9. نتائج البيانات الحقيقية (145 بلاغًا في السجل، 50 بإحداثيات — قراءة فقط)

> **50 بلاغًا حُللت: 0 Confirmed · 1 Likely · 49 Unknown**

| | العدد | الملاحظة |
|---|---|---|
| Confirmed | 0 | — |
| Likely | 1 | R4 sports — «ملعب» في العنوان (بلاغ 1303999) |
| Unknown | 49 | R5 بلا تخمين |

**لماذا صفر Confirmed؟ (فحص provenance):** أقرب بلاغ تاريخي لأي مستشفى بذري يبعد **1217م** («م. د. سليمان الحبيب»، بلاغ 1306291) — كل البلاغات خارج radiusM. البلاغات تقع في الميدان (منازل/شوارع) لا داخل المستشفيات، وهذا **يؤكد قرار التصميم**: معلومة المستشفى تأتي من الرحلة (1B) لا من موقع البلاغ، والمحرك لم يخمّن شيئًا. كما أن `description` فارغ في كل السجل (0/145) — لم تصل ملاحظات CAD بعد، فالمسار النصي شبه غائب في هذه العينة.

## 10. candidate ≠ active

- **0 مجموعات مرشحة** في العينة (لا خلية ~150م فيها ≥3 بلاغات غير محسومة) → `place-candidates.json` فارغ — بصدق، لا اختراع.
- اختبار E1: مرشح learned بإحداثيات مطابقة تمامًا **لا يدخل المطابقة** (R5).
- اختبار E7 (خط أحمر): `addPlace` بـ `source:'learned'` حتى مع طلب `status:'active'` صراحة **يُفرض candidate** — لا مسار آلي للاعتماد.

## 11. placesVersion وإعادة الحسم

- الاعتماد البشري `approveCandidate(placeId, reviewer)` هو **المسار الوحيد** candidate ← active، ويرفع `placesVersion` (اختبار E3: 0 ← 1).
- إعادة حسم بلاغ سابق بعد الاعتماد: `unknown` ← `confirmed/R1` مع سجل history موثق بالنسختين: «إعادة حسم بعد اعتماد بشري (placesVersion 0 ← 1)» (E4/E5 ✅).

## 12. عدم الانحدار — بالأدلة

| الحزمة | النتيجة |
|---|---|
| hospital-monitoring-lost | 48/48 ✅ |
| hospital-cycle | 53/53 ✅ |
| hospital-monitor-smoke | 16/16 ✅ |
| notification-hospital-ux | 49/49 ✅ |
| schedule-month-guard | 23/23 ✅ |
| multi-month | 7/7 ✅ |
| duplicate-detection-v2 | 13/13 ✅ (ومخرجات 2.0 على البيانات الحقيقية: 0 أزواج — كالسابق) |
| الانحدار الشامل (213) | **201/213 — نفس الـ12 فشل البيئية المعروفة في الـbaseline حرفيًا** (W1-B، V-B، SR-1، SR-2) |

## 13. الحالات الطرفية المغطاة

تضارب اسم/إحداثيات (G10) · غياب lat/lng (G11) · اسم مشترك بين موقعين (G3/G5) · بلاغ داخل مركز داخلي (G9) · تعدد المواقع داخل النطاق (evidence.multi) · إحداثيات خارج النطاق الجغرافي الصحيح تُرفض · candidate لا يُطابَق (E1) · إعادة الحسم موثقة (E5).

## 14. ما لم تستطع المنظومة حسمه ولماذا

1. **49/50 بلاغًا تاريخيًا = Unknown** — لا مواقع معروفة قريبة ولا نصوص كافية. هذا متوقع ومقبول في PI-1: السجل بذرته 21 موقعًا فقط، والنمو عبر المرشحين والمراجعة البشرية (PI-2).
2. **لا يوجد حقل «اسم موقع» صريح في CAD** — التعرف استنتاج بأدلة لا قراءة حقل، ولذلك نظام الثقة أساسي.
3. **`description` فارغ في السجل التاريخي كله** — المسار النصي سيقوى فقط عندما تصل ملاحظات CAD فعليًا للبلاغات الجديدة.

## 15. Git status (إثبات)

```text
?? pi-1-directive-final.md
?? pi-1-review-checklist.md
?? place-intelligence-architecture.md
?? scripts/place-intelligence-historical-run.js
?? scripts/place-intelligence-test.js
?? scripts/places-seed.js
?? services/place-intelligence-service.js
```
**صفر ملفات قائمة معدّلة. كل الإضافات untracked. (ملفات data/ الجديدة خارج التتبع أصلًا.)**

## 16. تأكيد صريح

**لا Commit / Push / Deploy تم. التنفيذ محلي بالكامل. لم تُلمس الأنظمة العشرة المحظورة. لا مصدر حقيقة ثانٍ للمستشفيات. لا واجهة. لا PI-2. متوقف بانتظار مراجعة المالك وفق `pi-1-review-checklist.md`.**

---

## ملحق مراجعة المالك (2026-08-29) — دلالة R1 ومبرر radiusM

**سؤال المراجعة:** هل R1 يعني أن القرب الجغرافي وحده يثبت الارتباط (A) أم أن radiusM يمثل نطاق الجهة الفعلي (B)؟

**الإجابة:** النية (B) — المحرك يفترض أن `radiusM` المخزن = نطاق الجهة الفعلي. الثغرة المعروفة: إذا كان radiusM أكبر من الحدود الفعلية، بلاغ مجاور (شارع أمام مدرسة 70م) يُحسب Confirmed خطأً. المحرك لا يخمّن الحدود؛ يطبّق ما في السجل.

**مبرر قيم البذرة (بصراحة):** مستشفيات=200م ومراكز=150م — Defaults نوعية بحجم نمطي، ليست قياسًا فعليًا لكل موقع. `radiusM` حقل مستقل لكل Place وقاب للمراجعة.

**الإغلاق المعتمد مبدئيًا (تنفيذه في PI-2):** ضبط radiusM على الحدود الفعلية أثناء المراجعة البشرية لكل مرشح قبل الاعتماد + توثيق المبرر في evidence. خيار مستقبلي (يحتاج اعتمادًا): النطاق الخارجي من radiusM يهبط إلى Likely.

---

## ✅ اعتماد المالك النهائي (2026-08-29 13:49) — PI-1 معتمد رسميًا

مع الشروط المثبتة للجولات القادمة:
1. لا اعتماد Active لأي جهة جديدة بالقرب المكاني فقط.
2. عند اعتماد أي جهة: تحديد نطاقها الفعلي + ضبط radiusM مستقلًا + توثيق السبب في evidence.
3. Confirmed = ارتباط بالجهة ضمن نطاقها المعتمد، لا مجرد قرب.
4. الإحصائيات الرسمية من Confirmed فقط.
5. Likely منفصل تمامًا عن العدد الرسمي.
6. لا تحويل آلي للمرشحين إلى Active.
7. لا تغيير في Hospital Monitor / Duplicate Detection / الجداول / CAD / الاحتساب.
8. PI-2: اكتشاف مرشحين + مراجعة بشرية + ضبط نطاقات — بلا واجهة ولا نشر.

**القاعدة المثبتة:** «radiusM ليس مسافة سماح؛ هو تمثيل تشغيلي لنطاق الجهة المعتمد» — مدرسة حرمها 65م تأخذ 65، سجن يحتاج 280م يأخذ 280.
