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

// H3/H4 (اعتماد المالك 2026-08-24 — الطبقة التاريخية التحليلية): تحليل الطلب ×
// التمركز يقرأ نوافذ التمركز من سجل positioning_events؛ تحليل startTime/endTime
// يمر عبر محلل PositioningService المركزي نفسه (parseRiyadhWall) — لا نسخ لمنطق
// التوقيت، والحمولات القديمة الـnaive تُفسَّر جداريةَ الرياض كما في كل المنصة.
const PositioningService = require('./positioning-service');

// اكتشاف احتمال تكرار البلاغات (اعتماد المالك 2026-08-24 — ملحق note-18):
// محرك نقي يشتق التنبيهات عند القراءة من incident_registry الخام — لا تخزين
// ولا جداول موازية، ورقم المبلغ يُستخدم سيرفريًا للمطابقة فقط ولا يخرج أبدًا
// في أي استجابة (الأدلة المعروضة مقنّعة: «متطابق» بلا الرقم نفسه).
const DuplicateDetection = require('./duplicate-detection');

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
     * الاشتقاق من صفوف المشاركات بقاعدة الاحتساب الواحدة (قرار المالك
     * 2026-08-24): الملغاة يدويًا/المسحوبة/بلا «تحرك» لا تدخل العدّ — نفس
     * تعريف getIncidentSummary حتى يتطابق تقرير المناوبة مع الإنجازات.
     *
     * @returns {Object} data map ({} when there is no active shift)
     */
    async getCurrentData() {
        const activeShift = await this.engine.shifts.getActiveShift();
        if (!activeShift) return {};
        const rows = await this.engine.storage.getShiftParticipationRows(activeShift.id);
        return this._buildCountedDataMap(rows);
    }

    /**
     * Read-only: reports for ANY shift (active or archived) as an object map
     *   { "<center>|<unit>": { count: <int>, times: [<string>, ...] } }
     * الاشتقاق من صفوف المشاركات بقاعدة الاحتساب الواحدة (قرار المالك
     * 2026-08-24) — لا من عدّاد reports.count التجميعي، حتى لا تظهر الفرق
     * الملغاة يدويًا في التقرير اليومي وعرض الأرشيف. يبقى السقوط للمخزن
     * المجمّد (shift_reports) للمناوبات السابقة على مصدر الحقيقة الواحد.
     *
     * @param {number} shiftId
     * @returns {Object} data map ({} when the shift has no reports anywhere)
     */
    async getShiftReports(shiftId) {
        const live = await this.engine.storage.all(
            'SELECT id FROM reports WHERE shift_id = ? ORDER BY id ASC',
            [shiftId]
        );
        if (Array.isArray(live) && live.length > 0) {
            const rows = await this.engine.storage.getShiftParticipationRows(shiftId);
            return this._buildCountedDataMap(rows);
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
     *  قاموس CAD المحسوم (قرار المالك 2026-08-20): «البحث» = وصول الفرقة للموقع · «العلاج» = مباشرة الحالة
     *  (اعتماد المالك 2026-08-25 — توحيد مع محرك الأزمنة): المباشرة = PATIENT_REACH → AT_PATIENT
     *  (البحث → العلاج) وليست من إنشاء البلاغ. يطبق على الحسابات الجديدة فقط —
     *  لا إعادة حساب ولا تعديل للسجلات التاريخية المحفوظة بأثر رجعي. */
    _responseFor(phases, cadCreatedAt) {
        const createdMin = this._cadMinutes(cadCreatedAt);
        if (createdMin === null || !phases) return { arrival: null, mubashara: null };
        const arr = phases['البحث'] ? this._cadMinutes(phases['البحث']) : null;
        const mub = phases['العلاج'] ? this._cadMinutes(phases['العلاج']) : null;
        return {
            arrival: arr === null ? null : this._cadDiffMin(createdMin, arr),
            mubashara: (arr === null || mub === null) ? null : this._cadDiffMin(arr, mub)
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
    async createIncidentEntries({ shiftId, number, code, type, crews, createdAt = null, address = null, region = null, lat = null, lng = null, status = null, source = 'cad-oneclick', callerNumber = null, description = null }, actor = null) {
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
                const id = await this.engine.storage.createIncident(shiftId, number, code, type, source, createdAt, address, region, district, loc.street, loc.city, cLat, cLng, callerNumber, description);
                incident = { id, number, code: code || null, type: type || null, cad_created_at: createdAt || null, address, region, district, street: loc.street, city: loc.city, lat: cLat, lng: cLng, caller_number: callerNumber || null, description: description || null };
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
                // رقم المبلغ/الوصف (اعتماد المالك 2026-08-24 — ملحق note-18): يُستكملان
                // إن وصلا متأخرين (بلاغ سُجّل من القائمة قبل فتح تفاصيله) — الموجود لا يُمس
                if ((callerNumber && !incident.caller_number) || (description && !incident.description)) {
                    await this.engine.storage.updateIncidentCallerInfo(incident.id,
                        incident.caller_number ? null : callerNumber, incident.description ? null : description);
                    if (callerNumber && !incident.caller_number) incident.caller_number = callerNumber;
                    if (description && !incident.description) incident.description = description;
                    incidentEnriched = true; // دليل اشتباه جديد محتمل — التنبيه يظهر فورًا عبر نفس القناة
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
            // حالة دورة حياة البلاغ (قرار المالك 2026-08-22): CAD مصدر الحقيقة.
            // القيم المقبولة داخليًا فقط: active/closed/cancelled (التطبيع من صيغ CAD
            // المتعددة يحدث في طبقة الـOverlay). النهائية لاصقة: لا ترتد إلى active
            // إلا بإشارة active صريحة من CAD، وغياب الحالة لا يغيّر المخزنة أبدًا.
            if (status === 'active' || status === 'closed' || status === 'cancelled') {
                const prevStatus = incident.status || 'active'; // NULL التاريخي = active
                if (prevStatus !== status) {
                    await this.engine.storage.updateIncidentStatus(incident.id, status);
                    incident.status = status;
                    incidentEnriched = true; // تغيّر الحالة يغيّر الخريطة والتنبيهات فورًا — يستحق البث
                }
            }
            // إن وصل وقت إنشاء البلاغ متأخرًا: أعد حساب أزمنة استجابة المشاركات السابقة
            if (cadTimeFilled) await this._recomputeIncidentResponses(effShiftId, number, incident.cad_created_at);

            const addedCrews = [], skippedCrews = [], withdrawnCrews = [], cancelAfterArrivalCrews = [], correctedCrews = [], linkedCrews = [], planUnitsIgnored = [], evidencelessIgnored = [];
            for (const c of crews) {
                // دفاع مصدر الحقيقة (اعتماد المالك 2026-08-25): Available ≠ Assigned
                // ≠ Responding ≠ Positioning ≠ Participating — لقطة CAD صريحة (وحدة
                // بهوية CAD أو phasesSource=cad-detail) بلا أي وقت رحلة ولا cadUrs
                // ولا cadReached = وحدة «خطة استجابة» مقترحة ظهرت في units[] بهيكل
                // journeys فارغ الأوقات (مثبت بالرصد الحي): لا تُنشئ مشاركة إطلاقًا
                // ولا تُعدّل سجلًا قائمًا بلقطة صفرية — تُوثَّق في planUnitsIgnored.
                // المسار اليدوي/التكميل (بلا هوية CAD ولا phasesSource) لا يُمس إطلاقًا.
                const hasCadIdentity = c.phasesSource === 'cad-detail' || Number.isInteger(c.cadRunUnitId) || Number.isInteger(c.cadUnitId);
                const hasAnyPhaseTime = !!(c.phases && Object.keys(c.phases).length);
                if (hasCadIdentity && !hasAnyPhaseTime && !c.cadUrs && c.cadReached !== true) {
                    planUnitsIgnored.push(c.team);
                    continue;
                }
                // تعريف الدليل (اعتماد المالك 2026-08-26): وقت رحلة/هوية CAD/urs/
                // cadReached صريح/withdrawn صريح. الحارس نفسه يعمل لاحقًا — عند
                // نقطة الإنشاء فقط، بعد مطابقة السجلات القائمة (انظر الأسفل).
                const hasAnyEvidence = hasAnyPhaseTime || hasCadIdentity || !!c.cadUrs || c.cadReached === true || c.withdrawn === true;
                // المطابقة بهوية الوحدة الثابتة أولًا (قرار المالك 2026-08-23):
                // eventId + cad_run_unit_id = نفس المشاركة مهما تغيّر المسمى —
                // فرقة سُجّلت من CAD ثم ظهرت لاحقًا في التكميل تُربط بسجلها
                // القائم ولا يُنشأ لها سجل ثانٍ أبدًا
                let dup = null, matchedByAlias = false;
                if (Number.isInteger(c.cadRunUnitId) || Number.isInteger(c.cadUnitId)) {
                    dup = await this.engine.storage.findParticipationByCadUnit(effShiftId, number, c.cadRunUnitId, c.cadUnitId);
                    if (dup && dup.unit && dup.unit !== c.team) matchedByAlias = true;
                }
                if (!dup) dup = await this.engine.storage.findParticipation(effShiftId, c.team, number);
                // التحديثات الموجهة بالاسم تستهدف الاسم المخزن عند المطابقة بالهوية
                const effUnit = (dup && dup.unit) ? dup.unit : c.team;
                if (matchedByAlias) { linkedCrews.push({ from: dup.unit, to: c.team }); incidentEnriched = true; }
                // استكمال/تصحيح أزمنة مشاركة قائمة — القاعدة (2026-08-23):
                // phases مصدرها journeys الوحدة (cad-detail) تستبدل اللقطة بالكامل
                // (تصحيح موثق للّقطات المشتركة الخاطئة)، وغيرها يملأ الفراغات فقط
                const applyPhases = async () => {
                    if (c.phasesSource === 'cad-detail') {
                        const rp = await this.engine.storage.replaceParticipationPhases(dup.id, c.phases || {});
                        if (rp.replaced) {
                            const respC = this._responseFor(c.phases, incident.cad_created_at);
                            await this.engine.storage.updateParticipationResponse(dup.id, respC.arrival, respC.mubashara);
                            correctedCrews.push({ team: c.team, oldPhases: rp.oldPhases });
                            incidentEnriched = true;
                        }
                        return;
                    }
                    if (c.phases && Object.keys(c.phases).length) {
                        const m = await this.engine.storage.mergeParticipationPhases(dup.id, c.phases);
                        if (m.merged > 0) {
                            const resp = this._responseFor(m.phases, incident.cad_created_at);
                            await this.engine.storage.updateParticipationResponse(dup.id, resp.arrival, resp.mubashara);
                            incidentEnriched = true; // تطور المراحل يغيّر الخطورة والأزمنة — يستحق بثًا حيًا
                        }
                    }
                };
                // قاعدة المشاركة الفعلية (قرار المالك 2026-08-22 — معتمدة حرفيًا):
                // السؤال ليس «هل الوحدة ملغاة؟» بل «هل أصبحت مشاركة تشغيلية فعلية؟».
                // المصدر: unitRequestStatus (A/B/C/R) + journeys[] (وصول/مباشرة بوقت
                // حقيقي) — لا نص «وحدة ملغاة» ولا تخمين من الغياب:
                //  • A                          → مشاركة قائمة (تُحسب)
                //  • B/C/R + لا وصول فعلي       → ملغاة قبل المباشرة: لا تُحسب ولا تُحذف
                //  • B/C/R + وصول/مباشرة فعلية  → مشاركة فعلية تُحسب + تُعلَّم «أُلغيت
                //    لاحقًا» وتُسجَّل للمراجعة (مثال 1305710: سريع جنوب 1-1 باشرت فعلًا)
                // غياب cadUrs ← السلوك القائم (علم withdrawn من صفحة CAD) لا يتغير إطلاقًا
                const urs = typeof c.cadUrs === 'string' ? c.cadUrs : null;
                let effWithdrawn = c.withdrawn; // undefined = لا تغيير على المخزَّن
                let afterArrival = false;
                if (urs) {
                    if (urs === 'A') effWithdrawn = false;
                    else if (c.cadReached === true) { effWithdrawn = false; afterArrival = true; }
                    else effWithdrawn = true;
                }
                // حالة المشاركة الحالية (§4 — 2026-08-21): سحب/إلغاء الفرقة يُعلَّم على
                // سجلها القائم؛ إن لم يوجد سجل يُنشأ مُعلَّمًا — التاريخ يبقى كاملًا ولا تُحتسب
                if (effWithdrawn === true) {
                    if (dup) {
                        await applyPhases();
                        await this.engine.storage.setParticipationWithdrawn(effShiftId, effUnit, number, true);
                    } else {
                        const phasesJsonW = (c.phases && Object.keys(c.phases).length) ? JSON.stringify(c.phases) : null;
                        const respW = this._responseFor(c.phases, incident.cad_created_at);
                        await this.engine.reports.addReport(effShiftId, 'CAD', c.team, type, number, phasesJsonW, respW.arrival, respW.mubashara);
                        await this.engine.storage.setParticipationWithdrawn(effShiftId, c.team, number, true);
                    }
                    if (urs) await this.engine.storage.setParticipationCadUnitState(effShiftId, effUnit, number, urs, c.cadReached, c.cadUnitId, c.cadRunUnitId);
                    withdrawnCrews.push(c.team);
                    incidentEnriched = true; // تغيّر حالة المشاركة يغيّر التنبيهات والخريطة فورًا
                    continue;
                }
                if (dup) {
                    // القاعدة ③: لا تضاعف العدّاد — لقطة الأزمنة تُستكمل أو تُصحَّح في نفس السجل
                    await applyPhases();
                    // عودة فرقة سُحبت خطأً: withdrawn=false الصريح فقط يزيل العلامة (لا استنتاج)
                    // — ومعه A الصريح من CAD: الوحدة ليست ملغاة في مصدر الحقيقة
                    if (effWithdrawn === false) {
                        await this.engine.storage.setParticipationWithdrawn(effShiftId, effUnit, number, false);
                        incidentEnriched = true;
                    }
                    if (urs) await this.engine.storage.setParticipationCadUnitState(effShiftId, effUnit, number, urs, c.cadReached, c.cadUnitId, c.cadRunUnitId);
                    if (afterArrival) { cancelAfterArrivalCrews.push(c.team); incidentEnriched = true; }
                    skippedCrews.push(c.team);
                    continue;
                }
                // حارس الإنشاء بلا دليل (اعتماد المالك 2026-08-26 ثم توسيعه 2026-08-27
                // بعد provenance المواليد الجديدة): طاقم عارٍ تمامًا {team, phases:{}}
                // بلا سجل قائم ولا أي دليل = لا مشاركة إطلاقًا — في كل المسارات إلا
                // اليدوي الموسوم صراحةً cad-manual. سبب التوسيع: مسارات الـOverlay
                // الآلية غير الموسومة (watchTick) كانت تسقط وسم cad-auto فتصل
                // cad-oneclick وتتجاوز الحارس القديم — 247 مولودة phantom بذلك.
                // موضع الحارس هنا (بعد المطابقة) مقصود: التحديثات على سجل قائم
                // (استكمال أوقات/عودة مسحوبة بـwithdrawn=false الصريح) لا تُحجب
                // أبدًا — المحظور هو إنشاء مشاركة جديدة بلا دليل فقط.
                // الترقية محفوظة: عند ظهور Journey يصل الطاقم بدليله فيُنشأ صحيحًا.
                if (!hasAnyEvidence && source !== 'cad-manual') {
                    evidencelessIgnored.push(c.team);
                    continue;
                }
                const phasesJson = (c.phases && Object.keys(c.phases).length) ? JSON.stringify(c.phases) : null;
                const resp = this._responseFor(c.phases, incident.cad_created_at);
                const r = await this.engine.reports.addReport(effShiftId, 'CAD', c.team, type, number, phasesJson, resp.arrival, resp.mubashara);
                if (r && r.success) {
                    addedCrews.push(c.team);
                    if (urs) await this.engine.storage.setParticipationCadUnitState(effShiftId, c.team, number, urs, c.cadReached, c.cadUnitId, c.cadRunUnitId);
                    if (afterArrival) { cancelAfterArrivalCrews.push(c.team); incidentEnriched = true; }
                } else skippedCrews.push(c.team);
            }
            return { incident, incidentCreated, addedCrews, skippedCrews, withdrawnCrews, cancelAfterArrivalCrews, correctedCrews, linkedCrews, planUnitsIgnored, evidencelessIgnored, incidentEnriched, effShiftId };
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
            withdrawnCrews: result.withdrawnCrews,
            // إلغاء بعد المباشرة (قرار المالك 2026-08-22): مشاركات محتسبة أُلغيت لاحقًا —
            // تُعاد للمسار ليُسجَّل كل واحدة للمراجعة (لا تخمين صامت عند تعارض الظاهر)
            cancelAfterArrivalCrews: result.cancelAfterArrivalCrews,
            // التصحيح من Journey الوحدة الموثوقة (قرار المالك 2026-08-23): كل مشاركة
            // استُبدلت أوقاتها تُعاد مع لقطة القديم لسجل التدقيق — تصحيح موثق لا حذف صامت
            correctedCrews: result.correctedCrews,
            // ربط بهوية الوحدة: مشاركة وُجدت بـcad_run_unit_id تحت مسمى مختلف (ظهور
            // الفرقة في التكميل لاحقًا) — نفس السجل حُدّث ولم يُنشأ ثانٍ
            linkedCrews: result.linkedCrews,
            // وحدات خطة الاستجابة المرفوضة (اعتماد المالك 2026-08-25): لقطات CAD
            // صفرية الدليل لم تُنشئ مشاركة — موثقة بالاسم للتتبع ولا تدخل أي عدّاد
            planUnitsIgnored: result.planUnitsIgnored,
            // أطقم بلا أي دليل مشاركة (اعتماد المالك 2026-08-26 — إصلاح الـphantom):
            // {team, phases:{}} عارية تمامًا لم تُنشئ سجلًا — تُرقَّى لاحقًا عند
            // ظهور Journey الحقيقية، وتبقى موثقة بالاسم هنا للتتبع
            evidencelessIgnored: result.evidencelessIgnored
        };
    }

    /**
     * الإلغاء اليدوي لمشاركة فرقة من توزيع البلاغات (اعتماد المالك 2026-08-24 —
     * جولة Observer): مشاركة سجّلها الـOverlay بالخطأ تُعلَّم manual_cancelled
     * فتخرج فورًا من كل عدّاد ومؤشر تشغيلي (byCrew/أزمنة الاستجابة/الخريطة/
     * نشاط الفرق) — بلا حذف إطلاقًا: السجل يبقى في التفاصيل والتدقيق مع
     * الفاعل والوقت والسبب. idempotent: الملغاة أصلًا تعاد already=true ولا
     * يتكرر القيد. restore يرفع التعليم فقط ويحتفظ بأثر الإلغاء الأول.
     */
    async cancelParticipation({ shiftId, number, unit }, actor, reason, cancel = true) {
        const dup = await this.engine.storage.findParticipation(shiftId, unit, number);
        if (!dup) return { success: false, status: 404, error: 'لا توجد مشاركة بهذه الفرقة على هذا البلاغ' };
        const row = await this.engine.storage.getParticipationManualState(dup.id);
        if (!row) return { success: false, status: 404, error: 'سجل المشاركة غير موجود' };
        if (cancel) {
            if (row.manual_cancelled) return { success: true, already: true, unit }; // لا تكرار للقيد ولا للحالة
            await this.engine.storage.setParticipationManualCancelled(row.id, true,
                actor ? (actor.name || actor.username) : null, reason || null);
            // بث حي بنفس قناة الإثراء: الخريطة والمؤشرات تنعكس فورًا بلا تحديث يدوي
            this.bus.emit('IncidentEnriched', { shift_id: shiftId, center: 'CAD', unit, number,
                actor: actor ? { id: actor.id, name: actor.name || actor.username } : null });
            return { success: true, already: false, unit };
        }
        if (!row.manual_cancelled) return { success: true, already: true, unit, restored: false };
        await this.engine.storage.setParticipationManualCancelled(row.id, false);
        this.bus.emit('IncidentEnriched', { shift_id: shiftId, center: 'CAD', unit, number,
            actor: actor ? { id: actor.id, name: actor.name || actor.username } : null });
        return { success: true, already: false, unit, restored: true,
            previousCancel: { by: row.manual_cancelled_by, at: row.manual_cancelled_at, reason: row.manual_cancel_reason } };
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
     * بصمة «اللقطة المشتركة القديمة» (اعتماد المالك 2026-08-26 — فصل منع
     * التلوث الجديد عن منع أثر التاريخي): مشاركة سُجلت قبل إغلاق مسار
     * التسجيل القديم (2026-08-23.c — commit 75af49e) + بلا أي هوية CAD
     * (unit/runUnit/status) + لديها phases موقوتة = legacy_snapshot /
     * historical_unverified. التتبع أثبت 149 مشاركة بهذه البصمة على 14 فرقة
     * (مراحل منسوخة حرفيًا من فرق أخرى أو من زر cad-oneclick القديم)، وصفر
     * مشاركة بهذه البصمة بعد لحظة الإغلاق.
     * المحميون من الاستبعاد (الاختبار العكسي): مشاركة قديمة بهوية CAD موثوقة
     * (10 صفوف في مناوبة 2026-08-23 صباحًا) تُحتسب طبيعيًا، واليدوي القديم
     * بلا phases (352 صفًا) يبقى على القاعدة القديمة، وأي مشاركة بعد الإغلاق
     * لا تدخل هذا التصنيف إطلاقًا.
     * السجل نفسه لا يُحذف ولا تُعدّل phases ولا يُصفَّر أي عداد يدويًا —
     * التمييز في طبقة الاحتساب فقط، والسجل يبقى للتدقيق بحالته.
     */
    static LEGACY_SNAPSHOT_CUTOFF = '2026-08-23 13:00:00';

    isLegacySnapshot(row) {
        if (!row) return false;
        const createdAt = row.report_created_at || row.created_at || null;
        if (!createdAt) return false; // بلا دليل زمني ← لا تصنيف (لا استبعاد بالشك)
        if (String(createdAt) >= ReportService.LEGACY_SNAPSHOT_CUTOFF) return false;
        if (row.cad_unit_id != null || row.cad_run_unit_id != null || row.cad_unit_status != null) return false;
        let phases = row.phases;
        if (typeof phases === 'string') { try { phases = JSON.parse(phases); } catch (_) { phases = null; } }
        if (!phases) return false;
        return Object.keys(phases).some(k => !!phases[k]);
    }

    /**
     * تعريف «المشاركة المحتسبة» الوحيد في المنصة (قرار المالك 2026-08-24 —
     * لا مصدران للحقيقة): لا مسحوبة (withdrawn) ولا ملغاة يدويًا
     * (manual_cancelled)، وإن وُجدت لقطة CAD فلا تُحسب إلا بدليل «التحرك».
     * ومن 2026-08-26: اللقطة المشتركة القديمة (legacy_snapshot) لا تُحسب —
     * تبقى محفوظة للتدقيق ولا تدخل byCrew ولا الإنجازات ولا التوزيع ولا
     * المؤشرات ولا الذاكرة التحليلية كـ«فرقة باشرت».
     * كل عدّاد مبني على المشاركات (تقرير المناوبة/توزيع البلاغات/التقرير
     * اليومي/byCrew/الأزمنة) يشتق من هذه القاعدة حتى لا تتباين الشاشات.
     * @param {Object} row - صف report_times (phases نص JSON أو كائن، withdrawn، manual_cancelled)
     */
    isParticipationCounted(row) {
        if (!row) return false;
        if (row.withdrawn) return false;
        if (row.manual_cancelled) return false;
        if (this.isLegacySnapshot(row)) return false;
        let phases = row.phases;
        if (typeof phases === 'string') { try { phases = JSON.parse(phases); } catch (_) { phases = null; } }
        return this.isCountedParticipation(phases || null);
    }

    /**
     * خريطة «center|unit» من صفوف المشاركات بعد قاعدة الاحتساب الواحدة —
     * count/times/types تُشتق من الصفوف المحتسبة فقط (لا من عدّاد reports.count
     * التجميعي الذي لا يُنقَص بالإلغاء). الوحدة التي استُبعدت كل مشاركاتها
     * تبقى ظاهرة بعدّاد 0 بصدق (الشكل محفوظ، والإحصاء لا يحسبها).
     */
    _buildCountedDataMap(rows) {
        const data = {};
        for (const row of rows) {
            if (!row.center || !row.unit) continue;
            const key = `${row.center}|${row.unit}`;
            if (!data[key]) data[key] = { count: 0, times: [], types: {} };
            if (row.id == null) continue; // تقرير بلا صفوف مشاركة إطلاقًا
            if (!this.isParticipationCounted(row)) continue;
            data[key].count++;
            if (row.timestamp) data[key].times.push(row.timestamp);
            if (row.type) data[key].types[row.type] = (data[key].types[row.type] || 0) + 1;
        }
        return data;
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
        // فصل الإلغاءات (قرار المالك 2026-08-22): قبل المباشرة = محفوظة تاريخيًا ولا
        // تدخل المشاركات · بعد المباشرة = تبقى محسوبة مشاركة فعلية وتُعلَّم
        let cancBeforeArrival = 0, cancAfterArrival = 0;
        const detail = incidents.map(ic => {
            const t = ic.type || 'other';
            byType[t] = (byType[t] || 0) + 1; // مرة واحدة لكل بلاغ (القاعدة ④)
            const d = ic.district || 'غير محدد';
            byDistrict[d] = (byDistrict[d] || 0) + 1; // الحي لا يتكرر بتعدد الفرق — مثل النوع تمامًا
            const crews = (partsByIncident[ic.number] || []).map(p => {
                let phases = null;
                try { phases = p.phases ? JSON.parse(p.phases) : null; } catch (_) { phases = null; }
                const withdrawn = !!p.withdrawn; // الحالة الحالية للمشاركة (§4): المسحوبة لا تُحتسب إطلاقًا
                // الإلغاء اليدوي من توزيع البلاغات (اعتماد المالك 2026-08-24): يُستبعد
                // فورًا من كل عدّاد ومؤشر — ويبقى موثقًا في التفاصيل والتدقيق
                const manualCancelled = !!p.manual_cancelled;
                // لقطة مشتركة قديمة (2026-08-26): لا تُحتسب لكنها تظهر في
                // التفاصيل مصنفة — تمييز عن المشاركة الحقيقية، لا مسح للتاريخ
                const legacySnapshot = this.isLegacySnapshot(p);
                // قاعدة الاحتساب الواحدة المشتركة مع تقرير المناوبة والتوزيع (2026-08-24)
                const counted = this.isParticipationCounted(p);
                if (counted) byCrew[p.unit] = (byCrew[p.unit] || 0) + 1; // مشاركة محتسبة واحدة لكل فرقة (②)
                // حالة الوحدة في CAD (قابلة للتتبع): B/C/R + لا وصول = قبل المباشرة ·
                // B/C/R + وصول فعلي = بعد المباشرة (محتسبة) — A أو غياب الحقل = لا إلغاء
                const cadUrs = p.cad_unit_status || null;
                const cadReached = p.cad_reached == null ? null : !!p.cad_reached;
                const cancelKind = this._cancelKind(p);
                if (cancelKind === 'after-arrival') cancAfterArrival++;
                else if (cancelKind === 'before-arrival') cancBeforeArrival++;
                return {
                    unit: p.unit, at: p.timestamp, phases, counted, withdrawn,
                    manualCancelled, legacySnapshot,
                    manualCancelledBy: p.manual_cancelled_by || null,
                    manualCancelledAt: p.manual_cancelled_at || null,
                    manualCancelReason: p.manual_cancel_reason || null,
                    cadUrs, cadReached, cancelKind,
                    // هوية الوحدة الثابتة في CAD (2026-08-23): ربط المشاركة بالوحدة
                    // الفعلية لا بترتيب الظهور — null بصدق للمشاركات اليدوية/القديمة
                    cadUnitId: p.cad_unit_id != null ? p.cad_unit_id : null,
                    cadRunUnitId: p.cad_run_unit_id != null ? p.cad_run_unit_id : null,
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
            return { number: ic.number, code: ic.code, type: t, source: ic.source, status: ic.status || 'active', createdAt: ic.created_at, cadCreatedAt: ic.cad_created_at || null, address: ic.address || null, region: ic.region || null, district: ic.district || null, street: ic.street || null, city: ic.city || null, lat: ic.lat != null ? ic.lat : null, lng: ic.lng != null ? ic.lng : null, crews,
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
            // البلاغ النهائي (قرار المالك 2026-08-22): خارج الحالة التشغيلية تمامًا —
            // لا خطورة ولا ضغط ولا «نشط»، ويبقى محفوظًا في الإحصائيات التاريخية
            if (d.status !== 'active') { d.severity = null; continue; }
            const arrived = d.crews.some(c => c.counted && c.phases && (c.phases['البحث'] || c.phases['العلاج']));
            const createdTs = this._cadDateTimeTs(d.cadCreatedAt);
            const elapsedMin = createdTs !== null ? (Date.now() - createdTs) / 60000 : null;
            d.severity = arrived ? 'green'
                : (avgArrival !== null && elapsedMin !== null && elapsedMin > avgArrival ? 'red' : 'yellow');
        }
        // حالة القطاع للشريط العلوي: أسوأ خطورة بين البلاغات النشطة فقط — وnull بلا نشطة («—» الصادقة)
        const activeDetail = detail.filter(d => d.status === 'active');
        const sectorStatus = !activeDetail.length ? null
            : activeDetail.some(d => d.severity === 'red') ? 'red'
            : activeDetail.some(d => d.severity === 'yellow') ? 'yellow' : 'green';
        // «أكثر حي ضغطًا» مؤشر تشغيلي: من النشطة فقط — byDistrict نفسه يبقى تاريخيًا شاملًا
        const activeByDistrict = {};
        for (const d of activeDetail) { const dn = d.district || 'غير محدد'; activeByDistrict[dn] = (activeByDistrict[dn] || 0) + 1; }
        let topDistrict = null;
        for (const dName of Object.keys(activeByDistrict)) {
            if (dName === 'غير محدد') continue;
            if (!topDistrict || activeByDistrict[dName] > topDistrict.count) topDistrict = { name: dName, count: activeByDistrict[dName] };
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
        // «بلا موقع دقيق» قائمة تشغيلية (تتطلب اكتمال موقعها الآن) ← النشطة فقط (قرار 2026-08-22)
        const noLocationList = activeDetail.filter(d => d.lat === null || d.lng === null)
            .map(d => ({ number: d.number, district: d.district }));
        // ═══ اكتشاف احتمال التكرار (اعتماد المالك 2026-08-24 — ملحق note-18) ═══
        // اشتقاق صرف عند القراءة من سجل البلاغات الخام نفسه — يُحسب بعد اكتمال كل
        // العدّادات ولا يلمسها إطلاقًا (total/byCrew/byType/الأزمنة لا تتغير)، ولا
        // يُخزَّن شيء ولا تُنشأ جداول موازية. «احتمال تكرار — يحتاج تحقق» تنبيه
        // فقط: القرار والإلغاء في CAD حصرًا، ولا سجل مراجعة هنا. رقم المبلغ
        // يدخل المطابقة سيرفريًا ولا يُضمَّن في المخرجات إطلاقًا (أدلة مقنّعة).
        const dupInput = incidents.map(ic => {
            const tsCad = this._cadDateTimeTs(ic.cad_created_at);
            const tsFallback = ic.created_at ? new Date(ic.created_at).getTime() : NaN;
            return { number: ic.number, status: ic.status || 'active',
                callerNumber: ic.caller_number || null, description: ic.description || null,
                address: ic.address || null, type: ic.type || null, code: ic.code || null,
                lat: ic.lat != null ? ic.lat : null, lng: ic.lng != null ? ic.lng : null,
                createdTs: tsCad !== null ? tsCad : (isFinite(tsFallback) ? tsFallback : null) };
        });
        const dupByNumber = {};
        for (const p of DuplicateDetection.findDuplicates(dupInput)) {
            if (!dupByNumber[p.number]) dupByNumber[p.number] = [];
            dupByNumber[p.number].push({ candidate: p.candidate, score: p.score, level: p.level,
                evidence: p.evidence, cancelledInCad: p.cancelledInCad });
        }
        for (const d of detail) d.duplicates = dupByNumber[d.number] || [];
        return {
            total: incidents.length + manual.length, // ① بلاغات فريدة + يدوي — تاريخي شامل (المنتهي حدث فعلًا)
            incidentsCount: incidents.length,
            activeCount: activeDetail.length, // النشطة فقط — أساس الخريطة والتنبيهات والضغط
            manualCount: manual.length,
            // فصل الإلغاءات (قرار المالك 2026-08-22): قبل المباشرة لا تدخل المشاركات،
            // وبعد المباشرة تبقى محسوبة — العدّان تاريخيان قابلان للتتبع لكل مشاركة
            unitCancels: { beforeArrival: cancBeforeArrival, afterArrival: cancAfterArrival },
            byType, byCrew, byDistrict,
            incidents: detail,
            lastReportTs,
            mapStatus: {
                sectorStatus,
                topDistrict,
                peakHour,
                topStreets,
                noLocation: noLocationList,
                positionedCount: activeDetail.filter(d => d.lat !== null && d.lng !== null).length,
                noLocationCount: noLocationList.length
            },
            responseTime: {
                arrival: { avg: avgArrival, count: rtArrival.length },
                mubashara: { avg: avgMubashara, count: rtMubashara.length },
                definition: 'من إنشاء البلاغ في CAD حتى الوصول (مرحلة البحث)/المباشرة (مرحلة العلاج) — الفرق التي لم تتحرك خارج المؤشر'
            }
        };
    }

    /**
     * الذاكرة التاريخية للخريطة (H1 — اعتماد المالك 2026-08-24، وثيقة
     * DECISION-HISTORICAL-ANALYTICS): نفس اشتقاقات getIncidentSummary لكن على
     * نطاق زمني حر عبر كل المناوبات. قواعد ملزمة:
     *  - الترشيح على وقت الإنشاء الفعلي cad_created_at عبر محلل CAD المركزي
     *    (_cadDateTimeTs)، وcreated_at بديلًا صادقًا عند غيابه — صف بلا أي وقت
     *    قابل للقراءة يُحسب في unresolvedTimeCount ولا يتسلل إلى النطاق.
     *  - الخريطة التاريخية تعرض كل بلاغات النطاق (المنتهي حدث فعلًا) —
     *    severity=null دائمًا: لا خطورة حية ولا «الآن» في ذاكرة تاريخية.
     *  - byCrew وأزمنة الاستجابة من المشاركات المحتسبة فقط (isParticipationCounted):
     *    Available Units ليست مشاركة، ولا نسخ أوقات بين الوحدات.
     *  - الضغطات اليدوية (بلا رقم CAD) خارج هذه الطبقة — لا موقع لها بنيويًا
     *    ولا تُخترع لها إحداثيات؛ تُوثَّق في notes.
     * قراءة مشتقة صرفة: لا تخزين ولا كتابة ولا جداول موازية.
     */
    /**
     * ترشيح البلاغات على نطاق زمني (قاعدة واحدة لكل طبقات H1–H4):
     * cad_created_at عبر محلل CAD المركزي، وcreated_at بديلًا صادقًا عند غيابه؛
     * صف بلا أي وقت قابل للقراءة يُحسب في unresolvedTimeCount ولا يتسلل للنطاق.
     */
    _incidentsInRange(incidents, fromTs, toTs) {
        const inRange = [];
        let unresolvedTimeCount = 0;
        for (const ic of incidents) {
            let ts = this._cadDateTimeTs(ic.cad_created_at);
            if (ts === null && ic.created_at) { const p = Date.parse(ic.created_at); ts = isNaN(p) ? null : p; }
            if (ts === null) { unresolvedTimeCount++; continue; }
            if (ts < fromTs || ts > toTs) continue;
            inRange.push({ ic, ts });
        }
        return { inRange, unresolvedTimeCount };
    }

    /**
     * نوع إلغاء الوحدة من CAD (قاعدة واحدة لكل الطبقات): حالة غير 'A' +
     * وصول/مباشرة فعلية (cad_reached) = بعد المباشرة (محتسبة) · وإلا قبلها.
     * null إن لم تُلغَ. قابل للتتبع إلى cad_unit_status/cad_reached الخام.
     */
    _cancelKind(p) {
        const cadUrs = p.cad_unit_status || null;
        if (!cadUrs || cadUrs === 'A') return null;
        const cadReached = p.cad_reached == null ? null : !!p.cad_reached;
        return cadReached === true ? 'after-arrival' : 'before-arrival';
    }

    /** مسافة هافرساين كم (مشتركة بين H3/H4 — حساب واحد لا تكرار) */
    _haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371, rad = Math.PI / 180;
        const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
            + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    async getHistoricalSummary(fromTs, toTs) {
        const { incidents, parts } = await this.engine.storage.getIncidentHistoryData();
        const { inRange, unresolvedTimeCount } = this._incidentsInRange(incidents, fromTs, toTs);
        const partsByKey = {};
        for (const p of parts) {
            const k = p.shift_id + '|' + p.incident_number;
            (partsByKey[k] = partsByKey[k] || []).push(p);
        }
        const byType = {}, byCrew = {}, byDistrict = {}, byStatus = {};
        const rtArrival = [], rtMubashara = [];
        let cancBeforeArrival = 0, cancAfterArrival = 0;
        const detail = inRange.map(({ ic }) => {
            const t = ic.type || 'other';
            byType[t] = (byType[t] || 0) + 1; // مرة واحدة لكل بلاغ — مثل الملخص الشيفتي
            const dName = ic.district || 'غير محدد';
            byDistrict[dName] = (byDistrict[dName] || 0) + 1; // الحي لا يتكرر بتعدد الفرق
            const st = ic.status || 'active';
            byStatus[st] = (byStatus[st] || 0) + 1;
            const crews = (partsByKey[ic.shift_id + '|' + ic.number] || []).map(p => {
                let phases = null;
                try { phases = p.phases ? JSON.parse(p.phases) : null; } catch (_) { phases = null; }
                // قاعدة الاحتساب الواحدة المشتركة مع كل أسطح المنصة (2026-08-24)
                const counted = this.isParticipationCounted(p);
                if (counted) byCrew[p.unit] = (byCrew[p.unit] || 0) + 1;
                const legacySnapshot = this.isLegacySnapshot(p); // مصنفة ولا تُحتسب (2026-08-26)
                const cadUrs = p.cad_unit_status || null;
                const cadReached = p.cad_reached == null ? null : !!p.cad_reached;
                const cancelKind = this._cancelKind(p);
                if (cancelKind === 'after-arrival') cancAfterArrival++;
                else if (cancelKind === 'before-arrival') cancBeforeArrival++;
                return {
                    unit: p.unit, at: p.timestamp, phases, counted,
                    withdrawn: !!p.withdrawn, manualCancelled: !!p.manual_cancelled,
                    legacySnapshot,
                    cadUrs, cadReached, cancelKind,
                    cadUnitId: p.cad_unit_id != null ? p.cad_unit_id : null,
                    cadRunUnitId: p.cad_run_unit_id != null ? p.cad_run_unit_id : null,
                    respArrivalMin: p.resp_arrival_min != null ? p.resp_arrival_min : null,
                    respMubasharaMin: p.resp_mubashara_min != null ? p.resp_mubashara_min : null
                };
            });
            // مؤشر البلاغ: أسرع وصول/مباشرة بين الفرق المحتسبة فقط — تعدد الفرق لا يكرر البلاغ
            const countedCrews = crews.filter(c => c.counted);
            const arrVals = countedCrews.map(c => c.respArrivalMin).filter(v => v !== null);
            const mubVals = countedCrews.map(c => c.respMubasharaMin).filter(v => v !== null);
            if (arrVals.length) rtArrival.push(Math.min(...arrVals));
            if (mubVals.length) rtMubashara.push(Math.min(...mubVals));
            return {
                number: ic.number, code: ic.code, type: t, source: ic.source,
                status: st, severity: null, // ذاكرة تاريخية: لا خطورة حية إطلاقًا
                shiftId: ic.shift_id != null ? ic.shift_id : null,
                createdAt: ic.created_at, cadCreatedAt: ic.cad_created_at || null,
                address: ic.address || null, region: ic.region || null, district: ic.district || null,
                street: ic.street || null, city: ic.city || null,
                lat: ic.lat != null ? ic.lat : null, lng: ic.lng != null ? ic.lng : null,
                crews,
                bestArrivalMin: arrVals.length ? Math.min(...arrVals) : null,
                bestMubasharaMin: mubVals.length ? Math.min(...mubVals) : null
            };
        });
        const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
        // مؤشرات النطاق التاريخية — على كامل النطاق (المنتهي حدث فعلًا)، لا على النشط فقط
        const hourCount = {};
        for (const { ts } of inRange) { const h = new Date(ts).getHours(); hourCount[h] = (hourCount[h] || 0) + 1; }
        let peakHour = null;
        for (const h of Object.keys(hourCount)) {
            if (!peakHour || hourCount[h] > peakHour.count) peakHour = { hour: +h, count: hourCount[h] };
        }
        let topDistrict = null;
        for (const dName of Object.keys(byDistrict)) {
            if (dName === 'غير محدد') continue;
            if (!topDistrict || byDistrict[dName] > topDistrict.count) topDistrict = { name: dName, count: byDistrict[dName] };
        }
        const streetCount = {};
        for (const d of detail) { if (d.street) streetCount[d.street] = (streetCount[d.street] || 0) + 1; }
        const topStreets = Object.entries(streetCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([name, count]) => ({ name, count }));
        // «بلا موقع دقيق» هنا تاريخية: كل بلاغات النطاق بلا إحداثيات — بصدق وبلا اختراع مواقع
        const positioned = detail.filter(d => d.lat !== null && d.lng !== null);
        const noLocationList = detail.filter(d => d.lat === null || d.lng === null)
            .map(d => ({ number: d.number, district: d.district, cadCreatedAt: d.cadCreatedAt }));
        return {
            range: { from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString() },
            total: detail.length,
            incidentsCount: detail.length,
            activeCount: detail.filter(d => d.status === 'active').length, // معلومة صدق — ليست أساس العرض هنا
            byStatus, byType, byCrew, byDistrict,
            unitCancels: { beforeArrival: cancBeforeArrival, afterArrival: cancAfterArrival },
            incidents: detail,
            unresolvedTimeCount,
            mapStatus: {
                sectorStatus: null, // لا حالة ضغط «الآن» في الذاكرة التاريخية
                topDistrict, peakHour, topStreets,
                noLocation: noLocationList,
                positionedCount: positioned.length,
                noLocationCount: noLocationList.length
            },
            responseTime: {
                arrival: { avg: avg(rtArrival), count: rtArrival.length },
                mubashara: { avg: avg(rtMubashara), count: rtMubashara.length },
                definition: 'من إنشاء البلاغ في CAD حتى الوصول (مرحلة البحث)/المباشرة (مرحلة العلاج) — الفرق التي لم تتحرك خارج المؤشر'
            },
            notes: [
                'الضغطات اليدوية بلا رقم CAD خارج هذه الطبقة — لا موقع لها بنيويًا ولا تُخترع لها إحداثيات',
                'Available Units (اقتراحات خطة الاستجابة) ليست مشاركة — لا تدخل أي عدّاد',
                'حدود النطاق وساعة الذروة بنفس أساس توقيت محلل CAD المركزي المستخدم في الخريطة التشغيلية'
            ]
        };
    }

    // ═══════════════ H2 — الأنماط الزمنية (اعتماد المالك 2026-08-24) ═══════════════
    // ثوابت الاشتقاق موثقة هنا ومصدرها الوحيد هذه الخدمة (لا منطق في الواجهة):
    // الفترات: صباح 07–15 · مساء 15–23 · ليل 23–07 (أساس توقيت محلل CAD المركزي).
    static get PERIODS() {
        return [
            { key: 'morning', label: 'صباح', from: 7, to: 15 },
            { key: 'evening', label: 'مساء', from: 15, to: 23 },
            { key: 'night', label: 'ليل', from: 23, to: 31 } // 23–24 و0–7
        ];
    }
    static _periodOf(hour) { return hour >= 7 && hour < 15 ? 'morning' : (hour >= 15 && hour < 23 ? 'evening' : 'night'); }

    /**
     * H2 — الأنماط: الساعة/اليوم/الفترة/الذروة/الأحياء/الشوارع + مقارنة بالفترة
     * السابقة المماثلة (نفس الطول قبل النطاق مباشرة). اشتقاق صرف من
     * incident_registry — لا تخزين ولا جداول موازية.
     */
    async getPatterns(fromTs, toTs) {
        const { incidents } = await this.engine.storage.getIncidentHistoryData();
        const { inRange, unresolvedTimeCount } = this._incidentsInRange(incidents, fromTs, toTs);
        const span = toTs - fromTs + 1;
        const prev = this._incidentsInRange(incidents, fromTs - span, fromTs - 1);
        const build = (list) => {
            const byHour = new Array(24).fill(0);
            const byWeekday = new Array(7).fill(0); // 0=الأحد … 6=السبت (ترقيم JS)
            const byPeriod = { morning: 0, evening: 0, night: 0 };
            const matrix = Array.from({ length: 7 }, () => new Array(24).fill(0));
            const byDate = {}, byDistrict = {}, byStreet = {}, byType = {};
            for (const { ic, ts } of list) {
                const d = new Date(ts);
                const h = d.getHours(), w = d.getDay();
                byHour[h]++; byWeekday[w]++; byPeriod[ReportService._periodOf(h)]++; matrix[w][h]++;
                const dk = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                byDate[dk] = (byDate[dk] || 0) + 1;
                const dn = ic.district || 'غير محدد';
                byDistrict[dn] = (byDistrict[dn] || 0) + 1;
                if (ic.street) byStreet[ic.street] = (byStreet[ic.street] || 0) + 1;
                const t = ic.type || 'other';
                byType[t] = (byType[t] || 0) + 1;
            }
            return { byHour, byWeekday, byPeriod, matrix, byDate, byDistrict, byStreet, byType, total: list.length };
        };
        const cur = build(inRange);
        const prv = build(prev.inRange);
        const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
        // الذروة: أول الأعلى — byHour/byWeekday مصفوفات فالتعادل يفوز الأصغر ترقيمًا (حتمي)
        const peakHourIdx = cur.byHour.indexOf(Math.max(...cur.byHour));
        const peakWeekdayIdx = cur.byWeekday.indexOf(Math.max(...cur.byWeekday));
        const round1 = v => Math.round(v * 10) / 10;
        const days = Math.max(1, Math.round(span / 86400000));
        return {
            range: { from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString() },
            total: cur.total,
            byHour: cur.byHour,
            byWeekday: cur.byWeekday,
            byPeriod: cur.byPeriod,
            byDate: cur.byDate,
            byType: cur.byType,
            districts: top(cur.byDistrict, 10),
            streets: top(cur.byStreet, 10),
            peakHour: cur.total ? { hour: peakHourIdx, count: cur.byHour[peakHourIdx] } : null,
            peakWeekday: cur.total ? { day: peakWeekdayIdx, count: cur.byWeekday[peakWeekdayIdx] } : null,
            unresolvedTimeCount,
            comparison: {
                label: 'الفترة السابقة المماثلة (' + days + (days === 1 ? ' يوم' : ' أيام') + ' قبل النطاق مباشرة)',
                range: { from: new Date(fromTs - span).toISOString(), to: new Date(fromTs - 1).toISOString() },
                total: prv.total,
                perDay: { current: round1(cur.total / days), previous: round1(prv.total / days) },
                delta: cur.total - prv.total,
                byType: { current: cur.byType, previous: prv.byType }
            },
            periodRule: 'صباح 07:00–15:00 · مساء 15:00–23:00 · ليل 23:00–07:00 — على أساس توقيت محلل CAD المركزي',
            notes: [
                'كل الأنماط مشتقة من cad_created_at الفعلي (أو created_at بديلًا صادقًا) — لا تخزين مسبق لأي نمط',
                'الفترات قاعدة اشتقاق موثقة قابلة للضبط بقرار — ليست تعريفًا تشغيليًا ملزمًا'
            ],
            _matrix: cur.matrix // لدعم القرار (H4) — نوافذ الذروة يوم×ساعة
        };
    }

    // ═══════════════ H3 — الطلب × التمركز (اعتماد المالك 2026-08-24) ═══════════════
    // ثوابت موثقة: خلية الطلب ≈ 0.01° (~1.1كم) بثلاثة بلاغات فأكثر · «بعيد» = 3كم ·
    // «تغطية ضعيفة» = متوسط أقرب تمركز وقت البلاغ > 3كم أو متوسط وصول أعلى من متوسط النطاق.
    static get ANALYTICS_RULES() {
        return { DEMAND_ZONE_MIN: 3, COVERAGE_FAR_KM: 3, SIM_RADIUS_KM: 3, CELL_DECIMALS: 2 };
    }

    /**
     * H3 — الطلب × التمركز: كل بلاغ محدد الموقع يُربط بنوافذ التمركز الفعلية من
     * سجل positioning_events (append-only — الحمولة كاملة عند كل حدث):
     * أقرب تمركز نشط وقت البلاغ (أي فرقة) + تمركز الفرقة المباشرة نفسها إن وُجد.
     * من لا تمركز معروف له وقت البلاغ يُعرض «بلا تمركز معروف» بصدق — لا تخمين.
     */
    async getCoverage(fromTs, toTs) {
        const { incidents, parts } = await this.engine.storage.getIncidentHistoryData();
        const { inRange, unresolvedTimeCount } = this._incidentsInRange(incidents, fromTs, toTs);
        const posEvents = await this.engine.storage.getPositioningHistory();
        // نوافذ التمركز من لقطات الأحداث — parseRiyadhWall المركزي يفسّر القديم والجديد
        const windows = [];
        for (const ev of posEvents) {
            let pl = null;
            try { pl = ev.payload ? JSON.parse(ev.payload) : null; } catch (_) { pl = null; }
            if (!pl) continue;
            const lat = parseFloat(pl.lat), lng = parseFloat(pl.lng);
            if (!isFinite(lat) || !isFinite(lng)) continue; // بلا إحداثية ← لا موقع مختلق
            const s = PositioningService.parseRiyadhWall(pl.startTime);
            const e = PositioningService.parseRiyadhWall(pl.endTime);
            windows.push({
                planId: String(ev.plan_id), unit: pl.unit || null, location: pl.location || null,
                lat, lng,
                startTs: s ? s.getTime() : null,
                endTs: e ? e.getTime() : null,
                eventType: ev.event_type, at: ev.created_at
            });
        }
        const partsByKey = {};
        for (const p of parts) {
            const k = p.shift_id + '|' + p.incident_number;
            (partsByKey[k] = partsByKey[k] || []).push(p);
        }
        // النوافذ المرتبطة بالنطاق فقط (تداخل زمني معه) — تمركزات خارج النطاق لا
        // تخص هذا التحليل ولا تُعرض على خريطته ولا تدخل «أقرب تمركز تاريخي»
        const windowsInRange = windows.filter(w =>
            (w.startTs === null || w.startTs <= toTs) && (w.endTs === null || w.endTs >= fromTs));
        const activeAt = (ts) => windowsInRange.filter(w =>
            (w.startTs === null || w.startTs <= ts) && (w.endTs === null || w.endTs >= ts));
        // نقاط تمركز فريدة للعرض على الخريطة (الأحداث مرتبة زمنيًا — الأحدث يطغى)
        const posPoints = {};
        for (const w of windowsInRange) {
            posPoints[(w.unit || '?') + '|' + w.lat + '|' + w.lng] =
                { unit: w.unit, location: w.location, lat: w.lat, lng: w.lng };
        }
        const nearestOf = (lat, lng, cands) => {
            let best = null;
            for (const w of cands) {
                const km = this._haversineKm(lat, lng, w.lat, w.lng);
                if (!best || km < best.km) best = { km: Math.round(km * 10) / 10, unit: w.unit, location: w.location, planId: w.planId };
            }
            return best;
        };
        const detail = [];
        const respAll = [];
        let noCoords = 0;
        for (const { ic, ts } of inRange) {
            const crewsList = partsByKey[ic.shift_id + '|' + ic.number] || [];
            const counted = crewsList.filter(p => this.isParticipationCounted(p));
            const countedUnits = counted.map(p => p.unit);
            const arrVals = counted.map(p => p.resp_arrival_min).filter(v => v !== null && v !== undefined);
            const bestArrivalMin = arrVals.length ? Math.min(...arrVals) : null;
            if (bestArrivalMin !== null) respAll.push(bestArrivalMin);
            if (ic.lat === null || ic.lat === undefined || ic.lng === null || ic.lng === undefined) {
                noCoords++;
                detail.push({
                    number: ic.number, type: ic.type || null, code: ic.code || null, status: ic.status || 'active',
                    district: ic.district || null, street: ic.street || null,
                    cadCreatedAt: ic.cad_created_at || null, lat: null, lng: null,
                    countedUnits, bestArrivalMin, cadHour: new Date(ts).getHours(),
                    nearestPositioningAtTime: null, crewPositioning: null, noCoords: true
                });
                continue;
            }
            const act = activeAt(ts);
            const nearestAny = nearestOf(ic.lat, ic.lng, act);
            let crewPos = null;
            for (const u of countedUnits) {
                const own = nearestOf(ic.lat, ic.lng, act.filter(w => w.unit === u));
                if (own && (!crewPos || own.km < crewPos.km)) { crewPos = own; break; } // أقرب تمركز لفرقة مباشرة
            }
            detail.push({
                number: ic.number, type: ic.type || null, code: ic.code || null, status: ic.status || 'active',
                district: ic.district || null, street: ic.street || null,
                cadCreatedAt: ic.cad_created_at || null, lat: ic.lat, lng: ic.lng,
                countedUnits, bestArrivalMin, cadHour: new Date(ts).getHours(),
                nearestPositioningAtTime: nearestAny, // null = بلا تمركز معروف وقت البلاغ (صدق)
                crewPositioning: crewPos,
                noCoords: false
            });
        }
        const avgOf = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 10) / 10 : null;
        const overallAvgArrival = avgOf(respAll);
        // مناطق الطلب: خلايا ~0.01° بثلاثة بلاغات محددة الموقع فأكثر
        const R = ReportService.ANALYTICS_RULES;
        const cells = {};
        for (const d of detail) {
            if (d.noCoords) continue;
            const key = d.lat.toFixed(R.CELL_DECIMALS) + ',' + d.lng.toFixed(R.CELL_DECIMALS);
            (cells[key] = cells[key] || []).push(d);
        }
        const zones = Object.entries(cells).filter(([, l]) => l.length >= R.DEMAND_ZONE_MIN).map(([key, list]) => {
            const clat = list.reduce((s, x) => s + x.lat, 0) / list.length;
            const clng = list.reduce((s, x) => s + x.lng, 0) / list.length;
            const respVals = list.map(x => x.bestArrivalMin).filter(v => v !== null);
            const nearVals = list.map(x => x.nearestPositioningAtTime ? x.nearestPositioningAtTime.km : null).filter(v => v !== null);
            const avgArrivalMin = avgOf(respVals);
            const avgNearestAtTimeKm = nearVals.length ? avgOf(nearVals) : null;
            // ذروة المنطقة الزمنية (اعتماد المالك 2026-08-24 — نافذة المنطقة الساخنة):
            // أعلى نافذة 3 ساعات متتالية طلبًا من cadHour الفعلي لبلاغات الخلية؛
            // التعادل يُحسم لأبكر بداية — اشتقاق صرف بلا تخمين
            const hourHist = new Array(24).fill(0);
            for (const x of list) { if (x.cadHour !== null && x.cadHour !== undefined) hourHist[x.cadHour]++; }
            let peakWindow = null, bestWinSum = -1;
            for (let s = 0; s <= 21; s++) {
                const sum = hourHist[s] + hourHist[s + 1] + hourHist[s + 2];
                if (sum > bestWinSum) { bestWinSum = sum; peakWindow = { startHour: s, endHour: s + 3, count: sum }; }
            }
            if (peakWindow && peakWindow.count === 0) peakWindow = null;
            // أقرب تمركز تاريخي للمنطقة ضمن النوافذ المتداخلة مع النطاق
            const nearestAnytime = nearestOf(clat, clng, windowsInRange);
            const weakReasons = [];
            if (avgNearestAtTimeKm !== null && avgNearestAtTimeKm > R.COVERAGE_FAR_KM) weakReasons.push('أقرب تمركز وقت البلاغات بعيد (>' + R.COVERAGE_FAR_KM + 'كم)');
            if (nearVals.length < list.length) weakReasons.push('بعض البلاغات بلا تمركز معروف وقتها');
            if (avgArrivalMin !== null && overallAvgArrival !== null && avgArrivalMin > overallAvgArrival) weakReasons.push('متوسط الوصول أعلى من متوسط النطاق');
            return {
                key,
                centroid: { lat: Math.round(clat * 10000) / 10000, lng: Math.round(clng * 10000) / 10000 },
                count: list.length,
                // تتبع الرقم إلى مصدره (اعتماد المالك 2026-08-25): كل منطقة تكشف
                // أرقام بلاغاتها الفعلية — 8 = هذه البلاغات الثمانية بالتحديد
                incidentNumbers: list.map(x => x.number),
                avgArrivalMin,
                avgNearestAtTimeKm,
                withoutPositioningAtTime: list.length - nearVals.length,
                nearestAnytimeKm: nearestAnytime ? nearestAnytime.km : null,
                peakWindow,
                weak: weakReasons.length > 0,
                weakReasons
            };
        }).sort((a, b) => b.count - a.count);
        return {
            range: { from: new Date(fromTs).toISOString(), to: new Date(toTs).toISOString() },
            totals: {
                incidents: inRange.length,
                positioned: inRange.length - noCoords,
                noCoords,
                unresolvedTimeCount
            },
            positioning: {
                windowsCount: windowsInRange.length, // المتداخلة مع النطاق فقط
                units: [...new Set(windowsInRange.map(w => w.unit).filter(Boolean))].sort()
            },
            positioningUnits: Object.values(posPoints), // نقاط فريدة للعرض — من السجل الفعلي فقط
            responseAvgArrival: overallAvgArrival,
            incidents: detail,
            zones,
            constants: { demandZoneMin: R.DEMAND_ZONE_MIN, coverageFarKm: R.COVERAGE_FAR_KM, cellDegrees: '0.01° (~1.1كم)' },
            notes: [
                'التمركز المعروف = ما سُجّل فعلًا في positioning_events فقط — الفرقة بلا تمركز مسجل وقت البلاغ تُعرض «بلا تمركز معروف» ولا يُخمَّن مكانها',
                'نوافذ التمركز الداخلة في التحليل = المتداخلة زمنيًا مع النطاق المحدد فقط',
                'منطقة الطلب = خلية شبكية ~1.1كم بثلاثة بلاغات فأكثر — قاعدة موثقة قابلة للضبط بقرار',
                'البلاغات بلا إحداثيات تُحسب في الإجماليات ولا تدخل الخريطة ولا المناطق — لا تخمين مواقع'
            ]
        };
    }

    // ═══════════════ H4 — دعم القرار (اعتماد المالك 2026-08-24) ═══════════════
    /**
     * H4 — توصيات تمركز مرشحة + نوافذ تستحق إعادة التوزيع + محاكاة أثر افتراضية
     * على البلاغات التاريخية. **دعم قرار فقط: لا ينفذ أي إجراء تشغيلي ولا ينقل
     * فرقة ولا يغيّر تمركزًا** — القرار لصاحبه البشري. يبني على getCoverage و
     * getPatterns (إعادة استخدام كاملة — لا اشتقاق موازٍ).
     */
    async getRecommendations(fromTs, toTs) {
        const coverage = await this.getCoverage(fromTs, toTs);
        const patterns = await this.getPatterns(fromTs, toTs);
        const R = ReportService.ANALYTICS_RULES;
        const overallAvg = coverage.responseAvgArrival;
        // محاكاة: بلاغات النطاق الواقعة ضمن نصف قطر المرشح (اشتقاق من الخام مباشرة)
        const simulate = (lat, lng) => {
            const near = coverage.incidents.filter(d => !d.noCoords &&
                this._haversineKm(lat, lng, d.lat, d.lng) <= R.SIM_RADIUS_KM);
            const respVals = near.map(d => d.bestArrivalMin).filter(v => v !== null);
            const avg = respVals.length ? Math.round(respVals.reduce((a, b) => a + b, 0) / respVals.length * 10) / 10 : null;
            return {
                radiusKm: R.SIM_RADIUS_KM,
                incidentsWithin: near.length,
                sharePct: coverage.totals.positioned ? Math.round(near.length / coverage.totals.positioned * 1000) / 10 : null,
                avgArrivalMin: avg,
                rangeAvgArrivalMin: overallAvg,
                comparison: avg === null || overallAvg === null ? 'unknown'
                    : (avg < overallAvg ? 'lower' : (avg > overallAvg ? 'higher' : 'equal'))
            };
        };
        const candidates = coverage.zones.map(z => ({
            lat: z.centroid.lat, lng: z.centroid.lng,
            basedOnIncidents: z.count,
            avgArrivalMin: z.avgArrivalMin,
            nearestHistoricalPositioningKm: z.nearestAnytimeKm,
            weakCoverage: z.weak,
            weakReasons: z.weakReasons,
            score: Math.round(z.count * (z.avgArrivalMin !== null && overallAvg ? z.avgArrivalMin / overallAvg : 1) * 100) / 100,
            simulation: simulate(z.centroid.lat, z.centroid.lng)
        })).sort((a, b) => b.score - a.score);
        // نوافذ تستحق إعادة توزيع التمركز: أعلى خلايا يوم×ساعة طلبًا في النطاق
        const matrix = patterns._matrix || [];
        const cellsList = [];
        for (let w = 0; w < 7; w++) for (let h = 0; h < 24; h++) {
            if (matrix[w] && matrix[w][h] > 0) cellsList.push({ weekday: w, hour: h, count: matrix[w][h] });
        }
        cellsList.sort((a, b) => b.count - a.count);
        return {
            range: coverage.range,
            candidates,
            suggestedWindows: cellsList.slice(0, 5),
            coverageSummary: {
                zonesCount: coverage.zones.length,
                weakZonesCount: coverage.zones.filter(z => z.weak).length,
                responseAvgArrival: overallAvg,
                positioningWindows: coverage.positioning.windowsCount
            },
            patternsSummary: {
                total: patterns.total,
                peakHour: patterns.peakHour,
                peakWeekday: patterns.peakWeekday,
                comparison: patterns.comparison
            },
            disclaimer: 'دعم قرار فقط — هذه الطبقة لا تنفذ أي إجراء تشغيلي: لا نقل فرق، لا تغيير تمركز، لا إنشاء خطط. القرار النهائي لصاحبه البشري.',
            notes: [
                'المرشحون = مراكز مناطق الطلب التاريخية (خلايا ~1.1كم بثلاثة بلاغات فأكثر) مرتبة بالطلب مضروبًا في معامل زمن الاستجابة',
                'المحاكاة تقيس فقط: كم بلاغًا تاريخيًا يقع ضمن ' + R.SIM_RADIUS_KM + 'كم من المرشح وما متوسط استجابته الفعلي مقابل متوسط النطاق — اشتقاق من الخام وليس تقديرًا نظريًا',
                'النوافذ المقترحة = أعلى خلايا (يوم × ساعة) طلبًا في النطاق من cad_created_at الفعلي'
            ]
        };
    }
}

module.exports = ReportService;
