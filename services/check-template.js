/**
 * ═══ check-template.js — القالب المركزي لنظام التشييك الذكي v4.2 (معتمد مبدئيًا 2026-09-06) ═══
 *
 * المصدر الوحيد لـ: المجموعات ← البنود ← الكمية المطلوبة ← الحرجية ← شرط الظهور.
 * تعديل الحرجية أو الكميات يتم هنا فقط — دون لمس أي واجهة أو منطق.
 *
 * نموذج الحرجية (قرار المالك):
 *   red             — أي مشكلة فيه → 🔴 غير جاهزة
 *   red_if_damaged  — 🔴 فقط عند «تالف/غير متوفر»؛ «ناقص/يحتاج متابعة» يبقى 🟡
 *                     (الأنوار الأمامية والإطارات — تعديل المالك: لا 🔴 دائمًا دون مراعاة أثر العطل)
 *   yellow          — مشكلته 🟡 جاهزة مع ملاحظة
 *   info            — ⚪ توثيق فقط، لا أثر على الجاهزية
 *
 * ملاحظات اعتماد:
 *   · اسم مجموعة general «المعدات العامة» مؤقت حتى مراجعة النسخة الورقية.
 *   · البنود والكميات حرفية من نموذجي PDF (المطابقة البصرية 2026-09-06).
 *   · المحاقن مكررة في النموذج الورقي نفسه (OXYGEN ×2each وALS ×5each) — أُبقي التكرار.
 *   · طقم التنبيب ALS مصنّف red مبدئيًا قابلًا للتعديل — بانتظار الاعتماد التشغيلي/الطبي.
 *   · ظهور مجموعة ALS يعتمد على vehicles.service_level الصريح فقط (لا مطابقة نصية
 *     على الموديل)؛ المركبة غير المصنّفة تُعامل BLS مؤقتًا وتُوسم «غير مؤكد» في الواجهة.
 */
'use strict';

/** مدة صلاحية «لا تغيير» بالساعات — أقدم منها يُفتح التفصيل إجباريًا. */
const NO_CHANGE_MAX_AGE_HOURS = 24;

/** حالات البند التفصيلية (الإدخال بالضغط). */
const ITEM_STATUSES = ['complete', 'shortage', 'damaged', 'unavailable', 'follow_up'];

/** حقول المركبة الثابتة (ترويسة نموذج السائق). */
const VEHICLE_FIELDS = {
    odometer:   { label: 'قراءة العداد', type: 'number', crit: 'info' },
    fuel_level: { label: 'كمية الوقود', type: 'choice', options: ['100', '75', '50', '25', 'under25'], crit: 'red_if', redWhen: 'under25' },
    cleanliness:{ label: 'النظافة (خارجية/داخلية)', type: 'choice', options: ['clean', 'dirty'], crit: 'info' },
    master_key: { label: 'مفتاح السيارة الأساسي', type: 'present', crit: 'red_if', redWhen: 0 },
    fuel_card:  { label: 'شريحة التزود بالوقود', type: 'present', crit: 'yellow_if', yellowWhen: 0 }
};

