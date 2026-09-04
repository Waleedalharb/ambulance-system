/**
 * ═══ assets-discrepancies-test.js — اختبار قبول «المرحلة 5: مركز الفروقات والقرارات» (اعتماد المالك 2026-08-23) ═══
 * على خادم معزول (نسخة مؤقتة — لا يمس بيانات حقيقية). يغطي حالات الاعتماد الـ16:
 *  ① مفقود ② منقول لفرقة أخرى ③ Serial متغير ④ لم يُتحقق ⑤ متعطل ⑥ مطابق
 *  ⑦ التجميع صحيح ⑧ تأكيد النقل يحدّث العهدة ⑨ حدث transferred ⑩ الحسم في audit_log
 *  ⑪ لا قرار بدون assets.manage ⑫ موظف الجرد لا يعتمد قرارًا إداريًا
 *  ⑬ لا حذف/دمج تلقائي ⑭ Timeline يعكس القرار ⑮ القرار persists بعد إعادة الجلب
 *  ⑯ لا كتابة موازية (لا جداول جديدة)
 * القاعدة: Agent يكتشف ويقترح، المسؤول يقرر — كل قرار موثق في Timeline الجهاز.
 * التشغيل: node scripts/assets-discrepancies-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3096;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'assets-disc-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 240) : '')); }
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
    const wipe = new Database(TMP_DB);
    for (const t of ['asset_import_staging', 'asset_events', 'asset_replacements', 'inventory_items', 'inventory_sessions', 'inventory_cycles', 'assets', 'asset_types']) {
        try { wipe.prepare(`DELETE FROM ${t}`).run(); } catch (_) { }
    }
    // تشديد admin.users_manage (قرار المالك 2026-09-04): النجمة وحدها لا تكفي لمسارات الإدارة — بذر منحة فردية للمدير 4252 (معرّفه الفعلي emp-4252)
    wipe.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-4252','admin.users_manage',1,'test-bootstrap')").run();
    wipe.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    users.push({ id: 'astw2-' + STAMP, username: 'astworker2', name: 'موظف جرد المرحلة 5', password: bcrypt.hashSync('w-pass', 10), role: 'user', isActive: true });
    users.push({ id: 'astv4-' + STAMP, username: 'astviewer4', name: 'قارئ بلا صلاحية', password: bcrypt.hashSync('x-pass', 10), role: 'user', isActive: true });
    fs.writeFileSync(path.join(TMP_DIR, 'users.json'), JSON.stringify(users));
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
        const admin = (await api('/api/auth/login', { method: 'POST', body: { username: '4252', password: '4252' } })).data.accessToken;
        let worker = (await api('/api/auth/login', { method: 'POST', body: { username: 'astworker2', password: 'w-pass' } })).data.accessToken;
        const viewer = (await api('/api/auth/login', { method: 'POST', body: { username: 'astviewer4', password: 'x-pass' } })).data.accessToken;

        // ⑪ مقدمًا: بلا صلاحيات ← 403 على القراءة والقرارات
        check('D0a viewer ← 403 على قراءة الفروقات (assets.view)', (await api('/api/assets/discrepancies', { token: viewer })).status === 403);
        check('D0b viewer ← 403 على تأكيد نقل (assets.manage)', (await api('/api/assets/1/transfer', { method: 'POST', token: viewer, body: { to_team: 'x', reason: 'y' } })).status === 403);

        // الخط الأساسي
        await api('/api/assets/import/stage', { method: 'POST', token: admin });
        const ap = await api('/api/assets/import/approve', { method: 'POST', token: admin });
        check('D0c الخط الأساسي جاهز (607)', ap.status === 200 && ap.data.created === 607);

        // منح الموظف التنفيذ فقط ثم إعادة الدخول (المنح يبطل الجلسة — سلوك مقصود)
        await api('/api/permissions/grant', { method: 'POST', token: admin, body: { user_id: 'astworker2', permission: 'assets.inventory' } });
        worker = (await api('/api/auth/login', { method: 'POST', body: { username: 'astworker2', password: 'w-pass' } })).data.accessToken;

        // ⑫ موظف الجرد (assets.inventory فقط) لا يستطيع القرارات الإدارية ولا قراءة الفروقات
        check('D0d موظف الجرد ← 403 على تأكيد نقل (قرار إداري)', (await api('/api/assets/1/transfer', { method: 'POST', token: worker, body: { to_team: 'x', reason: 'y' } })).status === 403);
        check('D0e موظف الجرد ← 403 على قراءة الفروقات (ليست assets.view)', (await api('/api/assets/discrepancies', { token: worker })).status === 403);

        // جهاز أجنبي بسيريال لسيناريو «موقع مختلف» + أرقام الخط الأساسي
        const probe0 = new Database(TMP_DB, { readonly: true });
        const foreign = probe0.prepare("SELECT id, asset_code, team_name, center_name, serial_number FROM assets WHERE team_name != 'جنوب 6' AND serial_number IS NOT NULL AND serial_number != '' LIMIT 1").get();
        const baseMissing = probe0.prepare("SELECT COUNT(*) c FROM assets WHERE status='missing'").get().c;
        const baseDamaged = probe0.prepare("SELECT COUNT(*) c FROM assets WHERE status='damaged'").get().c;
        const baseDup = probe0.prepare("SELECT COUNT(*) c FROM (SELECT serial_number FROM assets WHERE serial_number IS NOT NULL AND serial_number != '' GROUP BY serial_number HAVING COUNT(*) > 1)").get().c;
        probe0.close();
        check('D0f مرجعيات الخط الأساسي: 11 مفقود · 30 تالف · 9 سيريالات مكررة', baseMissing === 11 && baseDamaged === 30 && baseDup === 9 && !!foreign,
            `missing=${baseMissing} damaged=${baseDamaged} dup=${baseDup}`);

        // دورة جرد فعلية على «جنوب 6» تنتج كل فئات الفروقات
        const cyc = await api('/api/assets/inventory/cycles', { method: 'POST', token: admin, body: { label: 'جرد المرحلة 5' } });
        const cycleId = cyc.data.id;
        await api(`/api/assets/inventory/cycles/${cycleId}/activate`, { method: 'POST', token: admin });
        const cycles = (await api('/api/assets/inventory/cycles', { token: admin })).data.cycles;
        const s6 = cycles.find(c => c.id === cycleId).sessions.find(s => s.team_name === 'جنوب 6');
        const sess = await api(`/api/assets/inventory/sessions/${s6.id}`, { token: worker });
        const exp = sess.data.expected;
        const used = new Set();
        const pick = (pred) => { const a = exp.find(x => !used.has(x.id) && pred(x)); if (a) used.add(a.id); return a; };
        const aOk = pick(() => true);
        const aDam = pick(a => a.status !== 'damaged');
        const aMis = pick(a => a.status !== 'missing');
        const aNr = pick(() => true);
        const aSerial = pick(a => !a.serial_number);
        const aSkip = exp.find(x => !used.has(x.id));
        check('D1 أجهزة السيناريو مكتملة', !!(aOk && aDam && aMis && aNr && aSerial && aSkip));
        const post = (body) => api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body });
        await post({ asset_id: aOk.id, result: 'ok' });
        await post({ asset_id: aDam.id, result: 'damaged', reason: 'شاشة مكسورة' });              // ⑤ متعطل
        await post({ asset_id: aMis.id, result: 'missing', reason: 'غير موجود بالمركبة' });       // ① مفقود
        await post({ asset_id: aNr.id, result: 'needs_review', reason: 'ملصق تالف' });
        await post({ asset_id: aSerial.id, result: 'ok', serial_seen: 'SN-P5-001' });             // ③ Serial متغير
        for (const a of exp) { if (!used.has(a.id) && a.id !== aSkip.id) await post({ asset_id: a.id, result: 'ok' }); } // ⑥ مطابقة
        // aSkip يُترك بلا تحقق ④
        await api(`/api/assets/inventory/sessions/${s6.id}/discovered`, { method: 'POST', token: worker, body: { type_name: 'جهاز تترا', serial_number: 'SN-P5-DISC' } });
        await api(`/api/assets/inventory/sessions/${s6.id}/discovered`, { method: 'POST', token: worker, body: { type_name: 'جهاز تترا', serial_number: foreign.serial_number } }); // ② موقع مختلف
        await api(`/api/assets/inventory/sessions/${s6.id}/submit`, { method: 'POST', token: worker });
        const appr = await api(`/api/assets/inventory/sessions/${s6.id}/approve`, { method: 'POST', token: admin });
        check('D2 الجرد نُفّذ واعتُمد', appr.status === 200, JSON.stringify(appr.data).slice(0, 120));

        // ⑦ التجميع الصحيح
        const disc = await api('/api/assets/discrepancies', { token: admin });
        const s = disc.data.summary || {};
        check('D3a التجميع: مفقودة 12 (11 أساس + 1 جرد) · موقع مختلف 1 · Serial متغير 1',
            disc.status === 200 && s.missing === baseMissing + 1 && s.moved === 1 && s.serial_changed === 1, JSON.stringify(s));
        check('D3b التجميع: لم تُتحقق 1 · متعطلة 31 · سيريال بموقعين 9 · مطابقة ' + (exp.length - 3),
            s.unchecked === 1 && s.damaged === baseDamaged + 1 && s.duplicate_serial === baseDup && s.matched === exp.length - 3,
            `unchecked=${s.unchecked} damaged=${s.damaged} dup=${s.duplicate_serial} matched=${s.matched} (توقع ${exp.length - 3})`);
        check('D3c needs_decision = مجموع الفئات الست', s.needs_decision === s.missing + s.moved + s.duplicate_serial + s.serial_changed + s.unchecked + s.damaged);
        check('D3d الدورة المرجعية هي دورة الجرد الفعلية', disc.data.cycle && disc.data.cycle.label === 'جرد المرحلة 5');
        const cases = disc.data.cases || [];
        check('D3e الحالات مرتبة: العالية أولًا', cases.length === s.needs_decision && cases[0].priority === 'high');
        const movedCase = cases.find(c => c.category === 'moved');
        check('D3f حالة «موقع مختلف» تشرح نفسها: العهدة ← أين ظهر + الإجراء المقترح',
            !!movedCase && movedCase.found_team === 'جنوب 6' && movedCase.suggested_action === 'transfer' && movedCase.explanation.includes(foreign.team_name), JSON.stringify(movedCase || {}).slice(0, 200));
        const serialCase = cases.find(c => c.category === 'serial_changed');
        check('D3g حالة «Serial متغير» تعرض القديم ← الجديد', !!serialCase && serialCase.serial_seen === 'SN-P5-001' && serialCase.serial_from === 'فارغ');
        const missingCase = cases.find(c => c.category === 'missing' && c.asset_id === aMis.id);
        check('D3h حالة المفقود تقترح توثيق الفقد', !!missingCase && missingCase.suggested_action === 'document_missing');
        const summOnly = await api('/api/assets/discrepancies?summary=1', { token: admin });
        check('D3i وضع الملخص (?summary=1) للشريط — بلا قائمة حالات', summOnly.status === 200 && !!summOnly.data.summary && !summOnly.data.cases);

        // التحقق من المدخلات قبل القرارات
        check('D4a نقل بلا سبب ← 400', (await api(`/api/assets/${foreign.id}/transfer`, { method: 'POST', token: admin, body: { to_team: 'جنوب 6' } })).status === 400);
        check('D4b نقل لنفس العهدة ← 409', (await api(`/api/assets/${foreign.id}/transfer`, { method: 'POST', token: admin, body: { to_team: foreign.team_name, to_center: foreign.center_name, reason: 'x' } })).status === 409);
        check('D4c توثيق فقد بلا سبب ← 400', (await api(`/api/assets/${aMis.id}/document-missing`, { method: 'POST', token: admin, body: {} })).status === 400);
        check('D4d توثيق فقد لجهاز غير مفقود ← 409', (await api(`/api/assets/${aOk.id}/document-missing`, { method: 'POST', token: admin, body: { reason: 'x' } })).status === 409);
        check('D4e حسم بلا ملاحظة ← 400', (await api(`/api/assets/${aSerial.id}/resolve-review`, { method: 'POST', token: admin, body: {} })).status === 400);
        check('D4f حسم مجموعة بلا ملاحظة ← 400', (await api('/api/assets/resolve-serial-group', { method: 'POST', token: admin, body: { serial: 'X' } })).status === 400);

        // ⑧⑨ تأكيد النقل: العهدة تُحدَّث + حدث transferred موثق
        const tr = await api(`/api/assets/${foreign.id}/transfer`, { method: 'POST', token: admin, body: { to_team: 'جنوب 6', to_center: 'الحائر', reason: 'ظهر فعليًا لدى الفرقة في الجرد' } });
        check('D5a تأكيد النقل نجح', tr.status === 200, JSON.stringify(tr.data));
        let probe = new Database(TMP_DB, { readonly: true });
        const eAfter = probe.prepare('SELECT team_name, center_name, needs_review FROM assets WHERE id = ?').get(foreign.id);
        const evTr = probe.prepare("SELECT * FROM asset_events WHERE asset_id = ? AND event_type = 'transferred'").get(foreign.id);
        check('D5b ⑧ العهدة حُدّثت إلى جنوب 6 / الحائر ورفع علم المراجعة',
            eAfter.team_name === 'جنوب 6' && eAfter.center_name === 'الحائر' && eAfter.needs_review === 0, JSON.stringify(eAfter));
        check('D5c ⑨ حدث transferred موثق (من ← إلى · المعتمد)',
            !!evTr && JSON.parse(evTr.from_value).team === foreign.team_name && JSON.parse(evTr.to_value).team === 'جنوب 6' && !!evTr.actor_name);
        // ⑩ الحسم في audit_log
        const audTr = probe.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'asset_transferred'").get().c;
        check('D5d ⑩ النقل مسجل في audit_log', audTr >= 1);
        probe.close();

        // ⑭ Timeline يعكس القرار عبر بطاقة الجهاز
        const card = await api(`/api/assets/${foreign.id}`, { token: admin });
        check('D5e ⑭ بطاقة الجهاز تعرض «نقل معتمد» في الـTimeline بفاعله',
            card.status === 200 && card.data.events.some(e => e.event_type === 'transferred' && e.actor_name));

        // ⑮ القرار persists — إعادة الجلب: حالة «موقع مختلف» اختفت
        const disc2 = await api('/api/assets/discrepancies', { token: admin });
        check('D6 ⑮ بعد إعادة الجلب: موقع مختلف = 0 وneeds_decision نقص 1',
            disc2.data.summary.moved === 0 && disc2.data.summary.needs_decision === s.needs_decision - 1, JSON.stringify(disc2.data.summary));

        // توثيق الفقد — يبقى missing ولا يُحذف
        const dm = await api(`/api/assets/${aMis.id}/document-missing`, { method: 'POST', token: admin, body: { reason: 'تأكد الفقد — إجراء رسمي جارٍ' } });
        probe = new Database(TMP_DB, { readonly: true });
        const misAfter = probe.prepare('SELECT status, needs_review FROM assets WHERE id = ?').get(aMis.id);
        const evDm = probe.prepare("SELECT to_value FROM asset_events WHERE asset_id = ? AND event_type = 'review_resolved'").get(aMis.id);
        const audDm = probe.prepare("SELECT COUNT(*) c FROM audit_log WHERE action = 'asset_missing_documented'").get().c;
        probe.close();
        check('D7 توثيق الفقد: يبقى missing + قرار missing_confirmed موثق + audit',
            dm.status === 200 && misAfter.status === 'missing' && misAfter.needs_review === 0 && evDm && evDm.to_value === 'missing_confirmed' && audDm >= 1);

        // حسم Serial المتغير + غير المُتحقق + المتعطل
        await api(`/api/assets/${aSerial.id}/resolve-review`, { method: 'POST', token: admin, body: { note: 'رُوجع — السيريال الجديد صحيح', outcome: 'resolved' } });
        await api(`/api/assets/${aSkip.id}/resolve-review`, { method: 'POST', token: admin, body: { note: 'تحقق لاحق — الجهاز موجود', outcome: 'follow_up' } });
        await api(`/api/assets/${aDam.id}/resolve-review`, { method: 'POST', token: admin, body: { note: 'أُرسل للصيانة', outcome: 'resolved' } });

        // حسم مجموعة سيريال مكرر (أول مجموعة ظاهرة)
        const dupCase = disc2.data.cases.find(c => c.category === 'duplicate_serial');
        const grp = await api('/api/assets/resolve-serial-group', { method: 'POST', token: admin, body: { serial: dupCase.serial_number, note: 'تحقق ميداني — الجهازان منفصلان فعلًا' } });
        probe = new Database(TMP_DB, { readonly: true });
        const grpMembers = probe.prepare('SELECT id, needs_review FROM assets WHERE serial_number = ?').all(dupCase.serial_number);
        const grpEvents = probe.prepare("SELECT COUNT(*) c FROM asset_events WHERE event_type = 'review_resolved' AND from_value = 'duplicate_serial'").get().c;
        const totalAssets = probe.prepare('SELECT COUNT(*) c FROM assets').get().c;
        const dupStillBoth = probe.prepare('SELECT COUNT(*) c FROM assets WHERE serial_number = ?').get(dupCase.serial_number).c;
        const tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        probe.close();
        check('D8 حسم المجموعة: رفع العلم عن كل الأعضاء + أحداث موثقة لكل منهم',
            grp.status === 200 && grpMembers.every(m => m.needs_review === 0) && grpEvents === grpMembers.length, `events=${grpEvents} members=${grpMembers.length}`);
        check('D9 ⑬ لا حذف ولا دمج: 608 أصول (607+مكتشف) وعضوا السيريال المكرر باقيان',
            totalAssets === 608 && dupStillBoth === grpMembers.length && grpMembers.length > 1, `total=${totalAssets}`);
        check('D10 ⑯ لا جداول موازية — Single Source of Truth',
            !tables.some(t => /discrep|decision|agent|attention/i.test(t)), tables.filter(t => /asset|inventory/.test(t)).join(','));

        // الملخص النهائي بعد كل القرارات
        const disc3 = await api('/api/assets/discrepancies', { token: admin });
        const s3 = disc3.data.summary;
        check('D11 بعد القرارات: مفقودة 11 · متغير 0 · لم تُتحقق 0 · متعطلة 30 · مكرر 8 · محسومة ≥ 7',
            s3.missing === baseMissing && s3.serial_changed === 0 && s3.unchecked === 0 && s3.damaged === baseDamaged &&
            s3.duplicate_serial === baseDup - 1 && s3.moved === 0 && s3.resolved >= 7, JSON.stringify(s3));

        // الصفحات
        const pg = await fetch(BASE + '/assets/discrepancies');
        const html = await pg.text();
        check('D12a /assets/discrepancies ← 200 HTML وسكربت مطلق', pg.status === 200 && (pg.headers.get('content-type') || '').includes('text/html') && html.includes('src="/js/core/core-auth.js"'));
        const centerHtml = await (await fetch(BASE + '/assets-center')).text();
        check('D12b شريط «يحتاج انتباهك» موجود في مركز العهد', centerHtml.includes('attentionBar') && centerHtml.includes('/assets/discrepancies'));
        const cardHtml = await (await fetch(BASE + '/assets/asset')).text();
        check('D12c بطاقة الجهاز تعرف تسميات transferred/review_resolved/inventoried', cardHtml.includes('نقل معتمد') && cardHtml.includes('حسم مراجعة') && cardHtml.includes('تم جرده'));
    } finally {
        server.kill();
    }

    console.log(`\n═══ النتيجة: ${passed} ✅ / ${failed} ❌ ═══`);
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌ خطأ فادح:', e); process.exit(1); });
