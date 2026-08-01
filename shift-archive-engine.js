/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║                    Shift Archive Engine v2.0                              ║
 * ║         نظام أرشفة المناوبات المتكامل — قطاع جنوب الرياض                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *  المكونات الرئيسية:
 *  1. ShiftArchiveValidator  — التحقق من اكتمال البيانات قبل الأرشفة
 *  2. ShiftArchiveSnapshot   — إنشاء لقطة شاملة لحالة المناوبة
 *  3. ShiftArchiveEngine     — المحرك الرئيسي (Atomic Save + Rollback)
 *  4. ShiftIntegrityChecker  — التحقق من سلامة البيانات بعد الأرشفة
 *  5. ShiftAuditLogger       — سجل تدقيق عمليات الأرشفة
 *
 *  آلية العمل:
 *  ┌─────────────┐   ┌─────────────┐   ┌──────────────┐   ┌─────────────┐   ┌─────────────┐
 *  │  VALIDATE   │ → │  COLLECT    │ → │   ATOMIC    │ → │  VERIFY     │ → │   UPDATE    │
 *  │  (تحقق)     │   │  (اجمع)     │   │   SAVE      │   │  (تحقق)     │   │  (حدث KPIs) │
 *  └─────────────┘   └─────────────┘   └──────────────┘   └─────────────┘   └─────────────┘
 *       ↑                                                          │
 *       └────────────────── ROLLBACK (إلغاء) ←─────────────────────┘ (إذا فشل)
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// ============================================
// 1. VALIDATOR — التحقق من اكتمال البيانات
// ============================================
class ShiftArchiveValidator {
    constructor(db, storagePath) {
        this.db = db;
        this.storagePath = storagePath;
        this.errors = [];
        this.warnings = [];
    }

    /**
     * التحقق الشامل من جميع بيانات المناوبة
     * يُستدعى قبل بدء عملية الأرشفة
     */
    async validate(shiftId, options = {}) {
        this.errors = [];
        this.warnings = [];

        const results = {
            shiftId,
            isValid: true,
            timestamp: new Date().toISOString(),
            checks: {}
        };

        // 1. التحقق من وجود المناوبة
        results.checks.shiftExists = await this._validateShiftExists(shiftId);

        // 2. التحقق من البلاغات
        results.checks.reports = await this._validateReports(shiftId);

        // 3. التحقق من التكميل (Completion)
        results.checks.completions = await this._validateCompletions(shiftId);

        // 4. التحقق من النماذج
        results.checks.forms = await this._validateForms(shiftId);

        // 5. التحقق من المرفقات/الملفات
        results.checks.attachments = await this._validateAttachments(shiftId);

        // 6. التحقق من المؤشرات
        results.checks.metrics = await this._validateMetrics(shiftId);

        // 7. التحقق من توزيع البلاغات
        results.checks.distribution = await this._validateDistribution(shiftId);

        // 8. التحقق من الأحداث الزمنية
        results.checks.timeline = await this._validateTimeline(shiftId);

        // تحديد النتيجة النهائية
        const criticalChecks = [
            results.checks.shiftExists,
            results.checks.reports,
            results.checks.completions
        ];

        results.isValid = criticalChecks.every(c => c.isValid);
        results.errors = this.errors;
        results.warnings = this.warnings;

        // إذا كان وضع strict مفعل، أي warning يعتبر error
        if (options.strict) {
            results.isValid = results.isValid && this.warnings.length === 0;
        }

        return results;
    }

    async _validateShiftExists(shiftId) {
        try {
            // Check JSON
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(data);
            const shift = shifts.find(s => s.id === shiftId);

            if (!shift) {
                // Try DB
                if (this.db && this.db.Shifts && this.db.Shifts.getById) {
                    const dbShift = await this.db.Shifts.getById(shiftId);
                    if (dbShift) {
                        return { isValid: true, source: 'db', shift: dbShift };
                    }
                }
                this.errors.push(`المناوبة #${shiftId} غير موجودة في JSON أو قاعدة البيانات`);
                return { isValid: false, source: null };
            }

            // Validate essential fields
            const requiredFields = ['shiftDate', 'shiftType', 'startTime'];
            const missingFields = requiredFields.filter(f => !shift[f]);
            if (missingFields.length > 0) {
                this.warnings.push(`حقول ناقصة في المناوبة: ${missingFields.join(', ')}`);
            }

            return { isValid: true, source: 'json', shift };
        } catch (err) {
            this.errors.push(`خطأ في التحقق من وجود المناوبة: ${err.message}`);
            return { isValid: false, source: null, error: err.message };
        }
    }

    async _validateReports(shiftId) {
        try {
            let reports = [];
            let reportCount = 0;

            // Try DB first
            if (this.db && this.db.Reports && this.db.Reports.getByShift) {
                reports = await this.db.Reports.getByShift(shiftId);
                reportCount = Array.isArray(reports) ? reports.length : 0;
            }

            // Fallback: check shift.savedReports
            if (reportCount === 0) {
                const shiftsPath = path.join(this.storagePath, 'shift-data.json');
                const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
                const shifts = JSON.parse(data);
                const shift = shifts.find(s => s.id === shiftId);
                if (shift && shift.savedReports) {
                    reportCount = Object.values(shift.savedReports).reduce(
                        (sum, r) => sum + (r.count || 0), 0
                    );
                }
            }

            if (reportCount === 0) {
                this.warnings.push(`لا توجد بلاغات مسجلة للمناوبة #${shiftId}`);
            }

            // Check for corrupted report data
            if (Array.isArray(reports)) {
                const corrupted = reports.filter(r => !r || typeof r !== 'object');
                if (corrupted.length > 0) {
                    this.errors.push(`يوجد ${corrupted.length} بلاغ تالف في قاعدة البيانات`);
                }
            }

            return {
                isValid: true,
                count: reportCount,
                hasData: reportCount > 0
            };
        } catch (err) {
            this.errors.push(`خطأ في التحقق من البلاغات: ${err.message}`);
            return { isValid: false, error: err.message };
        }
    }

