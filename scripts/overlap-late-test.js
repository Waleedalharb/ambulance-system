/**
 * اختبارات مرحلة الأوفرلاب 3 — التأخير لكل موظف + ترحيل الأحداث المفتوحة
 * ═══════════════════════════════════════════════════════════════════════
 * نفس نمط العزل في overlap-codes-test.js / hours-metrics-test.js حرفيًا:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (يُضبط قبل require db.js).
 *   - الكتابة عبر الكاتب الرسمي فقط: RosterSyncService للكادر،
 *     StorageAdapter.appendOperationalEvent للأحداث (append-only).
 *   - deriveLateRecords/lateNote تُستخرج من المصدر الفعلي (regex + عدّ أقواس
 *     متزنة) وتُقيَّم في sandbox (vm) — تُختبر النسخة المنشورة لا نسخة مكررة.
 *   - التواريخ مفصولة بين مجموعات الاختبارات حتى لا تتداخل منطقة الترحيل:
 *       2026-08-20 صباحية (①②⑤⑦⑧⑨⑬) — بلا ليلية 2026-08-19 ⇒ بلا ترحيل.
 *       2026-08-21 ليلية  (③④⑥)      — بلا صباحية 2026-08-21 ⇒ بلا ترحيل.
 *       2026-08-22 صباحية+ليلية (⑩) — سيناريو الترحيل الكامل.
 *   - أكواد RRA: الصيغة الجديدة الموقعة (RRA1-D-04 صباحية · RRA1-N-16 ليلية —
 *     حرف D/N مصدر الحقيقة الوحيد) + الصيغة القديمة RRA1-04 محفوظة في ③.
 *     قرار المالك النهائي (إصلاح «حضر × التفعيل» — الخلل أ): الصيغة الموقعة
 *     بلا تدحرج إطلاقًا — البداية على تاريخ المناوبة المسؤولة نفسه؛ القديمة
 *     غير الموقعة تحتفظ بقاعدة التدحرج (③).
 *
 * التشغيل: node scripts/overlap-late-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** استخراج مصدر دالة من ملف بعدّ الأقواس المتزنة (نفس أداة hours-metrics-test). */
function extractFunctionSource(filePath, fnName) {
    const src = fs.readFileSync(filePath, 'utf8');
    const start = src.indexOf('function ' + fnName + '(');
    if (start === -1) throw new Error(`الدالة ${fnName} غير موجودة في ${filePath}`);
    const braceStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`أقواس ${fnName} غير متزنة`);
}

/** وقت جداري بالرياض ← UTC ISO (نفس تثبيت +03:00 الصريح في الخدمة). */
const R = (date, hhmm) => new Date(date + 'T' + hhmm + ':00+03:00').toISOString();

