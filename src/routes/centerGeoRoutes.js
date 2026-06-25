// ============================================
// مسارات API: البيانات الجغرافية للمراكز
// ============================================

const express = require('express');
const router = express.Router();
const { centerGeoData } = require('../config/constants');
const { getDistance } = require('../utils/geoUtils');

// جلب البيانات الجغرافية
router.get('/', (req, res) => {
    res.json({ success: true, data: centerGeoData });
});

// حفظ البيانات الجغرافية
router.post('/', async (req, res) => {
    try {
        const { data } = req.body;
        
        if (!data) {
            return res.status(400).json({ error: 'بيانات ناقصة' });
        }
        
        for (let center in data) {
            if (centerGeoData[center]) {
                centerGeoData[center].center = data[center].center;
                centerGeoData[center].radius = data[center].radius;
                centerGeoData[center].address = data[center].address || centerGeoData[center].address;
            }
        }
        
        res.json({ success: true, message: 'تم حفظ مواقع المراكز بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في حفظ مواقع المراكز' });
    }
});

// تحديد موقع البلاغ
router.post('/locate', (req, res) => {
    const { lat, lng } = req.body;
    
    if (!lat || !lng) {
        return res.status(400).json({ error: 'إحداثيات غير صالحة' });
    }
    
    let foundCenter = null;
    let minDistance = Infinity;
    
    for (let center in centerGeoData) {
        const data = centerGeoData[center];
        const distance = getDistance(lat, lng, data.center[0], data.center[1]);
        
        if (distance < data.radius && distance < minDistance) {
            minDistance = distance;
            foundCenter = center;
        }
    }
    
    res.json({
        success: true,
        center: foundCenter,
        distance: minDistance,
        location: foundCenter ? centerGeoData[foundCenter].address : 'غير معروف'
    });
});

module.exports = router;