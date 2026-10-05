'use strict';
// ═══════════════════════════════════════════════════════════════════
// A-3.6: Post-Deploy Smoke لبند A-3.5 (peak-data) — READ-ONLY بالكامل.
// ممنوع فيه كل كتابة: لا POST/PUT/PATCH/DELETE على الموارد، لا INSERT/
// UPDATE/DELETE على القاعدة، لا مهمة تجريبية، لا بث تجريبي.
// الاستثناء الوحيد الموثق: المصادقة — وفَّر SMOKE_TOKEN لتجنب أي POST،
// أو SMOKE_USER/SMOKE_PASS (تسجيل دخول كما في كل الـ smokes السابقة).
//
// التشغيل ضد الإنتاج (من أي مكان):
//   set SMOKE_TOKEN=<jwt> && node scripts/peak-production-smoke.js
// التشغيل داخل Render Shell (يضيف فحوص SQLite + الملف المجمّد):
//   DB_PATH=/data/ambulance.db DATA_DIR=/data node scripts/peak-production-smoke.js
// التحقق الذاتي المحلي (قبل النشر — بيئة معزولة بالكامل):
//   node scripts/peak-production-smoke.js --self-test
// ═══════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SELF_TEST = process.argv.includes('--self-test');

// التوقع المعتمد من فحص Render (2026-10-04): 3/3/6، radius=5000، 0 أيتام
const EXPECT = { missions: 3, alerts: 3, logs: 6 };

const results = [];
function report(name, pass, detail) {
    results.push({ name, pass });
    console.log((pass ? '✅ ' : '❌ ') + name + (detail ? ' — ' + detail : ''));
}

let BASE = process.env.BASE_URL || 'https://emsoperations.online';
let TOKEN = process.env.SMOKE_TOKEN || null;
let serverProc = null; // لوضع --self-test فقط

function httpJson(method, url, body) {
    return new Promise((resolve) => {
        const u = new URL(url);
        const lib = u.protocol === 'https:' ? require('https') : http;
        const data = body ? JSON.stringify(body) : null;
        const req = lib.request({
            hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search, method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {})
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) {}
                resolve({ status: res.statusCode, json });
            });
        });
        req.on('error', e => resolve({ status: 0, json: null, error: e.message }));
        req.setTimeout(20000, () => { req.destroy(); resolve({ status: 0, json: null, error: 'timeout' }); });
        if (data) req.write(data);
        req.end();
    });
}

const MISSION_KEYS = ['createdAt', 'endTime', 'id', 'lat', 'lng', 'location', 'notes', 'priority', 'startTime', 'status', 'unit'];
const ALERT_KEYS = ['createdAt', 'details', 'endTime', 'id', 'lat', 'lng', 'location', 'missionId', 'notes', 'priority', 'radius', 'startTime', 'status', 'title', 'unit'];
const LOG_KEYS = ['action', 'date', 'details', 'icon', 'id', 'priority', 'time'];
const keysMatch = (obj, keys) => JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A-3.5 (قرار المالك — Numeric Normalization): lat/lng في JSON التاريخي نصوص،
// وبعد الترحيل إلى REAL يعيدها الـ API أرقامًا. المقارنة الجغرافية رقمية
// بتفاوت صغير: اختلاف String/Number وحده ليس فشلًا، واختلاف القيمة الفعلي فشل.
const GEO_KEYS = ['lat', 'lng'];
const GEO_TOL = 1e-9;
function geoEq(x, y) {
    if (x == null && y == null) return true;
    const nx = Number(x), ny = Number(y);
    if (Number.isNaN(nx) || Number.isNaN(ny)) return false;
    return Math.abs(nx - ny) <= GEO_TOL;
}
function eqRow(b, a) {
    const kb = Object.keys(b);
    if (kb.length !== Object.keys(a).length) return false;
    return kb.every(k => GEO_KEYS.includes(k) ? geoEq(b[k], a[k]) : eq(b[k], a[k]));
}

