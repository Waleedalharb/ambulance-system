# تقرير تنفيذ UI-Map — المرحلة B (محلي فقط — بلا Commit/Push/Deploy)

**التاريخ:** 2026-08-31
**الاعتماد:** المرحلة B مشروطًا بتعديلات المالك (دفع التخطيط بدل سلم z-index · dark-v11 بنفس المزود/التوكن · عدم لمس PI-10/Place Identity)
**المرجع:** `UI-MAP-DIAGNOSIS.md` (المرحلة A)

---

## ① `/api/audit-log` = 500 — أُصلح

**الملف:** `server.js` فقط (3 نقاط)

| التغيير | الموضع | الوصف |
|---|---|---|
| عزل الملف التالف | `readAuditLog()` | عند `SyntaxError` من JSON.parse: إعادة تسمية إلى `audit-log.json.corrupt-<ts>` (حفظ الدليل، لا حذف صامت) + إرجاع `[]` + تسجيل الخطأ |
| كتابة ذرّية | `writeAuditLog()` | `writeFile` إلى `audit-log.json.tmp` ثم `rename` — يمنع ملفًا مقطوعًا عند restart وسط الكتابة (السبب الجذري) |
| تسجيل الخطأ الحقيقي | catch الخارجي للـ GET | `console.error('[AuditLog] GET /api/audit-log error:', error)` — لا 500 صامتًا بعد الآن |

**الإثبات — `scripts/ui-map-audit-log-test.js` = 17/17 ✅** (عزل كامل: VACUUM INTO + DATA_DIR مؤقت):
- لا ملف ← 200 ومصفوفة · ملف تالف ← **200 لا 500** + عزل `.corrupt-*` + المسار الأصلي أُزيل · أول كتابة بعد التلف ← نجاح وملف JSON صالح جديد + لا بقايا `.tmp` · قراءة بعد التعافي ← الإدخال ظاهر · بلا توكن ← 401.

## ② حدود الخريطة مقابل الـSidebar — أُصلح بالسبب لا بالأرقام

**السببان الجذريان (من المرحلة A):**
- **RC-1:** `.smart-sidebar` درج منزلق `position: fixed` فوق المحتوى في **كل** المقاسات — `.container` والشريط العلوي لا يتزحزحان.
- **RC-2:** `.minfo-pop` (بطاقة الشرح) `position: fixed` على `document.body` — تفلت من قصّ الخريطة، وحدّها الأيمن `window.innerWidth` لا يخصم القائمة المفتوحة.

**الإصلاح — دفع تخطيط + حدّ واعي بالقائمة (بلا أي تغيير z-index):**

| الملف | التغيير |
|---|---|
| `public/css/smart-toolbar.css` | `@media (min-width: 769px)`: عند `body.sidebar-open` ← `.container { margin-right: 280px }` + `.smart-topbar { right: 280px }` بانتقال 0.3s. الجوال يبقى درجًا فوقيًا بـ backdrop كما هو. **+ إصلاح بنيوي موروث:** إزالة قوس `}` زائد بلا مقابل كان في نهاية الملف — كان غير مؤثر حتى أُضيفت قواعد بعده فابتلعها استرداد أخطاء CSS (اكتشفه الاختبار البصري: الشبكة ترجع القاعدة والـCSSOM لا يراها) |
| `public/js/app.js` | `toggleSidebar`/`closeSidebarOnMobile`/Escape: مزامنة `body.sidebar-open` + بث `resize` بعد الانتقال (Leaflet يحتاجه، Mapbox trackResize يكفيه) |
| `public/js/smart-toolbar.js` | معالج Escape الثاني يزيل `body.sidebar-open` أيضًا |
| `public/js/map-guide.js` | حدّ `.minfo-pop` الأيمن يخصم عرض القائمة المفتوحة على سطح المكتب — تعيد التموضع داخل المساحة المتاحة بدل الدخول تحت القائمة |
| `public/index.html` | كسر كاش: `smart-toolbar.css?v=4` · `app.js?v=50` · `smart-toolbar.js?v=4` · `map-guide.js?v=2` · `map-adapter.js?v=2` |

## ③ المظهر الداكن — أُصلح (نفس المزود/التوكن/المصدر)

