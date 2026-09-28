/**
 * ═══ web-ssot-parity-test.js — اختبار تكافؤ P3: الويب على المصدر الوحيد ═══
 * اعتماد المالك 2026-09-21 — نطاق P3 (teamCenters + نقل الويب إلى SSOT).
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورتات 3135/3136/3137 — لا تمس الإنتاج.
 *
 * يغطي (شروط الاعتماد):
 *  1) عقد teamCenters: سريع 1/2/3 حسب DB (الدار البيضاء/الشفاء/الخالدية) —
 *     الحسم في التعارض المكتشف بين centersData وteamCenterMap القديمين.
 *  2) جنوب 11/12 ← المنصورة (كانتا غائبتين من خريطة الويب القديمة).
 *  3) جنوب 13–19 ← «الفرق الإضافية» و«العمليات»: غير جغرافية — لا إحداثيات
 *     لها في data ولا تُخفى من teamCenters.
 *  4) كل فرقة ميدانية يُحل مركزها (data ∪ nonGeographic) — غير القابلة للحل
 *     تُوثَّق بأسمائها ولا تُخفى.
 *  5) parity: /api/staffing/state يحمل center مطابقًا لـ teamCenters.
 *  6) /api/data: centers مشتقة من DB (المنصورة فيها جنوب 11/12 وليس سريع 3).
 *  7) مرجع ناقص (الحائر محذوف): integrity=false يسمّي الحائر وجنوب 7،
 *     وteamCenters تبقى كاملة، وdata تقدّم الثمانية المتبقية.
 *  8) فشل كامل (ملف غير موجود): data={} + loadError صريح + السيرفر حي.
 *
 * التشغيل: node scripts/web-ssot-parity-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const MAIN_REPO = path.join('C:\\', 'projects', 'Ambulance Dispatch');
const SRC_DATA = path.join(MAIN_REPO, 'data');
const SRC_DB = path.join(SRC_DATA, 'ambulance.db');
const STAMP = Date.now();
const tmp = (n) => path.join(os.tmpdir(), 'wsp3-' + n + '-' + STAMP).replace(/\\/g, '/');
const PORTS = { full: 3135, broken: 3136, missing: 3137 };

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(base, tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(base + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
function resolveModule(name) {
    const local = path.join(ROOT, 'node_modules', name);
    return fs.existsSync(local) ? local : path.join(MAIN_REPO, 'node_modules', name);
}
function makeIsolated(tmpDb, tmpDir) {
    const Database = require(resolveModule('better-sqlite3'));
    const bcrypt = require(resolveModule('bcryptjs'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + tmpDb + "'");
    src.close();
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const f of fs.readdirSync(SRC_DATA)) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(tmpDir, f)); } catch (_) { } }
    }
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(tmpDir, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    users.push({ id: 'emp-WP3', username: 'WP300', name: 'قارئ تكافؤ p3', password: hash, role: 'user', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}
function boot(port, tmpDb, tmpDir, extraEnv) {
    const nodePath = path.join(ROOT, 'node_modules') + ';' + path.join(MAIN_REPO, 'node_modules');
    const env = { ...process.env, PORT: String(port), DB_PATH: tmpDb, DATA_DIR: tmpDir, NODE_ENV: 'test', NODE_PATH: nodePath, ...(extraEnv || {}) };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server:' + port + ']', s.slice(0, 200)); });
    return server;
}
async function login(base) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'WP300', password: 'test1234' }) });
    const b = await r.json();
    return b.accessToken || null;
}
async function apiGet(base, p, tok) {
    const r = await fetch(base + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
    let body = null;
    try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

(async () => {
    const servers = [];
    const artifacts = [];
    try {
        // ═══ السيناريو الأول: المرجع الكامل ═══
        const db1 = tmp('a.db'), dir1 = tmp('a-data');
        makeIsolated(db1, dir1);
        artifacts.push(db1, dir1);
        console.log('🧪 خادم معزول على ' + PORTS.full + ' — P3 تكافؤ الويب مع SSOT');
        servers.push(boot(PORTS.full, db1, dir1));
        check('0) الخادم المعزول أقلع', await waitReady('http://127.0.0.1:' + PORTS.full));
        const BASE = 'http://127.0.0.1:' + PORTS.full;
        const tok = await login(BASE);
        check('0أ) تسجيل دخول مستخدم الاختبار', !!tok);

        const res = await apiGet(BASE, '/api/ops/centers', tok);
        const tc = (res.body && res.body.teamCenters) || {};
        const data = (res.body && res.body.data) || {};
        check('1) العقد يحوي teamCenters', res.status === 200 && res.body && typeof res.body.teamCenters === 'object' && res.body.teamCenters !== null,
            JSON.stringify(res.body).slice(0, 200));
        check('2) teamCenters نص فقط — لا إحداثيات داخله',
            Object.values(tc).every(v => typeof v === 'string'));

        // ① حسم التعارض المكتشف: سريع 1/2/3 حسب DB (لا centersData ولا teamCenterMap القديمين)
        check('3) سريع 1 ← الدار البيضاء (DB)', tc['سريع 1'] === 'الدار البيضاء', tc['سريع 1']);
        check('4) سريع 2 ← الشفاء (DB)', tc['سريع 2'] === 'الشفاء', tc['سريع 2']);
        check('5) سريع 3 ← الخالدية (DB)', tc['سريع 3'] === 'الخالدية', tc['سريع 3']);

        // ② الفرق الغائبة سابقًا عن خريطة الويب
        check('6) جنوب 11 ← المنصورة (كانت غائبة من الجدول القديم)', tc['جنوب 11'] === 'المنصورة', tc['جنوب 11']);
        check('7) جنوب 12 ← المنصورة (كانت غائبة من الجدول القديم)', tc['جنوب 12'] === 'المنصورة', tc['جنوب 12']);

        // ③ المراكز غير الجغرافية: مصرّح بها نصًا، بلا إحداثيات
        check('8) جنوب 13–19 ← الفرق الإضافية (نصيًا)',
            ['جنوب 13', 'جنوب 14', 'جنوب 15', 'جنوب 16', 'جنوب 17', 'جنوب 18', 'جنوب 19'].every(t => tc[t] === 'الفرق الإضافية'));
        check('9) «الفرق الإضافية» و«العمليات» لا إحداثيات لهما في data',
            !data['الفرق الإضافية'] && !data['العمليات']);

        // ④ كل فرقة ميدانية يُحل مركزها — غير القابلة تُوثَّق بلا إخفاء
        const geoNames = new Set(Object.keys(data).concat(['العمليات', 'الفرق الإضافية']));
        const unresolvable = Object.keys(tc).filter(t => !geoNames.has(tc[t]));
        check('10) كل الفرق الميدانية قابلة للحل (غير القابلة: ' + (unresolvable.join(' | ') || 'لا يوجد') + ')',
            unresolvable.length === 0, unresolvable.join(' | '));

        // ⑤ parity مع staffing/state
        const st = await apiGet(BASE, '/api/staffing/state', tok);
        const stTeams = (st.body && st.body.teams) || null;
        if (stTeams && Object.keys(stTeams).length > 0) {
            const mismatch = Object.keys(stTeams).filter(t => stTeams[t] && stTeams[t].center && tc[t] && stTeams[t].center !== tc[t]);
            check('11) parity: staffing/state.center مطابق لـ teamCenters لكل فرقة مشتركة',
                mismatch.length === 0, mismatch.map(t => t + ':' + stTeams[t].center + '≠' + tc[t]).join(' | '));
        } else {
            check('11) parity: staffing/state — لا مناوبة نشطة في النسخة المعزولة (يُختبر على التشغيل)', true);
        }

        // ⑥ /api/data: centers مشتقة من DB
        const d = await apiGet(BASE, '/api/data', tok);
        const centers = (d.body && d.body.centers) || {};
        check('12) /api/data: المنصورة تضم جنوب 1 و11 و12 (اشتقاق DB)',
            (centers['المنصورة'] || []).includes('جنوب 1') && (centers['المنصورة'] || []).includes('جنوب 11') && (centers['المنصورة'] || []).includes('جنوب 12'),
            JSON.stringify(centers['المنصورة']));
        check('13) /api/data: سريع 3 في الخالدية وليس المنصورة (زوال الجدول الثابت القديم)',
            (centers['الخالدية'] || []).includes('سريع 3') && !(centers['المنصورة'] || []).includes('سريع 3'),
            'الخالدية=' + JSON.stringify(centers['الخالدية']));
        check('14) /api/data: «الفرق الإضافية» تضم جنوب 13–19 (سريع 4 في المنصورة حسب DB)',
            ['جنوب 13', 'جنوب 19'].every(t => (centers['الفرق الإضافية'] || []).includes(t)) && !(centers['الفرق الإضافية'] || []).includes('سريع 4'),
            JSON.stringify(centers['الفرق الإضافية']));

        const integ = (res.body && res.body.integrity) || {};
        check('15) integrity.complete === true على البيانات الحقيقية', integ.complete === true, JSON.stringify(integ).slice(0, 300));

        // ═══ السيناريو الثاني: مرجع ناقص (الحائر محذوف) ═══
        const fullGeo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operational-centers.json'), 'utf8'));
        delete fullGeo.centers['الحائر'];
        const brokenGeo = tmp('broken.json');
        fs.writeFileSync(brokenGeo, JSON.stringify(fullGeo, null, 2));
        artifacts.push(brokenGeo);
        const db2 = tmp('b.db'), dir2 = tmp('b-data');
        makeIsolated(db2, dir2);
        artifacts.push(db2, dir2);
        console.log('🧪 خادم ثانٍ على ' + PORTS.broken + ' — مرجع ناقص (الحائر محذوف)');
        servers.push(boot(PORTS.broken, db2, dir2, { CENTERS_GEO_PATH: brokenGeo }));
        const BASE2 = 'http://127.0.0.1:' + PORTS.broken;
        check('16) الخادم الثاني أقلع رغم نقص المرجع', await waitReady(BASE2));
        const tok2 = await login(BASE2);
        const res2 = await apiGet(BASE2, '/api/ops/centers', tok2);
        const integ2 = (res2.body && res2.body.integrity) || {};
        const missing2 = integ2.missing || [];
        const hai = missing2.find(m => m.center === 'الحائر');
        check('17) مرجع ناقص: integrity.complete === false', res2.status === 200 && integ2.complete === false);
        check('18) missing يسمّي الحائر مع جنوب 7 (بلا فشل صامت)', !!hai && (hai.teams || []).includes('جنوب 7'),
            JSON.stringify(missing2).slice(0, 300));
        check('19) teamCenters تبقى كاملة رغم نقص المرجع (جنوب 7 ← الحائر نصيًا)',
            res2.body && res2.body.teamCenters && res2.body.teamCenters['جنوب 7'] === 'الحائر');
        check('20) data تقدّم الثمانية مراكز المتبقية (قراءة لا تنهار)',
            res2.body && res2.body.data && Object.keys(res2.body.data).length === 8);

        // ═══ السيناريو الثالث: فشل كامل (ملف غير موجود) ═══
        const ghostGeo = tmp('ghost.json'); // لا يُنشأ أصلًا
        const db3 = tmp('c.db'), dir3 = tmp('c-data');
        makeIsolated(db3, dir3);
        artifacts.push(db3, dir3);
        console.log('🧪 خادم ثالث على ' + PORTS.missing + ' — ملف مرجع غير موجود (فشل كامل)');
        servers.push(boot(PORTS.missing, db3, dir3, { CENTERS_GEO_PATH: ghostGeo }));
        const BASE3 = 'http://127.0.0.1:' + PORTS.missing;
        check('21) الخادم الثالث أقلع رغم فشل المرجع الكامل', await waitReady(BASE3));
        const tok3 = await login(BASE3);
        const res3 = await apiGet(BASE3, '/api/ops/centers', tok3);
        const integ3 = (res3.body && res3.body.integrity) || {};
        check('22) فشل كامل: success=true + data فارغة (لا إحداثيات وهمية)',
            res3.status === 200 && res3.body && res3.body.success === true && res3.body.data && Object.keys(res3.body.data).length === 0,
            JSON.stringify(res3.body).slice(0, 250));
        check('23) فشل كامل: integrity.loadError صريح وcomplete=false',
            integ3.complete === false && typeof integ3.loadError === 'string' && integ3.loadError.length > 0,
            JSON.stringify(integ3).slice(0, 250));
        check('24) فشل كامل: teamCenters ما زالت تُقدَّم من DB (الربط لا يموت مع ملف الإحداثيات)',
            res3.body && res3.body.teamCenters && res3.body.teamCenters['جنوب 1'] === 'المنصورة');

    } catch (e) {
        check('سير الاختبار بلا استثناء', false, e.message);
    }

    console.log('');
    console.log('════════════════ P3 تكافؤ الويب مع SSOT: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    for (const s of servers) { try { s.kill(); } catch (_) { } }
    for (const p of artifacts) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { }
    }
    process.exit(failed ? 1 : 0);
})();
