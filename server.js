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
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
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
// بيانات قطاع الجنوب
// ============================================
const centersData = {
    "جنوب": [
        "جنوب 1", "جنوب 2", "جنوب 3", "جنوب 4", "جنوب 5",
        "جنوب 6", "جنوب 7", "جنوب 8", "جنوب 9", "جنوب 10",
        "جنوب 11", "جنوب 12", "جنوب 13", "جنوب 14", "جنوب 15",
        "جنوب 16", "جنوب 17", "جنوب 18", "جنوب 19"
    ],
    "سريع": [
        "سريع 1", "سريع 2", "سريع 3", "سريع 4"
    ]
};

// ============================================
// البيانات الجغرافية للمراكز
// ============================================
const centerGeoData = {
    "جنوب 1": { center: [24.7136, 46.6753], radius: 5000, address: "طريق الملك فهد، الرياض" },
    "جنوب 2": { center: [24.7000, 46.6600], radius: 4000, address: "حي المنصورة، الرياض" },
    "جنوب 3": { center: [24.6850, 46.6450], radius: 3500, address: "الخالدية، الرياض" },
    "جنوب 4": { center: [24.7200, 46.6900], radius: 4500, address: "الدار البيضاء، الرياض" },
    "جنوب 5": { center: [24.7300, 46.7000], radius: 4000, address: "الدار البيضاء، الرياض" },
    "جنوب 6": { center: [24.6700, 46.6400], radius: 3500, address: "الإسكان، الرياض" },
    "جنوب 7": { center: [24.6500, 46.6200], radius: 4000, address: "الحائر، الرياض" },
    "جنوب 8": { center: [24.6900, 46.6600], radius: 3500, address: "الشفاء، الرياض" },
    "جنوب 9": { center: [24.7050, 46.6800], radius: 3000, address: "عكاظ، الرياض" },
    "جنوب 10": { center: [24.6600, 46.6100], radius: 4500, address: "ديراب، الرياض" },
    "جنوب 11": { center: [24.7150, 46.6850], radius: 4000, address: "المنصورة، الرياض" },
    "جنوب 12": { center: [24.7250, 46.6950], radius: 4000, address: "المنصورة، الرياض" },
    "جنوب 13": { center: [24.7350, 46.7050], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "جنوب 14": { center: [24.7400, 46.7100], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "جنوب 15": { center: [24.7450, 46.7150], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "جنوب 16": { center: [24.7500, 46.7200], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "جنوب 17": { center: [24.7550, 46.7250], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "جنوب 18": { center: [24.7600, 46.7300], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "جنوب 19": { center: [24.7650, 46.7350], radius: 4000, address: "الفرق الإضافية، الرياض" },
    "سريع 1": { center: [24.7100, 46.6850], radius: 8000, address: "مستشفى الملك خالد، الرياض" },
    "سريع 2": { center: [24.6900, 46.6600], radius: 7000, address: "الشفاء، الرياض" },
    "سريع 3": { center: [24.7000, 46.6700], radius: 6000, address: "المنصورة، الرياض" },
    "سريع 4": { center: [24.7200, 46.6800], radius: 7000, address: "الفرق الإضافية، الرياض" }
};

// ============================================
// Server-Sent Events للإشعارات اللحظية
// ============================================
let peakEventClients = [];

app.get('/api/peak-events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const clientId = Date.now();
    const newClient = { id: clientId, res: res };
    peakEventClients.push(newClient);
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'متصل بنظام الإشعارات', timestamp: new Date().toISOString() })}\n\n`);
    req.on('close', () => { peakEventClients = peakEventClients.filter(client => client.id !== clientId); });
});

function sendPeakNotification(alertData, type = 'new_peak_alert') {
    const eventData = { type, alert: alertData, timestamp: new Date().toISOString(), timestampDisplay: formatLocalDateTime(new Date()) };
    peakEventClients.forEach(client => { try { client.res.write(`data: ${JSON.stringify(eventData)}\n\n`); } catch (error) { } });
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c * 1000;
}

// ============================================
// API: جلب البيانات
// ============================================
app.get('/api/data', async (req, res) => {
    try { const data = await readData(); res.json({ data, centers: centersData, currentShiftId }); } catch (error) { res.status(500).json({ error: 'فشل في جلب البيانات' }); }
});

app.get('/api/last-update', (req, res) => { res.json({ lastUpdate: lastUpdateTime }); });

// ============================================
// API: المناوبات
// ============================================
app.get('/api/shifts', async (req, res) => {
    try { const shifts = await readShifts(); res.json(shifts); } catch (error) { res.status(500).json({ error: 'فشل في جلب المناوبات' }); }
});

app.get('/api/shifts/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const shiftId = parseInt(req.params.id);
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) return res.status(404).json({ error: 'المناوبة غير موجودة' });
        res.json({ shift, reports: shift.savedReports || {}, total: shift.totalReports || 0 });
    } catch (error) { res.status(500).json({ error: 'فشل في جلب المناوبة' }); }
});

app.post('/api/start-new-shift', async (req, res) => {
    try {
        const { shiftType } = req.body;
        if (!shiftType) return res.status(400).json({ error: 'نوع المناوبة مطلوب' });
        const currentReports = await readData();
        const total = Object.values(currentReports).reduce((sum, r) => sum + (r.count || 0), 0);
        const now = new Date();
        const shiftDate = formatLocalDate(now);
        const shiftTime = formatLocalTime(now);
        const newShift = {
            id: Date.now(),
            shiftName: `${shiftType} - ${shiftDate} ${shiftTime}`,
            shiftDate, shiftTime, shiftType,
            startTime: now.toISOString(),
            startTimeDisplay: formatLocalDateTime(now),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {}, centersData: {}, generalNotes: "",
            lastUpdate: now.toISOString()
        };
        const shifts = await readShifts();
        shifts.unshift(newShift);
        if (shifts.length > 50) shifts.pop();
        await writeShifts(shifts);
        await writeData({});
        currentShiftId = newShift.id;
        res.json({ success: true, shiftId: newShift.id, shift: newShift });
    } catch (error) { res.status(500).json({ error: 'فشل في بدء المناوبة: ' + error.message }); }
});

app.post('/api/update-shift-data', async (req, res) => {
    try {
        const { shiftId, shiftData } = req.body;
        if (!shiftId) return res.status(400).json({ error: 'معرف المناوبة مطلوب' });
        const shifts = await readShifts();
        const index = shifts.findIndex(s => s.id === shiftId);
        if (index === -1) return res.status(404).json({ error: 'المناوبة غير موجودة' });
        shifts[index].rapidLocations = shiftData.rapidLocations || {};
        shifts[index].centersData = shiftData.centersData || {};
        shifts[index].generalNotes = shiftData.generalNotes || "";
        shifts[index].shiftType = shiftData.shiftType || shifts[index].shiftType;
        shifts[index].lastUpdate = new Date().toISOString();
        await writeShifts(shifts);
        currentShiftId = shiftId;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'فشل في تحديث بيانات المناوبة' }); }
});

app.delete('/api/shifts/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const id = parseInt(req.params.id);
        const filtered = shifts.filter(s => s.id !== id);
        await writeShifts(filtered);
        if (currentShiftId === id) currentShiftId = null;
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'فشل في حذف المناوبة' }); }
});

// ============================================
// API: البلاغات
// ============================================
app.post('/api/report', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });
    const key = `${center}|${unit}`;
    const now = new Date();
    const localNow = getLocalTime(now);
    const timestamp = `${localNow.getUTCFullYear()}-${(localNow.getUTCMonth() + 1).toString().padStart(2, '0')}-${localNow.getUTCDate().toString().padStart(2, '0')} ${localNow.getUTCHours().toString().padStart(2, '0')}:${localNow.getUTCMinutes().toString().padStart(2, '0')}:${localNow.getUTCSeconds().toString().padStart(2, '0')}`;
    try {
        const allData = await readData();
        if (!allData[key]) allData[key] = { count: 0, times: [] };
        allData[key].count++;
        allData[key].times.unshift(timestamp);
        if (allData[key].times.length > 10) allData[key].times.pop();
        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) { res.status(500).json({ error: 'فشل في تسجيل البلاغ' }); }
});

app.post('/api/undo', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });
    const key = `${center}|${unit}`;
    try {
        const allData = await readData();
        if (!allData[key] || allData[key].count === 0) return res.status(400).json({ error: 'لا يوجد بلاغات للحذف' });
        allData[key].count--;
        allData[key].times.shift();
        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) { res.status(500).json({ error: 'فشل في حذف البلاغ' }); }
});

// ============================================
// API: إحصائيات القوى العاملة
// ============================================
app.get('/api/workforce-stats/:shiftId', async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const shifts = await readShifts();
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) return res.status(404).json({ error: 'المناوبة غير موجودة' });
        const centersData = shift.centersData || {};
        let totalStaff = 0, totalCars = 0, missingCenters = 0, readyCenters = 0, centerCount = 0;
        const distribution = {}, carDistribution = {};
        for (let center in centersData) {
            const staffCount = parseInt(centersData[center]?.staffCount) || 0;
            const carsCount = parseInt(centersData[center]?.carsCount) || 0;
            totalStaff += staffCount; totalCars += carsCount; centerCount++;
            if (staffCount >= 2 && carsCount >= 1) readyCenters++; else missingCenters++;
            distribution[center] = staffCount; carDistribution[center] = carsCount;
        }
        const readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
        res.json({ totalStaff, totalCars, missingCenters, readyCenters, centerCount, readinessRate, distribution, carDistribution });
    } catch (error) { res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' }); }
});

// ============================================
// API: المستندات (التحديثات التشغيلية)
// ============================================
app.get('/api/docs', async (req, res) => {
    try { const docs = await readDocs(); res.json({ success: true, docs }); } catch (error) { res.status(500).json({ error: 'فشل في جلب التحديثات' }); }
});

app.post('/api/upload-doc', async (req, res) => {
    try {
        const { filename, fileData, description, fileType, category, priority } = req.body;
        if (!filename || !fileData) return res.status(400).json({ error: 'بيانات ناقصة' });
        const docs = await readDocs();
        const newDoc = {
            id: Date.now().toString(), filename, fileData, fileType: fileType || 'application/octet-stream',
            description: description || '', category: category || 'أخرى', priority: priority || 'normal',
            uploader: req.body.uploader || 'المشرف', uploadDate: new Date().toISOString(),
            uploadDateDisplay: formatLocalDateTime(new Date())
        };
        docs.push(newDoc);
        await writeDocs(docs);
        res.json({ success: true, doc: newDoc });
    } catch (error) { res.status(500).json({ error: 'فشل في رفع التحديث' }); }
});

app.get('/api/download-doc/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const doc = docs.find(d => d.id === req.params.id);
        if (!doc) return res.status(404).json({ error: 'التحديث غير موجود' });
        const buffer = Buffer.from(doc.fileData, 'base64');
        res.setHeader('Content-Type', doc.fileType);
        res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
        res.send(buffer);
    } catch (error) { res.status(500).json({ error: 'فشل في تحميل التحديث' }); }
});

app.delete('/api/delete-doc/:id', async (req, res) => {
    try { const docs = await readDocs(); const filtered = docs.filter(d => d.id !== req.params.id); await writeDocs(filtered); res.json({ success: true }); } catch (error) { res.status(500).json({ error: 'فشل في حذف التحديث' }); }
});

// ============================================
// API: هوية القطاع
// ============================================
app.get('/api/get-identity', async (req, res) => {
    try { await fs.access(IDENTITY_PATH); res.json({ exists: true }); } catch (error) { res.json({ exists: false }); }
});

app.post('/api/upload-identity', async (req, res) => {
    try {
        const { fileData } = req.body;
        if (!fileData) return res.status(400).json({ error: 'بيانات ناقصة' });
        const buffer = Buffer.from(fileData, 'base64');
        await fs.writeFile(IDENTITY_PATH, buffer);
        res.json({ success: true, message: 'تم رفع هوية القطاع بنجاح' });
    } catch (error) { res.status(500).json({ error: 'فشل في رفع هوية القطاع' }); }
});

app.get('/api/download-identity', async (req, res) => {
    try {
        const data = await fs.readFile(IDENTITY_PATH);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="identity.pdf"');
        res.send(data);
    } catch (error) { res.status(404).json({ error: 'لا توجد هوية محفوظة' }); }
});

// ============================================
// API: الإسعاف الجوي
// ============================================
app.get('/api/air-ambulance', async (req, res) => {
    try { const records = await readAirRecords(); res.json({ success: true, records }); } catch (error) { res.status(500).json({ error: 'فشل في جلب سجلات الإسعاف الجوي' }); }
});

app.post('/api/save-air-ambulance', async (req, res) => {
    try {
        const { reportNumber, unit, hospital, dateTime, notes } = req.body;
        if (!reportNumber || !unit || !hospital || !dateTime) return res.status(400).json({ error: 'بيانات ناقصة' });
        const records = await readAirRecords();
        const now = new Date();
        const newRecord = {
            id: Date.now().toString(), reportNumber, unit, hospital, dateTime,
            dateTimeDisplay: formatLocalDateTime(new Date(dateTime)),
            notes: notes || '', createdAt: now.toISOString(), createdAtDisplay: formatLocalDateTime(now)
        };
        records.unshift(newRecord);
        await writeAirRecords(records);
        res.json({ success: true, record: newRecord });
    } catch (error) { res.status(500).json({ error: 'فشل في حفظ بلاغ الإسعاف الجوي' }); }
});

app.delete('/api/delete-air-ambulance/:id', async (req, res) => {
    try { const records = await readAirRecords(); const filtered = records.filter(r => r.id !== req.params.id); await writeAirRecords(filtered); res.json({ success: true }); } catch (error) { res.status(500).json({ error: 'فشل في حذف البلاغ' }); }
});

app.delete('/api/clear-air-ambulance', async (req, res) => {
    try { await writeAirRecords([]); res.json({ success: true }); } catch (error) { res.status(500).json({ error: 'فشل في حذف جميع البلاغات' }); }
});

// ============================================
// API: التصعيد
// ============================================
app.get('/api/escalation', async (req, res) => {
    try { const records = await readEscalations(); res.json({ success: true, records }); } catch (error) { res.status(500).json({ error: 'فشل في جلب سجل التصعيدات' }); }
});

app.post('/api/escalation', async (req, res) => {
    try {
        const { reportNumber, type, level, casualties, time, location, lat, lng, description, responseTime, agencies, fileData, fileType } = req.body;
        if (!reportNumber || !type || !level || !time) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        const records = await readEscalations();
        const now = new Date();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber,
            type,
            level,
            casualties: parseInt(casualties) || 0,
            time,
            location: location || '',
            lat: lat || null,
            lng: lng || null,
            description: description || '',
            responseTime: responseTime || '',
            agencies: agencies || [],
            fileData: fileData || null,
            fileType: fileType || null,
            status: 'جديد',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
        };
        records.unshift(newRecord);
        await writeEscalations(records);

        if (level === 'عاجل جداً' || level === 'عالي') {
            sendPeakNotification({
                title: `تصعيد عاجل: ${type}`,
                details: `المستوى: ${level} | المصابين: ${casualties}${location ? ' | الموقع: ' + location : ''}`,
                level: level,
                type: type,
                location: location || 'غير محدد',
                casualties: casualties,
                reportNumber: reportNumber
            }, 'new_escalation_alert');
        }

        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ التصعيد' });
    }
});

app.delete('/api/escalation/:id', async (req, res) => {
    try {
        const records = await readEscalations();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeEscalations(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التصعيد' });
    }
});

app.post('/api/escalation-alert', async (req, res) => {
    try {
        const { record } = req.body;
        if (!record) return res.status(400).json({ error: 'بيانات ناقصة' });
        sendPeakNotification({
            title: `استدعاء فوري: ${record.type}`,
            details: `المستوى: ${record.level} | المصابين: ${record.casualties}${record.location ? ' | الموقع: ' + record.location : ''}`,
            level: record.level,
            type: record.type,
            location: record.location || 'غير محدد',
            casualties: record.casualties,
            reportNumber: record.reportNumber
        }, 'urgent_escalation_call');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إرسال التنبيه' });
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
        if (error.code === 'ENOENT') res.json({ success: true, notes: '' });
        else res.status(500).json({ error: 'فشل في جلب الملاحظات' });
    }
});

app.post('/api/save-control-notes', async (req, res) => {
    try {
        const { notes } = req.body;
        await fs.writeFile(CONTROL_NOTES_PATH, JSON.stringify({ notes, updatedAt: new Date().toISOString() }));
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'فشل في حفظ الملاحظات' }); }
});

// ============================================
// API: إجازات التحكم والتنسيق
// ============================================
app.get('/api/vacations', async (req, res) => {
    try {
        const data = await fs.readFile(VACATIONS_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') res.json([]);
        else res.status(500).json({ error: 'فشل في جلب الإجازات' });
    }
});

app.post('/api/save-vacations', async (req, res) => {
    try {
        const { vacations } = req.body;
        await fs.writeFile(VACATIONS_PATH, JSON.stringify(vacations, null, 2));
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'فشل في حفظ الإجازات' }); }
});

// ============================================
// API: الرقم السري
// ============================================
app.get('/api/get-password', async (req, res) => {
    try { const password = await readPassword(); res.json({ success: true, password }); } catch (error) { res.status(500).json({ error: 'فشل في جلب الرقم السري' }); }
});

app.post('/api/change-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const currentPassword = await readPassword();
        if (oldPassword !== currentPassword) return res.status(400).json({ error: 'الرقم السري القديم غير صحيح' });
        if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل' });
        await writePassword(newPassword);
        res.json({ success: true, message: 'تم تغيير الرقم السري بنجاح' });
    } catch (error) { res.status(500).json({ error: 'فشل في تغيير الرقم السري' }); }
});

// ============================================
// API: وقت الذروة
// ============================================
app.get('/api/peak-data', async (req, res) => {
    try { const data = await readPeakData(); res.json({ success: true, data }); } catch (error) { res.status(500).json({ error: 'فشل في جلب بيانات وقت الذروة' }); }
});

app.post('/api/peak-mission', async (req, res) => {
    try {
        const { location, unit, startTime, endTime, priority, notes, lat, lng } = req.body;
        if (!location || !unit || !startTime || !endTime) return res.status(400).json({ error: 'بيانات ناقصة' });
        const data = await readPeakData();
        const now = new Date();
        const startUTC = new Date(new Date(startTime).getTime() - (3 * 60 * 60 * 1000));
        const endUTC = new Date(new Date(endTime).getTime() - (3 * 60 * 60 * 1000));
        const mission = {
            id: Date.now().toString(), location, lat: lat || null, lng: lng || null, unit,
            startTime: startUTC.toISOString(), endTime: endUTC.toISOString(),
            startTimeDisplay: formatLocalDateTime(startUTC), endTimeDisplay: formatLocalDateTime(endUTC),
            priority: priority || 'عالية', notes: notes || '', status: 'نشط',
            createdAt: now.toISOString(), createdAtDisplay: formatLocalDateTime(now)
        };
        data.missions.unshift(mission);
        if (data.missions.length > 100) data.missions.pop();
        data.logs.unshift({
            id: Date.now().toString(), icon: '🟡', action: 'مهمة جديدة', details: unit + ' في ' + location,
            priority: priority || 'عادي', time: formatLocalTime(now), date: formatLocalDate(now), fullDate: now.toISOString()
        });
        if (data.logs.length > 50) data.logs.pop();
        const alertData = {
            id: Date.now().toString(), title: 'تمركز مطلوب لـ ' + unit,
            details: 'المطلوب تمركز ' + unit + ' في ' + location + ' (' + formatLocalDateTime(startUTC) + ' - ' + formatLocalDateTime(endUTC) + ')',
            priority: priority || 'عالية', unit, location,
            startTime: startUTC.toISOString(), endTime: endUTC.toISOString(),
            startTimeDisplay: formatLocalDateTime(startUTC), endTimeDisplay: formatLocalDateTime(endUTC),
            notes: notes || '', lat: lat || null, lng: lng || null, radius: 5000,
            missionId: mission.id, status: 'نشط', createdAt: now.toISOString(), createdAtDisplay: formatLocalDateTime(now), read: false
        };
        data.alerts.unshift(alertData);
        if (data.alerts.length > 50) data.alerts.pop();
        await writePeakData(data);
        sendPeakNotification(alertData, 'new_peak_alert');
        res.json({ success: true, mission });
    } catch (error) { res.status(500).json({ error: 'فشل في حفظ المهمة' }); }
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
            data.logs.unshift({
                id: Date.now().toString(), icon: '✅', action: 'تم التنفيذ', details: alert.details,
                priority: alert.priority || 'عادي', time: formatLocalTime(new Date()), date: formatLocalDate(new Date()), fullDate: new Date().toISOString()
            });
            if (data.logs.length > 50) data.logs.pop();
            await writePeakData(data);
            sendPeakNotification({ ...alert, status: 'منتهي' }, 'resolved_peak_alert');
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: 'فشل في إنهاء التنبيه' }); }
});

// ============================================
// API: البيانات الجغرافية للمراكز
// ============================================
app.get('/api/center-geo', (req, res) => {
    res.json({ success: true, data: centerGeoData });
});

app.post('/api/save-center-geo', async (req, res) => {
    try {
        const { data } = req.body;
        if (!data) return res.status(400).json({ error: 'بيانات ناقصة' });
        for (let center in data) {
            if (centerGeoData[center]) {
                centerGeoData[center].center = data[center].center;
                centerGeoData[center].radius = data[center].radius;
                centerGeoData[center].address = data[center].address || centerGeoData[center].address;
            }
        }
        res.json({ success: true, message: 'تم حفظ مواقع المراكز بنجاح' });
    } catch (error) { res.status(500).json({ error: 'فشل في حفظ مواقع المراكز' }); }
});

app.post('/api/locate-report', (req, res) => {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'إحداثيات غير صالحة' });
    let foundCenter = null, minDistance = Infinity;
    for (let center in centerGeoData) {
        const data = centerGeoData[center];
        const distance = getDistance(lat, lng, data.center[0], data.center[1]);
        if (distance < data.radius && distance < minDistance) { minDistance = distance; foundCenter = center; }
    }
    res.json({ success: true, center: foundCenter, distance: minDistance, location: foundCenter ? centerGeoData[foundCenter].address : 'غير معروف' });
});

// ============================================
// API: الجدول الشهري
// ============================================
app.post('/api/upload-monthly-table', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'لا يوجد ملف' });
        await fs.copyFile(file.path, MONTHLY_TABLE_PATH);
        await fs.unlink(file.path);
        res.json({ success: true, message: 'تم حفظ الجدول الشهري بنجاح' });
    } catch (error) { res.status(500).json({ error: 'فشل في حفظ الجدول: ' + error.message }); }
});

app.get('/api/get-monthly-table', async (req, res) => {
    try {
        const data = await fs.readFile(MONTHLY_TABLE_PATH);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(data);
    } catch (error) {
        if (error.code === 'ENOENT') res.status(404).json({ error: 'لا يوجد جدول شهري محفوظ' });
        else res.status(500).json({ error: 'فشل في جلب الجدول' });
    }
});

app.get('/api/check-monthly-table', async (req, res) => {
    try { await fs.access(MONTHLY_TABLE_PATH); res.json({ exists: true }); } catch (error) { res.json({ exists: false }); }
});

// ============================================
// API: تصدير جميع البيانات (Backup كامل)
// ============================================
app.get('/api/export-all-data', async (req, res) => {
    try {
        const allData = {
            exportedAt: new Date().toISOString(),
            exportedAtDisplay: new Date().toLocaleString('ar-SA'),
            version: '2.1.0',
            data: {
                reports: await readData(),
                shifts: await readShifts(),
                docs: await readDocs(),
                airRecords: await readAirRecords(),
                peakData: await readPeakData(),
                escalations: await readEscalations(),
                controlNotes: await readDataFile(CONTROL_NOTES_PATH, { notes: '' }),
                vacations: await readDataFile(VACATIONS_PATH, []),
                themeData: await readThemeData()
            }
        };
        res.json({ success: true, data: allData });
    } catch (error) {
        console.error('❌ خطأ في تصدير البيانات:', error);
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// ============================================
// API: استيراد جميع البيانات (استعادة Backup)
// ============================================
app.post('/api/import-all-data', async (req, res) => {
    try {
        const { data } = req.body;
        if (!data || !data.data) {
            return res.status(400).json({ error: 'بيانات غير صالحة' });
        }
        const importedData = data.data;
        if (importedData.reports) await writeData(importedData.reports);
        if (importedData.shifts) await writeShifts(importedData.shifts);
        if (importedData.docs) await writeDocs(importedData.docs);
        if (importedData.airRecords) await writeAirRecords(importedData.airRecords);
        if (importedData.peakData) await writePeakData(importedData.peakData);
        if (importedData.escalations) await writeEscalations(importedData.escalations);
        if (importedData.controlNotes) await writeDataFile(CONTROL_NOTES_PATH, importedData.controlNotes);
        if (importedData.vacations) await writeDataFile(VACATIONS_PATH, importedData.vacations);
        if (importedData.themeData) await writeThemeData(importedData.themeData);
        lastUpdateTime = Date.now();
        res.json({ success: true, message: '✅ تم استعادة جميع البيانات بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في استيراد البيانات:', error);
        res.status(500).json({ error: 'فشل في استيراد البيانات: ' + error.message });
    }
});

// ============================================
// API: قائمة النسخ الاحتياطية المتاحة
// ============================================
app.get('/api/backups-list', async (req, res) => {
    try {
        const files = await fs.readdir(BACKUP_PATH);
        const backups = [];
        for (const f of files) {
            if (f.endsWith('.json')) {
                const filePath = path.join(BACKUP_PATH, f);
                const stats = await fs.stat(filePath);
                backups.push({
                    fileName: f,
                    size: stats.size,
                    createdAt: stats.birthtime,
                    createdAtDisplay: stats.birthtime.toLocaleString('ar-SA')
                });
            }
        }
        backups.sort((a, b) => b.createdAt - a.createdAt);
        res.json({ success: true, backups });
    } catch (error) {
        console.error('❌ خطأ في جلب النسخ الاحتياطية:', error);
        res.status(500).json({ error: 'فشل في جلب قائمة النسخ الاحتياطية' });
    }
});

// ============================================
// API: استعادة نسخة احتياطية محددة
// ============================================
app.post('/api/restore-backup', async (req, res) => {
    try {
        const { fileName } = req.body;
        if (!fileName) {
            return res.status(400).json({ error: 'اسم الملف مطلوب' });
        }
        const backupFilePath = path.join(BACKUP_PATH, fileName);
        const data = await fs.readFile(backupFilePath, 'utf8');
        const parsedData = JSON.parse(data);
        if (fileName.startsWith('ambulance-data')) {
            await writeData(parsedData);
        } else if (fileName.startsWith('shift-data')) {
            await writeShifts(parsedData);
        } else if (fileName.startsWith('docs')) {
            await writeDocs(parsedData);
        } else if (fileName.startsWith('air-ambulance')) {
            await writeAirRecords(parsedData);
        } else if (fileName.startsWith('peak-data')) {
            await writePeakData(parsedData);
        } else if (fileName.startsWith('escalation-data')) {
            await writeEscalations(parsedData);
        } else if (fileName.startsWith('theme-data')) {
            await writeThemeData(parsedData);
        } else {
            return res.status(400).json({ error: 'نوع الملف غير معروف' });
        }
        res.json({ success: true, message: `✅ تم استعادة النسخة الاحتياطية: ${fileName}` });
    } catch (error) {
        console.error('❌ خطأ في استعادة النسخة الاحتياطية:', error);
        res.status(500).json({ error: 'فشل في استعادة النسخة الاحتياطية' });
    }
});

// ============================================
// API: الثيمات
// ============================================
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
        const data = { headerBg, headerBgType, sectorLogo, themeMode };
        await writeThemeData(data);
        res.json({ success: true, message: 'تم حفظ إعدادات الثيم' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ إعدادات الثيم' });
    }
});

// ============================================
// API: تصدير البيانات إلى CSV
// ============================================
app.get('/api/export', async (req, res) => {
    try {
        const reports = await readData();
        const safeReports = (reports && typeof reports === 'object') ? reports : {};
        let rows = [
            ["تقرير بلاغات الفرق الإسعافية - قطاع جنوب الرياض"],
            ["تاريخ التصدير:", formatLocalDateTime(new Date())],
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
        const fileName = `بلاغات_${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.status(200).send("\uFEFF" + csv);
    } catch (error) { res.status(500).json({ error: 'فشل في تصدير البيانات' }); }
});

// ============================================
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار البيانات: ${DATA_DIR}`);
    console.log(`📁 مسار النسخ الاحتياطية: ${BACKUP_PATH}`);
    console.log(`🕒 التوقيت المحلي: ${new Date().toLocaleString('ar-SA')}`);
    console.log(`📡 نظام الإشعارات اللحظية (SSE) مفعل`);
    console.log(`💾 نظام النسخ الاحتياطي التلقائي مفعل`);
    console.log(`🌐 افتح المتصفح على: http://localhost:${PORT}`);
});