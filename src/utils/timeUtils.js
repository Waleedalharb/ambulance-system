// ============================================
// دوال مساعدة للتوقيت
// ============================================

function getLocalTime(date = new Date()) {
    const d = new Date(date);
    d.setHours(d.getHours() + 3);
    return d;
}

function formatLocalDateTime(date) {
    if (!date) return '-';
    try {
        const d = new Date(date);
        d.setHours(d.getHours() + 3);
        return d.toISOString().slice(0, 16).replace('T', ' ');
    } catch(e) { return date; }
}

function formatLocalDate(date) {
    if (!date) return '-';
    try {
        const d = new Date(date);
        d.setHours(d.getHours() + 3);
        return d.toLocaleDateString('ar-SA');
    } catch(e) { return date; }
}

function formatLocalTime(date) {
    if (!date) return '-';
    try {
        const d = new Date(date);
        d.setHours(d.getHours() + 3);
        return d.toLocaleTimeString('ar-SA');
    } catch(e) { return date; }
}

function getCurrentTimestamp() {
    const now = new Date();
    const localNow = getLocalTime(now);
    return `${localNow.getUTCFullYear()}-${(localNow.getUTCMonth()+1).toString().padStart(2,'0')}-${localNow.getUTCDate().toString().padStart(2,'0')} ${localNow.getUTCHours().toString().padStart(2,'0')}:${localNow.getUTCMinutes().toString().padStart(2,'0')}:${localNow.getUTCSeconds().toString().padStart(2,'0')}`;
}

module.exports = {
    getLocalTime,
    formatLocalDateTime,
    formatLocalDate,
    formatLocalTime,
    getCurrentTimestamp
};