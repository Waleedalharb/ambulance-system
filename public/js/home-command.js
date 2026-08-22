/**
 * ═══ home-command.js v2 — الصفحة الرئيسية المعاد تشكيلها (عرض فقط، صفر بيانات وهمية) ═══
 * يغذّي: شريط المؤشرات الثمانية + بطاقة «الحالة التشغيلية الآن» (تدمج قائمة
 * «المراكز تحتاج دعمًا») + بطاقة «البلاغات» المختصرة (إجمالي + أنواع + فرق).
 *
 * المصادر (نفس مصادر app.js القائمة — لا مصدر جديد ولا حساب محلي للقوى):
 *   - GET /api/staffing/state       ← القوى/الجاهزية/الفرق (نفس مصدر مؤشرات القوى العاملة)
 *   - window.reports + lastReportsTotal + getShiftTypeBreakdown() + REPORT_TYPE_DEFS
 *     ← البلاغات (نفس مرآة distTotal/liveUnitList/liveTypeList — عدّ عرض فقط)
 *
 * التحديث اللحظي: اشتراك صريح في الخطاف العام 'ops:sse' الذي يبثه app.js —
 * لا EventSource جديد ولا setInterval polling. غياب البيانات ← «لا توجد بيانات».
 */
(function () {
    'use strict';

    var REFRESH_EVENTS = [
        'staffing_events_updated', 'completion_updated', 'team_status_changed',
        'vehicles_updated', 'roster_synced',
        'new_report', 'report_undone', 'shift_started', 'shift_archived'
    ];

    var staffing = null;       // استجابة /api/staffing/state (workforce + teams)
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
    function shiftQs() {
        return (typeof currentShiftId !== 'undefined' && currentShiftId)
            ? '?shift_id=' + encodeURIComponent(currentShiftId) : '';
    }
    function api(url) {
        return AuthManager.apiRequest(url).then(function (r) { return r.json(); });
    }
    function setText(id, v) { var el = $(id); if (el) el.textContent = v; }

    // ── مرايا البلاغات القائمة (نفس كائنات app.js — قراءة فقط) ──
    function reportsTotal() {
        if (typeof lastReportsTotal === 'number') return lastReportsTotal; // المرآة المعتمدة في app.js
        return null;
    }
    function typeBreakdown() {
        return (typeof getShiftTypeBreakdown === 'function') ? getShiftTypeBreakdown() : null;
    }
    function reportsMirror() {
        if (typeof reports !== 'undefined' && reports) return reports;
        return (typeof window !== 'undefined' && window.reports) ? window.reports : null;
    }

    // ═══ ① شريط المؤشرات الثمانية — كلها من مرآة staffing الفعلية ═══
    function renderKpis() {
        var wf = (staffing && staffing.workforce) ? staffing.workforce : null;
        var honest = !wf || wf.operationalReadinessRate == null;
        if (honest) {
            ['hcKpiSched', 'hcKpiPresent', 'hcKpiAbsent', 'hcKpiSupport',
             'hcKpiRequired', 'hcKpiReadyTeams', 'hcKpiReadiness', 'hcKpiVehicles']
                .forEach(function (id) { setText(id, '—'); });
            return;
        }
        setText('hcKpiSched', wf.scheduledStaff == null ? '—' : wf.scheduledStaff);
        setText('hcKpiPresent', wf.totalStaff);
        setText('hcKpiAbsent', wf.absentees || 0);
        setText('hcKpiSupport', wf.supporters || 0);
        setText('hcKpiRequired', wf.requiredTeams || 0);
        setText('hcKpiReadyTeams', wf.readyTeams || 0);
        setText('hcKpiReadiness', wf.operationalReadinessRate + '%');
        setText('hcKpiVehicles', wf.totalCars == null ? '—' : wf.totalCars);
        var aCard = $('hcKpiAbsentCard');
        if (aCard) aCard.classList.toggle('hc-alert-on', (wf.absentees || 0) > 0);
    }

    // ═══ ② «الحالة التشغيلية الآن» — نفس منطق تصنيف مرآة staffing ═══
    // critical = مفقودة/خارج الخدمة/مركبة غير صالحة · monitor = بانتظار القرار
    function classifyTeams() {
        var teams = staffing && staffing.teams ? staffing.teams : null;
        if (!teams) return null;
        var offline = [], missing = [], pending = [], readyCount = 0, critCount = 0;
        for (var name in teams) {
            if (!teams.hasOwnProperty(name)) continue;
            var t = teams[name];
            if (!t) continue;
            if (t.status === 'offline') { offline.push({ name: name, t: t }); critCount++; }
            else if (t.status === 'missing') { missing.push({ name: name, t: t }); critCount++; }
            else if (t.vehicleOk === false) { critCount++; }
            else if (t.status === 'pending') { pending.push({ name: name, t: t }); }
            else if (t.status === 'ready') { readyCount++; }
        }
        return { offline: offline, missing: missing, pending: pending, readyCount: readyCount, critCount: critCount };
    }

    function renderStatus() {
        var pill = $('hcStatusPill');
        var list = $('hcSupportList');
        var wf = (staffing && staffing.workforce) ? staffing.workforce : null;
        var cls = classifyTeams();

        if (!pill) return;
        if (!cls || !wf) {
            pill.className = 'hc-status-pill hc-none';
            pill.textContent = '— بانتظار البيانات';
            setText('hcStReady', '—'); setText('hcStMonitor', '—');
            setText('hcStCrit', '—'); setText('hcStSup', '—');
            if (list) list.innerHTML = '<div class="hc-empty">لا توجد بيانات</div>';
            return;
        }

        var monitorCount = cls.pending.length;
        if (cls.critCount > 0) {
            pill.className = 'hc-status-pill hc-crit';
            pill.textContent = '🔴 يحتاج تدخلًا';
        } else if (monitorCount > 0) {
            pill.className = 'hc-status-pill hc-watch';
            pill.textContent = '🟡 يحتاج متابعة';
        } else {
            pill.className = 'hc-status-pill hc-ok';
            pill.textContent = '🟢 مستقر';
        }

        setText('hcStReady', cls.readyCount);
        setText('hcStMonitor', monitorCount);
        setText('hcStCrit', cls.critCount);
        setText('hcStSup', wf.supporters || 0);

        // قائمة «المراكز تحتاج دعمًا» — من مرآة teams السيرفرية حرفيًا
        if (!list) return;
        if (!cls.offline.length && !cls.missing.length && !cls.pending.length) {
            list.innerHTML = '<div class="hc-empty hc-ok">كل الفرق جاهزة — لا توجد مراكز تحتاج دعمًا</div>';
            return;
        }
        function centerOf(unit) {
            return (typeof teamCenterMap !== 'undefined' && teamCenterMap && teamCenterMap[unit]) || '';
        }
        function item(entry, clsName, badge, detail) {
            var c = centerOf(entry.name);
            return '<div class="hc-sup-item ' + clsName + '" onclick="navigateToPage(\'radio-completion.html?v=41\')" title="فتح تكميل المراكز الإسعافية">'
                + '<span class="hc-sup-dot"></span>'
                + '<span class="hc-sup-main">'
                + '<span class="hc-sup-name">' + esc(entry.name) + (c ? ' · ' + esc(c) : '') + '</span>'
                + '<span class="hc-sup-detail">' + esc(detail) + '</span>'
                + '</span>'
                + '<span class="hc-sup-badge">' + badge + '</span>'
                + '</div>';
        }
        var html = '';
        cls.offline.forEach(function (e) {
            html += item(e, 'hc-red', 'خارج الخدمة', e.t.reason || 'خارج الخدمة');
        });
        cls.missing.forEach(function (e) {
            var d = [];
            if (e.t.reason) d.push(e.t.reason);
            if (e.t.vacant > 0) d.push('ينقصها ' + e.t.vacant);
            html += item(e, 'hc-amber', 'ناقصة', d.join(' — ') || 'ناقصة');
        });
        cls.pending.forEach(function (e) {
            html += item(e, 'hc-amber', 'بانتظار القرار',
                (e.t.activeCount || 0) + '/' + (e.t.requiredPersonnel || 0) + ' حاضر');
        });
        list.innerHTML = html;
    }

    // ═══ ③ البلاغات المختصرة — إجمالي + دونات الأنواع + أشرطة الفرق ═══
    function renderReports() {
        var total = reportsTotal();
        setText('hcRepTotal', total === null ? '—' : total);
        renderDonut(total);
        renderUnitBars();
    }

    // دونات البلاغات حسب النوع — SVG بلا مكتبات، من مرآة liveTypeList
    function renderDonut(total) {
        var donut = $('hcDonut');
        var legend = $('hcDonutLegend');
        if (!donut || !legend) return;
        var breakdown = typeBreakdown();
        if (!breakdown || total === null) {
            donut.innerHTML = '';
            legend.innerHTML = '<div class="hc-empty">لا توجد بيانات</div>';
            return;
        }
        var entries = Object.keys(breakdown)
            .map(function (k) { return [k, breakdown[k]]; })
            .filter(function (e) { return e[1] > 0; })
            .sort(function (a, b) { return b[1] - a[1]; });
        if (!entries.length || total <= 0) {
            donut.innerHTML = '';
            legend.innerHTML = '<div class="hc-empty">لا توجد بلاغات مسجلة</div>';
            return;
        }
        var defs = (typeof REPORT_TYPE_DEFS !== 'undefined') ? REPORT_TYPE_DEFS : {};
        var R = 60, C = 2 * Math.PI * R;
        var segs = '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="18"></circle>';
        var offset = 0;
        var lg = '';
        entries.forEach(function (e) {
            var def = defs[e[0]] || { label: e[0], color: '#60A5FA', emoji: '📦' };
            var len = (e[1] / total) * C;
            segs += '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="' + def.color + '" stroke-width="18"'
                + ' stroke-dasharray="' + len.toFixed(2) + ' ' + C.toFixed(2) + '"'
                + ' stroke-dashoffset="' + (-offset).toFixed(2) + '" stroke-linecap="butt"></circle>';
            offset += len;
            var pct = Math.round((e[1] / total) * 100);
            lg += '<div class="hc-lg-item">'
                + '<span class="hc-lg-dot" style="background:' + def.color + ';"></span>'
                + '<span class="hc-lg-label">' + (def.emoji ? def.emoji + ' ' : '') + esc(def.label) + '</span>'
                + '<span class="hc-lg-val">' + e[1] + '</span>'
                + '<span class="hc-lg-pct">' + pct + '%</span>'
                + '</div>';
        });
        donut.innerHTML = '<svg viewBox="0 0 150 150" role="img" aria-label="توزيع البلاغات حسب النوع">' + segs + '</svg>';
        legend.innerHTML = lg;
    }

    // أشرطة الفرق — فقط الفرق ذات البلاغات الفعلية (نفس مرآة liveUnitList)
    function renderUnitBars() {
        var wrap = $('hcUnitBars');
        if (!wrap) return;
        var mirror = reportsMirror();
        if (!mirror) {
            wrap.innerHTML = '<div class="hc-empty">لا توجد بيانات</div>';
            return;
        }
        var entries = [];
        for (var key in mirror) {
            if (!mirror.hasOwnProperty(key)) continue;
            var r = mirror[key];
            if (!r || !(r.count > 0)) continue;
            var parts = String(key).split('|');
            entries.push({
                unit: parts.length > 1 ? parts[1] : String(key),
                center: parts.length > 1 ? parts[0] : '',
                count: r.count
            });
        }
        entries.sort(function (a, b) { return b.count - a.count; });
        if (!entries.length) {
            wrap.innerHTML = '';
            return;
        }
        var max = entries[0].count;
        var html = '';
        entries.forEach(function (e) {
            var pct = Math.max(4, Math.round((e.count / max) * 100));
            html += '<div class="hc-unit-row" title="' + esc(e.center ? e.center + ' — ' + e.unit : e.unit) + '">'
                + '<span class="hc-unit-name">' + esc(e.unit) + '</span>'
                + '<span class="hc-unit-track"><span class="hc-unit-fill" style="width:' + pct + '%;"></span></span>'
                + '<span class="hc-unit-val">' + e.count + '</span>'
                + '</div>';
        });
        wrap.innerHTML = html;
    }

    function renderAll() {
        renderKpis();
        renderStatus();
        renderReports();
    }

    // ═══ الجلب من المصادر القائمة ═══
    function refreshAll() {
        if (!loggedIn()) {
            staffing = null;
            renderAll();
            return;
        }
        api('/api/staffing/state' + shiftQs())
            .then(function (d) { staffing = (d && d.success) ? d : null; })
            .catch(function () { staffing = null; })
            .then(function () { renderKpis(); renderStatus(); });
        renderReports();
    }

    function scheduleRefresh() {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(function () { refreshTimer = null; refreshAll(); }, 800); // دمج الأحداث المتتالية
    }

    // الاشتراك الصريح في الخطاف العام — لا EventSource جديد ولا polling
    document.addEventListener('ops:sse', function (e) {
        var type = e && e.detail && e.detail.type;
        if (REFRESH_EVENTS.indexOf(type) !== -1) scheduleRefresh();
    });

    // مرآة إجمالي البلاغات تُحدَّث في app.js داخل #grandTotal — نراقبها (مراقب أحداث، ليس polling)
    function watchReportsMirror() {
        var gt = $('grandTotal');
        if (!gt || typeof MutationObserver === 'undefined') return;
        new MutationObserver(function () { renderReports(); })
            .observe(gt, { childList: true, characterData: true, subtree: true });
    }

    function init() {
        if (!$('hcKpiStrip')) return;
        watchReportsMirror();
        if (typeof AuthGate !== 'undefined' && AuthGate && typeof AuthGate.onStart === 'function') {
            AuthGate.onStart(refreshAll);
        }
        if (loggedIn()) refreshAll();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
