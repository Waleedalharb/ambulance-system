/**
 * اختبارات مرحلة بدايات الفرق التشغيلية — teams.operational_starts
 * ═══════════════════════════════════════════════════════════════════════
 * فصل نوع المناوبة (D/N في الجدول — بلا أي تغيير على الكادر) عن البداية
 * التشغيلية المخزنة على الفريق نفسه (JSON nullable لكل فريق).
 * سلسلة الحل في _personStartMap:
 *   ① كود تشغيلي ملحق (O12-12…) ⇒ من اللاحقة مع قاعدة الترحيل القائمة — كما هو.
 *   ② طبقة الفريق: roster.team_id ← teams.operational_starts ← day/night ⇒
 *     البداية مثبتة على تاريخ المناوبة نفسه مباشرة — بلا قاعدة ترحيل
 *     (قرار المالك: ليلية + 16:00 ⇒ نفس التاريخ D رغم 16:00 < 17:00).
 *   ③/④ كما اليوم — غير المطابقين بلا مدخل ⇒ سقوط على 05:00/17:00 العالمية.
 *
 * نفس نمط العزل في overlap-late-test.js حرفيًا:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (يُضبط قبل require db.js).
 *   - الكتابة عبر الكاتب الرسمي فقط: RosterSyncService للكادر،
 *     StorageAdapter.appendOperationalEvent للأحداث (append-only).
 *   - تواريخ مفصولة عن مجموعات الأوفرلاب حتى لا تتداخل منطقة الترحيل:
 *       2026-09-10 صباحية (①③④) — بلا ليلية 2026-09-09 ⇒ بلا ترحيل.
 *       2026-09-11 ليلية  (②③)   — بلا صباحية 2026-09-11 ⇒ بلا ترحيل.
 *   - البذر المعتمد يعطي سريع 1..4 المعرفات 20..23 مع
 *     {"day":"04:00","night":"16:00"} — يُتحقق منه صراحة.
 *
 * التشغيل: node scripts/team-starts-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** وقت جداري بالرياض ← UTC ISO (نفس تثبيت +03:00 الصريح في الخدمة). */
const R = (date, hhmm) => new Date(date + 'T' + hhmm + ':00+03:00').toISOString();

