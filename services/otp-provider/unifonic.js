/**
 * otp-provider/unifonic — ربط Unifonic Authenticate (المرحلة الثانية).
 * ═══════════════════════════════════════════════════════════════════
 * المعتمد: Create Verification (إرسال OTP عبر SMS) + Check Verification
 * (التحقق منه) — المصادقة بترويسة AppsId من Unifonic Console.
 *
 * 🟡 يحتاج تحققًا قبل التفعيل الفعلي (لم تُختبر على حساب حقيقي بعد):
 *   - المساران الدقيقان وأسماء الحقول تُثبَّت من وثائق/Console الحساب —
 *     صفحات docs.unifonic.com معروضة بجافاسكربت ولم تُظهر الحمولة النهائية.
 *   - أي اختلاف يُعزل هنا فقط؛ auth-reset-service لا يتغير.
 *
 * متغيرات البيئة المطلوبة (Render — لا تدخل الكود أو السجلات):
 *   UNIFONIC_APPS_ID   (إلزامي — من Console)
 *   UNIFONIC_BASE_URL  (اختياري — الافتراضي أدناه)
 */

const BASE_URL = (process.env.UNIFONIC_BASE_URL || 'https://el.cloud.unifonic.com').replace(/\/$/, '');
const APPS_ID = process.env.UNIFONIC_APPS_ID || '';
const TIMEOUT_MS = 10000;

function assertConfigured() {
    if (!APPS_ID) throw new Error('UNIFONIC_APPS_ID غير مضبوط — لا يمكن استخدام مزوّد unifonic');
}

async function call(path, body) {
    assertConfigured();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(BASE_URL + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'AppsId': APPS_ID },
            body: JSON.stringify(body),
            signal: ctrl.signal
        });
        const data = await res.json().catch(() => ({}));
        return { httpOk: res.ok, data };
    } finally { clearTimeout(t); }
}

module.exports = {
    name: 'unifonic',
    // 🟡 المسار والحقول مبدئيان من وثائق Create Verification — يُثبَّتان عند التفعيل
    async send(phoneE164) {
        const { httpOk, data } = await call('/v1/verifications', {
            recipient: phoneE164,
            channel: 'sms'
        });
        return { ok: httpOk, reason: httpOk ? undefined : (data.message || 'unifonic_send_failed') };
    },
    // 🟡 المسار والحقول مبدئيان من وثائق Check Verification — يُثبَّتان عند التفعيل
    async check(phoneE164, code) {
        const { httpOk, data } = await call('/v1/verifications/check', {
            recipient: phoneE164,
            code: String(code)
        });
        return { ok: httpOk, reason: httpOk ? undefined : (data.message || 'unifonic_check_failed') };
    }
};
