// ============================================
// SymbolRegistryService — السجل المركزي لرموز الجداول
// ============================================
// يستخرج الرموز من المحللات الفعلية (القواميس الأربعة + shift-codes-config +
// جدول shift_codes) ولا يعيد كتابة تعريفاتها. لا يغيّر معنى أي رمز قائم؛
// الرموز المخصصة تُضاف فوق القواميس (additive) عبر registerCustom فقط.
//
// الأنواع الثلاثة (فصل إلزامي — لا خلط):
//   day_code         ← كود خلية اليوم (ShiftTypeDictionary / shift_codes)
//   employee_symbol  ← رمز الموظف/القوة (SymbolDictionary)
//   operational_code ← كود تشغيلي ملحق (OperationalCodes)
// ============================================

const SymbolDictionary = require('../public/js/core/symbol-dictionary.js');
const ShiftTypeDictionary = require('../public/js/core/shift-type-dictionary.js');
const OperationalCodes = require('../public/js/core/operational-codes.js');
const ShiftCodesConfig = require('../public/js/shift-codes-config.js');
const ScheduleMetricsService = require('./schedule-metrics-service.js');

// أنواع الرموز المعتمدة
const SYMBOL_TYPES = ['day_code', 'employee_symbol', 'operational_code'];

// فئات «مناوبة/دوام» في قاموس أنواع المناوبات
const WORK_GROUPS = ['morning', 'night', 'night8', 'overlap', 'office', 'mission'];

// أسماء عربية للفئات
const GROUP_LABELS = {
    morning: 'مناوبة صباحية', night: 'مناوبة ليلية', night8: 'ليلية 8 ساعات',
    overlap: 'أوفرلاب', office: 'دوام رسمي', mission: 'مهمة رسمية',
    vacation: 'إجازة', rest: 'راحة دورية', training: 'تدريب', off: 'OFF'
};
const KIND_LABELS = {
    leadership: 'قيادة ميدانية', center: 'مركز جنوب', rapid: 'تدخل سريع',
    ops: 'عمليات', admin: 'إدارة/دعم', overlap: 'أوفرلاب'
};

// ⚠️ الرموز التي حددها التقرير المرجعي المعتمد (2026-08-15) كتحتاج قرارًا —
// تُعرض في الإدارة كـ«رمز يحتاج مراجعة» دون أي تغيير في سلوكها.
const REVIEW_FLAGS = {
    WO: 'تعارض موثق: القاموس يصنفه «دوام رسمي» بينما shift-codes-config يصنفه «راحة»، وقوائم الخادم تعده خارج الدوام — يحتاج قرار مالك قبل أي توحيد.',
    S: '«مرضية» موجودة في قاموس الإجازات لكنها غائبة عن قوائم الغياب في مسارات أخرى — قد تُحسب حضورًا في بعض الشاشات.',
    C: '«تدريب» يُعد غيابًا في بعض المسارات (مولّد/قوائم OFF) وحضورًا تدريبيًا في القاموس — يحتاج حسمًا.',
    O6: '«أوفرلاب 6» في قائمة الليلية لكنه خارج فئة «أوفرلاب» في فلاتر القاموس — تصنيفه غير موحد.',
    M: '«مهمة» تُحسب 24 ساعة للخلية الواحدة (00:00→23:59) — رقم ضخم قد لا يعكس الواقع التشغيلي.',
    O1515: 'رمز ملتبس يظهر لدى 3 موظفين: قد يكون أوفرلاب 15:15 أو كودًا قديمًا — يفك حاليًا كـ«أوفرلاب O1515» ويحتاج قرارًا.'
};

class SymbolRegistryService {
    constructor({ db }) {
        if (!db) throw new Error('SymbolRegistryService: db مطلوب');
        this.db = db;
        this.metrics = new ScheduleMetricsService({ db });
    }

    /** خريطة shift_codes بالرمز — لإعادة استخدام محلل الساعات المركزي حرفيًا. */
    async _codesByCode() {
        const rows = await this.db.all('SELECT code, name, time_start, time_end FROM shift_codes');
        const map = new Map();
        for (const r of rows) {
            const c = String(r.code || '').trim();
            if (!c) continue;
            map.set(c, r);
            map.set(c.toUpperCase(), r);
        }
        return map;
    }

