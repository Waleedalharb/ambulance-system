/* ═══════════════════════════════════════════════════════════
   Smart Operator UI — طبقة عرض فقط (المرحلة 6-د)
   صفر حساب في الواجهة: كل قرار من Decision Engine، كل تحديث من
   الوعي التشغيلي (SSE smart_operator_update). المصدر الغائب = «—».
   ═══════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    // ─── المصادقة — نفس عقد المنصة (websocket-sync.js:60-85) ───
    function getToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken');
    }
    function authFetch(url, options) {
        var opts = options || {};
        opts.headers = Object.assign({ 'Authorization': 'Bearer ' + getToken() }, opts.headers || {});
        return fetch(url, opts).then(function (r) { return r.json(); });
    }

    // ─── خرائط عرض صرفة (ترجمة رموز المحرك إلى العربية — لا منطق) ───
    var STATUS_WORD = { stable: 'مستقر', attention: 'متابعة', critical: 'إجراء فوري' };
    var PHASE_WORD = { early: 'مبكرة', mid: 'وسطى', late: 'متأخرة', final: 'نهائية', unknown: 'غير معروفة' };
    var TONE_CLASS = { stable: 'tone-stable', attention: 'tone-attention', critical: 'tone-critical' };
    var SEV_CLASS = { critical: 'sev-critical', warning: 'sev-warning', info: 'sev-info' };
    var SEV_WORD = { critical: 'إجراء فوري', warning: 'متابعة', info: 'معلومة' };

    var ASK_CHIPS = [
        'من يحتاج دعمًا الآن؟', 'هل الجاهزية مقبولة؟', 'ما الخطر الحالي؟',
        'ما الذي يمنع الجاهزية الكاملة؟', 'ملخص المناوبة'
    ];

    // خرائط بنود التغيّر (SSE) إلى سطور تنفيذية عربية — عرض صرف
    function changeLines(changes) {
        var lines = [];
        if (!changes) return lines;
        (changes.risksRaised || []).forEach(function (r) { lines.push('خطر جديد: ' + r.title); });
        (changes.risksResolved || []).forEach(function (r) { lines.push('زال الخطر: ' + r.title); });
        (changes.severityChanges || []).forEach(function (s) {
            lines.push((s.team ? s.team + ' — ' : '') + 'تغيّرت الشدة من «' + (SEV_WORD[s.from] || s.from) + '» إلى «' + (SEV_WORD[s.to] || s.to) + '»');
        });
        if (changes.phaseChange) {
            lines.push('مرحلة المناوبة: من «' + (PHASE_WORD[changes.phaseChange.from] || PHASE_WORD.unknown) + '» إلى «' + (PHASE_WORD[changes.phaseChange.to] || PHASE_WORD.unknown) + '»');
        }
        if (changes.recommendationChanged) lines.push('تغيّرت التوصيات التشغيلية');
        return lines;
    }

    function el(tag, className, text) {
        var e = document.createElement(tag);
        if (className) e.className = className;
        if (text != null) e.textContent = text;
        return e;
    }

    var currentShiftId = null;

    // ─── نصوص الحالات الفارغة — صدق تشغيلي بلا شرطات عائمة ───
    var STANDBY = {
        summary: 'لا توجد مناوبة نشطة حاليًا — المنظومة في وضع الاستعداد',
        readinessWord: 'وضع الاستعداد',
        readinessNote: 'ستُعرض الجاهزية فور بدء المناوبة',
        shiftInfo: 'بانتظار بدء المناوبة',
        shiftDate: 'ستُعرض التفاصيل فور البدء',
        shiftPhase: 'لم تبدأ',
        support: 'سيُحسب عند بدء المناوبة',
        riskLine: 'لا مخاطر — لا توجد عمليات نشطة',
        actionsEmpty: 'لا إجراءات — ستظهر التوصيات التنفيذية هنا فور بدء المناوبة وتحليل حالة العمليات',
        timelineMain: 'لا أحداث تشغيلية مسجّلة بعد'
    };
    var LIVE_EMPTY = {
        riskLine: 'لا مخاطر نشطة — الوضع التشغيلي مستقر',
        actionsEmpty: 'لا توجد إجراءات مطلوبة — الوضع التشغيلي مستقر',
        timelineMain: 'لا أحداث بعد — ستُسجّل التغيّرات التشغيلية هنا تلقائيًا'
    };
    var TIMELINE_SUB = 'سيوثّق هذا الخط كل تغيّر تشغيلي ذي معنى أثناء المناوبة';

    // ─── العرض: التقييم الكامل ───
    function renderAssessment(a) {
        var standby = !a.shift; // تمييز استعداد/نشاط — تفرّع عرضي صرف، صفر حساب تشغيلي
        document.getElementById('standby-banner').hidden = !standby;

        var shiftId = a.shift ? a.shift.id : null;
        if (currentShiftId !== null && shiftId !== currentShiftId) {
            document.getElementById('ask-thread').innerHTML = ''; // تغيّرت المناوبة — يُمسح سجل الاستعلامات
        }
        currentShiftId = shiftId;

        // ① الملخص التنفيذي (المحرك يعيد جملة الاستعداد نفسها عند غياب المناوبة)
        fadeSwap('summary-text', a.summary || STANDBY.summary);

        // ② مؤشر الجاهزية + الحالة
        var readiness = a.readiness || {};
        var tone = TONE_CLASS[readiness.status] || '';
        var card = document.getElementById('readiness-card');
        card.classList.remove('tone-stable', 'tone-attention', 'tone-critical', 'tone-standby');
        card.classList.add(standby ? 'tone-standby' : (tone || 'tone-standby'));
        var pctEl = document.getElementById('readiness-percent');
        if (standby) {
            pctEl.classList.add('standby-note');
            fadeSwap('readiness-percent', STANDBY.readinessNote);
        } else {
            pctEl.classList.remove('standby-note');
            fadeSwap('readiness-percent', (typeof readiness.percent === 'number') ? readiness.percent + '٪' : 'الجاهزية قيد الحساب');
        }
        document.getElementById('readiness-word').textContent = standby ? STANDBY.readinessWord : (STATUS_WORD[readiness.status] || 'حالة غير متاحة');

        // بطاقات الحالة
        document.getElementById('shift-info').textContent = standby ? STANDBY.shiftInfo : (a.shift.type || 'مناوبة نشطة');
        document.getElementById('shift-date').textContent = standby ? STANDBY.shiftDate : (a.shift.date || 'تاريخ غير مسجّل');
        document.getElementById('shift-phase').textContent = standby ? STANDBY.shiftPhase : (PHASE_WORD[a.shiftPhase] || PHASE_WORD.unknown);
        // عدد الدعم المتاح يُلحق بالاستجابة بجانب مخرجات المحرك (إثراء إضافي في المسار — server.js)
        document.getElementById('support-count').textContent = standby ? STANDBY.support
            : ((typeof a.supportCount === 'number') ? String(a.supportCount) : 'غير متاح حاليًا');

        // شريط المخاطر — الفراغ حالة طبيعية لها نص صادق (استعداد/استقرار)
        var strip = document.getElementById('risks-strip');
        strip.innerHTML = '';
        var risks = a.risks || [];
        if (!risks.length) {
            strip.appendChild(el('span', 'risk-chip calm', standby ? STANDBY.riskLine : LIVE_EMPTY.riskLine));
        }
        risks.forEach(function (r) {
            strip.appendChild(el('span', 'risk-chip ' + (SEV_CLASS[r.severity] || ''), (r.team ? r.team + ' — ' : '') + r.title));
        });

        // ③ الإجراءات (أول 3 بترتيب المحرك نفسه)
        var list = document.getElementById('actions-list');
        list.innerHTML = '';
        var recs = (a.recommendations || []).slice(0, 3);
        if (!recs.length) {
            list.appendChild(el('div', 'empty-state', standby ? STANDBY.actionsEmpty : LIVE_EMPTY.actionsEmpty));
        }
        recs.forEach(function (rec, i) {
            var recCard = el('div', 'action-card p' + (rec.priority || 3));
            recCard.appendChild(el('div', 'action-priority', String(i + 1)));
            var body = el('div');
            var title = rec.title || 'توصية تشغيلية';
            body.appendChild(el('div', 'a-title', title));
            var risk = risks.filter(function (r) { return rec.target && r.team && r.team === rec.target.team; })[0];
            body.appendChild(el('div', 'a-reason', risk ? risk.detail : title));
            body.appendChild(el('div', 'a-do', rec.action || title));
            recCard.appendChild(body);
            list.appendChild(recCard);
        });

        // ④ الاستعداد — الخط الزمني يعود لحالته التمهيدية (لا سجلات بلا مناوبة)
        if (standby) renderTimelineEmpty(STANDBY.timelineMain);
    }

    function fadeSwap(id, text) {
        var e = document.getElementById(id);
        if (e.textContent === text) return;
        e.classList.add('fading');
        setTimeout(function () { e.textContent = text; e.classList.remove('fading'); }, 250);
    }

    // ─── العرض: الخط الزمني ───
    function renderTimeline(records) {
        var list = document.getElementById('timeline-list');
        list.innerHTML = '';
        if (!records.length) {
            renderTimelineEmpty(LIVE_EMPTY.timelineMain);
            return;
        }
        // الأحدث أولًا (الذاكرة مرتبة زمنيًا تصاعديًا — العرض يعكسها)
        records.slice().reverse().forEach(function (rec) {
            list.appendChild(timelineEntry(rec.recordedAt, rec.summary, rec.readiness ? rec.readiness.status : null));
        });
    }

    function renderTimelineEmpty(main) {
        var list = document.getElementById('timeline-list');
        list.innerHTML = '';
        var box = el('div', 'empty-state', main);
        box.appendChild(el('small', null, TIMELINE_SUB));
        list.appendChild(box);
    }

    function timelineEntry(at, line, status) {
        var entry = el('div', 'tl-entry');
        entry.appendChild(el('div', 'tl-time', window.TimeRiyadh ? TimeRiyadh.formatTime(at) : 'وقت غير متاح'));
        entry.appendChild(el('div', 'tl-marker ' + (TONE_CLASS[status] || '')));
        entry.appendChild(el('div', 'tl-line', line || 'تحديث تشغيلي'));
        return entry;
    }

    function prependTimelineFromEvent(ev) {
        var list = document.getElementById('timeline-list');
        var empty = list.querySelector('.empty-state');
        if (empty) empty.remove();
        var status = ev.readiness ? ev.readiness.status : null;
        changeLines(ev.changes).forEach(function (line) {
            list.insertBefore(timelineEntry(ev.at, line, status), list.firstChild);
        });
    }

    // ─── الجلب الأولي ───
    function loadInitial() {
        return authFetch('/api/smart-operator/assessment').then(function (r) {
            if (r && r.success && r.data) {
                renderAssessment(r.data);
                if (r.data.shift && r.data.shift.id != null) {
                    return authFetch('/api/smart-operator/memory?shiftId=' + r.data.shift.id + '&limit=15')
                        .then(function (m) {
                            if (m && m.success && Array.isArray(m.records)) renderTimeline(m.records);
                        });
                }
            }
        }).catch(function (err) { console.error('Initial load failed:', err); });
    }

    // ─── الوعي اللحظي — قناة SSE الواحدة، نوع واحد فقط يُعالج ───
    function connectSSE() {
        var token = getToken();
        if (!token) { setConn(false); return; }
        var es = new EventSource('/api/sse?token=' + encodeURIComponent(token));
        var dot = document.getElementById('conn-dot');
        es.onopen = function () { setConn(true); };
        es.onerror = function () { setConn(false); };
        es.onmessage = function (event) {
            var data;
            try { data = JSON.parse(event.data); } catch (_) { return; }
            if (!data || data.type !== 'smart_operator_update') return; // كل الأنواع الأخرى تُتجاهل
            fadeSwap('summary-text', data.summary || STANDBY.summary);
            prependTimelineFromEvent(data);
            loadInitial(); // إعادة قراءة التقييم الكامل — الحقول المرجعية من المصدر نفسه
        };
        function setConn(on) {
            dot.classList.toggle('online', !!on);
            dot.classList.toggle('offline', !on);
            document.getElementById('conn-label').textContent = on ? 'متصل' : 'منقطع';
        }
    }

    // ─── ⑤ الاستعلام التشغيلي — اختصارات تنفيذية + بطاقات إحاطة ───
    function setupAsk() {
        var chips = document.getElementById('ask-chips');
        ASK_CHIPS.forEach(function (q) {
            var btn = el('button', 'ask-shortcut', q);
            btn.type = 'button';
            btn.addEventListener('click', function () { ask(q); });
            chips.appendChild(btn);
        });
        document.getElementById('ask-form').addEventListener('submit', function (e) {
            e.preventDefault();
            var input = document.getElementById('ask-input');
            var q = input.value.trim();
            if (q) { input.value = ''; ask(q); }
        });
    }

    // الإجابات تُعرض كبطاقات إحاطة (عنوان الاستعلام + نص الإجابة) — الأحدث أولًا
    function ask(question) {
        var thread = document.getElementById('ask-thread');
        var card = el('div', 'brief-card');
        card.appendChild(el('div', 'bc-title', question));
        var body = el('div', 'bc-body');
        var pending = el('span', 'bc-pending');
        pending.appendChild(el('span', 'bc-dot'));
        pending.appendChild(document.createTextNode('جارٍ المعالجة…'));
        body.appendChild(pending);
        card.appendChild(body);
        thread.insertBefore(card, thread.firstChild);
        var btn = document.getElementById('ask-send');
        btn.disabled = true;
        authFetch('/api/smart-operator/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ question: question })
        }).then(function (r) {
            body.textContent = (r && r.success && r.data && r.data.text) ? r.data.text : 'تعذّرت الإجابة حاليًا';
        }).catch(function () {
            body.textContent = 'تعذّر الاتصال بالمشغل الذكي';
        }).finally(function () {
            btn.disabled = false;
        });
    }

    // ─── الإقلاع ───
    if (!getToken()) { window.location.href = '/'; return; } // نفس سلوك الصفحات المحمية
    setupAsk();
    loadInitial();
    connectSSE();
})();
