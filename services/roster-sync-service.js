// ============================================
// SR-2: RosterSyncService — المزامنة الوحيدة من الجدولة إلى قاعدة البيانات
// ============================================
// مصدر الحقيقة (بلا Bridge ولا Fallback ولا قراءة JSON أثناء التشغيل):
//
//   الجدولة (استيراد إكسل) ──▶ RosterSync ──▶ employees ──▶ shift_roster
//
// العقد:
//  - employee_code هو مفتاح الهوية الوحيد (الاسم قابل للتغيير، الرقم لا يتغير).
//  - موجود بالرمز  ⇒ UPDATE (الاسم/الهاتف/المسمى + إعادة تفعيل).
//  - غير موجود     ⇒ INSERT (is_active = 1).
//  - لم يعد في الجدولة ⇒ لا حذف إطلاقًا — is_active = 0 فقط.
//  - shift_roster يُعاد بناؤه للفترات المشمولة بالاستيراد (حذف + إدراج ذري).
//  - مدخل فارغ (مسح الجدولة) ⇒ تعطيل الجميع + مسح roster بالكامل.
//  - لا يُنشئ ولا يمسّ حسابات الدخول (users) — جداول منفصلة المسؤولية.
//  - الصفوف المشوهة (تاريخ غير صالح/بلا رمز دوام) تُتخطى وتُحصى.
//
// الحقن: { db } وحدة واجهة القاعدة (run/get/all/beginTransaction/…)
// فيُختبر على قاعدة مؤقتة ويُستخدم إنتاجيًا عبر db.js نفسه.
// ============================================

class RosterSyncService {
    constructor({ db }) {
        if (!db || typeof db.run !== 'function' || typeof db.get !== 'function' || typeof db.all !== 'function') {
            throw new Error('RosterSyncService: db adapter (run/get/all) مطلوب');
        }
        this.db = db;
    }

    /** تطبيع اسم الفريق الخام من الإكسل إلى teams.id — غير المعروف ⇒ NULL. */
    _buildTeamResolver(teamRows) {
        const byName = new Map(teamRows.map(t => [String(t.name || '').trim(), t.id]));
        return (rawTeam) => {
            const t = String(rawTeam || '').trim();
            if (!t) return null;
            if (byName.has(t)) return byName.get(t);
            const m = t.match(/^(?:rapid_|تدخل\s*سريع\s*)(\d+)$/i);
            if (m) {
                const rapid = byName.get('سريع ' + parseInt(m[1], 10));
                if (rapid != null) return rapid;
            }
            return null; // وحدات غير تشغيلية (قائد_ميداني/دعم_لوجستي/إجازة…) — بلا فريق
        };
    }

