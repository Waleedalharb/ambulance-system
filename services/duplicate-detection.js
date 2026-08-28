'use strict';
/**
 * محرك اكتشاف «احتمال تكرار البلاغات» — Duplicate Detection 2.0
 * (اعتماد المالك 2026-08-24 — ملحق note-18 · ترقية 2.0 باعتماد المالك 2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════
 * محرك نقي بلا تخزين ولا آثار جانبية: يستقبل بلاغات مُطبَّعة ويعيد أزواجًا
 * مع قرار Rule-based قابل للتفسير وأدلة قابلة للتتبع. القواعد الحاكمة
 * (حرفية من اعتماد 2.0):
 *  • Precision First: يُفضَّل تفويت تكرار حقيقي على إعلان بلاغين مختلفين
 *    تكرارًا بلا دليل — «لا أعلم، يحتاج تحقق» خير من «مكرر» خاطئ.
 *  • الوقت وحده ممنوع من إنتاج Confirmed أو Likely أو حتى Similar.
 *  • 150م = دليل قرب مكاني قوي · 500م = نطاق بحث وتحليل فقط (ليس إثباتًا
 *    وليس حكمًا قاطعًا) · ما بعد 500م لا يمكن تأكيده مكانيًا ويحتاج دليلًا
 *    آخر قويًا (رقم جوال متطابق + سياق متطابق).
 *  • رقم الجوال بعد التطبيع عامل رئيسي، لكنه لا يُستخدم وحده لإعلان تكرار.
 *  • كود ProQA الدقيق هو دليل النوع — التصنيف العام (type=medical) لا يساوي شيئًا.
 *  • نفس رقم البلاغ = نفس البلاغ (لا يُقارن أصلًا) وليس تكرارًا.
 *  • 🟡 Similar تحليلي صامت: لا Toast ولا شريط تنبيه ولا عداد ولا كلمة «مكرر».
 *  • التنبيه التشغيلي (شريط الخريطة/الشارة/خط الربط) لـ 🔴 Confirmed فقط.
 *  • القرار Rule-based وقابل للتفسير — الـScore تفسيري للترتيب فقط ولا يقرر.
 *  • القرار والإلغاء في CAD حصرًا — لا دمج ولا إلغاء ولا سجل مراجعة هنا،
 *    ولا أي أثر على report_times أو isParticipationCounted أو الاحتساب.
 *  • رقم المبلغ يُستخدم للمطابقة فقط ولا يظهر في المخرجات (الأدلة تقول «متطابق»).
 * كل رقم هنا قابل للضبط من CONFIG في مكان واحد — لا ثوابت مدفونة في المنطق.
 */

const DEFAULT_CONFIG = {
    // المسافات (متر)
    strongDistM: 150,        // دليل قرب مكاني قوي
    searchDistM: 500,        // نطاق بحث وتحليل — بلا جوال لا يُنظر في أي زوج أبعد منها
    // الأزمنة (دقيقة)
    confirmedGapMin: 30,     // سقف فارق الزمن لقرار Confirmed
    strongGapMin: 15,        // فارق زمني قوي (يشترط لـ Likely بلا جوال)
    maxTimeGapMin: 60,       // خارجها لا دليل زمن إطلاقًا
    // نافذة المقارنة: لا يُقارن بلاغ بأقدم منها
    windowHours: 6,
    minPhoneDigits: 9,       // أقل طول مقبول لرقم مُطبَّع (جوال سعودي بلا مفتاح)
    textSupportMin: 0.25,    // حد التشابه النصي كدليل مساند — لا يقرر وحده أبدًا
    // أوزان تفسيرية للترتيب والشفافية فقط — القرار Rule-based ولا يعتمد عليها
    weights: { caller: 55, dist150: 25, dist500: 10, time15: 20, time30: 12, time60: 5, sameCode: 15, textMax: 12 }
};

/** تطبيع رقم الهاتف للمطابقة: أرقام فقط، إزالة مفتاح الدولة والصفر البادئ —
    «0533133496» = «+966533133496» = «00966533133496» = «533133496».
    يعيد null إن قصر عن الحد — رقم ناقص لا يُخمَّن ولا يُطابَق. */
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

/** نقاط تفسيرية للترتيب والشفافية فقط — لا تدخل في القرار إطلاقًا */
function informationalScore(f, W) {
    let s = 0;
    if (f.phoneMatch) s += W.caller;
    if (f.distM !== null) s += f.distM <= 150 ? W.dist150 : (f.distM <= 500 ? W.dist500 : 0);
    if (f.gapMin !== null) s += f.gapMin <= 15 ? W.time15 : (f.gapMin <= 30 ? W.time30 : (f.gapMin <= 60 ? W.time60 : 0));
    if (f.sameCode) s += W.sameCode;
    if (f.sim > 0) s += Math.round(f.sim * W.textMax);
    return s;
}

