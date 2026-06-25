// ============================================
// مسارات API: النسخ الاحتياطية
// ============================================

const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { PATHS } = require('../config/database');
const {
    readData, writeData,
    readShifts, writeShifts,
    readDocs, writeDocs,
    readAirRecords, writeAirRecords,
    readPeakData, writePeakData,
    readEscalations, writeEscalations,
    readThemeData, writeThemeData
} = require('../models/dataModel');
const { readDataFile, writeDataFile } = require('../services/fileService');

// تصدير جميع البيانات
router.get('/export', async (req, res) => {
    try {
        const allData = {
            exportedAt: new Date().toISOString(),
            exportedAtDisplay: new Date().toLocaleString('ar-SA'),
            version: '2.1.0',
            data: {
                reports: await readData(),
                shifts: await readShifts(),
                docs: await readDocs(),
                airRecords: await readAirRecords(),
                peakData: await readPeakData(),
                escalations: await readEscalations(),
                controlNotes: await readDataFile(PATHS.CONTROL_NOTES_PATH, { notes: '' }),
                vacations: await readDataFile(PATHS.VACATIONS_PATH, []),
                themeData: await readThemeData()
            }
        };
        
        res.json({ success: true, data: allData });
    } catch (error) {
        console.error('❌ خطأ في تصدير البيانات:', error);
        res.status(500).json({ error: 'فشل في تصدير البيانات' });
    }
});

// استيراد جميع البيانات
router.post('/import', async (req, res) => {
    try {
        const { data } = req.body;
        
        if (!data || !data.data) {
            return res.status(400).json({ error: 'بيانات غير صالحة' });
        }
        
        const importedData = data.data;
        
        if (importedData.reports) await writeData(importedData.reports);
        if (importedData.shifts) await writeShifts(importedData.shifts);
        if (importedData.docs) await writeDocs(importedData.docs);
        if (importedData.airRecords) await writeAirRecords(importedData.airRecords);
        if (importedData.peakData) await writePeakData(importedData.peakData);
        if (importedData.escalations) await writeEscalations(importedData.escalations);
        if (importedData.controlNotes) await writeDataFile(PATHS.CONTROL_NOTES_PATH, importedData.controlNotes);
        if (importedData.vacations) await writeDataFile(PATHS.VACATIONS_PATH, importedData.vacations);
        if (importedData.themeData) await writeThemeData(importedData.themeData);
        
        res.json({ success: true, message: '✅ تم استعادة جميع البيانات بنجاح' });
    } catch (error) {
        console.error('❌ خطأ في استيراد البيانات:', error);
        res.status(500).json({ error: 'فشل في استيراد البيانات: ' + error.message });
    }
});

// قائمة النسخ الاحتياطية
router.get('/list', async (req, res) => {
    try {
        const files = await fs.readdir(PATHS.BACKUP_DIR);
        const backups = files
            .filter(f => f.endsWith('.json'))
            .map(f => {
                const stats = fs.statSync(path.join(PATHS.BACKUP_DIR, f));
                return {
                    fileName: f,
                    size: stats.size,
                    createdAt: stats.birthtime,
                    createdAtDisplay: stats.birthtime.toLocaleString('ar-SA')
                };
            })
            .sort((a, b) => b.createdAt - a.createdAt);
        
        res.json({ success: true, backups });
    } catch (error) {
        res.status(500).json({ error: 'فشل في جلب قائمة النسخ الاحتياطية' });
    }
});

// استعادة نسخة احتياطية
router.post('/restore', async (req, res) => {
    try {
        const { fileName } = req.body;
        
        if (!fileName) {
            return res.status(400).json({ error: 'اسم الملف مطلوب' });
        }
        
        const backupFilePath = path.join(PATHS.BACKUP_DIR, fileName);
        const data = await fs.readFile(backupFilePath, 'utf8');
        const parsedData = JSON.parse(data);
        
        if (fileName.startsWith('ambulance-data')) {
            await writeData(parsedData);
        } else if (fileName.startsWith('shift-data')) {
            await writeShifts(parsedData);
        } else if (fileName.startsWith('docs')) {
            await writeDocs(parsedData);
        } else if (fileName.startsWith('air-ambulance')) {
            await writeAirRecords(parsedData);
        } else if (fileName.startsWith('peak-data')) {
            await writePeakData(parsedData);
        } else if (fileName.startsWith('escalation-data')) {
            await writeEscalations(parsedData);
        } else if (fileName.startsWith('theme-data')) {
            await writeThemeData(parsedData);
        } else {
            return res.status(400).json({ error: 'نوع الملف غير معروف' });
        }
        
        res.json({ success: true, message: `✅ تم استعادة النسخة الاحتياطية: ${fileName}` });
    } catch (error) {
        console.error('❌ خطأ في استعادة النسخة الاحتياطية:', error);
        res.status(500).json({ error: 'فشل في استعادة النسخة الاحتياطية' });
    }
});

module.exports = router;