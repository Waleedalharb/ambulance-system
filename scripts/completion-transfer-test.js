/* ============================================================
   completion-transfer-test.js — مانع رجوع إصلاحَي التكميل
   (توجيه المالك 2026-08-28 قبل النشر)

   ① Pointer DnD: التقاط فوري + استمرار مع Scroll + auto-scroll حواف
      + إلغاء آمن — بديل HTML5 Drag&Drop غير الثابت (كان لا يلتقط إلا
      بعد Scroll بالصدفة).
   ② النقل لأي رمز فرقة صالح ومعروف للنظام حتى لو غير مجدولة/غير
      متاحة بالجدول — بصلاحية ops.completion، والمنع فقط لرمز غير
      معروف أو فرقة معطّلة في سجل الفرق.

   تشغيل: node scripts/completion-transfer-test.js
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
let pass = 0, fail = 0;
const failures = [];
function ok(n) { pass++; console.log('  ✅ ' + n); }
function bad(n, w) { fail++; failures.push(n); console.log('  ❌ ' + n + ' — ' + w); }

console.log('\n🧪 اختبار إصلاحَي التكميل: Pointer DnD + النقل برمز الفرقة\n');

/* ت1: HTML5 Drag&Drop متقاعد تمامًا */
(function () {
    const leftovers = [];
    ['dragstart', 'dragover', 'dragleave', "addEventListener('drop'", 'dataTransfer', "setAttribute('draggable'"].forEach(k => {
        if (html.includes(k)) leftovers.push(k);
    });
    if (!leftovers.length) ok('ت1 HTML5 Drag&Drop متقاعد — لا dragstart/dragover/drop/dataTransfer/draggable في الصفحة');
    else bad('ت1 تقاعد HTML5 DnD', 'بقايا: ' + leftovers.join(', '));
})();

/* ت2: وحدة Pointer DnD مكتملة الأركان */
(function () {
    const need = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'elementFromPoint', 'requestAnimationFrame', 'rc-drag-ghost', 'rc-pointer-drag'];
    const missing = need.filter(k => !html.includes(k));
    if (!missing.length) ok('ت2 وحدة Pointer DnD موجودة بأركانها (التقاط/حركة/إفلات/إلغاء/هدف/ghost/auto-scroll)');
    else bad('ت2 أركان Pointer DnD', 'مفقود: ' + missing.join(', '));
})();

/* ت3: استمرارية السحب مع Scroll — حالة على document + حلقة rAF + حواف النافذة */
(function () {
    const chk = [
        [/document\.addEventListener\('pointermove', onMove, true\)/, 'مستمع حركة على document (capture)'],
        [/function autoScrollFrame\(\)[\s\S]*?window\.scrollBy/, 'auto-scroll عند الحواف'],
        [/window\.addEventListener\('blur'/, 'إلغاء آمن عند مغادرة النافذة'],
        [/key === 'Escape' && st && st\.dragging/, 'Escape يلغي السحب فقط'],
    ];
    const miss = chk.filter(c => !c[0].test(html)).map(c => c[1]);
    if (!miss.length) ok('ت3 الاستمرار مع Scroll + الإلغاء الآمن (document/rAF/حواف/blur/Escape)');
    else bad('ت3 الاستمرار مع Scroll', 'مفقود: ' + miss.join('، '));
})();

/* ت4: حارسا إعادة الرسم أثناء السحب ما زالا يعملان (كلاس rc-dragging محفوظ) */
(function () {
    const guards = (html.match(/\.pm\.rc-dragging, \.support-card\.rc-dragging/g) || []).length;
    const sets = html.includes("st.srcEl.classList.add('rc-dragging')") && html.includes("st.srcEl.classList.remove('rc-dragging')");
    if (guards >= 2 && sets) ok('ت4 كلاس rc-dragging يُضاف/يُزال في Pointer DnD — حارسا التحديث المؤجل (2016/2643) يعملان');
    else bad('ت4 حارسا إعادة الرسم', 'guards=' + guards + ' sets=' + sets);
})();

/* ت5: بوابة التأكيد الوحيدة — السحب لا يرسل مباشرة */
(function () {
    const m = html.match(/سحب المؤشر الموحّد[\s\S]*?\}\)\(\);/);
    const unit = m ? m[0] : '';
    const sends = /postPersonEvents|fetch\('/.test(unit);
    const opens = unit.includes('openRedistModal') && unit.includes('openActivationModal') && unit.includes('openSupportModal');
    if (!sends && opens) ok('ت5 الإفلات يفتح نوافذ التأكيد القائمة فقط — لا إرسال مباشر من وحدة السحب');
    else bad('ت5 بوابة التأكيد', 'sends=' + sends + ' opens=' + opens);
})();

