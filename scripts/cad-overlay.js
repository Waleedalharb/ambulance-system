/* ═══ «＋ تسجيل للجنوب» — CAD Overlay (مكوّن معتمد من المشروع، ليس PoC) ═══
   (قرار المالك 2026-08-20): CAD ← ضغطة واحدة ← المنصة ← إحصائية دقيقة + أزمنة.
   التشغيل: إضافة المتصفح extension/ (تلقائية عند فتح نطاق CAD) — أو الحقن اليدوي
   node scripts/inject-cad-overlay.js كبديل تطويري.
   - CAD مصدر قراءة فقط: لا نرسل له شيئًا ولا نضغط أي إجراء فيه ولا نغيّره.
   - المراقبة سلبية: نلتقط فقط الاستجابات التي يحمّلها تطبيق CAD بنفسه
     (الموقع/الإحداثيات/المراحل) ولا نطلق أي طلب إضافي نحو CAD.
   - رقم البلاغ من الرابط + رمز ProQA + الفرقة + أزمنة المراحل + الإحداثيات الأصلية.
   - التسجيل والإحصائية من خادم المنصة (POST/GET /api/cad-reports) — لا تخزين محلي.
   - المنع من التكرار بنيوي في الخادم: رقم البلاغ هو المفتاح.
   - تبديل/إلغاء الفرقة يُحدَّث وفق قواعد المحرك (الملغاة بلا تحرك لا تُحتسب).
   - شاشة الموظف مفلترة على الجنوب: الحارس صامت؛ لا يظهر إلا مع «جميع القطاعات»
     (فرقة غير جنوبية ← منع صريح) أو غياب فرقة ظاهرة (رقاقات).
   - الفصل الأمني (قرار المالك 2026-08-20): هذا الملف لا يحمل أي مفتاح أو سر.
     الإرسال للمنصة يمر عبر postMessage إلى جسر الإضافة المعزول ثم خلفيتها —
     المكان الوحيد الذي يحمل مفتاح التكامل هو background.js في سياق الإضافة،
     وهو مقصور على POST /api/cad-reports ويُلغى بعد التجربة، وبلا قراءة أو نقل
     لأي Session Token من أي تبويب.
   - فشل التقاط الإحداثيات ← تُسجل null بصدق ويظهر البلاغ في «بلاغات بلا موقع»
     (لا إحداثيات مختلقة ولا Geocoding خارجي). */
