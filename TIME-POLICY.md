# سياسة التوقيت الموحدة — TimeRiyadh

**جميع تنسيقات التاريخ والوقت يجب أن تمر عبر TimeRiyadh.js فقط، ويُمنع استخدام أي تحويل محلي خارج هذه الطبقة.**

الطبقة المركزية الوحيدة: `public/js/time-riyadh.js` — نمط UMD يعمل في المتصفح
(`window.TimeRiyadh`) وفي Node (`module.exports`). التخزين UTC دائمًا ولا يُمسّ؛
هذه الطبقة للعرض فقط وكلها `Intl.DateTimeFormat` بـ `timeZone:'Asia/Riyadh'`.

## الدوال

| الدالة | المخرج | مثال |
|---|---|---|
| `TimeRiyadh.formatTime(v)` | `HH:MM` | `14:23` |
| `TimeRiyadh.formatTimeSec(v)` | `HH:MM:SS` | `14:23:19` |
| `TimeRiyadh.formatDate(v)` | `YYYY-MM-DD` | `2026-07-26` |
| `TimeRiyadh.formatDateTime(v)` | `YYYY-MM-DD HH:MM` | `2026-07-26 14:23` |
| `TimeRiyadh.formatDateTimeSec(v)` | `YYYY-MM-DD HH:MM:SS` | `2026-07-26 14:23:19` |
| `TimeRiyadh.formatDayName(v)` | اسم اليوم (ar-SA) | `الأحد` |
| `TimeRiyadh.formatMonthYear(v)` | سنة+شهر (ar-SA) | `٠٧/٢٠٢٦` |
| `TimeRiyadh.formatFullDate(v)` | تاريخ كامل باسم اليوم والشهر (ar-SA) | `الأحد، ٢٦ يوليو ٢٠٢٦` |
| `TimeRiyadh.riyadhParts(v)` | مكوّنات الوقت بالرياض — **للمنطق فقط** (كشف المناوبة)، ليست للعرض | `{year, month, day, hour, minute, second}` |

تطبيع المدخل: ISO بـZ أو إزاحة يُحلَّل كما هو · النص naive بمسافة
(`YYYY-MM-DD HH:MM:SS`) أو بـT بلا Z يُفسَّر **UTC** · التاريخ المجرد
`YYYY-MM-DD` يُعامل كتاريخ بلا تحويل ساعات · رقم epoch مقبول ·
null/فارغ/غير صالح → `—`.

## الاستخدام

- **متصفح**: `<script src="/js/time-riyadh.js">` قبل أي سكربت يعرض وقتًا، ثم `TimeRiyadh.formatTime(x)`.
- **Node / خدمات**: `const TimeRiyadh = require('./public/js/time-riyadh.js');`

## الحارس الآلي

```bash
node scripts/guard-time-riyadh.js
```

يفحص `public/` + `server.js` + `services/` + `managers.js` عن الأنماط المحظورة:
`toLocaleString(` · `toLocaleTimeString(` · `toLocaleDateString(` ·
`Intl.DateTimeFormat` · `u-ca-islamic` (المنصة ميلادية حصرًا) · `getTimezoneOffset(` · `slice(11, 16)` · `slice(11,16)` ·
`setHours(` · `10800000` · `(3 * 60` · `+ 3 * 60` · `+3*60`.
عند أي مخالفة يطبع `ملف:سطر` ويخرج بـ exit 1. **يجب أن يمر قبل أي commit.**

## لا استثناءات

منطق كشف المناوبة نفسه يمر عبر الطبقة: `TimeRiyadh.riyadhParts(new Date())`
(في `radio-completion.html` و`app.js` و`js/core/core-time.js` و`server.js` و`managers.js`).
لم يعد هناك أي استثناء موثق — الطبقة هي المصدر الوحيد للتاريخ والوقت في المشروع بالكامل.

من يضيف عرضًا أو حسابًا زمنيًا جديدًا يستخدم `TimeRiyadh` أو يوسّعها —
ولا يكتب formatter محليًا جديدًا أبدًا.