    async _validateCompletions(shiftId) {
        try {
            let completions = [];

            if (this.db && this.db.ShiftCompletions && this.db.ShiftCompletions.getByShift) {
                completions = await this.db.ShiftCompletions.getByShift(shiftId);
            }

            const completionCount = Array.isArray(completions) ? completions.length : 0;

            // Check for corrupted completion data
            if (Array.isArray(completions)) {
                const corrupted = completions.filter(c => {
                    try {
                        if (!c) return true;
                        // Validate teams_data JSON
                        if (c.teams_data) JSON.parse(c.teams_data);
                        return false;
                    } catch {
                        return true;
                    }
                });
                if (corrupted.length > 0) {
                    this.errors.push(`يوجد ${corrupted.length} سجل تكميل تالف (teams_data غير صالح)`);
                    return { isValid: false, count: completionCount, corrupted: corrupted.length };
                }
            }

            return {
                isValid: true,
                count: completionCount,
                hasData: completionCount > 0
            };
        } catch (err) {
            this.errors.push(`خطأ في التحقق من التكميل: ${err.message}`);
            return { isValid: false, error: err.message };
        }
    }

    async _validateForms(shiftId) {
        try {
            let forms = [];

            if (this.db && this.db.ShiftForms && this.db.ShiftForms.getByShift) {
                forms = await this.db.ShiftForms.getByShift(shiftId);
            }

            const formCount = Array.isArray(forms) ? forms.length : 0;

            // Check for forms with missing data
            if (Array.isArray(forms)) {
                const incomplete = forms.filter(f => !f || !f.form_type);
                if (incomplete.length > 0) {
                    this.warnings.push(`يوجد ${incomplete.length} نموذج بدون نوع محدد`);
                }
            }

            return {
                isValid: true,
                count: formCount,
                hasData: formCount > 0
            };
        } catch (err) {
            this.errors.push(`خطأ في التحقق من النماذج: ${err.message}`);
            return { isValid: false, error: err.message };
        }
    }

    async _validateAttachments(shiftId) {
        try {
            let files = [];

            if (this.db && this.db.OpsFiles && this.db.OpsFiles.getByShift) {
                files = await this.db.OpsFiles.getByShift(shiftId);
            }

            const fileCount = Array.isArray(files) ? files.length : 0;

            // Verify files actually exist on disk
            if (Array.isArray(files)) {
                const missingFiles = [];
                for (const file of files) {
                    if (file.file_path || file.path) {
                        const exists = await fs.access(file.file_path || file.path)
                            .then(() => true).catch(() => false);
                        if (!exists) {
                            missingFiles.push(file.file_name || file.name || 'unknown');
                        }
                    }
                }
                if (missingFiles.length > 0) {
                    this.warnings.push(`ملفات مفقودة من القرص: ${missingFiles.join(', ')}`);
                }
            }

            return {
                isValid: true,
                count: fileCount,
                hasData: fileCount > 0
            };
        } catch (err) {
            this.errors.push(`خطأ في التحقق من المرفقات: ${err.message}`);
            return { isValid: false, error: err.message };
        }
    }

    async _validateMetrics(shiftId) {
        try {
            let metrics = null;

            if (this.db && this.db.ShiftMetrics && this.db.ShiftMetrics.getByShift) {
                metrics = await this.db.ShiftMetrics.getByShift(shiftId);
            }

            return {
                isValid: true,
                hasMetrics: !!metrics,
                metrics: metrics || null
            };
        } catch (err) {
            this.warnings.push(`خطأ في التحقق من المؤشرات: ${err.message}`);
            return { isValid: true, error: err.message }; // Non-critical
        }
    }

    async _validateDistribution(shiftId) {
        try {
            // Check if reports have center/unit distribution
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(data);
            const shift = shifts.find(s => s.id === shiftId);

            const hasDistribution = shift && shift.savedReports &&
                Object.keys(shift.savedReports).some(k => k.includes('|'));

            return {
                isValid: true,
                hasDistribution: !!hasDistribution
            };
        } catch (err) {
            this.warnings.push(`خطأ في التحقق من التوزيع: ${err.message}`);
            return { isValid: true, error: err.message };
        }
    }

    async _validateTimeline(shiftId) {
        try {
            let events = [];

            if (this.db && this.db.ShiftTimelineEvents && this.db.ShiftTimelineEvents.getByShift) {
                events = await this.db.ShiftTimelineEvents.getByShift(shiftId, 1);
            }

            return {
                isValid: true,
                eventCount: Array.isArray(events) ? events.length : 0
            };
        } catch (err) {
            this.warnings.push(`خطأ في التحقق من السجل الزمني: ${err.message}`);
            return { isValid: true, error: err.message };
        }
    }
}

// ============================================
// 2. SNAPSHOT — لقطة شاملة لحالة المناوبة
// ============================================
class ShiftArchiveSnapshot {
    constructor(db, storagePath) {
        this.db = db;
        this.storagePath = storagePath;
    }

