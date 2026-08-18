/**
 * ═══ اختبارات واجهة «🏆 إنجاز الفرق» — crew-achievement-ui-test.js (Phase D) ═══
 * (قرار المالك 2026-08-18) مصفوفة الاختبارات العشر المعتمدة:
 *  1) ★ الذهبي الموسّع: week بمناوبتين لنفس الفرقة — البطاقة تعرض طاقم أحدث
 *     مناوبة فقط + تاريخها، وخالد/سعد لا يتسربان للسطر الرئيسي إطلاقًا
 *  2) current_shift: الأسماء من members مباشرة، واستبدال كامل عند تغير الحمولة
 *  3) report_undone: الرقم يعود (لا أثر للمتراجع) عبر حمولتين متتاليتين
 *  4) الحالة 2: نص «لا توجد مناوبة نشطة» + التبويبات باقية (ساكن)
 *  5) الحالة 3: standings فارغة ← «السباق لم يبدأ»
 *  6) الحالة 4: فشل جلب ← ترميد بلا أرقام قديمة
 *  7) العدد والمعدل معًا في كل صف؛ rate=null ← «—»
 *  8) صفر «أفضل فرقة» + سطر العدالة دائمًا
 *  9) الربط الساكن: خطاف ops:sse في app.js + مستمعو الأحداث الأربعة + لا غطاء فوق الأزرار
 * 10) RTL/الثيم: الأنماط scoped بـ.crew-board وتستخدم متغيرات الثيم
 * سلوكي: دوال الرسم النقية في Node بلا خادم. ساكن: قراءة الملفات.
 * التشغيل: node scripts/crew-achievement-ui-test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BOARD = require(path.join(ROOT, 'public', 'js', 'crew-achievement-board.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function readFile(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

// ─── بذور الحمولات (بنفس عقد المحرك المنشور) ───
function standing(over) {
    return Object.assign({
        rank: 1, team: 'جنوب 5', center: 'الجنوب',
        reports_count: 0, members: [],
        shift_minutes: 0, active_minutes: 0, active_minutes_estimated: true,
        activity_rate_per_hour: null, shifts: []
    }, over);
}

// الحمولة الذهبية: نفس الفرقة × مناوبتان × أسماء مختلفة
const GOLDEN = {
    success: true, scope: 'south', period: 'week', label: 'الأكثر نشاطًا',
    period_range: { from: '2026-08-16', to: '2026-08-22' },
    standings: [standing({
        rank: 1, team: 'جنوب 5', reports_count: 5,
        members: ['محمد صالح', 'فهد العتيبي', 'خالد الدوسري', 'سعد المطيري'], // الحقل المجمّع — ممنوع عرضه في week
        activity_rate_per_hour: 0.62,
        shifts: [
            { shift_id: 's2', shift_date: '2026-08-18', shift_type: 'morning', reports_count: 2, members: ['محمد صالح', 'فهد العتيبي'] },
            { shift_id: 's1', shift_date: '2026-08-17', shift_type: 'morning', reports_count: 3, members: ['خالد الدوسري', 'سعد المطيري'] }
        ]
    })],
    meta: { teams_ranked: 1, teams_active_without_reports: 0, note: '' }
};

console.log('\n═══ Phase D — اختبارات واجهة إنجاز الفرق (10) ═══\n');

// ─── 1) ★ الذهبي الموسّع ───
console.log('① القاعدة الذهبية الموسّعة (week، مناوبتان، أسماء مختلفة):');
{
    const html = BOARD.renderBoard(GOLDEN, 'week', false);
    const cut = html.indexOf('<details');
    check('يوجد قسم تفاصيل مناوبات', cut !== -1);
    const head = cut !== -1 ? html.slice(0, cut) : html;
    const tail = cut !== -1 ? html.slice(cut) : '';
    check('البطاقة الرئيسية تعرض طاقم أحدث مناوبة (محمد · فهد)', head.includes('محمد صالح') && head.includes('فهد العتيبي'));
    check('كل اسم عنصر بصري مستقل (بند 8 — لا كتلة أسماء)', (head.match(/crew-board-person/g) || []).length === 2);
    check('البطاقة الرئيسية تعرض تاريخ المناوبة «مناوبة 18»', head.includes('مناوبة 18'));
    check('خالد لا يتسرب للسطر الرئيسي إطلاقًا', !head.includes('خالد'));
    check('سعد لا يتسرب للسطر الرئيسي إطلاقًا', !head.includes('سعد'));
    check('التوسعة تعرض مناوبة أمس بأسمائها وبلاغاتها', tail.includes('17 أغسطس') && tail.includes('خالد الدوسري') && tail.includes('سعد المطيري') && tail.includes('3 بلاغات'));
    check('التوسعة تعرض مناوبة اليوم بأسمائها وبلاغاتها', tail.includes('18 أغسطس') && tail.includes('محمد صالح') && tail.includes('2 بلاغ'));
}

// ─── 2) current_shift: الأسماء من members + استبدال كامل ───
console.log('② current_shift — الأسماء من members، واستبدال كامل عند تبديل المناوبة:');
{
    const p1 = { standings: [standing({ rank: 1, team: 'جنوب 8', reports_count: 4, activity_rate_per_hour: 0.55, members: ['عبدالله الشلاع', 'أحمد الرمضان'] })], meta: { teams_ranked: 1 } };
    const p2 = { standings: [standing({ rank: 1, team: 'جنوب 8', reports_count: 2, activity_rate_per_hour: 0.3, members: ['محمد الغامدي', 'سعد القحطاني'] })], meta: { teams_ranked: 1 } };
    const h1 = BOARD.renderBoard(p1, 'current_shift', false);
    const h2 = BOARD.renderBoard(p2, 'current_shift', false);
    check('المناوبة الأولى: أسماؤها من members مباشرة', h1.includes('عبدالله الشلاع') && h1.includes('أحمد الرمضان'));
    check('بعد التبديل: الأسماء الجديدة تظهر فورًا', h2.includes('محمد الغامدي') && h2.includes('سعد القحطاني'));
    check('استبدال كامل: لا أثر لأسماء المناوبة السابقة', !h2.includes('عبدالله الشلاع') && !h2.includes('أحمد الرمضان'));
    check('وسم «✨ طاقم هذه المناوبة» يظهر في الفترة القصيرة', h1.includes('✨ طاقم هذه المناوبة'));
}

// ─── 3) report_undone: الرقم يعود ───
console.log('③ التراجع عن بلاغ — الرقم يعود بلا أثر للمتراجع:');
{
    const before = { standings: [standing({ rank: 1, team: 'جنوب 3', reports_count: 5, members: ['أمجد'] })], meta: { teams_ranked: 1 } };
    const after = { standings: [standing({ rank: 1, team: 'جنوب 3', reports_count: 4, members: ['أمجد'] })], meta: { teams_ranked: 1 } };
    const hb = BOARD.renderBoard(before, 'today', false);
    const ha = BOARD.renderBoard(after, 'today', false);
    check('قبل التراجع: 5 بلاغات', hb.includes('5 بلاغات'));
    check('بعد التراجع: 4 بلاغات', ha.includes('4 بلاغات'));
    check('لا أثر للرقم القديم بعد التراجع', !ha.includes('5 بلاغات'));
}

// ─── 4) الحالة 2: لا مناوبة نشطة (404) + التبويبات باقية ───
console.log('④ الحالة 2 — لا مناوبة نشطة:');
{
    const html = BOARD.renderNoActiveShift();
    check('نص «لا توجد مناوبة نشطة»', html.includes('لا توجد مناوبة نشطة'));
    const indexHtml = readFile('public/index.html');
    const tabs = ['current_shift', 'today', 'week', 'month'].every(p => indexHtml.includes('data-period="' + p + '"'));
    check('التبويبات الأربعة باقية في هيكل الصفحة', tabs);
}

// ─── 5) الحالة 3: السباق لم يبدأ ───
console.log('⑤ الحالة 3 — فترة بلا بلاغات:');
{
    const html = BOARD.renderBoard({ standings: [], meta: { teams_ranked: 0 } }, 'today', false);
    check('نص «السباق لم يبدأ — أول بلاغ يصنع المتصدر»', html.includes('السباق لم يبدأ — أول بلاغ يصنع المتصدر'));
}

// ─── 6) الحالة 4: فشل الجلب — ترميد بلا أرقام قديمة ───
console.log('⑥ الحالة 4 — فشل الجلب:');
{
    const prev = BOARD.renderBoard({ standings: [standing({ rank: 1, team: 'سريع 1', reports_count: 42, members: ['سلمان'] })], meta: { teams_ranked: 1 } }, 'month', false);
    const err = BOARD.renderError();
    check('الحمولة السابقة كانت تعرض 42 فعلًا', prev.includes('42'));
    check('نص «تعذر تحديث اللوحة»', err.includes('تعذر تحديث اللوحة'));
    check('ترميد بلا أرقام قديمة (لا 42 ولا اسم الفرقة)', !err.includes('42') && !err.includes('سريع 1') && !err.includes('سلمان'));
    check('الحالة معطوبة بصريًا (faded)', err.includes('crew-board-faded'));
}

// ─── 7) العدد والمعدل معًا؛ rate=null ← «—» ───
console.log('⑦ العدد والمعدل معًا في كل صف:');
{
    const p = {
        standings: [
            standing({ rank: 1, team: 'جنوب 1', reports_count: 4, activity_rate_per_hour: 0.55, members: ['أ'] }),
            standing({ rank: 2, team: 'جنوب 2', reports_count: 3, activity_rate_per_hour: null, members: ['ب'] }),
            standing({ rank: 3, team: 'جنوب 3', reports_count: 11, activity_rate_per_hour: 3.6, members: ['ج'] })
        ], meta: { teams_ranked: 3 }
    };
    const html = BOARD.renderBoard(p, 'today', false);
    check('معدل رقمي يعرض «⚡ 0.55 بلاغ/ساعة»', html.includes('⚡ 0.55 بلاغ/ساعة'));
    check('rate=null يعرض «⚡ —» بلا اختلاق', html.includes('⚡ —'));
    check('كل صف فيه العدد (🚑) والمعدل (⚡) معًا', (html.match(/🚑/g) || []).length >= 3 && (html.match(/⚡/g) || []).length >= 3);
    check('الجمع: 11 بلاغ وليس بلاغات', html.includes('11 بلاغ'));
}

// ─── D.1-UI) عدم التخمين + المركز بسطر مستقل + الأسماء عناصر مستقلة ───
console.log('⑦ب D.1 — العرض: لا تخمين، المركز منفصل، كل اسم عنصر مستقل:');
{
    const inc = BOARD.renderBoard({ standings: [standing({ rank: 1, team: 'جنوب 9', reports_count: 3, members: [], members_incomplete: true })], meta: { teams_ranked: 1 } }, 'current_shift', false);
    check('تعذّر الإثبات ← «⚠️ بيانات طاقم المناوبة غير مكتملة»', inc.includes('⚠️ بيانات طاقم المناوبة غير مكتملة'));
    check('لا يُعرض أي اسم عند عدم الإثبات (لا تخمين)', !inc.includes('crew-board-person'));
    const withCenter = BOARD.renderBoard({ standings: [standing({ rank: 1, team: 'جنوب 1', reports_count: 2, members: ['أحمد الاختبار الطويل بن فلان الفلاني'], center: 'الشفاء' })], meta: { teams_ranked: 1 } }, 'today', false);
    check('المركز في سطر مستقل (📍) وليس ممزوجًا بالأسماء', withCenter.includes('crew-board-center') && withCenter.includes('📍 الشفاء'));
    check('سطر الفرقة لا يحتوي المركز', /<div class="crew-board-team">🥇 جنوب 1<\/div>/.test(withCenter));
    check('الاسم الطويل كاملًا في عنصر مستقل', withCenter.includes('<div class="crew-board-person">👤 أحمد الاختبار الطويل بن فلان الفلاني</div>'));
    const incWeek = BOARD.renderBoard({ standings: [standing({ rank: 1, team: 'جنوب 2', reports_count: 4, members: ['س'], shifts: [{ shift_id: 9, shift_date: '2026-08-18', shift_type: 'صباح', reports_count: 4, members: [], members_incomplete: true }] })], meta: { teams_ranked: 1 } }, 'week', false);
    const incHead = incWeek.slice(0, incWeek.indexOf('<details'));
    check('week: أحدث مناوبة بلا تشكيل مُثبت ← التحذير في البطاقة الرئيسية', incHead.includes('بيانات طاقم المناوبة غير مكتملة'));
}

// ─── 8) صفر «أفضل فرقة» + سطر العدالة دائمًا (صيغة D.1 المعتمدة) ───
console.log('⑧ لغة التحفيز المنضبطة:');
{
    const FAIR = 'الترتيب يعكس النشاط التشغيلي فقط — وليس تقييمًا وظيفيًا';
    const periods = ['current_shift', 'today', 'week', 'month'];
    const sample = { standings: [standing({ rank: 1, team: 'جنوب 7', reports_count: 2, members: ['س'] })], meta: { teams_ranked: 1 } };
    const allFair = periods.every(pp => BOARD.renderBoard(sample, pp, false).includes(FAIR));
    const statesFair = [BOARD.renderNoActiveShift(), BOARD.renderEmptyRace(), BOARD.renderError()].every(h => h.includes(FAIR));
    const noBest = periods.every(pp => !BOARD.renderBoard(sample, pp, false).includes('أفضل فرقة'));
    check('سطر العدالة (صيغة D.1) في كل الفترات', allFair);
    check('سطر العدالة في كل الحالات (404/فارغ/خطأ)', statesFair);
    check('صفر «أفضل فرقة» في المخرجات', noBest);
    check('الصيغة القديمة لسطر العدالة أُزيلت', !BOARD.renderBoard(sample, 'today', false).includes('الترتيب نشاط فقط — وليس تقييم أداء'));
    check('صفر «أفضل فرقة» في ملفات الواجهة (ساكن)', !readFile('public/js/crew-achievement-board.js').includes('أفضل فرقة') && !readFile('public/index.html').includes('أفضل فرقة'));
}

// ─── 9) الربط الساكن ───
console.log('⑨ الربط الساكن (الخطاف العام + المستمعون + لا غطاء):');
{
    const appJs = readFile('public/js/app.js');
    const boardJs = readFile('public/js/crew-achievement-board.js');
    const indexHtml = readFile('public/index.html');
    check('app.js يبث الخطاف العام ops:sse قبل الـswitch', appJs.indexOf("dispatchEvent(new CustomEvent('ops:sse'") !== -1 && appJs.indexOf("dispatchEvent(new CustomEvent('ops:sse'") < appJs.indexOf('switch(data.type)'));
    check("اللوحة تشترك عبر addEventListener('ops:sse') — بلا EventSource جديد", boardJs.includes("addEventListener('ops:sse'") && !boardJs.includes('new EventSource'));
    const evOk = ['new_report', 'report_undone', 'shift_started', 'shift_archived'].every(ev => boardJs.includes("'" + ev + "'"));
    check('الأحداث الأربعة مسجلة في اللوحة', evOk);
    check('index.html يحمّل سكربت اللوحة ويحوي الحاوية', indexHtml.includes('crew-achievement-board.js') && indexHtml.includes('id="crewAchievementBoard"'));
    const cssBlock = (indexHtml.match(/<style id="crew-board-styles">([\s\S]*?)<\/style>/) || [])[1] || '';
    check('الأنماط بلا position:fixed وبلا z-index (لا تغطي تسجيل البلاغ)', cssBlock.length > 0 && !/position\s*:\s*fixed/.test(cssBlock) && !/z-index/.test(cssBlock));
    check('لا polling في اللوحة (لا setInterval)', !boardJs.includes('setInterval'));
}

// ─── 10) RTL/الثيم ───
console.log('⑩ RTL وعزل الأنماط:');
{
    const indexHtml = readFile('public/index.html');
    const m = indexHtml.match(/<style id="crew-board-styles">([\s\S]*?)<\/style>/);
    const cssBlock = m ? m[1] : '';
    const selectors = cssBlock.split('}').map(s => s.split('{')[0].trim()).filter(s => s && !s.startsWith('/*'));
    const allScoped = selectors.length > 0 && selectors.every(s => s.split(',').every(x => x.trim().startsWith('.crew-board')));
    check('كل محددات CSS تبدأ بـ.crew-board (عدد: ' + selectors.length + ')', allScoped);
    check('الألوان الأساسية عبر متغيرات الثيم var(--…)', /background:\s*var\(--/.test(cssBlock) && /color:\s*var\(--/.test(cssBlock));
    check('الحاوية RTL', /id="crewAchievementBoard"[^>]*dir="rtl"/.test(indexHtml));
}

// ─── الخلاصة ───
console.log('\n════════════════════════════════════════');
console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
if (failures.length) {
    console.log('الفاشلات:');
    failures.forEach(f => console.log('  ❌ ' + f));
    process.exit(1);
}
console.log('★ ALL PASS — واجهة إنجاز الفرق مطابقة للمواصفة المعتمدة.');
