const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Middleware
// ============================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================
// Rate Limiter (for file access endpoints)
// ============================================
const rateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: 'طلبات كثيرة، يرجى الانتظار قليلاً' },
    standardHeaders: true,
    legacyHeaders: false,
});

const rateLimiterRead = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'طلبات كثيرة، يرجى الانتظار قليلاً' },
    standardHeaders: true,
    legacyHeaders: false,
});

// ============================================
// خدمة الملفات الثابتة - الصفحة الرئيسية
// ============================================
app.use(express.static(__dirname));

// الصفحة الرئيسية
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// أي صفحة HTML أخرى
app.get('*.html', (req, res) => {
    const filePath = path.join(__dirname, req.path);
    res.sendFile(filePath);
});

// ============================================
// مسار تخزين البيانات - Render Disk Storage
// ============================================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

console.log(`📁 مجلد البيانات: ${DATA_DIR}`);

// ============================================
// دوال التأكد من وجود المجلدات
// ============================================
async function ensureDataDir() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.mkdir(path.join(DATA_DIR, 'temp'), { recursive: true });
        await fs.mkdir(path.join(DATA_DIR, 'backups'), { recursive: true });
        console.log('✅ تم التأكد من وجود مجلدات البيانات');
    } catch (e) {
        console.error('❌ خطأ في إنشاء مجلدات البيانات:', e);
    }
}
ensureDataDir();

// ============================================
// مسارات ملفات البيانات
// ============================================
const DATA_PATH = path.join(DATA_DIR, 'ambulance-data.json');
const SHIFT_DATA_PATH = path.join(DATA_DIR, 'shift-data.json');
const MONTHLY_TABLE_PATH = path.join(DATA_DIR, 'monthly-table.xlsx');
const DOCS_PATH = path.join(DATA_DIR, 'docs.json');
const AIR_PATH = path.join(DATA_DIR, 'air-ambulance.json');
const IDENTITY_PATH = path.join(DATA_DIR, 'identity.pdf');
const CONTROL_NOTES_PATH = path.join(DATA_DIR, 'control-notes.json');
const VACATIONS_PATH = path.join(DATA_DIR, 'vacations.json');
const PASSWORD_PATH = path.join(DATA_DIR, 'password.json');
const PEAK_DATA_PATH = path.join(DATA_DIR, 'peak-data.json');
const ESCALATION_PATH = path.join(DATA_DIR, 'escalation-data.json');
const THEME_PATH = path.join(DATA_DIR, 'theme-data.json');
const CHIEF_PARAMEDICS_PATH = path.join(DATA_DIR, 'chief-paramedics.json');
const SYNC_BACKUP_PATH = path.join(DATA_DIR, 'sync-backup.json');
const BACKUP_PATH = path.join(DATA_DIR, 'backups');

let lastUpdateTime = Date.now();
let currentShiftId = null;

// ============================================
// تكوين multer لرفع الملفات
// ============================================
const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
        const tempDir = path.join(DATA_DIR, 'temp');
        try {
            await fs.mkdir(tempDir, { recursive: true });
            cb(null, tempDir);
        } catch (error) {
            cb(error, null);
        }
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: function (req, file, cb) {
        const allowedTypes = [
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
            'video/mp4', 'video/webm', 'video/quicktime',
            'application/pdf',
            'text/plain'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('نوع الملف غير مدعوم: ' + file.mimetype), false);
        }
    }
});

// ============================================
// دوال قراءة وكتابة البيانات مع Backup تلقائي
// ============================================

async function readDataFile(filePath, defaultData = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            await writeDataFile(filePath, defaultData);
            return defaultData;
        }
        throw error;
    }
}

async function writeDataFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = path.basename(filePath, path.extname(filePath));
        const backupFileName = `${fileName}_backup_${timestamp}.json`;
        const backupFilePath = path.join(BACKUP_PATH, backupFileName);

        await fs.writeFile(backupFilePath, JSON.stringify(data, null, 2));
        await cleanOldBackups(fileName);

        console.log(`✅ تم حفظ البيانات في: ${filePath}`);
        return true;
    } catch (error) {
        console.error(`❌ خطأ في حفظ البيانات ${filePath}:`, error);
        throw error;
    }
}