/**
 * تقييم زوج بلاغين. المدخل المُطبَّع لكل بلاغ:
 *   { number, status, callerNumber, description, address, type, code, lat, lng, createdTs }
 * (createdTs بالمللي ثانية أو null؛ lat/lng رقمان أو null).
 * يعيد null عند الاستقلال (🟢)، وإلا:
 *   { score, level, decision, rule, reasons[], evidence[], cancelledInCad }
 * level: confirmed 🔴 (تنبيه تشغيلي) / likely 🟠 (مرجّح بلا عداد) /
 *        similar 🟡 (تحليلي صامت — لا يُسمى مكررًا ولا يدخل أي عداد).
 */
function scorePair(a, b, config) {
    const C = config || DEFAULT_CONFIG;
    if (!a || !b || !a.number || !b.number || a.number === b.number) return null; // نفس الرقم = نفس البلاغ

    // ① رقم المبلغ بعد التطبيع — يُطابَق خامًا ولا يُعرض
    const pa = normalizePhone(a.callerNumber), pb = normalizePhone(b.callerNumber);
    const phoneMatch = pa !== null && pb !== null && pa === pb;

    // ② المسافة — لا تُحسب إلا بإحداثيات صحيحة الطرفين (بلا إحداثية لا تخمين)
    const geoA = typeof a.lat === 'number' && typeof a.lng === 'number' && isFinite(a.lat) && isFinite(a.lng);
    const geoB = typeof b.lat === 'number' && typeof b.lng === 'number' && isFinite(b.lat) && isFinite(b.lng);
    const distM = (geoA && geoB) ? haversineMeters(a.lat, a.lng, b.lat, b.lng) : null;

    // ③ الفارق الزمني بين إنشائي البلاغين في CAD
    const gapMin = (typeof a.createdTs === 'number' && typeof b.createdTs === 'number')
        ? Math.abs(a.createdTs - b.createdTs) / 60000 : null;

    // ④ كود ProQA الدقيق فقط — التصنيف العام (type) لا يُحتسب دليلًا في 2.0
    const sameCode = !!(a.code && b.code && String(a.code).toUpperCase() === String(b.code).toUpperCase());

    // ⑤ التشابه النصي (وصف CAD + العنوان) — دليل مساند بحد أدنى، لا يقرر وحده
    const sim = Math.max(
        textSimilarity(a.description, b.description),
        textSimilarity((a.description || '') + ' ' + (a.address || ''), (b.description || '') + ' ' + (b.address || '')));

    // ═══ Hard Gate مكاني (اعتماد المالك 2026-08-28 — لا يتجاوزه أي Score) ═══
    // بلا جوال متطابق: يُشترط دليل مكاني داخل نطاق البحث (≤500م). الوقت وحده
    // ممنوع من إنتاج أي قرار، وما بعد 500م لا يمكن تأكيده مكانيًا بلا دليل
    // آخر قوي — والدليل القوي الوحيد هنا هو الجوال + سياق متطابق (قاعدة C2).
    if (!phoneMatch && (distM === null || distM > C.searchDistM)) return null;

    // ═══ القرار Rule-based — يُقيَّم بالترتيب ويُفسَّر بالقاعدة التي أطلقته ═══
    const near = distM !== null && distM <= C.strongDistM;          // ≤150م
    const inSearch = distM !== null && distM <= C.searchDistM;      // ≤500م
    const tC = gapMin !== null && gapMin <= C.confirmedGapMin;      // ≤30د
    const tS = gapMin !== null && gapMin <= C.strongGapMin;         // ≤15د
    const tMax = gapMin !== null && gapMin <= C.maxTimeGapMin;      // ≤60د
    const textSupport = sim >= C.textSupportMin;

    let level = null, rule = null, decision = null;
    if (phoneMatch && near && tC) {
        level = 'confirmed'; rule = 'C1'; decision = 'CONFIRMED_DUPLICATE';
    } else if (phoneMatch && sameCode && tC) {
        // جوال + سياق متطابق (نفس كود ProQA) + زمن منطقي — يؤكد حتى لو تجاوزت
        // المسافة نطاق البحث أو غابت الإحداثيات (انتقال المبلّغ/دقة التحديد)
        level = 'confirmed'; rule = 'C2'; decision = 'CONFIRMED_DUPLICATE';
    } else if (phoneMatch && tMax && (distM === null || inSearch || sameCode)) {
        level = 'likely'; rule = 'L1'; decision = 'LIKELY_DUPLICATE';
    } else if (phoneMatch && near && gapMin === null) {
        level = 'likely'; rule = 'L2'; decision = 'LIKELY_DUPLICATE';
    } else if (!phoneMatch && near && tS && sameCode) {
        level = 'likely'; rule = 'L3'; decision = 'LIKELY_DUPLICATE';
    } else if (!phoneMatch && near && tC && sameCode && textSupport) {
        level = 'likely'; rule = 'L4'; decision = 'LIKELY_DUPLICATE';
    } else if (phoneMatch) {
        level = 'similar'; rule = 'S1'; decision = 'SIMILAR_NEEDS_REVIEW';
    } else if (near && (tMax || gapMin === null)) {
        level = 'similar'; rule = 'S2'; decision = 'SIMILAR_NEEDS_REVIEW';
    } else if (inSearch && tC && (sameCode || textSupport)) {
        level = 'similar'; rule = 'S3'; decision = 'SIMILAR_NEEDS_REVIEW';
    } else {
        return null; // 🟢 مستقل — لا يُعاد أي زوج
    }

    // ═══ الأدلة والتفسير — إلزامية لكل قرار يظهر للمشغل ═══
    const evidence = [];
    const reasons = [];
    if (phoneMatch) {
        evidence.push({ key: 'caller', label: 'رقم المبلغ متطابق' });
        reasons.push('رقم المبلّغ متطابق بعد التطبيع');
    }
    if (distM !== null) {
        const m = Math.round(distM);
        evidence.push({ key: 'distance', label: 'المسافة ~' + m + 'م', meters: m });
        reasons.push('المسافة ' + m + 'م' + (near ? ' (قرب قوي ≤' + C.strongDistM + 'م)' :
            inSearch ? ' (ضمن نطاق البحث ≤' + C.searchDistM + 'م)' : ' (خارج نطاق البحث)'));
    } else {
        reasons.push('لا إحداثيات مكتملة — الموقع غير مُثبت');
    }
    if (gapMin !== null) {
        const g = Math.round(gapMin);
        evidence.push({ key: 'time', label: 'الفارق الزمني ' + g + ' دقيقة', minutes: g });
        reasons.push('الفارق الزمني ' + g + ' دقيقة');
    } else {
        reasons.push('الزمن غير مُثبت لأحد الطرفين');
    }
    if (sameCode) {
        evidence.push({ key: 'code', label: 'نفس كود ProQA' });
        reasons.push('نفس كود ProQA («' + String(a.code).toUpperCase() + '»)');
    }
    if (textSupport) {
        evidence.push({ key: 'text', label: 'تشابه في الوصف/العنوان', similarity: Math.round(sim * 100) / 100 });
        reasons.push('تشابه نصي مساند في الوصف/العنوان');
    }

    const facts = { phoneMatch, distM, gapMin, sameCode, sim };
    return {
        score: informationalScore(facts, C.weights), // تفسيري للترتيب فقط — لا يقرر
        level, decision, rule, reasons, evidence,
        cancelledInCad: String(b.status || '') === 'cancelled'
    };
}

