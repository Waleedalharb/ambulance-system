/* ============================================================
   الخريطة التشغيلية الذكية — SmartMap (إعادة البناء المعتمدة)
   قراءة فقط: كل البيانات من /api/cad-reports و /api/staffing/state
   ومن الجداول الثابتة operationalCenters / teamCenterMap في app.js.
   لا منطق تشغيلي هنا، لا اشتقاق، لا إحداثيات مختلقة، لا مصادر جديدة.
   التمييز البصري القاطع: 🚑 فرقة · 🏥 مركز · 📍 بلاغ.
   ============================================================ */
(function () {
    'use strict';

    var map = null;
    var layers = null;          // layerGroups لكل نوع
    var markerIndex = null;     // { incidents:{num:mk}, teams:{name:mk}, centers:{name:mk} }
    var state = { summary: null, teams: null };
    var fitMode = 0;            // 0=لم يُضبط · 1=الفرق · 2=البلاغات (البلاغات تتقدم دائمًا)
    var lastFit = null;         // آخر نقاط ضُبط عليها العرض — لإعادة الضبط بعد تغيّر حجم الحاوية
    var resizeTimer = null;
    var wired = false;
    var focus = null;           // { kind:'incident'|'team'|'center', key:string }
    var focusLines = null;      // layerGroup لخطوط التركيز
    var layersOn = { incidents: true, teams: true, centers: true, hot: false, heat: false, streets: false, peak: false };

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function typeDef(t) {
        var defs = (typeof REPORT_TYPE_DEFS !== 'undefined') ? REPORT_TYPE_DEFS : null;
        return (defs && defs[t]) || { emoji: '📦', label: t || 'حالات أخرى', color: '#8B5CF6' };
    }
    function crewStatusLabel(c) {
        var ph = c.phases || {};
        if (c.counted === false) return { cls: 'st-cancelled', lbl: 'لم تتحرك' };
        if (ph['العلاج']) return { cls: 'st-done', lbl: 'مباشرة' };
        if (ph['البحث']) return { cls: 'st-arrived', lbl: 'وصلت' };
        if (ph['التحرك']) return { cls: 'st-enroute', lbl: 'في الطريق' };
        if (ph['قبول']) return { cls: 'st-enroute', lbl: 'قبلت' };
        return { cls: 'st-cancelled', lbl: 'بلا أزمنة بعد' };
    }

    // ============================================================
    // نظام التنبيه التشغيلي (قرار المالك 2026-08-21 · إعادة البناء 2026-08-25)
    // مصدر القرار: js/alert-rules.js (موديول نقي مختبَر برمجيًا) — محرك
    // الأزمنة الموحد: 4 مراحل مستقلة (وصول/مباشرة/موقع/منشأة) + تصنيف
    // A/B/C/D/E من proQACode. لا تنبيه ولا مؤقت إلا بحدث CAD فعلي.
    // هذه الطبقة عرض فقط.
    // ============================================================
    var AR = (typeof AlertRules !== 'undefined') ? AlertRules : null;
    var alertsCache = [];
    var cardTimers = [];        // مؤقتات البطاقة المفتوحة {id, startMin, limit}
    var tickerOn = false;

    function cadMin(str) { return AR ? AR.cadMin(str) : null; }
    function cadDiff(fromMin, toMin) { return AR.cadDiff(fromMin, toMin); }
    function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
    function fmtTimer(minFloat) {
        var neg = minFloat < 0; if (neg) minFloat = -minFloat;
        var m = Math.floor(minFloat), s = Math.floor((minFloat - m) * 60);
        return (neg ? '-' : '') + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    // بوابة أهلية التنبيه الصارمة: حدث «التحرك» الفعلي من CAD — لا مجرد ارتباط بالبلاغ
    function crewAlertable(c) { return AR ? AR.hasMovement(c.phases) : false; }

    // حساب التنبيهات — القرار كله في AlertRules (مختبَر في scripts/alert-rules-test.js)
    function computeAlerts() {
        if (!AR) return []; // القواعد غير محمّلة ← لا تنبيهات مخترعة بصدق
        return AR.computeAlerts(state.summary, nowMin());
    }

    var alertBarClosed = false; // إغلاق يدوي للعرض فقط — الحالة تبقى في KPI والشارة (§11)
    function alertBadgeEl() {
        var wrap = document.querySelector('.ops-map-wrap');
        if (!wrap) return null;
        var b = document.getElementById('smkAlertBadge');
        if (!b) {
            b = document.createElement('button');
            b.type = 'button'; b.id = 'smkAlertBadge'; b.className = 'smk-alertbadge';
            b.title = 'حالات قائمة — اضغط لإظهار تفاصيل التنبيهات';
            b.style.display = 'none';
            b.addEventListener('click', function () { alertBarClosed = false; renderAlerts(); });
            wrap.appendChild(b);
        }
        return b;
    }

    function renderAlerts() {
        alertsCache = computeAlerts();
        var over = alertsCache.filter(function (a) { return a.level === 'over'; });
        var near = alertsCache.filter(function (a) { return a.level === 'near'; });

        // تنبيهات احتمال التكرار (اعتماد المالك 2026-08-24 — ملحق note-18): طبقة عرض
        // مستقلة فوق التنبيه التشغيلي — «احتمال تكرار — يحتاج تحقق» فقط؛ لا دمج
        // ولا إلغاء ولا سجل مراجعة، والقرار في CAD حصرًا. النشطة فقط تُنبِّه.
        var dupRows = [];
        if (state.summary && state.summary.incidents) {
            state.summary.incidents.forEach(function (ic) {
                if (isFinalInc(ic) || !ic.duplicates || !ic.duplicates.length) return;
                var top = ic.duplicates[0]; // مرتبة سيرفريًا: الأعلى نقاطًا ثم الأقرب
                dupRows.push({ number: String(ic.number), level: top.level, count: ic.duplicates.length });
            });
            var lvlRank = { high: 3, medium: 2, low: 1 };
            dupRows.sort(function (x, y) { return (lvlRank[y.level] || 0) - (lvlRank[x.level] || 0); });
        }

        // KPI الحالات الحرجة
        var kpiEl = document.getElementById('smapKpiAlerts');
        if (kpiEl) {
            kpiEl.textContent = String(over.length);
            kpiEl.className = 'smap-kpi-v ' + (over.length ? 'sev-red' : 'sev-green');
        }

        // شريط التنبيه بزاوية الخريطة — قابل للإغلاق؛ الإغلاق يخفي العرض فقط (§11)
        var bar = document.getElementById('smkAlertBar');
        var badge = alertBadgeEl();
        var totalAlerts = alertsCache.length + dupRows.length;
        if (bar) {
            if (!totalAlerts) {
                bar.style.display = 'none'; bar.className = 'smk-alertbar';
                if (badge) badge.style.display = 'none';
            } else if (alertBarClosed) {
                // الموظف أغلق العرض — تبقى شارة الزاوية الصغيرة والمؤشرات بحالتها
                bar.style.display = 'none';
                if (badge) {
                    badge.textContent = (over.length ? '🔴 ' : (dupRows.length ? '⚠️ ' : '🟠 ')) + totalAlerts;
                    badge.className = 'smk-alertbadge' + (over.length ? '' : ' warn');
                    badge.style.display = 'inline-flex';
                }
            } else {
                if (badge) badge.style.display = 'none';
                var shown = alertsCache.slice(0, 3); // لا إزعاج بعشرات الحالات
                var html = '';
                if (alertsCache.length) {
                    html += '<div class="smk-alertbar-head ' + (over.length ? 'crit' : 'warn') + '">'
                        + (over.length ? '🔴 <b>' + over.length + '</b> ' + (over.length === 1 ? 'حالة تحتاج' : 'حالات تحتاج') + ' تدخلًا' : '🟠 ' + near.length + ' قريبة من تجاوز الحد')
                        + (alertsCache.length > 3 ? '<span class="more">+' + (alertsCache.length - 3) + '</span>' : '')
                        + '<button type="button" class="smk-alertbar-close" title="إغلاق العرض — تبقى الحالة في المؤشرات" onclick="SmartMap.dismissAlerts()"><i class="fas fa-xmark"></i></button></div>';
                    html += shown.map(function (a) {
                        // §9/§10 (اعتماد 2026-08-25): سبب التنبيه كاملًا — المرحلة + التصنيف
                        // (🚨 Echo — مهدد للحياة) + الهدف + الفعلي + التجاوز. لا تنبيه عام بلا سبب.
                        var clsTxt = a.classification
                            ? (a.classification.critical ? '🚨 Echo — مهدد للحياة' : a.classification.name + ' — ' + a.classification.label)
                            : 'بلا تصنيف CAD';
                        var key = esc(a.number) + '|' + esc(a.unit);
                        return '<button type="button" class="smk-alert-row ' + a.level + '" onclick="SmartMap.focusOn(\'incident\',\'' + esc(a.number) + '\')">'
                            + '<span class="u"><i class="fas fa-truck-medical"></i> ' + esc(a.unit) + '</span>'
                            + '<span class="s">' + AR.STAGE_TXT[a.stage] + ' · <b>' + esc(clsTxt) + '</b></span>'
                            + '<span class="t" data-alert-timer="' + key + '">' + fmtTimer(a.elapsed) + '</span>'
                            + '<small class="smk-alert-sub" data-alert-sub="' + key + '">الهدف ' + a.target + ' د'
                            + (a.level === 'over' ? ' · التجاوز +' + fmtTimer(a.overdue) : '') + '</small>'
                            + '</button>';
                    }).join('');
                }
                if (dupRows.length) {
                    // رأس القسم يحمل زر الإغلاق عندما لا توجد تنبيهات تشغيلية فوقه
                    html += '<div class="smk-alertbar-head dup">⚠️ <b>' + dupRows.length + '</b> ' + (dupRows.length === 1 ? 'بلاغ يحتمل' : 'بلاغات يحتمل') + ' أن تكون مكررة — تحتاج تحققًا في CAD'
                        + (alertsCache.length ? '' : '<button type="button" class="smk-alertbar-close" title="إغلاق العرض — تبقى الحالة في المؤشرات" onclick="SmartMap.dismissAlerts()"><i class="fas fa-xmark"></i></button>')
                        + '</div>';
                    html += dupRows.slice(0, 3).map(function (d) {
                        return '<button type="button" class="smk-alert-row dup" onclick="SmartMap.focusOn(\'incident\',\'' + esc(d.number) + '\')">'
                            + '<span class="u"><i class="fas fa-clone"></i> بلاغ ' + esc(d.number) + '</span>'
                            + '<span class="s">' + (d.level === 'high' ? 'اشتباه قوي' : d.level === 'medium' ? 'اشتباه متوسط' : 'اشتباه أولي') + (d.count > 1 ? ' · ' + d.count + ' مرشحين' : '') + '</span>'
                            + '</button>';
                    }).join('');
                }
                bar.innerHTML = html;
                bar.style.display = 'block';
                bar.className = 'smk-alertbar ' + (over.length ? 'has-crit' : 'has-warn');
            }
        }

        // هالة التنبيه على علامات الفرق والبلاغات (فوق لون الحالة — لا يغيّرها)
        var alertTeams = {}, alertIncs = {};
        alertsCache.forEach(function (a) {
            if (a.level === 'over') { alertTeams[a.unit] = 'over'; alertIncs[a.number] = 'over'; }
            else { if (!alertTeams[a.unit]) alertTeams[a.unit] = 'near'; if (!alertIncs[a.number]) alertIncs[a.number] = 'near'; }
        });
        if (markerIndex) {
            for (var u in markerIndex.teams) {
                var el = markerIndex.teams[u].getElement && markerIndex.teams[u].getElement();
                if (!el) continue;
                el.classList.remove('smk-alert-over', 'smk-alert-near');
                if (alertTeams[u]) el.classList.add(alertTeams[u] === 'over' ? 'smk-alert-over' : 'smk-alert-near');
            }
            for (var n in markerIndex.incidents) {
                var el2 = markerIndex.incidents[n].getElement && markerIndex.incidents[n].getElement();
                if (!el2) continue;
                el2.classList.remove('smk-alert-over', 'smk-alert-near');
                if (alertIncs[n]) el2.classList.add(alertIncs[n] === 'over' ? 'smk-alert-over' : 'smk-alert-near');
            }
        }
    }

    // نبضة حية: تحديث نصوص المؤقتات كل ثانية + إعادة حساب التنبيهات كل 5 ثوانٍ
    function startTicker() {
        if (tickerOn) return;
        tickerOn = true;
        var tick = 0;
        setInterval(function () {
            tick++;
            // إعادة الحساب الكاملة كل 5 ثوانٍ (الشريط + الهالات)،
            // وتحديث نصوص المؤقتات (شريط + بطاقة) كل ثانية
            if (tick % 5 === 0) renderAlerts();
            refreshCardTimers();
        }, 1000);
    }
    // تحديث قيم المؤقتات المعروضة (شريط + بطاقة) دون إعادة بناء DOM
    function refreshCardTimers() {
        var now = nowMin();
        for (var i = 0; i < cardTimers.length; i++) {
            var ct = cardTimers[i];
            var el = document.getElementById(ct.id);
            if (!el) continue;
            if (ct.frozenMin !== null && ct.frozenMin !== undefined) { el.textContent = fmtTimer(ct.frozenMin); continue; }
            var elapsed = cadDiff(ct.startMin, now);
            el.textContent = fmtTimer(elapsed);
            var over = elapsed > ct.limit;
            el.classList.toggle('over', over);
            el.classList.toggle('near', !over && elapsed >= ct.limit * 0.8);
            var ov = document.getElementById(ct.id + '-ov');
            if (ov) {
                ov.style.display = over ? '' : 'none';
                if (over) ov.textContent = 'تجاوز +' + fmtTimer(elapsed - ct.limit);
            }
        }
        // نصوص شريط التنبيه (الفعلي + التجاوز) — بداية المرحلة من المحرك نفسه (startAt)
        var spans = document.querySelectorAll('[data-alert-timer]');
        for (var s = 0; s < spans.length; s++) {
            var parts = spans[s].getAttribute('data-alert-timer').split('|');
            for (var j = 0; j < alertsCache.length; j++) {
                var a = alertsCache[j];
                if (a.number !== parts[0] || a.unit !== parts[1]) continue;
                var startMin = cadMin(a.startAt);
                if (startMin === null) break;
                var live = cadDiff(startMin, now);
                spans[s].textContent = fmtTimer(live);
                var sub = document.querySelector('[data-alert-sub="' + parts[0] + '|' + parts[1] + '"]');
                if (sub) sub.textContent = 'الهدف ' + a.target + ' د' + (live > a.target ? ' · التجاوز +' + fmtTimer(live - a.target) : '');
                break;
            }
        }
    }
    function teamSev(t) {
        if (!t) return 'yellow';
        if (t.status === 'missing' || t.status === 'offline' || t.vehicleOk === false) return 'red';
        if (t.status === 'pending') return 'yellow';
        return 'green';
    }
    function teamStatusText(t) {
        if (!t) return '—';
        if (t.status === 'ready') return 'جاهزة';
        if (t.status === 'missing') return 'ناقصة';
        if (t.status === 'offline') return 'خارج الخدمة';
        return 'بانتظار قرار التكميل';
    }
    // صف مؤقت مرحلة داخل بطاقة البلاغ: قيمة حية (أو مجمّدة للمرحلة المكتملة) + حد + شارة تجاوز
    function timerRow(incNum, unit, stage, label, startMin, frozenMin, limit) {
        var id = 'smkTm-' + String(incNum).replace(/[^\d]/g, '') + '-' + String(unit).replace(/[^\dA-Za-z\u0600-\u06FF]/g, '') + '-' + stage;
        cardTimers.push({ id: id, startMin: startMin, limit: limit, frozenMin: frozenMin });
        var val = (frozenMin !== null && frozenMin !== undefined) ? frozenMin : cadDiff(startMin, nowMin());
        var cls = val > limit ? 'over' : (val >= limit * 0.8 ? 'near' : '');
        var ovTxt = val > limit ? 'تجاوز +' + fmtTimer(val - limit) : '';
        return '<div class="smk-timer-row"><span class="smk-timer-l">' + label + ' <small>(الحد ' + limit + ' د)</small></span>'
            + '<span class="smk-timer-v ' + cls + '" id="' + id + '">' + fmtTimer(val) + '</span>'
            + '<small class="smk-timer-over" id="' + id + '-ov"' + (ovTxt ? '' : ' style="display:none"') + '>' + ovTxt + '</small></div>';
    }
    function hasCoords(ic) {
        return ic && ic.lat !== null && ic.lat !== undefined && ic.lng !== null && ic.lng !== undefined;
    }
    // البلاغ النهائي (مغلق/ملغى) خارج الخريطة النشطة تمامًا (قرار المالك 2026-08-22):
    // لا علامة ولا كثافة ولا موقع ساخن ولا ارتباط بفرقة — يبقى تاريخيًا في الإحصائيات
    function isFinalInc(ic) { return (AR && AR.isFinal) ? AR.isFinal(ic && ic.status) : false; }
    // موقع عرض الفرقة = حلقة صغيرة حول مركزها (تموضع عرضي بحت — لا GPS للفرق)
    function teamPosition(unit, centerName) {
        var base = operationalCenters[centerName];
        if (!base) return null;
        var siblings = [];
        for (var u in teamCenterMap) {
            if (teamCenterMap.hasOwnProperty(u) && teamCenterMap[u] === centerName && state.teams && state.teams[u]) siblings.push(u);
        }
        siblings.sort();
        var idx = siblings.indexOf(unit);
        if (siblings.length <= 1 || idx < 0) return [base[0], base[1]];
        var ang = (2 * Math.PI * idx) / siblings.length;
        return [base[0] + 0.0011 * Math.cos(ang), base[1] + 0.0011 * Math.sin(ang)];
    }
    function teamCenter(unit) { return teamCenterMap[unit] || null; }
    function centerTeams(centerName) {
        var out = [];
        if (!state.teams) return out;
        for (var u in teamCenterMap) {
            if (teamCenterMap.hasOwnProperty(u) && teamCenterMap[u] === centerName && state.teams[u]) out.push(u);
        }
        return out.sort();
    }
    function linkedIncidentForTeam(unit) {
        if (!state.summary || !state.summary.incidents) return null;
        var incs = state.summary.incidents;
        for (var i = incs.length - 1; i >= 0; i--) { // الأحدث أولًا
            if (isFinalInc(incs[i])) continue; // البلاغ النهائي لا يُظهر فرقة كأنها ما زالت مرتبطة به
            var crews = incs[i].crews || [];
            for (var j = 0; j < crews.length; j++) {
                if (crews[j].unit === unit && crews[j].counted !== false) return incs[i];
            }
        }
        return null;
    }

    // ---------- الإقلاع ----------
    function init() {
        if (map) return true;
        var el = document.getElementById('opsMap');
        if (!el) return false;
        if (typeof L === 'undefined') {
            var note0 = document.getElementById('opsMapTileNote');
            if (note0) { note0.style.display = 'block'; note0.innerHTML = '<i class="fas fa-triangle-exclamation"></i> تعذّر تحميل مكتبة الخرائط'; }
            return false;
        }
        map = L.map('opsMap', { scrollWheelZoom: false, attributionControl: true }).setView([24.7136, 46.6753], 12);
        map.on('click', function () { map.scrollWheelZoom.enable(); });
        map.on('mouseout', function () { map.scrollWheelZoom.disable(); });
        var tiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd', maxZoom: 19
        });
        tiles.on('tileerror', function () {
            var note = document.getElementById('opsMapTileNote');
            if (note) note.style.display = 'block';
        });
        tiles.addTo(map);

        layers = {
            centers: L.layerGroup().addTo(map),
            teams: L.layerGroup().addTo(map),
            incidents: L.layerGroup().addTo(map),
            hot: L.layerGroup(),
            streets: L.layerGroup(),
            heat: (typeof L.heatLayer === 'function') ? L.heatLayer([], { radius: 28, blur: 22, maxZoom: 16, minOpacity: 0.25 }) : null
        };
        // اكتشاف احتمال التكرار (اعتماد المالك 2026-08-24 — ملحق note-18): طبقة
        // خطوط الربط البصري بين البلاغ والمرشحين — عرض فقط فوق البيانات الحالية
        layers.dupLinks = L.layerGroup().addTo(map);
        focusLines = L.layerGroup().addTo(map);
        markerIndex = { incidents: {}, teams: {}, centers: {} };

        map.on('click', function () { clearFocus(); closeCard(); });
        wireOnce();
        startTicker(); // نبضة التنبيهات الحية (كل ثانية)
        // استقرار أولي: الحاوية داخل شبكة الصفحة قد يتأخر حجمها النهائي عن التهيئة
        [150, 600, 1500].forEach(function (ms) { setTimeout(onMapResize, ms); });
        return true;
    }

    function wireOnce() {
        if (wired) return;
        wired = true;
        var exBtn = document.getElementById('smapExpandBtn');
        if (exBtn) exBtn.addEventListener('click', toggleExpand);
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var s = document.getElementById('opsMapSection');
            if (focus) { clearFocus(); closeCard(); return; }
            if (s && s.classList.contains('smap-expanded')) toggleExpand();
        });
        var chipMap = {
            smapLayerTeams: 'teams', smapLayerIncidents: 'incidents', smapLayerCenters: 'centers',
            smapLayerHot: 'hot', smapLayerHeat: 'heat', smapLayerStreets: 'streets'
        };
        for (var id in chipMap) {
            if (!chipMap.hasOwnProperty(id)) continue;
            (function (chipId, which) {
                var ch = document.getElementById(chipId);
                if (ch) ch.addEventListener('click', function () { toggleLayer(ch, which); });
            })(id, chipMap[id]);
        }
        var chP = document.getElementById('smapLayerPeak');
        if (chP) chP.addEventListener('click', function () {
            layersOn.peak = !layersOn.peak;
            chP.classList.toggle('active', layersOn.peak);
            var pop = document.getElementById('smapPeakPop');
            if (pop) pop.style.display = layersOn.peak ? 'block' : 'none';
        });
        // استقرار الحجم: مراقبة حاوية الخريطة نفسها + نافذة المتصفح
        window.addEventListener('resize', onMapResize);
        var mapEl = document.getElementById('opsMap');
        if (mapEl && typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(onMapResize).observe(mapEl);
        }
    }

    function toggleLayer(btn, which) {
        if (!map || !layers) return;
        var layer = layers[which];
        if (!layer) return;
        layersOn[which] = !layersOn[which];
        btn.classList.toggle('active', layersOn[which]);
        if (layersOn[which]) layer.addTo(map);
        else {
            map.removeLayer(layer);
            if (which === 'incidents' && focus && focus.kind === 'incident') { clearFocus(); closeCard(); }
            if (which === 'teams' && focus && focus.kind === 'team') { clearFocus(); closeCard(); }
            if (which === 'centers' && focus && focus.kind === 'center') { clearFocus(); closeCard(); }
        }
    }

    // ---------- مؤشرات الأداء (أرقام كبيرة قابلة للقراءة من مسافة) ----------
    function renderKpis() {
        var ms = (state.summary && state.summary.mapStatus) || {};
        var stEl = document.getElementById('smapKpiStatus');
        if (stEl) {
            var stTxt = { green: 'طبيعي', yellow: 'ضغط متوسط', red: 'ضغط مرتفع' };
            stEl.innerHTML = '<span class="smap-status-dot ' + (ms.sectorStatus || '') + '"></span>'
                + '<span>' + (ms.sectorStatus ? stTxt[ms.sectorStatus] : '—') + '</span>';
            stEl.className = 'smap-kpi-v sev-' + (ms.sectorStatus || 'none');
        }
        var cntEl = document.getElementById('smapKpiCount');
        if (cntEl) {
            // عداد الخريطة تشغيلي: البلاغات النشطة فقط (المنتهية تبقى في الإحصائيات التاريخية)
            var actN = state.summary && typeof state.summary.activeCount === 'number' ? state.summary.activeCount
                : (state.summary && typeof state.summary.total === 'number' ? state.summary.total : null);
            cntEl.textContent = actN !== null ? String(actN) : '—';
        }
        var rdEl = document.getElementById('smapKpiReady');
        if (rdEl) {
            if (!state.teams) rdEl.textContent = '—';
            else {
                var total = 0, ready = 0;
                for (var u in state.teams) {
                    if (!state.teams.hasOwnProperty(u)) continue;
                    if (!teamCenterMap[u]) continue; // الفرق التشغيلية الميدانية فقط
                    total++;
                    if (state.teams[u].status === 'ready') ready++;
                }
                rdEl.textContent = total ? (ready + '/' + total) : '—';
            }
        }
        var arrEl = document.getElementById('smapKpiArrival');
        if (arrEl) {
            var rtA = state.summary && state.summary.responseTime && state.summary.responseTime.arrival;
            arrEl.textContent = (rtA && rtA.avg !== null && rtA.avg !== undefined) ? rtA.avg + ' د' : '—';
            var arrN = document.getElementById('smapKpiArrivalN');
            if (arrN) arrN.textContent = (rtA && rtA.count) ? rtA.count + ' بلاغ' : '';
        }
        var pkEl = document.getElementById('smapKpiPeak');
        if (pkEl) pkEl.textContent = ms.peakHour ? (ms.peakHour.hour + ':00') : '—';
    }

    // ---------- الفرق والمراكز ----------
    function renderTeams(teams) {
        state.teams = teams || null;
        renderKpis();
        if (!init()) return;
        layers.teams.clearLayers();
        layers.centers.clearLayers();
        markerIndex.teams = {};
        markerIndex.centers = {};
        if (!state.teams) { refit(); return; }

        // المراكز — 🏥 درع ثابت باسم المركز
        for (var cName in operationalCenters) {
            if (!operationalCenters.hasOwnProperty(cName)) continue;
            var cTeams = centerTeams(cName);
            var cSev = 'green';
            for (var ci = 0; ci < cTeams.length; ci++) {
                var sv = teamSev(state.teams[cTeams[ci]]);
                if (sv === 'red') { cSev = 'red'; break; }
                if (sv === 'yellow') cSev = 'yellow';
            }
            if (!cTeams.length) cSev = 'none';
            var cIcon = L.divIcon({
                className: 'smk-center sev-' + cSev,
                html: '<span class="smk-center-shield"><i class="fas fa-hospital"></i></span><span class="smk-center-name">' + esc(cName) + '</span>',
                iconSize: null, iconAnchor: [18, 18]
            });
            (function (name) {
                var mk = L.marker(operationalCenters[name], { icon: cIcon, zIndexOffset: 100 });
                mk.on('click', function (e) {
                    if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
                    focusOn('center', name);
                });
                mk.addTo(layers.centers);
                markerIndex.centers[name] = mk;
            })(cName);
        }

        // الفرق — 🚑 شريحة ملوّنة بالحالة + وسم الاسم
        var bounds = [];
        for (var unit in state.teams) {
            if (!state.teams.hasOwnProperty(unit)) continue;
            var cName2 = teamCenter(unit);
            if (!cName2 || !operationalCenters[cName2]) continue; // قيادة/تحكم/احتياط — مغطاة في مركز القرار
            var pos = teamPosition(unit, cName2);
            if (!pos) continue;
            var sev = teamSev(state.teams[unit]);
            var tIcon = L.divIcon({
                className: 'smk-team sev-' + sev,
                html: '<span class="smk-team-chip"><i class="fas fa-truck-medical"></i></span><span class="smk-team-name">' + esc(unit) + '</span>',
                iconSize: null, iconAnchor: [17, 17]
            });
            (function (u, p) {
                var mk = L.marker(p, { icon: tIcon, zIndexOffset: 200 });
                mk.on('click', function (e) {
                    if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
                    focusOn('team', u);
                });
                mk.addTo(layers.teams);
                markerIndex.teams[u] = mk;
                bounds.push(p);
            })(unit, pos);
        }
        if (bounds.length && fitMode === 0) {
            if (bounds.length === 1) map.setView(bounds[0], 14);
            else map.fitBounds(bounds, { padding: [42, 42], maxZoom: 15 });
            fitMode = 1;
            lastFit = bounds.slice();
        }
        reapplyFocus();
        setTimeout(function () { if (map) map.invalidateSize(); }, 250);
    }

    // ---------- البلاغات ----------
    function renderIncidents(summary) {
        if (!summary) return;
        state.summary = summary;
        renderKpis();
        renderSidePanels();
        if (!init()) return;
        layers.incidents.clearLayers();
        if (layers.hot) layers.hot.clearLayers();
        if (layers.streets) layers.streets.clearLayers();
        markerIndex.incidents = {};

        var incs = (summary.incidents || []).filter(function (ic) { return !isFinalInc(ic); }); // النشطة فقط على الخريطة
        var pts = [];
        incs.forEach(function (ic) {
            if (!hasCoords(ic)) return; // بلا إحداثيات ← لا موقع مختلق إطلاقًا
            var sev = ic.severity || 'yellow';
            var hasDup = !!(ic.duplicates && ic.duplicates.length); // note-18: احتمال تكرار — شارة تحقق فوق العلامة
            var icon = L.divIcon({
                className: 'smk-inc sev-' + sev,
                html: '<span class="smk-inc-pin"><i class="fas fa-location-dot"></i></span>'
                    + (hasDup ? '<span class="smk-dup-dot" title="احتمال تكرار — يحتاج تحقق"><i class="fas fa-clone"></i></span>' : ''),
                iconSize: [30, 38], iconAnchor: [15, 36]
            });
            var mk = L.marker([ic.lat, ic.lng], { icon: icon, zIndexOffset: 400 });
            mk.on('click', function (e) {
                if (e && e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
                focusOn('incident', String(ic.number));
            });
            mk.addTo(layers.incidents);
            markerIndex.incidents[String(ic.number)] = mk;
            pts.push([ic.lat, ic.lng]);
        });

        // اكتشاف احتمال التكرار (ملحق note-18): خط ربط بصري متقطع بين البلاغ
        // وكل مرشح ظاهر على الخريطة — مرشح بلا علامة ظاهرة (منتهٍ/بلا إحداثيات)
        // يبقى موثقًا في بطاقة الأدلة ولا يُرسم له خط مختلق
        if (layers.dupLinks) {
            layers.dupLinks.clearLayers();
            incs.forEach(function (ic) {
                if (!hasCoords(ic) || !ic.duplicates || !ic.duplicates.length) return;
                ic.duplicates.forEach(function (dup) {
                    var candMk = markerIndex.incidents[String(dup.candidate.number)];
                    if (!candMk) return;
                    var ll = candMk.getLatLng();
                    L.polyline([[ic.lat, ic.lng], [ll.lat, ll.lng]], {
                        className: 'smk-dup-line', color: '#F59E0B', weight: 2,
                        dashArray: '6 6', opacity: 0.8, interactive: false
                    }).addTo(layers.dupLinks);
                });
            });
        }

        if (pts.length && fitMode < 2) {
            if (pts.length === 1) map.setView(pts[0], 14);
            else map.fitBounds(pts, { padding: [42, 42], maxZoom: 15 });
            fitMode = 2;
            lastFit = pts.slice();
        }

        // الكثافة — نقاط حقيقية موقَّعة فقط بوزن متساوٍ
        if (layers.heat) layers.heat.setLatLngs(pts.map(function (p) { return [p[0], p[1], 1]; }));

        // المواقع الساخنة — تجميع بصري من نقاط حقيقية فقط: بلاغان+ على نفس الشارع
        var byStreet = {};
        incs.forEach(function (ic) {
            if (!hasCoords(ic)) return;
            var key = ic.street || ic.district;
            if (!key) return;
            (byStreet[key] = byStreet[key] || []).push(ic);
        });
        if (layers.hot) {
            for (var st in byStreet) {
                if (!byStreet.hasOwnProperty(st)) continue;
                var list = byStreet[st];
                if (list.length < 2) continue;
                var sx = 0, sy = 0;
                list.forEach(function (ic) { sx += ic.lat; sy += ic.lng; });
                var centroid = [sx / list.length, sy / list.length];
                var circle = L.circle(centroid, {
                    radius: 120 + list.length * 30,
                    className: 'smk-hot', color: '#E8C84A', weight: 1.5,
                    fillColor: '#E8C84A', fillOpacity: 0.10, opacity: 0.55
                });
                var typesTxt = {};
                list.forEach(function (ic) { var l = typeDef(ic.type).label; typesTxt[l] = (typesTxt[l] || 0) + 1; });
                var tHtml = Object.keys(typesTxt).map(function (k) { return esc(k) + ' ×' + typesTxt[k]; }).join(' · ');
                circle.bindPopup('<div class="smk-hot-pop"><b><i class="fas fa-fire"></i> ' + esc(st) + '</b><br>' + list.length + ' بلاغات في المناوبة<br><span>' + tHtml + '</span></div>', { closeButton: false });
                circle.addTo(layers.hot);
            }
        }

        // شارات الشوارع الأكثر بلاغًا — تُثبَّت على بلاغ حقيقي من الشارع
        var ms = summary.mapStatus || {};
        if (layers.streets) {
            (ms.topStreets || []).forEach(function (t) {
                var anchor = null;
                for (var i = 0; i < incs.length; i++) {
                    if (incs[i].street === t.name && hasCoords(incs[i])) { anchor = incs[i]; break; }
                }
                if (!anchor) return;
                var badge = L.divIcon({
                    className: 'smk-street-badge',
                    html: '<span class="smk-street-pill"><i class="fas fa-road"></i> ' + esc(t.name) + ' · ' + t.count + '</span>',
                    iconSize: null, iconAnchor: [0, 46]
                });
                L.marker([anchor.lat, anchor.lng], { icon: badge, interactive: false, zIndexOffset: 300 }).addTo(layers.streets);
            });
        }

        // نافذة الذروة — من mapStatus السيرفري
        var pkPop = document.getElementById('smapPeakPopBody');
        if (pkPop) pkPop.innerHTML = ms.peakHour
            ? 'أعلى ساعة بلاغات حتى الآن: <b>' + ms.peakHour.hour + ':00</b> (' + ms.peakHour.count + ' بلاغات) — من أوقات إنشاء CAD الفعلية.<br>التحليل التاريخي بالأيام والأحياء يُفعَّل مع تراكم البيانات.'
            : '<span class="smap-empty">لا توجد أوقات إنشاء CAD بعد — تُحسب الذروة من وقت إنشاء البلاغ الفعلي.</span>';

        reapplyFocus();
        renderAlerts(); // نظام التنبيه التشغيلي — من بيانات المحرك نفسها
        setTimeout(function () { if (map) map.invalidateSize(); }, 250);
    }

    function refit() { /* لا بيانات ⇒ لا ضبط — الخريطة تبقى على عرض الرياض */ }

    // ---------- استقرار الحجم (إصلاح عرضي بحت — لا يمس منطق البيانات) ----------
    // بعد نقل الخريطة إلى شبكة الصف الرئيسي قد يتغيّر حجم الحاوية متأخرًا عن
    // تهيئة Leaflet فتظهر البلاطات في ركن فقط. نراقب حجم الحاوية نفسه ونعيد
    // invalidateSize ثم نعيد الضبط على آخر نقاط عُرضت (بدون تغيير fitMode).
    function onMapResize() {
        if (!map) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function () {
            if (!map) return;
            map.invalidateSize();
            if (lastFit && lastFit.length) {
                if (lastFit.length === 1) map.setView(lastFit[0], 14);
                else map.fitBounds(lastFit, { padding: [42, 42], maxZoom: 15 });
            }
        }, 180);
    }

    // ---------- اللوحة الجانبية (الوضع الموسّع) ----------
    function renderSidePanels() {
        var ms = (state.summary && state.summary.mapStatus) || {};
        var tsEl = document.getElementById('smapTopStreets');
        if (tsEl) {
            var streets = ms.topStreets || [];
            tsEl.innerHTML = streets.length ? streets.map(function (t) {
                var w = Math.max(24, Math.round(110 * t.count / streets[0].count));
                return '<div class="smap-hot-row"><span class="nm">' + esc(t.name) + '</span><span class="bar" style="width:' + w + 'px"></span><span class="c">' + t.count + '</span></div>';
            }).join('') : '<div class="smap-empty">—</div>';
        }
        var pkEl = document.getElementById('smapPeakBody');
        if (pkEl) {
            pkEl.innerHTML = ms.peakHour
                ? '<div class="smap-peak-line">ذروة المناوبة الحالية حتى الآن: <b>الساعة ' + ms.peakHour.hour + ':00</b> (' + ms.peakHour.count + ' بلاغات)<br>التحليل التاريخي بالأيام والأحياء يُفعَّل مع تراكم البيانات.</div>'
                : '<div class="smap-empty">—</div>';
        }
        var nlEl = document.getElementById('smapNoLoc');
        if (nlEl) {
            var nl = ms.noLocation || [];
            nlEl.innerHTML = nl.length ? nl.map(function (x) {
                return '<div class="smap-noloc-row"><span class="n">' + esc(x.number) + '</span><span>' + esc(x.district || 'بلا حي محدد') + '</span></div>';
            }).join('') : '<div class="smap-empty">كل البلاغات موقَّعة ✅</div>';
        }
    }

    // ---------- وضع التركيز ----------
    function setMarkerFocus(mk, cls) {
        if (!mk || !mk.getElement()) return;
        mk.getElement().classList.add(cls);
    }
    function focusOn(kind, key) {
        clearFocus();
        focus = { kind: kind, key: key };
        applyFocus();
        showCard(kind, key);
    }
    function applyFocus() {
        if (!focus || !map) return;
        var wrap = document.querySelector('.ops-map-wrap');
        if (wrap) wrap.classList.add('smk-focusing');
        var keep = [];
        var linePts = [];

        if (focus.kind === 'incident') {
            var mk = markerIndex.incidents[focus.key];
            if (mk) { setMarkerFocus(mk, 'smk-focus'); keep.push(mk); }
            var ic = findIncident(focus.key);
            if (ic && hasCoords(ic)) {
                (ic.crews || []).forEach(function (c) {
                    if (c.counted === false) return; // الملغاة لا تظهر كمسؤولة
                    var tMk = markerIndex.teams[c.unit];
                    var cName = teamCenter(c.unit);
                    if (tMk) { setMarkerFocus(tMk, 'smk-keep'); keep.push(tMk); }
                    var cMk = cName && markerIndex.centers[cName];
                    if (cMk) { setMarkerFocus(cMk, 'smk-keep'); keep.push(cMk); }
                    var tPos = teamPosition(c.unit, cName);
                    if (tPos) {
                        linePts.push([[ic.lat, ic.lng], tPos]);
                        if (cName && operationalCenters[cName]) linePts.push([tPos, operationalCenters[cName]]);
                    } else if (hasCoords(ic) && cName && operationalCenters[cName]) {
                        linePts.push([[ic.lat, ic.lng], operationalCenters[cName]]);
                    }
                });
            }
        } else if (focus.kind === 'team') {
            var mk2 = markerIndex.teams[focus.key];
            if (mk2) { setMarkerFocus(mk2, 'smk-focus'); keep.push(mk2); }
            var cName2 = teamCenter(focus.key);
            var cMk2 = cName2 && markerIndex.centers[cName2];
            if (cMk2) { setMarkerFocus(cMk2, 'smk-keep'); keep.push(cMk2); }
            var tPos2 = teamPosition(focus.key, cName2);
            if (tPos2 && cName2 && operationalCenters[cName2]) linePts.push([tPos2, operationalCenters[cName2]]);
            var lic = linkedIncidentForTeam(focus.key);
            if (lic && hasCoords(lic)) {
                var iMk = markerIndex.incidents[String(lic.number)];
                if (iMk) { setMarkerFocus(iMk, 'smk-keep'); keep.push(iMk); }
                if (tPos2) linePts.push([[lic.lat, lic.lng], tPos2]);
            }
        } else if (focus.kind === 'center') {
            var mk3 = markerIndex.centers[focus.key];
            if (mk3) { setMarkerFocus(mk3, 'smk-focus'); keep.push(mk3); }
            centerTeams(focus.key).forEach(function (u) {
                var tMk3 = markerIndex.teams[u];
                if (tMk3) { setMarkerFocus(tMk3, 'smk-keep'); keep.push(tMk3); }
                var tPos3 = teamPosition(u, focus.key);
                if (tPos3 && operationalCenters[focus.key]) linePts.push([tPos3, operationalCenters[focus.key]]);
                var lic3 = linkedIncidentForTeam(u);
                if (lic3 && hasCoords(lic3)) {
                    var iMk3 = markerIndex.incidents[String(lic3.number)];
                    if (iMk3) { setMarkerFocus(iMk3, 'smk-keep'); keep.push(iMk3); }
                    if (tPos3) linePts.push([[lic3.lat, lic3.lng], tPos3]);
                }
            });
        }

        // خطوط الربط البصرية — عند الاختيار فقط، خفيفة متقطعة
        focusLines.clearLayers();
        linePts.forEach(function (pair) {
            L.polyline(pair, {
                className: 'smk-focus-line', color: '#3DB39B', weight: 2,
                opacity: 0.75, dashArray: '5 7', interactive: false
            }).addTo(focusLines);
        });
    }
    function clearFocus() {
        focus = null;
        focusLines && focusLines.clearLayers();
        var wrap = document.querySelector('.ops-map-wrap');
        if (wrap) wrap.classList.remove('smk-focusing');
        var focused = document.querySelectorAll('.smk-focus, .smk-keep');
        for (var i = 0; i < focused.length; i++) focused[i].classList.remove('smk-focus', 'smk-keep');
    }
    function reapplyFocus() {
        // بعد إعادة بناء العلامات: أعد تطبيق التركيز إن بقي الهدف موجودًا، وإلا ألغِه
        if (!focus) return;
        var exists = (focus.kind === 'incident' && markerIndex.incidents[focus.key])
            || (focus.kind === 'team' && markerIndex.teams[focus.key])
            || (focus.kind === 'center' && markerIndex.centers[focus.key]);
        if (!exists) { clearFocus(); closeCard(); return; }
        applyFocus();
        showCard(focus.kind, focus.key); // تحديث محتوى البطاقة بالبيانات الجديدة
    }
    function findIncident(num) {
        if (!state.summary || !state.summary.incidents) return null;
        for (var i = 0; i < state.summary.incidents.length; i++) {
            if (String(state.summary.incidents[i].number) === String(num)) return state.summary.incidents[i];
        }
        return null;
    }

    // ---------- بطاقة القرار الموحدة ----------
    function closeCard() {
        var card = document.getElementById('smapCard');
        if (card) card.style.display = 'none';
        cardTimers = [];
    }
    function showCard(kind, key) {
        var card = document.getElementById('smapCard');
        if (!card) return;
        cardTimers = []; // إعادة بناء المؤقتات مع محتوى البطاقة الجديد
        var html = '';
        if (kind === 'incident') html = incidentCardHtml(key);
        else if (kind === 'team') html = teamCardHtml(key);
        else if (kind === 'center') html = centerCardHtml(key);
        if (!html) { closeCard(); return; }
        card.innerHTML = '<button type="button" class="smap-card-close" onclick="SmartMap.closeCard();SmartMap.clearFocus();"><i class="fas fa-xmark"></i></button>' + html;
        card.style.display = 'block';
    }
    function sevText(sev) {
        return { green: 'تحت السيطرة', yellow: 'في الطريق / متابعة', red: 'تحتاج تدخلًا' }[sev] || '—';
    }
    function incidentCardHtml(num) {
        var ic = findIncident(num);
        if (!ic) return '';
        var t = typeDef(ic.type);
        var sev = ic.severity || 'yellow';
        var loc = [ic.address, ic.street, ic.district, ic.city].filter(Boolean).join(' — ') || '—';
        var createdMin = cadMin(ic.cadCreatedAt);
        var crewsHtml = (ic.crews || []).map(function (c) {
            var st = crewStatusLabel(c);
            var cName = teamCenter(c.unit);
            // الفرقة المسحوبة/الملغاة (§4): تظهر بحالتها الصادقة بلا مؤقتات ولا زمن استجابة
            if (c.withdrawn) {
                return '<div class="smap-card-crew withdrawn">'
                    + '<span class="u"><i class="fas fa-truck-medical"></i> ' + esc(c.unit) + (cName ? ' <small>(' + esc(cName) + ')</small>' : '') + '</span>'
                    + '<span class="st st-cancelled">مسحوبة من البلاغ</span>'
                    + '</div>';
            }
            var times = [];
            if (c.respArrivalMin !== null && c.respArrivalMin !== undefined) times.push('وصول ' + c.respArrivalMin + ' د');
            if (c.respMubasharaMin !== null && c.respMubasharaMin !== undefined) times.push('مباشرة ' + c.respMubasharaMin + ' د');
            // مؤقتات المراحل الأربع المستقلة (اعتماد المالك 2026-08-25): وصول/مباشرة/موقع/منشأة —
            // كل مرحلة تظهر عند توفر حدث بدايتها CAD وتُجمَّد عند حدث نهايتها، والحد من
            // المحرك الموحد (الوصول 10 د · Echo 8 د) والتصنيف من proQACode — لا حساب هنا.
            var timersHtml = '';
            if (createdMin !== null && crewAlertable(c)) {
                var ph = c.phases || {};
                var cls4 = AR.classify(ic.code);
                var searchMin = cadMin(ph['البحث']);
                var treatMin = cadMin(ph['العلاج']);
                var transMin = cadMin(ph['النقل']);
                var hospMin = cadMin(ph['بدء التسليم']);
                var hoMin = cadMin(ph['انتهاء التسليم']);
                var rows = [];
                var arrLbl = 'زمن الوصول' + (cls4 && cls4.critical ? ' 🚨 Echo' : '');
                rows.push(timerRow(ic.number, c.unit, 'arrival', arrLbl, createdMin, searchMin !== null ? cadDiff(createdMin, searchMin) : null, AR.stageTarget('arrival', cls4)));
                if (searchMin !== null) rows.push(timerRow(ic.number, c.unit, 'direct', 'زمن المباشرة', searchMin, treatMin !== null ? cadDiff(searchMin, treatMin) : null, AR.TARGETS.direct));
                if (treatMin !== null) rows.push(timerRow(ic.number, c.unit, 'scene', 'البقاء في الموقع', treatMin, transMin !== null ? cadDiff(treatMin, transMin) : null, AR.TARGETS.scene));
                if (hospMin !== null) rows.push(timerRow(ic.number, c.unit, 'facility', 'البقاء في المنشأة', hospMin, hoMin !== null ? cadDiff(hospMin, hoMin) : null, AR.TARGETS.facility));
                timersHtml = '<div class="smk-timers">' + rows.join('') + '</div>';
            }
            return '<div class="smap-card-crew">'
                + '<span class="u"><i class="fas fa-truck-medical"></i> ' + esc(c.unit) + (cName ? ' <small>(' + esc(cName) + ')</small>' : '') + '</span>'
                + '<span class="st ' + st.cls + '">' + st.lbl + '</span>'
                + (times.length ? '<span class="tm">' + esc(times.join(' · ')) + '</span>' : '')
                + timersHtml
                + '</div>';
        }).join('') || '<div class="smap-card-crew"><span class="u">لا فرق مسجلة بعد</span></div>';
        // بطاقة أدلة احتمال التكرار (ملحق note-18): «احتمال تكرار — يحتاج تحقق»
        // تنبيه فقط — Potential Duplicate ≠ Duplicate. لا «تمت المراجعة» ولا سجل،
        // والقرار والإلغاء في CAD حصرًا. المرشح الملغى يظهر موسومًا «ملغى في CAD»
        // وإلغاؤه ليس دليلًا بذاته. رقم المبلغ لا يُعرض — الدليل يقول «متطابق» فقط.
        var dupHtml = '';
        if (ic.duplicates && ic.duplicates.length) {
            dupHtml = '<div class="smap-dup-box"><div class="smap-dup-title">⚠️ احتمال تكرار — يحتاج تحقق</div>'
                + ic.duplicates.map(function (dup) {
                    var lvl = { high: '🔴 اشتباه قوي', medium: '🟠 اشتباه متوسط', low: '🟡 اشتباه أولي' }[dup.level] || '🟡';
                    var ev = (dup.evidence || []).map(function (e) { return '<span class="smap-dup-ev">' + esc(e.label) + '</span>'; }).join('');
                    return '<div class="smap-dup-row">'
                        + '<div class="smap-dup-head"><button type="button" class="smap-card-link" onclick="SmartMap.focusOn(\'incident\',\'' + esc(String(dup.candidate.number)) + '\')"><i class="fas fa-location-dot"></i> بلاغ ' + esc(dup.candidate.number) + '</button>'
                        + '<span class="smap-dup-lvl">' + lvl + '</span>'
                        + (dup.cancelledInCad ? '<span class="smap-dup-canc">ملغى في CAD</span>' : '') + '</div>'
                        + '<div class="smap-dup-evs">' + ev + '</div>'
                        + '</div>';
                }).join('')
                + '<div class="smap-dup-note">تنبيه آلي فقط — القرار والإلغاء داخل CAD حصرًا؛ المنصة لا تلغي ولا تدمج أي بلاغ.</div></div>';
        }
        return '<div class="smap-card-head">'
            + '<span class="smap-card-title"><i class="fas fa-location-dot"></i> بلاغ ' + esc(ic.number) + '</span>'
            + '<span class="smap-card-sev s-' + sev + '">' + sevText(sev) + '</span></div>'
            + '<div class="smap-card-body">'
            + '<div class="smap-card-row"><i class="fas fa-tag"></i><span class="k">النوع</span><span class="v">' + t.emoji + ' ' + esc(t.label) + (ic.code ? ' · ' + esc(ic.code) : '') + '</span></div>'
            + '<div class="smap-card-row"><i class="fas fa-map-pin"></i><span class="k">الموقع</span><span class="v">' + esc(loc) + '</span></div>'
            + '<div class="smap-card-row"><i class="fas fa-clock"></i><span class="k">الإنشاء</span><span class="v">' + esc(ic.cadCreatedAt || '—') + '</span></div>'
            + '<div class="smap-card-crews">' + crewsHtml + '</div>'
            + dupHtml
            + '<div class="smap-card-times">'
            + '<div class="smap-card-time"><div class="tv">' + ((ic.bestArrivalMin !== null && ic.bestArrivalMin !== undefined) ? ic.bestArrivalMin + ' د' : '—') + '</div><div class="tl">زمن الوصول</div></div>'
            + '<div class="smap-card-time"><div class="tv">' + ((ic.bestMubasharaMin !== null && ic.bestMubasharaMin !== undefined) ? ic.bestMubasharaMin + ' د' : '—') + '</div><div class="tl">زمن المباشرة</div></div>'
            + '</div></div>';
    }
    function teamCardHtml(unit) {
        var t = state.teams && state.teams[unit];
        if (!t) return '';
        var sev = teamSev(t);
        var cName = teamCenter(unit);
        var details = [];
        details.push((t.activeCount || 0) + '/' + (t.requiredPersonnel || 0) + ' حاضر');
        if (t.vacant > 0) details.push('ينقصها ' + t.vacant);
        if (t.reason) details.push(t.reason);
        var veh = '—';
        if (t.vehicleId) veh = esc(t.vehicleId) + ' — ' + (t.vehicleOk === false ? ('<span class="bad">' + esc(t.vehicleStatus || 'غير جاهزة') + '</span>') : esc(t.vehicleStatus || 'جاهزة'));
        var members = (t.members || []).map(function (m) {
            return '<div class="smap-card-member"><span>' + esc(m.name) + '</span><small>' + esc(m.jobTitle || '') + (m.state ? ' · ' + esc(m.state) : '') + '</small></div>';
        }).join('') || '<div class="smap-card-member"><span>لا أعضاء مسجلين</span></div>';
        var lic = linkedIncidentForTeam(unit);
        var licHtml = lic
            ? '<button type="button" class="smap-card-link" onclick="SmartMap.focusOn(\'incident\',\'' + esc(String(lic.number)) + '\')"><i class="fas fa-location-dot"></i> بلاغ ' + esc(lic.number) + ' — ' + esc(typeDef(lic.type).label) + '</button>'
            : '<span class="smap-card-nolink">لا بلاغ مرتبط حاليًا</span>';
        var lastDec = t.lastDecision && t.lastDecision.at ? esc(t.lastDecision.at) + (t.lastDecision.by ? ' · ' + esc(t.lastDecision.by) : '') : '—';
        return '<div class="smap-card-head">'
            + '<span class="smap-card-title"><i class="fas fa-truck-medical"></i> ' + esc(unit) + '</span>'
            + '<span class="smap-card-sev s-' + sev + '">' + teamStatusText(t) + '</span></div>'
            + '<div class="smap-card-body">'
            + '<div class="smap-card-row"><i class="fas fa-hospital"></i><span class="k">المركز</span><span class="v">' + esc(cName || '—') + '</span></div>'
            + '<div class="smap-card-row"><i class="fas fa-user-group"></i><span class="k">الطاقم</span><span class="v">' + esc(details.join(' — ')) + '</span></div>'
            + '<div class="smap-card-row"><i class="fas fa-car-side"></i><span class="k">المركبة</span><span class="v">' + veh + '</span></div>'
            + '<div class="smap-card-members">' + members + '</div>'
            + '<div class="smap-card-row"><i class="fas fa-link"></i><span class="k">البلاغ</span><span class="v">' + licHtml + '</span></div>'
            + '<div class="smap-card-row"><i class="fas fa-clock-rotate-left"></i><span class="k">آخر تحديث</span><span class="v">' + lastDec + '</span></div>'
            + '<button type="button" class="smap-card-action" onclick="navigateToPage(\'radio-completion.html?v=41\')">فتح إجراء التكميل <i class="fas fa-chevron-left"></i></button>'
            + '</div>';
    }
    function centerCardHtml(cName) {
        if (!operationalCenters[cName]) return '';
        var list = centerTeams(cName);
        var ready = 0, missing = 0;
        list.forEach(function (u) {
            var sv = teamSev(state.teams[u]);
            if (sv === 'green') ready++;
            if (sv === 'red') missing++;
        });
        var teamsHtml = list.map(function (u) {
            var t = state.teams[u];
            var sv = teamSev(t);
            return '<button type="button" class="smap-card-teamchip sev-' + sv + '" onclick="SmartMap.focusOn(\'team\',\'' + esc(u) + '\')">'
                + '<i class="fas fa-truck-medical"></i> ' + esc(u) + ' <small>' + teamStatusText(t) + '</small></button>';
        }).join('') || '<div class="smap-empty">لا فرق تابعة في المناوبة الحالية</div>';
        // بلاغات مرتبطة بالمركز: بلاغ لها فرقة محسوبة تابعة لهذا المركز
        var linked = 0;
        if (state.summary && state.summary.incidents) {
            state.summary.incidents.forEach(function (ic) {
                var hit = (ic.crews || []).some(function (c) { return c.counted !== false && teamCenter(c.unit) === cName; });
                if (hit) linked++;
            });
        }
        var lackHtml = missing > 0
            ? '<div class="smap-card-row warn"><i class="fas fa-triangle-exclamation"></i><span class="k">نقص</span><span class="v">' + missing + ' فرقة غير جاهزة في هذا المركز</span></div>'
            : '';
        return '<div class="smap-card-head">'
            + '<span class="smap-card-title"><i class="fas fa-hospital"></i> مركز ' + esc(cName) + '</span>'
            + '<span class="smap-card-sev s-' + (missing ? 'red' : 'green') + '">' + ready + '/' + list.length + ' جاهزة</span></div>'
            + '<div class="smap-card-body">'
            + '<div class="smap-card-teamchips">' + teamsHtml + '</div>'
            + '<div class="smap-card-row"><i class="fas fa-location-dot"></i><span class="k">بلاغات مرتبطة</span><span class="v">' + linked + '</span></div>'
            + lackHtml
            + '</div>';
    }

    // ---------- الوضع الموسّع ----------
    function toggleExpand() {
        var s = document.getElementById('opsMapSection');
        if (!s) return;
        var expanded = s.classList.toggle('smap-expanded');
        var ic = document.querySelector('#smapExpandBtn i');
        if (ic) ic.className = expanded ? 'fas fa-compress' : 'fas fa-expand';
        var btn = document.getElementById('smapExpandBtn');
        if (btn) btn.title = expanded ? 'تصغير الخريطة — العودة للوضع المدمج' : 'تكبير الخريطة — وضع التشغيل المتقدم';
        document.body.style.overflow = expanded ? 'hidden' : '';
        setTimeout(function () { if (map) map.invalidateSize(); }, 320);
        // توجيه الانتباه: عند الدخول للوضع الموسّع ووجود حالة متجاوزة ← ركّز على أخطر بلاغ (بلا تغيير Zoom)
        if (expanded) {
            renderAlerts();
            var crit = alertsCache.filter(function (a) { return a.level === 'over'; })[0];
            if (crit) setTimeout(function () { focusOn('incident', crit.number); }, 380);
        }
    }

    // ---------- الواجهة العامة ----------
    window.SmartMap = {
        renderTeams: renderTeams,
        renderIncidents: renderIncidents,
        toggleExpand: toggleExpand,
        focusOn: focusOn,
        clearFocus: clearFocus,
        closeCard: closeCard,
        dismissAlerts: function () { alertBarClosed = true; renderAlerts(); }
    };
})();
