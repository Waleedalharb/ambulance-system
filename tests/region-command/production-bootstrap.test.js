'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, NOW } = require('./fixtures');
const { bootstrapRegionCommandProduction } = require('../../scripts/region-command-production-bootstrap');

const USER_ID = '102462';
const now = () => new Date(NOW);

function addPlatformTables(db) {
  db.hdl.exec(`
    CREATE TABLE users (user_id TEXT PRIMARY KEY, role TEXT NOT NULL, is_active INTEGER NOT NULL);
    CREATE TABLE teams (name TEXT NOT NULL, center TEXT, is_active INTEGER NOT NULL DEFAULT 1);
  `);
}

function addAdmin(db, userId = USER_ID) {
  db.hdl.prepare('INSERT INTO users(user_id, role, is_active) VALUES (?, ?, 1)').run(userId, 'admin');
}

function addCenter(db, id, name) {
  db.hdl.prepare('INSERT INTO centers(id, name) VALUES (?, ?)').run(id, name);
}

function addTeam(db, name, center) {
  db.hdl.prepare('INSERT INTO teams(name, center, is_active) VALUES (?, ?, 1)').run(name, center);
}

test('bootstrap creates only Riyadh sectors and derives center links from real teams', async () => {
  const db = createFixture({ seed: false });
  addPlatformTables(db);
  addAdmin(db);
  addCenter(db, 'C-SOUTH', 'مركز الجنوب');
  addCenter(db, 'C-EAST', 'مركز الشرق');
  addCenter(db, 'C-EXTRA', 'الفرق الإضافية');
  addTeam(db, 'R-3-1-1', 'مركز الجنوب');
  addTeam(db, 'جنوب 2', 'مركز الجنوب');
  addTeam(db, 'شرق 2', 'مركز الشرق');
  addTeam(db, 'R-5-2-4', 'الفرق الإضافية');
  addTeam(db, 'غير معروف 1', 'مركز آخر');

  // واجهة db.js الإنتاجية تصدّر tx ولا تصدّر handle الداخلي hdl.
  const result = await bootstrapRegionCommandProduction({ tx: db.tx }, { userId: USER_ID, account: { id: USER_ID, role: 'admin', isActive: 1 }, now });
  assert.equal(result.regionId, 'REGION-RIYADH');
  assert.equal(result.linkedCenters, 2);
  assert.deepEqual(result.centerCounts, { 1: 0, 2: 1, 3: 1, 4: 0, 5: 0 });
  assert.deepEqual(result.unmappedTeams, ['غير معروف 1']);
  assert.deepEqual(
    db.hdl.prepare('SELECT code FROM sectors WHERE region_id = ? ORDER BY code').all(result.regionId).map(row => row.code),
    ['1', '2', '3', '4', '5']
  );
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM sector_centers').get().count, 2);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM sector_centers WHERE center_id = ?').get('C-EXTRA').count, 0);
  const scope = db.hdl.prepare(`SELECT * FROM user_access_scopes
    WHERE user_id = ? AND scope_type = 'region' AND scope_id = ? AND effective_to IS NULL`).get(USER_ID, result.regionId);
  assert.equal(scope.status, 'active');
  db.close();
});

test('bootstrap is idempotent and reactivates an existing current scope', async () => {
  const db = createFixture({ seed: false });
  addPlatformTables(db);
  addAdmin(db);
  addCenter(db, 'C-SOUTH', 'مركز الجنوب');
  addTeam(db, 'R-3-1-1', 'مركز الجنوب');

  const first = await bootstrapRegionCommandProduction(db, { userId: USER_ID, account: { id: USER_ID, role: 'admin', isActive: true }, now });
  db.hdl.prepare('UPDATE user_access_scopes SET status = ? WHERE user_id = ?').run('suspended', USER_ID);
  const second = await bootstrapRegionCommandProduction(db, { userId: USER_ID, account: { id: USER_ID, role: 'admin', isActive: true }, now });

  assert.equal(first.linkedCenters, 1);
  assert.equal(second.linkedCenters, 0);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM regions').get().count, 1);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM sectors').get().count, 5);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM sector_centers').get().count, 1);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM user_access_scopes').get().count, 1);
  assert.equal(db.hdl.prepare('SELECT status FROM user_access_scopes WHERE user_id = ?').get(USER_ID).status, 'active');
  db.close();
});

test('bootstrap rejects a missing or non-admin account without writes', async () => {
  const db = createFixture({ seed: false });
  addPlatformTables(db);
  db.hdl.prepare('INSERT INTO users(user_id, role, is_active) VALUES (?, ?, 1)').run('viewer', 'user');

  await assert.rejects(
    bootstrapRegionCommandProduction(db, { userId: USER_ID, account: null, now }),
    /الحساب المعتمد غير موجود أو ليس مدير نظام نشطًا/
  );
  await assert.rejects(
    bootstrapRegionCommandProduction(db, {
      userId: 'viewer', account: { id: 'viewer', role: 'user', isActive: true }, now
    }),
    /الحساب المعتمد غير موجود أو ليس مدير نظام نشطًا/
  );
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM regions').get().count, 0);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM user_access_scopes').get().count, 0);
  db.close();
});

test('bootstrap refuses to override a current center assignment and rolls back', async () => {
  const db = createFixture({ seed: false });
  addPlatformTables(db);
  addAdmin(db);
  addCenter(db, 'C-SOUTH', 'مركز الجنوب');
  addTeam(db, 'R-3-1-1', 'مركز الجنوب');
  db.hdl.prepare('INSERT INTO regions(id, code, name, status, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('R-EXISTING', 'R', 'منطقة الرياض', 'active', NOW);
  const sector = db.hdl.prepare('INSERT INTO sectors(id, region_id, code, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  sector.run('EAST-EXISTING', 'R-EXISTING', '2', 'قطاع شرق مدينة الرياض', 'active', NOW);
  sector.run('SOUTH-EXISTING', 'R-EXISTING', '3', 'قطاع جنوب الرياض', 'active', NOW);
  db.hdl.prepare(`INSERT INTO sector_centers(id, sector_id, center_id, effective_from, created_at)
    VALUES (?, ?, ?, ?, ?)`).run('SC-EXISTING', 'EAST-EXISTING', 'C-SOUTH', NOW, NOW);

  await assert.rejects(
    bootstrapRegionCommandProduction(db, { userId: USER_ID, account: { id: USER_ID, role: 'admin', isActive: true }, now }),
    /مركز الجنوب مرتبط حاليًا بقطاع آخر/
  );
  assert.equal(db.hdl.prepare('SELECT sector_id FROM sector_centers WHERE id = ?').get('SC-EXISTING').sector_id, 'EAST-EXISTING');
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM sectors').get().count, 2);
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS count FROM user_access_scopes').get().count, 0);
  db.close();
});