async function cleanOldBackups(fileName) {
    try {
        const files = await fs.readdir(BACKUP_PATH);
        const backupFiles = files
            .filter(f => f.startsWith(fileName) && f.endsWith('.json'))
            .sort()
            .reverse();

        const filesToDelete = backupFiles.slice(20);
        for (const file of filesToDelete) {
            const filePath = path.join(BACKUP_PATH, file);
            await fs.unlink(filePath);
            console.log(`🗑️ تم حذف نسخة احتياطية قديمة: ${file}`);
        }
    } catch (error) {
        console.error('⚠️ خطأ في تنظيف النسخ الاحتياطية:', error);
    }
}

// ============================================
// دوال قراءة وكتابة البيانات المحددة
// ============================================

async function readData() {
    return await readDataFile(DATA_PATH, {});
}

async function writeData(data) {
    await writeDataFile(DATA_PATH, data);
    lastUpdateTime = Date.now();
}

async function readShifts() {
    return await readDataFile(SHIFT_DATA_PATH, []);
}

async function writeShifts(data) {
    await writeDataFile(SHIFT_DATA_PATH, data);
}

async function readDocs() {
    return await readDataFile(DOCS_PATH, []);
}

async function writeDocs(data) {
    await writeDataFile(DOCS_PATH, data);
}

async function readAirRecords() {
    return await readDataFile(AIR_PATH, []);
}

async function writeAirRecords(data) {
    await writeDataFile(AIR_PATH, data);
}

async function readPeakData() {
    return await readDataFile(PEAK_DATA_PATH, { missions: [], alerts: [], logs: [] });
}

async function writePeakData(data) {
    await writeDataFile(PEAK_DATA_PATH, data);
}

async function readEscalations() {
    return await readDataFile(ESCALATION_PATH, []);
}

async function writeEscalations(data) {
    await writeDataFile(ESCALATION_PATH, data);
}

async function readPassword() {
    const data = await readDataFile(PASSWORD_PATH, { password: '1234' });
    return data.password || '1234';
}

async function writePassword(password) {
    await writeDataFile(PASSWORD_PATH, { password, updatedAt: new Date().toISOString() });
}

async function readThemeData() {
    return await readDataFile(THEME_PATH, { headerBg: null, headerBgType: null, sectorLogo: null, themeMode: 'off' });
}

async function writeThemeData(data) {
    await writeDataFile(THEME_PATH, data);
}

async function readChiefParamedics() {
    return await readDataFile(CHIEF_PARAMEDICS_PATH, []);
}

async function writeChiefParamedics(data) {
    await writeDataFile(CHIEF_PARAMEDICS_PATH, data);
}

async function readSyncBackup() {
    return await readDataFile(SYNC_BACKUP_PATH, {
        centers: {},
        reports: {},
        currentShiftId: null,
        allShifts: [],
        controlData: null,
        seniorRecords: [],
        airRecords: []
    });
}

async function writeSyncBackup(data) {
    await writeDataFile(SYNC_BACKUP_PATH, data);
}

async function readVacations() {
    return await readDataFile(VACATIONS_PATH, []);
}

async function writeVacations(data) {
    await writeDataFile(VACATIONS_PATH, data);
}

async function readDocs() {
    return await readDataFile(DOCS_PATH, []);
}

async function writeDocs(data) {
    await writeDataFile(DOCS_PATH, data);
}

async function readAirRecords() {
    return await readDataFile(AIR_PATH, []);
}

async function writeAirRecords(data) {
    await writeDataFile(AIR_PATH, data);
}

async function readPeakData() {
    return await readDataFile(PEAK_DATA_PATH, { missions: [], alerts: [], logs: [] });
}

async function writePeakData(data) {
    await writeDataFile(PEAK_DATA_PATH, data);
}

async function readEscalations() {
    return await readDataFile(ESCALATION_PATH, []);
}

async function writeEscalations(data) {
    await writeDataFile(ESCALATION_PATH, data);
}

// ============================================
// دوال مساعدة للتوقيت
// ============================================
function getLocalTime(date = new Date()) {
    const d = new Date(date);
    d.setHours(d.getHours() + 3);
    return d;
}

function formatLocalDateTime(date) {
    if (!date) return '-';
    try {
        const d = new Date(date);
        d.setHours(d.getHours() + 3);
        return d.toISOString().slice(0, 16).replace('T', ' ');
    } catch (e) { return date; }
}

