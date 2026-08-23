/**
 * ═══ assets-center-test.js — اختبار قبول «مرحلة 3: مركز العهد والأجهزة» (اعتماد المالك 2026-08-23) ═══
 * على خادم معزول (نسخة مؤقتة — لا يمس بيانات حقيقية):
 *  B1 الاعتماد ينشئ دورة «الجرد التأسيسي» المغلقة + جلسة معتمدة لكل فرقة
 *     ويربط أحداث registered بها (⇐ «آخر جرد» له معنى من اليوم الأول)
 *  B2 /api/assets/dashboard: 607 أصلًا، حالات مطابقة، 38 نوعًا، آخر الحركات، lastCycle
 *  B3 البحث الذكي: «تترا» يجد أجهزة التترا بكل الأعمدة (مركز/فرقة/سيريال/حالة/آخر جرد)
 *  B4 البحث بالسيريال المكرر يجد الجهازين (لا دمج) وبطاقة كل منهما كاملة
 *  B5 البحث باسم الفرقة والمركز يعمل (q تغطي team_name/center_name)
 *  B6 الحسم الخادمي: مستخدم بلا assets.view ← 403 على اللوحة والقائمة والبطاقة
 * التشغيل: node scripts/assets-center-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3095;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'assets-center-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 200) : '')); }
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
    // عزل تام: بيانات الأصول في المصدر (إن وُجدت) لا تدخل الاختبار — النسخة تبدأ فارغة
    const wipe = new Database(TMP_DB);
    for (const t of ['asset_import_staging', 'asset_events', 'asset_replacements', 'inventory_items', 'inventory_sessions', 'inventory_cycles', 'assets', 'asset_types']) {
        try { wipe.prepare(`DELETE FROM ${t}`).run(); } catch (_) { }
    }
    wipe.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    users.push({ id: 'astv-' + STAMP, username: 'astviewer2', name: 'قارئ بلا صلاحية', password: bcrypt.hashSync('x-pass', 10), role: 'user', isActive: true });
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
        const viewer = (await api('/api/auth/login', { method: 'POST', body: { username: 'astviewer2', password: 'x-pass' } })).data.accessToken;

        // B6 أولًا (قبل الاعتماد): الحسم الخادمي
        check('B6a viewer ← 403 على اللوحة', (await api('/api/assets/dashboard', { token: viewer })).status === 403);
        check('B6b viewer ← 403 على القائمة', (await api('/api/assets', { token: viewer })).status === 403);

        // تجهيز: stage + approve
        await api('/api/assets/import/stage', { method: 'POST', token: admin });
        const ap = await api('/api/assets/import/approve', { method: 'POST', token: admin });
        check('B0 الاعتماد أنشأ 607 أصول', ap.status === 200 && ap.data.created === 607, JSON.stringify(ap.data).slice(0, 120));

        // B1 — الدورة التأسيسية
        const probe = new Database(TMP_DB, { readonly: true });
        const cycle = probe.prepare("SELECT * FROM inventory_cycles WHERE label LIKE '%تأسيسي%'").get();
        check('B1a دورة الجرد التأسيسي أُنشئت مغلقة', !!cycle && cycle.status === 'closed', cycle && cycle.status);
        const sess = probe.prepare('SELECT COUNT(*) c FROM inventory_sessions WHERE cycle_id = ?').get(cycle.id).c;
        const teamsCount = probe.prepare('SELECT COUNT(DISTINCT team_name) c FROM assets').get().c;
        check('B1b جلسة معتمدة لكل فرقة (' + teamsCount + ' فرقة)', sess === teamsCount, `sessions=${sess} teams=${teamsCount}`);
        const sessOk = probe.prepare("SELECT COUNT(*) c FROM inventory_sessions WHERE cycle_id = ? AND status='approved'").get(cycle.id).c;
        const linked = probe.prepare("SELECT COUNT(*) c FROM asset_events WHERE event_type='registered' AND session_id IS NOT NULL").get().c;
        check('B1c كل الجلسات معتمدة وكل أحداث التسجيل مربوطة بها', sessOk === sess && linked === 607, `approved=${sessOk}/${sess} linked=${linked}/607`);
        probe.close();

        // B2 — اللوحة
        const dash = await api('/api/assets/dashboard', { token: admin });
        const bs = {}; (dash.data.byStatus || []).forEach(r => { bs[r.status] = r.c; });
        check('B2a اللوحة: 607 أصلًا والحالات مطابقة', dash.status === 200 && dash.data.total === 607 && bs.working === 362 && bs.unknown === 199, JSON.stringify(bs));
        check('B2b 38 نوعًا + 259 مراجعة + 270 بلا سيريال', dash.data.byType.length === 38 && dash.data.needs_review === 259 && dash.data.no_serial === 270);
        check('B2c آخر الحركات معبأة + lastCycle = التأسيسية', dash.data.recentEvents.length === 25 && (dash.data.lastCycle.label || '').includes('تأسيسي') && dash.data.activeCycle === null);

        // B3 — البحث الذكي «تترا»
        const tetra = await api('/api/assets?q=' + encodeURIComponent('تترا'), { token: admin });
        // الأوراق التي لا تذكر مركزها (جنوب 16 / سريع 3 / سريع 4) تُعرض بمركز فارغ
        // وتبقى معلّمة needs_review — لا تخمين (قرار المالك: لا نخمّن البيانات الناقصة)
        const tOk = tetra.data.rows.length > 0 && tetra.data.rows.every(r =>
            r.type_name.includes('تترا') && r.team_name &&
            r.last_event_type === 'registered' && r.last_inventory_at &&
            (r.center_name || r.needs_review === 1));
        check('B3 بحث «تترا» ← الأعمدة مكتملة (المراكز غير المؤكدة معلّمة مراجعة، لا تخمين)', tetra.status === 200 && tOk, `rows=${tetra.data.total}`);

        // B4 — السيريال المكرر + البطاقة
        const dup = await api('/api/assets?q=2PN901510G8H0A3', { token: admin });
        const twoTeams = new Set(dup.data.rows.map(r => r.team_name));
        check('B4a السيريال المكرر يظهر جهازين بموقعين (لا دمج)', dup.data.total === 2 && twoTeams.size === 2, `total=${dup.data.total}`);
        const card = await api('/api/assets/' + dup.data.rows[0].id, { token: admin });
        check('B4b بطاقة الجهاز: بيانات + Timeline + مصدر Excel', card.status === 200 && card.data.asset.asset_code.startsWith('ASSET-')
            && card.data.events.length === 1 && (card.data.events[0].reason || '').includes('Excel') && Array.isArray(card.data.replacements));

        // B5 — البحث باسم الفرقة والمركز
        const byTeam = await api('/api/assets?q=' + encodeURIComponent('جنوب 6'), { token: admin });
        const byCenter = await api('/api/assets?q=' + encodeURIComponent('الحائر'), { token: admin });
        check('B5 البحث يطابق اسم الفرقة والمركز أيضًا', byTeam.data.total >= 16 && byCenter.data.total >= 18,
            `team=${byTeam.data.total} center=${byCenter.data.total}`);
        check('B6c viewer ← 403 على البطاقة', (await api('/api/assets/1', { token: viewer })).status === 403);

        // B7 — تقديم الصفحات: 200 + HTML + مسار سكربت مطلق (لا 404 JSON / لا MIME)
        for (const [route, name] of [['/assets-center', 'مركز العهد'], ['/assets/asset', 'بطاقة الجهاز'], ['/assets/import', 'الاستيراد التأسيسي']]) {
            const r = await fetch(BASE + route);
            const ct = r.headers.get('content-type') || '';
            const html = await r.text();
            check('B7 ' + name + ' (' + route + ') ← 200 HTML وسكربت مطلق', r.status === 200 && ct.includes('text/html') && html.includes('src="/js/core/core-auth.js"'));
        }
    } finally {
        server.kill();
    }

    console.log(`\n═══ النتيجة: ${passed} ✅ / ${failed} ❌ ═══`);
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌ خطأ فادح:', e); process.exit(1); });
