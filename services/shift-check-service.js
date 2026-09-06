/**
 * ═══ shift-check-service.js — إجراءات الاستلام والتسليم (بوابة الموظف v3، معتمدة 2026-09-04)
 *     موسّعة إلى نظام التشييك الذكي v4.2 (معتمد مبدئيًا 2026-09-06) ═══
 *
 * سجل تشييك واحد مشترك لكل (مناوبة/فرقة/مركبة) — يشترك فيه موظفا الفرقة:
 *   · يُنشأ كسولًا من تكليف roster لليوم فقط (كتابة = بلا primary_fallback).
 *   · v4.2: الجلسات الجديدة (schema_version=2) تُبنى من القالب المركزي check-template.js:
 *     ميكانيكي 26 بندًا/7 مجموعات + طبي 4 مجموعات بكميات (ALS حسب نوع المركبة من السجل)،
 *     وقسم «الأصول المسجلة على الفرقة» يبقى لقطة عهدة مستقلة (group_key='assets').
 *   · الجلسات القديمة (schema_version=1) تكمل بقواعد v3 دون تغيير.
 *   · «لا تغيير» تأكيد فعلي مسجل بالوقت/المستخدم — لا يُتاح مع ملاحظة مفتوحة أو فحص
 *     أقدم من NO_CHANGE_MAX_AGE_HOURS أو بلا فحص سابق أو عند تغيّر المركبة.
 *   · الجاهزية 🟢/🟡/🔴 مشتقة تلقائيًا (computeReadiness) — لا يختارها المسعف،
 *     وتُخزن في الجلسة لتقرأها شاشات العمليات من مصدر واحد (شارة إعلامية فقط).
 *   · «تم التحقق» السليم يُحفظ في الجلسة فقط؛ النقص/التلف/الملاحظة فقط تنعكس:
 *       طبي     → asset_events (note_added — يظهر في سجل الجهاز، بلا تغيير حالة رسمية)
 *       ميكانيكي → operational_events عبر VehicleEventsService.appendEvent (note)
 *   · تأكيد اطلاع/استلام/تسليم مستقل لكل موظف؛ لا جلسة ثانية لنفس الثلاثية.
 *
 * قيود معمارية موروثة (موثقة): انعكاس المركبة يتطلب مناوبة نشطة
 * (ختم سيرفري في VehicleEventsService) — عند غيابها يُحفظ البند ويُوسم reflected=0.
 */
'use strict';

const TimeRiyadh = require('../public/js/time-riyadh.js'); // الطبقة المركزية للوقت (TIME-POLICY)
const MyPortalService = require('./my-portal-service');
const CheckTemplate = require('./check-template'); // القالب المركزي الوحيد للمجموعات/البنود/الكميات/الحرجية

function pad2(v) { return String(Number(v)).padStart(2, '0'); }
function riyadhToday() {
    const p = TimeRiyadh.riyadhParts(new Date());
    return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : null;
}

/** v3 القديم: بنود الجلسات schema_version=1 فقط. الجلسات الجديدة تُبنى من CheckTemplate. */
const MECH_TEMPLATE = [
    { key: 'exterior', label: 'الحالة الخارجية والداخلية' },
    { key: 'fuel_oil', label: 'الوقود والزيوت' },
    { key: 'tires', label: 'الإطارات' },
    { key: 'sirens', label: 'صافرات الإنذار' },
    { key: 'lights', label: 'الأضواء التحذيرية' },
    { key: 'radio', label: 'أجهزة التواصل اللاسلكي' },
    { key: 'digital', label: 'الأنظمة الرقمية الملحقة بالمركبة' }
];

class ShiftCheckService {
    constructor({ db, getVehicleEventsService }) {
        if (!db) throw new Error('ShiftCheckService: db مطلوب');
        this.db = db;
        this.getVehicleEventsService = typeof getVehicleEventsService === 'function' ? getVehicleEventsService : null;
        // تركيب (لا نسخ): الهوية والتكليف والفرق من خدمة البوابة نفسها
        this.portal = new MyPortalService({ db, getVehicleEventsService });
    }

