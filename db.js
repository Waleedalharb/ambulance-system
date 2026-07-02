const sqlite3 = require('sqlite3').verbose();
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

/**
 * Open the SQLite database connection with WAL mode for concurrency safety.
 * This prevents race conditions that occur with JSON file operations.
 */
async function openDb() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) {
        logger.error('Failed to open database', err);
        return reject(new Error(`Failed to open database: ${err.message}`));
      }
      db.run('PRAGMA journal_mode = WAL;', (walErr) => {
        if (walErr) {
          logger.error('Failed to enable WAL mode', walErr);
          return reject(new Error(`Failed to enable WAL mode: ${walErr.message}`));
        }
        db.run('PRAGMA foreign_keys = ON;', (fkErr) => {
          if (fkErr) {
            logger.error('Failed to enable foreign keys', fkErr);
            return reject(new Error(`Failed to enable foreign keys: ${fkErr.message}`));
          }
          logger.info(`Database opened at ${DB_PATH} with WAL mode`);
          resolve(db);
        });
      });
    });
  });
}

/**
 * Close the database connection gracefully.
 */
async function closeDb() {
  return new Promise((resolve, reject) => {
    if (!db) {
      return resolve();
    }
    db.close((err) => {
      if (err) {
        logger.error('Failed to close database', err);
        return reject(new Error(`Failed to close database: ${err.message}`));
      }
      db = null;
      logger.info('Database connection closed');
      resolve();
    });
  });
}

// ============================================
// PROMISE WRAPPERS
// ============================================

/**
 * Execute a SQL statement (INSERT, UPDATE, DELETE).
 * Returns { lastID, changes }.
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('Database not initialized. Call openDb() first.'));
    }
    db.run(sql, params, function (err) {
      if (err) {
        logger.error(`SQL error: ${err.message} | SQL: ${sql.substring(0, 200)}`, err);
        return reject(new Error(`SQL error: ${err.message}`));
      }
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * Get a single row.
 */
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('Database not initialized. Call openDb() first.'));
    }
    db.get(sql, params, (err, row) => {
      if (err) {
        logger.error(`Get error: ${err.message} | SQL: ${sql.substring(0, 200)}`, err);
        return reject(new Error(`Get error: ${err.message}`));
      }
      resolve(row || null);
    });
  });
}

/**
 * Get all rows matching the query.
 */
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('Database not initialized. Call openDb() first.'));
    }
    db.all(sql, params, (err, rows) => {
      if (err) {
        logger.error(`All error: ${err.message} | SQL: ${sql.substring(0, 200)}`, err);
        return reject(new Error(`All error: ${err.message}`));
      }
      resolve(rows || []);
    });
  });
}

/**
 * Execute multiple statements.
 */
function exec(sql) {
  return new Promise((resolve, reject) => {
    if (!db) {
      return reject(new Error('Database not initialized. Call openDb() first.'));
    }
    db.exec(sql, (err) => {
      if (err) {
        logger.error(`Exec error: ${err.message}`, err);
        return reject(new Error(`Exec error: ${err.message}`));
      }
      resolve();
    });
  });
}

/**
 * Begin a transaction.
 */
async function beginTransaction() {
  await run('BEGIN TRANSACTION;');
}

/**
 * Commit a transaction.
 */
async function commitTransaction() {
  await run('COMMIT;');
}

/**
 * Rollback a transaction.
 */
async function rollbackTransaction() {
  await run('ROLLBACK;');
}

// ============================================
// TABLE SCHEMAS
// ============================================

const TABLE_SCHEMAS = [
  // --- Reports (from ambulance-data.json) ---
  `CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    center TEXT NOT NULL,
    unit TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(center, unit)
  );`,

  `CREATE TABLE IF NOT EXISTS report_times (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );`,

  // --- Shifts (from shift-data.json) ---
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
    shift_id INTEGER NOT NULL,
    center TEXT NOT NULL,
    unit TEXT NOT NULL,
    count INTEGER DEFAULT 0,
    times TEXT,
    FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
  );`,

  // --- Users (from users.json) ---
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

  // --- Announcements (from announcements.json) ---
  `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    date TEXT,
    pinned INTEGER DEFAULT 0,
    urgent INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // --- Ops Files (from ops-uploads/metadata.json) ---
  `CREATE TABLE IF NOT EXISTS ops_files (
    id TEXT PRIMARY KEY,
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

  // --- Hospitals (from hospitals.json) ---
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

  // --- References (from references.json) ---
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

  // --- Timeline (from timeline.json) ---
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

  // --- Employees ---
  `CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    job_title TEXT DEFAULT 'مسعف',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // --- Teams ---
  `CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    center TEXT NOT NULL,
    team_type TEXT,
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1
  );`,

  // --- Shift Codes ---
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

  // --- Shift Roster ---
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

  // --- Team Assignments ---
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

// ============================================
// TABLE INITIALIZATION
// ============================================

/**
 * Add a column to an existing table if it doesn't already exist.
 * SQLite allows adding columns but not all constraints.
 */
