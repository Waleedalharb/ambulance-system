// ============================================
// مسارات API: الإسعاف الجوي
// ============================================

const express = require('express');
const router = express.Router();
const { readAirRecords, writeAirRecords } = require('../models/dataModel');
const { formatLocalDateTime } = require('../utils/timeUtils');

// جلب جميع السجلات
router.get('/', async (req, res) => {
    try {
        const records = await readAirRecords();
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجلات الإسعاف الجوي' });
    }
});

// حفظ سجل جديد
router.post('/', async (req, res) => {
    try {
        const { reportNumber, unit, hospital, dateTime, notes } = req.body;
        
        if (!reportNumber || !unit || !hospital || !dateTime) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        const records = await readAirRecords();
        const now = new Date();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber,
            unit,
            hospital,
            dateTime,
            dateTimeDisplay: formatLocalDateTime(new Date(dateTime)),
            notes: notes || '',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
        };
        
        records.unshift(newRecord);
        await writeAirRecords(records);
        res.json({ success: true, record: newRecord });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ بلاغ الإسعاف الجوي' });
    }
});

// حذف سجل
router.delete('/:id', async (req, res) => {
    try {
        const records = await readAirRecords();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeAirRecords(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف البلاغ' });
    }
});

// حذف جميع السجلات
router.delete('/', async (req, res) => {
    try {
        await writeAirRecords([]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف جميع البلاغات' });
    }
});

module.exports = router;