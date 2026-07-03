const { run, get, all } = require('./database.js');

/* ============================================================
   Team 3: SQLite CRUD Operations for EMS Platform (منصة الجنوب)
   Tables: announcements, ops_files, hospitals, references_table, timeline
   ============================================================ */

/* ────────────────────────────────────────────
   ANNOUNCEMENTS
   ──────────────────────────────────────────── */

async function readAnnouncements() {
  try {
    const rows = await all('SELECT * FROM announcements ORDER BY pinned DESC, date DESC');
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      body: r.body,
      date: r.date,
      pinned: !!r.pinned,
      urgent: !!r.urgent
    }));
  } catch (err) {
    console.error('❌ خطأ في قراءة الإعلانات:', err.message);
    return [];
  }
}

async function writeAnnouncements(data) {
  if (!Array.isArray(data)) throw new Error('بيانات الإعلانات يجب أن تكون مصفوفة');
  try {
    await run('DELETE FROM announcements');
    for (const a of data) {
      await run(
        `INSERT INTO announcements (id, title, body, date, pinned, urgent)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, body=excluded.body, date=excluded.date,
           pinned=excluded.pinned, urgent=excluded.urgent`,
        [a.id, a.title, a.body, a.date || new Date().toISOString().split('T')[0], a.pinned ? 1 : 0, a.urgent ? 1 : 0]
      );
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حفظ الإعلانات:', err.message);
    throw err;
  }
}

async function addAnnouncement(announcement) {
  const { title, body, date, pinned, urgent } = announcement;
  const id = Date.now().toString();
  try {
    await run(
      `INSERT INTO announcements (id, title, body, date, pinned, urgent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, title, body, date || new Date().toISOString().split('T')[0], pinned ? 1 : 0, urgent ? 1 : 0]
    );
    return { id, title, body, date, pinned, urgent };
  } catch (err) {
    console.error('❌ خطأ في إضافة الإعلان:', err.message);
    throw err;
  }
}

async function deleteAnnouncement(id) {
  try {
    const result = await run('DELETE FROM announcements WHERE id = ?', [id]);
    if (result.changes === 0) {
      throw new Error('الإعلان غير موجود');
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حذف الإعلان:', err.message);
    throw err;
  }
}

/* ────────────────────────────────────────────
   OPS FILES
   ──────────────────────────────────────────── */

async function readOpsMetadata() {
  try {
    const rows = await all('SELECT * FROM ops_files ORDER BY upload_date DESC');
    return rows.map(r => ({
      id: r.id,
      filename: r.filename,
      storedName: r.stored_name,
      size: r.size,
      mimeType: r.mime_type,
      uploadDate: r.upload_date,
      uploader: r.uploader,
      category: r.category,
      note: r.note,
      icon: r.icon
    }));
  } catch (err) {
    console.error('❌ خطأ في قراءة ملفات العمليات:', err.message);
    return [];
  }
}

async function writeOpsMetadata(data) {
  if (!Array.isArray(data)) throw new Error('بيانات الملفات يجب أن تكون مصفوفة');
  try {
    await run('DELETE FROM ops_files');
    for (const f of data) {
      await run(
        `INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           filename=excluded.filename, stored_name=excluded.stored_name, size=excluded.size,
           mime_type=excluded.mime_type, upload_date=excluded.upload_date, uploader=excluded.uploader,
           category=excluded.category, note=excluded.note, icon=excluded.icon`,
        [f.id, f.filename, f.storedName || f.stored_name, f.size || 0, f.mimeType || f.mime_type,
         f.uploadDate || f.upload_date, f.uploader, f.category || 'عام', f.note || '', f.icon || '']
      );
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حفظ ملفات العمليات:', err.message);
    throw err;
  }
}

async function addOpsFile(entry) {
  try {
    await run(
      `INSERT INTO ops_files (id, filename, stored_name, size, mime_type, upload_date, uploader, category, note, icon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.filename, entry.storedName || entry.stored_name, entry.size || 0,
       entry.mimeType || entry.mime_type, entry.uploadDate || entry.upload_date,
       entry.uploader, entry.category || 'عام', entry.note || '', entry.icon || '']
    );
    return entry;
  } catch (err) {
    console.error('❌ خطأ في إضافة ملف العمليات:', err.message);
    throw err;
  }
}

async function deleteOpsFile(id) {
  try {
    const result = await run('DELETE FROM ops_files WHERE id = ?', [id]);
    if (result.changes === 0) {
      throw new Error('الملف غير موجود');
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حذف ملف العمليات:', err.message);
    throw err;
  }
}

async function getOpsFileById(id) {
  try {
    const row = await get('SELECT * FROM ops_files WHERE id = ?', [id]);
    if (!row) return null;
    return {
      id: row.id,
      filename: row.filename,
      storedName: row.stored_name,
      size: row.size,
      mimeType: row.mime_type,
      uploadDate: row.upload_date,
      uploader: row.uploader,
      category: row.category,
      note: row.note,
      icon: row.icon
    };
  } catch (err) {
    console.error('❌ خطأ في جلب ملف العمليات:', err.message);
    throw err;
  }
}

/* ────────────────────────────────────────────
   HOSPITALS
   ──────────────────────────────────────────── */

async function readHospitals() {
  try {
    const rows = await all('SELECT * FROM hospitals ORDER BY name');
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      specialty: r.specialty,
      address: r.address,
      phone: r.phone,
      emergency: r.emergency,
      hours: r.hours,
      lat: r.lat,
      lng: r.lng
    }));
  } catch (err) {
    console.error('❌ خطأ في قراءة المستشفيات:', err.message);
    return [];
  }
}

