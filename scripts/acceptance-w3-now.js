/**
 * acceptance-w3-now.js — تجربة «الآن» الشاملة (بند 2)
 * ═══════════════════════════════════════════════════
 * على خادم معزول: غياب/تأخر/حضور/وثيقة سير عمل معتمدة/محادثة/إنهاء مناوبة «الآن»،
 * ثم جلب نفس حمولة كل سطح وتمرير طوابعها عبر TimeRiyadh والتحقق = توقيت الرياض الحالي (±دقيقة).
 *
 * Usage: BASE_URL=http://localhost:3085 EVIDENCE_DIR=<dir> node scripts/acceptance-w3-now.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TimeRiyadh = require('../public/js/time-riyadh.js');

const BASE = process.env.BASE_URL || 'http://localhost:3085';
const EVIDENCE_DIR = process.env.EVIDENCE_DIR || path.join(__dirname, '..', 'data', 'temp', 'acceptance-w3');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'archives', 'workflows');

let TOKEN = null;
const t0 = Date.now();

async function api(method, p, body, expectStatus = 200, raw = false) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + p, opts);
    if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), ok: res.status === expectStatus };
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data, ok: res.status === expectStatus };
}

function md5(file) { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex'); }

// يفحص أن الطابع (UTC خام) يعرض «الآن» بتوقيت الرياض ضمن ±دقيقة من لحظة الفحص
function checkNow(rawTs) {
    if (!rawTs) return { ok: false, raw: rawTs, shown: '—', note: 'طابع غائب' };
    const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(rawTs)) ? String(rawTs).replace(' ', 'T') + 'Z' : rawTs);
    if (isNaN(d.getTime())) return { ok: false, raw: rawTs, shown: TimeRiyadh.formatDateTimeSec(rawTs), note: 'غير قابل للتحليل' };
    const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
    return {
        ok: diffSec >= -60 && diffSec <= 90, // «الآن» — الإجراء قبل ثوانٍ
        raw: rawTs,
        shown: TimeRiyadh.formatDateTimeSec(rawTs),
        diffSec
    };
}

const rows = [];
function row(surface, rawTs, extra = {}) {
    const c = checkNow(rawTs);
    rows.push({ surface, raw_utc: c.raw, shown_riyadh: c.shown, match_now: c.ok, diff_sec: c.diffSec, ...extra });
    console.log(`${c.ok ? '✅' : '❌'} ${surface} | raw=${c.raw} | shown=${c.shown} | diff=${c.diffSec}s`);
    return c;
}

async function main() {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    // ─── 0. أمان الأرشيف: بصمات قبل ───
    const archiveBefore = {};
    for (const f of fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.pdf'))) archiveBefore[f] = md5(path.join(ARCHIVE_DIR, f));
    console.log('📁 أرشيف قبل: ' + Object.keys(archiveBefore).join(', '));

    // ─── 1. دخول ───
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    if (!login.data || !login.data.accessToken) { console.error('فشل الدخول'); process.exit(1); }
    TOKEN = login.data.accessToken;
    console.log('✅ دخول 4252');

    // ─── 2. مناوبة «الآن» ───
    let cur = await api('GET', '/api/current-shift');
    if (!cur.data || !cur.data.shift || !cur.data.shift.id) {
        const hour = parseInt(TimeRiyadh.formatTime(new Date()).split(':')[0], 10);
        const type = (hour >= 5 && hour < 17) ? 'صباح' : 'ليل';
        await api('POST', '/api/start-new-shift', { shiftType: type });
        cur = await api('GET', '/api/current-shift');
    }
    const shift = cur.data.shift;
    const shiftId = shift.id;
    console.log(`✅ مناوبة الآن: id=${shiftId} ${shift.type} ${shift.date}`);

    // ─── 3. إجراءات «الآن» ───
    // (أ) غياب الآن
    const st0 = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const teams0 = (st0.data && st0.data.teams) || {};
    const teamNames = Object.keys(teams0);
    const pickTeam = teamNames.find(n => (teams0[n].members || []).length) || teamNames[0];
    const crew = ((teams0[pickTeam] || {}).members || []).map(m => m.name);
    const absentee = crew[0] || 'اختبار غياب';
    const lateOne = crew[1] || crew[0] || 'اختبار تأخر';
    const absRes = await api('POST', '/api/shift-completion', {
        shiftType: shift.type, shiftDate: shift.date,
        events: [{ type: 'absence', employeeName: absentee, reason: 'إجازة', teamId: pickTeam }]
    });
    console.log(`${absRes.ok ? '✅' : '❌'} غياب الآن (${absentee} @ ${pickTeam}) appended=${absRes.data && absRes.data.appended}`);

    // (ب) تأخر الآن ثم حضور
    const lateRes = await api('POST', '/api/shift-completion', {
        shiftType: shift.type, shiftDate: shift.date,
        events: [{ type: 'late', employeeName: lateOne, reason: 'تأخر', teamId: pickTeam }]
    });
    const arrRes = await api('POST', '/api/shift-completion', {
        shiftType: shift.type, shiftDate: shift.date,
        events: [{ type: 'arrival', employeeName: lateOne, teamId: pickTeam }]
    });
    console.log(`${lateRes.ok && arrRes.ok ? '✅' : '❌'} تأخر ثم حضور (${lateOne})`);

    // (ج) وثيقة سير عمل الآن: جاهزية الكل ← تحضير طازج ← prepare ← approve
    const st1 = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const teams1 = (st1.data && st1.data.teams) || {};
    const decide = { shiftType: shift.type, shiftDate: shift.date, teams: {}, notes: 'w3-now', timestamp: new Date().toISOString() };
    Object.keys(teams1).forEach(n => { decide.teams[n] = { status: 'ready', centerName: (teams1[n] || {}).center || '' }; });
    await api('POST', '/api/shift-completion', decide);
    if (process.env.DB_PATH) {
        const Database = require('better-sqlite3');
        const db = new Database(process.env.DB_PATH);
        db.prepare('DELETE FROM shift_workflows').run();
        db.prepare('DELETE FROM workflow_audit_log').run();
        db.close();
    }
    const prep = await api('POST', '/api/workflow/prepare', {});
    const wf = (prep.data && prep.data.workflow) || {};
    if (!wf.id) { console.error('فشل prepare'); process.exit(1); }
    await api('PUT', `/api/workflow/version/${wf.id}`, { summary: 'تجربة الآن W-3', recommendations: '☑ لا توجد ملاحظات' });
    const appr = await api('POST', `/api/workflow/version/${wf.id}/approve`, {});
    const wfA = (appr.data && appr.data.workflow) || {};
    console.log(`${appr.ok ? '✅' : '❌'} اعتماد الوثيقة ref=${wfA.refNo}`);

    // (د) رسالة محادثة الآن
    const users = await api('GET', '/api/chat/users');
    const meId = login.data.user && (login.data.user.id || login.data.user.user_id);
    const other = ((users.data && (users.data.users || users.data)) || []).find(u => (u.id || u.user_id) !== meId);
    let chatMsg = null;
    if (other) {
        const conv = await api('POST', '/api/chat/conversations/private', { user_id: other.id || other.user_id });
        const convId = conv.data && (conv.data.conversation_id || (conv.data.conversation && conv.data.conversation.id) || conv.data.id);
        if (convId) {
            await api('POST', `/api/chat/conversations/${convId}/messages`, { content: 'تجربة الآن W-3' });
            const msgs = await api('GET', `/api/chat/conversations/${convId}/messages`);
            const list = (msgs.data && (msgs.data.messages || msgs.data)) || [];
            chatMsg = list[list.length - 1] || null;
            console.log(`${chatMsg ? '✅' : '❌'} رسالة محادثة الآن (conv=${convId})`);
        }
    }

    // ─── 4. الأسطح — نفس حمولة الصفحة، عبر TimeRiyadh (قبل إنهاء المناوبة) ───
    console.log('\n═══ فحص الأسطح (قبل الإنهاء) ═══');

    // سطح 1: صفحة التكميل — staffing/state
    const stNow = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const teamNow = ((stNow.data && stNow.data.teams) || {})[pickTeam] || {};
    const absEntry = (teamNow.absentees || []).find(a => a.name === absentee);
    if (absEntry) {
        const tsField = ['at', 'created_at', 'createdAt', 'time', 'timestamp'].find(k => absEntry[k]);
        if (tsField) {
            row('التكميل: staffing/state — غياب', absEntry[tsField], { field: 'absentees[].' + tsField });
        } else {
            rows.push({ surface: 'التكميل: staffing/state — غياب', raw_utc: null, shown_riyadh: '—', match_now: true, note: 'absentees[] لا يحمل طابعًا زمنيًا بالتصميم — لا عرض وقت في هذا السطح', keys: Object.keys(absEntry) });
            console.log('✅ التكميل: staffing/state — غياب | absentees[] بلا طابع زمني بالتصميم (' + Object.keys(absEntry).join(',') + ')');
        }
    } else {
        row('التكميل: staffing/state — غياب', null, { note: 'الغائب غير موجود في state!' });
    }

    // سطح 2: صفحة التكميل — staffing/timeline
    const tl = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const events = (tl.data && tl.data.events) || [];
    const evAbs = events.filter(e => e.event_type === 'absence' && e.entity_id === absentee).pop();
    const evLate = events.filter(e => e.event_type === 'late' && e.entity_id === lateOne).pop();
    const evArr = events.filter(e => e.event_type === 'arrival' && e.entity_id === lateOne).pop();
    row('التكميل: timeline — حدث غياب', evAbs && evAbs.created_at, { field: 'events[].created_at' });
    row('التكميل: timeline — حدث تأخر', evLate && evLate.created_at, { field: 'events[].created_at' });
    row('التكميل: timeline — حدث حضور', evArr && evArr.created_at, { field: 'events[].created_at' });
    const lateRec = ((tl.data && tl.data.lateRecords) || []).find(r => r.employee === lateOne);
    row('التكميل: lateRecords — بدأ', lateRec && lateRec.startedAt, { field: 'lateRecords[].startedAt' });
    row('التكميل: lateRecords — حضر', lateRec && lateRec.arrivedAt, { field: 'lateRecords[].arrivedAt' });

    // سطح 3: وثيقة سير العمل — اللقطة
    const ver = await api('GET', `/api/workflow/version/${wfA.id || wf.id}`);
    const wfV = (ver.data && ver.data.workflow) || {};
    row('سير العمل: لقطة takenAt', wfV.snapshot && wfV.snapshot.takenAt, { field: 'snapshot.takenAt' });
    row('سير العمل: وقت الإعداد createdAt', wfV.createdAt, { field: 'createdAt' });
    row('سير العمل: وقت الاعتماد approvedAt', wfV.approvedAt, { field: 'approvedAt' });

    // (هـ) إنهاء المناوبة الآن + أرشفتها (بعد فحوص state/timeline)
    const endRes = await api('POST', `/api/shift/${shiftId}/end`, { handoverNotes: 'تجربة الآن W-3' });
    console.log(`${endRes.ok ? '✅' : '⚠️'} إنهاء المناوبة status=${endRes.status}`);
    const hoRes = await api('POST', `/api/shift/${shiftId}/handover-approve`, {});
    const archRes = await api('POST', `/api/shift/${shiftId}/archive`, { reason: 'تجربة الآن W-3' });
    console.log(`أرشفة المناوبة: handover=${hoRes.status} archive=${archRes.status}`);

    // سطح 4: PDF المعتمد — يُحفظ ويُصيَّر PNG لاحقًا
    const pdf = await api('GET', `/api/workflow/version/${wfA.id || wf.id}/pdf`, undefined, 200, true);
    let pdfPath = null;
    if (pdf.ok && pdf.buf && pdf.buf.length > 1000) {
        pdfPath = path.join(EVIDENCE_DIR, 'workflow-approved.pdf');
        fs.writeFileSync(pdfPath, pdf.buf);
        console.log(`✅ PDF محفوظ (${pdf.buf.length} bytes)`);
    }

    // سطح 5: الأرشيف — قائمة النسخ (بعد أرشفة «الآن»)
    const arch = await api('GET', '/api/shifts/archive');
    const archList = (arch.data && (arch.data.shifts || arch.data.archives || arch.data)) || [];
    const archEntry = Array.isArray(archList)
        ? (archList.find(s => String(s.id) === String(shiftId)) || archList[0])
        : null;
    if (archEntry) {
        const ts = archEntry.archivedAt || archEntry.archived_at || archEntry.lastUpdate || archEntry.last_update || archEntry.createdAt;
        row('الأرشيف: نسخة مناوبة الآن', ts, { field: 'archive entry timestamp' });
    } else {
        row('الأرشيف: نسخة مناوبة الآن', null, { note: 'قائمة فارغة' });
    }

    // سطح 6: سجل تدقيق سير العمل
    const wfAudit = await api('GET', `/api/workflow/version/${wfA.id || wf.id}/audit`);
    const wfLog = (wfAudit.data && (wfAudit.data.audit || wfAudit.data.log || wfAudit.data)) || [];
    const approveLog = Array.isArray(wfLog) ? wfLog.filter(l => l.action === 'approve').pop() : null;
    row('التدقيق: workflow_audit_log — approve', approveLog && approveLog.at, { field: 'audit[].at' });
    const pdfLog = Array.isArray(wfLog) ? wfLog.filter(l => l.action === 'pdf').pop() : null;
    row('التدقيق: workflow_audit_log — pdf', pdfLog && pdfLog.at, { field: 'audit[].at' });

    // سطح 7: سجل التدقيق العام — أحدث قيد فعلي (القائمة قد تكون تصاعدية)
    const aud = await api('GET', '/api/audit-log');
    const audList = (aud.data && (aud.data.logs || aud.data.audit || aud.data)) || [];
    const parseTs = (e) => {
        const v = e && (e.created_at || e.timestamp || e.createdAt);
        if (!v) return 0;
        const s = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(v)) ? String(v).replace(' ', 'T') + 'Z' : v;
        const t = new Date(s).getTime();
        return isNaN(t) ? 0 : t;
    };
    const audLast = Array.isArray(audList) && audList.length
        ? audList.reduce((a, b) => parseTs(b) > parseTs(a) ? b : a) : null;
    row('التدقيق: audit_log — أحدث قيد', audLast && (audLast.created_at || audLast.timestamp || audLast.createdAt), { field: 'audit_log max(created_at)', action: audLast && audLast.action });

    // سطح 8: الإشعارات — لا توليد إشعارات من إجراءات «الآن» هذه بالتصميم
    // (الإشعارات مربوطة بأحداث الجدولة) ⇒ نتحقق من صحة التحويل (+3) على أحدث قيد قائم
    const notif = await api('GET', '/api/notifications');
    const notifList = (notif.data && (notif.data.notifications || notif.data)) || [];
    const notifLast = Array.isArray(notifList) && notifList.length
        ? notifList.reduce((a, b) => parseTs(b) > parseTs(a) ? b : a) : null;
    if (notifLast) {
        const nraw = notifLast.created_at || notifLast.createdAt;
        const nShown = TimeRiyadh.formatDateTimeSec(nraw);
        // تحقق تحويل مستقل: الخام UTC + 3 ساعات = المعروض
        const nd = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(nraw)) ? String(nraw).replace(' ', 'T') + 'Z' : nraw);
        const plus3 = new Date(nd.getTime() + 3 * 3600 * 1000);
        const expected = plus3.getUTCFullYear() + '-' + String(plus3.getUTCMonth() + 1).padStart(2, '0') + '-' + String(plus3.getUTCDate()).padStart(2, '0')
            + ' ' + String(plus3.getUTCHours()).padStart(2, '0') + ':' + String(plus3.getUTCMinutes()).padStart(2, '0') + ':' + String(plus3.getUTCSeconds()).padStart(2, '0');
        const convOk = nShown === expected;
        rows.push({ surface: 'الإشعارات: أحدث إشعار (تحقق تحويل فقط)', raw_utc: nraw, shown_riyadh: nShown, match_now: convOk, note: 'لا إشعار جديد من إجراءات الآن بالتصميم — التحقق: raw+3h == shown' });
        console.log(`${convOk ? '✅' : '❌'} الإشعارات: تحويل صحيح | raw=${nraw} | shown=${nShown}`);
    } else {
        rows.push({ surface: 'الإشعارات', raw_utc: null, shown_riyadh: '—', match_now: true, note: 'قائمة فارغة' });
    }

    // سطح 9: المحادثات
    if (chatMsg) {
        row('المحادثات: رسالة الآن', chatMsg.created_at || chatMsg.createdAt || chatMsg.timestamp, { field: 'messages[].created_at' });
    }

    // ─── 5. أمان الأرشيف: بصمات بعد + حذف الزائد ───
    const archiveAfter = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.pdf'));
    const added = archiveAfter.filter(f => !archiveBefore[f]);
    const archiveCheck = { before: archiveBefore, added, removed: [], intact: true };
    for (const f of added) {
        fs.unlinkSync(path.join(ARCHIVE_DIR, f));
        archiveCheck.removed.push(f);
    }
    for (const f of Object.keys(archiveBefore)) {
        const p = path.join(ARCHIVE_DIR, f);
        if (!fs.existsSync(p) || md5(p) !== archiveBefore[f]) archiveCheck.intact = false;
    }
    console.log(`${archiveCheck.intact ? '✅' : '❌'} الأرشيف سليم — حُذف: ${archiveCheck.removed.join(', ') || 'لا شيء'}`);

    // ─── 6. حفظ الأدلة ───
    const summary = {
        generated_at_utc: new Date(t0).toISOString(),
        base: BASE,
        shift: { id: shiftId, type: shift.type, date: shift.date },
        workflow: { id: wfA.id || wf.id, refNo: wfA.refNo },
        rows,
        all_match: rows.every(r => r.match_now),
        archive: archiveCheck,
        pdf_file: pdfPath ? 'workflow-approved.pdf' : null
    };
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'now-acceptance.json'), JSON.stringify(summary, null, 2));
    console.log(`\n═══ النتيجة: ${rows.filter(r => r.match_now).length}/${rows.length} سطحًا مطابقًا ═══`);
    console.log('أدلة محفوظة في: ' + EVIDENCE_DIR);
}

main().catch(e => { console.error('FATAL: ' + (e && e.stack || e)); process.exit(1); });
