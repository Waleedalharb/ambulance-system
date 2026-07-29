const Database = require('better-sqlite3');
const fs = require('fs').promises;
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================
// مصدر الحقيقة الوحيد للتخزين الدائم: RENDER_DISK_PATH (قرص /data على Render)
// أو DATA_DIR، وإلا مجلد data/ المحلي. قاعدة SQLite يجب أن تعيش تحته حتى تنجو
// من إعادة النشر وإعادة التشغيل (الجذر الذي كان يمسح البيانات: القاعدة كانت
// في جذر المشروع = نظام ملفات مؤقت على Render).
const STORAGE_PATH = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');
const LEGACY_DB_PATH = path.join(__dirname, 'database.db');
const DB_PATH = process.env.DB_PATH || path.join(STORAGE_PATH, 'ambulance.db');
const DATA_DIR = STORAGE_PATH;
const OPS_UPLOAD_DIR = path.join(DATA_DIR, 'uploads', 'operational');
const OPS_METADATA_PATH = path.join(OPS_UPLOAD_DIR, 'metadata.json');
const fsSync = require('fs');

// ترحيل لمرة واحدة: إن وُجدت القاعدة القديمة في جذر المشروع والهدف الجديد
// غائب أو فارغ (0 بايت) تُنقل القاعدة الحية إلى موقع التخزين الدائم.
// لا يعمل عند تعيين DB_PATH صراحة (عزل الاختبارات يبقى كما هو).
function migrateLegacyDbIfNeeded() {
  if (process.env.DB_PATH) return;
  if (DB_PATH === LEGACY_DB_PATH) return;
  try {
    if (!fsSync.existsSync(LEGACY_DB_PATH)) return;
    const targetMissing = !fsSync.existsSync(DB_PATH);
    const targetEmpty = !targetMissing && fsSync.statSync(DB_PATH).size === 0;
    if (!targetMissing && !targetEmpty) return;
    fsSync.mkdirSync(STORAGE_PATH, { recursive: true });
    // Checkpoint للـ WAL حتى تكون النسخة مكتملة في الملف الرئيسي
    try {
      const legacy = new Database(LEGACY_DB_PATH);
      legacy.pragma('wal_checkpoint(TRUNCATE)');
      legacy.close();
    } catch (chkErr) {
      logger.warn(`Legacy checkpoint skipped: ${chkErr.message}`);
    }
    fsSync.copyFileSync(LEGACY_DB_PATH, DB_PATH);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const stale = DB_PATH + suffix;
      if (fsSync.existsSync(stale)) fsSync.unlinkSync(stale);
    }
    logger.info(`Migrated legacy database ${LEGACY_DB_PATH} -> ${DB_PATH}`);
  } catch (err) {
    logger.error('Legacy DB migration failed (continuing with target path)', err);
  }
}

// ============================================
// LOGGER
// ============================================
const logger = {
  info: (msg) => console.log(`[DB] ${new Date().toISOString()} INFO: ${msg}`),
  error: (msg, err) => console.error(`[DB] ${new Date().toISOString()} ERROR: ${msg}`, err ? (err.message || err) : ''),
  warn: (msg) => console.warn(`[DB] ${new Date().toISOString()} WARN: ${msg}`),
  debug: (msg) => console.log(`[DB] ${new Date().toISOString()} DEBUG: ${msg}`),
};

// ============================================
// DATABASE CONNECTION
// ============================================
let db = null;

async function openDb() {
  try {
    migrateLegacyDbIfNeeded();
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
    is_active INTEGER DEFAULT 1,
    requiredPersonnel INTEGER DEFAULT 2
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

  // ─── W1-A: Operational Event Log (السجل التشغيلي الموحّد — append-only) ───
  // الأصل الوحيد لحالات الأفراد والمركبات؛ لا UPDATE/DELETE إطلاقًا.
  // الختم (shift_id/date/type/actor/created_at) سيرفري دائمًا.
  // V-A: shift_id/date/type nullable — أحداث تأسيس الأصول (initial_seed) تُزرع
  // بلا مناوبة (قرار المالك 2 في ملحق V-A). القواعد القديمة تُرحَّل في runMigrations.
  `CREATE TABLE IF NOT EXISTS operational_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER,
    shift_date TEXT,
    shift_type TEXT,
    domain TEXT NOT NULL CHECK(domain IN ('staffing', 'vehicle', 'center', 'logistics')),
    entity_id TEXT,
    entity_name TEXT,
    team_id TEXT,
    center TEXT,
    event_type TEXT NOT NULL,
    status TEXT,
    reason TEXT,
    readiness_basis TEXT,
    corrects_event_id INTEGER,
    payload TEXT,
    note TEXT,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,

  // W1-A: لقطات إغلاق المناوبة الثابتة (تُكتب مرة واحدة عند الأرشفة — W1-E)
  `CREATE TABLE IF NOT EXISTS operational_shift_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL,
    domain TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    events_hash TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(shift_id, domain)
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
  );`,

  // Auth: Token Blacklist (session lifecycle — revocation)
  `CREATE TABLE IF NOT EXISTS token_blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,
    token_type TEXT DEFAULT 'access',
    user_id TEXT,
    session_id INTEGER,
    reason TEXT,
    blacklisted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  );`,

  // Auth: Sessions (session lifecycle — tracking & revocation)
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    role TEXT,
    access_token_hash TEXT,
    refresh_token_hash TEXT,
    ip_address TEXT,
    user_agent TEXT,
    session_start DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
    session_expires DATETIME,
    refresh_expires DATETIME,
    is_active INTEGER DEFAULT 1,
    logout_time DATETIME,
    logout_reason TEXT
  );`,

  // Auth: Logs (login/logout/refresh audit trail)
  `CREATE TABLE IF NOT EXISTS auth_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    username TEXT,
    action_type TEXT NOT NULL,
    action_detail TEXT,
    ip_address TEXT,
    user_agent TEXT,
    session_id INTEGER,
    success INTEGER DEFAULT 1,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // ── Server-referenced tables (schemas extracted verbatim from the
  // production database; the server reads them via raw SQL and previously
  // only production had them — fresh databases failed on these endpoints) ──
  `CREATE TABLE IF NOT EXISTS shift_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER REFERENCES shifts(id) ON DELETE CASCADE,
    alert_type TEXT NOT NULL CHECK(alert_type IN ('high_pending', 'low_completion', 'staff_shortage', 'workload_spike', 'closure_delay', 'repeated_notes')),
    severity TEXT DEFAULT 'warning' CHECK(severity IN ('info', 'warning', 'critical')),
    message TEXT NOT NULL,
    suggested_reason TEXT,
    is_acknowledged INTEGER DEFAULT 0,
    acknowledged_by TEXT,
    acknowledged_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_audit_trail (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL CHECK(action_type IN ('created', 'modified', 'reviewed', 'approved', 'deleted', 'data_added', 'data_updated', 'export', 'alert_acked')),
    actor_id TEXT NOT NULL,
    actor_name TEXT,
    actor_role TEXT,
    action_detail TEXT,
    old_data TEXT,
    new_data TEXT,
    ip_address TEXT,
    user_agent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    total_reports INTEGER DEFAULT 0,
    completed_reports INTEGER DEFAULT 0,
    pending_reports INTEGER DEFAULT 0,
    suspended_reports INTEGER DEFAULT 0,
    total_completions INTEGER DEFAULT 0,
    total_forms INTEGER DEFAULT 0,
    staff_count INTEGER DEFAULT 0,
    team_count INTEGER DEFAULT 0,
    vehicle_count INTEGER DEFAULT 0,
    completion_rate REAL DEFAULT 0,
    avg_response_time REAL DEFAULT 0,
    avg_closure_time REAL DEFAULT 0,
    critical_cases INTEGER DEFAULT 0,
    health_score REAL DEFAULT 0,
    data_completeness REAL DEFAULT 0,
    notes_count INTEGER DEFAULT 0,
    event_count INTEGER DEFAULT 0,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_timeline_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK(event_type IN ('start', 'team_checkin', 'report_received', 'report_completed', 'shift_change', 'form_filed', 'note_added', 'alert_triggered', 'peak_mission', 'end')),
    event_title TEXT NOT NULL,
    event_description TEXT,
    event_data TEXT,
    event_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_by TEXT,
    created_by_name TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS shift_kpi_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    total_shifts INTEGER DEFAULT 0,
    total_reports INTEGER DEFAULT 0,
    completed_reports INTEGER DEFAULT 0,
    open_reports INTEGER DEFAULT 0,
    suspended_reports INTEGER DEFAULT 0,
    total_staff INTEGER DEFAULT 0,
    total_teams INTEGER DEFAULT 0,
    total_vehicles INTEGER DEFAULT 0,
    completion_rate REAL DEFAULT 0,
    avg_response_time REAL DEFAULT 0,
    avg_closure_time REAL DEFAULT 0,
    top_center TEXT,
    top_report_type TEXT,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_kpi_weekly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL,
    week_end TEXT NOT NULL,
    total_shifts INTEGER DEFAULT 0,
    total_reports INTEGER DEFAULT 0,
    avg_daily_reports REAL DEFAULT 0,
    peak_day TEXT,
    peak_day_count INTEGER DEFAULT 0,
    lowest_day TEXT,
    lowest_day_count INTEGER DEFAULT 0,
    completion_rate REAL DEFAULT 0,
    total_operating_hours REAL DEFAULT 0,
    total_staff INTEGER DEFAULT 0,
    total_teams INTEGER DEFAULT 0,
    total_vehicles INTEGER DEFAULT 0,
    avg_staff_per_shift REAL DEFAULT 0,
    comparison_last_week REAL DEFAULT 0,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_kpi_monthly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    total_shifts INTEGER DEFAULT 0,
    total_reports INTEGER DEFAULT 0,
    total_operating_hours REAL DEFAULT 0,
    total_staff INTEGER DEFAULT 0,
    total_teams INTEGER DEFAULT 0,
    total_vehicles INTEGER DEFAULT 0,
    morning_shifts INTEGER DEFAULT 0,
    night_shifts INTEGER DEFAULT 0,
    completion_rate REAL DEFAULT 0,
    avg_performance REAL DEFAULT 0,
    comparison_last_month REAL DEFAULT 0,
    comparison_chart_data TEXT,
    calculated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_comparison_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    comparison_name TEXT,
    shift_a_id INTEGER NOT NULL,
    shift_b_id INTEGER NOT NULL,
    shift_a_date TEXT,
    shift_b_date TEXT,
    comparison_data TEXT NOT NULL,
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_reports_generated (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_type TEXT NOT NULL CHECK(report_type IN ('daily', 'weekly', 'monthly', 'shift_detail')),
    report_date_from TEXT,
    report_date_to TEXT,
    shift_id INTEGER,
    report_data TEXT,
    file_path TEXT,
    file_format TEXT DEFAULT 'pdf',
    generated_by TEXT,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_roster_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_data_json TEXT NOT NULL,
    operation_type TEXT DEFAULT 'edit' CHECK(operation_type IN ('edit', 'swap', 'bulk', 'delete', 'add')),
    created_by TEXT NOT NULL,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    applied_at DATETIME,
    reverted_at DATETIME
  );`,
  `CREATE TABLE IF NOT EXISTS notification_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    notification_type TEXT DEFAULT 'shift_change' CHECK(notification_type IN ('shift_change', 'system', 'alert')),
    recipient_id INTEGER NOT NULL,
    recipient_name TEXT,
    recipient_phone TEXT,
    message TEXT NOT NULL,
    channel TEXT DEFAULT 'in-app' CHECK(channel IN ('in-app', 'whatsapp', 'sms', 'email')),
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'delivered', 'failed', 'read')),
    roster_id INTEGER,
    shift_date TEXT,
    old_value TEXT,
    new_value TEXT,
    sent_at DATETIME,
    delivered_at DATETIME,
    opened_at DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,
  `CREATE TABLE IF NOT EXISTS shift_change_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roster_id INTEGER,
    employee_id INTEGER NOT NULL,
    team_id INTEGER,
    shift_date TEXT NOT NULL,
    proposed_shift_code TEXT NOT NULL,
    old_shift_code TEXT,
    requested_by TEXT NOT NULL,
    requested_by_name TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'cancelled')),
    reason TEXT,
    reviewed_by TEXT,
    reviewed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`,

  // D-05: shift_audit_log — exists in production (schema below copied
  // verbatim from the production sqlite_master entry) but was never created
  // by code, so fresh databases lacked it. CREATE TABLE IF NOT EXISTS never
  // touches the existing production table.
  `CREATE TABLE IF NOT EXISTS shift_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roster_id INTEGER,
    employee_id INTEGER,
    team_id INTEGER,
    shift_date TEXT NOT NULL,
    old_shift_code TEXT,
    new_shift_code TEXT,
    old_team_id INTEGER,
    new_team_id INTEGER,
    changed_by TEXT NOT NULL,
    changed_by_name TEXT,
    change_type TEXT DEFAULT 'edit' CHECK(change_type IN ('edit', 'swap', 'bulk', 'delete', 'add')),
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    await exec(`CREATE INDEX IF NOT EXISTS idx_op_events_shift ON operational_events(shift_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_op_events_entity ON operational_events(domain, entity_id, created_at);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_op_events_shift_domain ON operational_events(shift_id, domain);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_op_events_corrects ON operational_events(corrects_event_id);`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_op_snapshots_shift ON operational_shift_snapshots(shift_id);`);
    // V-A: جدولا vehicles القديم (W1-D) والتوليد الذاتي من teams أُزيلا من هنا —
    // إعادة البناء بالمخطط الجديد (v9) + زرع السجل الرسمي تتم في runMigrations
    // عبر migrateFleetVA() (كشف PRAGMA + foreign_keys=OFF + معاملة).
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
  await ensureOperationalTeams();
  logger.info('All tables initialized successfully');
}