async function addColumnIfNotExists(tableName, columnDef) {
  return new Promise((resolve) => {
    if (!db) {
      logger.warn(`Cannot add column: database not initialized`);
      return resolve();
    }
    db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef};`, (err) => {
      if (err) {
        if (err.message.includes('duplicate column name') || err.message.includes('already exists')) {
          // Column already exists, expected behavior - silently ignore
        } else {
          logger.warn(`Could not add column to ${tableName}: ${err.message}`);
        }
        return resolve();
      }
      logger.info(`Added column ${columnDef} to ${tableName}`);
      resolve();
    });
  });
}

// Default shift codes from the PDF analysis
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

async function seedShiftCodes() {
  const hasData = await tableHasData('shift_codes');
  if (hasData) {
    logger.info('Shift codes already seeded. Skipping.');
    return;
  }
  logger.info('Seeding default shift codes...');
  await beginTransaction();
  try {
    for (const sc of DEFAULT_SHIFT_CODES) {
      await run(
        `INSERT INTO shift_codes (code, name, time_start, time_end, color, status) VALUES (?, ?, ?, ?, ?, ?);`,
        [sc.code, sc.name, sc.time_start, sc.time_end, sc.color, sc.status]
      );
    }
    await commitTransaction();
    logger.info(`Seeded ${DEFAULT_SHIFT_CODES.length} shift codes`);
  } catch (err) {
    await rollbackTransaction();
    logger.error('Shift codes seeding failed', err);
    throw err;
  }
}

/**
 * Initialize all tables. Safe to call multiple times (CREATE TABLE IF NOT EXISTS).
 * Also adds missing columns to existing tables.
 */
async function initTables() {
  logger.info('Initializing database tables...');
  for (const schema of TABLE_SCHEMAS) {
    await run(schema);
  }

  // Add missing columns to existing tables (migration compatibility)
  await addColumnIfNotExists('shifts', 'shift_day TEXT');
  await addColumnIfNotExists('shifts', 'vehicle_data TEXT');
  await addColumnIfNotExists('shifts', 'fuel_data TEXT');

  // Create indexes for new tables
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_shift_roster_date_team ON shift_roster(shift_date, team_id);`);
    await run(`CREATE INDEX IF NOT EXISTS idx_shift_roster_employee ON shift_roster(employee_id);`);
    await run(`CREATE INDEX IF NOT EXISTS idx_team_assignments_employee ON team_assignments(employee_id);`);
    await run(`CREATE INDEX IF NOT EXISTS idx_team_assignments_team ON team_assignments(team_id);`);
    logger.info('Indexes created successfully');
  } catch (idxErr) {
    logger.warn('Some indexes may already exist: ' + idxErr.message);
  }

  // Seed default shift codes
  await seedShiftCodes();

  // Seed default teams from hardcoded data
  await seedDefaultTeams();

  logger.info('All tables initialized successfully');
}

/**
 * Check if a table has any rows.
 */
async function tableHasData(tableName) {
  const row = await get(`SELECT COUNT(*) as count FROM ${tableName};`);
  return row && row.count > 0;
}

// ============================================
// REPORTS CRUD (from ambulance-data.json)
// ============================================

const Reports = {
  async create(center, unit, count = 0) {
    const result = await run(
      `INSERT INTO reports (center, unit, count) VALUES (?, ?, ?);`,
      [center, unit, count]
    );
    return result.lastID;
  },

  async upsert(center, unit, count) {
    const existing = await this.getByCenterUnit(center, unit);
    if (existing) {
      await run(`UPDATE reports SET count = ? WHERE id = ?;`, [count, existing.id]);
      return existing.id;
    }
    return this.create(center, unit, count);
  },

  async getById(id) {
    return get(`SELECT * FROM reports WHERE id = ?;`, [id]);
  },

  async getByCenterUnit(center, unit) {
    return get(`SELECT * FROM reports WHERE center = ? AND unit = ?;`, [center, unit]);
  },

  async getAll() {
    return all(`SELECT * FROM reports ORDER BY center, unit;`);
  },

  async updateCount(id, count) {
    return run(`UPDATE reports SET count = ? WHERE id = ?;`, [count, id]);
  },

  async incrementCount(center, unit) {
    const existing = await this.getByCenterUnit(center, unit);
    if (existing) {
      return run(`UPDATE reports SET count = count + 1 WHERE id = ?;`, [existing.id]);
    }
    return this.create(center, unit, 1);
  },

  async delete(id) {
    return run(`DELETE FROM reports WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM reports;`);
  },

  // Report Times
  async addTime(reportId, timestamp) {
    return run(`INSERT INTO report_times (report_id, timestamp) VALUES (?, ?);`, [reportId, timestamp]);
  },

  async getTimes(reportId) {
    return all(`SELECT timestamp FROM report_times WHERE report_id = ? ORDER BY timestamp;`, [reportId]);
  },

  async deleteTimes(reportId) {
    return run(`DELETE FROM report_times WHERE report_id = ?;`, [reportId]);
  },

  async getFullReport(center, unit) {
    const report = await this.getByCenterUnit(center, unit);
    if (!report) return null;
    const times = await this.getTimes(report.id);
    return { ...report, times: times.map(t => t.timestamp) };
  }
};