function formatLocalDate(date) {
    if (!date) return '-';
    try {
        const d = new Date(date);
        d.setHours(d.getHours() + 3);
        return d.toLocaleDateString('ar-SA');
    } catch (e) { return date; }
}

function formatLocalTime(date) {
    if (!date) return '-';
    try {
        const d = new Date(date);
        d.setHours(d.getHours() + 3);
        return d.toLocaleTimeString('ar-SA');
    } catch (e) { return date; }
}

// ============================================
// API: الثيمات (مع مزامنة كاملة)
// ============================================
app.get('/api/theme', async (req, res) => {
    try {
        const data = await readThemeData();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الثيم' });
    }
});

app.get('/api/theme-settings', async (req, res) => {
    try {
        const data = await readThemeData();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب إعدادات الثيم' });
    }
});

app.post('/api/theme-settings', async (req, res) => {
    try {
        const { headerBg, headerBgType, sectorLogo, themeMode } = req.body;
        const data = { headerBg, headerBgType, sectorLogo, themeMode, updatedAt: new Date().toISOString() };
        await writeThemeData(data);
        
        // إرسال إشعار بتحديث الثيم لجميع الأجهزة
        broadcastThemeUpdate(data);
        
        res.json({ success: true, message: 'تم حفظ إعدادات الثيم ومزامنتها' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ إعدادات الثيم' });
    }
});

// ============================================
// API: كبار المسعفين
// ============================================
app.get('/api/chiefs', async (req, res) => {
    try {
        const chiefs = await readChiefParamedics();
        res.json(chiefs);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب كبار المسعفين' });
    }
});

app.post('/api/chiefs', async (req, res) => {
    try {
        const { name, sector, signature } = req.body;
        if (!name || !sector) return res.status(400).json({ error: 'بيانات ناقصة' });

        const chiefs = await readChiefParamedics();
        const newChief = {
            id: Date.now().toString(),
            name,
            sector,
            signature: signature || null,
            date: new Date().toISOString(),
            dateDisplay: formatLocalDateTime(new Date())
        };
        
        chiefs.unshift(newChief);
        if (chiefs.length > 100) chiefs.pop();
        
        await writeChiefParamedics(chiefs);
        res.json({ success: true, chief: newChief });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ كبير المسعفين' });
    }
});

app.delete('/api/chiefs/:id', async (req, res) => {
    try {
        const chiefs = await readChiefParamedics();
        const filtered = chiefs.filter(c => c.id !== req.params.id);
        await writeChiefParamedics(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف كبير المسعفين' });
    }
});

// ============================================
// API: المزامنة الشاملة
// ============================================
app.get('/api/sync-all', async (req, res) => {
    try {
        const syncData = {
            themeData: await readThemeData(),
            chiefs: await readChiefParamedics(),
            shifts: await readShifts(),
            timestamp: new Date().toISOString()
        };
        res.json(syncData);
    } catch (error) {
        res.status(500).json({ error: 'فشل في المزامنة' });
    }
});

// ============================================
// API: المناوبات (باقي الكود السابق)
// ============================================
app.get('/api/shifts', async (req, res) => {
    try {
        const shifts = await readShifts();
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبات' });
    }
});

// ============================================
// Server-Sent Events للمزامنة
// ============================================
let themeUpdateClients = [];

app.get('/api/theme-updates', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const clientId = Date.now();
    const newClient = { id: clientId, res: res };
    themeUpdateClients.push(newClient);
    
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'متصل بنظام المزامنة' })}\n\n`);
    
    req.on('close', () => {
        themeUpdateClients = themeUpdateClients.filter(client => client.id !== clientId);
    });
});

function broadcastThemeUpdate(themeData) {
    const eventData = { type: 'theme_updated', data: themeData, timestamp: new Date().toISOString() };
    themeUpdateClients.forEach(client => {
        try {
            client.res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        } catch (error) { }
    });
}

// ============================================
// API: البيانات الرئيسية
// ============================================
app.get('/api/data', async (req, res) => {
    try {
        const reports = await readData();
        const backup = await readSyncBackup();
        res.json({
            data: reports,
            centers: backup.centers || {},
            currentShiftId: backup.currentShiftId || null,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('خطأ في /api/data:', error);
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

// ============================================
// API: النسخ الاحتياطي والمزامنة
// ============================================
app.post('/api/sync-backup', async (req, res) => {
    try {
        const backupData = req.body;
        if (backupData.reports) {
            await writeData(backupData.reports);
        }
        await writeSyncBackup({
            centers: backupData.centers || {},
            reports: backupData.reports || {},
            currentShiftId: backupData.currentShiftId || null,
            allShifts: backupData.allShifts || [],
            controlData: backupData.controlData || null,
            seniorRecords: backupData.seniorRecords || [],
            airRecords: backupData.airRecords || [],
            savedAt: new Date().toISOString()
        });
        res.json({ success: true, message: 'تم حفظ البيانات' });
    } catch (error) {
        console.error('خطأ في /api/sync-backup:', error);
        res.status(500).json({ error: 'فشل في حفظ النسخة الاحتياطية' });
    }
});

app.get('/api/restore-backup', async (req, res) => {
    try {
        const backup = await readSyncBackup();
        res.json({ success: true, data: backup });
    } catch (error) {
        console.error('خطأ في /api/restore-backup:', error);
        res.status(500).json({ error: 'فشل في استعادة البيانات' });
    }
});

// ============================================
// API: آخر تحديث
// ============================================
app.get('/api/last-update', (req, res) => {
    res.json({ lastUpdate: lastUpdateTime });
});

// ============================================
// API: البلاغات
// ============================================
app.post('/api/report', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    const key = `${center}|${unit}`;
    try {
        const allData = await readData();
        if (!allData[key]) allData[key] = { count: 0, times: [] };
        allData[key].count++;
        const timestamp = formatLocalDateTime(new Date());
        allData[key].times.unshift(timestamp);
        if (allData[key].times.length > 10) allData[key].times.pop();
        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        console.error('خطأ في /api/report:', error);
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

app.post('/api/undo', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }
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
        console.error('خطأ في /api/undo:', error);
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

// ============================================
// API: المناوبات (إضافة عمليات متقدمة)
// ============================================
app.get('/api/shifts/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const shiftId = parseInt(req.params.id);
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        res.json({ shift, reports: shift.savedReports || {}, total: shift.totalReports || 0 });
    } catch (error) {
        console.error('خطأ في /api/shifts/:id:', error);
        res.status(500).json({ error: 'فشل في جلب المناوبة' });
    }
});

app.post('/api/start-new-shift', async (req, res) => {
    try {
        const { shiftType } = req.body;
        if (!shiftType) {
            return res.status(400).json({ error: 'نوع المناوبة مطلوب' });
        }
        const currentReports = await readData();
        const total = Object.values(currentReports).reduce((sum, r) => sum + (r.count || 0), 0);
        const now = new Date();
        const newShift = {
            id: Date.now(),
            shiftName: `${shiftType} - ${formatLocalDate(now)} ${formatLocalTime(now)}`,
            shiftDate: formatLocalDate(now),
            shiftTime: formatLocalTime(now),
            shiftType,
            startTime: now.toISOString(),
            startTimeDisplay: formatLocalDateTime(now),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            generalNotes: '',
            lastUpdate: now.toISOString()
        };
        const shifts = await readShifts();
        shifts.unshift(newShift);
        if (shifts.length > 50) shifts.pop();
        await writeShifts(shifts);
        await writeData({});
        res.json({ success: true, shiftId: newShift.id, shift: newShift });
    } catch (error) {
        console.error('خطأ في /api/start-new-shift:', error);
        res.status(500).json({ error: 'فشل في بدء المناوبة: ' + error.message });
    }
});

app.post('/api/update-shift-data', async (req, res) => {
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
        shifts[index].generalNotes = shiftData.generalNotes || '';
        shifts[index].shiftType = shiftData.shiftType || shifts[index].shiftType;
        shifts[index].lastUpdate = new Date().toISOString();
        await writeShifts(shifts);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في /api/update-shift-data:', error);
        res.status(500).json({ error: 'فشل في تحديث بيانات المناوبة' });
    }
});

app.delete('/api/shifts/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const id = parseInt(req.params.id);
        const filtered = shifts.filter(s => s.id !== id);
        await writeShifts(filtered);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في DELETE /api/shifts/:id:', error);
        res.status(500).json({ error: 'فشل في حذف المناوبة' });
    }
});

// إحصائيات القوى العاملة لمناوبة محددة
app.get('/api/workforce-stats/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const shiftId = parseInt(req.params.id);
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        const centersDataMap = shift.centersData || {};
        let totalStaff = 0, totalCars = 0, missingCenters = 0, readyCenters = 0, centerCount = 0;
        const distribution = {}, carDistribution = {};
        for (let center in centersDataMap) {
            const staffCount = parseInt(centersDataMap[center]?.staffCount) || 0;
            const carsCount = parseInt(centersDataMap[center]?.carsCount) || 0;
            totalStaff += staffCount;
            totalCars += carsCount;
            centerCount++;
            if (staffCount >= 2 && carsCount >= 1) readyCenters++; else missingCenters++;
            distribution[center] = staffCount;
            carDistribution[center] = carsCount;
        }
        const readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
        res.json({ totalStaff, totalCars, missingCenters, readyCenters, centerCount, readinessRate, distribution, carDistribution });
    } catch (error) {
        console.error('خطأ في /api/workforce-stats/:id:', error);
        res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' });
    }
});

// ============================================
// API: التحديثات التشغيلية (Docs)
// ============================================
app.get('/api/docs', async (req, res) => {
    try {
        const docs = await readDocs();
        res.json({ success: true, docs });
    } catch (error) {
        console.error('خطأ في GET /api/docs:', error);
        res.status(500).json({ error: 'فشل في جلب التحديثات' });
    }
});

app.post('/api/docs', async (req, res) => {
    try {
        const { filename, fileData, description, fileType, category, priority, uploader } = req.body;
        if (!filename || !fileData) {
            return res.status(400).json({ error: 'بيانات ناقصة: اسم الملف ومحتواه مطلوبان' });
        }
        const docs = await readDocs();
        const newDoc = {
            id: Date.now().toString(),
            filename, fileData,
            fileType: fileType || 'application/octet-stream',
            description: description || '',
            category: category || 'أخرى',
            priority: priority || 'normal',
            uploader: uploader || 'المشرف',
            uploadDate: new Date().toISOString(),
            uploadDateDisplay: formatLocalDateTime(new Date())
        };
        docs.push(newDoc);
        await writeDocs(docs);
        res.json({ success: true, doc: newDoc });
    } catch (error) {
        console.error('خطأ في POST /api/docs:', error);
        res.status(500).json({ error: 'فشل في رفع التحديث' });
    }
});

app.delete('/api/delete-doc/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const filtered = docs.filter(d => d.id !== req.params.id);
        await writeDocs(filtered);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في DELETE /api/delete-doc/:id:', error);
        res.status(500).json({ error: 'فشل في حذف التحديث' });
    }
});

app.get('/api/download-doc/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const doc = docs.find(d => d.id === req.params.id);
        if (!doc) return res.status(404).json({ error: 'التحديث غير موجود' });
        const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
        const contentType = ALLOWED_TYPES.includes(doc.fileType) ? doc.fileType : 'application/octet-stream';
        const buffer = Buffer.from(doc.fileData, 'base64');
        if (buffer.length > MAX_FILE_SIZE) return res.status(413).json({ error: 'حجم الملف كبير جداً' });
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.filename)}"`);
        res.send(buffer);
    } catch (error) {
        console.error('خطأ في /api/download-doc/:id:', error);
        res.status(500).json({ error: 'فشل في تحميل التحديث' });
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
        console.error('خطأ في GET /api/air-ambulance:', error);
        res.status(500).json({ error: 'فشل في جلب سجلات الإسعاف الجوي' });
    }
});

