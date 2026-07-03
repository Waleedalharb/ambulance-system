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

// SQLite Database Module (optional — falls back to JSON if unavailable)
let db = null;
try {
    db = require('./db.js');
    console.log('✅ SQLite module loaded successfully');
} catch (err) {
    console.error('⚠️ SQLite module failed to load:', err.message);
    console.log('📁 Falling back to JSON file mode');
    db = null;
}

// Helper: check if DB is available
function dbAvailable() {
    return db && db.Employees && db.Teams && db.ShiftCodes && db.ShiftRoster && db.TeamAssignments;
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

// ============================================
// Logger (بسيط — يعمل حتى بدون winston)
// ============================================
const logger = {
  info: (...args) => console.log(`[${new Date().toISOString()}] [INFO]`, ...args),
  error: (...args) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...args),
  warn: (...args) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...args),
  debug: (...args) => process.env.DEBUG === '1' && console.log(`[${new Date().toISOString()}] [DEBUG]`, ...args)
};
const securityConfig = require('./config/security');
const app = express();
const PORT = process.env.PORT || 3002;

const { JWT_SECRET, JWT_EXPIRES_IN, HELMET_CONFIG, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, LOGIN_RATE_LIMIT_MAX, JSON_LIMIT, URLENCODED_LIMIT, MAX_FILE_SIZE, OPS_MAX_FILE_SIZE, API_READ_LIMIT_WINDOW_MS, API_READ_LIMIT_MAX } = securityConfig;

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
        
        console.log('🟢 WebSocket client connected from', origin || 'unknown');
        clients.push(ws);
        
        ws.send(JSON.stringify({ type: 'connected', message: 'متصل بالسيرفر' }));
        
        ws.on('close', function() {
            console.log('🔴 WebSocket client disconnected');
            clients = clients.filter(function(c) { return c !== ws; });
        });
        
        ws.on('error', function(err) {
            console.error('WebSocket error:', err);
        });
    });
    console.log('🔌 WebSocket server attached to HTTP server on /ws');
}

// دالة لبث الرسائل لجميع المتصلين
function broadcast(data) {
    var message = JSON.stringify(data);
    clients = clients.filter(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                return true;
            } catch (e) {
                console.error('Broadcast send error:', e.message);
                return false;
            }
        }
        return false;
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
const DAILY_REPORTS_PATH = path.join(STORAGE_PATH, 'daily-reports.json');
const SCHEDULE_EMPLOYEES_PATH = path.join(STORAGE_PATH, 'schedule-employees.json');
const SCHEDULE_FILES_PATH = path.join(STORAGE_PATH, 'schedule-files.json');
const REPORT_ENTRY_PATH = path.join(STORAGE_PATH, 'report-entry.json');
const DASHBOARD_PATH = path.join(STORAGE_PATH, 'dashboard.json');
const HOSPITALS_PATH = path.join(STORAGE_PATH, 'hospitals.json');
const REFERENCES_PATH = path.join(STORAGE_PATH, 'references.json');
const TIMELINE_PATH = path.join(STORAGE_PATH, 'timeline.json');
const UNIT_LOCATION_ADDRESSES_PATH = path.join(STORAGE_PATH, 'unit-location-addresses.json');
const UNIT_LOCATIONS_PATH = path.join(STORAGE_PATH, 'unit-locations.json');

let lastUpdateTime = Date.now();
let currentShiftId = null;

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
    // صباح: 05:00 - 17:00 | ليل: 17:00 - 05:00
    return (hour >= 5 && hour < 17) ? 'صباح' : 'ليل';
}

