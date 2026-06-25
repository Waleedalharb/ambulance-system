// ============================================
// مسارات API: التحكم والتنسيق
// ============================================

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const { PATHS } = require('../config/database');

// جلب ملاحظات التحكم
router.get('/notes', async (req, res) => {
    try {
        const data = await fs.readFile(PATHS.CONTROL_NOTES_PATH, 'utf8');
        const parsed = JSON.parse(data);
        res.json({ success: true, notes: parsed.notes || '' });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.json({ success: true, notes: '' });
        } else {
            res.status(500).json({ error: 'فشل في جلب الملاحظات' });
        }
    }
});

// حفظ ملاحظات التحكم
router.post('/notes', async (req, res) => {
    try {
        const { notes } = req.body;
        await fs.writeFile(PATHS.CONTROL_NOTES_PATH, JSON.stringify({ notes, updatedAt: new Date().toISOString() }));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الملاحظات' });
    }
});

// جلب الإجازات
router.get('/vacations', async (req, res) => {
    try {
        const data = await fs.readFile(PATHS.VACATIONS_PATH, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.json([]);
        } else {
            res.status(500).json({ error: 'فشل في جلب الإجازات' });
        }
    }
});

// حفظ الإجازات
router.post('/vacations', async (req, res) => {
    try {
        const { vacations } = req.body;
        await fs.writeFile(PATHS.VACATIONS_PATH, JSON.stringify(vacations, null, 2));
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ الإجازات' });
    }
});

module.exports = router;