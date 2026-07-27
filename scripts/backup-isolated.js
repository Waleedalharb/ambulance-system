// Isolated DB copy for test gates via better-sqlite3 backup API (safe with live WAL source)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dest = process.argv[2];
if (!dest) { console.error('usage: node backup-isolated.js <dest-db-path>'); process.exit(1); }
fs.mkdirSync(path.dirname(dest), { recursive: true });
// المصدر: القاعدة الدائمة الجديدة أولًا، ثم القديمة في الجذر كاحتياط (قبل الترحيل)
const candidates = [
    path.join(__dirname, '..', 'data', 'ambulance.db'),
    path.join(__dirname, '..', 'database.db')
];
const srcPath = process.env.DB_SRC || candidates.find(p => fs.existsSync(p) && fs.statSync(p).size > 0);
if (!srcPath) { console.error('no source db found'); process.exit(1); }
const src = new Database(srcPath, { readonly: true });
src.backup(dest).then(() => {
    src.close();
    console.log('backup done -> ' + dest);
    process.exit(0);
}).catch((e) => { console.error('backup failed: ' + e.message); process.exit(1); });
