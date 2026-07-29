/**
 * Smart Ask Service — طبقة الإجابة الحتمية لأسئلة المشغل الذكي (المرحلة 6-د)
 * ═══════════════════════════════════════════════════════════
 * بلا LLM وبلا استدلال: مطابقة قصد السؤال ثم تجميع الإجابة من حقول
 * التقييم الجاهز (decisionEngine) وأنماط الذاكرة فقط — صفر حساب جديد.
 * قانون الصدق: لا رقم ولا اسم يُختلق؛ غياب المصدر ⇒ عبارة صدق صريحة.
 * سؤال خارج النطاق ⇒ اعتذار مهني + عرض العائلات المدعومة.
 */

const FAMILIES = Object.freeze([
    { id: 'needs-support', label: 'من يحتاج دعمًا؟' },
    { id: 'readiness-ok', label: 'هل الجاهزية مقبولة؟' },
    { id: 'current-risk', label: 'ما الخطر الحالي؟' },
    { id: 'center-shortage', label: 'أي مركز به نقص؟' },
    { id: 'readiness-blockers', label: 'ما الذي يمنع الجاهزية الكاملة؟' },
    { id: 'completion-attention', label: 'أي طلب تكميل يحتاج انتباهًا؟' },
    { id: 'shift-story', label: 'ماذا حدث في هذه المناوبة؟' },
    { id: 'what-now', label: 'ماذا أفعل الآن؟' }
]);

const STATUS_WORD = Object.freeze({ stable: 'مستقرة', attention: 'تحتاج متابعة', critical: 'حرجة' });

function risksOf(a) { return Array.isArray(a && a.risks) ? a.risks : []; }
function recsOf(a) { return Array.isArray(a && a.recommendations) ? a.recommendations : []; }
function pct(a) { const p = a && a.readiness && a.readiness.percent; return (typeof p === 'number') ? p + '٪' : '—'; }

function detectFamily(q) {
    const t = ' ' + String(q || '').trim() + ' ';
    if (/تكميل/.test(t)) return 'completion-attention';
    if (/يمنع|مانع|عائق|يعيق/.test(t)) return 'readiness-blockers';
    if (/ماذا حدث|ماذا جرى|أحداث المناوبة|ملخص المناوبة|حدث في/.test(t)) return 'shift-story';
    if (/ماذا أفعل|ما العمل|ما الإجراء|الخطوة التالية/.test(t)) return 'what-now';
    if (/دعم/.test(t)) return 'needs-support';
    if (/مركز|مراكز/.test(t)) return 'center-shortage';
    if (/خطر|أخطر|مخاطر/.test(t)) return 'current-risk';
    if (/مقبول|مقبولة|كافي|كافية|جاهزية/.test(t)) return 'readiness-ok';
    return null;
}

