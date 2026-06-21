const express = require('express');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// إنشاء مجلد البيانات تلقائياً
// ============================================
const DATA_DIR = path.join(__dirname, 'data');
if (!fsSync.existsSync(DATA_DIR)) {
    fsSync.mkdirSync(DATA_DIR, { recursive: true });
}

const DATA_PATH = path.join(DATA_DIR, 'ambulance-data.json');
const SHIFT_DATA_PATH = path.join(DATA_DIR, 'shift-data.json');
const MONTHLY_TABLE_PATH = path.join(DATA_DIR, 'monthly-table.xlsx');
const DOCS_PATH = path.join(DATA_DIR, 'docs.json');
const AIR_PATH = path.join(DATA_DIR, 'air-ambulance.json');
const IDENTITY_PATH = path.join(DATA_DIR, 'identity.pdf');
const CONTROL_NOTES_PATH = path.join(DATA_DIR, 'control-notes.json');
const VACATIONS_PATH = path.join(DATA_DIR, 'vacations.json');
const PASSWORD_PATH = path.join(DATA_DIR, 'password.json');

let lastUpdateTime = Date.now();
let currentShiftId = null;

// ============================================
// إنشاء ملفات البيانات إذا لم تكن موجودة
// ============================================
async function ensureDataFiles() {
    const files = [
        { path: DATA_PATH, default: {} },
        { path: SHIFT_DATA_PATH, default: [] },
        { path: DOCS_PATH, default: [] },
        { path: AIR_PATH, default: [] },
        { path: CONTROL_NOTES_PATH, default: { notes: '' } },
        { path: VACATIONS_PATH, default: [] },
        { path: PASSWORD_PATH, default: { password: '1234' } }
    ];
    for (const file of files) {
        try {
            await fs.access(file.path);
        } catch {
            await fs.writeFile(file.path, JSON.stringify(file.default, null, 2));
        }
    }
}
ensureDataFiles();

// ============================================
// ترحيل البيانات من المسار القديم
// ============================================
async function migrateOldData() {
    const oldPaths = [
        '/data/ambulance-data.json',
        '/data/shift-data.json',
        '/data/monthly-table.xlsx',
        '/data/docs.json',
        '/data/air-ambulance.json',
        '/data/identity.pdf',
        '/data/control-notes.json',
        '/data/vacations.json',
        '/data/password.json'
    ];
    
    const newPaths = [
        DATA_PATH, SHIFT_DATA_PATH, MONTHLY_TABLE_PATH,
        DOCS_PATH, AIR_PATH, IDENTITY_PATH,
        CONTROL_NOTES_PATH, VACATIONS_PATH, PASSWORD_PATH
    ];
    
    for (let i = 0; i < oldPaths.length; i++) {
        try {
            await fs.access(oldPaths[i]);
            try {
                await fs.access(newPaths[i]);
            } catch {
                const data = await fs.readFile(oldPaths[i]);
                await fs.writeFile(newPaths[i], data);
                console.log(`✅ تم ترحيل: ${path.basename(oldPaths[i])}`);
            }
        } catch {}
    }
}
migrateOldData();

// Middleware
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// إعداد Multer لرفع الملفات
// ============================================
const upload = multer({
    dest: path.join(DATA_DIR, 'temp/'),
    limits: { fileSize: 100 * 1024 * 1024 }
});

async function ensureTempDir() {
    try {
        await fs.mkdir(path.join(DATA_DIR, 'temp'), { recursive: true });
    } catch (e) {}
}
ensureTempDir();

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
        if (error.code === 'ENOENT') {
            await fs.writeFile(PASSWORD_PATH, JSON.stringify({ password: '1234' }));
            return '1234';
        }
        return '1234';
    }
}

async function writePassword(password) {
    await fs.writeFile(PASSWORD_PATH, JSON.stringify({ password, updatedAt: new Date().toISOString() }));
}

// ============================================
// API: الصفحة الرئيسية
// ============================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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

app.post('/api/start-new-shift', async (req, res) => {
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

app.delete('/api/shifts/:id', async (req, res) => {
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
app.post('/api/report', async (req, res) => {
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
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

app.post('/api/undo', async (req, res) => {
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
        const distribution = {};
        const carDistribution = {};
        
        for (let center in centersData) {
            const staffCount = parseInt(centersData[center]?.staffCount) || 0;
            const carsCount = parseInt(centersData[center]?.carsCount) || 0;
            totalStaff += staffCount;
            totalCars += carsCount;
            centerCount++;
            if (staffCount >= 2 && carsCount >= 1) {
                readyCenters++;
            } else {
                missingCenters++;
            }
            distribution[center] = staffCount;
            carDistribution[center] = carsCount;
        }
        
        const readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
        res.json({
            totalStaff,
            totalCars,
            missingCenters,
            readyCenters,
            centerCount,
            readinessRate,
            distribution,
            carDistribution
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' });
    }
});

// ============================================
// API: المستندات / التحديثات التشغيلية
// ============================================
app.get('/api/docs', async (req, res) => {
    try {
        const docs = await readDocs();
        res.json({ success: true, docs });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التحديثات التشغيلية' });
    }
});

app.post('/api/upload-doc', async (req, res) => {
    try {
        const { filename, fileData, description, fileType } = req.body;
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

app.delete('/api/delete-doc/:id', async (req, res) => {
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

app.post('/api/upload-identity', async (req, res) => {
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
// API: الجدول الشهري
// ============================================
app.post('/api/upload-monthly-table', upload.single('file'), async (req, res) => {
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

app.post('/api/save-control-notes', async (req, res) => {
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

app.post('/api/save-vacations', async (req, res) => {
    try {
        const { vacations } = req.body;
        await fs.writeFile(VACATIONS_PATH, JSON.stringify(vacations, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الإجازات' });
    }
});

// ============================================
// API: الرقم السري
// ============================================
app.get('/api/get-password', async (req, res) => {
    try {
        const password = await readPassword();
        res.json({ success: true, password });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الرقم السري' });
    }
});

app.post('/api/change-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const currentPassword = await readPassword();
        
        if (oldPassword !== currentPassword) {
            return res.status(400).json({ error: 'الرقم السري القديم غير صحيح' });
        }
        
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ error: 'الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل' });
        }
        
        await writePassword(newPassword);
        res.json({ success: true, message: 'تم تغيير الرقم السري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تغيير الرقم السري' });
    }
});

// ============================================
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار البيانات: ${DATA_DIR}`);
    console.log(`📁 مسار الملفات الثابتة: ${path.join(__dirname, 'public')}`);
});