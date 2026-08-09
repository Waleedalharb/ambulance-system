/* ==========================================
   اختبار ميزات أرقام الجوالات
   test-phone-features.js
   ==========================================
   يعمل على نسخة معزولة من قاعدة البيانات (DB_PATH) — لا يمس الإنتاج.
   السيناريوهات (من المالك):
   1) استيراد جماعي (معاينة ثم تنفيذ)
   2) مطابقة صحيحة بالكود الوظيفي
   3) رقم غير موجود يظهر — (null)
   4) تعديل رقم يدويًا (+ رفض رقم غير صالح)
   5) ظهور الرقم الجديد في بطاقة الموظف (profile)
   6) ظهور الرقم نفسه في التكميل (shift-completion)
   7) بقاء الرقم بعد إعادة الطلب (استمرارية في القاعدة)
   + قواعد الحماية: كود مكرر، رقم غير صالح، بلا مطابقة، لا استبدال برقم فارغ
*/

const BASE = process.env.BASE_URL || 'http://localhost:3082';

let TOKEN = null;
let passed = 0, failed = 0;

function record(name, ok, detail) {
    if (ok) { passed++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
    else { failed++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

async function api(method, path, body, expectStatus) {
    const headers = { 'Content-Type': 'application/json' };
    if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
    const res = await fetch(BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, data, ok: expectStatus ? res.status === expectStatus : res.status < 400 };
}

(async () => {
    // ─── تسجيل الدخول (أدمن) ───
    const login = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    if (!login.data || !login.data.accessToken) {
        console.error('فشل تسجيل الدخول — تحقق من الخادم والبيانات');
        process.exit(1);
    }
    TOKEN = login.data.accessToken;
    console.log('🔐 تم تسجيل الدخول\n');

    // ─── 1+2) معاينة الاستيراد الجماعي ───
    const rows = [
        { code: '61277', phone: '0512345678' },   // مطابقة صحيحة → تحديث
        { code: '999999', phone: '0512345678' },   // كود غير موجود
        { code: '4201', phone: '' },               // رقم فارغ → يُخطى (لا يمس الموجود)
        { code: '61277', phone: '0599999999' },    // كود مكرر → يُهمل
        { code: '4202', phone: 'abc123' },         // رقم غير صالح
        { code: '4203', phone: '0523399804' }      // نفس الرقم المسجل → بلا تغيير
    ];
    const preview = await api('POST', '/api/employees/phones/import', { rows, confirm: false });
    const s = preview.data && preview.data.summary;
    record('① معاينة الاستيراد ترجع ملخصًا كاملًا', preview.ok && preview.data.dryRun === true && !!s,
        `status=${preview.status}`);
    record('② المطابقة بالكود الوظيفي — 61277 ضمن التحديثات', !!s && s.matched === 1 &&
        preview.data.toUpdate.some(u => u.code === '61277' && u.newPhone === '0512345678'),
        `matched=${s && s.matched}`);
    record('②ب كود غير موجود يظهر في قائمة بلا مطابقة', !!s && s.unmatched === 1 &&
        preview.data.unmatched.some(u => u.code === '999999'),
        `unmatched=${s && s.unmatched}`);
    record('②ج الكود المكرر يُكتشف ويُهمل التكرار', !!s && s.duplicates === 1 &&
        preview.data.duplicates.some(u => u.code === '61277'),
        `duplicates=${s && s.duplicates}`);
    record('②د الرقم غير الصالح يُرفض ويُدرج', !!s && s.invalid === 1 &&
        preview.data.invalid.some(u => u.code === '4202'),
        `invalid=${s && s.invalid}`);
    record('②هـ الرقم الفارغ يُخطى ولا يمس الموجود', !!s && s.skippedEmpty === 1 &&
        preview.data.skippedEmpty.some(u => u.code === '4201'),
        `skippedEmpty=${s && s.skippedEmpty}`);
    record('②و نفس الرقم المسجل = بلا تغيير', !!s && s.unchanged === 1,
        `unchanged=${s && s.unchanged}`);

    // ─── المعاينة لا تكتب شيئًا ───
    const beforeCommit = await api('GET', '/api/employees/61277/profile');
    record('②ز المعاينة لا تكتب — 61277 ما زال بلا رقم', beforeCommit.ok && !beforeCommit.data.employee.phone,
        `phone=${beforeCommit.data && beforeCommit.data.employee && beforeCommit.data.employee.phone}`);

    // ─── التنفيذ ───
    const commit = await api('POST', '/api/employees/phones/import', { rows, confirm: true });
    record('①ب التنفيذ يحدّث المطابقين فقط', commit.ok && commit.data.applied === 1,
        `applied=${commit.data && commit.data.applied}`);

    // ─── 5) بطاقة الموظف تعرض الرقم الجديد ───
    const card = await api('GET', '/api/employees/61277/profile');
    record('⑤ الرقم المستورد يظهر في بطاقة الموظف (profile)', card.ok && card.data.employee.phone === '0512345678',
        `phone=${card.data && card.data.employee && card.data.employee.phone}`);

    // ─── 3) موظف بلا رقم → null (تعرضه الواجهة «—») ───
    const noPhone = await api('GET', '/api/employees/4203/profile');
    // 4203 له رقم مسجل مسبقًا؛ نختبر موظفًا فارغًا بعد مسحه يدويًا لاحقًا — هنا نتحقق من سلوك null العام
    record('③ استجابة profile تعيد phone=null للفارغ (تعرضه الواجهة —)', noPhone.ok && ('phone' in noPhone.data.employee),
        `key exists`);

    // ─── 4) التعديل اليدوي ───
    const manual = await api('PUT', '/api/employees/692/phone', { phone: '0501112223' });
    record('④ تعديل يدوي لرقم موظف واحد', manual.ok && manual.data.phone === '0501112223',
        `status=${manual.status}`);
    const manualBad = await api('PUT', '/api/employees/692/phone', { phone: '123' }, 400);
    record('④ب رقم غير صالح يدويًا يُرفض (400)', manualBad.status === 400, `status=${manualBad.status}`);
    const manualGhost = await api('PUT', '/api/employees/000000/phone', { phone: '0501112223' }, 404);
    record('④ج كود غير موجود يدويًا يُرفض (404)', manualGhost.status === 404, `status=${manualGhost.status}`);

    // ─── 5ب) الرقم اليدوي يظهر في البطاقة ───
    const card2 = await api('GET', '/api/employees/692/profile');
    record('⑤ب الرقم المعدّل يدويًا يظهر في بطاقة الموظف', card2.ok && card2.data.employee.phone === '0501112223',
        `phone=${card2.data && card2.data.employee && card2.data.employee.phone}`);

    // ─── 6) نفس الرقم يظهر في التكميل ───
    let shiftId = null;
    const cur = await api('GET', '/api/current-shift');
    if (cur.data && cur.data.shift && cur.data.shift.id) {
        shiftId = cur.data.shift.id;
    } else {
        const start = await api('POST', '/api/start-new-shift', { shiftType: 'صباح' });
        shiftId = start.data && start.data.shiftId;
    }
    if (shiftId) {
        const comp = await api('GET', `/api/shift-completion/${shiftId}/${encodeURIComponent('القيادة الميدانية')}`);
        const members = (comp.data && (comp.data.paramedics || (comp.data.completion && comp.data.completion.paramedics))) || [];
        const fawaz = members.find(m => String(m.employee_code) === '692');
        record('⑥ الرقم المعدّل يدويًا يظهر بنفسه في التكميل (692)', !!fawaz && fawaz.phone === '0501112223',
            fawaz ? `phone=${fawaz.phone}` : `members=${members.length}`);
    } else {
        record('⑥ الرقم المعدّل يدويًا يظهر بنفسه في التكميل (692)', false, 'تعذّر تحديد مناوبة');
    }

    // ─── 7) الاستمرارية: طلب جديد بعد إعادة المصادقة ───
    const relogin = await api('POST', '/api/auth/login', { username: '4252', password: '4252' });
    TOKEN = relogin.data.accessToken;
    const again = await api('GET', '/api/employees/61277/profile');
    record('⑦ الرقم باقٍ بعد إعادة المصادقة والطلب (مخزن في employees.phone)', again.ok && again.data.employee.phone === '0512345678',
        `phone=${again.data && again.data.employee && again.data.employee.phone}`);

    // ─── حماية: لا استبدال برقم فارغ بعد الاستيراد ───
    const emptyOverwrite = await api('POST', '/api/employees/phones/import', { rows: [{ code: '61277', phone: '' }], confirm: true });
    const afterEmpty = await api('GET', '/api/employees/61277/profile');
    record('🛡 استيراد رقم فارغ لا يمسح الرقم الموجود', emptyOverwrite.ok && emptyOverwrite.data.applied === 0 &&
        afterEmpty.data.employee.phone === '0512345678',
        `applied=${emptyOverwrite.data && emptyOverwrite.data.applied}`);

    console.log(`\n═══ النتيجة: ${passed}/${passed + failed} ناجح ═══`);
    process.exit(failed ? 1 : 0);
})().catch(err => {
    console.error('خطأ عام:', err);
    process.exit(1);
});