function compareBackup(backup, api, label) {
    const mOk = backup.missions.length === api.missions.length && backup.missions.every((b, i) => eqRow(b, api.missions[i]));
    const aOk = backup.alerts.length === api.alerts.length && backup.alerts.every((b, i) => eqRow(b, api.alerts[i]));
    const lOk = backup.logs.length === api.logs.length && backup.logs.every((b, i) => eq(b, api.logs[i]));
    report(label + ': missions مطابقة (lat/lng رقميًا ±1e-9) وبالترتيب', mOk, mOk ? backup.missions.length + ' سجلًا' : 'اختلاف!');
    report(label + ': alerts مطابقة (lat/lng رقميًا ±1e-9) وبالترتيب', aOk, aOk ? backup.alerts.length + ' سجلًا' : 'اختلاف!');
    report(label + ': logs مطابقة حقل-بحقل وبالترتيب', lOk, lOk ? backup.logs.length + ' سجلًا' : 'اختلاف!');
}

async function runChecks(dbPath, dataDir) {
    // 1) health
    const h = await httpJson('GET', BASE + '/health');
    report('HEALTH: /health 200 + status=ok', h.status === 200 && h.json && h.json.status === 'ok', 'HTTP ' + h.status);

    // 2) auth
    if (!TOKEN && process.env.SMOKE_USER) {
        const login = await httpJson('POST', BASE + '/api/auth/login', { username: process.env.SMOKE_USER, password: process.env.SMOKE_PASS });
        TOKEN = login.json && (login.json.accessToken || login.json.token);
        report('AUTH: تسجيل دخول (موثق — كما smokes السابقة)', !!TOKEN, TOKEN ? 'token acquired' : 'فشل');
    } else {
        report('AUTH: SMOKE_TOKEN مُوفَّر (صفر كتابات)', !!TOKEN, TOKEN ? 'token via env' : 'لا token — حدد SMOKE_TOKEN أو SMOKE_USER');
    }
    if (!TOKEN) return;

    // 3) peak-data API
    const r = await httpJson('GET', BASE + '/api/peak-data');
    const d = r.json && r.json.data;
    const shapeOk = r.status === 200 && d && Array.isArray(d.missions) && Array.isArray(d.alerts) && Array.isArray(d.logs);
    report('API: GET /api/peak-data 200 + البنية {missions,alerts,logs}', shapeOk, 'HTTP ' + r.status);
    if (!shapeOk) return;

    // 4) counts
    report('COUNTS: 3 missions / 3 alerts / 6 logs (توقع فحص Render المعتمد)',
        d.missions.length === EXPECT.missions && d.alerts.length === EXPECT.alerts && d.logs.length === EXPECT.logs,
        `m=${d.missions.length} a=${d.alerts.length} l=${d.logs.length}`);

    // 5) contract camelCase
    report('CONTRACT: missions بنفس 11 حقلًا camelCase', d.missions.every(m => keysMatch(m, MISSION_KEYS)));
    report('CONTRACT: alerts بنفس 15 حقلًا', d.alerts.every(a => keysMatch(a, ALERT_KEYS)));
    report('CONTRACT: logs بنفس 7 حقول (بلا createdAt)', d.logs.every(l => keysMatch(l, LOG_KEYS)));

    // 6) ordering — createdAt تنازليًا
    const desc = arr => arr.every((x, i) => i === 0 || String(arr[i - 1].createdAt || arr[i - 1].date) >= String(x.createdAt || x.date));
    report('ORDERING: missions/alerts/logs كلها الأحدث أولًا', desc(d.missions) && desc(d.alerts) && desc(d.logs));

    // 7) statuses
    const stOk = arr => arr.every(x => ['نشط', 'منتهي'].includes(x.status));
    report('STATUSES: قيم ضمن {نشط، منتهي}', stOk(d.missions) && stOk(d.alerts));

    // 8) radius
    report('RADIUS: كل التنبيهات 5000', d.alerts.every(a => a.radius === 5000));

    // 9) orphan alerts
    const mIds = new Set(d.missions.map(m => String(m.id)));
    const orphans = d.alerts.filter(a => a.missionId != null && !mIds.has(String(a.missionId)));
    report('ORPHANS: صفر تنبيهات يتيمة', orphans.length === 0, orphans.length ? orphans.map(o => o.id).join(',') : 'لا أيتام');

    // 10) مقارنة مع Frozen Backup (إن وُفر)
    const backupPath = process.env.PEAK_FROZEN_BACKUP || path.join(ROOT, 'test-output', 'peak-frozen-backup.json');
    if (fs.existsSync(backupPath)) {
        try {
            const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
            compareBackup(backup, d, 'BACKUP↔API');
        } catch (e) {
            report('BACKUP↔API', false, 'فشل قراءة النسخة: ' + e.message);
        }
    } else {
        console.log('ℹ️  لا نسخة مجمّدة للمقارنة (' + backupPath + ') — وفّر PEAK_FROZEN_BACKUP لمقارنة حقل-بحقل');
    }

    // 11-13) فحوص المحلية (Render Shell أو self-test)
    if (dbPath && fs.existsSync(dbPath)) {
        try {
            const Database = require('better-sqlite3');
            const db = new Database(dbPath, { readonly: true, fileMustExist: true });
            const c = {
                m: db.prepare('SELECT COUNT(*) n FROM peak_missions').get().n,
                a: db.prepare('SELECT COUNT(*) n FROM peak_alerts').get().n,
                l: db.prepare('SELECT COUNT(*) n FROM peak_logs').get().n
            };
            report('SQLITE: counts = 3/3/6', c.m === EXPECT.missions && c.a === EXPECT.alerts && c.l === EXPECT.logs, `m=${c.m} a=${c.a} l=${c.l}`);
            const dbOrphans = db.prepare(`SELECT COUNT(*) n FROM peak_alerts WHERE mission_id IS NOT NULL AND mission_id NOT IN (SELECT id FROM peak_missions)`).get().n;
            report('SQLITE: صفر أيتام على مستوى القاعدة', dbOrphans === 0);
            const pp = db.prepare('SELECT COUNT(*) n FROM peak_plans').get().n;
            const ppExpect = process.env.PEAK_PLANS_EXPECT;
            report('SQLITE: peak_plans غير متأثر', ppExpect ? pp === Number(ppExpect) : true,
                'count=' + pp + (ppExpect ? ' (متوقع ' + ppExpect + ')' : ' — وفّر PEAK_PLANS_EXPECT للمطابقة الصارمة'));
            db.close();
        } catch (e) {
            report('SQLITE', false, e.message);
        }
    } else {
        console.log('ℹ️  لا DB_PATH محلي — فحوص SQLite تتطلب Render Shell (DB_PATH=/data/ambulance.db)');
    }
    const frozenFile = dataDir && path.join(dataDir, 'peak-data.json');
    if (frozenFile && fs.existsSync(frozenFile)) {
        try {
            const frozen = JSON.parse(fs.readFileSync(frozenFile, 'utf8'));
            report('FROZEN: peak-data.json سليم ويقرأ (لم يُحذف/يُتلف)', Array.isArray(frozen.missions) && Array.isArray(frozen.alerts) && Array.isArray(frozen.logs),
                `m=${frozen.missions.length} a=${frozen.alerts.length} l=${frozen.logs.length}`);
            compareBackup(frozen, d, 'FROZEN↔API');
        } catch (e) {
            report('FROZEN', false, e.message);
        }
    } else {
        console.log('ℹ️  ملف peak-data.json غير متاح محليًا — يُفحص داخل Render Shell (DATA_DIR=/data)');
    }

    // 14) أخطاء الإقلاع/الهجرة — آليًا على السجلات المحلية إن وجدت، وإلا يدويًا
    let scanned = false, foundErr = false;
    try {
        const logsDir = path.join(ROOT, 'logs');
        if (fs.existsSync(logsDir)) {
            for (const f of fs.readdirSync(logsDir).filter(x => x.endsWith('.log'))) {
                const tail = fs.readFileSync(path.join(logsDir, f), 'utf8').slice(-200000);
                if (/peak-data migration ABORTED|Failed to migrate peak-data/.test(tail)) { foundErr = true; break; }
                scanned = true;
            }
        }
    } catch (e) {}
    report('STARTUP: لا أخطاء هجرة peak-data', !foundErr,
        foundErr ? 'وُجدت أخطاء!' : (scanned ? 'فُحصت السجلات المحلية' : 'تحقق يدويًا من Render Dashboard logs بعد النشر'));
}

