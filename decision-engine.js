/**
 * Decision Engine v1.1 — العقل التحليلي للمنصة (المرحلة 6-أ · جولة المعايرة التشغيلية)
 * ═══════════════════════════════════════════════════════════
 * طبقة تحليل صرفة (Pure / Deterministic — بلا ML وبلا LLM):
 *   المدخل : لقطة حالة (snapshot) مُجمَّعة من الوحدات القائمة فقط —
 *            StaffingEventsService / VehicleEventsService / WorkflowService.
 *   المخرج : تقييم تشغيلي مهيكل (JSON) بصياغة تنفيذية عربية.
 *
 * المحرك لا يقرأ من قاعدة البيانات إطلاقًا، ولا يعيد حساب أي مؤشر:
 * نسب الجاهزية وحالات الفرق والمركبات تُقرأ من نفس مصادر المنصة (SSOT)
 * وتُفسَّر هنا فقط. كل توصية تجيب عن سؤالين: ما الذي يحدث + ما الإجراء.
 * دلالات الشدة: critical = إجراء فوري، warning = متابعة/انتباه، info = طبيعي.
 *
 * جولة المعايرة (باعتماد مراجعة جودة القرار التشغيلية):
 *   ① لا توصية متناقضة — نسبة الجاهزية تقود readiness.status والملخص فقط
 *     (بلا خطر مستقل يضاعف التنبيه)، وتوصية الاعتماد لا تظهر ما دامت
 *     محظورة عمليًا (فرق بلا تكميل) أو قبل أوانها (منتصف المناوبة).
 *   ② سلامة الأولويات — أولوية التوصية = شدة خطرها الأم؛ داخل الشريحة:
 *     العجلات قبل الأفراد (طاقم بلا مركبة لا يتحرك)، التغطية قبل الإداري؛
 *     توزيع الدعم حسب الحاجة (النقص المقرَّر أولًا ثم الأكبر عجزًا)،
 *     واستبعاد مركبات الورشة من ترشيحات الاحتياط.
 *   ③ وعي بزمن المناوبة (12 ساعة) — مراحل early/mid/late/final، خروج الخدمة
 *     بشدة مرتبطة بمدته، التكميل المعلّق يصير حرجًا في المرحلة النهائية
 *     (يهدد التسليم)، ومهلة متابعة للمتأخر قبل التوصية بسدّ مكانه.
 */

// ─── عتبات القرار (ثوابت مُسمّاة — تُضبط هنا فقط) ───
const THRESHOLDS = Object.freeze({
    READINESS_ATTENTION_PERCENT: 90,   // جاهزية دونها ⇒ انتباه
    READINESS_CRITICAL_PERCENT: 75,    // جاهزية دونها ⇒ حرج
    PENDING_COMPLETION_MINUTES: 45,    // تكميل معلّق أطول من هذه المدة بعد بدء المناوبة ⇒ تأخر
    CENTER_IMBALANCE_MIN_GAP: 2,       // فرق الفرق الناقصة بين المراكز ⇒ خلل توازن
    FINAL_PHASE_MINUTES: 90,           // ③ آخر 90 دقيقة من المناوبة = المرحلة النهائية
    OFFLINE_CRITICAL_HOURS: 4,         // ③ خروج عن الخدمة أطول منها ⇒ تصعيد لحرج
    LATE_GRACE_MINUTES: 30             // ③ مهلة متابعة المتأخر قبل التوصية بسدّ مكانه
});

// ③ زمن المناوبة: 12 ساعة في النافذتين (صباحية 05:00–17:00 / ليلية 17:00–05:00 — managers.js)
const SHIFT_DURATION_MINUTES = 720;
const EARLY_PHASE_MINUTES = 120;       // أول ساعتين = مرحلة مبكرة
const LATE_PHASE_START_MINUTES = 480;  // من الساعة الثامنة حتى ما قبل النهائية = متأخرة

