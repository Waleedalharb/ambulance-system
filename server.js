const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// اتصال MongoDB
// ============================================
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/south-platform';
let db;
let client;

async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db();
        console.log('✅ تم الاتصال بـ MongoDB بنجاح');
        
        // إنشاء المجموعات إذا لم تكن موجودة
        const collections = ['reports', 'shifts', 'docs', 'air', 'peak', 'themes', 'vacations', 'control'];
        for (const name of collections) {
            const colls = await db.listCollections({ name }).toArray();
            if (colls.length === 0) {
                await db.createCollection(name);
                console.log(`📁 تم إنشاء مجموعة: ${name}`);
            }
        }
        
        // تهيئة البيانات الافتراضية
        await initDefaultData();
        
        return db;
    } catch (error) {
        console.error('❌ فشل الاتصال بـ MongoDB:', error);
        process.exit(1);
    }
}

async function initDefaultData() {
    // التحقق من وجود بيانات في مجموعة reports
    const reportsCount = await db.collection('reports').countDocuments();
    if (reportsCount === 0) {
        await db.collection('reports').insertOne({ data: {}, currentShiftId: null, lastUpdate: Date.now() });
        console.log('✅ تم تهيئة بيانات البلاغات');
    }
    
    const shiftsCount = await db.collection('shifts').countDocuments();
    if (shiftsCount === 0) {
        await db.collection('shifts').insertOne({ shifts: [] });
        console.log('✅ تم تهيئة بيانات المناوبات');
    }
    
    const peakCount = await db.collection('peak').countDocuments();
    if (peakCount === 0) {
        await db.collection('peak').insertOne({ missions: [], alerts: [], logs: [] });
        console.log('✅ تم تهيئة بيانات وقت الذروة');
    }
    
    const themesCount = await db.collection('themes').countDocuments();
    if (themesCount === 0) {
        await db.collection('themes').insertOne({ headerBg: null, sectorLogo: null, headerBgType: null });
        console.log('✅ تم تهيئة بيانات الثيمات');
    }
    
    const controlCount = await db.collection('control').countDocuments();
    if (controlCount === 0) {
        await db.collection('control').insertOne({ notes: '', vacations: [] });
        console.log('✅ تم تهيئة بيانات التحكم');
    }
}

// ============================================
// Middleware
// ============================================
app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API: البلاغات (Reports)
// ============================================
app.get('/api/data', async (req, res) => {
    try {
        const doc = await db.collection('reports').findOne({});
        const data = doc?.data || {};
        const currentShiftId = doc?.currentShiftId || null;
        
        // بيانات المراكز
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
        
        res.json({ data, centers: centersData, currentShiftId });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب البيانات' });
    }
});