function getCurrentShiftDate() {
    const saudiTime = getSaudiDateTime();
    const year = saudiTime.getFullYear();
    const month = (saudiTime.getMonth() + 1).toString().padStart(2, '0');
    const day = saudiTime.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getShiftKey() {
    return getCurrentShiftDate() + ' ' + getCurrentShiftType();
}

async function autoArchiveIfShiftChanged() {
    try {
        const currentReports = await readData();
        const total = Object.values(currentReports).reduce((sum, r) => sum + (r.count || 0), 0);
        if (total === 0) return false; // No data to archive
        
        const shifts = await readShifts();
        const currentShiftType = getCurrentShiftType();
        const currentShiftDate = getCurrentShiftDate();
        const shiftKey = getShiftKey();
        
        // Check if this shift is already archived
        const existingShift = shifts.find(s => s.shiftDate === currentShiftDate && s.shiftType === currentShiftType);
        if (existingShift) return false; // Already archived for this shift
        
        // FIX: Check if data has timestamps from the CURRENT shift
        // If so, don't archive - just create a shift record for tracking
        const hasCurrentShiftData = Object.values(currentReports).some(r => {
            if (!r.times || r.times.length === 0) return false;
            return r.times.some(t => t.startsWith(currentShiftDate));
        });
        
        if (hasCurrentShiftData) {
            // Data is from current shift, create record without archiving/clearing
            const saudiTime = getSaudiDateTime();
            const newShift = {
                id: Date.now(),
                shiftName: `${currentShiftType} - ${currentShiftDate} ${saudiTime.toLocaleTimeString('ar-SA')}`,
                shiftDate: currentShiftDate,
                shiftTime: saudiTime.toLocaleTimeString('ar-SA'),
                shiftType: currentShiftType,
                startTime: saudiTime.toISOString(),
                savedReports: {},
                totalReports: 0,
                rapidLocations: {},
                centersData: {},
                vehicleData: {},
                fuelData: {},
                generalNotes: "",
                lastUpdate: saudiTime.toISOString(),
                autoArchived: false
            };
            shifts.unshift(newShift);
            if (shifts.length > 50) shifts.pop();
            await writeShifts(shifts);
            currentShiftId = newShift.id;
            return false;
        }
        
        // Data is from previous shift, archive it properly
        const saudiTime = getSaudiDateTime();
        const newShift = {
            id: Date.now(),
            shiftName: `${currentShiftType} - ${currentShiftDate} ${saudiTime.toLocaleTimeString('ar-SA')}`,
            shiftDate: currentShiftDate,
            shiftTime: saudiTime.toLocaleTimeString('ar-SA'),
            shiftType: currentShiftType,
            startTime: saudiTime.toISOString(),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            vehicleData: {},
            fuelData: {},
            generalNotes: "",
            lastUpdate: saudiTime.toISOString(),
            autoArchived: true
        };
        
        shifts.unshift(newShift);
        if (shifts.length > 50) shifts.pop();
        await writeShifts(shifts);
        
        // Clear current reports for new shift
        await writeData({});
        currentShiftId = newShift.id;
        
        broadcast({
            type: 'shift_auto_archived',
            message: 'تم أرشفة نوبة ' + currentShiftType + ' تلقائياً',
            shiftId: newShift.id,
            shiftType: currentShiftType
        });
        
        return true;
    } catch (error) {
        console.error('Auto-archive error:', error);
        return false;
    }
}

// ============================================
// التأكد من وجود مجلدات البيانات
// ============================================
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
        await initDefaultUsers();
        // Restore currentShiftId from shifts list on startup
        try {
            const shifts = await readShifts();
            const shiftType = getCurrentShiftType();
            const shiftDate = getCurrentShiftDate();
            const currentShift = shifts.find(s => s.shiftDate === shiftDate && s.shiftType === shiftType);
            if (currentShift) {
                currentShiftId = currentShift.id;
                console.log('✅ تم استعادة المناوبة الحالية: ' + currentShift.shiftName);
            }
        } catch (e) { /* ignore */ }
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
app.use(compression());

// 3. CORS
app.use(cors({
    origin: process.env.CORS_ORIGIN || (process.env.NODE_ENV === 'production' ? false : '*'),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

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

// 7. Lighter rate limit for read-heavy API endpoints
const apiReadLimiter = rateLimit({
    windowMs: API_READ_LIMIT_WINDOW_MS,
    max: API_READ_LIMIT_MAX,
    message: { error: 'عدد الطلبات مرتفع جداً. الرجاء المحاولة لاحقاً.' },
    standardHeaders: true,
    legacyHeaders: false,
});

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

function authenticate(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'مطلوب توكن المصادقة' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'توكن غير صالح' });
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
// Health Check (للـ Render Monitoring + Uptime)
// ============================================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
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
    });
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
        if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        
        const token = jwt.sign({ id: user.id, username: user.username, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    } catch (error) {
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
        res.json({ success: true, user });
    } catch (error) {
        res.json({ success: true, user: req.user });
    }
});

