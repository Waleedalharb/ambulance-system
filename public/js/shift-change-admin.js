/**
 * ═══ shift-change-admin.js — صفحة مراجعة طلبات تغيير المناوبة (F-2) ═══
 *
 * البوابة (نفس نمط A-4.4 S2): الصفحة كاملة خلف requests.review أو star —
 * تُجلب /api/auth/me أولًا؛ بلا الصلاحية ⇒ بطاقة «غير مصرّح» ولا يُستدعى
 * أي endpoint (Fail-Closed). إخفاء الزر في الشريط الجانبي ردع بصري فقط.
 *
 * العقد (قائم من F-1 — لا API جديد هنا):
 *   GET  /api/shift-change-request[?status=]    قائمة مُثراة (employee_name + current_shift_code — F-2)
 *   POST /api/shift-change-request/:id/review   {status:'approved'|'denied'} → {success, applied?}
 *
 * قواعد عرض ملزمة:
 *   - «الفعلية الآن» = current_shift_code الحي من shift_roster (مصدره السيرفر) —
 *     المرجع الحقيقي للقرار؛ «المناوبة عند التقديم» لقطة تاريخية للاطلاع.
 *   - الاعتماد يطبّق فعليًا على يوم الطلب فقط (F-1) — عند النجاح يُعرض أثر
 *     applied من الاستجابة؛ 409 (معالَج/رمز/موظف) ⇒ عرض رسالة السيرفر وإعادة جلب.
 *   - الرفض بلا سبب إلزامي (د3 — قرار المالك).
 *   - الطلب المعالَج = عرض حالة فقط، بلا أدوات قرار.
 *   - لا employee_id يُدخَل أو يُختار من هذه الواجهة إطلاقًا.
 *
 * SSE: EventSource واحد على /api/sse — حدث shift_change_request ⇒ إعادة جلب.
 *   رفض خادمي (CLOSED) = إيقاف نهائي بلا عاصفة إعادة اتصال.
 */
