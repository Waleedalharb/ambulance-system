/**
 * ═══ services/schedule-engine/preference-service.js — تفضيلات الموظفين (FSS E-1) ═══
 *
 * قرارات المالك المعتمدة 2026-10-06:
 *  ① Soft Preferences صِرفة: لا التزام ولا ضمان ولا ترجمة لجدولة في هذه المرحلة.
 *  ② النافذة من إعدادات E-0 (schedule_engine.preference_window — M8): الشهر
 *     المستهدف = الشهر القادم، والتقديم فقط بين open_day و close_day. خارجها =
 *     422 PREFERENCE_WINDOW_CLOSED مع توجيه للمسارات اليدوية القائمة (لا يُخزَّن شيء).
 *  ③ هوية الموظف تُشتق خادميًا (resolveEmployee في server.js) — لا employee_id
 *     من العميل إطلاقًا.
 *  ④ colleague: حد 3 (M14) · زميل نشط · ليس نفسه. زميل من فريق آخر يُقبل
 *     ويُخزَّن ولا يُرفض (قرار E-1/②) — قابلية تحقيقه شأن المحرك لاحقًا (M11).
 *  ⑤ لا سقف تجاري في V1 لعدد تفضيلات shift/day_off (قرار E-1/①).
 *  ⑥ الاستبدال الكامل (Full-Replace) ذرّي داخل tx.immediate: validate كامل ←
 *     delete القديم ← insert الجديد ← insert قيد audit_log — كلها في ترانزاكشن
 *     واحدة: أي فشل = ROLLBACK كامل، فلا تتغير التفضيلات أبدًا بدون Audit مطابق
 *     (شرط المالك 2026-10-06). مرآة JSON القديمة لا تُستخدم هنا حتى لا تتعدد
 *     مصادر التدقيق خارج الترانزاكشن.
 *  ⑦ رموز shift المقبولة = الموجودة في shift_codes بحالة 'دوام' فقط (رموز
 *     الإجازات/الراحة/التكميل ليست مناوبة عمل تُفضَّل — لها مساراتها الخاصة).
 *  ⑧ E-1 لا يحتوي أي منطق محرك ولا يكتب في shift_roster.
 */
'use strict';

const TimeRiyadh = require('../../public/js/time-riyadh.js');
const { getEngineSetting } = require('./config.js');

