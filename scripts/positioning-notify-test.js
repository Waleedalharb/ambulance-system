/**
 * ═══ اختبار تدشين نظام «التمركز» للمسعف (2026-09-28) ═══
 * العزل: DATA_DIR + DB_PATH مؤقتان — لا تمس بيانات الإنتاج.
 *
 * الحالات:
 *   1) إنشاء تمركز لفرقة ← إشعار شخصي واحد لمناوبها الحالي فقط، بحقول مهيكلة
 *      (task_key + data_json: center/team/start_time/end_time/positioning_task_id)
 *   2) عدم التسريب: مناوب فرقة أخرى / موظف برمز «راحة» / موظف غير نشط ← صفر إشعارات
 *   3) Idempotency بمعرف المهمة: إعادة نفس الحدث = touch (لا صف جديد، لا مسّ للقراءة)
 *   4) ختم القراءة personal + تحديث المهمة يعيدها غير مقروءة في الصف نفسه
 *   5) الصلاحية: ختم إشعار شخصي لا يملكه الحساب ← notOwned
 *   6) دمج getMyNotifications: سجل الجدول + التمركز بقائمة واحدة مرتبة + الحقول المهيكلة
 *   7) حالة عدم وجود تمركز: لا عناصر positioning ولا مهمة وهمية
 *   8) إلغاء التمركز يحدّث الصف نفسه (kind=ended) ولا يضيف صفًا
 *   9) خطة بلا فرق / فرقة غير معروفة: لا مستلمين ولا رمي
 *
 * التشغيل: node scripts/positioning-notify-test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const STAMP = Date.now();
const TMP_DIR = path.join(os.tmpdir(), 'positioning-notify-' + STAMP).replace(/\\/g, '/');
fs.mkdirSync(TMP_DIR, { recursive: true });
process.env.DATA_DIR = TMP_DIR;
process.env.DB_PATH = path.join(TMP_DIR, 'ambulance.db').replace(/\\/g, '/');

const db = require('../db.js');
const PositioningService = require('../services/positioning-service');
const MyPortalService = require('../services/my-portal-service');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}

function riyadhTodayStr() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

(async () => {
    await db.init();
    const today = riyadhTodayStr();
    const [y, m] = today.split('-').map(Number);

    // ── بذر مصغر: فرقتان + رمزا دوام/راحة + 4 موظفين + roster اليوم ──
    // التهيئة تبذر جداول تشغيلية مسبقًا — لا نفرض معرّفات؛ ندرج بالاسم ونقرأ id.
    await db.run("INSERT OR IGNORE INTO teams (name, center) VALUES ('جنوب 2', 'الخالدية'), ('شمال 1', 'العليا')");
    const team1 = (await db.get("SELECT id FROM teams WHERE name = 'جنوب 2'")).id;
    const team2 = (await db.get("SELECT id FROM teams WHERE name = 'شمال 1'")).id;
    await db.run("INSERT OR IGNORE INTO shift_codes (code, name, status) VALUES ('D', 'يومي', 'دوام'), ('OFF', 'راحة', 'راحة')");
    await db.run("UPDATE shift_codes SET status = 'دوام' WHERE code = 'D'");
    await db.run("UPDATE shift_codes SET status = 'راحة' WHERE code = 'OFF'");
    await db.run("INSERT INTO employees (employee_code, name, is_active) VALUES ('T001', 'مسعف أول', 1), ('T002', 'مسعف ثانٍ', 1), ('T003', 'مسعف راحة', 1), ('T004', 'مسعف موقوف', 0)");
    const emp1 = (await db.get("SELECT id FROM employees WHERE employee_code = 'T001'")).id;
    const emp2 = (await db.get("SELECT id FROM employees WHERE employee_code = 'T002'")).id;
    const emp3 = (await db.get("SELECT id FROM employees WHERE employee_code = 'T003'")).id;
    const emp4 = (await db.get("SELECT id FROM employees WHERE employee_code = 'T004'")).id;
    await db.run("INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, 'D', ?, ?), (?, ?, ?, 'D', ?, ?), (?, ?, ?, 'OFF', ?, ?), (?, ?, ?, 'D', ?, ?)",
        [emp1, team1, today, m, y, emp2, team2, today, m, y, emp3, team1, today, m, y, emp4, team1, today, m, y]);
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify([
        { id: 'u1', username: 'T001', name: 'مسعف أول', role: 'user', isActive: true },
        { id: 'u2', username: 'T002', name: 'مسعف ثانٍ', role: 'user', isActive: true },
        { id: 'u3', username: 'T003', name: 'مسعف راحة', role: 'user', isActive: true },
        { id: 'u4', username: 'T004', name: 'مسعف موقوف', role: 'user', isActive: true }
    ]));

    const bus = { emit() { } };
    const svc = new PositioningService({ db, bus, getActiveShiftId: async () => null });
    const portal = new MyPortalService({ db });
    const opsUser = { id: 'op1', username: 'ops', name: 'العمليات' };
    const u1 = { id: 'u1', username: 'T001' };
    const u2 = { id: 'u2', username: 'T002' };

    // ── 1) إنشاء تمركز ──
    const plan = await svc.create({
        title: 'مركز الخالدية', location: 'حي الخالدية - تقاطع الملك فهد',
        unit: 'جنوب 2', priority: 'high',
        startTime: today + 'T05:00', endTime: today + 'T17:00'
    }, opsUser);

    const u1Rows = await db.all('SELECT * FROM notifications WHERE user_id = ?', ['u1']);
    check('1أ) إشعار واحد لمناوب الفرقة المستهدفة', u1Rows.length === 1, JSON.stringify(u1Rows.length));
    const row = u1Rows[0] || {};
    check('1ب) task_key = positioning:<planId>', row.task_key === 'positioning:' + plan.id, row.task_key);
    let data = null;
    try { data = JSON.parse(row.data_json || 'null'); } catch (_) { }
    check('1ج) الحقول المهيكلة: type/center/team/positioning_task_id',
        data && data.type === 'positioning' && data.center === 'مركز الخالدية'
        && data.team === 'جنوب 2' && data.positioning_task_id === String(plan.id)
        && data.kind === 'created' && data.priority === 'high', JSON.stringify(data));
    check('1د) الفترة الحقيقية (UTC ISO بعد التطبيع) — لا وقت مُخترع',
        !!(data && data.start_time && data.end_time && /T02:00:00/.test(data.start_time) && /T14:00:00/.test(data.end_time)),
        data && (data.start_time + ' → ' + data.end_time));
    check('1هـ) العنوان «مهمة تمركز جديدة» والرسالة تحمل التوجيه والمركز',
        row.title === 'مهمة تمركز جديدة' && /تم توجيهك للتمركز في مركز الخالدية/.test(row.message || ''));

    // ── 2) عدم التسريب ──
    check('2أ) مناوب فرقة أخرى: صفر إشعارات', (await db.all("SELECT * FROM notifications WHERE user_id = 'u2'")).length === 0);
    check('2ب) موظف برمز «راحة»: صفر إشعارات', (await db.all("SELECT * FROM notifications WHERE user_id = 'u3'")).length === 0);
    check('2ج) موظف غير نشط: صفر إشعارات', (await db.all("SELECT * FROM notifications WHERE user_id = 'u4'")).length === 0);

    // ── 3) Idempotency: إعادة الحدث نفسه = touch ──
    await svc._notifyOnDuty(plan, 'created', opsUser);
    const afterDup = await db.all("SELECT * FROM notifications WHERE user_id = 'u1'");
    check('3أ) إعادة الإنشاء لا تضيف صفًا (touch فقط)', afterDup.length === 1, String(afterDup.length));

    // ── 4) ختم القراءة ثم تحديث المهمة ──
    const readRes = await portal.markMyNotificationRead(u1, row.id, 'personal');
    check('4أ) ختم قراءة personal ناجح', readRes.status === 'read', JSON.stringify(readRes));
    let cur = await db.get('SELECT * FROM notifications WHERE id = ?', [row.id]);
    check('4ب) الصف مقروء فعلًا', cur.is_read === 1);

    await svc.update(plan.id, { title: 'مركز العليا', location: 'حي العليا' }, opsUser);
    const afterUpd = await db.all("SELECT * FROM notifications WHERE user_id = 'u1'");
    cur = afterUpd[0] || {};
    check('4ج) التحديث في الصف نفسه (لا صف جديد)', afterUpd.length === 1, String(afterUpd.length));
    check('4د) المحتوى تحدّث وعاد غير مقروء (معلومة جديدة)',
        cur.is_read === 0 && /تحديث مهمة تمركز/.test(cur.title || '') && /مركز العليا/.test(cur.message || ''));
    const updData = JSON.parse(cur.data_json || '{}');
    check('4هـ) data_json تعكس التحديث (center الجديد + kind=updated)',
        updData.center === 'مركز العليا' && updData.kind === 'updated');

    // ── 5) الصلاحية: ختم إشعار لا يملكه الحساب ──
    const foreign = await portal.markMyNotificationRead(u2, row.id, 'personal');
    check('5) ختم إشعار الغير مرفوض (notOwned)', foreign.notOwned === true, JSON.stringify(foreign));

    // ── 6) الدمج في /api/my/notifications ──
    await db.NotificationLog.create({
        notification_type: 'shift_change', recipient_id: emp1, recipient_user_id: 'u1',
        message: 'تم تغيير مناوبتك يوم ' + today, channel: 'in-app', status: 'sent', shift_date: today
    });
    const merged = await portal.getMyNotifications(u1);
    const posItem = (merged.notifications || []).find(n => n.source === 'personal');
    const logItem = (merged.notifications || []).find(n => n.source === 'log');
    check('6أ) القائمة تدمج المصدرين (سجل + تمركز)', !!posItem && !!logItem, JSON.stringify((merged.notifications || []).map(n => n.source)));
    check('6ب) عنصر التمركز يحمل النوع والحقول المهيكلة للواجهة',
        posItem && posItem.type === 'positioning' && posItem.data && posItem.data.center === 'مركز العليا' && posItem.taskKey === 'positioning:' + plan.id);
    check('6ج) العداد يحسب غير المقروء عبر المصدرين', merged.unreadCount === 2, String(merged.unreadCount));

    // ── 7) حالة عدم وجود تمركز ──
    const empty = await portal.getMyNotifications(u2);
    check('7) بلا تمركز: لا عناصر positioning ولا مهمة وهمية',
        (empty.notifications || []).filter(n => n.type === 'positioning').length === 0);

    // ── 8) إلغاء التمركز ──
    await svc.remove(plan.id, opsUser);
    const afterEnd = await db.all("SELECT * FROM notifications WHERE user_id = 'u1' AND task_key = ?", ['positioning:' + plan.id]);
    const endRow = afterEnd[0] || {};
    check('8أ) الإلغاء في الصف نفسه', afterEnd.length === 1, String(afterEnd.length));
    check('8ب) المحتوى «إلغاء مهمة تمركز» + kind=ended',
        endRow.title === 'إلغاء مهمة تمركز' && (JSON.parse(endRow.data_json || '{}').kind === 'ended'));

    // ── 9) خطط بلا مستلمين — لا رمي ولا إشعارات ──
    const before = (await db.all('SELECT COUNT(*) AS c FROM notifications'))[0].c;
    // id الخطة = Date.now() — فاصل صغير يمنع تصادم المعرّف بين إنشاءين متتاليين
    await new Promise(r => setTimeout(r, 10));
    await svc.create({ title: 'بلا فرقة', location: 'x', startTime: today + 'T05:00', endTime: today + 'T06:00' }, opsUser);
    await new Promise(r => setTimeout(r, 10));
    await svc.create({ title: 'فرقة وهمية', unit: 'فرقة غير موجودة', startTime: today + 'T05:00', endTime: today + 'T06:00' }, opsUser);
    const after = (await db.all('SELECT COUNT(*) AS c FROM notifications'))[0].c;
    check('9) بلا فرق/فرقة غير معروفة: صفر إشعارات جديدة وبلا رمي', after === before, `${before} → ${after}`);

    // ── الخلاصة ──
    console.log('\n═══ النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل ═══');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('❌ فشل عام:', err);
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    process.exit(1);
});
