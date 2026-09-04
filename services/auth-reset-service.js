/**
 * AuthResetService — استعادة كلمة المرور عبر الجوال الموثّق (معتمد 2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════
 * المبادئ الحاكمة (قرارات المالك — لا تُخفَّف):
 *
 * ① توثيق الجوال يسبق الاستعادة: employees.phone_verified=1 شرط إرسال OTP.
 *    لا رقم موثق تلقائيًا، ونجاح OTP لا يوثّق رقمًا (مسار «ب» المرفوض).
 * ② عدم كشف الحساب: requestReset يعيد ردًا موحّدًا دائمًا — مسجل/غير مسجل،
 *    موثق/غير موثق — نفس الحالة ونفس النص ونفس الشكل الزمني قدر الإمكان.
 * ③ لا رقم جوال يُقبل من العميل في أي خطوة — يُشتق خادميًا من ملف الموظف
 *    المرتبط بالحساب (عقد الهوية: username === employee_code).
 * ④ رمز الاستعادة: خادمي، مرة واحدة، 10 دقائق، يُخزَّن sha256 فقط، ويحمل
 *    بصمة الرقم الموثق وقت الطلب — أي تغيير/تصفير للرقم أثناء الدورة يُبطله.
 * ⑤ عند نجاح إعادة التعيين: إبطال كل الجلسات والرموز السابقة فعليًا
 *    (revokeUserSessions — البنية القائمة المثبتة)، وتوثيق AuditLog/AuthLogs
 *    دون كلمة مرور ولا رمز OTP نهائيًا.
 * ⑥ حدود: 3 طلبات رمز/ساعة لكل هوية · 5 محاولات إدخال لكل دورة.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const bcrypt = require('bcryptjs');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;   // 10 دقائق
const MAX_REQUESTS_PER_HOUR = 3;
const MAX_CODE_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;               // أصرم من change-password القائم (4) — تحسين مقصود لمسار عام

// الرد الموحّد — لا يكشف وجود الحساب ولا حالة توثيق الرقم (تعديل المالك رقم 1)
const UNIFORM_MESSAGE = 'إذا كان الحساب مسجلًا وجواله موثقًا، فقد أُرسل رمز تحقق إلى جوالك.';

// تطبيع الرقم السعودي إلى صيغة دولية بلا '+': 05xxxxxxxx / 5xxxxxxxx → 9665xxxxxxxx
function normalizeSaudiPhone(raw) {
    if (!raw) return null;
    let p = String(raw).replace(/[^\d+]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.startsWith('00966')) p = p.slice(2);
    if (p.startsWith('05')) p = '966' + p.slice(1);
    else if (/^5\d{8}$/.test(p)) p = '966' + p;
    return /^9665\d{8}$/.test(p) ? p : null;
}

class AuthResetService {
    /**
     * @param {object} deps
     *   db                 — وحدة db.js (Employees/PasswordResetTokens/AuditLog/AuthLogs)
     *   usersPath          — مسار users.json (نفس مصدر الدخول)
     *   otpProvider        — من services/otp-provider (send/check)
     *   revokeUserSessions — (userId) => Promise<number> — من PermissionService
     */
    constructor({ db, usersPath, otpProvider, revokeUserSessions }) {
        if (!db || !usersPath || !otpProvider || typeof revokeUserSessions !== 'function') {
            throw new Error('AuthResetService: db/usersPath/otpProvider/revokeUserSessions مطلوبة');
        }
        this.db = db;
        this.usersPath = usersPath;
        this.otp = otpProvider;
        this.revokeUserSessions = revokeUserSessions;
        this._requests = new Map();   // identifier → [timestamps] — حد الطلبات (نافذة ساعة متحركة)
        this._codeAttempts = new Map(); // identifier → [timestamps] — حد محاولات الإدخال (نافذة ساعة — لا قفلًا أبديًا)
    }

    /** حلّ الهوية: مستخدم نشط + موظف نشط + جوال موثق بصيغة صالحة، أو null. */
    async _resolve(identifier) {
        const username = String(identifier || '').trim();
        if (!username || username.length > 50) return null;
        const users = JSON.parse(await fs.readFile(this.usersPath, 'utf8'));
        const user = users.find(u => u.username === username && u.isActive);
        if (!user) return null;
        const emp = await this.db.Employees.getByCode(username);   // عقد الهوية: username === employee_code
        if (!emp || !emp.is_active) return null;
        const phone = normalizeSaudiPhone(emp.phone);
        if (!phone || !emp.phone_verified) return null;
        return { user, emp, phone };
    }

    _requestsAllowed(identifier) {
        const now = Date.now();
        const list = (this._requests.get(identifier) || []).filter(t => now - t < 3600_000);
        this._requests.set(identifier, list);
        if (list.length >= MAX_REQUESTS_PER_HOUR) return false;
        list.push(now);
        return true;
    }

    /** الخطوة 1: طلب الرمز — رد موحّد دائمًا (200 بنفس النص) مهما كانت الحالة. */
    async requestReset({ identifier, ip }) {
        const key = String(identifier || '').trim();
        try {
            if (key && this._requestsAllowed(key)) {
                const ctx = await this._resolve(key);
                if (ctx) {
                    const sent = await this.otp.send(ctx.phone);
                    if (!sent.ok) {
                        // فشل المزوّد لا يُكشف للعميل — يُسجَّل داخليًا فقط
                        console.warn('[auth-reset] فشل إرسال OTP:', sent.reason);
                    }
                }
            }
            // خارج الحد أو حساب غير موجود/غير موثق → نفس الرد الموحّد
            await this._authLog(null, key, 'password_reset_request', true, null, ip);
            return { status: 200, body: { success: true, message: UNIFORM_MESSAGE } };
        } catch (err) {
            console.error('[auth-reset] requestReset:', err.message);
            return { status: 200, body: { success: true, message: UNIFORM_MESSAGE } }; // حتى الخطأ الداخلي لا يكشف شيئًا
        }
    }

    /** الخطوة 2: التحقق من الرمز ← رمز استعادة خادمي (مرة واحدة، 10 دقائق). */
    async verifyCode({ identifier, code, ip }) {
        const key = String(identifier || '').trim();
        const fail = async (msg) => {
            await this._authLog(null, key, 'password_reset_verify', false, msg, ip);
            return { status: 400, body: { success: false, error: 'الرمز غير صحيح أو منتهي الصلاحية' } };
        };
        const now = Date.now();
        const attemptList = (this._codeAttempts.get(key) || []).filter(t => now - t < 3600_000);
        this._codeAttempts.set(key, attemptList);
        if (attemptList.length >= MAX_CODE_ATTEMPTS) return fail('attempts_exceeded');
        attemptList.push(now);

        const ctx = await this._resolve(key);
        if (!ctx) return fail('not_resolvable');
        if (!/^\d{4,8}$/.test(String(code || ''))) return fail('bad_format');

        const checked = await this.otp.check(ctx.phone, String(code));
        if (!checked.ok) return fail(checked.reason || 'wrong_code');

        // نجاح التحقق ← رمز استعادة خادمي يحمل بصمة الرقم الموثق الآن
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
        await this.db.PasswordResetTokens.invalidateOpenForUser(ctx.user.id); // دورة واحدة حية فقط
        await this.db.PasswordResetTokens.create(ctx.user.id, sha256(token), sha256(ctx.phone), expiresAt);
        this._codeAttempts.delete(key);
        await this._authLog(ctx.user.id, key, 'password_reset_verify', true, null, ip);
        return { status: 200, body: { success: true, resetToken: token, expiresInMinutes: 10 } };
    }

    /** الخطوة 3: تعيين كلمة المرور — يفشل إذا تغيّر الرقم أو صُفّر توثيقه أثناء الدورة. */
    async resetPassword({ token, newPassword, ip }) {
        const genericFail = { status: 400, body: { success: false, error: 'رمز الاستعادة غير صالح أو منتهي — أعد المحاولة من البداية' } };
        if (!token || typeof token !== 'string' || token.length !== 64) return genericFail;
        if (!newPassword || String(newPassword).length < MIN_PASSWORD_LENGTH) {
            return { status: 400, body: { success: false, error: `كلمة المرور الجديدة يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل` } };
        }

        const row = await this.db.PasswordResetTokens.getByHash(sha256(token));
        if (!row || row.used || row.attempts >= MAX_CODE_ATTEMPTS) return genericFail;
        if (new Date(row.expires_at).getTime() < Date.now()) return genericFail;

        const users = JSON.parse(await fs.readFile(this.usersPath, 'utf8'));
        const idx = users.findIndex(u => String(u.id) === String(row.user_id) && u.isActive);
        if (idx === -1) return genericFail;
        const user = users[idx];

        // تعديل المالك رقم 4: الرقم الحالي يجب أن يطابق البصمة وما يزال موثقًا
        const emp = await this.db.Employees.getByCode(user.username);
        const currentPhone = emp && emp.phone_verified ? normalizeSaudiPhone(emp.phone) : null;
        if (!currentPhone || sha256(currentPhone) !== row.phone_fingerprint) {
            await this.db.PasswordResetTokens.markUsed(row.id); // يُبطل نهائيًا — لا إعادة محاولة بنفس الرمز
            await this._authLog(user.id, user.username, 'password_reset_commit', false, 'phone_changed_or_unverified', ip);
            return { status: 409, body: { success: false, error: 'تغيّر رقم الجوال الموثق أثناء الاستعادة — يرجى مراجعة مسؤول النظام والبدء من جديد' } };
        }

        const salt = await bcrypt.genSalt(12);
        users[idx].password = await bcrypt.hash(String(newPassword), salt);
        await fs.writeFile(this.usersPath, JSON.stringify(users, null, 2));

        await this.db.PasswordResetTokens.markUsed(row.id);
        const sessionsRevoked = await this.revokeUserSessions(user.id);

        await this._authLog(user.id, user.username, 'password_reset_commit', true, null, ip);
        if (this.db.AuditLog && this.db.AuditLog.create) {
            await this.db.AuditLog.create({
                user_id: user.id, user_name: user.name, action: 'password_reset',
                detail: `استعادة كلمة مرور عبر الجوال الموثق · أُبطلت ${sessionsRevoked} جلسة · كلمة المرور والرمز لم يُسجَّلا`,
                type: 'permissions'
            });
        }
        return { status: 200, body: { success: true, message: 'تم تعيين كلمة المرور الجديدة — سجّل الدخول الآن', sessionsRevoked } };
    }

    async _authLog(userId, username, action, success, errorMessage, ip) {
        try {
            if (this.db.AuthLogs) {
                await this.db.AuthLogs.create({
                    user_id: userId, username, action_type: action,
                    action_detail: action, ip_address: ip || 'unknown', user_agent: 'auth-reset',
                    session_id: null, success, error_message: errorMessage
                });
            }
        } catch (_) { /* السجل لا يُسقط العملية */ }
    }
}

module.exports = { AuthResetService, normalizeSaudiPhone, UNIFORM_MESSAGE, MIN_PASSWORD_LENGTH };