    /**
     * إنشاء لقطة شاملة لحالة المناوبة لحظة الأرشفة
     * تجمع جميع البيانات في كائن واحد متكامل
     */
    async create(shiftId) {
        const snapshot = {
            metadata: {
                shiftId,
                createdAt: new Date().toISOString(),
                version: '2.0',
                hash: null // will be calculated
            },
            shift: null,
            reports: {},
            completions: [],
            forms: [],
            files: [],
            timeline: [],
            auditTrail: [],
            metrics: null,
            notes: [],
            events: [],
            absences: [],
            operationalEvents: []
        };

        // 1. جلب بيانات المناوبة الأساسية
        snapshot.shift = await this._getShift(shiftId);

        // 2. جلب البلاغات
        snapshot.reports = await this._getReports(shiftId);

        // 3. جلب التكميل
        snapshot.completions = await this._getCompletions(shiftId);

        // 4. جلب النماذج
        snapshot.forms = await this._getForms(shiftId);

        // 5. جلب الملفات المرفقة
        snapshot.files = await this._getFiles(shiftId);

        // 6. جلب السجل الزمني
        snapshot.timeline = await this._getTimeline(shiftId);

        // 7. جلب سجل التدقيق
        snapshot.auditTrail = await this._getAuditTrail(shiftId);

        // 8. جلب المؤشرات
        snapshot.metrics = await this._getMetrics(shiftId);

        // 9. جلب الملاحظات
        snapshot.notes = await this._getNotes(shiftId);

        // 10. جلب الأحداث
        snapshot.events = await this._getEvents(shiftId);

        // 11. جلب الأحداث التشغيلية الموحدة (Timeline Events — مصدر الحقيقة للقوى البشرية)
        snapshot.operationalEvents = await this._getOperationalEvents(shiftId);

        // 12. جلب الغيابات (الجداول القديمة + المشتقة من الأحداث التشغيلية)
        snapshot.absences = await this._getAbsences(shiftId, snapshot.operationalEvents);

        // 13-15. Archive slice: تفاصيل البلاغات + التمركزات + المحادثات (D-6)
        snapshot.reportEntries = await this._getReportEntries(shiftId);
        snapshot.positioning = await this._getPositioning(shiftId);
        // 16. جولة Operational Workflow Completion (المرحلة أ): سجل أحداث التمركزات
        // (append-only) يُختم داخل اللقطة — دورة الحياة كاملة (إنشاء/تعديل/كنس/إنهاء)
        // تصبح جزءًا من الأرشيف التاريخي للمناوبة لا مجرد حالتها الأخيرة.
        snapshot.positioningEvents = await this._getPositioningEvents(shiftId);
        // 17. المرحلة ب: تسجيلات خروج الفرق — الحالة الحالية (أحدث حدث لكل فرقة)
        // + سجل أحداث TEAM_CHECKOUT الكامل (append-only) مختومَين في اللقطة:
        // من أنهى المناوبة ومتى ومن كانوا أفراد كل فرقة، مع أثر التصحيحات كاملًا
        // (مصدر الحقيقة: shift_signout_events — لا جدول حالة موازٍ).
        snapshot.signouts = await this._getSignouts(shiftId);
        snapshot.signoutEvents = await this._getSignoutEvents(shiftId);
        snapshot.conversations = await this._getConversations(shiftId);

        // Calculate integrity hash
        snapshot.metadata.hash = this._calculateHash(snapshot);

        return snapshot;
    }

    async _getShift(shiftId) {
        try {
            // Try JSON first
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(data);
            const shift = shifts.find(s => s.id === shiftId);
            if (shift) return shift;

            // Try DB
            if (this.db && this.db.Shifts && this.db.Shifts.getById) {
                return await this.db.Shifts.getById(shiftId);
            }
        } catch (err) {
            console.error('[Snapshot] Error getting shift:', err.message);
        }
        return null;
    }

    async _getReports(shiftId) {
        try {
            if (this.db && this.db.Reports && this.db.Reports.getByShift) {
                const reports = await this.db.Reports.getByShift(shiftId);
                if (Array.isArray(reports) && reports.length > 0) {
                    // Convert to object format
                    const obj = {};
                    reports.forEach(r => {
                        if (r.center && r.unit) {
                            obj[`${r.center}|${r.unit}`] = {
                                count: r.count || 0,
                                times: r.times || []
                            };
                        }
                    });
                    return obj;
                }
            }

            // Fallback to shift savedReports
            const shift = await this._getShift(shiftId);
            return shift && shift.savedReports ? shift.savedReports : {};
        } catch (err) {
            console.error('[Snapshot] Error getting reports:', err.message);
            return {};
        }
    }

    async _getCompletions(shiftId) {
        try {
            if (this.db && this.db.ShiftCompletions && this.db.ShiftCompletions.getByShift) {
                const completions = await this.db.ShiftCompletions.getByShift(shiftId);
                return Array.isArray(completions) ? completions : [];
            }
        } catch (err) {
            console.error('[Snapshot] Error getting completions:', err.message);
        }
        return [];
    }

    async _getForms(shiftId) {
        try {
            if (this.db && this.db.ShiftForms && this.db.ShiftForms.getByShift) {
                const forms = await this.db.ShiftForms.getByShift(shiftId);
                return Array.isArray(forms) ? forms : [];
            }
        } catch (err) {
            console.error('[Snapshot] Error getting forms:', err.message);
        }
        return [];
    }

    async _getFiles(shiftId) {
        try {
            if (this.db && this.db.OpsFiles && this.db.OpsFiles.getByShift) {
                const files = await this.db.OpsFiles.getByShift(shiftId);
                return Array.isArray(files) ? files : [];
            }
        } catch (err) {
            console.error('[Snapshot] Error getting files:', err.message);
        }
        return [];
    }

    async _getTimeline(shiftId) {
        try {
            if (this.db && this.db.ShiftTimelineEvents && this.db.ShiftTimelineEvents.getByShift) {
                const events = await this.db.ShiftTimelineEvents.getByShift(shiftId, 1000);
                return Array.isArray(events) ? events : [];
            }
        } catch (err) {
            console.error('[Snapshot] Error getting timeline:', err.message);
        }
        return [];
    }

    async _getAuditTrail(shiftId) {
        try {
            if (this.db && this.db.ShiftAuditTrail && this.db.ShiftAuditTrail.getByShift) {
                const audit = await this.db.ShiftAuditTrail.getByShift(shiftId, 1000);
                return Array.isArray(audit) ? audit : [];
            }
        } catch (err) {
            console.error('[Snapshot] Error getting audit trail:', err.message);
        }
        return [];
    }

    async _getMetrics(shiftId) {
        try {
            if (this.db && this.db.ShiftMetrics && this.db.ShiftMetrics.getByShift) {
                return await this.db.ShiftMetrics.getByShift(shiftId);
            }
        } catch (err) {
            console.error('[Snapshot] Error getting metrics:', err.message);
        }
        return null;
    }

