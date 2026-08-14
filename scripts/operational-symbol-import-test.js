/**
 * اختبار مسار رمز الموظف للأكواد التشغيلية — operational-symbol-import-test.js
 * ═══════════════════════════════════════════════════════════════════════════════
 * فجوة 2026-08-14: O12-09/12/14 تصل كرمز موظف في عمود «رمز» (وليس فقط كود يوم).
 * اعتماد المالك: تُقبل كرموز Overlap تشغيلية (kind=overlap · هوية O12 · البداية
 * من اللاحقة) دون استبعاد الموظف من الاستيراد، وبلا تحويل إلى O12A12.
 *
 * نفس نمط operational-import-test.js: مقطع حل الرمز يُستخرج من smart-schedule.html
 * الفعلي ويُقيَّم في vm مع القاموس الحقيقي — تُختبر النسخة المنشورة لا نسخة مكررة.
 * التكييف الوحيد الموثق: continue ⇒ return null (المقطع يعيش داخل حلقة الصفوف).
 *
 * التشغيل: node scripts/operational-symbol-import-test.js   (خروج غير صفري عند أي فشل)
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

/** استخراج كتلة if بعدّ الأقواس المتزنة من نقطة بداية معطاة. */
function extractBalanced(src, startIdx) {
    const braceStart = src.indexOf('{', startIdx);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return i + 1;
        }
    }
    throw new Error('أقواس غير متزنة في مقطع حل الرمز');
}

