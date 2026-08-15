/**
 * ═══ اختبار المسار الحقيقي لرمز جديد — symbols-e2e-test.js ═══
 * البوابة المطلوبة قبل رفع منظومة إدارة الرموز:
 *   إضافة رمز من الإدارة (نفس API الصفحة) → قفل الإدارة → إعادة تحميل
 *   (صفحة متصفح حقيقية بنفس سكربتات smart-schedule) → خلية جدول بالرمز
 *   (نفس مسار كتابة الاستيراد shift_roster) → التحقق أن النظام يفهمه في:
 *   التصنيف الأمامي + قاموس الرموز + حساب الساعات السيرفري → تعطيله →
 *   التحقق أن النظام يتعامل معه كمعطل والمدمج سليم.
 * يعمل على نسخة مؤقتة (VACUUM INTO) — لا يمس القاعدة الأصلية.
 * التشغيل: node scripts/symbols-e2e-test.js
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const TMP_DB = path.join(os.tmpdir(), 'symbols-e2e-' + Date.now() + '.db').replace(/\\/g, '/');
const PORT = 3091;
const BASE = 'http://127.0.0.1:' + PORT;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => fs.existsSync(p));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}

async function api(p, { method = 'GET', token, unlock, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (unlock) headers['x-symbols-unlock'] = unlock;
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

function chromeDump(url, tag) {
    const profile = path.join(os.tmpdir(), 'symbols-e2e-profile-' + tag);
    const out = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--user-data-dir=' + profile,
        '--virtual-time-budget=25000', '--dump-dom', url], { encoding: 'utf8', timeout: 90000 });
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { }
    const m = out.match(/E2E_RESULT:(\[.*\])/);
    return m ? JSON.parse(m[1]) : null;
}

async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

/** قراءة الساعات المجدولة لموظف من مؤشر المساهمة (ScheduleMetricsService الفعلي). */
async function hoursOf(T, empCode) {
    const r = await api('/api/indicators/contribution?year=2026&month=8', { token: T });
    const g = (r.data && r.data.groups) || {};
    const all = [].concat(g.operations || [], g.fieldLeadership || []);
    const emp = all.find(e => String(e.employeeCode) === String(empCode));
    return emp ? Number(emp.scheduledHours ?? 0) : null;
}

