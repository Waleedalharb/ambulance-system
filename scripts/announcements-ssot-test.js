// A-3.3.1: اختبار ترحيل announcements إلى SQLite SSOT — بيئة معزولة بالكامل.
// يغطي البنود المطلوبة: A) GET قبل/بعد B) Add + event C) Delete D) Full
// replacement E) Restart F) Boolean contract G) Idempotency H) JSON مجمّد.
// لا يلمس data/ الحقيقية ولا قاعدة الإنتاج — نسخة VACUUM مؤقتة فقط.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-ssot-'));
const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
const TMP_DATA = path.join(TMP_ROOT, 'data');
const PORT = 3086;
const BASE = `http://localhost:${PORT}`;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

let TOKEN = null;
function api(method, url, body, expectStatus) {
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
                if (expectStatus && res.statusCode !== expectStatus) return reject(new Error(method + ' ' + url + ' status=' + res.statusCode + ' body=' + buf.slice(0, 200)));
                resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// مستمع SSE مبسّط: يجمع أنواع الأحداث القادمة من broadcast
function listenSSE(onEvent) {
    const req = http.get(BASE + '/api/sse?token=' + encodeURIComponent(TOKEN), (res) => {
        let buf = '';
        res.on('data', (chunk) => {
            buf += chunk.toString();
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
                const line = frame.split('\n').find(l => l.startsWith('data:'));
                if (!line) continue;
                try { const msg = JSON.parse(line.slice(5).trim()); onEvent(msg); } catch (e) {}
            }
        });
    });
    req.on('error', () => {});
    return req;
}