// ============================================
// SHIFTS CRUD (from shift-data.json)
// ============================================

const Shifts = {
  async create(data) {
    const result = await run(
      `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time, total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        data.shiftName || null,
        data.shiftDate || null,
        data.shiftTime || null,
        data.shiftType || null,
        data.shiftDay || null,
        data.startTime || null,
        data.totalReports || 0,
        data.rapidLocations ? JSON.stringify(data.rapidLocations) : null,
        data.centersData ? JSON.stringify(data.centersData) : null,
        data.vehicleData ? JSON.stringify(data.vehicleData) : null,
        data.fuelData ? JSON.stringify(data.fuelData) : null,
        data.generalNotes || '',
        data.lastUpdate || null
      ]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM shifts WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM shifts ORDER BY start_time DESC;`);
  },

  async update(id, data) {
    const shift = await this.getById(id);
    if (!shift) return null;
    return run(
      `UPDATE shifts SET
        shift_name = ?, shift_date = ?, shift_time = ?, shift_type = ?, shift_day = ?,
        start_time = ?, total_reports = ?, rapid_locations = ?, centers_data = ?,
        vehicle_data = ?, fuel_data = ?, general_notes = ?, last_update = ?
      WHERE id = ?;`,
      [
        data.shiftName ?? shift.shift_name,
        data.shiftDate ?? shift.shift_date,
        data.shiftTime ?? shift.shift_time,
        data.shiftType ?? shift.shift_type,
        data.shiftDay ?? shift.shift_day,
        data.startTime ?? shift.start_time,
        data.totalReports ?? shift.total_reports,
        data.rapidLocations ? JSON.stringify(data.rapidLocations) : shift.rapid_locations,
        data.centersData ? JSON.stringify(data.centersData) : shift.centers_data,
        data.vehicleData ? JSON.stringify(data.vehicleData) : shift.vehicle_data,
        data.fuelData ? JSON.stringify(data.fuelData) : shift.fuel_data,
        data.generalNotes ?? shift.general_notes,
        data.lastUpdate ?? new Date().toISOString(),
        id
      ]
    );
  },

  async delete(id) {
    return run(`DELETE FROM shifts WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM shifts;`);
  },

  // Shift Reports (savedReports within a shift)
  async addShiftReport(shiftId, center, unit, count, times) {
    return run(
      `INSERT INTO shift_reports (shift_id, center, unit, count, times) VALUES (?, ?, ?, ?, ?);`,
      [shiftId, center, unit, count, times ? JSON.stringify(times) : '[]']
    );
  },

  async getShiftReports(shiftId) {
    return all(`SELECT * FROM shift_reports WHERE shift_id = ?;`, [shiftId]);
  },

  async deleteShiftReports(shiftId) {
    return run(`DELETE FROM shift_reports WHERE shift_id = ?;`, [shiftId]);
  }
};

// ============================================
// USERS CRUD (from users.json)
// ============================================

const Users = {
  async create(data) {
    const result = await run(
      `INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        data.id || null,
        data.username,
        data.password,
        data.name || null,
        data.role || 'user',
        data.isActive !== undefined ? (data.isActive ? 1 : 0) : 1,
        data.createdAt || null,
        data.lastLogin || null
      ]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM users WHERE id = ?;`, [id]);
  },

  async getByUserId(userId) {
    return get(`SELECT * FROM users WHERE user_id = ?;`, [userId]);
  },

  async getByUsername(username) {
    return get(`SELECT * FROM users WHERE username = ?;`, [username]);
  },

  async getAll() {
    return all(`SELECT * FROM users ORDER BY name;`);
  },

  async getActive() {
    return all(`SELECT * FROM users WHERE is_active = 1 ORDER BY name;`);
  },

  async update(id, data) {
    const user = await this.getById(id);
    if (!user) return null;
    return run(
      `UPDATE users SET
        user_id = ?, username = ?, password = ?, name = ?, role = ?, is_active = ?, last_login = ?
      WHERE id = ?;`,
      [
        data.id ?? user.user_id,
        data.username ?? user.username,
        data.password ?? user.password,
        data.name ?? user.name,
        data.role ?? user.role,
        data.isActive !== undefined ? (data.isActive ? 1 : 0) : user.is_active,
        data.lastLogin ?? user.last_login,
        id
      ]
    );
  },

  async setActive(id, isActive) {
    return run(`UPDATE users SET is_active = ? WHERE id = ?;`, [isActive ? 1 : 0, id]);
  },

  async delete(id) {
    return run(`DELETE FROM users WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM users;`);
  }
};

// ============================================
// ANNOUNCEMENTS CRUD (from announcements.json)
// ============================================

