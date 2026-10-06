/**
 * ═══ unable-attend-admin.js — صفحة مراجعة طلبات عدم التمكّن (FSS E-3/ج4) ═══
 *
 * نفس وصفة shift-change-admin (F-2) حرفيًا:
 * البوابة Fail-Closed: تُجلب /api/auth/me أولًا؛ بلا schedule.requests.review
 * ولا star ⇒ بطاقة «غير مصرّح» ولا يُستدعى أي endpoint. إخفاء الرابط في
 * الشريط الجانبي ردع بصري فقط — الخادم هو الحارس (authorizePerm).
 *
 * العقد (قائم من E-2 — لا API جديد هنا):
 *   GET  /api/schedule/unable-attend[?status=]    قائمة مُثراة (employee_name/code/job_title/team_name)
 *   POST /api/schedule/unable-attend/:id/review   {decision:'approve'|'reject', note?} → {success, status}
 *
 * قواعد عرض ملزمة (قرارات المالك):
 *   - M1/M2: pending_review = تصعيد (استثناء حد الأيام أو تعارض تغطية محتمل)
 *     وليس رفضًا مسبقًا — القرار للمسؤول.
 *   - د3: ملاحظة المراجعة اختيارية عند الاعتماد والرفض.
 *   - الطلب المعالَج = عرض حالة فقط، بلا أدوات قرار؛ 409 ⇒ رسالة السيرفر وإعادة جلب.
 *   - لا employee_id يُدخَل أو يُختار من هذه الواجهة إطلاقًا.
 *
 * SSE: EventSource واحد على /api/sse — حدث notification_created الخاص بعدم
 *   التمكّن ⇒ إعادة جلب. رفض خادمي (CLOSED) = إيقاف نهائي بلا عاصفة إعادة اتصال.
 */