    /**
     * استخراج كل الرموز المدمجة من المحللات الفعلية.
     * يعيد { entries, patterns } — entries صفوف سجل ملموسة، patterns عائلات أنماط
     * لا تُعدّ صفوفًا (تُعرض في الصفحة كقسم «أنماط مدعومة برمجيًا»).
     */
    async extractBuiltin() {
        const entries = new Map(); // مفتاح: type|code
        const codesByCode = await this._codesByCode();
        const cfgByCode = new Map(ShiftCodesConfig.SHIFT_CODES.map(s => [s.code, s]));

        const put = (e) => {
            const key = e.symbol_type + '|' + e.code;
            if (entries.has(key)) {
                // دمج حقول ناقصة فقط — لا سحق
                const cur = entries.get(key);
                for (const k of Object.keys(e)) {
                    if ((cur[k] === null || cur[k] === undefined || cur[k] === '' ) && e[k] !== null && e[k] !== undefined && e[k] !== '') cur[k] = e[k];
                }
                return;
            }
            entries.set(key, e);
        };

        // ── 1) رموز الموظفين — المدخلات الثابتة في SymbolDictionary ──
        for (const code of Object.keys(SymbolDictionary.CODE_MAP)) {
            const def = SymbolDictionary.CODE_MAP[code];
            put({
                code, symbol_type: 'employee_symbol',
                name: (KIND_LABELS[def.kind] || def.kind) + ' — ' + def.team,
                group_name: def.kind, team: def.team,
                hours: null, is_shift: 0,
                accepts_day_cell: 0, accepts_employee_symbol: 1, is_operational: 0,
                shift_side: '', source: 'builtin',
                needs_review: REVIEW_FLAGS[code] ? 1 : 0, review_reason: REVIEW_FLAGS[code] || null
            });
        }
        // رموز موظفين ملتبسة وثّقها التقرير وليست في المدخلات الثابتة
        for (const code of ['O1515']) {
            const r = SymbolDictionary.resolveSymbol(code);
            if (r) put({
                code, symbol_type: 'employee_symbol',
                name: (KIND_LABELS[r.kind] || r.kind) + ' — ' + r.team,
                group_name: r.kind, team: r.team,
                hours: null, is_shift: 0,
                accepts_day_cell: 0, accepts_employee_symbol: 1, is_operational: 0,
                shift_side: '', source: 'builtin',
                needs_review: 1, review_reason: REVIEW_FLAGS[code]
            });
        }

        // ── 2) أكواد الأيام — فئات ShiftTypeDictionary الفعلية ──
        const dayOnly = new Set(ShiftTypeDictionary.DAY_ONLY_CODES);
        const nightOnly = new Set(ShiftTypeDictionary.NIGHT_ONLY_CODES);
        const shared = new Set(ShiftTypeDictionary.SHARED_CODES);
        const offSet = new Set(ShiftTypeDictionary.OFF_CODES);
        const sideOf = (c) => dayOnly.has(c) ? 'صباحية' : nightOnly.has(c) ? 'ليلية' : shared.has(c) ? 'كلاهما' : '';

        for (const g of Object.keys(ShiftTypeDictionary.GROUPS)) {
            for (const code of ShiftTypeDictionary.GROUPS[g]) {
                const cfg = cfgByCode.get(code);
                const hours = this.metrics.resolveCodeDurationHours(code, codesByCode);
                put({
                    code, symbol_type: 'day_code',
                    name: cfg ? cfg.name : (GROUP_LABELS[g] || g),
                    group_name: g, team: null,
                    hours: hours, // من محلل ScheduleMetricsService المركزي نفسه
                    time_start: cfg ? cfg.time_start : null,
                    time_end: cfg ? cfg.time_end : null,
                    is_shift: WORK_GROUPS.indexOf(g) !== -1 ? 1 : 0,
                    accepts_day_cell: 1, accepts_employee_symbol: 0,
                    is_operational: OperationalCodes.isOperationalCode(code) ? 1 : 0,
                    shift_side: sideOf(code), source: 'builtin',
                    needs_review: REVIEW_FLAGS[code] ? 1 : 0, review_reason: REVIEW_FLAGS[code] || null
                });
            }
        }
        // أكواد أيام في قوائم الوردية ولم ترد في الفئات (تغطية كاملة للقوائم)
        for (const c of [...dayOnly, ...nightOnly, ...shared, ...offSet]) {
            const cfg = cfgByCode.get(c);
            put({
                code: c, symbol_type: 'day_code',
                name: cfg ? cfg.name : 'كود يوم',
                group_name: null, team: null,
                hours: this.metrics.resolveCodeDurationHours(c, codesByCode),
                time_start: cfg ? cfg.time_start : null, time_end: cfg ? cfg.time_end : null,
                is_shift: offSet.has(c) ? 0 : 1,
                accepts_day_cell: 1, accepts_employee_symbol: 0,
                is_operational: OperationalCodes.isOperationalCode(c) ? 1 : 0,
                shift_side: sideOf(c), source: 'builtin',
                needs_review: REVIEW_FLAGS[c] ? 1 : 0, review_reason: REVIEW_FLAGS[c] || null
            });
        }

        // ── 3) الأكواد التشغيلية الملحقة الملموسة (المزروعة في shift_codes) ──
        for (const s of ShiftCodesConfig.SHIFT_CODES) {
            const parsed = OperationalCodes.parseOperationalCode(s.code);
            if (!parsed) continue;
            put({
                code: s.code, symbol_type: 'operational_code',
                name: s.name,
                group_name: parsed.kind === 'rapid' ? 'rapid' : 'overlap',
                team: null,
                hours: parsed.durationH,
                time_start: s.time_start, time_end: s.time_end,
                is_shift: 1, accepts_day_cell: 1, accepts_employee_symbol: 0,
                is_operational: 1,
                shift_side: parsed.explicitShift ? (parsed.shift === 'D' ? 'صباحية' : 'ليلية') : '',
                source: 'builtin', needs_review: 0, review_reason: null
            });
        }

        // ── عائلات الأنماط (ليست صفوف سجل — قسم توثيقي في الصفحة) ──
        const patterns = [
            { family: 'مراكز الجنوب', pattern: '[A-D][1-19]', meaning: 'رمز موظف: الحرف مجموعة المناوبة والرقم رقم المركز (جنوب 1..19)', examples: 'A1 · B7 · C12 · D19', accepts: 'رمز الموظف' },
            { family: 'التدخل السريع (جديد)', pattern: 'RR[A-D][1-9]', meaning: 'رمز موظف: الحرف دورية المناوبة والرقم السيارة (سريع N)', examples: 'RRA1 · RRB2 · RRC3', accepts: 'رمز الموظف' },
            { family: 'الدعم اللوجستي', pattern: '[A-D]T · [A-D]Z', meaning: 'رمز موظف للدعم اللوجستي بالصيغتين', examples: 'AT · BZ · DT', accepts: 'رمز الموظف' },
            { family: 'مرحلو العمليات', pattern: '[A-D]W', meaning: 'رمز موظف لمرحلي العمليات', examples: 'AW · CW', accepts: 'رمز الموظف' },
            { family: 'أوفرلاب كلاسيكي', pattern: 'O<مدة><حرف?>', meaning: 'رمز موظف لطاقم أوفرلاب', examples: 'O12A · O14B · O15', accepts: 'رمز الموظف' },
            { family: 'أوفرلاب بتعيين صريح', pattern: 'O<مدة><حرف><سيارة 1-19>', meaning: 'طاقم أوفرلاب معيّن لسيارة جنوب محددة', examples: 'O12C13 · O12C5', accepts: 'رمز الموظف وخلية اليوم (يُفك لأساسه)' },
            { family: 'أوفرلاب ملحق', pattern: 'O<مدة>-<بداية 00-23>', meaning: 'كود تشغيلي: المدة وبداية التشغيل من لاحقة الكود', examples: 'O12-09 · O12-12 · O12-14', accepts: 'خلية اليوم' },
            { family: 'تدخل سريع ملحق (موقّع)', pattern: 'RR<دورية?><رقم>-<D|N>-<بداية>', meaning: 'كود تشغيلي بحرف وردية صريح — المصدر الوحيد لحقيقة الوردية', examples: 'RRA1-D-04 · RRA1-N-16', accepts: 'خلية اليوم' },
            { family: 'تدخل سريع ملحق (قديم)', pattern: 'RR<دورية?><رقم>-<بداية>', meaning: 'صيغة تاريخية بلا حرف وردية — الوردية تُشتق من الساعة', examples: 'RRA1-04 · RRA1-16', accepts: 'خلية اليوم' },
            { family: 'استخراج الرقم النصي', pattern: '^[A-Za-z]+(\\d{1,2})', meaning: 'قاعدة ساعات احتياطية: أول رقم بعد سابقة حرفية = ساعات (D12→12)', examples: 'D12 → 12 · D8 → 8', accepts: 'حساب الساعات فقط', needs_review: 1, review_reason: 'القاعدة قد تمنح ساعات لرمز موظف وقع في خلية يوم بالخطأ (A1→ساعة واحدة) — تحتاج قرارًا.' }
        ];

        return { entries: [...entries.values()], patterns };
    }