const SHIFT_PHASE = Object.freeze({ EARLY: 'early', MID: 'mid', LATE: 'late', FINAL: 'final', UNKNOWN: 'unknown' });
const SEVERITY = Object.freeze({ CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' });
const READINESS_STATUS = Object.freeze({ STABLE: 'stable', ATTENTION: 'attention', CRITICAL: 'critical' });

// ② ترتيب تشغيلي داخل شريحة الأولوية: العجلات أولًا، ثم إعادة التفعيل،
// ثم التغطية البشرية، ثم التكميل، والإداري (الاعتماد) أخيرًا دائمًا.
const REC_BAND = Object.freeze({
    ASSIGN_RESERVE_VEHICLE: 0, ESCALATE_VEHICLE: 0,
    REACTIVATE_TEAM: 1,
    ASSIGN_SUPPORT: 2, REQUEST_EXTERNAL_SUPPORT: 2,
    REQUEST_COMPLETION: 3,
    APPROVE_WORKFLOW: 4
});

// ─── أدوات داخلية (لا تلمس المدخل — قراءة فقط) ───
function percentText(percent) {
    return (typeof percent === 'number') ? percent + '٪' : '—';
}

function minutesBetween(isoStart, isoEnd) {
    const a = Date.parse(isoStart);
    const b = Date.parse(isoEnd);
    if (isNaN(a) || isNaN(b)) return null;
    return Math.max(0, Math.round((b - a) / 60000));
}

function durationText(min) {
    if (min >= 120) return Math.round(min / 60) + ' ساعات';
    if (min >= 60) return 'ساعة';
    return min + ' دقيقة';
}

function pendingLabel(n) {
    if (n === 1) return 'فريق واحد';
    if (n === 2) return 'فريقان';
    return n + ' فرق';
}

// ③ مرحلة المناوبة من وقت بدئها — بلا startedAt ⇒ «unknown» ولا تصعيد زمني إطلاقًا
function computeShiftPhase(shift, nowIso) {
    if (!shift || !shift.startedAt) return SHIFT_PHASE.UNKNOWN;
    const elapsed = minutesBetween(shift.startedAt, nowIso);
    if (elapsed === null) return SHIFT_PHASE.UNKNOWN;
    if (elapsed >= SHIFT_DURATION_MINUTES - THRESHOLDS.FINAL_PHASE_MINUTES) return SHIFT_PHASE.FINAL; // يشمل تجاوز المدة
    if (elapsed >= LATE_PHASE_START_MINUTES) return SHIFT_PHASE.LATE;
    if (elapsed >= EARLY_PHASE_MINUTES) return SHIFT_PHASE.MID;
    return SHIFT_PHASE.EARLY;
}

/**
 * التقييم التشغيلي اللحظي.
 * @param {Object} snapshot - {
 *   now: ISO,
 *   shift: { id, type, date, status, startedAt } | null,
 *   staffing: ناتج StaffingEventsService.deriveTeamReadiness (teams + workforce),
 *   vehicles: ناتج VehicleEventsService.getBoard (counters/vehicles/unassigned/support),
 *   support:  ناتج StaffingEventsService.getAvailableSupport (supporters),
 *   workflow: { pendingApprovals: [{ id, versionNo, createdByName, createdAt }] }
 * }
 * @returns {Object} التقييم المهيكل (لا يُعدَّل المدخل إطلاقًا).
 */
function assess(snapshot) {
    const snap = snapshot || {};
    const generatedAt = snap.now || new Date().toISOString();

    const staffing = snap.staffing || {};
    const teams = staffing.teams || {};
    const wf = staffing.workforce || {};
    const vehiclesBoard = snap.vehicles || {};
    const supporters = Array.isArray(snap.support && snap.support.supporters) ? snap.support.supporters : [];
    const pendingApprovals = Array.isArray(snap.workflow && snap.workflow.pendingApprovals) ? snap.workflow.pendingApprovals : [];
    const teamNames = Object.keys(teams);

    const risks = [];
    const recommendations = [];
    const proactive = [];

    // نسبة الجاهزية — من الاشتقاق الرسمي نفسه؛ ① تقود readiness.status والملخص فقط
    const percent = (typeof wf.operationalReadinessRate === 'number') ? wf.operationalReadinessRate
        : (typeof wf.readinessRate === 'number' ? wf.readinessRate : null);

    // ③ مرحلة المناوبة الزمنية
    const shiftPhase = computeShiftPhase(snap.shift, generatedAt);

    // أسماء المركبات للعرض (call_sign || plate_number كما تجهزها اللوحة — لا معرفات داخلية)
    const vehNameById = {};
    for (const list of [vehiclesBoard.vehicles, vehiclesBoard.unassigned]) {
        for (const v of (Array.isArray(list) ? list : [])) {
            if (v && v.id != null && v.name) vehNameById[v.id] = v.name;
        }
    }

    // ② المركبات الاحتياطية المتاحة — يُستبعد منها ما هو داخل الورشة (inWorkshop من اللوحة)
    const reserveVehicles = (Array.isArray(vehiclesBoard.unassigned) ? vehiclesBoard.unassigned : [])
        .filter(v => v && !v.inWorkshop && (v.status === null || v.status === undefined || v.status === 'reserve' || v.status === 'active'));

    // مؤشرا تعيين محليان — لا يمسان لقطة المدخل (منع الإسناد المزدوج داخل التقييم الواحد)
    const assignedSupporters = new Set();
    const assignedVehicles = new Set();

    // ═══ R01: فريق خارج الخدمة — ③ شدة مرتبطة بالمدة (قرار مشرف مُدار، ليس طارئًا مجهولًا) ═══
    for (const name of teamNames) {
        const t = teams[name] || {};
        if (t.status !== 'offline') continue;
        const offlineMin = (t.lastDecision && t.lastDecision.at) ? minutesBetween(t.lastDecision.at, generatedAt) : null;
        const longOffline = offlineMin !== null && offlineMin > THRESHOLDS.OFFLINE_CRITICAL_HOURS * 60;
        risks.push({
            code: 'TEAM_OFFLINE',
            severity: longOffline ? SEVERITY.CRITICAL : SEVERITY.WARNING,
            team: name,
            title: `${name} خارج الخدمة`,
            detail: (offlineMin !== null ? `خارج الخدمة منذ ${durationText(offlineMin)} — ` : '')
                + (t.reason ? `السبب المعتمد: ${t.reason}` : 'أُخرج من الخدمة بقرار المشرف')
        });
        recommendations.push({
            code: 'REACTIVATE_TEAM', priority: longOffline ? 1 : 2, // ② الأولوية = شدة الخطر الأم
            title: `معالجة خروج ${name}`,
            action: longOffline
                ? `خروج ${name} تجاوز ${THRESHOLDS.OFFLINE_CRITICAL_HOURS} ساعات — إعادته للخدمة فورًا أو اعتماد بديل رسمي`
                : `مراجعة استمرار خروج ${name} وتحديد موعد عودته أو بديله`,
            target: { team: name }
        });
        proactive.push({ code: 'TEAM_OFFLINE', text: `${name} خارج الخدمة${offlineMin !== null ? ' منذ ' + durationText(offlineMin) : ''} — يُتابع` });
    }

    // ═══ R02/R03: نقص القوى البشرية — قرار «ناقص» أو عجز فعلي عن المطلوب ═══
    const shortTeams = [];
    for (const name of teamNames) {
        const t = teams[name] || {};
        if (t.status === 'offline') continue; // عولج في R01
        const vacant = (typeof t.vacant === 'number') ? t.vacant : Math.max(0, (t.requiredPersonnel || 0) - (t.activeCount || 0));
        if (t.status === 'missing') {
            const absentees = Array.isArray(t.absentees) ? t.absentees.filter(Boolean) : [];
            // ③ مهلة المتأخر: نقص سببه تأخر فقط وأحدث تأخر دون 30 دقيقة ⇒ متابعة، بلا توصية إسناد
            const lateOnly = absentees.length > 0 && absentees.every(a => a.type === 'late');
            if (lateOnly) {
                const latestLateAge = Math.min(...absentees.map(a => {
                    const m = minutesBetween(a.since, generatedAt);
                    return m === null ? Infinity : m;
                }));
                if (latestLateAge < THRESHOLDS.LATE_GRACE_MINUTES) {
                    risks.push({
                        code: 'TEAM_MISSING', severity: SEVERITY.WARNING, team: name,
                        title: `${name} — مسعف متأخر`,
                        detail: `متأخر — يُتابع وصوله قبل الإسناد (${absentees.map(a => a.name).filter(Boolean).join('، ')}) — مضى ${latestLateAge} دقيقة`
                    });
                    proactive.push({ code: 'LATE_GRACE', text: `${name} بانتظار متأخر — متابعة قبل أي إسناد` });
                    continue; // احتجاز التوصية — لا تُدخل shortTeams
                }
            }
            shortTeams.push({ name, vacant: Math.max(1, vacant), team: t, kind: 'missing' });
            const absentNames = absentees.map(a => a && a.name).filter(Boolean);
            risks.push({
                code: 'TEAM_MISSING', severity: SEVERITY.CRITICAL, team: name,
                title: `${name} ينقصها ${vacant > 1 ? vacant + ' أفراد' : 'فرد'}`,
                detail: absentNames.length
                    ? `الغياب/التأخر المفتوح: ${absentNames.join('، ')}${t.reason ? ' — ' + t.reason : ''}`
                    : (t.reason || 'كادر الفريق دون العدد المطلوب')
            });
        } else if (vacant > 0) {
            shortTeams.push({ name, vacant, team: t, kind: 'understaffed' });
            risks.push({
                code: 'TEAM_UNDERSTAFFED', severity: SEVERITY.WARNING, team: name,
                title: `${name} بكادر ناقص فعليًا`,
                detail: `الحاضر ${t.activeCount || 0} من ${t.requiredPersonnel || 0} مطلوب — الحالة المعتمدة «${t.status === 'ready' ? 'جاهز' : 'بانتظار التكميل'}»`
            });
        }
    }

    // ② توزيع الدعم حسب الحاجة: النقص المقرَّر (missing) قبل العجز الفعلي، ثم الأكبر عجزًا
    shortTeams.sort((a, b) => (a.kind === b.kind ? b.vacant - a.vacant : (a.kind === 'missing' ? -1 : 1)));

    // توصيات سد النقص — إسناد دعم متاح محدد بالاسم، أو تصعيد عند انعدامه
    for (const s of shortTeams) {
        const available = supporters.filter(p => p && !assignedSupporters.has(p.name));
        if (available.length > 0) {
            const picks = available.slice(0, s.vacant);
            for (const p of picks) assignedSupporters.add(p.name);
            recommendations.push({
                code: 'ASSIGN_SUPPORT', priority: s.kind === 'missing' ? 1 : 2, // ② الأولوية = شدة الخطر الأم
                title: `سد نقص ${s.name}`,
                action: `إسناد ${picks.map(p => p.name + (p.jobTitle ? ' (' + p.jobTitle + ')' : '')).join('، ')} دعمًا مؤقتًا إلى ${s.name}`,
                target: { team: s.name, supporters: picks.map(p => ({ name: p.name, jobTitle: p.jobTitle || null, sourceUnit: p.sourceUnit || p.team || null })) }
            });
            proactive.push({ code: 'SUPPORT_AVAILABLE', text: `الدعم المتاح يغطي نقص ${s.name} — يُنصح بالإسناد الفوري` });
        } else {
            recommendations.push({
                code: 'REQUEST_EXTERNAL_SUPPORT', priority: s.kind === 'missing' ? 1 : 2, // ② نقص حرج مكشوف ⇒ أولوية قصوى
                title: `تصعيد نقص ${s.name}`,
                action: `لا قوى متاحة في حوض الدعم — تصعيد طلب تغطية ${s.name} إلى إدارة العمليات`,
                target: { team: s.name }
            });
        }
    }

    // ═══ R04: مركبة الفريق غير جاهزة (اشتقاق vehicleOk الرسمي) ⇒ حرج ═══
    for (const name of teamNames) {
        const t = teams[name] || {};
        if (t.status === 'offline') continue;
        if (t.vehicleOk !== false) continue;
        const statusAr = t.vehicleStatus === 'breakdown' ? 'متعطلة' : (t.vehicleStatus === 'out_of_service' ? 'خارج الخدمة' : 'غير جاهزة');
        const vehName = t.vehicleId ? (vehNameById[t.vehicleId] || null) : null;
        risks.push({
            code: 'VEHICLE_NOT_READY', severity: SEVERITY.CRITICAL, team: name,
            title: `مركبة ${name} ${statusAr}`,
            detail: vehName ? `المركبة ${vehName} بحالة ${statusAr} ولا مركبة دعم صالحة للفريق` : `لا مركبة صالحة معيّنة لـ ${name}`
        });
        const reserve = reserveVehicles.find(v => v && !assignedVehicles.has(v.id));
        if (reserve) {
            assignedVehicles.add(reserve.id);
            recommendations.push({
                code: 'ASSIGN_RESERVE_VEHICLE', priority: 1,
                title: `تعويض مركبة ${name}`,
                action: `تعيين المركبة الاحتياطية ${reserve.name} إلى ${name} فورًا`,
                target: { team: name, vehicleId: reserve.id, vehicleName: reserve.name }
            });
        } else {
            recommendations.push({
                code: 'ESCALATE_VEHICLE', priority: 1,
                title: `تصعيد مركبة ${name}`,
                action: `لا احتياط متاح خارج الورشة — رفع بلاغ صيانة عاجل وتغطية ${name} بمركبة دعم من فريق مجاور`,
                target: { team: name }
            });
        }
        proactive.push({ code: 'VEHICLE_NOT_READY', text: `مركبة ${name} ${statusAr} — الجاهزية الميدانية متأثرة` });
    }

    // ═══ R05: عجز إجمالي في المركبات العاملة مقابل الفرق المطلوبة ⇒ انتباه ═══
    if ((wf.requiredTeams || 0) > 0 && typeof wf.totalCars === 'number' && wf.totalCars < wf.requiredTeams) {
        risks.push({
            code: 'VEHICLE_SHORTAGE', severity: SEVERITY.WARNING,
            title: 'عدد المركبات العاملة دون الفرق المطلوبة',
            detail: `${wf.totalCars} مركبة عاملة مقابل ${wf.requiredTeams} فرق في خطة المناوبة`
        });
    }

    // ① R06 أُلغي كخطر مستقل: نسبة الجاهزية نتيجة لمخاطر الفرق نفسها — تقود
    // readiness.status (أدناه) وتظهر في الملخص فقط، بلا مضاعفة للتنبيه.

    // ═══ R07: فرق بلا تكميل — ③ تحذير منتصف المناوبة، حرج مهدد للتسليم في النهائية ═══
    const pendingTeams = teamNames.filter(n => (teams[n] || {}).status === 'pending');
    const elapsedMin = (snap.shift && snap.shift.startedAt) ? minutesBetween(snap.shift.startedAt, generatedAt) : null;
    if (pendingTeams.length > 0 && elapsedMin !== null && elapsedMin > THRESHOLDS.PENDING_COMPLETION_MINUTES) {
        // ① الاعتماد محظور نظامًا ما دامت فرق بلا تكميل — الملاحظة تُحمل على توصية التكميل نفسها
        const blocker = pendingApprovals.length > 0
            ? ` — الاعتماد محظور حتى اكتمال التكميل (باقي ${pendingTeams.length} ${pendingTeams.length === 1 ? 'فريق' : 'فرق'})` : '';
        if (shiftPhase === SHIFT_PHASE.FINAL) {
            risks.push({
                code: 'COMPLETION_PENDING', severity: SEVERITY.CRITICAL,
                title: 'التسليم مهدد',
                detail: `الاعتماد محظور حتى البت في: ${pendingTeams.join('، ')} — المناوبة في مرحلتها النهائية`
            });
            recommendations.push({
                code: 'REQUEST_COMPLETION', priority: 1,
                title: 'إنقاذ التسليم',
                action: `البت الفوري في حالة: ${pendingTeams.join('، ')}${blocker}`,
                target: { teams: pendingTeams.slice() }
            });
            proactive.push({ code: 'HANDOVER_AT_RISK', text: 'التسليم مهدد — فرق بلا تكميل في المرحلة النهائية' });
        } else {
            risks.push({
                code: 'COMPLETION_PENDING', severity: SEVERITY.WARNING,
                title: `${pendingLabel(pendingTeams.length)} بلا تكميل`,
                detail: `مضى ${elapsedMin} دقيقة على بدء المناوبة دون البت في: ${pendingTeams.join('، ')}`
            });
            recommendations.push({
                code: 'REQUEST_COMPLETION', priority: 2,
                title: 'استكمال التكميل',
                action: `مطالبة المشرف بالبت في حالة: ${pendingTeams.join('، ')}${blocker}`,
                target: { teams: pendingTeams.slice() }
            });
        }
    }

    // ═══ R08: خلل توازن الضغط بين المراكز ⇒ انتباه ═══
    const centerGap = {};
    for (const name of teamNames) {
        const t = teams[name] || {};
        const center = t.center || 'غير محدد';
        if (!centerGap[center]) centerGap[center] = { required: 0, short: 0 };
        centerGap[center].required++;
        if (t.status === 'missing' || t.status === 'offline') centerGap[center].short++;
    }
    const centerNames = Object.keys(centerGap);
    if (centerNames.length > 1) {
        let maxC = null, minC = null;
        for (const c of centerNames) {
            if (!maxC || centerGap[c].short > centerGap[maxC].short) maxC = c;
            if (!minC || centerGap[c].short < centerGap[minC].short) minC = c;
        }
        const gap = centerGap[maxC].short - centerGap[minC].short;
        if (gap >= THRESHOLDS.CENTER_IMBALANCE_MIN_GAP && centerGap[maxC].short > 0) {
            risks.push({
                code: 'CENTER_IMBALANCE', severity: SEVERITY.WARNING,
                title: 'تفاوت الضغط بين المراكز',
                detail: `${maxC}: ${centerGap[maxC].short} فرق ناقصة/خارجة مقابل ${centerGap[minC].short} في ${minC} — يُنصح بإعادة توزيع الدعم`
            });
            proactive.push({ code: 'CENTER_IMBALANCE', text: `الضغط يتركز في ${maxC} — إعادة التوازن متاحة عبر حوض الدعم` });
        }
    }

    // ═══ R09: سير عمل بانتظار الاعتماد — ①③ لا يظهر إلا في المرحلة النهائية
    // وحين يكون الاعتماد ممكنًا فعلًا (صفر فرق معلّقة)؛ مسودة منتصف المناوبة وضع طبيعي ═══
    if (pendingApprovals.length > 0 && pendingTeams.length === 0 && shiftPhase === SHIFT_PHASE.FINAL) {
        for (const w of pendingApprovals) {
            risks.push({
                code: 'PENDING_APPROVAL', severity: SEVERITY.WARNING,
                title: `سير عمل بانتظار الاعتماد (نسخة ${w.versionNo != null ? w.versionNo : '—'})`,
                detail: w.createdByName ? `أعدّه ${w.createdByName} — المناوبة في مرحلتها النهائية والاعتماد مستحق` : 'نسخة مسودة — المناوبة في مرحلتها النهائية والاعتماد مستحق'
            });
        }
        recommendations.push({
            code: 'APPROVE_WORKFLOW', priority: 3, // إداري — أخيرًا دائمًا
            title: 'اعتماد سير العمل',
            action: `اعتماد ${pendingApprovals.length === 1 ? 'نسخة سير العمل' : pendingApprovals.length + ' نسخ'} قبل نهاية المناوبة`,
            target: { workflowIds: pendingApprovals.map(w => w.id) }
        });
        proactive.push({ code: 'PENDING_APPROVAL', text: 'الاعتماد مستحق — المناوبة في مرحلتها النهائية' });
    }

    // ─── الحالة الكلية: أي خطر حرج ⇒ critical، وإلا عتبة الجاهزية/تحذيرات ⇒ attention ───
    const hasCritical = risks.some(r => r.severity === SEVERITY.CRITICAL);
    const hasWarning = risks.some(r => r.severity === SEVERITY.WARNING);
    let readinessStatus;
    if (hasCritical || (typeof percent === 'number' && percent < THRESHOLDS.READINESS_CRITICAL_PERCENT)) {
        readinessStatus = READINESS_STATUS.CRITICAL;
    } else if (hasWarning || (typeof percent === 'number' && percent < THRESHOLDS.READINESS_ATTENTION_PERCENT)) {
        readinessStatus = READINESS_STATUS.ATTENTION;
    } else {
        readinessStatus = READINESS_STATUS.STABLE;
    }

    // ② الترتيب: الأولوية (شدة الخطر الأم) ثم النطاق التشغيلي (عجلات ← تغطية ← إداري)
    recommendations.sort((a, b) =>
        ((a.priority || 9) - (b.priority || 9))
        || ((REC_BAND[a.code] !== undefined ? REC_BAND[a.code] : 5) - (REC_BAND[b.code] !== undefined ? REC_BAND[b.code] : 5)));

    // ─── الملخص التنفيذي (جملة واحدة) ───
    let summary;
    if (!snap.shift) {
        summary = 'لا توجد مناوبة نشطة حاليًا — المنظومة في وضع الاستعداد';
    } else if (teamNames.length === 0) {
        summary = 'مناوبة نشطة بلا خطة فرق مجدولة بعد — تُستكمل الجدولة أولًا';
    } else if (risks.length === 0) {
        summary = `جاهزية ${percentText(percent)} — جميع الفرق مكتملة ولا مخاطر قائمة`;
    } else {
        const topRisk = risks.find(r => r.severity === SEVERITY.CRITICAL) || risks[0];
        const topRec = recommendations[0];
        summary = `جاهزية ${percentText(percent)} — ${topRisk.title}${topRec ? '؛ يُنصح: ' + topRec.action : ''}`;
    }

    return {
        generatedAt,
        shift: snap.shift ? {
            id: snap.shift.id != null ? snap.shift.id : null,
            type: snap.shift.type || null,
            date: snap.shift.date || null,
            status: snap.shift.status || null
        } : null,
        shiftPhase, // ③ مرحلة المناوبة الزمنية — لعرض واجهة لاحقة
        readiness: { percent, status: readinessStatus },
        risks,
        recommendations,
        proactive,
        summary
    };
}

module.exports = { assess, THRESHOLDS, SEVERITY, READINESS_STATUS, SHIFT_PHASE };
