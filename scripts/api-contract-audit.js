// تدقيق عقود API: يستخرج كل مسارات API المستخدمة في تطبيق iOS الأصلي
// ويطابقها مع مسارات Express الفعلية في server.js.
// الاستخدام: node scripts/api-contract-audit.js
const fs = require('fs');
const path = require('path');

const IOS_ROOT = path.join(__dirname, '..', 'ios-native', 'EMSOperations');
const SERVER = 'C:\\projects\\Ambulance Dispatch\\server.js';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.swift')) out.push(p);
  }
  return out;
}

// 1) مسارات الخادم: app.METHOD('/api/...') مع وسطاء
const serverSrc = fs.readFileSync(SERVER, 'utf8');
const serverRoutes = new Set();
const routeRe = /app\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
let m;
while ((m = routeRe.exec(serverSrc))) {
  const norm = m[2].replace(/:([^/]+)/g, ':_');
  serverRoutes.add(`${m[1].toUpperCase()} ${norm}`);
}
// مسارات مسجلة عبر راوترات فرعية إن وجدت (app.use('/x', router)) — تُرصد يدويًا عند الحاجة

// 2) مسارات التطبيق: api.get/post/put/delete + getRaw/postRaw/putRaw + download
const swiftFiles = walk(IOS_ROOT);
const callRe = /api\.(get|post|put|delete|getRaw|postRaw|putRaw|download)\(\s*"([^"]+)"/g;
const appCalls = [];
for (const f of swiftFiles) {
  const src = fs.readFileSync(f, 'utf8');
  let mm;
  while ((mm = callRe.exec(src))) {
    const rawPath = mm[2].replace(/\\\([^)]*\)/g, ':_'); // \(id) → :_
    appCalls.push({
      method: mm[1].replace('getRaw', 'get').replace('postRaw', 'post').replace('putRaw', 'put').replace('download', 'get').toUpperCase(),
      path: rawPath,
      file: path.relative(IOS_ROOT, f),
      line: src.slice(0, mm.index).split('\n').length
    });
  }
}

// 3) المطابقة
const missing = [];
for (const c of appCalls) {
  const key = `${c.method} ${c.path}`;
  if (!serverRoutes.has(key)) missing.push(c);
}

console.log(`مسارات خادم مستخرجة: ${serverRoutes.size}`);
console.log(`استدعاءات تطبيق مستخرجة: ${appCalls.length}`);
if (missing.length === 0) {
  console.log('✅ كل استدعاءات التطبيق لها مسار مطابق في server.js');
} else {
  console.log(`❌ استدعاءات بلا مسار مطابق (${missing.length}):`);
  for (const c of missing) console.log(`  ${c.method} ${c.path}  ← ${c.file}:${c.line}`);
}
