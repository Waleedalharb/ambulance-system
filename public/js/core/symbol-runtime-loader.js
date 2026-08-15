/**
 * ═══ محمّل الرموز المخصصة وقت التشغيل — symbol-runtime-loader.js ═══
 * يجلب الرموز المخصصة الفعالة من /api/schedule-symbols/runtime ويسجلها في
 * القواميس الأربعة عبر دوال registerCustom الإضافية فقط.
 *
 * الضمانات:
 *  - لا يغيّر أي رمز مدمج: القواميس نفسها ترفض أي تجاوز (registerCustom).
 *  - الفشل صامت: غياب الخادم/التوكن يبقي السلوك المدمج كما هو حرفيًا.
 *  - يُحمَّل بعد القواميس في وسم script، ويُستدعى مرة واحدة عند بدء الصفحة.
 *
 * الاستخدام:
 *   <script src="js/core/symbol-runtime-loader.js"></script>
 *   <script>SymbolRuntimeLoader.load();</script>
 */
(function (root) {
    'use strict';

    function getToken() {
        try {
            if (root.CoreAuth && typeof root.CoreAuth.getToken === 'function') return root.CoreAuth.getToken();
        } catch (_) { /* تجاهل */ }
        try {
            return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');
        } catch (_) { return null; }
    }

    var _loaded = false;
    var _stats = { employeeSymbols: 0, dayCodes: 0, operationalCodes: 0, shiftCodeRows: 0 };

    async function load() {
        if (_loaded) return _stats; // مرة واحدة لكل صفحة
        var token = getToken();
        if (!token) return _stats;
        var res;
        try {
            res = await fetch('/api/schedule-symbols/runtime', {
                headers: { 'Authorization': 'Bearer ' + token }
            });
        } catch (_) { return _stats; } // بلا اتصال — السلوك المدمج يكفي
        if (!res || !res.ok) return _stats;
        var payload;
        try { payload = await res.json(); } catch (_) { return _stats; }
        if (!payload || payload.success === false) return _stats;

        // 1) رموز الموظفين المخصصة ← SymbolDictionary
        if (root.SymbolDictionary && Array.isArray(payload.employeeSymbols)) {
            payload.employeeSymbols.forEach(function (s) {
                if (root.SymbolDictionary.registerCustom(s.code, { kind: s.kind, team: s.team, num: s.num })) _stats.employeeSymbols++;
            });
        }
        // 2) أكواد الأيام المخصصة ← ShiftTypeDictionary (+ قائمة الوردية)
        if (root.ShiftTypeDictionary && Array.isArray(payload.dayCodes)) {
            payload.dayCodes.forEach(function (s) {
                if (root.ShiftTypeDictionary.registerCustom(s.code, s.group, s.shiftSide)) _stats.dayCodes++;
            });
        }
        // 3) الأكواد التشغيلية المخصصة ← OperationalCodes
        if (root.OperationalCodes && Array.isArray(payload.operationalCodes)) {
            payload.operationalCodes.forEach(function (s) {
                if (root.OperationalCodes.registerCustom(s.code, s)) _stats.operationalCodes++;
            });
        }
        // 4) صفوف shift_codes للعرض والحساب الأمامي ← shift-codes-config
        if (typeof root.registerCustomShiftCode === 'function' && Array.isArray(payload.shiftCodeRows)) {
            payload.shiftCodeRows.forEach(function (s) {
                if (root.registerCustomShiftCode(s)) _stats.shiftCodeRows++;
            });
        }

        _loaded = true;
        return _stats;
    }

    root.SymbolRuntimeLoader = {
        load: load,
        stats: function () { return Object.assign({}, _stats); },
        isLoaded: function () { return _loaded; }
    };
}(typeof window !== 'undefined' ? window : this));