    /** بذر السجل من الاستخراج الفعلي — مرة واحدة فقط (لا يمس إدخالات الأدمن). */
    async seedIfEmpty() {
        const count = await this.db.ScheduleSymbols.count();
        if (count > 0) return { seeded: false, count };
        const { entries } = await this.extractBuiltin();
        let inserted = 0;
        for (const e of entries) {
            await this.db.ScheduleSymbols.insert(e);
            inserted++;
        }
        return { seeded: true, count: inserted };
    }

    /** إعادة مزامنة الرموز المدمجة الناقصة فقط (رموز جديدة ظهرت في القواميس). */
    async syncMissingBuiltin() {
        const { entries } = await this.extractBuiltin();
        let added = 0;
        for (const e of entries) {
            const existing = await this.db.ScheduleSymbols.getByCodeAndType(e.code, e.symbol_type);
            if (!existing) { await this.db.ScheduleSymbols.insert(e); added++; }
        }
        return added;
    }

    /** قائمة كاملة للعرض — مع عدّ الاستخدام الحي من البيانات الفعلية. */
    async list() {
        const rows = await this.db.ScheduleSymbols.getAll();
        const { patterns } = await this.extractBuiltin();
        for (const r of rows) {
            try {
                r.usage_count = await this.db.ScheduleSymbols.usageCount(r.code, r.symbol_type, r.team);
            } catch (_) { r.usage_count = 0; }
        }
        return { symbols: rows, patterns };
    }

