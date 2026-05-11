const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// مسار ملف البيانات على الـ Persistent Disk
const DATA_PATH = '/data/ambulance-data.json';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// بيانات قطاع الجنوب فقط
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
        if (error.code === 'ENOENT') {
            return {};
        }
        throw error;
    }
}

async function writeData(data) {
    await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
}

// ============================================
// API Endpoints
// ============================================

// جلب جميع البيانات
app.get('/api/data', async (req, res) => {
    try {
        const data = await readData();
        res.json({ data, centers: centersData });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

// تسجيل بلاغ جديد
app.post('/api/report', async (req, res) => {
    const { center, unit } = req.body;
    const key = `${center}|${unit}`;
    const now = new Date();
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    try {
        const allData = await readData();
        if (!allData[key]) allData[key] = { count: 0, times: [] };

        allData[key].count++;
        allData[key].times.unshift(timestamp);
        if (allData[key].times.length > 8) allData[key].times.pop();

        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

// تصفير جميع البيانات
app.post('/api/reset', async (req, res) => {
    try {
        await writeData({});
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إعادة الضبط' });
    }
});

// تصدير البيانات إلى Excel
app.get('/api/export', async (req, res) => {
    try {
        const reports = await readData();
        
        let rows = [
            ["تقرير بلاغات الفرق الإسعافية - قطاع جنوب الرياض"],
            ["تاريخ التصدير:", new Date().toLocaleString("ar-SA")],
            [],
            ["المركز", "الوحدة", "عدد البلاغات", "التواقيت"]
        ];
        
        for (let center in centersData) {
            for (let unit of centersData[center]) {
                let key = `${center}|${unit}`;
                let r = reports[key] || { count: 0, times: [] };
                rows.push([center, unit, r.count, r.times.join(" ؛ ") || "لا يوجد"]);
            }
        }
        
        let total = 0;
        for (let key in reports) total += reports[key].count;
        rows.push([], ["الإجمالي الكلي", "", total, ""]);
        
        let csv = rows.map(row => row.map(cell => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=بلاغات_جنوب_الرياض_${Date.now()}.csv`);
        res.send("\uFEFF" + csv);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`🚑 نظام بلاغات الجنوب يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار حفظ البيانات: ${DATA_PATH}`);
});