    // ─── Archive slice: unified content collectors (SQLite single source) ───
    async _getContentRows(table, shiftId) {
        try {
            if (!this.db || !this.db.all) return [];
            const rows = await this.db.all(`SELECT * FROM ${table} WHERE shift_id = ?`, [shiftId]);
            return rows.map(r => {
                let data = {};
                try { data = r.data ? JSON.parse(r.data) : {}; } catch (e) {}
                return { ...data, id: r.id, shiftId: r.shift_id };
            });
        } catch (err) {
            console.error(`[Snapshot] Error getting ${table}:`, err.message);
            return [];
        }
    }

    async _getNotes(shiftId) {
        return this._getContentRows('shift_notes', shiftId);
    }

    async _getEvents(shiftId) {
        return this._getContentRows('shift_events', shiftId);
    }

    async _getOperationalEvents(shiftId) {
        try {
            if (!this.db || !this.db.all) return [];
            const rows = await this.db.all(
                'SELECT * FROM operational_events WHERE shift_id = ? ORDER BY created_at ASC',
                [shiftId]
            );
            return Array.isArray(rows) ? rows : [];
        } catch (err) {
            console.error('[Snapshot] Error getting operational events:', err.message);
            return [];
        }
    }

    async _getAbsences(shiftId, operationalEvents) {
        const legacy = await this._getContentRows('shift_absences', shiftId);
        // Timeline Events هي مصدر الحقيقة: أحداث الغياب/التأخر الشخصية تُشتق من
        // operational_events حتى لا تضيع في الأرشيف — تدفق الأحداث الجديد لا يكتب
        // جدول shift_absences القديم، والتاريخ يُحفظ كاملًا (Append Only)
        const derived = (Array.isArray(operationalEvents) ? operationalEvents : [])
            .filter(e => e.domain === 'staffing' && (e.event_type === 'absence' || e.event_type === 'late'))
            .map(e => ({
                source: 'operational_events',
                employee: e.entity_id || e.entity_name || '',
                team: e.team_id || '',
                center: e.center || '',
                type: e.event_type, // absence = غياب، late = تأخر
                reason: e.reason || '',
                createdAt: e.created_at || null
            }));
        return [...legacy, ...derived];
    }

    async _getReportEntries(shiftId) {
        return this._getContentRows('report_entries', shiftId);
    }

    async _getPositioning(shiftId) {
        return this._getContentRows('peak_plans', shiftId);
    }

    // المرحلة أ: أحداث التمركزات بترتيب وقوعها — الحقول JSON تُفك للعرض المباشر
    async _getPositioningEvents(shiftId) {
        try {
            if (!this.db || !this.db.all) return [];
            const rows = await this.db.all(
                'SELECT * FROM positioning_events WHERE shift_id = ? ORDER BY created_at ASC, id ASC',
                [shiftId]
            );
            return (Array.isArray(rows) ? rows : []).map(r => {
                let payload = {}, changed = null;
                try { payload = r.payload ? JSON.parse(r.payload) : {}; } catch (e) {}
                try { changed = r.changed_fields ? JSON.parse(r.changed_fields) : null; } catch (e) {}
                return {
                    id: r.id,
                    planId: r.plan_id,
                    eventType: r.event_type,
                    changedFields: changed,
                    payload,
                    actorId: r.actor_id,
                    actorName: r.actor_name,
                    createdAt: r.created_at
                };
            });
        } catch (err) {
            console.error('[Snapshot] Error getting positioning events:', err.message);
            return [];
        }
    }

    // المرحلة ب: تسجيلات خروج الفرق — الحالة الحالية = أحدث حدث TEAM_CHECKOUT
    // لكل فرقة (عرض مشتق من سجل shift_signout_events — members تُفك)
    async _getSignouts(shiftId) {
        try {
            if (!this.db || !this.db.all) return [];
            const rows = await this.db.all(
                `SELECT s.* FROM shift_signout_events s
                 JOIN (SELECT team, MAX(id) AS mid FROM shift_signout_events WHERE shift_id = ? GROUP BY team) t
                   ON t.team = s.team AND t.mid = s.id ORDER BY s.id ASC`,
                [shiftId]
            );
            return (Array.isArray(rows) ? rows : []).map(r => {
                let members = [];
                try { members = r.members ? JSON.parse(r.members) : []; } catch (e) {}
                return {
                    id: r.id,
                    team: r.team,
                    members,
                    notes: r.notes || '',
                    recordedById: r.actor_id,
                    recordedByName: r.actor_name,
                    createdAt: r.created_at
                };
            });
        } catch (err) {
            console.error('[Snapshot] Error getting signouts:', err.message);
            return [];
        }
    }

    // المرحلة ب: سجل أحداث TEAM_CHECKOUT الكامل (append-only — يشمل التصحيحات)
    async _getSignoutEvents(shiftId) {
        try {
            if (!this.db || !this.db.all) return [];
            const rows = await this.db.all(
                'SELECT * FROM shift_signout_events WHERE shift_id = ? ORDER BY id ASC',
                [shiftId]
            );
            return (Array.isArray(rows) ? rows : []).map(r => {
                let members = [];
                try { members = r.members ? JSON.parse(r.members) : []; } catch (e) {}
                return {
                    id: r.id,
                    eventType: r.event_type || 'TEAM_CHECKOUT',
                    team: r.team,
                    members,
                    notes: r.notes || '',
                    actorId: r.actor_id,
                    actorName: r.actor_name,
                    createdAt: r.created_at
                };
            });
        } catch (err) {
            console.error('[Snapshot] Error getting signout events:', err.message);
            return [];
        }
    }

    // Archive Contract §5: conversations explicitly linked via shift_id
    async _getConversations(shiftId) {
        try {
            if (!this.db || !this.db.all) return [];
            const convs = await this.db.all('SELECT * FROM chat_conversations WHERE shift_id = ?', [shiftId]);
            const out = [];
            for (const c of convs) {
                const messages = await this.db.all('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC', [c.id]);
                out.push({ ...c, messages });
            }
            return out;
        } catch (err) {
            console.error('[Snapshot] Error getting conversations:', err.message);
            return [];
        }
    }

