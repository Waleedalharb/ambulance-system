// A-3.5: اختبار ترحيل peak-data إلى SQLite SSOT — بيئة معزولة بالكامل.
// يغطي: الزرع من JSON + فحص الأيتام (إيقاف آمن) + GET ordering + عقد
// camelCase + create mission + resolve alert + delete mission (تتالي صريح)
// + الأسقف (100/50/50) + broadcasts + استمرارية Restart + JSON مجمّد +
// عدم الخلط مع peak_plans. لا يلمس data/ الحقيقية — نسخة VACUUM مؤقتة فقط.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('✅ ' + name); }
    else { failed++; failures.push(name); console.log('❌ ' + name + (extra ? ' — ' + extra : '')); }
}

// ─── مرحلة تشغيل واحدة: مجلد مؤقت + خادم على منفذ ───
function makeHarness(tag, port) {
    const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), tag));
    const TMP_DB = path.join(TMP_ROOT, 'ambulance.db');
    const TMP_DATA = path.join(TMP_ROOT, 'data');
    const BASE = `http://localhost:${port}`;
    let TOKEN = null;
    let server = null;

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
                    resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: json });
                });
            });
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

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

    function dbAll(sql, params) {
        const Database = require('better-sqlite3');
        const db = new Database(TMP_DB, { readonly: true });
        const rows = db.prepare(sql).all(...(params || []));
        db.close();
        return rows;
    }
    function dbRun(sql, params) {
        const Database = require('better-sqlite3');
        const db = new Database(TMP_DB);
        db.prepare(sql).run(...(params || []));
        db.close();
    }

    function start() {
        return new Promise((resolve, reject) => {
            const env = Object.assign({}, process.env, { PORT: String(port), DB_PATH: TMP_DB, DATA_DIR: TMP_DATA, NODE_ENV: 'test' });
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
    function stop() {
        return new Promise((resolve) => {
            if (!server) return resolve();
            server.once('exit', () => { server = null; resolve(); });
            server.kill();
            setTimeout(resolve, 5000);
        });
    }
    async function login() {
        const r = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
        if (!r.data || !r.data.accessToken) throw new Error('login failed');
        TOKEN = r.data.accessToken;
    }

    return { TMP_ROOT, TMP_DB, TMP_DATA, BASE, api, listenSSE, dbAll, dbRun, start, stop, login,
        setToken: t => { TOKEN = t; }, getToken: () => TOKEN };
}

function seedBase(h) {
    fs.mkdirSync(h.TMP_DATA, { recursive: true });
    const Database = require('better-sqlite3');
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + h.TMP_DB.replace(/'/g, "''") + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(h.TMP_DATA, 'users.json'));
}

// إسقاط جداول peak القديمة (مخطط db/migrate.js التاريخي الموجود في النسخة
// المحلية) من النسخة المؤقتة — لمحاكاة قاعدة Render النظيفة (لا جداول peak).
function dropLegacyPeakTables(h) {
    const Database = require('better-sqlite3');
    const db = new Database(h.TMP_DB);
    db.exec('DROP TABLE IF EXISTS peak_missions; DROP TABLE IF EXISTS peak_alerts; DROP TABLE IF EXISTS peak_logs;');
    db.close();
}

// ═══ المرحلة 0: إعادة بناء المخطط التاريخي مع حفظ الصفوف ═══
async function phase0() {
    console.log('\n═══ المرحلة 0: مخطط db/migrate.js التاريخي ⇒ إعادة بناء + حفظ البيانات ═══');
    const h = makeHarness('peak-legacy-', 3086);
    seedBase(h);
    // JSON مجمّد ببيانات خادعة — يجب ألا يُزرع فوق بيانات DB القائمة
    const decoy = { missions: [{ id: 'decoy-m', location: 'خادع', unit: 'و', startTime: '0', endTime: '1', createdAt: '2020-01-01T00:00:00.000Z' }], alerts: [], logs: [] };
    fs.writeFileSync(path.join(h.TMP_DATA, 'peak-data.json'), JSON.stringify(decoy, null, 2));
    await h.start();
    await h.login();
    const g = await h.api('GET', '/api/peak-data');
    const d = g.data.data;
    check('LEGACY: الصفوف التاريخية محفوظة (3/3/6)', d.missions.length === 3 && d.alerts.length === 3 && d.logs.length === 6,
        `m=${d.missions.length} a=${d.alerts.length} l=${d.logs.length}`);
    check('LEGACY: المعرفات النصية الأصلية أصبحت id', d.missions.map(m => m.id).join(',') === '1782594068817,1782593111240,1782591247529', d.missions.map(m => m.id).join(','));
    check('LEGACY: الترتيب بالأحدث (created_at)', d.missions[0].createdAt === '2026-06-27T21:01:08.817Z');
    check('LEGACY: حالات التنبيهات محفوظة («منتهي»)', d.alerts.every(a => a.status === 'منتهي'));
    check('LEGACY: mission_id للتنبيهات محفوظ', d.alerts[0].missionId === '1782594068817');
    check('LEGACY: JSON الخادع لم يُزرع (DB القائمة تكسب)', !d.missions.some(m => m.id === 'decoy-m'));
    const pmCols = h.dbAll('PRAGMA table_info(peak_missions)').map(c => c.name);
    check('LEGACY: المخطط أصبح قياسيًا (بلا mission_id في المهمات)', !pmCols.includes('mission_id') && pmCols.includes('id'));
    const idx = h.dbAll("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_peak_alerts_mission'");
    check('LEGACY: فهرس mission_id أُعيد إنشاؤه بعد الحذف', idx.length === 1);
    await h.stop();
}

// بيانات الزرع: JSON بترتيب unshift (الأحدث أولًا): m3 ثم m2 ثم m1
function peakJsonSeed() {
    const mk = (id, day) => ({
        id, location: 'موقع ' + id, lat: 24.7, lng: 46.7, unit: 'وحدة ' + id,
        startTime: '08:00', endTime: '20:00', priority: 'عالية', notes: 'ملاحظة ' + id,
        status: 'نشط', createdAt: `2026-09-0${day}T10:00:00.000Z`
    });
    const m1 = mk('m1', 1), m2 = mk('m2', 2), m3 = mk('m3', 3);
    const ak = (id, mid, day) => ({
        id, title: 'تنبيه ' + id, details: 'تفاصيل ' + id, priority: 'عالية', unit: 'وحدة ' + mid,
        location: 'موقع ' + mid, startTime: '08:00', endTime: '20:00', notes: '', lat: 24.7, lng: 46.7,
        radius: 5000, missionId: mid, status: 'نشط', createdAt: `2026-09-0${day}T11:00:00.000Z`
    });
    const a1 = ak('a1', 'm1', 1), a2 = ak('a2', 'm2', 2), a3 = ak('a3', 'm3', 3);
    const lk = (id, day) => ({ id, icon: '🟡', action: 'إجراء ' + id, details: 'تفاصيل سجل ' + id, priority: 'عادي', time: '10:00:00', date: `2026-09-0${day}T12:00:00.000Z` });
    return { missions: [m3, m2, m1], alerts: [a3, a2, a1], logs: [lk('l2', 2), lk('l1', 1)] };
}

async function phase1() {
    console.log('\n═══ المرحلة 1: الزرع + العقد + الدورة الكاملة + الأسقف + Restart ═══');
    const h = makeHarness('peak-ssot-', 3087);
    seedBase(h);
    dropLegacyPeakTables(h); // محاكاة قاعدة Render النظيفة ⇒ مسار الزرع من JSON
    const seed = peakJsonSeed();
    fs.writeFileSync(path.join(h.TMP_DATA, 'peak-data.json'), JSON.stringify(seed, null, 2));
    const frozenMtime = fs.statSync(path.join(h.TMP_DATA, 'peak-data.json')).mtimeMs;

    await h.start();
    await h.login();

    // ═══ الزرع: counts + ترتيب الأحدث أولًا + العقد ═══
    const g = await h.api('GET', '/api/peak-data');
    const d = g.data && g.data.data;
    check('SEED: GET success وdata موجودة', g.ok && d && Array.isArray(d.missions) && Array.isArray(d.alerts) && Array.isArray(d.logs));
    check('SEED: 3 missions / 3 alerts / 2 logs من JSON', d.missions.length === 3 && d.alerts.length === 3 && d.logs.length === 2,
        `m=${d.missions.length} a=${d.alerts.length} l=${d.logs.length}`);
    check('SEED: ترتيب المهمات الأحدث أولًا (m3,m2,m1)', d.missions.map(m => m.id).join(',') === 'm3,m2,m1', d.missions.map(m => m.id).join(','));
    check('SEED: ترتيب التنبيهات (a3,a2,a1)', d.alerts.map(a => a.id).join(',') === 'a3,a2,a1');
    check('SEED: ترتيب السجلات (l2,l1)', d.logs.map(l => l.id).join(',') === 'l2,l1');
    const m0 = d.missions[0];
    check('CONTRACT: mission بنفس 11 حقلًا camelCase', JSON.stringify(Object.keys(m0).sort()) === JSON.stringify(['createdAt','endTime','id','lat','lng','location','notes','priority','startTime','status','unit'].sort()), Object.keys(m0).join(','));
    check('CONTRACT: startTime/endTime/createdAt محوّلة من snake_case', m0.startTime === '08:00' && m0.endTime === '20:00' && m0.createdAt === '2026-09-03T10:00:00.000Z');
    const a0 = d.alerts[0];
    check('CONTRACT: alert بنفس 15 حقلًا', JSON.stringify(Object.keys(a0).sort()) === JSON.stringify(['createdAt','details','endTime','id','lat','lng','location','missionId','notes','priority','radius','startTime','status','title','unit'].sort()), Object.keys(a0).join(','));
    check('CONTRACT: missionId وradius=5000 محفوظان', a0.missionId === 'm3' && a0.radius === 5000);
    const l0 = d.logs[0];
    check('CONTRACT: log بنفس 7 حقول فقط (بلا createdAt)', JSON.stringify(Object.keys(l0).sort()) === JSON.stringify(['action','date','details','icon','id','priority','time'].sort()), Object.keys(l0).join(','));

    const plansBefore = h.dbAll('SELECT COUNT(*) n FROM peak_plans')[0].n;

    // ═══ إنشاء مهمة: POST + ظهور أولًا + بث ═══
    const sseEvents = [];
    const sse = h.listenSSE(m => { if (m && m.type) sseEvents.push(m.type); });
    await new Promise(r => setTimeout(r, 700));
    const pm = await h.api('POST', '/api/peak-mission', { location: 'موقع جديد', unit: 'جنوب 9', startTime: '06:00', endTime: '18:00', priority: 'متوسطة', notes: 'اختبار', lat: 24.8, lng: 46.8 });
    check('POST mission: success + mission بالعقد', pm.ok && pm.data.mission && pm.data.mission.location === 'موقع جديد' && pm.data.mission.startTime === '06:00' && pm.data.mission.status === 'نشط');
    const newMissionId = pm.data.mission.id;
    await new Promise(r => setTimeout(r, 800));
    const g2 = await h.api('GET', '/api/peak-data');
    check('POST mission: المهمة الجديدة أولًا (4 مهمات)', g2.data.data.missions.length === 4 && g2.data.data.missions[0].id === newMissionId);
    check('POST mission: تنبيه تابع أُنشئ وmissionId صحيح', g2.data.data.alerts.length === 4 && g2.data.data.alerts[0].missionId === newMissionId);
    check('POST mission: سجل «مهمة جديدة» أُضيف', g2.data.data.logs.some(l => l.action === 'مهمة جديدة'));
    check('POST mission: بث peak_mission_added', sseEvents.includes('peak_mission_added'), sseEvents.join(','));
    const newAlertId = g2.data.data.alerts[0].id;

    // ═══ إنهاء تنبيه: status + سجل + بث ═══
    const pr = await h.api('POST', '/api/peak-resolve', { alertId: newAlertId });
    await new Promise(r => setTimeout(r, 500));
    const g3 = await h.api('GET', '/api/peak-data');
    check('RESOLVE: success', pr.ok);
    check('RESOLVE: status أصبح «منتهي»', g3.data.data.alerts.find(a => a.id === newAlertId).status === 'منتهي');
    check('RESOLVE: سجل «تم التنفيذ» أُضيف', g3.data.data.logs.some(l => l.action === 'تم التنفيذ'));
    check('RESOLVE: بث peak_alert_resolved', sseEvents.includes('peak_alert_resolved'));
    const prNo = await h.api('POST', '/api/peak-resolve', { alertId: 'no-such-alert' });
    check('RESOLVE: معرف غير موجود ⇒ success صامت (كما كان)', prNo.ok && prNo.data.success === true);

    // ═══ حذف مهمة: تتالي صريح + سجل + بث + 404 ═══
    const dm = await h.api('DELETE', '/api/peak-mission/m2');
    await new Promise(r => setTimeout(r, 500));
    const g4 = await h.api('GET', '/api/peak-data');
    check('DELETE: success', dm.ok);
    check('DELETE: المهمة m2 حُذفت', !g4.data.data.missions.some(m => m.id === 'm2'));
    check('DELETE: تنبيهها a2 حُذف تتاليًا', !g4.data.data.alerts.some(a => a.id === 'a2'));
    check('DELETE: تنبيهات المهمات الأخرى باقية', g4.data.data.alerts.some(a => a.id === 'a1') && g4.data.data.alerts.some(a => a.id === 'a3'));
    check('DELETE: سجل «مهمة محذوفة» أُضيف', g4.data.data.logs.some(l => l.action === 'مهمة محذوفة'));
    check('DELETE: بث peak_mission_deleted', sseEvents.includes('peak_mission_deleted'));
    const dm404 = await h.api('DELETE', '/api/peak-mission/m2');
    check('DELETE: تكرار الحذف ⇒ 404', dm404.status === 404, 'status=' + dm404.status);

    // ═══ الأسقف: 100 مهمة / 50 تنبيهًا / 50 سجلًا — يُقصّ الأقدم ═══
    // نوصل العدد للسقف بإدراج مباشر بتواريخ أقدم فريدة ومتصاعدة، ثم POST واحد يختبر الثلاثة
    const capTime = i => new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString();
    const missionCount = h.dbAll('SELECT COUNT(*) n FROM peak_missions')[0].n;
    const alertCount = h.dbAll('SELECT COUNT(*) n FROM peak_alerts')[0].n;
    const logCount = h.dbAll('SELECT COUNT(*) n FROM peak_logs')[0].n;
    for (let i = 1; i <= 100 - missionCount; i++) {
        h.dbRun('INSERT INTO peak_missions (id, location, unit, start_time, end_time, priority, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ['cap-m-' + String(i).padStart(3, '0'), 'قص', 'و', '00:00', '01:00', 'عادية', '', 'نشط', capTime(i)]);
    }
    for (let i = 1; i <= 50 - alertCount; i++) {
        h.dbRun('INSERT INTO peak_alerts (id, title, details, priority, unit, location, start_time, end_time, notes, lat, lng, radius, mission_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            ['cap-a-' + String(i).padStart(3, '0'), 'قص', 'ق', 'عادية', 'و', 'م', '00:00', '01:00', '', null, null, 5000, null, 'نشط', capTime(i)]);
    }
    for (let i = 1; i <= 50 - logCount; i++) {
        h.dbRun('INSERT INTO peak_logs (id, icon, action, details, priority, time, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            ['cap-l-' + String(i).padStart(3, '0'), '⚪', 'قص', 'ق', 'عادي', '00:00:00', '2020-01-01T00:00:00.000Z', capTime(i)]);
    }
    const pm2 = await h.api('POST', '/api/peak-mission', { location: 'فوق السقف', unit: 'جنوب 1', startTime: '07:00', endTime: '19:00' });
    const capM = h.dbAll('SELECT COUNT(*) n FROM peak_missions')[0].n;
    const capA = h.dbAll('SELECT COUNT(*) n FROM peak_alerts')[0].n;
    const capL = h.dbAll('SELECT COUNT(*) n FROM peak_logs')[0].n;
    check('CAPS: missions تبقى 100 بعد الإضافة 101', pm2.ok && capM === 100, 'count=' + capM);
    check('CAPS: alerts تبقى 50', capA === 50, 'count=' + capA);
    check('CAPS: logs تبقى 50', capL === 50, 'count=' + capL);
    check('CAPS: الأقدم (cap-m-001) قُصّ والجديد باقٍ', !h.dbAll("SELECT id FROM peak_missions WHERE id='cap-m-001'").length && h.dbAll('SELECT id FROM peak_missions WHERE id=?', [pm2.data.mission.id]).length === 1);

    // ═══ عدم الخلط مع peak_plans ═══
    const plansAfter = h.dbAll('SELECT COUNT(*) n FROM peak_plans')[0].n;
    check('ISOLATION: peak_plans لم يُمسّ طوال العمليات', plansBefore === plansAfter, `before=${plansBefore} after=${plansAfter}`);
    const tables = h.dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'peak_%'").map(t => t.name).sort();
    check('ISOLATION: الجداول الأربعة مستقلة (peak_plans + 3 جديدة)', JSON.stringify(tables) === JSON.stringify(['peak_alerts', 'peak_logs', 'peak_missions', 'peak_plans']), tables.join(','));

    // ═══ Restart: استمرارية البيانات ═══
    sse.destroy();
    await h.stop();
    await h.start();
    await h.login();
    const g5 = await h.api('GET', '/api/peak-data');
    check('RESTART: البيانات تستمر (100/50/50) والجديد أولًا', g5.data.data.missions.length === 100 && g5.data.data.missions[0].id === pm2.data.mission.id);
    check('RESTART: الزرع لم يتكرر (idempotent — لا duplicates من JSON)', !g5.data.data.missions.some(m => m.id === 'm2') && g5.data.data.missions.filter(m => m.id === 'm3').length === 1);

    // ═══ JSON مجمّد ═══
    const frozenAfter = JSON.parse(fs.readFileSync(path.join(h.TMP_DATA, 'peak-data.json'), 'utf8'));
    const frozenMtimeAfter = fs.statSync(path.join(h.TMP_DATA, 'peak-data.json')).mtimeMs;
    check('FROZEN: peak-data.json لم يُمسّ (نفس المحتوى وmtime)', JSON.stringify(frozenAfter) === JSON.stringify(seed) && frozenMtimeAfter === frozenMtime);

    await h.stop();
}

async function phase2() {
    console.log('\n═══ المرحلة 2: تنبيه يتيم ⇒ إيقاف الزرع الآمن ═══');
    const h = makeHarness('peak-orphan-', 3088);
    seedBase(h);
    dropLegacyPeakTables(h); // جداول فارغة حتى يعمل فحص الأيتام عند الزرع
    const orphanData = {
        missions: [{ id: 'om1', location: 'م', lat: null, lng: null, unit: 'و', startTime: '08:00', endTime: '20:00', priority: 'عالية', notes: '', status: 'نشط', createdAt: '2026-09-01T10:00:00.000Z' }],
        alerts: [{ id: 'oa1', title: 'يتيم', details: 'د', priority: 'عالية', unit: 'و', location: 'م', startTime: '08:00', endTime: '20:00', notes: '', lat: null, lng: null, radius: 5000, missionId: 'missing-mission', status: 'نشط', createdAt: '2026-09-01T11:00:00.000Z' }],
        logs: []
    };
    fs.writeFileSync(path.join(h.TMP_DATA, 'peak-data.json'), JSON.stringify(orphanData, null, 2));
    await h.start();
    await h.login();
    const g = await h.api('GET', '/api/peak-data');
    const d = g.data.data;
    check('ORPHAN: الجداول تبقى فارغة تمامًا (لا زرع جزئي)', d.missions.length === 0 && d.alerts.length === 0 && d.logs.length === 0,
        `m=${d.missions.length} a=${d.alerts.length} l=${d.logs.length}`);
    check('ORPHAN: حتى المهمة السليمة لم تُزرع (إيقاف كامل)', h.dbAll('SELECT COUNT(*) n FROM peak_missions')[0].n === 0);
    check('ORPHAN: JSON لم يُعدَّل', JSON.parse(fs.readFileSync(path.join(h.TMP_DATA, 'peak-data.json'), 'utf8')).alerts[0].id === 'oa1');
    await h.stop();
}

async function phase3() {
    console.log('\n═══ المرحلة 3: لا JSON أصلًا ⇒ بنية فارغة صحيحة ═══');
    const h = makeHarness('peak-nojson-', 3089);
    seedBase(h);
    dropLegacyPeakTables(h);
    await h.start();
    await h.login();
    const g = await h.api('GET', '/api/peak-data');
    const d = g.data.data;
    check('NO-JSON: GET يعيد {missions:[],alerts:[],logs:[]}', g.ok && d.missions.length === 0 && d.alerts.length === 0 && d.logs.length === 0);
    check('NO-JSON: الجداول أُنشئت رغم غياب الملف', h.dbAll("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('peak_missions','peak_alerts','peak_logs')").length === 3);
    await h.stop();
}

async function main() {
    await phase0();
    await phase1();
    await phase2();
    await phase3();
    console.log('\n══════════════════════════════');
    console.log('✅ نجح: ' + passed + ' | ❌ فشل: ' + failed);
    if (failures.length) console.log('الفاشلة: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASH:', e.message); process.exit(1); });
