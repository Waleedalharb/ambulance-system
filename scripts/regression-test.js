/**
 * Regression Test — Slice 1 approval gate
 * ═══════════════════════════════════════════════════════════
 * Runs against a THROWAWAY copy of the database (DB_PATH env).
 * Covers: auth, shift lifecycle, reports, completion, indicators,
 * dashboards, chat, notifications, archive, daily report, cross-page sync,
 * and a broad read-only battery over every major GET endpoint.
 *
 * Usage:
 *   1) cp database.db %TEMP%\regression.db
 *   2) DB_PATH=%TEMP%\regression.db PORT=3080 node server.js
 *   3) node scripts/regression-test.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3080';
const results = [];
let TOKEN = null;

function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, path, body, expectStatus = 200) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json */ }
    return { status: res.status, data, ok: res.status === expectStatus };
}

// OV-S6 (قناة لحظية واحدة): عميل SSE أدنى للبوابة — الأحداث التشغيلية أصبحت
// تُبث عبر SSE فقط (broadcast() = SSE)، وWebSocket محجوز حصرياً للشات.
// اختبارات المزامنة اللحظية أدناه تستمع على /api/sse بدل /ws (العقد الجديد).
function listenSSE(path, onEvent) {
    const http = require('http');
    const state = { opened: false, onOpen: null };
    const req = http.get(BASE + path, (res) => {
        let buf = '';
        res.on('data', (chunk) => {
            if (!state.opened) { state.opened = true; if (state.onOpen) state.onOpen(); }
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const dataLine = frame.split('\n').find(l => l.indexOf('data:') === 0);
                if (dataLine) {
                    try { onEvent(JSON.parse(dataLine.slice(5).trim())); } catch (_) {}
                }
            }
        });
        res.on('error', () => {});
    });
    req.on('error', () => {});
    return {
        onOpen: (fn) => { if (state.opened) fn(); else state.onOpen = fn; },
        close: () => { try { req.destroy(); } catch (_) {} }
    };
}

