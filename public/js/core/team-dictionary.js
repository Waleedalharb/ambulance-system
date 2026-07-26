/**
 * ═══ قاموس ترتيب الفرق المركزي — team-dictionary.js ═══
 * المصدر الوحيد لترتيب الفرق في كل المنصة (بند 10):
 *   القيادة ← التحكم العملياتي/تنسيق الاستجابة ← جنوب 1..N طبيعي ← سريع 1..N ← الأوفرلاب ← الإدارات
 * أي قائمة فرق في أي شاشة يجب أن تمر عبر sortTeamNames من هنا فقط.
 * يعمل في المتصفح (window.TeamDictionary) وفي Node (module.exports).
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    root.TeamDictionary = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // مجموعات الترتيب — تعديل الترتيب مستقبلًا من هنا فقط
    var ORDER = {
        leadership: 1,   // القيادة
        control: 2,      // التحكم العملياتي / تنسيق الاستجابة
        south: 3,        // جنوب 1..N
        rapid: 4,        // سريع 1..N
        overlap: 5,      // الأوفرلاب
        admin: 6         // الإدارات والبقية
    };

    function teamSortKey(name) {
        var n = String(name || '').trim();
        if (n === 'القيادة' || n === 'القيادة الميدانية') return '0' + ORDER.leadership;
        if (n === 'القائد الميداني') return '0' + ORDER.leadership + '-2';
        if (n === 'التحكم العملياتي') return '0' + ORDER.control + '-1';
        if (n === 'تنسيق الاستجابة') return '0' + ORDER.control + '-2';
        var m = n.match(/^جنوب (\d+)$/);
        if (m) return '0' + ORDER.south + '-' + String(m[1]).padStart(3, '0');
        m = n.match(/^(?:سريع|تدخل سريع) (\d+)$/);
        if (m) return '0' + ORDER.rapid + '-' + String(m[1]).padStart(3, '0');
        if (n.indexOf('أوفرلاب') === 0) return '0' + ORDER.overlap + '-' + n;
        return '0' + ORDER.admin + '-' + n;
    }

    function sortTeamNames(arr) {
        return arr.slice().sort(function (a, b) {
            var ka = teamSortKey(a), kb = teamSortKey(b);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
        });
    }

    // فحص بنيوي ذاتي (يستدعيه system-validator)
    function validate() {
        var errors = [];
        var probe = sortTeamNames(['جنوب 10', 'جنوب 2', 'سريع 1', 'القيادة', 'أوفرلاب O12', 'التحكم العملياتي', 'إداري']);
        var expected = ['القيادة', 'التحكم العملياتي', 'جنوب 2', 'جنوب 10', 'سريع 1', 'أوفرلاب O12', 'إداري'];
        if (JSON.stringify(probe) !== JSON.stringify(expected)) {
            errors.push('ترتيب الفرق غير صحيح: ' + probe.join(' ← '));
        }
        if (teamSortKey('القيادة') >= teamSortKey('جنوب 1')) errors.push('القيادة يجب أن تكون أولًا');
        if (teamSortKey('جنوب 10') <= teamSortKey('جنوب 2')) errors.push('الترتيب الرقمي الطبيعي مكسور (جنوب 10 قبل 2)');
        return errors;
    }

    return {
        ORDER: ORDER,
        teamSortKey: teamSortKey,
        sortTeamNames: sortTeamNames,
        validate: validate
    };
}));
