/**
 * ═══ اختبار قواعد التنبيه التشغيلي — alert-rules-test.js ═══
 * (قرار المالك 2026-08-21): يمنع ظهور Timer/Alert لأي فرقة لم تتحرك فعليًا في CAD،
 * ويثبت دورة المراحل الأربع وتبديل الفرقة. قواعد نقية بلا خادم ولا متصفح.
 * التشغيل: node scripts/alert-rules-test.js
 */
'use strict';
const AR = require('../public/js/alert-rules.js');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// مرجع زمني ثابت: «الآن» = 12:00 ظهرًا = 720 دقيقة
const NOW = 720;
// أدوات بناء أوقات نسبية من NOW بصيغة CAD
function t(minOfDay) {
    const h24 = Math.floor(minOfDay / 60) % 24, m = Math.floor(minOfDay % 60);
    const mer = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return h12 + ':' + String(m).padStart(2, '0') + ':00 ' + mer;
}
function cadT(minOfDay) { return '21/8/2026 ' + t(minOfDay); }

console.log('\n① فرقة لم تتحرك ← بلا Timer ولا Alert إطلاقًا:');
{
    check('phases=null ← crewStage=null', AR.crewStage(null) === null);
    check('phases={} (لقطة فارغة) ← crewStage=null', AR.crewStage({}) === null);
    check('قبول فقط بلا تحرك ← crewStage=null', AR.crewStage({ 'قبول': t(700) }) === null);
    check('crewTimer=null لكل الأشكال الثلاثة',
        AR.crewTimer(null, cadT(700), NOW) === null &&
        AR.crewTimer({}, cadT(700), NOW) === null &&
        AR.crewTimer({ 'قبول': t(700) }, cadT(700), NOW) === null);
    const s = { incidents: [{ number: 'T1', cadCreatedAt: cadT(700), crews: [
        { unit: 'أ', phases: null }, { unit: 'ب', phases: {} }, { unit: 'ج', phases: { 'قبول': t(700) } }
    ] }] };
    check('computeAlerts يستثني الثلاثة جميعًا', AR.computeAlerts(s, NOW).length === 0);
}

console.log('\n② تحركت ← Timer وصول من إنشاء البلاغ (حد 10 د):');
{
    const ph = { 'قبول': t(694), 'التحرك': t(695) };
    check('crewStage=arrival', AR.crewStage(ph) === 'arrival');
    const ok = AR.crewTimer(ph, cadT(706), NOW);   // منقضٍ 14؟ لا — 720-706=14 ← over
    check('elapsed يُقاس من الإنشاء لا من التحرك', ok.elapsed === 14, JSON.stringify(ok));
    check('14 > 10 ← over', ok.level === 'over' && ok.stage === 'arrival');
    const near = AR.crewTimer(ph, cadT(711), NOW); // 9 د = 90% من الحد
    check('9 د ≥ 80% ← near', near.level === 'near', JSON.stringify(near));
    const ok2 = AR.crewTimer(ph, cadT(715), NOW);  // 5 د
    check('5 د ← ok (لا تنبيه)', ok2.level === 'ok');
    const edge = AR.crewTimer(ph, cadT(710), NOW); // 10 د بالضبط
    check('10 د بالضبط ليست تجاوزًا (over يتطلب > الحد)', edge.level === 'near' && edge.elapsed === 10);
}

console.log('\n③ وصلت («البحث») ← Timer الوصول يتوقف ويبدأ timer المباشرة (حد 12 د من الإنشاء):');
{
    const ph = { 'قبول': t(680), 'التحرك': t(682), 'البحث': t(700) };
    check('crewStage=mubashara (الوصول انتهى)', AR.crewStage(ph) === 'mubashara');
    const tm = AR.crewTimer(ph, cadT(680), NOW);   // منقضٍ من الإنشاء 40 > 12
    check('المباشرة تُقاس من الإنشاء: 40 د ← over', tm.stage === 'mubashara' && tm.elapsed === 40 && tm.level === 'over', JSON.stringify(tm));
    const tm2 = AR.crewTimer(ph, cadT(712), NOW);  // 8 د من الإنشاء ← ضمن الحد
    check('8 د ← ok', tm2.level === 'ok');
}

console.log('\n④ باشرت («العلاج») ← يبدأ Timer البقاء في الموقع من «البحث» (حد 15 د):');
{
    const ph = { 'قبول': t(600), 'التحرك': t(601), 'البحث': t(610), 'العلاج': t(612) };
    check('crewStage=onscene', AR.crewStage(ph) === 'onscene');
    const tm = AR.crewTimer(ph, cadT(600), NOW);   // بقاء = 720-610 = 110 > 15
    check('البقاء من البحث لا من الإنشاء: 110 د ← over', tm.stage === 'onscene' && tm.elapsed === 110 && tm.level === 'over', JSON.stringify(tm));
    const ph2 = { 'التحرك': t(700), 'البحث': t(710), 'العلاج': t(711) };
    const tm2 = AR.crewTimer(ph2, cadT(700), NOW); // بقاء = 10 د ← near (10/15=67%؟ لا ← ok)
    check('بقاء 10 د (67%) ← ok', tm2.level === 'ok', JSON.stringify(tm2));
    const ph3 = { 'التحرك': t(600), 'البحث': t(700), 'العلاج': t(701) };
    const tm3 = AR.crewTimer(ph3, cadT(600), NOW); // بقاء = 20 > 15 ← over
    check('بقاء 20 د ← over', tm3.level === 'over');
}

