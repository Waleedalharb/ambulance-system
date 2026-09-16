/**
 * ═══ schedule-change-notifier.js — موحِّد إشعارات تغيير الجدول (v5) ═══
 *
 * المُشغِّل الموحّد: صفوف shift_audit_log المكتوبة داخل معاملة المزامنة (أو
 * التعديل اليدوي). تُستدعى بعد COMMIT فقط — فشلها لا يمس الجدول إطلاقًا
 * (شرط المالك: «فشل الإشعار لا يعمل Rollback للجدول»).
 *
 * التدفق لكل مراجعة (schedule_revisions):
 *   auditIds ──▶ قراءة الصفوف ──▶ تجميع لكل موظف ──▶ بناء رسالة مصنّفة
 *   ──▶ منع التكرار (revision_id + recipient_id) ──▶ حساب الدخول
 *   (users.json أولًا ثم جدول users — username = employee_code)
 *   ──▶ notification_log (pending ← sent) ──▶ بث موجَّه broadcastToUsers.
 *
 * ضوابط المالك المثبتة:
 *   ① إعادة نفس الملف = صفر تغيير = لا تصل هنا أصلًا (لا audit بلا diff).
 *   ② لا تكرار من Refresh/Retry: المفتاح (revision_id, recipient_id) فريد منطقيًا.
 *   ③ الموظف بلا حساب دخول: لا إشعار in-app — يُحصى ويبقى أثره في التدقيق.
 *   ④ فتح الإشعار ≠ تأكيده — هذه الخدمة لا تختم read/ack (مسارات البوابة).
 *   ⑤ كل فشل جزئي يُحصى ولا يوقف الباقين، والفشل الكلي يُبتلع بعد التسجيل.
 */
'use strict';

const fs = require('fs').promises;

const SHIFT_CHANGE_TITLE = 'تحديث في جدول المناوبات';

class ScheduleChangeNotifier {
    /**
     * @param {object} deps { db, usersPath, broadcastToUsers? }
     *   db: وحدة القاعدة (ShiftAuditLog/NotificationLog/Teams + get/all).
     *   usersPath: مسار users.json (SSOT الدخول) — يُتحمل غيابه.
     *   broadcastToUsers: دالة البث الموجَّه (WS+SSE) — اختيارية في الاختبارات.
     */
    constructor({ db, usersPath, broadcastToUsers, pushGateway }) {
        if (!db || !usersPath) throw new Error('ScheduleChangeNotifier: db و usersPath مطلوبان');
        this.db = db;
        this.usersPath = usersPath;
        this.broadcastToUsers = typeof broadcastToUsers === 'function' ? broadcastToUsers : null;
        // v6: بوابة APNs اختيارية — غيابها = بلا Push وبلا أي تغيير سلوك
        this.pushGateway = pushGateway && typeof pushGateway.sendToUsers === 'function' ? pushGateway : null;
    }

    /** حساب الدخول للموظف: users.json أولًا ثم جدول users (username = employee_code). */
    async _findLoginAccount(employeeCode) {
        try {
            const users = JSON.parse(await fs.readFile(this.usersPath, 'utf8'));
            const hit = (users || []).find(u => String(u.username) === String(employeeCode) && u.isActive !== false);
            if (hit) return { id: String(hit.id), name: hit.name || null };
        } catch (_) { /* users.json غائب/مشوه — نكمل للاحتياطي */ }
        try {
            const row = await this.db.get(
                'SELECT user_id, name FROM users WHERE username = ? AND is_active = 1', [String(employeeCode)]);
            if (row && row.user_id) return { id: String(row.user_id), name: row.name || null };
        } catch (_) { /* جدول users غير موجود في قواعد مصغّرة — بلا حساب */ }
        return null;
    }

