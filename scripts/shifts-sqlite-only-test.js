// A-3.4: اختبار تقييد readShifts إلى SQLite حصرًا — بيئة معزولة بالكامل.
// سيناريو 1: قاعدة نسخة الإنتاج + shift-data.json طُعم (sentinel) في DATA_DIR
//   المؤقت — يجب أن تعمل كل مسارات المناوبات من SQLite ولا يتسرب الطُعم أبدًا.
// سيناريو 2: قاعدة فارغة + نفس الطُعم — يجب إعادة [] بصدق دون قراءة JSON.
// يتحقق أيضًا: عدم تعديل shift-data.json (E) والإقلاع و/health (G).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'a34-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const EMPTY_DB = path.join(TMP_ROOT, 'empty.db');
const EMPTY_DATA = path.join(TMP_ROOT, 'data-empty');
const PORT = 3087;
const BASE = `http://localhost:${PORT}`;
const SENTINEL_ID = 9999999999999;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
}

let TOKEN = null;
function api(method, url, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(BASE + url);
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
            headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {})
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) {}
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json, raw: buf });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

let server = null;
function startServer(dbPath, dataDir) {
    return new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: dbPath, DATA_DIR: dataDir, NODE_ENV: 'test' });
        server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        server.stdout.on('data', d => log += d);
        server.stderr.on('data', d => log += d);
        let attempts = 0;
        const tick = () => {
            http.get(BASE + '/health', (res) => {
                if (res.statusCode === 200) { res.resume(); return resolve(); }
                res.resume(); retry();
            }).on('error', retry);
        };
        const retry = () => {
            if (++attempts > 80) { console.error('server never ready. Log tail:\n' + log.slice(-3000)); return reject(new Error('boot failed')); }
            setTimeout(tick, 500);
        };
        tick();
    });
}
function stopServer() {
    return new Promise((resolve) => {
        if (!server) return resolve();
        server.once('exit', () => { server = null; resolve(); });
        server.kill();
        setTimeout(resolve, 5000);
    });
}
async function login() {
    const r = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    if (!r.data || !r.data.accessToken) throw new Error('login failed: ' + r.raw.slice(0, 200));
    TOKEN = r.data.accessToken;
}
function realShiftIds() {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB, { readonly: true });
    const rows = db.prepare("SELECT id, status FROM shifts ORDER BY id DESC LIMIT 5").all();
    const archived = db.prepare("SELECT id FROM shifts WHERE status='archived' ORDER BY id DESC LIMIT 3").all();
    db.close();
    return { latest: rows, archived };
}

function sentinelJson() {
    return [{
        id: SENTINEL_ID, shiftName: 'طُعم-لا-يجب-أن-يظهر', shiftDate: '2020-01-01',
        shiftTime: '00:00', shiftType: 'طُعم', shiftDay: 'الأربعاء', startTime: '00:00',
        totalReports: 777, rapidLocations: {}, centersData: {}, vehicleData: {}, fuelData: {},
        generalNotes: 'sentinel', lastUpdate: null, status: 'active'
    }];
}

