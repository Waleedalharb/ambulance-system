/**
 * Report Service — Owner of the Dispatch Log (Slice 1)
 * ═══════════════════════════════════════════════════════════
 * Write path: Route → ReportService → SQLite transaction → COMMIT
 *             → domain event on the engine's Event Bus.
 *
 * This service REUSES the existing opsEngine ReportManager logic
 * (no rewrites); it only adds transaction boundaries and event
 * emission around it. It never touches broadcast/WebSocket directly.
 *
 * Read path: getCurrentData() builds the same shape that
 * GET /api/data has always served, extended with per-type counts
 * ({ "center|unit": { count, times[], types{} } })
 * but sourced from SQLite (reports + report_times for the ACTIVE shift)
 * instead of data/ambulance-data.json.
 */

class ReportService {
    /**
     * @param {Object} deps
     * @param {Object} deps.engine - OperationsEngine instance
     * @param {Object} deps.bus    - Event bus owned by the engine
     */
    constructor({ engine, bus }) {
        if (!engine) throw new Error('ReportService requires an OperationsEngine instance');
        if (!bus) throw new Error('ReportService requires an event bus');
        this.engine = engine;
        this.bus = bus;
    }

    /**
     * Create (increment) a dispatch-log report for a center/unit.
     * Wraps ReportManager.addReport in a SQLite transaction and emits
     * `DispatchLogCreated` after COMMIT.
     *
     * @param {Object} data
     * @param {string} data.center
     * @param {string} data.unit
     * @param {number} [data.count] - number of increments (default 1)
     * @param {string} [data.type]  - report type key (stored in report_times.type)
     * @param {number} data.shiftId - resolved by the route via ShiftManager
     * @param {Object} [actor] - req.user ({ id, username, name, role })
     * @returns {Object} the SAME result object ReportManager.addReport returns
     */
    async createReport({ center, unit, count = 1, shiftId, type }, actor = null) {
        const increments = (Number.isInteger(count) && count > 1) ? count : 1;

        const result = await this.engine.runInTransaction(async () => {
            let last = null;
            for (let i = 0; i < increments; i++) {
                last = await this.engine.reports.addReport(shiftId, center, unit, type);
                if (!last || !last.success) break;
            }
            return last;
        });

        if (result && result.success) {
            this.bus.emit('DispatchLogCreated', {
                shift_id: shiftId,
                center,
                unit,
                new_count: result.newCount,
                total_reports: result.totalReports,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null
            });
        }
        return result;
    }

    /**
     * Undo the last dispatch-log report for a center/unit.
     * Wraps ReportManager.undoReport in a SQLite transaction and emits
     * `DispatchUndone` after COMMIT.
     *
     * @param {Object} data
     * @param {string} data.center
     * @param {string} data.unit
     * @param {number} data.shiftId
     * @param {Object} [actor]
     * @returns {Object} the SAME result object ReportManager.undoReport returns
     */
    async undoLastReport({ center, unit, shiftId }, actor = null) {
        const result = await this.engine.runInTransaction(async () => {
            return this.engine.reports.undoReport(shiftId, center, unit);
        });

        if (result && result.success) {
            this.bus.emit('DispatchUndone', {
                shift_id: shiftId,
                center,
                unit,
                new_count: result.newCount,
                total_reports: result.totalReports,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null
            });
        }
        return result;
    }

    /**
     * Current dispatch data for the ACTIVE shift, from SQLite.
     * Shape matches data/ambulance-data.json field-for-field, plus types:
     *   { "<center>|<unit>": { count: <int>, times: [<string>, ...], types: { <type>: <int>, ... } } }
     *
     * @returns {Object} data map ({} when there is no active shift)
     */
    async getCurrentData() {
        const activeShift = await this.engine.shifts.getActiveShift();
        if (!activeShift) return {};

        const rows = await this.engine.storage.all(
            `SELECT r.id, r.center, r.unit, r.count, t.timestamp AS ts, t.type AS rtype
             FROM reports r
             LEFT JOIN report_times t ON t.report_id = r.id
             WHERE r.shift_id = ?
             ORDER BY r.id ASC, t.id ASC`,
            [activeShift.id]
        );

        const data = {};
        for (const row of rows) {
            const key = `${row.center}|${row.unit}`;
            if (!data[key]) {
                data[key] = { count: row.count || 0, times: [], types: {} };
            }
            if (row.ts) data[key].times.push(row.ts);
            if (row.rtype) data[key].types[row.rtype] = (data[key].types[row.rtype] || 0) + 1;
        }
        return data;
    }

