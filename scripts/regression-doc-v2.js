/**
 * Regression Test — doc-v2 (تحسينات عرض وثيقة سير العمل)
 * ═══════════════════════════════════════════════════════════
 * بوابة مستقلة (ملف جديد — لا يعدّل regression-test.js):
 * تتحقق أن عقود العرض الجديدة محمولة فعلًا من المصدر السيرفري:
 *  ① staffing/state: كل عضو/غائب/داعم يحمل jobTitle + code
 *  ② staffing/timeline: سجلات التأخير مثراة بالتخصص/المعرف (مطابقة اسمية)
 *  ③ اللقطة الحية (workflow snapshot): نفس الحقول حاضرة في teams وlateRecords
 *
 * Usage:
 *   SHIFT_ID=1784126563155 BASE_URL=http://localhost:3085 node scripts/regression-doc-v2.js
 */

const BASE = process.env.BASE_URL || 'http://localhost:3085';
const SHIFT_ID_OVERRIDE = process.env.SHIFT_ID || null;
const results = [];
let TOKEN = null;

function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function api(method, path, body, expectStatus = 200) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json */ }
    return { status: res.status, data, ok: res.status === expectStatus };
}

function hasKeys(obj, keys) {
    return obj && keys.every(k => Object.prototype.hasOwnProperty.call(obj, k));
}

