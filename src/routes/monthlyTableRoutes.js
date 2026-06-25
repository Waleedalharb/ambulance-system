// ============================================
// مسارات API: الجدول الشهري
// ============================================

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const multer = require('multer');
const path = require('path');
const { PATHS } = require('../config/database');

// إعداد multer لرفع الملفات
const upload = multer({
    dest: PATHS.TEMP_DIR,
    limits: { fileSize: 100 * 1024 * 1024 }
});

// رفع الجدول الشهري
router.post('/', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        
        if (!file) {
            return res.status(400).json({ error: 'لا يوجد ملف' });
        }
        
        await fs.copyFile(file.path, PATHS.MONTHLY_TABLE_PATH);
        await fs.unlink(file.path);
        res.json({ success: true, message: 'تم حفظ الجدول الشهري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الجدول: ' + error.message });
    }
});

// جلب الجدول الشهري
router.get('/', async (req, res) => {
    try {
        const data = await fs.readFile(PATHS.MONTHLY_TABLE_PATH);
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

// التحقق من وجود الجدول
router.get('/check', async (req, res) => {
    try {
        await fs.access(PATHS.MONTHLY_TABLE_PATH);
        res.json({ exists: true });
    } catch (error) {
        res.json({ exists: false });
    }
});

module.exports = router;