app.post('/api/air-ambulance', async (req, res) => {
    try {
        const { reportNumber, unit, hospital, dateTime, notes } = req.body;
        const records = await readAirRecords();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber: reportNumber || '',
            unit: unit || '',
            hospital: hospital || '',
            dateTime: dateTime || new Date().toISOString(),
            notes: notes || '',
            createdAt: new Date().toISOString()
        };
        records.unshift(newRecord);
        if (records.length > 100) records.pop();
        await writeAirRecords(records);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error('خطأ في POST /api/air-ambulance:', error);
        res.status(500).json({ error: 'فشل في حفظ سجل الإسعاف الجوي' });
    }
});

app.delete('/api/delete-air-ambulance/:id', async (req, res) => {
    try {
        const records = await readAirRecords();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeAirRecords(filtered);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في DELETE /api/delete-air-ambulance/:id:', error);
        res.status(500).json({ error: 'فشل في حذف السجل' });
    }
});

// ============================================
// API: وقت الذروة
// ============================================
app.get('/api/peak-data', async (req, res) => {
    try {
        const data = await readPeakData();
        res.json({ success: true, data });
    } catch (error) {
        console.error('خطأ في GET /api/peak-data:', error);
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
        const now = new Date();
        const mission = {
            id: Date.now().toString(),
            location, unit,
            lat: lat || null, lng: lng || null,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            startTimeDisplay: formatLocalDateTime(new Date(startTime)),
            endTimeDisplay: formatLocalDateTime(new Date(endTime)),
            priority: priority || 'عالية',
            notes: notes || '',
            status: 'نشط',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
        };
        data.missions.unshift(mission);
        if (data.missions.length > 100) data.missions.pop();
        const alertData = {
            id: Date.now().toString(),
            title: `تمركز مطلوب لـ ${unit}`,
            details: `${unit} في ${location} (${formatLocalDateTime(new Date(startTime))} - ${formatLocalDateTime(new Date(endTime))})`,
            priority: priority || 'عالية',
            unit, location,
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            startTimeDisplay: formatLocalDateTime(new Date(startTime)),
            endTimeDisplay: formatLocalDateTime(new Date(endTime)),
            notes: notes || '',
            lat: lat || null, lng: lng || null,
            radius: 5000,
            missionId: mission.id,
            status: 'نشط',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now),
            read: false
        };
        data.alerts.unshift(alertData);
        if (data.alerts.length > 50) data.alerts.pop();
        data.logs = data.logs || [];
        data.logs.unshift({
            id: Date.now().toString(),
            icon: '🟡', action: 'مهمة جديدة',
            details: `${unit} في ${location}`,
            priority: priority || 'عادي',
            time: formatLocalTime(now), date: formatLocalDate(now), fullDate: now.toISOString()
        });
        if (data.logs.length > 50) data.logs.pop();
        await writePeakData(data);
        broadcastPeakAlert(alertData);
        res.json({ success: true, mission });
    } catch (error) {
        console.error('خطأ في POST /api/peak-mission:', error);
        res.status(500).json({ error: 'فشل في حفظ المهمة' });
    }
});

