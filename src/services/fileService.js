// ============================================
// خدمة قراءة وكتابة الملفات مع Backup تلقائي
// ============================================

const fs = require('fs').promises;
const path = require('path');
const { PATHS } = require('../config/database');
const { MAX_BACKUPS } = require('../config/constants');
const { readJSON, writeJSON, ensureDir } = require('../utils/fileUtils');

let lastUpdateTime = Date.now();

// التأكد من وجود المجلدات
async function initializeStorage() {
    await ensureDir(PATHS.DATA_DIR);
    await ensureDir(PATHS.BACKUP_DIR);
    await ensureDir(PATHS.TEMP_DIR);
    console.log('✅ تم التأكد من وجود مجلدات البيانات');
}

// قراءة البيانات مع التحقق من وجود الملف
async function readDataFile(filePath, defaultData = {}) {
    return await readJSON(filePath, defaultData);
}

// كتابة البيانات مع Backup تلقائي
async function writeDataFile(filePath, data) {
    // 1. حفظ البيانات في الملف الأساسي
    await writeJSON(filePath, data);
    
    // 2. إنشاء نسخة احتياطية
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = path.basename(filePath, path.extname(filePath));
    const backupFileName = `${fileName}_backup_${timestamp}.json`;
    const backupFilePath = path.join(PATHS.BACKUP_DIR, backupFileName);
    await writeJSON(backupFilePath, data);
    
    // 3. تنظيف النسخ الاحتياطية القديمة
    await cleanOldBackups(fileName);
    
    // 4. تحديث وقت آخر تحديث
    lastUpdateTime = Date.now();
    
    console.log(`✅ تم حفظ البيانات في: ${filePath}`);
    console.log(`📦 نسخة احتياطية: ${backupFilePath}`);
    
    return true;
}

// تنظيف النسخ الاحتياطية القديمة
async function cleanOldBackups(fileName) {
    try {
        const files = await fs.readdir(PATHS.BACKUP_DIR);
        const backupFiles = files
            .filter(f => f.startsWith(fileName) && f.endsWith('.json'))
            .sort()
            .reverse();
        
        const filesToDelete = backupFiles.slice(MAX_BACKUPS);
        for (const file of filesToDelete) {
            const filePath = path.join(PATHS.BACKUP_DIR, file);
            await fs.unlink(filePath);
            console.log(`🗑️ تم حذف نسخة احتياطية قديمة: ${file}`);
        }
    } catch (error) {
        console.error('⚠️ خطأ في تنظيف النسخ الاحتياطية:', error);
    }
}

// الحصول على آخر تحديث
function getLastUpdateTime() {
    return lastUpdateTime;
}

module.exports = {
    initializeStorage,
    readDataFile,
    writeDataFile,
    cleanOldBackups,
    getLastUpdateTime
};