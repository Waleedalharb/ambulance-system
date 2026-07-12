const Database = require('better-sqlite3');
const db = new Database(':memory:');

// Read TABLE_SCHEMAS from file
const fs = require('fs');
const code = fs.readFileSync('./db.js', 'utf8');

// Use same approach as initTables: find the array and eval
const regex = /const TABLE_SCHEMAS = \[([\s\S]*?)\];/;
const match = regex.exec(code);
if (match) {
  // Try a different eval approach
  const arrCode = match[0].replace('const TABLE_SCHEMAS', 'TABLE_SCHEMAS');
  eval(arrCode);
  console.log('Array length:', TABLE_SCHEMAS.length);
  for (let i = 0; i < TABLE_SCHEMAS.length; i++) {
    console.log(i, typeof TABLE_SCHEMAS[i]);
  }
} else {
  console.log('No match');
}
