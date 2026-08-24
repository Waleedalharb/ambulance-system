/**
 * ═══ اختبار اكتشاف احتمال تكرار البلاغات — duplicate-detection-test.js ═══
 * (اعتماد المالك 2026-08-24 — ملحق note-18): «احتمال تكرار — يحتاج تحقق»
 * تنبيه فقط داخل الخريطة التشغيلية — لا دمج ولا إلغاء ولا سجل مراجعة،
 * والقرار في CAD حصرًا. Potential Duplicate ≠ Duplicate.
 *
 * جزءان:
 *  ① محرك نقي بلا خادم — الاختبارات الثمانية الأولى من وثيقة الاعتماد حرفيًا:
 *    1) مبلغ متطابق + موقع قريب → اشتباه قوي 🔴
 *    2) موقع قريب فقط → لا يتجاوز المتوسط إطلاقًا (حارس cap)
 *    3) نفس الموقع + زمن بعيد → تخفيض الاشتباه
 *    4) نفس النوع + موقع + زمن متقارب → رفع الاشتباه
 *    5) بيانات ناقصة → لا ادعاء غير مدعوم
 *    6) الملغى في CAD مرشح موسوم «ملغى» — إلغاؤه ليس دليلًا ولا نقاط إضافية
 *    7) لا تطابق → لا تنبيه
 *    8) عدة مرشحين → يُعرضون بوضوح مرتبين
 *  ② تكامل على خادم معزول (VACUUM INTO + DATA_DIR مؤقت + مناوبة مبذورة):
 *    9) لا تأثير على العدّادات (total/byCrew/byType) + ظهور التنبيه في الملخص
 *       + الخصوصية: رقم المبلغ لا يظهر في أي استجابة + استكمال الرقم المتأخر
 *       دون مسّ الموجود.
 * التشغيل: node scripts/duplicate-detection-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const DD = require(path.join(ROOT, 'services', 'duplicate-detection'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
}

/* ═══════════════ الجزء ① — المحرك النقي ═══════════════ */
const BASE_TS = new Date(2026, 7, 24, 10, 0, 0).getTime(); // 24/8/2026 10:00 محلي
function inc(number, o = {}) {
    return {
        number, status: o.status || 'active',
        callerNumber: o.phone || null, description: o.desc || null,
        address: o.address || null, type: o.type || null, code: o.code || null,
        lat: o.lat != null ? o.lat : null, lng: o.lng != null ? o.lng : null,
        createdTs: o.min === null ? null : BASE_TS + (o.min || 0) * 60000 // min:null = بلا زمن معروف
    };
}
const L0 = { lat: 24.650000, lng: 46.700000 };

console.log('🧪 الجزء ① — المحرك النقي (قواعد الاشتباه):\n');

// ── 1) مبلغ متطابق + موقع قريب → اشتباه قوي ──
console.log('1) رقم مبلغ متطابق + موقع قريب:');
{
    const a = inc('2001', { phone: '0533133496', ...L0, min: 0, type: 'traffic', code: '29B05U' });
    const b = inc('2002', { phone: '0533133496', lat: L0.lat + 0.00036, lng: L0.lng, min: 4, type: 'traffic', code: '29B05U' }); // ~40م
    const r = DD.scorePair(b, a);
    check('1.1 الزوج أهل والمستوى high 🔴', !!r && r.level === 'high', JSON.stringify(r));
    check('1.2 الأدلة تشمل المبلغ والمسافة والزمن', !!r && ['caller', 'distance', 'time'].every(k => r.evidence.some(e => e.key === k)));
    check('1.3 الأدلة لا تحمل الرقم نفسه (مقنّعة)', !!r && !JSON.stringify(r.evidence).includes('0533133496') && !JSON.stringify(r.evidence).includes('533133496'));
    // صيغ الرقم المختلفة = نفس المبلغ
    check('1.4 تطبيع +966 و00966 والصفر البادئ',
        DD.normalizePhone('+966533133496') === DD.normalizePhone('0533133496') &&
        DD.normalizePhone('00966533133496') === DD.normalizePhone('0533133496'));
    const b2 = inc('2003', { phone: '+966533133496', lat: L0.lat + 0.00036, lng: L0.lng, min: 4 });
    check('1.5 الاشتباه يعمل عبر اختلاف صيغة الرقم', !!DD.scorePair(b2, a));
}

