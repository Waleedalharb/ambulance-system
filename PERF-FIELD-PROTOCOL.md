# PERF-FIELD-PROTOCOL — بروتوكول لحظة البطء (F5 مقابل Restart)

**الغرض:** حسم التناقض المركزي في تحقيق الأداء: هل البطء **متصفحي** (يحلّه F5) أم **خادمي/Render** (لا يحلّه إلا Restart)؟
**القاعدة الذهبية:** عند ملاحظة البطء — **لا Restart قبل إكمال هذا البروتوكول.**

---

## التسلسل الإلزامي

```
قبل البطء (سلس) → لحظة البطء → قياس → F5 فقط → قياس → [إن بقي البطء] Restart → قياس
```

## الخطوة 1 — عند ملاحظة البطء (قبل لمس أي شيء)

افتح DevTools في **نفس التبويب البطيء** (F12 ← Console)، الصق المقتطف (أ)، اضغط Enter، والتقط لقطة شاشة للمخرجات.

### المقتطف (أ) — قياسات المتصفح في الجلسة الحية

```js
(function(){
  var m = performance.memory || {};
  var res = performance.getEntriesByType('resource');
  var slowest = res.slice().sort(function(a,b){return b.duration-a.duration;}).slice(0,5)
    .map(function(r){ return r.name.replace(/^.*\//,'').slice(0,40) + ': ' + Math.round(r.duration) + 'ms'; });
  var out = {
    وقت_الجلسة_دقائق: Math.round(performance.now()/60000),
    JS_Heap_MB: m.usedJSHeapSize ? Math.round(m.usedJSHeapSize/1048576*10)/10 : 'غير متاح (Chrome فقط)',
    Heap_Limit_MB: m.jsHeapSizeLimit ? Math.round(m.jsHeapSizeLimit/1048576) : '—',
    DOM_عناصر: document.getElementsByTagName('*').length,
    موارد_محملة: res.length,
    SSE_حالة: (typeof sseSource !== 'undefined' && sseSource) ? sseSource.readyState : 'غير موجود',
    أبطأ_5_طلبات: slowest
  };
  console.table ? console.table(out) : console.log(out);
  console.log('أبطأ الطلبات:', slowest);
  return out;
})();
```

### المقتطف (ب) — زمن التنقل بين 4 واجهات (Click → usable)

```js
(async function(){
  var tests = [
    ['نموذج E', function(){ openModalById('formsModal'); loadFormsList(); loadForm('e'); }, function(){ return document.querySelector('#formContent #eIncidentLookup'); }],
    ['نموذج حادث', function(){ loadForm('incident'); }, function(){ return document.querySelector('#formContent #incidentLookup'); }],
    ['مركز العمليات', function(){ closeFormsModal(); openModalById('controlModal'); }, function(){ return document.querySelector('#controlModal .modal-content'); }],
    ['الإحصائيات', function(){ closeModalById('controlModal'); openModalById('analyticsModal'); }, function(){ return document.querySelector('#analyticsModal .modal-content'); }]
  ];
  var rows = [];
  for (var i = 0; i < tests.length; i++) {
    var t0 = performance.now();
    try { tests[i][1](); } catch(e) {}
    var waited = 0, ok = false;
    while (waited < 8000) { await new Promise(function(r){ setTimeout(r, 100); }); waited += 100;
      try { if (tests[i][2]()) { ok = true; break; } } catch(e) {} }
    rows.push({ الواجهة: tests[i][0], الزمن_ms: Math.round(performance.now() - t0), ظهرت: ok });
  }
  console.table(rows);
  try { closeModalById('analyticsModal'); closeFormsModal(); } catch(e) {}
  return rows;
})();
```

## الخطوة 2 — ملاحظة التنقل العام (إضافة المالك 22:35)

اختبار التنقل **لا يقتصر على النماذج الأربعة**. بعد ظهور البطء، تنقّل يدويًا بالضغط العادي عبر:

> **لوحة القيادة ← الجداول ← التكميل ← الإحصائيات والتقارير ← الخريطة ← إحصائيات (charts)**

وسجّل لكل واحدة: **بطيء أم سريع** (ملاحظة بسيطة تكفي). ولرقم دقيق: الصق المقتطف (ج) في Console **كل صفحة فور وصولها** — يقرأ زمن تحميل الصفحة الحالية من Performance API:

