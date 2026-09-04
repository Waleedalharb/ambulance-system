/**
 * ═══ assets-reports-test.js — اختبار قبول «المرحلة 6: التقارير والمخرجات» (اعتماد المالك 2026-08-23) ═══
 * على خادم معزول (نسخة مؤقتة — لا يمس بيانات حقيقية):
 *  R1 تقرير العهدة: كامل القاعدة + بفرقة محددة + CSV عربي بـBOM
 *  R2 تقرير الدورة: جلسات/نتائج/اعتماد + CSV
 *  R3 تقرير الفروقات: ملخص + حالات مصنفة + CSV
 *  R4 الحسم: viewer ← 403 على الثلاثة
 *  R5 الصفحة /assets/reports ← 200 HTML + شريط التنقل الموحد في كل الصفحات
 * التشغيل: node scripts/assets-reports-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'assets-rep-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
}
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

async function fetchCsv(url, token) {
    const res = await fetch(BASE + url, { headers: { Authorization: 'Bearer ' + token } });
    const buf = Buffer.from(await res.arrayBuffer());
    // text() يزيل BOM افتراضيًا — نفحص البايتات الخام ثم نفكّ الترميز يدويًا
    return { status: res.status, ct: res.headers.get('content-type') || '', hasBom: buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF, text: buf.toString('utf8') };
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
    // تشديد admin.users_manage (قرار المالك 2026-09-04): النجمة وحدها لا تكفي لمسارات الإدارة — بذر منحة فردية للمدير 4252 (معرّفه الفعلي emp-4252)
    wipe.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-4252','admin.users_manage',1,'test-bootstrap')").run();
    wipe.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    users.push({ id: 'astw3-' + STAMP, username: 'astworker3', name: 'موظف جرد التقارير', password: bcrypt.hashSync('w-pass', 10), role: 'user', isActive: true });
    users.push({ id: 'astv5-' + STAMP, username: 'astviewer5', name: 'قارئ بلا صلاحية', password: bcrypt.hashSync('x-pass', 10), role: 'user', isActive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify(users));
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
        let worker = (await api('/api/auth/login', { method: 'POST', body: { username: 'astworker3', password: 'w-pass' } })).data.accessToken;
        const viewer = (await api('/api/auth/login', { method: 'POST', body: { username: 'astviewer5', password: 'x-pass' } })).data.accessToken;

        // R4 مقدمًا: viewer بلا صلاحيات ← 403 على التقارير الثلاثة
        check('R4a viewer ← 403 على تقرير العهدة', (await api('/api/assets/reports/custody', { token: viewer })).status === 403);
        check('R4b viewer ← 403 على تقرير الفروقات', (await api('/api/assets/reports/discrepancies', { token: viewer })).status === 403);
        check('R4c viewer ← 403 على تقرير الدورة', (await api('/api/assets/reports/cycle/1', { token: viewer })).status === 403);

        // خط أساسي + دورة جرد فعلية صغيرة على جنوب 6 (لتقرير الدورة والفروقات)
        await api('/api/assets/import/stage', { method: 'POST', token: admin });
        await api('/api/assets/import/approve', { method: 'POST', token: admin });
        await api('/api/permissions/grant', { method: 'POST', token: admin, body: { user_id: 'astworker3', permission: 'assets.inventory' } });
        worker = (await api('/api/auth/login', { method: 'POST', body: { username: 'astworker3', password: 'w-pass' } })).data.accessToken;
        const cyc = await api('/api/assets/inventory/cycles', { method: 'POST', token: admin, body: { label: 'جرد تقرير الاختبار' } });
        await api(`/api/assets/inventory/cycles/${cyc.data.id}/activate`, { method: 'POST', token: admin });
        const cycles = (await api('/api/assets/inventory/cycles', { token: admin })).data.cycles;
        const s6 = cycles.find(c => c.id === cyc.data.id).sessions.find(s => s.team_name === 'جنوب 6');
        const exp = (await api(`/api/assets/inventory/sessions/${s6.id}`, { token: worker })).data.expected;
        await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: exp[0].id, result: 'ok' } });
        await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: exp[1].id, result: 'missing', reason: 'غير موجود' } });
        await api(`/api/assets/inventory/sessions/${s6.id}/submit`, { method: 'POST', token: worker });
        await api(`/api/assets/inventory/sessions/${s6.id}/approve`, { method: 'POST', token: admin });

        // R1 — تقرير العهدة
        const cust = await api('/api/assets/reports/custody', { token: admin });
        check('R1a تقرير العهدة: 607 أصول بكل الأعمدة', cust.status === 200 && cust.data.total === 607 &&
            cust.data.rows.every(r => r.asset_code && r.type_name && 'last_inventory_at' in r), `total=${cust.data.total}`);
        const custTeam = await api('/api/assets/reports/custody?team_name=' + encodeURIComponent('جنوب 6'), { token: admin });
        check('R1b تقرير العهدة بفرقة محددة — كل الصفوف لجنوب 6', custTeam.status === 200 &&
            custTeam.data.rows.length > 0 && custTeam.data.rows.every(r => r.team_name === 'جنوب 6'), `rows=${custTeam.data.total}`);
        const custCsv = await fetchCsv('/api/assets/reports/custody?format=csv', admin);
        check('R1c CSV العهدة: BOM عربي + ترويسة + صفوف', custCsv.status === 200 &&
            custCsv.ct.includes('text/csv') && custCsv.hasBom &&
            custCsv.text.includes('ASSET-ID') && custCsv.text.split('\r\n').length > 600, `rows=${custCsv.text.split('\r\n').length}`);

        // R2 — تقرير الدورة
        const cycRep = await api(`/api/assets/reports/cycle/${cyc.data.id}`, { token: admin });
        const s6rep = cycRep.data.sessions.find(s => s.team_name === 'جنوب 6');
        check('R2a تقرير الدورة: 31 جلسة وجنوب 6 معتمدة بنتائجها',
            cycRep.status === 200 && cycRep.data.cycle.label === 'جرد تقرير الاختبار' && cycRep.data.sessions.length === 31 &&
            s6rep && s6rep.status === 'approved' && s6rep.byResult.ok === 1 && s6rep.byResult.missing === 1 && s6rep.total === 2,
            JSON.stringify(s6rep && s6rep.byResult));
        check('R2b عناصر التقرير تفصيلية (نتيجة + سبب + سيريال)', s6rep.items.length === 2 && s6rep.items.some(i => i.result === 'missing' && i.reason === 'غير موجود'));
        check('R2c دورة غير موجودة ← 404', (await api('/api/assets/reports/cycle/99999', { token: admin })).status === 404);
        const cycCsv = await fetchCsv(`/api/assets/reports/cycle/${cyc.data.id}?format=csv`, admin);
        check('R2d CSV الدورة: BOM + صفّا عناصر جنوب 6', cycCsv.status === 200 && cycCsv.hasBom &&
            cycCsv.text.split('\r\n').length === 3 && cycCsv.text.includes('جنوب 6'), `lines=${cycCsv.text.split('\r\n').length}`);

        // R3 — تقرير الفروقات
        const discRep = await api('/api/assets/reports/discrepancies', { token: admin });
        check('R3a تقرير الفروقات: ملخص + حالات + تسميات + وقت توليد',
            discRep.status === 200 && discRep.data.summary.needs_decision > 0 && discRep.data.cases.length > 0 &&
            !!discRep.data.generated_at && !!discRep.data.category_labels && !!discRep.data.action_labels);
        check('R3b الحالة الجديدة (مفقود من الجرد) ظاهرة بفئتها وشرحها وإجرائها',
            discRep.data.cases.some(c => c.category === 'missing' && c.asset_id === exp[1].id && c.explanation && c.suggested_action === 'document_missing'));
        const discCsv = await fetchCsv('/api/assets/reports/discrepancies?format=csv', admin);
        check('R3c CSV الفروقات: BOM + صف لكل حالة', discCsv.status === 200 && discCsv.hasBom &&
            discCsv.text.split('\r\n').length === discRep.data.cases.length + 1, `lines=${discCsv.text.split('\r\n').length} cases=${discRep.data.cases.length}`);

        // R5 — الصفحة + شريط التنقل الموحد في كل الصفحات
        const pg = await fetch(BASE + '/assets/reports');
        const html = await pg.text();
        check('R5a /assets/reports ← 200 HTML وسكربت مطلق', pg.status === 200 && (pg.headers.get('content-type') || '').includes('text/html') && html.includes('src="/js/core/core-auth.js"'));
        check('R5b الطباعة مهيأة (@media print)', html.includes('@media print'));
        const pages = ['/assets-center', '/assets/discrepancies', '/assets/inventory', '/assets/asset', '/assets/import'];
        for (const p of pages) {
            const h = await (await fetch(BASE + p)).text();
            check('R5c شريط التنقل الموحد في ' + p, h.includes('/assets/reports') && h.includes('/assets/discrepancies') && h.includes('/assets/inventory'));
        }
    } finally {
        server.kill();
    }

    console.log(`\n═══ النتيجة: ${passed} ✅ / ${failed} ❌ ═══`);
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌ خطأ فادح:', e); process.exit(1); });
