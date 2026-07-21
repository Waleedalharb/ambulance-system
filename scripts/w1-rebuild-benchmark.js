/**
 * W1 Rebuild Benchmark — أداة قياس مستقلة (ليست جزءًا من النظام)
 * ═══════════════════════════════════════════════════════════════
 * قرار المالك (W1-E-C): الـ Benchmark سكربت قياس خارجي، نتائجه توثق في
 * تقرير الشريحة فقط، ولا يدخل أي كود قياس إلى المنصة.
 *
 * يقيس:
 *   1) أكبر مناوبة بعدد الأحداث في قاعدة فعلية + زمن إعادة الاشتقاق الكامل.
 *   2) إجهاد تركيبي: طيّ 100 / 500 / 1000 / 5000 حدث (معيار W2).
 *
 * التشغيل:
 *   node scripts/w1-rebuild-benchmark.js <مسار_قاعدة_البيانات>
 *   أو: DB_PATH=<مسار> node scripts/w1-rebuild-benchmark.js
 */

const path = require('path');
const { foldEvents, deriveIndicators } = require(path.join(__dirname, '..', 'services', 'operational-events-core'));

const RUNS = 50;

function bench(label, fn) {
    // إحماء
    for (let i = 0; i < 5; i++) fn();
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < RUNS; i++) fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
    return { label, avgMs: +ms.toFixed(3) };
}

function fullRebuild(events) {
    // إعادة اشتقاق كاملة: طيّ كل نطاق + مؤشراته (كما تفعل خدمات W1)
    const domains = ['staffing', 'vehicle', 'center', 'logistics'];
    let acc = 0;
    for (const d of domains) {
        const folded = foldEvents(events, d);
        const ind = deriveIndicators(events, d);
        acc += folded.length + Object.keys(ind).length;
    }
    return acc;
}

function synthEvents(n) {
    const out = [];
    const types = ['absence', 'late', 'arrival', 'exit', 'return', 'ready', 'missing', 'offline', 'note', 'external_support', 'support_end'];
    const base = Date.now();
    for (let i = 0; i < n; i++) {
        out.push({
            id: i + 1, shift_id: 1, shift_date: '2026-01-01', shift_type: 'صباح',
            domain: i % 3 === 0 ? 'vehicle' : 'staffing',
            entity_id: 'ent_' + (i % 40), entity_name: 'كيان ' + (i % 40),
            team_id: 'جنوب ' + ((i % 16) + 1), center: 'مركز ' + (i % 8),
            event_type: i % 3 === 0 ? 'status_change' : types[i % types.length],
            status: i % 3 === 0 ? ['active', 'reserve', 'breakdown', 'out_of_service'][i % 4] : null,
            reason: i % 5 === 0 ? 'سبب اختبار' : null,
            payload: null, note: null, corrects_event_id: null,
            actor_id: '1', actor_name: 'قياس', created_at: new Date(base + i * 1000).toISOString()
        });
    }
    return out;
}

async function main() {
    const results = { generatedAt: new Date().toISOString(), runs: RUNS, real: null, synthetic: [] };

    // ─── 1) قاعدة فعلية: أكبر مناوبة بعدد الأحداث ───
    const dbPath = process.argv[2] || process.env.DB_PATH;
    if (dbPath) {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath, { readonly: true });
        const top = db.prepare('SELECT shift_id, COUNT(*) c FROM operational_events GROUP BY shift_id ORDER BY c DESC LIMIT 1').get();
        const totals = db.prepare('SELECT COUNT(*) c, COUNT(DISTINCT shift_id) s FROM operational_events').get();
        if (top) {
            const events = db.prepare('SELECT * FROM operational_events WHERE shift_id = ? ORDER BY created_at ASC, id ASC').all(top.shift_id);
            const r = bench('real-largest-shift', () => fullRebuild(events));
            results.real = { shiftId: top.shift_id, events: events.length, rebuildAvgMs: r.avgMs, totalEventsInDb: totals.c, totalShiftsWithEvents: totals.s };
        } else {
            results.real = { note: 'لا أحداث في القاعدة بعد', totalEventsInDb: totals.c };
        }
        db.close();
    } else {
        results.real = { note: 'لم يُمرر مسار قاعدة — قياس تركيبي فقط' };
    }

    // ─── 2) إجهاد تركيبي (منحنى التكلفة — معيار W2) ───
    for (const n of [100, 500, 1000, 5000]) {
        const events = synthEvents(n);
        const r = bench('synthetic-' + n, () => fullRebuild(events));
        results.synthetic.push({ events: n, rebuildAvgMs: r.avgMs, perEventMicros: +(r.avgMs * 1000 / n).toFixed(2) });
    }

    console.log(JSON.stringify(results, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