    /** سياق اليوم: الموظف + تكليف roster لليوم (كتابة = roster فقط) + الفرقة الميدانية. */
    async _todayContext(user) {
        const emp = await this.portal.resolveEmployee(user);
        if (!emp) return { notFound: true };
        const today = riyadhToday();
        const row = await this.db.get(
            'SELECT team_id, shift_code FROM shift_roster WHERE employee_id = ? AND shift_date = ?',
            [emp.id, today]);
        if (!row || row.team_id == null) return { state: 'no_assignment', emp, today };
        const { teamById } = await this.portal._refs();
        const team = teamById.get(row.team_id) || null;
        if (!this.portal._isFieldTeam(team)) return { state: 'not_field_team', emp, today, team };
        const members = await this.db.all(
            `SELECT e.id, e.name, e.employee_code FROM shift_roster r
             JOIN employees e ON e.id = r.employee_id
             WHERE r.team_id = ? AND r.shift_date = ?`, [team.id, today]);
        return { emp, today, team, members };
    }

    /** مركبة الفرقة الحالية (اشتقاق getBoard نفسه عبر الخدمة الرسمية) أو null. */
    async _currentVehicle(teamId) {
        const ves = this.getVehicleEventsService ? this.getVehicleEventsService() : null;
        if (!ves) return null;
        const list = await ves.getTeamVehicles(teamId);
        return list.length ? list[0] : null;
    }

    /**
     * مركبة ALS؟ — من حقل service_level الصريح في سجل المركبة فقط (قرار المالك:
     * لا مطابقة نصية على الموديل). NULL = غير مؤكد ← BLS مؤقتًا مع وسم «غير مؤكد».
     */
    _isAls(vehicle) {
        return !!(vehicle && vehicle.serviceLevel === 'ALS');
    }

    /** إيجاد أو إنشاء الجلسة المشتركة + لقطة البنود عند الإنشاء فقط. */
    async _findOrCreateSession(ctx) {
        const vehicle = await this._currentVehicle(ctx.team.id);
        const vehId = vehicle ? String(vehicle.vehicleId) : '';
        let session = await this.db.get(
            'SELECT * FROM shift_check_sessions WHERE shift_date = ? AND team_id = ? AND vehicle_id = ?',
            [ctx.today, ctx.team.id, vehId]);
        if (session) return { session, vehicle, created: false };

        const ins = await this.db.run(
            `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, created_by, schema_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 2)`,
            [ctx.today, ctx.team.id, ctx.team.name, vehId, vehicle ? vehicle.name : null, ctx.team.center || null, String(ctx.emp.employee_code)]);
        session = await this.db.get('SELECT * FROM shift_check_sessions WHERE id = ?', [ins.id]);

        // v4.2 — لقطة البنود من القالب المركزي:
        // الطبي = 4 مجموعات بكميات مطلوبة (ALS فقط لمركبات ALS من سجل النظام)
        const isAls = this._isAls(vehicle);
        for (const g of CheckTemplate.MEDICAL_GROUPS) {
            if (g.alsOnly && !isAls) continue;
            for (const it of g.items) {
                await this.db.run(
                    `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, group_key, qty_required)
                     VALUES (?, 'medical', ?, ?, ?, ?)`,
                    [session.id, 'med:' + g.key + ':' + it.key, it.label, g.key, it.qty || null]);
            }
        }
        // قسم الأصول: لقطة عهدة الفرقة الحالية (مستقل — لا نسبة لمركبة ولا تغيير ارتباط)
        const assets = await this.db.all(
            `SELECT id, asset_code, type_name, status FROM assets
             WHERE team_name = ? AND archived_at IS NULL ORDER BY type_name, asset_code`, [ctx.team.name]);
        for (const a of assets) {
            await this.db.run(
                `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, asset_id, group_key)
                 VALUES (?, 'medical', ?, ?, ?, ?)`,
                [session.id, 'asset:' + a.id, a.type_name + ' (' + a.asset_code + ')', a.id, 'assets']);
        }
        // الميكانيكي = 26 بندًا/7 مجموعات من القالب — فقط عند وجود مركبة فعلية
        if (vehicle) {
            for (const g of CheckTemplate.MECHANICAL_GROUPS) {
                for (const m of g.items) {
                    await this.db.run(
                        `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, group_key, qty_required)
                         VALUES (?, 'mechanical', ?, ?, ?, ?)`,
                        [session.id, 'mech:' + m.key, m.label, g.key, m.qty || null]);
                }
            }
        }
        return { session, vehicle, created: true };
    }