/** ═══ الميكانيكي — نموذج «تشييك السائق»: 26 بندًا في 7 مجموعات ═══ */
const MECHANICAL_GROUPS = [
    { key: 'body', label: 'الهيكل والزجاج والمرايا', items: [
        { key: 'exterior',    label: 'الهيكل الخارجي',        crit: 'yellow' },
        { key: 'glass',       label: 'زجاج السيارة',          crit: 'yellow' },
        { key: 'mirrors',     label: 'المرايا الجانبية',      crit: 'yellow' },
        { key: 'wipers',      label: 'مساحات الزجاج',         crit: 'yellow' }
    ]},
    { key: 'lights', label: 'الأنوار والإنذارات', items: [
        { key: 'beacons',     label: 'الأنوار التحذيرية (السفتي)',  crit: 'red' },
        { key: 'sirens',      label: 'الأصوات التحذيرية (الونان)',  crit: 'red' },
        { key: 'headlights',  label: 'الأنوار الأمامية',            crit: 'red_if_damaged' },
        { key: 'taillights',  label: 'الأنوار الخلفية',             crit: 'red' },
        { key: 'spot_right',  label: 'الكشافات الجانبية اليمنى',    crit: 'yellow' },
        { key: 'spot_left',   label: 'الكشافات الجانبية اليسرى',    crit: 'yellow' }
    ]},
    { key: 'tires_brakes', label: 'الإطارات والفرامل', items: [
        { key: 'tires',       label: 'إطارات الدواليب الأربعة',     crit: 'red_if_damaged' },
        { key: 'brakes',      label: 'الفرامل',                     crit: 'red' },
        { key: 'spare_tire',  label: 'الإطار الاحتياطي',            crit: 'yellow' },
        { key: 'jack_tools',  label: 'العفريتة ومفتاح العجل',       crit: 'yellow' }
    ]},
    { key: 'fluids', label: 'الزيوت والسوائل', items: [
        { key: 'engine_oil',  label: 'زيت المحرك',              crit: 'yellow' },
        { key: 'gear_oil',    label: 'زيت القير',               crit: 'yellow' },
        { key: 'steering_oil',label: 'زيت الدركسيون',           crit: 'yellow' },
        { key: 'brake_fluid', label: 'زيت الفرامل',             crit: 'red' },
        { key: 'radiator',    label: 'سائل الرديتر',            crit: 'yellow' },
        { key: 'washer',      label: 'سائل مساحات الزجاج',      crit: 'yellow' }
    ]},
    { key: 'ac_battery', label: 'التكييف والبطارية', items: [
        { key: 'ac',          label: 'التكييف الداخلي',         crit: 'yellow' },
        { key: 'battery',     label: 'بطارية السيارة',          crit: 'yellow' }
    ]},
    { key: 'safety', label: 'معدات السلامة', items: [
        { key: 'triangle',    label: 'المثلث وأسلاك الاشتراك',  crit: 'yellow' },
        { key: 'extinguisher',label: 'طفاية الحريق', qty: '2',  crit: 'yellow' }
    ]},
    { key: 'radio', label: 'أجهزة اللاسلكي', items: [
        { key: 'radio_fixed', label: 'جهاز اللاسلكي الثابت في السيارة', crit: 'red' },
        { key: 'radio_hand',  label: 'جهاز اللاسلكي اليدوي + الشاحن',   crit: 'yellow' }
    ]}
];

