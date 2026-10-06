/**
 * ═══ schedule-proposals-admin.js — شاشة العروض التكميلية للجدولة (FSS E-7) ═══
 *
 * نفس وصفة unable-attend-admin (E-3/ج4) حرفيًا:
 * البوابة Fail-Closed: تُجلب /api/auth/me أولًا؛ بلا schedule.proposals.manage
 * ولا star ⇒ بطاقة «غير مصرّح» ولا يُستدعى أي endpoint. إخفاء الرابط في
 * الشريط الجانبي ردع بصري فقط — الخادم هو الحارس (authorizePerm).
 *
 * العقد (قائمة من E-5 — لا API جديد هنا):
 *   POST /api/schedule/proposals/generate        {month, team_id} → {run_id, gaps, offers[], skipped[]}
 *   GET  /api/schedule/proposals[?month&team_id&status]  قائمة مُثراة (employee_name/code)
 *   GET  /api/schedule/proposals/runs/:id        تشغيلة كاملة (gap_summary + ranked_queue بلا أسماء)
 *   POST /api/schedule/proposals/:id/withdraw    سحب عرض + تسلسل J5 للمرشح التالي
 *   GET  /api/teams                              قائمة الفرق (authenticate فقط)
 *
 * قواعد عرض ملزمة (قرارات المالك):
 *   - J4: لا تطبيق تلقائي — قبول الموظف يُطبَّق عبر المسارات المعتمدة (F-1) خارج E-5.
 *   - M13: شهر منشور ⇒ التوليد يرجع 409 MONTH_PUBLISHED — رسالة السيرفر تُعرض كما هي.
 *   - L4: تفصيل M5 الكامل (الأبعاد الأربعة) يظهر هنا للمسؤول فقط — بوابة الموظف
 *     تعرض سببًا مبسطًا ثابتًا ولا ترتيب فيها إطلاقًا.
 *   - ranked_queue في التشغيلة بلا أسماء (عقد E-5 المجمّد) — تُثرى من قائمة
 *     الشهر/الفريق المحمّلة عند توفرها، وإلا «موظف #id».
 *
 * SSE: EventSource واحد على /api/sse — حدث notification_created الخاص بالعروض
 *   التكميلية ⇒ إعادة جلب القائمة. رفض خادمي (CLOSED) = إيقاف نهائي.
 */
