const db = require('./db');

(async () => {
  await db.openDb();
  // Read TABLE_SCHEMAS from the file directly
  const fs = require('fs');
  const code = fs.readFileSync('./db.js', 'utf8');
  const start = code.indexOf('const TABLE_SCHEMAS = [');
  const end = code.indexOf('];', start) + 2;
  const arrCode = code.substring(start, end);
  const evalSchemas = eval(arrCode);
  console.log('Eval schemas count:', evalSchemas.length);
  for (let i = 0; i < evalSchemas.length; i++) {
    console.log(i, typeof evalSchemas[i], evalSchemas[i] ? evalSchemas[i].substring(0,30) : 'NULL');
  }
})().catch(e => console.log('Error:', e.message));
