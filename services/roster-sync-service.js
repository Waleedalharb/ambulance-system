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

// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد التوقيت —
// «اليوم» (تواريخ بدء/إنهاء التعيينات) = تاريخ الرياض الجداري، لا UTC الخادم.
const TimeRiyadh = require('../public/js/time-riyadh.js');

class RosterSyncService {
    constructor({ db }) {
        if (!db || typeof db.run !== 'function' || typeof db.get !== 'function' || typeof db.all !== 'function') {
            throw new Error('RosterSyncService: db adapter (run/get/all) مطلوب');
        }
        this.db = db;
    }

    /**
     * تطبيع اسم الفريق الخام من الإكسل إلى teams.id — غير المعروف ⇒ NULL.
     * المطابقة بعد تطبيع الطرفين: trim + توحيد المسافات المتكررة + الأرقام
     * العربية ← إنجليزية، و«تدخل سريع N»/«rapid_N»/«سريع N» كلها فريق واحد.
     * (لا يغيّر نتيجة الربط الناجح الحالي — يوسّع التقاط الصيغ فقط.)
     */
    _normalizeTeamName(v) {
        return String(v || '')
            .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
            .replace(/\s+/g, ' ')
            .trim();
    }

    _buildTeamResolver(teamRows) {
        const byName = new Map(teamRows.map(t => [this._normalizeTeamName(t.name), t.id]));
        return (rawTeam) => {
            const t = this._normalizeTeamName(rawTeam);
            if (!t) return null;
            if (byName.has(t)) return byName.get(t);
            const m = t.match(/^(?:rapid_\s*|تدخل\s*سريع\s*|سريع\s*)(\d+)$/i);
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
     * تطبيع مدخل الجدولة وإزالة التكرار بالرمز (الأخير يغلب).
     * مستخرجة حتى تتشاركها المزامنة وكشف التعارض مع التعديلات اليدوية.
     */
    _collectPeople(scheduleEmployees, stats) {
        const people = new Map(); // code → { code, name, phone, jobTitle, teamRaw, symbol, entries[] }
        for (const emp of scheduleEmployees) {
            const code = String((emp && (emp.employeeNumber != null ? emp.employeeNumber : emp.id)) || '').trim();
            const name = String((emp && emp.name) || '').trim();
            if (!code || !name) { stats.skippedEmployees++; continue; }
            people.set(code, {
                code, name,
                phone: emp.phone != null ? String(emp.phone) : null,
                jobTitle: String(emp.jobTitle || 'مسعف').trim() || 'مسعف',
                teamRaw: String(emp.team || '').trim(),
                // W-تكامل ③ب: الرمز الأساسي (O12A…) — undefined إن لم يرد في
                // هذا الاستيراد إطلاقًا حتى لا يمسح الرمز المخزن (استيراد قديم الصيغة)
                symbol: (emp && emp.symbol != null && String(emp.symbol).trim())
                    ? String(emp.symbol).trim() : undefined,
                entries: Array.isArray(emp.schedule) ? emp.schedule : []
            });
        }
        stats.employeesSeen = people.size;
        return people;
    }

    /**
     * كشف تعارض الاستيراد مع التعيينات اليدوية (source='manual') قبل أي كتابة.
     * التعارض = موظف له تعيين يدوي نشط لفرقة، والاستيراد يضعه في فرقة مختلفة.
     * لا يكتب شيئًا — قراءة فقط. الموظف غير الموجود في القاعدة لا تعارض له.
     * @returns {Promise<Array>} [{employeeCode, name, manualTeam, importTeam, assignedDate}]
     */
    async detectManualConflicts(scheduleEmployees) {
        if (!Array.isArray(scheduleEmployees)) return [];
        const stats = { skippedEmployees: 0, employeesSeen: 0 };
        const people = this._collectPeople(scheduleEmployees, stats);
        if (people.size === 0) return [];

        const teamRows = await this.db.all('SELECT id, name FROM teams');
        const resolveTeam = this._buildTeamResolver(teamRows);
        const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));

        const hasAssignTable = !!(await this.db.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='team_assignments'"));
        if (!hasAssignTable) return [];
        const cols = await this.db.all('PRAGMA table_info(team_assignments)').catch(() => []);
        const hasSourceCol = (cols || []).some(c => c.name === 'source');
        if (!hasSourceCol) return []; // قاعدة قديمة بلا عمود المصدر — لا حماية ممكنة

        const manualActive = await this.db.all(
            `SELECT ta.id, ta.employee_id, ta.team_id, ta.assigned_date, e.employee_code, e.name AS employee_name
             FROM team_assignments ta JOIN employees e ON e.id = ta.employee_id
             WHERE ta.end_date IS NULL AND ta.source = 'manual'`);
        const manualByCode = new Map();
        for (const a of manualActive) {
            if (!manualByCode.has(a.employee_code)) manualByCode.set(a.employee_code, []);
            manualByCode.get(a.employee_code).push(a);
        }

        const conflicts = [];
        for (const p of people.values()) {
            const manual = manualByCode.get(p.code);
            if (!manual || !manual.length) continue;
            const importTeamId = resolveTeam(p.teamRaw);
            for (const a of manual) {
                if (importTeamId == null || a.team_id !== importTeamId) {
                    conflicts.push({
                        employeeCode: p.code,
                        name: p.name,
                        manualTeam: teamNameById.get(a.team_id) || String(a.team_id),
                        importTeam: importTeamId != null ? (teamNameById.get(importTeamId) || p.teamRaw) : (p.teamRaw || 'بدون فريق'),
                        assignedDate: a.assigned_date || null
                    });
                }
            }
        }
        return conflicts;
    }

    /**
     * المزامنة الكاملة في معاملة واحدة ذرية.
     * @param {Array} scheduleEmployees مصفوفة الجدولة (بنية ملف الاستيراد).
     * @param {object} [options] { overwriteManual: true } يسمح باستبدال
     *   التعيينات اليدوية المتعارضة (يتطلب confirm صريحًا من واجهة الاستيراد).
     *   الافتراضي: التعيين اليدوي المتعارض يُحمى ولا يُمس.
     * @returns {Promise<object>} إحصاءات المزامنة.
     */
    async syncFromSchedule(scheduleEmployees, options = {}) {
        const overwriteManual = options && options.overwriteManual === true;
        // G2 — حارس المسح الصامت (اعتماد المالك 2026-08-30): المسح الشامل
        // لـ shift_roster (periods فارغة) مسارُ مسحٍ صريح فقط (explicitClear:
        // DELETE /api/schedule/employees). الاستيراد العادي بحمولة لا تُنتج
        // أي فترة صالحة يُرفض قبل أي كتابة — ممنوع أن يعود «نجاحًا» وقد
        // مُسحت كل الشهور (حوادث «الحفظ لا ينعكس» التاريخية).
        const explicitClear = options && options.explicitClear === true;
        if (!Array.isArray(scheduleEmployees)) {
            throw new Error('RosterSyncService: مصفوفة الجدولة مطلوبة');
        }
        const stats = {
            employeesSeen: 0, created: 0, updated: 0, reactivated: 0,
            deactivated: 0, rosterRows: 0, rosterPeriods: [],
            skippedEmployees: 0, skippedEntries: 0,
            assignmentsCreated: 0, assignmentsEnded: 0,
            manualConflictsProtected: [], manualOverwritten: 0,
            unmatchedTeams: []
        };

        // ── 1) تطبيع المدخل وإزالة التكرار بالرمز (الأخير يغلب) ──
        const people = this._collectPeople(scheduleEmployees, stats);

        // ── 1ب) G2: فحص مبكر بلا كتابة — هل ستُنتج الحمولة أي فترة صالحة؟ ──
        // نفس قاعدة الصلاحية المستخدمة في الخطوة 4 (تاريخ ISO حقيقي + رمز غير
        // فارغ). planned=0 يشمل: مصفوفة فارغة، موظفون بلا مداخل، وتواريخ مشوهة
        // (مثل 2026-00-XX من فشل كشف الشهر في المحلل الكلاسيكي).
        if (!explicitClear) {
            let planned = 0, invalid = 0;
            for (const p of people.values()) {
                for (const s of p.entries) {
                    const d = String((s && s.date) || '').trim();
                    const c = String((s && (s.shiftCode || s.shift)) || '').trim();
                    if (this._validIsoDate(d) && c) planned++; else invalid++;
                }
            }
            if (planned === 0) {
                const guardErr = new Error('حمولة الاستيراد لا تحتوي أي مدخل جدولة بتاريخ صالح — أُوقف الاستيراد قبل أي كتابة (حارس المسح الصامت)');
                guardErr.code = 'EMPTY_PERIODS_GUARD';
                guardErr.skippedEntries = invalid;
                throw guardErr;
            }
        }

        const teamRows = await this.db.all('SELECT id, name FROM teams');
        const resolveTeam = this._buildTeamResolver(teamRows);
        // ── شفافية الربط: أي فريق خام غير فارغ تعذّر ربطه يُجمع ويُرجع في
        // النتيجة (unmatchedTeams) بدل الاختفاء الصامت في team_id=NULL —
        // يظهر للإداري في تقرير الاستيراد (حادثة صفوف القيادة/العمليات).
        const unmatchedMap = new Map(); // teamRaw → عدد الموظفين
        for (const p of people.values()) {
            if (!p.teamRaw) continue;
            if (resolveTeam(p.teamRaw) == null) {
                unmatchedMap.set(p.teamRaw, (unmatchedMap.get(p.teamRaw) || 0) + 1);
            }
        }
        stats.unmatchedTeams = [...unmatchedMap.entries()]
            .map(([team, employees]) => ({ team, employees }))
            .sort((a, b) => b.employees - a.employees || a.team.localeCompare(b.team));
        // W-تكامل ③ب: العمود وصفة إضافية — قواعد مصغّرة بلا symbol تُتخطى تحديثه بأمان
        const empCols = await this.db.all('PRAGMA table_info(employees)').catch(() => []);
        const hasSymbolCol = (empCols || []).some(c => c.name === 'symbol');

        await this.db.beginTransaction();
        try {
            // ── 2) upsert الموظفين بالرمز (هوية وحيدة) ──
            const idByCode = new Map();
            for (const p of people.values()) {
                const existing = await this.db.get(
                    'SELECT id, is_active FROM employees WHERE employee_code = ?', [p.code]);
                if (existing) {
                    // حماية الجوال (البند ④ 2026-08-10): الاستيراد بلا عمود جوال
                    // لا يمسح رقمًا مخزنًا — يُستبدل فقط بقيمة غير فارغة.
                    if (hasSymbolCol && p.symbol !== undefined) {
                        await this.db.run(
                            "UPDATE employees SET name = ?, phone = COALESCE(NULLIF(?, ''), phone), job_title = ?, symbol = ?, is_active = 1 WHERE id = ?",
                            [p.name, p.phone, p.jobTitle, p.symbol, existing.id]);
                    } else {
                        await this.db.run(
                            "UPDATE employees SET name = ?, phone = COALESCE(NULLIF(?, ''), phone), job_title = ?, is_active = 1 WHERE id = ?",
                            [p.name, p.phone, p.jobTitle, existing.id]);
                    }
                    stats.updated++;
                    if (!existing.is_active) stats.reactivated++;
                    idByCode.set(p.code, existing.id);
                } else {
                    if (hasSymbolCol) {
                        const ins = await this.db.run(
                            'INSERT INTO employees (employee_code, name, phone, job_title, symbol, is_active) VALUES (?, ?, ?, ?, ?, 1)',
                            [p.code, p.name, p.phone, p.jobTitle, p.symbol !== undefined ? p.symbol : null]);
                        stats.created++;
                        idByCode.set(p.code, ins.id);
                    } else {
                        const ins = await this.db.run(
                            'INSERT INTO employees (employee_code, name, phone, job_title, is_active) VALUES (?, ?, ?, ?, 1)',
                            [p.code, p.name, p.phone, p.jobTitle]);
                        stats.created++;
                        idByCode.set(p.code, ins.id);
                    }
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

            // ── 3ب) تعيينات الفرق: مطابقة العضوية مع آخر جدولة (إنهاء لا حذف) ──
            // team_assignments يخدم مسار /api/shift-completion/:shiftId/:teamName.
            // بما أن هذه الخدمة هي الكاتب الوحيد للجدولة (W-تكامل ②)، فهي أيضًا
            // من يحافظ على العضوية: فريق الموظف في آخر استيراد هو عضويته النشطة،
            // والتعيين المستبدل يُنهى بـ end_date ولا يُحذف إطلاقًا.
            // ملاحظة حقن: قواعد مصغّرة بلا جدول التعيينات تُتخطى هذه الخطوة بأمان.
            const hasAssignTable = !!(await this.db.get(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='team_assignments'"));
            if (hasAssignTable) {
                const today = TimeRiyadh.formatDate(new Date()); // تاريخ الرياض الجداري (كان UTC)
                const assignCols = await this.db.all('PRAGMA table_info(team_assignments)').catch(() => []);
                const hasSourceCol = (assignCols || []).some(c => c.name === 'source');
                const activeAssign = await this.db.all(
                    hasSourceCol
                        ? 'SELECT id, employee_id, team_id, assigned_date, source FROM team_assignments WHERE end_date IS NULL'
                        : 'SELECT id, employee_id, team_id, assigned_date, NULL AS source FROM team_assignments WHERE end_date IS NULL');
                const teamNameById = new Map(teamRows.map(t => [t.id, t.name]));
                const assignByEmp = new Map();
                for (const a of activeAssign) {
                    if (!assignByEmp.has(a.employee_id)) assignByEmp.set(a.employee_id, []);
                    assignByEmp.get(a.employee_id).push(a);
                }
                for (const p of people.values()) {
                    const employeeId = idByCode.get(p.code);
                    const teamId = resolveTeam(p.teamRaw);
                    const current = assignByEmp.get(employeeId) || [];
                    const hasMatch = teamId != null && current.some(a => a.team_id === teamId);
                    // حماية التعديل اليدوي: تعيين source='manual' متعارض مع الاستيراد
                    // (فرقة مختلفة) لا يُنهى ولا يُستبدل إلا بتأكيد صريح
                    // (overwriteManual=true عبر confirmOverwriteManual في endpoint الاستيراد).
                    let manualProtected = false;
                    for (const a of current) {
                        if (a.team_id !== teamId) {
                            if (a.source === 'manual' && !overwriteManual) {
                                manualProtected = true;
                                stats.manualConflictsProtected.push({
                                    employeeCode: p.code,
                                    name: p.name,
                                    manualTeam: teamNameById.get(a.team_id) || String(a.team_id),
                                    importTeam: teamId != null ? (teamNameById.get(teamId) || p.teamRaw) : (p.teamRaw || 'بدون فريق'),
                                    assignedDate: a.assigned_date || null
                                });
                                continue;
                            }
                            if (a.source === 'manual' && overwriteManual) stats.manualOverwritten++;
                            await this.db.run('UPDATE team_assignments SET end_date = ? WHERE id = ?', [today, a.id]);
                            stats.assignmentsEnded++;
                        }
                    }
                    if (teamId != null && !hasMatch && !manualProtected) {
                        await this.db.run(
                            'INSERT INTO team_assignments (employee_id, team_id, assigned_date, is_primary) VALUES (?, ?, ?, 1)',
                            [employeeId, teamId, today]);
                        stats.assignmentsCreated++;
                    }
                }
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
