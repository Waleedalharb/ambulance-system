/**
 * otp-provider/mock — مزوّد وهمي للاختبارات والتطوير المحلي فقط.
 * ═══════════════════════════════════════════════════════════════
 * - لا يُرسل أي رسالة حقيقية إطلاقًا.
 * - الرمز المقبول ثابت: 246810 (يُستخرج من آخر طلب send عبر lastCode()).
 * - يُفعَّل فقط عند OTP_PROVIDER=mock صراحة — لا يعمل في الإنتاج افتراضيًا.
 * - حماية إضافية: يرفض العمل إذا NODE_ENV=production حتى لو ضُبط المتغير خطأً.
 */

const MOCK_CODE = '246810';
let sentTo = [];   // سجل داخلي للاختبار فقط (لا يُسجَّل في ملفات أو قاعدة)

function assertNotProduction() {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('otp-provider/mock ممنوع في الإنتاج — اضبط OTP_PROVIDER=unifonic');
    }
}

module.exports = {
    name: 'mock',
    MOCK_CODE,
    async send(phoneE164) {
        assertNotProduction();
        sentTo.push({ phone: phoneE164, at: Date.now() });
        return { ok: true };
    },
    async check(phoneE164, code) {
        assertNotProduction();
        const wasSent = sentTo.some(s => s.phone === phoneE164);
        if (!wasSent) return { ok: false, reason: 'no_code_sent' };
        return { ok: String(code) === MOCK_CODE, reason: String(code) === MOCK_CODE ? undefined : 'wrong_code' };
    },
    // للاختبارات: كم مرة «أُرسل» رمز لهذا الرقم
    sendCount(phoneE164) { return sentTo.filter(s => s.phone === phoneE164).length; },
    _reset() { sentTo = []; }
};
