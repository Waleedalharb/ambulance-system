'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const NOW = '2026-11-14T12:00:00.000Z';
const SCHEMA = fs.readFileSync(path.join(__dirname, '../../deploy/region-command-phase-1-schema.sql'), 'utf8');

function createFixture({ seed = true } = {}) {
  const hdl = new Database(':memory:');
  hdl.pragma('foreign_keys = ON');
  hdl.exec('CREATE TABLE centers (id TEXT PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE baseline_probe (id TEXT PRIMARY KEY, value TEXT);');
  hdl.exec(SCHEMA);
  const db = {
    hdl,
    run: async (sql, params = []) => hdl.prepare(sql).run(...params),
    get: async (sql, params = []) => hdl.prepare(sql).get(...params) || null,
    all: async (sql, params = []) => hdl.prepare(sql).all(...params),
    exec: async sql => hdl.exec(sql),
    tx: Object.assign(fn => hdl.transaction(() => fn(hdl))(), {
      immediate: fn => hdl.transaction(() => fn(hdl)).immediate()
    }),
    close: () => hdl.close()
  };
  if (seed) seedHierarchy(db);
  return db;
}

function seedHierarchy(db) {
  const h = db.hdl;
  const insertCenter = h.prepare('INSERT INTO centers(id, name) VALUES (?, ?)');
  for (const id of ['C1', 'C2', 'C3', 'C4', 'C5']) insertCenter.run(id, `مركز ${id}`);
  const region = h.prepare('INSERT INTO regions(id, code, name, status, created_at) VALUES (?, ?, ?, ?, ?)');
  region.run('R1', 'R1', 'منطقة اختبار 1', 'active', NOW);
  region.run('R2', 'R2', 'منطقة اختبار 2', 'active', NOW);
  const sector = h.prepare('INSERT INTO sectors(id, region_id, code, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  sector.run('S1', 'R1', 'S1', 'قطاع اختبار 1', 'active', NOW);
  sector.run('S2', 'R1', 'S2', 'قطاع اختبار 2', 'active', NOW);
  sector.run('S3', 'R2', 'S3', 'قطاع اختبار 3', 'active', NOW);
  const link = h.prepare('INSERT INTO sector_centers(id, sector_id, center_id, effective_from, effective_to, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  link.run('SC1', 'S1', 'C1', '2020-01-01T00:00:00.000Z', null, NOW);
  link.run('SC2', 'S1', 'C2', '2020-01-01T00:00:00.000Z', null, NOW);
  link.run('SC3', 'S2', 'C3', '2020-01-01T00:00:00.000Z', null, NOW);
  link.run('SC4', 'S3', 'C4', '2020-01-01T00:00:00.000Z', null, NOW);
}

function grant(db, userId, type, id, options = {}) {
  db.hdl.prepare(`INSERT INTO user_access_scopes(
    id, user_id, scope_type, scope_id, status, effective_from, effective_to, granted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    options.id || `GRANT-${userId}-${type}-${id}`, String(userId), type, id,
    options.status || 'active', options.from || '2020-01-01T00:00:00.000Z',
    options.to === undefined ? null : options.to, NOW
  );
}

function permissionStub(allowed = true) {
  return { hasPermission: async () => allowed };
}

module.exports = { createFixture, seedHierarchy, grant, permissionStub, NOW, SCHEMA };
