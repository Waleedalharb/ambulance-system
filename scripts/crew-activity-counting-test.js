/**
 * ═══ crew-activity-counting-test.js — توحيد عدّ «نشاط/إنجاز الفرق» (اعتماد المالك 2026-08-26) ═══
 * الخلل: crew-activity-service كان يعدّ COUNT(rt.id) بفلتر manual_cancelled فقط —
 * مسار احتساب ثانٍ لا يمر بـ isParticipationCounted، فعرض تبويب «شهر» الأرقام
 * الملوثة القديمة (سريع 2=32 · جنوب 8=17) رغم إصلاح d11b05a.
 * الإصلاح: العدّ يمر عبر ReportService.isParticipationCounted حصرًا (لا شروط SQL
 * مستقلة): legacy_snapshot/withdrawn/manual_cancelled/وحدات الخطة كلها مستبعدة
 * من المصدر المركزي — ولا حذف ولا تعديل لأي سجل تاريخي.
 *
 * ملاحظة تصميمية للاختبار: استجابة الخدمة/الـAPI مقصوصة بـtop ∈ {3,5} (TOPS
 * في الخدمة)، فلا تظهر كل الفرق في standings. لذلك تُفحص القيم الدقيقة لكل
 * الفرق عبر «غلاف عدّ» يلتف على isParticipationCounted فيلتقط كل صف تحتسبه
 * الخدمة فعليًا (قبل القصّ) — فيثبت التطابق الكامل مع المحاكاة المستقلة،
 * بينما يبقى فحص مستوى API للظاهر من standings + meta.teams_ranked.
 *
 * يعمل على نسخة VACUUM معزولة من قاعدة الإنتاج (قراءة بلا أي تعديل):
 *   قسم أ — مستوى الخدمة: شهر = سريع 2:4 · جنوب 8:2 · Σ=50 + تطابق حرفي كامل
 *            لجميع الفرق مع محاكاة مستقلة + المناوبة الحالية (جنوب 8=2 · Σ=31)
 *   قسم ب — الاختبار العكسي: مشاركات مناوبة 183 بهوية CAD وJourney تبقى محتسبة
 *   قسم ج — legacy_snapshot: محفوظة في القاعدة (149 · لجنوب 8 منها 15) ولا تدخل النشاط
 *   قسم د — مستوى API على خادم معزول: لا رقم ملوث (≤6) والظاهر يطابق المحاكاة
 *   قسم هـ — إثبات بنيوي: الخدمة تستدعي القاعدة المركزية ولا تحمل COUNT مستقلًا
 * التشغيل: node scripts/crew-activity-counting-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'crew-act-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const CUT = '2026-08-23 13:00:00';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 240) : '')); }
}

/* نفس canonicalTeam في الخدمة — لتوحيد مفاتيح المقارنة بين المحاكاة والغلاف */
function canonicalTeam(teamId) {
    if (teamId == null) return null;
    let t = String(teamId).trim();
    const arabicToWestern = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
    t = t.split('').map(c => arabicToWestern[c] || c).join('');
    const rapid = t.match(/^(?:rapid_|تدخل سريع\s*)(\d+)$/);
    if (rapid) return 'سريع ' + parseInt(rapid[1], 10);
    return t;
}

