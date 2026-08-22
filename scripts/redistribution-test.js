/**
 * اختبارات T3 — إعادة التوزيع (Redistribution) من شاشة التكميل
 * ═══════════════════════════════════════════════════════════════════════════════
 * نمط العزل نفسه في overlap-activation-test.js + بوابة HTTP حقيقية:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (تُضبط قبل require db.js).
 *   - الكادر يُزرع عبر الكاتب الرسمي RosterSyncService لتاريخ الرياض «اليوم».
 *   - الخادم الحقيقي يُشغَّل كعملية ابن على منفذ اختبار (3129).
 *
 * ما يثبته هذا الملف (البنود المعتمدة):
 *   (أ) assignment لعضو مجدول نشط ← يُقبل (appended=1).
 *   (ب) الاشتقاق بعد التكليف: العضو «مكلَّف خارج فرقته» في المصدر (لا يُحسب)،
 *       ويظهر في المستهدف كـ role=support/state=assignment (يُحسب)،
 *       وtotalStaff ثابت (إعادة توزيع داخلية — الإجمالي لا يتغير).
 *   (ج) idempotency: assignment مكرر لنفس الفريق يُتخطى (appended=0).
 *   (د) «إنهاء التكليف»: support_end يُقبل رغم غياب دعم مفتوح (الحارس المحدّث)،
 *       وقاعدة الإغلاق الدائمة (closureRules + طيّ الدفعة) تُغلق التكليف فعليًا:
 *       العضو يعود نشطًا في فرقته الأصلية ويختفي من المستهدفة.
 *   (هـ) دعم خارجي (external_support) لغير المجدولين ← totalStaff يزيد +1 (N+1).
 *   (و) حارس الإغلاق الفارغ محفوظ: support_end بلا أي دعم/تكليف مفتوح ← appended=0.
 *
 * التشغيل: node scripts/redistribution-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
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
    console.log('\n═══ اختبارات T3 — إعادة التوزيع (assignment / support_end يُغلق التكليف / N+1) ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'redistribution-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const TimeRiyadh = require(path.join(ROOT, 'public/js/time-riyadh.js'));
    const today = TimeRiyadh.formatDate(new Date()); // تاريخ الرياض الجداري — نفس ختم الخادم

    let server = null;

    try {
        // ── 1) قاعدة معزولة + بذر الكادر عبر الكاتب الرسمي ──
        const db = require(path.join(ROOT, 'db.js'));
        await db.init(false); // مخطط كامل + ترحيلات + بذر (فرق جنوب موجودة ونشطة)
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        await sync.syncFromSchedule([
            // فريقان نهاريان بكادر مكتمل (شخصان لكل فريق)
            { employeeNumber: '601', name: 'موزع أول', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '602', name: 'ثابت جنوب 3', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '603', name: 'هدف أول', team: 'جنوب 4', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] },
            { employeeNumber: '604', name: 'هدف ثانٍ', team: 'جنوب 4', jobTitle: 'مسعف', schedule: [{ date: today, shiftCode: 'D12' }] }
        ]);

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

        const postEvents = (events) => api('POST', '/api/shift-completion', { shiftType: 'صباحية', shiftDate: today, events });
        const getState = () => api('GET', '/api/staffing/state?shift_id=' + shiftId);
        const memberOf = (st, team, name) =>
            st.data.teams && st.data.teams[team] &&
            (st.data.teams[team].members || []).find(m => m.name === name);
        const teamOf = (st, team) => st.data.teams && st.data.teams[team];
        const totalStaffOf = (st) => st.data.workforce && st.data.workforce.totalStaff;

        // ── الحالة الابتدائية: فريقان مكتملان (2+2) ──
        const st0 = await getState();
        const base0 = totalStaffOf(st0);
        const t0 = st0.status === 200 && teamOf(st0, 'جنوب 3') && teamOf(st0, 'جنوب 4') &&
            teamOf(st0, 'جنوب 3').activeCount === 2 && teamOf(st0, 'جنوب 4').activeCount === 2 &&
            typeof base0 === 'number';
        record('⓪ الحالة الابتدائية: جنوب 3 وجنوب 4 بكادر مكتمل (2/2) ومجاميع القوى موجودة',
            t0, `جنوب3=${teamOf(st0, 'جنوب 3') && teamOf(st0, 'جنوب 3').activeCount} جنوب4=${teamOf(st0, 'جنوب 4') && teamOf(st0, 'جنوب 4').activeCount} قوة=${base0}`);

        // ── (أ) assignment لعضو مجدول نشط ← يُقبل ──
        const asg = await postEvents([{ type: 'assignment', employeeName: 'موزع أول', teamId: 'جنوب 4', coverageType: 'assignment' }]);
        const tA = asg.status === 200 && asg.data && asg.data.success && asg.data.appended === 1;
        record('(أ) تكليف عضو مجدول نشط إلى فرقة أخرى يُقبل (appended=1)',
            tA, `status=${asg.status} appended=${asg.data && asg.data.appended}`);

        // ── (ب) الاشتقاق: مكلَّف خارج فرقته في المصدر + محسوب في المستهدف + الإجمالي ثابت ──
        const st1 = await getState();
        const src1 = teamOf(st1, 'جنوب 3');
        const dst1 = teamOf(st1, 'جنوب 4');
        const mSrc = src1 && memberOf(st1, 'جنوب 3', 'موزع أول');
        const mDst = dst1 && memberOf(st1, 'جنوب 4', 'موزع أول');
        const tB = mSrc && mSrc.role === 'base' && mSrc.state === 'assignment' &&
            src1.activeCount === 1 &&
            mDst && mDst.role === 'support' && mDst.state === 'assignment' && mDst.supportType === 'assignment' &&
            dst1.activeCount === 3 &&
            totalStaffOf(st1) === base0;
        record('(ب) الاشتقاق: المصدر يفقده (1/2، state=assignment) · المستهدف يحسبه (3/2، support/assignment) · totalStaff ثابت',
            tB, `مصدر=${mSrc && mSrc.state}(${src1 && src1.activeCount}) مستهدف=${mDst && mDst.role}/${mDst && mDst.state}(${dst1 && dst1.activeCount}) قوة=${totalStaffOf(st1)} مقابل ${base0}`);

        // ── (ج) idempotency: تكليف مكرر لنفس الفريق يُتخطى ──
        const asgDup = await postEvents([{ type: 'assignment', employeeName: 'موزع أول', teamId: 'جنوب 4', coverageType: 'assignment' }]);
        const tC = asgDup.status === 200 && asgDup.data && asgDup.data.appended === 0;
        record('(ج) تكليف مكرر مفتوح لنفس الفريق يُتخطى (appended=0 — idempotent)',
            tC, `appended=${asgDup.data && asgDup.data.appended}`);

        // ── (د) «إنهاء التكليف»: support_end يُقبل بوجود تكليف فقط + الإغلاق فعلي في الطيّ الدائم ──
        const end = await postEvents([{ type: 'support_end', employeeName: 'موزع أول' }]);
        const st2 = await getState();
        const src2 = teamOf(st2, 'جنوب 3');
        const dst2 = teamOf(st2, 'جنوب 4');
        const mBack = src2 && memberOf(st2, 'جنوب 3', 'موزع أول');
        const gone = dst2 && !memberOf(st2, 'جنوب 4', 'موزع أول');
        const tD = end.status === 200 && end.data && end.data.appended === 1 &&
            mBack && mBack.role === 'base' && mBack.state === 'active' &&
            src2.activeCount === 2 && dst2.activeCount === 2 && gone &&
            totalStaffOf(st2) === base0;
        record('(د) «إنهاء التكليف»: support_end يُقبل (appended=1) ويُغلق التكليف فعليًا — العضو يعود نشطًا لفرقته والإجمالي ثابت',
            tD, `appended=${end.data && end.data.appended} عودة=${mBack && mBack.state} مصدر=${src2 && src2.activeCount} مستهدف=${dst2 && dst2.activeCount} اختفى=${gone}`);

        // ── (هـ) دعم خارجي لغير المجدولين ← N+1 في totalStaff ──
        const ext = await postEvents([{ type: 'external_support', employeeName: 'داعم خارجي س', teamId: 'جنوب 4', coverageType: 'external', center: 'الاحتياط' }]);
        const st3 = await getState();
        const dst3 = teamOf(st3, 'جنوب 4');
        const mExt = dst3 && memberOf(st3, 'جنوب 4', 'داعم خارجي س');
        const tE = ext.status === 200 && ext.data && ext.data.appended === 1 &&
            mExt && mExt.role === 'support' && mExt.state === 'external_support' &&
            dst3.activeCount === 3 &&
            totalStaffOf(st3) === base0 + 1;
        record('(هـ) دعم خارجي لغير المجدولين يُقبل ويُحسب — totalStaff يزيد +1 (N+1)',
            tE, `appended=${ext.data && ext.data.appended} عضو=${mExt && mExt.state} مستهدف=${dst3 && dst3.activeCount} قوة=${totalStaffOf(st3)} مقابل ${base0}+1`);

        // ── (و) حارس الإغلاق الفارغ محفوظ: support_end بلا دعم/تكليف مفتوح ← يُتخطى ──
        const emptyEnd = await postEvents([{ type: 'support_end', employeeName: 'ثابت جنوب 3' }]);
        const tF = emptyEnd.status === 200 && emptyEnd.data && emptyEnd.data.appended === 0;
        record('(و) support_end بلا أي دعم/تكليف مفتوح يُتخطى (appended=0 — الحارس لم يُضعف)',
            tF, `appended=${emptyEnd.data && emptyEnd.data.appended}`);

        // ── (ز) إنهاء الدعم الخارجي يعيد الإجمالي (تنظيف + إثبات رجوع N+1) ──
        const endExt = await postEvents([{ type: 'support_end', employeeName: 'داعم خارجي س' }]);
        const st4 = await getState();
        const tG = endExt.status === 200 && endExt.data && endExt.data.appended === 1 &&
            totalStaffOf(st4) === base0;
        record('(ز) إنهاء الدعم الخارجي يعيد totalStaff إلى خط الأساس',
            tG, `appended=${endExt.data && endExt.data.appended} قوة=${totalStaffOf(st4)} مقابل ${base0}`);

        // ── (ح) فحوص الواجهة الساكنة: السحب/الإفلات + نافذة التأكيد + وضع النقل + منطقة الإسقاط ──
        const html = fs.readFileSync(path.join(ROOT, 'public', 'radio-completion.html'), 'utf8');
        const tH =
            html.includes('id="redistModal"') &&
            html.includes('function openRedistModal(') &&
            html.includes('function confirmRedistribution(') &&
            html.includes('data-mdrag') &&
            html.includes('tc-dropzone') &&
            html.includes('id="moveBanner"') &&
            html.includes('function startMoveMode(') &&
            /type: 'assignment', employeeName: ctx\.name/.test(html) &&
            /type: 'external_support', employeeName: ctx\.name/.test(html) &&
            /support_end.*\}\]\)\.then\(function\(d\)/.test(html); // التسلسل: إنهاء الحالي ثم الجديد
        record('(ح) الواجهة ساكنًا: سحب .pm[data-mdrag] + #redistModal + وضع النقل + منطقة الإسقاط + التسلسل التأكيدي',
            tH, '');

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
