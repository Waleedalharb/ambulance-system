/**
 * خدمة سير العمل الرسمي (Official Shift Workflow) — W-1
 * ═══════════════════════════════════════════════════════════
 * منظومة مستقلة بالكامل (بقرار المالك):
 *  - تقرأ من التكميل/المركبات قراءة فقط، ولا تكتب في أي جدول قائم إطلاقًا.
 *  - جداولها الثلاثة تنشئها بنفسها (IF NOT EXISTS) — لا تعديل على db.js.
 *  - النسخة المعتمدة مستقلة 100%: اللقطة الكاملة تُخزن مع النسخة (§7 من التصميم).
 *  - Append Only: لا حذف ولا تعديل لأي نسخة أو سجل تدقيق.
 *  - الختم سيرفري: المناوبة/الوقت/الفاعل من الخادم فقط (OV-S6-01).
 *
 * نطاق W-1: الجداول + اللقطة الكاملة + prepare/list/get/updateFields.
 * الاعتماد/القفل/المرجع/PDF/الإرسال = مراحل W-3/W-4/W-5 (مقيدة هنا برفض صريح).
 */

const SNAPSHOT_SCHEMA = 1;

// حقول المشرف الخمسة + خانة المراجعة — قائمة بيضاء صارمة
const FIELD_WHITELIST = ['summary', 'operationalNotes', 'keyEvents', 'issues', 'recommendations'];
// doc-v4 ⑨: الجهات الثلاث المعتمدة في الوثيقة والشاشة — + الأسماء القديمة
// للتوافق الخلفي (بوابة WF-1 ③ والبيانات المخزنة قبل doc-v4)
const REVIEWER_WHITELIST = ['قائد المنطقة', 'كبير المسعفين', 'الإداري المناوب',
                            'مشرف العمليات', 'مدير القطاع', 'المناوبة الإداري'];

// حالات النسخ المعتمدة في التصميم (§3.1)
const VERSION_STATUSES = ['draft', 'approved', 'sent', 'cancelled'];

// W-3: الاعتماد الرسمي — بصمة المحتوى + PDF + مرجع ذرّي
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { generateWorkflowPdf } = require('./workflow-pdf-service');

class WorkflowService {
    constructor({ storage, engine, staffingService, vehicleService }) {
        if (!storage) throw new Error('WorkflowService requires a StorageAdapter');
        if (!engine) throw new Error('WorkflowService requires an OperationsEngine');
        if (!staffingService) throw new Error('WorkflowService requires StaffingEventsService');
        if (!vehicleService) throw new Error('WorkflowService requires VehicleEventsService');
        this.storage = storage;
        this.engine = engine;
        this.staffing = staffingService;
        this.vehicles = vehicleService;
    }

    // ─── الجداول الثلاثة — ذاتية الإنشاء، لا مساس بأي جدول قائم ───
    async init() {
        await this.storage.exec(`
            CREATE TABLE IF NOT EXISTS shift_workflows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                shift_id INTEGER NOT NULL,
                version_no INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                ref_no TEXT UNIQUE,
                content_hash TEXT,
                snapshot_json TEXT NOT NULL,
                fields_json TEXT NOT NULL DEFAULT '{}',
                signature_meta TEXT,
                reissue_reason TEXT,
                pdf_path TEXT,
                send_status TEXT,
                recipients_json TEXT,
                created_by TEXT,
                created_by_name TEXT,
                created_at TEXT,
                approved_by TEXT,
                approved_by_name TEXT,
                approved_at TEXT,
                sent_at TEXT,
                acknowledged_by TEXT,
                acknowledged_at TEXT,
                UNIQUE(shift_id, version_no)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_one_draft
                ON shift_workflows(shift_id) WHERE status = 'draft';
            CREATE TABLE IF NOT EXISTS workflow_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workflow_id INTEGER NOT NULL,
                version_no INTEGER,
                action TEXT NOT NULL,
                actor_id TEXT,
                actor_name TEXT,
                at TEXT NOT NULL,
                details_json TEXT
            );
            CREATE TABLE IF NOT EXISTS workflow_counters (
                year INTEGER PRIMARY KEY,
                next_seq INTEGER NOT NULL DEFAULT 1
            );
        `);
    }