app.post('/api/auth/logout', authenticate, (req, res) => {
    res.json({ success: true, message: 'تم تسجيل الخروج' });
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

        broadcast({ type: 'password_changed', message: 'تم تغيير كلمة المرور', username: user.username });
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
const ALLOWED_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf'];

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
// بيانات قطاع الجنوب
// ============================================
const centersData = {
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

async function writeData(data) {
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
    lastUpdateTime = Date.now();
}

async function readShifts() {
    try {
        const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeShifts(data) {
    await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(data, null, 2));
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
// دوال التقارير اليومية
// ============================================
async function readDailyReports() {
    try {
        const data = await fs.readFile(DAILY_REPORTS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function writeDailyReports(data) {
    await fs.writeFile(DAILY_REPORTS_PATH, JSON.stringify(data, null, 2));
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
        const data = await readData();
        const shiftType = getCurrentShiftType();
        const shiftDate = getCurrentShiftDate();
        
        // Find current shift ID from shifts list if not set in memory
        if (!currentShiftId) {
            try {
                const shifts = await readShifts();
                const currentShift = shifts.find(s => s.shiftDate === shiftDate && s.shiftType === shiftType);
                if (currentShift) currentShiftId = currentShift.id;
            } catch (e) { /* ignore */ }
        }
        
        res.json({
            data,
            centers: centersData,
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
    try {
        const shiftType = getCurrentShiftType();
        const shiftDate = getCurrentShiftDate();
        const data = await readData();
        const total = Object.values(data).reduce((sum, r) => sum + (r.count || 0), 0);
        res.json({
            success: true,
            shift: {
                type: shiftType,
                date: shiftDate,
                key: shiftDate + ' ' + shiftType,
                totalReports: total
            }
        });
    } catch (error) {
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
    try {
        const shifts = await readShifts();
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبات' });
    }
});

app.get('/api/shifts/:id', authenticate, async (req, res) => {
    try {
        const shifts = await readShifts();
        const shiftId = parseInt(req.params.id);
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        res.json({
            shift: shift,
            reports: shift.savedReports || {},
            total: shift.totalReports || 0
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبة' });
    }
});

app.post('/api/start-new-shift', authenticate, authorize(['admin', 'director']), async (req, res) => {
    // Shifts are now automatic - manual start is disabled
    res.json({ 
        success: false, 
        message: 'النظام يدير النوبات تلقائياً. لا حاجة لبدء مناوبة يدوياً.',
        currentShift: {
            type: getCurrentShiftType(),
            date: getCurrentShiftDate(),
            key: getShiftKey()
        }
    });
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
            index = shifts.findIndex(s => s.shiftDate === shiftDate && s.shiftType === shiftType);
        }
        
        if (index !== -1) {
            // Update existing shift
            shifts[index].rapidLocations = shiftData.rapidLocations || {};
            shifts[index].centersData = shiftData.centersData || {};
            shifts[index].generalNotes = shiftData.generalNotes || "";
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
                shiftName: `${shiftData.shiftType || 'صباح'} - ${shiftDate || isoDate}`,
                shiftDate: shiftDate || isoDate,
                shiftTime: saudiTime.toLocaleTimeString('ar-SA'),
                shiftType: shiftData.shiftType || 'صباح',
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
        try {
            const shiftDateToUse = targetShift ? targetShift.shiftDate : (shiftDate || isoDate);
            const teams = await db.Teams.getAll();
            const centerParamedics = {};
            for (const team of teams) {
                if (!centerParamedics[team.center]) centerParamedics[team.center] = [];
                const roster = await db.ShiftRoster.getByDateAndTeam(shiftDateToUse, team.id);
                const absentCodes = ['V', 'VC', 'E', 'EV', 'WO'];
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
                    targetShift.centersData[center].assignedParamedics = centerParamedics[center];
                    targetShift.centersData[center].staffCount = centerParamedics[center].filter(p => p.status === 'حاضر').length;
                }
            }
        } catch (e) {
            console.warn('Could not enrich centersData with paramedics:', e.message);
        }
        
        await writeShifts(shifts);
        if (targetShift) currentShiftId = targetShift.id;

        broadcast({
            type: 'shift_updated',
            message: 'تم تحديث بيانات المناوبة',
            shiftId: targetShift ? targetShift.id : null
        });

        res.json({ success: true, shiftId: targetShift ? targetShift.id : null });
    } catch (error) {
        console.error("خطأ في تحديث بيانات المناوبة:", error);
        res.status(500).json({ error: 'فشل في تحديث بيانات المناوبة' });
    }
});

app.delete('/api/shifts/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const shifts = await readShifts();
        const id = parseInt(req.params.id);
        const filtered = shifts.filter(s => s.id !== id);
        await writeShifts(filtered);

        broadcast({
            type: 'shift_deleted',
            message: 'تم حذف المناوبة',
            shiftId: id
        });

        if (currentShiftId === id) {
            currentShiftId = null;
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف المناوبة' });
    }
});

// ============================================
// API: البلاغات
// ============================================
app.post('/api/report', authenticate, validateBody({
    center: { required: true, type: 'string', minLength: 1, maxLength: 100 },
    unit: { required: true, type: 'string', minLength: 1, maxLength: 100 }
}), async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });

    const key = `${center}|${unit}`;
    const now = new Date();
    const offset = 3;
    const saudiTime = new Date(now.getTime() + (offset * 60 * 60 * 1000));
    const year = saudiTime.getUTCFullYear();
    const month = (saudiTime.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = saudiTime.getUTCDate().toString().padStart(2, '0');
    const hours = saudiTime.getUTCHours().toString().padStart(2, '0');
    const minutes = saudiTime.getUTCMinutes().toString().padStart(2, '0');
    const seconds = saudiTime.getUTCSeconds().toString().padStart(2, '0');
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    try {
        // Auto-archive if shift changed
        await autoArchiveIfShiftChanged();
        
        const allData = await readData();
        if (!allData[key]) allData[key] = { count: 0, times: [] };
        allData[key].count++;
        allData[key].times.unshift(timestamp);
        if (allData[key].times.length > 10) allData[key].times.pop();
        await writeData(allData);

        // بث البلاغ الجديد لجميع المتصلين
        broadcast({
            type: 'new_report',
            center: center,
            unit: unit,
            message: 'بلاغ جديد: ' + unit + ' في ' + center
        });

        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

app.post('/api/undo', authenticate, async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });

    const key = `${center}|${unit}`;
    try {
        const allData = await readData();
        if (!allData[key] || allData[key].count === 0) {
            return res.status(400).json({ error: 'لا يوجد بلاغات للحذف' });
        }
        allData[key].count--;
        allData[key].times.shift();
        await writeData(allData);

        broadcast({
            type: 'report_undone',
            message: 'تم التراجع عن بلاغ: ' + unit + ' في ' + center,
            center: center,
            unit: unit
        });

        res.json({ success: true, newCount: allData[key].count });
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
        const shift = shifts.find(s => s.id === shiftId);
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
                const absentCodes = ['V', 'VC', 'E', 'EV', 'WO'];
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
                const absentCodes = ['V', 'VC', 'E', 'EV', 'WO'];
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
            if (shift.shiftType && (shift.shiftType === 'صباحية' || shift.shiftType === 'ليلية')) {
                console.log('[SHIFT-TYPE] Using stored shiftType:', shift.shiftType);
                return shift.shiftType;
            }
            
            // Method 2: Derive from startTime (most reliable)
            // Convert UTC to Saudi Arabia time (UTC+3) before checking hour
            if (shift.startTime) {
                const startDate = new Date(shift.startTime);
                const utcHour = startDate.getUTCHours();
                const saudiHour = (utcHour + 3) % 24;
                const derived = (saudiHour >= 18 || saudiHour < 6) ? 'ليلية' : 'صباحية';
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
            const fallback = (nowSaudiHour >= 18 || nowSaudiHour < 6) ? 'ليلية' : 'صباحية';
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
        
        
        // Define valid shift codes for each shift type
        const dayShiftCodes = ['D12', 'D10', 'D11', 'D8', 'D6', 'M', 'CPD', 'CP8', 'CP24', 'C', 'O12', 'O10', 'O6', 'F', 'ME'];
        const nightShiftCodes = ['N12', 'N10', 'N11', 'N8', 'N6', 'LN8', 'LN10', 'CPN', 'CP24', 'C', 'O12', 'O10', 'O6', 'ME', 'F'];
        const validCodes = isNightShift ? nightShiftCodes : dayShiftCodes;
        
        // Filter paramedics: only show those whose shift code matches current shift type
        const filteredParamedics = paramedics.filter(p => {
            if (!p.shift_code) return false;
            return validCodes.includes(p.shift_code.toUpperCase());
        });
        
        const absentCodes = ['V', 'VC', 'E', 'EV', 'WO'];
        const paramedicsWithStatus = filteredParamedics.map(p => ({
            ...p,
            status: p.shift_code && absentCodes.includes(p.shift_code.toUpperCase()) ? 'غائب' : 'حاضر'
        }));
        
        res.json({ paramedics: paramedicsWithStatus, shiftDate, teamName, shiftType });
    } catch (error) {
        console.error('[API] Error in shift-completion:', error);
        res.json({ paramedics: [], source: 'fallback', error: error.message });
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
        const records = await readAirRecords();
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
        const records = await readAirRecords();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber,
            unit,
            hospital: destinationHospital,
            dateTime,
            notes: `pickup: ${pickupLocation}, diagnosis: ${diagnosis}, reason: ${reason}, patient: ${patientName}, age: ${patientAge}, paramedic: ${paramedic}`,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeAirRecords(records);

        broadcast({
            type: 'air_ambulance_saved',
            message: 'بلاغ إسعاف جوي جديد: ' + reportNumber,
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ بلاغ الإسعاف الجوي' });
    }
});

app.delete('/api/delete-air-ambulance/:id', authenticate, async (req, res) => {
    try {
        const records = await readAirRecords();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeAirRecords(filtered);

        broadcast({
            type: 'air_ambulance_deleted',
            message: 'تم حذف بلاغ إسعاف جوي',
            recordId: req.params.id
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.delete('/api/clear-air-ambulance', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        await writeAirRecords([]);

        broadcast({
            type: 'air_ambulance_cleared',
            message: 'تم حذف جميع بلاغات الإسعاف الجوي'
        });

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
        const records = await readIncidents();
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
        const records = await readIncidents();
        const newRecord = {
            id: Date.now().toString(),
            ...record,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeIncidents(records);

        broadcast({
            type: 'incident_added',
            message: 'تم إضافة حادث جديد',
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ الحادث' });
    }
});

app.delete('/api/incidents/:id', authenticate, async (req, res) => {
    try {
        const records = await readIncidents();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeIncidents(filtered);

        broadcast({
            type: 'incident_deleted',
            message: 'تم حذف حادث',
            recordId: req.params.id
        });

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
        const records = await readSeniorShifts();
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
        const records = await readSeniorShifts();
        const newRecord = {
            id: Date.now().toString(),
            ...record,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeSeniorShifts(records);

        broadcast({
            type: 'senior_shift_added',
            message: 'تم إضافة مناوبة كبار الضباط',
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ مناوبة كبار الضباط' });
    }
});

app.delete('/api/senior-shifts/:id', authenticate, async (req, res) => {
    try {
        const records = await readSeniorShifts();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeSeniorShifts(filtered);

        broadcast({
            type: 'senior_shift_deleted',
            message: 'تم حذف مناوبة كبار الضباط',
            recordId: req.params.id
        });

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
        const records = await readECases();
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
        const records = await readECases();
        const newRecord = {
            id: Date.now().toString(),
            ...record,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeECases(records);

        broadcast({
            type: 'e_case_added',
            message: 'تم إضافة حالة طوارئ جديدة',
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ حالة الطوارئ' });
    }
});

app.delete('/api/e-cases/:id', authenticate, async (req, res) => {
    try {
        const records = await readECases();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeECases(filtered);

        broadcast({
            type: 'e_case_deleted',
            message: 'تم حذف حالة طوارئ',
            recordId: req.params.id
        });

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
        const records = await readEscalations();
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
        const records = await readEscalations();
        const newRecord = {
            id: Date.now().toString(),
            ...record,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeEscalations(records);

        broadcast({
            type: 'escalation_added',
            message: 'تم إضافة بلاغ تصعيد جديد',
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ بلاغ التصعيد' });
    }
});

app.delete('/api/escalations/:id', authenticate, async (req, res) => {
    try {
        const records = await readEscalations();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeEscalations(filtered);

        broadcast({
            type: 'escalation_deleted',
            message: 'تم حذف بلاغ تصعيد',
            recordId: req.params.id
        });

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
        const records = await readDailyReports();
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
        const records = await readDailyReports();
        const newRecord = {
            id: Date.now().toString(),
            ...record,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeDailyReports(records);

        broadcast({
            type: 'daily_report_added',
            message: 'تم إضافة تقرير يومي جديد',
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ التقرير اليومي' });
    }
});

app.delete('/api/daily-reports/:id', authenticate, async (req, res) => {
    try {
        const records = await readDailyReports();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeDailyReports(filtered);

        broadcast({
            type: 'daily_report_deleted',
            message: 'تم حذف تقرير يومي',
            recordId: req.params.id
        });

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

app.get('/api/admin/daily-report', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const saudiTime = getSaudiDateTime();
        const year = saudiTime.getFullYear();
        const month = (saudiTime.getMonth() + 1).toString().padStart(2, '0');
        const day = saudiTime.getDate().toString().padStart(2, '0');
        const today = `${year}-${month}-${day}`;
        const shiftType = getCurrentShiftType();
        
        const data = await readData();
        const shifts = await readShifts();
        const auditLog = await readAuditLog();
        
        // Today's shift
        const todayShift = shifts.find(s => s.shiftDate === today && s.shiftType === shiftType);
        
        // Calculate metrics
        const totalReports = Object.values(data).reduce((sum, r) => sum + (r.count || 0), 0);
        const activeUnits = Object.keys(data).filter(k => data[k].count > 0).length;
        const totalUnits = Object.keys(data).length;
        
        // Center breakdown
        const centerBreakdown = {};
        for (let key in data) {
            const parts = key.split('|');
            if (parts.length === 2) {
                const center = parts[0];
                if (!centerBreakdown[center]) centerBreakdown[center] = 0;
                centerBreakdown[center] += data[key].count;
            }
        }
        
        // Recent audit entries (last 20)
        const recentAudit = auditLog.slice(0, 20);
        
        res.json({
            success: true,
            report: {
                date: today,
                shiftType,
                totalReports,
                activeUnits,
                totalUnits,
                centerBreakdown,
                recentAudit,
                shiftData: todayShift || null
            }
        });
    } catch (error) {
        console.error('Daily report error:', error);
        res.status(500).json({ error: 'فشل في إنشاء التقرير' });
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
app.post('/api/upload-monthly-table', authenticate, upload.single('file'), handleMulterError, async (req, res) => {
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
            count: results.length
        });
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

// Alias: DELETE /api/ops-files/:id → same as /api/delete-operational/:id
app.delete('/api/ops-files/:id', authenticate, async (req, res) => {
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
app.get('/health', async (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        version: process.env.npm_package_version || '2.0.0',
        env: process.env.NODE_ENV || 'development'
    };
    res.status(200).json(health);
});

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
        const events = await readShiftEvents();
        const filtered = events.filter(e => e.shiftId === shiftId);
        res.json({ success: true, events: filtered });
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
        const events = await readShiftEvents();
        const newEvent = {
            id: Date.now().toString(),
            shiftId,
            type,
            description,
            timestamp: timestamp || new Date().toISOString(),
            createdAt: new Date().toISOString()
        };
        events.unshift(newEvent);
        await writeShiftEvents(events);
        broadcast({
            type: 'shift_event_added',
            message: 'تم إضافة حدث جديد للمناوبة',
            event: newEvent
        });
        res.json({ success: true, event: newEvent });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الحدث' });
    }
});

app.delete('/api/shift-events/:shiftId/:eventId', authenticate, async (req, res) => {
    try {
        const { shiftId, eventId } = req.params;
        const events = await readShiftEvents();
        const filtered = events.filter(e => !(e.shiftId === parseInt(shiftId) && e.id === eventId));
        await writeShiftEvents(filtered);
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
        const absences = await readShiftAbsences();
        const filtered = absences.filter(a => a.shiftId === shiftId);
        res.json({ success: true, absences: filtered });
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
        const allAbsences = await readShiftAbsences();
        const filtered = allAbsences.filter(a => a.shiftId !== shiftId);
        const newAbsences = absences.map((a, i) => ({ ...a, shiftId, id: a.id ? String(a.id) : (Date.now() + i).toString() }));
        await writeShiftAbsences([...filtered, ...newAbsences]);
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
        const absences = await readShiftAbsences();
        const filtered = absences.filter(a => !(a.shiftId === parseInt(shiftId) && a.id === absenceId));
        await writeShiftAbsences(filtered);
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
        const notes = await readShiftNotes();
        const filtered = notes.filter(n => n.shiftId === shiftId);
        res.json({ success: true, notes: filtered });
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
        const allNotes = await readShiftNotes();
        const filtered = allNotes.filter(n => n.shiftId !== shiftId);
        const newNotes = notes.map((n, i) => ({ ...n, shiftId, id: n.id ? String(n.id) : (Date.now() + i).toString() }));
        await writeShiftNotes([...filtered, ...newNotes]);
        broadcast({
            type: 'shift_note_added',
            message: 'تم تحديث سجل الملاحظات'
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملاحظة' });
    }
});

app.delete('/api/shift-notes/:shiftId/:noteId', authenticate, async (req, res) => {
    try {
        const { shiftId, noteId } = req.params;
        const notes = await readShiftNotes();
        const filtered = notes.filter(n => !(n.shiftId === parseInt(shiftId) && n.id === noteId));
        await writeShiftNotes(filtered);
        broadcast({
            type: 'shift_note_deleted',
            message: 'تم حذف ملاحظة من المناوبة',
            shiftId: parseInt(shiftId),
            noteId
        });
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
        const plans = await readPeakPlans();
        res.json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب خطط الذروة' });
    }
});

app.post('/api/peak-plans', authenticate, async (req, res) => {
    try {
        const { title, description, location, units, startTime, endTime, priority } = req.body;
        if (!title || !location) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const plans = await readPeakPlans();
        const newPlan = {
            id: Date.now().toString(),
            title,
            description: description || '',
            location,
            units: units || [],
            startTime: startTime || '',
            endTime: endTime || '',
            priority: priority || 'عادي',
            status: 'active',
            createdAt: new Date().toISOString(),
            createdBy: req.user.username || 'unknown'
        };
        plans.unshift(newPlan);
        await writePeakPlans(plans);
        broadcast({
            type: 'peak_plan_added',
            message: 'تم إضافة خطة ذروة جديدة: ' + title,
            plan: newPlan
        });
        res.json({ success: true, plan: newPlan });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ خطة الذروة' });
    }
});

app.put('/api/peak-plans/:id', authenticate, async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;
        const plans = await readPeakPlans();
        const plan = plans.find(p => p.id === id);
        if (!plan) return res.status(404).json({ error: 'الخطة غير موجودة' });
        Object.assign(plan, updates);
        await writePeakPlans(plans);
        broadcast({ type: 'peak_plan_updated', message: 'تم تحديث خطة الذروة', plan });
        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تحديث خطة الذروة' });
    }
});

app.delete('/api/peak-plans/:id', authenticate, async (req, res) => {
    try {
        const plans = await readPeakPlans();
        const filtered = plans.filter(p => p.id !== req.params.id);
        await writePeakPlans(filtered);
        broadcast({
            type: 'peak_plan_deleted',
            message: 'تم حذف خطة ذروة',
            planId: req.params.id
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف خطة الذروة' });
    }
});

// ============================================
// API: سجل التدقيق
// ============================================
app.get('/api/audit-log', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const logs = await readAuditLog();
        res.json({ success: true, logs });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجل التدقيق' });
    }
});

app.post('/api/audit-log', authenticate, async (req, res) => {
    try {
        const { action, details, category } = req.body;
        if (!action) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const logs = await readAuditLog();
        const newEntry = {
            id: Date.now().toString(),
            action,
            details: details || '',
            category: category || 'general',
            user: req.user.name || req.user.username || 'unknown',
            role: req.user.role || 'unknown',
            timestamp: new Date().toISOString()
        };
        logs.unshift(newEntry);
        if (logs.length > 500) logs.pop();
        await writeAuditLog(logs);
        broadcast({
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
// API: تسجيل البلاغات (Report Entry)
// ============================================
app.get('/api/report-entry', authenticate, async (req, res) => {
    try {
        const records = await readReportEntry();
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
        const records = await readReportEntry();
        const newRecord = {
            id: Date.now().toString(),
            ...record,
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeReportEntry(records);

        broadcast({
            type: 'report_entry_added',
            message: 'تم تسجيل بلاغ جديد',
            record: newRecord
        });

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ البلاغ' });
    }
});

app.delete('/api/report-entry/:id', authenticate, async (req, res) => {
    try {
        const records = await readReportEntry();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeReportEntry(filtered);

        broadcast({
            type: 'report_entry_deleted',
            message: 'تم حذف بلاغ',
            recordId: req.params.id
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.delete('/api/report-entry', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await writeReportEntry([]);

        broadcast({
            type: 'report_entry_cleared',
            message: 'تم حذف جميع البلاغات'
        });

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
        const id = await db.ShiftRoster.create(req.body);
        res.json({ success: true, id });
    } catch (error) {
        console.error('ShiftRoster POST error:', error);
        res.status(500).json({ error: 'فشل في إضافة سجل المناوبة' });
    }
});

app.put('/api/shift-roster/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        const result = await db.ShiftRoster.update(req.params.id, req.body);
        if (!result) return res.status(404).json({ error: 'السجل غير موجود' });
        res.json({ success: true });
    } catch (error) {
        console.error('ShiftRoster PUT error:', error);
        res.status(500).json({ error: 'فشل في تحديث سجل المناوبة' });
    }
});

app.delete('/api/shift-roster/:id', authenticate, authorize(['admin']), async (req, res) => {
    try {
        await db.ShiftRoster.delete(req.params.id);
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

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'المسار غير موجود' });
});

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
    
    // Initialize DB after server starts
    await initDatabase();
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received. Shutting down gracefully...');
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

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received. Shutting down gracefully...');
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