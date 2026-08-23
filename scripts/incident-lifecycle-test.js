/**
 * ═══ incident-lifecycle-test.js — اختبار قبول دورة حياة البلاغ (قرار المالك 2026-08-22) ═══
 * يثبت على خادم معزول (نسخة مؤقتة من قاعدة البيانات — لا يمس بيانات حقيقية):
 *  S1 بلاغ بأربع فرق: الإجمالي +1 فقط (فريد) وكل فرقة +1 (مشاركات منفصلة)
 *  S2 سحب فرقتين من نفس البلاغ: تُستبعدان من العدّ والتنبيهات والإجمالي ثابت
 *  S3 بلاغ متجاوز للحد ثم closed من CAD: التنبيه يختفي فورًا والسجل يبقى تاريخيًا
 *  S4 cancelled + فرقة مسحوبة قبل التحرك: خارج النشطة والخطورة والتنبيه والعدّ
 *  S5 التسجيل بلا إحداثيات ← إثراء لاحق ← closed: بلاغ واحد بلا ازدواج، الإحداثيات
 *     باقية، والحالة النهائية لاصقة (لا ترتد إلا بـactive صريح) + رفض القيم الغريبة
 * التشغيل: node scripts/incident-lifecycle-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'cad-life-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const TEST_KEY = 'lifekey-' + STAMP;
const AlertRules = require(path.join(ROOT, 'public', 'js', 'alert-rules.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 160) : '')); }
}

async function api(p, { method = 'GET', token, key, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (key) headers['X-Integration-Key'] = key;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

const post = (token, body) => api('/api/cad-reports', { method: 'POST', token, body });
const NOW_MIN = AlertRules.cadMin('11:59:00 PM'); // 1439 — أي بلاغ صباحي متجاوز حتمًا
const alertsFor = (sum, num) => AlertRules.computeAlerts(sum, NOW_MIN).filter(a => a.number === num);
const incOf = (sum, num) => (sum.incidents || []).filter(i => i.number === num);

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار دورة الحياة', active: true, createdAt: new Date().toISOString() }
    ]));
    const probe = new Database(TMP_DB, { readonly: true });
    const active = probe.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    probe.close();
    if (!active) { console.log('❌ لا مناوبة نشطة في النسخة'); process.exit(1); }

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const TK = login.data && login.data.accessToken;
        if (!TK) { console.log('❌ الدخول فشل'); throw new Error('login'); }
        const sum = () => api('/api/cad-reports', { token: TK }).then(r => r.data);

        const s0 = await sum();
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;
        console.log('خط الأساس: total=' + s0.total + ' active=' + s0.activeCount);

        // ── S1: بلاغ واحد بأربع فرق ──
        console.log('\nS1 — بلاغ بأربع فرق (فريد مقابل مشاركات):');
        const r1 = await post(TK, { number: '990090', type: 'medical', crews: [{ team: 'جنوب 1' }, { team: 'جنوب 2' }, { team: 'جنوب 3' }, { team: 'جنوب 4' }] });
        check('S1 التسجيل نجح', r1.status === 200 && r1.data.success === true, JSON.stringify(r1.data).slice(0, 120));
        let s = await sum();
        check('S1 الإجمالي +1 فقط (رقم فريد لا مشاركات)', s.total === s0.total + 1, 'total=' + s.total);
        check('S1 النشطة +1', s.activeCount === s0.activeCount + 1, 'active=' + s.activeCount);
        check('S1 كل فرقة من الأربع +1 في توزيع الفرق',
            ['جنوب 1', 'جنوب 2', 'جنوب 3', 'جنوب 4'].every(u => (s.byCrew[u] || 0) === c0(u) + 1),
            JSON.stringify({ j1: s.byCrew['جنوب 1'], j4: s.byCrew['جنوب 4'] }));
        check('S1 مدخل واحد للبلاغ في الملخص (لا ازدواج)', incOf(s, '990090').length === 1);

        // ── S2: سحب فرقتين من نفس البلاغ ──
        console.log('\nS2 — سحب فرقتين:');
        await post(TK, { number: '990090', crews: [{ team: 'جنوب 3', withdrawn: true }, { team: 'جنوب 4', withdrawn: true }] });
        s = await sum();
        const ic90 = incOf(s, '990090')[0];
        check('S2 الإجمالي ثابت (السحب ليس بلاغًا جديدًا)', s.total === s0.total + 1, 'total=' + s.total);
        check('S2 المسحوبتان خارج العدّ (−1 لكل)', (s.byCrew['جنوب 3'] || 0) === c0('جنوب 3') && (s.byCrew['جنوب 4'] || 0) === c0('جنوب 4'),
            JSON.stringify({ j3: s.byCrew['جنوب 3'], j4: s.byCrew['جنوب 4'] }));
        check('S2 المسحوبتان معلَّمتان withdrawn وغير محتسبتين في السجل',
            !!ic90 && ic90.crews.filter(c => c.withdrawn).length === 2 && ic90.crews.filter(c => c.withdrawn).every(c => c.counted === false),
            JSON.stringify(ic90 && ic90.crews.map(c => ({ u: c.unit, w: c.withdrawn, n: c.counted }))));
        check('S2 الزميلتان تبقيان محتسبتين (+1 لكل)', (s.byCrew['جنوب 1'] || 0) === c0('جنوب 1') + 1 && (s.byCrew['جنوب 2'] || 0) === c0('جنوب 2') + 1);
        check('S2 لا تنبيه من الفرق المسحوبة', alertsFor(s, '990090').length === 0);

        // ── S3: تنبيه حقيقي ثم إغلاق من CAD ──
        console.log('\nS3 — تنبيه متجاوز ثم closed:');
        await post(TK, { number: '990091', createdAt: '22/08/2026 6:00:00 AM', crews: [{ team: 'جنوب 5', phases: { 'قبول': '6:01:00 AM', 'التحرك': '6:02:00 AM' } }] });
        s = await sum();
        const alBefore = alertsFor(s, '990091');
        check('S3 الفرقة المتحركة المتأخرة تنتج تنبيهًا', alBefore.length === 1 && alBefore[0].level === 'over', JSON.stringify(alBefore));
        const r3 = await post(TK, { number: '990091', status: 'closed', crews: [{ team: 'جنوب 5' }] });
        check('S3 تحديث الحالة نجح بلا بلاغ جديد', r3.status === 200 && r3.data.success === true && r3.data.created === false, JSON.stringify(r3.data).slice(0, 120));
        s = await sum();
        const ic91 = incOf(s, '990091')[0];
        check('S3 الحالة closed في الملخص', !!ic91 && ic91.status === 'closed', ic91 && ic91.status);
        check('S3 التنبيه اختفى فور الإغلاق', alertsFor(s, '990091').length === 0);
        check('S3 البلاغ خرج من النشطة (−1)', s.activeCount === s0.activeCount + 1, 'active=' + s.activeCount); // 990090 وحدها نشطة
        check('S3 الخطورة أُبطلت (خارج التشغيل)', ic91 && ic91.severity === null, String(ic91 && ic91.severity));
        check('S3 السجل التاريخي باقٍ: البلاغ في الملخص والإجمالي +2', !!ic91 && s.total === s0.total + 2, 'total=' + s.total);

        // ── S4: ملغى منذ الوصول + فرقة مسحوبة قبل التحرك ──
        console.log('\nS4 — cancelled + مسحوبة بلا تحرك:');
        await post(TK, { number: '990092', status: 'cancelled', crews: [{ team: 'جنوب 6', withdrawn: true, phases: { 'قبول': '7:00:00 AM' } }] });
        s = await sum();
        const ic92 = incOf(s, '990092')[0];
        check('S4 الحالة cancelled منذ الإنشاء', !!ic92 && ic92.status === 'cancelled', ic92 && ic92.status);
        check('S4 خارج النشطة (activeCount لم يتغير)', s.activeCount === s0.activeCount + 1, 'active=' + s.activeCount);
        check('S4 بلا خطورة وبلا تنبيه', ic92 && ic92.severity === null && alertsFor(s, '990092').length === 0);
        check('S4 المسحوبة قبل التحرك لا تُحسب إطلاقًا', (s.byCrew['جنوب 6'] || 0) === c0('جنوب 6'), 'j6=' + s.byCrew['جنوب 6']);
        check('S4 يُحفظ تاريخيًا: الإجمالي +3', s.total === s0.total + 3, 'total=' + s.total);

        // ── S5: تسجيل ← إثراء بالموقع ← إغلاق (الدورة الكاملة) ──
        console.log('\nS5 — الدورة الكاملة: تسجيل بلا موقع ← إثراء ← إغلاق:');
        await post(TK, { number: '990093', crews: [{ team: 'جنوب 7' }] });
        s = await sum();
        check('S5 سُجل بلا إحداثيات بصدق (null)', incOf(s, '990093').length === 1 && incOf(s, '990093')[0].lat === null);
        await post(TK, { number: '990093', lat: 24.63, lng: 46.73, crews: [{ team: 'جنوب 7' }] });
        s = await sum();
        const ic93a = incOf(s, '990093')[0];
        check('S5 الإثراء اللاحق ركّب الموقع على نفس البلاغ (لا بلاغ جديد)',
            incOf(s, '990093').length === 1 && ic93a && ic93a.lat === 24.63 && ic93a.lng === 46.73 && s.total === s0.total + 4,
            JSON.stringify({ lat: ic93a && ic93a.lat, total: s.total }));
        await post(TK, { number: '990093', status: 'closed', crews: [{ team: 'جنوب 7' }] });
        s = await sum();
        const ic93b = incOf(s, '990093')[0];
        check('S5 بعد الإغلاق: الحالة closed والإحداثيات باقية', !!ic93b && ic93b.status === 'closed' && ic93b.lat === 24.63, JSON.stringify({ st: ic93b && ic93b.status, lat: ic93b && ic93b.lat }));
        // حارس اللصق: تحديث بلا status لا يعيده نشطًا
        await post(TK, { number: '990093', crews: [{ team: 'جنوب 7', phases: { 'العلاج': '8:00:00 AM' } }] });
        s = await sum();
        check('S5 الحالة النهائية لاصقة: تحديث بلا status يبقيها closed', incOf(s, '990093')[0].status === 'closed', incOf(s, '990093')[0].status);
        // عودة صريحة فقط
        await post(TK, { number: '990093', status: 'active', crews: [{ team: 'جنوب 7' }] });
        s = await sum();
        check('S5 لا ترتد إلا بـactive صريح من CAD', incOf(s, '990093')[0].status === 'active');

        // ── حارس القيم الغريبة ──
        console.log('\nحارس المدخلات:');
        check('حالة غير معروفة ← 400', (await post(TK, { number: '990094', status: 'exploded', crews: [{ team: 'جنوب 8' }] })).status === 400);
        s = await sum();
        check('الرفض لم ينشئ بلاغًا', incOf(s, '990094').length === 0);

    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ دورة حياة البلاغ: فريد/مشاركات مفصولة + النهائي يخرج فورًا + الإثراء بلا ازدواج');
})();
