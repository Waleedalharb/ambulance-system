/**
 * ═══ leave-admin.js — صفحة مراجعة الإجازات للمخوَّلين (A-4.4 S2) ═══
 *
 * البوابة (D-S2-1 — اعتماد المالك): الصفحة كاملة خلف leave.review أو star.
 *   - تُجلب /api/auth/me أولًا؛ بلا star ولا leave.review ⇒ بطاقة «غير مصرّح»
 *     ولا يُستدعى أي endpoint للإجازات إطلاقًا (Fail-Closed — فشل تحديد
 *     الصلاحية = رفض). إخفاء الزر في الشريط الجانبي ردع بصري فقط وليس حسمًا.
 *
 * العقد (A-4.3 — ثابت، لا يُضاف ولا يُعدَّل أي API):
 *   GET    /api/leave-requests[?status=]          قائمة (نطاقها سيرفي — M3)
 *   POST   /api/leave-requests/:id/approve        {status:'approved'|'denied', denial_reason?} → {success, conflicts[]}
 *   DELETE /api/leave-requests/:id                {reason} — إلغاء معتمدة (سبب إلزامي R7)
 *   GET    /api/leave-requests/:id/events         سجل التدقيق الزمني
 *   GET    /api/leave-requests/conflicts          ?employee_id&from&to — قراءة صرفة (R8)
 *
 * قواعد عرض ملزمة:
 *   - تعارض المناوبات WARNING للاطلاع فقط — لا يمنع الاعتماد ولا يوجد أي
 *     إجراء على الجدول المنشور من هذه الصفحة (D7: صفر كتابة فيه).
 *   - الطلب المعالَج (approved/denied/cancelled) = عرض حالة فقط، بلا أدوات قرار.
 *   - LEAVE_PROCESSED / LEAVE_RACE من السيرفر ⇒ عرض رسالته ثم إعادة الجلب —
 *     الأولوية دائمًا لحالة السيرفر.
 *   - pending المنتهي (end_date < اليوم) يُعرض «منتهي — بانتظار المراجعة»
 *     ويبقى pending — لا يُعتبر مرفوضًا ولا ملغى؛ قرار المراجع هو الحاسم.
 *   - لا employee_id يُدخَل أو يُختار من هذه الواجهة إطلاقًا (يأتي ضمن صفوف
 *     القائمة من السيرفر فقط، ويُمرر لمسار conflicts للقراءة).
 *
 * SSE: EventSource واحد فقط على /api/sse (نمط my-ems): أحداث الإجازات
 *   (submitted/updated/resolved/cancelled) + notification_created الخاصة
 *   بالإجازات ⇒ إعادة جلب القائمة. رفض خادمي (CLOSED) = إيقاف نهائي بلا
 *   عاصفة إعادة اتصال؛ الأعطال العابرة يعيدها المتصفح تلقائيًا.
 */
