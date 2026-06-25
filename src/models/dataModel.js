// ============================================
// نموذج البيانات الرئيسية
// ============================================

const { PATHS } = require('../config/database');
const { readDataFile, writeDataFile } = require('../services/fileService');

async function readData() {
    return await readDataFile(PATHS.DATA_PATH, {});
}

async function writeData(data) {
    await writeDataFile(PATHS.DATA_PATH, data);
}

async function readShifts() {
    return await readDataFile(PATHS.SHIFT_DATA_PATH, []);
}

async function writeShifts(data) {
    await writeDataFile(PATHS.SHIFT_DATA_PATH, data);
}

async function readDocs() {
    return await readDataFile(PATHS.DOCS_PATH, []);
}

async function writeDocs(data) {
    await writeDataFile(PATHS.DOCS_PATH, data);
}

async function readAirRecords() {
    return await readDataFile(PATHS.AIR_PATH, []);
}

async function writeAirRecords(data) {
    await writeDataFile(PATHS.AIR_PATH, data);
}

async function readPeakData() {
    return await readDataFile(PATHS.PEAK_DATA_PATH, { missions: [], alerts: [], logs: [] });
}

async function writePeakData(data) {
    await writeDataFile(PATHS.PEAK_DATA_PATH, data);
}

async function readEscalations() {
    return await readDataFile(PATHS.ESCALATION_PATH, []);
}

async function writeEscalations(data) {
    await writeDataFile(PATHS.ESCALATION_PATH, data);
}

async function readPassword() {
    const data = await readDataFile(PATHS.PASSWORD_PATH, { password: '1234' });
    return data.password || '1234';
}

async function writePassword(password) {
    await writeDataFile(PATHS.PASSWORD_PATH, { password, updatedAt: new Date().toISOString() });
}

async function readThemeData() {
    return await readDataFile(PATHS.THEME_PATH, { headerBg: null, headerBgType: null, sectorLogo: null, themeMode: 'off' });
}

async function writeThemeData(data) {
    await writeDataFile(PATHS.THEME_PATH, data);
}

module.exports = {
    readData,
    writeData,
    readShifts,
    writeShifts,
    readDocs,
    writeDocs,
    readAirRecords,
    writeAirRecords,
    readPeakData,
    writePeakData,
    readEscalations,
    writeEscalations,
    readPassword,
    writePassword,
    readThemeData,
    writeThemeData
};