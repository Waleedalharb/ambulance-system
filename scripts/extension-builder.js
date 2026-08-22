/**
 * ═══ extension-builder.js — وحدة التوليد المشتركة لحزمة CAD Overlay ═══
 * (قرار المالك 2026-08-21): المنصة المنشورة هي نقطة التوزيع — نفس منطق التوليد
 * يخدم build-extension.js (محلي) ومسار GET /api/cad-overlay/package (الخادم).
 *
 * الثوابت الصارمة:
 *  - scripts/cad-overlay.js هو Source of Truth الوحيد — يُنسخ حرفيًا بلا أي سر.
 *  - مفتاح التكامل يدخل background.js فقط (سياق الإضافة) ولا يدخل سياق صفحة CAD أبدًا.
 *  - لا تعديل على منطق التسجيل/المراقبة المختبَر حيًا هنا — توليد وتغليف فقط.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** المفتاح النشط (scope=cad-reports) من ملف المفاتيح — لا يُطبع أبدًا */
function loadActiveKey(dataDir) {
    let keys;
    try { keys = JSON.parse(fs.readFileSync(path.join(dataDir, 'integration-keys.json'), 'utf8')); }
    catch (_) { return null; }
    const k = (Array.isArray(keys) ? keys : (keys.keys || []))
        .find(x => x.scope === 'cad-reports' && x.active !== false && !x.revoked);
    if (!k) return null;
    return k.key || k.value || k.token || null;
}

/** نمط matches بلا منفذ — Chrome لا يقبل المنافذ في content_scripts */
function matchPattern(origin) {
    const u = new URL(origin);
    return u.protocol + '//' + u.hostname + '/*';
}

/**
 * يولّد ملفات الإضافة كاملة لعنوان منصة محدد.
 * @param {string} platformBase  مثل https://emsoperations.online أو http://localhost:3002
 * @param {{dataDir?: string}} opts  dataDir: موضع integration-keys.json (افتراضيًا ROOT/data)
 */
