/* ═══ bridge.js — جسر الإضافة المعزول (بلا أي سر) ═══
   يعمل في سياق معزول (ISOLATED): يستقبل رسائل postMessage من الـOverlay في صفحة
   CAD (MAIN world) ويمررها لخلفية الإضافة، ثم يعيد الرد للصفحة.
   لا يحمل مفتاحًا ولا يتصل بأي خادم — مجرد مرحّل رسائل بتحقق صارم من الشكل. */
(() => {
  const REQ = 'south-cad-overlay', RES = 'south-ext-bridge';
  const KINDS = { 'cad-report': true, 'cad-stats': true, 'south-teams': true };

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== REQ || typeof d.reqId !== 'string' || d.reqId.length > 40) return;
    if (!KINDS[d.kind]) return;
    // تحقق شكلي صارم للحمولة قبل تمريرها (الخادم يتحقق أيضًا — دفاع بالعمق)
    if (d.kind === 'cad-report') {
      const p = d.payload;
      if (!p || typeof p !== 'object' || !/^\d{4,12}$/.test(String(p.number || ''))) return;
      if (!Array.isArray(p.crews) || p.crews.length < 1 || p.crews.length > 10) return;
    }
    try {
      chrome.runtime.sendMessage({ kind: d.kind, payload: d.payload || null }, (resp) => {
        const err = chrome.runtime.lastError;
        window.postMessage({
          source: RES, reqId: d.reqId,
          status: (resp && typeof resp.status === 'number') ? resp.status : 0,
          data: (resp && resp.data !== undefined) ? resp.data : (err ? { error: 'تعذّر الوصول لخلفية الإضافة: ' + err.message } : null)
        }, '*');
      });
    } catch (_) {
      window.postMessage({ source: RES, reqId: d.reqId, status: 0, data: { error: 'سياق الإضافة غير متاح — أعد تحميل الصفحة' } }, '*');
    }
  });
})();