// ── 2) موقع قريب فقط → لا يتجاوز المتوسط ──
console.log('2) موقع قريب فقط (بلا مبلغ):');
{
    const a = inc('2011', { ...L0, min: 0 });
    const b = inc('2012', { lat: L0.lat + 0.00054, lng: L0.lng, min: 6 }); // ~60م
    const r = DD.scorePair(b, a);
    check('2.1 يظهر بمستوى low 🟡 فقط', !!r && r.level === 'low', JSON.stringify(r));
    // أقصى تركيبة موقع-فقط: أقرب مسافة + أقرب زمن + نص متطابق
    const c = inc('2013', { lat: L0.lat + 0.00018, lng: L0.lng, min: 3, desc: 'حادث مروري على الطريق', address: 'طريق الملك فهد' });
    const a2 = inc('2010', { ...L0, min: 0, desc: 'حادث مروري على الطريق', address: 'طريق الملك فهد' });
    const r2 = DD.scorePair(c, a2);
    check('2.2 حتى أقصى تركيبة موقع-فقط لا تتجاوز الحارس (≤' + DD.DEFAULT_CONFIG.locationOnlyCap + ')',
        !!r2 && r2.score <= DD.DEFAULT_CONFIG.locationOnlyCap && r2.level !== 'high' && r2.level !== 'medium', JSON.stringify(r2));
}

// ── 3) نفس الموقع + زمن بعيد → تخفيض ──
console.log('3) نفس الموقع لكن زمن بعيد:');
{
    const a = inc('2021', { ...L0, min: 0 });
    const near = DD.scorePair(inc('2022', { ...L0, min: 5 }), a);   // 25+20
    const mid = DD.scorePair(inc('2023', { ...L0, min: 45 }), a);   // 25+5
    const far = DD.scorePair(inc('2024', { ...L0, min: 90 }), a);   // 25 → دون حد العرض
    check('3.1 زمن متقارب → أعلى نقاطًا', !!near && near.score === 45, JSON.stringify(near && near.score));
    check('3.2 زمن بعيد (45د) → تخفيض صريح (' + (mid && mid.score) + ' < ' + (near && near.score) + ')', !!mid && mid.score < near.score && mid.level === 'low');
    check('3.3 زمن أبعد من نافذة الدليل (90د) → يهبط دون حد العرض', far === null, JSON.stringify(far));
}

// ── 4) نفس النوع + موقع + زمن متقارب → رفع ──
console.log('4) نفس النوع + موقع + زمن متقارب:');
{
    const a = inc('2031', { lat: L0.lat, lng: L0.lng, min: 0, type: 'traffic', code: '29B05U' });
    const withType = DD.scorePair(inc('2032', { lat: L0.lat + 0.0027, lng: L0.lng, min: 20, type: 'traffic', code: '29B05U' }), a); // ~300م: 15+12+8
    const noType = DD.scorePair(inc('2033', { lat: L0.lat + 0.0027, lng: L0.lng, min: 20, type: 'medical', code: '10D04' }), a);    // 15+12
    check('4.1 مع النوع → يعبر حد العرض (35 ≥ low)', !!withType && withType.score === 35 && withType.level === 'low', JSON.stringify(withType));
    check('4.2 بلا النوع → أقل ودون حد العرض (رفع حقيقي صنعه النوع)', noType === null, JSON.stringify(noType));
}