const Announcements = {
  async create(data) {
    const id = data.id || Date.now().toString();
    await run(
      `INSERT INTO announcements (id, title, body, date, pinned, urgent) VALUES (?, ?, ?, ?, ?, ?);`,
      [
        id,
        data.title,
        data.body,
        data.date || new Date().toISOString().split('T')[0],
        data.pinned ? 1 : 0,
        data.urgent ? 1 : 0
      ]
    );
    return id;
  },

  async getById(id) {
    return get(`SELECT * FROM announcements WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM announcements ORDER BY pinned DESC, date DESC;`);
  },

  async getPinned() {
    return all(`SELECT * FROM announcements WHERE pinned = 1 ORDER BY date DESC;`);
  },

  async getUrgent() {
    return all(`SELECT * FROM announcements WHERE urgent = 1 ORDER BY date DESC;`);
  },

  async update(id, data) {
    const ann = await this.getById(id);
    if (!ann) return null;
    return run(
      `UPDATE announcements SET title = ?, body = ?, date = ?, pinned = ?, urgent = ? WHERE id = ?;`,
      [
        data.title ?? ann.title,
        data.body ?? ann.body,
        data.date ?? ann.date,
        data.pinned !== undefined ? (data.pinned ? 1 : 0) : ann.pinned,
        data.urgent !== undefined ? (data.urgent ? 1 : 0) : ann.urgent,
        id
      ]
    );
  },

  async delete(id) {
    return run(`DELETE FROM announcements WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM announcements;`);
  }
};

// ============================================
// OPS FILES CRUD (from ops-uploads/metadata.json)
// ============================================

const OpsFiles = {
  async create(data) {
    await run(
      `INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        data.id || Date.now().toString() + 'f' + Math.floor(Math.random() * 1000),
        data.filename,
        data.storedName || data.stored_name || null,
        data.size || 0,
        data.mimeType || data.mime_type || null,
        data.uploadDate || data.upload_date || new Date().toISOString(),
        data.uploader || null,
        data.category || 'general',
        data.note || '',
        data.icon || null
      ]
    );
    return data.id;
  },

  async getById(id) {
    return get(`SELECT * FROM ops_files WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM ops_files ORDER BY upload_date DESC;`);
  },

  async getByCategory(category) {
    return all(`SELECT * FROM ops_files WHERE category = ? ORDER BY upload_date DESC;`, [category]);
  },

  async update(id, data) {
    const file = await this.getById(id);
    if (!file) return null;
    return run(
      `UPDATE ops_files SET
        filename = ?, stored_name = ?, size = ?, mime_type = ?, upload_date = ?,
        uploader = ?, category = ?, note = ?, icon = ?
      WHERE id = ?;`,
      [
        data.filename ?? file.filename,
        data.storedName ?? data.stored_name ?? file.stored_name,
        data.size ?? file.size,
        data.mimeType ?? data.mime_type ?? file.mime_type,
        data.uploadDate ?? data.upload_date ?? file.upload_date,
        data.uploader ?? file.uploader,
        data.category ?? file.category,
        data.note ?? file.note,
        data.icon ?? file.icon,
        id
      ]
    );
  },

  async delete(id) {
    return run(`DELETE FROM ops_files WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM ops_files;`);
  }
};

// ============================================
// HOSPITALS CRUD (from hospitals.json)
// ============================================

const Hospitals = {
  async create(data) {
    const result = await run(
      `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        data.name,
        data.type || null,
        data.specialty || null,
        data.address || null,
        data.phone || null,
        data.emergency || null,
        data.hours || null,
        data.lat !== undefined ? data.lat : null,
        data.lng !== undefined ? data.lng : null
      ]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM hospitals WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM hospitals ORDER BY name;`);
  },

  async getByType(type) {
    return all(`SELECT * FROM hospitals WHERE type = ? ORDER BY name;`, [type]);
  },

  async update(id, data) {
    const h = await this.getById(id);
    if (!h) return null;
    return run(
      `UPDATE hospitals SET
        name = ?, type = ?, specialty = ?, address = ?, phone = ?, emergency = ?, hours = ?, lat = ?, lng = ?, updated_at = ?
      WHERE id = ?;`,
      [
        data.name ?? h.name,
        data.type ?? h.type,
        data.specialty ?? h.specialty,
        data.address ?? h.address,
        data.phone ?? h.phone,
        data.emergency ?? h.emergency,
        data.hours ?? h.hours,
        data.lat !== undefined ? data.lat : h.lat,
        data.lng !== undefined ? data.lng : h.lng,
        new Date().toISOString(),
        id
      ]
    );
  },

  async delete(id) {
    return run(`DELETE FROM hospitals WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM hospitals;`);
  }
};

// ============================================
// REFERENCES CRUD (from references.json)
// ============================================

const References = {
  async create(data) {
    const result = await run(
      `INSERT INTO references_table (title, type, dept, status, desc, date)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [
        data.title,
        data.type || null,
        data.dept || null,
        data.status || null,
        data.desc || data.description || null,
        data.date || null
      ]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM references_table WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM references_table ORDER BY date DESC;`);
  },

  async getByType(type) {
    return all(`SELECT * FROM references_table WHERE type = ? ORDER BY date DESC;`, [type]);
  },

  async getByStatus(status) {
    return all(`SELECT * FROM references_table WHERE status = ? ORDER BY date DESC;`, [status]);
  },

  async update(id, data) {
    const ref = await this.getById(id);
    if (!ref) return null;
    return run(
      `UPDATE references_table SET
        title = ?, type = ?, dept = ?, status = ?, desc = ?, date = ?, updated_at = ?
      WHERE id = ?;`,
      [
        data.title ?? ref.title,
        data.type ?? ref.type,
        data.dept ?? ref.dept,
        data.status ?? ref.status,
        data.desc ?? data.description ?? ref.desc,
        data.date ?? ref.date,
        new Date().toISOString(),
        id
      ]
    );
  },

  async delete(id) {
    return run(`DELETE FROM references_table WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM references_table;`);
  }
};

// ============================================
// TIMELINE CRUD (from timeline.json)
// ============================================

const Timeline = {
  async create(data) {
    const result = await run(
      `INSERT INTO timeline (title, desc, type, date, time)
       VALUES (?, ?, ?, ?, ?);`,
      [
        data.title,
        data.desc || data.description || null,
        data.type || null,
        data.date || null,
        data.time || null
      ]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM timeline WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM timeline ORDER BY date DESC, time DESC;`);
  },

  async getByType(type) {
    return all(`SELECT * FROM timeline WHERE type = ? ORDER BY date DESC, time DESC;`, [type]);
  },

  async update(id, data) {
    const item = await this.getById(id);
    if (!item) return null;
    return run(
      `UPDATE timeline SET
        title = ?, desc = ?, type = ?, date = ?, time = ?, updated_at = ?
      WHERE id = ?;`,
      [
        data.title ?? item.title,
        data.desc ?? data.description ?? item.desc,
        data.type ?? item.type,
        data.date ?? item.date,
        data.time ?? item.time,
        new Date().toISOString(),
        id
      ]
    );
  },

  async delete(id) {
    return run(`DELETE FROM timeline WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM timeline;`);
  }
};

