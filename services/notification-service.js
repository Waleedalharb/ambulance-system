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
    'support.recorded':       'info',    // تسجيل دعم — إشعار عام
    'leave.submitted':        'warning', // طلب إجازة جديد ينتظر قرارًا — يؤثر في الجدول
    'shift_change.submitted': 'warning'  // طلب تغيير مناوبة جديد ينتظر قرارًا — يؤثر في الجدول
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
            broadcastToUsers: _deps.broadcastToUsers,
            // requests.review (2026-09-29): فحص صلاحية اختياري يُحقن من server.js
            // عبر getPermissionService — يُستخدم فقط عند تمرير permKey صراحة.
            hasPermission: typeof _deps.hasPermission === 'function' ? _deps.hasPermission : null,
            // v6: بوابة APNs الاختيارية — غيابها = بلا Push وبلا أي تغيير سلوك
            pushGateway: _deps.pushGateway || null
        };
    }
    const storage = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    return { usersPath: path.join(storage, 'users.json'), db: require('../db.js'), broadcastToUsers: null, hasPermission: null };
}

// إشعار تشغيلي: صف لكل admin/director نشط (fan-out — النمط القائم حرفيًا)
// مع منع التكرار الموثق أعلاه (dedupeKey = مستخدم+عنوان+رسالة داخل النافذة).
// يُستدعى تحت حارس dbAvailable() && db.Notifications في المواضع كما كان.
// push اختياري (افتراضيًا false): عند تفعيله تُرسل نسخة Push عبر البوابة
// للمستخدمين الذين أُنشئ لهم صف فعلًا فقط — التكرار داخل النافذة (touch)
// لا يُزعج الجهاز مرة ثانية. البوابة لا ترمي أبدًا (وضع معطَّل آمن بلا مفاتيح)،
// وفشلها لا يمس الصفوف المنشأة ولا البث — الطلب لا يُفقد حتى لو فشل Push.
//
// permKey (2026-09-29 — معتمد): عند تمريره يُحدَّد المستلمون بالصلاحية عبر
// hasPermission المحقونة (افتراضي الدور + المنح/السحب الفردية، والنجمة تمر
// بحكم السياسة) بدل فلتر الدور القديم. يُستخدم حاليًا من leave.submitted و
// shift_change.submitted فقط ('requests.review') — بقية الأحداث التشغيلية
// تبقى على الفلتر القديم حرفيًا حتى تعتمد مصفوفة استهدافها بقرار منفصل.
// حسم صارم (تعديل معتمد 2026-09-29): permKey موجود + hasPermission غير محقونة
// ← صفر مستلمين وتحذير واضح — ممنوع الرجوع لفلتر admin/director القديم مع
// permKey كي لا يصل الإشعار لغير المخوَّلين بسبب حقن ناقص. وبلا permKey
// أصلًا يبقى الفلتر القديم كما هو تمامًا.
async function notifyOperational({ eventKey, title, message, push, permKey }) {
    const d = resolveDeps();
    const type = classify(eventKey);
    const users = JSON.parse(await fs.readFile(d.usersPath, 'utf8'));
    const byPermission = Boolean(permKey);
    if (byPermission && typeof d.hasPermission !== 'function') {
        console.error('notifyOperational: permKey=' + permKey + ' لكن PermissionService غير محقون (hasPermission مفقودة) — صفر مستلمين، لا رجوع للفلتر القديم:', eventKey);
    }
    const targets = [];
    for (const u of users) {
        if (!u.isActive) continue;
        if (byPermission) {
            if (typeof d.hasPermission !== 'function') continue; // حقن ناقص — لا مستلمين مع permKey
            const uid = u.id != null ? u.id.toString() : '';
            if (uid && await d.hasPermission(uid, u.role, permKey)) targets.push(u);
        } else if (u.role === 'admin' || u.role === 'director') {
            targets.push(u);
        }
    }
    let created = 0, deduped = 0;
    const createdUserIds = [];
    const createdRows = []; // {uid, id} — صف كل مستهدف للبث الموجَّه
    for (const t of targets) {
        const uid = t.id.toString();
        const existing = await d.db.Notifications.findRecentMatch(uid, title, message, DEDUPE_WINDOW_MINUTES);
        if (existing) {
            // تكرار داخل النافذة: تحديث وقت الصف القائم (لا صف مكرر، القراءة لا تُمس)
            await d.db.Notifications.touch(existing.id);
            deduped++;
        } else {
            const newId = await d.db.Notifications.create({ user_id: uid, title, message, type });
            created++;
            createdUserIds.push(uid);
            createdRows.push({ uid, id: newId });
        }
    }
    // بث لحظي موجَّه (A-1): لمن أُنشئ له صف فعلًا فقط، بنفس عقد notification_created
    // الذي تعالجه الواجهة (D-21) — يظهر الإشعار على الشاشة المفتوحة بلا Refresh.
    // التكرار داخل النافذة (touch) لا يبث ولا يزعج الشاشة، تمامًا كما لا يزعج
    // الجهاز بـ Push. غياب broadcastToUsers (اختبارات) = بلا بث وبلا رمي.
    if (typeof d.broadcastToUsers === 'function') {
        for (const row of createdRows) {
            d.broadcastToUsers([row.uid], {
                type: 'notification_created',
                message: 'تم إنشاء إشعار جديد',
                notification: { id: row.id, user_id: row.uid, title, message: message || '', type }
            });
        }
    }
    let pushed = null;
    if (push === true && createdUserIds.length && d.pushGateway && typeof d.pushGateway.sendToUsers === 'function') {
        pushed = await d.pushGateway.sendToUsers(createdUserIds, {
            title, body: message || '', badge: 'auto',
            data: { kind: 'notification', event: eventKey }
        });
    }
    return { created, deduped, type, pushed };
}

