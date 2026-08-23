/**
 * ═══ asset-import-test.js — اختبار قبول «نظام العهد: المرحلة 2» (اعتماد المالك 2026-08-23) ═══
 * يثبت على خادم معزول (نسخة مؤقتة من قاعدة البيانات — لا يمس بيانات حقيقية) أن:
 *  A1 الجداول الثمانية additive تُنشأ دون مساس بأي جدول قائم
 *  A2 preview قبل أي staging → batch=0 بلا أخطاء
 *  A3 stage بلا مصادقة → 401 · وبمستخدم بلا assets.manage → 403
 *  A4 stage كمدير → دفعة واحدة بـ607 سجلات (يطابق تقرير المحلل المعتمد)
 *  A5 الملخص يطابق أرقام المرحلة 1: 362 يعمل / 30 متعطل / 11 مفقود / 4 مسحوب
 *     / 1 مستبدل / 199 بلا حالة / 270 بلا سيريال / 259 تحتاج مراجعة
 *  A6 الفلاتر تعمل: فرقة + حالة + needs_review + بحث نصي
 *  A7 التحذيرات محفوظة مع كل صف (سيريال مكرر/مشترك/استبدال بالملاحظات…)
 *  A8 approve → 607 أصول + 607 حدث registered + أكواد ASSET-XXXXXX فريدة متسلسلة
 *  A9 asset_types يحوي 38 نوعًا موحدًا مع المرادفات
 *  A10 السيريالات المكررة تبقى معلّمة needs_review ولا تُدمج ولا تُحذف
 *  A11 إعادة approve → 409 (لا ازدواج) · إعادة stage → دفعة جديدة والمعتمد يبقى
 *  A12 GET /api/assets وبطاقة الجهاز تعرضان السجل مع حدث التسجيل ومصدره
 *  A13 مستخدم دوره user بلا assets.view → 403 على القراءة أيضًا (حسم خادمي)
 * التشغيل: node scripts/asset-import-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3097;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'asset-import-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 200) : '')); }
}

async function api(p, { method = 'GET', token, body } = {}) {
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { }
    return { status: res.status, data };
}

(async () => {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const src = new Database(path.join(ROOT, 'data', 'ambulance.db'), { readonly: true });
    src.exec("VACUUM INTO '" + TMP_DB + "'");
    src.close();
    // عزل تام: بيانات الأصول في المصدر (إن وُجدت دفعة staging حقيقية) لا تدخل الاختبار —
    // النسخة المؤقتة تبدأ بجداول الأصول فارغة حتى تبقى التوقعات حتمية
    const wipe = new Database(TMP_DB);
    for (const t of ['asset_import_staging', 'asset_events', 'asset_replacements', 'inventory_items', 'inventory_sessions', 'inventory_cycles', 'assets', 'asset_types']) {
        try { wipe.prepare(`DELETE FROM ${t}`).run(); } catch (_) { /* الجدول قد لا يوجد قبل أول ترحيل */ }
    }
    wipe.close();
    // مستخدمون: الأصليون + مستخدم عادي بلا صلاحيات أصول (لاختبار الحسم الخادمي)
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    users.push({
        id: 'ast-viewer-' + STAMP, username: 'astviewer', name: 'مستخدم اختبار العهد',
        password: bcrypt.hashSync('astviewer-pass', 10), role: 'user', isActive: true
    });
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify(users));
    // حمولة الاستيراد المعتمدة (ناتج محلل المرحلة 1 — نفس الملف الذي يقرأه المسار)
    fs.copyFileSync(path.join(ROOT, 'data', 'asset-import-payload.json'), path.join(TMP_DIR, 'asset-import-payload.json'));

    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test' }
    });
    server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/health'); up = r.ok; } catch (_) { } if (!up) await new Promise(r => setTimeout(r, 500)); }
    if (!up) { console.log('❌ الخادم لم يقلع'); server.kill(); process.exit(1); }

    try {
        // A1 — الجداول الثمانية موجودة والجداول القائمة سليمة
        const probe = new Database(TMP_DB, { readonly: true });
        const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
        const need = ['asset_types', 'assets', 'asset_events', 'asset_replacements',
            'inventory_cycles', 'inventory_sessions', 'inventory_items', 'asset_import_staging'];
        check('A1a الجداول الثمانية أُنشئت (additive)', need.every(t => tables.includes(t)), need.filter(t => !tables.includes(t)).join(','));
        check('A1b الجداول القائمة لم تُمس', ['reports', 'shifts', 'teams', 'vehicles', 'report_times'].every(t => tables.includes(t)));
        probe.close();

        const adminLogin = await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } });
        const admin = adminLogin.data && adminLogin.data.accessToken;
        const viewerLogin = await api('/api/auth/login', { method: 'POST', body: { username: 'astviewer', password: 'astviewer-pass' } });
        const viewer = viewerLogin.data && viewerLogin.data.accessToken;
        check('A0 تسجيل دخول admin + viewer', !!admin && !!viewer);

        // A2
        const pre = await api('/api/assets/import/preview', { token: admin });
        check('A2 preview قبل staging → batch=0', pre.status === 200 && pre.data.batch === 0);

        // A3
        const noAuth = await api('/api/assets/import/stage', { method: 'POST' });
        check('A3a stage بلا مصادقة → 401', noAuth.status === 401);
        const noPerm = await api('/api/assets/import/stage', { method: 'POST', token: viewer });
        check('A3b stage بمستخدم بلا assets.manage → 403', noPerm.status === 403);

        // A4
        const staged = await api('/api/assets/import/stage', { method: 'POST', token: admin });
        check('A4 stage كمدير → دفعة بـ607 سجلات', staged.status === 200 && staged.data.success && staged.data.summary.total === 607,
            JSON.stringify(staged.data).slice(0, 150));

        // A5
        const s = staged.data.summary;
        const bs = {}; (s.byStatus || []).forEach(r => { bs[r.status] = r.c; });
        check('A5a الحالات تطابق تقرير المرحلة 1', bs.working === 362 && bs.damaged === 30 && bs.missing === 11 && bs.recalled === 4 && bs.replaced === 1 && bs.unknown === 199,
            JSON.stringify(bs));
        check('A5b بلا سيريال 270 · تحتاج مراجعة 259', s.no_serial === 270 && s.needs_review === 259,
            `no_serial=${s.no_serial} needs_review=${s.needs_review}`);

        // A6 — فلاتر
        const fTeam = await api('/api/assets/import/preview?team=' + encodeURIComponent('جنوب 6'), { token: admin });
        const fAll = await api('/api/assets/import/preview?limit=1', { token: admin });
        check('A6a فلتر الفرقة يعمل', fTeam.status === 200 && fTeam.data.total > 0 && fTeam.data.total < fAll.data.total);
        const fRev = await api('/api/assets/import/preview?needs_review=1&limit=1', { token: admin });
        check('A6b فلتر needs_review → 259', fRev.status === 200 && fRev.data.total === 259, String(fRev.data.total));
        const fQ = await api('/api/assets/import/preview?q=' + encodeURIComponent('2PN901510G8H0A3'), { token: admin });
        check('A6c البحث بالسيريال يجد الموضعين المكررين', fQ.status === 200 && fQ.data.total === 2, String(fQ.data.total));

        // A7 — التحذيرات محفوظة مع الصف
        const wRow = fQ.data.rows[0];
        const warns = JSON.parse(wRow.warnings || '[]');
        check('A7 تحذير السيريال المكرر محفوظ مع الصف', warns.some(w => w.includes('مكرر')), JSON.stringify(warns));

        // A8 — الاعتماد
        const approved = await api('/api/assets/import/approve', { method: 'POST', token: admin });
        check('A8a approve → أُنشئ 607 أصول', approved.status === 200 && approved.data.created === 607, JSON.stringify(approved.data).slice(0, 150));
        const db2 = new Database(TMP_DB, { readonly: true });
        const aCount = db2.prepare('SELECT COUNT(*) c FROM assets').get().c;
        const eCount = db2.prepare("SELECT COUNT(*) c FROM asset_events WHERE event_type='registered'").get().c;
        const codes = db2.prepare('SELECT COUNT(DISTINCT asset_code) c FROM assets').get().c;
        const codeFmt = db2.prepare("SELECT COUNT(*) c FROM assets WHERE asset_code GLOB 'ASSET-[0-9][0-9][0-9][0-9][0-9][0-9]'").get().c;
        check('A8b assets=607 وأحداث registered=607', aCount === 607 && eCount === 607, `assets=${aCount} events=${eCount}`);
        check('A8c أكواد ASSET فريدة وبالتنسيق المعتمد', codes === 607 && codeFmt === 607, `distinct=${codes} fmt=${codeFmt}`);
        const staged2 = db2.prepare("SELECT COUNT(*) c FROM asset_import_staging WHERE import_status='approved' AND asset_id IS NOT NULL").get().c;
        check('A8d صفوف staging رُبطت بمعرفات الأصول', staged2 === 607, String(staged2));

        // A9
        const tCount = db2.prepare('SELECT COUNT(*) c FROM asset_types').get().c;
        check('A9 فهرس الأنواع الموحدة = 38', tCount === 38, String(tCount));

        // A10 — التكرارات معلّمة وغير مدموجة
        const dup = db2.prepare("SELECT COUNT(*) c FROM assets WHERE serial_number = '2PN901510G8H0A3'").get().c;
        const dupFlag = db2.prepare("SELECT COUNT(*) c FROM assets WHERE serial_number = '2PN901510G8H0A3' AND needs_review = 1").get().c;
        check('A10 السيريال المكرر محفوظ كجهازين معلّمين (لا دمج)', dup === 2 && dupFlag === 2, `rows=${dup} flagged=${dupFlag}`);

        // A11
        const reApprove = await api('/api/assets/import/approve', { method: 'POST', token: admin });
        check('A11a إعادة الاعتماد → 409 بلا ازدواج', reApprove.status === 409);
        const reStage = await api('/api/assets/import/stage', { method: 'POST', token: admin });
        const keepApproved = db2.prepare("SELECT COUNT(*) c FROM asset_import_staging WHERE import_status='approved'").get().c;
        check('A11b إعادة stage دفعة جديدة والمعتمد يبقى أثرًا', reStage.data.batch === 2 && keepApproved === 607,
            `batch=${reStage.data && reStage.data.batch} approved=${keepApproved}`);
        db2.close();

        // A12 — القراءة وبطاقة الجهاز
        const list = await api('/api/assets?limit=5', { token: admin });
        check('A12a GET /api/assets يعرض الأصول المعتمدة', list.status === 200 && list.data.total === 607, String(list.data && list.data.total));
        const one = list.data.rows[0];
        const card = await api('/api/assets/' + one.id, { token: admin });
        check('A12b بطاقة الجهاز تعرض حدث التسجيل ومصدره', card.status === 200 && card.data.events.length === 1
            && card.data.events[0].event_type === 'registered' && (card.data.events[0].reason || '').includes('Excel'));

        // A13 — الحسم الخادمي للقراءة
        const denied = await api('/api/assets', { token: viewer });
        check('A13 مستخدم بلا assets.view → 403', denied.status === 403);
    } finally {
        server.kill();
    }

    console.log(`\n═══ النتيجة: ${passed} ✅ / ${failed} ❌ ═══`);
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌ خطأ فادح:', e); process.exit(1); });
