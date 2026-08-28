/* ============================================================
   ui-map-isolation-test.js — مانع رجوع خلل «الوهج المتسرب»
   (اعتماد المالك 2026-08-28)

   الخلفية: ظهر توهج/وميض متحرك على بطاقة «المستشفيات» (hcKpiHospCard)
   عند تحريك الماوس فوق الخريطة رغم أن المؤشر ليس فوق البطاقة.
   التشخيص الكودي أثبت:
     - صفر mousemove/pointermove في كود المنصة (لا JS يتتبع المؤشر).
     - لا أحد يبدّل classes البطاقة (hc-alert-on يخص بطاقة الغياب فقط).
     - الآلية الوحيدة المتسقة: اقتران إعادة التركيب (compositing) —
       أسطح backdrop-filter المجاورة لـcanvas خريطة WebGL (Mapbox)
       تُعاد إعادةَ تركيبها مع كل إطار رسم في Chromium.

   هذا الاختبار يحمي الإصلاح من الرجوع:
     ز1  لا mousemove/pointermove في public/js إطلاقًا (مانع تتبع مؤشر مستقبلي)
     ز2  قاعدة .hc-kpi في index.html بلا backdrop-filter
     ز3  تجاوز .ops-map-section { backdrop-filter: none } موجود في index.html
     ز4  .ops-map-wrap في executive-theme.css تحتفظ بـ overflow: hidden
     ز5  hc-alert-on لا يُبدَّل إلا على hcKpiAbsentCard (بطاقة الغياب) وحدها
     ز6  كل بطاقات الشريط الثماني تشترك في .hc-kpi (تغطية الإصلاح شاملة)
     ز7  بطاقة المستشفيات hcKpiHospCard تحمل hc-kpi (داخلة في الإصلاح)
     ز8  لا tooltip/عنصر يتبع المؤشر في map-adapter.js / smart-map.js

   تشغيل: node scripts/ui-map-isolation-test.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const failures = [];

function ok(name) { pass++; console.log('  ✅ ' + name); }
function bad(name, why) { fail++; failures.push(name + ' — ' + why); console.log('  ❌ ' + name + ' — ' + why); }

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

console.log('\n🧪 اختبار عزل الخريطة عن بطاقات المؤشرات (مانع رجوع الوهج)\n');

/* ── ز1: لا تتبع مؤشر في جافاسكربت المنصة ── */
(function () {
    const jsDir = path.join(ROOT, 'public', 'js');
    const hits = [];
    fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).forEach(f => {
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        ['mousemove', 'pointermove'].forEach(ev => {
            const re = new RegExp("addEventListener\\s*\\(\\s*['\"]" + ev, 'g');
            let m; while ((m = re.exec(src))) hits.push(f + ':' + src.slice(0, m.index).split('\n').length + ' (' + ev + ')');
        });
    });
    if (hits.length === 0) ok('ز1 لا مستمعات mousemove/pointermove في public/js');
    else bad('ز1 لا مستمعات mousemove/pointermove', 'وُجدت: ' + hits.join(', '));
})();

/* ── ز2: .hc-kpi بلا backdrop-filter ── */
(function () {
    const html = read('public/index.html');
    const m = html.match(/\.hc-kpi\s*\{[^}]*\}/);
    if (!m) return bad('ز2 قاعدة .hc-kpi', 'القاعدة غير موجودة');
    if (!/backdrop-filter/.test(m[0])) ok('ز2 قاعدة .hc-kpi خالية من backdrop-filter');
    else bad('ز2 قاعدة .hc-kpi خالية من backdrop-filter', 'ما زالت تحمل backdrop-filter: ' + m[0].slice(0, 120));
})();

/* ── ز3: تجاوز عزل حاوية الخريطة موجود ── */
(function () {
    const html = read('public/index.html');
    const re = /\.ops-map-section\s*\{[^}]*backdrop-filter:\s*none\s*!important[^}]*\}/;
    if (re.test(html)) ok('ز3 تجاوز .ops-map-section { backdrop-filter: none !important } موجود');
    else bad('ز3 تجاوز عزل حاوية الخريطة', 'التجاوز مفقود من الطبقة الختامية في index.html');
})();

