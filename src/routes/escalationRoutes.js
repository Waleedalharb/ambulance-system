// ============================================
// مسارات API: التصعيد
// ============================================

const express = require('express');
const router = express.Router();
const { readEscalations, writeEscalations } = require('../models/dataModel');
const { formatLocalDateTime } = require('../utils/timeUtils');
const { sendNotification } = require('../services/notificationService');

// جلب جميع التصعيدات
router.get('/', async (req, res) => {
    try {
        const records = await readEscalations();
        res.json({ success: true, records });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب سجل التصعيدات' });
    }
});

// حفظ تصعيد جديد
router.post('/', async (req, res) => {
    try {
        const { 
            reportNumber, type, level, casualties, time, location, 
            lat, lng, description, responseTime, agencies, fileData, fileType 
        } = req.body;
        
        if (!reportNumber || !type || !level || !time) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        const records = await readEscalations();
        const now = new Date();
        const newRecord = {
            id: Date.now().toString(),
            reportNumber,
            type,
            level,
            casualties: parseInt(casualties) || 0,
            time,
            location: location || '',
            lat: lat || null,
            lng: lng || null,
            description: description || '',
            responseTime: responseTime || '',
            agencies: agencies || [],
            fileData: fileData || null,
            fileType: fileType || null,
            status: 'جديد',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
        };
        
        records.unshift(newRecord);
        await writeEscalations(records);
        
        // إرسال إشعار فوري للتصعيد العاجل
        if (level === 'عاجل جداً' || level === 'عالي') {
            sendNotification({
                title: `🚨 تصعيد عاجل: ${type}`,
                details: `المستوى: ${level} | المصابين: ${casualties}${location ? ' | الموقع: ' + location : ''}`,
                level,
                type,
                location: location || 'غير محدد',
                casualties,
                reportNumber
            }, 'new_escalation_alert');
        }
        
        res.json({ success: true, record: newRecord });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ التصعيد' });
    }
});

// حذف تصعيد
router.delete('/:id', async (req, res) => {
    try {
        const records = await readEscalations();
        const filtered = records.filter(r => r.id !== req.params.id);
        await writeEscalations(filtered);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حذف التصعيد' });
    }
});

// إرسال تنبيه استدعاء فوري
router.post('/alert', async (req, res) => {
    try {
        const { record } = req.body;
        if (!record) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        sendNotification({
            title: `🔔 استدعاء فوري: ${record.type}`,
            details: `المستوى: ${record.level} | المصابين: ${record.casualties}${record.location ? ' | الموقع: ' + record.location : ''}`,
            level: record.level,
            type: record.type,
            location: record.location || 'غير محدد',
            casualties: record.casualties,
            reportNumber: record.reportNumber
        }, 'urgent_escalation_call');
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إرسال التنبيه' });
    }
});

module.exports = router;