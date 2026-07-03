const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

/**
 * ═══════════════════════════════════════════════════════════════
 * Team 2: JSON-to-SQLite Migration Script
 * EMS Platform (منصة الجنوب) — Critical Infrastructure Upgrade
 * Tables: reports, shifts, users, announcements, ops_files,
 *         hospitals, references_table, timeline
 * ═══════════════════════════════════════════════════════════════
 *
 * CRITICAL RULES ENFORCED:
 *   1. JSON files are NEVER modified — only read for migration
 *   2. All DB operations are async (Promise-wrapped)
 *   3. Proper error handling and logging throughout
 *   4. Existing file structure preserved — server.js untouched
 *   5. CREATE TABLE uses IF NOT EXISTS to be idempotent
 *
 * Usage:
 *   node db/migrate-team2.js
 *
 * Or programmatically:
 *   const { migrateAll } = require('./db/migrate-team2');
 *   await migrateAll();
 */

// ─────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(__dirname, '..', 'database.db');
const OPS_UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads', 'operational');

// ─────────────────────────────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────────────────────────────

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// DATABASE CONNECTION (Promise-wrapped sqlite3)
// ─────────────────────────────────────────────────────────────────

let db = null;

function openDb(dbPath) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(dbPath);
    db = new sqlite3.Database(resolvedPath, (err) => {
      if (err) {
        return reject(new Error(`فشل فتح قاعدة البيانات: ${err.message}`));
      }
      // Enable WAL for better concurrency and safety
      db.run('PRAGMA journal_mode = WAL;', (walErr) => {
        if (walErr) {
          return reject(new Error(`فشل تفعيل وضع WAL: ${walErr.message}`));
        }
        resolve(db);
      });
    });
  });
}

