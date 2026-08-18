/**
 * ═══ اختبار محرك نشاط الفرق — crew-activity-test.js (Phase B) ═══
 * (قرار المالك 2026-08-18) يثبت على خادم معزول (VACUUM INTO + DATA_DIR مؤقت):
 *  1) البلاغ يُحسب مرة واحدة          2) التراجع يزيل الأثر
 *  3) عزل الفرق                        4) عزل المناوبات (current_shift)
 *  5) ★ قاعدة الأسماء الذهبية: نفس الفرقة × مناوبتان × أسماء مختلفة — كل
 *     مناوبة تعرض أسماءها، ولا اسم قديم بجانب إنجاز جديد إطلاقًا
 *  6) عزل اليوم/الأسبوع/الشهر          7) استبعاد الفرق غير العاملة/بلا بلاغات
 *  8) اتساق التفصيل مع الإجمالي        9) scope غير مدعوم ← 400
 * 10) الأداء ضمن العتبة               11) قاعدة الترتيب الثابتة (rate ← count ← الاسم)
 * 12) التسمية «الأكثر نشاطًا» ولا «أفضل فرقة» في أي حقل
 * D.1) ★ التكميل هو المرجع الوحيد (قرار المالك 2026-08-18): أسماء اللوحة =
 *      effectiveRoster من اشتقاق التكميل لنفس shift+team ونفس اللحظة — الغائب
 *      والداعم/المفعَّل المنتهي لا يظهران، والمفتوح يظهر، وبلا تشكيل مُثبت
 *      ← members_incomplete بلا أسماء مختلقة.
 * التشغيل: node scripts/crew-activity-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'crewact-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'crewact-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

// ─── تقويم الرياض (مطابق للخدمة) ───
function riyadhToday() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function dateAdd(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    // ═══ البذر المباشر في النسخة المعزولة (لا يمس الأصلية إطلاقًا) ═══
    const db = new Database(TMP_DB);
    const today = riyadhToday();
    const yesterday = dateAdd(today, -1);
    const oldMonth = '2026-01-15'; // خارج اليوم/الأسبوع/الشهر الحالي
    const B = STAMP; // بادئة معرفات فريدة

    function seedShift(id, date, startZ, endZ) {
        db.prepare(`INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, shift_day, start_time, end_time, total_reports, status)
                    VALUES (?, ?, ?, '07:00', 'صباح', 'اختبار', ?, ?, 0, 'archived')`)
            .run(id, 'مناوبة اختبار ' + date, date, startZ, endZ);
    }
    function seedReports(shiftId, unit, n, baseTs) {
        const rid = db.prepare(`INSERT INTO reports (center, unit, count, shift_id, created_at) VALUES ('الشفاء', ?, ?, ?, ?)`)
            .run(unit, n, shiftId, baseTs).lastInsertRowid;
        for (let i = 0; i < n; i++) {
            db.prepare(`INSERT INTO report_times (report_id, timestamp, type) VALUES (?, ?, 'إصابة')`)
                .run(rid, new Date(new Date(baseTs).getTime() + i * 60000).toISOString());
        }
    }
    function seedMembers(shiftId, date, team, names, baseTs) {
        for (const nm of names) {
            db.prepare(`INSERT INTO operational_events (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, event_type, actor_id, actor_name, created_at)
                        VALUES (?, ?, 'صباح', 'staffing', ?, ?, ?, 'activation', 'seed', 'seed', ?)`)
                .run(shiftId, date, nm, nm, team, baseTs);
        }
    }
    function seedStatus(shiftId, date, team, eventType, atZ) {
        db.prepare(`INSERT INTO operational_events (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, event_type, actor_id, actor_name, created_at)
                    VALUES (?, ?, 'صباح', 'staffing', NULL, NULL, ?, ?, 'seed', 'seed', ?)`)
            .run(shiftId, date, team, eventType, atZ);
    }

    // مناوبة اليوم (8 ساعات: 04:00Z ← 12:00Z) — سيناريو الترتيب + الأسماء الجديدة
    const S_TODAY = B + 1;
    const T0 = today + 'T04:00:00.000Z';
    const plus = (min) => new Date(new Date(T0).getTime() + min * 60000).toISOString();
    seedShift(S_TODAY, today, T0, plus(480));
    // «اختبار أ»: 2 بلاغ، بلا أحداث حالة → active=480 (estimated) → rate 0.25
    seedReports(S_TODAY, 'اختبار أ', 2, plus(60));
    seedMembers(S_TODAY, today, 'اختبار أ', ['فرد أول أ', 'فرد ثان أ'], T0);
    // «اختبار ب»: 1 بلاغ، missing 240د → active=240 → rate 0.25 (تعادل rate مع أ، يخسر بالعدد)
    seedReports(S_TODAY, 'اختبار ب', 1, plus(30));
    seedMembers(S_TODAY, today, 'اختبار ب', ['فرد أول ب'], T0);
    seedStatus(S_TODAY, today, 'اختبار ب', 'missing', T0);
    seedStatus(S_TODAY, today, 'اختبار ب', 'ready', plus(240));
    // «اختبار ج»: مطابق لـ«ب» تمامًا → تعادل كامل ← الاسم الأبجدي يحسم (ب قبل ج)
    seedReports(S_TODAY, 'اختبار ج', 1, plus(35));
    seedMembers(S_TODAY, today, 'اختبار ج', ['فرد أول ج'], T0);
    seedStatus(S_TODAY, today, 'اختبار ج', 'missing', T0);
    seedStatus(S_TODAY, today, 'اختبار ج', 'ready', plus(240));
    // «اختبار د»: 1 بلاغ، missing 120د → active=360 → rate 0.167 (الأدنى)
    seedReports(S_TODAY, 'اختبار د', 1, plus(40));
    seedMembers(S_TODAY, today, 'اختبار د', ['فرد أول د'], T0);
    seedStatus(S_TODAY, today, 'اختبار د', 'missing', T0);
    seedStatus(S_TODAY, today, 'اختبار د', 'ready', plus(120));
    // «اختبار هـ»: أحداث أفراد بلا بلاغات → عاملة بلا بلاغات (خارج standings)
    seedMembers(S_TODAY, today, 'اختبار هـ', ['فرد أول هـ'], T0);
    // جنوب 7 اليوم: أسماء المناوبة الجديدة + بلاغان
    seedReports(S_TODAY, 'جنوب 7', 2, plus(70));
    seedMembers(S_TODAY, today, 'جنوب 7', ['محمد اختبار اليوم', 'فهد اختبار اليوم'], T0);

    // مناوبة أمس — جنوب 7 بأسماء مختلفة تمامًا + 3 بلاغات (قاعدة الأسماء الذهبية)
    const S_YST = B + 2;
    const Y0 = yesterday + 'T04:00:00.000Z';
    const yplus = (min) => new Date(new Date(Y0).getTime() + min * 60000).toISOString();
    seedShift(S_YST, yesterday, Y0, yplus(480));
    seedReports(S_YST, 'جنوب 7', 3, yplus(50));
    seedMembers(S_YST, yesterday, 'جنوب 7', ['خالد اختبار الأمس', 'سعد اختبار الأمس'], Y0);

    // مناوبة قديمة (يناير) — جنوب 7 بأسماء قديمة + 5 بلاغات: يجب ألا تظهر اليوم/الأسبوع/الشهر
    const S_OLD = B + 3;
    const O0 = oldMonth + 'T04:00:00.000Z';
    const oplus = (min) => new Date(new Date(O0).getTime() + min * 60000).toISOString();
    seedShift(S_OLD, oldMonth, O0, oplus(480));
    seedReports(S_OLD, 'جنوب 7', 5, oplus(50));
    seedMembers(S_OLD, oldMonth, 'جنوب 7', ['اسم قديم واحد', 'اسم قديم اثنان'], O0);

    // ═══ D.1: سيناريو جنوب 8 الكامل على المناوبة النشطة (مرجعية التكميل) ═══
    // المناوبة النشطة في اللقطة (1784126563174 — 2026-08-13) بلا بلاغات إطلاقًا،
    // فلا يزاحم البذرُ اختبارَ الترتيب (today) ولا الفترات. غائب أساسي + داعم
    // مفتوح + داعم منتهٍ + مفعَّل منتهٍ + مفعَّل مفتوح — اللوحة يجب أن تعرض
    // التشكيل الفعلي فقط (ما يثبته اشتقاق التكميل لنفس shift_id).
    const ACTIVE_SID = 1784126563174;
    const ACTIVE_DATE = '2026-08-13';
    function seedEvent(shiftId, date, team, name, type, atZ) {
        db.prepare(`INSERT INTO operational_events (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, event_type, actor_id, actor_name, created_at)
                    VALUES (?, ?, 'صباح', 'staffing', ?, ?, ?, ?, 'seed', 'seed', ?)`)
            .run(shiftId, date, name, name, team, type, atZ);
    }
    const g8roster = db.prepare(`SELECT e.name AS name FROM shift_roster sr JOIN teams t ON t.id = sr.team_id JOIN employees e ON e.id = sr.employee_id WHERE sr.shift_date = ? AND t.name = 'جنوب 8' LIMIT 1`).get(ACTIVE_DATE);
    const ABSENT_G8 = g8roster ? g8roster.name : null;
    const A0 = ACTIVE_DATE + 'T05:00:00.000Z';
    const aplus = (min) => new Date(new Date(A0).getTime() + min * 60000).toISOString();
    seedReports(ACTIVE_SID, 'جنوب 8', 6, aplus(90));
    if (ABSENT_G8) seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', ABSENT_G8, 'absence', aplus(5));
    seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', 'داعم اختبار مفتوح', 'external_support', aplus(10));
    seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', 'داعم اختبار منتهي', 'external_support', aplus(12));
    seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', 'داعم اختبار منتهي', 'support_end', aplus(200));
    seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', 'مفعل اختبار منتهي', 'activation', aplus(14));
    seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', 'مفعل اختبار منتهي', 'activation_end', aplus(210));
    seedEvent(ACTIVE_SID, ACTIVE_DATE, 'جنوب 8', 'مفعل اختبار مفتوح', 'activation', aplus(16));
    db.close();

    console.log('🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    if (!(await waitReady())) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        if (!login.data || !login.data.accessToken) { console.error('❌ تعذر تسجيل الدخول'); throw new Error('login'); }
        const TK = login.data.accessToken;
        const act = (p) => api('/api/crew-performance/activity' + p, { token: TK });

        // ── 0) الحماية والعقد ──
        console.log('\n🛡️ العقد والحماية:');
        const noAuth = await api('/api/crew-performance/activity');
        check('بلا توكن ← 401', noAuth.status === 401);
        const badScope = await act('?scope=north');
        check('scope=north ← 400 (لا تسرب بين القطاعات)', badScope.status === 400);
        const badPeriod = await act('?period=year');
        check('period غير صالحة ← 400', badPeriod.status === 400);

        // ── 1-4) السلوك الحي عبر API على المناوبة النشطة ──
        console.log('\n🔴 المناوبة الحالية (حي عبر API):');
        const base = await act('?period=current_shift&top=5');
        check('current_shift يرد 200 بعقد صحيح', base.status === 200 && base.data.label === 'الأكثر نشاطًا' && Array.isArray(base.data.standings), 'status=' + base.status);
        const baseG1 = (base.data.standings.find(t => t.team === 'جنوب 1') || {}).reports_count || 0;

        await api('/api/report', { method: 'POST', token: TK, body: { center: 'الشفاء', unit: 'جنوب 1' } });
        const afterAdd = await act('?period=current_shift&top=5');
        const addG1 = (afterAdd.data.standings.find(t => t.team === 'جنوب 1') || {}).reports_count || 0;
        check('① البلاغ يُحسب مرة واحدة بالضبط (+1)', addG1 === baseG1 + 1, baseG1 + '→' + addG1);
        const addG3 = (afterAdd.data.standings.find(t => t.team === 'جنوب 3') || {}).reports_count || 0;
        const baseG3 = (base.data.standings.find(t => t.team === 'جنوب 3') || {}).reports_count || 0;
        check('③ عزل الفرق: بلاغ جنوب 1 لا يظهر في جنوب 3', addG3 === baseG3);

        await api('/api/undo', { method: 'POST', token: TK, body: { center: 'الشفاء', unit: 'جنوب 1' } });
        const afterUndo = await act('?period=current_shift&top=5');
        const undoG1 = (afterUndo.data.standings.find(t => t.team === 'جنوب 1') || {}).reports_count || 0;
        check('② التراجع يزيل الأثر فورًا', undoG1 === baseG1, undoG1 + ' vs ' + baseG1);

        // المناوبة النشطة في النسخة بتاريخ قديم (2026-08-13) — بلاغها الحي لا يدخل اليوم
        const todayRes = await act('?period=today&top=5');
        const todayHasG1Live = todayRes.data.standings.some(t => t.team === 'جنوب 1');
        check('④ عزل المناوبات: بلاغ المناوبة النشطة القديمة التاريخ لا يدخل today', !todayHasG1Live);

        // ── 5) ★ قاعدة الأسماء الذهبية — D.1: التكميل هو المرجع الوحيد ──
        console.log('\n🏆 قاعدة الأسماء الذهبية (D.1: التكميل = الإنجاز):');
        // مرجع التكميل لنفس shift+team وبنفس اللحظة — عبر نفس الاشتقاق الذي
        // تستهلكه شاشة التكميل (/api/staffing/state ← deriveTeamReadiness)
        async function expectedCrew(date, team) {
            const r = await api('/api/staffing/state?date=' + encodeURIComponent(date) + '&type=' + encodeURIComponent('صباح'), { token: TK });
            const t = r.data && r.data.teams && r.data.teams[team];
            return (t && t.effectiveRoster ? t.effectiveRoster.map(m => m.name) : []).sort();
        }
        const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

        const todayG7 = todayRes.data.standings.find(t => t.team === 'جنوب 7');
        const expTodayG7 = await expectedCrew(today, 'جنوب 7');
        check('⑤★ today: أسماء جنوب 7 = تشكيل التكميل حرفيًا (نفس shift+team ونفس اللحظة)',
            !!todayG7 && sameNames(todayG7.members, expTodayG7),
            'board=' + JSON.stringify(todayG7 && todayG7.members) + ' completion=' + JSON.stringify(expTodayG7));
        check('⑤ today: الأسماء المزروعة ضمن التشكيل', !!todayG7 && todayG7.members.includes('محمد اختبار اليوم') && todayG7.members.includes('فهد اختبار اليوم'));
        const noStaleToday = todayRes.data.standings.every(t => !t.members.some(m => m.includes('الأمس') || m.includes('قديم')));
        check('⑤ today: صفر أسماء قديمة/أمس في كل النتائج', noStaleToday);

        const weekRes = await act('?period=week&top=5');
        const weekG7 = weekRes.data.standings.find(t => t.team === 'جنوب 7');
        const wShifts = weekG7 ? weekG7.shifts : [];
        const wToday = wShifts.find(s => s.shift_date === today);
        const wYst = wShifts.find(s => s.shift_date === yesterday);
        const expYstG7 = await expectedCrew(yesterday, 'جنوب 7');
        check('⑤★ week: مناوبة اليوم تعرض تشكيل تكميلها حصرًا',
            !!wToday && sameNames(wToday.members, expTodayG7) && !wToday.members.some(m => m.includes('الأمس')),
            'board=' + JSON.stringify(wToday && wToday.members) + ' completion=' + JSON.stringify(expTodayG7));
        check('⑤★ week: مناوبة أمس تعرض تشكيل تكميلها حصرًا',
            !!wYst && sameNames(wYst.members, expYstG7) && !wYst.members.some(m => m.includes('اليوم')),
            'board=' + JSON.stringify(wYst && wYst.members) + ' completion=' + JSON.stringify(expYstG7));
        check('⑤ week: الاتحاد يجمع الأربعة المزروعين بلا خلط', !!weekG7 && ['محمد اختبار اليوم', 'فهد اختبار اليوم', 'خالد اختبار الأمس', 'سعد اختبار الأمس'].every(n => weekG7.members.includes(n)), JSON.stringify(weekG7 && weekG7.members));
        check('⑤ week: جنوب 7 إجمالي = 2+3 = 5 (بلاغ يناير مستبعد)', !!weekG7 && weekG7.reports_count === 5, 'count=' + (weekG7 && weekG7.reports_count));

        // ── D.1) سيناريو جنوب 8 الكامل — حالات الطاقم الست (على المناوبة النشطة) ──
        console.log('\n🛡️ D.1 — التكميل هو المرجع الوحيد (جنوب 8):');
        const d1Res = await act('?period=current_shift&top=5');
        const g8 = d1Res.data.standings.find(t => t.team === 'جنوب 8');
        const expG8 = await expectedCrew('2026-08-13', 'جنوب 8');
        check('D.1-① التكميل = الإنجاز: أسماء جنوب 8 مطابقة حرفيًا للتشكيل الفعلي (نفس shift+team ونفس اللحظة)',
            !!g8 && sameNames(g8.members, expG8),
            'board=' + JSON.stringify(g8 && g8.members) + ' completion=' + JSON.stringify(expG8));
        check('D.1-② الغائب لا يظهر ضمن طاقم الإنجاز', !!g8 && (!ABSENT_G8 || !g8.members.includes(ABSENT_G8)), 'absent=' + ABSENT_G8);
        check('D.1-③ الداعم المفتوح حاليًا يظهر', !!g8 && g8.members.includes('داعم اختبار مفتوح'), JSON.stringify(g8 && g8.members));
        check('D.1-④ الداعم المنتهي لا يظهر (ولا أي حدث قديم لغير المشكَّل)', !!g8 && !g8.members.some(m => m.includes('منتهي')), JSON.stringify(g8 && g8.members));
        check('D.1-⑤ المفعَّل المفتوح يظهر', !!g8 && g8.members.includes('مفعل اختبار مفتوح'), JSON.stringify(g8 && g8.members));
        const testA = todayRes.data.standings.find(t => t.team === 'اختبار أ');
        check('D.1-⑥ إنجاز بلا تشكيل مُثبت ← members_incomplete=true وصفر أسماء مختلقة',
            !!testA && testA.members_incomplete === true && testA.members.length === 0,
            JSON.stringify(testA && { mi: testA.members_incomplete, m: testA.members }));

        // ── 6) عزل الفترات ──
        console.log('\n📅 عزل الفترات:');
        const monthRes = await act('?period=month&top=5');
        const monthG7 = monthRes.data.standings.find(t => t.team === 'جنوب 7');
        check('⑥ month: بلاغات يناير الخمسة لا تدخل الشهر الحالي', !!monthG7 && monthG7.reports_count === 5, 'count=' + (monthG7 && monthG7.reports_count));
        check('⑥ لا اسم قديم في month إطلاقًا', monthRes.data.standings.every(t => !t.members.some(m => m.includes('قديم'))));

        // ── 7) العدالة: الفرق بلا بلاغات ──
        console.log('\n⚖️ العدالة:');
        const hasHE = todayRes.data.standings.some(t => t.team === 'اختبار هـ');
        check('⑦ الفرقة العاملة بلا بلاغات خارج standings (ليست صفر أداء)', !hasHE);
        check('⑦ وتُحصى في meta.teams_active_without_reports', todayRes.data.meta.teams_active_without_reports >= 1, 'meta=' + todayRes.data.meta.teams_active_without_reports);

        // ── 8) اتساق التفصيل مع الإجمالي ──
        const consistent = weekRes.data.standings.every(t => t.shifts.reduce((s, x) => s + x.reports_count, 0) === t.reports_count);
        check('⑧ مجموع shifts[].reports_count = reports_count لكل فرقة (لا خلط مناوبات)', consistent);

        // ── 11) قاعدة الترتيب الثابتة ──
        console.log('\n📊 قاعدة الترتيب:');
        const order = todayRes.data.standings.map(t => t.team);
        const iA = order.indexOf('اختبار أ'), iB = order.indexOf('اختبار ب'), iJ = order.indexOf('اختبار ج'), iD = order.indexOf('اختبار د');
        check('⑪ rate تنازليًا ثم العدد ثم الاسم: أ ← ب ← ج ← د',
            iA !== -1 && iB !== -1 && iJ !== -1 && iD !== -1 && iA < iB && iB < iJ && iJ < iD, order.join(' | '));
        const rowB = todayRes.data.standings.find(t => t.team === 'اختبار ب');
        check('⑪ active_minutes من طيّ missing←ready: 480−240=240 دقيقة', !!rowB && rowB.active_minutes === 240 && rowB.active_minutes_estimated === false, JSON.stringify(rowB && { a: rowB.active_minutes, e: rowB.active_minutes_estimated }));
        const rowA = todayRes.data.standings.find(t => t.team === 'اختبار أ');
        check('⑪ بلا أحداث حالة ← estimated:true وactive=shift', !!rowA && rowA.active_minutes_estimated === true && rowA.active_minutes === rowA.shift_minutes);

        // ── 12) التسمية ──
        const payload = JSON.stringify(todayRes.data);
        check('⑫ التسمية «الأكثر نشاطًا» ولا «أفضل فرقة» في أي حقل', todayRes.data.label === 'الأكثر نشاطًا' && !payload.includes('أفضل فرقة'));

        // ── 10) الأداء ──
        console.log('\n⚡ الأداء:');
        let ms = 0;
        for (let i = 0; i < 20; i++) { const t0 = Date.now(); await act('?period=week&top=5'); ms += Date.now() - t0; }
        const avg = Math.round((ms / 20) * 10) / 10;
        check('⑩ متوسط week top=5 ضمن العتبة (<150ms)', avg < 150, 'avg=' + avg + 'ms');

    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ كل اختبارات محرك نشاط الفرق ناجحة');
})().catch(e => { console.error('🛑 تعذر الإكمال:', e.message); process.exit(1); });
