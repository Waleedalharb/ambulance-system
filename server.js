const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// مسارات ملفات البيانات
// ============================================
const DATA_PATH = '/data/ambulance-data.json';
const SHIFT_DATA_PATH = '/data/shift-data.json';
const MONTHLY_TABLE_PATH = '/data/monthly-table.xlsx';
const DOCS_PATH = '/data/docs.json';
const AIR_PATH = '/data/air-ambulance.json';
const IDENTITY_PATH = '/data/identity.pdf';
const CONTROL_NOTES_PATH = '/data/control-notes.json';
const VACATIONS_PATH = '/data/vacations.json';
const PASSWORD_PATH = '/data/password.json';
const PEAK_DATA_PATH = '/data/peak-data.json';
let lastUpdateTime = Date.now();
let currentShiftId = null;

// ============================================
// Middleware
// ============================================
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// إعداد Multer لرفع الملفات
// ============================================
const upload = multer({
    dest: '/data/temp/',
    limits: { fileSize: 100 * 1024 * 1024 }
});

async function ensureTempDir() {
    try {
        await fs.mkdir('/data/temp', { recursive: true });
    } catch (e) {}
}
ensureTempDir();

// ============================================
// دوال مساعدة للتوقيت (الرياض GMT+3)
// ============================================

// الحصول على التوقيت المحلي (الرياض GMT+3)
function getLocalTime(date = new Date()) {
    const offset = 3; // الرياض GMT+3
    const localDate = new Date(date.getTime() + (offset * 60 * 60 * 1000));
    return localDate;
}

function formatLocalDateTime(date) {
    const local = getLocalTime(date);
    return local.toISOString().slice(0, 16).replace('T', ' ');
}

function formatLocalDate(date) {
    const local = getLocalTime(date);
    return local.toLocaleDateString('ar-SA');
}

