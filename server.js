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
let lastUpdateTime = Date.now();

// Middleware
app.use(express.json());
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

// ============================================
// API: جلب البيانات
// ============================================
app.get('/api/data', async (req, res) => {
    try {
        const data = await readData();
        res.json({ data, centers: centersData });
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
        
        // جلب البلاغات المرتبطة بهذه المناوبة
        const reports = await readData();
        const shiftReports = {};
        
        if (shift.savedReports) {
            // إذا كانت المناوبة تحوي نسخة محفوظة من البلاغات
            shiftReports.reports = shift.savedReports;
            shiftReports.total = shift.totalReports || 0;
        } else {
            // فلترة البلاغات حسب وقت المناوبة (للتوافق مع الإصدارات القديمة)
            for (let key in reports) {
                const report = reports[key];
                if (report.count > 0) {
                    shiftReports[key] = report;
                }
            }
        }
        
        res.json({ shift, reports: shiftReports.reports || {}, total: shiftReports.total });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبة' });
    }
});

// ============================================
// API: حفظ مناوبة جديدة (من نموذج المناوبة)
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
// API: حفظ المناوبة الحالية (زر مناوبة جديدة)
// ============================================
app.post('/api/save-current-shift', async (req, res) => {
    try {
        // قراءة البلاغات الحالية
        const currentReports = await readData();
        
        // حساب إجمالي البلاغات
        let total = 0;
        for (let key in currentReports) {
            if (currentReports[key]?.count) total += currentReports[key].count;
        }
        
        // إنشاء مناوبة جديدة محفوظة
        const now = new Date();
        const shiftDate = now.toLocaleDateString('ar-SA');
        const shiftTime = now.toLocaleTimeString('ar-SA');
        
        const newShift = {
            id: Date.now(),
            shiftName: `مناوبة ${shiftDate} - ${shiftTime}`,
            shiftDate: shiftDate,
            shiftTime: shiftTime,
            shiftType: "غير محدد",
            startTime: now.toISOString(),
            endTime: now.toISOString(),
            savedReports: currentReports,
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            generalNotes: "",
            lastUpdate: now.toISOString()
        };
        
        // جلب المناوبات السابقة
        let allShifts = [];
        try {
            const data = await fs.readFile(SHIFT_DATA_PATH, 'utf8');
            allShifts = JSON.parse(data);
        } catch (e) {}
        
        // إضافة المناوبة الجديدة في البداية
        allShifts.unshift(newShift);
        
        // الاحتفاظ بآخر 50 مناوبة
        if (allShifts.length > 50) allShifts.pop();
        
        await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(allShifts, null, 2));
        
        // تصفير البلاغات الحالية
        await writeData({});
        
        res.json({ success: true, shiftId: newShift.id });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ المناوبة' });
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
    
    // وقت السعودية (UTC+3)
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
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار بيانات البلاغات: ${DATA_PATH}`);
    console.log(`📁 مسار بيانات المناوبات: ${SHIFT_DATA_PATH}`);
});