    _calculateHash(snapshot) {
        const str = JSON.stringify(snapshot, Object.keys(snapshot).sort());
        return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
    }
}

// ============================================
// 3. INTEGRITY CHECKER — فحص سلامة البيانات
// ============================================
class ShiftIntegrityChecker {
    constructor(db, storagePath) {
        this.db = db;
        this.storagePath = storagePath;
    }

    /**
     * فحص شامل لسلامة الأرشيف بعد الحفظ
     */
    async verify(shiftId, snapshot) {
        const results = {
            shiftId,
            timestamp: new Date().toISOString(),
            passed: true,
            checks: {}
        };

        // 1. التحقق من تطابق hash
        results.checks.hashMatch = await this._verifyHash(shiftId, snapshot);

        // 2. التحقق من ارتباط البيانات
        results.checks.dataLinkage = await this._verifyDataLinkage(shiftId, snapshot);

        // 3. التحقق من سلامة الملفات
        results.checks.fileIntegrity = await this._verifyFileIntegrity(snapshot);

        // 4. التحقق من اكتمال البيانات
        results.checks.dataCompleteness = await this._verifyDataCompleteness(shiftId, snapshot);

        // 5. التحقق من عدم وجود بيانات مكررة
        results.checks.noDuplicates = await this._verifyNoDuplicates(shiftId);

        results.passed = Object.values(results.checks).every(c => c.passed);

        return results;
    }

    async _verifyHash(shiftId, snapshot) {
        try {
            const storedHash = snapshot.metadata.hash;
            const recalculated = this._recalculateHash(snapshot);
            const passed = storedHash === recalculated;
            return { passed, storedHash, recalculated };
        } catch (err) {
            return { passed: false, error: err.message };
        }
    }

    async _verifyDataLinkage(shiftId, snapshot) {
        try {
            const issues = [];

            // Check all reports link to valid shift
            if (snapshot.reports) {
                const reportKeys = Object.keys(snapshot.reports);
                if (reportKeys.length === 0 && snapshot.shift && snapshot.shift.totalReports > 0) {
                    issues.push('عدم تطابق: المناوبة تدعي وجود بلاغات لكن savedReports فارغ');
                }
            }

            // Check completions link to shift
            if (Array.isArray(snapshot.completions)) {
                const orphaned = snapshot.completions.filter(c => {
                    return c.shift_id !== shiftId && c.shiftId !== shiftId;
                });
                if (orphaned.length > 0) {
                    issues.push(`${orphaned.length} سجل تكميل غير مرتبط بالمناوبة الصحيحة`);
                }
            }

            return { passed: issues.length === 0, issues };
        } catch (err) {
            return { passed: false, error: err.message };
        }
    }

    async _verifyFileIntegrity(snapshot) {
        try {
            const issues = [];

            if (!Array.isArray(snapshot.files)) {
                return { passed: true, checked: 0 };
            }

            for (const file of snapshot.files) {
                const filePath = file.file_path || file.path;
                if (filePath) {
                    const exists = await fs.access(filePath)
                        .then(() => true).catch(() => false);
                    if (!exists) {
                        issues.push(`ملف مفقود: ${file.file_name || file.name}`);
                    }
                }
            }

            return {
                passed: issues.length === 0,
                checked: snapshot.files.length,
                missing: issues.length,
                issues
            };
        } catch (err) {
            return { passed: false, error: err.message };
        }
    }

    async _verifyDataCompleteness(shiftId, snapshot) {
        try {
            const requiredSections = ['shift', 'reports', 'completions', 'forms'];
            const missing = requiredSections.filter(s => !snapshot[s]);

            return {
                passed: missing.length === 0,
                missingSections: missing
            };
        } catch (err) {
            return { passed: false, error: err.message };
        }
    }

    async _verifyNoDuplicates(shiftId) {
        try {
            // Check for duplicate shift records
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(data);
            const duplicates = shifts.filter(s => s.id === shiftId);

            return {
                passed: duplicates.length <= 1,
                duplicateCount: duplicates.length > 1 ? duplicates.length - 1 : 0
            };
        } catch (err) {
            return { passed: true, error: err.message };
        }
    }

    _recalculateHash(snapshot) {
        const copy = JSON.parse(JSON.stringify(snapshot));
        copy.metadata = { ...copy.metadata, hash: null };
        const str = JSON.stringify(copy, Object.keys(copy).sort());
        return crypto.createHash('sha256').update(str).digest('hex').substring(0, 16);
    }
}

// ============================================
// 4. AUDIT LOGGER — سجل تدقيق الأرشفة
// ============================================
class ShiftAuditLogger {
    constructor(db, storagePath) {
        this.db = db;
        this.storagePath = storagePath;
        this.logPath = path.join(storagePath, 'archive-audit-log.json');
    }

    async log(operation, shiftId, details, user = null) {
        const entry = {
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            timestamp: new Date().toISOString(),
            operation,      // 'validate', 'snapshot', 'save', 'verify', 'rollback', 'archive'
            shiftId,
            details,
            user: user ? {
                id: user.id,
                name: user.name,
                role: user.role
            } : null
        };

        // Save to JSON log
        try {
            const existing = await fs.readFile(this.logPath, 'utf8').catch(() => '[]');
            const logs = JSON.parse(existing);
            logs.unshift(entry);
            if (logs.length > 1000) logs.pop(); // Keep last 1000
            await fs.writeFile(this.logPath, JSON.stringify(logs, null, 2));
        } catch (err) {
            console.error('[AuditLogger] Failed to write log:', err.message);
        }

        // Also save to DB if available
        try {
            if (this.db && this.db.ShiftAuditTrail && this.db.ShiftAuditTrail.create) {
                await this.db.ShiftAuditTrail.create({
                    shift_id: shiftId,
                    event_type: operation,
                    event_title: details.status || details.message || operation,
                    event_description: JSON.stringify(details),
                    event_data: JSON.stringify(details),
                    created_by: user ? user.id : 'system',
                    created_by_name: user ? user.name : 'النظام'
                });
            }
        } catch (err) {
            console.error('[AuditLogger] DB log failed:', err.message);
        }

        return entry;
    }

