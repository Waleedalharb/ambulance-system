/**
 * تشغيل الانحدار العام على بيئة معزولة بالكامل:
 *  - نسخة قاعدة بيانات مؤقتة (VACUUM INTO)
 *  - DATA_DIR مؤقت فيه نسخة users.json
 *  - خادم على المنفذ 3080
 * ثم تشغيل scripts/regression-test.js ضده وإنهاء الخادم.
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-iso-'));
const TMP_DB = path.join(TMP, 'regression.db');
const TMP_DATA = path.join(TMP, 'data');
fs.mkdirSync(TMP_DATA, { recursive: true });

console.log('[iso] temp dir:', TMP);

// 1) نسخة قاعدة البيانات عبر VACUUM INTO (نسخة متسقة)
const init = spawn(process.execPath, ['-e', `
const Database = require(${JSON.stringify(path.join(ROOT, 'node_modules', 'better-sqlite3'))});
const db = new Database(${JSON.stringify(path.join(ROOT, 'data', 'ambulance.db'))}, { readonly: true });
db.exec("VACUUM INTO '" + ${JSON.stringify(TMP_DB)}.replace(/'/g, "''") + "'");
db.close();
console.log('vacuum ok');
`], { stdio: 'inherit', env: process.env });
init.on('exit', (code) => {
    if (code !== 0) { console.error('[iso] VACUUM failed'); process.exit(1); }
    // 2) نسخ users.json إلى DATA_DIR المؤقت
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DATA, 'users.json'));

    // 3) تشغيل الخادم معزولًا
    const serverEnv = Object.assign({}, process.env, {
        PORT: '3080',
        DB_PATH: TMP_DB,
        DATA_DIR: TMP_DATA,
        NODE_ENV: 'test'
    });
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = '';
    server.stdout.on('data', d => { serverLog += d; });
    server.stderr.on('data', d => { serverLog += d; });

    const waitReady = (attempt) => {
        http.get('http://localhost:3080/api/health', (res) => {
            if (res.statusCode < 500) return startTests();
            res.resume();
            retry(attempt);
        }).on('error', () => retry(attempt));
    };
    const retry = (attempt) => {
        if (attempt > 60) {
            console.error('[iso] server never became ready. Log:\n' + serverLog.slice(-4000));
            server.kill();
            process.exit(1);
        }
        setTimeout(() => waitReady(attempt + 1), 500);
    };
    waitReady(0);

    function startTests() {
        console.log('[iso] server ready, running regression...');
        // 4) تشغيل عميل الانحدار — يحتاج DB_PATH أيضًا لخطوات تجهيز WF-3
        const clientEnv = Object.assign({}, process.env, {
            BASE_URL: 'http://localhost:3080',
            DB_PATH: TMP_DB,
            DATA_DIR: TMP_DATA,
            NODE_ENV: 'test'
        });
        const client = spawn(process.execPath, [path.join(ROOT, 'scripts', 'regression-test.js')], { env: clientEnv, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        client.stdout.on('data', d => { const s = d.toString(); out += s; process.stdout.write(s); });
        client.stderr.on('data', d => { const s = d.toString(); out += s; process.stderr.write(s); });
        client.on('exit', (c) => {
            console.log('\n[iso] regression client exit code:', c);
            server.kill();
            setTimeout(() => {
                try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
                process.exit(c || 0);
            }, 500);
        });
    }
});
