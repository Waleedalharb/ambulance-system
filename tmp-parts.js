const fs = require('fs');
const code = fs.readFileSync('./db.js', 'utf8');
const regex = /const TABLE_SCHEMAS = \[([\s\S]*?)\];/;
const match = regex.exec(code);
if (match) {
  // Extract just the array body and wrap in []
  const body = match[1];
  // Split by backtick pairs
  const parts = [];
  let pos = 0;
  while (true) {
    const bt = body.indexOf('`', pos);
    if (bt === -1) break;
    const et = body.indexOf('`', bt + 1);
    if (et === -1) break;
    parts.push(body.substring(bt + 1, et));
    pos = et + 1;
  }
  console.log('Parts:', parts.length);
  
  // Check for any non-string looking things
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].trim().startsWith('CREATE')) {
      console.log('BAD at', i, parts[i].substring(0,50));
    }
  }
}
