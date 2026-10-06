/**
 * ═══ services/schedule-engine/proposal-service.js — محرك الاقتراحات (FSS E-5) ═══
 *
 * قرارات المالك المجمّدة 2026-10-06 (Design Revision 2 — J1–J7 + M5/M7/M13):
 *  ① عروض مسودة على شهر Draft فقط. لا Auto-Apply ولا كتابة في shift_roster
 *     إطلاقًا — accepted إشعار لحاملي schedule.proposals.manage والتطبيق عبر
 *     F-1/المسارات المعتمدة خارج E-5 (J4).
 *  ② M7 (حارس ثلاثي): استبعاد LIVE_OFFER_SAME_DAY عند بناء ranked_queue ·
 *     فحص العرض الحي قبل كل INSERT (generate وتسلسل J5) · الفهرس الفريد
 *     الجزئي uq_proposals_live_emp_date حارس بنيوي أخير. الفحص على مستوى
 *     الموظف بغض النظر عن الفريق. الحالات الحية = offered+accepted فقط.
 *  ③ M13: شهر published ⇒ توقف فوري بصفر كتابة في كل المسارات (generate /
 *     respond / تسلسل). العروض offered لشهر منشور تبقى تاريخية ميتة ولا
 *     تُحدَّث؛ respond عليها ⇒ 409 MONTH_PUBLISHED بلا تغيير حالة.
 *     superseded محصور قبل النشر (gap_resolved / withdraw).
 *  ④ J2: رموز الفترة من shift_codes (دوام) مرتبة code ASC — الأول يُختار،
 *     وتُسجَّل القائمة كاملة + selection_rule. بلا رمز ⇒ no_valid_shift_code.
 *  ⑤ M5 عبر ranking-service حرفيًا (4 أبعاد، request_age=null لا يحسم — J3).
 *  ⑥ J5 عند decline/withdraw: بوابة published ⇒ توقف بصفر كتابة · إعادة
 *     computeCoverage ⇒ met ⇒ gap_resolved وتوقف · التالي من ranked_queue مع
 *     إعادة validateAssignment لحظية كاملة + عضوية حية ⇒ invalid ⇒
 *     candidate_invalidated والتالي · عرض جديد rank_position+1 + Audit.
 *     من رفض لا يُعاد عرضه أبدًا. نهاية القائمة ⇒ queue_exhausted.
 *  ⑦ كل كتابة + قيد audit_log داخل tx.immediate واحدة (نمط E-1/E-2):
 *     أي فشل = ROLLBACK للعملية والتدقيق معًا. القراءات التحليلية تسبق
 *     الترانزاكشن (better-sqlite3 متزامنة)، وبوابة M13 وفحص M7 يُعادان
 *     داخلها على المقبض الخام — فلا كتابة بعد نشر مهما تأخرت التحليلات.
 *  ⑧ ranked_queue كاملة تُحفظ في run.gap_summary لكل فجوة مع queue_state
 *     (active/exhausted/resolved/aborted) — قابلة للتدقيق والتفسير.
 */
'use strict';

const coverageService = require('./coverage-service.js');
const { validateAssignment } = require('./validation-service.js');
const { rankCandidates } = require('./ranking-service.js');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

class ProposalError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** أيام شهر YYYY-MM (UTC — بلا حساسية توقيت). */
function _daysOfMonth(month) {
    const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= n; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
    return out;
}

class ProposalService {
    constructor(db) { this.db = db; }

    /** بوابة M13 (قراءة async قبل الترانزاكشن). */
    async _assertDraft(month) {
        const row = await this.db.ScheduleMonths.get(month);
        if (row && row.status === 'published') {
            throw new ProposalError(409, 'MONTH_PUBLISHED',
                `شهر ${month} منشور — محرك الاقتراحات لا يكتب في شهر منشور (M13)`);
        }
    }

    /** بوابة M13 داخل الترانزاكشن (فحص خام متزامن — صفر كتابة بعد النشر). */
    _assertDraftTx(hdl, month) {
        const row = hdl.prepare('SELECT status FROM schedule_months WHERE month = ?').get(month);
        if (row && row.status === 'published') {
            throw new ProposalError(409, 'MONTH_PUBLISHED',
                `شهر ${month} نُشر أثناء العملية — توقف فوري بصفر كتابة (M13)`);
        }
    }

