const sqlite3 = require('sqlite3').verbose();
const path = require('path');

let db = null;

const TABLE_SCHEMAS = [
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    center TEXT NOT NULL,
    unit TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS report_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER REFERENCES reports(id),
    timestamp TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_name TEXT NOT NULL,
    shift_date TEXT,
    shift_time TEXT,
    shift_type TEXT,
    start_time TEXT,
    total_reports INTEGER DEFAULT 0,
    rapid_locations TEXT,
    centers_data TEXT,
    general_notes TEXT,
    last_update TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS shift_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER REFERENCES shifts(id),
    center TEXT,
    unit TEXT,
    count INTEGER DEFAULT 0,
    times TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT UNIQUE,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT,
    role TEXT CHECK(role IN ('admin', 'director', 'user')),
    is_active INTEGER DEFAULT 1,
    created_at TEXT,
    last_login TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id TEXT UNIQUE,
    action TEXT,
    details TEXT,
    user_id TEXT,
    username TEXT,
    timestamp TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS e_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date_time TEXT,
    location TEXT,
    age INTEGER,
    gender TEXT,
    unit TEXT,
    response_time INTEGER,
    hospital TEXT,
    outcome TEXT,
    notes TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS incident_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date_time TEXT,
    location TEXT,
    inc_type TEXT,
    injuries INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    unit TEXT,
    hospital TEXT,
    details TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS escalation_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date_time TEXT,
    location TEXT,
    event_type TEXT,
    injuries INTEGER DEFAULT 0,
    deaths INTEGER DEFAULT 0,
    agencies TEXT,
    details TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS daily_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_number TEXT,
    date TEXT,
    response_teams INTEGER DEFAULT 0,
    air INTEGER DEFAULT 0,
    border_reports TEXT,
    paths TEXT,
    form_fill TEXT,
    summary TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS air_ambulance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id TEXT UNIQUE,
    report_number TEXT,
    unit TEXT,
    hospital TEXT,
    date_time TEXT,
    notes TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS peak_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT UNIQUE,
    location TEXT,
    lat REAL,
    lng REAL,
    unit TEXT,
    start_time TEXT,
    end_time TEXT,
    priority TEXT,
    notes TEXT,
    status TEXT DEFAULT 'نشط',
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS peak_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id TEXT UNIQUE,
    title TEXT,
    details TEXT,
    priority TEXT,
    unit TEXT,
    location TEXT,
    start_time TEXT,
    end_time TEXT,
    notes TEXT,
    lat REAL,
    lng REAL,
    radius INTEGER DEFAULT 5000,
    mission_id TEXT,
    status TEXT DEFAULT 'نشط',
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS peak_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    log_id TEXT UNIQUE,
    icon TEXT,
    action TEXT,
    details TEXT,
    priority TEXT,
    time TEXT,
    date TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS control_notes (
    id INTEGER PRIMARY KEY,
    notes TEXT,
    updated_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS vacations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    start_date TEXT,
    end_date TEXT,
    type TEXT,
    created_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT UNIQUE,
    filename TEXT,
    file_data TEXT,
    file_type TEXT,
    description TEXT,
    category TEXT,
    priority TEXT,
    uploader TEXT,
    upload_date TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS sound_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    enabled INTEGER DEFAULT 1,
    volume REAL DEFAULT 0.5,
    updated_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS theme_settings (
    id INTEGER PRIMARY KEY,
    file_type TEXT,
    file_name TEXT,
    logo_file_name TEXT,
    logo_file_type TEXT,
    updated_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS password_settings (
    id INTEGER PRIMARY KEY,
    password TEXT,
    updated_at TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    date TEXT,
    pinned INTEGER DEFAULT 0,
    urgent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS ops_files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER DEFAULT 0,
    mime_type TEXT,
    upload_date TEXT,
    uploader TEXT,
    category TEXT DEFAULT 'عام',
    note TEXT,
    icon TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS references_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT,
    dept TEXT,
    status TEXT,
    desc TEXT,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    desc TEXT,
    type TEXT,
    date TEXT,
    time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    job_title TEXT DEFAULT 'مسعف',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    center TEXT NOT NULL,
    team_type TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );`,
  `CREATE TABLE IF NOT EXISTS shift_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    time_start TEXT,
    time_end TEXT,
    color TEXT DEFAULT '#2563EB',
    status TEXT DEFAULT 'دوام',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_roster (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    team_id INTEGER,
    shift_date TEXT NOT NULL,
    shift_code TEXT NOT NULL,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
  );`,
  `CREATE TABLE IF NOT EXISTS team_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    team_id INTEGER NOT NULL,
    assigned_date TEXT,
    end_date TEXT,
    is_primary INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
  );`
];

function initDb(dbPath) {
  return new Promise((resolve, reject) => {
    const resolvedPath = path.resolve(dbPath);
    db = new sqlite3.Database(resolvedPath, (err) => {
      if (err) {
        return reject(new Error(`فشل فتح قاعدة البيانات: ${err.message}`));
      }
      db.run('PRAGMA journal_mode = WAL;', (walErr) => {
        if (walErr) {
          return reject(new Error(`فشل تفعيل وضع WAL: ${walErr.message}`));
        }
        let completed = 0;
        const total = TABLE_SCHEMAS.length;
        for (const schema of TABLE_SCHEMAS) {
          db.run(schema, (schemaErr) => {
            if (schemaErr) {
              return reject(new Error(`فشل إنشاء الجدول: ${schemaErr.message}`));
            }
            completed++;
            if (completed === total) {
              resolve(db);
            }
          });
        }
      });
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('قاعدة البيانات غير مفتوحة'));
    }
    db.run(sql, params, function(err) {
      if (err) {
        return reject(new Error(`خطأ في تنفيذ الاستعلام: ${err.message}`));
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('قاعدة البيانات غير مفتوحة'));
    }
    db.get(sql, params, (err, row) => {
      if (err) {
        return reject(new Error(`خطأ في جلب البيانات: ${err.message}`));
      }
      resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('قاعدة البيانات غير مفتوحة'));
    }
    db.all(sql, params, (err, rows) => {
      if (err) {
        return reject(new Error(`خطأ في جلب البيانات: ${err.message}`));
      }
      resolve(rows || []);
    });
  });
}

function close() {
  return new Promise((resolve, reject) => {
    if (!db) {
      return resolve();
    }
    db.close((err) => {
      if (err) {
        return reject(new Error(`فشل إغلاق قاعدة البيانات: ${err.message}`));
      }
      db = null;
      resolve();
    });
  });
}

module.exports = {
  initDb,
  run,
  get,
  all,
  close
};
