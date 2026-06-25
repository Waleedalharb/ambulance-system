// ============================================
// إعدادات قاعدة البيانات (ملفات JSON)
// ============================================

const path = require('path');

// مسار تخزين البيانات - Render Disk Storage
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');

const PATHS = {
    DATA_DIR,
    BACKUP_DIR: path.join(DATA_DIR, 'backups'),
    TEMP_DIR: path.join(DATA_DIR, 'temp'),
    DATA_PATH: path.join(DATA_DIR, 'ambulance-data.json'),
    SHIFT_DATA_PATH: path.join(DATA_DIR, 'shift-data.json'),
    MONTHLY_TABLE_PATH: path.join(DATA_DIR, 'monthly-table.xlsx'),
    DOCS_PATH: path.join(DATA_DIR, 'docs.json'),
    AIR_PATH: path.join(DATA_DIR, 'air-ambulance.json'),
    IDENTITY_PATH: path.join(DATA_DIR, 'identity.pdf'),
    CONTROL_NOTES_PATH: path.join(DATA_DIR, 'control-notes.json'),
    VACATIONS_PATH: path.join(DATA_DIR, 'vacations.json'),
    PASSWORD_PATH: path.join(DATA_DIR, 'password.json'),
    PEAK_DATA_PATH: path.join(DATA_DIR, 'peak-data.json'),
    ESCALATION_PATH: path.join(DATA_DIR, 'escalation-data.json'),
    THEME_PATH: path.join(DATA_DIR, 'theme-data.json')
};

module.exports = {
    DATA_DIR,
    PATHS
};