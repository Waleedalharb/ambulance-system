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
// TRANSACTION WRAPPERS
// ============================================
function beginTransaction() {
  db.exec('BEGIN TRANSACTION');
}

function commitTransaction() {
  db.exec('COMMIT');
}

function rollbackTransaction() {
  db.exec('ROLLBACK');
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
  );`,

  // Leave Requests
  `CREATE TABLE IF NOT EXISTS leave_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    type TEXT DEFAULT 'إجازة' CHECK(type IN ('إجازة', 'مرضية', 'استثنائية')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'cancelled')),
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    approved_by INTEGER,
    approved_at DATETIME,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
  );`,

  // Shift Schedule Auto
  `CREATE TABLE IF NOT EXISTS shift_schedule_auto (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id INTEGER NOT NULL,
    team_id INTEGER,
    shift_date TEXT NOT NULL,
    shift_code TEXT NOT NULL,
    shift_hours INTEGER DEFAULT 12 CHECK(shift_hours IN (8, 12)),
    mode TEXT DEFAULT 'normal' CHECK(mode IN ('normal', 'alternative')),
    is_override INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL
  );`,

  // Shift Completions (Radio Mode)
  `CREATE TABLE IF NOT EXISTS shift_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_type TEXT NOT NULL,
    shift_date TEXT NOT NULL,
    teams_data TEXT NOT NULL,
    notes TEXT,
    created_by TEXT,
    created_at TEXT
  );`,

  // Staffing Alerts
  `CREATE TABLE IF NOT EXISTS staffing_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_date TEXT NOT NULL,
    shift_type TEXT NOT NULL,
    severity TEXT DEFAULT 'green' CHECK(severity IN ('green', 'yellow', 'red')),
    message TEXT NOT NULL,
    recommendation TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved INTEGER DEFAULT 0
  );`,

  // Notifications
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    type TEXT DEFAULT 'info',
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Knowledge Chunks (RAG)
  `CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT,
    category TEXT DEFAULT 'عام',
    chunk_index INTEGER DEFAULT 0,
    total_chunks INTEGER DEFAULT 1,
    tokens_json TEXT,
    tf_json TEXT,
    meta_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Unanswered Questions
  `CREATE TABLE IF NOT EXISTS ai_unanswered_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT,
    score REAL DEFAULT 0,
    page_context TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'resolved', 'dismissed')),
    resolution TEXT,
    resolved_by TEXT,
    resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Chat Logs
  `CREATE TABLE IF NOT EXISTS ai_chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    answer TEXT NOT NULL,
    confidence TEXT,
    user_id TEXT,
    user_name TEXT,
    page_context TEXT,
    sources_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Feedback
  `CREATE TABLE IF NOT EXISTS ai_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_log_id INTEGER,
    feedback TEXT CHECK(feedback IN ('positive', 'negative')),
    user_id TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Knowledge Base Documents
  `CREATE TABLE IF NOT EXISTS kb_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT UNIQUE,
    title TEXT NOT NULL,
    filename TEXT,
    original_name TEXT,
    file_type TEXT,
    mime_type TEXT,
    file_path TEXT,
    file_size INTEGER DEFAULT 0,
    content TEXT,
    category TEXT DEFAULT 'عام',
    description TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'processing', 'error', 'archived')),
    chunk_count INTEGER DEFAULT 0,
    metadata TEXT,
    meta TEXT,
    created_by TEXT,
    uploader TEXT,
    upload_date TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Knowledge Base Chunks (with TF-IDF embeddings as JSON)
  `CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
    doc_id INTEGER REFERENCES kb_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER DEFAULT 0,
    content TEXT NOT NULL,
    embedding TEXT,
    token_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Chat Sessions
  `CREATE TABLE IF NOT EXISTS kb_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT UNIQUE NOT NULL,
    user_id TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Chat Messages
  `CREATE TABLE IF NOT EXISTS kb_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES kb_chat_sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    sources TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Query Log
  `CREATE TABLE IF NOT EXISTS kb_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    answer TEXT,
    sources TEXT,
    query_time REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // AI Chat History (legacy unified table, kept for backward compatibility)
  `CREATE TABLE IF NOT EXISTS kb_chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    session_id TEXT,
    role TEXT CHECK(role IN ('user', 'assistant', 'system')),
    message TEXT NOT NULL,
    sources TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // Chat Conversations
  `CREATE TABLE IF NOT EXISTS chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('private', 'group')),
    title TEXT,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_archived INTEGER DEFAULT 0
  );`,

  // Chat Participants
  `CREATE TABLE IF NOT EXISTS chat_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_admin INTEGER DEFAULT 0,
    is_muted INTEGER DEFAULT 0,
    last_read_at DATETIME,
    UNIQUE(conversation_id, user_id)
  );`,

  // Chat Messages
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT DEFAULT 'text' CHECK(type IN ('text', 'file', 'system', 'context')),
    file_url TEXT,
    context_type TEXT,
    context_id TEXT,
    reply_to INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    edited_at DATETIME,
    is_deleted INTEGER DEFAULT 0
  );`,

  // Chat Message Reads
  `CREATE TABLE IF NOT EXISTS chat_message_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id)
  );`,

  // Chat Attachments
  `CREATE TABLE IF NOT EXISTS chat_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER DEFAULT 0,
    upload_date DATETIME DEFAULT CURRENT_TIMESTAMP
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
    await exec(`CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests(employee_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_leave_requests_status ON leave_requests(status);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_leave_requests_dates ON leave_requests(start_date, end_date);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shift_schedule_auto_date ON shift_schedule_auto(shift_date);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shift_schedule_auto_employee ON shift_schedule_auto(employee_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_staffing_alerts_date ON staffing_alerts(alert_date);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_staffing_alerts_resolved ON staffing_alerts(resolved);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shift_completions_date_type ON shift_completions(shift_date, shift_type);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_documents_status ON kb_documents(status);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_documents_category ON kb_documents(category);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_documents_doc_id ON kb_documents(doc_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chat_session ON kb_chat_history(session_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chat_sessions_sid ON kb_chat_sessions(session_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chat_messages_session ON kb_chat_messages(session_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_queries_created ON kb_queries(created_at);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ai_knowledge_category ON ai_knowledge_chunks(category);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ai_unanswered_status ON ai_unanswered_questions(status);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_user ON ai_chat_logs(user_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ai_chat_logs_created ON ai_chat_logs(created_at);`);
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
// MIGRATIONS: Add shift_id columns & new tables
// ============================================
async function runMigrations() {
  logger.info('Running database migrations...');

  // Add shift_id columns to existing tables (backward-compatible)
  const migrations = [
    `ALTER TABLE reports ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL`,
    `ALTER TABLE shift_completions ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE`,
    `ALTER TABLE ops_files ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL`,
    `ALTER TABLE timeline ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL`,
    `ALTER TABLE announcements ADD COLUMN shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL`
  ];

  for (const sql of migrations) {
    try {
      await exec(sql);
      logger.info(`Migration executed: ${sql}`);
    } catch (err) {
      if (err.message && err.message.includes('duplicate column')) {
        logger.info(`Column already exists, skipping: ${sql}`);
      } else {
        logger.warn(`Migration warning: ${err.message}`);
      }
    }
  }

  // Create audit_log table
  try {
    await exec(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
      user_id TEXT,
      user_name TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      type TEXT DEFAULT 'system',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_audit_shift ON audit_log(shift_id)`);
    logger.info('audit_log table created');
  } catch (err) {
    logger.warn('audit_log table creation warning: ' + err.message);
  }

  // Create shift_forms table
  try {
    await exec(`CREATE TABLE IF NOT EXISTS shift_forms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
      form_id TEXT NOT NULL,
      form_name TEXT,
      form_data TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_forms_shift ON shift_forms(shift_id)`);
    logger.info('shift_forms table created');
  } catch (err) {
    logger.warn('shift_forms table creation warning: ' + err.message);
  }


  // ── New unified tables (Phase 1: JSON → SQLite) ──

  // Add status column to shifts table
  try {
    await exec(`ALTER TABLE shifts ADD COLUMN status TEXT DEFAULT 'active' CHECK(status IN ('active', 'pending_handover', 'archived'))`);
    await exec(`ALTER TABLE shifts ADD COLUMN archived_at DATETIME`);
    logger.info('Added status column to shifts');
  } catch (err) {
    if (err.message && err.message.includes('duplicate column')) {
      logger.info('shifts status column already exists');
    } else {
      logger.warn('shifts status migration: ' + err.message);
    }
  }

  // app_settings (replaces theme-settings.json, password.json)
  try {
    await exec(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    logger.info('app_settings table created');
  } catch (err) {
    logger.warn('app_settings: ' + err.message);
  }

  // incidents (replaces incidents.json)
  try {
    await exec(`CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT,
      severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
      location TEXT,
      reported_by TEXT,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_incidents_shift ON incidents(shift_id)`);
    logger.info('incidents table created');
  } catch (err) {
    logger.warn('incidents: ' + err.message);
  }

  // escalations (replaces escalations.json)
  try {
    await exec(`CREATE TABLE IF NOT EXISTS escalations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      level TEXT DEFAULT 'level1' CHECK(level IN ('level1', 'level2', 'level3')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open', 'in_progress', 'resolved', 'closed')),
      reported_by TEXT,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_escalations_shift ON escalations(shift_id)`);
    logger.info('escalations table created');
  } catch (err) {
    logger.warn('escalations: ' + err.message);
  }

  // daily_reports (replaces daily-reports.json)
  try {
    await exec(`CREATE TABLE IF NOT EXISTS daily_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT,
      report_type TEXT DEFAULT 'general',
      created_by TEXT,
      shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_daily_reports_shift ON daily_reports(shift_id)`);
    logger.info('daily_reports table created');
  } catch (err) {
    logger.warn('daily_reports: ' + err.message);
  }

  // KB migrations: add columns to existing kb_documents for backward compatibility
  try {
    const kbCols = [
      { name: 'doc_id', type: 'TEXT' },
      { name: 'mime_type', type: 'TEXT' },
      { name: 'file_path', type: 'TEXT' },
      { name: 'description', type: 'TEXT' },
      { name: 'uploader', type: 'TEXT' },
      { name: 'upload_date', type: 'TEXT' },
      { name: 'is_active', type: 'INTEGER', default: '1' },
      { name: 'meta', type: 'TEXT' }
    ];
    for (const col of kbCols) {
      try {
        await exec(`ALTER TABLE kb_documents ADD COLUMN ${col.name} ${col.type} ${col.default ? 'DEFAULT ' + col.default : ''}`);
        logger.info(`Added kb_documents column: ${col.name}`);
      } catch (colErr) {
        if (colErr.message && colErr.message.includes('duplicate column')) {
          logger.info(`Column ${col.name} already exists, skipping`);
        } else {
          logger.warn(`Column ${col.name} migration warning: ${colErr.message}`);
        }
      }
    }
  } catch (err) {
    logger.warn('KB documents column migration warning: ' + err.message);
  }

  // KB migrations: add doc_id to kb_chunks
  try {
    await exec(`ALTER TABLE kb_chunks ADD COLUMN doc_id INTEGER REFERENCES kb_documents(id) ON DELETE CASCADE`);
    logger.info('Added kb_chunks column: doc_id');
  } catch (err) {
    if (err.message && err.message.includes('duplicate column')) {
      logger.info('Column doc_id already exists in kb_chunks, skipping');
    } else {
      logger.warn('kb_chunks doc_id migration warning: ' + err.message);
    }
  }

  // Create kb_chat_sessions table
  try {
    await exec(`CREATE TABLE IF NOT EXISTS kb_chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      user_id TEXT,
      title TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chat_sessions_sid ON kb_chat_sessions(session_id)`);
    logger.info('kb_chat_sessions table created');
  } catch (err) {
    logger.warn('kb_chat_sessions table creation warning: ' + err.message);
  }

  // Create kb_chat_messages table
  try {
    await exec(`CREATE TABLE IF NOT EXISTS kb_chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES kb_chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      sources TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_chat_messages_session ON kb_chat_messages(session_id)`);
    logger.info('kb_chat_messages table created');
  } catch (err) {
    logger.warn('kb_chat_messages table creation warning: ' + err.message);
  }

  // Create kb_queries table
  try {
    await exec(`CREATE TABLE IF NOT EXISTS kb_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      answer TEXT,
      sources TEXT,
      query_time REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_kb_queries_created ON kb_queries(created_at)`);
    logger.info('kb_queries table created');
  } catch (err) {
    logger.warn('kb_queries table creation warning: ' + err.message);
  }

  logger.info('Migrations complete');
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
  async create(center, unit, count = 0, shift_id = null) {
    const result = await run('INSERT INTO reports (center, unit, count, shift_id) VALUES (?, ?, ?, ?);', [center, unit, count, shift_id]);
    return result.id;
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM reports WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
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
    return run('INSERT INTO announcements (id, title, body, date, pinned, urgent, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?);', [data.id, data.title, data.body, data.date, data.pinned ? 1 : 0, data.urgent ? 1 : 0, data.shift_id || null]);
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM announcements WHERE shift_id = ? ORDER BY pinned DESC, urgent DESC, created_at DESC', [shift_id]);
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
    return run('INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);', [data.id, data.filename, data.storedName, data.size, data.mimeType, data.uploadDate, data.uploader, data.category, data.note, data.shift_id || null]);
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM ops_files WHERE shift_id = ? ORDER BY upload_date DESC', [shift_id]);
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
    return run('INSERT INTO timeline (title, desc, type, date, time, shift_id) VALUES (?, ?, ?, ?, ?, ?);', [data.title, data.desc, data.type, data.date, data.time, data.shift_id || null]);
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM timeline WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
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
// CRUD: CHAT CONVERSATIONS
// ============================================
const ChatConversations = {
  async getAll() {
    return all('SELECT * FROM chat_conversations ORDER BY updated_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM chat_conversations WHERE id = ?', [id]);
  },
  async getByUser(user_id) {
    return all(`SELECT c.* FROM chat_conversations c
      JOIN chat_participants p ON c.id = p.conversation_id
      WHERE p.user_id = ? AND c.is_archived = 0
      ORDER BY c.updated_at DESC`, [user_id]);
  },
  async create(data) {
    const result = await run(
      `INSERT INTO chat_conversations (type, title, created_by) VALUES (?, ?, ?);`,
      [data.type, data.title || null, data.created_by]
    );
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE chat_conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;', [data.title, id]);
  },
  async archive(id) {
    return run('UPDATE chat_conversations SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?;', [id]);
  },
  async delete(id) {
    return run('DELETE FROM chat_conversations WHERE id = ?', [id]);
  }
};

// ============================================
// CRUD: CHAT PARTICIPANTS
// ============================================
const ChatParticipants = {
  async getAll(conversation_id) {
    return all('SELECT * FROM chat_participants WHERE conversation_id = ?', [conversation_id]);
  },
  async getByConversationAndUser(conversation_id, user_id) {
    return get('SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ?', [conversation_id, user_id]);
  },
  async create(conversation_id, user_id, is_admin = 0) {
    return run('INSERT INTO chat_participants (conversation_id, user_id, is_admin) VALUES (?, ?, ?);', [conversation_id, user_id, is_admin]);
  },
  async updateLastRead(conversation_id, user_id) {
    return run('UPDATE chat_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?;', [conversation_id, user_id]);
  },
  async delete(conversation_id, user_id) {
    return run('DELETE FROM chat_participants WHERE conversation_id = ? AND user_id = ?', [conversation_id, user_id]);
  }
};

// ============================================
// CRUD: CHAT MESSAGES
// ============================================
const ChatMessages = {
  async getByConversation(conversation_id, limit = 50, offset = 0) {
    return all(`SELECT * FROM chat_messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?`, [conversation_id, limit, offset]);
  },
  async getById(id) {
    return get('SELECT * FROM chat_messages WHERE id = ?', [id]);
  },
  async create(data) {
    const result = await run(
      `INSERT INTO chat_messages (conversation_id, sender_id, content, type, file_url, context_type, context_id, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.conversation_id, data.sender_id, data.content, data.type || 'text', data.file_url || null, data.context_type || null, data.context_id || null, data.reply_to || null]
    );
    return result.id;
  },
  async markDeleted(id) {
    return run('UPDATE chat_messages SET is_deleted = 1 WHERE id = ?', [id]);
  },
  async getUnreadCount(conversation_id, user_id) {
    const row = await get(`SELECT COUNT(*) as count FROM chat_messages m
      LEFT JOIN chat_message_reads r ON m.id = r.message_id AND r.user_id = ?
      WHERE m.conversation_id = ? AND m.sender_id != ? AND r.id IS NULL AND m.is_deleted = 0`, [user_id, conversation_id, user_id]);
    return row ? row.count : 0;
  }
};

// ============================================
// CRUD: CHAT MESSAGE READS
// ============================================
const ChatMessageReads = {
  async create(message_id, user_id) {
    return run('INSERT OR IGNORE INTO chat_message_reads (message_id, user_id) VALUES (?, ?);', [message_id, user_id]);
  },
  async getByMessage(message_id) {
    return all('SELECT user_id, read_at FROM chat_message_reads WHERE message_id = ?', [message_id]);
  }
};

// ============================================
// CRUD: CHAT ATTACHMENTS
// ============================================
const ChatAttachments = {
  async create(data) {
    const result = await run(
      `INSERT INTO chat_attachments (message_id, filename, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?);`,
      [data.message_id, data.filename, data.stored_name, data.mime_type || null, data.size || 0]
    );
    return result.id;
  },
  async getByMessage(message_id) {
    return all('SELECT * FROM chat_attachments WHERE message_id = ?', [message_id]);
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
// CRUD: LEAVE REQUESTS
// ============================================
const LeaveRequests = {
  async getAll() {
    return all('SELECT lr.*, e.name as employee_name, e.employee_code FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id ORDER BY lr.created_at DESC');
  },
  async getById(id) {
    return get('SELECT lr.*, e.name as employee_name, e.employee_code FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id WHERE lr.id = ?', [id]);
  },
  async getByEmployee(employee_id) {
    return all('SELECT lr.*, e.name as employee_name, e.employee_code FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id WHERE lr.employee_id = ? ORDER BY lr.start_date DESC', [employee_id]);
  },
  async getByStatus(status) {
    return all('SELECT lr.*, e.name as employee_name, e.employee_code FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id WHERE lr.status = ? ORDER BY lr.created_at DESC', [status]);
  },
  async getActiveForDate(date) {
    return all('SELECT lr.*, e.name as employee_name, e.employee_code FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id WHERE lr.status = \'approved\' AND lr.start_date <= ? AND lr.end_date >= ?', [date, date]);
  },
  async getActiveForDateRange(start_date, end_date) {
    return all('SELECT lr.*, e.name as employee_name, e.employee_code FROM leave_requests lr JOIN employees e ON lr.employee_id = e.id WHERE lr.status = \'approved\' AND lr.start_date <= ? AND lr.end_date >= ?', [end_date, start_date]);
  },
  async create(data) {
    const result = await run('INSERT INTO leave_requests (employee_id, start_date, end_date, type, status, reason, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);', [data.employee_id, data.start_date, data.end_date, data.type || 'إجازة', data.status || 'pending', data.reason || null, data.approved_by || null, data.approved_at || null]);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE leave_requests SET employee_id = ?, start_date = ?, end_date = ?, type = ?, status = ?, reason = ?, approved_by = ?, approved_at = ? WHERE id = ?;', [data.employee_id, data.start_date, data.end_date, data.type, data.status, data.reason, data.approved_by, data.approved_at, id]);
  },
  async updateStatus(id, status, approved_by) {
    return run('UPDATE leave_requests SET status = ?, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?;', [status, approved_by, id]);
  },
  async delete(id) {
    return run('DELETE FROM leave_requests WHERE id = ?', [id]);
  }
};

// ============================================
// CRUD: SHIFT SCHEDULE AUTO
// ============================================
const ShiftScheduleAuto = {
  async getAll() {
    return all('SELECT ssa.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_schedule_auto ssa JOIN employees e ON ssa.employee_id = e.id LEFT JOIN teams t ON ssa.team_id = t.id ORDER BY ssa.shift_date, e.name');
  },
  async getById(id) {
    return get('SELECT ssa.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_schedule_auto ssa JOIN employees e ON ssa.employee_id = e.id LEFT JOIN teams t ON ssa.team_id = t.id WHERE ssa.id = ?', [id]);
  },
  async getByMonthYear(month, year) {
    return all('SELECT ssa.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_schedule_auto ssa JOIN employees e ON ssa.employee_id = e.id LEFT JOIN teams t ON ssa.team_id = t.id WHERE CAST(strftime(\'%m\', ssa.shift_date) AS INTEGER) = ? AND CAST(strftime(\'%Y\', ssa.shift_date) AS INTEGER) = ? ORDER BY ssa.shift_date, e.name', [month, year]);
  },
  async getByDate(shift_date) {
    return all('SELECT ssa.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_schedule_auto ssa JOIN employees e ON ssa.employee_id = e.id LEFT JOIN teams t ON ssa.team_id = t.id WHERE ssa.shift_date = ? ORDER BY e.name', [shift_date]);
  },
  async getByEmployeeAndDate(employee_id, shift_date) {
    return get('SELECT * FROM shift_schedule_auto WHERE employee_id = ? AND shift_date = ?', [employee_id, shift_date]);
  },
  async create(data) {
    const result = await run('INSERT INTO shift_schedule_auto (employee_id, team_id, shift_date, shift_code, shift_hours, mode, is_override) VALUES (?, ?, ?, ?, ?, ?, ?);', [data.employee_id, data.team_id || null, data.shift_date, data.shift_code, data.shift_hours || 12, data.mode || 'normal', data.is_override ? 1 : 0]);
    return result.id;
  },
  async update(id, data) {
    return run('UPDATE shift_schedule_auto SET employee_id = ?, team_id = ?, shift_date = ?, shift_code = ?, shift_hours = ?, mode = ?, is_override = ? WHERE id = ?;', [data.employee_id, data.team_id, data.shift_date, data.shift_code, data.shift_hours, data.mode, data.is_override ? 1 : 0, id]);
  },
  async delete(id) {
    return run('DELETE FROM shift_schedule_auto WHERE id = ?', [id]);
  },
  async deleteByMonthYear(month, year) {
    return run('DELETE FROM shift_schedule_auto WHERE CAST(strftime(\'%m\', shift_date) AS INTEGER) = ? AND CAST(strftime(\'%Y\', shift_date) AS INTEGER) = ?', [month, year]);
  }
};

// ============================================
// CRUD: STAFFING ALERTS
// ============================================
const StaffingAlerts = {
  async getAll() {
    return all('SELECT * FROM staffing_alerts ORDER BY created_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM staffing_alerts WHERE id = ?', [id]);
  },
  async getActive() {
    return all('SELECT * FROM staffing_alerts WHERE resolved = 0 ORDER BY alert_date, created_at DESC');
  },
  async getByDate(alert_date) {
    return all('SELECT * FROM staffing_alerts WHERE alert_date = ? AND resolved = 0 ORDER BY created_at DESC', [alert_date]);
  },
  async create(data) {
    const result = await run('INSERT INTO staffing_alerts (alert_date, shift_type, severity, message, recommendation, resolved) VALUES (?, ?, ?, ?, ?, ?);', [data.alert_date, data.shift_type, data.severity, data.message, data.recommendation || null, data.resolved ? 1 : 0]);
    return result.id;
  },
  async resolve(id) {
    return run('UPDATE staffing_alerts SET resolved = 1 WHERE id = ?', [id]);
  },
  async delete(id) {
    return run('DELETE FROM staffing_alerts WHERE id = ?', [id]);
  }
};

// ============================================
// CRUD: NOTIFICATIONS
// ============================================
const Notifications = {
  async getAll() {
    return all('SELECT * FROM notifications ORDER BY created_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM notifications WHERE id = ?', [id]);
  },
  async getByUser(userId, limit = 50) {
    return all('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
  },
  async getUnreadByUser(userId) {
    return all('SELECT * FROM notifications WHERE user_id = ? AND is_read = 0 ORDER BY created_at DESC', [userId]);
  },
  async create(data) {
    const result = await run('INSERT INTO notifications (user_id, title, message, type, is_read) VALUES (?, ?, ?, ?, ?);', [data.user_id, data.title, data.message || '', data.type || 'info', data.is_read ? 1 : 0]);
    return result.id;
  },
  async markAsRead(id) {
    return run('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);
  },
  async markAllAsRead(userId) {
    return run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [userId]);
  },
  async delete(id) {
    return run('DELETE FROM notifications WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM notifications');
  }
};

// ============================================
// CRUD: SHIFT COMPLETIONS
// ============================================
const ShiftCompletions = {
  async getAll() {
    return all('SELECT * FROM shift_completions ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM shift_completions WHERE id = ?', [id]);
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM shift_completions WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
  },
  async create(data) {
    const result = await run('INSERT INTO shift_completions (shift_type, shift_date, teams_data, notes, created_by, created_at, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?);', [data.shift_type, data.shift_date, data.teams_data, data.notes || '', data.created_by, data.created_at, data.shift_id || null]);
    return result.id;
  }
};

// ============================================
// CRUD: AUDIT LOG
// ============================================
const AuditLog = {
  async getAll() {
    return all('SELECT * FROM audit_log ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM audit_log WHERE id = ?', [id]);
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM audit_log WHERE shift_id = ? ORDER BY created_at DESC', [shift_id]);
  },
  async create(data) {
    const result = await run('INSERT INTO audit_log (shift_id, user_id, user_name, action, detail, type) VALUES (?, ?, ?, ?, ?, ?);', [data.shift_id || null, data.user_id || null, data.user_name || null, data.action, data.detail || '', data.type || 'system']);
    return result.id;
  }
};

// ============================================


// ============================================
// CRUD: APP SETTINGS (Replaces JSON: theme-settings, password)
// ============================================
const AppSettings = {
  async get(key) {
    const row = await get('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? JSON.parse(row.value) : null;
  },
  async set(key, value) {
    const json = JSON.stringify(value);
    const existing = await get('SELECT key FROM app_settings WHERE key = ?', [key]);
    if (existing) {
      return run('UPDATE app_settings SET value = ?, updated_at = datetime("now") WHERE key = ?', [json, key]);
    } else {
      return run('INSERT INTO app_settings (key, value) VALUES (?, ?)', [key, json]);
    }
  },
  async delete(key) {
    return run('DELETE FROM app_settings WHERE key = ?', [key]);
  }
};

// ============================================
// CRUD: INCIDENTS (Replaces incidents.json)
// ============================================
const Incidents = {
  async getAll() {
    return all('SELECT * FROM incidents ORDER BY id DESC');
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM incidents WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO incidents (title, description, type, severity, status, location, reported_by, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [data.title, data.description, data.type, data.severity || 'medium', data.status || 'open', data.location, data.reportedBy, data.shiftId || null]
    );
    return result.id;
  },
  async update(id, data) {
    return run(
      'UPDATE incidents SET title = ?, description = ?, type = ?, severity = ?, status = ?, location = ? WHERE id = ?',
      [data.title, data.description, data.type, data.severity, data.status, data.location, id]
    );
  },
  async delete(id) {
    return run('DELETE FROM incidents WHERE id = ?', [id]);
  }
};

// ============================================
// CRUD: ESCALATIONS (Replaces escalations.json)
// ============================================
const Escalations = {
  async getAll() {
    return all('SELECT * FROM escalations ORDER BY id DESC');
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM escalations WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO escalations (title, description, level, status, reported_by, shift_id) VALUES (?, ?, ?, ?, ?, ?)',
      [data.title, data.description, data.level || 'level1', data.status || 'open', data.reportedBy, data.shiftId || null]
    );
    return result.id;
  },
  async update(id, data) {
    return run(
      'UPDATE escalations SET title = ?, description = ?, level = ?, status = ? WHERE id = ?',
      [data.title, data.description, data.level, data.status, id]
    );
  },
  async delete(id) {
    return run('DELETE FROM escalations WHERE id = ?', [id]);
  }
};

// ============================================
// CRUD: DAILY REPORTS (Replaces daily-reports.json)
// ============================================
const DailyReports = {
  async getAll() {
    return all('SELECT * FROM daily_reports ORDER BY id DESC');
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM daily_reports WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO daily_reports (title, content, report_type, created_by, shift_id) VALUES (?, ?, ?, ?, ?)',
      [data.title, data.content, data.reportType || 'general', data.createdBy, data.shiftId || null]
    );
    return result.id;
  },
  async delete(id) {
    return run('DELETE FROM daily_reports WHERE id = ?', [id]);
  }
};

// CRUD: SHIFT FORMS
// ============================================
const ShiftForms = {
  async getAll() {
    return all('SELECT * FROM shift_forms ORDER BY id DESC');
  },
  async getById(id) {
    return get('SELECT * FROM shift_forms WHERE id = ?', [id]);
  },
  async getByShift(shift_id) {
    return all('SELECT * FROM shift_forms WHERE shift_id = ? ORDER BY id DESC', [shift_id]);
  },
  async create(data) {
    const result = await run('INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (?, ?, ?, ?, ?);', [data.shift_id, data.form_id, data.form_name || null, data.form_data || null, data.created_by || null]);
    return result.id;
  }
};

// ============================================
// CRUD: KNOWLEDGE BASE
// ============================================
const KBDocuments = {
  async getAll() {
    return all('SELECT id, doc_id, title, filename, original_name, file_type, mime_type, file_size, category, description, status, chunk_count, created_by, uploader, upload_date, is_active, created_at, updated_at FROM kb_documents ORDER BY created_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM kb_documents WHERE id = ?', [id]);
  },
  async getByDocId(docId) {
    return get('SELECT * FROM kb_documents WHERE doc_id = ?', [docId]);
  },
  async getByStatus(status) {
    return all('SELECT * FROM kb_documents WHERE status = ? ORDER BY created_at DESC', [status]);
  },
  async create(data) {
    const result = await run(
      `INSERT INTO kb_documents (doc_id, title, filename, original_name, file_type, mime_type, file_path, file_size, content, category, description, status, chunk_count, metadata, meta, created_by, uploader, upload_date, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        data.doc_id || null,
        data.title || data.original_name || 'Untitled',
        data.filename || null,
        data.original_name || null,
        data.file_type || null,
        data.mime_type || null,
        data.file_path || null,
        data.file_size || 0,
        data.content || null,
        data.category || 'عام',
        data.description || null,
        data.status || 'active',
        data.chunk_count || 0,
        data.metadata ? JSON.stringify(data.metadata) : null,
        data.meta ? JSON.stringify(data.meta) : null,
        data.created_by || null,
        data.uploader || null,
        data.upload_date || new Date().toISOString(),
        data.is_active !== undefined ? (data.is_active ? 1 : 0) : 1
      ]
    );
    return result.id;
  },
  async update(id, data) {
    return run(
      'UPDATE kb_documents SET title = ?, category = ?, status = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;',
      [data.title, data.category, data.status, data.content, id]
    );
  },
  async updateChunkCount(id, chunkCount) {
    return run('UPDATE kb_documents SET chunk_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;', [chunkCount, 'active', id]);
  },
  async delete(id) {
    return run('DELETE FROM kb_documents WHERE id = ?', [id]);
  },
  async search(query) {
    const searchTerm = `%${query}%`;
    return all('SELECT * FROM kb_documents WHERE title LIKE ? OR content LIKE ? OR description LIKE ? ORDER BY created_at DESC', [searchTerm, searchTerm, searchTerm]);
  }
};

const KBChunks = {
  async getAll() {
    return all('SELECT * FROM kb_chunks ORDER BY id DESC');
  },
  async getByDocumentId(documentId) {
    return all('SELECT * FROM kb_chunks WHERE document_id = ? ORDER BY chunk_index', [documentId]);
  },
  async getByDocId(docId) {
    return all('SELECT * FROM kb_chunks WHERE doc_id = ? ORDER BY chunk_index', [docId]);
  },
  async getAllWithEmbeddings() {
    return all('SELECT id, document_id, doc_id, chunk_index, content, embedding FROM kb_chunks WHERE embedding IS NOT NULL');
  },
  async create(data) {
    const result = await run(
      'INSERT INTO kb_chunks (document_id, doc_id, chunk_index, content, embedding, token_count) VALUES (?, ?, ?, ?, ?, ?);',
      [data.document_id, data.doc_id || null, data.chunk_index, data.content, data.embedding ? JSON.stringify(data.embedding) : null, data.token_count || 0]
    );
    return result.id;
  },
  async deleteByDocumentId(documentId) {
    return run('DELETE FROM kb_chunks WHERE document_id = ?', [documentId]);
  }
};

const KBChatSessions = {
  async getAll() {
    return all('SELECT * FROM kb_chat_sessions ORDER BY updated_at DESC');
  },
  async getById(id) {
    return get('SELECT * FROM kb_chat_sessions WHERE id = ?', [id]);
  },
  async getBySessionId(sessionId) {
    return get('SELECT * FROM kb_chat_sessions WHERE session_id = ?', [sessionId]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO kb_chat_sessions (session_id, user_id, title) VALUES (?, ?, ?);',
      [data.session_id, data.user_id || null, data.title || null]
    );
    return result.id;
  },
  async updateTitle(id, title) {
    return run('UPDATE kb_chat_sessions SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [title, id]);
  },
  async delete(id) {
    return run('DELETE FROM kb_chat_sessions WHERE id = ?', [id]);
  },
  async deleteBySessionId(sessionId) {
    return run('DELETE FROM kb_chat_sessions WHERE session_id = ?', [sessionId]);
  }
};

const KBChatMessages = {
  async getBySessionId(sessionId) {
    const session = await get('SELECT id FROM kb_chat_sessions WHERE session_id = ?', [sessionId]);
    if (!session) return [];
    return all('SELECT * FROM kb_chat_messages WHERE session_id = ? ORDER BY created_at', [session.id]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO kb_chat_messages (session_id, role, content, sources) VALUES (?, ?, ?, ?);',
      [data.session_id, data.role, data.content, data.sources ? JSON.stringify(data.sources) : null]
    );
    return result.id;
  },
  async deleteBySessionId(sessionId) {
    const session = await get('SELECT id FROM kb_chat_sessions WHERE session_id = ?', [sessionId]);
    if (!session) return { changes: 0 };
    return run('DELETE FROM kb_chat_messages WHERE session_id = ?', [session.id]);
  }
};

const KBQueries = {
  async getAll(limit = 100) {
    return all('SELECT * FROM kb_queries ORDER BY created_at DESC LIMIT ?', [limit]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO kb_queries (query, answer, sources, query_time) VALUES (?, ?, ?, ?);',
      [data.query, data.answer || null, data.sources ? JSON.stringify(data.sources) : null, data.query_time || 0]
    );
    return result.id;
  }
};

const KBChatHistory = {
  async getBySession(sessionId, limit = 50) {
    return all('SELECT * FROM kb_chat_history WHERE session_id = ? ORDER BY created_at DESC LIMIT ?', [sessionId, limit]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO kb_chat_history (user_id, session_id, role, message, sources) VALUES (?, ?, ?, ?, ?);',
      [data.user_id || null, data.session_id, data.role, data.message, data.sources ? JSON.stringify(data.sources) : null]
    );
    return result.id;
  },
  async deleteBySession(sessionId) {
    return run('DELETE FROM kb_chat_history WHERE session_id = ?', [sessionId]);
  }
};

// ============================================
// CRUD: AI KNOWLEDGE CHUNKS (RAG TF-IDF)
// ============================================
const AIKnowledgeChunks = {
  async getAll(limit = 100, offset = 0) {
    return all('SELECT id, title, source, category, chunk_index, total_chunks, created_at FROM ai_knowledge_chunks ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
  },
  async getById(id) {
    return get('SELECT * FROM ai_knowledge_chunks WHERE id = ?', [id]);
  },
  async getByCategory(category) {
    return all('SELECT id, title, source, category, chunk_index, total_chunks, created_at FROM ai_knowledge_chunks WHERE category = ? ORDER BY created_at DESC', [category]);
  },
  async searchByTitleOrContent(query) {
    return all('SELECT id, title, source, category, content, chunk_index, total_chunks, created_at FROM ai_knowledge_chunks WHERE title LIKE ? OR content LIKE ? ORDER BY created_at DESC', [`%${query}%`, `%${query}%`]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO ai_knowledge_chunks (title, content, source, category, chunk_index, total_chunks, tokens_json, tf_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
      [data.title, data.content, data.source || '', data.category || 'عام', data.chunk_index || 0, data.total_chunks || 1, data.tokens_json || '[]', data.tf_json || '{}', data.meta_json || '{}', data.created_at || new Date().toISOString()]
    );
    return result.id;
  },
  async delete(id) {
    return run('DELETE FROM ai_knowledge_chunks WHERE id = ?', [id]);
  },
  async deleteAll() {
    return run('DELETE FROM ai_knowledge_chunks');
  },
  async count() {
    const row = await get('SELECT COUNT(*) as count FROM ai_knowledge_chunks');
    return row ? row.count : 0;
  }
};

// ============================================
// CRUD: AI UNANSWERED QUESTIONS
// ============================================
const AIUnansweredQuestions = {
  async getAll(limit = 100, offset = 0) {
    return all('SELECT * FROM ai_unanswered_questions ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
  },
  async getById(id) {
    return get('SELECT * FROM ai_unanswered_questions WHERE id = ?', [id]);
  },
  async getPending(limit = 100) {
    return all('SELECT * FROM ai_unanswered_questions WHERE status = ? ORDER BY created_at DESC LIMIT ?', ['pending', limit]);
  },
  async getByStatus(status, limit = 100) {
    return all('SELECT * FROM ai_unanswered_questions WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, limit]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO ai_unanswered_questions (question, user_id, user_name, score, page_context, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?);',
      [data.question, data.user_id || null, data.user_name || null, data.score || 0, data.page_context || '', data.status || 'pending', data.created_at || new Date().toISOString()]
    );
    return result.id;
  },
  async resolve(id, resolution, resolvedBy) {
    return run('UPDATE ai_unanswered_questions SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ?', ['resolved', resolution || '', resolvedBy || null, new Date().toISOString(), id]);
  },
  async dismiss(id) {
    return run('UPDATE ai_unanswered_questions SET status = ?, resolved_at = ? WHERE id = ?', ['dismissed', new Date().toISOString(), id]);
  },
  async delete(id) {
    return run('DELETE FROM ai_unanswered_questions WHERE id = ?', [id]);
  },
  async countByStatus(status) {
    const row = await get('SELECT COUNT(*) as count FROM ai_unanswered_questions WHERE status = ?', [status]);
    return row ? row.count : 0;
  }
};

// ============================================
// CRUD: AI CHAT LOGS
// ============================================
const AIChatLogs = {
  async getAll(limit = 100, offset = 0) {
    return all('SELECT * FROM ai_chat_logs ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
  },
  async getById(id) {
    return get('SELECT * FROM ai_chat_logs WHERE id = ?', [id]);
  },
  async getByUser(userId, limit = 50) {
    return all('SELECT * FROM ai_chat_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO ai_chat_logs (query, answer, confidence, user_id, user_name, page_context, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?);',
      [data.query, data.answer, data.confidence || 'low', data.user_id || null, data.user_name || null, data.page_context || '', data.sources_json || '[]', data.created_at || new Date().toISOString()]
    );
    return result.id;
  },
  async getStats(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const total = await get('SELECT COUNT(*) as count FROM ai_chat_logs WHERE created_at >= ?', [since.toISOString()]);
    const highConf = await get('SELECT COUNT(*) as count FROM ai_chat_logs WHERE confidence = ? AND created_at >= ?', ['high', since.toISOString()]);
    return { total: total ? total.count : 0, highConfidence: highConf ? highConf.count : 0 };
  }
};

// ============================================
// CRUD: AI FEEDBACK
// ============================================
const AIFeedback = {
  async getAll(limit = 100) {
    return all('SELECT * FROM ai_feedback ORDER BY created_at DESC LIMIT ?', [limit]);
  },
  async create(data) {
    const result = await run(
      'INSERT INTO ai_feedback (chat_log_id, feedback, user_id, notes, created_at) VALUES (?, ?, ?, ?, ?);',
      [data.chat_log_id, data.feedback, data.user_id || null, data.notes || '', data.created_at || new Date().toISOString()]
    );
    return result.id;
  },
  async getStats(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const positive = await get('SELECT COUNT(*) as count FROM ai_feedback WHERE feedback = ? AND created_at >= ?', ['positive', since.toISOString()]);
    const negative = await get('SELECT COUNT(*) as count FROM ai_feedback WHERE feedback = ? AND created_at >= ?', ['negative', since.toISOString()]);
    return { positive: positive ? positive.count : 0, negative: negative ? negative.count : 0 };
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
  await runMigrations();
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
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
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
  LeaveRequests,
  ShiftScheduleAuto,
  StaffingAlerts,
  Notifications,
  ShiftCompletions,
  AuditLog,
  ShiftForms,
  KBDocuments,
  KBChunks,
  KBChatSessions,
  KBChatMessages,
  KBQueries,
  KBChatHistory,
  AIKnowledgeChunks,
  AIUnansweredQuestions,
  AIChatLogs,
  AIFeedback,

  // Chat
  ChatConversations,
  ChatParticipants,
  ChatMessages,
  ChatMessageReads,
  ChatAttachments,

  // Migration
  migrateAll
};