    // ═══════════════════════════════════════════════════════════
    // اللقطة الكاملة (§7) — استقلالية النسخة 100%
    // كل قسم في محاولة مستقلة: فشل قسم لا يُسقط اللقطة (يُوسم null + تحذير)
    // ═══════════════════════════════════════════════════════════
    async _buildSnapshot(shiftId) {
        const snapshot = {
            snapshotSchema: SNAPSHOT_SCHEMA,
            takenAt: new Date().toISOString(), // UTC تخزينًا — العرض بالسعودية (بند 16)
            shift: null,
            staffing: null,      // الفرق + الحالات + الكادر + الغياب/التأخير/الدعم/التكليف + ملخص القوى
            indicators: null,    // مؤشرات المناوبة
            vehicles: null,      // التعيينات + الحالات + الأرقام + غير المعيّنة
            completionNotes: '', // ملاحظات التكميل العامة
            supervisors: [],     // المشرفون المتفاعلون (فاعلو الأحداث)
            lateRecords: null    // سجلات التأخير (وصول/عدم وصول + المدة) — قد تغيب في اللقطات القديمة
        };

        // 1) هوية المناوبة (ختم سيرفري)
        try {
            const s = await this.engine.shifts.getShiftById(shiftId);
            if (s) {
                snapshot.shift = {
                    id: s.id, type: s.shift_type, date: s.shift_date,
                    status: s.status, startedAt: s.started_at || null,
                    endedAt: s.ended_at || null
                };
            }
        } catch (e) { console.warn('[Workflow] snapshot.shift failed:', e.message); }

        // 2) حالة القوى البشرية (قراءة فقط)
        try {
            const state = await this.staffing.getState(shiftId);
            snapshot.staffing = { teams: state.teams || {}, workforce: state.workforce || {} };
        } catch (e) { console.warn('[Workflow] snapshot.staffing failed:', e.message); }

        // 3) المؤشرات (قراءة فقط)
        try {
            snapshot.indicators = await this.staffing.getIndicators(shiftId);
        } catch (e) { console.warn('[Workflow] snapshot.indicators failed:', e.message); }

        // 4) لوحة المركبات (قراءة فقط)
        try {
            snapshot.vehicles = await this.vehicles.getBoard(shiftId);
        } catch (e) { console.warn('[Workflow] snapshot.vehicles failed:', e.message); }

        // 5) ملاحظات التكميل العامة (قراءة فقط)
        try {
            const latest = await this.engine.completions.getLatestByShiftId(shiftId);
            snapshot.completionNotes = (latest && latest.notes) || '';
        } catch (e) { console.warn('[Workflow] snapshot.notes failed:', e.message); }

        // 6) المشرفون المتفاعلون (أسماء فاعلي أحداث المناوبة — قراءة فقط)
        try {
            const tl = await this.staffing.getTimeline(shiftId);
            const names = new Set();
            ((tl && tl.events) || []).forEach(ev => { if (ev.actor_name) names.add(ev.actor_name); });
            snapshot.supervisors = [...names];
        } catch (e) { console.warn('[Workflow] snapshot.supervisors failed:', e.message); }

        // 7) سجلات التأخير (قراءة فقط — وصول/عدم وصول + المدة بالدقائق)
        try {
            const tl2 = await this.staffing.getTimeline(shiftId);
            snapshot.lateRecords = (tl2 && tl2.lateRecords) || null;
        } catch (e) { console.warn('[Workflow] snapshot.lateRecords failed:', e.message); }

        return snapshot;
    }