/* محاكاة مستقلة للقاعدة (للتحقق المتقاطع — الخدمة نفسها تستدعي القاعدة الحقيقية) */
function legacySnap(x) {
    if (!x.report_created_at || String(x.report_created_at) >= CUT) return false;
    if (x.cad_unit_id != null || x.cad_run_unit_id != null || x.cad_unit_status != null) return false;
    let ph = null; try { ph = JSON.parse(x.phases); } catch (_) { }
    return ph && Object.keys(ph).some(k => !!ph[k]);
}
function countedInd(x) {
    if (x.withdrawn || x.manual_cancelled) return false;
    if (legacySnap(x)) return false;
    let ph = null; try { ph = JSON.parse(x.phases); } catch (_) { }
    if (!ph) return true;
    return !!ph['التحرك'];
}
const sumOf = (m) => Object.values(m).reduce((a, b) => a + b, 0);
const eqMap = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => b[k] === a[k]);
};

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    /* تجهيز الخدمة بمحرك وهمي فوق النسخة المعزولة + القاعدة المركزية الحقيقية */
    const ReportService = require(path.join(ROOT, 'services', 'report-service.js'));
    const CrewActivityService = require(path.join(ROOT, 'services', 'crew-activity-service.js'));
    const TimeRiyadh = require(path.join(ROOT, 'public', 'js', 'time-riyadh.js'));
    const db = new Database(TMP_DB, { readonly: true });
    const storage = { all: (sql, params) => Promise.resolve(db.prepare(sql).all(...(params || []))) };
    const engine = { storage };
    const reportService = Object.create(ReportService.prototype); // isParticipationCounted نقية بلا حالة
    const svc = new CrewActivityService({ engine });

    /* غلاف العدّ: يلتقط كل صف تعتبره الخدمة مشاركة محتسبة (قبل قصّ top) —
       فيعطينا عدّ الخدمة الكامل لكل الفرق، لا الظاهر منها فقط */
    const makeCounter = () => {
        const counts = {}; // 'shiftId|team' → n
        svc.reportService = {
            isParticipationCounted: (r) => {
                const ok = reportService.isParticipationCounted(r);
                if (ok) {
                    const t = canonicalTeam(r.unit);
                    if (t) counts[r.shift_id + '|' + t] = (counts[r.shift_id + '|' + t] || 0) + 1;
                }
                return ok;
            }
        };
        return counts;
    };
    const byTeam = (counts) => {
        const m = {};
        for (const k of Object.keys(counts)) {
            const team = k.split('|')[1];
            m[team] = (m[team] || 0) + counts[k];
        }
        return m;
    };

    /* التجميع المتوقع مستقلًا من القاعدة نفسها (بنفس حقول استعلام الخدمة) */
    const expectedFor = (shiftIds) => {
        if (!shiftIds.length) return {};
        const rows = db.prepare(
            `SELECT r.shift_id, r.unit, r.created_at AS report_created_at, rt.id, rt.phases, rt.withdrawn, rt.manual_cancelled,
                    rt.cad_unit_id, rt.cad_run_unit_id, rt.cad_unit_status
             FROM reports r JOIN report_times rt ON rt.report_id = r.id
             WHERE r.shift_id IN (${shiftIds.map(() => '?').join(',')})`).all(...shiftIds);
        const by = {};
        for (const x of rows) if (countedInd(x)) {
            const t = canonicalTeam(x.unit);
            if (t) by[t] = (by[t] || 0) + 1;
        }
        return by;
    };

    /* نطاقات الفترات كما تحسبها الخدمة (اليوم الجداري بتوقيت الرياض) */
    const today = TimeRiyadh.formatDate(new Date());
    const monthFrom = today.slice(0, 8) + '01', monthTo = today.slice(0, 8) + '31';
    const wd = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10))).getUTCDay();
    const weekFromD = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - wd * 86400000);
    const weekFrom = weekFromD.toISOString().slice(0, 10);
    const weekTo = new Date(weekFromD.getTime() + 6 * 86400000).toISOString().slice(0, 10);

    console.log('🧪 توحيد عدّ نشاط/إنجاز الفرق — قاعدة isParticipationCounted الواحدة\n');

    /* ── قسم أ: الشهر الحالي — الأرقام المعتمدة من المالك ── */
    const monthShifts = db.prepare('SELECT id FROM shifts WHERE shift_date>=? AND shift_date<=?').all(monthFrom, monthTo).map(r => r.id);
    const expMonth = expectedFor(monthShifts);
    let counts = makeCounter();
    const resMonth = await svc.getActivity({ scope: 'south', period: 'month', top: 5 });
    const monthSvc = byTeam(counts); // عدّ الخدمة الكامل لكل الفرق (قبل قصّ top)
    check('أ1 شهر: قمة العدّ الظاهر ≤ 6 (كان سريع 2=32 وجنوب 8=17 قبل الإصلاح)',
        (resMonth.standings || []).every(t => t.reports_count <= 6),
        JSON.stringify((resMonth.standings || []).map(t => t.team + '=' + t.reports_count)));
    check('أ2 شهر: سريع 2 = 4 وجنوب 8 = 2 (نقاط المالك) — عدّ الخدمة الكامل عبر الغلاف',
        (monthSvc['سريع 2'] || 0) === 4 && (monthSvc['جنوب 8'] || 0) === 2,
        JSON.stringify({ s2: monthSvc['سريع 2'], j8: monthSvc['جنوب 8'] }));
    check('أ3 شهر: الإجمالي الكلي = 50 (كان 202 بشروط SQL القديمة)',
        sumOf(expMonth) === 50, 'Σ=' + sumOf(expMonth));
    check('أ4 شهر: عدّ الخدمة الكامل يطابق المحاكاة المستقلة حرفيًا لجميع الفرق',
        eqMap(monthSvc, expMonth),
        JSON.stringify({ svc: monthSvc, exp: expMonth }));
    check('أ5 شهر: meta.teams_ranked = عدد فرق المحاكاة (لا فريق مخفي بقيمة مختلفة)',
        (resMonth.meta || {}).teams_ranked === Object.keys(expMonth).length,
        JSON.stringify({ ranked: (resMonth.meta || {}).teams_ranked, exp: Object.keys(expMonth).length }));

    /* ── قسم أ2: المناوبة الحالية — جنوب 8 = 2 · الإجمالي 31 ── */
    const activeShift = db.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    const expCur = activeShift ? expectedFor([activeShift.id]) : {};
    counts = makeCounter();
    let curSvc = {};
    try {
        await svc.getActivity({ scope: 'south', period: 'current_shift', top: 5 });
        curSvc = byTeam(counts);
    } catch (_) { /* لا مناوبة نشطة في النسخة */ }
    check('أ6 المناوبة الحالية: عدّ الخدمة يطابق المحاكاة وجنوب 8 = 2 والإجمالي = 31',
        eqMap(curSvc, expCur) && (expCur['جنوب 8'] || 0) === 2 && sumOf(expCur) === 31,
        JSON.stringify({ svc: curSvc, exp: expCur, Σ: sumOf(expCur) }));

    /* ── قسم ب: الاختبار العكسي — مشاركة شرعية بهوية CAD تبقى محتسبة ── */
    const weekShifts = db.prepare('SELECT id FROM shifts WHERE shift_date>=? AND shift_date<=?').all(weekFrom, weekTo).map(r => r.id);
    const expWeek = expectedFor(weekShifts);
    check('ب1 عكسي: مناوبة 183 (2026-08-23 صباحًا — بهوية CAD) جنوب 6 = 2 محتسبتان',
        (expWeek['جنوب 6'] || 0) >= 2, JSON.stringify({ j6: expWeek['جنوب 6'] }));
    counts = makeCounter();
    await svc.getActivity({ scope: 'south', period: 'week', top: 5 });
    const weekSvc = byTeam(counts);
    check('ب2 عكسي: عدّ الخدمة للأسبوع يطابق المحاكاة كاملًا (الشرعية القديمة بهوية CAD لم تُستبعد)',
        eqMap(weekSvc, expWeek),
        JSON.stringify({ svc: weekSvc, exp: expWeek }));

    /* ── قسم ج: legacy_snapshot محفوظة ولا تدخل النشاط ── */
    const legacyCount = db.prepare(
        `SELECT COUNT(*) AS c FROM report_times rt JOIN reports r ON r.id=rt.report_id
         WHERE r.created_at < ? AND rt.cad_unit_id IS NULL AND rt.cad_run_unit_id IS NULL AND rt.cad_unit_status IS NULL
           AND rt.phases IS NOT NULL AND rt.phases NOT IN ('{}','null')
           AND COALESCE(rt.withdrawn,0)=0 AND COALESCE(rt.manual_cancelled,0)=0`).get(CUT).c;
    check('ج1 الـ149 legacy محفوظة في القاعدة (لا حذف)', legacyCount === 149, 'c=' + legacyCount);
    const legacyJ8 = db.prepare(
        `SELECT COUNT(*) AS c FROM report_times rt JOIN reports r ON r.id=rt.report_id
         WHERE r.created_at < ? AND rt.cad_unit_id IS NULL AND rt.cad_run_unit_id IS NULL AND rt.cad_unit_status IS NULL
           AND rt.phases IS NOT NULL AND rt.phases NOT IN ('{}','null')
           AND COALESCE(rt.withdrawn,0)=0 AND COALESCE(rt.manual_cancelled,0)=0 AND r.unit='جنوب 8'`).get(CUT).c;
    check('ج2 جنوب 8: الـ15 legacy لها محفوظة، وعدّ نشاطها الشهري = 2 فقط (مستبعدة لا محذوفة)',
        legacyJ8 === 15 && (monthSvc['جنوب 8'] || 0) === 2,
        JSON.stringify({ legacyJ8, monthJ8: monthSvc['جنوب 8'] }));

    /* ── قسم هـ: إثبات بنيوي — لا COUNT مستقل والخدمة تستدعي القاعدة المركزية ── */
    const svcSrc = fs.readFileSync(path.join(ROOT, 'services', 'crew-activity-service.js'), 'utf8');
    check('هـ1 الخدمة تستدعي isParticipationCounted المركزية', svcSrc.includes('isParticipationCounted'));
    check('هـ2 لا COUNT(rt.id) ولا فلتر احتساب مستقل في SQL الخدمة',
        !/COUNT\s*\(\s*rt\.id\s*\)/.test(svcSrc) && !svcSrc.includes("COALESCE(rt.manual_cancelled, 0) = 0\n                 GROUP BY"),
        'فحص نصي للمصدر');
    check('هـ3 ربط reportService في server.js بعد إنشائه (لا عدّ بلا القاعدة الواحدة)',
        fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').includes('crewActivityService.reportService = reportService'));

    /* ── قسم د: مستوى API — خادم معزول كامل ── */
    db.close();
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }
    try {
        const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: '4252', password: '4252' }) }).then(r => r.json());
        const TK = login.accessToken;
        const act = await fetch(BASE + '/api/crew-performance/activity?period=month&top=5', { headers: { Authorization: 'Bearer ' + TK } }).then(r => r.json());
        check('د1 API شهر: لا فريق يتجاوز 6 بلاغات (الأرقام الملوثة 32/17 اختفت من اللوحة)',
            (act.standings || []).every(t => t.reports_count <= 6),
            JSON.stringify((act.standings || []).map(t => t.team + '=' + t.reports_count)));
        const visibleOk = (act.standings || []).every(t => expMonth[t.team] === t.reports_count);
        check('د2 API شهر: كل فريق ظاهر يطابق المحاكاة حرفيًا، وسريع 2 الظاهر = 4، وteams_ranked مطابق',
            visibleOk && (act.standings || []).some(t => t.team === 'سريع 2' && t.reports_count === 4)
            && (act.meta || {}).teams_ranked === Object.keys(expMonth).length,
            JSON.stringify({ got: (act.standings || []).map(t => t.team + '=' + t.reports_count), ranked: (act.meta || {}).teams_ranked }));
        check('د3 API شهر: جنوب 8 إن ظهرت فبقيمة 2 لا 17 (خارج top-5 مقبول — أثبتته أ2 عبر الغلاف)',
            !(act.standings || []).some(t => t.team === 'جنوب 8' && t.reports_count !== 2),
            JSON.stringify((act.standings || []).map(t => t.team + '=' + t.reports_count)));
        const actCur = await fetch(BASE + '/api/crew-performance/activity?period=current_shift&top=5', { headers: { Authorization: 'Bearer ' + TK } }).then(r => r.json());
        check('د4 API المناوبة الحالية: كل فريق ظاهر يطابق المحاكاة، وجنوب 8 إن ظهرت فبقيمة 2',
            (actCur.standings || []).every(t => expCur[t.team] === t.reports_count)
            && !(actCur.standings || []).some(t => t.team === 'جنوب 8' && t.reports_count !== 2),
            JSON.stringify((actCur.standings || []).map(t => t.team + '=' + t.reports_count)));
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n═══ النتيجة الإجمالية: ' + passed + ' ✅ / ' + failed + ' ❌ ═══');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); }
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('💥 خطأ غير متوقع:', e); process.exit(1); });
