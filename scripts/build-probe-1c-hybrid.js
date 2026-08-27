// بناء الحزمة الهجينة dist-probe-1c:
// ينزّل حزمة الإنتاج الرسمية (بخلفية تحمل مفتاح الإنتاج) ويستبدل فيها
// ملف المحتوى فقط بنسخة المسبار المحلية 2026-08-27.c — بلا أي نشر.
// تشغيل: node scripts/build-probe-1c-hybrid.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const BASE = 'https://emsoperations.online';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist-probe-1c');
const LOCAL_CONTENT = path.join(ROOT, 'dist', 'south-cad-overlay-extension', 'cad-overlay-content.js');

async function main() {
  // 1) تسجيل الدخول للحصول على جلسة
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '4252', password: '4252' })
  });
  if (!login.ok) throw new Error('فشل الدخول: ' + login.status);
  const loginBody = await login.json();
  const token = loginBody.accessToken;
  if (!token) throw new Error('لم يُرجع الدخول accessToken');

  // 2) تنزيل حزمة الإنتاج
  const res = await fetch(BASE + '/api/cad-overlay/package', { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('فشل تنزيل الحزمة: ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log('⬇ حزمة الإنتاج:', buf.length, 'بايت');

  // 3) فك الضغط ونسخ كل الملفات
  const zip = await JSZip.loadAsync(buf);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const data = await entry.async('nodebuffer');
    const dest = path.join(OUT, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    console.log('  📄', name, data.length, 'بايت');
  }

  // 4) استبدال ملف المحتوى بنسخة المسبار المحلية فقط
  const local = fs.readFileSync(LOCAL_CONTENT);
  fs.writeFileSync(path.join(OUT, 'cad-overlay-content.js'), local);
  console.log('🔁 استُبدل cad-overlay-content.js بالنسخة المحلية:', local.length, 'بايت');

  // 5) التحققات الإلزامية
  const content = local.toString('utf8');
  const bg = fs.readFileSync(path.join(OUT, 'background.js'), 'utf8');
  const bridge = fs.readFileSync(path.join(OUT, 'bridge.js'), 'utf8');

  const stamp = /2026-08-27\.c/.test(content);
  const keyMatch = bg.match(/INTEGRATION_KEY\s*[:=]\s*['"]([^'"]+)['"]/);
  const fp = keyMatch ? crypto.createHash('sha256').update(keyMatch[1]).digest('hex').slice(0, 12) : 'غير موجود';
  const bridgeOk = !/length\s*<\s*1/.test(bridge);
  const probeBtn = content.includes('southProbeBtn');

  console.log('\n═══ التحقق ═══');
  console.log((stamp ? '✅' : '❌'), 'ختم البناء 2026-08-27.c في ملف المحتوى');
  console.log((fp === 'f3bb06c64f58' ? '✅' : '❌'), 'بصمة مفتاح الإنتاج:', fp);
  console.log((bridgeOk ? '✅' : '❌'), 'الجسر بلا شرط length < 1');
  console.log((probeBtn ? '✅' : '❌'), 'زر المسبار southProbeBtn موجود');
  if (!(stamp && fp === 'f3bb06c64f58' && bridgeOk && probeBtn)) {
    throw new Error('فشل أحد التحققات — لا تسلّم الحزمة');
  }
  console.log('\n📦 الحزمة الهجينة جاهزة:', OUT);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
