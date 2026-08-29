# Seed Safety Fix — تقرير إصلاح places-seed.js (2026-08-29)

**المرجعية:** أمر المالك «Seed Safety — إصلاح إلزامي قبل النشر» بعد فشل التدقيق (② ليس idempotent · ③ب مسح الضبط البشري على موقع بذري).
**الحالة:** مُصلح + مختبر — **بلا Commit / Push / Deploy**.
**نطاق اللمس:** `scripts/places-seed.js` فقط + ملف اختبار جديد. لم تُلمس R1–R5 ولا server.js ولا shift-archive-engine.js ولا الواجهة ولا قاعدة البيانات.

---

## ① التصميم المختار (الأقل تغييرًا والأكثر أمانًا)

**Reconcile وليس Rebuild:** البذرة تضيف البذريات **الغائبة فقط**. أي موقع موجود — بذريًا كان أو بشريًا — **لا يُمس إطلاقًا** (لا يوجد في الكود أي مسار كتابة على موقع قائم). وبلا إضافات = **بلا كتابة للملف أصلًا** وبلا رفع نسخة (idempotence صارمة byte-identical).

**مفاضلة مقصودة موثقة:** تصحيح إحداثيات/بيانات مستشفى بذري قائم من `map-locations.json` لن ينتشر تلقائيًا عند إعادة التشغيل — يمر عبر مراجعة بشرية، نفس بوابة اعتماد `radiusM`. هذا ثمن «لا overwrite إطلاقًا» وهو الخيار الأآمن.

## ② diff الكود (Before → After)

`main()` — قبل:
```js
// rebuild: يعيد بناء الـ21 بطوابع/أدلة جديدة كل مرة + يحتفظ فقط بـ source!=='seed'
const kept = {};
for (const [id, p] of Object.entries(existing.places || {})) {
    if (p.source !== 'seed') kept[id] = p;
}
const merged = Object.assign({}, seedPlaces, kept);   // ← البذريات تُكتب فوق أي ضبط بشري
const changed = ...JSON.stringify(existing.places) !== JSON.stringify(merged); // ← دائمًا true (طوابع جديدة)
placesVersion: changed ? (existing.placesVersion || 0) + 1 : ...  // ← ترتفع كل تشغيل
```

بعد:
```js
// reconcile: يضيف الغائب فقط — الموجود لا يُمس إطلاقًا
const merged = Object.assign({}, existing.places);
let added = 0;
for (const [id, p] of Object.entries(seedPlaces)) {
    if (!merged[id]) { merged[id] = p; added++; }
}
// idempotent صارم: بلا إضافات = بلا كتابة وبلا رفع نسخة — byte-identical
if (added === 0 && fileExisted) { console.log('بلا تغيير'); return; }
placesVersion: (existing.placesVersion || 0) + 1  // ترتفع فقط عند تغيير فعلي
```

## ③ الاختبارات العشرة الإلزامية — 10/10 ✅ (`scripts/places-seed-test.js`)

| # | الاختبار | الدليل الرقمي |
|---|---|---|
| T1 | empty → seed | 21 موقعًا · v1 ✅ |
| T2 | seed → seed | **byte-identical** · v1 ثابتة · log «بلا تغيير» ✅ |
| T3 | radiusM بشري 200→280 على بذري | يبقى **280** ✅ |
| T4 | status بشري active→retired على بذري | يبقى **retired** ✅ |
| T5 | evidence بشرية مضافة على بذري | تبقى (2 = 1+1، و`by:owner` موجودة) ✅ |
| T6 | name/nameVariants/district بشرية | كلها محفوظة ✅ |
| T7 | manual + learned + candidate + rejected | الأربعة **byte-identical** · إجمالي 25 ✅ |
| T8 | 3 تشغيلات بلا تغيير | النسخة 1 ← 1 ✅ |
| T9 | idempotency كاملة | الحالة بعد 3 تشغيلات = بعد الأول byte-identical ✅ |
| T10 | اعتماد مركّب (7 حقول) + 3 تشغيلات | كل الحقول السبعة محفوظة ✅ |

## ④ إعادة التدقيق الأصلي (الذي كشف الفشل) — 7/7 ✅

| الحالة | قبل الإصلاح | بعد الإصلاح |
|---|---|---|
| ② تشغيل ثانٍ بلا تعديل | ❌ v1→v2 + إعادة كتابة أدلة/طوابع | ✅ Idempotent تمامًا (بلا كتابة) |
| ③ب ضبط بشري على بذري (280/retired/evidence) | ❌ **مُسح** → 200/active | ✅ **محفوظ بالكامل** |
| ③ موقع manual + v50 | ✅ محفوظ | ✅ محفوظ (والنسخة بقيت 50 — لا رفع بلا تغيير) |
| ①⑥⑦⑧ | ✅ | ✅ |

## ⑤ عدم المساس

- `data/places.json` الحقيقي: **لم يُمس** (mtime ثابت 13:18 من PI-1) — كل التشغيلات في sandbox بنُسخ byte-identical.
- انحدار حزم PI بعد الإصلاح: place-intelligence **26/26** · place-archive **13/13** ✅.
- git: الملفات المتتبعة المعدّلة ما زالت الثلاثة نفسها فقط؛ `places-seed.js` ملف جديد untracked؛ آخر commit **`ba8bc29`**.
- **لا Commit / Push / Deploy.**

## ⑥ الخلاصة

`places-seed.js` أصبح آمنًا كأمر متكرر: reconcile يضيف الغائب فقط، صفر overwrite لأي موقع قائم، والنسخة لا تتحرك بلا تغيير فعلي. نظام «يُشغَّل بالخطأ مستقبلًا» لم يعد قادرًا على مسح أي قرار بشري.

**بانتظار مراجعة المالك: PASS ← نجهز أمر النشر.**
