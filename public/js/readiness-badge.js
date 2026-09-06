/**
 * ═══ readiness-badge.js — شارة جاهزية الفرق v4.2 (قراءة فقط — شارة إعلامية لا تمنع التعيين) ═══
 * تقرأ GET /api/ops/readiness/today (مصدر واحد — لا تعيد حساب الجاهزية).
 * تُركَّب في أي صفحة عمليات بإضافة: <div id="readinessBadge"></div> + هذا الملف.
 * غياب الصلاحية (403) = إخفاء صامت. لا كتابة ولا إنشاء سجلات من هذه الشاشات.
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
        if (document.getElementById('rdyBadgeStyle')) return;
        var st = document.createElement('style');
        st.id = 'rdyBadgeStyle';
        st.textContent =
            '#readinessBadge{direction:rtl;font-family:inherit;font-size:.74rem;margin:6px 0}' +
            '.rdy-wrap{display:flex;flex-wrap:wrap;gap:6px;align-items:center;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:7px 10px}' +
            '.rdy-title{font-weight:700;color:#93a4b8;margin-left:4px}' +
            '.rdy-chip{border-radius:8px;padding:3px 9px;font-weight:700;border:1px solid transparent;white-space:nowrap}' +
            '.rdy-chip small{font-weight:500;opacity:.8}' +
            '.rdy-c-green{color:#7EE2B8;background:rgba(14,164,122,.12);border-color:rgba(14,164,122,.4)}' +
            '.rdy-c-yellow{color:#EADDA8;background:rgba(232,200,74,.10);border-color:rgba(232,200,74,.4)}' +
            '.rdy-c-red{color:#FCA5A5;background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.45)}' +
            '.rdy-c-none{color:#8b98a9;background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.08)}' +
            '.rdy-count{border-radius:8px;padding:3px 8px;font-weight:800;margin-left:2px}';
        document.head.appendChild(st);
    }
    var ICON = { green: '🟢', yellow: '🟡', red: '🔴' };
    function render(el, data) {
        var sessions = (data && data.sessions) || [];
        var counts = { green: 0, yellow: 0, red: 0, none: 0 };
        sessions.forEach(function (s) { counts[s.readiness || 'none']++; });
        var chips = sessions.map(function (s) {
            var r = s.readiness || 'none';
            var label = (s.teamName || '—') + (s.vehicleName ? ' / ' + s.vehicleName : '');
            var reason = s.readinessReason ? ' — ' + s.readinessReason : (r === 'none' ? ' — لم تُستكمل' : '');
            return '<a href="/check-review.html?session=' + s.sessionId + '" style="text-decoration:none">' +
                '<span class="rdy-chip rdy-c-' + r + '" title="' + esc(label + reason) + '">' +
                (ICON[r] || '⏳') + ' ' + esc(label) + '</span></a>';
        }).join('');
        el.innerHTML = '<div class="rdy-wrap">' +
            '<span class="rdy-title">جاهزية الفرق اليوم:</span>' +
            '<span class="rdy-count rdy-c-green">🟢 ' + counts.green + '</span>' +
            '<span class="rdy-count rdy-c-yellow">🟡 ' + counts.yellow + '</span>' +
            '<span class="rdy-count rdy-c-red">🔴 ' + counts.red + '</span>' +
            (counts.none ? '<span class="rdy-count rdy-c-none">⏳ ' + counts.none + '</span>' : '') +
            chips + '</div>';
    }
    async function load() {
        var el = document.getElementById('readinessBadge');
        if (!el) return;
        var t = token();
        if (!t) return;
        try {
            var r = await fetch('/api/ops/readiness/today', { headers: { Authorization: 'Bearer ' + t } });
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