(function () {
    'use strict';

    var state = { allowed: false, proposals: [], teams: [], runId: null, es: null };
    var STATUS_LABEL = {
        offered: 'معروض — بانتظار رد الموظف',
        accepted: 'مقبول — بانتظار التطبيق',
        declined: 'رفضه الموظف',
        withdrawn: 'مسحوب',
        superseded: 'متجاوَز'
    };
    var QUEUE_STATE_LABEL = {
        active: 'نشطة',
        resolved: 'سُدّت',
        exhausted: 'استُنفدت قائمة المرشحين',
        aborted: 'أُجهضت (لا رمز صالح)'
    };
    var OUTCOME_LABEL = {
        offer_next: 'سُحب العرض وعُرض على المرشح التالي تلقائيًا',
        gap_resolved: 'سُحب العرض — الفجوة سُدّت بالفعل، لا حاجة لعرض بديل',
        queue_exhausted: 'سُحب العرض — لا مرشح صالح متبقٍ لهذه الفجوة'
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
            if (!star && perms.indexOf('schedule.proposals.manage') === -1) {
                gateDenied('غير مصرّح', 'هذه الشاشة تتطلب صلاحية «إدارة اقتراحات الجدولة». اطلب المنحة من مدير النظام.');
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

    // ═══ الفرق + الشهر الافتراضي ═══
    function nextMonthValue() {
        var d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() + 1);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }

    function loadTeams() {
        return api('/api/teams').then(function (r) {
            if (!r.ok || !r.data) { toast('تعذر جلب قائمة الفرق', 'error'); return; }
            state.teams = r.data.teams || [];
            $('teamSelect').innerHTML = '<option value="">— الفريق —</option>' +
                state.teams.map(function (t) {
                    return '<option value="' + t.id + '">' + esc(t.name) + (t.center ? ' (' + esc(t.center) + ')' : '') + '</option>';
                }).join('');
        });
    }

    // ═══ القائمة ═══
    function statusChip(p) {
        return '<span class="chip ' + esc(p.status) + '">' + esc(STATUS_LABEL[p.status] || p.status) + '</span>';
    }

    function renderRows() {
        var rows = state.proposals;
        var body = $('rowsBody');
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="8" class="loading">لا توجد عروض مطابقة — ولّد العروض أو غيّر الفلاتر.</td></tr>';
            return;
        }
        body.innerHTML = rows.map(function (p) {
            return '<tr>' +
                '<td>' + esc(p.date) + '</td>' +
                '<td>' + (p.period === 'night' ? 'ليلية' : 'صباحية') + '</td>' +
                '<td class="name">' + esc(p.employee_name || ('موظف #' + p.employee_id)) +
                    '<span class="code">' + esc(p.employee_code || '') + '</span></td>' +
                '<td>' + esc(p.shift_code) + '</td>' +
                '<td>' + (p.rank_position != null ? '#' + p.rank_position : '—') + '</td>' +
                '<td>' + statusChip(p) + '</td>' +
                '<td>' + fmtTs(p.created_at) + '</td>' +
                '<td>' +
                    '<button class="detail-toggle" data-run="' + p.run_id + '">التشغيلة</button> ' +
                    (p.status === 'offered' ? '<button class="detail-toggle withdraw" data-withdraw="' + p.id + '">سحب</button>' : '') +
                '</td>' +
            '</tr>';
        }).join('');
        $('metaLine').textContent = 'إجمالي المعروض: ' + rows.length + ' عرضًا — ' +
            $('monthInput').value + ' · ' + ($('teamSelect').selectedOptions[0] ? $('teamSelect').selectedOptions[0].textContent : '');
    }

    function currentFilters() {
        return { month: $('monthInput').value, teamId: $('teamSelect').value, status: $('statusFilter').value };
    }

    function loadProposals() {
        var f = currentFilters();
        if (!f.month || !f.teamId) {
            toast('اختر الشهر والفريق أولًا', 'warn');
            return Promise.resolve();
        }
        var qs = '?month=' + encodeURIComponent(f.month) + '&team_id=' + encodeURIComponent(f.teamId) +
                 (f.status ? '&status=' + encodeURIComponent(f.status) : '');
        return api('/api/schedule/proposals' + qs).then(function (r) {
            if (!r.ok || !r.data) {
                $('rowsBody').innerHTML = '<tr><td colspan="8" class="error-box">تعذر جلب العروض — ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</td></tr>';
                return;
            }
            state.proposals = r.data.proposals || [];
            renderRows();
        });
    }

    // ═══ التوليد (J1) — الخادم هو الحارس: M13 ⇒ 409، العروض الحية تُتخطى ═══
    function generate() {
        var f = currentFilters();
        if (!f.month || !f.teamId) { toast('اختر الشهر والفريق أولًا', 'warn'); return; }
        var btn = $('generateBtn');
        btn.disabled = true;
        api('/api/schedule/proposals/generate', { method: 'POST', body: JSON.stringify({ month: f.month, team_id: Number(f.teamId) }) }).then(function (r) {
            btn.disabled = false;
            if (r.ok && r.data && r.data.success) {
                var d = r.data;
                toast('✅ اكتملت التشغيلة #' + d.run_id + ' — فجوات: ' + d.gaps +
                      ' · عروض جديدة: ' + (d.offers || []).length +
                      ((d.skipped || []).length ? ' · متخطاة: ' + d.skipped.length : ''), 'success');
                loadProposals();
            } else {
                // 409 MONTH_PUBLISHED وغيرها — رسالة السيرفر هي الحاكمة
                toast((r.data && r.data.error) || ('تعذر التوليد — HTTP ' + r.status), 'error');
            }
        }).catch(function () {
            btn.disabled = false;
            toast('خطأ اتصال — لم يبدأ أي توليد', 'error');
        });
    }

    // ═══ سحب عرض (تسلسل J5 داخل الخدمة) ═══
    function withdraw(id) {
        if (!confirm('سحب العرض #' + id + '؟ سيُعرض على المرشح التالي تلقائيًا إن وُجد.')) return;
        api('/api/schedule/proposals/' + id + '/withdraw', { method: 'POST', body: '{}' }).then(function (r) {
            if (r.ok && r.data && r.data.success) {
                toast(OUTCOME_LABEL[r.data.outcome] || 'تم سحب العرض', 'success');
                loadProposals();
            } else {
                toast((r.data && r.data.error) || ('تعذر السحب — HTTP ' + r.status), 'error');
                loadProposals();
            }
        }).catch(function () {
            toast('خطأ اتصال — لم يُنفَّذ السحب', 'error');
        });
    }

    // ═══ نافذة التشغيلة — تفصيل عوامل الترتيب للمسؤول بصياغة تشغيلية (قرار المالك: لا رموز داخلية) ═══
    function nameOf(empId) {
        var p = state.proposals.find(function (x) { return Number(x.employee_id) === Number(empId); });
        return p && p.employee_name ? (p.employee_name + ' (' + (p.employee_code || '') + ')') : ('موظف #' + empId);
    }

    // ترجمة أسباب استبعاد مرشح لصياغة تشغيلية — الأكواد الخام تبقى في قاعدة البيانات والـAudit فقط
    var INVALID_LABEL = {
        LIVE_OFFER_SAME_DAY: 'لديه عرض آخر قائم في نفس اليوم',
        LIVE_OFFER_SAME_DAY_RACE: 'لديه عرض آخر قائم في نفس اليوم',
        HAS_ROSTER: 'لديه مناوبة مسجلة في ذلك اليوم',
        EMPLOYEE_NO_ACTIVE_TEAM: 'لم يعد ضمن الفريق في ذلك التاريخ',
        EMPLOYEE_NOT_ACTIVE: 'الموظف غير نشط حاليًا',
        UNKNOWN_SHIFT_CODE: 'رمز المناوبة غير صالح للجدولة',
        NOT_A_WORK_SHIFT: 'رمز المناوبة غير صالح للجدولة',
        MULTIPLE_SHIFTS_SAME_DAY: 'سيكون لديه أكثر من مناوبة في نفس اليوم',
        SHIFT_OVERLAP: 'يوجد تداخل زمني مع مناوبة أخرى قائمة',
        NEXT_DAY_CONFLICT: 'يتعارض مع مناوبة اليوم التالي',
        REST_BELOW_MINIMUM: 'الفترة بين المناوبات أقل من الحد الأدنى للراحة (8 ساعات)',
        LEAVE_CONFLICT_APPROVED: 'لديه إجازة معتمدة في نفس الفترة',
        UNABLE_ATTEND_CONFLICT: 'لديه عدم تمكّن معتمد في نفس الفترة',
        CONSECUTIVE_NIGHTS_EXCEEDED: 'عدد الليالي المتتالية سيتجاوز الحد المسموح',
        COVERAGE_BELOW_MINIMUM: 'تغطية الفريق ستنزل تحت الحد الأدنى المطلوب'
    };
    function translateInvalidated(raw) {
        return String(raw).split(',').map(function (code) {
            return INVALID_LABEL[code.trim()] || 'لم يعد مؤهلًا لهذا العرض';
        }).join('، ');
    }
    // ملاحظات الفجوة الخام تأتي ببادئة تقنية ثم نص — تُعرض بلا البادئة
    var NOTE_PREFIX_LABEL = {
        queue_exhausted: 'استُنفدت قائمة المرشحين',
        existing_live_offer: 'يوجد عرض قائم لهذه الفجوة',
        no_valid_shift_code: 'لا يوجد رمز مناوبة صالح لهذه الفترة'
    };
    function translateNote(n) {
        var m = /^([a-z_]+):?\s*(.*)$/i.exec(String(n));
        if (m && NOTE_PREFIX_LABEL[m[1]]) {
            return NOTE_PREFIX_LABEL[m[1]] + (m[2] ? ' — ' + m[2] : '');
        }
        return String(n);
    }

    function m5Line(c) {
        var m = c.m5 || {};
        return 'تفضيلات محققة: ' + (m.pref_fulfilled != null ? m.pref_fulfilled : '—') + ' من ' + (m.pref_total != null ? m.pref_total : '—') + ' (الأقل تحققًا يتقدم)' +
               ' · عبء الليالي هذا الشهر: ' + (m.burden_nights || 0) + ' (الأعلى عبئًا يتقدم)' +
               ' · عمر الطلب: لا يؤثر حاليًا' +
               ' · عند التعادل: الأقدم رقمًا وظيفيًا';
    }

    function renderGap(g) {
        var cov = g.coverage_before || {};
        var queue = (g.ranked_queue || []).slice().sort(function (a, b) { return a.rank_position - b.rank_position; });
        var qRows = queue.map(function (c) {
            return '<tr>' +
                '<td>#' + c.rank_position + '</td>' +
                '<td>' + esc(nameOf(c.employee_id)) +
                    (c.offered ? ' <span class="offered-flag">— عُرض عليه</span>' : '') +
                    (c.invalidated ? '<br><span class="invalid-flag">اُستبعد لاحقًا: ' + esc(translateInvalidated(c.invalidated)) + '</span>' : '') +
                    '<div class="m5-line">' + esc(m5Line(c)) + '</div></td>' +
            '</tr>';
        }).join('');
        return '<div class="gap-card">' +
            '<h4><i class="fas fa-circle-notch"></i>' + esc(g.date) + ' — ' + (g.period === 'night' ? 'ليلية' : 'صباحية') +
                (g.shift_code_selected ? ' · الرمز المختار: ' + esc(g.shift_code_selected) : '') + '</h4>' +
            '<div class="gap-meta">التغطية قبل العرض: نهار ' + (cov.day != null ? cov.day : '—') + '/' + (cov.rule && cov.rule.day != null ? cov.rule.day : '—') +
                ' · ليل ' + (cov.night != null ? cov.night : '—') + '/' + (cov.rule && cov.rule.night != null ? cov.rule.night : '—') +
                ' · إجمالي ' + (cov.total != null ? cov.total : '—') + '/' + (cov.rule && cov.rule.total != null ? cov.rule.total : '—') +
                ' · حالة القائمة: ' + esc(QUEUE_STATE_LABEL[g.queue_state] || g.queue_state || '—') + '</div>' +
            (queue.length ?
                '<table class="queue-table"><thead><tr><th style="width:52px">الترتيب</th><th>المرشح — عوامل الترتيب المعتمدة</th></tr></thead><tbody>' + qRows + '</tbody></table>' +
                '<div class="m5-note">هذه المعلومات تُستخدم لترتيب المرشحين لهذه المناوبة فقط، ولا تمثل تقييمًا لأداء الموظف.</div>'
                : '<div class="gap-meta">لا قائمة مرشحين مسجلة لهذه الفجوة.</div>') +
            ((g.notes || []).length ? '<div class="gap-notes">' + g.notes.map(function (n) { return '• ' + esc(translateNote(n)); }).join('<br>') + '</div>' : '') +
        '</div>';
    }

    function openRun(runId) {
        state.runId = runId;
        $('runBody').innerHTML = '<div class="loading"><i class="fas fa-spinner fa-spin"></i> جاري تحميل التشغيلة…</div>';
        $('runModal').classList.add('open');
        api('/api/schedule/proposals/runs/' + encodeURIComponent(runId)).then(function (r) {
            if (!r.ok || !r.data || !r.data.run) {
                $('runBody').innerHTML = '<div class="error-box">تعذر جلب التشغيلة — ' + esc((r.data && r.data.error) || ('HTTP ' + r.status)) + '</div>' +
                    '<div class="decision-bar"><button class="btn secondary" id="runClose2">إغلاق</button></div>';
                $('runClose2').addEventListener('click', closeRun);
                return;
            }
            var run = r.data.run;
            var gaps = run.gap_summary || [];
            var team = state.teams.find(function (t) { return Number(t.id) === Number(run.team_id); });
            $('runBody').innerHTML =
                '<div class="kv-grid">' +
                    '<div class="kv"><div class="k">التشغيلة</div><div class="v">#' + run.id + '</div></div>' +
                    '<div class="kv"><div class="k">الشهر</div><div class="v">' + esc(run.month) + '</div></div>' +
                    '<div class="kv"><div class="k">الفريق</div><div class="v">' + esc(team ? team.name : ('#' + run.team_id)) + '</div></div>' +
                    '<div class="kv"><div class="k">الحالة</div><div class="v">' + esc(run.status) + '</div></div>' +
                    '<div class="kv"><div class="k">الفجوات</div><div class="v">' + gaps.length + '</div></div>' +
                    '<div class="kv"><div class="k">العروض الناتجة</div><div class="v">' + (run.proposals || []).length + '</div></div>' +
                    '<div class="kv"><div class="k">تاريخ التشغيلة</div><div class="v">' + fmtTs(run.created_at) + '</div></div>' +
                '</div>' +
                '<div class="warn-box">ترتيب المرشحين آلي وحتمي حسب قواعد العدالة المعتمدة: ① الأقل تحققًا لتفضيلاته يتقدم ← ② الأعلى عبئًا بالليالي يتقدم ← ③ عند التعادل: الأقدم رقمًا وظيفيًا. قائمة كل فجوة محفوظة كاملة، وعند رفض موظف أو سحب عرضه ينتقل العرض تلقائيًا للمرشح التالي في القائمة.</div>' +
                (gaps.length ? gaps.map(renderGap).join('') : '<div class="loading">لا فجوات في هذه التشغيلة.</div>') +
                '<div class="decision-bar"><button class="btn secondary" id="runClose2">إغلاق</button></div>';
            $('runClose2').addEventListener('click', closeRun);
        });
    }
    function closeRun() { $('runModal').classList.remove('open'); state.runId = null; }

    // ═══ SSE — تحديث لحظي عند عرض/قبول/سحب (إشعارات E-5 عبر عقد A-1) ═══
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
                if (/تكميلي/.test(hay)) {
                    var f = currentFilters();
                    if (f.month && f.teamId) {
                        toast('تحديث في العروض التكميلية — تُعاد القراءة', 'warn');
                        loadProposals();
                    }
                }
            }
        };
        es.onerror = function () {
            if (es.readyState === EventSource.CLOSED) { try { es.close(); } catch (_) { } state.es = null; }
        };
    }

    // ═══ الإقلاع ═══
    document.addEventListener('DOMContentLoaded', function () {
        $('monthInput').value = nextMonthValue();
        checkAccess().then(function (ok) {
            if (!ok) return;
            loadTeams();
            connectLive();
        });
        $('loadBtn').addEventListener('click', loadProposals);
        $('statusFilter').addEventListener('change', loadProposals);
        $('teamSelect').addEventListener('change', loadProposals);
        $('monthInput').addEventListener('change', loadProposals);
        $('generateBtn').addEventListener('click', generate);
        $('runClose').addEventListener('click', closeRun);
        $('runModal').addEventListener('click', function (e) { if (e.target === $('runModal')) closeRun(); });
        $('rowsBody').addEventListener('click', function (e) {
            var b = e.target.closest('[data-run]');
            if (b) { openRun(b.getAttribute('data-run')); return; }
            var w = e.target.closest('[data-withdraw]');
            if (w) withdraw(w.getAttribute('data-withdraw'));
        });
    });
})();
