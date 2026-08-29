# تقرير PI-3 — ربط Place Intelligence الحي السلبي + قسم «الجهات والمواقع» في أرشيف المناوبة

**التاريخ:** 2026-08-29
**الحالة:** منفذ محليًا + مختبر + أدلة كاملة — **بلا Commit / Push / Deploy**
**المرجعية:** `pi-3-directive-draft.md` (مع الحواجز التسعة) · `pi-1-directive-final.md` · `pi-2-directive-draft.md` · اعتمادات المالك 2026-08-29

---

## ① نطاق PI-3 كما نُفذ (Before → After)

| | قبل PI-3 | بعد PI-3 |
|---|---|---|
| محرك Place Intelligence | موجود من PI-1/PI-2 لكنه **غير موصول** بأي مسار تشغيلي | موصول سلبيًا بـ POST /api/cad-reports عبر طابور تسلسلي |
| لقطة أرشيف المناوبة | لا تحتوي أي معلومة عن الجهات/المواقع | تحتوي قسم `places` مختومًا: إحصائية Confirmed/Likely/Unknown لكل بلاغات المناوبة |
| ملفات النظام القائمة | — | ملفان فقط لُمسا: `server.js` و`shift-archive-engine.js`، وبإضافات additive صِرفة (55 سطرًا مضافًا / سطر واحد معدل) |

**ما لم يُنفذ (خارج النطاق عمدًا):** لا واجهة عرض تنفيذية (PI-4) · لا Commit/Push/Deploy · لا تعديل على report_times أو الاحتساب أو مخازن 1B أو الجداول أو Duplicate Detection أو Hospital Monitor.

---

## ② الملفات

### جديدة (2)
| الملف | الوظيفة |
|---|---|
| `services/place-resolution-hook.js` | `makeResolutionHook(placeIntel, logger)` → `{enqueue, _drain, _stats}` — طابور Promise تسلسلي (حاجز ①): الحسم لا يُنتَظر في الاستجابة، وفشل المحرك يُسجَّل `console.error` ولا يكسر الطابور ولا الاستجابة |
| `scripts/place-archive-test.js` | Golden Set الخاص بـ PI-3 — 13 فحصًا (انظر البند ⑤) |

### معدَّلة (2 — الملفان القائمان الوحيدان الملموسان، بالأسطر)

**`server.js`** (إضافتان، صفر حذف):
1. **بعد سطر 4861** (حقن hospitalMonitor): استيراد الخدمتين + إنشاء `placeIntel` (بـ `PLACES_DATA_DIR` كتجاوز اختباري عازل) + حقن late-binding في `archiveEngine.snapshot.placeIntel` + إنشاء `placeResolutionHook`.
2. **بعد سطر 5232** (داخل POST /api/cad-reports، بعد نجاح `createIncidentEntries`): كتلة additive ملتفة بـ `try/catch` تستدعي `placeResolutionHook.enqueue(number, {lat, lng, address, district, description})` — لا تُنتَظر، وفشلها لا يؤثر على الاستجابة إطلاقًا.

**`shift-archive-engine.js`** (3 إضافات):
1. تهيئة اللقطة (~سطر 376): `places: null` بجانب `hospital: null`.
2. الخطوة 19 (~سطر 435): `snapshot.places = await this._getPlaces(shiftId)` بعد قسم المستشفيات مباشرة وقبل حساب بصمة السلامة.
3. دالة `_getPlaces(shiftId)` (~سطر 661): بنفس نمط `_getHospital` — تقرأ أرقام البلاغات من `incident_registry` وتستدعي `this.placeIntel.archiveSectionForIncidents(numbers)`، وعند غياب الحقن أو الخطأ ترجع `null` **بصدق** (بلا حقن قيم وهمية).

**`services/place-intelligence-service.js`** (ملف PI-1 أصلًا — توسعة additive):
- `archiveSectionForIncidents(incidentNumbers)` — قراءة مخازن فقط (place-resolutions + places)، deep copy، ممنوع فيها resolve. البنية:
```
{ sealedAt, engineVersion,
  totals: { incidents, confirmedPlaceLinked, likelyPlaceLinked,
            unknownUnclassified, noResolution, denominatorNote },
  byType: [ { placeType, label, confirmedCount, likelyCount, uniquePlaces,
              percentOfConfirmed,
              places: [ { placeId, name, confirmedCount, likelyCount,
                          incidents: [ { eventId, rule, confidence,
                                         placesVersion, resolvedAt, evidence[] } ] } ] } ] }
```

