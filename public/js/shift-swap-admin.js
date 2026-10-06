/**
 * ═══ shift-swap-admin.js — صفحة مراجعة طلبات التبديل بالتراضي (FSS E-7) ═══
 *
 * نفس وصفة unable-attend-admin (E-3/ج4) حرفيًا:
 * البوابة Fail-Closed: تُجلب /api/auth/me أولًا؛ بلا schedule.requests.review
 * ولا star ⇒ بطاقة «غير مصرّح» ولا يُستدعى أي endpoint. إخفاء الرابط في
 * الشريط الجانبي ردع بصري فقط — الخادم هو الحارس (authorizePerm).
 *
 * العقد (قائم من E-6 — لا API جديد هنا):
 *   GET  /api/schedule/shift-swaps[?status=]      قائمة مُثراة (أسماء الطرفين + الفريق)
 *   POST /api/schedule/shift-swaps/:id/review     {decision:'approve'|'reject', note?} → {success, status}
 *
 * قواعد عرض ملزمة (قرارات المالك):
 *   - M9: pending_review = تصعيد بعد موافقة الطرفين (نافذة 48س و/أو فشل فحص E-4)
 *     وليس رفضًا مسبقًا — القرار للمسؤول.
 *   - الاعتماد يعيد فحوصات E-4 للاتجاهين إلزاميًا ثم يطبّق ذرّيًا (خادميًا).
 *   - escalation_reason يُعرض مترجمًا: حالة النافذة + أكواد أسباب E-4 لكل اتجاه.
 *   - الطلب المعالَج = عرض حالة فقط، بلا أدوات قرار؛ 409 ⇒ رسالة السيرفر وإعادة جلب.
 *   - لا employee_id يُدخَل أو يُختار من هذه الواجهة إطلاقًا.
 *
 * SSE: EventSource واحد على /api/sse — حدث notification_created الخاص بالتبديل
 *   ⇒ إعادة جلب. رفض خادمي (CLOSED) = إيقاف نهائي بلا عاصفة إعادة اتصال.
 */
