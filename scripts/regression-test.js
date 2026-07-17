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

    // ─── 6. Completion: save + update + read ───
    const comp1 = await api('POST', '/api/shift-completion', {
        shiftType: 'ليل', shiftDate: '2026-07-17', shift_id: shiftId,
        teams: { 'جنوب 3': { status: 'ready', centerName: 'منفوحة' } }, notes: 'regression', timestamp: new Date().toISOString()
    });
    record('حفظ التكميل', comp1.ok && comp1.data.success, JSON.stringify(comp1.data));

    const compLatest = await api('GET', '/api/completion/latest?shiftDate=2026-07-17&shiftType=' + encodeURIComponent('ليل'));
    record('قراءة التكميل المحفوظ', compLatest.ok && compLatest.data.success && compLatest.data.completion && !!compLatest.data.completion.teams['جنوب 3']);

    const comp2 = await api('POST', '/api/shift-completion', {
        shiftType: 'ليل', shiftDate: '2026-07-17', shift_id: shiftId,
        teams: { 'جنوب 3': { status: 'missing', centerName: 'منفوحة' } }, notes: 'regression-2', timestamp: new Date().toISOString()
    });
    const compLatest2 = await api('GET', '/api/completion/latest?shiftDate=2026-07-17&shiftType=' + encodeURIComponent('ليل'));
    const updated = compLatest2.data && compLatest2.data.completion && compLatest2.data.completion.teams['جنوب 3'] && compLatest2.data.completion.teams['جنوب 3'].status === 'missing';
    record('تعديل التكميل ينعكس', comp2.ok && !!updated);

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
    const evPost = await api('POST', `/api/shift-events/${shift2Id}`, { type: 'اختبار', description: 'حدث regression' });
    const evGet = await api('GET', `/api/shift-events/${shift2Id}`);
    const evList = evGet.data && evGet.data.events || [];
    record('سجل الأحداث عبر SQLite (كتابة/قراءة)', evPost.ok && evList.some(e => e.description === 'حدث regression'), `events=${evList.length}`);
    const abPost = await api('POST', `/api/shift-absences/${shift2Id}`, { absences: [{ name: 'غياب اختبار', center: 'منفوحة' }] });
    const abGet = await api('GET', `/api/shift-absences/${shift2Id}`);
    const abList = abGet.data && abGet.data.absences || [];
    record('سجل الغيابات عبر SQLite (كتابة/قراءة)', abPost.ok && abList.some(a => a.name === 'غياب اختبار'), `absences=${abList.length}`);
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

    // ─── 13. WebSocket live sync (shift_started + new_report) ───
    let wsStarted = false, wsReport = false, wsPlanAdded = false, wsPlanDeleted = false, wsPlanId = null;
    try {
        const WebSocket = require('ws');
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://localhost:3080/ws?token=${TOKEN}`);
            const timer = setTimeout(() => { try { ws.terminate(); } catch (_) {} resolve(); }, 10000);
            ws.on('open', async () => {
                await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
                await api('POST', '/api/report', { center: 'منفوحة', unit: 'جنوب 3' });
                const wp = await api('POST', '/api/peak-plans', { title: 'خطة WS regression', location: 'موقع WS' });
                const pid = wp.data && wp.data.plan && wp.data.plan.id;
                if (pid) await api('DELETE', `/api/peak-plans/${pid}`);
            });
            ws.on('message', (raw) => {
                try {
                    const m = JSON.parse(raw.toString());
                    if (m.type === 'shift_started') wsStarted = true;
                    if (m.type === 'new_report' && m.center === 'منفوحة') wsReport = true;
                    if (m.type === 'peak_plan_added' && m.plan && m.plan.title === 'خطة WS regression') { wsPlanAdded = true; wsPlanId = m.plan.id; }
                    if (m.type === 'peak_plan_deleted' && m.planId === wsPlanId) wsPlanDeleted = true;
                    if (wsStarted && wsReport && wsPlanAdded && wsPlanDeleted) { clearTimeout(timer); ws.terminate(); resolve(); }
                } catch (_) {}
            });
            ws.on('error', () => { clearTimeout(timer); resolve(); });
        });
    } catch (e) {}
    record('التحديث اللحظي عبر WebSocket (new_report)', wsReport);
    record('بث بدء المناوبة لحظياً (shift_started عبر ShiftStarted)', wsStarted);
    record('بث إنشاء التمركز لحظياً (PositioningStarted ← peak_plan_added)', wsPlanAdded);
    record('بث إنهاء التمركز لحظياً (PositioningEnded ← peak_plan_deleted)', wsPlanDeleted);

    // ─── 13b. Archive slice: auto-archive + direct archive produce seals (bug fix verification) ───
    const autoSnap = await api('GET', `/api/shift-snapshot/${shift2Id}`);
    record('الأرشفة التلقائية تُنتج لقطة ختم (إصلاح الخلل)', autoSnap.ok && autoSnap.data && autoSnap.data.success && !!autoSnap.data.snapshot, `status=${autoSnap.status}`);
    const mk2 = await api('POST', '/api/update-shift-data', { shiftDate: '2099-01-02', shiftType: 'ليلية', shiftData: { generalNotes: 'disposable direct-archive regression' } });
    const mk2Id = mk2.data && mk2.data.shiftId;
    const dArch = mk2Id ? await api('POST', `/api/shift/${mk2Id}/archive`, { reason: 'regression direct' }) : { ok: false };
    const dSnap = mk2Id ? await api('GET', `/api/shift-snapshot/${mk2Id}`) : { ok: false };
    record('الأرشفة المباشرة تُنتج لقطة ختم (إصلاح الخلل)', !!(mk2Id && dArch.ok && dSnap.ok && dSnap.data && dSnap.data.success), `mk=${mk2Id} arch=${dArch.status} snap=${dSnap.status}`);
    if (mk2Id) await api('DELETE', `/api/shifts/${mk2Id}`);

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
