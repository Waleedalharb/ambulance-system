/**
 * ═══ my-ems.js — بوابة الموظف التشغيلية v1+v2 (معتمدة 2026-09-04) ═══
 * عرض فقط: لا Business Logic. كل الحساب في الخادم (my-portal-service).
 * الهوية من التوكن — لا يُرسل أي معرّف موظف.
 * v2: الأقسام تُبنى من خريطة /api/my/sections (لا بطاقات فارغة) + مركبتي + الجرد.
 *     رابط «المنصة الرئيسية» يظهر فقط لمن يملك صلاحية منصة فعلية.
 */
'use strict';

(function () {
    const app = document.getElementById('app');
    const token = localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');

    const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
    const AR_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    // تسميات عرض — المصدر الرسمي للقيم: operational-events-core (المركبات) ومخطط db.js (الأصول/الجلسات)
    const VEH_STATUS = { active: 'عاملة', reserve: 'احتياط', breakdown: 'متعطلة', out_of_service: 'خارج الخدمة' };
    const ASSET_STATUS = { working: 'سليم', damaged: 'تالف', missing: 'مفقود', replaced: 'مستبدَل', recalled: 'مسترجَع', out_of_service: 'خارج الخدمة', unknown: 'غير محدد' };
    const SESSION_STATUS = { open: 'مفتوحة', submitted: 'مُرسلة للاعتماد', approved: 'معتمدة' };

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

    // توست عام خفيف بنطاق الصفحة (إصلاح v5: bindNotifEvents كان ينادي toast
    // غير معرّفة خارج bindCheckEvents — ReferenceError في مسار الخطأ)
    function toast(m) {
        const t = document.createElement('div');
        t.className = 'my-toast';
        t.textContent = m;
        document.body.appendChild(t);
        setTimeout(() => { try { t.remove(); } catch (_) { } }, 3500);
    }

    // تطبيع سعودي لـ WhatsApp: 05xxxxxxxx / 5xxxxxxxx / 9665xxxxxxxx ⇒ wa.me/9665…
    // غير ذلك ⇒ null (لا يُعرض زر واتساب) — الرقم نفسه يصل من الخادم فقط لحامل staff.phone_view
    function waHref(phone) {
        const d = String(phone || '').replace(/\D/g, '');
        let n = null;
        if (/^05\d{8}$/.test(d)) n = '966' + d.slice(1);
        else if (/^5\d{8}$/.test(d)) n = '966' + d;
        else if (/^9665\d{8}$/.test(d)) n = d;
        return n ? 'https://wa.me/' + n : null;
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

    // ── تسجيل الخروج — إبطال خادمي حقيقي، لا مسحًا شكليًا (قرار المالك 2026-09-05) ──
    // المسار الخادمي /api/auth/logout يحظر توكن الوصول والتحديث في TokenBlacklist
    // ويعطّل الجلسة في auth_sessions ويدقق الحدث — نفس آلية المنصة الرئيسية حرفًا.
    async function logout() {
        const btn = document.getElementById('logoutBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'جارٍ تسجيل الخروج…'; }
        try {
            await fetch('/api/auth/logout', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
            });
            // جلسة منتهية أصلًا ← 401 من الخادم: الحالة متوقعة، نكمل المسح المحلي بلا خطأ
        } catch (_) { /* انقطاع الشبكة لا يمنع إكمال الخروج محليًا */ }
        // نفس المفاتيح التي يمسحها AuthManager في المنصة الرئيسية
        ['auth_access_token', 'auth_refresh_token', 'auth_user', 'auth_token_expires', 'authToken', 'currentUser']
            .forEach(k => localStorage.removeItem(k));
        // replace وليس href: لا تبقى البوابة في سجل التنقل — زر Back لا يعيدها
        location.replace('/');
    }

    // bfcache: صفحة محفوظة تُستعاد بزر Back بعد الخروج — التوكن مسحوب محليًا ← إعادة توجيه فورية
    window.addEventListener('pageshow', function (ev) {
        if (ev.persisted && !localStorage.getItem('auth_access_token') && !localStorage.getItem('authToken')) {
            location.replace('/');
        }
    });

    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);

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

    // ── جاهزية الفرقة — نظام التشييك الذكي v4.2 (معتمد مبدئيًا 2026-09-06) ──
    // تدفق المسعف: سؤال واحد ← «لا تغيير» مؤكد / مشكلة / تشييك جديد ← حقول المركبة ← الجاهزية مشتقة.
    let checkView = 'home';      // home | groups | vehicle
    let checkGroupOpen = null;   // مفتاح المجموعة المفتوحة حاليًا
    const checkSel = {};         // اختيارات الحالة المؤقتة لكل بند (قبل الحفظ)

    const STATUS_LABELS = { complete: 'مكتمل', shortage: 'ناقص', damaged: 'تالف', unavailable: 'غير متوفر', follow_up: 'يحتاج متابعة' };
    const NC_REASON_LABELS = { open_issues: 'توجد ملاحظات مفتوحة — افحص التفاصيل', no_previous_check: 'لا يوجد فحص سابق لهذه المركبة', stale_check: 'آخر فحص قديم (تجاوز المدة المعتمدة)', vehicle_changed: 'تغيّرت المركبة منذ آخر فحص' };

    function readinessBadge(d) {
        const map = {
            green: { t: '🟢 جاهزة', c: 'rdy-green' },
            yellow: { t: '🟡 جاهزة مع ملاحظة', c: 'rdy-yellow' },
            red: { t: '🔴 غير جاهزة', c: 'rdy-red' }
        };
        if (!d.readiness) return '<div class="rdy-badge rdy-pending">⏳ لم تُستكمل الجاهزية بعد</div>';
        const m = map[d.readiness];
        return `<div class="rdy-badge ${m.c}">${m.t}${d.readinessReason ? `<small>${esc(d.readinessReason)}</small>` : ''}</div>`;
    }

    function renderCheck(d) {
        const head = '<div class="card-head check">🚑 جاهزية الفرقة</div>';
        if (d.state === 'no_assignment') {
            return `<div class="card" id="checkCard">${head}<div class="card-body">
                <div class="empty">لا يوجد تكليف ميداني مسجل لك اليوم — تظهر جاهزية الفرقة أيام التكليف.</div>
            </div></div>`;
        }
        if (d.state === 'not_field_team') {
            return `<div class="card" id="checkCard">${head}<div class="card-body">
                <div class="empty">التشييك مخصص للفرق الميدانية.</div>
            </div></div>`;
        }
        // الجلسات القديمة (v1): العرض الكلاسيكي بلا تغيير
        if (!d.session || (d.session.schema_version || 1) < 2) return renderCheckLegacy(d, head);

        const completed = d.session.status === 'completed';
        const meId = d.me.id;
        const myConf = new Set((d.confirmations || []).filter(c => c.employee_id === meId).map(c => c.kind));

        // الملاحظات المفتوحة — تُعرض إلزاميًا قبل أي تأكيد (قاعدة المالك)
        const openIssues = (d.openIssues || []).filter(o =>
            !(d.items || []).some(i => i.itemKey === o.itemKey && i.result === 'ok'));
        const issuesHtml = openIssues.length
            ? `<div class="issue-banner">⚠ ملاحظات مفتوحة من تشييك سابق — يجب الاطلاع عليها قبل التأكيد:<br>${openIssues.map(o =>
                `• ${esc(o.label)}${o.note ? ' — ' + esc(o.note) : ''} <small>(${esc(o.byName || '')} · ${esc((o.at || '').slice(0, 10))})</small>`).join('<br>')}</div>`
            : '';

        // عنصر بند v4.2: الحالة بالضغط + الكمية المطلوبة + المتاح عند النقص
        const itemHtml = i => {
            const sel = checkSel[i.itemKey];
            const st = i.statusDetail;
            const meta = i.noChange
                ? `✓ لا تغيير — أكده ${esc(i.checkedByName || '')} · ${esc((i.checkedAt || '').slice(0, 16).replace('T', ' '))}`
                : (i.checkedByName ? `آخر فحص: ${esc(i.checkedByName)} · ${esc((i.checkedAt || '').slice(0, 16).replace('T', ' '))}` : 'لم يُفحص بعد');
            const stTag = st && !i.noChange ? ` <b class="st-tag st-${st}">${STATUS_LABELS[st] || ''}</b>` : '';
            const qty = i.qtyRequired ? ` <small class="chk-qty">المطلوب: ${esc(i.qtyRequired)}</small>` : '';
            const qtyAv = i.qtyAvailable != null ? ` <small class="chk-qty">المتاح: ${esc(i.qtyAvailable)}</small>` : '';
            const noteHtml = i.note
                ? `<div class="chk-existing-note">📝 ${esc(i.note)}${i.reflected ? ' <small>· انعكست في النظام المختص ✓</small>' : ''}</div>` : '';
            const editor = (!completed && sel) ? `<div class="chk-note-editor open">
                ${sel === 'shortage' && i.qtyRequired ? `<div class="chk-qty-row">المطلوب ${esc(i.qtyRequired)} — المتاح: <input type="text" inputmode="numeric" class="chk-qty-input" data-qty="${esc(i.itemKey)}" placeholder="0" style="width:64px"></div>` : ''}
                <textarea placeholder="ملاحظة قصيرة (اختياري)…"></textarea>
                <button data-save="${esc(i.itemKey)}" data-status="${esc(sel)}">حفظ «${STATUS_LABELS[sel]}»</button>
            </div>` : '';
            const btns = completed ? '' : `<div class="chk-actions st-row">
                ${(d.itemStatuses || []).map(s =>
                    `<button class="st-btn st-${s}${(st === s && !i.noChange) || sel === s ? ' on' : ''}" data-st="${s}" data-key="${esc(i.itemKey)}">${STATUS_LABELS[s]}</button>`).join('')}
            </div>`;
            return `<div class="chk-item" data-key="${esc(i.itemKey)}">
                <div class="chk-label">${esc(i.label)}${stTag}${qty}${qtyAv}</div>
                <div class="chk-meta">${meta}</div>
                ${noteHtml}${btns}${editor}
            </div>`;
        };

        // بطاقة مجموعة: «كلها سليمة» / «توجد مشكلة»
        const groupHtml = g => {
            const total = g.items.length;
            const done = g.items.filter(i => i.result === 'ok' || i.noChange).length;
            const issues = g.items.filter(i => i.result === 'issue').length;
            const open = checkGroupOpen === g.key;
            const stateTxt = issues ? `<span class="grp-iss">⚠ ${issues} ملاحظة</span>` : (done === total ? '<span class="grp-ok">✓ مكتملة</span>' : `<span class="grp-pend">${done}/${total}</span>`);
            const hint = g.isAssets ? '<div class="chk-hint">لقطة من الأصول المسجلة على فرقتك لحظة إنشاء الجلسة — ليست إثباتًا بأن جميعها محمّل فعليًا على المركبة.</div>' : '';
            const actions = completed ? '' : `<div class="grp-actions">
                <button class="chk-btn" data-group-ok="${esc(g.key)}">✓ كلها سليمة</button>
                <button class="chk-btn" data-group-open="${esc(g.key)}">${open ? 'إغلاق التفاصيل' : '⚠ توجد مشكلة / تفاصيل'}</button>
            </div>`;
            return `<div class="grp-card${open ? ' open' : ''}">
                <div class="grp-head"><b>${esc(g.label)}</b> ${stateTxt}</div>
                ${hint}${actions}
                ${open || completed ? '<div class="grp-items">' + g.items.map(itemHtml).join('') + '</div>' : ''}
            </div>`;
        };

        // الشاشة الرئيسية: سؤال واحد (تجربة «نظام جاهزية ذكي» — قرار المالك)
        const nc = d.noChange || {};
        const ncReasons = (nc.reasons || []).map(r => NC_REASON_LABELS[r] || r).join(' · ');
        const lastTxt = nc.lastCheck ? `آخر تشييك مكتمل: ${esc((nc.lastCheck.at || '').slice(0, 16).replace('T', ' '))}${nc.lastCheck.vehicleName ? ' · ' + esc(nc.lastCheck.vehicleName) : ''}` : 'لا يوجد تشييك سابق مكتمل';
        const homeHtml = `
            <div class="chk-question">هل توجد أي تغييرات منذ آخر تشييك؟</div>
            <div class="chk-last">${lastTxt}</div>
            <div class="conf-row">
                <button class="conf-btn" data-nc="1" ${nc.eligible ? '' : 'disabled'}>✓ لا، كل شيء كما هو</button>
                <button class="conf-btn chk-btn-warn" data-view="groups">⚠ نعم، توجد مشكلة</button>
                <button class="conf-btn chk-btn-neutral" data-view="groups">🔄 بدء تشييك جديد</button>
            </div>
            ${nc.eligible ? '' : `<div class="chk-hint" style="margin-top:6px">لا يتاح «لا تغيير»: ${esc(ncReasons)}</div>`}`;

        // حقول المركبة الثابتة (عداد/وقود/نظافة/مفتاح/شريحة)
        const vf = d.vehicleFields || {};
        const fuelOpts = [['100', '100%'], ['75', '75%'], ['50', '50%'], ['25', '25%'], ['under25', 'أقل من 25%']];
        const slTag = d.vehicle ? (d.serviceLevelConfirmed
            ? ` · ${esc(d.serviceLevel)}` : ' · <span class="chk-qty">تصنيف ALS/BLS غير مؤكد — تُعرض كـBLS مؤقتًا</span>') : '';
        const vehicleHtml = d.vehicle ? `
            <div class="chk-sub">بيانات المركبة — ${esc(d.vehicle.name)}${d.vehicleType ? ' · ' + esc(d.vehicleType) : ''}${slTag}</div>
            <div class="vf-grid">
                <label>قراءة العداد: <input type="number" min="0" class="vf-input" id="vfOdometer" value="${vf.odometer != null ? vf.odometer : ''}" placeholder="كم"></label>
                <div class="vf-row">كمية الوقود: ${fuelOpts.map(o => `<button class="st-btn vf-fuel${vf.fuel_level === o[0] ? ' on' : ''}" data-vf-fuel="${o[0]}">${o[1]}</button>`).join('')}</div>
                <div class="vf-row">النظافة: <button class="st-btn vf-clean${vf.cleanliness === 'clean' ? ' on' : ''}" data-vf-clean="clean">نظيفة</button><button class="st-btn vf-clean${vf.cleanliness === 'dirty' ? ' on' : ''}" data-vf-clean="dirty">غير نظيفة</button></div>
                <div class="vf-row">المفتاح الأساسي: <button class="st-btn vf-key${vf.master_key === 1 ? ' on' : ''}" data-vf-key="1">موجود</button><button class="st-btn vf-key${vf.master_key === 0 ? ' on' : ''}" data-vf-key="0">غير موجود</button></div>
                <div class="vf-row">شريحة الوقود: <button class="st-btn vf-card${vf.fuel_card === 1 ? ' on' : ''}" data-vf-card="1">موجودة</button><button class="st-btn vf-card${vf.fuel_card === 0 ? ' on' : ''}" data-vf-card="0">غير موجودة</button></div>
            </div>
            ${completed ? '' : '<div class="conf-row"><button class="conf-btn" data-vf-save="1">حفظ بيانات المركبة</button></div>'}` : '';

        // تأكيدات الفرقة (كما في v3)
        const confLabel = { ack: 'الاطلاع', checkin: 'الاستلام', checkout: 'التسليم' };
        const membersHtml = (d.members || []).map(m => {
            const kinds = new Set((d.confirmations || []).filter(c => c.employee_id === m.id).map(c => c.kind));
            const marks = ['ack', 'checkin', 'checkout'].map(k => `${kinds.has(k) ? '✅' : '⬜'} ${confLabel[k]}`).join(' · ');
            return `<div><b>${esc(m.name)}</b>: ${marks}</div>`;
        }).join('');
        const myBtns = ['ack', 'checkin', 'checkout']
            .filter(k => !myConf.has(k))
            .map(k => `<button class="conf-btn" data-conf="${k}">تأكيد ${confLabel[k]}</button>`).join('');

        const modeTag = d.checkMode === 'no_change' ? '<div class="chip">النمط: <b>تأكيد لا تغيير</b></div>' : (d.checkMode ? `<div class="chip">النمط: <b>${d.checkMode === 'full' ? 'تشييك كامل' : 'تشييك جزئي'}</b></div>` : '');

        let bodyMain = '';
        if (completed) {
            bodyMain = '<div class="chk-done">✅ اكتملت إجراءات الاستلام والتسليم لهذه المناوبة</div>' + (d.groups || []).map(groupHtml).join('');
        } else if (checkView === 'groups') {
            bodyMain = `<div class="conf-row" style="margin-bottom:8px"><button class="chk-btn" data-view="home">→ رجوع</button><button class="chk-btn" data-view="vehicle">بيانات المركبة ←</button></div>`
                + (d.groups || []).map(groupHtml).join('');
        } else if (checkView === 'vehicle') {
            bodyMain = `<div class="conf-row" style="margin-bottom:8px"><button class="chk-btn" data-view="home">→ رجوع</button></div>` + vehicleHtml;
        } else {
            bodyMain = homeHtml;
        }

        return `<div class="card" id="checkCard">${head}
            <div class="card-body">
                <div class="chip-row">
                    <div class="chip">الفرقة: <b>${esc(d.team.teamName)}</b></div>
                    <div class="chip">المركبة: <b>${d.vehicle ? esc(d.vehicle.name) : '—'}</b></div>
                    <div class="chip">التاريخ: <b>${esc(d.today)}</b></div>
                    ${modeTag}
                </div>
                ${readinessBadge(d)}
                <div style="margin-top:8px" id="chkToastHolder"></div>
                ${issuesHtml}
                ${bodyMain}
                ${checkView === 'home' && !completed ? vehicleHtml : ''}
                <div class="chk-sub">تأكيدات الفرقة (لكل موظف على حدة)</div>
                <div class="conf-members">${membersHtml || '—'}</div>
                ${completed ? '' : `<div class="conf-row">${myBtns || '<span style="font-size:0.78rem;color:var(--muted)">أكملت جميع تأكيداتك لهذه الجلسة</span>'}</div>`}
            </div>
        </div>`;
    }

    // العرض الكلاسيكي للجلسات القديمة v1 — بلا تغيير عن v3
    function renderCheckLegacy(d, head) {
        const completed = d.session && d.session.status === 'completed';
        const meId = d.me.id;
        const myConf = new Set((d.confirmations || []).filter(c => c.employee_id === meId).map(c => c.kind));

        const openIssues = (d.openIssues || []).filter(o =>
            !(d.items || []).some(i => i.itemKey === o.itemKey && i.result === 'ok'));
        const issuesHtml = openIssues.length
            ? `<div class="issue-banner">⚠ ملاحظات مفتوحة من تشييك سابق:<br>${openIssues.map(o =>
                `• ${esc(o.label)}${o.note ? ' — ' + esc(o.note) : ''} <small>(${esc(o.byName || '')} · ${esc((o.at || '').slice(0, 10))})</small>`).join('<br>')}</div>`
            : '';

        const itemHtml = i => {
            const okOn = i.result === 'ok' ? ' on-ok' : '';
            const isOn = i.result === 'issue' ? ' on-issue' : '';
            const meta = i.checkedByName ? `آخر فحص: ${esc(i.checkedByName)} · ${esc((i.checkedAt || '').slice(0, 16).replace('T', ' '))}` : 'لم يُفحص بعد';
            const noteHtml = i.note
                ? `<div class="chk-existing-note">📝 ${esc(i.note)}${i.reflected ? ' <small>· انعكست في النظام المختص ✓</small>' : ''}</div>` : '';
            return `<div class="chk-item" data-key="${esc(i.itemKey)}">
                <div class="chk-label">${esc(i.label)}</div>
                <div class="chk-meta">${meta}</div>
                ${noteHtml}
                ${completed ? '' : `<div class="chk-actions">
                    <button class="chk-btn${okOn}" data-act="ok">✓ تم التحقق</button>
                    <button class="chk-btn${isOn}" data-act="issue">⚠ ملاحظة / نقص</button>
                </div>
                <div class="chk-note-editor" data-editor="${esc(i.itemKey)}">
                    <textarea placeholder="اكتب الملاحظة أو النقص أو التلف…">${esc(i.note || '')}</textarea>
                    <button data-save="${esc(i.itemKey)}">حفظ الملاحظة</button>
                </div>`}
            </div>`;
        };
        const med = (d.items || []).filter(i => i.domain === 'medical');
        const mech = (d.items || []).filter(i => i.domain === 'mechanical');
        const medHtml = med.length
            ? `<div class="chk-sub">التشييك الطبي — الأصول المسجلة على الفرقة (${med.length})</div>`
              + '<div class="chk-hint">لقطة من الأصول المسجلة على فرقتك في النظام لحظة إنشاء الجلسة — ليست إثباتًا بأن جميعها محمّل فعليًا على المركبة.</div>'
              + med.map(itemHtml).join('')
            : '<div class="chk-sub">التشييك الطبي — الأصول المسجلة على الفرقة</div><div class="empty">لا توجد أصول مسجلة على فرقتك حاليًا.</div>';
        const mechHtml = d.vehicle
            ? `<div class="chk-sub">التشييك الميكانيكي والتقني — ${esc(d.vehicle.name)}</div>` + mech.map(itemHtml).join('')
            : '<div class="chk-sub">التشييك الميكانيكي والتقني</div><div class="empty">لا توجد مركبة مسندة حاليًا لفرقتك.</div>';

        const confLabel = { ack: 'الاطلاع', checkin: 'الاستلام', checkout: 'التسليم' };
        const membersHtml = (d.members || []).map(m => {
            const kinds = new Set((d.confirmations || []).filter(c => c.employee_id === m.id).map(c => c.kind));
            const marks = ['ack', 'checkin', 'checkout'].map(k => `${kinds.has(k) ? '✅' : '⬜'} ${confLabel[k]}`).join(' · ');
            return `<div><b>${esc(m.name)}</b>: ${marks}</div>`;
        }).join('');
        const myBtns = ['ack', 'checkin', 'checkout']
            .filter(k => !myConf.has(k))
            .map(k => `<button class="conf-btn" data-conf="${k}">تأكيد ${confLabel[k]}</button>`).join('');

        return `<div class="card" id="checkCard">${head}
            <div class="card-body">
                <div class="chip-row">
                    <div class="chip">الفرقة: <b>${esc(d.team.teamName)}</b></div>
                    <div class="chip">المركبة: <b>${d.vehicle ? esc(d.vehicle.name) : '—'}</b></div>
                    <div class="chip">التاريخ: <b>${esc(d.today)}</b></div>
                </div>
                <div style="margin-top:8px" id="chkToastHolder"></div>
                ${issuesHtml}
                ${completed ? '<div class="chk-done">✅ اكتملت إجراءات الاستلام والتسليم لهذه المناوبة</div>' : ''}
                ${medHtml}
                ${mechHtml}
                <div class="chk-sub">تأكيدات الفرقة (لكل موظف على حدة)</div>
                <div class="conf-members">${membersHtml || '—'}</div>
                ${completed ? '' : `<div class="conf-row">${myBtns || '<span style="font-size:0.78rem;color:var(--muted)">أكملت جميع تأكيداتك لهذه الجلسة</span>'}</div>`}
            </div>
        </div>`;
    }

    async function refreshCheck(warning) {
        const old = document.getElementById('checkCard');
        if (!old) return;
        try {
            const d = await api('/api/my/check-session');
            const tmp = document.createElement('div');
            tmp.innerHTML = renderCheck(d);
            old.replaceWith(tmp.firstElementChild);
            bindCheckEvents();
            if (warning) {
                const h = document.getElementById('chkToastHolder');
                if (h) h.innerHTML = `<div class="chk-toast">⚠ ${esc(warning)}</div>`;
            }
        } catch (e) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    function bindCheckEvents() {
        const card = document.getElementById('checkCard');
        if (!card) return;
        card.addEventListener('click', async ev => {
            const btn = ev.target.closest('button');
            if (!btn) return;
            const itemEl = btn.closest('.chk-item');
            const toast = m => { const h = document.getElementById('chkToastHolder'); if (h) h.innerHTML = `<div class="chk-toast">⚠ ${esc(m)}</div>`; };
            try {
                // v4.2 — التنقل بين الشاشات
                if (btn.dataset.view) { checkView = btn.dataset.view; if (btn.dataset.view !== 'groups') checkGroupOpen = null; await refreshCheck(); return; }
                // v4.2 — «لا تغيير» (تأكيد فعلي مسجل)
                if (btn.dataset.nc) { const r = await apiPost('/api/my/check-session/no-change', {}); await refreshCheck(r.warning); return; }
                // v4.2 — فتح/إغلاق تفاصيل مجموعة
                if (btn.dataset.groupOpen) { checkGroupOpen = checkGroupOpen === btn.dataset.groupOpen ? null : btn.dataset.groupOpen; await refreshCheck(); return; }
                // v4.2 — «كلها سليمة» لمجموعة كاملة
                if (btn.dataset.groupOk) {
                    const gk = btn.dataset.groupOk;
                    const d = await api('/api/my/check-session');
                    const g = (d.groups || []).find(x => x.key === gk);
                    if (!g) return;
                    btn.disabled = true;
                    for (const it of g.items) {
                        if (it.result || it.noChange) continue;
                        const r = await apiPost('/api/my/check-session/items', { item_key: it.itemKey, status_detail: 'complete' });
                        if (r.warning) toast(r.warning);
                    }
                    await refreshCheck(); return;
                }
                // v4.2 — اختيار حالة بند (يفتح محرر الحفظ)
                if (btn.dataset.st && btn.dataset.key) {
                    checkSel[btn.dataset.key] = checkSel[btn.dataset.key] === btn.dataset.st ? null : btn.dataset.st;
                    await refreshCheck(); return;
                }
                // v4.2 — حفظ حالة بند (مع المتاح عند النقص)
                if (btn.dataset.save && btn.dataset.status) {
                    const ed = btn.closest('.chk-note-editor');
                    const note = ed ? ed.querySelector('textarea').value : '';
                    const qtyIn = ed ? ed.querySelector('.chk-qty-input') : null;
                    const r = await apiPost('/api/my/check-session/items', {
                        item_key: btn.dataset.save, status_detail: btn.dataset.status, note,
                        qty_available: qtyIn ? qtyIn.value : undefined
                    });
                    delete checkSel[btn.dataset.save];
                    await refreshCheck(r.warning); return;
                }
                // v4.2 — حفظ بيانات المركبة
                if (btn.dataset.vfSave) {
                    const odo = card.querySelector('#vfOdometer');
                    const fuel = card.querySelector('.vf-fuel.on');
                    const clean = card.querySelector('.vf-clean.on');
                    const key = card.querySelector('.vf-key.on');
                    const crd = card.querySelector('.vf-card.on');
                    const r = await apiPost('/api/my/check-session/vehicle-fields', {
                        odometer: odo && odo.value !== '' ? Number(odo.value) : undefined,
                        fuel_level: fuel ? fuel.dataset.vfFuel : undefined,
                        cleanliness: clean ? clean.dataset.vfClean : undefined,
                        master_key: key ? Number(key.dataset.vfKey) : undefined,
                        fuel_card: crd ? Number(crd.dataset.vfCard) : undefined
                    });
                    await refreshCheck(r.warning); return;
                }
                // v4.2 — أزرار حقول المركبة (تحديد بصري فقط، الحفظ بزر الحفظ)
                if (btn.dataset.vfFuel || btn.dataset.vfClean || btn.dataset.vfKey || btn.dataset.vfCard) {
                    const cls = btn.dataset.vfFuel ? '.vf-fuel' : btn.dataset.vfClean ? '.vf-clean' : btn.dataset.vfKey ? '.vf-key' : '.vf-card';
                    card.querySelectorAll(cls).forEach(b => b.classList.remove('on'));
                    btn.classList.add('on'); return;
                }
                // v1 القديم — بلا تغيير
                if (btn.dataset.act === 'ok' && itemEl) {
                    const r = await apiPost('/api/my/check-session/items', { item_key: itemEl.dataset.key, result: 'ok' });
                    await refreshCheck(r.warning);
                } else if (btn.dataset.act === 'issue' && itemEl) {
                    const ed = card.querySelector(`[data-editor="${itemEl.dataset.key}"]`);
                    if (ed) ed.classList.toggle('open');
                } else if (btn.dataset.save) {
                    const ed = btn.closest('.chk-note-editor');
                    const note = ed ? ed.querySelector('textarea').value : '';
                    const r = await apiPost('/api/my/check-session/items', { item_key: btn.dataset.save, result: 'issue', note });
                    await refreshCheck(r.warning);
                } else if (btn.dataset.conf) {
                    const r = await apiPost('/api/my/check-session/confirm', { kind: btn.dataset.conf });
                    await refreshCheck(r.warning);
                }
            } catch (e) {
                toast(e.message || 'تعذر الحفظ — تحقق من الاتصال وحاول مجددًا');
            }
        });
    }

    async function apiPost(path, body) {
        const r = await fetch(path, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw { state: r.status, message: b.error };
        return b;
    }

    // A-4.4 S1: PUT/DELETE بنفس عقد apiPost (الخطأ: {state, message} من body.error)
    async function apiSend(path, method, body) {
        const r = await fetch(path, {
            method,
            headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined
        });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw { state: r.status, message: b.error };
        return b;
    }

    // ── مركبتي (v2) — المركبات المعيّنة حاليًا لفرقة اليوم ──
    function renderVehicle(d) {
        let body;
        if (d.available === false) {
            body = '<div class="empty">بيانات المركبات غير متاحة حاليًا من النظام.</div>';
        } else if (!d.vehicles || d.vehicles.length === 0) {
            // آخر حالة assignment_end أو بلا تعيين أصلًا — رسالة صادقة بلا مركبة قديمة
            body = '<div class="empty">لا توجد مركبة مسندة حاليًا لفرقتك' + (d.team && d.team.teamName ? ' (' + esc(d.team.teamName) + ')' : '') + '.</div>';
        } else {
            body = d.vehicles.map(v => {
                const st = v.status ? `<span class="veh-status st-${esc(v.status)}">${esc(VEH_STATUS[v.status] || v.status)}</span>` : '';
                const meta = [
                    v.plateNumber ? 'لوحة: ' + esc(v.plateNumber) : null,
                    v.vehicleType ? esc(v.vehicleType) : null,
                    v.statusSince ? 'منذ: ' + esc(v.statusSince.slice(0, 10)) : null
                ].filter(Boolean).join(' · ');
                return `<div class="veh-item"><div class="v-name">${esc(v.name)}${st}</div><div class="v-meta">${meta}</div></div>`;
            }).join('');
        }
        return `<div class="card">
            <div class="card-head vehicle">مركبتي</div>
            <div class="card-body">${body}</div>
        </div>`;
    }

    // ── جرد فرقتي (v2) — العرض بالارتباط بالبيانات، والإجراء بالصلاحية ──
    function renderInventory(d, canOpen) {
        const chips = [];
        if (d.assets && d.assets.total > 0) {
            for (const k of Object.keys(ASSET_STATUS)) {
                const c = d.assets.byStatus[k];
                if (c) chips.push(`<div class="chip">${ASSET_STATUS[k]}: <b>${c}</b></div>`);
            }
        }
        const s = d.lastSession;
        const sessionLine = s
            ? `<div class="chip">آخر جلسة جرد: <b>${esc(SESSION_STATUS[s.status] || s.status)}</b> · ${esc((s.approved_at || s.submitted_at || s.started_at || '').slice(0, 10))}${s.conductor_name ? ' · ' + esc(s.conductor_name) : ''}</div>`
            : '<div class="chip">لا توجد جلسة جرد مسجلة لفرقتك بعد</div>';
        const openBtn = canOpen
            ? '<a class="inv-open-btn" href="/assets-inventory.html">فتح الجرد ←</a>'
            : '<div class="inv-note">تنفيذ الجرد يتطلب صلاحية «تنفيذ جلسات الجرد» — تُمنح فرديًا من إدارة النظام.</div>';
        return `<div class="card">
            <div class="card-head inventory">الجرد — عهد فرقتي</div>
            <div class="card-body">
                <div class="chip-row">${chips.join('')}</div>
                <div class="chip-row" style="margin-top:8px">${sessionLine}</div>
                ${openBtn}
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
        return `<div class="card" id="schedCard">
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

    // ── v5: معي في المناوبة — السياق يُشتق خادميًا من تعييني الفعلي (تصحيح 2026-09-16) ──
    function renderMates(d) {
        if (!d || !d.available) return '';
        const w = d.window || {};
        const row = (p, showTeam) => `<div class="mate-row">
            <div>
                <div class="m-name">${esc(p.name)}${p.isMe ? ' <span class="me-tag">(أنا)</span>' : ''}</div>
                <div class="m-role">${esc(p.jobTitle || '—')}${p.shiftCode ? ' · ' + esc(p.shiftCode) : ''}${showTeam && p.teamName ? ' · ' + esc(p.teamName) : ''}</div>
            </div>
            ${p.phone ? `<div class="m-phone"><a class="ph-btn" href="tel:${esc(p.phone)}">📞 اتصال</a>${waHref(p.phone) ? ` <a class="ph-btn wa" href="${waHref(p.phone)}" target="_blank" rel="noopener">واتساب</a>` : ''}</div>` : ''}
        </div>`;
        const teamRows = (d.team || []).map(p => row(p, false)).join('');
        const leadRows = (d.leadership || []).map(p => row(p, true)).join('');
        const opsRows = (d.ops || []).map(p => row(p, true)).join('');
        const stateNote = d.me && d.me.state === 'upcoming'
            ? `<div class="chk-hint" style="margin:0 0 8px">مناوبتك ${esc(w.label || '')} لم تبدأ بعد — المعروض طاقمها مسبقًا.</div>`
            : d.me && !d.me.onShift
                ? '<div class="chk-hint" style="margin:0 0 8px">أنت خارج المناوبة الحالية — المعروضون هم المناوبون الآن.</div>' : '';
        return `<div class="card"><div class="card-head mates">👥 معي في المناوبة</div>
            <div class="card-body">
                <div class="chk-hint" style="margin:0 0 8px">السياق: ${esc(w.label || '')} · ${fmtDateShort(w.date)} ${arDay(w.date)}${w.source === 'clock' ? ' · نافذة الساعة (لا تعيين لك)' : ' · من تعيينك الفعلي'}${w.active ? ' · جارية الآن' : ''}</div>
                ${stateNote}
                ${teamRows ? `<div class="mates-sub">فرقتي${d.me && d.me.teamName ? ' — ' + esc(d.me.teamName) : ''}</div>` + teamRows : ''}
                ${leadRows ? '<div class="mates-sub">القيادة الميدانية</div>' + leadRows : ''}
                ${opsRows ? '<div class="mates-sub">العمليات</div>' + opsRows : ''}
                ${!teamRows && !leadRows && !opsRows ? '<div class="empty">لا يوجد مناوبون مسجلون في هذا السياق.</div>' : ''}
            </div>
        </div>`;
    }

    // ── v5: إشعاراتي — فتح الإشعار ≠ تأكيده (زرّان مستقلان بختمين مستقلين) ──
    function renderNotifs(d) {
        const rows = (d.notifications || []).map(n => {
            const st = n.status === 'acknowledged' ? '<span class="notif-state st-ack">✓ تم التأكيد</span>'
                : n.status === 'read' ? '<span class="notif-state st-read">مقروء — بانتظار التأكيد</span>'
                : '<span class="notif-state st-new">جديد</span>';
            const actions = n.status === 'acknowledged' ? '' : `<div class="n-actions">
                ${n.status !== 'read' ? `<button class="notif-btn" data-nread="${n.id}">تحديد كمقروء</button>` : ''}
                <button class="notif-btn ack" data-nack="${n.id}">✓ تأكيد الاطلاع</button>
            </div>`;
            return `<div class="notif-row${['read', 'acknowledged'].indexOf(n.status) === -1 ? ' unread' : ''}">
                <div class="n-msg">${esc(n.message)}</div>
                <div class="n-meta">${st} · ${esc((n.createdAt || '').slice(0, 16))}</div>
                ${actions}
            </div>`;
        }).join('');
        return `<div class="card" id="notifCard"><div class="card-head notifs">🔔 إشعاراتي${d.unackedCount ? ` <span class="notif-count">${d.unackedCount} بلا تأكيد</span>` : ''}</div>
            <div class="card-body">${rows || '<div class="empty">لا توجد إشعارات بعد — تصلك هنا أي تغييرات على جدولك فور اعتمادها.</div>'}</div>
        </div>`;
    }

    function bindNotifEvents() {
        document.querySelectorAll('[data-nread]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            try { await apiPost('/api/my/notifications/' + b.dataset.nread + '/read'); await refreshNotifs(); }
            catch (e) { b.disabled = false; toast(e.message || 'تعذر الختم'); }
        }));
        document.querySelectorAll('[data-nack]').forEach(b => b.addEventListener('click', async () => {
            b.disabled = true;
            try { await apiPost('/api/my/notifications/' + b.dataset.nack + '/ack'); await refreshNotifs(); }
            catch (e) { b.disabled = false; toast(e.message || 'تعذر التأكيد'); }
        }));
    }

    async function refreshNotifs() {
        try {
            const notifs = await api('/api/my/notifications');
            const tmp = document.createElement('div');
            tmp.innerHTML = renderNotifs(notifs);
            const old = document.getElementById('notifCard');
            if (old) old.replaceWith(tmp.firstElementChild);
            bindNotifEvents();
        } catch (_) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    async function refreshChanges() {
        try {
            const changes = await api('/api/my/schedule-changes');
            const tmp = document.createElement('div');
            tmp.innerHTML = renderChanges(changes);
            const old = document.getElementById('changesCard');
            if (old) old.replaceWith(tmp.firstElementChild);
        } catch (_) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    // ═══ A-4.4 S1: إجازاتي — تقديم/تعديل/إلغاء/سجل، من /api/leave-requests (SSOT: SQLite — A-4.3) ═══
    // لا employee_id يُدخَل أو يُختار من الواجهة إطلاقًا: الهوية من profile
    // (الحساب المرتبط بسجل الموظف) فقط، والخادم يفرض النطاق Server-side (M3).
    // كشف تعارض المناوبات عميليًا من /api/my/schedule — مسار
    // /api/leave-requests/conflicts محجوز لحامل leave.review فلا يُستخدم هنا.
    const LV_STATUS = {
        pending: ['st-pending', 'قيد المراجعة'],
        approved: ['st-approved', 'معتمدة'],
        denied: ['st-denied', 'مرفوضة'],
        cancelled: ['st-cancelled', 'ملغاة']
    };
    const LV_TYPES = ['إجازة', 'مرضية', 'استثنائية']; // الأنواع المقبولة في A-4.3 حصرًا
    const LV_EV_LABEL = { pending: 'قيد المراجعة', approved: 'معتمدة ✓', denied: 'مرفوضة ✗', cancelled: 'ملغاة' };
    let leaveProfile = null;        // يُملأ من load() — المصدر الوحيد لـ employee.id
    let leaveEditingId = null;      // وضع التعديل (PUT) — null يعني طلبًا جديدًا
    let leaveRowsById = new Map();  // صفوف آخر جلب — لتعبئة نموذج التعديل
    const lvSchedCache = new Map(); // كاش جداول الأشهر لكشف التعارض («YYYY-M»)

    function lvDaysCount(s, e) {
        const a = Date.parse(s), b = Date.parse(e);
        if (isNaN(a) || isNaN(b) || b < a) return null;
        return Math.round((b - a) / 86400000) + 1; // شامل الطرفين
    }

    function renderLeave(d) {
        const today = riyadhToday();
        let rows = '';
        if (d && d.__error) {
            rows = '<div class="empty">تعذر تحميل طلباتك حاليًا — حدّث الصفحة للمحاولة مجددًا.</div>';
        } else {
            const reqs = (d && d.requests) || [];
            leaveRowsById = new Map(reqs.map(r => [Number(r.id), r]));
            rows = reqs.map(r => {
                const st = LV_STATUS[r.status] || ['', r.status];
                const days = lvDaysCount(r.start_date, r.end_date);
                // pending انتهت أيامه دون مراجعة — يُوسم صراحة ولا يُعرض كطلب قابل للتنفيذ
                const expiredPending = r.status === 'pending' && today && r.end_date < today;
                // التعديل/الإلغاء: pending وبدايته في المستقبل فقط (الخادم يحسم أي سباق — M2)
                const canAct = r.status === 'pending' && today && r.start_date > today;
                const denyNote = r.status === 'denied' && r.denial_reason
                    ? `<div class="lv-reason-note">سبب الرفض: ${esc(r.denial_reason)}</div>` : '';
                const cancelNote = r.status === 'cancelled' && r.cancel_reason
                    ? `<div class="lv-reason-note cancel">سبب الإلغاء: ${esc(r.cancel_reason)}</div>` : '';
                return `<div class="lv-row">
                    <div class="lv-head">
                        <div>
                            <div class="lv-type">${esc(r.type)}${days ? ` <small style="color:var(--muted);font-weight:400">(${days} ${days === 1 ? 'يوم' : 'أيام'})</small>` : ''}</div>
                            <div class="lv-range">${esc(r.start_date)} ← ${esc(r.end_date)}</div>
                        </div>
                        <span class="lv-status ${st[0]}">${esc(st[1])}</span>
                    </div>
                    ${expiredPending ? '<span class="lv-expired">منتهي — بانتظار المراجعة</span>' : ''}
                    ${r.reason ? `<div class="lv-range">السبب: ${esc(r.reason)}</div>` : ''}
                    ${denyNote}${cancelNote}
                    <div class="lv-row-actions">
                        <button class="lv-btn" type="button" data-lvevents="${r.id}">السجل</button>
                        ${canAct ? `<button class="lv-btn edit" type="button" data-lvedit="${r.id}">تعديل</button>
                        <button class="lv-btn cancel" type="button" data-lvcancel="${r.id}">إلغاء الطلب</button>` : ''}
                    </div>
                    <div class="lv-events" id="lvEvents${r.id}"></div>
                </div>`;
            }).join('') || '<div class="empty">لا توجد طلبات إجازة بعد — قدّم طلبك من الزر أعلاه.</div>';
        }
        return `<div class="card" id="leaveCard"><div class="card-head leave">🌴 إجازاتي</div>
            <div class="card-body">
                <button class="lv-new-btn" id="lvNewBtn" type="button">＋ طلب إجازة جديد</button>
                <div class="lv-form" id="lvForm">
                    <div class="lv-form-title" id="lvFormTitle">طلب إجازة جديد</div>
                    <div class="lv-dates">
                        <div><label>من تاريخ</label><input type="date" id="lvStart"></div>
                        <div><label>إلى تاريخ</label><input type="date" id="lvEnd"></div>
                    </div>
                    <label>نوع الإجازة</label>
                    <select id="lvType">${LV_TYPES.map(t => `<option>${t}</option>`).join('')}</select>
                    <label>السبب (اختياري)</label>
                    <textarea id="lvReason" maxlength="300"></textarea>
                    <div class="lv-days" id="lvDays"></div>
                    <div class="lv-conflict" id="lvConflict"></div>
                    <div class="lv-error" id="lvError"></div>
                    <div class="lv-form-actions">
                        <button class="lv-submit" id="lvSubmit" type="button">إرسال الطلب</button>
                        <button class="lv-cancel-form" id="lvCancelForm" type="button">تراجع</button>
                    </div>
                </div>
                <div style="margin-top:12px">${rows}</div>
            </div>
        </div>`;
    }

    function lvShowError(m) {
        const el = document.getElementById('lvError');
        if (el) { el.textContent = m; el.classList.add('show'); }
    }
    function lvHideError() {
        const el = document.getElementById('lvError');
        if (el) { el.textContent = ''; el.classList.remove('show'); }
    }
    function lvUpdateDays() {
        const s = document.getElementById('lvStart').value, e = document.getElementById('lvEnd').value;
        const n = lvDaysCount(s, e);
        const el = document.getElementById('lvDays');
        el.textContent = n ? `المدة: ${n} ${n === 1 ? 'يوم' : 'أيام'}` : (s && e ? 'تحقق من التواريخ — النهاية قبل البداية.' : '');
    }

    // تعارض المناوبات المنشورة مع الفترة المختارة — شريط أصفر غير حاجب (D7:
    // اعتماد الإجازة لا يعدّل shift_roster؛ المعالجة إجراء مستقل لاحقًا).
    // يوم مناوبة = له shiftCode وليس يوم راحة/إجازة (نفس قاعدة renderSchedule).
    async function lvCheckConflict() {
        const el = document.getElementById('lvConflict');
        if (!el) return;
        el.classList.remove('show'); el.textContent = '';
        const s = document.getElementById('lvStart').value, e = document.getElementById('lvEnd').value;
        if (!s || !e || e < s) return;
        try {
            const days = [];
            let y = +s.slice(0, 4), m = +s.slice(5, 7);
            const ey = +e.slice(0, 4), em = +e.slice(5, 7);
            let guard = 0;
            while ((y < ey || (y === ey && m <= em)) && guard++ < 24) {
                const key = y + '-' + m;
                if (!lvSchedCache.has(key)) {
                    lvSchedCache.set(key, await api(`/api/my/schedule?month=${m}&year=${y}`).catch(() => null));
                }
                const sch = lvSchedCache.get(key);
                ((sch && sch.days) || []).forEach(d => {
                    if (d.date >= s && d.date <= e && d.shiftCode &&
                        !(d.codeStatus && d.codeStatus !== 'دوام' && d.codeStatus !== 'تكميل')) {
                        days.push(d);
                    }
                });
                m++; if (m > 12) { m = 1; y++; }
            }
            if (days.length) {
                el.innerHTML = '⚠️ لديك مناوبات منشورة خلال هذه الفترة: ' +
                    days.map(d => `${fmtDateShort(d.date)} ${arDay(d.date)} (${esc(d.shiftName || d.shiftCode)}${d.teamName ? ' — ' + esc(d.teamName) : ''})`).join('، ') +
                    '.<br>اعتماد الإجازة لا يلغي المناوبة تلقائيًا — تُعالج بإجراء مستقل من المشرف.';
                el.classList.add('show');
            }
        } catch (_) { /* فشل الكشف لا يمنع التقديم — التحذير مساعد فقط */ }
    }

    function lvRenderEvents(events) {
        if (!events.length) return '<div class="lv-ev">لا توجد أحداث مسجلة.</div>';
        return events.map(ev => {
            const to = LV_EV_LABEL[ev.to_status] || ev.to_status;
            const trans = ev.from_status == null
                ? `<b>تقديم الطلب ← ${esc(to)}</b>`
                : `<b>${esc(LV_EV_LABEL[ev.from_status] || ev.from_status)} ← ${esc(to)}</b>`;
            return `<div class="lv-ev">• ${trans}${ev.reason ? ' — ' + esc(ev.reason) : ''}<br>
                <span class="lv-ev-time">${esc((ev.created_at || '').slice(0, 16))}</span></div>`;
        }).join('');
    }

    function bindLeaveEvents() {
        const newBtn = document.getElementById('lvNewBtn');
        if (!newBtn) return;
        const form = document.getElementById('lvForm');
        const startEl = document.getElementById('lvStart');
        const endEl = document.getElementById('lvEnd');
        const submitBtn = document.getElementById('lvSubmit');
        const today = riyadhToday();
        if (today) { startEl.min = today; endEl.min = today; }

        function openForm(editRow) {
            leaveEditingId = editRow ? editRow.id : null;
            document.getElementById('lvFormTitle').textContent = editRow ? 'تعديل طلب الإجازة' : 'طلب إجازة جديد';
            submitBtn.textContent = editRow ? 'حفظ التعديل' : 'إرسال الطلب';
            submitBtn.disabled = false;
            startEl.value = editRow ? editRow.start_date : '';
            endEl.value = editRow ? editRow.end_date : '';
            document.getElementById('lvType').value = editRow ? editRow.type : LV_TYPES[0];
            document.getElementById('lvReason').value = editRow ? (editRow.reason || '') : '';
            lvHideError(); lvUpdateDays(); lvCheckConflict();
            form.classList.add('open');
        }
        newBtn.addEventListener('click', () => {
            if (form.classList.contains('open') && !leaveEditingId) { form.classList.remove('open'); return; }
            openForm(null);
        });
        document.getElementById('lvCancelForm').addEventListener('click', () => {
            form.classList.remove('open'); leaveEditingId = null;
        });
        startEl.addEventListener('change', () => {
            if (endEl.value && startEl.value && startEl.value > endEl.value) endEl.value = startEl.value;
            if (startEl.value) endEl.min = startEl.value;
            lvUpdateDays(); lvCheckConflict();
        });
        endEl.addEventListener('change', () => { lvUpdateDays(); lvCheckConflict(); });

        submitBtn.addEventListener('click', async () => {
            lvHideError();
            const s = startEl.value, e = endEl.value;
            const type = document.getElementById('lvType').value;
            const reason = document.getElementById('lvReason').value.trim();
            if (!s || !e) { lvShowError('حدّد تاريخي البداية والنهاية.'); return; }
            if (e < s) { lvShowError('تاريخ النهاية قبل تاريخ البداية.'); return; }
            if (!leaveProfile || !leaveProfile.employee || leaveProfile.employee.id == null) {
                lvShowError('حسابك غير مربوط بسجل موظف — راجع المشرف.'); return;
            }
            submitBtn.disabled = true;
            try {
                if (leaveEditingId) {
                    await apiSend('/api/leave-requests/' + leaveEditingId, 'PUT',
                        { start_date: s, end_date: e, type, reason: reason || undefined });
                    toast('تم حفظ التعديل — طلبك بانتظار المراجعة');
                } else {
                    // employee_id من profile المرتبط بالحساب — لا إدخال ولا اختيار
                    const b = await apiPost('/api/leave-requests',
                        { employee_id: leaveProfile.employee.id, start_date: s, end_date: e, type, reason: reason || undefined });
                    if (b && Array.isArray(b.warnings) && b.warnings.length) {
                        toast('⚠️ ' + b.warnings.map(w =>
                            `يوم ${w.date}: يوجد ${w.pendingCount} طلب أخرى قيد المراجعة`).join(' — '));
                    }
                    toast('تم إرسال طلبك — بانتظار المراجعة');
                }
                leaveEditingId = null;
                await refreshLeave();
            } catch (err) {
                submitBtn.disabled = false;
                lvShowError((err && err.message) || 'تعذر إرسال الطلب — حاول مجددًا.');
            }
        });

        document.querySelectorAll('[data-lvedit]').forEach(b => b.addEventListener('click', () => {
            const row = leaveRowsById.get(Number(b.dataset.lvedit));
            if (row) openForm(row);
        }));
        document.querySelectorAll('[data-lvcancel]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('هل تريد إلغاء طلب الإجازة هذا؟')) return;
            b.disabled = true;
            try {
                // إلغاء المالك لطلب pending — بلا سبب (السبب إلزامي فقط لإلغاء المخوَّل لمعتمدة)
                await apiSend('/api/leave-requests/' + b.dataset.lvcancel, 'DELETE');
                toast('تم إلغاء الطلب');
                await refreshLeave();
            } catch (err) { b.disabled = false; toast((err && err.message) || 'تعذر الإلغاء'); }
        }));
        document.querySelectorAll('[data-lvevents]').forEach(b => b.addEventListener('click', async () => {
            const box = document.getElementById('lvEvents' + b.dataset.lvevents);
            if (!box) return;
            if (box.classList.contains('open')) { box.classList.remove('open'); return; }
            box.innerHTML = '<div class="lv-ev">جارٍ التحميل…</div>';
            box.classList.add('open');
            try {
                const r = await api('/api/leave-requests/' + b.dataset.lvevents + '/events');
                box.innerHTML = lvRenderEvents(r.events || []);
            } catch (_) { box.innerHTML = '<div class="lv-ev">تعذر تحميل السجل.</div>'; }
        }));
    }

    async function refreshLeave() {
        try {
            const d = await api('/api/leave-requests').catch(() => ({ __error: true }));
            const tmp = document.createElement('div');
            tmp.innerHTML = renderLeave(d);
            const old = document.getElementById('leaveCard');
            if (old) old.replaceWith(tmp.firstElementChild); // نمط refreshNotifs نفسه
            bindLeaveEvents();
        } catch (_) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    // ═══ F-2: طلبات تغيير المناوبة — تقديم/متابعة/إلغاء، نطاق الحساب فقط ═══
    // لا employee_id ولا old_shift_code يُرسَلان من الواجهة إطلاقًا: الخادم يفرض
    // الموظف من الحساب المرتبط (د2) ويشتق المناوبة الحالية من shift_roster
    // (قاعدة المالك) — الواجهة ترسل التاريخ والرمز المقترح والسبب فقط.
    const SC_STATUS = {
        pending: ['st-pending', 'قيد المراجعة'],
        approved: ['st-approved', 'معتمدة'],
        denied: ['st-denied', 'مرفوضة'],
        cancelled: ['st-cancelled', 'ملغاة']
    };
    let scCodesCache = null;        // الرموز المعتمدة (/api/shift-codes) — تُجلب مرة واحدة
    const scSchedCache = new Map(); // كاش أشهر الجدول لعرض «مناوبتك الحالية» لليوم المختار

    function renderShiftChange(d) {
        let rows = '';
        if (d && d.__error) {
            rows = '<div class="empty">تعذر تحميل طلباتك حاليًا — حدّث الصفحة للمحاولة مجددًا.</div>';
        } else {
            const reqs = (d && d.requests) || [];
            rows = reqs.map(r => {
                const st = SC_STATUS[r.status] || ['', r.status];
                const oldV = r.oldShiftCode ? (r.oldShiftName || r.oldShiftCode) : 'لا مناوبة مسجلة';
                return `<div class="lv-row">
                    <div class="lv-head">
                        <div>
                            <div class="lv-type">${esc(r.date)}</div>
                            <div class="lv-range">${esc(oldV)} ← <b>${esc(r.proposedShiftName || r.proposedShiftCode)}</b></div>
                        </div>
                        <span class="lv-status ${st[0]}">${esc(st[1])}</span>
                    </div>
                    ${r.reason ? `<div class="lv-range">السبب: ${esc(r.reason)}</div>` : ''}
                    <div class="lv-row-actions">
                        ${r.status === 'pending' ? `<button class="lv-btn cancel" type="button" data-sccancel="${r.id}">إلغاء الطلب</button>` : ''}
                    </div>
                </div>`;
            }).join('') || '<div class="empty">لا توجد طلبات تغيير مناوبة — قدّم طلبك من الزر أعلاه.</div>';
        }
        return `<div class="card" id="shiftChangeCard"><div class="card-head leave">🔁 طلبات تغيير المناوبة</div>
            <div class="card-body">
                <button class="lv-new-btn" id="scNewBtn" type="button">＋ طلب تغيير مناوبة</button>
                <div class="lv-form" id="scForm">
                    <div class="lv-form-title">طلب تغيير مناوبة</div>
                    <label>يوم المناوبة</label>
                    <input type="date" id="scDate">
                    <div class="lv-days" id="scCurrent"></div>
                    <label>الرمز المقترح</label>
                    <select id="scCode"><option value="">— حدّد يوم المناوبة أولًا —</option></select>
                    <label>السبب (اختياري)</label>
                    <textarea id="scReason" maxlength="300"></textarea>
                    <div class="lv-error" id="scError"></div>
                    <div class="lv-form-actions">
                        <button class="lv-submit" id="scSubmit" type="button">إرسال الطلب</button>
                        <button class="lv-cancel-form" id="scCancelForm" type="button">تراجع</button>
                    </div>
                </div>
                <div style="margin-top:12px">${rows}</div>
            </div>
        </div>`;
    }

    function scShowError(m) {
        const el = document.getElementById('scError');
        if (el) { el.textContent = m; el.classList.add('show'); }
    }
    function scHideError() {
        const el = document.getElementById('scError');
        if (el) { el.textContent = ''; el.classList.remove('show'); }
    }

    // عرض «مناوبتك الحالية» لليوم المختار — للاطلاع فقط؛ القيمة المخزَّنة يشتقها
    // الخادم من shift_roster عند التقديم ولا تُرسَل من هنا (قاعدة المالك).
    async function scShowCurrent() {
        const el = document.getElementById('scCurrent');
        if (!el) return;
        el.textContent = '';
        const date = document.getElementById('scDate').value;
        if (!date) return;
        try {
            const y = +date.slice(0, 4), m = +date.slice(5, 7);
            const key = y + '-' + m;
            if (!scSchedCache.has(key)) {
                scSchedCache.set(key, await api(`/api/my/schedule?month=${m}&year=${y}`).catch(() => null));
            }
            const sch = scSchedCache.get(key);
            const day = ((sch && sch.days) || []).find(d => d.date === date);
            el.textContent = day && day.shiftCode
                ? `مناوبتك الحالية في هذا اليوم: ${day.shiftName || day.shiftCode}${day.teamName ? ' — ' + day.teamName : ''}`
                : 'لا توجد مناوبة مسجلة لك في هذا اليوم — عند الاعتماد سيُنشأ سطر بالرمز المقترح.';
        } catch (_) { /* العرض مساعد فقط — لا يمنع التقديم */ }
    }

    async function scEnsureCodes() {
        const sel = document.getElementById('scCode');
        if (!sel || scCodesCache) return;
        try {
            const d = await api('/api/shift-codes');
            const codes = (d && (d.codes || d.shift_codes || d.data)) || (Array.isArray(d) ? d : []);
            scCodesCache = codes;
            sel.innerHTML = '<option value="">— اختر الرمز المقترح —</option>' +
                codes.map(c => `<option value="${esc(c.code)}">${esc(c.name || c.code)} (${esc(c.code)})</option>`).join('');
        } catch (_) {
            sel.innerHTML = '<option value="">— تعذر تحميل الرموز —</option>';
        }
    }

    function bindShiftChangeEvents() {
        const newBtn = document.getElementById('scNewBtn');
        if (!newBtn) return;
        const form = document.getElementById('scForm');
        const dateEl = document.getElementById('scDate');
        const submitBtn = document.getElementById('scSubmit');

        newBtn.addEventListener('click', () => {
            form.classList.toggle('open');
            if (form.classList.contains('open')) { scHideError(); scEnsureCodes(); scShowCurrent(); }
        });
        document.getElementById('scCancelForm').addEventListener('click', () => form.classList.remove('open'));
        dateEl.addEventListener('change', scShowCurrent);

        submitBtn.addEventListener('click', async () => {
            scHideError();
            const date = dateEl.value;
            const code = document.getElementById('scCode').value;
            const reason = document.getElementById('scReason').value.trim();
            if (!date) { scShowError('حدّد يوم المناوبة.'); return; }
            if (!code) { scShowError('اختر الرمز المقترح.'); return; }
            submitBtn.disabled = true;
            try {
                // التاريخ + الرمز + السبب فقط — الموظف والقيمة الحالية من الخادم (د2 + قاعدة المالك)
                await apiPost('/api/shift-change-request',
                    { shift_date: date, proposed_shift_code: code, reason: reason || undefined });
                toast('تم إرسال طلبك — بانتظار المراجعة');
                form.classList.remove('open');
                dateEl.value = ''; document.getElementById('scReason').value = '';
                document.getElementById('scCurrent').textContent = '';
                await refreshShiftChange();
            } catch (err) {
                submitBtn.disabled = false;
                scShowError((err && err.message) || 'تعذر إرسال الطلب — حاول مجددًا.');
            }
        });

        document.querySelectorAll('[data-sccancel]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('هل تريد إلغاء طلب تغيير المناوبة هذا؟')) return;
            b.disabled = true;
            try {
                await apiPost('/api/my/shift-change-requests/' + b.dataset.sccancel + '/cancel', {});
                toast('تم إلغاء الطلب');
                await refreshShiftChange();
            } catch (err) { b.disabled = false; toast((err && err.message) || 'تعذر الإلغاء'); }
        }));
    }

    async function refreshShiftChange() {
        try {
            const d = await api('/api/my/shift-change-requests').catch(() => ({ __error: true }));
            const tmp = document.createElement('div');
            tmp.innerHTML = renderShiftChange(d);
            const old = document.getElementById('shiftChangeCard');
            if (old) old.replaceWith(tmp.firstElementChild); // نمط refreshLeave نفسه
            bindShiftChangeEvents();
        } catch (_) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    // ═══ FSS E-3 (معتمد 2026-10-06 — ج1): تفضيلاتي للشهر القادم ═══
    // استهلاك صِرف لعقد E-1 (GET/PUT /api/my/schedule-preferences): النافذة
    // تُنفَّذ خادميًا (ج2/ب — 422 PREFERENCE_WINDOW_CLOSED) والواجهة تعكسها
    // فقط. Soft Preferences: لا ضمان ولا ترجمة لجدولة هنا. لا localStorage —
    // كل عرض من API مباشرة (درس V-B). حد الزمالة 3 (M14) — تلميح واجهة،
    // والخادم هو الحارس (COLLEAGUE_LIMIT_EXCEEDED).
    const PF_TYPES = { shift: 'مناوبة مفضلة', day_off: 'يوم راحة', colleague: 'زميل مفضل' };
    let pfCodesCache = null;       // رموز المناوبات (/api/shift-codes) — تُجلب مرة
    let pfColleaguesCache = null;  // زملاء الفريق النشط (/api/my/team-colleagues — ج3)

    function pfPrefChips(prefs, colleagues) {
        if (!prefs.length) return '<div class="empty">لا توجد تفضيلات مسجلة لهذا الشهر بعد.</div>';
        const nameOf = (id) => {
            const c = (colleagues || []).find(x => String(x.id) === String(id));
            return c ? c.name : ('زميل #' + id);
        };
        return '<div class="chip-row">' + prefs.map(p => {
            const label = p.pref_type === 'colleague' ? 'زميل: ' + esc(nameOf(p.pref_value))
                : p.pref_type === 'day_off' ? 'راحة: ' + esc(p.pref_value)
                : 'مناوبة: ' + esc(p.pref_value);
            return `<span class="chip">${label}</span>`;
        }).join('') + '</div>';
    }

    function renderPrefs(d) {
        let body = '';
        if (d && d.__error) {
            body = '<div class="empty">تعذر تحميل التفضيلات حاليًا — حدّث الصفحة للمحاولة مجددًا.</div>';
        } else {
            const w = (d && d.window) || {};
            const prefs = (d && d.preferences) || [];
            const winLine = w.is_open
                ? `النافذة مفتوحة لشهر <b>${esc(w.target_month || '')}</b> — التقديم حتى يوم ${esc(String(w.close_day || ''))}`
                : `النافذة مغلقة حاليًا (تفتح يوم ${esc(String(w.open_day || ''))} وتغلق يوم ${esc(String(w.close_day || ''))} — الشهر المستهدف ${esc(w.target_month || '')})`;
            if (w.is_open) {
                body = `<div class="lv-days" style="margin-bottom:10px">${winLine}</div>
                    <div class="pf-sec">المناوبات المفضلة <small>(رمز «دوام» فقط — بلا سقف في هذه النسخة)</small></div>
                    <div class="pf-opts" id="pfShiftOpts"><div class="empty">جاري تحميل الرموز…</div></div>
                    <div class="pf-sec">أيام راحة مفضلة <small>(داخل ${esc(w.target_month || '')})</small></div>
                    <div id="pfDayOffList"></div>
                    <button class="lv-btn" id="pfAddDayOff" type="button">＋ إضافة يوم راحة</button>
                    <div class="pf-sec">زملاء مفضلون <small>(حتى 3 — تفضيل إيجابي فقط، وليس ضمانًا)</small></div>
                    <div class="pf-opts" id="pfColleagueOpts"><div class="empty">جاري تحميل الزملاء…</div></div>
                    <div class="lv-error" id="pfError"></div>
                    <div class="lv-form-actions">
                        <button class="lv-submit" id="pfSave" type="button">حفظ التفضيلات</button>
                    </div>`;
            } else {
                body = `<div class="lv-days" style="margin-bottom:10px">${winLine}</div>
                    ${pfPrefChips(prefs, null)}
                    <div class="pf-hint">بعد إغلاق النافذة يمكنك استخدام المسارات المعتمدة: طلب تغيير المناوبة، أو الإجازة، أو طلب عدم التمكّن من البطاقة أدناه.</div>`;
            }
        }
        return `<div class="card" id="prefsCard"><div class="card-head prefs">⭐ تفضيلاتي للشهر القادم</div>
            <div class="card-body">${body}</div>
        </div>`;
    }

    function pfShowError(m) {
        const el = document.getElementById('pfError');
        if (el) { el.textContent = m; el.classList.add('show'); }
    }
    function pfHideError() {
        const el = document.getElementById('pfError');
        if (el) { el.textContent = ''; el.classList.remove('show'); }
    }

    async function pfEnsureRefs() {
        const w = (await api('/api/my/schedule-preferences').catch(() => null));
        const targetMonth = w && w.window && w.window.target_month;
        // الرموز: «دوام» فقط — نفس قاعدة الخادم (INVALID_SHIFT_CODE)
        if (!pfCodesCache) {
            try {
                const cd = await api('/api/shift-codes');
                const codes = (cd && (cd.codes || cd.shift_codes || cd.data)) || (Array.isArray(cd) ? cd : []);
                pfCodesCache = codes.filter(c => !c.status || c.status === 'دوام');
            } catch (_) { pfCodesCache = []; }
        }
        const shiftBox = document.getElementById('pfShiftOpts');
        if (shiftBox) {
            const cur = (w && w.preferences || []).filter(p => p.pref_type === 'shift').map(p => p.pref_value);
            shiftBox.innerHTML = pfCodesCache.length
                ? pfCodesCache.map(c => `<label class="pf-opt"><input type="checkbox" class="pf-shift" value="${esc(c.code)}"${cur.includes(String(c.code)) ? ' checked' : ''}> ${esc(c.name || c.code)} (${esc(c.code)})</label>`).join('')
                : '<div class="empty">تعذر تحميل الرموز.</div>';
        }
        // الزملاء: الفريق النشط من الخادم (ج3) — لا قائمة ثابتة
        if (!pfColleaguesCache) {
            pfColleaguesCache = await api('/api/my/team-colleagues').catch(() => null);
        }
        const colBox = document.getElementById('pfColleagueOpts');
        if (colBox) {
            const colleagues = (pfColleaguesCache && pfColleaguesCache.colleagues) || [];
            const cur = (w && w.preferences || []).filter(p => p.pref_type === 'colleague').map(p => String(p.pref_value));
            colBox.innerHTML = colleagues.length
                ? colleagues.map(c => `<label class="pf-opt"><input type="checkbox" class="pf-coll" value="${c.id}"${cur.includes(String(c.id)) ? ' checked' : ''}> ${esc(c.name)} <small>(${esc(c.employee_code || '')})</small></label>`).join('')
                : '<div class="empty">لا يوجد زملاء نشطون في فريقك الحالي.</div>';
            colBox.querySelectorAll('.pf-coll').forEach(cb => cb.addEventListener('change', () => {
                const checked = colBox.querySelectorAll('.pf-coll:checked');
                if (checked.length > 3) { cb.checked = false; pfShowError('الحد الأقصى لتفضيلات الزمالة هو 3 (M14).'); }
                else pfHideError();
            }));
        }
        // أيام الراحة الحالية → صفوف جاهزة
        const list = document.getElementById('pfDayOffList');
        if (list && targetMonth) {
            const cur = (w && w.preferences || []).filter(p => p.pref_type === 'day_off').map(p => p.pref_value);
            list.innerHTML = '';
            (cur.length ? cur : []).forEach(v => pfAddDayOffRow(targetMonth, v));
        }
        return targetMonth;
    }

    function pfAddDayOffRow(targetMonth, value) {
        const list = document.getElementById('pfDayOffList');
        if (!list) return;
        const y = +targetMonth.slice(0, 4), m = +targetMonth.slice(5, 7);
        const lastDay = new Date(y, m, 0).getDate();
        const row = document.createElement('div');
        row.className = 'pf-dayoff-row';
        row.innerHTML = `<input type="date" class="pf-dayoff" min="${targetMonth}-01" max="${targetMonth}-${String(lastDay).padStart(2, '0')}"${value ? ` value="${esc(value)}"` : ''}>
            <button class="lv-btn cancel" type="button">حذف</button>`;
        row.querySelector('button').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    async function bindPrefsEvents() {
        const saveBtn = document.getElementById('pfSave');
        if (!saveBtn) return; // النافذة مغلقة — عرض فقط
        const targetMonth = await pfEnsureRefs();
        document.getElementById('pfAddDayOff').addEventListener('click', () => {
            if (targetMonth) pfAddDayOffRow(targetMonth, null);
        });
        saveBtn.addEventListener('click', async () => {
            pfHideError();
            const prefs = [];
            document.querySelectorAll('.pf-shift:checked').forEach(cb => prefs.push({ pref_type: 'shift', pref_value: cb.value }));
            document.querySelectorAll('.pf-dayoff').forEach(inp => { if (inp.value) prefs.push({ pref_type: 'day_off', pref_value: inp.value }); });
            document.querySelectorAll('.pf-coll:checked').forEach(cb => prefs.push({ pref_type: 'colleague', pref_value: cb.value }));
            saveBtn.disabled = true;
            try {
                await apiSend('/api/my/schedule-preferences', 'PUT', { month: targetMonth, preferences: prefs });
                toast('تم حفظ تفضيلاتك');
                pfCodesCache = null; pfColleaguesCache = null;
                await refreshPrefs();
            } catch (err) {
                saveBtn.disabled = false;
                pfShowError((err && err.message) || 'تعذر حفظ التفضيلات — حاول مجددًا.');
            }
        });
    }

    async function refreshPrefs() {
        try {
            const d = await api('/api/my/schedule-preferences').catch(() => ({ __error: true }));
            const tmp = document.createElement('div');
            tmp.innerHTML = renderPrefs(d);
            const old = document.getElementById('prefsCard');
            if (old) old.replaceWith(tmp.firstElementChild);
            bindPrefsEvents();
        } catch (_) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    // ═══ FSS E-3 (معتمد 2026-10-06 — ج1): عدم التمكّن — استهلاك صِرف لعقد E-2 ═══
    // كل القواعد (M1 حد الأيام / M2 فحص التغطية / د1 الإلغاء / د2 الماضي) خادمية؛
    // الواجهة تعرض الحالات الخمس وترسل التاريخ والسبب فقط. لا localStorage.
    const UA_STATUS = {
        auto_approved: ['st-approved', 'مقبول تلقائيًا'],
        approved: ['st-approved', 'معتمد'],
        pending_review: ['st-pending', 'قيد مراجعة المسؤول'],
        rejected: ['st-denied', 'مرفوض'],
        cancelled: ['st-cancelled', 'ملغي']
    };
    const UA_CANCELLABLE = ['pending_review', 'auto_approved', 'approved']; // د1

    function renderUnable(d) {
        let rows = '', counter = '';
        if (d && d.__error) {
            rows = '<div class="empty">تعذر تحميل الطلبات حاليًا — حدّث الصفحة للمحاولة مجددًا.</div>';
        } else {
            const reqs = (d && d.requests) || [];
            const today = riyadhToday();
            const curMonthKey = today ? today.slice(0, 7) : '';
            const liveThisMonth = reqs.filter(r => UA_CANCELLABLE.includes(r.status) && r.month === curMonthKey).length;
            counter = `طلباتك الحية هذا الشهر (${esc(curMonthKey)}): <b>${liveThisMonth}</b> من ${esc(String((d && d.max_days) || ''))} — ما زاد عن الحد يدخل مراجعة مسؤول تلقائيًا ولا يُرفض`;
            rows = reqs.map(r => {
                const st = UA_STATUS[r.status] || ['', r.status];
                const cancellable = UA_CANCELLABLE.includes(r.status) && today && r.off_date >= today;
                return `<div class="lv-row">
                    <div class="lv-head">
                        <div>
                            <div class="lv-type">${esc(r.off_date)} — ${arDay(r.off_date)}</div>
                            ${r.reason ? `<div class="lv-range">السبب: ${esc(r.reason)}</div>` : ''}
                            ${r.is_exception ? '<div class="lv-range" style="color:var(--gold-id)">استثناء: تجاوز حد الأيام الشهري — يحتاج اعتماد مسؤول</div>' : ''}
                            ${r.review_note ? `<div class="lv-range">ملاحظة المراجعة: ${esc(r.review_note)}</div>` : ''}
                        </div>
                        <span class="lv-status ${st[0]}">${esc(st[1])}</span>
                    </div>
                    <div class="lv-row-actions">
                        ${cancellable ? `<button class="lv-btn cancel" type="button" data-uacancel="${r.id}">إلغاء الطلب</button>` : ''}
                    </div>
                </div>`;
            }).join('') || '<div class="empty">لا توجد طلبات عدم تمكّن — قدّم طلبك من الزر أعلاه.</div>';
        }
        return `<div class="card" id="unableCard"><div class="card-head unable">🚫 عدم التمكّن من الحضور</div>
            <div class="card-body">
                ${counter ? `<div class="lv-days" style="margin-bottom:10px">${counter}</div>` : ''}
                <button class="lv-new-btn" id="uaNewBtn" type="button">＋ طلب عدم تمكّن</button>
                <div class="lv-form" id="uaForm">
                    <div class="lv-form-title">طلب عدم تمكّن من الحضور</div>
                    <label>اليوم</label>
                    <input type="date" id="uaDate">
                    <label>السبب (اختياري)</label>
                    <textarea id="uaReason" maxlength="300"></textarea>
                    <div class="lv-error" id="uaError"></div>
                    <div class="lv-form-actions">
                        <button class="lv-submit" id="uaSubmit" type="button">إرسال الطلب</button>
                        <button class="lv-cancel-form" id="uaCancelForm" type="button">تراجع</button>
                    </div>
                </div>
                <div style="margin-top:12px">${rows}</div>
            </div>
        </div>`;
    }

    function uaShowError(m) {
        const el = document.getElementById('uaError');
        if (el) { el.textContent = m; el.classList.add('show'); }
    }
    function uaHideError() {
        const el = document.getElementById('uaError');
        if (el) { el.textContent = ''; el.classList.remove('show'); }
    }

    function bindUnableEvents() {
        const newBtn = document.getElementById('uaNewBtn');
        if (!newBtn) return;
        const form = document.getElementById('uaForm');
        const dateEl = document.getElementById('uaDate');
        const submitBtn = document.getElementById('uaSubmit');
        newBtn.addEventListener('click', () => {
            form.classList.toggle('open');
            if (form.classList.contains('open')) {
                uaHideError();
                const t = riyadhToday();
                if (t) dateEl.min = t; // تلميح واجهة — الخادم يفرض PAST_DATE (د2)
            }
        });
        document.getElementById('uaCancelForm').addEventListener('click', () => form.classList.remove('open'));
        submitBtn.addEventListener('click', async () => {
            uaHideError();
            const date = dateEl.value;
            const reason = document.getElementById('uaReason').value.trim();
            if (!date) { uaShowError('حدّد اليوم.'); return; }
            submitBtn.disabled = true;
            try {
                const out = await apiPost('/api/my/unable-attend', { off_date: date, reason: reason || undefined });
                toast(out && out.status === 'pending_review'
                    ? 'تم إرسال طلبك — يحتاج مراجعة مسؤول'
                    : 'تم قبول طلبك تلقائيًا');
                form.classList.remove('open');
                dateEl.value = ''; document.getElementById('uaReason').value = '';
                await refreshUnable();
            } catch (err) {
                submitBtn.disabled = false;
                uaShowError((err && err.message) || 'تعذر إرسال الطلب — حاول مجددًا.');
            }
        });
        document.querySelectorAll('[data-uacancel]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('هل تريد إلغاء طلب عدم التمكّن هذا؟')) return;
            b.disabled = true;
            try {
                await apiPost('/api/my/unable-attend/' + b.dataset.uacancel + '/cancel', {});
                toast('تم إلغاء الطلب');
                await refreshUnable();
            } catch (err) { b.disabled = false; toast((err && err.message) || 'تعذر الإلغاء'); }
        }));
    }

    async function refreshUnable() {
        try {
            const d = await api('/api/my/unable-attend').catch(() => ({ __error: true }));
            const tmp = document.createElement('div');
            tmp.innerHTML = renderUnable(d);
            const old = document.getElementById('unableCard');
            if (old) old.replaceWith(tmp.firstElementChild);
            bindUnableEvents();
        } catch (_) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    // ── v5.1: التحديث اللحظي — SSE الموجَّه القائم (OV-S6: لا قناة جديدة تُنشأ). ──
    // Initial Load يبقى REST دائمًا؛ هذه طبقة تسريع فقط: عند بث notification_created
    // يظهر 🔔 فورًا ثم يُعاد جلب القسمين من REST (مصدر الحقيقة). انقطاعها لا يُسقط
    // شيئًا — عند فتح الصفحة يجلب REST كل الإشعارات الفائتة (شرط المالك 2026-09-16).
    function connectLive() {
        if (!token || typeof EventSource === 'undefined') return;
        let es = null;
        try { es = new EventSource('/api/sse?token=' + encodeURIComponent(token)); }
        catch (_) { return; }
        es.onmessage = (event) => {
            let data = null;
            try { data = JSON.parse(event.data); } catch (_) { return; }
            if (!data || data.type !== 'notification_created') return;
            toast('🔔 ' + (data.message || 'وصلك إشعار جديد'));
            refreshNotifs();
            refreshChanges();
            // A-4.4 S1: إشعارات الإجازات (اعتماد/رفض/إلغاء) ← تحديث «إجازاتي» فورًا بلا Refresh.
            // العنوان والنص الحقيقيان داخل data.notification — المستوى الأعلى رسالة عامة (عقد A-1).
            const n = data.notification || {};
            if (/إجاز/.test(String(n.title || '') + ' ' + String(n.message || ''))) refreshLeave();
            // F-2: إشعارات طلبات المناوبة (اعتماد/رفض/تطبيق) ← تحديث البطاقة فورًا بلا Refresh
            if (/مناوبة/.test(String(n.title || '') + ' ' + String(n.message || ''))) refreshShiftChange();
            // FSS E-3: إشعارات عدم التمكّن (اعتماد/رفض المراجعة) ← تحديث البطاقة فورًا بلا Refresh
            if (/تمكّن/.test(String(n.title || '') + ' ' + String(n.message || ''))) refreshUnable();
        };
        // رفض خادمي (401/403 ⇒ CLOSED): إيقاف نهائي بلا عاصفة إعادة اتصال — نفس
        // سياسة websocket-sync. الأخطاء العابرة يعيد المتصفح الاتصال بها تلقائيًا.
        es.onerror = () => {
            if (es.readyState === EventSource.CLOSED) { try { es.close(); } catch (_) { } es = null; }
        };
    }

    // ── v5: سجل تغييرات جدولي — كل رقم قابل للتتبع (العملية/الفاعل/المراجعة) ──
    function renderChanges(d) {
        const rows = (d.changes || []).map(c => {
            const what = c.changeType === 'add' ? `أُضيفت مناوبة «${esc(c.newShiftCode || '')}»`
                : c.changeType === 'delete' ? `أُلغيت مناوبة «${esc(c.oldShiftCode || '')}»`
                : `«${esc(c.oldShiftCode || '—')}» ← «${esc(c.newShiftCode || '—')}»`;
            const team = c.oldTeam !== c.newTeam ? `<br><small>${esc(c.oldTeam || 'بدون فرقة')} ← ${esc(c.newTeam || 'بدون فرقة')}</small>` : '';
            const src = [c.revisionSource, c.revisionActor].filter(Boolean).map(esc).join(' · ') || '—';
            return `<tr><td>${fmtDateShort(c.date)}<br><small>${arDay(c.date)}</small></td><td>${c.changeLabel}: ${what}${team}</td><td><small>${src}</small></td></tr>`;
        }).join('');
        return `<div class="card" id="changesCard"><div class="card-head changes">📅 سجل تغييرات جدولي</div>
            <div class="card-body">
                ${rows ? `<table><thead><tr><th>اليوم</th><th>التغيير</th><th>العملية</th></tr></thead><tbody>${rows}</tbody></table>`
                    : '<div class="empty">لا توجد تغييرات مسجلة على جدولك.</div>'}
            </div>
        </div>`;
    }

    // ── التحميل ──
    let curMonth = null, curYear = null;
    async function load() {
        if (!token) { stateCard('مطلوب تسجيل الدخول', 'سجّل دخولك من الصفحة الرئيسية ثم عد إلى هذه الصفحة.', true); return; }
        try {
            // رابط «المنصة الرئيسية»: يظهر فقط لمن يملك صلاحية منصة فعلية (v2)
            try {
                const me = await api('/api/auth/me/permissions');
                const eff = me.permissions || [];
                const hasPlatform = !!me.permissions_star || eff.some(k => k !== 'ops.my_portal' && k !== 'ops.execute');
                if (hasPlatform) document.getElementById('homeLink').style.display = '';
            } catch (_) { /* فشل الجلب ← يبقى الرابط مخفيًا */ }

            // خريطة الأقسام من الخادم — لا بطاقات فارغة (قرار ⑧)
            const [sectionsRes, profile, assignments] = await Promise.all([
                api('/api/my/sections'), api('/api/my/profile'), api('/api/my/assignments')]);
            const sec = sectionsRes.sections || {};
            document.getElementById('whoLine').textContent = profile.employee.name + ' — ' + (profile.employee.jobTitle || '');
            if (curMonth === null) {
                const t = riyadhToday();
                curYear = t ? +t.slice(0, 4) : new Date().getFullYear();
                curMonth = t ? +t.slice(5, 7) : new Date().getMonth() + 1;
            }
            const [schedule, incidents, vehicle, inventory, checkData, mates, notifs, changes, leave, shiftChanges, prefs, unable] = await Promise.all([
                api(`/api/my/schedule?month=${curMonth}&year=${curYear}`),
                sec.incidents ? api('/api/my/team-incidents') : Promise.resolve(null),
                sec.vehicle ? api('/api/my/vehicle') : Promise.resolve(null),
                sec.inventory ? api('/api/my/inventory') : Promise.resolve(null),
                sec.check ? api('/api/my/check-session') : Promise.resolve(null),
                // v5: الأقسام الثلاثة الجديدة — فشل أيٍّ منها لا يُسقط بقية الصفحة
                api('/api/my/shift-mates').catch(() => null),
                api('/api/my/notifications').catch(() => null),
                api('/api/my/schedule-changes').catch(() => null),
                // A-4.4 S1: طلبات إجازاتي — فشل الجلب يُظهر حالة داخل البطاقة ولا يُسقط الصفحة
                sec.leave ? api('/api/leave-requests').catch(() => ({ __error: true })) : Promise.resolve(null),
                // F-2: طلبات تغيير المناوبة — نفس نمط الإجازات (فشل الجلب لا يُسقط الصفحة)
                api('/api/my/shift-change-requests').catch(() => ({ __error: true })),
                // FSS E-3: تفضيلاتي + عدم التمكّن — نفس النمط (فشل الجلب لا يُسقط الصفحة)
                api('/api/my/schedule-preferences').catch(() => ({ __error: true })),
                api('/api/my/unable-attend').catch(() => ({ __error: true }))]);
            leaveProfile = profile; // المصدر الوحيد لـ employee.id عند تقديم الطلب
            app.innerHTML = renderProfile(profile)
                + (notifs ? renderNotifs(notifs) : '')
                + (leave ? renderLeave(leave) : '')
                + renderShiftChange(shiftChanges)
                + renderPrefs(prefs)
                + renderUnable(unable)
                + (mates ? renderMates(mates) : '')
                + (checkData ? renderCheck(checkData) : '')
                + (incidents ? renderIncidents(incidents) : '')
                + (vehicle ? renderVehicle(vehicle) : '')
                + (inventory ? renderInventory(inventory, !!sec.inventoryCanOpen) : '')
                + renderSchedule(schedule)
                + (changes ? renderChanges(changes) : '')
                + renderAssignments(assignments);
            if (checkData) bindCheckEvents();
            if (notifs) bindNotifEvents();
            if (leave) bindLeaveEvents();
            bindShiftChangeEvents(); // F-2: بطاقة طلبات المناوبة تُعرض دائمًا للموظف
            bindPrefsEvents();   // FSS E-3: بطاقة التفضيلات (عرض فقط عند إغلاق النافذة)
            bindUnableEvents();  // FSS E-3: بطاقة عدم التمكّن
            connectLive(); // v5.1: القناة اللحظية بعد نجاح التحميل الأول — REST يبقى المصدر
            if (logoutBtn) logoutBtn.style.display = ''; // نجاح التحميل ← الزر يظهر في الشريط العلوي الثابت

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
            const tmp = document.createElement('div');
            tmp.innerHTML = renderSchedule(schedule);
            const old = document.getElementById('schedCard');
            if (old) old.replaceWith(tmp.firstElementChild); // بدل الاعتماد على ترتيب البطاقات (v2)
            document.getElementById('mPrev').addEventListener('click', () => { curMonth--; if (curMonth < 1) { curMonth = 12; curYear--; } refreshSchedule(); });
            document.getElementById('mNext').addEventListener('click', () => { curMonth++; if (curMonth > 12) { curMonth = 1; curYear++; } refreshSchedule(); });
        } catch (e) { /* تبقى البطاقة القديمة — لا انهيار */ }
    }

    load();
})();

// ── v6: طبقة APNs — تُحمَّل فقط داخل تطبيق iOS (Capacitor)؛ في المتصفح لا تفعل شيئًا ──
// اللمسة الوحيدة على هذا الملف: تحميل مشروط لملف مستقل push-register.js —
// لا تغيير على أي منطق أو واجهة قائمة.
(function () {
    try {
        if (!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())) return;
        const s = document.createElement('script');
        s.src = '/js/push-register.js';
        s.defer = true;
        document.head.appendChild(s);
    } catch (_) { /* لا شيء — طبقة اختيارية */ }
})();
