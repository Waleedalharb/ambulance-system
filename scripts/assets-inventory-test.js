/**
 * ═══ assets-inventory-test.js — اختبار قبول «المرحلة 4: دورة الجرد الفعلية» (اعتماد المالك 2026-08-23) ═══
 * على خادم معزول (نسخة مؤقتة — لا يمس بيانات حقيقية):
 *  C0 الحسم الخادمي: بلا صلاحية ← 403 على عناصر الجرد/الاعتماد/المكتشفات
 *  C1 إنشاء دورة (manage فقط) — الموظف المنفذ يُرفض
 *  C2 التفعيل ينشئ جلسة لكل فرقة لها أجهزة (31)
 *  C3 الموظف يفتح جلسة فرقته: الأجهزة المتوقعة + الحالة open
 *  C4 تسجيل النتائج: ok/تالف/مفقود — المفقود بلا سبب ← 400، وبسبب ← 200
 *     جهاز فرقة أخرى بلا discovered ← 409 · upsert لا يكرر الصف
 *  C5 جهاز مكتشف: سيريال جديد ← هوية جديدة معلّمة · سيريال جهاز آخر ← ربط+تحذير (لا مكرر صامت)
 *  C6 الإرسال ← submitted، وإعادة الإرسال ← 409
 *  C7 مراجعة الإدارة: byResult/serialChanges/unchecked/discovered صحيحة
 *  C8 الاعتماد: حالات محدثة + أحداث inventoried/serial_corrected/reported_missing بـsession_id
 *     + غير المُتحقق needs_review + ختم المعتمد — كلها من القاعدة مباشرة
 *  C9 إعادة الاعتماد ← 409 · المنفذ لا يستطيع الاعتماد (فصل التنفيذ عن الاعتماد)
 *  C10 الإرجاع: بلا ملاحظة ← 400 · بملاحظة ← open من جديد
 *  C11 إغلاق الدورة قبل اعتماد الكل ← 409 يسمّي الفرق الناقصة
 *  C12 الصفحتان تُقدَّمان 200 HTML بسكربت مطلق
 * التشغيل: node scripts/assets-inventory-test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const ROOT = path.join(__dirname, '..');
const PORT = 3094;
const BASE = 'http://127.0.0.1:' + PORT;
const STAMP = Date.now().toString(36);
const TMP_DIR = path.join(os.tmpdir(), 'assets-inv-' + STAMP);
const TMP_DB = path.join(TMP_DIR, 'ambulance.db');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 220) : '')); }
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
    // عزل تام: بيانات الأصول في المصدر (إن وُجدت) لا تدخل الاختبار — النسخة تبدأ فارغة
    const wipe = new Database(TMP_DB);
    for (const t of ['asset_import_staging', 'asset_events', 'asset_replacements', 'inventory_items', 'inventory_sessions', 'inventory_cycles', 'assets', 'asset_types']) {
        try { wipe.prepare(`DELETE FROM ${t}`).run(); } catch (_) { }
    }
    // تشديد admin.users_manage (قرار المالك 2026-09-04): النجمة وحدها لا تكفي لمسارات الإدارة — بذر منحة فردية للمدير 4252 (معرّفه الفعلي emp-4252)
    wipe.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES ('emp-4252','admin.users_manage',1,'test-bootstrap')").run();
    wipe.close();
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'users.json'), 'utf8'));
    users.push({ id: 'astw-' + STAMP, username: 'astworker', name: 'موظف جرد الاختبار', password: bcrypt.hashSync('w-pass', 10), role: 'user', isActive: true });
    users.push({ id: 'astv-' + STAMP, username: 'astviewer3', name: 'قارئ بلا صلاحية', password: bcrypt.hashSync('x-pass', 10), role: 'user', isActive: true });
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
        let worker = (await api('/api/auth/login', { method: 'POST', body: { username: 'astworker', password: 'w-pass' } })).data.accessToken;
        const viewer = (await api('/api/auth/login', { method: 'POST', body: { username: 'astviewer3', password: 'x-pass' } })).data.accessToken;

        // C0 — الحسم الخادمي قبل أي شيء (المصادقة/الصلاحية تسبق معالج المسار)
        check('C0a viewer ← 403 على تسجيل نتيجة', (await api('/api/assets/inventory/sessions/1/items', { method: 'POST', token: viewer, body: { asset_id: 1, result: 'ok' } })).status === 403);
        check('C0b viewer ← 403 على الاعتماد', (await api('/api/assets/inventory/sessions/1/approve', { method: 'POST', token: viewer })).status === 403);
        check('C0c viewer ← 403 على فتح الجلسة', (await api('/api/assets/inventory/sessions/1', { token: viewer })).status === 403);

        // تجهيز الخط الأساسي: stage + approve (607)
        await api('/api/assets/import/stage', { method: 'POST', token: admin });
        const ap = await api('/api/assets/import/approve', { method: 'POST', token: admin });
        check('C0d الخط الأساسي جاهز (607 أصول)', ap.status === 200 && ap.data.created === 607, JSON.stringify(ap.data).slice(0, 120));

        // منح الموظف صلاحية التنفيذ فقط (منح فردي — assets.inventory لا تأتي بأي دور)
        const grant = await api('/api/permissions/grant', { method: 'POST', token: admin, body: { user_id: 'astworker', permission: 'assets.inventory' } });
        check('C0e منح assets.inventory للموظف', grant.status === 200 && grant.data.success, JSON.stringify(grant.data).slice(0, 120));
        // المنصة تُبطل جلسات المستخدم عند تغيير صلاحياته (سلوك أمني مقصود) — نعيد الدخول برمز جديد
        worker = (await api('/api/auth/login', { method: 'POST', body: { username: 'astworker', password: 'w-pass' } })).data.accessToken;

        // جهاز أجنبي (فرقة أخرى) بسيريال — لاختبارَي 409 والمطابقة
        const probe0 = new Database(TMP_DB, { readonly: true });
        const foreign = probe0.prepare("SELECT id, asset_code, team_name, serial_number FROM assets WHERE team_name != 'جنوب 6' AND serial_number IS NOT NULL AND serial_number != '' LIMIT 1").get();
        probe0.close();
        check('C0f وُجد جهاز أجنبي بسيريال للاختبار', !!foreign, 'لا جهاز أجنبي بسيريال في الحمولة');

        // C1 — إنشاء الدورة: manage فقط
        check('C1a الموظف المنفذ ← 403 على إنشاء دورة', (await api('/api/assets/inventory/cycles', { method: 'POST', token: worker, body: { label: 'محاولة' } })).status === 403);
        const cyc = await api('/api/assets/inventory/cycles', { method: 'POST', token: admin, body: { label: 'جرد الاختبار — الربع الثالث' } });
        check('C1b الإدارة تنشئ الدورة', cyc.status === 200 && cyc.data.id > 0, JSON.stringify(cyc.data));
        const cycleId = cyc.data.id;

        // C2 — التفعيل: جلسة لكل فرقة لها أجهزة (31)
        const act = await api(`/api/assets/inventory/cycles/${cycleId}/activate`, { method: 'POST', token: admin });
        check('C2 التفعيل أنشأ 31 جلسة فرق', act.status === 200 && act.data.sessions === 31, JSON.stringify(act.data));
        const cycles = (await api('/api/assets/inventory/cycles', { token: admin })).data.cycles;
        const myCycle = cycles.find(c => c.id === cycleId);
        const s6 = myCycle.sessions.find(s => s.team_name === 'جنوب 6');
        const s7 = myCycle.sessions.find(s => s.team_name === 'جنوب 7');
        check('C2b قائمة الدورات تعرض الجلسات بحالاتها', !!s6 && !!s7 && myCycle.sessions_total === 31 && s6.status === 'open');

        // C3 — الموظف يفتح جلسة فرقته
        const sess = await api(`/api/assets/inventory/sessions/${s6.id}`, { token: worker });
        const exp = sess.data.expected || [];
        check('C3 الجلسة تعرض أجهزة الفرقة المتوقعة', sess.status === 200 && exp.length >= 10 && sess.data.session.status === 'open' && sess.data.items.length === 0, `expected=${exp.length}`);

        // اختيار الأجهزة للسيناريو (بخط أساسي مختلف عن الهدف لضمان التغيير)
        const used = new Set();
        const pick = (pred) => { const a = exp.find(x => !used.has(x.id) && pred(x)); if (a) used.add(a.id); return a; };
        const aOk = pick(() => true);
        const aDam = pick(a => a.status !== 'damaged');
        const aMis = pick(a => a.status !== 'missing');
        const aNr = pick(() => true);
        const aSerial = pick(a => !a.serial_number);
        const aSkip = exp.find(x => !used.has(x.id)); // يُترك بلا تحقق
        check('C3b أجهزة السيناريو مكتملة (منها بلا سيريال وجهاز يُترك)', !!(aOk && aDam && aMis && aNr && aSerial && aSkip),
            `ok=${!!aOk} dam=${!!aDam} mis=${!!aMis} nr=${!!aNr} serial=${!!aSerial} skip=${!!aSkip}`);

        // C4 — تسجيل النتائج
        check('C4a ok', (await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aOk.id, result: 'ok' } })).status === 200);
        const again = await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aOk.id, result: 'ok', location_note: 'برفوف المستودع' } });
        check('C4b upsert: إعادة تسجيل نفس الجهاز تحدّث ولا تكرر', again.status === 200);
        check('C4c damaged', (await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aDam.id, result: 'damaged', reason: 'كسر في الشاشة' } })).status === 200);
        const missNoReason = await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aMis.id, result: 'missing' } });
        check('C4d 🔴 مفقود بلا سبب ← 400 (السبب إلزامي)', missNoReason.status === 400);
        check('C4e مفقود بسبب ← 200', (await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aMis.id, result: 'missing', reason: 'لم يُوجد بالمركبة ولا المستودع منذ أسبوع' } })).status === 200);
        check('C4f needs_review', (await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aNr.id, result: 'needs_review', reason: 'الملصق تالف' } })).status === 200);
        check('C4g تأكيد سيريال لجهاز بلا سيريال', (await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aSerial.id, result: 'ok', serial_seen: 'SN-CORR-001' } })).status === 200);
        // أكمل بقية أجهزة الفرقة «سليمًا» — يبقى aSkip وحده بلا تحقق (سيناريو المراجعة)
        for (const a of exp) {
            if (used.has(a.id) || a.id === aSkip.id) continue;
            const r = await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: a.id, result: 'ok' } });
            if (r.status !== 200) { check('C4g2 تسجيل بقية الأجهزة', false, `asset ${a.id} ← ${r.status}`); break; }
        }
        const foreignItem = await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: foreign.id, result: 'ok' } });
        check('C4h جهاز فرقة أخرى بلا «مكتشف» ← 409 يوجّه للمسار الصحيح', foreignItem.status === 409 && /مكتشف/.test(foreignItem.data.error || ''), JSON.stringify(foreignItem.data).slice(0, 120));
        const mid = await api(`/api/assets/inventory/sessions/${s6.id}`, { token: worker });
        check('C4i الجلسة تحوي ' + (exp.length - 1) + ' عنصرًا (كل الأجهزة ما عدا المترك، ولا تكرار من upsert)', mid.data.items.length === exp.length - 1, `items=${mid.data.items.length}`);
        check('C4j أول حفظ ختم المجرى', mid.data.session.conductor_name === 'موظف جرد الاختبار', mid.data.session.conductor_name);

        // C5 — الأجهزة المكتشفة
        const discNew = await api(`/api/assets/inventory/sessions/${s6.id}/discovered`, { method: 'POST', token: worker, body: { type_name: 'جهاز تترا', serial_number: 'SN-NEW-DISC-1', notes: 'وُجد بمركبة الفرقة' } });
        check('C5a مكتشف بسيريال جديد ← هوية جديدة معلّمة للمراجعة', discNew.status === 200 && discNew.data.asset_code && discNew.data.needs_review === true, JSON.stringify(discNew.data));
        const discDup = await api(`/api/assets/inventory/sessions/${s6.id}/discovered`, { method: 'POST', token: worker, body: { type_name: 'جهاز تترا', serial_number: foreign.serial_number } });
        check('C5b سيريال مسجل لجهاز آخر ← ربط بالقائم + تحذير (لا مكرر صامت)',
            discDup.status === 200 && discDup.data.matched_existing === foreign.asset_code && /مسجل لجهاز آخر/.test(discDup.data.warning || ''), JSON.stringify(discDup.data).slice(0, 160));

        // C6 — الإرسال
        const sub = await api(`/api/assets/inventory/sessions/${s6.id}/submit`, { method: 'POST', token: worker });
        check('C6a الإرسال ← submitted بعدد العناصر', sub.status === 200 && sub.data.items === exp.length + 1, JSON.stringify(sub.data));
        check('C6b إعادة الإرسال ← 409', (await api(`/api/assets/inventory/sessions/${s6.id}/submit`, { method: 'POST', token: worker })).status === 409);
        check('C6c تسجيل نتيجة بعد الإرسال ← 409', (await api(`/api/assets/inventory/sessions/${s6.id}/items`, { method: 'POST', token: worker, body: { asset_id: aOk.id, result: 'ok' } })).status === 409);

        // C7 — مراجعة الإدارة
        check('C7a الموظف المنفذ ← 403 على المراجعة (manage فقط)', (await api(`/api/assets/inventory/sessions/${s6.id}/review`, { token: worker })).status === 403);
        const rev = await api(`/api/assets/inventory/sessions/${s6.id}/review`, { token: admin });
        const br = rev.data.byResult || {};
        check('C7b byResult: ok=' + (exp.length - 3) + ' damaged=1 missing=1 needs_review=2', rev.status === 200 && br.ok === exp.length - 3 && br.damaged === 1 && br.missing === 1 && br.needs_review === 2, JSON.stringify(br));
        check('C7c serialChanges يلتقط تأكيد السيريال (فارغ ← SN-CORR-001)',
            rev.data.serialChanges.length === 1 && rev.data.serialChanges[0].to === 'SN-CORR-001' && rev.data.serialChanges[0].from === 'فارغ', JSON.stringify(rev.data.serialChanges));
        check('C7d unchecked = الجهاز المترك فقط · discovered = 2',
            rev.data.unchecked.length === 1 && rev.data.unchecked[0].id === aSkip.id && rev.data.discovered.length === 2,
            `unchecked=${rev.data.unchecked.length} discovered=${rev.data.discovered.length}`);

        // C8 — الاعتماد + التحقق من القاعدة مباشرة
        check('C8a الموظف المنفذ ← 403 على الاعتماد (فصل التنفيذ عن الاعتماد)', (await api(`/api/assets/inventory/sessions/${s6.id}/approve`, { method: 'POST', token: worker })).status === 403);
        const appr = await api(`/api/assets/inventory/sessions/${s6.id}/approve`, { method: 'POST', token: admin });
        check('C8b الاعتماد نجح: ' + (exp.length + 1) + ' عنصرًا · تغييرات حالة ≥ 2 · تصحيح سيريال = 1',
            appr.status === 200 && appr.data.items === exp.length + 1 && appr.data.changed >= 2 && appr.data.serialFixed === 1, JSON.stringify(appr.data));
        const probe = new Database(TMP_DB, { readonly: true });
        const stDam = probe.prepare('SELECT status FROM assets WHERE id = ?').get(aDam.id).status;
        const stMis = probe.prepare('SELECT status FROM assets WHERE id = ?').get(aMis.id).status;
        check('C8c الحالات طُبقت: تالف ومفقود', stDam === 'damaged' && stMis === 'missing', `dam=${stDam} mis=${stMis}`);
        const evInv = probe.prepare("SELECT COUNT(*) c FROM asset_events WHERE event_type='inventoried' AND session_id = ?").get(s6.id).c;
        const evMiss = probe.prepare("SELECT COUNT(*) c FROM asset_events WHERE event_type='reported_missing' AND asset_id = ? AND session_id = ?").get(aMis.id, s6.id).c;
        check('C8d حدث inventoried لكل عنصر بـsession_id + reported_missing موثق', evInv === exp.length + 1 && evMiss === 1, `inventoried=${evInv} missing_ev=${evMiss}`);
        const serRow = probe.prepare('SELECT serial_number FROM assets WHERE id = ?').get(aSerial.id);
        const evSer = probe.prepare("SELECT COUNT(*) c FROM asset_events WHERE event_type='serial_corrected' AND asset_id = ? AND to_value = 'SN-CORR-001'").get(aSerial.id).c;
        check('C8e السيريال صُحّح وحدث serial_corrected موثق (فارغ ← SN-CORR-001)', serRow.serial_number === 'SN-CORR-001' && evSer === 1, `serial=${serRow.serial_number}`);
        const nrSkip = probe.prepare('SELECT needs_review FROM assets WHERE id = ?').get(aSkip.id).needs_review;
        const nrFlag = probe.prepare('SELECT needs_review FROM assets WHERE id = ?').get(aNr.id).needs_review;
        check('C8f غير المُتحقق والمعلّم ← needs_review (لا تخمين)', nrSkip === 1 && nrFlag === 1, `skip=${nrSkip} nr=${nrFlag}`);
        const discRow = probe.prepare("SELECT needs_review, source, team_name FROM assets WHERE serial_number = 'SN-NEW-DISC-1'").get();
        const foreignFlag = probe.prepare('SELECT needs_review FROM assets WHERE id = ?').get(foreign.id).needs_review;
        check('C8g المكتشف الجديد محفوظ بمصدره ومعلّم · والمطابق عُلّم (لا مكرر)',
            !!discRow && discRow.needs_review === 1 && discRow.source === 'inventory-discovery' && discRow.team_name === 'جنوب 6' && foreignFlag === 1,
            JSON.stringify(discRow || {}));
        const sessRow = probe.prepare('SELECT status, approved_by, approved_at FROM inventory_sessions WHERE id = ?').get(s6.id);
        check('C8h الجلسة approved بختم المعتمد والوقت', sessRow.status === 'approved' && !!sessRow.approved_by && !!sessRow.approved_at, JSON.stringify(sessRow));
        probe.close();

        // C9 — إعادة الاعتماد مرفوضة
        check('C9 إعادة اعتماد جلسة معتمدة ← 409', (await api(`/api/assets/inventory/sessions/${s6.id}/approve`, { method: 'POST', token: admin })).status === 409);

        // C10 — الإرجاع بملاحظة إلزامية (على جلسة ثانية)
        await api(`/api/assets/inventory/sessions/${s7.id}/items`, { method: 'POST', token: worker, body: { asset_id: (await api(`/api/assets/inventory/sessions/${s7.id}`, { token: worker })).data.expected[0].id, result: 'ok' } });
        await api(`/api/assets/inventory/sessions/${s7.id}/submit`, { method: 'POST', token: worker });
        check('C10a الإرجاع بلا ملاحظة ← 400', (await api(`/api/assets/inventory/sessions/${s7.id}/reopen`, { method: 'POST', token: admin, body: {} })).status === 400);
        const reo = await api(`/api/assets/inventory/sessions/${s7.id}/reopen`, { method: 'POST', token: admin, body: { note: 'أكمل بقية الأجهزة' } });
        const s7After = await api(`/api/assets/inventory/sessions/${s7.id}`, { token: worker });
        check('C10b الإرجاع بملاحظة ← open من جديد والملاحظة محفوظة', reo.status === 200 && s7After.data.session.status === 'open' && s7After.data.session.notes === 'أكمل بقية الأجهزة');

        // C11 — إغلاق الدورة قبل اعتماد الكل ← 409 يسمّي الفرق
        const close = await api(`/api/assets/inventory/cycles/${cycleId}/close`, { method: 'POST', token: admin });
        check('C11 الإغلاق مرفوض ويسمّي الفرق غير المعتمدة', close.status === 409 && /جنوب 7/.test(close.data.error || ''), JSON.stringify(close.data).slice(0, 120));

        // C12 — تقديم الصفحتين: 200 HTML + سكربت مطلق
        for (const [route, name] of [['/assets/inventory', 'دورات الجرد'], ['/assets/inventory/session', 'جلسة الجرد']]) {
            const r = await fetch(BASE + route);
            const ct = r.headers.get('content-type') || '';
            const html = await r.text();
            check('C12 ' + name + ' (' + route + ') ← 200 HTML وسكربت مطلق', r.status === 200 && ct.includes('text/html') && html.includes('src="/js/core/core-auth.js"'));
        }
    } finally {
        server.kill();
    }

    console.log(`\n═══ النتيجة: ${passed} ✅ / ${failed} ❌ ═══`);
    if (failures.length) console.log('الفشلات: ' + failures.join(' | '));
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('❌ خطأ فادح:', e); process.exit(1); });