// ─── مجمّعات الإجابات (كلها قراءة من حقول التقييم/الأنماط فقط) ───
const ANSWERERS = {
    'needs-support': (a) => {
        const risks = risksOf(a).filter(r => r.code === 'TEAM_MISSING' || r.code === 'TEAM_UNDERSTAFFED');
        if (!risks.length) return 'لا يوجد نقص حالي — جميع الفرق مكتملة الكادر.';
        const lines = [];
        for (const r of risks) {
            const assign = recsOf(a).find(x => x.code === 'ASSIGN_SUPPORT' && x.target && x.target.team === r.team);
            const escalate = recsOf(a).find(x => x.code === 'REQUEST_EXTERNAL_SUPPORT' && x.target && x.target.team === r.team);
            if (assign && assign.target.supporters && assign.target.supporters.length) {
                lines.push(`${r.team} — ${r.title}؛ يُنصح بإسناد ${assign.target.supporters.map(s => s.name).join('، ')} دعمًا مؤقتًا.`);
            } else if (escalate) {
                lines.push(`${r.team} — ${r.title}؛ لا دعم متاح في الحوض، التصعيد لإدارة العمليات.`);
            } else {
                lines.push(`${r.team} — ${r.title}.`);
            }
        }
        return 'الفرق المحتاجة للدعم: ' + lines.join(' | ');
    },
    'readiness-ok': (a) => {
        const st = a.readiness ? a.readiness.status : null;
        const word = STATUS_WORD[st] || 'غير معروفة';
        if (st === 'stable') return `الجاهزية ${pct(a)} — ${word} وضمن المستوى المقبول.`;
        if (st === 'attention') return `الجاهزية ${pct(a)} — ${word}؛ ليست في وضع مثالي وتستدعي الانتباه.`;
        if (st === 'critical') return `الجاهزية ${pct(a)} — ${word} ودون المستوى المقبول؛ تتطلب إجراءً فوريًا.`;
        return 'حالة الجاهزية غير متاحة حاليًا (—).';
    },
    'current-risk': (a) => {
        const risks = risksOf(a);
        if (!risks.length) return 'لا مخاطر نشطة — الوضع التشغيلي مستقر.';
        const top = risks.find(r => r.severity === 'critical') || risks[0];
        const more = risks.length > 1 ? ` (إجمالي المخاطر النشطة: ${risks.length})` : '';
        return `الخطر الأبرز الآن: ${top.title} — ${top.detail}${more}`;
    },
    'center-shortage': (a) => {
        const imb = risksOf(a).find(r => r.code === 'CENTER_IMBALANCE');
        if (imb) return `تفاوت مسجّل بين المراكز: ${imb.detail}`;
        return 'لا تفاوت مسجّل بين المراكز حاليًا.';
    },
    'readiness-blockers': (a) => {
        const blockers = risksOf(a).filter(r => r.severity === 'critical' || r.severity === 'warning');
        if (!blockers.length) return 'لا عوائق مسجّلة — الجاهزية مكتملة.';
        return 'يعيق الجاهزية الكاملة: ' + blockers.map(r => r.title).join('؛ ') + '.';
    },
    'completion-attention': (a) => {
        const pend = risksOf(a).find(r => r.code === 'COMPLETION_PENDING');
        if (pend) return `طلب التكميل المحتاج انتباهًا: ${pend.detail}`;
        return 'جميع الفرق مُكمَّلة ولا طلبات تكميل معلّقة.';
    },
    'shift-story': (a, patterns) => {
        if (!patterns || !patterns.records) return 'لا سجلّات تشغيلية بعد لهذه المناوبة.';
        const parts = [];
        const teams = Object.entries(patterns.shortageTeams || {});
        if (teams.length) parts.push('نقص: ' + teams.map(([t, n]) => `${t} (×${n})`).join('، '));
        const veh = Object.entries(patterns.vehicleIssues || {});
        if (veh.length) parts.push('أعطال مركبات: ' + veh.map(([v, n]) => `${v} (×${n})`).join('، '));
        if (patterns.completionDelays) parts.push(`تأخر تكميل (×${patterns.completionDelays})`);
        const readiness = patterns.readiness && typeof patterns.readiness.min === 'number'
            ? ` — أدنى جاهزية سُجّلت: ${patterns.readiness.min}٪` : '';
        return `سُجّلت ${patterns.records} تغيّرات تشغيلية في هذه المناوبة${readiness}.`
            + (parts.length ? ' أبرز الأنماط: ' + parts.join('؛ ') + '.' : ' لا أنماط متكررة بعد.');
    },
    'what-now': (a) => {
        const top = recsOf(a)[0];
        if (!top) return 'لا إجراءات مطلوبة — الوضع التشغيلي مستقر؛ تابع الموقف المعتاد.';
        return `الإجراء الأعلى أولوية الآن: ${top.action}`;
    }
};

/**
 * إجابة حتمية عن سؤال تشغيلي.
 * @param {string} question
 * @param {Object} ctx - { assessment, patterns }
 * @returns {Object} { family: string|null, text: string }
 */
function answer(question, { assessment, patterns } = {}) {
    const a = assessment || {};
    if (!a.shift) {
        return { family: null, text: 'لا توجد مناوبة نشطة حاليًا — المنظومة في وضع الاستعداد.' };
    }
    const family = detectFamily(question);
    if (!family) {
        return {
            family: null,
            text: 'سؤال خارج نطاق البيانات التشغيلية الحالية. الأسئلة المدعومة: '
                + FAMILIES.map(f => f.label).join(' / ')
        };
    }
    return { family, text: ANSWERERS[family](a, patterns) };
}

module.exports = { answer, detectFamily, FAMILIES };
