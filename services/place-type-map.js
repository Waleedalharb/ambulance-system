/**
 * place-type-map.js — جدول تحويل فئات المزودين إلى أنواع المنصة الداخلية (PI-7)
 * اعتماد المالك 2026-08-30: Place Identity مستقل عن المزود — هذا الملف هو
 * نقطة الارتباط الوحيدة بمفرداته. إضافة مزود جديد = صفوف هنا فقط.
 * الفئة غير المعروفة → 'other' بلا تخمين، والفئة الخام تُحفظ دائمًا في
 * PlaceCandidate.providerCategory للتدقيق.
 * ═══════════════════════════════════════════════════════════════════════════
 * الأنواع الداخلية = PLACE_TYPES في place-intelligence-service.js حرفيًا:
 * hospital, health_center, school, university, police, prison, government,
 * mosque, mall, sports, public_facility, construction, operational_center, other
 * (لا نوع داخلي لـ park/hotel/gas_station — تُصنَّف بأقرب نوع مع توثيق الخام)
 */
'use strict';

/** مفاتيح Mapbox canonical (poi_category_ids / id الفئة) → النوع الداخلي */
const MAPBOX_CATEGORY_MAP = {
    school: 'school', kindergarten: 'school',
    university: 'university', college: 'university',
    hospital: 'hospital',
    clinic: 'health_center', medical_clinic: 'health_center', doctors: 'health_center',
    police_station: 'police',
    prison: 'prison',
    mosque: 'mosque',
    church: 'other', synagogue: 'other', temple: 'other',   // عبادة غير إسلامية — لا تُصنَّف مسجدًا
    place_of_worship: 'other',                               // عامة — لا تخمين
    park: 'public_facility', playground: 'sports', theme_park: 'public_facility',
    shopping_mall: 'mall', mall: 'mall',
    stadium: 'sports', sports_center: 'sports', gym: 'sports', sports_club: 'sports',
    government: 'government', government_offices: 'government',
    town_hall: 'government', courthouse: 'government', post_office: 'government',
    embassy: 'government', library: 'government', community_center: 'government',
    fire_station: 'government',                              // دفاع مدني — أقرب نوع داخلي، الخام موثق
    hotel: 'other', motel: 'other', hostel: 'other',
    gas_station: 'other', charging_station: 'other',
    ferry_terminal: 'other', bus_station: 'other', train_station: 'other', airport: 'other',
    cemetery: 'public_facility'
};

/** احتياط نصي: فئة عربية مُعادة (language=ar) → النوع الداخلي (يُستخدم عند غياب الـid) */
const ARABIC_CATEGORY_MAP = [
    ['مدرسة', 'school'], ['روضة', 'school'], ['حضانة', 'school'],
    ['جامعة', 'university'], ['كلية', 'university'],
    ['مستشفى', 'hospital'],
    ['عيادة', 'health_center'], ['مركز صحي', 'health_center'], ['مستوصف', 'health_center'],
    ['مركز شرطة', 'police'], ['شرطة', 'police'],
    ['سجن', 'prison'], ['إصلاحية', 'prison'],
    ['مسجد', 'mosque'], ['جامع', 'mosque'], ['مصلى', 'mosque'],
    ['حديقة', 'public_facility'], ['منتزه', 'public_facility'], ['ممشى', 'public_facility'],
    ['ملعب', 'sports'], ['استاد', 'sports'], ['نادي', 'sports'], ['صالة رياضية', 'sports'],
    ['مول', 'mall'], ['مركز تجاري', 'mall'], ['تسوق', 'mall'],
    ['حكومة', 'government'], ['بلدية', 'government'], ['أمانة', 'government'],
    ['محكمة', 'government'], ['وزارة', 'government'], ['دفاع مدني', 'government'],
    ['فندق', 'other'], ['محطة وقود', 'other'], ['وقود', 'other'], ['محطة', 'other']
];

const VALID_INTERNAL = new Set(['hospital', 'health_center', 'school', 'university',
    'police', 'prison', 'government', 'mosque', 'mall', 'sports', 'public_facility',
    'construction', 'operational_center', 'other']);

/**
 * تحويل فئات مزود إلى النوع الداخلي.
 * @param {string} provider       id المزود ('mapbox-searchbox'…)
 * @param {string[]} categories   الفئات الخام (ids و/أو أسماء مترجمة كما أعادها المزود)
 * @returns {string} InternalPlaceType — 'other' عند عدم المعرفة (بلا تخمين)
 */
function toInternalPlaceType(provider, categories) {
    if (!Array.isArray(categories)) return 'other';
    if (provider === 'mapbox-searchbox') {
        for (const c of categories) {
            const key = String(c || '').trim().toLowerCase();
            if (MAPBOX_CATEGORY_MAP[key]) return MAPBOX_CATEGORY_MAP[key];
        }
    }
    // احتياط نصي عام لأي مزود (فئات مترجمة/نصية) — الأكثر تحديدًا يفوز:
    // نجمع كل التطابقات ونختار صاحب أطول كلمة مفتاحية («مركز شرطة» تسبق «حكومة»)
    let best = null, bestLen = 0;
    for (const c of categories) {
        const s = String(c || '');
        for (const [kw, t] of ARABIC_CATEGORY_MAP) {
            if (s.includes(kw) && kw.length > bestLen) { best = t; bestLen = kw.length; }
        }
    }
    return best || 'other';
}

/** الفئات الافتراضية للبحث القريب في Mapbox (تُغطي قاموس أنواع المالك) */
const MAPBOX_DEFAULT_CATEGORIES = ['school', 'university', 'kindergarten', 'mosque',
    'police_station', 'fire_station', 'hospital', 'clinic', 'park', 'playground',
    'shopping_mall', 'stadium', 'hotel', 'gas_station', 'government'];

/** عكس النوع الداخلي إلى فئة Mapbox canonical (للترشيح الاختياري types) */
const INTERNAL_TO_MAPBOX = {
    school: ['school', 'kindergarten'], university: ['university'],
    hospital: ['hospital'], health_center: ['clinic'],
    police: ['police_station'], prison: ['prison'], mosque: ['mosque'],
    government: ['government', 'fire_station'], mall: ['shopping_mall'],
    sports: ['stadium', 'playground'], public_facility: ['park']
};

module.exports = { MAPBOX_CATEGORY_MAP, ARABIC_CATEGORY_MAP, MAPBOX_DEFAULT_CATEGORIES,
    INTERNAL_TO_MAPBOX, VALID_INTERNAL, toInternalPlaceType };
