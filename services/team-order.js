/**
 * فرز الفرق الرقمي الطبيعي — الموضع المركزي الوحيد (doc-v4 البند ⑫)
 * ═══════════════════════════════════════════════════════════
 * المفتاح: البادئة النصية (عربي) ثم الرقم المستخرج من الاسم رقميًا:
 *   جنوب 1، جنوب 2، …، جنوب 9، جنوب 10، …، جنوب 19، سريع 1، سريع 2، …
 * لا فرز نصي أبجدي (النصي كان يضع «جنوب 10» قبل «جنوب 2»).
 * يُستدعى من staffing-events-service (اشتقاق الحالة المركزي) فترثه
 * كل الشاشات والوثيقة تلقائيًا — ممنوع تكرار هذا المنطق في أي موضع آخر.
 */
function teamOrderKey(name) {
    const m = /^(.*?)(\d+)\s*$/.exec(String(name || '').trim());
    if (!m) return { prefix: String(name || ''), num: Number.MAX_SAFE_INTEGER };
    return { prefix: m[1].trim(), num: parseInt(m[2], 10) };
}
// رتب ثابتة للفرق غير الرقمية (W-تكامل): القيادة ← التحكم/التنسيق ← بقية الفرق.
// لا يغيّر ترتيب أي اسم آخر إطلاقًا (جنوب/سريع/الأسماء القديمة كلها رتبة واحدة).
const FIXED_RANK = {
    'القيادة الميدانية': 0, 'القيادة': 0,
    'التحكم العملياتي': 1, 'تنسيق الاستجابة': 2,
    'الدعم اللوجستي': 3 // قرار المالك: بجوار العمليات والقيادة
};
function teamRank(name) {
    const r = FIXED_RANK[String(name || '').trim()];
    return r === undefined ? 10 : r;
}
function compareTeamNames(a, b) {
    const ra = teamRank(a), rb = teamRank(b);
    if (ra !== rb) return ra - rb;
    const ka = teamOrderKey(a);
    const kb = teamOrderKey(b);
    const p = ka.prefix.localeCompare(kb.prefix, 'ar');
    return p !== 0 ? p : ka.num - kb.num;
}
/** نسخة مرتبة من الصفوف — nameFn يستخرج الاسم من الصف (افتراضيًا الصف نفسه اسم) */
function sortTeamsNatural(rows, nameFn) {
    const get = typeof nameFn === 'function' ? nameFn : (r) => r;
    return (rows || []).slice().sort((x, y) => compareTeamNames(get(x), get(y)));
}
module.exports = { teamOrderKey, compareTeamNames, sortTeamsNatural };
