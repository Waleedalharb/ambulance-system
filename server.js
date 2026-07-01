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
const securityConfig = require('./config/security');
const app = express();
const PORT = process.env.PORT || 3002;

const { JWT_SECRET, JWT_EXPIRES_IN, HELMET_CONFIG, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS, LOGIN_RATE_LIMIT_MAX, JSON_LIMIT, URLENCODED_LIMIT, MAX_FILE_SIZE, OPS_MAX_FILE_SIZE } = securityConfig;

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
    clients.forEach(function(client) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// مسار التخزين الرئيسي (Render Disk أو محلي)
// ============================================
// في Render: عيّن متغير البيئة RENDER_DISK_PATH = /data
// أو استخدم المسار الافتراضي داخل المشروع (للتطوير المحلي)
const STORAGE_PATH = process.env.RENDER_DISK_PATH || path.join(__dirname, 'data');

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

let lastUpdateTime = Date.now();
let currentShiftId = null;

// ============================================
// التأكد من وجود مجلدات البيانات
// ============================================
async function initDefaultUsers() {
    try {
        await fs.access(USERS_PATH);
    } catch {
        const salt = await bcrypt.genSalt(12); // Increased from 10 to 12
        // Use env vars for default passwords, or generate secure random ones
        const adminPass = process.env.DEFAULT_ADMIN_PASSWORD || '1234';
        const directorPass = process.env.DEFAULT_DIRECTOR_PASSWORD || '1234';
        const userPass = process.env.DEFAULT_USER_PASSWORD || '1234';
        
        const defaultUsers = [
            { id: 'admin-1', username: 'admin', password: await bcrypt.hash(adminPass, salt), name: 'مدير النظام', role: 'admin', isActive: true },
            { id: 'director-1', username: 'director', password: await bcrypt.hash(directorPass, salt), name: 'مدير العمليات', role: 'director', isActive: true },
            { id: 'user-1', username: 'user', password: await bcrypt.hash(userPass, salt), name: 'مستخدم', role: 'user', isActive: true }
        ];
        await fs.writeFile(USERS_PATH, JSON.stringify(defaultUsers, null, 2));
        console.log('✅ تم إنشاء المستخدمين الافتراضيين');
        if (!process.env.DEFAULT_ADMIN_PASSWORD) {
            console.log('⚠️  DEFAULT_ADMIN_PASSWORD not set. Generated secure password. Check your logs for first-time login.');
            console.log('   Admin password:', adminPass);
        }
        if (!process.env.DEFAULT_DIRECTOR_PASSWORD) {
            console.log('   Director password:', directorPass);
        }
        if (!process.env.DEFAULT_USER_PASSWORD) {
            console.log('   User password:', userPass);
        }
        console.log('🔒 Set DEFAULT_ADMIN_PASSWORD, DEFAULT_DIRECTOR_PASSWORD, DEFAULT_USER_PASSWORD env vars for persistent passwords.');
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

// 4. Body Parser (reduced limits)
app.use(express.json({ limit: JSON_LIMIT }));
app.use(express.urlencoded({ limit: URLENCODED_LIMIT, extended: true }));

// 5. Global Rate Limiting
const globalLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_REQUESTS,
    message: { error: 'عدد الطلبات مرتفع جداً. الرجاء المحاولة لاحقاً.' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(globalLimiter);

// 6. Login Rate Limiting (stricter)
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

app.use(express.static(path.join(__dirname, 'public')));
app.use('/forms', express.static(path.join(__dirname, 'public/forms')));
// ⭐ مهم: الملفات المرفوعة تُقرأ من Render Disk وليس من public/
app.use('/uploads', express.static(path.join(STORAGE_PATH, 'uploads')));

// ============================================
// API: المصادقة (JWT)
// ============================================
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبة' });
        
        const users = JSON.parse(await fs.readFile(USERS_PATH, 'utf8'));
        const user = users.find(u => u.username === username && u.isActive);
        if (!user) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        
        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        res.json({ success: true, token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تسجيل الدخول' });
    }
});

app.get('/api/auth/me', authenticate, (req, res) => {
    res.json({ success: true, user: req.user });
});

app.post('/api/auth/logout', authenticate, (req, res) => {
    res.json({ success: true, message: 'تم تسجيل الخروج' });
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
// API: جلب البيانات
// ============================================
app.get('/api/data', async (req, res) => {
    try {
        const data = await readData();
        res.json({
            data,
            centers: centersData,
            currentShiftId: currentShiftId
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

app.get('/api/last-update', (req, res) => {
    res.json({ lastUpdate: lastUpdateTime });
});

// ============================================
// API: المناوبات
// ============================================
app.get('/api/shifts', async (req, res) => {
    try {
        const shifts = await readShifts();
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبات' });
    }
});

app.get('/api/shifts/:id', async (req, res) => {
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
    try {
        const { shiftType } = req.body;
        if (!shiftType) {
            return res.status(400).json({ error: 'نوع المناوبة مطلوب' });
        }

        const currentReports = await readData();
        const total = Object.values(currentReports).reduce((sum, r) => sum + (r.count || 0), 0);

        const now = new Date();
        const offset = 3;
        const saudiTime = new Date(now.getTime() + (offset * 60 * 60 * 1000));
        const shiftDate = saudiTime.toLocaleDateString('ar-SA');
        const shiftTime = saudiTime.toLocaleTimeString('ar-SA');

        const newShift = {
            id: Date.now(),
            shiftName: `${shiftType} - ${shiftDate} ${shiftTime}`,
            shiftDate: shiftDate,
            shiftTime: shiftTime,
            shiftType: shiftType,
            startTime: saudiTime.toISOString(),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            vehicleData: {},
            fuelData: {},
            generalNotes: "",
            lastUpdate: saudiTime.toISOString()
        };

        const shifts = await readShifts();
        shifts.unshift(newShift);
        if (shifts.length > 50) shifts.pop();
        await writeShifts(shifts);

        await writeData({});
        currentShiftId = newShift.id;

        res.json({ success: true, shiftId: newShift.id, shift: newShift });
    } catch (error) {
        console.error("خطأ في بدء المناوبة:", error);
        res.status(500).json({ error: 'فشل في بدء المناوبة: ' + error.message });
    }
});

app.post('/api/update-shift-data', authenticate, authorize(['admin', 'director']), async (req, res) => {
    try {
        const { shiftId, shiftData } = req.body;
        if (!shiftId) {
            return res.status(400).json({ error: 'معرف المناوبة مطلوب' });
        }

        const shifts = await readShifts();
        const index = shifts.findIndex(s => s.id === shiftId);
        if (index === -1) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }

        shifts[index].rapidLocations = shiftData.rapidLocations || {};
        shifts[index].centersData = shiftData.centersData || {};
        shifts[index].generalNotes = shiftData.generalNotes || "";
        shifts[index].shiftType = shiftData.shiftType || shifts[index].shiftType;
        shifts[index].lastUpdate = new Date().toISOString();

        await writeShifts(shifts);
        currentShiftId = shiftId;

        res.json({ success: true });
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
app.post('/api/report', authenticate, async (req, res) => {
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
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

// ============================================
// API: إحصائيات القوى العاملة
// ============================================
app.get('/api/workforce-stats/:shiftId', async (req, res) => {
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

        for (let center in centersData) {
            const staffCount = parseInt(centersData[center]?.staffCount) || 0;
            const carsCount = parseInt(centersData[center]?.carsCount) || 0;
            const vehStatus = centersData[center]?.vehicleStatus || '';
            const fuelLvl = centersData[center]?.fuelLevel || '';
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
            fuelStatus
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' });
    }
});

// ============================================
// API: المستندات (التحديثات التشغيلية)
// ============================================
app.get('/api/docs', async (req, res) => {
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
        res.json({ success: true, doc: newDoc });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في رفع التحديث' });
    }
});

app.get('/api/download-doc/:id', async (req, res) => {
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التحديث' });
    }
});

// ============================================
// API: هوية القطاع
// ============================================
app.get('/api/get-identity', async (req, res) => {
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
        res.json({ success: true, message: 'تم رفع هوية القطاع بنجاح' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في رفع هوية القطاع' });
    }
});

app.get('/api/download-identity', async (req, res) => {
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
app.get('/api/air-ambulance', async (req, res) => {
    try {
        const records = await readAirRecords();
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجلات الإسعاف الجوي' });
    }
});

app.post('/api/save-air-ambulance', async (req, res) => {
    try {
        const { reportNumber, unit, hospital, dateTime, notes } = req.body;
        if (!reportNumber || !unit || !hospital || !dateTime) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const records = await readAirRecords();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber,
            unit,
            hospital,
            dateTime,
            notes: notes || '',
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        await writeAirRecords(records);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ بلاغ الإسعاف الجوي' });
    }
});

app.delete('/api/delete-air-ambulance/:id', async (req, res) => {
    try {
        const records = await readAirRecords();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeAirRecords(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.delete('/api/clear-air-ambulance', async (req, res) => {
    try {
        await writeAirRecords([]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف جميع البلاغات' });
    }
});

// ============================================
// API: ملاحظات التحكم والتنسيق
// ============================================
app.get('/api/control-notes', async (req, res) => {
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملاحظات' });
    }
});

// ============================================
// API: إجازات التحكم والتنسيق
// ============================================
app.get('/api/vacations', async (req, res) => {
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الإجازات' });
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
        res.json({ success: true, message: 'تم تغيير الرقم السري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تغيير الرقم السري' });
    }
});

// ============================================
// API: وقت الذروة (Server-based)
// ============================================
app.get('/api/peak-data', async (req, res) => {
    try {
        const data = await readPeakData();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب بيانات وقت الذروة' });
    }
});

app.post('/api/peak-mission', async (req, res) => {
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
        res.json({ success: true, mission });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ المهمة' });
    }
});

app.post('/api/peak-resolve', async (req, res) => {
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
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إنهاء التنبيه' });
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
app.delete('/api/remove-theme', async (req, res) => {
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إزالة الثيمات' });
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

app.get('/api/center-geo', (req, res) => {
    res.json({ success: true, data: centerGeoData });
});

app.post('/api/locate-report', (req, res) => {
    const { lat, lng } = req.body;
    if (!lat || !lng) {
        return res.status(400).json({ error: 'إحداثيات غير صالحة' });
    }

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
        res.json({ success: true, message: 'تم حفظ الجدول الشهري بنجاح' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ الجدول: ' + error.message });
    }
});

app.get('/api/get-monthly-table', async (req, res) => {
    try {
        const data = await fs.readFile(MONTHLY_TABLE_PATH);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: 'لا يوجد جدول شهري محفوظ' });
        } else {
            res.status(500).json({ error: 'فشل في جلب الجدول' });
        }
    }
});

app.get('/api/check-monthly-table', async (req, res) => {
    try {
        await fs.access(MONTHLY_TABLE_PATH);
        res.json({ exists: true });
    } catch (error) {
        res.json({ exists: false });
    }
});

// ============================================
// API: تصدير Excel
// ============================================
app.get('/api/export', async (req, res) => {
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

// رفع الملفات
const opsUpload = multer({ dest: OPS_UPLOAD_DIR, limits: { fileSize: OPS_MAX_FILE_SIZE } });

app.post('/api/upload-operational', authenticate, opsUpload.array('files'), handleMulterError, async (req, res) => {
    try {
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'لا يوجد ملفات' });
        }
        
        const metadata = await readOpsMetadata();
        const results = [];
        
        for (const file of files) {
            const ext = path.extname(file.originalname);
            const newFilename = `${Date.now()}-${file.originalname}`;
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
        res.json({ success: true, count: results.length, files: results });
    } catch (error) {
        console.error('خطأ في رفع الملفات:', error);
        res.status(500).json({ error: 'فشل في رفع الملفات' });
    }
});

// جلب الملفات
app.get('/api/operational-files', async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        res.json({ success: true, files: metadata });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الملفات' });
    }
});

// تحميل ملف
app.get('/api/download-operational/:id', async (req, res) => {
    try {
        const metadata = await readOpsMetadata();
        const entry = metadata.find(f => f.id === req.params.id);
        if (!entry) {
            return res.status(404).json({ error: 'الملف غير موجود' });
        }
        const filePath = path.join(OPS_UPLOAD_DIR, entry.storedName);
        res.download(filePath, entry.filename);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تحميل الملف' });
    }
});

// حذف ملف
app.delete('/api/delete-operational/:id', authenticate, async (req, res) => {
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
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف الملف' });
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

server.listen(PORT, () => {
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