    async getLogs(shiftId, limit = 50) {
        try {
            const data = await fs.readFile(this.logPath, 'utf8').catch(() => '[]');
            const logs = JSON.parse(data);
            return logs
                .filter(l => !shiftId || l.shiftId === shiftId)
                .slice(0, limit);
        } catch {
            return [];
        }
    }
}

// ============================================
// 5. MAIN ENGINE — المحرك الرئيسي
// ============================================
class ShiftArchiveEngine {
    constructor(db, storagePath) {
        this.db = db;
        this.storagePath = storagePath;
        this.validator = new ShiftArchiveValidator(db, storagePath);
        this.snapshot = new ShiftArchiveSnapshot(db, storagePath);
        this.integrity = new ShiftIntegrityChecker(db, storagePath);
        this.audit = new ShiftAuditLogger(db, storagePath);
        this.state = 'idle'; // idle, validating, collecting, saving, verifying, completed, failed
        this.lastError = null;
    }

    /**
     * ╔═══════════════════════════════════════════════════════════════╗
     * ║  executeArchive — العملية الرئيسية للأرشفة                    ║
     * ║                                                               ║
     * ║  المراحل:                                                     ║
     * ║  1. VALIDATE  → التحقق من اكتمال البيانات                     ║
     * ║  2. COLLECT   → جمع البيانات في snapshot                      ║
     * ║  3. SAVE      → حفظ ذري (Atomic Save)                         ║
     * ║  4. VERIFY    → التحقق من السلامة                             ║
     * ║  5. UPDATE    → تحديث المؤشرات                                ║
     * ║                                                               ║
     * ║  إذا فشلت أي مرحلة → ROLLBACK كامل                           ║
     * ╚═══════════════════════════════════════════════════════════════╝
     */
    async executeArchive(shiftId, options = {}) {
        const startTime = Date.now();
        const result = {
            success: false,
            shiftId,
            startedAt: new Date().toISOString(),
            phases: {},
            duration: 0
        };

        try {
            // ═══════════════════════════════════════════
            // PHASE 1: VALIDATE
            // ═══════════════════════════════════════════
            this.state = 'validating';
            console.log(`[ArchiveEngine] Phase 1: Validating shift #${shiftId}...`);

            const validationResult = await this.validator.validate(shiftId, options);
            result.phases.validation = validationResult;

            await this.audit.log('validate', shiftId, {
                status: validationResult.isValid ? 'passed' : 'failed',
                errors: validationResult.errors,
                warnings: validationResult.warnings
            }, options.user);

            if (!validationResult.isValid && !options.force) {
                throw new ArchiveError(
                    'VALIDATION_FAILED',
                    'فشل التحقق من البيانات: ' + validationResult.errors.join('; '),
                    validationResult
                );
            }

            // ═══════════════════════════════════════════
            // PHASE 2: COLLECT SNAPSHOT
            // ═══════════════════════════════════════════
            this.state = 'collecting';
            console.log(`[ArchiveEngine] Phase 2: Creating snapshot for shift #${shiftId}...`);

            const snapshot = await this.snapshot.create(shiftId);
            result.phases.snapshot = {
                status: 'success',
                hash: snapshot.metadata.hash,
                sections: Object.keys(snapshot).filter(k => k !== 'metadata')
            };

            await this.audit.log('snapshot', shiftId, {
                status: 'success',
                hash: snapshot.metadata.hash
            }, options.user);

            // ═══════════════════════════════════════════
            // PHASE 3: ATOMIC SAVE
            // ═══════════════════════════════════════════
            this.state = 'saving';
            console.log(`[ArchiveEngine] Phase 3: Atomic save for shift #${shiftId}...`);

            const saveResult = await this._atomicSave(shiftId, snapshot, options);
            result.phases.save = saveResult;

            await this.audit.log('save', shiftId, {
                status: saveResult.success ? 'success' : 'failed',
                details: saveResult.details
            }, options.user);

            if (!saveResult.success) {
                throw new ArchiveError(
                    'SAVE_FAILED',
                    'فشل في حفظ الأرشيف: ' + (saveResult.error || 'Unknown error'),
                    saveResult
                );
            }

            // ═══════════════════════════════════════════
            // PHASE 4: VERIFY INTEGRITY
            // ═══════════════════════════════════════════
            this.state = 'verifying';
            console.log(`[ArchiveEngine] Phase 4: Verifying integrity for shift #${shiftId}...`);

            const integrityResult = await this.integrity.verify(shiftId, snapshot);
            result.phases.integrity = integrityResult;

            await this.audit.log('verify', shiftId, {
                status: integrityResult.passed ? 'passed' : 'failed',
                checks: integrityResult.checks
            }, options.user);

            if (!integrityResult.passed && !options.skipVerify) {
                // Rollback!
                await this._rollback(shiftId, saveResult);
                throw new ArchiveError(
                    'INTEGRITY_FAILED',
                    'فشل التحقق من سلامة الأرشيف. تم إلغاء العملية.',
                    integrityResult
                );
            }

            // ═══════════════════════════════════════════
            // PHASE 5: UPDATE KPIs
            // ═══════════════════════════════════════════
            this.state = 'updating';
            console.log(`[ArchiveEngine] Phase 5: Updating KPIs for shift #${shiftId}...`);

            const kpiResult = await this._updateKPIs(shiftId, snapshot, options);
            result.phases.kpis = kpiResult;

            await this.audit.log('archive', shiftId, {
                status: 'completed',
                hash: snapshot.metadata.hash,
                duration: Date.now() - startTime
            }, options.user);

            // ═══════════════════════════════════════════
            // COMPLETED
            // ═══════════════════════════════════════════
            this.state = 'completed';
            result.success = true;
            result.completedAt = new Date().toISOString();
            result.duration = Date.now() - startTime;
            result.snapshotHash = snapshot.metadata.hash;

            console.log(`[ArchiveEngine] ✅ Archive completed for shift #${shiftId} in ${result.duration}ms`);

            return result;

        } catch (err) {
            this.state = 'failed';
            this.lastError = err;
            result.success = false;
            result.error = {
                code: err.code || 'UNKNOWN',
                message: err.message,
                phase: this.state
            };
            result.duration = Date.now() - startTime;

            await this.audit.log('rollback', shiftId, {
                status: 'rolled_back',
                error: err.message,
                code: err.code || 'UNKNOWN'
            }, options.user);

            console.error(`[ArchiveEngine] ❌ Archive failed for shift #${shiftId}:`, err.message);

            return result;
        }
    }

