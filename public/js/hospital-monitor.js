/**
 * ═══ hospital-monitor.js — مؤشر المستشفيات 1B + دورة التنبيهات ═══
 * (اعتماد المالك 2026-08-27 للمؤشر، 2026-08-28 لدورة المستشفيات والتنبيهات)
 * عرض فقط (Zero Business Logic في الواجهة): كل الأرقام من
 * GET /api/hospital-monitor/summary (الاشتقاق كله سيرفري).
 * التحديث: اشتراك في الخطاف العام 'ops:sse' (بما فيه hospital_monitor_updated)
 * بخنق 800ms — لا EventSource جديد ولا polling.
 * الأداء (اعتماد المالك 2026-08-28 — بند 13): بصمة skip-if-unchanged —
 * إن لم تتغير الحمولة: صفر إعادة رسم. إن تغير تنبيه واحد: يُعاد رسم
 * الحمولة المتغيرة فقط (البصمة تلتقط التغيير ويتحدث المودال في مكانه).
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
    var lastSig = null;       // بصمة آخر حمولة مُرسومة (diff/skip-if-unchanged)

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
    function fmtDT(v) {
        if (!v) return '—';
        try { return new Date(v).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return String(v); }
    }
    // زر الإقرار يظهر فقط لحامل صلاحية التنبيهات التشغيلية (ops.alerts) — نفس
    // بوابة الخادم. قبل تحميل حالة الصلاحيات يظهر الزر والحسم خادمي (403).
    function canAck() {
        var st = window.__opsPermsState;
        if (!st || !st.loaded) return true;
        return st.star === true || (st.perms || []).indexOf('ops.alerts') !== -1;
    }

    function renderKpi() {
        if (!summary || !summary.success) {
            setText('hcKpiHosp', '—');
            setText('hcKpiHospSub', 'حالة منقولة');
            return;
        }
        setText('hcKpiHosp', summary.totalTransferred || 0);
        // لوحة المناوبة الحية (بند 9): فصل الحالات — حالية/مغلقة/تنبيه نشط —
        // لا رقم واحد يوحي بأن كل الرحلات ما زالت داخل المستشفى
        var parts = [];
        parts.push('حالية ' + (summary.currentAtHospital != null ? summary.currentAtHospital : '—'));
        parts.push('مغلقة ' + (summary.lastKnownOnly || 0));
        if (summary.monitoringLost) parts.push('انقطع الرصد ' + summary.monitoringLost);
        if (summary.activeAlerts) parts.push('⚠ تنبيه نشط ' + summary.activeAlerts);
        if (summary.avgDwellMin != null) parts.push('متوسط ' + fmtMin(summary.avgDwellMin));
        setText('hcKpiHospSub', parts.join(' · '));
    }

    // قسم التنبيهات داخل المودال — مع زر إقرار (ACK) للنشطة. الإقرار يتم
    // سيرفريًا بحفظ الوقت والمستخدم؛ المُقَرّ والمحلول يظهران بحالتيهما بصدق.
    function renderAlertsHtml(s) {
        var alerts = Array.isArray(s.alerts) ? s.alerts : [];
        if (!alerts.length) return '';
        var stateBadge = { open: '<b style="color:var(--pi-red,#dc2626);">نشط</b>',
            acknowledged: '<b style="color:var(--primary-700);">مُقَرّ</b>',
            resolved: '<b style="color:var(--gray-500);">محلول</b>' };
        // إصلاح دورة المستشفى [5] (اعتماد المالك 2026-08-28): التنبيه المتأثر
        // بالانقطاع يُوسم صراحة — قيمته «عند آخر مشاهدة» ولا تُقرأ زمنَ بقاء حقيقي.
        var resBadge = function (a) {
            if (a.state !== 'resolved') return stateBadge[a.state] || esc(a.state || '—');
            if (a.resolution === 'monitoring-lost') return stateBadge.resolved + ' <small style="color:var(--pi-amber,#b45309);">انقطع الرصد</small>';
            if (a.resolution === 'completed-late-sync') return stateBadge.resolved + ' <small style="color:var(--primary-700);">صُحّح لاحقًا</small>';
            return stateBadge.resolved;
        };
        var rows = alerts.map(function (a) {
            // [5] وسم الانقطاع (اعتماد المالك 2026-08-29): قيمة ذات دلالة تُعرض
            // «عند آخر مشاهدة»، وبلا قيمة موثوقة ← «غير مقاس» — الصفر ممنوع.
            var dwellCell = a.unreliable
                ? (a.dwellMin != null
                    ? '<span style="color:var(--gray-500);">≈ ' + esc(fmtMin(a.dwellMin)) + '</span> <small style="color:var(--pi-amber,#b45309);">عند آخر مشاهدة — الزمن النهائي غير موثوق</small>'
                    : '<span style="color:var(--gray-400);">غير مقاس</span> <small style="color:var(--pi-amber,#b45309);">انقطع الرصد — الزمن النهائي غير موثوق</small>')
                : esc(fmtMin(a.dwellMin));
            var ackCell = a.state === 'open'
                ? (canAck()
                    ? '<button type="button" class="hc-ack-btn" data-ack="' + esc(a.id) + '" ' +
                      'style="background:var(--primary,#1A3A5C); color:#fff; border:none; border-radius:8px; padding:3px 12px; cursor:pointer; font-size:0.78rem;">إقرار</button>'
                    : '<small style="color:var(--gray-400);">بانتظار إقرار ذي الصلاحية</small>')
                : (a.ackAt ? esc(fmtDT(a.ackAt)) + (a.ackByName ? ' · ' + esc(a.ackByName) : '') : '—');
            return '<tr><td style="padding:4px 8px; white-space:nowrap;">' + esc(fmtDT(a.firstRaisedAt)) + '</td>' +
                '<td style="padding:4px 8px; direction:ltr; text-align:right;">' + esc(a.eventId || '—') + '</td>' +
                '<td style="padding:4px 8px;">' + esc(a.southTeam || a.unitCode || '—') + '</td>' +
                '<td style="padding:4px 8px; font-size:0.8rem;">' + esc(a.facility || '—') + '</td>' +
                '<td style="padding:4px 8px; white-space:nowrap;">' + dwellCell + '</td>' +
                '<td style="padding:4px 8px;">' + resBadge(a) + '</td>' +
                '<td style="padding:4px 8px;">' + ackCell + '</td></tr>';
        }).join('');
        return '<div style="border:1px solid var(--pi-amber,#f59e0b); border-radius:12px; padding:10px 14px; margin-bottom:12px;">' +
            '<div style="font-weight:700; color:var(--pi-amber,#b45309); margin-bottom:6px;"><i class="fas fa-bell"></i> تنبيهات تجاوز زمن البقاء (' + alerts.length + ')</div>' +
            '<table style="width:100%; font-size:0.82rem; border-collapse:collapse;">' +
            '<thead><tr style="color:var(--gray-500); text-align:right;">' +
            '<th style="padding:2px 8px;">الرفع</th><th style="padding:2px 8px;">البلاغ</th><th style="padding:2px 8px;">الفرقة</th>' +
            '<th style="padding:2px 8px;">المنشأة</th><th style="padding:2px 8px;">البقاء</th><th style="padding:2px 8px;">الحالة</th><th style="padding:2px 8px;">الإقرار</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
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
            chip('رحلات مغلقة', s.lastKnownOnly || 0) +
            chip('متوسط زمن البقاء', fmtMin(s.avgDwellMin)) +
            chip('تجاوز > 10 د', s.exceedances || 0) +
            chip('تنبيهات نشطة', s.activeAlerts || 0) +
            (s.monitoringLost ? chip('انقطع الرصد', s.monitoringLost) : '') +
            (s.unmeasured ? chip('بلا أزمنة تسليم', s.unmeasured) : '');
        var alertsHtml = renderAlertsHtml(s);
        if (!s.facilities || !s.facilities.length) {
            body.innerHTML = alertsHtml +
                '<div class="hc-empty">لم تُسجَّل أي حالة منقولة بمنشأة مثبتة من CAD في هذه المناوبة بعد</div>';
            return;
        }
        body.innerHTML = alertsHtml + s.facilities.map(function (f) {
            var rows = f.journeys.map(function (j) {
                var dwell = j.dwellMin == null
                    ? (j.monitoringLost ? '<span style="color:var(--gray-400);">غير مقاس</span>' : '<span style="color:var(--gray-400);">—</span>')
                    : esc(fmtMin(j.dwellMin)) +
                      (j.dwellCapped ? ' <small style="color:var(--pi-amber);">⏸ عند آخر مشاهدة</small>'
                          : (j.ongoing ? ' <small style="color:var(--pi-amber);">⏳ جارٍ</small>' : '')) +
                      (j.dwellMin > 10 && !j.dwellCapped ? ' <small style="color:var(--pi-red);">⚠ تجاوز</small>' : '');
                var stateBadge = j.monitoringLost
                    ? ' <small style="color:var(--pi-amber,#b45309);">(انقطع الرصد — الزمن النهائي غير موثوق)</small>'
                    : j.episodeState === 'last-known'
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

    // تفويض زر الإقرار (مستمع واحد على الحاوية — لا مستمع لكل زر)
    function bindAck() {
        var body = $('hospitalModalBody');
        if (!body || body.__ackBound) return;
        body.__ackBound = true;
        body.addEventListener('click', function (e) {
            var btn = e.target && e.target.closest ? e.target.closest('[data-ack]') : null;
            if (!btn) return;
            var id = btn.getAttribute('data-ack');
            if (!id) return;
            btn.disabled = true;
            AuthManager.apiRequest('/api/hospital-monitor/alerts/' + encodeURIComponent(id) + '/ack', { method: 'POST' })
                .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
                .then(function (res) {
                    if (!res.ok || !res.j || !res.j.success) throw new Error((res.j && res.j.error) || ('HTTP ' + res.j));
                    refresh(true); // إعادة جلب فورية بعد الإقرار
                })
                .catch(function (err) {
                    btn.disabled = false;
                    if (typeof showNotification === 'function') showNotification('تعذر الإقرار', String(err.message || err), 'error', 3000);
                });
        });
    }

    // force=true يتجاوز البصمة (بعد إجراء المستخدم نفسه — الإقرار مثلًا)
    function refresh(force) {
        if (!loggedIn()) { summary = null; lastSig = null; renderKpi(); return; }
        api('/api/hospital-monitor/summary').then(function (j) {
            var sig = JSON.stringify(j || null);
            if (!force && sig === lastSig) return; // صفر إعادة رسم عند الثبات
            lastSig = sig;
            summary = (j && j.success) ? j : null;
            renderKpi();
            // إن كان المودال مفتوحًا حدّث محتواه في مكانه (بلا إغلاق/وميض)
            var m = $('hospitalModal');
            if (m && m.style.display === 'flex') window.renderHospitalModal();
        }).catch(function () { summary = null; lastSig = null; renderKpi(); });
    }

    function scheduleRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () { refreshTimer = null; refresh(false); }, 800);
    }

    document.addEventListener('ops:sse', function (e) {
        var type = e && e.detail && e.detail.type;
        if (REFRESH_EVENTS.indexOf(type) !== -1) scheduleRefresh();
    });

    function init() {
        if (!$('hcKpiHospCard')) return;
        bindAck();
        if (typeof AuthGate !== 'undefined' && AuthGate && typeof AuthGate.onStart === 'function') {
            AuthGate.onStart(function () { refresh(false); });
        }
        if (loggedIn()) refresh(false);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
