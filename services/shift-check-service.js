/**
 * ═══ shift-check-service.js — إجراءات الاستلام والتسليم (بوابة الموظف v3، معتمدة 2026-09-04) ═══
 *
 * سجل تشييك واحد مشترك لكل (مناوبة/فرقة/مركبة) — يشترك فيه موظفا الفرقة:
 *   · يُنشأ كسولًا من تكليف roster لليوم فقط (كتابة = بلا primary_fallback).
 *   · قائمة التشييك الطبي = أصول الفرقة الحالية لحظة الإنشاء (لقطة الجلسة) —
 *     لا تُنسب لمركبة ولا يتغير ارتباطها الرسمي.
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

function pad2(v) { return String(Number(v)).padStart(2, '0'); }
function riyadhToday() {
    const p = TimeRiyadh.riyadhParts(new Date());
    return p ? `${p.year}-${pad2(p.month)}-${pad2(p.day)}` : null;
}

/** بنود التشييك الميكانيكي والتقني — قائمة ثوابت معتمدة من المالك (لا توجد كبيانات في نظام المركبات). */
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

    /** إيجاد أو إنشاء الجلسة المشتركة + لقطة البنود عند الإنشاء فقط. */
    async _findOrCreateSession(ctx) {
        const vehicle = await this._currentVehicle(ctx.team.id);
        const vehId = vehicle ? String(vehicle.vehicleId) : '';
        let session = await this.db.get(
            'SELECT * FROM shift_check_sessions WHERE shift_date = ? AND team_id = ? AND vehicle_id = ?',
            [ctx.today, ctx.team.id, vehId]);
        if (session) return { session, vehicle, created: false };

        const ins = await this.db.run(
            `INSERT INTO shift_check_sessions (shift_date, team_id, team_name, vehicle_id, vehicle_name, center, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [ctx.today, ctx.team.id, ctx.team.name, vehId, vehicle ? vehicle.name : null, ctx.team.center || null, String(ctx.emp.employee_code)]);
        session = await this.db.get('SELECT * FROM shift_check_sessions WHERE id = ?', [ins.id]);

        // لقطة البنود: الطبي = أصول الفرقة الحالية (عهدة الفرقة — لا نسبة لمركبة ولا تغيير ارتباط)
        const assets = await this.db.all(
            `SELECT id, asset_code, type_name, status FROM assets
             WHERE team_name = ? AND archived_at IS NULL ORDER BY type_name, asset_code`, [ctx.team.name]);
        for (const a of assets) {
            await this.db.run(
                `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, asset_id)
                 VALUES (?, 'medical', ?, ?, ?)`,
                [session.id, 'asset:' + a.id, a.type_name + ' (' + a.asset_code + ')', a.id]);
        }
        // الميكانيكي = القالب المعتمد — فقط عند وجود مركبة فعلية
        if (vehicle) {
            for (const m of MECH_TEMPLATE) {
                await this.db.run(
                    `INSERT INTO shift_check_items (session_id, domain, item_key, item_label)
                     VALUES (?, 'mechanical', ?, ?)`,
                    [session.id, 'mech:' + m.key, m.label]);
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

        return {
            today: ctx.today,
            session,
            vehicle: vehicle || null,
            team: { teamId: ctx.team.id, teamName: ctx.team.name, center: ctx.team.center || null },
            members: ctx.members,
            me: { id: ctx.emp.id, name: ctx.emp.name, code: ctx.emp.employee_code },
            items: items.map(i => ({
                itemKey: i.item_key, domain: i.domain, label: i.item_label,
                result: i.result || null, note: i.note || null,
                checkedByName: i.checked_by_name || null, checkedAt: i.checked_at || null,
                reflected: !!i.reflected
            })),
            confirmations,
            openIssues: openIssues.map(o => ({
                domain: o.domain, itemKey: o.item_key, label: o.item_label,
                note: o.note, byName: o.checked_by_name, at: o.checked_at
            })),
            mechTemplate: MECH_TEMPLATE.map(m => m.key)
        };
    }

    /** تسجيل بند (تم التحقق / ملاحظة). idempotent عبر UNIQUE(session_id,item_key). */
    async checkItem(user, { itemKey, result, note }) {
        if (!itemKey || typeof itemKey !== 'string') throw this._err(422, 'item_key مطلوب', 'BAD_INPUT');
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
            `INSERT INTO shift_check_items (session_id, domain, item_key, item_label, asset_id, result, note, reflected, checked_by, checked_by_name, checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, item_key) DO UPDATE SET
               result = excluded.result, note = excluded.note, reflected = MAX(shift_check_items.reflected, excluded.reflected),
               checked_by = excluded.checked_by, checked_by_name = excluded.checked_by_name, checked_at = excluded.checked_at`,
            [session.id, item.domain, item.item_key, item.item_label, item.asset_id,
             result, noteText, reflected, String(ctx.emp.employee_code), ctx.emp.name, now]);

        return { success: true, sessionId: session.id, itemKey, result, reflected: !!reflected, warning };
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
