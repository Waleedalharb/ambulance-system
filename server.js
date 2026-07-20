const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cors = require('cors');
const { ShiftArchiveEngine } = require('./shift-archive-engine');
const { createEngine, getEngine } = require('./ops-engine');
// OV-S6-01: server-side shift type/date derivation (prep mode stamping)
// (aliased: server.js already defines its own identical getCurrentShiftType)
const { getCurrentShiftType: deriveServerShiftType, getSaudiDateString } = require('./managers');

// ═══════════════════════════════════════════════════════════
// Operations Engine v1.0 — The New Single Source of Truth
// ═══════════════════════════════════════════════════════════
let opsEngine = null;

// ═══════════════════════════════════════════════════════════
// Slice 1: Event-driven services (instantiated after engine init)
// ═══════════════════════════════════════════════════════════
let reportService = null;
let completionService = null;
let positioningService = null; // Slice 4: single owner of peak_plans writes
let notesService = null; // Slice 5: single owner of shift_notes writes
let formsService = null; // Slice 6: single owner of all form writes (form_type)
let indicatorService = null; // F5a: read-only operational indicators

// Set timezone to Saudi Arabia (Riyadh)
process.env.TZ = 'Asia/Riyadh';

// ============================================
// AI PROVIDER CONFIGURATION (via Environment Variables)
// ============================================
// IMPORTANT: Set these on your server, NOT in code:
//   OPENAI_API_KEY=sk-...
//   GEMINI_API_KEY=AQ...
//   AI_PROVIDER=openai (or gemini)
//   AI_MODEL=gpt-4o-mini (or gemini-1.5-flash)
// ============================================
console.log('AI Provider Config:', {
    provider: process.env.AI_PROVIDER || 'openai',
    model: process.env.AI_MODEL || 'gpt-4o-mini',
    openaiKeySet: !!process.env.OPENAI_API_KEY,
    geminiKeySet: !!process.env.GEMINI_API_KEY
});

// SQLite Database Module (optional — falls back to JSON if unavailable)
let db = null;
let opsService = null;

try {
    db = require('./db.js');
    console.log('✅ SQLite module loaded successfully');
} catch (err) {
    console.error('⚠️ SQLite module failed to load:', err.message);
    console.log('📁 Falling back to JSON file mode');
    db = null;
}

// ── Phase 1: Unified Operations Service (JSON → SQLite) ──
if (db) {
    try {
        opsService = require('./services/operations.service');
        opsService.init(db);
        console.log('✅ Operations Service initialized');
    } catch (err) {
        console.error('⚠️ Operations Service failed:', err.message);
        opsService = null;
    }
}

// AI Monitor Agent — System health, alerts & auto-healing
const aiMonitor = require('./ai-monitor');

// Auto-Fix Engine — Data integrity & self-healing
// const autoFixEngine = require('./auto-fix-engine'); // disabled - file not tracked

// Helper: check if DB is available
function dbAvailable() {
    return db && db.Employees && db.Teams && db.ShiftCodes && db.ShiftRoster && db.TeamAssignments && db.LeaveRequests && db.ShiftScheduleAuto && db.StaffingAlerts && db.Shifts && db.Reports && db.ShiftCompletions && db.ShiftForms && db.KBDocuments && db.KBChunks && db.KBChatHistory && db.KBChatSessions && db.KBChatMessages && db.KBQueries && db.ChatConversations && db.ChatParticipants && db.ChatMessages && db.ChatMessageReads && db.ShiftAuditLog && db.NotificationLog && db.ShiftRosterDrafts && db.ShiftChangeRequests && db.ShiftMetrics && db.ShiftKpiDaily && db.ShiftKpiWeekly && db.ShiftKpiMonthly && db.ShiftTimelineEvents && db.ShiftAlerts && db.ShiftComparisonSnapshots && db.ShiftReportsGenerated && db.ShiftAuditTrail;
}

// Helper: safe DB response
function dbResponse(res, promise, fallback) {
    if (!dbAvailable()) {
        return res.status(503).json({ 
            error: 'قاعدة البيانات غير متوفرة', 
            fallback: fallback !== undefined ? fallback : null 
        });
    }
    promise.then(data => res.json(data)).catch(err => {
        console.error('DB error:', err);
        res.status(500).json({ error: 'خطأ في قاعدة البيانات' });
    });
}

// Helper: resolve shift_id — SQLite is source of truth (Phase 2+3)
async function resolveShiftId(req, shiftDate, shiftType) {
    // 1. From request body
    let shiftId = req.body.shift_id || req.body.shiftId || null;
    if (shiftId) return parseInt(shiftId);
    
    // 2. From query params
    if (req.query && (req.query.shift_id || req.query.shiftId)) {
        return parseInt(req.query.shift_id || req.query.shiftId);
    }
    
    // 3. Find ACTIVE shift in SQLite (source of truth)
    if (opsService && opsService.getActiveShift) {
        try {
            const active = await opsService.getActiveShift();
            if (active) return active.id;
        } catch (e) {
            console.warn('[resolveShiftId] opsService error:', e.message);
        }
    }
    
    // 4. Fallback: query SQLite directly
    if (dbAvailable()) {
        try {
            const row = await db.get("SELECT id FROM shifts WHERE status = 'active' ORDER BY id DESC LIMIT 1");
            if (row) return row.id;
        } catch (e) {}
    }
    
    // 5. Legacy: infer from date+type in JSON
    if (shiftDate && shiftType) {
        try {
            const shifts = await readShifts();
            const shift = shifts.find(s => s.shiftDate === shiftDate && normalizeShiftType(s.shiftType) === normalizeShiftType(shiftType));
            if (shift) return shift.id;
        } catch (e) {
            console.warn('[resolveShiftId] Could not resolve:', e.message);
        }
    }
    
    return null;
}

// Helper: add entry to shift_audit_log
async function addShiftAuditLog(data) {
    if (!dbAvailable() || !db.ShiftAuditLog) return null;
    try {
        return await db.ShiftAuditLog.create(data);
    } catch (e) {
        console.error('addShiftAuditLog error:', e.message);
        return null;
    }
}

// Helper: add entry to shift_audit_trail
async function addShiftAuditTrail(data) {
    if (!dbAvailable() || !db.ShiftAuditTrail) return null;
    try {
        return await db.ShiftAuditTrail.create(data);
    } catch (e) {
        console.error('addShiftAuditTrail error:', e.message);
        return null;
    }
}

// ============================================
// SYNC: JSON Shift → SQLite
// ============================================
async function syncShiftToDB(shift) {
    if (!dbAvailable() || !db.Shifts) return;
    try {
        const existing = await db.get('SELECT id FROM shifts WHERE id = ?', [shift.id]);
        if (existing) {
            await db.run(
                `UPDATE shifts SET shift_name = ?, shift_date = ?, shift_type = ?, total_reports = ?, rapid_locations = ?, centers_data = ?, vehicle_data = ?, fuel_data = ?, general_notes = ?, last_update = ? WHERE id = ?`,
                [
                    shift.shiftName || '', shift.shiftDate || '', shift.shiftType || '', shift.totalReports || 0,
                    JSON.stringify(shift.rapidLocations || {}), JSON.stringify(shift.centersData || {}),
                    JSON.stringify(shift.vehicleData || {}), JSON.stringify(shift.fuelData || {}),
                    shift.generalNotes || '', shift.lastUpdate || new Date().toISOString(), shift.id
                ]
            );
        } else {
            await db.run(
                `INSERT INTO shifts (id, shift_name, shift_date, shift_type, total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, last_update) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    shift.id, shift.shiftName || '', shift.shiftDate || '', shift.shiftType || '', shift.totalReports || 0,
                    JSON.stringify(shift.rapidLocations || {}), JSON.stringify(shift.centersData || {}),
                    JSON.stringify(shift.vehicleData || {}), JSON.stringify(shift.fuelData || {}),
                    shift.generalNotes || '', shift.lastUpdate || new Date().toISOString()
                ]
            );
        }
        console.log('[SYNC] Shift synced to SQLite:', shift.id, shift.shiftType);
    } catch (err) {
        console.error('[SYNC] Failed to sync shift to SQLite:', err.message);
    }
}


// ============================================
// Logger (بسيط — يعمل حتى بدون winston)
// ============================================
const logger = {
  info: (...args) => console.log(`[${new Date().toISOString()}] [INFO]`, ...args),
  error: (...args) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...args),
  warn: (...args) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...args),
  debug: (...args) => process.env.DEBUG === '1' && console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args)
};

// RAG Engine for AI Assistant
let ragEngine = null;
let ragInstance = null;
let ragInitialized = false;
try {
    ragEngine = require('./rag-engine');
    ragInstance = new ragEngine.RAGEngine();
    console.log('✅ RAG Engine initialized');
} catch (err) {
    console.error('⚠️ RAG Engine failed to load:', err.message);
}

// New RAG KB API (replaces Nano AI backend)
const kbApi = require('./rag/kb-api');

const securityConfig = require('./config/security');
const app = express();
app.locals.db = db;
const PORT = process.env.PORT || 3002;

const { JWT_SECRET, JWT_EXPIRES_IN, JWT_ACCESS_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN, HELMET_CONFIG, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, LOGIN_RATE_LIMIT_MAX, JSON_LIMIT, URLENCODED_LIMIT, MAX_FILE_SIZE, OPS_MAX_FILE_SIZE, API_READ_LIMIT_WINDOW_MS, API_READ_LIMIT_MAX } = securityConfig;

// ============================================
// Validation Helper (بدون Zod — خفيف وفعال)
// ============================================
function validateBody(schema) {
    return (req, res, next) => {
        const errors = [];
        for (const [field, rules] of Object.entries(schema)) {
            const value = req.body[field];
            // Required check
            if (rules.required && (value === undefined || value === null || (typeof value === 'string' && value.trim() === ''))) {
                errors.push(`الحقل "${field}" مطلوب`);
                continue;
            }
            if (value === undefined || value === null) continue;
            // Type check
            if (rules.type === 'string' && typeof value !== 'string') {
                errors.push(`الحقل "${field}" يجب أن يكون نصاً`);
            }
            if (rules.type === 'number' && (typeof value !== 'number' || isNaN(value))) {
                errors.push(`الحقل "${field}" يجب أن يكون رقماً`);
            }
            if (rules.type === 'boolean' && typeof value !== 'boolean') {
                errors.push(`الحقل "${field}" يجب أن يكون boolean`);
            }
            if (rules.type === 'array' && !Array.isArray(value)) {
                errors.push(`الحقل "${field}" يجب أن يكون مصفوفة`);
            }
            // Min/Max for strings
            if (rules.type === 'string' && rules.minLength && value.length < rules.minLength) {
                errors.push(`الحقل "${field}" يجب أن يكون ${rules.minLength} أحرف على الأقل`);
            }
            if (rules.type === 'string' && rules.maxLength && value.length > rules.maxLength) {
                errors.push(`الحقل "${field}" يجب أن لا يتجاوز ${rules.maxLength} حرف`);
            }
            // Range for numbers
            if (rules.type === 'number' && rules.min !== undefined && value < rules.min) {
                errors.push(`الحقل "${field}" يجب أن يكون ${rules.min} على الأقل`);
            }
            if (rules.type === 'number' && rules.max !== undefined && value > rules.max) {
                errors.push(`الحقل "${field}" يجب أن لا يتجاوز ${rules.max}`);
            }
            // Pattern (regex)
            if (rules.pattern && !rules.pattern.test(value)) {
                errors.push(`الحقل "${field}" غير صالح`);
            }
        }
        if (errors.length > 0) {
            return res.status(400).json({ error: 'بيانات غير صالحة', details: errors });
        }
        next();
    };
}

// ============================================
// WebSocket Server - تحديث فوري (uses same HTTP server for Render compatibility)
// ============================================
var clients = [];
var wss = null; // Will be initialized after HTTP server starts

// Online users tracking: { userId: { ws, user, lastSeen } }
var onlineUsers = new Map();

function initWebSocket(server) {
    wss = new WebSocket.Server({ server, path: '/ws' });
    wss.on('connection', function(ws, req) {
        // Basic origin check for WebSocket
        const origin = req.headers.origin;
        const allowedOrigins = process.env.CORS_ORIGIN ? [process.env.CORS_ORIGIN] : [];
        if (process.env.NODE_ENV === 'production' && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
            ws.close(1008, 'Origin not allowed');
            return;
        }

        // Extract token from query string or headers
        const url = new URL(req.url, 'http://localhost');
        const token = url.searchParams.get('token') || req.headers['sec-websocket-protocol'];

        // JWT Authentication for WebSocket
        if (!token) {
            console.log('🔴 WebSocket rejected: no token');
            ws.close(1008, 'Authentication required');
            return;
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            ws.user = decoded; // { id, username, name, role }
            ws.isAuthenticated = true;
            ws.chatConversations = [];
            ws.lastSeen = Date.now();
            console.log('🟢 WebSocket authenticated:', ws.user.name, '(' + ws.user.id + ')');
        } catch (err) {
            console.log('🔴 WebSocket rejected: invalid token');
            ws.close(1008, 'Invalid token');
            return;
        }

        clients.push(ws);

        // Track online user
        if (ws.user && ws.user.id) {
            onlineUsers.set(ws.user.id, {
                ws: ws,
                user: ws.user,
                lastSeen: Date.now()
            });
            // Broadcast user_online to all connected WS clients (presence = chat — OV-S6: WS-only)
            broadcastToAll({
                type: 'user_online',
                userId: ws.user.id,
                name: ws.user.name,
                onlineUsers: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
            });
        }

        ws.send(JSON.stringify({ type: 'connected', message: 'متصل بالسيرفر', user: ws.user }));

        // Keep-Alive: send ping every 25 seconds to prevent Render timeout
        var pingInterval = setInterval(function() {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
            }
        }, 25000);

        ws.on('message', function(raw) {
            try {
                var msg = JSON.parse(raw);
                ws.lastSeen = Date.now();

                if (msg.type === 'chat_typing') {
                    // Only broadcast to conversation participants (DB-backed, fail-closed)
                    broadcastToConversation(msg.conversationId, { type: 'chat_typing', conversationId: msg.conversationId, user: ws.user })
                        .catch(function(e) { console.error('[WS] chat_typing broadcast error:', e.message); });
                }
                if (msg.type === 'chat_subscribe') {
                    ws.chatConversations = ws.chatConversations || [];
                    if (!ws.chatConversations.includes(msg.conversationId)) {
                        ws.chatConversations.push(msg.conversationId);
                    }
                    // Send current online users list to the subscriber
                    ws.send(JSON.stringify({
                        type: 'online_users',
                        users: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
                    }));
                }
                if (msg.type === 'chat_unsubscribe') {
                    if (ws.chatConversations) {
                        ws.chatConversations = ws.chatConversations.filter(function(id) { return id !== msg.conversationId; });
                    }
                }
                if (msg.type === 'chat_presence') {
                    // Update presence timestamp
                    if (ws.user && ws.user.id) {
                        const entry = onlineUsers.get(ws.user.id);
                        if (entry) {
                            entry.lastSeen = Date.now();
                        }
                    }
                    // Broadcast presence to all connected clients
                    broadcastToAll({
                        type: 'chat_presence',
                        userId: ws.user.id,
                        name: ws.user.name,
                        status: 'online',
                        timestamp: new Date().toISOString()
                    });
                }
                if (msg.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                }
                if (msg.type === 'logout') {
                    // Client is closing tab/browser — mark as offline immediately
                    console.log('👋 User logged out (tab close):', ws.user ? ws.user.name : 'unknown');
                    if (ws.user && ws.user.id) {
                        onlineUsers.delete(ws.user.id);
                        broadcastToAll({
                            type: 'user_offline',
                            userId: ws.user.id,
                            name: ws.user.name,
                            onlineUsers: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
                        });
                    }
                    ws.close(1000, 'User logged out');
                }
            } catch(e) {
                console.error('WebSocket message error:', e.message);
            }
        });

        ws.on('close', function() {
            console.log('🔴 WebSocket client disconnected:', ws.user ? ws.user.name : 'unknown');
            clearInterval(pingInterval);
            // Remove from online users
            if (ws.user && ws.user.id) {
                onlineUsers.delete(ws.user.id);
                // Broadcast user_offline to all connected WS clients (presence = chat — OV-S6: WS-only)
                broadcastToAll({
                    type: 'user_offline',
                    userId: ws.user.id,
                    name: ws.user.name,
                    onlineUsers: Array.from(onlineUsers.values()).map(u => ({ id: u.user.id, name: u.user.name, role: u.user.role }))
                });
            }
            clients = clients.filter(function(c) { return c !== ws; });
        });

        ws.on('error', function(err) {
            console.error('WebSocket error:', err);
        });
    });
    console.log('🔌 WebSocket server attached to HTTP server on /ws');
    
    // Heartbeat: remove stale connections every 30 seconds
    // Users who haven't sent any message in 60 seconds are considered offline
    setInterval(function() {
        var now = Date.now();
        var staleThreshold = 60000; // 60 seconds
        clients.forEach(function(client) {
            if (client.lastSeen && (now - client.lastSeen) > staleThreshold) {
                console.log('💀 Heartbeat timeout for:', client.user ? client.user.name : 'unknown');
                client.terminate(); // Force close stale connection
            }
        });
    }, 30000);
}

// دالة لبث الأحداث التشغيلية العامة لجميع المتصلين — SSE فقط.
// OV-S6 (قناة لحظية واحدة): SSE هو القناة الوحيدة للأحداث التشغيلية server→client.
// WebSocket محجوز حصرياً للشات ثنائي الاتجاه عبر الدوال الموجهة
// (broadcastToConversation / broadcastToAll / broadcastToRoles / broadcastToUsers).
// كان البث المزدوج (WS + SSE) يوصل كل حدث مرتين لكل عميل متصل بالقناتين
// (toast مزدوج + جلب مزدوج — OV-S4-01 / D-14).
function broadcast(data) {
    broadcastSSE(data);
}

// Helper: broadcast to conversation PARTICIPANTS only (DB-backed).
// SECURITY (OV-S8-01): private chat content must never leave the participant
// set. Participants are loaded from the database on every call; if the lookup
// fails we send to NOBODY (fail-closed) — never fall back to public broadcast.
async function broadcastToConversation(conversationId, data) {
    var message = JSON.stringify(data);
    var participantIds;
    try {
        if (!db || !db.ChatParticipants) {
            throw new Error('ChatParticipants store unavailable');
        }
        var rows = await db.ChatParticipants.getAll(conversationId);
        participantIds = (rows || []).map(function(r) { return String(r.user_id); });
    } catch (e) {
        console.error('[WS] FAIL-CLOSED: participant lookup failed for conversation', conversationId, '-', e.message);
        return; // fail-closed: do not deliver to anyone
    }

    var sentCount = 0;
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.user) {
            if (participantIds.indexOf(String(client.user.id)) !== -1) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (e) {
                    console.error('[WS] Participant broadcast error:', e.message);
                }
            }
        }
    });

    console.log('[WS] Broadcast to', sentCount, 'participant clients for conversation', conversationId, '- type:', data.type);
}

// Helper: broadcast to ALL authenticated connected clients
function broadcastToAll(data) {
    var message = JSON.stringify(data);
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (e) {
                console.error('Broadcast to all error:', e.message);
            }
        }
    });
}

// Helper: broadcast only to authenticated clients whose role is in `roles`
// (OV-S4-02: personal/privileged events must not reach every user)
function broadcastToRoles(roles, data) {
    var message = JSON.stringify(data);
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.user && roles.indexOf(client.user.role) !== -1) {
            try {
                client.send(message);
            } catch (e) {
                console.error('Broadcast to roles error:', e.message);
            }
        }
    });
}

// Helper: broadcast only to authenticated clients whose user id is in `userIds`
function broadcastToUsers(userIds, data) {
    var message = JSON.stringify(data);
    var ids = (userIds || []).map(function(id) { return String(id); });
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN && client.isAuthenticated && client.user && ids.indexOf(String(client.user.id)) !== -1) {
            try {
                client.send(message);
            } catch (e) {
                console.error('Broadcast to users error:', e.message);
            }
        }
    });
}

// Helper: get online users list
function getOnlineUsers() {
    return Array.from(onlineUsers.values()).map(function(u) {
        return { id: u.user.id, name: u.user.name, role: u.user.role };
    });
}

// ============================================
// مسار التخزين الرئيسي (Render Disk أو محلي)
// ============================================
// في Render: عيّن متغير البيئة RENDER_DISK_PATH = /data
// أو استخدم المسار الافتراضي داخل المشروع (للتطوير المحلي)
const STORAGE_PATH = process.env.RENDER_DISK_PATH || process.env.DATA_DIR || path.join(__dirname, 'data');

console.log('📂 مسار التخزين الرئيسي:', STORAGE_PATH);

// ============================================
// مسارات ملفات البيانات (على Render Disk)
// ============================================
const DATA_PATH = path.join(STORAGE_PATH, 'ambulance-data.json');
const SHIFT_DATA_PATH = path.join(STORAGE_PATH, 'shift-data.json');
const MONTHLY_TABLE_PATH = path.join(STORAGE_PATH, 'monthly-table.xlsx');
const DOCS_PATH = path.join(STORAGE_PATH, 'docs.json');
const AIR_PATH = path.join(STORAGE_PATH, 'air-ambulance.json');
const IDENTITY_PATH = path.join(STORAGE_PATH, 'identity.pdf');
const CONTROL_NOTES_PATH = path.join(STORAGE_PATH, 'control-notes.json');
const VACATIONS_PATH = path.join(STORAGE_PATH, 'vacations.json');
const PASSWORD_PATH = path.join(STORAGE_PATH, 'password.json');
const PEAK_DATA_PATH = path.join(STORAGE_PATH, 'peak-data.json');
const THEME_SETTINGS_PATH = path.join(STORAGE_PATH, 'theme-settings.json');
const USERS_PATH = path.join(STORAGE_PATH, 'users.json');
const SHIFT_EVENTS_PATH = path.join(STORAGE_PATH, 'shift-events.json');
const SHIFT_ABSENCES_PATH = path.join(STORAGE_PATH, 'shift-absences.json');
const SHIFT_NOTES_PATH = path.join(STORAGE_PATH, 'shift-notes.json');
const PEAK_PLANS_PATH = path.join(STORAGE_PATH, 'peak-plans.json');
const AUDIT_LOG_PATH = path.join(STORAGE_PATH, 'audit-log.json');
const INCIDENTS_PATH = path.join(STORAGE_PATH, 'incidents.json');
const SENIOR_SHIFTS_PATH = path.join(STORAGE_PATH, 'senior-shifts.json');
const E_CASES_PATH = path.join(STORAGE_PATH, 'e-cases.json');
const ESCALATIONS_PATH = path.join(STORAGE_PATH, 'escalations.json');
const SCHEDULE_EMPLOYEES_PATH = path.join(STORAGE_PATH, 'schedule-employees.json');
const SCHEDULE_FILES_PATH = path.join(STORAGE_PATH, 'schedule-files.json');
const REPORT_ENTRY_PATH = path.join(STORAGE_PATH, 'report-entry.json');
const DASHBOARD_PATH = path.join(STORAGE_PATH, 'dashboard.json');
const HOSPITALS_PATH = path.join(STORAGE_PATH, 'hospitals.json');
const REFERENCES_PATH = path.join(STORAGE_PATH, 'references.json');
const TIMELINE_PATH = path.join(STORAGE_PATH, 'timeline.json');
const UNIT_LOCATION_ADDRESSES_PATH = path.join(STORAGE_PATH, 'unit-location-addresses.json');
const UNIT_LOCATIONS_PATH = path.join(STORAGE_PATH, 'unit-locations.json');

// ============================================
// Shift Archive Engine v2.0 — Atomic Archive System
// ============================================
const archiveEngine = new ShiftArchiveEngine(db, STORAGE_PATH);
console.log('[ArchiveEngine] Shift Archive Engine v2.0 initialized');

let lastUpdateTime = Date.now();
// OV-S5: أُزيل المتغير العام currentShiftId نهائياً — حالة المناوبة تُشتق دائماً
// من القاعدة عبر OpsEngine (مصدر الحقيقة الوحيد)، لا من حالة ذاكرة قابلة للبَيات.

// ============================================
// نظام النوبة التلقائي (Auto-Shift System)
// ============================================
function getSaudiDateTime() {
    const now = new Date();
    // Get UTC time first, then add Saudi offset (+3)
    const utc = now.getTime() + (now.getTimezoneOffset() * 60 * 1000);
    return new Date(utc + (3 * 60 * 60 * 1000));
}

function getCurrentShiftType() {
    const saudiTime = getSaudiDateTime();
    const hour = saudiTime.getHours();
    // صباحية: 05:00 - 17:00 | ليلية: 17:00 - 05:00
    return (hour >= 5 && hour < 17) ? 'صباحية' : 'ليلية';
}

// Shift rows may store the short form ('صباح'/'ليل') while time-based lookups
// produce the long form ('صباحية'/'ليلية') — normalize before comparing.
function normalizeShiftType(t) {
    if (t === 'صباحية') return 'صباح';
    if (t === 'ليلية') return 'ليل';
    return t;
}

function getCurrentShiftDate() {
    const saudiTime = getSaudiDateTime();
    const year = saudiTime.getFullYear();
    const month = saudiTime.getMonth();
    const day = saudiTime.getDate();
    const hour = saudiTime.getHours();
    
    let shiftDate = new Date(year, month, day);
    
    // Night shift runs from 17:00 to 05:00 next day
    // If time is between 00:00 and 05:00, we are in the night shift that started yesterday
    if (hour >= 0 && hour < 5) {
        shiftDate.setDate(shiftDate.getDate() - 1);
    }
    
    const shiftYear = shiftDate.getFullYear();
    const shiftMonth = (shiftDate.getMonth() + 1).toString().padStart(2, '0');
    const shiftDay = shiftDate.getDate().toString().padStart(2, '0');
    return `${shiftYear}-${shiftMonth}-${shiftDay}`;
}

async function initDefaultUsers() {
    try {
        await fs.access(USERS_PATH);
    } catch {
        const salt = await bcrypt.genSalt(12);
        const employees = [
            { id: 'emp-4252', username: '4252', name: 'سلطان ابراهيم يوسف اليوسف التميمي', role: 'admin' },
            { id: 'emp-101353', username: '101353', name: 'هيثم حويكم هليل العنزي', role: 'admin' },
            { id: 'emp-102462', username: '102462', name: 'وليد معلا الحربي', role: 'admin' },
            { id: 'emp-11120', username: '11120', name: 'عوض عبدالعزيز عوض الاسمري', role: 'admin' },
            { id: 'emp-102752', username: '102752', name: 'محمد نايف صنهات العتيبي', role: 'admin' },
            { id: 'emp-10717', username: '10717', name: 'عطاالله خالد عطوي الرويلي', role: 'admin' },
            { id: 'emp-101915', username: '101915', name: 'مبارك هذال مبارك ال بريك', role: 'admin' },
            { id: 'emp-8323', username: '8323', name: 'تركي عتيق الله خيرالله المطيري', role: 'admin' },
            { id: 'emp-10373', username: '10373', name: 'سامي صالح عناد العنزي', role: 'admin' },
            { id: 'emp-6182', username: '6182', name: 'مشعل علي هديرس الحجيلي', role: 'admin' },
            { id: 'emp-9666', username: '9666', name: 'راشد محمد راشد الخرعان', role: 'admin' },
            { id: 'emp-11079', username: '11079', name: 'مبارك محسن مبارك العجمي', role: 'admin' },
            { id: 'emp-8745', username: '8745', name: 'خالد محمد عبدالمجيد العياضي', role: 'admin' },
            { id: 'emp-7454', username: '7454', name: 'عادل خليف دخيل المطيري', role: 'admin' },
            { id: 'emp-692', username: '692', name: 'فواز حميد خلاف الظفيري', role: 'admin' },
            { id: 'emp-61277', username: '61277', name: 'زياد سعيد جبران الشهراني', role: 'admin' },
            { id: 'emp-8968', username: '8968', name: 'موسى علي احمد غروي', role: 'admin' },
            { id: 'emp-61296', username: '61296', name: 'سامي منور عبدالله المطيري', role: 'admin' },
            { id: 'emp-6263', username: '6263', name: 'عبدالرحمن نائف مضحي الحربي', role: 'admin' }
        ];
        const defaultUsers = [];
        for (const emp of employees) {
            const tempPassword = emp.username; // الرقم السري المؤقت = الكود
            defaultUsers.push({
                id: emp.id,
                username: emp.username,
                name: emp.name,
                password: await bcrypt.hash(tempPassword, salt),
                role: emp.role,
                isActive: true
            });
        }
        await fs.writeFile(USERS_PATH, JSON.stringify(defaultUsers, null, 2));
        console.log('✅ تم إنشاء 19 مستخدم للموظفين');
        console.log('⚠️  الرقم السري المؤقت لكل موظف = كود الموظف (الرقم)');
        console.log('🔒 يجب على كل موظف تغيير رقمه السري بعد أول تسجيل دخول');
    }
}

async function ensureDataDir() {
    try {
        // المجلد الرئيسي على Render Disk (أو محلي)
        await fs.mkdir(STORAGE_PATH, { recursive: true });
        await fs.mkdir(path.join(STORAGE_PATH, 'temp'), { recursive: true });
        // مجلد رفع الملفات على Render Disk
        await fs.mkdir(path.join(STORAGE_PATH, 'uploads'), { recursive: true });
        await fs.mkdir(path.join(STORAGE_PATH, 'uploads', 'operational'), { recursive: true });
        await fs.mkdir(path.join(STORAGE_PATH, 'uploads', 'chat'), { recursive: true });
        await initDefaultUsers();
        // OV-S5: لا استعادة لحالة مناوبة في الذاكرة عند الإقلاع —
        // المناوبة النشطة تُقرأ من القاعدة عند كل طلب (مصدر الحقيقة الوحيد).
        console.log('✅ تم التأكد من وجود مجلدات البيانات');
    } catch (e) {
        console.error('❌ خطأ في إنشاء مجلدات البيانات:', e.message);
    }
}
ensureDataDir();

// ============================================
// Security & Performance Middleware
// ============================================
// 1. Security Headers (Helmet)
app.use(helmet(HELMET_CONFIG));

// 2. Gzip Compression
// OV-S6: استثناء SSE من الضغط — compression يخزّن استجابة text/event-stream
// مؤقتاً (المتصفح يرسل Accept-Encoding: gzip) فيبقى EventSource عالقاً في
// CONNECTING ولا يصل أي حدث لحظي للمتصفح إطلاقاً (كان الاستطلاع الاحتياطي
// كل 3 ثوانٍ يخفي العطل). القناة اللحظية الواحدة تعتمد على SSE حياً في المتصفح.
app.use(compression({
    filter: function (req, res) {
        if (req.path === '/api/sse') return false;
        if (res.getHeader('Content-Type') === 'text/event-stream') return false;
        return compression.filter(req, res);
    }
}));

// 3. CORS
app.use(cors({
    origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : '*'),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 3.5 Trust proxy (required for Render and other reverse proxies)
app.set('trust proxy', 1);

// 4. Static Files (BEFORE rate limiting — never rate-limit assets)
const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: process.env.NODE_ENV === 'production' ? ONE_YEAR : 0,
    etag: true,
    lastModified: true
}));
app.use('/forms', express.static(path.join(__dirname, 'public/forms'), {
    maxAge: process.env.NODE_ENV === 'production' ? ONE_YEAR : 0
}));
// ⭐ مهم: الملفات المرفوعة تُقرأ من Render Disk وليس من public/
// REMOVED: Static /uploads route — files must be downloaded via authenticated /api/download-operational/:id only
// app.use('/uploads', express.static(path.join(STORAGE_PATH, 'uploads'), { maxAge: ONE_YEAR }));

// 5. Body Parser (reduced limits)
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ limit: URLENCODED_LIMIT, extended: true }));

// 6. Global Rate Limiting (skip static files & health check)
const globalLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_REQUESTS,
    message: { error: 'عدد الطلبات مرتفع جداً. الرجاء المحاولة لاحقاً.' },
    standardHeaders: true,
    legacyHeaders: false,
    // Fix for Render/reverse proxy: skip X-Forwarded-For validation
    validate: { xForwardedForHeader: false },
    skip: (req) => {
        // Never rate-limit health checks, static assets, or WebSocket upgrade
        if (req.path === '/health') return true;
        if (req.path.startsWith('/sw.js')) return true;
        if (req.path.startsWith('/manifest.json')) return true;
        if (req.headers.upgrade === 'websocket') return true;
        return false;
    }
});
app.use(globalLimiter);

// 8. Login Rate Limiting (stricter)
const loginLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: LOGIN_RATE_LIMIT_MAX,
    message: { error: 'عدد محاولات تسجيل الدخول مرتفع جداً. الرجاء المحاولة لاحقاً.' },
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
});
app.use('/api/auth/login', loginLimiter);

async function logAuthEvent(userId, username, actionType, detail, success, errorMessage, sessionId, req) {
    try {
        if (db && db.AuthLogs) {
            await db.AuthLogs.create({
                user_id: userId,
                username: username,
                action_type: actionType,
                action_detail: detail,
                ip_address: req?.ip || req?.headers['x-forwarded-for'] || 'unknown',
                user_agent: req?.headers['user-agent'] || 'unknown',
                session_id: sessionId,
                success: success,
                error_message: errorMessage
            });
        }
    } catch (e) {
        console.error('Auth log error:', e.message);
    }
}

async function authenticate(req, res, next) {
    // Try Authorization header first (standard API calls)
    const authHeader = req.headers['authorization'];
    let token = authHeader && authHeader.split(' ')[1];
    
    // Fallback to query string (for SSE/EventSource which doesn't support custom headers)
    if (!token && req.query && req.query.token) {
        token = req.query.token;
    }
    
    if (!token) return res.status(401).json({ error: 'مطلوب توكن المصادقة' });
    
    // Check blacklist
    try {
        if (db && db.TokenBlacklist) {
            const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
            const isBlacklisted = await db.TokenBlacklist.isBlacklisted(tokenHash);
            if (isBlacklisted) {
                return res.status(403).json({ error: 'التوكن مُلغى، يرجى تسجيل الدخول مرة أخرى', code: 'TOKEN_REVOKED' });
            }
        }
    } catch (e) { /* ignore blacklist check errors */ }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET, { clockTolerance: 60 });
        
        // Check if user is still active in database
        if (db && db.Users && db.Users.getByUserId) {
            try {
                const user = await db.Users.getByUserId(decoded.id);
                if (!user || !user.is_active) {
                    return res.status(403).json({ error: 'المستخدم غير نشط', code: 'USER_INACTIVE' });
                }
            } catch (e) {
                // ignore DB errors, continue with decoded token
            }
        }
        
        req.user = decoded;
        
        // Update session_last_active if db available
        try {
            if (db && db.AuthSessions && db.AuthSessions.getByUser) {
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                const sessions = await db.AuthSessions.getByUser(decoded.id);
                const session = sessions && sessions.find(s => s.access_token_hash === tokenHash && s.is_active);
                if (session) {
                    await db.AuthSessions.update(session.id, { session_last_active: new Date().toISOString() });
                }
            }
        } catch (e) { /* ignore session update errors */ }
        
        next();
    } catch (error) {
        res.setHeader('X-Token-Invalid', 'true');
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'انتهت صلاحية التوكن', code: 'TOKEN_EXPIRED', expiredAt: error.expiredAt });
        }
        return res.status(403).json({ error: 'توكن غير صالح', code: 'TOKEN_INVALID' });
    }
}

function authorize(roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'مطلوب تسجيل الدخول' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ليس لديك الصلاحية' });
        next();
    };
}

// ============================================
// SSE - تحديثات فورية عبر Server-Sent Events
// ============================================
var sseClients = []; // مصفوفة عملاء SSE

// دالة لإضافة عميل SSE وإرسال التحديثات
function broadcastSSE(data) {
    var message = 'data: ' + JSON.stringify(data) + '\n\n';
    sseClients = sseClients.filter(function(client) {
        try {
            client.res.write(message);
            return true;
        } catch (e) {
            console.error('SSE broadcast error:', e.message);
            return false;
        }
    });
}

// ============================================
// API: SSE Endpoint
// ============================================
app.get('/api/sse', authenticate, function(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no' // Disable nginx buffering if behind proxy
    });
    // إرسال رسالة أولية للتأكد من الاتصال
    res.write('data: ' + JSON.stringify({ type: 'connected', message: 'متصل بـ SSE', user: req.user }) + '\n\n');
    var client = { res: res, user: req.user, id: Date.now() + Math.random() };
    sseClients.push(client);
    console.log('🟢 SSE client connected:', req.user.name, '(' + req.user.id + ')');
    
    // Keep-alive heartbeat every 15 seconds to prevent Render timeout
    var heartbeatInterval = setInterval(function() {
        try {
            res.write(':heartbeat\n\n'); // Comment line keeps connection alive
        } catch(e) {
            clearInterval(heartbeatInterval);
        }
    }, 15000);
    
    // إزالة العميل عند الإغلاق
    req.on('close', function() {
        clearInterval(heartbeatInterval);
        sseClients = sseClients.filter(function(c) { return c !== client; });
        console.log('🔴 SSE client disconnected:', req.user.name);
    });
});

// ============================================
// Health Check (للـ Render Monitoring + Uptime)
// ============================================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        version: '2.0.0',
        env: process.env.NODE_ENV || 'development',
        memory: {
            rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
            external: Math.round(mem.external / 1024 / 1024) + ' MB'
        },
        checks: {
            storage: !!process.env.DATA_DIR || !!process.env.RENDER_DISK_PATH,
            jwt: !!process.env.JWT_SECRET,
            websocket: !!wss
        }
    };
    if (aiMonitor) {
        health.aiMonitor = {
            stats: aiMonitor.getStats(),
            health: aiMonitor.getHealth(),
            alerts: aiMonitor.getAlerts()
        };
    }
    res.json(health);
});

// ============================================
// API: المصادقة (JWT)
// ============================================
app.post('/api/auth/login', validateBody({
    username: { required: true, type: 'string', minLength: 1, maxLength: 50 },
    password: { required: true, type: 'string', minLength: 1, maxLength: 100 }
}), async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبة' });
        
        const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
        const user = users.find(u => u.username === username && u.isActive);
        if (!user) {
            await logAuthEvent(null, username, 'login', 'login attempt', false, 'اسم المستخدم أو كلمة المرور غير صحيحة', null, req);
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            await logAuthEvent(user.id, user.username, 'login', 'login attempt', false, 'اسم المستخدم أو كلمة المرور غير صحيحة', null, req);
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }
        
        const jti = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        const tokenPayload = { id: user.id, username: user.username, name: user.name, role: user.role, jti };
        const accessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_ACCESS_EXPIRES_IN || '15m' });
        const refreshToken = jwt.sign({ ...tokenPayload, type: 'refresh' }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES_IN || '7d' });
        
        let sessionId = null;
        try {
            if (db && db.AuthSessions) {
                const accessTokenHash = crypto.createHash('sha256').update(accessToken).digest('hex');
                const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
                const sessionExpires = new Date();
                sessionExpires.setMinutes(sessionExpires.getMinutes() + 15);
                const refreshExpires = new Date();
                refreshExpires.setDate(refreshExpires.getDate() + 7);
                const session = await db.AuthSessions.create({
                    user_id: user.id,
                    username: user.username,
                    access_token_hash: accessTokenHash,
                    refresh_token_hash: refreshTokenHash,
                    ip_address: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                    user_agent: req.headers['user-agent'] || 'unknown',
                    session_expires: sessionExpires.toISOString(),
                    refresh_expires: refreshExpires.toISOString(),
                    expires_at: refreshExpires.toISOString(),
                    is_active: true
                });
                sessionId = session?.id || null;
            }
        } catch (e) {
            console.error('Session creation error:', e.message);
        }
        
        await logAuthEvent(user.id, user.username, 'login', 'login successful', true, null, sessionId, req);
        
        // Broadcast login notification to privileged roles only (OV-S4-02)
        broadcastToRoles(['admin', 'director'], {
            type: 'user_login',
            message: 'تسجيل دخول جديد: ' + user.name,
            user: { id: user.id, name: user.name, role: user.role }
        });
        
        // Audit log
        await addAuditLogEntry('user_login', 'تسجيل دخول للنظام', 'auth', user.name, user.role, user.id);
        
        res.json({
            success: true,
            accessToken,
            refreshToken,
            user: { id: user.id, username: user.username, name: user.name, role: user.role }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'فشل في تسجيل الدخول' });
    }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
    try {
        // If JWT doesn't have name (old token), get it from users.json
        let user = req.user;
        if (!user.name) {
            const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
            const fullUser = users.find(u => u.id === user.id || u.username === user.username);
            if (fullUser) {
                user = { ...user, name: fullUser.name };
            }
        }
        
        // Optional: check if session is still active in DB
        let sessionValid = true;
        try {
            if (db && db.AuthSessions && db.AuthSessions.getByUser) {
                const sessions = await db.AuthSessions.getByUser(user.id);
                sessionValid = sessions && sessions.some(s => s.is_active);
            }
        } catch (e) { /* ignore session check errors */ }
        
        res.json({ success: true, user, sessionValid });
    } catch (error) {
        res.json({ success: true, user: req.user });
    }
});

// Token refresh endpoint - exchanges refreshToken for a new accessToken
app.post('/api/auth/refresh', async (req, res) => {
    try {
        const { refreshToken } = req.body;
        const authHeader = req.headers['authorization'];
        const tokenFromHeader = authHeader && authHeader.split(' ')[1];
        const tokenToUse = refreshToken || tokenFromHeader;
        
        if (!tokenToUse) {
            return res.status(401).json({ error: 'مطلوب refresh token' });
        }
        
        // Check blacklist
        try {
            if (db && db.TokenBlacklist) {
                const tokenHash = crypto.createHash('sha256').update(tokenToUse).digest('hex');
                const isBlacklisted = await db.TokenBlacklist.isBlacklisted(tokenHash);
                if (isBlacklisted) {
                    return res.status(403).json({ error: 'التوكن مُلغى، يرجى تسجيل الدخول مرة أخرى', code: 'TOKEN_REVOKED' });
                }
            }
        } catch (e) { /* ignore */ }
        
        let decoded;
        try {
            decoded = jwt.verify(tokenToUse, JWT_SECRET, { clockTolerance: 60 });
            if (decoded.type !== 'refresh') {
                return res.status(403).json({ error: 'نوع التوكن غير صالح', code: 'TOKEN_INVALID' });
            }
        } catch (err) {
            if (err.name === 'TokenExpiredError') {
                return res.status(401).json({ error: 'انتهت صلاحية refresh token', code: 'TOKEN_EXPIRED' });
            }
            return res.status(403).json({ error: 'توكن غير صالح', code: 'TOKEN_INVALID' });
        }
        
        // Verify session is active in DB
        try {
            if (db && db.AuthSessions && db.AuthSessions.getByUser) {
                const sessions = await db.AuthSessions.getByUser(decoded.id);
                const refreshTokenHash = crypto.createHash('sha256').update(tokenToUse).digest('hex');
                const activeSession = sessions && sessions.find(s => s.refresh_token_hash === refreshTokenHash && s.is_active);
                if (!activeSession) {
                    return res.status(403).json({ error: 'الجلسة غير نشطة أو منتهية', code: 'SESSION_INVALID' });
                }
            }
        } catch (e) {
            console.error('Session check error:', e.message);
        }
        
        // Get user from database to ensure still active
        const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
        const user = users.find(u => u.id === decoded.id && u.isActive);
        if (!user) {
            return res.status(403).json({ error: 'المستخدم غير موجود أو غير نشط' });
        }
        
        const tokenPayload = { id: user.id, username: user.username, name: user.name, role: user.role };
        const newAccessToken = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: JWT_ACCESS_EXPIRES_IN || '15m' });
        
        // Update session with new access token hash and last active
        try {
            if (db && db.AuthSessions && db.AuthSessions.getByUser) {
                const sessions = await db.AuthSessions.getByUser(decoded.id);
                const refreshTokenHash = crypto.createHash('sha256').update(tokenToUse).digest('hex');
                const session = sessions && sessions.find(s => s.refresh_token_hash === refreshTokenHash && s.is_active);
                if (session) {
                    const newAccessTokenHash = crypto.createHash('sha256').update(newAccessToken).digest('hex');
                    const sessionExpires = new Date();
                    sessionExpires.setMinutes(sessionExpires.getMinutes() + 15);
                    await db.AuthSessions.update(session.id, {
                        access_token_hash: newAccessTokenHash,
                        session_last_active: new Date().toISOString(),
                        session_expires: sessionExpires.toISOString()
                    });
                }
            }
        } catch (e) {
            console.error('Session update error:', e.message);
        }
        
        res.json({ success: true, accessToken: newAccessToken, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    } catch (error) {
        console.error('Token refresh error:', error);
        res.status(500).json({ error: 'فشل في تجديد التوكن' });
    }
});

app.post('/api/auth/logout', authenticate, async (req, res) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];
        
        let sessionToDeactivate = null;
        
        // Find the specific session by access token hash
        if (token) {
            try {
                if (db && db.AuthSessions && db.AuthSessions.getByUser) {
                    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                    const sessions = await db.AuthSessions.getByUser(req.user.id);
                    sessionToDeactivate = sessions && sessions.find(s => s.access_token_hash === tokenHash && s.is_active);
                }
            } catch (e) {
                console.error('Session lookup error:', e.message);
            }
        }
        
        // Blacklist access token
        if (token) {
            try {
                const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
                if (db && db.TokenBlacklist) {
                    await db.TokenBlacklist.add(tokenHash);
                }
            } catch (e) {
                console.error('Token blacklist error:', e.message);
            }
        }
        
        // Blacklist refresh token and deactivate specific session
        try {
            if (db && db.AuthSessions && sessionToDeactivate) {
                if (db && db.TokenBlacklist && sessionToDeactivate.refresh_token_hash) {
                    await db.TokenBlacklist.add(sessionToDeactivate.refresh_token_hash);
                }
                await db.AuthSessions.update(sessionToDeactivate.id, { is_active: false });
            }
        } catch (e) {
            console.error('Session deactivate error:', e.message);
        }
        
        await logAuthEvent(req.user.id, req.user.username, 'logout', 'logout successful', true, null, sessionToDeactivate?.id || null, req);
        
        res.json({ success: true, message: 'تم تسجيل الخروج' });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'فشل في تسجيل الخروج' });
    }
});

// List active sessions (admin only)
app.get('/api/auth/sessions', authenticate, authorize(['admin']), async (req, res) => {
    try {
        if (!db || !db.AuthSessions) {
            return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        }
        
        let sessions = [];
        if (db.all) {
            sessions = await db.all(
                'SELECT id, user_id, username, ip_address, user_agent, session_expires, refresh_expires, session_last_active, session_start, is_active FROM auth_sessions WHERE is_active = 1 ORDER BY session_last_active DESC'
            );
        }
        
        res.json({ success: true, sessions });
    } catch (error) {
        console.error('Sessions list error:', error);
        res.status(500).json({ error: 'فشل في جلب الجلسات' });
    }
});

app.post('/api/auth/change-password', authenticate, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'كلمة المرور الحالية والجديدة مطلوبة' });
        }
        if (newPassword.length < 4) {
            return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل' });
        }

        const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
        const userIndex = users.findIndex(u => u.username === req.user.username && u.isActive);
        if (userIndex === -1) return res.status(404).json({ error: 'المستخدم غير موجود' });

        const user = users[userIndex];
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });

        const salt = await bcrypt.genSalt(12);
        users[userIndex].password = await bcrypt.hash(newPassword, salt);
        await fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2));

        broadcastToUsers([user.id], { type: 'password_changed', message: 'تم تغيير كلمة المرور', username: user.username });
        res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'فشل في تغيير كلمة المرور' });
    }
});

app.get('/api/users', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
        res.json({ success: true, users: users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, isActive: u.isActive })) });
    } catch (error) { res.status(500).json({ error: 'فشل في جلب المستخدمين' }); }
});

// ============================================
// PWA routes
// ============================================
app.get('/manifest.json', function(req, res) {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', function(req, res) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'sw.js'));
});

// ============================================
// إعداد Multer لرفع الملفات (مع حماية أفضل)
// ============================================
const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];

const upload = multer({
    dest: path.join(STORAGE_PATH, 'temp'),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: function(req, file, cb) {
        if (ALLOWED_UPLOAD_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح: ' + file.mimetype));
        }
    }
});

// ============================================
// Multer مخصص لملفات Excel (أكثر مرونة)
// ============================================
const EXCEL_MIME_TYPES = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'application/octet-stream'
];
const EXCEL_EXTENSIONS = ['.xlsx', '.xls'];

const uploadExcel = multer({
    dest: path.join(STORAGE_PATH, 'temp'),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: function(req, file, cb) {
        const ext = path.extname(file.originalname || '').toLowerCase();
        // السماح بأي ملف امتداده .xlsx أو .xls حتى لو MIME type غير واضح
        if (EXCEL_EXTENSIONS.includes(ext)) {
            cb(null, true);
        } else if (EXCEL_MIME_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح. يُسمح فقط بملفات Excel (.xlsx, .xls). نوع الملف المستلم: ' + file.mimetype + ', الامتداد: ' + ext));
        }
    }
});

// Multer error handler middleware
function handleMulterError(err, req, res, next) {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'حجم الملف كبير جداً. الحد الأقصى 20 ميجابايت.' });
        }
        return res.status(400).json({ error: 'خطأ في رفع الملف: ' + err.message });
    } else if (err) {
        return res.status(400).json({ error: err.message });
    }
    next();
}

// ============================================
// Chat Upload Multer
// ============================================
const uploadChat = multer({
    dest: path.join(STORAGE_PATH, 'temp'),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: function(req, file, cb) {
        cb(null, true);
    }
});

// ============================================
// بيانات قطاع الجنوب
// ============================================
let centersData = {
    "المنصورة": ["جنوب 1", "جنوب 11", "جنوب 12", "سريع 3"],
    "الخالدية": ["جنوب 2"],
    "منفوحة": ["جنوب 3"],
    "الدار البيضاء": ["جنوب 4", "جنوب 5", "سريع 1"],
    "الإسكان": ["جنوب 6"],
    "الحائر": ["جنوب 7"],
    "ديراب": ["جنوب 10"],
    "عكاظ": ["جنوب 9"],
    "الشفاء": ["جنوب 8", "سريع 2"],
    "الفرق الإضافية": ["سريع 4", "جنوب 13", "جنوب 14", "جنوب 15", "جنوب 16", "جنوب 17", "جنوب 18", "جنوب 19"]
};

// ============================================
// دوال قراءة وكتابة البيانات
// ============================================
async function readData() {
    try {
        const data = await fs.readFile(DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

// ═══ Slice 2 (X2): shifts read from SQLite — the single source of truth ═══
// shift-data.json is kept as a frozen legacy fallback only. All ~30 callers
// keep working unchanged: rows are normalized to the legacy camelCase shape.
function normalizeShiftRow(row) {
    const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
    return {
        id: row.id,
        shiftName: row.shift_name,
        shiftDate: row.shift_date,
        shiftTime: row.shift_time,
        shiftType: row.shift_type,
        shiftDay: row.shift_day,
        startTime: row.start_time,
        totalReports: row.total_reports || 0,
        rapidLocations: parseJson(row.rapid_locations, {}),
        centersData: parseJson(row.centers_data, {}),
        vehicleData: parseJson(row.vehicle_data, {}),
        fuelData: parseJson(row.fuel_data, {}),
        generalNotes: row.general_notes || '',
        lastUpdate: row.last_update,
        status: row.status || 'active',
        archivedAt: row.archived_at,
        createdAt: row.created_at
    };
}

async function readShifts() {
    try {
        if (db && db.Shifts && db.Shifts.getAll) {
            const rows = await db.Shifts.getAll();
            if (rows && rows.length > 0) return rows.map(normalizeShiftRow);
        }
    } catch (e) {
        console.warn('[readShifts] SQLite read failed, falling back to JSON:', e.message);
    }
    try {
        const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

// ═══ Archive slice: مخازن محتوى المناوبة الموحدة (SQLite single source) ═══
// The legacy JSON files (notes/events/absences/peak-plans/report-entry) are
// frozen; rows keep their legacy string ids and full payload in `data`.
function contentRowToJson(row) {
    let data = {};
    try { data = row.data ? JSON.parse(row.data) : {}; } catch (e) {}
    return { ...data, id: row.id, shiftId: row.shift_id };
}
async function contentList(table) {
    const rows = await db.all(`SELECT * FROM ${table} ORDER BY created_at DESC, id DESC`);
    return rows.map(contentRowToJson);
}
async function contentListByShift(table, shiftId) {
    const rows = await db.all(`SELECT * FROM ${table} WHERE shift_id = ? ORDER BY created_at DESC, id DESC`, [shiftId]);
    return rows.map(contentRowToJson);
}
async function contentInsert(table, shiftId, obj) {
    const sid = shiftId != null ? shiftId : (obj.shiftId != null ? obj.shiftId : null);
    await db.run(`INSERT INTO ${table} (id, shift_id, data) VALUES (?, ?, ?)`, [String(obj.id), sid, JSON.stringify(obj)]);
}
async function withTx(fn) {
    if (opsEngine && typeof opsEngine.runInTransaction === 'function') return opsEngine.runInTransaction(fn);
    return fn();
}
async function getActiveShiftId() {
    try {
        const active = opsEngine && opsEngine.shifts ? await opsEngine.shifts.getActiveShift() : null;
        return active ? active.id : null;
    } catch (e) { return null; }
}

async function writeShifts(data) {
    await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(data, null, 2));
}

// ═══ Phase 2+3: JSON → SQLite migration helpers ═══
async function migrateJsonShiftToSqlite(jsonShift) {
    // Migrate a shift from JSON file to SQLite table
    try {
        if (!dbAvailable() || !db.run) return null;
        
        // Check if already migrated
        const existing = await opsService.getShiftById(jsonShift.id);
        if (existing) return jsonShift.id;
        
        // Insert into SQLite
        await db.run(
            `INSERT INTO shifts (id, shift_name, shift_date, shift_time, shift_type, shift_day, start_time, 
             total_reports, rapid_locations, centers_data, vehicle_data, fuel_data, general_notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
            [
                jsonShift.id,
                jsonShift.shiftName || jsonShift.shift_name || '',
                jsonShift.shiftDate || jsonShift.shift_date || '',
                jsonShift.shiftTime || jsonShift.shift_time || '',
                jsonShift.shiftType || jsonShift.shift_type || '',
                jsonShift.shiftDay || jsonShift.shift_day || '',
                jsonShift.startTime || jsonShift.start_time || '',
                jsonShift.totalReports || jsonShift.total_reports || 0,
                JSON.stringify(jsonShift.rapidLocations || []),
                JSON.stringify(jsonShift.centersData || {}),
                JSON.stringify(jsonShift.vehicleData || {}),
                JSON.stringify(jsonShift.fuelData || {}),
                jsonShift.generalNotes || jsonShift.general_notes || '',
                jsonShift.status || 'active'
            ]
        );
        
        console.log('[Migrate] Shift', jsonShift.id, 'migrated from JSON to SQLite');
        return jsonShift.id;
    } catch (err) {
        console.error('[Migrate] Failed:', err.message);
        return null;
    }
}

async function updateShiftInJson(shiftId, updates) {
    // Update a shift in JSON file (legacy fallback)
    try {
        const shifts = await readShifts();
        const idx = shifts.findIndex(s => s.id === shiftId);
        if (idx === -1) return false;
        
        shifts[idx] = Object.assign({}, shifts[idx], updates);
        shifts[idx].lastUpdate = new Date().toISOString();
        await writeShifts(shifts);
        return true;
    } catch (err) {
        console.error('[UpdateShiftJson] Failed:', err.message);
        return false;
    }
}

async function readDocs() {
    try {
        const data = await fs.readFile(DOCS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeDocs(data) {
    await fs.writeFile(DOCS_PATH, JSON.stringify(data, null, 2));
}

async function readAirRecords() {
    try {
        const data = await fs.readFile(AIR_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeAirRecords(data) {
    await fs.writeFile(AIR_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال الرقم السري
// ============================================
async function readPassword() {
    try {
        const data = await fs.readFile(PASSWORD_PATH, 'utf8');
        const parsed = JSON.parse(data);
        return parsed.password || '1234';
    } catch (error) {
        if (error.code === 'ENOENT') return '1234';
        return '1234';
    }
}

async function writePassword(password) {
    await fs.writeFile(PASSWORD_PATH, JSON.stringify({ password, updatedAt: new Date().toISOString() }));
}

// ============================================
// دوال وقت الذروة
// ============================================
async function readPeakData() {
    try {
        const data = await fs.readFile(PEAK_DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return { missions: [], alerts: [], logs: [] };
        return { missions: [], alerts: [], logs: [] };
    }
}

async function writePeakData(data) {
    await fs.writeFile(PEAK_DATA_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال الثيمات العامة
// ============================================
async function readThemeSettings() {
    try {
        const data = await fs.readFile(THEME_SETTINGS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return { fileType: null, fileName: null };
        return { fileType: null, fileName: null };
    }
}

async function writeThemeSettings(data) {
    await fs.writeFile(THEME_SETTINGS_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال سجل الأحداث والغيابات والملاحظات للمناوبات
// ============================================
async function readShiftEvents() {
    try {
        const data = await fs.readFile(SHIFT_EVENTS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeShiftEvents(data) {
    await fs.writeFile(SHIFT_EVENTS_PATH, JSON.stringify(data, null, 2));
}

async function readShiftAbsences() {
    try {
        const data = await fs.readFile(SHIFT_ABSENCES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeShiftAbsences(data) {
    await fs.writeFile(SHIFT_ABSENCES_PATH, JSON.stringify(data, null, 2));
}

async function readShiftNotes() {
    try {
        const data = await fs.readFile(SHIFT_NOTES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeShiftNotes(data) {
    await fs.writeFile(SHIFT_NOTES_PATH, JSON.stringify(data, null, 2));
}

async function readPeakPlans() {
    try {
        const data = await fs.readFile(PEAK_PLANS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writePeakPlans(data) {
    await fs.writeFile(PEAK_PLANS_PATH, JSON.stringify(data, null, 2));
}

async function readAuditLog() {
    try {
        const data = await fs.readFile(AUDIT_LOG_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeAuditLog(data) {
    await fs.writeFile(AUDIT_LOG_PATH, JSON.stringify(data, null, 2));
}

async function addAuditLogEntry(action, details, category, user, role, userId, shiftId = null) {
    try {
        const logs = await readAuditLog();
        const newEntry = {
            id: Date.now().toString(),
            action,
            details: details || '',
            category: category || 'general',
            user: user || 'غير معروف',
            role: role || 'unknown',
            userId: userId || null,
            shift_id: shiftId,
            timestamp: new Date().toISOString()
        };
        logs.unshift(newEntry);
        if (logs.length > 500) logs.pop();
        await writeAuditLog(logs);
        
        // Also save to SQLite audit_log if available
        try {
            if (dbAvailable() && db.AuditLog) {
                await db.AuditLog.create({
                    shift_id: shiftId || null,
                    user_id: userId || null,
                    user_name: user || 'غير معروف',
                    action: action,
                    detail: details || '',
                    type: category || 'general'
                });
            }
        } catch (dbErr) {
            console.log('[DB] SQLite audit_log save failed in helper:', dbErr.message);
        }
        
        // OV-S4-02: audit trail entries are privileged — admins/directors only
        broadcastToRoles(['admin', 'director'], {
            type: 'audit_log_added',
            message: 'تم إضافة سجل تدقيق جديد',
            entry: newEntry
        });
        return newEntry;
    } catch (error) {
        console.error('Audit log error:', error);
        return null;
    }
}

// ============================================
// دوال سجلات الحوادث
// ============================================
async function readIncidents() {
    try {
        const data = await fs.readFile(INCIDENTS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeIncidents(data) {
    await fs.writeFile(INCIDENTS_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال مناوبات كبار الضباط
// ============================================
async function readSeniorShifts() {
    try {
        const data = await fs.readFile(SENIOR_SHIFTS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeSeniorShifts(data) {
    await fs.writeFile(SENIOR_SHIFTS_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال حالات الطوارئ (E-Cases)
// ============================================
async function readECases() {
    try {
        const data = await fs.readFile(E_CASES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeECases(data) {
    await fs.writeFile(E_CASES_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال بلاغات التصعيد
// ============================================
async function readEscalations() {
    try {
        const data = await fs.readFile(ESCALATIONS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeEscalations(data) {
    await fs.writeFile(ESCALATIONS_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال الجدولة الذكية
// ============================================
async function readScheduleEmployees() {
    try {
        const data = await fs.readFile(SCHEDULE_EMPLOYEES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeScheduleEmployees(data) {
    await fs.writeFile(SCHEDULE_EMPLOYEES_PATH, JSON.stringify(data, null, 2));
}

async function readScheduleFiles() {
    try {
        const data = await fs.readFile(SCHEDULE_FILES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeScheduleFiles(data) {
    await fs.writeFile(SCHEDULE_FILES_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال تسجيل البلاغات (Report Entry)
// ============================================
async function readReportEntry() {
    try {
        const data = await fs.readFile(REPORT_ENTRY_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeReportEntry(data) {
    await fs.writeFile(REPORT_ENTRY_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// دوال غرفة العمليات (Operations Command)
// ============================================
async function readDashboard() {
    try {
        const data = await fs.readFile(DASHBOARD_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeDashboard(data) {
    await fs.writeFile(DASHBOARD_PATH, JSON.stringify(data, null, 2));
}

async function readHospitals() {
    try {
        const data = await fs.readFile(HOSPITALS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeHospitals(data) {
    await fs.writeFile(HOSPITALS_PATH, JSON.stringify(data, null, 2));
}

async function readReferences() {
    try {
        const data = await fs.readFile(REFERENCES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeReferences(data) {
    await fs.writeFile(REFERENCES_PATH, JSON.stringify(data, null, 2));
}

async function readTimeline() {
    try {
        const data = await fs.readFile(TIMELINE_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeTimeline(data) {
    await fs.writeFile(TIMELINE_PATH, JSON.stringify(data, null, 2));
}

async function readAnnouncements() {
    try {
        const data = await fs.readFile(ANNOUNCEMENTS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        return [];
    }
}

async function writeAnnouncements(data) {
    await fs.writeFile(ANNOUNCEMENTS_PATH, JSON.stringify(data, null, 2));
}

async function readUnitLocations() {
    try {
        const data = await fs.readFile(UNIT_LOCATIONS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            // Default locations
            return {
                'جاكسو': { 'جنوب 12': [24.6234, 46.7256] },
                'المنصورة': { 'جنوب 2': [24.6789, 46.7123], 'جنوب 16': [24.6812, 46.7198], 'سريع 4': [24.6756, 46.7089] },
                'الشيخ زايد': { 'جنوب 3': [24.7234, 46.6845], 'جنوب 19': [24.7289, 46.6912] },
                'حي الواحات': { 'جنوب 11': [24.7123, 46.7567] },
                'المناخ': { 'جنوب 10': [24.6987, 46.7321] },
                'المريوطية': { 'جنوب 8': [24.6543, 46.6789] },
                'طرة': { 'جنوب 7': [24.6678, 46.7234] },
                'مطرية': { 'جنوب 14': [24.6890, 46.7456] },
                'البساتين': { 'جنوب 5': [24.7345, 46.7234] },
                'الخليفة': { 'جنوب 13': [24.6456, 46.7123] },
                'الشفاء': { 'جنوب 6': [24.7456, 46.6890], 'جنوب 17': [24.7512, 46.6945], 'سريع 2': [24.7398, 46.6834], 'سريع 3': [24.7489, 46.6876] },
                'عكاظ': { 'جنوب 9': [24.6890, 46.7678] },
                'الدار البيضاء': { 'جنوب 4': [24.7567, 46.7123], 'جنوب 15': [24.7623, 46.7189] },
                'طريق الملك فهد': { 'جنوب 1': [24.7890, 46.6890], 'جنوب 18': [24.7956, 46.6956] },
                'مستشفى الملك خالد': { 'سريع 1': [24.7345, 46.7012] }
            };
        }
        return {};
    }
}

async function writeUnitLocations(data) {
    await fs.writeFile(UNIT_LOCATIONS_PATH, JSON.stringify(data, null, 2));
}

async function readUnitLocationAddresses() {
    try {
        const data = await fs.readFile(UNIT_LOCATION_ADDRESSES_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                'جنوب 1': 'طريق الملك فهد، الرياض',
                'جنوب 2': 'حي المنصورة، الرياض',
                'جنوب 3': 'الخالدية، الرياض',
                'جنوب 4': 'الدار البيضاء، الرياض',
                'جنوب 5': 'البساتين، الرياض',
                'جنوب 6': 'الشفاء، الرياض',
                'جنوب 7': 'طرة، الرياض',
                'جنوب 8': 'المريوطية، الرياض',
                'جنوب 9': 'عكاظ، الرياض',
                'جنوب 10': 'المناخ، الرياض',
                'جنوب 11': 'حي الواحات، الرياض',
                'جنوب 12': 'جاكسو، الرياض',
                'جنوب 13': 'الخليفة، الرياض',
                'جنوب 14': 'المطرية، الرياض',
                'جنوب 15': 'الدار البيضاء، الرياض',
                'جنوب 16': 'المنصورة، الرياض',
                'جنوب 17': 'الشفاء، الرياض',
                'جنوب 18': 'طريق الملك فهد، الرياض',
                'جنوب 19': 'الخالدية، الرياض',
                'سريع 1': 'مستشفى الملك خالد، الرياض',
                'سريع 2': 'الشفاء، الرياض',
                'سريع 3': 'الدار البيضاء، الرياض',
                'سريع 4': 'المنصورة، الرياض'
            };
        }
        return {};
    }
}

async function writeUnitLocationAddresses(data) {
    await fs.writeFile(UNIT_LOCATION_ADDRESSES_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// API: جلب البيانات
// ============================================
app.get('/api/data', authenticate, async (req, res) => {
    try {
        // Slice 1: dispatch data comes from SQLite (reports + report_times
        // of the ACTIVE shift) via ReportService. Falls back to the JSON
        // file ONLY when the engine/services are unavailable (init failure).
        const data = reportService ? await reportService.getCurrentData() : await readData();
        const shiftType = getCurrentShiftType();
        const shiftDate = getCurrentShiftDate();
        
        // OV-S5: معرّف المناوبة النشطة يُشتق من القاعدة عبر OpsEngine في كل طلب
        // (نفس نمط /api/current-shift — مصدر الحقيقة الوحيد). لا حالة ذاكرة:
        // مناوبة منتهية/مؤرشفة لا تبقى «نشطة»، وتحديث مناوبة قديمة لا ينشّطها.
        let currentShiftId = null;
        try {
            if (opsEngine) {
                const session = await opsEngine.shifts.getCurrentSession();
                if (session && session.currentShift && session.currentShift.id) {
                    currentShiftId = session.currentShift.id;
                }
            }
        } catch (e) { /* ignore — يبقى null */ }
        
        // Ensure centersData is never empty — protects dispatch display on new shifts
        var safeCentersData = centersData;
        if (!safeCentersData || Object.keys(safeCentersData).length === 0) {
            safeCentersData = {
                "المنصورة": ["جنوب 1", "جنوب 11", "جنوب 12", "سريع 3"],
                "الخالدية": ["جنوب 2"],
                "منفوحة": ["جنوب 3"],
                "الدار البيضاء": ["جنوب 4", "جنوب 5", "سريع 1"],
                "الإسكان": ["جنوب 6"],
                "الحائر": ["جنوب 7"],
                "ديراب": ["جنوب 10"],
                "عكاظ": ["جنوب 9"],
                "الشفاء": ["جنوب 8", "سريع 2"],
                "الفرق الإضافية": ["سريع 4", "جنوب 13", "جنوب 14", "جنوب 15", "جنوب 16", "جنوب 17", "جنوب 18", "جنوب 19"]
            };
        }
        
        res.json({
            data,
            centers: safeCentersData,
            currentShiftId: currentShiftId,
            currentShift: {
                type: shiftType,
                date: shiftDate,
                key: shiftDate + ' ' + shiftType
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

app.get('/api/current-shift', authenticate, async (req, res) => {
    // Operations Engine → ShiftManager → SQLite
    try {
        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });
        const session = await opsEngine.shifts.getCurrentSession();
        res.json({ success: true, shift: session.currentShift || { id: null, status: 'none' } });
    } catch (error) {
        console.error('[CurrentShift] Error:', error);
        res.status(500).json({ error: 'فشل في جلب النوبة الحالية' });
    }
});

app.get('/api/last-update', (req, res) => {
    res.json({ lastUpdate: lastUpdateTime });
});

// ============================================
// API: المناوبات
// ============================================
app.get('/api/shifts', authenticate, async (req, res) => {
    // Phase 2+3: Read from SQLite first, fallback to JSON
    try {
        let shifts = [];
        
        // 1. Try SQLite (source of truth)
        if (opsService && opsService.getAllShifts) {
            shifts = await opsService.getAllShifts(100);
            if (shifts && shifts.length > 0) {
                // Normalize SQLite format to JSON-like format for frontend compatibility
                shifts = shifts.map(s => ({
                    id: s.id,
                    shiftName: s.shift_name || s.shiftName,
                    shiftDate: s.shift_date || s.shiftDate,
                    shiftTime: s.shift_time || s.shiftTime,
                    shiftType: s.shift_type || s.shiftType,
                    shiftDay: s.shift_day || s.shiftDay,
                    startTime: s.start_time || s.startTime,
                    totalReports: s.total_reports || s.totalReports || 0,
                    status: s.status || 'active',
                    archivedAt: s.archived_at || s.archivedAt,
                    lastUpdate: s.last_update || s.lastUpdate,
                    generalNotes: s.general_notes || s.generalNotes,
                    createdAt: s.created_at || s.createdAt
                }));
            }
        }
        
        // 2. Fallback: JSON files
        if (shifts.length === 0) {
            shifts = await readShifts();
        }
        
        res.json(shifts);
    } catch (error) {
        console.error('[Shifts] Error:', error);
        res.status(500).json({ error: 'فشل في جلب المناوبات' });
    }
});

// GET /api/shifts/archive - paginated archive list with filters
app.get('/api/shifts/archive', authenticate, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const dateFrom = req.query.date_from;
        const dateTo = req.query.date_to;
        const shiftType = req.query.shift_type;
        const status = req.query.status;
        const sort = req.query.sort || 'date_desc';

        let shifts = [];
        
        // 1. Try SQLite
        if (opsService && opsService.getAllShifts) {
            shifts = await opsService.getAllShifts(1000);
            shifts = shifts.map(s => ({
                id: s.id,
                shiftName: s.shift_name || s.shiftName,
                shiftDate: s.shift_date || s.shiftDate,
                shiftTime: s.shift_time || s.shiftTime,
                shiftType: s.shift_type || s.shiftType,
                shiftDay: s.shift_day || s.shiftDay,
                startTime: s.start_time || s.startTime,
                totalReports: s.total_reports || s.totalReports || 0,
                status: s.status || 'active',
                archivedAt: s.archived_at || s.archivedAt,
                lastUpdate: s.last_update || s.lastUpdate,
                generalNotes: s.general_notes || s.generalNotes
            }));
        }
        
        // 2. Fallback: JSON
        if (shifts.length === 0) {
            shifts = await readShifts();
        }

        // Apply filters
        if (dateFrom) shifts = shifts.filter(s => (s.shiftDate || '') >= dateFrom);
        if (dateTo) shifts = shifts.filter(s => (s.shiftDate || '') <= dateTo);
        if (shiftType) shifts = shifts.filter(s => (s.shiftType || '').toLowerCase().includes(shiftType.toLowerCase()));
        if (status) shifts = shifts.filter(s => (s.status || '').toLowerCase() === status.toLowerCase());

        // Sort
        shifts.sort((a, b) => {
            if (sort === 'date_desc') return new Date(b.shiftDate || 0) - new Date(a.shiftDate || 0);
            if (sort === 'date_asc') return new Date(a.shiftDate || 0) - new Date(b.shiftDate || 0);
            return 0;
        });

        const total = shifts.length;
        const totalPages = Math.ceil(total / limit);
        const paginated = shifts.slice((page - 1) * limit, page * limit);

        res.json({ success: true, shifts: paginated, total, page, total_pages: totalPages });
    } catch (error) {
        console.error('[Archive] Error:', error);
        res.status(500).json({ error: 'فشل في جلب الأرشيف' });
    }
});

app.get('/api/shifts/:id(\\d+)', authenticate, async (req, res) => {
    // Phase 2+3: Read from SQLite directly (not JSON)
    try {
        const shiftId = parseInt(req.params.id);

        // Get shift from SQLite
        let shift = null;
        if (opsService && opsService.getShiftById) {
            shift = await opsService.getShiftById(shiftId);
        }
        // Fallback: db.Shifts (guarded directly — dbAvailable() is an
        // overly-broad gate; full gate cleanup is Slice 2 scope)
        if (!shift && db.Shifts && db.Shifts.getById) {
            shift = await db.Shifts.getById(shiftId);
        }
        // Final fallback: JSON (backward compatibility)
        if (!shift) {
            const jsonShifts = await readShifts();
            shift = jsonShifts.find(s => s.id === shiftId);
        }

        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }

        // Normalize shift data (handle both snake_case and camelCase)
        const normalizedShift = {
            id: shift.id,
            shiftName: shift.shift_name || shift.shiftName,
            shiftDate: shift.shift_date || shift.shiftDate,
            shiftTime: shift.shift_time || shift.shiftTime,
            shiftType: shift.shift_type || shift.shiftType,
            shiftDay: shift.shift_day || shift.shiftDay,
            startTime: shift.start_time || shift.startTime,
            totalReports: shift.total_reports || shift.totalReports || 0,
            status: shift.status || 'active',
            archivedAt: shift.archived_at || shift.archivedAt,
            lastUpdate: shift.last_update || shift.lastUpdate,
            generalNotes: shift.general_notes || shift.generalNotes,
            createdAt: shift.created_at || shift.createdAt
        };

        const response = {
            shift: normalizedShift,
            reports: {},
            total: normalizedShift.totalReports || 0,
            completions: [],
            forms: [],
            audit_log: [],
            files: [],
            timeline: []
        };

        // ── 1. Query related data from SQLite (new data) ──
        try {
            if (dbAvailable()) {
                // Reports
                if (db.Reports && db.Reports.getByShift) {
                    const dbReports = await db.Reports.getByShift(shiftId);
                    if (Array.isArray(dbReports) && dbReports.length > 0) {
                        const reportsObj = {};
                        let totalCount = 0;
                        dbReports.forEach(r => {
                            if (r.center && r.unit) {
                                const key = `${r.center}|${r.unit}`;
                                reportsObj[key] = {
                                    count: r.count || 0,
                                    times: r.times || []
                                };
                                totalCount += r.count || 0;
                            }
                        });
                        response.reports = reportsObj;
                        response.total = totalCount;
                    }
                }
                // Shift Completions (Takmeel)
                if (db.ShiftCompletions && db.ShiftCompletions.getByShift) {
                    const dbCompletions = await db.ShiftCompletions.getByShift(shiftId);
                    if (Array.isArray(dbCompletions) && dbCompletions.length > 0) {
                        const completionsObj = {};
                        dbCompletions.forEach(c => {
                            let teamsData = c.teams_data || c.teamsData;
                            if (typeof teamsData === 'string') {
                                try { teamsData = JSON.parse(teamsData); } catch(e) { teamsData = {}; }
                            }
                            if (teamsData && typeof teamsData === 'object') {
                                Object.keys(teamsData).forEach(teamKey => {
                                    completionsObj[teamKey] = teamsData[teamKey];
                                });
                            } else {
                                const key = c.team || c.shift_type || 'general';
                                completionsObj[key] = c;
                            }
                        });
                        if (Object.keys(completionsObj).length > 0) response.completions = completionsObj;
                    }
                }
                // Forms
                if (db.ShiftForms && db.ShiftForms.getByShift) {
                    const dbForms = await db.ShiftForms.getByShift(shiftId);
                    if (Array.isArray(dbForms) && dbForms.length > 0) response.forms = dbForms;
                }
                // Audit Log
                if (db.AuditLog && db.AuditLog.getByShift) {
                    const dbAudit = await db.AuditLog.getByShift(shiftId);
                    if (Array.isArray(dbAudit) && dbAudit.length > 0) response.audit_log = dbAudit;
                }
                // Ops Files
                if (db.OpsFiles && db.OpsFiles.getByShift) {
                    const dbFiles = await db.OpsFiles.getByShift(shiftId);
                    if (Array.isArray(dbFiles) && dbFiles.length > 0) response.files = dbFiles;
                }
                // Timeline
                if (db.Timeline && db.Timeline.getByShift) {
                    const dbTimeline = await db.Timeline.getByShift(shiftId);
                    if (Array.isArray(dbTimeline) && dbTimeline.length > 0) response.timeline = dbTimeline;
                }
            }
        } catch (dbErr) {
            console.warn('[DB] Failed to load related shift data:', dbErr.message);
        }

        // ── 2. Fallback: Read from shift JSON fields (legacy data) ──
        if (Object.keys(response.reports).length === 0 && shift.savedReports) {
            try {
                let saved = typeof shift.savedReports === 'string' ? JSON.parse(shift.savedReports) : shift.savedReports;
                if (saved && typeof saved === 'object') {
                    response.reports = saved;
                    // Recalculate total from savedReports
                    response.total = Object.values(saved).reduce((sum, r) => sum + ((r.count || r) || 0), 0);
                }
            } catch (e) { /* ignore */ }
        }
        if (Object.keys(response.completions).length === 0 && shift.centersData) {
            try {
                let centers = typeof shift.centersData === 'string' ? JSON.parse(shift.centersData) : shift.centersData;
                if (centers && typeof centers === 'object') {
                    // Convert centersData to completion-like format
                    const completionsObj = {};
                    Object.keys(centers).forEach(center => {
                        const units = centers[center];
                        if (Array.isArray(units)) {
                            units.forEach(unit => {
                                completionsObj[unit] = { status: 'ready', center: center, reason: '', missingPerson: '' };
                            });
                        }
                    });
                    if (Object.keys(completionsObj).length > 0) response.completions = completionsObj;
                }
            } catch (e) { /* ignore */ }
        }
        if (shift.vehicleData && !response.forms.length) {
            try {
                let vd = typeof shift.vehicleData === 'string' ? JSON.parse(shift.vehicleData) : shift.vehicleData;
                if (vd && Object.keys(vd).length > 0) {
                    response.forms = [{ formName: 'بيانات المركبات', formData: JSON.stringify(vd), createdAt: shift.lastUpdate || shift.last_update }];
                }
            } catch (e) { /* ignore */ }
        }
        if (!response.audit_log.length && shift.generalNotes) {
            response.audit_log = [{
                action: 'note',
                detail: shift.generalNotes || shift.general_notes || '',
                userName: '-',
                createdAt: shift.lastUpdate || shift.last_update,
                type: 'notes'
            }];
        }

        res.json(response);
    } catch (error) {
        console.error('[ShiftDetail] Error:', error);
        res.status(500).json({ error: 'فشل في جلب المناوبة' });
    }
});

app.post('/api/start-new-shift', authenticate, authorize(['admin', 'director']), async (req, res) => {
    // Operations Engine → ShiftManager → SQLite
    try {
        const { shiftType } = req.body;
        if (!opsEngine) return res.status(503).json({ success: false, error: 'Engine unavailable' });

        // Slice 2: via ShiftService — ShiftStarted event drives the WS broadcast
        const result = await opsEngine.shiftService.startShift(shiftType, req.user);
        res.json(result);
    } catch (error) {
        console.error('[Shift] Error:', error);
        res.status(500).json({ success: false, error: 'فشل في بدء المناوبة' });
    }
});

// ═══════════════════════════════════════════════════════════
// Phase 2+3: Shift Lifecycle API (End, Archive, Handover)
// ═══════════════════════════════════════════════════════════

// End shift: Active → Pending Handover
app.post('/api/shift/:id/end', authenticate, authorize(['admin', 'director']), async (req, res) => {
    // Operations Engine → ShiftManager → SQLite
    try {
        const shiftId = parseInt(req.params.id);
        const { handoverNotes } = req.body;

        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        // Slice 2: via ShiftService — emits ShiftEnded (bus-only, no legacy WS)
        const result = await opsEngine.shiftService.endShift(shiftId, req.user, handoverNotes);
        res.json(result);
    } catch (error) {
        console.error('[Shift] Error ending shift:', error);
        res.status(500).json({ error: 'فشل في إنهاء المناوبة' });
    }
});// Approve handover: Pending Handover → Archived + Snapshot
app.post('/api/shift/:id/handover-approve', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        const user = req.user;

        const shift = await db.get('SELECT * FROM shifts WHERE id = ?', [shiftId]);
        if (!shift) return res.status(404).json({ error: 'المناوبة غير موجودة' });
        if (shift.status !== 'pending_handover') return res.status(400).json({ error: 'المناوبة ليست بانتظار التسليم' });

        // Archive slice: single archive path (seal + conversations + transition)
        const archiveResult = await opsEngine.archiveService.archive(shiftId, user, {
            source: 'handover',
            reason: 'تم اعتماد التسليم وأرشفة المناوبة'
        });
        if (!archiveResult.success) {
            return res.status(500).json({ error: archiveResult.error || 'فشل في اعتماد التسليم' });
        }

        res.json({ success: true, message: 'تم اعتماد التسليم وأرشفة المناوبة', snapshotHash: archiveResult.snapshotHash });
    } catch (error) {
        console.error('[HandoverApprove] Error:', error);
        res.status(500).json({ error: 'فشل في اعتماد التسليم' });
    }
});

// Direct archive (admin only): Active → Archived
app.post('/api/shift/:id/archive', authenticate, authorize(['admin']), async (req, res) => {
    // Operations Engine → ShiftManager → SQLite
    try {
        const shiftId = parseInt(req.params.id);
        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        // Archive slice: single archive path — direct archive now seals too
        // (previously flipped status WITHOUT a snapshot — contract violation)
        const result = await opsEngine.archiveService.archive(shiftId, req.user, {
            source: 'direct',
            reason: req.body.reason || 'أرشفة مباشرة'
        });
        res.json(result);
    } catch (error) {
        console.error('[Shift] Error archiving shift:', error);
        res.status(500).json({ error: 'فشل في أرشفة المناوبة' });
    }
});// Restore archived shift (supervisor only)
app.post('/api/shift/:id/restore', authenticate, authorize(['admin', 'director']), async (req, res) => {
    // Operations Engine → ShiftManager → SQLite
    try {
        const shiftId = parseInt(req.params.id);
        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        // Restore = start new shift (old one stays archived) — via ShiftService
        const result = await opsEngine.shiftService.startShift(null, req.user);
        res.json(result);
    } catch (error) {
        console.error('[Shift] Error restoring shift:', error);
        res.status(500).json({ error: 'فشل في استعادة المناوبة' });
    }
});

// ═══════════════════════════════════════════════════════════
// EMERGENCY: Manage Stuck Active Shifts
// ═══════════════════════════════════════════════════════════
app.get('/api/emergency/active-shifts', authenticate, authorize(['admin', 'director']), async (req, res) => {
    // List ALL active/pending shifts (for cleanup)
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const shifts = await db.all(
            "SELECT id, shift_name, shift_date, shift_type, status, start_time, total_reports FROM shifts WHERE status IN ('active', 'pending_handover') ORDER BY id DESC"
        );
        res.json({ success: true, count: shifts.length, shifts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/emergency/archive-shift', authenticate, authorize(['admin', 'director']), async (req, res) => {
    // Force archive any shift by ID
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const { shiftId } = req.body;
        if (!shiftId) return res.status(400).json({ error: 'shiftId مطلوب' });
        
        await db.run(
            "UPDATE shifts SET status = 'archived', archived_at = datetime('now') WHERE id = ?",
            [shiftId]
        );
        res.json({ success: true, message: `تم أرشفة المناوبة #${shiftId}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/emergency/delete-shift', authenticate, authorize(['admin']), async (req, res) => {
    // Delete any shift by ID (use with caution)
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const { shiftId } = req.body;
        if (!shiftId) return res.status(400).json({ error: 'shiftId مطلوب' });
        
        await db.run('DELETE FROM shifts WHERE id = ?', [shiftId]);
        res.json({ success: true, message: `تم حذف المناوبة #${shiftId}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/emergency/edit-shift', authenticate, authorize(['admin']), async (req, res) => {
    // Edit shift type or date
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const { shiftId, shiftType, shiftDate } = req.body;
        if (!shiftId) return res.status(400).json({ error: 'shiftId مطلوب' });
        
        const updates = [];
        const params = [];
        if (shiftType) { updates.push('shift_type = ?'); params.push(shiftType); }
        if (shiftDate) { updates.push('shift_date = ?'); params.push(shiftDate); }
        if (updates.length === 0) return res.status(400).json({ error: 'لا يوجد ما يُعدّل' });
        
        params.push(shiftId);
        await db.run(`UPDATE shifts SET ${updates.join(', ')} WHERE id = ?`, params);
        res.json({ success: true, message: `تم تعديل المناوبة #${shiftId}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get shift status
app.get('/api/shift/:id/status', authenticate, async (req, res) => {
    try {
        const shift = await opsService.getShiftById(parseInt(req.params.id));
        if (!shift) return res.status(404).json({ error: 'المناوبة غير موجودة' });
        res.json({
            id: shift.id,
            status: shift.status,
            shiftType: shift.shift_type,
            shiftDate: shift.shift_date,
            archivedAt: shift.archived_at
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الحالة' });
    }
});

app.post('/api/update-shift-data', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { shiftId, shiftData, shiftDate, shiftType } = req.body;
        const shifts = await readShifts();
        
        let targetShift = null;
        let index = -1;
        
        if (shiftId) {
            // Find by ID (legacy/manual mode)
            index = shifts.findIndex(s => s.id === shiftId);
        } else if (shiftDate && shiftType) {
            // Find by date + type (auto-shift mode)
            index = shifts.findIndex(s => s.shiftDate === shiftDate && normalizeShiftType(s.shiftType) === normalizeShiftType(shiftType));
        }
        
        if (index !== -1) {
            // Update existing shift
            shifts[index].rapidLocations = shiftData.rapidLocations || shifts[index].rapidLocations || {};
            shifts[index].centersData = shiftData.centersData || shifts[index].centersData || {};
            shifts[index].vehicleData = shiftData.vehicleData || shifts[index].vehicleData || {};
            shifts[index].fuelData = shiftData.fuelData || shifts[index].fuelData || {};
            shifts[index].generalNotes = shiftData.generalNotes || shifts[index].generalNotes || "";
            shifts[index].shiftType = shiftData.shiftType || shifts[index].shiftType;
            shifts[index].lastUpdate = new Date().toISOString();
            targetShift = shifts[index];
        } else {
            // Create new auto-shift record
            const now = new Date();
            const saudiTime = new Date(now.getTime() + (3 * 60 * 60 * 1000));
            const year = saudiTime.getFullYear();
            const month = (saudiTime.getMonth() + 1).toString().padStart(2, '0');
            const day = saudiTime.getDate().toString().padStart(2, '0');
            const isoDate = `${year}-${month}-${day}`;
            const newShift = {
                id: Date.now(),
                shiftName: `${shiftData.shiftType || 'صباحية'} - ${shiftDate || isoDate}`,
                shiftDate: shiftDate || isoDate,
                shiftTime: saudiTime.toLocaleTimeString('ar-SA'),
                shiftType: shiftData.shiftType || 'صباحية',
                startTime: saudiTime.toISOString(),
                savedReports: {},
                totalReports: 0,
                rapidLocations: shiftData.rapidLocations || {},
                centersData: shiftData.centersData || {},
                vehicleData: {},
                fuelData: {},
                generalNotes: shiftData.generalNotes || "",
                lastUpdate: saudiTime.toISOString(),
                autoArchived: false
            };
            shifts.unshift(newShift);
            if (shifts.length > 50) shifts.pop();
            targetShift = newShift;
            index = 0;
        }
        
        // Enrich centersData with assignedParamedics from database if available
        // BUT do NOT overwrite user-entered staffCount - preserve manual input
        try {
            const shiftDateToUse = targetShift ? targetShift.shiftDate : (shiftDate || isoDate);
            const teams = await db.Teams.getAll();
            const centerParamedics = {};
            for (const team of teams) {
                if (!centerParamedics[team.center]) centerParamedics[team.center] = [];
                const roster = await db.ShiftRoster.getByDateAndTeam(shiftDateToUse, team.id);
                const absentCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
                for (const entry of roster) {
                    centerParamedics[team.center].push({
                        name: entry.employee_name,
                        employeeCode: entry.employee_code,
                        team: team.name,
                        shiftCode: entry.shift_code,
                        status: absentCodes.includes(entry.shift_code) ? 'غائب' : 'حاضر'
                    });
                }
            }
            for (const center in targetShift.centersData) {
                if (centerParamedics[center] && centerParamedics[center].length > 0) {
                    // Only add assignedParamedics if not already present
                    if (!targetShift.centersData[center].assignedParamedics || targetShift.centersData[center].assignedParamedics.length === 0) {
                        targetShift.centersData[center].assignedParamedics = centerParamedics[center];
                    }
                    // Only update staffCount if user hasn't manually entered a value
                    // If staffCount is empty or 0, use the database count
                    const currentStaffCount = parseInt(targetShift.centersData[center].staffCount);
                    if (isNaN(currentStaffCount) || currentStaffCount === 0) {
                        targetShift.centersData[center].staffCount = centerParamedics[center].filter(p => p.status === 'حاضر').length;
                    }
                    // Otherwise, keep the user's manual input (staffCount already set by user)
                }
            }
        } catch (e) {
            console.warn('Could not enrich centersData with paramedics:', e.message);
        }
        
        // ═══ Slice 2 (X2): persist via ShiftService → SQLite (single source) ═══
        // JSON writeShifts + dead syncShiftToDB + missing db.saveShiftData removed.
        // The ShiftUpdated event drives the 'shift_updated' WS broadcast.
        if (targetShift) {
            try {
                await opsEngine.shiftService.saveShiftData(targetShift);
            } catch (saveErr) {
                console.error('Failed to save shift to SQLite:', saveErr);
                return res.status(500).json({ error: 'فشل في حفظ بيانات المناوبة' });
            }
        }
        
        // OV-S5: تحديث مناوبة (قديمة أو مؤرشفة) لا يجعلها «نشطة» —
        // أُزيل السطر الذي كان يضبط currentShiftId عند أي تحديث.

        // Create notifications for admin/director
        try {
            if (dbAvailable() && db.Notifications) {
                const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
                const admins = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
                for (const admin of admins) {
                    await db.Notifications.create({
                        user_id: admin.id.toString(),
                        title: 'تحديث المناوبة',
                        message: 'تم تحديث بيانات المناوبة',
                        type: 'info'
                    });
                }
            }
        } catch (notifErr) {
            console.error('Notification creation error:', notifErr);
        }
        
        // Audit log
        await addAuditLogEntry('shift_updated', 'تم تحديث بيانات المناوبة', 'shifts', req.user.name, req.user.role, req.user.id);

        res.json({ success: true, shiftId: targetShift ? targetShift.id : null });
    } catch (error) {
        console.error("خطأ في تحديث بيانات المناوبة:", error);
        res.status(500).json({ error: 'فشل في تحديث بيانات المناوبة' });
    }
});

// POST /api/shift-save - حفظ موثوق للمناوبة
// TODO: أعد إضافة authorize(['admin', 'director']) بعد الاختبار
app.post('/api/shift-save', authenticate, async (req, res) => {
    try {
        const { shiftId, shiftData } = req.body;
        if (!shiftId) {
            return res.status(400).json({ success: false, error: 'shiftId مطلوب' });
        }
        
        // ═══ Slice 2: persist via ShiftService → SQLite (db.saveShiftData never
        // existed — this route previously always failed 500) ═══
        const shifts = await readShifts();
        const existing = shifts.find(s => s.id === shiftId) || { id: shiftId };
        const merged = { ...existing, ...shiftData, id: shiftId, lastUpdate: new Date().toISOString() };
        const result = await opsEngine.shiftService.saveShiftData(merged);
        
        res.json({ success: true, shiftId, lastSaved: result.lastSaved });
    } catch (error) {
        console.error('Error saving shift:', error);
        res.status(500).json({ success: false, error: 'فشل في حفظ المناوبة: ' + error.message });
    }
});

// POST /api/shift-archive - أرشفة صريحة
// TODO: أعد إضافة authorize(['admin', 'director']) بعد الاختبار
app.post('/api/shift-archive', authenticate, async (req, res) => {
    try {
        const { shiftId, supervisorName, supervisorId } = req.body;
        if (!shiftId) {
            return res.status(400).json({ success: false, error: 'shiftId مطلوب' });
        }

        console.log('[ShiftArchive] Manual archive requested for shift #' + shiftId);

        // Archive slice: single archive path (seal + conversations + transition)
        const result = await opsEngine.archiveService.archive(parseInt(shiftId), req.user, {
            source: 'manual',
            strict: true,
            reason: 'أرشفة يدوية'
        });

        if (result.success) {
            await addAuditLogEntry(
                'shift_archived_manual',
                'تمت أرشفة المناوبة يدوياً، Hash: ' + result.snapshotHash,
                'shifts',
                req.user ? req.user.name : 'system',
                req.user ? req.user.role : 'system',
                req.user ? req.user.id : null,
                parseInt(shiftId)
            );

            res.json({
                success: true,
                shiftId: parseInt(shiftId),
                archivedAt: new Date().toISOString(),
                snapshotHash: result.snapshotHash,
                duration: result.duration,
                phases: result.phases
            });
        } else {
            await addAuditLogEntry(
                'shift_archive_failed_manual',
                'فشلت الأرشفة اليدارية: ' + (result.error?.message || 'unknown'),
                'shifts',
                req.user ? req.user.name : 'system',
                req.user ? req.user.role : 'system',
                req.user ? req.user.id : null,
                parseInt(shiftId)
            );

            res.status(500).json({
                success: false,
                error: result.error?.message || 'فشل في أرشفة المناوبة',
                code: result.error?.code || 'UNKNOWN',
                phases: result.phases
            });
        }
    } catch (error) {
        console.error('Error archiving shift:', error);
        res.status(500).json({ success: false, error: 'فشل في أرشفة المناوبة: ' + error.message });
    }
});
app.get('/api/shift-status', async (req, res) => {
    try {
        const activeShift = await db.getActiveShift();
        if (!activeShift) {
            return res.json({ isActive: false, message: 'لا توجد مناوبة نشطة' });
        }
        
        const status = await db.getShiftStatus(activeShift.id);
        res.json(status);
    } catch (error) {
        console.error('Error getting shift status:', error);
        res.status(500).json({ error: 'فشل في جلب حالة المناوبة' });
    }
});

// GET /api/shift-timeline/:shiftId - الأحداث الزمنية
// TODO: أعد إضافة authenticate بعد الاختبار
app.get('/api/shift-timeline/:shiftId', async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const events = await db.getTimelineEvents(shiftId, 100);
        res.json({ success: true, events });
    } catch (error) {
        console.error('Error getting timeline:', error);
        res.status(500).json({ error: 'فشل في جلب السجل الزمني' });
    }
});

// POST /api/shift-timeline/:shiftId - إضافة حدث زمني
app.post('/api/shift-timeline/:shiftId', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const { eventType, title, description, data } = req.body;
        const eventId = await db.addTimelineEvent(shiftId, {
            type: eventType,
            title: title,
            description: description,
            data: data,
            createdBy: req.user ? req.user.id : 'system',
            createdByName: req.user ? req.user.name : 'النظام'
        });
        res.json({ success: true, eventId });
    } catch (error) {
        console.error('Error adding timeline event:', error);
        res.status(500).json({ error: 'فشل في إضافة الحدث' });
    }
});

// GET /api/shift-snapshot/:shiftId - آخر لقطة محفوظة
// مقيّد: اللقطات تحوي بيانات تشغيلية ومحادثات (قرار المالك بعد شريحة الأرشفة)
app.get('/api/shift-snapshot/:shiftId', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        // Archive slice: read from shift_snapshots (db.getLatestShiftSnapshot never existed)
        const row = await db.get('SELECT * FROM shift_snapshots WHERE shift_id = ? ORDER BY id DESC LIMIT 1', [shiftId]);
        if (!row) {
            return res.status(404).json({ success: false, error: 'لا توجد لقطة محفوظة' });
        }
        let snapshot = null;
        try { snapshot = JSON.parse(row.snapshot_data); } catch (e) { snapshot = row.snapshot_data; }
        res.json({ success: true, snapshot, snapshotType: row.snapshot_type, createdAt: row.created_at });
    } catch (error) {
        console.error('Error getting snapshot:', error);
        res.status(500).json({ error: 'فشل في جلب اللقطة' });
    }
});

// GET /api/shift-integrity/:shiftId - التحقق من سلامة البيانات
// مقيّد: يكشف محتوى اللقطة (قرار المالك بعد شريحة الأرشفة)
app.get('/api/shift-integrity/:shiftId', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        // Archive slice: verify against the stored seal (db.verifyShiftIntegrity never existed)
        const row = await db.get('SELECT * FROM shift_snapshots WHERE shift_id = ? ORDER BY id DESC LIMIT 1', [shiftId]);
        if (!row) {
            return res.status(404).json({ success: false, error: 'لا توجد لقطة محفوظة للتحقق منها' });
        }
        const snapshot = JSON.parse(row.snapshot_data);
        const { ShiftIntegrityChecker } = require('./shift-archive-engine');
        const checker = new ShiftIntegrityChecker(db, STORAGE_PATH);
        const result = await checker.verify(shiftId, snapshot);
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Error verifying integrity:', error);
        res.status(500).json({ error: 'فشل في التحقق من السلامة' });
    }
});

app.delete('/api/shifts/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const shifts = await readShifts();
        const id = parseInt(req.params.id);
        // ═══ Slice 2: delete from SQLite (single source) via ShiftService ═══
        // ShiftDeleted (Catalog D-3) fires inside the service → engine broadcasts 'shift_deleted'
        await opsEngine.shiftService.deleteShift(id);

        // Audit log
        await addAuditLogEntry('shift_deleted', 'تم حذف المناوبة: ' + id, 'shifts', req.user.name, req.user.role, req.user.id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف المناوبة' });
    }
});

// ============================================
// API: Shift Archive & Analytics (New)
// ============================================

// Helper: calculate metrics for a single shift
async function calculateShiftMetrics(shiftId, shiftsList) {
    if (!dbAvailable()) return null;
    const shift = shiftsList.find(s => s.id === shiftId) || await db.Shifts.getById(shiftId);
    if (!shift) return null;

    const reports = await db.Reports.getByShift(shiftId);
    const completions = await db.ShiftCompletions.getByShift(shiftId);
    const forms = await db.ShiftForms.getByShift(shiftId);
    const timeline = await db.Timeline.getByShift(shiftId);
    const audit = await db.AuditLog.getByShift(shiftId);
    const files = await db.OpsFiles.getByShift(shiftId);

    const totalReports = Array.isArray(reports) ? reports.length : 0;
    const completedReports = Array.isArray(reports) ? reports.filter(r => r.status === 'completed').length : 0;
    const pendingReports = Array.isArray(reports) ? reports.filter(r => r.status === 'pending').length : 0;
    const suspendedReports = Array.isArray(reports) ? reports.filter(r => r.status === 'suspended').length : 0;
    const completionRate = totalReports > 0 ? (completedReports / totalReports) * 100 : 0;

    let staffCount = 0;
    let teamCount = 0;
    let vehicleCount = 0;
    if (Array.isArray(completions) && completions.length > 0) {
        teamCount = completions.length;
        completions.forEach(c => {
            try {
                const td = JSON.parse(c.teams_data || '{}');
                if (td.staffCount) staffCount += parseInt(td.staffCount) || 0;
                if (td.carsCount) vehicleCount += parseInt(td.carsCount) || 0;
                if (td.vehicles) vehicleCount += parseInt(td.vehicles) || 0;
            } catch (e) {}
        });
    }

    const notesCount = (Array.isArray(completions) ? completions.filter(c => c.notes && c.notes.trim()).length : 0) +
                       (Array.isArray(timeline) ? timeline.length : 0);
    const eventCount = Array.isArray(timeline) ? timeline.length : 0;
    const totalForms = Array.isArray(forms) ? forms.length : 0;
    const criticalCases = Array.isArray(forms) ? forms.filter(f => {
        const name = (f.form_name || '').toLowerCase();
        return name.includes('e-case') || name.includes('critical') || name.includes('حادث') || name.includes('طوارئ');
    }).length : 0;

    // data_completeness: percentage of fields filled in shift record
    let filledFields = 0;
    let totalFields = 0;
    const shiftFields = ['shiftName', 'shiftDate', 'shiftType', 'shiftDay', 'startTime', 'totalReports', 'rapidLocations', 'centersData', 'vehicleData', 'fuelData', 'generalNotes'];
    shiftFields.forEach(f => {
        totalFields++;
        const val = shift[f] || (shift[f.charAt(0).toLowerCase() + f.slice(1)]);
        if (val !== undefined && val !== null && val !== '' && JSON.stringify(val) !== '{}') filledFields++;
    });
    const dataCompleteness = totalFields > 0 ? (filledFields / totalFields) * 100 : 0;

    const avgResponseTime = 0; // no data source
    const avgClosureTime = 0; // no data source

    // health_score: weighted average
    // data_completeness * 0.2 + completion_rate * 0.3 + (1/avg_response_time)*0.2 + notes_count * 0.1 + event_count * 0.2
    // Adjusted: if avg_response_time is 0, we treat that component as 0
    const responseComponent = avgResponseTime > 0 ? (1 / avgResponseTime) * 0.2 : 0;
    const notesComponent = Math.min(notesCount * 2, 20); // cap at 20 points
    const eventComponent = Math.min(eventCount * 2, 20); // cap at 20 points
    let healthScore = (dataCompleteness * 0.2) + (completionRate * 0.3) + responseComponent + notesComponent + eventComponent;
    healthScore = Math.min(100, Math.max(0, healthScore));

    const metrics = {
        shift_id: shiftId,
        total_reports: totalReports,
        completed_reports: completedReports,
        pending_reports: pendingReports,
        suspended_reports: suspendedReports,
        total_completions: Array.isArray(completions) ? completions.length : 0,
        total_forms: totalForms,
        staff_count: staffCount,
        team_count: teamCount,
        vehicle_count: vehicleCount,
        completion_rate: parseFloat(completionRate.toFixed(2)),
        avg_response_time: avgResponseTime,
        avg_closure_time: avgClosureTime,
        critical_cases: criticalCases,
        health_score: parseFloat(healthScore.toFixed(2)),
        data_completeness: parseFloat(dataCompleteness.toFixed(2)),
        notes_count: notesCount,
        event_count: eventCount
    };

    // Save to SQLite
    try {
        const existing = await db.ShiftMetrics.getByShift(shiftId);
        if (existing) {
            await db.ShiftMetrics.update(existing.id, metrics);
        } else {
            await db.ShiftMetrics.create(metrics);
        }
    } catch (e) {
        console.warn('Failed to save shift metrics:', e.message);
    }

    return metrics;
}

// Helper: calculate alerts for a shift
async function calculateShiftAlerts(shiftId, metrics) {
    if (!dbAvailable() || !db.ShiftAlerts) return [];
    const alerts = [];
    const m = metrics || await calculateShiftMetrics(shiftId, []);
    if (!m) return alerts;

    if (m.pending_reports > 5) {
        alerts.push({ shift_id: shiftId, alert_type: 'high_pending', severity: 'warning', message: 'عدد البلاغات المعلقة مرتفع (' + m.pending_reports + ')' });
    }
    if (m.completion_rate < 50 && m.total_reports > 0) {
        alerts.push({ shift_id: shiftId, alert_type: 'low_completion', severity: 'critical', message: 'نسبة الإنجاز منخفضة (' + m.completion_rate.toFixed(1) + '%)' });
    }
    if (m.staff_count < 3) {
        alerts.push({ shift_id: shiftId, alert_type: 'staff_shortage', severity: 'critical', message: 'نقص في الكادر (' + m.staff_count + ')' });
    }
    if (m.total_reports > 30) {
        alerts.push({ shift_id: shiftId, alert_type: 'workload_spike', severity: 'warning', message: 'ارتفاع في حجم البلاغات (' + m.total_reports + ')' });
    }
    if (m.avg_closure_time > 120) {
        alerts.push({ shift_id: shiftId, alert_type: 'closure_delay', severity: 'warning', message: 'تأخر في إغلاق البلاغات' });
    }
    if (m.notes_count > 10) {
        alerts.push({ shift_id: shiftId, alert_type: 'repeated_notes', severity: 'info', message: 'عدد الملاحظات مرتفع (' + m.notes_count + ')' });
    }

    const saved = [];
    for (const alert of alerts) {
        try {
            const id = await db.ShiftAlerts.create(alert);
            const savedAlert = { id, ...alert };
            saved.push(savedAlert);
            broadcast({
                type: 'shift_alert_new',
                alert_id: id,
                shift_id: shiftId,
                alert_type: alert.alert_type,
                severity: alert.severity,
                message: alert.message
            });
        } catch (e) {
            console.warn('Alert creation error:', e.message);
        }
    }
    return saved;
}

// GET /api/shifts/:id/detail - comprehensive shift data
app.get('/api/shifts/:id/detail', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        const shifts = await readShifts();
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }

        const result = {
            shift: shift,
            reports: shift.savedReports || {},
            completions: [],
            forms: [],
            audit_trail: [],
            timeline: [],
            files: [],
            metrics: null,
            alerts: [],
            staff: [],
            vehicles: []
        };

        if (dbAvailable()) {
            try {
                const dbReports = await db.Reports.getByShift(shiftId);
                if (Array.isArray(dbReports) && dbReports.length > 0) {
                    const reportsObj = {};
                    dbReports.forEach(r => {
                        if (r.center && r.unit) {
                            reportsObj[`${r.center}|${r.unit}`] = { count: r.count || 0, times: r.times || [] };
                        }
                    });
                    result.reports = reportsObj;
                }
                const dbCompletions = await db.ShiftCompletions.getByShift(shiftId);
                if (Array.isArray(dbCompletions)) result.completions = dbCompletions;
                const dbForms = await db.ShiftForms.getByShift(shiftId);
                if (Array.isArray(dbForms)) result.forms = dbForms;
                const dbAudit = await db.ShiftAuditTrail.getByShift(shiftId, 100);
                if (Array.isArray(dbAudit)) result.audit_trail = dbAudit;
                const dbTimeline = await db.ShiftTimelineEvents.getByShift(shiftId, 100);
                if (Array.isArray(dbTimeline)) result.timeline = dbTimeline;
                const dbFiles = await db.OpsFiles.getByShift(shiftId);
                if (Array.isArray(dbFiles)) result.files = dbFiles;
                const dbMetrics = await db.ShiftMetrics.getByShift(shiftId);
                if (dbMetrics) result.metrics = dbMetrics;
                const dbAlerts = await db.ShiftAlerts.getByShift(shiftId, 50);
                if (Array.isArray(dbAlerts)) result.alerts = dbAlerts;

                // Extract staff/vehicles from completions
                const staffSet = new Set();
                const vehicleSet = new Set();
                dbCompletions.forEach(c => {
                    try {
                        const td = JSON.parse(c.teams_data || '{}');
                        if (td.assignedParamedics) {
                            td.assignedParamedics.forEach(p => staffSet.add(p.name || p));
                        }
                        if (td.cars) {
                            td.cars.forEach(v => vehicleSet.add(v.plate || v.name || v));
                        }
                    } catch (e) {}
                });
                result.staff = Array.from(staffSet);
                result.vehicles = Array.from(vehicleSet);
            } catch (dbErr) {
                console.warn('[DB] Failed to load shift detail:', dbErr.message);
            }
        }

        res.json(result);
    } catch (error) {
        console.error('Shift detail error:', error);
        res.status(500).json({ error: 'فشل في جلب تفاصيل المناوبة' });
    }
});

// GET /api/shifts/:id/timeline - timeline events
app.get('/api/shifts/:id/timeline', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        if (!dbAvailable() || !db.ShiftTimelineEvents) {
            return res.json({ success: true, events: [] });
        }
        const events = await db.ShiftTimelineEvents.getByShift(shiftId, parseInt(req.query.limit) || 50);
        res.json({ success: true, events: events || [] });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الأحداث الزمنية' });
    }
});

// GET /api/shifts/:id/metrics - KPIs for shift
app.get('/api/shifts/:id/metrics', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        if (!dbAvailable() || !db.ShiftMetrics) {
            return res.json({ success: true, metrics: null });
        }
        let metrics = await db.ShiftMetrics.getByShift(shiftId);
        if (!metrics) {
            const shifts = await readShifts();
            metrics = await calculateShiftMetrics(shiftId, shifts);
        }
        res.json({ success: true, metrics });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المؤشرات' });
    }
});

// GET /api/shifts/:id/health-score - health score calculation
app.get('/api/shifts/:id/health-score', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        const shifts = await readShifts();
        const metrics = await calculateShiftMetrics(shiftId, shifts);
        if (!metrics) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        const components = {
            data_completeness: metrics.data_completeness,
            completion_rate: metrics.completion_rate,
            notes_count: metrics.notes_count,
            event_count: metrics.event_count,
            staff_count: metrics.staff_count,
            critical_cases: metrics.critical_cases
        };
        res.json({ success: true, health_score: metrics.health_score, components });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حساب مؤشر الصحة' });
    }
});

// GET /api/shifts/daily-dashboard - daily KPIs
app.get('/api/shifts/daily-dashboard', authenticate, async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split('T')[0];
        if (!dbAvailable()) {
            return res.json({ success: true, date, total_shifts: 0, total_reports: 0, completed_reports: 0, open_reports: 0, suspended_reports: 0, total_staff: 0, total_teams: 0, total_vehicles: 0, completion_rate: 0, avg_response_time: 0, avg_closure_time: 0, top_center: null, top_report_type: null });
        }
        let kpi = await db.ShiftKpiDaily.getByDate(date);
        if (!kpi) {
            // Calculate from shifts
            const shifts = await readShifts();
            const dayShifts = shifts.filter(s => s.shiftDate === date);
            let totalReports = 0, completedReports = 0, openReports = 0, suspendedReports = 0;
            let totalStaff = 0, totalTeams = 0, totalVehicles = 0;
            const centerCounts = {};
            const typeCounts = {};
            for (const s of dayShifts) {
                const m = await calculateShiftMetrics(s.id, shifts);
                if (m) {
                    totalReports += m.total_reports;
                    completedReports += m.completed_reports;
                    openReports += m.pending_reports;
                    suspendedReports += m.suspended_reports;
                    totalStaff += m.staff_count;
                    totalTeams += m.team_count;
                    totalVehicles += m.vehicle_count;
                }
                if (s.savedReports) {
                    Object.keys(s.savedReports).forEach(k => {
                        const [center, unit] = k.split('|');
                        if (center) centerCounts[center] = (centerCounts[center] || 0) + (s.savedReports[k].count || 0);
                        if (unit) typeCounts[unit] = (typeCounts[unit] || 0) + (s.savedReports[k].count || 0);
                    });
                }
            }
            const topCenter = Object.entries(centerCounts).sort((a, b) => b[1] - a[1])[0];
            const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
            const completionRate = totalReports > 0 ? (completedReports / totalReports) * 100 : 0;
            kpi = {
                date,
                total_shifts: dayShifts.length,
                total_reports: totalReports,
                completed_reports: completedReports,
                open_reports: openReports,
                suspended_reports: suspendedReports,
                total_staff: totalStaff,
                total_teams: totalTeams,
                total_vehicles: totalVehicles,
                completion_rate: parseFloat(completionRate.toFixed(2)),
                avg_response_time: 0,
                avg_closure_time: 0,
                top_center: topCenter ? topCenter[0] : null,
                top_report_type: topType ? topType[0] : null
            };
        }
        res.json({ success: true, ...kpi });
    } catch (error) {
        console.error('Daily dashboard error:', error);
        res.status(500).json({ error: 'فشل في جلب لوحة المعلومات اليومية' });
    }
});

// GET /api/shifts/weekly-dashboard - weekly KPIs
app.get('/api/shifts/weekly-dashboard', authenticate, async (req, res) => {
    try {
        const weekStart = req.query.week_start;
        const weekEnd = req.query.week_end;
        if (!weekStart || !weekEnd) {
            return res.status(400).json({ error: 'معايير التاريخ مطلوبة' });
        }
        if (!dbAvailable()) {
            return res.json({ success: true, week_start: weekStart, week_end: weekEnd, total_shifts: 0, total_reports: 0, avg_daily_reports: 0, peak_day: null, peak_day_count: 0, lowest_day: null, lowest_day_count: 0, completion_rate: 0, total_operating_hours: 0, total_staff: 0, total_teams: 0, total_vehicles: 0, avg_staff_per_shift: 0, comparison_last_week: 0 });
        }
        let kpi = await db.ShiftKpiWeekly.getByWeekStart(weekStart);
        if (!kpi) {
            const shifts = await readShifts();
            const weekShifts = shifts.filter(s => s.shiftDate >= weekStart && s.shiftDate <= weekEnd);
            let totalReports = 0, totalStaff = 0, totalTeams = 0, totalVehicles = 0, completedReports = 0;
            const dayCounts = {};
            for (const s of weekShifts) {
                const m = await calculateShiftMetrics(s.id, shifts);
                if (m) {
                    totalReports += m.total_reports;
                    completedReports += m.completed_reports;
                    totalStaff += m.staff_count;
                    totalTeams += m.team_count;
                    totalVehicles += m.vehicle_count;
                }
                dayCounts[s.shiftDate] = (dayCounts[s.shiftDate] || 0) + (s.totalReports || 0);
            }
            const days = Object.entries(dayCounts);
            const peak = days.sort((a, b) => b[1] - a[1])[0];
            const lowest = days.sort((a, b) => a[1] - b[1])[0];
            const completionRate = totalReports > 0 ? (completedReports / totalReports) * 100 : 0;
            kpi = {
                week_start: weekStart,
                week_end: weekEnd,
                total_shifts: weekShifts.length,
                total_reports: totalReports,
                avg_daily_reports: weekShifts.length > 0 ? parseFloat((totalReports / weekShifts.length).toFixed(2)) : 0,
                peak_day: peak ? peak[0] : null,
                peak_day_count: peak ? peak[1] : 0,
                lowest_day: lowest ? lowest[0] : null,
                lowest_day_count: lowest ? lowest[1] : 0,
                completion_rate: parseFloat(completionRate.toFixed(2)),
                total_operating_hours: weekShifts.length * 12,
                total_staff: totalStaff,
                total_teams: totalTeams,
                total_vehicles: totalVehicles,
                avg_staff_per_shift: weekShifts.length > 0 ? parseFloat((totalStaff / weekShifts.length).toFixed(2)) : 0,
                comparison_last_week: 0
            };
        }
        res.json({ success: true, ...kpi });
    } catch (error) {
        console.error('Weekly dashboard error:', error);
        res.status(500).json({ error: 'فشل في جلب لوحة المعلومات الأسبوعية' });
    }
});

// GET /api/shifts/monthly-dashboard - monthly KPIs
app.get('/api/shifts/monthly-dashboard', authenticate, async (req, res) => {
    try {
        const month = parseInt(req.query.month) || (new Date().getMonth() + 1);
        const year = parseInt(req.query.year) || new Date().getFullYear();
        if (!dbAvailable()) {
            return res.json({ success: true, month, year, total_shifts: 0, total_reports: 0, total_operating_hours: 0, total_staff: 0, total_teams: 0, total_vehicles: 0, morning_shifts: 0, night_shifts: 0, completion_rate: 0, avg_performance: 0, comparison_last_month: 0, comparison_chart_data: null });
        }
        let kpi = await db.ShiftKpiMonthly.getByMonthYear(month, year);
        if (!kpi) {
            const shifts = await readShifts();
            const monthShifts = shifts.filter(s => {
                if (!s.shiftDate) return false;
                const d = new Date(s.shiftDate);
                return d.getMonth() + 1 === month && d.getFullYear() === year;
            });
            let totalReports = 0, totalStaff = 0, totalTeams = 0, totalVehicles = 0, completedReports = 0;
            let morningShifts = 0, nightShifts = 0;
            for (const s of monthShifts) {
                const m = await calculateShiftMetrics(s.id, shifts);
                if (m) {
                    totalReports += m.total_reports;
                    completedReports += m.completed_reports;
                    totalStaff += m.staff_count;
                    totalTeams += m.team_count;
                    totalVehicles += m.vehicle_count;
                }
                const st = (s.shiftType || '').toLowerCase();
                if (st.includes('صباح') || st.includes('morning')) morningShifts++;
                else if (st.includes('ليل') || st.includes('night')) nightShifts++;
            }
            const completionRate = totalReports > 0 ? (completedReports / totalReports) * 100 : 0;
            kpi = {
                month, year,
                total_shifts: monthShifts.length,
                total_reports: totalReports,
                total_operating_hours: monthShifts.length * 12,
                total_staff: totalStaff,
                total_teams: totalTeams,
                total_vehicles: totalVehicles,
                morning_shifts: morningShifts,
                night_shifts: nightShifts,
                completion_rate: parseFloat(completionRate.toFixed(2)),
                avg_performance: parseFloat((completionRate * 0.6 + (morningShifts / Math.max(monthShifts.length, 1)) * 40).toFixed(2)),
                comparison_last_month: 0,
                comparison_chart_data: null
            };
        }
        res.json({ success: true, ...kpi });
    } catch (error) {
        console.error('Monthly dashboard error:', error);
        res.status(500).json({ error: 'فشل في جلب لوحة المعلومات الشهرية' });
    }
});

// GET /api/shifts/executive-dashboard - executive summary
app.get('/api/shifts/executive-dashboard', authenticate, async (req, res) => {
    try {
        const shifts = await readShifts();
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        const todayShifts = shifts.filter(s => s.shiftDate === today);
        const weekShifts = shifts.filter(s => s.shiftDate >= weekAgo);
        const monthShifts = shifts.filter(s => s.shiftDate >= monthAgo);

        const daily = { total_shifts: todayShifts.length, total_reports: 0, completion_rate: 0 };
        const weekly = { total_shifts: weekShifts.length, total_reports: 0, completion_rate: 0 };
        const monthly = { total_shifts: monthShifts.length, total_reports: 0, completion_rate: 0 };

        const centerCounts = {};
        const trends = [];

        for (const s of monthShifts) {
            const m = await calculateShiftMetrics(s.id, shifts);
            if (m) {
                monthly.total_reports += m.total_reports;
            }
            if (s.shiftDate >= weekAgo) {
                weekly.total_reports += s.totalReports || 0;
            }
            if (s.shiftDate === today) {
                daily.total_reports += s.totalReports || 0;
            }
            if (s.savedReports) {
                Object.keys(s.savedReports).forEach(k => {
                    const [center] = k.split('|');
                    if (center) centerCounts[center] = (centerCounts[center] || 0) + (s.savedReports[k].count || 0);
                });
            }
            trends.push({ date: s.shiftDate, reports: s.totalReports || 0, completion_rate: m ? m.completion_rate : 0 });
        }

        const topCenters = Object.entries(centerCounts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

        let alerts = [];
        if (dbAvailable() && db.ShiftAlerts) {
            alerts = await db.ShiftAlerts.getUnacknowledged(20);
        }

        const latestShifts = shifts.slice(0, 10);

        res.json({ success: true, daily, weekly, monthly, top_centers: topCenters, trends: trends.slice(-30), alerts: alerts || [], latest_shifts: latestShifts });
    } catch (error) {
        console.error('Executive dashboard error:', error);
        res.status(500).json({ error: 'فشل في جلب لوحة المعلومات التنفيذية' });
    }
});

// GET /api/shifts/search - advanced search
app.get('/api/shifts/search', authenticate, async (req, res) => {
    try {
        const q = (req.query.q || '').toLowerCase();
        const dateFrom = req.query.date_from;
        const dateTo = req.query.date_to;
        const shiftType = req.query.shift_type;
        const center = req.query.center;
        const supervisor = req.query.supervisor;
        const employee = req.query.employee;
        const reportId = req.query.report_id;
        const reportType = req.query.report_type;
        const status = req.query.status;
        const limit = parseInt(req.query.limit) || 50;

        let shifts = await readShifts();
        let results = [];

        for (const s of shifts) {
            let match = true;
            if (q) {
                const haystack = JSON.stringify(s).toLowerCase();
                match = haystack.includes(q);
            }
            if (match && dateFrom) match = s.shiftDate >= dateFrom;
            if (match && dateTo) match = s.shiftDate <= dateTo;
            if (match && shiftType) match = (s.shiftType || '').toLowerCase().includes(shiftType.toLowerCase());
            if (match && center) match = s.centersData && Object.keys(s.centersData).some(c => c.includes(center));
            if (match && supervisor) match = (s.supervisor || s.shiftName || '').includes(supervisor);
            if (match && status) match = (s.status || '').toLowerCase() === status.toLowerCase();
            if (match && employee) {
                match = s.centersData && Object.values(s.centersData).some(c => {
                    const ap = c.assignedParamedics || [];
                    return ap.some(p => (p.name || '').includes(employee));
                });
            }
            if (match && reportId) {
                match = s.savedReports && Object.keys(s.savedReports).some(k => k.includes(reportId));
            }
            if (match && reportType) {
                match = s.savedReports && Object.keys(s.savedReports).some(k => k.includes(reportType));
            }
            if (match) results.push(s);
        }

        results = results.slice(0, limit);

        // Enrich with metrics
        if (dbAvailable() && db.ShiftMetrics) {
            for (const r of results) {
                const m = await db.ShiftMetrics.getByShift(r.id);
                if (m) r.metrics = m;
            }
        }

        res.json({ success: true, results, total: results.length });
    } catch (error) {
        console.error('Search error:', error);
        res.status(500).json({ error: 'فشل في البحث' });
    }
});

// POST /api/shifts/compare - compare two shifts
app.post('/api/shifts/compare', authenticate, async (req, res) => {
    try {
        const { shift_a_id, shift_b_id } = req.body;
        if (!shift_a_id || !shift_b_id) {
            return res.status(400).json({ error: 'معرفات المناوبات مطلوبة' });
        }
        const shifts = await readShifts();
        const shiftA = shifts.find(s => s.id === shift_a_id) || await db.Shifts.getById(shift_a_id);
        const shiftB = shifts.find(s => s.id === shift_b_id) || await db.Shifts.getById(shift_b_id);
        if (!shiftA || !shiftB) {
            return res.status(404).json({ error: 'إحدى المناوبات غير موجودة' });
        }

        const metricsA = await calculateShiftMetrics(shift_a_id, shifts);
        const metricsB = await calculateShiftMetrics(shift_b_id, shifts);

        const diff = {};
        if (metricsA && metricsB) {
            diff.total_reports = metricsB.total_reports - metricsA.total_reports;
            diff.completed_reports = metricsB.completed_reports - metricsA.completed_reports;
            diff.completion_rate = parseFloat((metricsB.completion_rate - metricsA.completion_rate).toFixed(2));
            diff.staff_count = metricsB.staff_count - metricsA.staff_count;
            diff.health_score = parseFloat((metricsB.health_score - metricsA.health_score).toFixed(2));
        }

        const a = { shift: shiftA, metrics: metricsA };
        const b = { shift: shiftB, metrics: metricsB };

        res.json({ success: true, comparison: { a, b, diff } });
    } catch (error) {
        console.error('Compare error:', error);
        res.status(500).json({ error: 'فشل في المقارنة' });
    }
});

// GET /api/shifts/comparison/:id - get saved comparison
app.get('/api/shifts/comparison/:id', authenticate, async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftComparisonSnapshots) {
            return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        }
        const comparison = await db.ShiftComparisonSnapshots.getById(req.params.id);
        if (!comparison) {
            return res.status(404).json({ error: 'المقارنة غير موجودة' });
        }
        res.json({ success: true, comparison });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المقارنة' });
    }
});

// GET /api/shifts/alerts - smart alerts
app.get('/api/shifts/alerts', authenticate, async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftAlerts) {
            return res.json({ success: true, alerts: [] });
        }
        const shiftId = req.query.shift_id ? parseInt(req.query.shift_id) : null;
        const severity = req.query.severity;
        const acknowledged = req.query.acknowledged;
        const limit = parseInt(req.query.limit) || 50;

        let alerts = [];
        if (shiftId) {
            alerts = await db.ShiftAlerts.getByShift(shiftId, limit);
        } else if (severity) {
            alerts = await db.all('SELECT * FROM shift_alerts WHERE severity = ? ORDER BY created_at DESC LIMIT ?', [severity, limit]);
        } else if (acknowledged !== undefined) {
            const ack = acknowledged === '1' || acknowledged === 'true' ? 1 : 0;
            alerts = await db.all('SELECT * FROM shift_alerts WHERE is_acknowledged = ? ORDER BY created_at DESC LIMIT ?', [ack, limit]);
        } else {
            alerts = await db.ShiftAlerts.getAll(limit);
        }
        res.json({ success: true, alerts: alerts || [] });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التنبيهات' });
    }
});

// POST /api/shifts/alerts/:id/acknowledge - acknowledge alert
app.post('/api/shifts/alerts/:id/acknowledge', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftAlerts) {
            return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        }
        const alertId = parseInt(req.params.id);
        const acknowledgedBy = req.body.acknowledged_by || req.user.name;
        await db.ShiftAlerts.acknowledge(alertId, acknowledgedBy);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تأكيد التنبيه' });
    }
});

// POST /api/shifts/alerts/calculate - trigger alert calculation
app.post('/api/shifts/alerts/calculate', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const shiftId = req.body.shift_id ? parseInt(req.body.shift_id) : null;
        const shifts = await readShifts();
        let generated = [];
        if (shiftId) {
            const metrics = await calculateShiftMetrics(shiftId, shifts);
            generated = await calculateShiftAlerts(shiftId, metrics);
        } else {
            for (const s of shifts.slice(0, 10)) {
                const metrics = await calculateShiftMetrics(s.id, shifts);
                const alerts = await calculateShiftAlerts(s.id, metrics);
                generated.push(...alerts);
            }
        }
        res.json({ success: true, alerts_generated: generated });
    } catch (error) {
        console.error('Alert calculation error:', error);
        res.status(500).json({ error: 'فشل في حساب التنبيهات' });
    }
});

// GET /api/shifts/audit-trail - full audit trail
app.get('/api/shifts/audit-trail', authenticate, async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftAuditTrail) {
            return res.json({ success: true, entries: [], total: 0 });
        }
        const shiftId = req.query.shift_id ? parseInt(req.query.shift_id) : null;
        const actorId = req.query.actor_id;
        const actionType = req.query.action_type;
        const dateFrom = req.query.date_from;
        const dateTo = req.query.date_to;
        const limit = parseInt(req.query.limit) || 50;

        let where = [];
        let params = [];
        if (shiftId) { where.push('shift_id = ?'); params.push(shiftId); }
        if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
        if (actionType) { where.push('action_type = ?'); params.push(actionType); }
        if (dateFrom) { where.push('created_at >= ?'); params.push(dateFrom); }
        if (dateTo) { where.push('created_at <= ?'); params.push(dateTo + ' 23:59:59'); }

        const sqlWhere = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
        const entries = await db.all(`SELECT * FROM shift_audit_trail ${sqlWhere} ORDER BY created_at DESC LIMIT ?`, [...params, limit]);
        const totalRow = await db.get(`SELECT COUNT(*) as count FROM shift_audit_trail ${sqlWhere}`, params);
        res.json({ success: true, entries: entries || [], total: totalRow ? totalRow.count : 0 });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجل التدقيق' });
    }
});

// POST /api/shifts/audit-trail - add audit entry
app.post('/api/shifts/audit-trail', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftAuditTrail) {
            return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        }
        const { shift_id, action_type, action_detail, old_data, new_data } = req.body;
        if (!shift_id || !action_type) {
            return res.status(400).json({ error: 'معرف المناوبة ونوع الإجراء مطلوبان' });
        }
        const id = await db.ShiftAuditTrail.create({
            shift_id: parseInt(shift_id),
            action_type,
            actor_id: req.user.id,
            actor_name: req.user.name,
            actor_role: req.user.role,
            action_detail: action_detail || '',
            old_data: old_data || null,
            new_data: new_data || null,
            ip_address: req.ip || null,
            user_agent: req.headers['user-agent'] || null
        });
        // Broadcast WebSocket event
        broadcast({
            type: 'shift_audit_trail_new',
            shift_id: parseInt(shift_id),
            entry: { id, shift_id, action_type, actor_name: req.user.name, created_at: new Date().toISOString() }
        });
        res.json({ success: true, id });
    } catch (error) {
        console.error('Audit trail create error:', error);
        res.status(500).json({ error: 'فشل في إضافة سجل التدقيق' });
    }
});

// POST /api/shifts/:id/metrics/calculate - recalculate metrics for a shift
app.post('/api/shifts/:id/metrics/calculate', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        const shifts = await readShifts();
        const metrics = await calculateShiftMetrics(shiftId, shifts);
        if (!metrics) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        broadcast({
            type: 'shift_detail_updated',
            shift_id: shiftId,
            field: 'metrics',
            new_value: metrics
        });
        broadcast({
            type: 'shift_metrics_calculated',
            shift_id: shiftId,
            metrics
        });
        res.json({ success: true, metrics });
    } catch (error) {
        console.error('Metrics calculation error:', error);
        res.status(500).json({ error: 'فشل في حساب المؤشرات' });
    }
});

// POST /api/shifts/metrics/calculate-all - batch recalculate
app.post('/api/shifts/metrics/calculate-all', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const dateFrom = req.body.date_from;
        const dateTo = req.body.date_to;
        let shifts = await readShifts();
        if (dateFrom) shifts = shifts.filter(s => s.shiftDate >= dateFrom);
        if (dateTo) shifts = shifts.filter(s => s.shiftDate <= dateTo);

        let count = 0;
        for (const s of shifts) {
            await calculateShiftMetrics(s.id, shifts);
            count++;
        }
        res.json({ success: true, calculated_count: count });
    } catch (error) {
        console.error('Batch metrics calculation error:', error);
        res.status(500).json({ error: 'فشل في حساب المؤشرات بالدفعة' });
    }
});

// POST /api/shifts/export - export report
app.post('/api/shifts/export', authenticate, async (req, res) => {
    try {
        const { shift_id, format, type } = req.body;
        const shiftId = shift_id ? parseInt(shift_id) : null;
        const shifts = await readShifts();
        let data = {};
        let filename = 'export';

        if (type === 'detail' && shiftId) {
            const shift = shifts.find(s => s.id === shiftId);
            data = shift || {};
            filename = `shift-detail-${shiftId}`;
        } else if (type === 'daily') {
            const date = req.body.date || new Date().toISOString().split('T')[0];
            data = { date, shifts: shifts.filter(s => s.shiftDate === date) };
            filename = `daily-report-${date}`;
        } else if (type === 'weekly') {
            const weekStart = req.body.week_start;
            const weekEnd = req.body.week_end;
            data = { weekStart, weekEnd, shifts: shifts.filter(s => s.shiftDate >= weekStart && s.shiftDate <= weekEnd) };
            filename = `weekly-report-${weekStart}`;
        } else if (type === 'monthly') {
            const month = req.body.month;
            const year = req.body.year;
            data = { month, year, shifts: shifts.filter(s => {
                if (!s.shiftDate) return false;
                const d = new Date(s.shiftDate);
                return d.getMonth() + 1 === month && d.getFullYear() === year;
            }) };
            filename = `monthly-report-${year}-${month}`;
        }

        const exportPath = path.join(STORAGE_PATH, 'exports', `${filename}-${Date.now()}.json`);
        await fs.mkdir(path.join(STORAGE_PATH, 'exports'), { recursive: true });
        await fs.writeFile(exportPath, JSON.stringify(data, null, 2));

        const downloadUrl = `/api/download-export?file=${encodeURIComponent(path.basename(exportPath))}`;
        res.json({ success: true, download_url: downloadUrl });
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'فشل في التصدير' });
    }
});

// POST /api/shifts/reports/generate - generate report
app.post('/api/shifts/reports/generate', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftReportsGenerated) {
            return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        }
        const { type, date_from, date_to } = req.body;
        if (!type) {
            return res.status(400).json({ error: 'نوع التقرير مطلوب' });
        }
        const shifts = await readShifts();
        let reportData = {};
        let filename = '';

        if (type === 'daily') {
            const date = date_from || new Date().toISOString().split('T')[0];
            reportData = { date, shifts: shifts.filter(s => s.shiftDate === date) };
            filename = `daily-report-${date}.pdf`;
        } else if (type === 'weekly') {
            const weekStart = date_from;
            const weekEnd = date_to;
            reportData = { weekStart, weekEnd, shifts: shifts.filter(s => s.shiftDate >= weekStart && s.shiftDate <= weekEnd) };
            filename = `weekly-report-${weekStart}.pdf`;
        } else if (type === 'monthly') {
            const month = parseInt(date_from);
            const year = parseInt(date_to);
            reportData = { month, year, shifts: shifts.filter(s => {
                if (!s.shiftDate) return false;
                const d = new Date(s.shiftDate);
                return d.getMonth() + 1 === month && d.getFullYear() === year;
            }) };
            filename = `monthly-report-${year}-${month}.pdf`;
        } else if (type === 'shift_detail') {
            const shiftId = parseInt(req.body.shift_id);
            reportData = { shift: shifts.find(s => s.id === shiftId) };
            filename = `shift-detail-${shiftId}.pdf`;
        }

        const reportPath = path.join(STORAGE_PATH, 'reports', filename);
        await fs.mkdir(path.join(STORAGE_PATH, 'reports'), { recursive: true });
        await fs.writeFile(reportPath, JSON.stringify(reportData, null, 2));

        const reportId = await db.ShiftReportsGenerated.create({
            report_type: type,
            report_date_from: date_from || null,
            report_date_to: date_to || null,
            shift_id: req.body.shift_id || null,
            report_data: JSON.stringify(reportData),
            file_path: reportPath,
            file_format: 'pdf',
            generated_by: req.user.name
        });

        broadcast({
            type: 'shift_report_generated',
            report_id: reportId,
            type: type,
            download_url: `/api/download-report/${reportId}`
        });

        res.json({ success: true, report_id: reportId, file_path: reportPath });
    } catch (error) {
        console.error('Report generation error:', error);
        res.status(500).json({ error: 'فشل في إنشاء التقرير' });
    }
});

// GET /api/shifts/reports/:id - get generated report
app.get('/api/shifts/reports/:id', authenticate, async (req, res) => {
    try {
        if (!dbAvailable() || !db.ShiftReportsGenerated) {
            return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        }
        const report = await db.ShiftReportsGenerated.getById(req.params.id);
        if (!report) {
            return res.status(404).json({ error: 'التقرير غير موجود' });
        }
        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التقرير' });
    }
});

// ============================================
// API: التقرير اليومي
// ============================================
app.get('/api/daily-report', authenticate, async (req, res) => {
    try {
        const shiftId = req.query.shiftId ? parseInt(req.query.shiftId) : null;
        let shift, shiftReports = [];
        let allShifts = [];

        if (db && db.Shifts) {
            // SQLite mode
            if (shiftId) {
                shift = await db.Shifts.getById(shiftId);
            } else {
                allShifts = await db.Shifts.getAll();
                shift = allShifts[0] || null;
            }
            if (shift) {
                if (reportService) {
                    // F4: derive from the single source (reports) via ReportService;
                    // the service falls back internally to the frozen migration
                    // store (shift_reports) for pre-migration shifts.
                    const reportsObj = await reportService.getShiftReports(shift.id);
                    for (const key in reportsObj) {
                        const parts = key.split('|');
                        if (parts.length === 2) {
                            shiftReports.push({ center: parts[0], unit: parts[1], count: reportsObj[key].count || 0 });
                        }
                    }
                } else {
                    // Legacy fallback (services unavailable): frozen migration store
                    shiftReports = await db.Shifts.getShiftReports(shift.id);
                }
            }
        } else {
            // JSON fallback mode
            allShifts = await readShifts();
            shift = shiftId ? allShifts.find(s => s.id === shiftId) : allShifts[allShifts.length - 1];
            if (shift && shift.savedReports) {
                for (let key in shift.savedReports) {
                    const parts = key.split('|');
                    if (parts.length === 2) {
                        const count = shift.savedReports[key].count || 0;
                        shiftReports.push({ center: parts[0], unit: parts[1], count: count });
                    }
                }
            }
        }

        if (!shift) {
            return res.status(404).json({ error: 'لا توجد مناوبات متاحة' });
        }

        // Calculate center totals and unit ranking
        const centerBreakdown = {};
        const unitRanking = [];
        let totalReports = 0;

        shiftReports.forEach(r => {
            const count = r.count || 0;
            totalReports += count;
            centerBreakdown[r.center] = (centerBreakdown[r.center] || 0) + count;
            unitRanking.push({ center: r.center, unit: r.unit, count: count });
        });

        unitRanking.sort((a, b) => b.count - a.count);

        // Get previous shift for comparison (X13: normalize ordering locally —
        // SQLite getAll is newest-first, JSON readShifts is oldest-first)
        if (allShifts.length === 0) {
            allShifts = (db && db.Shifts) ? await db.Shifts.getAll() : await readShifts();
        }
        const shiftsDesc = [...allShifts].sort((a, b) => b.id - a.id);
        const currentIndex = shiftsDesc.findIndex(s => s.id === shift.id);
        const prevShift = currentIndex >= 0 && shiftsDesc.length > currentIndex + 1 ? shiftsDesc[currentIndex + 1] : null;
        let prevTotal = 0;
        if (prevShift) {
            if (db && db.Shifts) {
                if (reportService) {
                    const prevObj = await reportService.getShiftReports(prevShift.id);
                    prevTotal = Object.values(prevObj).reduce((sum, r) => sum + (r.count || 0), 0);
                } else {
                    const prevReports = await db.Shifts.getShiftReports(prevShift.id);
                    prevTotal = prevReports.reduce((sum, r) => sum + (r.count || 0), 0);
                }
            } else if (prevShift.savedReports) {
                for (let key in prevShift.savedReports) {
                    prevTotal += (prevShift.savedReports[key].count || 0);
                }
            }
        }

        res.json({
            shift: {
                id: shift.id,
                name: shift.shift_name || shift.name || 'نوبة',
                type: shift.shift_type || shift.type || '—',
                date: shift.shift_date || shift.date || '—',
                totalReports: totalReports
            },
            centerBreakdown: centerBreakdown,
            topUnits: unitRanking.slice(0, 10),
            previousShift: prevShift ? {
                id: prevShift.id,
                name: prevShift.shift_name || prevShift.name || 'نوبة',
                type: prevShift.shift_type || prevShift.type || '—',
                totalReports: prevTotal
            } : null,
            comparison: {
                current: totalReports,
                previous: prevTotal,
                difference: totalReports - prevTotal,
                percentChange: prevTotal > 0 ? ((totalReports - prevTotal) / prevTotal * 100).toFixed(1) : null
            }
        });
    } catch (error) {
        console.error('Daily report error:', error);
        res.status(500).json({ error: 'فشل في إنشاء التقرير اليومي' });
    }
});

// ============================================
// API: مؤشرات التشغيل (F5a — قراءة فقط من المصدر الواحد)
// ============================================
app.get('/api/indicators/dashboard', authenticate, async (req, res) => {
    try {
        if (!indicatorService) return res.status(503).json({ error: 'الخدمة غير متوفرة' });
        const bundle = await indicatorService.getDashboard();
        res.json({ success: true, ...bundle });
    } catch (error) {
        console.error('Indicators dashboard error:', error);
        res.status(500).json({ error: 'فشل في جلب مؤشرات التشغيل' });
    }
});

// ============================================
// API: البلاغات
// ============================================
app.post('/api/report', authenticate, validateBody({
    center: { required: true, type: 'string', minLength: 1, maxLength: 100 },
    unit: { required: true, type: 'string', minLength: 1, maxLength: 100 }
}), async (req, res) => {
    // Slice 1: Route → ReportService → SQLite tx → COMMIT → DispatchLogCreated
    // event → broadcast subscriber emits the SAME 'new_report' WS payload.
    const { center, unit, type } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });

    try {
        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        const shiftId = await opsEngine.shifts.resolveShiftId(req);
        if (!shiftId) return res.status(400).json({ error: 'لا توجد مناوبة نشطة - ابدأ مناوبة أولاً' });

        if (reportService) {
            const result = await reportService.createReport({ center, unit, type, shiftId }, req.user);
            return res.json(result);
        }

        // Legacy fallback (services unavailable): original inline path
        const result = await opsEngine.reports.addReport(shiftId, center, unit, type);

        if (result.success) {
            broadcast({ type: 'new_report', center, unit, shiftId });
        }
        res.json(result);
    } catch (error) {
        console.error('[Report] Error:', error);
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});


app.post('/api/undo', authenticate, async (req, res) => {
    // Slice 1: Route → ReportService → SQLite tx → COMMIT → DispatchUndone
    // event → broadcast subscriber emits the SAME 'report_undone' WS payload.
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });

    try {
        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        const shiftId = await opsEngine.shifts.resolveShiftId(req);
        if (!shiftId) return res.status(400).json({ error: 'لا توجد مناوبة نشطة' });

        if (reportService) {
            const result = await reportService.undoLastReport({ center, unit, shiftId }, req.user);
            return res.json(result);
        }

        // Legacy fallback (services unavailable): original inline path
        const result = await opsEngine.reports.undoReport(shiftId, center, unit);

        if (result.success) {
            broadcast({ type: 'report_undone', center, unit, shiftId });
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

// ============================================
// API: إحصائيات القوى العاملة
// ============================================
app.get('/api/workforce-stats/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const shifts = await readShifts();
        let shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            // Fallback to SQLite (Single Source of Truth) — shifts created via
            // Operations Engine live in SQLite only. Full JSON removal is Slice 2 scope.
            const row = await db.get('SELECT * FROM shifts WHERE id = ?', [shiftId]);
            if (row) {
                const parseJson = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
                shift = {
                    id: row.id,
                    shiftDate: row.shift_date,
                    centersData: parseJson(row.centers_data, {}),
                    vehicleData: parseJson(row.vehicle_data, {}),
                    fuelData: parseJson(row.fuel_data, {})
                };
            }
        }
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }

        const centersData = shift.centersData || {};
        let totalStaff = 0;
        let totalCars = 0;
        let missingCenters = 0;
        let readyCenters = 0;
        let centerCount = 0;
        let readyVehicles = 0;
        let maintenanceVehicles = 0;
        let brokenVehicles = 0;
        let lowFuel = 0;
        const distribution = {};
        const carDistribution = {};
        const vehicleStatus = {};
        const fuelStatus = {};
        const paramedicDistribution = {};

        // Pre-fetch paramedics from database for this shift date
        const shiftDate = shift.shiftDate;
        let dbParamedics = {};
        try {
            const teams = await db.Teams.getAll();
            for (const team of teams) {
                if (!dbParamedics[team.center]) dbParamedics[team.center] = [];
                const roster = await db.ShiftRoster.getByDateAndTeam(shiftDate, team.id);
                const absentCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
                for (const entry of roster) {
                    dbParamedics[team.center].push({
                        name: entry.employee_name,
                        shiftCode: entry.shift_code,
                        status: absentCodes.includes(entry.shift_code) ? 'غائب' : 'حاضر'
                    });
                }
            }
        } catch (e) {
            console.warn('Could not fetch paramedics from DB for stats:', e.message);
        }

        for (let center in centersData) {
            const cData = centersData[center];
            let staffCount = parseInt(cData?.staffCount) || 0;
            
            // If assignedParamedics exists in JSON, calculate present count from actual roster
            const assignedParamedics = cData?.assignedParamedics;
            if (Array.isArray(assignedParamedics) && assignedParamedics.length > 0) {
                const absentCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
                staffCount = assignedParamedics.filter(p => {
                    const code = p.shiftCode ? p.shiftCode.toString().toUpperCase() : (p.shift_code ? p.shift_code.toString().toUpperCase() : '');
                    return code && !absentCodes.includes(code);
                }).length;
                paramedicDistribution[center] = assignedParamedics;
            } else if (dbParamedics[center] && dbParamedics[center].length > 0) {
                // Fallback to database paramedics
                staffCount = dbParamedics[center].filter(p => p.status === 'حاضر').length;
                paramedicDistribution[center] = dbParamedics[center];
            }
            
            const carsCount = parseInt(cData?.carsCount) || 0;
            const vehStatus = cData?.vehicleStatus || '';
            const fuelLvl = cData?.fuelLevel || '';
            totalStaff += staffCount;
            totalCars += carsCount;
            centerCount++;
            if (staffCount >= 2 && carsCount >= 1) {
                readyCenters++;
            } else {
                missingCenters++;
            }
            if (vehStatus === 'ready') readyVehicles++;
            else if (vehStatus === 'maintenance') maintenanceVehicles++;
            else if (vehStatus === 'broken') brokenVehicles++;
            if (fuelLvl === 'low') lowFuel++;
            distribution[center] = staffCount;
            carDistribution[center] = carsCount;
            vehicleStatus[center] = vehStatus;
            fuelStatus[center] = fuelLvl;
        }

        const readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
        res.json({
            totalStaff,
            totalCars,
            missingCenters,
            readyCenters,
            centerCount,
            readinessRate,
            readyVehicles,
            maintenanceVehicles,
            brokenVehicles,
            lowFuel,
            distribution,
            carDistribution,
            vehicleStatus,
            fuelStatus,
            paramedicDistribution
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' });
    }
});

// ============================================
// API: Paramedic display for shift completion
// ============================================

/**
 * Check if a database table exists in SQLite.
 */
async function tableExists(tableName) {
    try {
        const row = await db.get(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`,
            [tableName]
        );
        return !!row;
    } catch (err) {
        return false;
    }
}

app.get('/api/shift-completion/:shiftId/:teamName', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const teamName = decodeURIComponent(req.params.teamName);
        
        // Get shift data to find the date
        const shifts = await readShifts();
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        
        const shiftDate = shift.shiftDate;
        
        // Robust shift type detection: derive from startTime, not stored shiftType
        function getShiftType(shift) {
            // Method 1: Use explicit shiftType if it's valid
            if (shift.shiftType) {
                const normalized = shift.shiftType.trim();
                if (normalized === 'صباحية' || normalized === 'صباح' || normalized === 'morning' || normalized === 'day') {
                    console.log('[SHIFT-TYPE] Using stored shiftType (day):', normalized);
                    return 'صباحية';
                }
                if (normalized === 'ليلية' || normalized === 'ليل' || normalized === 'night' || normalized === 'evening') {
                    console.log('[SHIFT-TYPE] Using stored shiftType (night):', normalized);
                    return 'ليلية';
                }
            }
            
            // Method 2: Derive from startTime (most reliable)
            // Convert UTC to Saudi Arabia time (UTC+3) before checking hour
            if (shift.startTime) {
                const startDate = new Date(shift.startTime);
                const utcHour = startDate.getUTCHours();
                const saudiHour = (utcHour + 3) % 24;
                const derived = (saudiHour >= 17 || saudiHour < 5) ? 'ليلية' : 'صباحية';
                console.log('[SHIFT-TYPE] startTime:', shift.startTime, 'UTC hour:', utcHour, 'Saudi hour:', saudiHour, '→', derived);
                return derived;
            }
            
            // Method 3: Derive from shiftName
            if (shift.shiftName) {
                if (shift.shiftName.includes('ليل')) {
                    console.log('[SHIFT-TYPE] Derived from shiftName (night):', shift.shiftName);
                    return 'ليلية';
                }
                if (shift.shiftName.includes('صباح')) {
                    console.log('[SHIFT-TYPE] Derived from shiftName (day):', shift.shiftName);
                    return 'صباحية';
                }
            }
            
            // Method 4: Fallback to current time (Saudi Arabia UTC+3)
            const now = new Date();
            const nowUtcHour = now.getUTCHours();
            const nowSaudiHour = (nowUtcHour + 3) % 24;
            const fallback = (nowSaudiHour >= 17 || nowSaudiHour < 5) ? 'ليلية' : 'صباحية';
            console.log('[SHIFT-TYPE] Fallback current UTC:', nowUtcHour, 'Saudi:', nowSaudiHour, '→', fallback);
            return fallback;
        }
        
        const shiftType = getShiftType(shift);
        const isNightShift = shiftType === 'ليلية';
        console.log('[SHIFT-TYPE] Final:', shiftType, 'isNightShift:', isNightShift);
        
        if (!shiftDate) {
            return res.json({ paramedics: [], shiftDate: null, teamName, shiftType });
        }
        
        // Convert Arabic date to ISO format (e.g., "١/٧/٢٠٢٦" → "2026-07-01")
        let isoDate = shiftDate;
        if (shiftDate && typeof shiftDate === 'string') {
            // Try to parse Arabic date format
            const arabicNumerals = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
            let normalized = shiftDate;
            for (let i = 0; i < 10; i++) {
                normalized = normalized.split(arabicNumerals[i]).join(String(i));
            }
            // Try parsing DD/MM/YYYY or D/M/YYYY
            const match = normalized.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            if (match) {
                const day = match[1].padStart(2, '0');
                const month = match[2].padStart(2, '0');
                const year = match[3];
                isoDate = `${year}-${month}-${day}`;
            } else {
                // Try YYYY-MM-DD
                const isoMatch = normalized.match(/(\d{4})-(\d{2})-(\d{2})/);
                if (isoMatch) isoDate = normalized;
            }
        }
        
        // Check if new employee tables exist
        const hasTeams = await tableExists('teams');
        const hasEmployees = await tableExists('employees');
        const hasShiftRoster = await tableExists('shift_roster');
        const hasTeamAssignments = await tableExists('team_assignments');
        
        if (!hasTeams || !hasEmployees || !hasShiftRoster || !hasTeamAssignments) {
            return res.json({ 
                paramedics: [], 
                source: 'legacy', 
                shiftDate, 
                teamName,
                message: 'جداول المسعفين غير موجودة' 
            });
        }
        
        // Query paramedics for this team and date using ISO date
        const paramedics = await db.all(`
            SELECT 
                e.employee_code,
                e.name,
                e.phone,
                e.job_title,
                sr.shift_code,
                sc.name as shift_name,
                sc.status as shift_status
            FROM employees e
            JOIN team_assignments ta ON e.id = ta.employee_id
            JOIN teams t ON t.id = ta.team_id
            LEFT JOIN shift_roster sr ON sr.employee_id = e.id 
                AND sr.shift_date = ? 
                AND sr.team_id = t.id
            LEFT JOIN shift_codes sc ON sc.code = sr.shift_code
            WHERE t.name = ? 
              AND e.is_active = 1
              AND (ta.end_date IS NULL OR ta.end_date >= ?)
            ORDER BY e.name
        `, [isoDate, teamName, isoDate]);
        
        
        // Define shift code categories for proper filtering
        const dayOnlyCodes = ['D12', 'D10', 'D11', 'D8', 'D6', 'CPD', 'CP8'];
        const nightOnlyCodes = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10', 'CPN'];
        const sharedCodes = ['CP24', 'M', 'ME', 'F', 'O12', 'O10', 'O6'];
        const offCodes = ['V', 'VC', 'E', 'EV', 'WO', 'C'];
        
        const validCodes = isNightShift 
            ? [...nightOnlyCodes, ...sharedCodes] 
            : [...dayOnlyCodes, ...sharedCodes];
        
        // Filter paramedics: show working codes for this shift + all off codes (to show as absent)
        const filteredParamedics = paramedics.filter(p => {
            if (!p.shift_code) return false;
            const codeUpper = p.shift_code.toUpperCase();
            return validCodes.includes(codeUpper) || offCodes.includes(codeUpper);
        });
        
        // Map paramedics with accurate status using database shift_status
        const paramedicsWithStatus = filteredParamedics.map(p => {
            const codeUpper = p.shift_code ? p.shift_code.toUpperCase() : '';
            const isOff = offCodes.includes(codeUpper);
            // Use actual shift_status from database for accurate display
            const actualStatus = p.shift_status || '';
            const displayStatus = isOff ? 'غائب' : 'حاضر';
            return {
                ...p,
                status: displayStatus,
                actualStatus: actualStatus
            };
        });
        
        res.json({ paramedics: paramedicsWithStatus, shiftDate, teamName, shiftType });
    } catch (error) {
        console.error('[API] Error in shift-completion:', error);
        res.json({ paramedics: [], source: 'fallback', error: error.message });
    }
});

// ============================================
// API: Save Radio Completion (Shift Quick Log)
// ============================================
app.post('/api/shift-completion', authenticate, async (req, res) => {
    // Slice 1: Route → CompletionService → SQLite tx → COMMIT →
    // CompletionUpdated (+ CenterStatusChanged on ready/not-ready flips).
    try {
        const { teams, notes } = req.body;
        const clientShiftType = req.body.shiftType;
        const clientShiftDate = req.body.shiftDate;
        if (!clientShiftType || !clientShiftDate || !teams) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }

        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        // ─── OV-S6-01: Server-stamped shift identity (SSOT) ───
        // The active shift ROW is the single source of truth. Client-derived
        // type/date (wall-clock) are NEVER trusted for the stamp.
        let shiftType, shiftDate, shiftId, corrected = false;
        const activeShift = await opsEngine.shifts.getActiveShift();
        if (activeShift) {
            // Active shift: stamp verbatim from its row (no label unification)
            shiftType = activeShift.shift_type;
            shiftDate = activeShift.shift_date;
            shiftId = activeShift.id;
        } else {
            // Prep mode (no active shift): the SERVER derives the upcoming
            // type/date; client values are ignored here too.
            shiftType = deriveServerShiftType();
            shiftDate = getSaudiDateString();
            shiftId = null;
        }
        if (clientShiftType !== shiftType || clientShiftDate !== shiftDate) {
            corrected = true;
            console.warn(`[ShiftCompletion] OV-S6-01 stamp correction — client(${clientShiftType}/${clientShiftDate}) → server(${shiftType}/${shiftDate}, shift_id=${shiftId})`);
        }

        if (completionService) {
            const result = await completionService.saveCompletion(
                { shiftType, shiftDate, teams, notes, shiftId }, req.user
            );
            return res.json({
                success: true, message: 'تم حفظ التكميل', ...result,
                corrected, stampedShiftType: shiftType, stampedShiftDate: shiftDate
            });
        }

        // Legacy fallback (services unavailable): original inline path
        const result = await opsEngine.completions.saveCompletion(
            shiftId, shiftType, shiftDate, teams, notes, req.user
        );

        res.json({
            success: true, message: 'تم حفظ التكميل', ...result,
            corrected, stampedShiftType: shiftType, stampedShiftDate: shiftDate
        });
    } catch (error) {
        console.error('[API] Error saving shift-completion:', error);
        res.status(500).json({ error: 'فشل في حفظ التكميل' });
    }
});


// ============================================
// API: Get Radio Completion (latest for shift date + type)
// ============================================
app.get('/api/completion/latest', authenticate, async (req, res) => {
    // Slice 1: Route → CompletionService → SQLite (read)
    try {
        const { shiftDate, shiftType } = req.query;
        const shiftIdParam = req.query.shift_id || req.query.shiftId || null;

        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        // OV-S6-01: read by shift_id — label-agnostic, so historically
        // mis-stamped completions stay visible through their own shift.
        if (shiftIdParam) {
            const shiftId = parseInt(shiftIdParam);
            if (isNaN(shiftId)) return res.status(400).json({ error: 'shift_id غير صالح' });
            const byShift = completionService
                ? await completionService.getLatestByShiftId(shiftId)
                : await opsEngine.completions.getLatestByShiftId(shiftId);
            if (!byShift) return res.json({ success: false, message: 'لا يوجد تكميل محفوظ لهذه المناوبة' });
            return res.json({ success: true, completion: byShift });
        }

        // Backward-compatible path: latest by shift date + type
        if (!shiftDate || !shiftType) return res.status(400).json({ error: 'shiftDate and shiftType required' });

        const completion = completionService
            ? await completionService.getLatest({ shiftDate, shiftType })
            : await opsEngine.completions.getLatestCompletion(shiftDate, shiftType);
        if (!completion) return res.json({ success: false, message: 'لا يوجد تكميل محفوظ لهذه المناوبة' });

        res.json({ success: true, completion });
    } catch (error) {
        console.error('[API] Error getting shift-completion:', error);
        res.status(500).json({ error: 'فشل في جلب التكميل' });
    }
});


// ============================================
// API: المستندات (التحديثات التشغيلية)
// ============================================
app.get('/api/docs', authenticate, async (req, res) => {
    try {
        const docs = await readDocs();
        res.json({ success: true, docs });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التحديثات' });
    }
});

app.post('/api/upload-doc', authenticate, async (req, res) => {
    try {
        const { filename, fileData, description, fileType, category, priority } = req.body;
        if (!filename || !fileData) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const docs = await readDocs();
        const newDoc = {
            id: Date.now().toString(),
            filename: filename,
            fileData: fileData,
            fileType: fileType || 'application/octet-stream',
            description: description || '',
            category: category || 'أخرى',
            priority: priority || 'normal',
            uploader: req.body.uploader || 'المشرف',
            uploadDate: new Date().toISOString()
        };
        docs.push(newDoc);
        await writeDocs(docs);
        
        broadcast({
            type: 'doc_uploaded',
            message: 'تم رفع مستند جديد: ' + newDoc.filename,
            doc: { id: newDoc.id, filename: newDoc.filename, category: newDoc.category }
        });
        
        // Create notifications for admin/director
        try {
            if (dbAvailable() && db.Notifications) {
                const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
                const admins = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
                for (const admin of admins) {
                    await db.Notifications.create({
                        user_id: admin.id.toString(),
                        title: 'مستند جديد',
                        message: 'تم رفع مستند جديد: ' + newDoc.filename,
                        type: 'info'
                    });
                }
            }
        } catch (notifErr) {
            console.error('Notification creation error:', notifErr);
        }
        
        // Audit log
        await addAuditLogEntry('doc_uploaded', 'تم رفع مستند: ' + newDoc.filename, 'files', req.user.name, req.user.role, req.user.id);
        
        res.json({ success: true, doc: newDoc });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في رفع التحديث' });
    }
});

app.get('/api/download-doc/:id', authenticate, async (req, res) => {
    try {
        const docs = await readDocs();
        const doc = docs.find(d => d.id === req.params.id);
        if (!doc) {
            return res.status(404).json({ error: 'التحديث غير موجود' });
        }
        const buffer = Buffer.from(doc.fileData, 'base64');
        res.setHeader('Content-Type', doc.fileType);
        res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
        res.send(buffer);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تحميل التحديث' });
    }
});

app.delete('/api/delete-doc/:id', authenticate, async (req, res) => {
    try {
        const docs = await readDocs();
        const filtered = docs.filter(d => d.id !== req.params.id);
        await writeDocs(filtered);
        
        broadcast({
            type: 'doc_deleted',
            message: 'تم حذف مستند',
            docId: req.params.id
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التحديث' });
    }
});

// ============================================
// API: هوية القطاع
// ============================================
app.get('/api/get-identity', authenticate, async (req, res) => {
    try {
        await fs.access(IDENTITY_PATH);
        res.json({ exists: true });
    } catch (error) {
        res.json({ exists: false });
    }
});

app.post('/api/upload-identity', authenticate, async (req, res) => {
    try {
        const { fileData, filename } = req.body;
        if (!fileData) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const buffer = Buffer.from(fileData, 'base64');
        await fs.writeFile(IDENTITY_PATH, buffer);
        
        broadcast({
            type: 'identity_uploaded',
            message: 'تم تحديث هوية القطاع'
        });
        
        // Create notifications for admin/director
        try {
            if (dbAvailable() && db.Notifications) {
                const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
                const admins = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
                for (const admin of admins) {
                    await db.Notifications.create({
                        user_id: admin.id.toString(),
                        title: 'تحديث هوية القطاع',
                        message: 'تم تحديث هوية القطاع',
                        type: 'info'
                    });
                }
            }
        } catch (notifErr) {
            console.error('Notification creation error:', notifErr);
        }
        
        // Audit log
        await addAuditLogEntry('identity_uploaded', 'تم تحديث هوية القطاع', 'files', req.user.name, req.user.role, req.user.id);
        
        res.json({ success: true, message: 'تم رفع هوية القطاع بنجاح' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في رفع هوية القطاع' });
    }
});

app.get('/api/download-identity', authenticate, async (req, res) => {
    try {
        const data = await fs.readFile(IDENTITY_PATH);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="identity.pdf"');
        res.send(data);
    } catch (error) {
        res.status(404).json({ error: 'لا توجد هوية محفوظة' });
    }
});

// ============================================
// API: الإسعاف الجوي
// ============================================
app.get('/api/air-ambulance', authenticate, async (req, res) => {
    try {
        // Slice 6: read via FormsService (form_type='air_ambulance')
        const records = await formsService.list('air_ambulance');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجلات الإسعاف الجوي' });
    }
});

app.post('/api/save-air-ambulance', authenticate, async (req, res) => {
    try {
        const { reportNumber, dateTime, pickupLocation, destinationHospital, diagnosis, reason, patientName, patientAge, unit, paramedic } = req.body;
        if (!reportNumber || !unit || !dateTime || !destinationHospital) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 6 + F2: FormsService owns build + shift stamp + insert;
        // FormSubmitted → air_ambulance_saved (engine broadcast subscriber).
        // F2: تخزين جميع الحقول المهيكلة من الواجهة كما هي + الحقول التوافقية القديمة
        const newRecord = await formsService.submit('air_ambulance', {
            reportNumber,
            dateTime,
            pickupLocation,
            destinationHospital,
            diagnosis,
            reason,
            patientName,
            patientAge,
            unit,
            paramedic,
            // حقول توافقية مشتقة (سلوك قديم — يبقى كما هو)
            hospital: destinationHospital,
            notes: `pickup: ${pickupLocation}, diagnosis: ${diagnosis}, reason: ${reason}, patient: ${patientName}, age: ${patientAge}, paramedic: ${paramedic}`
        }, req.user);

        // Audit log
        await addAuditLogEntry('air_ambulance_saved', 'بلاغ إسعاف جوي جديد: ' + reportNumber, 'air_ambulance', req.user.name, req.user.role, req.user.id);

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ بلاغ الإسعاف الجوي' });
    }
});

app.delete('/api/delete-air-ambulance/:id', authenticate, async (req, res) => {
    try {
        // Slice 6 + Catalog D-6: FormDeleted fires inside the service → engine broadcasts 'air_ambulance_deleted'
        await formsService.remove('air_ambulance', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.delete('/api/clear-air-ambulance', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        // Slice 6 + Catalog D-7: FormsCleared fires inside the service → engine broadcasts 'air_ambulance_cleared'
        await formsService.clear('air_ambulance');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف جميع البلاغات' });
    }
});

// ============================================
// API: الحوادث
// ============================================
app.get('/api/incidents', authenticate, async (req, res) => {
    try {
        // Slice 6: read via FormsService (single owner, form_type='incident')
        const records = await formsService.list('incident');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الحوادث' });
    }
});

app.post('/api/incidents', authenticate, async (req, res) => {
    try {
        const record = req.body;
        if (!record) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 6: FormsService owns build + shift stamp + insert;
        // FormSubmitted fires after the write (engine broadcasts incident_added)
        const newRecord = await formsService.submit('incident', record, req.user);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ الحادث' });
    }
});

app.delete('/api/incidents/:id', authenticate, async (req, res) => {
    try {
        // Slice 6 + Catalog D-6: FormDeleted fires inside the service → engine broadcasts 'incident_deleted'
        await formsService.remove('incident', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الحادث' });
    }
});

// ============================================
// API: مناوبات كبار الضباط
// ============================================
app.get('/api/senior-shifts', authenticate, async (req, res) => {
    try {
        // Slice 6: read via FormsService (form_type='senior_shift')
        const records = await formsService.list('senior_shift');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب مناوبات كبار الضباط' });
    }
});

app.post('/api/senior-shifts', authenticate, async (req, res) => {
    try {
        const record = req.body;
        if (!record) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 6: FormsService owns the write; FormSubmitted → senior_shift_added
        const newRecord = await formsService.submit('senior_shift', record, req.user);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ مناوبة كبار الضباط' });
    }
});

app.delete('/api/senior-shifts/:id', authenticate, async (req, res) => {
    try {
        // Slice 6 + Catalog D-6: FormDeleted fires inside the service → engine broadcasts 'senior_shift_deleted'
        await formsService.remove('senior_shift', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف مناوبة كبار الضباط' });
    }
});

// ============================================
// API: حالات الطوارئ (E-Cases)
// ============================================
app.get('/api/e-cases', authenticate, async (req, res) => {
    try {
        // Slice 6: read via FormsService (form_type='e_case')
        const records = await formsService.list('e_case');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب حالات الطوارئ' });
    }
});

app.post('/api/e-cases', authenticate, async (req, res) => {
    try {
        const record = req.body;
        if (!record) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 6: FormsService owns the write; FormSubmitted → e_case_added
        const newRecord = await formsService.submit('e_case', record, req.user);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ حالة الطوارئ' });
    }
});

app.delete('/api/e-cases/:id', authenticate, async (req, res) => {
    try {
        // Slice 6 + Catalog D-6: FormDeleted fires inside the service → engine broadcasts 'e_case_deleted'
        await formsService.remove('e_case', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف حالة الطوارئ' });
    }
});

// ============================================
// API: بلاغات التصعيد
// ============================================
app.get('/api/escalations', authenticate, async (req, res) => {
    try {
        // Slice 6: read via FormsService (form_type='escalation')
        const records = await formsService.list('escalation');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب بلاغات التصعيد' });
    }
});

app.post('/api/escalations', authenticate, async (req, res) => {
    try {
        const record = req.body;
        if (!record) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 6: FormsService owns the write; FormSubmitted → escalation_added
        const newRecord = await formsService.submit('escalation', record, req.user);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ بلاغ التصعيد' });
    }
});

app.delete('/api/escalations/:id', authenticate, async (req, res) => {
    try {
        // Slice 6 + Catalog D-6: FormDeleted fires inside the service → engine broadcasts 'escalation_deleted'
        await formsService.remove('escalation', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف بلاغ التصعيد' });
    }
});

// ============================================
// API: التقارير اليومية
// ============================================
app.get('/api/daily-reports', authenticate, async (req, res) => {
    try {
        // Slice 6: read via FormsService (form_type='daily_report')
        const records = await formsService.list('daily_report');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التقارير اليومية' });
    }
});

app.post('/api/daily-reports', authenticate, async (req, res) => {
    try {
        const record = req.body;
        if (!record) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 6: FormsService owns the write; FormSubmitted → daily_report_added
        const newRecord = await formsService.submit('daily_report', record, req.user);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ التقرير اليومي' });
    }
});

app.delete('/api/daily-reports/:id', authenticate, async (req, res) => {
    try {
        // Slice 6 + Catalog D-6: FormDeleted fires inside the service → engine broadcasts 'daily_report_deleted'
        await formsService.remove('daily_report', req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التقرير اليومي' });
    }
});

// ============================================
// API: ملاحظات التحكم والتنسيق
// ============================================
app.get('/api/control-notes', authenticate, async (req, res) => {
    try {
        const data = await fs.readFile(CONTROL_NOTES_PATH, 'utf8');
        const parsed = JSON.parse(data);
        res.json({ success: true, notes: parsed.notes || '' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.json({ success: true, notes: '' });
        } else {
            res.status(500).json({ error: 'فشل في جلب الملاحظات' });
        }
    }
});

app.post('/api/save-control-notes', authenticate, async (req, res) => {
    try {
        const { notes } = req.body;
        await fs.writeFile(CONTROL_NOTES_PATH, JSON.stringify({ notes, updatedAt: new Date().toISOString() }));
        
        broadcast({
            type: 'control_notes_updated',
            message: 'تم تحديث ملاحظات التحكم والتنسيق'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملاحظات' });
    }
});

app.delete('/api/control-notes', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await fs.writeFile(CONTROL_NOTES_PATH, JSON.stringify({ notes: '', updatedAt: new Date().toISOString() }));
        
        broadcast({
            type: 'control_notes_cleared',
            message: 'تم مسح ملاحظات التحكم والتنسيق'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في مسح الملاحظات' });
    }
});

// ============================================
// API: إجازات التحكم والتنسيق
// ============================================
app.get('/api/vacations', authenticate, async (req, res) => {
    try {
        const data = await fs.readFile(VACATIONS_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.json([]);
        } else {
            res.status(500).json({ error: 'فشل في جلب الإجازات' });
        }
    }
});

app.post('/api/save-vacations', authenticate, async (req, res) => {
    try {
        const { vacations } = req.body;
        await fs.writeFile(VACATIONS_PATH, JSON.stringify(vacations, null, 2));
        
        broadcast({
            type: 'vacations_updated',
            message: 'تم تحديث إجازات التحكم والتنسيق'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الإجازات' });
    }
});

app.delete('/api/vacations', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await fs.writeFile(VACATIONS_PATH, JSON.stringify([]));
        
        broadcast({
            type: 'vacations_cleared',
            message: 'تم مسح الإجازات'
        });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في مسح الإجازات' });
    }
});

// ============================================
// API: الرقم السري (Secured - requires authentication)
// ============================================
// ⚠️  This endpoint returns a sensitive PIN. It requires admin/director auth.
// Consider removing this endpoint entirely and handling PIN verification server-side.
app.get('/api/get-password', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const password = await readPassword();
        res.json({ success: true, password });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الرقم السري' });
    }
});

app.post('/api/change-password', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ error: 'الرقم السري القديم والجديد مطلوبان' });
        }
        const currentPassword = await readPassword();

        if (oldPassword !== currentPassword) {
            return res.status(400).json({ error: 'الرقم السري القديم غير صحيح' });
        }

        if (newPassword.length < 4) {
            return res.status(400).json({ error: 'الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل' });
        }
        if (newPassword.length > 50) {
            return res.status(400).json({ error: 'الرقم السري طويل جداً' });
        }

        await writePassword(newPassword);

        broadcast({
            type: 'password_changed',
            message: 'تم تغيير الرقم السري'
        });

        res.json({ success: true, message: 'تم تغيير الرقم السري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تغيير الرقم السري' });
    }
});

// ============================================
// API: وقت الذروة (Server-based)
// ============================================
app.get('/api/peak-data', authenticate, async (req, res) => {
    try {
        const data = await readPeakData();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب بيانات وقت الذروة' });
    }
});

app.post('/api/peak-mission', authenticate, async (req, res) => {
    try {
        const { location, unit, startTime, endTime, priority, notes, lat, lng } = req.body;
        if (!location || !unit || !startTime || !endTime) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }

        const data = await readPeakData();
        const mission = {
            id: Date.now().toString(),
            location,
            lat: lat || null,
            lng: lng || null,
            unit,
            startTime,
            endTime,
            priority: priority || 'عالية',
            notes: notes || '',
            status: 'نشط',
            createdAt: new Date().toISOString()
        };

        data.missions.unshift(mission);
        if (data.missions.length > 100) data.missions.pop();

        data.logs.unshift({
            id: Date.now().toString(),
            icon: '🟡',
            action: 'مهمة جديدة',
            details: unit + ' في ' + location,
            priority: priority || 'عادي',
            time: new Date().toLocaleTimeString('ar-SA'),
            date: new Date().toISOString()
        });
        if (data.logs.length > 50) data.logs.pop();

        data.alerts.unshift({
            id: Date.now().toString(),
            title: 'تمركز مطلوب لـ ' + unit,
            details: 'المطلوب تمركز ' + unit + ' في ' + location + ' (' + startTime + ' - ' + endTime + ')',
            priority: priority || 'عالية',
            unit: unit,
            location: location,
            startTime: startTime,
            endTime: endTime,
            notes: notes || '',
            lat: lat || null,
            lng: lng || null,
            radius: 5000,
            missionId: mission.id,
            status: 'نشط',
            createdAt: new Date().toISOString()
        });
        if (data.alerts.length > 50) data.alerts.pop();

        await writePeakData(data);

        broadcast({
            type: 'peak_mission_added',
            message: 'مهمة جديدة في وقت الذروة: ' + unit + ' في ' + location,
            mission: mission
        });

        res.json({ success: true, mission });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ المهمة' });
    }
});

app.post('/api/peak-resolve', authenticate, async (req, res) => {
    try {
        const { alertId } = req.body;
        if (!alertId) {
            return res.status(400).json({ error: 'معرف التنبيه مطلوب' });
        }

        const data = await readPeakData();
        const alert = data.alerts.find(a => a.id === alertId);
        if (alert) {
            alert.status = 'منتهي';
            data.logs.unshift({
                id: Date.now().toString(),
                icon: '✅',
                action: 'تم التنفيذ',
                details: alert.details,
                priority: alert.priority || 'عادي',
                time: new Date().toLocaleTimeString('ar-SA'),
                date: new Date().toISOString()
            });
            if (data.logs.length > 50) data.logs.pop();
            await writePeakData(data);

            broadcast({
                type: 'peak_alert_resolved',
                message: 'تم إنهاء تنبيه وقت الذروة',
                alertId: alertId
            });
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إنهاء التنبيه' });
    }
});

app.delete('/api/peak-mission/:id', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const id = req.params.id;
        const data = await readPeakData();
        const mission = data.missions.find(m => m.id === id);
        if (!mission) {
            return res.status(404).json({ error: 'المهمة غير موجودة' });
        }
        data.missions = data.missions.filter(m => m.id !== id);
        data.alerts = data.alerts.filter(a => a.missionId !== id);
        data.logs.unshift({
            id: Date.now().toString(),
            icon: '🔴',
            action: 'مهمة محذوفة',
            details: mission.unit + ' في ' + mission.location,
            priority: mission.priority || 'عادي',
            time: new Date().toLocaleTimeString('ar-SA'),
            date: new Date().toISOString()
        });
        if (data.logs.length > 50) data.logs.pop();
        await writePeakData(data);

        broadcast({
            type: 'peak_mission_deleted',
            message: 'تم حذف مهمة وقت الذروة: ' + mission.unit + ' في ' + mission.location,
            missionId: id
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف المهمة' });
    }
});

// ============================================
// API: الثيمات العامة (لجميع المستخدمين)
// ============================================

// رفع الثيم (خلفية أو شعار)
app.post('/api/upload-theme', authenticate, upload.single('file'), handleMulterError, async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'لا يوجد ملف' });
        }

        const type = req.body.type || 'background'; // 'background' أو 'logo'
        const uploadsDir = path.join(STORAGE_PATH, 'uploads');
        
        // تحديد البادئة حسب النوع
        const prefix = type === 'logo' ? 'logo.' : 'header-bg.';
        
        // حذف الملفات القديمة من نفس النوع
        const files = await fs.readdir(uploadsDir);
        for (const f of files) {
            if (f.startsWith(prefix)) {
                await fs.unlink(path.join(uploadsDir, f));
            }
        }

        // إعادة تسمية الملف الجديد
        const ext = file.originalname.split('.').pop();
        const newFileName = `${prefix}${ext}`;
        const newPath = path.join(uploadsDir, newFileName);
        await fs.rename(file.path, newPath);

        // حفظ الإعدادات
        const currentSettings = await readThemeSettings();
        if (type === 'logo') {
            currentSettings.logoFileName = newFileName;
            currentSettings.logoFileType = file.mimetype;
        } else {
            currentSettings.fileType = file.mimetype;
            currentSettings.fileName = newFileName;
        }
        currentSettings.updatedAt = new Date().toISOString();
        await writeThemeSettings(currentSettings);

        // بث تحديث الثيم لجميع المتصلين
        broadcast({
            type: 'theme_updated',
            message: 'تم تحديث الثيم'
        });

        res.json({ success: true, message: 'تم رفع الملف بنجاح', fileName: newFileName });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في رفع الملف' });
    }
});

// جلب الثيم الحالي (الخلفية + الشعار)
app.get('/api/theme-settings', async (req, res) => {
    try {
        const data = await readThemeSettings();
        // التأكد من وجود جميع الحقول
        res.json({
            fileType: data.fileType || null,
            fileName: data.fileName || null,
            logoFileName: data.logoFileName || null,
            logoFileType: data.logoFileType || null,
            updatedAt: data.updatedAt || null
        });
    } catch (error) {
        res.json({ 
            fileType: null, 
            fileName: null,
            logoFileName: null,
            logoFileType: null,
            updatedAt: null
        });
    }
});

// حذف جميع الثيمات (الخلفية + الشعار)
app.delete('/api/remove-theme', authenticate, async (req, res) => {
    try {
        const uploadsDir = path.join(STORAGE_PATH, 'uploads');
        const files = await fs.readdir(uploadsDir);
        for (const f of files) {
            if (f.startsWith('header-bg.') || f.startsWith('logo.')) {
                await fs.unlink(path.join(uploadsDir, f));
            }
        }
        await writeThemeSettings({ 
            fileType: null, 
            fileName: null,
            logoFileName: null,
            logoFileType: null,
            updatedAt: new Date().toISOString()
        });

        broadcast({
            type: 'theme_removed',
            message: 'تم إزالة الثيمات'
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إزالة الثيمات' });
    }
});

// ============================================
// API: غرفة العمليات (Operations Command)
// ============================================

// Dashboard
app.get('/api/dashboard', authenticate, async (req, res) => {
    try {
        const data = await readDashboard();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب لوحة المعلومات' });
    }
});

app.post('/api/dashboard', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeDashboard(data);
        broadcast({
            type: 'dashboard_updated',
            message: 'تم تحديث لوحة المعلومات'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ لوحة المعلومات' });
    }
});

// Hospitals
app.get('/api/hospitals', authenticate, async (req, res) => {
    try {
        const data = await readHospitals();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المستشفيات' });
    }
});

app.post('/api/hospitals', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeHospitals(data);
        broadcast({
            type: 'hospitals_updated',
            message: 'تم تحديث قائمة المستشفيات'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ المستشفيات' });
    }
});

// References
app.get('/api/references', authenticate, async (req, res) => {
    try {
        const data = await readReferences();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المراجع' });
    }
});

app.post('/api/references', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeReferences(data);
        broadcast({
            type: 'references_updated',
            message: 'تم تحديث المراجع'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ المراجع' });
    }
});

// Timeline
app.get('/api/timeline', authenticate, async (req, res) => {
    try {
        const data = await readTimeline();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الخط الزمني' });
    }
});

app.post('/api/timeline', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeTimeline(data);
        
        // Also try to sync to SQLite with shift_id
        try {
            if (dbAvailable() && db.Timeline) {
                const shiftId = await resolveShiftId(req);
                if (Array.isArray(data) && shiftId) {
                    for (const item of data) {
                        if (item.title && item.date) {
                            await db.Timeline.create({
                                title: item.title,
                                desc: item.desc || '',
                                type: item.type || 'event',
                                date: item.date,
                                time: item.time || '',
                                shift_id: shiftId
                            });
                        }
                    }
                }
            }
        } catch (dbErr) {
            console.log('[DB] SQLite timeline sync failed:', dbErr.message);
        }
        
        broadcast({
            type: 'timeline_updated',
            message: 'تم تحديث الخط الزمني'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الخط الزمني' });
    }
});

// Announcements
app.get('/api/announcements', authenticate, async (req, res) => {
    try {
        const data = await readAnnouncements();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الإعلانات' });
    }
});

app.post('/api/announcements', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeAnnouncements(data);
        broadcast({
            type: 'announcements_updated',
            message: 'تم تحديث الإعلانات'
        });
        
        // Audit log
        await addAuditLogEntry('announcements_updated', 'تم تحديث الإعلانات', 'announcements', req.user.name, req.user.role, req.user.id);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الإعلانات' });
    }
});

app.delete('/api/announcements/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const data = await readAnnouncements();
        const filtered = data.filter(item => item.id !== req.params.id);
        await writeAnnouncements(filtered);
        broadcast({
            type: 'announcement_deleted',
            message: 'تم حذف إعلان',
            id: req.params.id
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الإعلان' });
    }
});

// Add single announcement (for EOCC UI)
app.post('/api/announcements/add', authenticate, authorize(['admin']), validateBody({
    title: { required: true, type: 'string', minLength: 1, maxLength: 500 },
    body: { required: true, type: 'string', minLength: 1, maxLength: 5000 },
    pinned: { type: 'boolean' },
    urgent: { type: 'boolean' }
}), async (req, res) => {
    try {
        const { title, body, date, pinned, urgent } = req.body;
        if (!title || !body) {
            return res.status(400).json({ error: 'العنوان والنص مطلوبان' });
        }
        const data = await readAnnouncements();
        const newAnnouncement = {
            id: Date.now().toString(),
            title,
            body,
            date: date || new Date().toISOString().split('T')[0],
            pinned: !!pinned,
            urgent: !!urgent
        };
        data.unshift(newAnnouncement);
        await writeAnnouncements(data);
        broadcast({
            type: 'announcement_added',
            message: 'تم إضافة إعلان جديد: ' + title,
            announcement: newAnnouncement
        });
        res.json({ success: true, announcement: newAnnouncement });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إضافة الإعلان' });
    }
});

// Unit Locations API
app.get('/api/unit-locations', authenticate, async (req, res) => {
    try {
        const locations = await readUnitLocations();
        const addresses = await readUnitLocationAddresses();
        res.json({ success: true, locations, addresses });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب مواقع الفرق' });
    }
});

app.post('/api/unit-locations', authenticate, async (req, res) => {
    try {
        const { center, unit, lat, lng, address } = req.body;
        if (!center || !unit || lat === undefined || lng === undefined) {
            return res.status(400).json({ error: 'بيانات ناقصة: center, unit, lat, lng مطلوبة' });
        }
        const locations = await readUnitLocations();
        // Remove unit from any other center first (to avoid duplicates)
        for (const c in locations) {
            if (c !== center && locations[c][unit]) {
                delete locations[c][unit];
            }
        }
        if (!locations[center]) locations[center] = {};
        locations[center][unit] = [parseFloat(lat), parseFloat(lng)];
        await writeUnitLocations(locations);

        // Save address if provided
        if (address) {
            const addresses = await readUnitLocationAddresses();
            addresses[unit] = address;
            await writeUnitLocationAddresses(addresses);
        }

        const addresses = await readUnitLocationAddresses();
        broadcast({
            type: 'unit_location_updated',
            message: 'تم تحديث موقع ' + unit + ' في ' + center,
            center, unit, lat, lng
        });
        res.json({ success: true, locations, addresses });
    } catch (error) {
        console.error('Unit location update error:', error);
        res.status(500).json({ error: 'فشل في تحديث الموقع' });
    }
});

app.post('/api/unit-location-addresses', authenticate, async (req, res) => {
    try {
        const { unit, address } = req.body;
        if (!unit || !address) {
            return res.status(400).json({ error: 'بيانات ناقصة: unit و address مطلوبان' });
        }
        const addresses = await readUnitLocationAddresses();
        addresses[unit] = address;
        await writeUnitLocationAddresses(addresses);
        broadcast({
            type: 'unit_location_updated',
            message: 'تم تحديث عنوان ' + unit,
            unit, address
        });
        res.json({ success: true, addresses });
    } catch (error) {
        console.error('Unit location address update error:', error);
        res.status(500).json({ error: 'فشل في تحديث العنوان' });
    }
});

app.get('/api/admin/stats', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const data = await readData();
        const shifts = await readShifts();
        let users = [];
        try {
            users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
            if (!Array.isArray(users)) users = [];
        } catch (e) { users = []; }
        let auditLog = [];
        try { auditLog = await readAuditLog(); } catch (e) { auditLog = []; }
        let reports = [];
        try { reports = await readReportEntry(); } catch (e) { reports = []; }
        
        // Ensure data is object
        const safeData = data || {};
        const safeShifts = Array.isArray(shifts) ? shifts : [];
        const safeUsers = Array.isArray(users) ? users : [];
        
        // Calculate stats
        const totalReports = Object.values(safeData).reduce((sum, r) => sum + (r && r.count ? r.count : 0), 0);
        const activeCenters = Object.keys(safeData).filter(k => safeData[k] && safeData[k].count > 0).length;
        const totalShifts = safeShifts.length;
        const totalUsers = safeUsers.filter(u => u && u.isActive).length;
        
        // Hourly distribution
        const hourlyDistribution = {};
        for (let i = 0; i < 24; i++) hourlyDistribution[i] = 0;
        // Fill from report timestamps
        for (let key in safeData) {
            const report = safeData[key];
            if (report && report.times && Array.isArray(report.times)) {
                for (const timeStr of report.times) {
                    try {
                        const hour = parseInt(timeStr.split(' ')[1].split(':')[0]);
                        if (!isNaN(hour) && hour >= 0 && hour < 24) {
                            hourlyDistribution[hour] += 1;
                        }
                    } catch (e) { /* ignore malformed timestamps */ }
                }
            }
        }
        
        // Center performance - use actual center names from centersData
        const centerStats = {};
        const centerNames = Object.keys(centersData);
        for (let i = 0; i < centerNames.length; i++) {
            const center = centerNames[i];
            let centerReports = 0;
            for (let key in safeData) {
                const parts = key.split('|');
                if (parts.length === 2 && parts[0] === center) {
                    centerReports += (safeData[key] && safeData[key].count ? safeData[key].count : 0);
                }
            }
            centerStats[center] = centerReports;
        }
        
        // Last 7 days stats
        const last7Days = [];
        const now = new Date();
        for (let i = 6; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const year = d.getFullYear();
            const month = (d.getMonth() + 1).toString().padStart(2, '0');
            const day = d.getDate().toString().padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;
            const dayShifts = safeShifts.filter(s => s && s.shiftDate === dateStr);
            const dayReports = dayShifts.reduce((sum, s) => sum + (s && s.totalReports ? s.totalReports : 0), 0);
            last7Days.push({ date: dateStr, reports: dayReports });
        }
        
        // Top 10 units
        const unitStats = [];
        for (let key in safeData) {
            if (safeData[key] && safeData[key].count > 0) {
                unitStats.push({ key, count: safeData[key].count });
            }
        }
        unitStats.sort((a, b) => b.count - a.count);
        
        res.json({
            success: true,
            stats: {
                totalReports,
                activeCenters,
                totalShifts,
                totalUsers,
                hourlyDistribution,
                last7Days,
                centerStats,
                topUnits: unitStats.slice(0, 10)
            }
        });
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ error: 'فشل في جلب الإحصائيات: ' + error.message });
    }
});

// ============================================
// API: AI Monitor — System Health & Alerts
// ============================================
app.get('/api/admin/monitor/health', authenticate, authorize(['admin']), (req, res) => {
    try {
        res.json({ success: true, health: aiMonitor.getHealth() });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب حالة النظام' });
    }
});

app.get('/api/admin/monitor/stats', authenticate, authorize(['admin']), (req, res) => {
    try {
        res.json({ success: true, stats: aiMonitor.getStats() });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الإحصائيات' });
    }
});

app.get('/api/admin/monitor/alerts', authenticate, authorize(['admin']), (req, res) => {
    try {
        const filter = {};
        if (req.query.level) filter.level = req.query.level;
        if (req.query.category) filter.category = req.query.category;
        res.json({ success: true, alerts: aiMonitor.getAlerts(filter) });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التنبيهات' });
    }
});

app.post('/api/admin/monitor/alerts/:id/resolve', authenticate, authorize(['admin']), (req, res) => {
    try {
        const success = aiMonitor.resolveAlert(req.params.id);
        if (success) {
            res.json({ success: true, message: 'تم حل التنبيه' });
        } else {
            res.status(404).json({ error: 'التنبيه غير موجود أو تم حله مسبقاً' });
        }
    } catch (error) {
        res.status(500).json({ error: 'فشل في حل التنبيه' });
    }
});

app.get('/api/admin/monitor/logs', authenticate, authorize(['admin']), (req, res) => {
    try {
        const filter = {};
        if (req.query.level) filter.level = req.query.level;
        if (req.query.category) filter.category = req.query.category;
        if (req.query.limit) filter.limit = parseInt(req.query.limit);
        res.json({ success: true, logs: aiMonitor.getLogs(filter) });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب السجلات' });
    }
});

app.post('/api/admin/monitor/force-check', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const health = await aiMonitor.forceCheck();
        res.json({ success: true, health });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تشغيل فحص النظام' });
    }
});

// ============================================
// API: Auto-Fix Engine — الإصلاح التلقائي (disabled - module not available)
// ============================================
/*
app.post('/api/admin/auto-fix', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const result = await autoFixEngine.runAll(
            () => currentShiftId,
            (id) => { currentShiftId = id; }
        );
        broadcast({
            type: 'auto_fix_complete',
            message: `تم تشغيل الإصلاح التلقائي — ${result.totalFixed} إصلاح`,
            result
        });
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('Auto-fix error:', error);
        res.status(500).json({ error: 'فشل في تشغيل الإصلاح التلقائي' });
    }
});

app.get('/api/admin/auto-fix/logs', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        res.json({ success: true, logs: autoFixEngine.getFixLogs(limit) });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجل الإصلاحات' });
    }
});
*/

// ============================================
// API: Frontend Errors — أخطاء المتصفح
// ============================================
app.post('/api/frontend-errors', async (req, res) => {
    try {
        const { errors, sessionId } = req.body;
        if (!errors || !Array.isArray(errors)) {
            return res.status(400).json({ error: 'Invalid payload' });
        }
        for (const err of errors) {
            await db.run(
                `INSERT INTO frontend_errors (timestamp, type, message, file, line, column, stack, page_url, page_path, user_agent, screen, session_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    err.page ? err.page.timestamp : new Date().toISOString(),
                    err.type,
                    err.message ? err.message.substring(0, 1000) : '',
                    err.file,
                    err.line,
                    err.column,
                    err.stack ? err.stack.substring(0, 2000) : null,
                    err.page ? err.page.url : null,
                    err.page ? err.page.path : null,
                    err.page ? err.page.userAgent : null,
                    err.page ? err.page.screen : null,
                    sessionId || null
                ]
            );
        }
        res.json({ success: true, count: errors.length });
    } catch (error) {
        console.error('Frontend error logging failed:', error.message);
        res.status(500).json({ error: 'Failed to log errors' });
    }
});

app.get('/api/admin/frontend-errors', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const rows = await db.all(
            `SELECT * FROM frontend_errors ORDER BY timestamp DESC LIMIT ?`,
            [limit]
        );
        res.json({ success: true, errors: rows || [] });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب أخطاء المتصفح' });
    }
});


// ============================================
// API: البيانات الجغرافية للمراكز
// ============================================
const centerGeoData = {
    "جنوب 1": {
        center: [24.7136, 46.6753],
        radius: 5000,
        boundaries: { north: 24.7500, south: 24.6800, east: 46.7200, west: 46.6300 },
        address: "طريق الملك فهد، الرياض"
    },
    "جنوب 2": {
        center: [24.7000, 46.6600],
        radius: 4000,
        boundaries: { north: 24.7300, south: 24.6700, east: 46.6900, west: 46.6300 },
        address: "حي المنصورة، الرياض"
    },
    "جنوب 3": {
        center: [24.6850, 46.6450],
        radius: 3500,
        boundaries: { north: 24.7100, south: 24.6600, east: 46.6700, west: 46.6200 },
        address: "الخالدية، الرياض"
    },
    "جنوب 4": {
        center: [24.7200, 46.6900],
        radius: 4500,
        boundaries: { north: 24.7550, south: 24.6900, east: 46.7300, west: 46.6500 },
        address: "الدار البيضاء، الرياض"
    },
    "جنوب 5": {
        center: [24.7300, 46.7000],
        radius: 4000,
        boundaries: { north: 24.7600, south: 24.7000, east: 46.7350, west: 46.6700 },
        address: "الدار البيضاء، الرياض"
    },
    "جنوب 6": {
        center: [24.6700, 46.6400],
        radius: 3500,
        boundaries: { north: 24.7000, south: 24.6400, east: 46.6700, west: 46.6100 },
        address: "الإسكان، الرياض"
    },
    "جنوب 7": {
        center: [24.6500, 46.6200],
        radius: 4000,
        boundaries: { north: 24.6800, south: 24.6200, east: 46.6500, west: 46.5900 },
        address: "الحائر، الرياض"
    },
    "جنوب 8": {
        center: [24.6900, 46.6700],
        radius: 3500,
        boundaries: { north: 24.7200, south: 24.6600, east: 46.7000, west: 46.6400 },
        address: "الشفاء، الرياض"
    },
    "جنوب 9": {
        center: [24.7050, 46.6800],
        radius: 3000,
        boundaries: { north: 24.7300, south: 24.6800, east: 46.7100, west: 46.6500 },
        address: "عكاظ، الرياض"
    },
    "جنوب 10": {
        center: [24.6600, 46.6100],
        radius: 4500,
        boundaries: { north: 24.6900, south: 24.6300, east: 46.6400, west: 46.5800 },
        address: "ديراب، الرياض"
    },
    "سريع 1": {
        center: [24.7100, 46.6850],
        radius: 8000,
        boundaries: { north: 24.7700, south: 24.6600, east: 46.7500, west: 46.6200 },
        address: "مستشفى الملك خالد، الرياض"
    },
    "سريع 2": {
        center: [24.6900, 46.6600],
        radius: 7000,
        boundaries: { north: 24.7400, south: 24.6400, east: 46.7100, west: 46.6100 },
        address: "الشفاء، الرياض"
    }
};

app.get('/api/center-geo', authenticate, (req, res) => {
    res.json({ success: true, data: centerGeoData });
});

app.post('/api/locate-report', authenticate, validateBody({
    lat: { required: true, type: 'number', min: -90, max: 90 },
    lng: { required: true, type: 'number', min: -180, max: 180 }
}), (req, res) => {
    const { lat, lng } = req.body;

    let foundCenter = null;
    let minDistance = Infinity;

    for (let center in centerGeoData) {
        const data = centerGeoData[center];
        const centerLat = data.center[0];
        const centerLng = data.center[1];

        const distance = getDistance(lat, lng, centerLat, centerLng);

        if (distance < data.radius && distance < minDistance) {
            minDistance = distance;
            foundCenter = center;
        }
    }

    res.json({
        success: true,
        center: foundCenter,
        distance: minDistance,
        location: foundCenter ? centerGeoData[foundCenter].address : 'غير معروف'
    });
});

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c * 1000;
}

// ============================================
// API: الجدول الشهري
// ============================================
app.post('/api/upload-monthly-table', authenticate, uploadExcel.single('file'), handleMulterError, async (req, res) => {
    try {
        const file = req.file;
        if (!file) {
            return res.status(400).json({ error: 'لا يوجد ملف' });
        }
        await fs.copyFile(file.path, MONTHLY_TABLE_PATH);
        await fs.unlink(file.path);
        
        broadcast({
            type: 'monthly_table_uploaded',
            message: 'تم رفع جدول شهري جديد'
        });
        
        res.json({ success: true, message: 'تم حفظ الجدول الشهري بنجاح' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ الجدول: ' + error.message });
    }
});

app.get('/api/get-monthly-table', authenticate, async (req, res) => {
    try {
        const data = await fs.readFile(MONTHLY_TABLE_PATH);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.send(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'لا يوجد جدول شهري محفوظ' });
        } else {
            res.status(500).json({ error: 'فشل في جلب الجدول' });
        }
    }
});

app.get('/api/check-monthly-table', authenticate, async (req, res) => {
    try {
        await fs.access(MONTHLY_TABLE_PATH);
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.json({ exists: true });
    } catch (error) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.json({ exists: false });
    }
});

app.delete('/api/monthly-table', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        await fs.unlink(MONTHLY_TABLE_PATH);

        broadcast({
            type: 'monthly_table_deleted',
            message: 'تم حذف الجدول الشهري'
        });

        res.json({ success: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'لا يوجد جدول شهري محفوظ' });
        }
        res.status(500).json({ error: 'فشل في حذف الجدول الشهري' });
    }
});

// ============================================
// API: تصدير Excel
// ============================================
app.get('/api/export', authenticate, async (req, res) => {
    try {
        const reports = await readData();
        const safeReports = (reports && typeof reports === 'object') ? reports : {};
        let rows = [
            ["تقرير بلاغات الفرق الإسعافية - قطاع جنوب الرياض"],
            ["تاريخ التصدير:", new Date().toLocaleString("ar-SA")],
            [],
            ["المركز", "الوحدة", "عدد البلاغات", "التواقيت"]
        ];
        for (let center in centersData) {
            for (let unit of centersData[center]) {
                let key = `${center}|${unit}`;
                let record = safeReports[key] || { count: 0, times: [] };
                let timesStr = (record.times && record.times.length) ? record.times.join(" ؛ ") : "لا يوجد بلاغات";
                rows.push([center, unit, record.count, timesStr]);
            }
        }
        let total = Object.values(safeReports).reduce((sum, r) => sum + (r.count || 0), 0);
        rows.push([], ["الإجمالي الكلي", "", total, ""]);
        let csv = rows.map(row => row.map(cell => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
        const fileName = `بلاغات_${new Date().toISOString().slice(0,10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.status(200).send("\uFEFF" + csv);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// ============================================
// API: غرفة العمليات التشغيلية
// ============================================

const OPS_UPLOAD_DIR = path.join(STORAGE_PATH, 'uploads', 'operational');
const OPS_METADATA_PATH = path.join(OPS_UPLOAD_DIR, 'metadata.json');
const ANNOUNCEMENTS_PATH = path.join(STORAGE_PATH, 'announcements.json');

// التأكد من وجود المجلد والملف
async function ensureOpsDir() {
    try {
        await fs.mkdir(OPS_UPLOAD_DIR, { recursive: true });
        try {
            await fs.access(OPS_METADATA_PATH);
        } catch {
            await fs.writeFile(OPS_METADATA_PATH, JSON.stringify([]));
        }
    } catch (e) {}
}
ensureOpsDir();

// قراءة الميتاداتا
async function readOpsMetadata() {
    try {
        const data = await fs.readFile(OPS_METADATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch {
        return [];
    }
}

// كتابة الميتاداتا
async function writeOpsMetadata(data) {
    await fs.writeFile(OPS_METADATA_PATH, JSON.stringify(data, null, 2));
}

// رفع الملفات — مع فلترة الأنواع وحدود
const opsUpload = multer({
    dest: OPS_UPLOAD_DIR,
    limits: { fileSize: OPS_MAX_FILE_SIZE, files: 10 },
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            'application/pdf',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.ms-powerpoint'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مسموح: ' + file.mimetype), false);
        }
    }
});

app.post('/api/upload-operational', authenticate, opsUpload.array('files'), handleMulterError, async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'لا يوجد ملفات' });
        }
        
        const metadata = await readOpsMetadata();
        const results = [];
        
        for (const file of files) {
            const safeOriginalName = path.basename(file.originalname);
            const ext = path.extname(safeOriginalName);
            const newFilename = `${Date.now()}-${safeOriginalName}`;
            const newPath = path.join(OPS_UPLOAD_DIR, newFilename);
            await fs.rename(file.path, newPath);
            
            const entry = {
                id: Date.now() + Math.random().toString(36).substr(2, 4),
                filename: file.originalname,
                storedName: newFilename,
                size: file.size,
                mimeType: file.mimetype,
                uploadDate: new Date().toISOString(),
                uploader: req.body.uploader || 'المشرف',
                category: req.body.category || 'عام',
                note: req.body.note || '',
                icon: file.mimetype.startsWith('image/') ? '🖼️' :
                      file.mimetype === 'application/pdf' ? '📄' :
                      file.mimetype.includes('word') ? '📝' :
                      file.mimetype.includes('excel') ? '📊' : '📎'
            };
            metadata.unshift(entry);
            results.push(entry);
        }
        
        await writeOpsMetadata(metadata);
        
        broadcast({
            type: 'ops_files_uploaded',
            message: 'تم رفع ' + results.length + ' ملف/ملفات تشغيلية جديدة',
            count: results.length,
            files: results.map(f => ({ id: f.id, filename: f.filename, category: f.category }))
        });
        
        // Create notifications for admin/director
        try {
            if (dbAvailable() && db.Notifications) {
                const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
                const admins = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
                for (const admin of admins) {
                    await db.Notifications.create({
                        user_id: admin.id.toString(),
                        title: 'ملفات تشغيلية جديدة',
                        message: 'تم رفع ' + results.length + ' ملف/ملفات تشغيلية جديدة',
                        type: 'info'
                    });
                }
            }
        } catch (notifErr) {
            console.error('Notification creation error:', notifErr);
        }
        
        // Audit log
        await addAuditLogEntry('ops_files_uploaded', 'تم رفع ملفات تشغيلية: ' + results.length, 'files', req.user.name, req.user.role, req.user.id);
        
        res.json({ success: true, count: results.length, files: results });
    } catch (error) {
        console.error('خطأ في رفع الملفات:', error);
        res.status(500).json({ error: 'فشل في رفع الملفات' });
    }
});

// جلب الملفات
app.get('/api/operational-files', authenticate, async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        res.json({ success: true, files: metadata });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الملفات' });
    }
});

// GET /api/ops-files - alias for operations-command.html compatibility
app.get('/api/ops-files', authenticate, async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        const typeMap = {
            'application/pdf': 'pdf',
            'image/jpeg': 'img', 'image/png': 'img', 'image/gif': 'img', 'image/webp': 'img',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
            'application/msword': 'word',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
            'application/vnd.ms-excel': 'excel',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'ppt',
            'application/vnd.ms-powerpoint': 'ppt'
        };
        const files = metadata.map(f => ({
            id: f.id,
            name: f.filename,
            type: typeMap[f.mimeType] || 'pdf',
            size: f.size > 1048576 ? (f.size/1048576).toFixed(1)+' MB' : (f.size/1024).toFixed(0)+' KB',
            date: f.uploadDate ? f.uploadDate.split('T')[0] : '',
            url: '/api/download-operational/' + f.id
        }));
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الملفات' });
    }
});

// POST /api/ops-files - alias for upload (multipart form-data)
app.post('/api/ops-files', authenticate, opsUpload.array('files'), handleMulterError, async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'لا يوجد ملفات' });
        }
        const shiftId = await resolveShiftId(req);
        const metadata = await readOpsMetadata();
        const results = [];
        for (const file of files) {
            const safeOriginalName = path.basename(file.originalname);
            const ext = path.extname(safeOriginalName);
            const newFilename = `${Date.now()}-${safeOriginalName}`;
            const newPath = path.join(OPS_UPLOAD_DIR, newFilename);
            await fs.rename(file.path, newPath);
            const entry = {
                id: Date.now() + Math.random().toString(36).substr(2, 4),
                filename: file.originalname,
                storedName: newFilename,
                size: file.size,
                mimeType: file.mimetype,
                uploadDate: new Date().toISOString(),
                uploader: req.body.uploader || 'مستخدم',
                category: req.body.category || 'عام',
                note: req.body.note || '',
                shift_id: shiftId,
                icon: file.mimetype.startsWith('image/') ? '🖼️' :
                      file.mimetype === 'application/pdf' ? '📄' :
                      file.mimetype.includes('word') ? '📝' :
                      file.mimetype.includes('excel') ? '📊' : '📎'
            };
            metadata.unshift(entry);
            results.push(entry);
            
            // Also save to SQLite ops_files if available
            try {
                if (dbAvailable() && db.OpsFiles) {
                    await db.OpsFiles.create({
                        id: entry.id,
                        filename: entry.filename,
                        storedName: entry.storedName,
                        size: entry.size,
                        mimeType: entry.mimeType,
                        uploadDate: entry.uploadDate,
                        uploader: entry.uploader,
                        category: entry.category,
                        note: entry.note,
                        shift_id: shiftId
                    });
                }
            } catch (dbErr) {
                console.log('[DB] SQLite ops_files save failed:', dbErr.message);
            }
        }
        await writeOpsMetadata(metadata);
        broadcast({
            type: 'ops_files_uploaded',
            message: 'تم رفع ' + results.length + ' ملف/ملفات تشغيلية جديدة',
            count: results.length
        });
        
        // Create notifications for admin/director
        try {
            if (dbAvailable() && db.Notifications) {
                const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
                const admins = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
                for (const admin of admins) {
                    await db.Notifications.create({
                        user_id: admin.id.toString(),
                        title: 'ملفات تشغيلية جديدة',
                        message: 'تم رفع ' + results.length + ' ملف/ملفات تشغيلية جديدة',
                        type: 'info'
                    });
                }
            }
        } catch (notifErr) {
            console.error('Notification creation error:', notifErr);
        }
        
        // Audit log
        await addAuditLogEntry('ops_files_uploaded', 'تم رفع ملفات تشغيلية: ' + results.length, 'files', req.user.name, req.user.role, req.user.id);
        
        res.json({ success: true, count: results.length, files: results });
    } catch (error) {
        console.error('خطأ في رفع الملفات:', error);
        res.status(500).json({ error: 'فشل في رفع الملفات' });
    }
});

// DELETE /api/ops-files/:id - alias for delete
app.delete('/api/ops-files/:id', authenticate, async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        const index = metadata.findIndex(f => f.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'الملف غير موجود' });
        }
        const entry = metadata[index];
        const filePath = path.join(OPS_UPLOAD_DIR, entry.storedName);
        try { await fs.unlink(filePath); } catch (e) {}
        metadata.splice(index, 1);
        await writeOpsMetadata(metadata);
        broadcast({
            type: 'ops_files_deleted',
            message: 'تم حذف ملف: ' + entry.filename,
            id: req.params.id
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الملف' });
    }
});

// تحميل ملف
app.get('/api/download-operational/:id', authenticate, async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        const entry = metadata.find(f => f.id === req.params.id);
        if (!entry) {
            return res.status(404).json({ error: 'الملف غير موجود' });
        }
        const safeName = path.basename(entry.storedName);
        const filePath = path.join(OPS_UPLOAD_DIR, safeName);
        // Path traversal check
        if (!filePath.startsWith(OPS_UPLOAD_DIR + path.sep)) {
            return res.status(400).json({ error: 'مسار الملف غير صالح' });
        }
        // Check file exists before download
        try {
            await fs.access(filePath);
        } catch {
            return res.status(404).json({ error: 'الملف غير موجود على القرص' });
        }
        const safeFilename = path.basename(entry.filename).replace(/[^\w\.\-]/g, '_');
        res.download(filePath, safeFilename);
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'فشل في تحميل الملف' });
    }
});

// حذف ملف (legacy endpoint — kept for backward compatibility)
app.delete('/api/delete-operational/:id', authenticate, async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        const index = metadata.findIndex(f => f.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'الملف غير موجود' });
        }
        const entry = metadata[index];
        const safeName = path.basename(entry.storedName);
        const filePath = path.join(OPS_UPLOAD_DIR, safeName);
        if (!filePath.startsWith(OPS_UPLOAD_DIR + path.sep)) {
            return res.status(400).json({ error: 'مسار الملف غير صالح' });
        }
        try {
            await fs.unlink(filePath);
        } catch (e) {
            if (e.code !== 'ENOENT') {
                console.error('Failed to delete file:', e);
                return res.status(500).json({ error: 'فشل في حذف الملف من القرص' });
            }
        }
        metadata.splice(index, 1);
        await writeOpsMetadata(metadata);
        
        broadcast({
            type: 'ops_file_deleted',
            message: 'تم حذف ملف تشغيلي',
            id: req.params.id
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'فشل في حذف الملف' });
    }
});

// ============================================
// API: الجدولة الذكية (Smart Schedule)
// ============================================
app.get('/api/schedule/employees', authenticate, async (req, res) => {
    try {
        const employees = await readScheduleEmployees();
        res.json({ success: true, employees });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب بيانات الموظفين' });
    }
});

app.post('/api/schedule/employees', authenticate, async (req, res) => {
    try {
        const employees = Array.isArray(req.body) ? req.body : req.body.employees;
        if (!employees || !Array.isArray(employees)) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeScheduleEmployees(employees);
        broadcast({
            type: 'schedule_employees_updated',
            message: 'تم تحديث بيانات الموظفين'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ بيانات الموظفين' });
    }
});

app.get('/api/schedule/files', authenticate, async (req, res) => {
    try {
        const files = await readScheduleFiles();
        res.json({ success: true, files });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الملفات' });
    }
});

app.post('/api/schedule/files', authenticate, async (req, res) => {
    try {
        const files = Array.isArray(req.body) ? req.body : req.body.files;
        if (!files || !Array.isArray(files)) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        await writeScheduleFiles(files);
        broadcast({
            type: 'schedule_files_updated',
            message: 'تم تحديث الملفات'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملفات' });
    }
});

app.delete('/api/schedule/employees', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await writeScheduleEmployees([]);
        broadcast({
            type: 'schedule_employees_cleared',
            message: 'تم حذف جميع بيانات الموظفين'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف بيانات الموظفين' });
    }
});

// ============================================
// Health Check & Monitoring
// ============================================
// Disk usage endpoint for monitoring (admin only)
app.get('/api/disk-usage', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { exec } = require('child_process');
        const util = require('util');
        const execAsync = util.promisify(exec);
        
        let diskInfo = { total: 'N/A', used: 'N/A', available: 'N/A', percent: 'N/A' };
        
        try {
            // Try df command (Linux/Unix)
            const { stdout } = await execAsync(`df -h "${STORAGE_PATH}"`);
            const lines = stdout.trim().split('\n');
            if (lines.length >= 2) {
                const parts = lines[1].split(/\s+/);
                diskInfo = {
                    total: parts[1] || 'N/A',
                    used: parts[2] || 'N/A',
                    available: parts[3] || 'N/A',
                    percent: parts[4] || 'N/A'
                };
            }
        } catch (e) {
            // Fallback: calculate directory size manually
            let totalSize = 0;
            async function calcDir(dirPath) {
                const entries = await fs.readdir(dirPath, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = path.join(dirPath, entry.name);
                    if (entry.name === 'node_modules' || entry.name === '.git') continue;
                    if (entry.isDirectory()) {
                        await calcDir(fullPath);
                    } else {
                        const stat = await fs.stat(fullPath);
                        totalSize += stat.size;
                    }
                }
            }
            await calcDir(STORAGE_PATH);
            const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
            const sizeGB = (totalSize / 1024 / 1024 / 1024).toFixed(2);
            diskInfo = {
                total: '10 GB (Render Disk)',
                used: `${sizeMB} MB (${sizeGB} GB)`,
                available: `${(10 - parseFloat(sizeGB)).toFixed(2)} GB`,
                percent: `${((parseFloat(sizeGB) / 10) * 100).toFixed(1)}%`
            };
        }
        
        res.json({ success: true, disk: diskInfo, storagePath: STORAGE_PATH });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب معلومات القرص' });
    }
});

// ============================================
// API: سجل الأحداث والغيابات والملاحظات للمناوبات
// ============================================

// Shift Events
app.get('/api/shift-events/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const events = await contentListByShift('shift_events', shiftId);
        res.json({ success: true, events });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الأحداث' });
    }
});

app.post('/api/shift-events/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const { type, description, timestamp } = req.body;
        if (!type || !description) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const newEvent = {
            id: Date.now().toString(),
            shiftId,
            type,
            description,
            timestamp: timestamp || new Date().toISOString(),
            createdAt: new Date().toISOString()
        };
        await contentInsert('shift_events', shiftId, newEvent);
        broadcast({
            type: 'shift_event_added',
            message: 'تم إضافة حدث جديد للمناوبة',
            event: newEvent
        });
        
        // Audit log
        await addAuditLogEntry('shift_event_added', 'تم إضافة حدث جديد للمناوبة', 'shifts', req.user.name, req.user.role, req.user.id);
        
        res.json({ success: true, event: newEvent });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الحدث' });
    }
});

app.delete('/api/shift-events/:shiftId/:eventId', authenticate, async (req, res) => {
    try {
        const { shiftId, eventId } = req.params;
        await db.run('DELETE FROM shift_events WHERE shift_id = ? AND id = ?', [parseInt(shiftId), eventId]);
        broadcast({
            type: 'shift_event_deleted',
            message: 'تم حذف حدث من المناوبة',
            shiftId: parseInt(shiftId),
            eventId
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الحدث' });
    }
});

// Shift Absences
app.get('/api/shift-absences/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const absences = await contentListByShift('shift_absences', shiftId);
        res.json({ success: true, absences });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الغيابات' });
    }
});

app.post('/api/shift-absences/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const { absences } = req.body;
        if (!absences || !Array.isArray(absences)) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const newAbsences = absences.map((a, i) => ({ ...a, shiftId, id: a.id ? String(a.id) : (Date.now() + i).toString() }));
        // Archive slice: bulk-replace inside one transaction (same semantics as the JSON write)
        await withTx(async () => {
            await db.run('DELETE FROM shift_absences WHERE shift_id = ?', [shiftId]);
            for (const a of newAbsences) {
                await contentInsert('shift_absences', shiftId, a);
            }
        });
        broadcast({
            type: 'shift_absence_added',
            message: 'تم تحديث سجل الغياب'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الغياب' });
    }
});

app.delete('/api/shift-absences/:shiftId/:absenceId', authenticate, async (req, res) => {
    try {
        const { shiftId, absenceId } = req.params;
        await db.run('DELETE FROM shift_absences WHERE shift_id = ? AND id = ?', [parseInt(shiftId), absenceId]);
        broadcast({
            type: 'shift_absence_deleted',
            message: 'تم حذف غياب من المناوبة',
            shiftId: parseInt(shiftId),
            absenceId
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الغياب' });
    }
});

// Shift Notes
app.get('/api/shift-notes/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        // Slice 5: read via NotesService (single owner)
        const notes = await notesService.list(shiftId);
        res.json({ success: true, notes });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الملاحظات' });
    }
});

app.post('/api/shift-notes/:shiftId', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const { notes } = req.body;
        if (!notes || !Array.isArray(notes)) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 5: NotesService owns the bulk-replace transaction;
        // ShiftNoteAdded fires after COMMIT (engine broadcasts shift_note_added)
        await notesService.replaceAll(shiftId, notes);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملاحظة' });
    }
});

app.delete('/api/shift-notes/:shiftId/:noteId', authenticate, async (req, res) => {
    try {
        const { shiftId, noteId } = req.params;
        // Slice 5: delete via NotesService.
        // LEGACY EXCEPTION: no catalogued ShiftNoteDeleted event (DOMAIN-MODEL
        // §10.2 هـ lists ShiftNoteAdded only) — the broadcast stays here until
        // the catalog gains the event (same status as PositioningUpdated).
        await notesService.remove(parseInt(shiftId), noteId);
        // ShiftNoteDeleted (Catalog D-5) fires inside the service → engine broadcasts 'shift_note_deleted'
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الملاحظة' });
    }
});

// ============================================
// API: خطط وقت الذروة
// ============================================
app.get('/api/peak-plans', authenticate, async (req, res) => {
    try {
        // Slice 4: read via PositioningService (single owner)
        const plans = await positioningService.list();
        res.json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب خطط الذروة' });
    }
});

app.post('/api/peak-plans', authenticate, async (req, res) => {
    try {
        const { title, location } = req.body;
        if (!title || !location) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        // Slice 4: PositioningService owns build + shift stamp + insert;
        // PositioningStarted fires after the write (engine broadcasts peak_plan_added)
        const plan = await positioningService.create(req.body, req.user);
        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ خطة الذروة' });
    }
});

app.put('/api/peak-plans/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        // Slice 4: merge + save via PositioningService.
        const plan = await positioningService.update(id, req.body);
        if (!plan) return res.status(404).json({ error: 'الخطة غير موجودة' });
        // PositioningUpdated (Catalog D-4) fires inside the service → engine broadcasts 'peak_plan_updated'
        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تحديث خطة الذروة' });
    }
});

app.delete('/api/peak-plans/:id', authenticate, async (req, res) => {
    try {
        // Slice 4: delete via PositioningService; PositioningEnded fires after
        // the write when a row existed (engine broadcasts peak_plan_deleted)
        await positioningService.remove(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف خطة الذروة' });
    }
});

// ============================================
// API: سجل التدقيق
// ============================================
app.get('/api/audit-log', authenticate, async (req, res) => {
    try {
        const logs = await readAuditLog();
        // Also try to include SQLite audit logs if available
        try {
            if (dbAvailable() && db.AuditLog) {
                const dbLogs = await db.AuditLog.getAll();
                // Merge and sort by timestamp desc, deduplicate by action+timestamp
                const seen = new Set(logs.map(l => l.timestamp + '|' + l.action + '|' + l.user));
                for (const dbLog of dbLogs) {
                    const key = (dbLog.created_at || '') + '|' + (dbLog.action || '') + '|' + (dbLog.user_name || '');
                    if (!seen.has(key)) {
                        logs.push({
                            id: dbLog.id ? dbLog.id.toString() : Date.now().toString(),
                            action: dbLog.action,
                            details: dbLog.detail || '',
                            category: dbLog.type || 'general',
                            user: dbLog.user_name || 'غير معروف',
                            role: 'unknown',
                            userId: dbLog.user_id || null,
                            shift_id: dbLog.shift_id || null,
                            timestamp: dbLog.created_at || new Date().toISOString()
                        });
                    }
                }
                logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                if (logs.length > 500) logs.length = 500;
            }
        } catch (dbErr) {
            console.log('[DB] SQLite audit_log read failed:', dbErr.message);
        }
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجل التدقيق' });
    }
});

app.post('/api/audit-log', authenticate, async (req, res) => {
    try {
        const { action, details, category, user, shift_id } = req.body;
        if (!action) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const shiftId = await resolveShiftId(req);
        const logs = await readAuditLog();
        // Use client-provided user name as override if present, otherwise JWT
        var displayUser = user || req.user.name || req.user.username || 'غير معروف';
        const newEntry = {
            id: Date.now().toString(),
            action,
            details: details || '',
            category: category || 'general',
            user: displayUser,
            role: req.user.role || 'unknown',
            userId: req.user.id || req.user.userId || null,
            shift_id: shiftId,
            timestamp: new Date().toISOString()
        };
        logs.unshift(newEntry);
        if (logs.length > 500) logs.pop();
        await writeAuditLog(logs);
        
        // Also save to SQLite audit_log if available
        try {
            if (dbAvailable() && db.AuditLog) {
                await db.AuditLog.create({
                    shift_id: shiftId,
                    user_id: req.user.id || req.user.userId || null,
                    user_name: displayUser,
                    action: action,
                    detail: details || '',
                    type: category || 'general'
                });
            }
        } catch (dbErr) {
            console.log('[DB] SQLite audit_log save failed:', dbErr.message);
        }
        
        // OV-S4-02: same event as the helper — privileged roles only
        broadcastToRoles(['admin', 'director'], {
            type: 'audit_log_added',
            message: 'تم إضافة سجل تدقيق جديد',
            entry: newEntry
        });
        res.json({ success: true, entry: newEntry });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ سجل التدقيق' });
    }
});

// ============================================
// API: Notifications
// ============================================
app.get('/api/notifications', authenticate, async (req, res) => {
    try {
        const userId = req.user.id || req.user.username || req.user.userId;
        if (!userId) {
            return res.status(400).json({ error: 'لا يمكن تحديد المستخدم' });
        }
        let notifications = [];
        if (dbAvailable() && db.Notifications) {
            notifications = await db.Notifications.getByUser(userId.toString(), 50);
        }
        res.json({ success: true, notifications });
    } catch (error) {
        console.error('[API] Error fetching notifications:', error);
        res.status(500).json({ error: 'فشل في جلب الإشعارات' });
    }
});

app.post('/api/notifications', authenticate, async (req, res) => {
    try {
        const { user_id, title, message, type } = req.body;
        if (!user_id || !title) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const targetUserId = user_id.toString();
        const currentUserId = req.user.id || req.user.username || req.user.userId;
        const currentRole = req.user.role;
        if (currentRole !== 'admin' && currentRole !== 'director') {
            if (targetUserId !== (currentUserId ? currentUserId.toString() : '')) {
                return res.status(403).json({ error: 'ليس لديك الصلاحية لإرسال إشعارات لهذا المستخدم' });
            }
        }
        let notificationId = null;
        if (dbAvailable() && db.Notifications) {
            notificationId = await db.Notifications.create({
                user_id: targetUserId,
                title,
                message: message || '',
                type: type || 'info'
            });
        }
        broadcast({
            type: 'notification_created',
            message: 'تم إنشاء إشعار جديد',
            notification: { id: notificationId, user_id: targetUserId, title, message, type }
        });
        res.json({ success: true, id: notificationId });
    } catch (error) {
        console.error('[API] Error creating notification:', error);
        res.status(500).json({ error: 'فشل في إنشاء الإشعار' });
    }
});

app.post('/api/notifications/read', authenticate, async (req, res) => {
    try {
        const userId = req.user.id || req.user.username || req.user.userId;
        if (!userId) {
            return res.status(400).json({ error: 'لا يمكن تحديد المستخدم' });
        }
        if (dbAvailable() && db.Notifications) {
            await db.Notifications.markAllAsRead(userId.toString());
        }
        res.json({ success: true, message: 'تم تحديد جميع الإشعارات كمقروءة' });
    } catch (error) {
        console.error('[API] Error marking all notifications as read:', error);
        res.status(500).json({ error: 'فشل في تحديث الإشعارات' });
    }
});

app.post('/api/notifications/:id/read', authenticate, async (req, res) => {
    try {
        const notificationId = parseInt(req.params.id);
        if (isNaN(notificationId)) {
            return res.status(400).json({ error: 'معرف الإشعار غير صالح' });
        }
        const userId = req.user.id || req.user.username || req.user.userId;
        if (dbAvailable() && db.Notifications) {
            const notification = await db.Notifications.getById(notificationId);
            if (!notification) {
                return res.status(404).json({ error: 'الإشعار غير موجود' });
            }
            if (notification.user_id !== (userId ? userId.toString() : '')) {
                return res.status(403).json({ error: 'ليس لديك الصلاحية' });
            }
            await db.Notifications.markAsRead(notificationId);
        }
        res.json({ success: true, message: 'تم تحديد الإشعار كمقروء' });
    } catch (error) {
        console.error('[API] Error marking notification as read:', error);
        res.status(500).json({ error: 'فشل في تحديث الإشعار' });
    }
});

// ============================================
// API: تسجيل البلاغات (Report Entry)
// ============================================
app.get('/api/report-entry', authenticate, async (req, res) => {
    try {
        const records = await contentList('report_entries');
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البلاغات' });
    }
});

app.post('/api/report-entry', authenticate, async (req, res) => {
    try {
        const record = req.body;
        if (!record || typeof record !== 'object') {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }

        if (!opsEngine) return res.status(503).json({ error: 'Engine unavailable' });

        // ─── S5-T: ختم سيرفري من مصدر الحقيقة الواحد (نفس آلية الشريحة 4) ───
        // المناوبة النشطة هي مصدر الحقيقة الوحيد؛ لا يُثق بأي shiftId قادم من العميل.
        // بلا مناوبة نشطة ⇒ رفض 400. إن أرسل العميل معرّف مناوبة فلا بد أن يطابق
        // النشطة (منتهية/مؤرشفة/مزوّر/غير صحيح ⇒ رفض 400). الختم النهائي سيرفري دائماً.
        const activeShift = await opsEngine.shifts.getActiveShift();
        if (!activeShift) {
            return res.status(400).json({ error: 'لا توجد مناوبة نشطة - ابدأ مناوبة أولاً' });
        }
        const clientShiftId = record.shiftId != null ? record.shiftId
            : (record.shift_id != null ? record.shift_id : null);
        if (clientShiftId != null && Number(clientShiftId) !== Number(activeShift.id)) {
            console.warn(`[ReportEntry] S5-T رفض — shiftId العميل(${clientShiftId}) لا يطابق النشطة(${activeShift.id})`);
            return res.status(400).json({ error: 'معرّف المناوبة المرسل لا يطابق المناوبة النشطة' });
        }

        const records = await contentList('report_entries');
        // id/createdAt/shiftId سيرفرية فوق جسم الطلب — لا يقبل أي ختم من العميل
        const newRecord = {
            ...record,
            id: Date.now().toString(),
            createdAt: new Date().toISOString(),
            shiftId: activeShift.id,
            shift_id: activeShift.id
        };
        // Archive slice: SQLite + explicit shift stamp — القيمة المؤكدة نفسها من getActiveShift
        await contentInsert('report_entries', activeShift.id, newRecord);

        broadcast({
            type: 'report_entry_added',
            message: 'تم تسجيل بلاغ جديد',
            record: newRecord
        });

        // Create notifications for admin/director
        try {
            if (dbAvailable() && db.Notifications) {
                const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
                const admins = users.filter(u => (u.role === 'admin' || u.role === 'director') && u.isActive);
                for (const admin of admins) {
                    await db.Notifications.create({
                        user_id: admin.id.toString(),
                        title: 'بلاغ جديد',
                        message: 'تم تسجيل بلاغ جديد في النظام',
                        type: 'info'
                    });
                }
            }
        } catch (notifErr) {
            console.error('Notification creation error:', notifErr);
        }
        
        // Audit log
        await addAuditLogEntry('report_entry_added', 'تم تسجيل بلاغ جديد', 'reports', req.user.name, req.user.role, req.user.id);

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ البلاغ' });
    }
});

app.delete('/api/report-entry/:id', authenticate, async (req, res) => {
    try {
        await db.run('DELETE FROM report_entries WHERE id = ?', [req.params.id]);

        broadcast({
            type: 'report_entry_deleted',
            message: 'تم حذف بلاغ',
            recordId: req.params.id
        });

        // Audit log
        await addAuditLogEntry('report_entry_deleted', 'تم حذف بلاغ: ' + req.params.id, 'reports', req.user.name, req.user.role, req.user.id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.delete('/api/report-entry', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.run('DELETE FROM report_entries');

        broadcast({
            type: 'report_entry_cleared',
            message: 'تم حذف جميع البلاغات'
        });

        // Audit log
        await addAuditLogEntry('report_entry_cleared', 'تم حذف جميع البلاغات', 'reports', req.user.name, req.user.role, req.user.id);

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف جميع البلاغات' });
    }
});

// ============================================
// API: Employees
// ============================================
app.get('/api/employees', authenticate, async (req, res) => {
    try {
        const employees = await db.Employees.getAll();
        res.json({ success: true, employees });
    } catch (error) {
        console.error('Employees GET error:', error);
        res.status(500).json({ error: 'فشل في جلب المسعفين' });
    }
});

app.get('/api/employees/:id', authenticate, async (req, res) => {
    try {
        const employee = await db.Employees.getById(req.params.id);
        if (!employee) return res.status(404).json({ error: 'المسعف غير موجود' });
        res.json({ success: true, employee });
    } catch (error) {
        console.error('Employee GET error:', error);
        res.status(500).json({ error: 'فشل في جلب المسعف' });
    }
});

app.post('/api/employees', authenticate, authorize(['admin']), validateBody({
    employee_code: { required: true, type: 'string', minLength: 1, maxLength: 50 },
    name: { required: true, type: 'string', minLength: 1, maxLength: 200 }
}), async (req, res) => {
    try {
        const id = await db.Employees.create(req.body);
        res.json({ success: true, id });
    } catch (error) {
        console.error('Employee POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة المسعف' });
    }
});

app.put('/api/employees/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const result = await db.Employees.update(req.params.id, req.body);
        if (!result) return res.status(404).json({ error: 'المسعف غير موجود' });
        res.json({ success: true });
    } catch (error) {
        console.error('Employee PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث المسعف' });
    }
});

app.delete('/api/employees/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.Employees.delete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Employee DELETE error:', error);
        res.status(500).json({ error: 'فشل في حذف المسعف' });
    }
});

// ============================================
// API: Teams
// ============================================
app.get('/api/teams', authenticate, async (req, res) => {
    try {
        const teams = await db.Teams.getAll();
        res.json({ success: true, teams });
    } catch (error) {
        console.error('Teams GET error:', error);
        res.status(500).json({ error: 'فشل في جلب الفرق' });
    }
});

app.get('/api/teams/:id', authenticate, async (req, res) => {
    try {
        const team = await db.Teams.getById(req.params.id);
        if (!team) return res.status(404).json({ error: 'الفريق غير موجود' });
        res.json({ success: true, team });
    } catch (error) {
        console.error('Team GET error:', error);
        res.status(500).json({ error: 'فشل في جلب الفريق' });
    }
});

app.post('/api/teams', authenticate, authorize(['admin']), validateBody({
    name: { required: true, type: 'string', minLength: 1, maxLength: 100 },
    center: { required: true, type: 'string', minLength: 1, maxLength: 100 }
}), async (req, res) => {
    try {
        const id = await db.Teams.create(req.body);
        res.json({ success: true, id });
    } catch (error) {
        console.error('Team POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة الفريق' });
    }
});

app.put('/api/teams/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const result = await db.Teams.update(req.params.id, req.body);
        if (!result) return res.status(404).json({ error: 'الفريق غير موجود' });
        res.json({ success: true });
    } catch (error) {
        console.error('Team PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث الفريق' });
    }
});

app.delete('/api/teams/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.Teams.delete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('Team DELETE error:', error);
        res.status(500).json({ error: 'فشل في حذف الفريق' });
    }
});

// ============================================
// API: Shift Codes
// ============================================
app.get('/api/shift-codes', authenticate, async (req, res) => {
    try {
        const codes = await db.ShiftCodes.getAll();
        res.json({ success: true, codes });
    } catch (error) {
        console.error('ShiftCodes GET error:', error);
        res.status(500).json({ error: 'فشل في جلب رموز المناوبات' });
    }
});

app.get('/api/shift-codes/:id', authenticate, async (req, res) => {
    try {
        const code = await db.ShiftCodes.getById(req.params.id);
        if (!code) return res.status(404).json({ error: 'الرمز غير موجود' });
        res.json({ success: true, code });
    } catch (error) {
        console.error('ShiftCode GET error:', error);
        res.status(500).json({ error: 'فشل في جلب الرمز' });
    }
});

app.post('/api/shift-codes', authenticate, authorize(['admin']), validateBody({
    code: { required: true, type: 'string', minLength: 1, maxLength: 20 },
    name: { required: true, type: 'string', minLength: 1, maxLength: 200 }
}), async (req, res) => {
    try {
        const id = await db.ShiftCodes.create(req.body);
        res.json({ success: true, id });
    } catch (error) {
        console.error('ShiftCode POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة رمز المناوبة' });
    }
});

app.put('/api/shift-codes/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const result = await db.ShiftCodes.update(req.params.id, req.body);
        if (!result) return res.status(404).json({ error: 'الرمز غير موجود' });
        res.json({ success: true });
    } catch (error) {
        console.error('ShiftCode PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث رمز المناوبة' });
    }
});

app.delete('/api/shift-codes/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.ShiftCodes.delete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('ShiftCode DELETE error:', error);
        res.status(500).json({ error: 'فشل في حذف رمز المناوبة' });
    }
});

// ============================================
// API: Shift Roster
// ============================================
app.get('/api/shift-roster', authenticate, async (req, res) => {
    try {
        const { month, year } = req.query;
        if (month && year) {
            const roster = await db.ShiftRoster.getByMonthYear(parseInt(month), parseInt(year));
            res.json({ success: true, roster });
        } else {
            const roster = await db.ShiftRoster.getAll();
            res.json({ success: true, roster });
        }
    } catch (error) {
        console.error('ShiftRoster GET error:', error);
        res.status(500).json({ error: 'فشل في جلب جدول المناوبات' });
    }
});

app.get('/api/shift-roster/:id', authenticate, async (req, res) => {
    try {
        const entry = await db.ShiftRoster.getById(req.params.id);
        if (!entry) return res.status(404).json({ error: 'السجل غير موجود' });
        res.json({ success: true, entry });
    } catch (error) {
        console.error('ShiftRoster GET error:', error);
        res.status(500).json({ error: 'فشل في جلب السجل' });
    }
});

app.post('/api/shift-roster', authenticate, authorize(['admin']), validateBody({
    employee_id: { required: true, type: 'number' },
    shift_date: { required: true, type: 'string', minLength: 1 },
    shift_code: { required: true, type: 'string', minLength: 1 },
    month: { required: true, type: 'number' },
    year: { required: true, type: 'number' }
}), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const id = await db.ShiftRoster.create(req.body);
        await addShiftAuditLog({
            roster_id: id, employee_id: req.body.employee_id, team_id: req.body.team_id || null,
            shift_date: req.body.shift_date, old_shift_code: null, new_shift_code: req.body.shift_code,
            old_team_id: null, new_team_id: req.body.team_id || null,
            changed_by: req.user.username || req.user.name, changed_by_name: req.user.name,
            change_type: 'add', reason: 'إضافة سجل مناوبة جديد'
        });
        broadcast({ type: 'shift_roster_updated', payload: { type: 'single', changes: [{ roster_id: id, change_type: 'add' }], by_user: req.user.name || req.user.username } });
        res.json({ success: true, id });
    } catch (error) {
        console.error('ShiftRoster POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة سجل المناوبة' });
    }
});

app.put('/api/shift-roster/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const existing = await db.ShiftRoster.getById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'السجل غير موجود' });
        const result = await db.ShiftRoster.update(req.params.id, req.body);
        await addShiftAuditLog({
            roster_id: req.params.id, employee_id: existing.employee_id, team_id: existing.team_id,
            shift_date: existing.shift_date, old_shift_code: existing.shift_code, new_shift_code: req.body.shift_code || existing.shift_code,
            old_team_id: existing.team_id, new_team_id: req.body.team_id || existing.team_id,
            changed_by: req.user.username || req.user.name, changed_by_name: req.user.name,
            change_type: 'edit', reason: 'تحديث سجل المناوبة'
        });
        broadcast({ type: 'shift_roster_updated', payload: { type: 'single', changes: [{ roster_id: req.params.id, change_type: 'edit' }], by_user: req.user.name || req.user.username } });
        res.json({ success: true });
    } catch (error) {
        console.error('ShiftRoster PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث سجل المناوبة' });
    }
});

app.delete('/api/shift-roster/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const existing = await db.ShiftRoster.getById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'السجل غير موجود' });
        await db.ShiftRoster.delete(req.params.id);
        await addShiftAuditLog({
            roster_id: req.params.id, employee_id: existing.employee_id, team_id: existing.team_id,
            shift_date: existing.shift_date, old_shift_code: existing.shift_code, new_shift_code: null,
            old_team_id: existing.team_id, new_team_id: null,
            changed_by: req.user.username || req.user.name, changed_by_name: req.user.name,
            change_type: 'delete', reason: 'حذف سجل المناوبة'
        });
        broadcast({ type: 'shift_roster_updated', payload: { type: 'single', changes: [{ roster_id: req.params.id, change_type: 'delete' }], by_user: req.user.name || req.user.username } });
        res.json({ success: true });
    } catch (error) {
        console.error('ShiftRoster DELETE error:', error);
        res.status(500).json({ error: 'فشل في حذف سجل المناوبة' });
    }
});

// ============================================
// API: Bulk Import Shift Roster from Excel
// ============================================
app.post('/api/shift-roster/import', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { employees, roster, month, year } = req.body;
        console.log('[IMPORT DEBUG] Request body keys:', Object.keys(req.body || {}));
        console.log('[IMPORT DEBUG] employees type:', typeof employees, 'isArray:', Array.isArray(employees), 'length:', employees ? employees.length : 'null');
        console.log('[IMPORT DEBUG] roster type:', typeof roster, 'isArray:', Array.isArray(roster), 'length:', roster ? roster.length : 'null');
        console.log('[IMPORT DEBUG] month:', month, 'year:', year);
        if (!employees || !Array.isArray(employees) || !roster || !Array.isArray(roster)) {
            return res.status(400).json({ 
                error: 'بيانات الاستيراد غير صالحة',
                details: {
                    hasEmployees: !!employees,
                    employeesIsArray: Array.isArray(employees),
                    hasRoster: !!roster,
                    rosterIsArray: Array.isArray(roster),
                    month: month,
                    year: year
                }
            });
        }

        await db.beginTransaction();
        let empCount = 0;
        let rosterCount = 0;
        let teamCount = 0;
        let assignmentCount = 0;

        try {
            // Ensure teams exist (insert if not present, using existing logic)
            const allTeams = await db.Teams.getAll();
            const teamMap = {};
            for (const t of allTeams) { teamMap[t.name] = t.id; }

            // Process employees: create or update
            const employeeIdMap = {};
            for (const emp of employees) {
                const existing = await db.Employees.getByCode(emp.employee_code);
                let empId;
                if (existing) {
                    await db.Employees.update(existing.id, emp);
                    empId = existing.id;
                } else {
                    empId = await db.Employees.create(emp);
                    empCount++;
                }
                employeeIdMap[emp.employee_code] = empId;

                // Create team assignments if team provided
                if (emp.team_name && teamMap[emp.team_name]) {
                    const existingAssignments = await db.TeamAssignments.getByEmployee(empId);
                    const alreadyAssigned = existingAssignments.find(a => a.team_id === teamMap[emp.team_name]);
                    if (!alreadyAssigned) {
                        await db.TeamAssignments.create({
                            employee_id: empId,
                            team_id: teamMap[emp.team_name],
                            assigned_date: new Date().toISOString().split('T')[0],
                            is_primary: 1
                        });
                        assignmentCount++;
                    }
                }
            }

            // Delete existing roster for same month/year to avoid duplicates
            await db.ShiftRoster.deleteByMonthYear(month, year);

            // Insert roster entries
            for (const entry of roster) {
                const empId = employeeIdMap[entry.employee_code];
                if (!empId) continue;
                let teamId = null;
                if (entry.team_name && teamMap[entry.team_name]) {
                    teamId = teamMap[entry.team_name];
                }
                await db.ShiftRoster.create({
                    employee_id: empId,
                    team_id: teamId,
                    shift_date: entry.shift_date,
                    shift_code: entry.shift_code,
                    month: month,
                    year: year
                });
                rosterCount++;
            }

            await db.commitTransaction();
            res.json({ success: true, empCount, rosterCount, assignmentCount, teamCount });
        } catch (err) {
            await db.rollbackTransaction();
            throw err;
        }
    } catch (error) {
        console.error('ShiftRoster import error:', error);
        res.status(500).json({ error: 'فشل في استيراد جدول المناوبات' });
    }
});

// ============================================
// API: Clear All Shift Roster Data
// ============================================
app.post('/api/shift-roster/clear-all', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.ShiftRoster.deleteAll();
        res.json({ success: true, message: 'تم حذف جميع بيانات الجدول بنجاح' });
    } catch (error) {
        console.error('ShiftRoster clear-all error:', error);
        res.status(500).json({ error: 'فشل في حذف بيانات الجدول' });
    }
});

// ============================================
// API: Clear Shift Roster by Date Range
// ============================================
app.post('/api/shift-roster/clear', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { startDate, endDate } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'تاريخ البداية والنهاية مطلوب' });
        }
        const result = await db.run(
            'DELETE FROM shift_roster WHERE shift_date >= ? AND shift_date <= ?',
            [startDate, endDate]
        );
        res.json({ success: true, deleted: result.changes, message: `تم حذف ${result.changes} سجل من الجدول` });
    } catch (error) {
        console.error('ShiftRoster clear error:', error);
        res.status(500).json({ error: 'فشل في حذف بيانات الجدول' });
    }
});

// ============================================
// API: Shift Roster - Audit Log
// ============================================
app.get('/api/shift-roster/audit-log', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { employee_id, date_from, date_to, limit = 50 } = req.query;
        let entries;
        if (employee_id) {
            entries = await db.ShiftAuditLog.getByEmployee(parseInt(employee_id), parseInt(limit));
        } else if (date_from && date_to) {
            entries = await db.ShiftAuditLog.getByDateRange(date_from, date_to, parseInt(limit));
        } else {
            entries = await db.ShiftAuditLog.getAll(parseInt(limit));
        }
        res.json({ success: true, entries });
    } catch (error) {
        console.error('AuditLog GET error:', error);
        res.status(500).json({ error: 'فشل في جلب سجل التدقيق' });
    }
});

app.post('/api/shift-roster/audit-log', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code, old_team_id, new_team_id, change_type, reason } = req.body;
        if (!shift_date) {
            return res.status(400).json({ error: 'تاريخ المناوبة مطلوب' });
        }
        const id = await addShiftAuditLog({
            roster_id, employee_id, team_id, shift_date, old_shift_code, new_shift_code,
            old_team_id, new_team_id, changed_by: req.user.username || req.user.name,
            changed_by_name: req.user.name, change_type: change_type || 'edit', reason
        });
        res.json({ success: true, id });
    } catch (error) {
        console.error('AuditLog POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة سجل التدقيق' });
    }
});

// ============================================
// API: Shift Roster - Bulk Update
// ============================================
app.post('/api/shift-roster/bulk-update', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { changes } = req.body;
        if (!Array.isArray(changes) || changes.length === 0) {
            return res.status(400).json({ error: 'قائمة التغييرات مطلوبة' });
        }
        const updated = [];
        const conflicts = [];
        const auditRecords = [];
        await db.beginTransaction();
        try {
            for (const change of changes) {
                const { roster_id, employee_id, team_id, shift_date, shift_code, old_shift_code } = change;
                if (!roster_id) {
                    conflicts.push({ type: 'missing_id', message: 'معرف السجل مفقود', change });
                    continue;
                }
                const existing = await db.ShiftRoster.getById(roster_id);
                if (!existing) {
                    conflicts.push({ type: 'not_found', message: 'السجل غير موجود', roster_id });
                    continue;
                }
                await db.ShiftRoster.update(roster_id, {
                    employee_id: employee_id !== undefined ? employee_id : existing.employee_id,
                    team_id: team_id !== undefined ? team_id : existing.team_id,
                    shift_date: shift_date || existing.shift_date,
                    shift_code: shift_code || existing.shift_code,
                    month: existing.month,
                    year: existing.year
                });
                const auditId = await addShiftAuditLog({
                    roster_id, employee_id: employee_id || existing.employee_id,
                    team_id: team_id || existing.team_id, shift_date: shift_date || existing.shift_date,
                    old_shift_code: old_shift_code || existing.shift_code,
                    new_shift_code: shift_code || existing.shift_code,
                    old_team_id: existing.team_id, new_team_id: team_id || existing.team_id,
                    changed_by: req.user.username || req.user.name,
                    changed_by_name: req.user.name,
                    change_type: 'bulk', reason: 'تحديث جماعي'
                });
                updated.push({ roster_id, auditId });
                auditRecords.push({ roster_id, auditId });
            }
            await db.commitTransaction();
        } catch (err) {
            await db.rollbackTransaction();
            throw err;
        }
        broadcast({
            type: 'shift_roster_updated',
            payload: { type: 'bulk', changes: updated, by_user: req.user.name || req.user.username }
        });
        res.json({ success: true, updated: updated.length, conflicts, audit_log: auditRecords });
    } catch (error) {
        console.error('BulkUpdate error:', error);
        res.status(500).json({ error: 'فشل في التحديث الجماعي' });
    }
});

// ============================================
// API: Shift Roster - Swap
// ============================================
app.post('/api/shift-roster/swap', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { roster_id_1, roster_id_2, employee_id_1, employee_id_2, shift_date } = req.body;
        if (!roster_id_1 || !roster_id_2) {
            return res.status(400).json({ error: 'معرفا السجلان مطلوبان' });
        }
        const entry1 = await db.ShiftRoster.getById(roster_id_1);
        const entry2 = await db.ShiftRoster.getById(roster_id_2);
        if (!entry1 || !entry2) {
            return res.status(404).json({ error: 'أحد السجلات غير موجود' });
        }
        await db.beginTransaction();
        try {
            await db.ShiftRoster.update(roster_id_1, {
                employee_id: employee_id_2 || entry2.employee_id,
                team_id: entry1.team_id,
                shift_date: entry1.shift_date,
                shift_code: entry1.shift_code,
                month: entry1.month,
                year: entry1.year
            });
            await db.ShiftRoster.update(roster_id_2, {
                employee_id: employee_id_1 || entry1.employee_id,
                team_id: entry2.team_id,
                shift_date: entry2.shift_date,
                shift_code: entry2.shift_code,
                month: entry2.month,
                year: entry2.year
            });
            await addShiftAuditLog({
                roster_id: roster_id_1, employee_id: entry1.employee_id, team_id: entry1.team_id,
                shift_date: entry1.shift_date, old_shift_code: entry1.shift_code, new_shift_code: entry2.shift_code,
                old_team_id: entry1.team_id, new_team_id: entry2.team_id,
                changed_by: req.user.username || req.user.name, changed_by_name: req.user.name,
                change_type: 'swap', reason: 'تبديل مع سجل ' + roster_id_2
            });
            await addShiftAuditLog({
                roster_id: roster_id_2, employee_id: entry2.employee_id, team_id: entry2.team_id,
                shift_date: entry2.shift_date, old_shift_code: entry2.shift_code, new_shift_code: entry1.shift_code,
                old_team_id: entry2.team_id, new_team_id: entry1.team_id,
                changed_by: req.user.username || req.user.name, changed_by_name: req.user.name,
                change_type: 'swap', reason: 'تبديل مع سجل ' + roster_id_1
            });
            await db.commitTransaction();
        } catch (err) {
            await db.rollbackTransaction();
            throw err;
        }
        broadcast({
            type: 'shift_roster_swapped',
            payload: { roster_id_1, roster_id_2, by_user: req.user.name || req.user.username }
        });
        res.json({ success: true, swapped: [{ roster_id: roster_id_1, old_employee_id: entry1.employee_id, new_employee_id: entry2.employee_id }, { roster_id: roster_id_2, old_employee_id: entry2.employee_id, new_employee_id: entry1.employee_id }] });
    } catch (error) {
        console.error('Swap error:', error);
        res.status(500).json({ error: 'فشل في تبديل المناوبات' });
    }
});

// ============================================
// API: Shift Roster - Validate
// ============================================
app.post('/api/shift-roster/validate', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { changes } = req.body;
        if (!Array.isArray(changes)) {
            return res.status(400).json({ error: 'قائمة التغييرات مطلوبة' });
        }
        const conflicts = [];
        const shiftCodes = await db.ShiftCodes.getAll();
        const validCodes = new Set(shiftCodes.map(sc => sc.code));
        for (const change of changes) {
            const { employee_id, shift_date, shift_code, team_id } = change;
            if (!employee_id || !shift_date || !shift_code) {
                conflicts.push({ type: 'missing_fields', message: 'بيانات ناقصة', employee_id, shift_date });
                continue;
            }
            if (!validCodes.has(shift_code)) {
                conflicts.push({ type: 'invalid_code', message: 'رمز المناوبة غير معروف: ' + shift_code, employee_id, shift_date });
            }
            const existing = await db.ShiftRoster.getByEmployeeAndDate(employee_id, shift_date);
            if (existing) {
                conflicts.push({ type: 'duplicate', message: 'يوجد سجل لهذا الموظف في هذا التاريخ', employee_id, shift_date });
            }
            if (team_id) {
                const team = await db.Teams.getById(team_id);
                if (!team) {
                    conflicts.push({ type: 'invalid_team', message: 'الفريق غير موجود', employee_id, shift_date, team_id });
                }
            }
        }
        res.json({ success: true, valid: conflicts.length === 0, conflicts });
    } catch (error) {
        console.error('Validate error:', error);
        res.status(500).json({ error: 'فشل في التحقق من الصحة' });
    }
});

// ============================================
// API: Shift Roster - Drafts (Undo/Redo)
// ============================================
app.get('/api/shift-roster/drafts', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { limit = 50 } = req.query;
        const entries = await db.ShiftRosterDrafts.getByCreatedBy(req.user.username || req.user.name, parseInt(limit));
        res.json({ success: true, drafts: entries });
    } catch (error) {
        console.error('Drafts GET error:', error);
        res.status(500).json({ error: 'فشل في جلب المسودات' });
    }
});

app.post('/api/shift-roster/draft', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { draft_data_json, operation_type } = req.body;
        if (!draft_data_json) {
            return res.status(400).json({ error: 'بيانات المسودة مطلوبة' });
        }
        const id = await db.ShiftRosterDrafts.create({
            draft_data_json: typeof draft_data_json === 'string' ? draft_data_json : JSON.stringify(draft_data_json),
            operation_type: operation_type || 'edit',
            created_by: req.user.username || req.user.name,
            created_by_name: req.user.name
        });
        res.json({ success: true, id });
    } catch (error) {
        console.error('Draft POST error:', error);
        res.status(500).json({ error: 'فشل في حفظ المسودة' });
    }
});

app.post('/api/shift-roster/undo', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const drafts = await db.ShiftRosterDrafts.getPendingByCreatedBy(req.user.username || req.user.name);
        if (!drafts || drafts.length === 0) {
            return res.status(404).json({ error: 'لا توجد مسودات للتراجع' });
        }
        const lastDraft = drafts[0];
        await db.ShiftRosterDrafts.markReverted(lastDraft.id);
        res.json({ success: true, draft: lastDraft, message: 'تم التراجع عن آخر تغيير' });
    } catch (error) {
        console.error('Undo error:', error);
        res.status(500).json({ error: 'فشل في التراجع' });
    }
});

app.post('/api/shift-roster/redo', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const allDrafts = await db.ShiftRosterDrafts.getByCreatedBy(req.user.username || req.user.name, 100);
        const revertedDraft = allDrafts.find(d => d.reverted_at !== null && d.applied_at !== null);
        if (!revertedDraft) {
            return res.status(404).json({ error: 'لا يوجد تغيير لإعادة تطبيقه' });
        }
        res.json({ success: true, draft: revertedDraft, message: 'تم إعادة تطبيق المسودة' });
    } catch (error) {
        console.error('Redo error:', error);
        res.status(500).json({ error: 'فشل في إعادة التطبيق' });
    }
});

// ============================================
// API: Notifications
// ============================================
app.post('/api/notifications/send', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { recipient_id, recipient_phone, message, type, roster_id, shift_date, old_value, new_value } = req.body;
        if (!recipient_id || !message) {
            return res.status(400).json({ error: 'معرف المستلم والرسالة مطلوبان' });
        }
        const id = await db.NotificationLog.create({
            notification_type: type || 'shift_change',
            recipient_id, recipient_phone: recipient_phone || null,
            message, channel: 'in-app',
            roster_id: roster_id || null, shift_date: shift_date || null,
            old_value: old_value || null, new_value: new_value || null
        });
        await db.NotificationLog.markAsSent(id);
        broadcast({
            type: 'notification_new',
            payload: { notification_id: id, recipient_id, message }
        });
        res.json({ success: true, id, message: 'تم إرسال الإشعار' });
    } catch (error) {
        console.error('Notification send error:', error);
        res.status(500).json({ error: 'فشل في إرسال الإشعار' });
    }
});

app.get('/api/notifications/log', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { recipient_id, status, limit = 50 } = req.query;
        let entries;
        if (recipient_id) {
            entries = await db.NotificationLog.getByRecipient(parseInt(recipient_id), parseInt(limit));
        } else if (status) {
            entries = await db.NotificationLog.getByStatus(status, parseInt(limit));
        } else {
            entries = await db.NotificationLog.getAll(parseInt(limit));
        }
        res.json({ success: true, notifications: entries });
    } catch (error) {
        console.error('Notification log GET error:', error);
        res.status(500).json({ error: 'فشل في جلب سجل الإشعارات' });
    }
});

app.post('/api/notifications/:id/delivered', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        await db.NotificationLog.markAsDelivered(req.params.id);
        res.json({ success: true, message: 'تم تحديد الإشعار كمستلم' });
    } catch (error) {
        console.error('Notification delivered error:', error);
        res.status(500).json({ error: 'فشل في تحديث حالة الإشعار' });
    }
});

// ============================================
// API: Shift Roster - Export
// ============================================
app.post('/api/shift-roster/export', authenticate, async (req, res) => {
    try {
        const { format, month, year, filters } = req.body;
        if (!format || !month || !year) {
            return res.status(400).json({ error: 'التنسيق والشهر والسنة مطلوبة' });
        }
        const roster = await db.ShiftRoster.getByMonthYear(parseInt(month), parseInt(year));
        let data = roster;
        if (filters && filters.team_id) {
            data = data.filter(r => r.team_id === parseInt(filters.team_id));
        }
        if (filters && filters.employee_id) {
            data = data.filter(r => r.employee_id === parseInt(filters.employee_id));
        }
        const filename = `shift-roster-${year}-${month}.${format === 'excel' ? 'xlsx' : 'pdf'}`;
        res.json({ success: true, download_url: `/api/download/${filename}`, data, format });
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// ============================================
// API: Shift Roster - Stats
// ============================================
app.get('/api/shift-roster/stats', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { month, year } = req.query;
        if (!month || !year) {
            return res.status(400).json({ error: 'الشهر والسنة مطلوبة' });
        }
        const roster = await db.ShiftRoster.getByMonthYear(parseInt(month), parseInt(year));
        const shift_code_breakdown = {};
        const team_coverage = {};
        let conflicts_count = 0;
        const seen = {};
        for (const entry of roster) {
            shift_code_breakdown[entry.shift_code] = (shift_code_breakdown[entry.shift_code] || 0) + 1;
            team_coverage[entry.team_name || 'بدون فريق'] = (team_coverage[entry.team_name || 'بدون فريق'] || 0) + 1;
            const key = `${entry.employee_id}-${entry.shift_date}`;
            if (seen[key]) conflicts_count++;
            seen[key] = true;
        }
        const employees_count = new Set(roster.map(r => r.employee_id)).size;
        res.json({
            success: true,
            total_shifts: roster.length,
            employees_count,
            shift_code_breakdown,
            team_coverage,
            conflicts_count
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'فشل في جلب الإحصائيات' });
    }
});

// ============================================
// API: Shift Roster - Employee Schedule
// ============================================
app.get('/api/shift-roster/employee-schedule/:employeeId', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const employeeId = parseInt(req.params.employeeId);
        const { month, year } = req.query;
        if (req.user.role === 'user' && req.user.id !== employeeId) {
            return res.status(403).json({ error: 'لا يمكنك عرض جدول موظف آخر' });
        }
        let schedule;
        if (month && year) {
            const roster = await db.ShiftRoster.getByMonthYear(parseInt(month), parseInt(year));
            schedule = roster.filter(r => r.employee_id === employeeId);
        } else {
            schedule = await db.all('SELECT sr.*, e.name as employee_name, e.employee_code, t.name as team_name FROM shift_roster sr JOIN employees e ON sr.employee_id = e.id LEFT JOIN teams t ON sr.team_id = t.id WHERE sr.employee_id = ? ORDER BY sr.shift_date DESC', [employeeId]);
        }
        const shiftCodes = await db.ShiftCodes.getAll();
        const codeMap = {};
        for (const sc of shiftCodes) { codeMap[sc.code] = sc.name; }
        const result = schedule.map(s => ({
            date: s.shift_date,
            shift_code: s.shift_code,
            shift_name: codeMap[s.shift_code] || s.shift_code,
            team_name: s.team_name || 'بدون فريق',
            team_id: s.team_id
        }));
        res.json({ success: true, schedule: result });
    } catch (error) {
        console.error('EmployeeSchedule error:', error);
        res.status(500).json({ error: 'فشل في جلب جدول الموظف' });
    }
});

// ============================================
// API: Shift Change Requests
// ============================================
app.post('/api/shift-change-request', authenticate, async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { roster_id, employee_id, team_id, shift_date, proposed_shift_code, old_shift_code, reason } = req.body;
        if (!employee_id || !shift_date || !proposed_shift_code) {
            return res.status(400).json({ error: 'معرف الموظف وتاريخ المناوبة والرمز المقترح مطلوبة' });
        }
        const id = await db.ShiftChangeRequests.create({
            roster_id, employee_id, team_id, shift_date, proposed_shift_code, old_shift_code,
            requested_by: req.user.username || req.user.name,
            requested_by_name: req.user.name,
            status: 'pending', reason
        });
        broadcast({
            type: 'shift_change_request',
            payload: { request_id: id, employee_id, status: 'pending' }
        });
        res.json({ success: true, id, message: 'تم إرسال طلب التغيير' });
    } catch (error) {
        console.error('ShiftChangeRequest error:', error);
        res.status(500).json({ error: 'فشل في إرسال طلب التغيير' });
    }
});

app.get('/api/shift-change-request', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { status, limit = 50 } = req.query;
        let entries;
        if (status) {
            entries = await db.ShiftChangeRequests.getByStatus(status, parseInt(limit));
        } else {
            entries = await db.ShiftChangeRequests.getAll(parseInt(limit));
        }
        res.json({ success: true, requests: entries });
    } catch (error) {
        console.error('ShiftChangeRequest GET error:', error);
        res.status(500).json({ error: 'فشل في جلب طلبات التغيير' });
    }
});

app.post('/api/shift-change-request/:id/review', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        if (!dbAvailable()) return res.status(503).json({ error: 'قاعدة البيانات غير متوفرة' });
        const { status } = req.body;
        if (!['approved', 'denied', 'cancelled'].includes(status)) {
            return res.status(400).json({ error: 'حالة غير صالحة' });
        }
        await db.ShiftChangeRequests.updateStatus(req.params.id, status, req.user.username || req.user.name);
        const entry = await db.ShiftChangeRequests.getById(req.params.id);
        broadcast({
            type: 'shift_change_request',
            payload: { request_id: req.params.id, employee_id: entry ? entry.employee_id : null, status }
        });
        res.json({ success: true, message: 'تم مراجعة الطلب' });
    } catch (error) {
        console.error('ShiftChangeRequest review error:', error);
        res.status(500).json({ error: 'فشل في مراجعة الطلب' });
    }
});

// ============================================
// API: DESTROY DATABASE - Delete physical DB file
// ⚠️ WARNING: This deletes database.db and data/ folder completely
// ============================================
app.post('/api/admin/destroy-db', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const fsSync = require('fs');
        const path = require('path');
        
        // 1. Close DB connection
        if (db && db.closeDb) {
            await db.closeDb();
            console.log('[DESTROY] Database connection closed');
        }
        
        // 2. Delete database.db file
        const dbFile = path.join(__dirname, 'database.db');
        const dbWal = path.join(__dirname, 'database.db-shm');
        const dbJournal = path.join(__dirname, 'database.db-wal');
        
        let deletedFiles = [];
        [dbFile, dbWal, dbJournal].forEach(f => {
            if (fsSync.existsSync(f)) {
                fsSync.unlinkSync(f);
                deletedFiles.push(path.basename(f));
            }
        });
        
        // 3. Delete data/ directory recursively
        const dataDir = path.join(__dirname, 'data');
        if (fsSync.existsSync(dataDir)) {
            fsSync.rmSync(dataDir, { recursive: true, force: true });
            deletedFiles.push('data/');
        }
        
        console.log('[DESTROY] Deleted:', deletedFiles);
        
        // 4. Re-initialize fresh database
        if (db && db.init) {
            await db.init(false);
            console.log('[DESTROY] Fresh database initialized');
        }
        
        res.json({ 
            success: true, 
            message: 'تم حذف قاعدة البيانات بالكامل وإعادة إنشائها', 
            deleted: deletedFiles 
        });
    } catch (error) {
        console.error('[DESTROY] Error:', error);
        res.status(500).json({ error: 'فشل في حذف قاعدة البيانات: ' + error.message });
    }
});

// ============================================
// API: Team Assignments
// ============================================
app.get('/api/team-assignments', authenticate, async (req, res) => {
    try {
        const assignments = await db.TeamAssignments.getAll();
        res.json({ success: true, assignments });
    } catch (error) {
        console.error('TeamAssignments GET error:', error);
        res.status(500).json({ error: 'فشل في جلب التعيينات' });
    }
});

app.get('/api/team-assignments/employee/:employeeId', authenticate, async (req, res) => {
    try {
        const assignments = await db.TeamAssignments.getByEmployee(req.params.employeeId);
        res.json({ success: true, assignments });
    } catch (error) {
        console.error('TeamAssignments GET error:', error);
        res.status(500).json({ error: 'فشل في جلب التعيينات' });
    }
});

app.get('/api/team-assignments/team/:teamId', authenticate, async (req, res) => {
    try {
        const assignments = await db.TeamAssignments.getActiveByTeam(req.params.teamId);
        res.json({ success: true, assignments });
    } catch (error) {
        console.error('TeamAssignments GET error:', error);
        res.status(500).json({ error: 'فشل في جلب التعيينات' });
    }
});

app.post('/api/team-assignments', authenticate, authorize(['admin']), validateBody({
    employee_id: { required: true, type: 'number' },
    team_id: { required: true, type: 'number' }
}), async (req, res) => {
    try {
        const id = await db.TeamAssignments.create(req.body);
        res.json({ success: true, id });
    } catch (error) {
        console.error('TeamAssignments POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة التعيين' });
    }
});

app.put('/api/team-assignments/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const result = await db.TeamAssignments.update(req.params.id, req.body);
        if (!result) return res.status(404).json({ error: 'التعيين غير موجود' });
        res.json({ success: true });
    } catch (error) {
        console.error('TeamAssignments PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث التعيين' });
    }
});

app.delete('/api/team-assignments/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.TeamAssignments.delete(req.params.id);
        res.json({ success: true });
    } catch (error) {
        console.error('TeamAssignments DELETE error:', error);
        res.status(500).json({ error: 'فشل في حذف التعيين' });
    }
});

// ============================================
// Smart Scheduling Engine
// ============================================

const DAY_SHIFT_CODES = ['D12', 'D10', 'D11', 'D8', 'D6'];
const NIGHT_SHIFT_CODES = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10'];
const ABSENT_CODES = ['V', 'VC', 'E', 'EV', 'WO', 'C'];

async function buildLeaveMap(year, month) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    const endDate = `${year}-${String(month).padStart(2,'0')}-${String(daysInMonth).padStart(2,'0')}`;
    
    const leaveRequests = await db.LeaveRequests.getActiveForDateRange(startDate, endDate);
    
    const leaveMap = {};
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        leaveMap[dateStr] = new Set();
    }
    
    for (const lr of leaveRequests) {
        const start = new Date(lr.start_date);
        const end = new Date(lr.end_date);
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            const curr = new Date(dateStr);
            if (curr >= start && curr <= end) {
                leaveMap[dateStr].add(lr.employee_id);
            }
        }
    }
    return leaveMap;
}

async function generateNormalSchedule(year, month, leaveMap) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const employees = await db.Employees.getActive();
    const schedule = [];
    const alerts = [];
    
    const dayShiftCode = 'D12';
    const nightShiftCode = 'N12';
    const cycleLength = 8;
    
    // Pre-fetch team assignments for all employees
    const teamAssignments = {};
    for (const emp of employees) {
        const assignments = await db.TeamAssignments.getByEmployee(emp.id);
        const primary = assignments.find(a => a.is_primary) || assignments[0];
        teamAssignments[emp.id] = primary ? primary.team_id : null;
    }
    
    for (let i = 0; i < employees.length; i++) {
        const emp = employees[i];
        const startOffset = (i * 2) % cycleLength;
        const teamId = teamAssignments[emp.id];
        
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
            
            if (leaveMap[dateStr].has(emp.id)) {
                schedule.push({
                    employee_id: emp.id,
                    team_id: teamId,
                    shift_date: dateStr,
                    shift_code: 'V',
                    shift_hours: 0,
                    mode: 'normal',
                    is_override: 0
                });
                continue;
            }
            
            const dayInCycle = (d - 1 + startOffset) % cycleLength;
            let shiftCode, shiftHours;
            
            if (dayInCycle < 2) {
                shiftCode = dayShiftCode;
                shiftHours = 12;
            } else if (dayInCycle < 4) {
                shiftCode = nightShiftCode;
                shiftHours = 12;
            } else {
                shiftCode = 'WO';
                shiftHours = 0;
            }
            
            schedule.push({
                employee_id: emp.id,
                team_id: teamId,
                shift_date: dateStr,
                shift_code: shiftCode,
                shift_hours: shiftHours,
                mode: 'normal',
                is_override: 0
            });
        }
    }
    
    // Validate coverage and generate alerts
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dayAssignments = schedule.filter(s => s.shift_date === dateStr && DAY_SHIFT_CODES.includes(s.shift_code));
        const nightAssignments = schedule.filter(s => s.shift_date === dateStr && NIGHT_SHIFT_CODES.includes(s.shift_code));
        const onLeave = leaveMap[dateStr].size;
        const available = employees.length - onLeave;
        
        if (dayAssignments.length < 2) {
            alerts.push({
                alert_date: dateStr,
                shift_type: 'day',
                severity: dayAssignments.length === 0 ? 'red' : 'yellow',
                message: `النوبة الصباحية: ${dayAssignments.length}/2 مسعفين`,
                recommendation: 'تعيين مسعفين إضافيين أو تفعيل الوضع البديل'
            });
        }
        if (nightAssignments.length < 2) {
            alerts.push({
                alert_date: dateStr,
                shift_type: 'night',
                severity: nightAssignments.length === 0 ? 'red' : 'yellow',
                message: `النوبة الليلية: ${nightAssignments.length}/2 مسعفين`,
                recommendation: 'تعيين مسعفين إضافيين أو تفعيل الوضع البديل'
            });
        }
        if (available < 8) {
            alerts.push({
                alert_date: dateStr,
                shift_type: 'all',
                severity: 'red',
                message: `نقص حاد: ${available} متاح من ${employees.length}`,
                recommendation: 'تفعيل الوضع البديل (8 ساعات) أو نقل موظفين'
            });
        }
    }
    
    return { schedule, alerts };
}

async function generateAlternativeSchedule(year, month, leaveMap) {
    const daysInMonth = new Date(year, month, 0).getDate();
    const employees = await db.Employees.getActive();
    const schedule = [];
    const alerts = [];
    
    const dayShiftCode = 'D8';
    const nightShiftCode = 'N8';
    
    // Pre-fetch team assignments
    const teamAssignments = {};
    for (const emp of employees) {
        const assignments = await db.TeamAssignments.getByEmployee(emp.id);
        const primary = assignments.find(a => a.is_primary) || assignments[0];
        teamAssignments[emp.id] = primary ? primary.team_id : null;
    }
    
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const availableEmployees = employees.filter(e => !leaveMap[dateStr].has(e.id));
        
        // 3 day + 3 night = 6 slots, rest off
        const daySlots = Math.min(3, availableEmployees.length);
        const nightSlots = Math.min(3, Math.max(0, availableEmployees.length - daySlots));
        
        // Rotate start index to distribute shifts fairly
        const startIdx = (d - 1) % Math.max(availableEmployees.length, 1);
        
        for (let i = 0; i < availableEmployees.length; i++) {
            const emp = availableEmployees[i];
            const teamId = teamAssignments[emp.id];
            const rotatedIdx = (i + startIdx) % availableEmployees.length;
            let shiftCode, shiftHours;
            
            if (rotatedIdx < daySlots) {
                shiftCode = dayShiftCode;
                shiftHours = 8;
            } else if (rotatedIdx < daySlots + nightSlots) {
                shiftCode = nightShiftCode;
                shiftHours = 8;
            } else {
                shiftCode = 'WO';
                shiftHours = 0;
            }
            
            schedule.push({
                employee_id: emp.id,
                team_id: teamId,
                shift_date: dateStr,
                shift_code: shiftCode,
                shift_hours: shiftHours,
                mode: 'alternative',
                is_override: 0
            });
        }
        
        if (availableEmployees.length < 6) {
            alerts.push({
                alert_date: dateStr,
                shift_type: 'all',
                severity: 'red',
                message: `نقص حاد في الوضع البديل: ${availableEmployees.length} متاح`,
                recommendation: 'نقل موظفين من فرق أخرى أو طلب تعيينات طارئة'
            });
        }
    }
    
    return { schedule, alerts };
}

async function analyzeTeamStaffing(dateStr, schedule) {
    const teams = await db.Teams.getActive();
    const assignments = await db.TeamAssignments.getAll();
    const dayAssignments = schedule.filter(s => s.shift_date === dateStr && DAY_SHIFT_CODES.includes(s.shift_code));
    const nightAssignments = schedule.filter(s => s.shift_date === dateStr && NIGHT_SHIFT_CODES.includes(s.shift_code));
    
    const teamStatus = [];
    
    for (const team of teams) {
        const teamEmps = assignments.filter(a => a.team_id === team.id).map(a => a.employee_id);
        const dayCount = dayAssignments.filter(s => teamEmps.includes(s.employee_id)).length;
        const nightCount = nightAssignments.filter(s => teamEmps.includes(s.employee_id)).length;
        
        let status = 'green';
        if (dayCount < 2 || nightCount < 2) status = 'yellow';
        if (dayCount < 1 || nightCount < 1) status = 'red';
        
        teamStatus.push({
            team_id: team.id,
            team_name: team.name,
            center: team.center,
            day_count: dayCount,
            night_count: nightCount,
            status: status,
            recommendation: status === 'red' ? 'نقل مسعف من فريق آخر' : status === 'yellow' ? 'مراقبة التغطية' : 'تغطية كافية'
        });
    }
    
    return teamStatus;
}

async function generateRecommendations(year, month) {
    const leaveMap = await buildLeaveMap(year, month);
    const daysInMonth = new Date(year, month, 0).getDate();
    const employees = await db.Employees.getActive();
    const recommendations = [];
    
    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const available = employees.length - leaveMap[dateStr].size;
        const onLeave = leaveMap[dateStr].size;
        
        if (available < 8) {
            recommendations.push({
                date: dateStr,
                type: 'alternative_mode',
                severity: 'red',
                message: `نقص حاد: ${available} متاح، ${onLeave} في إجازة`,
                action: 'تفعيل الوضع البديل (8 ساعات) مع 3 مسعفين لكل نوبة'
            });
        } else if (onLeave >= 2) {
            recommendations.push({
                date: dateStr,
                type: 'monitor',
                severity: 'yellow',
                message: `إجازات متعددة: ${onLeave} موظفين`,
                action: 'مراقبة التغطية وإعداد خطة بديلة'
            });
        }
    }
    
    return recommendations;
}

// ============================================
// API: Smart Shift Schedule
// ============================================

app.post('/api/shift-schedule/generate', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { year, month, mode = 'normal' } = req.body;
        if (!year || !month) {
            return res.status(400).json({ error: 'السنة والشهر مطلوبة' });
        }
        
        const y = parseInt(year);
        const m = parseInt(month);
        const leaveMap = await buildLeaveMap(y, m);
        
        let result;
        if (mode === 'alternative') {
            result = await generateAlternativeSchedule(y, m, leaveMap);
        } else {
            result = await generateNormalSchedule(y, m, leaveMap);
        }
        
        // Save to database
        await db.beginTransaction();
        try {
            await db.ShiftScheduleAuto.deleteByMonthYear(m, y);
            for (const entry of result.schedule) {
                await db.ShiftScheduleAuto.create(entry);
            }
            const daysInMonth = new Date(y, m, 0).getDate();
            for (let d = 1; d <= daysInMonth; d++) {
                const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                await db.run('DELETE FROM staffing_alerts WHERE alert_date = ? AND resolved = 0', [dateStr]);
            }
            for (const alert of result.alerts) {
                await db.StaffingAlerts.create(alert);
            }
            await db.commitTransaction();
        } catch (err) {
            await db.rollbackTransaction();
            throw err;
        }
        
        broadcast({
            type: 'schedule_generated',
            message: `تم إنشاء جدول ${mode === 'alternative' ? 'الوضع البديل' : 'الوضع العادي'} لشهر ${m}/${y}`,
            year: y,
            month: m,
            mode
        });
        
        res.json({ success: true, schedule: result.schedule, alerts: result.alerts, mode });
    } catch (error) {
        console.error('Schedule generation error:', error);
        res.status(500).json({ error: 'فشل في إنشاء الجدول' });
    }
});

app.get('/api/shift-schedule/month', authenticate, async (req, res) => {
    try {
        const { month, year } = req.query;
        if (!month || !year) {
            return res.status(400).json({ error: 'الشهر والسنة مطلوبة' });
        }
        
        const schedule = await db.ShiftScheduleAuto.getByMonthYear(parseInt(month), parseInt(year));
        const alerts = await db.StaffingAlerts.getActive();
        
        const byDate = {};
        for (const entry of schedule) {
            if (!byDate[entry.shift_date]) {
                byDate[entry.shift_date] = { day: [], night: [], off: [], leave: [] };
            }
            if (DAY_SHIFT_CODES.includes(entry.shift_code)) {
                byDate[entry.shift_date].day.push(entry);
            } else if (NIGHT_SHIFT_CODES.includes(entry.shift_code)) {
                byDate[entry.shift_date].night.push(entry);
            } else if (ABSENT_CODES.includes(entry.shift_code)) {
                byDate[entry.shift_date].leave.push(entry);
            } else {
                byDate[entry.shift_date].off.push(entry);
            }
        }
        
        res.json({ success: true, schedule, byDate, alerts });
    } catch (error) {
        console.error('Schedule month GET error:', error);
        res.status(500).json({ error: 'فشل في جلب الجدول' });
    }
});

app.post('/api/shift-schedule/update', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { id, employee_id, team_id, shift_date, shift_code, shift_hours, mode, is_override } = req.body;
        if (!id) {
            return res.status(400).json({ error: 'معرف السجل مطلوب' });
        }
        
        const existing = await db.ShiftScheduleAuto.getById(id);
        if (!existing) {
            return res.status(404).json({ error: 'السجل غير موجود' });
        }
        
        await db.ShiftScheduleAuto.update(id, {
            employee_id: employee_id !== undefined ? employee_id : existing.employee_id,
            team_id: team_id !== undefined ? team_id : existing.team_id,
            shift_date: shift_date || existing.shift_date,
            shift_code: shift_code || existing.shift_code,
            shift_hours: shift_hours !== undefined ? shift_hours : existing.shift_hours,
            mode: mode || existing.mode,
            is_override: is_override !== undefined ? is_override : existing.is_override
        });
        
        broadcast({
            type: 'schedule_updated',
            message: 'تم تحديث جدول المناوبات',
            entry: { id, shift_date, shift_code }
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Schedule update error:', error);
        res.status(500).json({ error: 'فشل في تحديث الجدول' });
    }
});

app.get('/api/staffing-levels', authenticate, async (req, res) => {
    try {
        const { date } = req.query;
        const targetDate = date || new Date().toISOString().split('T')[0];
        
        const schedule = await db.ShiftScheduleAuto.getByDate(targetDate);
        const employees = await db.Employees.getActive();
        const leaveRequests = await db.LeaveRequests.getActiveForDate(targetDate);
        const onLeave = leaveRequests.length;
        const available = employees.length - onLeave;
        
        const dayShift = schedule.filter(s => DAY_SHIFT_CODES.includes(s.shift_code));
        const nightShift = schedule.filter(s => NIGHT_SHIFT_CODES.includes(s.shift_code));
        
        let daySeverity = 'green';
        if (dayShift.length < 2) daySeverity = 'red';
        else if (dayShift.length < 3) daySeverity = 'yellow';
        
        let nightSeverity = 'green';
        if (nightShift.length < 2) nightSeverity = 'red';
        else if (nightShift.length < 3) nightSeverity = 'yellow';
        
        let overallSeverity = 'green';
        if (available < 8) overallSeverity = 'red';
        else if (available < 10) overallSeverity = 'yellow';
        
        const teamStatus = await analyzeTeamStaffing(targetDate, schedule);
        
        res.json({
            success: true,
            date: targetDate,
            available,
            onLeave,
            total: employees.length,
            day: { count: dayShift.length, severity: daySeverity },
            night: { count: nightShift.length, severity: nightSeverity },
            overall: overallSeverity,
            teams: teamStatus
        });
    } catch (error) {
        console.error('Staffing levels error:', error);
        res.status(500).json({ error: 'فشل في جلب مستويات التغطية' });
    }
});

// ============================================
// API: Leave Requests
// ============================================

app.get('/api/leave-requests', authenticate, async (req, res) => {
    try {
        const { status, employee_id } = req.query;
        let requests;
        if (status) {
            requests = await db.LeaveRequests.getByStatus(status);
        } else if (employee_id) {
            requests = await db.LeaveRequests.getByEmployee(employee_id);
        } else {
            requests = await db.LeaveRequests.getAll();
        }
        res.json({ success: true, requests });
    } catch (error) {
        console.error('Leave requests GET error:', error);
        res.status(500).json({ error: 'فشل في جلب طلبات الإجازة' });
    }
});

app.post('/api/leave-requests', authenticate, validateBody({
    employee_id: { required: true, type: 'number' },
    start_date: { required: true, type: 'string', minLength: 1 },
    end_date: { required: true, type: 'string', minLength: 1 },
    type: { required: true, type: 'string', minLength: 1 }
}), async (req, res) => {
    try {
        const { employee_id, start_date, end_date, type, reason } = req.body;
        
        const start = new Date(start_date);
        const end = new Date(end_date);
        const daysInRange = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            daysInRange.push(d.toISOString().split('T')[0]);
        }
        
        for (const dateStr of daysInRange) {
            const activeLeave = await db.LeaveRequests.getActiveForDate(dateStr);
            const otherLeave = activeLeave.filter(lr => lr.employee_id !== employee_id && lr.status !== 'cancelled');
            if (otherLeave.length >= 2) {
                return res.status(400).json({ 
                    error: 'لا يمكن قبول الإجازة', 
                    message: `يوجد ${otherLeave.length} موظفين في إجازة بتاريخ ${dateStr}. الحد الأقصى 2.`,
                    date: dateStr
                });
            }
        }
        
        const id = await db.LeaveRequests.create({
            employee_id,
            start_date,
            end_date,
            type,
            reason,
            status: 'pending'
        });
        
        broadcast({
            type: 'leave_request_submitted',
            message: 'تم تقديم طلب إجازة جديد',
            requestId: id
        });
        
        res.json({ success: true, id });
    } catch (error) {
        console.error('Leave request POST error:', error);
        res.status(500).json({ error: 'فشل في تقديم طلب الإجازة' });
    }
});

app.put('/api/leave-requests/:id', authenticate, async (req, res) => {
    try {
        const existing = await db.LeaveRequests.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'الطلب غير موجود' });
        }
        
        if (existing.status !== 'pending' && req.user.role !== 'admin' && req.user.role !== 'director') {
            return res.status(403).json({ error: 'لا يمكن تعديل طلب تمت معالجته' });
        }
        
        const data = { ...req.body, approved_by: null, approved_at: null };
        await db.LeaveRequests.update(req.params.id, data);
        
        broadcast({
            type: 'leave_request_updated',
            message: 'تم تحديث طلب الإجازة',
            requestId: req.params.id
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Leave request PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث طلب الإجازة' });
    }
});

app.delete('/api/leave-requests/:id', authenticate, async (req, res) => {
    try {
        const existing = await db.LeaveRequests.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'الطلب غير موجود' });
        }
        
        if (existing.status === 'approved' && req.user.role !== 'admin' && req.user.role !== 'director') {
            return res.status(403).json({ error: 'لا يمكن إلغاء إجازة معتمدة' });
        }
        
        await db.LeaveRequests.delete(req.params.id);
        
        broadcast({
            type: 'leave_request_cancelled',
            message: 'تم إلغاء طلب الإجازة',
            requestId: req.params.id
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Leave request DELETE error:', error);
        res.status(500).json({ error: 'فشل في إلغاء طلب الإجازة' });
    }
});

app.post('/api/leave-requests/:id/approve', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { status } = req.body;
        if (!status || !['approved', 'denied'].includes(status)) {
            return res.status(400).json({ error: 'الحالة يجب أن تكون approved أو denied' });
        }
        
        const existing = await db.LeaveRequests.getById(req.params.id);
        if (!existing) {
            return res.status(404).json({ error: 'الطلب غير موجود' });
        }
        
        if (existing.status !== 'pending') {
            return res.status(400).json({ error: 'الطلب تمت معالجته مسبقاً' });
        }
        
        await db.LeaveRequests.updateStatus(req.params.id, status, req.user.id);
        
        broadcast({
            type: 'leave_request_resolved',
            message: `تم ${status === 'approved' ? 'قبول' : 'رفض'} طلب الإجازة`,
            requestId: req.params.id,
            status
        });
        
        res.json({ success: true });
    } catch (error) {
        console.error('Leave request approve error:', error);
        res.status(500).json({ error: 'فشل في معالجة طلب الإجازة' });
    }
});

// ============================================
// API: Staffing Alerts
// ============================================

app.get('/api/staffing-alerts', authenticate, async (req, res) => {
    try {
        const alerts = await db.StaffingAlerts.getActive();
        res.json({ success: true, alerts });
    } catch (error) {
        console.error('Staffing alerts GET error:', error);
        res.status(500).json({ error: 'فشل في جلب التنبيهات' });
    }
});

app.get('/api/staffing-recommendations', authenticate, async (req, res) => {
    try {
        const { month, year } = req.query;
        const now = new Date();
        const m = month ? parseInt(month) : now.getMonth() + 1;
        const y = year ? parseInt(year) : now.getFullYear();
        
        const recommendations = await generateRecommendations(y, m);
        res.json({ success: true, recommendations });
    } catch (error) {
        console.error('Recommendations error:', error);
        res.status(500).json({ error: 'فشل في جلب التوصيات' });
    }
});

// ============================================
// RAG AI Assistant - Knowledge Base Routes
// ============================================

async function initRAG() {
    try {
        if (!dbAvailable() || !db.KBChunks) return;
        const chunks = await db.KBChunks.getAllWithEmbeddings();
        if (chunks.length > 0) {
            await ragInstance.loadDocuments(chunks);
            ragInitialized = true;
            console.log(`✅ RAG Engine initialized with ${chunks.length} chunks`);
        } else {
            console.log('ℹ️ RAG Engine: no chunks found yet');
        }
        
        // Seed default AI knowledge if ai_knowledge_chunks is empty
        try {
            if (db.AIKnowledgeChunks) {
                const count = await db.AIKnowledgeChunks.count();
                if (count === 0) {
                    console.log('[AI] Seeding default operational knowledge...');
                    const defaults = [
                        { title: 'تسجيل البلاغات', content: 'لتسجيل بلاغ جديد: 1) اذهب إلى صفحة تسجيل البلاغات. 2) اضغط على زر + أمام الفرقة المطلوبة. 3) يتم التسجيل تلقائياً مع الوقت والتاريخ. 4) يمكن التراجع عن آخر بلاغ بالضغط على زر تراجع. 5) الإجمالي يُحدّث تلقائياً لجميع المستخدمين.', source: 'دليل المستخدم', category: 'البلاغات' },
                        { title: 'تكميل النوبة', content: 'خطوات تكميل النوبة: 1) اضغط على "تكميل النوبة" من الصفحة الرئيسية. 2) أدخل بيانات المسعفين المتواجدين في كل فرقة. 3) حدد حالة كل سيارة (جاهزة/صيانة/غير جاهزة). 4) أدخل بيانات الوقود. 5) أضف أي ملاحظات عامة. 6) اضغط حفظ.', source: 'دليل المستخدم', category: 'المناوبات' },
                        { title: 'الإسعاف الجوي', content: 'بلاغ الإسعاف الجوي: يُستخدم للحالات التي تتطلب نقلاً جوياً للمستشفى. يجب تحديد المستشفى الوجهة بدقة وإدخال ملاحظات الحالة. يتم تسجيل البلاغ وتتبعه من قبل الإشراف.', source: 'البروتوكولات التشغيلية', category: 'الإسعاف الجوي' },
                        { title: 'حالات توقف القلب والتنفس', content: 'نموذج E-Case: يُستخدم لتسجيل حالات توقف القلب والتنفس (Cardiac Arrest). يجب تسجيل: زمن الاستجابة، الإجراءات المتخذة (CPR، صدمات)، الأدوية المستخدمة، النتيجة النهائية (استعادة نبض/وفاة). الملاحظات تساعد في مراجعات الجودة.', source: 'البروتوكولات الطبية', category: 'النماذج الإسعافية' },
                        { title: 'بلاغ التصعيد', content: 'بلاغ التصعيد: للحالات التي تتطلب تدخلاً إضافياً من جهات أخرى (الدفاع المدني، المرور، الشرطة). يجب تحديد الجهات المشاركة وتفاصيل الحالة. الوصف التفصيلي يساعد في التحقيقات المستقبلية.', source: 'البروتوكولات التشغيلية', category: 'البلاغات' },
                        { title: 'الجداول التشغيلية', content: 'نظام الجداول: يمكن استيراد الجداول من Excel مباشرة. يدعم النظام تصدير الجداول كـ PDF أو Excel. يمكن إنشاء QR Code للمشاركة السريعة. يدعم OCR لتحويل صور الجداول إلى بيانات.', source: 'دليل المستخدم', category: 'الجداول' },
                        { title: 'غرفة العمليات', content: 'غرفة العمليات (Operations Command): مركز إدارة الملفات والبروتوكولات. يمكن رفع الملفات بالسحب والإفلات. تصنيف الملفات: عاجل/عام/تقرير/بروتوكول. البروتوكولات التشغيلية تُراجع بشكل دوري.', source: 'دليل المستخدم', category: 'العمليات' },
                        { title: 'التحقق من صحة البيانات', content: 'التوقيع الرقمي: يُستخدم لتأكيد صحة بيانات المناوبة من قبل كبار المسعفين. يجب مراجعة بيانات التكميل قبل التوقيع. التوقيع الرقمي يُربط بالمناوبة الحالية.', source: 'دليل المستخدم', category: 'الجودة' },
                        { title: 'الفرق والمراكز', content: 'الفرق الإسعافية: يتكون القطاع من فرق إسعافية (جنوب 1 إلى جنوب 19) وفرق سريعة (سريع 1 إلى سريع 4). كل فرقة تابعة لمركز إسعافي محدد. يمكن مراجعة بيانات الفرق في قسم الإدارة.', source: 'دليل المستخدم', category: 'الفرق' },
                        { title: 'الإشعارات والتنبيهات', content: 'الإشعارات: تظهر فوراً عند حدوث أحداث مهمة. يمكن تخصيص الصوت من الإعدادات. شريط التنبيهات يظهر التنبيهات العاجلة فور وصولها. مؤشرات القوى العاملة تساعد في تحديد المراكز الناقصة.', source: 'دليل المستخدم', category: 'الإشعارات' }
                    ];
                    for (const item of defaults) {
                        const ch = chunkDocument(item.content, 500, 50);
                        for (let i = 0; i < ch.length; i++) {
                            const tokens = preprocessText(ch[i]);
                            const tf = computeTF(tokens);
                            await db.AIKnowledgeChunks.create({
                                title: item.title,
                                content: ch[i],
                                source: item.source,
                                category: item.category,
                                chunk_index: i,
                                total_chunks: ch.length,
                                tokens_json: JSON.stringify(tokens),
                                tf_json: JSON.stringify(tf)
                            });
                        }
                    }
                    console.log(`[AI] Seeded ${defaults.length} default knowledge items`);
                }
            }
        } catch (seedErr) {
            console.error('[AI] Failed to seed default knowledge:', seedErr.message);
        }
    } catch (err) {
        console.error('RAG init error:', err.message);
    }
}

// Upload knowledge document (admin only)
app.post('/api/kb/upload', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { title, content, category, fileType, fileName, fileSize } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'العنوان والمحتوى مطلوبان' });
        }
        
        const docId = await db.KBDocuments.create({
            title,
            content,
            category: category || 'عام',
            file_type: fileType || 'text',
            original_name: fileName || null,
            file_size: fileSize || 0,
            status: 'processing',
            created_by: req.user.username
        });
        
        res.json({ success: true, id: docId, message: 'تم رفع الوثيقة بنجاح' });
    } catch (error) {
        console.error('KB upload error:', error);
        res.status(500).json({ error: 'فشل في رفع الوثيقة' });
    }
});

// List knowledge documents
app.get('/api/kb/documents', authenticate, async (req, res) => {
    try {
        const docs = await db.KBDocuments.getAll();
        res.json({ success: true, documents: docs });
    } catch (error) {
        console.error('KB documents error:', error);
        res.status(500).json({ error: 'فشل في جلب الوثائق' });
    }
});

// Delete knowledge document (admin only)
app.delete('/api/kb/documents/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const id = parseInt(req.params.id);
        await db.KBChunks.deleteByDocumentId(id);
        await db.KBDocuments.delete(id);
        
        // Re-initialize RAG
        await initRAG();
        
        res.json({ success: true, message: 'تم حذف الوثيقة بنجاح' });
    } catch (error) {
        console.error('KB delete error:', error);
        res.status(500).json({ error: 'فشل في حذف الوثيقة' });
    }
});

// Process document into chunks (admin only)
app.post('/api/kb/process/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        if (!ragEngine) {
            return res.status(503).json({ error: 'محرك RAG غير متوفر' });
        }
        
        const id = parseInt(req.params.id);
        const doc = await db.KBDocuments.getById(id);
        if (!doc) {
            return res.status(404).json({ error: 'الوثيقة غير موجودة' });
        }
        
        // Delete old chunks
        await db.KBChunks.deleteByDocumentId(id);
        
        // Chunk document
        const chunks = ragEngine.chunkDocument(doc.content, 500, 50);
        
        // Process each chunk
        const allTokens = [];
        const chunkEmbeddings = [];
        
        for (let i = 0; i < chunks.length; i++) {
            const tokens = ragEngine.preprocessText(chunks[i]);
            allTokens.push(tokens);
        }
        
        const idf = ragEngine.computeIDF(allTokens);
        
        for (let i = 0; i < chunks.length; i++) {
            const tf = ragEngine.computeTF(allTokens[i]);
            const tfidf = ragEngine.normalizeVector(ragEngine.computeTFIDF(tf, idf));
            chunkEmbeddings.push(tfidf);
        }
        
        // Save chunks
        for (let i = 0; i < chunks.length; i++) {
            await db.KBChunks.create({
                document_id: id,
                chunk_index: i,
                content: chunks[i],
                embedding: chunkEmbeddings[i],
                token_count: allTokens[i].length
            });
        }
        
        await db.KBDocuments.updateChunkCount(id, chunks.length);
        
        // Re-initialize RAG
        await initRAG();
        
        res.json({ success: true, chunkCount: chunks.length, message: 'تم معالجة الوثيقة بنجاح' });
    } catch (error) {
        console.error('KB process error:', error);
        res.status(500).json({ error: 'فشل في معالجة الوثيقة' });
    }
});

// AI Chat endpoint
app.post('/api/ai/chat', authenticate, async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'الرسالة مطلوبة' });
        }
        
        const session_id = sessionId || req.user.username + '-' + Date.now();
        
        // Save user message
        await db.KBChatHistory.create({
            user_id: req.user.username,
            session_id,
            role: 'user',
            message
        });
        
        // Initialize RAG if not already done
        if (!ragInitialized) {
            await initRAG();
        }
        
        // Query RAG
        let retrieved = [];
        if (ragInstance && ragInitialized && ragInstance.isInitialized) {
            retrieved = await ragInstance.query(message, 5);
        }
        
        // Generate answer
        let result;
        if (ragInstance) {
            result = await ragInstance.generateAnswer(message, retrieved, {
                user: req.user.username,
                role: req.user.role
            });
        } else {
            result = {
                answer: 'المساعد الذكي غير متوفر حالياً. يرجى التحقق من إعدادات النظام أو الاتصال بالمسؤول.',
                followUp: '',
                sources: [],
                confidence: 0,
                queryType: 'unavailable'
            };
        }
        
        // Save assistant response
        await db.KBChatHistory.create({
            user_id: req.user.username,
            session_id,
            role: 'assistant',
            message: result.answer,
            sources: result.sources
        });
        
        res.json({
            success: true,
            answer: result.answer,
            followUp: result.followUp,
            sources: result.sources,
            confidence: result.confidence,
            queryType: result.queryType,
            sessionId: session_id
        });
    } catch (error) {
        console.error('AI chat error:', error);
        res.status(500).json({ error: 'فشل في معالجة السؤال' });
    }
});

// AI Chat history
app.get('/api/ai/history', authenticate, async (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!sessionId) {
            return res.status(400).json({ error: 'معرف الجلسة مطلوب' });
        }
        const history = await db.KBChatHistory.getBySession(sessionId, 50);
        res.json({ success: true, history: history.reverse() });
    } catch (error) {
        console.error('AI history error:', error);
        res.status(500).json({ error: 'فشل في جلب السجل' });
    }
});

// AI Stats
app.get('/api/ai/stats', authenticate, async (req, res) => {
    try {
        const docs = await db.KBDocuments.getAll();
        const chunks = await db.KBChunks.getAll();
        const totalDocs = docs.length;
        const totalChunks = chunks.length;
        const activeDocs = docs.filter(d => d.status === 'active').length;
        
        res.json({
            success: true,
            stats: {
                totalDocuments: totalDocs,
                activeDocuments: activeDocs,
                totalChunks: totalChunks,
                ragInitialized: ragInitialized
            }
        });
    } catch (error) {
        console.error('AI stats error:', error);
        res.status(500).json({ error: 'فشل في جلب الإحصائيات' });
    }
});

// ============================================
// AI Assistant V2 — Unanswered Questions, Feedback, Knowledge Management
// ============================================

// AI Chat V2 (uses ai_chat_logs with confidence tracking)
app.post('/api/ai/v2/chat', authenticate, async (req, res) => {
    try {
        const { message, pageContext } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'الرسالة مطلوبة' });
        }
        
        const userId = req.user.id || req.user.username;
        const userName = req.user.name || req.user.username;
        
        // Initialize RAG if not already done
        if (!ragInitialized) {
            await initRAG();
        }
        
        // Query RAG
        let retrieved = [];
        if (ragInitialized && ragInstance.isInitialized) {
            retrieved = await ragInstance.query(message, 5);
        }
        
        // Generate answer
        const result = await ragInstance.generateAnswer(message, retrieved, {
            user: userName,
            role: req.user.role
        });
        
        // Determine confidence level
        let confidence = 'low';
        if (result.confidence >= 65) confidence = 'high';
        else if (result.confidence >= 35) confidence = 'medium';
        
        // Log to ai_chat_logs
        try {
            if (db && db.AIChatLogs) {
                await db.AIChatLogs.create({
                    query: message,
                    answer: result.answer,
                    confidence: confidence,
                    user_id: String(userId),
                    user_name: userName,
                    page_context: pageContext || '',
                    sources_json: JSON.stringify(result.sources || [])
                });
            }
        } catch (logErr) {
            console.error('[AI] Failed to log chat:', logErr.message);
        }
        
        // Log unanswered if low confidence
        if (confidence === 'low' && db && db.AIUnansweredQuestions) {
            try {
                await db.AIUnansweredQuestions.create({
                    question: message,
                    user_id: String(userId),
                    user_name: userName,
                    score: result.confidence / 100,
                    page_context: pageContext || ''
                });
            } catch (uerr) {
                console.error('[AI] Failed to log unanswered:', uerr.message);
            }
        }
        
        res.json({
            success: true,
            answer: result.answer,
            followUp: result.followUp,
            sources: result.sources,
            confidence: confidence,
            bestScore: result.confidence / 100,
            requiresReview: confidence === 'low',
            queryType: result.queryType
        });
    } catch (error) {
        console.error('AI V2 chat error:', error);
        res.status(500).json({ error: 'فشل في معالجة السؤال' });
    }
});

// AI Feedback
app.post('/api/ai/v2/feedback', authenticate, async (req, res) => {
    try {
        const { chatLogId, feedback, notes } = req.body;
        if (!chatLogId || !feedback) {
            return res.status(400).json({ error: 'معرف المحادثة والتقييم مطلوبان' });
        }
        
        if (db && db.AIFeedback) {
            await db.AIFeedback.create({
                chat_log_id: chatLogId,
                feedback: feedback,
                user_id: String(req.user.id || req.user.username),
                notes: notes || ''
            });
        }
        
        res.json({ success: true, message: 'تم حفظ التقييم' });
    } catch (error) {
        console.error('AI feedback error:', error);
        res.status(500).json({ error: 'فشل في حفظ التقييم' });
    }
});

// Unanswered Questions — List
app.get('/api/ai/v2/unanswered', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { status, limit } = req.query;
        const lim = parseInt(limit) || 100;
        
        let questions = [];
        if (db && db.AIUnansweredQuestions) {
            if (status) {
                questions = await db.AIUnansweredQuestions.getByStatus(status, lim);
            } else {
                questions = await db.AIUnansweredQuestions.getAll(lim);
            }
        }
        
        res.json({ success: true, questions });
    } catch (error) {
        console.error('Unanswered questions error:', error);
        res.status(500).json({ error: 'فشل في جلب الأسئلة' });
    }
});

// Unanswered Questions — Resolve
app.post('/api/ai/v2/unanswered/:id/resolve', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { id } = req.params;
        const { resolution } = req.body;
        const resolvedBy = req.user.name || req.user.username;
        
        if (db && db.AIUnansweredQuestions) {
            await db.AIUnansweredQuestions.resolve(id, resolution, resolvedBy);
        }
        
        res.json({ success: true, message: 'تم حل السؤال' });
    } catch (error) {
        console.error('Resolve unanswered error:', error);
        res.status(500).json({ error: 'فشل في حل السؤال' });
    }
});

// Unanswered Questions — Dismiss
app.post('/api/ai/v2/unanswered/:id/dismiss', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { id } = req.params;
        
        if (db && db.AIUnansweredQuestions) {
            await db.AIUnansweredQuestions.dismiss(id);
        }
        
        res.json({ success: true, message: 'تم تجاهل السؤال' });
    } catch (error) {
        console.error('Dismiss unanswered error:', error);
        res.status(500).json({ error: 'فشل في تجاهل السؤال' });
    }
});

// AI Knowledge — Upload text knowledge
app.post('/api/ai/v2/knowledge', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { title, content, source, category } = req.body;
        if (!title || !content) {
            return res.status(400).json({ error: 'العنوان والمحتوى مطلوبان' });
        }
        
        // Store in ai_knowledge_chunks
        if (db && db.AIKnowledgeChunks) {
            const chunks = chunkDocument(content, 500, 50);
            for (let i = 0; i < chunks.length; i++) {
                const tokens = preprocessText(chunks[i]);
                const tf = computeTF(tokens);
                await db.AIKnowledgeChunks.create({
                    title: title,
                    content: chunks[i],
                    source: source || '',
                    category: category || 'عام',
                    chunk_index: i,
                    total_chunks: chunks.length,
                    tokens_json: JSON.stringify(tokens),
                    tf_json: JSON.stringify(tf)
                });
            }
        }
        
        res.json({ success: true, message: 'تم إضافة المعرفة بنجاح' });
    } catch (error) {
        console.error('AI knowledge upload error:', error);
        res.status(500).json({ error: 'فشل في رفع المعرفة' });
    }
});

// AI Knowledge — List
app.get('/api/ai/v2/knowledge', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { category, search, limit, offset } = req.query;
        const lim = parseInt(limit) || 100;
        const off = parseInt(offset) || 0;
        
        let chunks = [];
        let total = 0;
        
        if (db && db.AIKnowledgeChunks) {
            if (search) {
                chunks = await db.AIKnowledgeChunks.searchByTitleOrContent(search);
                total = chunks.length;
            } else if (category) {
                chunks = await db.AIKnowledgeChunks.getByCategory(category);
                total = chunks.length;
            } else {
                chunks = await db.AIKnowledgeChunks.getAll(lim, off);
                total = await db.AIKnowledgeChunks.count();
            }
        }
        
        res.json({ success: true, chunks, total });
    } catch (error) {
        console.error('AI knowledge list error:', error);
        res.status(500).json({ error: 'فشل في جلب المعرفة' });
    }
});

// AI Knowledge — Delete
app.delete('/api/ai/v2/knowledge/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const { id } = req.params;
        
        if (db && db.AIKnowledgeChunks) {
            await db.AIKnowledgeChunks.delete(id);
        }
        
        res.json({ success: true, message: 'تم حذف المعرفة' });
    } catch (error) {
        console.error('AI knowledge delete error:', error);
        res.status(500).json({ error: 'فشل في حذف المعرفة' });
    }
});

// AI V2 Stats
app.get('/api/ai/v2/stats', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        let stats = {
            totalChats: 0,
            highConfidence: 0,
            mediumConfidence: 0,
            lowConfidence: 0,
            pendingQuestions: 0,
            knowledgeChunks: 0,
            positiveFeedback: 0,
            negativeFeedback: 0
        };
        
        if (db && db.AIChatLogs) {
            const chatStats = await db.AIChatLogs.getStats(days);
            stats.totalChats = chatStats.total;
            
            const since = new Date();
            since.setDate(since.getDate() - days);
            
            const high = await db.get('SELECT COUNT(*) as count FROM ai_chat_logs WHERE confidence = ? AND created_at >= ?', ['high', since.toISOString()]);
            const medium = await db.get('SELECT COUNT(*) as count FROM ai_chat_logs WHERE confidence = ? AND created_at >= ?', ['medium', since.toISOString()]);
            const low = await db.get('SELECT COUNT(*) as count FROM ai_chat_logs WHERE confidence = ? AND created_at >= ?', ['low', since.toISOString()]);
            
            stats.highConfidence = high ? high.count : 0;
            stats.mediumConfidence = medium ? medium.count : 0;
            stats.lowConfidence = low ? low.count : 0;
        }
        
        if (db && db.AIUnansweredQuestions) {
            stats.pendingQuestions = await db.AIUnansweredQuestions.countByStatus('pending');
        }
        
        if (db && db.AIKnowledgeChunks) {
            stats.knowledgeChunks = await db.AIKnowledgeChunks.count();
        }
        
        if (db && db.AIFeedback) {
            const fb = await db.AIFeedback.getStats(days);
            stats.positiveFeedback = fb.positive;
            stats.negativeFeedback = fb.negative;
        }
        
        res.json({ success: true, stats });
    } catch (error) {
        console.error('AI V2 stats error:', error);
        res.status(500).json({ error: 'فشل في جلب الإحصائيات' });
    }
});

// ============================================
// RAG-based Operational AI Assistant — KB API v2
// ============================================
app.use('/api/rag', authenticate, kbApi.router);

// ============================================
// AI Agent Chat API
// ============================================
const { getAgent } = require('./rag/agent-layer');
app.post('/api/agent/chat', authenticate, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: 'الرسالة مطلوبة' });
        
        const agent = getAgent(req.user.id);
        const response = await agent.chat(message, req.user);
        res.json({ success: true, response });
    } catch (error) {
        console.error('Agent chat error:', error);
        res.status(500).json({ error: 'فشل في معالجة الرسالة' });
    }
});


// ============================================
// API: CHAT MODULE
// ============================================

// Note: broadcastToConversation and broadcastToAll are defined above in the WebSocket section
// and are reused here for chat message delivery.
// 1. GET /api/chat/conversations
app.get('/api/chat/conversations', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const userId = req.user.id;
        const conversations = await db.all(
            `SELECT c.* FROM chat_conversations c
             JOIN chat_participants p ON c.id = p.conversation_id
             WHERE p.user_id = ? AND c.is_archived = 0
             ORDER BY c.updated_at DESC`,
            [userId]
        );
        const result = [];
        for (const conv of conversations) {
            // unread count
            const unreadRow = await db.get(
                `SELECT COUNT(*) as count FROM chat_messages m
                 LEFT JOIN chat_message_reads r ON m.id = r.message_id AND r.user_id = ?
                 WHERE m.conversation_id = ? AND m.sender_id != ? AND r.id IS NULL AND m.is_deleted = 0`,
                [userId, conv.id, userId]
            );
            // last message
            const lastMsg = await db.get(
                `SELECT m.*, u.name as sender_name FROM chat_messages m
                 LEFT JOIN users u ON m.sender_id = u.user_id
                 WHERE m.conversation_id = ? AND m.is_deleted = 0
                 ORDER BY m.created_at DESC LIMIT 1`,
                [conv.id]
            );
            // participants
            const participants = await db.all(
                `SELECT p.*, u.username, u.name, u.role FROM chat_participants p
                 LEFT JOIN users u ON p.user_id = u.user_id
                 WHERE p.conversation_id = ?`,
                [conv.id]
            );
            // Build title for private chats
            let title = conv.title;
            if (!title && conv.type === 'private') {
                const other = participants.find(function(p) { return p.user_id !== userId; });
                title = other ? (other.name || other.username) : 'محادثة خاصة';
            }
            result.push({
                ...conv,
                title: title || conv.title,
                unread_count: unreadRow ? unreadRow.count : 0,
                last_message: lastMsg || null,
                participants: participants || []
            });
        }
        res.json({ success: true, conversations: result });
    } catch (err) {
        console.error('Chat conversations error:', err);
        res.status(500).json({ error: 'فشل في جلب المحادثات' });
    }
});

// 2. POST /api/chat/conversations — create group
app.post('/api/chat/conversations', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const { title, participant_ids } = req.body;
        if (!title || typeof title !== 'string' || title.trim() === '') {
            return res.status(400).json({ error: 'عنوان المجموعة مطلوب' });
        }
        if (!Array.isArray(participant_ids) || participant_ids.length < 1) {
            return res.status(400).json({ error: 'يجب إضافة مشارك واحد على الأقل' });
        }
        const convId = await db.run(
            `INSERT INTO chat_conversations (type, title, created_by) VALUES (?, ?, ?);`,
            ['group', title.trim(), req.user.id]
        );
        // Archive Contract §5: stamp with the active shift (NULL = general conversation)
        try {
            const _sid = await getActiveShiftId();
            if (_sid) await db.run('UPDATE chat_conversations SET shift_id = ? WHERE id = ?', [_sid, convId.id]);
        } catch (e) { /* shift stamping is best-effort */ }
        // Add creator as admin
        await db.run(
            `INSERT INTO chat_participants (conversation_id, user_id, is_admin) VALUES (?, ?, ?);`,
            [convId.id, req.user.id, 1]
        );
        // Add participants
        for (const pid of participant_ids) {
            if (pid !== req.user.id) {
                await db.run(
                    `INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, is_admin) VALUES (?, ?, ?);`,
                    [convId.id, pid, 0]
                );
            }
        }
        const conversation = await db.get('SELECT * FROM chat_conversations WHERE id = ?', [convId.id]);
        res.json({ success: true, conversation });
    } catch (err) {
        console.error('Create group chat error:', err);
        res.status(500).json({ error: 'فشل في إنشاء المجموعة' });
    }
});

// 3. POST /api/chat/conversations/private — start or find private chat
app.post('/api/chat/conversations/private', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const { user_id } = req.body;
        if (!user_id) {
            return res.status(400).json({ error: 'معرف المستخدم مطلوب' });
        }
        const currentUserId = req.user.id;
        const targetUserId = String(user_id); // تحويل إلى string للمطابقة
        
        // Check if private conversation already exists
        const existing = await db.get(
            `SELECT c.* FROM chat_conversations c
             JOIN chat_participants p1 ON c.id = p1.conversation_id
             JOIN chat_participants p2 ON c.id = p2.conversation_id
             WHERE c.type = 'private' AND p1.user_id = ? AND p2.user_id = ?`,
            [currentUserId, targetUserId]
        );
        if (existing) {
            const participants = await db.all(
                `SELECT p.*, u.username, u.name, u.role FROM chat_participants p
                 LEFT JOIN users u ON p.user_id = u.user_id
                 WHERE p.conversation_id = ?`,
                [existing.id]
            );
            // Build title for private chats
            let title = existing.title;
            if (!title && existing.type === 'private') {
                const other = participants.find(function(p) { return p.user_id !== currentUserId; });
                title = other ? (other.name || other.username) : 'محادثة خاصة';
            }
            return res.json({ success: true, conversation: { ...existing, title: title, participants } });
        }
        // Create new private conversation
        const convResult = await db.run(
            `INSERT INTO chat_conversations (type, created_by) VALUES (?, ?);`,
            ['private', currentUserId]
        );
        // Archive Contract §5: stamp with the active shift (NULL = general conversation)
        try {
            const _sid = await getActiveShiftId();
            if (_sid) await db.run('UPDATE chat_conversations SET shift_id = ? WHERE id = ?', [_sid, convResult.id]);
        } catch (e) { /* shift stamping is best-effort */ }
        await db.run(
            `INSERT INTO chat_participants (conversation_id, user_id) VALUES (?, ?);`,
            [convResult.id, currentUserId]
        );
        await db.run(
            `INSERT INTO chat_participants (conversation_id, user_id) VALUES (?, ?);`,
            [convResult.id, targetUserId]
        );
        const conversation = await db.get('SELECT * FROM chat_conversations WHERE id = ?', [convResult.id]);
        const participants = await db.all(
            `SELECT p.*, u.username, u.name, u.role FROM chat_participants p
             LEFT JOIN users u ON p.user_id = u.user_id
             WHERE p.conversation_id = ?`,
            [convResult.id]
        );
        // Build title for private chats
        let title = conversation.title;
        if (!title && conversation.type === 'private') {
            const other = participants.find(function(p) { return p.user_id !== currentUserId; });
            title = other ? (other.name || other.username) : 'محادثة خاصة';
        }
        res.json({ success: true, conversation: { ...conversation, title: title, participants } });
    } catch (err) {
        console.error('Private chat error:', err);
        res.status(500).json({ error: 'فشل في إنشاء المحادثة الخاصة' });
    }
});

// 4. GET /api/chat/conversations/:id/messages
app.get('/api/chat/conversations/:id/messages', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const convId = parseInt(req.params.id);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const offset = (page - 1) * limit;
        const userId = req.user.id;
        // Verify participant
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ?',
            [convId, userId]
        );
        if (!participant) {
            return res.status(403).json({ error: 'ليس لديك صلاحية الوصول لهذه المحادثة' });
        }
        const messages = await db.all(
            `SELECT m.*, u.name as sender_name FROM chat_messages m
             LEFT JOIN users u ON m.sender_id = u.user_id
             WHERE m.conversation_id = ? AND m.is_deleted = 0
             ORDER BY m.created_at DESC LIMIT ? OFFSET ?`,
            [convId, limit, offset]
        );
        // Add read_by for each message
        for (const msg of messages) {
            const reads = await db.all(
                'SELECT user_id, read_at FROM chat_message_reads WHERE message_id = ?',
                [msg.id]
            );
            msg.read_by = reads || [];
        }
        res.json({ success: true, messages, page, limit });
    } catch (err) {
        console.error('Get messages error:', err);
        res.status(500).json({ error: 'فشل في جلب الرسائل' });
    }
});

// 5. POST /api/chat/conversations/:id/messages
app.post('/api/chat/conversations/:id/messages', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const convId = parseInt(req.params.id);
        const { content, type, file_url, context_type, context_id, reply_to } = req.body;
        const msgType = type || 'text';
        if (!content && msgType !== 'file') {
            return res.status(400).json({ error: 'محتوى الرسالة مطلوب' });
        }
        const userId = req.user.id;
        // Verify participant
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ?',
            [convId, userId]
        );
        if (!participant) {
            return res.status(403).json({ error: 'ليس لديك صلاحية الإرسال لهذه المحادثة' });
        }
        const result = await db.run(
            `INSERT INTO chat_messages (conversation_id, sender_id, content, type, file_url, context_type, context_id, reply_to)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
            [convId, userId, content || '', msgType, file_url || null, context_type || null, context_id || null, reply_to || null]
        );
        await db.run(
            'UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?;',
            [convId]
        );
        const message = await db.get(
            `SELECT m.*, u.name as sender_name FROM chat_messages m
             LEFT JOIN users u ON m.sender_id = u.user_id
             WHERE m.id = ?`,
            [result.id]
        );
        message.read_by = [];
        // Broadcast to conversation participants only (DB-backed, fail-closed)
        await broadcastToConversation(convId, { type: 'chat_message', conversationId: convId, message: message });
        res.json({ success: true, message });
    } catch (err) {
        console.error('Send message error:', err);
        res.status(500).json({ error: 'فشل في إرسال الرسالة' });
    }
});

// 6. PUT /api/chat/messages/:id/read
app.put('/api/chat/messages/:id/read', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const messageId = parseInt(req.params.id);
        const userId = req.user.id;
        const message = await db.get('SELECT * FROM chat_messages WHERE id = ?', [messageId]);
        if (!message) {
            return res.status(404).json({ error: 'الرسالة غير موجودة' });
        }
        // Verify participant
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ?',
            [message.conversation_id, userId]
        );
        if (!participant) {
            return res.status(403).json({ error: 'ليس لديك صلاحية' });
        }
        await db.run(
            'INSERT OR IGNORE INTO chat_message_reads (message_id, user_id) VALUES (?, ?);',
            [messageId, userId]
        );
        await db.run(
            'UPDATE chat_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = ? AND user_id = ?;',
            [message.conversation_id, userId]
        );
        // Broadcast read receipt to conversation participants only (fail-closed)
        await broadcastToConversation(message.conversation_id, { type: 'chat_read', messageId: messageId, userId: userId, readAt: new Date().toISOString() });
        // Broadcast read receipt to conversation participants
        res.json({ success: true, message: 'تم الت标记 كمقروء' });
    } catch (err) {
        console.error('Mark read error:', err);
        res.status(500).json({ error: 'فشل في تحديث حالة القراءة' });
    }
});

// 7. GET /api/chat/users
app.get('/api/chat/users', authenticate, async (req, res) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
        const activeUsers = users.filter(u => u.isActive).map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role }));
        res.json({ success: true, users: activeUsers });
    } catch (err) {
        console.error('Chat users error:', err);
        res.status(500).json({ error: 'فشل في جلب المستخدمين' });
    }
});

// 7b. GET /api/chat/online — get currently online users
app.get('/api/chat/online', authenticate, async (req, res) => {
    try {
        const online = getOnlineUsers();
        res.json({ success: true, onlineUsers: online, count: online.length });
    } catch (err) {
        console.error('Chat online users error:', err);
        res.status(500).json({ error: 'فشل في جلب المستخدمين المتصلين' });
    }
});

// 8. DELETE /api/chat/conversations/:id — archive group (admin only)
app.delete('/api/chat/conversations/:id', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const convId = parseInt(req.params.id);
        const userId = req.user.id;
        const conversation = await db.get('SELECT * FROM chat_conversations WHERE id = ?', [convId]);
        if (!conversation) {
            return res.status(404).json({ error: 'المحادثة غير موجودة' });
        }
        if (conversation.type !== 'group') {
            return res.status(400).json({ error: 'يمكن أرشفة المجموعات فقط' });
        }
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND is_admin = 1',
            [convId, userId]
        );
        if (!participant) {
            return res.status(403).json({ error: 'فقط المسؤول يمكنه أرشفة المجموعة' });
        }
        await db.run('UPDATE chat_conversations SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?;', [convId]);
        res.json({ success: true, message: 'تم أرشفة المحادثة' });
    } catch (err) {
        console.error('Archive conversation error:', err);
        res.status(500).json({ error: 'فشل في أرشفة المحادثة' });
    }
});

// 9. POST /api/chat/conversations/:id/participants — add participant (admin only)
app.post('/api/chat/conversations/:id/participants', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const convId = parseInt(req.params.id);
        const { user_id } = req.body;
        if (!user_id) {
            return res.status(400).json({ error: 'معرف المستخدم مطلوب' });
        }
        const userId = req.user.id;
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND is_admin = 1',
            [convId, userId]
        );
        if (!participant) {
            return res.status(403).json({ error: 'فقط المسؤول يمكنه إضافة مشاركين' });
        }
        await db.run(
            'INSERT OR IGNORE INTO chat_participants (conversation_id, user_id, is_admin) VALUES (?, ?, ?);',
            [convId, user_id, 0]
        );
        res.json({ success: true, message: 'تم إضافة المشارك' });
    } catch (err) {
        console.error('Add participant error:', err);
        res.status(500).json({ error: 'فشل في إضافة المشارك' });
    }
});

// 10. DELETE /api/chat/conversations/:id/participants/:user_id — remove participant (admin only, cannot remove creator)
app.delete('/api/chat/conversations/:id/participants/:user_id', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const convId = parseInt(req.params.id);
        const targetUserId = req.params.user_id;
        const userId = req.user.id;
        const conversation = await db.get('SELECT * FROM chat_conversations WHERE id = ?', [convId]);
        if (!conversation) {
            return res.status(404).json({ error: 'المحادثة غير موجودة' });
        }
        if (targetUserId === conversation.created_by) {
            return res.status(403).json({ error: 'لا يمكن إزالة منشئ المحادثة' });
        }
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ? AND is_admin = 1',
            [convId, userId]
        );
        if (!participant) {
            return res.status(403).json({ error: 'فقط المسؤول يمكنه إزالة مشاركين' });
        }
        await db.run(
            'DELETE FROM chat_participants WHERE conversation_id = ? AND user_id = ?;',
            [convId, targetUserId]
        );
        res.json({ success: true, message: 'تم إزالة المشارك' });
    } catch (err) {
        console.error('Remove participant error:', err);
        res.status(500).json({ error: 'فشل في إزالة المشارك' });
    }
});

// 11. POST /api/chat/upload — file upload for chat
app.post('/api/chat/upload', authenticate, uploadChat.single('file'), handleMulterError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم رفع أي ملف' });
        }
        const originalName = req.file.originalname;
        const ext = path.extname(originalName);
        const storedName = 'chat-' + Date.now() + '-' + Math.random().toString(36).substring(2, 10) + ext;
        const destDir = path.join(STORAGE_PATH, 'uploads', 'chat');
        const destPath = path.join(destDir, storedName);
        await fs.rename(req.file.path, destPath);
        const fileUrl = '/uploads/chat/' + storedName;
        res.json({ success: true, fileUrl, filename: originalName, storedName, size: req.file.size });
    } catch (err) {
        console.error('Chat upload error:', err);
        res.status(500).json({ error: 'فشل في رفع الملف' });
    }
});

// 12. PUT /api/chat/conversations/:id/leave — leave a group conversation
app.put('/api/chat/conversations/:id/leave', authenticate, async (req, res) => {
    try {
        if (!db) return res.status(503).json({ error: 'Database not available' });
        const convId = parseInt(req.params.id);
        const userId = req.user.id;
        const conversation = await db.get('SELECT * FROM chat_conversations WHERE id = ?', [convId]);
        if (!conversation) {
            return res.status(404).json({ error: 'المحادثة غير موجودة' });
        }
        if (conversation.type !== 'group') {
            return res.status(400).json({ error: 'يمكن مغادرة المجموعات فقط' });
        }
        // Cannot leave if you are the creator and only admin
        const participant = await db.get(
            'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id = ?',
            [convId, userId]
        );
        if (!participant) {
            return res.status(404).json({ error: 'أنت لست مشاركاً في هذه المحادثة' });
        }
        // If creator, prevent leaving unless another admin exists
        if (conversation.created_by === userId) {
            const otherAdmin = await db.get(
                'SELECT * FROM chat_participants WHERE conversation_id = ? AND user_id != ? AND is_admin = 1',
                [convId, userId]
            );
            if (!otherAdmin) {
                return res.status(403).json({ error: 'لا يمكن مغادرة المجموعة قبل تعيين مسؤول آخر' });
            }
        }
        await db.run('DELETE FROM chat_participants WHERE conversation_id = ? AND user_id = ?;', [convId, userId]);
        // Broadcast system message to participants only (fail-closed)
        await broadcastToConversation(convId, {
            type: 'chat_conversation_update',
            conversationId: convId,
            event: 'user_left',
            userId: userId,
            userName: req.user.name
        });
        res.json({ success: true, message: 'تم مغادرة المحادثة' });
    } catch (err) {
        console.error('Leave conversation error:', err);
        res.status(500).json({ error: 'فشل في مغادرة المحادثة' });
    }
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'المسار غير موجود' });
});

// AI Monitor error tracking middleware
if (aiMonitor) {
    app.use(aiMonitor.errorTrackingMiddleware());
}
// Global error handler
app.use((err, req, res, next) => {
    console.error('❌ Error:', err.stack || err.message);
    if (err.status === 413 || err.message && err.message.includes('file size')) {
        return res.status(413).json({ error: 'حجم الملف كبير جداً' });
    }
    res.status(err.status || 500).json({ error: 'خطأ في الخادم' });
});

// ============================================
// تشغيل الخادم + WebSocket + Graceful Shutdown
// ============================================
const server = require('http').createServer(app);

// Initialize WebSocket on same HTTP server
initWebSocket(server);

// Initialize SQLite Database + Migrate JSON data
async function initDatabase() {
    if (!db) {
        console.log('📁 SQLite not available — using JSON file mode');
        return;
    }
    try {
        console.log('🗄️ Initializing SQLite database...');
        await db.init(true); // init + migrate
        console.log('✅ SQLite database ready');
        
        // Create frontend_errors table for Smart AI Monitor
        try {
            await db.run(`CREATE TABLE IF NOT EXISTS frontend_errors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                type TEXT,
                message TEXT,
                file TEXT,
                line INTEGER,
                column INTEGER,
                stack TEXT,
                page_url TEXT,
                page_path TEXT,
                user_agent TEXT,
                screen TEXT,
                session_id TEXT
            )`);
            console.log('✅ frontend_errors table ready');
        } catch (e) {
            console.error('❌ Failed to create frontend_errors table:', e.message);
        }

        // Sync users from JSON to SQLite for chat module
        try {
            const usersJson = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
            for (const u of usersJson) {
                const existing = await db.get('SELECT id FROM users WHERE user_id = ?', [u.id]);
                if (!existing) {
                    await db.run(
                        'INSERT INTO users (user_id, username, password, name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
                        [u.id, u.username, u.password || '', u.name, u.role, u.isActive ? 1 : 0]
                    );
                }
            }
            console.log('✅ Users synced to SQLite for chat module');
        } catch (e) {
            console.error('❌ Failed to sync users to SQLite:', e.message);
        }
    } catch (err) {
        console.error('❌ Failed to initialize database:', err.message);
        console.log('⚠️ Falling back to JSON file mode');
    }
}

server.listen(PORT, async () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار بيانات البلاغات: ${DATA_PATH}`);
    console.log(`📁 مسار بيانات المناوبات: ${SHIFT_DATA_PATH}`);
    console.log(`📁 مسار التحديثات التشغيلية: ${DOCS_PATH}`);
    console.log(`📁 مسار الإسعاف الجوي: ${AIR_PATH}`);
    console.log(`📁 مسار هوية القطاع: ${IDENTITY_PATH}`);
    console.log(`📁 مسار الرقم السري: ${PASSWORD_PATH}`);
    console.log(`📁 مسار بيانات وقت الذروة: ${PEAK_DATA_PATH}`);
    console.log(`📁 مسار إعدادات الثيمات: ${THEME_SETTINGS_PATH}`);
    console.log(`🗺️ تم تحميل البيانات الجغرافية لـ ${Object.keys(centerGeoData).length} مركز`);
    console.log(`📸 مجلد رفع الثيمات: ${path.join(STORAGE_PATH, 'uploads')}`);
    console.log(`🔒 Security: Helmet, Rate Limiting, CORS enabled`);
    console.log(`📡 WebSocket attached on path /ws`);
    console.log(`📡 SSE endpoint available on /api/sse`);
    
    // Initialize DB after server starts
    await initDatabase();
    
    // ═══════════════════════════════════════════════════════════
    // Initialize Operations Engine (Single Source of Truth)
    // ═══════════════════════════════════════════════════════════
    try {
        opsEngine = await createEngine({ db: db });
        console.log('✅ Operations Engine initialized');
    } catch (err) {
        console.error('⚠️ Operations Engine failed:', err.message);
        opsEngine = null;
    }

    // ═══════════════════════════════════════════════════════════
    // Slice 1: Event-driven write path (Reports + Completion)
    // Route → Service → SQLite transaction → COMMIT → domain event
    // on the engine-owned Event Bus → subscribers (broadcast, ...).
    // The engine holds the bus; we register ONE broadcast subscriber
    // that maps domain events to the EXISTING broadcast() payloads.
    // ═══════════════════════════════════════════════════════════
    if (opsEngine) {
        try {
            const ReportService = require('./services/report-service');
            const CompletionService = require('./services/completion-service');
            opsEngine.wireEvents({ broadcast });
            reportService = new ReportService({ engine: opsEngine, bus: opsEngine.bus });
            completionService = new CompletionService({ engine: opsEngine, bus: opsEngine.bus });
            console.log('✅ Event-driven services wired (ReportService, CompletionService)');

            // F5a: IndicatorService — read-only operational indicators bundle
            const IndicatorService = require('./services/indicator-service');
            indicatorService = new IndicatorService({ engine: opsEngine, reportService });
            console.log('✅ IndicatorService wired (F5a, read-only)');

            // Archive slice: single archive path (Archive Contract §2) —
            // seal + conversation archiving + status transition
            const ArchiveService = require('./services/archive-service');
            opsEngine.archiveService = new ArchiveService({
                archiveEngine,
                shiftService: opsEngine.shiftService,
                storage: opsEngine.storage,
                db
            });
            // Late binding so ShiftService.startShift can seal auto-archived shifts
            opsEngine.shiftService.getArchiveService = () => opsEngine.archiveService;
            console.log('✅ ArchiveService wired (single archive path)');

            // Slice 4: PositioningService — single owner of peak_plans writes
            const PositioningService = require('./services/positioning-service');
            positioningService = new PositioningService({ db, bus: opsEngine.bus, getActiveShiftId });
            console.log('✅ PositioningService wired (Slice 4)');

            // Slice 5: NotesService — single owner of shift_notes writes
            const NotesService = require('./services/notes-service');
            notesService = new NotesService({ engine: opsEngine, db, bus: opsEngine.bus });
            console.log('✅ NotesService wired (Slice 5)');

            // Slice 6: FormsService — single owner of all form writes (form_type)
            const FormsService = require('./services/forms-service');
            formsService = new FormsService({ db, bus: opsEngine.bus, getActiveShiftId });
            console.log('✅ FormsService wired (Slice 6)');
        } catch (err) {
            console.error('⚠️ Event-driven services failed:', err.message);
            reportService = null;
            completionService = null;
            indicatorService = null;
            positioningService = null;
            notesService = null;
            formsService = null;
        }
    }
    
    // Initialize RAG Engine
    await initRAG();
    
    // Initialize new KB RAG index
    try {
        await kbApi.loadIndexFromFile();
        if (!kbApi.ragIndex.isBuilt && db) {
            await kbApi.loadIndexFromDB(db);
        }
        if (kbApi.ragIndex.isBuilt) {
            console.log('✅ KB RAG index loaded');
        }
    } catch (err) {
        console.error('⚠️ KB RAG index init warning:', err.message);
    }
    
    // Initialize AI Monitor
    if (aiMonitor) {
        aiMonitor.init({ db, wss, app });
        console.log('🤖 AI Monitor initialized');
    }

    console.log('🤖 RAG-based Operational AI Assistant ready');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received. Shutting down gracefully...');
    // إغلاق جميع اتصالات SSE
    sseClients.forEach(function(client) {
        try { client.res.end(); } catch(e) {}
    });
    server.close(() => {
        console.log('✅ HTTP server closed');
        if (wss) {
            wss.clients.forEach(client => client.close());
            wss.close(() => {
                console.log('✅ WebSocket server closed');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
});


// ============================================
// Shift Archive Engine v2.0 — New Routes
// ============================================

// GET /api/shifts/:id/verify-archive — التحقق من سلامة أرشيف
app.get('/api/shifts/:id/verify-archive', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        console.log('[ShiftArchive] Verify archive requested for shift #' + shiftId);

        const { ShiftArchiveSnapshot, ShiftIntegrityChecker } = require('./shift-archive-engine');
        const snapshotter = new ShiftArchiveSnapshot(db, STORAGE_PATH);
        const checker = new ShiftIntegrityChecker(db, STORAGE_PATH);

        const snapshot = await snapshotter.create(shiftId);
        const result = await checker.verify(shiftId, snapshot);

        res.json({
            success: true,
            shiftId,
            passed: result.passed,
            timestamp: result.timestamp,
            checks: result.checks
        });
    } catch (error) {
        console.error('Verify archive error:', error);
        res.status(500).json({ error: 'فشل في التحقق من سلامة الأرشيف: ' + error.message });
    }
});

// POST /api/shifts/:id/rearchive — إعادة أرشفة
app.post('/api/shifts/:id/rearchive', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        console.log('[ShiftArchive] Re-archive requested for shift #' + shiftId);

        const result = await archiveEngine.executeArchive(shiftId, {
            user: req.user,
            strict: true,
            skipVerify: false,
            force: true
        });

        if (result.success) {
            res.json({
                success: true,
                shiftId,
                message: 'تمت إعادة الأرشفة بنجاح',
                snapshotHash: result.snapshotHash,
                duration: result.duration
            });
        } else {
            res.status(500).json({
                success: false,
                error: result.error?.message || 'فشلت إعادة الأرشفة',
                phases: result.phases
            });
        }
    } catch (error) {
        console.error('Re-archive error:', error);
        res.status(500).json({ error: 'فشل في إعادة الأرشفة: ' + error.message });
    }
});

// GET /api/shifts/:id/archive-log — سجل عمليات الأرشفة
app.get('/api/shifts/:id/archive-log', authenticate, async (req, res) => {
    try {
        const shiftId = parseInt(req.params.id);
        const { ShiftAuditLogger } = require('./shift-archive-engine');
        const logger = new ShiftAuditLogger(db, STORAGE_PATH);
        const logs = await logger.getLogs(shiftId, parseInt(req.query.limit) || 50);

        res.json({ success: true, shiftId, logs });
    } catch (error) {
        console.error('Archive log error:', error);
        res.status(500).json({ error: 'فشل في جلب سجل الأرشفة: ' + error.message });
    }
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received. Shutting down gracefully...');
    // إغلاق جميع اتصالات SSE
    sseClients.forEach(function(client) {
        try { client.res.end(); } catch(e) {}
    });
    server.close(() => {
        console.log('✅ HTTP server closed');
        if (wss) {
            wss.clients.forEach(client => client.close());
            wss.close(() => {
                console.log('✅ WebSocket server closed');
                process.exit(0);
            });
        } else {
            process.exit(0);
        }
    });
});