/**
 * اختبار نوع الدعم «أوفرلاب» في شاشة تنفيذ الدعم (قرار المالك 2026-10-22)
 * ═══════════════════════════════════════════════════════════════════════════════
 * السيناريوهات المعتمدة:
 *   ① الواجهة: خيار «أوفرلاب» موجود في supportType، وقائمة «الفريق المدعوم»
 *     مصدرها vbTeamsCache (كل فرق القطاع النشطة) وليس serverTeamIds (المجدولة فقط).
 *   ② POST /api/shift-completion بحدث overlap لفريق نشط غير مجدول (جنوب 15) ⇒ 200
 *     والحدث يُحفظ فعليًا (لا مجرد إظهار).
 *   ③ الاشتقاق: الداعم يظهر على بطاقة جنوب 15 بدور support وحالة overlap،
 *     ويغادر حوض الانشغال، وسجل التغطية coverageType=overlap.
 *   ④ منع التكرار: نفس الحدث ثانيةً ⇒ appended=0 (idempotent).
 *   ⑤ الإغلاق: support_end يُقبل مع overlap مفتوح ويُغلقه (يخرج من البطاقة).
 *   ⑥ عدم كسر الأنواع القائمة: volunteer_support وexternal_support يعملان كما كانا.
 *   ⑦ حارس: بصمة shift_roster ثابتة (لا كتابة على الجدول الرسمي).
 *
 * نمط العزل نفسه في volunteer-from-completion-test.js حرفيًا: قاعدة SQLite
 * مؤقتة عبر DB_PATH · زرع عبر RosterSyncService · خادم حقيقي كعملية ابن على
 * منفذ اختبار · قراءات القاعدة المباشرة بعد إيقاف الخادم فقط.
 *
 * التشغيل: node scripts/overlap-support-type-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3129;
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
    console.log('\n═══ اختبار نوع الدعم «أوفرلاب» — شاشة تنفيذ الدعم ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-support-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const TimeRiyadh = require(path.join(ROOT, 'public/js/time-riyadh.js'));
    const today = TimeRiyadh.formatDate(new Date());

    let server = null;
    let rosterHashBefore = null;
    const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');

    try {
        // ── 0) فحوص الواجهة الساكنة (المصدر الفعلي) ──
        const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        const hasOption = /<option value="overlap">أوفرلاب<\/option>/.test(html);
        const fillFn = (html.match(/function fillSupportTeams\(\) \{[\s\S]*?\n\}/) || [''])[0];
        const fromTeamsCache = /vbTeamsCache/.test(fillFn) && /is_active/.test(fillFn);
        const notFromRoster = !/serverTeamIds\(\)/.test(fillFn); // استدعاء فعلي — لا ذكر في تعليق
        const typeMapping = /ctype === 'overlap' \? 'overlap' : 'external_support'/.test(html);
        const labelMaps = /overlap: 'أوفرلاب'/.test(html.match(/var SUPPORT_TYPE_LABELS = \{[^}]+\}/) ? html : '');
        record('① الواجهة: خيار «أوفرلاب» موجود وقائمة الفرق من /api/teams (vbTeamsCache) لا من المجدولة فقط والربط الثلاثي صحيح',
            hasOption && fromTeamsCache && notFromRoster && typeMapping && labelMaps,
            `خيار=${hasOption} مصدر_الفرق=${fromTeamsCache} بلا_حصر=${notFromRoster} ربط=${typeMapping} وسم=${labelMaps}`);

        // ── 1) قاعدة معزولة + بذر الكادر عبر الكاتب الرسمي ──
        const db = require(path.join(ROOT, 'db.js'));
        await db.init(false); // مخطط كامل + ترحيلات + بذر (جنوب 1-15 موجودة ونشطة)
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        await sync.syncFromSchedule([
            // مجدول للعمل الفعلي اليوم (سياق واقعي للفرقة المجدولة جنوب 3)
            { employeeNumber: '810', name: 'عامل فعلي', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            // مجاز V — بطل الأوفرلاب
            { employeeNumber: '811', name: 'داعم أوفرلاب', team: 'جنوب 3', jobTitle: 'فني إسعاف', schedule: [{ date: today, shiftCode: 'V' }] },
            // مجاز V — بطل الدعم الخارجي (رجوع)
            { employeeNumber: '812', name: 'داعم خارجي', team: 'جنوب 3', jobTitle: 'أخصائي إسعاف', schedule: [{ date: today, shiftCode: 'V' }] },
            // مجاز V — بطل التطوع (رجوع)
            { employeeNumber: '813', name: 'داعم تطوع', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'V' }] }
        ]);

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

        const start = await api('POST', '/api/start-new-shift', { shiftType: 'صباحية' });
        const shiftId = start.data && start.data.shiftId;
        if (!shiftId) throw new Error('تعذر بدء المناوبة: ' + JSON.stringify(start.data));

        const getState = () => api('GET', `/api/staffing/state?shift_id=${shiftId}`);
        const getTimeline = (ent) => api('GET', `/api/staffing/timeline?shift_id=${shiftId}${ent ? '&entity_id=' + encodeURIComponent(ent) : ''}`);
        const postEvents = (events) => api('POST', '/api/shift-completion', {
            shiftType: 'صباحية', shiftDate: today, events
        });

        // ═══ ② حفظ فعلي: overlap لفريق نشط غير مجدول (جنوب 15) ⇒ 200 + appended=1 ═══
        const overlapEv = {
            type: 'overlap', employeeName: 'داعم أوفرلاب', teamId: 'جنوب 15',
            coverageType: 'overlap', jobTitle: 'فني إسعاف', employeeNumber: '811'
        };
        const r1 = await postEvents([overlapEv]);
        const tl1 = await getTimeline('داعم أوفرلاب');
        const oEv = (tl1.data.events || []).find(e => e.event_type === 'overlap');
        const t2 = r1.status === 200 && r1.data && r1.data.success && r1.data.appended === 1 &&
            oEv && oEv.team_id === 'جنوب 15' && oEv.shift_id === shiftId;
        record('② overlap لفريق غير مجدول (جنوب 15) ⇒ 200 · يُحفظ فعليًا في سجل الأحداث',
            t2, `status=${r1.status} appended=${r1.data && r1.data.appended} حدث=${!!oEv} فريق=${oEv && oEv.team_id}`);

        // ═══ ③ الاشتقاق: يظهر على بطاقة جنوب 15 بحالة overlap · سجل تغطية overlap ═══
        const st1 = await getState();
        const team15 = (st1.data.teams || {})['جنوب 15'];
        const mOvl = team15 && (team15.members || []).find(m => m.name === 'داعم أوفرلاب');
        const cov = (tl1.data.coverageRecords || []).find(c => c.employee === 'داعم أوفرلاب');
        const t3 = team15 && mOvl && mOvl.role === 'support' && mOvl.state === 'overlap' &&
            mOvl.supportType === 'overlap' &&
            cov && cov.coverageType === 'overlap';
        record('③ الاشتقاق: بطاقة جنوب 15 تُظهر الداعم بدور support وحالة overlap · سجل التغطية overlap',
            t3, `بطاقة=${!!team15} عضو=${!!mOvl} حالة=${mOvl && mOvl.state} تغطية=${cov && cov.coverageType}`);

        // ═══ ④ منع التكرار: نفس overlap لنفس الفريق ⇒ appended=0 ═══
        const r2 = await postEvents([overlapEv]);
        const tl2 = await getTimeline('داعم أوفرلاب');
        const ovlCount = (tl2.data.events || []).filter(e => e.event_type === 'overlap').length;
        const t4 = r2.status === 200 && r2.data && r2.data.appended === 0 && ovlCount === 1;
        record('④ منع التكرار: overlap مكرر مفتوح لنفس الفريق يُتخطى (appended=0 · حدث واحد فقط)',
            t4, `appended=${r2.data && r2.data.appended} أحداث=${ovlCount}`);

        // ═══ ⑥ا عدم كسر الأنواع القائمة: volunteer_support وexternal_support
        // على فريق مجدول (جنوب 3) — نفس سلوك ما قبل التعديل حرفيًا ═══
        const rV = await postEvents([{
            type: 'volunteer_support', employeeName: 'داعم تطوع', teamId: 'جنوب 3',
            coverageType: 'volunteer', jobTitle: 'مسعف', employeeNumber: '813'
        }]);
        const rE = await postEvents([{
            type: 'external_support', employeeName: 'داعم خارجي', teamId: 'جنوب 3',
            coverageType: 'external', jobTitle: 'أخصائي إسعاف', employeeNumber: '812'
        }]);
        const st2 = await getState();
        const team3 = (st2.data.teams || {})['جنوب 3'];
        const mVol = team3 && (team3.members || []).find(m => m.name === 'داعم تطوع');
        const mExt = team3 && (team3.members || []).find(m => m.name === 'داعم خارجي');
        const t6 = rV.status === 200 && rV.data && rV.data.appended === 1 &&
            rE.status === 200 && rE.data && rE.data.appended === 1 &&
            mVol && mVol.state === 'external_support' && mVol.supportType === 'volunteer_support' &&
            mExt && mExt.state === 'external_support' && mExt.supportType === 'external_support';
        record('⑥ الأنواع القائمة سليمة: volunteer_support وexternal_support يُقبلان ويُشتقان كما كانا',
            t6, `تطوع=${rV.data && rV.data.appended} خارجي=${rE.data && rE.data.appended} حالة_تطوع=${mVol && mVol.state} حالة_خارجي=${mExt && mExt.state}`);

        // ═══ ⑤ الإغلاق: support_end يُقبل مع overlap مفتوح ويُخرج الداعم من البطاقة ═══
        const rEnd = await postEvents([{ type: 'support_end', employeeName: 'داعم أوفرلاب' }]);
        const st3 = await getState();
        const team15b = (st3.data.teams || {})['جنوب 15'];
        const stillThere = team15b && (team15b.members || []).some(m => m.name === 'داعم أوفرلاب');
        const t5 = rEnd.status === 200 && rEnd.data && rEnd.data.appended === 1 && !stillThere;
        record('⑤ الإغلاق: support_end يُغلق الأوفرلاب المفتوح ويُزيل الداعم من بطاقة الفريق',
            t5, `status=${rEnd.status} appended=${rEnd.data && rEnd.data.appended} باقٍ=${!!stillThere}`);

        // ── 3) إيقاف الخادم ثم قراءة القاعدة مباشرة (بصمة shift_roster) ──
        server.kill('SIGTERM');
        await sleep(1200);
        const db2 = require(path.join(ROOT, 'db.js'));
        await db2.init(false);
        const rosterHashAfter = hashOf(JSON.stringify(await db2.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id')));
        await db2.closeDb();
        record('⑦ حارس الجدول الرسمي: بصمة shift_roster ثابتة (لا كتابة عليه إطلاقًا)',
            rosterHashBefore === rosterHashAfter,
            rosterHashBefore === rosterHashAfter ? 'ثابتة' : 'تغيّرت!');

    } finally {
        if (server) { try { server.kill('SIGKILL'); } catch (_) { } }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    console.log(`نجح: ${results.length - failed.length} | ❌ فشل: ${failed.length}`);
    if (failed.length) {
        console.log('❌ الفاشل: ' + failed.map(f => f.name).join(' | '));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات نوع الدعم «أوفرلاب» ناجحة');
}

main().catch(e => { console.error('❌ خطأ جسيم:', e); process.exit(1); });