    /**
     * حمولة التشغيل للمحللات الأمامية — الرموز المخصصة الفعالة فقط،
     * مصنفة بنفس الشكل الذي تتوقعه دوال registerCustom في القواميس الأربعة.
     */
    async runtimePayload() {
        const custom = await this.db.ScheduleSymbols.getActiveCustom();
        const payload = { employeeSymbols: [], dayCodes: [], operationalCodes: [], shiftCodeRows: [] };
        for (const r of custom) {
            if (r.symbol_type === 'employee_symbol') {
                payload.employeeSymbols.push({ code: r.code, kind: r.group_name || 'admin', team: r.team || r.name || r.code, num: null });
            } else if (r.symbol_type === 'day_code') {
                payload.dayCodes.push({ code: r.code, group: r.group_name || 'office', name: r.name, shiftSide: r.shift_side || '' });
            } else if (r.symbol_type === 'operational_code') {
                payload.operationalCodes.push({
                    code: r.code, kind: r.group_name === 'rapid' ? 'rapid' : 'overlap',
                    durationH: r.hours, start: r.time_start, end: r.time_end,
                    shift: r.shift_side === 'صباحية' ? 'D' : r.shift_side === 'ليلية' ? 'N' : null,
                    explicitShift: r.shift_side === 'صباحية' || r.shift_side === 'ليلية'
                });
            }
            // أي رمز مخصص يقبل خلية اليوم وله أوقات يحتاج صف shift_codes ليحسبه النظام
            if (r.accepts_day_cell && r.time_start) {
                payload.shiftCodeRows.push({ code: r.code, name: r.name || r.code, time_start: r.time_start, time_end: r.time_end, status: 'دوام' });
            }
        }
        return payload;
    }

    /** التحقق من تعارض الرمز مع المحللات المدمجة (رفض الازدواج). */
    checkBuiltinConflict(code, symbolType) {
        const c = SymbolDictionary.normalize(code);
        if (symbolType === 'employee_symbol' && SymbolDictionary.resolveSymbol(c)) {
            return 'الرمز معروف مسبقًا في قاموس الرموز المدمج';
        }
        if (symbolType === 'day_code' || symbolType === 'operational_code') {
            for (const g of Object.keys(ShiftTypeDictionary.GROUPS)) {
                if (ShiftTypeDictionary.GROUPS[g].indexOf(c) !== -1) return 'الرمز معروف مسبقًا في قاموس أنواع المناوبات المدمج';
            }
        }
        if (symbolType === 'operational_code' && OperationalCodes.isOperationalCode(c)) {
            return 'الرمز يطابق نمطًا تشغيليًا مدمجًا مسبقًا (لا حاجة لتعريفه)';
        }
        return null;
    }

