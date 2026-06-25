// ============================================
// مسارات API: المصادقة
// ============================================

const express = require('express');
const router = express.Router();
const { readPassword, writePassword } = require('../models/dataModel');

// جلب الرقم السري
router.get('/password', async (req, res) => {
    try {
        const password = await readPassword();
        res.json({ success: true, password });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب الرقم السري' });
    }
});

// تغيير الرقم السري
router.post('/change-password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const currentPassword = await readPassword();
        
        if (oldPassword !== currentPassword) {
            return res.status(400).json({ error: 'الرقم السري القديم غير صحيح' });
        }
        
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ error: 'الرقم السري الجديد يجب أن يكون 4 أحرف على الأقل' });
        }
        
        await writePassword(newPassword);
        res.json({ success: true, message: 'تم تغيير الرقم السري بنجاح' });
    } catch (error) {
        res.status(500).json({ error: 'فشل في تغيير الرقم السري' });
    }
});

module.exports = router;