    /** الملاحظات المفتوحة: آخر حالة لكل بند (طبي: الأصل عالميًا · ميكانيكي: نفس المركبة) — لا تختفي إلا بفحص لاحق سليم. */
    async _openIssues(session, currentAssetIds) {
        const out = [];
        if (currentAssetIds.length) {
            const rows = await this.db.all(
                `SELECT i.item_key, i.item_label, i.result, i.note, i.checked_by_name, i.checked_at, i.session_id
                 FROM shift_check_items i
                 WHERE i.domain = 'medical' AND i.asset_id IN (${currentAssetIds.map(() => '?').join(',')}) AND i.result IS NOT NULL
                 ORDER BY i.checked_at ASC, i.id ASC`, currentAssetIds);
            const latest = new Map();
            for (const r of rows) latest.set(r.item_key, r);
            for (const r of latest.values()) if (r.result === 'issue') out.push({ domain: 'medical', ...r });
        }
        if (session.vehicle_id) {
            const rows = await this.db.all(
                `SELECT i.item_key, i.item_label, i.result, i.note, i.checked_by_name, i.checked_at, i.session_id
                 FROM shift_check_items i JOIN shift_check_sessions s ON s.id = i.session_id
                 WHERE s.vehicle_id = ? AND i.domain = 'mechanical' AND i.result IS NOT NULL
                 ORDER BY i.checked_at ASC, i.id ASC`, [session.vehicle_id]);
            const latest = new Map();
            for (const r of rows) latest.set(r.item_key, r);
            for (const r of latest.values()) if (r.result === 'issue') out.push({ domain: 'mechanical', ...r });
        }
        return out;
    }

    _err(statusCode, message, code) {
        const e = new Error(message); e.statusCode = statusCode; e.code = code; return e;
    }

    /** آخر جلسة مكتملة لنفس المركبة (أو الفرقة عند غياب مركبة) — مرجع «لا تغيير». */
    async _lastCompletedCheck(session) {
        if (session.vehicle_id) {
            return this.db.get(
                `SELECT id, completed_at, vehicle_id, vehicle_name FROM shift_check_sessions
                 WHERE status = 'completed' AND id != ? AND vehicle_id = ?
                 ORDER BY completed_at DESC LIMIT 1`, [session.id, session.vehicle_id]);
        }
        return this.db.get(
            `SELECT id, completed_at, vehicle_id, vehicle_name FROM shift_check_sessions
             WHERE status = 'completed' AND id != ? AND team_id = ?
             ORDER BY completed_at DESC LIMIT 1`, [session.id, session.team_id]);
    }

    /**
     * أهلية «لا تغيير» (قواعد المالك المشددة): لا تُتاح مع ملاحظة مفتوحة،
     * أو فحص أقدم من NO_CHANGE_MAX_AGE_HOURS، أو بلا فحص سابق، أو عند تغيّر المركبة.
     */
    async _noChangeEligibility(session, items, openIssues) {
        const reasons = [];
        if (openIssues.length || items.some(i => i.result === 'issue')) reasons.push('open_issues');
        const last = await this._lastCompletedCheck(session);
        if (!last || !last.completed_at) {
            reasons.push('no_previous_check');
        } else {
            const ageH = (Date.now() - new Date(last.completed_at).getTime()) / 36e5;
            if (ageH > CheckTemplate.NO_CHANGE_MAX_AGE_HOURS) reasons.push('stale_check');
            if (session.vehicle_id && last.vehicle_id !== session.vehicle_id) reasons.push('vehicle_changed');
        }
        return {
            eligible: reasons.length === 0,
            reasons,
            lastCheck: last ? { at: last.completed_at, vehicleName: last.vehicle_name || null } : null
        };
    }

    /**
     * اشتقاق الجاهزية من مصدر واحد — 🟢/🟡/🔴 محسوبة، لا يختارها المسعف.
     * 🔴: بند حرج معطوب أو حقل مركبة حرج · 🟡: ملاحظة/نقص غير حرج أو ملاحظة مفتوحة
     * 🟢: كل البنود سليمة/مؤكدة ولا ملاحظات مؤثرة (تتطلب اكتمال الفحص وحقول المركبة).
     */
    computeReadiness(session, items, openIssues) {
        const reds = [], yellows = [];
        for (const f of ['fuel_level', 'master_key', 'fuel_card']) {
            const sev = CheckTemplate.vehicleFieldSeverity(f, session[f]);
            if (sev === 'red') reds.push(CheckTemplate.VEHICLE_FIELDS[f].label);
            else if (sev === 'yellow') yellows.push(CheckTemplate.VEHICLE_FIELDS[f].label);
        }
        for (const i of items) {
            if (i.result !== 'issue') continue;
            const sev = CheckTemplate.issueSeverity(i.item_key, i.status_detail);
            if (sev === 'red') reds.push(i.item_label);
            else if (sev === 'yellow') yellows.push(i.item_label);
        }
        for (const o of openIssues) {
            const sev = CheckTemplate.issueSeverity(o.item_key, null);
            if (sev === 'red') reds.push(o.item_label + ' (مفتوحة)');
            else if (sev === 'yellow') yellows.push(o.item_label + ' (مفتوحة)');
        }
        if (reds.length) return { readiness: 'red', reason: reds.join(' · ') };
        if (yellows.length) return { readiness: 'yellow', reason: yellows.join(' · ') };
        const allDone = items.length > 0 && items.every(i => i.result != null || i.no_change === 1);
        const vehDone = !session.vehicle_id || session.odometer != null;
        if (allDone && vehDone) return { readiness: 'green', reason: 'لا ملاحظات مؤثرة ولا نواقص حرجة' };
        return { readiness: null, reason: null }; // لم يُستكمل الفحص بعد
    }

