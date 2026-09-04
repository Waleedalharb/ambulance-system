/**
 * otp-provider — واجهة موحدة لإرسال/التحقق من رموز OTP (معتمد 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════
 * تغيير المزوّد = ملف واحد جديد + متغير البيئة OTP_PROVIDER —
 * صفر تعديل في منطق الاستعادة (auth-reset-service لا يعرف اسم المزوّد).
 *
 * الواجهة:
 *   send(phoneE164)        → { ok: boolean, reason?: string }
 *   check(phoneE164, code) → { ok: boolean, reason?: string }
 *
 * الواجهة لا تعرف شيئًا عن كلمات المرور — تعيد نجاح/فشل فقط.
 *
 * الاختيار عبر OTP_PROVIDER:
 *   mock      ← للاختبارات والتطوير المحلي فقط (بلا إرسال حقيقي)
 *   unifonic  ← المرحلة الثانية (تتطلب UNIFONIC_APPS_ID)
 *   (افتراضي) ← disabled: يرفض الإرسال دائمًا — سقوط آمن يمنع أي OTP
 *               وهمي في الإنتاج إن نُسي ضبط المتغير.
 */

function getOtpProvider() {
    const name = (process.env.OTP_PROVIDER || '').trim().toLowerCase();
    if (name === 'mock') return require('./mock');
    if (name === 'unifonic') return require('./unifonic');
    return {
        name: 'disabled',
        async send() { return { ok: false, reason: 'provider_not_configured' }; },
        async check() { return { ok: false, reason: 'provider_not_configured' }; }
    };
}

module.exports = { getOtpProvider };
