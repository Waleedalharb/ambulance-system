/**
 * ═══ inject-cad-overlay.js — حقن «＋ تسجيل للجنوب» في تبويب CAD (بديل تطويري) ═══
 * (قرار المالك 2026-08-20): الطريقة الأساسية هي إضافة المتصفح extension/
 * (تلقائية بلا حقن). هذا الحاقن بديل تطويري عبر WebBridge.
 *
 * بعد الفصل الأمني (2026-08-20): الـOverlay لا يحمل أي مفتاح — يُحقن كما هو.
 * الإرسال الفعلي للمنصة يتطلب إضافة المتصفح مثبتة (الجسر + الخلفية)، وإلا
 * يظهر للموظف تنبيه صادق — لا سر يدخل سياق الصفحة من أي مسار.
 *
 * المتطلبات: تبويب CAD (cad.alsahab.sa) مفتوح ومستعار عبر WebBridge
 * (جلسة cad-observe). التشغيل: node scripts/inject-cad-overlay.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BRIDGE = process.env.WEBBRIDGE_URL || 'http://127.0.0.1:10086/command';
const SESSION = 'cad-observe';

function fail(msg, code) { console.error('❌ ' + msg); process.exit(code || 1); }

let overlay;
try { overlay = fs.readFileSync(path.join(ROOT, 'scripts', 'cad-overlay.js'), 'utf8'); }
catch (_) { fail('تعذّر قراءة scripts/cad-overlay.js'); }
if (/%%|INTEGRATION_KEY|X-Integration-Key/i.test(overlay))
    fail('cad-overlay.js يحمل أثر مفتاح/placeholder — الفصل الأمني يمنع حقنه');

const tmp = path.join(os.tmpdir(), 'cad-overlay-inject-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json');
fs.writeFileSync(tmp, JSON.stringify({ action: 'evaluate', args: { code: overlay }, session: SESSION }), 'utf8');
try {
    const out = execFileSync('curl.exe', ['-s', '-X', 'POST', BRIDGE, '-H', 'Content-Type: application/json', '--data-binary', '@' + tmp], { encoding: 'utf8', timeout: 30000 });
    let res = null;
    try { res = JSON.parse(out); } catch (_) { }
    if (res && res.ok === false) fail('WebBridge رفض الحقن: ' + (res.error || out.slice(0, 200)));
    console.log('✅ حُقن CAD Overlay (بلا مفتاح) في تبويب CAD — جلسة ' + SESSION);
    console.log('   ملاحظة: الإرسال للمنصة يتطلب إضافة المتصفح extension/ مثبتة (الجسر + الخلفية).');
} catch (e) {
    fail('فشل الاتصال بـWebBridge (' + BRIDGE + ') — تأكد أن الجسر يعمل وأن تبويب CAD مستعار. ' + e.message);
} finally {
    try { fs.unlinkSync(tmp); } catch (_) { }
}
