#!/usr/bin/env node
'use strict';
/** اختبار معزول: نسخة قبل الترحيل + بقاء الأرشيف + فشل الإقلاع الآمن. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const { protectDatabaseStartup, inspectDatabase } = require('../services/database-startup-safety');
const OUT = path.join(ROOT, 'test-output', 'database-startup-safety-' + Date.now());
const DATA = path.join(OUT, 'data');
const DB = path.join(DATA, 'ambulance.db');
const BACKUP = path.join(OUT, 'backups');
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail: detail || null });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!condition) throw new Error(name);
}
function hashRows(rows) { return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'); }
function tableColumns(db, table) { return db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name); }
function originalRows(dbPath, table, columns) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const quoted = columns.map(c => `"${c.replace(/"/g, '""')}"`).join(', ');
  const rows = db.prepare(`SELECT ${quoted} FROM "${table}" ORDER BY rowid`).all();
  db.close();
  return rows;
}
function vacuumCopy(sourcePath, targetPath) {
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  db.close();
}
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}
function runMigration(dbPath, dataDir) {
  const result = spawnSync(process.execPath, ['-e', `const db=require(${JSON.stringify(path.join(ROOT, 'db.js'))}); db.init(true).then(()=>db.closeDb()).catch(e=>{console.error(e.stack);process.exit(1);});`], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', DB_PATH: dbPath, DATA_DIR: dataDir, SCHEDULE_FILE: path.join(dataDir, 'schedule-employees.json'), REGION_COMMAND_ENABLED: 'true' },
    encoding: 'utf8', maxBuffer: 30 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result;
}
async function expectFailedServer(dbPath, dataDir, backupDir) {
  const port = await freePort();
  const env = {
    ...process.env,
    NODE_ENV: 'production', PORT: String(port), JWT_SECRET: 'isolated-safety-test-only',
    DATA_DIR: dataDir, DB_PATH: dbPath, BACKUP_DIR: backupDir,
    SCHEDULE_FILE: path.join(dataDir, 'schedule-employees.json'), REGION_COMMAND_ENABLED: 'true'
  };
  delete env.RENDER_DISK_PATH;
  delete env.DB_STARTUP_BACKUP_ENABLED;
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Server did not fail closed within 20 seconds')); }, 20000);
    child.once('error', reject);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  return { exit, log };
}
(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  const sourcePath = path.join(ROOT, 'data', 'ambulance.db');
  vacuumCopy(sourcePath, DB);
  for (const name of ['users.json', 'shift-data.json', 'schedule-employees.json']) {
    const source = path.join(ROOT, 'data', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(DATA, name));
  }
  const before = inspectDatabase(DB);
  const sourceDb = new Database(DB, { readonly: true });
  const originalColumns = Object.fromEntries(Object.keys(before.tables).map(table => [table, tableColumns(sourceDb, table)]));
  const archivedBefore = sourceDb.prepare("SELECT COUNT(*) AS c FROM shifts WHERE status='archived'").get().c;
  sourceDb.close();
  check('نسخة الاختبار سليمة وتحتوي أرشيفًا حقيقيًا', before.integrity === 'ok' && archivedBefore > 0, `${archivedBefore} مناوبة مؤرشفة`);

  const protectedResult = await protectDatabaseStartup({ production: true, dbPath: DB, storagePath: DATA, backupDir: BACKUP });
  check('الحارس أنشأ لقطة قبل أي ترحيل', protectedResult.status === 'created' && fs.existsSync(protectedResult.snapshotPath));
  check('اللقطة وبيّنتها محفوظتان في pre-deploy', protectedResult.snapshotPath.includes(path.join('backups', 'pre-deploy')) && fs.existsSync(protectedResult.manifestPath));
  const snapshotInspection = inspectDatabase(protectedResult.snapshotPath);
  check('سلامة وبصمة اللقطة تطابقان المصدر', snapshotInspection.integrity === 'ok' && snapshotInspection.contentFingerprint === before.contentFingerprint);
  const manifest = JSON.parse(fs.readFileSync(protectedResult.manifestPath, 'utf8'));
  check('البيان يوثق جميع الجداول وبصمة ملف اللقطة', Object.keys(manifest.database.tables).length === Object.keys(before.tables).length && manifest.snapshot.sha256 === crypto.createHash('sha256').update(fs.readFileSync(protectedResult.snapshotPath)).digest('hex'));

  runMigration(DB, DATA);
  const after = inspectDatabase(DB);
  check('القاعدة سليمة بعد init + migrate', after.integrity === 'ok');
  const archivedAfterDb = new Database(DB, { readonly: true });
  const archivedAfter = archivedAfterDb.prepare("SELECT COUNT(*) AS c FROM shifts WHERE status='archived'").get().c;
  archivedAfterDb.close();
  check('كل المناوبات المؤرشفة بقيت بعد الترقية', archivedAfter === archivedBefore, `${archivedBefore} → ${archivedAfter}`);
  const changed = [];
  for (const table of Object.keys(before.tables)) {
    if (!after.tables[table]) { changed.push({ table, reason: 'deleted' }); continue; }
    const oldRows = originalRows(protectedResult.snapshotPath, table, originalColumns[table]);
    const newRows = originalRows(DB, table, originalColumns[table]);
    if (hashRows(oldRows) !== hashRows(newRows)) changed.push({ table, reason: 'original columns changed' });
  }
  check('كل صفوف الجداول القديمة محفوظة بأعمدتها الأصلية', changed.length === 0, changed.length ? JSON.stringify(changed) : `${Object.keys(before.tables).length} جدولًا`);

  const second = await protectDatabaseStartup({ production: true, dbPath: DB, storagePath: DATA, backupDir: BACKUP });
  const third = await protectDatabaseStartup({ production: true, dbPath: DB, storagePath: DATA, backupDir: BACKUP });
  check('إعادة الإقلاع بلا تغيير تعيد استخدام لقطة موثقة', second.status === 'created' && third.status === 'reused' && third.snapshotPath === second.snapshotPath);

  const emptyData = path.join(OUT, 'missing-data');
  fs.mkdirSync(emptyData, { recursive: true });
  let missingError = null;
  try {
    await protectDatabaseStartup({ production: true, dbPath: path.join(emptyData, 'ambulance.db'), storagePath: emptyData, backupDir: path.join(emptyData, 'backups') });
  } catch (error) { missingError = error; }
  check('غياب القاعدة في الإنتاج يوقف الإقلاع ولا ينشئ قاعدة', missingError && missingError.code === 'DB_STARTUP_SAFETY_FAILED' && !fs.existsSync(path.join(emptyData, 'ambulance.db')));
  const allowedEmpty = await protectDatabaseStartup({ production: true, allowEmpty: true, dbPath: path.join(emptyData, 'ambulance.db'), storagePath: emptyData, backupDir: path.join(emptyData, 'backups') });
  check('التثبيت الجديد يحتاج سماحًا صريحًا ولا يُنشئ الحارس قاعدة', allowedEmpty.status === 'empty-database-allowed' && !fs.existsSync(path.join(emptyData, 'ambulance.db')));

  const failureData = path.join(OUT, 'failure-data');
  fs.mkdirSync(failureData, { recursive: true });
  const failureDb = path.join(failureData, 'ambulance.db');
  vacuumCopy(sourcePath, failureDb);
  for (const name of ['users.json', 'schedule-employees.json']) {
    const source = path.join(ROOT, 'data', name);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(failureData, name));
  }
  const failureBefore = inspectDatabase(failureDb);
  const blockingFile = path.join(OUT, 'backup-destination-is-a-file');
  fs.writeFileSync(blockingFile, 'synthetic failure injection');
  const failedServer = await expectFailedServer(failureDb, failureData, blockingFile);
  const failureAfter = inspectDatabase(failureDb);
  check('فشل وجهة النسخ يجعل الخادم يخرج بفشل', failedServer.exit.code === 1, `exit=${failedServer.exit.code}`);
  check('الفشل يحدث قبل الترحيل ولا يغيّر القاعدة', failureAfter.contentFingerprint === failureBefore.contentFingerprint && failedServer.log.includes('تم إيقاف الإقلاع لحماية البيانات'));

  const summary = { passed: checks.length, failed: 0, checks, archivedBefore, archivedAfter, tablesVerified: Object.keys(before.tables).length, output: OUT, snapshot: protectedResult.snapshotPath, scope: 'isolated copies only; no production data or deployment touched', finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nالنتيجة: ${summary.passed} ✅ / 0 ❌\nالأدلة: ${OUT}`);
})().catch(error => {
  console.error('❌ ' + error.stack);
  const summary = { passed: checks.filter(c => c.ok).length, failed: 1, checks, error: error.message, output: OUT, finishedAt: new Date().toISOString() };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  process.exitCode = 1;
});