async function writeHospitals(data) {
  if (!Array.isArray(data)) throw new Error('بيانات المستشفيات يجب أن تكون مصفوفة');
  try {
    await run('DELETE FROM hospitals');
    for (const h of data) {
      await run(
        `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [h.name, h.type, h.specialty, h.address, h.phone, h.emergency, h.hours, h.lat, h.lng]
      );
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حفظ المستشفيات:', err.message);
    throw err;
  }
}

async function addHospital(hospital) {
  try {
    const result = await run(
      `INSERT INTO hospitals (name, type, specialty, address, phone, emergency, hours, lat, lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [hospital.name, hospital.type, hospital.specialty, hospital.address,
       hospital.phone, hospital.emergency, hospital.hours, hospital.lat, hospital.lng]
    );
    return { id: result.lastID, ...hospital };
  } catch (err) {
    console.error('❌ خطأ في إضافة المستشفى:', err.message);
    throw err;
  }
}

async function deleteHospital(id) {
  try {
    const result = await run('DELETE FROM hospitals WHERE id = ?', [id]);
    if (result.changes === 0) throw new Error('المستشفى غير موجود');
    return true;
  } catch (err) {
    console.error('❌ خطأ في حذف المستشفى:', err.message);
    throw err;
  }
}

/* ────────────────────────────────────────────
   REFERENCES (renamed to references_table — SQL reserved word)
   ──────────────────────────────────────────── */

async function readReferences() {
  try {
    const rows = await all('SELECT * FROM references_table ORDER BY date DESC, title');
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      type: r.type,
      dept: r.dept,
      status: r.status,
      desc: r.desc,
      date: r.date
    }));
  } catch (err) {
    console.error('❌ خطأ في قراءة المراجع:', err.message);
    return [];
  }
}

async function writeReferences(data) {
  if (!Array.isArray(data)) throw new Error('بيانات المراجع يجب أن تكون مصفوفة');
  try {
    await run('DELETE FROM references_table');
    for (const r of data) {
      await run(
        `INSERT INTO references_table (title, type, dept, status, desc, date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [r.title, r.type, r.dept, r.status, r.desc, r.date]
      );
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حفظ المراجع:', err.message);
    throw err;
  }
}

async function addReference(reference) {
  try {
    const result = await run(
      `INSERT INTO references_table (title, type, dept, status, desc, date)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [reference.title, reference.type, reference.dept, reference.status, reference.desc, reference.date]
    );
    return { id: result.lastID, ...reference };
  } catch (err) {
    console.error('❌ خطأ في إضافة المرجع:', err.message);
    throw err;
  }
}

async function deleteReference(id) {
  try {
    const result = await run('DELETE FROM references_table WHERE id = ?', [id]);
    if (result.changes === 0) throw new Error('المرجع غير موجود');
    return true;
  } catch (err) {
    console.error('❌ خطأ في حذف المرجع:', err.message);
    throw err;
  }
}

/* ────────────────────────────────────────────
   TIMELINE
   ──────────────────────────────────────────── */

async function readTimeline() {
  try {
    const rows = await all('SELECT * FROM timeline ORDER BY date DESC, time DESC');
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      desc: r.desc,
      type: r.type,
      date: r.date,
      time: r.time
    }));
  } catch (err) {
    console.error('❌ خطأ في قراءة الخط الزمني:', err.message);
    return [];
  }
}

async function writeTimeline(data) {
  if (!Array.isArray(data)) throw new Error('بيانات الخط الزمني يجب أن تكون مصفوفة');
  try {
    await run('DELETE FROM timeline');
    for (const t of data) {
      await run(
        `INSERT INTO timeline (title, desc, type, date, time)
         VALUES (?, ?, ?, ?, ?)`,
        [t.title, t.desc, t.type, t.date, t.time]
      );
    }
    return true;
  } catch (err) {
    console.error('❌ خطأ في حفظ الخط الزمني:', err.message);
    throw err;
  }
}

async function addTimeline(entry) {
  try {
    const result = await run(
      `INSERT INTO timeline (title, desc, type, date, time)
       VALUES (?, ?, ?, ?, ?)`,
      [entry.title, entry.desc, entry.type, entry.date, entry.time]
    );
    return { id: result.lastID, ...entry };
  } catch (err) {
    console.error('❌ خطأ في إضافة حدث للخط الزمني:', err.message);
    throw err;
  }
}

async function deleteTimeline(id) {
  try {
    const result = await run('DELETE FROM timeline WHERE id = ?', [id]);
    if (result.changes === 0) throw new Error('الحدث غير موجود');
    return true;
  } catch (err) {
    console.error('❌ خطأ في حذف حدث الخط الزمني:', err.message);
    throw err;
  }
}

/* ============================================================
   EXPORTS
   ============================================================ */
module.exports = {
  // Announcements
  readAnnouncements,
  writeAnnouncements,
  addAnnouncement,
  deleteAnnouncement,
  // Ops Files
  readOpsMetadata,
  writeOpsMetadata,
  addOpsFile,
  deleteOpsFile,
  getOpsFileById,
  // Hospitals
  readHospitals,
  writeHospitals,
  addHospital,
  deleteHospital,
  // References
  readReferences,
  writeReferences,
  addReference,
  deleteReference,
  // Timeline
  readTimeline,
  writeTimeline,
  addTimeline,
  deleteTimeline
};
