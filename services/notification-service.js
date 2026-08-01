/**
 * NotificationService — الطبقة المركزية الوحيدة لإنشاء الإشعارات
 * ═══════════════════════════════════════════════════════════
 * جولة «ربط الإشعارات بالأحداث التشغيلية + التمييز تشغيلي/شخصي» (تفويض المستخدم).
 *
 * قبل هذه الجولة كانت مواضع الإنشاء السبعة في server.js: ستة منها تكرر كتلة
 * fan-out نفسها (قراءة users.json ← ترشيح admin/director النشط ← إنشاء صف
 * لكلٍّ منهم) وتخزّن type: 'info' دائمًا بصرف النظر عن طبيعة الحدث. الآن:
 *
 * ① خريطة الحدث ← النوع (EVENT_TYPE_MAP) معيار ثابت حرفي من خريطة المستخدم:
 *    🟢 success = اعتماد/اكتمال («تم اعتماد سير العمل»)
 *    🟡 warning = تغيير جدول/تمركز («تم تغيير تمركز جنوب 8»)
 *    🔵 info    = إشعار عام («تم تسجيل دخول مستخدم جديد»)
 *    🔴 danger  = عاجل («تم تسجيل مركبة خارج الخدمة»)
 *    ممنوع نوع خامس. السقوط الآمن info بلا خطأ عند حدث غير معروف.
 *
 * ② التمييز تشغيلي/شخصي بلا أي تغيير مخطط — النموذج القائم يدعمه أصلًا
 *    (user_id لكل صف + getByUser مقيّد بالمستخدم + broadcastToUsers موجَّه D-21):
 *    - تشغيلي (notifyOperational): fan-out صفًا لكل admin/director نشط — نمط
 *      «حسب الصلاحيات» القائم حرفيًا. صف البث العام المشترك (user_id NULL)
 *      مرفوض وموثق: is_read لكل صف، فوجود صف مشترك يجعل قراءة أحدهم تُخفي
 *      الإشعار عن الباقين وتكسر عداد غير المقروء لكلٍّ منهم.
 *    - شخصي (notifyPersonal / مسار POST /api/notifications): صف واحد لصاحبه
 *      + بث موجَّه للمستهدف فقط.
 *
 * ③ الأحداث المفوَّضة حاليًا بلا موضع إنشاء قائم (تغيير تمركز، مركبة خارج
 *    الخدمة، اعتماد سير العمل، فشل اعتماد، تسجيل دخول، تسجيل دعم، إيصالات
 *    قراءة الرسائل، قبول النماذج) لا تُخترع لها إشعارات — تُوثَّق كفجوات
 *    في تقرير الجولة، وخريطتها هنا جاهزة متى أُضيف موضعها.
 */

const fs = require('fs').promises;
const path = require('path');

// الأنواع الأربعة القانونية — لا خامس لها (معيار خريطة المستخدم الثابت)
const VALID_TYPES = Object.freeze(['success', 'warning', 'info', 'danger']);

// أسماء مستعارة واردة من واجهات قديمة — تُحسم إلى الأنواع الأربعة ولا تُخزَّن كما هي
const TYPE_ALIASES = Object.freeze({ urgent: 'danger', error: 'danger', alert: 'warning' });

// سياسة منع التكرار (تفويض المستخدم صراحة — جولة توصيل الأحداث):
// نفس الحدث على نفس الكيان خلال النافذة لا يملأ القائمة بإشعارات متطابقة.
// المفتاح = (المستخدم + العنوان + الرسالة) — الرسالة تحمل اسم الكيان حرفيًا
// («تم تغيير تمركز: جنوب 8») فتطابقها = تطابق الحدث والكيان معًا.
// النافذة = 5 دقائق (ثابت قابل للضبط هنا). السلوك المختار والموثق:
// **تحديث وقت الإشعار القائم** (touch) بدل إنشاء صف جديد — القائمة تبقى
// بصف واحد يعكس أحدث وقوع، وحالة القراءة لا تُمس. الأحداث 🔴 الحرجة تخضع
// للسياسة نفسها: النبضة المكررة لنفس المركبة داخل النافذة تحديث وقت فقط،
// أما الحالة الجديدة فعلًا (مركبة أخرى، أو تكرار بعد انقضاء النافذة) فصف
// جديد مستحق. تسري على notifyOperational (الأحداث) فقط — الإرسال اليدوي
// الشخصي عبر notifyPersonal يمر كما أرسله القيادي (فعل مقصود لا نبضة حدث).
const DEDUPE_WINDOW_MINUTES = 5;

