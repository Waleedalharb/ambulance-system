/**
 * place-suggestion.js — عرض «هوية الموقع» في بطاقة البلاغ (PI-7)
 * اعتماد المالك 2026-08-30 — عرض قراءة فقط لتلميح خارجي:
 *  - الجلب من GET /api/cad-reports/:number/place-suggestion (محروس بـops.reports).
 *  - 403/شبكة/فشل ← إخفاء صامت للمساحة (لا يتعطل أي عرض قائم).
 *  - الوسم «اقتراح خارجي — غير معتمد» إلزامي في كل الحالات.
 *  - لا يُكتب أي شيء في البلاغ — DOM عرضي فقط.
 */
(function () {
    'use strict';

    var TYPE_META = {
        school:          { emoji: '🏫', label: 'مدرسة' },
        university:      { emoji: '🎓', label: 'جامعة/كلية' },
        hospital:        { emoji: '🏥', label: 'مستشفى' },
        health_center:   { emoji: '🩺', label: 'مركز صحي' },
        police:          { emoji: '🚓', label: 'مركز شرطة' },
        prison:          { emoji: '🔒', label: 'سجن' },
        government:      { emoji: '🏛️', label: 'جهة حكومية' },
        mosque:          { emoji: '🕌', label: 'مسجد' },
        mall:            { emoji: '🏬', label: 'مجمع تجاري' },
        sports:          { emoji: '🏟️', label: 'ملعب/منشأة رياضية' },
        public_facility: { emoji: '🏞️', label: 'منشأة عامة' },
        construction:    { emoji: '🏗️', label: 'موقع إنشائي' },
        other:           { emoji: '📍', label: 'معلم' }
    };

    function esc(s) { return (typeof escapeHtml === 'function') ? escapeHtml(String(s)) : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    function lineFor(c) {
        var m = TYPE_META[c.placeType] || TYPE_META.other;
        return m.emoji + ' ' + esc(c.name) + ' — ' + c.distanceM + 'م';
    }

    function render(result) {
        var box = 'border:1px solid rgba(147,130,220,.4); background:rgba(147,130,220,.08); border-radius:8px; padding:5px 9px; margin-top:5px; font-size:.8rem;';
        var tag = '<div style="opacity:.65; font-size:.72rem; margin-top:2px;">اقتراح خارجي — غير معتمد</div>';
        if (!result || !result.outcome) return '';
        if (result.outcome === 'dominant' && result.suggestions && result.suggestions.length) {
            return '<div style="' + box + '">📍 <b>هوية الموقع</b><br>' +
                lineFor(result.suggestions[0]) + tag + '</div>';
        }
        if ((result.outcome === 'ambiguous' || result.outcome === 'conflict') && result.suggestions && result.suggestions.length) {
            return '<div style="' + box + '">📍 <b>هوية الموقع غير محسومة</b><br>' +
                result.suggestions.map(lineFor).join('<br>') +
                '<br><span style="color:#EAB308;">⚠️ يوجد أكثر من معلم قريب</span>' + tag + '</div>';
        }
        if (result.outcome === 'no-match') {
            return '<div style="' + box + '">📍 <b>هوية الموقع</b><br>' +
                '<span style="opacity:.8;">لم يتم التعرف على معلم قريب</span>' + tag + '</div>';
        }
        return ''; // disabled / provider-error / budget-exhausted / no-coords ← لا شيء يظهر
    }

    async function fillSlot(slot) {
        var number = slot.getAttribute('data-num');
        if (!number) return;
        try {
            var res = await AuthManager.apiRequest('/api/cad-reports/' + encodeURIComponent(number) + '/place-suggestion');
            if (res.status === 403) return;            // بلا صلاحية مشاهدة — إخفاء صامت
            if (!res.ok) return;
            var data = await res.json();
            var html = render(data);
            if (html) slot.innerHTML = html;
        } catch (e) { /* فشل العرض لا يمس البطاقة */ }
    }

    /** تعبئة كل مساحات الاقتراح داخل حاوية (تُستدعى بعد رسم سجل البلاغات) */
    function hydrate(container) {
        if (!container || !window.AuthManager || !AuthManager.isLoggedIn()) return;
        var slots = container.querySelectorAll('.pi-sugg-slot[data-num]');
        slots.forEach(function (slot) {
            if (slot.getAttribute('data-filled') === '1') return;
            slot.setAttribute('data-filled', '1');
            fillSlot(slot);
        });
    }

    window.PlaceSuggestion = { hydrate: hydrate, render: render };
})();
