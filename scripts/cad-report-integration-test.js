/**
 * ═══ اختبار محرك توزيع البلاغات برقم البلاغ — cad-report-integration-test.js ═══
 * (قرار المالك 2026-08-20): CAD مدخل بيانات؛ محرك التوزيع هو العقل الإحصائي.
 * يثبت على خادم معزول (VACUUM INTO + DATA_DIR مؤقت) القواعد الخمس:
 *  ① الإجمالي = أرقام البلاغات الفريدة (3 فرق على بلاغ = بلاغ واحد)
 *  ② كل فرقة مشاركة = بلاغ واحد في عدّادها
 *  ③ نفس الفرقة + نفس الرقم = مشاركة واحدة فقط (لا تضاعف)
 *  ④ النوع يُصنف مرة واحدة لكل رقم ولا يتكرر بتعدد الفرق
 *  ⑤ مدخل CAD يكتب في reports/report_times/incident_registry — لا مخزن موازٍ
 * السيناريوهات الستة المطلوبة: فرقة واحدة / فرقتان / ثلاث / تكرار نفس الفرقة /
 * بلاغان لنفس الفرقة / أنواع مختلفة + تعايش اليدوي والتراجع + حماية المفتاح.
 * التشغيل: node scripts/cad-report-integration-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'cadeng-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'cadeng-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3099;
const BASE = 'http://127.0.0.1:' + PORT;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); }
}
async function api(p, { method = 'GET', token, key, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (key) headers['X-Integration-Key'] = key;
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
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    const TEST_KEY = 'testkey-' + STAMP;
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار', active: true, createdAt: new Date().toISOString() },
        { key: 'revoked-' + STAMP, scope: 'cad-reports', label: 'ملغى', active: false, createdAt: new Date().toISOString() }
    ]));
    // قياس وجود مناوبة نشطة في النسخة (مطلوبة للمسار اليدوي وCAD معًا)
    const probe = new Database(TMP_DB, { readonly: true });
    const active = probe.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    probe.close();
    console.log('  ℹ️ المناوبة النشطة في النسخة: ' + (active ? '#' + active.id : 'لا توجد — سيناريوهات الكتابة ستُقفل'));

    console.log('🚀 تشغيل خادم الاختبار على المنفذ ' + PORT + '...');
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    if (!(await waitReady())) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const login = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        if (!login.data || !login.data.accessToken) throw new Error('login failed');
        const TK = login.data.accessToken;
        const sum = () => api('/api/cad-reports', { token: TK });

        // خط الأساس: النسخة قد تحوي بلاغات CAD من تجارب حية سابقة — كل التوقعات فروقات عنه
        const s0 = (await sum()).data;
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;
        const t0 = ty => (s0.byType && s0.byType[ty]) || 0;
        const d0 = dd => (s0.byDistrict && s0.byDistrict[dd]) || 0;
        const baseDb = new Database(TMP_DB, { readonly: true });
        const reg0 = baseDb.prepare('SELECT COUNT(*) c FROM incident_registry').get().c;
        const linked0 = baseDb.prepare('SELECT COUNT(*) c FROM report_times WHERE incident_number IS NOT NULL').get().c;
        baseDb.close();
        console.log('  ℹ️ خط الأساس: total=' + s0.total + ' · registry=' + reg0 + ' · مربوطة=' + linked0);

        // ── حماية المدخل ──
        console.log('\n🛡️ الحماية:');
        check('POST بلا توكن ولا مفتاح ← 401', (await api('/api/cad-reports', { method: 'POST', body: { number: '1401001', crews: [{ team: 'جنوب 8' }] } })).status === 401);
        check('GET بلا توكن ← 401', (await api('/api/cad-reports')).status === 401);
        check('مفتاح خاطئ ← 401', (await api('/api/cad-reports', { method: 'POST', key: 'wrong', body: { number: '1401001', crews: [{ team: 'جنوب 8' }] } })).status === 401);
        check('مفتاح ملغى ← 401', (await api('/api/cad-reports', { method: 'POST', key: 'revoked-' + STAMP, body: { number: '1401001', crews: [{ team: 'جنوب 8' }] } })).status === 401);
        check('المفتاح على GET ← 401 (POST فقط)', (await api('/api/cad-reports', { key: TEST_KEY })).status === 401);
        check('المفتاح على /api/report ← 401 (لا صلاحية خارج نطاقه)', (await api('/api/report', { method: 'POST', key: TEST_KEY, body: { center: 'الشفاء', unit: 'جنوب 8' } })).status === 401);
        check('رقم غير صالح ← 400', (await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '12ab56', crews: [{ team: 'جنوب 8' }] } })).status === 400);
        check('نوع غير معروف ← 400', (await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401099', type: 'alien', crews: [{ team: 'جنوب 8' }] } })).status === 400);
        check('crews فارغة ← 400', (await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401099', crews: [] } })).status === 400);
        check('وقت إنشاء غير صالح ← 400', (await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401099', createdAt: 'بكرة الظهر', crews: [{ team: 'جنوب 8' }] } })).status === 400);

        if (!active) { console.log('⚠️ لا مناوبة نشطة — تُخطى سيناريوهات الكتابة'); }

        // ── ① بلاغ واحد بفرقة واحدة (عبر مفتاح التكامل — بلا Session Token) ──
        console.log('\n① بلاغ بفرقة واحدة (مفتاح التكامل):');
        const r1 = await api('/api/cad-reports', {
            method: 'POST', key: TEST_KEY,
            body: { number: '1401001', code: '29B05U', type: 'traffic', crews: [{ team: 'جنوب 8', phases: { 'قبول': '7:11:33 AM', 'التحرك': '7:11:38 AM', 'الاستجابة': '7:12:11 AM' } }] }
        });
        check('① created=true عبر المفتاح', r1.status === 200 && r1.data.created === true, 'status=' + r1.status + ' ' + JSON.stringify(r1.data));
        let s = (await sum()).data;
        check('① الإجمالي=+1 وbyType.traffic=+1 (فروقات عن خط الأساس)', s.total === s0.total + 1 && s.byType.traffic === t0('traffic') + 1, JSON.stringify({ t: s.total, bt: s.byType }));
        check('① عدّاد جنوب 8 = +1', (s.byCrew['جنوب 8'] || 0) === c0('جنوب 8') + 1);
        const ic1 = s.incidents.find(i => i.number === '1401001');
        check('① الأزمنة الخام محفوظة مع الفرقة', !!ic1 && ic1.crews[0].phases['الاستجابة'] === '7:12:11 AM', JSON.stringify(ic1 && ic1.crews[0].phases));

        // ── ② بلاغ بفرقتين ──
        console.log('\n② بلاغ بفرقتين:');
        const r2 = await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401002', type: 'injury', crews: [{ team: 'جنوب 4' }, { team: 'جنوب 5' }] } });
        s = (await sum()).data;
        check('② الإجمالي +1 فقط (وليس +2)', r2.data.created === true && s.total === s0.total + 2, 'total=' + s.total);
        check('② byType.injury=+1 مرة واحدة رغم فرقتين', s.byType.injury === t0('injury') + 1);
        check('② جنوب 4 = +1 وجنوب 5 = +1', (s.byCrew['جنوب 4'] || 0) === c0('جنوب 4') + 1 && (s.byCrew['جنوب 5'] || 0) === c0('جنوب 5') + 1);

        // ── ③ بلاغ بثلاث فرق ──
        console.log('\n③ بلاغ بثلاث فرق:');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401003', type: 'medical', crews: [{ team: 'جنوب 1' }, { team: 'سريع 1' }, { team: 'جنوب 8' }] } });
        s = (await sum()).data;
        check('③ الإجمالي +1 فقط (وليس +3)', s.total === s0.total + 3, 'total=' + s.total);
        check('③ byType.medical=+1', s.byType.medical === t0('medical') + 1);

        // ── ⑤ بلاغان مختلفان لنفس الفرقة ──
        check('⑤ جنوب 8 = +2 (بلاغان مختلفان = مشاركتان)', (s.byCrew['جنوب 8'] || 0) === c0('جنوب 8') + 2, 'byCrew=' + s.byCrew['جنوب 8']);

        // ── ④ نفس الفرقة تُضاف مرتين لنفس البلاغ ──
        console.log('\n④ منع تضاعف الفرقة:');
        const r4 = await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401001', crews: [{ team: 'جنوب 8' }] } });
        check('④ created=false وskippedCrews=[جنوب 8]', r4.data.created === false && (r4.data.skippedCrews || []).includes('جنوب 8') && r4.data.addedCrews.length === 0, JSON.stringify(r4.data));
        s = (await sum()).data;
        check('④ الإجمالي لم يتغير وعدّاد جنوب 8 لم يتضاعف', s.total === s0.total + 3 && (s.byCrew['جنوب 8'] || 0) === c0('جنوب 8') + 2, JSON.stringify({ t: s.total, c: s.byCrew['جنوب 8'] }));
        // فرقة جديدة تُلحق بنفس البلاغ دون إنشاء بلاغ جديد
        const r4b = await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401001', crews: [{ team: 'جنوب 2' }] } });
        s = (await sum()).data;
        check('④ إلحاق فرقة جديدة: created=false والإجمالي ثابت وعدّاد جنوب 2 = +1', r4b.data.created === false && s.total === s0.total + 3 && (s.byCrew['جنوب 2'] || 0) === c0('جنوب 2') + 1);

        // ── ⑥ أنواع مختلفة ──
        console.log('\n⑥ نوع مختلف:');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401004', type: 'fire', crews: [{ team: 'سريع 2' }] } });
        s = (await sum()).data;
        check('⑥ byType.fire=+1 والإجمالي +4', s.byType.fire === t0('fire') + 1 && s.total === s0.total + 4, JSON.stringify({ f: s.byType.fire, t: s.total }));

        // ── تعايش المدخل اليدوي القائم (لا يتغير سلوكه) ──
        console.log('\n🖐️ اليدوي والتراجع:');
        if (active) {
            await api('/api/report', { method: 'POST', token: TK, body: { center: 'الشفاء', unit: 'جنوب 3' } });
            s = (await sum()).data;
            check('الضغطة اليدوية = بلاغ مستقل (+1 إجمالي و+1 يدوي)', s.total === s0.total + 5 && s.manualCount === (s0.manualCount || 0) + 1, JSON.stringify({ t: s.total, m: s.manualCount }));
            check('عدّاد جنوب 3 = +1', (s.byCrew['جنوب 3'] || 0) === c0('جنوب 3') + 1);
            await api('/api/undo', { method: 'POST', token: TK, body: { center: 'الشفاء', unit: 'جنوب 3' } });
            s = (await sum()).data;
            check('التراجع اليدوي يزيل الأثر', s.total === s0.total + 4 && (s.byCrew['جنوب 3'] || 0) === c0('جنوب 3'), 'total=' + s.total);
        }

        // ── ⑦ عدالة الفرق: أُسندت وأُلغيت قبل التحرك ← لا تُحسب، والتبديل ينتقل للمتحركة ──
        console.log('\n⑦ إلغاء قبل التحرك ← تبديل:');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401005', type: 'medical', crews: [{ team: 'جنوب 6', phases: { 'قبول': '8:00:00 AM' } }] } });
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401005', crews: [{ team: 'جنوب 7', phases: { 'قبول': '8:01:00 AM', 'التحرك': '8:02:30 AM' } }] } });
        s = (await sum()).data;
        const ic7 = s.incidents.find(i => i.number === '1401005');
        const cA = ic7 && ic7.crews.find(c => c.unit === 'جنوب 6');
        const cB = ic7 && ic7.crews.find(c => c.unit === 'جنوب 7');
        check('⑦ المُلغاة قبل التحرك: counted=false وخارج العدّاد (لا تُظلم ولا تُحسب)', !!cA && cA.counted === false && (s.byCrew['جنوب 6'] || 0) === c0('جنوب 6'), JSON.stringify(cA));
        check('⑦ البديلة المتحركة: counted=true وعدّادها=1', !!cB && cB.counted === true && (s.byCrew['جنوب 7'] || 0) === c0('جنوب 7') + 1, JSON.stringify(cB));
        check('⑦ التاريخ محفوظ كاملًا (فرقتان في التفاصيل) والإجمالي +1 فقط', ic7.crews.length === 2 && s.total === s0.total + 5, 'total=' + s.total);

        // ── ⑧ تحركت ثم أُلغيت لاحقًا ← تُحسب؛ وفرقتان تحركتا لنفس الرقم = كلتاهما ──
        console.log('\n⑧ تحركت ثم أُلغيت لاحقًا (لا تُظلم):');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401006', crews: [{ team: 'جنوب 9', phases: { 'قبول': '9:00:00 AM', 'التحرك': '9:01:10 AM' } }] } });
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401006', crews: [{ team: 'جنوب 10', phases: { 'قبول': '9:05:00 AM', 'التحرك': '9:06:00 AM' } }] } });
        s = (await sum()).data;
        const ic8 = s.incidents.find(i => i.number === '1401006');
        check('⑧ التي تحركت ثم أُلغيت تبقى محتسبة (جنوب 9 +1)', (s.byCrew['جنوب 9'] || 0) === c0('جنوب 9') + 1 && ic8.crews.find(c => c.unit === 'جنوب 9').counted === true);
        check('⑧ فرقتان تحركتا لنفس الرقم: كلتاهما محتسبة والإجمالي +1 فقط', (s.byCrew['جنوب 10'] || 0) === c0('جنوب 10') + 1 && s.total === s0.total + 6, 'total=' + s.total);

        // ── ⑨ دمج الأزمنة التصاعدي: لقطة «قبول» ثم «تحرك» لاحقًا ← ترتقي لمحتسبة بلا سجل جديد ──
        console.log('\n⑨ دمج الأزمنة التصاعدي:');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401007', crews: [{ team: 'جنوب 11', phases: { 'قبول': '10:00:00 AM' } }] } });
        s = (await sum()).data;
        const c11a = s.incidents.find(i => i.number === '1401007').crews[0];
        check('⑨ لقطة أولى بلا تحرك ← غير محتسبة بعد', c11a.counted === false && (s.byCrew['جنوب 11'] || 0) === c0('جنوب 11'), JSON.stringify(c11a));
        const r9 = await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401007', crews: [{ team: 'جنوب 11', phases: { 'قبول': '10:00:00 AM', 'التحرك': '10:03:00 AM', 'الاستجابة': '10:09:00 AM' } }] } });
        s = (await sum()).data;
        const c11b = s.incidents.find(i => i.number === '1401007').crews[0];
        check('⑨ التكرار لا ينشئ سجلًا (skipped) لكنه يستكمل التحرك والاستجابة', r9.data.created === false && (r9.data.skippedCrews || []).includes('جنوب 11') && c11b.phases['التحرك'] === '10:03:00 AM' && c11b.phases['الاستجابة'] === '10:09:00 AM');
        check('⑨ بعد اكتمال التحرك أصبحت محتسبة (جنوب 11 +1) والإجمالي +7', (s.byCrew['جنوب 11'] || 0) === c0('جنوب 11') + 1 && s.total === s0.total + 7, 'total=' + s.total);
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401007', crews: [{ team: 'جنوب 11', phases: { 'التحرك': '11:11:11 PM', 'الوصول': '10:20:00 AM' } }] } });
        s = (await sum()).data;
        const c11c = s.incidents.find(i => i.number === '1401007').crews[0];
        check('⑨ الدمج لا يكتب فوق وقت التحرك الموجود، ويستكمل الوصول فقط', c11c.phases['التحرك'] === '10:03:00 AM' && c11c.phases['الوصول'] === '10:20:00 AM', JSON.stringify(c11c.phases));

        // ── ⑩ مؤشر زمن الاستجابة (تعريف المالك): من إنشاء البلاغ في CAD ← الوصول/المباشرة ──
        console.log('\n⑩ مؤشر زمن الاستجابة:');
        const rtA0 = (s0.responseTime && s0.responseTime.arrival) ? s0.responseTime.arrival.count : 0;
        const rtM0 = (s0.responseTime && s0.responseTime.mubashara) ? s0.responseTime.mubashara.count : 0;
        // (أ) مناوبة تعبر منتصف الليل: إنشاء 11:58 PM ← وصول 12:05 AM = 7.0 د · مباشرة 12:07:30 = 9.5 د
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401008', createdAt: '20/08/2026 11:58:00 PM', crews: [{ team: 'جنوب 12', phases: { 'قبول': '11:59:00 PM', 'التحرك': '11:59:30 PM', 'البحث': '12:05:00 AM', 'العلاج': '12:07:30 AM' } }] } });
        s = (await sum()).data;
        const c12 = s.incidents.find(i => i.number === '1401008').crews[0];
        check('⑩ عبور منتصف الليل: الوصول=7.0 د والمباشرة=9.5 د (وليس سالبًا)', c12.respArrivalMin === 7 && c12.respMubasharaMin === 9.5, JSON.stringify({ a: c12.respArrivalMin, m: c12.respMubasharaMin }));
        check('⑩ وقت إنشاء البلاغ محفوظ على السجل', s.incidents.find(i => i.number === '1401008').cadCreatedAt === '20/08/2026 11:58:00 PM');
        // (ب) نفس اليوم: إنشاء 5:00:06 ← وصول 5:09:06 = 9.0 د · مباشرة 5:12:06 = 12.0 د
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401009', createdAt: '20/08/2026 5:00:06 AM', crews: [{ team: 'جنوب 13', phases: { 'قبول': '5:00:30 AM', 'التحرك': '5:01:00 AM', 'البحث': '5:09:06 AM', 'العلاج': '5:12:06 AM' } }] } });
        s = (await sum()).data;
        const c13 = s.incidents.find(i => i.number === '1401009').crews[0];
        check('⑩ نفس اليوم: الوصول=9.0 د والمباشرة=12.0 د', c13.respArrivalMin === 9 && c13.respMubasharaMin === 12, JSON.stringify({ a: c13.respArrivalMin, m: c13.respMubasharaMin }));
        // (ج) وقت الإنشاء يصل متأخرًا ← إعادة حساب المشاركات السابقة (backfill)
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401010', crews: [{ team: 'جنوب 14', phases: { 'قبول': '6:00:20 AM', 'التحرك': '6:01:00 AM' } }] } });
        s = (await sum()).data;
        const c14a = s.incidents.find(i => i.number === '1401010').crews[0];
        check('⑩ بلا وقت إنشاء: خارج المؤشر بصدق (null)', c14a.respArrivalMin === null && c14a.respMubasharaMin === null);
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401010', createdAt: '20/08/2026 6:00:00 AM', crews: [{ team: 'جنوب 14', phases: { 'البحث': '6:08:00 AM' } }] } });
        s = (await sum()).data;
        const c14b = s.incidents.find(i => i.number === '1401010').crews[0];
        check('⑩ وصول وقت الإنشاء متأخرًا + دمج الوصول ← الوصول=8.0 د', c14b.respArrivalMin === 8 && c14b.respMubasharaMin === null, JSON.stringify({ a: c14b.respArrivalMin }));
        // (د) بلاغ بفرقتين: المُسندة بلا تحرك خارج المؤشر، والبلاغ يدخل مرة واحدة بأسرع وصول
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401011', createdAt: '20/08/2026 7:00:00 AM', crews: [{ team: 'جنوب 15', phases: { 'قبول': '7:01:00 AM' } }, { team: 'جنوب 16', phases: { 'قبول': '7:01:00 AM', 'التحرك': '7:02:00 AM', 'البحث': '7:11:00 AM', 'العلاج': '7:14:00 AM' } }] } });
        s = (await sum()).data;
        const ic11 = s.incidents.find(i => i.number === '1401011');
        const c15 = ic11.crews.find(c => c.unit === 'جنوب 15'), c16 = ic11.crews.find(c => c.unit === 'جنوب 16');
        check('⑩ غير المتحركة: counted=false وبلا زمن استجابة', c15.counted === false && c15.respArrivalMin === null);
        check('⑩ المتحركة الواصلة: الوصول=11 د والمباشرة=14 د', c16.counted === true && c16.respArrivalMin === 11 && c16.respMubasharaMin === 14);
        // مؤشر القطاع: +4 بلاغات للوصول (1401008/9/10/11) و+3 للمباشرة (1401010 بلا مباشرة)
        const rt = s.responseTime;
        check('⑩ مؤشر القطاع: +4 بلاغات للوصول و+3 للمباشرة (تعدد الفرق لا يكرر)', rt && rt.arrival.count === rtA0 + 4 && rt.mubashara.count === rtM0 + 3, JSON.stringify(rt && { a: rt.arrival.count, m: rt.mubashara.count }));
        if (rtA0 === 0 && rtM0 === 0) {
            check('⑩ المتوسطات: الوصول 8.8 د · المباشرة 11.8 د', rt.arrival.avg === 8.8 && rt.mubashara.avg === 11.8, JSON.stringify({ a: rt.arrival.avg, m: rt.mubashara.avg }));
        }

        // ── ⑪ «آخر بلاغ» بوقت الإنشاء الفعلي: إدخال متأخر لا يسرق اللقب ──
        console.log('\n⑪ آخر بلاغ بوقت الإنشاء الفعلي:');
        const cadTs = s2 => { const m = s2.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i); let h = +m[4]; if (/pm/i.test(m[7] || '') && h < 12) h += 12; if (/am/i.test(m[7] || '') && h === 12) h = 0; return new Date(+m[3], +m[2] - 1, +m[1], h, +m[5], +(m[6] || 0)).getTime(); };
        // بلاغ أُنشئ 11:59:30 PM وسُجّل أولًا (بعد كل أزمنة الاختبار الأخرى)
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401012', createdAt: '20/08/2026 11:59:30 PM', crews: [{ team: 'جنوب 8', phases: { 'التحرك': '11:59:40 PM' } }] } });
        s = (await sum()).data;
        // المؤشر = max عبر كل البلاغات: القاعدة المنسوخة قد تحوي بلاغات حقيقية أحدث
        // (مثل 1303794 اليوم) — فالمتوقع هو الأكبر بين خط الأساس و11:59:30 PM، لا قيمة ثابتة
        const exp11 = Math.max((s0.lastReportTs || 0), cadTs('20/08/2026 11:59:30 PM'));
        check('⑪ آخر بلاغ = max(خط الأساس، الأحدث إنشاءً 11:59:30 PM)', s.lastReportTs === exp11, 'lastReportTs=' + (s.lastReportTs && new Date(s.lastReportTs).toISOString()) + ' exp=' + new Date(exp11).toISOString());
        // بلاغ أُنشئ 11:59:00 PM لكنه دخل المنصة بعده (إدخال متأخر) ← لا يحرك المؤشر إطلاقًا
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401013', createdAt: '20/08/2026 11:59:00 PM', crews: [{ team: 'جنوب 8', phases: { 'التحرك': '11:59:10 PM' } }] } });
        s = (await sum()).data;
        check('⑪ الإدخال المتأخر (11:59:00 PM) لا يسرق اللقب ولا يحرك المؤشر', s.lastReportTs === exp11 && s.lastReportTs !== cadTs('20/08/2026 11:59:00 PM'), 'lastReportTs=' + (s.lastReportTs && new Date(s.lastReportTs).toISOString()));

        // ── ⑫ طبقة التقاط الموقع: العنوان الخام + الحي المشتق + الاستكمال بلا كتابة فوق ──
        console.log('\n⑫ التقاط الموقع والحي:');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401014', address: 'RLFA7348، 7348 طريق ابن تيمية، 4788، حي الشفا، الرياض 14721، السعودية', region: 'South Riyadh city Sector', crews: [{ team: 'جنوب 3' }] } });
        s = (await sum()).data;
        const ic14 = s.incidents.find(i => i.number === '1401014');
        check('⑫ «حي الشفا» ← district=الشفا مع حفظ العنوان الخام والمنطقة', ic14.district === 'الشفا' && ic14.address.includes('طريق ابن تيمية') && ic14.region === 'South Riyadh city Sector', JSON.stringify({ d: ic14.district }));
        // نمط بلا بادئة «حي»: الجزء الذي يسبق «الرياض …»
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401015', address: '7616 الخليل بن أحمد، بدر، الرياض 14724، السعودية', crews: [{ team: 'جنوب 3' }] } });
        s = (await sum()).data;
        check('⑫ بلا بادئة «حي» ← district=بدر (ما قبل الرياض)', s.incidents.find(i => i.number === '1401015').district === 'بدر');
        // الاستكمال بلا كتابة فوق: إعادة إرسال بعنوان مختلف لا يغيّر المخزن
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401014', address: 'عنوان مختلف تمامًا، العليا، الرياض 12222، السعودية', crews: [{ team: 'جنوب 3' }] } });
        s = (await sum()).data;
        const ic14b = s.incidents.find(i => i.number === '1401014');
        check('⑫ العنوان/الحي المخزنان لا يُكتب فوقهما', ic14b.district === 'الشفا' && ic14b.address.includes('ابن تيمية'), JSON.stringify({ d: ic14b.district }));
        // استكمال لاحق لبلاغ حُفظ بلا عنوان
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401016', crews: [{ team: 'جنوب 3' }] } });
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401016', address: 'طريق الملك فهد، حي العليا، الرياض 12212، السعودية', crews: [{ team: 'جنوب 3' }] } });
        s = (await sum()).data;
        check('⑫ بلاغ بلا عنوان ثم وصل متأخرًا ← district=العليا', s.incidents.find(i => i.number === '1401016').district === 'العليا');

        // الموقع التفصيلي كبيانات مستقلة (قرار المالك 2026-08-20): الشارع والمدينة مشتقان ومحفوظان
        check('⑫ street/city مستقلان: «7348 طريق ابن تيمية» / «الرياض»', ic14b.street === '7348 طريق ابن تيمية' && ic14b.city === 'الرياض', JSON.stringify({ st: ic14b.street, c: ic14b.city }));
        const ic15 = s.incidents.find(i => i.number === '1401015');
        check('⑫ نمط «رقم مبنى + اسم»: street=«7616 الخليل بن أحمد»', ic15.street === '7616 الخليل بن أحمد' && ic15.city === 'الرياض', JSON.stringify({ st: ic15.street }));
        const ic16 = s.incidents.find(i => i.number === '1401016');
        check('⑫ شارع بكلمة «طريق»: street=«طريق الملك فهد» وcity=الرياض', ic16.street === 'طريق الملك فهد' && ic16.city === 'الرياض', JSON.stringify({ st: ic16.street }));
        // عنوان بلا اسم شارع (رقم فقط) ← street=null بصدق
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401017', address: '8372، منفوحة، الرياض 12681، السعودية', crews: [{ team: 'جنوب 3' }] } });
        s = (await sum()).data;
        const ic17 = s.incidents.find(i => i.number === '1401017');
        check('⑫ بلا اسم شارع ← street=null بصدق مع district=منفوحة وcity=الرياض', ic17.street === null && ic17.district === 'منفوحة' && ic17.city === 'الرياض', JSON.stringify({ st: ic17.street, d: ic17.district }));

        // ── ⑬ تجميع المواقع بالحي: كل بلاغ مرة واحدة تحت حيّه مهما تعددت فرقه ──
        console.log('\n⑬ تجميع المواقع بالحي (byDistrict):');
        s = (await sum()).data;
        check('⑬ الملخص يحمل byDistrict', !!s.byDistrict && typeof s.byDistrict === 'object');
        check('⑬ الشفا/بدر/العليا +1 لكل منها عن خط الأساس',
            (s.byDistrict['الشفا'] || 0) === d0('الشفا') + 1 &&
            (s.byDistrict['بدر'] || 0) === d0('بدر') + 1 &&
            (s.byDistrict['العليا'] || 0) === d0('العليا') + 1,
            JSON.stringify(s.byDistrict));
        // كل بلاغ CAD يدخل التجميع مرة واحدة بالضبط — البلاغ بفرقتين (1401011) لا يضاعف حيّه
        const totalInDistricts = Object.values(s.byDistrict).reduce((a, b) => a + b, 0);
        check('⑬ مجموع byDistrict = عدد البلاغات الفريدة (تعدد الفرق لا يضاعف الحي)', totalInDistricts === s.incidentsCount, totalInDistricts + ' vs ' + s.incidentsCount);
        check('⑬ بلاغ بلا عنوان يُصنف بصدق «غير محدد» ولا يُخترع له حي', (s.byDistrict['غير محدد'] || 0) > d0('غير محدد'));

        // ── ⑭ إحداثيات CAD الأصلية: تُحفظ كما هي، وتصحيح CAD يُطاع، ولا تُخترع ──
        console.log('\n⑭ إحداثيات البلاغ الأصلية:');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401018', lat: 24.713551, lng: 46.675295, crews: [{ team: 'جنوب 4' }] } });
        s = (await sum()).data;
        const ic18 = s.incidents.find(i => i.number === '1401018');
        check('⑭ إحداثيات صحيحة تُحفظ وتظهر في الملخص كما هي', ic18.lat === 24.713551 && ic18.lng === 46.675295, JSON.stringify({ lat: ic18.lat, lng: ic18.lng }));
        // تصحيح الموقع في CAD يُحدِّث المخزن (قرار المالك 2026-08-21 صباحًا — اختبار D):
        // إحداثيات CAD الصحيحة المختلفة تُطاع لأن CAD هو مرجع الموقع
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401018', lat: 24.9, lng: 46.9, crews: [{ team: 'جنوب 4' }] } });
        s = (await sum()).data;
        const ic18b = s.incidents.find(i => i.number === '1401018');
        check('⑭ تصحيح CAD للموقع يُحدِّث الإحداثيات المخزنة', ic18b.lat === 24.9 && ic18b.lng === 46.9, JSON.stringify({ lat: ic18b.lat, lng: ic18b.lng }));
        // قيم خارج النطاق/غير رقمية ← تُهمَل ولا تُخترع ولا تمس المخزن
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401018', lat: 91.5, lng: 'abc', crews: [{ team: 'جنوب 4' }] } });
        s = (await sum()).data;
        const ic18c = s.incidents.find(i => i.number === '1401018');
        check('⑭ قيم غير صالحة تُهمَل ولا تمس الإحداثيات المخزنة', ic18c.lat === 24.9 && ic18c.lng === 46.9);
        // بلاغ جديد بقيم غير صالحة ← يُسجل بلا إحداثيات بصدق
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401019', lat: 91.5, lng: 'abc', crews: [{ team: 'جنوب 4' }] } });
        s = (await sum()).data;
        const ic19 = s.incidents.find(i => i.number === '1401019');
        check('⑭ بلاغ جديد بقيم غير صالحة ← lat/lng=null بصدق ويُسجل طبيعيًا', !!ic19 && ic19.lat === null && ic19.lng === null);

        // ── ⑮ خطورة البلاغ وحالة القطاع للخريطة الذكية (قرار المالك 2026-08-20) ──
        console.log('\n⑮ خطورة البلاغ (severity) وحالة القطاع (mapStatus):');
        const pad2 = n => String(n).padStart(2, '0');
        const mer = d => d.getHours() >= 12 ? 'PM' : 'AM';
        const h12 = d => d.getHours() % 12 || 12;
        const cadDT = d => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${h12(d)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${mer(d)}`;
        const cadT = d => `${h12(d)}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${mer(d)}`;
        const nowT = Date.now();
        // (أ) فرقة محتسبة وصلت («البحث») ← green وأفضل زمن وصول على البلاغ من الخدمة
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401020', createdAt: cadDT(new Date(nowT - 20 * 60000)), crews: [{ team: 'جنوب 15', phases: { 'قبول': cadT(new Date(nowT - 19 * 60000)), 'التحرك': cadT(new Date(nowT - 18 * 60000)), 'البحث': cadT(new Date(nowT - 8 * 60000)) } }] } });
        // (ب) بلا وصول وضمن حد متوسط القطاع ← yellow
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401021', createdAt: cadDT(new Date(nowT - 2 * 60000)), crews: [{ team: 'جنوب 16', phases: { 'قبول': cadT(new Date(nowT - 60000)), 'التحرك': cadT(new Date(nowT - 30000)) } }] } });
        // (ج) بلا وصول وانقضى أكثر من متوسط وصول القطاع ← red
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401022', createdAt: cadDT(new Date(nowT - 6 * 3600000)), crews: [{ team: 'جنوب 17', phases: { 'قبول': cadT(new Date(nowT - 6 * 3600000 + 60000)) } }] } });
        s = (await sum()).data;
        const ic20 = s.incidents.find(i => i.number === '1401020');
        const ic21 = s.incidents.find(i => i.number === '1401021');
        const ic22 = s.incidents.find(i => i.number === '1401022');
        check('⑮ فرقة محتسبة وصلت ← severity=green', ic20.severity === 'green', ic20.severity);
        check('⑮ أفضل زمن وصول على البلاغ = 12 د من الخدمة (لا اشتقاق في الواجهة)', ic20.bestArrivalMin === 12 && ic20.bestMubasharaMin === null, JSON.stringify({ a: ic20.bestArrivalMin, m: ic20.bestMubasharaMin }));
        check('⑮ بلا وصول ضمن المتوسط ← severity=yellow', ic21.severity === 'yellow', ic21.severity);
        check('⑮ بلا وصول وتجاوز متوسط القطاع ← severity=red', ic22.severity === 'red', ic22.severity + ' avg=' + s.responseTime.arrival.avg);
        check('⑮ mapStatus.sectorStatus=red (أسوأ حالة قائمة) + topDistrict محسوب سيرفريًا',
            s.mapStatus && s.mapStatus.sectorStatus === 'red' && s.mapStatus.topDistrict && s.mapStatus.topDistrict.count >= 1, JSON.stringify(s.mapStatus));
        check('⑮ mapStatus: positioned + noLocation = عدد البلاغات النشطة (قرار 2026-08-22: المؤشرات التشغيلية من النشطة فقط)',
            s.mapStatus.positionedCount + s.mapStatus.noLocationCount === s.activeCount,
            s.mapStatus.positionedCount + '+' + s.mapStatus.noLocationCount + ' vs ' + s.activeCount);
        check('⑮ mapStatus.peakHour من أوقات إنشاء CAD الفعلية', s.mapStatus.peakHour && typeof s.mapStatus.peakHour.hour === 'number' && s.mapStatus.peakHour.count >= 1, JSON.stringify(s.mapStatus.peakHour));
        check('⑮ mapStatus.topStreets مرتبة تنازليًا وبلا اختراع', Array.isArray(s.mapStatus.topStreets) && (!s.mapStatus.topStreets.length || (typeof s.mapStatus.topStreets[0].name === 'string' && s.mapStatus.topStreets[0].count >= 1)));
        check('⑮ mapStatus.noLocation يسرد غير الموقَّعة بصدق (1401019 بلا إحداثيات)', s.mapStatus.noLocation.some(x => x.number === '1401019'));

        // ── ⑯ هوية الإحداثيات عبر بلاغات متعددة (بوابة قبول المالك ② 2026-08-20) ──
        // كل بلاغ يجب أن يحمل lat/lng الخاص به حرفيًا: stored ↔ summary ↔ (marker في الواجهة يُبنى من نفس الحقل)
        console.log('\n⑯ هوية الإحداثيات: incident ID → stored → summary (مطابقة 100%):');
        const GEO = [
            { number: '1401030', lat: 24.610101, lng: 46.710101, district: 'حي أ', address: 'موقع أ' },
            { number: '1401031', lat: 24.720202, lng: 46.820202, district: 'حي ب', address: 'موقع ب' },
            { number: '1401032', lat: 24.530303, lng: 46.630303, district: 'حي ج', address: 'موقع ج' }
        ];
        for (const g of GEO) {
            await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: g.number, lat: g.lat, lng: g.lng, address: g.address, crews: [{ team: 'جنوب 4' }] } });
        }
        s = (await sum()).data;
        const geoDb = new Database(TMP_DB, { readonly: true });
        let geoOk = true, geoDetail = [];
        for (const g of GEO) {
            const row = geoDb.prepare('SELECT lat, lng FROM incident_registry WHERE number = ?').get(g.number);
            const sm = s.incidents.find(i => i.number === g.number);
            const ok = row && sm && row.lat === g.lat && row.lng === g.lng && sm.lat === g.lat && sm.lng === g.lng;
            if (!ok) { geoOk = false; geoDetail.push(g.number + ':' + JSON.stringify({ stored: row, summary: sm && { lat: sm.lat, lng: sm.lng } })); }
        }
        geoDb.close();
        check('⑯ 3 بلاغات بإحداثيات مختلفة: المخزن = المرسل = الملخص (بلا تبادل ولا افتراضي)', geoOk, geoDetail.join(' | '));
        check('⑯ كل بلاغ يحمل إحداثيات مختلفة عن الآخر (لا نقطة واحدة مشتركة)',
            new Set(GEO.map(g => { const i = s.incidents.find(x => x.number === g.number); return i.lat + ',' + i.lng; })).size === 3);

        // ── ⑤ الكتابة في جداول المحرك نفسها (لا مخزن موازٍ) ──
        console.log('\n⑤ مصدر واحد:');
        const chk = new Database(TMP_DB, { readonly: true });
        const reg = chk.prepare('SELECT COUNT(*) c FROM incident_registry').get().c;
        const linked = chk.prepare('SELECT COUNT(*) c FROM report_times WHERE incident_number IS NOT NULL').get().c;
        chk.close();
        check('⑤ incident_registry أضيفت له 25 رقمًا فريدًا', reg === reg0 + 25, 'reg=' + reg + ' base=' + reg0);
        check('⑤ مشاركات report_times المربوطة +32', linked === linked0 + 32, 'linked=' + linked + ' base=' + linked0);
        check('⑤ لا ملف cad-reports.json (لا مخزن موازٍ)', !fs.existsSync(path.join(TMP_DIR, 'cad-reports.json')) && !fs.existsSync(path.join(ROOT, 'data', 'cad-reports.json')));

        // ── ⑰ منع الازدواج عبر التسليم بين المناوبات (قرار المالك 2026-08-21) ──
        // بلاغ أُنشئ قبل التسليم وسُجّل في مناوبة قديمة، ثم أعاد الـOverlay إرساله بعد فتح
        // مناوبة جديدة ← يُلحق بسجله القائم ولا يتكرر في incident_registry إطلاقًا (حالة 1303365)
        console.log('\n⑰ ازدواج عبر التسليم (رقم البلاغ مفتاح عالمي):');
        // مناوبة قديمة حقيقية من النسخة (FK) — تحاكي مناوبة ما قبل التسليم
        const shDb = new Database(TMP_DB, { readonly: true });
        const oldShiftRow = shDb.prepare('SELECT id FROM shifts WHERE id != ? ORDER BY id DESC LIMIT 1').get(active.id);
        shDb.close();
        const OLD_SHIFT = oldShiftRow.id;
        const wdb = new Database(TMP_DB);
        wdb.prepare(`INSERT INTO incident_registry (shift_id, number, code, type, source, created_at, cad_created_at) VALUES (?, '1401040', NULL, 'medical', 'cad-oneclick', ?, '20/08/2026 10:00:00 PM')`).run(OLD_SHIFT, new Date().toISOString());
        wdb.close();
        const sPre17 = (await sum()).data;
        const r17 = await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401040', crews: [{ team: 'جنوب 90', phases: { 'قبول': '10:01:00 PM', 'التحرك': '10:05:00 PM' } }] } });
        s = (await sum()).data;
        check('⑰ created=false رغم اختلاف المناوبة — لا سجل جديد', r17.data.created === false, JSON.stringify(r17.data));
        check('⑰ إجمالي المناوبة النشطة لم يتغير (البلاغ يتبع مناوبته الأصلية)', s.total === sPre17.total, 'total=' + s.total + ' pre=' + sPre17.total);
        check('⑰ عدّاد جنوب 90 لم يُحتسب في المناوبة النشطة', (s.byCrew['جنوب 90'] || 0) === ((sPre17.byCrew && sPre17.byCrew['جنوب 90']) || 0));
        const chk17 = new Database(TMP_DB, { readonly: true });
        const dup17 = chk17.prepare(`SELECT COUNT(*) c FROM incident_registry WHERE number = '1401040'`).get().c;
        const part17 = chk17.prepare(`SELECT r.shift_id sid FROM report_times t JOIN reports r ON r.id = t.report_id WHERE t.incident_number = '1401040'`).all();
        chk17.close();
        check('⑰ سجل واحد فقط للرقم 1401040 عبر القاعدة كلها', dup17 === 1, 'rows=' + dup17);
        check('⑰ المشاركة أُلحقت بالمناوبة الأصلية', part17.length === 1 && String(part17[0].sid) === String(OLD_SHIFT), JSON.stringify(part17));

        // ── ⑱ حالة المشاركة المسحوبة (§4 — 2026-08-21): لا عدّ ولا مؤقت ولا تنبيه — والتاريخ يبقى ──
        console.log('\n⑱ الفرقة المسحوبة (withdrawn):');
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401041', createdAt: '21/08/2026 8:00:00 AM', crews: [{ team: 'جنوب 91', phases: { 'قبول': '8:01:00 AM', 'التحرك': '8:02:00 AM' } }, { team: 'جنوب 92', phases: { 'قبول': '8:01:30 AM', 'التحرك': '8:03:00 AM', 'البحث': '8:15:00 AM' } }] } });
        let s18 = (await sum()).data;
        const c91pre = s18.byCrew['جنوب 91'] || 0;
        // سحب جنوب 91 بعد تحركها — علامة على سجلها القائم (لا حذف)
        const r18 = await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401041', crews: [{ team: 'جنوب 91', withdrawn: true }] } });
        s = (await sum()).data;
        const ic41 = s.incidents.find(i => i.number === '1401041');
        const cr91 = ic41.crews.find(c => c.unit === 'جنوب 91');
        const cr92 = ic41.crews.find(c => c.unit === 'جنوب 92');
        check('⑱ السحب: created=false وwithdrawnCrews=[جنوب 91]', r18.data.created === false && (r18.data.withdrawnCrews || []).includes('جنوب 91'), JSON.stringify(r18.data));
        check('⑱ المسحوبة تُستبعد من العدّ (−1) والزميلة تبقى محتسبة', (s.byCrew['جنوب 91'] || 0) === c91pre - 1 && cr92.counted === true, JSON.stringify({ c91: s.byCrew['جنوب 91'], pre: c91pre }));
        check('⑱ crews تُظهر الحالة بصدق: withdrawn=true وcounted=false وتاريخها محفوظ', cr91.withdrawn === true && cr91.counted === false && cr91.phases && cr91.phases['التحرك'] === '8:02:00 AM', JSON.stringify(cr91));
        check('⑱ مؤشر البلاغ من المحتسبة فقط: وصول 15 د (جنوب 92)', ic41.bestArrivalMin === 15, JSON.stringify({ a: ic41.bestArrivalMin }));
        const chk18 = new Database(TMP_DB, { readonly: true });
        const w91 = chk18.prepare(`SELECT t.withdrawn w FROM report_times t JOIN reports r ON r.id = t.report_id WHERE t.incident_number = '1401041' AND r.unit = 'جنوب 91'`).get();
        chk18.close();
        check('⑱ report_times.withdrawn=1 مخزّنة (علامة لا حذف)', !!w91 && w91.w === 1, JSON.stringify(w91));
        // عودة صريحة: withdrawn=false فقط يزيل العلامة ويعيد الاحتساب (لا استنتاج)
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401041', crews: [{ team: 'جنوب 91', withdrawn: false }] } });
        s = (await sum()).data;
        const cr91b = s.incidents.find(i => i.number === '1401041').crews.find(c => c.unit === 'جنوب 91');
        check('⑱ withdrawn=false الصريح يعيد الاحتساب', cr91b.withdrawn === false && cr91b.counted === true && (s.byCrew['جنوب 91'] || 0) === c91pre, JSON.stringify(cr91b));
        // سحب فرقة لم تُسجَّل أصلًا: تُنشأ مشاركة معلَّمة ولا تُحتسب إطلاقًا
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401042', createdAt: '21/08/2026 9:00:00 AM', crews: [{ team: 'جنوب 93', phases: { 'التحرك': '9:05:00 AM' } }] } });
        s18 = (await sum()).data;
        const c94pre = s18.byCrew['جنوب 94'] || 0;
        await api('/api/cad-reports', { method: 'POST', token: TK, body: { number: '1401042', crews: [{ team: 'جنوب 94', withdrawn: true }] } });
        s = (await sum()).data;
        const cr94 = s.incidents.find(i => i.number === '1401042').crews.find(c => c.unit === 'جنوب 94');
        check('⑱ سحب بلا مشاركة سابقة ← سجل معلَّم محفوظ ولا يدخل العدّ', !!cr94 && cr94.withdrawn === true && cr94.counted === false && (s.byCrew['جنوب 94'] || 0) === c94pre, JSON.stringify(cr94));

    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }

    console.log('\n' + '═'.repeat(50));
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
    console.log('★ محرك التوزيع برقم البلاغ يعمل بكل القواعد');
})().catch(e => { console.error('🛑 تعذر الإكمال:', e.message); process.exit(1); });