function formatLocalTime(date) {
    const local = getLocalTime(date);
    return local.toLocaleTimeString('ar-SA');
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
// البيانات الجغرافية للمراكز
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
    },
    "سريع 3": {
        center: [24.7000, 46.6700],
        radius: 6000,
        boundaries: { north: 24.7400, south: 24.6600, east: 46.7100, west: 46.6300 },
        address: "المنصورة، الرياض"
    },
    "سريع 4": {
        center: [24.7200, 46.6800],
        radius: 7000,
        boundaries: { north: 24.7600, south: 24.6800, east: 46.7300, west: 46.6300 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 11": {
        center: [24.7100, 46.6700],
        radius: 3500,
        boundaries: { north: 24.7400, south: 24.6800, east: 46.7000, west: 46.6400 },
        address: "المنصورة، الرياض"
    },
    "جنوب 12": {
        center: [24.7200, 46.6750],
        radius: 3000,
        boundaries: { north: 24.7450, south: 24.6950, east: 46.7050, west: 46.6450 },
        address: "المنصورة، الرياض"
    },
    "جنوب 13": {
        center: [24.7300, 46.6900],
        radius: 4000,
        boundaries: { north: 24.7600, south: 24.7000, east: 46.7200, west: 46.6600 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 14": {
        center: [24.7400, 46.6950],
        radius: 3500,
        boundaries: { north: 24.7700, south: 24.7100, east: 46.7250, west: 46.6650 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 15": {
        center: [24.7500, 46.7000],
        radius: 3000,
        boundaries: { north: 24.7750, south: 24.7250, east: 46.7300, west: 46.6700 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 16": {
        center: [24.7100, 46.6600],
        radius: 3500,
        boundaries: { north: 24.7400, south: 24.6800, east: 46.6900, west: 46.6300 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 17": {
        center: [24.7000, 46.6550],
        radius: 3000,
        boundaries: { north: 24.7250, south: 24.6750, east: 46.6850, west: 46.6250 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 18": {
        center: [24.6900, 46.6500],
        radius: 3500,
        boundaries: { north: 24.7200, south: 24.6600, east: 46.6800, west: 46.6200 },
        address: "الفرق الإضافية، الرياض"
    },
    "جنوب 19": {
        center: [24.6800, 46.6450],
        radius: 3000,
        boundaries: { north: 24.7050, south: 24.6550, east: 46.6750, west: 46.6150 },
        address: "الفرق الإضافية، الرياض"
    }
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

async function readPeakData() {
    try {
        const data = await fs.readFile(PEAK_DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { missions: [], alerts: [], logs: [] };
        }
        return { missions: [], alerts: [], logs: [] };
    }
}

async function writePeakData(data) {
    await fs.writeFile(PEAK_DATA_PATH, JSON.stringify(data, null, 2));
}

async function readPassword() {
    try {
        const data = await fs.readFile(PASSWORD_PATH, 'utf8');
        const parsed = JSON.parse(data);
        return parsed.password || '1234';
    } catch (error) {
        if (error.code === 'ENOENT') {
            return '1234';
        }
        return '1234';
    }
}

async function writePassword(password) {
    await fs.writeFile(PASSWORD_PATH, JSON.stringify({ password, updatedAt: new Date().toISOString() }));
}

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
    const newClient = {
        id: clientId,
        res: res
    };
    
    peakEventClients.push(newClient);
    
    // إرسال رسالة ترحيب
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'متصل بنظام الإشعارات', timestamp: new Date().toISOString() })}\n\n`);
    
    // إزالة العميل عند انقطاع الاتصال
    req.on('close', () => {
        peakEventClients = peakEventClients.filter(client => client.id !== clientId);
    });
});

// دالة إرسال إشعار لجميع العملاء
function sendPeakNotification(alertData, type = 'new_peak_alert') {
    const eventData = {
        type: type,
        alert: alertData,
        timestamp: new Date().toISOString(),
        timestampDisplay: formatLocalDateTime(new Date())
    };
    
    peakEventClients.forEach(client => {
        try {
            client.res.write(`data: ${JSON.stringify(eventData)}\n\n`);
        } catch (error) {
            console.error('خطأ في إرسال الإشعار:', error);
        }
    });
}

// ============================================
// دوال المساعدة
// ============================================
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
        const localNow = getLocalTime(now);
        const shiftDate = formatLocalDate(now);
        const shiftTime = formatLocalTime(now);
        
        const newShift = {
            id: Date.now(),
            shiftName: `${shiftType} - ${shiftDate} ${shiftTime}`,
            shiftDate: shiftDate,
            shiftTime: shiftTime,
            shiftType: shiftType,
            startTime: now.toISOString(),
            startTimeDisplay: formatLocalDateTime(now),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            generalNotes: "",
            lastUpdate: now.toISOString()
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
    const localNow = getLocalTime(now);
    const year = localNow.getUTCFullYear();
    const month = (localNow.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = localNow.getUTCDate().toString().padStart(2, '0');
    const hours = localNow.getUTCHours().toString().padStart(2, '0');
    const minutes = localNow.getUTCMinutes().toString().padStart(2, '0');
    const seconds = localNow.getUTCSeconds().toString().padStart(2, '0');
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

app.post('/api/upload-doc', async (req, res) => {
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
            uploadDate: new Date().toISOString(),
            uploadDateDisplay: formatLocalDateTime(new Date())
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
        const now = new Date();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber,
            unit,
            hospital,
            dateTime,
            dateTimeDisplay: formatLocalDateTime(new Date(dateTime)),
            notes: notes || '',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
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
// API: وقت الذروة (Server-based مع توقيت محلي)
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
        const now = new Date();
        
        // تحويل التوقيتات إلى التوقيت المحلي
        const startLocal = new Date(startTime);
        const endLocal = new Date(endTime);
        
        const mission = {
            id: Date.now().toString(),
            location,
            lat: lat || null,
            lng: lng || null,
            unit,
            startTime: startLocal.toISOString(),
            endTime: endLocal.toISOString(),
            startTimeDisplay: formatLocalDateTime(startLocal),
            endTimeDisplay: formatLocalDateTime(endLocal),
            priority: priority || 'عالية',
            notes: notes || '',
            status: 'نشط',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
        };
        
        data.missions.unshift(mission);
        if (data.missions.length > 100) data.missions.pop();
        
        data.logs.unshift({
            id: Date.now().toString(),
            icon: '🟡',
            action: 'مهمة جديدة',
            details: unit + ' في ' + location,
            priority: priority || 'عادي',
            time: formatLocalTime(now),
            date: formatLocalDate(now),
            fullDate: now.toISOString()
        });
        if (data.logs.length > 50) data.logs.pop();
        
        // إضافة تنبيه مع توقيت محلي
        const alertData = {
            id: Date.now().toString(),
            title: 'تمركز مطلوب لـ ' + unit,
            details: 'المطلوب تمركز ' + unit + ' في ' + location + ' (' + formatLocalDateTime(startLocal) + ' - ' + formatLocalDateTime(endLocal) + ')',
            priority: priority || 'عالية',
            unit: unit,
            location: location,
            startTime: startLocal.toISOString(),
            endTime: endLocal.toISOString(),
            startTimeDisplay: formatLocalDateTime(startLocal),
            endTimeDisplay: formatLocalDateTime(endLocal),
            notes: notes || '',
            lat: lat || null,
            lng: lng || null,
            radius: 5000,
            missionId: mission.id,
            status: 'نشط',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now),
            read: false
        };
        data.alerts.unshift(alertData);
        if (data.alerts.length > 50) data.alerts.pop();
        
        await writePeakData(data);
        
        // إرسال إشعار فوري عبر SSE
        sendPeakNotification(alertData, 'new_peak_alert');
        
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
            alert.resolvedAt = new Date().toISOString();
            alert.resolvedAtDisplay = formatLocalDateTime(new Date());
            
            data.logs.unshift({
                id: Date.now().toString(),
                icon: '✅',
                action: 'تم التنفيذ',
                details: alert.details,
                priority: alert.priority || 'عادي',
                time: formatLocalTime(new Date()),
                date: formatLocalDate(new Date()),
                fullDate: new Date().toISOString()
            });
            if (data.logs.length > 50) data.logs.pop();
            await writePeakData(data);
            
            // إرسال إشعار بحل التنبيه
            sendPeakNotification({
                ...alert,
                status: 'منتهي'
            }, 'resolved_peak_alert');
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إنهاء التنبيه' });
    }
});

// ============================================
// API: البيانات الجغرافية للمراكز
// ============================================
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
// API: تصدير البيانات
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
        const fileName = `بلاغات_${new Date().toISOString().slice(0,10)}.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.status(200).send("\uFEFF" + csv);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// ============================================
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار بيانات البلاغات: ${DATA_PATH}`);
    console.log(`📁 مسار بيانات المناوبات: ${SHIFT_DATA_PATH}`);
    console.log(`📁 مسار التحديثات التشغيلية: ${DOCS_PATH}`);
    console.log(`📁 مسار الإسعاف الجوي: ${AIR_PATH}`);
    console.log(`📁 مسار هوية القطاع: ${IDENTITY_PATH}`);
    console.log(`📁 مسار الرقم السري: ${PASSWORD_PATH}`);
    console.log(`📁 مسار بيانات وقت الذروة: ${PEAK_DATA_PATH}`);
    console.log(`🗺️ تم تحميل البيانات الجغرافية لـ ${Object.keys(centerGeoData).length} مركز`);
    console.log(`🕒 التوقيت المحلي: ${formatLocalDateTime(new Date())}`);
    console.log(`📡 نظام الإشعارات اللحظية (SSE) مفعل`);
});