### المقتطف (ج) — زمن تحميل الصفحة الحالية (الصقه في أي صفحة بعد وصولها)

```js
(function(){
  var n = performance.getEntriesByType('navigation')[0] || {};
  var m = performance.memory || {};
  var out = {
    الصفحة: location.pathname.split('/').pop(),
    تحميل_الصفحة_كاملًا_ms: Math.round(n.duration || 0),
    استجابة_الخادم_ms: Math.round((n.responseEnd || 0) - (n.startTime || 0)),
    DOMContentLoaded_ms: Math.round(n.domContentLoadedEventEnd || 0),
    JS_Heap_MB: m.usedJSHeapSize ? Math.round(m.usedJSHeapSize/1048576*10)/10 : '—',
    DOM_عناصر: document.getElementsByTagName('*').length
  };
  console.table ? console.table(out) : console.log(out);
  return out;
})();
```

> ملاحظة تقنية مهمة: التنقل بين الصفحات الرئيسية في المنصة هو **تحميل صفحة كامل** (index.html ← smart-schedule.html ← radio-completion.html ← operations-dashboard.html)، وكل تحميل كامل يصفّر Heap وlisteners المتصفح تلقائيًا. لذلك هذه الجولة تفصل بحسم: إذا كانت **الصفحات نفسها** (تحميل كامل) بطيئة ← خادم/شبكة. أما إذا كان البطء داخل الصفحة الواحدة بعد استخدامها ← تراكم متصفحي.

### قراءة النمط (أي نتيجة تعني ماذا)

| النمط الملاحظ | الدلالة |
|---|---|
| كل الصفحات بطيئة | طبقة مشتركة (خادم/شبكة/Render) |
| كل صفحة بعد فتحها مرة ثانية تصبح أثقل | تراكم Frontend/listeners |
| الصفحات المرتبطة بـAPI معينة فقط بطيئة | API/data محددة |
| الخريطة تُفتح مرة ثم كل التنقل بعدها يثقل | الخريطة مشتبه أقوى |
| حتى صفحة بسيطة جدًا بطيئة | مورد مشترك أو المتصفح نفسه |

## الخطوة 3 — F5 فقط (تحديث الصفحة، **بلا Restart**)

بعد رجوع الصفحة وتسجيل الدخول إن لزم: أعد المقتطف (أ) ثم (ب)، وأعد جولة التنقل العام (الخطوة 2) مع المقتطف (ج) على كل صفحة، والتقط لقطات.

- **إذا عادت السلاسة بعد F5** ← المشكلة **متصفحية (Browser/Frontend)** — نركز على تراكم listeners/الخريطة. توقف هنا، لا Restart، وأرسل اللقطات.
- **إذا بقي البطء بعد F5** ← انتقل للخطوة 4.

## الخطوة 4 — Restart لـRender

بعد رجوع الخدمة مباشرة: أعد المقتطفات (أ) و(ب) و(ج)، والتقط لقطة. هذه تصبح **T=0 الجديدة** لخط الزمن.

- إذا عادت السلاسة بعد Restart ولم تعد بعد F5 ← **خادمي/Render** (مورد يتراكم في الخادم).
- إذا لم تعد حتى بعد Restart ← نوسّع التحقيق (شبكة/خطة الاستضافة).

## الخطوة 5 — إن أمكن، جهاز ثانٍ

بنفس لحظة البطء (قبل F5): افتح المنصة من جهاز آخر وقِس التنقل. بطء الجهازين معًا ← خادمي. بطء جهاز واحد ← متصفحي.

---

## ما يُسجَّل تلقائيًا في الخلفية

مهمة القياس كل 15 دقيقة تسجل أزمنة نقاط الإنتاج الحرجة باستمرار في `samples.jsonl` — عند إعلامي بلحظة البطء/الـRestart أحسب منها T=0/15/30/45/60 وأبني جدول: **قبل البطء → لحظة البطء → بعد F5 → بعد Restart**.

## ما لا يمكن قياسه من خارج Render (بصدق)

Server RSS / CPU / Heap الداخلية وعدد اتصالات SSE الفعلي على الخادم — لا تُتاح من خارج Render بلا إضافة عدّاد (تعديل كود — مؤجل لحين اعتمادك).