/**
 * البحث عن كل الأزواج المستحقة في قائمة بلاغات (نافذة CONFIG.windowHours).
 * يعيد مصفوفة أزواج: { number, candidate: { number, status }, score, level,
 * decision, rule, reasons, evidence, cancelledInCad } — موجهة من الأحدث
 * للأقدم، وكل زوج يظهر مرة واحدة فقط مهما تكررت دورات الحساب (لا تنبيهات
 * مكررة من تكرار التحديثات/SSE — البصمة الزوجية ثابتة).
 */
function findDuplicates(incidents, config) {
    const C = config || DEFAULT_CONFIG;
    const list = (Array.isArray(incidents) ? incidents : []).filter(x => x && x.number);
    const windowMs = C.windowHours * 3600000;
    const out = [];
    const seen = new Set(); // بصمة الزوج — الزوج الواحد يُحسب مرة واحدة فقط
    for (let i = 0; i < list.length; i++) {
        for (let j = 0; j < i; j++) {
            const a = list[i], b = list[j];
            // نافذة المقارنة: إن عُرف الزمنان وكان الفارق أبعد من النافذة يُستبعد الزوج
            if (typeof a.createdTs === 'number' && typeof b.createdTs === 'number' &&
                Math.abs(a.createdTs - b.createdTs) > windowMs) continue;
            const fp = [String(a.number), String(b.number)].sort().join('↔');
            if (seen.has(fp)) continue;
            const r = scorePair(a, b, C);
            if (r) { seen.add(fp); out.push({ number: a.number, candidate: { number: b.number, status: b.status || 'active' }, ...r }); }
        }
    }
    const lvlRank = { confirmed: 3, likely: 2, similar: 1 };
    const distOf = p => { const e = (p.evidence || []).find(e => e.key === 'distance'); return e ? e.meters : Infinity; };
    // الترتيب: المستوى الأعلى ثقة أولًا، ثم النقاط التفسيرية، ثم الأقرب مكانيًا
    out.sort((x, y) => ((lvlRank[y.level] || 0) - (lvlRank[x.level] || 0)) || (y.score - x.score) || (distOf(x) - distOf(y)));
    return out;
}

module.exports = { DEFAULT_CONFIG, normalizePhone, haversineMeters, tokenize, textSimilarity, scorePair, findDuplicates };
