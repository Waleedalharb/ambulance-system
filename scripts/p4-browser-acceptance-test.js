/**
 * P4 — قبول نهائي للواجهة والحالات الحدية والتنافس.
 * متصفح Chrome حقيقي + SQLite اصطناعي داخل test-output فقط.
 * لا توليد/اعتماد/نشر، ولا كتابة في roster/schedule_months أو حسابات الإنتاج.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output', 'p4-browser-' + Date.now());
const TMP_DB = path.join(OUT, 'ambulance.db');
const TMP_DATA = path.join(OUT, 'data');
const CHROME_PROFILE = path.join(OUT, 'chrome-profile');
const PORT = 3117, BASE = 'http://127.0.0.1:' + PORT;
process.env.DB_PATH = TMP_DB;
process.env.DATA_DIR = TMP_DATA;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'p4-browser-isolated-secret';
let passed = 0, failed = 0, server = null, chrome = null, cdp = null, raw;
const failures = [], browserErrors = [];
function check(name, condition, extra) {
    if (condition) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
function must(name, condition, extra) { check(name, condition, extra); if (!condition) throw new Error(name + (extra ? ' — ' + extra : '')); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function hashRows(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
async function api(p, { method = 'GET', token, body } = {}) {
    const headers = { 'Content-Type': 'application/json' }; if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await response.json(); } catch (_) {}
    return { status: response.status, data };
}
async function waitHttp(url, tries = 120) {
    for (let i = 0; i < tries; i++) { try { if ((await fetch(url)).ok) return true; } catch (_) {} await sleep(150); }
    return false;
}
async function stopChild(child) {
    if (!child || child.killed || child.exitCode !== null) return;
    await new Promise(resolve => { const timer = setTimeout(resolve, 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
}
function freePort() {
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
    });
}
class Cdp {
    constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.listeners = new Map(); }
    async open() {
        this.ws = new WebSocket(this.url);
        this.ws.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id); this.pending.delete(message.id);
                if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result || {});
            } else if (message.method && this.listeners.has(message.method)) {
                this.listeners.get(message.method).forEach(fn => fn(message.params || {}));
            }
        });
        await new Promise((resolve, reject) => { this.ws.addEventListener('open', resolve, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    }
    on(method, fn) { if (!this.listeners.has(method)) this.listeners.set(method, []); this.listeners.get(method).push(fn); }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
    }
    async eval(expression) {
        const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result ? result.result.value : undefined;
    }
    close() { try { this.ws.close(); } catch (_) {} }
}
async function waitBrowser(expression, timeout = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeout) { if (await cdp.eval(`Boolean(${expression})`)) return true; await sleep(150); }
    return false;
}
async function screenshot(name) {
    const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(result.data, 'base64'));
}
function chromePath() {
    const candidates = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) throw new Error('لم يُعثر على Chrome/Edge لاختبار الواجهة');
    return found;
}

(async () => {
    fs.mkdirSync(TMP_DATA, { recursive: true });
    const db = require('../db.js');
    const { ContinuityService, daysOfMonth } = require('../services/schedule-engine/continuity-service.js');
    await db.init(false);
    const teams = await db.all('SELECT * FROM teams ORDER BY id'); const team = teams[0];
    await db.run('UPDATE teams SET is_active = 0 WHERE id <> ?', [team.id]);
    const cycle = ['D12', 'D12', 'N12', 'N12', 'WO', 'WO', 'WO', 'WO'];
    await db.run("UPDATE shift_patterns SET cycle_json = ?, is_active = 1 WHERE code = 'A'", [JSON.stringify(cycle)]);
    const users = [
        { id: 'p4-admin', role: 'admin', name: 'أدمن P4' },
        { id: 'p4-viewer', role: 'director', name: 'قارئ P4' },
        { id: 'p4-settings', role: 'director', name: 'إعدادات P4' }
    ];
    const grants = { 'p4-viewer': ['schedule.view'], 'p4-settings': ['schedule.view', 'schedule.settings.manage'] };
    for (const user of users) {
        await db.run('INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, 1)', [user.id, user.id, 'not-used', user.name, user.role]);
        for (const key of grants[user.id] || []) await db.run('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, ?)', [user.id, key, 'مجس P4 اصطناعي فقط']);
    }
    fs.writeFileSync(path.join(TMP_DATA, 'users.json'), JSON.stringify(users.map(user => ({ id: user.id, username: user.id, password: 'not-used', name: user.name, role: user.role, isActive: true })), null, 2));
    for (let i = 0; i < 4; i++) {
        const id = (await db.run("INSERT INTO employees (employee_code, name, pattern_code) VALUES (?, ?, 'A')", [`P4-E${i + 1}`, `موظف P4 ${i + 1}`])).id;
        await db.run('INSERT INTO team_assignments (employee_id, team_id, assigned_date, is_primary) VALUES (?, ?, ?, 1)', [id, team.id, '2026-01-01']);
        for (const [index, date] of daysOfMonth('2026-02').entries()) await db.run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, 2, 2026)', [id, team.id, date, cycle[(i + index) % cycle.length]]);
    }
    await db.AppSettings.set('schedule_engine.coverage_default', { day: 90, night: 90, total: 999 });
    await db.AppSettings.set('schedule_engine.coverage_team_overrides', {});
    const continuity = new ContinuityService(db), actor = { id: 'p4-admin', role: 'admin', name: 'أدمن P4' };
    let reference = await continuity.importRoster({ month: '2026-02', sourceNote: 'مرجع P4 اصطناعي', user: actor });
    await continuity.openDraft(reference.id, actor); reference = await continuity.derive(reference.id, actor);
    reference = await continuity.approve(reference.id, reference.content_hash, actor);
    must('مرجع الواجهة الاصطناعي معتمد', reference.status === 'approved');
    await db.closeDb();

    raw = new (require('better-sqlite3'))(TMP_DB);
    const baseline = {
        roster: hashRows(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()),
        months: hashRows(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()),
        employees: hashRows(raw.prepare('SELECT * FROM employees ORDER BY id').all()),
        users: hashRows(raw.prepare('SELECT * FROM users ORDER BY rowid').all()),
        permissions: hashRows(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all())
    };
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverLog = ''; server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
    must('خادم P4 المعزول يعمل', await waitHttp(BASE + '/health'), serverLog.slice(-2000));
    const jwt = require('jsonwebtoken');
    const tokens = Object.fromEntries(users.map(user => [user.id, jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET)]));

    console.log('\n🧭 المدخلات الحدية والرفض قبل الكتابة:');
    let response = await api('/api/schedule/workspace?month=2026-13', { token: tokens['p4-viewer'] });
    check('الشهر غير الصالح 422 INVALID_MONTH', response.status === 422 && response.data.code === 'INVALID_MONTH');
    response = await api('/api/schedule/version-comparison?base_id=&target_id=', { token: tokens['p4-viewer'] });
    check('المقارنة الناقصة 422 دون استنتاج', response.status === 422 && response.data.code === 'COMPARISON_VERSIONS_REQUIRED');
    response = await api('/api/schedule/versions/not-a-version/employee/not-a-number', { token: tokens['p4-viewer'] });
    check('معرّف الموظف غير الرقمي 422', response.status === 422 && response.data.code === 'INVALID_EMPLOYEE');
    const runsBefore = raw.prepare('SELECT COUNT(*) AS n FROM schedule_generation_runs').get().n;
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens['p4-viewer'], body: { target_month: '2026-03' } });
    check('director مرفوض قبل إنشاء تشغيل', response.status === 403 && raw.prepare('SELECT COUNT(*) AS n FROM schedule_generation_runs').get().n === runsBefore);
    response = await api('/api/schedule/generation-runs', { method: 'POST', token: tokens['p4-admin'], body: { target_month: '2026-13' } });
    check('شهر التوليد غير الصالح مرفوض بلا كتابة', response.status === 422 && raw.prepare('SELECT COUNT(*) AS n FROM schedule_generation_runs').get().n === runsBefore);

    console.log('\n🖥️ متصفح حقيقي: الحالة الفارغة وunresolved والتنقل:');
    const debugPort = await freePort();
    chrome = spawn(chromePath(), [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${CHROME_PROFILE}`, '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' });
    must('منفذ تصحيح المتصفح يعمل', await waitHttp(`http://127.0.0.1:${debugPort}/json/version`));
    const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    cdp = new Cdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl); await cdp.open();
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    cdp.on('Runtime.exceptionThrown', event => browserErrors.push(event.exceptionDetails && event.exceptionDetails.text || 'Runtime exception'));
    async function setToken(token) {
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('auth_access_token', ${JSON.stringify(token)}); localStorage.setItem('authToken', ${JSON.stringify(token)}); localStorage.removeItem('auth_refresh_token');` });
    }
    await setToken(tokens['p4-admin']);
    await cdp.send('Page.navigate', { url: BASE + '/schedule-workspace.html' });
    must('الواجهة اكتمل تحميلها', await waitBrowser(`document.readyState === 'complete' && document.getElementById('currentUser').textContent.includes('أدمن P4')`));
    must('الحالة الفارغة ظاهرة بصدق', await waitBrowser(`document.getElementById('metricStatus').textContent.includes('لا توجد مسودة')`));
    check('زر التوليد ظاهر للأدمن فقط', await cdp.eval(`!document.getElementById('generateDraft').classList.contains('hidden')`));
    await cdp.eval(`(() => { const input = document.getElementById('targetMonth'); input.value = '2026-03'; input.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    must('المرجع المعتمد ظاهر بعد اختيار الشهر', await waitBrowser(`document.getElementById('metricReference').textContent.includes('الإصدار') && !document.getElementById('globalMessage').classList.contains('hidden') === false`));
    check('عداد الفرق غير المحسومة = 1', await cdp.eval(`document.getElementById('metricUnresolved').textContent.trim() === '1'`));
    const tabNames = ['imports', 'reference', 'versions', 'review', 'employees', 'exceptions', 'coverage', 'audit', 'overview'];
    for (const name of tabNames) {
        const ok = await cdp.eval(`(() => { document.getElementById('tab-${name}').click(); const panel = document.getElementById('panel-${name}'); return !panel.hidden && panel.classList.contains('active') && document.getElementById('tab-${name}').getAttribute('aria-selected') === 'true'; })()`);
        check(`التبويب ${name} يفتح لوحته الصحيحة`, ok === true);
    }
    must('قسم الاستيراد الذكي يتصل بمساره دون خطأ', await waitBrowser(`document.getElementById('smartImportMessage').classList.contains('hidden') && !document.getElementById('smartImportBatches').textContent.includes('فشل')`));
    check('قائمة دفعات الاستيراد تعرض حالة صادقة', await cdp.eval(`document.getElementById('smartImportBatches').textContent.includes('لا توجد دفعات') || document.querySelectorAll('#smartImportBatches .import-batch').length > 0`));
    await cdp.eval(`document.getElementById('tab-coverage').click()`);
    const coverageUi = await cdp.eval(`(() => { const matrix = document.getElementById('coverageMatrix'); const select = matrix.querySelector('.coverage-applicability'); return { applicability: select && select.value, label: select && select.selectedOptions[0].textContent, text: matrix.textContent, dayDisabled: matrix.querySelector('.coverage-day').disabled, nightDisabled: matrix.querySelector('.coverage-night').disabled }; })()`);
    check('حالة unresolved ظاهرة في مصفوفة التغطية', coverageUi.applicability === 'unresolved' && coverageUi.label === 'غير محسوم' && coverageUi.text.includes('لا يوجد إثبات صالح') && coverageUi.dayDisabled && coverageUi.nightDisabled, JSON.stringify(coverageUi));
    check('القيم التقنية 90/90/999 لا تظهر كقيمة معتمدة', await cdp.eval(`![...document.querySelectorAll('.coverage-day,.coverage-night')].some(input => input.value === '90') && !document.getElementById('coverageMatrix').textContent.includes('999')`));
    await cdp.eval(`document.getElementById('tab-overview').click()`);
    await screenshot('desktop-unresolved.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    check('لا تمرير أفقي على عرض الجوال', await cdp.eval(`document.documentElement.scrollWidth <= window.innerWidth + 1`), await cdp.eval(`document.documentElement.scrollWidth + '/' + window.innerWidth`));
    await screenshot('mobile-unresolved.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    await setToken(tokens['p4-viewer']);
    await cdp.send('Page.navigate', { url: BASE + '/schedule-workspace.html' });
    must('واجهة القارئ اكتملت', await waitBrowser(`document.getElementById('currentUser').textContent.includes('قارئ P4')`));
    check('زر التوليد مخفي للقارئ director', await cdp.eval(`document.getElementById('generateDraft').classList.contains('hidden')`));
    check('حقول إدارة التغطية معطلة للقارئ', await cdp.eval(`document.getElementById('coverageSource').disabled && document.getElementById('coverageForm').querySelector('button[type="submit"]').classList.contains('hidden')`));
    check('لا استثناءات JavaScript في المتصفح', browserErrors.length === 0, browserErrors.join(' | '));
    await cdp.close(); cdp = null; await stopChild(chrome); chrome = null;

    console.log('\n⚡ تنافس حفظ مصفوفة التغطية على نفس البصمتين:');
    const current = await api('/api/schedule/coverage-approvals?month=2026-03', { token: tokens['p4-viewer'] });
    const payload = {
        rows: [{ team_id: team.id, applicability: 'required', day: 1, night: 1 }],
        source: 'سند سباق اصطناعي P4', approval_authority: 'جهة اختبار P4', approved_by: 'معتمد اختبار P4',
        approved_at: '2026-02-20T00:00:00Z', effective_from: '2020-01-01', effective_to: null, official_confirmation: true,
        expected_default_hash: current.data.coverage_default_hash, expected_overrides_hash: current.data.coverage_overrides_hash
    };
    const proofsBefore = raw.prepare('SELECT COUNT(*) AS n FROM schedule_coverage_approvals').get().n;
    const auditBefore = raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_coverage_matrix_recorded'").get().n;
    const race = await Promise.all([
        api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p4-settings'], body: payload }),
        api('/api/schedule/coverage-approvals', { method: 'PUT', token: tokens['p4-settings'], body: payload })
    ]);
    check('طلب واحد ينجح والآخر STALE_COVERAGE_SETTINGS', race.filter(row => row.status === 200).length === 1 && race.filter(row => row.status === 409 && row.data.code === 'STALE_COVERAGE_SETTINGS').length === 1, JSON.stringify(race.map(row => ({ status: row.status, code: row.data.code }))));
    check('التنافس أنتج إثباتًا واحدًا وتدقيقًا واحدًا', raw.prepare('SELECT COUNT(*) AS n FROM schedule_coverage_approvals').get().n === proofsBefore + 1 && raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_coverage_matrix_recorded'").get().n === auditBefore + 1);

    console.log('\n🧊 ثبات البيانات الرسمية والحسابات:');
    check('shift_roster ثابت', hashRows(raw.prepare('SELECT * FROM shift_roster ORDER BY id').all()) === baseline.roster);
    check('schedule_months ثابت', hashRows(raw.prepare('SELECT * FROM schedule_months ORDER BY month').all()) === baseline.months);
    check('employees ثابت', hashRows(raw.prepare('SELECT * FROM employees ORDER BY id').all()) === baseline.employees);
    check('users والأدوار ثابتة', hashRows(raw.prepare('SELECT * FROM users ORDER BY rowid').all()) === baseline.users);
    check('user_permissions ثابت', hashRows(raw.prepare('SELECT * FROM user_permissions ORDER BY id').all()) === baseline.permissions);

    const summary = { passed, failed, failures, browserErrors, screenshots: ['desktop-unresolved.png', 'mobile-unresolved.png'], scope: 'synthetic isolated browser acceptance; no generation/approval/publication', finishedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(`\n════════════════════════════════\nالنتيجة: ${passed} ✅ / ${failed} ❌\nالأدلة: ${OUT}`);
    if (failures.length) failures.forEach(name => console.log('  ❌ ' + name));
    await stopChild(server); server = null; raw.close(); raw = null;
    process.exit(failed ? 1 : 0);
})().catch(async error => {
    console.error('فشل عام:', error && (error.stack || error.message));
    try { if (cdp) cdp.close(); } catch (_) {}
    await stopChild(chrome); await stopChild(server); if (raw) raw.close();
    process.exit(1);
});