// إشعار شخصي: صف واحد لصاحبه + بث موجَّه للمستهدف فقط (D-21).
// النوع: eventKey يُصنَّف عبر الخريطة إن وُجد، وإلا يُطبَّع type الصريح.
// pushExtra (بند 11 — تمركزات الذروة): حقول إضافية تُدمج في data الـPush
// (kind/plan_id) حتى يفتح الضغط على الإشعار وجهة الحدث لا قائمة الإشعارات.
//
// تدشين نظام «التمركز» (2026-09-28) — taskKey/data اختياريان إضافيان صرف:
// عند تمرير taskKey (معرّف المهمة، مثل positioning:<planId>) تصبح العملية
// Idempotent بمعرف المهمة لا بنافذة زمنية:
//   - لا صف سابق ← إنشاء عادي (مع تخزين الحمولة المهيكلة data_json).
//   - صف سابق بنفس المحتوى تمامًا (إعادة محاولة/Refresh) ← touch فقط:
//     لا صف مكرر، لا Push مكرر، وحالة القراءة لا تُمس.
//   - صف سابق بمحتوى متغيّر (تحديث/إلغاء المهمة = معلومة جديدة) ← تحديث
//     المحتوى في الصف نفسه ويعود غير مقروء + Push بالمحتوى الجديد.
// بلا taskKey يبقى السلوك القائم حرفيًا (إنشاء + بث + Push).
async function notifyPersonal(userId, { eventKey, title, message, type, taskKey, data }, pushExtra) {
    const d = resolveDeps();
    const finalType = eventKey ? classify(eventKey) : normalizeType(type);
    const targetUserId = String(userId);
    const dataJson = data != null ? JSON.stringify(data) : null;

    if (taskKey != null && d.db.Notifications && typeof d.db.Notifications.findByTaskKey === 'function') {
        const existing = await d.db.Notifications.findByTaskKey(targetUserId, taskKey);
        if (existing) {
            const unchanged = existing.title === title
                && (existing.message || '') === (message || '')
                && (existing.data_json || null) === (dataJson || null);
            if (unchanged) {
                // إعادة المحاولة: تقديم الوقت فقط — لا تكرار ولا Push ولا مسّ للقراءة
                await d.db.Notifications.touch(existing.id);
                return { id: existing.id, type: finalType, deduped: true, push: null };
            }
            // تغيّر فعلي في المهمة: نفس الصف يحمل أحدث محتوى ويعود غير مقروء
            await d.db.Notifications.updateContent(existing.id, { title, message, data_json: dataJson });
            if (typeof d.broadcastToUsers === 'function') {
                d.broadcastToUsers([targetUserId], {
                    type: 'notification_created',
                    message: 'تم تحديث إشعار قائم',
                    notification: { id: existing.id, user_id: targetUserId, title, message: message || '', type: finalType }
                });
            }
            let push = null;
            if (d.pushGateway && typeof d.pushGateway.sendToUsers === 'function') {
                push = await d.pushGateway.sendToUsers([targetUserId], {
                    title, body: message || '', badge: 'auto',
                    data: { kind: 'notification', notification_id: existing.id, ...(pushExtra || {}) }
                });
            }
            return { id: existing.id, type: finalType, updated: true, push };
        }
    }

    const id = await d.db.Notifications.create({ user_id: targetUserId, title, message: message || '', type: finalType, task_key: taskKey != null ? String(taskKey) : null, data_json: dataJson });
    if (typeof d.broadcastToUsers === 'function') {
        d.broadcastToUsers([targetUserId], {
            type: 'notification_created',
            message: 'تم إنشاء إشعار جديد',
            notification: { id, user_id: targetUserId, title, message: message || '', type: finalType }
        });
    }
    // v6: نسخة Push لأجهزة المستهدف — فوق القناة القائمة لا بدلًا عنها.
    // البوابة لا ترمي أبدًا؛ فشلها لا يمس الإشعار المنشأ ولا البث.
    let push = null;
    if (d.pushGateway && typeof d.pushGateway.sendToUsers === 'function') {
        push = await d.pushGateway.sendToUsers([targetUserId], {
            title, body: message || '', badge: 'auto',
            data: { kind: 'notification', notification_id: id, ...(pushExtra || {}) }
        });
    }
    return { id, type: finalType, push };
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