    /**
     * الحفظ الذري (Atomic Save)
     * إما أن يحفظ الكل، أو لا يحفظ شيئاً
     */
    async _atomicSave(shiftId, snapshot, options) {
        const backupState = await this._createBackup(shiftId);
        const details = [];

        try {
            // 1. Save snapshot to archive file
            const archiveDir = path.join(this.storagePath, 'archives');
            await fs.mkdir(archiveDir, { recursive: true });

            const archivePath = path.join(archiveDir, `shift-${shiftId}-snapshot.json`);
            await fs.writeFile(archivePath, JSON.stringify(snapshot, null, 2));
            details.push({ step: 'snapshot_file', status: 'success', path: archivePath });

            // 2. Update shift record in JSON
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const shiftsData = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(shiftsData);
            const shiftIndex = shifts.findIndex(s => s.id === shiftId);

            if (shiftIndex !== -1) {
                shifts[shiftIndex] = {
                    ...shifts[shiftIndex],
                    ...snapshot.shift,
                    savedReports: snapshot.reports,
                    totalReports: Object.values(snapshot.reports).reduce(
                        (sum, r) => sum + (r.count || 0), 0
                    ),
                    status: 'archived',
                    archivedAt: new Date().toISOString(),
                    archiveVersion: '2.0',
                    snapshotHash: snapshot.metadata.hash,
                    completions: snapshot.completions,
                    forms: snapshot.forms,
                    files: snapshot.files,
                    timeline: snapshot.timeline,
                    auditTrail: snapshot.auditTrail,
                    metrics: snapshot.metrics,
                    notes: snapshot.notes,
                    events: snapshot.events,
                    absences: snapshot.absences,
                    operationalEvents: snapshot.operationalEvents
                };
                await fs.writeFile(shiftsPath, JSON.stringify(shifts, null, 2));
                details.push({ step: 'shift_json', status: 'success' });
            }

            // 3. Save to SQLite (primary)
            if (this.db) {
                try {
                    // Save shift
                    if (this.db.Shifts && this.db.Shifts.save) {
                        await this.db.Shifts.save({
                            ...snapshot.shift,
                            status: 'archived',
                            archived_at: new Date().toISOString(),
                            snapshot_hash: snapshot.metadata.hash
                        });
                        details.push({ step: 'sqlite_shift', status: 'success' });
                    }

                    // Save reports
                    if (this.db.Reports && this.db.Reports.saveBulk && Object.keys(snapshot.reports).length > 0) {
                        const reportsArray = Object.entries(snapshot.reports).map(([key, data]) => {
                            const [center, unit] = key.split('|');
                            return {
                                shift_id: shiftId,
                                center,
                                unit,
                                count: data.count || 0,
                                times: data.times || []
                            };
                        });
                        await this.db.Reports.saveBulk(reportsArray);
                        details.push({ step: 'sqlite_reports', status: 'success', count: reportsArray.length });
                    }

                    // Save completions
                    if (this.db.ShiftCompletions && this.db.ShiftCompletions.saveBulk && snapshot.completions.length > 0) {
                        await this.db.ShiftCompletions.saveBulk(
                            snapshot.completions.map(c => ({ ...c, shift_id: shiftId }))
                        );
                        details.push({ step: 'sqlite_completions', status: 'success', count: snapshot.completions.length });
                    }

                    // Save forms
                    if (this.db.ShiftForms && this.db.ShiftForms.saveBulk && snapshot.forms.length > 0) {
                        await this.db.ShiftForms.saveBulk(
                            snapshot.forms.map(f => ({ ...f, shift_id: shiftId }))
                        );
                        details.push({ step: 'sqlite_forms', status: 'success', count: snapshot.forms.length });
                    }

                    // Save metrics
                    if (this.db.ShiftMetrics && this.db.ShiftMetrics.save && snapshot.metrics) {
                        await this.db.ShiftMetrics.save({
                            ...snapshot.metrics,
                            shift_id: shiftId
                        });
                        details.push({ step: 'sqlite_metrics', status: 'success' });
                    }

                    // Archive slice: persist the seal blob itself (SQLite = source of truth)
                    // Without this the seal existed only as a file and the
                    // snapshot/integrity endpoints could never find it.
                    // snapshot_type respects the legacy CHECK constraint.
                    if (this.db.run) {
                        const snapType = ['auto', 'manual', 'pre_archive'].includes(options && options.snapshotType)
                            ? options.snapshotType : 'manual';
                        await this.db.run(
                            'INSERT INTO shift_snapshots (shift_id, snapshot_type, snapshot_data, snapshot_hash, created_at) VALUES (?, ?, ?, ?, ?)',
                            [shiftId, snapType, JSON.stringify(snapshot), snapshot.metadata.hash, new Date().toISOString()]
                        );
                        details.push({ step: 'sqlite_snapshot', status: 'success' });
                    }

                } catch (dbErr) {
                    details.push({ step: 'sqlite', status: 'failed', error: dbErr.message });
                    // If SQLite fails, rollback JSON changes
                    await this._restoreBackup(backupState);
                    throw new ArchiveError('DB_SAVE_FAILED', `فشل حفظ قاعدة البيانات: ${dbErr.message}`);
                }
            }

            return { success: true, details };

        } catch (err) {
            // Rollback on any error
            await this._restoreBackup(backupState);
            return {
                success: false,
                error: err.message,
                details
            };
        }
    }

