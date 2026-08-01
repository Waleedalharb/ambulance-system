/**
 * PositioningService — مالك التمركزات الوحيد (Slice 4 + شريحة F1)
 * ═══════════════════════════════════════════════════════════
 * Single writer for peak_plans (خطط التمركز): list / create / update / remove.
 * Routes delegate and keep their exact legacy response shapes; domain events
 * fire AFTER the write succeeds, and the engine's broadcast subscriber maps
 * them to the legacy WS payloads (peak_plan_added / peak_plan_updated /
 * peak_plan_deleted).
 *
 * The store stays the unified peak_plans table (archive slice): rows keyed by
 * their string ids, shift_id stamped from the active shift on create, and the
 * archive engine's _getPositioning collector reads the same table — unchanged.
 *
 * F1 (frontend-integration):
 *  - create يخزّن حمولة الواجهة كاملة كما هي (تصحيح عقد — بلا تفسير): spread
 *    أولاً ثم الحقول المملوكة للخادم (id / status / createdAt / createdBy)
 *    أخيراً حتى لا تتجاوزها الحمولة.
 *  - list تكنس الخطط المنتهية قبل القراءة بنفس منطق الواجهة القديم
 *    cleanupPeakPlans حرفياً (status === 'active' + endTime منقضٍ ← status =
 *    'completed')، وتُطلق PositioningUpdated بعد نجاح كل UPDATE — انتهاء
 *    صلاحية الخطط أصبح داخل الخدمة (بلا منطق تشغيلي في الواجهة).
 *
 * PositioningUpdated (Catalog D-4) مُفعَّل: يُطلق من update ومن كنس list،
 * والمحرك يبثه كـ peak_plan_updated.
 *
 * Documented exception (DOMAIN-MODEL §10.2 د):
 *  - remove emits PositioningEnded only when a row actually existed. The
 *    legacy route broadcast even for no-op deletes; events are facts, and the
 *    frontend now reloads via loadPeakPlans on peak_plan_deleted, so staying
 *    silent on no-op deletes remains the correct, side-effect-free choice.
 */

class PositioningService {
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

    _rowToJson(row) {
        let data = {};
        try { data = row.data ? JSON.parse(row.data) : {}; } catch (e) {}
        return { ...data, id: row.id, shiftId: row.shift_id };
    }