async function main() {
    console.log('\n═══ اختبارات مرحلة الأوفرلاب 3 — تأخير كل موظف + الترحيل ═══\n');

    // ── قاعدة معزولة مؤقتة (Windows: %TEMP% = C:\Users\...\AppData\Local\Temp) ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlap-late-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const db = require(path.join(ROOT, 'db.js'));
    try {
        await db.init(false); // مخطط كامل + ترحيلات + بذر
        const StorageAdapter = require(path.join(ROOT, 'storage-adapter.js'));
        const storage = new StorageAdapter(db);
        const StaffingEventsService = require(path.join(ROOT, 'services', 'staffing-events-service.js'));
        const svc = new StaffingEventsService({ storage, engine: {} }); // engine لا يُستخدم في مسار القراءة
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        // ── الكادر المجدول عبر الكاتب الرسمي (تواريخ مفصولة لكل مجموعة) ──
        await sync.syncFromSchedule([
            // 2026-08-20 (صباحية): ①②⑤⑦⑧⑨⑬
            { employeeNumber: '711', name: 'أوفرلاب تسعة أ', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'O12-09' }] },
            { employeeNumber: '712', name: 'أوفرلاب تسعة ب', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'O12-09' }] },
            { employeeNumber: '713', name: 'أوفرلاب اثنا عشر أ', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'O12-12' }] },
            { employeeNumber: '714', name: 'أوفرلاب اثنا عشر ب', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'O12-12' }] },
            { employeeNumber: '725', name: 'سريع فجر ج أ', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'RRA1-D-04' }] },
            { employeeNumber: '726', name: 'سريع فجر ج ب', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'RRA1-D-04' }] },
            { employeeNumber: '716', name: 'نهاري قديم أ', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'D12' }] },
            { employeeNumber: '717', name: 'نهاري قديم ب', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'D12' }] },
            { employeeNumber: '718', name: 'أوفرلاب غائب', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'O12-12' }] },
            { employeeNumber: '719', name: 'أوفرلاب مصحح', team: 'جنوب 3', jobTitle: 'مسعف', schedule: [{ date: '2026-08-20', shiftCode: 'O12-09' }] },
            // 2026-08-21 (ليلية): ③④⑥
            { employeeNumber: '715', name: 'سريع عصر', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: '2026-08-21', shiftCode: 'RRA1-N-16' }] },
            { employeeNumber: '721', name: 'سريع فجر أ', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: '2026-08-21', shiftCode: 'RRA1-04' }] },
            { employeeNumber: '722', name: 'سريع فجر ب', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: '2026-08-21', shiftCode: 'RRA1-04' }] },
            { employeeNumber: '723', name: 'ليلي قديم أ', team: 'جنوب 5', jobTitle: 'مسعف', schedule: [{ date: '2026-08-21', shiftCode: 'N12' }] },
            { employeeNumber: '724', name: 'ليلي قديم ب', team: 'جنوب 5', jobTitle: 'مسعف', schedule: [{ date: '2026-08-21', shiftCode: 'N12' }] },
            // 2026-08-22 (صباحية + ليلية): ⑩ الترحيل
            { employeeNumber: '731', name: 'أوفرلاب مرحل', team: 'جنوب 7', jobTitle: 'مسعف', schedule: [{ date: '2026-08-22', shiftCode: 'O12-12' }] },
            { employeeNumber: '732', name: 'نهاري غير مرحل', team: 'جنوب 7', jobTitle: 'مسعف', schedule: [{ date: '2026-08-22', shiftCode: 'D12' }] }
        ]);

        // ── المناوبات ──
        const insShift = async (name, date, time, type) => (await db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time)
             VALUES (?, ?, ?, ?, 'الخميس', ?)`, [name, date, time, type, R(date, time)])).id;
        const dayA = await insShift('صباحية 20', '2026-08-20', '05:00', 'صباحية');
        const nightB = await insShift('ليلية 21', '2026-08-21', '17:00', 'ليلية');
        const dayC = await insShift('صباحية 22', '2026-08-22', '05:00', 'صباحية');
        const nightD = await insShift('ليلية 22', '2026-08-22', '17:00', 'ليلية');

        // ── كاتب الأحداث الرسمي (append-only) ──
        const addEvent = (shiftId, shiftDate, shiftType, ev) => storage.appendOperationalEvent({
            shiftId, shiftDate, shiftType, domain: 'staffing',
            entityId: ev.emp, entityName: ev.emp, teamId: ev.team || 'جنوب 3', center: null,
            eventType: ev.type, reason: ev.type === 'late' ? 'مسعف متأخر' : null,
            payload: ev.payload || null, note: null,
            actorId: 'test', actorName: 'اختبار', createdAt: ev.at
        });

        // ═══ أحداث صباحية 2026-08-20 (①②⑤⑦⑧⑨⑬) ═══
        const D1 = '2026-08-20';
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب تسعة أ', type: 'late', at: R(D1, '05:05') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب تسعة أ', type: 'arrival', at: R(D1, '09:00') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب تسعة ب', type: 'late', at: R(D1, '05:05') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب تسعة ب', type: 'arrival', at: R(D1, '09:20') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب اثنا عشر أ', type: 'late', at: R(D1, '05:05') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب اثنا عشر أ', type: 'arrival', at: R(D1, '12:00') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب اثنا عشر ب', type: 'late', at: R(D1, '05:05') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب اثنا عشر ب', type: 'arrival', at: R(D1, '12:37') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع فجر ج أ', type: 'late', at: R(D1, '03:50'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع فجر ج أ', type: 'arrival', at: R(D1, '04:00'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع فجر ج ب', type: 'late', at: R(D1, '03:50'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع فجر ج ب', type: 'arrival', at: R(D1, '04:20'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'نهاري قديم أ', type: 'late', at: R(D1, '04:55') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'نهاري قديم أ', type: 'arrival', at: R(D1, '05:00') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'نهاري قديم ب', type: 'late', at: R(D1, '05:02') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'نهاري قديم ب', type: 'arrival', at: R(D1, '05:20') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'شخص غير مجدول', type: 'late', at: R(D1, '05:02') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'شخص غير مجدول', type: 'arrival', at: R(D1, '05:30') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب غائب', type: 'late', at: R(D1, '05:05') }); // بلا وصول — ⑧
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب مصحح', type: 'late', at: R(D1, '05:05') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب مصحح', type: 'arrival', at: R(D1, '09:50') });
        await addEvent(dayA, D1, 'صباحية', { emp: 'أوفرلاب مصحح', type: 'correction', at: R(D1, '10:00'), payload: { corrects: 'arrival_time', arrivalAt: R(D1, '09:10') } });

        const tlA = await svc.getTimeline(dayA);
        const recA = n => (tlA.lateRecords || []).find(r => r.employee === n);

        // ─── ① O12-09 (صباحية): حضور 09:00 ⇒ 0 · 09:20 ⇒ 20 ───
        const r1a = recA('أوفرلاب تسعة أ'), r1b = recA('أوفرلاب تسعة ب');
        const t1 = r1a && r1b &&
            r1a.durationMinutes === 0 && r1a.startedAt === R(D1, '09:00') && r1a.operationalStart === R(D1, '09:00') &&
            r1b.durationMinutes === 20 && r1b.operationalStart === R(D1, '09:00');
        record('① O12-09 صباحية: 09:00⇒0 · 09:20⇒20 · البداية التشغيلية 09:00',
            t1, r1a && r1b ? `أ=${r1a.durationMinutes} ب=${r1b.durationMinutes}` : 'سجل مفقود');

        // ─── ② O12-12: 12:00 ⇒ 0 · 12:37 ⇒ 37 ───
        const r2a = recA('أوفرلاب اثنا عشر أ'), r2b = recA('أوفرلاب اثنا عشر ب');
        const t2 = r2a && r2b &&
            r2a.durationMinutes === 0 && r2a.operationalStart === R(D1, '12:00') &&
            r2b.durationMinutes === 37 && r2b.operationalStart === R(D1, '12:00');
        record('② O12-12 صباحية: 12:00⇒0 · 12:37⇒37',
            t2, r2a && r2b ? `أ=${r2a.durationMinutes} ب=${r2b.durationMinutes}` : 'سجل مفقود');

        // ═══ أحداث ليلية 2026-08-21 (③④⑥) ═══
        const D2 = '2026-08-21';
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع عصر', type: 'late', at: R(D2, '15:50'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع عصر', type: 'arrival', at: R(D2, '16:00'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع فجر أ', type: 'late', at: R(D2, '17:05'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع فجر أ', type: 'arrival', at: R('2026-08-22', '04:00'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع فجر ب', type: 'late', at: R(D2, '17:05'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع فجر ب', type: 'arrival', at: R('2026-08-22', '04:15'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'ليلي قديم أ', type: 'late', at: R(D2, '16:55'), team: 'جنوب 5' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'ليلي قديم أ', type: 'arrival', at: R(D2, '17:00'), team: 'جنوب 5' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'ليلي قديم ب', type: 'late', at: R(D2, '17:02'), team: 'جنوب 5' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'ليلي قديم ب', type: 'arrival', at: R(D2, '17:15'), team: 'جنوب 5' });

        const tlB = await svc.getTimeline(nightB);
        const recB = n => (tlB.lateRecords || []).find(r => r.employee === n);

        // ─── ③ RRA1-04 (الصيغة القديمة — تغطية legacy محفوظة): حضور 04:00 في D+1 ⇒ 0 · 04:15 ⇒ 15 ───
        const r3a = recB('سريع فجر أ'), r3b = recB('سريع فجر ب');
        const t3 = r3a && r3b &&
            r3a.durationMinutes === 0 && r3a.operationalStart === R('2026-08-22', '04:00') &&
            r3b.durationMinutes === 15 && r3b.operationalStart === R('2026-08-22', '04:00');
        record('③ RRA1-04 ليلية (قديم): البداية D+1 04:00 · 04:00⇒0 · 04:15⇒15',
            t3, r3a && r3b ? `أ=${r3a.durationMinutes} ب=${r3b.durationMinutes} بداية=${r3a.operationalStart}` : 'سجل مفقود');

        // ─── ④ RRA1-N-16 (ليلية بحرف N الصريح): البداية 16:00 نفس تاريخ الليلية · وصول 16:00 ⇒ 0 ───
        // حرف N يجعل الموظف عضوًا في الليلية رغم أن 16:00 ∈ [05,17) — المسؤولية ≠ الساعة.
        // قرار المالك النهائي (الخلل أ): الصيغة الموقعة بلا تدحرج — 16:00 تُثبَّت
        // على تاريخ المناوبة الليلية نفسه ولو سبقت بدايتها العالمية 17:00.
        const r4 = recB('سريع عصر');
        const t4 = r4 && r4.durationMinutes === 0 && r4.operationalStart === R(D2, '16:00') &&
            r4.startedAt === R(D2, '16:00');
        record('④ RRA1-N-16 ليلية (حرف N): البداية نفس التاريخ 16:00 (بلا تدحرج) · وصول 16:00⇒0',
            t4, r4 ? `المدة=${r4.durationMinutes} البداية=${r4.operationalStart}` : 'سجل مفقود');

        // ─── ⑤ D12 (خط الأساس بلا تغيير): 05:00 ⇒ 0 · 05:20 ⇒ 20 · بلا operationalStart ───
        const r5a = recA('نهاري قديم أ'), r5b = recA('نهاري قديم ب');
        const t5 = r5a && r5b &&
            r5a.durationMinutes === 0 && r5b.durationMinutes === 20 &&
            r5a.startedAt === R(D1, '05:00') &&
            !('operationalStart' in r5a) && !('operationalStart' in r5b);
        record('⑤ D12 صباحية (خط الأساس): 05:00⇒0 · 05:20⇒20 · بلا operationalStart',
            t5, r5a && r5b ? `أ=${r5a.durationMinutes} ب=${r5b.durationMinutes}` : 'سجل مفقود');

        // ─── ⑥ N12 (ليلية — خط الأساس): 17:00 ⇒ 0 · 17:15 ⇒ 15 ───
        const r6a = recB('ليلي قديم أ'), r6b = recB('ليلي قديم ب');
        const t6 = r6a && r6b &&
            r6a.durationMinutes === 0 && r6b.durationMinutes === 15 &&
            r6a.startedAt === R(D2, '17:00') &&
            !('operationalStart' in r6a) && !('operationalStart' in r6b);
        record('⑥ N12 ليلية (خط الأساس): 17:00⇒0 · 17:15⇒15 · بلا operationalStart',
            t6, r6a && r6b ? `أ=${r6a.durationMinutes} ب=${r6b.durationMinutes}` : 'سجل مفقود');

        // ─── ⑦ اسم بلا مطابقة في الكادر ⇒ سقوط على بداية المناوبة العالمية ───
        const r7 = recA('شخص غير مجدول');
        const t7 = r7 && r7.durationMinutes === 30 && r7.startedAt === R(D1, '05:00') &&
            !('operationalStart' in r7) && !('code' in r7);
        record('⑦ اسم غير مجدول: سقوط على 05:00 العالمية · 05:30⇒30 · بلا code/operationalStart',
            t7, r7 ? `المدة=${r7.durationMinutes} البداية=${r7.startedAt}` : 'سجل مفقود');

        // ─── ⑧ «لم يحضر» يكشف البداية التشغيلية للموظف ───
        const r8 = recA('أوفرلاب غائب');
        const t8 = r8 && r8.status === 'not_arrived' && r8.arrivedAt === null &&
            r8.operationalStart === R(D1, '12:00') && r8.startedAt === R(D1, '12:00');
        record('⑧ not_arrived: operationalStart=12:00 مكشوفة · arrivedAt=null',
            t8, r8 ? `الحالة=${r8.status} البداية=${r8.operationalStart}` : 'سجل مفقود');

        // ─── ⑨ correction يحدّث arrivedAt والمدة تُعاد من البداية التشغيلية ───
        const r9 = recA('أوفرلاب مصحح');
        const t9 = r9 && r9.arrivedAt === R(D1, '09:10') && r9.durationMinutes === 10 &&
            r9.operationalStart === R(D1, '09:00');
        record('⑨ correction: 09:50⇒09:10 مصححة · المدة من 09:00 التشغيلية = 10',
            t9, r9 ? `الحضور=${r9.arrivedAt} المدة=${r9.durationMinutes}` : 'سجل مفقود');

        // ─── ⑬ RRA1-D-04 (صباحية بحرف D الصريح): عضو الصباحية رغم بداية 04:00 —
        //        المسؤولية ≠ ساعة البداية: وصول 04:00 (نفس التاريخ) ⇒ 0 · 04:20 ⇒ 20 ───
        // حرف D يُدخله خريطة الصباحية (لو اعتُمدت الساعة لصار ليليًا واستُبعد)،
        // وقرار المالك النهائي (الخلل أ): بلا تدحرج — 04:00 على تاريخ الصباحية نفسه.
        const r13a = recA('سريع فجر ج أ'), r13b = recA('سريع فجر ج ب');
        const t13 = r13a && r13b &&
            r13a.durationMinutes === 0 && r13a.operationalStart === R(D1, '04:00') &&
            r13b.durationMinutes === 20 && r13b.operationalStart === R(D1, '04:00');
        record('⑬ RRA1-D-04 صباحية (حرف D): عضو الصباحية رغم 04:00 · بلا تدحرج · 04:00⇒0 · 04:20⇒20',
            t13, r13a && r13b ? `أ=${r13a.durationMinutes} ب=${r13b.durationMinutes} بداية=${r13a.operationalStart}` : 'سجل مفقود');

        // ═══ ⑩ الترحيل — نموذج الطوابع الثلاثة ═══
        const D3 = '2026-08-22';
        // صباحية 22: تأخير مفتوح لـO12-12 (بلا وصول) + تأخير مفتوح لـD12
        await addEvent(dayC, D3, 'صباحية', { emp: 'أوفرلاب مرحل', type: 'late', at: R(D3, '05:30'), team: 'جنوب 7' });
        await addEvent(dayC, D3, 'صباحية', { emp: 'نهاري غير مرحل', type: 'late', at: R(D3, '05:30'), team: 'جنوب 7' });
        // ليلية 22: وصول 18:30 يُغلق التأخير المرحّل
        await addEvent(nightD, D3, 'ليلية', { emp: 'أوفرلاب مرحل', type: 'arrival', at: R(D3, '18:30'), team: 'جنوب 7' });

        const tlD = await svc.getTimeline(nightD);
        const rc = (tlD.lateRecords || []).find(r => r.employee === 'أوفرلاب مرحل');
        const carriedOk = rc && rc.status === 'arrived' &&
            rc.operationalStart === R(D3, '12:00') &&
            rc.responsibilityStart === R(D3, '17:00') &&
            rc.carryForwardAt === R(D3, '17:00') &&
            rc.arrivedAt === R(D3, '18:30') &&
            rc.carriedFromShiftId === dayC &&
            rc.durationMinutes === 390 &&          // 12:00 ← 18:30 إجمالي
            rc.delayUnderShiftMinutes === 90;      // 17:00 ← 18:30 تحت مسؤولية الليلية
        const d12NotCarried = !(tlD.lateRecords || []).some(r => r.employee === 'نهاري غير مرحل');

        // مناوبة المنشأ (صباحية 22): السجل يبقى not_arrived مع وسم carryForwardAt
        const tlC = await svc.getTimeline(dayC);
        const ro = (tlC.lateRecords || []).find(r => r.employee === 'أوفرلاب مرحل');
        const originOk = ro && ro.status === 'not_arrived' && ro.arrivedAt === null &&
            ro.operationalStart === R(D3, '12:00') &&
            ro.carryForwardAt === R(D3, '17:00') &&
            !('carriedFromShiftId' in ro);
        const roD12 = (tlC.lateRecords || []).find(r => r.employee === 'نهاري غير مرحل');
        const d12NoAnnot = roD12 && !('carryForwardAt' in roD12) && !('operationalStart' in roD12);

        // محاكاة عدم التقاطع: نفس البذور لكن بداية مناوبة حالية بعيدة (3 أيام لاحقًا)
        // ⇒ نافذة O12-12 [22 12:00, 23 00:00) لا تتقاطع [25 17:00, 26 05:00) ⇒ لا ترحيل.
        const prevRow = await storage.getShiftById(dayC);
        const prevEvents = await storage.getOperationalEventsByShift(dayC, 'staffing');
        const rosterCodes = await svc._rosterShiftCodeByName(D3);
        const seedsFar = svc._computeCarrySeeds(prevRow, prevEvents, rosterCodes, R('2026-08-25', '17:00'));
        const seedsNear = svc._computeCarrySeeds(prevRow, prevEvents, rosterCodes, R(D3, '17:00'));
        const simOk = seedsFar.length === 0 &&
            seedsNear.length === 1 && seedsNear[0].employee === 'أوفرلاب مرحل';

        const t10 = carriedOk && d12NotCarried && originOk && d12NoAnnot && simOk;
        record('⑩ الترحيل: ثلاث طوابع · إجمالي 390 / تحت المسؤولية 90 · المنشأ موسوم 17:00 · D12 وغير المتقاطع لا يُرحَّلان',
            t10, `مرحّل=${!!carriedOk} D12_محجوب=${d12NotCarried} منشأ=${!!originOk} D12_بلا_وسم=${!!d12NoAnnot} محاكاة=${simOk}`);

        // ─── ⑪ حارس العرض: lateNote المركبة (استخراج vm من المصدر الفعلي) ───
        const pdfPath = path.join(ROOT, 'services', 'workflow-pdf-service.js');
        const lateNoteSandbox = {
            fTime: iso => {
                if (!iso) return '';
                const d = new Date(new Date(iso).getTime() + 3 * 3600000); // عرض الرياض
                return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
            }
        };
        vm.createContext(lateNoteSandbox);
        vm.runInContext(
            extractFunctionSource(pdfPath, 'lateFor') + '\n' +
            extractFunctionSource(pdfPath, 'lateNote') + '\n' +
            'this.lateNote = lateNote;', lateNoteSandbox);
        const lateNoteFn = lateNoteSandbox.lateNote;
        const carriedRec = {
            employee: 'س', status: 'arrived', arrivedAt: R(D3, '18:30'),
            operationalStart: R(D3, '12:00'), responsibilityStart: R(D3, '17:00'),
            durationMinutes: 390, delayUnderShiftMinutes: 90, carriedFromShiftId: dayC
        };
        const noteCarried = lateNoteFn([carriedRec], 'س');
        const t11carried = typeof noteCarried === 'string' &&
            noteCarried.includes('390') && noteCarried.includes('90') &&
            noteCarried.includes('تأخير إجمالي') && noteCarried.includes('تحت مسؤولية هذه المناوبة') &&
            noteCarried.includes('18:30') && noteCarried.includes('12:00') && noteCarried.includes('17:00');
        const plainRec = { employee: 'ع', status: 'arrived', arrivedAt: R(D1, '05:20'), durationMinutes: 20 };
        const notePlain = lateNoteFn([plainRec], 'ع');
        const t11plain = notePlain === 'وقت الحضور: 05:20 • مدة التأخير: 20 دقيقة';
        const noteOpen = lateNoteFn([{ employee: 'غ', status: 'not_arrived', arrivedAt: null }], 'غ');
        const t11open = noteOpen === 'لم يحضر بعد';
        record('⑪ حارس العرض: مرحّل⇒مركبة (390+90+العبارات) · عادي⇒صيغة اليوم حرفيًا · مفتوح⇒لم يحضر بعد',
            t11carried && t11plain && t11open,
            `مركبة=${t11carried} عادية=${t11plain} مفتوحة=${t11open}`);

        // ─── ⑫ ذهبي + أرشيف: بلا أكواد تشغيلية ⇒ مطابقة حرفية · الحقول الجديدة
        //        تُخزَّن قيمًا في اللقطة · بصمة shift_roster لا تتغير ───
        const svcPath = path.join(ROOT, 'services', 'staffing-events-service.js');
        const deriveSandbox = { console };
        vm.createContext(deriveSandbox);
        vm.runInContext(
            extractFunctionSource(svcPath, 'toIsoDate') + '\n' +
            extractFunctionSource(svcPath, 'shiftStartIso') + '\n' +
            extractFunctionSource(svcPath, 'parsePayload') + '\n' +
            extractFunctionSource(svcPath, 'deriveLateRecords') + '\n' +
            'this.deriveLateRecords = deriveLateRecords;', deriveSandbox);
        const derive = deriveSandbox.deriveLateRecords;
        const goldenEvents = [
            { id: 1, entity_id: 'م أ', team_id: 'جنوب 1', event_type: 'late', created_at: R(D1, '05:03'), payload: null },
            { id: 2, entity_id: 'م أ', team_id: 'جنوب 1', event_type: 'arrival', created_at: R(D1, '05:41'), payload: null },
            { id: 3, entity_id: 'م ب', team_id: 'جنوب 1', event_type: 'absence', created_at: R(D1, '05:04'), payload: null },
            { id: 4, entity_id: 'م ب', team_id: 'جنوب 1', event_type: 'arrival', created_at: R(D1, '06:00'), payload: null },
            { id: 5, entity_id: 'م ب', team_id: 'جنوب 1', event_type: 'correction', created_at: R(D1, '07:00'), payload: JSON.stringify({ arrivalAt: R(D1, '05:55') }) },
            { id: 6, entity_id: 'م ج', team_id: 'جنوب 2', event_type: 'late', created_at: R(D1, '05:06'), payload: null }
        ];
        const golden3 = JSON.stringify(derive(goldenEvents, 'صباحية', D1));          // النداء القديم (3 وسائط)
        const golden4 = JSON.stringify(derive(goldenEvents, 'صباحية', D1, {}));      // النداء الجديد بخريطة فارغة
        const t12golden = golden3 === golden4 && !golden4.includes('operationalStart');

        // مسار اللقطة: getTimeline ← JSON (نفس ما يخزنه workflow-service:189 ويُختم SHA-256)
        const rosterDump = async () => JSON.stringify(await db.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id'));
        const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');
        const rosterHashBefore = hashOf(await rosterDump());
        const tlDfresh = await svc.getTimeline(nightD);
        const snapshot = { lateRecords: tlDfresh.lateRecords };   // كما يُخزَّن في اللقطة
        const sealed = JSON.parse(JSON.stringify(snapshot));      // تخزين JSON كما في الأرشيف
        const sealedCarried = (sealed.lateRecords || []).find(r => r.employee === 'أوفرلاب مرحل');
        const t12snapshot = sealedCarried &&
            typeof sealedCarried.operationalStart === 'string' &&
            typeof sealedCarried.responsibilityStart === 'string' &&
            typeof sealedCarried.carriedFromShiftId === 'number' &&
            typeof sealedCarried.delayUnderShiftMinutes === 'number' &&
            typeof hashOf(JSON.stringify(sealed)) === 'string';   // اللقطة قابلة للختم
        const rosterHashAfter = hashOf(await rosterDump());
        const t12roster = rosterHashBefore === rosterHashAfter;
        record('⑫ ذهبي + أرشيف: بلا أكواد⇒مطابقة حرفية · الحقول الأربعة قيمًا في اللقطة · بصمة الكادر ثابتة',
            t12golden && t12snapshot && t12roster,
            `ذهبي=${t12golden} لقطة=${!!t12snapshot} كادر=${t12roster}`);

    } catch (err) {
        record('خطأ غير متوقع أثناء الاختبارات', false, err.message);
        console.error(err);
    } finally {
        try { await db.closeDb(); } catch (_) {}
        // مهلة قصيرة حتى يتحرر مقبض WAL على ويندوز قبل الحذف
        await new Promise(r => setTimeout(r, 500));
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // ─── الملخص ───
    const failed = results.filter(r => !r.ok);
    console.log(`\n═══ الملخص: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) {
        failed.forEach(f => console.log(`   ❌ ${f.name}`));
        process.exit(1);
    }
    console.log('✅ جميع اختبارات مرحلة الأوفرلاب 3 ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