// ============================================
// EMPLOYEES CRUD
// ============================================

const Employees = {
  async create(data) {
    const result = await run(
      `INSERT INTO employees (employee_code, name, phone, job_title, is_active) VALUES (?, ?, ?, ?, ?);`,
      [data.employee_code, data.name, data.phone || null, data.job_title || 'مسعف', data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM employees WHERE id = ?;`, [id]);
  },

  async getByCode(code) {
    return get(`SELECT * FROM employees WHERE employee_code = ?;`, [code]);
  },

  async getAll() {
    return all(`SELECT * FROM employees ORDER BY name;`);
  },

  async getActive() {
    return all(`SELECT * FROM employees WHERE is_active = 1 ORDER BY name;`);
  },

  async update(id, data) {
    const emp = await this.getById(id);
    if (!emp) return null;
    return run(
      `UPDATE employees SET employee_code = ?, name = ?, phone = ?, job_title = ?, is_active = ? WHERE id = ?;`,
      [data.employee_code ?? emp.employee_code, data.name ?? emp.name, data.phone ?? emp.phone, data.job_title ?? emp.job_title, data.is_active !== undefined ? (data.is_active ? 1 : 0) : emp.is_active, id]
    );
  },

  async setActive(id, isActive) {
    return run(`UPDATE employees SET is_active = ? WHERE id = ?;`, [isActive ? 1 : 0, id]);
  },

  async delete(id) {
    return run(`DELETE FROM employees WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM employees;`);
  }
};

// ============================================
// TEAMS CRUD
// ============================================

const Teams = {
  async create(data) {
    const result = await run(
      `INSERT INTO teams (name, center, team_type, sort_order, is_active) VALUES (?, ?, ?, ?, ?);`,
      [data.name, data.center, data.team_type || null, data.sort_order || 0, data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM teams WHERE id = ?;`, [id]);
  },

  async getByName(name) {
    return get(`SELECT * FROM teams WHERE name = ?;`, [name]);
  },

  async getAll() {
    return all(`SELECT * FROM teams ORDER BY sort_order, name;`);
  },

  async getActive() {
    return all(`SELECT * FROM teams WHERE is_active = 1 ORDER BY sort_order, name;`);
  },

  async getByCenter(center) {
    return all(`SELECT * FROM teams WHERE center = ? ORDER BY sort_order, name;`, [center]);
  },

  async update(id, data) {
    const t = await this.getById(id);
    if (!t) return null;
    return run(
      `UPDATE teams SET name = ?, center = ?, team_type = ?, sort_order = ?, is_active = ? WHERE id = ?;`,
      [data.name ?? t.name, data.center ?? t.center, data.team_type ?? t.team_type, data.sort_order ?? t.sort_order, data.is_active !== undefined ? (data.is_active ? 1 : 0) : t.is_active, id]
    );
  },

  async delete(id) {
    return run(`DELETE FROM teams WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM teams;`);
  }
};

// ============================================
// SHIFT CODES CRUD
// ============================================

const ShiftCodes = {
  async create(data) {
    const result = await run(
      `INSERT INTO shift_codes (code, name, time_start, time_end, color, status) VALUES (?, ?, ?, ?, ?, ?);`,
      [data.code, data.name, data.time_start || null, data.time_end || null, data.color || '#2563EB', data.status || 'دوام']
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM shift_codes WHERE id = ?;`, [id]);
  },

  async getByCode(code) {
    return get(`SELECT * FROM shift_codes WHERE code = ?;`, [code]);
  },

  async getAll() {
    return all(`SELECT * FROM shift_codes ORDER BY code;`);
  },

  async update(id, data) {
    const sc = await this.getById(id);
    if (!sc) return null;
    return run(
      `UPDATE shift_codes SET code = ?, name = ?, time_start = ?, time_end = ?, color = ?, status = ? WHERE id = ?;`,
      [data.code ?? sc.code, data.name ?? sc.name, data.time_start ?? sc.time_start, data.time_end ?? sc.time_end, data.color ?? sc.color, data.status ?? sc.status, id]
    );
  },

  async delete(id) {
    return run(`DELETE FROM shift_codes WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM shift_codes;`);
  }
};

// ============================================
// SHIFT ROSTER CRUD
// ============================================

const ShiftRoster = {
  async create(data) {
    const result = await run(
      `INSERT INTO shift_roster (employee_id, team_id, shift_date, shift_code, month, year) VALUES (?, ?, ?, ?, ?, ?);`,
      [data.employee_id, data.team_id || null, data.shift_date, data.shift_code, data.month, data.year]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM shift_roster WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM shift_roster ORDER BY shift_date DESC;`);
  },

  async getByDateAndTeam(shift_date, team_id) {
    return all(
      `SELECT sr.*, e.name as employee_name, e.employee_code, e.job_title FROM shift_roster sr JOIN employees e ON sr.employee_id = e.id WHERE sr.shift_date = ? AND sr.team_id = ? ORDER BY e.name;`,
      [shift_date, team_id]
    );
  },

  async getByMonthYear(month, year) {
    return all(
      `SELECT sr.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_roster sr JOIN employees e ON sr.employee_id = e.id LEFT JOIN teams t ON sr.team_id = t.id WHERE sr.month = ? AND sr.year = ? ORDER BY sr.shift_date, t.name, e.name;`,
      [month, year]
    );
  },

  async getByEmployeeAndDate(employee_id, shift_date) {
    return get(`SELECT * FROM shift_roster WHERE employee_id = ? AND shift_date = ?;`, [employee_id, shift_date]);
  },

  async update(id, data) {
    const sr = await this.getById(id);
    if (!sr) return null;
    return run(
      `UPDATE shift_roster SET employee_id = ?, team_id = ?, shift_date = ?, shift_code = ?, month = ?, year = ? WHERE id = ?;`,
      [data.employee_id ?? sr.employee_id, data.team_id ?? sr.team_id, data.shift_date ?? sr.shift_date, data.shift_code ?? sr.shift_code, data.month ?? sr.month, data.year ?? sr.year, id]
    );
  },

  async delete(id) {
    return run(`DELETE FROM shift_roster WHERE id = ?;`, [id]);
  },

  async deleteByMonthYear(month, year) {
    return run(`DELETE FROM shift_roster WHERE month = ? AND year = ?;`, [month, year]);
  },

  async deleteAll() {
    return run(`DELETE FROM shift_roster;`);
  }
};

// ============================================
// TEAM ASSIGNMENTS CRUD
// ============================================

const TeamAssignments = {
  async create(data) {
    const result = await run(
      `INSERT INTO team_assignments (employee_id, team_id, assigned_date, end_date, is_primary) VALUES (?, ?, ?, ?, ?);`,
      [data.employee_id, data.team_id, data.assigned_date || null, data.end_date || null, data.is_primary !== undefined ? (data.is_primary ? 1 : 0) : 1]
    );
    return result.lastID;
  },

  async getById(id) {
    return get(`SELECT * FROM team_assignments WHERE id = ?;`, [id]);
  },

  async getAll() {
    return all(`SELECT * FROM team_assignments ORDER BY id DESC;`);
  },

  async getByEmployee(employee_id) {
    return all(`SELECT * FROM team_assignments WHERE employee_id = ?;`, [employee_id]);
  },

  async getByTeam(team_id) {
    return all(`SELECT * FROM team_assignments WHERE team_id = ?;`, [team_id]);
  },

  async getActiveByTeam(team_id) {
    return all(
      `SELECT ta.*, e.name as employee_name, e.employee_code, e.phone, e.job_title FROM team_assignments ta JOIN employees e ON ta.employee_id = e.id WHERE ta.team_id = ? AND (ta.end_date IS NULL OR ta.end_date >= date('now')) ORDER BY e.name;`,
      [team_id]
    );
  },

  async update(id, data) {
    const ta = await this.getById(id);
    if (!ta) return null;
    return run(
      `UPDATE team_assignments SET employee_id = ?, team_id = ?, assigned_date = ?, end_date = ?, is_primary = ? WHERE id = ?;`,
      [data.employee_id ?? ta.employee_id, data.team_id ?? ta.team_id, data.assigned_date ?? ta.assigned_date, data.end_date ?? ta.end_date, data.is_primary !== undefined ? (data.is_primary ? 1 : 0) : ta.is_primary, id]
    );
  },

  async delete(id) {
    return run(`DELETE FROM team_assignments WHERE id = ?;`, [id]);
  },

  async deleteAll() {
    return run(`DELETE FROM team_assignments;`);
  }
};

// ============================================
// MIGRATION HELPERS
// ============================================

async function readJsonFile(filePath, defaultValue = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.warn(`File not found: ${filePath}`);
      return defaultValue;
    }
    logger.error(`Failed to read JSON file ${filePath}`, error);
    return defaultValue;
  }
}

