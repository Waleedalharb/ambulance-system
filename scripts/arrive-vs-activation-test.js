/**
 * اختبارات إصلاح «حضر × إنهاء التفعيل» — arrive-vs-activation (v2)
 * ═══════════════════════════════════════════════════════════════════════════
 * v1: بلاغ المالك — موظف Overlap/RRA متأخر كان يظهر له «⛔ إنهاء التفعيل»
 *     فقط بلا زر «✋ حضر». أصلحه حقن المفعَّل المتأخر في absentees + قبول
 *     أكواد D/N الصرفة في طاقم الفرق + فصل الزرين بصريًا في الواجهة.
 * v2 (تجربة المالك اليدوية على 3090):
 *     الخلل أ — عائلة RRA الموقعة (RRA1-D-04/N-16) كانت تُدحرج بدايتها
 *       لليوم التالي إن سبقت بداية المناوبة (04:00 ← 05:00) فتصفر المدة.
 *       قرار المالك النهائي: لا تدحرج لعائلة RRA — البداية على تاريخ
 *       المناوبة المسؤولة نفسه. O12-* والقديمة غير الموقعة (legacy) كما هي.
 *     الخلل ب — التأخر المسجل قبل التفعيل (نفس المناوبة) يدخل absentees
 *       بأي ترتيب زمني (الحقن يفحص كل الأحداث المفتوحة باسم الموظف).
 *       (الحالة الحية لعبدالاله كانت عابرة لصفّي مناوبة 159/160 — تسليم
 *       واستلام — وموثقة في التقرير كخطر متبقٍّ خارج هذا النطاق.)
 *
 * نمط العزل نفسه في overlap-activation-test.js / overlap-late-test.js:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (تُضبط قبل require db.js).
 *   - مقطع اشتقاق داخلي (in-process) بتواريخ ثابتة لمصفوفة التدحرج،
 *     ثم خادم حقيقي كعملية ابن على منفذ الاختبار 3085 للسيناريوهات الحية.
 *   - الكادر عبر الكاتب الرسمي RosterSyncService؛ الأحداث الداخلية عبر
 *     StorageAdapter.appendOperationalEvent (append-only).
 *
 * التشغيل: node scripts/arrive-vs-activation-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3085;
const BASE = `http://localhost:${PORT}`;
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** وقت جداري بالرياض ← UTC ISO (نفس تثبيت +03:00 الصريح في الخدمة). */
const R = (date, hhmm) => new Date(date + 'T' + hhmm + ':00+03:00').toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let TOKEN = null;
async function api(method, p, body) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json */ }
    return { status: res.status, data };
}

async function waitHealth(timeoutMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try {
            const r = await fetch(BASE + '/health');
            if (r.ok) return true;
        } catch (_) { /* لم يصغِ بعد */ }
        await sleep(400);
    }
    return false;
}

