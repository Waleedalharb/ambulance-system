/**
 * اختبارات المرحلة ب (تصحيح المالك) — إضافة متطوع من شاشة التكميل بمسار الـOverlap
 * ═══════════════════════════════════════════════════════════════════════════════
 * سيناريو المالك حرفيًا:
 *   مجاز (V) ⇒ POST /api/staffing/volunteer 200 بلا فريق ⇒ يظهر في
 *   /api/staffing/available-support كمتطوع غير مفعّل برمز يومه ⇒ تفعيل جنوب 15
 *   غير المجدولة عبر POST /api/staffing/activation ⇒ جنوب 15 تظهر في
 *   /api/staffing/state رسميًا والمتطوع عضو activation فيها ويغيب من الحوض ⇒
 *   activation/end ⇒ يعود للحوض متطوعًا غير مفعّل.
 * الحراس: D12⇒400 وغائب من المرشحين · WO وبلا سجل⇒مقبولان للحوض · تكرار
 * idempotent · حارس الـ192 وبصمة shift_roster ثابتة · موظف/فريق وهمي⇒404 ·
 * فحوص ساكنة للواجهة (المودال بلا منتقي فرقة، زر الحوض يفتح مودال التفعيل).
 *
 * نمط العزل نفسه في overlap-activation-test.js حرفيًا: قاعدة SQLite مؤقتة
 * عبر DB_PATH · زرع عبر RosterSyncService · خادم حقيقي كعملية ابن على منفذ
 * اختبار · قراءات القاعدة المباشرة بعد إيقاف الخادم فقط.
 *
 * التشغيل: node scripts/volunteer-from-completion-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3127;
const BASE = `http://localhost:${PORT}`;
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

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
    console.log('\n═══ اختبارات المرحلة ب (تصحيح المالك) — متطوع بمسار الـOverlap ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'volunteer-completion-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const TimeRiyadh = require(path.join(ROOT, 'public/js/time-riyadh.js'));
    const today = TimeRiyadh.formatDate(new Date()); // تاريخ الرياض الجداري — نفس ختم الخادم
    // نطاق الشهر الحالي لحارس الـ192 (computeMetrics حتمي — بلا طوابع وقت)
    const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
    const monthStart = today.slice(0, 7) + '-01';
    const monthEnd = today.slice(0, 7) + '-' + String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');

    let server = null;
    let rosterHashBefore = null;
    let metricsBefore = null;

    const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');

    try {
        // ── 1) قاعدة معزولة + بذر الكادر عبر الكاتب الرسمي ──
        const db = require(path.join(ROOT, 'db.js'));
        await db.init(false); // مخطط كامل + ترحيلات + بذر (جنوب 1-15 موجودة ونشطة)
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });
        const ScheduleMetricsService = require(path.join(ROOT, 'services', 'schedule-metrics-service'));
        const metrics = new ScheduleMetricsService({ db });

        await sync.syncFromSchedule([
            // مجدول للعمل الفعلي اليوم — ممنوع من الترشح والقبول (①)
            { employeeNumber: '801', name: 'عامل فعلي', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            // إجازة V — مرشح الحوض (بطل السيناريو)
            { employeeNumber: '802', name: 'مجاز تطوع', team: 'جنوب 3', jobTitle: 'فني إسعاف', schedule: [{ date: today, shiftCode: 'V' }] },
            // نهاية أسبوع WO — مرشح رغم أنه ليس ضمن OFF_CODES
            { employeeNumber: '803', name: 'نهاية أسبوع', team: 'جنوب 3', jobTitle: 'أخصائي إسعاف', schedule: [{ date: today, shiftCode: 'WO' }] },
            // بلا سجل كادر لهذا اليوم إطلاقًا — مرشح
            { employeeNumber: '804', name: 'بلا جدولة', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-01-15', shiftCode: 'D12' }] },
            // أوفرلاب بلا فريق — اختبار ذهبي: المفعَّل الأوفرلاب يحتفظ بوسمه (لا كسر)
            { employeeNumber: '805', name: 'أوفرلاب ذهبي', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12-12' }] }
        ]);

        rosterHashBefore = hashOf(JSON.stringify(await db.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id')));
        // بصمة الـ192 قبل أي تطوع — JSON كامل (computeMetrics حتمي بلا طوابع)
        metricsBefore = JSON.stringify(await metrics.computeMetrics(monthStart, monthEnd, 192));

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
        const getPool = () => api('GET', `/api/staffing/available-support?shift_id=${shiftId}`);
        const getTimeline = (ent) => api('GET', `/api/staffing/timeline?shift_id=${shiftId}${ent ? '&entity_id=' + encodeURIComponent(ent) : ''}`);
        const getCandidates = (q) => api('GET', `/api/staffing/volunteer-candidates?shift_id=${shiftId}&q=${encodeURIComponent(q || '')}`);
        const postVolunteer = (body) => api('POST', '/api/staffing/volunteer', body);
        const postActivation = (p, body) => api('POST', p, body);

        // ═══ ① القاعدة السيرفرية: D12⇒400 وغائب من المرشحين · V/WO/بلا سجل حاضرون ═══
        const cand0 = await getCandidates('');
        const names0 = (cand0.data.candidates || []).map(c => c.name);
        const c802 = (cand0.data.candidates || []).find(c => c.name === 'مجاز تطوع');
        const c803 = (cand0.data.candidates || []).find(c => c.name === 'نهاية أسبوع');
        const c804 = (cand0.data.candidates || []).find(c => c.name === 'بلا جدولة');
        const rWork = await postVolunteer({ employeeCode: '801' });
        const t1 = cand0.status === 200 &&
            !names0.includes('عامل فعلي') &&
            c802 && c802.dayCode === 'V' && c803 && c803.dayCode === 'WO' && c804 && c804.dayCode === null &&
            rWork.status === 400;
        record('① القاعدة: D12⇒400 عند الإضافة وغائب من المرشحين · V/WO/بلا سجل حاضرون برموزهم',
            t1, `المرشحون=[${names0.join('، ')}] D12_قبول=${rWork.status}`);

        // ═══ ② الإضافة = دخول الحوض فقط: V⇒200 بلا فريق ⇒ «متطوع — غير مفعّل» برمز يومه ═══
        const v2 = await postVolunteer({ employeeCode: '802' });
        const pool2 = await getPool();
        const pv2 = (pool2.data.supporters || []).find(s => s.name === 'مجاز تطوع');
        const st2 = await getState();
        const tlV = await getTimeline('مجاز تطوع');
        const vEv = (tlV.data.events || []).find(e => e.event_type === 'volunteer_support');
        const inAnyTeam = Object.values(st2.data.teams || {}).some(t =>
            (t.members || []).some(x => x.name === 'مجاز تطوع'));
        const t2 = v2.status === 200 && v2.data && v2.data.success && v2.data.appended === 1 &&
            !v2.data.teamName && // الإضافة بلا إسناد
            pv2 && pv2.volunteer === true && pv2.shiftCode === 'V' && !pv2.team &&
            String(pv2.employeeCode) === '802' && pv2.jobTitle === 'فني إسعاف' &&
            vEv && (vEv.team_id == null) && vEv.shift_id === shiftId &&
            !inAnyTeam; // ليس عضوًا في أي فرقة بعد
        record('② V⇒200 بلا فريق: يظهر في الحوض «متطوع — غير مفعّل» برمز يومه V · الحدث بلا teamId · بلا عضوية فرقة',
            t2, `status=${v2.status} حوض=${!!pv2} volunteer=${pv2 && pv2.volunteer} رمز=${pv2 && pv2.shiftCode} فريق_الحدث=${vEv && vEv.team_id} عضوية=${inAnyTeam}`);

        // المتطوع يغادر قائمة المرشحين فورًا (مشغّل مفتوح)
        const candAfter = await getCandidates('مجاز');
        const t2b = candAfter.status === 200 && !(candAfter.data.candidates || []).some(c => c.name === 'مجاز تطوع');
        record('②ب المتطوع يغادر قائمة المرشحين (مشغّل مفتوح)', t2b,
            `النتائج=[${(candAfter.data.candidates || []).map(c => c.name).join('، ')}]`);

        // ═══ ③ WO يُقبل للحوض (ليست ضمن OFF_CODES — القاعدة ليست قائمة راحة) ═══
        const v3 = await postVolunteer({ employeeCode: '803' });
        const pool3 = await getPool();
        const pv3 = (pool3.data.supporters || []).find(s => s.name === 'نهاية أسبوع');
        const t3 = v3.status === 200 && v3.data && v3.data.appended === 1 &&
            pv3 && pv3.volunteer === true && pv3.shiftCode === 'WO';
        record('③ WO⇒200: يدخل الحوض متطوعًا برمز يومه WO', t3,
            `status=${v3.status} رمز=${pv3 && pv3.shiftCode}`);

        // ═══ ④ بلا سجل كادر لليوم يُقبل للحوض (بالاسم فقط — بلا كود) ═══
        const v4 = await postVolunteer({ employeeName: 'بلا جدولة' });
        const pool4 = await getPool();
        const pv4 = (pool4.data.supporters || []).find(s => s.name === 'بلا جدولة');
        const t4 = v4.status === 200 && v4.data && v4.data.appended === 1 &&
            pv4 && pv4.volunteer === true && pv4.shiftCode === null &&
            String(pv4.employeeCode) === '804'; // الإثراء من employees رغم غياب صف الكادر
        record('④ بلا سجل⇒200 (بالاسم فقط): في الحوض بهويته من employees وبلا رمز يوم', t4,
            `status=${v4.status} كود=${pv4 && pv4.employeeCode} رمز=${pv4 && pv4.shiftCode}`);

        // ═══ ⑤ منع التكرار: إضافة ثانية ⇒ idempotent بلا حدث ثانٍ ═══
        const v5 = await postVolunteer({ employeeCode: '802' });
        const tlDup = await getTimeline('مجاز تطوع');
        const vCount = (tlDup.data.events || []).filter(e => e.event_type === 'volunteer_support').length;
        const t5 = v5.status === 200 && v5.data && v5.data.appended === 0 &&
            v5.data.skipped === 'already-volunteering' && vCount === 1;
        record('⑤ تكرار الإضافة⇒200 بلا إلحاق (appended=0 · حدث واحد فقط)', t5,
            `status=${v5.status} appended=${v5.data && v5.data.appended} أحداث=${vCount}`);

        // ═══ ⑥ التفعيل من الحوض: جنوب 15 غير المجدولة ⇒ تظهر رسميًا بعضو activation ويغيب من الحوض ═══
        const act = await postActivation('/api/staffing/activation', { employeeName: 'مجاز تطوع', teamName: 'جنوب 15' });
        const st6 = await getState();
        const j15 = st6.data.teams && st6.data.teams['جنوب 15'];
        const actMember = j15 && (j15.members || []).find(x => x.role === 'activation' && x.name === 'مجاز تطوع');
        const pool6 = await getPool();
        // تمييز عرضي: العضو المفعَّل يحمل activationKind='volunteer' (تطوعه مفتوح بلا فريق)
        // وعضو القاعدة (عامل فعلي في جنوب 3) بلا activationKind إطلاقًا
        const j3 = st6.data.teams && st6.data.teams['جنوب 3'];
        const baseMember = j3 && (j3.members || []).find(x => x.name === 'عامل فعلي');
        const t6 = act.status === 200 && act.data && act.data.appended === 1 &&
            j15 && actMember && actMember.state === 'activation' && String(actMember.code) === '802' &&
            actMember.activationKind === 'volunteer' &&
            baseMember && baseMember.role === 'base' && baseMember.activationKind === undefined &&
            j15.activeCount === 1 &&
            !(pool6.data.supporters || []).some(s => s.name === 'مجاز تطوع'); // غادر الحوض
        record('⑥ تفعيل جنوب 15 غير المجدولة⇒200: عضو activation بـactivationKind=volunteer · القاعدة بلا علم · يغيب من الحوض',
            t6, `status=${act.status} kind=${actMember && actMember.activationKind} قاعدة_kind=${baseMember && baseMember.activationKind} حوض=${(pool6.data.supporters || []).map(s => s.name).join('، ')}`);

        // ═══ ⑥ب الحلقة 3 (التشكيلة الفعلية): المفعَّل المتطوع داخل effectiveRoster بـactivationKind
        // (سد فجوة الفلتر — القوى الفعلية = المجدولون + المفعَّلون + الدعم) والعدادات بلا تضخيم ═══
        const eff6 = j15 && (j15.effectiveRoster || []).find(x => x.name === 'مجاز تطوع');
        const effBase6 = j3 && (j3.effectiveRoster || []).some(x => x.name === 'عامل فعلي' && x.activationKind === undefined);
        const t6b = eff6 && eff6.role === 'activation' && eff6.activationKind === 'volunteer' &&
            j15.activeCount === 1 && // العداد كما هو — الإصلاح عرضي/تشكيلي فقط
            effBase6; // أعضاء القاعدة يبقون في التشكيلة بلا علم
        record('⑥ب التشكيلة الفعلية: المتطوع المفعَّل داخل effectiveRoster بـactivationKind=volunteer · القاعدة باقية · activeCount بلا تضخيم',
            t6b, `موجود=${!!eff6} kind=${eff6 && eff6.activationKind} قاعدة=${effBase6} عداد=${j15 && j15.activeCount}`);

        // ═══ ⑥ج الحلقة 4 (لقطة سير العمل): prepare يبني اللقطة طازجة من getState —
        // الصفة تتدفق تلقائيًا إلى snapshot.staffing.teams (الأعضاء + التشكيلة الفعلية) ═══
        const prep = await api('POST', '/api/workflow/prepare', {});
        const wfSnap = prep.data && prep.data.workflow && prep.data.workflow.snapshot;
        const wfJ15 = wfSnap && wfSnap.staffing && wfSnap.staffing.teams && wfSnap.staffing.teams['جنوب 15'];
        const wfVolM = wfJ15 && (wfJ15.members || []).find(x => x.name === 'مجاز تطوع');
        const wfVolE = wfJ15 && (wfJ15.effectiveRoster || []).find(x => x.name === 'مجاز تطوع');
        const t6c = prep.status === 200 && prep.data && prep.data.success &&
            wfVolM && wfVolM.activationKind === 'volunteer' &&
            wfVolE && wfVolE.activationKind === 'volunteer';
        record('⑥ج لقطة سير العمل: snapshot.staffing.teams[جنوب 15] تحمل activationKind=volunteer (عضوًا وتشكيلةً فعلية)',
            t6c, `prepare=${prep.status} عضو=${wfVolM && wfVolM.activationKind} فعلية=${wfVolE && wfVolE.activationKind}`);

        // ═══ ⑦ إنهاء التفعيل ⇒ يعود للحوض «متطوع — غير مفعّل» والفرقة تغادر الحالة ═══
        const end7 = await postActivation('/api/staffing/activation/end', { employeeName: 'مجاز تطوع' });
        const st7 = await getState();
        const pool7 = await getPool();
        const pv7 = (pool7.data.supporters || []).find(s => s.name === 'مجاز تطوع');
        const t7 = end7.status === 200 && end7.data && end7.data.appended === 1 &&
            !(st7.data.teams && st7.data.teams['جنوب 15']) &&
            pv7 && pv7.volunteer === true && pv7.shiftCode === 'V';
        record('⑦ activation/end⇒200: المتطوع يعود للحوض غير مفعّل برمزه · جنوب 15 تغادر الحالة',
            t7, `end=${end7.status} فرقة_باقية=${!!(st7.data.teams && st7.data.teams['جنوب 15'])} حوض=${!!pv7} رمز=${pv7 && pv7.shiftCode}`);

        // ═══ ⑦ج ذهبي: المفعَّل الأوفرلاب يحمل activationKind='overlap' (وسمه محفوظ — لا كسر) ═══
        const actG = await postActivation('/api/staffing/activation', { employeeName: 'أوفرلاب ذهبي', teamName: 'جنوب 15' });
        const stG = await getState();
        const j15g = stG.data.teams && stG.data.teams['جنوب 15'];
        const gMember = j15g && (j15g.members || []).find(x => x.role === 'activation' && x.name === 'أوفرلاب ذهبي');
        const gEff = j15g && (j15g.effectiveRoster || []).find(x => x.name === 'أوفرلاب ذهبي');
        const endG = await postActivation('/api/staffing/activation/end', { employeeName: 'أوفرلاب ذهبي' });
        const t7g = actG.status === 200 && actG.data && actG.data.appended === 1 &&
            gMember && gMember.activationKind === 'overlap' &&
            gEff && gEff.activationKind === 'overlap' && // الأوفرلاب المفعَّل في التشكيلة الفعلية أيضًا
            endG.status === 200;
        record('⑦ج ذهبي: مفعَّل الأوفرلاب (O12-12) ⇒ activationKind=overlap في الأعضاء وeffectiveRoster (وسمه «أوفرلاب مفعَّل» محفوظ)',
            t7g, `تفعيل=${actG.status} kind=${gMember && gMember.activationKind} فعلية=${gEff && gEff.activationKind} إنهاء=${endG.status}`);

        // ═══ ⑧ الرفض: موظف وهمي⇒404 · بلا موظف⇒400 · تفعيل بفريق وهمي⇒404 · تفعيل D12 (غير متطوع)⇒400 ═══
        const rNoEmp = await postVolunteer({ employeeCode: '999' });
        const rNoBody = await postVolunteer({});
        const rFakeTeam = await postActivation('/api/staffing/activation', { employeeName: 'مجاز تطوع', teamName: 'جنوب 20' });
        const rD12Act = await postActivation('/api/staffing/activation', { employeeName: 'عامل فعلي', teamName: 'جنوب 15' });
        const t8 = rNoEmp.status === 404 && rNoBody.status === 400 &&
            rFakeTeam.status === 404 && rD12Act.status === 400;
        record('⑧ الرفض: موظف وهمي⇒404 · بلا موظف⇒400 · فريق وهمي للتفعيل⇒404 · D12 بلا تطوع⇒400 (قاعدة التفعيل قائمة)',
            t8, `موظف=${rNoEmp.status} ناقص=${rNoBody.status} فريق=${rFakeTeam.status} D12=${rD12Act.status}`);

        // ═══ ⑨ «إنهاء تطوع»: support_end بلا فريق يخرج الموظف نهائيًا من الحوض + سجل منتهٍ ═══
        const end9 = await api('POST', '/api/shift-completion', {
            shiftType: 'صباحية', shiftDate: today,
            events: [{ type: 'support_end', employeeName: 'نهاية أسبوع' }] // بلا teamId — متطوع الحوض
        });
        const pool9 = await getPool();
        const tl9 = await getTimeline();
        const cov803 = (tl9.data.coverageRecords || []).find(r => r.employee === 'نهاية أسبوع');
        const t9 = end9.status === 200 && end9.data && end9.data.appended === 1 &&
            !(pool9.data.supporters || []).some(s => s.name === 'نهاية أسبوع') &&
            cov803 && cov803.coverageType === 'volunteer' && cov803.status === 'ended' &&
            cov803.durationMinutes !== null &&
            // الباقون بلا مساس: مجاز تطوع وبلا جدولة ما زالا في الحوض
            (pool9.data.supporters || []).some(s => s.name === 'مجاز تطوع') &&
            (pool9.data.supporters || []).some(s => s.name === 'بلا جدولة');
        record('⑨ إنهاء تطوع الحوض: support_end بلا فريق⇒خرج نهائيًا + سجل تغطية منتهٍ · الباقون بلا مساس',
            t9, `end=${end9.status} سجل=${cov803 && cov803.status}/${cov803 && cov803.durationMinutes}د حوض=[${(pool9.data.supporters || []).map(s => s.name).join('، ')}]`);

        // ═══ إيقاف الخادم قبل أي قراءة مباشرة للقاعدة ═══
        server.kill();
        await new Promise(r => { const t = setTimeout(r, 8000); server.once('exit', () => { clearTimeout(t); r(); }); });
        server = null;
        await sleep(600); // تحرير مقابض WAL

        // إعادة فتح القاعدة (وحدة جديدة — ذاكرة التخزين المؤقت تُمحى)
        for (const k of Object.keys(require.cache)) {
            if (k.startsWith(ROOT + path.sep) && !k.includes('node_modules')) delete require.cache[k];
        }
        const db2 = require(path.join(ROOT, 'db.js'));
        await db2.init(false);

        // ═══ ⑩ حارس الـ192: computeMetrics قبل/بعد الدورة كاملة متطابقة حرفيًا + بصمة shift_roster ثابتة ═══
        const metrics2 = new (require(path.join(ROOT, 'services', 'schedule-metrics-service')))({ db: db2 });
        const metricsAfter = JSON.stringify(await metrics2.computeMetrics(monthStart, monthEnd, 192));
        const rosterHashAfter = hashOf(JSON.stringify(await db2.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id')));
        const t10 = metricsBefore === metricsAfter && rosterHashBefore === rosterHashAfter;
        record('⑩ حارس الـ192: computeMetrics قبل/بعد متطابقة حرفيًا + صفر كتابة على shift_roster',
            t10, `مقاييس=${metricsBefore === metricsAfter} بصمة_كادر=${rosterHashBefore === rosterHashAfter}`);

        // ═══ ⑩ب الحلقة 5 (الأرشيف): باني اللقطة يختم أحداث التطوع كاملة —
        // volunteer_support بلا فريق بـcoverageType=volunteer (ختم الهوية) +
        // support_end المنهي بلا فريق — والمدة قابلة للاشتقاق من الختمين الزمنيين ═══
        const { ShiftArchiveSnapshot } = require(path.join(ROOT, 'shift-archive-engine.js'));
        const snapBuilder = new ShiftArchiveSnapshot(db2, tmpDir);
        const snap = await snapBuilder.create(shiftId);
        const ops = Array.isArray(snap.operationalEvents) ? snap.operationalEvents : [];
        const vEv802 = ops.find(e => e.event_type === 'volunteer_support' && e.entity_id === 'مجاز تطوع');
        const vEv803 = ops.find(e => e.event_type === 'volunteer_support' && e.entity_id === 'نهاية أسبوع');
        const eEv803 = ops.find(e => e.event_type === 'support_end' && e.entity_id === 'نهاية أسبوع');
        let pl803 = {};
        try { pl803 = vEv803 && vEv803.payload ? JSON.parse(vEv803.payload) : {}; } catch (_) {}
        const dur803 = (vEv803 && eEv803)
            ? Math.round((new Date(eEv803.created_at) - new Date(vEv803.created_at)) / 60000) : null;
        const t10b = vEv802 && (vEv802.team_id == null) && vEv802.shift_id === shiftId &&
            vEv803 && (vEv803.team_id == null) && pl803.coverageType === 'volunteer' &&
            pl803.source === 'completion-volunteer' && String(pl803.employeeNumber) === '803' &&
            eEv803 && (eEv803.team_id == null) && eEv803.shift_id === shiftId &&
            dur803 !== null && dur803 >= 0;
        record('⑩ب لقطة الأرشيف: volunteer_support (بلا فريق · coverageType=volunteer · هوية كاملة) + support_end منتهٍ مختومان — المدة قابلة للاشتقاق',
            t10b, `أحداث=${ops.length} تطوع802=${!!vEv802} تطوع803=${!!vEv803}/${pl803.coverageType} إنهاء=${!!eEv803} مدة=${dur803}د`);

        await db2.closeDb();

        // ═══ ⑪ فحوص الواجهة الساكنة: المودال بلا منتقي فرقة · زر الحوض يفتح مودال التفعيل · إنهاء تطوع · شارة المتطوع شرطية في الأسطح الثلاثة ═══
        const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        const modalMatch = html.match(/<div class="modal-overlay" id="volunteerModal">([\s\S]*?)<\/div>\s*<\/div>/);
        const modalSrc = modalMatch ? modalMatch[1] : '';
        const modalOk = !!modalSrc && !modalSrc.includes('volunteerTeam') && !/<select/i.test(modalSrc) &&
            modalSrc.includes('volunteerSearch'); // بلا منتقي فرقة — بحث فقط
        const hasBtn = html.includes('🙋 متطوع') && html.includes('openVolunteerModal');
        const hitsCandidates = html.includes("'/api/staffing/volunteer-candidates?q='");
        const postsVolunteer = html.includes("'/api/staffing/volunteer'");
        const noEmpSearch = !html.includes('/api/employees/search');
        const debounce = /function volunteerSearchInput\(\)[\s\S]{0,400}setTimeout/.test(html);
        const confirmSrc = (html.match(/function confirmVolunteer\(\) \{[\s\S]*?\n\}/) || [''])[0];
        const confirmNoTeam = !!confirmSrc && !confirmSrc.includes('teamName') && !confirmSrc.includes('volunteerTeam') &&
            confirmSrc.includes('employeeName: p.name');
        const poolBadge = html.includes('متطوع — غير مفعّل') && /p\.volunteer/.test(html);
        const poolActivates = /isVol[\s\S]{0,250}openActivationModal/.test(html); // زر الحوض يفتح مودال التفعيل
        const endVol = html.includes('إنهاء تطوع') && /function endVolunteer\([\s\S]{0,450}support_end/.test(html);
        const actTeamsAll = /function openActivationModal[\s\S]{0,1400}vbTeamsCache[\s\S]{0,300}is_active[\s\S]{0,700}activationTeam/.test(html);
        // التمييز العرضي (تثبيت صفة «متطوع»): الشارة «🤝 متطوع» بجوار الاسم +
        // السطر الثانوي «منذ …» فقط للمتطوع — الأوفرلاب يحتفظ بـ«أوفرلاب مفعَّل — منذ …»
        // والصيغة القديمة «متطوع مفعَّل» أُزيلت من السطحين
        const badgeCond = /m\.activationKind === 'volunteer'/.test(html) &&
            html.includes('🤝 متطوع') && html.includes('أوفرلاب مفعَّل') &&
            /isVolAct \? '' : 'أوفرلاب مفعَّل'/.test(html) &&
            /'منذ ' \+ TimeRiyadh\.formatTime\(m\.since\)/.test(html) &&
            !html.includes('متطوع مفعَّل');
        const wfHtml = fs.readFileSync(path.join(ROOT, 'public', 'workflow.html'), 'utf8');
        const wfBadge = /m\.activationKind === 'volunteer'/.test(wfHtml) &&
            wfHtml.includes('<span class="p-note">🤝 متطوع</span>') && !wfHtml.includes('متطوع مفعَّل');
        const pdfSrc = fs.readFileSync(path.join(ROOT, 'services', 'workflow-pdf-service.js'), 'utf8');
        const pdfBadge = /activationKind === 'volunteer'/.test(pdfSrc) && pdfSrc.includes('متطوع مفعَّل');
        const t11 = modalOk && hasBtn && hitsCandidates && postsVolunteer && noEmpSearch &&
            debounce && confirmNoTeam && poolBadge && poolActivates && endVol && actTeamsAll &&
            badgeCond && wfBadge && pdfBadge;
        record('⑪ الواجهة ساكنًا: المودال بلا منتقي فرقة · التأكيد بلا teamName · شارة الحوض + زر التفعيل · إنهاء تطوع · شارة «🤝 متطوع» شرطية في التكميل/سير العمل/PDF ووسم الأوفرلاب محفوظ',
            t11, `مودال=${modalOk} تأكيد=${confirmNoTeam} شارة=${badgeCond} سير=${wfBadge} pdf=${pdfBadge} فرق=${actTeamsAll}`);

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
    console.log('✅ جميع اختبارات المرحلة ب (تصحيح المالك — متطوع بمسار الـOverlap) ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