    /** تاريخ ISO حقيقي فقط (يرفض مشوهات مثل 2026-07-32). */
    _validIsoDate(d) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d || ''))) return false;
        const [y, m, day] = d.split('-').map(Number);
        if (m < 1 || m > 12 || day < 1 || day > 31) return false;
        const dt = new Date(Date.UTC(y, m - 1, day));
        return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
    }

    /**
     * المزامنة الكاملة في معاملة واحدة ذرية.
     * @param {Array} scheduleEmployees مصفوفة الجدولة (بنية ملف الاستيراد).
     * @returns {Promise<object>} إحصاءات المزامنة.
     */
    async syncFromSchedule(scheduleEmployees) {
        if (!Array.isArray(scheduleEmployees)) {
            throw new Error('RosterSyncService: مصفوفة الجدولة مطلوبة');
        }
        const stats = {
            employeesSeen: 0, created: 0, updated: 0, reactivated: 0,
            deactivated: 0, rosterRows: 0, rosterPeriods: [],
            skippedEmployees: 0, skippedEntries: 0
        };

        // ── 1) تطبيع المدخل وإزالة التكرار بالرمز (الأخير يغلب) ──
        const people = new Map(); // code → { code, name, phone, jobTitle, teamRaw, entries[] }
        for (const emp of scheduleEmployees) {
            const code = String((emp && (emp.employeeNumber != null ? emp.employeeNumber : emp.id)) || '').trim();
            const name = String((emp && emp.name) || '').trim();
            if (!code || !name) { stats.skippedEmployees++; continue; }
            people.set(code, {
                code, name,
                phone: emp.phone != null ? String(emp.phone) : null,
                jobTitle: String(emp.jobTitle || 'مسعف').trim() || 'مسعف',
                teamRaw: String(emp.team || '').trim(),
                entries: Array.isArray(emp.schedule) ? emp.schedule : []
            });
        }
        stats.employeesSeen = people.size;

        const teamRows = await this.db.all('SELECT id, name FROM teams');
        const resolveTeam = this._buildTeamResolver(teamRows);

        await this.db.beginTransaction();
        try {
            // ── 2) upsert الموظفين بالرمز (هوية وحيدة) ──
            const idByCode = new Map();
            for (const p of people.values()) {
                const existing = await this.db.get(
                    'SELECT id, is_active FROM employees WHERE employee_code = ?', [p.code]);
                if (existing) {
                    await this.db.run(
                        'UPDATE employees SET name = ?, phone = ?, job_title = ?, is_active = 1 WHERE id = ?',
                        [p.name, p.phone, p.jobTitle, existing.id]);
                    stats.updated++;
                    if (!existing.is_active) stats.reactivated++;
                    idByCode.set(p.code, existing.id);
                } else {
                    const ins = await this.db.run(
                        'INSERT INTO employees (employee_code, name, phone, job_title, is_active) VALUES (?, ?, ?, ?, 1)',
                        [p.code, p.name, p.phone, p.jobTitle]);
                    stats.created++;
                    idByCode.set(p.code, ins.id);
                }
            }

            // ── 3) من لم يعد في الجدولة: تعطيل فقط — لا حذف إطلاقًا ──
            if (people.size > 0) {
                const placeholders = [...people.keys()].map(() => '?').join(',');
                const deact = await this.db.run(
                    `UPDATE employees SET is_active = 0 WHERE employee_code NOT IN (${placeholders})`,
                    [...people.keys()]);
                stats.deactivated = deact.changes || 0;
            } else {
                const deact = await this.db.run('UPDATE employees SET is_active = 0');
                stats.deactivated = deact.changes || 0;
            }

            // ── 4) صفوف الـ roster من مداخل الجدولة الصالحة فقط ──
            const periods = new Set(); // 'year-month'
            const rows = [];           // [employee_id, team_id, shift_date, shift_code, month, year]
            for (const p of people.values()) {
                const employeeId = idByCode.get(p.code);
                const teamId = resolveTeam(p.teamRaw);
                for (const s of p.entries) {
                    const date = String((s && s.date) || '').trim();
                    const code = String((s && (s.shiftCode || s.shift)) || '').trim().toUpperCase();
                    if (!this._validIsoDate(date) || !code) { stats.skippedEntries++; continue; }
                    const year = Number(date.slice(0, 4));
                    const month = Number(date.slice(5, 7));
                    periods.add(year + '-' + month);
                    rows.push([employeeId, teamId, date, code, month, year]);
                }
            }

            // ── 5) إعادة بناء roster للفترات المشمولة (حذف + إدراج) ──
            if (periods.size === 0) {
                // مسح الجدولة ⇒ مسح roster بالكامل (بيانات جدولة، لا بيانات موظفين)
                await this.db.run('DELETE FROM shift_roster');
            } else {
                for (const key of periods) {
                    const [y, m] = key.split('-').map(Number);
                    await this.db.run('DELETE FROM shift_roster WHERE year = ? AND month = ?', [y, m]);
                }
                for (const r of rows) {
                    await this.db.run(
                        'INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)',
                        r);
                }
            }
            stats.rosterRows = rows.length;
            stats.rosterPeriods = [...periods].sort();

            await this.db.commitTransaction();
            return stats;
        } catch (err) {
            try { await this.db.rollbackTransaction(); } catch (_) { /* لا شيء */ }
            throw err;
        }
    }
}

module.exports = RosterSyncService;