app.post('/api/report', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });
    
    const key = `${center}|${unit}`;
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);
    
    try {
        const doc = await db.collection('reports').findOne({});
        const data = doc?.data || {};
        
        if (!data[key]) data[key] = { count: 0, times: [] };
        data[key].count++;
        data[key].times.unshift(timestamp);
        if (data[key].times.length > 10) data[key].times.pop();
        
        await db.collection('reports').updateOne(
            {},
            { $set: { data, lastUpdate: Date.now() } },
            { upsert: true }
        );
        
        res.json({ success: true, newCount: data[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

app.post('/api/undo', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) return res.status(400).json({ error: 'بيانات ناقصة' });
    
    const key = `${center}|${unit}`;
    try {
        const doc = await db.collection('reports').findOne({});
        const data = doc?.data || {};
        
        if (!data[key] || data[key].count === 0) {
            return res.status(400).json({ error: 'لا يوجد بلاغات للحذف' });
        }
        data[key].count--;
        data[key].times.shift();
        
        await db.collection('reports').updateOne(
            {},
            { $set: { data, lastUpdate: Date.now() } },
            { upsert: true }
        );
        
        res.json({ success: true, newCount: data[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.get('/api/last-update', async (req, res) => {
    try {
        const doc = await db.collection('reports').findOne({});
        res.json({ lastUpdate: doc?.lastUpdate || Date.now() });
    } catch (error) {
        res.json({ lastUpdate: Date.now() });
    }
});

// ============================================
// API: المناوبات (Shifts)
// ============================================
app.get('/api/shifts', async (req, res) => {
    try {
        const doc = await db.collection('shifts').findOne({});
        res.json(doc?.shifts || []);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبات' });
    }
});

app.get('/api/shifts/:id', async (req, res) => {
    try {
        const doc = await db.collection('shifts').findOne({});
        const shifts = doc?.shifts || [];
        const shiftId = parseInt(req.params.id);
        const shift = shifts.find(s => s.id === shiftId);
        
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        
        res.json({
            shift,
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
        
        // جلب البيانات الحالية
        const reportsDoc = await db.collection('reports').findOne({});
        const currentReports = reportsDoc?.data || {};
        const total = Object.values(currentReports).reduce((sum, r) => sum + (r.count || 0), 0);
        
        const now = new Date();
        const shiftDate = now.toLocaleDateString('ar-SA');
        const shiftTime = now.toLocaleTimeString('ar-SA');
        
        const newShift = {
            id: Date.now(),
            shiftName: `${shiftType} - ${shiftDate} ${shiftTime}`,
            shiftDate,
            shiftTime,
            shiftType,
            startTime: now.toISOString(),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            generalNotes: "",
            lastUpdate: now.toISOString()
        };
        
        const shiftsDoc = await db.collection('shifts').findOne({});
        const shifts = shiftsDoc?.shifts || [];
        shifts.unshift(newShift);
        if (shifts.length > 50) shifts.pop();
        
        await db.collection('shifts').updateOne(
            {},
            { $set: { shifts } },
            { upsert: true }
        );
        
        // تصفير البلاغات الحالية
        await db.collection('reports').updateOne(
            {},
            { $set: { data: {}, currentShiftId: newShift.id, lastUpdate: Date.now() } },
            { upsert: true }
        );
        
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
        
        const doc = await db.collection('shifts').findOne({});
        const shifts = doc?.shifts || [];
        const index = shifts.findIndex(s => s.id === shiftId);
        
        if (index === -1) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        
        shifts[index].rapidLocations = shiftData.rapidLocations || {};
        shifts[index].centersData = shiftData.centersData || {};
        shifts[index].generalNotes = shiftData.generalNotes || "";
        shifts[index].shiftType = shiftData.shiftType || shifts[index].shiftType;
        shifts[index].lastUpdate = new Date().toISOString();
        
        await db.collection('shifts').updateOne(
            {},
            { $set: { shifts } },
            { upsert: true }
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error("خطأ في تحديث بيانات المناوبة:", error);
        res.status(500).json({ error: 'فشل في تحديث بيانات المناوبة' });
    }
});

app.delete('/api/shifts/:id', async (req, res) => {
    try {
        const doc = await db.collection('shifts').findOne({});
        const shifts = doc?.shifts || [];
        const id = parseInt(req.params.id);
        const filtered = shifts.filter(s => s.id !== id);
        
        await db.collection('shifts').updateOne(
            {},
            { $set: { shifts: filtered } },
            { upsert: true }
        );
        
        // إذا كانت المناوبة الحالية محذوفة
        const reportsDoc = await db.collection('reports').findOne({});
        if (reportsDoc?.currentShiftId === id) {
            await db.collection('reports').updateOne(
                {},
                { $set: { currentShiftId: null } },
                { upsert: true }
            );
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف المناوبة' });
    }
});

app.get('/api/workforce-stats/:shiftId', async (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId);
        const doc = await db.collection('shifts').findOne({});
        const shifts = doc?.shifts || [];
        const shift = shifts.find(s => s.id === shiftId);
        
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        
        const centersData = shift.centersData || {};
        let totalStaff = 0, totalCars = 0, missingCenters = 0, readyCenters = 0, centerCount = 0;
        const distribution = {}, carDistribution = {};
        
        for (const center in centersData) {
            const staffCount = parseInt(centersData[center]?.staffCount) || 0;
            const carsCount = parseInt(centersData[center]?.carsCount) || 0;
            totalStaff += staffCount;
            totalCars += carsCount;
            centerCount++;
            if (staffCount >= 2 && carsCount >= 1) readyCenters++;
            else missingCenters++;
            distribution[center] = staffCount;
            carDistribution[center] = carsCount;
        }
        
        const readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
        res.json({
            totalStaff, totalCars, missingCenters, readyCenters, centerCount,
            readinessRate, distribution, carDistribution
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' });
    }
});

// ============================================
// API: وقت الذروة (Peak Time) - متزامن مع MongoDB
// ============================================
app.get('/api/peak-data', async (req, res) => {
    try {
        const doc = await db.collection('peak').findOne({});
        res.json({ success: true, ...doc });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب بيانات وقت الذروة' });
    }
});

app.post('/api/peak-data', async (req, res) => {
    try {
        const { missions, alerts, logs } = req.body;
        await db.collection('peak').updateOne(
            {},
            { $set: { missions: missions || [], alerts: alerts || [], logs: logs || [] } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ بيانات وقت الذروة' });
    }
});

// ============================================
// API: الثيمات (Themes) - متزامن مع MongoDB
// ============================================
app.post('/api/save-themes', async (req, res) => {
    try {
        const { headerBg, sectorLogo, headerBgType } = req.body;
        await db.collection('themes').updateOne(
            {},
            { $set: { headerBg: headerBg || null, sectorLogo: sectorLogo || null, headerBgType: headerBgType || null } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الثيمات' });
    }
});

app.get('/api/get-themes', async (req, res) => {
    try {
        const doc = await db.collection('themes').findOne({});
        res.json({ success: true, themes: doc || { headerBg: null, sectorLogo: null, headerBgType: null } });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الثيمات' });
    }
});

// ============================================
// API: التحكم والتنسيق (Control)
// ============================================
app.get('/api/control-notes', async (req, res) => {
    try {
        const doc = await db.collection('control').findOne({});
        res.json({ success: true, notes: doc?.notes || '' });
    } catch (error) {
        res.json({ success: true, notes: '' });
    }
});

app.post('/api/save-control-notes', async (req, res) => {
    try {
        const { notes } = req.body;
        await db.collection('control').updateOne(
            {},
            { $set: { notes: notes || '', updatedAt: new Date().toISOString() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملاحظات' });
    }
});

app.get('/api/vacations', async (req, res) => {
    try {
        const doc = await db.collection('control').findOne({});
        res.json(doc?.vacations || []);
    } catch (error) {
        res.json([]);
    }
});

app.post('/api/save-vacations', async (req, res) => {
    try {
        const { vacations } = req.body;
        await db.collection('control').updateOne(
            {},
            { $set: { vacations: vacations || [], updatedAt: new Date().toISOString() } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الإجازات' });
    }
});

// ============================================
// API: الرقم السري (Password)
// ============================================
app.get('/api/get-password', async (req, res) => {
    try {
        // استخدام ملف مؤقت أو قيمة ثابتة للتوافق
        res.json({ success: true, password: '1234' });
    } catch (error) {
        res.json({ success: true, password: '1234' });
    }
});

app.post('/api/change-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        // في إصدار مبسط، نستخدم قيمة ثابتة
        if (oldPassword !== '1234') {
            return res.status(400).json({ error: 'الرقم السري القديم غير صحيح' });
        }
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ error: 'الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل' });
        }
        // حفظ الرقم السري الجديد في قاعدة البيانات
        await db.collection('password').updateOne(
            {},
            { $set: { password: newPassword, updatedAt: new Date().toISOString() } },
            { upsert: true }
        );
        res.json({ success: true, message: 'تم تغيير الرقم السري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تغيير الرقم السري' });
    }
});

// ============================================
// API: المستندات التشغيلية (Docs)
// ============================================
app.get('/api/docs', async (req, res) => {
    try {
        const doc = await db.collection('docs').findOne({});
        res.json({ success: true, docs: doc?.docs || [] });
    } catch (error) {
        res.json({ success: true, docs: [] });
    }
});

app.post('/api/upload-doc', async (req, res) => {
    try {
        const { filename, fileData, description, fileType, category, priority, uploader } = req.body;
        if (!filename) {
            return res.status(400).json({ error: 'عنوان التحديث مطلوب' });
        }
        
        const doc = await db.collection('docs').findOne({});
        const docs = doc?.docs || [];
        
        const newDoc = {
            id: Date.now().toString(),
            filename,
            fileData: fileData || '',
            fileType: fileType || 'text/plain',
            description: description || '',
            category: category || 'أخرى',
            priority: priority || 'normal',
            uploader: uploader || 'المشرف',
            uploadDate: new Date().toISOString()
        };
        docs.push(newDoc);
        
        await db.collection('docs').updateOne(
            {},
            { $set: { docs } },
            { upsert: true }
        );
        
        res.json({ success: true, doc: newDoc });
    } catch (error) {
        res.status(500).json({ error: 'فشل في رفع التحديث: ' + error.message });
    }
});

app.delete('/api/delete-doc/:id', async (req, res) => {
    try {
        const doc = await db.collection('docs').findOne({});
        const docs = doc?.docs || [];
        const filtered = docs.filter(d => d.id !== req.params.id);
        await db.collection('docs').updateOne(
            {},
            { $set: { docs: filtered } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التحديث' });
    }
});

// ============================================
// API: الإسعاف الجوي (Air Ambulance)
// ============================================
app.get('/api/air-ambulance', async (req, res) => {
    try {
        const doc = await db.collection('air').findOne({});
        res.json({ success: true, records: doc?.records || [] });
    } catch (error) {
        res.json({ success: true, records: [] });
    }
});

app.post('/api/save-air-ambulance', async (req, res) => {
    try {
        const { reportNumber, unit, hospital, dateTime, notes } = req.body;
        if (!reportNumber || !unit || !hospital || !dateTime) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        const doc = await db.collection('air').findOne({});
        const records = doc?.records || [];
        
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
        
        await db.collection('air').updateOne(
            {},
            { $set: { records } },
            { upsert: true }
        );
        
        res.json({ success: true, record: newRecord });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ بلاغ الإسعاف الجوي' });
    }
});

app.delete('/api/delete-air-ambulance/:id', async (req, res) => {
    try {
        const doc = await db.collection('air').findOne({});
        const records = doc?.records || [];
        const filtered = records.filter(r => r.id !== req.params.id);
        await db.collection('air').updateOne(
            {},
            { $set: { records: filtered } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

app.delete('/api/clear-air-ambulance', async (req, res) => {
    try {
        await db.collection('air').updateOne(
            {},
            { $set: { records: [] } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف جميع البلاغات' });
    }
});

// ============================================
// API: الجدول الشهري (Monthly Table)
// ============================================
const MONTHLY_TABLE_PATH = path.join(__dirname, 'data', 'monthly-table.xlsx');

app.post('/api/upload-monthly-table', async (req, res) => {
    try {
        const { fileData } = req.body;
        if (!fileData) {
            return res.status(400).json({ error: 'لا يوجد ملف' });
        }
        const buffer = Buffer.from(fileData, 'base64');
        await fs.promises.mkdir(path.join(__dirname, 'data'), { recursive: true });
        await fs.promises.writeFile(MONTHLY_TABLE_PATH, buffer);
        res.json({ success: true, message: 'تم حفظ الجدول الشهري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الجدول: ' + error.message });
    }
});

app.get('/api/get-monthly-table', async (req, res) => {
    try {
        const data = await fs.promises.readFile(MONTHLY_TABLE_PATH);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(data);
    } catch (error) {
        res.status(404).json({ error: 'لا يوجد جدول شهري محفوظ' });
    }
});

app.get('/api/check-monthly-table', async (req, res) => {
    try {
        await fs.promises.access(MONTHLY_TABLE_PATH);
        res.json({ exists: true });
    } catch (error) {
        res.json({ exists: false });
    }
});

// ============================================
// تشغيل الخادم
// ============================================
async function startServer() {
    await connectDB();
    app.listen(PORT, () => {
        console.log(`🚑 الخادم يعمل على المنفذ ${PORT}`);
        console.log(`📁 متصل بـ MongoDB`);
    });
}

startServer();