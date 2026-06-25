// ============================================
// مسارات API: وقت الذروة
// ============================================

const express = require('express');
const router = express.Router();
const { readPeakData, writePeakData } = require('../models/dataModel');
const { formatLocalDateTime, formatLocalTime, formatLocalDate } = require('../utils/timeUtils');
const { sendNotification } = require('../services/notificationService');

// جلب بيانات وقت الذروة
router.get('/data', async (req, res) => {
    try {
        const data = await readPeakData();
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب بيانات وقت الذروة' });
    }
});

// حفظ مهمة تمركز
router.post('/mission', async (req, res) => {
    try {
        const { location, unit, startTime, endTime, priority, notes, lat, lng } = req.body;
        
        if (!location || !unit || !startTime || !endTime) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        const data = await readPeakData();
        const now = new Date();
        
        // تحويل التوقيت إلى UTC للتخزين
        const startUTC = new Date(new Date(startTime).getTime() - (3 * 60 * 60 * 1000));
        const endUTC = new Date(new Date(endTime).getTime() - (3 * 60 * 60 * 1000));
        
        const mission = {
            id: Date.now().toString(),
            location,
            lat: lat || null,
            lng: lng || null,
            unit,
            startTime: startUTC.toISOString(),
            endTime: endUTC.toISOString(),
            startTimeDisplay: formatLocalDateTime(startUTC),
            endTimeDisplay: formatLocalDateTime(endUTC),
            priority: priority || 'عالية',
            notes: notes || '',
            status: 'نشط',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now)
        };
        
        data.missions.unshift(mission);
        if (data.missions.length > 100) data.missions.pop();
        
        // سجل العمليات
        data.logs.unshift({
            id: Date.now().toString(),
            icon: '🟡',
            action: 'مهمة جديدة',
            details: `${unit} في ${location}`,
            priority: priority || 'عادي',
            time: formatLocalTime(now),
            date: formatLocalDate(now),
            fullDate: now.toISOString()
        });
        if (data.logs.length > 50) data.logs.pop();
        
        // إنشاء تنبيه
        const alertData = {
            id: Date.now().toString(),
            title: `تمركز مطلوب لـ ${unit}`,
            details: `المطلوب تمركز ${unit} في ${location} (${formatLocalDateTime(startUTC)} - ${formatLocalDateTime(endUTC)})`,
            priority: priority || 'عالية',
            unit,
            location,
            startTime: startUTC.toISOString(),
            endTime: endUTC.toISOString(),
            startTimeDisplay: formatLocalDateTime(startUTC),
            endTimeDisplay: formatLocalDateTime(endUTC),
            notes: notes || '',
            lat: lat || null,
            lng: lng || null,
            radius: 5000,
            missionId: mission.id,
            status: 'نشط',
            createdAt: now.toISOString(),
            createdAtDisplay: formatLocalDateTime(now),
            read: false
        };
        
        data.alerts.unshift(alertData);
        if (data.alerts.length > 50) data.alerts.pop();
        
        await writePeakData(data);
        
        // إرسال إشعار فوري
        sendNotification(alertData, 'new_peak_alert');
        
        res.json({ success: true, mission });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'فشل في حفظ المهمة' });
    }
});

// إنهاء تنبيه
router.post('/resolve', async (req, res) => {
    try {
        const { alertId } = req.body;
        
        if (!alertId) {
            return res.status(400).json({ error: 'معرف التنبيه مطلوب' });
        }
        
        const data = await readPeakData();
        const alert = data.alerts.find(a => a.id === alertId);
        
        if (alert) {
            alert.status = 'منتهي';
            alert.resolvedAt = new Date().toISOString();
            alert.resolvedAtDisplay = formatLocalDateTime(new Date());
            
            data.logs.unshift({
                id: Date.now().toString(),
                icon: '✅',
                action: 'تم التنفيذ',
                details: alert.details,
                priority: alert.priority || 'عادي',
                time: formatLocalTime(new Date()),
                date: formatLocalDate(new Date()),
                fullDate: new Date().toISOString()
            });
            
            if (data.logs.length > 50) data.logs.pop();
            await writePeakData(data);
            
            sendNotification({ ...alert, status: 'منتهي' }, 'resolved_peak_alert');
        }
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'فشل في إنهاء التنبيه' });
    }
});

module.exports = router;