app.post('/api/peak-resolve', async (req, res) => {
    try {
        const { alertId } = req.body;
        if (!alertId) return res.status(400).json({ error: 'معرف التنبيه مطلوب' });
        const data = await readPeakData();
        const alert = data.alerts.find(a => a.id === alertId);
        if (alert) {
            alert.status = 'منتهي';
            alert.resolvedAt = new Date().toISOString();
            alert.resolvedAtDisplay = formatLocalDateTime(new Date());
            data.logs = data.logs || [];
            data.logs.unshift({
                id: Date.now().toString(),
                icon: '✅', action: 'تم التنفيذ', details: alert.details,
                priority: alert.priority || 'عادي',
                time: formatLocalTime(new Date()), date: formatLocalDate(new Date()),
                fullDate: new Date().toISOString()
            });
            if (data.logs.length > 50) data.logs.pop();
            await writePeakData(data);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في POST /api/peak-resolve:', error);
        res.status(500).json({ error: 'فشل في إنهاء التنبيه' });
    }
});

// SSE لتحديثات وقت الذروة
let peakEventClients = [];

app.get('/api/peak-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const clientId = Date.now();
    peakEventClients.push({ id: clientId, res });
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    req.on('close', () => {
        peakEventClients = peakEventClients.filter(c => c.id !== clientId);
    });
});

