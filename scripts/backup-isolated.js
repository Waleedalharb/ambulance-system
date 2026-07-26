// Isolated DB copy for test gates via better-sqlite3 backup API (safe with live WAL source)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dest = process.argv[2];
if (!dest) { console.error('usage: node backup-isolated.js <dest-db-path>'); process.exit(1); }
fs.mkdirSync(path.dirname(dest), { recursive: true });
const src = new Database(path.join(__dirname, '..', 'database.db'), { readonly: true });
src.backup(dest).then(() => {
    src.close();
    console.log('backup done -> ' + dest);
    process.exit(0);
}).catch((e) => { console.error('backup failed: ' + e.message); process.exit(1); });