async function main() {
    console.log('\n═══ اختبارات إصلاح «حضر × إنهاء التفعيل» (v2) ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arrive-vs-activation-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const TimeRiyadh = require(path.join(ROOT, 'public/js/time-riyadh.js'));
    const today = TimeRiyadh.formatDate(new Date()); // تاريخ الرياض الجداري — نفس ختم الخادم

    let server = null;

    try {
        // ── 1) قاعدة معزولة + بذر الكادر عبر الكاتب الرسمي ──
        const db = require(path.join(ROOT, 'db.js'));
        await db.init(false); // مخطط كامل + بذر (سريع 1..4 ببدايات {"day":"04:00","night":"16:00"})
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        // كادر المقطع الداخلي — تواريخ ثابتة بعيدة عن «اليوم» (بلا مناوبة سابقة ⇒ بلا ترحيل)
        const D1 = '2026-08-20'; // صباحية
        const D2 = '2026-08-21'; // ليلية
        await sync.syncFromSchedule([
            { employeeNumber: '601', name: 'سريع موقع دال', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'RRA1-D-04' }] },
            { employeeNumber: '602', name: 'أوفرلاب ذهبي', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'O12-12' }] },
            { employeeNumber: '605', name: 'سريع موقع نون', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D2, shiftCode: 'RRA1-N-16' }] },
            { employeeNumber: '606', name: 'سريع قديم', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D2, shiftCode: 'RRA1-04' }] },
            // كادر المقطع الحي (اليوم — صباحية)
            { employeeNumber: '821', name: 'سريع متأخر', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D' }] },
            { employeeNumber: '822', name: 'سريع حاضر', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D' }] },
            { employeeNumber: '831', name: 'أوفرلاب متأخر مفعّل', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12-12' }] },
            { employeeNumber: '832', name: 'أوفرلاب منهي', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12-12' }] },
            { employeeNumber: '833', name: 'أوفرلاب متأخر قبل التفعيل', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12-12' }] },
            { employeeNumber: '841', name: 'نهاري عادي أ', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '842', name: 'نهاري عادي ب', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] }
        ]);

        // ── المقطع الداخلي: مصفوفة التدحرج (الخلل أ) بتواريخ ثابتة ──
        const StorageAdapter = require(path.join(ROOT, 'storage-adapter.js'));
        const storage = new StorageAdapter(db);
        const StaffingEventsService = require(path.join(ROOT, 'services', 'staffing-events-service.js'));
        const svc = new StaffingEventsService({ storage, engine: {} }); // engine لا يُستخدم في مسار القراءة
        const insShift = async (name, date, time, type) => (await db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time)
             VALUES (?, ?, ?, ?, 'الخميس', ?)`, [name, date, time, type, R(date, time)])).id;
        const dayA = await insShift('صباحية 20', D1, '05:00', 'صباحية');
        const nightB = await insShift('ليلية 21', D2, '17:00', 'ليلية');
        const addEvent = (shiftId, shiftDate, shiftType, ev) => storage.appendOperationalEvent({
            shiftId, shiftDate, shiftType, domain: 'staffing',
            entityId: ev.emp, entityName: ev.emp, teamId: ev.team || null, center: null,
            eventType: ev.type, reason: ev.type === 'late' ? 'مسعف متأخر' : null,
            payload: null, note: null, actorId: 'test', actorName: 'اختبار', createdAt: ev.at
        });

        // صباحية D1: RRA1-D-04 متأخر ثم حضر 09:30 · O12-12 ذهبي
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع موقع دال', type: 'late', at: R(D1, '03:50'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع موقع دال', type: 'arrival', at: R(D1, '09:30'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب ذهبي', type: 'late', at: R(D1, '05:05'), team: 'جنوب 3' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب ذهبي', type: 'arrival', at: R(D1, '12:37'), team: 'جنوب 3' });
        // ليلية D2: RRA1-N-16 متأخر ثم حضر 16:45 · القديمة RRA1-04 (تدحرج محفوظ)
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع موقع نون', type: 'late', at: R(D2, '15:50'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع موقع نون', type: 'arrival', at: R(D2, '16:45'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع قديم', type: 'late', at: R(D2, '17:05'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع قديم', type: 'arrival', at: R('2026-08-22', '04:15'), team: 'سريع 1' });

        const tlA = await svc.getTimeline(dayA);
        const recA = n => (tlA.lateRecords || []).find(r => r.employee === n);
        const tlB = await svc.getTimeline(nightB);
        const recB = n => (tlB.lateRecords || []).find(r => r.employee === n);

        // ① RRA1-D-04: بلا تدحرج — البداية 04:00 نفس تاريخ المناوبة · مدة > 0 صحيحة
        const rD = recA('سريع موقع دال');
        const t1 = rD && rD.status === 'arrived' &&
            rD.operationalStart === R(D1, '04:00') && rD.startedAt === R(D1, '04:00') &&
            rD.operationalStart !== R('2026-08-21', '04:00') &&       // حارس العودة: لا D+1
            rD.durationMinutes === 330;                                // 04:00 ← 09:30
        record('① الخلل أ: RRA1-D-04 صباحية بلا تدحرج — 04:00 نفس التاريخ · 09:30⇒330 دقيقة (>0)',
            t1, `opStart=${rD && rD.operationalStart} المدة=${rD && rD.durationMinutes}`);

        // ② RRA1-N-16: نفس تاريخ المناوبة الليلية 16:00 (ولو سبقت 17:00) · 16:45⇒45
        const rN = recB('سريع موقع نون');
        const t2 = rN && rN.status === 'arrived' &&
            rN.operationalStart === R(D2, '16:00') && rN.startedAt === R(D2, '16:00') &&
            rN.operationalStart !== R('2026-08-22', '16:00') &&       // حارس العودة: لا D+1
            rN.durationMinutes === 45;
        record('② الخلل أ: RRA1-N-16 ليلية — 16:00 نفس تاريخ الليلية (بلا تدحرج) · 16:45⇒45',
            t2, `opStart=${rN && rN.operationalStart} المدة=${rN && rN.durationMinutes}`);

        // ③ ذهبي: O12-12 سلوكه ثابت (12:00⇒37) · القديمة RRA1-04 تبقى مدحرجة (D+1 04:00⇒15)
        const rG = recA('أوفرلاب ذهبي');
        const rL = recB('سريع قديم');
        const t3 = rG && rG.operationalStart === R(D1, '12:00') && rG.durationMinutes === 37 &&
            rL && rL.operationalStart === R('2026-08-22', '04:00') && rL.durationMinutes === 15;
        record('③ ذهبي: O12-12 ثابت (12:00⇒37) · الصيغة القديمة RRA1-04 تحتفظ بالتدحرج (D+1 04:00⇒15)',
            t3, `O12=${rG && rG.durationMinutes}/${rG && rG.operationalStart} قديم=${rL && rL.durationMinutes}/${rL && rL.operationalStart}`);

        await db.closeDb();
        await sleep(500); // تحرير مقبض WAL على ويندوز قبل تشغيل الخادم

        // ── 2) تشغيل الخادم الحقيقي على القاعدة المعزولة ──
        server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
            cwd: ROOT,
            env: { ...process.env, DB_PATH: tmpDb, PORT: String(PORT) },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let serverLog = '';
        server.stdout.on('data', d => { serverLog += d.toString(); });
        server.stderr.on('data', d => { serverLog += d.toString(); });

        if (!(await waitHealth())) {
            record('إقلاع خادم الاختبار', false, serverLog.slice(-800));
            throw new Error('تعذر إقلاع الخادم');
        }

        const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
        if (!login.data || !login.data.accessToken) throw new Error('تعذر تسجيل الدخول: ' + login.status);
        TOKEN = login.data.accessToken;

        const start = await api('POST', '/api/start-new-shift', { shiftType: 'صباحية' });
        const shiftId = start.data && start.data.shiftId;
        if (!shiftId) throw new Error('تعذر بدء المناوبة: ' + JSON.stringify(start.data));

        const getState = () => api('GET', `/api/staffing/state?shift_id=${shiftId}`);
        const getTimeline = (ent) => api('GET', `/api/staffing/timeline?shift_id=${shiftId}${ent ? '&entity_id=' + encodeURIComponent(ent) : ''}`);
        const postEvents = (events) => api('POST', '/api/shift-completion', { shiftType: 'صباحية', shiftDate: today, events });

        // ═══ ④ RRA مجدول في فريقه (كود D صرف) ومتأخر ⇒ فريقه يظهر به وهو في absentees ═══
        const late1 = await postEvents([{ type: 'late', employeeName: 'سريع متأخر', teamId: 'سريع 1', reason: 'مسعف متأخر' }]);
        const st1 = await getState();
        const rap1 = st1.data.teams && st1.data.teams['سريع 1'];
        const rapLateMember = rap1 && (rap1.members || []).find(m => m.name === 'سريع متأخر');
        const rapOkMember = rap1 && (rap1.members || []).find(m => m.name === 'سريع حاضر');
        const rapAbs = rap1 && (rap1.absentees || []).find(a => a.name === 'سريع متأخر');
        const t4 = late1.status === 200 && rap1 && rapLateMember && rapLateMember.state === 'late' &&
            rapAbs && rapAbs.type === 'late' &&
            rapOkMember && rapOkMember.state === 'active';
        record('④ RRA مجدول (كود D صرف): فريقه في الحالة · المتأخر state=late وفي absentees · زميله active',
            t4, `فريق=${!!rap1} عضو=${rapLateMember && rapLateMember.state} غائب=${rapAbs && rapAbs.type}`);

        // ═══ ⑤ «حضر» للـRRA: يغلق التأخير من بدايته التشغيلية 04:00 · بلا مساس بأي تفعيل ═══
        const arr1 = await postEvents([{ type: 'arrival', employeeName: 'سريع متأخر', teamId: 'سريع 1' }]);
        const tl1 = await getTimeline('سريع متأخر');
        const rec1 = (tl1.data.lateRecords || []).find(r => r.employee === 'سريع متأخر');
        const arrEv1 = (tl1.data.events || []).filter(e => e.event_type === 'arrival' && e.entity_id === 'سريع متأخر').pop();
        const actEvs1 = (tl1.data.events || []).filter(e => e.event_type === 'activation' || e.event_type === 'activation_end');
        const opStartRapid = R(today, '04:00'); // سريع 1 operational_starts.day — طبقة الفريق (بلا تدحرج أصلًا)
        const expDur1 = arrEv1 ? Math.max(0, Math.round((new Date(arrEv1.created_at) - new Date(opStartRapid)) / 60000)) : null;
        const st1b = await getState();
        const rap1b = st1b.data.teams && st1b.data.teams['سريع 1'];
        const rapLateAfter = rap1b && (rap1b.members || []).find(m => m.name === 'سريع متأخر');
        const t5 = arr1.status === 200 && arr1.data && arr1.data.appended === 1 &&
            rec1 && rec1.status === 'arrived' &&
            rec1.operationalStart === opStartRapid && rec1.startedAt === opStartRapid &&
            expDur1 !== null && rec1.durationMinutes === expDur1 &&
            actEvs1.length === 0 &&                       // لا حدث تفعيل/إنهاء أُنشئ
            rapLateAfter && rapLateAfter.state === 'active' &&
            (rap1b.absentees || []).length === 0;
        record('⑤ «حضر» للـRRA: التأخير يُغلق من 04:00 التشغيلية بالمدة الصحيحة · بلا حدث تفعيل · العضو active',
            t5, `opStart=${rec1 && rec1.operationalStart} المدة=${rec1 && rec1.durationMinutes} متوقع=${expDur1} تفعيلات=${actEvs1.length} حالة=${rapLateAfter && rapLateAfter.state}`);

        // ═══ ⑥ Overlap مفعَّل ومتأخر (تفعيل ثم تأخير) ⇒ في absentees بعضو activation موسوم late ═══
        const act3 = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب متأخر مفعّل', teamName: 'جنوب 15' });
        const late3 = await postEvents([{ type: 'late', employeeName: 'أوفرلاب متأخر مفعّل', teamId: 'جنوب 15', reason: 'مسعف متأخر' }]);
        const st3 = await getState();
        const j15a = st3.data.teams && st3.data.teams['جنوب 15'];
        const actLateMember = j15a && (j15a.members || []).find(m => m.name === 'أوفرلاب متأخر مفعّل');
        const actAbs = j15a && (j15a.absentees || []).find(a => a.name === 'أوفرلاب متأخر مفعّل');
        const t6 = act3.status === 200 && late3.status === 200 && j15a &&
            actLateMember && actLateMember.role === 'activation' && actLateMember.state === 'late' &&
            actAbs && actAbs.type === 'late';
        record('⑥ Overlap مفعَّل متأخر: عضو activation بحالة late + مدخل absentees (مصدر زر «حضر» السيرفري)',
            t6, `عضو=${actLateMember && actLateMember.role}/${actLateMember && actLateMember.state} غائب=${actAbs && actAbs.type}`);

        // ═══ ⑦ «حضر» للمفعَّل: يغلق التأخير من 12:00 · مدة > 0 عبر تصحيح موثق · التفعيل يبقى مفتوحًا ═══
        // (v1 كانت تخلّد «0=0» لأن الحضور الطبيعي يسبق 12:00 وقت التشغيل؛ هنا
        //  يُثبَّت وصول مصحح 13:30 — صلاحية المشرف — فالمدة 90 دقيقة قاطعة بأي ساعة تشغيل)
        const arr4 = await postEvents([{ type: 'arrival', employeeName: 'أوفرلاب متأخر مفعّل', teamId: 'جنوب 15' }]);
        const corr4 = await postEvents([{ type: 'correction', employeeName: 'أوفرلاب متأخر مفعّل', teamId: 'جنوب 15', arrivalAt: R(today, '13:30') }]);
        const tl4 = await getTimeline('أوفرلاب متأخر مفعّل');
        const rec4 = (tl4.data.lateRecords || []).find(r => r.employee === 'أوفرلاب متأخر مفعّل');
        const actOpen4 = (tl4.data.events || []).some(e => e.event_type === 'activation');
        const actEnd4 = (tl4.data.events || []).some(e => e.event_type === 'activation_end');
        const opStartO12 = R(today, '12:00'); // O12-12 في صباحية ⇒ نفس اليوم 12:00
        const st4 = await getState();
        const j15b = st4.data.teams && st4.data.teams['جنوب 15'];
        const actMemberAfter = j15b && (j15b.members || []).find(m => m.name === 'أوفرلاب متأخر مفعّل');
        const t7 = arr4.status === 200 && arr4.data && arr4.data.appended === 1 &&
            corr4.status === 200 &&
            rec4 && rec4.status === 'arrived' &&
            rec4.operationalStart === opStartO12 && rec4.startedAt === opStartO12 &&
            rec4.arrivedAt === R(today, '13:30') && rec4.durationMinutes === 90 &&   // >0 قاطعة
            actOpen4 && !actEnd4 &&                        // «حضر» لا ينهي التفعيل
            actMemberAfter && actMemberAfter.role === 'activation' && actMemberAfter.state === 'activation' &&
            (j15b.absentees || []).length === 0;
        record('⑦ «حضر» للمفعَّل: يُغلق من 12:00 · وصول مصحح 13:30⇒90 دقيقة (>0) · التفعيل مفتوح · العضو يعود activation',
            t7, `الحضور=${rec4 && rec4.arrivedAt} المدة=${rec4 && rec4.durationMinutes} إنهاء=${actEnd4} حالة=${actMemberAfter && actMemberAfter.state}`);

        // ═══ ⑧ الخلل ب (نفس المناوبة): تأخر سُجّل قبل التفعيل ⇒ يدخل absentees بأي ترتيب ═══
        //        + إعادة التفعيل فوق مفتوح لنفس الفريق ⇒ idempotent بلا حدث ثانٍ
        const late8 = await postEvents([{ type: 'late', employeeName: 'أوفرلاب متأخر قبل التفعيل', teamId: 'جنوب 14', reason: 'مسعف متأخر' }]);
        const act8 = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب متأخر قبل التفعيل', teamName: 'جنوب 14' });
        const st8 = await getState();
        const j14a = st8.data.teams && st8.data.teams['جنوب 14'];
        const lateFirstMember = j14a && (j14a.members || []).find(m => m.name === 'أوفرلاب متأخر قبل التفعيل');
        const lateFirstAbs = j14a && (j14a.absentees || []).find(a => a.name === 'أوفرلاب متأخر قبل التفعيل');
        // إعادة التفعيل فوق المفتوح لنفس الفريق ⇒ تخطٍّ idempotent (بلا activation ثانٍ)
        const act8dup = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب متأخر قبل التفعيل', teamName: 'جنوب 14' });
        const tl8pre = await getTimeline('أوفرلاب متأخر قبل التفعيل');
        const actCount8 = (tl8pre.data.events || []).filter(e => e.event_type === 'activation').length;
        // «حضر» بعدها: يغلق التأخير من 12:00 والتفعيل يبقى مفتوحًا
        const arr8 = await postEvents([{ type: 'arrival', employeeName: 'أوفرلاب متأخر قبل التفعيل', teamId: 'جنوب 14' }]);
        const tl8 = await getTimeline('أوفرلاب متأخر قبل التفعيل');
        const rec8 = (tl8.data.lateRecords || []).find(r => r.employee === 'أوفرلاب متأخر قبل التفعيل');
        const actEnd8 = (tl8.data.events || []).some(e => e.event_type === 'activation_end');
        const st8b = await getState();
        const j14b = st8b.data.teams && st8b.data.teams['جنوب 14'];
        const lateFirstAfter = j14b && (j14b.members || []).find(m => m.name === 'أوفرلاب متأخر قبل التفعيل');
        const t8 = late8.status === 200 && act8.status === 200 &&
            lateFirstMember && lateFirstMember.role === 'activation' && lateFirstMember.state === 'late' &&
            lateFirstAbs && lateFirstAbs.type === 'late' &&
            act8dup.status === 200 && act8dup.data && act8dup.data.appended === 0 && actCount8 === 1 &&
            arr8.status === 200 && arr8.data && arr8.data.appended === 1 &&
            rec8 && rec8.status === 'arrived' && rec8.operationalStart === R(today, '12:00') &&
            !actEnd8 && lateFirstAfter && lateFirstAfter.state === 'activation' &&
            (j14b.absentees || []).length === 0;
        record('⑧ الخلل ب: تأخر قبل التفعيل (نفس المناوبة) ⇒ absentees + state=late · تكرار التفعيل بلا حدث ثانٍ · «حضر» يغلق ويبقي التفعيل',
            t8, `عضو=${lateFirstMember && lateFirstMember.state} غائب=${lateFirstAbs && lateFirstAbs.type} تكرار=${act8dup.data && act8dup.data.appended}/أحداث=${actCount8} بعد_الحضور=${lateFirstAfter && lateFirstAfter.state}`);

        // ═══ ⑨ مفعَّل غير متأخر: «إنهاء التفعيل» مستقل — بلا absentees وبلا حدث حضور ═══
        const act5 = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب منهي', teamName: 'جنوب 15' });
        const st5 = await getState();
        const j15c = st5.data.teams && st5.data.teams['جنوب 15'];
        const cleanMember = j15c && (j15c.members || []).find(m => m.name === 'أوفرلاب منهي');
        const cleanAbs = j15c && (j15c.absentees || []).some(a => a.name === 'أوفرلاب منهي');
        const end5 = await api('POST', '/api/staffing/activation/end', { employeeName: 'أوفرلاب منهي' });
        const tl5 = await getTimeline('أوفرلاب منهي');
        const arrEvs5 = (tl5.data.events || []).filter(e => e.event_type === 'arrival' && e.entity_id === 'أوفرلاب منهي');
        const lateRecs5 = (tl5.data.lateRecords || []).filter(r => r.employee === 'أوفرلاب منهي');
        const endEv5 = (tl5.data.events || []).some(e => e.event_type === 'activation_end' && e.entity_id === 'أوفرلاب منهي');
        const st5b = await getState();
        const j15d = st5b.data.teams && st5b.data.teams['جنوب 15'];
        const goneAfterEnd = !(j15d && (j15d.members || []).some(m => m.name === 'أوفرلاب منهي'));
        const t9 = act5.status === 200 &&
            cleanMember && cleanMember.state === 'activation' && !cleanAbs &&   // غير متأخر ⇒ لا زر حضور
            end5.status === 200 && end5.data && end5.data.appended === 1 &&
            endEv5 && arrEvs5.length === 0 && lateRecs5.length === 0 &&          // الإنهاء لا يسجل حضورًا
            goneAfterEnd;
        record('⑨ مفعَّل غير متأخر: بلا absentees · «إنهاء التفعيل» 200 مستقل · بلا حدث arrival ولا سجل تأخير',
            t9, `حالة=${cleanMember && cleanMember.state} غائب=${cleanAbs} إنهاء=${end5.status} حضور=${arrEvs5.length} تأخير=${lateRecs5.length}`);

        // ═══ ⑩ خط الأساس: كادر D12 العادي لم يتغير بفلتر D/N الجديد ═══
        const j3 = st5b.data.teams && st5b.data.teams['جنوب 3'];
        const j3a = j3 && (j3.members || []).find(m => m.name === 'نهاري عادي أ');
        const j3b = j3 && (j3.members || []).find(m => m.name === 'نهاري عادي ب');
        const t10 = j3 && j3a && j3a.state === 'active' && j3a.role === 'base' &&
            j3b && j3b.state === 'active' && (j3.absentees || []).length === 0;
        record('⑩ خط الأساس: جنوب 3 (D12) عضوان active بلا absentees — فلتر الطاقم لم يُغيّر العاديين',
            t10, `أ=${j3a && j3a.state} ب=${j3b && j3b.state} غياب=${j3 && (j3.absentees || []).length}`);

        // ═══ إيقاف الخادم قبل فحوص الواجهة الساكنة ═══
        server.kill();
        await new Promise(r => { const t = setTimeout(r, 8000); server.once('exit', () => { clearTimeout(t); r(); }); });
        server = null;
        await sleep(600);

        // ═══ ⑪ الواجهة (مصدر radio-completion.html الفعلي): «حضر» من absentees
        //        و«إنهاء التفعيل» في حاوية ثانوية منفصلة — لا تحل إحداهما محل الأخرى ═══
        const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        // فرع العضو المفعَّل: يحوي endActivation داخل pm-secondary-actions، ولا يحوي btn-arrive إطلاقًا
        const actIdx = html.indexOf("if (m.role === 'activation')");
        const actBranch = actIdx >= 0 ? html.slice(actIdx, actIdx + 2200) : '';
        const actBranchOk = !!actBranch &&
            actBranch.includes('pm-secondary-actions') &&
            actBranch.includes('endActivation') &&
            actBranch.includes('إنهاء التفعيل') &&
            actBranch.includes('pm-state-late') &&          // شارة التأخير من m.state السيرفرية
            actBranch.includes("m.state === 'late'") &&
            !actBranch.includes('btn-arrive') &&            // لا «حضر» داخل فرع التفعيل
            !actBranch.includes('personArrived');
        // كتلة الغائبين: زر «✋ حضر» يُرسم من d.absentees (حالة سيرفرية) عبر personArrived
        const absIdx = html.indexOf('var absentees = (d && d.absentees) || [];');
        const absBlock = absIdx >= 0 ? html.slice(absIdx, absIdx + 900) : '';
        const absBlockOk = !!absBlock &&
            absBlock.includes('btn-arrive') &&
            absBlock.includes('personArrived') &&
            absBlock.includes('✋ حضر') &&
            !absBlock.includes('endActivation') &&          // لا «إنهاء التفعيل» في كتلة الحضور
            !absBlock.includes('activation/end');
        // فصل بصري موثق: نمط CSS للحاوية الثانوية المنفصلة موجود
        const cssOk = html.includes('.pm .pm-secondary-actions');
        const t11 = actBranchOk && absBlockOk && cssOk;
        record('⑪ الواجهة: «حضر» من absentees فقط · «إنهاء التفعيل» في pm-secondary-actions منفصلة · شارة late من m.state',
            t11, `فرع_التفعيل=${actBranchOk} كتلة_الحضور=${absBlockOk} نمط=${cssOk}`);

    } catch (err) {
        record('خطأ غير متوقع أثناء الاختبارات', false, err.message);
        console.error(err);
    } finally {
        if (server) { try { server.kill(); } catch (_) {} await sleep(500); }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ─── الملخص ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) {
        failed.forEach(f => console.log(`   ❌ ${f.name}`));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات إصلاح «حضر × إنهاء التفعيل» (v2) ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