    /**
     * إنشاء نسخة احتياطية قبل الحفظ
     */
    async _createBackup(shiftId) {
        try {
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(data);
            const shift = shifts.find(s => s.id === shiftId);

            return {
                shiftId,
                timestamp: new Date().toISOString(),
                shiftData: shift ? JSON.parse(JSON.stringify(shift)) : null,
                fullBackup: data
            };
        } catch (err) {
            console.error('[ArchiveEngine] Backup creation failed:', err.message);
            return null;
        }
    }

    /**
     * استعادة النسخة الاحتياطية (Rollback)
     */
    async _restoreBackup(backup) {
        if (!backup || !backup.fullBackup) {
            console.warn('[ArchiveEngine] No backup to restore');
            return;
        }

        try {
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            await fs.writeFile(shiftsPath, backup.fullBackup);
            console.log(`[ArchiveEngine] Rollback completed for shift #${backup.shiftId}`);
        } catch (err) {
            console.error('[ArchiveEngine] Rollback failed:', err.message);
        }
    }

    /**
     * Rollback كامل
     */
    async _rollback(shiftId, saveResult) {
        console.log(`[ArchiveEngine] Rolling back archive for shift #${shiftId}...`);

        try {
            // Remove archive file
            const archivePath = path.join(this.storagePath, 'archives', `shift-${shiftId}-snapshot.json`);
            await fs.unlink(archivePath).catch(() => {});

            // Restore shift status
            const shiftsPath = path.join(this.storagePath, 'shift-data.json');
            const data = await fs.readFile(shiftsPath, 'utf8').catch(() => '[]');
            const shifts = JSON.parse(data);
            const shiftIndex = shifts.findIndex(s => s.id === shiftId);

            if (shiftIndex !== -1) {
                delete shifts[shiftIndex].status;
                delete shifts[shiftIndex].archivedAt;
                delete shifts[shiftIndex].archiveVersion;
                delete shifts[shiftIndex].snapshotHash;
                await fs.writeFile(shiftsPath, JSON.stringify(shifts, null, 2));
            }

            console.log(`[ArchiveEngine] Rollback completed for shift #${shiftId}`);
        } catch (err) {
            console.error('[ArchiveEngine] Rollback error:', err.message);
        }
    }

    /**
     * تحديث المؤشرات (KPIs) بعد نجاح الأرشفة
     */
    async _updateKPIs(shiftId, snapshot, options) {
        const results = {
            daily: false,
            weekly: false,
            monthly: false
        };

        try {
            // المناوبات SQLite-المصدر تصل بشكل snake_case (shift_date) بينما
            // مناوبات JSON القديمة camelCase (shiftDate) — بدون هذا التوافق كان
            // shiftDate=null لكل مناوبة SQLite فتُتخطى مرحلة KPI بصمت (رُصد في
            // تحقق الشريحة 7 بعد فك حظر dbAvailable).
            const shiftDate = snapshot.shift ? (snapshot.shift.shiftDate || snapshot.shift.shift_date) : null;
            if (!shiftDate) return results;

            // Update daily KPI
            if (this.db && this.db.ShiftKpiDaily && this.db.ShiftKpiDaily.upsert) {
                await this.db.ShiftKpiDaily.upsert({
                    date: shiftDate,
                    shift_id: shiftId,
                    total_reports: snapshot.metrics ? snapshot.metrics.total_reports : 0,
                    completed_reports: snapshot.metrics ? snapshot.metrics.completed_reports : 0,
                    total_shifts: 1,
                    staff_count: snapshot.metrics ? snapshot.metrics.staff_count : 0,
                    completion_rate: snapshot.metrics ? snapshot.metrics.completion_rate : 0,
                    updated_at: new Date().toISOString()
                });
                results.daily = true;
            }

            // Calculate and update weekly KPI
            if (this.db && this.db.ShiftKpiWeekly && this.db.ShiftKpiWeekly.upsert) {
                const weekStart = this._getWeekStart(shiftDate);
                await this.db.ShiftKpiWeekly.upsert({
                    week_start: weekStart,
                    total_reports: snapshot.metrics ? snapshot.metrics.total_reports : 0,
                    total_shifts: 1,
                    avg_completion_rate: snapshot.metrics ? snapshot.metrics.completion_rate : 0,
                    updated_at: new Date().toISOString()
                });
                results.weekly = true;
            }

            // Calculate and update monthly KPI
            if (this.db && this.db.ShiftKpiMonthly && this.db.ShiftKpiMonthly.upsert) {
                const monthStart = shiftDate.substring(0, 7) + '-01';
                await this.db.ShiftKpiMonthly.upsert({
                    month_start: monthStart,
                    total_reports: snapshot.metrics ? snapshot.metrics.total_reports : 0,
                    total_shifts: 1,
                    avg_completion_rate: snapshot.metrics ? snapshot.metrics.completion_rate : 0,
                    updated_at: new Date().toISOString()
                });
                results.monthly = true;
            }

            return results;
        } catch (err) {
            console.error('[ArchiveEngine] KPI update error:', err.message);
            return { ...results, error: err.message };
        }
    }

    _getWeekStart(dateStr) {
        const d = new Date(dateStr);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        const start = new Date(d.setDate(diff));
        return start.toISOString().split('T')[0];
    }

    getState() {
        return {
            state: this.state,
            lastError: this.lastError ? this.lastError.message : null
        };
    }
}

// ============================================
// ArchiveError — خطأ مخصص لعمليات الأرشفة
// ============================================
class ArchiveError extends Error {
    constructor(code, message, details = null) {
        super(message);
        this.name = 'ArchiveError';
        this.code = code;
        this.details = details;
    }
}

// ============================================
// Exports
// ============================================
module.exports = {
    ShiftArchiveEngine,
    ShiftArchiveValidator,
    ShiftArchiveSnapshot,
    ShiftIntegrityChecker,
    ShiftAuditLogger,
    ArchiveError
};