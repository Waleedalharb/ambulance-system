// ============================================
// مسارات API: الثيمات
// ============================================

const express = require('express');
const router = express.Router();
const { readThemeData, writeThemeData } = require('../models/dataModel');

// جلب إعدادات الثيم
router.get('/settings', async (req, res) => {
    try {
        const data = await readThemeData();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب إعدادات الثيم' });
    }
});

// حفظ إعدادات الثيم
router.post('/settings', async (req, res) => {
    try {
        const { headerBg, headerBgType, sectorLogo, themeMode } = req.body;
        const data = { headerBg, headerBgType, sectorLogo, themeMode };
        await writeThemeData(data);
        res.json({ success: true, message: 'تم حفظ إعدادات الثيم' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ إعدادات الثيم' });
    }
});

module.exports = router;