function dbRows() {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB, { readonly: true });
    const rows = db.prepare('SELECT id, title, body, date, pinned, urgent, created_at FROM announcements ORDER BY created_at ASC').all();
    db.close();
    return rows;
}
function dbInsert(row) {
    const Database = require('better-sqlite3');
    const db = new Database(TMP_DB);
    db.prepare('INSERT INTO announcements (id, title, body, date, pinned, urgent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, row.title, row.body, row.date, row.pinned, row.urgent, row.created_at);
    db.close();
}

let server = null;
function startServer() {
    return new Promise((resolve, reject) => {
        const env = Object.assign({}, process.env, { PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' });
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

async function main() {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    // تهيئة القاعدة المؤقتة من نسخة الإنتاج المحلية (كما في run-regression-isolated)
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));
    // announcements.json داخل المخزن المؤقت — لإثبات أنه لا يُقرأ ولا يُكتب (Frozen)
    const frozenJson = [{ id: 'frozen-1', title: 'مجمّد', body: 'لا يجب أن يظهر', date: '2020-01-01', pinned: false, urgent: false }];
    fs.writeFileSync(path.join(TMP_DATA, 'announcements.json'), JSON.stringify(frozenJson, null, 2));
    const frozenMtime = fs.statSync(path.join(TMP_DATA, 'announcements.json')).mtimeMs;

    await startServer();
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    if (!login.data || !login.data.accessToken) { console.error('login failed'); process.exit(1); }
    TOKEN = login.data.accessToken;

    // ═══ A) GET قبل/بعد — بيانات مطابقة لمقارنة Render (سجل واحد Both-Same) ═══
    const before = await api('GET', '/api/announcements');
    const beforeCount = (before.data && before.data.data || []).length;
    // محاكاة حالة Render: نفس السجل المتطابق موجود في SQLite
    dbInsert({ id: '1783938528823', title: 'تجريبي', body: 'إعلان', date: '2026-07-13', pinned: 1, urgent: 0, created_at: '2026-07-27 11:28:40' });
    const after = await api('GET', '/api/announcements');
    const rows = after.data.data;
    // القاعدة المؤقتة مأخوذة من نسخة الإنتاج المحلية وفيها صفوف قديمة مهجّرة
    // (ANN-*) — تُبقى كما هي (قاعدة DB-only لا يُحذف). المطلوب: ظهور سجل
    // Render بحقوله الصحيحة + انضمامه للعدد القائم، لا التطابق العددي المطلق.
    check('A: GET من SQLite — سجل Render يظهر بحقوله', rows.some(r => r.id === '1783938528823' && r.title === 'تجريبي'), JSON.stringify(rows.map(r => r.id)));
    check('A: العدد = القديم + 1 (لا فقد ولا استبدال صامت)', rows.length === beforeCount + 1, 'before=' + beforeCount + ' after=' + rows.length);
    check('A: نفس الحقول title/body/date', rows[0].title === 'تجريبي' && rows[0].body === 'إعلان' && rows[0].date === '2026-07-13');
    check('A: JSON المجمّد لا يُقرأ (frozen-1 غائب)', !rows.some(r => r.id === 'frozen-1'));

    // ═══ F) Boolean contract ═══
    check('F: pinned/urgent booleans (true/false لا 1/0)', rows[0].pinned === true && rows[0].urgent === false);

    // ═══ B) Add — يظهر أولًا + event announcement_added ═══
    const sseEvents = [];
    const sse = listenSSE(m => { if (m && m.type) sseEvents.push(m.type); });
    await new Promise(r => setTimeout(r, 700));
    const addRes = await api('POST', '/api/announcements/add', { title: 'اختبار A-3.3.1', body: 'إضافة تجريبية', pinned: false, urgent: true });
    check('B: POST /add نجح وأعاد الكائن', addRes.ok && addRes.data.announcement && addRes.data.announcement.title === 'اختبار A-3.3.1');
    const addedId = addRes.data.announcement.id;
    await new Promise(r => setTimeout(r, 800));
    const afterAdd = await api('GET', '/api/announcements');
    check('B: الإعلان الجديد يظهر أولًا (الأحدث أولًا)', afterAdd.data.data[0] && afterAdd.data.data[0].id === addedId, JSON.stringify(afterAdd.data.data.map(r => r.id)));
    check('B: حدث announcement_added وصل عبر SSE', sseEvents.includes('announcement_added'), sseEvents.join(','));
    check('F: /add يعيد booleans', addRes.data.announcement.urgent === true && addRes.data.announcement.pinned === false);

    // ═══ C) Delete — من SQLite + event ═══
    const delRes = await api('DELETE', '/api/announcements/' + addedId);
    await new Promise(r => setTimeout(r, 500));
    const afterDel = await api('GET', '/api/announcements');
    check('C: DELETE نجح والسجل اختفى من GET', delRes.ok && !afterDel.data.data.some(r => r.id === addedId));
    check('C: السجل حُذف فعليًا من SQLite', !dbRows().some(r => r.id === addedId));
    check('C: حدث announcement_deleted وصل', sseEvents.includes('announcement_deleted'));

    // ═══ D) Full replacement — upsert + حذف الغائب، بترتيب الـ payload ═══
    sseEvents.length = 0;
    const payload = [
        { id: '1783938528823', title: 'تجريبي معدّل', body: 'إعلان', date: '2026-07-13', pinned: true, urgent: false },
        { id: 'd-2', title: 'ثانٍ', body: 'ب', date: '2026-07-14', pinned: false, urgent: true },
        { id: 'd-3', title: 'ثالث', body: 'ج', date: '2026-07-15', pinned: false, urgent: false }
    ];
    const repRes = await api('POST', '/api/announcements', { data: payload });
    const afterRep = await api('GET', '/api/announcements');
    const repIds = afterRep.data.data.map(r => r.id).sort();
    check('D: الاستبدال الكامل — SQLite يعكس الـ payload (3 سجلات)', repRes.ok && repIds.length === 3 && repIds.includes('d-2') && repIds.includes('d-3') && repIds.includes('1783938528823'), repIds.join(','));
    check('D: upsert حدّث السجل القائم (title معدّل)', afterRep.data.data.find(r => r.id === '1783938528823').title === 'تجريبي معدّل');
    check('D: حدث announcements_updated وصل', sseEvents.includes('announcements_updated'), sseEvents.join(','));

    // ═══ G) Idempotency — نفس الـ payload مرتين بلا duplicates ═══
    await api('POST', '/api/announcements', { data: payload });
    const afterRep2 = await api('GET', '/api/announcements');
    check('G: تكرار الاستبدال بلا duplicates', afterRep2.data.data.length === 3, 'count=' + afterRep2.data.data.length);

    // ═══ E) Restart — استمرارية البيانات ═══
    sse.destroy();
    await stopServer();
    await startServer();
    const login2 = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    TOKEN = login2.data.accessToken;
    const afterRestart = await api('GET', '/api/announcements');
    check('E: البيانات تستمر بعد Restart (3 سجلات من SQLite)', afterRestart.data.data.length === 3, 'count=' + afterRestart.data.data.length);

    // ═══ H) JSON مجمّد — لم يُعدَّل طوال الاختبار ═══
    const frozenAfter = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'announcements.json'), 'utf8'));
    const frozenMtimeAfter = fs.statSync(path.join(TMP_DATA, 'announcements.json')).mtimeMs;
    check('H: announcements.json لم يُمسّ (نفس المحتوى ونفس mtime)', JSON.stringify(frozenAfter) === JSON.stringify(frozenJson) && frozenMtimeAfter === frozenMtime);

    await stopServer();
    console.log('\n══════════════════════════════');
    console.log('✅ نجح: ' + passed + ' | ❌ فشل: ' + failed);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH:', e.message); try { server && server.kill(); } catch (_) {} process.exit(1); });