async function main() {
    console.log(`\n═══ doc-v2 Regression @ ${BASE} ═══\n`);

    // ─── 1. دخول ───
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    record('تسجيل الدخول', login.ok && login.data && !!login.data.accessToken, `status=${login.status}`);
    if (!login.data || !login.data.accessToken) { console.log('لا يمكن المتابعة بدون توكن'); process.exit(1); }
    TOKEN = login.data.accessToken;

    // ─── 2. حلّ المناوبة المستهدفة (صباح 2026-07-22 أو تجاوز بيئي) ───
    let shiftId = SHIFT_ID_OVERRIDE;
    if (!shiftId) {
        const shifts = await api('GET', '/api/shifts');
        const list = (shifts.data && (shifts.data.shifts || shifts.data)) || [];
        const target = Array.isArray(list) ? list.find(s => {
            const d = s.shift_date || s.shiftDate || '';
            const t = s.shift_type || s.shiftType || '';
            return String(d).includes('2026-07-22') && String(t).includes('صباح');
        }) : null;
        shiftId = target ? String(target.id) : null;
    }
    record('حلّ المناوبة المستهدفة', !!shiftId, `shiftId=${shiftId || 'غير موجود'}`);
    if (!shiftId) { summarize(); process.exit(1); }

    // ─── 3. staffing/state: jobTitle + code على كل شخص ───
    const state = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    record('جلب staffing/state', state.ok && state.data && !!state.data.teams, `status=${state.status}`);
    const teams = (state.data && state.data.teams) || {};
    const teamNames = Object.keys(teams);
    record('وجود فرق في الحالة', teamNames.length > 0, `teams=${teamNames.length}`);

    let membersTotal = 0, membersWithKeys = 0, membersWithTitle = 0, membersWithCode = 0;
    let absTotal = 0, absWithKeys = 0, supTotal = 0, supWithKeys = 0;
    for (const n of teamNames) {
        const t = teams[n] || {};
        for (const m of (t.members || [])) {
            membersTotal++;
            if (hasKeys(m, ['jobTitle', 'code'])) membersWithKeys++;
            if (m && m.jobTitle) membersWithTitle++;
            if (m && m.code) membersWithCode++;
            if (m && m.role === 'support') { supTotal++; if (hasKeys(m, ['jobTitle', 'code'])) supWithKeys++; }
        }
        for (const a of (t.absentees || [])) {
            absTotal++;
            if (hasKeys(a, ['jobTitle', 'code'])) absWithKeys++;
        }
    }
    record('① أعضاء يحملون مفتاحي jobTitle/code', membersTotal > 0 && membersWithKeys === membersTotal,
        `${membersWithKeys}/${membersTotal}`);
    record('② تخصص فعلي غير فارغ لبعض الأعضاء على الأقل', membersWithTitle > 0, `withTitle=${membersWithTitle}`);
    record('③ معرف وظيفي فعلي لبعض الأعضاء على الأقل', membersWithCode > 0, `withCode=${membersWithCode}`);
    record('① الغائبون يحملون jobTitle/code', absTotal > 0 && absWithKeys === absTotal, `${absWithKeys}/${absTotal}`);
    record('① الداعمون يحملون jobTitle/code', supTotal > 0 && supWithKeys === supTotal, `${supWithKeys}/${supTotal}`);

    // ─── 3ب. doc-v4 ⑫: الفرز الطبيعي المركزي — بادئة نصية ثم رقم (مفتاح مبني من الأسماء نفسها) ───
    function natKey(name) {
        const m = /^(.*?)(\d+)\s*$/.exec(String(name || '').trim());
        if (!m) return { prefix: String(name || ''), num: Number.MAX_SAFE_INTEGER };
        return { prefix: m[1].trim(), num: parseInt(m[2], 10) };
    }
    function natCompare(a, b) {
        const ka = natKey(a), kb = natKey(b);
        const p = ka.prefix.localeCompare(kb.prefix, 'ar');
        return p !== 0 ? p : ka.num - kb.num;
    }
    const expectedOrder = teamNames.slice().sort(natCompare);
    record('④ staffing/state: ترتيب الفرق طبيعي مركزي (بادئة ثم رقم)',
        teamNames.join('|') === expectedOrder.join('|'),
        teamNames.join('، '));

    // ─── 4. staffing/timeline: سجلات تأخير مثراة ───
    const tl = await api('GET', `/api/staffing/timeline?shift_id=${shiftId}`);
    const lateRecords = (tl.data && tl.data.lateRecords) || [];
    record('جلب staffing/timeline', tl.ok, `status=${tl.status}`);
    record('② وجود سجلات تأخير (بذرة الجولة)', lateRecords.length > 0, `records=${lateRecords.length}`);
    const lateEnriched = lateRecords.filter(r => hasKeys(r, ['jobTitle', 'code']) && (r.jobTitle || r.code));
    record('② سجلات التأخير مثراة بالتخصص/المعرف', lateRecords.length > 0 && lateEnriched.length === lateRecords.length,
        `${lateEnriched.length}/${lateRecords.length}`);

    // ─── 5. اللقطة الحية: prepare ثم قراءة المسودة ───
    const prep = await api('POST', '/api/workflow/prepare', {});
    record('prepare مسودة سير العمل', prep.ok && prep.data, `status=${prep.status}`);
    const wfList = await api('GET', `/api/workflow/shift/${shiftId}`);
    const versions = (wfList.data && (wfList.data.versions || [])) || [];
    // المسودة المفتوحة أولًا؛ وإلا الأحدث رقمًا (النسخ القديمة لقطاتها بلا إثراء doc-v2)
    const newest = versions.slice().sort((a, b) => (b.version_no || 0) - (a.version_no || 0))[0] || null;
    const draft = versions.find(v => v.status === 'draft') || newest;
    record('③ وجود نسخة سير عمل للمناوبة', !!draft, `versions=${versions.length}`);
    if (draft) {
        const ver = await api('GET', `/api/workflow/version/${draft.id}`);
        const snap = (ver.data && (ver.data.snapshot || (ver.data.workflow && ver.data.workflow.snapshot))) || null;
        record('③ قراءة لقطة النسخة', !!snap, `status=${ver.status}`);
        if (snap) {
            const sTeams = (snap.staffing && snap.staffing.teams) || {};
            let sm = 0, smKeys = 0;
            for (const n of Object.keys(sTeams)) {
                for (const m of ((sTeams[n] && sTeams[n].members) || [])) {
                    sm++;
                    if (hasKeys(m, ['jobTitle', 'code'])) smKeys++;
                }
            }
            record('③ لقطة: الأعضاء يحملون jobTitle/code', sm > 0 && smKeys === sm, `${smKeys}/${sm}`);
            const sNames = Object.keys(sTeams);
            const sExpected = sNames.slice().sort(natCompare);
            record('④ لقطة: ترتيب الفرق يطابق الفرز المركزي',
                sNames.length > 0 && sNames.join('|') === sExpected.join('|'),
                sNames.join('، '));
            const sLate = snap.lateRecords || [];
            const sLateOk = sLate.filter(r => hasKeys(r, ['jobTitle', 'code']));
            record('③ لقطة: سجلات التأخير تحمل مفاتيح الإثراء',
                sLate.length > 0 && sLateOk.length === sLate.length, `${sLateOk.length}/${sLate.length}`);
        }
    }

    summarize();
    const failed = results.filter(r => !r.ok).length;
    // مهلة قصيرة قبل الخروج — إغلاق مقابس undici بسلامة على ويندوز
    setTimeout(() => process.exit(failed ? 1 : 0), 400);
}

function summarize() {
    const passed = results.filter(r => r.ok).length;
    console.log(`\n═══ النتيجة: ${passed}/${results.length} (${results.length - passed} فاشلة) ═══`);
}

main().catch(e => { console.error('فشل غير متوقع:', e); process.exit(1); });