    /**
     * بناء رسالة مصنّفة من تغييرات موظف واحد (تصنيف المالك الخماسي).
     * المجموعة المتجانسة تحمل صيغتها المحددة («تم تغيير فرقتك…» لعدة أيام)؛
     * غير المتجانسة فقط تسقط على «تم تحديث N عناصر».
     * teamName: دالة id ⇒ اسم («بدون فرقة» عند null).
     */
    _buildMessage(changes, teamName) {
        const dates = changes.map(c => c.shift_date).sort().join('، ');
        if (changes.length === 1) {
            const c = changes[0];
            const date = c.shift_date;
            if (c.change_type === 'add') {
                return `أُضيفت لك مناوبة يوم ${date} برمز «${c.new_shift_code}» مع فرقة «${teamName(c.new_team_id)}».`;
            }
            if (c.change_type === 'delete') {
                return `أُلغيت مناوبتك يوم ${date} (كانت برمز «${c.old_shift_code}» مع فرقة «${teamName(c.old_team_id)}»).`;
            }
            const teamChanged = c.old_team_id !== c.new_team_id;
            const codeChanged = String(c.old_shift_code || '') !== String(c.new_shift_code || '');
            if (teamChanged && codeChanged) {
                return `تم تغيير مناوبتك يوم ${date}: الرمز من «${c.old_shift_code}» إلى «${c.new_shift_code}» والفرقة من «${teamName(c.old_team_id)}» إلى «${teamName(c.new_team_id)}».`;
            }
            if (teamChanged) {
                return `تم تغيير فرقتك يوم ${date} من «${teamName(c.old_team_id)}» إلى «${teamName(c.new_team_id)}».`;
            }
            return `تم تغيير مناوبتك يوم ${date} من «${c.old_shift_code}» إلى «${c.new_shift_code}».`;
        }
        const n = changes.length;
        const allAdd = changes.every(c => c.change_type === 'add');
        const allDel = changes.every(c => c.change_type === 'delete');
        const allEdit = changes.every(c => c.change_type === 'edit');
        if (allAdd) return `أُضيفت لك ${n} مناوبات في جدولك (أيام ${dates}) — التفاصيل في «سجل تغييرات جدولي».`;
        if (allDel) return `أُلغيت ${n} مناوبات من جدولك (أيام ${dates}) — التفاصيل في «سجل تغييرات جدولي».`;
        if (allEdit) {
            const same = fn => changes.every(c => fn(c, changes[0]));
            const teamOnly = changes.every(c => c.old_team_id !== c.new_team_id && String(c.old_shift_code || '') === String(c.new_shift_code || ''));
            const codeOnly = changes.every(c => c.old_team_id === c.new_team_id && String(c.old_shift_code || '') !== String(c.new_shift_code || ''));
            if (teamOnly && same((c, f) => c.old_team_id === f.old_team_id && c.new_team_id === f.new_team_id)) {
                return `تم تغيير فرقتك من «${teamName(changes[0].old_team_id)}» إلى «${teamName(changes[0].new_team_id)}» (${n} أيام: ${dates}).`;
            }
            if (codeOnly && same((c, f) => c.old_shift_code === f.old_shift_code && c.new_shift_code === f.new_shift_code)) {
                return `تم تغيير مناوبتك من «${changes[0].old_shift_code}» إلى «${changes[0].new_shift_code}» (${n} أيام: ${dates}).`;
            }
        }
        const adds = changes.filter(c => c.change_type === 'add').length;
        const edits = changes.filter(c => c.change_type === 'edit').length;
        const dels = changes.filter(c => c.change_type === 'delete').length;
        const parts = [];
        if (adds) parts.push(`إضافة ${adds}`);
        if (edits) parts.push(`تعديل ${edits}`);
        if (dels) parts.push(`حذف ${dels}`);
        return `تم تحديث ${n} عناصر في جدولك (${parts.join('، ')}) — التفاصيل في قسم «سجل تغييرات جدولي» في بوابتك.`;
    }

    /**
     * إشعارات مراجعة واحدة. يُستدعى بعد COMMIT فقط.
     * @param {object} args { revisionId, auditIds }
     * @returns {Promise<object>} { notified, noAccount, duplicates, failed, total }
     *   لا يرمي أبدًا — الفشل الكلي يُسجَّل ويُعاد failed=total.
     */
    async notifyRevision({ revisionId, auditIds }) {
        const stats = { notified: 0, noAccount: 0, duplicates: 0, failed: 0, total: 0, pushed: 0 };
        try {
            if (!revisionId || !Array.isArray(auditIds) || !auditIds.length) return stats;
            const rows = await this.db.ShiftAuditLog.getByIds(auditIds);
            if (!rows.length) return stats;

            const teamRows = await this.db.all('SELECT id, name FROM teams');
            const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));
            const teamName = id => (id == null ? 'بدون فرقة' : (teamNameById.get(id) || 'بدون فرقة'));

