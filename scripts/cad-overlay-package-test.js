/**
 * ═══ cad-overlay-package-test.js — اختبار حزمة توزيع أداة CAD من المنصة ═══
 * (قرار المالك 2026-08-21): المنصة المنشورة نقطة التوزيع. يثبت معزولًا:
 *  ① صفحة /cad-overlay موجودة وفيها الزر ومنطق الفحص الذاتي
 *  ② تنزيل الحزمة محمي بجلسة المنصة (بلا توكن ← 401)
 *  ③ الحزمة ZIP سليمة وتحمل الملفات الستة
 *  ④ محتوى الـOverlay في الحزمة = scripts/cad-overlay.js حرفيًا (Source of Truth)
 *  ⑤ الفصل الأمني: المفتاح في background.js فقط — غائب من البقية
 *  ⑥ عنوان المنصة: مشتق من الطلب محليًا، وemsoperations.online عند التمرير الصريح
 *  ⑦ وظيفة الحزمة: المفتاح المستخرج منها يسجّل بلاغًا فعليًا (POST ← ملخص)
 * التشغيل: node scripts/cad-overlay-package-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3099;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'cad-pkg-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const TEST_KEY = 'pkgkey-' + STAMP;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
}

async function api(p, { method = 'GET', token, body, raw } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (raw) return res;
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار الحزمة', active: true, createdAt: new Date().toISOString() }
    ]));
    const probe = new Database(TMP_DB, { readonly: true });
    const active = probe.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    probe.close();
    if (!active) { console.log('❌ لا مناوبة نشطة في النسخة'); process.exit(1); }

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        // ① صفحة التثبيت
        console.log('\n① صفحة /cad-overlay:');
        const pageRes = await api('/cad-overlay', { raw: true });
        const html = await pageRes.text();
        check('① الصفحة تُقدَّم (200)', pageRes.status === 200);
        check('① تحمل زر «🚑 تثبيت CAD Overlay»', html.includes('🚑 تثبيت CAD Overlay'));
        check('① تحمل مسار الحزمة ومنطق الفحص الذاتي (ping/pong + العلامة)',
            html.includes('/api/cad-overlay/package') && html.includes('overlay-ping') && html.includes('data-south-cad-overlay'));

        // ② الحماية
        console.log('\n② حماية التنزيل:');
        check('② بلا توكن ← 401', (await api('/api/cad-overlay/package')).status === 401);

        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) { console.log('❌ الدخول فشل'); throw new Error('login'); }

        // ③ الحزمة
        console.log('\n③ تنزيل الحزمة وفكها:');
        const pkgRes = await api('/api/cad-overlay/package', { token: TK, raw: true });
        check('③ التنزيل 200 بنوع ZIP', pkgRes.status === 200 && (pkgRes.headers.get('content-type') || '').includes('zip'));
        const buf = Buffer.from(await pkgRes.arrayBuffer());
        check('③ الحجم معقول (>5KB)', buf.length > 5000, 'size=' + buf.length);
        const JSZip = require(path.join(ROOT, 'node_modules', 'jszip'));
        const zip = await JSZip.loadAsync(buf);
        const names = Object.keys(zip.files).sort();
        check('③ الملفات الستة كاملة', ['background.js', 'bridge.js', 'cad-overlay-content.js', 'manifest.json', 'platform-marker.js', 'اقرأني-التثبيت.txt']
            .every(f => names.includes(f)), names.join(','));
        const zContent = await zip.file('cad-overlay-content.js').async('string');
        const zBg = await zip.file('background.js').async('string');
        const zManifest = await zip.file('manifest.json').async('string');
        const zBridge = await zip.file('bridge.js').async('string');
        const zMarker = await zip.file('platform-marker.js').async('string');
        const zReadme = await zip.file('اقرأني-التثبيت.txt').async('string');

        // ④ هوية المصدر
        console.log('\n④ هوية المصدر (Source of Truth):');
        const overlaySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'cad-overlay.js'), 'utf8');
        check('④ محتوى الحزمة = scripts/cad-overlay.js حرفيًا (هيدر توليد + المصدر)', zContent.endsWith(overlaySrc));
        const localBuilt = fs.readFileSync(path.join(ROOT, 'extension', 'cad-overlay-content.js'), 'utf8');
        check('④ = نفس البناء المحلي المختبَر (إزالة الهيدر)', zContent.replace(/^\/\*[\s\S]*?\*\/\n/, '') === localBuilt.replace(/^\/\*[\s\S]*?\*\/\n/, ''));
        check('④ الجسر والعلامة = النسخ الثابتة حرفيًا',
            zBridge === fs.readFileSync(path.join(ROOT, 'extension', 'bridge.js'), 'utf8') &&
            zMarker === fs.readFileSync(path.join(ROOT, 'extension', 'platform-marker.js'), 'utf8'));

        // ⑤ الفصل الأمني
        console.log('\n⑤ الفصل الأمني للمفتاح:');
        check('⑤ المفتاح في background.js', zBg.includes(TEST_KEY));
        check('⑤ المفتاح غائب من content/bridge/marker/manifest/اقرأني',
            !zContent.includes(TEST_KEY) && !zBridge.includes(TEST_KEY) && !zMarker.includes(TEST_KEY) && !zManifest.includes(TEST_KEY) && !zReadme.includes(TEST_KEY));
        check('⑤ content بلا أي أثر مفتاح/placeholder', !/INTEGRATION_KEY|X-Integration-Key|%%/.test(zContent));

        // ⑥ عنوان المنصة
        console.log('\n⑥ عنوان المنصة في الحزمة:');
        const mf = JSON.parse(zManifest);
        check('⑥ host_permissions = عنوان الخادم المشتق من الطلب', mf.host_permissions[0] === BASE + '/*', mf.host_permissions[0]);
        check('⑥ background يتصل بنفس العنوان (لا localhost الثابت)', zBg.includes('"http://127.0.0.1:' + PORT + '"'));
        check('⑥ matches: CAD + علامة المنصة', mf.content_scripts.length === 3 &&
            mf.content_scripts[2].js[0] === 'platform-marker.js' && mf.content_scripts[2].matches[0] === 'http://127.0.0.1/*');
        const { buildExtensionFiles } = require(path.join(ROOT, 'scripts', 'extension-builder'));
        const prod = buildExtensionFiles('https://emsoperations.online', { dataDir: TMP_DIR });
        const pmf = JSON.parse(prod.manifest);
        check('⑥ بوضع النشر: background وhost_permissions وعلامة ← emsoperations.online',
            prod.background.includes('"https://emsoperations.online"') &&
            pmf.host_permissions[0] === 'https://emsoperations.online/*' &&
            pmf.content_scripts[2].matches[0] === 'https://emsoperations.online/*');
        check('⑥ اقرأني الحزمة يذكر عنوان المنصة', zReadme.includes(BASE) && prod.readme.includes('https://emsoperations.online'));

        // ⑦ وظيفة الحزمة: المفتاح المستخرج منها يسجّل بلاغًا فعليًا
        console.log('\n⑦ وظيفة الحزمة (مفتاحها يسجّل فعليًا):');
        const mKey = zBg.match(/const INTEGRATION_KEY = "([^"]+)"/);
        check('⑦ المفتاح قابل للاستخراج من background', !!mKey);
        const reg = await fetch(BASE + '/api/cad-reports', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Integration-Key': mKey ? mKey[1] : 'none' },
            body: JSON.stringify({ number: '990080', createdAt: '21/08/2026 6:00:00 PM', lat: 24.62, lng: 46.72, crews: [{ team: 'جنوب 3', phases: { 'التحرك': '6:01:00 PM' } }] })
        });
        const regData = await reg.json();
        check('⑦ POST بمفتاح الحزمة ← 200 created', reg.status === 200 && regData.success && regData.created === true, JSON.stringify(regData).slice(0, 120));
        const sum = await api('/api/cad-reports', { token: TK });
        const ic = (sum.data.incidents || []).find(i => i.number === '990080');
        check('⑦ البلاغ ظهر في الملخص بإحداثياته', !!ic && ic.lat === 24.62 && ic.lng === 46.72);

    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ حزمة CAD Overlay من المنصة: مصدر واحد + فصل أمني + عنوان صحيح + وظيفة مثبتة');
})();
