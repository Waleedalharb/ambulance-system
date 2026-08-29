/**
 * ═══ place-intelligence-service.js — Place Intelligence Engine (PI-1) ═══
 * اعتماد المالك 2026-08-29 — تنفيذ محلي فقط، بلا Commit/Push/Deploy.
 *
 * الغرض الوحيد: استنتاج نوع الموقع/الجهة المرتبطة بالبلاغ وفق قواعد
 * Precision First، وإخراج placeResolution قابل للتدقيق لكل بلاغ.
 *
 * القواعد الملزمة (من pi-1-directive-final.md):
 *  R1: إحداثيات داخل radiusM لموقع active → Confirmed (90–99)
 *  R2: اسم معروف مطابق (حدود كلمة كاملة) + توافق مكاني داخل radiusM → Confirmed (90–97)
 *  R3: اسم معروف مطابق خارج radiusM أو بدون إحداثيات → Likely فقط (70–85، ممنوع Confirmed)
 *  R4: كلمة/دليل نوع المنشأة فقط → Likely فقط (60–75)
 *  R5: لا أدلة كافية → Unknown (0)
 *  النطاق 86–89 محظور. ممنوع Likely فوق 85 وConfirmed تحت 90.
 *  الزمن وتشابه النص وحدهما لا ينتجان Confirmed. ممنوع substring ساذج.
 *  ممنوع تخمين اسم المنشأة من نوعها (R4 يخرج placeType فقط، placeName=null).
 *
 * الخطوط الحمراء:
 *  - لا مساس بـ Hospital Monitor / Duplicate Detection / report_times /
 *    الاحتساب / CAD / المناوبات / الجداول / الأرشيف الحالي / الخريطة / التنبيهات.
 *  - لا مصدر حقيقة ثانٍ للمستشفيات: hospitalName ورحلاتها من مخزن 1B حصريًا؛
 *    بذرة المستشفيات هنا للتطابق المكاني فقط.
 *  - candidate ≠ active: لا يدخل المطابقة إلا status='active'، ولا يتحول أي
 *    موقع مكتشف تلقائيًا إلى active إلا عبر approveCandidate (مراجعة بشرية).
 *  - النظام لا يتعلم من خطئه: لا مسار آلي (بلاغ ← استنتاج ← موقع موثوق).
 *
 * التخزين (معزول، fs/path فقط — نمط hospital-monitor):
 *  data/places.json            — السجل الموحد (placesVersion + places{})
 *  data/place-resolutions.json — نتيجة كل بلاغ مفتوحة على eventId + history تدقيقي
 *  data/place-candidates.json  — مرشحون مكتشفون (learned) بانتظار مراجعة بشرية
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { haversineMeters } = require('./duplicate-detection'); // إعادة استخدام — ممنوع نسخة ثانية

const ENGINE_VERSION = '1.0.0';

// سقوف الثقة المعتمدة لكل قاعدة (النطاق 86–89 محظور معماريًا)
const CONF_BANDS = {
    R1: { min: 90, max: 99 },   // دالة المسافة الفعلية داخل radiusM
    R2: { min: 90, max: 97 },   // اسم مطابق + توافق مكاني داخل radiusM
    R3: { min: 70, max: 85 },   // اسم مطابق بدون توافق مكاني كافٍ
    R4: { min: 60, max: 75 },   // دليل نوع نصي فقط
    R5: { min: 0,  max: 0 }     // Unknown — لا رقم تجميلي
};

const PLACE_TYPES = ['hospital', 'health_center', 'school', 'university', 'police',
    'prison', 'government', 'mosque', 'mall', 'sports', 'public_facility',
    'construction', 'operational_center', 'other'];

// أدلة نوع المنشأة النصية (R4) — مطابقة بحدود كلمة كاملة بعد التطبيع.
// تُستخدم لتصنيف النوع فقط، ولا تنتج اسم منشأة أبدًا.
const TYPE_KEYWORDS = [
    { placeType: 'school',        words: ['مدرسة', 'مدارس', 'ثانوية', 'متوسطة', 'ابتدائية', 'روضة اطفال'] },
    { placeType: 'university',    words: ['جامعة', 'كلية'] },
    { placeType: 'hospital',      words: ['مستشفى'] },
    { placeType: 'health_center', words: ['مركز صحي', 'مستوصف', 'عيادة', 'عيادات'] },
    { placeType: 'police',        words: ['شرطة', 'مركز شرطة', 'قسم شرطة'] },
    { placeType: 'prison',        words: ['سجن', 'سجون', 'إصلاحية'] },
    { placeType: 'mosque',        words: ['مسجد', 'جامع', 'مصلى'] },
    { placeType: 'mall',          words: ['مول', 'مركز تجاري', 'سوق تجاري'] },
    { placeType: 'sports',        words: ['ملعب', 'استاد', 'نادي', 'منشأة رياضية', 'صالة رياضية'] },
    { placeType: 'government',    words: ['أمانة', 'بلدية', 'محكمة', 'وزارة', 'دائرة حكومية', 'جهة حكومية'] },
    { placeType: 'construction',  words: ['موقع إنشائي', 'موقع انشائي', 'تحت الإنشاء', 'تحت الانشاء'] }
];

/** تطبيع النص العربي قبل أي مطابقة (همزات/تاء مربوطة/أرقام عربية/تشكيل/تطويل) */
function normalizeArabic(s) {
    if (!s || typeof s !== 'string') return '';
    return s
        .replace(/[ً-ْٰـ]/g, '')           // تشكيل + تطويل
        .replace(/[أإآٱ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** هل تظهر العبارة في النص بحدود كلمة كاملة؟ (ممنوع substring ساذج) */
function phraseInText(phrase, text) {
    const p = normalizeArabic(phrase), t = normalizeArabic(text);
    if (!p || !t) return false;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '([^\\p{L}\\p{N}]|$)', 'u').test(t);
}

function clampToBand(rule, value) {
    const b = CONF_BANDS[rule];
    return Math.max(b.min, Math.min(b.max, Math.round(value)));
}

class PlaceIntelligenceService {
    /**
     * @param {object} opts { placesFile, resolutionsFile, candidatesFile }
     *  كل المسارات قابلة للحقن — الاختبارات تعمل على مجلد مؤقت معزول.
     */
    constructor(opts = {}) {
        const dataDir = opts.dataDir || path.join(__dirname, '..', 'data');
        this.placesFile = opts.placesFile || path.join(dataDir, 'places.json');
        this.resolutionsFile = opts.resolutionsFile || path.join(dataDir, 'place-resolutions.json');
        this.candidatesFile = opts.candidatesFile || path.join(dataDir, 'place-candidates.json');
        this._reg = null; this._res = null; this._cand = null; // lazy
    }

    // ─── التحميل/الحفظ (كتابة ذرّية — نفس نمط hospital-monitor) ───
    _loadRegistry() {
        if (this._reg) return this._reg;
        let s = null;
        try { s = JSON.parse(fs.readFileSync(this.placesFile, 'utf8')); } catch (_) { s = null; }
        if (!s || typeof s !== 'object' || !s.places || typeof s.places !== 'object') {
            s = { placesVersion: 0, places: {} };
        }
        this._reg = s;
        return s;
    }
    _saveRegistry() {
        const tmp = this.placesFile + '.tmp';
        fs.mkdirSync(path.dirname(this.placesFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this._reg, null, 2));
        fs.renameSync(tmp, this.placesFile);
    }
    _loadResolutions() {
        if (this._res) return this._res;
        let s = null;
        try { s = JSON.parse(fs.readFileSync(this.resolutionsFile, 'utf8')); } catch (_) { s = null; }
        if (!s || typeof s !== 'object' || !s.byIncident || typeof s.byIncident !== 'object' || !Array.isArray(s.history)) {
            s = { byIncident: {}, history: [] };
        }
        this._res = s;
        return s;
    }
    _saveResolutions() {
        const tmp = this.resolutionsFile + '.tmp';
        fs.mkdirSync(path.dirname(this.resolutionsFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this._res));
        fs.renameSync(tmp, this.resolutionsFile);
    }
    _loadCandidates() {
        if (this._cand) return this._cand;
        let s = null;
        try { s = JSON.parse(fs.readFileSync(this.candidatesFile, 'utf8')); } catch (_) { s = null; }
        if (!s || typeof s !== 'object' || !Array.isArray(s.candidates)) s = { candidates: [] };
        this._cand = s;
        return s;
    }
    _saveCandidates() {
        const tmp = this.candidatesFile + '.tmp';
        fs.mkdirSync(path.dirname(this.candidatesFile), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this._cand, null, 2));
        fs.renameSync(tmp, this.candidatesFile);
    }

    // ─── إدارة السجل ───
    listPlaces(filter = {}) {
        const reg = this._loadRegistry();
        let out = Object.values(reg.places);
        if (filter.status) out = out.filter(p => p.status === filter.status);
        if (filter.placeType) out = out.filter(p => p.placeType === filter.placeType);
        return out;
    }

    /**
     * إضافة موقع. status الافتراضي candidate — لا يوجد إنشاء active إلا عبر
     * البذرة (source='seed') أو الاعتماد البشري approveCandidate.
     */
    addPlace(data, actor = 'manual') {
        const reg = this._loadRegistry();
        const now = new Date().toISOString();
        const placeId = data.placeId || ('plc_' + require('crypto').createHash('sha1')
            .update((data.name || '') + '|' + data.lat + '|' + data.lng).digest('hex').slice(0, 10));
        if (reg.places[placeId]) return { ok: false, reason: 'exists', placeId };
        const status = (data.source === 'seed') ? 'active' : (data.status === 'active' && actor !== 'seed' ? 'candidate' : (data.status || 'candidate'));
        reg.places[placeId] = {
            placeId,
            placeType: PLACE_TYPES.includes(data.placeType) ? data.placeType : 'other',
            subtype: data.subtype || null,
            name: data.name || null,
            nameVariants: Array.isArray(data.nameVariants) ? data.nameVariants : [data.name].filter(Boolean),
            lat: typeof data.lat === 'number' ? data.lat : null,
            lng: typeof data.lng === 'number' ? data.lng : null,
            radiusM: typeof data.radiusM === 'number' && data.radiusM > 0 ? data.radiusM : 150,
            district: data.district || null,
            internal: !!data.internal,
            source: data.source || 'manual',
            status,
            evidence: [{ at: now, by: actor, note: data.note || ('إضافة ' + (data.source || 'manual')) }],
            createdAt: now, updatedAt: now, createdBy: actor
        };
        this._saveRegistry();
        return { ok: true, placeId, status };
    }

    /**
     * الاعتماد البشري الوحيد الذي يحوّل candidate → active.
     * يرفع placesVersion — كل placeResolution لاحق يُنسب للنسخة الجديدة،
     * وإعادة حسم البلاغات السابقة تُوثَّق في history مع النسختين.
     * (PI-2) justification إلزامي عمليًا من طبقة المراجعة: يوثَّق في evidence
     * مع radiusM — «radiusM تمثيل تشغيلي لنطاق الجهة المعتمد، لا مسافة سماح».
     */
    approveCandidate(placeId, reviewer, justification = null) {
        const reg = this._loadRegistry();
        const p = reg.places[placeId];
        if (!p) return { ok: false, reason: 'not-found' };
        if (p.status === 'active') return { ok: false, reason: 'already-active' };
        const now = new Date().toISOString();
        p.status = 'active';
        p.updatedAt = now;
        p.evidence.push({
            at: now, by: reviewer || 'reviewer',
            note: 'اعتماد بشري: candidate → active' +
                (justification ? ' · radiusM=' + p.radiusM + ' — المبرر: ' + justification : '')
        });
        reg.placesVersion = (reg.placesVersion || 0) + 1;
        this._saveRegistry();
        return { ok: true, placeId, placesVersion: reg.placesVersion };
    }

    /** تحديث حقول موقع candidate قبل الاعتماد (اسم/نوع/إحداثيات/radiusM) — من قرار بشري فقط */
    reviseCandidate(placeId, fields, reviewer) {
        const reg = this._loadRegistry();
        const p = reg.places[placeId];
        if (!p) return { ok: false, reason: 'not-found' };
        if (p.status === 'active') return { ok: false, reason: 'already-active' };
        const now = new Date().toISOString();
        for (const k of ['name', 'district']) if (typeof fields[k] === 'string' && fields[k]) p[k] = fields[k];
        if (typeof fields.placeType === 'string' && PLACE_TYPES.includes(fields.placeType)) p.placeType = fields.placeType;
        if (Array.isArray(fields.nameVariants) && fields.nameVariants.length) p.nameVariants = fields.nameVariants;
        for (const k of ['lat', 'lng']) if (typeof fields[k] === 'number' && isFinite(fields[k])) p[k] = fields[k];
        if (typeof fields.radiusM === 'number' && isFinite(fields.radiusM) && fields.radiusM > 0) p.radiusM = fields.radiusM;
        p.updatedAt = now;
        p.evidence.push({ at: now, by: reviewer || 'reviewer', note: 'تنقيح بشري قبل الاعتماد: ' + JSON.stringify(fields) });
        this._saveRegistry();
        return { ok: true, placeId };
    }

    /** وسم مرشح مكتشف: adopted (اعتُمد ودخل السجل) أو rejected (رُفض — لا يدخل السجل نهائيًا) */
    setCandidateStatus(candidateId, status, reviewer, note = '') {
        const c = this._loadCandidates();
        const cand = c.candidates.find(x => x.id === candidateId);
        if (!cand) return { ok: false, reason: 'not-found' };
        cand.status = status;
        cand.reviewedBy = reviewer || 'reviewer';
        cand.reviewedAt = new Date().toISOString();
        if (note) cand.reviewNote = note;
        this._saveCandidates();
        return { ok: true, candidateId, status };
    }

    /** المرشحون المكتشفون (learned) — ملف منفصل، بانتظار مراجعة بشرية فقط */
    addCandidate(candidate, actor = 'learned') {
        const c = this._loadCandidates();
        const now = new Date().toISOString();
        const entry = Object.assign({
            id: 'cand_' + require('crypto').createHash('sha1')
                .update(JSON.stringify([candidate.lat, candidate.lng, candidate.nameGuess || ''])).digest('hex').slice(0, 10),
            status: 'candidate', discoveredBy: actor, discoveredAt: now
        }, candidate);
        c.candidates.push(entry);
        this._saveCandidates();
        return entry.id;
    }
    listCandidates() { return this._loadCandidates().candidates; }

    // ─── محرك التعرف R1–R5 ───

    /**
     * استنتاج نوع/اسم الموقع لبلاغ واحد — دالة نقية بلا كتابة.
     * @param {object} incident { lat, lng, address, district, description, notes[]|string, ... }
     * @returns {object} placeResolution { placeId, placeType, placeName, decision,
     *   confidence, rule, evidence[], resolvedAt, engineVersion, placesVersion, internalContext }
     */
    resolve(incident) {
        const reg = this._loadRegistry();
        const placesVersion = reg.placesVersion || 0;
        const now = new Date().toISOString();
        const evidence = [];
        const base = {
            placeId: null, placeType: null, placeName: null,
            decision: 'unknown', confidence: 0, rule: 'R5',
            evidence, resolvedAt: now,
            engineVersion: ENGINE_VERSION, placesVersion,
            internalContext: null
        };

        // المطابقة على المواقع active فقط — candidate لا يدخل المطابقة أبدًا
        const active = Object.values(reg.places).filter(p => p.status === 'active');
        const internalPlaces = active.filter(p => p.internal);
        const external = active.filter(p => !p.internal);

        const lat = (incident && typeof incident.lat === 'number' && isFinite(incident.lat)) ? incident.lat : null;
        const lng = (incident && typeof incident.lng === 'number' && isFinite(incident.lng)) ? incident.lng : null;
        const hasCoords = lat !== null && lng !== null && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;

        const texts = {
            address: incident && incident.address,
            description: incident && incident.description,
            notes: incident && incident.notes
                ? (Array.isArray(incident.notes) ? incident.notes.join('\n') : String(incident.notes)) : null
        };

        // ⓪ سياق داخلي: بلاغ داخل مركز تشغيلي — لا يُصنَّف جهة خارجية أبدًا
        let internalHit = null;
        if (hasCoords) {
            for (const p of internalPlaces) {
                if (p.lat === null || p.lng === null) continue;
                const d = haversineMeters(lat, lng, p.lat, p.lng);
                if (d <= p.radiusM) { internalHit = { place: p, distanceM: Math.round(d) }; break; }
            }
        }

        // ① تطابق إحداثي مع المواقع الخارجية (الأقرب أولًا)
        let geoHits = [];
        if (hasCoords) {
            geoHits = external
                .filter(p => p.lat !== null && p.lng !== null)
                .map(p => ({ place: p, distanceM: haversineMeters(lat, lng, p.lat, p.lng) }))
                .filter(h => h.distanceM <= h.place.radiusM)
                .sort((a, b) => a.distanceM - b.distanceM);
        }

        // ② تطابق اسمي (nameVariants بحدود كلمة كاملة) في أي حقل نصي
        const nameHits = [];
        for (const p of external) {
            for (const v of (p.nameVariants || [])) {
                for (const field of ['address', 'description', 'notes']) {
                    if (texts[field] && phraseInText(v, texts[field])) {
                        nameHits.push({ place: p, variant: v, field });
                        break;
                    }
                }
                if (nameHits.some(h => h.place.placeId === p.placeId)) break;
            }
        }

        // ── المسار الحاسم ──
        if (geoHits.length) {
            const g = geoHits[0];
            const dM = Math.round(g.distanceM);
            const sameName = nameHits.find(h => h.place.placeId === g.place.placeId);
            if (sameName) {
                // R2: اسم مطابق + توافق مكاني داخل radiusM
                const conf = clampToBand('R2', 90 + 7 * (1 - g.distanceM / g.place.radiusM));
                evidence.push({ key: 'rule', text: 'R2 — اسم معروف مطابق («' + sameName.variant + '» في ' + sameName.field + ') + توافق مكاني داخل radiusM' });
                evidence.push({ key: 'distance', text: 'المسافة: ' + dM + 'م · radiusM: ' + g.place.radiusM + 'م', meters: dM, radiusM: g.place.radiusM });
                evidence.push({ key: 'confidence', text: 'confidence = 90 + 7×(1 − ' + dM + '/' + g.place.radiusM + ') = ' + conf });
                return Object.assign(base, {
                    placeId: g.place.placeId, placeType: g.place.placeType, placeName: g.place.name,
                    decision: 'confirmed', confidence: conf, rule: 'R2',
                    internalContext: internalHit ? internalHit.place.name : null
                });
            }
            // R1: تطابق إحداثي خالص
            const conf = clampToBand('R1', 90 + 9 * (1 - g.distanceM / g.place.radiusM));
            evidence.push({ key: 'rule', text: 'R1 — الإحداثيات داخل radiusM لموقع active معروف (' + g.place.name + ')' });
            evidence.push({ key: 'distance', text: 'المسافة: ' + dM + 'م · radiusM: ' + g.place.radiusM + 'م', meters: dM, radiusM: g.place.radiusM });
            evidence.push({ key: 'confidence', text: 'confidence = 90 + 9×(1 − ' + dM + '/' + g.place.radiusM + ') = ' + conf });
            if (geoHits.length > 1) evidence.push({ key: 'multi', text: 'عدد المواقع داخل النطاق: ' + geoHits.length + ' — فاز الأقرب' });
            // توثيق التضارب: اسم نصي يشير لموقع آخر خارج radiusM — الإحداثي يفوز، لا تخمين
            const conflict = nameHits.find(h => h.place.placeId !== g.place.placeId);
            if (conflict) {
                evidence.push({ key: 'conflict', text: 'تضارب: الاسم النصي «' + conflict.variant + '» يطابق موقعًا آخر (' + conflict.place.name + ') خارج radiusM — فاز التطابق الإحداثي الموثق' });
            }
            return Object.assign(base, {
                placeId: g.place.placeId, placeType: g.place.placeType, placeName: g.place.name,
                decision: 'confirmed', confidence: conf, rule: 'R1',
                internalContext: internalHit ? internalHit.place.name : null
            });
        }

        if (nameHits.length) {
            // R3: اسم مطابق بدون توافق مكاني كافٍ — Likely فقط، ممنوع Confirmed
            const h = nameHits[0];
            let conf = 70;
            const reasons = ['تطابق اسم «' + h.variant + '» في ' + h.field];
            if (incident && incident.district && h.place.district &&
                normalizeArabic(incident.district) === normalizeArabic(h.place.district)) {
                conf += 10; reasons.push('الحي متوافق (+10)');
            }
            const sameName = external.filter(p => (p.nameVariants || [])
                .some(v => normalizeArabic(v) === normalizeArabic(h.variant)));
            if (sameName.length === 1) { conf += 5; reasons.push('الاسم فريد في السجل (+5)'); }
            else reasons.push('الاسم مشترك بين ' + sameName.length + ' مواقع (+0)');
            if (hasCoords) reasons.push('الإحداثيات خارج radiusM — لا يجوز Confirmed');
            else reasons.push('لا إحداثيات — لا يجوز Confirmed');
            conf = clampToBand('R3', conf);
            evidence.push({ key: 'rule', text: 'R3 — اسم معروف مطابق بدون توافق مكاني داخل radiusM' });
            evidence.push({ key: 'name-match', text: reasons.join(' · ') });
            evidence.push({ key: 'confidence', text: 'confidence = 70' + (conf > 70 ? ' + عوامل مؤيدة' : '') + ' = ' + conf + ' (سقف R3 = 85)' });
            return Object.assign(base, {
                placeId: h.place.placeId, placeType: h.place.placeType, placeName: h.place.name,
                decision: 'likely', confidence: conf, rule: 'R3',
                internalContext: internalHit ? internalHit.place.name : null
            });
        }

        // R4: دليل نوع نصي فقط — placeType بلا اسم، Likely بسقف 75
        for (const group of TYPE_KEYWORDS) {
            for (const w of group.words) {
                const fields = ['address', 'description', 'notes'].filter(f => texts[f] && phraseInText(w, texts[f]));
                if (fields.length) {
                    let conf = 60;
                    const reasons = ['كلمة «' + w + '» في ' + fields.join(' و')];
                    if (incident && incident.district) { conf += 10; reasons.push('الحي معروف (+10)'); }
                    if (fields.length >= 2) { conf += 5; reasons.push('الدليل في أكثر من حقل (+5)'); }
                    conf = clampToBand('R4', conf);
                    evidence.push({ key: 'rule', text: 'R4 — دليل نوع نصي فقط، بلا موقع معروف مطابق' });
                    evidence.push({ key: 'keyword', text: reasons.join(' · ') });
                    evidence.push({ key: 'confidence', text: 'confidence = 60' + (conf > 60 ? ' + عوامل مؤيدة' : '') + ' = ' + conf + ' (سقف R4 = 75) — النوع فقط، لا اسم ولا حسم' });
                    return Object.assign(base, {
                        placeType: group.placeType,
                        decision: 'likely', confidence: conf, rule: 'R4',
                        internalContext: internalHit ? internalHit.place.name : null
                    });
                }
            }
        }

        // R5: لا أدلة كافية — Unknown نتيجة مشروعة، لا تخمين
        if (internalHit) {
            evidence.push({ key: 'rule', text: 'R5 — البلاغ داخل مركز تشغيلي داخلي (' + internalHit.place.name + ', ' + internalHit.distanceM + 'م) — ليس جهة خارجية' });
            return Object.assign(base, { internalContext: internalHit.place.name });
        }
        evidence.push({ key: 'rule', text: 'R5 — لا تطابق إحداثي ولا اسمي ولا دليل نوع: Unknown بلا تخمين' });
        return base;
    }

    /**
     * حسم وتخزين نتيجة بلاغ (مفتوح على eventId).
     * إعادة الحسم موثقة في history مع placesVersion القديمة والجديدة —
     * وتصبح ممكنة فعليًا بعد اعتماد بشري يرفع placesVersion.
     */
    recordResolution(eventId, incident) {
        if (!eventId) return { ok: false, reason: 'no-eventId' };
        const store = this._loadResolutions();
        const prev = store.byIncident[eventId] || null;
        const next = this.resolve(incident);
        next.eventId = eventId;
        if (prev && (prev.decision !== next.decision || prev.placeId !== next.placeId || prev.placesVersion !== next.placesVersion)) {
            store.history.push({
                eventId, at: next.resolvedAt,
                from: { decision: prev.decision, placeId: prev.placeId, placeName: prev.placeName, rule: prev.rule, placesVersion: prev.placesVersion },
                to: { decision: next.decision, placeId: next.placeId, placeName: next.placeName, rule: next.rule, placesVersion: next.placesVersion },
                reason: prev.placesVersion !== next.placesVersion
                    ? 'إعادة حسم بعد اعتماد بشري (placesVersion ' + prev.placesVersion + ' ← ' + next.placesVersion + ')'
                    : 'إعادة حسم بتغير المدخلات'
            });
        }
        store.byIncident[eventId] = next;
        this._saveResolutions();
        return { ok: true, resolution: next, changed: !!(prev && store.history.length && store.history[store.history.length - 1].eventId === eventId) };
    }

    getResolution(eventId) { return this._loadResolutions().byIncident[eventId] || null; }
    getHistory(eventId) {
        return this._loadResolutions().history.filter(h => h.eventId === eventId);
    }

    /**
     * قسم «الجهات والمواقع» للأرشيف (PI-3 — حواجز المالك ③④⑤⑥⑦⑧).
     * قراءة مخازن فقط (place-resolutions + places) — ممنوع resolve/استنتاج هنا.
     * مدخلات: أرقام بلاغات المناوبة. الناتج بنية موصولة العمق (deep copy) —
     * لا مرجعية لكائنات المخزن الحي، فتبقى اللقطة المختومة ثابتة تاريخيًا.
     *  - Confirmed = الرقم الرسمي · Likely منفصل تمامًا «للتحقق» ·
     *    Unknown لا يدخل أي نوع — سطر معلومة واحد فقط.
     *  - كل نسبة بمقام صريح موثق (percentOfConfirmed = مؤكد النوع / مؤكد الجهات كله).
     *  - placeType canonical من المخزن فقط (PLACE_TYPES) — لا أنواع حرة.
     */
    archiveSectionForIncidents(incidentNumbers) {
        const res = this._loadResolutions();
        const reg = this._loadRegistry();
        const numbers = Array.isArray(incidentNumbers) ? [...new Set(incidentNumbers.filter(Boolean))] : [];

        const byType = new Map(); // placeType ← {confirmed[], likely[], places: Map(placeId ← {…})}
        let confirmedTotal = 0, likelyTotal = 0, unknownTotal = 0, unresolvedTotal = 0;

        for (const num of numbers) {
            const r = res.byIncident[num];
            if (!r) { unresolvedTotal++; continue; }
            if (r.decision === 'unknown') { unknownTotal++; continue; }
            const type = PLACE_TYPES.includes(r.placeType) ? r.placeType : 'other';
            if (!byType.has(type)) byType.set(type, { confirmed: [], likely: [], places: new Map() });
            const bucket = byType.get(type);
            // حاجز ④: الحالة النهائية المخزنة لكل eventId — بلاغ واحد يُحسب مرة واحدة
            const entry = {
                eventId: num, rule: r.rule, confidence: r.confidence,
                decision: r.decision, // الحالة المختومة نفسها — الواجهة تعرضها ولا تستنتجها (PI-4)
                placesVersion: r.placesVersion, resolvedAt: r.resolvedAt,
                evidence: JSON.parse(JSON.stringify(r.evidence || [])) // مرجع الأدلة — نسخة منفصلة
            };
            if (r.decision === 'confirmed') {
                confirmedTotal++;
                bucket.confirmed.push(entry);
                if (r.placeId) {
                    if (!bucket.places.has(r.placeId)) {
                        const p = reg.places[r.placeId];
                        bucket.places.set(r.placeId, {
                            placeId: r.placeId,
                            // الاسم/النوع كما عرفهما النظام وقت الحسم — من النتيجة لا من السجل الحي
                            name: r.placeName || (p ? p.name : null),
                            confirmed: [], likely: []
                        });
                    }
                    bucket.places.get(r.placeId).confirmed.push(entry);
                }
            } else { // likely
                likelyTotal++;
                bucket.likely.push(entry);
                if (r.placeId) {
                    if (!bucket.places.has(r.placeId)) {
                        const p = reg.places[r.placeId];
                        bucket.places.set(r.placeId, {
                            placeId: r.placeId, name: r.placeName || (p ? p.name : null),
                            confirmed: [], likely: []
                        });
                    }
                    bucket.places.get(r.placeId).likely.push(entry);
                }
            }
        }

        const TYPE_LABELS = {
            hospital: 'مستشفيات', health_center: 'مراكز صحية', school: 'مدارس',
            university: 'جامعات', police: 'مراكز شرطة', prison: 'سجون/إصلاحيات',
            government: 'جهات حكومية', mosque: 'مساجد', mall: 'مراكز تجارية',
            sports: 'منشآت رياضية', public_facility: 'مرافق عامة',
            construction: 'مواقع إنشائية', operational_center: 'مراكز تشغيلية', other: 'أخرى'
        };

        const types = [...byType.entries()].map(([placeType, b]) => ({
            placeType, // canonical من المخزن — حاجز ⑦
            label: TYPE_LABELS[placeType] || placeType,
            confirmedCount: b.confirmed.length,
            likelyCount: b.likely.length, // منفصل «للتحقق» — لا يدخل الرقم الرسمي
            uniquePlaces: b.places.size,
            // حاجز ⑥: النسبة بمقام صريح موثق
            percentOfConfirmed: confirmedTotal > 0
                ? Math.round((b.confirmed.length / confirmedTotal) * 1000) / 10 : 0,
            places: [...b.places.values()]
                .map(p => ({
                    placeId: p.placeId, name: p.name,
                    confirmedCount: p.confirmed.length, likelyCount: p.likely.length,
                    incidents: p.confirmed.concat(p.likely)
                }))
                .sort((a, z) => z.confirmedCount - a.confirmedCount)
        })).sort((a, z) => z.confirmedCount - a.confirmedCount);

        return {
            sealedAt: new Date().toISOString(),
            engineVersion: ENGINE_VERSION,
            totals: {
                incidents: numbers.length,
                confirmedPlaceLinked: confirmedTotal,   // الرقم الرسمي الوحيد
                likelyPlaceLinked: likelyTotal,          // منفصل — للتحقق
                unknownUnclassified: unknownTotal,       // حُسم كـ Unknown
                noResolution: unresolvedTotal            // بلاغات قبل عهد المحرك/بلا حسم
            },
            denominatorNote: 'percentOfConfirmed = بلاغات النوع المؤكدة ÷ إجمالي البلاغات المؤكدة المرتبطة بجهات (' + confirmedTotal + ')',
            byType: types
        };
    }
}

module.exports = {
    PlaceIntelligenceService, ENGINE_VERSION, CONF_BANDS, PLACE_TYPES,
    TYPE_KEYWORDS, normalizeArabic, phraseInText
};