    /** فحص M7 داخل الترانزاكشن: عرض حيٌّ لنفس الموظف في نفس اليوم؟ */
    _liveOfferTx(hdl, employeeId, date) {
        return hdl.prepare(
            `SELECT id, status FROM schedule_proposals WHERE employee_id = ? AND date = ?
             AND status IN ('offered','accepted')`).get(employeeId, date) || null;
    }

    /**
     * إدراج عرض جديد دائمًا — قرار المالك 2026-10-06 (مراجعة E-5): لا إحياء
     * للصفوف الساقطة إطلاقًا؛ declined/withdrawn حالات نهائية تاريخية تبقى
     * كما هي، والتشغيلة الجديدة تنشئ Proposal جديدًا مستقلًا فيبقى الـHistory
     * واضحًا (Proposal #1 ← declined · Proposal #2 ← offered). لا UNIQUE
     * رباعي في الجدول لهذا السبب تحديدًا؛ الحارس البنيوي الوحيد هو الفهرس
     * الجزئي على الحالات الحية (M7).
     * @returns {number} معرّف العرض الجديد
     */
    _insertOfferTx(hdl, { runId, month, teamId, employeeId, date, shiftCode, period, rankPosition, explanation, snapshot }) {
        const res = hdl.prepare(
            `INSERT INTO schedule_proposals
             (run_id, month, team_id, employee_id, date, shift_code, period, status, rank_position, ranking_explanation, coverage_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?)`)
            .run(runId, month, teamId, employeeId, date, shiftCode, period, rankPosition, explanation, snapshot);
        return res.lastInsertRowid;
    }

    // ═══════════════ القراءات ═══════════════

