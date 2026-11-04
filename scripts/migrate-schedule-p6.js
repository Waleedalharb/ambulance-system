#!/usr/bin/env node
/** P6 additive migration: dry-run, consistent backup, verification, idempotency.
 * It never seeds coverage/accounts and never writes official roster/month data.
 * Check:  node scripts/migrate-schedule-p6.js --db /path/ambulance.db
 * Apply:  node scripts/migrate-schedule-p6.js --db /path/ambulance.db --backup-dir /path/backups --apply
 * Verify: node scripts/migrate-schedule-p6.js --db /path/ambulance.db --verify
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const SQL_PATH = path.join(ROOT, 'deploy', 'migrations', '2026-11-05-schedule-p6.sql');
const TABLES = ['schedule_import_batches', 'schedule_import_reviews', 'schedule_import_templates'];
const INDEXES = ['idx_schedule_import_batches_month', 'idx_schedule_import_reviews_batch'];
const TRIGGERS = [
  'schedule_import_batches_source_immutable', 'schedule_import_batches_no_delete',
  'schedule_import_reviews_immutable_update', 'schedule_import_reviews_immutable_delete',
  'schedule_import_templates_immutable_update', 'schedule_import_templates_immutable_delete'
];
const PROTECTED = ['shift_roster', 'schedule_months', 'employees', 'users', 'user_permissions', 'teams', 'leave_requests'];
const DEPENDENCIES = ['schedule_versions'];
const EXPECTED = { table: TABLES, index: INDEXES, trigger: TRIGGERS };

function args() {
  const out = { apply: false, verify: false };
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--apply' || arg === '--verify') out[arg.slice(2)] = true;
    else if (['--db', '--backup-dir', '--manifest'].includes(arg)) out[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = process.argv[++i];
    else throw new Error('معامل غير معروف: ' + arg);
  }
  if (!out.db) throw new Error('--db إلزامي؛ لا يوجد مسار افتراضي لمنع لمس قاعدة غير مقصودة');
  if (out.apply && !out.backupDir) throw new Error('--backup-dir إلزامي مع --apply');
  if (out.apply && out.verify) throw new Error('استخدم --apply أو --verify، لا كليهما');
  return out;
}
function sha(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function fileSha(file) { return sha(fs.readFileSync(file)); }
function canonical(sql) { return String(sql || '').replace(/\s+/g, ' ').replace(/ IF NOT EXISTS/gi, '').trim().replace(/;$/, ''); }
function tableExists(db, name) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name); }
function safePath(input) {
  const resolved = path.resolve(input);
  if (resolved.split(path.sep).includes('public')) throw new Error('يمنع وضع قاعدة البيانات أو النسخ داخل public');
  return resolved;
}
function objectMap(db, type) {
  return new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'").all(type).map(row => [row.name, canonical(row.sql)]));
}
function schemaState(db) { return { table: objectMap(db, 'table'), index: objectMap(db, 'index'), trigger: objectMap(db, 'trigger') }; }
function missingOrDifferent(state, expectedState, allowMissing) {
  const missing = {}, different = {};
  for (const type of Object.keys(EXPECTED)) {
    missing[type] = EXPECTED[type].filter(name => !state[type].has(name));
    different[type] = EXPECTED[type].filter(name => state[type].has(name) && state[type].get(name) !== expectedState[type].get(name));
    if (!allowMissing) {
      const extra = [...missing[type], ...different[type]];
      if (extra.length) throw new Error(`مخطط ${type} غير مكتمل أو مختلف: ${extra.join(', ')}`);
    }
  }
  return { missing, different };
}
function protectedHashes(db) {
  return Object.fromEntries(PROTECTED.map(table => [table, tableExists(db, table) ? sha(JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())) : null]));
}
function importCounts(db) {
  return Object.fromEntries(TABLES.map(table => [table, tableExists(db, table) ? db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n : null]));
}
function assertDependencies(db) {
  const absent = DEPENDENCIES.filter(table => !tableExists(db, table));
  if (absent.length) throw new Error('جداول الاعتماد مفقودة؛ طبّق P1–P3 أولًا: ' + absent.join(', '));
}
function checkDatabase(db) {
  const quick = db.pragma('quick_check', { simple: true });
  if (quick !== 'ok') throw new Error('quick_check فشل: ' + quick);
  const foreign = db.pragma('foreign_key_check');
  if (foreign.length) throw new Error('foreign_key_check فشل: ' + JSON.stringify(foreign.slice(0, 5)));
}
function expectedSchema(sql) {
  const memory = new Database(':memory:');
  memory.exec('CREATE TABLE schedule_versions(id TEXT PRIMARY KEY);');
  memory.exec(sql);
  const state = schemaState(memory); memory.close(); return state;
}
function backup(db, sourcePath, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `pre-schedule-p6-${stamp}.db`);
  if (fs.existsSync(target)) throw new Error('مسار النسخة موجود مسبقًا: ' + target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const copy = new Database(target, { readonly: true, fileMustExist: true });
  checkDatabase(copy); const hashes = protectedHashes(copy); copy.close();
  return { path: target, sha256: fileSha(target), bytes: fs.statSync(target).size, protectedHashes: hashes, sourceSha256BeforeBackup: fileSha(sourcePath) };
}
function writeManifest(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n'); }

(async () => {
  const options = args();
  const dbPath = safePath(options.db), backupDir = options.backupDir ? safePath(options.backupDir) : null;
  const sql = fs.readFileSync(SQL_PATH, 'utf8'), expected = expectedSchema(sql);
  if (!fs.existsSync(dbPath)) throw new Error('قاعدة البيانات غير موجودة: ' + dbPath);
  const db = new Database(dbPath, { readonly: !options.apply, fileMustExist: true });
  let backupInfo = null;
  const result = {
    migration: path.basename(SQL_PATH), migrationSha256: sha(sql), mode: options.apply ? 'apply' : options.verify ? 'verify' : 'check',
    database: dbPath, startedAt: new Date().toISOString(), expected: { tables: TABLES.length, indexes: INDEXES.length, triggers: TRIGGERS.length }
  };
  try {
    assertDependencies(db); checkDatabase(db);
    const before = schemaState(db), diff = missingOrDifferent(before, expected, true);
    result.before = diff;
    if (Object.values(diff.different).some(rows => rows.length)) throw new Error('توجد كائنات P6 قائمة بمخطط مختلف؛ أوقف الترحيل وراجعها يدويًا');
    result.protectedBefore = protectedHashes(db); result.importCountsBefore = importCounts(db);
    const complete = Object.values(diff.missing).every(rows => rows.length === 0);
    if (options.verify) {
      missingOrDifferent(before, expected, false); result.status = 'verified';
    } else if (options.apply && !complete) {
      backupInfo = backup(db, dbPath, backupDir); result.backup = backupInfo;
      db.exec('BEGIN IMMEDIATE');
      try { db.exec(sql); db.exec('COMMIT'); }
      catch (error) { try { db.exec('ROLLBACK'); } catch (_) {} throw error; }
      const after = schemaState(db); missingOrDifferent(after, expected, false); checkDatabase(db);
      result.protectedAfter = protectedHashes(db); result.importCountsAfter = importCounts(db);
      if (JSON.stringify(result.protectedBefore) !== JSON.stringify(result.protectedAfter)) throw new Error('تغيرت بيانات محمية أثناء الترحيل');
      for (const table of TABLES) {
        const expectedCount = result.importCountsBefore[table] === null ? 0 : result.importCountsBefore[table];
        if (result.importCountsAfter[table] !== expectedCount) throw new Error('تغيرت بيانات الاستيراد أثناء الترحيل: ' + table);
      }
      result.status = 'applied';
    } else {
      result.status = complete ? 'already_applied' : 'ready_to_apply';
      result.protectedAfter = result.protectedBefore; result.importCountsAfter = result.importCountsBefore;
    }
    result.finishedAt = new Date().toISOString();
    const manifest = options.manifest ? safePath(options.manifest) : backupInfo ? path.join(backupDir, path.basename(backupInfo.path, '.db') + '-manifest.json') : null;
    if (manifest) { writeManifest(manifest, result); result.manifest = manifest; }
    console.log(JSON.stringify(result, null, 2));
  } finally { db.close(); }
})().catch(error => { console.error('❌ ' + error.message); process.exit(1); });
