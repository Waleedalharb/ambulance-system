// ============================================
// PermissionService — المرحلة 0: بنية الصلاحيات (معتمد 2026-08-16)
// ============================================
// الحساب الفعلي: دور المستخدم (خريطة ROLES_PERMISSIONS) + منح/سحب فردي
// من جدول user_permissions. القواعد:
//   - role = '*'          ⇒ كل الصلاحيات (admin — لا يفقد أحد شيئًا في المرحلة 0)
//   - granted = 1         ⇒ منحة فوق الدور
//   - granted = 0         ⇒ سحب حتى مما يمنحه الدور (السحب يغلب)
//   - غياب الصف           ⇒ افتراضي الدور حرفيًا
//   - schedule.import     ⇒ لا يمنحها أي دور؛ منحة فردية فقط
// تغيير أي صلاحية يُبطل جلسات المستخدم النشطة (TokenBlacklist موجودة أصلًا)
// ويُسجَّل في audit_log. لا ربط تلقائي بأي بيان وظيفي — إسناد يدوي فقط.
// ============================================
'use strict';

const crypto = require('crypto');
const { PERMISSIONS, PERMISSION_KEYS, ROLE_LABELS, ROLES_PERMISSIONS } = require('../config/permissions');

class PermissionService {
    constructor({ db }) {
        if (!db) throw new Error('PermissionService: db مطلوب');
        this.db = db;
    }

    isValidKey(key) { return PERMISSION_KEYS.indexOf(key) !== -1; }

    /** صلاحيات الدور الافتراضية — '*' تبقى '*'، وغير المعروف = بلا صلاحيات. */
    roleDefaults(role) {
        const r = ROLES_PERMISSIONS[role];
        if (!r) return [];
        return r.slice();
    }

    /**
     * الصلاحيات الفعلية لمستخدم ← { star, granted[], revoked[], effective[] }
     * star=true تعني admin/'*' — effective تبقى كاملة نظريًا ويُختصر عرضها.
     */
    async getEffective(userId, role) {
        const defaults = this.roleDefaults(role);
        const rows = await this.db.UserPermissions.getByUser(userId);
        // المنح/السحب الفردي يظهر في السجل دائمًا — حتى للمدير ('*')
        const granted = [], revoked = [];
        for (const r of rows) {
            if (!this.isValidKey(r.permission_key)) continue; // مفتاح ملغى من الكتالوج لا أثر له
            if (r.granted === 1) granted.push(r.permission_key); else revoked.push(r.permission_key);
        }
        if (defaults.indexOf('*') !== -1) {
            return { star: true, granted, revoked, effective: ['*'] };
        }
        const set = new Set(defaults);
        for (const r of rows) {
            if (!this.isValidKey(r.permission_key)) continue;
            if (r.granted === 1) set.add(r.permission_key); else set.delete(r.permission_key);
        }
        return { star: false, granted, revoked, effective: [...set].sort() };
    }

    /** هل يملك المستخدم الصلاحية؟ — نفس القواعد الأربع بالضبط. */
    async hasPermission(userId, role, key) {
        const eff = await this.getEffective(userId, role);
        return eff.star || eff.effective.indexOf(key) !== -1;
    }

    /**
     * منح (granted=true) أو سحب (granted=false) — مع التدقيق وإبطال الجلسات.
     * @returns {{changed:boolean, sessionsRevoked:number}}
     */
    async setPermission(targetUserId, key, granted, actor) {
        if (!this.isValidKey(key)) throw new Error('مفتاح صلاحية غير معروف: ' + key);
        const before = await this.db.UserPermissions.getByUser(targetUserId);
        const prev = before.find(r => r.permission_key === key);
        await this.db.UserPermissions.set(targetUserId, key, granted, actor.name);
        const sessionsRevoked = await this.revokeUserSessions(targetUserId);
        if (this.db.AuditLog && this.db.AuditLog.create) {
            await this.db.AuditLog.create({
                user_id: actor.id, user_name: actor.name, action: granted ? 'permission_grant' : 'permission_revoke',
                detail: `صلاحية ${key} للمستخدم ${targetUserId}: ${prev ? (prev.granted ? 'منحة' : 'سحب') : 'افتراضي الدور'} ← ${granted ? 'منحة' : 'سحب'} · أُبطلت ${sessionsRevoked} جلسة`,
                type: 'permissions'
            });
        }
        return { changed: true, sessionsRevoked };
    }

    /** إزالة الصف = عودة لافتراضي الدور — مع الإبطال والتدقيق أيضًا. */
    async clearPermission(targetUserId, key, actor) {
        await this.db.UserPermissions.clear(targetUserId, key);
        const sessionsRevoked = await this.revokeUserSessions(targetUserId);
        if (this.db.AuditLog && this.db.AuditLog.create) {
            await this.db.AuditLog.create({
                user_id: actor.id, user_name: actor.name, action: 'permission_clear',
                detail: `إعادة صلاحية ${key} للمستخدم ${targetUserId} إلى افتراضي الدور · أُبطلت ${sessionsRevoked} جلسة`,
                type: 'permissions'
            });
        }
        return { changed: true, sessionsRevoked };
    }

    /**
     * إبطال كل الجلسات النشطة لمستخدم — البنية الجاهزة لفرض التغيير فورًا.
     * تعتمد TokenBlacklist الموجودة (فحصها مدمج في authenticate أصلًا).
     */
    async revokeUserSessions(userId) {
        if (!this.db.AuthSessions || !this.db.TokenBlacklist) return 0;
        const sessions = await this.db.AuthSessions.getByUser(userId);
        let n = 0;
        for (const s of (sessions || [])) {
            if (!s.is_active || !s.access_token_hash) continue;
            await this.db.TokenBlacklist.add(s.access_token_hash, s.session_expires || null);
            await this.db.AuthSessions.update(s.id, { is_active: 0, logout_time: new Date().toISOString(), logout_reason: 'permissions_changed' });
            n++;
        }
        return n;
    }

    /** حزمة عرض auth/me: الدور + تسميته + الصلاحيات الفعلية. */
    async mePayload(userId, role) {
        const eff = await this.getEffective(userId, role);
        return {
            role,
            role_label: ROLE_LABELS[role] || role,
            permissions: eff.effective,           // ['*'] للمدير
            permissions_star: eff.star,
            permissions_granted: eff.granted,     // منح فردية فوق الدور
            permissions_revoked: eff.revoked      // سحوبات فردية من الدور
        };
    }
}

module.exports = PermissionService;