function broadcastPeakAlert(alertData) {
    const eventData = JSON.stringify({ type: 'new_peak_alert', data: alertData });
    const deadClients = [];
    peakEventClients.forEach(client => {
        try { client.res.write(`data: ${eventData}\n\n`); } catch (e) {
            console.error('خطأ في إرسال تنبيه SSE:', e.message);
            deadClients.push(client.id);
        }
    });
    if (deadClients.length > 0) {
        peakEventClients = peakEventClients.filter(c => !deadClients.includes(c.id));
    }
}

// ============================================
// API: التصعيد
// ============================================
app.get('/api/escalation', async (req, res) => {
    try {
        const escalations = await readEscalations();
        res.json({ success: true, escalations });
    } catch (error) {
        console.error('خطأ في GET /api/escalation:', error);
        res.status(500).json({ error: 'فشل في جلب التصعيدات' });
    }
});

app.post('/api/escalation', async (req, res) => {
    try {
        const data = req.body;
        const escalations = await readEscalations();
        const newEscalation = {
            id: Date.now().toString(),
            ...data,
            createdAt: new Date().toISOString(),
            createdAtDisplay: formatLocalDateTime(new Date()),
            status: 'نشط'
        };
        escalations.unshift(newEscalation);
        if (escalations.length > 100) escalations.pop();
        await writeEscalations(escalations);
        res.json({ success: true, escalation: newEscalation });
    } catch (error) {
        console.error('خطأ في POST /api/escalation:', error);
        res.status(500).json({ error: 'فشل في حفظ التصعيد' });
    }
});

