/**
 * SignoutService — مالك «تسجيل خروج المناوبة» الوحيد (المرحلة ب، التوسعة ①)
 * ═══════════════════════════════════════════════════════════
 * TEAM_CHECKOUT حدث تشغيلي في سجل shift_signout_events (append-only — نمط
 * positioning_events نفسه لأن operational_events مقيّد بـ CHECK(domain)).
 * الكتابة إلحاق فقط؛ الحالة الحالية للفرقة = أحدث حدث لها (عرض مشتق من السجل
 * نفسه — لا جدول حالة ولا مصدر موازٍ)، وكل صفحة تقرأ من هذا السجل.
 *
 * الاقتراح التلقائي (suggest) — سلسلة أولويات موثقة:
 *   1. آخر Final Team Snapshot معتمد = أحدث حدث تسجيل خروج لهذه الفرقة
 *      (TEAM_CHECKOUT في shift_signout_events — source: signout): هم من
 *      أنهوا المناوبة السابقة فعلًا وسلّموها
 *   2. احتياطي فقط عند غياب أي Snapshot سابق إطلاقًا: طاقم الفرقة الفعلي
 *      في المناوبة الحالية المشتق سيرفريًا (effectiveRoster — source:
 *      current_shift) — أول تشغيل/أول مناوبة في القاعدة
 *   3. آخر مناوبة سابقة لها طاقم فعلي مشتق للفرقة (source: previous_shift)
 * وكلها لا تلمس الجدول الشهري الخام ولا HR — الاشتقاق السيرفري نفسه المستخدم
 * في صفحة التكميل ولوحة المؤشرات.
 * تفويض المالك (2026-08-08): تسجيل الخروج = تسليم متسلسل بين المناوبات —
 * مناوبة 1 → تسجيل خروج → Final Team Snapshot → مناوبة 2 تجلب الـSnapshot →
 * تغييرات أثناء المناوبة → تسجيل خروج جديد → Snapshot جديد → مناوبة 3 …
 * الاقتراح يقرأ من آخر Final Team Snapshot معتمد (تسليم المناوبة السابقة)،
 * وeffectiveRoster احتياطي فقط عند غياب أي Snapshot سابق.
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
 *
 * تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08) — تذكرة البند ③:
 *   (ب) record يقبل createdAt يدويًا اختياريًا (تاريخ المناوبة النشطة + وقت
 *       الرياض الذي أدخله المستخدم، مُركَّبًا في الواجهة كـ+03:00 ثم UTC) —
 *       يُخزن كما هو إن صحّ تحليله، وإلا يسقط على الختم الآلي بالوقت الحالي.
 *   (ج) listByShift/record يُثريان كل تسجيل بـ memberDetails (الاسم + الكود +
 *       المسمى الوظيفي) من دليل الموظفين employees بالمطابقة الاسمية — المصدر
 *       القانوني نفسه الذي تشتق منه حالة القوى code/jobTitle — حتى تظهر
 *       التسجيلات متطابقة (أعضاء بأكوادهم ومسمياتهم + الوقت + المسجِّل) في
 *       صفحة التكميل وسير العمل والتفاصيل والأرشيف والـPDF، وكلها تقرأ من هذا
 *       السجل لا من roster المجدول.
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

    /**
     * التشكيلة النهائية الفعلية للفرقة في مناوبة معينة — كائنات
     * {name, code, jobTitle, role, state} بعد طيّ كل أحداث المناوبة.
     * تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): تسجيل الخروج يوثّق
     * من أنهى المناوبة فعلًا — الغائب/المتأخر غير العائد/المكلَّف خارج الفريق لا
     * يظهر، والبديل/المتطوع/الدعم الوارد يظهر عضوًا كاملًا. القراءة من حقل
     * effectiveRoster الذي يشتقه deriveTeamReadiness (المصدر الوحيد للطيّ —
     * لا منطق طيّ مكرر هنا)؛ السقوط لنفس القاعدة على members للأشكال الأقدم.
     */
    async _effectiveRoster(team, shiftId) {
        try {
            if (!this.staffingService || !shiftId) return [];
            const state = await this.staffingService.getState(shiftId);
            const t = state && state.teams ? state.teams[team] : null;
            if (!t || !Array.isArray(t.members)) return [];
            const eff = Array.isArray(t.effectiveRoster)
                ? t.effectiveRoster
                : t.members.filter(m => m && (m.state === 'active' || m.role === 'support'));
            return eff.filter(m => m && m.name);
        } catch (e) { return []; }
    }

    /** أسماء التشكيلة النهائية الفعلية المشتقة سيرفريًا لمناوبة معينة ([] عند الغياب) */
    async _derivedMembers(team, shiftId) {
        return (await this._effectiveRoster(team, shiftId)).map(m => m.name);
    }

    /**
     * اقتراح أسماء أفراد الفرقة — السلسلة الموثقة أعلاه.
     * تفويض المالك (2026-08-08): الاقتراح يقرأ من آخر Final Team Snapshot
     * معتمد (تسليم المناوبة السابقة) — effectiveRoster احتياطي فقط عند
     * غياب أي Snapshot سابق.
     * @returns {{members: string[], source: 'signout'|'current_shift'|'previous_shift'|null,
     *            sourceShiftId: number|null, sourceLabel: string}}
     */
    async suggest(team, currentShiftId) {
        const empty = { members: [], source: null, sourceShiftId: null, sourceLabel: '' };
        if (!team) return empty;

        // 1. آخر Final Team Snapshot معتمد = آخر حدث تسجيل خروج للفرقة (سجل
        //    المنصة نفسه — أصدق مصدر تراكمي). تفويض المالك (2026-08-08):
        //    الاقتراح يقرأ من آخر Final Team Snapshot معتمد (تسليم المناوبة
        //    السابقة) — effectiveRoster احتياطي فقط عند غياب أي Snapshot سابق.
        try {
            const row = await this.db.get(
                'SELECT * FROM shift_signout_events WHERE team = ? ORDER BY id DESC LIMIT 1',
                [team]
            );
            if (row) {
                const s = this._rowToJson(row);
                if (s.members.length) {
                    return { members: s.members, memberDetails: (await this._withMemberDetails([{ members: s.members }]))[0].memberDetails, source: 'signout', sourceShiftId: s.shiftId, sourceLabel: 'آخر تشكيلة معتمدة (تسليم مناوبة #' + s.shiftId + ')' };
                }
            }
        } catch (e) { /* الجدول قد يسبق تهيئته في بيئة اختبار — نكمل السلسلة */ }

        // 2. احتياطي فقط (لا يوجد أي تسليم سابق — أول تشغيل/أول مناوبة في
        //    القاعدة): الطاقم الفعلي للمناوبة الحالية المشتق سيرفريًا من
        //    الأحداث. «الفعلية» = التشكيلة النهائية بعد طيّ الغياب/التأخير/
        //    الدعم/الاستبدال/التطوع (effectiveRoster — لا القاعدة المجدولة)،
        //    وكل عضو يُعاد بحقوله الثلاثة (الاسم + الكود + المسمى): code/
        //    jobTitle المحفوظان في الاشتقاق أولًا، ودليل employees القانوني
        //    يملأ الفراغ (نفس إثراء _withMemberDetails — مصدر واحد).
        const roster = await this._effectiveRoster(team, currentShiftId);
        if (roster.length) {
            const pmap = await this._personnelMap();
            const memberDetails = roster.map(m => {
                const p = pmap[String(m.name).trim()] || {};
                return { name: m.name, code: m.code || p.code || null, jobTitle: m.jobTitle || p.jobTitle || null };
            });
            return { members: memberDetails.map(d => d.name), memberDetails, source: 'current_shift', sourceShiftId: currentShiftId || null, sourceLabel: 'طاقم المناوبة الحالية الفعلي (لا يوجد تسليم سابق)' };
        }

        // 3. آخر مناوبة فعلية سابقة لها طاقم مشتق للفرقة (أحدث 10 مناوبات)
        try {
            const rows = await this.db.all(
                'SELECT id FROM shifts WHERE id != ? ORDER BY id DESC LIMIT 10',
                [currentShiftId || -1]
            );
            for (const r of (Array.isArray(rows) ? rows : [])) {
                const prevRoster = await this._effectiveRoster(team, r.id);
                if (prevRoster.length) {
                    const pmap = await this._personnelMap();
                    const memberDetails = prevRoster.map(m => {
                        const p = pmap[String(m.name).trim()] || {};
                        return { name: m.name, code: m.code || p.code || null, jobTitle: m.jobTitle || p.jobTitle || null };
                    });
                    return { members: memberDetails.map(d => d.name), memberDetails, source: 'previous_shift', sourceShiftId: r.id, sourceLabel: 'آخر مناوبة فعلية (#' + r.id + ')' };
                }
            }
        } catch (e) { /* صمت — الاقتراح الفارغ حالة صحيحة */ }

        return empty;
    }

    /**
     * تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): خريطة اسم →
     * {code, jobTitle} من دليل الموظفين (employees — المصدر القانوني الواحد؛
     * حالة القوى نفسها تشتق code/jobTitle منه بالمطابقة الاسمية). إثراء وصفي
     * additive: من لا يُطابق اسمه يُترك بلا code/jobTitle ولا يُسقط السجل.
     */
    async _personnelMap() {
        const map = {};
        try {
            const rows = await this.db.all('SELECT name, employee_code, job_title FROM employees WHERE is_active = 1');
            for (const r of (Array.isArray(rows) ? rows : [])) {
                const n = String(r.name || '').trim();
                if (n && !map[n]) map[n] = { code: r.employee_code || null, jobTitle: r.job_title || null };
            }
        } catch (e) { /* جدول employees قد يسبق تهيئته في بيئة اختبار — الإثراء يُترك فارغًا */ }
        return map;
    }

    /** إلحاق memberDetails (الاسم + الكود + المسمى) بكل تسجيل — عرض مشتق، لا كتابة */
    async _withMemberDetails(list) {
        const arr = Array.isArray(list) ? list : [];
        if (!arr.length) return arr;
        const pmap = await this._personnelMap();
        arr.forEach(s => {
            s.memberDetails = (Array.isArray(s.members) ? s.members : []).map(n => {
                const p = pmap[String(n || '').trim()] || {};
                return { name: n, code: p.code || null, jobTitle: p.jobTitle || null };
            });
        });
        return arr;
    }

    /**
     * تسجيل خروج فرقة = إلحاق حدث TEAM_CHECKOUT مختوم بالمناوبة والمستخدم
     * (append-only — التصحيح حدث جديد لا تعديل). يُطلق ShiftSignoutRecorded
     * بعد نجاح الكتابة (الحدث حقيقة واقعة).
     * createdAt اختياري (وقت يدوي): يُقبل إن صحّ تحليله تاريخًا، وإلا يسقط
     * على الختم الآلي — الوقت اليدوي يُحفظ كما هو ولا يُستبدل بالوقت الحالي.
     */
    async record(team, members, notes, user, createdAt) {
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
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): الوقت اليدوي —
        // الواجهة تركّب تاريخ المناوبة النشطة + وقت الرياض المدخل (+03:00) وترسله
        // UTC؛ يُخزن كما هو إن صحّ، وإلا يسقط على الوقت الحالي. لا بديل عنه
        // بالوقت الحالي عند الحفظ إطلاقًا.
        let stampedAt = now;
        if (createdAt) {
            const manual = new Date(createdAt);
            if (!isNaN(manual.getTime())) stampedAt = manual.toISOString();
        }
        const actorId = user && user.id != null ? String(user.id) : null;
        const actorName = (user && (user.name || user.username)) || 'unknown';

        // إلحاق صِرف — لا UPDATE ولا DELETE على السجل إطلاقًا
        const ins = await this.db.run(
            `INSERT INTO shift_signout_events (shift_id, shift_date, shift_type, event_type, team, members, notes, actor_id, actor_name, created_at)
             VALUES (?, ?, ?, 'TEAM_CHECKOUT', ?, ?, ?, ?, ?, ?)`,
            [shiftId, shiftDate, shiftType, team, JSON.stringify(cleanMembers), notes || '', actorId, actorName, stampedAt]
        );

        const row = await this.db.get('SELECT * FROM shift_signout_events WHERE id = ?', [ins && ins.id]);
        const saved = (await this._withMemberDetails([this._rowToJson(row)]))[0];
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
            // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): الإثراء
            // بـ memberDetails (كود/مسمى) من دليل الموظفين — additive فوق
            // members (أسماء) التي تبقى كما هي للتوافق الخلفي.
            return await this._withMemberDetails((Array.isArray(rows) ? rows : []).map(r => this._rowToJson(r)));
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
