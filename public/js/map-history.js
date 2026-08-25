/* ============================================================
   ذاكرة الخريطة — الوضع التاريخي التحليلي داخل الخريطة التشغيلية
   (اعتماد المالك 2026-08-24 — وثيقة DECISION-HISTORICAL-ANALYTICS)

   عرض فقط: كل رقم يأتي من /api/analytics/* (H1–H4) — لا اشتقاق ولا
   منطق أعمال هنا إطلاقًا (قاعدة Zero Business Logic في الواجهة).

   عدم التأثير على الوضع الحي مضمون بنيويًا:
   - هذه الوحدة تلمس فقط عناصرها الخاصة (#histMap / #histDock /
     #smapHistBar / #smapHistoryBtn) وتبدّل CSS class على #opsMapSection.
   - لا تقرأ ولا تكتب أي حالة من smart-map.js، ولا توقف مؤقتاته.
   - الخريطة الحية تبقى تعمل في الخلفية وتستعيد عرضها عند الخروج
     (نرفع حدث resize فيعيد LastFit الخاص بها ضبط نفسه).
   ============================================================ */
(function () {
    'use strict';

    var on = false;             // الوضع التاريخي مفعّل؟
    var hmap = null;            // خريطة Leaflet التاريخية الخاصة
    var layers = null;          // { heat, markers, dots } — طبقات الوضع التاريخي
    var tab = 'density';        // density | zones | patterns | positioning | gaps | decision
    var cache = {};             // مفتاح: kind|from|to
    var fittedFor = null;       // النطاق الذي ضُبط العرض عليه
    // تتبع الرقم إلى مصدره (اعتماد المالك 2026-08-25): آخر حمولة coverage وفهرس
    // عرض برقم البلاغ — lookup عرضي خالص فوق بيانات الخادم، بلا أي اشتقاق
    var lastCov = null;
    var incByNumber = {};
    var zoneCircles = {};       // مفتاح المنطقة ← دائرتها (فتح نافذتها من صف اللوحة)

    var WEEKDAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function el(id) { return document.getElementById(id); }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function isoDay(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
    function minTxt(v) { return (v === null || v === undefined) ? '—' : v + ' د'; }
    function kmTxt(v) { return (v === null || v === undefined) ? '—' : v + ' كم'; }

    function range() {
        var f = el('histFrom'), t = el('histTo');
        return { from: f && f.value ? f.value : null, to: t && t.value ? t.value : null };
    }

    function fetchAnalytics(kind) {
        var r = range();
        if (!r.from || !r.to) return Promise.reject(new Error('حدد النطاق'));
        var key = kind + '|' + r.from + '|' + r.to;
        if (cache[key]) return Promise.resolve(cache[key]);
        return AuthManager.apiRequest('/api/analytics/' + kind + '?from=' + r.from + '&to=' + r.to)
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (d) { cache[key] = d; return d; });
    }

    // ---------- دخول/خروج الوضع ----------
    function enter() {
        var sec = el('opsMapSection');
        if (!sec) return;
        on = true;
        sec.classList.add('smap-hist-mode');
        var btn = el('smapHistoryBtn');
        if (btn) { btn.classList.add('active'); btn.title = 'العودة إلى الوضع الحي'; }
        // النطاق الافتراضي: آخر 7 أيام (مطابق لافتراضي الخادم)
        var f = el('histFrom'), t = el('histTo');
        if (t && !t.value) t.value = isoDay(new Date());
        if (f && !f.value) { var d = new Date(); d.setDate(d.getDate() - 6); f.value = isoDay(d); }
        ensureMap();
        [150, 600].forEach(function (ms) {
            setTimeout(function () { if (hmap) hmap.invalidateSize(); }, ms);
        });
        renderTab();
    }

    function exit() {
        var sec = el('opsMapSection');
        if (!sec) return;
        on = false;
        sec.classList.remove('smap-hist-mode');
        var btn = el('smapHistoryBtn');
        if (btn) { btn.classList.remove('active'); btn.title = 'ذاكرة الخريطة — التحليل التاريخي (H1–H4) فوق نفس الخريطة'; }
        // الخريطة الحية تستعيد ضبط حجمها بنفسها عبر معالجها الخاص للحدث
        window.dispatchEvent(new Event('resize'));
    }

    function ensureMap() {
        if (hmap) return;
        if (typeof L === 'undefined') {
            dockBody('<div class="smap-hist-warn">تعذّر تحميل مكتبة الخرائط</div>');
            return;
        }
        // trackResize:false — الوحدة تدير invalidateSize بنفسها عند الدخول فقط، حتى
        // لا يعيد Leaflet ضبط الحجم بينما الحاوية مخفية (canvas الكثافة بعرض 0)
        hmap = L.map('histMap', { scrollWheelZoom: false, attributionControl: true, trackResize: false }).setView([24.7136, 46.6753], 11);
        hmap.on('click', function () { hmap.scrollWheelZoom.enable(); });
        hmap.on('mouseout', function () { hmap.scrollWheelZoom.disable(); });
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: 'abcd', maxZoom: 19
        }).addTo(hmap);
        layers = {
            heat: (typeof L.heatLayer === 'function') ? L.heatLayer([], { radius: 28, blur: 22, maxZoom: 16, minOpacity: 0.25 }) : null,
            markers: L.layerGroup().addTo(hmap),
            dots: L.layerGroup().addTo(hmap) // نقاط البلاغات الفعلية القابلة للضغط (تتبع الكثافة)
        };
        // طبقة الكثافة تبقى ملحقة دائمًا وتُصفَّر بالبيانات فقط — إزالتها ثم
        // setLatLngs تضرب سباق إطار داخلي في leaflet-heat (this._map === null)
        if (layers.heat) layers.heat.addTo(hmap);
    }

    function clearLayers() {
        if (!hmap || !layers) return;
        layers.markers.clearLayers();
        if (layers.dots) layers.dots.clearLayers();
        if (layers.heat) layers.heat.setLatLngs([]); // ملحقة دائمًا — التصفير آمن
        zoneCircles = {};
    }

    function dockBody(html) { var b = el('histDockBody'); if (b) b.innerHTML = html; }
    function dockHead() {
        var r = range();
        var h = el('histDockRange');
        if (h && r.from && r.to) h.textContent = r.from + ' → ' + r.to;
    }

    function loading() { dockBody('<div class="smap-empty">⏳ جارٍ تحميل التحليل…</div>'); }
    function fail(e) {
        dockBody('<div class="smap-hist-warn">تعذّر جلب التحليل (' + esc(e && e.message) + ') — تحقق من الجلسة ثم اضغط تحديث</div>');
    }

    // ملاءمة العرض لنقاط البلاغات — مرة واحدة لكل نطاق
    function fitTo(cov) {
        var key = range().from + '|' + range().to;
        if (!hmap || fittedFor === key || !cov) return;
        var pts = (cov.incidents || []).filter(function (d) { return !d.noCoords; })
            .map(function (d) { return [d.lat, d.lng]; });
        if (pts.length) {
            fittedFor = key;
            hmap.fitBounds(pts, { padding: [42, 42], maxZoom: 13 });
        }
    }

    function heatFrom(cov) {
        if (!layers || !layers.heat || !cov) return;
        var pts = (cov.incidents || []).filter(function (d) { return !d.noCoords; })
            .map(function (d) { return [d.lat, d.lng, 1]; });
        layers.heat.setLatLngs(pts);
        if (pts.length) layers.heat.addTo(hmap);
    }

    // ═══ تتبع الكثافة إلى مصدرها (اعتماد المالك 2026-08-25) ═══
    // كل نقطة/منطقة تكشف بلاغاتها الفعلية: الضغط على نقطة كثافة ← بطاقة البلاغ
    // بالحقول المتوفرة فقط («غير متوفر» عند الغياب — لا تخمين إطلاقًا)، والضغط
    // على منطقة ← قائمة بلاغاتها (رقم/وقت/نوع/حي) وكل بلاغ ← بطاقته.
    function typeDef(t) {
        var defs = (typeof REPORT_TYPE_DEFS !== 'undefined') ? REPORT_TYPE_DEFS : null;
        return (defs && defs[t]) || { emoji: '📦', label: t || 'حالات أخرى' };
    }
    function statusTxt(s) { return s === 'closed' ? 'مغلق' : (s === 'cancelled' ? 'ملغى' : 'نشط'); }
    function indexCoverage(cov) {
        lastCov = cov;
        incByNumber = {};
        (cov && cov.incidents || []).forEach(function (d) { incByNumber[String(d.number)] = d; });
    }
    // بطاقة البلاغ التاريخية — بالحقول المتوفرة فقط، والغائب «غير متوفر» بصراحة
    function incidentCardHtml(d) {
        if (!d) return '<div class="hist-zone-pop"><div class="t">البلاغ خارج النطاق الحالي</div></div>';
        var t = typeDef(d.type);
        var loc = [d.street, d.district].filter(Boolean).join(' — ');
        var near = d.nearestPositioningAtTime;
        var arr = (d.bestArrivalMin === null || d.bestArrivalMin === undefined) ? 'غير متوفر' : d.bestArrivalMin + ' د';
        return '<div class="hist-zone-pop hist-inc-pop">'
            + '<div class="t">📍 بلاغ ' + esc(d.number) + ' <small>(' + esc(statusTxt(d.status)) + ')</small></div>'
            + '<div class="r"><span class="k">النوع</span><span class="v">' + t.emoji + ' ' + esc(t.label) + (d.code ? ' · ' + esc(d.code) : '') + '</span></div>'
            + '<div class="r"><span class="k">وقت الإنشاء (CAD)</span><span class="v">' + esc(d.cadCreatedAt || 'غير متوفر') + '</span></div>'
            + '<div class="r"><span class="k">الموقع</span><span class="v">' + esc(loc || 'غير متوفر') + '</span></div>'
            + '<div class="r"><span class="k">الفرق المحتسبة</span><span class="v">' + (d.countedUnits && d.countedUnits.length ? esc(d.countedUnits.join('، ')) : 'غير متوفر') + '</span></div>'
            + '<div class="r"><span class="k">أفضل زمن وصول</span><span class="v">' + arr + '</span></div>'
            + '<div class="r"><span class="k">أقرب تمركز وقت البلاغ</span><span class="v">' + (near ? (kmTxt(near.km) + (near.unit ? ' — ' + esc(near.unit) : '')) : 'غير متوفر') + '</span></div>'
            + '</div>';
    }
    // فتح بطاقة بلاغ على موقعه الفعلي — بلا إحداثية لا موقع مختلق إطلاقًا
    function openIncident(num) {
        var d = incByNumber[String(num)];
        if (!d || !hmap) return;
        if (d.lat === null || d.lat === undefined || d.lng === null || d.lng === undefined) return;
        if (hmap.getZoom() < 14) hmap.setView([d.lat, d.lng], 14);
        else hmap.panTo([d.lat, d.lng]);
        L.popup({ closeButton: true, maxWidth: 320 }).setLatLng([d.lat, d.lng]).setContent(incidentCardHtml(d)).openOn(hmap);
    }
    // قائمة بلاغات منطقة: رقم/وقت/نوع/حي — كل زر يفتح بطاقة بلاغه
    function zoneIncListHtml(z, max) {
        var nums = z.incidentNumbers || [];
        var lim = max || 8;
        var html = nums.slice(0, lim).map(function (n) {
            var d = incByNumber[String(n)] || null;
            var t = d ? typeDef(d.type) : null;
            var sub = d ? [d.cadCreatedAt || 'بلا وقت', t ? t.label : null, d.district].filter(Boolean).join(' · ') : '';
            return '<button type="button" class="hist-inc-btn" onclick="MapHistory.openIncident(\'' + esc(String(n)) + '\')">'
                + '📍 ' + esc(String(n)) + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</button>';
        }).join('');
        if (nums.length > lim) html += '<div class="hist-inc-more">+' + (nums.length - lim) + ' بلاغًا آخر في هذه المنطقة — اضغط صف المنطقة في اللوحة الجانبية لعرض القائمة كاملة</div>';
        return html;
    }
    // نقاط الكثافة التفاعلية: نقطة صغيرة لكل بلاغ محدد الموقع — الضغط يكشف بطاقته.
    // الحرارية تبقى للمشهد العام، والنقاط هي طبقة التتبع بنفس البيانات حرفيًا
    function dotsFrom(cov) {
        if (!layers || !layers.dots || !cov) return;
        (cov.incidents || []).forEach(function (d) {
            if (d.noCoords || d.lat === null || d.lat === undefined) return; // بلا إحداثية ← لا نقطة مختلقة
            var m = L.circleMarker([d.lat, d.lng], {
                radius: 5, color: '#FBBF24', weight: 1, fillColor: '#F59E0B', fillOpacity: 0.65
            });
            m.bindPopup(incidentCardHtml(d), { maxWidth: 320 });
            m.addTo(layers.dots);
        });
    }

    // نافذة المنطقة الساخنة — بالحقول التي اعتمدها المالك حرفيًا (2026-08-24)
    function zonePopup(z) {
        var peak = z.peakWindow ? (pad2(z.peakWindow.startHour) + ':00–' + pad2(z.peakWindow.endHour) + ':00') : '—';
        var r = range();
        return '<div class="hist-zone-pop">'
            + '<div class="t">منطقة ' + (z.weak ? 'مرتفعة الطلب — تغطية ضعيفة' : 'مرتفعة الطلب') + '</div>'
            + '<div class="r"><span class="k">البلاغات</span><span class="v">' + z.count + '</span></div>'
            + '<div class="r"><span class="k">الفترة</span><span class="v" style="direction:ltr">' + esc((r.from || '—') + ' ← ' + (r.to || '—')) + '</span></div>'
            + '<div class="r"><span class="k">متوسط الوصول</span><span class="v">' + minTxt(z.avgArrivalMin) + '</span></div>'
            + '<div class="r"><span class="k">الذروة</span><span class="v" style="direction:ltr">' + peak + '</span></div>'
            + '<div class="r"><span class="k">أقرب تمركز تاريخي</span><span class="v">' + kmTxt(z.nearestAnytimeKm) + '</span></div>'
            + '<div class="r"><span class="k">التغطية</span><span class="v">' + (z.weak ? 'ضعيفة' : 'جيدة') + '</span></div>'
            + (z.weak && z.weakReasons && z.weakReasons.length
                ? '<div class="why"><b>سبب التصنيف:</b> ' + esc(z.weakReasons.join(' + ')) + '</div>' : '')
            // تتبع الرقم إلى مصدره: «N بلاغًا» = هذه البلاغات بالتحديد — كل زر يفتح بطاقة بلاغه
            + '<div class="hist-inc-list"><b>البلاغات الفعلية (' + (z.incidentNumbers ? z.incidentNumbers.length : 0) + '):</b>'
            + zoneIncListHtml(z, 8) + '</div>'
            + '</div>';
    }

    // ---------- تبويب الكثافة ----------
    function renderDensity() {
        loading();
        fetchAnalytics('coverage').then(function (cov) {
            if (!on || tab !== 'density') return;
            indexCoverage(cov);
            clearLayers(); fitTo(cov); heatFrom(cov); dotsFrom(cov); dockHead();
            var t = cov.totals || {};
            dockBody(
                '<div class="smap-hist-stat"><span class="k">بلاغات النطاق</span><span class="v">' + (t.incidents != null ? t.incidents : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">محددة الموقع (على الخريطة)</span><span class="v">' + (t.positioned != null ? t.positioned : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">بلا إحداثية (لا تُخمَّن)</span><span class="v">' + (t.noCoords != null ? t.noCoords : '—') + '</span></div>'
                + (t.unresolvedTimeCount ? '<div class="smap-hist-stat"><span class="k">بلا وقت قابل للقراءة</span><span class="v">' + t.unresolvedTimeCount + '</span></div>' : '')
                + '<div class="smap-hist-note">الكثافة من مواقع البلاغات الفعلية المسجلة في النطاق فقط — بلا أي تخمين مواقع.</div>'
                + '<div class="smap-hist-note">🟡 كل نقطة صفراء = بلاغ فعلي — <b>اضغطها لتظهر بطاقته</b> (رقمه ووقته ونوعه وموقعه). الرقم أعلاه = هذه النقاط بالتحديد، ولا نقطة بلا بلاغ ولا بلاغ محدد الموقع بلا نقطة.</div>'
            );
        }).catch(fail);
    }

    // ---------- تبويب المناطق الساخنة ----------
    function renderZones(onlyWeak) {
        loading();
        fetchAnalytics('coverage').then(function (cov) {
            if (!on || (tab !== 'zones' && tab !== 'gaps')) return;
            indexCoverage(cov);
            clearLayers(); fitTo(cov); heatFrom(cov); dockHead();
            var zones = (cov.zones || []).filter(function (z) { return !onlyWeak || z.weak; });
            zones.forEach(function (z) {
                var c = L.circle([z.centroid.lat, z.centroid.lng], {
                    radius: 140 + z.count * 25,
                    color: z.weak ? '#EF4444' : '#F59E0B',
                    weight: 2, opacity: .9,
                    fillColor: z.weak ? '#EF4444' : '#F59E0B', fillOpacity: .18
                });
                c.bindPopup(zonePopup(z), { maxWidth: 340 });
                c.addTo(layers.markers);
                zoneCircles[z.key] = c; // فتح نفس النافذة من صف اللوحة الجانبية
            });
            var rows = zones.map(function (z, i) {
                var peak = z.peakWindow ? (pad2(z.peakWindow.startHour) + ':00–' + pad2(z.peakWindow.endHour) + ':00') : '—';
                return '<div class="smap-hist-zone" data-lat="' + z.centroid.lat + '" data-lng="' + z.centroid.lng + '" data-key="' + esc(z.key) + '">'
                    + '<div class="z-head"><span>#' + (i + 1) + ' — ' + z.count + ' بلاغًا</span>'
                    + '<span class="smap-hist-badge ' + (z.weak ? 'weak' : 'ok') + '">' + (z.weak ? 'تغطية ضعيفة' : 'جيدة') + '</span></div>'
                    + '<div class="z-sub">وصول ' + minTxt(z.avgArrivalMin) + ' · ذروة <span style="direction:ltr;display:inline-block">' + peak + '</span> · أقرب تمركز ' + kmTxt(z.nearestAnytimeKm) + '</div>'
                    + (z.weak && z.weakReasons && z.weakReasons.length ? '<div class="z-sub" style="color:#FCA5A5">⛔ ' + esc(z.weakReasons.join(' + ')) + '</div>' : '')
                    // تتبع «N بلاغًا» إلى مصدرها: قائمة البلاغات الفعلية كاملة — كل زر يفتح بطاقة بلاغه
                    + '<div class="z-incs">' + zoneIncListHtml(z, 1000) + '</div>'
                    + '</div>';
            }).join('');
            dockBody(
                (onlyWeak
                    ? '<div class="smap-hist-weak">⚠ ' + zones.length + ' منطقة طلب مرتفع بتغطية ضعيفة في النطاق — الضغط على أي منطقة يوضح سبب التصنيف</div>'
                    : '<div class="smap-hist-h">مناطق الطلب المرتفع (خلايا ~1.1كم بثلاثة بلاغات فأكثر)</div>')
                + (rows || '<div class="smap-empty">لا توجد مناطق مطابقة في هذا النطاق</div>')
                + '<div class="smap-hist-note">القاعدة: ' + esc((cov.constants && cov.constants.cellDegrees) || '') + ' بحد أدنى ' + (cov.constants ? cov.constants.demandZoneMin : '—') + ' بلاغات — من الخام مباشرة.</div>'
            );
        }).catch(fail);
    }

    // ---------- تبويب الأنماط الزمنية ----------
    function bars(arr, peakIdx) {
        var max = Math.max.apply(null, arr.concat([1]));
        return '<div class="smap-hist-bars">' + arr.map(function (v, i) {
            var h = Math.max(2, Math.round(v / max * 100));
            return '<div class="b' + (i === peakIdx ? ' pk' : '') + '" style="height:' + h + '%" title="' + v + '"></div>';
        }).join('') + '</div>';
    }
    function topList(title, list, unit) {
        if (!list || !list.length) return '';
        return '<div class="smap-hist-h">' + title + '</div>' + list.slice(0, 5).map(function (x) {
            return '<div class="smap-hist-stat"><span class="k">' + esc(x.name) + '</span><span class="v">' + x.count + (unit || '') + '</span></div>';
        }).join('');
    }
    function renderPatterns() {
        loading();
        fetchAnalytics('patterns').then(function (p) {
            if (!on || tab !== 'patterns') return;
            clearLayers(); dockHead();
            var cmp = p.comparison || {};
            var deltaTxt = cmp.delta == null ? '—' : (cmp.delta > 0 ? '+' + cmp.delta : String(cmp.delta));
            dockBody(
                '<div class="smap-hist-stat"><span class="k">إجمالي بلاغات النطاق</span><span class="v">' + (p.total != null ? p.total : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">' + esc(cmp.label || 'الفترة السابقة') + '</span><span class="v">' + (cmp.total != null ? cmp.total : '—') + ' (' + deltaTxt + ')</span></div>'
                + '<div class="smap-hist-stat"><span class="k">متوسط يومي — الحالية / السابقة</span><span class="v">' + (cmp.perDay ? cmp.perDay.current + ' / ' + cmp.perDay.previous : '—') + '</span></div>'
                + '<div class="smap-hist-h">التوزيع بالساعة' + (p.peakHour ? ' — الذروة ' + pad2(p.peakHour.hour) + ':00 (' + p.peakHour.count + ')' : '') + '</div>'
                + bars(p.byHour || [], p.peakHour ? p.peakHour.hour : -1)
                + '<div class="smap-hist-bars-lbl"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>'
                + '<div class="smap-hist-h">التوزيع باليوم' + (p.peakWeekday ? ' — الأعلى: ' + WEEKDAYS[p.peakWeekday.day] + ' (' + p.peakWeekday.count + ')' : '') + '</div>'
                + bars(p.byWeekday || [], p.peakWeekday ? p.peakWeekday.day : -1)
                + '<div class="smap-hist-bars-lbl"><span>' + WEEKDAYS[0] + '</span><span>' + WEEKDAYS[6] + '</span></div>'
                + '<div class="smap-hist-h">الفترات</div>'
                + '<div class="smap-hist-stat"><span class="k">صباح (07–15)</span><span class="v">' + (p.byPeriod ? p.byPeriod.morning : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">مساء (15–23)</span><span class="v">' + (p.byPeriod ? p.byPeriod.evening : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">ليل (23–07)</span><span class="v">' + (p.byPeriod ? p.byPeriod.night : '—') + '</span></div>'
                + topList('أكثر الأحياء بلاغًا', p.districts)
                + topList('أكثر الشوارع بلاغًا', p.streets)
                + '<div class="smap-hist-note">' + esc(p.periodRule || '') + '</div>'
            );
        }).catch(fail);
    }

    // ---------- تبويب التمركزات التاريخية ----------
    function renderPositioning() {
        loading();
        fetchAnalytics('coverage').then(function (cov) {
            if (!on || tab !== 'positioning') return;
            clearLayers(); fitTo(cov); heatFrom(cov); dockHead();
            var pts = cov.positioningUnits || [];
            pts.forEach(function (w) {
                var m = L.circleMarker([w.lat, w.lng], {
                    radius: 9, color: '#38BDF8', weight: 2, fillColor: '#0EA5E9', fillOpacity: .5
                });
                m.bindPopup('<div class="hist-zone-pop"><div class="t" style="color:#0369A1">تمركز تاريخي</div>'
                    + '<div class="r"><span class="k">الوحدة</span><span class="v">' + esc(w.unit || '—') + '</span></div>'
                    + '<div class="r"><span class="k">الموقع</span><span class="v">' + esc(w.location || '—') + '</span></div></div>');
                m.addTo(layers.markers);
            });
            var rows = pts.map(function (w) {
                return '<div class="smap-hist-stat"><span class="k">🚑 ' + esc(w.unit || '—') + '</span><span class="v" style="direction:rtl">' + esc(w.location || '—') + '</span></div>';
            }).join('');
            dockBody(
                '<div class="smap-hist-stat"><span class="k">نوافذ تمركز في النطاق</span><span class="v">' + (cov.positioning ? cov.positioning.windowsCount : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">وحدات متمركزة</span><span class="v">' + (cov.positioning && cov.positioning.units ? cov.positioning.units.length : '—') + '</span></div>'
                + '<div class="smap-hist-h">نقاط التمركز الفعلية</div>'
                + (rows || '<div class="smap-empty">لا تمركزات مسجلة في هذا النطاق</div>')
                + '<div class="smap-hist-note">من سجل positioning_events الفعلي فقط — الفرقة بلا تمركز مسجل لا يُخمَّن مكانها.</div>'
            );
        }).catch(fail);
    }

    // ---------- تبويب دعم القرار ----------
    function renderDecision() {
        loading();
        fetchAnalytics('recommendations').then(function (rec) {
            if (!on || tab !== 'decision') return;
            clearLayers(); dockHead();
            var cands = rec.candidates || [];
            cands.slice(0, 8).forEach(function (c, i) {
                var m = L.circleMarker([c.lat, c.lng], {
                    radius: 11, color: c.weakCoverage ? '#EF4444' : '#22C55E', weight: 2.5,
                    fillColor: c.weakCoverage ? '#EF4444' : '#22C55E', fillOpacity: .35
                });
                var sim = c.simulation || {};
                m.bindPopup('<div class="hist-zone-pop"><div class="t" style="color:#15803D">مرشح تمركز #' + (i + 1) + ' — درجة ' + c.score + '</div>'
                    + '<div class="r"><span class="k">مبني على</span><span class="v">' + c.basedOnIncidents + ' بلاغًا</span></div>'
                    + '<div class="r"><span class="k">متوسط الوصول</span><span class="v">' + minTxt(c.avgArrivalMin) + '</span></div>'
                    + '<div class="r"><span class="k">بلاغات ضمن ' + (sim.radiusKm || '—') + ' كم</span><span class="v">' + (sim.incidentsWithin != null ? sim.incidentsWithin : '—') + ' (' + (sim.sharePct != null ? sim.sharePct + '%' : '—') + ')</span></div>'
                    + '<div class="r"><span class="k">متوسط استجابتها / النطاق</span><span class="v">' + minTxt(sim.avgArrivalMin) + ' / ' + minTxt(sim.rangeAvgArrivalMin) + '</span></div>'
                    + '<div class="r"><span class="k">أقرب تمركز تاريخي</span><span class="v">' + kmTxt(c.nearestHistoricalPositioningKm) + '</span></div></div>');
                m.addTo(layers.markers);
            });
            var wins = (rec.suggestedWindows || []).map(function (w) {
                return '<div class="smap-hist-stat"><span class="k">' + WEEKDAYS[w.weekday] + ' <span style="direction:ltr;unicode-bidi:isolate;display:inline-block">' + pad2(w.hour) + ':00–' + pad2((w.hour + 1) % 24) + ':00</span></span><span class="v">' + w.count + '</span></div>';
            }).join('');
            var cs = rec.coverageSummary || {};
            dockBody(
                '<div class="smap-hist-warn">📊 ' + esc(rec.disclaimer || 'دعم قرار فقط — لا تنفيذ تلقائي') + '</div>'
                + '<div class="smap-hist-stat"><span class="k">مناطق طلب / ضعيفة التغطية</span><span class="v">' + (cs.zonesCount != null ? cs.zonesCount : '—') + ' / ' + (cs.weakZonesCount != null ? cs.weakZonesCount : '—') + '</span></div>'
                + '<div class="smap-hist-stat"><span class="k">متوسط وصول النطاق</span><span class="v">' + minTxt(cs.responseAvgArrival) + '</span></div>'
                + '<div class="smap-hist-h">مرشحو التمركز (أعلى درجة أولًا)</div>'
                + cands.slice(0, 5).map(function (c, i) {
                    return '<div class="smap-hist-zone" data-lat="' + c.lat + '" data-lng="' + c.lng + '">'
                        + '<div class="z-head"><span>#' + (i + 1) + ' — درجة ' + c.score + '</span>'
                        + '<span class="smap-hist-badge ' + (c.weakCoverage ? 'weak' : 'ok') + '">' + (c.weakCoverage ? 'فجوة' : 'مدعوم') + '</span></div>'
                        + '<div class="z-sub">' + c.basedOnIncidents + ' بلاغًا · وصول ' + minTxt(c.avgArrivalMin) + ' · ضمن 3كم: ' + (c.simulation ? c.simulation.incidentsWithin : '—') + ' بلاغًا</div>'
                        + '</div>';
                }).join('')
                + '<div class="smap-hist-h">نوافذ تستحق إعادة توزيع التمركز</div>'
                + (wins || '<div class="smap-empty">—</div>')
                + '<div class="smap-hist-note">المحاكاة اشتقاق من البلاغات التاريخية الفعلية وليست تقديرًا نظريًا.</div>'
            );
        }).catch(fail);
    }

    function renderTab() {
        if (!on) return;
        dockHead();
        if (tab === 'density') renderDensity();
        else if (tab === 'zones') renderZones(false);
        else if (tab === 'patterns') renderPatterns();
        else if (tab === 'positioning') renderPositioning();
        else if (tab === 'gaps') renderZones(true);
        else if (tab === 'decision') renderDecision();
    }

    // ---------- التوصيل ----------
    function wire() {
        var btn = el('smapHistoryBtn');
        if (btn) btn.addEventListener('click', function () { on ? exit() : enter(); });
        var apply = el('histApply');
        if (apply) apply.addEventListener('click', function () { fittedFor = null; renderTab(); });
        var tabs = document.querySelectorAll('.smap-hist-tab');
        for (var i = 0; i < tabs.length; i++) {
            (function (t) {
                t.addEventListener('click', function () {
                    tab = t.getAttribute('data-tab');
                    var all = document.querySelectorAll('.smap-hist-tab');
                    for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
                    t.classList.add('active');
                    renderTab();
                });
            })(tabs[i]);
        }
        // الضغط على صف في اللوحة يقود الخريطة التاريخية لموقعه ويفتح نافذة المنطقة
        // (قائمة بلاغاتها الفعلية)؛ أزرار البلاغات داخل الصف لها معالجها الخاص
        var dock = el('histDockBody');
        if (dock) dock.addEventListener('click', function (e) {
            if (e.target.closest && e.target.closest('.hist-inc-btn')) return; // زر بلاغ — يفتح بطاقته مباشرة
            var z = e.target.closest ? e.target.closest('.smap-hist-zone') : null;
            if (!z || !hmap) return;
            var lat = parseFloat(z.getAttribute('data-lat')), lng = parseFloat(z.getAttribute('data-lng'));
            if (isFinite(lat) && isFinite(lng)) hmap.setView([lat, lng], 14);
            var key = z.getAttribute('data-key');
            var circ = key && zoneCircles[key];
            if (circ && circ.openPopup) circ.openPopup();
        });
    }

    // الواجهة العامة — أزرار البلاغات داخل النوافذ واللوحة تستدعي فتح البطاقة
    window.MapHistory = { openIncident: openIncident };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
