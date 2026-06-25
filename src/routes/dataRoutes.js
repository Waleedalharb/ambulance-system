// ============================================
// مسارات API: التحديثات التشغيلية
// ============================================

const express = require('express');
const router = express.Router();
const { readDocs, writeDocs } = require('../models/dataModel');
const { formatLocalDateTime } = require('../utils/timeUtils');

// جلب جميع التحديثات
router.get('/', async (req, res) => {
    try {
        const docs = await readDocs();
        res.json({ success: true, docs });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب التحديثات' });
    }
});

// رفع تحديث جديد
router.post('/', async (req, res) => {
    try {
        const { filename, fileData, description, fileType, category, priority, uploader } = req.body;
        
        if (!filename || !fileData) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        const docs = await readDocs();
        const newDoc = {
            id: Date.now().toString(),
            filename,
            fileData,
            fileType: fileType || 'application/octet-stream',
            description: description || '',
            category: category || 'أخرى',
            priority: priority || 'normal',
            uploader: uploader || 'المشرف',
            uploadDate: new Date().toISOString(),
            uploadDateDisplay: formatLocalDateTime(new Date())
        };
        
        docs.push(newDoc);
        await writeDocs(docs);
        res.json({ success: true, doc: newDoc });
    } catch (error) {
        res.status(500).json({ error: 'فشل في رفع التحديث' });
    }
});

// تحميل ملف
router.get('/:id', async (req, res) => {
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

// حذف تحديث
router.delete('/:id', async (req, res) => {
    try {
        const docs = await readDocs();
        const filtered = docs.filter(d => d.id !== req.params.id);
        await writeDocs(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التحديث' });
    }
});

module.exports = router;