    // ── جولة Operational Workflow Completion (المرحلة أ): سجل أحداث append-only ──
    // كل تغيير واقٍع على خطة تمركز يُختم في positioning_events مربوطًا بالمناوبة
    // (الختم يتم بعد نجاح الكتابة — الحدث حقيقة لا نية). فشل التسجيل لا يكسر
    // العملية الأصلية: يُسجَّل تحذيرًا فقط (السجل تدقيقي معزول عن المسار التشغيلي).
    async _recordEvent(planId, shiftId, eventType, changedFields, payload, user) {
        try {
            await this.db.run(
                'INSERT INTO positioning_events (shift_id, plan_id, event_type, changed_fields, payload, actor_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    shiftId != null ? shiftId : null,
                    String(planId),
                    eventType,
                    changedFields ? JSON.stringify(changedFields) : null,
                    JSON.stringify(payload || {}),
                    user && user.id != null ? String(user.id) : null,
                    (user && (user.name || user.username)) || 'system',
                    new Date().toISOString()
                ]
            );
        } catch (err) {
            console.warn('[Positioning] event log failed (' + eventType + '):', err.message);
        }
    }

    /** مقارنة حقول الخطة قبل/بعد — يعيد {field: [from, to]} للحقول المتغيرة فقط */
    _diffFields(before, after) {
        const changed = {};
        const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
        for (const k of keys) {
            if (k === 'id' || k === 'shiftId') continue;
            const a = before ? before[k] : undefined;
            const b = after ? after[k] : undefined;
            if (JSON.stringify(a === undefined ? null : a) !== JSON.stringify(b === undefined ? null : b)) {
                changed[k] = [a === undefined ? null : a, b === undefined ? null : b];
            }
        }
        return Object.keys(changed).length ? changed : null;
    }

    /**
     * قائمة خطط التمركز (نفس ترتيب المسار القديم).
     * قبل القراءة: كنس الخطط المنتهية — نسخة حرفية من cleanupPeakPlans في الواجهة:
     *   if (p.status === 'active' && p.endTime && new Date(p.endTime) < now) p.status = 'completed';
     * (endTime بصيغة YYYY-MM-DDTHH:MM — new Date في Node يفسّرها بالتوقيت المحلي
     * للخادم مثل المتصفح سابقاً على نفس المنطقة الزمنية)
     */
    async list() {
        const now = new Date();
        const candidates = await this.db.all('SELECT * FROM peak_plans');
        for (const row of candidates) {
            const plan = this._rowToJson(row);
            if (plan.status === 'active' && plan.endTime && new Date(plan.endTime) < now) {
                const before = { ...plan };
                plan.status = 'completed';
                await this.db.run('UPDATE peak_plans SET data = ? WHERE id = ?', [JSON.stringify(plan), row.id]);
                // الحدث حقيقة واقعة — يُطلق بعد نجاح التحديث، وكل خطة تُكنس مرة واحدة فقط
                this.bus.emit('PositioningUpdated', { plan_id: row.id, shift_id: row.shift_id, plan });
                // المرحلة أ: الكنس حدث موثق أيضًا (الفاعل system — بلا مستخدم بشري)
                await this._recordEvent(row.id, row.shift_id, 'swept', this._diffFields(before, plan), plan, null);
            }
        }
        const rows = await this.db.all('SELECT * FROM peak_plans ORDER BY created_at DESC, id DESC');
        return rows.map(r => this._rowToJson(r));
    }

    /** إنشاء خطة تمركز → PositioningStarted (بعد نجاح الحفظ) — يخزّن حمولة الواجهة كاملة */
    async create(payload, user) {
        const plan = {
            ...(payload || {}),
            id: Date.now().toString(),
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: (user && user.username) || 'unknown'
        };
        const shiftId = typeof this.getActiveShiftId === 'function' ? await this.getActiveShiftId() : null;
        await this.db.run('INSERT INTO peak_plans (id, shift_id, data) VALUES (?, ?, ?)',
            [plan.id, shiftId != null ? shiftId : null, JSON.stringify(plan)]);
        this.bus.emit('PositioningStarted', { plan_id: plan.id, shift_id: shiftId, title: plan.title, plan });
        // المرحلة أ: ختم حدث الإنشاء في سجل المناوبة
        await this._recordEvent(plan.id, shiftId, 'created', null, plan, user);
        return plan;
    }

    /** تعديل خطة → PositioningUpdated (Catalog D-4 — مُفعَّل) */
    async update(id, updates, user) {
        const row = await this.db.get('SELECT * FROM peak_plans WHERE id = ?', [id]);
        if (!row) return null;
        const before = this._rowToJson(row);
        const plan = { ...before, ...updates, id: row.id };
        // المرحلة أ: ختم shift_id على الخطط اليتيمة (shift_id=null أُنشئت بلا مناوبة
        // نشطة) عند أول تعديل أثناء مناوبة نشطة — وإلا ضاعت من سجل المناوبة ولقطتها.
        let shiftId = row.shift_id;
        if (shiftId == null && typeof this.getActiveShiftId === 'function') {
            const activeId = await this.getActiveShiftId();
            if (activeId != null) {
                shiftId = activeId;
                plan.shiftId = activeId;
                await this.db.run('UPDATE peak_plans SET shift_id = ? WHERE id = ?', [activeId, id]);
            }
        }
        await this.db.run('UPDATE peak_plans SET data = ? WHERE id = ?', [JSON.stringify(plan), id]);
        this.bus.emit('PositioningUpdated', { plan_id: row.id, shift_id: shiftId, plan });
        // المرحلة أ: ختم حدث التعديل مع ما تغيّر فعلًا (before/after لكل حقل)
        await this._recordEvent(row.id, shiftId, 'updated', this._diffFields(before, plan), plan, user || null);
        return plan;
    }

    /** إنهاء/حذف تمركز → PositioningEnded فقط إذا وُجدت الخطة فعلاً */
    async remove(id, user) {
        const row = await this.db.get('SELECT * FROM peak_plans WHERE id = ?', [id]);
        await this.db.run('DELETE FROM peak_plans WHERE id = ?', [id]);
        if (row) {
            this.bus.emit('PositioningEnded', { plan_id: id, shift_id: row.shift_id });
            // المرحلة أ: الحذف إنهاء موثق — الحمولة الأخيرة تُحفظ في السجل قبل فقدها
            await this._recordEvent(id, row.shift_id, 'ended', null, this._rowToJson(row), user || null);
        }
        return true;
    }
}

module.exports = PositioningService;