            const empIds = [...new Set(rows.map(r => r.employee_id).filter(v => v != null))];
            const empById = new Map();
            for (const id of empIds) {
                const e = await this.db.get(
                    'SELECT id, employee_code, name, phone FROM employees WHERE id = ?', [id]);
                if (e) empById.set(id, e);
            }

            // تجميع صفوف كل موظف (صف واحد لكل موظف مهما تعددت تغييراته)
            const byEmp = new Map();
            for (const r of rows) {
                if (r.employee_id == null) continue;
                if (!byEmp.has(r.employee_id)) byEmp.set(r.employee_id, []);
                byEmp.get(r.employee_id).push(r);
            }
            stats.total = byEmp.size;

            for (const [empId, changes] of byEmp) {
                try {
                    const emp = empById.get(empId);
                    if (!emp) { stats.noAccount++; continue; } // موظف محذوف من السجل — أثره في التدقيق فقط

                    // ② منع التكرار: إشعار قائم لنفس (المراجعة، الموظف) ⇒ تخطٍّ
                    const dup = await this.db.NotificationLog.getByRevisionAndRecipient(revisionId, empId);
                    if (dup && dup.length) { stats.duplicates++; continue; }

                    // ③ بلا حساب دخول ⇒ لا إشعار in-app (يُحصى ويبقى التدقيق)
                    const account = await this._findLoginAccount(emp.employee_code);
                    if (!account) { stats.noAccount++; continue; }

                    changes.sort((a, b) => String(a.shift_date).localeCompare(String(b.shift_date)) || (a.id - b.id));
                    const message = this._buildMessage(changes, teamName);
                    const first = changes[0];
                    const notifId = await this.db.NotificationLog.create({
                        notification_type: 'shift_change',
                        recipient_id: empId,
                        recipient_user_id: account.id,
                        recipient_name: emp.name,
                        recipient_phone: emp.phone || null,
                        message,
                        channel: 'in-app',
                        status: 'pending',
                        roster_id: first.roster_id || null,
                        shift_date: first.shift_date,
                        old_value: changes.length === 1 ? (first.old_shift_code || null) : null,
                        new_value: changes.length === 1 ? (first.new_shift_code || null) : null,
                        revision_id: revisionId,
                        audit_id: first.id
                    });
                    await this.db.NotificationLog.markAsSent(notifId);
                    stats.notified++;

                    if (this.broadcastToUsers) {
                        try {
                            this.broadcastToUsers([account.id], {
                                type: 'notification_created',
                                message: SHIFT_CHANGE_TITLE,
                                notification: { id: notifId, title: SHIFT_CHANGE_TITLE, message, kind: 'schedule_change', revision_id: revisionId }
                            });
                        } catch (bErr) {
                            console.warn('[schedule-change-notifier] broadcast failed for', emp.employee_code, bErr.message);
                        }
                    }

                    // v6: نسخة Push لأجهزة الموظف — بعد نجاح الإشعار الداخلي فقط.
                    // البوابة لا ترمي؛ فشلها لا يمس الإشعار ولا الإحصاء القائم.
                    if (this.pushGateway) {
                        try {
                            const p = await this.pushGateway.sendToUsers([account.id], {
                                title: SHIFT_CHANGE_TITLE, body: message, badge: 'auto',
                                data: { kind: 'schedule_change', revision_id: revisionId, notification_id: notifId }
                            });
                            if (p && p.sent) stats.pushed += p.sent;
                        } catch (pErr) {
                            console.warn('[schedule-change-notifier] push failed for', emp.employee_code, pErr.message);
                        }
                    }
                } catch (perErr) {
                    stats.failed++;
                    console.error('[schedule-change-notifier] employee', empId, perErr.message);
                }
            }
        } catch (err) {
            console.error('[schedule-change-notifier] notifyRevision failed:', err.message);
        }
        return stats;
    }
}

module.exports = ScheduleChangeNotifier;
