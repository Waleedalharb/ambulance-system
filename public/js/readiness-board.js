/**
 * ═══ readiness-board.js — «استعداد الفرق الآن» v4.3.1 (قراءة فقط صِرفة) ═══
 * وضعان من نفس المصدر GET /api/ops/readiness/teams — لا حساب جاهزية هنا:
 *   · card (صفحة التكميل): بطاقة مختصرة بالعدّادات الأربع ← الضغط ينقل لصفحة
 *     التفاصيل في نفس التبويب (زر الرجوع يعمل طبيعيًا).
 *   · full (readiness-board.html): الملخص + الجدول + زر تحديث يدوي + تحديث دوري.
 * الضغط على فرقة لها جلسة ← check-review.html في نفس التبويب (قراءة فقط).
 * غياب الصلاحية (401/403): إخفاء صامت في وضع البطاقة، رسالة واضحة في صفحة التفاصيل.
 * لا كتابة ولا POST من هذا الملف إطلاقًا.
 */
(function () {
    'use strict';
    var REFRESH_MS = 60000;

    function token() {
        return (window.AuthCore && AuthCore.getToken) ? AuthCore.getToken()
            : (localStorage.getItem('auth_access_token') || localStorage.getItem('authToken'));
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function ensureStyle() {
        if (document.getElementById('rdyBoardStyle')) return;
        var st = document.createElement('style');
        st.id = 'rdyBoardStyle';
        st.textContent =
            '#readinessBoard{direction:rtl;font-family:inherit;margin:10px 16px}' +
            /* بطاقة مختصرة (وضع card) */
            '.rdb-mini{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:10px 14px;cursor:pointer;transition:border-color .15s}' +
            '.rdb-mini:hover{border-color:rgba(126,226,184,.45)}' +
            '.rdb-mini-title{font-weight:800;color:#c9d6e4;font-size:.86rem}' +
            '.rdb-mini-hint{color:#8b98a9;font-size:.72rem;margin-inline-start:auto}' +
            /* الملخص والعدّادات */
            '.rdb-sum{border-radius:8px;padding:3px 10px;font-weight:800;font-size:.78rem;border:1px solid transparent;white-space:nowrap}' +
            '.rdb-s-green{color:#7EE2B8;background:rgba(14,164,122,.12);border-color:rgba(14,164,122,.4)}' +
            '.rdb-s-yellow{color:#EADDA8;background:rgba(232,200,74,.10);border-color:rgba(232,200,74,.4)}' +
            '.rdb-s-red{color:#FCA5A5;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45)}' +
            '.rdb-s-none{color:#8b98a9;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}' +
            /* صفحة التفاصيل (وضع full) */
            '.rdb-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px 14px}' +
            '.rdb-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}' +
            '.rdb-refresh{margin-inline-start:auto;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:#c9d6e4;border-radius:8px;padding:4px 12px;font-size:.76rem;font-weight:700;cursor:pointer}' +
            '.rdb-refresh:hover{background:rgba(255,255,255,.12)}' +
            '.rdb-table{width:100%;border-collapse:collapse;font-size:.78rem}' +
            '.rdb-table th{color:#8b98a9;font-weight:700;text-align:right;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.09)}' +
            '.rdb-table td{padding:7px 8px;border-bottom:1px solid rgba(255,255,255,.05);color:#c9d6e4}' +
            '.rdb-table tr.rdb-link{cursor:pointer}' +
            '.rdb-table tr.rdb-link:hover td{background:rgba(255,255,255,.04)}' +
            '.rdb-pill{display:inline-block;border-radius:7px;padding:2px 9px;font-weight:800;border:1px solid transparent;white-space:nowrap}' +
            '.rdb-p-green{color:#7EE2B8;background:rgba(14,164,122,.12);border-color:rgba(14,164,122,.4)}' +
            '.rdb-p-yellow{color:#EADDA8;background:rgba(232,200,74,.10);border-color:rgba(232,200,74,.4)}' +
            '.rdb-p-red{color:#FCA5A5;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45)}' +
            '.rdb-p-none{color:#8b98a9;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}' +
            '.rdb-empty{color:#8b98a9;font-size:.8rem;padding:8px 2px}';
        document.head.appendChild(st);
    }

    var PILL = {
        green: '<span class="rdb-pill rdb-p-green">🟢 جاهزة</span>',
        yellow: '<span class="rdb-pill rdb-p-yellow">🟡 جزئية</span>',
        red: '<span class="rdb-pill rdb-p-red">🔴 غير جاهزة</span>',
        none: '<span class="rdb-pill rdb-p-none">⚪ لم تُسجّل</span>'
    };

    function fmtTime(iso) {
        if (!iso) return '—';
        try {
            return new Intl.DateTimeFormat('ar-SA', { timeZone: 'Asia/Riyadh', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
        } catch (_) { return '—'; }
    }

    function sumChips(sum) {
        return '<span class="rdb-sum rdb-s-green">🟢 ' + sum.green + ' جاهزة</span>' +
            '<span class="rdb-sum rdb-s-yellow">🟡 ' + sum.yellow + ' جزئية</span>' +
            '<span class="rdb-sum rdb-s-red">🔴 ' + sum.red + ' غير جاهزة</span>' +
            '<span class="rdb-sum rdb-s-none">⚪ ' + sum.unrecorded + ' لم تُسجّل</span>';
    }

    /* بطاقة مختصرة في صفحة التكميل — الضغط ← صفحة التفاصيل في نفس التبويب */
    function renderCard(el, data) {
        var sum = (data && data.summary) || { green: 0, yellow: 0, red: 0, unrecorded: 0 };
        el.innerHTML = '<div class="rdb-mini" role="button" tabindex="0">' +
            '<span class="rdb-mini-title">🚑 استعداد الفرق الآن</span>' +
            sumChips(sum) +
            '<span class="rdb-mini-hint">اضغط لعرض التفاصيل ◂</span>' +
            '</div>';
        var mini = el.querySelector('.rdb-mini');
        function go() { window.location.href = '/readiness-board.html'; } // نفس التبويب — الرجوع يعمل
        mini.addEventListener('click', go);
        mini.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') go(); });
    }

    /* صفحة التفاصيل — الملخص + الجدول + زر تحديث يدوي */
    function renderFull(el, data) {
        var rows = (data && data.rows) || [];
        var sum = (data && data.summary) || { green: 0, yellow: 0, red: 0, unrecorded: 0 };
        var body = rows.map(function (r) {
            var pill = r.readiness ? PILL[r.readiness] : PILL.none;
            var title = r.readinessReason ? ' title="' + esc(r.readinessReason) + '"' : '';
            var link = r.sessionId ? ' class="rdb-link" data-session="' + r.sessionId + '"' : '';
            return '<tr' + link + title + '>' +
                '<td><b>' + esc(r.teamName) + '</b></td>' +
                '<td>' + esc(r.center || '—') + '</td>' +
                '<td>' + esc(r.vehicleName || '—') + '</td>' +
                '<td>' + esc(r.checkState) + '</td>' +
                '<td>' + pill + '</td>' +
                '<td>' + fmtTime(r.lastUpdate) + '</td>' +
                '</tr>';
        }).join('');
        el.innerHTML = '<div class="rdb-card">' +
            '<div class="rdb-head">' +
            sumChips(sum) +
            '<button type="button" class="rdb-refresh" id="rdbRefresh">↻ تحديث</button>' +
            '</div>' +
            (rows.length
                ? '<table class="rdb-table"><thead><tr><th>الفرقة</th><th>المركز</th><th>المركبة</th><th>حالة التشييك</th><th>الجاهزية</th><th>آخر تحديث</th></tr></thead><tbody>' + body + '</tbody></table>'
                : '<div class="rdb-empty">لا توجد فرق ميدانية مكلّفة اليوم.</div>') +
            '</div>';
        var btn = document.getElementById('rdbRefresh');
        if (btn) btn.addEventListener('click', function () { load(el, 'full'); });
        Array.prototype.forEach.call(el.querySelectorAll('tr.rdb-link'), function (tr) {
            tr.addEventListener('click', function () {
                // مراجعة قراءة فقط — نفس التبويب حتى يعمل زر الرجوع طبيعيًا
                window.location.href = '/check-review.html?session=' + tr.getAttribute('data-session');
            });
        });
    }

    async function load(el, mode) {
        var t = token();
        if (!t) {
            if (mode === 'full') { window.location.href = '/'; } // صفحة مستقلة — بلا جلسة ← الدخول
            return;
        }
        try {
            var r = await fetch('/api/ops/readiness/teams', { headers: { Authorization: 'Bearer ' + t } });
            if (r.status === 403 || r.status === 401) {
                if (mode === 'full') {
                    ensureStyle();
                    el.innerHTML = '<div class="rdb-card"><div class="rdb-empty">لا تملك صلاحية عرض لوحة الاستعداد.</div></div>';
                } else {
                    el.style.display = 'none'; // إخفاء صامت في البطاقة
                }
                return;
            }
            if (!r.ok) return;
            ensureStyle();
            el.style.display = '';
            var data = await r.json();
            if (mode === 'full') renderFull(el, data); else renderCard(el, data);
        } catch (_) { /* قراءة فقط — الفشل صامت */ }
    }

    function init() {
        var el = document.getElementById('readinessBoard');
        if (!el) return;
        var mode = el.getAttribute('data-mode') === 'full' ? 'full' : 'card';
        load(el, mode);
        setInterval(function () { load(el, mode); }, REFRESH_MS); // دورة التحديث الدورية — بلا إعادة تحميل الصفحة
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
