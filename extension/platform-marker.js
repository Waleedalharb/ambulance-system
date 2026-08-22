/* علامة «أداة CAD مثبتة» — تُحقن على صفحات منصة الجنوب فقط (ISOLATED world).
   دورها الوحيد: صفحة التثبيت داخل المنصة تكتشف بها أن الإضافة تعمل على هذا الجهاز.
   لا سر هنا ولا منطق تسجيل ولا مراقبة — منطق CAD يعيش في cad-overlay-content.js
   على نطاق CAD حصرًا (الفصل الأمني 2026-08-20). */
(function () {
  'use strict';
  var VERSION = '2.0.0';
  function mark() {
    try { document.documentElement.setAttribute('data-south-cad-overlay', VERSION); } catch (e) {}
  }
  mark();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mark);
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.source === 'south-platform' && d.kind === 'overlay-ping') {
      window.postMessage({ source: 'south-cad-overlay-marker', kind: 'overlay-pong', version: VERSION }, '*');
    }
  });
})();