    async listByMonthTeam(month, teamId, status) {
        if (typeof month !== 'string' || !MONTH_RE.test(String(month).trim())) {
            throw new ProposalError(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة — المطلوب YYYY-MM');
        }
        teamId = Number(teamId);
        if (!Number.isInteger(teamId) || teamId <= 0) {
            throw new ProposalError(422, 'INVALID_TEAM', 'معرّف الفريق غير صالح');
        }
        return this.db.ScheduleProposals.getByMonthTeam(month.trim(), teamId, status || null);
    }

    async getRun(runId) {
        const run = await this.db.ScheduleProposalRuns.getById(runId);
        if (!run) throw new ProposalError(404, 'RUN_NOT_FOUND', `التشغيلة #${runId} غير موجودة`);
        return {
            ...run,
            gap_summary: run.gap_summary ? JSON.parse(run.gap_summary) : [],
            candidates_summary: run.candidates_summary ? JSON.parse(run.candidates_summary) : [],
            proposals: await this.db.ScheduleProposals.getByRun(runId)
        };
    }

    async getMine(emp, month) {
        const rows = month
            ? await this.db.ScheduleProposals.getByEmployeeMonth(emp.id, month)
            : await this.db.all('SELECT * FROM schedule_proposals WHERE employee_id = ? ORDER BY date, id', [emp.id]);
        return {
            proposals: rows.map(r => ({
                ...r,
                ranking_explanation: r.ranking_explanation ? JSON.parse(r.ranking_explanation) : null,
                coverage_snapshot: r.coverage_snapshot ? JSON.parse(r.coverage_snapshot) : null
            }))
        };
    }

    // ═══════════════ التوليد (J1/J2/J3/J6/J7) ═══════════════

    /**
     * توليد عروض مسودة لشهر/فريق: فجوة واحدة = عرض واحد للمرشح الأول فقط.
     * التحليل كله قراءة؛ الكتابة (run + offers + audits) في tx.immediate واحدة
     * مع إعادة بوابة M13 وفحص M7 داخلها.
     * @returns {Promise<{run_id, month, team_id, gaps, offers}>}
     */
    async generate({ month, teamId, user }) {
        if (typeof month !== 'string' || !MONTH_RE.test(month.trim())) {
            throw new ProposalError(422, 'INVALID_MONTH', 'صيغة الشهر غير صالحة — المطلوب YYYY-MM');
        }
        month = month.trim();
        teamId = Number(teamId);
        if (!Number.isInteger(teamId) || teamId <= 0) {
            throw new ProposalError(422, 'INVALID_TEAM', 'معرّف الفريق غير صالح');
        }
        const team = await this.db.get('SELECT id, name, center FROM teams WHERE id = ?', [teamId]);
        if (!team) throw new ProposalError(404, 'TEAM_NOT_FOUND', `الفريق #${teamId} غير موجود`);
        await this._assertDraft(month); // M13 — بوابة أولى (تُعاد داخل الترانزاكشن)

        const codes = await this.db.ShiftCodes.getAll();
        const codeMap = new Map((codes || []).map(c => [String(c.code), c]));

        // ── اكتشاف الفجوات عبر coverage-service الموحد (لا تعريف ثانٍ للتغطية) ──
        const gaps = [];
        for (const date of _daysOfMonth(month)) {
            const cov = await coverageService.computeCoverage(this.db, teamId, date);
            for (const period of ['day', 'night']) {
                if (!cov.missing.includes(period)) continue;
                gaps.push({
                    date, period,
                    missing: cov.rule[period] - cov[period],
                    coverage_before: { day: cov.day, night: cov.night, total: cov.total, rule: cov.rule }
                });
            }
        }

        // ── بناء الخطط (قراءة فقط) ──
        const gapSummary = [];
        const candidatesSummary = [];
        const plannedOffers = [];
        const plannedAudits = [];

        for (const gap of gaps) {
            const gapEntry = {
                date: gap.date, period: gap.period, missing: gap.missing,
                coverage_before: gap.coverage_before,
                shift_code_candidates: [], shift_code_selected: null,
                selection_rule: 'first_by_code_asc_in_period', // J2
                ranked_queue: [], queue_state: 'active', notes: []
            };

            // J2: مرشحو الرموز = دوام بفترة الفجوة، code ASC حتمي
            const periodCodes = (codes || [])
                .filter(c => coverageService.periodOf(c) === gap.period)
                .map(c => String(c.code))
                .sort();
            gapEntry.shift_code_candidates = periodCodes;
            if (periodCodes.length === 0) {
                gapEntry.queue_state = 'aborted';
                gapEntry.notes.push('no_valid_shift_code');
                gapSummary.push(gapEntry);
                continue;
            }
            const shiftCode = periodCodes[0]; // J2: الأول يُختار
            gapEntry.shift_code_selected = shiftCode;

            // إعادة التوليد لا تتكرر: للفجوة عرض حيٌّ قائم (offered/accepted) ⇒ تخطَّها
            const existingOffer = await this.db.get(
                `SELECT id FROM schedule_proposals WHERE team_id = ? AND date = ? AND period = ?
                 AND status IN ('offered','accepted')`, [teamId, gap.date, gap.period]);
            if (existingOffer) {
                gapEntry.queue_state = 'active';
                gapEntry.notes.push(`existing_live_offer: للفجوة عرض قائم #${existingOffer.id} — لا عرض مكرر`);
                gapSummary.push(gapEntry);
                continue;
            }

            // المرشحون: عضوية حية في التاريخ + نشط + بلا سطر roster ذلك اليوم
            const members = await this.db.all(
                `SELECT DISTINCT e.id FROM team_assignments ta
                 JOIN employees e ON e.id = ta.employee_id AND e.is_active = 1
                 WHERE ta.team_id = ? AND (ta.end_date IS NULL OR ta.end_date = '' OR ta.end_date >= ?)`,
                [teamId, gap.date]);
            const eligible = [];
            for (const m of members) {
                const rosterRow = await this.db.get(
                    'SELECT 1 AS x FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [m.id, gap.date]);
                if (rosterRow) {
                    candidatesSummary.push({ date: gap.date, period: gap.period, employee_id: m.id, stage: 'roster', reasons: ['HAS_ROSTER'] });
                    continue;
                }
                // M7 ①: استبعاد من لديه عرض حيٌّ في نفس اليوم (أي فريق)
                const live = await this.db.ScheduleProposals.getLiveByEmployeeDate(m.id, gap.date);
                if (live) {
                    candidatesSummary.push({ date: gap.date, period: gap.period, employee_id: m.id, stage: 'live_offer', reasons: ['LIVE_OFFER_SAME_DAY'], live_proposal_id: live.id });
                    continue;
                }
                // إعادة تحقق E-4 لحظية كاملة (J5-④ نفسها تُستخدم هنا — لا تكرار للقواعد)
                const v = await validateAssignment(this.db, {
                    employeeId: m.id, date: gap.date, shiftCode, operation: 'add', teamId
                });
                if (!v.valid) {
                    candidatesSummary.push({ date: gap.date, period: gap.period, employee_id: m.id, stage: 'validation', reasons: v.reasons });
                    continue;
                }
                eligible.push(m.id);
            }

            if (eligible.length === 0) {
                gapEntry.queue_state = 'exhausted';
                gapEntry.notes.push('queue_exhausted: لا مرشح صالح');
                gapSummary.push(gapEntry);
                continue;
            }

            // M5 حرفيًا عبر ranking-service (J3: request_age=null لا يحسم)
            const ranked = await rankCandidates(this.db, { month, candidates: eligible });
            gapEntry.ranked_queue = ranked.map(r => ({
                employee_id: r.employee_id, rank_position: r.rank_position, m5: r.m5, explanation: r.explanation, offered: false
            }));

            // عرض للأول فقط (J1) — فحص M7 النهائي يُعاد داخل الترانزاكشن
            const first = ranked[0];
            gapEntry.ranked_queue[0].offered = true;
            plannedOffers.push({
                gap, gapEntry, employeeId: first.employee_id, rankPosition: 1,
                shiftCode, ranking: first
            });
            plannedAudits.push({
                action: 'schedule_proposal_offer',
                detail: `عرض تكميلي: موظف #${first.employee_id} يوم ${gap.date} (${shiftCode}/${gap.period}) فريق #${teamId} شهر ${month} — رتبة M5 #1 (نسبة تفضيلات ${first.m5.pref_ratio.toFixed(2)} · عبء ${first.m5.burden_nights + first.m5.burden_holidays})`
            });
            gapSummary.push(gapEntry);
        }

        // ── الكتابة: run + العروض + الـAudit في ترانزاكشن واحدة ──
        const runId = this.db.tx.immediate((hdl) => {
            this._assertDraftTx(hdl, month); // M13 — صفر كتابة لو نُشر أثناء التحليل
            const r = hdl.prepare(
                `INSERT INTO schedule_proposal_runs (month, team_id, status, gap_summary, candidates_summary, created_by)
                 VALUES (?, ?, 'completed', ?, ?, ?)`)
                .run(month, teamId, JSON.stringify(gapSummary), JSON.stringify(candidatesSummary), user.id);
            const newRunId = r.lastInsertRowid;

            const insAudit = hdl.prepare(
                'INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)');
            insAudit.run(user.id, user.name || 'غير معروف', 'schedule_proposal_run',
                `تشغيلة اقتراحات #${newRunId}: شهر ${month} فريق #${teamId} — ${gaps.length} فجوة، ${plannedOffers.length} عرض`, 'schedule');

            let seq = 0;
            for (const offer of plannedOffers) {
                // M7 ②: فحص العرض الحي قبل كل INSERT (سباق محتمل بين التحليل والكتابة)
                if (this._liveOfferTx(hdl, offer.employeeId, offer.gap.date)) {
                    offer.skipped = 'LIVE_OFFER_SAME_DAY_RACE';
                    continue;
                }
                const cov = offer.gap.coverage_before;
                offer.proposalId = this._insertOfferTx(hdl, {
                    runId: newRunId, month, teamId, employeeId: offer.employeeId,
                    date: offer.gap.date, shiftCode: offer.shiftCode, period: offer.gap.period,
                    rankPosition: offer.rankPosition,
                    explanation: JSON.stringify(offer.ranking.explanation),
                    snapshot: JSON.stringify({ before: cov, after: { day: cov.day + (offer.gap.period === 'day' ? 1 : 0), night: cov.night + (offer.gap.period === 'night' ? 1 : 0), total: cov.total + 1, rule: cov.rule } })
                });
                const a = plannedAudits[seq];
                insAudit.run(user.id, user.name || 'غير معروف', a.action, `${a.detail} — عرض #${offer.proposalId}`, 'schedule');
                seq++;
            }
            return newRunId;
        });

        return {
            run_id: runId, month, team_id: teamId,
            gaps: gaps.length,
            offers: plannedOffers.filter(o => o.proposalId).map(o => ({
                proposal_id: o.proposalId, employee_id: o.employeeId,
                date: o.gap.date, period: o.gap.period, shift_code: o.shiftCode, rank_position: 1
            })),
            skipped: plannedOffers.filter(o => o.skipped).map(o => ({ employee_id: o.employeeId, date: o.gap.date, reason: o.skipped }))
        };
    }

    // ═══════════════ تسلسل J5 الداخلي ═══════════════

    /**
     * البحث عن فجوة العرض داخل gap_summary لتشغيلته (مطابقة date+period).
     */
    _findGap(gapSummary, date, period) {
        return (gapSummary || []).find(g => g.date === date && g.period === period) || null;
    }

    /**
     * J5 بعد decline/withdraw لعرض: سدّ الفجوة بالتالي في ranked_queue.
     * يُستدعى بعد تحديث حالة العرض الأصلي — داخل نفس الترانزاكشن لا يمكن
     * (قراءات async)، فيعمل كسلسلة: تحليل async ← ترانزاكشن كتابة واحدة.
     * @returns {Promise<{outcome, nextProposalId?, nextEmployeeId?}>}
     */
    async _cascade(proposal, run, gapEntry, user) {
        // ② إعادة التغطية لحظيًا — سُدّت يدويًا؟
        const cov = await coverageService.computeCoverage(this.db, proposal.team_id, proposal.date);
        if (!cov.missing.includes(proposal.period)) {
            return { outcome: 'gap_resolved', coverage: cov };
        }

        // ③④ التالي من ranked_queue مع إعادة تحقق E-4 لحظية + عضوية حية
        const queue = (gapEntry.ranked_queue || []).slice().sort((a, b) => a.rank_position - b.rank_position);
        const declined = new Set(
            (await this.db.all(
                `SELECT employee_id FROM schedule_proposals WHERE run_id = ? AND date = ? AND period = ? AND status IN ('declined','withdrawn','offered','accepted','superseded')`,
                [proposal.run_id, proposal.date, proposal.period])).map(r => Number(r.employee_id)));
        // من رُفض/وُضع له عرض لهذه الفجوة لا يُعاد عرضه أبدًا (J5-⑥)
        let chosen = null, chosenValidation = null;
        for (const cand of queue) {
            if (declined.has(Number(cand.employee_id))) continue;
            // عرض حيٌّ لنفس اليوم (أي فريق) — M7
            const live = await this.db.ScheduleProposals.getLiveByEmployeeDate(cand.employee_id, proposal.date);
            if (live) { cand.invalidated = 'LIVE_OFFER_SAME_DAY'; continue; }
            const membership = await this.db.get(
                `SELECT 1 AS x FROM team_assignments ta WHERE ta.employee_id = ? AND ta.team_id = ?
                 AND (ta.end_date IS NULL OR ta.end_date = '' OR ta.end_date >= ?) LIMIT 1`,
                [cand.employee_id, proposal.team_id, proposal.date]);
            if (!membership) { cand.invalidated = 'EMPLOYEE_NO_ACTIVE_TEAM'; continue; }
            const v = await validateAssignment(this.db, {
                employeeId: cand.employee_id, date: proposal.date,
                shiftCode: proposal.shift_code, operation: 'add', teamId: proposal.team_id
            });
            if (!v.valid) { cand.invalidated = v.reasons.join(','); continue; }
            chosen = cand; chosenValidation = v;
            break;
        }
        if (!chosen) return { outcome: 'queue_exhausted', queue };

        return { outcome: 'offer_next', chosen, coverage: cov, validation: chosenValidation, queue };
    }

    // ═══════════════ رد الموظف (J5/J4/M13) ═══════════════

    /**
     * رد الموظف على عرضه: accept|decline.
     * accept ⇒ accepted + إشعار حاملي schedule.proposals.manage (من server.js بعد COMMIT — J4).
     * decline ⇒ declined + تسلسل J5 كامل في ترانزاكشن واحدة.
     */
    async respond(emp, user, proposalId, decision) {
        if (!['accept', 'decline'].includes(decision)) {
            throw new ProposalError(422, 'INVALID_DECISION', 'القرار يجب أن يكون accept أو decline');
        }
        const proposal = await this.db.ScheduleProposals.getById(proposalId);
        if (!proposal) throw new ProposalError(404, 'NOT_FOUND', 'العرض غير موجود');
        if (Number(proposal.employee_id) !== Number(emp.id)) {
            throw new ProposalError(403, 'NOT_PROPOSAL_OWNER', 'لا يمكنك الرد على عرض ليس لك');
        }
        // M13: شهر منشور ⇒ 409 بلا أي تغيير حالة — العروض offered تبقى تاريخية ميتة
        await this._assertDraft(proposal.month);
        if (proposal.status !== 'offered') {
            throw new ProposalError(409, 'PROPOSAL_NOT_RESPONDABLE', `لا يمكن الرد على عرض بحالة ${proposal.status}`);
        }

        if (decision === 'accept') {
            // J4: لا Auto-Apply — مجرد قبول يُشعر المسؤول (من server.js بعد COMMIT)
            this.db.tx.immediate((hdl) => {
                this._assertDraftTx(hdl, proposal.month); // M13 — إعادة داخلية
                const r = hdl.prepare(
                    `UPDATE schedule_proposals SET status='accepted', responded_at=datetime('now'), responded_by=?
                     WHERE id=? AND status='offered'`).run(user.id, proposalId);
                if (r.changes === 0) throw new ProposalError(409, 'PROPOSAL_NOT_RESPONDABLE', 'تغيّرت حالة العرض أثناء الرد');
                hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)')
                    .run(user.id, user.name || 'غير معروف', 'schedule_proposal_respond',
                        `قبول العرض التكميلي #${proposalId} (موظف #${proposal.employee_id} يوم ${proposal.date} ${proposal.shift_code}) — J4: لا تطبيق آلي، الإشعار لحاملي schedule.proposals.manage`, 'schedule');
            });
            return { id: Number(proposalId), status: 'accepted', proposal };
        }

        // ── decline + تسلسل J5 ──
        return this._declineAndCascade(proposal, user, 'declined');
    }

    /** سحب المسؤول لعرض قائم (offered فقط) + تسلسل J5. */
    async withdraw(user, proposalId) {
        const proposal = await this.db.ScheduleProposals.getById(proposalId);
        if (!proposal) throw new ProposalError(404, 'NOT_FOUND', 'العرض غير موجود');
        await this._assertDraft(proposal.month); // M13 — صفر كتابة بعد النشر
        if (proposal.status !== 'offered') {
            throw new ProposalError(409, 'PROPOSAL_NOT_WITHDRAWABLE', `لا يمكن سحب عرض بحالة ${proposal.status}`);
        }
        return this._declineAndCascade(proposal, user, 'withdrawn');
    }

    /**
     * decline/withdraw + J5: تحليل async ← ترانزاكشن كتابة واحدة تشمل:
     * تحديث العرض الأصلي · تحديث gap_summary (queue_state/invalidations) ·
     * العرض الجديد إن وجد · كل قيود الـAudit.
     */
    async _declineAndCascade(proposal, user, newStatus) {
        const run = await this.db.ScheduleProposalRuns.getById(proposal.run_id);
        const gapSummary = run && run.gap_summary ? JSON.parse(run.gap_summary) : [];
        const gapEntry = this._findGap(gapSummary, proposal.date, proposal.period);
        const cascade = gapEntry
            ? await this._cascade(proposal, run, gapEntry, user)
            : { outcome: 'queue_exhausted' };

        const result = this.db.tx.immediate((hdl) => {
            this._assertDraftTx(hdl, proposal.month); // M13 — توقف فوري بصفر كتابة
            const insAudit = hdl.prepare('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (NULL, ?, ?, ?, ?, ?)');

            // تحديث العرض الأصلي بقفل شرطي
            const upd = hdl.prepare(
                `UPDATE schedule_proposals SET status=?, responded_at=datetime('now'), responded_by=?
                 WHERE id=? AND status='offered'`).run(newStatus, user.id, proposal.id);
            if (upd.changes === 0) throw new ProposalError(409, 'PROPOSAL_NOT_RESPONDABLE', 'تغيّرت حالة العرض أثناء العملية');
            insAudit.run(user.id, user.name || 'غير معروف',
                newStatus === 'declined' ? 'schedule_proposal_respond' : 'schedule_proposal_withdraw',
                `${newStatus === 'declined' ? 'رفض' : 'سحب'} العرض التكميلي #${proposal.id} (موظف #${proposal.employee_id} يوم ${proposal.date} ${proposal.shift_code})`, 'schedule');

            let nextProposalId = null, nextEmployeeId = null;
            if (gapEntry) {
                if (cascade.outcome === 'gap_resolved') {
                    gapEntry.queue_state = 'resolved';
                    gapEntry.notes = (gapEntry.notes || []).concat([`gap_resolved: سُدّت الفجوة خارج E-5 (فحص لحظي بعد ${newStatus})`]);
                    insAudit.run(user.id, user.name || 'غير معروف', 'schedule_proposal_gap_resolved',
                        `فجوة ${proposal.date}/${proposal.period} فريق #${proposal.team_id} سُدّت — لا عرض تالٍ (J5-②)`, 'schedule');
                } else if (cascade.outcome === 'offer_next') {
                    const chosen = cascade.chosen;
                    // M7 ②: فحص العرض الحي قبل الـINSERT مرة أخرى داخل الترانزاكشن
                    if (!this._liveOfferTx(hdl, chosen.employee_id, proposal.date)) {
                        const cov = cascade.coverage;
                        nextProposalId = this._insertOfferTx(hdl, {
                            runId: proposal.run_id, month: proposal.month, teamId: proposal.team_id,
                            employeeId: chosen.employee_id, date: proposal.date,
                            shiftCode: proposal.shift_code, period: proposal.period,
                            rankPosition: chosen.rank_position,
                            explanation: JSON.stringify(chosen.explanation || null),
                            snapshot: JSON.stringify({ before: { day: cov.day, night: cov.night, total: cov.total, rule: cov.rule } })
                        });
                        nextEmployeeId = chosen.employee_id;
                        const qe = (gapEntry.ranked_queue || []).find(q => Number(q.employee_id) === Number(chosen.employee_id));
                        if (qe) qe.offered = true;
                        insAudit.run(user.id, user.name || 'غير معروف', 'schedule_proposal_next_offered',
                            `تسلسل J5: عرض تالٍ #${nextProposalId} لموظف #${nextEmployeeId} يوم ${proposal.date} (${proposal.shift_code}) رتبة M5 #${chosen.rank_position}`, 'schedule');
                    } else {
                        gapEntry.queue_state = 'exhausted';
                        gapEntry.notes = (gapEntry.notes || []).concat(['queue_exhausted: التالي الوحيد لديه عرض حيٌّ (سباق M7)']);
                    }
                } else { // queue_exhausted
                    gapEntry.queue_state = 'exhausted';
                    gapEntry.notes = (gapEntry.notes || []).concat(['queue_exhausted: لا مرشح صالح متبقٍ (J5-⑥)']);
                    insAudit.run(user.id, user.name || 'غير معروف', 'schedule_proposal_queue_exhausted',
                        `فجوة ${proposal.date}/${proposal.period} فريق #${proposal.team_id}: استنفدت قائمة المرشحين`, 'schedule');
                }
                // توثيق الإبطالات اللحظية (candidate_invalidated — J5-④)
                for (const cand of (cascade.queue || [])) {
                    if (!cand.invalidated) continue;
                    const qe = (gapEntry.ranked_queue || []).find(q => Number(q.employee_id) === Number(cand.employee_id));
                    if (qe && !qe.invalidated) qe.invalidated = cand.invalidated;
                }
                // حفظ gap_summary المحدّث في سطر التشغيلة
                hdl.prepare('UPDATE schedule_proposal_runs SET gap_summary = ? WHERE id = ?')
                    .run(JSON.stringify(gapSummary), proposal.run_id);
            }
            return { id: Number(proposal.id), status: newStatus, next_proposal_id: nextProposalId, next_employee_id: nextEmployeeId, outcome: cascade.outcome, proposal };
        });
        return result;
    }
}

module.exports = { ProposalService, ProposalError };