// ============================================
// MIGRATION HELPER: idempotent, per-column ensure.
// Reads PRAGMA table_info instead of matching error text, so one failing
// ALTER can never skip the remaining columns in the same migration block.
// ============================================
async function ensureColumn(table, column, definition) {
  try {
    const cols = await all(`PRAGMA table_info(${table})`);
    if (cols.some(c => c.name === column)) {
      logger.debug(`Column already present, skipping: ${table}.${column}`);
      return false;
    }
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    logger.info(`Added column: ${table}.${column} ${definition}`);
    return true;
  } catch (err) {
    logger.warn(`ensureColumn ${table}.${column}: ${err.message}`);
    return false;
  }
}

// ============================================
// MIGRATIONS: Add shift_id columns & new tables
// ============================================
async function runMigrations() {
  logger.info('Running database migrations...');

  // Add shift_id columns to existing tables (backward-compatible)
  // F3: report_times.type — single source for type breakdowns
  await ensureColumn('reports', 'shift_id', 'INTEGER REFERENCES shifts(id) ON DELETE SET NULL');
  await ensureColumn('shift_completions', 'shift_id', 'INTEGER REFERENCES shifts(id) ON DELETE CASCADE');
  await ensureColumn('ops_files', 'shift_id', 'INTEGER REFERENCES shifts(id) ON DELETE SET NULL');
  await ensureColumn('timeline', 'shift_id', 'INTEGER REFERENCES shifts(id) ON DELETE SET NULL');
  await ensureColumn('announcements', 'shift_id', 'INTEGER REFERENCES shifts(id) ON DELETE SET NULL');
  await ensureColumn('report_times', 'type', 'TEXT');
  // VA: العدد المطلوب لجاهزية الفرقة — يُشتق منه النقص/الجاهزية سيرفريًا (idempotent)
  await ensureColumn('teams', 'requiredPersonnel', 'INTEGER DEFAULT 2');
  // W-تكامل ③ب: الرمز الأساسي للموظف من الجدولة الرسمية (O12A/O14B/D0…)
  // مفتاح تجميع أطقم الأوفرلاب لاشتقاق الفرق الديناميكية — بيانات وصفية فقط (idempotent)
  await ensureColumn('employees', 'symbol', 'TEXT');

  // F4: drop the dead daily_reports store (derived daily report replaces it)
  try {
    await exec(`DROP TABLE IF EXISTS daily_reports`);
    logger.info('daily_reports table dropped (dead store cleanup)');
  } catch (err) {
    logger.warn('daily_reports drop warning: ' + err.message);
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
  await ensureColumn('shifts', 'status', `TEXT DEFAULT 'active' CHECK(status IN ('active', 'pending_handover', 'archived'))`);
  await ensureColumn('shifts', 'archived_at', 'DATETIME');

  // Add created_at/updated_at/end_time columns to shifts (required by
  // StorageAdapter — endShift writes end_time; previously only databases
  // touched by the manual migrate-shifts-table.js script had it)
  await ensureColumn('shifts', 'created_at', 'DATETIME');
  await ensureColumn('shifts', 'updated_at', 'DATETIME');
  await ensureColumn('shifts', 'end_time', 'DATETIME');

  // Rebuild shifts table when a legacy CHECK constraint blocks the current
  // lifecycle states (e.g. CHECK(status IN ('active','archived','closed'))).
  // SQLite cannot alter a CHECK constraint, so the table is rebuilt with the
  // same columns and the canonical CHECK: active / pending_handover / archived.
  try {
    const tableRow = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shifts'`);
    if (tableRow && tableRow.sql && !tableRow.sql.includes('pending_handover')) {
      logger.info('Rebuilding shifts table: legacy status CHECK constraint detected');
      const cols = await all(`PRAGMA table_info(shifts)`);
      const colNames = cols.map(c => c.name);
      const colDefs = cols.map(c => {
        if (c.name === 'id') return 'id INTEGER PRIMARY KEY AUTOINCREMENT';
        if (c.name === 'status') return `status TEXT DEFAULT 'active' CHECK(status IN ('active', 'pending_handover', 'archived'))`;
        const type = c.type || 'TEXT';
        const notNull = c.notnull ? ' NOT NULL' : '';
        const dflt = (c.dflt_value !== null && c.dflt_value !== undefined) ? ` DEFAULT ${c.dflt_value}` : '';
        return `${c.name} ${type}${notNull}${dflt}`;
      });
      // FK pragma cannot change inside a transaction — disable before BEGIN
      db.pragma('foreign_keys = OFF');
      beginTransaction();
      try {
        await exec(`CREATE TABLE shifts_new (${colDefs.join(', ')})`);
        // Map any legacy 'closed' status to 'archived' during the copy
        const selectCols = colNames.map(n => n === 'status' ? `CASE WHEN status = 'closed' THEN 'archived' ELSE status END` : n).join(', ');
        await exec(`INSERT INTO shifts_new (${colNames.join(', ')}) SELECT ${selectCols} FROM shifts`);
        await exec(`DROP TABLE shifts`);
        await exec(`ALTER TABLE shifts_new RENAME TO shifts`);
        commitTransaction();
        db.pragma('foreign_keys = ON');
        logger.info('shifts table rebuilt with canonical status CHECK constraint');
      } catch (rebuildErr) {
        rollbackTransaction();
        db.pragma('foreign_keys = ON');
        throw rebuildErr;
      }
    }
  } catch (err) {
    logger.warn('shifts CHECK rebuild migration: ' + err.message);
  }

  // V-A: rebuild operational_events when a legacy NOT NULL on shift_id/date/type
  // blocks NULL-stamped asset seed events (owner decision: initial_seed events
  // carry shift_id = NULL). Rows are preserved verbatim; same rebuild pattern
  // as shifts above (foreign_keys OFF + single transaction). New databases get
  // the nullable DDL from TABLE_SCHEMAS directly and skip this.
  try {
    const oeRow = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operational_events'`);
    if (oeRow && oeRow.sql && oeRow.sql.includes('shift_id INTEGER NOT NULL')) {
      logger.info('Rebuilding operational_events: legacy NOT NULL shift stamp detected');
      db.pragma('foreign_keys = OFF');
      beginTransaction();
      try {
        await exec(`CREATE TABLE operational_events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shift_id INTEGER,
          shift_date TEXT,
          shift_type TEXT,
          domain TEXT NOT NULL CHECK(domain IN ('staffing', 'vehicle', 'center', 'logistics')),
          entity_id TEXT,
          entity_name TEXT,
          team_id TEXT,
          center TEXT,
          event_type TEXT NOT NULL,
          status TEXT,
          reason TEXT,
          readiness_basis TEXT,
          corrects_event_id INTEGER,
          payload TEXT,
          note TEXT,
          actor_id TEXT NOT NULL,
          actor_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        )`);
        await exec(`INSERT INTO operational_events_new
          (id, shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center,
           event_type, status, reason, readiness_basis, corrects_event_id, payload, note,
           actor_id, actor_name, created_at)
          SELECT id, shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center,
           event_type, status, reason, readiness_basis, corrects_event_id, payload, note,
           actor_id, actor_name, created_at FROM operational_events`);
        await exec(`DROP TABLE operational_events`);
        await exec(`ALTER TABLE operational_events_new RENAME TO operational_events`);
        commitTransaction();
        db.pragma('foreign_keys = ON');
        logger.info('operational_events rebuilt with nullable shift stamp');
      } catch (oeErr) {
        rollbackTransaction();
        db.pragma('foreign_keys = ON');
        throw oeErr;
      }
    }
  } catch (err) {
    logger.warn('operational_events nullable-stamp rebuild: ' + err.message);
  }

  // Reconcile legacy JSON shifts into SQLite (X2 single-source adoption):
  // any shift present only in shift-data.json is inserted preserving its id.
  // JSON-only stubs with status 'active' are inserted as 'archived' — the
  // domain allows one ACTIVE shift and newer shifts already started after
  // them (auto-archive rule). Existing ids are never touched (content was
  // verified identical at adoption time: 17/17 equal).
  try {
    const shiftsJsonPath = path.join(
      process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, 'data'),
      'shift-data.json'
    );
    const raw = await fs.readFile(shiftsJsonPath, 'utf8').catch(() => null);
    if (raw) {
      const jsonShifts = JSON.parse(raw);
      let inserted = 0;
      for (const js of jsonShifts) {
        if (!js || js.id == null) continue;
        const exists = await get('SELECT id FROM shifts WHERE id = ?', [js.id]);
        if (exists) continue;
        const status = js.status === 'active' ? 'archived' : (js.status || 'archived');
        await run(
          `INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, shift_day, start_time,
           total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update, status, archived_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            js.id, js.shiftName || '', js.shiftDate || '', js.shiftTime || '', js.shiftType || '',
            js.shiftDay || '', js.startTime || '', js.totalReports || 0,
            JSON.stringify(js.rapidLocations || {}), JSON.stringify(js.centersData || {}),
            JSON.stringify(js.vehicleData || {}), JSON.stringify(js.fuelData || {}),
            js.generalNotes || '', js.lastUpdate || null, status,
            js.archivedAt || (status === 'archived' ? new Date().toISOString() : null)
          ]
        );
        inserted++;
      }
      if (inserted > 0) logger.info(`Reconciled ${inserted} JSON-only shift(s) into SQLite (as archived)`);
    }
  } catch (err) {
    logger.warn('JSON shifts reconciliation: ' + err.message);
  }

  // ── Archive slice: unified tables for shift operational content (X2 pattern) ──
  // Content previously split across JSON files. shift_id has no REFERENCES
  // clause on purpose: archived content must survive an admin hard-delete of
  // its parent shift (audit safety). Rows are keyed by their legacy string ids.
  const contentTables = ['shift_notes', 'shift_events', 'shift_absences', 'peak_plans', 'report_entries'];
  for (const t of contentTables) {
    try {
      await exec(`CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        shift_id INTEGER,
        data TEXT NOT NULL DEFAULT '{}',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      await exec(`CREATE INDEX IF NOT EXISTS idx_${t}_shift ON ${t}(shift_id)`);
    } catch (err) {
      logger.warn(`${t} table creation: ` + err.message);
    }
  }

  // Archive slice: seal blobs. The table predates this slice in real
  // databases (REFERENCES shifts + CHECK on snapshot_type) but nothing ever
  // wrote to it — the engine now inserts one row per seal and the
  // snapshot/integrity endpoints read the latest by shift_id.
  try {
    await exec(`CREATE TABLE IF NOT EXISTS shift_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      snapshot_data TEXT NOT NULL,
      snapshot_type TEXT DEFAULT 'auto' CHECK(snapshot_type IN ('auto', 'manual', 'pre_archive')),
      snapshot_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shift_snapshots_shift ON shift_snapshots(shift_id)`);
  } catch (err) {
    logger.warn('shift_snapshots table creation: ' + err.message);
  }
  // Real databases predate the snapshot_hash column — add it idempotently.
  await ensureColumn('shift_snapshots', 'snapshot_hash', 'TEXT');

  // Explicit Shift↔Conversation link (Archive Contract §5, owner decision):
  // NULL = general conversation, never archived.
  await ensureColumn('chat_conversations', 'shift_id', 'INTEGER');
  try {
    await exec(`CREATE INDEX IF NOT EXISTS idx_chat_conv_shift ON chat_conversations(shift_id)`);
  } catch (err) { /* index is best-effort */ }

  // One-time idempotent reconcile of the legacy JSON stores into their tables
  const jsonStoreReconciles = [
    ['shift-notes.json', 'shift_notes', true],
    ['shift-events.json', 'shift_events', true],
    ['shift-absences.json', 'shift_absences', true],
    ['peak-plans.json', 'peak_plans', false],
    ['report-entry.json', 'report_entries', false]
  ];
  for (const [file, table, hasShiftId] of jsonStoreReconciles) {
    try {
      const p = path.join(
        process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, 'data'),
        file
      );
      const raw = await fs.readFile(p, 'utf8').catch(() => null);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      let n = 0;
      for (const item of arr) {
        if (!item || item.id == null) continue;
        const id = String(item.id);
        const exists = await get(`SELECT id FROM ${table} WHERE id = ?`, [id]);
        if (exists) continue;
        const shiftId = hasShiftId ? (item.shiftId != null ? item.shiftId : null) : null;
        await run(`INSERT INTO ${table} (id, shift_id, data) VALUES (?, ?, ?)`, [id, shiftId, JSON.stringify(item)]);
        n++;
      }
      if (n > 0) logger.info(`Reconciled ${n} row(s) from ${file} into ${table}`);
    } catch (err) {
      logger.warn(`${file} reconciliation: ` + err.message);
    }
  }

  // Slice 6: one-time idempotent reconcile of the six legacy form JSON stores
  // into shift_forms (form_name = form_type, form_id = legacy string id).
  // Legacy records carried no shift context → shift_id NULL (same rule as the
  // other reconciles). Rows are inserted oldest-first so AUTOINCREMENT id DESC
  // keeps the legacy unshift (newest-first) display order.
  const formReconciles = [
    ['incidents.json', 'incident'],
    ['senior-shifts.json', 'senior_shift'],
    ['e-cases.json', 'e_case'],
    ['escalations.json', 'escalation'],
    ['daily-reports.json', 'daily_report'],
    ['air-ambulance.json', 'air_ambulance']
  ];
  for (const [file, formType] of formReconciles) {
    try {
      const p = path.join(
        process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, 'data'),
        file
      );
      const raw = await fs.readFile(p, 'utf8').catch(() => null);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) continue;
      let n = 0;
      for (const item of [...arr].reverse()) {
        if (!item || item.id == null) continue;
        const id = String(item.id);
        const exists = await get('SELECT id FROM shift_forms WHERE form_name = ? AND form_id = ?', [formType, id]);
        if (exists) continue;
        await run('INSERT INTO shift_forms (shift_id, form_id, form_name, form_data, created_by) VALUES (?, ?, ?, ?, ?)',
          [item.shiftId != null ? item.shiftId : null, id, formType, JSON.stringify(item), null]);
        n++;
      }
      if (n > 0) logger.info(`Reconciled ${n} form(s) from ${file} into shift_forms (${formType})`);
    } catch (err) {
      logger.warn(`${file} form reconciliation: ` + err.message);
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

  // KB migrations: add columns to existing kb_documents for backward compatibility
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
    await ensureColumn('kb_documents', col.name, `${col.type}${col.default ? ' DEFAULT ' + col.default : ''}`);
  }

  // KB migrations: add doc_id to kb_chunks
  await ensureColumn('kb_chunks', 'doc_id', 'INTEGER REFERENCES kb_documents(id) ON DELETE CASCADE');

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

  // V-A: المراكز + إعادة بناء الأسطول v9 + زرع السجل الرسمي + أحداث الافتتاح
  // + تصحيح مركزَي سريع 3/4 (C7) + system_metadata — كلها idempotent.
  await migrateFleetVA();

  // ضمان الفرق التشغيلية المستقلة بعد اكتمال الأعمدة (يتقارب في إقلاع واحد
  // حتى للقواعد القديمة التي ينقصها عمود requiredPersonnel قبل runMigrations)
  await ensureOperationalTeams();
  // سيارة الصيانة المتنقلة لفرقة الدعم اللوجستي (قرار المالك 2026-07-27)
  await ensureLogisticsVehicleAssignment();

  logger.info('Migrations complete');
}

