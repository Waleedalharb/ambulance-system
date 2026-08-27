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
     * @returns {{changed:boolean, kind:string, key:string|null}}
     */
    applySighting(s, nowIso) {
        const st = this._load();
        const key = HospitalMonitorService.keyOf(s);
        if (!key) return { changed: false, kind: 'no-identity', key: null };
        const now = nowIso || new Date().toISOString();
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
    closeEpisode(s, nowIso) {
        const st = this._load();
        const key = HospitalMonitorService.keyOf(s);
        if (!key) return { changed: false, kind: 'no-identity', key: null };
        const now = nowIso || new Date().toISOString();
        const cur = st.current[key];
        if (!cur || !cur.hospitalName) return { changed: false, kind: 'close-without-episode', key };
        if (cur.episodeState === 'last-known') { cur.lastSeenAt = now; this._save(); return { changed: false, kind: 'already-closed', key }; }
        const code = s.unitCode != null ? String(s.unitCode) : cur.unitCode;
        st.history.push({ at: now, key, field: 'episode', from: 'at-hospital', to: 'last-known', step: s.journeyStepCode ? String(s.journeyStepCode) : null, unitCode: code });
        cur.episodeState = 'last-known';
        cur.episodeClosedAt = now;
        if (code) cur.unitCode = code;
        cur.lastSeenAt = now;
        cur.updatedAt = now;
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
        const journeys = this.journeysInWindow(fromTs, toTs);
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
