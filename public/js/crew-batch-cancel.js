/* ═══ crew-batch-cancel.js — الاختيار الجماعي لفرق البلاغ في «توزيع البلاغات» (اعتماد المالك 2026-08-25) ═══
   المشكلة: إلغاء فرق متعددة من نفس البلاغ كان يتطلب إلغاءً فرديًا + تحديثًا كاملًا
   بعد كل فرقة. الحل واجهة صرفة فوق نفس مسار الحماية القائم:
     • وضع تحديد لكل بطاقة بلاغ: checkboxes على الفرق + شريط أدوات.
     • «تحديد الكل» يحدد كل الفرق الظاهرة غير الملغاة أصلًا (بما فيها الفعلية —
       قرار المالك: أسرع في البلاغات الملوثة، والمستخدم يستثني ما يريد إبقاءه).
     • تأكيد واحد للعملية كاملة (نفس نمط الإلغاء الفردي — سبب واحد موحد).
     • التنفيذ عبر نفس endpoint الفردي /crews/:unit/cancel لكل فرقة — لا تجاوز
       لأي حماية ولا منطق احتساب ولا تعديل خادم: نفس الصلاحية ونفس التدقيق.
     • بلا إعادة رسم أثناء التنفيذ: عدّاد تقدم مباشر، وإعادة رسم واحدة في
       النهاية مع بقاء الموضع، ونتيجة صادقة (نجاح/كانت ملغاة/فشل بالأسماء).
   لا يُمس: isParticipationCounted ولا المنجزات ولا الخريطة ولا CAD الأصلي. */
