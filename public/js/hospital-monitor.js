/**
 * ═══ hospital-monitor.js — مؤشر المستشفيات 1B (اعتماد المالك 2026-08-27) ═══
 * عرض فقط (Zero Business Logic في الواجهة): كل الأرقام من
 * GET /api/hospital-monitor/summary (الاشتقاق كله سيرفري).
 * التحديث: اشتراك في الخطاف العام 'ops:sse' (بما فيه hospital_monitor_updated)
 * بخنق 800ms — لا EventSource جديد ولا polling.
 * غياب البيانات ← «—» بصدق.
 */
(function () {
    'use strict';

    var REFRESH_EVENTS = [
        'hospital_monitor_updated', 'new_report', 'report_undone',
        'shift_started', 'shift_archived'
    ];

    var summary = null;       // آخر استجابة summary ناجحة
    var refreshTimer = null;

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function loggedIn() {
        return typeof AuthManager !== 'undefined' && AuthManager &&
            typeof AuthManager.isLoggedIn === 'function' && AuthManager.isLoggedIn();
    }
    function api(url) {
        return AuthManager.apiRequest(url).then(function (r) { return r.json(); });
    }
    function setText(id, v) { var el = $(id); if (el) el.textContent = v; }
    function fmtMin(v) { return v == null ? '—' : (Math.round(v * 10) / 10) + ' د'; }

    function renderKpi() {
        if (!summary || !summary.success) {
            setText('hcKpiHosp', '—');
            setText('hcKpiHospSub', 'حالة منقولة');
            return;
        }
        setText('hcKpiHosp', summary.totalTransferred || 0);
        var sub = 'حالة منقولة';
        if (summary.avgDwellMin != null) sub = 'متوسط ' + fmtMin(summary.avgDwellMin) + ' · تجاوز ' + (summary.exceedances || 0);
        setText('hcKpiHospSub', sub);
    }

    // تفصيل المنشآت — لا يظهر إلا لهوية منشأة مثبتة من CAD (قاعدة المالك)
    window.renderHospitalModal = function () {
        var sumEl = $('hospitalModalSummary');
        var body = $('hospitalModalBody');
        if (!sumEl || !body) return;
        if (!summary || !summary.success) {
            sumEl.innerHTML = '';
            body.innerHTML = '<div class="hc-empty">لا توجد بيانات</div>';
            return;
        }
        var s = summary;
        var chip = function (label, val) {
            return '<div style="background:var(--gray-100,#f3f4f6); border-radius:10px; padding:8px 14px;">' +
                '<b style="font-size:1.15rem;">' + esc(val) + '</b> <span style="color:var(--gray-600);">' + esc(label) + '</span></div>';
        };
        sumEl.innerHTML =
            chip('حالة منقولة', s.totalTransferred || 0) +
            chip('في المستشفى الآن', s.currentAtHospital != null ? s.currentAtHospital : '—') +
            chip('متوسط زمن البقاء', fmtMin(s.avgDwellMin)) +
            chip('تجاوز > 10 د', s.exceedances || 0) +
            (s.unmeasured ? chip('بلا أزمنة تسليم', s.unmeasured) : '');
        if (!s.facilities || !s.facilities.length) {
            body.innerHTML = '<div class="hc-empty">لم تُسجَّل أي حالة منقولة بمنشأة مثبتة من CAD في هذه المناوبة بعد</div>';
            return;
        }
        body.innerHTML = s.facilities.map(function (f) {
            var rows = f.journeys.map(function (j) {
                var dwell = j.dwellMin == null ? '<span style="color:var(--gray-400);">—</span>'
                    : esc(fmtMin(j.dwellMin)) + (j.ongoing ? ' <small style="color:var(--pi-amber);">⏳ جارٍ</small>' : '') +
                      (j.dwellMin > 10 ? ' <small style="color:var(--pi-red);">⚠ تجاوز</small>' : '');
                var stateBadge = j.episodeState === 'last-known'
                    ? ' <small style="color:var(--gray-500);">(سابقة — آخر منشأة معروفة)</small>' : '';
                return '<tr><td style="padding:4px 8px; direction:ltr; text-align:right;">' + esc(j.eventId) + '</td>' +
                    '<td style="padding:4px 8px;">' + esc(j.southTeam || j.unitCode || '—') + stateBadge + '</td>' +
                    '<td style="padding:4px 8px;">' + dwell + '</td></tr>';
            }).join('');
            return '<div style="border:1px solid var(--gray-200,#e5e7eb); border-radius:12px; padding:10px 14px; margin-bottom:10px;">' +
                '<div style="display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; font-weight:700; color:var(--primary-700);">' +
                    '<span><i class="fas fa-hospital"></i> ' + esc(f.facility) + '</span>' +
                    '<span style="font-weight:400; font-size:0.85rem; color:var(--gray-600);">' +
                        'الحالات: <b>' + f.cases + '</b> · المتوسط: <b>' + esc(fmtMin(f.avgDwellMin)) + '</b> · التجاوزات: <b>' + f.exceedances + '</b>' +
                    '</span></div>' +
                '<table style="width:100%; margin-top:6px; font-size:0.82rem; border-collapse:collapse;">' +
                    '<thead><tr style="color:var(--gray-500); text-align:right;"><th style="padding:2px 8px;">البلاغ</th><th style="padding:2px 8px;">الفرقة</th><th style="padding:2px 8px;">زمن البقاء</th></tr></thead>' +
                    '<tbody>' + rows + '</tbody></table></div>';
        }).join('');
    };

    function refresh() {
        if (!loggedIn()) { summary = null; renderKpi(); return; }
        api('/api/hospital-monitor/summary').then(function (j) {
            summary = (j && j.success) ? j : null;
            renderKpi();
            // إن كان المودال مفتوحًا حدّث محتواه في مكانه (بلا إغلاق/وميض)
            var m = $('hospitalModal');
            if (m && m.style.display === 'flex') window.renderHospitalModal();
        }).catch(function () { summary = null; renderKpi(); });
    }

    function scheduleRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () { refreshTimer = null; refresh(); }, 800);
    }

    document.addEventListener('ops:sse', function (e) {
        var type = e && e.detail && e.detail.type;
        if (REFRESH_EVENTS.indexOf(type) !== -1) scheduleRefresh();
    });

    function init() {
        if (!$('hcKpiHospCard')) return;
        if (typeof AuthGate !== 'undefined' && AuthGate && typeof AuthGate.onStart === 'function') {
            AuthGate.onStart(refresh);
        }
        if (loggedIn()) refresh();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