// ============================================
// MIGRATION: REPORTS (from ambulance-data.json)
// ============================================

async function migrateReports() {
  const hasData = await tableHasData('reports');
  if (hasData) {
    logger.warn('Reports table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'ambulance-data.json'));
  if (!data || typeof data !== 'object') {
    logger.warn('No ambulance-data.json found or invalid format');
    return 0;
  }

  let count = 0;
  let timeCount = 0;

  await beginTransaction();
  try {
    for (const key of Object.keys(data)) {
      const [center, unit] = key.split('|');
      if (!center || !unit) continue;
      const item = data[key];
      const result = await run(
        `INSERT INTO reports (center, unit, count) VALUES (?, ?, ?);`,
        [center, unit, item.count || 0]
      );
      const reportId = result.lastID;
      count++;

      if (Array.isArray(item.times)) {
        for (const t of item.times) {
          await run(`INSERT INTO report_times (report_id, timestamp) VALUES (?, ?);`, [reportId, t]);
          timeCount++;
        }
      }
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Reports migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} reports with ${timeCount} timestamps`);
  return count;
}

// ============================================
// MIGRATION: SHIFTS (from shift-data.json)
// ============================================

async function migrateShifts() {
  const hasData = await tableHasData('shifts');
  if (hasData) {
    logger.warn('Shifts table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'shift-data.json'));
  if (!data || !Array.isArray(data)) {
    logger.warn('No shift-data.json found or invalid format');
    return 0;
  }

  let count = 0;
  let reportCount = 0;

  await beginTransaction();
  try {
    for (const shift of data) {
      const result = await run(
        `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, shift_day, start_time, total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          shift.shiftName || null,
          shift.shiftDate || null,
          shift.shiftTime || null,
          shift.shiftType || null,
          shift.shiftDay || null,
          shift.startTime || null,
          shift.totalReports || 0,
          shift.rapidLocations ? JSON.stringify(shift.rapidLocations) : null,
          shift.centersData ? JSON.stringify(shift.centersData) : null,
          shift.vehicleData ? JSON.stringify(shift.vehicleData) : null,
          shift.fuelData ? JSON.stringify(shift.fuelData) : null,
          shift.generalNotes || '',
          shift.lastUpdate || null
        ]
      );
      const shiftId = result.lastID;
      count++;

      if (shift.savedReports && typeof shift.savedReports === 'object') {
        for (const key of Object.keys(shift.savedReports)) {
          const [center, unit] = key.split('|');
          if (!center || !unit) continue;
          const r = shift.savedReports[key];
          await run(
            `INSERT INTO shift_reports (shift_id, center, unit, count, times) VALUES (?, ?, ?, ?, ?);`,
            [shiftId, center, unit, r.count || 0, JSON.stringify(r.times || [])]
          );
          reportCount++;
        }
      }
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Shifts migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} shifts with ${reportCount} shift reports`);
  return count;
}

// ============================================
// MIGRATION: USERS (from users.json)
// ============================================

async function migrateUsers() {
  const hasData = await tableHasData('users');
  if (hasData) {
    logger.warn('Users table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'users.json'));
  if (!data || !Array.isArray(data)) {
    logger.warn('No users.json found or invalid format');
    return 0;
  }

  let count = 0;

  await beginTransaction();
  try {
    for (const u of data) {
      await run(
        `INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          u.id || null,
          u.username,
          u.password,
          u.name || null,
          u.role || 'user',
          u.isActive !== undefined ? (u.isActive ? 1 : 0) : 1,
          u.createdAt || null,
          u.lastLogin || null
        ]
      );
      count++;
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Users migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} users`);
  return count;
}

// ============================================
// MIGRATION: ANNOUNCEMENTS (from announcements.json)
// ============================================

async function migrateAnnouncements() {
  const hasData = await tableHasData('announcements');
  if (hasData) {
    logger.warn('Announcements table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'announcements.json'), []);
  if (!Array.isArray(data)) {
    logger.warn('No announcements.json found or invalid format');
    return 0;
  }

  let count = 0;

  await beginTransaction();
  try {
    for (const a of data) {
      await run(
        `INSERT INTO announcements (id, title, body, date, pinned, urgent) VALUES (?, ?, ?, ?, ?, ?);`,
        [
          a.id || Date.now().toString() + '-' + count,
          a.title,
          a.body,
          a.date || new Date().toISOString().split('T')[0],
          a.pinned ? 1 : 0,
          a.urgent ? 1 : 0
        ]
      );
      count++;
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Announcements migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} announcements`);
  return count;
}

