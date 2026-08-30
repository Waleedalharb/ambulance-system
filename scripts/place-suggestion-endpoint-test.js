/**
 * ═══ اختبار مسار place-suggestion + صلاحيته — place-suggestion-endpoint-test.js ═══ (PI-7)
 * اعتماد المالك 2026-08-30: العرض = نفس صلاحية مشاهدة البلاغات (ops.reports) —
 * موثّق بلا صلاحية ← 403 حتى لو عرف رقم البلاغ. لا Permission جديدة.
 * العزل: VACUUM INTO + DATA_DIR مؤقت — لا يمس القاعدة ولا users.json الأصليين.
 * MAPBOX_SEARCH_TOKEN غير مضبوط هنا ← Discovery معطّل (فشل آمن) — السلوك
 * الخارجي الحي مغطى يدويًا في تقرير الجولة.
 * التشغيل: node scripts/place-suggestion-endpoint-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'pi7-endpoint-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'pi7-endpoint-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    // ── فحص ساكن: الحراسة والربط ──
    console.log('\n🧪 الفحص الساكن:');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('المسار محروس بـ authenticate + authorizePerm(\'ops.reports\')',
        serverSrc.includes("app.get('/api/cad-reports/:number/place-suggestion', authenticate, authorizePerm('ops.reports')"));
    check('لا Permission جديدة أُنشئت (ops.reports من الكتالوج القائم)',
        fs.readFileSync(path.join(ROOT, 'config', 'permissions.js'), 'utf8').includes("'ops.reports'"));
    check('Discovery معطّل بصمت بلا MAPBOX_SEARCH_TOKEN',
        serverSrc.includes('process.env.MAPBOX_SEARCH_TOKEN\n    ? new MapboxSearchBoxProvider') || serverSrc.includes('MAPBOX_SEARCH_TOKEN'));
    const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
    check('بطاقة البلاغ فيها مساحة pi-sugg-slot + استدعاء hydrate',
        appSrc.includes('pi-sugg-slot') && appSrc.includes('PlaceSuggestion.hydrate'));
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    check('place-suggestion.js محمّل في index.html', htmlSrc.includes('js/place-suggestion.js'));
    const uiSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'place-suggestion.js'), 'utf8');
    check('الوسم «اقتراح خارجي — غير معتمد» إلزامي في كل حالات العرض',
        (uiSrc.match(/اقتراح خارجي — غير معتمد/g) || []).length >= 1 && uiSrc.includes('403'));

    // ── خادم معزول ──
    console.log('\n🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + ' (بلا MAPBOX_SEARCH_TOKEN)...');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    delete env.MAPBOX_SEARCH_TOKEN;
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    if (!(await waitReady())) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security.js'));
        const tok = (id, role) => jwt.sign({ id, role, name: 'مجس ' + id }, securityConfig.JWT_SECRET);
        const T_VIEWER = tok('pi7-viewer', 'viewer');       // بلا أي منح
        const T_OP = tok('pi7-operator', 'operator');       // حزمة OPS_ALL تشمل ops.reports

        console.log('\n🚪 الحراسة الحية:');
        let r = await api('/api/cad-reports/123456/place-suggestion');
        check('بلا توكن ← 401', r.status === 401);
        r = await api('/api/cad-reports/123456/place-suggestion', { token: T_VIEWER });
        check('viewer (موثّق بلا صلاحية بلاغات) ← 403 PERMISSION_DENIED',
            r.status === 403 && r.data && r.data.code === 'PERMISSION_DENIED');
        r = await api('/api/cad-reports/123456/place-suggestion', { token: T_OP });
        check('operator (ops.reports) ← يجتاز الحارس (404 لبلاغ غير موجود)',
            r.status === 404);
        r = await api('/api/cad-reports/abc!!/place-suggestion', { token: T_OP });
        check('رقم غير صالح ← 400', r.status === 400);

        console.log('\n🛡️ عدم المساس: resolve/R1–R5 لا يستدعي شبكة ولا مزود:');
        const svcSrc = fs.readFileSync(path.join(ROOT, 'services', 'place-intelligence-service.js'), 'utf8');
        check('place-intelligence-service بلا أي require لطبقة المزودين',
            !svcSrc.includes('place-providers') && !svcSrc.includes('place-discovery'));
    } finally {
        server.kill();
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
})();
