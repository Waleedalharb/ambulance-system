/* ============================================================
   MapAdapter — طبقة الخريطة الموحدة (اعتماد المالك 2026-08-28)
   «نقل العين فقط، بلا لمس عقل المنصة»

   المبدأ: Mapbox = مزود رسم قابل للاستبدال فقط. مصدر الحقيقة يبقى
   داخل المنصة (operationalCenters / teamCenterMap / incident_registry /
   positioning_events / map-locations.json) — هذه الطبقة لا تقرأ ولا
   تكتب أي بيانات تشغيلية، ولا تحوّل ولا تشتق ولا تجلب شيئًا بنفسها
   (لا fetch ولا طلبات CAD). كل ما تفعله: ترجمة استدعاءات الرسم
   إلى المزود النشط.

   الاستبدال: MapAdapter.L واجهة موحدة بنفس شكل الاستدعاءات الحالية
   (map/marker/divIcon/circle/circleMarker/polyline/popup/heatLayer/
   layerGroup/tileLayer). المزود الافتراضي leaflet = السلوك القائم
   حرفيًا. عند ضبط window.SMAP_MAP_CONFIG.provider='mapbox' (ملف
   map-config.local.js المحلي — خارج Git مع المفتاح) يُرسم عبر
   Mapbox GL بنفس الواجهة دون تغيير سطر واحد في smart-map/map-history.

   الفشل الآمن: إذا طُلب mapbox والمكتبة غير متاحة ← رجوع تلقائي
   إلى Leaflet (المنصة لا تتعطل بسبب مزود الرسم أبدًا).

   تجهيز مستقبلي (لا تفعيل في هذه المرحلة — اعتماد المالك):
   - Vehicle Location Adapter: setMarkers/updateMarker موجودان أصلًا
     عبر الواجهة (marker.setLatLng يحرّك علامة واحدة بلا إعادة بناء)
     بصيغة {unitId, unitCode, latitude, longitude, timestamp, accuracy}.
   - Traffic/Routing: لا شيفرة لهما هنا إطلاقًا — تُضاف كطبقات فوق
     نفس الواجهة في مرحلة مستقلة معتمدة.
   ============================================================ */
