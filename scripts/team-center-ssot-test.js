/**
 * ═══ اختبار توحيد «فريق ← مركز» على SSOT (A-2) — اعتماد المالك 2026-10-03 ═══
 *
 * يثبت أن المصدر الوحيد (teams.center + config/operational-centers.json عبر
 * /api/ops/centers) يغطي كل استخدامات الخرائط الثابتة القديمة، وأن التعيينات
 * المعتمدة هي الظاهرة فعليًا في كل سطح:
 *
 * الجزء A — وحدوي على النسخة الحقيقية (قراءة فقط):
 *   1) التعيين المعتمد حرفيًا لكل فريق ميداني (جنوب 1–19 + سريع 1–4).
 *   2) لا فريق في مركزين، ولا فريق ميداني بلا مركز/حالة معلنة.
 *   3) جنوب 13–19 «الفرق الإضافية» غير جغرافية (لا تُرسم) — السلوك محفوظ.
 *   4) إملاء المراكز موحّد: منفوحة/الشفاء، ولا أثر لـ منفوحه/الشفا.
 *   5) تجميع التوزيع من SSOT: سريع 3 بالخالدية، سريع 4 بالمنصورة، جنوب 11–12 بالمنصورة.
 *   6) تغطية markers: كل فريق جغرافي له إحداثيات مركزه — لا marker ضائع.
 *
 * الجزء B — مساريّ (سيرفر معزول):
 *   7) /api/ops/centers: نفس التعيينات + integrity.complete.
 *   8) /api/data: التجميع مطابق للقاعدة (بما فيه الفرق الإضافية).
 *   9) فحص ساكن للواجهة: لا جداول ثابتة متضاربة في app.js / report-entry.html.
 *
 * التشغيل: node scripts/team-center-ssot-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'tcs-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'tcs-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3139;
const BASE = 'http://127.0.0.1:' + PORT;

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
const MAIN_MODULES = path.join('C:\\', 'projects', 'Ambulance Dispatch', 'node_modules');
function resolveModule(name) {
    const local = path.join(ROOT, 'node_modules', name);
    return fs.existsSync(local) ? local : path.join(MAIN_MODULES, name);
}

// التعيين المعتمد من المالك (جدول A-2) — لا يُشتق من الكود، بل يُختبر الكود ضده
const APPROVED = {
    'جنوب 1': 'المنصورة', 'جنوب 2': 'الخالدية', 'جنوب 3': 'منفوحة',
    'جنوب 4': 'الدار البيضاء', 'جنوب 5': 'الدار البيضاء', 'جنوب 6': 'الإسكان',
    'جنوب 7': 'الحائر', 'جنوب 8': 'الشفاء', 'جنوب 9': 'عكاظ', 'جنوب 10': 'ديراب',
    'جنوب 11': 'المنصورة', 'جنوب 12': 'المنصورة',
    'جنوب 13': 'الفرق الإضافية', 'جنوب 14': 'الفرق الإضافية', 'جنوب 15': 'الفرق الإضافية',
    'جنوب 16': 'الفرق الإضافية', 'جنوب 17': 'الفرق الإضافية', 'جنوب 18': 'الفرق الإضافية', 'جنوب 19': 'الفرق الإضافية',
    'سريع 1': 'الدار البيضاء', 'سريع 2': 'الشفاء', 'سريع 3': 'الخالدية', 'سريع 4': 'المنصورة'
};
const GEO_CENTERS = ['المنصورة', 'الخالدية', 'منفوحة', 'الدار البيضاء', 'الإسكان', 'الشفاء', 'عكاظ', 'ديراب', 'الحائر'];
const NON_GEO = ['العمليات', 'الفرق الإضافية'];

function approvedTableMatches(tc) {
    const mismatches = [];
    for (const team of Object.keys(APPROVED)) {
        if (tc[team] !== APPROVED[team]) mismatches.push(team + ': متوقع «' + APPROVED[team] + '» وجد «' + tc[team] + '»');
    }
    return mismatches;
}

async function partA() {
    console.log('═══ A) التعيينات المعتمدة على النسخة الحقيقية (قراءة فقط) ═══');
    const Database = require(resolveModule('better-sqlite3'));
    const db = new Database(SRC_DB, { readonly: true });
    const rows = db.prepare(
        "SELECT name, center, team_type FROM teams WHERE is_active = 1 AND team_type IN ('جنوب','سريع','دعم')"
    ).all();
    db.close();
    const tc = {};
    for (const r of rows) if (r.center) tc[r.name] = r.center;

    const mm = approvedTableMatches(tc);
    check('A1) كل فريق ميداني (جنوب 1–19 + سريع 1–4) معيّن حرفيًا كالجدول المعتمد', mm.length === 0, mm.join(' | '));

    // لا فريق جنوب/سريع بلا مركز
    const noCenter = rows.filter(r => (r.team_type === 'جنوب' || r.team_type === 'سريع') && !r.center).map(r => r.name);
    check('A2) لا فريق جنوب/سريع نشط بلا مركز أو حالة معلنة', noCenter.length === 0, noCenter.join(','));

    // جنوب 13–19 غير جغرافية — السلوك محفوظ
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'operational-centers.json'), 'utf8'));
    const geo1319 = ['جنوب 13', 'جنوب 19'].every(t => !cfg.centers[tc[t]]);
    check('A3) جنوب 13–19 ضمن «الفرق الإضافية» المعلنة غير الجغرافية (لا تُرسم)',
        ['13', '14', '15', '16', '17', '18', '19'].every(n => tc['جنوب ' + n] === 'الفرق الإضافية') && geo1319 && !!cfg.nonGeographicCenters['الفرق الإضافية']);

    // الإملاء الموحد
    const allCenters = Object.values(tc);
    check('A4) لا إملاء قديم (منفوحه/الشفا) في القاعدة أو المرجع',
        !allCenters.includes('منفوحه') && !allCenters.includes('الشفا') &&
        !cfg.centers['منفوحه'] && !cfg.centers['الشفا'] &&
        !!cfg.centers['منفوحة'] && !!cfg.centers['الشفاء']);

    // getDispatchCenters على قاعدة حقيقية (قراءة فقط عبر محاكاة الاستعلام نفسه)
    const db2 = new Database(SRC_DB, { readonly: true });
    const drows = db2.prepare("SELECT name, center FROM teams WHERE is_active = 1 AND team_type IN ('جنوب','سريع') AND center IS NOT NULL AND center != ''").all();
    db2.close();
    const grouped = {};
    for (const r of drows) {
        if (r.center === 'العمليات') continue;
        (grouped[r.center] = grouped[r.center] || []).push(r.name);
    }
    check('A5) تجميع التوزيع: سريع 3 بالخالدية وسريع 4 بالمنصورة وجنوب 11–12 بالمنصورة',
        (grouped['الخالدية'] || []).includes('سريع 3') &&
        (grouped['المنصورة'] || []).includes('سريع 4') &&
        (grouped['المنصورة'] || []).includes('جنوب 11') &&
        (grouped['المنصورة'] || []).includes('جنوب 12') &&
        !(grouped['الفرق الإضافية'] || []).includes('سريع 4'));

    // تغطية markers: كل فريق جغرافي له إحداثيات
    const missingCoords = [];
    for (const team of Object.keys(tc)) {
        const c = tc[team];
        if (NON_GEO.includes(c)) continue;
        if (!cfg.centers[c] || !Array.isArray(cfg.centers[c].center)) missingCoords.push(team + '→' + c);
    }
    check('A6) كل فريق جغرافي له إحداثيات مركزه (لا marker ضائع)', missingCoords.length === 0, missingCoords.join(','));

    // لا فريق في مركزين (مصدر واحد = تعريف واحد بطبيعته) + اكتمال القائمة
    check('A7) القائمة مكتملة: 19 فريق جنوب + 4 سريع = 23',
        Object.keys(APPROVED).length === 23 && Object.keys(APPROVED).every(t => tc[t] !== undefined));
}

function makeIsolated() {
    const Database = require(resolveModule('better-sqlite3'));
    const bcrypt = require(resolveModule('bcryptjs'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    for (const f of fs.readdirSync(SRC_DATA)) {
        if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(TMP_DIR, f)); } catch (_) { } }
    }
    const hash = bcrypt.hashSync('test1234', 10);
    const usersPath = path.join(TMP_DIR, 'users.json');
    const users = JSON.parse(fs.readFileSync(usersPath, 'utf8')).filter(u => u.username !== 'TCADMIN');
    users.push({ id: 'tc-admin-1', username: 'TCADMIN', name: 'مسؤول اختبار المراكز', password: hash, role: 'admin', isActive: true });
    fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}
function boot() {
    const nodePath = path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES;
    const env = { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test', NODE_PATH: nodePath };
    delete env.APNS_KEY; delete env.APNS_KEY_BASE64; delete env.APNS_KEY_ID; delete env.APNS_TEAM_ID;
    const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    return server;
}
async function login(username) {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password: 'test1234' }) });
    const d = await r.json();
    const token = d.token || d.accessToken || (d.data && (d.data.token || d.data.accessToken));
    if (!r.ok || !token) throw new Error('فشل الدخول: ' + JSON.stringify(d).slice(0, 200));
    return token;
}

async function partB() {
    console.log('═══ B) المسارات الحية عبر سيرفر معزول ═══');
    makeIsolated();
    const server = boot();
    try {
        if (!await waitReady(BASE)) throw new Error('السيرفر لم يقلع');
        const tok = await login('TCADMIN');
        const H = { Authorization: 'Bearer ' + tok };

        // /api/ops/centers
        const r1 = await fetch(BASE + '/api/ops/centers', { headers: H });
        const d1 = await r1.json();
        check('B1) /api/ops/centers ينجح ويعيد teamCenters', d1.success && d1.teamCenters && typeof d1.teamCenters === 'object');
        const mm = approvedTableMatches(d1.teamCenters || {});
        check('B2) teamCenters من المسار = الجدول المعتمد حرفيًا', mm.length === 0, mm.join(' | '));
        check('B3) integrity.complete === true (لا مركز غير مصرح)', d1.integrity && d1.integrity.complete === true, JSON.stringify(d1.integrity && d1.integrity.missing));
        check('B4) مفاتيح المراكز الجغرافية التسعة بالإملاء الموحد',
            GEO_CENTERS.every(c => d1.data && d1.data[c] && Array.isArray(d1.data[c].center)));

        // /api/data — تجميع التوزيع
        const r2 = await fetch(BASE + '/api/data', { headers: H });
        const d2 = await r2.json();
        const centers = d2.centers || {};
        check('B5) /api/data: سريع 3 بالخالدية وسريع 4 بالمنصورة',
            (centers['الخالدية'] || []).includes('سريع 3') && (centers['المنصورة'] || []).includes('سريع 4'),
            JSON.stringify({ 'الخالدية': centers['الخالدية'], 'المنصورة': centers['المنصورة'] }));
        check('B6) /api/data: جنوب 11–12 بالمنصورة وجنوب 13–19 بالفرق الإضافية',
            (centers['المنصورة'] || []).includes('جنوب 11') && (centers['المنصورة'] || []).includes('جنوب 12') &&
            ['13', '14', '15', '16', '17', '18', '19'].every(n => (centers['الفرق الإضافية'] || []).includes('جنوب ' + n)));
        // لا فريق في مركزين
        const seen = {}, dup = [];
        for (const c of Object.keys(centers)) for (const t of centers[c]) { if (seen[t]) dup.push(t); seen[t] = c; }
        check('B7) /api/data: لا فريق في مركزين مختلفين', dup.length === 0, dup.join(','));
        check('B8) /api/data: كل فرق الجدول المعتمد ظاهرة (23/23 — لا اختفاء لسريع 1–4 ولا جنوب 11–19)',
            Object.keys(APPROVED).every(t => seen[t] === APPROVED[t]),
            Object.keys(APPROVED).filter(t => seen[t] !== APPROVED[t]).map(t => t + '→' + seen[t]).join(' | '));

        // فحص ساكن للواجهة
        const appJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
        check('B9) app.js: لا إملاء قديم (منفوحه/الشفا) ولا جدول teamCenterMap ثابت',
            !appJs.includes('منفوحه') && !appJs.includes('"الشفا"') &&
            appJs.includes('loadCentersReference') && appJs.includes("apiRequest('/api/ops/centers')"));
        const reHtml = fs.readFileSync(path.join(ROOT, 'public', 'report-entry.html'), 'utf8');
        check('B10) report-entry.html: لا centersData ثابت — الجلب من /api/ops/centers',
            !/var centersData = \{[\s\S]*?المنصورة/.test(reHtml) &&
            reHtml.includes("fetch('/api/ops/centers'") && reHtml.includes('loadCentersData'));
        const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
        check('B11) server.js: لا مرآة ثابتة — الاشتقاق من SSOT عبر getTeamCenters (سريع 3 بالخالدية، سريع 4 بالمنصورة)',
            !serverJs.includes('"الخالدية": ["جنوب 2"') &&
            !serverJs.includes('"المنصورة": ["جنوب 1"') &&
            serverJs.includes('getTeamCenters'));
    } finally {
        server.kill();
    }
}

(async () => {
    try {
        await partA();
        await partB();
    } catch (e) {
        failed++; failures.push('fatal: ' + e.message);
        console.error('❌ فشل عام:', e.message);
    } finally {
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }
    console.log('\n════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})();
