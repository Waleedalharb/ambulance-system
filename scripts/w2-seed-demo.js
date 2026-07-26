/* بذر بيانات واقعية على النسخة المعزولة للقطات شاشة W-2 — لا يلمس بيانات التشغيل */
const BASE = process.env.BASE_URL || 'http://localhost:3085';
let TOKEN = null;
async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (TOKEN) opts.headers['Authorization'] = 'Bearer ' + TOKEN;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(BASE + path, opts);
    let data = null; try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
}
async function main() {
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    TOKEN = login.data.accessToken;

    let shiftId = null, shiftType = 'ليل', shiftDate = '2026-07-24';
    const cur = await api('GET', '/api/current-shift');
    if (cur.data && cur.data.shift && cur.data.shift.id) {
        shiftId = cur.data.shift.id;
        shiftType = cur.data.shift.type || shiftType;
        shiftDate = cur.data.shift.date || shiftDate;
    } else {
        const s = await api('POST', '/api/start-new-shift', { shiftType: 'ليل' });
        shiftId = s.data && s.data.shiftId;
    }
    console.log('shiftId=', shiftId, shiftType, shiftDate);
    const ev = (events, notes) => api('POST', '/api/shift-completion', notes ? { shiftType, shiftDate, events, notes } : { shiftType, shiftDate, events });

    const st = await api('GET', `/api/staffing/state?shift_id=${shiftId}`);
    const teams = (st.data && st.data.teams) || {};
    const keys = Object.keys(teams).filter(k => (teams[k].members || []).filter(m => m.role === 'base').length >= 2);
    const [k1, k2, k3] = keys;
    const m1 = teams[k1].members.filter(m => m.role === 'base').map(m => m.name);
    const m2 = teams[k2].members.filter(m => m.role === 'base').map(m => m.name);
    const m3 = teams[k3].members.filter(m => m.role === 'base').map(m => m.name);
    console.log('teams:', k1, '|', k2, '|', k3);

    // k1: غياب + تأخير ثم حضور (مصحح بمدة 40 دقيقة) ثم قرار ناقصة
    await ev([{ type: 'absence', employeeName: m1[0], reason: 'غياب', teamId: k1 }]);
    await ev([{ type: 'late', employeeName: m1[1], reason: 'تأخير', teamId: k1 }]);
    await ev([{ type: 'arrival', employeeName: m1[1], teamId: k1 }]);
    await ev([{ type: 'correction', employeeName: m1[1], teamId: k1, arrivalAt: new Date(Date.now() + 40 * 60000).toISOString() }]);
    await ev([{ type: 'missing', teamId: k1, reason: 'نقص كادر' }]);

    // k2: غياب يُغطى بدعم شخص من k3 ثم قرار جاهزة ⇒ «جاهزة (تم تغطية النقص)»
    await ev([{ type: 'absence', employeeName: m2[0], reason: 'إجازة', teamId: k2 }]);
    await ev([{ type: 'external_support', employeeName: m3[0], teamId: k2 }]);
    await ev([{ type: 'ready', teamId: k2 }]);

    // k3: خارج الخدمة بسبب تعطل المركبة
    await ev([{ type: 'offline', teamId: k3, reason: 'تعطل المركبة' }]);

    // مركبات: تعيين عاملة + متعطلة بسبب
    const board = await api('GET', `/api/vehicles/board?shift_id=${shiftId}`);
    const un = (board.data && board.data.unassigned) || [];
    if (un[0]) await api('POST', '/api/vehicles/assignment', { vehicleId: un[0].id, teamId: 1 });
    if (un[1]) await api('POST', '/api/vehicles/events', { vehicleId: un[1].id, status: 'breakdown', reason: 'عطل ميكانيكي — بانتظار الورشة' });

    // ملاحظات التكميل
    await ev([], 'تأخر وصول مركبة الورشة — تمت المتابعة مع الصيانة. تم توزيع التغطية مؤقتًا حتى وصول الدعم.');

    // سير العمل: لقطة جديدة + حقول المشرف
    const prep = await api('POST', '/api/workflow/prepare');
    const wf = prep.data && prep.data.workflow;
    console.log('workflow=', wf && wf.id, 'V' + (wf && wf.versionNo), 'lateRecords=', wf && wf.snapshot && Array.isArray(wf.snapshot.lateRecords) ? wf.snapshot.lateRecords.length : '—');
    if (wf) await api('PUT', `/api/workflow/version/${wf.id}`, {
        summary: 'مناوبة اعتيادية، اكتمل التكميل، نقص واحد عولج بدعم مؤقت.',
        operationalNotes: 'تعطل مركبة — بلاغ صيانة مرفوع.',
        keyEvents: 'لا توجد أحداث جوهرية حتى وقت إعداد سير العمل.',
        issues: 'نقص الكادر بسبب غياب غير مُبلّغ.',
        recommendations: '☑ يحتاج متابعة الصيانة\n☑ رفع بلاغ للإدارة\n—\nمتابعة بلاغ الصيانة، والتنبيه على الإبلاغ المبكر عن الغياب.',
        reviewedBy: ['مشرف العمليات']
    });
    console.log('تم البذر — السيرفر جاهز للقطات على', BASE + '/workflow.html');
}
main().catch(e => { console.error(e); process.exit(1); });
