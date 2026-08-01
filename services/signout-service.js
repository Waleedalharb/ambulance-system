/**
 * SignoutService — مالك «تسجيل خروج المناوبة» الوحيد (المرحلة ب، التوسعة ①)
 * ═══════════════════════════════════════════════════════════
 * TEAM_CHECKOUT حدث تشغيلي في سجل shift_signout_events (append-only — نمط
 * positioning_events نفسه لأن operational_events مقيّد بـ CHECK(domain)).
 * الكتابة إلحاق فقط؛ الحالة الحالية للفرقة = أحدث حدث لها (عرض مشتق من السجل
 * نفسه — لا جدول حالة ولا مصدر موازٍ)، وكل صفحة تقرأ من هذا السجل.
 *
 * الاقتراح التلقائي (suggest) — سلسلة أولويات موثقة من وثيقة المرحلة ب:
 *   1. آخر حدث تسجيل خروج مسجل لهذه الفرقة (أي مناوبة سابقة — source: signout)
 *   2. طاقم الفرقة الفعلي في المناوبة الحالية المشتق سيرفريًا من الأحداث
 *      (source: current_shift) — staffingEventsService.getState: المجدولون بعد
 *      تطبيق الغياب/التكليف/الدعم، وهذه هي «المناوبة الفعلية»
 *   3. آخر مناوبة سابقة لها طاقم فعلي مشتق للفرقة (source: previous_shift)
 * وكلها لا تلمس الجدول الشهري الخام ولا HR — الاشتقاق السيرفري نفسه المستخدم
 * في صفحة التكميل ولوحة المؤشرات.
 *
 * record: إلحاق حدث TEAM_CHECKOUT مختوم بالمناوبة/النوع/التاريخ/المستخدم/الوقت
 * (التخزين ISO والعرض Asia/Riyadh في الواجهات). التصحيح = حدث جديد يبقي الأثر.
 * يُطلق ShiftSignoutRecorded بعد نجاح الكتابة (المحرك يبثه shift_signout_recorded
 * لتحديث الصفحات المفتوحة لحظيًا).
 *
 * تعديل «الآن فهمت قصدك 100%» (تفويض المستخدم): تسجيل الخروج سجل تشغيلي
 * اختياري حسب الحاجة — تُسجَّل بعض الفرق فقط. أُزيل منطق حالة التغطية
 * (status: مقام الفرق النشطة/نسبة/فرق ناقصة/حالات none-partial-complete)
 * بالكامل — لا إلزام ولا تحذير نقص ولا بوابة اعتماد. البنية (السجل
 * append-only + العرض المشتق + الاقتراح) تبقى كما هي.
 */

