/**
 * ═══ اختبار محرك الأزمنة التشغيلية — alert-rules-test.js ═══
 * (اعتماد المالك 2026-08-25 — إعادة بناء تنبيهات الخريطة حسب مراحل البلاغ وتصنيفه)
 * يثبت: أربع مراحل مستقلة (وصول 10/Echo 8 · مباشرة 2 · موقع 10 · منشأة 10) ·
 * تصنيف A/B/C/D/E من proQACode · قاعدة الحد (التجاوز فقط — المساواة ليست تأخيرًا) ·
 * توقف كل مؤقت فور حدث نهايته (لا تنبيهات وهمية) · بوابة «لا تحرك = لا تنبيه».
 * قواعد نقية بلا خادم ولا متصفح. التشغيل: node scripts/alert-rules-test.js
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
function t(minOfDay) {
    const h24 = Math.floor(minOfDay / 60) % 24, m = Math.floor(minOfDay % 60);
    const mer = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return h12 + ':' + String(m).padStart(2, '0') + ':00 ' + mer;
}
function cadT(minOfDay) { return '21/8/2026 ' + t(minOfDay); }
// دقيقة + ثوانٍ (لدقة حدود :59/:01)
function tm(minOfDay, sec) {
    const base = t(minOfDay);
    return base.replace(':00 ', ':' + String(sec).padStart(2, '0') + ' ');
}

console.log('\n① التصنيف من proQACode — Parser مركزي وحيد (أكواد حقيقية من البيانات):');
{
    check('13C03 → Charlie (كود حقيقي)', (AR.classify('13C03') || {}).name === 'Charlie' && AR.classify('13C03').letter === 'C');
    check('31D02 → Delta (كود حقيقي)', (AR.classify('31D02') || {}).name === 'Delta' && AR.classify('31D02').letter === 'D');
    check('9E01 → Echo (كود Echo حقيقي — ليس افتراضيًا)', (AR.classify('9E01') || {}).name === 'Echo' && AR.classify('9E01').critical === true);
    check('25D03V → Delta (لاحقة حرفية اختيارية)', (AR.classify('25D03V') || {}).letter === 'D');
    check('21D04M → Delta (لاحقة + رقم واحد بادئ يعملان)', (AR.classify('21D04M') || {}).letter === 'D');
    check('A → Alpha · B → Bravo · C → Charlie · D → Delta · E → Echo',
        AR.classify('1A01').name === 'Alpha' && AR.classify('1B01').name === 'Bravo' &&
        AR.classify('1C01').name === 'Charlie' && AR.classify('1D01').name === 'Delta' && AR.classify('1E01').name === 'Echo');
    check('بلا كود ← بلا تصنيف (لا تخمين)', AR.classify(null) === null && AR.classify('') === null);
    check('كود غير مطابق للشكل ← null', AR.classify('حادث مروري') === null && AR.classify('12345') === null);
    check('Echo وحدها هدفها 8 د — الباقي 10 د',
        AR.arrivalTarget(AR.classify('9E01')) === 8 &&
        AR.arrivalTarget(AR.classify('13C03')) === 10 &&
        AR.arrivalTarget(AR.classify('31D02')) === 10 &&
        AR.arrivalTarget(null) === 10);
}

console.log('\n② بوابة الأهلية: فرقة لم تتحرك ← بلا Timer ولا Alert إطلاقًا:');
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

console.log('\n③ الوصول: createdDate → البحث (10 د · التجاوز فقط تأخير):');
{
    const ph = { 'قبول': t(694), 'التحرك': t(695) };
    check('crewStage=arrival', AR.crewStage(ph) === 'arrival');
    const ok = AR.crewTimer(ph, cadT(706), NOW);
    check('elapsed يُقاس من الإنشاء لا من التحرك (14 د)', ok.elapsed === 14, JSON.stringify(ok));
    check('14 > 10 ← over', ok.level === 'over' && ok.stage === 'arrival' && ok.target === 10);
    const e1 = AR.crewTimer(ph, cadT(710), NOW);      // 10:00 بالضبط
    check('10:00 بالضبط ليست تأخيرًا (قاعدة الحد)', e1.level !== 'over' && e1.elapsed === 10, JSON.stringify(e1));
    const e2 = AR.crewTimer(ph, cadT(709) , NOW + 1); // 10:01
    check('10:01 ← تأخير over', e2.level === 'over' && e2.overdue > 0, JSON.stringify(e2));
    const e3 = AR.crewTimer(ph, cadT(710) , NOW - 1); // 9:59
    check('9:59 ← لا تأخير', e3.level !== 'over');
    const ok2 = AR.crewTimer(ph, cadT(715), NOW);     // 5 د
    check('5 د ← ok (لا تنبيه)', ok2.level === 'ok');
    check('startAt = وقت إنشاء CAD نفسه', ok.startAt === cadT(706));
}

console.log('\n④ Echo: هدف الوصول 8 د (الاستثناء الوحيد):');
{
    const ph = { 'التحرك': t(700) };
    const cls = AR.classify('9E01');
    const e1 = AR.crewTimer(ph, cadT(712), NOW, cls); // 8:00 بالضبط
    check('Echo 8:00 بالضبط ← ليست تأخيرًا', e1.level !== 'over' && e1.target === 8, JSON.stringify(e1));
    const e2 = AR.crewTimer(ph, cadT(711), NOW + 1, cls); // 9:01 من الإنشاء = 9 د+ ← over
    check('Echo 9 د ← تأخير (الهدف 8 لا 10)', e2.level === 'over', JSON.stringify(e2));
    const e3 = AR.crewTimer(ph, cadT(713), NOW, cls); // 7 د
    check('Echo 7 د ← لا تأخير', e3.level !== 'over');
    // بلاغ عادي بنفس الزمن لا يُنبِّه — إثبات أن Echo هو الاستثناء
    const e4 = AR.crewTimer(ph, cadT(711), NOW + 1, AR.classify('31D02'));
    check('Delta بنفس 9 د ← لا تأخير (هدفها 10)', e4.level !== 'over', JSON.stringify(e4));
}

console.log('\n⑤ المباشرة: البحث → العلاج (2 د · لا تُحسب من الإنشاء إطلاقًا):');
{
    const ph = { 'قبول': t(680), 'التحرك': t(682), 'البحث': t(718) };
    check('crewStage=direct', AR.crewStage(ph) === 'direct');
    const tm = AR.crewTimer(ph, cadT(680), NOW);
    check('تُقاس من البحث لا من الإنشاء: منقضٍ 2 د رغم مرور 40 د على الإنشاء',
        tm.stage === 'direct' && tm.elapsed === 2 && tm.startAt === t(718), JSON.stringify(tm));
    check('2:00 بالضبط ← ليست تأخيرًا', tm.level !== 'over' && tm.target === 2);
    const tm2 = AR.crewTimer(ph, cadT(680), NOW + 1); // 3 د
    check('3 د ← تأخر مباشرة over (+1)', tm2.level === 'over' && Math.round(tm2.overdue) === 1, JSON.stringify(tm2));
    const ph2 = { 'التحرك': t(700), 'البحث': t(719) };
    const tm3 = AR.crewTimer(ph2, cadT(700), NOW);    // دقيقة واحدة
    check('1 د ← ok', tm3.level === 'ok');
}

console.log('\n⑥ الموقع: العلاج → النقل/نهاية البلاغ (10 د · تُقاس من العلاج لا من البحث):');
{
    const ph = { 'التحرك': t(600), 'البحث': t(610), 'العلاج': t(710) };
    check('crewStage=scene', AR.crewStage(ph) === 'scene');
    const tm = AR.crewTimer(ph, cadT(600), NOW);
    check('تُقاس من العلاج: منقضٍ 10 د (وليس 110 من البحث)', tm.elapsed === 10 && tm.startAt === t(710), JSON.stringify(tm));
    check('10:00 بالضبط ← ليست تأخيرًا', tm.level !== 'over' && tm.target === 10);
    const tm2 = AR.crewTimer(ph, cadT(600), NOW + 1); // 11 د
    check('11 د ← تأخر في الموقع over', tm2.level === 'over', JSON.stringify(tm2));
    const ph2 = { 'التحرك': t(700), 'البحث': t(705), 'العلاج': t(719) };
    const tm3 = AR.crewTimer(ph2, cadT(700), NOW);    // دقيقة واحدة
    check('1 د ← ok', tm3.level === 'ok');
}

console.log('\n⑦ المنشأة: بدء التسليم → انتهاء التسليم (10 د):');
{
    const ph = { 'التحرك': t(600), 'البحث': t(610), 'العلاج': t(612), 'النقل': t(620), 'بدء التسليم': t(710) };
    check('crewStage=facility', AR.crewStage(ph) === 'facility');
    const tm = AR.crewTimer(ph, cadT(600), NOW);
    check('تُقاس من بدء التسليم: 10 د', tm.elapsed === 10 && tm.startAt === t(710) && tm.target === 10, JSON.stringify(tm));
    check('10:00 بالضبط ← ليست تأخيرًا', tm.level !== 'over');
    const tm2 = AR.crewTimer(ph, cadT(600), NOW + 1); // 11 د
    check('11 د ← تأخر في المنشأة over', tm2.level === 'over', JSON.stringify(tm2));
    const ph2 = { 'التحرك': t(600), 'بدء التسليم': t(712) };
    const tm3 = AR.crewTimer(ph2, cadT(600), NOW);    // 8 د = 80% من الحد
    check('8 د ← لا تأخير (near مؤشر منفصل — ليست over)', tm3.level === 'near' && tm3.level !== 'over');
}

console.log('\n⑧ المؤقت ينتقل مع المرحلة — لا تنبيهات وهمية (توقف فوري عند حدث النهاية):');
{
    // بلاغ واحد يتقدم عبر الزمن — في كل لقطة مرحلة واحدة فقط
    const base = { 'التحرك': t(700) };
    check('تحرك فقط ← arrival', AR.crewStage(base) === 'arrival');
    check('بعد البحث ← وصول يتوقف ويبدأ مباشرة', AR.crewStage({ ...base, 'البحث': t(710) }) === 'direct');
    check('بعد العلاج ← مباشرة تتوقف ويبدأ موقع', AR.crewStage({ ...base, 'البحث': t(710), 'العلاج': t(712) }) === 'scene');
    check('بعد النقل ← موقع يتوقف (في الطريق — لا مؤقت)', AR.crewStage({ ...base, 'البحث': t(710), 'العلاج': t(712), 'النقل': t(718) }) === null);
    check('بعد بدء التسليم ← منشأة تعمل', AR.crewStage({ ...base, 'البحث': t(710), 'العلاج': t(712), 'النقل': t(718), 'بدء التسليم': t(719) }) === 'facility');
    check('بعد انتهاء التسليم ← كل المؤقتات متوقفة', AR.crewStage({ ...base, 'البحث': t(710), 'العلاج': t(712), 'النقل': t(718), 'بدء التسليم': t(719), 'انتهاء التسليم': t(720) }) === null);
    // بلاغ كامل بكل المراحل المكتملة ← صفر تنبيهات حتى لو تجاوزت الأزمنة الحدود
    const done = { incidents: [{ number: 'DONE', cadCreatedAt: cadT(600), crews: [{ unit: 'مكتملة', phases: {
        'التحرك': t(600), 'البحث': t(620), 'العلاج': t(640), 'النقل': t(700), 'بدء التسليم': t(705), 'انتهاء التسليم': t(719) } }] }] };
    check('رحلة مكتملة بأزمنة متجاوزة ← صفر تنبيهات (لا وهمية)', AR.computeAlerts(done, NOW).length === 0);
    // نهاية البلاغ بدون نقل (رفض النقل) ← مؤقت الموقع يتوقف مع نهاية البلاغ
    const refused = { incidents: [{ number: 'REF', status: 'closed', cadCreatedAt: cadT(600), crews: [{ unit: 'رفض', phases: {
        'التحرك': t(600), 'البحث': t(610), 'العلاج': t(612) } }] }] };
    check('بلاغ انتهى بلا نقل (رفض) ← صفر تنبيهات رغم بقاء 108 د', AR.computeAlerts(refused, NOW).length === 0);
}

console.log('\n⑨ سيناريو البلاغ الناجح الكامل (§14): لا تنبيه تأخير في أي نقطة:');
{
    // إنشاء 10:00 ← وصول 8 د ← مباشرة 2 د ← نقل بعد 10 د ← تسليم 8 د
    const C = 600; // إنشاء
    const ph = { 'التحرك': t(601), 'البحث': t(608), 'العلاج': t(610), 'النقل': t(620), 'بدء التسليم': t(630), 'انتهاء التسليم': t(638) };
    const mk = (phases, atMin) => AR.computeAlerts({ incidents: [{ number: 'OK1', cadCreatedAt: cadT(C), crews: [{ unit: 'ف', phases }] }] }, atMin);
    const partial = (keys) => { const o = {}; keys.forEach(k => { if (ph[k]) o[k] = ph[k]; }); return o; };
    check('عند 8 د (لحظة الوصول) ← لا over', mk(partial(['التحرك']), 608).every(a => a.level !== 'over'));
    check('عند 10 د (لحظة المباشرة) ← لا over', mk(partial(['التحرك', 'البحث']), 610).every(a => a.level !== 'over'));
    check('عند 20 د (لحظة النقل) ← لا over', mk(partial(['التحرك', 'البحث', 'العلاج']), 620).every(a => a.level !== 'over'));
    check('عند 38 د (لحظة انتهاء التسليم) ← لا over', mk(partial(['التحرك', 'البحث', 'العلاج', 'النقل', 'بدء التسليم']), 638).every(a => a.level !== 'over'));
    check('بعد اكتمال الرحلة ← صفر تنبيهات', mk(ph, 640).length === 0);
}

console.log('\n⑩ سيناريوهات التأخير الخمسة (§14):');
{
    const mk = (phases, atMin, code) => AR.computeAlerts({ incidents: [{ number: 'D1', code: code || null, cadCreatedAt: cadT(600), crews: [{ unit: 'ف', phases }] }] }, atMin);
    const a1 = mk({ 'التحرك': t(600) }, 611); // 11 د بلا وصول
    check('تأخر وصول: 11 د ← over arrival', a1.length === 1 && a1[0].stage === 'arrival' && a1[0].level === 'over', JSON.stringify(a1));
    const a2 = mk({ 'التحرك': t(600) }, 609, '9E01'); // Echo 9 د
    check('تأخر وصول Echo: 9 د ← over (الهدف 8)', a2.length === 1 && a2[0].stage === 'arrival' && a2[0].level === 'over' && a2[0].target === 8 && a2[0].classification.critical === true, JSON.stringify(a2));
    const a3 = mk({ 'التحرك': t(600), 'البحث': t(608) }, 611); // مباشرة 3 د
    check('تأخر مباشرة: 3 د ← over direct (+1)', a3.length === 1 && a3[0].stage === 'direct' && a3[0].level === 'over' && Math.round(a3[0].overdue) === 1, JSON.stringify(a3));
    const a4 = mk({ 'التحرك': t(600), 'البحث': t(605), 'العلاج': t(606) }, 617); // موقع 11 د
    check('تأخر في الموقع: 11 د ← over scene', a4.length === 1 && a4[0].stage === 'scene' && a4[0].level === 'over', JSON.stringify(a4));
    const a5 = mk({ 'التحرك': t(600), 'البحث': t(602), 'العلاج': t(603), 'النقل': t(604), 'بدء التسليم': t(606) }, 617); // منشأة 11 د
    check('تأخر في المنشأة: 11 د ← over facility', a5.length === 1 && a5[0].stage === 'facility' && a5[0].level === 'over', JSON.stringify(a5));
    // مدخل التنبيه يحمل السبب كاملًا (§9)
    check('مدخل التنبيه يحمل: التصنيف + الهدف + الفعلي + التجاوز + البداية',
        a2[0].classification.name === 'Echo' && a2[0].target === 8 && a2[0].elapsed > 8 && a2[0].overdue > 0 && !!a2[0].startAt);
}

console.log('\n⑪ تبديل الفرقة والمسحوبة (قواعد سارية):');
{
    const s = { incidents: [{ number: 'T5', cadCreatedAt: cadT(690), crews: [
        { unit: 'القديمة', phases: { 'قبول': t(690) } },
        { unit: 'الجديدة', phases: { 'قبول': t(700), 'التحرك': t(701) } }
    ] }] };
    const alerts = AR.computeAlerts(s, NOW);
    check('تنبيه واحد فقط للجديدة (تأخر وصول)', alerts.length === 1 && alerts[0].unit === 'الجديدة' && alerts[0].stage === 'arrival' && alerts[0].level === 'over');
    const s2 = { incidents: [{ number: 'T8b', cadCreatedAt: cadT(660), crews: [
        { unit: 'مسحوبة', withdrawn: true, phases: { 'التحرك': t(661) } },
        { unit: 'باقية', phases: { 'التحرك': t(662) } }
    ] }] };
    const a2 = AR.computeAlerts(s2, NOW);
    check('المسحوبة لا تُنبِّه مهما تجاوزت — الباقية فقط', a2.length === 1 && a2[0].unit === 'باقية');
}

console.log('\n⑫ صدق البيانات وحواف التقويم والترتيب:');
{
    check('بلاغ بلا وقت إنشاء ← crewTimer=null', AR.crewTimer({ 'التحرك': t(700) }, null, NOW) === null);
    check('بلاغ بوقت غير قابل للقراءة ← null', AR.crewTimer({ 'التحرك': t(700) }, 'غير مفهوم', NOW) === null);
    const cross = AR.crewTimer({ 'التحرك': t(1435) }, cadT(1430), 1445 % 1440);
    check('عبور منتصف الليل: 23:50→00:05 = 15 د', cross.elapsed === 15, JSON.stringify(cross));
    check('cadMin يقبل «7:11:38 AM»', AR.cadMin('7:11:38 AM') === 7 * 60 + 11 + 38 / 60);
    check('cadMin يقبل ص/م العربية', AR.cadMin('1:30:00 م') === 13 * 60 + 30);
    check('cadMin يقبل التاريخ + الوقت', AR.cadMin('20/08/2026 5:00:06 AM') === 5 * 60 + 0.1);
    check('cadMin يرفض قيمًا مستحيلة', AR.cadMin('25:99:99 AM') === null);
    const s = { incidents: [
        { number: 'A', cadCreatedAt: cadT(660), crews: [{ unit: 'متجاوزة60', phases: { 'التحرك': t(660) } }] },
        { number: 'B', cadCreatedAt: cadT(700), crews: [{ unit: 'متجاوزة20', phases: { 'التحرك': t(700) } }] },
        { number: 'C', cadCreatedAt: cadT(714), crews: [{ unit: 'طبيعية', phases: { 'التحرك': t(714) } }] }
    ] };
    const alerts = AR.computeAlerts(s, NOW);
    check('الترتيب: الأكثر تجاوزًا أولًا، والطبيعية خارج القائمة',
        alerts.length === 2 && alerts[0].unit === 'متجاوزة60' && alerts[1].unit === 'متجاوزة20',
        JSON.stringify(alerts.map(a => a.unit)));
}

console.log('\n══════════════════════════════════════════════════');
console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
console.log('★ محرك الأزمنة الموحد: 4 مراحل مستقلة + تصنيف CAD + توقف فوري بلا تنبيهات وهمية');
