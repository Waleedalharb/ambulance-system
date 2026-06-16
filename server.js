const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// مسارات ملفات البيانات
// ============================================
const DATA_PATH = '/data/ambulance-data.json';
const SHIFT_DATA_PATH = '/data/shift-data.json';
const CURRENT_SHIFT_DATA_PATH = '/data/current-shift-data.json';
const MONTHLY_TABLE_PATH = '/data/monthly-table.xlsx';
let lastUpdateTime = Date.now();

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
// دوال قراءة وكتابة البيانات (البلاغات)
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

// ============================================
// دوال بيانات التكميل الحالية
// ============================================
async function readCurrentShiftData() {
    try {
        const data = await fs.readFile(CURRENT_SHIFT_DATA_PATH, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

async function writeCurrentShiftData(data) {
    await fs.writeFile(CURRENT_SHIFT_DATA_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// API: جلب البيانات
// ============================================
app.get('/api/data', async (req, res) => {
    try {
        const data = await readData();
        const currentShiftData = await readCurrentShiftData();
        res.json({ 
            data, 
            centers: centersData,
            currentShiftData: currentShiftData
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

app.get('/api/last-update', (req, res) => {
    res.json({ lastUpdate: lastUpdateTime });
});

// ============================================
// API: جلب جميع المناوبات
// ============================================
app.get('/api/shifts', async (req, res) => {
    try {
        const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.json([]);
        } else {
            res.status(500).json({ error: 'فشل في جلب المناوبات' });
        }
    }
});

// ============================================
// API: جلب مناوبة محددة مع بلاغاتها
// ============================================
app.get('/api/shifts/:id', async (req, res) => {
    try {
        let allShifts = [];
        try {
            const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
            allShifts = JSON.parse(data);
        } catch (e) {}
        
        const shiftId = parseInt(req.params.id);
        const shift = allShifts.find(s => s.id === shiftId);
        
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

// ============================================
// API: حفظ مناوبة جديدة (من نموذج التكميل)
// ============================================
app.post('/api/shifts', async (req, res) => {
    try {
        let allShifts = [];
        try {
            const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
            allShifts = JSON.parse(data);
        } catch (e) {}
        
        const newShift = req.body;
        newShift.id = newShift.id || Date.now();
        newShift.lastUpdate = new Date().toISOString();
        
        const index = allShifts.findIndex(s => s.id === newShift.id);
        if (index !== -1) {
            allShifts[index] = newShift;
        } else {
            allShifts.unshift(newShift);
        }
        
        if (allShifts.length > 50) allShifts.pop();
        
        await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(allShifts, null, 2));
        res.json({ success: true, id: newShift.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ المناوبة' });
    }
});

// ============================================
// API: حفظ بيانات التكميل الحالية
// ============================================
app.post('/api/save-current-shift-data', async (req, res) => {
    try {
        const data = req.body;
        await writeCurrentShiftData(data);
        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ بيانات المناوبة الحالية' });
    }
});

// ============================================
// API: جلب بيانات التكميل الحالية
// ============================================
app.get('/api/get-current-shift-data', async (req, res) => {
    try {
        const data = await readCurrentShiftData();
        res.json(data);
    } catch (error) {
        res.json({});
    }
});

// ============================================
// API: حفظ المناوبة الحالية (زر مناوبة جديدة)
// ============================================
app.post('/api/save-current-shift', async (req, res) => {
    try {
        const currentReports = await readData();
        const currentShiftData = await readCurrentShiftData();
        
        let total = 0;
        for (let key in currentReports) {
            if (currentReports[key]?.count) total += currentReports[key].count;
        }
        
        const now = new Date();
        const offset = 3;
        const saudiTime = new Date(now.getTime() + (offset * 60 * 60 * 1000));
        const shiftDate = saudiTime.toLocaleDateString('ar-SA');
        const shiftTime = saudiTime.toLocaleTimeString('ar-SA');
        
        const newShift = {
            id: Date.now(),
            shiftName: `مناوبة ${shiftDate} - ${shiftTime}`,
            shiftDate: shiftDate,
            shiftTime: shiftTime,
            shiftType: currentShiftData.shiftType || "غير محدد",
            startTime: saudiTime.toISOString(),
            endTime: saudiTime.toISOString(),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: currentShiftData.rapidLocations || {},
            centersData: currentShiftData.centersData || {},
            generalNotes: currentShiftData.generalNotes || "",
            lastUpdate: saudiTime.toISOString()
        };
        
        let allShifts = [];
        try {
            const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
            allShifts = JSON.parse(data);
        } catch (e) {}
        
        allShifts.unshift(newShift);
        if (allShifts.length > 50) allShifts.pop();
        
        await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(allShifts, null, 2));
        await writeData({});
        await writeCurrentShiftData({});
        
        res.json({ success: true, shiftId: newShift.id });
    } catch (error) {
        console.error("خطأ في حفظ المناوبة:", error);
        res.status(500).json({ error: 'فشل في حفظ المناوبة: ' + error.message });
    }
});

// ============================================
// API: حذف مناوبة
// ============================================
app.delete('/api/shifts/:id', async (req, res) => {
    try {
        let allShifts = [];
        try {
            const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
            allShifts = JSON.parse(data);
        } catch (e) {}
        
        const id = parseInt(req.params.id);
        allShifts = allShifts.filter(s => s.id !== id);
        await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(allShifts, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف المناوبة' });
    }
});

// ============================================
// API: تسجيل بلاغ
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

// ============================================
// API: حذف آخر بلاغ
// ============================================
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
// API: تصدير Excel
// ============================================
app.get('/api/export', async (req, res) => {
    const shiftId = req.query.shiftId ? parseInt(req.query.shiftId) : null;
    
    try {
        let reports = await readData();
        let shiftInfo = null;
        
        if (shiftId) {
            let allShifts = [];
            try {
                const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
                allShifts = JSON.parse(data);
            } catch (e) {}
            shiftInfo = allShifts.find(s => s.id === shiftId);
            
            if (shiftInfo && shiftInfo.savedReports) {
                reports = shiftInfo.savedReports;
            }
        }
        
        const safeReports = (reports && typeof reports === 'object') ? reports : {};
        
        let rows = [
            [shiftInfo ? `تقرير بلاغات - ${shiftInfo.shiftName || 'مناوبة'}` : "تقرير بلاغات الفرق الإسعافية - قطاع جنوب الرياض"],
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
        
        let total = 0;
        for (let key in safeReports) {
            if (safeReports[key]?.count) total += safeReports[key].count;
        }
        rows.push([], ["الإجمالي الكلي", "", total, ""]);
        
        let csv = rows.map(row => row.map(cell => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
        const fileName = `blaghat_${Date.now()}.csv`;
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=${fileName}`);
        res.status(200).send("\uFEFF" + csv);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// ============================================
// API: الجدول الشهري (حفظ واسترجاع)
// ============================================

// حفظ الجدول الشهري
app.post('/api/upload-monthly-table', async (req, res) => {
    try {
        const base64Data = req.body.fileData;
        const buffer = Buffer.from(base64Data, 'base64');
        await fs.writeFile(MONTHLY_TABLE_PATH, buffer);
        res.json({ success: true, message: 'تم حفظ الجدول الشهري بنجاح' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ الجدول' });
    }
});

// جلب الجدول الشهري
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

// التحقق من وجود جدول محفوظ
app.get('/api/check-monthly-table', async (req, res) => {
    try {
        await fs.access(MONTHLY_TABLE_PATH);
        res.json({ exists: true });
    } catch (error) {
        res.json({ exists: false });
    }
});

// ============================================
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار بيانات البلاغات: ${DATA_PATH}`);
    console.log(`📁 مسار بيانات المناوبات: ${SHIFT_DATA_PATH}`);
    console.log(`📁 مسار بيانات التكميل الحالية: ${CURRENT_SHIFT_DATA_PATH}`);
    console.log(`📁 مسار الجدول الشهري: ${MONTHLY_TABLE_PATH}`);
});