// ── 5) بيانات ناقصة → لا ادعاء ──
console.log('5) بيانات ناقصة:');
{
    const a = inc('2041', { min: 0 }); // بلا هاتف/إحداثيات
    check('5.1 بلا هاتف + بلا إحداثيات الطرفين + بلا زمن ← لا تنبيه',
        DD.scorePair(inc('2042', {}), { number: '2043' }) === null);
    check('5.2 بلا هاتف + إحداثيات + بلا زمن الطرفين (25 < low) ← لا تنبيه',
        DD.scorePair(inc('2044', { lat: L0.lat + 0.0005, lng: L0.lng, min: null }), inc('2045', { ...L0, min: null })) === null);
    check('5.3 بلا هاتف + زمن فقط (20 < low) ← لا تنبيه',
        DD.scorePair(inc('2046', { min: 8 }), a) === null);
    check('5.4 بلاغ بلا إحداثية لا يُخمَّن موقعه (لا دليل مسافة)',
        !DD.scorePair(inc('2047', { phone: '0551112222' }), inc('2048', { phone: '0551112222' })) ||
        !DD.scorePair(inc('2047', { phone: '0551112222' }), inc('2048', { phone: '0551112222' })).evidence.some(e => e.key === 'distance'));
}

// ── 6) الملغى في CAD مرشح موسوم ──
console.log('6) البلاغ الملغى في CAD:');
{
    const aActive = inc('2051', { phone: '0545451083', ...L0, min: 0 });
    const aCanc = inc('2051', { phone: '0545451083', ...L0, min: 0, status: 'cancelled' });
    const b = inc('2052', { phone: '0545451083', lat: L0.lat + 0.00036, lng: L0.lng, min: 4 });
    const rA = DD.scorePair(b, aActive), rC = DD.scorePair(b, aCanc);
    check('6.1 الملغى يبقى مرشحًا صالحًا', !!rC);
    check('6.2 موسوم cancelledInCad=true', !!rC && rC.cancelledInCad === true && rA.cancelledInCad === false);
    check('6.3 الإلغاء لا يضيف ولا يخصم نقاطًا (ليس دليلًا)', !!rA && !!rC && rA.score === rC.score, (rA && rA.score) + ' vs ' + (rC && rC.score));
}

// ── 7) لا تطابق → لا تنبيه ──
console.log('7) لا تطابق إطلاقًا:');
{
    const a = inc('2061', { phone: '0501111111', ...L0, min: 0, type: 'traffic' });
    const b = inc('2062', { phone: '0509999999', lat: L0.lat + 0.03, lng: L0.lng + 0.03, min: 300, type: 'medical' }); // ~4كم و5 ساعات
    check('7.1 بعيد مكانيًا وزمنيًا وبلا مبلغ ← null', DD.scorePair(b, a) === null);
    check('7.2 نفس الموقع لكن أرقام مختلفة وزمن فوق نافذة الدليل (70د) ← null',
        DD.scorePair(inc('2063', { phone: '0509999999', ...L0, min: 70 }), a) === null);
}

// ── 8) عدة مرشحين ──
console.log('8) أكثر من بلاغ محتمل:');
{
    const A = inc('2071', { phone: '0531111111', ...L0, min: 0 });
    const B = inc('2072', { phone: '0531111111', lat: L0.lat + 0.0003, lng: L0.lng, min: 5 });
    const C = inc('2073', { phone: '0531111111', lat: L0.lat + 0.0006, lng: L0.lng, min: 9 });
    const pairs = DD.findDuplicates([A, B, C]); // مرتبة تصاعديًا زمنيًا
    const forC = pairs.filter(p => p.number === '2073');
    check('8.1 الأحدث (C) يرى المرشحين الاثنين', forC.length === 2, JSON.stringify(pairs.map(p => p.number + '→' + p.candidate.number)));
    check('8.2 مرتبة بالنقاط تنازليًا والأقرب أولًا', forC.length === 2 && forC[0].score >= forC[1].score && forC[0].candidate.number === '2072');
    check('8.3 لا ازدواج معكوس (A لا تُنبَّه على B)', pairs.filter(p => p.number === '2071').length === 0);
}