    /** إعادة احتساب الجاهزية وتخزينها في الجلسة (تُستدعى بعد كل كتابة). */
    async _recomputeReadiness(sessionId) {
        const session = await this.db.get('SELECT * FROM shift_check_sessions WHERE id = ?', [sessionId]);
        if (!session || (session.schema_version || 1) < 2) return null;
        const items = await this.db.all('SELECT * FROM shift_check_items WHERE session_id = ?', [sessionId]);
        const assetIds = items.filter(i => i.domain === 'medical' && i.asset_id != null).map(i => i.asset_id);
        const openIssues = await this._openIssues(session, assetIds);
        const r = this.computeReadiness(session, items, openIssues);
        await this.db.run(
            'UPDATE shift_check_sessions SET readiness = ?, readiness_reason = ?, readiness_at = ? WHERE id = ?',
            [r.readiness, r.reason, r.readiness ? new Date().toISOString() : null, sessionId]);
        return r;
    }

    /** حالة الجلسة الكاملة للواجهة. الحالات الصادقة: no_assignment / not_field_team. */
    async getSession(user) {
        const ctx = await this._todayContext(user);
        if (ctx.notFound) return { notFound: true };
        if (ctx.state) return { state: ctx.state, today: ctx.today };

        const { session, vehicle } = await this._findOrCreateSession(ctx);
        const items = await this.db.all(
            'SELECT * FROM shift_check_items WHERE session_id = ? ORDER BY domain, id', [session.id]);
        const confirmations = await this.db.all(
            'SELECT employee_id, employee_name, kind, confirmed_at FROM shift_check_confirmations WHERE session_id = ?', [session.id]);
        const assetIds = items.filter(i => i.domain === 'medical' && i.asset_id != null).map(i => i.asset_id);
        const openIssues = await this._openIssues(session, assetIds);

        const flatItems = items.map(i => ({
            itemKey: i.item_key, domain: i.domain, label: i.item_label,
            groupKey: i.group_key || null, qtyRequired: i.qty_required || null,
            result: i.result || null, statusDetail: i.status_detail || null,
            qtyAvailable: i.qty_available || null, note: i.note || null,
            noChange: !!i.no_change, refCheckedAt: i.ref_checked_at || null,
            checkedByName: i.checked_by_name || null, checkedAt: i.checked_at || null,
            reflected: !!i.reflected
        }));
        const mappedOpen = openIssues.map(o => ({
            domain: o.domain, itemKey: o.item_key, label: o.item_label,
            note: o.note, byName: o.checked_by_name, at: o.checked_at
        }));

        // v4.2 — تجميع البنود في مجموعات القالب (الجلسات القديمة v1 تُجمّع حسب domain)
        const isV2 = (session.schema_version || 1) >= 2;
        const groupOrder = [];
        const groupMap = new Map();
        if (isV2) {
            for (const g of CheckTemplate.MECHANICAL_GROUPS) groupOrder.push({ key: g.key, label: g.label, domain: 'mechanical' });
            for (const g of CheckTemplate.MEDICAL_GROUPS) {
                if (g.alsOnly && !this._isAls(vehicle)) continue;
                groupOrder.push({ key: g.key, label: g.label, domain: 'medical' });
            }
            groupOrder.push({ key: 'assets', label: CheckTemplate.ASSETS_GROUP.label, domain: 'medical', isAssets: true });
        }
        for (const g of groupOrder) groupMap.set(g.key, { ...g, items: [] });
        for (const i of flatItems) {
            const gk = i.groupKey || (i.domain === 'mechanical' ? '_legacy_mech' : '_legacy_med');
            if (!groupMap.has(gk)) groupMap.set(gk, {
                key: gk, domain: i.domain,
                label: i.domain === 'mechanical' ? 'التشييك الميكانيكي والتقني' : 'الأصول المسجلة على الفرقة',
                isAssets: i.domain === 'medical', items: []
            });
            groupMap.get(gk).items.push(i);
        }
        const groups = [...groupMap.values()].filter(g => g.items.length > 0 || groupOrder.some(o => o.key === g.key));

        const noChange = isV2 && session.status === 'open'
            ? await this._noChangeEligibility(session, items, openIssues) : null;

        return {
            today: ctx.today,
            session,
            vehicle: vehicle || null,
            vehicleType: vehicle ? vehicle.vehicleType || null : null,
            serviceLevel: vehicle ? vehicle.serviceLevel || null : null,
            serviceLevelConfirmed: !!(vehicle && vehicle.serviceLevel),
            isAls: this._isAls(vehicle),
            team: { teamId: ctx.team.id, teamName: ctx.team.name, center: ctx.team.center || null },
            members: ctx.members,
            me: { id: ctx.emp.id, name: ctx.emp.name, code: ctx.emp.employee_code },
            items: flatItems,
            groups,
            confirmations,
            openIssues: mappedOpen,
            readiness: session.readiness || null,
            readinessReason: session.readiness_reason || null,
            readinessAt: session.readiness_at || null,
            checkMode: session.check_mode || null,
            vehicleFields: {
                odometer: session.odometer != null ? session.odometer : null,
                fuel_level: session.fuel_level || null,
                cleanliness: session.cleanliness || null,
                master_key: session.master_key != null ? session.master_key : null,
                fuel_card: session.fuel_card != null ? session.fuel_card : null
            },
            vehicleFieldDefs: CheckTemplate.VEHICLE_FIELDS,
            itemStatuses: CheckTemplate.ITEM_STATUSES,
            noChange,
            noChangeMaxAgeHours: CheckTemplate.NO_CHANGE_MAX_AGE_HOURS,
            mechTemplate: MECH_TEMPLATE.map(m => m.key)
        };
    }

