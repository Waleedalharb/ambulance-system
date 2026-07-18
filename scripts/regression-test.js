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

    // ─── 13. WebSocket live sync (shift_started + new_report) ───
    let wsStarted = false, wsReport = false, wsPlanAdded = false, wsPlanDeleted = false, wsPlanId = null, wsNoteAdded = false;
    try {
        const WebSocket = require('ws');
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://localhost:3080/ws?token=${TOKEN}`);
            const timer = setTimeout(() => { try { ws.terminate(); } catch (_) {} resolve(); }, 10000);
            ws.on('open', async () => {
                const st = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
                const wsShift = st.data && st.data.shiftId;
                await api('POST', '/api/report', { center: 'منفوحة', unit: 'جنوب 3' });
                const wp = await api('POST', '/api/peak-plans', { title: 'خطة WS regression', location: 'موقع WS' });
                const pid = wp.data && wp.data.plan && wp.data.plan.id;
                if (pid) await api('DELETE', `/api/peak-plans/${pid}`);
                if (wsShift) await api('POST', `/api/shift-notes/${wsShift}`, { notes: [{ text: 'ملاحظة WS regression' }] });
            });
            ws.on('message', (raw) => {
                try {
                    const m = JSON.parse(raw.toString());
                    if (m.type === 'shift_started') wsStarted = true;
                    if (m.type === 'new_report' && m.center === 'منفوحة') wsReport = true;
                    if (m.type === 'peak_plan_added' && m.plan && m.plan.title === 'خطة WS regression') { wsPlanAdded = true; wsPlanId = m.plan.id; }
                    if (m.type === 'peak_plan_deleted' && m.planId === wsPlanId) wsPlanDeleted = true;
                    if (m.type === 'shift_note_added') wsNoteAdded = true;
                    if (wsStarted && wsReport && wsPlanAdded && wsPlanDeleted && wsNoteAdded) { clearTimeout(timer); ws.terminate(); resolve(); }
                } catch (_) {}
            });
            ws.on('error', () => { clearTimeout(timer); resolve(); });
        });
    } catch (e) {}
    record('التحديث اللحظي عبر WebSocket (new_report)', wsReport);
    record('بث بدء المناوبة لحظياً (shift_started عبر ShiftStarted)', wsStarted);
    record('بث إنشاء التمركز لحظياً (PositioningStarted ← peak_plan_added)', wsPlanAdded);
    record('بث إنهاء التمركز لحظياً (PositioningEnded ← peak_plan_deleted)', wsPlanDeleted);
    record('بث تحديث سجل الملاحظات لحظياً (ShiftNoteAdded ← shift_note_added)', wsNoteAdded);

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
    let wsShiftDel = false, wsPlanUpd = false, wsNoteDel = false, wsFormDel = false, wsFormClr = false;
    try {
        const WebSocket = require('ws');
        await new Promise((resolve) => {
            const ws = new WebSocket(`ws://localhost:3080/ws?token=${TOKEN}`);
            const timer = setTimeout(() => { try { ws.terminate(); } catch (_) {} resolve(); }, 12000);
            ws.on('open', async () => {
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
            ws.on('message', (raw) => {
                try {
                    const m = JSON.parse(raw.toString());
                    if (m.type === 'shift_deleted') wsShiftDel = true;
                    if (m.type === 'peak_plan_updated') wsPlanUpd = true;
                    if (m.type === 'shift_note_deleted') wsNoteDel = true;
                    if (m.type === 'incident_deleted') wsFormDel = true;
                    if (m.type === 'air_ambulance_cleared') wsFormClr = true;
                    if (wsShiftDel && wsPlanUpd && wsNoteDel && wsFormDel && wsFormClr) { clearTimeout(timer); ws.terminate(); resolve(); }
                } catch (_) {}
            });
            ws.on('error', () => { clearTimeout(timer); resolve(); });
        });
    } catch (e) {}
    record('بث PositioningUpdated لحظياً (Catalog D-4 ← peak_plan_updated)', wsPlanUpd);
    record('بث ShiftNoteDeleted لحظياً (Catalog D-5 ← shift_note_deleted)', wsNoteDel);
    record('بث FormDeleted لحظياً (Catalog D-6 ← incident_deleted)', wsFormDel);
    record('بث FormsCleared لحظياً (Catalog D-7 ← air_ambulance_cleared)', wsFormClr);
    record('بث ShiftDeleted لحظياً (Catalog D-3 ← shift_deleted)', wsShiftDel);

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
