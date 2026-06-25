// ============================================
// مسارات API: المناوبات
// ============================================

const express = require('express');
const router = express.Router();
const { readShifts, writeShifts, readData, writeData } = require('../models/dataModel');
const { formatLocalDate, formatLocalTime, formatLocalDateTime } = require('../utils/timeUtils');

// جلب جميع المناوبات
router.get('/', async (req, res) => {
    try {
        const shifts = await readShifts();
        res.json(shifts);
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبات' });
    }
});

// جلب مناوبة محددة
router.get('/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const shiftId = parseInt(req.params.id);
        const shift = shifts.find(s => s.id === shiftId);
        if (!shift) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        res.json({ shift, reports: shift.savedReports || {}, total: shift.totalReports || 0 });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب المناوبة' });
    }
});

// بدء مناوبة جديدة
router.post('/start', async (req, res) => {
    try {
        const { shiftType } = req.body;
        if (!shiftType) {
            return res.status(400).json({ error: 'نوع المناوبة مطلوب' });
        }
        
        const currentReports = await readData();
        const total = Object.values(currentReports).reduce((sum, r) => sum + (r.count || 0), 0);
        const now = new Date();
        const shiftDate = formatLocalDate(now);
        const shiftTime = formatLocalTime(now);
        
        const newShift = {
            id: Date.now(),
            shiftName: `${shiftType} - ${shiftDate} ${shiftTime}`,
            shiftDate,
            shiftTime,
            shiftType,
            startTime: now.toISOString(),
            startTimeDisplay: formatLocalDateTime(now),
            savedReports: JSON.parse(JSON.stringify(currentReports)),
            totalReports: total,
            rapidLocations: {},
            centersData: {},
            generalNotes: "",
            lastUpdate: now.toISOString()
        };
        
        const shifts = await readShifts();
        shifts.unshift(newShift);
        if (shifts.length > 50) shifts.pop();
        await writeShifts(shifts);
        await writeData({});
        
        res.json({ success: true, shiftId: newShift.id, shift: newShift });
    } catch (error) {
        res.status(500).json({ error: 'فشل في بدء المناوبة: ' + error.message });
    }
});

// تحديث بيانات المناوبة
router.post('/update', async (req, res) => {
    try {
        const { shiftId, shiftData } = req.body;
        if (!shiftId) {
            return res.status(400).json({ error: 'معرف المناوبة مطلوب' });
        }
        
        const shifts = await readShifts();
        const index = shifts.findIndex(s => s.id === shiftId);
        if (index === -1) {
            return res.status(404).json({ error: 'المناوبة غير موجودة' });
        }
        
        shifts[index].rapidLocations = shiftData.rapidLocations || {};
        shifts[index].centersData = shiftData.centersData || {};
        shifts[index].generalNotes = shiftData.generalNotes || "";
        shifts[index].shiftType = shiftData.shiftType || shifts[index].shiftType;
        shifts[index].lastUpdate = new Date().toISOString();
        
        await writeShifts(shifts);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تحديث بيانات المناوبة' });
    }
});

// حذف مناوبة
router.delete('/:id', async (req, res) => {
    try {
        const shifts = await readShifts();
        const id = parseInt(req.params.id);
        const filtered = shifts.filter(s => s.id !== id);
        await writeShifts(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف المناوبة' });
    }
});

module.exports = router;