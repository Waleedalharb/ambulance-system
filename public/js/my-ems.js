/**
 * ═══ my-ems.js — بوابة الموظف التشغيلية v1 (معتمدة 2026-09-04) ═══
 * عرض فقط: لا Business Logic. كل الحساب في الخادم (my-portal-service).
 * الهوية من التوكن — لا يُرسل أي معرّف موظف.
 */
'use strict';

(function () {
    const app = document.getElementById('app');
    const token = localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');

    const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    function riyadhToday() {
        try {
            const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' })
                .formatToParts(new Date());
            const g = t => (parts.find(p => p.type === t) || {}).value;
            return `${g('year')}-${g('month')}-${g('day')}`;
        } catch (_) { return null; }
    }
    function arDay(dateStr) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
        if (!m) return '';
        return AR_DAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    }
    function fmtDateShort(dateStr) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
        return m ? `${Number(m[3])}/${Number(m[2])}` : (dateStr || '—');
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    async function api(path) {
        const r = await fetch(path, { headers: { Authorization: 'Bearer ' + token } });
        if (r.status === 401) throw { state: 401 };
        if (r.status === 403) throw { state: 403 };
        const body = await r.json().catch(() => ({}));
        if (r.status === 404 && body.code === 'NO_EMPLOYEE') throw { state: 404 };
        if (!r.ok) throw { state: r.status, message: body.error };
        return body;
    }

    function stateCard(title, desc, withLink) {
        app.innerHTML = `<div class="card"><div class="state-card">
            <div class="t">${esc(title)}</div>
            <div class="d">${desc}${withLink ? '<br><a href="/">الانتقال إلى صفحة الدخول ←</a>' : ''}</div>
        </div></div>`;
    }

    // ── ملفي التشغيلي ──
    function renderProfile(p) {
        const t = p.today || {};
        const fallbackTag = t.assignmentSource === 'primary_fallback'
            ? '<span class="fallback-tag">تعيين أساسي — خارج جدول اليوم (primary_fallback)</span>' : '';
        const shiftLine = t.shiftName
            ? `${esc(t.shiftName)}${t.timeStart ? ` <small>${esc(t.timeStart)} – ${esc(t.timeEnd)}</small>` : ''}`
            : '—';
        const teamLine = t.teamName ? esc(t.teamName) + (fallbackTag ? '<br>' + fallbackTag : '') : 'لا تكليف مسجل اليوم';
        return `<div class="card">
            <div class="card-head">ملفي التشغيلي</div>
            <div class="card-body profile-grid">
                <div class="p-item"><div class="k">الاسم</div><div class="v">${esc(p.employee.name)}</div></div>
                <div class="p-item"><div class="k">المسمى الوظيفي</div><div class="v">${esc(p.employee.jobTitle || '—')}</div></div>
                <div class="p-item"><div class="k">الفرقة الحالية</div><div class="v">${teamLine}</div></div>
                <div class="p-item"><div class="k">المركز الحالي</div><div class="v">${esc(t.center || '—')}</div></div>
                <div class="p-item"><div class="k">وردية اليوم (${fmtDateShort(t.date)} ${arDay(t.date)})</div><div class="v">${shiftLine}</div></div>
                <div class="p-item"><div class="k">آخر تحديث لبيانات الجدول</div><div class="v"><small>${esc(p.lastRosterUpdate || '—')}</small></div></div>
            </div>
        </div>`;
    }

    // ── إنجازاتي: بلاغات فرقتي أثناء تكليفي ──
    function renderIncidents(d) {
        const todayCell = d.today.count === null
            ? '<div class="n na">لا تكليف</div>' : `<div class="n">${d.today.count}</div>`;
        const rows = (d.byTeam || []).map(b => `<tr>
            <td>${esc(b.teamName)}</td>
            <td>${fmtDateShort(b.from)} – ${fmtDateShort(b.to)}</td>
            <td class="num">${b.count}</td>
        </tr>`).join('');
        const breakdown = rows
            ? `<button class="breakdown-toggle" id="bdToggle">التفصيل حسب الفرقة وفترة التكليف ▾</button>
               <div class="breakdown" id="bdTable"><table>
                   <thead><tr><th>الفرقة</th><th>فترة التكليف</th><th>البلاغات</th></tr></thead>
                   <tbody>${rows}</tbody>
               </table></div>` : '';
        const unmatched = d.unmatchedUnits
            ? `<div style="margin-top:8px;font-size:0.7rem;color:var(--muted)">${d.unmatchedUnits} مشاركة CAD بأسماء وحدات لا تطابق فرقة مسجلة — لا تدخل في العد.</div>` : '';
        return `<div class="card">
            <div class="card-head incidents">إنجازاتي — بلاغات فرقتي أثناء تكليفي</div>
            <div class="card-body">
                <div class="stat-row">
                    <div class="stat">${todayCell}<div class="l">اليوم</div></div>
                    <div class="stat"><div class="n">${d.week.count}</div><div class="l">هذا الأسبوع<br>(${fmtDateShort(d.week.start)} – ${fmtDateShort(d.week.end)})</div></div>
                    <div class="stat"><div class="n">${d.month.count}</div><div class="l">هذا الشهر (${AR_MONTHS[(d.month.month || 1) - 1]})</div></div>
                </div>
                ${breakdown}
                <div class="incident-note">${esc(d.note)}</div>
                ${unmatched}
            </div>
        </div>`;
    }

    // ── جدولي ──
    function renderSchedule(s) {
        const today = riyadhToday();
        let banner = '';
        if (s.coverage === 'none') banner = '<div class="coverage-warn">لا تتوفر بيانات جدول لهذا الشهر.</div>';
        else if (s.coverage === 'partial') banner = '<div class="coverage-warn">لا تتوفر بيانات جدول كاملة لهذه الفترة.</div>';
        const rows = s.days.map(d => {
            const isOff = d.codeStatus && d.codeStatus !== 'دوام' && d.codeStatus !== 'تكميل';
            return `<div class="day-row${d.date === today ? ' today' : ''}${isOff ? ' off' : ''}">
                <div class="d-date">${fmtDateShort(d.date)} ${arDay(d.date)}</div>
                <div class="d-code">${esc(d.shiftCode || '—')}</div>
                <div class="d-name">${esc(d.shiftName || '—')}</div>
                <div class="d-team">${esc(d.teamName || '')}</div>
            </div>`;
        }).join('');
        return `<div class="card">
            <div class="card-head schedule">جدولي</div>
            <div class="card-body">
                <div class="month-nav">
                    <button id="mPrev" title="الشهر السابق">‹</button>
                    <div class="m-title">${AR_MONTHS[s.month - 1]} ${s.year}</div>
                    <button id="mNext" title="الشهر التالي">›</button>
                </div>
                ${banner}
                ${rows || '<div class="empty">—</div>'}
            </div>
        </div>`;
    }

    // ── تكليفاتي عبر الزمن ──
    function renderAssignments(a) {
        const rows = (a.periods || []).map(p => `<tr>
            <td>${p.from}</td><td>${p.to}</td>
            <td>${esc(p.teamName)}</td><td>${esc(p.center || '—')}</td>
        </tr>`).join('');
        return `<div class="card">
            <div class="card-head">تكليفاتي عبر الزمن</div>
            <div class="card-body">
                ${rows ? `<table><thead><tr><th>من</th><th>إلى</th><th>الفرقة</th><th>المركز</th></tr></thead><tbody>${rows}</tbody></table>`
                    : '<div class="empty">لا توجد تكليفات مسجلة في الجدول بعد.</div>'}
            </div>
        </div>`;
    }

    // ── التحميل ──
    let curMonth = null, curYear = null;
    async function load() {
        if (!token) { stateCard('مطلوب تسجيل الدخول', 'سجّل دخولك من الصفحة الرئيسية ثم عد إلى هذه الصفحة.', true); return; }
        try {
            const [profile, incidents, assignments] = await Promise.all([
                api('/api/my/profile'), api('/api/my/team-incidents'), api('/api/my/assignments')]);
            document.getElementById('whoLine').textContent = profile.employee.name + ' — ' + (profile.employee.jobTitle || '');
            if (curMonth === null) {
                const t = riyadhToday();
                curYear = t ? +t.slice(0, 4) : new Date().getFullYear();
                curMonth = t ? +t.slice(5, 7) : new Date().getMonth() + 1;
            }
            const schedule = await api(`/api/my/schedule?month=${curMonth}&year=${curYear}`);
            app.innerHTML = renderProfile(profile) + renderIncidents(incidents) + renderSchedule(schedule) + renderAssignments(assignments);

            const bdToggle = document.getElementById('bdToggle');
            if (bdToggle) bdToggle.addEventListener('click', () => {
                const b = document.getElementById('bdTable');
                b.classList.toggle('open');
                bdToggle.textContent = b.classList.contains('open') ? 'إخفاء التفصيل ▴' : 'التفصيل حسب الفرقة وفترة التكليف ▾';
            });
            document.getElementById('mPrev').addEventListener('click', () => { curMonth--; if (curMonth < 1) { curMonth = 12; curYear--; } refreshSchedule(); });
            document.getElementById('mNext').addEventListener('click', () => { curMonth++; if (curMonth > 12) { curMonth = 1; curYear++; } refreshSchedule(); });
        } catch (e) {
            if (e.state === 401) stateCard('مطلوب تسجيل الدخول', 'انتهت الجلسة أو لم تسجل الدخول بعد.', true);
            else if (e.state === 403) stateCard('لا تملك صلاحية البوابة', 'هذه البوابة تتطلب صلاحية «بوابة الموظف التشغيلية». راجع إدارة النظام لمنحها لحسابك.');
            else if (e.state === 404) stateCard('لا يوجد ملف موظف مرتبط', 'هذا الحساب غير مرتبط بملف موظف في سجل الموظفين. راجع إدارة النظام.');
            else stateCard('تعذر التحميل', esc(e.message || 'خطأ غير متوقع') + ' — حدّث الصفحة للمحاولة مجددًا.');
        }
    }

    async function refreshSchedule() {
        try {
            const schedule = await api(`/api/my/schedule?month=${curMonth}&year=${curYear}`);
            const cards = app.querySelectorAll('.card');
            const tmp = document.createElement('div');
            tmp.innerHTML = renderSchedule(schedule);
            cards[2].replaceWith(tmp.firstElementChild);
            document.getElementById('mPrev').addEventListener('click', () => { curMonth--; if (curMonth < 1) { curMonth = 12; curYear--; } refreshSchedule(); });
            document.getElementById('mNext').addEventListener('click', () => { curMonth++; if (curMonth > 12) { curMonth = 1; curYear++; } refreshSchedule(); });
        } catch (e) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    load();
})();
