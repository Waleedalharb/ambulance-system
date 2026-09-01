/**
 * ═══ map-history-traceability-test.js — اختبار تتبع كثافة ذاكرة الخريطة ═══
 * (اعتماد المالك 2026-08-25 — «كل رقم كثافة قابل للتتبع: 8 ← أرقام البلاغات ← بياناتها»)
 * يثبت على خادم معزول (نسخة مؤقتة من قاعدة البيانات — لا يمس بيانات حقيقية):
 *  T1 كل بلاغ في coverage.incidents يحمل حقول البطاقة (number/type/status/
 *     cadCreatedAt/countedUnits) — الغائب null صادق لا مخترع
 *  T2 كل منطقة طلب تكشف incidentNumbers: طولها = count، وأرقامها فريدة، وكل
 *     رقم يحلّ إلى بلاغ فعلي محدد الموقع في incidents[] — لا رقم بلا مصدر
 *  T3 البلاغ بلا إحداثية: noCoords=true ولا يدخل أي منطقة إطلاقًا (لا تخمين)
 *  T4 ثلاثة بلاغات في نفس الخلية (~0.01°) تكوّن منطقة واحدة تتضمنها صراحة
 *  T5 اتساق الإجماليات: positioned + noCoords = incidents
 *  T6 الأقفال البنيوية للواجهة: طبقة النقاط القابلة للضغط + بطاقة البلاغ +
 *     قائمة المنطقة + «غير متوفر» الصادقة + عزل الذاكرة عن الحية
 * التشغيل: node scripts/map-history-traceability-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3099;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'map-hist-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');
const TEST_KEY = 'maphist-' + STAMP;

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 200) : '')); }
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
const post = (key, body) => api('/api/cad-reports', { method: 'POST', key, body });
function todayCad(time) {
    const d = new Date();
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + time;
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.copyFileSync(path.join(ROOT, 'data', 'users.json'), path.join(TMP_DIR, 'users.json'));
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار تتبع الكثافة', active: true, createdAt: new Date().toISOString() }
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

        // ثلاثة بلاغات في نفس الخلية (~0.01°) + واحد بعيد منفرد + واحد بلا إحداثيات
        const Z = ['92000101', '92000102', '92000103'];
        const F1 = '92000111', NC = '92000121';
        const crew = [{ team: 'جنوب 1', phases: { 'التحرك': '10:01:00 AM', 'البحث': '10:07:00 AM' } }];
        for (let i = 0; i < Z.length; i++) {
            await post(TEST_KEY, {
                number: Z[i], type: 'medical', createdAt: todayCad('10:0' + i + ':00 AM'),
                lat: 24.7000 + i * 0.0001, lng: 46.7000 + i * 0.0001, crews: crew
            });
        }
        await post(TEST_KEY, { number: F1, type: 'traffic', createdAt: todayCad('11:00:00 AM'), lat: 24.95, lng: 46.95, crews: crew });
        await post(TEST_KEY, { number: NC, type: 'other', createdAt: todayCad('12:00:00 PM'), crews: crew }); // بلا إحداثيات

        const cov = await api('/api/analytics/coverage?from=2020-01-01&to=2099-12-31', { token: TK }).then(r => r.data);
        if (!cov || !cov.incidents) { console.log('❌ coverage لم تُرجع بيانات'); throw new Error('coverage'); }
        const incByNum = {};
        cov.incidents.forEach(d => { incByNum[d.number] = d; });
        const ours = Z.concat([F1, NC]);

        console.log('\n— T1: حقول بطاقة البلاغ متوفرة لكل بلاغ —');
        check('T1① بلاغات الاختبار الخمسة كلها في incidents[]', ours.every(n => incByNum[n]));
        // RC-6: الحمولة خفيفة (نقاط الخريطة) والتفصيل الكامل عبر incident-detail عند الطلب
        check('T1② الحمولة الخفيفة تحمل number/shiftId/lat/lng/type/cadCreatedAt/district',
            ours.every(n => {
                const d = incByNum[n];
                return d && 'type' in d && 'shiftId' in d && 'cadCreatedAt' in d && 'district' in d && 'lat' in d && 'lng' in d;
            }));
        check('T1②-ب الحمولة الخفيفة لا تشمل الحقول الثقيلة (countedUnits/bestArrivalMin خارجها)',
            ours.every(n => incByNum[n] && !('countedUnits' in incByNum[n]) && !('bestArrivalMin' in incByNum[n])));
        // التفصيل الكامل للبطاقة يُجلب عند فتحها — نفس الحقول التي كانت مسبقة
        const det = await api('/api/analytics/incident-detail?from=2020-01-01&to=2099-12-31&shiftId='
            + encodeURIComponent(incByNum[Z[0]].shiftId) + '&number=' + Z[0], { token: TK }).then(r => r.data && r.data.incident);
        check('T1③ incident-detail يعيد النوع والحالة صادقين من المصدر (medical/active)',
            det && det.type === 'medical' && det.status === 'active');
        check('T1④ الفرقة المحتسبة ظاهرة في التفصيل (جنوب 1 تحركت)', det && det.countedUnits.includes('جنوب 1'));
        check('T1⑤ أفضل زمن وصول اشتُق من المراحل (٧ دقائق: إنشاء 10:00 ← بحث 10:07)', det && det.bestArrivalMin === 7, String(det && det.bestArrivalMin));
        const detNc = await api('/api/analytics/incident-detail?from=2020-01-01&to=2099-12-31&shiftId='
            + encodeURIComponent(incByNum[NC].shiftId) + '&number=' + NC, { token: TK }).then(r => r.data && r.data.incident);
        check('T1⑤-ب بلاغ بلا إحداثية: بطاقته تجيء بصدق (بلا موقع وبلا تمركز مخترع)',
            detNc && detNc.lat === null && detNc.nearestPositioningAtTime === null);

        console.log('\n— T2: كل منطقة تكشف بلاغاتها الفعلية —');
        check('T2① كل منطقة تحمل incidentNumbers بطول = count',
            cov.zones.every(z => Array.isArray(z.incidentNumbers) && z.incidentNumbers.length === z.count));
        check('T2② أرقام كل منطقة فريدة (لا تكرار داخل العدد)',
            cov.zones.every(z => new Set(z.incidentNumbers).size === z.incidentNumbers.length));
        check('T2③ كل رقم منطقة يحلّ إلى بلاغ فعلي محدد الموقع',
            cov.zones.every(z => z.incidentNumbers.every(n => incByNum[n] && !incByNum[n].noCoords && incByNum[n].lat !== null)));

        console.log('\n— T3: البلاغ بلا إحداثية لا يُخمَّن —');
        check('T3① موسوم noCoords=true بصدق', incByNum[NC] && incByNum[NC].noCoords === true);
        check('T3② لا يظهر في أي منطقة إطلاقًا', cov.zones.every(z => !z.incidentNumbers.includes(NC)));

        console.log('\n— T4: الثلاثة المتقاربة منطقة واحدة تتضمنهم صراحة —');
        const zoneOf = cov.zones.find(z => z.incidentNumbers.includes(Z[0]));
        check('T4① وُجدت منطقة تتضمن البلاغ الأول', !!zoneOf);
        check('T4② نفس المنطقة تتضمن الثلاثة كلهم', zoneOf && Z.every(n => zoneOf.incidentNumbers.includes(n)),
            zoneOf ? JSON.stringify(zoneOf.incidentNumbers) : 'لا منطقة');
        check('T4③ حد المنطقة الأدنى محترم (≥3)', zoneOf && zoneOf.count >= 3);

        console.log('\n— T5: اتساق الإجماليات —');
        const t = cov.totals;
        check('T5① positioned + noCoords = incidents', t.positioned + t.noCoords === t.incidents, t.positioned + '+' + t.noCoords + '≠' + t.incidents);

        console.log('\n— T6: الأقفال البنيوية للواجهة —');
        const histJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'map-history.js'), 'utf8');
        check('T6① طبقة النقاط القابلة للضغط موجودة (dotsFrom)', histJs.includes('function dotsFrom'));
        check('T6② بطاقة البلاغ التاريخية موجودة (incidentCardHtml)', histJs.includes('function incidentCardHtml'));
        check('T6③ قائمة بلاغات المنطقة موجودة (zoneIncListHtml)', histJs.includes('function zoneIncListHtml'));
        check('T6④ الغائب يُعرض «غير متوفر» بلا تخمين', histJs.includes('غير متوفر'));
        check('T6⑤ فتح البطاقة معلن عبر واجهة عامة (MapHistory.openIncident)', histJs.includes('MapHistory.openIncident'));
        check('T6⑥ الذاكرة لا تلمس حالة الخريطة الحية', !histJs.includes('SmartMap'));
        check('T6⑦ بلا إحداثية لا نقطة مختلقة في طبقة النقاط', /!d\.noCoords && d\.lat !== null/.test(histJs) || /noCoords \|\| d\.lat === null/.test(histJs));
    } catch (e) {
        console.error('خطأ عام:', e);
        failed++;
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
    }
    console.log('\n════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح / ' + failed + ' فاشل');
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})();
