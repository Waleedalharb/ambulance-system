/**
 * ═══ قاموس أنواع المناوبات المركزي — shift-type-dictionary.js ═══
 * المصدر الوحيد لتصنيف أكواد الأيام (D12/N12/N8/O12/WO/ME/V/VC/C/R...) في كل المنصة.
 * القاعدة الأساسية: الراحة الدورية جزء من دورة التشغيل ≠ الإجازة (استثناء عنها).
 * أي فئة مستقبلية تُضاف هنا فقط — ممنوع أي شرط على كود خارج هذا الملف.
 * يعمل في المتصفح (window.ShiftTypeDictionary) وفي Node (module.exports).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.ShiftTypeDictionary = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── فئات المناوبة التسع (المصدر الوحيد للفلاتر والإحصائيات والرسوم) ──
    // الدلالات الرسمية (تعريف المالك): S إجازة مرضية · E إجازة اختبارات · EV إجازة استثنائية
    // VC إجازة تعويضية · C دورة تدريبية · CP ساعات تكميلية · M مهمة رسمية · ME مكلف
    // WO دوام رسمي · XD إضافي صباحي · XN إضافي مسائي
    var GROUPS = {
        morning:  ['D', 'D12', 'D10', 'D11', 'D8', 'D6', 'M', 'CPD', 'CP8', 'CP24', 'XD', 'CP'],
        night:    ['N', 'N12', 'N10', 'N11', 'N6', 'CPN', 'XN'],
        night8:   ['N8', 'LN8', 'LN10'],
        overlap:  ['O12', 'O10', 'O13', 'O14', 'O14A', 'O14B', 'O15', 'O16', 'O12A', 'O12B', 'O12C', 'OVD', 'OVN'],
        office:   ['WO'],
        mission:  ['ME', 'F'],
        vacation: ['V', 'VC', 'E', 'EV', 'S'],
        rest:     ['R'],
        training: ['C'],
        off:      ['OFF']
    };

    // بطاقات العرض لكل فئة (تسمية موحدة لكل الشاشات)
    var LABELS = { morning: 'صباح', night: 'ليل', night8: 'ليل 8 ساعات', overlap: 'أوفرلاب', office: 'دوام رسمي', mission: 'مهمة رسمية', training: 'تدريب', rest: 'راحة دورية', vacation: 'إجازات', off: 'OFF', unscheduled: 'غير مجدول' };

    // حالة العرض (توافق النظام القديم)
    var STATUS = { morning: 'دوام', night: 'دوام', night8: 'دوام', overlap: 'دوام', office: 'دوام', mission: 'دوام', vacation: 'إجازة', rest: 'راحة', training: 'تدريب', off: 'OFF' };

    // فئات فلتر «نوع المناوبة» — بالترتيب المعتمد
    var FILTER_CATEGORIES = ['صباحية', 'ليلية', 'أوفرلاب', 'دوام رسمي', 'مهمة رسمية', 'راحة', 'إجازة', 'إجازة تعويضية', 'تدريب'];
    var FILTERCAT = { morning: 'صباحية', night: 'ليلية', night8: 'ليلية', overlap: 'أوفرلاب', office: 'دوام رسمي', mission: 'مهمة رسمية', rest: 'راحة', vacation: 'إجازة', training: 'تدريب', off: 'OFF' };

    // ترتيب وألوان مخطط التوزيع
    var CHART_ORDER = ['morning', 'night', 'night8', 'overlap', 'office', 'mission', 'training', 'rest', 'vacation', 'off', 'unscheduled'];
    var CHART_COLORS = { morning: '#D97706', night: '#475569', night8: '#94A3B8', overlap: '#0D9488', office: '#78716C', mission: '#B45309', training: '#65A30D', rest: '#D6D3D1', vacation: '#DC2626', off: '#A8A29E', unscheduled: '#E7E5E4' };

    // ── قوائم وردية الخادم (المصدر الوحيد لشاشة التكميل / current-shift) ──
    // القاموس الرسمي: الأوفرلاب جزء من المناوبة الليلية — الاستثناء الوحيد OvD (نهاري بتعريف المالك)
    var DAY_ONLY_CODES = ['D12', 'D10', 'D11', 'D8', 'D6', 'CPD', 'CP8', 'OVD', 'XD', 'CP'];
    var NIGHT_ONLY_CODES = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10', 'CPN', 'OVN', 'XN',
        'O12', 'O12A', 'O12B', 'O12C', 'O14', 'O14A', 'O14B', 'O15', 'O10', 'O13', 'O16', 'O6'];
    var SHARED_CODES = ['CP24', 'M', 'ME', 'F'];
    var OFF_CODES = ['V', 'VC', 'E', 'EV', 'S', 'WO', 'C'];

    var ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
    function normalize(code) {
        if (code === null || code === undefined) return '';
        return String(code)
            .replace(/[٠-٩]/g, function (d) { return ARABIC_DIGITS.indexOf(d); })
            .replace(/\s+/g, '')
            .toUpperCase();
    }

    // تصنيف كود يوم واحد ← { group, status, shift, filterCat, label }
    function classifyDayCode(code) {
        var c = normalize(code);
        if (!c) return { group: 'rest', status: STATUS.rest, shift: '', filterCat: FILTERCAT.rest, label: LABELS.rest };
        for (var g in GROUPS) {
            if (GROUPS[g].indexOf(c) !== -1) {
                // القاموس الرسمي: الأوفرلاب جزء من المناوبة الليلية — الاستثناء OvD نهاري
                var sh = (g === 'morning' || c === 'OVD') ? 'صباحية' : (g === 'night' || g === 'night8' || g === 'overlap') ? 'ليلية' : '';
                var fc = (c === 'VC') ? 'إجازة تعويضية' : FILTERCAT[g];
                return { group: g, status: STATUS[g], shift: sh, filterCat: fc, label: LABELS[g] };
            }
        }
        // رمز مدخل غير معروف = عمل (لا نفترض إجازة أبدًا)
        return { group: 'office', status: STATUS.office, shift: '', filterCat: FILTERCAT.office, label: LABELS.office };
    }

    // تصنيف سجل جدولة كامل — يفضّل الرمز، ويستنتج من الحقول القديمة عند غيابه
    function classifyEntry(sch) {
        if (normalize(sch.shiftCode || sch.code)) return classifyDayCode(sch.shiftCode || sch.code);
        if (sch.status === 'إجازة') return { group: 'vacation', status: 'إجازة', shift: sch.shift || '', filterCat: 'إجازة', label: LABELS.vacation };
        if (sch.status === 'راحة')  return { group: 'rest', status: 'راحة', shift: sch.shift || '', filterCat: 'راحة', label: LABELS.rest };
        if (sch.status === 'تدريب') return { group: 'training', status: 'تدريب', shift: sch.shift || '', filterCat: 'تدريب', label: LABELS.training };
        if (sch.status === 'OFF')   return { group: 'off', status: 'OFF', shift: sch.shift || '', filterCat: 'OFF', label: LABELS.off };
        var sh = String(sch.shift || '');
        var isNight = sh.indexOf('ليل') !== -1;
        var g = isNight ? 'night' : 'morning';
        return { group: g, status: 'دوام', shift: sch.shift || '', filterCat: FILTERCAT[g], label: LABELS[g] };
    }

    // ── دورة المناوبة: الراحة الدورية تُشتق من الدورة وليس من الفراغ ──
    // «غير مجدول» حصرًا للإداريين (إداري/صيانة/تموين/أكسجين/أجهزة) — قرار المستشار:
    // أي إسعافي/قيادة/عمليات بلا جدولة = خطأ في الجدول يُبلَّغ عنه، وليس تصنيفًا
    var ROTATION_KINDS = ['center', 'rapid', 'overlap', 'leadership', 'ops'];
    function isRotationEmployee(emp) {
        if (!emp) return false;
        if (emp.kind && ROTATION_KINDS.indexOf(emp.kind) !== -1) return true;
        var dn = 0;
        var sch = emp.schedule || [];
        for (var i = 0; i < sch.length; i++) {
            var g = classifyEntry(sch[i]).group;
            if (g === 'morning' || g === 'night' || g === 'night8') {
                dn++;
                if (dn >= 4) return true;
            }
        }
        return false;
    }

    // اليوم الفارغ لموظف: راحة دورية إن كان من موظفي الدورة، وإلا «غير مجدول»
    function blankDayGroup(emp) {
        return isRotationEmployee(emp) ? 'rest' : 'unscheduled';
    }

    // فحص بنيوي ذاتي (يستدعيه system-validator)
    function validate() {
        var errors = [];
        // لا كود في فئتين
        var owner = {};
        for (var g in GROUPS) {
            if (!GROUPS[g].length) errors.push('فئة فارغة: ' + g);
            for (var i = 0; i < GROUPS[g].length; i++) {
                var c = GROUPS[g][i];
                if (owner[c] && owner[c] !== g) errors.push('الكود ' + c + ' في فئتين: ' + owner[c] + ' و ' + g);
                owner[c] = g;
            }
            if (!STATUS[g]) errors.push('فئة بلا حالة: ' + g);
            if (!FILTERCAT[g]) errors.push('فئة بلا فلتر: ' + g);
            if (!LABELS[g]) errors.push('فئة بلا تسمية: ' + g);
        }
        if (!FILTER_CATEGORIES.length) errors.push('فئات الفلتر فارغة');
        // نهاري ∩ ليلي = ∅
        for (var d = 0; d < DAY_ONLY_CODES.length; d++) {
            if (NIGHT_ONLY_CODES.indexOf(DAY_ONLY_CODES[d]) !== -1) errors.push('كود نهاري وليلي معًا: ' + DAY_ONLY_CODES[d]);
        }
        if (!DAY_ONLY_CODES.length || !NIGHT_ONLY_CODES.length) errors.push('قوائم وردية الخادم فارغة');
        return errors;
    }

    return {
        GROUPS: GROUPS,
        LABELS: LABELS,
        STATUS: STATUS,
        FILTER_CATEGORIES: FILTER_CATEGORIES,
        FILTERCAT: FILTERCAT,
        CHART_ORDER: CHART_ORDER,
        CHART_COLORS: CHART_COLORS,
        DAY_ONLY_CODES: DAY_ONLY_CODES,
        NIGHT_ONLY_CODES: NIGHT_ONLY_CODES,
        SHARED_CODES: SHARED_CODES,
        OFF_CODES: OFF_CODES,
        normalize: normalize,
        classifyDayCode: classifyDayCode,
        classifyEntry: classifyEntry,
        isRotationEmployee: isRotationEmployee,
        blankDayGroup: blankDayGroup,
        validate: validate
    };
}));
