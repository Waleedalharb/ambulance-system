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
            const [schedule, incidents, vehicle, inventory, checkData] = await Promise.all([
                api(`/api/my/schedule?month=${curMonth}&year=${curYear}`),
                sec.incidents ? api('/api/my/team-incidents') : Promise.resolve(null),
                sec.vehicle ? api('/api/my/vehicle') : Promise.resolve(null),
                sec.inventory ? api('/api/my/inventory') : Promise.resolve(null),
                sec.check ? api('/api/my/check-session') : Promise.resolve(null)]);
            app.innerHTML = renderProfile(profile)
                + (checkData ? renderCheck(checkData) : '')
                + (incidents ? renderIncidents(incidents) : '')
                + (vehicle ? renderVehicle(vehicle) : '')
                + (inventory ? renderInventory(inventory, !!sec.inventoryCanOpen) : '')
                + renderSchedule(schedule)
                + renderAssignments(assignments);
            if (checkData) bindCheckEvents();
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
