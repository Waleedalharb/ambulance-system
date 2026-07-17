/**
 * FormsService — مالك النماذج الوحيد (Slice 6)
 * ═══════════════════════════════════════════════════════════
 * ONE service owns every operational form record; forms differ only by
 * form_type (بقرار المالك: دورة حياة واحدة، اختلاف في النوع فقط):
 *
 *   incident · senior_shift · e_case · escalation · daily_report · air_ambulance
 *
 * Store: the pre-existing shift_forms table (form_name = form_type,
 * form_id = legacy string id, form_data = full record JSON). Nothing wrote
 * to this table before — the legacy routes wrote JSON files, which is why
 * forms never appeared in archive snapshots. Every submit is now stamped
 * with the active shift id, so the archive engine's _getForms collector
 * captures them (archive gap fixed).
 *
 * Routes keep their exact legacy contracts (validation, field mapping,
 * response shapes, audit log). FormSubmitted fires AFTER the write; the
 * engine's broadcast subscriber maps it per form_type to the legacy WS
 * payloads (<type>_added / air_ambulance_saved).
 *
 * Documented exception: deletes have no catalogued domain event (the catalog
 * lists FormSubmitted only) — the legacy <type>_deleted broadcasts stay in
 * the routes pending the post-Slice-6 Domain Events Catalog review.
 */

const FORM_TYPES = ['incident', 'senior_shift', 'e_case', 'escalation', 'daily_report', 'air_ambulance'];

class FormsService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db              - db module (raw run/get/all)
     * @param {Object} deps.bus             - domain event bus (owned by the engine)
     * @param {Function} deps.getActiveShiftId - resolves the active shift id (or null)
     */
    constructor({ db, bus, getActiveShiftId }) {
        this.db = db;
        this.bus = bus;
        this.getActiveShiftId = getActiveShiftId;
    }

    _assertType(formType) {
        if (!FORM_TYPES.includes(formType)) throw new Error('Unknown form_type: ' + formType);
    }

    /** سجلات نوع معين (الأحدث أولاً — نفس ترتيب unshift القديم) */
    async list(formType) {
        this._assertType(formType);
        const rows = await this.db.all('SELECT form_data FROM shift_forms WHERE form_name = ? ORDER BY id DESC', [formType]);
        return rows.map(r => {
            try { return JSON.parse(r.form_data); } catch (e) { return {}; }
        });
    }

    /**
     * حفظ نموذج → FormSubmitted (بعد نجاح الحفظ)
     * يبني السجل بنفس الدلالات القديمة: id نصي من Date.now() + createdAt،
     * ويختم بالمناوبة النشطة (جديد — يصلح فجوة الأرشفة).
     */
    async submit(formType, payload, user) {
        this._assertType(formType);
        const shiftId = typeof this.getActiveShiftId === 'function' ? await this.getActiveShiftId() : null;
        const record = {
            id: Date.now().toString(),
            ...(payload || {}),
            createdAt: new Date().toISOString(),
            shiftId
        };
        await this.db.run(
            'INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (?, ?, ?, ?, ?)',
            [shiftId != null ? shiftId : null, record.id, formType, JSON.stringify(record), (user && (user.username || user.name)) || null]
        );
        this.bus.emit('FormSubmitted', { form_type: formType, form_id: record.id, shift_id: shiftId, record });
        return record;
    }

    /** حذف نموذج — بلا حدث domain (لا FormDeleted في الكتالوج بعد) */
    async remove(formType, recordId) {
        this._assertType(formType);
        await this.db.run('DELETE FROM shift_forms WHERE form_name = ? AND form_id = ?', [formType, String(recordId)]);
        return true;
    }

    /** مسح جميع سجلات نوع معين (clear-air-ambulance — admin/director فقط) */
    async clear(formType) {
        this._assertType(formType);
        await this.db.run('DELETE FROM shift_forms WHERE form_name = ?', [formType]);
        return true;
    }
}

FormsService.FORM_TYPES = FORM_TYPES;
module.exports = FormsService;
