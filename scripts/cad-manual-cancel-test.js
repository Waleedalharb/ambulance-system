/**
 * ═══ اختبار الإلغاء اليدوي لمشاركة فرقة — cad-manual-cancel-test.js ═══
 * (اعتماد المالك 2026-08-24 — جولة Observer): من توزيع البلاغات يمكن إلغاء
 * مشاركة فرقة سُجّلت بالخطأ: تُعلَّم manual_cancelled فتُستبعد فورًا من كل
 * العدّادات والمؤشرات التشغيلية (byCrew/أزمنة الاستجابة/نشاط الفرق) — بلا حذف:
 * السجل يبقى في التفاصيل والتدقيق مع الفاعل والوقت والسبب، والاستعادة ترفع
 * الاستبعاد وتحتفظ بأثر الإلغاء. معزول كاملًا: VACUUM INTO + DATA_DIR مؤقت.
 * التشغيل: node scripts/cad-manual-cancel-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SRC_DB = path.join(ROOT, 'data', 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'mancancel-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'mancancel-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3101;
const BASE = 'http://127.0.0.1:' + PORT;
const INC = '9001';

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
const crewUrl = (unit, action) => '/api/cad-reports/' + INC + '/crews/' + encodeURIComponent(unit) + '/' + action;

(async () => {
    console.log('📋 عزل كامل: قاعدة مؤقتة + DATA_DIR مؤقت...');
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const bcrypt = require(path.join(ROOT, 'node_modules', 'bcryptjs'));
    const src = new Database(SRC_DB, { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    users.push({ id: 'mc-viewer-' + STAMP, username: 'mcviewer', name: 'مستخدم بلا صلاحية توزيع',
        password: bcrypt.hashSync('mcviewer-pass', 10), role: 'user', isActive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify(users));
    const TEST_KEY = 'mckey-' + STAMP;
    fs.writeFileSync(path.join(TMP_DIR, 'integration-keys.json'), JSON.stringify([
        { key: TEST_KEY, scope: 'cad-reports', label: 'اختبار', active: true, createdAt: new Date().toISOString() }
    ]));

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.error('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        const admin = (await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } })).data.accessToken;
        const viewer = (await api('/api/auth/login', { method: 'POST', body: { username: 'mcviewer', password: 'mcviewer-pass' } })).data.accessToken;
        check('S0 دخول admin + viewer', !!admin && !!viewer);

        // مناوبة نشطة إلزامية للمسار — نبدأ واحدة إن غابت في النسخة
        const probe = new Database(TMP_DB, { readonly: true });
        const active = probe.prepare("SELECT id FROM shifts WHERE status='active' ORDER BY id DESC LIMIT 1").get();
        probe.close();
        if (!active) {
            const st = await api('/api/start-new-shift', { method: 'POST', token: admin, body: { shiftType: 'صباح' } });
            check('S0b بدء مناوبة اختبار', st.status === 200 && st.data && st.data.success !== false, JSON.stringify(st.data).slice(0, 120));
        }

        // S1: بلاغ CAD بفرقتين محتسبتين (لكلتيهما «التحرك» — قاعدة الاحتساب)
        // أسماء فرق وهمية فريدة (2026-08-24): النسخة تحمل بيانات المناوبة الحقيقية —
        // «جنوب 1/2» الحقيقيتان قد تملكان مشاركات فعلية تلوّث فحوص /api/data
        const UNIT_A = 'اختبار جنوب 901', UNIT_B = 'اختبار جنوب 902';
        const reg = await api('/api/cad-reports', { method: 'POST', key: TEST_KEY, body: {
            number: INC, code: '30A01', type: 'injury', createdAt: '8/24/2026 10:00:00 AM',
            crews: [
                { team: UNIT_A, phases: { 'التحرك': '10:07:11 AM', 'البحث': '10:13:16 AM', 'العلاج': '10:20:56 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: true, cadUnitId: 11, cadRunUnitId: 1101 },
                { team: UNIT_B, phases: { 'التحرك': '10:02:47 AM', 'البحث': '10:03:13 AM' }, phasesSource: 'cad-detail', cadUrs: 'A', cadReached: false, cadUnitId: 12, cadRunUnitId: 1201 }
            ] } });
        check('S1 تسجيل بلاغ بفرقتين عبر مفتاح التكامل', reg.status === 200 && reg.data.success === true, JSON.stringify(reg.data).slice(0, 150));

        const sum1 = await api('/api/cad-reports', { token: admin });
        const inc1 = sum1.data.incidents.find(i => i.number === INC);
        check('S1b byCrew: كلتا الفرقتين محتسبتان', sum1.data.byCrew[UNIT_A] === 1 && sum1.data.byCrew[UNIT_B] === 1, JSON.stringify(sum1.data.byCrew));
        check('S1c البلاغ يدخل مؤشر الزمن بأسرع وصول بين فرقه (3.4 د)', inc1 && Math.abs(inc1.bestArrivalMin - 3.4) < 0.2, 'bestArrivalMin=' + (inc1 && inc1.bestArrivalMin));

        // S1d: توحيد قاعدة الاحتساب (قرار المالك 2026-08-24) — /api/data و/api/shifts/:id
        // يشتقان من نفس القاعدة: كلتا الفرقتين ظاهرتان قبل أي إلغاء
        const data1 = await api('/api/data', { token: admin });
        const shiftId1 = data1.data && data1.data.currentShiftId;
        check('S1d /api/data: الفرقتان محتسبتان من نفس القاعدة',
            data1.data && data1.data.data && data1.data.data['CAD|' + UNIT_A] && data1.data.data['CAD|' + UNIT_A].count === 1 &&
            data1.data.data['CAD|' + UNIT_B] && data1.data.data['CAD|' + UNIT_B].count === 1,
            JSON.stringify({ a: data1.data && data1.data.data && data1.data.data['CAD|' + UNIT_A], b: data1.data && data1.data.data && data1.data.data['CAD|' + UNIT_B] }).slice(0, 200));
        const sh1 = shiftId1 ? await api('/api/shifts/' + shiftId1, { token: admin }) : { status: 0, data: null };
        check('S1e /api/shifts/:id: الفرقتان محتسبتان في عرض الأرشيف',
            sh1.status === 200 && sh1.data.reports['CAD|' + UNIT_A] && sh1.data.reports['CAD|' + UNIT_A].count === 1 &&
            sh1.data.reports['CAD|' + UNIT_B] && sh1.data.reports['CAD|' + UNIT_B].count === 1,
            'status=' + sh1.status);

        // S2: الحسم الخادمي — بلا ops.dispatch ← 403
        const denied = await api(crewUrl(UNIT_B, 'cancel'), { method: 'POST', token: viewer, body: { reason: 'محاولة' } });
        check('S2 مستخدم بلا ops.dispatch ← 403', denied.status === 403, 'status=' + denied.status);

        // S3: الإلغاء اليدوي للفرقة B
        const cancel = await api(crewUrl(UNIT_B, 'cancel'), { method: 'POST', token: admin, body: { reason: 'سُجّلت بالخطأ' } });
        check('S3 إلغاء مشاركة B ← success', cancel.status === 200 && cancel.data.success === true && cancel.data.already === false);

        const sum2 = await api('/api/cad-reports', { token: admin });
        const inc2 = sum2.data.incidents.find(i => i.number === INC);
        const crew2 = inc2 && inc2.crews.find(c => c.unit === UNIT_B);
        check('S4a الملغاة خرجت فورًا من byCrew', sum2.data.byCrew[UNIT_B] === undefined && sum2.data.byCrew[UNIT_A] === 1);
        check('S4b الملغاة خرجت من مؤشر الزمن (أصبح 13.3 د للفرقة A)', inc2 && Math.abs(inc2.bestArrivalMin - 13.3) < 0.2, 'bestArrivalMin=' + (inc2 && inc2.bestArrivalMin));
        check('S4c الملغاة تبقى في التفاصيل موسومة: manualCancelled + الفاعل + السبب',
            crew2 && crew2.manualCancelled === true && !!crew2.manualCancelledBy && crew2.manualCancelReason === 'سُجّلت بالخطأ');
        check('S4d إجمالي البلاغات لم يتغير (البلاغ بلاغ واحد مهما أُلغيت فرقه)', sum2.data.incidentsCount === sum1.data.incidentsCount);

        // S4e/S4f: الاستبعاد موحد في كل مصادر تقرير المناوبة (قرار المالك 2026-08-24):
        // /api/data و/api/shifts/:id لا تعرضان الملغاة — نفس قاعدة byCrew بالضبط
        const data2 = await api('/api/data', { token: admin });
        const rowA2 = data2.data && data2.data.data && data2.data.data['CAD|' + UNIT_A];
        const rowB2 = data2.data && data2.data.data && data2.data.data['CAD|' + UNIT_B];
        check('S4e /api/data: الملغاة خارج العدّ (A=1، B=0)', rowA2 && rowA2.count === 1 && rowB2 && rowB2.count === 0,
            JSON.stringify({ a: rowA2 && rowA2.count, b: rowB2 && rowB2.count }));
        const sh2 = await api('/api/shifts/' + shiftId1, { token: admin });
        const shA2 = sh2.data && sh2.data.reports['CAD|' + UNIT_A];
        const shB2 = sh2.data && sh2.data.reports['CAD|' + UNIT_B];
        check('S4f /api/shifts/:id: الملغاة خارج العدّ (A=1، B=0)', shA2 && shA2.count === 1 && shB2 && shB2.count === 0,
            JSON.stringify({ a: shA2 && shA2.count, b: shB2 && shB2.count }));

        // S5: idempotent — إعادة الإلغاء بلا أثر مكرر
        const again = await api(crewUrl(UNIT_B, 'cancel'), { method: 'POST', token: admin, body: {} });
        check('S5 إعادة إلغاء الملغاة ← already=true بلا تكرار', again.status === 200 && again.data.already === true);

        // S6: إلغاء الفرقة الثانية — البلاغ بلا أي مشاركة محتسبة
        await api(crewUrl(UNIT_A, 'cancel'), { method: 'POST', token: admin, body: {} });
        const sum3 = await api('/api/cad-reports', { token: admin });
        const inc3 = sum3.data.incidents.find(i => i.number === INC);
        check('S6 إلغاء الفرقتين ← byCrew فارغة للبلاغ ومؤشر الزمن null', !sum3.data.byCrew[UNIT_A] && !sum3.data.byCrew[UNIT_B] && inc3 && inc3.bestArrivalMin === null);

        // S7: الاستعادة ترفع الاستبعاد وتحتفظ بأثر الإلغاء
        const restore = await api(crewUrl(UNIT_B, 'restore'), { method: 'POST', token: admin, body: {} });
        check('S7a استعادة B ← restored=true مع أثر الإلغاء السابق', restore.status === 200 && restore.data.restored === true && !!(restore.data.previousCancel && restore.data.previousCancel.by));
        const sum4 = await api('/api/cad-reports', { token: admin });
        check('S7b المستعادة عادت للعدّادات فورًا (byCrew=1 والزمن 3.4 د)', sum4.data.byCrew[UNIT_B] === 1 &&
            Math.abs(sum4.data.incidents.find(i => i.number === INC).bestArrivalMin - 3.4) < 0.2);

        // S7c: الاستعادة تعيد الفرقة إلى /api/data فورًا — بلا سجل مشاركة جديد
        const data3 = await api('/api/data', { token: admin });
        const rowB3 = data3.data && data3.data.data && data3.data.data['CAD|' + UNIT_B];
        check('S7c /api/data: المستعادة عادت (B=1)', rowB3 && rowB3.count === 1, 'count=' + (rowB3 && rowB3.count));

        // S8: فرقة غير مشاركة ← 404 صادق
        const nf = await api(crewUrl('اختبار جنوب 999', 'cancel'), { method: 'POST', token: admin, body: {} });
        check('S8 إلغاء فرقة بلا مشاركة ← 404', nf.status === 404, 'status=' + nf.status);

        // S9: لا حذف إطلاقًا + التدقيق موثق (DB مباشرة)
        const db = new Database(TMP_DB, { readonly: true });
        const rows = db.prepare(`SELECT rt.manual_cancelled, rt.manual_cancelled_by, r.unit
                                 FROM report_times rt JOIN reports r ON r.id = rt.report_id
                                 WHERE rt.incident_number = ?`).all(INC);
        check('S9a سجلا المشاركتين محفوظان (لا حذف فعلي)', rows.length === 2);
        const r2 = rows.find(r => r.unit === UNIT_B);
        check('S9b المستعادة: manual_cancelled=0 مع بقاء اسم من ألغى (التاريخ محفوظ)', r2 && r2.manual_cancelled === 0 && !!r2.manual_cancelled_by);
        const audC = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='cad_crew_manual_cancel' AND detail LIKE '%' || ? || '%'").get(INC).c;
        const audR = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='cad_crew_manual_restore'").get().c;
        check('S9c التدقيق: قيدا إلغاء بالضبط (الإعادة لم تكرر) + قيد استعادة', audC === 2 && audR === 1, 'cancel=' + audC + ' restore=' + audR);
        // S10: فلتر الاستبعاد نفسه مثبت على الاستعلام الخام (نشاط الفرق/المؤشرات)
        // مقيّد ببلاغ الاختبار — النسخة تحمل إلغاءات حقيقية من الاختبار الحي (2026-08-24)
        const withCancelled = db.prepare(`SELECT COUNT(*) c FROM report_times rt
            WHERE rt.incident_number = ?`).get(INC).c;
        const withoutCancelled = db.prepare(`SELECT COUNT(*) c FROM report_times rt
            WHERE rt.incident_number = ? AND COALESCE(rt.manual_cancelled, 0) = 0`).get(INC).c;
        check('S10 فلتر COALESCE(manual_cancelled,0)=0 يستبعد الملغاة من الاستعلامات الخام', withCancelled === 2 && withoutCancelled === 1, withCancelled + '/' + withoutCancelled);
        db.close();
    } finally {
        server.kill();
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.unlinkSync(TMP_DB); } catch (_) { }
    }

    console.log('\n═══ النتيجة: ' + passed + ' ✅ / ' + failed + ' ❌ ═══');
    if (failed) { console.log('الفاشلة:'); failures.forEach(f => console.log('  ❌ ' + f)); process.exit(1); }
})().catch(e => { console.error('💥 خطأ غير متوقع:', e); process.exit(1); });
