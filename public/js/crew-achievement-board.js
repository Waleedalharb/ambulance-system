/**
 * ═══ لوحة «🏆 إنجاز الفرق» — crew-achievement-board.js (Phase D) ═══
 * (قرار المالك 2026-08-18) واجهة عرض فقط فوق GET /api/crew-performance/activity.
 * لا Business Logic هنا: الترتيب يؤخذ من المحرك (rank) كما هو، والأسماء من
 * استجابة لحظة الرسم — صفر كاش، كل تحديث يستبدل البطاقة كاملة.
 *
 * قاعدة الأسماء (تعديل المالك):
 *   - current_shift / today  ← standings[i].members
 *   - week / month           ← standings[i].shifts[0].members (طاقم أحدث مناوبة)
 *     + سطر «🕐 مناوبة <تاريخها>»، والتوسعة تعرض كل مناوبة بأسمائها وبلاغاتها.
 *   - حقل members المجمّع لا يُعرض إطلاقًا في week/month.
 *
 * التحديث اللحظي: اشتراك صريح في الخطاف العام 'ops:sse' (يبثه app.js من قناة
 * SSE الموجودة أصلًا) على الأحداث: new_report / report_undone / shift_started /
 * shift_archived — جلب الفترة المعروضة فقط بدمج 2 ثانية. لا قناة جديدة ولا polling.
 *
 * نمط UMD: يعمل في المتصفح (window.CrewAchievementBoard) وفي Node
 * (module.exports) حتى تختبره scripts/crew-achievement-ui-test.js دون خادم.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CrewAchievementBoard = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ─── الثوابت النصية (حرفيًا من المواصفة المعتمدة) ───
    var TITLE = '🏆 إنجاز الفرق';
    var LABEL_TOP = 'الأكثر نشاطًا';
    var TAG_SHIFT_CREW = '✨ طاقم هذه المناوبة';
    var MSG_EMPTY_RACE = 'السباق لم يبدأ — أول بلاغ يصنع المتصدر 🚑';
    var MSG_NO_SHIFT = 'لا توجد مناوبة نشطة — يبدأ السباق مع المناوبة القادمة';
    var MSG_ERROR = 'تعذر تحديث اللوحة — ستُعاد المحاولة مع أول حدث';
    var FAIRNESS_LINE = 'الترتيب نشاط فقط — وليس تقييم أداء';
    var EXPAND_TOP5 = '▾ عرض الخمسة الأوائل';
    var COLLAPSE_TOP3 = '▴ إظهار الثلاثة الأوائل';
    var EXPAND_SHIFTS = '▾ تفاصيل الإنجاز حسب المناوبة';

    var PERIODS = [
        { id: 'current_shift', tab: 'الحالية', qualifier: 'مباشرة' },
        { id: 'today', tab: 'اليوم', qualifier: 'اليوم' },
        { id: 'week', tab: 'أسبوع', qualifier: 'هذا الأسبوع' },
        { id: 'month', tab: 'شهر', qualifier: 'هذا الشهر' }
    ];
    var REFRESH_EVENTS = ['new_report', 'report_undone', 'shift_started', 'shift_archived'];
    var AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    var MEDALS = ['🥇', '🥈', '🥉'];

    // ─── أدوات نقية ───
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // جمع البلاغات كما في المخطط المعتمد: 3..10 «بلاغات»، وإلا «بلاغ»
    function pluralReports(n) {
        return (n >= 3 && n <= 10) ? 'بلاغات' : 'بلاغ';
    }
    // المعدل: null ← «—» بلا اختلاق؛ غير ذلك بحد أقصى منزلتين
    function formatRate(r) {
        if (r === null || r === undefined || !isFinite(Number(r))) return '—';
        return String(Math.round(Number(r) * 100) / 100);
    }
    // '2026-08-18' ← «18 أغسطس» (تاريخ مجرد، بلا تحويل ساعات)
    function formatShiftDate(ymd) {
        if (!ymd || typeof ymd !== 'string') return '—';
        var parts = ymd.split('-');
        if (parts.length < 3) return esc(ymd);
        var m = parseInt(parts[1], 10), d = parseInt(parts[2], 10);
        if (!m || !d || m < 1 || m > 12) return esc(ymd);
        return d + ' ' + AR_MONTHS[m - 1];
    }
    function isLongPeriod(period) { return period === 'week' || period === 'month'; }
    function periodDef(period) {
        for (var i = 0; i < PERIODS.length; i++) if (PERIODS[i].id === period) return PERIODS[i];
        return PERIODS[0];
    }
    function medal(rank) {
        return (rank >= 1 && rank <= 3) ? MEDALS[rank - 1] : (rank + '.');
    }
    function joinNames(members) {
        if (!members || !members.length) return '—';
        return members.map(esc).join(' · ');
    }
    function statsLine(count, rate) {
        var rateTxt = (rate === null || rate === undefined || !isFinite(Number(rate)))
            ? '—' : (formatRate(rate) + ' بلاغ/ساعة');
        return count + ' ' + pluralReports(count) + ' · ' + rateTxt;
    }

    // ─── رسم صف واحد ───
    // long period: الأسماء من shifts[0] (أحدث مناوبة) + تاريخها + تفاصيل كل مناوبة.
    // short period: الأسماء من members مباشرة.
    function renderRow(s, period) {
        var longP = isLongPeriod(period);
        var latest = (longP && s.shifts && s.shifts.length) ? s.shifts[0] : null;
        var names = longP ? (latest ? latest.members : null) : s.members;
        var html = '';
        if (s.rank === 1) {
            html += '<div class="crew-board-gold">';
            html += '<div class="crew-board-team">' + medal(s.rank) + ' ' + esc(s.team) + '</div>';
            html += '<div class="crew-board-names">' + joinNames(names) + '</div>';
            html += '<div class="crew-board-stats">' + statsLine(s.reports_count, s.activity_rate_per_hour) + ' ' + periodDef(period).qualifier + '</div>';
            if (longP) {
                if (latest) html += '<div class="crew-board-shiftdate">🕐 مناوبة ' + formatShiftDate(latest.shift_date) + '</div>';
            } else {
                html += '<div class="crew-board-tag">' + TAG_SHIFT_CREW + '</div>';
            }
            html += renderShiftDetails(s, longP);
            html += '</div>';
        } else {
            html += '<div class="crew-board-row">';
            html += '<div class="crew-board-row-main">' + medal(s.rank) + ' ' + esc(s.team) + ' — ' + joinNames(names) + '</div>';
            html += '<div class="crew-board-row-stats">' + statsLine(s.reports_count, s.activity_rate_per_hour) + '</div>';
            if (longP && latest) html += '<div class="crew-board-shiftdate">🕐 مناوبة ' + formatShiftDate(latest.shift_date) + '</div>';
            html += renderShiftDetails(s, longP);
            html += '</div>';
        }
        return html;
    }
    function renderShiftDetails(s, longP) {
        if (!longP || !s.shifts || !s.shifts.length) return '';
        var html = '<details class="crew-board-details"><summary>' + EXPAND_SHIFTS + '</summary>';
        for (var i = 0; i < s.shifts.length; i++) {
            var sh = s.shifts[i];
            html += '<div class="crew-board-shiftline">' + formatShiftDate(sh.shift_date) + ': ' + joinNames(sh.members) + ' — ' + sh.reports_count + ' ' + pluralReports(sh.reports_count) + '</div>';
        }
        html += '</details>';
        return html;
    }

    // ─── الرسم الرئيسي: البطاقة كاملة تُستبدل في كل تحديث ───
    function renderBoard(payload, period, expanded) {
        var standings = (payload && payload.standings) || [];
        var html = '';
        if (!standings.length) return renderEmptyRace();
        html += '<div class="crew-board-sublabel">' + LABEL_TOP + '</div>';
        for (var i = 0; i < standings.length; i++) html += renderRow(standings[i], period);
        var ranked = (payload.meta && payload.meta.teams_ranked) || standings.length;
        if (!expanded && ranked > standings.length) {
            html += '<button type="button" id="crewBoardToggleTop" class="crew-board-expand">' + EXPAND_TOP5 + '</button>';
        } else if (expanded) {
            html += '<button type="button" id="crewBoardToggleTop" class="crew-board-expand">' + COLLAPSE_TOP3 + '</button>';
        }
        html += '<div class="crew-board-fairness">' + FAIRNESS_LINE + '</div>';
        return html;
    }

    // ─── الحالات الصادقة ───
    function renderNoActiveShift() {
        return '<div class="crew-board-empty">' + MSG_NO_SHIFT + '</div>'
            + '<div class="crew-board-fairness">' + FAIRNESS_LINE + '</div>';
    }
    function renderEmptyRace() {
        return '<div class="crew-board-empty">' + MSG_EMPTY_RACE + '</div>'
            + '<div class="crew-board-fairness">' + FAIRNESS_LINE + '</div>';
    }
    function renderError() {
        // ترميد بلا أرقام قديمة — لا تُعرض أي قيمة سابقة كأنها حية
        return '<div class="crew-board-empty crew-board-faded">' + MSG_ERROR + '</div>'
            + '<div class="crew-board-fairness">' + FAIRNESS_LINE + '</div>';
    }

    var api = {
        TITLE: TITLE, LABEL_TOP: LABEL_TOP, FAIRNESS_LINE: FAIRNESS_LINE,
        MSG_EMPTY_RACE: MSG_EMPTY_RACE, MSG_NO_SHIFT: MSG_NO_SHIFT, MSG_ERROR: MSG_ERROR,
        TAG_SHIFT_CREW: TAG_SHIFT_CREW,
        PERIODS: PERIODS, REFRESH_EVENTS: REFRESH_EVENTS,
        esc: esc, pluralReports: pluralReports, formatRate: formatRate, formatShiftDate: formatShiftDate,
        renderBoard: renderBoard, renderNoActiveShift: renderNoActiveShift,
        renderEmptyRace: renderEmptyRace, renderError: renderError
    };

    // ─── جزء المتصفح فقط (لا يعمل تحت Node) ───
    if (typeof document !== 'undefined' && typeof window !== 'undefined') {
        var state = { period: 'current_shift', expanded: false };
        var refreshTimer = null;

        function getToken() {
            try { return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken'); } catch (e) { return null; }
        }
        function updateTabs() {
            var tabs = document.querySelectorAll('.crew-board-tab');
            for (var i = 0; i < tabs.length; i++) {
                if (tabs[i].getAttribute('data-period') === state.period) tabs[i].classList.add('active');
                else tabs[i].classList.remove('active');
            }
        }
        function load() {
            var body = document.getElementById('crewBoardBody');
            if (!body) return;
            var t = getToken();
            if (!t) return;
            var top = state.expanded ? 5 : 3;
            fetch('/api/crew-performance/activity?period=' + encodeURIComponent(state.period) + '&top=' + top, {
                headers: { 'Authorization': 'Bearer ' + t }
            }).then(function (res) {
                if (res.status === 404) { body.innerHTML = renderNoActiveShift(); return null; }
                if (!res.ok) throw new Error('http ' + res.status);
                return res.json();
            }).then(function (data) {
                if (!data) return;
                body.innerHTML = renderBoard(data, state.period, state.expanded);
            }).catch(function () {
                body.innerHTML = renderError();
            });
        }
        function scheduleRefresh() {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(load, 2000); // دمج 2 ثانية
        }

        // الاشتراك الصريح في الخطاف العام — لا EventSource جديد
        document.addEventListener('ops:sse', function (e) {
            var type = e && e.detail && e.detail.type;
            if (REFRESH_EVENTS.indexOf(type) !== -1) scheduleRefresh();
        });

        // التبويبات + زر التوسعة (تفويض حدث واحد على الحاوية)
        document.addEventListener('click', function (e) {
            var el = e.target;
            if (!el || !el.closest) return;
            var tab = el.closest('.crew-board-tab');
            if (tab) {
                state.period = tab.getAttribute('data-period') || 'current_shift';
                state.expanded = false;
                updateTabs();
                load();
                return;
            }
            if (el.closest('#crewBoardToggleTop')) {
                state.expanded = !state.expanded;
                load();
            }
        });

        function init() {
            if (!document.getElementById('crewBoardBody')) return;
            if (typeof AuthGate !== 'undefined' && AuthGate && typeof AuthGate.onStart === 'function') {
                AuthGate.onStart(load);
            }
            updateTabs();
            if (getToken()) load();
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return api;
}));
