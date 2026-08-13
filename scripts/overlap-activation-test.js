/**
 * اختبارات مرحلة الأوفرلاب 4 — تفعيل الفرقة من شاشة التكميل (Completion-Screen Activation)
 * ═══════════════════════════════════════════════════════════════════════════════
 * نمط العزل نفسه في overlap-late-test.js + بوابة HTTP حقيقية:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (تُضبط قبل require db.js).
 *   - الكادر يُزرع عبر الكاتب الرسمي RosterSyncService لتاريخ الرياض «اليوم»
 *     (المناوبة النشطة تُبدأ عبر /api/start-new-shift وتُختم بتاريخ اليوم سيرفريًا).
 *   - الخادم الحقيقي يُشغَّل كعملية ابن على منفذ اختبار (نفس نمط regression-test)
 *     فيُختبر العقد الفعلي: 200/400/404/409 + الختم السيرفري + الاشتقاق.
 *   - قراءات القاعدة المباشرة (بصمة shift_roster وcrew_key) تتم بعد إيقاف
 *     الخادم — لا نسخ ولا قراءة أثناء الإمساك.
 *   - تأكيدات الواجهة عبر regex على المصدر الفعلي لـ radio-completion.html.
 *
 * التشغيل: node scripts/overlap-activation-test.js   (خروج غير صفري عند أي فشل)
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
    console.log('\n═══ اختبارات مرحلة الأوفرلاب 4 — تفعيل الفرقة من شاشة التكميل ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-activation-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const TimeRiyadh = require(path.join(ROOT, 'public/js/time-riyadh.js'));
    const today = TimeRiyadh.formatDate(new Date()); // تاريخ الرياض الجداري — نفس ختم الخادم

    let server = null;
    let rosterHashBefore = null;

    const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');

    try {
        // ── 1) قاعدة معزولة + بذر الكادر عبر الكاتب الرسمي ──
        const db = require(path.join(ROOT, 'db.js'));
        await db.init(false); // مخطط كامل + ترحيلات + بذر (جنوب 15 موجودة ونشطة)
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        await sync.syncFromSchedule([
            // أوفرلاب بلا فريق (مرشح التفعيل) — كود تشغيلي ملحق صباحي التصنيف
            { employeeNumber: '901', name: 'أوفرلاب مرشح', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12-12' }] },
            // نهاري عادي بفريق — ليس في الحوض (منشغل كطاقم أساسي)
            { employeeNumber: '902', name: 'نهاري عادي أ', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '903', name: 'نهاري عادي ب', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            // أوفرلاب معيّن صراحة (O12C13) — لا يظهر في الحوض
            { employeeNumber: '904', name: 'أوفرلاب معين', team: 'جنوب 13', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12C13' }] },
            // تدخل سريع بتعيين صريح (RRC1 ← سريع 1) — منشغل، ليس في الحوض
            { employeeNumber: '905', name: 'سريع صريح', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'RRC1' }] },
            // الصيغة الجديدة الموقعة: حرف D/N مصدر حقيقة الوردية (⑪)
            { employeeNumber: '906', name: 'سريع دال جديد', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'RRA1-D-04' }] },
            { employeeNumber: '907', name: 'سريع نون جديد', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'RRA1-N-16' }] },
            // صيغة باطلة (X ليست D/N) — ليست كودًا تشغيليًا ⇒ التفعيل مرفوض (⑪)
            { employeeNumber: '908', name: 'سريع باطل', team: '', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'RRA1-X-04' }] }
        ]);
        // فريق غير نشط لاختبار الرفض 400
        await db.run("UPDATE teams SET is_active = 0 WHERE name = 'جنوب 19'");

        rosterHashBefore = hashOf(JSON.stringify(await db.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id')));

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
        const actorName = login.data.user.name;

        const start = await api('POST', '/api/start-new-shift', { shiftType: 'صباحية' });
        const shiftId = start.data && start.data.shiftId;
        if (!shiftId) throw new Error('تعذر بدء المناوبة: ' + JSON.stringify(start.data));

        const getState = () => api('GET', `/api/staffing/state?shift_id=${shiftId}`);
        const getPool = () => api('GET', `/api/staffing/available-support?shift_id=${shiftId}`);
        const getTimeline = (ent) => api('GET', `/api/staffing/timeline?shift_id=${shiftId}${ent ? '&entity_id=' + encodeURIComponent(ent) : ''}`);

        // خط الأساس قبل أي تفعيل (لاختبار ④)
        const stateBefore = await getState();
        const requiredBefore = stateBefore.data.workforce.requiredTeams;

        // ═══ ① الحوض: أوفرلاب بلا فريق يظهر برمزه · D12 بفريق لا · المعيّن صراحة لا ═══
        const pool1 = await getPool();
        const names1 = (pool1.data.supporters || []).map(s => s.name);
        const cand = (pool1.data.supporters || []).find(s => s.name === 'أوفرلاب مرشح');
        const t1 = pool1.status === 200 &&
            cand && cand.shiftCode === 'O12-12' && !cand.team &&
            !names1.includes('نهاري عادي أ') && !names1.includes('نهاري عادي ب') &&
            !names1.includes('أوفرلاب معين') && !names1.includes('سريع صريح');
        record('① الحوض: O12-12 بلا فريق يظهر برمزه · D12 بفريق لا · المعيّن صراحة (O12C13/RRC1) لا',
            t1, `الحوض=[${names1.join('، ')}] shiftCode=${cand && cand.shiftCode}`);

        // ═══ ② تفعيل صالح (O12-12 + جنوب 15) ⇒ 200 + ختم سيرفري ═══
        const act = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب مرشح', teamName: 'جنوب 15' });
        const tlAct = await getTimeline('أوفرلاب مرشح');
        const actEv = (tlAct.data.events || []).find(e => e.event_type === 'activation');
        const t2 = act.status === 200 && act.data && act.data.success && act.data.appended === 1 &&
            act.data.shiftId === shiftId &&
            actEv && actEv.shift_id === shiftId &&
            actEv.shift_date === today && actEv.shift_type === 'صباحية' &&
            actEv.actor_name === actorName && !!actEv.created_at &&
            actEv.team_id === 'جنوب 15';
        record('② تفعيل صالح ⇒ 200 + حدث مختوم سيرفريًا (المناوبة/الفاعل/الوقت/الفريق)',
            t2, `status=${act.status} appended=${act.data && act.data.appended} actor=${actEv && actEv.actor_name} shift=${actEv && actEv.shift_id}`);

        // ═══ ③ الرفض: فريق غير موجود 404 · غير نشط 400 · D12 400 · غير مجدول 400 · تكرار بلا حدث ═══
        const r404 = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب مرشح', teamName: 'جنوب 20' });
        const rInactive = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب مرشح', teamName: 'جنوب 19' });
        const rD12 = await api('POST', '/api/staffing/activation', { employeeName: 'نهاري عادي أ', teamName: 'جنوب 15' });
        const rUnsched = await api('POST', '/api/staffing/activation', { employeeName: 'شخص خارج الجدول', teamName: 'جنوب 15' });
        const rDup = await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب مرشح', teamName: 'جنوب 15' });
        const tlDup = await getTimeline('أوفرلاب مرشح');
        const actCount = (tlDup.data.events || []).filter(e => e.event_type === 'activation').length;
        const t3 = r404.status === 404 && rInactive.status === 400 && rD12.status === 400 &&
            rUnsched.status === 400 &&
            rDup.status === 200 && rDup.data && rDup.data.appended === 0 && actCount === 1;
        record('③ الرفض: جنوب 20⇒404 · غير نشط⇒400 · D12⇒400 · غير مجدول⇒400 · تكرار مفتوح⇒بلا حدث ثانٍ',
            t3, `404=${r404.status} غيرنشط=${rInactive.status} D12=${rD12.status} غيرمجدول=${rUnsched.status} تكرار=${rDup.status}/أحداث=${actCount}`);

        // ═══ ④ انعكاس الحالة: جنوب 15 تدخل الاشتقاق بعضو activation · requiredTeams+1 ═══
        const stateAfter = await getState();
        const j15 = stateAfter.data.teams && stateAfter.data.teams['جنوب 15'];
        const actMember = j15 && (j15.members || []).find(m => m.role === 'activation' && m.name === 'أوفرلاب مرشح');
        const t4 = stateAfter.status === 200 && j15 && actMember &&
            actMember.state === 'activation' && actMember.code === '901' &&
            j15.activeCount === 1 &&
            stateAfter.data.workforce.requiredTeams === requiredBefore + 1;
        record('④ الحالة: جنوب 15 في /api/staffing/state بعضو activation · requiredTeams+1 (اشتقاق واحد)',
            t4, `required: ${requiredBefore}←${stateAfter.data.workforce.requiredTeams} activeCount=${j15 && j15.activeCount} code=${actMember && actMember.code}`);

        // ═══ ⑤ الحوض بعد التفعيل: المفعَّل يغادر «الدعم المتاح» ═══
        const pool2 = await getPool();
        const names2 = (pool2.data.supporters || []).map(s => s.name);
        const t5 = pool2.status === 200 && !names2.includes('أوفرلاب مرشح');
        record('⑤ الحوض بعد التفعيل: المفعَّل غادر «الدعم المتاح»', t5, `الحوض=[${names2.join('، ')}]`);

        // ═══ ⑦ crew_key يشمل هوية العضو المفعَّل (قرار جاهزية أثناء التفعيل) ═══
        // القرار يُختم سيرفريًا بهوية الطاقم الفعلية (_decisionCrewKey ← members) —
        // يُقرأ الصف من القاعدة بعد إيقاف الخادم (لا قراءة أثناء الإمساك).
        const readyDec = await api('POST', '/api/shift-completion', {
            shiftType: 'صباحية', shiftDate: today,
            events: [{ type: 'ready', teamId: 'جنوب 15' }]
        });

        // ═══ ⑥ الإنهاء: activation_end يُغلق ⇒ الفريق يغادر الحالة والموظف يعود للحوض · بلا مفتوح⇒409 ═══
        const end1 = await api('POST', '/api/staffing/activation/end', { employeeName: 'أوفرلاب مرشح' });
        const stateEnd = await getState();
        const pool3 = await getPool();
        const names3 = (pool3.data.supporters || []).map(s => s.name);
        const end409 = await api('POST', '/api/staffing/activation/end', { employeeName: 'أوفرلاب مرشح' });
        const t6 = end1.status === 200 && end1.data && end1.data.appended === 1 &&
            !(stateEnd.data.teams && stateEnd.data.teams['جنوب 15']) &&
            names3.includes('أوفرلاب مرشح') &&
            end409.status === 409;
        record('⑥ الإنهاء: يُغلق التفعيل ⇒ الفريق يغادر الحالة + الموظف يعود للحوض · إنهاء بلا مفتوح⇒409',
            t6, `end=${end1.status} فريق_باقٍ=${!!(stateEnd.data.teams && stateEnd.data.teams['جنوب 15'])} حوض=${names3.includes('أوفرلاب مرشح')} ثانية=${end409.status}`);

        // ═══ ⑧ الأرشيف: اللقطة تحمل حدثي activation/activation_end + التشكيلة الفعلية · بصمة الكادر ثابتة ═══
        // نفس مصدري لقطة سير العمل الرسمي (getState ← teams/workforce · getTimeline ← events)
        const tlAll = await getTimeline();
        const snapEvents = tlAll.data.events || [];
        const snapshot = { staffing: { teams: stateAfter.data.teams, workforce: stateAfter.data.workforce }, events: snapEvents };
        const sealed = JSON.parse(JSON.stringify(snapshot)); // تخزين JSON كما في الأرشيف
        const hasAct = sealed.events.some(e => e.event_type === 'activation' && e.entity_id === 'أوفرلاب مرشح');
        const hasEnd = sealed.events.some(e => e.event_type === 'activation_end' && e.entity_id === 'أوفرلاب مرشح');
        const comp = sealed.staffing.teams['جنوب 15'] &&
            sealed.staffing.teams['جنوب 15'].members.some(m => m.role === 'activation' && m.name === 'أوفرلاب مرشح');
        const sealable = typeof hashOf(JSON.stringify(sealed)) === 'string';
        const t8a = hasAct && hasEnd && comp && sealable;

        // ═══ ⑩ تكامل المرحلة 3: تأخير موظف مفعَّل يُحسب من بدايته التشغيلية لا 05:00/17:00 ═══
        // إعادة تفعيل ثم حدثا late/arrival عبر عقد أحداث التكميل (الختم سيرفري)
        await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلاب مرشح', teamName: 'جنوب 15' });
        await api('POST', '/api/shift-completion', {
            shiftType: 'صباحية', shiftDate: today,
            events: [{ type: 'late', employeeName: 'أوفرلاب مرشح', teamId: 'جنوب 15', reason: 'تأخير' }]
        });
        await api('POST', '/api/shift-completion', {
            shiftType: 'صباحية', shiftDate: today,
            events: [{ type: 'arrival', employeeName: 'أوفرلاب مرشح', teamId: 'جنوب 15' }]
        });
        const tlLate = await getTimeline();
        const lateRec = (tlLate.data.lateRecords || []).find(r => r.employee === 'أوفرلاب مرشح');
        const arrEv = (tlLate.data.events || []).filter(e => e.event_type === 'arrival' && e.entity_id === 'أوفرلاب مرشح').pop();
        const opStartExpected = R(today, '12:00'); // O12-12 في صباحية ⇒ نفس اليوم 12:00
        const expectedDur = arrEv ? Math.max(0, Math.round((new Date(arrEv.created_at) - new Date(opStartExpected)) / 60000)) : null;
        const t10 = lateRec && lateRec.status === 'arrived' &&
            lateRec.operationalStart === opStartExpected &&
            lateRec.startedAt === opStartExpected &&          // لا 05:00 العالمية
            lateRec.startedAt !== R(today, '05:00') &&
            expectedDur !== null && lateRec.durationMinutes === expectedDur;
        record('⑩ المرحلة 3 × التفعيل: تأخير المفعَّل من بدايته التشغيلية 12:00 (لا 05:00/17:00)',
            t10, `startedAt=${lateRec && lateRec.startedAt} المدة=${lateRec && lateRec.durationMinutes} متوقع=${expectedDur}`);

        // ═══ ⑪ الصيغة الجديدة: التفعيل يقبل RRA1-D-04/RRA1-N-16 ويرفض RRA1-X-04 ═══
        const actD = await api('POST', '/api/staffing/activation', { employeeName: 'سريع دال جديد', teamName: 'جنوب 15' });
        const actN = await api('POST', '/api/staffing/activation', { employeeName: 'سريع نون جديد', teamName: 'جنوب 15' });
        const actX = await api('POST', '/api/staffing/activation', { employeeName: 'سريع باطل', teamName: 'جنوب 15' });
        const endD = await api('POST', '/api/staffing/activation/end', { employeeName: 'سريع دال جديد' });
        const endN = await api('POST', '/api/staffing/activation/end', { employeeName: 'سريع نون جديد' });
        const t11 = actD.status === 200 && actD.data && actD.data.appended === 1 &&
            actN.status === 200 && actN.data && actN.data.appended === 1 &&
            actX.status === 400 &&
            endD.status === 200 && endN.status === 200;
        record('⑪ الصيغة الجديدة × التفعيل: RRA1-D-04⇒200 · RRA1-N-16⇒200 · RRA1-X-04⇒400 (ليست تشغيلية)',
            t11, `D=${actD.status} N=${actN.status} X=${actX.status} إنهاء=${endD.status}/${endN.status}`);

        // ═══ إيقاف الخادم قبل أي قراءة مباشرة للقاعدة ═══
        const readyOk = readyDec.status === 200 && readyDec.data && readyDec.data.success;
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

        // ⑦ (قراءة ما بعد الإيقاف): صف قرار جنوب 15 يحمل crew_key بهوية المفعَّل
        const decRow = await db2.get(
            'SELECT team_id, status, crew_key FROM shift_team_status WHERE shift_id = ? AND team_id = ?',
            [shiftId, 'جنوب 15']);
        const t7 = readyOk && decRow && decRow.status === 'ready' &&
            typeof decRow.crew_key === 'string' && decRow.crew_key.split('|').includes('901');
        record('⑦ crew_key يشمل هوية العضو المفعَّل (الكود الوظيفي 901) عند ختم قرار الفريق',
            t7, `crew_key=${decRow && decRow.crew_key} قرار=${readyOk}`);

        // ⑧ (تتمة): بصمة shift_roster لا تتغير قبل/بعد دورة التفعيل كاملة
        const rosterHashAfter = hashOf(JSON.stringify(await db2.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id')));
        const t8 = t8a && rosterHashBefore === rosterHashAfter;
        record('⑧ الأرشيف: الحدثان + التشكيلة الفعلية في اللقطة القابلة للختم · بصمة shift_roster ثابتة',
            t8, `حدثان=${hasAct && hasEnd} تشكيلة=${!!comp} بصمة=${rosterHashBefore === rosterHashAfter}`);

        await db2.closeDb();

        // ═══ ⑨ استخراج الواجهة: الزر مشروط بالكود التشغيلي · القائمة من /api/teams · بلا إدخال حر ═══
        const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        const scriptLoaded = /<script src="js\/core\/operational-codes\.js"><\/script>/.test(html);
        const gateIdx = html.indexOf('OperationalCodes.isOperationalCode(p.shiftCode)');
        const gateCtx = gateIdx >= 0 ? html.slice(gateIdx, gateIdx + 1200) : '';
        const badgeBtnGated = gateIdx >= 0 &&
            gateCtx.includes('أوفرلاب — غير مفعّل') && gateCtx.includes('تفعيل فرقة') &&
            gateCtx.includes('openActivationModal');
        const modalMatch = html.match(/<div class="modal-overlay" id="activationModal">([\s\S]*?)<\/div>\s*<\/div>/);
        const modalSrc = modalMatch ? modalMatch[1] : '';
        const modalNoFreeText = !!modalSrc && !/<input/i.test(modalSrc) && modalSrc.includes('<select id="activationTeam">');
        const selectFromTeams = /vbTeamsCache[\s\S]{0,400}activationTeam/.test(html) &&
            html.includes("'/api/teams'");
        const endBtn = html.includes('إنهاء التفعيل') && html.includes("'/api/staffing/activation/end'");
        const t9 = scriptLoaded && badgeBtnGated && modalNoFreeText && selectFromTeams && endBtn;
        record('⑨ الواجهة: الزر مشروط بـ isOperationalCode · قائمة المودال من /api/teams · بلا إدخال حر · زر إنهاء',
            t9, `سكربت=${scriptLoaded} مشروط=${badgeBtnGated} مودال=${modalNoFreeText} قائمة=${selectFromTeams} إنهاء=${endBtn}`);

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
    console.log('✅ جميع اختبارات مرحلة الأوفرلاب 4 (التفعيل) ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