    /** تسجيل بند (تم التحقق / ملاحظة + حالة تفصيلية v4.2). idempotent عبر UNIQUE(session_id,item_key). */
    async checkItem(user, { itemKey, result, note, statusDetail, qtyAvailable }) {
        if (!itemKey || typeof itemKey !== 'string') throw this._err(422, 'item_key مطلوب', 'BAD_INPUT');
        if (statusDetail != null && !CheckTemplate.ITEM_STATUSES.includes(statusDetail))
            throw this._err(422, 'حالة البند غير صالحة', 'BAD_INPUT');
        // الاتساق: الحالة التفصيلية تحدد النتيجة أولًا (complete → ok؛ غيرها → issue)
        if (statusDetail) result = statusDetail === 'complete' ? 'ok' : 'issue';
        if (result !== 'ok' && result !== 'issue') throw this._err(422, 'النتيجة ok أو issue فقط', 'BAD_INPUT');
        const ctx = await this._todayContext(user);
        if (ctx.notFound) throw this._err(404, 'لا يوجد ملف موظف مرتبط بهذا الحساب', 'NO_EMPLOYEE');
        if (ctx.state === 'no_assignment') throw this._err(409, 'لا يوجد تكليف مسجل لك اليوم — الجلسة السابقة محفوظة كما هي', 'NO_ASSIGNMENT');
        if (ctx.state === 'not_field_team') throw this._err(409, 'التشييك للفرق الميدانية فقط', 'NOT_FIELD_TEAM');

        const { session } = await this._findOrCreateSession(ctx);
        if (session.status !== 'open') throw this._err(409, 'الجلسة مكتملة — التسليم تم', 'SESSION_COMPLETED');
        const item = await this.db.get(
            'SELECT * FROM shift_check_items WHERE session_id = ? AND item_key = ?', [session.id, itemKey]);
        if (!item) throw this._err(404, 'البند غير موجود في جلسة اليوم', 'ITEM_NOT_FOUND');

        const noteText = note != null && String(note).trim() !== '' ? String(note).trim().slice(0, 500) : null;
        const now = new Date().toISOString();
        const needsReflection = result === 'issue' || !!noteText;

        // الانعكاس المركزي: فقط عند ملاحظة/نقص/تلف — الفحص السليم لا يولّد أحداثًا (قرار المالك)
        let reflected = item.reflected ? 1 : 0;
        let warning = null;
        if (needsReflection && !item.reflected) {
            try {
                if (item.domain === 'medical' && item.asset_id != null) {
                    await this.db.AssetEvents.create({
                        asset_id: item.asset_id, event_type: 'note_added',
                        actor_id: String(ctx.emp.employee_code), actor_name: ctx.emp.name,
                        reason: (noteText || 'ملاحظة تشييك') + ` · تشييك مناوبة ${ctx.today} · ${session.team_name}`
                    });
                    reflected = 1;
                } else if (item.domain === 'mechanical' && session.vehicle_id) {
                    const ves = this.getVehicleEventsService ? this.getVehicleEventsService() : null;
                    if (!ves) throw new Error('خدمة المركبات غير متاحة');
                    await ves.appendEvent({
                        entityId: session.vehicle_id, eventType: 'note',
                        note: `[تشييك ${session.team_name}] ${item.item_label}: ${noteText || 'ملاحظة تشييك'}`
                    }, { id: String(ctx.emp.employee_code), name: ctx.emp.name });
                    reflected = 1;
                }
            } catch (e) {
                warning = 'سُجلت في الجلسة ولم تنعكس مركزيًا: ' + (e.message || 'خطأ غير متوقع');
            }
        }

        await this.db.run(
            `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, asset_id, result, note, reflected, checked_by, checked_by_name, checked_at, status_detail, qty_available, no_change)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
             ON CONFLICT(session_id, item_key) DO UPDATE SET
               result = excluded.result, note = excluded.note, reflected = MAX(shift_check_items.reflected, excluded.reflected),
               checked_by = excluded.checked_by, checked_by_name = excluded.checked_by_name, checked_at = excluded.checked_at,
               status_detail = excluded.status_detail, qty_available = excluded.qty_available, no_change = 0`,
            [session.id, item.domain, item.item_key, item.item_label, item.asset_id,
             result, noteText, reflected, String(ctx.emp.employee_code), ctx.emp.name, now,
             statusDetail || (result === 'ok' ? 'complete' : null),
             qtyAvailable != null && String(qtyAvailable).trim() !== '' ? String(qtyAvailable).trim().slice(0, 50) : null]);

        const readiness = await this._recomputeReadiness(session.id);
        return { success: true, sessionId: session.id, itemKey, result, statusDetail: statusDetail || null, reflected: !!reflected, warning, readiness };
    }