---

## ③ إثبات عدم تغيّر POST /api/cad-reports

- **cad-report-integration: 89/89 ✅** بعد الحقن — نفس نتيجة baseline قبل PI-3.
- الكتلة المضافة تقع **بعد** اكتمال تسجيل البلاغ، لا تُنتَظر (`enqueue` غير awaited)، وملتفة بـ try/catch، ولا تلمس `result` ولا الاستجابة ولا `report_times`.
- **duplicate-v2: 13/13 ✅** — محرك كشف التكرار لم يتأثر.
- Golden Q1 يثبت: زمن الاستجابة لا ينتظر الحسم، والطابور يُفرَّغ تسلسليًا.
- Golden Q2 يثبت: فشل `recordResolution` داخل المحرك لا يكسر الطابور ولا يمنع البلاغات اللاحقة.

---

## ④ حواجز المالك التسعة — أين غُطيت

| الحاجز | المعنى | أين أُثبت |
|---|---|---|
| ① | طابور تسلسلي، الاستجابة لا تنتظر، لا lost update | `place-resolution-hook.js` + Golden Q1 + **A** (خمسون بلاغًا متزامنًا — صفر lost update) |
| ② | التحديث اللاحق لنفس البلاغ يعيد الحسم ويُوثَّق | Golden **B/B2** (حدث واحد Unknown→Likely→Confirmed يُحسب مرة بالحالة النهائية + history موثق) |
| ③ | اللقطة المختومة تاريخية ثابتة | Golden **C** (تعديل المخازن بعد الختم لا يغيّر اللقطة) |
| ④ | فصل Confirmed/Likely — Likely لا يدخل الأرقام الرسمية | Golden **D** + حقول `likelyCount` منفصلة في كل مستوى |
| ⑤ | Unknown لا يظهر تحت أي جهة | Golden **E** (يُحسب في `totals.unknownUnclassified` فقط) |
| ⑥ | نسبة بمقام موثق | Golden **F** (66.7% من 3 — المقام مصرّح به في `denominatorNote`) |
| ⑦ | أنواع canonical فقط | Golden **G** |
| ⑧ | الأرشيف مستهلك فقط — ممنوع resolve داخله | Golden **H** (بناء القسم ينجح بينما resolve مكسورة/مرمية) |
| ⑨ | عند غياب الحقن: null بصدق بلا حقن | Golden **W/W2** (`_getPlaces` ترجع null بلا مخدم، وبطلان الحقن لا يكسر الختم) |

---

## ⑤ Golden Set الخاص بـ PI-3 — حالة بحالة (13/13 ✅)

| # | الفحص | النتيجة |
|---|---|---|
| Q1 | الطابور تسلسلي والاستجابة لا تنتظر الحسم | ✅ |
| Q2 | فشل المحرك لا يكسر الطابور ولا البلاغات اللاحقة | ✅ |
| A | 50 بلاغًا متزامنًا — صفر lost update، العد النهائي صحيح | ✅ |
| B | إعادة حسم نفس البلاغ: حدث واحد يُحسب مرة بالحالة النهائية | ✅ |
| B2 | المسار Unknown→Likely→Confirmed موثق في history | ✅ |
| C | ثبات اللقطة المختومة بعد تعديل المخازن | ✅ |
| D | Confirmed/Likely منفصلان عدديًا في كل مستوى | ✅ |
| E | Unknown لا يظهر تحت أي جهة | ✅ |
| F | النسبة بمقام موثق (66.7% من 3) | ✅ |
| G | أنواع canonical فقط في byType | ✅ |
| H | القسم يُبنى من المخازن حتى مع resolve مكسورة (مستهلك صِرف) | ✅ |
| W | `_getPlaces` بلا محرك محقون ⇒ null بصدق | ✅ |
| W2 | بطلان الحقن لا يكسر ختم اللقطة | ✅ |