(function () {
    'use strict';

    var state = { allowed: false, requests: [], detailId: null, es: null };
    var STATUS_LABEL = {
        pending_review: 'قيد المراجعة',
        auto_approved: 'مقبول تلقائيًا',
        approved: 'معتمد',
        rejected: 'مرفوض',
        cancelled: 'ملغي'
    };

    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function fmtTs(ts) { return ts ? String(ts).slice(0, 16) : '—'; }

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
            if (!star && perms.indexOf('schedule.requests.review') === -1) {
                gateDenied('غير مصرّح', 'هذه الشاشة تتطلب صلاحية «مراجعة طلبات الجدولة» (schedule.requests.review). اطلب المنحة من مدير النظام.');
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
                var hay = String(r.employee_name || '') + ' ' + String(r.employee_code || '') + ' ' + String(r.team_name || '');
                if (hay.indexOf(q) === -1) return false;
            }
            if (from && r.off_date < from) return false;
            if (to && r.off_date > to) return false;
            return true;
        });
    }

    function renderRows() {
        var rows = applyClientFilters(state.requests);
        var body = $('rowsBody');
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="7" class="loading">لا توجد طلبات مطابقة.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(function (r) {
            return '<tr>' +
                '<td class="name">' + esc(r.employee_name || ('موظف #' + r.employee_id)) +
                    '<span class="code">' + esc(r.employee_code || '') + (r.job_title ? ' · ' + esc(r.job_title) : '') + '</span></td>' +
                '<td>' + esc(r.team_name || '—') + '</td>' +
                '<td>' + esc(r.off_date) + (r.is_exception ? '<span class="exc-badge" title="تجاوز حد الأيام الشهري (M1)">استثناء</span>' : '') + '</td>' +
                '<td>' + (r.reason ? esc(String(r.reason).slice(0, 40)) : '<span style="color:var(--muted)">—</span>') + '</td>' +
                '<td>' + statusChip(r) + '</td>' +
                '<td>' + fmtTs(r.created_at) + '</td>' +
                '<td><button class="detail-toggle" data-detail="' + r.id + '">التفاصيل</button></td>' +
            '</tr>';
        }).join('');
        $('metaLine').textContent = 'إجمالي المعروض: ' + rows.length + ' من ' + state.requests.length + ' طلبًا';
    }

    function loadRequests() {
        var st = $('statusFilter').value;
        return api('/api/schedule/unable-attend' + (st ? '?status=' + encodeURIComponent(st) : '')).then(function (r) {
            if (!r.ok || !r.data) {
                $('rowsBody').innerHTML = '<tr><td colspan="7" class="error-box">تعذر جلب الطلبات — ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</td></tr>';
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
        var pending = r.status === 'pending_review';
        $('detailBody').innerHTML =
            '<div class="kv-grid">' +
                '<div class="kv"><div class="k">الموظف</div><div class="v">' + esc(r.employee_name || ('#' + r.employee_id)) + '</div></div>' +
                '<div class="kv"><div class="k">الرقم الوظيفي</div><div class="v">' + esc(r.employee_code || '—') + '</div></div>' +
                '<div class="kv"><div class="k">المسمى</div><div class="v">' + esc(r.job_title || '—') + '</div></div>' +
                '<div class="kv"><div class="k">الفريق</div><div class="v">' + esc(r.team_name || '—') + '</div></div>' +
                '<div class="kv"><div class="k">يوم عدم التمكّن</div><div class="v">' + esc(r.off_date) + '</div></div>' +
                '<div class="kv"><div class="k">الحالة</div><div class="v">' + esc(STATUS_LABEL[r.status] || r.status) + '</div></div>' +
                '<div class="kv"><div class="k">استثناء حد الأيام (M1)</div><div class="v">' + (r.is_exception ? 'نعم — تجاوز الحد الشهري' : 'لا') + '</div></div>' +
                '<div class="kv"><div class="k">تاريخ الطلب</div><div class="v">' + fmtTs(r.created_at) + '</div></div>' +
                (r.reviewed_at ? '<div class="kv"><div class="k">تاريخ المراجعة</div><div class="v">' + fmtTs(r.reviewed_at) + '</div></div>' : '') +
            '</div>' +
            (r.reason ? '<div class="kv" style="margin-bottom:12px"><div class="k">سبب الموظف</div><div class="v">' + esc(r.reason) + '</div></div>' : '') +
            (r.review_note ? '<div class="kv" style="margin-bottom:12px"><div class="k">ملاحظة المراجعة</div><div class="v">' + esc(r.review_note) + '</div></div>' : '') +
            (pending && r.is_exception ? '<div class="warn-box">⚠️ هذا الطلب استثناء: تجاوز الموظف حد الأيام الشهري (M1) — يحتاج قرارك الصريح.</div>' : '') +
            (pending && !r.is_exception ? '<div class="warn-box">⚠️ صُعّد هذا الطلب لاحتمال تعارضه مع التغطية الدنيا (M2) — التصعيد ليس رفضًا مسبقًا؛ القرار لك.</div>' : '') +
            (pending ?
                '<div class="kv"><div class="k">ملاحظة المراجعة (اختيارية — د3)</div>' +
                    '<textarea class="note-input" id="uaNote" maxlength="300" placeholder="سبب القرار أو توضيح للموظف…"></textarea></div>' +
                '<div class="decision-bar">' +
                    '<button class="btn approve" id="uaApprove">اعتماد الطلب</button>' +
                    '<button class="btn deny" id="uaReject">رفض الطلب</button>' +
                    '<button class="btn secondary" id="uaClose">إغلاق</button>' +
                '</div>'
            : '<div class="decision-bar"><button class="btn secondary" id="uaClose">إغلاق</button></div>');
        $('detailModal').classList.add('open');
        $('uaClose').addEventListener('click', closeDetail);
        if (pending) {
            $('uaApprove').addEventListener('click', function () { decide('approve'); });
            $('uaReject').addEventListener('click', function () { decide('reject'); });
        }
    }
    function closeDetail() { $('detailModal').classList.remove('open'); state.detailId = null; }

    function decide(decision) {
        var id = state.detailId;
        if (!id) return;
        var noteEl = $('uaNote');
        var note = noteEl ? noteEl.value.trim() : '';
        if (decision === 'approve' && !confirm('اعتماد طلب عدم التمكّن هذا؟')) return;
        var btns = $('detailBody').querySelectorAll('.btn');
        btns.forEach(function (b) { b.disabled = true; });
        api('/api/schedule/unable-attend/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision: decision, note: note || undefined }) }).then(function (r) {
            if (r.ok && r.data && r.data.success) {
                toast(decision === 'approve' ? '✅ تم اعتماد الطلب وأُشعر الموظف' : 'تم رفض الطلب وأُشعر الموظف', 'success');
                closeDetail();
                loadRequests();
            } else {
                // 409: معالَج/مُلغى مسبقًا — رسالة السيرفر هي الحاكمة
                toast((r.data && r.data.error) || ('تعذر تنفيذ القرار — HTTP ' + r.status), 'error');
                btns.forEach(function (b) { b.disabled = false; });
                loadRequests(); // الأولوية لحالة السيرفر
            }
        }).catch(function () {
            toast('خطأ اتصال — لم يُنفَّذ أي قرار', 'error');
            btns.forEach(function (b) { b.disabled = false; });
        });
    }

    // ═══ SSE — تحديث لحظي عند تصعيد طلب جديد (إشعارات E-2 عبر عقد A-1) ═══
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
            if (data && data.type === 'notification_created') {
                var n = data.notification || {};
                var hay = String(n.title || '') + ' ' + String(n.message || '');
                if (/تمكّن/.test(hay)) {
                    toast('تحديث في طلبات عدم التمكّن — تُعاد القراءة', 'warn');
                    loadRequests();
                }
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
