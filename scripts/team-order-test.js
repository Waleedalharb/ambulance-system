/**
 * ═══ team-order-test.js — اختبار ترتيب عرض الفرق المعتمد (2026-08-23) ═══
 * القاعدة (عرض فقط — الأسماء المخزنة لا تُمس):
 *   جنوب 1..17 رقميًا ← سريع 1..4 رقميًا ← «جنوب N 2..10» رقميًا ← مقر القطاع
 * يتحقق من نفس الترتيب في: لوحة المركز (byTeam) · جلسات الدورة · تقرير العهدة
 * ومن أن الأسماء نفسها لم تتغير (تطابق المجموعة الأصلية حرفيًا).
 * التشغيل: node scripts/team-order-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3098;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'team-order-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

// التسلسل المتوقع حرفيًا من البيانات الفعلية (31 فرقة)
const EXPECTED = [...Array(17)].map((_, i) => 'جنوب ' + (i + 1))
    .concat([...Array(4)].map((_, i) => 'سريع ' + (i + 1)))
    .concat([...Array(9)].map((_, i) => 'جنوب N ' + (i + 2)))
    .concat(['مقر القطاع']);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    const wipe = new Database(TMP_DB);
    for (const t of ['asset_import_staging', 'asset_events', 'asset_replacements', 'inventory_items', 'inventory_sessions', 'inventory_cycles', 'assets', 'asset_types']) {
        try { wipe.prepare(`DELETE FROM ${t}`).run(); } catch (_) { }
    }
    wipe.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    fs.copyFileSync(path.join(ROOT, 'data', 'asset-import-payload.json'), path.join(TMP_DIR, 'asset-import-payload.json'));

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const admin = (await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } })).data.accessToken;
        await api('/api/assets/import/stage', { method: 'POST', token: admin });
        await api('/api/assets/import/approve', { method: 'POST', token: admin });

        // T1 — لوحة المركز: byTeam بالترتيب الرقمي المعتمد
        const dash = await api('/api/assets/dashboard', { token: admin });
        const dashTeams = (dash.data.byTeam || []).map(t => t.team_name);
        check('T1 لوحة المركز: 31 فرقة بالترتيب المعتمد (جنوب ← سريع ← N ← مقر القطاع)',
            JSON.stringify(dashTeams) === JSON.stringify(EXPECTED), dashTeams.join(' | '));

        // T2 — جلسات الدورة بنفس الترتيب
        const cyc = await api('/api/assets/inventory/cycles', { method: 'POST', token: admin, body: { label: 'دورة ترتيب الفرق' } });
        await api(`/api/assets/inventory/cycles/${cyc.data.id}/activate`, { method: 'POST', token: admin });
        const cycles = (await api('/api/assets/inventory/cycles', { token: admin })).data.cycles;
        const sessTeams = cycles.find(c => c.id === cyc.data.id).sessions.map(s => s.team_name);
        check('T2 جلسات دورة الجرد: 31 جلسة بنفس الترتيب',
            JSON.stringify(sessTeams) === JSON.stringify(EXPECTED), sessTeams.join(' | '));

        // T3 — تقرير العهدة: تسلسل الفرق كما تظهر في الصفوف
        const cust = await api('/api/assets/reports/custody', { token: admin });
        const seen = [];
        for (const r of cust.data.rows) { if (!seen.includes(r.team_name)) seen.push(r.team_name); }
        check('T3 تقرير العهدة: الفرق تظهر بنفس الترتيب في الصفوف',
            JSON.stringify(seen) === JSON.stringify(EXPECTED), seen.join(' | '));

        // T4 — الأسماء لم تُمس: نفس المجموعة الأصلية حرفيًا (ترتيب عرض فقط)
        const probe = new Database(TMP_DB, { readonly: true });
        const dbNames = probe.prepare('SELECT DISTINCT team_name FROM assets ORDER BY team_name').all().map(r => r.team_name);
        probe.close();
        check('T4 الأسماء المخزنة لم تتغير (31 اسمًا حرفيًا بلا إعادة تسمية)',
            dbNames.length === 31 && EXPECTED.every(t => dbNames.includes(t)) && dbNames.includes('جنوب N 10'),
            dbNames.join(' | '));
    } finally {
        server.kill();
    }

    console.log(`\n═══ النتيجة: ${passed} ✅ / ${failed} ❌ ═══`);
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌ خطأ فادح:', e); process.exit(1); });
