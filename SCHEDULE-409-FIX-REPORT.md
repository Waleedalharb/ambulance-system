# SCHEDULE-409-FIX-REPORT — تقرير إصلاح `toast is not defined`

**التاريخ:** 2026-08-29 · **النطاق المنفذ:** سطران فقط، بأمر المالك — لا Commit، لا Push، لا Deploy
**يستند إلى:** SCHEDULE-409-FRONTEND-DIAGNOSIS.md (تشخيص معتمد)

---

## ١. التعديل (diff — سطران فقط، لا شيء آخر)

```diff
--- a/public/smart-schedule.html
@@ -3157 (المسار اليدوي — saveToServer)
-                            toast('⏳ جاري إعادة الاستيراد مع الكتابة فوق التعديلات اليدوية…', 'info');
+                            showToast('⏳ جاري إعادة الاستيراد مع الكتابة فوق التعديلات اليدوية…', 'info');
                             saveToServer({ confirmOverwriteManual: true });
@@ -5441 (الاستيراد الرسمي — oiSaveToServer)
-                    toast('⏳ جاري إعادة الاستيراد مع الكتابة فوق التعديلات اليدوية…', 'info');
+                    showToast('⏳ جاري إعادة الاستيراد مع الكتابة فوق التعديلات اليدوية…', 'info');
                     oiSaveToServer(true);
```

`git diff --stat`: `public/smart-schedule.html | 4 +-` — سطران محذوفان + سطران مضافان فقط.

## ٢. النتيجة قبل/بعد

| المرحلة | قبل الإصلاح | بعد الإصلاح |
|---|---|---|
| 409 يصل للواجهة والنافذة تظهر | ✅ تعمل | ✅ تعمل |
| ضغط «كتابة فوق» + تأكيد | ❌ `ReferenceError: toast is not defined` (5444:21) | ✅ رسالة الانتظار عبر showToast |
| الطلب الثاني `oiSaveToServer(true)` | ❌ لا يُرسل إطلاقًا (يموت قبله) | ✅ يُرسل بـ`confirmOverwriteManual: true` |
| نتيجة الاستيراد | ❌ عالق عند النافذة | ✅ 200 + `manualOverwritten=1` |

## ٣. اختبار القبول E2E — 14/14 ✅ (قاعدة معزولة طازجة، PORT 3091، صفر لمس لبيانات المشروع)

يحاكي المتصفح حرفيًا بعد الإصلاح:

```
✅ سلكي ×4: لا toast() مجردة · showToast معرّفة · كلا الـcallbackين يتبعانها بالطلب الصحيح
✅ تجهيز: تعيين يدوي نشط (S9-001 ← جنوب 2) عبر transfer من تاريخ — كما يحدث في الإنتاج
✅ طلب 1: official-import → 409 + conflicts (manual=جنوب 2 / import=جنوب 1)
✅ 409 لم يكتب شيئًا: التعيين اليدوي باقٍ
✅ طلب 2 (= كتابة فوق): confirmOverwriteManual=true → 200 نجاح        ← إثبات إرسال الطلب الثاني
✅ manualOverwritten = 1                                              ← إثبات نجاح الاستيراد
✅ التعيين استُبدل فعلًا: المفتوح الآن جنوب 1 / import
✅ سجل التدقيق: import_overwrite_manual موثَّق
✅ القناة الثانية (السطر 3160، /api/schedule/employees): 409 ثم 200 بالتأكيد — تعمل أيضًا
```

سكربت الاختبار: `acceptance-409-fix.js` (خارج المشروع، في مساحة العمل).

## ٤. عدم الانحدار

| الاختبار | النتيجة |
|---|---|
| `scripts/test-write-channels-ssot.js` | **15/15 ✅** |
| `scripts/test-schedule-features.js` | **24/24 ✅** |

## ٥. git status

- `M public/smart-schedule.html` (+2/−2 فقط — الإصلاح)
- `M server.js · M shift-archive-engine.js · M public/operations-dashboard.html` — تعديلات جولات PI السابقة المعتمدة، **لم تتغير في هذه الجولة**
- ملفات untracked: تقارير PI + تقارير هذه الجولة — كما كانت
- **لا Commit، لا Push، لا Deploy**

## ٦. حدود الإثبات (صراحة)

لا يوجد متصفح آلي في البيئة المحلية (لا playwright/puppeteer). لذلك:
- **المُثبت هنا:** السلكية الساكنة (showToast معرّفة ومتصلة بالطلب الثاني) + التدفق الكامل على مستوى HTTP بنفس حمولة المتصفح حرفيًا.
- **يبقى للتحقق الميداني على جهاز الإداري:** إعادة استيراد شهر 9 → «كتابة فوق» → المفترض رؤية رسالة الانتظار ثم في Network طلبان: `official-import → 409` ثم `official-import → 200`. إن ظهر أي خلل آخر — توقف وأبلغني به ولا أصلحه تلقائيًا.