(async () => {
    console.log('📋 نسخ القاعدة إلى ملف مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB.replace(/'/g, "''") + "'");
    src.close();

    console.log('🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    server.stdout.on('data', d => serverLog += d);
    server.stderr.on('data', d => serverLog += d);

    try {
        check('خادم الاختبار يعمل', await waitReady());
        await new Promise(r => setTimeout(r, 6000)); // اكتمال البذر

        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const T = login.data && (login.data.token || login.data.accessToken);
        check('دخول admin', !!T);

        // ① إضافة رمز تجريبي من الإدارة (نفس API الذي تستدعيه الصفحة)
        await api('/api/schedule-symbols/secret', { method: 'POST', token: T, body: { next: 'e2e-pass-1', confirm: 'e2e-pass-1' } });
        const un = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'e2e-pass-1' } });
        const U = un.data && un.data.unlockToken;
        check('ضبط الرمز السري وفتح القفل', !!U);

        const addDay = await api('/api/schedule-symbols', {
            method: 'POST', token: T, unlock: U,
            body: { code: 'QZ6', name: 'مناوبة اختبار E2E', symbol_type: 'day_code', group_name: 'morning', shift_side: 'صباحية', time_start: '06:00', time_end: '14:00', is_shift: true, accepts_day_cell: true }
        });
        check('① إضافة QZ6 من الإدارة', addDay.status === 200, JSON.stringify(addDay.data).slice(0, 120));
        const addEmp = await api('/api/schedule-symbols', {
            method: 'POST', token: T, unlock: U,
            body: { code: 'QZ1', name: 'فريق اختبار', symbol_type: 'employee_symbol', group_name: 'admin', team: 'فريق اختبار', accepts_employee_symbol: true }
        });
        check('① إضافة QZ1 من الإدارة', addEmp.status === 200);
        const qz6Id = addDay.data && addDay.data.id;

        // ② قفل الإدارة
        await api('/api/schedule-symbols/lock', { method: 'POST', token: T, unlock: U });
        const lockedTry = await api('/api/schedule-symbols', { method: 'POST', token: T, unlock: U, body: { code: 'ZZ9', symbol_type: 'day_code' } });
        check('② الإدارة مقفلة فعلًا (423)', lockedTry.status === 423);

        // ③ إعادة تحميل حقيقية في متصفح — نفس سكربتات smart-schedule
        console.log('  🌐 تشغيل المتصفح (مسار الواجهة الحقيقي)...');
        const onRes = chromeDump(BASE + '/tmp-symbols-e2e.html?expect=on', 'on');
        check('③ المتصفح أعاد نتائج (إعادة تحميل + loader)', Array.isArray(onRes));
        (onRes || []).filter(x => typeof x.ok === 'boolean').forEach(r => check('   [متصفح] ' + r.n, r.ok, r.extra));

        // ④ خلية جدول تحمل الرمز — نفس مسار كتابة الاستيراد (shift_roster)
        const emps = await api('/api/employees', { token: T });
        const emp = (emps.data.employees || emps.data || []).find(e => String(e.employee_code) === '4252');
        check('وجود موظف الاختبار 4252', !!emp);
        const roster = await api('/api/shift-roster?month=8&year=2026', { token: T });
        const rows = (roster.data.roster || []).filter(r => r.employee_id === emp.id);
        const before = await hoursOf(T, '4252');
        check('قراءة ساعات الأساس من مؤشر المساهمة', before !== null, 'before=' + before);

        // نستبدل خلية بلا ساعات (راحة/فارغة) أو نضيف في يوم فارغ — محاكاة خلية مستوردة
        let delta;
        const freeRow = rows.find(r => ['R', 'WO', 'C', 'EV'].includes(String(r.shift_code).toUpperCase()));
        if (freeRow) {
            const upd = await api('/api/shift-roster/' + freeRow.id, {
                method: 'PUT', token: T,
                body: { shift_code: 'QZ6', shift_date: freeRow.shift_date, month: 8, year: 2026 }
            });
            check('④ كتابة خلية QZ6 في الجدول (مسار الاستيراد)', upd.status === 200, JSON.stringify(upd.data).slice(0, 100));
        } else {
            const usedDates = new Set(rows.map(r => r.shift_date));
            let day = null;
            for (let d = 1; d <= 31; d++) { const ds = '2026-08-' + String(d).padStart(2, '0'); if (!usedDates.has(ds)) { day = ds; break; } }
            const ins = await api('/api/shift-roster', {
                method: 'POST', token: T,
                body: { employee_id: emp.id, shift_date: day, shift_code: 'QZ6', month: 8, year: 2026 }
            });
            check('④ إضافة خلية QZ6 في يوم فارغ ' + day, ins.status === 200, JSON.stringify(ins.data).slice(0, 100));
        }
        const after = await hoursOf(T, '4252');
        delta = Math.round(((after ?? 0) - (before ?? 0)) * 10) / 10;
        check('④ حساب الساعات السيرفري يفهم QZ6: +8 ساعات (' + before + ' → ' + after + ')', delta === 8, 'delta=' + delta);

        // ⑤ تعطيل الرمز ثم إعادة تحميل المتصفح
        const un2 = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'e2e-pass-1' } });
        const dis = await api('/api/schedule-symbols/' + qz6Id + '/status', { method: 'POST', token: T, unlock: un2.data.unlockToken, body: { status: 'disabled' } });
        check('⑤ تعطيل QZ6', dis.status === 200);
        const emp2 = await api('/api/schedule-symbols', { token: T });
        const qz1 = (emp2.data.symbols || []).find(s => s.code === 'QZ1');
        await api('/api/schedule-symbols/' + qz1.id + '/status', { method: 'POST', token: T, unlock: un2.data.unlockToken, body: { status: 'disabled' } });

        console.log('  🌐 تشغيل المتصفح بعد التعطيل...');
        const offRes = chromeDump(BASE + '/tmp-symbols-e2e.html?expect=off', 'off');
        check('⑤ المتصفح أعاد نتائج ما بعد التعطيل', Array.isArray(offRes));
        (offRes || []).filter(x => typeof x.ok === 'boolean').forEach(r => check('   [متصفح] ' + r.n, r.ok, r.extra));

        // ⑥ الأثر التاريخي محفوظ: الساعات المحسوبة قبل التعطيل لا تتغير (بند 10)
        const afterDisable = await hoursOf(T, '4252');
        check('⑥ التعطيل لا يغيّر قراءة الجداول التاريخية (الساعات ثابتة)', afterDisable === after, afterDisable + ' vs ' + after);

    } catch (e) {
        failed++; failures.push('استثناء: ' + e.message);
        console.error('💥', e.message, '\n', serverLog.slice(-1500));
    } finally {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1500));
        try { server.kill('SIGKILL'); } catch (_) { }
        for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) { } }
    }

    console.log('\n════════════════════════════════');
    console.log(`النتيجة: ${passed} ✅ / ${failed} ❌`);
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    process.exit(failed ? 1 : 0);
})();
