// ============================================
// تجميع جميع مسارات API
// ============================================

const express = require('express');
const router = express.Router();

// استيراد المسارات
const dataRoutes = require('./dataRoutes');
const shiftsRoutes = require('./shiftsRoutes');
const reportsRoutes = require('./reportsRoutes');
const docsRoutes = require('./docsRoutes');        // ← تم إضافة هذا السطر
const escalationRoutes = require('./escalationRoutes');

// تسجيل المسارات
router.use('/data', dataRoutes);
router.use('/shifts', shiftsRoutes);
router.use('/reports', reportsRoutes);
router.use('/docs', docsRoutes);                  // ← تم إضافة هذا السطر
router.use('/escalation', escalationRoutes);

// مسار جلب آخر تحديث
router.get('/last-update', (req, res) => {
    const { getLastUpdateTime } = require('../services/fileService');
    res.json({ lastUpdate: getLastUpdateTime() });
});

module.exports = router;