function buildExtensionFiles(platformBase, opts) {
    const dataDir = (opts && opts.dataDir) || path.join(ROOT, 'data');
    const keyValue = loadActiveKey(dataDir);
    if (!keyValue) throw new Error('لا يوجد مفتاح تكامل نشط (scope=cad-reports)');
    const base = String(platformBase || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new Error('عنوان المنصة غير صالح: ' + platformBase);

    // سكربت المحتوى = الـOverlay المعتمد حرفيًا (بلا أي حقن أسرار)
    const overlay = fs.readFileSync(path.join(ROOT, 'scripts', 'cad-overlay.js'), 'utf8');
    if (/%%|INTEGRATION_KEY|X-Integration-Key/i.test(overlay))
        throw new Error('cad-overlay.js ما زال يحمل أثر مفتاح/placeholder — الفصل الأمني يمنع ذلك');
    const stamp = new Date().toISOString();
    const content = '/* ⚠️ ملف مولّد تلقائيًا — لا تعدّله يدويًا.\n'
        + '   المصدر: scripts/cad-overlay.js | التوليد: scripts/extension-builder.js\n'
        + '   التاريخ: ' + stamp + ' — بلا أي سر (الفصل الأمني 2026-08-20) */\n' + overlay;

    // خلفية الإضافة — المكان الوحيد للمفتاح (سياق الإضافة المعزول)
    const background = `/* ⚠️ ملف مولّد تلقائيًا — لا تعدّله يدويًا ولا تلتزم به في Git.
   خلفية إضافة «منصة الجنوب»: المكان الوحيد الذي يحمل مفتاح التكامل.
   تعمل في سياق الإضافة المعزول (Service Worker) — لا تدخل سياق صفحة CAD أبدًا.
   التوليد: scripts/extension-builder.js | ${stamp} */
const PLATFORM_BASE = ${JSON.stringify(base)};
const INTEGRATION_KEY = ${JSON.stringify(keyValue)};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.kind !== 'cad-report' && msg.kind !== 'cad-stats' && msg.kind !== 'south-teams')) return false;
  // تحقق شكلي إضافي (دفاع بالعمق — التحقق الكامل في الخادم)
  if (msg.kind === 'cad-report') {
    const p = msg.payload;
    if (!p || typeof p !== 'object' || !/^\\d{4,12}$/.test(String(p.number || ''))) { sendResponse({ status: 0, data: { error: 'حمولة غير صالحة' } }); return false; }
    if (!Array.isArray(p.crews) || p.crews.length < 1 || p.crews.length > 10) { sendResponse({ status: 0, data: { error: 'حمولة غير صالحة' } }); return false; }
  }
  (async () => {
    try {
      const isPost = msg.kind === 'cad-report';
      // فرق الجنوب من التكميل (§5): GET بنفس المفتاح على مساره المقصور — قراءة فقط
      const url = PLATFORM_BASE + (msg.kind === 'south-teams' ? '/api/cad-reports/south-teams' : '/api/cad-reports');
      const res = await fetch(url, {
        method: isPost ? 'POST' : 'GET',
        headers: Object.assign({ 'Content-Type': 'application/json' },
          (isPost || msg.kind === 'south-teams') ? { 'X-Integration-Key': INTEGRATION_KEY } : {}),
        body: isPost ? JSON.stringify(msg.payload) : undefined
      });
      const data = await res.json().catch(() => null);
      sendResponse({ status: res.status, data });
    } catch (e) {
      sendResponse({ status: 0, data: { error: 'تعذّر الوصول لمنصة الجنوب — تحقق أنها تعمل محليًا' } });
    }
  })();
  return true; // رد غير متزامن
});
`;

    // الملفان الثابتان بلا أسرار
    const bridge = fs.readFileSync(path.join(ROOT, 'extension', 'bridge.js'), 'utf8');
    const marker = fs.readFileSync(path.join(ROOT, 'extension', 'platform-marker.js'), 'utf8');

    const manifest = JSON.stringify({
        manifest_version: 3,
        name: 'منصة الجنوب — تسجيل بلاغات CAD',
        version: '2.0.0',
        description: 'تسجيل بلاغات CAD في منصة الجنوب بضغطة واحدة — قراءة فقط، مراقبة سلبية، بلا استخراج جلسات وبلا طلبات إضافية إلى CAD. مفتاح التكامل في خلفية الإضافة فقط (خارج سياق الصفحة).',
        host_permissions: [base + '/*'],
        background: { service_worker: 'background.js' },
        content_scripts: [
            { matches: ['*://cad.alsahab.sa/*'], js: ['cad-overlay-content.js'], run_at: 'document_idle', world: 'MAIN' },
            { matches: ['*://cad.alsahab.sa/*'], js: ['bridge.js'], run_at: 'document_idle', world: 'ISOLATED' },
            // علامة «الأداة مثبتة» على صفحات المنصة نفسها — لصفحة التثبيت (فحص ذاتي)
            { matches: [matchPattern(base)], js: ['platform-marker.js'], run_at: 'document_idle', world: 'ISOLATED' }
        ]
    }, null, 2);

    const readme = [
        'تثبيت إضافة «منصة الجنوب — تسجيل بلاغات CAD» على جهاز العمل',
        '═══════════════════════════════════════════════════',
        '',
        'المنصة التي ستتصل بها هذه الحزمة: ' + base,
        '',
        '1) فكّ ضغط ملف ZIP في مجلد ثابت على جهاز العمل (لا تحذفه بعد التثبيت).',
        '2) في Chrome افتح العنوان:  chrome://extensions',
        '3) فعّل «وضع المطوّر / Developer mode» (أعلى الصفحة).',
        '4) اضغط «Load unpacked / تحميل غير مُعبأ» واختر مجلد الحزمة المفكوك.',
        '5) افتح CAD — تظهر لوحة «🚑 منصة الجنوب» تلقائيًا. انتهى.',
        '',
        '• لا حقن يدوي ولا خطوة يومية — تعمل تلقائيًا عند فتح CAD.',
        '• اللوحة قابلة للسحب لأي مكان، وزر ✕ يطويها إلى شارة صغيرة.',
        '• التسجيل: افتح البلاغ ← ＋ تسجيل للجنوب (ضغطة واحدة) — الموقع',
        '  وأي تحديث لاحق يصل تلقائيًا دون ضغطة ثانية.',
        '• للتحقق: صفحة «تثبيت أداة CAD» داخل المنصة تعرض ✅ عند نجاح التثبيت.',
        '• للتحديث بعد نسخة جديدة: نزّل الحزمة من المنصة، استبدل المجلد،',
        '  ثم زر «إعادة التحميل ⟳» في chrome://extensions.',
        '• للتعطيل: إيقاف من chrome://extensions — يزيل كل أثر فورًا.',
        ''
    ].join('\r\n');

    return { manifest, content, bridge, marker, background, readme, base };
}

module.exports = { buildExtensionFiles, loadActiveKey, matchPattern };
