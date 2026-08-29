# SCHEDULE-409-FRONTEND-DIAGNOSIS — تشخيص `toast is not defined` عند معالجة التعارض

**التاريخ:** 2026-08-29 · **النطاق:** تشخيص فقط — لا إصلاح، لا Commit، لا Push، لا Deploy
**مكمّل لـ:** SCHEDULE-409-DIAGNOSIS.md (الـ409 نفسه حماية صحيحة — هذا التقرير يشخّص فشل الواجهة في معالجته)

---

## سلسلة الإثبات المطلوبة

```
409 وصل للسيرفر؟        ✅ نعم — السيرفر نفسه هو من أرسله (server.js:9494)
↓
409 وصل للواجهة؟        ✅ نعم — smart-schedule.html:5440 استقبله وقرأ جسم الاستجابة
↓
showImportConflictModal اشتغلت؟  ✅ نعم — معرفة في smart-schedule-cell-editor.js:594
                          كـ window.showImportConflictModal (عامة)، والملف محمّل
                          في الصفحة (smart-schedule.html:4948)، والنافذة عُرضت
↓
callback اشتغل؟         ✅ نعم — عند ضغط «كتابة فوق» ثم تأكيد confirm()
                          (cell-editor.js:621-625) → onOverwrite() استُدعي
↓
toast موجودة؟           ❌ لا — لا توجد دالة عامة باسم toast في نطاق الصفحة
↓
لماذا ظهر ReferenceError؟  السطر 5444 ينادي toast() المجردة، والصفحة لا تعرّفها
↓
هل oiSaveToServer(true) يُستدعى؟  ❌ لا — ReferenceError يقطع الـcallback
                          قبل الوصول للسطر 5445
↓
أقل إصلاح مطلوب:        استبدال toast( بـ showToast( في سطرين فقط (3160 و5444)
```

---

## ١. لماذا `toast` غير معرفة — تحديدًا

**ما هو معرّف في smart-schedule.html:**
- `showToast(message, type)` — معرّفة في السطر 4845، وتفوّض إلى `ToastCore.show`
  (core-toast.js محمّل في السطر 2017). تُستخدم في **أكثر من 40 موضعًا** في الصفحة.

**ما هو غير معرّف:** لا يوجد أي `function toast` أو `window.toast` في نطاق هذه الصفحة.
الأماكن الوحيدة في المشروع التي تحمل اسم `toast`:

| الموقع | الطبيعة | هل يصل إليه smart-schedule.html؟ |
|---|---|---|
| `js/smart-schedule-cell-editor.js:57` | دالة **خاصة داخل IIFE** تفوّض إلى `window.showToast` | ❌ غير مرئية خارج الملف |
| `admin-users.html:203` · `admin-symbols.html:479` · `workflow.html:519` | دوال عامة في صفحات أخرى | ❌ صفحات لا تُحمّل هنا |
| `app.js` · `chat.js` · `websocket-sync.js` · `core-toast.js` | متغيرات محلية `var toast` (عناصر DOM) | ❌ متغيرات لا دوال عامة |

**الخلاصة:** السطران 3160 و5444 كُتبا على افتراض وجود `toast()` عامة — وهي غير
موجودة. على الأرجح قصد الكاتب `showToast()` (أو ظن أن دالة cell-editor الخاصة عامة).

## ٢. الموضعان المصابان (نفس الخطأ مكرر)

**الموضع الأول — مسار الاستيراد الرسمي (الذي ظهر فيه الخطأ):**
```js
// smart-schedule.html:5440-5450 — داخل oiSaveToServer(confirmOverwrite)
if (response.status === 409) {
    var conflict = await response.json().catch(...);
    if (window.showImportConflictModal && ...) {
        window.showImportConflictModal(conflict.conflicts, function () {
            toast('⏳ جاري إعادة الاستيراد…', 'info');   // ← 5444: ReferenceError
            oiSaveToServer(true);                        // ← 5445: لا يصل إليه أبدًا
        });
    } else { showToast('⚠️ …', 'error'); }               // ← هذا السطر سليم
    return 'conflict';
}
```

**الموضع الثاني — المسار اليدوي القديم لحفظ الجدول:**
```js
// smart-schedule.html:3158-3161 — نفس النمط حرفيًا
window.showImportConflictModal(conflict.conflicts, function () {
    toast('⏳ جاري إعادة الاستيراد…', 'info');   // ← 3160: نفس العطل الكامن
    ...
});
```

## ٣. لماذا لم يُكتشف الخطأ سابقًا

الـ`toast()` تُنادى **فقط داخل callback الكتابة فوق** — أي أن العطل لا يظهر إلا عند
تحقق ثلاثة شروط معًا: (1) حدوث 409 فعلي، (2) وجود conflicts في الجسم، (3) ضغط
المستخدم «كتابة فوق» ثم تأكيد الـconfirm. أول ظهور حقيقي لهذا المسار كان مع جدول
شهر 9 — فانكشف العطل الكامن. زر الإلغاء (cell-editor.js:619) يستخدم `toast()` الخاصة
بملف cell-editor (داخل IIFE) فلا يتأثر.

## ٤. إثبات أن `oiSaveToServer(true)` لا تُنفَّذ

آلية القطع: `onOverwrite()` تُستدعى من داخل `onclick` (cell-editor.js:624).
أول سطر فيها هو `toast(...)` → `ReferenceError: toast is not defined` → يقذف
الاستثناء فورًا → السطر التالي `oiSaveToServer(true)` **لا يُنفَّذ إطلاقًا**.
الدليل الميداني المطابق: Stack trace المبلّغ `at smart-schedule.html:5444:21` —
وهو بالضبط سطر `toast(...)` داخل الـcallback.
**لا توجد مشكلة أخرى بعده** — الـ409 الثاني المتوقع (مع confirmOverwriteManual=true)
لم يُرسل أصلًا؛ لا يوجد طلب ثانٍ في Network.

## ٥. أقل إصلاح مطلوب (للتنفيذ بعد الاعتماد فقط)

**سطران فقط:** استبدال `toast(` بـ `showToast(` في:

1. `smart-schedule.html:5444`
2. `smart-schedule.html:3160` (نفس العطل الكامن في المسار الثاني — إصلاحه معًا
   يمنع تكرار نفس العطل من القناة الأخرى)

لا حاجة لتعريف دالة جديدة ولا تعديل cell-editor ولا السيرفر. بعد الإصلاح:
«كتابة فوق» → confirm → showToast تعمل → `oiSaveToServer(true)` يُرسل
`confirmOverwriteManual: true` → السيرفر يتجاوز فحص 9491 → `syncFromSchedule`
بـ `overwriteManual: true` → تسجيل `import_overwrite_manual` في سجل التدقيق → نجاح.

**اختبار القبول المقترح بعد الإصلاح:** تكرار استيراد شهر 9 على بيئة تحمل تعيينًا
يدويًا نشطًا → 409 → النافذة تعرض المتعارضين → «كتابة فوق» → بلا ReferenceError →
طلب ثانٍ ناجح → قائمة conflicts تُستبدل وتُوثَّق في سجل التدقيق.

---

**ملاحظة أخيرة:** هذا التشخيص يؤكد استنتاج الجولة السابقة — الـ409 حماية صحيحة،
والعطل الوحيد هو سطران في الواجهة يمنعان المستخدم من ممارسة حقه المعتمد في
«الكتابة فوق الواعية». قائمة المتعارضين (من هم؟ أي فرقتين؟) تبقى مرئية في النافذة
نفسها قبل اتخاذ القرار.