/** ═══ الطبي — نموذج Ambulance Equipments - Supplies Check-List (بعد المطابقة البصرية) ═══ */
const MEDICAL_GROUPS = [
    { key: 'emt_bag', label: 'حقيبة EMT', items: [
        { key: 'triage_cards',   label: 'بطاقات الفرز (Triage Cards)',                    qty: '20' },
        { key: 'backboard',      label: 'لوح الظهر A+P',                                  qty: '2+1' },
        { key: 'head_immob',     label: 'مثبت الرأس وطوق الرقبة',                         qty: '2+5' },
        { key: 'stretcher',      label: 'النقالة المتحركة (Wheeled Stretcher)',           qty: '1', crit: 'red' },
        { key: 'fold_stretcher', label: 'النقالة القابلة للطي',                           qty: '1' },
        { key: 'stair_chair',    label: 'كرسي السلالم',                                   qty: '1' },
        { key: 'scoop',          label: 'النقالة المغرفة (Scoop)',                        qty: '1' },
        { key: 'ked',            label: 'K.E.D',                                          qty: '1' },
        { key: 'traction',       label: 'جبائر الشد A+P',                                 qty: '1 each' },
        { key: 'belts',          label: 'الأحزمة',                                        qty: '2' },
        { key: 'aed',            label: 'جهاز AED + أقطاب A+P',                           qty: '1+2', crit: 'red' },
        { key: 'vs_monitor',     label: 'جهاز العلامات الحيوية + أقطاب ECG',              qty: '1' },
        { key: 'suction',        label: 'الشفاط المحمول + الأنابيب',                      qty: '1+5', crit: 'red' },
        { key: 'obstetric',      label: 'طقم الولادة (Obstetric Sets)',                   qty: '2' },
        { key: 'gloves_box',     label: 'علبة القفازات',                                  qty: '3' },
        { key: 'burns_blanket',  label: 'بطانيات الحروق',                                 qty: '5' },
        { key: 'sterile_gloves', label: 'قفازات معقمة',                                   qty: '5' },
        { key: 'gown',           label: 'العباءة (Gown)',                                 qty: '5' },
        { key: 'sanitizer',      label: 'معقم اليدين',                                    qty: '3' },
        { key: 'tri_bandages',   label: 'الضمادات المثلثة',                               qty: '5' },
        { key: 'trauma_pads',    label: 'ضمادات الإصابات (Trauma Pads)',                  qty: '5' },
        { key: 'plasters',       label: 'اللصقات (Plasters)',                             qty: '5' },
        { key: 'gauze',          label: 'شاش 4×4 + 7×4',                                  qty: '5 each' },
        { key: 'alcohol_box',    label: 'علبة مسحات الكحول',                              qty: '1' },
        { key: 'airways_set',    label: 'طقم المجاري الهوائية الفموية + الأنفية',         qty: '3 each' },
        { key: 'suction_bags',   label: 'أكياس الشفط (Disposable)',                       qty: '5' },
        { key: 'sheets',         label: 'الملاءات',                                       qty: '5' },
        { key: 'bed_paper',      label: 'رول ورق الأسرة',                                 qty: '2', crit: 'info' },
        { key: 'tongue_dep',     label: 'خافض اللسان',                                    qty: '1', crit: 'info' }
    ]},
    { key: 'oxygen_bag', label: 'حقيبة الأكسجين', items: [
        { key: 'o2_set',         label: 'أسطوانة الأكسجين + المنظم + الفاتحة',            qty: '1 each', crit: 'red' },
        { key: 'simple_mask',    label: 'القناع البسيط A+P',                              qty: '2 each' },
        { key: 'nrb_mask',       label: 'أقنعة Non-Rebreather A+P',                       qty: '2 each' },
        { key: 'o2_airways',     label: 'طقم المجاري الهوائية الفموية + الأنفية',         qty: '1 each' },
        { key: 'o2_syringes',    label: 'محاقن 3/5/10 مل (داخل الحقيبة)',                 qty: '2 each' },
        { key: 'manual_suction', label: 'جهاز الشفط اليدوي + الأنابيب',                   qty: '1 each' },
        { key: 'nebulizer',      label: 'جهاز التبخيرة A+P',                              qty: '2 each' },
        { key: 'bvm',            label: 'أقنعة كيس الصمام BVM (A+P+I)',                   qty: '1 each', crit: 'red' },
        { key: 'humid_reg',      label: 'منظم O² المرطب (M)',                             qty: '1', crit: 'red' },
        { key: 'o2_key',         label: 'مفتاح أسطوانة O²',                               qty: '1' },
        { key: 'o2_cylinder_m',  label: 'أسطوانة O² (M)',                                 qty: '1', crit: 'red' },
        { key: 'o2_regulator_m', label: 'منظم O² (M)',                                    qty: '1', crit: 'red' },
        { key: 'body_bag',       label: 'أكياس الموتى (Dead Body Bag)',                   qty: '2', crit: 'info' }
    ]},
    { key: 'als', label: 'ALS Only', alsOnly: true, items: [
        { key: 'ecg_defib',      label: 'شاشة ECG + الصاعق',                              qty: '1', crit: 'red' },
        { key: 'ecg_electrodes', label: 'أقطاب وصفائح ECG والصاعق',                       qty: '1pk+2' },
        { key: 'ecg_gel',        label: 'جل ECG',                                         qty: '1' },
        { key: 'io_kit',         label: 'طقم I.O',                                        qty: '1' },
        { key: 'ezio_needles',   label: 'إبر EZ-IO',                                      qty: '1 each' },
        { key: 'etco2',          label: 'كاشف CO² (End Tidal)',                           qty: '1' },
        { key: 'intubation',     label: 'طقم التنبيب + الأنابيب',                         qty: '1+5', crit: 'red' }, // مبدئي قابل للتعديل — بانتظار الاعتماد التشغيلي/الطبي
        { key: 'als_syringes',   label: 'محاقن 3/5/10 مل (ALS)',                          qty: '5 each' },
        { key: 'cannula_1418',   label: 'قساطر وريدية 14-18',                             qty: '5 each' },
        { key: 'cannula_2024',   label: 'قساطر وريدية 20-22-24',                          qty: '5 each' },
        { key: 'iv_sets_als',    label: 'أطقم المحاليل (ALS)',                            qty: '5' },
        { key: 'dextrose50',     label: 'دكستروز 50%',                                    qty: '2' },
        { key: 'dextrose5',      label: 'دكستروز 5%',                                     qty: '5' },
        { key: 'normal_saline',  label: 'محلول ملح 0.9%',                                 qty: '5' },
        { key: 'als_nebulizer',  label: 'جهاز التبخيرة A+P (ALS)',                        qty: '5 each' },
        { key: 'als_nrb',        label: 'أقنعة Non-Rebreather A+P (ALS)',                 qty: '5 each' },
        { key: 'face_n95',       label: 'كمامة وجه + N95',                                qty: '1 each' },
        { key: 'als_simple',     label: 'القناع البسيط A+P (ALS)',                        qty: '5 each' }
    ]},
    { key: 'general', label: 'المعدات العامة', nameStatus: 'temporary', items: [ // الاسم مؤقت حتى مراجعة الورقي
        { key: 'g_burns',        label: 'بطانية الحروق',                                  qty: '1' },
        { key: 'glucometer',     label: 'جهاز قياس السكر',                                qty: '1' },
        { key: 'glucostrips',    label: 'شرائط السكر + عصا الوخز',                        qty: '5 each' },
        { key: 'stethoscope',    label: 'السماعة الطبية',                                 qty: '1' },
        { key: 'sphygmo',        label: 'جهاز قياس الضغط A+P',                            qty: '1 each' },
        { key: 'thermometer',    label: 'ميزان الحرارة',                                  qty: '1' },
        { key: 'torch',          label: 'المصباح القلمي',                                 qty: '1' },
        { key: 'rescue_scissor', label: 'مقص الإنقاذ',                                    qty: '1' },
        { key: 'ring_cutter',    label: 'قاطع الخواتم',                                   qty: '1' },
        { key: 'glass_perf',     label: 'ثاقب الزجاج',                                    qty: '1' },
        { key: 'tourniquet',     label: 'العاصبة (Tourniquet)',                           qty: '2' },
        { key: 'g_gloves',       label: 'القفازات (أزواج)',                               qty: '10' },
        { key: 'g_sterile',      label: 'قفازات معقمة (أزواج)',                           qty: '2' },
        { key: 'gauze_44',       label: 'شاش 4×4',                                        qty: '1' },
        { key: 'gauze_74',       label: 'شاش 7×4',                                        qty: '1' },
        { key: 'g_tri_band',     label: 'ضمادات مثلثة',                                   qty: '2' },
        { key: 'g_trauma',       label: 'ضمادات إصابات',                                  qty: '1' },
        { key: 'cannula_gen',    label: 'قساطر وريدية 18-20-22-24',                       qty: '3 each' },
        { key: 'iv_sets_gen',    label: 'أطقم المحاليل',                                  qty: '3' },
        { key: 'ns_d5',          label: 'محلول NS + D5%',                                 qty: '1 each' },
        { key: 'plaster_gen',    label: 'اللصق (Plaster)',                                qty: '1' },
        { key: 'alcohol_gen',    label: 'مسحات الكحول (علبة)',                            qty: '1' },
        { key: 'alum_blanket',   label: 'بطانية الإنقاذ الألمنيوم',                       qty: '1' }
    ]}
];

