'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const StorageAdapter = require('../../storage-adapter');
const RegionScopeService = require('../../services/region-scope-service');
const RegionCommandReadService = require('../../services/region-command-read-service');
const { createFixture, grant } = require('./fixtures');

const NOW = '2026-11-17T12:00:00.000Z';

function setup({ incidents = [], historical = null, board = null } = {}) {
  const db = createFixture();
  db.hdl.exec('CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL, center TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)');
  const addTeam = db.hdl.prepare('INSERT INTO teams(id, name, center, is_active) VALUES (?, ?, ?, 1)');
  addTeam.run(1, 'فريق 1', 'مركز C1');
  addTeam.run(2, 'فريق 2', 'مركز C2');
  addTeam.run(3, 'فريق 3', 'مركز C3');
  addTeam.run(4, 'خارج', 'مركز C4');
  grant(db, 'leader', 'region', 'R1');
  const scopeService = new RegionScopeService({ db, now: () => NOW });
  const teams = {
    'فريق 1': { status: 'ready', center: 'مركز C1', activeCount: 2, requiredPersonnel: 2, vehicleId: 'V1', lastDecision: { at: NOW } },
    'فريق 2': { status: 'ready', center: 'مركز C2', activeCount: 2, requiredPersonnel: 2, vehicleId: 'V2', lastDecision: { at: NOW } },
    'فريق 3': { status: 'ready', center: 'مركز C3', activeCount: 2, requiredPersonnel: 2, vehicleId: 'V3', lastDecision: { at: NOW } }
  };
  let historyCalls = 0;
  const readService = new RegionCommandReadService({
    scopeService,
    staffingService: { deriveTeamReadiness: async shiftId => ({ shiftId, teams, workforce: {} }) },
    vehicleService: {
      getBoard: async shiftId => board || { shiftId, vehicles: [
        { id: 'V1', name: 'مركبة 1', status: 'active', since: NOW },
        { id: 'V2', name: 'مركبة 2', status: 'breakdown', since: NOW },
        { id: 'V3', name: 'مركبة 3', status: 'active', since: NOW }
      ] },
      getState: async () => { throw new Error('getState must not replace the current board'); }
    },
    reportService: {
      getIncidentSummary: async shiftId => ({ shiftId, incidents }),
      getHistoricalSummary: historical ? async () => { historyCalls++; return historical; } : undefined
    },
    getActiveShift: async ({ sectorId }) => ({ id: sectorId === 'S1' ? '101' : '202', shift_name: 'مناوبة اختبار', shift_type: 'صباحية', shift_date: '2026-11-17' }),
    now: () => NOW
  });
  return { db, readService, actor: { id: 'leader', role: 'director' }, historyCalls: () => historyCalls };
}

test('actual accepted CAD assignment makes a ready team busy without changing counted participation', async () => {
  const incidents = [
    { number: 'I-BUSY', status: 'active', createdAt: NOW, bestArrivalMin: null, crews: [{ unit: 'فريق 1', counted: true, cadUrs: 'A', phases: null }] },
    { number: 'I-B', status: 'active', crews: [{ unit: 'فريق 2', counted: false, cadUrs: 'B' }] },
    { number: 'I-C', status: 'active', crews: [{ unit: 'فريق 2', counted: false, cadUrs: 'C' }] },
    { number: 'I-R', status: 'active', crews: [{ unit: 'فريق 2', counted: false, cadUrs: 'R' }] },
    { number: 'I-WITHDRAWN', status: 'active', crews: [{ unit: 'فريق 2', counted: false, withdrawn: true }] },
    { number: 'I-MANUAL', status: 'active', crews: [{ unit: 'فريق 2', counted: false, manualCancelled: true }] },
    { number: 'I-LEGACY', status: 'active', crews: [{ unit: 'فريق 2', counted: false, legacySnapshot: true }] },
    { number: 'I-CLOSED', status: 'closed', crews: [{ unit: 'فريق 2', counted: false, cadUrs: 'A' }] }
  ];
  const { db, readService, actor } = setup({ incidents });
  const { sector } = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  const first = sector.teams.find(team => team.name === 'فريق 1');
  const second = sector.teams.find(team => team.name === 'فريق 2');
  assert.equal(first.status, 'busy');
  assert.equal(first.completionStatus, 'ready');
  assert.deepEqual(first.activeIncidentIds, ['I-BUSY']);
  assert.equal(second.status, 'ready');
  assert.deepEqual(second.activeIncidentIds, []);
  assert.equal(sector.metrics.teamsReady.value, 1);
  assert.equal(sector.metrics.teamsBusy.value, 1);
  assert.equal(sector.metrics.readinessRate.value, 50);
  assert.equal(sector.metrics.incidentsTotal.value, 1, 'only the counted crew participates in incident totals');
  db.close();
});