async function selfTest() {
    // بيئة معزولة: نسخة VACUUM + peak-data.json طُعم + خادم محلي مؤقت
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'peak-smoke-selftest-'));
    const TMP_DB = path.join(TMP, 'ambulance.db');
    const TMP_DATA = path.join(TMP, 'data');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const srcDb = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    srcDb.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    srcDb.close();
    // إسقاط جداول peak التاريخية لمحاكاة Render النظيفة ⇒ زرع من JSON
    const wdb = new Database(TMP_DB);
    wdb.exec('DROP TABLE IF EXISTS peak_missions; DROP TABLE IF EXISTS peak_alerts; DROP TABLE IF EXISTS peak_logs;');
    wdb.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));
    // lat/lng كنصوص — محاكاة حرفية لبيانات الإنتاج التاريخية (قرار Numeric Normalization)
    const mk = (id, day) => ({ id, location: 'موقع ' + id, lat: '24.6929571930255', lng: '46.70108388960175', unit: 'وحدة ' + id, startTime: '08:00', endTime: '20:00', priority: 'عالية', notes: '', status: 'نشط', createdAt: `2026-09-0${day}T10:00:00.000Z` });
    const ak = (id, mid, day) => ({ id, title: 'تنبيه ' + id, details: 'د ' + id, priority: 'عالية', unit: 'وحدة ' + mid, location: 'موقع ' + mid, startTime: '08:00', endTime: '20:00', notes: '', lat: '24.6929571930255', lng: '46.70108388960175', radius: 5000, missionId: mid, status: 'نشط', createdAt: `2026-09-0${day}T11:00:00.000Z` });
    const lk = (id, day) => ({ id, icon: '🟡', action: 'إجراء ' + id, details: 'س ' + id, priority: 'عادي', time: '10:00:00', date: `2026-09-0${day}T12:00:00.000Z` });
    const seed = {
        missions: [mk('m1', 3), mk('m2', 2), mk('m3', 1)],
        alerts: [ak('a1', 'm1', 3), ak('a2', 'm2', 2), ak('a3', 'm3', 1)],
        logs: [lk('l1', 3), lk('l2', 2), lk('l3', 1), lk('l4', 3), lk('l5', 2), lk('l6', 1)]
    };
    // logs بترتيب createdAt تنازلي صحيح: نرتبهم بحيث يكون l1/l4 (day3) أولًا
    seed.logs.sort((x, y) => (y.date > x.date ? 1 : -1));
    fs.writeFileSync(path.join(TMP_DATA, 'peak-data.json'), JSON.stringify(seed, null, 2));
    const PORT = 3096;
    BASE = 'http://localhost:' + PORT;
    process.env.PEAK_FROZEN_BACKUP = path.join(TMP_DATA, 'peak-data.json');
    console.log('── SELF-TEST: إقلاع خادم معزول على :' + PORT + ' ──');
    serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' }),
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        const h = await httpJson('GET', BASE + '/health');
        if (h.status === 200) up = true; else await new Promise(r => setTimeout(r, 500));
    }
    if (!up) { console.error('فشل إقلاع خادم الاختبار الذاتي'); process.exit(1); }
    process.env.SMOKE_USER = '4252';
    process.env.SMOKE_PASS = '4252';
    await runChecks(TMP_DB, TMP_DATA);
}

(async () => {
    console.log('═══ PEAK PRODUCTION SMOKE (READ-ONLY) — ' + new Date().toISOString() + ' ═══');
    console.log('BASE: ' + (SELF_TEST ? '(self-test معزول)' : BASE) + '\n');
    if (SELF_TEST) await selfTest();
    else await runChecks(process.env.DB_PATH, process.env.DATA_DIR);
    const failed = results.filter(r => !r.pass);
    console.log('\n═══════════════════════════════════');
    console.log(failed.length ? `❌ SMOKE: FAIL — ${failed.length} فشل: ` + failed.map(f => f.name).join(' | ') : `✅ SMOKE: PASS — ${results.length} فحصًا`);
    if (serverProc) { try { serverProc.kill(); } catch (_) {} }
    process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('⚠️ انهيار:', e.message); if (serverProc) { try { serverProc.kill(); } catch (_) {} } process.exit(1); });