    /** إضافة رمز مخصص — مع التسجيل في المصدر الصحيح حسب نوعه. */
    async addCustom(data, actor) {
        const code = SymbolDictionary.normalize(data.code);
        if (!code) throw new Error('الرمز مطلوب');
        if (SYMBOL_TYPES.indexOf(data.symbol_type) === -1) throw new Error('نوع الرمز غير صالح');
        const conflict = this.checkBuiltinConflict(code, data.symbol_type);
        if (conflict) throw new Error(conflict);
        const dup = await this.db.ScheduleSymbols.getByCodeAndType(code, data.symbol_type);
        if (dup) throw new Error('الرمز موجود مسبقًا في السجل');

        const entry = {
            code, symbol_type: data.symbol_type,
            name: data.name || code,
            group_name: data.group_name || null,
            team: data.team || null,
            hours: data.hours ?? null,
            time_start: data.time_start || null,
            time_end: data.time_end || null,
            is_shift: data.is_shift ? 1 : 0,
            accepts_day_cell: data.accepts_day_cell ? 1 : 0,
            accepts_employee_symbol: data.accepts_employee_symbol ? 1 : 0,
            is_operational: data.symbol_type === 'operational_code' ? 1 : 0,
            shift_side: data.shift_side || '',
            source: 'custom', status: 'active',
            needs_review: 0, review_reason: null, usage_count: 0
        };

        // المصدر الصحيح: كود يوم/تشغيلي بأوقات يحتاج صف shift_codes حتى يحسبه
        // ScheduleMetricsService من الأولوية الأولى (time_start/time_end).
        if ((data.symbol_type === 'day_code' || data.symbol_type === 'operational_code') && data.time_start && data.time_end) {
            const existing = await this.db.ShiftCodes.getByCode(code);
            if (!existing) {
                await this.db.ShiftCodes.create({
                    code, name: entry.name,
                    time_start: data.time_start, time_end: data.time_end,
                    color: data.color || '#2E8B7A', status: 'دوام'
                });
            }
        }

        const id = await this.db.ScheduleSymbols.insert(entry);
        await this.db.SymbolAuditLog.add({
            actor_id: actor.id, actor_name: actor.name,
            action: 'add', code, old_value: null, new_value: entry
        });
        return { id, entry };
    }

    /** تعديل رمز — مع فحص الأثر التاريخي (بند 10) قبل الحسم. */
    async editSymbol(id, data, actor, confirmHistorical) {
        const cur = await this.db.ScheduleSymbols.getById(id);
        if (!cur) throw new Error('الرمز غير موجود');
        const usage = await this.db.ScheduleSymbols.usageCount(cur.code, cur.symbol_type, cur.team);
        const touchesHours = (data.time_start !== undefined && data.time_start !== cur.time_start)
            || (data.time_end !== undefined && data.time_end !== cur.time_end)
            || (data.hours !== undefined && data.hours !== cur.hours);
        if (usage > 0 && touchesHours && !confirmHistorical) {
            return { requiresConfirmation: true, usageCount: usage, code: cur.code };
        }
        await this.db.ScheduleSymbols.update(id, data, actor.name);
        // مزامنة صف shift_codes إن وُجد (مصدر حساب الساعات)
        if (cur.accepts_day_cell && (data.time_start || data.time_end)) {
            const sc = await this.db.ShiftCodes.getByCode(cur.code);
            if (sc) {
                await this.db.ShiftCodes.update(sc.id, {
                    code: sc.code, name: data.name || sc.name,
                    time_start: data.time_start || sc.time_start,
                    time_end: data.time_end || sc.time_end,
                    color: sc.color, status: sc.status
                });
            }
        }
        await this.db.SymbolAuditLog.add({
            actor_id: actor.id, actor_name: actor.name,
            action: 'edit', code: cur.code, old_value: cur, new_value: data
        });
        return { updated: true, historicalImpact: usage > 0 && touchesHours, usageCount: usage };
    }

    /** تعطيل/تفعيل — لا حذف أبدًا. */
    async setStatus(id, status, actor) {
        const cur = await this.db.ScheduleSymbols.getById(id);
        if (!cur) throw new Error('الرمز غير موجود');
        if (cur.source === 'builtin' && status === 'disabled') {
            throw new Error('الرموز المدمجة في القواميس لا تُعطَّل من هنا — تعطيلها يتطلب قرارًا وتعديل قاموس');
        }
        await this.db.ScheduleSymbols.update(id, { status }, actor.name);
        await this.db.SymbolAuditLog.add({
            actor_id: actor.id, actor_name: actor.name,
            action: status === 'disabled' ? 'disable' : 'enable',
            code: cur.code, old_value: { status: cur.status }, new_value: { status }
        });
        return { updated: true };
    }
}

module.exports = SymbolRegistryService;
