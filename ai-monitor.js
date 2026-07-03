/**
 * AI Monitor Agent — EMS Platform System Monitor & Self-Healer
 * Node.js built-in modules only. Zero external dependencies.
 *
 * Responsibilities:
 *  1. Periodic health checks (every 30 s)
 *  2. Error detection (uncaught exceptions, 500s, slow queries, memory leaks)
 *  3. Auto-healing (stale data, memory pressure, DB retries, critical thresholds)
 *  4. Structured logging (in-memory ring buffer + optional SQLite persistence)
 *  5. Alert manager with escalation and manual resolution
 *
 * Usage:
 *   const aiMonitor = require('./ai-monitor');
 *   aiMonitor.init({ db, wss, app });
 */

const os = require('os');
const v8 = require('v8');

// ─────────────────────────────────────────────────────────────────────────────
// Internal state
// ─────────────────────────────────────────────────────────────────────────────
let _db = null;
let _wss = null;
let _app = null;

let _healthInterval = null;
let _initialized = false;
let _shuttingDown = false;

const _logs = [];                 // in-memory ring buffer (last 500)
const MAX_LOGS = 500;

const _alerts = new Map();        // id → alert object
let _alertIdCounter = 0;

const _stats = {
  checksPerformed: 0,
  errorsRecorded: 0,
  slowQueriesRecorded: 0,
  autoFixesApplied: 0,
  alertsRaised: 0,
  alertsResolved: 0,
  startTime: Date.now(),
  lastCheckTime: null,
};

// Error-rate tracking (rolling 1-minute window)
const _errorLog = [];             // timestamps of API 500 errors

// Memory-leak tracking
const _heapHistory = [];          // { timestamp, heapUsed }
const HEAP_HISTORY_MAX = 20;      // keep ~10 min of samples (30 s interval)

// Response-time tracking
let _lastResponseTimeMs = 0;

// Cached health snapshot (updated every cycle)
let _currentHealth = {};

// ─────────────────────────────────────────────────────────────────────────────
// DB Compatibility Helpers (sqlite3 callback vs promise-based)
// ─────────────────────────────────────────────────────────────────────────────

function _isAsync(fn) {
  return fn && fn.constructor && fn.constructor.name === 'AsyncFunction';
}

async function _dbRun(sql, params = []) {
  if (!_db || typeof _db.run !== 'function') return { changes: 0 };
  try {
    if (_isAsync(_db.run)) {
      return await _db.run(sql, params);
    }
    // Callback-style (sqlite3)
    return new Promise((resolve, reject) => {
      _db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ changes: this ? this.changes : 0 });
      });
    });
  } catch (e) {
    return { changes: 0, error: e.message };
  }
}