test('current vehicle board supplies assigned fleet even without a status event in the active shift', async () => {
  const { db, readService, actor } = setup();
  const { sector } = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  assert.equal(sector.metrics.vehiclesTotal.value, 2);
  assert.equal(sector.metrics.vehiclesActive.value, 1);
  assert.deepEqual(sector.vehicles.map(vehicle => vehicle.id), ['V1', 'V2']);
  assert.equal(sector.vehicles[1].status, 'breakdown');
  db.close();
});

test('partial response coverage keeps its calculated value and mubashara average remains explicit', async () => {
  const incidents = [
    { number: 'I-1', status: 'closed', createdAt: NOW, bestArrivalMin: 8, bestMubasharaMin: 4, crews: [{ unit: 'فريق 1', counted: true }] },
    { number: 'I-2', status: 'closed', createdAt: NOW, bestArrivalMin: null, bestMubasharaMin: 6, crews: [{ unit: 'فريق 2', counted: true }] }
  ];
  const { db, readService, actor } = setup({ incidents });
  const { sector } = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  assert.equal(sector.metrics.avgResponseMinutes.value, 8);
  assert.equal(sector.metrics.avgResponseMinutes.status, 'partial');
  assert.deepEqual(sector.metrics.avgResponseMinutes.coverage, { expected: 2, available: 1, status: 'partial' });
  assert.equal(sector.metrics.avgMubasharaMinutes.value, 5);
  assert.equal(sector.metrics.avgMubasharaMinutes.status, 'ok');
  assert.deepEqual(sector.metrics.avgMubasharaMinutes.coverage, { expected: 2, available: 2, status: 'complete' });
  db.close();
});

test('trend buckets use Riyadh calendar days including 00:30 local time', async () => {
  const { db, readService } = setup();
  const range = { dates: ['2026-11-16', '2026-11-17'], from: '2026-11-15T21:00:00.000Z', to: NOW, bucket: 'day' };
  const trend = readService._trendSeries([
    { number: 'PREVIOUS', occurredAt: '2026-11-16T20:59:59.000Z', bestArrivalMin: 10, bestMubasharaMin: 5 },
    { number: 'BOUNDARY', occurredAt: '2026-11-16T21:30:00.000Z', bestArrivalMin: 8, bestMubasharaMin: 4 }
  ], range);
  assert.equal(trend.points[0].incidentsTotal.value, 1);
  assert.equal(trend.points[1].incidentsTotal.value, 1);
  assert.equal(trend.points[1].avgResponseMinutes.value, 8);
  db.close();
});

