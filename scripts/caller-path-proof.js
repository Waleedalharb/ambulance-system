/* إثبات مسار رقم المبلّغ سيرفريًا (Duplicate 2.0 — خطوة ما قبل الكود):
   POST /api/cad-reports → تعقيم server.js → createIncidentEntries →
   createIncident / updateIncidentCallerInfo → incident_registry.caller_number
   يعمل على نسخة مؤقتة من القاعدة (DB_PATH) وبورت معزول — لا يلمس بيانات التشغيل. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), 'caller-proof.db');
const PORT = 3081;
const BASE = `http://127.0.0.1:${PORT}`;

function copyDb() {
    for (const suffix of ['', '-wal', '-shm']) {
        const src = path.join(ROOT, 'data', 'ambulance.db' + suffix);
        const dst = TMP_DB + suffix;
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
}

async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (e) {}
        await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('الخادم لم يجهز');
}

async function api(method, url, body, token) {
    const r = await fetch(BASE + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null; try { data = await r.json(); } catch (e) {}
    return { status: r.status, data };
}

function readCaller(number) {
    // قراءة مباشرة من نسخة القاعدة المؤقتة عبر better-sqlite3 المشروع
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(TMP_DB, { readonly: true });
    const row = db.prepare('SELECT number, caller_number, description FROM incident_registry WHERE number = ?').get(number);
    db.close();
    return row || null;
}

(async () => {
    console.log('═══ إثبات مسار رقم المبلّغ (معزول) ═══');
    copyDb();
    const shiftRow = (() => {
        const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
        const db = new Database(TMP_DB, { readonly: true });
        const r = db.prepare('SELECT id FROM shifts ORDER BY id DESC LIMIT 1').get();
        db.close();
        return r;
    })();
    if (!shiftRow) { console.log('❌ لا توجد مناوبة في النسخة'); process.exit(1); }
    console.log('مناوبة مستخدمة للاختبار: id=' + shiftRow.id);

    const srv = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB }, stdio: 'ignore'
    });
    try {
        await waitReady();
        const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
        if (!login.data || !login.data.accessToken) { console.log('❌ فشل تسجيل الدخول'); process.exit(1); }
        const T = login.data.accessToken;

        // 1) بلاغ بلا رقم مبلّغ → يجب أن يُنشأ وcaller_number = NULL
        const n1 = '99000001';
        const r1 = await api('POST', '/api/cad-reports', {
            number: n1, crews: [], shift_id: shiftRow.id, source: 'cad-auto',
            createdAt: '28/08/2026 10:00:00 PM', lat: 24.6, lng: 46.7
        }, T);
        const db1 = readCaller(n1);
        console.log('\n1) إنشاء بلا مبلّغ:', r1.status, r1.data && r1.data.success ? 'success' : JSON.stringify(r1.data));
        console.log('   DB:', JSON.stringify(db1));

        // 2) نفس البلاغ + وصول الرقم متأخرًا → updateIncidentCallerInfo يجب أن يستكمله
        const r2 = await api('POST', '/api/cad-reports', {
            number: n1, crews: [], shift_id: shiftRow.id, source: 'cad-auto',
            callerNumber: '+966 55 123 4567', description: 'وصف اختبار متأخر'
        }, T);
        const db2 = readCaller(n1);
        console.log('\n2) استكمال متأخر (updateIncidentCallerInfo):', r2.status, r2.data && r2.data.success ? 'success' : JSON.stringify(r2.data));
        console.log('   DB:', JSON.stringify(db2));

        // 3) بلاغ جديد مع الرقم منذ الإنشاء + تعقيم الصيغة (أحرف/مسافات تُزال)
        const n3 = '99000002';
        const r3 = await api('POST', '/api/cad-reports', {
            number: n3, crews: [], shift_id: shiftRow.id, source: 'cad-manual',
            callerNumber: '05-12-345-678', description: 'اختبار التعقيم'
        }, T);
        const db3 = readCaller(n3);
        console.log('\n3) إنشاء مع مبلّغ + تعقيم:', r3.status, r3.data && r3.data.success ? 'success' : JSON.stringify(r3.data));
        console.log('   DB:', JSON.stringify(db3));

        // 4) محاولة استبدال الرقم الموجود برقم مختلف → يجب ألا يُستبدل (استكمال فقط)
        const r4 = await api('POST', '/api/cad-reports', {
            number: n3, crews: [], shift_id: shiftRow.id, source: 'cad-auto', callerNumber: '0509999999'
        }, T);
        const db4 = readCaller(n3);
        console.log('\n4) محاولة استبدال رقم قائم:', r4.status, r4.data && r4.data.success ? 'success' : JSON.stringify(r4.data));
        console.log('   DB (يجب أن يبقى الرقم الأول):', JSON.stringify(db4));

        const pass =
            db1 && db1.caller_number === null &&
            db2 && db2.caller_number === '+966551234567' && db2.description === 'وصف اختبار متأخر' &&
            db3 && db3.caller_number === '0512345678' &&
            db4 && db4.caller_number === '0512345678';
        console.log('\n' + (pass ? '✅ المسار السيرفري كامل وسليم: إنشاء + استكمال + تعقيم + عدم استبدال' : '❌ خلل في المسار السيرفري'));
        process.exitCode = pass ? 0 : 1;
    } finally {
        srv.kill();
    }
})().catch(e => { console.error('خطأ:', e.message); process.exit(1); });
