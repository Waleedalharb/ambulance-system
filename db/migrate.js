const fs = require('fs');
const path = require('path');
const { initDb, run, get, all, close } = require('./database.js');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(__dirname, '..', 'database.db');

function readJsonFile(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.log(`⚠️ ملف غير موجود: ${filename} — سيتم تخطي الترحيل لهذا الجدول`);
    return null;
  }
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.log(`⚠️ خطأ في قراءة ${filename}: ${err.message}`);
    return null;
  }
}

async function migrateUsers() {
  const data = readJsonFile('users.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const u of data) {
    await run(
      `INSERT INTO users (user_id, username, password, name, role, is_active, created_at, last_login)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.username, u.password, u.name, u.role, u.isActive ? 1 : 0, u.createdAt, u.lastLogin]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} مستخدم`);
  return count;
}

async function migrateAuditLogs() {
  const data = readJsonFile('audit-log.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const log of data) {
    await run(
      `INSERT INTO audit_logs (log_id, action, details, user_id, username, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [log.id, log.action, log.details, log.userId, log.username, log.timestamp]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} سجل عملية`);
  return count;
}

async function migrateAirAmbulance() {
  const data = readJsonFile('air-ambulance.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const r of data) {
    await run(
      `INSERT INTO air_ambulance_records (record_id, report_number, unit, hospital, date_time, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [r.id, r.reportNumber, r.unit, r.hospital, r.dateTime, r.notes, r.createdAt]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} سجل إسعاف جوي`);
  return count;
}

async function migratePeakData() {
  const data = readJsonFile('peak-data.json');
  if (!data || typeof data !== 'object') return 0;
  let count = 0;

  if (Array.isArray(data.missions)) {
    for (const m of data.missions) {
      await run(
        `INSERT INTO peak_missions (mission_id, location, lat, lng, unit, start_time, end_time, priority, notes, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.id, m.location, parseFloat(m.lat), parseFloat(m.lng), m.unit, m.startTime, m.endTime, m.priority, m.notes, m.status, m.createdAt]
      );
      count++;
    }
    console.log(`✅ تم ترحيل ${data.missions.length} مهمة ذروة`);
  }

  if (Array.isArray(data.alerts)) {
    let alertCount = 0;
    for (const a of data.alerts) {
      await run(
        `INSERT INTO peak_alerts (alert_id, title, details, priority, unit, location, start_time, end_time, notes, lat, lng, radius, mission_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [a.id, a.title, a.details, a.priority, a.unit, a.location, a.startTime, a.endTime, a.notes, parseFloat(a.lat), parseFloat(a.lng), a.radius, a.missionId, a.status, a.createdAt]
      );
      alertCount++;
    }
    console.log(`✅ تم ترحيل ${alertCount} تنبيه ذروة`);
    count += alertCount;
  }

  if (Array.isArray(data.logs)) {
    let logCount = 0;
    for (const l of data.logs) {
      await run(
        `INSERT INTO peak_logs (log_id, icon, action, details, priority, time, date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [l.id, l.icon, l.action, l.details, l.priority, l.time, l.date, l.date]
      );
      logCount++;
    }
    console.log(`✅ تم ترحيل ${logCount} سجل ذروة`);
    count += logCount;
  }

  return count;
}

async function migrateControlNotes() {
  const data = readJsonFile('control-notes.json');
  if (!data || typeof data !== 'object') return 0;
  const notes = data.notes || '';
  await run(
    `INSERT INTO control_notes (id, notes, updated_at) VALUES (1, ?, ?)`,
    [notes, new Date().toISOString()]
  );
  console.log(`✅ تم ترحيل ملاحظات التحكم`);
  return 1;
}

async function migrateVacations() {
  const data = readJsonFile('vacations.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const v of data) {
    await run(
      `INSERT INTO vacations (name, start_date, end_date, type, created_at) VALUES (?, ?, ?, ?, ?)`,
      [v.name, v.startDate, v.endDate, v.type, v.createdAt]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} إجازة`);
  return count;
}

async function migrateDocs() {
  const data = readJsonFile('docs.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const d of data) {
    await run(
      `INSERT INTO docs (doc_id, filename, file_data, file_type, description, category, priority, uploader, upload_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.id, d.filename, d.fileData, d.fileType, d.description, d.category, d.priority, d.uploader, d.uploadDate]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} وثيقة`);
  return count;
}

async function migrateSoundSettings() {
  const data = readJsonFile('sound-settings.json');
  if (!data || typeof data !== 'object') return 0;
  let count = 0;
  for (const userId of Object.keys(data)) {
    const s = data[userId];
    await run(
      `INSERT INTO sound_settings (user_id, enabled, volume, updated_at) VALUES (?, ?, ?, ?)`,
      [userId, s.enabled ? 1 : 0, s.volume, s.updatedAt]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} إعداد صوت`);
  return count;
}

async function migrateThemeSettings() {
  const data = readJsonFile('theme-settings.json');
  if (!data || typeof data !== 'object') return 0;
  await run(
    `INSERT INTO theme_settings (id, file_type, file_name, logo_file_name, logo_file_type, updated_at) VALUES (1, ?, ?, ?, ?, ?)`,
    [data.fileType || null, data.fileName || null, data.logoFileName || null, data.logoFileType || null, data.updatedAt || new Date().toISOString()]
  );
  console.log(`✅ تم ترحيل إعدادات الثيم`);
  return 1;
}

async function migratePasswordSettings() {
  const data = readJsonFile('password.json');
  if (!data || typeof data !== 'object') return 0;
  const password = data.password || '';
  await run(
    `INSERT INTO password_settings (id, password, updated_at) VALUES (1, ?, ?)`,
    [password, new Date().toISOString()]
  );
  console.log(`✅ تم ترحيل إعدادات كلمة المرور`);
  return 1;
}

async function migrateReports() {
  const data = readJsonFile('ambulance-data.json');
  if (!data || typeof data !== 'object') return 0;
  let count = 0;
  let timeCount = 0;
  for (const key of Object.keys(data)) {
    const [center, unit] = key.split('|');
    const item = data[key];
    const result = await run(
      `INSERT INTO reports (center, unit, count) VALUES (?, ?, ?)`,
      [center, unit, item.count || 0]
    );
    const reportId = result.lastID;
    count++;
    if (Array.isArray(item.times)) {
      for (const t of item.times) {
        await run(
          `INSERT INTO report_times (report_id, timestamp) VALUES (?, ?)`,
          [reportId, t]
        );
        timeCount++;
      }
    }
  }
  console.log(`✅ تم ترحيل ${count} بلاغ مع ${timeCount} توقيت`);
  return count;
}

async function migrateShifts() {
  const data = readJsonFile('shift-data.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  let reportCount = 0;
  for (const shift of data) {
    const result = await run(
      `INSERT INTO shifts (shift_name, shift_date, shift_time, shift_type, start_time, total_reports, rapid_locations, centers_data, general_notes, last_update)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        shift.shiftName,
        shift.shiftDate,
        shift.shiftTime,
        shift.shiftType,
        shift.startTime,
        shift.totalReports || 0,
        JSON.stringify(shift.rapidLocations || {}),
        JSON.stringify(shift.centersData || {}),
        shift.generalNotes || '',
        shift.lastUpdate
      ]
    );
    const shiftId = result.lastID;
    count++;

    if (shift.savedReports && typeof shift.savedReports === 'object') {
      for (const key of Object.keys(shift.savedReports)) {
        const [center, unit] = key.split('|');
        const r = shift.savedReports[key];
        await run(
          `INSERT INTO shift_reports (shift_id, center, unit, count, times) VALUES (?, ?, ?, ?, ?)`,
          [shiftId, center, unit, r.count || 0, JSON.stringify(r.times || [])]
        );
        reportCount++;
      }
    }
  }
  console.log(`✅ تم ترحيل ${count} مناوبة مع ${reportCount} بلاغ محفوظ`);
  return count;
}

/* ============================================================
   Team 3: Migration for announcements, ops_files, hospitals,
           references, and timeline
   ============================================================ */

async function migrateAnnouncements() {
  const data = readJsonFile('announcements.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const a of data) {
    await run(
      `INSERT INTO announcements (id, title, body, date, pinned, urgent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, body=excluded.body, date=excluded.date,
         pinned=excluded.pinned, urgent=excluded.urgent`,
      [
        a.id || (Date.now().toString() + count),
        a.title,
        a.body,
        a.date || new Date().toISOString().split('T')[0],
        a.pinned ? 1 : 0,
        a.urgent ? 1 : 0
      ]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} إعلان`);
  return count;
}

async function migrateOpsFiles() {
  const data = readJsonFile('uploads/operational/metadata.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const f of data) {
    await run(
      `INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         filename=excluded.filename, stored_name=excluded.stored_name, size=excluded.size,
         mime_type=excluded.mime_type, upload_date=excluded.upload_date, uploader=excluded.uploader,
         category=excluded.category, note=excluded.note, icon=excluded.icon`,
      [
        f.id,
        f.filename,
        f.storedName || f.stored_name,
        f.size || 0,
        f.mimeType || f.mime_type,
        f.uploadDate || f.upload_date,
        f.uploader,
        f.category || 'عام',
        f.note || '',
        f.icon || ''
      ]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} ملف تشغيلي`);
  return count;
}

async function migrateHospitals() {
  const data = readJsonFile('hospitals.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const h of data) {
    await run(
      `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        h.name,
        h.type,
        h.specialty,
        h.address,
        h.phone,
        h.emergency,
        h.hours,
        h.lat ? parseFloat(h.lat) : null,
        h.lng ? parseFloat(h.lng) : null
      ]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} مستشفى`);
  return count;
}

async function migrateReferences() {
  const data = readJsonFile('references.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const r of data) {
    await run(
      `INSERT INTO references_table (title, type, dept, status, desc, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.title, r.type, r.dept, r.status, r.desc, r.date]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} مرجعية`);
  return count;
}

async function migrateTimeline() {
  const data = readJsonFile('timeline.json');
  if (!data || !Array.isArray(data)) return 0;
  let count = 0;
  for (const t of data) {
    await run(
      `INSERT INTO timeline (title, desc, type, date, time)
       VALUES (?, ?, ?, ?, ?)`,
      [t.title, t.desc, t.type, t.date, t.time]
    );
    count++;
  }
  console.log(`✅ تم ترحيل ${count} حدث زمني`);
  return count;
}

async function main() {
  console.log('🚀 بدء ترحيل البيانات إلى SQLite...\n');

  try {
    await initDb(DB_PATH);
    console.log('✅ تم فتح قاعدة البيانات وتفعيل WAL\n');

    console.log('📦 جارٍ ترحيل المستخدمين...');
    await migrateUsers();

    console.log('📦 جارٍ ترحيل سجلات العمليات...');
    await migrateAuditLogs();

    console.log('📦 جارٍ ترحيل البلاغات...');
    await migrateReports();

    console.log('📦 جارٍ ترحيل المناوبات...');
    await migrateShifts();

    console.log('📦 جارٍ ترحيل الإسعاف الجوي...');
    await migrateAirAmbulance();

    console.log('📦 جارٍ ترحيل بيانات الذروة...');
    await migratePeakData();

    console.log('📦 جارٍ ترحيل ملاحظات التحكم...');
    await migrateControlNotes();

    console.log('📦 جارٍ ترحيل الإجازات...');
    await migrateVacations();

    console.log('📦 جارٍ ترحيل الوثائق...');
    await migrateDocs();

    console.log('📦 جارٍ ترحيل إعدادات الصوت...');
    await migrateSoundSettings();

    console.log('📦 جارٍ ترحيل إعدادات الثيم...');
    await migrateThemeSettings();

    console.log('📦 جارٍ ترحيل إعدادات كلمة المرور...');
    await migratePasswordSettings();

    console.log('📦 جارٍ ترحيل الإعلانات...');
    await migrateAnnouncements();

    console.log('📦 جارٍ ترحيل ملفات العمليات...');
    await migrateOpsFiles();

    console.log('📦 جارٍ ترحيل المستشفيات...');
    await migrateHospitals();

    console.log('📦 جارٍ ترحيل المراجع...');
    await migrateReferences();

    console.log('📦 جارٍ ترحيل الخط الزمني...');
    await migrateTimeline();

    console.log('\n🎉 اكتمل الترحيل بنجاح!');
    console.log(`📁 قاعدة البيانات: ${DB_PATH}`);
    console.log('💾 ملفات JSON محفوظة كنسخة احتياطية.');
  } catch (err) {
    console.error('\n❌ فشل الترحيل:', err.message);
    process.exit(1);
  } finally {
    await close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