    // ═══════════════════════════════════════════════════════════
    // prepare: إنشاء مسودة بسحب اللقطة — أو إرجاع المسودة المفتوحة
    // الختم سيرفري: المناوبة النشطة هي المصدر (لا shift_id من العميل)
    // ═══════════════════════════════════════════════════════════
    async prepare({ actor }) {
        const active = await this.engine.shifts.getActiveShift();
        if (!active) {
            const err = new Error('لا توجد مناوبة نشطة — لا يمكن إعداد سير العمل');
            err.statusCode = 409;
            throw err;
        }
        const shiftId = active.id;

        // مسودة واحدة مفتوحة لكل مناوبة — idempotent (الحفظ التلقائي/الضغط المتكرر آمن)
        const existing = await this.storage.get(
            "SELECT * FROM shift_workflows WHERE shift_id = ? AND status = 'draft' ORDER BY version_no DESC LIMIT 1",
            [shiftId]
        );
        if (existing) {
            return { workflow: await this._withLiveSnapshot(existing), reused: true };
        }

        // العرض الحي: لا تُخزن أي بيانات تشغيلية في المسودة — اللقطة تُبنى
        // طازجة عند كل قراءة عبر _withLiveSnapshot. يُخزن '{}' فقط.
        const maxV = await this.storage.get(
            'SELECT MAX(version_no) AS v FROM shift_workflows WHERE shift_id = ?', [shiftId]
        );
        const versionNo = ((maxV && maxV.v) || 0) + 1;
        const now = new Date().toISOString();
        const fields = { summary: '', operationalNotes: '', keyEvents: '', issues: '', recommendations: '', reviewedBy: [] };

        const result = await this.storage.run(
            `INSERT INTO shift_workflows
             (shift_id, version_no, status, snapshot_json, fields_json, created_by, created_by_name, created_at, signature_meta)
             VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
            [shiftId, versionNo, '{}', JSON.stringify(fields),
             String(actor.id), actor.name || actor.username || '', now,
             JSON.stringify({ role: actor.role || null })]
        );

        const id = result.id; // غلاف db.js يرجع { id, changes }
        await this._audit(id, versionNo, 'create', actor, { shiftId, versionNo, snapshotSchema: SNAPSHOT_SCHEMA });

        const row = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        return { workflow: await this._withLiveSnapshot(row), reused: false };
    }

    // ═══════════════════════════════════════════════════════════
    // listByShift: نسخ المناوبة + حالة سير العمل المشتقة (§3.2)
    // ═══════════════════════════════════════════════════════════
    async listByShift(shiftId) {
        const rows = await this.storage.all(
            `SELECT id, shift_id, version_no, status, ref_no, reissue_reason,
                    created_by_name, created_at, approved_by_name, approved_at, sent_at, acknowledged_at
             FROM shift_workflows WHERE shift_id = ? ORDER BY version_no ASC`, [shiftId]
        );
        // العرض الحي: إدخالات المسودة تُرفق بلقطة طازجة (إضافي — بلا كسر للشكل)
        const versions = [];
        for (const r of rows) {
            if (r.status === 'draft') {
                const full = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [r.id]);
                const v = await this._withLiveSnapshot(full);
                versions.push(Object.assign({}, r, { snapshot: v.snapshot }));
            } else {
                versions.push(r);
            }
        }
        return { shiftId, versions, shiftStatus: this._deriveShiftStatus(rows) };
    }

    // حالة سير العمل على مستوى المناوبة — تُشتق من أحدث نسخة (لا تُخزن)
    _deriveShiftStatus(versions) {
        if (!versions || versions.length === 0) return 'بانتظار إعداد سير العمل';
        const latest = versions[versions.length - 1];
        switch (latest.status) {
            case 'draft': return 'تم إعداده';
            case 'approved': return 'تم اعتماده';
            case 'sent': return latest.acknowledged_at ? 'تم استلامه' : 'تم إرساله';
            case 'cancelled': return 'بانتظار إعداد سير العمل';
            default: return 'بانتظار إعداد سير العمل';
        }
    }

    // ═══════════════════════════════════════════════════════════
    // getVersion: المسودة بلقطة حية طازجة؛ المقفلة بلقطتها المجمدة
    // ═══════════════════════════════════════════════════════════
    async getVersion(id) {
        const row = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        if (!row) {
            const err = new Error('نسخة سير العمل غير موجودة');
            err.statusCode = 404;
            throw err;
        }
        return { workflow: await this._withLiveSnapshot(row) };
    }

    // ═══════════════════════════════════════════════════════════
    // updateFields: حفظ حقول المشرف — مسودة فقط، قائمة بيضاء صارمة
    // ═══════════════════════════════════════════════════════════
    async updateFields(id, fields, { actor }) {
        const row = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        if (!row) {
            const err = new Error('نسخة سير العمل غير موجودة');
            err.statusCode = 404;
            throw err;
        }
        if (row.status !== 'draft') {
            const err = new Error('النسخة مقفلة — لا يمكن تحريرها');
            err.statusCode = 403;
            throw err;
        }

        const current = JSON.parse(row.fields_json || '{}');
        const next = { ...current };
        const changed = [];

        for (const key of FIELD_WHITELIST) {
            if (key in (fields || {})) {
                const val = String(fields[key] == null ? '' : fields[key]);
                if (val !== (current[key] || '')) { next[key] = val; changed.push(key); }
            }
        }
        if (fields && Array.isArray(fields.reviewedBy)) {
            const clean = fields.reviewedBy.filter(r => REVIEWER_WHITELIST.includes(r));
            if (JSON.stringify(clean) !== JSON.stringify(current.reviewedBy || [])) {
                next.reviewedBy = clean; changed.push('reviewedBy');
            }
        }

        if (changed.length > 0) {
            await this.storage.run('UPDATE shift_workflows SET fields_json = ? WHERE id = ?',
                [JSON.stringify(next), id]);
            await this._audit(id, row.version_no, 'edit_fields', actor, { changed });
        }

        const updated = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        return { workflow: await this._withLiveSnapshot(updated), changed };
    }

    // ═══════════════════════════════════════════════════════════
    // approve (W-3): الاعتماد الرسمي — قفل + مرجع ذرّي + بصمة + PDF
    // ترتيب إلزامي: PDF أولًا؛ فشله = لا اعتماد إطلاقًا. فشل UPDATE
    // بعد إنشاء الملف = حذف الملف اليتيم.
    // ═══════════════════════════════════════════════════════════
    async approve(id, { actor }) {
        const row = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        if (!row) {
            const err = new Error('نسخة سير العمل غير موجودة');
            err.statusCode = 404;
            throw err;
        }
        if (row.status !== 'draft') {
            const err = new Error('لا يمكن الاعتماد — النسخة ليست مسودة');
            err.statusCode = 409;
            throw err;
        }

        // بوابة سيرفرية: صفر فرق بانتظار — من المصدر المركزي الحي نفسه
        // الذي تعتمد عليه شاشة التكميل (StaffingEventsService.getState عبر
        // _buildSnapshot). ممنوع قراءة Pending من اللقطة المجمدة: قد تكون
        // أُعدّت قبل اكتمال التكميل فتظهر تعارضًا زائفًا (باقي 8 بينما
        // العداد الحي 0). الاعتماد يبني لقطة نهائية طازجة ويقفل عليها.
        const snapshot = await this._buildSnapshot(row.shift_id);
        const pending = snapshot && snapshot.staffing && snapshot.staffing.workforce
            ? snapshot.staffing.workforce.pendingTeams : null;
        if (pending !== 0) {
            const err = new Error(pending == null
                ? 'لا يمكن الاعتماد — ملخص القوى غير مكتمل في اللقطة'
                : 'لا يمكن الاعتماد — باقي ' + pending + ' فرق لم تُكمّل');
            err.statusCode = 409;
            throw err;
        }

        const now = new Date().toISOString();
        // سنة المرجع من تاريخ المناوبة (الختم السيرفري)، مع سقوط للسنة الحالية
        const shiftDate = snapshot && snapshot.shift && snapshot.shift.date;
        const year = /^\d{4}/.test(shiftDate || '') ? parseInt(shiftDate.slice(0, 4), 10) : new Date().getFullYear();

        // الرقم المرجعي الذرّي — يُستهلك ولا يتكرر أبدًا حتى عند فشل لاحق
        await this.storage.run('INSERT OR IGNORE INTO workflow_counters (year, next_seq) VALUES (?, 1)', [year]);
        const counterRow = await this.storage.get(
            'UPDATE workflow_counters SET next_seq = next_seq + 1 WHERE year = ? RETURNING next_seq', [year]);
        const seq = counterRow.next_seq - 1;
        const refNo = 'SRCA-SR-OPS-' + year + '-' + String(seq).padStart(6, '0');

        const approverName = (actor && (actor.name || actor.username)) || '';
        const contentHash = crypto.createHash('sha256')
            .update(JSON.stringify(snapshot) + '|' + approverName + '|' + now + '|' + refNo)
            .digest('hex');

        // توليد PDF قبل UPDATE الصف — فشله يلغي الاعتماد كله
        // (اللقطة الطازجة تُمرَّر للـPDF وتُخزَّن مع القفل حتى تكون
        //  الوثيقة المعتمدة مطابقة للحقيقة النهائية لحظة الاعتماد)
        const freshSnapshotJson = JSON.stringify(snapshot);
        const versionForPdf = this._rowToVersion(Object.assign({}, row, {
            status: 'approved', ref_no: refNo, content_hash: contentHash,
            approved_by: actor ? String(actor.id) : null,
            approved_by_name: approverName, approved_at: now,
            snapshot_json: freshSnapshotJson
        }));
        const pdf = await generateWorkflowPdf(versionForPdf);

        try {
            await this.storage.run(
                `UPDATE shift_workflows
                 SET status = 'approved', ref_no = ?, content_hash = ?, pdf_path = ?,
                     approved_by = ?, approved_by_name = ?, approved_at = ?,
                     snapshot_json = ?
                 WHERE id = ?`,
                [refNo, contentHash, pdf.relPath,
                 actor ? String(actor.id) : null, approverName, now,
                 freshSnapshotJson, id]
            );
        } catch (e) {
            try { if (pdf.absPath && fs.existsSync(pdf.absPath)) fs.unlinkSync(pdf.absPath); } catch (_) {}
            throw e;
        }

        await this._audit(id, row.version_no, 'approve', actor, { refNo, contentHash });
        await this._audit(id, row.version_no, 'pdf', actor, { pdfPath: pdf.relPath });

        const updatedRow = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        return { workflow: this._rowToVersion(updatedRow) };
    }

    // ═══════════════════════════════════════════════════════════
    // reissue (W-3): إعادة إصدار من نسخة معتمدة — مسودة حية جديدة +
    // نسخ حقول المشرف. المعتمدة القديمة تبقى كما هي تمامًا.
    // ═══════════════════════════════════════════════════════════
    async reissue(id, reason, { actor }) {
        if (!reason || !String(reason).trim()) {
            const err = new Error('سبب إعادة الإصدار إلزامي');
            err.statusCode = 400;
            throw err;
        }
        const row = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [id]);
        if (!row) {
            const err = new Error('نسخة سير العمل غير موجودة');
            err.statusCode = 404;
            throw err;
        }
        if (row.status !== 'approved') {
            const err = new Error('إعادة الإصدار متاحة للنسخ المعتمدة فقط');
            err.statusCode = 409;
            throw err;
        }

        const shiftId = row.shift_id;
        let oldFields = {};
        try { oldFields = JSON.parse(row.fields_json || '{}'); } catch (e) {}

        const maxV = await this.storage.get(
            'SELECT MAX(version_no) AS v FROM shift_workflows WHERE shift_id = ?', [shiftId]);
        const versionNo = ((maxV && maxV.v) || 0) + 1;
        const now = new Date().toISOString();

        // العرض الحي: snapshot_json = '{}' — اللقطة تُبنى طازجة عند كل قراءة
        const result = await this.storage.run(
            `INSERT INTO shift_workflows
             (shift_id, version_no, status, snapshot_json, fields_json, reissue_reason,
              created_by, created_by_name, created_at, signature_meta)
             VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
            [shiftId, versionNo, '{}', JSON.stringify(oldFields),
             String(reason).trim(), String(actor.id), actor.name || actor.username || '', now,
             JSON.stringify({ role: actor.role || null })]
        );

        const newId = result.id;
        await this._audit(newId, versionNo, 'reissue', actor,
            { fromVersionId: id, fromVersionNo: row.version_no, reason: String(reason).trim() });

        const newRow = await this.storage.get('SELECT * FROM shift_workflows WHERE id = ?', [newId]);
        return { workflow: await this._withLiveSnapshot(newRow) };
    }