function main() {
    console.log('\n═══ اختبار مسار رمز الموظف — الأكواد التشغيلية (O12-09/12/14) ═══\n');

    const html = fs.readFileSync(path.join(ROOT, 'public', 'smart-schedule.html'), 'utf8');

    // ── ① استخراج مقطع حل الرمز الفعلي: من resolveSymbol حتى نهاية فرع الرفض ──
    const startMarker = 'var resolved = oiResolveSymbol(rawSym, job);';
    const start = html.indexOf(startMarker);
    const rejectIdx = html.indexOf('if (!resolved) {', start); // فرع الرفض (بلا &&)
    const t1a = start !== -1 && rejectIdx !== -1;
    const snippet = t1a ? html.slice(start, extractBalanced(html, rejectIdx)) : '';
    const fixIdx = snippet.indexOf('OperationalCodes.parseOperationalCode');
    const unkIdx = snippet.indexOf('unknownSymbols.push');
    const t1b = fixIdx !== -1 && unkIdx !== -1 && fixIdx < unkIdx;
    record('① الاستخراج: مقطع حل الرمز من HTML الفعلي · فرع المحلل المركزي يسبق unknownSymbols',
        t1a && t1b, `استخراج=${t1a} ترتيب_الإصلاح=${t1b}`);

    // ── ② sandbox: قاموس الرموز الحقيقي + المحلل المركزي الحقيقي ──
    const SD = require(path.join(ROOT, 'public', 'js', 'core', 'symbol-dictionary.js'));
    const OC = require(path.join(ROOT, 'public', 'js', 'core', 'operational-codes.js'));
    function makeSandbox(withOC) {
        const sandbox = {
            oiNormalize: code => SD.normalize(code),
            oiResolveSymbol: (sym, job) => SD.resolveSymbol(sym, job),
            window: withOC ? { OperationalCodes: OC } : {},
            OperationalCodes: withOC ? OC : undefined
        };
        vm.createContext(sandbox);
        // التكييف الموثق الوحيد: continue ⇒ return null (خارج الحلقة في المختبر)
        vm.runInContext(
            `this.resolveEmployeeSymbol = function (rawSym, job, empCode, name, out) {\n` +
            snippet.replace(/continue;/g, 'return null;') + `\n` +
            `    return resolved;\n` +
            `};`, sandbox);
        return sandbox;
    }
    function trySymbol(sandbox, sym) {
        const out = { issues: { unknownSymbols: [], noSymbol: [] } };
        const resolved = sandbox.resolveEmployeeSymbol(sym, 'مسعف', '999', 'اختبار', out);
        return { resolved, unknown: out.issues.unknownSymbols };
    }

    // ── ③ قبول المالك: الرموز الثلاثة كرمز موظف — بلا Unknown وبلا استبعاد ──
    const ACCEPT = { 'O12-09': '09:00', 'O12-12': '12:00', 'O12-14': '14:00' };
    const sb = makeSandbox(true);
    let t3 = true;
    const det3 = [];
    for (const [code, startWanted] of Object.entries(ACCEPT)) {
        const r = trySymbol(sb, code);
        const ok = r.resolved && r.resolved.kind === 'overlap' &&
            r.resolved.team === 'أوفرلاب O12' && r.resolved.opStart === startWanted &&
            r.resolved.opCode === code && r.unknown.length === 0;
        if (!ok) t3 = false;
        det3.push(`${code}: ${r.resolved ? `overlap/${r.resolved.team}/بداية=${r.resolved.opStart}` : 'مرفوض'} unknown=${r.unknown.length}`);
    }
    record('③ قبول المالك: O12-09/12/14 كرمز موظف ⇒ overlap · هوية أوفرلاب O12 · البداية من اللاحقة · بلا Unknown',
        t3, det3.join(' · '));

    // ── ④ ضابطة سلبية 1: رمز خردة يبقى مرفوضًا ويُحصى ──
    const junk = trySymbol(sb, 'Q9');
    const t4 = junk.resolved === null && junk.unknown.length === 1 && junk.unknown[0] === 'Q9';
    record('④ ضابطة سلبية: Q9 كرمز موظف يبقى مرفوضًا في unknownSymbols',
        t4, `resolved=${junk.resolved} unknown=[${junk.unknown.join(',')}]`);

    // ── ⑤ ضابطة سلبية 2: التدخل السريع الملحق ليس رمز موظف (قرار RRA: يُعرف من الفرقة) ──
    const rra = trySymbol(sb, 'RRA1-D-04');
    const t5 = rra.resolved === null && rra.unknown.length === 1 && rra.unknown[0] === 'RRA1-D-04';
    record('⑤ RRA1-D-04 في عمود الرمز يبقى مرفوضًا — التدخل السريع لا يكون رمز موظف',
        t5, `resolved=${rra.resolved} unknown=[${rra.unknown.join(',')}]`);

    // ── ⑥ الذهبي: الرموز العادية القديمة لم تتأثر (بوجود المحلل وبدونه نتيجة واحدة) ──
    const sbNoOC = makeSandbox(false);
    const CLASSIC = [
        ['A1', 'center', 'جنوب 1'],
        ['O12', 'overlap', 'أوفرلاب O12'],
        ['O12A12', 'overlap', 'جنوب 12'],
        ['RRA1', 'rapid', 'سريع 1']
    ];
    let t6 = true;
    const det6 = [];
    for (const [sym, kind, team] of CLASSIC) {
        const withOC = trySymbol(sb, sym);
        const noOC = trySymbol(sbNoOC, sym);
        const ok = withOC.resolved && noOC.resolved &&
            withOC.resolved.kind === kind && withOC.resolved.team === team &&
            withOC.resolved.opStart === undefined && // الرموز القديمة لا تكسب بداية ملحقة
            JSON.stringify(withOC.resolved) === JSON.stringify(noOC.resolved) &&
            withOC.unknown.length === 0;
        if (!ok) t6 = false;
        det6.push(`${sym}:${withOC.resolved ? withOC.resolved.kind + '/' + withOC.resolved.team : 'مرفوض'}`);
    }
    record('⑥ الذهبي: A1/O12/O12A12/RRA1 بنفس النتيجة حرفيًا بوجود المحلل وبدونه — resolveSymbol لم يُمس',
        t6, det6.join(' · '));

    // ── ⑦ الرمز يُحفظ كما ورد: oiNormalize يمرر O12-12 للتخزين (employees.symbol) ──
    const t7 = sb.oiNormalize('O12-12') === 'O12-12' && sb.oiNormalize('o12-12 ') === 'O12-12';
    record('⑦ الرمز يُحفظ كما هو (O12-12) — بداية التشغيل تبقى قابلة للقراءة من اللاحقة سيرفريًا',
        t7, `normalize('O12-12')=${sb.oiNormalize('O12-12')}`);

    // ─── الملخص ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) {
        failed.forEach(f => console.log(`   ❌ ${f.name}`));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات مسار رمز الموظف ناجحة\n');
    process.exit(0);
}

main();