> ملاحظة شفافية: الفحص C فشل في أول تشغيلة بسبب **خطأ في الاختبار نفسه** (المدرسة المزروعة كانت على بعد ~1.5كم من إحداثيات البلاغ فلم يحسمها المحرك Confirmed) — صُححت الإحداثيات في بذرة الاختبار ونجح. لا علاقة للفشل بمنطق النظام.

---

## ⑥ عدم الانحدار — بالأرقام

| الحزمة | النتيجة |
|---|---|
| place-intelligence (PI-1) | **26/26 ✅** |
| place-discovery (PI-2) | **13/13 ✅** |
| place-archive (PI-3) | **13/13 ✅** |
| monitoring-lost (دورة المستشفيات) | **48/48 ✅** |
| cycle (دورة المناوبة) | **53/53 ✅** |
| smoke | **16/16 ✅** |
| duplicate-v2 | **13/13 ✅** |
| cad-report-integration | **89/89 ✅** |
| schedule-month-guard (حارس الجداول) | **23/23 ✅** |
| multi-month | **7/7 ✅** |
| **الانحدار الشامل** | **201/213 — نفس الـ12 فشل البيئية المعروفة من baseline** (W1-B/V-B/SR-1/SR-2 — غيابات وتكميل وبيئة واجهة، موجودة قبل PI-1 ولم تتغير) |

`report_times` واحتساب المشاركات: لم تُمس (لا استعلام واحد عليهما في الملفات الجديدة/المعدلة)، وحزم cad-report-integration وcycle تغطيهما.

---

## ⑦ حالة المستودع (git)

```
 M server.js                  (+15 سطرًا — إضافتان)
 M shift-archive-engine.js    (+29 سطرًا / −1 — ثلاث إضافات)
?? PI-1-REPORT.md  PI-2-REPORT.md  pi-1-directive-final.md
?? pi-1-review-checklist.md  place-intelligence-architecture.md
?? scripts/place-archive-test.js  scripts/place-discovery-test.js
?? scripts/place-discovery.js  scripts/place-intelligence-historical-run.js
?? scripts/place-intelligence-test.js  scripts/places-review.js  scripts/places-seed.js
?? services/place-intelligence-service.js  services/place-resolution-hook.js
```

- آخر commit: **`ba8bc29`** — لم يتغير.
- **لا Commit / لا Push / لا Deploy تم في هذه الجولة.**
- الملفان المعدَّلان (`server.js`، `shift-archive-engine.js`) هما الملفان القائمان الوحيدان الملموسان، والتعديلات additive صِرفة وموثقة بالأسطر في البند ②.

---

## ⑧ قيود معلنة بصدق

1. **العرض التنفيذي غير موجود بعد**: `snapshot.places` تُخزَّن في اللقطة المختومة، لكن واجهة الأرشيف الحالية لا تعرضها — العرض نطاق **PI-4** ولم يُبدأ.
2. **اللقطات المختومة قبل PI-3** لا تحتوي قسم `places`؛ قراءتها يجب أن تتعامل مع غيابه (`null`) — لم يُختبر هذا على لقطة إنتاجية قديمة حقيقية، وسيُضاف فحص صريح له في PI-4 إن طلبه المالك.
3. فشل `_parseLocationParts` داخل الـhook لم يُختبر مباشرة، لكن الكتلة ملتفة بـ try/catch في `server.js` وهي كافية للحاجز ①.

---

## ⑨ الخلاصة

PI-3 مكتمل محليًا وفق الأمر والحواجز التسعة: المحرك موصول سلبيًا بطابور تسلسلي لا يمس الاستجابة، وقسم «الجهات والمواقع» يُختم مع اللقطة كمستهلك صِرف لمخازن المحرك، والانحدار مطابق للـbaseline رقمًا برقم.

**الحالة: بانتظار مراجعة المالك واعتماده. لا Commit / Push / Deploy، ولا بدء PI-4، إلا بأمر صريح.**

---

## ⑩ ملحق إغلاق المراجعة (RETURN → إثباتات مكتملة — 2026-08-29)

