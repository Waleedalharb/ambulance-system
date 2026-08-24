'use strict';
/**
 * محرك اكتشاف «احتمال تكرار البلاغات» (اعتماد المالك 2026-08-24 — ملحق note-18)
 * ═══════════════════════════════════════════════════════════════════════════
 * محرك نقي بلا تخزين ولا آثار جانبية: يستقبل بلاغات مُطبَّعة ويعيد أزواجًا
 * مشتبهًا بها مع نقاط وأدلة قابلة للتتبع. القواعد الحاكمة (حرفية من الاعتماد):
 *  • «احتمال تكرار — يحتاج تحقق» تنبيه فقط: Potential Duplicate ≠ Duplicate.
 *  • القرار والإلغاء في CAD حصرًا — لا دمج ولا إلغاء ولا سجل مراجعة هنا.
 *  • البلاغ الملغى في CAD يصلح مرشحًا موسومًا «ملغى في CAD» — إلغاؤه ليس دليلًا
 *    ولا يضيف نقاطًا.
 *  • قرب الموقع وحده لا يرتقي فوق 🟡 مهما بلغ (حارس cap).
 *  • الأدلة الناقصة (بلا هاتف + بلا إحداثيات + بلا زمن) = لا تنبيه إطلاقًا.
 *  • رقم المبلغ يُستخدم للمطابقة فقط ولا يظهر في المخرجات (الأدلة تقول «متطابق»).
 * كل رقم هنا قابل للضبط من CONFIG في مكان واحد — لا ثوابت مدفونة في المنطق.
 */

const DEFAULT_CONFIG = {
    // الأوزان
    weights: {
        caller: 55,          // رقم مبلغ متطابق بعد التطبيع — وحده 🟠، ومع موقع قريب 🔴
        dist150: 25,         // مسافة ≤ 150م
        dist500: 15,         // مسافة ≤ 500م
        dist1000: 5,         // مسافة ≤ 1000م
        time10: 20,          // فارق إنشاء ≤ 10 دقائق
        time30: 12,          // ≤ 30 دقيقة
        time60: 5,           // ≤ 60 دقيقة
        sameType: 8,         // نفس رمز ProQA أو نفس النوع المُصنَّف
        textMax: 12          // سقف مساهمة التشابه النصي (وصف/عنوان)
    },
    // العتبات
    thresholds: { high: 80, medium: 55, low: 30 },  // 🔴 / 🟠 / 🟡 — دون low لا يُعرض
    locationOnlyCap: 54,     // حارس «قرب موقع وحده»: بلا دليل مبلغ لا يتجاوز 🟡 أبدًا
    maxDistanceM: 1000,      // خارجها لا دليل موقع
    maxTimeGapMin: 60,       // خارجها لا دليل زمن
    windowHours: 6,          // نافذة المقارنة: لا يُقارن بلاغ بأقدم منها
    minPhoneDigits: 9        // أقل طول مقبول لرقم مُطبَّع (جوال سعودي بلا مفتاح)
};

/** تطبيع رقم الهاتف للمطابقة: أرقام فقط، إزالة مفتاح الدولة والصفر البادئ —
    «0533133496» = «+966533133496» = «00966533133496». يعيد null إن قصر عن الحد. */
function normalizePhone(raw) {
    if (raw == null) return null;
    let d = String(raw).replace(/\D/g, '');
    if (!d) return null;
    if (d.startsWith('00966')) d = d.slice(5);
    else if (d.startsWith('966')) d = d.slice(3);
    if (d.length === 10 && d.startsWith('0')) d = d.slice(1);
    return d.length >= DEFAULT_CONFIG.minPhoneDigits ? d : null;
}

/** مسافة هافرساين بالأمتار بين نقطتين — تُستدعى فقط بإحداثيات صحيحة الطرفين */
function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000, toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** تطبيع نص عربي/لاتيني للتشابه: إزالة التشكيل، توحيد الألف والياء والتاء
    المربوطة، ثم رموز بطول ≥3 (كلمات قصيرة كـ«في/من/على» لا تصلح دليلًا) */
function tokenize(text) {
    if (!text) return new Set();
    const norm = String(text)
        .replace(/[ً-ْٰ]/g, '')
        .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
        .toLowerCase();
    const tokens = norm.match(/[؀-ۿa-z0-9]{3,}/g) || [];
    return new Set(tokens);
}

/** تشابه جاكارد بين مجموعتي رموز — 0..1 */
function textSimilarity(a, b) {
    const ta = tokenize(a), tb = tokenize(b);
    if (!ta.size || !tb.size) return 0;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter);
}

/**
 * تقييم زوج بلاغين. المدخل المُطبَّع لكل بلاغ:
 *   { number, status, callerNumber, description, address, type, code, lat, lng, createdTs }
 * (createdTs بالمللي ثانية أو null؛ lat/lng رقمان أو null).
 * يعيد null عند انعدام الأهلية، وإلا { score, level, evidence[], cancelledInCad }.
 */
