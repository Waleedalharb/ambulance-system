/**
 * ═══ قاموس الرموز المركزي — symbol-dictionary.js ═══
 * المصدر الوحيد لترجمة رموز الفرق (A0/A00/AA10/RRA/X/YY/O12A/OvN...) في كل المنصة.
 * القاعدة: لا يُسمح بأي شرط على رمز (if code == "A00") خارج هذا الملف.
 * أي رمز مستقبلي يُضاف هنا فقط.
 * يعمل في المتصفح (window.SymbolDictionary) وفي Node (module.exports).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.SymbolDictionary = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── مدخلات الرموز الثابتة (القاموس الرسمي للقطاع) ──
    // مصفوفة [رمز, تعريف] — وليست كائنًا — حتى يُكشف أي رمز مكرر عند التحميل (كائن JS يسحق التكرار بصمت)
    // kind: leadership قيادة · center مركز جنوب · rapid تدخل سريع · ops عمليات · admin إدارة · overlap أوفرلاب
    // jobTitleTeam: المسمى النهائي يُحسم من طبيعة عمل الموظف (مثل تنسيق الاستجابة)
    var CODE_ENTRIES = [
        // القيادة الميدانية (قائد المجموعة / كبير المسعفين ومساعده) — الاسم التشغيلي المعتمد من المالك
        ['A0', { kind: 'leadership', team: 'القيادة الميدانية' }], ['B0', { kind: 'leadership', team: 'القيادة الميدانية' }],
        ['C0', { kind: 'leadership', team: 'القيادة الميدانية' }], ['D0', { kind: 'leadership', team: 'القيادة الميدانية' }],
        // التحكم العملياتي — وإن كانت طبيعة العمل «تنسيق استجابة» فالمسمى تنسيق الاستجابة
        ['A00', { kind: 'ops', team: 'التحكم العملياتي', jobTitleTeam: true }], ['B00', { kind: 'ops', team: 'التحكم العملياتي', jobTitleTeam: true }],
        ['C00', { kind: 'ops', team: 'التحكم العملياتي', jobTitleTeam: true }], ['D00', { kind: 'ops', team: 'التحكم العملياتي', jobTitleTeam: true }],
        // جنوب 10 (ديراب) — كل الصيغ التاريخية والرسمية فريق واحد
        ['AA', { kind: 'center', team: 'جنوب 10', num: 10 }], ['A10', { kind: 'center', team: 'جنوب 10', num: 10 }],
        ['AA10', { kind: 'center', team: 'جنوب 10', num: 10 }], ['BB10', { kind: 'center', team: 'جنوب 10', num: 10 }],
        ['CC10', { kind: 'center', team: 'جنوب 10', num: 10 }], ['DD10', { kind: 'center', team: 'جنوب 10', num: 10 }],
        ['BB', { kind: 'center', team: 'جنوب 10', num: 10 }], ['CC', { kind: 'center', team: 'جنوب 10', num: 10 }],
        ['DD', { kind: 'center', team: 'جنوب 10', num: 10 }],
        // التدخل السريع — الصيغة القديمة والرسمية
        ['AR', { kind: 'rapid', team: 'سريع 1' }], ['BR', { kind: 'rapid', team: 'سريع 2' }],
        ['CR', { kind: 'rapid', team: 'سريع 3' }], ['DR', { kind: 'rapid', team: 'سريع 4' }],
        ['ARR', { kind: 'rapid', team: 'سريع 1' }], ['BRR', { kind: 'rapid', team: 'سريع 2' }],
        ['CRR', { kind: 'rapid', team: 'سريع 3' }], ['DRR', { kind: 'rapid', team: 'سريع 4' }],
        ['RRA', { kind: 'rapid', team: 'سريع 1' }], ['RRB', { kind: 'rapid', team: 'سريع 2' }],
        ['RRC', { kind: 'rapid', team: 'سريع 3' }], ['RRD', { kind: 'rapid', team: 'سريع 4' }],
        // الإدارات (القاموس الرسمي)
        ['0', { kind: 'admin', team: 'إداري' }], // رمز صفر في الملفات الرسمية = إداري
        ['X', { kind: 'ops', team: 'العمليات' }],
        ['XX', { kind: 'admin', team: 'إدارة الإجازات' }],
        // XX1/XX2 = تجمع إدارة الإجازات (إجازة طول الشهر ومن يغطّونها) — تعريف المالك
        ['XX1', { kind: 'admin', team: 'إدارة الإجازات' }], ['XX2', { kind: 'admin', team: 'إدارة الإجازات' }],
        // XY = إداري / دعم لوجستي — تعريف المالك
        ['XY', { kind: 'admin', team: 'الدعم اللوجستي' }],
        ['XW1', { kind: 'ops', team: 'العمليات' }], ['XW2', { kind: 'ops', team: 'العمليات' }],
        ['XW3', { kind: 'ops', team: 'العمليات' }], ['XW4', { kind: 'ops', team: 'العمليات' }], ['XW5', { kind: 'ops', team: 'العمليات' }],
        ['Y', { kind: 'admin', team: 'إداري' }],
        ['YY', { kind: 'admin', team: 'صيانة مركبات' }],
        ['YYY', { kind: 'admin', team: 'تموين طبي' }],
        ['YYYY', { kind: 'admin', team: 'أكسجين' }],
        ['Z', { kind: 'admin', team: 'صيانة أجهزة طبية' }],
        // الأوفرلاب الحديث
        ['OVN', { kind: 'overlap', team: 'أوفرلاب ليلي' }],
        ['OVD', { kind: 'overlap', team: 'أوفرلاب نهاري' }]
    ];

    var VALID_KINDS = ['leadership', 'center', 'rapid', 'ops', 'admin', 'overlap'];

    // البناء مع رفض التكرار: أي رمز مكرر = توقف فوري برسالة واضحة (حماية القواميس)
    function buildCodeMap(entries) {
        var map = {};
        for (var i = 0; i < entries.length; i++) {
            var code = entries[i][0];
            if (Object.prototype.hasOwnProperty.call(map, code)) {
                throw new Error('قاموس الرموز: رمز مكرر «' + code + '» — صحّح js/core/symbol-dictionary.js قبل التشغيل');
            }
            map[code] = entries[i][1];
        }
        return map;
    }
    var CODE_MAP = buildCodeMap(CODE_ENTRIES);

    // فحص بنيوي ذاتي (يستدعيه system-validator)
    function validate() {
        var errors = [];
        var seen = {};
        for (var i = 0; i < CODE_ENTRIES.length; i++) {
            var code = CODE_ENTRIES[i][0], def = CODE_ENTRIES[i][1];
            if (seen[code]) errors.push('رمز مكرر: ' + code);
            seen[code] = true;
            if (!code || typeof code !== 'string') errors.push('رمز غير صالح في المدخل رقم ' + i);
            if (!def || VALID_KINDS.indexOf(def.kind) === -1) errors.push('نوع مجهول للرمز ' + code + ': ' + (def && def.kind));
            if (!def || typeof def.team !== 'string' || !def.team.trim()) errors.push('فريق فارغ للرمز ' + code);
        }
        // النطاق الصريح للأوفرلاب (1-19): O12C13 يبقى جنوب 13 (لا جنوب 1 + «3»)، وجنوب 1-10 مقبولة
        var p13 = resolveSymbol('O12C13');
        if (!p13 || p13.kind !== 'overlap' || p13.team !== 'جنوب 13' || p13.overlapCrew !== 'O12C') errors.push('فك الكود الصريح مكسور: O12C13');
        var p5 = resolveSymbol('O12C5');
        if (!p5 || p5.kind !== 'overlap' || p5.team !== 'جنوب 5') errors.push('فك الكود الصريح مكسور: O12C5 (جنوب 1-10)');
        return errors;
    }

    var ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

    // التطبيع المركزي: أرقام عربية ← إنجليزية · إزالة مسافات · أحرف كبيرة · A01 ← A1
    // لكن A00 يبقى A00 (تحكم عملياتي ≠ قيادة A0)
    function normalize(code) {
        if (code === null || code === undefined) return '';
        var s = String(code)
            .replace(/[٠-٩]/g, function (d) { return ARABIC_DIGITS.indexOf(d); })
            .replace(/\s+/g, '')
            .toUpperCase();
        var m = s.match(/^([A-Z]+)0+([1-9]\d*)$/);
        if (m) return m[1] + parseInt(m[2], 10);
        return s;
    }

    // الترجمة المركزية: رمز خام (+ طبيعة العمل اختياريًا) ← { kind, team, num }
    // قاعدة تنسيق الاستجابة محسومة هنا فقط.
    function resolveSymbol(rawSym, jobNature) {
        var sym = normalize(rawSym);
        if (!sym) return null;
        var hit = CODE_MAP[sym];
        if (hit) {
            var out = { kind: hit.kind, team: hit.team, num: hit.num || null };
            if (hit.jobTitleTeam && jobNature && String(jobNature).indexOf('تنسيق') !== -1) {
                out.team = 'تنسيق الاستجابة';
            }
            return out;
        }
        var m;
        // التدخل السريع — الصيغة الجديدة RRC1/RRB2 (تعريف المالك):
        // الحرف = دورية المناوبة، الرقم = السيارة. RRC1 ← سريع 1 · RRB2 ← سريع 2
        m = sym.match(/^RR([A-D])([1-9]\d?)$/);
        if (m) return { kind: 'rapid', team: 'سريع ' + parseInt(m[2], 10), num: parseInt(m[2], 10) };
        // الفرق الإسعافية A1..A19 (وبقية المجموعات B/C/D)
        m = sym.match(/^([A-D])([1-9]\d?)$/);
        if (m) return { kind: 'center', team: 'جنوب ' + parseInt(m[2], 10), num: parseInt(m[2], 10) };
        // الدعم اللوجستي AT/BT/CT/DT
        m = sym.match(/^([A-D])T$/);
        if (m) return { kind: 'admin', team: 'الدعم اللوجستي', num: null };
        // الدعم اللوجستي AZ/BZ/CZ/DZ — الصيغة الرسمية في جدول القطاع (تعريف المالك)
        m = sym.match(/^([A-D])Z$/);
        if (m) return { kind: 'admin', team: 'الدعم اللوجستي', num: null };
        // AW/BW/CW/DW — مرحلو العمليات
        m = sym.match(/^([A-D])W$/);
        if (m) return { kind: 'ops', team: 'العمليات', num: null };
        // الأوفرلاب بتعيين صريح من الإكسل (تعريف المالك): O12C13 = طاقم O12C
        // على سيارة جنوب 13 تحديدًا — الإداري يوزّع من ملف الجدول مباشرة،
        // وينعكس في التكميل كفريق عادي بلا أي انتشار تلقائي. النطاق 1-19
        // (كل فرق الجنوب الموجودة فعلًا — الأوفرلاب قد يُسند لسد نقص في
        // جنوب 1-10 أيضًا عبر نفس آلية الكود الصريح — قرار المالك).
        // «13» تُقرأ رقمًا واحدًا ([1-9] لا تلتهم «1» ثم تترك «3» بفضل مرساة النهاية).
        m = sym.match(/^O(\d+)([A-Z])([1-9]|1[0-9])$/);
        if (m) return { kind: 'overlap', team: 'جنوب ' + parseInt(m[3], 10), num: parseInt(m[3], 10), overlapCrew: 'O' + m[1] + m[2] };
        // فرق الأوفرلاب الكلاسيكية O12A/O12B/O12C/O14B/O15...
        m = sym.match(/^O(\d+)([A-Z]?)$/);
        if (m) return { kind: 'overlap', team: 'أوفرلاب O' + m[1] + m[2], num: parseInt(m[1], 10) };
        return null;
    }

    return {
        CODE_MAP: CODE_MAP,
        VALID_KINDS: VALID_KINDS,
        normalize: normalize,
        resolveSymbol: resolveSymbol,
        validate: validate
    };
}));