ردًا على مراجعة المالك (RETURN مع 4 ثغرات إثبات): نُفذت الاختبارات الأربعة في ملف جديد
`scripts/place-archive-proof2-test.js` — **اختبارات فقط، صفر تعديل على كود الإنتاج**
(لم تتغير R1–R5 ولا placesVersion ولا تصميم الإحصائية). النتيجة: **6/6 ✅**.

### P1 — Snapshot Immutability (mutation عميق) ✅

| الخطوة | الدليل الرقمي |
|---|---|
| ختم لقطة فيها «مدرسة الختم» Confirmed بثقة 97 | `sealed.totals.confirmedPlaceLinked = 1` |
| بعد الختم — تعديل على القرص نفسه: `name` (اسم مغيّر كليًا) · `placeType` (school←mosque) · `radiusM` (9999) · `confidence` (97←3) · `evidence` (مستبدلة) · `placesVersion` (2←99) | خدمة جديدة بلا كاش رأت القيم المعدّلة فعلًا (`mutated.confidence=3`) — أي الـmutation وقع حقًا |
| النتيجة | `JSON.stringify(sealed)` قبل وبعد — **مطابقة 100%** |
| ثم **حذف** `placeResolution` الأصلي كليًا من المخزن | اللقطة المختومة احتفظت بالبلاغ Confirmed (`sealed.confirmed=1`) بينما القراءة الحية فقدته (`live.confirmed=0`) |

**الخلاصة:** `snapshot.places` نسخة مستقلة كاملة قابلة للتدقيق التاريخي — ليست مراجع إلى المخزن الحي. الاسم يُؤخذ من نتيجة الحسم نفسها (`r.placeName`) والأدلة تُنسخ نسخًا عميقًا، فلا يؤثر عليها أي تغيير لاحق.

### P2 — Old Snapshot Compatibility ✅

لقطتان تمثلان ما قبل PI-3: واحدة **بلا مفتاح `places` إطلاقًا** وواحدة `places: null` صراحة — حُفظتا على قرص وقُرئتا وعولجتا بنمط المستهلك: **بلا crash**، والغياب عومل كغياب طبيعي («لا قسم»)، وباقي أقسام اللقطة (`stats.incidents=12`، `hospital`) عولجت طبيعيًا.

### P3 — `_parseLocationParts` failure isolation ✅

محاكاة كتلة `server.js` حرفيًا (نفس بنية try/catch المضافة في POST /api/cad-reports) مع `reportService` مصطنع يفشل على عنوان بلاغ A:

| | بلاغ A (عنوان مكسور) | بلاغ B (طبيعي) |
|---|---|---|
| استجابة POST | `200` | `200` |
| الحسم | لم يدخل الطابور أصلًا — فشل معزول قبل `enqueue` | `confirmed` (R1) |
| عدادات الطابور | — | `enqueued=1, failed=0` — سليم |

**الخلاصة:** خطأ التحليل لا يوقف الطابور ولا يضيع البلاغات اللاحقة ولا يؤثر على استجابة POST.

### P4 — Unique eventId counting (بالأرقام الصريحة) ✅

بلاغ واحد `U100` بثلاث حالات تاريخية `Unknown → Likely → Confirmed`:

| المقياس | القيمة الفعلية |
|---|---|
| `place.incidents` | `[U100]` — **length = 1** (وليس 2 أو 3) |
| `new Set(incidentIds).size` | **1** — لا تكرار تحت الجهة |
| `section.totals.confirmedPlaceLinked` | **1** |
| `section.totals.incidents` | **1** |
| `history` | انتقالان محفوظان: `unknown←likely` · `likely←confirmed` |
| الحالة الداخلة في القسم | النهائية فقط: `R1 / confidence 97` |

### حالة المستودع بعد الإغلاق

- الملفات المتتبعة المعدّلة: `server.js` و`shift-archive-engine.js` فقط — **لم تتغيرا في جولة الإغلاق هذه** (التعديل الوحيد كان ملف اختبار جديد untracked).
- Golden Set الأصلي أُعيد تشغيله بعد الإغلاق: **13/13 ✅**.
- آخر commit: **`ba8bc29`** — لا Commit / Push / Deploy.

**كل ثغرات الإثبات الأربع مغلقة بالأدلة. PI-3 جاهز لحكم المالك النهائي.**