// خريطة الحدث التشغيلي ← النوع (حرفية من خريطة المستخدم)
const EVENT_TYPE_MAP = Object.freeze({
    'report.entry_added':     'danger',  // بلاغ جديد — يتطلب انتباه غرفة العمليات فورًا
    'vehicle.out_of_service': 'danger',  // «تم تسجيل مركبة خارج الخدمة» — مثال المستخدم حرفيًا
    'workflow.approved':      'success', // «تم اعتماد سير العمل» — مثال المستخدم حرفيًا
    'archive.completed':      'success', // اكتمال أرشفة المناوبة — حدث قليل التكرار (🟢)
    'shift.updated':          'warning', // تغيير جدول/مناوبة
    'positioning.changed':    'warning', // «تم تغيير تمركز جنوب 8» — مثال المستخدم حرفيًا
    'staffing.changed':       'warning', // تغيير حالة فرقة (انتقال جاهزية فعلي فقط)
    'approval.failed':        'warning', // فشل اعتماد
    'doc.uploaded':           'info',    // مستند جديد — إشعار عام
    'identity.updated':       'info',    // تحديث هوية القطاع — إشعار عام
    'ops_files.uploaded':     'info',    // ملفات تشغيلية جديدة — إشعار عام
    'user.login':             'info',    // «تم تسجيل دخول مستخدم جديد» — مثال المستخدم حرفيًا
    'support.recorded':       'info'     // تسجيل دعم — إشعار عام
});

// تصنيف حدث — سقوط آمن info بلا خطأ عند مفتاح غير معروف
function classify(eventKey) {
    return EVENT_TYPE_MAP[eventKey] || 'info';
}

// تطبيع نوع صريح (من API مثلًا): يقبل الأنواع الأربعة والأسماء المستعارة، ويسقط info
function normalizeType(type) {
    if (VALID_TYPES.includes(type)) return type;
    if (TYPE_ALIASES[type]) return TYPE_ALIASES[type];
    return 'info';
}

// الاعتماديات تُحقن من server.js عبر init (usersPath + getDb + broadcastToUsers).
// الافتراضي يكرر اصطلاح STORAGE_PATH نفسه ليعمل standalone في الاختبارات.
let _deps = null;
function init(deps) { _deps = deps; }
function resolveDeps() {
    if (_deps) {
        return {
            usersPath: _deps.usersPath,
            db: typeof _deps.getDb === 'function' ? _deps.getDb() : _deps.db,
            broadcastToUsers: _deps.broadcastToUsers
        };
    }
    const storage = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    return { usersPath: path.join(storage, 'users.json'), db: require('../db.js'), broadcastToUsers: null };
}

// إشعار تشغيلي: صف لكل admin/director نشط (fan-out — النمط القائم حرفيًا)
// مع منع التكرار الموثق أعلاه (dedupeKey = مستخدم+عنوان+رسالة داخل النافذة).
// يُستدعى تحت حارس dbAvailable() && db.Notifications في المواضع كما كان.
async function notifyOperational({ eventKey, title, message }) {
    const d = resolveDeps();
    const type = classify(eventKey);
    const users = JSON.parse(await fs.readFile(d.usersPath, 'utf8'));
    const targets = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
    let created = 0, deduped = 0;
    for (const t of targets) {
        const uid = t.id.toString();
        const existing = await d.db.Notifications.findRecentMatch(uid, title, message, DEDUPE_WINDOW_MINUTES);
        if (existing) {
            // تكرار داخل النافذة: تحديث وقت الصف القائم (لا صف مكرر، القراءة لا تُمس)
            await d.db.Notifications.touch(existing.id);
            deduped++;
        } else {
            await d.db.Notifications.create({ user_id: uid, title, message, type });
            created++;
        }
    }
    return { created, deduped, type };
}

// إشعار شخصي: صف واحد لصاحبه + بث موجَّه للمستهدف فقط (D-21).
// النوع: eventKey يُصنَّف عبر الخريطة إن وُجد، وإلا يُطبَّع type الصريح.
async function notifyPersonal(userId, { eventKey, title, message, type }) {
    const d = resolveDeps();
    const finalType = eventKey ? classify(eventKey) : normalizeType(type);
    const targetUserId = String(userId);
    const id = await d.db.Notifications.create({ user_id: targetUserId, title, message: message || '', type: finalType });
    if (typeof d.broadcastToUsers === 'function') {
        d.broadcastToUsers([targetUserId], {
            type: 'notification_created',
            message: 'تم إنشاء إشعار جديد',
            notification: { id, user_id: targetUserId, title, message: message || '', type: finalType }
        });
    }
    return { id, type: finalType };
}

module.exports = {
    VALID_TYPES,
    TYPE_ALIASES,
    EVENT_TYPE_MAP,
    DEDUPE_WINDOW_MINUTES,
    classify,
    normalizeType,
    init,
    notifyOperational,
    notifyPersonal
};
