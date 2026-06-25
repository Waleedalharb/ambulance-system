// ============================================
// مسارات API: التحديثات التشغيلية
// ============================================

const express = require('express');
const router = express.Router();
const { readDocs, writeDocs } = require('../models/dataModel');
const { formatLocalDateTime } = require('../utils/timeUtils');

// ===== جلب جميع التحديثات =====
router.get('/', async (req, res) => {
    try {
        const docs = await readDocs();
        res.json({ success: true, docs });
    } catch (error) {
        console.error('❌ خطأ في جلب التحديثات:', error);
        res.status(500).json({ error: 'فشل في جلب التحديثات' });
    }
});

// ===== رفع تحديث جديد =====
router.post('/', async (req, res) => {
    try {
        const { 
            filename, 
            fileData, 
            description, 
            fileType, 
            category, 
            priority, 
            uploader 
        } = req.body;
        
        // التحقق من البيانات المطلوبة
        if (!filename || !fileData) {
            return res.status(400).json({ 
                success: false, 
                error: 'بيانات ناقصة: اسم الملف ومحتواه مطلوبان' 
            });
        }
        
        // قراءة التحديثات الحالية
        const docs = await readDocs();
        
        // إنشاء تحديث جديد
        const newDoc = {
            id: Date.now().toString(),
            filename: filename,
            fileData: fileData,
            fileType: fileType || 'application/octet-stream',
            description: description || '',
            category: category || 'أخرى',
            priority: priority || 'normal',
            uploader: uploader || 'المشرف',
            uploadDate: new Date().toISOString(),
            uploadDateDisplay: formatLocalDateTime(new Date())
        };
        
        // إضافة التحديث إلى القائمة
        docs.push(newDoc);
        await writeDocs(docs);
        
        res.json({ 
            success: true, 
            message: 'تم رفع التحديث بنجاح',
            doc: newDoc 
        });
    } catch (error) {
        console.error('❌ خطأ في رفع التحديث:', error);
        res.status(500).json({ 
            success: false, 
            error: 'فشل في رفع التحديث: ' + error.message 
        });
    }
});

// ===== تحميل ملف تحديث =====
router.get('/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const doc = docs.find(d => d.id === req.params.id);
        
        if (!doc) {
            return res.status(404).json({ 
                success: false, 
                error: 'التحديث غير موجود' 
            });
        }
        
        // تحويل البيانات من base64 إلى Buffer
        const buffer = Buffer.from(doc.fileData, 'base64');
        
        // تعيين رؤوس الاستجابة
        res.setHeader('Content-Type', doc.fileType);
        res.setHeader('Content-Disposition', `attachment; filename="${doc.filename}"`);
        res.setHeader('Content-Length', buffer.length);
        
        // إرسال الملف
        res.send(buffer);
    } catch (error) {
        console.error('❌ خطأ في تحميل التحديث:', error);
        res.status(500).json({ 
            success: false, 
            error: 'فشل في تحميل التحديث: ' + error.message 
        });
    }
});

// ===== عرض معاينة التحديث =====
router.get('/preview/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const doc = docs.find(d => d.id === req.params.id);
        
        if (!doc) {
            return res.status(404).json({ 
                success: false, 
                error: 'التحديث غير موجود' 
            });
        }
        
        // إرجاع بيانات التحديث بدون الملف
        res.json({
            success: true,
            doc: {
                id: doc.id,
                filename: doc.filename,
                description: doc.description,
                category: doc.category,
                priority: doc.priority,
                uploader: doc.uploader,
                uploadDate: doc.uploadDate,
                uploadDateDisplay: doc.uploadDateDisplay,
                fileType: doc.fileType,
                fileSize: doc.fileData ? Math.round(doc.fileData.length * 0.75 / 1024) : 0 // حجم تقريبي بالكيلوبايت
            }
        });
    } catch (error) {
        console.error('❌ خطأ في معاينة التحديث:', error);
        res.status(500).json({ 
            success: false, 
            error: 'فشل في معاينة التحديث: ' + error.message 
        });
    }
});

// ===== حذف تحديث =====
router.delete('/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const filtered = docs.filter(d => d.id !== req.params.id);
        
        if (filtered.length === docs.length) {
            return res.status(404).json({ 
                success: false, 
                error: 'التحديث غير موجود' 
            });
        }
        
        await writeDocs(filtered);
        res.json({ 
            success: true, 
            message: 'تم حذف التحديث بنجاح' 
        });
    } catch (error) {
        console.error('❌ خطأ في حذف التحديث:', error);
        res.status(500).json({ 
            success: false, 
            error: 'فشل في حذف التحديث: ' + error.message 
        });
    }
});

// ===== تحديث بيانات تحديث موجود =====
router.put('/:id', async (req, res) => {
    try {
        const { description, category, priority } = req.body;
        const docs = await readDocs();
        const index = docs.findIndex(d => d.id === req.params.id);
        
        if (index === -1) {
            return res.status(404).json({ 
                success: false, 
                error: 'التحديث غير موجود' 
            });
        }
        
        // تحديث الحقول المطلوبة
        if (description) docs[index].description = description;
        if (category) docs[index].category = category;
        if (priority) docs[index].priority = priority;
        docs[index].lastModified = new Date().toISOString();
        docs[index].lastModifiedDisplay = formatLocalDateTime(new Date());
        
        await writeDocs(docs);
        res.json({ 
            success: true, 
            message: 'تم تحديث التحديث بنجاح',
            doc: docs[index]
        });
    } catch (error) {
        console.error('❌ خطأ في تحديث التحديث:', error);
        res.status(500).json({ 
            success: false, 
            error: 'فشل في تحديث التحديث: ' + error.message 
        });
    }
});

// ===== الحصول على إحصائيات التحديثات =====
router.get('/stats/summary', async (req, res) => {
    try {
        const docs = await readDocs();
        
        const stats = {
            total: docs.length,
            byCategory: {},
            byPriority: {
                normal: 0,
                important: 0,
                urgent: 0
            },
            recent: docs
                .sort((a, b) => new Date(b.uploadDate) - new Date(a.uploadDate))
                .slice(0, 5)
                .map(d => ({
                    id: d.id,
                    filename: d.filename,
                    category: d.category,
                    priority: d.priority,
                    uploadDateDisplay: d.uploadDateDisplay
                }))
        };
        
        // حساب التوزيع حسب التصنيف
        docs.forEach(doc => {
            const category = doc.category || 'أخرى';
            stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
            
            const priority = doc.priority || 'normal';
            if (stats.byPriority[priority] !== undefined) {
                stats.byPriority[priority]++;
            }
        });
        
        res.json({ success: true, stats });
    } catch (error) {
        console.error('❌ خطأ في جلب إحصائيات التحديثات:', error);
        res.status(500).json({ 
            success: false, 
            error: 'فشل في جلب الإحصائيات: ' + error.message 
        });
    }
});

module.exports = router;