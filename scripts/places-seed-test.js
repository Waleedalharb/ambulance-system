/**
 * places-seed-test.js — الاختبارات العشرة الإلزامية لإصلاح Seed Safety
 * (أمر المالك 2026-08-29 بعد فشل Seed Safety Audit)
 * ═══════════════════════════════════════════════════════════════════════════
 * كل تشغيل في sandbox معزول (نسخة byte-identical من places-seed.js الحقيقي) —
 * صفر لمس لبيانات المشروع. السلوك المعتمد: reconcile (يضيف الغائب فقط) وليس
 * rebuild — الموقع الموجود لا يُمس إطلاقًا، والنسخة ترتفع فقط عند تغيير فعلي.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

function mkSandbox() {
    const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));
    fs.mkdirSync(path.join(sb, 'data'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'public', 'js'), { recursive: true });
    fs.mkdirSync(path.join(sb, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'scripts', 'places-seed.js'), path.join(sb, 'scripts', 'places-seed.js'));
    fs.copyFileSync(path.join(ROOT, 'data', 'map-locations.json'), path.join(sb, 'data', 'map-locations.json'));
    fs.copyFileSync(path.join(ROOT, 'public', 'js', 'app.js'), path.join(sb, 'public', 'js', 'app.js'));
    return sb;
}
const outPath = (sb) => path.join(sb, 'data', 'places.json');
const readOut = (sb) => JSON.parse(fs.readFileSync(outPath(sb), 'utf8'));
const writeOut = (sb, o) => fs.writeFileSync(outPath(sb), JSON.stringify(o, null, 2));
const run = (sb) => execSync('node scripts/places-seed.js', { cwd: sb, encoding: 'utf8' }).trim();
const seedHospitalId = (o) => Object.keys(o.places).find(k => o.places[k].source === 'seed' && o.places[k].placeType === 'hospital');

(async () => {
console.log('═══ Seed Safety — الاختبارات العشرة الإلزامية ═══\n');

// ── ① empty → seed ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    T('T1', 'empty → seed: 21 موقعًا · v1', o.placesVersion === 1 && Object.keys(o.places).length === 21,
        'v=' + o.placesVersion + ' مواقع=' + Object.keys(o.places).length);
}

// ── ② seed → seed: نفس المواقع والقيم والنسخة + byte-identical ──
{
    const sb = mkSandbox();
    run(sb);
    const b1 = fs.readFileSync(outPath(sb), 'utf8');
    const log2 = run(sb);
    const b2 = fs.readFileSync(outPath(sb), 'utf8');
    const o = readOut(sb);
    T('T2', 'seed → seed: byte-identical · نفس v1 · لا كتابة ثانية', b1 === b2 && o.placesVersion === 1 && /بلا تغيير/.test(log2),
        'identical=' + (b1 === b2) + ' · v=' + o.placesVersion + ' · log=«بلا تغيير»');
}

// ── ③ ضبط radiusM بشري على موقع بذري ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    const id = seedHospitalId(o);
    o.places[id].radiusM = 280;
    writeOut(sb, o);
    run(sb);
    const o2 = readOut(sb);
    T('T3', 'seeded + human radiusM 200→280 ← يبقى 280', o2.places[id].radiusM === 280, 'radiusM=' + o2.places[id].radiusM);
}

// ── ④ إيقاف بشري (status) على موقع بذري ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    const id = seedHospitalId(o);
    o.places[id].status = 'retired';
    writeOut(sb, o);
    run(sb);
    const o2 = readOut(sb);
    T('T4', 'seeded + human status active→retired ← يبقى retired', o2.places[id].status === 'retired', 'status=' + o2.places[id].status);
}

// ── ⑤ evidence بشرية على موقع بذري ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    const id = seedHospitalId(o);
    const n0 = o.places[id].evidence.length;
    o.places[id].evidence.push({ at: '2026-08-29T01:00:00Z', by: 'owner', note: 'ضبط حرم بعد مراجعة ميدانية' });
    writeOut(sb, o);
    run(sb);
    const o2 = readOut(sb);
    const kept = o2.places[id].evidence.length === n0 + 1 && o2.places[id].evidence.some(e => e.by === 'owner');
    T('T5', 'seeded + evidence بشرية ← تبقى كاملة', kept, 'evidence=' + o2.places[id].evidence.length + ' (كانت ' + n0 + '+1)');
}

// ── ⑥ name/nameVariants بشرية على موقع بذري ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    const id = seedHospitalId(o);
    o.places[id].name = 'مستشفى الملك فهد — المسمى المعتمد';
    o.places[id].nameVariants.push('مستشفى الملك فهد العام');
    o.places[id].district = 'حي النرجس';
    writeOut(sb, o);
    run(sb);
    const o2 = readOut(sb);
    T('T6', 'seeded + name/nameVariants/district بشرية ← تبقى',
        o2.places[id].name === 'مستشفى الملك فهد — المسمى المعتمد' &&
        o2.places[id].nameVariants.includes('مستشفى الملك فهد العام') &&
        o2.places[id].district === 'حي النرجس',
        'name محفوظ · variants=' + o2.places[id].nameVariants.length + ' · district=' + o2.places[id].district);
}

// ── ⑦ manual + learned + candidate + rejected تبقى بلا تغيير ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    o.places['plc_manual1'] = { placeId: 'plc_manual1', placeType: 'school', name: 'يدوية', lat: 1, lng: 1, radiusM: 65, source: 'manual', status: 'active', evidence: [{ by: 'owner' }] };
    o.places['plc_learned1'] = { placeId: 'plc_learned1', placeType: 'mosque', name: 'مكتشفة', lat: 2, lng: 2, radiusM: 120, source: 'learned', status: 'active', evidence: [] };
    o.places['plc_cand1'] = { placeId: 'plc_cand1', placeType: 'school', name: 'مرشحة', lat: 3, lng: 3, radiusM: 150, source: 'learned', status: 'candidate', evidence: [] };
    o.places['plc_rej1'] = { placeId: 'plc_rej1', placeType: 'mall', name: 'مرفوضة', lat: 4, lng: 4, radiusM: 100, source: 'learned', status: 'rejected', evidence: [] };
    const before = JSON.stringify([o.places['plc_manual1'], o.places['plc_learned1'], o.places['plc_cand1'], o.places['plc_rej1']]);
    writeOut(sb, o);
    run(sb);
    const o2 = readOut(sb);
    const after = JSON.stringify([o2.places['plc_manual1'], o2.places['plc_learned1'], o2.places['plc_cand1'], o2.places['plc_rej1']]);
    T('T7', 'manual/learned/candidate/rejected ← الأربعة محفوظة byte-identical', before === after && Object.keys(o2.places).length === 25,
        'identical=' + (before === after) + ' · إجمالي=25');
}

// ── ⑧ placesVersion لا تتحرك بلا تغيير ──
{
    const sb = mkSandbox();
    run(sb);
    const v1 = readOut(sb).placesVersion;
    run(sb); run(sb);
    const v3 = readOut(sb).placesVersion;
    T('T8', '3 تشغيلات: النسخة لا تتحرك بلا تغيير فعلي', v1 === 1 && v3 === 1, 'v: ' + v1 + ' → ' + v3);
}

// ── ⑨ idempotency كاملة: 3 تشغيلات = الحالة بعد الأول ──
{
    const sb = mkSandbox();
    run(sb);
    const s1 = fs.readFileSync(outPath(sb), 'utf8');
    run(sb); run(sb);
    const s3 = fs.readFileSync(outPath(sb), 'utf8');
    T('T9', 'idempotency: الحالة بعد 3 تشغيلات = بعد الأول (byte-identical)', s1 === s3, 'identical=' + (s1 === s3));
}

// ── ⑩ لا مسار يعيد seeded place للـdefaults بعد اعتماد بشري (سيناريو مركّب) ──
{
    const sb = mkSandbox();
    run(sb);
    const o = readOut(sb);
    const id = seedHospitalId(o);
    // اعتماد بشري مركّب: كل الحقول الحساسة دفعة واحدة
    o.places[id].radiusM = 62; o.places[id].status = 'retired';
    o.places[id].name = 'اسم معتمد'; o.places[id].nameVariants = ['اسم معتمد', 'بديل'];
    o.places[id].district = 'حي معتمد'; o.places[id].evidence.push({ by: 'owner', note: 'اعتماد مركّب' });
    writeOut(sb, o);
    run(sb); run(sb); run(sb); // ثلاث مرات — تحت أي ظرف
    const o2 = readOut(sb);
    const p = o2.places[id];
    const intact = p.radiusM === 62 && p.status === 'retired' && p.name === 'اسم معتمد' &&
        p.nameVariants.length === 2 && p.district === 'حي معتمد' && p.evidence.some(e => e.by === 'owner');
    T('T10', 'اعتماد بشري مركّب + 3 تشغيلات seed ← كل شيء محفوظ', intact,
        intact ? 'كل الحقول السبعة محفوظة' : JSON.stringify({ r: p.radiusM, s: p.status }));
}

console.log('\n════════════════════════════════');
console.log('النتيجة: ' + pass + ' ✅ · ' + fail + ' ❌');
process.exit(fail ? 1 : 0);
})().catch(err => { console.error('❌ خطأ عام:', err); process.exit(1); });