    /**
     * «لا تغيير» — تأكيد فعلي مسجل بالوقت/المستخدم (قرار المالك: ليس اعتمادًا أعمى).
     * لا يُتاح مع ملاحظة مفتوحة أو فحص قديم أو بلا فحص سابق أو عند تغيّر المركبة.
     */
    async noChange(user) {
        const ctx = await this._todayContext(user);
        if (ctx.notFound) throw this._err(404, 'لا يوجد ملف موظف مرتبط بهذا الحساب', 'NO_EMPLOYEE');
        if (ctx.state === 'no_assignment') throw this._err(409, 'لا يوجد تكليف مسجل لك اليوم', 'NO_ASSIGNMENT');
        if (ctx.state === 'not_field_team') throw this._err(409, 'التشييك للفرق الميدانية فقط', 'NOT_FIELD_TEAM');

        const { session } = await this._findOrCreateSession(ctx);
        if (session.status !== 'open') throw this._err(409, 'الجلسة مكتملة', 'SESSION_COMPLETED');
        if ((session.schema_version || 1) < 2) throw this._err(409, 'جلسة قديمة — أكملها ببنودها', 'LEGACY_SESSION');

        const items = await this.db.all('SELECT * FROM shift_check_items WHERE session_id = ?', [session.id]);
        const assetIds = items.filter(i => i.asset_id != null).map(i => i.asset_id);
        const openIssues = await this._openIssues(session, assetIds);
        const elig = await this._noChangeEligibility(session, items, openIssues);
        if (!elig.eligible) {
            const msgs = {
                open_issues: 'توجد ملاحظات مفتوحة — يجب فحص التفاصيل',
                no_previous_check: 'لا يوجد فحص سابق لهذه المركبة — ابدأ تشييكًا جديدًا',
                stale_check: 'آخر فحص أقدم من ' + CheckTemplate.NO_CHANGE_MAX_AGE_HOURS + ' ساعة — ابدأ تشييكًا جديدًا',
                vehicle_changed: 'تغيّرت المركبة منذ آخر فحص — ابدأ تشييكًا جديدًا'
            };
            throw this._err(409, elig.reasons.map(r => msgs[r] || r).join(' · '), 'NO_CHANGE_NOT_ALLOWED');
        }

        const now = new Date().toISOString();
        await this.db.run(
            `UPDATE shift_check_items SET no_change = 1, ref_checked_at = ?, checked_by = ?, checked_by_name = ?, checked_at = ?
             WHERE session_id = ? AND result IS NULL`,
            [elig.lastCheck.at, String(ctx.emp.employee_code), ctx.emp.name, now, session.id]);
        await this.db.run("UPDATE shift_check_sessions SET check_mode = 'no_change' WHERE id = ? AND check_mode IS NULL", [session.id]);
        const readiness = await this._recomputeReadiness(session.id);
        return { success: true, sessionId: session.id, noChange: true, refCheckedAt: elig.lastCheck.at, readiness };
    }