// ============================================
// MIGRATION: OPS FILES (from ops-uploads/metadata.json)
// ============================================

async function migrateOpsFiles() {
  const hasData = await tableHasData('ops_files');
  if (hasData) {
    logger.warn('Ops files table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(OPS_METADATA_PATH, []);
  if (!Array.isArray(data)) {
    logger.warn('No ops metadata found or invalid format');
    return 0;
  }

  let count = 0;

  await beginTransaction();
  try {
    for (const f of data) {
      await run(
        `INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          f.id || Date.now().toString() + 'f' + count,
          f.filename,
          f.storedName || null,
          f.size || 0,
          f.mimeType || null,
          f.uploadDate || null,
          f.uploader || null,
          f.category || 'general',
          f.note || '',
          f.icon || null
        ]
      );
      count++;
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Ops files migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} ops files`);
  return count;
}

// ============================================
// MIGRATION: HOSPITALS (from hospitals.json)
// ============================================

async function migrateHospitals() {
  const hasData = await tableHasData('hospitals');
  if (hasData) {
    logger.warn('Hospitals table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'hospitals.json'), []);
  if (!Array.isArray(data)) {
    logger.warn('No hospitals.json found or invalid format');
    return 0;
  }

  let count = 0;

  await beginTransaction();
  try {
    for (const h of data) {
      await run(
        `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          h.name,
          h.type || null,
          h.specialty || null,
          h.address || null,
          h.phone || null,
          h.emergency || null,
          h.hours || null,
          h.lat !== undefined ? h.lat : null,
          h.lng !== undefined ? h.lng : null
        ]
      );
      count++;
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Hospitals migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} hospitals`);
  return count;
}

// ============================================
// MIGRATION: REFERENCES (from references.json)
// ============================================

async function migrateReferences() {
  const hasData = await tableHasData('references_table');
  if (hasData) {
    logger.warn('References table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'references.json'), []);
  if (!Array.isArray(data)) {
    logger.warn('No references.json found or invalid format');
    return 0;
  }

  let count = 0;

  await beginTransaction();
  try {
    for (const r of data) {
      await run(
        `INSERT INTO references_table (title, type, dept, status, desc, date)
         VALUES (?, ?, ?, ?, ?, ?);`,
        [
          r.title,
          r.type || null,
          r.dept || null,
          r.status || null,
          r.desc || r.description || null,
          r.date || null
        ]
      );
      count++;
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('References migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} references`);
  return count;
}

// ============================================
// MIGRATION: TIMELINE (from timeline.json)
// ============================================

async function migrateTimeline() {
  const hasData = await tableHasData('timeline');
  if (hasData) {
    logger.warn('Timeline table already has data. Skipping migration.');
    return 0;
  }

  const data = await readJsonFile(path.join(DATA_DIR, 'timeline.json'), []);
  if (!Array.isArray(data)) {
    logger.warn('No timeline.json found or invalid format');
    return 0;
  }

  let count = 0;

  await beginTransaction();
  try {
    for (const t of data) {
      await run(
        `INSERT INTO timeline (title, desc, type, date, time)
         VALUES (?, ?, ?, ?, ?);`,
        [
          t.title,
          t.desc || t.description || null,
          t.type || null,
          t.date || null,
          t.time || null
        ]
      );
      count++;
    }
    await commitTransaction();
  } catch (err) {
    await rollbackTransaction();
    logger.error('Timeline migration failed', err);
    throw err;
  }

  logger.info(`Migrated ${count} timeline entries`);
  return count;
}

// ============================================
// MAIN MIGRATION RUNNER
// ============================================

/**
 * Run all migrations. Skips tables that already have data.
 * Does NOT delete or modify JSON files.
 */
async function migrateAll() {
  logger.info('=== Starting SQLite Migration ===');
  logger.info('Note: JSON files are preserved and will continue to work');

  const results = {
    reports: await migrateReports(),
    shifts: await migrateShifts(),
    users: await migrateUsers(),
    announcements: await migrateAnnouncements(),
    opsFiles: await migrateOpsFiles(),
    hospitals: await migrateHospitals(),
    references: await migrateReferences(),
    timeline: await migrateTimeline()
  };

  logger.info('=== Migration Summary ===');
  for (const [key, count] of Object.entries(results)) {
    logger.info(`  ${key}: ${count} records migrated`);
  }
  logger.info('=== Migration Complete ===');
  return results;
}

/**
 * Initialize the database: open connection, create tables, optionally migrate data.
 * @param {boolean} runMigration - Whether to run data migration from JSON files
 */
async function init(runMigration = false) {
  await openDb();
  await initTables();
  if (runMigration) {
    await migrateAll();
  }
  logger.info('Database initialized successfully');
}

// ============================================
// MODULE EXPORTS
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

  // Transaction helpers
  beginTransaction,
  commitTransaction,
  rollbackTransaction,

  // Table init
  initTables,
  tableHasData,

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
  migrateReports,
  migrateShifts,
  migrateUsers,
  migrateAnnouncements,
  migrateOpsFiles,
  migrateHospitals,
  migrateReferences,
  migrateTimeline,
  migrateAll
};
