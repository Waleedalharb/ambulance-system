/**
 * ═══ المدقق المركزي — system-validator.js ═══
 * يعمل عند إقلاع الخادم (واختياريًا في المتصفح):
 *   يفحص القواميس · الرموز المكررة · الرموز غير المعروفة · ترتيب الفرق · تغطية الموظفين
 * عند أي فشل: تقرير ❌ واضح + رفض التشغيل — لا يبدأ الخادم بقواميس معطوبة.
 * يعمل في المتصفح (window.SystemValidator) وفي Node (module.exports).
 */
(function (root, factory) {
    var isNode = (typeof module !== 'undefined' && module.exports);
    var api;
    if (isNode) {
        api = factory(
            require('./symbol-dictionary.js'),
            require('./shift-type-dictionary.js'),
            require('./team-dictionary.js')
        );
        module.exports = api;
    } else {
        api = factory(root.SymbolDictionary, root.ShiftTypeDictionary, root.TeamDictionary);
    }
    root.SystemValidator = api;
}(typeof self !== 'undefined' ? self : this, function (SymbolDictionary, ShiftTypeDictionary, TeamDictionary) {
    'use strict';

    // فحص رموز الموظفين (يُستدعى عند الاستيراد أو عند توفر قائمة رموز)
    function validateEmployees(entries) {
        var errors = [];
        (entries || []).forEach(function (e) {
            var sym = e.symbol || e;
            var label = e.name ? (sym + ' — ' + e.name) : String(sym);
            if (!SymbolDictionary.resolveSymbol(sym)) errors.push('رمز مجهول: ' + label);
        });
        return errors;
    }

    // deps اختيارية للاختبار (حقن قواميس معطوبة)
    function validateAll(deps) {
        deps = deps || {};
        var SD = deps.symbolDict || SymbolDictionary;
        var STD = deps.shiftDict || ShiftTypeDictionary;
        var TD = deps.teamDict || TeamDictionary;
        var checks = [];

        // 1) الرموز
        (function () {
            var errors = [];
            if (!SD) errors.push('قاموس الرموز غير محمّل');
            else {
                if (!SD.CODE_MAP || Object.keys(SD.CODE_MAP).length === 0) errors.push('قاموس الرموز فارغ');
                if (typeof SD.validate === 'function') errors = errors.concat(SD.validate());
            }
            checks.push({ name: 'Symbols', ok: errors.length === 0, errors: errors });
        })();

        // 2) أنواع المناوبات
        (function () {
            var errors = [];
            if (!STD) errors.push('قاموس أنواع المناوبات غير محمّل');
            else if (typeof STD.validate === 'function') errors = errors.concat(STD.validate());
            checks.push({ name: 'Shift Types', ok: errors.length === 0, errors: errors });
        })();

        // 3) ترتيب الفرق
        (function () {
            var errors = [];
            if (!TD) errors.push('قاموس ترتيب الفرق غير محمّل');
            else if (typeof TD.validate === 'function') errors = errors.concat(TD.validate());
            checks.push({ name: 'Team Order', ok: errors.length === 0, errors: errors });
        })();

        // 4) الموظفون — يُدقق عند الاستيراد (تقرير الاستيراد يبلّغ عن المجهول/الميداني بلا مناوبات)
        checks.push({ name: 'Employees', ok: true, errors: [], note: 'تُدقق عند الاستيراد' });

        var ok = checks.every(function (c) { return c.ok; });
        return { ok: ok, checks: checks };
    }

    // صيغة التقرير المعتمدة
    function formatReport(result) {
        var lines = ['', '═══ System Validation ═══', ''];
        result.checks.forEach(function (c) {
            if (c.ok) {
                lines.push('✅ ' + c.name + ' OK' + (c.note ? ' (' + c.note + ')' : ''));
            } else {
                c.errors.forEach(function (e) { lines.push('❌ ' + e); });
            }
        });
        lines.push('');
        lines.push(result.ok ? 'Server Ready ✅' : 'Server Startup Cancelled ❌');
        lines.push('');
        return lines.join('\n');
    }

    // نقطة الإقلاع: يفحص ويطبع ويرمي عند الفشل (رفض التشغيل)
    function assertValid(logger) {
        var result = validateAll();
        var report = formatReport(result);
        (logger || console.log)(report);
        if (!result.ok) {
            throw new Error('إلغاء تشغيل الخادم — أخطاء في القواميس المركزية (راجع التقرير أعلاه)');
        }
        return result;
    }

    return {
        validateAll: validateAll,
        validateEmployees: validateEmployees,
        formatReport: formatReport,
        assertValid: assertValid
    };
}));
