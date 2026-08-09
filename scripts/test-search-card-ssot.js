/* ==========================================
   اختبار البند الثاني — البحث وبطاقة الموظف من المصدر الموحد (SSOT)
   test-search-card-ssot.js
   ==========================================
   يعمل على بيئة معزولة (PORT 3084) مع JSON مسموم عمدًا:
   - اسم مزيف + رمز خاطئ في schedule-employees.json
   يثبت أن البحث والبطاقة يقرآن من قاعدة البيانات فقط.
*/
const BASE = process.env.BASE_URL || 'http://localhost:3084';
let TOKEN = null, passed = 0, failed = 0;

function record(name, ok, detail) {
    if (ok) { passed++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
    else { failed++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (e) { }
    return { status: res.status, data, ok: res.status < 400 };
}

(async () => {
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    if (!login.data || !login.data.accessToken) { console.error('فشل الدخول'); process.exit(1); }
    TOKEN = login.data.accessToken;
    console.log('🔐 تم تسجيل الدخول\n');

    // ─── 1) البحث بالاسم ───
    const byName = await api('GET', '/api/employees/search?q=' + encodeURIComponent('زياد سعيد'));
    record('① البحث بالاسم يجد الموظف من القاعدة', byName.ok && byName.data.results.some(r => String(r.employee_code) === '61277'),
        `results=${byName.data && byName.data.results && byName.data.results.length}`);

    // ─── 2) البحث بالكود الوظيفي ───
    const byCode = await api('GET', '/api/employees/search?q=61277');
    record('② البحث بالكود الوظيفي يجد نفس الموظف', byCode.ok && byCode.data.results.some(r => r.name.includes('زياد سعيد')),
        `results=${byCode.data && byCode.data.results && byCode.data.results.length}`);

    // ─── 3) JSON مسموم بالاسم لا يؤثر في البحث ───
    const fake = await api('GET', '/api/employees/search?q=' + encodeURIComponent('اسم مزيف'));
    record('③ الاسم المزيف في JSON لا يظهر في البحث (المصدر = القاعدة)', fake.ok && fake.data.results.length === 0,
        `results=${fake.data && fake.data.results && fake.data.results.length}`);

    // ─── 4) بطاقة الموظف: كل الحقول المطلوبة ───
    const card = await api('GET', '/api/employees/61277/profile');
    const e = card.data && card.data.employee;
    const hasAll = e && e.name && e.code && ('phone' in e) && ('jobTitle' in e) && ('patternCode' in e)
        && Array.isArray(card.data.roster) && Array.isArray(card.data.leaves) && ('team' in card.data);
    record('④ البطاقة تعرض: الاسم/الكود/المسمى/الجوال/الفرقة/Pattern/المناوبات/الإجازات', card.ok && hasAll,
        e ? `${e.name} | ${e.code} | ${e.jobTitle} | ${e.phone}` : 'no employee');

    // ─── 5) مناوبات البطاقة مطابقة حرفيًا لمصدر الجدول الكلاسيكي (shift_roster) ───
    const roster = await api('GET', '/api/shift-roster');
    const emps = await api('GET', '/api/employees');
    const dbEmp = emps.data.employees.find(x => x.employee_code === '61277');
    const gridMap = {};
    roster.data.roster.filter(r => r.employee_id === dbEmp.id && r.shift_date.startsWith('2026-08'))
        .forEach(r => { gridMap[r.shift_date] = r.shift_code; });
    const cardMap = {};
    (card.data.roster || []).forEach(r => { cardMap[r.shift_date] = r.shift_code; });
    const dates = Object.keys(gridMap);
    const mismatch = dates.filter(d => gridMap[d] !== cardMap[d]);
    record('⑤ مناوبات البطاقة ≡ الجدول الكلاسيكي حرفيًا (' + dates.length + ' يوم)', dates.length > 0 && mismatch.length === 0,
        mismatch.length ? 'اختلاف: ' + mismatch.slice(0, 3).join(',') : 'تطابق كامل');

    // ─── 6) الرمز المسموم في JSON لا يؤثر في البطاقة ───
    record('⑥ الرمز الخاطئ في JSON (WO) لا يظهر — البطاقة تعرض N12 من القاعدة',
        cardMap['2026-08-01'] === 'N12',
        `card=${cardMap['2026-08-01']} | grid=${gridMap['2026-08-01']} | json=WO`);

    // ─── 7) الجوال من المصدر الموحد ───
    record('⑦ الجوال في البطاقة من employees.phone', e && e.phone === '0557217742',
        `phone=${e && e.phone}`);

    // ─── 8) employee-schedule بنجاح فارغ = حقيقة (لا سقوط) ───
    const emptySched = await api('GET', '/api/shift-roster/employee-schedule/61277?month=1&year=2030');
    record('⑧ شهر بلا مناوبات: الخادم ينجح بجدول فارغ (تعرضه الواجهة «لا توجد مناوبات»)',
        emptySched.ok && emptySched.data.success && Array.isArray(emptySched.data.schedule) && emptySched.data.schedule.length === 0,
        `len=${emptySched.data && emptySched.data.schedule && emptySched.data.schedule.length}`);

    // ─── 9) الثبات بعد إعادة المصادقة (إعادة فتح الصفحة) ───
    const relogin = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    TOKEN = relogin.data.accessToken;
    const again = await api('GET', '/api/employees/search?q=61277');
    const againCard = await api('GET', '/api/employees/61277/profile');
    record('⑨ النتائج ثابتة بعد إعادة الفتح (بحث + بطاقة من القاعدة)',
        again.ok && again.data.results.length > 0 && againCard.data.roster.some(r => r.shift_date === '2026-08-01' && r.shift_code === 'N12'),
        'ثابتة');

    console.log(`\n═══ النتيجة: ${passed}/${passed + failed} ناجح ═══`);
    process.exit(failed ? 1 : 0);
})().catch(err => { console.error('خطأ عام:', err); process.exit(1); });
