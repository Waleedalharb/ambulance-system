/**
 * ═══ اختبار منظومة إدارة رموز الجداول — symbols-admin-test.js ═══
 * يعمل على نسخة مؤقتة من القاعدة (VACUUM INTO) — لا يمس القاعدة الأصلية.
 * يغطي: البذر من المحللات الفعلية · القفل بطبقتين · ضبط/تغيير الرمز السري ·
 * إضافة رموز بأنواعها الثلاثة · فهم المحللات الفعلي للرموز المخصصة ·
 * التعطيل/التفعيل · الأثر التاريخي · سجل التدقيق · صلاحية 403.
 * التشغيل: node scripts/symbols-admin-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const TMP_DB = path.join(os.tmpdir(), 'symbols-test-' + Date.now() + '.db');
const PORT = 3090;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name + (extra ? ' — ' + extra : '')); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
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

async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
}

(async () => {
    // 1) نسخة مؤقتة سليمة من القاعدة عبر VACUUM INTO (WAL-safe)
    console.log('📋 نسخ القاعدة إلى ملف مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    await src.exec(`VACUUM INTO '${TMP_DB.replace(/'/g, "''")}'`);
    src.close();

    // 2) تشغيل خادم الاختبار
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
        const ready = await waitReady();
        check('خادم الاختبار يعمل', ready);
        if (!ready) throw new Error('Server did not start:\n' + serverLog.slice(-2000));
        // انتظار اكتمال البذر (initDatabase بعد بدء الاستماع)
        await new Promise(r => setTimeout(r, 6000));

        // 3) دخول إداري
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        check('تسجيل دخول admin (4252)', login.status === 200 && login.data && (login.data.token || login.data.accessToken), JSON.stringify(login.data).slice(0, 120));
        const T = login.data.token || login.data.accessToken;

        // 4) صلاحية 403 لدور user (توكن مزوّر بالسر الفعلي)
        const jwt = require(path.join(ROOT, 'node_modules', 'jsonwebtoken'));
        const securityConfig = require(path.join(ROOT, 'config', 'security'));
        const userToken = jwt.sign({ id: 'no-such-user', role: 'user', name: 'اختبار' }, securityConfig.JWT_SECRET);
        const forbidden = await api('/api/schedule-symbols', { token: userToken });
        check('GET /api/schedule-symbols يرفض دور user بـ 403', forbidden.status === 403, 'status=' + forbidden.status);

        // 5) السجل بُذر من المحللات الفعلية
        const list1 = await api('/api/schedule-symbols', { token: T });
        check('جلب السجل ناجح', list1.status === 200 && Array.isArray(list1.data.symbols), 'status=' + list1.status);
        const syms = list1.data.symbols || [];
        console.log('  ℹ️ إجمالي الرموز المبذورة: ' + syms.length);
        check('البذر استخرج 80+ رمزًا من المحللات', syms.length >= 80, 'count=' + syms.length);
        const has = (code, type) => syms.some(s => s.code === code && s.symbol_type === type);
        check('D12 موجود ككود يوم بساعات 12', has('D12', 'day_code') && syms.find(s => s.code === 'D12' && s.symbol_type === 'day_code').hours === 12);
        check('A0 موجود كرمز موظف (قيادة ميدانية)', has('A0', 'employee_symbol'));
        check('XX موجود كرمز موظف (إدارة الإجازات)', has('XX', 'employee_symbol'));
        check('O12-09 موجود ككود تشغيلي ملحق بساعات 12', has('O12-09', 'operational_code'));
        check('RRA1-D-04 موجود ككود تشغيلي صباحي صريح', has('RRA1-D-04', 'operational_code'));
        check('WO موسوم ⚠️ يحتاج مراجعة', syms.some(s => s.code === 'WO' && s.needs_review === 1));
        check('O1515 موسوم ⚠️ يحتاج مراجعة', syms.some(s => s.code === 'O1515' && s.needs_review === 1));
        check('S موسومة ⚠️ يحتاج مراجعة', syms.some(s => s.code === 'S' && s.needs_review === 1));
        check('عائلات الأنماط موجودة (10)', Array.isArray(list1.data.patterns) && list1.data.patterns.length >= 9, 'patterns=' + (list1.data.patterns || []).length);
        check('الرمز السري غير مضبوط مبدئيًا', list1.data.secretConfigured === false);
        const d12Usage = syms.find(s => s.code === 'D12' && s.symbol_type === 'day_code');
        check('عدّ الاستخدام الحي يعمل (D12 > 0)', d12Usage && d12Usage.usage_count > 0, 'usage=' + (d12Usage && d12Usage.usage_count));

        // 6) القفل: فتح قبل الضبط → 409
        const unlockEarly = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'x' } });
        check('فتح القفل قبل ضبط الرمز → 409 SECRET_NOT_SET', unlockEarly.status === 409 && unlockEarly.data.code === 'SECRET_NOT_SET', 'status=' + unlockEarly.status);

        // 7) التعديل مقفل → 423
        const addLocked = await api('/api/schedule-symbols', { method: 'POST', token: T, body: { code: 'TST9', symbol_type: 'day_code' } });
        check('إضافة رمز والقفل مغلق → 423', addLocked.status === 423 && addLocked.data.code === 'SYMBOLS_LOCKED', 'status=' + addLocked.status);

        // 8) الضبط الأول للرمز السري
        const setBad = await api('/api/schedule-symbols/secret', { method: 'POST', token: T, body: { next: 'abc123', confirm: 'xyz' } });
        check('تأكيد غير متطابق → 400', setBad.status === 400);
        const setShort = await api('/api/schedule-symbols/secret', { method: 'POST', token: T, body: { next: '123', confirm: '123' } });
        check('رمز أقصر من 6 → 400', setShort.status === 400);
        const setOk = await api('/api/schedule-symbols/secret', { method: 'POST', token: T, body: { next: 'south2026', confirm: 'south2026' } });
        check('الضبط الأول للرمز السري ناجح', setOk.status === 200 && setOk.data.success);

        // 9) فتح القفل: خاطئ → 401، صحيح → توكن
        const unlockBad = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'wrong' } });
        check('رمز سري خاطئ → 401', unlockBad.status === 401);
        const unlockOk = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'south2026' } });
        check('فتح القفل بالرمز الصحيح', unlockOk.status === 200 && !!unlockOk.data.unlockToken);
        const U = unlockOk.data.unlockToken;

        // 10) إضافة رمز مخصص بأنواعه الثلاثة
        // أ) كود يوم جديد TEST6 (06:00→14:00 = 8 ساعات)
        const addDay = await api('/api/schedule-symbols', {
            method: 'POST', token: T, unlock: U,
            body: { code: 'TEST6', name: 'مناوبة تجريبية 6', symbol_type: 'day_code', group_name: 'morning', shift_side: 'صباحية', time_start: '06:00', time_end: '14:00', is_shift: true, accepts_day_cell: true }
        });
        check('إضافة كود يوم TEST6', addDay.status === 200, JSON.stringify(addDay.data).slice(0, 150));
        // ب) رمز موظف جديد Q1 (لا يطابق أي نمط مدمج)
        const addEmp = await api('/api/schedule-symbols', {
            method: 'POST', token: T, unlock: U,
            body: { code: 'Q1', name: 'فريق تجريبي', symbol_type: 'employee_symbol', group_name: 'admin', team: 'فريق تجريبي', accepts_employee_symbol: true }
        });
        check('إضافة رمز موظف Q1', addEmp.status === 200, JSON.stringify(addEmp.data).slice(0, 150));
        // ج) كود تشغيلي مخصص OPS8 (لا يطابق الأنماط المدمجة) بداية 10:00 مدة 8
        const addOp = await api('/api/schedule-symbols', {
            method: 'POST', token: T, unlock: U,
            body: { code: 'OPS8', name: 'كود تشغيلي تجريبي', symbol_type: 'operational_code', group_name: 'overlap', time_start: '10:00', time_end: '18:00', hours: 8, is_shift: true, accepts_day_cell: true }
        });
        check('إضافة كود تشغيلي OPS8', addOp.status === 200, JSON.stringify(addOp.data).slice(0, 150));
        // د) رفض الازدواج مع المدمج
        const addDup = await api('/api/schedule-symbols', { method: 'POST', token: T, unlock: U, body: { code: 'D12', symbol_type: 'day_code', name: 'نسخة' } });
        check('رفض إضافة D12 (مدمج مسبقًا)', addDup.status === 400);
        const addPattern = await api('/api/schedule-symbols', { method: 'POST', token: T, unlock: U, body: { code: 'O12-16', symbol_type: 'operational_code', name: 'x', time_start: '16:00', time_end: '04:00', hours: 12 } });
        check('رفض O12-16 (يطابق نمطًا مدمجًا)', addPattern.status === 400);

        // 11) صف shift_codes أُنشئ لـ TEST6 (مصدر حساب الساعات)
        const shiftCodes = await api('/api/shift-codes', { token: T });
        const test6Row = (shiftCodes.data.codes || []).find(c => c.code === 'TEST6');
        check('صف shift_codes لـ TEST6 موجود بأوقاته', !!test6Row && test6Row.time_start === '06:00' && test6Row.time_end === '14:00');

        // 12) حمولة التشغيل تحمل الرموز المخصصة
        const runtime = await api('/api/schedule-symbols/runtime', { token: T });
        check('runtime يحمل TEST6 ككود يوم', (runtime.data.dayCodes || []).some(d => d.code === 'TEST6'));
        check('runtime يحمل Q1 كرمز موظف', (runtime.data.employeeSymbols || []).some(s => s.code === 'Q1'));
        check('runtime يحمل OPS8 ككود تشغيلي', (runtime.data.operationalCodes || []).some(o => o.code === 'OPS8'));
        check('runtime يحمل صف shift_codes لـ TEST6', (runtime.data.shiftCodeRows || []).some(r => r.code === 'TEST6'));

        // 13) الفهم الفعلي: تسجيل الحمولة في المحللات الحقيقية (Node)
        const SymD = require(path.join(ROOT, 'public/js/core/symbol-dictionary.js'));
        const StD = require(path.join(ROOT, 'public/js/core/shift-type-dictionary.js'));
        const OpC = require(path.join(ROOT, 'public/js/core/operational-codes.js'));
        check('Q1 مجهول قبل التسجيل', SymD.resolveSymbol('Q1') === null);
        SymD.registerCustom('Q1', { kind: 'admin', team: 'فريق تجريبي' });
        const q1 = SymD.resolveSymbol('Q1');
        check('Q1 مفهوم بعد التسجيل (admin/فريق تجريبي)', q1 && q1.kind === 'admin' && q1.team === 'فريق تجريبي');
        check('القاموس يرفض تجاوز رمز مدمج (A0)', SymD.registerCustom('A0', { kind: 'admin', team: 'عبث' }) === false && SymD.resolveSymbol('A0').team === 'القيادة الميدانية');

        StD.registerCustom('TEST6', 'morning', 'صباحية');
        const cls = StD.classifyDayCode('TEST6');
        check('TEST6 يُصنف صباحًا/دوام بعد التسجيل', cls.group === 'morning' && cls.status === 'دوام' && cls.shift === 'صباحية');
        check('القاموس يرفض تجاوز كود مدمج (D12)', StD.registerCustom('D12', 'vacation') === false && StD.classifyDayCode('D12').group === 'morning');
        check('TEST6 في قائمة الصباحية للخادم', StD.DAY_ONLY_CODES.indexOf('TEST6') !== -1);

        check('OPS8 مجهول للمحلل قبل التسجيل', OpC.parseOperationalCode('OPS8') === null);
        OpC.registerCustom('OPS8', { kind: 'overlap', durationH: 8, start: '10:00' });
        const ops8 = OpC.parseOperationalCode('OPS8');
        check('OPS8 مفهوم بعد التسجيل (8س 10:00→18:00)', ops8 && ops8.durationH === 8 && ops8.start === '10:00' && ops8.end === '18:00');
        check('المحلل يرفض كودًا يطابق نمطًا مدمجًا (O12-16)', OpC.registerCustom('O12-16', { durationH: 5, start: '00:00' }) === false);

        // 14) حساب الساعات المركزي يفهم TEST6 من صف shift_codes (ScheduleMetricsService)
        const ScheduleMetricsService = require(path.join(ROOT, 'services', 'schedule-metrics-service.js'));
        const dbMod = require(path.join(ROOT, 'db.js'));
        // db.js يقرأ DB_PATH من البيئة — لكنه قد يكون مُحمّلًا مسبقًا؛ نبني محولًا مباشرًا
        const testDb = new Database(TMP_DB, { readonly: true });
        const adapter = {
            get: (sql, p) => Promise.resolve(testDb.prepare(sql).get(...(p || []))),
            all: (sql, p) => Promise.resolve(testDb.prepare(sql).all(...(p || [])))
        };
        const metrics = new ScheduleMetricsService({ db: adapter });
        const rows = await adapter.all('SELECT code, name, time_start, time_end FROM shift_codes');
        const map = new Map();
        rows.forEach(r => { map.set(r.code, r); map.set(String(r.code).toUpperCase(), r); });
        check('ScheduleMetricsService: TEST6 = 8 ساعات من صف التعريف', metrics.resolveCodeDurationHours('TEST6', map) === 8);
        void dbMod;

        // 15) الأثر التاريخي: تعديل أوقات D12 (مستخدم تاريخيًا) يتطلب تأكيدًا
        const list2 = await api('/api/schedule-symbols', { token: T });
        const d12 = list2.data.symbols.find(s => s.code === 'D12' && s.symbol_type === 'day_code');
        const editNoConfirm = await api('/api/schedule-symbols/' + d12.id, { method: 'PUT', token: T, unlock: U, body: { time_start: '06:00', time_end: '18:00' } });
        check('تعديل D12 بلا تأكيد → 409 HISTORICAL_IMPACT', editNoConfirm.status === 409 && editNoConfirm.data.code === 'HISTORICAL_IMPACT', 'status=' + editNoConfirm.status);
        const editConfirm = await api('/api/schedule-symbols/' + d12.id, { method: 'PUT', token: T, unlock: U, body: { time_start: '06:00', time_end: '18:00', confirmHistorical: true } });
        check('تعديل D12 مع تأكيد صريح ينجح ويُبلّغ عن الأثر', editConfirm.status === 200 && editConfirm.data.historicalImpact === true);
        const scAfter = await api('/api/shift-codes', { token: T });
        const d12Row = (scAfter.data.codes || []).find(c => c.code === 'D12');
        check('صف shift_codes لـ D12 تزامن مع التعديل', d12Row && d12Row.time_start === '06:00' && d12Row.time_end === '18:00');

        // 16) التعطيل: مدمج مرفوض، مخصص ينجح
        const disableBuiltin = await api('/api/schedule-symbols/' + d12.id + '/status', { method: 'POST', token: T, unlock: U, body: { status: 'disabled' } });
        check('تعطيل رمز مدمج مرفوض', disableBuiltin.status === 400);
        const test6 = list2.data.symbols.find(s => s.code === 'TEST6');
        const disableCustom = await api('/api/schedule-symbols/' + test6.id + '/status', { method: 'POST', token: T, unlock: U, body: { status: 'disabled' } });
        check('تعطيل TEST6 المخصص ينجح', disableCustom.status === 200);
        const runtime2 = await api('/api/schedule-symbols/runtime', { token: T });
        check('المعطّل يختفي من حمولة التشغيل', !(runtime2.data.dayCodes || []).some(d => d.code === 'TEST6'));
        await api('/api/schedule-symbols/' + test6.id + '/status', { method: 'POST', token: T, unlock: U, body: { status: 'active' } });

        // 17) سجل التدقيق
        const audit = await api('/api/schedule-symbols/audit', { token: T });
        const actions = (audit.data.log || []).map(l => l.action);
        check('السجل يوثق secret_set', actions.includes('secret_set'));
        check('السجل يوثق add (3 إضافات)', actions.filter(a => a === 'add').length >= 3);
        check('السجل يوثق edit و disable', actions.includes('edit') && actions.includes('disable'));
        check('السجل يحمل اسم الموظف', (audit.data.log || []).every(l => l.actor_name));

        // 18) تغيير الرمز السري + إبطال الجلسات
        const chgBad = await api('/api/schedule-symbols/secret', { method: 'POST', token: T, body: { current: 'wrong', next: 'newpass1', confirm: 'newpass1' } });
        check('تغيير الرمز بتيار خاطئ → 401', chgBad.status === 401);
        const chgOk = await api('/api/schedule-symbols/secret', { method: 'POST', token: T, body: { current: 'south2026', next: 'newpass1', confirm: 'newpass1' } });
        check('تغيير الرمز السري ينجح', chgOk.status === 200);
        const staleUse = await api('/api/schedule-symbols', { method: 'POST', token: T, unlock: U, body: { code: 'TST10', symbol_type: 'day_code' } });
        check('تغيير الرمز يُبطل جلسات الفتح القديمة → 423', staleUse.status === 423);
        const unlockNew = await api('/api/schedule-symbols/unlock', { method: 'POST', token: T, body: { secret: 'newpass1' } });
        check('فتح القفل بالرمز الجديد', unlockNew.status === 200);
        const audit2 = await api('/api/schedule-symbols/audit', { token: T });
        check('السجل يوثق secret_change', (audit2.data.log || []).some(l => l.action === 'secret_change'));

    } catch (e) {
        failed++;
        failures.push('استثناء: ' + e.message);
        console.error('💥', e.message);
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