    // معلومات ملف PDF للمسار (يتحقق المسار من الحالة والوجود)
    async getPdfInfo(id) {
        const row = await this.storage.get(
            'SELECT id, status, pdf_path, ref_no FROM shift_workflows WHERE id = ?', [id]);
        if (!row) {
            const err = new Error('نسخة سير العمل غير موجودة');
            err.statusCode = 404;
            throw err;
        }
        return { id: row.id, status: row.status, pdfPath: row.pdf_path || null, refNo: row.ref_no || null };
    }

    // ─── سجل التدقيق — Append Only، لا UPDATE/DELETE له إطلاقًا ───
    async _audit(workflowId, versionNo, action, actor, details) {
        await this.storage.run(
            `INSERT INTO workflow_audit_log (workflow_id, version_no, action, actor_id, actor_name, at, details_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [workflowId, versionNo, action, String((actor && actor.id) || 'system'),
             (actor && (actor.name || actor.username)) || 'system',
             new Date().toISOString(), JSON.stringify(details || {})]
        );
    }

    async getAudit(id) {
        return this.storage.all(
            'SELECT * FROM workflow_audit_log WHERE workflow_id = ? ORDER BY id ASC', [id]
        );
    }

    // ─── العرض الحي (Live Draft): المسودة لا تخزّن بيانات تشغيلية ───
    // إن كانت النسخة مسودة تُبنى لقطة طازجة من المصدر المركزي في كل قراءة
    // (بلا أي كتابة في قاعدة البيانات)؛ النسخ المقفلة تبقى مجمدة بلقطتها
    // المخزنة إلى الأبد. التغليف للقراءة فقط — مسارات الكتابة تستخدم
    // _rowToVersion المتزامن مباشرة.
    async _withLiveSnapshot(row) {
        const version = this._rowToVersion(row);
        if (row.status === 'draft') {
            version.snapshot = await this._buildSnapshot(row.shift_id);
        }
        return version;
    }

    // ─── تحويل الصف لكائن النسخة (فك JSON بأمان) ───
    _rowToVersion(row) {
        let snapshot = {}, fields = {}, sigMeta = {};
        try { snapshot = JSON.parse(row.snapshot_json || '{}'); } catch (e) {}
        try { fields = JSON.parse(row.fields_json || '{}'); } catch (e) {}
        try { sigMeta = JSON.parse(row.signature_meta || '{}'); } catch (e) {}
        return {
            id: row.id,
            shiftId: row.shift_id,
            versionNo: row.version_no,
            status: row.status,
            refNo: row.ref_no || null,
            contentHash: row.content_hash || null,
            reissueReason: row.reissue_reason || null,
            sendStatus: row.send_status || null,
            pdfPath: row.pdf_path || null,
            snapshot,
            fields,
            createdBy: row.created_by_name || row.created_by || null,
            createdById: row.created_by || null,
            createdByRole: sigMeta.role || null,
            createdAt: row.created_at || null,
            approvedBy: row.approved_by_name || null,
            approvedAt: row.approved_at || null,
            sentAt: row.sent_at || null,
            acknowledgedAt: row.acknowledged_at || null
        };
    }
}

module.exports = WorkflowService;
