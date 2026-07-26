// مسبار وظيفي: إصلاح خطأ «تطوع» + سجل الدعم الاحترافي (بيئة معزولة فقط)
// يتحقق: قبول volunteer_support، قبول external_support، ظهور الحقول الخمسة في staffing/state،
// منع التكرار، إنهاء التغطية — ثم ينظّف أحداثه.
const BASE = process.env.BASE_URL || 'http://localhost:3081';
const SHIFT = { id: 1784126563155, type: 'صباح', date: '2026-07-22' };
const NAME = 'موظف تحقق تطوع';
const NAME2 = 'موظف تحقق خارجي';

let TOKEN = null;
let pass = 0, fail = 0;
function rec(label, ok, detail) {
    if (ok) pass++; else fail++;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + (detail ? ' | ' + detail : ''));
}
async function api(method, path, body) {
    const res = await fetch(BASE + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    return { status: res.status, ok: res.ok, data };
}

(async () => {
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    TOKEN = login.data && login.data.accessToken;
    if (!TOKEN) { console.log('فشل الدخول'); process.exit(1); }

    // اكتشف المناوبة النشطة فعليًا (المسار يحلّها سيرفريًا وقد لا يطابق التاريخ المرسل)
    const st0 = await api('GET', '/api/staffing/state');
    const ACTIVE_SHIFT = st0.data && st0.data.shiftId;
    if (!ACTIVE_SHIFT) { console.log('لا توجد مناوبة نشطة'); process.exit(1); }
    console.log('المناوبة النشطة: ' + ACTIVE_SHIFT);

    // ① تطوع — كان يرفض سابقًا (400 نوع غير صالح)
    const v = await api('POST', '/api/shift-completion', {
        shiftType: SHIFT.type, shiftDate: SHIFT.date,
        events: [{ type: 'volunteer_support', employeeName: NAME, teamId: 'جنوب 1', center: 'الاحتياط', coverageType: 'volunteer', jobTitle: 'فني إسعاف', employeeNumber: '99999' }]
    });
    rec('تطوع: الحفظ ينجح (كان 400 سابقًا)', v.ok && v.data && v.data.success && v.data.appended === 1, `status=${v.status} appended=${v.data && v.data.appended} err=${v.data && v.data.error || ''}`);

    // ② دعم من مركز آخر — كان يعمل ويجب أن يبقى
    const x = await api('POST', '/api/shift-completion', {
        shiftType: SHIFT.type, shiftDate: SHIFT.date,
        events: [{ type: 'external_support', employeeName: NAME2, teamId: 'جنوب 2', center: 'المنصورة', coverageType: 'external', jobTitle: 'أخصائي إسعاف', employeeNumber: '88888' }]
    });
    rec('دعم مركز آخر: الحفظ ينجح', x.ok && x.data && x.data.success && x.data.appended === 1, `status=${x.status}`);

    // ③ staffing/state — الحقول الخمسة كاملة من نفس المصدر
    const st = await api('GET', '/api/staffing/state?shift_id=' + ACTIVE_SHIFT);
    const teams = (st.data && (st.data.teams || st.data)) || {};
    const t1 = teams['جنوب 1'] || {};
    const t2 = teams['جنوب 2'] || {};
    const s1 = (t1.members || []).find(m => m.role === 'support' && m.name === NAME);
    const s2 = (t2.members || []).find(m => m.role === 'support' && m.name === NAME2);
    rec('تطوع: يظهر في جنوب 1 كداعم', !!s1);
    rec('تطوع: المسمى الوظيفي', s1 && s1.jobTitle === 'فني إسعاف', s1 && s1.jobTitle);
    rec('تطوع: الكود الوظيفي', s1 && String(s1.code) === '99999', s1 && String(s1.code));
    rec('تطوع: المركز القادم منه', s1 && s1.fromCenter === 'الاحتياط', s1 && s1.fromCenter);
    rec('تطوع: نوع الدعم', s1 && s1.supportType === 'volunteer_support' && s1.coverageType === 'volunteer', s1 && (s1.supportType + '/' + s1.coverageType));
    rec('خارجي: يظهر في جنوب 2 بالحقول', !!s2 && s2.jobTitle === 'أخصائي إسعاف' && String(s2.code) === '88888' && s2.fromCenter === 'المنصورة' && s2.supportType === 'external_support', s2 && (s2.supportType + '/' + s2.coverageType));

    // ④ منع التكرار — نفس التطوع مرة ثانية = صفر إلحاق
    const v2 = await api('POST', '/api/shift-completion', {
        shiftType: SHIFT.type, shiftDate: SHIFT.date,
        events: [{ type: 'volunteer_support', employeeName: NAME, teamId: 'جنوب 1', center: 'الاحتياط', coverageType: 'volunteer' }]
    });
    rec('تطوع مكرر: لا إلحاق مكرر', v2.ok && v2.data && v2.data.appended === 0, `appended=${v2.data && v2.data.appended}`);

    // ⑤ إنهاء التغطية يغلق التطوع
    const end = await api('POST', '/api/shift-completion', {
        shiftType: SHIFT.type, shiftDate: SHIFT.date,
        events: [{ type: 'support_end', employeeName: NAME, teamId: 'جنوب 1' }]
    });
    rec('إنهاء تغطية التطوع ينجح', end.ok && end.data && end.data.appended === 1, `appended=${end.data && end.data.appended}`);
    const st2 = await api('GET', '/api/staffing/state?shift_id=' + ACTIVE_SHIFT);
    const t1b = ((st2.data && (st2.data.teams || st2.data)) || {})['جنوب 1'] || {};
    rec('التطوع اختفى بعد الإنهاء', !(t1b.members || []).some(m => m.role === 'support' && m.name === NAME));

    // ⑥ تنظيف: إنهاء الدعم الخارجي حتى تعود القاعدة المعزولة كما كانت
    await api('POST', '/api/shift-completion', {
        shiftType: SHIFT.type, shiftDate: SHIFT.date,
        events: [{ type: 'support_end', employeeName: NAME2, teamId: 'جنوب 2' }]
    });

    console.log(`\n=== ${pass} passed, ${fail} failed ===`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
