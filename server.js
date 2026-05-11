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
// بيانات القطاعات (مطابقة للواجهة)
// ============================================
const sectorsData = {
    south: { name: "الجنوب", centers: {
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
    }},
    north: { name: "الشمال", centers: {
        "مركز الروضة": ["شمال 1", "شمال 2", "سريع 5"],
        "مركز النرجس": ["شمال 3", "شمال 4"],
        "مركز العارض": ["شمال 5", "سريع 6"]
    }},
    east: { name: "الشرق", centers: {
        "مركز النسيم": ["شرق 1", "شرق 2", "سريع 7"],
        "مركز الروابي": ["شرق 3", "شرق 4"]
    }},
    west: { name: "الغرب", centers: {
        "مركز الدار": ["غرب 1", "غرب 2", "سريع 8"],
        "مركز السويدي": ["غرب 3", "غرب 4"]
    }},
    central: { name: "الوسط", centers: {
        "مركز البطحاء": ["وسط 1", "وسط 2", "سريع 9"],
        "مركز المربع": ["وسط 3", "وسط 4"]
    }}
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
            // ملف غير موجود → نرجع هيكل فارغ
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
        res.json({ data, sectors: sectorsData });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

// جلب بيانات قطاع محدد
app.get('/api/data/:sector', async (req, res) => {
    try {
        const allData = await readData();
        const sectorData = allData[req.params.sector] || {};
        res.json(sectorData);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

// تسجيل بلاغ جديد
app.post('/api/report', async (req, res) => {
    const { sector, center, unit } = req.body;
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
        if (!allData[sector]) allData[sector] = {};
        if (!allData[sector][key]) allData[sector][key] = { count: 0, times: [] };

        allData[sector][key].count++;
        allData[sector][key].times.unshift(timestamp);
        if (allData[sector][key].times.length > 8) allData[sector][key].times.pop();

        await writeData(allData);
        res.json({ success: true, newCount: allData[sector][key].count });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

// تصفير قطاع معين
app.post('/api/reset', async (req, res) => {
    const { sector } = req.body;
    try {
        const allData = await readData();
        allData[sector] = {};
        await writeData(allData);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إعادة الضبط' });
    }
});

// تصدير بيانات قطاع (لـ Excel)
app.get('/api/export/:sector', async (req, res) => {
    const { sector } = req.params;
    try {
        const allData = await readData();
        const sectorData = allData[sector] || {};
        
        // تحويل إلى CSV
        let rows = [[`تقرير بلاغات - قطاع ${sectorsData[sector]?.name || sector}`], ["تاريخ التصدير:", new Date().toLocaleString("ar-SA")], [], ["المركز", "الوحدة", "عدد البلاغات", "التواقيت"]];
        
        const centers = sectorsData[sector]?.centers || {};
        for (let center in centers) {
            for (let unit of centers[center]) {
                let key = `${center}|${unit}`;
                let r = sectorData[key] || { count: 0, times: [] };
                rows.push([center, unit, r.count, r.times.join(" ؛ ") || "لا يوجد"]);
            }
        }
        
        let total = 0;
        for (let key in sectorData) total += sectorData[key].count;
        rows.push([], ["الإجمالي", "", total, ""]);
        
        let csv = rows.map(row => row.map(cell => `"${String(cell || "").replace(/"/g, '""')}"`).join(",")).join("\n");
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=بلاغات_${sectorsData[sector]?.name || sector}_${Date.now()}.csv`);
        res.send("\uFEFF" + csv);
    } catch (error) {
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`🚑 نظام البلاغات المركزي يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار حفظ البيانات: ${DATA_PATH}`);
});