/* ت6: الإدخال اليدوي لرمز الفرقة موجود ومربوط بوضع التوزيع */
(function () {
    const chk = [
        [/id="moveTeamCode" list="moveTeamCodes"/, 'حقل الرمز + datalist'],
        [/function submitMoveTeamCode\(\)/, 'دالة النقل اليدوي'],
        [/function fillMoveTeamCodes\(\)/, 'تعبئة الرموز المعروفة'],
        [/fillMoveTeamCodes\(\); \/\/ ②/, 'الاستدعاء داخل startMoveMode'],
    ];
    const miss = chk.filter(c => !c[0].test(html)).map(c => c[1]);
    if (!miss.length) ok('ت6 الإدخال اليدوي لرمز الفرقة مربوط بوضع التوزيع');
    else bad('ت6 الإدخال اليدوي', 'مفقود: ' + miss.join('، '));
})();

/* ت7: «عدم توفر الفرقة ≠ منع النقل» — التحقق من صحة الرمز فقط */
(function () {
    const known = /function knownTeamCodesMap\(\)[\s\S]*?serverTeamIds\(\)[\s\S]*?vbTeamsCache/.test(html);
    const reject = html.includes('رمز الفرقة غير صالح أو غير معروف للنظام');
    const noBlockMsg = !html.includes('الفرقة غير متاحة');
    const redist = /submitMoveTeamCode[\s\S]*?openRedistModal\(mv\.name, mv\.fromTeamId, code\)/.test(html);
    if (known && reject && noBlockMsg && redist) ok('ت7 الرموز المعروفة (مجدولة + سجل الفرق) تُقبل · غير المعروف يُرفض برسالة دقيقة · لا رسالة «غير متاحة»');
    else bad('ت7 منطق قبول الرمز', 'known=' + known + ' reject=' + reject + ' noBlockMsg=' + noBlockMsg + ' redist=' + redist);
})();

/* ت8: صلاحية النقل/التكميل مسيطر عليها في الواجهة + الخادم */
(function () {
    const g1 = html.includes('{ sel: \'button[onclick="confirmRedistribution()"]\', perm: \'ops.completion\' }');
    const g2 = html.includes('{ sel: \'button[onclick="submitMoveTeamCode()"]\', perm: \'ops.completion\' }');
    if (g1 && g2) ok('ت8 GATES: تأكيد النقل + النقل اليدوي بصلاحية ops.completion (والحسم النهائي سيرفري كما هو)');
    else bad('ت8 بوابات الصلاحية', 'confirmRedistribution=' + g1 + ' submitMoveTeamCode=' + g2);
})();

/* ت9: مسار الفرق غير المجدولة محفوظ بلا تعديل سيرفري */
(function () {
    const chk = [
        [/function isNonRosterTeam/, 'isNonRosterTeam'],
        [/kind === 'activate'/, "kind='activate'"],
        [/postActivation\('\/api\/staffing\/activation'/, 'مسار activation القائم'],
    ];
    const miss = chk.filter(c => !c[0].test(html)).map(c => c[1]);
    if (!miss.length) ok('ت9 الفرقة غير المجدولة ← تفعيل + توزيع عبر المسار القائم (بلا مسار سيرفري جديد)');
    else bad('ت9 مسار غير المجدولة', 'مفقود: ' + miss.join('، '));
})();

/* ت10: كل كتل الصفحة سليمة صياغيًا */
(function () {
    const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    let badCount = 0;
    blocks.forEach(b => { try { new Function(b[1]); } catch (_) { badCount++; } });
    if (!badCount && blocks.length >= 10) ok('ت10 كل كتل script المضمّنة (' + blocks.length + ') سليمة صياغيًا');
    else bad('ت10 سلامة الصياغة', 'فاشلة=' + badCount + ' من ' + blocks.length);
})();

console.log('\n──────────────────────────────');
console.log('النتيجة: ' + pass + ' ناجح · ' + fail + ' فاشل');
if (fail) { console.log('الفاشل:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('✅ إصلاحا التكميل ثابتان بنيويًا\n');
