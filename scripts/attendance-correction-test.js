/**
 * اختبارات بند «تصحيح الحالة» (اعتماد المالك 2026-09-08)
 * ═══════════════════════════════════════════════════════
 * نفس نمط العزل في overlap-late-test.js حرفيًا:
 *   - قاعدة SQLite مؤقتة تحت %TEMP% عبر DB_PATH (تُضبط قبل require db.js).
 *   - الكتابة عبر المسار الرسمي: StaffingEventsService.appendPersonEvents
 *     (نفس مسار الواجهة — تحقق + idempotency + ختم targetEventId سيرفري).
 *   - القراءة عبر getTimeline (سجلات مشتقة + سجل خام) وgetState (الطيّ).
 *
 * المُتحقَّق منه (قرارات المالك):
 *   · إلغاء التأخير: يعود الموظف حاضرًا طبيعيًا ولا تُحسب دقائق تأخير.
 *   · «لم يحضر حتى الآن»: يبقى غير حاضر ويُسجَّل حضوره لاحقًا على نفس السجل.
 *   · غائب: غياب واحد بلا ازدواج اسم.
 *   · لا حذف للأحداث الأصلية — السجل الخام يحتفظ بكل شيء (أثر تدقيق).
 *   · idempotency: التصحيح بلا هدف قائم يُتخطى (appended=0).
 *
 * التشغيل: node scripts/attendance-correction-test.js   (خروج غير صفري عند أي فشل)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
}

/** وقت جداري بالرياض ← UTC ISO (نفس تثبيت +03:00 الصريح في الخدمة). */
const R = (date, hhmm) => new Date(date + 'T' + hhmm + ':00+03:00').toISOString();