function closeDb() {
  return new Promise((resolve, reject) => {
    if (!db) return resolve();
    db.close((err) => {
      if (err) return reject(new Error(`فشل إغلاق قاعدة البيانات: ${err.message}`));
      db = null;
      resolve();
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('قاعدة البيانات غير مفتوحة'));
    db.run(sql, params, function(err) {
      if (err) return reject(new Error(`خطأ في تنفيذ الاستعلام: ${err.message} | SQL: ${sql} | Params: ${JSON.stringify(params)}`));
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('قاعدة البيانات غير مفتوحة'));
    db.get(sql, params, (err, row) => {
      if (err) return reject(new Error(`خطأ في جلب البيانات: ${err.message}`));
      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) return reject(new Error('قاعدة البيانات غير مفتوحة'));
    db.all(sql, params, (err, rows) => {
      if (err) return reject(new Error(`خطأ في جلب البيانات: ${err.message}`));
      resolve(rows || []);
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// CREATE TABLE STATEMENTS (idempotent — IF NOT EXISTS)
// ─────────────────────────────────────────────────────────────────

const TABLE_SCHEMAS = [
  // ── reports ──────────────────────────────────────────────
  // Source: ambulance-data.json
  // Key: center|unit, Value: {count, times[]}
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    center TEXT NOT NULL,
    unit TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // ── report_times ─────────────────────────────────────────
  // Normalized times array from ambulance-data.json
  `CREATE TABLE IF NOT EXISTS report_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    timestamp TEXT NOT NULL
  );`,

  // ── shifts ───────────────────────────────────────────────
  // Source: shift-data.json
  `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_name TEXT NOT NULL,
    shift_date TEXT,
    shift_time TEXT,
    shift_type TEXT,
    shift_day TEXT,
    start_time TEXT,
    total_reports INTEGER DEFAULT 0,
    rapid_locations TEXT,
    centers_data TEXT,
    vehicle_data TEXT,
    fuel_data TEXT,
    general_notes TEXT,
    last_update TEXT
  );`,

  // ── shift_reports ────────────────────────────────────────
  // Normalized savedReports from shift-data.json
  `CREATE TABLE IF NOT EXISTS shift_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    center TEXT,
    unit TEXT,
    count INTEGER DEFAULT 0,
    times TEXT
  );`,

  // ── users ────────────────────────────────────────────────
  // Source: users.json
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    role TEXT CHECK(role IN ('admin', 'director', 'user', 'supervisor')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT,
    last_login TEXT
  );`,

  // ── announcements ──────────────────────────────────────────
  // Source: announcements.json (may not exist yet — created for future)
  `CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT,
    date TEXT,
    pinned INTEGER DEFAULT 0,
    urgent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // ── ops_files ──────────────────────────────────────────────
  // Source: ops-uploads/metadata.json (operational uploads)
  `CREATE TABLE IF NOT EXISTS ops_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT UNIQUE,
    filename TEXT NOT NULL,
    stored_name TEXT,
    size INTEGER DEFAULT 0,
    mime_type TEXT,
    upload_date TEXT,
    uploader TEXT,
    category TEXT,
    note TEXT,
    icon TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // ── hospitals ──────────────────────────────────────────────
  // Source: hospitals.json
  `CREATE TABLE IF NOT EXISTS hospitals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT,
    specialty TEXT,
    address TEXT,
    phone TEXT,
    emergency TEXT,
    hours TEXT,
    lat REAL,
    lng REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // ── references_table ───────────────────────────────────────
  // Source: references.json (named references_table to avoid SQL keyword conflict)
  `CREATE TABLE IF NOT EXISTS references_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_id TEXT UNIQUE,
    title TEXT NOT NULL,
    type TEXT,
    dept TEXT,
    status TEXT,
    description TEXT,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // ── timeline ─────────────────────────────────────────────────
  // Source: timeline.json
  `CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT,
    date TEXT,
    time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`
];

// ── Indexes for performance ────────────────────────────────────
const INDEX_SCHEMAS = [
  `CREATE INDEX IF NOT EXISTS idx_reports_center ON reports(center);`,
  `CREATE INDEX IF NOT EXISTS idx_reports_unit ON reports(unit);`,
  `CREATE INDEX IF NOT EXISTS idx_report_times_report_id ON report_times(report_id);`,
  `CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(shift_date);`,
  `CREATE INDEX IF NOT EXISTS idx_shifts_type ON shifts(shift_type);`,
  `CREATE INDEX IF NOT EXISTS idx_shift_reports_shift_id ON shift_reports(shift_id);`,
  `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`,
  `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);`,
  `CREATE INDEX IF NOT EXISTS idx_announcements_pinned ON announcements(pinned);`,
  `CREATE INDEX IF NOT EXISTS idx_announcements_date ON announcements(date);`,
  `CREATE INDEX IF NOT EXISTS idx_ops_files_category ON ops_files(category);`,
  `CREATE INDEX IF NOT EXISTS idx_hospitals_name ON hospitals(name);`,
  `CREATE INDEX IF NOT EXISTS idx_references_status ON references_table(status);`,
  `CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline(date);`
];

async function initTables() {
  log('info', 'جارٍ إنشاء/التحقق من الجداول...');
  for (const schema of TABLE_SCHEMAS) {
    await dbRun(schema);
  }
  for (const idx of INDEX_SCHEMAS) {
    await dbRun(idx);
  }
  log('info', '✅ تم إنشاء/التحقق من جميع الجداول والفهارس');
}

// ─────────────────────────────────────────────────────────────────
// JSON FILE READER (read-only, never modifies source)
// ─────────────────────────────────────────────────────────────────

function readJsonFile(filepath) {
  if (!fs.existsSync(filepath)) {
    log('warn', `ملف غير موجود: ${filepath} — سيتم تخطي الترحيل`);
    return null;
  }
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    if (!raw || raw.trim() === '') {
      log('warn', `ملف فارغ: ${filepath}`);
      return null;
    }
    return JSON.parse(raw);
  } catch (err) {
    log('error', `خطأ في قراءة ${filepath}: ${err.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: reports (ambulance-data.json)
// ─────────────────────────────────────────────────────────────────

async function migrateReports() {
  const filepath = path.join(DATA_DIR, 'ambulance-data.json');
  const data = readJsonFile(filepath);
  if (!data || typeof data !== 'object') {
    log('warn', 'لا توجد بيانات بلاغات للترحيل');
    return { reports: 0, times: 0 };
  }

  let reportCount = 0;
  let timeCount = 0;

  for (const key of Object.keys(data)) {
    const [center, unit] = key.split('|');
    const item = data[key];

    if (!center || !unit) {
      log('warn', `مفتاح غير صالح: ${key} — تم تخطيه`);
      continue;
    }

    const result = await dbRun(
      `INSERT INTO reports (center, unit, count) VALUES (?, ?, ?)`,
      [center.trim(), unit.trim(), item.count || 0]
    );
    const reportId = result.lastID;
    reportCount++;

    if (Array.isArray(item.times)) {
      for (const t of item.times) {
        await dbRun(
          `INSERT INTO report_times (report_id, timestamp) VALUES (?, ?)`,
          [reportId, t]
        );
        timeCount++;
      }
    }
  }

  log('info', `✅ تم ترحيل ${reportCount} بلاغ مع ${timeCount} توقيت`);
  return { reports: reportCount, times: timeCount };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: shifts (shift-data.json)
// ─────────────────────────────────────────────────────────────────

async function migrateShifts() {
  const filepath = path.join(DATA_DIR, 'shift-data.json');
  const data = readJsonFile(filepath);
  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات مناوبات للترحيل');
    return { shifts: 0, shiftReports: 0 };
  }

  let shiftCount = 0;
  let shiftReportCount = 0;

  for (const shift of data) {
    const result = await dbRun(
      `INSERT INTO shifts (
        shift_name, shift_date, shift_time, shift_type, shift_day,
        start_time, total_reports, rapid_locations, centers_data,
        vehicle_data, fuel_data, general_notes, last_update
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shift.shiftName || '',
        shift.shiftDate || '',
        shift.shiftTime || '',
        shift.shiftType || '',
        shift.shiftDay || '',
        shift.startTime || '',
        shift.totalReports || 0,
        JSON.stringify(shift.rapidLocations || {}),
        JSON.stringify(shift.centersData || {}),
        JSON.stringify(shift.vehicleData || {}),
        JSON.stringify(shift.fuelData || {}),
        shift.generalNotes || '',
        shift.lastUpdate || shift.startTime || new Date().toISOString()
      ]
    );
    const shiftId = result.lastID;
    shiftCount++;

    // Migrate savedReports (same structure as ambulance-data.json)
    if (shift.savedReports && typeof shift.savedReports === 'object') {
      for (const key of Object.keys(shift.savedReports)) {
        const [center, unit] = key.split('|');
        const r = shift.savedReports[key];
        if (!center || !unit) continue;

        await dbRun(
          `INSERT INTO shift_reports (shift_id, center, unit, count, times) VALUES (?, ?, ?, ?, ?)`,
          [shiftId, center.trim(), unit.trim(), r.count || 0, JSON.stringify(r.times || [])]
        );
        shiftReportCount++;
      }
    }
  }

  log('info', `✅ تم ترحيل ${shiftCount} مناوبة مع ${shiftReportCount} بلاغ محفوظ`);
  return { shifts: shiftCount, shiftReports: shiftReportCount };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: users (users.json)
// ─────────────────────────────────────────────────────────────────

async function migrateUsers() {
  const filepath = path.join(DATA_DIR, 'users.json');
  const data = readJsonFile(filepath);
  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات مستخدمين للترحيل');
    return { users: 0 };
  }

  let count = 0;
  for (const u of data) {
    await dbRun(
      `INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        u.id || null,
        u.username || '',
        u.password || '',
        u.name || '',
        u.role || 'user',
        u.isActive ? 1 : 0,
        u.createdAt || new Date().toISOString(),
        u.lastLogin || null
      ]
    );
    count++;
  }

  log('info', `✅ تم ترحيل ${count} مستخدم`);
  return { users: count };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: announcements (announcements.json)
// ─────────────────────────────────────────────────────────────────

async function migrateAnnouncements() {
  const filepath = path.join(DATA_DIR, 'announcements.json');
  const data = readJsonFile(filepath);
  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات إعلانات للترحيل (ملف غير موجود أو فارغ)');
    return { announcements: 0 };
  }

  let count = 0;
  for (const a of data) {
    await dbRun(
      `INSERT INTO announcements (title, body, date, pinned, urgent) VALUES (?, ?, ?, ?, ?)`,
      [
        a.title || '',
        a.body || '',
        a.date || '',
        a.pinned ? 1 : 0,
        a.urgent ? 1 : 0
      ]
    );
    count++;
  }

  log('info', `✅ تم ترحيل ${count} إعلان`);
  return { announcements: count };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: ops_files (ops-uploads/metadata.json)
// ─────────────────────────────────────────────────────────────────

async function migrateOpsFiles() {
  // Try multiple possible locations for backward compatibility
  const possiblePaths = [
    path.join(DATA_DIR, 'uploads', 'operational', 'metadata.json'),
    path.join(OPS_UPLOADS_DIR, 'metadata.json'),
    path.join(__dirname, '..', 'public', 'uploads', 'operational', 'metadata.json'),
    path.join(__dirname, '..', 'ambulance-dispatch', 'data', 'ops-uploads', 'metadata.json')
  ];

  let data = null;
  let usedPath = null;
  for (const p of possiblePaths) {
    data = readJsonFile(p);
    if (data) {
      usedPath = p;
      break;
    }
  }

  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات ملفات تشغيلية للترحيل');
    return { opsFiles: 0 };
  }

  let count = 0;
  for (const f of data) {
    await dbRun(
      `INSERT INTO ops_files (file_id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        f.id || null,
        f.filename || '',
        f.storedName || '',
        f.size || 0,
        f.mimeType || '',
        f.uploadDate || '',
        f.uploader || '',
        f.category || 'general',
        f.note || '',
        f.icon || ''
      ]
    );
    count++;
  }

  log('info', `✅ تم ترحيل ${count} ملف تشغيلي (المصدر: ${usedPath})`);
  return { opsFiles: count };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: hospitals (hospitals.json)
// ─────────────────────────────────────────────────────────────────

async function migrateHospitals() {
  const filepath = path.join(DATA_DIR, 'hospitals.json');
  const data = readJsonFile(filepath);
  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات مستشفيات للترحيل (ملف غير موجود أو فارغ)');
    return { hospitals: 0 };
  }

  let count = 0;
  for (const h of data) {
    await dbRun(
      `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        h.name || '',
        h.type || '',
        h.specialty || '',
        h.address || '',
        h.phone || '',
        h.emergency || '',
        h.hours || '',
        h.lat ? parseFloat(h.lat) : null,
        h.lng ? parseFloat(h.lng) : null
      ]
    );
    count++;
  }

  log('info', `✅ تم ترحيل ${count} مستشفى`);
  return { hospitals: count };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: references (references.json)
// ─────────────────────────────────────────────────────────────────

async function migrateReferences() {
  const filepath = path.join(DATA_DIR, 'references.json');
  const data = readJsonFile(filepath);
  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات مراجع للترحيل (ملف غير موجود أو فارغ)');
    return { references: 0 };
  }

  let count = 0;
  for (const r of data) {
    await dbRun(
      `INSERT INTO references_table (ref_id, title, type, dept, status, description, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id || null,
        r.title || '',
        r.type || '',
        r.dept || '',
        r.status || '',
        r.desc || r.description || '',
        r.date || ''
      ]
    );
    count++;
  }

  log('info', `✅ تم ترحيل ${count} مرجع`);
  return { references: count };
}

// ─────────────────────────────────────────────────────────────────
// MIGRATION: timeline (timeline.json)
// ─────────────────────────────────────────────────────────────────

async function migrateTimeline() {
  const filepath = path.join(DATA_DIR, 'timeline.json');
  const data = readJsonFile(filepath);
  if (!data || !Array.isArray(data)) {
    log('warn', 'لا توجد بيانات خط زمني للترحيل (ملف غير موجود أو فارغ)');
    return { timeline: 0 };
  }

  let count = 0;
  for (const t of data) {
    await dbRun(
      `INSERT INTO timeline (event_id, title, description, type, date, time)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        t.id || null,
        t.title || '',
        t.desc || t.description || '',
        t.type || '',
        t.date || '',
        t.time || ''
      ]
    );
    count++;
  }

  log('info', `✅ تم ترحيل ${count} حدث زمني`);
  return { timeline: count };
}

// ─────────────────────────────────────────────────────────────────
// MAIN MIGRATION ORCHESTRATOR
// ─────────────────────────────────────────────────────────────────

async function migrateAll() {
  const summary = {
    reports: 0, times: 0, shifts: 0, shiftReports: 0,
    users: 0, announcements: 0, opsFiles: 0,
    hospitals: 0, references: 0, timeline: 0
  };

  log('info', '🚀 بدء ترحيل Team 2: JSON → SQLite');
  log('info', `📁 قاعدة البيانات: ${DB_PATH}`);
  log('info', `📁 مجلد البيانات: ${DATA_DIR}`);

  try {
    await openDb(DB_PATH);
    log('info', '✅ تم فتح قاعدة البيانات وتفعيل WAL');

    await initTables();

    log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('info', '📦 جارٍ ترحيل البلاغات (ambulance-data.json)...');
    const r = await migrateReports();
    summary.reports = r.reports;
    summary.times = r.times;

    log('info', '📦 جارٍ ترحيل المناوبات (shift-data.json)...');
    const s = await migrateShifts();
    summary.shifts = s.shifts;
    summary.shiftReports = s.shiftReports;

    log('info', '📦 جارٍ ترحيل المستخدمين (users.json)...');
    const u = await migrateUsers();
    summary.users = u.users;

    log('info', '📦 جارٍ ترحيل الإعلانات (announcements.json)...');
    const a = await migrateAnnouncements();
    summary.announcements = a.announcements;

    log('info', '📦 جارٍ ترحيل الملفات التشغيلية (ops-uploads/metadata.json)...');
    const o = await migrateOpsFiles();
    summary.opsFiles = o.opsFiles;

    log('info', '📦 جارٍ ترحيل المستشفيات (hospitals.json)...');
    const h = await migrateHospitals();
    summary.hospitals = h.hospitals;

    log('info', '📦 جارٍ ترحيل المراجع (references.json)...');
    const ref = await migrateReferences();
    summary.references = ref.references;

    log('info', '📦 جارٍ ترحيل الخط الزمني (timeline.json)...');
    const tl = await migrateTimeline();
    summary.timeline = tl.timeline;

    log('info', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log('info', '🎉 اكتمل ترحيل Team 2 بنجاح!');
    log('info', 'ملخص الترحيل:', summary);
    log('info', `💾 ملفات JSON الأصلية محفوظة بدون تعديل — يمكن استخدامها كنسخة احتياطية`);

    return summary;
  } catch (err) {
    log('error', '❌ فشل الترحيل:', err.message);
    throw err;
  } finally {
    await closeDb();
    log('info', '🔒 تم إغلاق قاعدة البيانات');
  }
}

// ─────────────────────────────────────────────────────────────────
// CRUD OPERATIONS (exported for use by application code)
// ─────────────────────────────────────────────────────────────────

// ── Reports CRUD ────────────────────────────────────────────

async function createReport(center, unit, count = 0, times = []) {
  const result = await dbRun(
    `INSERT INTO reports (center, unit, count) VALUES (?, ?, ?)`,
    [center, unit, count]
  );
  const reportId = result.lastID;
  for (const t of times) {
    await dbRun(`INSERT INTO report_times (report_id, timestamp) VALUES (?, ?)`, [reportId, t]);
  }
  return reportId;
}

async function getReportsByCenter(center) {
  return dbAll(`SELECT * FROM reports WHERE center = ?`, [center]);
}

async function getReportsByUnit(unit) {
  return dbAll(`SELECT * FROM reports WHERE unit = ?`, [unit]);
}

async function getAllReports() {
  return dbAll(`SELECT r.*, GROUP_CONCAT(rt.timestamp) as times
    FROM reports r LEFT JOIN report_times rt ON r.id = rt.report_id
    GROUP BY r.id`);
}

async function updateReportCount(id, newCount) {
  return dbRun(`UPDATE reports SET count = ? WHERE id = ?`, [newCount, id]);
}

async function addReportTime(reportId, timestamp) {
  return dbRun(`INSERT INTO report_times (report_id, timestamp) VALUES (?, ?)`, [reportId, timestamp]);
}

async function deleteReport(id) {
  return dbRun(`DELETE FROM reports WHERE id = ?`, [id]);
}

// ── Shifts CRUD ───────────────────────────────────────────────

async function createShift(shiftData) {
  const result = await dbRun(
    `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time, total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      shiftData.shiftName || '', shiftData.shiftDate || '', shiftData.shiftTime || '',
      shiftData.shiftType || '', shiftData.shiftDay || '', shiftData.startTime || '',
      shiftData.totalReports || 0, JSON.stringify(shiftData.rapidLocations || {}),
      JSON.stringify(shiftData.centersData || {}), JSON.stringify(shiftData.vehicleData || {}),
      JSON.stringify(shiftData.fuelData || {}), shiftData.generalNotes || '',
      shiftData.lastUpdate || new Date().toISOString()
    ]
  );
  return result.lastID;
}

async function getShiftById(id) {
  const shift = await dbGet(`SELECT * FROM shifts WHERE id = ?`, [id]);
  if (!shift) return null;
  const reports = await dbAll(`SELECT * FROM shift_reports WHERE shift_id = ?`, [id]);
  shift.savedReports = {};
  for (const r of reports) {
    shift.savedReports[`${r.center}|${r.unit}`] = { count: r.count, times: JSON.parse(r.times || '[]') };
  }
  return shift;
}

async function getAllShifts() {
  return dbAll(`SELECT * FROM shifts ORDER BY start_time DESC`);
}

async function updateShift(id, shiftData) {
  return dbRun(
    `UPDATE shifts SET shift_name = ?, shift_date = ?, shift_time = ?, shift_type = ?, shift_day = ?, total_reports = ?, rapid_locations = ?, centers_data = ?, vehicle_data = ?, fuel_data = ?, general_notes = ?, last_update = ? WHERE id = ?`,
    [
      shiftData.shiftName, shiftData.shiftDate, shiftData.shiftTime, shiftData.shiftType, shiftData.shiftDay,
      shiftData.totalReports, JSON.stringify(shiftData.rapidLocations || {}), JSON.stringify(shiftData.centersData || {}),
      JSON.stringify(shiftData.vehicleData || {}), JSON.stringify(shiftData.fuelData || {}),
      shiftData.generalNotes, new Date().toISOString(), id
    ]
  );
}

async function deleteShift(id) {
  return dbRun(`DELETE FROM shifts WHERE id = ?`, [id]);
}

// ── Users CRUD ────────────────────────────────────────────────

async function createUser(userData) {
  return dbRun(
    `INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userData.id || null, userData.username, userData.password, userData.name || '',
      userData.role || 'user', userData.isActive ? 1 : 0,
      userData.createdAt || new Date().toISOString(), userData.lastLogin || null
    ]
  );
}

async function getUserByUsername(username) {
  return dbGet(`SELECT * FROM users WHERE username = ?`, [username]);
}

async function getUserById(id) {
  return dbGet(`SELECT * FROM users WHERE id = ?`, [id]);
}

async function getAllUsers() {
  return dbAll(`SELECT * FROM users ORDER BY name`);
}

async function updateUser(id, userData) {
  const fields = [];
  const values = [];
  if (userData.name !== undefined) { fields.push('name = ?'); values.push(userData.name); }
  if (userData.password !== undefined) { fields.push('password = ?'); values.push(userData.password); }
  if (userData.role !== undefined) { fields.push('role = ?'); values.push(userData.role); }
  if (userData.isActive !== undefined) { fields.push('is_active = ?'); values.push(userData.isActive ? 1 : 0); }
  if (userData.lastLogin !== undefined) { fields.push('last_login = ?'); values.push(userData.lastLogin); }
  if (fields.length === 0) return { changes: 0 };
  values.push(id);
  return dbRun(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteUser(id) {
  return dbRun(`DELETE FROM users WHERE id = ?`, [id]);
}

// ── Announcements CRUD ──────────────────────────────────────

async function createAnnouncement(data) {
  return dbRun(
    `INSERT INTO announcements (title, body, date, pinned, urgent) VALUES (?, ?, ?, ?, ?)`,
    [data.title || '', data.body || '', data.date || '', data.pinned ? 1 : 0, data.urgent ? 1 : 0]
  );
}

async function getAllAnnouncements() {
  return dbAll(`SELECT * FROM announcements ORDER BY pinned DESC, date DESC`);
}

async function getPinnedAnnouncements() {
  return dbAll(`SELECT * FROM announcements WHERE pinned = 1 ORDER BY date DESC`);
}

async function updateAnnouncement(id, data) {
  const fields = [];
  const values = [];
  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
  if (data.body !== undefined) { fields.push('body = ?'); values.push(data.body); }
  if (data.pinned !== undefined) { fields.push('pinned = ?'); values.push(data.pinned ? 1 : 0); }
  if (data.urgent !== undefined) { fields.push('urgent = ?'); values.push(data.urgent ? 1 : 0); }
  if (fields.length === 0) return { changes: 0 };
  values.push(id);
  return dbRun(`UPDATE announcements SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteAnnouncement(id) {
  return dbRun(`DELETE FROM announcements WHERE id = ?`, [id]);
}

// ── Ops Files CRUD ──────────────────────────────────────────

async function createOpsFile(data) {
  return dbRun(
    `INSERT INTO ops_files (file_id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id || null, data.filename || '', data.storedName || '', data.size || 0,
      data.mimeType || '', data.uploadDate || '', data.uploader || '',
      data.category || 'general', data.note || '', data.icon || ''
    ]
  );
}

async function getAllOpsFiles() {
  return dbAll(`SELECT * FROM ops_files ORDER BY upload_date DESC`);
}

async function getOpsFilesByCategory(category) {
  return dbAll(`SELECT * FROM ops_files WHERE category = ? ORDER BY upload_date DESC`, [category]);
}

async function deleteOpsFile(id) {
  return dbRun(`DELETE FROM ops_files WHERE id = ?`, [id]);
}

// ── Hospitals CRUD ──────────────────────────────────────────

async function createHospital(data) {
  return dbRun(
    `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.name || '', data.type || '', data.specialty || '', data.address || '',
      data.phone || '', data.emergency || '', data.hours || '',
      data.lat ? parseFloat(data.lat) : null, data.lng ? parseFloat(data.lng) : null
    ]
  );
}

async function getAllHospitals() {
  return dbAll(`SELECT * FROM hospitals ORDER BY name`);
}

async function getHospitalsByType(type) {
  return dbAll(`SELECT * FROM hospitals WHERE type = ? ORDER BY name`, [type]);
}

async function updateHospital(id, data) {
  const fields = [];
  const values = [];
  if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
  if (data.phone !== undefined) { fields.push('phone = ?'); values.push(data.phone); }
  if (data.emergency !== undefined) { fields.push('emergency = ?'); values.push(data.emergency); }
  if (data.lat !== undefined) { fields.push('lat = ?'); values.push(parseFloat(data.lat)); }
  if (data.lng !== undefined) { fields.push('lng = ?'); values.push(parseFloat(data.lng)); }
  if (fields.length === 0) return { changes: 0 };
  values.push(id);
  return dbRun(`UPDATE hospitals SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteHospital(id) {
  return dbRun(`DELETE FROM hospitals WHERE id = ?`, [id]);
}

// ── References CRUD ─────────────────────────────────────────

async function createReference(data) {
  return dbRun(
    `INSERT INTO references_table (ref_id, title, type, dept, status, description, date)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      data.id || null, data.title || '', data.type || '', data.dept || '',
      data.status || '', data.desc || data.description || '', data.date || ''
    ]
  );
}

async function getAllReferences() {
  return dbAll(`SELECT * FROM references_table ORDER BY date DESC`);
}

async function getReferencesByStatus(status) {
  return dbAll(`SELECT * FROM references_table WHERE status = ? ORDER BY date DESC`, [status]);
}

async function updateReference(id, data) {
  const fields = [];
  const values = [];
  if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
  if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
  if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
  if (fields.length === 0) return { changes: 0 };
  values.push(id);
  return dbRun(`UPDATE references_table SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function deleteReference(id) {
  return dbRun(`DELETE FROM references_table WHERE id = ?`, [id]);
}

// ── Timeline CRUD ───────────────────────────────────────────

async function createTimelineEvent(data) {
  return dbRun(
    `INSERT INTO timeline (event_id, title, description, type, date, time)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      data.id || null, data.title || '', data.desc || data.description || '',
      data.type || '', data.date || '', data.time || ''
    ]
  );
}

async function getAllTimelineEvents() {
  return dbAll(`SELECT * FROM timeline ORDER BY date DESC, time DESC`);
}

async function getTimelineByType(type) {
  return dbAll(`SELECT * FROM timeline WHERE type = ? ORDER BY date DESC`, [type]);
}

async function deleteTimelineEvent(id) {
  return dbRun(`DELETE FROM timeline WHERE id = ?`, [id]);
}

// ─────────────────────────────────────────────────────────────────
// CLI ENTRY POINT
// ─────────────────────────────────────────────────────────────────

async function main() {
  try {
    await migrateAll();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ فشل الترحيل:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

// ─────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────

module.exports = {
  // Migration
  migrateAll,
  migrateReports,
  migrateShifts,
  migrateUsers,
  migrateAnnouncements,
  migrateOpsFiles,
  migrateHospitals,
  migrateReferences,
  migrateTimeline,
  initTables,

  // Database connection (for integration with existing code)
  openDb,
  closeDb,
  dbRun,
  dbGet,
  dbAll,

  // Reports CRUD
  createReport, getReportsByCenter, getReportsByUnit, getAllReports,
  updateReportCount, addReportTime, deleteReport,

  // Shifts CRUD
  createShift, getShiftById, getAllShifts, updateShift, deleteShift,

  // Users CRUD
  createUser, getUserByUsername, getUserById, getAllUsers, updateUser, deleteUser,

  // Announcements CRUD
  createAnnouncement, getAllAnnouncements, getPinnedAnnouncements,
  updateAnnouncement, deleteAnnouncement,

  // Ops Files CRUD
  createOpsFile, getAllOpsFiles, getOpsFilesByCategory, deleteOpsFile,

  // Hospitals CRUD
  createHospital, getAllHospitals, getHospitalsByType, updateHospital, deleteHospital,

  // References CRUD
  createReference, getAllReferences, getReferencesByStatus, updateReference, deleteReference,

  // Timeline CRUD
  createTimelineEvent, getAllTimelineEvents, getTimelineByType, deleteTimelineEvent
};
