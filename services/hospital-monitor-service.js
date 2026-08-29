/**
 * ═══ hospital-monitor-service.js — Hospital Monitor 1B (اعتماد المالك 2026-08-27) ═══
 *
 * الغرض الوحيد: تتبّع «اسم المنشأة الذي يورّده CAD حاليًا في بيانات الرحلة»
 * (incident-list → items[].lastJourneys[].hospitalName) وربطه بالرحلة عبر
 * الهوية الثابتة eventId + runUnitId (وunitId احتياطي).
 *
 * القواعد الملزمة (من اعتماد المالك — 12 قاعدة):
 *  ② ممنوع استنتاج «وصول/بدء تسليم/انتهاء تسليم» من وجود hospitalName.
 *  ③ hospitalName وjourneyStep وtimestamps ثلاث معلومات مستقلة — لا دمج دلالات.
 *  ④ الهوية الثابتة: eventId + runUnitId (unitId احتياطي)؛ unitCode وhospitalName حقول Mutable.
 *  ⑤ تغيّر unitCode (32←29) = تحديث نفس الرحلة — لا حالة جديدة.
 *  ⑥ تغيّر hospitalName = تحديث نفس الرحلة + حفظ السابقة في history.
 *  ⑦ hospitalName=null لا يمسح آخر قيمة معروفة (غياب قيمة في اللقطة فقط).
 *  ⑧ ممنوع المساس بـ report_times / isParticipationCounted / أي احتساب قائم —
 *     هذا المخزن مستقل تمامًا (مراقبة حالة فقط، ليس نظام بلاغات ثاني).
 *
 * إصلاح دورة المستشفى الكاملة (اعتماد المالك 2026-08-28 — بعد إثبات تضخم
 * زمن البقاء 238/256د على البلاغين 1321000/1320859 في الإنتاج):
 *  [1] حارس الطزاجة/الحالة: لا رفع ولا تحديث تنبيه إلا لرحلة «نشطة»
 *      (at-hospital + آخر مشاهدة خلال 30د + بلا وسم انقطاع).
 *  [2] انقطاع الرصد يوقف نمو زمن البقاء: تُعرض «آخر قيمة موثوقة» (القيمة عند
 *      آخر مشاهدة) وتُوسم — ممنوع تحويل 12د إلى 238د.
 *  [3] الإغلاق الإداري monitoring-lost (مسار اختفاء CAD في الـOverlay بعد
 *      detail أخير بلا نهاية تسليم حقيقية) — ممنوع تسجيل BACK_TO_SERVICE مختلق.
 *  [4] وصول نهاية التسليم الحقيقية لاحقًا يصحّح قيمة التنبيه ويحوّل الحلول إلى
 *      completed-late-sync ويوثّق التصحيح في Timeline (alert-dwell-corrected).
 *  [5] التنبيهات المتأثرة تُحلّ برمجيًا «monitoring-lost» وتُوسم unreliable
 *      (لا حذف ولا تعديل يدوي) وتُستبعد من النشطة والعدّادات والمتوسط — تبقى
 *      للأرشيف/التدقيق.
 *  [7] الفصل الدلالي الثلاثي من مصدر واحد (episodeClass):
 *      active / completed / monitoring-lost — «cancelled» ليس مرادفًا لإغلاق
 *      المستشفى، ولا استنتاج مدة لرحلة بلا نهاية موثوقة.
 *
 * التخزين: ملف JSON مستقل data/hospital-monitor.json
 *   current: { "eventId:runUnitId": {..آخر حالة موثوقة..} }
 *   history: append-only لكل انتقال قيمة (للتدقيق) — بلا حذف ولا تعديل، بسقف منزلق.
 *
 * زمن البقاء: لا يُشتق هنا من hospitalName إطلاقًا. يُحسب في طبقة الاستعلام
 * (server.js) من أزمنة Journey المخزنة أصلًا («بدء التسليم» ← «انتهاء التسليم»)
 * كمعرفة زمن مستقلة، ويُمرَّر لهذا المخدم كمدخل جاهز (dwellByKey).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HISTORY_CAP = 5000;   // سقف منزلق — الأقدم يخرج من الذاكرة الحية فقط عند الامتلاء
const CURRENT_CAP = 2000;   // رحلات نشطة/حديثة محتفظ بها
const ALERT_CAP = 1000;     // تنبيهات محتفظ بها (مفتاحها episodeKey+alertType — تحديث لا تكرار)
const ALERT_DWELL_MIN = 10; // حد «تجاوز زمن البقاء» المعتمد في المؤشر نفسه
// حد الطزاجة [1]: القائمة تُستطلع كل ~10ث والـOverlay يرسل نبضة حضور كل ~4د؛
// رحلة لم تُرَ منذ >30د اختفت من CAD فلا تُعامل كنشطة إطلاقًا.
const FRESH_MS = 30 * 60 * 1000;

class HospitalMonitorService {
    constructor(filePath) {
        this.file = filePath;
        this.state = null; // lazy
    }

    _load() {
        if (this.state) return this.state;
        let s = null;
        try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { s = null; }
        if (!s || typeof s !== 'object' || !s.current || typeof s.current !== 'object' || !Array.isArray(s.history)) {
            s = { current: {}, history: [] };
        }
        // دورة المستشفيات (اعتماد المالك 2026-08-28): التنبيهات تعيش داخل مخزن 1B
        // نفسه — لا مصدر حقيقة ثانٍ. ملفات ما قبل الدورة تُهيَّأ عند القراءة.
        if (!s.alerts || typeof s.alerts !== 'object' || Array.isArray(s.alerts)) s.alerts = {};
        this.state = s;
        return s;
    }

    _save() {
        const tmp = this.file + '.tmp';
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.state));
        fs.renameSync(tmp, this.file); // كتابة ذرّية — لا ملف نصف مكتوب
    }

    /** مفتاح الهوية الثابتة للرحلة: eventId + runUnitId (وunitId احتياطي بادئة u) */
    static keyOf(s) {
        const ev = s && s.eventId != null ? String(s.eventId) : null;
        if (!ev) return null;
        if (s.runUnitId != null && String(s.runUnitId) !== '') return ev + ':' + String(s.runUnitId);
        if (s.unitId != null && String(s.unitId) !== '') return ev + ':u' + String(s.unitId);
        return null;
    }

    /**
     * [2][5] تصحيح قيمة التنبيه إلى «آخر قيمة موثوقة» عند مرساة آخر مشاهدة:
     * النمو الجارٍ خطي (دقيقة بدقيقة) ← القيمة عند المرساة = القيمة عند آخر رفع
     * + (المرساة − آخر رفع). قاعدة العرض (اعتماد المالك 2026-08-29): القيمة
     * تُعرض فقط إن كانت ذات دلالة (≥ دقيقة)؛ وإلا null = «غير مقاس» — الصفر
     * ممنوع لأنه يوهم أن الرحلة لم تبقَ في المنشأة أصلًا.
     */
    static _correctDwellToAnchor(a, anchorMs) {
        if (a.dwellMin == null) return; // غير مقاسة أصلًا — تبقى كذلك
        const raisedMs = Date.parse(a.lastRaisedAt || '') || 0;
        if (anchorMs > 0 && raisedMs > 0) {
            const v = Math.round((a.dwellMin + (anchorMs - raisedMs) / 60000) * 10) / 10;
            a.dwellMin = v >= 1 ? v : null; // بلا قيمة ذات دلالة ← «غير مقاس» بصدق
        } else {
            a.dwellMin = null; // بلا مرساة موثوقة ← «غير مقاس» بصدق
        }
    }

    /**
     * [7] الفصل الدلالي الثلاثي — المصدر الوحيد للاشتقاق (اعتماد المالك
     * 2026-08-28 — إصلاح دورة المستشفى):
     *   active          = حالة حالية + رصد طازج (≤30د) ← تُحسب وتُنبَّه
     *   completed       = أُغلقت بحدث حقيقي (BACK_TO_SERVICE/نهاية موثوقة)
     *   monitoring-lost = بلا نهاية موثوقة (بالية عن الرصد أو أُغلقت إداريًا)
     *     ← لا استنتاج مدة ولا تنبيه نشط؛ تُعرض آخر قيمة موثوقة موسومة.
     */
    episodeClass(j, nowTs) {
        if (!j) return 'monitoring-lost';
        if (j.episodeState === 'last-known') return j.monitoringLost === true ? 'monitoring-lost' : 'completed';
        const now = nowTs != null ? nowTs : Date.now();
        const fresh = (Date.parse(j.lastSeenAt || '') || 0) >= now - FRESH_MS;
        return fresh ? 'active' : 'monitoring-lost';
    }

    /**
     * تطبيق مشاهدة واحدة. القاعدة ⑦: hospitalName الفارغ لا يصل هنا أصلًا
     * (يُرفض عند الحدود — الـOverlay والجسر والتحقق السيرفري).
     * الفصل الدلالي (اعتماد المالك 2026-08-27 — ما قبل النشر): المشاهدة تفتح/تحدث
     * «حالة حالية في المنشأة» (episodeState='at-hospital')؛ الإغلاق يتم عبر
     * closeEpisode فقط (عودة للخدمة) — ويبقى الاسم محفوظًا كـ«آخر منشأة معروفة».
     * نبضة الحضور (إصلاح [2]): الـOverlay يعيد إرسال المشاهدة نفسها كل ~4د للرحلة
     * الظاهرة غير المتغيّرة — lastSeenAt هنا يعني «آخر تأكيد حضور في قائمة CAD»
     * وليس «آخر تغيّر قيمة»، وعليه يُبنى حد الطزاجة [1].
     * @param shiftId ختم ملكية المناوبة — يُشتق سيرفريًا من getActiveShift لحظة
     *   الاستدعاء ولا يُقبل من العميل إطلاقًا (اعتماد المالك 2026-08-28، قرار ②أ):
     *   الرحلة تُختم بمناوبة أول مشاهدة، وإن عبرت مناوبة ثانية تبقى ملكًا للأولى.
     *   بلا مناوبة نشطة ← null بصدق؛ وإن وُخت سابقًا null ثم ظهرت مناوبة نشطة في
     *   مشاهدة لاحقة يُستكمل الختم (لا اختراع مناوبة — استكمال لواقع موجود).
     * @returns {{changed:boolean, kind:string, key:string|null}}
     */
    applySighting(s, nowIso, shiftId) {
        const st = this._load();
        const key = HospitalMonitorService.keyOf(s);
        if (!key) return { changed: false, kind: 'no-identity', key: null };
        const now = nowIso || new Date().toISOString();
        const sid = (shiftId != null && shiftId !== '') ? Number(shiftId) : null;
        const hn = String(s.hospitalName).trim();
        const code = s.unitCode != null ? String(s.unitCode) : null;
        const step = s.journeyStepCode ? String(s.journeyStepCode) : null; // تتبع فقط — قاعدة ③
        const southTeam = s.southTeam != null ? String(s.southTeam).slice(0, 100) : null;
        let cur = st.current[key];
        let kind = 'seen';
        if (!cur) {
            cur = st.current[key] = {
                eventId: String(s.eventId),
                unitId: s.unitId != null ? String(s.unitId) : null,
                runUnitId: s.runUnitId != null ? String(s.runUnitId) : null,
                unitCode: code, southTeam,
                hospitalName: hn,
                episodeState: 'at-hospital', episodeClosedAt: null,
                journeyStepCode: step,
                shiftId: sid, // ملكية المناوبة — ختم سيرفي عند أول مشاهدة
                firstSeenAt: now, lastSeenAt: now, updatedAt: now
            };
            st.history.push({ at: now, key, field: 'hospitalName', from: null, to: hn, unitCode: code });
            kind = 'created';
        } else {
            if (cur.hospitalName !== hn) { // قاعدة ⑥: تحديث نفس الرحلة + حفظ السابقة
                st.history.push({ at: now, key, field: 'hospitalName', from: cur.hospitalName, to: hn, unitCode: code });
                cur.hospitalName = hn;
                cur.updatedAt = now;
                kind = 'hospital-change';
            }
            if (code && cur.unitCode !== code) { // قاعدة ⑤: الرمز متغيّر — نفس الرحلة
                st.history.push({ at: now, key, field: 'unitCode', from: cur.unitCode, to: code, unitCode: code });
                cur.unitCode = code;
                cur.updatedAt = now;
                if (kind === 'seen') kind = 'unitcode-change';
            }
            if (southTeam && cur.southTeam !== southTeam) cur.southTeam = southTeam;
            // استكمال ختم الملكية إن وُخت الرحلة بلا مناوبة نشطة ثم ظهرت مناوبة
            if (cur.shiftId == null && sid != null) cur.shiftId = sid;
            if (cur.episodeState === 'last-known') { // CAD أعاد قيمة لنفس الرحلة ← إعادة فتح موثقة
                st.history.push({ at: now, key, field: 'episode', from: 'last-known', to: 'at-hospital', step, unitCode: code });
                cur.episodeState = 'at-hospital';
                cur.episodeClosedAt = null;
                cur.monitoringLost = false; // الرصد عاد فعلًا — وسم الانقطاع يسقط
                cur.updatedAt = now;
                if (kind === 'seen') kind = 'episode-reopened';
            }
            if (step) cur.journeyStepCode = step;
            cur.lastSeenAt = now; // نبضة حضور أو تغيّر — كلاهما «شوهدت الآن»
        }
        // سقوف منزلقة
        if (st.history.length > HISTORY_CAP) st.history.splice(0, st.history.length - HISTORY_CAP);
        const keys = Object.keys(st.current);
        if (keys.length > CURRENT_CAP) {
            const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // أسبوع
            for (const k of keys) {
                const c = st.current[k];
                if (c && Date.parse(c.lastSeenAt || '') < cutoff) delete st.current[k];
            }
        }
        this._save();
        return { changed: kind !== 'seen', kind, key };
    }

    /**
     * إغلاق «الحالة الحالية». لا يمسح الاسم: يتحول من «حاليًا في المنشأة» إلى
     * «آخر منشأة معروفة». إشارة الإغلاق لا تُنشئ حالة أبدًا (لا episode بلا
     * مشاهدة اسم سابقة).
     * @param resolution (إصلاح [3]):
     *   'back-to-service' (افتراضي) = حدث حقيقي وصل من CAD — عودة للخدمة أو
     *     نهاية تسليم موثقة في detail الأخير.
     *   'monitoring-lost' = إغلاق إداري: اختفى البلاغ من قائمة CAD ولم يُوجد
     *     في detail الأخير أي نهاية تسليم حقيقية — ممنوع تسجيل BACK_TO_SERVICE
     *     مختلق؛ تُوسم الرحلة monitoringLost=true ويُحلّ تنبيهها «غير موثوق»
     *     بعد تصحيح قيمته إلى لحظة آخر مشاهدة.
     */
    closeEpisode(s, nowIso, shiftId, resolution) {
        const st = this._load();
        const key = HospitalMonitorService.keyOf(s);
        if (!key) return { changed: false, kind: 'no-identity', key: null };
        const now = nowIso || new Date().toISOString();
        const cur = st.current[key];
        if (!cur || !cur.hospitalName) return { changed: false, kind: 'close-without-episode', key };
        // استكمال ختم الملكية إن وُخت بلا مناوبة نشطة (نفس قاعدة applySighting) —
        // الملكية المختومة لا تُنقل ولا تتغير عند الإغلاق (قرار ②أ)
        if (cur.shiftId == null && shiftId != null && shiftId !== '') cur.shiftId = Number(shiftId);
        if (cur.episodeState === 'last-known') { cur.lastSeenAt = now; this._save(); return { changed: false, kind: 'already-closed', key }; }
        const monLost = resolution === 'monitoring-lost';
        // مرساة التصحيح [2][5]: لحظة آخر مشاهدة فعلية قبل ختم الإغلاق — قيمة
        // البقاء لا يجوز أن تتجاوزها عند انقطاع الرصد.
        const prevLastSeenMs = Date.parse(cur.lastSeenAt || '') || 0;
        const code = s.unitCode != null ? String(s.unitCode) : cur.unitCode;
        st.history.push({ at: now, key, field: 'episode', from: 'at-hospital', to: 'last-known',
            step: monLost ? 'MONITORING_LOST' : (s.journeyStepCode ? String(s.journeyStepCode) : null), unitCode: code });
        cur.episodeState = 'last-known';
        cur.episodeClosedAt = now;
        if (monLost) cur.monitoringLost = true;
        if (code) cur.unitCode = code;
        // الإغلاق الحقيقي (BACK_TO_SERVICE وصل من CAD) = مشاهدة فعلية ← يحدّث
        // lastSeenAt. أما الإغلاق الإداري (monitoring-lost) فليس مشاهدة: يبقى
        // lastSeenAt عند آخر حضور فعلي في القائمة — هو مرساة «آخر قيمة موثوقة»
        // [2] ولا يجوز أن يتقدم بلحظة كشف الاختفاء.
        if (!monLost) cur.lastSeenAt = now;
        cur.updatedAt = now;
        // دورة التنبيه (اعتماد المالك 2026-08-28): الإغلاق يحلّ تنبيهات الحالة.
        // الحدث التشغيلي الصحيح (BACK_TO_SERVICE/نهاية موثقة) أو الإداري
        // (monitoring-lost) — لا حلول بصمت ولا بقاء تنبيه ينمو بلا رصد.
        this._resolveAlertsForKey(st, key, now, monLost ? 'monitoring-lost' : 'back-to-service', prevLastSeenMs);
        if (st.history.length > HISTORY_CAP) st.history.splice(0, st.history.length - HISTORY_CAP);
        this._save();
        return { changed: true, kind: monLost ? 'episode-closed-monitoring-lost' : 'episode-closed', key };
    }

    /** رحلات ضمن نافذة زمنية (lastSeenAt ≥ from وfirstSeenAt ≤ to) — ms timestamps */
    journeysInWindow(fromTs, toTs) {
        const st = this._load();
        const out = [];
        for (const k of Object.keys(st.current)) {
            const c = st.current[k];
            if (!c || !c.hospitalName) continue;
            const first = Date.parse(c.firstSeenAt || '') || 0;
            const last = Date.parse(c.lastSeenAt || '') || 0;
            if (fromTs != null && last < fromTs) continue;
            if (toTs != null && first > toTs) continue;
            out.push({ key: k, ...c });
        }
        return out;
    }

    /**
     * رحلات مناوبة محددة (اعتماد المالك 2026-08-28): المختومة بـ shiftId تطابقه
     * حرفيًا — حتى لو عبرت مناوبة ثانية (قرار ②أ: الملكية لمناوبة المنشأ). السجلات
     * القديمة بلا ختم (shiftId=null، ما قبل الدورة) تُنسب بالنافذة الزمنية سقوطًا
     * صادقًا. الرحلات المختومة بمناوبة أخرى تُستبعد دائمًا — لا ازدواجية أرشيف.
     * كل رحلة تُرفق بـ episodeClass المشتق لحظة الاستعلام [7] — الواجهة عرض فقط.
     */
    journeysForShift(shiftId, fromTs, toTs) {
        const sid = Number(shiftId);
        const now = Date.now();
        return this.journeysInWindow(fromTs, toTs)
            .filter(j => j.shiftId != null ? Number(j.shiftId) === sid : true)
            .map(j => ({ ...j, episodeClass: this.episodeClass(j, now) }));
    }

    // ════════════════════════════════════════════════════════════════════════
    // دورة التنبيهات (اعتماد المالك 2026-08-28) — داخل مخزن 1B نفسه، بلا مصدر
    // حقيقة ثانٍ. الهوية المنطقية: episodeKey + alertType ← تحديث في المكان،
    // لا نسخة جديدة مع كل تحديث SSE. الدورة: open → acknowledged → resolved.
    // الحلول يكون بالحدث التشغيلي الصحيح (closeEpisode) أو بحلول الانقطاع
    // الإداري (monitoring-lost) — لا تنبيه ينمو بلا رصد [1][2][5].
    // ════════════════════════════════════════════════════════════════════════

    /**
     * تقييم تنبيهات «تجاوز زمن البقاء» لمجموعة رحلات. dwellByKey محسوب خارجيًا
     * من أزمنة Journey (قراءة فقط — قاعدة ⑧). يُرجع معرّفات التنبيهات التي
     * تغيّرت فعلًا (skip-if-unchanged: لا كتابة ملف ولا بث عند الثبات).
     * يشمل ثلاثة واجبات مترابطة (إصلاح دورة المستشفى):
     *  [1] الرفع/التحديث لرحلة «نشطة» فقط (at-hospital + طازجة + بلا انقطاع).
     *  [5] مصالحة الانقطاع: كل تنبيه غير محلول رحلته لم تعد نشطة يُحلّ
     *      «monitoring-lost» ويُوسم unreliable وتُصحَّح قيمته إلى آخر مشاهدة.
     *  [4] وصول نهاية حقيقية لاحقًا (dwell مكتمل ongoing=false) لتنبيه محلول
     *      بالانقطاع ← قيمة حقيقية + completed-late-sync + توثيق في history.
     */
    evaluateAlerts(dwellByKey, nowIso, shiftId) {
        const st = this._load();
        const now = nowIso || new Date().toISOString();
        const nowMs = Date.parse(now) || Date.now();
        const changed = [];
        // «نشطة» = حالة حالية في المنشأة + رصد طازج + بلا وسم انقطاع إداري
        const isActive = (cur) => !!(cur && cur.hospitalName &&
            cur.episodeState === 'at-hospital' && cur.monitoringLost !== true &&
            (Date.parse(cur.lastSeenAt || '') || 0) >= nowMs - FRESH_MS);
        for (const key of Object.keys(dwellByKey || {})) {
            const d = dwellByKey[key];
            const cur = st.current[key];
            if (!isActive(cur)) continue; // [1] لا تنبيه لرحلة بالية/مغلقة/منقطعة
            if (!d || d.dwellMin == null || d.dwellMin <= ALERT_DWELL_MIN) continue;
            const id = key + '|dwell-exceed';
            let a = st.alerts[id];
            if (!a) {
                a = st.alerts[id] = {
                    id, key, type: 'dwell-exceed', state: 'open',
                    shiftId: shiftId != null ? Number(shiftId) : (cur.shiftId != null ? Number(cur.shiftId) : null),
                    eventId: cur.eventId, unitCode: cur.unitCode,
                    southTeam: cur.southTeam || null, facility: cur.hospitalName,
                    dwellMin: d.dwellMin, ongoing: !!d.ongoing,
                    firstRaisedAt: now, lastRaisedAt: now, updates: 0,
                    ackAt: null, ackBy: null, ackByName: null,
                    resolvedAt: null, resolution: null, unreliable: false
                };
                changed.push(id);
            } else if (a.state === 'resolved') {
                // إعادة فتح موثقة للحالة (CAD أعاد قيمة لنفس الرحلة) ← التنبيه
                // يعود open بنفس الهوية المنطقية — لا نسخة جديدة ولا تنبيه يتيم
                if (cur.episodeState === 'at-hospital') {
                    a.state = 'open'; a.resolvedAt = null; a.resolution = null;
                    a.unreliable = false; // رصد حي جديد — القيم القادمة موثوقة
                    a.dwellMin = d.dwellMin; a.ongoing = !!d.ongoing;
                    a.facility = cur.hospitalName; a.unitCode = cur.unitCode;
                    a.lastRaisedAt = now; a.updates++;
                    changed.push(id);
                }
            } else if (a.state !== 'resolved') {
                // تحديث في المكان — وفقط عند تغيّر فعلي (قيمة البقاء/المنشأة/الرمز)
                const dwellChanged = a.dwellMin !== d.dwellMin || a.ongoing !== !!d.ongoing;
                const facChanged = a.facility !== cur.hospitalName || a.unitCode !== cur.unitCode;
                if (dwellChanged || facChanged) {
                    a.dwellMin = d.dwellMin; a.ongoing = !!d.ongoing;
                    a.facility = cur.hospitalName; a.unitCode = cur.unitCode;
                    a.lastRaisedAt = now; a.updates++;
                    changed.push(id);
                }
                // الحالة المُقَرَّة (acknowledged) لا تعود open — الإقرار يبقى محفوظًا
            }
        }
        // [5] مصالحة الانقطاع — مسح كل التنبيهات غير المحلولة: رحلة مفقودة أو
        // بالية عن الرصد (>30د بلا مشاهدة/نبضة) أو مُغلقة إداريًا ← حلول
        // «monitoring-lost» برمجي موثق (لا حذف ولا تعديل يدوي)، مع إعادة القيمة
        // إلى ما كانت عليه عند آخر مشاهدة — لا يبقى تنبيه ينتفخ بعد اختفاء CAD.
        for (const id of Object.keys(st.alerts)) {
            const a = st.alerts[id];
            if (!a || a.state === 'resolved') continue;
            const cur = st.current[a.key];
            if (isActive(cur)) continue; // نشطة طازجة — يديرها منطق الرفع أعلاه
            const anchorMs = cur ? (Date.parse(cur.lastSeenAt || '') || 0) : 0;
            a.state = 'resolved';
            a.resolvedAt = now;
            a.resolution = 'monitoring-lost';
            a.unreliable = true;
            HospitalMonitorService._correctDwellToAnchor(a, anchorMs);
            changed.push(id);
        }
        // [4] وصول نهاية التسليم الحقيقية لاحقًا (detail أخير/إثراء متأخر جلب
        // «انتهاء التسليم» لرحلة أُغلقت انقطاعًا): القيمة الحقيقية تحل محل
        // التقدير، والوسم يتحول إلى completed-late-sync، ويُوثَّق التصحيح في
        // history ← يظهر في Timeline الرحلة تلقائيًا.
        for (const key of Object.keys(dwellByKey || {})) {
            const d = dwellByKey[key];
            if (!d || d.dwellMin == null || d.ongoing) continue; // نهاية حقيقية فقط
            const id = key + '|dwell-exceed';
            const a = st.alerts[id];
            if (!a || a.state !== 'resolved' || a.resolution !== 'monitoring-lost') continue;
            if (a.dwellMin === d.dwellMin && a.unreliable !== true) continue; // صُحّح سابقًا
            st.history.push({ at: now, key, field: 'alert-dwell-corrected', from: a.dwellMin, to: d.dwellMin, unitCode: a.unitCode || null });
            a.dwellMin = d.dwellMin;
            a.unreliable = false;
            a.resolution = 'completed-late-sync';
            changed.push(id);
        }
        // سقف منزلق: الأقدم حلًّا/رفعًا يخرج أولًا
        const ids = Object.keys(st.alerts);
        if (ids.length > ALERT_CAP) {
            const sorted = ids.sort((x, y) => String(st.alerts[x].firstRaisedAt).localeCompare(String(st.alerts[y].firstRaisedAt)));
            for (const id of sorted.slice(0, ids.length - ALERT_CAP)) delete st.alerts[id];
        }
        // لا تكرار في المُعاد: التنبيه الواحد قد يتحرك في المصالحة [5] ثم في
        // التصحيح المتأخر [4] ضمن التكة نفسها (اعتماد المالك 2026-08-29)
        const uniq = Array.from(new Set(changed));
        if (uniq.length) this._save();
        return uniq;
    }

    /**
     * حلّ تنبيهات رحلة عند إغلاق حالتها (يُستدعى من closeEpisode فقط).
     * @param anchorMs لحظة آخر مشاهدة فعلية — مرساة تصحيح القيمة عند الحلول
     *   الإداري (monitoring-lost): أي انتفاخ بعد آخر مشاهدة يُخصم [2][5]،
     *   وبلا قيمة ذات دلالة ← «غير مقاس» (null) لا صفر (اعتماد المالك 2026-08-29).
     */
    _resolveAlertsForKey(st, key, now, resolution, anchorMs) {
        let touched = false;
        for (const id of Object.keys(st.alerts)) {
            const a = st.alerts[id];
            if (a.key !== key || a.state === 'resolved') continue;
            a.state = 'resolved';
            a.resolvedAt = now;
            a.resolution = resolution || 'episode-closed';
            if (a.resolution === 'monitoring-lost') {
                a.unreliable = true;
                HospitalMonitorService._correctDwellToAnchor(a, anchorMs || 0);
            }
            touched = true;
        }
        return touched;
    }

    /**
     * إقرار تنبيه (ACK). يمنع ACK الوهمي (غير موجود ← 404) وإقرار المحلول
     * (409)، وإقرار المُقَرّ مسبقًا idempotent (changed:false بلا كتابة).
     * يحفظ وقت الإقرار وهوية المستخدم من جلسة المصادقة الحالية.
     */
    ackAlert(id, user, nowIso) {
        const st = this._load();
        const a = st.alerts[id];
        if (!a) return { ok: false, code: 404, error: 'التنبيه غير موجود' };
        if (a.state === 'resolved') return { ok: false, code: 409, error: 'التنبيه محلول — لا يُقرّ' };
        if (a.state === 'acknowledged') return { ok: true, changed: false, alert: { ...a } };
        a.state = 'acknowledged';
        a.ackAt = nowIso || new Date().toISOString();
        a.ackBy = user && user.id != null ? String(user.id) : null;
        a.ackByName = user && (user.name || user.username) ? String(user.name || user.username) : null;
        this._save();
        return { ok: true, changed: true, alert: { ...a } };
    }

    /** تنبيهات رُفعت ضمن نافذة (firstRaisedAt داخلها) — للوحة المناوبة الحية */
    alertsInWindow(fromTs, toTs) {
        const st = this._load();
        const out = [];
        for (const id of Object.keys(st.alerts)) {
            const a = st.alerts[id];
            const t = Date.parse(a.firstRaisedAt || '') || 0;
            if (fromTs != null && t < fromTs) continue;
            if (toTs != null && t > toTs) continue;
            out.push({ ...a });
        }
        return out.sort((x, y) => String(y.firstRaisedAt).localeCompare(String(x.firstRaisedAt)));
    }

    /** تنبيهات مجموعة رحلات بمفاتيحها — لختم الأرشيف (قرار ②أ: تبعية الرحلة) */
    alertsForKeys(keys) {
        const st = this._load();
        const set = new Set(keys || []);
        return Object.keys(st.alerts)
            .filter(id => set.has(st.alerts[id].key))
            .map(id => ({ ...st.alerts[id] }))
            .sort((x, y) => String(x.firstRaisedAt).localeCompare(String(y.firstRaisedAt)));
    }

    /**
     * Timeline رحلات: أحداث history (append-only) + أحداث دورة التنبيه
     * (رفع/إقرار/حلول) مدموجة بالترتيب الزمني الحقيقي — بلا تخزين إضافي:
     * تُشتق من سجلَّي history وalerts الموجودين أصلًا (اعتماد المالك 2026-08-28:
     * التنبيه حدث في Timeline المناوبة، لا جدولًا جانبيًا فقط). أحداث تصحيح
     * القيمة (alert-dwell-corrected — إصلاح [4]) تدخل من history تلقائيًا.
     */
    timelineForKeys(keys) {
        const st = this._load();
        const set = new Set(keys || []);
        const out = [];
        for (const h of st.history) if (set.has(h.key)) out.push({ ...h });
        for (const id of Object.keys(st.alerts)) {
            const a = st.alerts[id];
            if (!set.has(a.key)) continue;
            out.push({ at: a.firstRaisedAt, key: a.key, field: 'alert', alert: 'raised', dwellMin: a.dwellMin, facility: a.facility, unreliable: a.unreliable === true });
            if (a.ackAt) out.push({ at: a.ackAt, key: a.key, field: 'alert', alert: 'acknowledged', actor: a.ackByName || null });
            if (a.resolvedAt) out.push({ at: a.resolvedAt, key: a.key, field: 'alert', alert: 'resolved', to: a.resolution });
        }
        return out.sort((x, y) => String(x.at).localeCompare(String(y.at)));
    }

    /** تاريخ التغييرات لرحلة (للتدقيق) */
    historyFor(key) {
        return this._load().history.filter(h => h.key === key);
    }

    /**
     * ملخص المؤشر: تجميع بحسب المنشأة الحالية.
     * @param dwellByKey خريطة key ← { dwellMin, ongoing } محسوبة خارجيًا من أزمنة
     *   Journey (معرفة الزمن المستقلة) — الرحلات بلا أزمنة تُحتسب في العدد وتُستبعد
     *   من المتوسط بصدق (unmeasured).
     * الفصل الدلالي [7]: active (نراها ونحسبها) / completed (نهاية موثوقة) /
     * monitoring-lost (بلا نهاية موثوقة ← لا استنتاج مدة: تُستبعد من المتوسط
     * والتجاوزات والجَرَيان، وتُعرض «آخر قيمة موثوقة» موسومة عند توفرها [2]).
     */
    summarize(fromTs, toTs, dwellByKey, nowTs) {
        return this.summarizeJourneys(this.journeysInWindow(fromTs, toTs), dwellByKey, nowTs);
    }

    /**
     * التجميع نفسه فوق مجموعة رحلات محددة مسبقًا — يستخدمه جامع الأرشيف لختم
     * ملخص «رحلات المناوبة المملوكة لها» (قرار ②أ) بدل نافذة زمنية فضفاضة.
     * لا تغيير في منطق الحساب: نفس قواعد الطزاجة والفصل الدلالي أدناه.
     */
    summarizeJourneys(journeys, dwellByKey, nowTs) {
        const dwell = dwellByKey || {};
        const now = nowTs != null ? nowTs : Date.now();
        const byFac = {};
        let dwellSum = 0, dwellN = 0, exceed = 0, unmeasured = 0, ongoing = 0;
        let currentAtHospital = 0, lastKnownOnly = 0, monitoringLost = 0;
        for (const j of journeys) {
            const fac = j.hospitalName;
            // [7] الفصل الدلالي الثلاثي من المصدر الوحيد
            const cls = this.episodeClass(j, now);
            if (cls === 'active') currentAtHospital++;
            else if (cls === 'monitoring-lost') monitoringLost++;
            else lastKnownOnly++;
            const d = dwell[j.key];
            const f = byFac[fac] = byFac[fac] || { facility: fac, cases: 0, dwellSum: 0, dwellN: 0, exceedances: 0, ongoing: 0, unmeasured: 0, monitoringLost: 0, journeys: [] };
            f.cases++;
            if (cls === 'monitoring-lost') f.monitoringLost++;
            const row = { key: j.key, eventId: j.eventId, unitCode: j.unitCode, southTeam: j.southTeam || null,
                episodeState: cls === 'active' ? 'at-hospital' : (cls === 'monitoring-lost' ? 'monitoring-lost' : 'last-known'),
                episodeClass: cls, monitoringLost: cls === 'monitoring-lost',
                dwellMin: null, ongoing: false };
            // البقاء يدخل الإحصاء فقط: مكتمل بنهاية حقيقية (ongoing=false — حتى
            // لو وصلت متأخرة لرحلة انقطع رصدها [4])، أو جارٍ لرحلة نشطة طازجة.
            const usable = d && d.dwellMin != null && (!d.ongoing || cls === 'active');
            if (usable) {
                row.dwellMin = d.dwellMin; row.ongoing = !!d.ongoing;
                f.dwellSum += d.dwellMin; f.dwellN++;
                dwellSum += d.dwellMin; dwellN++;
                if (d.ongoing) { f.ongoing++; ongoing++; }
                if (d.dwellMin > 10) { f.exceedances++; exceed++; }
            } else if (d && d.dwellMin != null && d.ongoing && cls === 'monitoring-lost') {
                // [2] آخر قيمة موثوقة: البقاء الجارٍ عند انقطاع الرصد يُعرض
                // كما كان لحظة آخر مشاهدة (القيمة الحالية ناقص مدة الانقطاع) —
                // ممنوع النمو بعد الاختفاء — ويُستبعد من المتوسط والتجاوزات.
                const lastSeenMs = Date.parse(j.lastSeenAt || '') || 0;
                const capped = Math.round((d.dwellMin - (now - lastSeenMs) / 60000) * 10) / 10;
                row.dwellMin = capped >= 1 ? capped : null; // «غير مقاس» — الصفر ممنوع (اعتماد المالك 2026-08-29)
                row.dwellCapped = row.dwellMin != null;
                f.unmeasured++; unmeasured++;
            } else { f.unmeasured++; unmeasured++; }
            f.journeys.push(row);
        }
        const facilities = Object.values(byFac).map(f => ({
            facility: f.facility, cases: f.cases,
            avgDwellMin: f.dwellN ? Math.round((f.dwellSum / f.dwellN) * 10) / 10 : null,
            exceedances: f.exceedances, ongoing: f.ongoing, unmeasured: f.unmeasured, monitoringLost: f.monitoringLost,
            journeys: f.journeys.sort((a, b) => (b.dwellMin || -1) - (a.dwellMin || -1))
        })).sort((a, b) => b.cases - a.cases);
        return {
            totalTransferred: journeys.length,
            currentAtHospital, lastKnownOnly, monitoringLost,
            avgDwellMin: dwellN ? Math.round((dwellSum / dwellN) * 10) / 10 : null,
            exceedances: exceed, ongoing, unmeasured,
            facilities
        };
    }
}

module.exports = { HospitalMonitorService };