class SignoutService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db              - db module (raw run/get/all)
     * @param {Object} deps.bus             - domain event bus (owned by the engine)
     * @param {Function} deps.getActiveShiftId - resolves the active shift id (or null)
     * @param {Object} deps.staffingService - StaffingEventsService (getState → teams[name].members)
     * @param {Object} deps.storage         - StorageAdapter (getShiftById / shifts listing)
     */
    constructor({ db, bus, getActiveShiftId, staffingService, storage }) {
        this.db = db;
        this.bus = bus;
        this.getActiveShiftId = getActiveShiftId;
        this.staffingService = staffingService;
        this.storage = storage;
    }

    _rowToJson(row) {
        let members = [];
        try { members = row.members ? JSON.parse(row.members) : []; } catch (e) {}
        return {
            id: row.id,
            shiftId: row.shift_id,
            shiftDate: row.shift_date || null,
            shiftType: row.shift_type,
            eventType: row.event_type || 'TEAM_CHECKOUT',
            team: row.team,
            members: Array.isArray(members) ? members : [],
            notes: row.notes || '',
            recordedById: row.actor_id,
            recordedByName: row.actor_name,
            createdAt: row.created_at
        };
    }

    /** أسماء طاقم الفرقة الفعلي المشتق سيرفريًا لمناوبة معينة ([] عند الغياب) */
    async _derivedMembers(team, shiftId) {
        try {
            if (!this.staffingService || !shiftId) return [];
            const state = await this.staffingService.getState(shiftId);
            const t = state && state.teams ? state.teams[team] : null;
            if (!t || !Array.isArray(t.members)) return [];
            return t.members.map(m => m && m.name).filter(Boolean);
        } catch (e) { return []; }
    }

    /**
     * اقتراح أسماء أفراد الفرقة — السلسلة الموثقة أعلاه.
     * @returns {{members: string[], source: 'signout'|'current_shift'|'previous_shift'|null,
     *            sourceShiftId: number|null, sourceLabel: string}}
     */
    async suggest(team, currentShiftId) {
        const empty = { members: [], source: null, sourceShiftId: null, sourceLabel: '' };
        if (!team) return empty;

        // 1. آخر حدث تسجيل خروج للفرقة (سجل المنصة نفسه — أصدق مصدر تراكمي)
        try {
            const row = await this.db.get(
                'SELECT * FROM shift_signout_events WHERE team = ? ORDER BY id DESC LIMIT 1',
                [team]
            );
            if (row) {
                const s = this._rowToJson(row);
                if (s.members.length) {
                    return { members: s.members, source: 'signout', sourceShiftId: s.shiftId, sourceLabel: 'آخر تسجيل خروج (مناوبة #' + s.shiftId + ')' };
                }
            }
        } catch (e) { /* الجدول قد يسبق تهيئته في بيئة اختبار — نكمل السلسلة */ }

        // 2. الطاقم الفعلي للمناوبة الحالية (مشتق سيرفريًا من الأحداث)
        const cur = await this._derivedMembers(team, currentShiftId);
        if (cur.length) {
            return { members: cur, source: 'current_shift', sourceShiftId: currentShiftId || null, sourceLabel: 'طاقم المناوبة الحالية الفعلي' };
        }

        // 3. آخر مناوبة فعلية سابقة لها طاقم مشتق للفرقة (أحدث 10 مناوبات)
        try {
            const rows = await this.db.all(
                'SELECT id FROM shifts WHERE id != ? ORDER BY id DESC LIMIT 10',
                [currentShiftId || -1]
            );
            for (const r of (Array.isArray(rows) ? rows : [])) {
                const prev = await this._derivedMembers(team, r.id);
                if (prev.length) {
                    return { members: prev, source: 'previous_shift', sourceShiftId: r.id, sourceLabel: 'آخر مناوبة فعلية (#' + r.id + ')' };
                }
            }
        } catch (e) { /* صمت — الاقتراح الفارغ حالة صحيحة */ }

        return empty;
    }

    /**
     * تسجيل خروج فرقة = إلحاق حدث TEAM_CHECKOUT مختوم بالمناوبة والمستخدم
     * (append-only — التصحيح حدث جديد لا تعديل). يُطلق ShiftSignoutRecorded
     * بعد نجاح الكتابة (الحدث حقيقة واقعة).
     */
    async record(team, members, notes, user) {
        if (!team) return { success: false, error: 'الفرقة مطلوبة' };
        const cleanMembers = (Array.isArray(members) ? members : [])
            .map(n => String(n || '').trim()).filter(Boolean);
        if (!cleanMembers.length) return { success: false, error: 'أسماء أفراد الفرقة مطلوبة' };

        const shiftId = typeof this.getActiveShiftId === 'function' ? await this.getActiveShiftId() : null;
        if (shiftId == null) return { success: false, error: 'لا توجد مناوبة نشطة للتسجيل فيها' };

        let shiftType = null, shiftDate = null;
        try {
            const shift = this.storage && this.storage.getShiftById ? await this.storage.getShiftById(shiftId) : null;
            shiftType = shift ? (shift.shift_type || shift.shiftType || null) : null;
            shiftDate = shift ? (shift.shift_date || shift.shiftDate || null) : null;
        } catch (e) { /* النوع/التاريخ يبقيان null — لا كسر للتسجيل */ }

        const now = new Date().toISOString();
        const actorId = user && user.id != null ? String(user.id) : null;
        const actorName = (user && (user.name || user.username)) || 'unknown';

        // إلحاق صِرف — لا UPDATE ولا DELETE على السجل إطلاقًا
        const ins = await this.db.run(
            `INSERT INTO shift_signout_events (shift_id, shift_date, shift_type, event_type, team, members, notes, actor_id, actor_name, created_at)
             VALUES (?, ?, ?, 'TEAM_CHECKOUT', ?, ?, ?, ?, ?, ?)`,
            [shiftId, shiftDate, shiftType, team, JSON.stringify(cleanMembers), notes || '', actorId, actorName, now]
        );

        const row = await this.db.get('SELECT * FROM shift_signout_events WHERE id = ?', [ins && ins.id]);
        const saved = this._rowToJson(row);
        this.bus.emit('ShiftSignoutRecorded', { shift_id: shiftId, team, signout: saved });
        return { success: true, signout: saved };
    }

    /**
     * الحالة الحالية لتسجيلات مناوبة = أحدث حدث لكل فرقة (عرض مشتق من السجل —
     * تفاصيل/أرشيف حي/تصدير). سجل الأحداث الكامل عبر historyByShift.
     */
    async listByShift(shiftId) {
        try {
            const rows = await this.db.all(
                `SELECT s.* FROM shift_signout_events s
                 JOIN (SELECT team, MAX(id) AS mid FROM shift_signout_events WHERE shift_id = ? GROUP BY team) t
                   ON t.team = s.team AND t.mid = s.id
                 ORDER BY s.id ASC`,
                [shiftId]
            );
            return (Array.isArray(rows) ? rows : []).map(r => this._rowToJson(r));
        } catch (e) { return []; }
    }

    /** سجل الأحداث الكامل لمناوبة (append-only — يشمل التصحيحات) بترتيب الإلحاق */
    async historyByShift(shiftId) {
        try {
            const rows = await this.db.all(
                'SELECT * FROM shift_signout_events WHERE shift_id = ? ORDER BY id ASC',
                [shiftId]
            );
            return (Array.isArray(rows) ? rows : []).map(r => this._rowToJson(r));
        } catch (e) { return []; }
    }
}

module.exports = SignoutService;
