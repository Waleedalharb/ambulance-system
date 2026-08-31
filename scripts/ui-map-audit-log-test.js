/**
 * ═══ اختبار إصلاح /api/audit-log — ui-map-audit-log-test.js ═══
 * جولة UI-Map المرحلة B (اعتماد المالك 2026-08-31):
 *   ① ملف JSON تالف ← عزل .corrupt-<ts> + إرجاع [] بدل 500 دائم
 *   ② كتابة ذرّية tmp → rename (لا ملف مقطوع عند restart وسط الكتابة)
 *   ③ تسجيل الخطأ الحقيقي في الـcatch الخارجي
 * العزل: VACUUM INTO + DATA_DIR مؤقت — لا يمس data/ الحقيقية إطلاقًا.
 * التشغيل: node scripts/ui-map-audit-log-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'uimap-audit-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'uimap-audit-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;
const AUDIT_FILE = path.join(TMP_DIR, 'audit-log.json');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(p, { token, method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
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
    // ── فحص ساكن ──
    console.log('🧪 الفحص الساكن:');
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    check('readAuditLog يعزل الملف التالف (.corrupt-)', /audit-log\.json'?\s*\+\s*'\.corrupt-'|AUDIT_LOG_PATH \+ '\.corrupt-'/.test(serverSrc));
    check('readAuditLog يرجع [] بعد العزل بدل الرمي', /SyntaxError[\s\S]{0,500}return \[\]/.test(serverSrc));
    check('writeAuditLog ذرّية (tmp ثم rename)', /AUDIT_LOG_PATH \+ '\.tmp'[\s\S]{0,200}fs\.rename\(tmpPath, AUDIT_LOG_PATH\)/.test(serverSrc));
    check('الـcatch الخارجي يسجل الخطأ الحقيقي', /catch \(error\) \{\s*console\.error\('\[AuditLog\] GET \/api\/audit-log error:'/.test(serverSrc));

    // ── خادم معزول ──
    console.log('\n📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));

    console.log('🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    if (!(await waitReady())) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security.js'));
        const T_OP = jwt.sign({ id: 'uimap-tester', role: 'operator', name: 'مجس UI-Map' }, securityConfig.JWT_SECRET);

        console.log('\n🚪 الحراسة:');
        let r = await api('/api/audit-log');
        check('بلا توكن ← 401', r.status === 401);

        console.log('\n📄 الحالة A — لا ملف audit-log.json أصلًا:');
        check('الملف غير موجود في DATA_DIR المؤقت', !fs.existsSync(AUDIT_FILE));
        r = await api('/api/audit-log', { token: T_OP });
        check('GET ← 200 (ليس 500)', r.status === 200, 'status=' + r.status);
        check('logs مصفوفة', r.data && Array.isArray(r.data.logs));

        console.log('\n💥 الحالة B — ملف تالف (محاكاة restart وسط كتابة):');
        fs.writeFileSync(AUDIT_FILE, '[{"id":"1","action":"x"'); // JSON مقطوع
        r = await api('/api/audit-log', { token: T_OP });
        check('GET مع ملف تالف ← 200 (ليس 500)', r.status === 200, 'status=' + r.status);
        check('logs مصفوفة رغم التلف', r.data && Array.isArray(r.data.logs));
        const orphans = fs.readdirSync(TMP_DIR).filter(f => f.startsWith('audit-log.json.corrupt-'));
        check('الملف التالف عُزل إلى .corrupt-* (لم يُحذف)', orphans.length === 1, orphans.join(','));
        check('المسار الأصلي لم يعد موجودًا بعد العزل', !fs.existsSync(AUDIT_FILE));

        console.log('\n✍️ الحالة C — التعافي الذاتي: أول كتابة بعد العزل:');
        r = await api('/api/audit-log', { token: T_OP, method: 'POST', body: { action: 'ui-map-test', details: 'اختبار تعافي', category: 'test' } });
        check('POST ← نجاح', r.status === 200 && r.data && r.data.success, 'status=' + r.status);
        check('audit-log.json أُعيد إنشاؤه بصيغة صالحة', fs.existsSync(AUDIT_FILE) && Array.isArray(JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'))));
        const logs = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
        check('الإدخال الجديد موجود في الملف', logs.some(l => l.action === 'ui-map-test'));
        check('لا بقايا ملف مؤقت .tmp', !fs.existsSync(AUDIT_FILE + '.tmp'));

        console.log('\n🔁 الحالة D — قراءة طبيعية بعد التعافي:');
        r = await api('/api/audit-log', { token: T_OP });
        check('GET ← 200 والإدخال ظاهر', r.status === 200 && r.data.logs.some(l => l.action === 'ui-map-test'));
    } finally {
        server.kill();
    }

    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌');
    if (failed) { console.log('الفاشلة: ' + failures.join(' | ')); process.exit(1); }
    console.log('🟢 إصلاح audit-log مثبت: عزل التالف + كتابة ذرّية + تعافٍ ذاتي.');
})();