async function _dbGet(sql, params = []) {
  if (!_db || typeof _db.get !== 'function') return null;
  try {
    if (_isAsync(_db.get)) {
      return await _db.get(sql, params);
    }
    // Callback-style (sqlite3)
    return new Promise((resolve, reject) => {
      _db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a log entry to SQLite (best-effort).
 */
async function _persistLog(entry) {
  if (!_db) return;
  try {
    const sql = `INSERT INTO system_logs
      (timestamp, level, category, message, details, auto_fixed, action_taken, requires_attention)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    await _dbRun(sql, [
      entry.timestamp,
      entry.level,
      entry.category,
      entry.message,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.autoFixed ? 1 : 0,
      entry.actionTaken || null,
      entry.requiresAttention ? 1 : 0,
    ]);
  } catch (err) {
    // Prevent recursion: don't call _log here; use console directly
    // eslint-disable-next-line no-console
    console.error('[AI-Monitor] SQLite persist failed:', err.message);
  }
}

/**
 * Core logging function.
 */
function _log(level, category, message, options = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
    details: options.details || null,
    autoFixed: !!options.autoFixed,
    actionTaken: options.actionTaken || null,
    requiresAttention: !!options.requiresAttention,
  };

  // Push to in-memory ring buffer
  _logs.push(entry);
  if (_logs.length > MAX_LOGS) {
    _logs.shift();
  }

  // Persist to SQLite (fire-and-forget)
  _persistLog(entry).catch(() => {});

  // Console output (structured)
  const flag = entry.autoFixed ? ' [AUTO-FIXED]' : '';
  const attn = entry.requiresAttention ? ' [REQUIRES ATTENTION]' : '';
  const meta = `[${entry.timestamp}] [${level.toUpperCase()}] [${category}]${flag}${attn}`;

  const output = entry.details
    ? `${meta} ${message} | ${JSON.stringify(entry.details)}`
    : `${meta} ${message}`;

  switch (level) {
    case 'critical':
    case 'error':
      // eslint-disable-next-line no-console
      console.error(output);
      break;
    case 'warning':
      // eslint-disable-next-line no-console
      console.warn(output);
      break;
    case 'heal':
      // eslint-disable-next-line no-console
      console.info(`\x1b[32m${output}\x1b[0m`);
      break;
    default:
      // eslint-disable-next-line no-console
      console.info(output);
  }

  return entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Alert Manager
// ─────────────────────────────────────────────────────────────────────────────

function _raiseAlert(level, category, message, options = {}) {
  _alertIdCounter += 1;
  const id = _alertIdCounter;
  const alert = {
    id,
    level,
    category,
    message,
    details: options.details || null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    resolved: false,
    autoFixed: !!options.autoFixed,
    requiresAttention: !!options.requiresAttention,
  };
  _alerts.set(id, alert);
  _stats.alertsRaised += 1;

  _log(level, category, message, {
    ...options,
    details: { alertId: id, ...(options.details || {}) },
  });

  return alert;
}

function _resolveAlertInternal(id, reason = 'manual') {
  const alert = _alerts.get(id);
  if (!alert || alert.resolved) return false;
  alert.resolved = true;
  alert.resolvedAt = new Date().toISOString();
  alert.resolutionReason = reason;
  _stats.alertsResolved += 1;
  _log('info', 'ALERT', `Alert #${id} resolved (${reason})`, {
    details: { alertId: id, category: alert.category },
  });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Health Checker
// ─────────────────────────────────────────────────────────────────────────────

function _countWsConnections() {
  if (!_wss || !_wss.clients) return 0;
  let count = 0;
  _wss.clients.forEach((client) => {
    if (client.readyState === 1) count += 1; // WebSocket.OPEN === 1
  });
  return count;
}

async function _pingDatabase() {
  const start = Date.now();
  if (!_db) {
    return { ok: false, ms: 0, error: 'No DB handle' };
  }
  try {
    const row = await _dbGet('SELECT 1 AS ok');
    const ms = Date.now() - start;
    return { ok: !!row, ms, row };
  } catch (err) {
    const ms = Date.now() - start;
    return { ok: false, ms, error: err.message };
  }
}

function _checkMemoryLeak() {
  if (_heapHistory.length < 5) return { leakDetected: false, growthRate: 0 };

  // Compare oldest half vs newest half average heap
  const half = Math.floor(_heapHistory.length / 2);
  const oldAvg = _heapHistory.slice(0, half).reduce((s, h) => s + h.heapUsed, 0) / half;
  const newAvg = _heapHistory.slice(half).reduce((s, h) => s + h.heapUsed, 0) / half;

  const growthRate = oldAvg > 0 ? (newAvg - oldAvg) / oldAvg : 0;
  // Flag leak if newer average is >30 % larger and absolute growth > 50 MB
  const leakDetected = growthRate > 0.30 && (newAvg - oldAvg) > 50 * 1024 * 1024;

  return { leakDetected, growthRate: parseFloat(growthRate.toFixed(4)) };
}

async function _performHealthCheck() {
  if (_shuttingDown) return;
  _stats.checksPerformed += 1;
  const checkTime = new Date().toISOString();
  _stats.lastCheckTime = checkTime;

  const mem = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const uptimeSec = Math.floor(process.uptime());
  const dbPing = await _pingDatabase();
  const wsCount = _countWsConnections();

  // Disk-space estimate: use freemem as rough proxy (no cross-platform fs stat)
  const freeMem = os.freemem();
  const totalMem = os.totalmem();
  const diskEstimate = {
    freeMemBytes: freeMem,
    totalMemBytes: totalMem,
    freePercent: totalMem > 0 ? parseFloat(((freeMem / totalMem) * 100).toFixed(2)) : 0,
    note: 'Estimated from os.freemem / os.totalmem (process-level)',
  };

  // Error rate in last 60 s
  const oneMinuteAgo = Date.now() - 60000;
  while (_errorLog.length > 0 && _errorLog[0] < oneMinuteAgo) {
    _errorLog.shift();
  }
  const errorRatePerMinute = _errorLog.length;

  // Heap history for leak detection
  _heapHistory.push({ timestamp: Date.now(), heapUsed: mem.heapUsed });
  if (_heapHistory.length > HEAP_HISTORY_MAX) _heapHistory.shift();
  const leakInfo = _checkMemoryLeak();

  _currentHealth = {
    checkTime,
    uptimeSec,
    memory: {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external || 0,
      heapLimit: heapStats.heap_size_limit,
    },
    dbPing,
    wsConnections: wsCount,
    disk: diskEstimate,
    errorRatePerMinute,
    memoryLeak: leakInfo,
    responseTimeMs: _lastResponseTimeMs,
  };

  // ── Auto-healing & alerting ──
  await _evaluateAndHeal(_currentHealth);

  return _currentHealth;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Auto-Healer & Rule Engine
// ─────────────────────────────────────────────────────────────────────────────

async function _evaluateAndHeal(health) {
  // Rule 1: DB connection failure → retry up to 3 times
  if (!health.dbPing.ok) {
    _log('warning', 'DB', 'Database ping failed — initiating retry sequence', {
      details: { error: health.dbPing.error },
    });
    let recovered = false;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await new Promise((r) => setTimeout(r, 500)); // brief back-off
      const retry = await _pingDatabase();
      if (retry.ok) {
        recovered = true;
        _stats.autoFixesApplied += 1;
        _log('heal', 'DB', `Database connection recovered on retry ${attempt}`, {
          autoFixed: true,
          actionTaken: `DB retry attempt ${attempt}`,
        });
        health.dbPing = retry;
        break;
      }
    }
    if (!recovered) {
      _raiseAlert('critical', 'DB', 'Database unreachable after 3 retries', {
        requiresAttention: true,
        details: { lastError: health.dbPing.error },
      });
    }
  }

  // Rule 2: Memory heap > 500 MB → force GC + log warning
  const heapUsedMB = health.memory.heapUsed / (1024 * 1024);
  if (heapUsedMB > 500) {
    const action = 'Forced global.gc() + warning logged';
    if (global.gc) {
      try {
        global.gc();
        _stats.autoFixesApplied += 1;
        _log('heal', 'MEMORY', `Heap exceeded 500 MB (${heapUsedMB.toFixed(1)} MB) — GC forced`, {
          autoFixed: true,
          actionTaken: action,
        });
      } catch (e) {
        _log('warning', 'MEMORY', 'Failed to force GC', { details: { error: e.message } });
      }
    } else {
      _log('warning', 'MEMORY', `Heap exceeded 500 MB (${heapUsedMB.toFixed(1)} MB) — start with --expose-gc to enable forced GC`, {
        requiresAttention: false,
      });
    }
  }

  // Rule 3: Memory leak detected
  if (health.memoryLeak.leakDetected) {
    _raiseAlert('warning', 'MEMORY', 'Possible memory leak detected', {
      details: { growthRate: health.memoryLeak.growthRate },
    });
  }

  // Rule 4: API 500 errors > 5 per minute → critical
  if (health.errorRatePerMinute > 5) {
    _raiseAlert('critical', 'API', `API 500 error rate critical: ${health.errorRatePerMinute}/min`, {
      requiresAttention: true,
      details: { threshold: 5, actual: health.errorRatePerMinute },
    });
  } else if (health.errorRatePerMinute >= 3) {
    _raiseAlert('warning', 'API', `API 500 error rate elevated: ${health.errorRatePerMinute}/min`, {
      details: { threshold: 5, actual: health.errorRatePerMinute },
    });
  }

  // Rule 5: Response time > 5 s → slow query warning
  if (health.responseTimeMs > 5000) {
    _log('warning', 'PERFORMANCE', `Response time high: ${health.responseTimeMs} ms`, {
      details: { thresholdMs: 5000, actualMs: health.responseTimeMs },
    });
  }

  // Rule 6: currentShiftId stale (> 24 h) → reset to null
  // We attempt a best-effort update if the shifts table exists.
  if (_db) {
    try {
      const row = await _dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='shifts'");
      if (row) {
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const result = await _dbRun(
          'UPDATE shifts SET currentShiftId = NULL WHERE currentShiftId IS NOT NULL AND updatedAt < ?',
          [dayAgo]
        );
        if (result && result.changes > 0) {
          _stats.autoFixesApplied += 1;
          _log('heal', 'SHIFT', `Reset ${result.changes} stale currentShiftId(s) (> 24 h)`, {
            autoFixed: true,
            actionTaken: 'Reset stale currentShiftId to NULL',
          });
        }
      }
    } catch (e) {
      // silently ignore — best-effort
    }
  }

  // Rule 7: allShifts cache corrupted → trigger reload (placeholder hook)
  // Actual cache validation depends on app implementation. We expose a hook.
  if (_app && _app.locals && _app.locals.allShiftsCacheCorrupted) {
    _stats.autoFixesApplied += 1;
    delete _app.locals.allShiftsCacheCorrupted;
    _log('heal', 'CACHE', 'Detected corrupted allShifts cache — triggering reload', {
      autoFixed: true,
      actionTaken: 'Flag cleared; reload triggered via app.locals hook',
    });
    if (typeof _app.locals.reloadAllShifts === 'function') {
      try {
        _app.locals.reloadAllShifts();
      } catch (e) {
        _log('error', 'CACHE', 'reloadAllShifts() threw', { details: { error: e.message } });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Error Detector Hooks
// ─────────────────────────────────────────────────────────────────────────────

function _hookProcessEvents() {
  // Uncaught exceptions
  process.on('uncaughtException', (err) => {
    _log('critical', 'PROCESS', 'Uncaught Exception', {
      requiresAttention: true,
      details: { message: err.message, stack: err.stack },
    });
    _raiseAlert('critical', 'PROCESS', `Uncaught Exception: ${err.message}`, {
      requiresAttention: true,
    });
    // Graceful shutdown recommended; don't exit immediately to let logs flush
    setTimeout(() => process.exit(1), 1500);
  });

  // Unhandled rejections
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    _log('error', 'PROCESS', 'Unhandled Rejection', {
      details: { reason: msg },
    });
  });

  // Warning events (e.g., DeprecationWarning)
  process.on('warning', (warning) => {
    _log('warning', 'PROCESS', `Node warning: ${warning.name}`, {
      details: { message: warning.message, stack: warning.stack },
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Exported API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize the AI monitor.
 * @param {Object} options
 * @param {Object} options.db   — SQLite database handle (better-sqlite3 or sqlite3)
 * @param {Object} options.wss  — WebSocketServer instance (optional)
 * @param {Object} options.app  — Express app instance (optional)
 */
async function init(options = {}) {
  if (_initialized) {
    _log('warning', 'INIT', 'AI Monitor already initialized; skipping duplicate init');
    return;
  }

  _db = options.db || null;
  _wss = options.wss || null;
  _app = options.app || null;

  // Create logs table if DB available
  if (_db) {
    try {
      await _dbRun(`CREATE TABLE IF NOT EXISTS system_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
        level TEXT,
        category TEXT,
        message TEXT,
        details TEXT,
        auto_fixed INTEGER DEFAULT 0,
        action_taken TEXT,
        requires_attention INTEGER DEFAULT 0
      )`);
      _log('info', 'INIT', 'system_logs table ready');
    } catch (err) {
      _log('warning', 'INIT', 'Failed to create system_logs table', {
        details: { error: err.message },
      });
    }
  }

  _hookProcessEvents();

  // Kick off periodic health checks (every 30 s)
  _healthInterval = setInterval(() => {
    _performHealthCheck().catch((err) => {
      _log('error', 'HEALTH', 'Health check threw', { details: { error: err.message } });
    });
  }, 30000);

  // Immediate first check
  _performHealthCheck().catch(() => {});

  _initialized = true;
  _log('info', 'INIT', 'AI Monitor initialized', {
    details: { db: !!_db, wss: !!_wss, app: !!_app },
  });
}

/**
 * Get the most recent health status object.
 */
function getHealth() {
  return { ..._currentHealth };
}

/**
 * Get log entries with optional filter.
 * @param {Object} filter — { level, category, since, limit }
 */
function getLogs(filter = {}) {
  let results = _logs.slice(); // copy

  if (filter.level) {
    results = results.filter((l) => l.level === filter.level);
  }
  if (filter.category) {
    results = results.filter((l) => l.category === filter.category);
  }
  if (filter.since) {
    const sinceMs = new Date(filter.since).getTime();
    results = results.filter((l) => new Date(l.timestamp).getTime() >= sinceMs);
  }
  if (filter.limit && filter.limit > 0) {
    results = results.slice(-filter.limit);
  }

  return results;
}

/**
 * Get active (unresolved) alerts.
 * @param {Object} filter — { level, category }
 */
function getAlerts(filter = {}) {
  let alerts = Array.from(_alerts.values()).filter((a) => !a.resolved);

  if (filter.level) {
    alerts = alerts.filter((a) => a.level === filter.level);
  }
  if (filter.category) {
    alerts = alerts.filter((a) => a.category === filter.category);
  }

  // Sort newest first
  alerts.sort((a, b) => b.id - a.id);
  return alerts;
}

/**
 * Resolve an alert by ID.
 * @param {number} id
 * @returns {boolean} success
 */
function resolveAlert(id) {
  return _resolveAlertInternal(Number(id), 'manual');
}

/**
 * Record an API error for tracking (call from Express error middleware).
 * @param {Error}  err
 * @param {Object} req  — Express request (optional)
 */
function recordError(err, req) {
  _stats.errorsRecorded += 1;
  const ts = Date.now();
  _errorLog.push(ts);

  const details = {
    message: err.message,
    stack: err.stack,
    url: req ? req.originalUrl || req.url : null,
    method: req ? req.method : null,
  };

  _log('error', 'API', `API Error recorded`, { details });

  // If error rate crosses threshold immediately, health check will catch it
  // on next cycle, but we also do a quick inline check for responsiveness.
  const oneMinuteAgo = ts - 60000;
  const recent = _errorLog.filter((t) => t >= oneMinuteAgo).length;
  if (recent > 5) {
    _raiseAlert('critical', 'API', `API 500 error rate critical: ${recent}/min`, {
      requiresAttention: true,
      details: { threshold: 5, actual: recent },
    });
  }
}

/**
 * Record a slow query.
 * @param {string} sql     — the query text
 * @param {number} elapsedMs
 */
function recordSlowQuery(sql, elapsedMs) {
  _stats.slowQueriesRecorded += 1;
  _lastResponseTimeMs = elapsedMs;

  _log('warning', 'QUERY', `Slow query detected (${elapsedMs} ms)`, {
    details: { elapsedMs, sql: sql ? sql.substring(0, 500) : null },
  });

  if (elapsedMs > 5000) {
    // Already logged; alert if extreme
    _raiseAlert('warning', 'QUERY', `Very slow query: ${elapsedMs} ms`, {
      details: { thresholdMs: 5000, actualMs: elapsedMs, sql: sql ? sql.substring(0, 200) : null },
    });
  }
}

/**
 * Manually trigger a health check cycle.
 */
async function forceCheck() {
  const health = await _performHealthCheck();
  return health;
}

/**
 * Get aggregate statistics.
 */
function getStats() {
  return {
    ..._stats,
    uptimeSec: Math.floor(process.uptime()),
    logsInMemory: _logs.length,
    activeAlerts: getAlerts().length,
    totalAlerts: _alerts.size,
    heapHistorySamples: _heapHistory.length,
  };
}

/**
 * Graceful shutdown — stops the health-check interval.
 */
function shutdown() {
  _shuttingDown = true;
  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
  _log('info', 'SHUTDOWN', 'AI Monitor shutting down');
}

// Catch SIGTERM / SIGINT for graceful shutdown
process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());

// ─────────────────────────────────────────────────────────────────────────────
// Middleware helper (to be mounted in Express)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express middleware that tracks 500 errors.
 * Mount as: app.use(aiMonitor.errorTrackingMiddleware());
 */
function errorTrackingMiddleware() {
  return (err, req, res, next) => {
    if (res.statusCode >= 500 || (err && err.status >= 500)) {
      recordError(err || new Error('Unknown 500'), req);
    }
    next(err);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  init,
  getHealth,
  getLogs,
  getAlerts,
  resolveAlert,
  recordError,
  recordSlowQuery,
  forceCheck,
  getStats,
  // Extra utilities
  shutdown,
  errorTrackingMiddleware,
};
