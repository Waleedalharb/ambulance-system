'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFixture, grant } = require('./fixtures');

test('additive schema preserves existing tables and creates required objects', () => {
  const db = createFixture({ seed: false });
  db.hdl.prepare('INSERT INTO baseline_probe(id, value) VALUES (?, ?)').run('keep', 'unchanged');
  const names = db.hdl.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger','index')").all().map(r => r.name);
  for (const name of ['regions', 'sectors', 'sector_centers', 'user_access_scopes', 'sector_command_counters', 'sector_command_ledger', 'trg_sector_ledger_no_update', 'trg_sector_ledger_no_delete', 'uq_sector_centers_current_center']) assert.ok(names.includes(name), name);
  assert.equal(db.hdl.prepare('SELECT value FROM baseline_probe WHERE id = ?').get('keep').value, 'unchanged');
  assert.equal(db.hdl.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(db.hdl.pragma('foreign_key_check'), []);
  db.close();
});

test('current and historical center assignments cannot overlap', () => {
  const db = createFixture();
  const insert = () => db.hdl.prepare('INSERT INTO sector_centers(id, sector_id, center_id, effective_from, effective_to, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('BAD', 'S2', 'C1', '2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  assert.throws(insert, /SECTOR_CENTER_PERIOD_OVERLAP/);
  db.hdl.prepare('INSERT INTO sector_centers(id, sector_id, center_id, effective_from, effective_to, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('HIST', 'S2', 'C1', '2018-01-01T00:00:00.000Z', '2019-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  db.close();
});

test('scope target validation and temporal overlap are enforced', () => {
  const db = createFixture();
  grant(db, 'u1', 'sector', 'S1');
  assert.throws(() => grant(db, 'u1', 'sector', 'S1', { id: 'overlap', from: '2025-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z' }), /UNIQUE|USER_SCOPE_PERIOD_OVERLAP/);
  assert.throws(() => grant(db, 'u1', 'sector', 'UNKNOWN', { id: 'unknown' }), /SCOPE_SECTOR_NOT_FOUND/);
  db.close();
});

test('core read queries use the additive indexes', () => {
  const db = createFixture();
  const sectorPlan = db.hdl.prepare("EXPLAIN QUERY PLAN SELECT id FROM sectors WHERE region_id = 'R1' AND status = 'active'").all();
  const ledgerPlan = db.hdl.prepare("EXPLAIN QUERY PLAN SELECT id FROM sector_command_ledger WHERE sector_id = 'S1' ORDER BY occurred_at DESC, id DESC LIMIT 50").all();
  assert.ok(JSON.stringify(sectorPlan).includes('idx_sectors_region_status'));
  assert.ok(JSON.stringify(ledgerPlan).includes('idx_sector_ledger_sector_time'));
  db.close();
});