(function () {
    'use strict';

    var cfg = window.SMAP_MAP_CONFIG || {};
    var requested = cfg.provider === 'mapbox' ? 'mapbox' : 'leaflet';

    function mapboxUsable() {
        return typeof window.mapboxgl !== 'undefined' && window.mapboxgl && typeof window.mapboxgl.Map === 'function';
    }
    function leafletUsable() {
        return typeof window.L !== 'undefined' && window.L && typeof window.L.map === 'function';
    }
    // المزود النشط لحظة الاستدعاء — فشل Mapbox لا يُسقط الخريطة إطلاقًا
    function active() {
        if (requested === 'mapbox' && mapboxUsable()) return 'mapbox';
        if (leafletUsable()) return 'leaflet';
        if (mapboxUsable()) return 'mapbox';
        return null;
    }

    // ---------- النمط البصري: Dark Ops / Muted ----------
    // مع مفتاح Mapbox: Dark v11 افتراضيًا (اعتماد المالك 2026-08-31 — داكن
    // هادئ يلائم الواجهة الداكنة، قابل للتجاوز عبر cfg.style).
    // بلا مفتاح (إثبات محلي فقط): نمط raster مؤقت من OSM مُخفَّت الألوان
    // بنفس اتجاه الهوية — يُستبدل بمجرد وضع المفتاح، بلا أي تغيير كود.
    var INTERIM_STYLE = {
        version: 8,
        name: 'south-light-ops-interim',
        sources: {
            osm: {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '© OpenStreetMap — نمط مؤقت محلي بانتظار مفتاح Mapbox'
            }
        },
        layers: [
            { id: 'bg', type: 'background', paint: { 'background-color': '#E9EEF4' } },
            {
                id: 'osm', type: 'raster', source: 'osm',
                paint: { 'raster-saturation': -0.6, 'raster-brightness-min': 0.45, 'raster-brightness-max': 0.96, 'raster-contrast': -0.06 }
            }
        ]
    };
    function resolveStyle() {
        if (cfg.style) return cfg.style;
        if (cfg.accessToken) return 'mapbox://styles/mapbox/dark-v11';
        return INTERIM_STYLE;
    }

    // ---------- أدوات مشتركة ----------
    var uid = 0;
    function nextId(prefix) { return 'smk-mb-' + (prefix || 'x') + '-' + (++uid); }
    function whenReady(fm, fn) {
        if (!fm || !fm.__st) return;
        if (fm.__st.loaded) { try { fn(); } catch (e) { } }
        else fm.__st.queue.push(fn);
    }
    // دائرة جغرافية (نصف قطر بالأمتار) ← مضلّع GeoJSON
    function circlePolygon(center, radiusM, n) {
        var pts = [], R = 6378137, steps = n || 64;
        var lat1 = center[0] * Math.PI / 180, lng1 = center[1] * Math.PI / 180, d = radiusM / R;
        for (var i = 0; i < steps; i++) {
            var brg = 2 * Math.PI * i / steps;
            var lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
            var lng2 = lng1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
            pts.push([lng2 * 180 / Math.PI, lat2 * 180 / Math.PI]);
        }
        pts.push(pts[0]);
        return pts;
    }
    function parseDash(s) {
        if (!s) return null;
        var parts = String(s).split(/[\s,]+/).map(Number).filter(function (x) { return isFinite(x) && x > 0; });
        return parts.length >= 2 ? parts : null;
    }

    // ---------- إثراء النمط Light Operational (اعتماد المالك 2026-08-28) ----------
    // الاتجاه البصري Light معتمد — المطلوب ثراء جغرافي هادئ: طرق أوضح وأسماء
    // شوارع وأحياء مقروءة ومعالم ظاهرة، بلا ازدحام ينافس العلامات التشغيلية.
    // تُطبَّق فوق light-v11 بعد تحميله — تعديل ألوان/حواف فقط، ولا تُضاف ولا
    // تُحذف طبقات. كل ضبط في جدول واحد ليسهل ضبطه بصريًا لاحقًا.
    var LIGHT_OPS_TWEAKS = [
        { re: /^background$/, paint: { 'background-color': '#EDF1F6' } },
        { re: /^water$|^waterway/, paint: { 'fill-color': '#CFDEE9', 'line-color': '#B9CCDC' } },
        { re: /^(landuse|landcover|park|grass|national-park)/, paint: { 'fill-color': '#DFE9DF' } },
        { re: /^building/, paint: { 'fill-color': '#E2E8EE', 'fill-outline-color': '#D3DCE4' } },
        { re: /^road.*(case|casing)/, paint: { 'line-color': '#BEC9D4' } },
        { re: /^road(?!.*(case|casing|label|area))/, paint: { 'line-color': '#FFFFFF' } },
        { re: /^(tunnel|bridge).*(case|casing)/, paint: { 'line-color': '#BEC9D4' } },
        { re: /road.*label/, paint: { 'text-color': '#4E617A', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } },
        { re: /(place|settlement|neighbourhood|neighborhood).*label/, paint: { 'text-color': '#2F4359', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.2 } },
        { re: /poi.*label/, paint: { 'text-color': '#5E7186', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1 } },
        { re: /(transit|airport|aeroway).*label/, paint: { 'text-color': '#5E7186', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1 } },
        { re: /^admin/, paint: { 'line-color': '#9FAFC1' } },
        { re: /(natural|water).*label/, paint: { 'text-color': '#6E87A0', 'text-halo-color': '#FFFFFF', 'text-halo-width': 1 } }
    ];
    function applyLightOpsTweaks(inner) {
        var layers = [];
        try { layers = (inner.getStyle() && inner.getStyle().layers) || []; } catch (e) { return; }
        layers.forEach(function (lay) {
            LIGHT_OPS_TWEAKS.forEach(function (t) {
                if (!t.re.test(lay.id)) return;
                Object.keys(t.paint || {}).forEach(function (k) {
                    try { inner.setPaintProperty(lay.id, k, t.paint[k]); } catch (e) { }
                });
                Object.keys(t.layout || {}).forEach(function (k) {
                    try { inner.setLayoutProperty(lay.id, k, t.layout[k]); } catch (e) { }
                });
            });
        });
    }

    // ---------- ثيم Light Ops لعناصر العرض (اعتماد المالك 2026-08-28) ----------
    // عندما يكون المزود النشط Mapbox تُوسم حاويات الخريطة بكلاس smap-light-ops،
    // فتتحول عناصر العرض الداكنة (حبيبات أسماء الفرق/المراكز، بطاقة القرار،
    // شريط التنبيه، لوحة الذاكرة، نوافذ Mapbox المنبثقة) إلى نسخة فاتحة تلائم
    // خلفية Light Operational. الوسم مشروط بالمزود فقط: في وضع Leaflet (الإنتاج
    // الحالي) لا يُضاف الكلاس أصلًا فتبقى القواعد الداكنة القائمة كما هي حرفيًا.
    function applyLightOpsTheme(containerId) {
        try {
            var el = document.getElementById(containerId);
            if (!el) return;
            var wrap = el.closest ? el.closest('.ops-map-wrap') : null;
            var sec = document.getElementById('opsMapSection');
            [el, wrap, sec].forEach(function (t) {
                if (t && t.classList) t.classList.add('smap-light-ops');
            });
        } catch (e) { }
    }

    // ============================================================
    // مزود Mapbox — ترجمة الواجهة الموحدة إلى Mapbox GL
    // ============================================================
    var MB = {};

    MB.map = function (id, opts) {
        opts = opts || {};
        if (cfg.accessToken) window.mapboxgl.accessToken = cfg.accessToken;
        try {
            // أسماء المعالم العربية تُعرض صحيحة (تحميل كسول — لا يفشل شيء بلاها)
            if (typeof window.mapboxgl.setRTLTextPlugin === 'function') {
                window.mapboxgl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.js', null, true);
            }
        } catch (e) { }
        var styleUsed = resolveStyle();
        var inner = new window.mapboxgl.Map({
            container: id,
            style: styleUsed,
            center: [46.6753, 24.7136], // الرياض — نفس عرض Leaflet الافتراضي
            zoom: 11,
            attributionControl: opts.attributionControl !== false,
            trackResize: opts.trackResize !== false,
            // التفاعل الطبيعي الكامل (اعتماد المالك 2026-08-28): العجلة تكبّر
            // بسلاسة حول المؤشر، سحب بالماوس واللمس، دبل-كليك/دبل-تاب، pinch —
            // الشمال ثابت دائمًا (لا دوران) في شاشة تشغيل تُقرأ لساعات
            scrollZoom: true,
            dragPan: true,
            doubleClickZoom: true,
            touchZoomRotate: true,
            touchPitch: false,
            dragRotate: false,
            keyboard: true,
            cooperativeGestures: false
        });
        try {
            if (inner.dragRotate && inner.dragRotate.disable) inner.dragRotate.disable();
            if (inner.touchZoomRotate && inner.touchZoomRotate.disableRotation) inner.touchZoomRotate.disableRotation();
        } catch (e) { }
        // أزرار + / − دائمة أسفل اليسار (بوصلة ممنوعة — الشمال ثابت).
        // الموضع السفلي يمنع تغطية بطاقة القرار (أعلى اليسار) لها عند فتحها —
        // مراجعة UI 2026-08-28
        try {
            if (typeof window.mapboxgl.NavigationControl === 'function') {
                inner.addControl(new window.mapboxgl.NavigationControl({ showCompass: false, showZoom: true }), 'bottom-left');
            }
        } catch (e) { }
        var st = { loaded: false, queue: [] };
        inner.on('load', function () {
            // إثراء Light Operational فوق النمط الرسمي فقط — النمط المؤقت
            // النقطي لا طبقات متجهة فيه أصلًا
            if (typeof styleUsed === 'string' && /mapbox\/light-v11/.test(styleUsed) && cfg.styleEnrich !== false) {
                try { applyLightOpsTweaks(inner); } catch (e) { }
            }
            st.loaded = true;
            var q = st.queue; st.queue = [];
            q.forEach(function (f) { try { f(); } catch (e) { } });
        });
        // Viewport المستخدم مقدَّس: resize عند Mapbox يحفظ المركز والزوم
        // أصلًا — smart-map يقرأ هذه العلامة فلا يعيد fitBounds فوق تفاعله
        var fm = { __inner: inner, __st: st, __keepViewport: true };
        // ثيم Light Ops للعناصر يُضاف فقط إذا كان النمط المستخدم فاتحًا فعلًا
        // (اعتماد المالك 2026-08-31: dark-v11 يبقى على القواعد الداكنة الأصلية)
        if (typeof styleUsed === 'string' && /\/light-v\d+$/.test(styleUsed)) applyLightOpsTheme(id);
        fm.setView = function (ll, zoom) { inner.jumpTo({ center: [ll[1], ll[0]], zoom: zoom }); return fm; };
        fm.fitBounds = function (pts, o) {
            var b = pts.map(function (p) { return [p[1], p[0]]; });
            var opt = {};
            if (o) { if (o.padding) opt.padding = o.padding[0]; if (o.maxZoom) opt.maxZoom = o.maxZoom; }
            inner.fitBounds(b, opt);
            return fm;
        };
        fm.on = function (ev, fn) { inner.on(ev, fn); return fm; };
        // التكبير الطبيعي دائم في Mapbox — enable يؤكّد، وdisable ممنوع كسره
        fm.scrollWheelZoom = {
            enable: function () { inner.scrollZoom.enable(); },
            disable: function () { /* اعتماد المالك 2026-08-28: العجلة تبقى طبيعية دائمًا */ }
        };
        fm.invalidateSize = function () { inner.resize(); };
        fm.getZoom = function () { return inner.getZoom(); };
        fm.panTo = function (ll) { inner.panTo([ll[1], ll[0]]); return fm; };
        fm.removeLayer = function (layer) {
            if (!layer) return fm;
            if (layer.__removeGroup) layer.__removeGroup();
            else if (layer.__unmount) layer.__unmount();
            return fm;
        };
        return fm;
    };

    MB.tileLayer = function (url, opts) {
        // البلاطات عند Mapbox تأتي من النمط (Style) — هذه الواجهة تبقى لتوافق
        // الشيفرة الحالية؛ خطأ تحميل النمط يُمرَّر لمعالج tileerror نفسه
        var t = { __terr: null };
        t.on = function (ev, fn) { if (ev === 'tileerror') t.__terr = fn; return t; };
        t.addTo = function (fm) { if (t.__terr && fm && fm.__inner) fm.__inner.on('error', function (e) { t.__terr(e); }); return t; };
        return t;
    };

    MB.layerGroup = function () {
        var members = [];
        var g = { __members: members, __onMap: false, __map: null };
        g.addTo = function (fm) { g.__map = fm; g.__onMap = true; members.forEach(function (x) { x.__mount(fm); }); return g; };
        g.clearLayers = function () { members.slice().forEach(function (x) { x.__unmount(); }); members.length = 0; return g; };
        // إزالة عضو واحد فقط — أساس الرسم التفاضلي (اعتماد المالك 2026-08-28)
        g.removeLayer = function (x) {
            var i = members.indexOf(x);
            if (i >= 0) { members.splice(i, 1); x.__unmount(); }
            return g;
        };
        g.__removeGroup = function () { members.forEach(function (x) { x.__unmount(); }); g.__onMap = false; g.__map = null; };
        g.__register = function (x) { members.push(x); if (g.__onMap && g.__map) x.__mount(g.__map); };
        return g;
    };

    MB.divIcon = function (opts) { return { __div: true, options: opts || {} }; };

    MB.marker = function (ll, o) {
        o = o || {};
        var el = document.createElement('div');
        if (o.icon && o.icon.__div) {
            el.className = o.icon.options.className || '';
            el.innerHTML = o.icon.options.html || '';
        }
        if (o.zIndexOffset) el.style.zIndex = String(500 + o.zIndexOffset);
        var anchor = (o.icon && o.icon.options.iconAnchor) || [0, 0];
        var mk = null;
        var f = { __ll: ll, __map: null };
        f.on = function (ev, fn) {
            if (ev === 'click') el.addEventListener('click', function (e) { fn({ originalEvent: e }); });
            return f;
        };
        f.addTo = function (t) { if (t && t.__register) t.__register(f); else if (t) f.__mount(t); return f; };
        f.getElement = function () { return el; };
        f.getLatLng = function () { return { lat: f.__ll[0], lng: f.__ll[1] }; };
        // تحديث علامة واحدة بلا إعادة بناء الخريطة — أساس Vehicle Location مستقبلًا
        f.setLatLng = function (nll) { f.__ll = nll; if (mk) mk.setLngLat([nll[1], nll[0]]); return f; };
        f.__mount = function (fm) {
            if (mk) return;
            f.__map = fm;
            mk = new window.mapboxgl.Marker({ element: el, anchor: 'top-left', offset: [-anchor[0], -anchor[1]] })
                .setLngLat([f.__ll[1], f.__ll[0]]).addTo(fm.__inner);
        };
        f.__unmount = function () { if (mk) { mk.remove(); mk = null; } f.__map = null; };
        return f;
    };

    function addShapePopup(fm, layerId, getHtml, popOpts) {
        fm.__inner.on('click', layerId, function (e) {
            var html = getHtml();
            if (!html) return;
            new window.mapboxgl.Popup({ closeButton: popOpts.closeButton !== false, maxWidth: (popOpts.maxWidth || 300) + 'px' })
                .setLngLat(e.lngLat).setHTML(html).addTo(fm.__inner);
        });
        fm.__inner.on('mouseenter', layerId, function () { fm.__inner.getCanvas().style.cursor = 'pointer'; });
        fm.__inner.on('mouseleave', layerId, function () { fm.__inner.getCanvas().style.cursor = ''; });
    }

    MB.circle = function (center, o) {
        o = o || {};
        var f = { __center: center, __pop: null, __popOpts: {}, __map: null, __ids: null };
        f.bindPopup = function (html, po) { f.__pop = html; f.__popOpts = po || {}; return f; };
        f.openPopup = function () {
            if (f.__map && f.__pop) {
                new window.mapboxgl.Popup({ closeButton: f.__popOpts.closeButton !== false, maxWidth: (f.__popOpts.maxWidth || 300) + 'px' })
                    .setLngLat([center[1], center[0]]).setHTML(f.__pop).addTo(f.__map.__inner);
            }
            return f;
        };
        f.addTo = function (t) { if (t && t.__register) t.__register(f); else if (t) f.__mount(t); return f; };
        f.__mount = function (fm) {
            if (f.__ids) return;
            f.__map = fm;
            var sid = nextId('circle'), fid = sid + '-fill', lid = sid + '-line';
            f.__ids = { s: sid, ls: [fid, lid] };
            whenReady(fm, function () {
                if (fm.__inner.getSource(sid)) return;
                fm.__inner.addSource(sid, {
                    type: 'geojson',
                    data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circlePolygon(center, o.radius || 100)] } }
                });
                fm.__inner.addLayer({
                    id: fid, type: 'fill', source: sid,
                    paint: { 'fill-color': o.fillColor || o.color || '#2E8B7A', 'fill-opacity': o.fillOpacity != null ? o.fillOpacity : 0.15 }
                });
                fm.__inner.addLayer({
                    id: lid, type: 'line', source: sid,
                    paint: { 'line-color': o.color || '#2E8B7A', 'line-width': o.weight || 1.5, 'line-opacity': o.opacity != null ? o.opacity : 0.8 }
                });
                addShapePopup(fm, fid, function () { return f.__pop; }, f.__popOpts);
            });
        };
        f.__unmount = function () {
            var fm = f.__map;
            if (fm && f.__ids) {
                whenReady(fm, function () {
                    f.__ids.ls.forEach(function (l) { if (fm.__inner.getLayer(l)) fm.__inner.removeLayer(l); });
                    if (fm.__inner.getSource(f.__ids.s)) fm.__inner.removeSource(f.__ids.s);
                });
            }
            f.__ids = null; f.__map = null;
        };
        return f;
    };

    MB.circleMarker = function (ll, o) {
        o = o || {};
        var f = { __pop: null, __popOpts: {}, __map: null, __ids: null };
        f.bindPopup = function (html, po) { f.__pop = html; f.__popOpts = po || {}; return f; };
        f.addTo = function (t) { if (t && t.__register) t.__register(f); else if (t) f.__mount(t); return f; };
        f.__mount = function (fm) {
            if (f.__ids) return;
            f.__map = fm;
            var sid = nextId('cm'), lid = sid + '-c';
            f.__ids = { s: sid, ls: [lid] };
            whenReady(fm, function () {
                if (fm.__inner.getSource(sid)) return;
                fm.__inner.addSource(sid, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [ll[1], ll[0]] } } });
                fm.__inner.addLayer({
                    id: lid, type: 'circle', source: sid,
                    paint: {
                        'circle-radius': o.radius || 6,
                        'circle-color': o.fillColor || o.color || '#2E8B7A',
                        'circle-opacity': o.fillOpacity != null ? o.fillOpacity : 1,
                        'circle-stroke-color': o.color || '#2E8B7A',
                        'circle-stroke-width': o.weight != null ? o.weight : 1,
                        'circle-stroke-opacity': o.opacity != null ? o.opacity : 1
                    }
                });
                addShapePopup(fm, lid, function () { return f.__pop; }, f.__popOpts);
            });
        };
        f.__unmount = function () {
            var fm = f.__map;
            if (fm && f.__ids) {
                whenReady(fm, function () {
                    f.__ids.ls.forEach(function (l) { if (fm.__inner.getLayer(l)) fm.__inner.removeLayer(l); });
                    if (fm.__inner.getSource(f.__ids.s)) fm.__inner.removeSource(f.__ids.s);
                });
            }
            f.__ids = null; f.__map = null;
        };
        return f;
    };

    MB.polyline = function (latlngs, o) {
        o = o || {};
        var f = { __map: null, __ids: null };
        f.addTo = function (t) { if (t && t.__register) t.__register(f); else if (t) f.__mount(t); return f; };
        f.__mount = function (fm) {
            if (f.__ids) return;
            f.__map = fm;
            var sid = nextId('line'), lid = sid + '-l';
            f.__ids = { s: sid, ls: [lid] };
            whenReady(fm, function () {
                if (fm.__inner.getSource(sid)) return;
                fm.__inner.addSource(sid, {
                    type: 'geojson',
                    data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: latlngs.map(function (p) { return [p[1], p[0]]; }) } }
                });
                var paint = { 'line-color': o.color || '#3DB39B', 'line-width': o.weight || 2, 'line-opacity': o.opacity != null ? o.opacity : 0.75 };
                var layout = {};
                var dash = parseDash(o.dashArray);
                if (dash) paint['line-dasharray'] = dash;
                fm.__inner.addLayer({ id: lid, type: 'line', source: sid, paint: paint, layout: layout });
            });
        };
        f.__unmount = function () {
            var fm = f.__map;
            if (fm && f.__ids) {
                whenReady(fm, function () {
                    f.__ids.ls.forEach(function (l) { if (fm.__inner.getLayer(l)) fm.__inner.removeLayer(l); });
                    if (fm.__inner.getSource(f.__ids.s)) fm.__inner.removeSource(f.__ids.s);
                });
            }
            f.__ids = null; f.__map = null;
        };
        return f;
    };

    MB.popup = function (opts) {
        opts = opts || {};
        var p = { __ll: null, __html: '' };
        p.setLatLng = function (ll) { p.__ll = ll; return p; };
        p.setContent = function (h) { p.__html = h; return p; };
        p.openOn = function (fm) {
            if (p.__ll && fm && fm.__inner) {
                new window.mapboxgl.Popup({ closeButton: opts.closeButton !== false, maxWidth: (opts.maxWidth || 300) + 'px' })
                    .setLngLat([p.__ll[1], p.__ll[0]]).setHTML(p.__html).addTo(fm.__inner);
            }
            return p;
        };
        return p;
    };

    // طبقة الكثافة — تدرّج هوية المنصة (Teal ← Gold ← Red)
    MB.heatLayer = function (pts, o) {
        o = o || {};
        var f = { __pts: pts || [], __map: null, __sid: null };
        function toData() {
            return {
                type: 'FeatureCollection',
                features: f.__pts.map(function (p) {
                    return { type: 'Feature', properties: { weight: p[2] != null ? p[2] : 1 }, geometry: { type: 'Point', coordinates: [p[1], p[0]] } };
                })
            };
        }
        f.setLatLngs = function (np) {
            f.__pts = np || [];
            if (f.__map && f.__sid) {
                var fm = f.__map;
                whenReady(fm, function () { var s = fm.__inner.getSource(f.__sid); if (s) s.setData(toData()); });
            }
            return f;
        };
        f.addTo = function (t) { if (t && t.__register) t.__register(f); else if (t) f.__mount(t); return f; };
        f.__mount = function (fm) {
            if (f.__sid) return;
            f.__map = fm;
            var sid = nextId('heat'), lid = sid + '-h';
            f.__sid = sid; f.__lid = lid;
            whenReady(fm, function () {
                if (fm.__inner.getSource(sid)) return;
                fm.__inner.addSource(sid, { type: 'geojson', data: toData() });
                fm.__inner.addLayer({
                    id: lid, type: 'heatmap', source: sid, maxzoom: o.maxZoom || 16,
                    paint: {
                        'heatmap-weight': ['get', 'weight'],
                        'heatmap-intensity': 1,
                        'heatmap-radius': o.radius || 28,
                        'heatmap-opacity': 0.85,
                        'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
                            0, 'rgba(46,139,122,0)', 0.35, '#2E8B7A', 0.65, '#E8C84A', 1, '#EF4444']
                    }
                });
            });
        };
        f.__unmount = function () {
            var fm = f.__map;
            if (fm && f.__sid) {
                whenReady(fm, function () {
                    if (fm.__inner.getLayer(f.__lid)) fm.__inner.removeLayer(f.__lid);
                    if (fm.__inner.getSource(f.__sid)) fm.__inner.removeSource(f.__sid);
                });
            }
            f.__sid = null; f.__map = null;
        };
        return f;
    };

    // ============================================================
    // الواجهة الموحدة MapAdapter.L — توجيه لحظي للمزود النشط
    // ============================================================
    var FL = {};
    function route(name) {
        return function () {
            var p = active();
            if (p === 'mapbox') return MB[name].apply(null, arguments);
            if (p === 'leaflet' && window.L && typeof window.L[name] === 'function') return window.L[name].apply(window.L, arguments);
            return undefined;
        };
    }
    ['map', 'tileLayer', 'layerGroup', 'marker', 'divIcon', 'circle', 'circleMarker', 'polyline', 'popup'].forEach(function (n) {
        FL[n] = route(n);
    });
    // الكثافة: Leaflet تحتاج إضافة leaflet.heat وقد تغيب — نحافظ على فحص التوفر نفسه
    FL.heatLayer = function () {
        var p = active();
        if (p === 'mapbox') return MB.heatLayer.apply(null, arguments);
        if (p === 'leaflet' && window.L && typeof window.L.heatLayer === 'function') return window.L.heatLayer.apply(window.L, arguments);
        return undefined;
    };
    FL.DomEvent = {
        stopPropagation: function (e) {
            var p = active();
            if (p === 'leaflet' && window.L && window.L.DomEvent) { window.L.DomEvent.stopPropagation(e); return; }
            if (e && e.stopPropagation) e.stopPropagation();
        }
    };
    // جاهزية المزود — تحل محل فحص «typeof L === 'undefined'» في الوحدات
    FL.__ready = function () { return active() !== null; };

    window.MapAdapter = {
        L: FL,
        provider: active,          // المزود النشط فعلًا الآن
        requested: function () { return requested; },
        version: '1.2.0-2026-08-28'
    };
})();