const PREF_TYPES = ['shift', 'day_off', 'colleague'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

class PrefError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

class PreferenceService {
    constructor(db) { this.db = db; }

    /** اليوم بتوقيت الرياض (الطبقة المركزية للوقت — TIME-POLICY). */
    _riyadhToday() {
        const p = TimeRiyadh.riyadhParts(new Date());
        return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
    }

    /** معلومات النافذة الحالية: مفتوحة؟ وما الشهر المستهدف (الشهر القادم — M8 أفق شهر واحد). */
    async getWindowInfo() {
        const win = await getEngineSetting('schedule_engine.preference_window');
        const { year, month, day } = this._riyadhToday();
        const isOpen = day >= win.open_day && day <= win.close_day;
        const nm = month === 12 ? 1 : month + 1;
        const ny = month === 12 ? year + 1 : year;
        return {
            is_open: isOpen,
            open_day: win.open_day,
            close_day: win.close_day,
            publish_from: win.publish_from,
            publish_to: win.publish_to,
            today: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
            target_month: `${ny}-${String(nm).padStart(2, '0')}`
        };
    }

    /** قراءة تفضيلات الموظف للشهر المستهدف الحالي + معلومات النافذة. */
    async getMyPreferences(emp) {
        const window = await this.getWindowInfo();
        const rows = await this.db.EmployeePreferences.getByEmployeeMonth(emp.id, window.target_month);
        return {
            window,
            preferences: rows.map(r => ({ pref_type: r.pref_type, pref_value: r.pref_value }))
        };
    }

    /**
     * استبدال كامل ذرّي لتفضيلات (emp, month) + قيد audit_log — كلها في ترانزاكشن واحدة.
     * @param {object} emp ملف الموظف المشتق خادميًا (resolveEmployee)
     * @param {object} user مستخدم الجلسة (req.user) — id/name يُشتقان من الجلسة فقط
     * @returns {Promise<{month, preferences, added, removed}>}
     * @throws {PrefError} 422 بأحد أكواد الرفض — وعندها صفر كتابة وصفر Audit.
     */
    async replaceMyPreferences(emp, user, month, preferences) {
        if (typeof month !== 'string' || !MONTH_RE.test(month.trim())) {
            throw new PrefError(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة — المطلوب YYYY-MM');
        }
        month = month.trim();
        const window = await this.getWindowInfo();
        if (!window.is_open || month !== window.target_month) {
            throw new PrefError(422, 'PREFERENCE_WINDOW_CLOSED',
                `نافذة التفضيلات مغلقة لهذا الشهر (المتاح: ${window.target_month} بين يوم ${window.open_day} و${window.close_day}) — بعد نشر الجدول يمكنك استخدام طلب تغيير المناوبة أو التبديل أو الإجازة`);
        }
        if (!Array.isArray(preferences)) {
            throw new PrefError(400, 'INVALID_PAYLOAD', 'preferences يجب أن تكون مصفوفة');
        }

        // ── مرجعيات التحقق ──
        const codes = await this.db.ShiftCodes.getAll();
        const codeStatus = new Map((codes || []).map(c => [String(c.code), c.status]));
        const maxColleagues = await getEngineSetting('schedule_engine.max_colleague_preferences');

        // ── التحقق من كل العناصر قبل أي كتابة ──
        const seen = new Set();
        const clean = [];
        let colleagueCount = 0;
        for (const item of preferences) {
            const type = item && typeof item.pref_type === 'string' ? item.pref_type.trim() : '';
            const value = item && item.pref_value != null ? String(item.pref_value).trim() : '';
            if (!PREF_TYPES.includes(type)) {
                throw new PrefError(422, 'INVALID_PREF_TYPE', `نوع تفضيل غير صالح: ${type || '(فارغ)'} — الأنواع: shift/day_off/colleague`);
            }
            if (!value) {
                throw new PrefError(422, 'INVALID_PREF_VALUE', `قيمة التفضيل فارغة للنوع ${type}`);
            }
            if (type === 'shift') {
                if (!codeStatus.has(value) || codeStatus.get(value) !== 'دوام') {
                    throw new PrefError(422, 'INVALID_SHIFT_CODE', `رمز المناوبة غير صالح أو ليس مناوبة عمل: ${value}`);
                }
            } else if (type === 'day_off') {
                if (!DATE_RE.test(value) || !value.startsWith(month + '-')) {
                    throw new PrefError(422, 'INVALID_DAY_OFF_DATE', `تاريخ يوم الراحة غير صالح أو خارج الشهر المستهدف (${month}): ${value}`);
                }
            } else { // colleague
                const cid = Number(value);
                if (!Number.isInteger(cid) || cid <= 0 || String(cid) !== value) {
                    throw new PrefError(422, 'COLLEAGUE_NOT_ACTIVE', `معرّف الزميل غير صالح: ${value}`);
                }
                if (cid === Number(emp.id)) {
                    throw new PrefError(422, 'COLLEAGUE_SELF', 'لا يمكنك تفضيل نفسك كزميل');
                }
                const colleague = await this.db.get('SELECT id FROM employees WHERE id = ? AND is_active = 1', [cid]);
                if (!colleague) {
                    throw new PrefError(422, 'COLLEAGUE_NOT_ACTIVE', `الزميل غير موجود أو غير نشط: ${value}`);
                }
                colleagueCount++;
            }
            const key = type + ':' + value;
            if (seen.has(key)) {
                throw new PrefError(422, 'DUPLICATE_PREFERENCE', `تفضيل مكرر: ${type} = ${value}`);
            }
            seen.add(key);
            clean.push({ pref_type: type, pref_value: value });
        }
        if (colleagueCount > maxColleagues) {
            throw new PrefError(422, 'COLLEAGUE_LIMIT_EXCEEDED', `الحد الأقصى لتفضيلات الزمالة هو ${maxColleagues} (M14) — أرسلت ${colleagueCount}`);
        }

        // ── الفرق للـAudit (قبل الاستبدال) ──
        const oldRows = await this.db.EmployeePreferences.getByEmployeeMonth(emp.id, month);
        const oldKeys = new Set(oldRows.map(r => r.pref_type + ':' + r.pref_value));
        const newKeys = new Set(clean.map(r => r.pref_type + ':' + r.pref_value));
        const added = clean.filter(r => !oldKeys.has(r.pref_type + ':' + r.pref_value));
        const removed = oldRows.filter(r => !newKeys.has(r.pref_type + ':' + r.pref_value))
            .map(r => ({ pref_type: r.pref_type, pref_value: r.pref_value }));

        // ── الاستبدال الذرّي + التدقيق في ترانزاكشن واحدة: validate تم أعلاه،
        // والآن delete ← insert ← audit. أي رمي = ROLLBACK كامل (التفضيلات
        // والتدقيق معًا) — لا تتغير التفضيلات أبدًا بدون Audit مطابق.
        const detail =
            `تحديث تفضيلات ${emp.name} (${emp.employee_code}) لشهر ${month}: ` +
            `أُضيف ${added.length} [${added.map(r => r.pref_type + '=' + r.pref_value).join('، ') || '—'}] · ` +
            `حُذف ${removed.length} [${removed.map(r => r.pref_type + '=' + r.pref_value).join('، ') || '—'}] · الإجمالي ${clean.length}`;
        this.db.tx.immediate((hdl) => {
            hdl.prepare('DELETE FROM employee_preferences WHERE employee_id = ? AND month = ?').run(emp.id, month);
            const ins = hdl.prepare('INSERT INTO employee_preferences (employee_id, month, pref_type, pref_value, created_by) VALUES (?, ?, ?, ?, ?)');
            for (const r of clean) ins.run(emp.id, month, r.pref_type, r.pref_value, user.id);
            hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                .run(user.id, user.name || 'غير معروف', 'schedule_preferences_replace', detail, 'schedule');
        });

        return { month, preferences: clean, added, removed };
    }
}

module.exports = { PreferenceService, PrefError, PREF_TYPES };