    /** حقول المركبة الثابتة (عداد/وقود/نظافة/مفتاح/شريحة) — whitelist صارم. */
    async vehicleFields(user, fields) {
        const ctx = await this._todayContext(user);
        if (ctx.notFound) throw this._err(404, 'لا يوجد ملف موظف مرتبط بهذا الحساب', 'NO_EMPLOYEE');
        if (ctx.state === 'no_assignment') throw this._err(409, 'لا يوجد تكليف مسجل لك اليوم', 'NO_ASSIGNMENT');
        if (ctx.state === 'not_field_team') throw this._err(409, 'التشييك للفرق الميدانية فقط', 'NOT_FIELD_TEAM');

        const { session } = await this._findOrCreateSession(ctx);
        if (session.status !== 'open') throw this._err(409, 'الجلسة مكتملة', 'SESSION_COMPLETED');
        if (!session.vehicle_id) throw this._err(409, 'لا توجد مركبة مسندة — لا حقول مركبة', 'NO_VEHICLE');

        const f = fields || {};
        const out = {};
        if (f.odometer != null && f.odometer !== '') {
            const n = Number(f.odometer);
            if (!Number.isInteger(n) || n < 0 || n > 9999999) throw this._err(422, 'قراءة العداد غير صالحة', 'BAD_INPUT');
            out.odometer = n;
        }
        if (f.fuel_level != null && f.fuel_level !== '') {
            if (!CheckTemplate.VEHICLE_FIELDS.fuel_level.options.includes(String(f.fuel_level))) throw this._err(422, 'كمية الوقود غير صالحة', 'BAD_INPUT');
            out.fuel_level = String(f.fuel_level);
        }
        if (f.cleanliness != null && f.cleanliness !== '') {
            if (!CheckTemplate.VEHICLE_FIELDS.cleanliness.options.includes(String(f.cleanliness))) throw this._err(422, 'قيمة النظافة غير صالحة', 'BAD_INPUT');
            out.cleanliness = String(f.cleanliness);
        }
        for (const k of ['master_key', 'fuel_card']) {
            if (f[k] != null && f[k] !== '') {
                const v = Number(f[k]);
                if (v !== 0 && v !== 1) throw this._err(422, 'قيمة ' + k + ' غير صالحة', 'BAD_INPUT');
                out[k] = v;
            }
        }
        if (!Object.keys(out).length) throw this._err(422, 'لا توجد حقول صالحة للحفظ', 'BAD_INPUT');

        const sets = Object.keys(out).map(k => k + ' = ?').join(', ');
        await this.db.run(`UPDATE shift_check_sessions SET ${sets} WHERE id = ?`, [...Object.values(out), session.id]);

        // نمط الفحص: full إذا غطيت كل البنود، partial إذا بقي شيء (ما لم يُضبط no_change سلفًا)
        const items = await this.db.all('SELECT result, no_change FROM shift_check_items WHERE session_id = ?', [session.id]);
        const allDone = items.length > 0 && items.every(i => i.result != null || i.no_change === 1);
        await this.db.run(
            'UPDATE shift_check_sessions SET check_mode = COALESCE(check_mode, ?) WHERE id = ?',
            [allDone ? 'full' : 'partial', session.id]);
        const readiness = await this._recomputeReadiness(session.id);
        return { success: true, sessionId: session.id, saved: Object.keys(out), readiness };
    }