async function main() {
    console.log(`\n═══ Regression Test @ ${BASE} ═══\n`);

    // ─── 1. Auth ───
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    record('تسجيل الدخول', login.ok && login.data && login.data.accessToken, `status=${login.status}`);
    if (!login.data || !login.data.accessToken) { console.log('لا يمكن المتابعة بدون توكن'); process.exit(1); }
    TOKEN = login.data.accessToken;

    const me = await api('GET', '/api/auth/me');
    record('التحقق من الجلسة /auth/me', me.ok && me.data && (me.data.username === '4252' || (me.data.user && me.data.user.username === '4252')), `status=${me.status}`);

    const badLogin = await api('POST', '/api/auth/login', { username: '4252', password: 'wrong' }, 401);
    record('رفض كلمة مرور خاطئة', badLogin.status === 401, `status=${badLogin.status}`);

    const savedToken = TOKEN;
    TOKEN = null; // ensure no Authorization header is attached
    const noAuth = await api('GET', '/api/shifts', undefined, 401);
    record('حماية المسارات بدون توكن', noAuth.status === 401, `status=${noAuth.status}`);
    TOKEN = savedToken;

    // ─── 2. Pages battery ───
    const pages = ['index.html', 'smart-schedule.html', 'operations-command.html', 'operations-dashboard.html',
        'radio-completion.html', 'report-entry.html', 'daily-report.html', 'chat.html',
        'admin-dashboard.html', 'admin-knowledge.html', 'admin-shift-codes.html', 'ai-dashboard.html', 'south-sector.html'];
    let pagesOk = 0;
    for (const p of pages) {
        const res = await fetch(BASE + '/' + p);
        if (res.status === 200) pagesOk++;
    }
    record(`الصفحات تُقدَّم (${pagesOk}/${pages.length})`, pagesOk === pages.length);

    // ─── 3. Read-only GET battery (pre-lifecycle) ───
    const gets = ['/api/data', '/api/shifts', '/api/employees', '/api/teams', '/api/shift-codes',
        '/api/shift-roster', '/api/team-assignments', '/api/announcements', '/api/hospitals',
        '/api/references', '/api/timeline', '/api/docs', '/api/peak-data', '/api/peak-plans',
        '/api/e-cases', '/api/incidents', '/api/escalations', '/api/daily-reports',
        '/api/air-ambulance', '/api/senior-shifts', '/api/control-notes', '/api/vacations',
        '/api/report-entry', '/api/audit-log', '/api/notifications', '/api/schedule/employees',
        '/api/leave-requests', '/api/daily-report', '/api/admin/monitor/health', '/api/center-geo',
        '/api/chat/users', '/api/chat/conversations', '/api/chat/online', '/api/users'];
    const failedGets = [];
    for (const g of gets) {
        const r = await api('GET', g);
        if (r.status !== 200) failedGets.push(`${g}→${r.status}`);
    }
    record(`بطارية القراءة (${gets.length - failedGets.length}/${gets.length})`, failedGets.length === 0, failedGets.join(' | '));

    // ─── 4. Shift lifecycle ───
    const start = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
    record('بدء مناوبة', start.ok && start.data.success && !!start.data.shiftId, `shiftId=${start.data && start.data.shiftId}`);
    const shiftId = start.data && start.data.shiftId;

    const cur = await api('GET', '/api/current-shift');
    record('المناوبة الحالية active', cur.ok && cur.data.shift && cur.data.shift.status === 'active' && cur.data.shift.id === shiftId, JSON.stringify(cur.data.shift && { id: cur.data.shift.id, status: cur.data.shift.status }));

    // ─── 5. Reports: add / undo / consistency ───
    const center = 'المنصورة', unit = 'جنوب 1';
    const r1 = await api('POST', '/api/report', { center, unit });
    const r2 = await api('POST', '/api/report', { center, unit });
    record('تسجيل بلاغين', r1.ok && r2.ok && r2.data.newCount === 2 && r2.data.totalReports === 2, JSON.stringify(r2.data));

    const dataAfter = await api('GET', '/api/data');
    const key = center + '|' + unit;
    const reflected = dataAfter.data && dataAfter.data.data && dataAfter.data.data[key] && dataAfter.data.data[key].count === 2;
    record('انعكاس البلاغ في /api/data (مصدر واحد)', !!reflected, JSON.stringify(dataAfter.data && dataAfter.data.data && dataAfter.data.data[key]));

    const undo = await api('POST', '/api/undo', { center, unit });
    record('التراجع عن بلاغ', undo.ok && undo.data.success && undo.data.newCount === 1, JSON.stringify(undo.data));

    const dataUndo = await api('GET', '/api/data');
    const undoReflected = dataUndo.data && dataUndo.data.data && dataUndo.data.data[key] && dataUndo.data.data[key].count === 1;
    record('انعكاس التراجع في /api/data', !!undoReflected);

    const cur2 = await api('GET', '/api/current-shift');
    record('تساق عدّاد المناوبة مع البلاغات (مزامنة)', cur2.ok && cur2.data.shift && cur2.data.shift.totalReports === 1, `totalReports=${cur2.data.shift && cur2.data.shift.totalReports}`);

    // ─── 6. Completion: server-stamped SSOT (OV-S6-01) + read by shift_id ───
    // The active shift row is the stamp source; client type/date are ignored.
    const activeShift = cur.data.shift; // { id, type, date, ... } — مناوبة 'ليل' بدأت في الخطوة 4
    const comp1 = await api('POST', '/api/shift-completion', {
        shiftType: 'صباح', shiftDate: '2026-07-17', shift_id: shiftId, // ختم واجهة خاطئ عمداً
        teams: { 'جنوب 3': { status: 'ready', centerName: 'منفوحة' } }, notes: 'regression', timestamp: new Date().toISOString()
    });
    record('حفظ التكميل (الختم سيرفري SSOT)', comp1.ok && comp1.data.success && comp1.data.corrected === true
        && comp1.data.stampedShiftType === activeShift.type && comp1.data.stampedShiftDate === activeShift.date,
        JSON.stringify({ corrected: comp1.data && comp1.data.corrected, stampedShiftType: comp1.data && comp1.data.stampedShiftType, stampedShiftDate: comp1.data && comp1.data.stampedShiftDate }));

    const compLatest = await api('GET', `/api/completion/latest?shiftDate=${encodeURIComponent(activeShift.date)}&shiftType=${encodeURIComponent(activeShift.type)}`);
    const compById = await api('GET', `/api/completion/latest?shift_id=${shiftId}`);
    const foundByDateType = compLatest.ok && compLatest.data.success && compLatest.data.completion && !!compLatest.data.completion.teams['جنوب 3'];
    const foundByShiftId = compById.ok && compById.data.success && compById.data.completion && !!compById.data.completion.teams['جنوب 3']
        && compById.data.completion.shiftType === activeShift.type && compById.data.completion.shiftDate === activeShift.date;
    record('قراءة التكميل المحفوظ (date+type و shift_id)', foundByDateType && foundByShiftId, `dateType=${foundByDateType} shiftId=${foundByShiftId}`);

    const comp2 = await api('POST', '/api/shift-completion', {
        shiftType: 'صباح', shiftDate: '2026-07-17', shift_id: shiftId, // ختم خاطئ عمداً مجدداً
        teams: { 'جنوب 3': { status: 'missing', centerName: 'منفوحة' } }, notes: 'regression-2', timestamp: new Date().toISOString()
    });
    const compLatest2 = await api('GET', `/api/completion/latest?shift_id=${shiftId}`);
    const updated = compLatest2.data && compLatest2.data.completion && compLatest2.data.completion.teams['جنوب 3'] && compLatest2.data.completion.teams['جنوب 3'].status === 'missing';
    record('تعديل التكميل ينعكس', comp2.ok && !!updated);

    // ─── 6b. W1-B: ترجمة التكميل إلى أحداث تشغيلية (معاملة واحدة + منع تكرار + ختم سيرفري) ───
    // comp1 (ready) وcomp2 (missing بلا سبب) أنتجا حدثين لهذه المناوبة حتى الآن
    const w1bTl0 = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const w1bEv0 = (w1bTl0.data && w1bTl0.data.events) || [];
    const w1bStampsOk = w1bEv0.length === 2 && w1bEv0.every(e =>
        e.shift_id === shiftId && e.shift_date === activeShift.date && e.shift_type === activeShift.type
        && e.domain === 'staffing' && e.actor_name && e.actor_id && e.created_at);
    record('W1-B ①: حفظا التكميل السابقان أنتجا حدثين مختومين سيرفريًا (shift/date/type/actor/time)', w1bTl0.ok && w1bStampsOk,
        `events=${w1bEv0.length} types=${w1bEv0.map(e => e.event_type).join(',')}`);

    // سيناريو 3 فرق: جاهز (كان ناقصًا) / ناقص بمسعف غائب معروف / خارج الخدمة ⇒ 4 أحداث
    const w1bPayload1 = {
        shiftType: activeShift.type, shiftDate: activeShift.date,
        teams: {
            'جنوب 3': { status: 'ready', centerName: 'منفوحة' },
            'جنوب 7': { status: 'missing', reason: 'مسعف غائب', missingPerson: 'محمد القحطاني', centerName: 'الشفاء' },
            'جنوب 9': { status: 'offline', centerName: 'السويدي' }
        },
        notes: 'w1b-1', timestamp: new Date().toISOString()
    };
    const w1bSave1 = await api('POST', '/api/shift-completion', w1bPayload1);
    const w1bTl1 = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const w1bEv1 = (w1bTl1.data && w1bTl1.data.events) || [];
    const w1bDelta1 = w1bEv1.slice(w1bEv0.length);
    const w1bTypes1 = w1bDelta1.map(e => e.event_type).sort().join(',');
    const w1bAbsence = w1bDelta1.find(e => e.event_type === 'absence');
    record('W1-B ②: حفظ 3 فرق أنتج 4 أحداث صحيحة (ready+missing+absence+offline) وabsence مربوط بالشخص',
        w1bSave1.ok && w1bDelta1.length === 4 && w1bTypes1 === 'absence,missing,offline,ready'
        && w1bAbsence && w1bAbsence.entity_id === 'محمد القحطاني' && w1bAbsence.team_id === 'جنوب 7' && w1bAbsence.center === 'الشفاء',
        `delta=${w1bDelta1.length} types=${w1bTypes1}`);

    // إعادة الحفظ بنفس البيانات ⇒ صفر أحداث جديدة (منع التكرار مع الحفظ التلقائي)
    const w1bSave2 = await api('POST', '/api/shift-completion', { ...w1bPayload1, notes: 'w1b-2' });
    const w1bTl2 = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const w1bEv2 = (w1bTl2.data && w1bTl2.data.events) || [];
    record('W1-B ③: إعادة الحفظ المتطابق لا تُنتج أي حدث مكرر', w1bSave2.ok && w1bEv2.length === w1bEv1.length,
        `before=${w1bEv1.length} after=${w1bEv2.length}`);

    // عودة «جنوب 7» جاهزًا ⇒ حدث ready + حدث arrival للشخص (إغلاق دلالي + مدة مشتقة)
    const w1bPayload3 = {
        ...w1bPayload1,
        teams: {
            'جنوب 3': { status: 'ready', centerName: 'منفوحة' },
            'جنوب 7': { status: 'ready', centerName: 'الشفاء' },
            'جنوب 9': { status: 'offline', centerName: 'السويدي' }
        },
        notes: 'w1b-3'
    };
    const w1bSave3 = await api('POST', '/api/shift-completion', w1bPayload3);
    const w1bTl3 = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const w1bEv3 = (w1bTl3.data && w1bTl3.data.events) || [];
    const w1bDelta3 = w1bEv3.slice(w1bEv2.length);
    const w1bArrival = w1bDelta3.find(e => e.event_type === 'arrival');
    const w1bState = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const w1bPerson = ((w1bState.data && w1bState.data.entities) || []).find(en => en.entityId === 'محمد القحطاني');
    const w1bPair = w1bPerson && w1bPerson.closedPairs && w1bPerson.closedPairs[0];
    record('W1-B ④: عودة الفريق جاهزًا ⇒ ready+arrival والغياب يُغلق دلاليًا بمدة مشتقة',
        w1bSave3.ok && w1bDelta3.length === 2 && !!w1bArrival && w1bArrival.entity_id === 'محمد القحطاني'
        && !!w1bPerson && w1bPerson.open.length === 0 && !!w1bPair && w1bPair.closedBy.type === 'arrival' && typeof w1bPair.durationMs === 'number',
        `delta=${w1bDelta3.length} closed=${w1bPair ? w1bPair.event_type + '→' + w1bPair.closedBy.type : 'none'}`);

    // القراءة القديمة (الإسقاط التوافقي) لم تتغير: آخر حفظ يظهر كما كان سابقًا
    const w1bCompat = await api('GET', `/api/completion/latest?shift_id=${shiftId}`);
    const w1bCompatTeams = w1bCompat.data && w1bCompat.data.completion && w1bCompat.data.completion.teams;
    record('W1-B ⑤: الإسقاط التوافقي shift_completions سليم (قراءة قديمة متطابقة)',
        !!(w1bCompatTeams && w1bCompatTeams['جنوب 7'] && w1bCompatTeams['جنوب 7'].status === 'ready'
        && w1bCompatTeams['جنوب 9'] && w1bCompatTeams['جنوب 9'].status === 'offline'),
        `s7=${w1bCompatTeams && w1bCompatTeams['جنوب 7'] && w1bCompatTeams['جنوب 7'].status}`);

    // الأداء: زمن حفظ التكميل بعد إضافة الأحداث يبقى ضمن العتبة (R-4)
    const w1bT0 = Date.now();
    for (let i = 0; i < 5; i++) await api('POST', '/api/shift-completion', { ...w1bPayload3, notes: 'w1b-perf' });
    const w1bPerfAvg = (Date.now() - w1bT0) / 5;
    const w1bTlEnd = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const w1bEvEnd = (w1bTlEnd.data && w1bTlEnd.data.events) || [];
    record('W1-B ⑥: زمن حفظ التكميل ضمن العتبة (<150ms) وحفظات الأداء لم تُنتج أحداثًا (نفس البصمة)',
        w1bPerfAvg < 150 && w1bEvEnd.length === w1bEv3.length, `avg=${w1bPerfAvg.toFixed(1)}ms events=${w1bEvEnd.length}`);

    // ─── 6c. W1-E-A: قراءة هجينة لـ completion/latest (الأحداث أولًا + paramedics من الإسقاط دومًا) ───
    // ① الحالات تُقدَّم مشتقة من السجل (آخر أحداث: ready/ready/offline) وتطابق آخر حفظ
    const w1eLatest = await api('GET', `/api/completion/latest?shift_id=${shiftId}`);
    const w1eTeams = w1eLatest.data && w1eLatest.data.completion && w1eLatest.data.completion.teams;
    record('W1-E-A ①: completion/latest يقدّم الحالات المشتقة من السجل (ready/ready/offline)',
        !!(w1eTeams && w1eTeams['جنوب 3'] && w1eTeams['جنوب 3'].status === 'ready'
        && w1eTeams['جنوب 7'] && w1eTeams['جنوب 7'].status === 'ready'
        && w1eTeams['جنوب 9'] && w1eTeams['جنوب 9'].status === 'offline'),
        `s3=${w1eTeams && w1eTeams['جنوب 3'] && w1eTeams['جنوب 3'].status} s7=${w1eTeams && w1eTeams['جنوب 7'] && w1eTeams['جنوب 7'].status} s9=${w1eTeams && w1eTeams['جنوب 9'] && w1eTeams['جنوب 9'].status}`);

    // ② paramedics تصل دائمًا من shift_completions (D2) — حفظ بمسعفين بنفس البصمة ⇒ صفر أحداث جديدة
    const w1eEvB = ((await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`)).data.events || []).length;
    await api('POST', '/api/shift-completion', {
        ...w1bPayload3,
        teams: { ...w1bPayload3.teams, 'جنوب 3': { status: 'ready', centerName: 'منفوحة', paramedics: ['مسعف أول', 'مسعف ثانٍ'] } },
        notes: 'w1e-paramedics'
    });
    const w1eLatest2 = await api('GET', `/api/completion/latest?shift_id=${shiftId}`);
    const w1eT3 = w1eLatest2.data && w1eLatest2.data.completion && w1eLatest2.data.completion.teams['جنوب 3'];
    const w1eEvA = ((await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`)).data.events || []).length;
    record('W1-E-A ②: paramedics من الإسقاط دومًا (D2) وحفظها بلا حدث جديد (نفس البصمة)',
        !!(w1eT3 && Array.isArray(w1eT3.paramedics) && w1eT3.paramedics.length === 2
        && w1eT3.status === 'ready' && w1eEvA === w1eEvB),
        `paramedics=${w1eT3 && JSON.stringify(w1eT3.paramedics)} events=${w1eEvB}→${w1eEvA}`);

    // ③ السقوط للمناوبات القديمة: مناوبة بلا أحداث staffing ⇒ بيانات الإسقاط كما هي (D1)
    let w1eLegacy = null, w1eLegacyShift = null;
    const w1eShifts = await api('GET', '/api/shifts');
    for (const s of (w1eShifts.data || []).slice(0, 15)) {
        if (s.id === shiftId) continue;
        const tl = await api('GET', `/api/staffing/timeline?shift_id=${s.id}`);
        const evCount = ((tl.data && tl.data.events) || []).length;
        if (evCount > 0) continue;
        const c = await api('GET', `/api/completion/latest?shift_id=${s.id}`);
        if (c.ok && c.data && c.data.success && c.data.completion && c.data.completion.teams && Object.keys(c.data.completion.teams).length) {
            w1eLegacy = c.data.completion; w1eLegacyShift = s.id; break;
        }
        const c2 = await api('GET', `/api/completion/latest?shiftDate=${encodeURIComponent(s.shiftDate || '')}&shiftType=${encodeURIComponent(s.shiftType || '')}`);
        if (c2.ok && c2.data && c2.data.success && c2.data.completion && c2.data.completion.teams && Object.keys(c2.data.completion.teams).length) {
            w1eLegacy = c2.data.completion; w1eLegacyShift = s.id; break;
        }
    }
    record('W1-E-A ③: مناوبة قديمة بلا أحداث تُقرأ من الإسقاط التوافقي كما هي (سقوط صادق)',
        !!(w1eLegacy && Object.keys(w1eLegacy.teams).length > 0),
        `legacyShift=${w1eLegacyShift} teams=${w1eLegacy ? Object.keys(w1eLegacy.teams).length : 'none'}`);

    // ④ عقد المغلف بلا تغيير (نفس الحقول الثمانية بالضبط)
    const w1eKeys = w1eLatest2.data && w1eLatest2.data.completion ? Object.keys(w1eLatest2.data.completion).sort().join(',') : '';
    record('W1-E-A ④: عقد الاستجابة ثابت (حقول المغلف الثمانية بلا زيادة)',
        w1eKeys === 'createdAt,createdBy,id,notes,shiftDate,shiftId,shiftType,teams', `keys=${w1eKeys}`);

    // ⑤ أداء القراءة الهجينة ضمن العتبة
    const w1eT0 = Date.now();
    const w1ePerf = await api('GET', `/api/completion/latest?shift_id=${shiftId}`);
    const w1eMs = Date.now() - w1eT0;
    record('W1-E-A ⑤: زمن القراءة الهجينة ضمن العتبة (<150ms)', w1ePerf.ok && w1eMs < 150, `ms=${w1eMs}`);

    // ─── 7. Indicators / dashboards ───
    const wf = await api('GET', `/api/workforce-stats/${shiftId}`);
    record('إحصائيات القوى العاملة للمناوبة', wf.status === 200, `status=${wf.status}`);
    const adminStats = await api('GET', '/api/admin/stats');
    record('لوحة إحصاءات المشرف', adminStats.status === 200, `status=${adminStats.status}`);
    const mon = await api('GET', '/api/admin/monitor/health');
    record('مراقبة الصحة', mon.status === 200, `status=${mon.status}`);

    // ─── 8. Daily report ───
    const daily = await api('GET', '/api/daily-report');
    record('التقرير اليومي', daily.status === 200 && daily.data !== null, `status=${daily.status}`);

    // ─── 9. Chat ───
    const users = await api('GET', '/api/chat/users');
    const others = (users.data && (users.data.users || users.data)) || [];
    const other = Array.isArray(others) ? others.find(u => (u.id || u.user_id) && (u.username !== '4252' && u.user_id !== '4252')) : null;
    let convId = null;
    if (other) {
        const otherId = other.id || other.user_id;
        const conv = await api('POST', '/api/chat/conversations/private', { user_id: otherId });
        convId = conv.data && (conv.data.conversation_id || conv.data.id || (conv.data.conversation && conv.data.conversation.id));
        record('إنشاء/فتح محادثة خاصة', conv.ok && !!convId, `conv=${convId}`);
        if (convId) {
            const msg = await api('POST', `/api/chat/conversations/${convId}/messages`, { content: 'رسالة اختبار regression' });
            const msgOk = msg.ok || msg.status === 201;
            record('إرسال رسالة', msgOk, `status=${msg.status}`);
            const msgs = await api('GET', `/api/chat/conversations/${convId}/messages`);
            const list = msgs.data && (msgs.data.messages || msgs.data);
            record('قراءة الرسائل', msgs.ok && Array.isArray(list) && list.length > 0);
        }
    } else {
        record('إنشاء/فتح محادثة خاصة', false, 'لا يوجد مستخدم آخر');
    }

    // Archive slice (D-6): a freshly created conversation is stamped with the active shift.
    // Group conv guarantees an INSERT (private may reopen a pre-existing unstamped one).
    let gconvId = null;
    if (other) {
        const gconv = await api('POST', '/api/chat/conversations', { title: 'regression D-6', participant_ids: [other.id || other.user_id] });
        gconvId = gconv.data && gconv.data.conversation && gconv.data.conversation.id;
        const glist = await api('GET', '/api/chat/conversations');
        const gitems = (glist.data && glist.data.conversations) || [];
        const gmine = Array.isArray(gitems) ? gitems.find(c => c.id === gconvId) : null;
        record('المحادثة تُختم بالمناوبة النشطة عند إنشائها (D-6)', !!(gconvId && gmine && gmine.shift_id === shiftId),
            gmine ? `shift_id=${gmine.shift_id} expected=${shiftId}` : `conv=${gconvId} status=${gconv.status}`);
    }

    // ─── 10. Notifications ───
    const notif = await api('GET', '/api/notifications');
    record('جلب الإشعارات', notif.status === 200, `status=${notif.status}`);

    // ─── 11. End + archive ───
    const end = await api('POST', `/api/shift/${shiftId}/end`, { handoverNotes: 'regression handover' });
    record('إنهاء المناوبة (pending_handover)', end.ok && end.data.success !== false, JSON.stringify(end.data));

    const approve = await api('POST', `/api/shift/${shiftId}/handover-approve`, {});
    record('اعتماد التسليم والأرشفة', approve.ok && approve.data.success !== false, `status=${approve.status} ${JSON.stringify(approve.data).slice(0, 120)}`);

    const arch = await api('GET', `/api/shifts/${shiftId}`);
    const archivedOk = arch.ok && arch.data && (arch.data.shift || arch.data).status === 'archived';
    record('المناوبة مؤرشفة وقابلة للفتح', !!archivedOk, `status=${arch.data && ((arch.data.shift || arch.data).status)}`);

    // ─── 11b. Archive slice: seal + conversations (D-6) + integrity ───
    if (gconvId) {
        const convs = await api('GET', '/api/chat/conversations');
        const convList = (convs.data && (convs.data.conversations || convs.data)) || [];
        const stillVisible = Array.isArray(convList) && convList.some(c => c.id === gconvId);
        record('المحادثة المؤرشفة تختفي من القائمة النشطة (is_archived=1)', !stillVisible);
    }
    const snap = await api('GET', `/api/shift-snapshot/${shiftId}`);
    record('لقطة الأرشفة محفوظة وقابلة للجلب', snap.ok && snap.data && snap.data.success && !!snap.data.snapshot, `status=${snap.status}`);
    if (gconvId && snap.data && snap.data.snapshot) {
        const sconvs = snap.data.snapshot.conversations || [];
        const sco = sconvs.find(c => c.id === gconvId);
        record('لقطة الأرشفة تتضمن محادثات المناوبة ورسائلها (D-6)', !!sco && Array.isArray(sco.messages), `convs=${sconvs.length}`);
    }
    const integ = await api('GET', `/api/shift-integrity/${shiftId}`);
    record('مسار التحقق من سلامة الأرشيف يعمل', integ.ok && integ.data && integ.data.success && !!integ.data.checks,
        `status=${integ.status} passed=${integ.data && integ.data.passed}`);
    const tok2 = TOKEN; TOKEN = null;
    const noAuthSnap = await api('GET', `/api/shift-snapshot/${shiftId}`, undefined, 401);
    const noAuthInteg = await api('GET', `/api/shift-integrity/${shiftId}`, undefined, 401);
    TOKEN = tok2;
    record('مسارا اللقطة والسلامة مقيّدان بالصلاحيات (401 بدون توكن)', noAuthSnap.status === 401 && noAuthInteg.status === 401,
        `snap=${noAuthSnap.status} integ=${noAuthInteg.status}`);

    // ─── 12. Cross-page sync (new shift for a clean read) ───
    const start2 = await api('POST', '/api/start-new-shift', { shiftType: 'صباح' });
    const r3 = await api('POST', '/api/report', { center: 'الخالدية', unit: 'جنوب 2' });
    const dA = await api('GET', '/api/data');
    const dB = await api('GET', '/api/current-shift');
    const key2 = 'الخالدية|جنوب 2';
    const syncOk = dA.data && dA.data.data && dA.data.data[key2] && dA.data.data[key2].count === 1 &&
        dB.data && dB.data.shift && dB.data.shift.totalReports === 1;
    record('مزامنة نفس البيانات عبر المسارات (صفحات مختلفة)', !!syncOk && start2.ok && r3.ok,
        `data=${dA.data && dA.data.data && dA.data.data[key2] && dA.data.data[key2].count} shiftTotal=${dB.data && dB.data.shift && dB.data.shift.totalReports}`);

    // ─── 12b. Slice 2: X2 — shift data single source (SQLite) ───
    const shift2Id = start2.data && start2.data.shiftId;
    const upd = await api('POST', '/api/update-shift-data', { shiftId: shift2Id, shiftData: { centersData: { 'مركز الاختبار': { staffCount: 2, carsCount: 1 } } } });
    const wf2 = await api('GET', `/api/workforce-stats/${shift2Id}`);
    const dist = wf2.data && wf2.data.distribution;
    record('X2: كتابة بيانات المناوبة عبر ShiftService وقراءتها من SQLite', upd.ok && dist && dist['مركز الاختبار'] === 2,
        `upd=${upd.status} dist=${dist && dist['مركز الاختبار']}`);

    const allShifts = await api('GET', '/api/shifts');
    const shiftsList = Array.isArray(allShifts.data) ? allShifts.data : (allShifts.data && allShifts.data.shifts) || [];
    const reconciled = shiftsList.find(s => s.id === 1784126563154);
    record('X2: مناوبة كانت JSON-فقط ظهرت من SQLite (reconcile)', !!reconciled && reconciled.status === 'archived',
        reconciled ? `status=${reconciled.status}` : 'غير موجودة');

    const mk = await api('POST', '/api/update-shift-data', { shiftDate: '2099-01-01', shiftType: 'صباحية', shiftData: { generalNotes: 'disposable regression shift' } });
    const mkId = mk.data && mk.data.shiftId;
    const delRead = mkId ? await api('GET', `/api/shifts/${mkId}`) : { status: 0 };
    const del = mkId ? await api('DELETE', `/api/shifts/${mkId}`) : { status: 0 };
    const afterDel = mkId ? await api('GET', `/api/shifts/${mkId}`) : { status: 0 };
    record('حذف مناوبة من المصدر الواحد (SQLite)', !!(mkId && delRead.ok && del.ok && afterDel.status === 404),
        `mk=${mkId} read=${delRead.status} del=${del.status} after=${afterDel.status}`);

    // ─── 12c. Archive slice: unified content stores (SQLite) + shift stamping ───
    const notePost = await api('POST', `/api/shift-notes/${shift2Id}`, { notes: [{ text: 'ملاحظة regression', author: 'اختبار' }] });
    const noteGet = await api('GET', `/api/shift-notes/${shift2Id}`);
    const noteList = noteGet.data && noteGet.data.notes || [];
    record('سجل الملاحظات عبر SQLite (كتابة/قراءة)', notePost.ok && noteList.some(n => n.text === 'ملاحظة regression'), `notes=${noteList.length}`);
    const noteDel = noteList.length ? await api('DELETE', `/api/shift-notes/${shift2Id}/${noteList[0].id}`) : { ok: false, status: 0 };
    const noteGet2 = await api('GET', `/api/shift-notes/${shift2Id}`);
    const noteList2 = (noteGet2.data && noteGet2.data.notes) || [];
    record('حذف ملاحظة من المصدر الواحد (NotesService)', noteDel.ok && noteList2.length === noteList.length - 1, `before=${noteList.length} after=${noteList2.length}`);
    const evPost = await api('POST', `/api/shift-events/${shift2Id}`, { type: 'اختبار', description: 'حدث regression' });
    const evGet = await api('GET', `/api/shift-events/${shift2Id}`);
    const evList = evGet.data && evGet.data.events || [];
    record('سجل الأحداث عبر SQLite (كتابة/قراءة)', evPost.ok && evList.some(e => e.description === 'حدث regression'), `events=${evList.length}`);
    const abPost = await api('POST', `/api/shift-absences/${shift2Id}`, { absences: [{ name: 'غياب اختبار', center: 'منفوحة' }] });
    const abGet = await api('GET', `/api/shift-absences/${shift2Id}`);
    const abList = abGet.data && abGet.data.absences || [];
    record('سجل الغيابات عبر SQLite (كتابة/قراءة)', abPost.ok && abList.some(a => a.name === 'غياب اختبار'), `absences=${abList.length}`);

    // ─── W1-C: Facade فوق الكتّاب الموازيين — أحداث موثقة + عقود بلا تغيير ───
    // ① حفظ الغياب أعلاه ولّد حدث absence تشغيليًا بختم سيرفري (staffing domain)
    const w1cTl1 = await api('GET', `/api/staffing/timeline?shift_id=${shift2Id}`);
    const w1cEv1 = (w1cTl1.data && w1cTl1.data.events) || [];
    const w1cAbs = w1cEv1.find(e => e.event_type === 'absence' && e.entity_id === 'غياب اختبار');
    record('W1-C ①: POST غياب جماعي ولّد حدث absence بختم سيرفري (actor/time/shift من السيرفر)',
        !!(w1cAbs && w1cAbs.shift_id === shift2Id && w1cAbs.actor_name && w1cAbs.created_at && w1cAbs.center === 'منفوحة'),
        `events=${w1cEv1.length} found=${!!w1cAbs}`);

    // ② إعادة إرسال نفس القائمة ⇒ صفر أحداث جديدة (منع التكرار في Bulk Replace)
    await api('POST', `/api/shift-absences/${shift2Id}`, { absences: [{ name: 'غياب اختبار', center: 'منفوحة' }] });
    const w1cTl2 = await api('GET', `/api/staffing/timeline?shift_id=${shift2Id}`);
    const w1cEv2 = (w1cTl2.data && w1cTl2.data.events) || [];
    record('W1-C ②: إعادة الاستبدال المتطابق لم تُنتج أحداثًا مكررة', w1cEv2.length === w1cEv1.length,
        `before=${w1cEv1.length} after=${w1cEv2.length}`);

    // ③ إزالة الاسم من القائمة (قائمة فارغة) ⇒ حدث correction موثق للمسحوب
    await api('POST', `/api/shift-absences/${shift2Id}`, { absences: [] });
    const w1cTl3 = await api('GET', `/api/staffing/timeline?shift_id=${shift2Id}`);
    const w1cEv3 = (w1cTl3.data && w1cTl3.data.events) || [];
    const w1cCorr = w1cEv3.find(e => e.event_type === 'correction' && e.entity_id === 'غياب اختبار');
    record('W1-C ③: سحب الغياب بالاستبدال وُثق كـ correction (التاريخ لا يُفقد)',
        w1cEv3.length === w1cEv2.length + 1 && !!w1cCorr && !!(w1cCorr.payload || '').includes('withdrawn'),
        `events=${w1cEv3.length} correction=${!!w1cCorr}`);

    // ④ DELETE فردي: حذف فيزيائي (العقد) + correction موثق — والقراءة القديمة تخلو من المحذوف
    await api('POST', `/api/shift-absences/${shift2Id}`, { absences: [{ name: 'غياب مؤقت', center: 'الشفاء' }] });
    const w1cAbGet = await api('GET', `/api/shift-absences/${shift2Id}`);
    const w1cAbItem = ((w1cAbGet.data && w1cAbGet.data.absences) || []).find(a => a.name === 'غياب مؤقت');
    const w1cDel = w1cAbItem ? await api('DELETE', `/api/shift-absences/${shift2Id}/${w1cAbItem.id}`) : { ok: false };
    const w1cAbGet2 = await api('GET', `/api/shift-absences/${shift2Id}`);
    const w1cAbList2 = (w1cAbGet2.data && w1cAbGet2.data.absences) || [];
    const w1cTl4 = await api('GET', `/api/staffing/timeline?shift_id=${shift2Id}`);
    const w1cEv4 = (w1cTl4.data && w1cTl4.data.events) || [];
    const w1cDelCorr = w1cEv4.find(e => e.event_type === 'correction' && e.entity_id === 'غياب مؤقت');
    record('W1-C ④: DELETE فردي ⇒ حذف فيزيائي (العقد) + correction موثق بالمحذوف',
        w1cDel.ok && w1cAbList2.length === 0 && !!w1cDelCorr && !!(w1cDelCorr.payload || '').includes('deleted'),
        `del=${w1cDel.ok} list=${w1cAbList2.length} correction=${!!w1cDelCorr}`);

    // ⑤ عقود الاستجابة كما هي: POST يرجع {success,event} وDELETE يرجع {success:true}
    const w1cEvShape = await api('POST', `/api/shift-events/${shift2Id}`, { type: 'عقد', description: 'تحقق شكل الاستجابة' });
    const w1cEvId = w1cEvShape.data && w1cEvShape.data.event && w1cEvShape.data.event.id;
    const w1cDelShape = w1cEvId ? await api('DELETE', `/api/shift-events/${shift2Id}/${w1cEvId}`) : { ok: false };
    record('W1-C ⑤: عقود Request/Response لم تتغير (event بنفس الحقول + delete بنجاح)',
        !!(w1cEvShape.ok && w1cEvShape.data.success === true && w1cEvShape.data.event
        && w1cEvShape.data.event.type === 'عقد' && w1cEvShape.data.event.shiftId === shift2Id
        && w1cEvShape.data.event.timestamp && w1cEvShape.data.event.createdAt)
        && w1cDelShape.ok && w1cDelShape.data && w1cDelShape.data.success === true,
        `post=${w1cEvShape.status} delete=${w1cDelShape.status}`);

    // ─── W1-D/V-A: لوحة المركبات — سجل مرجعي v9 بمعرف ثابت + اشتقاق سيرفري فقط ───
    // ① V-A (v9): السجل المرجعي الجديد — 26 مركبة من السجل الرسمي (veh_000001..26)
    //    بلا team_id وبلا حالة تشغيلية مخزنة (C9/C14/C17)
    const w1dReg = await api('GET', '/api/vehicles/registry');
    const w1dVehicles = (w1dReg.data && w1dReg.data.vehicles) || [];
    const w1dRegOk = w1dReg.ok && w1dVehicles.length === 26
        && w1dVehicles.every(v => /^veh_\d{6}$/.test(v.id) && !!v.plate_number && !!v.vehicle_type
            && !!v.admin_status && !('team_id' in v) && !('status' in v));
    record('V-A ①: سجل الأسطول v9 — 26 مركبة بمعرف ثابت وبلا team_id/status مخزنين', w1dRegOk, `count=${w1dVehicles.length}`);

    // ② كتابة حدث عبر المسار الجديد فقط: قبول صحيح (ختم سيرفري بالمناوبة النشطة)
    //    + رفض حالة غير صالحة (400) + رفض breakdown بلا سبب (400) + رفض مركبة غير موجودة (404)
    const w1dV1 = w1dVehicles[0] || {};
    const w1dBadStatus = await api('POST', '/api/vehicles/events', { vehicleId: w1dV1.id, status: 'flying' }, 400);
    const w1dNoReason = await api('POST', '/api/vehicles/events', { vehicleId: w1dV1.id, status: 'breakdown' }, 400);
    const w1dNotFound = await api('POST', '/api/vehicles/events', { vehicleId: 'veh_999999', status: 'active' }, 404);
    const w1dPost = await api('POST', '/api/vehicles/events', { vehicleId: w1dV1.id, status: 'breakdown', reason: 'عطل اختبار regression' });
    record('W1-D ②: POST /api/vehicles/events — قبول مختوم سيرفريًا + رفض (حالة/بلا سبب/مركبة غير موجودة)',
        w1dPost.ok && w1dPost.data && w1dPost.data.success === true && w1dPost.data.shiftId === shift2Id
        && w1dBadStatus.status === 400 && w1dNoReason.status === 400 && w1dNotFound.status === 404,
        `post=${w1dPost.status} badStatus=${w1dBadStatus.status} noReason=${w1dNoReason.status} notFound=${w1dNotFound.status}`);

    // ③ اللوحة تُشتق من operational_events فقط: العدادات + الحالة/السبب/since تطابق timeline
    //    V-A: العداد المتوقع breakdown=2 (افتتاحية veh_000017 + عطل الاختبار على veh_000001)
    const w1dBoard = await api('GET', `/api/vehicles/board?shift_id=${shift2Id}`);
    const w1dCounters = (w1dBoard.data && w1dBoard.data.counters) || {};
    const w1dBV = ((w1dBoard.data && w1dBoard.data.vehicles) || []).find(v => v.id === w1dV1.id);
    const w1dTl = await api('GET', `/api/vehicles/timeline?shift_id=${shift2Id}`);
    const w1dTlEv = ((w1dTl.data && w1dTl.data.events) || []).find(e => e.entity_id === w1dV1.id && e.status === 'breakdown');
    record('W1-D ③: اللوحة مشتقة من السجل (breakdown=2 + status/reason/since تطابق timeline)',
        w1dBoard.ok && w1dCounters.breakdown === 2 && !!w1dBV && w1dBV.status === 'breakdown'
        && w1dBV.reason === 'عطل اختبار regression' && !!w1dBV.since && !!w1dTlEv,
        `breakdown=${w1dCounters.breakdown} status=${w1dBV && w1dBV.status} timelineEvent=${!!w1dTlEv}`);

    // ④ بث لحظي: كتابة حدث مركبة تبث vehicles_updated عبر SSE (إعادة المركبة «عاملة»)
    let sseVehiclesUpdated = false;
    try {
        await new Promise((resolve) => {
            const timer = setTimeout(() => { try { sseV.close(); } catch (_) {} resolve(); }, 8000);
            const sseV = listenSSE(`/api/sse?token=${encodeURIComponent(TOKEN)}`, (m) => {
                if (m.type === 'vehicles_updated' && m.shiftId === shift2Id) {
                    sseVehiclesUpdated = true;
                    clearTimeout(timer); sseV.close(); resolve();
                }
            });
            sseV.onOpen(async () => {
                await api('POST', '/api/vehicles/events', { vehicleId: w1dV1.id, status: 'active' });
            });
        });
    } catch (e) {}
    record('W1-D ④: بث vehicles_updated لحظيًا عبر SSE عند كتابة حدث مركبة', sseVehiclesUpdated);

    // ⑤ لا مصدر حقيقة ثانٍ: جدول vehicles بلا عمود حالة تشغيلية وبلا team_id (v9/C14)
    //    + الواجهة بلا localStorage للمركبات + عناصر الواجهة موجودة
    const w1dFs = require('fs'), w1dPath = require('path');
    const w1dDbSrc = w1dFs.readFileSync(w1dPath.join(__dirname, '..', 'db.js'), 'utf8');
    const w1dRcSrc = w1dFs.readFileSync(w1dPath.join(__dirname, '..', 'public', 'radio-completion.html'), 'utf8');
    const w1dVehTable = (w1dDbSrc.match(/CREATE TABLE IF NOT EXISTS vehicles \(([\s\S]*?)\)/) || [])[1] || '';
    const w1dNoStatusCol = !/\bstatus\b/i.test(w1dVehTable) && !/\bteam_id\b/i.test(w1dVehTable);
    const w1dNoVehLS = !/localStorage\.(setItem|getItem)\([^)]*vehic/i.test(w1dRcSrc);
    const w1dUiOk = w1dRcSrc.includes('id="vehiclesSection"') && w1dRcSrc.includes('mini-log')
        && w1dRcSrc.includes("'vehicles_updated'") && w1dRcSrc.includes('loadVehiclesBoard();')
        && w1dRcSrc.includes('loadStaffingLog();');
    record('W1-D ⑤: لا مصدر حقيقة ثانٍ (جدول بلا status/team_id + واجهة بلا localStorage) + عناصر الواجهة موجودة',
        w1dNoStatusCol && w1dNoVehLS && w1dUiOk,
        `noStatusCol=${w1dNoStatusCol} noVehLS=${w1dNoVehLS} ui=${w1dUiOk}`);

    // ⑥ أداء اللوحة ضمن العتبة (<150ms)
    const w1dT0 = Date.now();
    const w1dBoardPerf = await api('GET', `/api/vehicles/board?shift_id=${shift2Id}`);
    const w1dBoardMs = Date.now() - w1dT0;
    record('W1-D ⑥: زمن جلب لوحة المركبات ضمن العتبة (<150ms)', w1dBoardPerf.ok && w1dBoardMs < 150, `ms=${w1dBoardMs}`);

    // ⑦ V-A (قرار المالك 1): اللوحة تعرض المركبات المعيّنة فقط — 14 بـ teamId (صفر تغيير مرئي)
    const vaBoardOnly = await api('GET', `/api/vehicles/board?shift_id=${shift2Id}`);
    const vaBoardVehicles = (vaBoardOnly.data && vaBoardOnly.data.vehicles) || [];
    record('V-A ⑦: اللوحة تعرض المعيّنة فقط (14 مركبة كلها بـ teamId — صفر تغيير مرئي)',
        vaBoardOnly.ok && vaBoardVehicles.length === 14 && vaBoardVehicles.every(v => v.teamId != null),
        `shown=${vaBoardVehicles.length}`);

    // ─── V-A: المراكز + أحداث الافتتاح + system_metadata + تصحيح C7 (قراءات DB مباشرة) ───
    if (process.env.DB_PATH) {
        const VaDB = require('better-sqlite3');
        const vadbc = new VaDB(process.env.DB_PATH, { readonly: true });
        try {
            // ⑧ المراكز التسعة الرسمية مزروعة (من teams.center الفعلية — بلا «الفرق الإضافية»)
            const centersRows = vadbc.prepare('SELECT * FROM centers').all();
            record('V-A ⑧: جدول centers مزروع بالمراكز التسعة الرسمية',
                centersRows.length === 9 && !centersRows.some(c => c.name === 'الفرق الإضافية'),
                `centers=${centersRows.length}`);

            // ⑨ أحداث الافتتاح: 52 دورة حياة + 2 عطل + 2 طلب صيانة + 14 تعيين = 70
            //    مختومة system-migration وبلا مناوبة (قرار المالك 2) — وidempotent (لا تكرار)
            const seedEv = vadbc.prepare(`SELECT event_type AS t, COUNT(*) AS c FROM operational_events
                WHERE domain='vehicle' AND actor_name='system-migration' GROUP BY event_type`).all();
            const seedMap = Object.fromEntries(seedEv.map(r => [r.t, r.c]));
            const nullShift = vadbc.prepare(`SELECT COUNT(*) AS c FROM operational_events
                WHERE domain='vehicle' AND actor_name='system-migration' AND shift_id IS NOT NULL`).get().c;
            record('V-A ⑨: أحداث الافتتاح (26 acquired + 26 entered_service + 2 breakdown + 2 maintenance_requested + 14 assignment) بلا مناوبة',
                seedMap.acquired === 26 && seedMap.entered_service === 26
                && seedMap.status_change === 2 && seedMap.maintenance_requested === 2
                && seedMap.assignment === 14 && nullShift === 0,
                JSON.stringify(seedMap) + ` nullShift=${nullShift}`);

            // ⑩ system_metadata: schema_version=2 / fleet_schema=v9 / migration=V-A
            const metaRows = vadbc.prepare('SELECT key, value FROM system_metadata').all();
            const metaMap = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
            record('V-A ⑩: system_metadata (schema_version=2 + fleet_schema=v9 + migration=V-A)',
                metaMap.schema_version === '2' && metaMap.fleet_schema === 'v9' && metaMap.migration === 'V-A',
                JSON.stringify(metaMap));

            // ⑪ تصحيح C7: سريع 3 = الخالدية / سريع 4 = المنصورة
            const fast3 = vadbc.prepare(`SELECT center FROM teams WHERE name = 'سريع 3'`).get();
            const fast4 = vadbc.prepare(`SELECT center FROM teams WHERE name = 'سريع 4'`).get();
            record('V-A ⑪: تصحيح مركزَي سريع 3/4 (C7)',
                !!(fast3 && fast3.center === 'الخالدية' && fast4 && fast4.center === 'المنصورة'),
                `fast3=${fast3 && fast3.center} fast4=${fast4 && fast4.center}`);

            // ⑫ مخطط vehicles بلا team_id وبلا status تشغيلية (C14/C17) — مستوى DB
            const vCols = vadbc.prepare('PRAGMA table_info(vehicles)').all().map(c => c.name);
            record('V-A ⑫: مخطط vehicles بلا team_id وبلا status (DB level)',
                !vCols.includes('team_id') && !vCols.includes('status'),
                vCols.join(','));

            // ⑬ مطابقة حقلية للسجل الرسمي: لوحتا veh_000001 وveh_000017 + مالك veh_000004 (C1)
            const v1 = vadbc.prepare(`SELECT * FROM vehicles WHERE id = 'veh_000001'`).get();
            const v17 = vadbc.prepare(`SELECT * FROM vehicles WHERE id = 'veh_000017'`).get();
            const v4 = vadbc.prepare(`SELECT v.owner_center_id, c.name AS cname FROM vehicles v
                LEFT JOIN centers c ON c.id = v.owner_center_id WHERE v.id = 'veh_000004'`).get();
            record('V-A ⑬: مطابقة السجل الرسمي (لوحة 8572/1989 + جنوب 4 ← الدار البيضاء C1)',
                !!(v1 && v1.plate_number === '8572 س ح ص' && v17 && v17.plate_number === '1989 ح ص ح'
                && v4 && v4.cname === 'الدار البيضاء'),
                `v1=${v1 && v1.plate_number} v17=${v17 && v17.plate_number} v4=${v4 && v4.cname}`);
        } finally { vadbc.close(); }
    }

    const ppPost = await api('POST', '/api/peak-plans', { title: 'خطة regression', location: 'موقع اختبار' });
    const ppGet = await api('GET', '/api/peak-plans');
    const ppList = ppGet.data && ppGet.data.plans || [];
    const pp = ppList.find(p => p.title === 'خطة regression');
    record('خطة الذروة تُحفظ في SQLite وتُختم بالمناوبة النشطة', ppPost.ok && !!pp && pp.shiftId === shift2Id, `shiftId=${pp && pp.shiftId} expected=${shift2Id}`);
    const ppUpd = pp ? await api('PUT', `/api/peak-plans/${pp.id}`, { title: 'خطة regression معدلة' }) : { ok: false, status: 0 };
    const ppAfter = await api('GET', '/api/peak-plans');
    const pp2 = (ppAfter.data && ppAfter.data.plans || []).find(p => p.id === (pp && pp.id));
    record('تعديل خطة التمركز ينعكس من المصدر الواحد (PositioningService)', ppUpd.ok && !!pp2 && pp2.title === 'خطة regression معدلة', `status=${ppUpd.status}`);
    const rePost = await api('POST', '/api/report-entry', { team: 'جنوب 1', caseType: 'regression' });
    const reGet = await api('GET', '/api/report-entry');
    const reList = reGet.data && reGet.data.records || [];
    const re = reList.find(r => r.caseType === 'regression');
    record('تفاصيل البلاغات عبر SQLite مع ختم المناوبة', rePost.ok && !!re && re.shiftId === shift2Id, `shiftId=${re && re.shiftId}`);
    if (re) await api('DELETE', `/api/report-entry/${re.id}`);
    if (pp) await api('DELETE', `/api/peak-plans/${pp.id}`);

    // ─── 12d. Slice 6: FormsService — all six form types via single owner (shift_forms) ───
    const incPost = await api('POST', '/api/incidents', { unit: 'reg-وحدة', type: 'regression' });
    const incGet = await api('GET', '/api/incidents');
    const inc = (incGet.data && incGet.data.records || []).find(r => r.unit === 'reg-وحدة');
    record('حادث يُحفظ في shift_forms ويُختم بالمناوبة النشطة (FormsService)', incPost.ok && !!inc && inc.shiftId === shift2Id, `shiftId=${inc && inc.shiftId} expected=${shift2Id}`);

    const ecPost = await api('POST', '/api/e-cases', { patient: 'reg-e-case' });
    const ecGet = await api('GET', '/api/e-cases');
    const ec = (ecGet.data && ecGet.data.records || []).find(r => r.patient === 'reg-e-case');
    record('حالة طوارئ (e_case) عبر المصدر الواحد', ecPost.ok && !!ec && ec.shiftId === shift2Id, `shiftId=${ec && ec.shiftId}`);

    const esPost = await api('POST', '/api/escalations', { title: 'reg-تصعيد' });
    const esGet = await api('GET', '/api/escalations');
    const es = (esGet.data && esGet.data.records || []).find(r => r.title === 'reg-تصعيد');
    record('بلاغ تصعيد (escalation) عبر المصدر الواحد', esPost.ok && !!es && es.shiftId === shift2Id, `shiftId=${es && es.shiftId}`);

    const ssPost = await api('POST', '/api/senior-shifts', { officer: 'reg-ضابط' });
    const ssGet = await api('GET', '/api/senior-shifts');
    const ss = (ssGet.data && ssGet.data.records || []).find(r => r.officer === 'reg-ضابط');
    record('مناوبة كبار الضباط (senior_shift) عبر المصدر الواحد', ssPost.ok && !!ss && ss.shiftId === shift2Id, `shiftId=${ss && ss.shiftId}`);

    const drPost = await api('POST', '/api/daily-reports', { title: 'reg-تقرير' });
    const drGet = await api('GET', '/api/daily-reports');
    const dr = (drGet.data && drGet.data.records || []).find(r => r.title === 'reg-تقرير');
    record('تقرير يومي (daily_report) عبر المصدر الواحد', drPost.ok && !!dr && dr.shiftId === shift2Id, `shiftId=${dr && dr.shiftId}`);

    const airBad = await api('POST', '/api/save-air-ambulance', { reportNumber: 'REG-AIR-1' });
    const airPost = await api('POST', '/api/save-air-ambulance', { reportNumber: 'REG-AIR-1', unit: 'جنوب 1', dateTime: '2099-01-01T10:00', destinationHospital: 'مستشفى regression' });
    const airGet = await api('GET', '/api/air-ambulance');
    const air = (airGet.data && airGet.data.records || []).find(r => r.reportNumber === 'REG-AIR-1');
    record('إسعاف جوي: تحقق الحقول + تعيين hospital + ختم المناوبة', airBad.status === 400 && airPost.ok && !!air && air.hospital === 'مستشفى regression' && air.shiftId === shift2Id, `bad=${airBad.status} hospital=${air && air.hospital} shiftId=${air && air.shiftId}`);

    const incDel = inc ? await api('DELETE', `/api/incidents/${inc.id}`) : { ok: false, status: 0 };
    const incGet2 = await api('GET', '/api/incidents');
    const incGone = !(incGet2.data && incGet2.data.records || []).some(r => r.unit === 'reg-وحدة');
    record('حذف نموذج من المصدر الواحد (FormsService)', incDel.ok && incGone, `del=${incDel.status} gone=${incGone}`);
    if (ec) await api('DELETE', `/api/e-cases/${ec.id}`);
    if (es) await api('DELETE', `/api/escalations/${es.id}`);
    if (ss) await api('DELETE', `/api/senior-shifts/${ss.id}`);
    if (dr) await api('DELETE', `/api/daily-reports/${dr.id}`);
    if (air) await api('DELETE', `/api/delete-air-ambulance/${air.id}`);

    // ─── 13. SSE live sync (shift_started + new_report) — OV-S6: SSE هي القناة التشغيلية الوحيدة ───
    // (كان هذا الاختبار يستمع عبر WebSocket — الازدواج القديم؛ عُدّل ليعكس العقد الجديد)
    let sseStarted = false, sseReport = false, ssePlanAdded = false, ssePlanDeleted = false, ssePlanId = null, sseNoteAdded = false;
    try {
        await new Promise((resolve) => {
            const timer = setTimeout(() => { try { sse.close(); } catch (_) {} resolve(); }, 10000);
            const sse = listenSSE(`/api/sse?token=${encodeURIComponent(TOKEN)}`, (m) => {
                if (m.type === 'shift_started') sseStarted = true;
                if (m.type === 'new_report' && m.center === 'منفوحة') sseReport = true;
                if (m.type === 'peak_plan_added' && m.plan && m.plan.title === 'خطة SSE regression') { ssePlanAdded = true; ssePlanId = m.plan.id; }
                if (m.type === 'peak_plan_deleted' && m.planId === ssePlanId) ssePlanDeleted = true;
                if (m.type === 'shift_note_added') sseNoteAdded = true;
                if (sseStarted && sseReport && ssePlanAdded && ssePlanDeleted && sseNoteAdded) { clearTimeout(timer); sse.close(); resolve(); }
            });
            sse.onOpen(async () => {
                const st = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
                const sseShift = st.data && st.data.shiftId;
                await api('POST', '/api/report', { center: 'منفوحة', unit: 'جنوب 3' });
                const wp = await api('POST', '/api/peak-plans', { title: 'خطة SSE regression', location: 'موقع SSE' });
                const pid = wp.data && wp.data.plan && wp.data.plan.id;
                if (pid) await api('DELETE', `/api/peak-plans/${pid}`);
                if (sseShift) await api('POST', `/api/shift-notes/${sseShift}`, { notes: [{ text: 'ملاحظة SSE regression' }] });
            });
        });
    } catch (e) {}
    record('التحديث اللحظي عبر SSE (new_report)', sseReport);
    record('بث بدء المناوبة لحظياً (shift_started عبر ShiftStarted)', sseStarted);
    record('بث إنشاء التمركز لحظياً (PositioningStarted ← peak_plan_added)', ssePlanAdded);
    record('بث إنهاء التمركز لحظياً (PositioningEnded ← peak_plan_deleted)', ssePlanDeleted);
    record('بث تحديث سجل الملاحظات لحظياً (ShiftNoteAdded ← shift_note_added)', sseNoteAdded);

    // ─── 13b. Archive slice: auto-archive + direct archive produce seals (bug fix verification) ───
    const autoSnap = await api('GET', `/api/shift-snapshot/${shift2Id}`);
    record('الأرشفة التلقائية تُنتج لقطة ختم (إصلاح الخلل)', autoSnap.ok && autoSnap.data && autoSnap.data.success && !!autoSnap.data.snapshot, `status=${autoSnap.status}`);
    const mk2 = await api('POST', '/api/update-shift-data', { shiftDate: '2099-01-02', shiftType: 'ليلية', shiftData: { generalNotes: 'disposable direct-archive regression' } });
    const mk2Id = mk2.data && mk2.data.shiftId;
    const dArch = mk2Id ? await api('POST', `/api/shift/${mk2Id}/archive`, { reason: 'regression direct' }) : { ok: false };
    const dSnap = mk2Id ? await api('GET', `/api/shift-snapshot/${mk2Id}`) : { ok: false };
    record('الأرشفة المباشرة تُنتج لقطة ختم (إصلاح الخلل)', !!(mk2Id && dArch.ok && dSnap.ok && dSnap.data && dSnap.data.success), `mk=${mk2Id} arch=${dArch.status} snap=${dSnap.status}`);
    if (mk2Id) await api('DELETE', `/api/shifts/${mk2Id}`);

    // ─── 13c. Event Activation Slice (Catalog D-3..D-7): adopted events broadcast via engine ───
    // (OV-S6: كان يستمع عبر WebSocket — الازدواج القديم؛ عُدّل للاستماع عبر SSE، القناة الوحيدة)
    let sseShiftDel = false, ssePlanUpd = false, sseNoteDel = false, sseFormDel = false, sseFormClr = false;
    try {
        await new Promise((resolve) => {
            const timer = setTimeout(() => { try { sse2.close(); } catch (_) {} resolve(); }, 12000);
            const sse2 = listenSSE(`/api/sse?token=${encodeURIComponent(TOKEN)}`, (m) => {
                if (m.type === 'shift_deleted') sseShiftDel = true;
                if (m.type === 'peak_plan_updated') ssePlanUpd = true;
                if (m.type === 'shift_note_deleted') sseNoteDel = true;
                if (m.type === 'incident_deleted') sseFormDel = true;
                if (m.type === 'air_ambulance_cleared') sseFormClr = true;
                if (sseShiftDel && ssePlanUpd && sseNoteDel && sseFormDel && sseFormClr) { clearTimeout(timer); sse2.close(); resolve(); }
            });
            sse2.onOpen(async () => {
                const p = await api('POST', '/api/peak-plans', { title: 'خطة تفعيل regression', location: 'موقع تفعيل' });
                const pid = p.data && p.data.plan && p.data.plan.id;
                if (pid) await api('PUT', `/api/peak-plans/${pid}`, { title: 'خطة تفعيل معدلة' });
                await api('POST', `/api/shift-notes/${shift2Id}`, { notes: [{ text: 'ملاحظة تفعيل regression' }] });
                const ng = await api('GET', `/api/shift-notes/${shift2Id}`);
                const target = ((ng.data && ng.data.notes) || []).find(x => x.text === 'ملاحظة تفعيل regression');
                if (target) await api('DELETE', `/api/shift-notes/${shift2Id}/${target.id}`);
                const f = await api('POST', '/api/incidents', { unit: 'reg-تفعيل' });
                const fid = f.data && f.data.record && f.data.record.id;
                if (fid) await api('DELETE', `/api/incidents/${fid}`);
                await api('POST', '/api/save-air-ambulance', { reportNumber: 'REG-CLR-1', unit: 'جنوب 1', dateTime: '2099-01-01T11:00', destinationHospital: 'مستشفى تفعيل' });
                await api('DELETE', '/api/clear-air-ambulance');
                const mk3 = await api('POST', '/api/update-shift-data', { shiftDate: '2099-01-03', shiftType: 'صباحية', shiftData: { generalNotes: 'disposable activation regression' } });
                const mk3Id = mk3.data && mk3.data.shiftId;
                if (mk3Id) await api('DELETE', `/api/shifts/${mk3Id}`);
                if (pid) await api('DELETE', `/api/peak-plans/${pid}`);
            });
        });
    } catch (e) {}
    record('بث PositioningUpdated لحظياً (Catalog D-4 ← peak_plan_updated)', ssePlanUpd);
    record('بث ShiftNoteDeleted لحظياً (Catalog D-5 ← shift_note_deleted)', sseNoteDel);
    record('بث FormDeleted لحظياً (Catalog D-6 ← incident_deleted)', sseFormDel);
    record('بث FormsCleared لحظياً (Catalog D-7 ← air_ambulance_cleared)', sseFormClr);
    record('بث ShiftDeleted لحظياً (Catalog D-3 ← shift_deleted)', sseShiftDel);

    // ─── 13d. F1: تكامل الواجهة (التمركز) — توسيع العقد + الإنهاء داخل الخدمة + إزالة الكود الميت ───
    const f1Payload = { title: 'خطة F1', location: 'موقع F1', planType: 'peak', teamType: 'advanced', unit: 'جنوب 5', notes: 'ملاحظة F1', lat: 24.1, lng: 46.1 };
    const f1Post = await api('POST', '/api/peak-plans', f1Payload);
    const f1Plans1 = await api('GET', '/api/peak-plans');
    const f1Found = ((f1Plans1.data && f1Plans1.data.plans) || []).find(p => p.title === 'خطة F1');
    const f1AllKept = !!f1Found && ['planType', 'teamType', 'unit', 'notes', 'lat', 'lng'].every(k => f1Found[k] === f1Payload[k]);
    record('F1: الخدمة تحفظ جميع حقول الواجهة كما هي (توسيع العقد)', f1Post.ok && f1AllKept, `id=${f1Found && f1Found.id}`);

    const f1Exp = await api('POST', '/api/peak-plans', { title: 'خطة F1 منتهية', location: 'موقع', endTime: '2020-01-01T10:00' });
    const f1ExpId = f1Exp.data && f1Exp.data.plan && f1Exp.data.plan.id;
    const f1Plans2 = await api('GET', '/api/peak-plans');
    const f1Swept = ((f1Plans2.data && f1Plans2.data.plans) || []).find(p => p.id === f1ExpId);
    record('F1: إنهاء الخطط المنتهية داخل الخدمة (Zero Business Logic)', f1Exp.ok && !!f1Swept && f1Swept.status === 'completed', `status=${f1Swept && f1Swept.status}`);

    const f1Html = await (await fetch(BASE + '/')).text();
    const f1IdsOk = ['id="peakTimeModal"', 'id="peakDeploymentsList"', 'id="peakKpiActive"', 'id="peakPlanForm"'].every(s => f1Html.includes(s));
    record('F1 UI: index.html يحوي عناصر التمركز وخالٍ من الكود الميت', f1IdsOk && !f1Html.includes("'peakDeployments'") && !f1Html.includes('/api/peak-deployments'), `ids=${f1IdsOk}`);

    const f1AppJs = await (await fetch(BASE + '/js/app.js')).text();
    record('F1 UI: app.js يربط بالمصدر الواحد', f1AppJs.includes('loadPeakPlans') && !f1AppJs.includes("localStorage.setItem('peakPlans'"));

    const f1WsJs = await (await fetch(BASE + '/js/websocket-sync.js')).text();
    record('F1 UI: تحديث التمركز يُعيد التحميل لحظياً (peak_plan_updated)', f1WsJs.includes("case 'peak_plan_updated'"));

    let f1ApiMs = 0;
    for (let i = 0; i < 20; i++) { const t0 = Date.now(); await api('GET', '/api/peak-plans'); f1ApiMs += Date.now() - t0; }
    let f1PageMs = 0;
    for (let i = 0; i < 5; i++) { const t0 = Date.now(); await fetch(BASE + '/'); f1PageMs += Date.now() - t0; }
    const f1ApiAvg = f1ApiMs / 20, f1PageAvg = f1PageMs / 5;
    record('F1 Performance: استجابة المسار والصفحة ضمن العتبة', f1ApiAvg < 200 && f1PageAvg < 500, `apiAvg=${f1ApiAvg.toFixed(1)}ms pageAvg=${f1PageAvg.toFixed(1)}ms`);

    if (f1Found) await api('DELETE', `/api/peak-plans/${f1Found.id}`);
    if (f1ExpId) await api('DELETE', `/api/peak-plans/${f1ExpId}`);

    // ─── 13e. F2: تكامل الواجهة (النماذج) — المصدر الواحد + إزالة مودال الجوي الميت ───
    const f2AppJs = await (await fetch(BASE + '/js/app.js')).text();
    const f2LoadersOk = ['loadIncidentRecords', 'loadERecords', 'loadEscalationRecords', 'loadDailyRecords', 'loadSeniorShifts'].every(s => f2AppJs.includes(s));
    const f2Keys = ['incidentRecords', 'seniorShiftRecords', 'eRecords', 'escalationRecords', 'dailyRecords', 'airRecords'];
    const f2NoWrites = f2Keys.every(k => !f2AppJs.includes("localStorage.setItem('" + k));
    record('F2 UI: محمّلات النماذج معرّفة ولا كتابات localStorage للمفاتيح الستة', f2LoadersOk && f2NoWrites, `loaders=${f2LoadersOk} noWrites=${f2NoWrites}`);

    const f2Html = await (await fetch(BASE + '/')).text();
    const f2FormsOk = f2Html.includes('id="formsModal"') && f2Html.includes('id="formContent"');
    record('F2 UI: مركز النماذج سليم ومودال الجوي الميت أُزيل', f2FormsOk && !f2Html.includes('airAmbulanceModal') && !f2Html.includes('airRecordsList'), `forms=${f2FormsOk}`);

    const f2AirBody = { reportNumber: 'F2-AIR-1', unit: 'جنوب 1', dateTime: '2099-01-01T10:00', pickupLocation: 'موقع F2', destinationHospital: 'مستشفى F2', diagnosis: 'تشخيص', reason: 'سبب', patientName: 'مريض', patientAge: 40, paramedic: 'مسعف' };
    const f2AirPost = await api('POST', '/api/save-air-ambulance', f2AirBody);
    const f2AirGet = await api('GET', '/api/air-ambulance');
    const f2Air = ((f2AirGet.data && f2AirGet.data.records) || []).find(r => r.reportNumber === 'F2-AIR-1');
    const f2AirStructured = !!f2Air && f2Air.pickupLocation === 'موقع F2' && f2Air.destinationHospital === 'مستشفى F2' && f2Air.diagnosis === 'تشخيص' && f2Air.reason === 'سبب' && f2Air.patientName === 'مريض' && f2Air.paramedic === 'مسعف';
    const f2AirCompat = !!f2Air && f2Air.hospital === 'مستشفى F2' && typeof f2Air.notes === 'string' && f2Air.notes.includes('موقع F2');
    record('F2: الجوي يحفظ الحقول المهيكلة كما هي + الحقول التوافقية', f2AirPost.ok && f2AirStructured && f2AirCompat, `structured=${f2AirStructured} compat=${f2AirCompat}`);

    const f2SenA = await api('POST', '/api/senior-shifts', { activeCars: 5, locations: ['الشفا'], assistantName: 'أ' });
    const f2SenB = await api('POST', '/api/senior-shifts', { workingCars: 7, overlapAreas: ['العزيزية'], asstName: 'ب' });
    const f2SenGet = await api('GET', '/api/senior-shifts');
    const f2SenList = (f2SenGet.data && f2SenGet.data.records) || [];
    const f2FoundA = f2SenList.find(r => r.assistantName === 'أ');
    const f2FoundB = f2SenList.find(r => r.asstName === 'ب');
    const f2SchemaA = !!f2FoundA && f2FoundA.activeCars === 5 && Array.isArray(f2FoundA.locations) && f2FoundA.locations[0] === 'الشفا';
    const f2SchemaB = !!f2FoundB && f2FoundB.workingCars === 7;
    record('F2: senior_shift يحفظ مخططي الواجهتين', f2SenA.ok && f2SenB.ok && f2SchemaA && f2SchemaB, `schemaA=${f2SchemaA} schemaB=${f2SchemaB}`);

    const f2EcPost = await api('POST', '/api/e-cases', { patient: 'f2-delete' });
    const f2EcId = f2EcPost.data && f2EcPost.data.record && f2EcPost.data.record.id;
    const f2EcDel = f2EcId ? await api('DELETE', `/api/e-cases/${f2EcId}`) : { ok: false, status: 0 };
    const f2EcGet = await api('GET', '/api/e-cases');
    const f2EcGone = !((f2EcGet.data && f2EcGet.data.records) || []).some(r => r.patient === 'f2-delete');
    record('F2: حذف نموذج بالمعرف عبر المصدر الواحد', f2EcPost.ok && !!f2EcId && f2EcDel.ok && f2EcGone, `id=${f2EcId} del=${f2EcDel.status} gone=${f2EcGone}`);

    const f2Routes = ['/api/incidents', '/api/e-cases', '/api/escalations', '/api/daily-reports', '/api/senior-shifts', '/api/air-ambulance'];
    const f2Avgs = {};
    let f2TotalMs = 0;
    for (const route of f2Routes) {
        let ms = 0;
        for (let i = 0; i < 10; i++) { const t0 = Date.now(); await api('GET', route); ms += Date.now() - t0; }
        f2Avgs[route] = ms / 10;
        f2TotalMs += ms;
    }
    const f2OverallAvg = f2TotalMs / 60;
    record('F2 Performance: مسارات النماذج الستة ضمن العتبة', f2OverallAvg < 200, `overallAvg=${f2OverallAvg.toFixed(1)}ms | ` + f2Routes.map(r => `${r}=${f2Avgs[r].toFixed(1)}ms`).join(' | '));

    if (f2Air) await api('DELETE', `/api/delete-air-ambulance/${f2Air.id}`);
    if (f2FoundA) await api('DELETE', `/api/senior-shifts/${f2FoundA.id}`);
    if (f2FoundB) await api('DELETE', `/api/senior-shifts/${f2FoundB.id}`);

    // ─── 13f. F3: Single Source Verification — نوع البلاغ من المصدر الواحد (report_times.type) ───
    const f3AppJs = await (await fetch(BASE + '/js/app.js')).text();
    record('F3 UI: app.js خالٍ من reportTypeStorage وsyncReportEntryData', !f3AppJs.includes('reportTypeStorage') && !f3AppJs.includes('syncReportEntryData'));

    let f3WriteCount = 0, f3WriteIdx = -1;
    while ((f3WriteIdx = f3AppJs.indexOf("localStorage.setItem('report", f3WriteIdx + 1)) !== -1) f3WriteCount++;
    record('F3 UI: صفر كتابات localStorage لمفاتيح البلاغات', f3WriteCount === 0, `writes=${f3WriteCount}`);

    const f3Center = 'الشفاء', f3Unit = 'جنوب 8', f3Type = 'إصابة';
    const f3Key = f3Center + '|' + f3Unit;
    const f3Post = await api('POST', '/api/report', { center: f3Center, unit: f3Unit, type: f3Type });
    const f3Data1 = await api('GET', '/api/data');
    const f3Entry1 = f3Data1.data && f3Data1.data.data && f3Data1.data.data[f3Key];
    const f3TypeOk = !!f3Entry1 && f3Entry1.types && f3Entry1.types[f3Type] === 1 && Array.isArray(f3Entry1.times) && f3Entry1.times.length === 1;
    record('F3: نوع البلاغ ينعكس من المصدر الواحد (types + times)', f3Post.ok && f3TypeOk, JSON.stringify(f3Entry1));

    const f3Undo = await api('POST', '/api/undo', { center: f3Center, unit: f3Unit });
    const f3Data2 = await api('GET', '/api/data');
    const f3Entry2 = f3Data2.data && f3Data2.data.data && f3Data2.data.data[f3Key];
    const f3Cleared = !!f3Entry2 && Array.isArray(f3Entry2.times) && f3Entry2.times.length === 0 && (!f3Entry2.types || !f3Entry2.types[f3Type]);
    record('F3: التراجع يحذف آخر زمن/نوع من المصدر الواحد (وهو التنظيف)', f3Undo.ok && f3Cleared, JSON.stringify(f3Entry2));

    const f3FnStart = f3AppJs.indexOf('function getShiftTypeBreakdown');
    const f3FnEnd = f3FnStart !== -1 ? f3AppJs.indexOf('\nfunction ', f3FnStart + 1) : -1;
    const f3FnBody = (f3FnStart !== -1 && f3FnEnd !== -1) ? f3AppJs.slice(f3FnStart, f3FnEnd) : '';
    record('F3 UI: getShiftTypeBreakdown معرّفة وجسمها بلا localStorage (مصدر واحد)', f3FnBody.length > 0 && !f3FnBody.includes('localStorage'), `bodyLen=${f3FnBody.length}`);

    let f3DataMs = 0;
    for (let i = 0; i < 20; i++) { const t0 = Date.now(); await api('GET', '/api/data'); f3DataMs += Date.now() - t0; }
    const f3DataAvg = f3DataMs / 20;
    record('F3 Performance: GET /api/data ضمن العتبة', f3DataAvg < 200, `avg=${f3DataAvg.toFixed(1)}ms`);

    // ─── 13g. F4: Daily Report Single Source — التقرير اليومي مشتق من المصدر الواحد ───
    // ① الاشتقاق الحي: بلاغات في مركزين ← التقرير يطابقها (المصدر reports لا shift_reports المجمد)
    const f4StartA = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
    const f4ShiftA = f4StartA.data && f4StartA.data.shiftId;
    await api('POST', '/api/report', { center: 'الشفاء', unit: 'جنوب 8', type: 'إصابة' });
    await api('POST', '/api/report', { center: 'الشفاء', unit: 'جنوب 8', type: 'إصابة' });
    await api('POST', '/api/report', { center: 'منفوحة', unit: 'جنوب 3', type: 'نقل مريض' });
    const f4Rep1 = await api('GET', `/api/daily-report?shiftId=${f4ShiftA}`);
    const f4D1 = f4Rep1.data || {};
    const f4Derived = f4D1.shift && f4D1.shift.totalReports === 3
        && f4D1.centerBreakdown && f4D1.centerBreakdown['الشفاء'] === 2 && f4D1.centerBreakdown['منفوحة'] === 1;
    record('F4: التقرير اليومي مشتق من المصدر الواحد لا الجدول المجمد', f4Rep1.ok && !!f4ShiftA && f4Derived, JSON.stringify(f4D1.shift));

    // ② التحديث اللحظي: التراجع عن بلاغ ← التقرير يعكس النقصان فوراً
    await api('POST', '/api/undo', { center: 'الشفاء', unit: 'جنوب 8' });
    const f4Rep2 = await api('GET', `/api/daily-report?shiftId=${f4ShiftA}`);
    const f4D2 = f4Rep2.data || {};
    const f4Live = f4D2.shift && f4D2.shift.totalReports === 2 && f4D2.centerBreakdown && f4D2.centerBreakdown['الشفاء'] === 1;
    record('F4: التقرير يعكس التراجع لحظياً (اشتقاق حي غير مجمد)', f4Rep2.ok && f4Live, `total=${f4D2.shift && f4D2.shift.totalReports}`);

    // تنظيف ①② أفضل جهد: إفراغ بلاغات المناوبة A
    await api('POST', '/api/undo', { center: 'الشفاء', unit: 'جنوب 8' });
    await api('POST', '/api/undo', { center: 'منفوحة', unit: 'جنوب 3' });

    // ③ X13: مناوبة B جديدة ← التقرير يقارنها بالأقدم A فعلاً (ترتيب محلي مطبّع)
    const f4StartB = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
    const f4ShiftB = f4StartB.data && f4StartB.data.shiftId;
    const f4Rep3 = await api('GET', `/api/daily-report?shiftId=${f4ShiftB}`);
    const f4Prev = f4Rep3.data && f4Rep3.data.previousShift;
    record('F4 X13: المقارنة تتم مع المناوبة الأقدم مباشرة', f4Rep3.ok && !!f4ShiftB && !!f4Prev && f4Prev.id === f4ShiftA, `prev=${f4Prev && f4Prev.id} expected=${f4ShiftA}`);

    // ④ fallback الهجرة: لا مناوبة بـ shift_reports دون reports في النسخة ← تحقق ساكن من مسار الـ fallback
    const f4Fs = require('fs'), f4Path = require('path');
    const f4SvcSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'services', 'report-service.js'), 'utf8');
    const f4SrvSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'server.js'), 'utf8');
    const f4FallbackOk = f4SvcSrc.includes('getShiftReports') && f4SvcSrc.includes('FROM shift_reports') && f4SrvSrc.includes('reportService.getShiftReports');
    record('F4: مسار fallback الهجرة (shift_reports) موجود في الخدمة والمسار', f4FallbackOk);

    // ⑤ التنظيف: server.js بلا مخلفات daily-reports.json والمسار الإداري؛ db.js بلا مخطط/namespace الميت
    const f4DbSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'db.js'), 'utf8');
    const f4SrvClean = !f4SrvSrc.includes('admin/daily-report') && !f4SrvSrc.includes('readDailyReports') && !f4SrvSrc.includes('DAILY_REPORTS_PATH');
    const f4DbClean = !f4DbSrc.includes('DailyReports') && !f4DbSrc.includes('CREATE TABLE IF NOT EXISTS daily_reports');
    record('F4: إزالة مخزن daily_reports الميت ومساره الإداري ودوال JSON', f4SrvClean && f4DbClean, `srv=${f4SrvClean} db=${f4DbClean}`);

    // ⑥ الأداء
    let f4Ms = 0;
    for (let i = 0; i < 20; i++) { const t0 = Date.now(); await api('GET', '/api/daily-report'); f4Ms += Date.now() - t0; }
    const f4Avg = f4Ms / 20;
    record('F4 Performance: GET /api/daily-report ضمن العتبة', f4Avg < 200, `avg=${f4Avg.toFixed(1)}ms`);

    // ─── 13h. F5a: Indicators Single Source — مؤشرات التشغيل من المصدر الواحد ───
    // ① توزيع المراكز حقيقي: قياس قبل/بعد بلاغين بمركزين (المناوبة النشطة من 13g)
    const f5Base = await api('GET', '/api/indicators/dashboard');
    const f5BaseC = (f5Base.data && f5Base.data.centerDistribution) || [];
    const f5B1 = (f5BaseC.find(c => c.center === 'الشفاء') || { count: 0 }).count;
    const f5B2 = (f5BaseC.find(c => c.center === 'منفوحة') || { count: 0 }).count;
    await api('POST', '/api/report', { center: 'الشفاء', unit: 'جنوب 8', type: 'إصابة' });
    await api('POST', '/api/report', { center: 'منفوحة', unit: 'جنوب 3', type: 'نقل مريض' });
    const f5After = await api('GET', '/api/indicators/dashboard');
    const f5AfterC = (f5After.data && f5After.data.centerDistribution) || [];
    const f5A1 = (f5AfterC.find(c => c.center === 'الشفاء') || { count: 0 }).count;
    const f5A2 = (f5AfterC.find(c => c.center === 'منفوحة') || { count: 0 }).count;
    record('F5a: توزيع المراكز حقيقي من reports عبر قراءة F4 (+1 لكل مركز)', f5After.ok && f5A1 === f5B1 + 1 && f5A2 === f5B2 + 1, `الشفاء ${f5B1}→${f5A1} | منفوحة ${f5B2}→${f5A2}`);

    // ② اللوحة مربوطة بالمصدر الواحد بلا بيانات ثابتة
    const f5Html = await (await fetch(BASE + '/operations-dashboard.html')).text();
    const f5UiOk = !f5Html.includes('[12,8,15,10,7,5,3]') && !f5Html.includes('(placeholder') && f5Html.includes('/api/indicators/dashboard');
    record('F5a UI: operations-dashboard بلا بيانات ثابتة ومربوطة بالمسار الجديد', f5UiOk);

    // ③ (قرار B مُحدَّث بعد OV-S9-02): المسار لم يعد صفرياً مجمداً — يحسب حياً من
    // SQLite (SSOT). التحقق الحتمي: يوم فارغ صراحة (?date=1999-01-01) ⇒ أصفار صادقة
    // بلا بيانات مختلقة. (النسخة السابقة قارنت تاريخ UTC بـ shift_date المحلي فكانت
    // تنجح ليلاً فقط 00:00–03:00 الرياض — تجليّ الدين D-37، وليس سلوكاً مقصوداً.)
    const f5Guarded = await api('GET', '/api/shifts/daily-dashboard?date=1999-01-01');
    const f5G = f5Guarded.data || {};
    const f5GuardedSame = f5Guarded.ok && f5G.success === true && f5G.total_shifts === 0 && f5G.total_reports === 0;
    record('F5a: المسارات المحروسة — أصفار صادقة ليوم فارغ (حساب حي من SSOT بلا اختلاق)', f5GuardedSame, `total_shifts=${f5G.total_shifts} total_reports=${f5G.total_reports}`);

    // ④ server.js بلا 'unified' + الملفان محذوفان
    const f5SrvSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'server.js'), 'utf8');
    const f5UnifiedGone = !f5SrvSrc.includes('unified');
    const f5FilesGone = !f4Fs.existsSync(f4Path.join(__dirname, '..', 'unified-api-routes.js')) && !f4Fs.existsSync(f4Path.join(__dirname, '..', 'unified-data-layer.js'));
    record('F5a: حذف unified-* من server.js والملفين', f5UnifiedGone && f5FilesGone, `src=${f5UnifiedGone} files=${f5FilesGone}`);

    // ⑤ الملف الساعي الحقيقي من report_times (24 مفتاح ساعة، قيم رقمية)
    const f5Hourly = f5After.data && f5After.data.hourlyProfile;
    const f5HourlyOk = !!f5Hourly && Object.keys(f5Hourly).length === 24 && Object.keys(f5Hourly).every(k => /^\d{2}$/.test(k) && typeof f5Hourly[k] === 'number');
    record('F5a: الملف الساعي موجود وبنيته صحيحة (24 ساعة رقمية)', f5HourlyOk, `keys=${f5Hourly ? Object.keys(f5Hourly).length : 0}`);

    // ⑥ الأداء + تنظيف ① أفضل جهد
    let f5Ms = 0;
    for (let i = 0; i < 20; i++) { const t0 = Date.now(); await api('GET', '/api/indicators/dashboard'); f5Ms += Date.now() - t0; }
    const f5Avg = f5Ms / 20;
    record('F5a Performance: GET /api/indicators/dashboard ضمن العتبة', f5Avg < 200, `avg=${f5Avg.toFixed(1)}ms`);
    await api('POST', '/api/undo', { center: 'الشفاء', unit: 'جنوب 8' });
    await api('POST', '/api/undo', { center: 'منفوحة', unit: 'جنوب 3' });

    // ─── 13i. F5b: Zero Fake Data — صفر بيانات وهمية في الواجهة ───
    // (بند liveTimeline مجمّد رسمياً بقرار المالك — فحص timeline القديم ⑥ مُلغى مع التجميد)
    const f5bAppSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    const f5bIdxSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const f5bOpsSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'operations-dashboard.html'), 'utf8');

    // ① Math.random في app.js === 1 بالضبط (شريط الرفع التجميلي فقط)
    const f5bRandomCount = (f5bAppSrc.match(/Math\.random/g) || []).length;
    record('F5b ①: Math.random في app.js === 1 (شريط الرفع التجميلي فقط)', f5bRandomCount === 1, `count=${f5bRandomCount}`);

    // ② علامات الوهم زالت (قاعدة 15/8/3، عشوائية الأسبوعي، عشوائية الحرارية) + دوال الرسوم تقرأ من المرآة/الحزمة
    const f5bFakeGone = !f5bAppSrc.includes('(i >= 16 && i <= 22) ? 15')
        && !f5bAppSrc.includes('Math.floor(Math.random() * 40) + 20')
        && !f5bAppSrc.includes('intensity = Math.floor(Math.random() * 10)');
    const f5bHourlyReal = /function renderHourlyChart\(\)[\s\S]{0,1200}?\.times/.test(f5bAppSrc);
    const f5bHeatmapReal = /function renderHeatmap\(\)[\s\S]{0,1200}?\.times/.test(f5bAppSrc);
    const f5bWeeklyReal = /function renderWeeklyChart\(\)[\s\S]{0,1600}?indicators\/dashboard/.test(f5bAppSrc);
    record('F5b ②: علامات الوهم زالت والرسوم تقرأ من المرآة/حزمة المؤشرات', f5bFakeGone && f5bHourlyReal && f5bHeatmapReal && f5bWeeklyReal, `fakeGone=${f5bFakeGone} hourly=${f5bHourlyReal} heatmap=${f5bHeatmapReal} weekly=${f5bWeeklyReal}`);

    // ③ QR: صفر مراجع (generateAllQRCodes/createQRCard/qrCodesBtn) في public/
    const f5bQrTokens = ['generateAllQRCodes', 'createQRCard', 'qrCodesBtn'];
    const f5bQrHits = [];
    (function scanPublic(dir) {
        for (const entry of f4Fs.readdirSync(dir, { withFileTypes: true })) {
            const p = f4Path.join(dir, entry.name);
            if (entry.isDirectory()) { scanPublic(p); continue; }
            if (!/\.(html|js|css)$/i.test(entry.name)) continue;
            const src = f4Fs.readFileSync(p, 'utf8');
            for (const t of f5bQrTokens) { if (src.includes(t)) f5bQrHits.push(entry.name + ':' + t); }
        }
    })(f4Path.join(__dirname, '..', 'public'));
    record('F5b ③: صفر مراجع QR (generateAllQRCodes/createQRCard/qrCodesBtn) في public/', f5bQrHits.length === 0, f5bQrHits.join(' | ') || 'clean');

    // ④ Gamification (P1-S9): إزالة كاملة بلا يتيم — صفر renderAchievements/achievementsModal/gamificationStats/leaderboard
    const f5bAchApp = (f5bAppSrc.match(/renderAchievements|gamificationStats|unlockedAchievements|renderLeaderboard/g) || []).length;
    const f5bAchIdx = (f5bIdxSrc.match(/achievementsModal|leaderboardTable|renderAchievements/g) || []).length;
    const f5bSidebarAch = f5bAppSrc.includes('sidebarAchievements') || f5bIdxSrc.includes('sidebarAchievements');
    record('F5b ④: Gamification مُزالة بالكامل بلا يتيم (P1-S9: صفر renderAchievements/gamificationStats/achievementsModal/leaderboard)', f5bAchApp === 0 && f5bAchIdx === 0 && !f5bSidebarAch, `app=${f5bAchApp} index=${f5bAchIdx} sidebar=${f5bSidebarAch}`);

    // ⑤ التصدير: operations-dashboard تفتح daily-report.html
    const f5bGenMatch = f5bOpsSrc.match(/function generateDailyReport\(\)\s*\{[\s\S]{0,300}?\}/);
    const f5bExportOk = !!f5bGenMatch && f5bGenMatch[0].includes("window.open('daily-report.html', '_blank')") && !f5bGenMatch[0].includes('showToast');
    record('F5b ⑤: تصدير operations-dashboard يفتح daily-report.html', f5bExportOk, f5bGenMatch ? 'function found' : 'function NOT found');

    // ─── 13j. No Fabricated Defaults — إزالة الافتراضي المختلق (بقرار المالك بعد F5b) ───
    const f5bNoFabricated = !f5bAppSrc.includes('staffCount) || 2');
    record('F5b+ ⑥: لا افتراضي مختلق في staffCount (|| 2 أُزيل — الحالة الصادقة «—» عند الغياب)', f5bNoFabricated, f5bNoFabricated ? 'clean' : 'fabricated default found');

    // ─── 13k. F6: Source of Truth Validation — smart-schedule SoT ───
    const f6RcSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'radio-completion.html'), 'utf8');
    const f6SsSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'smart-schedule.html'), 'utf8');
    const f6WsSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'js', 'websocket-sync.js'), 'utf8');
    const f6AdmSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'public', 'admin-dashboard.html'), 'utf8');

    // ① الخادم يغلب الكاش: الجلب الخادمي يسبق مراجع الكاش نصياً في مسارَي الفتح
    const f6RcRegion = f6RcSrc.slice(f6RcSrc.indexOf('function loadFromSmartSchedule()'), f6RcSrc.indexOf('function showNoScheduleData'));
    const f6RcOrder = f6RcRegion.indexOf('/api/schedule/employees') !== -1
        && f6RcRegion.indexOf('/api/schedule/employees') < f6RcRegion.indexOf('loadFromIndexedDBFallback')
        && f6RcRegion.indexOf('/api/schedule/employees') < f6RcRegion.indexOf('indexedDB.open');
    const f6SsSetup = f6SsSrc.slice(f6SsSrc.indexOf('async function setupDemoData()'), f6SsSrc.indexOf('function generateDemoData'));
    const f6SsOrder = f6SsSetup.indexOf('fetchEmployeesFromServerSilent') !== -1
        && f6SsSetup.indexOf('fetchEmployeesFromServerSilent') < f6SsSetup.indexOf('loadFromIndexedDB');
    record('F6 ①: الخادم يغلب الكاش — الجلب الخادمي أولاً في مسارَي الفتح (radio + smart-schedule)', f6RcOrder && f6SsOrder, `radio=${f6RcOrder} schedule=${f6SsOrder}`);

    // ② الكاش fallback فقط (بعد الجلب الخادمي نصياً) + الجلب الصامت بلا Toast
    const f6SsFetcher = f6SsSrc.slice(f6SsSrc.indexOf('async function fetchEmployeesFromServerSilent'), f6SsSrc.indexOf('// F6: اعتماد بيانات الخادم'));
    const f6SilentOk = !f6SsFetcher.includes('showToast') && !f6RcRegion.includes('showToast');
    const f6RcFallbackOnly = f6RcRegion.indexOf('/api/schedule/employees') < f6RcRegion.indexOf("localStorage.getItem('ss_employees')");
    const f6SsFallbackOnly = f6SsSetup.indexOf('fetchEmployeesFromServerSilent') < f6SsSetup.indexOf('loadFromLocalStorage');
    record('F6 ②: الكاش fallback فقط عند الفشل/الفراغ + الجلب الصامت بلا Toast', f6SilentOk && f6RcFallbackOnly && f6SsFallbackOnly, `silent=${f6SilentOk} rcCache=${f6RcFallbackOnly} ssCache=${f6SsFallbackOnly}`);

    // ③ تحديث الكاش بعد النجاح (write-through) في الصفحتين
    const f6SsAdopt = f6SsSrc.slice(f6SsSrc.indexOf('function adoptServerEmployees'), f6SsSrc.indexOf('async function saveToServer'));
    const f6SsWT = f6SsAdopt.includes('saveToIndexedDB()') && f6SsAdopt.includes('saveToLocalStorage()');
    const f6RcWTfn = f6RcSrc.slice(f6RcSrc.indexOf('function writeEmployeesToCaches'), f6RcSrc.indexOf('// F6: قراءة الكاش'));
    const f6RcWT = f6RcWTfn.includes("localStorage.setItem('ss_employees'") && f6RcWTfn.includes('indexedDB.open');
    const f6RcWTcalled = f6RcRegion.includes('writeEmployeesToCaches(serverEmployees)');
    record('F6 ③: write-through للكاشين بعد نجاح الجلب الخادمي في الصفحتين', f6SsWT && f6RcWT && f6RcWTcalled, `schedule=${f6SsWT} radio=${f6RcWT} called=${f6RcWTcalled}`);

    // ④ تطابق الشاشتين على المصدر الواحد: static + runtime (POST⇒GET للموظفين والملفات، سجل اختباري يُنظَّف)
    const f6BothFetch = f6RcSrc.includes("'/api/schedule/employees'") && f6SsSrc.includes("'/api/schedule/employees'");
    const f6EmpOrig = await api('GET', '/api/schedule/employees');
    const f6EmpList = (f6EmpOrig.data && f6EmpOrig.data.employees) || [];
    const f6TestEmp = { id: 'F6TEST_EMP', name: 'موظف اختبار F6', jobTitle: 'اختبار', phone: '', team: '', schedule: [] };
    const f6EmpMod = f6EmpList.concat([f6TestEmp]);
    const f6EmpPut = await api('POST', '/api/schedule/employees', { employees: f6EmpMod });
    const f6EmpAfter = await api('GET', '/api/schedule/employees');
    const f6EmpMatch = f6EmpAfter.ok && JSON.stringify((f6EmpAfter.data && f6EmpAfter.data.employees) || []) === JSON.stringify(f6EmpMod);
    await api('POST', '/api/schedule/employees', { employees: f6EmpList }); // حذف السجل الاختباري = استعادة الحالة
    const f6EmpBack = await api('GET', '/api/schedule/employees');
    const f6EmpRestored = JSON.stringify((f6EmpBack.data && f6EmpBack.data.employees) || []) === JSON.stringify(f6EmpList);
    const f6FilesOrig = await api('GET', '/api/schedule/files');
    const f6FilesList = (f6FilesOrig.data && f6FilesOrig.data.files) || [];
    const f6TestFile = { id: 987654321, name: 'F6TEST.xlsx', type: 'xlsx', size: 1, date: new Date().toISOString() };
    const f6FilesMod = [f6TestFile].concat(f6FilesList);
    await api('POST', '/api/schedule/files', { files: f6FilesMod });
    const f6FilesAfter = await api('GET', '/api/schedule/files');
    const f6FilesMatch = JSON.stringify((f6FilesAfter.data && f6FilesAfter.data.files) || []) === JSON.stringify(f6FilesMod);
    await api('POST', '/api/schedule/files', { files: f6FilesList }); // استعادة
    record('F6 ④: تطابق الشاشتين على /api/schedule/employees + runtime POST⇒GET (موظفون وملفات)', f6BothFetch && f6EmpPut.ok && f6EmpMatch && f6EmpRestored && f6FilesMatch, `static=${f6BothFetch} emp=${f6EmpMatch} restore=${f6EmpRestored} files=${f6FilesMatch}`);

    // ⑤ لا مصدر أول محلي: صفر مفتاح الملفات المحلي، مستمعا المزامنة (SSE) صحيحان، تعريف loadFromServer واحد، المفاتيح الأربعة غائبة، لا بذور موظفين ثابتة
    const f6NoSavedFiles = !f6SsSrc.includes('ss_savedFiles');
    const f6WsEmp = f6WsSrc.includes('fetchEmployeesFromServerSilent');
    const f6WsFiles = f6WsSrc.includes('loadSavedFiles');
    const f6SsFilesApi = /function loadSavedFiles[\s\S]{0,600}?\/api\/schedule\/files/.test(f6SsSrc);
    const f6OneLfs = (f6SsSrc.match(/function loadFromServer\(/g) || []).length === 1;
    const f6KeysGone = !f6AdmSrc.includes('importedEmployees') && !f6AdmSrc.includes('plannerEmployees') && !f6AdmSrc.includes('lastImportedFile') && !f6AdmSrc.includes('shift-planner-data');
    const f6NoSeeds = !f6RcSrc.includes('generateDemoData') && /function generateDemoData\(\)[\s\S]{0,500}?return \[\];/.test(f6SsSrc);
    record('F6 ⑤: لا مصدر أول محلي (مفتاح الملفات صفر، مستمعا المزامنة SSE، loadFromServer واحد، المفاتيح الأربعة، لا بذور)', f6NoSavedFiles && f6WsEmp && f6WsFiles && f6SsFilesApi && f6OneLfs && f6KeysGone && f6NoSeeds, `files=${f6NoSavedFiles} sync=${f6WsEmp}/${f6WsFiles} api=${f6SsFilesApi} lfs=${f6OneLfs} keys=${f6KeysGone} seeds=${f6NoSeeds}`);

    // ⑥ Phase 2 Final Cleanup: زر «تحميل من السيرفر» اليدوي مربوط بالمصدر الرسمي المؤقت (JSON) لا بالمسار العلائقي الفارغ (إصلاح خلل — كان مكسوراً إنتاجياً)
    const f6BtnWired = f6SsSrc.includes('onclick="loadFromServerManual()"');
    const f6BtnHandler = /async function loadFromServerManual\(\)[\s\S]{0,800}?fetchEmployeesFromServerSilent/.test(f6SsSrc);
    const f6BtnNotRelational = !f6SsSrc.includes('onclick="loadFromServer()"');
    record('F6 ⑥: زر «تحميل من السيرفر» مربوط بالمصدر JSON (إصلاح خلل — كان علائقياً فارغاً)', f6BtnWired && f6BtnHandler && f6BtnNotRelational, `wired=${f6BtnWired} handler=${f6BtnHandler} notRelational=${f6BtnNotRelational}`);

    // ─── 13l. W1-E-B: قراءات shift-events/absences مشتقة + Parity حرفي صارم ───
    // قارئ توافقي مباشر من SQLite (نفس منطق contentListByShift حرفيًا) لمقارنة
    // حقلًا-بحقل: أسماء الحقول، الأنواع، القيم، والترتيب — شفافية 100% للمستهلك.
    function w1ebCompat(table, sid) {
        if (!process.env.DB_PATH) return null;
        const Database = require('better-sqlite3');
        const dbc = new Database(process.env.DB_PATH, { readonly: true });
        const rows = dbc.prepare(`SELECT * FROM ${table} WHERE shift_id = ? ORDER BY created_at DESC, id DESC`).all(sid);
        dbc.close();
        return rows.map(r => { let d = {}; try { d = JSON.parse(r.data); } catch (_) {} return { ...d, id: r.id, shiftId: r.shift_id }; });
    }
    function w1ebParity(apiRows, dbRows) {
        if (!Array.isArray(apiRows) || !Array.isArray(dbRows) || apiRows.length !== dbRows.length) return false;
        for (let i = 0; i < apiRows.length; i++) {
            const a = apiRows[i], b = dbRows[i];
            if (Object.keys(a).sort().join('|') !== Object.keys(b).sort().join('|')) return false;
            for (const k of Object.keys(a)) {
                if (typeof a[k] !== typeof b[k]) return false;
                if (a[k] !== b[k]) return false;
            }
        }
        return true;
    }

    const w1ebStart = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
    const w1ebShift = w1ebStart.data && w1ebStart.data.shiftId;

    // أحداث المناوبة: POST حدثين ⇒ Parity؛ DELETE الأول ⇒ Parity
    const w1ebEvP1 = await api('POST', `/api/shift-events/${w1ebShift}`, { type: 'صيانة', description: 'فحص دوري للمركبة' });
    await api('POST', `/api/shift-events/${w1ebShift}`, { type: 'دعم', description: 'وصول دعم لوجستي' });
    const w1ebEvG1 = await api('GET', `/api/shift-events/${w1ebShift}`);
    record('W1-E-B ①: Parity حرفي لسجل الأحداث بعد POST (مشتق ≡ توافقي: حقول/أنواع/قيم/ترتيب)',
        !!(w1ebShift && w1ebEvG1.ok && w1ebParity(w1ebEvG1.data && w1ebEvG1.data.events, w1ebCompat('shift_events', w1ebShift))),
        `api=${(w1ebEvG1.data && w1ebEvG1.data.events || []).length} db=${(w1ebCompat('shift_events', w1ebShift) || []).length}`);
    const w1ebEvId1 = w1ebEvP1.data && w1ebEvP1.data.event && w1ebEvP1.data.event.id;
    await api('DELETE', `/api/shift-events/${w1ebShift}/${w1ebEvId1}`);
    const w1ebEvG2 = await api('GET', `/api/shift-events/${w1ebShift}`);
    record('W1-E-B ②: Parity حرفي بعد DELETE (الحذف الموثق ينعكس في المشتق)',
        w1ebParity(w1ebEvG2.data && w1ebEvG2.data.events, w1ebCompat('shift_events', w1ebShift)),
        `api=${(w1ebEvG2.data && w1ebEvG2.data.events || []).length}`);

    // الغيابات (بمعرفات صريحة — العقد الرسمي المستقر): bulk ⇒ Parity
    await api('POST', `/api/shift-absences/${w1ebShift}`, { absences: [
        { id: 'w1eb-a1', name: 'غياب أول', center: 'منفوحة' },
        { id: 'w1eb-a2', name: 'غياب ثانٍ', center: 'الشفاء' }
    ] });
    const w1ebAbG1 = await api('GET', `/api/shift-absences/${w1ebShift}`);
    record('W1-E-B ③: Parity حرفي للغيابات بعد الاستبدال الجماعي',
        w1ebParity(w1ebAbG1.data && w1ebAbG1.data.absences, w1ebCompat('shift_absences', w1ebShift)),
        `api=${(w1ebAbG1.data && w1ebAbG1.data.absences || []).length}`);
    // سحب «غياب أول» بالاستبدال ⇒ Parity (correction يزيله من المشتق)
    await api('POST', `/api/shift-absences/${w1ebShift}`, { absences: [{ id: 'w1eb-a2', name: 'غياب ثانٍ', center: 'الشفاء' }] });
    const w1ebAbG2 = await api('GET', `/api/shift-absences/${w1ebShift}`);
    record('W1-E-B ④: Parity حرفي بعد سحب غياب بالاستبدال (withdrawn يُقصى من المشتق)',
        w1ebParity(w1ebAbG2.data && w1ebAbG2.data.absences, w1ebCompat('shift_absences', w1ebShift)),
        `api=${(w1ebAbG2.data && w1ebAbG2.data.absences || []).length}`);
    // حذف فردي ⇒ Parity (قائمة فارغة من مصدرين)
    await api('DELETE', `/api/shift-absences/${w1ebShift}/w1eb-a2`);
    const w1ebAbG3 = await api('GET', `/api/shift-absences/${w1ebShift}`);
    record('W1-E-B ⑤: Parity حرفي بعد الحذف الفردي (فارغ من المصدرين)',
        w1ebParity(w1ebAbG3.data && w1ebAbG3.data.absences, w1ebCompat('shift_absences', w1ebShift)),
        `api=${(w1ebAbG3.data && w1ebAbG3.data.absences || []).length}`);

    // ⑥ السقوط الصادق: مناوبة إنتاجية قديمة بلا أحداث ⇒ القراءة التوافقية حرفيًا (D1)
    let w1ebLegacyOk = false, w1ebLegacyId = null;
    const w1ebShifts = await api('GET', '/api/shifts');
    for (const s of (w1ebShifts.data || []).slice(0, 15)) {
        if (s.id === w1ebShift) continue;
        const tl = await api('GET', `/api/staffing/timeline?shift_id=${s.id}`);
        if (((tl.data && tl.data.events) || []).length > 0) continue;
        const gE = await api('GET', `/api/shift-events/${s.id}`);
        const gA = await api('GET', `/api/shift-absences/${s.id}`);
        if (gE.ok && gA.ok && w1ebParity(gE.data.events, w1ebCompat('shift_events', s.id))
            && w1ebParity(gA.data.absences, w1ebCompat('shift_absences', s.id))) {
            w1ebLegacyOk = true; w1ebLegacyId = s.id; break;
        }
    }
    record('W1-E-B ⑥: مناوبة قديمة بلا أحداث تُقرأ توافقيًا بـ Parity حرفي (سقوط صادق)',
        w1ebLegacyOk, `legacyShift=${w1ebLegacyId}`);

    if (w1ebShift) await api('DELETE', `/api/shifts/${w1ebShift}`);

    // ─── 13l-2. W1-E-C: قسم completions في تفاصيل الأرشيف — اشتقاق هجين (النطاق مقيد بقرار المالك) ───
    function w1ecStable(o) {
        if (Array.isArray(o)) return '[' + o.map(w1ecStable).join(',') + ']';
        if (o && typeof o === 'object') return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + w1ecStable(o[k])).join(',') + '}';
        return JSON.stringify(o);
    }

    // ① مناوبة بأحداث ⇒ قسم completions مشتق هجينًا ويطابق completion/latest حرفيًا (نفس المصدر)
    const w1ecArch = await api('GET', `/api/shifts/${shiftId}`);
    const w1ecLatestTeams = ((await api('GET', `/api/completion/latest?shift_id=${shiftId}`)).data.completion || {}).teams;
    const w1ecComp = w1ecArch.data && w1ecArch.data.completions;
    record('W1-E-C ①: completions الأرشيف مشتقة هجينًا (ready/offline + paramedics من الإسقاط) وتطابق completion/latest حرفيًا',
        !!(w1ecArch.ok && w1ecComp && w1ecComp['جنوب 7'] && w1ecComp['جنوب 7'].status === 'ready'
        && w1ecComp['جنوب 9'] && w1ecComp['جنوب 9'].status === 'offline'
        && w1ecComp['جنوب 3'] && JSON.stringify(w1ecComp['جنوب 3'].paramedics) === JSON.stringify(['مسعف أول', 'مسعف ثانٍ'])
        && w1ecStable(w1ecComp) === w1ecStable(w1ecLatestTeams)),
        `s7=${w1ecComp && w1ecComp['جنوب 7'] && w1ecComp['جنوب 7'].status} parity=${w1ecStable(w1ecComp) === w1ecStable(w1ecLatestTeams)}`);

    // ② مناوبة قديمة بلا أحداث ⇒ الفرع القديم حرفيًا (F1 محفوظ — دين موثق لا يُصلح هنا)
    let w1ecLegacyOk = false, w1ecLegacyId = null;
    if (process.env.DB_PATH) {
        const W1ecDB = require('better-sqlite3');
        const dbc = new W1ecDB(process.env.DB_PATH, { readonly: true });
        const cand = dbc.prepare('SELECT DISTINCT shift_id FROM shift_completions WHERE shift_id IS NOT NULL').all();
        for (const r of cand) {
            const tl = await api('GET', `/api/staffing/timeline?shift_id=${r.shift_id}`);
            if (((tl.data && tl.data.events) || []).length > 0) continue;
            const rows = dbc.prepare('SELECT * FROM shift_completions WHERE shift_id = ? ORDER BY id DESC').all(r.shift_id);
            const expected = {};
            rows.forEach(c => {
                let t = c.teams_data;
                if (typeof t === 'string') { try { t = JSON.parse(t); } catch (e) { t = {}; } }
                if (t && typeof t === 'object') Object.keys(t).forEach(k => { expected[k] = t[k]; });
            });
            if (!Object.keys(expected).length) continue;
            const arch = await api('GET', `/api/shifts/${r.shift_id}`);
            if (arch.ok && arch.data && w1ecStable(arch.data.completions) === w1ecStable(expected)) {
                w1ecLegacyOk = true; w1ecLegacyId = r.shift_id; break;
            }
        }
        dbc.close();
    }
    record('W1-E-C ②: مناوبة قديمة بلا أحداث — قسم completions بالفرع القديم حرفيًا (تطابق كامل مع دمج shift_completions)',
        w1ecLegacyOk, `legacyShift=${w1ecLegacyId}`);

    // ③ قيد النطاق: الاشتقاق داخل قسم completions فقط + الفرع القديم وفولباك centersData محفوظان نصًا
    const w1ecSrvSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'server.js'), 'utf8');
    record('W1-E-C ③: النطاق مقيد (اشتقاق داخل completions فقط + الفرع القديم وفولباك centersData محفوظان)',
        w1ecSrvSrc.includes('w1eDerived') && w1ecSrvSrc.includes('dbCompletions.forEach') && w1ecSrvSrc.includes('shift.centersData'),
        `derived=${w1ecSrvSrc.includes('w1eDerived')} legacy=${w1ecSrvSrc.includes('dbCompletions.forEach')} fallback=${w1ecSrvSrc.includes('shift.centersData')}`);

    // ④ أداء تفاصيل الأرشيف ضمن العتبة
    const w1ecT0 = Date.now();
    const w1ecPerf = await api('GET', `/api/shifts/${shiftId}`);
    const w1ecMs = Date.now() - w1ecT0;
    record('W1-E-C ④: زمن تفاصيل الأرشيف ضمن العتبة (<150ms)', w1ecPerf.ok && w1ecMs < 150, `ms=${w1ecMs}`);

    // ─── 13m. W1-A: السجل التشغيلي الموحّد (operational_events) — الشريحة التأسيسية ───
    // ① ساكن: db.js يعرّف الجدولين والفهارس الخمسة (الترحيل ذاتي عند الإقلاع)
    const w1DbSrc = f4Fs.readFileSync(f4Path.join(__dirname, '..', 'db.js'), 'utf8');
    const w1TablesOk = /CREATE TABLE IF NOT EXISTS operational_events\b/.test(w1DbSrc)
        && /CREATE TABLE IF NOT EXISTS operational_shift_snapshots\b/.test(w1DbSrc);
    const w1IdxOk = ['idx_op_events_shift', 'idx_op_events_entity', 'idx_op_events_shift_domain', 'idx_op_events_corrects', 'idx_op_snapshots_shift']
        .every(ix => w1DbSrc.includes(ix));
    record('W1-A ①: تعريف جدولَي operational_events/snapshots + الفهارس الخمسة في db.js', w1TablesOk && w1IdxOk, `tables=${w1TablesOk} indexes=${w1IdxOk}`);

    // ② تشغيلي: المسارات الستة محمية (401 بلا توكن)
    const w1SavedTok = TOKEN; TOKEN = null;
    const w1NoAuth = await api('GET', '/api/staffing/state', undefined, 401);
    TOKEN = w1SavedTok;
    record('W1-A ②: مسارات الأحداث محمية بالمصادقة (401 بلا توكن)', w1NoAuth.status === 401, `status=${w1NoAuth.status}`);

    // ③ تشغيلي: المسارات الستة ترجع 200 بأشكال صادقة (فارغة عند غياب أحداث — لا بيانات مختلقة)
    const w1StState = await api('GET', '/api/staffing/state');
    const w1StTimeline = await api('GET', '/api/staffing/timeline');
    const w1StInd = await api('GET', '/api/staffing/indicators');
    const w1VhState = await api('GET', '/api/vehicles/state');
    const w1VhTimeline = await api('GET', '/api/vehicles/timeline');
    const w1VhInd = await api('GET', '/api/vehicles/indicators');
    const w1ReadShapesOk =
        w1StState.ok && w1StState.data && w1StState.data.success === true && Array.isArray(w1StState.data.entities) &&
        w1StTimeline.ok && w1StTimeline.data && Array.isArray(w1StTimeline.data.events) &&
        w1StInd.ok && w1StInd.data && typeof w1StInd.data.openByType === 'object' && typeof w1StInd.data.totalByType === 'object' &&
        w1VhState.ok && w1VhState.data && Array.isArray(w1VhState.data.entities) &&
        w1VhTimeline.ok && w1VhTimeline.data && Array.isArray(w1VhTimeline.data.events) &&
        w1VhInd.ok && w1VhInd.data && typeof w1VhInd.data.vehiclesByStatus === 'object';
    record('W1-A ③: المسارات الستة ترد 200 بأشكال صادقة (state/timeline/indicators × staffing/vehicles)', w1ReadShapesOk,
        `st=${w1StState.status}/${w1StTimeline.status}/${w1StInd.status} vh=${w1VhState.status}/${w1VhTimeline.status}/${w1VhInd.status}`);

    // ④ تشغيلي: shift_id غير رقمي ⇒ 400 (لا 500)
    const w1BadShift = await api('GET', '/api/staffing/state?shift_id=abc', undefined, 400);
    record('W1-A ④: رفض shift_id غير صالح (400)', w1BadShift.status === 400, `status=${w1BadShift.status}`);

    // ⑤ وحدات: رزنامة النطاقات + الطيّ الدلالي (إغلاق/مدة مشتقة) + المؤشرات
    const w1Core = require('../services/operational-events-core');
    const w1ValidType = w1Core.isValidEventType('staffing', 'absence') && !w1Core.isValidEventType('staffing', 'bogus') && w1Core.isValidEventType('vehicle', 'status_change');
    const w1Ev = [
        { id: 1, domain: 'staffing', entity_id: 'E1', entity_name: 'اختبار', team_id: null, center: null, event_type: 'absence', created_at: '2026-07-21T07:00:00.000Z' },
        { id: 2, domain: 'staffing', entity_id: 'E1', entity_name: 'اختبار', team_id: null, center: null, event_type: 'arrival', created_at: '2026-07-21T08:30:00.000Z' }
    ];
    const w1Folded = w1Core.foldEvents(w1Ev, 'staffing');
    const w1Pair = w1Folded[0] && w1Folded[0].closedPairs && w1Folded[0].closedPairs[0];
    const w1FoldOk = w1Folded.length === 1 && w1Folded[0].open.length === 0 && !!w1Pair
        && w1Pair.durationMs === 90 * 60 * 1000 && w1Pair.closedBy && w1Pair.closedBy.type === 'arrival';
    const w1VehInd = w1Core.deriveIndicators([
        { id: 1, domain: 'vehicle', entity_id: 'V1', event_type: 'status_change', status: 'breakdown', created_at: '2026-07-21T09:00:00.000Z' },
        { id: 2, domain: 'vehicle', entity_id: 'V2', event_type: 'status_change', status: 'active', created_at: '2026-07-21T09:05:00.000Z' }
    ], 'vehicle');
    const w1VehOk = w1VehInd.vehiclesByStatus.breakdown === 1 && w1VehInd.vehiclesByStatus.active === 1;
    record('W1-A ⑤: رزنامة النطاقات + الطيّ الدلالي (إغلاق absence بـ arrival، مدة 90د) + مؤشرات المركبات', w1ValidType && w1FoldOk && w1VehOk, `types=${w1ValidType} fold=${w1FoldOk} veh=${w1VehOk}`);

    // ─── 14. Logout ───
    const logout = await api('POST', '/api/auth/logout', {});
    record('تسجيل الخروج', logout.ok || logout.status === 200, `status=${logout.status}`);

    // ─── Summary ───
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ النتيجة: ${passed}/${results.length} ناجح ═══`);
    if (failed.length) {
        console.log('الفاشلة:');
        failed.forEach(f => console.log(`  ❌ ${f.name} — ${f.detail}`));
    }
    process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('Regression runner crashed:', e); process.exit(1); });