(function () {
    'use strict';

    /* الحالة تعيش خارج إعادة الرسم: لكل بلاغ {active, selected:Set, running} */
    var state = {};
    /* آخر قائمة فرق معروفة لكل بلاغ (تُحدَّث عند رسم أدوات البطاقة) */
    var lastCrews = {};

    function esc(s) { return String(s).replace(/'/g, "\\'"); }
    function canDispatch() {
        var s = window.__opsPermsState;
        return !!(s && s.loaded && (s.star || (s.perms || []).indexOf('ops.dispatch') !== -1));
    }
    function st(number) { return state[number] || null; }
    function el(id) { return document.getElementById(id); }
    function refresh() {
        // إعادة رسم واحدة مع بقاء الموضع قدر الإمكان (طلب المالك)
        var y = window.scrollY;
        var p = (typeof window.renderAdvancedDistribution === 'function') ? window.renderAdvancedDistribution() : null;
        Promise.resolve(p).then(function () { try { window.scrollTo(0, y); } catch (_) { } });
        return p;
    }
    function updateCounter(number) {
        var s = st(number);
        var c = el('cbc-count-' + number), b = el('cbc-run-' + number);
        var n = s ? s.selected.size : 0;
        if (c) c.textContent = 'المحدد: ' + n;
        if (b) { b.textContent = '🚫 حذف المحدد (' + n + ')'; b.disabled = !n || (s && s.running); }
    }

    var api = {
        isActive: function (number) { var s = st(number); return !!(s && s.active); },
        isSelected: function (number, unit) { var s = st(number); return !!(s && s.selected.has(unit)); },

        /* checkbox داخل شارة الفرقة — يظهر فقط في وضع التحديد (يُستدعى من renderer) */
        chipCheckboxHtml: function (number, unit) {
            if (!api.isActive(number)) return '';
            return '<input type="checkbox" data-cbc="' + esc(number) + '" data-unit="' + esc(unit) + '"' +
                (api.isSelected(number, unit) ? ' checked' : '') +
                ' onclick="CrewBatchCancel.toggleUnit(\'' + esc(number) + '\', \'' + esc(unit) + '\', this)"' +
                ' style="margin-left:4px; vertical-align:middle; cursor:pointer;" title="تحديد للإلغاء الجماعي">';
        },

        /* زر تفعيل الوضع + شريط الأدوات داخل بطاقة البلاغ (يُستدعى من renderer) */
        incidentControlsHtml: function (ic) {
            if (!canDispatch()) return '';
            var number = ic.number;
            // الفرق القابلة للتحديد: الظاهرة غير الملغاة يدويًا أصلًا (الملغاة لا تحتاج إجراء)
            lastCrews[number] = (ic.crews || []).filter(function (c) { return !c.manualCancelled; }).map(function (c) { return c.unit; });
            if (!lastCrews[number].length) return '';
            var s = st(number);
            if (!s || !s.active) {
                return ' <button onclick="CrewBatchCancel.toggleMode(\'' + esc(number) + '\')" title="وضع التحديد الجماعي — إلغاء عدة فرق دفعة واحدة بتحديث واحد"' +
                    ' style="background:none; border:1px dashed rgba(46,139,122,.5); border-radius:6px; color:#2E8B7A; cursor:pointer; font-size:.72rem; padding:1px 8px; margin-right:6px;">☑ تحديد</button>';
            }
            return '<div id="cbc-bar-' + esc(number) + '" style="display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin:6px 0 2px; padding:5px 8px;' +
                ' background:rgba(46,139,122,.07); border:1px dashed rgba(46,139,122,.4); border-radius:8px; font-size:.78rem;">' +
                '<button onclick="CrewBatchCancel.selectAll(\'' + esc(number) + '\')" style="background:none;border:1px solid rgba(46,139,122,.5);border-radius:6px;color:#2E8B7A;cursor:pointer;padding:1px 8px;">تحديد الكل</button>' +
                '<button onclick="CrewBatchCancel.clearSelection(\'' + esc(number) + '\')" style="background:none;border:1px solid rgba(148,163,184,.5);border-radius:6px;color:#94A3B8;cursor:pointer;padding:1px 8px;">إلغاء تحديد الكل</button>' +
                '<span id="cbc-count-' + esc(number) + '" style="font-weight:700; color:#2E8B7A;">المحدد: ' + s.selected.size + '</span>' +
                '<button id="cbc-run-' + esc(number) + '" onclick="CrewBatchCancel.run(\'' + esc(number) + '\')"' + (s.selected.size && !s.running ? '' : ' disabled') +
                ' style="background:#EF4444;border:none;border-radius:6px;color:#fff;cursor:pointer;padding:2px 12px;font-weight:700;">🚫 حذف المحدد (' + s.selected.size + ')</button>' +
                '<span id="cbc-prog-' + esc(number) + '" style="opacity:.75;"></span>' +
                '<button onclick="CrewBatchCancel.toggleMode(\'' + esc(number) + '\')" title="الخروج من وضع التحديد" style="background:none;border:none;color:#94A3B8;cursor:pointer;">✖ خروج</button>' +
                '</div>';
        },

        toggleMode: function (number) {
            var s = st(number);
            if (s && s.active) { delete state[number]; } // خروج: يمسح التحديد
            else state[number] = { active: true, selected: new Set(), running: false };
            refresh();
        },
        toggleUnit: function (number, unit, input) {
            var s = st(number); if (!s || s.running) return;
            if (s.selected.has(unit)) s.selected.delete(unit); else s.selected.add(unit);
            if (input) input.checked = s.selected.has(unit);
            updateCounter(number); // تحديث مباشر — بلا إعادة رسم إطلاقًا
        },
        selectAll: function (number) {
            var s = st(number); if (!s || s.running) return;
            (lastCrews[number] || []).forEach(function (u) { s.selected.add(u); }); // قرار المالك: الكل بما فيهم الفعلية — المستخدم يستثني يدويًا
            var boxes = document.querySelectorAll('input[data-cbc="' + number + '"]');
            for (var i = 0; i < boxes.length; i++) boxes[i].checked = true;
            updateCounter(number);
        },
        clearSelection: function (number) {
            var s = st(number); if (!s || s.running) return;
            s.selected.clear();
            var boxes = document.querySelectorAll('input[data-cbc="' + number + '"]');
            for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
            updateCounter(number);
        },

        /* التنفيذ الجماعي: تأكيد واحد + نفس endpoint الفردي لكل فرقة + رسمة واحدة */
        run: async function (number) {
            var s = st(number);
            if (!s || !s.active || s.running || !s.selected.size) return;
            var units = Array.from(s.selected);
            var reason = window.prompt(
                'إلغاء تسجيل ' + units.length + ' فرقة من البلاغ ' + number + ' دفعة واحدة؟\n' +
                'ستُستبعد الفرق المحددة فورًا من جميع العدّادات والمؤشرات، وتبقى سجلاتها محفوظة في التاريخ والتدقيق.\n\n' +
                'سبب الإلغاء الموحد (اختياري):', '');
            if (reason === null) return; // ألغى المستخدم العملية كاملة
            s.running = true;
            var prog = el('cbc-prog-' + number), runBtn = el('cbc-run-' + number);
            if (runBtn) runBtn.disabled = true;
            var ok = [], already = [], failed = [];
            for (var i = 0; i < units.length; i++) {
                var unit = units[i];
                if (prog) prog.textContent = 'جارٍ الإلغاء… ' + (i + 1) + '/' + units.length + ' (' + unit + ')';
                try {
                    var res = await AuthManager.apiRequest(
                        '/api/cad-reports/' + encodeURIComponent(number) + '/crews/' + encodeURIComponent(unit) + '/cancel',
                        { method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ reason: (reason || '').trim() || null }) });
                    var data = await res.json().catch(function () { return {}; });
                    if (res.ok && data.success) (data.already ? already : ok).push(unit);
                    else failed.push({ unit: unit, error: data.error || ('HTTP ' + res.status) });
                } catch (e) {
                    failed.push({ unit: unit, error: 'تعذر الاتصال بالخادم' });
                }
            }
            delete state[number]; // انتهى الوضع — التحديد لا يبقى معلقًا
            await refresh(); // ⭐ إعادة رسم واحدة فقط بعد اكتمال الدفعة كلها
            // النتيجة بصدق: لا «نجاح كامل» إذا فشل أي عنصر (طلب المالك صراحة)
            var msg = '🚫 أُلغي تسجيل ' + ok.length + ' فرقة من البلاغ ' + number +
                (already.length ? ' · ' + already.length + ' كانت ملغاة أصلًا' : '');
            if (failed.length) {
                msg += ' · ❌ فشل ' + failed.length + ': ' + failed.map(function (f) { return f.unit + ' (' + f.error + ')'; }).join('، ');
                if (typeof showToast === 'function') showToast(msg, 'error'); else alert(msg);
            } else if (typeof showToast === 'function') showToast(msg, 'success');
        }
    };

    window.CrewBatchCancel = api;
})();
