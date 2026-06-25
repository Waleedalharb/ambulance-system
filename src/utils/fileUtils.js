// ============================================
// دوال مساعدة للملفات
// ============================================

const fs = require('fs').promises;

async function ensureDir(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
        return true;
    } catch (error) {
        console.error(`❌ خطأ في إنشاء المجلد ${dirPath}:`, error);
        return false;
    }
}

async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function readJSON(filePath, defaultData = {}) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultData;
        }
        throw error;
    }
}

async function writeJSON(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

module.exports = {
    ensureDir,
    fileExists,
    readJSON,
    writeJSON
};