(() => {
  if(window.__SOUTH_POC__){
    ['southPocDock','southPocBtn','southPocStatsBtn','southPocTimesBtn','southPocToast','southPocPanel'].forEach(id => {
      const el = document.getElementById(id); if(el) el.remove();
    });
  }
  window.__SOUTH_POC__ = true;

  /* ─── الالتقاط السلبي لإحداثيات البلاغ الأصلية (اعتماد المالك 2026-08-20) ───
     لا نطلق أي طلب ولا نقرأ ترويسة ولا نلمس الجلسة: نراقب فقط الاستجابات التي
     يجلبها تطبيق CAD بنفسه، ونلتقط latitude/longitude إن مرّت في استجابة موقع.
     الربط صارم: الإحداثيات تُنسب للبلاغ فقط إن جاءت من استجابة تحمل رقمه أو
     location_id المرتبط به — وإلا تبقى null بصدق (لا اختراع ولا نقل بين بلاغات). */
  const geo = window.__southGeo = window.__southGeo || { byIncident: {}, locOfIncident: {}, byLocId: {} };
  // CAD يعيد الإحداثيات نصوصًا ("24.490789") لا أرقامًا — نقبل الاثنين مع تحقق صارم
  // بالنطاق، ونرفض الفراغ والقيم غير الرقمية (لا اختراع إحداثيات).
  function numOrNull(v){
    if(typeof v === 'number') return Number.isFinite(v) ? v : null;
    if(typeof v === 'string' && v.trim() !== ''){ const n = Number(v); return Number.isFinite(n) ? n : null; }
    return null;
  }
  function scanGeo(o, depth){
    if(!o || typeof o !== 'object' || depth > 6) return null;
    let lat = null, lng = null;
    for(const k of Object.keys(o)){
      const v = o[k];
      if(/^lat(itude)?$/i.test(k)){ const n = numOrNull(v); if(n !== null) lat = n; }
      else if(/^(lng|long|longitude)$/i.test(k)){ const n = numOrNull(v); if(n !== null) lng = n; }
    }
    if(lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    for(const k of Object.keys(o)){ const r = scanGeo(o[k], depth + 1); if(r) return r; }
    return null;
  }
  function handleCadResponse(url, j){
    try{
      if(!j || typeof j !== 'object') return;
      // مورد الحدث بصورتيه (events/{id} وevents/edit/{id}): يحمل location_id
      // وكائن location الكامل — منه نأخذ latitude/longitude الأصليين فقط
      let m = url.match(/event-manager\/api\/events\/(?:edit\/)?(\d+)/);
      if(m){
        const loc = j.location || (j.data && j.data.location);
        const lid = j.location_id || (j.data && j.data.location_id) || (loc && loc.id);
        if(lid && geo.locOfIncident[m[1]] !== String(lid)){
          geo.locOfIncident[m[1]] = String(lid);
          lifeLog('location_id', { incident: m[1], locationId: String(lid) });
        }
        const latN = loc ? numOrNull(loc.latitude) : null;
        const lngN = loc ? numOrNull(loc.longitude) : null;
        if(loc && latN !== null && lngN !== null &&
           latN >= -90 && latN <= 90 && lngN >= -180 && lngN <= 180){
          const prev = geo.byIncident[m[1]];
          if(!prev || prev.lat !== latN || prev.lng !== lngN){
            geo.byIncident[m[1]] = { lat: latN, lng: lngN };
            lifeLog('geo', { incident: m[1], lat: latN, lng: lngN });
          }
        }
      }
      m = url.match(/location-manager\/api\/locations\/(\d+)/);
      if(m){ const g = scanGeo(j, 0); if(g) geo.byLocId[m[1]] = g; }
      m = url.match(/\/incidents\/(\d+)/);
      if(m){
        const g = scanGeo(j, 0); if(g) geo.byIncident[m[1]] = g;
        const lid = j.location_id || (j.data && j.data.location_id);
        if(lid) geo.locOfIncident[m[1]] = String(lid);
      }
    }catch(e){}
  }
  function coordsFor(number){
    const direct = geo.byIncident[number]; if(direct) return direct;
    const lid = geo.locOfIncident[number];
    if(lid && geo.byLocId[lid]) return geo.byLocId[lid];
    return null; // لم تمرّ إحداثيات هذا البلاغ ← null بصدق
  }
  /* استكمال الإحداثيات بـlocation_id (اعتماد المالك 2026-08-20 — يفعَّل 2026-08-21
     بعد أن أثبتت البيانات أن الالتقاط السلبي وحده لا يكفي: 73/74 بلاغًا بلا إحداثيات):
     عند التسجيل، إن عرفنا location_id ولم تصل الإحداثيات سلبيًا نقرأ مورد الموقع
     مرة واحدة بنفس جلسة الصفحة (fetch من سياق الصفحة — بلا توكن ولا استخراج جلسة).
     الفشل أو الغياب ← null بصدق، ولا تُخترع إحداثيات إطلاقًا. */
  async function fetchCoordsByLocId(lid){
    try{
      const res = await window.fetch(location.origin + '/location-manager/api/locations/' + encodeURIComponent(lid), { credentials: 'same-origin' });
      if(!res || !res.ok) return null;
      const j = await res.json().catch(() => null);
      const g = scanGeo(j, 0);
      if(g){ geo.byLocId[String(lid)] = g; return g; }
    }catch(e){}
    return null;
  }
  async function coordsEnsured(number){
    const have = coordsFor(number); if(have) return have;
    const lid = geo.locOfIncident[number];
    if(lid) return await fetchCoordsByLocId(lid);
    return null;
  }
  if(!window.__southGeoHooked){
    window.__southGeoHooked = true;
    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m2, u){ this.__southUrl = u; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function(){
      this.addEventListener('load', function(){
        try{
          const u = String(this.__southUrl || '');
          if(!/(event-manager|location-manager)\/api|cad-proxy/.test(u)) return;
          if(typeof this.responseText === 'string' && this.responseText.charAt(0) !== '<')
            window.__southHandleCadResponse(u, JSON.parse(this.responseText));
        }catch(e){}
      });
      return XS.apply(this, arguments);
    };
    const OF = window.fetch.bind(window);
    window.fetch = async function(){
      const res = await OF.apply(null, arguments);
      try{
        const u = String(res.url || '');
        if(/(event-manager|location-manager)\/api|cad-proxy/.test(u))
          res.clone().json().then(j => window.__southHandleCadResponse(u, j)).catch(() => {});
      }catch(e){}
      return res;
    };
  }
  /* المعالج يُحدَّث عند كل إعادة حقن (الخطاف يستدعيه بالمرجع — إعادة الحقن بلا تحديث
     كانت تبقي النسخة القديمة وتفوّت الالتقاط) */
  window.__southHandleCadResponse = handleCadResponse;

  /* ─── قناة المنصة — فصل أمني (قرار المالك 2026-08-20) ───
     هذا السياق (صفحة CAD) لا يحمل أي مفتاح أو سر. الإرسال يمر برسالة
     window.postMessage إلى جسر الإضافة المعزول (bridge.js) ثم خلفية الإضافة
     (background.js — المكان الوحيد للمفتاح، خارج سياق الصفحة تمامًا).
     إن لم تُثبَّت الإضافة يفشل الإرسال برسالة صادقة — لا التفاف ولا سر مضمّن. */
  function sendToPlatform(kind, payload){
    return new Promise((resolve) => {
      const reqId = 'sr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ status: 0, data: { error: 'إضافة منصة الجنوب غير مثبتة أو لا تستجيب — ثبّتها من مجلد extension/ (دليل CAD-OVERLAY-RUNBOOK)' } });
      }, 4000);
      function onMsg(e){
        const d = e.data;
        if(!d || d.source !== 'south-ext-bridge' || d.reqId !== reqId) return;
        clearTimeout(timer); window.removeEventListener('message', onMsg);
        resolve({ status: d.status, data: d.data });
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'south-cad-overlay', kind, reqId, payload }, '*');
    });
  }
  async function apiPost(number, code, type, crews, phases, createdAt, address, region, coords){
    return sendToPlatform('cad-report', { number, code, type, createdAt: createdAt || null, address: address || null, region: region || null,
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null,
      crews: crews.map(c => {
        const o = { team: (typeof c === 'string' ? c : c.team), phases };
        if (typeof c === 'object' && c && c.withdrawn === true) o.withdrawn = true;
        return o;
      }) });
  }
  /* الإحصائية عبر نفس القناة (GET بلا مفتاح — مقصورة سيرفريًا على نافذة المنصة؛
     عند 401 يظهر التنبيه الصادق المعتمد) */
  async function apiStats(){
    return sendToPlatform('cad-stats', null);
  }

  /* فرق قطاع الجنوب من التكميل الفعلي (قرار المالك 2026-08-21 — §5): تُجلب من
     المنصة عبر قناة الإضافة وتُحدَّث دوريًا وتُخزن محليًا؛ القائمة الثابتة احتياط
     صادق عند تعذر الجلب. أي فرقة موجودة في التكميل قابلة للاختيار — لا قائمة محدودة. */
  const SOUTH_TEAMS_FALLBACK = ['جنوب 1','جنوب 2','جنوب 3','جنوب 4','جنوب 5','جنوب 6','جنوب 7','جنوب 8',
                                'سريع 1','سريع 2','سريع 3'];
  let teamsList = SOUTH_TEAMS_FALLBACK;
  try{
    const cached = JSON.parse(localStorage.getItem('southPocTeams') || 'null');
    if(cached && Array.isArray(cached.list) && cached.list.length) teamsList = cached.list;
  }catch(e){}
  async function refreshTeams(){
    try{
      const r = await sendToPlatform('south-teams', null);
      if(r && r.data && r.data.success && Array.isArray(r.data.teams) && r.data.teams.length){
        const list = r.data.teams.map(t => (typeof t === 'string' ? t : t && t.name)).filter(Boolean);
        if(list.length){
          teamsList = list;
          try{ localStorage.setItem('southPocTeams', JSON.stringify({ at: Date.now(), list })); }catch(e){}
        }
      }
    }catch(e){}
  }
  refreshTeams();
  setInterval(refreshTeams, 10 * 60 * 1000);
  const TYPES = {
    medical: { emoji:'🤒', label:'حالة مرضية' }, traffic: { emoji:'🚗', label:'حادث مروري' },
    injury:  { emoji:'🚨', label:'إصابة' },      fire:    { emoji:'🔥', label:'حريق' },
    other:   { emoji:'📦', label:'أخرى' }
  };
  const MPDS_MAP = { traffic:[29], injury:[30,17,21,27,22], fire:[7] };
  function typeFromCode(code){
    const m = /^(\d{1,2})/.exec((code||'').trim());
    if(!m) return 'other';
    const card = parseInt(m[1],10);
    if(card === 32 || card === 23) return 'other'; // «غير معروف» — يُصحَّح بعد ترحيل الفرقة
    for(const t in MPDS_MAP) if(MPDS_MAP[t].includes(card)) return t;
    return 'medical';
  }

  /* ─── الاستخراج من الصفحة (قراءة فقط) ─── */
  const clean = s => (s||'').replace(/[‎‏‪-‮⁦-⁩﻿]/g,'').trim();
  function incidentFromUrl(){ const m = location.href.match(/incidents\/(\d+)/); return m ? m[1] : null; }
  function proqaFromPage(){
    const m = (document.body.innerText||'').match(/\b(\d{1,2}[A-E]\d{2}[A-Z]?)\b/);
    return m ? m[1] : null;
  }
  /* الحالة الحالية للمشاركة (§4 — 2026-08-21): سطر الفرقة في متتبع CAD قد يحمل
     كلمة سحب/إلغاء صريحة — عندها تُرسَل مسحوبة فتُستبعد فورًا من العدّادات
     والمؤقتات والتنبيهات والخريطة. لا استنتاج من الغياب — علامة صريحة فقط. */
  const WITHDRAWN_RE = /(سحب|مسحوب|ألغي|أُلغي|إلغاء)/;
  function crewStatesFromTracker(){
    const out = []; const seen = new Set();
    (document.body.innerText||'').split('\n').forEach(line => {
      const t = clean(line);
      const m = t.match(/([ء-يA-Za-z][ء-يA-Za-z\s]*?\d+)\s*[-–]\s*\d+/);
      if(m && m[1].length < 30 && !seen.has(m[1])){
        seen.add(m[1]);
        out.push({ name: m[1].trim(), withdrawn: WITHDRAWN_RE.test(t) });
      }
    });
    return out;
  }
  function mapToSouthTeam(cadCrew){
    const name = (cadCrew || '').trim();
    let m = name.match(/سريع\s*جنوب\s*(\d+)/);
    if(m && teamsList.includes('سريع ' + m[1])) return 'سريع ' + m[1];
    m = name.match(/سريع\s*(\d+)/);
    if(m && teamsList.includes('سريع ' + m[1])) return 'سريع ' + m[1];
    m = name.match(/جنوب\s*(\d+)/);
    if(m && teamsList.includes('جنوب ' + m[1])) return 'جنوب ' + m[1];
    // تطابق تام مع أي اسم في تكميل المناوبة — يغطي الأسماء غير النمطية (§5)
    const exact = teamsList.find(t => t === name);
    return exact || null; // قطاع آخر ← null ← لا تسجيل تلقائي
  }

  /* ─── أزمنة المراحل: اسم المرحلة في سطر ووقتها في السطر الذي يليه ─── */
  const PHASES = ['قبول','الاستجابة','التحرك','الوصول','البحث','العلاج','المباشرة','النقل','بدء التسليم','انتهاء التسليم','الجاهزية'];
  const TIME_RE = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|ص|م)?)/i;
  /* وقت إنشاء البلاغ (نقطة بداية مؤشر زمن الاستجابة — تعريف المالك 2026-08-20):
     حقل «التاريخ» في تفاصيل البلاغ يحمل تاريخًا ووقتًا كاملًا — قراءة فقط */
  const DATETIME_RE = /(\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|ص|م)?)/i;
  function incidentCreatedAt(){
    const lines = (document.body.innerText||'').split('\n').map(clean).filter(Boolean);
    for(let i = 0; i < lines.length; i++){
      if(lines[i] === 'التاريخ' || (lines[i].includes('التاريخ') && lines[i].length < 14)){
        for(let k = i; k <= Math.min(i + 2, lines.length - 1); k++){
          const m = lines[k].match(DATETIME_RE);
          if(m) return m[1];
        }
      }
    }
    return null; // لا تاريخ إنشاء ← البلاغ خارج مؤشر الزمن بصدق (لا نخترع مرساة)
  }
  /* موقع البلاغ (طبقة الالتقاط 2026-08-20): العنوان الخام من حقل «العنوان»
     والمنطقة من حقل «المنطقة» — قراءة فقط، والحي يُشتق سيرفريًا من العنوان */
  function fieldAfterLabel(label){
    const lines = (document.body.innerText||'').split('\n').map(clean).filter(Boolean);
    for(let i = 0; i < lines.length; i++){
      if(lines[i] === label || (lines[i].includes(label) && lines[i].length < label.length + 8)){
        if(lines[i + 1]) return lines[i + 1];
      }
    }
    return null;
  }
  function addressFromPage(){ return fieldAfterLabel('العنوان'); }
  function regionFromPage(){ return fieldAfterLabel('المنطقة'); }
  function probeTimes(){
    const out = [];
    const lines = (document.body.innerText||'').split('\n').map(clean).filter(Boolean);
    const seen = new Set();
    lines.forEach((t, i) => {
      PHASES.forEach(p => {
        if((t === p || (t.includes(p) && t.length < p.length + 12)) && !seen.has(p)){
          let time = null, inProgress = false;
          for(let k = i; k <= Math.min(i + 2, lines.length - 1); k++){
            const tm = lines[k].match(TIME_RE);
            if(tm){ time = tm[1]; break; }
            if(lines[k].includes('قيد التقدم')) inProgress = true;
          }
          seen.add(p);
          out.push({ phase: p, time, inProgress });
        }
      });
    });
    return out;
  }
  function phasesObject(){
    const o = {};
    probeTimes().forEach(r => { if(r.time) o[r.phase] = r.time; });
    return o;
  }

  /* ─── الواجهة العائمة — Dock قابل للسحب (قرار المالك 2026-08-21) ───
     كل عناصر الـOverlay داخل حاوية واحدة تُسحب من مقبضها وتحفظ آخر موضع —
     تجميع وتحريك عرضي بحت: لا يمس الالتقاط ولا القناة ولا الفصل الأمني. */
  const css = `
    #southPocDock{position:fixed;left:14px;top:42%;z-index:999999;display:flex;
      flex-direction:column;gap:8px;direction:rtl;align-items:flex-start}
    #southPocGrip{cursor:grab;user-select:none;-webkit-user-select:none;background:#0B1E33;
      color:#7fd8c4;border:1px solid #2E8B7A;border-radius:8px;padding:2px 10px;
      font:700 11px Tahoma;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;gap:8px}
    #southPocGrip:active{cursor:grabbing}
    #southPocClose{background:none;border:none;color:#8A9BB0;cursor:pointer;font:700 11px Tahoma;
      padding:0 3px;border-radius:4px}
    #southPocClose:hover{color:#fff;background:rgba(255,255,255,.12)}
    #southPocLauncher{display:none;background:#0B1E33;color:#7fd8c4;border:1px solid #2E8B7A;
      border-radius:10px;padding:6px 12px;font:700 12px Tahoma;cursor:pointer;
      box-shadow:0 4px 16px rgba(0,0,0,.35)}
    #southPocDock.collapsed #southPocLauncher{display:block}
    #southPocDock.collapsed #southPocBtn,#southPocDock.collapsed #southPocStatsBtn,
    #southPocDock.collapsed #southPocTimesBtn,#southPocDock.collapsed #southPocToast,
    #southPocDock.collapsed #southPocPanel{display:none!important}
    #southPocBtn{background:#2E8B7A;color:#fff;
      border:none;border-radius:12px;padding:13px 18px;font:700 15px Tahoma;cursor:pointer;
      box-shadow:0 4px 16px rgba(0,0,0,.35);direction:rtl}
    #southPocBtn:hover{filter:brightness(1.12)}
    #southPocStatsBtn{background:#1A3A5C;
      color:#E8C84A;border:1px solid #E8C84A;border-radius:12px;padding:10px 14px;font:700 14px Tahoma;
      cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35)}
    #southPocTimesBtn{background:#1A3A5C;
      color:#7fd8c4;border:1px solid #2E8B7A;border-radius:12px;padding:10px 14px;font:700 14px Tahoma;
      cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35)}
    #southPocToast{background:#0B1E33;
      color:#EAF1F8;border:1px solid #2E8B7A;border-radius:12px;padding:14px 18px;font:14px/2 Tahoma;
      direction:rtl;display:none;max-width:340px;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    #southPocPanel{background:#0B1E33;color:#EAF1F8;
      border:1px solid #E8C84A;border-radius:12px;padding:16px;font:14px/2 Tahoma;direction:rtl;
      display:none;max-width:360px;box-shadow:0 6px 20px rgba(0,0,0,.5)}
    .southPocChip{display:inline-block;background:#1A3A5C;border:1px solid rgba(255,255,255,.25);
      color:#fff;border-radius:16px;padding:5px 13px;margin:3px;cursor:pointer;font:13px Tahoma}
    .southPocChip:hover{border-color:#2E8B7A;background:#2E8B7A}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.id = 'southPocBtn'; btn.textContent = '＋ تسجيل للجنوب';
  const statsBtn = document.createElement('button');
  statsBtn.id = 'southPocStatsBtn'; statsBtn.textContent = '📊 إحصائية المنصة';
  const timesBtn = document.createElement('button');
  timesBtn.id = 'southPocTimesBtn'; timesBtn.textContent = '⏱ أوقات الرحلة (قراءة فقط)';
  const toast = document.createElement('div'); toast.id = 'southPocToast';
  const panel = document.createElement('div'); panel.id = 'southPocPanel';
  const dock = document.createElement('div'); dock.id = 'southPocDock';
  const grip = document.createElement('div'); grip.id = 'southPocGrip';
  grip.title = 'اسحب لتحريك لوحة منصة الجنوب إلى أي مكان مناسب';
  const gripLabel = document.createElement('span'); gripLabel.textContent = '⠿ منصة الجنوب';
  const closeBtn = document.createElement('button'); closeBtn.id = 'southPocClose';
  closeBtn.textContent = '✕'; closeBtn.title = 'طيّ اللوحة — تبقى شارة صغيرة لإعادة فتحها';
  grip.append(gripLabel, closeBtn);
  const launcher = document.createElement('button'); launcher.id = 'southPocLauncher';
  launcher.textContent = '🚑 الجنوب'; launcher.title = 'إظهار لوحة منصة الجنوب';
  dock.append(grip, launcher, btn, statsBtn, timesBtn, toast, panel);
  document.body.appendChild(dock);
  (function makeDockDraggable(){
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false, collapsed = false;
    function applyPos(L, T){
      const maxL = Math.max(0, window.innerWidth - dock.offsetWidth);
      const maxT = Math.max(0, window.innerHeight - 40);
      dock.style.right = 'auto';
      dock.style.left = Math.max(0, Math.min(maxL, L)) + 'px';
      dock.style.top = Math.max(0, Math.min(maxT, T)) + 'px';
    }
    function saveUI(){
      try{ localStorage.setItem('southPocDockPos', JSON.stringify({ left: dock.offsetLeft, top: dock.offsetTop, collapsed })); }catch(e){}
    }
    function setCollapsed(v){
      collapsed = !!v;
      dock.classList.toggle('collapsed', collapsed);
      grip.style.display = collapsed ? 'none' : '';
      saveUI();
    }
    try{
      const saved = JSON.parse(localStorage.getItem('southPocDockPos') || 'null');
      if(saved && isFinite(saved.left) && isFinite(saved.top)) applyPos(saved.left, saved.top);
      if(saved && saved.collapsed) setCollapsed(true);
    }catch(e){}
    closeBtn.addEventListener('click', e => { e.stopPropagation(); setCollapsed(true); });
    launcher.addEventListener('click', () => setCollapsed(false));
    // تكيّف مع تغيّر حجم الشاشة: لا تخرج اللوحة خارج الحدود إطلاقًا
    window.addEventListener('resize', () => applyPos(dock.offsetLeft, dock.offsetTop));
    grip.addEventListener('pointerdown', e => {
      if(e.target === closeBtn) return;
      dragging = true; sx = e.clientX; sy = e.clientY; ox = dock.offsetLeft; oy = dock.offsetTop;
      try{ grip.setPointerCapture(e.pointerId); }catch(_){}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', e => {
      if(!dragging) return;
      applyPos(ox + e.clientX - sx, oy + e.clientY - sy);
    });
    grip.addEventListener('pointerup', () => {
      if(!dragging) return;
      dragging = false;
      saveUI();
    });
  })();

  function showToast(html, ms){
    toast.innerHTML = html; toast.style.display = 'block';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.style.display = 'none', ms || 6000);
  }

  async function successToast(number, type, teams, coords){
    const st = await apiStats();
    const total = (st.data && typeof st.data.total === 'number')
      ? 'بلاغات اليوم: <b>' + st.data.total + '</b>'
      : 'الإحصائية في نافذة «توزيع البلاغات» بالمنصة';
    const td = TYPES[type] || TYPES.other;
    showToast('✅ <b style="direction:ltr;display:inline-block">' + number + '</b><br>🚑 ' +
      teams.join(' · ') + '<br>' + td.emoji + ' ' + td.label +
      (coords ? '<br>🌐 <b style="direction:ltr;display:inline-block">' + coords.lat.toFixed(6) + ', ' + coords.lng.toFixed(6) + '</b> <small>(إحداثيات CAD الأصلية)</small>' : '') +
      '<br><b>تم التسجيل في منصة الجنوب</b> — ' + total);
  }

  function bindChips(number, code, type){
    panel.querySelectorAll('.southPocChip').forEach(ch => ch.onclick = async () => {
      panel.style.display = 'none';
      const t = ch.dataset.t;
      if(t === '__cancel'){ showToast('🚫 أُلغي — لم يُسجَّل أي بلاغ.', 3000); return; }
      const coords = await coordsEnsured(number);
      const phasesNow = phasesObject(), createdNow = incidentCreatedAt(), addrNow = addressFromPage(), regionNow = regionFromPage();
      const r = await apiPost(number, code, type, [t], phasesNow, createdNow, addrNow, regionNow, coords);
      if(r.data && r.data.success){
        watchAdd(number, { code, type, crews: [{ team: t }], phases: phasesNow, createdAt: createdNow, address: addrNow, region: regionNow, lat: coords ? coords.lat : null, lng: coords ? coords.lng : null }); // مراقبة + إثراء تلقائي بعد التسجيل
        successToast(number, type, [t], coords);
      }
      else showToast('❌ فشل التسجيل: ' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 6000);
    });
  }
  const chipsHtml = () =>
    teamsList.map(t => '<span class="southPocChip" data-t="' + t + '">' + t + '</span>').join('') +
    '<br><span class="southPocChip" data-t="__cancel" style="border-color:#EF4444;color:#EF4444">إلغاء</span>';

  function askCrewManually(number, code, type){
    panel.innerHTML = '<b>ℹ️ لا تظهر فرقة في هذا البلاغ بعد</b><br>' +
      'البلاغ <b style="direction:ltr;display:inline-block">' + number + '</b> — اختر فرقة الجنوب المستجيبة:<br>' +
      chipsHtml();
    panel.style.display = 'block';
    bindChips(number, code, type);
  }
  function blockOtherSector(number, code, cadCrews){
    panel.innerHTML = '<b>🚫 لم يُسجَّل — الفرقة الظاهرة ليست من قطاع الجنوب</b><br>' +
      'الظاهر في البلاغ: ' + cadCrews.join(' · ') + '<br>' +
      '<small>شاشتك تعرض «جميع القطاعات» غالبًا. إن استجابت فرقة جنوب فعلًا ولم تظهر بعد، اخترها يدويًا:</small><br>' +
      chipsHtml();
    panel.style.display = 'block';
    bindChips(number, code, 'other');
  }

  btn.onclick = async () => {
    const number = incidentFromUrl();
    if(!number){ showToast('⚠️ هذه ليست صفحة بلاغ — افتح بلاغًا من قائمة البلاغات أولًا.', 4000); return; }
    const code = proqaFromPage();
    const type = typeFromCode(code);
    const cadCrews = crewStatesFromTracker();
    const southCrews = cadCrews.map(c => ({ team: mapToSouthTeam(c.name), withdrawn: c.withdrawn })).filter(c => c.team);

    if(!southCrews.length){
      if(cadCrews.length) blockOtherSector(number, code, cadCrews.map(c => c.name));
      else askCrewManually(number, code, type);
      return;
    }

    btn.disabled = true;
    try {
      const coords = await coordsEnsured(number); // الالتقاط السلبي ثم جلب location_id المعتمد عند الحاجة
      const phasesNow = phasesObject(), createdNow = incidentCreatedAt(), addrNow = addressFromPage(), regionNow = regionFromPage();
      const r = await apiPost(number, code, type, southCrews, phasesNow, createdNow, addrNow, regionNow, coords);
      if(r.data && r.data.success){
        // ضغطة واحدة = تسجيل + مراقبة + إثراء تلقائي (قرار المالك 2026-08-21):
        // البلاغ يدخل قائمة المراقبة فورًا — أي موقع/إحداثيات/مرحلة تصل لاحقًا تُرسل تلقائيًا
        watchAdd(number, { code, type, crews: southCrews, phases: phasesNow, createdAt: createdNow, address: addrNow, region: regionNow, lat: coords ? coords.lat : null, lng: coords ? coords.lng : null });
        const wdr = (r.data.withdrawnCrews || []);
        if(!r.data.created && !(r.data.addedCrews || []).length && !wdr.length){
          const st = await apiStats();
          const total = (st.data && st.data.total) ? ' (بلاغات اليوم: ' + st.data.total + ')' : '';
          showToast('📌 البلاغ <b style="direction:ltr;display:inline-block">' + number +
            '</b> مسجل مسبقًا — <b>لم يتضاعف</b>' + total +
            (coords ? '<br>🌐 استُكملت الإحداثيات إن كانت غائبة: <b style="direction:ltr;display:inline-block">' + coords.lat.toFixed(6) + ', ' + coords.lng.toFixed(6) + '</b>' : ''));
        } else {
          successToast(number, type, southCrews.map(c => c.team + (c.withdrawn ? ' (مسحوبة)' : '')), coords);
        }
      } else {
        showToast('❌ فشل التسجيل: ' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 7000);
      }
    } catch(e){
      showToast('❌ تعذر الوصول لمنصة الجنوب — تحقق أنها تعمل محليًا.', 7000);
    } finally { btn.disabled = false; }
  };

  statsBtn.onclick = async () => {
    const r = await apiStats();
    if(r.status === 401){ showToast('🔐 مفتاح التكامل مقصور على التسجيل فقط — الإحصائية متاحة في نافذة «توزيع البلاغات» بالمنصة.', 8000); return; }
    if(!r.data || !r.data.success){ showToast('❌ ' + ((r.data && r.data.error) || ('تعذر جلب إحصائية المنصة (HTTP ' + r.status + ').')), 6000); return; }
    const s = r.data;
    const rows = Object.keys(s.byCrew).sort((a,b)=>s.byCrew[b]-s.byCrew[a]||(a<b?-1:1))
      .map(c => c + ' — <b>' + s.byCrew[c] + '</b>').join('<br>') || 'لا شيء بعد';
    showToast('📊 <b>بلاغات اليوم في منصة الجنوب: ' + s.total + '</b><br>' +
      '🤒 ' + s.byType.medical + ' · 🚗 ' + s.byType.traffic + ' · 🚨 ' + s.byType.injury +
      ' · 🔥 ' + s.byType.fire + ' · 📦 ' + s.byType.other +
      '<br>—— توزيع الفرق ——<br>' + rows +
      '<br><small>من الخادم مباشرة — تُحسب برقم البلاغ لا بعدد الفرق</small>', 25000);
  };

  timesBtn.onclick = () => {
    if(!incidentFromUrl()){ showToast('⚠️ افتح صفحة بلاغ أولًا ثم اضغط مسبار الأوقات.', 4000); return; }
    const rows = probeTimes();
    if(!rows.length){ showToast('⏱ لم أجد مراحل رحلة في هذه الصفحة.', 6000); return; }
    showToast('⏱ <b>أوقات الرحلة (قراءة فقط — لم يُسجَّل شيء):</b><br>' +
      rows.map(r => r.phase + ': <b>' + (r.time || (r.inProgress ? '⏳ قيد التقدم' : '—')) + '</b>').join('<br>'), 25000);
  };

  /* ─── مراقبة ما بعد التسجيل — إثراء تلقائي للبلاغ الموجود (قرار المالك 2026-08-21) ───
     ضغطة واحدة = تسجيل + مراقبة + إثراء. بعد أول تسجيل ناجح يبقى البلاغ تحت
     المراقبة، وأي بيانات تصل لاحقًا من CAD (إحداثيات/عنوان/مراحل/فرقة/وقت إنشاء)
     تُرسل تلقائيًا تحديثًا لنفس رقم البلاغ — الخادم يُثري السجل القائم ولا ينشئ
     بلاغًا جديدًا (رقم البلاغ هو الهوية الثابتة) ويبث للخريطة لحظيًا.
     الإحداثيات: التقاط سلبي أولًا، ثم جلب محدود بـlocation_id (القناة المعتمدة
     2026-08-20) — 6 محاولات بفاصل 45 ثانية كحد أقصى، ثم يبقى بلا إحداثيات بصدق.
     لا إرسال بلا تغيّر فعلي (بصمة لقطة)، ولا إرسال بلا فرقة معروفة. */
  const watch = window.__southWatch = window.__southWatch || { list: {}, order: [] };
  try{
    const savedW = JSON.parse(sessionStorage.getItem('__southWatch') || 'null');
    if(savedW && savedW.list && !watch.order.length){ watch.list = savedW.list; watch.order = savedW.order || []; }
  }catch(e){}
  function watchSave(){ try{ sessionStorage.setItem('__southWatch', JSON.stringify({ list: watch.list, order: watch.order.slice(-30) })); }catch(e){} }
  function snapSig(o){ return JSON.stringify([o.lat != null ? o.lat : null, o.lng != null ? o.lng : null, o.address || null, o.region || null, o.createdAt || null, o.phases || {}, (o.crews || []).map(c => c.team + (c.withdrawn ? '!W' : ''))]); }
  function watchAdd(number, sent){
    if(!number) return;
    if(!watch.list[number]) watch.order.push(number);
    watch.order = watch.order.slice(-30);
    const prev = watch.list[number] || {};
    watch.list[number] = {
      code: sent.code || prev.code || null,
      type: sent.type || prev.type || 'other',
      crews: (sent.crews && sent.crews.length) ? sent.crews : (prev.crews || []),
      phases: Object.assign({}, prev.phases || {}, sent.phases || {}),
      createdAt: sent.createdAt || prev.createdAt || null,
      address: sent.address || prev.address || null,
      region: sent.region || prev.region || null,
      lat: sent.lat != null ? sent.lat : (prev.lat != null ? prev.lat : null),
      lng: sent.lng != null ? sent.lng : (prev.lng != null ? prev.lng : null),
      lastSig: snapSig(sent),
      fetchTries: prev.fetchTries || 0,
      lastFetch: prev.lastFetch || 0,
      at: Date.now()
    };
    watchSave();
  }
  async function watchTick(){
    const now = Date.now();
    const current = incidentFromUrl();
    for(const num of watch.order.slice()){
      const w = watch.list[num];
      if(!w) continue;
      if(now - w.at > 6 * 3600 * 1000){ // دورة مراقبة 6 ساعات كحد أقصى لكل بلاغ
        delete watch.list[num]; watch.order = watch.order.filter(x => x !== num); watchSave(); continue;
      }
      // ① الإحداثيات — الالتقاط السلبي أولًا
      let coords = coordsFor(num);
      // ② جلب محدود بـlocation_id إن عُرف متأخرًا ولم تصل الإحداثيات سلبيًا
      if(!coords && geo.locOfIncident[num] && w.fetchTries < 6 && now - (w.lastFetch || 0) > 45000){
        w.lastFetch = now; w.fetchTries++; watchSave();
        coords = await fetchCoordsByLocId(geo.locOfIncident[num]);
      }
      // ③ لقطة الصفحة — فقط إن كان هذا البلاغ مفتوحًا أمام الموظف الآن
      const onPage = current === num;
      const pageCrews = onPage ? crewStatesFromTracker().map(c => ({ team: mapToSouthTeam(c.name), withdrawn: c.withdrawn })).filter(c => c.team) : [];
      const effCrews = pageCrews.length ? pageCrews : w.crews;
      if(!effCrews.length) continue; // لا إرسال بلا فرقة معروفة — نبقى نراقب
      const snap = {
        lat: coords ? coords.lat : w.lat,
        lng: coords ? coords.lng : w.lng,
        address: onPage ? (addressFromPage() || w.address) : w.address,
        region: onPage ? (regionFromPage() || w.region) : w.region,
        createdAt: onPage ? (incidentCreatedAt() || w.createdAt) : w.createdAt,
        phases: Object.assign({}, w.phases, onPage ? phasesObject() : {}),
        crews: effCrews
      };
      if(snapSig(snap) === w.lastSig) continue; // لا جديد — لا إرسال إطلاقًا
      const gotNewCoords = !!(coords && (w.lat !== coords.lat || w.lng !== coords.lng));
      const r = await apiPost(num, w.code, w.type, effCrews, snap.phases, snap.createdAt, snap.address, snap.region,
        coords || (snap.lat != null && snap.lng != null ? { lat: snap.lat, lng: snap.lng } : null));
      if(r.data && r.data.success){
        watchAdd(num, { code: w.code, type: w.type, crews: effCrews, phases: snap.phases, createdAt: snap.createdAt, address: snap.address, region: snap.region, lat: snap.lat, lng: snap.lng });
        lifeLog('enrich', { incident: num, newCoords: gotNewCoords ? coords : null });
        if(gotNewCoords) showToast('🌐 اكتمل موقع البلاغ <b style="direction:ltr;display:inline-block">' + num + '</b> <b>تلقائيًا</b> — ظهر على خريطة منصة الجنوب<br><b style="direction:ltr;display:inline-block">' + coords.lat.toFixed(6) + ', ' + coords.lng.toFixed(6) + '</b>', 9000);
      }
    }
  }
  if(!window.__southWatchTimer){
    window.__southWatchTimer = setInterval(() => { try{ const f = window.__southWatchTick; if(f) f().catch(() => {}); }catch(e){} }, 12000);
  }
  window.__southWatchTick = watchTick;

  /* ─── مسجل دورة حياة البلاغ — مراقبة سلبية خالصة (قرار المالك 2026-08-20) ───
     لا يتدخل إطلاقًا ولا يطلق طلبات: كل 15 ثانية يلتقط ما يعرضه CAD نفسه
     (رقم البلاغ + أزمنة المراحل الظاهرة + الإحداثيات الملتقطة) ويخزن التغييرات فقط.
     الهدف: إثبات أن العين السلبية تغطي دورة البلاغ كاملة: إنشاء ← موقع ← فرقة
     ← قبول ← تحرك ← بحث/وصول ← علاج/مباشرة. يُحفظ على window + sessionStorage
     (تخزين التبويب المحلي فقط — لا يُرسل شيء لـCAD ولا يقرأ جلسته). */
  const life = window.__southLife = window.__southLife || { events: [] };
  try{
    const saved = sessionStorage.getItem('__southLife');
    if(saved && !life.events.length) life.events = JSON.parse(saved);
  }catch(e){}
  function lifeLog(kind, data){
    life.events.push(Object.assign({ t: new Date().toISOString(), kind }, data));
    try{ sessionStorage.setItem('__southLife', JSON.stringify(life.events.slice(-300))); }catch(e){}
  }
  if(!window.__southLifeTimer){
    let lastSig = '';
    window.__southLifeTimer = setInterval(() => {
      try{
        const num = incidentFromUrl();
        if(!num) return;
        const ph = phasesObject();
        const sig = num + '|' + JSON.stringify(ph);
        if(sig !== lastSig){ lastSig = sig; lifeLog('phases', { incident: num, phases: ph }); }
        const c = coordsFor(num);
        if(c && !life.events.some(e => e.kind === 'geo' && e.incident === num))
          lifeLog('geo', { incident: num, lat: c.lat, lng: c.lng });
      }catch(e){}
    }, 15000);
  }

  return 'SouthPoC(platform) injected — مرتبط بمنصة الجنوب';
})()
