/**
 * ═══ IncidentLookup — مكوّن البحث عن بلاغ (L-1) ═══
 * اعتماد المالك 2026-09-01 — مواصفة FORMS-LOOKUP-L1-SPEC.md.
 *
 * مكوّن واحد معزول يخدم لاحقًا كل النماذج المرتبطة ببلاغ. في L-1 لا يُربط
 * بأي نموذج ولا يُحمَّل في index.html — يُختبر بتركيب معزول فقط.
 *
 * مبادئ محسومة:
 *  - بيانات CAD تُعرض نصوصًا read-only ببنية DOM (ليست حقول إدخال أصلًا).
 *  - الأزمنة تُقرأ من رد الخادم كما حُسبت مركزيًا — صفر حساب هنا.
 *  - النقص يُعرض صراحةً: «غير متاح — بيانات CAD ناقصة» ولا يظهر صفر إطلاقًا.
 *  - تكرار الرقم عبر المناوبات يُعرض بشارة، والأحدث هو الافتراضي.
 *
 * API عام واحد:
 *   IncidentLookup.mount(el, { onResolved(payload) }) → instance
 *   instance.reset()
 */
(function () {
    'use strict';

    var NUMBER_RE = /^\d{4,12}$/; // نفس CAD_NUMBER_RE القائم في الخادم

    function h(tag, cls, text) {
        var el = document.createElement(tag);
        if (cls) el.className = cls;
        if (text !== undefined && text !== null) el.textContent = text;
        return el;
    }
    function fmtMin(v) {
        if (v === null || v === undefined) return null;
        return (Math.round(v * 10) / 10) + ' دقيقة';
    }
    // وقت CAD الخام (وقت-فقط أو تاريخ+وقت 12 ساعة) يُعرض كما ورد — هو جداري الرياض أصلًا
    function fmtCadRaw(v) { return v || null; }

    function mount(root, opts) {
        opts = opts || {};
        root.classList.add('il-root');
        root.innerHTML = '';

        // ── صف البحث ──
        var searchRow = h('div', 'il-search-row');
        var input = h('input', 'il-input');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.placeholder = 'رقم البلاغ…';
        input.setAttribute('autocomplete', 'off');
        var btn = h('button', 'il-btn', '🔍 بحث');
        btn.type = 'button';
        searchRow.appendChild(input);
        searchRow.appendChild(btn);
        root.appendChild(searchRow);

        var status = h('div', 'il-status');
        status.style.display = 'none';
        root.appendChild(status);
        var card = h('div', 'il-card');
        card.style.display = 'none';
        root.appendChild(card);

        var inflight = null; // AbortController
        var lastPayload = null;

        function setStatus(kind, text) {
            status.style.display = '';
            status.className = 'il-status il-status-' + kind;
            status.textContent = text;
            card.style.display = 'none';
        }
        function hideStatus() { status.style.display = 'none'; }

        function row(label, value, opts2) {
            opts2 = opts2 || {};
            var r = h('div', 'il-row' + (opts2.accent ? ' il-row-accent' : ''));
            r.appendChild(h('span', 'il-label', label));
            var v = h('span', 'il-value' + (opts2.missing ? ' il-missing' : ''), value);
            if (opts2.title) v.title = opts2.title;
            r.appendChild(v);
            return r;
        }

        function render(payload) {
            hideStatus();
            card.innerHTML = '';
            card.style.display = '';
            var inc = payload.incident || {};
            var tc = payload.timeCompleteness || { state: 'missing', missing: [] };

            // شارة الحالة
            var head = h('div', 'il-head');
            if (tc.state === 'complete') head.appendChild(h('span', 'il-badge il-badge-ok', '✓ تم العثور على البلاغ'));
            else head.appendChild(h('span', 'il-badge il-badge-warn', '⚠️ البلاغ موجود، لكن بياناته الزمنية غير مكتملة'));
            head.appendChild(h('span', 'il-head-num', '#' + payload.number));
            card.appendChild(head);

            // شارة تعدد المناوبات
            if (payload.otherShifts && payload.otherShifts.length > 0) {
                var s0 = payload.otherShifts[0];
                var when = s0.createdAt ? String(s0.createdAt).slice(0, 10) : 'سابقة';
                card.appendChild(h('div', 'il-dup', 'ℹ️ هذا الرقم ظهر أيضًا في مناوبة ' + when +
                    (payload.otherShifts.length > 1 ? ' (+' + (payload.otherShifts.length - 1) + ')' : '') +
                    ' — المعروض أحدث ظهور'));
            }

            // بيانات CAD — نصوص read-only ببنية DOM
            var grid = h('div', 'il-grid');
            grid.appendChild(row('رقم البلاغ', inc.number || payload.number));
            var cadTxt = fmtCadRaw(inc.cadCreatedAtRaw);
            grid.appendChild(row('وقت البلاغ (CAD)', cadTxt || 'غير متوفر — بيانات CAD ناقصة',
                { missing: !cadTxt, title: cadTxt ? 'الخام كما ورد من CAD' : '' }));
            var loc = [inc.address, inc.district, inc.street].filter(Boolean).join(' — ');
            grid.appendChild(row('الموقع', loc || 'غير متوفر', { missing: !loc }));
            if (inc.code) grid.appendChild(row('الترميز', inc.code));
            if (inc.description) grid.appendChild(row('وصف CAD', inc.description));
            card.appendChild(grid);

            // الفرق والأزمنة
            var unitsBox = h('div', 'il-units');
            if (!payload.units || payload.units.length === 0) {
                unitsBox.appendChild(h('div', 'il-unit-empty', 'لا مشاركات فرق مسجلة لهذا البلاغ'));
            }
            (payload.units || []).forEach(function (u) {
                var ue = h('div', 'il-unit' + (u.counted ? '' : ' il-unit-excluded'));
                var ut = h('div', 'il-unit-title', u.unit || 'فرقة');
                if (u.flags && u.flags.manualCancelled) {
                    var tag = h('span', 'il-flag', 'ملغاة يدويًا' + (u.flags.manualCancelReason ? ': ' + u.flags.manualCancelReason : ''));
                    ut.appendChild(tag);
                } else if (u.flags && u.flags.withdrawn) {
                    ut.appendChild(h('span', 'il-flag', 'مسحوبة'));
                }
                ue.appendChild(ut);
                var arr = fmtMin(u.respArrivalMin);
                ue.appendChild(row('زمن الاستجابة', arr || 'غير متاح — بيانات CAD ناقصة', { missing: !arr, accent: !!arr }));
                var mub = fmtMin(u.respMubasharaMin);
                ue.appendChild(row('زمن المباشرة', mub || 'غير متاح', { missing: !mub }));
                if (u.phases) {
                    var order = ['قبول', 'التحرك', 'البحث', 'العلاج', 'النقل', 'الجاهزية', 'بدء التسليم', 'انتهاء التسليم'];
                    var ph = h('div', 'il-phases');
                    order.forEach(function (k) {
                        if (u.phases[k]) ph.appendChild(h('span', 'il-phase', k + ' ' + u.phases[k]));
                    });
                    if (ph.childNodes.length) ue.appendChild(ph);
                }
                unitsBox.appendChild(ue);
            });
            card.appendChild(unitsBox);

            // الأسرع (فوق المحتسبة فقط — الخادم حسم ذلك)
            var best = fmtMin(payload.bestArrivalMin);
            var bestEl = h('div', 'il-best', best ? ('⏱ أسرع استجابة: ' + best) : '⏱ زمن الاستجابة غير متاح — بيانات CAD ناقصة');
            if (!best) bestEl.classList.add('il-missing');
            card.appendChild(bestEl);
        }

        async function search() {
            var number = (input.value || '').trim();
            if (!number) { setStatus('err', 'أدخل رقم البلاغ'); return; }
            if (!NUMBER_RE.test(number)) { setStatus('err', 'صيغة رقم بلاغ غير صالحة — أرقام فقط'); return; }
            if (inflight) inflight.abort();
            inflight = new AbortController();
            btn.disabled = true; input.disabled = true;
            setStatus('busy', 'جارٍ البحث…');
            try {
                var token = localStorage.getItem('auth_access_token') || '';
                var res = await fetch('/api/incidents/lookup?number=' + encodeURIComponent(number), {
                    headers: token ? { 'Authorization': 'Bearer ' + token } : {},
                    signal: inflight.signal
                });
                if (res.status === 404) { lastPayload = null; setStatus('err', '✗ لا يوجد بلاغ بهذا الرقم'); return; }
                if (!res.ok) { lastPayload = null; setStatus('err', '✗ تعذر البحث — تحقق من الاتصال'); return; }
                var payload = await res.json();
                lastPayload = payload;
                render(payload);
                if (typeof opts.onResolved === 'function') { try { opts.onResolved(payload); } catch (_) { } }
            } catch (e) {
                if (e && e.name === 'AbortError') return;
                lastPayload = null;
                setStatus('err', '✗ تعذر البحث — تحقق من الاتصال');
            } finally {
                btn.disabled = false; input.disabled = false;
            }
        }

        btn.addEventListener('click', search);
        input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') search(); });

        return {
            reset: function () {
                if (inflight) inflight.abort();
                input.value = ''; lastPayload = null;
                status.style.display = 'none'; card.style.display = 'none'; card.innerHTML = '';
            },
            getLastPayload: function () { return lastPayload; }
        };
    }

    window.IncidentLookup = { mount: mount };
})();