(function () {
    'use strict';

    var state = { allowed: false, requests: [], detailId: null, es: null };
    var STATUS_LABEL = {
        pending_consent: 'بانتظار موافقة الطرف الثاني',
        declined_by_peer: 'رفضها الزميل',
        pending_review: 'قيد المراجعة',
        auto_applied: 'طُبّقت تلقائيًا',
        applied: 'طُبّقت باعتماد المسؤول',
        rejected: 'مرفوضة',
        cancelled: 'ملغاة'
    };
    // ترجمة أسباب الفحص لصياغة تشغيلية واضحة — المفاتيح التقنية تبقى في الكود
    // والـAudit فقط ولا تُعرض للمستخدم إطلاقًا (قرار المالك 2026-10-06).
    // أي سبب غير معروف يُعرض بصيغة عامة بلا رمز.
    var REASON_LABEL = {
        EMPLOYEE_NOT_ACTIVE: 'الموظف غير نشط حاليًا',
        EMPLOYEE_NO_ACTIVE_TEAM: 'الموظف ليس ضمن الفريق في ذلك التاريخ',
        UNKNOWN_SHIFT_CODE: 'رمز المناوبة غير صالح للجدولة',
        NOT_A_WORK_SHIFT: 'رمز المناوبة غير صالح للجدولة',
        MULTIPLE_SHIFTS_SAME_DAY: 'سيكون لديه أكثر من مناوبة في نفس اليوم',
        SHIFT_OVERLAP: 'يوجد تداخل زمني مع مناوبة أخرى قائمة',
        NEXT_DAY_CONFLICT: 'يتعارض مع مناوبة اليوم التالي',
        REST_BELOW_MINIMUM: 'الفترة بين المناوبات ستصبح أقل من الحد الأدنى للراحة (8 ساعات)',
        LEAVE_CONFLICT_APPROVED: 'لديه إجازة معتمدة في نفس الفترة',
        UNABLE_ATTEND_CONFLICT: 'لديه عدم تمكّن معتمد في نفس الفترة',
        CONSECUTIVE_NIGHTS_EXCEEDED: 'عدد الليالي المتتالية سيتجاوز الحد المسموح',
        COVERAGE_BELOW_MINIMUM: 'تغطية الفريق ستنزل تحت الحد الأدنى المطلوب'
    };
    var REASON_FALLBACK = 'يتعارض مع قواعد الجدولة الحالية';

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
                gateDenied('غير مصرّح', 'هذه الشاشة تتطلب صلاحية «مراجعة طلبات الجدولة». اطلب المنحة من مدير النظام.');
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
                var hay = String(r.initiator_name || '') + ' ' + String(r.initiator_code || '') + ' ' +
                          String(r.target_name || '') + ' ' + String(r.target_code || '') + ' ' + String(r.team_name || '');
                if (hay.indexOf(q) === -1) return false;
            }
            var firstDate = r.initiator_date < r.target_date ? r.initiator_date : r.target_date;
            if (from && firstDate < from) return false;
            if (to && firstDate > to) return false;
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
            return '<tr>' +
                '<td class="name">' + esc(r.initiator_name || ('موظف #' + r.initiator_employee_id)) +
                    '<span class="code">' + esc(r.initiator_code || '') + '</span></td>' +
                '<td class="name">' + esc(r.target_name || ('موظف #' + r.target_employee_id)) +
                    '<span class="code">' + esc(r.target_code || '') + '</span></td>' +
                '<td>' + esc(r.team_name || '—') + '</td>' +
                '<td>' + esc(r.initiator_date) + ' (' + esc(r.initiator_shift_code) + ')</td>' +
                '<td>' + esc(r.target_date) + ' (' + esc(r.target_shift_code) + ')</td>' +
                '<td>' + statusChip(r) + '</td>' +
                '<td>' + fmtTs(r.created_at) + '</td>' +
                '<td><button class="detail-toggle" data-detail="' + r.id + '">التفاصيل</button></td>' +
            '</tr>';
        }).join('');
        $('metaLine').textContent = 'إجمالي المعروض: ' + rows.length + ' من ' + state.requests.length + ' طلبًا';
    }

    function loadRequests() {
        var st = $('statusFilter').value;
        return api('/api/schedule/shift-swaps' + (st ? '?status=' + encodeURIComponent(st) : '')).then(function (r) {
            if (!r.ok || !r.data) {
                $('rowsBody').innerHTML = '<tr><td colspan="8" class="error-box">تعذر جلب الطلبات — ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</td></tr>';
                return;
            }
            state.requests = r.data.requests || [];
            renderRows();
        });
    }

    // ═══ تفكيك سبب المراجعة — صياغة تشغيلية واضحة بلا أي رموز داخلية (قرار المالك) ═══
    // المصدر الخام (escalation_reason) يبقى في قاعدة البيانات والـAudit للمطور؛
    // المعروض هنا يجيب فقط: ما المشكلة؟ ومن المتأثر؟ — بلا أسماء قواعد أو أكواد.
    function renderEscalation(raw, r) {
        if (!raw) return '';
        if (raw === 'roster_changed_at_consent') {
            return '<div class="reason-box"><b>سبب الإلغاء:</b> تغيّرت مناوبات أحد الطرفين قبل اكتمال الموافقة، فأُلغي الطلب تلقائيًا. يمكن تقديم طلب جديد بالمناوبات الحالية.</div>';
        }
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { /* ليس JSON — صيغة عامة */ }
        if (!parsed || typeof parsed !== 'object') {
            return '<div class="reason-box"><b>سبب المراجعة:</b> وافق الطرفان على التبادل، لكن تطبيقه يحتاج قرار المسؤول قبل اعتماده على الجدول.</div>';
        }
        var parts = [];
        if (parsed.window === true) {
            parts.push('موافقة الطرف الثاني جاءت قريبًا من موعد المناوبة (خلال 48 ساعة من بدايتها)، لذلك لا يُطبَّق التبادل تلقائيًا ويحتاج قرارك.');
        }
        function dir(name, d) {
            if (!d || d.valid) return;
            var reasons = (d.reasons || []).map(function (code) {
                return REASON_LABEL[code] || REASON_FALLBACK;
            });
            parts.push('بالنسبة لـ<b>' + esc(name) + '</b>:');
            if (reasons.length) parts.push('<ul>' + reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>');
            else parts.push('<ul><li>' + esc(REASON_FALLBACK) + '</li></ul>');
        }
        dir((r && r.initiator_name) || 'المبادر', parsed.dir_initiator);
        dir((r && r.target_name) || 'الهدف', parsed.dir_target);
        if (!parts.length) parts.push('وافق الطرفان على التبادل، لكن تطبيقه يحتاج قرار المسؤول قبل اعتماده على الجدول.');
        return '<div class="reason-box"><b>سبب المراجعة</b><br>' + parts.join('<br>') + '</div>';
    }

    // ═══ نافذة التفاصيل + القرار ═══
    function openDetail(id) {
        var r = state.requests.find(function (x) { return Number(x.id) === Number(id); });
        if (!r) return;
        state.detailId = r.id;
        var pending = r.status === 'pending_review';
        $('detailBody').innerHTML =
            '<div class="kv-grid">' +
                '<div class="kv"><div class="k">المبادر</div><div class="v">' + esc(r.initiator_name || ('#' + r.initiator_employee_id)) + ' (' + esc(r.initiator_code || '—') + ')</div></div>' +
                '<div class="kv"><div class="k">الهدف</div><div class="v">' + esc(r.target_name || ('#' + r.target_employee_id)) + ' (' + esc(r.target_code || '—') + ')</div></div>' +
                '<div class="kv"><div class="k">الفريق</div><div class="v">' + esc(r.team_name || '—') + '</div></div>' +
                '<div class="kv"><div class="k">الحالة</div><div class="v">' + esc(STATUS_LABEL[r.status] || r.status) + '</div></div>' +
                '<div class="kv"><div class="k">مناوبة المبادر</div><div class="v">' + esc(r.initiator_date) + ' (' + esc(r.initiator_shift_code) + ')</div></div>' +
                '<div class="kv"><div class="k">مناوبة الهدف</div><div class="v">' + esc(r.target_date) + ' (' + esc(r.target_shift_code) + ')</div></div>' +
                '<div class="kv"><div class="k">تاريخ الطلب</div><div class="v">' + fmtTs(r.created_at) + '</div></div>' +
                (r.consent_at ? '<div class="kv"><div class="k">موافقة الطرف الثاني</div><div class="v">' + fmtTs(r.consent_at) + '</div></div>' : '') +
                (r.reviewed_at ? '<div class="kv"><div class="k">تاريخ المراجعة</div><div class="v">' + fmtTs(r.reviewed_at) + '</div></div>' : '') +
            '</div>' +
            (r.review_note ? '<div class="kv" style="margin-bottom:12px"><div class="k">ملاحظة المراجعة</div><div class="v">' + esc(r.review_note) + '</div></div>' : '') +
            renderEscalation(r.escalation_reason, r) +
            (pending ? '<div class="warn-box">⚠️ وافق الطرفان على التبادل، لكنه يحتاج قرارك قبل التطبيق. عند الاعتماد يتحقق النظام من قواعد الجدولة للطرفين ثم يبدّل المناوبتين بشكل آمن — وإن تعذّر ذلك لن يتغيّر أي شيء.</div>' : '') +
            (pending ?
                '<div class="kv"><div class="k">ملاحظة المراجعة (اختيارية)</div>' +
                    '<textarea class="note-input" id="swNote" maxlength="300" placeholder="سبب القرار أو توضيح للطرفين…"></textarea></div>' +
                '<div class="decision-bar">' +
                    '<button class="btn approve" id="swApprove">اعتماد وتطبيق التبادل</button>' +
                    '<button class="btn deny" id="swReject">رفض الطلب</button>' +
                    '<button class="btn secondary" id="swClose">إغلاق</button>' +
                '</div>'
            : '<div class="decision-bar"><button class="btn secondary" id="swClose">إغلاق</button></div>');
        $('detailModal').classList.add('open');
        $('swClose').addEventListener('click', closeDetail);
        if (pending) {
            $('swApprove').addEventListener('click', function () { decide('approve'); });
            $('swReject').addEventListener('click', function () { decide('reject'); });
        }
    }
    function closeDetail() { $('detailModal').classList.remove('open'); state.detailId = null; }

    function decide(decision) {
        var id = state.detailId;
        if (!id) return;
        var noteEl = $('swNote');
        var note = noteEl ? noteEl.value.trim() : '';
        if (decision === 'approve' && !confirm('اعتماد طلب التبديل هذا وتطبيقه على جدول المناوبات؟')) return;
        var btns = $('detailBody').querySelectorAll('.btn');
        btns.forEach(function (b) { b.disabled = true; });
        api('/api/schedule/shift-swaps/' + id + '/review', { method: 'POST', body: JSON.stringify({ decision: decision, note: note || undefined }) }).then(function (r) {
            if (r.ok && r.data && r.data.success) {
                toast(decision === 'approve' ? '✅ تم الاعتماد وطُبّق التبادل على الجدول وأُشعر الطرفان' : 'تم رفض الطلب وأُشعر الطرفان', 'success');
                closeDetail();
                loadRequests();
            } else {
                // 409: معالَج/مُلغى مسبقًا أو تغيّر الجدول — رسالة السيرفر هي الحاكمة
                toast((r.data && r.data.error) || ('تعذر تنفيذ القرار — HTTP ' + r.status), 'error');
                btns.forEach(function (b) { b.disabled = false; });
                loadRequests(); // الأولوية لحالة السيرفر
            }
        }).catch(function () {
            toast('خطأ اتصال — لم يُنفَّذ أي قرار', 'error');
            btns.forEach(function (b) { b.disabled = false; });
        });
    }

    // ═══ SSE — تحديث لحظي عند تصعيد/تطبيق طلب تبديل (إشعارات E-6 عبر عقد A-1) ═══
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
                if (/تبديل/.test(hay)) {
                    toast('تحديث في طلبات التبديل — تُعاد القراءة', 'warn');
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