// ============================================
// V-A: FLEET REBUILD (v9) — centers + vehicles + system_metadata + seed events
// المصدر الملزم: VEHICLE-REDESIGN-PROPOSAL.md §1 (السجل الرسمي) + §2 (المخطط)
// وقرارات المالك في ملحق V-A-DISCOVERY-REPORT.md.
// ============================================
const FLEET_SEED_AT = '2026-07-21T08:00:00.000Z'; // تاريخ السجل الرسمي (حتمي ومستقر)

// السجل الرسمي §1 حرفيًا (26 مركبة: veh_000001..veh_000026 — عنوان الوثيقة
// يقول 27 لكن الصفوف المعتمدة 26 فقط؛ لا مركبة لجنوب 11 بقرار C3).
// designation: 'نقطة دائمة' / 'نقطة مؤقتة' (§2.2) • ownerCenter بإملاء teams.center
// الرسمي ('الشفاء') • veh_000018 مالكها «فرقة الصيانة المتنقلة» وليس مركزًا ⇒ NULL.
const FLEET_ROSTER = [
  { id: 'veh_000001', callSign: 'جنوب 1', plate: '8572 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'المنصورة' },
  { id: 'veh_000002', callSign: 'جنوب 2', plate: '8565 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الخالدية' },
  { id: 'veh_000003', callSign: 'جنوب 3', plate: '8561 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'منفوحة' },
  { id: 'veh_000004', callSign: 'جنوب 4', plate: '8905 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الدار البيضاء' },
  { id: 'veh_000005', callSign: 'جنوب 5', plate: '8912 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الدار البيضاء' },
  { id: 'veh_000006', callSign: 'جنوب 6', plate: '8901 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الإسكان' },
  { id: 'veh_000007', callSign: 'جنوب 7', plate: '8578 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الحائر' },
  { id: 'veh_000008', callSign: 'جنوب 8', plate: '8904 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الشفاء' },
  { id: 'veh_000009', callSign: 'جنوب 9', plate: '8560 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'عكاظ' },
  { id: 'veh_000010', callSign: 'جنوب 10', plate: '8069 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'ديراب' },
  { id: 'veh_000011', callSign: 'جنوب 12', plate: '8913 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'أساسية', ownerCenter: 'الشفاء' },
  { id: 'veh_000012', callSign: 'جنوب 13', plate: '8902 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'أساسية', ownerCenter: 'عكاظ' },
  { id: 'veh_000013', callSign: 'جنوب 14', plate: '8579 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'أساسية', ownerCenter: 'الإسكان' },
  { id: 'veh_000014', callSign: 'سريع 1', plate: '9783 ر هـ ع', type: 'تاهو', year: 2023, category: 'تدخل سريع', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الدار البيضاء' },
  { id: 'veh_000015', callSign: 'سريع 2', plate: '3066 ر هـ ص', type: 'تاهو', year: 2023, category: 'تدخل سريع', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الشفاء' },
  { id: 'veh_000016', callSign: 'سريع 3', plate: '1009 ح ص ح', type: 'فورتشنر', year: 2014, category: 'تدخل سريع', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'الخالدية' },
  { id: 'veh_000017', callSign: 'سريع 4', plate: '1989 ح ص ح', type: 'سكوبيا', year: 2016, category: 'تدخل سريع', designation: 'نقطة دائمة', adminStatus: 'أساسية', ownerCenter: 'المنصورة' },
  { id: 'veh_000018', callSign: 'صيانة متنقلة', plate: '6118 ب ا ي', type: 'سفانا', year: 2015, category: 'سيارة خدمة', designation: 'نقطة دائمة', adminStatus: 'خدمة', ownerCenter: null },
  { id: 'veh_000019', callSign: 'احتياط', plate: '8564 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000020', callSign: 'احتياط', plate: '8569 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000021', callSign: 'احتياط', plate: '8907 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000022', callSign: 'احتياط', plate: '8395 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000023', callSign: 'احتياط', plate: '8906 س ح ص', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000024', callSign: 'احتياط', plate: '4794 ب ق ك', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000025', callSign: 'احتياط', plate: '4959 ب ق و', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' },
  { id: 'veh_000026', callSign: 'احتياط', plate: '4962 ب ق و', type: 'فورد', year: 2024, category: 'إسعاف', designation: 'نقطة مؤقتة', adminStatus: 'احتياط', ownerCenter: 'المنصورة' }
];

// التعيينات الافتتاحية: مركبات النقاط الدائمة الـ14 بفرقها المطابقة فقط
// (قرار المالك 1: صفر تغيير مرئي — الأوفر لاب/الصيانة/الاحتياط بلا تعيين).
const FLEET_OPENING_ASSIGNMENTS = {
  veh_000001: 'جنوب 1', veh_000002: 'جنوب 2', veh_000003: 'جنوب 3', veh_000004: 'جنوب 4',
  veh_000005: 'جنوب 5', veh_000006: 'جنوب 6', veh_000007: 'جنوب 7', veh_000008: 'جنوب 8',
  veh_000009: 'جنوب 9', veh_000010: 'جنوب 10',
  veh_000014: 'سريع 1', veh_000015: 'سريع 2', veh_000016: 'سريع 3', veh_000017: 'سريع 4',
  // قرار المالك 2026-07-27: سيارة الصيانة المتنقلة هي سيارة فرقة الدعم اللوجستي
  veh_000018: 'الدعم اللوجستي'
};

// slugs ثابتة للمراكز التسعة (المفاتيح بإملاء teams.center الرسمي)
const CENTER_SLUGS = {
  'المنصورة': 'ctr_mansoura',
  'الخالدية': 'ctr_khaldiya',
  'منفوحة': 'ctr_manfouha',
  'الدار البيضاء': 'ctr_dar_albayda',
  'الإسكان': 'ctr_iskan',
  'الحائر': 'ctr_hair',
  'الشفاء': 'ctr_shifa',
  'عكاظ': 'ctr_okaz',
  'ديراب': 'ctr_dirab'
};
const CENTER_PREFERRED_ORDER = ['المنصورة', 'الخالدية', 'منفوحة', 'الدار البيضاء', 'الإسكان', 'الحائر', 'الشفاء', 'عكاظ', 'ديراب'];

const VEHICLES_DDL = `CREATE TABLE IF NOT EXISTS vehicles (
  id              TEXT PRIMARY KEY,
  plate_number    TEXT NOT NULL,
  call_sign       TEXT,
  vehicle_type    TEXT NOT NULL,
  model_year      INTEGER NOT NULL,
  category        TEXT NOT NULL,
  designation     TEXT NOT NULL,
  admin_status    TEXT NOT NULL DEFAULT 'أساسية',
  owner_center_id TEXT REFERENCES centers(id),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);`;

// ضمان تعيين سيارة الصيانة المتنقلة (veh_000018) لفرقة الدعم اللوجستي في القواعد
// القائمة (زرع الافتتاح V-A يعمل مرة واحدة فقط ولا يغطي القواعد المزروعة سلفًا).
// idempotent: لا يُدرج إن وُجد أي حدث تعيين سابق للمركبة. يُستدعى من runMigrations
// فقط (بعد وجود جدولَي vehicles وoperational_events وفريق الدعم اللوجستي).
async function ensureLogisticsVehicleAssignment() {
  try {
    const team = await get(`SELECT id, center FROM teams WHERE name = 'الدعم اللوجستي'`);
    if (!team) return;
    const existing = await get(`SELECT COUNT(*) AS c FROM operational_events WHERE domain = 'vehicle' AND entity_id = 'veh_000018' AND event_type = 'assignment'`);
    if (existing.c > 0) return;
    await run(
      `INSERT INTO operational_events
       (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center,
        event_type, status, reason, readiness_basis, corrects_event_id, payload, note,
        actor_id, actor_name, created_at)
       VALUES (NULL, NULL, NULL, 'vehicle', 'veh_000018', 'صيانة متنقلة', ?, ?, 'assignment',
        NULL, 'initial_seed', NULL, NULL, NULL, 'ensure: سيارة فرقة الدعم اللوجستي (قرار المالك 2026-07-27)', 'system', 'system-migration', ?)`,
      [String(team.id), team.center, FLEET_SEED_AT]
    );
    logger.info('Logistics vehicle assignment ensured: veh_000018 -> الدعم اللوجستي');
  } catch (err) {
    logger.error('ensureLogisticsVehicleAssignment failed', err);
  }
}

async function migrateFleetVA() {
  // ── C7: تصحيح مركزَي سريع 3/4 للقواعد القائمة (idempotent) ──
  await run(`UPDATE teams SET center = 'الخالدية' WHERE name = 'سريع 3' AND center = 'المنصورة'`);
  await run(`UPDATE teams SET center = 'المنصورة' WHERE name = 'سريع 4' AND center = 'الفرق الإضافية'`);

  // ── centers (§2.1): إنشاء + زرع المراكز التسعة من teams.center الفعلية ──
  await exec(`CREATE TABLE IF NOT EXISTS centers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
  );`);
  const centersCount = await get('SELECT COUNT(*) AS c FROM centers');
  if (centersCount.c === 0) {
    const distinct = await all(`SELECT DISTINCT center FROM teams WHERE center IS NOT NULL AND center <> 'الفرق الإضافية'`);
    const names = distinct.map(r => r.center);
    const ordered = CENTER_PREFERRED_ORDER.filter(n => names.includes(n))
      .concat(names.filter(n => !CENTER_PREFERRED_ORDER.includes(n)));
    for (let i = 0; i < ordered.length; i++) {
      const id = CENTER_SLUGS[ordered[i]] || ('ctr_center_' + (i + 1));
      await run('INSERT INTO centers (id, name, sort_order, is_active, created_at) VALUES (?, ?, ?, 1, ?)',
        [id, ordered[i], i + 1, FLEET_SEED_AT]);
    }
    logger.info(`Seeded ${ordered.length} centers (V-A)`);
  }

  // ── vehicles (§2.2): كشف الجدول القديم (بلا plate_number) وإعادة بنائه ──
  // الصفوف القديمة مولّدة ذاتيًا ومهملة ⇒ DROP + CREATE (نمط shifts: FK OFF + معاملة).
  const vCols = await all(`PRAGMA table_info(vehicles)`);
  if (vCols.length && !vCols.some(c => c.name === 'plate_number')) {
    logger.info('Rebuilding vehicles table: legacy W1-D schema detected (V-A)');
    db.pragma('foreign_keys = OFF');
    beginTransaction();
    try {
      await exec(`DROP TABLE vehicles`);
      await exec(VEHICLES_DDL);
      commitTransaction();
      db.pragma('foreign_keys = ON');
      logger.info('vehicles table rebuilt with v9 schema');
    } catch (rebuildErr) {
      rollbackTransaction();
      db.pragma('foreign_keys = ON');
      throw rebuildErr;
    }
  } else {
    await exec(VEHICLES_DDL);
  }

  // Fleet Engine V1 ②: عمود ملاحظات السجل المرجعي — إضافي وidempotent
  // (ensureColumn يقرأ PRAGMA table_info؛ آمن على القواعد القائمة والجديدة).
  await ensureColumn('vehicles', 'notes', 'TEXT');

  // ── زرع السجل الرسمي (فقط إذا كان الجدول فارغًا) ──
  const vehiclesCount = await get('SELECT COUNT(*) AS c FROM vehicles');
  if (vehiclesCount.c === 0) {
    const centerRows = await all('SELECT id, name FROM centers');
    const centerIdByName = new Map(centerRows.map(r => [r.name, r.id]));
    for (let i = 0; i < FLEET_ROSTER.length; i++) {
      const v = FLEET_ROSTER[i];
      const ownerId = v.ownerCenter ? (centerIdByName.get(v.ownerCenter) || null) : null;
      if (v.ownerCenter && !ownerId) {
        logger.warn(`V-A seed: owner center not found for ${v.id}: ${v.ownerCenter}`);
      }
      await run(`INSERT INTO vehicles
        (id, plate_number, call_sign, vehicle_type, model_year, category, designation, admin_status, owner_center_id, sort_order, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [v.id, v.plate, v.callSign, v.type, v.year, v.category, v.designation, v.adminStatus, ownerId, i + 1, FLEET_SEED_AT]);
    }
    logger.info(`Seeded ${FLEET_ROSTER.length} vehicles from official roster (V-A)`);
  }

  // ── system_metadata (قرار المالك 5): تتبع الهجرات ──
  await exec(`CREATE TABLE IF NOT EXISTS system_metadata (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT
  );`);
  const metaSeed = [['schema_version', '2'], ['fleet_schema', 'v9'], ['migration', 'V-A']];
  for (const [k, v] of metaSeed) {
    await run('INSERT OR IGNORE INTO system_metadata (key, value, updated_at) VALUES (?, ?, ?)', [k, v, FLEET_SEED_AT]);
  }

  // ── أحداث الافتتاح (قرار المالك 2): فقط عند غياب أي حدث vehicle سابق ──
  // زرع مباشر عبر طبقة التخزين (نفس أعمدة appendOperationalEvent) — لا عبر
  // VehicleEventsService لأنه يتطلب مناوبة نشطة. الختم: system/system-migration،
  // shift_* = NULL، created_at = تاريخ السجل الرسمي (حتمي).
  const vehEventCount = await get(`SELECT COUNT(*) AS c FROM operational_events WHERE domain = 'vehicle'`);
  if (vehEventCount.c === 0) {
    const teamRows = await all('SELECT id, name, center FROM teams');
    const teamByName = new Map(teamRows.map(t => [t.name, t]));
    const insertSeedEvent = async (e) => run(
      `INSERT INTO operational_events
       (shift_id, shift_date, shift_type, domain, entity_id, entity_name, team_id, center,
        event_type, status, reason, readiness_basis, corrects_event_id, payload, note,
        actor_id, actor_name, created_at)
       VALUES (NULL, NULL, NULL, 'vehicle', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 'V-A initial fleet seed', 'system', 'system-migration', ?)`,
      [e.entityId, e.entityName, e.teamId || null, e.center || null, e.eventType,
       e.status || null, e.reason || 'initial_seed', e.payload || null, FLEET_SEED_AT]
    );
    beginTransaction();
    try {
      // 1) دورة الحياة: acquired + entered_service لكل مركبة (52 حدثًا)
      for (const v of FLEET_ROSTER) {
        await insertSeedEvent({ entityId: v.id, entityName: v.callSign, eventType: 'acquired' });
        await insertSeedEvent({ entityId: v.id, entityName: v.callSign, eventType: 'entered_service' });
      }
      // 2) الحالة الرسمية: عطل لـ veh_000017 وveh_000019
      for (const id of ['veh_000017', 'veh_000019']) {
        const v = FLEET_ROSTER.find(r => r.id === id);
        await insertSeedEvent({ entityId: id, entityName: v.callSign, eventType: 'status_change', status: 'breakdown', reason: 'حالة السجل الرسمي 2026-07-21' });
      }
      // 3) طلبات صيانة مذكورة بالسجل: سريع 3 وسريع 4 (بانتظار التأكيد الميداني)
      for (const id of ['veh_000016', 'veh_000017']) {
        const v = FLEET_ROSTER.find(r => r.id === id);
        await insertSeedEvent({ entityId: id, entityName: v.callSign, eventType: 'maintenance_requested', payload: JSON.stringify({ source: 'migration', verified: false }) });
      }
      // 4) التعيينات الافتتاحية لمركبات النقاط الدائمة الـ14
      for (const [vehId, teamName] of Object.entries(FLEET_OPENING_ASSIGNMENTS)) {
        const team = teamByName.get(teamName);
        if (!team) { logger.warn(`V-A seed: team not found for assignment: ${teamName}`); continue; }
        const v = FLEET_ROSTER.find(r => r.id === vehId);
        await insertSeedEvent({ entityId: vehId, entityName: v.callSign, teamId: String(team.id), center: team.center, eventType: 'assignment' });
      }
      commitTransaction();
      const total = await get(`SELECT COUNT(*) AS c FROM operational_events WHERE domain = 'vehicle'`);
      logger.info(`Seeded ${total.c} opening vehicle events (V-A)`);
    } catch (seedErr) {
      rollbackTransaction();
      throw seedErr;
    }
  }
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
  { name: 'سريع 1', center: 'الدار البيضاء', team_type: 'سريع', sort_order: 101, requiredPersonnel: 1 },
  { name: 'سريع 2', center: 'الشفاء', team_type: 'سريع', sort_order: 102, requiredPersonnel: 1 },
  { name: 'سريع 3', center: 'الخالدية', team_type: 'سريع', sort_order: 103, requiredPersonnel: 1 },
  { name: 'سريع 4', center: 'المنصورة', team_type: 'سريع', sort_order: 104, requiredPersonnel: 1 },
  // فرق العمليات المستقلة (كانت تُضاف يدويًا لقاعدة الإنتاج فقط — غيابها عن الزرع
  // أسقط القيادة/التحكم/التنسيق من التكميل على أي قاعدة جديدة مثل Render)
  { name: 'القيادة الميدانية', center: 'العمليات', team_type: 'قيادة', sort_order: 0, requiredPersonnel: 2 },
  { name: 'التحكم العملياتي', center: 'العمليات', team_type: 'عمليات', sort_order: 0, requiredPersonnel: 1 },
  { name: 'تنسيق الاستجابة', center: 'العمليات', team_type: 'عمليات', sort_order: 0, requiredPersonnel: 1 },
  // قرار المالك 2026-07-27: الدعم اللوجستي فرقة تُحضَّر مثل سائر الفرق
  // (أكواد XY/AZ-DZ يحلّها القاموس أصلًا إلى هذا الاسم — كان ينقص وجود الفريق)
  { name: 'الدعم اللوجستي', center: 'العمليات', team_type: 'دعم', sort_order: 0, requiredPersonnel: 1 }
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
      await run('INSERT INTO teams (name, center, team_type, sort_order, is_active, requiredPersonnel) VALUES (?, ?, ?, ?, ?, ?);', [t.name, t.center, t.team_type, t.sort_order, 1, t.requiredPersonnel || 2]);
    }
    logger.info(`Seeded ${DEFAULT_TEAMS.length} teams`);
  } catch (err) {
    logger.error('Teams seeding failed', err);
  }
}

// ضمان الفرق التشغيلية المستقلة في القواعد القائمة (idempotent بالاسم):
// seedDefaultTeams يتخطى أي قاعدة فيها فرق، لذا قواعد مثل Render (23 فريقًا)
// بقيت بلا قيادة/تحكم/تنسيق — هذا الضمان يكملها. كما يوحّد requiredPersonnel
// للسريع = 1 (قاعدة المالك: شخص واحد لكل سيارة تدخل سريع).
const OPERATIONAL_TEAMS = [
  { name: 'القيادة الميدانية', center: 'العمليات', team_type: 'قيادة', requiredPersonnel: 2 },
  { name: 'التحكم العملياتي', center: 'العمليات', team_type: 'عمليات', requiredPersonnel: 1 },
  { name: 'تنسيق الاستجابة', center: 'العمليات', team_type: 'عمليات', requiredPersonnel: 1 },
  { name: 'الدعم اللوجستي', center: 'العمليات', team_type: 'دعم', requiredPersonnel: 1 }
];

async function ensureOperationalTeams() {
  try {
    for (const t of OPERATIONAL_TEAMS) {
      const existing = await all('SELECT id FROM teams WHERE name = ?', [t.name]);
      if (existing.length > 0) continue;
      await run('INSERT INTO teams (name, center, team_type, sort_order, is_active, requiredPersonnel) VALUES (?, ?, ?, 0, 1, ?);', [t.name, t.center, t.team_type, t.requiredPersonnel]);
      logger.info(`Operational team ensured: ${t.name}`);
    }
    await run(`UPDATE teams SET requiredPersonnel = 1 WHERE team_type = 'سريع' AND requiredPersonnel <> 1`);
  } catch (err) {
    logger.error('ensureOperationalTeams failed', err);
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
// AUTH: TOKEN BLACKLIST / SESSIONS / LOGS
// ============================================
// better-sqlite3 لا يقبل booleans — تُحوَّل إلى 1/0 (is_active, success تصل من server.js كـ true/false)
function _authBindVal(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return v === undefined ? null : v;
}

const TokenBlacklist = {
  // D-15: expires_at يُعبَّأ من exp التوكن عند الإبطال حتى يمكن تنظيف الصفوف
  // المنتهية دورياً بدل تراكمها إلى الأبد (صفوف بلا expires_at تُبقى — محافظة).
  // يُخزَّن بصيغة SQLite datetime ('YYYY-MM-DD HH:MM:SS' UTC) حتى تكون
  // المقارنة النصية مع datetime('now') صحيحة.
  async add(tokenHash, expiresAt) {
    let exp = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (!isNaN(d.getTime())) exp = d.toISOString().replace('T', ' ').slice(0, 19);
    }
    const result = await run('INSERT INTO token_blacklist (token_hash, expires_at) VALUES (?, ?)', [tokenHash, exp]);
    return result.id;
  },
  async isBlacklisted(tokenHash) {
    const row = await get('SELECT id FROM token_blacklist WHERE token_hash = ? LIMIT 1', [tokenHash]);
    return !!row;
  },
  // D-15: تنظيف محافظ — يحذف فقط الصفوف التي ثبت انتهاء توكنها
  async purgeExpired() {
    const result = await run("DELETE FROM token_blacklist WHERE expires_at IS NOT NULL AND expires_at < datetime('now')");
    return result.changes || 0;
  }
};

// whitelist للأعمدة الحقيقية فقط — المفاتيح غير المعروفة (مثل expires_at) تُتجاهل
const AUTH_SESSION_COLUMNS = ['user_id', 'username', 'role', 'access_token_hash', 'refresh_token_hash', 'ip_address', 'user_agent', 'session_start', 'session_last_active', 'session_expires', 'refresh_expires', 'is_active', 'logout_time', 'logout_reason'];

const AuthSessions = {
  async create(data) {
    const cols = AUTH_SESSION_COLUMNS.filter(c => data[c] !== undefined);
    const sql = `INSERT INTO auth_sessions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const result = await run(sql, cols.map(c => _authBindVal(data[c])));
    return { id: result.id };
  },
  async getByUser(userId) {
    return all('SELECT * FROM auth_sessions WHERE user_id = ?', [userId]);
  },
  async update(id, data) {
    const cols = AUTH_SESSION_COLUMNS.filter(c => data[c] !== undefined);
    if (cols.length === 0) return { changes: 0 };
    const sql = `UPDATE auth_sessions SET ${cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`;
    return run(sql, [...cols.map(c => _authBindVal(data[c])), id]);
  }
};

const AUTH_LOG_COLUMNS = ['user_id', 'username', 'action_type', 'action_detail', 'ip_address', 'user_agent', 'session_id', 'success', 'error_message'];

const AuthLogs = {
  async create(data) {
    const cols = AUTH_LOG_COLUMNS.filter(c => data[c] !== undefined);
    const sql = `INSERT INTO auth_logs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const result = await run(sql, cols.map(c => _authBindVal(data[c])));
    return { id: result.id };
  },
  async getByUser(userId) {
    return all('SELECT * FROM auth_logs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
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
  // D-26: توحيد مع reconcile المناوبات في runMigrations (~سطر 951):
  //  - نفس حسم المسار (RENDER_DISK_PATH || DATA_DIR || ./data) بدل DATA_DIR الثابت
  //  - حفظ معرّف JSON الأصلي بدل توليد معرّفات جديدة
  //  - الإدراج كـ archived بدل إرث DEFAULT 'active' (كان يصنع 19 مناوبة active
  //    زائفة على أي قاعدة جديدة عند اختلاف المسارين)
  try {
    const existing = await Shifts.getAll();
    if (existing.length > 0) {
      logger.warn('Shifts table already has data. Skipping migration.');
      return;
    }
    const dataPath = path.join(
      process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, 'data'),
      'shift-data.json'
    );
    const shifts = JSON.parse(await fs.readFile(dataPath, 'utf8'));
    for (const shift of shifts) {
      const status = shift.status === 'active' ? 'archived' : (shift.status || 'archived');
      const result = await run(
        `INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, shift_day, start_time,
         total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update, status, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shift.id ?? null, shift.shiftName || '', shift.shiftDate || '', shift.shiftTime || '',
          shift.shiftType || '', shift.shiftDay || '', shift.startTime || '', shift.totalReports || 0,
          JSON.stringify(shift.rapidLocations || {}), JSON.stringify(shift.centersData || {}),
          JSON.stringify(shift.vehicleData || {}), JSON.stringify(shift.fuelData || {}),
          shift.generalNotes || '', shift.lastUpdate || null, status,
          shift.archivedAt || new Date().toISOString()
        ]
      );
      const shiftId = shift.id ?? result.id;
      if (shift.savedReports && typeof shift.savedReports === 'object') {
        for (const [key, report] of Object.entries(shift.savedReports)) {
          const [center, unit] = key.split('|');
          if (!center || !unit) continue;
          await Shifts.addShiftReport(shiftId, center, unit, report.count || 0, report.times || []);
        }
      }
    }
    logger.info(`✅ Migrated ${shifts.length} shifts to SQLite (ids preserved, archived)`);
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
// CRUD: SHIFT ANALYTICS / AUDIT NAMESPACES (Slice 7 — dbAvailable unblock)
// هذه المنافذ الـ13 تغطي جداول موجودة أصلاً في الإنتاج (مخططاتها في
// TABLE_SCHEMAS أعلاه) — الناقص كان كائنات CRUD فقط، وغيابها أبقى
// dbAvailable() في server.js=false دائماً فعطّل ~35 نقطة نهاية بصمت.
// الأعمدة المقيدة بـ CHECK تُتحقق ضد قوائم الإنتاج حرفياً حتى لا يخترق
// أي مستدعٍ القيود.
// ============================================
const SHIFT_ALERT_TYPES = ['high_pending', 'low_completion', 'staff_shortage', 'workload_spike', 'closure_delay', 'repeated_notes'];
const SHIFT_ALERT_SEVERITIES = ['info', 'warning', 'critical'];
const SHIFT_AUDIT_TRAIL_ACTIONS = ['created', 'modified', 'reviewed', 'approved', 'deleted', 'data_added', 'data_updated', 'export', 'alert_acked'];
const SHIFT_TIMELINE_EVENT_TYPES = ['start', 'team_checkin', 'report_received', 'report_completed', 'shift_change', 'form_filed', 'note_added', 'alert_triggered', 'peak_mission', 'end'];
const SHIFT_AUDIT_LOG_CHANGE_TYPES = ['edit', 'swap', 'bulk', 'delete', 'add'];
const NOTIFICATION_LOG_TYPES = ['shift_change', 'system', 'alert'];
const NOTIFICATION_LOG_CHANNELS = ['in-app', 'whatsapp', 'sms', 'email'];
const NOTIFICATION_LOG_STATUSES = ['pending', 'sent', 'delivered', 'failed', 'read'];
const SHIFT_CHANGE_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'cancelled'];
const ROSTER_DRAFT_OPERATION_TYPES = ['edit', 'swap', 'bulk', 'delete', 'add'];
const SHIFT_REPORT_TYPES = ['daily', 'weekly', 'monthly', 'shift_detail'];

function _jsonOrRaw(v) {
  if (v === undefined || v === null) return null;
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

const ShiftMetrics = {
  async getByShift(shiftId) {
    return get('SELECT * FROM shift_metrics WHERE shift_id = ? ORDER BY id DESC LIMIT 1', [shiftId]);
  },
  async create(data) {
    const result = await run(
      `INSERT INTO shift_metrics (shift_id, total_reports, completed_reports, pending_reports, suspended_reports, total_completions, total_forms, staff_count, team_count, vehicle_count, completion_rate, avg_response_time, avg_closure_time, critical_cases, health_score, data_completeness, notes_count, event_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.shift_id, data.total_reports || 0, data.completed_reports || 0, data.pending_reports || 0,
       data.suspended_reports || 0, data.total_completions || 0, data.total_forms || 0, data.staff_count || 0,
       data.team_count || 0, data.vehicle_count || 0, data.completion_rate || 0, data.avg_response_time || 0,
       data.avg_closure_time || 0, data.critical_cases || 0, data.health_score || 0, data.data_completeness || 0,
       data.notes_count || 0, data.event_count || 0]
    );
    return result.id;
  },
  async update(id, data) {
    return run(
      `UPDATE shift_metrics SET total_reports = ?, completed_reports = ?, pending_reports = ?, suspended_reports = ?, total_completions = ?, total_forms = ?, staff_count = ?, team_count = ?, vehicle_count = ?, completion_rate = ?, avg_response_time = ?, avg_closure_time = ?, critical_cases = ?, health_score = ?, data_completeness = ?, notes_count = ?, event_count = ?, calculated_at = CURRENT_TIMESTAMP WHERE id = ?;`,
      [data.total_reports || 0, data.completed_reports || 0, data.pending_reports || 0, data.suspended_reports || 0,
       data.total_completions || 0, data.total_forms || 0, data.staff_count || 0, data.team_count || 0,
       data.vehicle_count || 0, data.completion_rate || 0, data.avg_response_time || 0, data.avg_closure_time || 0,
       data.critical_cases || 0, data.health_score || 0, data.data_completeness || 0, data.notes_count || 0,
       data.event_count || 0, id]
    );
  },
  // upsert by shift_id (shift-archive-engine persists snapshot metrics via save)
  async save(data) {
    const existing = await this.getByShift(data.shift_id);
    if (existing) {
      await this.update(existing.id, data);
      return existing.id;
    }
    return this.create(data);
  }
};

const ShiftAlerts = {
  async getAll(limit = 50) {
    return all('SELECT * FROM shift_alerts ORDER BY created_at DESC LIMIT ?', [limit]);
  },
  async getByShift(shiftId, limit = 50) {
    return all('SELECT * FROM shift_alerts WHERE shift_id = ? ORDER BY created_at DESC LIMIT ?', [shiftId, limit]);
  },
  async getUnacknowledged(limit = 20) {
    return all('SELECT * FROM shift_alerts WHERE is_acknowledged = 0 ORDER BY created_at DESC LIMIT ?', [limit]);
  },
  async create(data) {
    if (!SHIFT_ALERT_TYPES.includes(data.alert_type)) throw new Error('ShiftAlerts.create: alert_type غير صالح: ' + data.alert_type);
    if (!data.message) throw new Error('ShiftAlerts.create: message مطلوب');
    const result = await run(
      `INSERT INTO shift_alerts (shift_id, alert_type, severity, message, suggested_reason, is_acknowledged, acknowledged_by, acknowledged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.shift_id || null, data.alert_type,
       SHIFT_ALERT_SEVERITIES.includes(data.severity) ? data.severity : 'warning',
       data.message, data.suggested_reason || null,
       data.is_acknowledged ? 1 : 0, data.acknowledged_by || null, data.acknowledged_at || null]
    );
    return result.id;
  },
  async acknowledge(id, acknowledgedBy) {
    return run('UPDATE shift_alerts SET is_acknowledged = 1, acknowledged_by = ?, acknowledged_at = CURRENT_TIMESTAMP WHERE id = ?', [acknowledgedBy || null, id]);
  }
};

// KPI upserts: تحديث تجميعي جزئي — الأعمدة الممررة فقط تُحدَّث عند التعارض،
// وغير الممررة تبقى كما هي (مستدعيان بشكلين: لقطة كاملة من مولّد البيانات،
// وتحديث جزئي لكل مناوبة من محرك الأرشفة).
function _partialUpsertSql(table, conflictTarget, insertCols, providedCols) {
  const placeholders = insertCols.map(() => '?').join(', ');
  if (providedCols.length === 0) {
    return `INSERT INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflictTarget}) DO NOTHING;`;
  }
  const sets = providedCols.map(c => `${c} = excluded.${c}`).join(', ');
  return `INSERT INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflictTarget}) DO UPDATE SET ${sets};`;
}

const ShiftKpiDaily = {
  async getByDate(date) {
    return get('SELECT * FROM shift_kpi_daily WHERE date = ?', [date]);
  },
  async upsert(data) {
    if (!data.date) throw new Error('ShiftKpiDaily.upsert: date مطلوب');
    // محرك الأرشفة يمرر staff_count — العمود الحقيقي total_staff
    const cols = {
      total_shifts: data.total_shifts,
      total_reports: data.total_reports,
      completed_reports: data.completed_reports,
      open_reports: data.open_reports,
      suspended_reports: data.suspended_reports,
      total_staff: data.total_staff !== undefined ? data.total_staff : data.staff_count,
      total_teams: data.total_teams,
      total_vehicles: data.total_vehicles,
      completion_rate: data.completion_rate,
      avg_response_time: data.avg_response_time,
      avg_closure_time: data.avg_closure_time,
      top_center: data.top_center,
      top_report_type: data.top_report_type
    };
    const provided = Object.keys(cols).filter(k => cols[k] !== undefined);
    const insertCols = ['date', ...provided];
    const sql = _partialUpsertSql('shift_kpi_daily', 'date', insertCols, provided);
    const result = await run(sql, insertCols.map(c => c === 'date' ? data.date : cols[c]));
    return result.id;
  }
};

const ShiftKpiWeekly = {
  async getByWeekStart(weekStart) {
    return get('SELECT * FROM shift_kpi_weekly WHERE week_start = ? ORDER BY id DESC LIMIT 1', [weekStart]);
  },
  async upsert(data) {
    if (!data.week_start) throw new Error('ShiftKpiWeekly.upsert: week_start مطلوب');
    // week_end NOT NULL ولا يمرره محرك الأرشفة — يُشتق (week_start + 6 أيام)
    let weekEnd = data.week_end;
    if (!weekEnd) {
      const d = new Date(data.week_start + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 6);
      weekEnd = d.toISOString().slice(0, 10);
    }
    // محرك الأرشفة يمرر avg_completion_rate — العمود الحقيقي completion_rate
    const cols = {
      week_end: weekEnd,
      total_shifts: data.total_shifts,
      total_reports: data.total_reports,
      avg_daily_reports: data.avg_daily_reports,
      peak_day: data.peak_day,
      peak_day_count: data.peak_day_count,
      lowest_day: data.lowest_day,
      lowest_day_count: data.lowest_day_count,
      completion_rate: data.completion_rate !== undefined ? data.completion_rate : data.avg_completion_rate,
      total_operating_hours: data.total_operating_hours,
      total_staff: data.total_staff,
      total_teams: data.total_teams,
      total_vehicles: data.total_vehicles,
      avg_staff_per_shift: data.avg_staff_per_shift,
      comparison_last_week: data.comparison_last_week
    };
    const provided = Object.keys(cols).filter(k => cols[k] !== undefined);
    const existing = await this.getByWeekStart(data.week_start);
    if (existing) {
      if (provided.length > 0) {
        await run(`UPDATE shift_kpi_weekly SET ${provided.map(c => `${c} = ?`).join(', ')}, calculated_at = CURRENT_TIMESTAMP WHERE id = ?;`,
          [...provided.map(c => cols[c]), existing.id]);
      }
      return existing.id;
    }
    const insertCols = ['week_start', ...provided];
    const result = await run(
      `INSERT INTO shift_kpi_weekly (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')});`,
      insertCols.map(c => c === 'week_start' ? data.week_start : cols[c])
    );
    return result.id;
  }
};

const ShiftKpiMonthly = {
  async getByMonthYear(month, year) {
    return get('SELECT * FROM shift_kpi_monthly WHERE month = ? AND year = ? ORDER BY id DESC LIMIT 1', [month, year]);
  },
  async upsert(data) {
    // محرك الأرشفة يمرر month_start ('YYYY-MM-01') — العمودان الحقيقيان month/year
    let month = data.month;
    let year = data.year;
    if ((month === undefined || year === undefined) && data.month_start) {
      const parts = String(data.month_start).split('-');
      year = parseInt(parts[0], 10);
      month = parseInt(parts[1], 10);
    }
    if (!month || !year) throw new Error('ShiftKpiMonthly.upsert: month/year مطلوبان');
    const cols = {
      total_shifts: data.total_shifts,
      total_reports: data.total_reports,
      total_operating_hours: data.total_operating_hours,
      total_staff: data.total_staff,
      total_teams: data.total_teams,
      total_vehicles: data.total_vehicles,
      morning_shifts: data.morning_shifts,
      night_shifts: data.night_shifts,
      completion_rate: data.completion_rate !== undefined ? data.completion_rate : data.avg_completion_rate,
      avg_performance: data.avg_performance,
      comparison_last_month: data.comparison_last_month,
      comparison_chart_data: _jsonOrRaw(data.comparison_chart_data)
    };
    const provided = Object.keys(cols).filter(k => cols[k] !== undefined);
    const existing = await this.getByMonthYear(month, year);
    if (existing) {
      if (provided.length > 0) {
        await run(`UPDATE shift_kpi_monthly SET ${provided.map(c => `${c} = ?`).join(', ')}, calculated_at = CURRENT_TIMESTAMP WHERE id = ?;`,
          [...provided.map(c => cols[c]), existing.id]);
      }
      return existing.id;
    }
    const insertCols = ['month', 'year', ...provided];
    const result = await run(
      `INSERT INTO shift_kpi_monthly (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')});`,
      insertCols.map(c => (c === 'month' ? month : (c === 'year' ? year : cols[c])))
    );
    return result.id;
  }
};

const ShiftAuditTrail = {
  async getByShift(shiftId, limit = 100) {
    return all('SELECT * FROM shift_audit_trail WHERE shift_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [shiftId, limit]);
  },
  async create(data) {
    // بعض المستدعين (shift-archive-engine) يمررون event_type/event_title بدل
    // action_type — القيمة الأصلية تُحفظ في action_detail ويُستخدم أقرب نوع صالح
    // حتى لا يُخترق قيد CHECK أبداً.
    let actionType = data.action_type;
    let detail = data.action_detail || data.event_title || '';
    if (!SHIFT_AUDIT_TRAIL_ACTIONS.includes(actionType)) {
      const original = actionType || data.event_type;
      actionType = 'data_updated';
      if (original) detail = `[${original}] ${detail}`;
    }
    const actorId = data.actor_id !== undefined && data.actor_id !== null ? String(data.actor_id)
      : (data.created_by !== undefined && data.created_by !== null ? String(data.created_by) : 'system');
    const result = await run(
      `INSERT INTO shift_audit_trail (shift_id, action_type, actor_id, actor_name, actor_role, action_detail, old_data, new_data, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.shift_id, actionType, actorId,
       data.actor_name || data.created_by_name || null, data.actor_role || null,
       detail, _jsonOrRaw(data.old_data),
       _jsonOrRaw(data.new_data) || _jsonOrRaw(data.event_data),
       data.ip_address || null, data.user_agent || null]
    );
    return result.id;
  }
};

const ShiftAuditLog = {
  async getAll(limit = 50) {
    return all('SELECT * FROM shift_audit_log ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
  },
  async getByEmployee(employeeId, limit = 50) {
    return all('SELECT * FROM shift_audit_log WHERE employee_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [employeeId, limit]);
  },
  async getByDateRange(dateFrom, dateTo, limit = 50) {
    return all('SELECT * FROM shift_audit_log WHERE shift_date >= ? AND shift_date <= ? ORDER BY created_at DESC, id DESC LIMIT ?', [dateFrom, dateTo, limit]);
  },
  async create(data) {
    if (!data.shift_date) throw new Error('ShiftAuditLog.create: shift_date مطلوب');
    const result = await run(
      `INSERT INTO shift_audit_log (roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code, old_team_id, new_team_id, changed_by, changed_by_name, change_type, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.roster_id || null, data.employee_id || null, data.team_id || null, data.shift_date,
       data.old_shift_code || null, data.new_shift_code || null,
       data.old_team_id || null, data.new_team_id || null,
       String(data.changed_by || 'system'), data.changed_by_name || null,
       SHIFT_AUDIT_LOG_CHANGE_TYPES.includes(data.change_type) ? data.change_type : 'edit',
       data.reason || null]
    );
    return result.id;
  }
};

const ShiftTimelineEvents = {
  async getByShift(shiftId, limit = 50) {
    return all('SELECT * FROM shift_timeline_events WHERE shift_id = ? ORDER BY event_time ASC, id ASC LIMIT ?', [shiftId, limit]);
  },
  async create(data) {
    if (!SHIFT_TIMELINE_EVENT_TYPES.includes(data.event_type)) throw new Error('ShiftTimelineEvents.create: event_type غير صالح: ' + data.event_type);
    if (!data.event_title) throw new Error('ShiftTimelineEvents.create: event_title مطلوب');
    if (!data.shift_id) throw new Error('ShiftTimelineEvents.create: shift_id مطلوب');
    // event_time يُدرج فقط عند تمريره — تمرير NULL صراحةً كان يلغي DEFAULT
    // CURRENT_TIMESTAMP في المخطط (رُصد في تحقق الشريحة 7)
    const hasTime = !!data.event_time;
    const cols = ['shift_id', 'event_type', 'event_title', 'event_description', 'event_data'];
    const vals = [data.shift_id, data.event_type, data.event_title, data.event_description || null, _jsonOrRaw(data.event_data)];
    if (hasTime) { cols.push('event_time'); vals.push(data.event_time); }
    cols.push('created_by', 'created_by_name');
    vals.push(data.created_by !== undefined && data.created_by !== null ? String(data.created_by) : null, data.created_by_name || null);
    const result = await run(
      `INSERT INTO shift_timeline_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`,
      vals
    );
    return result.id;
  }
};

const ShiftComparisonSnapshots = {
  async getById(id) {
    return get('SELECT * FROM shift_comparison_snapshots WHERE id = ?', [id]);
  },
  async create(data) {
    if (!data.comparison_data) throw new Error('ShiftComparisonSnapshots.create: comparison_data مطلوب');
    const result = await run(
      `INSERT INTO shift_comparison_snapshots (comparison_name, shift_a_id, shift_b_id, shift_a_date, shift_b_date, comparison_data, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      [data.comparison_name || null, data.shift_a_id, data.shift_b_id,
       data.shift_a_date || null, data.shift_b_date || null,
       _jsonOrRaw(data.comparison_data), data.created_by || null]
    );
    return result.id;
  }
};

const ShiftReportsGenerated = {
  async getById(id) {
    return get('SELECT * FROM shift_reports_generated WHERE id = ?', [id]);
  },
  async create(data) {
    if (!SHIFT_REPORT_TYPES.includes(data.report_type)) throw new Error('ShiftReportsGenerated.create: report_type غير صالح: ' + data.report_type);
    const result = await run(
      `INSERT INTO shift_reports_generated (report_type, report_date_from, report_date_to, shift_id, report_data, file_path, file_format, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.report_type, data.report_date_from || null, data.report_date_to || null,
       data.shift_id || null, _jsonOrRaw(data.report_data), data.file_path || null,
       data.file_format || 'pdf', data.generated_by || null]
    );
    return result.id;
  }
};

const ShiftRosterDrafts = {
  async getByCreatedBy(createdBy, limit = 50) {
    return all('SELECT * FROM shift_roster_drafts WHERE created_by = ? ORDER BY id DESC LIMIT ?', [createdBy, limit]);
  },
  async getPendingByCreatedBy(createdBy) {
    return all('SELECT * FROM shift_roster_drafts WHERE created_by = ? AND applied_at IS NULL AND reverted_at IS NULL ORDER BY id DESC', [createdBy]);
  },
  async create(data) {
    if (!data.draft_data_json) throw new Error('ShiftRosterDrafts.create: draft_data_json مطلوب');
    const result = await run(
      `INSERT INTO shift_roster_drafts (draft_data_json, operation_type, created_by, created_by_name)
       VALUES (?, ?, ?, ?);`,
      [_jsonOrRaw(data.draft_data_json),
       ROSTER_DRAFT_OPERATION_TYPES.includes(data.operation_type) ? data.operation_type : 'edit',
       String(data.created_by || 'system'), data.created_by_name || null]
    );
    return result.id;
  },
  async markReverted(id) {
    return run('UPDATE shift_roster_drafts SET reverted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }
};

const NotificationLog = {
  async getAll(limit = 50) {
    return all('SELECT * FROM notification_log ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
  },
  async getByRecipient(recipientId, limit = 50) {
    return all('SELECT * FROM notification_log WHERE recipient_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', [recipientId, limit]);
  },
  async getByStatus(status, limit = 50) {
    return all('SELECT * FROM notification_log WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?', [status, limit]);
  },
  async create(data) {
    if (!data.recipient_id && data.recipient_id !== 0) throw new Error('NotificationLog.create: recipient_id مطلوب');
    if (!data.message) throw new Error('NotificationLog.create: message مطلوب');
    const result = await run(
      `INSERT INTO notification_log (notification_type, recipient_id, recipient_name, recipient_phone, message, channel, status, roster_id, shift_date, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [NOTIFICATION_LOG_TYPES.includes(data.notification_type) ? data.notification_type : 'shift_change',
       data.recipient_id, data.recipient_name || null, data.recipient_phone || null, data.message,
       NOTIFICATION_LOG_CHANNELS.includes(data.channel) ? data.channel : 'in-app',
       NOTIFICATION_LOG_STATUSES.includes(data.status) ? data.status : 'pending',
       data.roster_id || null, data.shift_date || null, data.old_value || null, data.new_value || null]
    );
    return result.id;
  },
  async markAsSent(id) {
    return run("UPDATE notification_log SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  },
  async markAsDelivered(id) {
    return run("UPDATE notification_log SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
  }
};

const ShiftChangeRequests = {
  async getAll(limit = 50) {
    return all('SELECT * FROM shift_change_requests ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
  },
  async getByStatus(status, limit = 50) {
    return all('SELECT * FROM shift_change_requests WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?', [status, limit]);
  },
  async getById(id) {
    return get('SELECT * FROM shift_change_requests WHERE id = ?', [id]);
  },
  async create(data) {
    if (!data.employee_id || !data.shift_date || !data.proposed_shift_code) {
      throw new Error('ShiftChangeRequests.create: employee_id/shift_date/proposed_shift_code مطلوبة');
    }
    const result = await run(
      `INSERT INTO shift_change_requests (roster_id, employee_id, team_id, shift_date, proposed_shift_code, old_shift_code, requested_by, requested_by_name, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [data.roster_id || null, data.employee_id, data.team_id || null, data.shift_date,
       data.proposed_shift_code, data.old_shift_code || null,
       String(data.requested_by || 'system'), data.requested_by_name || null,
       SHIFT_CHANGE_REQUEST_STATUSES.includes(data.status) ? data.status : 'pending',
       data.reason || null]
    );
    return result.id;
  },
  async updateStatus(id, status, reviewedBy) {
    if (!SHIFT_CHANGE_REQUEST_STATUSES.includes(status)) throw new Error('ShiftChangeRequests.updateStatus: status غير صالحة: ' + status);
    return run('UPDATE shift_change_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?', [status, reviewedBy || null, id]);
  }
};

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
  TokenBlacklist,
  AuthSessions,
  AuthLogs,
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

  // Shift analytics / audit (Slice 7 — unblock dbAvailable)
  ShiftMetrics,
  ShiftAlerts,
  ShiftKpiDaily,
  ShiftKpiWeekly,
  ShiftKpiMonthly,
  ShiftAuditTrail,
  ShiftAuditLog,
  ShiftTimelineEvents,
  ShiftComparisonSnapshots,
  ShiftReportsGenerated,
  ShiftRosterDrafts,
  NotificationLog,
  ShiftChangeRequests,

  // Migration
  migrateAll,

  // Paths (مصدر الحقيقة للتخزين — يستخدمها server.js في /health وdestroy)
  DB_PATH,
  STORAGE_PATH,
  LEGACY_DB_PATH
};