    /**
     * Read-only: reports for ANY shift (active or archived) as an object map
     *   { "<center>|<unit>": { count: <int>, times: [<string>, ...] } }
     * Mirrors the archive engine's _getReports logic: the single source
     * (reports table) first; when the shift predates the single source,
     * falls back to the frozen migration store (shift_reports — written by
     * migrateShifts from the legacy savedReports map).
     *
     * @param {number} shiftId
     * @returns {Object} data map ({} when the shift has no reports anywhere)
     */
    async getShiftReports(shiftId) {
        const live = await this.engine.storage.all(
            'SELECT center, unit, count FROM reports WHERE shift_id = ? ORDER BY id ASC',
            [shiftId]
        );
        if (Array.isArray(live) && live.length > 0) {
            const obj = {};
            for (const r of live) {
                if (r.center && r.unit) {
                    obj[`${r.center}|${r.unit}`] = { count: r.count || 0, times: [] };
                }
            }
            return obj;
        }

        // Migration fallback: frozen shift_reports store (legacy savedReports)
        const migrated = await this.engine.storage.all(
            'SELECT center, unit, count, times FROM shift_reports WHERE shift_id = ?',
            [shiftId]
        );
        const obj = {};
        for (const r of migrated) {
            if (!r.center || !r.unit) continue;
            let times = [];
            try { times = r.times ? JSON.parse(r.times) : []; } catch (_) { times = []; }
            obj[`${r.center}|${r.unit}`] = { count: r.count || 0, times };
        }
        return obj;
    }
    /* ─── مؤشر زمن الاستجابة (تعريف المالك المعتمد 2026-08-20) ───
       يُقاس من لحظة إنشاء البلاغ في CAD حتى الوصول، وحتى المباشرة.
       «قبول» و«التحرك» أزمنة وسيطة تُحفظ ولا تكون نقطة بداية للمؤشر إطلاقًا.
       الفروقات بالدقائق، وعبور منتصف الليل يُعالج بـ +24 ساعة. */

