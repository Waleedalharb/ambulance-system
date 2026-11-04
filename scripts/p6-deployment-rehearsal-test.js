#!/usr/bin/env node
/** Isolated P6 deployment rehearsal: cold schema, additive migration, backup,
 * idempotency, verification, rollback and protected-data fingerprints. */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test-output', 'p6-predeploy-' + Date.now());
const DB = path.join(OUT, 'ambulance.db');
const DATA = path.join(OUT, 'data');
const MIGRATE = path.join(ROOT, 'scripts', 'migrate-schedule-p6.js');
const TABLES = ['schedule_import_batches', 'schedule_import_reviews', 'schedule_import_templates'];
const INDEXES = ['idx_schedule_import_batches_month', 'idx_schedule_import_reviews_batch'];
const TRIGGERS = ['schedule_import_batches_source_immutable', 'schedule_import_batches_no_delete', 'schedule_import_reviews_immutable_update', 'schedule_import_reviews_immutable_delete', 'schedule_import_templates_immutable_update', 'schedule_import_templates_immutable_delete'];
const PROTECTED = ['shift_roster', 'schedule_months', 'employees', 'users', 'user_permissions', 'teams', 'leave_requests'];
const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail: detail || null });
  console.log(`  ${condition ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!condition) throw new Error(name);
}
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, NODE_ENV: 'test', DB_PATH: DB, DATA_DIR: DATA }, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `فشل ${args[0]}`);
  return result.stdout;
}
function migrate(args) { return JSON.parse(run([MIGRATE, ...args])); }
function objects(db, type) { return new Set(db.prepare('SELECT name FROM sqlite_master WHERE type=?').all(type).map(row => row.name)); }
function hashes(db) {
  return Object.fromEntries(PROTECTED.map(table => [table, crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())).digest('hex')]));
}
function quick(db) { return db.pragma('quick_check', { simple: true }) === 'ok' && db.pragma('foreign_key_check').length === 0; }
function finish(failed, error) {
  const summary = { passed: checks.filter(row => row.ok).length, failed, checks, error: error || null, output: OUT, scope: 'synthetic isolated only; no production deployment', finishedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`\nالنتيجة: ${summary.passed} ✅ / ${failed} ❌\nالأدلة: ${OUT}`);
}
try {
  fs.mkdirSync(DATA, { recursive: true });
  console.log('🧊 بروفة P6 معزولة: ' + OUT);
  run(['-e', "require('./db').init(false).then(()=>require('./db').closeDb()).catch(e=>{console.error(e);process.exit(1)})"]);
  let db = new Database(DB);
  check('الإقلاع البارد ينشئ مخطط P6 المطابق للترحيل', TABLES.every(name => objects(db, 'table').has(name)) && INDEXES.every(name => objects(db, 'index').has(name)) && TRIGGERS.every(name => objects(db, 'trigger').has(name)) && quick(db));
  const coldVerified = migrate(['--db', DB, '--verify']);
  check('تحقق الترحيل يطابق مخطط db.js', coldVerified.status === 'verified');
  db.pragma('foreign_keys = OFF');
  for (const name of TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS "${name}"`);
  for (const name of INDEXES) db.exec(`DROP INDEX IF EXISTS "${name}"`);
  for (const name of [...TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.pragma('foreign_keys = ON');
  const baseline = hashes(db); db.close();
  db = new Database(DB, { readonly: true });
  check('قاعدة ما قبل P6 سليمة وجاهزة', TABLES.every(name => !objects(db, 'table').has(name)) && quick(db));
  db.close();

  const backupDir = path.join(OUT, 'backups');
  const dry = migrate(['--db', DB]);
  check('dry-run يكشف 3 جداول وفهرسين و6 Triggers بلا كتابة', dry.status === 'ready_to_apply' && dry.before.missing.table.length === 3 && dry.before.missing.index.length === 2 && dry.before.missing.trigger.length === 6);
  const applied = migrate(['--db', DB, '--backup-dir', backupDir, '--apply']);
  check('الترحيل الإضافي طُبق مع نسخة متسقة', applied.status === 'applied' && applied.backup.bytes > 0 && fs.existsSync(applied.backup.path));
  check('الترحيل لم يغيّر البيانات الرسمية أو الحسابات', JSON.stringify(applied.protectedBefore) === JSON.stringify(applied.protectedAfter) && JSON.stringify(applied.protectedAfter) === JSON.stringify(baseline));
  check('لا دفعات أو مراجعات أو قوالب بعد الترحيل', Object.values(applied.importCountsAfter).every(value => value === 0));
  const verified = migrate(['--db', DB, '--verify']);
  db = new Database(DB, { readonly: true });
  check('التحقق اللاحق وسلامة SQLite ناجحان', verified.status === 'verified' && quick(db));
  db.close();
  const repeated = migrate(['--db', DB, '--backup-dir', backupDir, '--apply']);
  check('إعادة الترحيل idempotent بلا نسخة جديدة', repeated.status === 'already_applied' && !repeated.backup);
  db = new Database(applied.backup.path, { readonly: true });
  check('نسخة التراجع تعيد مخطط ما قبل P6 وتحفظ البيانات', TABLES.every(name => !objects(db, 'table').has(name)) && JSON.stringify(hashes(db)) === JSON.stringify(baseline) && quick(db));
  db.close();
  finish(0, null);
} catch (error) {
  console.error('❌ ' + error.stack); finish(1, error.message); process.exitCode = 1;
}