/* ── ز4: .ops-map-wrap تحتفظ بـ overflow: hidden ── */
(function () {
    const css = read(path.join('public', 'css', 'executive-theme.css'));
    const m = css.match(/\.ops-map-wrap\s*\{[^}]*\}/);
    if (m && /overflow:\s*hidden/.test(m[0])) ok('ز4 .ops-map-wrap تحتفظ بـ overflow: hidden (قص رسم الخريطة داخلها)');
    else bad('ز4 .ops-map-wrap overflow', 'overflow: hidden مفقودة من حاوية الخريطة');
})();

/* ── ز5: hc-alert-on حصرًا على بطاقة الغياب ── */
(function () {
    const jsDir = path.join(ROOT, 'public', 'js');
    const users = [];
    fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).forEach(f => {
        const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
        // كل سطر يبدّل hc-alert-on فعليًا (classList/add/remove/toggle) بعيدًا عن التعليقات
        src.split('\n').forEach((ln, i) => {
            if (/hc-alert-on/.test(ln) && /classList|addClass|toggleClass/.test(ln) && !/^\s*(\/\/|\*)/.test(ln)) {
                users.push({ f, i: i + 1, ln: ln.trim() });
            }
        });
    });
    // الوحيد المسموح: home-command.js حيث المتغير aCard = $('hcKpiAbsentCard')
    const hc = fs.readFileSync(path.join(jsDir, 'home-command.js'), 'utf8');
    const legit = /aCard\s*=\s*\$\('hcKpiAbsentCard'\)/.test(hc) && /aCard\.classList\.toggle\('hc-alert-on'/.test(hc);
    const onlyLegit = users.length === 1 && users[0].f === 'home-command.js' && legit;
    if (onlyLegit) ok('ز5 hc-alert-on يُبدَّل فقط على بطاقة الغياب hcKpiAbsentCard');
    else bad('ز5 حصر hc-alert-on', users.map(u => u.f + ':' + u.i + ' ' + u.ln).join(' | ') || 'لا استخدام');
})();

/* ── ز6: كل بطاقات الشريط الثماني تحمل .hc-kpi ── */
(function () {
    const html = read('public/index.html');
    const cards = (html.match(/class="hc-kpi hc-kpi-/g) || []).length;
    // 8 مؤشرات قيادة + بطاقة المستشفيات (1B) = 9 — كلها تشترك في .hc-kpi
    if (cards === 9) ok('ز6 بطاقات الشريط التسع كلها .hc-kpi (الإصلاح يغطيها جميعًا)');
    else bad('ز6 تغطية بطاقات الشريط', 'وُجد ' + cards + ' بدل 9');
})();

/* ── ز7: بطاقة المستشفيات داخلة في الإصلاح ── */
(function () {
    const html = read('public/index.html');
    const m = html.match(/<button[^>]*id="hcKpiHospCard"[^>]*>/);
    if (m && /class="[^"]*\bhc-kpi\b/.test(m[0])) ok('ز7 hcKpiHospCard تحمل .hc-kpi (تسري عليها إزالة backdrop-filter)');
    else bad('ز7 بطاقة المستشفيات', m ? 'لا تحمل .hc-kpi: ' + m[0] : 'البطاقة غير موجودة');
})();

/* ── ز8: لا عناصر تتبع المؤشر في طبقة الخريطة ── */
(function () {
    const files = ['public/js/map-adapter.js', 'public/js/smart-map.js', 'public/js/map-history.js'];
    const hits = [];
    files.forEach(f => {
        const src = read(f);
        ['mousemove', 'pointermove', 'clientX'].forEach(k => {
            if (src.includes(k)) hits.push(f + ' (' + k + ')');
        });
    });
    if (hits.length === 0) ok('ز8 لا tooltip/تتبع مؤشر في map-adapter / smart-map / map-history');
    else bad('ز8 تتبع المؤشر في طبقة الخريطة', hits.join(', '));
})();

console.log('\n──────────────────────────────');
console.log('النتيجة: ' + pass + ' ناجح · ' + fail + ' فاشل');
if (fail) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✅ كل ضوابط عزل الوهج ثابتة\n');