    /** «7:11:38 AM» أو «20/08/2026 5:00:06 AM» أو بـ ص/م → دقائق منذ منتصف الليل */
    _cadMinutes(str) {
        if (!str || typeof str !== 'string') return null;
        const s = str.trim();
        let mer = null;
        if (s.includes('ص')) mer = 'AM';
        else if (s.includes('م')) mer = 'PM';
        else { const mm = s.match(/\b(AM|PM)\b/i); if (mm) mer = mm[1].toUpperCase(); }
        const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10), sec = m[3] ? parseInt(m[3], 10) : 0;
        if (mer === 'PM' && h < 12) h += 12;
        if (mer === 'AM' && h === 12) h = 0;
        if (h > 23 || min > 59 || sec > 59) return null;
        return h * 60 + min + sec / 60;
    }
    _cadDiffMin(fromMin, toMin) { if (toMin < fromMin) toMin += 1440; return Math.round((toMin - fromMin) * 10) / 10; }
    /** «20/08/2026 12:01:51 PM» → طابع زمني حقيقي (مللي ثانية) للمقارنة الزمنية الكاملة عبر منتصف الليل */
    _cadDateTimeTs(str) {
        if (!str || typeof str !== 'string') return null;
        const m = str.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|ص|م)?/i);
        if (!m) return null;
        let h = parseInt(m[4], 10);
        const mer = m[7] || '';
        if (/pm|م/i.test(mer) && h < 12) h += 12;
        if (/am|ص/i.test(mer) && h === 12) h = 0;
        const ts = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), h, parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0).getTime();
        return isNaN(ts) ? null : ts;
    }
    /** زمن البلاغ حتى الوصول/المباشرة لهذه المشاركة (null إن تعذر — تبقى خارج المؤشر بصدق)
     *  قاموس CAD المحسوم (قرار المالك 2026-08-20): «البحث» = وصول الفرقة للموقع · «العلاج» = مباشرة الحالة */
    _responseFor(phases, cadCreatedAt) {
        const createdMin = this._cadMinutes(cadCreatedAt);
        if (createdMin === null || !phases) return { arrival: null, mubashara: null };
        const arr = phases['البحث'] ? this._cadMinutes(phases['البحث']) : null;
        const mub = phases['العلاج'] ? this._cadMinutes(phases['العلاج']) : null;
        return {
            arrival: arr === null ? null : this._cadDiffMin(createdMin, arr),
            mubashara: mub === null ? null : this._cadDiffMin(createdMin, mub)
        };
    }
    /** إعادة حساب زمني الاستجابة لكل مشاركات بلاغ عند وصول وقت إنشائه متأخرًا (لا قيمة تُفقد) */
    async _recomputeIncidentResponses(shiftId, number, cadCreatedAt) {
        const parts = await this.engine.storage.getIncidentParticipations(shiftId, number);
        for (const p of parts) {
            let phases = null;
            try { phases = p.phases ? JSON.parse(p.phases) : null; } catch (_) { phases = null; }
            const resp = this._responseFor(phases, cadCreatedAt);
            await this.engine.storage.updateParticipationResponse(p.id, resp.arrival, resp.mubashara);
        }
    }

    /**
     * استخراج الحي من عنوان CAD الخام (نمط العنوان الوطني):
     *  ① جزء يبدأ بـ«حي » ← نأخذه بدون البادئة
     *  ② وإلا الجزء الذي يسبق «الرياض …» مباشرة («…، بدر، الرياض 14724، السعودية» ← بدر)
     *  العنوان الخام يُحفظ دائمًا مع البلاغ — الحي مشتق قابل لإعادة الحساب والتتبع.
     */
    _parseDistrict(address) {
        if (!address || typeof address !== 'string') return null;
        const parts = address.split(/[،,]/).map(s => s.trim()).filter(Boolean);
        const hayy = parts.find(p => /^حي\s+/.test(p));
        if (hayy) return hayy.replace(/^حي\s+/, '');
        const ci = parts.findIndex(p => /^الرياض(\s|$)/.test(p));
        if (ci > 0) return parts[ci - 1];
        return null;
    }

    /**
     * تفكيك عنوان CAD إلى مكونات مستقلة محفوظة مع البلاغ (قرار المالك 2026-08-20):
     * الشارع كما ورد (برقم المبنى) + الحي + المدينة — كلها مشتقة من العنوان الخام وقابلة للتتبع إليه.
     * الأنماط المعتمدة على صيغة العنوان الوطني القصير:
     * «رمز مختصر، رقم+شارع، رقم إضافي، حي X، المدينة+الرمز البريدي، السعودية»
     *  ① الشارع: جزء فيه «طريق/شارع»، أو نمط «رقم مبنى + اسم» («7616 الخليل بن أحمد»)
     *  ② الحي: جزء يبدأ بـ«حي » بدون البادئة، وإلا الجزء الذي يسبق المدينة مباشرة
     *  ③ المدينة: الجزء الحامل للرمز البريدي («الرياض 14721» ← الرياض)
     * ما لا يُشتق بثقة يبقى null بصدق — لا تخمين ولا اختراع.
     */
    _parseLocationParts(address) {
        const empty = { street: null, district: null, city: null };
        if (!address || typeof address !== 'string') return empty;
        const parts = address.split(/[،,]/).map(s => s.trim()).filter(Boolean);
        const isPostalCity = p => /\s\d{5}$/.test(p); // «الرياض 14721»
        const isShortCode = p => /^[A-Za-z0-9]{6,12}$/.test(p) && /[A-Za-z]/.test(p) && /\d/.test(p); // «RLFA7348»
        const isPlainNumber = p => /^\d{3,5}$/.test(p); // رقم إضافي/مبنى وحده
        // ③ المدينة
        const ci = parts.findIndex(p => isPostalCity(p) || /^الرياض(\s|$)/.test(p));
        const city = ci >= 0 ? (parts[ci].replace(/\s*\d{5}$/, '').trim() || null) : null;
        // ② الحي
        let district = null;
        const hayy = parts.find(p => /^حي\s+/.test(p));
        if (hayy) district = hayy.replace(/^حي\s+/, '');
        else if (ci > 0) {
            const cand = parts[ci - 1];
            if (!isPlainNumber(cand) && !isShortCode(cand)) district = cand;
        }
        // ① الشارع
        let street = null;
        for (const p of parts) {
            if (/^حي\s+/.test(p) || p === 'السعودية' || isPostalCity(p) || isShortCode(p) || isPlainNumber(p)) continue;
            if (/(طريق|شارع)/.test(p) || /^\d{3,5}\s+\D/.test(p)) { street = p; break; }
        }
        return { street, district, city };
    }

    /**
     * مدخل CAD «الضغطة الواحدة» (محرك التوزيع برقم البلاغ — 2026-08-20)
     * ═══════════════════════════════════════════════════════════
     * CAD مجرد مدخل: البيانات تدخل نفس الجداول التي يقرأها توزيع البلاغات.
     *  ① الإجمالي = أرقام البلاغات الفريدة (incident_registry)
     *  ② كل فرقة مشاركة = مشاركة واحدة في عدّادها (report_times كالمعتاد)
     *  ③ نفس الفرقة + نفس الرقم = لا تضاعف (فحص findParticipation + دمج أزمنة تصاعدي)
     *  ④ النوع يُصنف مرة واحدة في السجل، ولا يتكرر بتعدد الفرق
     *  ⑤ زمن الاستجابة يُحسب ويُحفظ مع كل مشاركة: من إنشاء البلاغ في CAD حتى الوصول/المباشرة
     *  ⑥ موقع البلاغ (عنوان خام + منطقة + حي مشتق) يُحفظ مع السجل — يُستكمل إن وصل متأخرًا
     * يبث DispatchLogCreated لكل فرقة مضافة ← نفس قناة new_report الحية.
     */
    async createIncidentEntries({ shiftId, number, code, type, crews, createdAt = null, address = null, region = null, lat = null, lng = null }, actor = null) {
        const loc = this._parseLocationParts(address);
        const district = loc.district;
        // إحداثيات CAD الأصلية فقط (اعتماد المالك 2026-08-20): تُقبل رقمًا ضمن النطاق الجغرافي
        // الصحيح وإلا تبقى null — لا Geocoding ولا قيم مخترعة
        const validCoords = typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng) &&
            lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
        const cLat = validCoords ? lat : null, cLng = validCoords ? lng : null;
        const result = await this.engine.runInTransaction(async () => {
            let incident = await this.engine.storage.findIncident(shiftId, number);
            if (!incident) {
                // رقم البلاغ هو المفتاح بنيويًا (قرار المالك 2026-08-21): قبل إنشاء سجل
                // جديد نبحث عن الرقم عبر كل المناوبات — البلاغ الممتد عبر التسليم بين
                // مناوبتين يُلحق بسجله القائم ولا يتكرر أبدًا
                incident = await this.engine.storage.findIncidentByNumber(number);
            }
            // كل المشاركات والمراحل تُسجَّل في مناوبة البلاغ الأصلية — مصدر واحد للحقيقة
            const effShiftId = incident ? incident.shift_id : shiftId;
            let incidentCreated = false;
            let cadTimeFilled = false;
            let incidentEnriched = false; // أي إثراء لاحق على بلاغ قائم (موقع/مراحل) — لبث التحديث الحي
            if (!incident) {
                const id = await this.engine.storage.createIncident(shiftId, number, code, type, 'cad-oneclick', createdAt, address, region, district, loc.street, loc.city, cLat, cLng);
                incident = { id, number, code: code || null, type: type || null, cad_created_at: createdAt || null, address, region, district, street: loc.street, city: loc.city, lat: cLat, lng: cLng };
                incidentCreated = true;
            } else {
                // النوع يُصنف مرة واحدة؛ نستكمل code/وقت الإنشاء/الموقع فقط إن كانت غائبة
                if (code && !incident.code) {
                    await this.engine.storage.updateIncidentCode(incident.id, code);
                    incident.code = code;
                }
                if (createdAt && !incident.cad_created_at) {
                    await this.engine.storage.updateIncidentCadCreatedAt(incident.id, createdAt);
                    incident.cad_created_at = createdAt;
                    cadTimeFilled = true;
                }
                if ((address && !incident.address) || (region && !incident.region) || (district && !incident.district) || (loc.street && !incident.street) || (loc.city && !incident.city) || (cLat !== null && incident.lat == null) || (cLng !== null && incident.lng == null)) {
                    await this.engine.storage.updateIncidentLocation(incident.id, incident.address ? null : address, incident.region ? null : region, incident.district ? null : district, incident.street ? null : loc.street, incident.city ? null : loc.city, incident.lat != null ? null : cLat, incident.lng != null ? null : cLng);
                    incident.address = incident.address || address;
                    incident.region = incident.region || region;
                    incident.district = incident.district || district;
                    incident.street = incident.street || loc.street;
                    incident.city = incident.city || loc.city;
                    if (incident.lat == null) { incident.lat = cLat; incidentEnriched = true; }
                    if (incident.lng == null) { incident.lng = cLng; incidentEnriched = true; }
                    incidentEnriched = incidentEnriched || Boolean(address || region || district || loc.street || loc.city);
                }
                // تصحيح الموقع في CAD (قرار المالك 2026-08-21 صباحًا): إذا وصلت إحداثيات
                // CAD صحيحة تختلف عن المخزنة، تُحدَّث — الموقع المُصحَّح في CAD هو المرجع،
                // والخريطة يجب أن تحرّك نفس العلامة فورًا عبر IncidentEnriched.
                // القيم غير الصالحة تُهمَل كما كانت، ولا تُخترع إحداثيات إطلاقًا.
                if (cLat !== null && cLng !== null && incident.lat != null && incident.lng != null &&
                    (incident.lat !== cLat || incident.lng !== cLng)) {
                    await this.engine.storage.updateIncidentCoords(incident.id, cLat, cLng);
                    incident.lat = cLat; incident.lng = cLng;
                    incidentEnriched = true;
                }
            }
            // إن وصل وقت إنشاء البلاغ متأخرًا: أعد حساب أزمنة استجابة المشاركات السابقة
            if (cadTimeFilled) await this._recomputeIncidentResponses(effShiftId, number, incident.cad_created_at);

            const addedCrews = [], skippedCrews = [], withdrawnCrews = [];
            for (const c of crews) {
                const dup = await this.engine.storage.findParticipation(effShiftId, c.team, number);
                // حالة المشاركة الحالية (§4 — 2026-08-21): سحب/إلغاء الفرقة يُعلَّم على
                // سجلها القائم؛ إن لم يوجد سجل يُنشأ مُعلَّمًا — التاريخ يبقى كاملًا ولا تُحتسب
                if (c.withdrawn === true) {
                    if (dup) {
                        if (c.phases && Object.keys(c.phases).length) {
                            const m0 = await this.engine.storage.mergeParticipationPhases(dup.id, c.phases);
                            if (m0.merged > 0) {
                                const resp0 = this._responseFor(m0.phases, incident.cad_created_at);
                                await this.engine.storage.updateParticipationResponse(dup.id, resp0.arrival, resp0.mubashara);
                            }
                        }
                        await this.engine.storage.setParticipationWithdrawn(effShiftId, c.team, number, true);
                    } else {
                        const phasesJsonW = (c.phases && Object.keys(c.phases).length) ? JSON.stringify(c.phases) : null;
                        const respW = this._responseFor(c.phases, incident.cad_created_at);
                        await this.engine.reports.addReport(effShiftId, 'CAD', c.team, type, number, phasesJsonW, respW.arrival, respW.mubashara);
                        await this.engine.storage.setParticipationWithdrawn(effShiftId, c.team, number, true);
                    }
                    withdrawnCrews.push(c.team);
                    incidentEnriched = true; // تغيّر حالة المشاركة يغيّر التنبيهات والخريطة فورًا
                    continue;
                }
                if (dup) {
                    // القاعدة ③: لا تضاعف العدّاد — لكن لقطة الأزمنة تتطور، فنستكمل الناقص فقط
                    // (فرقة سُجّلت بـ«قبول» ثم تحركت لاحقًا ترتقي إلى «محتسبة» دون سجل جديد)
                    if (c.phases && Object.keys(c.phases).length) {
                        const m = await this.engine.storage.mergeParticipationPhases(dup.id, c.phases);
                        if (m.merged > 0) {
                            const resp = this._responseFor(m.phases, incident.cad_created_at);
                            await this.engine.storage.updateParticipationResponse(dup.id, resp.arrival, resp.mubashara);
                            incidentEnriched = true; // تطور المراحل يغيّر الخطورة والأزمنة — يستحق بثًا حيًا
                        }
                    }
                    // عودة فرقة سُحبت خطأً: withdrawn=false الصريح فقط يزيل العلامة (لا استنتاج)
                    if (c.withdrawn === false) {
                        await this.engine.storage.setParticipationWithdrawn(effShiftId, c.team, number, false);
                        incidentEnriched = true;
                    }
                    skippedCrews.push(c.team);
                    continue;
                }
                const phasesJson = (c.phases && Object.keys(c.phases).length) ? JSON.stringify(c.phases) : null;
                const resp = this._responseFor(c.phases, incident.cad_created_at);
                const r = await this.engine.reports.addReport(effShiftId, 'CAD', c.team, type, number, phasesJson, resp.arrival, resp.mubashara);
                if (r && r.success) addedCrews.push(c.team); else skippedCrews.push(c.team);
            }
            return { incident, incidentCreated, addedCrews, skippedCrews, withdrawnCrews, incidentEnriched, effShiftId };
        });

        for (const team of result.addedCrews) {
            this.bus.emit('DispatchLogCreated', {
                shift_id: result.effShiftId, center: 'CAD', unit: team,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null
            });
        }
        // بلاغ قائم أُثري لاحقًا (مراحل جديدة/موقع اكتمل/وقت إنشاء وصل متأخرًا):
        // لا فرقة جديدة ولا سجل جديد — لكن الخريطة والمؤشرات يجب أن تنعكس فورًا
        // عبر نفس قناة new_report (قرار المالك 2026-08-20: تغيير المرحلة/الموقع يظهر لحظيًا)
        if (!result.incidentCreated && result.incidentEnriched) {
            this.bus.emit('IncidentEnriched', {
                shift_id: result.effShiftId, center: 'CAD', unit: (result.skippedCrews[0] || result.withdrawnCrews[0] || ''),
                number,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null
            });
        }
        return {
            success: true,
            created: result.incidentCreated,
            addedCrews: result.addedCrews,
            skippedCrews: result.skippedCrews,
            withdrawnCrews: result.withdrawnCrews
        };
    }

    /**
     * قاعدة عدالة الفرق (قرار المالك 2026-08-20):
     *  • فرقة أُسندت وأُلغيت قبل التحرك ← لا تُحسب في عدّادها (counted=false).
     *  • فرقة تحركت ثم أُلغيت لاحقًا ← تُحسب (لا تُظلم).
     *  • المعيار الوحيد: وجود وقت «التحرك» المستخرج من CAD — لا «أول» ولا «آخر» فرقة.
     *  • مشاركة بلا لقطة أزمنة إطلاقًا (null) ← تُحسب (لا دليل على الإلغاء — سلوك قائم).
     * التاريخ التشغيلي يبقى كاملًا: كل المشاركات تظهر في التفاصيل بحالتها، ولا حذف.
     */
    isCountedParticipation(phases) {
        if (!phases) return true;
        return Boolean(phases['التحرك']);
    }

    /**
     * ملخص المحرك لمناوبة: total بأرقام البلاغات الفريدة + اليدوي،
     * byType مرة لكل بلاغ، byCrew بعدد المشاركات المحتسبة فقط — مع تفاصيل كل بلاغ وأزمنته.
     * + مؤشر زمن الاستجابة للقطاع: البلاغ يدخل مرة واحدة بأسرع وصول/مباشرة بين فرقه المحتسبة.
     */
    async getIncidentSummary(shiftId) {
        const { incidents, parts, manual } = await this.engine.storage.getIncidentSummary(shiftId);

        const byType = {};
        const partsByIncident = {};
        for (const p of parts) {
            if (!partsByIncident[p.incident_number]) partsByIncident[p.incident_number] = [];
            partsByIncident[p.incident_number].push(p);
        }
        const byCrew = {};
        const byDistrict = {}; // تجميع المواقع بالحي المشتق من عنوان CAD — مرة واحدة لكل بلاغ (قرار المالك 2026-08-20)
        const rtArrival = [], rtMubashara = [];
        const detail = incidents.map(ic => {
            const t = ic.type || 'other';
            byType[t] = (byType[t] || 0) + 1; // مرة واحدة لكل بلاغ (القاعدة ④)
            const d = ic.district || 'غير محدد';
            byDistrict[d] = (byDistrict[d] || 0) + 1; // الحي لا يتكرر بتعدد الفرق — مثل النوع تمامًا
            const crews = (partsByIncident[ic.number] || []).map(p => {
                let phases = null;
                try { phases = p.phases ? JSON.parse(p.phases) : null; } catch (_) { phases = null; }
                const withdrawn = !!p.withdrawn; // الحالة الحالية للمشاركة (§4): المسحوبة لا تُحتسب إطلاقًا
                const counted = !withdrawn && this.isCountedParticipation(phases);
                if (counted) byCrew[p.unit] = (byCrew[p.unit] || 0) + 1; // مشاركة محتسبة واحدة لكل فرقة (②)
                return {
                    unit: p.unit, at: p.timestamp, phases, counted, withdrawn,
                    respArrivalMin: p.resp_arrival_min != null ? p.resp_arrival_min : null,
                    respMubasharaMin: p.resp_mubashara_min != null ? p.resp_mubashara_min : null
                };
            });
            // مؤشر البلاغ: أسرع وصول/مباشرة بين الفرق المحتسبة (التي تحركت) — تعدد الفرق لا يكرر البلاغ
            const countedCrews = crews.filter(c => c.counted);
            const arrVals = countedCrews.map(c => c.respArrivalMin).filter(v => v !== null);
            const mubVals = countedCrews.map(c => c.respMubasharaMin).filter(v => v !== null);
            if (arrVals.length) rtArrival.push(Math.min(...arrVals));
            if (mubVals.length) rtMubashara.push(Math.min(...mubVals));
            return { number: ic.number, code: ic.code, type: t, source: ic.source, createdAt: ic.created_at, cadCreatedAt: ic.cad_created_at || null, address: ic.address || null, region: ic.region || null, district: ic.district || null, street: ic.street || null, city: ic.city || null, lat: ic.lat != null ? ic.lat : null, lng: ic.lng != null ? ic.lng : null, crews,
                bestArrivalMin: arrVals.length ? Math.min(...arrVals) : null,
                bestMubasharaMin: mubVals.length ? Math.min(...mubVals) : null };
        });
        for (const m of manual) { // اليدوي: كل ضغطة بلاغ مستقل — سلوك قائم لا يتغير
            const t = m.type || 'other';
            byType[t] = (byType[t] || 0) + 1;
            byCrew[m.unit] = (byCrew[m.unit] || 0) + 1;
        }
        // «آخر بلاغ» بوقت الإنشاء الفعلي (قرار المالك 2026-08-20): أحدث وقت إنشاء CAD بين
        // البلاغات — حتى لو دخل المنصة متأخرًا — وأحدث ضغطة يدوية إن كانت أحدث منها
        let lastReportTs = null;
        for (const ic of incidents) {
            const ts = this._cadDateTimeTs(ic.cad_created_at);
            if (ts !== null && (lastReportTs === null || ts > lastReportTs)) lastReportTs = ts;
        }
        for (const m of manual) {
            const ts = new Date(m.timestamp).getTime();
            if (!isNaN(ts) && (lastReportTs === null || ts > lastReportTs)) lastReportTs = ts;
        }
        const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
        const avgArrival = avg(rtArrival);
        const avgMubashara = avg(rtMubashara);
        // ── خطورة البلاغ للخريطة التشغيلية (قرار المالك 2026-08-20) — اشتقاق سيرفري بحت:
        //  🟢 أي فرقة محتسبة وصلت («البحث») أو باشرت («العلاج»)
        //  🔴 لا وصول لأي فرقة وانقضى منذ إنشاء البلاغ أكثر من متوسط وصول القطاع
        //  🟡 غير ذلك (قيد الانتظار/الطريق ضمن الحد) — ولا حمراء بلا خط أساس للمتوسط (صدق)
        for (const d of detail) {
            const arrived = d.crews.some(c => c.counted && c.phases && (c.phases['البحث'] || c.phases['العلاج']));
            const createdTs = this._cadDateTimeTs(d.cadCreatedAt);
            const elapsedMin = createdTs !== null ? (Date.now() - createdTs) / 60000 : null;
            d.severity = arrived ? 'green'
                : (avgArrival !== null && elapsedMin !== null && elapsedMin > avgArrival ? 'red' : 'yellow');
        }
        // حالة القطاع للشريط العلوي: أسوأ خطورة قائمة — وnull بلا بلاغات («—» الصادقة)
        const sectorStatus = !detail.length ? null
            : detail.some(d => d.severity === 'red') ? 'red'
            : detail.some(d => d.severity === 'yellow') ? 'yellow' : 'green';
        let topDistrict = null;
        for (const dName of Object.keys(byDistrict)) {
            if (dName === 'غير محدد') continue;
            if (!topDistrict || byDistrict[dName] > topDistrict.count) topDistrict = { name: dName, count: byDistrict[dName] };
        }
        // إثراء لوحة التحليل الجانبية للخريطة الذكية — كلها من بيانات المناوبة الحالية نفسها
        // (قراءة مشتقة في الخدمة، لا منطق جديد ولا تخزين؛ تتراكم دلالتها مع تراكم البلاغات):
        // ساعة الذروة = أكثر ساعة إنشاء بلاغات (من cad_created_at الفعلي)، وأكثر الشوارع تكرارًا،
        // والبلاغات بلا إحداثيات تُعرض بصدق بدل اختراع مواقع لها.
        const hourCount = {};
        for (const d of detail) {
            const ts = this._cadDateTimeTs(d.cadCreatedAt);
            if (ts !== null) { const h = new Date(ts).getHours(); hourCount[h] = (hourCount[h] || 0) + 1; }
        }
        let peakHour = null;
        for (const h of Object.keys(hourCount)) {
            if (!peakHour || hourCount[h] > peakHour.count) peakHour = { hour: +h, count: hourCount[h] };
        }
        const streetCount = {};
        for (const d of detail) { if (d.street) streetCount[d.street] = (streetCount[d.street] || 0) + 1; }
        const topStreets = Object.entries(streetCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([name, count]) => ({ name, count }));
        const noLocationList = detail.filter(d => d.lat === null || d.lng === null)
            .map(d => ({ number: d.number, district: d.district }));
        return {
            total: incidents.length + manual.length, // ① بلاغات فريدة + يدوي
            incidentsCount: incidents.length,
            manualCount: manual.length,
            byType, byCrew, byDistrict,
            incidents: detail,
            lastReportTs,
            mapStatus: {
                sectorStatus,
                topDistrict,
                peakHour,
                topStreets,
                noLocation: noLocationList,
                positionedCount: detail.filter(d => d.lat !== null && d.lng !== null).length,
                noLocationCount: noLocationList.length
            },
            responseTime: {
                arrival: { avg: avgArrival, count: rtArrival.length },
                mubashara: { avg: avgMubashara, count: rtMubashara.length },
                definition: 'من إنشاء البلاغ في CAD حتى الوصول (مرحلة البحث)/المباشرة (مرحلة العلاج) — الفرق التي لم تتحرك خارج المؤشر'
            }
        };
    }
}

module.exports = ReportService;
