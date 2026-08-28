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
     * تطبيق مشاهدة واحدة. القاعدة ⑦: hospitalName الفارغ لا يصل هنا أصلًا
     * (يُرفض عند الحدود — الـOverlay والجسر والتحقق السيرفري).
     * الفصل الدلالي (اعتماد المالك 2026-08-27 — ما قبل النشر): المشاهدة تفتح/تحدث
     * «حالة حالية في المنشأة» (episodeState='at-hospital')؛ الإغلاق يتم عبر
     * closeEpisode فقط (عودة للخدمة) — ويبقى الاسم محفوظًا كـ«آخر منشأة معروفة».
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
                cur.updatedAt = now;
                if (kind === 'seen') kind = 'episode-reopened';
            }
            if (step) cur.journeyStepCode = step;
            cur.lastSeenAt = now;
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
     * إغلاق «الحالة الحالية» عند عودة الوحدة للخدمة (BACK_TO_SERVICE — معرفة
     * المرحلة المستقلة، لا استنتاج من hospitalName). لا يمسح الاسم: يتحول من
     * «حاليًا في المنشأة» إلى «آخر منشأة معروفة». إشارة الإغلاق لا تُنشئ حالة
     * أبدًا (لا episode بلا مشاهدة اسم سابقة).
     */
    closeEpisode(s, nowIso, shiftId) {
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
        const code = s.unitCode != null ? String(s.unitCode) : cur.unitCode;
        st.history.push({ at: now, key, field: 'episode', from: 'at-hospital', to: 'last-known', step: s.journeyStepCode ? String(s.journeyStepCode) : null, unitCode: code });
        cur.episodeState = 'last-known';
        cur.episodeClosedAt = now;
        if (code) cur.unitCode = code;
        cur.lastSeenAt = now;
        cur.updatedAt = now;
        // دورة التنبيه (اعتماد المالك 2026-08-28): الإغلاق يعتمد الحدث التشغيلي
        // الصحيح (BACK_TO_SERVICE وصل هنا فعلًا) — لا اختفاء الرحلة من قائمة CAD.
        this._resolveAlertsForKey(st, key, now, 'back-to-service');
        if (st.history.length > HISTORY_CAP) st.history.splice(0, st.history.length - HISTORY_CAP);
        this._save();
        return { changed: true, kind: 'episode-closed', key };
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
     */
    journeysForShift(shiftId, fromTs, toTs) {
        const sid = Number(shiftId);
        return this.journeysInWindow(fromTs, toTs).filter(j =>
            j.shiftId != null ? Number(j.shiftId) === sid : true);
    }

    // ════════════════════════════════════════════════════════════════════════
    // دورة التنبيهات (اعتماد المالك 2026-08-28) — داخل مخزن 1B نفسه، بلا مصدر
    // حقيقة ثانٍ. الهوية المنطقية: episodeKey + alertType ← تحديث في المكان،
    // لا نسخة جديدة مع كل تحديث SSE. الدورة: open → acknowledged → resolved.
    // الحلول يكون بالحدث التشغيلي الصحيح (BACK_TO_SERVICE عبر closeEpisode) —
    // لا يُحلّ تنبيه لمجرد اختفاء الرحلة من قائمة CAD.
    // ════════════════════════════════════════════════════════════════════════

    /**
     * تقييم تنبيهات «تجاوز زمن البقاء» لمجموعة رحلات. dwellByKey محسوب خارجيًا
     * من أزمنة Journey (قراءة فقط — قاعدة ⑧). يُرجع معرّفات التنبيهات التي
     * تغيّرت فعلًا (skip-if-unchanged: لا كتابة ملف ولا بث عند الثبات).
     */
    evaluateAlerts(dwellByKey, nowIso, shiftId) {
        const st = this._load();
        const now = nowIso || new Date().toISOString();
        const changed = [];
        for (const key of Object.keys(dwellByKey || {})) {
            const d = dwellByKey[key];
            const cur = st.current[key];
            if (!cur || !cur.hospitalName) continue;
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
                    resolvedAt: null, resolution: null
                };
                changed.push(id);
            } else if (a.state === 'resolved') {
                // إعادة فتح موثقة للحالة (CAD أعاد قيمة لنفس الرحلة) ← التنبيه
                // يعود open بنفس الهوية المنطقية — لا نسخة جديدة ولا تنبيه يتيم
                if (cur.episodeState === 'at-hospital') {
                    a.state = 'open'; a.resolvedAt = null; a.resolution = null;
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
        // سقف منزلق: الأقدم حلًّا/رفعًا يخرج أولًا
        const ids = Object.keys(st.alerts);
        if (ids.length > ALERT_CAP) {
            const sorted = ids.sort((x, y) => String(st.alerts[x].firstRaisedAt).localeCompare(String(st.alerts[y].firstRaisedAt)));
            for (const id of sorted.slice(0, ids.length - ALERT_CAP)) delete st.alerts[id];
        }
        if (changed.length) this._save();
        return changed;
    }

    /** حلّ تنبيهات رحلة عند إغلاق حالتها (يُستدعى من closeEpisode فقط) */
    _resolveAlertsForKey(st, key, now, resolution) {
        let touched = false;
        for (const id of Object.keys(st.alerts)) {
            const a = st.alerts[id];
            if (a.key !== key || a.state === 'resolved') continue;
            a.state = 'resolved';
            a.resolvedAt = now;
            a.resolution = resolution || 'episode-closed';
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
     * التنبيه حدث في Timeline المناوبة، لا جدولًا جانبيًا فقط).
     */
    timelineForKeys(keys) {
        const st = this._load();
        const set = new Set(keys || []);
        const out = [];
        for (const h of st.history) if (set.has(h.key)) out.push({ ...h });
        for (const id of Object.keys(st.alerts)) {
            const a = st.alerts[id];
            if (!set.has(a.key)) continue;
            out.push({ at: a.firstRaisedAt, key: a.key, field: 'alert', alert: 'raised', dwellMin: a.dwellMin, facility: a.facility });
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
     * الفصل الدلالي: «حاليًا في المنشأة» (episodeState='at-hospital') ≠ «آخر منشأة
     *   معروفة» (last-known). البقاء الجارٍ (ongoing) يُحتسب فقط لحالة حالية
     *   وطازجة (آخر مشاهدة خلال 30 دقيقة — القائمة تُستطلع كل ~10ث، والأقدم من
     *   ذلك اختفى من القائمة فلا يُعامل كجارٍ). حالة مغلقة بلا وقت انتهاء
     *   تسليم ← unmeasured بصدق — لا تجميد زمن بتخمين.
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
        const FRESH_MS = 30 * 60 * 1000;
        const byFac = {};
        let dwellSum = 0, dwellN = 0, exceed = 0, unmeasured = 0, ongoing = 0;
        let currentAtHospital = 0, lastKnownOnly = 0;
        for (const j of journeys) {
            const fac = j.hospitalName;
            const isCurrent = j.episodeState !== 'last-known';
            const fresh = (Date.parse(j.lastSeenAt || '') || 0) >= now - FRESH_MS;
            if (isCurrent && fresh) currentAtHospital++; else lastKnownOnly++;
            const d = dwell[j.key];
            const f = byFac[fac] = byFac[fac] || { facility: fac, cases: 0, dwellSum: 0, dwellN: 0, exceedances: 0, ongoing: 0, unmeasured: 0, journeys: [] };
            f.cases++;
            const row = { key: j.key, eventId: j.eventId, unitCode: j.unitCode, southTeam: j.southTeam || null,
                episodeState: isCurrent ? 'at-hospital' : 'last-known', dwellMin: null, ongoing: false };
            // البقاء الجارٍ يُقبل فقط لحالة حالية طازجة؛ المغلقة/القديمة بلا وقت انتهاء ← unmeasured
            const usable = d && d.dwellMin != null && (!d.ongoing || (isCurrent && fresh));
            if (usable) {
                row.dwellMin = d.dwellMin; row.ongoing = !!d.ongoing;
                f.dwellSum += d.dwellMin; f.dwellN++;
                dwellSum += d.dwellMin; dwellN++;
                if (d.ongoing) { f.ongoing++; ongoing++; }
                if (d.dwellMin > 10) { f.exceedances++; exceed++; }
            } else { f.unmeasured++; unmeasured++; }
            f.journeys.push(row);
        }
        const facilities = Object.values(byFac).map(f => ({
            facility: f.facility, cases: f.cases,
            avgDwellMin: f.dwellN ? Math.round((f.dwellSum / f.dwellN) * 10) / 10 : null,
            exceedances: f.exceedances, ongoing: f.ongoing, unmeasured: f.unmeasured,
            journeys: f.journeys.sort((a, b) => (b.dwellMin || -1) - (a.dwellMin || -1))
        })).sort((a, b) => b.cases - a.cases);
        return {
            totalTransferred: journeys.length,
            currentAtHospital, lastKnownOnly,
            avgDwellMin: dwellN ? Math.round((dwellSum / dwellN) * 10) / 10 : null,
            exceedances: exceed, ongoing, unmeasured,
            facilities
        };
    }
}

module.exports = { HospitalMonitorService };