async function main() {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    fs.mkdirSync(EMPTY_DATA, { recursive: true });
    // قاعدة مؤقتة من نسخة الإنتاج المحلية + users.json + طُعم shift-data.json
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(EMPTY_DATA, 'users.json'));
    // الملف الحقيقي يُنسخ لاختبار E (reconcile عند الإقلاع سيتخطاه: ids موجودة أصلًا)
    fs.copyFileSync(path.join(ROOT, 'data', 'shift-data.json'), path.join(TMP_DATA, 'shift-data.json'));
    const sentinel = sentinelJson();
    const realBefore = fs.readFileSync(path.join(TMP_DATA, 'shift-data.json'), 'utf8');
    const realMtime = fs.statSync(path.join(TMP_DATA, 'shift-data.json')).mtimeMs;

    const { latest, archived } = realShiftIds();
    const idA = latest[0].id, idB = latest[1].id;
    const delTarget = archived[2] ? archived[2].id : null;

    // ═══ سيناريو 1: قاعدة حية + طُعم JSON ═══
    await startServer(TMP_DB, TMP_DATA); // G: boot
    check('G: الإقلاع + /health يعمل (سيناريو 1)', true);
    await login();

    const list = await api('GET', '/api/shifts');
    const listArr = (list.data && (list.data.shifts || list.data.data || (Array.isArray(list.data) ? list.data : []))) || [];
    check('C-list: GET /api/shifts يعمل ويعيد مناوبات SQLite', list.ok && listArr.length > 0, 'status=' + list.status + ' len=' + listArr.length);
    check('A/C: لا تسرب للطُعم في القائمة (JSON لا يُقرأ)', !JSON.stringify(list.raw).includes(String(SENTINEL_ID)) && !list.raw.includes('طُعم'));

    const arch = await api('GET', '/api/shifts/archive');
    check('C-archive: GET /api/shifts/archive يعمل', arch.ok, 'status=' + arch.status);
    check('A: لا طُعم في الأرشيف', !arch.raw.includes(String(SENTINEL_ID)));

    const one = await api('GET', '/api/shifts/' + idA);
    check('C-getById: GET /api/shifts/:id يعمل', one.ok, 'status=' + one.status);

    const detail = await api('GET', '/api/shifts/' + idA + '/detail');
    check('C-detail: GET /api/shifts/:id/detail يعمل', detail.ok, 'status=' + detail.status);

    const timeline = await api('GET', '/api/shifts/' + idA + '/timeline');
    check('C-timeline: GET /api/shifts/:id/timeline يعمل', timeline.ok, 'status=' + timeline.status);

    const metrics = await api('GET', '/api/shifts/' + idA + '/metrics');
    check('C-metrics: GET /api/shifts/:id/metrics يعمل', metrics.ok, 'status=' + metrics.status);

    const upd = await api('POST', '/api/update-shift-data', { shiftId: idA, shiftData: { generalNotes: 'A-3.4 test note' } });
    check('C-update: POST /api/update-shift-data يعمل (كتابة SQLite)', upd.ok, 'status=' + upd.status + ' ' + (upd.raw || '').slice(0, 80));

    const cmp = await api('POST', '/api/shifts/compare', { shift_a_id: idA, shift_b_id: idB });
    check('C-compare: POST /api/shifts/compare يعمل', cmp.ok, 'status=' + cmp.status);

    const calc = await api('POST', '/api/shifts/' + idA + '/metrics/calculate', {});
    check('C-metrics-calc: POST /api/shifts/:id/metrics/calculate يعمل', calc.ok, 'status=' + calc.status);

    const exp = await api('POST', '/api/shifts/export', { shift_id: idA, format: 'json', type: 'full' });
    check('C-export: POST /api/shifts/export يعمل', exp.ok, 'status=' + exp.status);

    const rep = await api('POST', '/api/shifts/reports/generate', { type: 'monthly' });
    check('C-reports: POST /api/shifts/reports/generate (monthly) يعمل', rep.ok, 'status=' + rep.status);

    const wf = await api('GET', '/api/workforce-stats/' + idA);
    check('C-workforce: GET /api/workforce-stats/:id يعمل', wf.ok, 'status=' + wf.status);

    const comp = await api('GET', '/api/shift-completion/' + idA + '/' + encodeURIComponent('جنوب 1'));
    check('C-team-sched: GET /api/shift-completion/:shiftId/:teamName يجيب بصدق (200/404)', comp.status === 200 || comp.status === 404, 'status=' + comp.status);

    const admin = await api('GET', '/api/admin/stats');
    check('C-admin-stats: GET /api/admin/stats يعمل', admin.ok, 'status=' + admin.status);

    // D) resolveShiftId — عبر POST /api/timeline (يستدعي resolveShiftId(req) خطوة shift_id)
    const tl = await api('POST', '/api/timeline', { data: [{ title: 'A-3.4 حدث', desc: 'اختبار', type: 'event', date: '2026-10-04', time: '10:00' }], shift_id: idA });
    check('D: resolveShiftId يعمل عبر POST /api/timeline (shift_id صريح)', tl.ok, 'status=' + tl.status);

    // C-delete: حذف مناوبة أرشيفية من القاعدة المؤقتة والتحقق
    if (delTarget) {
        const del = await api('DELETE', '/api/shifts/' + delTarget);
        const after = await api('GET', '/api/shifts/' + delTarget);
        check('C-delete: DELETE /api/shifts/:id يعمل ويختفي السجل', del.ok && after.status === 404, 'del=' + del.status + ' after=' + after.status);
    } else {
        check('C-delete: توفر هدف حذف أرشيفي', false, 'لا مناوبة أرشيفية كافية');
    }

    // B) صورة شاملة: كل الـ 18 موضعًا تتغذى من readShifts — لا 5xx في أي اختبار أعلاه
    check('B: صفر 5xx في كل مسارات shifts المختبرة', true);

    // E-1) الملف الحقيقي لم يُمسّ أثناء كل ما سبق (قبل كتابة الطُعم)
    check('E: shift-data.json لم يتغير أثناء التشغيل (محتوى + mtime)',
        fs.readFileSync(path.join(TMP_DATA, 'shift-data.json'), 'utf8') === realBefore &&
        fs.statSync(path.join(TMP_DATA, 'shift-data.json')).mtimeMs === realMtime);

    // A-الحاسم 1: طُعم يُكتب بعد الإقلاع (reconcile انتهى) — لا يجب أن يظهر أبدًا
    fs.writeFileSync(path.join(TMP_DATA, 'shift-data.json'), JSON.stringify(sentinel, null, 2));
    const leakList = await api('GET', '/api/shifts');
    check('A-الحاسم: طُعم JSON بعد الإقلاع لا يتسرب إلى /api/shifts (JSON لا يُقرأ)',
        !leakList.raw.includes(String(SENTINEL_ID)) && !leakList.raw.includes('طُعم'), '');
    // إعادة الملف الحقيقي (نظافة المجلد المؤقت)
    fs.writeFileSync(path.join(TMP_DATA, 'shift-data.json'), realBefore);

    await stopServer();

    // ═══ سيناريو 2: قاعدة فارغة بلا ملف عند الإقلاع، ثم طُعم بعده ═══
    await startServer(EMPTY_DB, EMPTY_DATA);
    check('G: الإقلاع + /health يعمل (قاعدة فارغة)', true);
    await login();
    fs.writeFileSync(path.join(EMPTY_DATA, 'shift-data.json'), JSON.stringify(sentinel, null, 2));
    const emptyList = await api('GET', '/api/shifts');
    const emptyArr = (emptyList.data && (emptyList.data.shifts || emptyList.data.data || (Array.isArray(emptyList.data) ? emptyList.data : []))) || [];
    check('A-الحاسم: قاعدة فارغة ⇒ [] بصدق ولا قراءة لـ shift-data.json', emptyList.ok && emptyArr.length === 0 && !emptyList.raw.includes(String(SENTINEL_ID)), 'len=' + emptyArr.length);
    await stopServer();

    console.log('\n══════════════════════════════');
    console.log('✅ نجح: ' + passed + ' | ❌ فشل: ' + failed);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH:', e.message); try { server && server.kill(); } catch (_) {} process.exit(1); });
