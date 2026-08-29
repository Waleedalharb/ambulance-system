# Seed Safety Audit — places-seed.js (2026-08-29)

**البيئة:** sandbox معزول (`C:/Users/a7bk-/AppData/Local/Temp/seed-audit-kCFITE`) — نسخة byte-identical من السكربت الحقيقي. صفر لمس للمشروع.

| الحالة | قبل | بعد تشغيل seed | الحكم |
|---|---|---|---|
| ① الملف غير موجود → إنشاء | لا ملف | placesVersion=1 · مواقع=21 | أنشأ 21 موقعًا بذريًا (v1) — ✅ places.json — placesVersion=1 · مستشفيات بذرية=12 · مراكز داخلية=9 · أُضيف=21 · إجمالي=21 |
| ② تشغيل ثانٍ بلا تعديل (idempotency) | v=1 | v=1 · نفس المواقع=true · byte-identical=true | Idempotent تمامًا |
| ③ موقع manual معتمد + v50 | manual radiusM=65 · v=50 · مواقع=22 | v=50 · manual محفوظ حرفيًا=true | manual لم يُمس (radiusM=65 وevidence كما هي) · النسخة 50 (لا خفض) |
| ③ب ضبط بشري على موقع بذري (radiusM=280 + evidence + retired) | radiusM=280 · evidence+1 · status=retired | radiusM=280 · evidence=2 · status=retired | الضبط البشري محفوظ |
| ⑥ موقع learned إضافي | plc_learned1 (mosque · learned) | موجود بعد seed | الموقع الإضافي بقي — لا حذف لغير البذري |
| ⑦ rejected + candidate غير بذريين | rejected + candidate | rejected=rejected · candidate=candidate | لا إعادة تفعيل ولا حذف |
| ⑧ العدد النهائي | 21 بذرة | إجمالي=24 | 21 بذرة + manual + learned + candidate = 24 |