app.post('/api/escalation-alert', async (req, res) => {
    try {
        res.json({ success: true, message: 'تم إرسال التنبيه' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إرسال التنبيه' });
    }
});

// ============================================
// API: الجدول الشهري
// ============================================
app.get('/api/check-monthly-table', rateLimiterRead, async (req, res) => {
    try {
        await fs.access(MONTHLY_TABLE_PATH);
        res.json({ exists: true });
    } catch {
        res.json({ exists: false });
    }
});

app.get('/api/get-monthly-table', rateLimiterRead, async (req, res) => {
    try {
        const data = await fs.readFile(MONTHLY_TABLE_PATH);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="monthly-table.xlsx"');
        res.send(data);
    } catch (error) {
        res.status(404).json({ error: 'الجدول غير موجود' });
    }
});

app.post('/api/upload-monthly-table', rateLimiter, async (req, res) => {
    try {
        const { fileData } = req.body;
        if (!fileData) return res.status(400).json({ error: 'بيانات ناقصة' });
        const buffer = Buffer.from(fileData, 'base64');
        if (buffer.length > MAX_FILE_SIZE) return res.status(413).json({ error: 'حجم الملف كبير جداً (الحد الأقصى 10 ميجابايت)' });
        await fs.writeFile(MONTHLY_TABLE_PATH, buffer);
        res.json({ success: true, message: 'تم رفع الجدول بنجاح' });
    } catch (error) {
        console.error('خطأ في POST /api/upload-monthly-table:', error);
        res.status(500).json({ error: 'فشل في رفع الجدول' });
    }
});

// ============================================
// API: الإجازات
// ============================================
app.get('/api/vacations', async (req, res) => {
    try {
        const vacations = await readVacations();
        res.json({ success: true, vacations });
    } catch (error) {
        console.error('خطأ في GET /api/vacations:', error);
        res.status(500).json({ error: 'فشل في جلب الإجازات' });
    }
});

app.post('/api/save-vacations', async (req, res) => {
    try {
        const { vacations } = req.body;
        await writeVacations(vacations || []);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في POST /api/save-vacations:', error);
        res.status(500).json({ error: 'فشل في حفظ الإجازات' });
    }
});

// ============================================
// API: كلمة المرور
// ============================================
app.get('/api/get-password', async (req, res) => {
    try {
        const password = await readPassword();
        res.json({ success: true, password });
    } catch (error) {
        console.error('خطأ في GET /api/get-password:', error);
        res.status(500).json({ error: 'فشل في جلب كلمة المرور' });
    }
});

app.post('/api/change-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const currentPassword = await readPassword();
        if (oldPassword !== currentPassword) {
            return res.status(401).json({ error: 'كلمة المرور القديمة غير صحيحة' });
        }
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ error: 'كلمة المرور الجديدة يجب أن تكون 4 أحرف على الأقل' });
        }
        await writePassword(newPassword);
        res.json({ success: true });
    } catch (error) {
        console.error('خطأ في POST /api/change-password:', error);
        res.status(500).json({ error: 'فشل في تغيير كلمة المرور' });
    }
});

// ============================================
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار البيانات: ${DATA_DIR}`);
    console.log(`✅ APIs المتاحة:`);
    console.log(`   - GET  /api/theme - جلب الثيمات`);
    console.log(`   - POST /api/theme-settings - حفظ الثيمات`);
    console.log(`   - GET  /api/chiefs - جلب كبار المسعفين`);
    console.log(`   - POST /api/chiefs - إضافة كبير مسعفين`);
    console.log(`   - GET  /api/sync-all - مزامنة جميع البيانات`);
    console.log(`   - GET  /api/theme-updates - SSE للمزامنة الفورية`);
});
