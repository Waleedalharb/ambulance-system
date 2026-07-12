const fs = require('fs');
const code = fs.readFileSync('./db.js', 'utf8');

// Find TABLE_SCHEMAS declaration
const regex = /const TABLE_SCHEMAS = \[([\s\S]*?)\];/;
const match = regex.exec(code);
if (match) {
  console.log('Found TABLE_SCHEMAS');
  console.log('First 200 chars:', match[0].substring(0,200));
  console.log('Last 200 chars:', match[0].substring(match[0].length-200));
  
  // Try to evaluate
  try {
    const arr = eval(match[0]);
    console.log('Array length:', arr.length);
    for (let i=0; i<arr.length; i++) {
      console.log(i, typeof arr[i], arr[i] ? arr[i].substring(0,30) : 'NULL');
    }
  } catch(e) {
    console.log('Eval error:', e.message);
  }
} else {
  console.log('Not found');
}