async function main() {
    console.log('\n═══ اختبارات مرحلة بدايات الفرق التشغيلية — teams.operational_starts ═══\n');

    // ── قاعدة معزولة مؤقتة (Windows: %TEMP% = C:\Users\...\AppData\Local\Temp) ──
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-starts-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const db = require(path.join(ROOT, 'db.js'));
    try {
        await db.init(false); // مخطط كامل + ترحيلات + بذر (بما فيها بذر بدايات سريع 1..4)
        const StorageAdapter = require(path.join(ROOT, 'storage-adapter.js'));
        const storage = new StorageAdapter(db);
        const StaffingEventsService = require(path.join(ROOT, 'services', 'staffing-events-service.js'));
        const svc = new StaffingEventsService({ storage, engine: {} }); // engine لا يُستخدم في مسار القراءة
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        // ─── ⓪ البذر + مسار الكتابة API: سريع 1..4 مبذورة id=20..23 بالقيمة
        //        المعتمدة · جنوب 7 بلا إعداد · Teams.update يكتب العمود ───
        const teamsAll = await db.Teams.getAll(); // SELECT * — العمود ظاهر تلقائيًا (نفس GET /api/teams)
        const byName = {};
        for (const t of teamsAll) byName[t.name] = t;
        const rapidOk = ['سريع 1', 'سريع 2', 'سريع 3', 'سريع 4'].every((n, i) => {
            const t = byName[n];
            return t && t.id === 20 + i && t.operational_starts === '{"day":"04:00","night":"16:00"}';
        });
        const south7Null = byName['جنوب 7'] && byName['جنوب 7'].operational_starts == null;
        record('⓪ البذر: سريع 1..4 id=20..23 مع {"day":"04:00","night":"16:00"} · جنوب 7=NULL',
            rapidOk && south7Null,
            `سريع1=${byName['سريع 1'] && byName['سريع 1'].id}:${byName['سريع 1'] && byName['سريع 1'].operational_starts} جنوب7=${byName['جنوب 7'] && byName['جنوب 7'].operational_starts}`);

        // كاتب التحديث الرسمي (نفس مسار PUT /api/teams/:id ← db.Teams.update)
        const s1 = byName['جنوب 1'];
        await db.Teams.update(s1.id, { name: s1.name, center: s1.center, team_type: s1.team_type, sort_order: s1.sort_order, is_active: s1.is_active, operational_starts: '{"day":"18:00"}' });
        const s2 = byName['جنوب 2'];
        await db.Teams.update(s2.id, { name: s2.name, center: s2.center, team_type: s2.team_type, sort_order: s2.sort_order, is_active: s2.is_active, operational_starts: { day: '05:00' } }); // كائن ⇒ يُخزَّن JSON
        const s1After = await db.Teams.getById(s1.id);
        const s2After = await db.Teams.getById(s2.id);
        const updateOk = s1After.operational_starts === '{"day":"18:00"}' &&
            s2After.operational_starts === '{"day":"05:00"}';
        record('⓪-ب Teams.update (مسار PUT /api/teams/:id): يكتب operational_starts نصًا وكائنًا',
            updateOk, `جنوب1=${s1After.operational_starts} جنوب2=${s2After.operational_starts}`);

        // ── الكادر المجدول عبر الكاتب الرسمي — أكواد D/N صرفة فقط (صفر تغيير على الكادر) ──
        const D1 = '2026-09-10'; // صباحية
        const D2 = '2026-09-11'; // ليلية
        await sync.syncFromSchedule([
            // 2026-09-10 (صباحية): ①③④
            { employeeNumber: '801', name: 'سريع نهاري أ', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            { employeeNumber: '802', name: 'سريع نهاري ب', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            { employeeNumber: '803', name: 'سريع نهاري ج', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            { employeeNumber: '804', name: 'جنوبي نهاري', team: 'جنوب 7', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            { employeeNumber: '805', name: 'توسعة نهاري أ', team: 'جنوب 1', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            { employeeNumber: '806', name: 'توسعة نهاري ب', team: 'جنوب 1', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            { employeeNumber: '807', name: 'حد نهاري', team: 'جنوب 2', jobTitle: 'مسعف', schedule: [{ date: D1, shiftCode: 'D' }] },
            // 2026-09-11 (ليلية): ②③
            { employeeNumber: '811', name: 'سريع ليلي أ', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D2, shiftCode: 'N' }] },
            { employeeNumber: '812', name: 'سريع ليلي ب', team: 'سريع 1', jobTitle: 'مسعف', schedule: [{ date: D2, shiftCode: 'N' }] },
            { employeeNumber: '813', name: 'جنوبي ليلي', team: 'جنوب 7', jobTitle: 'مسعف', schedule: [{ date: D2, shiftCode: 'N' }] }
        ]);

        // ── المناوبات ──
        const insShift = async (name, date, time, type) => (await db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time)
             VALUES (?, ?, ?, ?, 'الخميس', ?)`, [name, date, time, type, R(date, time)])).id;
        const dayA = await insShift('صباحية 10', D1, '05:00', 'صباحية');
        const nightB = await insShift('ليلية 11', D2, '17:00', 'ليلية');

        // ── كاتب الأحداث الرسمي (append-only) ──
        const addEvent = (shiftId, shiftDate, shiftType, ev) => storage.appendOperationalEvent({
            shiftId, shiftDate, shiftType, domain: 'staffing',
            entityId: ev.emp, entityName: ev.emp, teamId: ev.team, center: null,
            eventType: ev.type, reason: ev.type === 'late' ? 'مسعف متأخر' : null,
            payload: ev.payload || null, note: null,
            actorId: 'test', actorName: 'اختبار', createdAt: ev.at
        });

        // ═══ أحداث صباحية 2026-09-10 (①③④) ═══
        // ملاحظة ترتيب الطيّ: حدث late يجب أن يسبق arrival زمنيًا (created_at) ليُغلق —
        // لذا تُفتح تأخيرات طاقم سريع 04:00 قبل وصولهم المبكر (نفس نمط المجموعات السابقة).
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع نهاري أ', type: 'late', at: R(D1, '03:50'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع نهاري أ', type: 'arrival', at: R(D1, '04:00'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع نهاري ب', type: 'late', at: R(D1, '03:50'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع نهاري ب', type: 'arrival', at: R(D1, '04:20'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع نهاري ج', type: 'late', at: R(D1, '03:50'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'سريع نهاري ج', type: 'arrival', at: R(D1, '05:00'), team: 'سريع 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'جنوبي نهاري', type: 'late', at: R(D1, '05:02'), team: 'جنوب 7' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'جنوبي نهاري', type: 'arrival', at: R(D1, '05:20'), team: 'جنوب 7' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'توسعة نهاري أ', type: 'late', at: R(D1, '05:05'), team: 'جنوب 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'توسعة نهاري أ', type: 'arrival', at: R(D1, '18:00'), team: 'جنوب 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'توسعة نهاري ب', type: 'late', at: R(D1, '05:05'), team: 'جنوب 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'توسعة نهاري ب', type: 'arrival', at: R(D1, '18:30'), team: 'جنوب 1' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'حد نهاري', type: 'late', at: R(D1, '05:02'), team: 'جنوب 2' });
        await addEvent(dayA, D1, 'صباحية', { emp: 'حد نهاري', type: 'arrival', at: R(D1, '05:20'), team: 'جنوب 2' });

        const tlA = await svc.getTimeline(dayA);
        const recA = n => (tlA.lateRecords || []).find(r => r.employee === n);

        // ─── ① سريع 1 نهاري (D صريح): البداية 04:00 على تاريخ المناوبة نفسه —
        //        04:00⇒0 · 04:20⇒20 · 05:00⇒60 (بلا أكواد RRA إطلاقًا) ───
        const r1a = recA('سريع نهاري أ'), r1b = recA('سريع نهاري ب'), r1c = recA('سريع نهاري ج');
        const t1 = r1a && r1b && r1c &&
            r1a.durationMinutes === 0 && r1a.operationalStart === R(D1, '04:00') && r1a.startedAt === R(D1, '04:00') &&
            r1b.durationMinutes === 20 && r1b.operationalStart === R(D1, '04:00') &&
            r1c.durationMinutes === 60 && r1c.operationalStart === R(D1, '04:00');
        record('① سريع 1 صباحية (D صريح): البداية D 04:00 · 04:00⇒0 · 04:20⇒20 · 05:00⇒60',
            t1, r1a && r1b && r1c ? `أ=${r1a.durationMinutes} ب=${r1b.durationMinutes} ج=${r1c.durationMinutes} بداية=${r1a.operationalStart}` : 'سجل مفقود');

        // ─── ③-صباحية جنوب 7 (بلا إعداد): خط الأساس 05:00 بلا تغيير — 05:20⇒20 ───
        const r3d = recA('جنوبي نهاري');
        const t3d = r3d && r3d.durationMinutes === 20 && r3d.startedAt === R(D1, '05:00') &&
            !('operationalStart' in r3d);
        record('③-أ جنوب 7 صباحية (بلا operational_starts): 05:00⇒أساس · 05:20⇒20 · بلا operationalStart',
            t3d, r3d ? `المدة=${r3d.durationMinutes} البداية=${r3d.startedAt}` : 'سجل مفقود');

        // ─── ④ قابلية التوسع: جنوب 1 {"day":"18:00"} ⇒ طاقمه بكود D صريح:
        //        18:00⇒0 · 18:30⇒30 — بلا أي تغيير على رموز الكادر ───
        const r4a = recA('توسعة نهاري أ'), r4b = recA('توسعة نهاري ب');
        const t4 = r4a && r4b &&
            r4a.durationMinutes === 0 && r4a.operationalStart === R(D1, '18:00') &&
            r4b.durationMinutes === 30 && r4b.operationalStart === R(D1, '18:00');
        record('④ توسعة: جنوب 1 {"day":"18:00"} + كود D صريح ⇒ 18:00⇒0 · 18:30⇒30',
            t4, r4a && r4b ? `أ=${r4a.durationMinutes} ب=${r4b.durationMinutes} بداية=${r4a.operationalStart}` : 'سجل مفقود');

        // ─── ④-ب فحص موضعي: إعداد مساوٍ للحد {"day":"05:00"} يتصرف كخط الأساس تمامًا ───
        const r4c = recA('حد نهاري');
        const t4b = r4c && r4c.durationMinutes === 20 && r4c.startedAt === R(D1, '05:00') &&
            r4c.operationalStart === R(D1, '05:00');
        record('④-ب حد مساوٍ للأساس: جنوب 2 {"day":"05:00"} ⇒ 05:20⇒20 (مطابق لخط الأساس)',
            t4b, r4c ? `المدة=${r4c.durationMinutes} البداية=${r4c.startedAt}` : 'سجل مفقود');

        // ═══ أحداث ليلية 2026-09-11 (②③) ═══
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع ليلي أ', type: 'late', at: R(D2, '15:50'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع ليلي أ', type: 'arrival', at: R(D2, '16:00'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع ليلي ب', type: 'late', at: R(D2, '15:50'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'سريع ليلي ب', type: 'arrival', at: R(D2, '16:30'), team: 'سريع 1' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'جنوبي ليلي', type: 'late', at: R(D2, '17:02'), team: 'جنوب 7' });
        await addEvent(nightB, D2, 'ليلية', { emp: 'جنوبي ليلي', type: 'arrival', at: R(D2, '17:15'), team: 'جنوب 7' });

        const tlB = await svc.getTimeline(nightB);
        const recB = n => (tlB.lateRecords || []).find(r => r.employee === n);

        // ─── ② سريع 1 ليلي (N صريح): البداية 16:00 على تاريخ المناوبة نفسه D —
        //        بلا قاعدة ترحيل في طبقة الفريق (قرار المالك الصريح) —
        //        ISO الدقيق المؤكد: D 16:00+03:00 · 16:00⇒0 · 16:30⇒30 ───
        const exactNightIso = R(D2, '16:00'); // '2026-09-11T13:00:00.000Z'
        const r2a = recB('سريع ليلي أ'), r2b = recB('سريع ليلي ب');
        const t2 = r2a && r2b &&
            r2a.operationalStart === exactNightIso && r2a.startedAt === exactNightIso &&
            r2a.durationMinutes === 0 &&
            r2b.durationMinutes === 30 && r2b.operationalStart === exactNightIso;
        record('② سريع 1 ليلية (N صريح): البداية نفس التاريخ D 16:00 (بلا ترحيل) · 16:00⇒0 · 16:30⇒30',
            t2, r2a && r2b ? `ISO=${r2a.operationalStart} أ=${r2a.durationMinutes} ب=${r2b.durationMinutes}` : 'سجل مفقود');
        if (r2a) console.log(`   ℹ️  operationalStart لليلية (ISO الدقيق): ${r2a.operationalStart}`);

        // ─── ③-ليلية جنوب 7 (بلا إعداد): خط الأساس 17:00 بلا تغيير — 17:15⇒15 ───
        const r3n = recB('جنوبي ليلي');
        const t3n = r3n && r3n.durationMinutes === 15 && r3n.startedAt === R(D2, '17:00') &&
            !('operationalStart' in r3n);
        record('③-ب جنوب 7 ليلية (بلا operational_starts): 17:00⇒أساس · 17:15⇒15 · بلا operationalStart',
            t3n, r3n ? `المدة=${r3n.durationMinutes} البداية=${r3n.startedAt}` : 'سجل مفقود');

        // ─── ⑥ أرشيف: مسار اللقطة يخزّن startedAt/operationalStart قيمًا ·
        //        بصمة shift_roster لا تتغير بقراءة الخط الزمني ───
        const rosterDump = async () => JSON.stringify(await db.all(
            'SELECT * FROM shift_roster ORDER BY shift_date, employee_id'));
        const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');
        const rosterHashBefore = hashOf(await rosterDump());
        const tlBfresh = await svc.getTimeline(nightB);
        const snapshot = { lateRecords: tlBfresh.lateRecords };   // كما يُخزَّن في لقطة سير العمل
        const sealed = JSON.parse(JSON.stringify(snapshot));      // تخزين JSON كما في الأرشيف
        const sealedRapid = (sealed.lateRecords || []).find(r => r.employee === 'سريع ليلي أ');
        const t6snap = sealedRapid &&
            sealedRapid.operationalStart === exactNightIso &&
            sealedRapid.startedAt === exactNightIso &&
            typeof hashOf(JSON.stringify(sealed)) === 'string';   // اللقطة قابلة للختم
        const rosterHashAfter = hashOf(await rosterDump());
        const t6roster = rosterHashBefore === rosterHashAfter;
        record('⑥ أرشيف: اللقطة تخزّن startedAt/operationalStart قيمًا · بصمة shift_roster ثابتة',
            t6snap && t6roster, `لقطة=${!!t6snap} كادر=${t6roster}`);

        // ─── ⑤ ذهبي: NULL في كل الفرق ⇒ سلوك ما قبل المرحلة حرفيًا —
        //        بلا operationalStart في أي سجل · نفس مدد خط الأساس ·
        //        سريع 1 يسقط على 05:00/17:00 العالمية ───
        await db.run('UPDATE teams SET operational_starts = NULL');
        const tlAnull = await svc.getTimeline(dayA);
        const tlBnull = await svc.getTimeline(nightB);
        const jsonNull = JSON.stringify(tlAnull.lateRecords) + JSON.stringify(tlBnull.lateRecords);
        const nRapidDay = (tlAnull.lateRecords || []).find(r => r.employee === 'سريع نهاري ب');
        const nSouthDay = (tlAnull.lateRecords || []).find(r => r.employee === 'جنوبي نهاري');
        const nSouthNight = (tlBnull.lateRecords || []).find(r => r.employee === 'جنوبي ليلي');
        const t5 = !jsonNull.includes('operationalStart') &&
            nRapidDay && nRapidDay.startedAt === R(D1, '05:00') && nRapidDay.durationMinutes === 0 && // 04:20 قبل 05:00 ⇒ 0 كما قبل المرحلة
            nSouthDay && nSouthDay.durationMinutes === 20 && nSouthDay.startedAt === R(D1, '05:00') &&
            nSouthNight && nSouthNight.durationMinutes === 15 && nSouthNight.startedAt === R(D2, '17:00');
        record('⑤ ذهبي: NULL في كل الفرق ⇒ بلا operationalStart إطلاقًا · مدد وبدايات خط الأساس حرفيًا',
            t5, `سريع_ب=${nRapidDay && nRapidDay.durationMinutes}/${nRapidDay && nRapidDay.startedAt} جنوبي_نهاري=${nSouthDay && nSouthDay.durationMinutes} جنوبي_ليلي=${nSouthNight && nSouthNight.durationMinutes}`);

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
    console.log('✅ جميع اختبارات مرحلة بدايات الفرق التشغيلية ناجحة\n');
    process.exit(0);
}

main().catch(err => {
    console.error('فشل تشغيل الاختبارات:', err);
    process.exit(1);
});
