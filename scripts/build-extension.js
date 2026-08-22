/**
 * ═══ build-extension.js — توليد ملفات الإضافة من المصادر المعتمدة ═══
 * (قرار المالك 2026-08-20): الفصل الأمني الكامل —
 *   • extension/cad-overlay-content.js ← نسخة حرفية من scripts/cad-overlay.js
 *     (بلا أي سر).
 *   • extension/background.js ← يُولَّد ويحمل مفتاح التكامل — المكان الوحيد
 *     للسر، يعمل في سياق الإضافة المعزول ولا يدخل سياق صفحة CAD أبدًا
 *     (مستثنى من Git — لا يُعدَّل يدويًا).
 *   • extension/bridge.js وplatform-marker.js ملفان ثابتان بلا أسرار.
 *   • منطق التوليد الفعلي في scripts/extension-builder.js (مصدر واحد يشاركه
 *     مسار الخادم GET /api/cad-overlay/package للتوزيع من المنصة المنشورة).
 *
 * التشغيل:
 *   node scripts/build-extension.js          ← يولّد extension/ (localhost:3002)
 *   node scripts/build-extension.js --dist   ← + حزمة توزيع dist/south-cad-overlay-extension/
 *   PLATFORM_BASE=https://emsoperations.online node scripts/build-extension.js --dist
 *                                            ← حزمة موجهة للمنصة المنشورة
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { buildExtensionFiles } = require('./extension-builder');

const ROOT = path.join(__dirname, '..');
const PLATFORM_BASE = process.env.PLATFORM_BASE || 'http://localhost:3002';

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

let files;
try { files = buildExtensionFiles(PLATFORM_BASE); }
catch (e) { fail(e.message); }

// ── كتابة extension/ — manifest أصبح مولّدًا أيضًا (مصدر واحد للحقيقة) ──
fs.writeFileSync(path.join(ROOT, 'extension', 'manifest.json'), files.manifest, 'utf8');
fs.writeFileSync(path.join(ROOT, 'extension', 'cad-overlay-content.js'), files.content, 'utf8');
fs.writeFileSync(path.join(ROOT, 'extension', 'background.js'), files.background, 'utf8');

// ── تحقق نحوي فوري من الملفين المولّدين ──
const { execFileSync } = require('child_process');
execFileSync(process.execPath, ['--check', path.join(ROOT, 'extension', 'cad-overlay-content.js')]);
execFileSync(process.execPath, ['--check', path.join(ROOT, 'extension', 'background.js')]);
console.log('✅ cad-overlay-content.js = الـOverlay المعتمد حرفيًا (بلا أي سر)');
console.log('✅ background.js وُلّد بالمفتاح — سياق الإضافة فقط، مستثنى من Git');
console.log('✅ manifest.json وُلّد بعنوان المنصة: ' + files.base);
console.log('   ثبّت/حدّث الإضافة: chrome://extensions ← Load unpacked ← extension/');

// ── حزمة التوزيع لأجهزة العمل: node scripts/build-extension.js --dist ──
// (قرار المالك 2026-08-21): مجلد مستقل قابل للنسخ — نفس البناء المختبَر حرفيًا.
if (process.argv.includes('--dist')) {
    const distDir = path.join(ROOT, 'dist', 'south-cad-overlay-extension');
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'manifest.json'), files.manifest, 'utf8');
    fs.writeFileSync(path.join(distDir, 'cad-overlay-content.js'), files.content, 'utf8');
    fs.writeFileSync(path.join(distDir, 'bridge.js'), files.bridge, 'utf8');
    fs.writeFileSync(path.join(distDir, 'platform-marker.js'), files.marker, 'utf8');
    fs.writeFileSync(path.join(distDir, 'background.js'), files.background, 'utf8');
    fs.writeFileSync(path.join(distDir, 'اقرأني-التثبيت.txt'), files.readme, 'utf8');
    console.log('📦 حزمة التوزيع جاهزة: dist/south-cad-overlay-extension/ ← ' + files.base);
}
