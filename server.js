const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// مسار ملف البيانات على الـ Persistent Disk
// ============================================
const DATA_PATH = '/data/ambulance-data.json';

// ============================================
// Middleware
// ============================================
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
            // ملف غير موجود → نرجع كائن فارغ
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

// 1. جلب جميع البيانات
app.get('/api/data', async (req, res) => {
    try {
        const data = await readData();
        res.json({ data, centers: centersData });
    } catch (error) {
        console.error("❌ خطأ في /api/data:", error);
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

// 2. تسجيل بلاغ جديد
app.post('/api/report', async (req, res) => {
    console.log("📝 تم استلام طلب تسجيل بلاغ:", req.body);
    
    const { center, unit } = req.body;
    
    if (!center || !unit) {
        return res.status(400).json({ error: 'بيانات ناقصة (center أو unit مفقود)' });
    }
    
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
        console.log("✅ تم حفظ البلاغ بنجاح:", key, "العدد الجديد:", allData[key].count);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        console.error("❌ خطأ في /api/report:", error);
        res.status(500).json({ error: 'فشل في تسجيل البلاغ: ' + error.message });
    }
});

// 3. تصفير جميع البيانات
app.post('/api/reset', async (req, res) => {
    console.log("🗑️ تم استلام طلب تصفير جميع البيانات");
    try {
        await writeData({});
        console.log("✅ تم تصفير جميع البيانات بنجاح");
        res.json({ success: true });
    } catch (error) {
        console.error("❌ خطأ في /api/reset:", error);
        res.status(500).json({ error: 'فشل في إعادة الضبط' });
    }
});

// 4. تصدير البيانات إلى Excel (CSV) - نسخة محسنة ومضمونة
app.get('/api/export', async (req, res) => {
    console.log("📎 تم استلام طلب تصدير البيانات");
    try {
        // قراءة البيانات من ملف الـ Disk
        const reports = await readData();
        
        // التأكد من أن reports هو كائن صالح
        const safeReports = (reports && typeof reports === 'object') ? reports : {};
        
        // بناء صفوف ملف Excel
        let rows = [
            ["تقرير بلاغات الفرق الإسعافية - قطاع جنوب الرياض"],
            ["تاريخ التصدير:", new Date().toLocaleString("ar-SA")],
            [],
            ["المركز", "الوحدة", "عدد البلاغات", "التواقيت"]
        ];
        
        // إضافة بيانات كل مركز ووحدة
        for (let center in centersData) {
            for (let unit of centersData[center]) {
                let key = `${center}|${unit}`;
                let record = safeReports[key] || { count: 0, times: [] };
                let timesStr = (Array.isArray(record.times) && record.times.length > 0) 
                    ? record.times.join(" ؛ ") 
                    : "لا يوجد بلاغات";
                rows.push([center, unit, record.count, timesStr]);
            }
        }
        
        // حساب الإجمالي الكلي
        let total = 0;
        for (let key in safeReports) {
            if (safeReports[key] && typeof safeReports[key].count === 'number') {
                total += safeReports[key].count;
            }
        }
        rows.push([], ["الإجمالي الكلي للبلاغات:", "", total, ""]);
        
        // تحويل المصفوفة إلى CSV
        let csv = rows.map(row => {
            return row.map(cell => {
                let cellStr = String(cell || "").replace(/"/g, '""');
                return `"${cellStr}"`;
            }).join(",");
        }).join("\n");
        
        // إضافة BOM لدعم اللغة العربية في Excel
        const csvWithBOM = "\uFEFF" + csv;
        
        // إرسال الملف
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=بلاغات_جنوب_الرياض_${Date.now()}.csv`);
        return res.status(200).send(csvWithBOM);
        
    } catch (error) {
        console.error("❌ خطأ جذري في /api/export:", error);
        return res.status(500).json({ 
            error: 'فشل في تصدير البيانات', 
            details: error.message,
            stack: error.stack
        });
    }
});

// 5. مسار اختبار للتحقق من أن الخادم يعمل
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// تشغيل الخادم
// ============================================
app.listen(PORT, () => {
    console.log(`🚑 نظام بلاغات الجنوب يعمل على المنفذ ${PORT}`);
    console.log(`📁 مسار حفظ البيانات: ${DATA_PATH}`);
    console.log(`✅ الخادم جاهز لاستقبال الطلبات`);
});