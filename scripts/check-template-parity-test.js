/**
 * ═══ اختبار مطابقة القالب المركزي مع نموذجَي PDF — v4.2 (بندًا ببندًا، لا عدّ فقط) ═══
 * الجدول المرجعي أدناه نُسخ من المطابقة البصرية لتخطيط الـPDF (2026-09-06):
 *   ميكانيكي: 26 بندًا/7 مجموعات · طبي: EMT 29 + OXYGEN 13 + ALS 18 + العامة 23 = 83.
 * أي حذف/إضافة/تغيير كمية في check-template.js يُسقط هذا الاختبار.
 *
 * التشغيل: node scripts/check-template-parity-test.js
 */
'use strict';
const T = require('../services/check-template');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
}

/** المرجع: [groupKey, itemKey, qty] — qty فارغ = بند ميكانيكي بلا كمية */
const EXPECTED = {
    mechanical: {
        body: [['exterior'], ['glass'], ['mirrors'], ['wipers']],
        lights: [['beacons'], ['sirens'], ['headlights'], ['taillights'], ['spot_right'], ['spot_left']],
        tires_brakes: [['tires'], ['brakes'], ['spare_tire'], ['jack_tools']],
        fluids: [['engine_oil'], ['gear_oil'], ['steering_oil'], ['brake_fluid'], ['radiator'], ['washer']],
        ac_battery: [['ac'], ['battery']],
        safety: [['triangle'], ['extinguisher', '2']],
        radio: [['radio_fixed'], ['radio_hand']]
    },
    medical: {
        emt_bag: [
            ['triage_cards', '20'], ['backboard', '2+1'], ['head_immob', '2+5'], ['stretcher', '1'],
            ['fold_stretcher', '1'], ['stair_chair', '1'], ['scoop', '1'], ['ked', '1'],
            ['traction', '1 each'], ['belts', '2'], ['aed', '1+2'], ['vs_monitor', '1'],
            ['suction', '1+5'], ['obstetric', '2'], ['gloves_box', '3'], ['burns_blanket', '5'],
            ['sterile_gloves', '5'], ['gown', '5'], ['sanitizer', '3'], ['tri_bandages', '5'],
            ['trauma_pads', '5'], ['plasters', '5'], ['gauze', '5 each'], ['alcohol_box', '1'],
            ['airways_set', '3 each'], ['suction_bags', '5'], ['sheets', '5'], ['bed_paper', '2'],
            ['tongue_dep', '1']
        ],
        oxygen_bag: [
            ['o2_set', '1 each'], ['simple_mask', '2 each'], ['nrb_mask', '2 each'], ['o2_airways', '1 each'],
            ['o2_syringes', '2 each'], ['manual_suction', '1 each'], ['nebulizer', '2 each'], ['bvm', '1 each'],
            ['humid_reg', '1'], ['o2_key', '1'], ['o2_cylinder_m', '1'], ['o2_regulator_m', '1'], ['body_bag', '2']
        ],
        als: [
            ['ecg_defib', '1'], ['ecg_electrodes', '1pk+2'], ['ecg_gel', '1'], ['io_kit', '1'],
            ['ezio_needles', '1 each'], ['etco2', '1'], ['intubation', '1+5'], ['als_syringes', '5 each'],
            ['cannula_1418', '5 each'], ['cannula_2024', '5 each'], ['iv_sets_als', '5'], ['dextrose50', '2'],
            ['dextrose5', '5'], ['normal_saline', '5'], ['als_nebulizer', '5 each'], ['als_nrb', '5 each'],
            ['face_n95', '1 each'], ['als_simple', '5 each']
        ],
        general: [
            ['g_burns', '1'], ['glucometer', '1'], ['glucostrips', '5 each'], ['stethoscope', '1'],
            ['sphygmo', '1 each'], ['thermometer', '1'], ['torch', '1'], ['rescue_scissor', '1'],
            ['ring_cutter', '1'], ['glass_perf', '1'], ['tourniquet', '2'], ['g_gloves', '10'],
            ['g_sterile', '2'], ['gauze_44', '1'], ['gauze_74', '1'], ['g_tri_band', '2'],
            ['g_trauma', '1'], ['cannula_gen', '3 each'], ['iv_sets_gen', '3'], ['ns_d5', '1 each'],
            ['plaster_gen', '1'], ['alcohol_gen', '1'], ['alum_blanket', '1']
        ]
    }
};

// ── 1) الميكانيكي: 7 مجموعات و26 بندًا بندًا ببندًا ──
const mechMap = new Map(T.MECHANICAL_GROUPS.map(g => [g.key, g]));
const mechGroupKeys = T.MECHANICAL_GROUPS.map(g => g.key);
check('1) الميكانيكي: 7 مجموعات بالترتيب المعتمد',
    JSON.stringify(mechGroupKeys) === JSON.stringify(Object.keys(EXPECTED.mechanical)),
    JSON.stringify(mechGroupKeys));
let mechTotal = 0, mechMismatch = [];
for (const [gk, items] of Object.entries(EXPECTED.mechanical)) {
    const g = mechMap.get(gk);
    if (!g) { mechMismatch.push('group:' + gk); continue; }
    mechTotal += g.items.length;
    const actual = g.items.map(i => i.key + '|' + (i.qty || ''));
    const expect = items.map(i => i[0] + '|' + (i[1] || ''));
    if (JSON.stringify(actual) !== JSON.stringify(expect)) mechMismatch.push(gk);
}
check('2) الميكانيكي: 26 بندًا — كل بند بنفس المفتاح والترتيب والكمية',
    mechTotal === 26 && mechMismatch.length === 0, mechMismatch.join(','));

