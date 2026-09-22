/**
 * ═══ اختبار P1: المصدر الوحيد (SSOT) لإحداثيات المراكز التشغيلية ═══
 * اعتماد المالك 2026-09-21 — نطاق P1 فقط (سيرفري؛ لا ويب ولا iOS).
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3133/3134 — لا تمس بيانات الإنتاج.
 *
 * يغطي:
 *  1) GET /api/ops/centers ← 200، version:1، 9 مراكز جغرافية، نطاقات lat/lng صحيحة.
 *  2) integrity.complete === true على البيانات الحقيقية (الاختبار الحاسم —
 *     يثبت أن المراكز التسع + nonGeographicCenters يغطيان كل فرق FIELD_TEAM_TYPES).
 *  3) إملاء المفاتيح: «منفوحة» (تاء مربوطة) و«الشفاء» (ألف) موجودتان حرفيًا.
 *  4) الحراسة: 401 بلا توكن.
 *  5) انحدار: /api/center-geo القديم يرجع مفاتيح الفرق دون تغيير،
 *     وPOST /api/locate-report يعمل بنفس العقد.
 *  6) حالة ملف ناقص: سيرفر ثانٍ بـ CENTERS_GEO_PATH محذوف منه «الحائر» ←
 *     integrity.complete === false وmissing يسمّي الحائر وفرقها، والسيرفر يبقى حيًا.
 *
 * التشغيل: node scripts/centers-geo-p1-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
// قاعدة البيانات الحقيقية وملفات JSON تعيش في المستودع الرئيسي؛ الـworktree كود فقط.
const MAIN_REPO = path.join('C:\\', 'projects', 'Ambulance Dispatch');
const SRC_DATA = path.join(MAIN_REPO, 'data');
const SRC_DB = path.join(SRC_DATA, 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'cgp1-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DB2 = path.join(os.tmpdir(), 'cgp1b-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'cgp1-data-' + STAMP).replace(/\\/g, '/');
const TMP_DIR2 = path.join(os.tmpdir(), 'cgp1b-data-' + STAMP).replace(/\\/g, '/');
const BROKEN_GEO = path.join(os.tmpdir(), 'cgp1-broken-' + STAMP + '.json').replace(/\\/g, '/');
const PORT = 3133;
const PORT2 = 3134;
const BASE = 'http://127.0.0.1:' + PORT;
const BASE2 = 'http://127.0.0.1:' + PORT2;

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

// الـworktree قد يفتقد better-sqlite3/bcryptjs — نحسم من المستودع الرئيسي عند الحاجة.
const MAIN_MODULES = path.join('C:\\', 'projects', 'Ambulance Dispatch', 'node_modules');
function resolveModule(name) {
    const local = path.join(ROOT, 'node_modules', name);
    return fs.existsSync(local) ? local : path.join(MAIN_MODULES, name);
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
    users.push({ id: 'emp-CG1', username: 'CG001', name: 'قارئ مراكز p1', password: hash, role: 'user', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}

function boot(port, tmpDb, tmpDir, extraEnv) {
    // NODE_PATH: الـworktree قد يفتقد bcryptjs/better-sqlite3 — يُحمَّلان من المستودع الرئيسي
    const nodePath = path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES;
    const env = { ...process.env, PORT: String(port), DB_PATH: tmpDb, DATA_DIR: tmpDir, NODE_ENV: 'test', NODE_PATH: nodePath, ...(extraEnv || {}) };
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server:' + port + ']', s.slice(0, 200)); });
    return server;
}

async function login(base) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'CG001', password: 'test1234' }) });
    const b = await r.json();
    return b.accessToken || null;
}
async function apiGet(base, p, tok) {
    const r = await fetch(base + p, { headers: tok ? { Authorization: 'Bearer ' + tok } : {} });
    let body = null;
    try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

const EXPECTED_CENTERS = ['المنصورة', 'الخالدية', 'منفوحة', 'الدار البيضاء', 'الإسكان', 'الشفاء', 'عكاظ', 'ديراب', 'الحائر'];

(async () => {
    let server = null, server2 = null;
    try {
        // ═══ السيناريو الأول: المرجع الكامل على البيانات الحقيقية ═══
        makeIsolated(TMP_DB, TMP_DIR);
        console.log('🧪 خادم معزول على ' + PORT + ' — P1 مرجع إحداثيات المراكز (SSOT)');
        server = boot(PORT, TMP_DB, TMP_DIR);
        check('0) الخادم المعزول أقلع', await waitReady(BASE));

        const tok = await login(BASE);
        check('0أ) تسجيل دخول مستخدم الاختبار', !!tok);

        // الحراسة
        const noTok = await apiGet(BASE, '/api/ops/centers', null);
        check('1) GET /api/ops/centers بلا توكن ← 401', noTok.status === 401, 'status=' + noTok.status);

        // العقد الأساسي
        const res = await apiGet(BASE, '/api/ops/centers', tok);
        check('2) GET /api/ops/centers ← 200 + success', res.status === 200 && res.body && res.body.success === true,
            'status=' + res.status + ' body=' + JSON.stringify(res.body).slice(0, 200));
        check('3) version === 1', res.body && res.body.version === 1, String(res.body && res.body.version));

        const centers = (res.body && res.body.data) || {};
        const names = Object.keys(centers);
        check('4) تسعة مراكز جغرافية بالضبط', names.length === 9, 'count=' + names.length + ' : ' + names.join(' | '));
        check('5) كل المراكز التسعة المتوقعة موجودة بالأسماء الحرفية',
            EXPECTED_CENTERS.every(n => names.includes(n)),
            'missing=' + EXPECTED_CENTERS.filter(n => !names.includes(n)).join(' | '));
        check('6) إملاء «منفوحة» بتاء مربوطة و«الشفاء» بألف',
            !!centers['منفوحة'] && !!centers['الشفاء'] && !centers['منفوحه'] && !centers['الشفا']);

        let coordsOk = names.length > 0;
        for (const n of names) {
            const c = centers[n] && centers[n].center;
            if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'number' || typeof c[1] !== 'number' ||
                c[0] < 24.3 || c[0] > 24.8 || c[1] < 46.5 || c[1] > 47.0) coordsOk = false;
        }
        check('7) كل الإحداثيات [lat,lng] أرقام ضمن نطاق الرياض المعقول', coordsOk,
            JSON.stringify(names.map(n => [n, centers[n] && centers[n].center])));

        // الاختبار الحاسم: سلامة المرجع على البيانات الحقيقية
        const integ = (res.body && res.body.integrity) || {};
        check('8) integrity.complete === true على البيانات الحقيقية (تغطية كل الفرق الميدانية)',
            integ.complete === true, JSON.stringify(integ).slice(0, 400));
        check('9) integrity.missing فارغة', Array.isArray(integ.missing) && integ.missing.length === 0,
            JSON.stringify(integ.missing));

        // انحدار: المسار القديم وعقدته لا يتغيران
        const oldGeo = await apiGet(BASE, '/api/center-geo', tok);
        const oldKeys = oldGeo.body && oldGeo.body.data ? Object.keys(oldGeo.body.data) : [];
        check('10) انحدار: /api/center-geo القديم يرجع مفاتيح الفرق (مثل «جنوب 1») دون تغيير',
            oldGeo.status === 200 && oldKeys.includes('جنوب 1'), 'keys=' + oldKeys.slice(0, 5).join(' | '));

        const loc = await fetch(BASE + '/api/locate-report', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
            body: JSON.stringify({ lat: 24.6142, lng: 46.7511 }) // قرب مركز المنصورة القديم
        });
        const locBody = await loc.json().catch(() => null);
        check('11) انحدار: POST /api/locate-report يعمل بنفس العقد (center/location)',
            loc.status === 200 && locBody && locBody.success === true && 'center' in locBody && 'location' in locBody,
            'status=' + loc.status + ' body=' + JSON.stringify(locBody).slice(0, 200));

        // ═══ السيناريو الثاني: ملف ناقص — خطأ ظاهر بلا فشل صامت والسيرفر حي ═══
        const fullGeo = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operational-centers.json'), 'utf8'));
        delete fullGeo.centers['الحائر'];
        fs.writeFileSync(BROKEN_GEO, JSON.stringify(fullGeo, null, 2));

        makeIsolated(TMP_DB2, TMP_DIR2);
        console.log('🧪 خادم ثانٍ على ' + PORT2 + ' — ملف مرجع محذوف منه «الحائر»');
        server2 = boot(PORT2, TMP_DB2, TMP_DIR2, { CENTERS_GEO_PATH: BROKEN_GEO });
        check('12) الخادم الثاني أقلع رغم نقص المرجع (لا يسقط السيرفر)', await waitReady(BASE2));

        const tok2 = await login(BASE2);
        const res2 = await apiGet(BASE2, '/api/ops/centers', tok2);
        const integ2 = (res2.body && res2.body.integrity) || {};
        const missing2 = integ2.missing || [];
        const haiEntry = missing2.find(m => m.center === 'الحائر');
        check('13) ملف ناقص: integrity.complete === false', res2.status === 200 && integ2.complete === false,
            JSON.stringify(integ2).slice(0, 300));
        check('14) missing يسمّي «الحائر» صراحة مع فرقه المتأثرة (بلا فشل صامت)',
            !!haiEntry && Array.isArray(haiEntry.teams) && haiEntry.teams.length > 0,
            JSON.stringify(missing2).slice(0, 300));
        check('15) الملف الناقص ما زال يقدّم الثمانية مراكز المتبقية (قراءة لا تنهار)',
            res2.body && res2.body.data && Object.keys(res2.body.data).length === 8,
            'count=' + (res2.body && res2.body.data ? Object.keys(res2.body.data).length : 'n/a'));

    } catch (e) {
        check('سير الاختبار بلا استثناء', false, e.message);
    }

    console.log('');
    console.log('════════════════ P1 مرجع إحداثيات المراكز: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    if (server) server.kill();
    if (server2) server2.kill();
    for (const p of [TMP_DIR, TMP_DIR2]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { } }
    for (const p of [TMP_DB, TMP_DB2, BROKEN_GEO]) { try { fs.unlinkSync(p); } catch (_) { } }
    process.exit(failed ? 1 : 0);
})();
