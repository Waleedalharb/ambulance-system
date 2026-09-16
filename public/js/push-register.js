/**
 * ═══ push-register.js — طبقة APNs في تطبيق iOS (v6) ═══
 *
 * تُحمَّل فقط داخل WebView تطبيق Capacitor (سطر التحميل المحروس في نهاية
 * my-ems.js) — في المتصفح لا تُحمَّل أصلًا، وحتى لو حُمّلت تخرج فورًا.
 *
 * التدفق (شروط المالك):
 *   ① لا تسجيل قبل المصادقة: نخرج إن لم يوجد توكن دخول، والتوكن يُربط
 *      بالحساب خادميًا من جلسة Bearer — لا يُرسل أي معرّف مستخدم.
 *   ② الإذن يُطلب بالطريقة الأصلية (requestPermissions) ثم register().
 *   ③ عند «registration» نرسل التوكن لـ /api/my/push/register.
 *   ④ الضغط على إشعار (actionPerformed) يوجّه للوجهة: تغيير جدول ←
 *      «سجل تغييرات جدولي» (#changesCard)، وغيره ← «إشعاراتي» (#notifCard).
 *   ⑤ تسجيل الخروج يفصل الأجهزة خادميًا في /api/auth/logout — لا حاجة
 *      لاعتراض زر الخروج من هنا.
 *
 * ملاحظة تقنية: الصفحة تُقدَّم من الخادم (server.url) لذا لا تتوفر حزمة
 * JS للإضافة — نستخدم جسر Capacitor الأصلي مباشرة
 * (window.Capacitor.Plugins.PushNotifications) الذي تحقنه المنصة في
 * أي صفحة داخل الـWebView بما فيها البعيدة.
 */
'use strict';

(function () {
    // حارس البيئة: جسر Capacitor + إضافة PushNotifications — غير ذلك نخرج بصمت
    const cap = window.Capacitor;
    if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return;
    const Push = cap.Plugins && cap.Plugins.PushNotifications;
    if (!Push) { console.warn('[push] PushNotifications plugin غير متوفر في هذا البناء'); return; }

    function authToken() {
        return localStorage.getItem('auth_access_token') || localStorage.getItem('authToken') || null;
    }

    // بيئة APNs: بناء Xcode التصحيحي = sandbox (development)
    function apnsEnvironment() {
        return cap.DEBUG === true ? 'development' : 'production';
    }

    async function registerToken(deviceToken) {
        const jwt = authToken();
        if (!jwt) return; // ① لا ربط قبل المصادقة — يُعاد المحاولة عند أول دخول
        try {
            const r = await fetch('/api/my/push/register', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: deviceToken,
                    platform: 'ios',
                    environment: apnsEnvironment()
                })
            });
            if (!r.ok) console.warn('[push] register فشل:', r.status);
        } catch (e) {
            console.warn('[push] register خطأ شبكة:', e && e.message);
        }
    }

    // ④ التوجيه للوجهة — أقسام بوابة الموظف تُبنى غير متزامنة، لذا نعيد
    // محاولة التمرير حتى يظهر المقطع (بحد أقصى ~5 ثوانٍ)
    function scrollToCard(id, attemptsLeft) {
        const el = document.getElementById(id);
        if (el) { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { el.scrollIntoView(); } return; }
        if (attemptsLeft > 0) setTimeout(() => scrollToCard(id, attemptsLeft - 1), 500);
    }

    function navigateFor(data) {
        const kind = data && data.kind;
        const target = kind === 'schedule_change' ? 'changesCard' : 'notifCard';
        const onPortal = /\/my-ems\.html$/.test(location.pathname);
        if (onPortal) {
            scrollToCard(target, 10);
        } else {
            location.href = '/my-ems.html#' + target;
        }
    }

    // عند فتح البوابة عبر #anchor من إشعار سابق (التطبيق كان مغلقًا)
    function honorInitialHash() {
        const m = /^#(changesCard|notifCard)$/.exec(location.hash || '');
        if (m) scrollToCard(m[1], 10);
    }

    async function boot() {
        if (!authToken()) return; // ① لا شيء قبل الدخول
        try {
            const perm = await Push.requestPermissions();
            if (!perm || perm.receive !== 'granted') {
                console.log('[push] إذن الإشعارات غير ممنوح:', perm && perm.receive);
                return;
            }
            Push.addListener('registration', (t) => {
                if (t && t.value) registerToken(t.value);
            });
            Push.addListener('registrationError', (e) => {
                console.warn('[push] registrationError:', e && (e.error || e.message || e));
            });
            Push.addListener('pushNotificationActionPerformed', (a) => {
                navigateFor(a && a.notification && a.notification.data);
            });
            // إشعار يصل والتطبيق مفتوح: SSE يحدّث القائمة أصلًا — لا واجهة إضافية هنا
            await Push.register();
            honorInitialHash();
        } catch (e) {
            console.warn('[push] boot failed:', e && e.message);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