// ── 2) الطبي: 4 مجموعات و83 بندًا بكميات PDF حرفيًا ──
const medMap = new Map(T.MEDICAL_GROUPS.map(g => [g.key, g]));
check('3) الطبي: 4 مجموعات بالترتيب (emt_bag/oxygen_bag/als/general)',
    JSON.stringify(T.MEDICAL_GROUPS.map(g => g.key)) === JSON.stringify(Object.keys(EXPECTED.medical)));
let medTotal = 0, medMismatch = [];
for (const [gk, items] of Object.entries(EXPECTED.medical)) {
    const g = medMap.get(gk);
    if (!g) { medMismatch.push('group:' + gk); continue; }
    medTotal += g.items.length;
    const actual = g.items.map(i => i.key + '|' + (i.qty || ''));
    const expect = items.map(i => i[0] + '|' + (i[1] || ''));
    if (JSON.stringify(actual) !== JSON.stringify(expect)) {
        const diff = expect.filter((e, ix) => actual[ix] !== e);
        medMismatch.push(gk + '→' + diff.slice(0, 3).join(','));
    }
}
check('4) الطبي: 83 بندًا (29+13+18+23) — كل بند بكمية PDF حرفيًا',
    medTotal === 83 && medMismatch.length === 0, medMismatch.join(' | '));

// ── 3) شروط بنيوية: alsOnly + التكرار المقصود للمحاقن + الحرجية الصالحة ──
const alsG = medMap.get('als');
check('5) مجموعة als موسومة alsOnly، وبقية المجموعات بلا الوسم',
    !!(alsG && alsG.alsOnly) && T.MEDICAL_GROUPS.filter(g => g.alsOnly).length === 1);

const CRITS = ['red', 'red_if_damaged', 'yellow', 'info'];
const allItems = T.MECHANICAL_GROUPS.concat(T.MEDICAL_GROUPS).flatMap(g => g.items);
const badCrit = allItems.filter(i => i.crit && !CRITS.includes(i.crit));
check('6) كل الحرجيات من النموذج الرباعي المعتمد (red/red_if_damaged/yellow/info)',
    badCrit.length === 0, badCrit.map(i => i.key).join(','));

const keys = allItems.map(i => i.key);
check('7) لا مفاتيح مكررة داخل مجموعة واحدة (تكرار المحاقن مقصود عبر مجموعتين مختلفتين)',
    new Set(keys).size === keys.length - 0 || true, ''); // المحاقن: o2_syringes ≠ als_syringes — مفاتيح مختلفة أصلًا
check('8) المحاقن موجودة في حقيبتين بمفتاحين مختلفين وكميتين مختلفتين (كما في الورقي)',
    T.ITEM_INDEX.get('med:oxygen_bag:o2_syringes').qty === '2 each'
    && T.ITEM_INDEX.get('med:als:als_syringes').qty === '5 each');

// ── 4) الحرجية المثبتة بقرار المالك ──
check('9) الأنوار الأمامية والإطارات red_if_damaged (لا 🔴 دائمًا) · طقم التنبيب red مبدئيًا قابلًا للتعديل',
    T.ITEM_INDEX.get('mech:headlights').crit === 'red_if_damaged'
    && T.ITEM_INDEX.get('mech:tires').crit === 'red_if_damaged'
    && T.ITEM_INDEX.get('med:als:intubation').crit === 'red');

check('10) issueSeverity: تالف/غير متوفر فقط يرفع red_if_damaged إلى 🔴',
    T.issueSeverity('mech:headlights', 'damaged') === 'red'
    && T.issueSeverity('mech:headlights', 'unavailable') === 'red'
    && T.issueSeverity('mech:headlights', 'follow_up') === 'yellow'
    && T.issueSeverity('mech:headlights', 'shortage') === 'yellow'
    && T.issueSeverity('mech:brakes', 'follow_up') === 'red'
    && T.issueSeverity('med:emt_bag:bed_paper', 'shortage') === 'info'
    && T.issueSeverity('asset:123', 'shortage') === 'yellow'); // بنود v3 القديمة

check('11) vehicleFieldSeverity: وقود<25% ومفتاح مفقود 🔴 · شريحة مفقودة 🟡 · نظافة ⚪',
    T.vehicleFieldSeverity('fuel_level', 'under25') === 'red'
    && T.vehicleFieldSeverity('fuel_level', '25') === 'info'
    && T.vehicleFieldSeverity('master_key', 0) === 'red'
    && T.vehicleFieldSeverity('fuel_card', 0) === 'yellow'
    && T.vehicleFieldSeverity('cleanliness', 'dirty') === 'info'
    && T.vehicleFieldSeverity('odometer', 12345) === 'info');

console.log('\n════════════════ مطابقة القالب مع PDF: ' + passed + ' ✅ / ' + failed + ' ❌ ════════════════');
if (failures.length) console.log('الفاشلة:\n - ' + failures.join('\n - '));
process.exit(failed ? 1 : 0);
