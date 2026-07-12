const db = require('./db');

(async () => {
  await db.openDb();
  // Override initTables to debug
  const originalExec = db.exec;
  let count = 0;
  db.exec = async (sql) => {
    console.log('exec #' + count, typeof sql, sql ? sql.substring(0,40) : 'NULL');
    count++;
    if (typeof sql !== 'string') {
      console.log('NON-STRING! Skipping...');
      return;
    }
    return originalExec(sql);
  };
  try {
    await db.init(true);
  } catch (e) {
    console.log('Error:', e.message);
  }
})().catch(e => console.log('Error:', e.message));