function scorePair(a, b, config) {
    const C = config || DEFAULT_CONFIG;
    const W = C.weights, T = C.thresholds;
    if (!a || !b || !a.number || !b.number || a.number === b.number) return null;

    const evidence = [];
    let score = 0;

    // ① رقم المبلغ — أقوى دليل فردي (يُطابَق خامًا ولا يُعرض)
    const pa = normalizePhone(a.callerNumber), pb = normalizePhone(b.callerNumber);
    const phoneMatch = pa !== null && pb !== null && pa === pb;
    if (phoneMatch) {
        score += W.caller;
        evidence.push({ key: 'caller', label: 'رقم المبلغ متطابق' });
    }

    // ② المسافة — لا تُحسب إلا بإحداثيات صحيحة الطرفين (بلاغ بلا إحداثية لا يُخمَّن)
    const geoA = typeof a.lat === 'number' && typeof a.lng === 'number' && isFinite(a.lat) && isFinite(a.lng);
    const geoB = typeof b.lat === 'number' && typeof b.lng === 'number' && isFinite(b.lat) && isFinite(b.lng);
    let distM = null;
    if (geoA && geoB) {
        distM = haversineMeters(a.lat, a.lng, b.lat, b.lng);
        if (distM <= 150) score += W.dist150;
        else if (distM <= 500) score += W.dist500;
        else if (distM <= C.maxDistanceM) score += W.dist1000;
        if (distM <= C.maxDistanceM)
            evidence.push({ key: 'distance', label: 'المسافة ~' + Math.round(distM) + 'م', meters: Math.round(distM) });
    }

    // ③ الفارق الزمني بين إنشائي البلاغين في CAD
    let gapMin = null;
    if (typeof a.createdTs === 'number' && typeof b.createdTs === 'number') {
        gapMin = Math.abs(a.createdTs - b.createdTs) / 60000;
        if (gapMin <= 10) score += W.time10;
        else if (gapMin <= 30) score += W.time30;
        else if (gapMin <= C.maxTimeGapMin) score += W.time60;
        if (gapMin <= C.maxTimeGapMin)
            evidence.push({ key: 'time', label: 'الفارق الزمني ' + Math.round(gapMin) + ' دقيقة', minutes: Math.round(gapMin) });
    }

    // ④ نفس النوع — رمز ProQA أولًا ثم التصنيف العام
    const sameCode = a.code && b.code && String(a.code).toUpperCase() === String(b.code).toUpperCase();
    const sameType = !sameCode && a.type && b.type && a.type === b.type;
    if (sameCode || sameType) {
        score += W.sameType;
        evidence.push({ key: 'type', label: 'نفس نوع البلاغ' });
    }

    // ⑤ التشابه النصي (وصف CAD + العنوان) — مساهمة محدودة السقف
    const sim = Math.max(
        textSimilarity(a.description, b.description),
        textSimilarity((a.description || '') + ' ' + (a.address || ''), (b.description || '') + ' ' + (b.address || '')));
    if (sim > 0) {
        const pts = Math.round(sim * W.textMax);
        if (pts > 0) {
            score += pts;
            evidence.push({ key: 'text', label: 'تشابه في الوصف/العنوان', similarity: Math.round(sim * 100) / 100 });
        }
    }

    // ═══ الحراس ═══
    // حارس الأدلة الناقصة: بلا مبلغ + بلا إحداثيات صحيحة الطرفين + بلا زمن الطرفين
    // = لا أساس للاشتباه إطلاقًا (النوع والنص وحدهما لا يكفيان)
    if (!phoneMatch && !(geoA && geoB) && gapMin === null) return null;
    // بلا مبلغ متطابق: يُشترط دليل موقع أو زمن حقيقي (داخل الحدود) — وإلا لا تنبيه
    if (!phoneMatch && !(distM !== null && distM <= C.maxDistanceM) && !(gapMin !== null && gapMin <= C.maxTimeGapMin)) return null;

    // حارس «قرب الموقع وحده»: غياب دليل المبلغ يضع سقفًا لا يتجاوز 🟡 أبدًا
    if (!phoneMatch && score > C.locationOnlyCap) score = C.locationOnlyCap;

    if (score < T.low) return null;
    const level = score >= T.high ? 'high' : (score >= T.medium ? 'medium' : 'low');
    return { score, level, evidence, cancelledInCad: String(b.status || '') === 'cancelled' };
}

/**
 * البحث عن كل الأزواج المشتبه بها في قائمة بلاغات (نافذة CONFIG.windowHours).
 * يعيد مصفوفة أزواج: { number, candidate: { number, status }, score, level,
 * evidence, cancelledInCad } — موجهة من الأحدث للأقدم حتى لا يتكرر الزوج معكوسًا.
 */
function findDuplicates(incidents, config) {
    const C = config || DEFAULT_CONFIG;
    const list = (Array.isArray(incidents) ? incidents : []).filter(x => x && x.number);
    const windowMs = C.windowHours * 3600000;
    const out = [];
    for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < i; j++) {
            const a = list[i], b = list[j];
            // نافذة المقارنة: إن عُرف الزمنان وكان الفارق أبعد من النافذة يُستبعد الزوج
            if (typeof a.createdTs === 'number' && typeof b.createdTs === 'number' &&
                Math.abs(a.createdTs - b.createdTs) > windowMs) continue;
            const r = scorePair(a, b, C);
            if (r) out.push({ number: a.number, candidate: { number: b.number, status: b.status || 'active' }, ...r });
        }
    }
    const distOf = p => { const e = (p.evidence || []).find(e => e.key === 'distance'); return e ? e.meters : Infinity; };
    out.sort((x, y) => (y.score - x.score) || (distOf(x) - distOf(y))); // التعادل: الأقرب مكانيًا أولًا
    return out;
}

module.exports = { DEFAULT_CONFIG, normalizePhone, haversineMeters, tokenize, textSimilarity, scorePair, findDuplicates };
