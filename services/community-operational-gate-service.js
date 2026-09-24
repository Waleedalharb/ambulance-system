// ============================================
// CommunityOperationalGateService — EMS Community C1 (اعتماد المالك 2026-09-24)
// ============================================
// النقطة الوحيدة في منظومة المجتمع التي تستعلم عن الحالة التشغيلية.
// تستدعي operational-assignment-service قراءةً فقط (resolveEffectiveAssignment
// كما هو — بلا أي تعديل عليه)، وتُعيد قرارًا عامًا بلا تفاصيل تشغيلية:
//   { allowRead, allowParticipation, reason }
// reason ∈ OPERATIONAL_DUTY · ACTIVE_ASSIGNMENT · ATTENDANCE_STATE · null
// (لا أرقام بلاغات، لا أسماء فرق، لا مواقع).
//
// ⚠️ قاعدة معمارية ثابتة (v3): الحالات المانعة ليست إعدادًا إداريًا ولا يوجد
// أي Toggle يفتحها. أي تغيير في سياسة المنع = تغيير معماري موثّق ومراجع.
// مفاتيح التعطيل تعمل في اتجاه التقييد فقط ولا تمر عبر هنا.
//
// الحالات (مستخرجة من الكود الفعلي — لا اختراع):
//  active_shift + deployable          → DENY (ACTIVE_ASSIGNMENT) + allowRead=false
//  active_shift + لا تكليف/غير ميداني → DENY (OPERATIONAL_DUTY)  + allowRead=true
//  active_shift + absent (غياب/تأخر/exit مفتوح) → DENY (ATTENDANCE_STATE)
//  staffing_unavailable (مناوبة نشطة وحالتها غير متاحة) → DENY fail-closed
//  roster_only (خارج المناوبة/تكليف قادم/إجازة)  → ALLOW
//  بلا ملف موظف (حسابات النظام)                  → ALLOW
//  خطأ في الاستعلام                              → DENY fail-closed
// ============================================
'use strict';

const REASONS = Object.freeze({
    OPERATIONAL_DUTY: 'OPERATIONAL_DUTY',
    ACTIVE_ASSIGNMENT: 'ACTIVE_ASSIGNMENT',
    ATTENDANCE_STATE: 'ATTENDANCE_STATE'
});

const ALLOW = Object.freeze({ allowRead: true, allowParticipation: true, reason: null });

class CommunityOperationalGateService {
    constructor({ assignment }) {
        if (!assignment) throw new Error('CommunityOperationalGateService: assignment مطلوب');
        this.assignment = assignment;
    }

    /**
     * تقييم السماح الاجتماعي لمستخدم — القواعد أدناه ثابتة معماريًا.
     * @returns {Promise<{allowRead:boolean, allowParticipation:boolean, reason:string|null}>}
     */
    async evaluate(user) {
        let eff;
        try {
            eff = await this.assignment.resolveEffectiveAssignment(user);
        } catch (_) {
            // fail-closed: لا نعرف الحالة التشغيلية ← لا مشاركة ترفيهية
            return { allowRead: true, allowParticipation: false, reason: REASONS.OPERATIONAL_DUTY };
        }
        if (!eff || eff.notFound) return { ...ALLOW }; // حساب نظام بلا ملف موظف — ليس ميدانيًا

        // مناوبة نشطة تعذّر استعلام حالتها ← fail-closed قبل أي قراءة للنتيجة
        if (eff.shiftMode === 'staffing_unavailable') {
            return { allowRead: true, allowParticipation: false, reason: REASONS.OPERATIONAL_DUTY };
        }

        // مناوبة نشطة فعلًا
        if (eff.shiftMode === 'active_shift') {
            if (eff.blockReason === 'absent') {
                return { allowRead: true, allowParticipation: false, reason: REASONS.ATTENDANCE_STATE };
            }
            if (eff.deployable) {
                return { allowRead: false, allowParticipation: false, reason: REASONS.ACTIVE_ASSIGNMENT };
            }
            return { allowRead: true, allowParticipation: false, reason: REASONS.OPERATIONAL_DUTY };
        }

        // roster_only: خارج المناوبة · تكليف قادم لم تبدأ مناوبته · إجازة/راحة
        return { ...ALLOW };
    }
}

CommunityOperationalGateService.REASONS = REASONS;
module.exports = CommunityOperationalGateService;
