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
// API: تسجيل بلاغ
// ============================================
app.post('/api/report', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });
    
    const key = `${center}|${unit}`;
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    
    try {
        const allData = await readData();
        if (!allData[key]) allData[key] = { count: 0, times: [] };
        allData[key].count++;
        allData[key].times.unshift(timestamp);
        if (allData[key].times.length > 8) allData[key].times.pop();
        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

// ============================================
// API: تصفير البيانات
// ============================================
app.post('/api/reset', async (req, res) => {
    try {
        await writeData({});
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إعادة الضبط' });
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
// API: نموذج المناوبة (Shift Form)
// ============================================

// جلب جميع المناوبات
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

// حفظ مناوبة جديدة أو تحديثها
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

// حذف مناوبة
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
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار بيانات البلاغات: ${DATA_PATH}`);
    console.log(`📁 مسار بيانات المناوبات: ${SHIFT_DATA_PATH}`);
});