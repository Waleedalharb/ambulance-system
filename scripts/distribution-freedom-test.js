/**
 * اختبارات المراجعة النهائية §14 — حرية التوزيع واحتساب القوى
 * ═══════════════════════════════════════════════════════════════════════════════
 * نفس نمط العزل في redistribution-test.js (قاعدة %TEMP% + RosterSyncService +
 * خادم ابن حقيقي على منفذ 3131). تكمل — لا تستبدل — حزمة إعادة التوزيع (9/9).
 *
 * ما يثبته هذا الملف (بنود المراجعة النهائية):
 *   (أ) §1: موظف غير مجدول — external_support بحمولة jobTitle/employeeNumber
 *       (نفس عقد التغطية التشغيلية) يُقبل ويظهر في القوة العاملة الفعلية (+1).
 *   (ج) §2: عضو تدخل سريع (سريع 1) → فرقة أساسية ناقصة (جنوب 4) يُقبل —
 *       الأولوية التشغيلية للفرقة الأساسية، والنظام لا يمنع بسبب التصنيف.
 *   (د) §2: موظف غير أوفرلاب (كود غير تشغيلي D12) قابل للتوزيع كأي مورد.
 *   (هـ) §5: فرقة غير مجدولة اليوم (بلا كادر في shift_roster) تُفعَّل بحدث
 *       activation القائم ← تظهر في الحالة بعضو role=activation والقوة +1.
 *   (و) §3: scheduledStaff ثابت عبر كل الحركات (المجدول لا يتغير بالتوزيع)،
 *       بينما totalStaff يعكس الإضافات خارج الجدول فقط.
 *   (ز) فحوص واجهة ساكنة لبنود §3/§5/§7/§9/§10 (شرائح القوة، شريط الفرق غير
 *       المجدولة، ملء شاشة المركبات، بحث الخروج، مؤشر الحفظ التلقائي).
 *
 * التشغيل: node scripts/distribution-freedom-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3131;
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
    console.log('\n═══ اختبارات §14 — حرية التوزيع + احتساب القوى + التفعيل ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-freedom-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const TimeRiyadh = require(path.join(ROOT, 'public/js/time-riyadh.js'));
    const today = TimeRiyadh.formatDate(new Date());

    let server = null;

    try {
        // ── 1) قاعدة معزولة + بذر الكادر عبر الكاتب الرسمي ──
        const db = require(path.join(ROOT, 'db.js'));
        await db.init(false);
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        await sync.syncFromSchedule([
            // فرقة أساسية ناقصة (عضو واحد من اثنين) + فرقة مكتملة + تدخل سريع
            { employeeNumber: '701', name: 'ناقص جنوب 4', team: 'جنوب 4', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '702', name: 'مكتمل أول', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '703', name: 'مكتمل ثانٍ', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '704', name: 'سريعي أول', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '705', name: 'سريعي ثانٍ', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            // أوفرلاب بكود تشغيلي ملحق (صيغة البداية الصريحة) — في الكادر المخزّن
            // لكنه مستبعد من طواقم الفرق بالاشتقاق (لا يُحسب حتى يُفعَّل)
            { employeeNumber: '706', name: 'أوفرلابي حر', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'O12-09' }] },
            // موظف موجود في employees بكود إجازة (V — ليس عملًا فعليًا) ليمر
            // عبر قناة «تطوع بلا فريق ← تفعيل» القائمة حرفيًا
            { employeeNumber: '9001', name: 'متطوع حر', team: 'جنوب 3', jobTitle: 'مسعف إسعاف', schedule: [{ date: today, shiftCode: 'V' }] }
        ]);

        await db.closeDb();
        await sleep(500);

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

        const postEvents = (events) => api('POST', '/api/shift-completion', { shiftType: 'صباحية', shiftDate: today, events });
        const getState = () => api('GET', '/api/staffing/state?shift_id=' + shiftId);
        const teamOf = (st, team) => st.data.teams && st.data.teams[team];
        const memberOf = (st, team, name) =>
            teamOf(st, team) && (teamOf(st, team).members || []).find(m => m.name === name);
        const wfOf = (st) => st.data.workforce || {};

        // ── ⓪ الحالة الابتدائية: 5 مجدولين (جنوب 4 ناقصة 1/2) ──
        const st0 = await getState();
        const wf0 = wfOf(st0);
        const t0 = st0.status === 200 && teamOf(st0, 'جنوب 4') && teamOf(st0, 'جنوب 4').activeCount === 1 &&
            teamOf(st0, 'سريع 1') && teamOf(st0, 'سريع 1').activeCount === 2 &&
            wf0.totalStaff === 5 && wf0.scheduledStaff === 5;
        record('⓪ الحالة الابتدائية: 5 مجدولين (جنوب 4 ناقصة 1/2 · سريع 1 مكتملة) — scheduled=total=5',
            t0, `جنوب4=${teamOf(st0, 'جنوب 4') && teamOf(st0, 'جنوب 4').activeCount} سريع1=${teamOf(st0, 'سريع 1') && teamOf(st0, 'سريع 1').activeCount} total=${wf0.totalStaff} sched=${wf0.scheduledStaff}`);

        // ── (أ) §1: غير المجدول بحمولة كاملة (jobTitle/employeeNumber) → +1 ──
        const ext = await postEvents([{
            type: 'external_support', employeeName: 'سلمان غير المجدول', teamId: 'جنوب 4',
            coverageType: 'external', jobTitle: 'أخصائي إسعاف', employeeNumber: '4252'
        }]);
        const stA = await getState();
        const mExt = memberOf(stA, 'جنوب 4', 'سلمان غير المجدول');
        const tA = ext.status === 200 && ext.data && ext.data.appended === 1 &&
            mExt && mExt.role === 'support' &&
            wfOf(stA).totalStaff === 5 + 1 && wfOf(stA).scheduledStaff === 5 &&
            teamOf(stA, 'جنوب 4').activeCount === 2;
        record('(أ) §1 غير المجدول يُوزَّع بحمولة المسمى/الرقم ← يظهر في القوة العاملة (+1) والمجدول ثابت',
            tA, `appended=${ext.data && ext.data.appended} دور=${mExt && mExt.role} total=${wfOf(stA).totalStaff} sched=${wfOf(stA).scheduledStaff} جنوب4=${teamOf(stA, 'جنوب 4').activeCount}`);

        // ── (ج) §2: من التدخل السريع إلى فرقة أساسية ناقصة — يُقبل والإجمالي ثابت ──
        const mv = await postEvents([{ type: 'assignment', employeeName: 'سريعي أول', teamId: 'جنوب 4', coverageType: 'assignment' }]);
        const stC = await getState();
        const mSrcC = memberOf(stC, 'سريع 1', 'سريعي أول');
        const mDstC = memberOf(stC, 'جنوب 4', 'سريعي أول');
        const tC = mv.status === 200 && mv.data && mv.data.appended === 1 &&
            mSrcC && mSrcC.state === 'assignment' && teamOf(stC, 'سريع 1').activeCount === 1 &&
            mDstC && mDstC.role === 'support' && teamOf(stC, 'جنوب 4').activeCount === 3 &&
            wfOf(stC).totalStaff === 6; // 5 + سلمان (إعادة التوزيع لا تضيف)
        record('(ج) §2 سحب من «سريع 1» إلى «جنوب 4» الناقصة يُقبل — إعادة توزيع بلا زيادة في الإجمالي',
            tC, `appended=${mv.data && mv.data.appended} سريع1=${teamOf(stC, 'سريع 1').activeCount} جنوب4=${teamOf(stC, 'جنوب 4').activeCount} total=${wfOf(stC).totalStaff}`);

        // ── (د) §2: غير الأوفرلاب (كود D12 غير تشغيلي) قابل للتوزيع ──
        const mv2 = await postEvents([{ type: 'assignment', employeeName: 'مكتمل أول', teamId: 'سريع 1', coverageType: 'assignment' }]);
        const stD = await getState();
        const mD = memberOf(stD, 'سريع 1', 'مكتمل أول');
        const tD = mv2.status === 200 && mv2.data && mv2.data.appended === 1 &&
            mD && mD.role === 'support' && wfOf(stD).totalStaff === 6;
        record('(د) §2 موظف غير أوفرلاب (D12) يُوزَّع بلا بوابة تصنيف — والإجمالي ثابت',
            tD, `appended=${mv2.data && mv2.data.appended} دور=${mD && mD.role} total=${wfOf(stD).totalStaff}`);

        // ── (هـ) §5: فرقة غير مجدولة اليوم — تفعيل + توزيع عبر activation القائم ──
        // الفرقة الهدف: نشطة في /api/teams وبلا كادر في مناوبة اليوم (ليست جنوب 3/4 ولا سريع 1)
        const teamsRes = await api('GET', '/api/teams');
        const nrTeam = ((teamsRes.data && teamsRes.data.teams) || []).find(function(t) {
            return Number(t.is_active) === 1 && ['جنوب 3', 'جنوب 4', 'سريع 1'].indexOf(t.name) === -1;
        });
        // (هـ1) أوفرلاب بكود تشغيلي: التفعيل المباشر على الفرقة غير المجدولة — العقد القائم حرفيًا
        const act = nrTeam ? await api('POST', '/api/staffing/activation', { employeeName: 'أوفرلابي حر', teamName: nrTeam.name }) : { status: 0, data: null };
        const stE = await getState();
        const mAct = nrTeam ? memberOf(stE, nrTeam.name, 'أوفرلابي حر') : null;
        const tE1 = !!nrTeam && act.status === 200 && act.data && act.data.success && act.data.appended === 1 &&
            mAct && mAct.role === 'activation' &&
            wfOf(stE).totalStaff === 6 + 1 && wfOf(stE).scheduledStaff === 5;
        record('(هـ1) §5 فرقة غير مجدولة (' + (nrTeam ? nrTeam.name : '—') + ') تُفعَّل بحدث activation القائم ← تظهر في الحالة والقوة +1',
            tE1, `status=${act.status} appended=${act.data && act.data.appended} دور=${mAct && mAct.role} total=${wfOf(stE).totalStaff} sched=${wfOf(stE).scheduledStaff}`);

        // (هـ2) غير المجدول على فرقة غير مجدولة: القناة القائمة ذاتها — تطوع بلا فريق ثم تفعيل
        const vol = nrTeam ? await api('POST', '/api/staffing/volunteer', { employeeName: 'متطوع حر', employeeCode: '9001' }) : { status: 0, data: null };
        const act2 = nrTeam ? await api('POST', '/api/staffing/activation', { employeeName: 'متطوع حر', teamName: nrTeam.name }) : { status: 0, data: null };
        const stE2 = await getState();
        const mAct2 = nrTeam ? memberOf(stE2, nrTeam.name, 'متطوع حر') : null;
        const tE2 = !!nrTeam && vol.status === 200 && vol.data && vol.data.success &&
            act2.status === 200 && act2.data && act2.data.success && act2.data.appended === 1 &&
            mAct2 && mAct2.role === 'activation' &&
            wfOf(stE2).totalStaff === 7 + 1 && wfOf(stE2).scheduledStaff === 5;
        record('(هـ2) §5 غير المجدول على فرقة غير مجدولة: تطوع ← تفعيل (القناة القائمة) ← قوة +1 أخرى',
            tE2, `vol=${vol.status} act=${act2.status} دور=${mAct2 && mAct2.role} total=${wfOf(stE2).totalStaff} sched=${wfOf(stE2).scheduledStaff}`);

        // ── (و) §3: الانفصال المحاسبي — scheduledStaff لم يتحرك عبر كل الحركات ──
        const wfEnd = wfOf(stE2);
        const tF = wfEnd.scheduledStaff === 5 && wfEnd.totalStaff === 8 &&
            wfEnd.totalStaff - wfEnd.scheduledStaff === 3; // سلمان + أوفرلابي + متطوع
        record('(و) §3 الانفصال المحاسبي: المجدول=5 ثابت · العامل=8 · خارج الجدول=+3 بالضبط',
            tF, `sched=${wfEnd.scheduledStaff} total=${wfEnd.totalStaff} diff=${wfEnd.totalStaff - wfEnd.scheduledStaff}`);

        // ── (ز) فحوص الواجهة الساكنة لبنود المراجعة ──
        const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        const tG =
            // §3 شرائح القوة
            html.includes('id="dashScheduled"') && html.includes('id="dashWorking"') && html.includes('id="dashOutOfPlan"') &&
            // §1/§2 توزيع بلا بوابات + حمولة غير المجدول
            html.includes('🔀 توزيع الموظف') && html.includes('mainEv.jobTitle') && html.includes('mainEv.employeeNumber') &&
            !html.includes('لا يمكن نقله') && !html.includes('غير مجدول → لا يمكن') &&
            // §5 شريط الفرق غير المجدولة + مسار التفعيل
            html.includes('id="nonRosterSection"') && html.includes('renderNonRosterTargets') &&
            html.includes("postActivation('/api/staffing/activation', { employeeName: ctx.name, teamName: ctx.toTeamId })") &&
            // §6 حقول النافذة + الأثر
            html.includes('المركز') && html.includes('إعادة توزيع — لا زيادة في إجمالي القوة') && html.includes('إضافة خارج الجدول') &&
            // §7 ملء الشاشة
            html.includes('veh-fullscreen') && html.includes('عمليات المركبات') && html.includes('العودة إلى التكميل') &&
            // §9 بحث الخروج
            html.includes('id="signoutSearch"') && html.includes('pickSignoutEmployee') &&
            // §10 الحفظ التلقائي + المؤشر
            html.includes('saveNotesDebounced') && html.includes('id="notesSaved"');
        record('(ز) الواجهة ساكنًا: شرائح §3 + توزيع بلا بوابات §1/§2 + تفعيل §5 + نافذة §6 + ملء الشاشة §7 + بحث الخروج §9 + الحفظ التلقائي §10',
            tG, '');
    } catch (err) {
        record('خطأ غير متوقع أثناء الاختبارات', false, err.message);
    } finally {
        if (server) {
            try { server.kill(); } catch (_) {}
            await sleep(400);
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n═══ الحصيلة: ${passed}/${results.length} ✅` + (failed ? ` — ${failed} ❌` : '') + ' ═══\n');
    process.exit(failed ? 1 : 0);
}

main();