console.log('\n⑤ تبديل الفرقة ← المسؤولية تنتقل بلا مضاعفة ولا تنبيه للملغاة:');
{
    const s = { incidents: [{ number: 'T5', cadCreatedAt: cadT(690), crews: [
        { unit: 'القديمة', phases: { 'قبول': t(690) } },                       // لم تتحرك
        { unit: 'الجديدة', phases: { 'قبول': t(700), 'التحرك': t(701) } }      // تحركت — منقضٍ 30 د
    ] }] };
    const alerts = AR.computeAlerts(s, NOW);
    check('تنبيه واحد فقط', alerts.length === 1, JSON.stringify(alerts));
    check('التنبيه للجديدة فقط (تأخر وصول over)', alerts[0] && alerts[0].unit === 'الجديدة' && alerts[0].stage === 'arrival' && alerts[0].level === 'over');
    check('لا أثر للقديمة إطلاقًا', !alerts.some(a => a.unit === 'القديمة'));
}

console.log('\n⑥ صدق البيانات وحواف التقويم:');
{
    check('بلاغ بلا وقت إنشاء ← crewTimer=null', AR.crewTimer({ 'التحرك': t(700) }, null, NOW) === null);
    check('بلاغ بوقت غير قابل للقراءة ← null', AR.crewTimer({ 'التحرك': t(700) }, 'غير مفهوم', NOW) === null);
    // عبور منتصف الليل: إنشاء 23:50، الآن 00:05 (1445 دقيقة) ← منقضٍ 15 د
    const cross = AR.crewTimer({ 'التحرك': t(1435) }, cadT(1430), 1445 % 1440);
    check('عبور منتصف الليل: 23:50→00:05 = 15 د', cross.elapsed === 15, JSON.stringify(cross));
    // صيغ CAD المقبولة
    check('cadMin يقبل «7:11:38 AM»', AR.cadMin('7:11:38 AM') === 7 * 60 + 11 + 38 / 60);
    check('cadMin يقبل ص/م العربية', AR.cadMin('1:30:00 م') === 13 * 60 + 30);
    check('cadMin يقبل التاريخ + الوقت', AR.cadMin('20/08/2026 5:00:06 AM') === 5 * 60 + 0.1);
    check('cadMin يرفض قيمًا مستحيلة', AR.cadMin('25:99:99 AM') === null);
}

console.log('\n⑦ ترتيب الأولوية: المتجاوز أولًا (بالأكثر تجاوزًا) ثم القريب:');
{
    const s = { incidents: [
        { number: 'A', cadCreatedAt: cadT(711), crews: [{ unit: 'قريبة', phases: { 'التحرك': t(711) } }] },   // 9 د near
        { number: 'B', cadCreatedAt: cadT(660), crews: [{ unit: 'متجاوزة60', phases: { 'التحرك': t(660) } }] }, // 60 د over+50
        { number: 'C', cadCreatedAt: cadT(700), crews: [{ unit: 'متجاوزة20', phases: { 'التحرك': t(700) } }] }  // 20 د over+10
    ] };
    const alerts = AR.computeAlerts(s, NOW);
    check('الترتيب: متجاوزة60 ← متجاوزة20 ← قريبة',
        alerts.length === 3 && alerts[0].unit === 'متجاوزة60' && alerts[1].unit === 'متجاوزة20' && alerts[2].unit === 'قريبة',
        JSON.stringify(alerts.map(a => a.unit)));
}

console.log('\n⑧ الفرقة المسحوبة (§4): لا Timer ولا Alert مهما تجاوزت الأزمنة — والمسؤولية للباقين:');
{
    const s = { incidents: [{ number: 'T8', cadCreatedAt: cadT(660), crews: [
        { unit: 'مسحوبة', withdrawn: true, phases: { 'قبول': t(660), 'التحرك': t(661) } },                    // 60 د arrival — لكنها مسحوبة
        { unit: 'مسحوبة2', withdrawn: true, phases: { 'التحرك': t(600), 'البحث': t(610), 'العلاج': t(612) } } // بقاء 110 د — مسحوبة أيضًا
    ] }] };
    check('مسحوبة متأخرة الوصول ← صفر تنبيهات', AR.computeAlerts(s, NOW).length === 0);
    const s2 = { incidents: [{ number: 'T8b', cadCreatedAt: cadT(660), crews: [
        { unit: 'مسحوبة', withdrawn: true, phases: { 'التحرك': t(661) } },
        { unit: 'باقية', phases: { 'التحرك': t(662) } } // 58 د ← over
    ] }] };
    const a2 = AR.computeAlerts(s2, NOW);
    check('بلاغ مختلط: تنبيه واحد للباقية فقط', a2.length === 1 && a2[0].unit === 'باقية', JSON.stringify(a2.map(a => a.unit)));
    check('withdrawn=false الصريح (عادت) ← تُعامَل طبيعيًا', AR.computeAlerts({ incidents: [{ number: 'T8c', cadCreatedAt: cadT(660), crews: [
        { unit: 'عائدة', withdrawn: false, phases: { 'التحرك': t(661) } }
    ] }] }, NOW).length === 1);
}

console.log('\n══════════════════════════════════════════════════');
console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('★ كل تنبيه مرتبط بحدث CAD فعلي — لا مؤقت لفرقة لم تتحرك');
