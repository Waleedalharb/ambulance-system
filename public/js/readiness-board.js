/**
 * ═══ readiness-board.js — لوحة «استعداد الفرق الإسعافية» v4.3 (قراءة فقط صِرفة) ═══
 * تقرأ GET /api/ops/readiness/teams (المصدر الوحيد — لا تعيد حساب أي جاهزية).
 * تعرض كل الفرق الميدانية المكلّفة اليوم: جاهزة/جزئية/غير جاهزة/لم تُسجّل.
 * الضغط على صف له جلسة ← check-review.html (مراجعة فقط — لا تعديل ولا اعتماد).
 * غياب الصلاحية (401/403) = إخفاء صامت. لا كتابة من هذه الشاشة إطلاقًا.
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
            '.rdb-card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px 14px}' +
            '.rdb-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}' +
            '.rdb-title{font-weight:800;color:#c9d6e4;font-size:.9rem}' +
            '.rdb-sum{border-radius:8px;padding:3px 10px;font-weight:800;font-size:.78rem;border:1px solid transparent}' +
            '.rdb-s-green{color:#7EE2B8;background:rgba(14,164,122,.12);border-color:rgba(14,164,122,.4)}' +
            '.rdb-s-yellow{color:#EADDA8;background:rgba(232,200,74,.10);border-color:rgba(232,200,74,.4)}' +
            '.rdb-s-red{color:#FCA5A5;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45)}' +
            '.rdb-s-none{color:#8b98a9;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}' +
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

    function render(el, data) {
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
            '<span class="rdb-title">🚑 استعداد الفرق الإسعافية — ' + esc(data.today || '') + '</span>' +
            '<span class="rdb-sum rdb-s-green">🟢 جاهزة: ' + sum.green + '</span>' +
            '<span class="rdb-sum rdb-s-yellow">🟡 جزئية: ' + sum.yellow + '</span>' +
            '<span class="rdb-sum rdb-s-red">🔴 غير جاهزة: ' + sum.red + '</span>' +
            '<span class="rdb-sum rdb-s-none">⚪ لم تُسجّل: ' + sum.unrecorded + '</span>' +
            '</div>' +
            (rows.length
                ? '<table class="rdb-table"><thead><tr><th>الفرقة</th><th>المركز</th><th>المركبة</th><th>حالة التشييك</th><th>الجاهزية</th><th>آخر تحديث</th></tr></thead><tbody>' + body + '</tbody></table>'
                : '<div class="rdb-empty">لا توجد فرق ميدانية مكلّفة اليوم.</div>') +
            '</div>';
        Array.prototype.forEach.call(el.querySelectorAll('tr.rdb-link'), function (tr) {
            tr.addEventListener('click', function () {
                window.open('/check-review.html?session=' + tr.getAttribute('data-session'), '_blank');
            });
        });
    }

    async function load() {
        var el = document.getElementById('readinessBoard');
        if (!el) return;
        var t = token();
        if (!t) return;
        try {
            var r = await fetch('/api/ops/readiness/teams', { headers: { Authorization: 'Bearer ' + t } });
            if (r.status === 403 || r.status === 401) { el.style.display = 'none'; return; } // إخفاء صامت بلا صلاحية
            if (!r.ok) return;
            ensureStyle();
            el.style.display = '';
            render(el, await r.json());
        } catch (_) { /* قراءة فقط — الفشل صامت */ }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
    else load();
    setInterval(load, REFRESH_MS);
})();
