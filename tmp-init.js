const db = require('./db');

(async () => {
  await db.openDb();
  const fs = require('fs');
  const code = fs.readFileSync('./db.js', 'utf8');
  const start = code.indexOf('const TABLE_SCHEMAS = [');
  const end = code.indexOf('];', start) + 2;
  const arrCode = code.substring(start, end);
  const items = [];
  let pos = 0;
  while (true) {
    const bt = arrCode.indexOf('`', pos);
    if (bt === -1) break;
    const et = arrCode.indexOf('`', bt + 1);
    if (et === -1) break;
    items.push(arrCode.substring(bt + 1, et));
    pos = et + 1;
  }
  for (let i = 0; i < items.length; i++) {
    try {
      await db.exec(items[i]);
      console.log('OK', i);
    } catch (e) {
      console.log('FAIL', i, e.message);
    }
  }
  console.log('Done');
})().catch(e => console.log('Error:', e.message));