test('regional trend filters sector teams, deduplicates shared incidents and reads history once', async () => {
  const historical = { incidents: [
    { number: 'SHARED', shiftId: 'H1', occurredAt: '2026-11-16T21:30:00.000Z', bestArrivalMin: 8, bestMubasharaMin: 4, crews: [{ unit: 'فريق 1', counted: true }, { unit: 'فريق 3', counted: true }] },
    { number: 'S1-ONLY', shiftId: 'H2', occurredAt: '2026-11-16T20:00:00.000Z', bestArrivalMin: 10, bestMubasharaMin: 6, crews: [{ unit: 'فريق 2', counted: true }] },
    { number: 'OUTSIDE', shiftId: 'H3', occurredAt: '2026-11-16T22:00:00.000Z', bestArrivalMin: 1, bestMubasharaMin: 1, crews: [{ unit: 'خارج', counted: true }] }
  ], unresolvedTimeCount: 0 };
  const { db, readService, actor, historyCalls } = setup({ historical });
  const overview = await readService.getOverview({ actor, regionId: 'R1' });
  const today = overview.totals.trends.points.find(point => point.date === '2026-11-17');
  const yesterday = overview.totals.trends.points.find(point => point.date === '2026-11-16');
  assert.equal(today.incidentsTotal.value, 1, 'shared incident is counted once regionally');
  assert.equal(yesterday.incidentsTotal.value, 1);
  assert.equal(overview.sectors[0].trends.points.find(point => point.date === '2026-11-17').incidentsTotal.value, 1);
  assert.equal(overview.sectors[1].trends.points.find(point => point.date === '2026-11-17').incidentsTotal.value, 1);
  assert.equal(overview.totals.trends.points.reduce((sum, point) => sum + point.incidentsTotal.value, 0), 2, 'outside team never enters the region');
  assert.equal(historyCalls(), 1);
  db.close();
});

test('scoped active shift selection never lends another sector its shift', async () => {
  const hdl = new Database(':memory:');
  hdl.exec(`CREATE TABLE shifts (id INTEGER PRIMARY KEY, status TEXT, shift_name TEXT, shift_date TEXT);
    CREATE TABLE operational_events (id INTEGER PRIMARY KEY, shift_id INTEGER, center TEXT);
    CREATE TABLE shift_reports (id INTEGER PRIMARY KEY, shift_id INTEGER, center TEXT);
    CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT, center TEXT);
    CREATE TABLE shift_team_status (shift_id INTEGER, team_id TEXT, status TEXT);
    CREATE TABLE shift_roster (id INTEGER PRIMARY KEY, team_id INTEGER, shift_date TEXT);
    INSERT INTO shifts VALUES
      (1, 'active', 'مناوبة أ', '2026-11-17'),
      (2, 'active', 'مناوبة ب', '2026-11-17'),
      (3, 'active', 'مناوبة ج', '2026-11-17'),
      (4, 'active', 'مناوبة تكميل', '2026-11-17'),
      (5, 'active', 'مناوبة مجدولة', '2026-11-17');
    INSERT INTO operational_events VALUES (1, 1, 'مركز أ'), (2, 2, 'مركز ب');
    INSERT INTO shift_reports VALUES (1, 3, 'مركز ج');
    INSERT INTO teams VALUES (4, 'فريق جاهز', 'مركز تكميل'), (5, 'فريق مجدول', 'مركز جدولة');
    INSERT INTO shift_team_status VALUES (4, 'فريق جاهز', 'ready');
    INSERT INTO shift_roster VALUES (1, 5, '2026-11-17');`);
  const db = {
    get: async (sql, params = []) => hdl.prepare(sql).get(...params) || null,
    all: async (sql, params = []) => hdl.prepare(sql).all(...params),
    run: async (sql, params = []) => hdl.prepare(sql).run(...params)
  };
  const storage = new StorageAdapter(db);
  assert.equal((await storage.getActiveShift({ centerNames: ['مركز أ'] })).id, 1);
  assert.equal((await storage.getActiveShift({ centerNames: ['مركز ب'] })).id, 2);
  assert.equal((await storage.getActiveShift({ centerNames: ['مركز ج'] })).id, 3);
  assert.equal((await storage.getActiveShift({ centerNames: ['مركز تكميل'] })).id, 4,
    'a saved completion decision selects its sector shift without operational events');
  assert.equal((await storage.getActiveShift({ centerNames: ['مركز جدولة'] })).id, 5,
    'a scheduled roster selects its sector shift before the first completion');
  assert.equal(await storage.getActiveShift({ centerNames: ['مركز غير مرتبط'] }), null);
  assert.equal((await storage.getActiveShift()).id, 5, 'unscoped legacy behavior remains unchanged');
  hdl.close();
});
