// ============================================
// مسارات API: البلاغات
// ============================================

const express = require('express');
const router = express.Router();
const { readData, writeData } = require('../models/dataModel');
const { getCurrentTimestamp } = require('../utils/timeUtils');

// تسجيل بلاغ جديد
router.post('/', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    
    const key = `${center}|${unit}`;
    const timestamp = getCurrentTimestamp();
    
    try {
        const allData = await readData();
        if (!allData[key]) allData[key] = { count: 0, times: [] };
        allData[key].count++;
        allData[key].times.unshift(timestamp);
        if (allData[key].times.length > 10) allData[key].times.pop();
        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تسجيل البلاغ' });
    }
});

// التراجع عن آخر بلاغ
router.post('/undo', async (req, res) => {
    const { center, unit } = req.body;
    if (!center || !unit) {
        return res.status(400).json({ error: 'بيانات ناقصة' });
    }
    
    const key = `${center}|${unit}`;
    try {
        const allData = await readData();
        if (!allData[key] || allData[key].count === 0) {
            return res.status(400).json({ error: 'لا يوجد بلاغات للحذف' });
        }
        allData[key].count--;
        allData[key].times.shift();
        await writeData(allData);
        res.json({ success: true, newCount: allData[key].count });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

// إحصائيات القوى العاملة
router.get('/workforce/:shiftId', async (req, res) => {
    try {
        const { readShifts } = require('../models/dataModel');
        const shiftId = parseInt(req.params.shiftId);
        const shifts = await readShifts();
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        
        const centersData = shift.centersData || {};
        let totalStaff = 0, totalCars = 0, missingCenters = 0, readyCenters = 0, centerCount = 0;
        const distribution = {}, carDistribution = {};
        
        for (let center in centersData) {
            const staffCount = parseInt(centersData[center]?.staffCount) || 0;
            const carsCount = parseInt(centersData[center]?.carsCount) || 0;
            totalStaff += staffCount;
            totalCars += carsCount;
            centerCount++;
            if (staffCount >= 2 && carsCount >= 1) {
                readyCenters++;
            } else {
                missingCenters++;
            }
            distribution[center] = staffCount;
            carDistribution[center] = carsCount;
        }
        
        const readinessRate = centerCount > 0 ? Math.round((readyCenters / centerCount) * 100) : 0;
        res.json({
            totalStaff,
            totalCars,
            missingCenters,
            readyCenters,
            centerCount,
            readinessRate,
            distribution,
            carDistribution
        });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب إحصائيات القوى العاملة' });
    }
});

module.exports = router;