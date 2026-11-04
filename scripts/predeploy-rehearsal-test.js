#!/usr/bin/env node
/** Full isolated deployment rehearsal: cold start, additive migration, backup,
 * restore, rollback and static Render checks. Synthetic test-output data only. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const tar = require('tar');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output', 'predeploy-' + Date.now());
const NODE = process.execPath;
const MIGRATE = path.join(ROOT, 'scripts', 'migrate-schedule-p1-p3.js');
const BACKUP = path.join(ROOT, 'scripts', 'backup.js');
const SQL = fs.readFileSync(path.join(ROOT, 'deploy', 'migrations', '2026-11-04-schedule-p1-p3.sql'), 'utf8');
const TABLES = [...SQL.matchAll(/CREATE TABLE IF NOT EXISTS (schedule_\w+)/g)].map(match => match[1]);
const INDEXES = [...SQL.matchAll(/CREATE(?: UNIQUE)? INDEX IF NOT EXISTS (schedule_\w+|uq_schedule_\w+)/g)].map(match => match[1]);
const TRIGGERS = [...SQL.matchAll(/CREATE TRIGGER IF NOT EXISTS (schedule_\w+)/g)].map(match => match[1]);
const checks = [];
let server;
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail: detail || null });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!condition) throw new Error(name);
}
function shaRows(db, table) {
  return crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())).digest('hex');
}
function quick(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const result = db.pragma('quick_check', { simple: true });
  const foreign = db.pragma('foreign_key_check');
  db.close();
  return result === 'ok' && foreign.length === 0;
}
function run(script, args, env) {
  const result = spawnSync(NODE, [script, ...args], { cwd: ROOT, env: { ...process.env, ...(env || {}) }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${path.basename(script)} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}
function jsonRun(args) { return JSON.parse(run(MIGRATE, args)); }
function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(() => resolve(port)); });
  });
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, timeout = 30000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(150); }
  throw new Error('انتهت مهلة الانتظار' + (last ? ': ' + last.message : ''));
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(resolve, 5000); server.once('exit', () => { clearTimeout(timer); resolve(); }); server.kill(); });
}
function objects(dbPath, type) {
  const db = new Database(dbPath, { readonly: true }); const rows = db.prepare('SELECT name FROM sqlite_master WHERE type=?').all(type).map(row => row.name); db.close(); return rows;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('🧊 بروفة نشر معزولة: ' + OUT);
  const coldData = path.join(OUT, 'cold-data'); fs.mkdirSync(coldData, { recursive: true });
  const coldDb = path.join(coldData, 'ambulance.db');
  const port = await freePort();
  let serverLog = '';
  server = spawn(NODE, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DB_PATH: coldDb, DATA_DIR: coldData, SCHEDULE_FILE: path.join(coldData, 'schedule-employees.json'), JWT_SECRET: 'predeploy-synthetic-only', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
  await waitFor(async () => { const response = await fetch(`http://127.0.0.1:${port}/health`); return response.ok ? response.json() : null; });
  await waitFor(() => serverLog.includes('SQLite database ready'));
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  check('الإقلاع البارد و/health يعملان', health.status === 'ok' && health.checks.jwt === true);
  check('إثبات التخزين والقاعدة على القرص المعزول', health.storageProof.writable && health.storageProof.persistent && health.storageProof.dbPath === coldDb);
  const page = await fetch(`http://127.0.0.1:${port}/schedule-workspace.html`);
  check('واجهة P3 تُخدم بعد الإقلاع', page.status === 200 && (await page.text()).includes('مركز إدارة دورة الجدول'));
  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/schedule/workspace?month=2026-03`);
  check('واجهة API لا تفتح بلا مصادقة', unauthorized.status === 401);
  await stopServer(); server = null;
  check('مخطط P1–P3 بعد الإقلاع: 10/9/22', TABLES.every(name => objects(coldDb, 'table').includes(name)) && INDEXES.every(name => objects(coldDb, 'index').includes(name)) && TRIGGERS.every(name => objects(coldDb, 'trigger').includes(name)));
  check('سلامة SQLite بعد الإقلاع', quick(coldDb));

  // Meaningful synthetic protected rows, never production data.
  let db = new Database(coldDb);
  const employee = db.prepare("INSERT INTO employees (employee_code, name) VALUES ('PREDEPLOY-E', 'موظف بروفة اصطناعي')").run();
  const team = db.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get();
  db.prepare('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?)').run(employee.lastInsertRowid, team.id, '2026-01-01', 'D12', 1, 2026);
  const user = db.prepare('SELECT user_id FROM users ORDER BY rowid LIMIT 1').get();
  if (user) db.prepare('INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, ?, ?)').run(user.user_id, 'schedule.view', 1, 'بروفة اصطناعية');
  const protectedTables = ['shift_roster', 'schedule_months', 'employees', 'users', 'user_permissions', 'teams', 'leave_requests'];
  const baselineHashes = Object.fromEntries(protectedTables.map(table => [table, shaRows(db, table)]));
  db.close();

  const migrationDb = path.join(OUT, 'migration.db'); fs.copyFileSync(coldDb, migrationDb);
  db = new Database(migrationDb);
  db.pragma('foreign_keys = OFF');
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  for (const name of INDEXES) db.exec(`DROP INDEX IF EXISTS "${name}"`);
  for (const name of [...TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.pragma('foreign_keys = ON'); db.close();
  check('قاعدة ما قبل P1–P3 جاهزة للبروفة', !objects(migrationDb, 'table').some(name => TABLES.includes(name)) && quick(migrationDb));

  const backupDir = path.join(OUT, 'migration-backups');
  const dry = jsonRun(['--db', migrationDb]);
  check('dry-run لا يكتب ويكشف النواقص', dry.status === 'ready_to_apply' && dry.before.missing.table.length === 10 && dry.before.missing.index.length === 9 && dry.before.missing.trigger.length === 22);
  const applied = jsonRun(['--db', migrationDb, '--backup-dir', backupDir, '--apply']);
  check('الترحيل الإضافي طُبق مع نسخة سابقة', applied.status === 'applied' && fs.existsSync(applied.backup.path) && applied.backup.bytes > 0);
  check('الترحيل لم يغيّر البيانات المحمية', JSON.stringify(applied.protectedBefore) === JSON.stringify(applied.protectedAfter));
  check('لا توليد أو إثبات تغطية أو إصدارات بعد الترحيل', Object.values(applied.scheduleCountsAfter).every(value => value === 0));
  const verified = jsonRun(['--db', migrationDb, '--verify']);
  check('التحقق المستقل: المخطط مكتمل والقاعدة سليمة', verified.status === 'verified' && quick(migrationDb));
  const repeated = jsonRun(['--db', migrationDb, '--backup-dir', backupDir, '--apply']);
  check('إعادة تشغيل الترحيل idempotent بلا نسخة أو كتابة جديدة', repeated.status === 'already_applied' && !repeated.backup);

  const rollbackDb = path.join(OUT, 'rollback.db'); fs.copyFileSync(applied.backup.path, rollbackDb);
  db = new Database(rollbackDb, { readonly: true });
  const rollbackHashes = Object.fromEntries(protectedTables.map(table => [table, shaRows(db, table)])); db.close();
  check('نسخة التراجع تعيد مخطط ما قبل P1–P3 وتحفظ البيانات', !objects(rollbackDb, 'table').some(name => TABLES.includes(name)) && JSON.stringify(rollbackHashes) === JSON.stringify(baselineHashes) && quick(rollbackDb));

  const dataDir = path.join(OUT, 'backup-data'); fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true }); fs.mkdirSync(path.join(dataDir, 'exports'), { recursive: true });
  const liveDb = path.join(dataDir, 'ambulance.db'); fs.copyFileSync(migrationDb, liveDb);
  fs.writeFileSync(path.join(dataDir, 'users.json'), '[{"id":"synthetic","role":"admin"}]\n');
  fs.writeFileSync(path.join(dataDir, 'schedule-employees.json'), '{"employees":[]}\n');
  fs.writeFileSync(path.join(dataDir, 'monthly-table.xlsx'), 'synthetic-xlsx-placeholder');
  fs.writeFileSync(path.join(dataDir, 'uploads', 'proof.txt'), 'original-upload');
  fs.writeFileSync(path.join(dataDir, 'exports', 'proof.json'), '{"original":true}');
  const fullBackupDir = path.join(OUT, 'full-backups');
  const backupOutput = run(BACKUP, ['backup'], { DATA_DIR: dataDir, BACKUP_DIR: fullBackupDir, NODE_ENV: 'test' });
  const archive = backupOutput.match(/Backup created: (.+\.tar\.gz)/)[1].trim();
  const entries = []; await tar.list({ file: archive, onentry: entry => entries.push(String(entry.path)) });
  check('النسخة الكاملة تشمل القاعدة والملفات والمجلدات', ['ambulance.db', 'users.json', 'monthly-table.xlsx', 'uploads/proof.txt', 'exports/proof.json'].every(name => entries.includes(name)));
  check('الأرشيف يستبعد WAL/SHM ويحتوي لقطة متسقة', !entries.some(name => /ambulance\.db-(wal|shm)$/.test(name)) && entries.includes('ambulance.db'));
  const inspectDir = path.join(OUT, 'archive-inspect'); fs.mkdirSync(inspectDir); await tar.extract({ file: archive, cwd: inspectDir });
  db = new Database(path.join(inspectDir, 'ambulance.db'), { readonly: true }); const archivedRoster = shaRows(db, 'shift_roster'); db.close();
  check('قاعدة الأرشيف سليمة ومطابقة للمصدر', quick(path.join(inspectDir, 'ambulance.db')) && archivedRoster === baselineHashes.shift_roster);

  fs.writeFileSync(path.join(dataDir, 'users.json'), 'mutated');
  fs.writeFileSync(path.join(dataDir, 'uploads', 'proof.txt'), 'mutated');
  db = new Database(liveDb); db.prepare('DELETE FROM shift_roster').run(); db.close();
  fs.writeFileSync(liveDb + '-wal', ''); fs.writeFileSync(liveDb + '-shm', '');
  run(BACKUP, ['restore', archive], { DATA_DIR: dataDir, BACKUP_DIR: fullBackupDir, NODE_ENV: 'test' });
  check('الاستعادة أزالت WAL/SHM القديمين قبل فتح اللقطة', !fs.existsSync(liveDb + '-wal') && !fs.existsSync(liveDb + '-shm'));
  db = new Database(liveDb, { readonly: true }); const restoredRoster = shaRows(db, 'shift_roster'); db.close();
  check('الاستعادة أعادت القاعدة والملفات والمجلدات', restoredRoster === baselineHashes.shift_roster && fs.readFileSync(path.join(dataDir, 'users.json'), 'utf8').includes('synthetic') && fs.readFileSync(path.join(dataDir, 'uploads', 'proof.txt'), 'utf8') === 'original-upload' && fs.existsSync(path.join(dataDir, 'exports', 'proof.json')) && quick(liveDb));

  const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
  check('Render: Node 22 وnpm start وhealth والتخزين الدائم', /NODE_VERSION[\s\S]*?22\.14\.0/.test(render) && /startCommand: npm start/.test(render) && /healthCheckPath: \/health/.test(render) && /DB_PATH[\s\S]*?\/data\/ambulance\.db/.test(render) && /SCHEDULE_FILE[\s\S]*?\/data\/schedule-employees\.json/.test(render));
  check('Render: JWT سري والنشر اليدوي ولا cron/preDeploy غير صالح', /JWT_SECRET\s*\n\s*sync: false/.test(render) && /autoDeployTrigger: ['"]?off['"]?/.test(render) && !/^cronJobs:/m.test(render) && !/preDeployCommand:/.test(render));

  const summary = { passed: checks.length, failed: 0, checks, output: OUT, migrationBackup: applied.backup.path, fullBackup: archive, rollbackDatabase: rollbackDb, scope: 'synthetic isolated only; no production deployment or account/coverage changes', finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nالنتيجة: ${summary.passed} ✅ / 0 ❌\nالأدلة: ${OUT}`);
})().catch(async error => {
  console.error('❌ ' + error.stack);
  const summary = { passed: checks.filter(row => row.ok).length, failed: 1, checks, error: error.message, output: OUT, finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); process.exitCode = 1;
}).finally(async () => { await stopServer(); });
