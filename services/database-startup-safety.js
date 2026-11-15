'use strict';

/**
 * حارس إقلاع SQLite: لقطة متسقة ومتحقق منها قبل أي CREATE/ALTER/DROP أو ترحيل.
 * لا يقرأ أو يحذف نسخ المستخدم، ولا يسمح في الإنتاج بإنشاء قاعدة فارغة بصمت.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

class DatabaseStartupSafetyError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'DatabaseStartupSafetyError';
    this.code = 'DB_STARTUP_SAFETY_FAILED';
    if (cause) this.cause = cause;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fileSha256(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function tableNames(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
}

function inspectOpenDatabase(db) {
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error('SQLite integrity_check failed: ' + integrity);
  const tables = {};
  for (const table of tableNames(db)) {
    const quoted = '"' + table.replace(/"/g, '""') + '"';
    let rows;
    try {
      rows = db.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all();
    } catch (error) {
      if (!/no such column: rowid/i.test(error.message)) throw error;
      rows = db.prepare(`SELECT * FROM ${quoted}`).all();
    }
    tables[table] = { count: rows.length, sha256: sha256(JSON.stringify(rows)) };
  }
  return { integrity, tables, contentFingerprint: sha256(JSON.stringify(tables)) };
}

function inspectDatabase(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return inspectOpenDatabase(db);
  } finally {
    db.close();
  }
}

function assertDirectoryWritable(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const probe = path.join(directory, `.write-probe-${process.pid}-${Date.now()}`);
  const fd = fs.openSync(probe, 'wx');
  fs.closeSync(fd);
  fs.unlinkSync(probe);
}

function sameContent(left, right) {
  return left && right && left.contentFingerprint === right.contentFingerprint;
}

function tryReuseLatestSnapshot(backupDirectory, currentInspection) {
  const manifests = fs.readdirSync(backupDirectory)
    .filter(name => /^pre-migration-.+\.json$/.test(name))
    .sort()
    .reverse();
  if (!manifests.length) return null;
  const manifestPath = path.join(backupDirectory, manifests[0]);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.database || manifest.database.contentFingerprint !== currentInspection.contentFingerprint) return null;
    const snapshotPath = path.join(backupDirectory, path.basename(manifest.snapshot.path));
    if (!fs.existsSync(snapshotPath) || fs.statSync(snapshotPath).size === 0) return null;
    if (fileSha256(snapshotPath) !== manifest.snapshot.sha256) return null;
    const snapshotInspection = inspectDatabase(snapshotPath);
    if (!sameContent(snapshotInspection, currentInspection)) return null;
    return { status: 'reused', snapshotPath, manifestPath, database: currentInspection };
  } catch (_) {
    return null;
  }
}

async function protectDatabaseStartup(options = {}) {
  const env = options.env || process.env;
  const production = options.production !== undefined ? !!options.production : env.NODE_ENV === 'production';
  const storagePath = path.resolve(options.storagePath || env.RENDER_DISK_PATH || env.DATA_DIR || path.join(__dirname, '..', 'data'));
  const dbPath = path.resolve(options.dbPath || env.DB_PATH || path.join(storagePath, 'ambulance.db'));
  const backupRoot = path.resolve(options.backupDir || env.BACKUP_DIR || path.join(storagePath, 'backups'));
  const backupDirectory = path.join(backupRoot, 'pre-deploy');
  const allowEmpty = options.allowEmpty !== undefined ? !!options.allowEmpty : env.ALLOW_EMPTY_DATABASE === 'true';

  try {
    if (production && !(options.storagePath || env.RENDER_DISK_PATH || env.DATA_DIR)) {
      throw new Error('Persistent storage is not configured (RENDER_DISK_PATH/DATA_DIR)');
    }
    if (production && !path.isAbsolute(storagePath)) {
      throw new Error('Persistent storage path must be absolute: ' + storagePath);
    }
    if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) {
      if (production && !allowEmpty) {
        throw new Error('Database is missing/empty; refusing to create a fresh production database. Restore /data/ambulance.db or set ALLOW_EMPTY_DATABASE=true only for a verified new installation: ' + dbPath);
      }
      return { status: 'empty-database-allowed', dbPath, snapshotPath: null };
    }

    assertDirectoryWritable(backupDirectory);
    const currentInspection = inspectDatabase(dbPath);
    const reusable = tryReuseLatestSnapshot(backupDirectory, currentInspection);
    if (reusable) return reusable;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = `pre-migration-${stamp}-${process.pid}`;
    const snapshotPath = path.join(backupDirectory, baseName + '.db');
    const partialPath = snapshotPath + '.partial';
    const manifestPath = path.join(backupDirectory, baseName + '.json');
    const partialManifestPath = manifestPath + '.partial';
    let source;
    try {
      source = new Database(dbPath, { readonly: true, fileMustExist: true });
      source.exec(`VACUUM INTO '${partialPath.replace(/'/g, "''")}'`);
      source.close();
      source = null;
      const snapshotInspection = inspectDatabase(partialPath);
      if (!sameContent(snapshotInspection, currentInspection)) {
        throw new Error('Snapshot table fingerprints do not match the source database');
      }
      fs.renameSync(partialPath, snapshotPath);
      const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        source: { path: dbPath, bytes: fs.statSync(dbPath).size },
        snapshot: { path: snapshotPath, bytes: fs.statSync(snapshotPath).size, sha256: fileSha256(snapshotPath) },
        database: currentInspection
      };
      fs.writeFileSync(partialManifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      fs.renameSync(partialManifestPath, manifestPath);
      return { status: 'created', snapshotPath, manifestPath, database: currentInspection };
    } catch (error) {
      if (source) source.close();
      for (const generated of [partialPath, partialManifestPath]) {
        try { fs.unlinkSync(generated); } catch (_) {}
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof DatabaseStartupSafetyError) throw error;
    throw new DatabaseStartupSafetyError('Database startup safety failed: ' + error.message, error);
  }
}

module.exports = {
  DatabaseStartupSafetyError,
  protectDatabaseStartup,
  inspectDatabase
};
