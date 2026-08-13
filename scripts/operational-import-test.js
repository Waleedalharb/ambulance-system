/**
 * اختبار قبول الاستيراد الرسمي للأكواد التشغيلية الملحقة — operational-import-test.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * اختبار قبول المالك: «O12-12 لم يعد Unknown ولا يُفقد اليوم».
 *
 * نفس نمط العزل في overlap-codes-test.js / hours-metrics-test.js حرفيًا:
 *   - سلسلة قبول اليوم (حلقة dayCols داخل oiParseOfficial) تُستخرج من
 *     smart-schedule.html الفعلي (regex + عدّ أقواس متزنة) وتُقيَّم في vm —
 *     تُختبر النسخة المنشورة لا نسخة مكررة.
 *   - OI_WORK_DAYCODES تُستخرج بنفس الطريقة، والقاموس الحقيقي يُحمَّل في
 *     sandbox مع حقن المحلل المشترك (نفس أسلوب loadDictionaryWithParser).
 *   - oiNormalize/oiResolveSymbol تُحقنان بنسخة دنيا: التطبيع trim+uppercase
 *     (يكفي للأكواد اللاتينية)، وحل الرمز null (أكواد الأيام ليست رموز وحدات).
 *
 * التشغيل: node scripts/operational-import-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** استخراج كتلة for بعدّ الأقواس المتزنة (نفس أداة hours-metrics-test). */
function extractLoopSource(src, startMarker) {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error(`العلامة غير موجودة: ${startMarker}`);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('أقواس حلقة قبول اليوم غير متزنة');
}

function main() {
    console.log('\n═══ اختبار قبول الاستيراد — الأكواد التشغيلية الملحقة ═══\n');

    const html = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');

    // ── ① استخراج السلسلة الفعلية: قائمة أكواد العمل + حلقة قبول اليوم ──
    const listMatch = html.match(/var OI_WORK_DAYCODES = \[\]\.concat\([\s\S]*?\);/);
    const dayLoop = extractLoopSource(html, 'for (var d = 0; d < dayCols.length; d++)');
    const t1extract = !!listMatch && dayLoop.includes('OI_WORK_DAYCODES.indexOf(dcb)') &&
        dayLoop.includes('unknownSymbols');
    // حارس الإصلاح: السلسلة المستخرجة تستشير المحلل المشترك قبل unknownSymbols
    const fixIdx = dayLoop.indexOf('OperationalCodes.isOperationalCode');
    const unkIdx = dayLoop.indexOf("unknownSymbols.push('يوم:'");
    const t1fix = fixIdx !== -1 && unkIdx !== -1 && fixIdx < unkIdx;
    record('① الاستخراج: حلقة قبول اليوم + OI_WORK_DAYCODES من HTML الفعلي · استشارة المحلل تسبق unknownSymbols',
        t1extract && t1fix, `استخراج=${t1extract} ترتيب_الإصلاح=${t1fix}`);

    // ── ② sandbox: القاموس الحقيقي + المحلل المشترك + السلسلة المستخرجة ──
    const OC = require(path.join(ROOT, 'public', 'js', 'core', 'operational-codes.js'));
    const dictSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'core', 'shift-type-dictionary.js'), 'utf8');
    const sandbox = {
        OperationalCodes: OC,
        window: { OperationalCodes: OC },
        oiNormalize: code => String(code == null ? '' : code).trim().toUpperCase(),
        oiResolveSymbol: () => null // أكواد الأيام ليست رموز وحدات ميدانية
    };
    vm.createContext(sandbox);
    vm.runInContext(dictSrc, sandbox); // ينشر ShiftTypeDictionary ويلتقط المحلل من globalThis
    vm.runInContext(listMatch[0], sandbox); // OI_WORK_DAYCODES الفعلية
    vm.runInContext(
        `this.runDays = function (row, dayCols, out) {\n` +
        `    var days = {}, workDays = 0;\n` +
        dayLoop + `\n` +
        `    return { days: days, workDays: workDays };\n` +
        `};`, sandbox);

    /** محاكاة صف استيراد: كود واحد في يوم واحد ← نتيجة السلسلة الفعلية. */
    function importOne(code, day) {
        const out = { issues: { unknownSymbols: [] }, counts: { restDays: 0, vacations: 0 } };
        const r = sandbox.runDays([code], [{ col: 0, day }], out);
        return { ...r, unknownSymbols: out.issues.unknownSymbols };
    }

    // ── ③ قبول المالك: كل كود تشغيلي ⇒ بلا Unknown + اليوم حاضر + workDays يُحسب ──
    const ACCEPT = ['O12-09', 'O12-12', 'O12-14', 'RRA1-D-04', 'RRA1-N-16', 'RRA1-04', 'RRA1-16'];
    let t3 = true;
    const details = [];
    for (const code of ACCEPT) {
        const r = importOne(code, 12);
        const ok = r.unknownSymbols.length === 0 && r.days[12] === code && r.workDays === 1;
        if (!ok) t3 = false;
        details.push(`${code}: unknown=${r.unknownSymbols.length} يوم=${r.days[12] || 'مفقود'} عمل=${r.workDays}`);
    }
    record('③ قبول المالك: O12-12 + RRA1-D-04/N-16 + القديمة ⇒ unknownSymbols فارغة + اليوم حاضر + workDays يُحسب',
        t3, details.join(' · '));

    // ── ④ ضابطة سلبية: رمز خردة ما زال يُرفض (السلسلة لم تفتح الباب لكل شيء) ──
    const junk = importOne('Q9', 12);
    const t4 = junk.unknownSymbols.length === 1 && junk.unknownSymbols[0] === 'يوم:Q9' &&
        junk.workDays === 0 && !junk.days[12];
    record('④ ضابطة سلبية: Q9 يبقى في unknownSymbols ولا يُحسب يوم عمل',
        t4, `unknown=[${junk.unknownSymbols.join(',')}] عمل=${junk.workDays}`);

    // ── ⑤ صف كامل متعدد الأيام: الأكواد الأربعة محور الاعتماد في صف واحد ──
    const out5 = { issues: { unknownSymbols: [] }, counts: { restDays: 0, vacations: 0 } };
    const r5 = sandbox.runDays(
        ['O12-12', 'RRA1-D-04', 'RRA1-N-16', 'RRA1-04'],
        [{ col: 0, day: 5 }, { col: 1, day: 6 }, { col: 2, day: 7 }, { col: 3, day: 8 }],
        out5);
    const t5 = r5.workDays === 4 && out5.issues.unknownSymbols.length === 0 &&
        r5.days[5] === 'O12-12' && r5.days[6] === 'RRA1-D-04' &&
        r5.days[7] === 'RRA1-N-16' && r5.days[8] === 'RRA1-04';
    record('⑤ صف كامل: الأكواد الأربعة في 4 أيام ⇒ workDays=4 · بلا Unknown · الأيام محفوظة بأكوادها كما وردت',
        t5, `عمل=${r5.workDays} unknown=${out5.issues.unknownSymbols.length} أيام=${JSON.stringify(r5.days)}`);

    // ─── الملخص ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) {
        failed.forEach(f => console.log(`   ❌ ${f.name}`));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات قبول الاستيراد ناجحة\n');
    process.exit(0);
}

main();