/** فهرس مسطّح: item_key ← { groupKey, domain, label, qty, crit, alsOnly } */
function buildIndex() {
    const idx = new Map();
    for (const g of MECHANICAL_GROUPS)
        for (const it of g.items)
            idx.set('mech:' + it.key, { domain: 'mechanical', groupKey: g.key, groupLabel: g.label, crit: 'yellow', ...it });
    for (const g of MEDICAL_GROUPS)
        for (const it of g.items)
            idx.set('med:' + g.key + ':' + it.key, { domain: 'medical', groupKey: g.key, groupLabel: g.label, alsOnly: !!g.alsOnly, crit: 'yellow', ...it });
    return idx;
}
const ITEM_INDEX = buildIndex();

/** مجموعات قسم الأصول (لقطة عهدة الفرقة) — مستقل عن القالب، مفتاحه asset:<id>. */
const ASSETS_GROUP = { key: 'assets', label: 'الأصول المسجلة على الفرقة' };

/**
 * حرجية مشكلة بند: 'red' | 'yellow' | 'info' | null (بند قديم v3 بلا قالب ← yellow).
 * red_if_damaged: 🔴 فقط عند تالف/غير متوفر.
 */
function issueSeverity(itemKey, statusDetail) {
    const t = ITEM_INDEX.get(itemKey);
    if (!t) return 'yellow'; // بنود v3 القديمة (asset:<id> وmech القديمة)
    const c = t.crit || 'yellow';
    if (c === 'red') return 'red';
    if (c === 'red_if_damaged') return (statusDetail === 'damaged' || statusDetail === 'unavailable') ? 'red' : 'yellow';
    return c; // yellow | info
}

/** حرجية حقول المركبة الثابتة. */
function vehicleFieldSeverity(field, value) {
    const f = VEHICLE_FIELDS[field];
    if (!f || value == null || value === '') return null;
    if (f.crit === 'red_if' && String(value) === String(f.redWhen)) return 'red';
    if (f.crit === 'yellow_if' && String(value) === String(f.yellowWhen)) return 'yellow';
    return 'info';
}

module.exports = {
    NO_CHANGE_MAX_AGE_HOURS,
    ITEM_STATUSES,
    VEHICLE_FIELDS,
    MECHANICAL_GROUPS,
    MEDICAL_GROUPS,
    ASSETS_GROUP,
    ITEM_INDEX,
    issueSeverity,
    vehicleFieldSeverity
};
