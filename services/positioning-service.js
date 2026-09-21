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

const fs = require('fs').promises;
const path = require('path');
const TimeRiyadh = require('../public/js/time-riyadh.js'); // الطبقة المركزية للوقت (TIME-POLICY)

// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد التوقيت — السيرفر
// (Asia/Riyadh) مرجع وحيد. startTime/endTime القادمان من حقول datetime-local
// أوقات جدارية بتوقيت الرياض (naive بلا إزاحة)؛ تفسيرها بمنطقة الخادم المحلية
// (new Date مباشرة) يزيح الكنس ٣ ساعات على خادم UTC. الإزاحة تُكتب نصًا صريحًا
// +03:00 (الرياض بلا توقيت صيفي). القيم الحاملة لإزاحة/Z تُحترم كما هي.
function parseRiyadhWall(v) {
    if (!v) return null;
    const s = String(v).trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}+03:00`);
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد مصدر وقت التمركزات +
// تسجيل الخروج من التشكيلة النهائية الفعلية — الجذر: startTime/endTime كانا يُخزَّنان
// نصيين naive كما يصلان من datetime-local (جدارية الرياض)، بينما كل عرض يمر عبر
// TimeRiyadh الذي يفسر الـnaive كـUTC — فظهرت «البداية/النهاية» مزاحة +٣ ساعات عن
// الوصول الفعلي وسجل الأحداث (المختومين UTC ISO). التوحيد: الصيغة القانونية المخزنة
// = UTC ISO (سياسة المنصة: التخزين UTC والعرض Asia/Riyadh). التطبيع idempotent:
// القيم الحاملة Z/إزاحة تُحوَّل للصيغة القانونية نفسها، والصفوف القديمة الـnaive
// تُفسَّر عند القراءة جداريةَ الرياض (نفس قاعدة parseRiyadhWall) — فتتطابق البيانات
// القديمة والجديدة في كل الأسطح بلا ترحيل بيانات.
function normalizePlanTimes(plan) {
    if (!plan || typeof plan !== 'object') return plan;
    for (const k of ['startTime', 'endTime']) {
        if (plan[k]) {
            const d = parseRiyadhWall(plan[k]);
            if (d) plan[k] = d.toISOString();
        }
    }
    return plan;
}

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
    }    _rowToJson(row) {
        let data = {};
        try { data = row.data ? JSON.parse(row.data) : {}; } catch (e) {}
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): القراءة تطبّع
        // startTime/endTime — الصفوف القديمة الـnaive تُفسَّر جدارية الرياض
        // (+03:00) وتُعاد UTC ISO، والجديدة تبقى كما هي (idempotent).
        return normalizePlanTimes({ ...data, id: row.id, shiftId: row.shift_id });
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

    // ── بند 11 (اعتماد المالك 2026-09-20): إشعار مناوبي الفرق المختارة ──
    // الخادم وحده يحدد المستلمين: فرقة ← shift_roster اليوم (الرياض) ← موظف
    // نشط بكود «دوام» ← حساب users.json بنفس employee_code. لا يُوثق بأي
    // قائمة مستلمين قادمة من العميل. منع التكرار: العنوان+الرسالة يحملان
    // [تمركز #id] فتطابق إعادة المحاولة داخل النافذة = touch لا صف جديد.

    /** أسماء الفرق المستهدفة في الخطة — unit (نص) أو units (مصفوفة) */
    static _unitNamesOf(plan) {
        if (!plan || typeof plan !== 'object') return [];
        const out = [];
        if (Array.isArray(plan.units)) out.push(...plan.units);
        if (plan.unit != null) out.push(plan.unit);
        return [...new Set(out.map(u => String(u || '').trim()).filter(Boolean))];
    }

    /** تاريخ الرياض اليوم YYYY-MM-DD من الطبقة المركزية */
    static _riyadhToday() {
        const p = TimeRiyadh.riyadhParts(new Date());
        return p ? `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}` : null;
    }

    /** عرض لحظة UTC ISO بتوقيت الرياض: «HH:MM · YYYY-MM-DD» */
    static _riyadhDisplay(iso) {
        const p = TimeRiyadh.riyadhParts(iso);
        if (!p) return iso ? String(iso) : '—';
        const pad = v => String(v).padStart(2, '0');
        return `${pad(p.hour)}:${pad(p.minute)} · ${p.year}-${pad(p.month)}-${pad(p.day)}`;
    }

    /**
     * يحل أسماء الفرق إلى حسابات الموظفين المناوبين عليها اليوم فعليًا.
     * يعيد [{ userId, employeeName, teamName }] — بلا تكرار موظف.
     */
    async _resolveOnDutyRecipients(unitNames) {
        if (!unitNames.length) return [];
        const teams = await this.db.all('SELECT id, name FROM teams');
        const teamIds = teams.filter(t => unitNames.includes(String(t.name))).map(t => t.id);
        if (!teamIds.length) return [];
        const today = PositioningService._riyadhToday();
        if (!today) return [];
        const ph = teamIds.map(() => '?').join(',');
        const rows = await this.db.all(
            `SELECT employee_id, shift_code FROM shift_roster WHERE team_id IN (${ph}) AND shift_date = ?`,
            [...teamIds, today]);
        if (!rows.length) return [];
        // «مناوب حاليًا» = له رمز مناوبة اليوم وحالة الرمز «دوام»؛ الرمز غير
        // المسجل يُعامل دوامًا (الافتراضي القانوني في shift_codes.status)،
        // والإجازة/الراحة والصفوف بلا رمز تُستبعد — لا مناوبة بلا رمز.
        const codes = await this.db.all('SELECT code, status FROM shift_codes');
        const statusBy = new Map(codes.map(c => [String(c.code), c.status || 'دوام']));
        const dutyEmpIds = [...new Set(rows
            .filter(r => r.shift_code != null && statusBy.get(String(r.shift_code), 'دوام') === 'دوام')
            .map(r => r.employee_id))];
        if (!dutyEmpIds.length) return [];
        const ph2 = dutyEmpIds.map(() => '?').join(',');
        const emps = await this.db.all(
            `SELECT id, employee_code, name FROM employees WHERE id IN (${ph2}) AND COALESCE(is_active, 1) = 1`,
            dutyEmpIds);
        if (!emps.length) return [];
        const usersPath = path.join(
            process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
            'users.json');
        let users = [];
        try { users = JSON.parse(await fs.readFile(usersPath, 'utf8')); } catch (_) { return []; }
        const activeByUsername = new Map(
            (Array.isArray(users) ? users : []).filter(u => u && u.isActive).map(u => [String(u.username), u]));
        return emps
            .map(e => {
                const u = activeByUsername.get(String(e.employee_code));
                return u ? { userId: String(u.id), employeeName: e.name } : null;
            })
            .filter(Boolean);
    }

    /**
     * إشعار + Push للمناوبين الحاليين عند إنشاء/تعديل/إلغاء تمركز.
     * لا يرمي أبدًا — فشل الإشعار لا يمس العملية التشغيلية الأصلية.
     */
    async _notifyOnDuty(plan, kind, user, before) {
        try {
            const unitNames = [...new Set([
                ...PositioningService._unitNamesOf(plan),
                ...(before ? PositioningService._unitNamesOf(before) : [])
            ])];
            if (!unitNames.length || !plan || plan.id == null) return;
            const targets = await this._resolveOnDutyRecipients(unitNames);
            if (!targets.length) return;
            const notificationService = require('./notification-service');
            const title = { created: 'تمركز وقت الذروة', updated: 'تحديث تمركز وقت الذروة', ended: 'إلغاء تمركز وقت الذروة' }[kind]
                || 'تمركز وقت الذروة';
            const lines = [];
            if (kind === 'ended') lines.push('تم إلغاء التمركز الموجه لفرقتك.');
            else if (kind === 'updated') lines.push('تم تحديث التمركز الموجه لفرقتك.');
            else lines.push('تم توجيه تمركز وقت الذروة لفرقتك.');
            if (plan.title) lines.push(`العنوان: ${plan.title}`);
            lines.push(`الفرقة: ${unitNames.join('، ')}`);
            if (plan.location) lines.push(`الموقع: ${plan.location}`);
            if (kind !== 'ended') {
                if (plan.startTime) lines.push(`البداية: ${PositioningService._riyadhDisplay(plan.startTime)}`);
                if (plan.endTime) lines.push(`النهاية: ${PositioningService._riyadhDisplay(plan.endTime)}`);
                const s = parseRiyadhWall(plan.startTime), e = parseRiyadhWall(plan.endTime);
                if (s && e && e > s) {
                    const mins = Math.round((e - s) / 60000);
                    const h = Math.floor(mins / 60), m = mins % 60;
                    lines.push(`المدة: ${h > 0 ? h + ' ساعة' : ''}${h > 0 && m > 0 ? ' و' : ''}${m > 0 ? m + ' دقيقة' : ''}`.trim());
                }
            }
            const actor = (user && (user.name || user.username)) || plan.createdBy;
            if (actor) lines.push(`المصدر: ${actor}`);
            lines.push(`[تمركز #${plan.id}]`);
            const message = lines.filter(Boolean).join('\n');
            for (const t of targets) {
                // منع التكرار: نفس التمركز لنفس الموظف داخل النافذة = تحديث وقت فقط
                const existing = typeof this.db.Notifications?.findRecentMatch === 'function'
                    ? await this.db.Notifications.findRecentMatch(t.userId, title, message, 5) : null;
                if (existing) { await this.db.Notifications.touch(existing.id); continue; }
                await notificationService.notifyPersonal(t.userId,
                    { eventKey: 'positioning.changed', title, message },
                    { kind: 'positioning', plan_id: String(plan.id) });
            }
        } catch (err) {
            console.warn('[Positioning] on-duty notify failed (' + kind + '):', err.message);
        }
    }

    /**
     * قائمة خطط التمركز (نفس ترتيب المسار القديم).
     * قبل القراءة: كنس الخطط المنتهية — نسخة حرفية من cleanupPeakPlans في الواجهة:
     *   if (p.status === 'active' && p.endTime && new Date(p.endTime) < now) p.status = 'completed';
     * مع تصحيح المرجع الزمني (تفويض 2026-08): endTime الجداري naive يُفسَّر بتوقيت
     * الرياض (+03:00 صريح عبر parseRiyadhWall) لا بمنطقة الخادم المحلية، و«الآن»
     * لحظة الخادم — المقارنة لحظات مطلقة فلا تتأثر بمنطقة الجهاز.
     */
    async list() {
        const now = new Date();
        const candidates = await this.db.all('SELECT * FROM peak_plans');
        for (const row of candidates) {
            const plan = this._rowToJson(row);
            const endAt = parseRiyadhWall(plan.endTime);
            if (plan.status === 'active' && endAt && endAt < now) {
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
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد المصدر عند
        // الكتابة — البداية/النهاية الجداريتان (naive من datetime-local) تُخزَّنان
        // UTC ISO قانونية فتقرؤهما كل الأسطح عبر TimeRiyadh بلا إزاحة وهمية.
        normalizePlanTimes(plan);
        const shiftId = typeof this.getActiveShiftId === 'function' ? await this.getActiveShiftId() : null;
        await this.db.run('INSERT INTO peak_plans (id, shift_id, data) VALUES (?, ?, ?)',
            [plan.id, shiftId != null ? shiftId : null, JSON.stringify(plan)]);
        this.bus.emit('PositioningStarted', { plan_id: plan.id, shift_id: shiftId, title: plan.title, plan });
        // المرحلة أ: ختم حدث الإنشاء في سجل المناوبة
        await this._recordEvent(plan.id, shiftId, 'created', null, plan, user);
        // بند 11: إشعار المناوبين الحاليين على الفرق المختارة (لا يرمي أبدًا)
        await this._notifyOnDuty(plan, 'created', user);
        return plan;
    }

    /** تعديل خطة → PositioningUpdated (Catalog D-4 — مُفعَّل) */
    async update(id, updates, user) {
        const row = await this.db.get('SELECT * FROM peak_plans WHERE id = ?', [id]);
        if (!row) return null;
        const before = this._rowToJson(row);
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): توحيد التوقيت —
        // arrivalTime/departureTime دلالتهما «الآن» (ضغطة وصول/مغادرة/إنهاء)،
        // فتُختم من ساعة الخادم حصرًا ولا يُوثق بأي طابع قادم من جهاز العميل.
        // إعادة إرسال القيمة المخزنة نفسها (echo) لا تُعاد ختمًا — تبقى كما هي.
        const serverNowIso = new Date().toISOString();
        const stamped = { ...(updates || {}) };
        for (const k of ['arrivalTime', 'departureTime']) {
            if (Object.prototype.hasOwnProperty.call(stamped, k) && stamped[k] && stamped[k] !== before[k]) {
                stamped[k] = serverNowIso;
            }
        }
        const plan = { ...before, ...stamped, id: row.id };
        // تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): نفس توحيد الكتابة —
        // قيم startTime/endTime الجديدة (naive) تُخزَّن UTC ISO، والقيم القديمة
        // المخزنة تُشفى ذاتيًا عند أول تعديل (idempotent — بلا ترحيل منفصل).
        normalizePlanTimes(plan);
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
        // بند 11: المتأثرون = مناوبو الفرق قبل/بعد التعديل (لا يرمي أبدًا)
        await this._notifyOnDuty(plan, 'updated', user, before);
        return plan;
    }

    /** إنهاء/حذف تمركز → PositioningEnded فقط إذا وُجدت الخطة فعلاً */
    async remove(id, user) {
        const row = await this.db.get('SELECT * FROM peak_plans WHERE id = ?', [id]);
        await this.db.run('DELETE FROM peak_plans WHERE id = ?', [id]);
        if (row) {
            const removedPlan = this._rowToJson(row);
            this.bus.emit('PositioningEnded', { plan_id: id, shift_id: row.shift_id });
            // المرحلة أ: الحذف إنهاء موثق — الحمولة الأخيرة تُحفظ في السجل قبل فقدها
            await this._recordEvent(id, row.shift_id, 'ended', null, removedPlan, user || null);
            // بند 11: إشعار الإلغاء لمناوبي فرق الخطة الملغاة (لا يرمي أبدًا)
            await this._notifyOnDuty(removedPlan, 'ended', user);
        }
        return true;
    }
}

module.exports = PositioningService;
// تفويض «المرحلة الأخيرة قبل الاعتماد الرسمي» (2026-08): المطبِّع يُصدَّر ليقرأه
// كل مستهلك خام لـ peak_plans (تفاصيل/تصدير server.js ولقطة shift-archive-engine)
// — نقطة تطبيع واحدة لا منطق مكرر.
PositioningService.normalizePlanTimes = normalizePlanTimes;
PositioningService.parseRiyadhWall = parseRiyadhWall;