async function main() {
    console.log('\n═══ اختبارات بند «تصحيح الحالة» — تصحيحات الحضور append-only ═══\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-corr-'));
    const tmpDb = path.join(tmpDir, 'test.db');
    process.env.DB_PATH = tmpDb; // يجب أن يسبق require — db.js يقرأه عند التحميل

    const db = require(path.join(ROOT, 'db.js'));
    try {
        await db.init(false); // مخطط كامل + ترحيلات + بذر
        const StorageAdapter = require(path.join(ROOT, 'storage-adapter.js'));
        const storage = new StorageAdapter(db);
        const StaffingEventsService = require(path.join(ROOT, 'services', 'staffing-events-service.js'));
        const svc = new StaffingEventsService({ storage, engine: {} });
        const RosterSyncService = require(path.join(ROOT, 'services', 'roster-sync-service'));
        const sync = new RosterSyncService({ db });

        const D = '2026-09-01';
        const NAMES = [
            'أحمد إلغاء مفتوح', 'خالد زوج مكتمل', 'سعود لم يحضر', 'فهد تحويل غياب',
            'ماجد تكرار', 'ناصر بلا هدف', 'عمر وقت مصحح', 'وليد هدف خاطئ', 'يوسف غائب حضر'
        ];
        await sync.syncFromSchedule(NAMES.map((n, i) => ({
            employeeNumber: String(900 + i), name: n, team: 'جنوب 3', jobTitle: 'مسعف',
            schedule: [{ date: D, shiftCode: 'D12' }]
        })));

        const shiftId = (await db.run(
            `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time)
             VALUES ('صباحية الاختبار', ?, '05:00', 'صباحية', 'الثلاثاء', ?)`, [D, R(D, '05:00')])).id;

        const actor = { id: 'test-supervisor', name: 'مشرف الاختبار' };
        const append = (events) => svc.appendPersonEvents({
            shiftId, shiftDate: D, shiftType: 'صباحية', events, actor
        });
        const ev = (type, employeeName, extra = {}) => ({ type, employeeName, teamId: 'جنوب 3', ...extra });
        const lateRecs = async () => (await svc.getTimeline(shiftId)).lateRecords || [];
        const recOf = async (n) => (await lateRecs()).filter(r => r.employee === n);
        const openOf = async (n) => {
            const st = await svc.getState(shiftId);
            const f = (st.entities || []).find(x => x.entityId === n);
            return f ? f.open : [];
        };

        // ─── ① تأخر مفتوح ثم «إلغاء التأخير» — يختفي السجل ويعود حاضرًا طبيعيًا ───
        let r = await append([ev('late', 'أحمد إلغاء مفتوح', { reason: 'مسعف متأخر' })]);
        const lateId1 = r.events[0] && r.events[0].id;
        r = await append([ev('correction', 'أحمد إلغاء مفتوح', { corrects: 'late_void', targetEventId: lateId1 })]);
        const recs1 = await recOf('أحمد إلغاء مفتوح');
        const open1 = await openOf('أحمد إلغاء مفتوح');
        record('① إلغاء تأخير مفتوح: appended=1 · لا سجل تأخير · لا فتح مفتوح (حاضر طبيعي)',
            r.appended === 1 && recs1.length === 0 && open1.length === 0,
            `appended=${r.appended} records=${recs1.length} open=${open1.length}`);

        // ─── ② زوج مكتمل (تأخر+حضور) ثم «إلغاء التأخير» — يزول الزوج كله ولا دقائق ───
        await append([ev('late', 'خالد زوج مكتمل', { reason: 'مسعف متأخر' })]);
        await append([ev('arrival', 'خالد زوج مكتمل')]);
        const recs2pre = await recOf('خالد زوج مكتمل');
        const lateId2 = recs2pre[0] && recs2pre[0].openEventId;
        r = await append([ev('correction', 'خالد زوج مكتمل', { corrects: 'late_void', targetEventId: lateId2 })]);
        const recs2 = await recOf('خالد زوج مكتمل');
        const open2 = await openOf('خالد زوج مكتمل');
        record('② إلغاء تأخير لزوج مكتمل: يزول السجل كاملًا (لا «حاضر متأخر» ولا دقائق) ولا فتح',
            r.appended === 1 && recs2pre.length === 1 && recs2.length === 0 && open2.length === 0,
            `قبل=${recs2pre.length} بعد=${recs2.length} open=${open2.length}`);

        // ─── ③ «لم يحضر حتى الآن» ثم حضور لاحق — على نفس السجل، بلا تكرار اسم ───
        await append([ev('late', 'سعود لم يحضر', { reason: 'مسعف متأخر' })]);
        await append([ev('arrival', 'سعود لم يحضر')]);
        const recs3pre = await recOf('سعود لم يحضر');
        const arrId3 = recs3pre[0] && recs3pre[0].arrivalEventId;
        r = await append([ev('correction', 'سعود لم يحضر', { corrects: 'arrival_void', targetEventId: arrId3 })]);
        const recs3mid = await recOf('سعود لم يحضر');
        const midOk = r.appended === 1 && recs3mid.length === 1 && recs3mid[0].status === 'not_arrived' &&
            recs3mid[0].startedAt === R(D, '05:00');
        // حضور لاحق على نفس السجل — يُقبل لأن الفتح الأصلي عاد مفتوحًا
        const r3b = await append([ev('arrival', 'سعود لم يحضر')]);
        const recs3 = await recOf('سعود لم يحضر');
        const finalOk = r3b.appended === 1 && recs3.length === 1 && recs3[0].status === 'arrived' &&
            recs3[0].openEventId === recs3mid[0].openEventId; // نفس سجل الفتح الأصلي
        record('③ لم يحضر حتى الآن: يعود not_arrived بنفس البداية، والحضور اللاحق على نفس السجل (سجل واحد)',
            midOk && finalOk,
            `mid=${recs3mid.length}/${recs3mid[0] && recs3mid[0].status} final=${recs3.length}/${recs3[0] && recs3[0].status} appended=${r3b.appended}`);

        // ─── ④ تحويل تأخر → غياب في دفعة واحدة — غياب واحد بلا ازدواج ───
        await append([ev('late', 'فهد تحويل غياب', { reason: 'مسعف متأخر' })]);
        const recs4pre = await recOf('فهد تحويل غياب');
        const lateId4 = recs4pre[0] && recs4pre[0].openEventId;
        r = await append([
            ev('correction', 'فهد تحويل غياب', { corrects: 'late_void', targetEventId: lateId4 }),
            ev('absence', 'فهد تحويل غياب', { reason: 'ظرف طارئ' })
        ]);
        const recs4 = await recOf('فهد تحويل غياب');
        const open4 = await openOf('فهد تحويل غياب');
        record('④ تحويل تأخر→غياب: appended=2 · سجل واحد absence · لا سجل late · فتح واحد',
            r.appended === 2 && recs4.length === 1 && recs4[0].sourceEventType === 'absence' &&
            open4.length === 1 && open4[0].event_type === 'absence',
            `appended=${r.appended} records=${recs4.map(x => x.sourceEventType).join(',')} open=${open4.map(o => o.event_type).join(',')}`);

        // ─── ⑤ idempotency: تكرار نفس التصحيح لا يُلحق حدثًا ثانيًا ───
        await append([ev('late', 'ماجد تكرار', { reason: 'مسعف متأخر' })]);
        r = await append([ev('correction', 'ماجد تكرار', { corrects: 'late_void' })]); // بلا هدف صريح — الأحدث
        const firstVoid = r.appended;
        r = await append([ev('correction', 'ماجد تكرار', { corrects: 'late_void' })]); // تكرار — بلا هدف قائم
        record('⑤ idempotency: الإلغاء الأول appended=1 والمكرر appended=0 (لا تكرار تدقيقي بلا أثر)',
            firstVoid === 1 && r.appended === 0, `أول=${firstVoid} مكرر=${r.appended}`);

        // ─── ⑥ تصحيح بلا هدف أصلًا (موظف بلا أحداث) ⇒ يُتخطى ───
        r = await append([ev('correction', 'ناصر بلا هدف', { corrects: 'arrival_void' })]);
        record('⑥ arrival_void بلا زوج وصول قائم ⇒ appended=0 ولا حدث',
            r.appended === 0, `appended=${r.appended}`);

        // ─── ⑦ تصحيح وقت الحضور بهدف صريح — يطبَّق على زوجه ويُعاد حساب المدة ───
        await append([ev('late', 'عمر وقت مصحح', { reason: 'مسعف متأخر' })]);
        await append([ev('arrival', 'عمر وقت مصحح')]);
        const recs7pre = await recOf('عمر وقت مصحح');
        const arrId7 = recs7pre[0] && recs7pre[0].arrivalEventId;
        r = await append([ev('correction', 'عمر وقت مصحح', { corrects: 'arrival_time', arrivalAt: R(D, '06:30'), targetEventId: arrId7 })]);
        const recs7 = await recOf('عمر وقت مصحح');
        record('⑦ arrival_time بهدف صريح: الحضور 06:30 والمدة 90 دقيقة من بداية المناوبة',
            r.appended === 1 && recs7.length === 1 && recs7[0].arrivedAt === R(D, '06:30') && recs7[0].durationMinutes === 90,
            `appended=${r.appended} arrivedAt=${recs7[0] && recs7[0].arrivedAt} مدة=${recs7[0] && recs7[0].durationMinutes}`);

        // ─── ⑧ التحقق: نوع تصحيح غير معروف ⇒ 400 · arrival_time بلا وقت ⇒ 400 ───
        let bad1 = null, bad2 = null;
        try { await append([ev('correction', 'وليد هدف خاطئ', { corrects: 'magic' })]); } catch (e) { bad1 = e; }
        try { await append([ev('correction', 'وليد هدف خاطئ', { corrects: 'arrival_time' })]); } catch (e) { bad2 = e; }
        record('⑧ التحقق: corrects غير معروف ⇒ 400 · arrival_time بلا وقت ⇒ 400',
            !!(bad1 && bad1.statusCode === 400 && bad2 && bad2.statusCode === 400),
            `bad1=${bad1 && bad1.statusCode} bad2=${bad2 && bad2.statusCode}`);

        // ─── ⑨ هدف صريح من نوع مختلف (id حدث arrival لتصحيح late_void) ⇒ يُتخطى بلا استنتاج ───
        await append([ev('late', 'وليد هدف خاطئ', { reason: 'مسعف متأخر' })]);
        await append([ev('arrival', 'وليد هدف خاطئ')]);
        const recs9pre = await recOf('وليد هدف خاطئ');
        const wrongId = recs9pre[0] && recs9pre[0].arrivalEventId; // arrival وليس late
        r = await append([ev('correction', 'وليد هدف خاطئ', { corrects: 'late_void', targetEventId: wrongId })]);
        const recs9 = await recOf('وليد هدف خاطئ');
        record('⑨ هدف صريح غير مطابق للنوع ⇒ appended=0 والسجل كما هو (لا استنتاج بديل)',
            r.appended === 0 && recs9.length === 1 && recs9[0].status === 'arrived',
            `appended=${r.appended} records=${recs9.length}`);

        // ─── ⑩ غائب حضر (حاضر متأخر) ثم «إلغاء الغياب» — يزول الزوج ويعود حاضرًا طبيعيًا ───
        await append([ev('absence', 'يوسف غائب حضر', { reason: 'لم يحضر' })]);
        await append([ev('arrival', 'يوسف غائب حضر')]);
        const recs10pre = await recOf('يوسف غائب حضر');
        const absId10 = recs10pre[0] && recs10pre[0].openEventId;
        r = await append([ev('correction', 'يوسف غائب حضر', { corrects: 'absence_void', targetEventId: absId10 })]);
        const recs10 = await recOf('يوسف غائب حضر');
        const open10 = await openOf('يوسف غائب حضر');
        record('⑩ إلغاء غياب لزوج مكتمل: يزول سجل «حاضر متأخر» ولا فتح (حاضر طبيعي)',
            r.appended === 1 && recs10pre.length === 1 && recs10pre[0].sourceEventType === 'absence' &&
            recs10.length === 0 && open10.length === 0,
            `قبل=${recs10pre.length}/${recs10pre[0] && recs10pre[0].sourceEventType} بعد=${recs10.length} open=${open10.length}`);

        // ─── ⑪ أثر التدقيق: السجل الخام يحتفظ بكل الأحداث (المصحَّحة والتصحيحات) ───
        const tl = await svc.getTimeline(shiftId);
        const rawKhaled = (tl.events || []).filter(e => e.entity_id === 'خالد زوج مكتمل');
        const rawTypes = rawKhaled.map(e => e.event_type).sort().join(',');
        record('⑪ لا حذف: السجل الخام لـ«خالد» يحوي late+arrival+correction رغم زواله من المشتقات',
            rawKhaled.length === 3 && rawTypes === 'arrival,correction,late',
            `raw=${rawTypes}`);

        // ─── ⑫ حقول الاستهداف: openEventId/arrivalEventId معرَّفة في السجلات المشتقة ───
        const recs12 = await recOf('وليد هدف خاطئ');
        record('⑫ السجلات تحمل openEventId وarrivalEventId (استهداف دقيق من الواجهة)',
            !!(recs12[0] && recs12[0].openEventId != null && recs12[0].arrivalEventId != null),
            `open=${recs12[0] && recs12[0].openEventId} arrival=${recs12[0] && recs12[0].arrivalEventId}`);

    } finally {
        if (db.closeDb) await db.closeDb();
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { }
    }

    const failed = results.filter(x => !x.ok);
    console.log(`\n═══ النتيجة: ${results.length - failed.length}/${results.length} ناجح ═══`);
    if (failed.length) { console.error('فشل:', failed.map(x => x.name).join(' | ')); process.exit(1); }
}

main().catch(e => { console.error('خطأ غير متوقع:', e); process.exit(1); });