    /** تفاصيل جلسة كاملة للمشرف/العمليات — قراءة فقط صِرفة (لا إنشاء ولا كتابة). */
    async getSessionDetail(sessionId) {
        const id = Number(sessionId);
        if (!Number.isInteger(id) || id <= 0) throw this._err(422, 'معرّف الجلسة غير صالح', 'BAD_INPUT');
        const session = await this.db.get('SELECT * FROM shift_check_sessions WHERE id = ?', [id]);
        if (!session) throw this._err(404, 'الجلسة غير موجودة', 'SESSION_NOT_FOUND');
        const items = await this.db.all('SELECT * FROM shift_check_items WHERE session_id = ? ORDER BY domain, id', [id]);
        const confirmations = await this.db.all(
            'SELECT employee_id, employee_name, kind, confirmed_at FROM shift_check_confirmations WHERE session_id = ?', [id]);
        const assetIds = items.filter(i => i.asset_id != null).map(i => i.asset_id);
        const openIssues = await this._openIssues(session, assetIds);
        return {
            session,
            items: items.map(i => ({
                itemKey: i.item_key, domain: i.domain, label: i.item_label,
                groupKey: i.group_key || null, qtyRequired: i.qty_required || null,
                result: i.result || null, statusDetail: i.status_detail || null,
                qtyAvailable: i.qty_available || null, note: i.note || null,
                noChange: !!i.no_change, refCheckedAt: i.ref_checked_at || null,
                checkedByName: i.checked_by_name || null, checkedAt: i.checked_at || null,
                reflected: !!i.reflected
            })),
            confirmations,
            openIssues: openIssues.map(o => ({
                domain: o.domain, itemKey: o.item_key, label: o.item_label,
                note: o.note, byName: o.checked_by_name, at: o.checked_at
            })),
            groupLabels: Object.fromEntries(
                CheckTemplate.MECHANICAL_GROUPS.concat(CheckTemplate.MEDICAL_GROUPS, [CheckTemplate.ASSETS_GROUP])
                    .map(g => [g.key, g.label]))
        };
    }

    /** جاهزية اليوم لكل الجلسات — قراءة فقط لشاشات العمليات (شارة إعلامية، لا تمنع التعيين). */
    async getTodayReadiness() {
        const today = riyadhToday();
        const rows = await this.db.all(
            `SELECT id, shift_date, team_id, team_name, vehicle_id, vehicle_name, center,
                    status, schema_version, readiness, readiness_reason, readiness_at, check_mode
             FROM shift_check_sessions WHERE shift_date = ? ORDER BY team_name`, [today]);
        return {
            today,
            sessions: rows.map(s => ({
                sessionId: s.id, teamId: s.team_id, teamName: s.team_name,
                vehicleId: s.vehicle_id || null, vehicleName: s.vehicle_name || null,
                center: s.center || null, status: s.status,
                readiness: s.readiness || null, readinessReason: s.readiness_reason || null,
                readinessAt: s.readiness_at || null, checkMode: s.check_mode || null
            }))
        };
    }

    /** تأكيد مستقل لكل موظف: ack/checkin/checkout — UNIQUE يمنع التكرار. */
    async confirm(user, { kind }) {
        if (!['ack', 'checkin', 'checkout'].includes(kind)) throw this._err(422, 'نوع تأكيد غير صالح', 'BAD_INPUT');
        const ctx = await this._todayContext(user);
        if (ctx.notFound) throw this._err(404, 'لا يوجد ملف موظف مرتبط بهذا الحساب', 'NO_EMPLOYEE');
        if (ctx.state === 'no_assignment') throw this._err(409, 'لا يوجد تكليف مسجل لك اليوم', 'NO_ASSIGNMENT');
        if (ctx.state === 'not_field_team') throw this._err(409, 'التشييك للفرق الميدانية فقط', 'NOT_FIELD_TEAM');

        const { session } = await this._findOrCreateSession(ctx);
        if (session.status !== 'open') throw this._err(409, 'الجلسة مكتملة', 'SESSION_COMPLETED');

        const ins = await this.db.run(
            `INSERT OR IGNORE INTO shift_check_confirmations (session_id, employee_id, employee_name, kind)
             VALUES (?, ?, ?, ?)`, [session.id, ctx.emp.id, ctx.emp.name, kind]);
        const already = !(ins && ins.changes > 0);

        // الاكتمال: كل أعضاء الفرقة (roster اليوم) أكّدوا التسليم
        let completed = false;
        if (kind === 'checkout') {
            const memberIds = ctx.members.map(m => m.id);
            if (memberIds.length) {
                const done = await this.db.all(
                    `SELECT DISTINCT employee_id FROM shift_check_confirmations
                     WHERE session_id = ? AND kind = 'checkout' AND employee_id IN (${memberIds.map(() => '?').join(',')})`,
                    [session.id, ...memberIds]);
                if (done.length === memberIds.length) {
                    await this.db.run(
                        "UPDATE shift_check_sessions SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'open'",
                        [session.id]);
                    completed = true;
                }
            }
        }
        return { success: true, sessionId: session.id, kind, already, completed };
    }
}

module.exports = ShiftCheckService;
