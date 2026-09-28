// ============================================
// CommunityIdentityService — EMS Community C1 (اعتماد المالك الكتابي 2026-09-24)
// ============================================
// النقطة الوحيدة في منظومة المجتمع التي تعرف شيئًا عن بيانات الموظفين.
// Projection محدد ونهائي: employee_id · display_name · avatar_url · is_active.
// ممنوع على أي خدمة/مسار Community قراءة جدول employees أو users مباشرة أو
// استدعاء /api/employees/:id — أي حقل إضافي مستقبلًا يُضاف هنا بقرار مراجعة.
// لا يقرأ phone/job_title/الكود الوظيفي/المركز — ولا يُرجعها حتى لو طُلبت.
// ============================================
'use strict';

const fs = require('fs').promises;

class CommunityIdentityService {
    constructor({ db, usersPath }) {
        if (!db) throw new Error('CommunityIdentityService: db مطلوب');
        if (!usersPath) throw new Error('CommunityIdentityService: usersPath مطلوب');
        this.db = db;
        this.usersPath = usersPath;
    }

    /** قراءة users.json طازجة — نفس مصدر تسجيل الدخول الفعلي في المنصة. */
    async _readUsers() {
        try { return JSON.parse(await fs.readFile(this.usersPath, 'utf8')); }
        catch (_) { return []; }
    }

    /**
     * إسقاط هوية مستخدم للعرض الاجتماعي.
     * الربط الوحيد المسموح: users.json user → employee_code = username → employee.
     * لا مطابقة بالاسم إطلاقًا (الاسم ليس معرفًا فريدًا — تشابه الأسماء كان
     * سيربط الهوية بموظف خاطئ؛ أُزيل هذا المسار بمراجعة المالك 2026-09-24).
     * بلا مطابقة employee_code: employee_id=null ويُعرض باسم حسابه بصدق.
     * @returns {Promise<{employee_id:number|null, display_name:string,
     *   avatar_url:null, is_active:boolean}>}
     */
    async resolveByUser(user) {
        if (!user || user.id == null) return null;
        const users = await this._readUsers();
        const row = users.find(u => String(u.id) === String(user.id)) ||
                    users.find(u => u.username && u.username === user.username);
        if (!row) return null;
        let emp = null;
        if (row.username) {
            emp = await this.db.get(
                'SELECT id, name, is_active FROM employees WHERE employee_code = ?', [String(row.username)]);
        }
        return {
            employee_id: emp ? emp.id : null,
            display_name: (emp && emp.name) || row.name || String(row.username || user.id),
            avatar_url: null, // لا عمود صور في employees حاليًا — ثابت بلا التفاف
            is_active: emp ? !!emp.is_active : !!row.isActive
        };
    }

    /** إسقاط هوية بمعرّف مستخدم (للإشراف والتدقيق). */
    async resolveByUserId(userId) {
        return this.resolveByUser({ id: userId });
    }

    /** إسقاط جماعي لقوائم العرض — نفس الحقول الأربعة فقط. */
    async resolveMany(userIds) {
        const out = {};
        for (const id of (userIds || [])) {
            out[String(id)] = await this.resolveByUserId(id);
        }
        return out;
    }
}

module.exports = CommunityIdentityService;
