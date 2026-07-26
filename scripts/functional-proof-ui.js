/**
 * تحقق وظيفي حي (Functional Proof) — يحاكي نفس استدعاءات الواجهة حرفيًا
 * بعد قرار المالك: إثبات أن V-B ⑪⑫②⑦ وSR-1 ⑨ وظائف عاملة وليست «أسماء تغيرت».
 * يعمل ضد نسخة معزولة (DB_PATH) — لا يلمس بيانات التشغيل.
 */
const BASE = process.env.BASE_URL || 'http://localhost:3080';
let TOKEN = null;
let pass = 0, fail = 0;

function record(name, ok, detail = '') {
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
    ok ? pass++ : fail++;
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
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data, ok: res.status === expectStatus };
}

// نفس حمولة postPersonEvents في radio-completion.html حرفيًا
function postPersonEvents(events, shiftType, shiftDate) {
    return api('POST', '/api/shift-completion', { shiftType, shiftDate, events });
}

async function main() {
    console.log('\n═══ التحقق الوظيفي — وظائف «الاختبارات القديمة» + زر إنهاء التعيين ═══\n');

    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    if (!login.data || !login.data.accessToken) { console.log('فشل الدخول'); process.exit(1); }
    TOKEN = login.data.accessToken;

    const start = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
    const shiftId = start.data && start.data.shiftId;
    record('⓪ بدء مناوبة اختبار معزولة', !!shiftId, `shiftId=${shiftId}`);

    // ─── F1: دورة المركبة الكاملة من أزرار الواجهة (تعيين ← نقل ← إنهاء التعيين الجديد) ───
    const teams = ((await api('GET', '/api/teams')).data || {}).teams || [];
    const t1 = teams[0], t2 = teams[1];
    const board0 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const unass0 = (board0.data && board0.data.unassigned) || [];
    const veh = unass0.find(v => v.status === 'active') || unass0[0];
    record('F1-⓪ توفر مركبة غير معيّنة وفريقان للاختبار', !!veh && !!t1 && !!t2,
        `veh=${veh && veh.id} t1=${t1 && t1.id} t2=${t2 && t2.id}`);

    // زر «📍 تعيين» — confirmVehicleTeam(mode='assign')
    const a1 = await api('POST', '/api/vehicles/assignment', { vehicleId: veh.id, teamId: t1.id, note: null });
    const b1 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const v1 = ((b1.data && b1.data.vehicles) || []).find(v => v.id === veh.id);
    record('F1-① زر «تعيين»: المركبة تظهر في فريقها باللوحة', a1.ok && !!v1 && v1.teamId === t1.id,
        `appended=${a1.data && a1.data.appended} teamId=${v1 && v1.teamId}`);

    // زر «🔄 نقل» — confirmVehicleTeam(mode='switch')
    const a2 = await api('POST', '/api/vehicles/assignment/switch', { vehicleId: veh.id, teamId: t2.id, note: null });
    const b2 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const v2 = ((b2.data && b2.data.vehicles) || []).find(v => v.id === veh.id);
    record('F1-② زر «نقل»: المركبة تنتقل للفريق الجديد فورًا', a2.ok && !!v2 && v2.teamId === t2.id,
        `appended=${a2.data && a2.data.appended} teamId=${v2 && v2.teamId}`);

    // زر «⛔ إنهاء التعيين» الجديد — endVehicleAssignment (نفس مسار/حمولة الزر المضاف)
    const a3 = await api('POST', '/api/vehicles/assignment/end', { vehicleId: veh.id });
    const b3 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const v3u = ((b3.data && b3.data.unassigned) || []).find(v => v.id === veh.id);
    const v3a = ((b3.data && b3.data.vehicles) || []).find(v => v.id === veh.id);
    record('F1-③ زر «إنهاء التعيين» الجديد: المركبة تعود لقائمة غير المعيّنة',
        a3.ok && (a3.data.appended === 1) && !!v3u && !v3a,
        `appended=${a3.data && a3.data.appended} unassigned=${!!v3u} stillAssigned=${!!v3a}`);

    // idempotency: إنهاء ثانٍ بلا تعيين مفتوح يُتخطى (نفس سلوك بقية الأزرار)
    const a4 = await api('POST', '/api/vehicles/assignment/end', { vehicleId: veh.id });
    record('F1-④ إنهاء مكرر يُتخطى بأمان (appended=0)', a4.ok && a4.data.appended === 0,
        `skipped=${a4.data && a4.data.skipped}`);

    // ─── F2: منتقي الحالة — تغيير لأي حالة في أي وقت (زرّي جاهزة/خارج الخدمة) ───
    const s1 = await api('POST', '/api/vehicles/events', { vehicleId: veh.id, status: 'breakdown', reason: 'عطل اختبار F2' });
    const sb1 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const sv1 = ((sb1.data && sb1.data.unassigned) || []).find(v => v.id === veh.id);
    const s2 = await api('POST', '/api/vehicles/events', { vehicleId: veh.id, status: 'active' }); // زر «✅ جاهزة»
    const sb2 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const sv2 = ((sb2.data && sb2.data.unassigned) || []).find(v => v.id === veh.id);
    record('F2-① عطل ← جاهزة: انتقال عكسي مباشر وآخر قرار يحكم',
        s1.ok && s2.ok && sv1 && sv1.status === 'breakdown' && sv2 && sv2.status === 'active',
        `after1=${sv1 && sv1.status} after2=${sv2 && sv2.status}`);

    // ─── F3: الدعم وإنهاؤه من أزرار الواجهة + الشارة (supportingTeamId) ───
    await api('POST', '/api/vehicles/assignment', { vehicleId: veh.id, teamId: t1.id, note: null });
    const sp1 = await api('POST', '/api/vehicles/support', { vehicleId: veh.id, targetTeamId: t2.id, note: null }); // زر «🤝 دعم»
    const pb1 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const pv1 = ((pb1.data && pb1.data.vehicles) || []).find(v => v.id === veh.id);
    record('F3-① زر «دعم»: المركبة تبقى لفريقها الأصلي وتظهر شارة الداعم (supportingTeamId)',
        sp1.ok && !!pv1 && pv1.teamId === t1.id && pv1.supportingTeamId === t2.id,
        `home=${pv1 && pv1.teamId} supports=${pv1 && pv1.supportingTeamId}`);
    const sp2 = await api('POST', '/api/vehicles/support/end', { vehicleId: veh.id }); // زر «⛔ إنهاء الدعم»
    const pb2 = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const pv2 = ((pb2.data && pb2.data.vehicles) || []).find(v => v.id === veh.id);
    record('F3-② زر «إنهاء الدعم»: الشارة تزول والمركبة تبقى معيّنة لفريقها',
        sp2.ok && !!pv2 && pv2.teamId === t1.id && pv2.supportingTeamId == null,
        `supports=${pv2 && pv2.supportingTeamId}`);
    await api('POST', '/api/vehicles/assignment/end', { vehicleId: veh.id }); // تنظيف

    // ─── F4: نموذج النقص الإلزامي — الأسباب الأربعة من الواجهة تُخزَّن وتنعكس ───
    // نفس اختيار SR-1: فريق بكادر نشط ≥2 من shift_roster (members[state=active])
    const st0 = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const teamsState = (st0.data && st0.data.teams) || {};
    const teamKey = Object.keys(teamsState).find(k =>
        (teamsState[k].members || []).filter(m => m.state === 'active').length >= 2);
    const teamSt = teamKey && teamsState[teamKey];
    const roster = teamSt ? teamSt.members.filter(m => m.state === 'active').map(m => m.name) : [];
    record('F4-⓪ فريق بكادر ≥2 من shift_roster (SSOT)', !!teamKey && roster.length >= 2,
        `team=${teamKey} crew=${roster.length}`);

    // نفس حمولة confirmMissing حرفيًا: type=MISSING_REASON_EVENT[reason] + employeeName + reason + teamId
    const SD = '2026-07-24';
    const e1 = roster[0], e2 = roster[1];
    const m1 = await postPersonEvents([{ type: 'absence', employeeName: e1, reason: 'غياب', teamId: teamKey }], 'ليل', SD);
    const st1 = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const t1s = (st1.data.teams || {})[teamKey] || {};
    const abs1 = (t1s.absentees || []).map(a => a.name);
    const abs1Reason = (t1s.absentees || []).find(a => a.name === e1);
    record('F4-① سبب «غياب»: يُحفظ ويظهر الغائب بسببه ويُخصم من الحاضرين',
        m1.ok && m1.data.appended === 1 && abs1.includes(e1) && abs1Reason && abs1Reason.reason === 'غياب',
        `appended=${m1.data && m1.data.appended} absentees=${JSON.stringify(t1s.absentees || [])}`);

    // «تأخير» — نفس النموذج (type=late)
    const m2 = await postPersonEvents([{ type: 'late', employeeName: e2, reason: 'تأخير', teamId: teamKey }], 'ليل', SD);
    record('F4-② سبب «تأخير»: يُحفظ كحدث late', m2.ok && m2.data.appended === 1,
        `appended=${m2.data && m2.data.appended}`);

    // «تكليف» و«إجازة» — يُخزنان حرفيًا كـ absence بنفس النموذج (السبب محفوظ حرفيًا)
    const m3 = await postPersonEvents([
        { type: 'absence', employeeName: e1, reason: 'تكليف', teamId: teamKey },
        { type: 'absence', employeeName: e2, reason: 'إجازة', teamId: teamKey }
    ], 'ليل', SD);
    record('F4-③ سببا «تكليف»/«إجازة»: يمران بنفس النموذج (تكرار المفتوح يُتخطى idempotency)',
        m3.ok, `appended=${m3.data && m3.data.appended}`);

    // «حضر» — personArrived: يغلق الغياب ويعيد الحاضر للاشتقاق
    const av1 = await postPersonEvents([{ type: 'arrival', teamId: teamKey, employeeName: e1 }], 'ليل', SD);
    const st2 = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const t2s = (st2.data.teams || {})[teamKey] || {};
    const abs2 = (t2s.absentees || []).map(a => a.name);
    record('F4-④ زر «حضر»: يغلق الغياب ويعيد الموظف للحاضرين',
        av1.ok && av1.data.appended === 1 && !abs2.includes(e1),
        `appended=${av1.data && av1.data.appended} absentees=${JSON.stringify(abs2)}`);

    // قرار المشرف — cardSetReady: { type:'ready' } يخزَّن ويظهر (عقد الفصل)
    const rd = await postPersonEvents([{ type: 'ready', teamId: teamKey }], 'ليل', SD);
    const st3 = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const t3s = (st3.data.teams || {})[teamKey] || {};
    record('F4-⑤ زر «جاهزة»: قرار المشرف يُخزَّن ويظهر في الحالة', rd.ok && t3s.status === 'ready',
        `status=${t3s.status}`);

    // تنظيف: حذف مناوبة الاختبار
    if (shiftId) await api('DELETE', `/api/shifts/${shiftId}`);

    console.log(`\n═══ النتيجة: ${pass} ناجح / ${fail} فاشل ═══`);
    process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('خطأ غير متوقع:', e); process.exit(1); });