(function () {
    'use strict';

    // ── حالة الصفحة ──────────────────────────────────────────────────────
    var state = {
        allowed: false,
        requests: [],            // آخر جلب من السيرفر (مصدر الحقيقة)
        conflictsCache: {},      // requestId → conflicts[] (جلب كسول لصفوف pending)
        detailId: null,          // الطلب المفتوح في النافذة
        es: null                 // اتصال SSE الوحيد
    };

    var STATUS_LABEL = { pending: 'قيد المراجعة', approved: 'معتمدة', denied: 'مرفوضة', cancelled: 'ملغاة' };

    // ── أدوات صرفة ───────────────────────────────────────────────────────
    function $(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    // تاريخ اليوم المحلي YYYY-MM-DD — لعرض شارة «منتهي» فقط (الحسم سيرفي)
    function todayStr() {
        var d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    // عدد الأيام شاملًا الطرفين — عرض فقط (تعريف R9 سيرفي)
    function dayCount(start, end) {
        var a = new Date(start + 'T00:00:00Z'), b = new Date(end + 'T00:00:00Z');
        return Math.round((b - a) / 86400000) + 1;
    }
    function isExpiredPending(r) { return r.status === 'pending' && r.end_date < todayStr(); }
    function fmtTs(ts) { return ts ? String(ts).slice(0, 16) : '—'; }

    function toast(msg, kind) {
        var box = $('toastBox');
        var el = document.createElement('div');
        el.className = 'toast ' + (kind || '');
        el.textContent = msg;
        box.appendChild(el);
        setTimeout(function () { try { box.removeChild(el); } catch (_) { } }, 5200);
    }

    // ── طبقة النداء — AuthCore (توكن + تجديد 401 واحد) بلا نظام Auth جديد ──
    function api(url, options) {
        options = options || {};
        options.headers = AuthCore.authHeaders(Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}));
        return AuthCore.apiRequest(url, options).then(function (res) {
            return res.json().catch(function () { return null; }).then(function (data) {
                return { status: res.status, ok: res.ok, data: data };
            });
        });
    }

    // ═══ البوابة — Fail-Closed (D-S2-1) ═══
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
            // الحسم: star أو leave.review صراحة — غير ذلك ممنوع حتى لو وصل للصفحة
            if (!star && perms.indexOf('leave.review') === -1) {
                gateDenied('غير مصرّح', 'هذه الشاشة تتطلب صلاحية «مراجعة الإجازات» (leave.review). اطلب المنحة من مدير النظام.');
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
        var base = '<span class="chip ' + esc(r.status) + '">' + esc(STATUS_LABEL[r.status] || r.status) + '</span>';
        if (isExpiredPending(r)) base += ' <span class="chip expired">منتهي — بانتظار المراجعة</span>';
        return base;
    }

    function applyClientFilters(rows) {
        var q = ($('searchInput').value || '').trim();
        var from = $('dateFrom').value || '';
        var to = $('dateTo').value || '';
        return rows.filter(function (r) {
            if (q) {
                var hay = String(r.employee_name || '') + ' ' + String(r.employee_code || '');
                if (hay.indexOf(q) === -1) return false;
            }
            if (from && r.end_date < from) return false;   // تداخل النطاقين
            if (to && r.start_date > to) return false;
            return true;
        });
    }

    function rowHtml(r) {
        var conflictCell;
        if (r.status === 'pending') {
            var cached = state.conflictsCache[r.id];
            conflictCell = cached
                ? (cached.length
                    ? '<span class="conflict-warn"><i class="fas fa-triangle-exclamation"></i> ' + cached.length + ' مناوبة</span>'
                    : '<span class="conflict-none">—</span>')
                : '<span class="conflict-none" data-conflict-for="' + r.id + '"><i class="fas fa-spinner fa-spin"></i></span>';
        } else {
            conflictCell = '<span class="conflict-none">—</span>';
        }
        return '<tr>' +
            '<td class="name">' + esc(r.employee_name || ('موظف #' + r.employee_id)) + '<span class="code">' + esc(r.employee_code || '') + '</span></td>' +
            '<td>' + esc(r.type) + '</td>' +
            '<td class="num">' + esc(r.start_date) + '</td>' +
            '<td class="num">' + esc(r.end_date) + '</td>' +
            '<td class="num">' + dayCount(r.start_date, r.end_date) + '</td>' +
            '<td>' + statusChip(r) + '</td>' +
            '<td class="num">' + fmtTs(r.created_at) + '</td>' +
            '<td>' + conflictCell + '</td>' +
            '<td><button class="detail-toggle" data-open="' + r.id + '"><i class="fas fa-eye"></i> التفاصيل</button></td>' +
            '</tr>';
    }

    function renderList() {
        var rows = applyClientFilters(state.requests);
        // pending أولًا، مع الحفاظ على ترتيب السيرفر (created_at DESC) داخل كل مجموعة
        var pending = rows.filter(function (r) { return r.status === 'pending'; });
        var rest = rows.filter(function (r) { return r.status !== 'pending'; });
        var ordered = pending.concat(rest);
        $('rowsBody').innerHTML = ordered.length
            ? ordered.map(rowHtml).join('')
            : '<tr><td colspan="9" class="loading">لا توجد طلبات مطابقة.</td></tr>';
        $('metaLine').textContent = 'إجمالي المعروض: ' + ordered.length + ' من ' + state.requests.length +
            ' · قيد المراجعة: ' + pending.length + ' · آخر تحديث: ' + new Date().toLocaleTimeString('ar-SA');
        // الجلب الكسول للتعارضات — صفوف pending الظاهرة فقط، مرة واحدة لكل طلب
        ordered.forEach(function (r) {
            if (r.status === 'pending' && !state.conflictsCache[r.id]) fetchRowConflict(r);
        });
    }

    // تعارض كسول لصف واحد — قراءة صرفة (R8)، وفشله لا يكسر القائمة
    function fetchRowConflict(r) {
        state.conflictsCache[r.id] = state.conflictsCache[r.id] || null; // قفل تكرار
        api('/api/leave-requests/conflicts?employee_id=' + encodeURIComponent(r.employee_id) +
            '&from=' + encodeURIComponent(r.start_date) + '&to=' + encodeURIComponent(r.end_date))
            .then(function (res) {
                state.conflictsCache[r.id] = (res.ok && res.data && res.data.conflicts) || [];
                renderList();
            }).catch(function () {
                state.conflictsCache[r.id] = [];
                renderList();
            });
    }

    function loadRequests() {
        var status = $('statusFilter').value;
        var url = '/api/leave-requests' + (status ? '?status=' + encodeURIComponent(status) : '');
        return api(url).then(function (r) {
            if (r.status === 403) {
                // الصلاحية سُحبت أثناء الجلسة — عودة للبوابة المغلقة
                state.allowed = false;
                gateDenied('غير مصرّح', 'رفض الخادم الوصول — صلاحية «مراجعة الإجازات» غير متاحة لهذا الحساب.');
                return;
            }
            if (!r.ok || !r.data || !r.data.success) {
                $('rowsBody').innerHTML = '<tr><td colspan="9" class="error-box"><i class="fas fa-circle-xmark"></i> ' +
                    esc((r.data && r.data.error) || 'فشل الجلب') + '</td></tr>';
                return;
            }
            state.requests = r.data.requests || [];
            state.conflictsCache = {}; // إبطال الكسول مع كل جلب جديد
            renderList();
            // طلب مفتوح بالنافذة؟ حدّثه من الحالة الجديدة (الأولوية للسيرفر)
            if (state.detailId) {
                var cur = state.requests.filter(function (x) { return Number(x.id) === Number(state.detailId); })[0];
                if (cur) renderDetail(cur); else closeDetail();
            }
        }).catch(function () {
            $('rowsBody').innerHTML = '<tr><td colspan="9" class="error-box"><i class="fas fa-circle-xmark"></i> خطأ اتصال</td></tr>';
        });
    }

    // ═══ التفاصيل ═══
    function kv(k, v) { return '<div class="kv"><div class="k">' + esc(k) + '</div><div class="v">' + (v == null || v === '' ? '—' : v) + '</div></div>'; }

    function conflictListHtml(conflicts) {
        if (!conflicts || !conflicts.length) {
            return '<div class="warn-box" style="background:var(--surface);border-color:var(--border-soft);color:var(--text-2)">لا توجد مناوبات منشورة للموظف خلال أيام الطلب.</div>';
        }
        return '<div class="warn-box"><strong><i class="fas fa-triangle-exclamation"></i> للاطلاع فقط — الاعتماد لا يعدّل الجدول المنشور:</strong><ul style="padding-right:18px">' +
            conflicts.map(function (c) {
                return '<li>' + esc(c.date) + ' · مناوبة «' + esc(c.code || '—') + '»' +
                    (c.team ? ' · ' + esc(c.team) : '') + (c.center ? ' · ' + esc(c.center) : '') + '</li>';
            }).join('') + '</ul></div>';
    }

    function eventsHtml(events) {
        if (!events || !events.length) return '<div class="warn-box" style="background:var(--surface);border-color:var(--border-soft);color:var(--text-2)">لا أحداث مسجلة.</div>';
        return '<ul class="timeline">' + events.map(function (e) {
            var trans = (e.from_status ? (STATUS_LABEL[e.from_status] || e.from_status) + ' ← ' : '') + (STATUS_LABEL[e.to_status] || e.to_status);
            return '<li>' + esc(trans) +
                (e.reason ? ' — ' + esc(e.reason) : '') +
                '<span class="t">' + esc(fmtTs(e.created_at)) + ' · ' + esc(e.actor_user_id || '—') + ' (' + esc(e.actor_role || '—') + ')</span></li>';
        }).join('') + '</ul>';
    }

    function decisionBarHtml(r) {
        if (r.status === 'pending') {
            return '<div class="decision-bar" id="decisionBar">' +
                '<button class="btn approve" data-act="approve"><i class="fas fa-check"></i> اعتماد</button>' +
                '<button class="btn deny" data-act="deny"><i class="fas fa-ban"></i> رفض</button>' +
                '</div><div id="reasonHost"></div>';
        }
        if (r.status === 'approved') {
            return '<div class="decision-bar" id="decisionBar">' +
                '<button class="btn cancel-leave" data-act="cancel"><i class="fas fa-calendar-xmark"></i> إلغاء الإجازة المعتمدة</button>' +
                '</div><div id="reasonHost"></div>';
        }
        return ''; // معالَج — عرض حالة فقط، بلا أدوات قرار
    }

    function renderDetail(r, conflicts, events) {
        state.detailId = r.id;
        var html =
            '<div class="kv-grid">' +
            kv('الموظف', esc(r.employee_name || ('موظف #' + r.employee_id))) +
            kv('الكود', esc(r.employee_code || '—')) +
            kv('النوع', esc(r.type)) +
            kv('البداية', '<span class="num">' + esc(r.start_date) + '</span>') +
            kv('النهاية', '<span class="num">' + esc(r.end_date) + '</span>') +
            kv('الأيام', '<span class="num">' + dayCount(r.start_date, r.end_date) + '</span>') +
            kv('الحالة', statusChip(r)) +
            kv('تاريخ الطلب', '<span class="num">' + fmtTs(r.created_at) + '</span>') +
            (r.created_by ? kv('مقدّم الطلب (حساب)', esc(r.created_by)) : '') +
            (r.status === 'denied' ? kv('سبب الرفض', esc(r.denial_reason)) : '') +
            (r.status === 'cancelled' ? kv('سبب الإلغاء', esc(r.cancel_reason)) + kv('أُلغي بواسطة', esc(r.cancelled_by)) + kv('تاريخ الإلغاء', '<span class="num">' + fmtTs(r.cancelled_at) + '</span>') : '') +
            (r.reason ? kv('سبب الموظف', esc(r.reason)) : '') +
            '</div>' +
            '<div class="section-title"><i class="fas fa-calendar-day"></i>تعارضات الجدول المنشور</div><div id="detailConflicts">' +
            (conflicts ? conflictListHtml(conflicts) : '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>') + '</div>' +
            '<div class="section-title"><i class="fas fa-clock-rotate-left"></i>سجل التدقيق</div><div id="detailEvents">' +
            (events ? eventsHtml(events) : '<div class="loading"><i class="fas fa-spinner fa-spin"></i></div>') + '</div>' +
            decisionBarHtml(r);
        $('detailBody').innerHTML = html;
        $('detailModal').classList.add('open');
    }

    function openDetail(id) {
        var r = state.requests.filter(function (x) { return Number(x.id) === Number(id); })[0];
        if (!r) return;
        renderDetail(r); // هيكل فوري، والقراءتان الكسولتان تتبعان
        api('/api/leave-requests/conflicts?employee_id=' + encodeURIComponent(r.employee_id) +
            '&from=' + encodeURIComponent(r.start_date) + '&to=' + encodeURIComponent(r.end_date))
            .then(function (res) {
                if (state.detailId !== r.id) return;
                state.conflictsCache[r.id] = (res.ok && res.data && res.data.conflicts) || [];
                var host = $('detailConflicts');
                if (host) host.innerHTML = conflictListHtml(state.conflictsCache[r.id]);
            }).catch(function () { /* القائمة تبقى صالحة */ });
        api('/api/leave-requests/' + encodeURIComponent(r.id) + '/events')
            .then(function (res) {
                if (state.detailId !== r.id) return;
                var host = $('detailEvents');
                if (host) host.innerHTML = eventsHtml((res.ok && res.data && res.data.events) || []);
            }).catch(function () { /* عابر */ });
    }

    function closeDetail() {
        state.detailId = null;
        $('detailModal').classList.remove('open');
    }

    // ═══ قرارات الطلب ═══
    // رسالة السيرفر تُعرض كما هي؛ المعالَج/السباق ⇒ إعادة جلب (الأولوية للسيرفر)
    function handleDecisionError(res) {
        var msg = (res.data && res.data.error) || 'فشل تنفيذ القرار';
        toast(msg, 'error');
        if (res.data && (res.data.code === 'LEAVE_PROCESSED' || res.data.code === 'LEAVE_RACE')) {
            loadRequests();
        }
    }

    function doApprove(r) {
        api('/api/leave-requests/' + encodeURIComponent(r.id) + '/approve', {
            method: 'POST', body: JSON.stringify({ status: 'approved' })
        }).then(function (res) {
            if (!res.ok || !res.data || !res.data.success) { handleDecisionError(res); return; }
            toast('تم اعتماد الإجازة', 'success');
            // الاعتماد يرد conflicts (R8) — تُعرض مباشرة ولا تمنع شيئًا
            var conflicts = res.data.conflicts || [];
            state.conflictsCache[r.id] = conflicts;
            if (conflicts.length) {
                toast('تنبيه: للموظف ' + conflicts.length + ' مناوبة منشورة خلال الإجازة — راجع التفاصيل', 'warn');
            }
            loadRequests();
        }).catch(function () { toast('خطأ اتصال', 'error'); });
    }

    function doDeny(r, reason) {
        api('/api/leave-requests/' + encodeURIComponent(r.id) + '/approve', {
            method: 'POST', body: JSON.stringify({ status: 'denied', denial_reason: reason })
        }).then(function (res) {
            if (!res.ok || !res.data || !res.data.success) { handleDecisionError(res); return; }
            toast('تم رفض الطلب مع تسجيل السبب', 'success');
            loadRequests();
        }).catch(function () { toast('خطأ اتصال', 'error'); });
    }

    function doCancelApproved(r, reason) {
        api('/api/leave-requests/' + encodeURIComponent(r.id), {
            method: 'DELETE', body: JSON.stringify({ reason: reason })
        }).then(function (res) {
            if (!res.ok || !res.data || !res.data.success) { handleDecisionError(res); return; }
            toast('تم إلغاء الإجازة المعتمدة مع تسجيل السبب', 'success');
            loadRequests();
        }).catch(function () { toast('خطأ اتصال', 'error'); });
    }

    // نموذج السبب الإلزامي (رفض/إلغاء) — لا يُرسل شيء بسبب فارغ (تحقق عميل + حسم سيرفي)
    function showReasonForm(kind, r) {
        var isDeny = kind === 'deny';
        $('reasonHost').innerHTML =
            '<div class="reason-box"><textarea id="reasonText" placeholder="' +
            (isDeny ? 'سبب الرفض (إلزامي) — يظهر للموظف في إشعار الرفض' : 'سبب إلغاء الإجازة المعتمدة (إلزامي) — يظهر للموظف في الإشعار') +
            '"></textarea><div class="reason-actions">' +
            '<button class="btn ' + (isDeny ? 'deny' : 'cancel-leave') + '" id="reasonConfirm"><i class="fas fa-paper-plane"></i> ' +
            (isDeny ? 'تأكيد الرفض' : 'تأكيد الإلغاء') + '</button>' +
            '<button class="btn secondary" id="reasonCancel">تراجع</button></div></div>';
        $('reasonCancel').onclick = function () { $('reasonHost').innerHTML = ''; };
        $('reasonConfirm').onclick = function () {
            var reason = ($('reasonText').value || '').trim();
            if (!reason) { toast(isDeny ? 'سبب الرفض إلزامي' : 'سبب الإلغاء إلزامي', 'error'); return; }
            if (isDeny) doDeny(r, reason); else doCancelApproved(r, reason);
        };
        $('reasonText').focus();
    }

    // ═══ SSE — اتصال واحد فقط (نمط my-ems) ═══
    // REST هو مصدر الحقيقة دائمًا؛ البث طبقة تسريع: حدث إجازات ⇒ إعادة جلب القائمة.
    function connectLive() {
        var token = AuthCore.getToken();
        if (!token || typeof EventSource === 'undefined' || state.es) return;
        var es;
        try { es = new EventSource('/api/sse?token=' + encodeURIComponent(token)); }
        catch (_) { return; }
        state.es = es;
        es.onmessage = function (event) {
            var data = null;
            try { data = JSON.parse(event.data); } catch (_) { return; }
            if (!data || !data.type) return;
            if (data.type === 'leave_request_submitted' || data.type === 'leave_request_updated' ||
                data.type === 'leave_request_resolved' || data.type === 'leave_request_cancelled') {
                toast(data.message || 'تحديث في طلبات الإجازات');
                loadRequests();
                return;
            }
            // العنوان/النص الحقيقيان داخل data.notification — المستوى الأعلى رسالة عامة (عقد A-1)
            if (data.type === 'notification_created') {
                var n = data.notification || {};
                if (/إجاز/.test(String(n.title || '') + ' ' + String(n.message || ''))) {
                    toast('🔔 ' + (n.title || data.message || 'إشعار إجازات'));
                    loadRequests();
                }
            }
        };
        // رفض خادمي (401/403 ⇒ CLOSED): إيقاف نهائي بلا عاصفة إعادة اتصال.
        es.onerror = function () {
            if (es.readyState === EventSource.CLOSED) {
                try { es.close(); } catch (_) { }
                state.es = null;
            }
        };
    }

    // ═══ الربط والإقلاع ═══
    function bindEvents() {
        $('refreshBtn').onclick = function () { loadRequests(); };
        $('statusFilter').onchange = function () { loadRequests(); };       // فلتر سيرفي ?status=
        $('searchInput').oninput = function () { renderList(); };           // فلاتر محلية
        $('dateFrom').onchange = function () { renderList(); };
        $('dateTo').onchange = function () { renderList(); };
        $('detailClose').onclick = closeDetail;
        $('detailModal').addEventListener('click', function (e) {
            if (e.target === $('detailModal')) closeDetail();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && state.detailId) closeDetail();
        });
        // تفويض أحداث الجدول والقرارات (عناصر تُعاد كتابتها مع كل render)
        document.addEventListener('click', function (e) {
            var openBtn = e.target.closest('[data-open]');
            if (openBtn) { openDetail(openBtn.getAttribute('data-open')); return; }
            var actBtn = e.target.closest('[data-act]');
            if (!actBtn || !state.detailId) return;
            var r = state.requests.filter(function (x) { return Number(x.id) === Number(state.detailId); })[0];
            if (!r) return;
            var act = actBtn.getAttribute('data-act');
            if (act === 'approve') {
                if (window.confirm('اعتماد الإجازة لـ ' + (r.employee_name || '') + ' من ' + r.start_date + ' إلى ' + r.end_date + '؟')) doApprove(r);
            } else if (act === 'deny') {
                showReasonForm('deny', r);
            } else if (act === 'cancel') {
                showReasonForm('cancel', r);
            }
        });
    }

    function init() {
        if (!AuthCore.requireAuth('/')) return; // بلا توكن ⇒ الصفحة الرئيسية (بوابة الدخول)
        bindEvents();
        // البوابة أولًا — لا جلب لأي بيانات إجازات قبل اجتيازها (Fail-Closed)
        checkAccess().then(function (allowed) {
            if (!allowed) return;
            loadRequests();
            connectLive();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
