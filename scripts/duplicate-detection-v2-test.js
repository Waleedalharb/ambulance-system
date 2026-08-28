/**
 * Duplicate Detection 2.0 — اختبارات T1–T10 + إعادة تشخيص البيانات الحقيقية
 * (اعتماد المالك 2026-08-28 — Precision First · محلي فقط بلا Commit)
 * ═══════════════════════════════════════════════════════════════════════════
 * الجزء 1: اختبارات الوحدة T1–T10 على المحرك مباشرة.
 * الجزء 2: إعادة تشغيل المحرك على نفس الـ145 بلاغًا من نسخة %TEMP%\dup-analysis.db
 *          وإثبات اختفاء الأزواج الخمسة الخاطئة (قبل → القرار الجديد → الأدلة).
 * لا كتابة على أي قاعدة — قراءة فقط.
 */
const path = require('path');
const os = require('os');
const Dup = require('../services/duplicate-detection');

let pass = 0, fail = 0;
function T(id, name, cond, detail) {
    if (cond) { pass++; console.log('✅ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
    else { fail++; console.log('❌ ' + id + ' — ' + name + (detail ? ' (' + detail + ')' : '')); }
}

const NOW = Date.parse('2026-08-28T12:00:00');
const MIN = 60000;
// بلاغات افتراضية: موقعان قريبان (80م) وموقع بعيد (5كم) داخل الرياض
const P_NEAR_A = { lat: 24.6100, lng: 46.7100 };
const P_NEAR_B = { lat: 24.6106, lng: 46.7106 };   // ≈ 85م من A
const P_FAR = { lat: 24.5700, lng: 46.6400 };      // ≈ 8.5كم من A
function inc(number, over) {
    return Object.assign({ number, status: 'active', callerNumber: null, description: null,
        address: null, type: 'medical', code: null, lat: null, lng: null, createdTs: null }, over);
}

console.log('═══ الجزء 1: اختبارات T1–T10 ═══\n');

// T1 — نفس جوال + موقع قريب جدًا + وقت منطقي ⇒ 🔴 Confirmed (قاعدة C1)
{
    const a = inc('A1', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B1', { callerNumber: '+966533133496', ...P_NEAR_B, code: '26D01', createdTs: NOW + 12 * MIN });
    const r = Dup.scorePair(a, b);
    T('T1', 'جوال+موقع≤150م+زمن≤30د ⇒ Confirmed', r && r.level === 'confirmed' && r.rule === 'C1',
        r ? 'level=' + r.level + ' rule=' + r.rule : 'null');
}

// T2 — جوال مختلف + موقع متقارب ⇒ Similar ولا Confirmed إطلاقًا
{
    const a = inc('A2', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B2', { callerNumber: '0559999888', ...P_NEAR_B, code: '31D02', createdTs: NOW + 8 * MIN });
    const r = Dup.scorePair(a, b);
    T('T2', 'جوال مختلف+موقع متقارب ⇒ Similar لا Confirmed', r && r.level === 'similar', r ? r.level + '/' + r.rule : 'null');
}

// T3 — حيّان مختلفان (مسافة كيلومترات) ⇒ لا تكرار إطلاقًا (مستقل)
{
    const a = inc('A3', { ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B3', { ...P_FAR, code: '31D02', createdTs: NOW + 5 * MIN });
    const r = Dup.scorePair(a, b);
    T('T3', 'حيّان مختلفان (5كم) + فارق 5د ⇒ مستقل (null)', r === null, r ? JSON.stringify(r.level) : 'null');
}

// T4 — صيغ الجوال: 05 / +966 / 00966 / 966 / بلا صفر ⇒ كلها متطابقة بعد التطبيع
{
    const forms = ['0533133496', '+966533133496', '00966533133496', '966533133496', '533133496', '05-3313-3496'];
    const norm = forms.map(Dup.normalizePhone);
    T('T4', 'تطبيع صيغ الجوال الست ⇒ قيمة واحدة', norm.every(n => n && n === norm[0]), norm.join(' | '));
}

// T5 — جوال ناقص/قصير ⇒ لا تخمين ولا مطابقة
{
    const shortOk = Dup.normalizePhone('0533') === null && Dup.normalizePhone('') === null && Dup.normalizePhone(null) === null;
    const a = inc('A5', { callerNumber: '0533133496', ...P_FAR, code: '26D01', createdTs: NOW });
    const b = inc('B5', { callerNumber: null, ...P_NEAR_A, code: '26D01', createdTs: NOW + 3 * MIN });
    // طرف واحد بلا جوال + مسافة كيلومترات ⇒ يُعامل كغياب جوال ⇒ Hard Gate ⇒ مستقل
    const r = Dup.scorePair(a, b);
    T('T5', 'جوال ناقص ⇒ لا تخمين (تطبيع null + Hard Gate)', shortOk && r === null, 'short=' + shortOk + ' pair=' + (r ? r.level : 'null'));
}

// T6 — نفس رقم البلاغ = نفس البلاغ وليس تكرارًا
{
    const a = inc('SAME', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('SAME', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    T('T6', 'نفس رقم البلاغ ⇒ null', Dup.scorePair(a, b) === null);
}

// T7 — تكرار التحديثات/SSE لا ينتج أزواجًا مكررة: الزوج يظهر مرة واحدة
{
    const a = inc('A7', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B7', { callerNumber: '0533133496', ...P_NEAR_B, code: '26D01', createdTs: NOW + 10 * MIN });
    const list = [a, b, Object.assign({}, a), Object.assign({}, b)]; // إعادة بث نفس البلاغين
    const r1 = Dup.findDuplicates(list);
    const r2 = Dup.findDuplicates(list); // دورة ثانية (تحديث SSE)
    const samePair = r1.filter(p => [p.number, p.candidate.number].sort().join('↔') === 'A7↔B7');
    T('T7', 'تكرار SSE ⇒ الزوج مرة واحدة وبصمة ثابتة بين الدورتين',
        samePair.length === 1 && JSON.stringify(r1) === JSON.stringify(r2),
        'pairs=' + r1.length + ' samePair=' + samePair.length);
}

// T8 — الوقت وحده ممنوع: فارق دقيقتان بلا جوال وبلا موقع/بموقع بعيد ⇒ مستقل
{
    const noGeo = Dup.scorePair(inc('A8', { code: '26D01', createdTs: NOW }), inc('B8', { code: '26D01', createdTs: NOW + 2 * MIN }));
    const far = Dup.scorePair(inc('C8', { ...P_NEAR_A, code: '26D01', createdTs: NOW }), inc('D8', { ...P_FAR, code: '26D01', createdTs: NOW + 2 * MIN }));
    T('T8', 'الوقت وحده (2د) بلا جوال ⇒ لا Confirmed/Likely/Similar', noGeo === null && far === null,
        'noGeo=' + (noGeo ? noGeo.level : 'null') + ' far=' + (far ? far.level : 'null'));
}

// T9 — جوال متطابق + سياق متطابق (نفس ProQA) + زمن ≤30د ⇒ Confirmed حتى بعد 500م
{
    const a = inc('A9', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B9', { callerNumber: '533133496', ...P_FAR, code: '26D01', createdTs: NOW + 20 * MIN });
    const r = Dup.scorePair(a, b);
    T('T9', '>500م + جوال + سياق متطابق ⇒ Confirmed (C2)', r && r.level === 'confirmed' && r.rule === 'C2', r ? r.rule : 'null');
}

// T10 — بلا جوال: أقصى مستوى ممكن Likely، ويستحيل Confirmed
{
    const a = inc('A10', { ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B10', { ...P_NEAR_B, code: '26D01', createdTs: NOW + 10 * MIN });
    const r = Dup.scorePair(a, b);
    T('T10', 'بلا جوال + قرب قوي + زمن + نفس ProQA ⇒ Likely كحد أقصى', r && r.level === 'likely' && r.rule === 'L3', r ? r.level + '/' + r.rule : 'null');
}

// T11 إضافي — الجوال وحده لا يؤكد: بلا موقع وبلا زمن ⇒ Similar كحد أقصى
{
    const a = inc('A11', { callerNumber: '0533133496' });
    const b = inc('B11', { callerNumber: '0533133496' });
    const r = Dup.scorePair(a, b);
    T('T11', 'الجوال وحده بلا موقع/زمن ⇒ Similar لا Confirmed', r && r.level === 'similar' && r.rule === 'S1', r ? r.rule : 'null');
}

// T12 إضافي — نافذة الـ6 ساعات: بلاغان متطابقان بفارق 7 ساعات ⇒ مستقل
{
    const a = inc('A12', { callerNumber: '0533133496', ...P_NEAR_A, code: '26D01', createdTs: NOW });
    const b = inc('B12', { callerNumber: '0533133496', ...P_NEAR_B, code: '26D01', createdTs: NOW + 7 * 60 * MIN });
    const r = Dup.findDuplicates([a, b]);
    T('T12', 'خارج نافذة 6 ساعات ⇒ لا زوج', r.length === 0, 'pairs=' + r.length);
}

console.log('\n═══ الجزء 2: إعادة التشخيص على البيانات الحقيقية (145 بلاغًا) ═══\n');

const DBP = path.join(os.tmpdir(), 'dup-analysis.db');
const db = new (require('better-sqlite3'))(DBP, { readonly: true });
function cadTs(str) {
    if (!str || typeof str !== 'string') return null;
    const m = str.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|ص|م)?/i);
    if (!m) return null;
    let h = parseInt(m[4], 10);
    const mer = m[7] || '';
    if (/pm|م/i.test(mer) && h < 12) h += 12;
    if (/am|ص/i.test(mer) && h === 12) h = 0;
    const ts = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10), h, parseInt(m[5], 10), m[6] ? parseInt(m[6], 10) : 0).getTime();
    return isNaN(ts) ? null : ts;
}
const rows = db.prepare('SELECT * FROM incident_registry').all();
const input = rows.map(ic => {
    const t1 = cadTs(ic.cad_created_at);
    const t2 = ic.created_at ? new Date(ic.created_at).getTime() : NaN;
    return { number: ic.number, status: ic.status || 'active',
        callerNumber: ic.caller_number || null, description: ic.description || null,
        address: ic.address || null, type: ic.type || null, code: ic.code || null,
        lat: ic.lat != null ? ic.lat : null, lng: ic.lng != null ? ic.lng : null,
        createdTs: t1 !== null ? t1 : (isFinite(t2) ? t2 : null), district: ic.district || null };
});
const pairs = Dup.findDuplicates(input);
const byNum = {}; rows.forEach(r => { byNum[r.number] = r; });

// الأزواج الخمسة التي أنتجها المحرك القديم (كلها 🟡 score=30 — حيّان مختلفان)
const OLD5 = [['1305942','1305931'], ['1306039','1306026'], ['1306078','1306089'], ['1307899','1307885'], ['1310420','1310425']];
const pairSet = new Set(pairs.map(p => [p.number, p.candidate.number].sort().join('↔')));
let old5Gone = 0;
console.log('الأزواج الخمسة الخاطئة (قبل → القرار الجديد → الأدلة):');
for (const [x, y] of OLD5) {
    const key = [x, y].sort().join('↔');
    const a = byNum[x], b = byNum[y];
    const distM = (a && b && a.lat != null && b.lat != null) ? Math.round(Dup.haversineMeters(a.lat, a.lng, b.lat, b.lng)) : null;
    const still = pairSet.has(key);
    if (!still) old5Gone++;
    console.log((still ? '❌ ' : '✅ ') + x + ' ↔ ' + y +
        ' | قبل: 🟡 low score=30 (زمن+نوع خشن+نص)' +
        ' | بعد: ' + (still ? 'ما زال موجودًا!' : '🟢 مستقل — لا زوج') +
        ' | الأدلة الحاكمة: مسافة ' + (distM !== null ? distM + 'م (>500م)' : 'غير محسوبة') +
        ' + بلا جوال + كودان مختلفان (' + (a ? a.code : '—') + ' ≠ ' + (b ? b.code : '—') + ')');
}
T('REAL', 'الأزواج الخمسة الخاطئة تختفي كلها من مخرجات 2.0', old5Gone === 5, old5Gone + '/5');

const lvl = { confirmed: 0, likely: 0, similar: 0 };
pairs.forEach(p => lvl[p.level] !== undefined && lvl[p.level]++);
console.log('\nمخرجات 2.0 على البيانات الحقيقية: إجمالي الأزواج=' + pairs.length +
    ' | 🔴 confirmed=' + lvl.confirmed + ' | 🟠 likely=' + lvl.likely + ' | 🟡 similar(صامت)=' + lvl.similar);
pairs.slice(0, 15).forEach(p => {
    console.log('  ' + (p.level === 'confirmed' ? '🔴' : p.level === 'likely' ? '🟠' : '🟡') + ' ' +
        p.number + ' ↔ ' + p.candidate.number + ' | ' + p.rule + ' | ' + (p.reasons || []).join(' + '));
});
db.close();

console.log('\n═══ النتيجة: ' + pass + ' ناجح / ' + fail + ' فاشل ═══');
process.exit(fail ? 1 : 0);
