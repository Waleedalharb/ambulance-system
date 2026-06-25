const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// Middleware
// ============================================
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
