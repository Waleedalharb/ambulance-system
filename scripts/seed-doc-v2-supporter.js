// بذرة صف داعم خارجي في القاعدة المعزولة فقط (بوابة doc-v2 — «الداعمون 0/0»)
const Database = require('better-sqlite3');
const db = new Database('C:/projects/Ambulance Dispatch/data/temp/gate-3085/database.db');
const info = db.prepare(`INSERT INTO operational_events
    (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center, event_type, readiness_basis, actor_id, actor_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    1784126563155,
    '2026-07-22',
    'صباح',
    'staffing',
    'فواز حميد خلاف الظفيري',
    'فواز حميد خلاف الظفيري',
    'جنوب 1',
    'الاحتياط',
    'external_support',
    'external_support',
    'emp-4252',
    'مشرف النظام',
    '2026-07-22T04:30:00.000Z'
);
console.log('inserted rowid=' + info.lastInsertRowid);
db.close();