| الملف | التغيير |
|---|---|
| `server.js` (`/js/map-config.runtime.js`) | النمط المحقون: `light-v11` ← **`dark-v11`** (سطر واحد + تحديث التعليق) |
| `public/js/map-adapter.js` | الافتراضي في `resolveStyle()` ← `dark-v11` · `applyLightOpsTheme()` أصبحت مشروطة: كلاس `smap-light-ops` يُضاف **فقط** إذا كان النمط المستخدم فاتحًا فعلًا — فتعود قواعد الثيم الداكن الأصلية للعمل حرفيًا مع dark-v11 |

لم يُمَسّ: المزود، التوكن، مصدر البيانات، Place Intelligence، منطق العلامات، `LIGHT_OPS_TWEAKS` (تُطبَّق فقط على light-v11 أصلًا — dark-v11 لا يمر بها).

---

## الاختبار البصري الفعلي — `scripts/ui-map-visual-test.js` = 16/16 ✅

خادم معزول (قاعدة مؤقتة + DATA_DIR مؤقت) + Chrome headless عبر CDP خام + تسجيل دخول حقيقي (4252) + توكن Mapbox الحقيقي (بلاطات فعلية):

| الحالة | النتيجة |
|---|---|
| 1 — الشاشة العادية | ✅ لا دفع، القائمة مغلقة، الخريطة داكنة |
| 2 — فتح الـSidebar | ✅ `body.sidebar-open` · `.container` انكمش 280px · الشريط العلوي ابتعد 280px · **قسم الخريطة لا يمتد تحت القائمة** (secRight ≤ sbLeft) |
| 3 — بطاقة شرح + القائمة مفتوحة | ✅ البطاقة ظاهرة وداخل المساحة المتاحة (right ≤ innerWidth−280) |
| 4 — إغلاق القائمة | ✅ التخطيط عاد كاملًا |
| الخريطة | ✅ `map-config.runtime.js` يحقن `dark-v11` فعليًا، لا أثر لـ light-v11 |
| API من المتصفح | ✅ `GET /api/audit-log` ← **200** (ليس 500) |

**اللقطات (دليل بصري):** `test-output/ui-map-1788190216453/` — `1-normal.png` · `2-sidebar-open.png` · `3-popup-with-sidebar.png` · `4-sidebar-closed.png`

## عدم الانحدار — كلها خضراء

| الاختبار | النتيجة |
|---|---|
| `ui-map-audit-log-test` (جديد) | 17/17 ✅ |
| `ui-map-visual-test` (جديد) | 16/16 ✅ |
| `nav-perms-test` | 33/33 ✅ |
| `schedule-permissions-test` | 27/27 ✅ |
| `symbols-admin-test` | 58/58 ✅ |
| `pi10-planner-test` | 18/18 ✅ |
| `pi10-queue-test` | 14/14 ✅ |
| `place-discovery-hook-test` | 11/11 ✅ |
| `alert-rules-test` | 70/70 ✅ |
| `contribution-ops-total-test` | 5/5 ✅ |
| `node --check` على كل ملف معدَّل | ✅ |

## حدود ما تم

- **محلي فقط:** لا Commit / Push / Deploy. لم يُختبر على الإنتاج بعد.
- **لم يُمَسّ:** PI-10 / Place Identity / R1–R5 / Registry / مصدر الخرائط / المزود / التوكن.
- **ملاحظة فصل:** `server.js` يحمل الآن تغييرين من جولتين (PI-10 المعلّقة + UI-Map). عند أي Commit مستقبلي يجب فصلهما أو دفع الجولتين بوعي.
- «المؤشرات المباشرة» في الواجهة (`operations-dashboard.html` / `admin-dashboard.html` / `app.js`) قراءتها أُثبتت عبر نجاح الـ API نفسه (200 من سياق المتصفح)؛ لم تُفتح صفحاتها بصريًا في هذه الجولة.
- عمليات الاختبار المؤقتة (خادم/متصفح) أُنهيت كلها — لا عمليات شغّالة.

## الملفات المعدلة في هذه الجولة

```
server.js                          (audit-log ×3 + dark-v11 + تعليق)
public/css/smart-toolbar.css       (دفع التخطيط + إزالة قوس زائد موروث)
public/js/app.js                   (مزامنة body.sidebar-open + resize)
public/js/smart-toolbar.js         (Escape يزيل الكلاس)
public/js/map-guide.js             (حدّ البطاقة يخصم القائمة)
public/js/map-adapter.js           (dark-v11 افتراضيًا + ثيم فاتح مشروط)
public/index.html                  (كسر كاش ×5)
scripts/ui-map-audit-log-test.js   (جديد)
scripts/ui-map-visual-test.js      (جديد)
```