(function () {
    'use strict';

    var state = { allowed: false, requests: [], detailId: null, es: null };
    var STATUS_LABEL = { pending: 'قيد المراجعة', approved: 'معتمدة', denied: 'مرفوضة', cancelled: 'ملغاة' };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function fmtTs(ts) { return ts ? String(ts).slice(0, 16) : '—'; }
    function codeView(c) { return c ? esc(c) : '<span style="color:var(--muted)">—</span>'; }

    function toast(msg, kind) {
        var box = $('toastBox');
        var el = document.createElement('div');
        el.className = 'toast ' + (kind || '');
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(function () { try { box.removeChild(el); } catch (_) { } }, 5200);
    }

    function api(url, options) {
        options = options || {};
        options.headers = AuthCore.authHeaders(Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}));
        return AuthCore.apiRequest(url, options).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
                return { status: res.status, ok: res.ok, data: data };
            });
        });
    }

    // ═══ البوابة — Fail-Closed ═══
    function gateDenied(title, msg) {
        $('gateBox').innerHTML =
            '<div class="state-card denied"><i class="fas fa-lock"></i><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p></div>';
        $('appBox').style.display = 'none';
        $('filtersBar').style.display = 'none';
    }

    function checkAccess() {
        $('gateBox').innerHTML = '<div class="state-card"><i class="fas fa-spinner fa-spin"></i><h2>جاري التحقق من الصلاحية…</h2></div>';
        return api('/api/auth/me').then(function (r) {
            if (!r.ok || !r.data || !r.data.user) {
                gateDenied('تعذر تحديد الصلاحية', 'فشل جلب هوية الحساب أو صلاحياته — أعد تحميل الصفحة أو سجّل الدخول من جديد.');
                return false;
            }
            var me = r.data;
            var perms = Array.isArray(me.permissions) ? me.permissions : [];
            var star = me.permissions_star === true;
            if (!star && perms.indexOf('requests.review') === -1) {
                gateDenied('غير مصرّح', 'هذه الشاشة تتطلب صلاحية «مراجعة الطلبات» (requests.review). اطلب المنحة من مدير النظام.');
                return false;
            }
            state.allowed = true;
            $('gateBox').innerHTML = '';
            $('appBox').style.display = '';
            $('filtersBar').style.display = '';
            return true;
        }).catch(function () {
            gateDenied('تعذر تحديد الصلاحية', 'خطأ اتصال أثناء التحقق — لن تُعرض أي بيانات (Fail-Closed).');
            return false;
        });
    }

    // ═══ القائمة ═══
    function statusChip(r) {
        return '<span class="chip ' + esc(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>';
    }

    function applyClientFilters(rows) {
        var q = ($('searchInput').value || '').trim();
        var from = $('dateFrom').value || '';
        var to = $('dateTo').value || '';
        return rows.filter(function (r) {
            if (q) {
                var hay = String(r.employee_name || '') + ' ' + String(r.requested_by_name || '') + ' ' +
                    String(r.proposed_shift_code || '') + ' ' + String(r.old_shift_code || '');
                if (hay.indexOf(q) === -1) return false;
            }
            if (from && r.shift_date < from) return false;
            if (to && r.shift_date > to) return false;
            return true;
        });
    }

    function renderRows() {
        var rows = applyClientFilters(state.requests);
        var body = $('rowsBody');
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="8" class="loading">لا توجد طلبات مطابقة.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(function (r) {
            // تنبيه: الفعلية الحالية تغيّرت عن لقطة التقديم — القرار على الواقع
            var drift = r.status === 'pending' && r.current_shift_code !== r.old_shift_code;
            return '<tr>' +
                '<td class="name">' + esc(r.employee_name || ('موظف #' + r.employee_id)) +
                    '<span class="code">' + esc(r.requested_by_name || '') + '</span></td>' +
                '<td>' + esc(r.shift_date) + '</td>' +
                '<td>' + codeView(r.old_shift_code) + '</td>' +
                '<td><b>' + codeView(r.proposed_shift_code) + '</b></td>' +
                '<td>' + codeView(r.current_shift_code) + (drift ? ' <span style="color:var(--gold-id)" title="تغيّرت عن وقت التقديم">⚠</span>' : '') + '</td>' +
                '<td>' + statusChip(r) + '</td>' +
                '<td>' + fmtTs(r.created_at) + '</td>' +
                '<td><button class="detail-toggle" data-detail="' + r.id + '">التفاصيل</button></td>' +
            '</tr>';
        }).join('');
        $('metaLine').textContent = 'إجمالي المعروض: ' + rows.length + ' من ' + state.requests.length + ' طلبًا';
    }

    function loadRequests() {
        var st = $('statusFilter').value;
        return api('/api/shift-change-request' + (st ? '?status=' + encodeURIComponent(st) : '')).then(function (r) {
            if (!r.ok || !r.data) {
                $('rowsBody').innerHTML = '<tr><td colspan="8" class="error-box">تعذر جلب الطلبات — ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</td></tr>';
                return;
            }
            state.requests = r.data.requests || [];
            renderRows();
        });
    }

    // ═══ نافذة التفاصيل + القرار ═══
    function openDetail(id) {
        var r = state.requests.find(function (x) { return Number(x.id) === Number(id); });
        if (!r) return;
        state.detailId = r.id;
        var drift = r.current_shift_code !== r.old_shift_code;
        var pending = r.status === 'pending';
        $('detailBody').innerHTML =
            '<div class="kv-grid">' +
                '<div class="kv"><div class="k">الموظف</div><div class="v">' + esc(r.employee_name || ('#' + r.employee_id)) + '</div></div>' +
                '<div class="kv"><div class="k">يوم المناوبة</div><div class="v">' + esc(r.shift_date) + '</div></div>' +
                '<div class="kv"><div class="k">المناوبة عند التقديم (لقطة)</div><div class="v">' + (r.old_shift_code ? esc(r.old_shift_code) : '—') + '</div></div>' +
                '<div class="kv"><div class="k">المقترحة</div><div class="v">' + esc(r.proposed_shift_code) + '</div></div>' +
                '<div class="kv"><div class="k">الفعلية الآن (الجدول الحي)</div><div class="v">' + (r.current_shift_code ? esc(r.current_shift_code) : '—') + '</div></div>' +
                '<div class="kv"><div class="k">الحالة</div><div class="v">' + esc(STATUS_LABEL[r.status] || r.status) + '</div></div>' +
                '<div class="kv"><div class="k">قدّمها</div><div class="v">' + esc(r.requested_by_name || r.requested_by || '—') + '</div></div>' +
                '<div class="kv"><div class="k">تاريخ الطلب</div><div class="v">' + fmtTs(r.created_at) + '</div></div>' +
                (r.reviewed_by ? '<div class="kv"><div class="k">راجعها</div><div class="v">' + esc(r.reviewed_by) + ' · ' + fmtTs(r.reviewed_at) + '</div></div>' : '') +
            '</div>' +
            (r.reason ? '<div class="kv" style="margin-bottom:12px"><div class="k">سبب الموظف</div><div class="v">' + esc(r.reason) + '</div></div>' : '') +
            (pending && drift ? '<div class="warn-box">⚠️ المناوبة الفعلية لهذا اليوم تغيّرت منذ التقديم («' + esc(r.old_shift_code || '—') + '» ← «' + esc(r.current_shift_code || '—') + '»). الاعتماد سيستبدل <b>القيمة الفعلية الحالية</b> بالرمز المقترح، وسيُدقَّق القديم الفعلي لا لقطة التقديم.</div>' : '') +
            (pending ? '<div class="warn-box" style="margin-top:8px">الاعتماد يطبّق «' + esc(r.proposed_shift_code) + '» على يوم ' + esc(r.shift_date) + ' فقط — لا يمتد لأيام أخرى، والتطبيق ذرّي ومُدقَّق (F-1).</div>' : '') +
            (pending ?
                '<div class="decision-bar">' +
                    '<button class="btn approve" id="scApprove">اعتماد وتطبيق على الجدول</button>' +
                    '<button class="btn deny" id="scDeny">رفض</button>' +
                    '<button class="btn secondary" id="scClose">إغلاق</button>' +
                '</div>'
            : '<div class="decision-bar"><button class="btn secondary" id="scClose">إغلاق</button></div>');
        $('detailModal').classList.add('open');
        $('scClose').addEventListener('click', closeDetail);
        if (pending) {
            $('scApprove').addEventListener('click', function () { decide('approved'); });
            $('scDeny').addEventListener('click', function () { decide('denied'); });
        }
    }
    function closeDetail() { $('detailModal').classList.remove('open'); state.detailId = null; }

    function decide(status) {
        var id = state.detailId;
        if (!id) return;
        if (status === 'approved' && !confirm('اعتماد الطلب وتطبيق الرمز المقترح على يوم المناوبة فورًا؟')) return;
        var btns = $('detailBody').querySelectorAll('.btn');
        btns.forEach(function (b) { b.disabled = true; });
        api('/api/shift-change-request/' + id + '/review', { method: 'POST', body: JSON.stringify({ status: status }) }).then(function (r) {
            if (r.ok && r.data && r.data.success) {
                if (status === 'approved' && r.data.applied) {
                    var a = r.data.applied;
                    toast('✅ تم الاعتماد والتطبيق: ' + a.shift_date + ' ← «' + a.shift_code + '» (' + (a.change_type === 'add' ? 'سطر جديد' : 'تحديث') + ')', 'success');
                } else {
                    toast(status === 'approved' ? 'تم الاعتماد' : 'تم الرفض', 'success');
                }
                closeDetail();
                loadRequests();
            } else {
                // 409: معالَج مسبقًا / رمز لم يعد صالحًا / موظف غير نشط — رسالة السيرفر هي الحاكمة
                toast((r.data && r.data.error) || ('تعذر تنفيذ القرار — HTTP ' + r.status), 'error');
                btns.forEach(function (b) { b.disabled = false; });
                loadRequests(); // الأولوية لحالة السيرفر
            }
        }).catch(function () {
            toast('خطأ اتصال — لم يُنفَّذ أي قرار', 'error');
            btns.forEach(function (b) { b.disabled = false; });
        });
    }

    // ═══ SSE — تحديث لحظي عند أي طلب/قرار ═══
    function connectLive() {
        if (typeof EventSource === 'undefined') return;
        var token = AuthCore.getToken && AuthCore.getToken();
        if (!token) return;
        var es;
        try { es = new EventSource('/api/sse?token=' + encodeURIComponent(token)); } catch (_) { return; }
        state.es = es;
        es.onmessage = function (event) {
            var data = null;
            try { data = JSON.parse(event.data); } catch (_) { return; }
            if (data && data.type === 'shift_change_request') {
                toast('تحديث في طلبات المناوبة — تُعاد القراءة', 'warn');
                loadRequests();
            }
        };
        es.onerror = function () {
            if (es.readyState === EventSource.CLOSED) { try { es.close(); } catch (_) { } state.es = null; }
        };
    }

    // ═══ الإقلاع ═══
    document.addEventListener('DOMContentLoaded', function () {
        checkAccess().then(function (ok) {
            if (!ok) return;
            loadRequests();
            connectLive();
        });
        $('statusFilter').addEventListener('change', loadRequests);
        $('searchInput').addEventListener('input', renderRows);
        $('dateFrom').addEventListener('change', renderRows);
        $('dateTo').addEventListener('change', renderRows);
        $('refreshBtn').addEventListener('click', loadRequests);
        $('detailClose').addEventListener('click', closeDetail);
        $('detailModal').addEventListener('click', function (e) { if (e.target === $('detailModal')) closeDetail(); });
        $('rowsBody').addEventListener('click', function (e) {
            var b = e.target.closest('[data-detail]');
            if (b) openDetail(b.getAttribute('data-detail'));
        });
    });
})();
