const Database = require('better-sqlite3');
const fs = require('fs').promises;
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
const DB_PATH = path.join(__dirname, 'database.db');
const DATA_DIR = path.join(__dirname, 'data');
const OPS_UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'operational');
const OPS_METADATA_PATH = path.join(OPS_UPLOAD_DIR, 'metadata.json');

// ============================================
// LOGGER
// ============================================
const logger = {
  info: (msg) => console.log(`[DB] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[DB] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
  warn: (msg) => console.warn(`[DB] ${new Date().toISOString()} WARN: ${msg}`),
};

// ============================================
// DATABASE CONNECTION
// ============================================
let db = null;

async function openDb() {
  try {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info(`Database opened at ${DB_PATH} with WAL mode`);
    return db;
  } catch (err) {
    logger.error('Failed to open database', err);
    throw new Error(`Failed to open database: ${err.message}`);
  }
}

async function closeDb() {
  if (db) {
    db.close();
    logger.info('Database connection closed');
  }
}

// ============================================
// PROMISE WRAPPERS (keep async signatures for compatibility)
// ============================================
async function run(sql, params = []) {
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return { id: result.lastInsertRowid, changes: result.changes };
}

async function get(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.get(...params) || null;
}

async function all(sql, params = []) {
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

async function exec(sql) {
  db.exec(sql);
}

// ============================================
// TABLE SCHEMAS
// ============================================
const TABLE_SCHEMAS = [
  // Reports
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    center TEXT NOT NULL,
    unit TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS report_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
    timestamp TEXT NOT NULL
  );`,

  // Shifts
  `CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_name TEXT,
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
  `CREATE TABLE IF NOT EXISTS shift_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
    center TEXT,
    unit TEXT,
    count INTEGER DEFAULT 0,
    times TEXT
  );`,

  // Users
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

  // Announcements
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    date TEXT,
    pinned INTEGER DEFAULT 0,
    urgent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Ops Files
  `CREATE TABLE IF NOT EXISTS ops_files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    stored_name TEXT,
    size INTEGER DEFAULT 0,
    mime_type TEXT,
    upload_date TEXT,
    uploader TEXT,
    category TEXT DEFAULT 'عام',
    note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Hospitals
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

  // References
  `CREATE TABLE IF NOT EXISTS references_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    type TEXT,
    dept TEXT,
    status TEXT,
    desc TEXT,
    date TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Timeline
  `CREATE TABLE IF NOT EXISTS timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    desc TEXT,
    type TEXT,
    date TEXT,
    time TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Employees
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    job_title TEXT DEFAULT 'مسعف',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Teams
  `CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    center TEXT NOT NULL,
    team_type TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );`,

  // Shift Codes
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

  // Shift Roster
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

  // Team Assignments
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

async function initTables() {
  logger.info('Initializing database tables...');
  for (const schema of TABLE_SCHEMAS) {
    await exec(schema);
  }
  // Create indexes for new tables
  try {
    await exec(`CREATE INDEX IF NOT EXISTS idx_shift_roster_date_team ON shift_roster(shift_date, team_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shift_roster_employee ON shift_roster(employee_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_team_assignments_employee ON team_assignments(employee_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_team_assignments_team ON team_assignments(team_id);`);
    logger.info('Indexes created successfully');
  } catch (idxErr) {
    logger.warn('Some indexes may already exist: ' + idxErr.message);
  }
  // Seed default data
  await seedShiftCodes();
  await seedDefaultTeams();
  logger.info('All tables initialized successfully');
}

// ============================================
// CRUD: REPORTS
// ============================================
const Reports = {
  async getAll() {
    return all('SELECT * FROM reports ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM reports WHERE id = ?', [id]);
  },
  async getByCenterUnit(center, unit) {
    return get('SELECT * FROM reports WHERE center = ? AND unit = ?', [center, unit]);
  },
  async create(center, unit, count = 0) {
    const result = await run('INSERT INTO reports (center, unit, count) VALUES (?, ?, ?);', [center, unit, count]);
    return result.id;
  },
  async updateCount(id, count) {
    return run('UPDATE reports SET count = ? WHERE id = ?', [count, id]);
  },
  async delete(id) {
    return run('DELETE FROM reports WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM reports');
  },
  async getTimes(reportId) {
    return all('SELECT * FROM report_times WHERE report_id = ?', [reportId]);
  },
  async addTime(reportId, timestamp) {
    return run('INSERT INTO report_times (report_id, timestamp) VALUES (?, ?)', [reportId, timestamp]);
  }
};

// ============================================
// CRUD: SHIFTS
// ============================================
const Shifts = {
  async getAll() {
    return all('SELECT * FROM shifts ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM shifts WHERE id = ?', [id]);
  },
  async create(data) {
    const result = await run(
      `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time, total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.shiftName || null, data.shiftDate || null, data.shiftTime || null, data.shiftType || null, data.shiftDay || null, data.startTime || null, data.totalReports || 0, data.rapidLocations ? JSON.stringify(data.rapidLocations) : null, data.centersData ? JSON.stringify(data.centersData) : null, data.vehicleData ? JSON.stringify(data.vehicleData) : null, data.fuelData ? JSON.stringify(data.fuelData) : null, data.generalNotes || '', data.lastUpdate || null]
    );
    return result.id;
  },
  async update(id, data) {
    return run(
      `UPDATE shifts SET shift_name = ?, shift_date = ?, shift_time = ?, shift_type = ?, shift_day = ?, start_time = ?, total_reports = ?, rapid_locations = ?, centers_data = ?, vehicle_data = ?, fuel_data = ?, general_notes = ?, last_update = ? WHERE id = ?;`,
      [data.shiftName || null, data.shiftDate || null, data.shiftTime || null, data.shiftType || null, data.shiftDay || null, data.startTime || null, data.totalReports || 0, data.rapidLocations ? JSON.stringify(data.rapidLocations) : null, data.centersData ? JSON.stringify(data.centersData) : null, data.vehicleData ? JSON.stringify(data.vehicleData) : null, data.fuelData ? JSON.stringify(data.fuelData) : null, data.generalNotes || '', data.lastUpdate || null, id]
    );
  },
  async delete(id) {
    return run('DELETE FROM shifts WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM shifts');
  },
  async addShiftReport(shiftId, center, unit, count, times) {
    return run('INSERT INTO shift_reports (shift_id, center, unit, count, times) VALUES (?, ?, ?, ?, ?);', [shiftId, center, unit, count, JSON.stringify(times || [])]);
  },
  async getShiftReports(shiftId) {
    return all('SELECT * FROM shift_reports WHERE shift_id = ?', [shiftId]);
  }
};

// ============================================
// CRUD: USERS
// ============================================
const Users = {
  async getAll() {
    return all('SELECT * FROM users ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM users WHERE id = ?', [id]);
  },
  async getByUsername(username) {
    return get('SELECT * FROM users WHERE username = ?', [username]);
  },
  async create(data) {
    return run('INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?, ?, ?);', [data.id, data.username, data.password, data.name, data.role, data.isActive ? 1 : 0, data.createdAt, data.lastLogin]);
  },
  async update(id, data) {
    return run('UPDATE users SET username = ?, password = ?, name = ?, role = ?, is_active = ? WHERE id = ?;', [data.username, data.password, data.name, data.role, data.isActive ? 1 : 0, id]);
  },
  async delete(id) {
    return run('DELETE FROM users WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM users');
  }
};

// ============================================
// CRUD: ANNOUNCEMENTS
// ============================================
const Announcements = {
  async getAll() {
    return all('SELECT * FROM announcements ORDER BY pinned DESC, urgent DESC, created_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM announcements WHERE id = ?', [id]);
  },
  async create(data) {
    return run('INSERT INTO announcements (id, title, body, date, pinned, urgent) VALUES (?, ?, ?, ?, ?, ?);', [data.id, data.title, data.body, data.date, data.pinned ? 1 : 0, data.urgent ? 1 : 0]);
  },
  async update(id, data) {
    return run('UPDATE announcements SET title = ?, body = ?, date = ?, pinned = ?, urgent = ? WHERE id = ?;', [data.title, data.body, data.date, data.pinned ? 1 : 0, data.urgent ? 1 : 0, id]);
  },
  async delete(id) {
    return run('DELETE FROM announcements WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM announcements');
  }
};

// ============================================
// CRUD: OPS FILES
// ============================================
const OpsFiles = {
  async getAll() {
    return all('SELECT * FROM ops_files ORDER BY upload_date DESC');
  },
  async getById(id) {
    return get('SELECT * FROM ops_files WHERE id = ?', [id]);
  },
  async create(data) {
    return run('INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);', [data.id, data.filename, data.storedName, data.size, data.mimeType, data.uploadDate, data.uploader, data.category, data.note]);
  },
  async update(id, data) {
    return run('UPDATE ops_files SET filename = ?, stored_name = ?, size = ?, mime_type = ?, upload_date = ?, uploader = ?, category = ?, note = ? WHERE id = ?;', [data.filename, data.storedName, data.size, data.mimeType, data.uploadDate, data.uploader, data.category, data.note, id]);
  },
  async delete(id) {
    return run('DELETE FROM ops_files WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM ops_files');
  }
};

// ============================================
// CRUD: HOSPITALS
// ============================================
const Hospitals = {
  async getAll() {
    return all('SELECT * FROM hospitals ORDER BY name');
  },
  async getById(id) {
    return get('SELECT * FROM hospitals WHERE id = ?', [id]);
  },
  async create(data) {
    return run('INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);', [data.name, data.type, data.specialty, data.address, data.phone, data.emergency, data.hours, data.lat, data.lng]);
  },
  async update(id, data) {
    return run('UPDATE hospitals SET name = ?, type = ?, specialty = ?, address = ?, phone = ?, emergency = ?, hours = ?, lat = ?, lng = ? WHERE id = ?;', [data.name, data.type, data.specialty, data.address, data.phone, data.emergency, data.hours, data.lat, data.lng, id]);
  },
  async delete(id) {
    return run('DELETE FROM hospitals WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM hospitals');
  }
};

// ============================================
// CRUD: REFERENCES
// ============================================
const References = {
  async getAll() {
    return all('SELECT * FROM references_table ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM references_table WHERE id = ?', [id]);
  },
  async create(data) {
    return run('INSERT INTO references_table (title, type, dept, status, desc, date) VALUES (?, ?, ?, ?, ?, ?);', [data.title, data.type, data.dept, data.status, data.desc, data.date]);
  },
  async update(id, data) {
    return run('UPDATE references_table SET title = ?, type = ?, dept = ?, status = ?, desc = ?, date = ? WHERE id = ?;', [data.title, data.type, data.dept, data.status, data.desc, data.date, id]);
  },
  async delete(id) {
    return run('DELETE FROM references_table WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM references_table');
  }
};

// ============================================
// CRUD: TIMELINE
// ============================================
const Timeline = {
  async getAll() {
    return all('SELECT * FROM timeline ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM timeline WHERE id = ?', [id]);
  },
  async create(data) {
    return run('INSERT INTO timeline (title, desc, type, date, time) VALUES (?, ?, ?, ?, ?);', [data.title, data.desc, data.type, data.date, data.time]);
  },
  async update(id, data) {
    return run('UPDATE timeline SET title = ?, desc = ?, type = ?, date = ?, time = ? WHERE id = ?;', [data.title, data.desc, data.type, data.date, data.time, id]);
  },
  async delete(id) {
    return run('DELETE FROM timeline WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM timeline');
  }
};

// ============================================
// DEFAULT SEED DATA
// ============================================
const DEFAULT_SHIFT_CODES = [
  { code: 'D12', name: 'دوام 12 صباحاً', time_start: '05:00', time_end: '17:00', color: '#2563EB', status: 'دوام' },
  { code: 'N12', name: 'دوام 12 ليلاً', time_start: '17:00', time_end: '05:00', color: '#7C3AED', status: 'دوام' },
  { code: 'M', name: 'مهمة', time_start: '00:00', time_end: '23:59', color: '#F59E0B', status: 'دوام' },
  { code: 'O12', name: 'أوفرلاب 12', time_start: '05:00', time_end: '17:00', color: '#10B981', status: 'دوام' },
  { code: 'V', name: 'إجازة', time_start: null, time_end: null, color: '#EF4444', status: 'إجازة' },
  { code: 'WO', name: 'Weekend Off', time_start: null, time_end: null, color: '#F97316', status: 'راحة' },
  { code: 'VC', name: 'إجازة مرضية', time_start: null, time_end: null, color: '#EC4899', status: 'إجازة' },
  { code: 'C', name: 'تدريب', time_start: null, time_end: null, color: '#8B5CF6', status: 'تدريب' },
  { code: 'ME', name: 'مكلف', time_start: null, time_end: null, color: '#06B6D4', status: 'دوام' },
  { code: 'N8', name: 'دوام 8 ليلاً', time_start: '22:00', time_end: '06:00', color: '#7C3AED', status: 'دوام' },
  { code: 'CP8', name: 'تكميلية 8', time_start: null, time_end: null, color: '#84CC16', status: 'تكميل' },
  { code: 'CP24', name: 'تكميلية 24', time_start: null, time_end: null, color: '#84CC16', status: 'تكميل' },
  { code: 'CPD', name: 'تكميلية صباحية', time_start: '05:00', time_end: '17:00', color: '#84CC16', status: 'تكميل' },
  { code: 'CPN', name: 'تكميلية ليلية', time_start: '17:00', time_end: '05:00', color: '#84CC16', status: 'تكميل' },
  { code: 'E', name: 'إجازة', time_start: null, time_end: null, color: '#EF4444', status: 'إجازة' },
  { code: 'EV', name: 'إجازة استثنائية', time_start: null, time_end: null, color: '#F43F5E', status: 'إجازة' },
  { code: 'F', name: 'مكلف', time_start: null, time_end: null, color: '#06B6D4', status: 'دوام' },
  { code: 'LN8', name: 'ليلية 8', time_start: '22:00', time_end: '06:00', color: '#7C3AED', status: 'دوام' },
  { code: 'LN10', name: 'ليلية 10', time_start: '20:00', time_end: '06:00', color: '#7C3AED', status: 'دوام' },
  { code: 'D10', name: 'دوام 10 صباحاً', time_start: '07:00', time_end: '17:00', color: '#2563EB', status: 'دوام' },
  { code: 'D11', name: 'دوام 11 صباحاً', time_start: '06:00', time_end: '17:00', color: '#2563EB', status: 'دوام' },
  { code: 'D8', name: 'دوام 8 صباحاً', time_start: '07:00', time_end: '15:00', color: '#2563EB', status: 'دوام' },
  { code: 'D6', name: 'دوام 6 صباحاً', time_start: '05:00', time_end: '11:00', color: '#2563EB', status: 'دوام' },
  { code: 'N10', name: 'دوام 10 ليلاً', time_start: '19:00', time_end: '05:00', color: '#7C3AED', status: 'دوام' },
  { code: 'N11', name: 'دوام 11 ليلاً', time_start: '18:00', time_end: '05:00', color: '#7C3AED', status: 'دوام' },
  { code: 'N6', name: 'دوام 6 ليلاً', time_start: '17:00', time_end: '23:00', color: '#7C3AED', status: 'دوام' },
  { code: 'O10', name: 'أوفرلاب 10', time_start: '07:00', time_end: '17:00', color: '#10B981', status: 'دوام' },
  { code: 'O6', name: 'أوفرلاب 6', time_start: '05:00', time_end: '11:00', color: '#10B981', status: 'دوام' }
];

const DEFAULT_TEAMS = [
  { name: 'جنوب 1', center: 'المنصورة', team_type: 'جنوب', sort_order: 1 },
  { name: 'جنوب 2', center: 'الخالدية', team_type: 'جنوب', sort_order: 2 },
  { name: 'جنوب 3', center: 'منفوحة', team_type: 'جنوب', sort_order: 3 },
  { name: 'جنوب 4', center: 'الدار البيضاء', team_type: 'جنوب', sort_order: 4 },
  { name: 'جنوب 5', center: 'الدار البيضاء', team_type: 'جنوب', sort_order: 5 },
  { name: 'جنوب 6', center: 'الإسكان', team_type: 'جنوب', sort_order: 6 },
  { name: 'جنوب 7', center: 'الحائر', team_type: 'جنوب', sort_order: 7 },
  { name: 'جنوب 8', center: 'الشفاء', team_type: 'جنوب', sort_order: 8 },
  { name: 'جنوب 9', center: 'عكاظ', team_type: 'جنوب', sort_order: 9 },
  { name: 'جنوب 10', center: 'ديراب', team_type: 'جنوب', sort_order: 10 },
  { name: 'جنوب 11', center: 'المنصورة', team_type: 'جنوب', sort_order: 11 },
  { name: 'جنوب 12', center: 'المنصورة', team_type: 'جنوب', sort_order: 12 },
  { name: 'جنوب 13', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 13 },
  { name: 'جنوب 14', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 14 },
  { name: 'جنوب 15', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 15 },
  { name: 'جنوب 16', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 16 },
  { name: 'جنوب 17', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 17 },
  { name: 'جنوب 18', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 18 },
  { name: 'جنوب 19', center: 'الفرق الإضافية', team_type: 'جنوب', sort_order: 19 },
  { name: 'سريع 1', center: 'الدار البيضاء', team_type: 'سريع', sort_order: 101 },
  { name: 'سريع 2', center: 'الشفاء', team_type: 'سريع', sort_order: 102 },
  { name: 'سريع 3', center: 'المنصورة', team_type: 'سريع', sort_order: 103 },
  { name: 'سريع 4', center: 'الفرق الإضافية', team_type: 'سريع', sort_order: 104 }
];

async function seedShiftCodes() {
  try {
    const existing = await all('SELECT COUNT(*) as count FROM shift_codes');
    if (existing[0].count > 0) {
      logger.info('Shift codes already seeded. Skipping.');
      return;
    }
    logger.info('Seeding default shift codes...');
    for (const sc of DEFAULT_SHIFT_CODES) {
      await run('INSERT INTO shift_codes (code, name, time_start, time_end, color, status) VALUES (?, ?, ?, ?, ?, ?);', [sc.code, sc.name, sc.time_start, sc.time_end, sc.color, sc.status]);
    }
    logger.info(`Seeded ${DEFAULT_SHIFT_CODES.length} shift codes`);
  } catch (err) {
    logger.error('Shift codes seeding failed', err);
  }
}

async function seedDefaultTeams() {
  try {
    const existing = await all('SELECT COUNT(*) as count FROM teams');
    if (existing[0].count > 0) {
      logger.info('Teams already seeded. Skipping.');
      return;
    }
    logger.info('Seeding default teams...');
    for (const t of DEFAULT_TEAMS) {
      await run('INSERT INTO teams (name, center, team_type, sort_order, is_active) VALUES (?, ?, ?, ?, ?);', [t.name, t.center, t.team_type, t.sort_order, 1]);
    }
    logger.info(`Seeded ${DEFAULT_TEAMS.length} teams`);
  } catch (err) {
    logger.error('Teams seeding failed', err);
  }
}

// ============================================
// CRUD: EMPLOYEES
// ============================================
const Employees = {
  async getAll() {
    return all('SELECT * FROM employees ORDER BY name');
  },
  async getById(id) {
    return get('SELECT * FROM employees WHERE id = ?', [id]);
  },
  async getByCode(code) {
    return get('SELECT * FROM employees WHERE employee_code = ?', [code]);
  },
  async getActive() {
    return all('SELECT * FROM employees WHERE is_active = 1 ORDER BY name');
  },
  async create(data) {
    const result = await run('INSERT INTO employees (employee_code, name, phone, job_title, is_active) VALUES (?, ?, ?, ?, ?);', [data.employee_code, data.name, data.phone || null, data.job_title || 'مسعف', data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1]);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE employees SET employee_code = ?, name = ?, phone = ?, job_title = ?, is_active = ? WHERE id = ?;', [data.employee_code, data.name, data.phone, data.job_title, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1, id]);
  },
  async delete(id) {
    return run('DELETE FROM employees WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM employees');
  }
};

// ============================================
// CRUD: TEAMS
// ============================================
const Teams = {
  async getAll() {
    return all('SELECT * FROM teams ORDER BY sort_order, name');
  },
  async getById(id) {
    return get('SELECT * FROM teams WHERE id = ?', [id]);
  },
  async getByName(name) {
    return get('SELECT * FROM teams WHERE name = ?', [name]);
  },
  async getActive() {
    return all('SELECT * FROM teams WHERE is_active = 1 ORDER BY sort_order, name');
  },
  async getByCenter(center) {
    return all('SELECT * FROM teams WHERE center = ? ORDER BY sort_order, name', [center]);
  },
  async create(data) {
    const result = await run('INSERT INTO teams (name, center, team_type, sort_order, is_active) VALUES (?, ?, ?, ?, ?);', [data.name, data.center, data.team_type || null, data.sort_order || 0, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1]);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE teams SET name = ?, center = ?, team_type = ?, sort_order = ?, is_active = ? WHERE id = ?;', [data.name, data.center, data.team_type, data.sort_order, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1, id]);
  },
  async delete(id) {
    return run('DELETE FROM teams WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM teams');
  }
};

// ============================================
// CRUD: SHIFT CODES
// ============================================
const ShiftCodes = {
  async getAll() {
    return all('SELECT * FROM shift_codes ORDER BY code');
  },
  async getById(id) {
    return get('SELECT * FROM shift_codes WHERE id = ?', [id]);
  },
  async getByCode(code) {
    return get('SELECT * FROM shift_codes WHERE code = ?', [code]);
  },
  async create(data) {
    const result = await run('INSERT INTO shift_codes (code, name, time_start, time_end, color, status) VALUES (?, ?, ?, ?, ?, ?);', [data.code, data.name, data.time_start || null, data.time_end || null, data.color || '#2563EB', data.status || 'دوام']);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE shift_codes SET code = ?, name = ?, time_start = ?, time_end = ?, color = ?, status = ? WHERE id = ?;', [data.code, data.name, data.time_start, data.time_end, data.color, data.status, id]);
  },
  async delete(id) {
    return run('DELETE FROM shift_codes WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM shift_codes');
  }
};

// ============================================
// CRUD: SHIFT ROSTER
// ============================================
const ShiftRoster = {
  async getAll() {
    return all('SELECT * FROM shift_roster ORDER BY shift_date DESC');
  },
  async getById(id) {
    return get('SELECT * FROM shift_roster WHERE id = ?', [id]);
  },
  async getByDateAndTeam(shift_date, team_id) {
    return all('SELECT sr.*, e.name as employee_name, e.employee_code, e.job_title FROM shift_roster sr JOIN employees e ON sr.employee_id = e.id WHERE sr.shift_date = ? AND sr.team_id = ? ORDER BY e.name', [shift_date, team_id]);
  },
  async getByMonthYear(month, year) {
    return all('SELECT sr.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_roster sr JOIN employees e ON sr.employee_id = e.id LEFT JOIN teams t ON sr.team_id = t.id WHERE sr.month = ? AND sr.year = ? ORDER BY sr.shift_date, t.name, e.name', [month, year]);
  },
  async getByEmployeeAndDate(employee_id, shift_date) {
    return get('SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?', [employee_id, shift_date]);
  },
  async create(data) {
    const result = await run('INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?);', [data.employee_id, data.team_id || null, data.shift_date, data.shift_code, data.month, data.year]);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE shift_roster SET employee_id = ?, team_id = ?, shift_date = ?, shift_code = ?, month = ?, year = ? WHERE id = ?;', [data.employee_id, data.team_id, data.shift_date, data.shift_code, data.month, data.year, id]);
  },
  async delete(id) {
    return run('DELETE FROM shift_roster WHERE id = ?', [id]);
  },
  async deleteByMonthYear(month, year) {
    return run('DELETE FROM shift_roster WHERE month = ? AND year = ?', [month, year]);
  },
  async deleteAll() {
    return run('DELETE FROM shift_roster');
  }
};

// ============================================
// CRUD: TEAM ASSIGNMENTS
// ============================================
const TeamAssignments = {
  async getAll() {
    return all('SELECT * FROM team_assignments ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM team_assignments WHERE id = ?', [id]);
  },
  async getByEmployee(employee_id) {
    return all('SELECT * FROM team_assignments WHERE employee_id = ?', [employee_id]);
  },
  async getByTeam(team_id) {
    return all('SELECT * FROM team_assignments WHERE team_id = ?', [team_id]);
  },
  async getActiveByTeam(team_id) {
    return all('SELECT ta.*, e.name as employee_name, e.employee_code, e.phone, e.job_title FROM team_assignments ta JOIN employees e ON ta.employee_id = e.id WHERE ta.team_id = ? AND (ta.end_date IS NULL OR ta.end_date >= date(\'now\')) ORDER BY e.name', [team_id]);
  },
  async create(data) {
    const result = await run('INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary) VALUES (?, ?, ?, ?, ?);', [data.employee_id, data.team_id, data.assigned_date || null, data.end_date || null, data.is_primary !== undefined ? (data.is_primary ? 1 : 0) : 1]);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE team_assignments SET employee_id = ?, team_id = ?, assigned_date = ?, end_date = ?, is_primary = ? WHERE id = ?;', [data.employee_id, data.team_id, data.assigned_date, data.end_date, data.is_primary !== undefined ? (data.is_primary ? 1 : 0) : 1, id]);
  },
  async delete(id) {
    return run('DELETE FROM team_assignments WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM team_assignments');
  }
};

// ============================================
// MIGRATION FUNCTIONS
// ============================================
async function migrateReports() {
  try {
    const existing = await Reports.getAll();
    if (existing.length > 0) {
      logger.warn('Reports table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'ambulance-data.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const [key, item] of Object.entries(data)) {
      const [center, unit] = key.split('|');
      if (!center || !unit) continue;
      const reportId = await Reports.create(center, unit, item.count || 0);
      if (Array.isArray(item.times)) {
        for (const t of item.times) {
          await Reports.addTime(reportId, t);
        }
      }
    }
    logger.info(`✅ Migrated ${Object.keys(data).length} reports to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No ambulance-data.json found. Skipping reports migration.');
    } else {
      logger.error('Failed to migrate reports:', error);
    }
  }
}

async function migrateShifts() {
  try {
    const existing = await Shifts.getAll();
    if (existing.length > 0) {
      logger.warn('Shifts table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'shift-data.json');
    const shifts = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const shift of shifts) {
      const shiftId = await Shifts.create(shift);
      if (shift.savedReports && typeof shift.savedReports === 'object') {
        for (const [key, report] of Object.entries(shift.savedReports)) {
          const [center, unit] = key.split('|');
          if (!center || !unit) continue;
          await Shifts.addShiftReport(shiftId, center, unit, report.count || 0, report.times || []);
        }
      }
    }
    logger.info(`✅ Migrated ${shifts.length} shifts to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No shift-data.json found. Skipping shifts migration.');
    } else {
      logger.error('Failed to migrate shifts:', error);
    }
  }
}

async function migrateUsers() {
  try {
    const existing = await Users.getAll();
    if (existing.length > 0) {
      logger.warn('Users table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'users.json');
    const users = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const user of users) {
      await Users.create(user);
    }
    logger.info(`✅ Migrated ${users.length} users to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No users.json found. Skipping users migration.');
    } else {
      logger.error('Failed to migrate users:', error);
    }
  }
}

async function migrateAnnouncements() {
  try {
    const existing = await Announcements.getAll();
    if (existing.length > 0) {
      logger.warn('Announcements table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'announcements.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const item of data) {
      await Announcements.create(item);
    }
    logger.info(`✅ Migrated ${data.length} announcements to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No announcements.json found. Skipping announcements migration.');
    } else {
      logger.error('Failed to migrate announcements:', error);
    }
  }
}

async function migrateOpsFiles() {
  try {
    const existing = await OpsFiles.getAll();
    if (existing.length > 0) {
      logger.warn('Ops files table already has data. Skipping migration.');
      return;
    }
    const data = JSON.parse(await fs.readFile(OPS_METADATA_PATH, 'utf8'));
    for (const item of data) {
      await OpsFiles.create(item);
    }
    logger.info(`✅ Migrated ${data.length} ops files to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No ops metadata found. Skipping ops files migration.');
    } else {
      logger.error('Failed to migrate ops files:', error);
    }
  }
}

async function migrateHospitals() {
  try {
    const existing = await Hospitals.getAll();
    if (existing.length > 0) {
      logger.warn('Hospitals table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'hospitals.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const item of data) {
      await Hospitals.create(item);
    }
    logger.info(`✅ Migrated ${data.length} hospitals to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No hospitals.json found. Skipping hospitals migration.');
    } else {
      logger.error('Failed to migrate hospitals:', error);
    }
  }
}

async function migrateReferences() {
  try {
    const existing = await References.getAll();
    if (existing.length > 0) {
      logger.warn('References table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'references.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const item of data) {
      await References.create(item);
    }
    logger.info(`✅ Migrated ${data.length} references to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No references.json found. Skipping references migration.');
    } else {
      logger.error('Failed to migrate references:', error);
    }
  }
}

async function migrateTimeline() {
  try {
    const existing = await Timeline.getAll();
    if (existing.length > 0) {
      logger.warn('Timeline table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(DATA_DIR, 'timeline.json');
    const data = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const item of data) {
      await Timeline.create(item);
    }
    logger.info(`✅ Migrated ${data.length} timeline events to SQLite`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn('No timeline.json found. Skipping timeline migration.');
    } else {
      logger.error('Failed to migrate timeline:', error);
    }
  }
}

async function migrateAll() {
  logger.info('=== Starting SQLite Migration ===');
  logger.info('Note: JSON files are preserved and will continue to work as fallback');
  await migrateReports();
  await migrateShifts();
  await migrateUsers();
  await migrateAnnouncements();
  await migrateOpsFiles();
  await migrateHospitals();
  await migrateReferences();
  await migrateTimeline();
  logger.info('=== SQLite Migration Complete ===');
}

// ============================================
// INIT FUNCTION
// ============================================
async function init(runMigration = false) {
  await openDb();
  await initTables();
  if (runMigration) {
    await migrateAll();
  }
}

// ============================================
// EXPORTS
// ============================================
module.exports = {
  // Core
  openDb,
  closeDb,
  init,
  run,
  get,
  all,
  exec,
  // CRUD namespaces
  Reports,
  Shifts,
  Users,
  Announcements,
  OpsFiles,
  Hospitals,
  References,
  Timeline,
  Employees,
  Teams,
  ShiftCodes,
  ShiftRoster,
  TeamAssignments,

  // Migration
  migrateAll
};
