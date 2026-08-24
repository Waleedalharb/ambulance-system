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
  /* ختم البناء — تحقق بصري فوري من نسخة الـOverlay المشغَّلة فعليًا في المتصفح
     (تشخيص 2026-08-22: فشل الاختبار الحي سببه أن Chrome كان يشغّل بناءً قديمًا).
     يظهر في تلميح مقبض اللوحة وفي مسجل دورة الحياة — لا منطق ولا سلوك. */
  const OVERLAY_BUILD = '2026-08-24.c — اكتشاف احتمال تكرار البلاغات: التقاط phoneNumber/notes من event-dispatched/detail (تنبيه فقط — القرار في CAD)';
  window.__southBuild = OVERLAY_BUILD;

  /* ─── الالتقاط السلبي لإحداثيات البلاغ الأصلية (اعتماد المالك 2026-08-20) ───
     لا نطلق أي طلب ولا نقرأ ترويسة ولا نلمس الجلسة: نراقب فقط الاستجابات التي
     يجلبها تطبيق CAD بنفسه، ونلتقط latitude/longitude إن مرّت في استجابة موقع.
     الربط صارم: الإحداثيات تُنسب للبلاغ فقط إن جاءت من استجابة تحمل رقمه أو
     location_id المرتبط به — وإلا تبقى null بصدق (لا اختراع ولا نقل بين بلاغات). */
  const geo = window.__southGeo = window.__southGeo || { byIncident: {}, locOfIncident: {}, byLocId: {} };
  // حالات الوحدات الملتقطة من event-dispatched/detail (قرار المالك 2026-08-22) —
  // تنجو من إعادة الحقن مثل geo، وتُقاد بصمةً حتى لا يُعاد إرسال لقطة بلا تغيّر
  const unitsByIncident = window.__southUnits = window.__southUnits || {};
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
  /* هضم وحدات event-dispatched/detail → unitsByIncident (مشترك: الالتقاط السلبي
     والقراءة النشطة للـObserver — اعتماد المالك 2026-08-24). البصمة تشمل الأزمنة:
     تطوّر Journey أي وحدة = لقطة جديدة. يعيد true عند تغيّر فعلي فقط. */
  function ingestDetailUnits(evId, d, via){
    if(!d || !Array.isArray(d.units)) return false;
    const ARRIVAL_STEPS = { AT_PATIENT: 1 };
    // No Journey = No Participation (اعتماد المالك 2026-08-24 — تصحيح دلالي):
    // وحدات «تغيير خطة الاستجابة» اقتراحات CAD للمشغل (متاحة/جاهزة/قريبة) وليست
    // مرتبطة بالبلاغ — لا تُهضم إلا وحدة أنشأ لها CAD رحلة فعلية (Journey/Dispatch)
    const ignored = [];
    const list = d.units.map(u => {
      if(!u || !u.unitCode) return null;
      const jr = Array.isArray(u.journeys) ? u.journeys : [];
      if(!jr.length){ ignored.push(String(u.unitCode)); return null; }
      let lastTimed = null;
      jr.forEach(s => {
        if(s && s.journeyStepTime && (!lastTimed || (s.stepSeq || 0) > (lastTimed.stepSeq || 0))) lastTimed = s;
      });
      return {
        unit: String(u.unitCode),
        urs: u.unitRequestStatus ? String(u.unitRequestStatus).toUpperCase() : null,
        reached: jr.some(s => s && ARRIVAL_STEPS[s.journeyStepCode] && !!s.journeyStepTime),
        lastStep: lastTimed ? lastTimed.journeyStepCode : null,
        // Journey الوحدة الخاصة (قرار المالك 2026-08-23): أزمنة كل وحدة من
        // journeys[] الخاصة بها فقط — لا لقطة مدمجة على مستوى البلاغ إطلاقًا
        phases: phasesFromJourneys(jr),
        unitId: u.unitId != null ? u.unitId : null,        // هوية الوحدة الثابتة (2026-08-23)
        runUnitId: u.runUnitId != null ? u.runUnitId : null // مثبت حيًا: يطابق lastJourneys
      };
    }).filter(Boolean);
    // توثيق الاقتراحات المتجاهلة (قابل للتتبع — لا قرار صامت): وحدات ظهرت في
    // الحمولة بلا Journey = Available Units في نافذة الخطة، ليست مشاركة
    if(ignored.length) lifeLog('available-ignored', { incident: evId, units: ignored, via: via || 'passive' });
    // قراءة ناجحة بلا أي وحدة مرتبطة = لقطة فارغة صادقة تُخزَّن (لا تجميد للقطة
    // قديمة): وحدة فقدت رحلتها أو غابت عن التفاصيل يوثّقها الـObserver «gone»
    const sig = JSON.stringify(list.map(x => x.unit + ':' + (x.urs || '') + ':' + (x.reached ? 1 : 0) + ':' + JSON.stringify(x.phases || {})).sort());
    const prev = unitsByIncident[evId];
    if(!prev || prev.sig !== sig){
      unitsByIncident[evId] = { at: Date.now(), sig, units: list };
      lifeLog('units', { incident: evId, units: list, via: via || 'passive' });
      return true;
    }
    return false;
  }
  function handleCadResponse(url, j){
    try{
      if(!j || typeof j !== 'object') return;
      // ══ مصدر الحقيقة الموثق بالرصد الحي (2026-08-22): CAD نفسه يستطلع كل ~10ث
      // dispatch-manager/api/cfs/v2/{operation-controller|response-coordinator}/incident-list
      // ويعتمد data.items[].eventId في بناء قائمتي «البلاغات المرحلة» و«تنسيق
      // الاستجابة». نقرأ نفس الاستجابات سلبيًا: الحضور يصفّر الغياب دائمًا،
      // والغياب يُحسب فقط من لقطة مكتملة الصفحات (last=true) — لا حكم من صفحة جزئية.
      const lm = url.match(/dispatch-manager\/api\/cfs\/v2\/(operation-controller|response-coordinator)\/(incident-list|awaiting-list)/);
      if(lm){
        const d = j.data;
        if(d && Array.isArray(d.items)){
          const ids = d.items.map(it => it && it.eventId != null ? String(it.eventId) : null).filter(Boolean);
          // awaiting-list = بانتظار الترحيل: وجود البلاغ فيها دليل وجود (تصفير)،
          // وغيابه منها لا يعني شيئًا (قد يكون مرحّلًا) ← presence-only
          const complete = lm[2] === 'awaiting-list' ? false : d.last === true;
          recordListSnapshot(ids, complete);
          // الاكتشاف التلقائي (المرحلة A): من لقطات incident-list المكتملة فقط —
          // القائمة تكتشف والتفاصيل تؤكد (لا اكتشاف من صفحة جزئية ولا من awaiting)
          if(lm[2] === 'incident-list' && d.last === true) autoDiscoverFromItems(d.items);
        }
      }
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
      // ══ حالة الوحدة داخل البلاغ (قرار المالك 2026-08-22 — مصدر موثق بالرصد الحي):
      // صفحة تفاصيل البلاغ في CAD تطلب event-manager/api/v2/event-dispatched/detail
      //?eventId=…&showAbortedCancelledUnits=true ← data.units[] وفيها لكل وحدة
      // unitRequestStatus (A=مقبولة B=ملغاة C=ملغاة R=مرفوضة) وjourneys[] كاملة.
      // شارة «وحدة ملغاة» في واجهة CAD ترسمها الواجهة من هذه القيمة — لا نص في الحمولة.
      // الالتقاط سلبي خالص: نقرأ فقط الاستجابة التي حمّلها تطبيق CAD نفسه.
      // «المباشرة الفعلية» = وقت فعلي في AT_PATIENT (العلاج) فقط — أثبت الاختبار الحي
      // (1306598/جنوب 9-2) أن PATIENT_REACH «البحث» قد يحمل وقتًا لوحدة أُلغيت قبل
      // المباشرة: الوصول للموقع والبحث عن المريض ≠ مباشرة المريض. ولا يُعتمد
      // currentStep دليلًا — المرحلة الجارية وقتها null ولا تُثبت إتمامًا.
      if(/event-manager\/api\/v\d*\/event-dispatched\/detail/.test(url)){
        const d = j.data;
        const evId = (d && d.id != null) ? String(d.id) : ((url.match(/eventId=(\d+)/) || [])[1] || null);
        if(d && evId) ingestDetailUnits(evId, d, 'passive');
      }
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
          if(!/(event-manager|location-manager|dispatch-manager)\/api|cad-proxy/.test(u)) return;
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
        if(/(event-manager|location-manager|dispatch-manager)\/api|cad-proxy/.test(u))
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
  async function apiPost(number, code, type, crews, phases, createdAt, address, region, coords, status, source, extra){
    const payload = { number, code, type, createdAt: createdAt || null, address: address || null, region: region || null,
      lat: coords ? coords.lat : null, lng: coords ? coords.lng : null,
      status: status || null, // الحالة النهائية إن ظهرت صراحة في CAD — غيابها لا يعني شيئًا
      source: source === 'cad-auto' ? 'cad-auto' : undefined, // وسم الاكتشاف التلقائي (المرحلة A)
      crews: crews.map(c => {
        // القاعدة الجذرية (قرار المالك 2026-08-23): أوقات كل فرقة من Journey الخاصة
        // بها فقط. اللقطة المشتركة من الصفحة تُعطى فقط عندما تكون الفرقة الوحيدة
        // في البلاغ (حينها هي فعليًا رحلتها) — مع تعدد الفرق، من لا Journey لها
        // تُرسل phases فارغة ولا تُنسخ لها أوقات فرقة أخرى أبدًا
        const own = (typeof c === 'object' && c && c.phases) ? c.phases : null;
        const o = { team: (typeof c === 'string' ? c : c.team),
          phases: own || (crews.length === 1 ? (phases || {}) : {}) };
        if (own && typeof c === 'object' && c.phasesSource === 'cad-detail') o.phasesSource = 'cad-detail';
        if (typeof c === 'object' && c && c.withdrawn === true) o.withdrawn = true;
        // حالة الوحدة من CAD (قرار المالك 2026-08-22): تُمرَّر خامًا — قاعدة
        // الاحتساب (A/B/C/R × الوصول الفعلي) سيرفرية، لا قرار عدّ في الـOverlay
        if (typeof c === 'object' && c && c.cadUrs) o.cadUrs = c.cadUrs;
        if (typeof c === 'object' && c && (c.cadReached === true || c.cadReached === false)) o.cadReached = c.cadReached;
        if (typeof c === 'object' && c && c.cadUnitId != null) o.cadUnitId = c.cadUnitId;
        if (typeof c === 'object' && c && c.cadRunUnitId != null) o.cadRunUnitId = c.cadRunUnitId;
        return o;
      }) };
    // اكتشاف احتمال التكرار (ملحق note-18): رقم المبلغ/الوصف الملتقطان من
    // event-dispatched/detail يُرسلان خامًا — للمطابقة السيرفرية فقط، بلا عرض
    if(extra && extra.callerNumber) payload.callerNumber = extra.callerNumber;
    if(extra && extra.description) payload.description = extra.description;
    return sendToPlatform('cad-report', payload);
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
     والمؤقتات والتنبيهات والخريطة. لا استنتاج من الغياب — علامة صريحة فقط.
     (2026-08-22): وُسّعت الصيغ — عربي وإنجليزي — لأن CAD لا يلتزم مسمى واحدًا */
  const WITHDRAWN_RE = /(سحب|مسحوب|منسحب|مُلغ[ىية]|ألغي|أُلغي|إلغاء|cancel(l)?ed|withdrawn|removed)/i;
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

  /* ─── مصدر الحقيقة لحالة البلاغ: قائمة البلاغات في CAD (قرار المالك 2026-08-22) ───
     أثبتت التجربة الحية أن قراءة «كلمات الحالة» (مغلق/ملغي/Closed…) من تفاصيل
     البلاغ غير موثوقة في CAD لدينا — أُزيلت تلك الطبقة كلها. المعيار التشغيلي
     الحقيقي: طالما رقم البلاغ موجود في قائمة البلاغات الرئيسية فهو نشط،
     واختفاؤه المؤكد منها = انتهاء تشغيلي (إغلاقًا كان أو إلغاءً — القائمة لا
     تميّز بينهما). الالتقاط سلبي خالص: نقرأ فقط استجابات القائمة التي يحمّلها
     تطبيق CAD نفسه أثناء عمل الموظف الطبيعي — لا طلب إضافي إطلاقًا.
     حارس الاستقرار (نص قرار المالك): لا إنهاء بغياب لحظي (إعادة تحميل القائمة/
     انتقال صفحة/بطء عرض) — يُشترط الغياب في ٣ لقطات مكتملة متتالية + انقضاء
     ٦٠ ثانية منذ آخر رؤية في أي قائمة (CAD يستطلع كل ~10ث ← ٦ دورات كاملة)،
     أو مضي 15 دقيقة على تسجيل بلاغ لم يُرَ في أي قائمة بعد. */
  const LIST_ABSENT_CONFIRM = 3;
  const LIST_GRACE_MS = 15 * 60 * 1000;
  const LIST_SEEN_TIMEOUT_MS = 60 * 1000;
  const listTrack = window.__southListTrack = window.__southListTrack || {};
  /* لقطة قائمة منظمة (items[].eventId من dispatch-manager): الحاضر يصفّر عدّاد
     غيابه ويُحدَّث آخر وقت رؤية دائمًا، والغائب يتصاعد عدّاده فقط إن كانت
     اللقطة مكتملة الصفحات (last=true) — اللقطات الجزئية وawaiting-list لا
     تُثبت غيابًا إطلاقًا */
  function recordListSnapshot(ids, complete){
    const present = new Set(ids);
    for(const num of Object.keys(listTrack)){
      const t = listTrack[num];
      if(present.has(num)){ t.everListed = true; t.absentStreak = 0; t.lastSeenAt = Date.now(); }
      else if(complete) t.absentStreak = (t.absentStreak || 0) + 1;
    }
    watchSave();
  }
  /* تسمية الفرقة من مسمى CAD (قرار المالك 2026-08-23): الاسم يُشتق من نمط الوحدة
     نفسه (جنوب N / سريع N) سواء كانت في التكميل أم لا — المنصة تراقب التشغيل
     الفعلي وليست نسخة من التكميل. فرقة غير مدرجة في التكميل تُسجَّل باسمها المشتق،
     وعند ظهورها لاحقًا في التكميل يطابقها الخادم بسجلها القائم بهوية الوحدة
     (runUnitId) فلا يُنشأ سجل ثانٍ. وحدات القطاعات الأخرى (شرق/غرب/شمال…) لا
     تطابق النمط أصلًا ← null ← لا تسجيل. */
  function mapToSouthTeam(cadCrew){
    const name = (cadCrew || '').trim();
    let m = name.match(/سريع\s*جنوب\s*(\d+)/);
    if(m) return 'سريع ' + m[1];
    m = name.match(/سريع\s*(\d+)/);
    if(m) return 'سريع ' + m[1];
    m = name.match(/جنوب\s*(\d+)/);
    if(m) return 'جنوب ' + m[1];
    // تطابق تام مع أي اسم في تكميل المناوبة — يغطي الأسماء غير النمطية (§5)
    const exact = teamsList.find(t => t === name);
    return exact || null; // قطاع آخر ← null ← لا تسجيل تلقائي
  }

  /* ─── فرق البلاغ من مصدر CAD الحقيقي (قرار المالك 2026-08-22) ───
     crewsFromCadUnits: وحدات event-dispatched/detail الملتقطة سلبيًا، مربوطة بفرق
     الجنوب — تحمل urs (حرف unitRequestStatus) وreached (وقت فعلي في العلاج
     AT_PATIENT فقط — البحث ليس مباشرة، إثبات حي 2026-08-22). لا قرار عدّ هنا: الخادم يطبق قاعدة المشاركة الفعلية المعتمدة.
     mergeCrewSources: دمج بلا فقدان — كل فرقة معروفة من أي مصدر تبقى، ومن لها
     لقطة وحدة من CAD تُرقَّى إليها (مصدر الحقيقة)، والباقي يبقى على علم الصفحة
     (withdrawn من نص المتتبع) كما كان — لا استنتاج إلغاء من مجرد غياب وحدة. */
  function crewsFromCadUnits(num){
    const rec = unitsByIncident[num];
    if(!rec || !Array.isArray(rec.units)) return [];
    const out = []; const seen = new Set();
    for(const u of rec.units){
      const team = mapToSouthTeam(u.unit);
      if(!team || seen.has(team)) continue;
      seen.add(team);
      const c = { team, cadReached: u.reached === true };
      if(u.urs) c.cadUrs = u.urs;
      // Journey الوحدة الخاصة الملتقطة من التفاصيل — مصدرها journeys[] نفسها
      if(u.phases && Object.keys(u.phases).length){ c.phases = u.phases; c.phasesSource = 'cad-detail'; }
      if(u.unitId != null) c.cadUnitId = u.unitId;
      if(u.runUnitId != null) c.cadRunUnitId = u.runUnitId;
      out.push(c);
    }
    return out;
  }
  /* دمج مصادر الفرق (إصلاح 2026-08-24): الترتيب تصاعدي بالحداثة — المخزَّن أولًا
     ثم الصفحة ثم لقطة CAD الطازجة أخيرًا. لقطة الوحدة (cadUrs) ترقّي السابقة،
     ولقطة بلا cadUrs لا تطغى على لقطة وحدة قائمة. الترتيب المعكوس كان يجعل
     المخزَّن القديم يطغى على الطازج فيجمد التحديثات بعد التسجيل التلقائي. */
  function mergeCrewSources(){
    const map = new Map(); // team ← أفضل لقطة معروفة
    const put = (c, upgradeOnly) => {
      if(!c || !c.team) return;
      const prev = map.get(c.team);
      if(!prev){ map.set(c.team, Object.assign({}, c)); return; }
      // لقطة الوحدة (cadUrs) ترقّي السابقة؛ لقطة الصفحة لا تطغى على لقطة وحدة قائمة
      if(c.cadUrs){
        const merged = Object.assign({}, prev, c);
        map.set(c.team, merged);
      } else if(!prev.cadUrs){
        map.set(c.team, Object.assign({}, prev, c));
      }
    };
    for(const list of arguments){ (list || []).forEach(c => put(c)); }
    return Array.from(map.values());
  }

  /* ═══ المرحلة A — الاكتشاف التشغيلي التلقائي (قرار المالك 2026-08-23) ═══
     «القائمة تكتشف، والتفاصيل تؤكد»: incident-list (التي يستطلعها CAD نفسه كل
     ~10ث) تكشف البلاغ الجديد ووحداته عبر items[].lastJourneys[] — بلا أي طلب
     إضافي. عند اكتشاف بلاغ عليه وحدة جنوبية نجلب event-dispatched/detail مرة
     واحدة من سياق الصفحة (نفس قناة location_id المعتمدة 2026-08-21) لتأكيد
     حالة الوحدات (unitRequestStatus) وأوقات الرحلة، ثم نسجّل بوسم cad-auto.
     بعدها: تغيّر lastJourneys (وحدة جديدة/مرحلة تقدمت) = إشارة تستحق التحقق ←
     إعادة قراءة التفاصيل بخنق زمني ٣٠ ثانية. لا طلب مستمر لكل البلاغات إطلاقًا.
     الضوابط الثابتة: وحدات جنوبية فقط (بلاغ بلا وحدة جنوبية لا يدخل) · eventId
     مانع التكرار (الخادم يحدّث نفس الهوية ولا ينشئ) · الزر اليدوي يبقى احتياطيًا
     · سقف ٦٠ بلاغًا تلقائيًا للجلسة · CAD قراءة فقط. */
  const auto = window.__southAuto = window.__southAuto || { seen: {}, queue: [], pumping: false, count: 0, lastItems: {} };
  const AUTO_MAX_PER_SESSION = 60;
  const DETAIL_REFETCH_MS = 30000;
  const JOURNEY_PHASES = { ACCEPTANCE: 'قبول', TURNOUT: 'التحرك', IN_ROUTE: 'الاستجابة', PATIENT_REACH: 'البحث',
    AT_PATIENT: 'العلاج', TO_HOSPITAL: 'النقل', AT_HOSPITAL: 'بدء التسليم', HANDOVER: 'انتهاء التسليم', BACK_TO_SERVICE: 'الجاهزية' };
  function fmtCadTime(iso){
    try{ return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'Asia/Riyadh', hour12: true, hour: 'numeric', minute: '2-digit', second: '2-digit' }); }catch(e){ return null; }
  }
  function fmtCadDateTime(iso){
    try{
      const d = new Date(iso);
      return d.toLocaleDateString('en-US', { timeZone: 'Asia/Riyadh' }) + ' ' + fmtCadTime(iso); // M/D/YYYY h:mm:ss AM — صيغة CAD الخام المعتمدة سيرفريًا
    }catch(e){ return null; }
  }
  function phasesFromJourneys(jr){
    const o = {};
    (Array.isArray(jr) ? jr : []).forEach(s => {
      if(!s || !s.journeyStepTime) return;
      const name = s.journeyStepName ? String(s.journeyStepName).trim() : (JOURNEY_PHASES[s.journeyStepCode] || null);
      if(!name) return;
      const t = fmtCadTime(s.journeyStepTime);
      if(t && !o[name]) o[name] = t; // أقدم وقت موثق للمرحلة — لا استبدال
    });
    return o;
  }
  function crewsFromDetail(d){
    const out = []; const seenT = new Set();
    const ARRIVAL = { AT_PATIENT: 1 }; // المباشرة الفعلية = وقت العلاج فقط (إثبات 1306598)
    for(const u of ((d && d.units) || [])){
      if(!u || !u.unitCode) continue;
      // No Journey = No Participation (2026-08-24): اقتراحات خطة الاستجابة ليست فرقًا مرتبطة
      const jr = Array.isArray(u.journeys) ? u.journeys : [];
      if(!jr.length) continue;
      const team = mapToSouthTeam(String(u.unitCode));
      if(!team || seenT.has(team)) continue;
      seenT.add(team);
      const c = { team, phases: phasesFromJourneys(jr), phasesSource: 'cad-detail',
                  cadReached: jr.some(s => s && ARRIVAL[s.journeyStepCode] && !!s.journeyStepTime) };
      if(u.unitRequestStatus) c.cadUrs = String(u.unitRequestStatus).toUpperCase();
      if(u.unitId != null) c.cadUnitId = u.unitId;         // هوية الوحدة الثابتة — لا اعتماد على ترتيب units[]
      if(u.runUnitId != null) c.cadRunUnitId = u.runUnitId;
      out.push(c);
    }
    return out;
  }
  /* جلب محدود من سياق الصفحة (بلا توكن ولا استخراج جلسة) — نفس نمط
     fetchCoordsByLocId المعتمد: نفس الأصل + كوكيز الصفحة. الفشل ← null بصدق */
  async function fetchIncidentDetail(num){
    try{
      const res = await window.fetch(location.origin + '/event-manager/api/v2/event-dispatched/detail?eventId=' + encodeURIComponent(num) + '&showAbortedCancelledUnits=true', { credentials: 'same-origin' });
      if(!res || !res.ok) return null;
      const j = await res.json().catch(() => null);
      return (j && j.data) ? j.data : null;
    }catch(e){ return null; }
  }
  async function fetchEventLocId(num){
    try{
      const res = await window.fetch(location.origin + '/event-manager/api/events/' + encodeURIComponent(num), { credentials: 'same-origin' });
      if(!res || !res.ok) return;
      const j = await res.json().catch(() => null);
      const lid = j && (j.location_id || (j.data && j.data.location_id));
      if(lid){ geo.locOfIncident[num] = String(lid); lifeLog('location_id', { incident: num, locationId: String(lid) }); }
    }catch(e){}
  }
  /* اكتشاف احتمال التكرار (اعتماد المالك 2026-08-24 — ملحق note-18): التقاط رقم
     المبلغ ووصف البلاغ من حمولة event-dispatched/detail نفسها التي يقرأها الـOverlay
     أصلًا (تحقق خطوة صفر من لقطات حقيقية: phoneNumber/phoneNumberSecondary/notes[]
     موجودة في هذا المسار). لا طلب إضافي إطلاقًا — التقاط من نفس الاستجابة.
     رقم المبلغ بيانات شخصية: يُرسل خامًا للمطابقة السيرفرية فقط ولا يُعرض إطلاقًا. */
  function callerInfoFromDetail(d){
    if(!d) return null;
    const phone = (d.phoneNumber && String(d.phoneNumber).trim()) ||
                  (d.phoneNumberSecondary && String(d.phoneNumberSecondary).trim()) || null;
    // ملاحظات CAD النصية = وصف البلاغ المتاح — تُلتقط كما هي (لا استنتاج ولا اختلاق)
    const descs = (Array.isArray(d.notes) ? d.notes : [])
      .map(n => n && n.description ? String(n.description).trim() : '')
      .filter(Boolean);
    const description = descs.length ? descs.join(' — ').slice(0, 480) : null;
    if(!phone && !description) return null;
    return { callerNumber: phone, description };
  }
  function queueAuto(num, proqa, isUpdate){
    if(auto.queue.some(q => q.num === num)) return;
    auto.queue.push({ num, proqa: proqa || null, isUpdate: !!isUpdate });
  }
  async function pumpAutoQueue(){
    if(auto.pumping) return;
    auto.pumping = true;
    try{
      while(auto.queue.length){
        const q = auto.queue.shift();
        try{ if(q.isUpdate) await autoRefresh(q.num); else await autoRegister(q.num, q.proqa); }catch(e){}
      }
    } finally { auto.pumping = false; }
  }
  /* الاكتشاف من لقطة القائمة المكتملة: بلاغ جديد عليه وحدة جنوبية ← تسجيل تلقائي.
     بلاغ معروف تغيّرت lastJourneys له (وحدة ظهرت/مرحلة تقدمت) ← تحديث مخنوق.
     بلاغ بلا وحدة جنوبية يبقى مرصودًا صامتًا — قد تنضم له وحدة جنوبية لاحقًا */
  function autoDiscoverFromItems(items){
    const now = Date.now();
    for(const it of items){
      const num = it && it.eventId != null ? String(it.eventId) : null;
      if(!num) continue;
      auto.lastItems[num] = it;
      const lj = Array.isArray(it.lastJourneys) ? it.lastJourneys : [];
      const ljSig = JSON.stringify(lj.map(u => String(u.unitCode || '') + ':' + String(u.journeyStepCode || '')).sort());
      const hasSouth = lj.some(u => !!mapToSouthTeam(String(u.unitCode || u.unitNameAr || '')));
      const prev = auto.seen[num];
      if(!prev){
        auto.seen[num] = { ljSig, at: now };
        if(hasSouth && !watch.list[num]) queueAuto(num, it.proQACode);
      } else if(prev.ljSig !== ljSig){
        prev.ljSig = ljSig;
        if(watch.list[num]) queueAuto(num, null, true);         // إشارة تغيّر ← تحقق
        else if(hasSouth) queueAuto(num, it.proQACode);         // انضمت وحدة جنوبية لاحقًا
      }
    }
    pumpAutoQueue();
  }
  async function autoRegister(num, proqa){
    if(watch.list[num]) return; // مسجل (يدويًا أو تلقائيًا) — التحديث مساره autoRefresh
    if(auto.count >= AUTO_MAX_PER_SESSION){ lifeLog('auto-cap', { incident: num }); return; }
    const code = proqa || null;
    const type = typeFromCode(code);
    let crews = [], createdAt = null, address = null, region = null;
    const d = await fetchIncidentDetail(num); // تأكيد مرة واحدة عند الاكتشاف
    if(d){
      crews = crewsFromDetail(d);
      createdAt = d.createdDate ? fmtCadDateTime(d.createdDate) : null;
      address = d.address || null;
      region = d.zoneName || null;
    }
    if(!crews.length){
      // fallback صادق: الوحدات الجنوبية الظاهرة في lastJourneys للقائمة — هي نفسها
      // دليل Journey (الوحدة ظاهرة بمرحلة رحلة) بلا تفاصيل أوقات (لا اختلاق حالة)
      const it = auto.lastItems[num];
      const lj = it && Array.isArray(it.lastJourneys) ? it.lastJourneys : [];
      const seenT = new Set();
      for(const u of lj){
        const team = mapToSouthTeam(String((u && u.unitCode) || ''));
        if(team && !seenT.has(team)){ seenT.add(team); crews.push({ team, phases: {} }); }
      }
    }
    if(!crews.length){ lifeLog('auto-skip-nonsouth', { incident: num }); return; } // ⓒ لا وحدة جنوبية
    let coords = coordsFor(num);
    if(!coords && !geo.locOfIncident[num]) await fetchEventLocId(num); // مرة واحدة — قناة الموقع المعتمدة
    if(!coords && geo.locOfIncident[num]) coords = await fetchCoordsByLocId(geo.locOfIncident[num]);
    const callerInfo = callerInfoFromDetail(d); // note-18: التقاط من نفس الاستجابة — بلا طلب إضافي
    const r = await apiPost(num, code, type, crews, null, createdAt, address, region, coords, null, 'cad-auto', callerInfo);
    if(r.data && r.data.success){
      setObsStatus('synced');
      auto.count++;
      watchAdd(num, { code, type, crews, phases: {}, createdAt, address, region, lat: coords ? coords.lat : null, lng: coords ? coords.lng : null,
        callerNumber: callerInfo ? callerInfo.callerNumber : null, description: callerInfo ? callerInfo.description : null });
      lifeLog('auto-register', { incident: num, crews: crews.map(c => c.team + (c.cadUrs ? '#' + c.cadUrs : '')), confirmed: !!d });
      showToast('📡 البلاغ <b style="direction:ltr;display:inline-block">' + num + '</b> سُجّل <b>تلقائيًا</b><br>🚑 ' +
        crews.map(c => c.team).join(' · ') + '<br><small>الزر اليدوي يبقى متاحًا للتصحيح</small>', 6000);
    } else { setObsStatus('error', (r.data && r.data.error) || ('HTTP ' + r.status)); }
  }
  /* تحديث بلاغ قائم عند إشارة تغيّر lastJourneys: إعادة قراءة التفاصيل مخنوقة —
     إضافة فرقة ظهرت لاحقًا / استبعاد فرقة ثبت إلغاؤها / ترقية أوقات الرحلة.
     Registered ≠ Final: نفس eventId يُحدَّث ولا يتكرر (قرار المالك 2026-08-23) */
  async function autoRefresh(num){
    const w = watch.list[num];
    if(!w) return;
    const now = Date.now();
    if(now - (w.lastDetailAt || 0) < DETAIL_REFETCH_MS) return;
    const d = await fetchIncidentDetail(num);
    if(!d) return;
    const crews = mergeCrewSources(w.crews, crewsFromDetail(d));
    if(!crews.length) return;
    // note-18: معلومات المبلغ تُلتقط من نفس الاستجابة حتى عند ثبات الفرق — وصولها
    // لأول مرة يستحق الإرسال بذاته (الخادم يستكملها فقط إن كانت غائبة)
    const freshCaller = callerInfoFromDetail(d);
    const callerIsNew = !!(freshCaller && ((freshCaller.callerNumber && !w.callerNumber) || (freshCaller.description && !w.description)));
    const sig = JSON.stringify(crews.map(c => c.team + (c.cadUrs || '') + (c.cadReached ? 'R' : '') + JSON.stringify(c.phases || {})).sort());
    if(sig === w.autoSig && !callerIsNew) return; // لا جديد فعلي — لا إرسال
    const createdAt = w.createdAt || (d.createdDate ? fmtCadDateTime(d.createdDate) : null);
    const address = w.address || d.address || null;
    const region = w.region || d.zoneName || null;
    const callerInfo = freshCaller || (w.callerNumber || w.description ? { callerNumber: w.callerNumber, description: w.description } : null);
    const r = await apiPost(num, w.code, w.type, crews, null, createdAt, address, region,
      (w.lat != null && w.lng != null) ? { lat: w.lat, lng: w.lng } : null, null, 'cad-auto', callerInfo);
    if(r.data && r.data.success){
      setObsStatus('synced');
      watchAdd(num, { code: w.code, type: w.type, crews, phases: w.phases, createdAt, address, region, lat: w.lat, lng: w.lng,
        callerNumber: callerInfo ? callerInfo.callerNumber : null, description: callerInfo ? callerInfo.description : null });
      const ww = watch.list[num]; if(ww){ ww.lastDetailAt = now; ww.autoSig = sig; watchSave(); }
      lifeLog('auto-refresh', { incident: num, crews: crews.map(c => c.team + (c.cadUrs ? '#' + c.cadUrs : '')) });
    } else { setObsStatus('error', (r.data && r.data.error) || ('HTTP ' + r.status)); }
  }

  /* ═══ Incident Observer (اعتماد المالك 2026-08-24 — جولة Observer) ═══
     فتح صفحة البلاغ = بدء المراقبة تلقائيًا: بلا ضغط «أوقات الرحلة» ولا فتح أقسام
     ولا تدخل من المستخدم. كل 12 ثانية (إيقاع استطلاع CAD نفسه للقائمة) نقرأ
     event-dispatched/detail من سياق الصفحة — نفس المصدر الذي تبني واجهة CAD
     منه التفاصيل — ونغذّي وحداته في unitsByIncident؛ مسار الإرسال الواحد
     (watchTick + بصمة اللقطة) يلتقط أي تغيير ويرسله للمنصة تلقائيًا.
     بصمة لكل وحدة: هوية الوحدة + حالتها (urs) + مرحلتها الأخيرة + أزمنتها —
     التغيير الحقيقي فقط يُرسَل؛ تكرار نفس البيانات لا يُرسل إطلاقًا (spam-safe).
     يُراقب: ظهور Journey جديدة، تغيّر Journey، تغيّر phases/التوقيتات، تغيّر
     حالة الوحدة، انضمام وحدة. وحدة تختفي من التفاصيل تُوثَّق فقط — لا استنتاج
     إلغاء من الغياب (القاعدة الجذرية). تشخيص obs-gap المضمّن: إن ظهرت أوقات في
     الصفحة ولم تصل عبر journeys[] يُسجَّل دليلًا صادقًا — بلا تخمين مصدر بديل. */
  const OBS_POLL_MS = 12000;
  const obs = window.__southObs = window.__southObs || { fp: {}, gapSig: {} };
  function unitFp(u){
    return JSON.stringify([u.unit, u.urs || '', u.reached ? 1 : 0, u.lastStep || '', u.phases || {}, u.unitId || null, u.runUnitId || null]);
  }
  async function observerTick(){
    const num = incidentFromUrl();
    if(!num) return;
    const d = await fetchIncidentDetail(num);
    if(!d){
      // فشل قراءة متكرر = 🔴 صادق (لا صمت) — فشل عابر واحد يُتحمَّل للدورة القادمة
      obs.failStreak = (obs.failStreak || 0) + 1;
      if(obs.failStreak >= 3) setObsStatus('error', 'تعذرت قراءة تفاصيل البلاغ من CAD');
      return;
    }
    obs.failStreak = 0;
    ingestDetailUnits(num, d, 'observer');
    // note-18: معلومات المبلغ (رقم/وصف) من نفس استجابة التفاصيل التي يقرأها
    // الـObserver أصلًا — بلا طلب إضافي. وصولها لأول مرة يوسم اللقطة «متغيرة»
    // (lastSig=null) فيرسلها watchTick في دورته القادمة — والخادم يستكملها فقط
    if(d){
      try{
        const ci = callerInfoFromDetail(d);
        const w0 = watch.list[num];
        if(ci && w0 && ((ci.callerNumber && !w0.callerNumber) || (ci.description && !w0.description))){
          if(ci.callerNumber && !w0.callerNumber) w0.callerNumber = ci.callerNumber;
          if(ci.description && !w0.description) w0.description = ci.description;
          w0.lastSig = null;
          watchSave();
          lifeLog('caller-info', { incident: num, hasPhone: !!ci.callerNumber, hasDesc: !!ci.description });
        }
      }catch(e){}
    }
    const nowUnits = (unitsByIncident[num] && unitsByIncident[num].units) || [];
    const fpMap = obs.fp[num] = obs.fp[num] || {};
    for(const u of nowUnits){
      const key = String(u.runUnitId || u.unitId || u.unit);
      const fp = unitFp(u);
      if(fpMap[key] && fpMap[key] !== fp) lifeLog('obs-change', { incident: num, unit: u.unit });
      else if(!fpMap[key]) lifeLog('obs-unit-seen', { incident: num, unit: u.unit });
      fpMap[key] = fp;
    }
    // وحدة كانت معروفة واختفت من التفاصيل — توثيق فقط (لا استنتاج إلغاء من الغياب)
    const nowKeys = new Set(nowUnits.map(u => String(u.runUnitId || u.unitId || u.unit)));
    for(const k of Object.keys(fpMap)){
      if(!nowKeys.has(k)){ lifeLog('obs-unit-gone', { incident: num, unitKey: k }); delete fpMap[k]; }
    }
    // تشخيص الفجوة (تحقق برمجي — اعتماد 2026-08-24): أوقات ظاهرة في الصفحة ولم
    // تصل عبر journeys[] = القراءة النشطة وحدها لا تكفي لهذا البلاغ — يُسجَّل دليلًا
    try{
      const domPhases = phasesObject();
      const domHas = Object.keys(domPhases).length > 0;
      const apiHas = nowUnits.some(u => u.phases && Object.keys(u.phases).length > 0);
      const gapSig = num + '|' + (domHas ? 1 : 0) + '|' + (apiHas ? 1 : 0);
      if(domHas && !apiHas && obs.gapSig[num] !== gapSig){
        obs.gapSig[num] = gapSig;
        lifeLog('obs-gap', { incident: num, domPhases, note: 'أوقات ظاهرة في الصفحة وغائبة عن journeys[] المقروءة نشطًا' });
      }
    }catch(e){}
    setObsStatus('synced');
  }
  if(!window.__southObsTimer){
    window.__southObsTimer = setInterval(() => { try{ const f = window.__southObsTick; if(f) f().catch(() => {}); }catch(e){} }, OBS_POLL_MS);
  }
  window.__southObsTick = observerTick;
  setTimeout(() => { try{ const f = window.__southObsTick; if(f) f().catch(() => {}); }catch(e){} }, 800); // أول قراءة فور فتح الصفحة

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

  /* حالة المزامنة على المقبض (اعتماد المالك 2026-08-24): 🟢 متزامن · 🟡 جارٍ
     التحديث · 🔴 خطأ — الـObserver يعمل في الخلفية حتى والواجهة مطوية تمامًا */
  const obsState = window.__southObsState = window.__southObsState || { state: 'synced', note: '', at: 0, lastOkAt: 0 };
  function setObsStatus(state, note){
    obsState.state = state; obsState.note = note || ''; obsState.at = Date.now();
    if(state === 'synced') obsState.lastOkAt = obsState.at;
    const dot = document.getElementById('southPocStatus');
    if(dot) dot.textContent = state === 'error' ? '🔴' : (state === 'updating' ? '🟡' : '🟢');
    const lc = document.getElementById('southPocLauncher');
    if(lc) lc.title = (state === 'error' ? '🔴 يوجد خطأ' : state === 'updating' ? '🟡 جارٍ التحديث' : '🟢 متزامن') +
      (obsState.note ? ' — ' + obsState.note : '') + '\n' + OVERLAY_BUILD;
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
  grip.title = 'اسحب لتحريك لوحة منصة الجنوب إلى أي مكان مناسب' + '\n' + OVERLAY_BUILD;
  const gripLabel = document.createElement('span'); gripLabel.textContent = '⠿ منصة الجنوب';
  const closeBtn = document.createElement('button'); closeBtn.id = 'southPocClose';
  closeBtn.textContent = '✕'; closeBtn.title = 'طيّ اللوحة — تبقى شارة صغيرة لإعادة فتحها';
  grip.append(gripLabel, closeBtn);
  const launcher = document.createElement('button'); launcher.id = 'southPocLauncher';
  launcher.innerHTML = '<span id="southPocStatus">🟢</span> الجنوب';
  launcher.title = '🟢 متزامن\n' + OVERLAY_BUILD;
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
      // شبه مخفي افتراضيًا (اعتماد المالك 2026-08-24): مقبض صغير + مؤشر حالة فقط —
      // لا يُفتح إلا بطلب المستخدم، والـObserver يعمل في الخلفية بغض النظر
      if(!saved || saved.collapsed !== false) setCollapsed(true);
    }catch(e){ setCollapsed(true); }
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
    const pageCrews = cadCrews.map(c => ({ team: mapToSouthTeam(c.name), withdrawn: c.withdrawn })).filter(c => c.team);
    // مصدر الحقيقة لحالة الوحدة (قرار المالك 2026-08-22): وحدات event-dispatched/detail
    // الملتقطة سلبيًا ترقّي لقطة الصفحة — ولا تُسقط فرقة ظاهرة في الصفحة ولا وحداتها
    const southCrews = mergeCrewSources(crewsFromCadUnits(number), pageCrews);

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
          // وسم صادق لحالة كل فرقة: مسحوبة (نص الصفحة) أو ملغاة قبل المباشرة
          // (unitRequestStatus= B/C/R بلا وصول فعلي — قاعدة 2026-08-22)
          const tag = c => c.team + (c.withdrawn ? ' (مسحوبة)' :
            (c.cadUrs && c.cadUrs !== 'A' && !c.cadReached ? ' (ملغاة قبل المباشرة)' :
            (c.cadUrs && c.cadUrs !== 'A' && c.cadReached ? ' (أُلغيت بعد المباشرة — محتسبة)' : '')));
          successToast(number, type, southCrews.map(tag), coords);
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
    if(savedW && savedW.list && !watch.order.length){
      watch.list = savedW.list; watch.order = savedW.order || [];
      if(savedW.listTrack) Object.assign(listTrack, savedW.listTrack); // عدّادات الغياب تنجو من تحديث الصفحة
    }
  }catch(e){}
  function watchSave(){ try{ sessionStorage.setItem('__southWatch', JSON.stringify({ list: watch.list, order: watch.order.slice(-30), listTrack })); }catch(e){} }
  function snapSig(o){ return JSON.stringify([o.lat != null ? o.lat : null, o.lng != null ? o.lng : null, o.address || null, o.region || null, o.createdAt || null, o.phases || {}, (o.crews || []).map(c => c.team + (c.withdrawn ? '!W' : '') + (c.cadUrs ? '#' + c.cadUrs + (c.cadReached ? '+R' : '-R') : '') + JSON.stringify(c.phases || {}))]); }
  function watchAdd(number, sent){
    if(!number) return;
    if(!watch.list[number]) watch.order.push(number);
    watch.order = watch.order.slice(-30);
    if(!listTrack[number]) listTrack[number] = { everListed: false, absentStreak: 0, lastSeenAt: 0 };
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
      callerNumber: sent.callerNumber || prev.callerNumber || null, // note-18: معلومات المبلغ تبقى عبر الإثراءات
      description: sent.description || prev.description || null,
      lastSig: snapSig(sent),
      fetchTries: prev.fetchTries || 0,
      lastFetch: prev.lastFetch || 0,
      lastDetailAt: prev.lastDetailAt || 0, // خنق إعادة قراءة التفاصيل (المرحلة A)
      autoSig: prev.autoSig || null,        // بصمة آخر تأكيد تلقائي — لا إرسال بلا جديد
      firstAt: prev.firstAt || Date.now(), // مرساة فترة السماح — لا تتقدم مع الإثراءات
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
      // ⓪ مصدر الحقيقة — قائمة بلاغات CAD (قرار المالك 2026-08-22): الغياب المؤكد
      // (٣ لقطات متتالية + رؤية سابقة أو مضي 15 د على التسجيل) = انتهاء تشغيلي.
      // نرسل التحديث الأخير بنفس رقم البلاغ ثم نوقف المراقبة — يخرج فورًا من
      // التشغيل النشط (خريطة/تنبيهات/مؤشرات) ويبقى محفوظًا تاريخيًا بكل بياناته.
      const onPage = current === num;
      if(!listTrack[num]) listTrack[num] = { everListed: false, absentStreak: 0, lastSeenAt: 0 };
      const lt = listTrack[num];
      const goneLong = lt.everListed
        ? (now - (lt.lastSeenAt || 0) > LIST_SEEN_TIMEOUT_MS)   // ٦٠ ثانية بلا ظهور في أي قائمة (٦ دورات استطلاع)
        : (now - (w.firstAt || w.at) > LIST_GRACE_MS);           // لم يُرَ أبدًا: مهلة 15 د من التسجيل
      if(lt.absentStreak >= LIST_ABSENT_CONFIRM && goneLong){
        if(w.crews && w.crews.length){
          await apiPost(num, w.code, w.type, w.crews, w.phases, w.createdAt, w.address, w.region,
            (w.lat != null && w.lng != null) ? { lat: w.lat, lng: w.lng } : null, 'cancelled', undefined,
            (w.callerNumber || w.description) ? { callerNumber: w.callerNumber, description: w.description } : null);
        }
        delete watch.list[num]; watch.order = watch.order.filter(x => x !== num);
        delete listTrack[num]; watchSave();
        lifeLog('final', { incident: num, status: 'cancelled', reason: 'list-absence', streak: lt.absentStreak });
        showToast('⛔ البلاغ <b style="direction:ltr;display:inline-block">' + num + '</b> اختفى من قائمة بلاغات CAD — <b>أُخرج من التشغيل النشط وأُوقفت مراقبته</b>', 9000);
        continue;
      }
      // ① الإحداثيات — الالتقاط السلبي أولًا
      let coords = coordsFor(num);
      // ② جلب محدود بـlocation_id إن عُرف متأخرًا ولم تصل الإحداثيات سلبيًا
      if(!coords && geo.locOfIncident[num] && w.fetchTries < 6 && now - (w.lastFetch || 0) > 45000){
        w.lastFetch = now; w.fetchTries++; watchSave();
        coords = await fetchCoordsByLocId(geo.locOfIncident[num]);
      }
      // ③ لقطة الصفحة — فقط إن كان هذا البلاغ مفتوحًا أمام الموظف الآن
      const pageCrews = onPage ? crewStatesFromTracker().map(c => ({ team: mapToSouthTeam(c.name), withdrawn: c.withdrawn })).filter(c => c.team) : [];
      // حالة الوحدة من CAD (قرار المالك 2026-08-22): إلغاء/عودة الوحدة يُرسل تلقائيًا
      // فور تغيّر لقطة event-dispatched/detail — بلا ضغطة ثانية، ودمج بلا فقدان
      const effCrews = mergeCrewSources(w.crews, pageCrews, crewsFromCadUnits(num));
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
      setObsStatus('updating', 'بلاغ ' + num);
      const r = await apiPost(num, w.code, w.type, effCrews, snap.phases, snap.createdAt, snap.address, snap.region,
        coords || (snap.lat != null && snap.lng != null ? { lat: snap.lat, lng: snap.lng } : null), null, undefined,
        (w.callerNumber || w.description) ? { callerNumber: w.callerNumber, description: w.description } : null);
      if(r.data && r.data.success){
        setObsStatus('synced');
        watchAdd(num, { code: w.code, type: w.type, crews: effCrews, phases: snap.phases, createdAt: snap.createdAt, address: snap.address, region: snap.region, lat: snap.lat, lng: snap.lng,
          callerNumber: w.callerNumber || null, description: w.description || null });
        lifeLog('enrich', { incident: num, newCoords: gotNewCoords ? coords : null });
        if(gotNewCoords) showToast('🌐 اكتمل موقع البلاغ <b style="direction:ltr;display:inline-block">' + num + '</b> <b>تلقائيًا</b> — ظهر على خريطة منصة الجنوب<br><b style="direction:ltr;display:inline-block">' + coords.lat.toFixed(6) + ', ' + coords.lng.toFixed(6) + '</b>', 9000);
      } else {
        setObsStatus('error', (r.data && r.data.error) || ('HTTP ' + r.status));
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