// ── عبور النافذة + عدم العبث بالمدخلات ──
console.log('+) النافذة والنقاء:');
{
    const A = inc('2081', { phone: '0531111111', ...L0, min: 0 });
    const B = inc('2082', { phone: '0531111111', ...L0, min: 400 }); // 6.7 ساعة > نافذة 6س
    check('+.1 خارج نافذة المقارنة (6س) لا يُقارن', DD.findDuplicates([A, B]).length === 0);
    const frozen = [Object.freeze({ ...A }), Object.freeze({ ...inc('2083', { phone: '0531111111', lat: L0.lat + 0.0003, lng: L0.lng, min: 5 }) })];
    let threw = false;
    try { DD.findDuplicates(frozen); } catch (e) { threw = true; }
    check('+.2 المحرك لا يعدّل مدخلاته (نقي تمامًا)', !threw);
}

/* ═══════════════ الجزء ② — التكامل على خادم معزول ═══════════════ */
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'dupdet-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'dupdet-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3115;
const BASE = 'http://127.0.0.1:' + PORT;

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
    console.log('\n🧪 الجزء ② — التكامل على خادم معزول:\n');
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    const TEST_KEY = 'dupkey-' + STAMP;
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار التكرار', active: true, createdAt: new Date().toISOString() }
    ]));
    // مناوبة نشطة مبذورة في النسخة المعزولة (لا يمس الأصلية إطلاقًا)
    const seed = new Database(TMP_DB);
    seed.prepare(`INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, shift_day, start_time, total_reports, status)
                  VALUES (?, 'مناوبة اختبار التكرار', '2026-08-24', '07:00', 'صباح', 'اختبار', '2026-08-24T07:00:00.000Z', 0, 'active')`)
        .run(900000000 + (STAMP % 1000000));
    seed.close();

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
        const s0 = (await sum()).data;
        const c0 = u => (s0.byCrew && s0.byCrew[u]) || 0;
        const t0 = ty => (s0.byType && s0.byType[ty]) || 0;

        // ── سيناريو رئيسي: بلاغان بنفس المبلغ وموقع قريب وزمن متقارب ──
        console.log('📍 بلاغان متطابقا المبلغ وقريبان (40م / 5د):');
        const mk = (number, latOff, time, extra = {}) => ({
            number, code: '29B05U', type: 'traffic', createdAt: time,
            callerNumber: '0545451083', description: 'حادث مروري — اصطدام مركبتين',
            lat: L0.lat + latOff, lng: L0.lng,
            crews: [{ team: extra.team || 'جنوب 8', phases: { 'التحرك': '10:01:00 AM' } }],
            ...(extra.status ? { status: extra.status } : {})
        });
        const rA = await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: mk('1500001', 0, '24/8/2026 10:00:00 AM') });
        check('②.1 البلاغ الأول أُنشئ', rA.status === 200 && rA.data.created === true, JSON.stringify(rA.data));
        const rB = await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: mk('1500002', 0.00036, '24/8/2026 10:05:00 AM', { team: 'جنوب 4' }) });
        check('②.2 البلاغ الثاني أُنشئ (لا دمج ولا منع — القرار في CAD)', rB.status === 200 && rB.data.created === true);

        let s = (await sum()).data;
        const dA = s.incidents.find(i => i.number === '1500001');
        const dB = s.incidents.find(i => i.number === '1500002');
        check('②.3 الأحدث (1500002) يحمل تنبيهًا واحدًا مرشحه 1500001 بمستوى high',
            !!dB && Array.isArray(dB.duplicates) && dB.duplicates.length === 1 &&
            dB.duplicates[0].candidate.number === '1500001' && dB.duplicates[0].level === 'high',
            JSON.stringify(dB && dB.duplicates));
        check('②.4 الأقدم لا يُنبَّه (اتجاه واحد: الأحدث ← الأقدم)', !!dA && dA.duplicates.length === 0);
        check('②.5 الأدلة تشمل المبلغ/المسافة/الزمن/النوع',
            !!dB && ['caller', 'distance', 'time', 'type'].every(k => dB.duplicates[0].evidence.some(e => e.key === k)));

        // ── الخصوصية: رقم المبلغ لا يظهر في أي استجابة ──
        console.log('🔒 الخصوصية:');
        const raw = JSON.stringify(s);
        check('②.6 رقم المبلغ غير موجود في استجابة الملخص إطلاقًا', !raw.includes('0545451083') && !raw.includes('545451083'));

        // ── ⑨ لا تأثير على العدّادات ──
        console.log('⑨ عدم التأثير على العدّادات:');
        check('9.1 الإجمالي = +2 بالضبط (بلاغان فريدان — التكرار المحتمل لا يدمج)',
            s.total === s0.total + 2, 'total=' + s.total + ' baseline=' + s0.total);
        check('9.2 byType.traffic = +2 (كل بلاغ مصنف مرة)', s.byType.traffic === t0('traffic') + 2);
        check('9.3 byCrew: جنوب 8 = +1 وجنوب 4 = +1 (المشاركات لا تتأثر)',
            (s.byCrew['جنوب 8'] || 0) === c0('جنوب 8') + 1 && (s.byCrew['جنوب 4'] || 0) === c0('جنوب 4') + 1);

        // ── الملغى مرشح موسوم ──
        console.log('⛔ مرشح ملغى في CAD:');
        await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: mk('1500003', 0.0002, '24/8/2026 10:10:00 AM', { team: 'جنوب 5', status: 'cancelled' }) });
        await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: mk('1500004', 0.0005, '24/8/2026 10:14:00 AM', { team: 'جنوب 6' }) });
        s = (await sum()).data;
        const dD = s.incidents.find(i => i.number === '1500004');
        const cancCand = dD && dD.duplicates.find(x => x.candidate.number === '1500003');
        check('②.7 الملغى (1500003) يظهر مرشحًا موسومًا cancelledInCad', !!cancCand && cancCand.cancelledInCad === true, JSON.stringify(dD && dD.duplicates));
        check('②.8 الملغى يبقى في التاريخ (total=+4 ولم يُحذف)', s.total === s0.total + 4);

        // ── استكمال متأخر بلا مسّ للموجود ──
        console.log('🧩 الاستكمال المتأخر:');
        await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: { number: '1500005', type: 'medical', crews: [{ team: 'جنوب 7', phases: { 'التحرك': '10:20:00 AM' } }] } });
        await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: { number: '1500005', callerNumber: '0501234567', description: 'وصف متأخر', crews: [{ team: 'جنوب 7' }] } });
        await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: { number: '1500005', callerNumber: '0599999999', crews: [{ team: 'جنوب 7' }] } }); // محاولة استبدال
        const probe = new Database(TMP_DB, { readonly: true });
        const row5 = probe.prepare("SELECT caller_number, description FROM incident_registry WHERE number = '1500005'").get();
        probe.close();
        check('②.9 الرقم المتأخر استُكمل', !!row5 && row5.caller_number === '0501234567', JSON.stringify(row5));
        check('②.10 الموجود لا يُمس (محاولة الاستبدال رُفضت صامتًا)', !!row5 && row5.caller_number !== '0599999999');
        check('②.11 الوصف المتأخر استُكمل', !!row5 && row5.description === 'وصف متأخر');

        // ── تعقيم المدخل ──
        console.log('🛡️ التعقيم:');
        await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: { number: '1500006', callerNumber: '+966 (50) 111-2222 abc', crews: [{ team: 'جنوب 7', phases: { 'التحرك': '10:30:00 AM' } }] } });
        const probe2 = new Database(TMP_DB, { readonly: true });
        const row6 = probe2.prepare("SELECT caller_number FROM incident_registry WHERE number = '1500006'").get();
        probe2.close();
        check('②.12 الرقم يُخزَّن معقّمًا (أرقام/+ فقط)', !!row6 && row6.caller_number === '+966501112222', JSON.stringify(row6));
    } catch (e) {
        failed++; failures.push('fatal: ' + e.message);
        console.error('❌ خطأ فادح: ' + e.message);
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }

    console.log('\n════════════════════════════');
    console.log('النتيجة: ' + passed + ' ✅ / ' + (passed + failed) + (failed ? ' — فشل: ' + failures.join(' | ') : ' — الكل ناجح'));
    process.exit(failed ? 1 : 0);
})();
