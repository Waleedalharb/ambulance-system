'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RegionScopeService = require('../../services/region-scope-service');
const RegionCommandReadService = require('../../services/region-command-read-service');
const RegionDecisionCenterService = require('../../services/region-decision-center-service');
const { createFixture, grant, NOW } = require('./fixtures');

function sources() {
  return {
    staffingService: { deriveTeamReadiness: async shiftId => ({ shiftId, teams: {
      'فريق 1': { status: 'ready', center: 'مركز C1', activeCount: 2, requiredPersonnel: 2, lastDecision: { at: NOW } },
      'فريق 2': { status: 'missing', center: 'مركز C2', activeCount: 1, requiredPersonnel: 2 },
      'خارج': { status: 'ready', center: 'مركز C3', activeCount: 9, requiredPersonnel: 9 }
    }, workforce: {} }) },
    vehicleService: { getState: async shiftId => ({ shiftId, entities: [
      { entityId: 'V1', entityName: 'مركبة 1', center: 'مركز C1', open: [{ status: 'active', created_at: NOW }] },
      { entityId: 'V2', entityName: 'مركبة 2', center: 'مركز C2', open: [{ status: 'breakdown', created_at: NOW }] },
      { entityId: 'V3', entityName: 'خارج', center: 'مركز C3', open: [{ status: 'active' }] }
    ] }) },
    reportService: { getIncidentSummary: async shiftId => ({ incidents: [
      { number: 'I-1', type: 'إصابة', status: 'active', createdAt: NOW, bestArrivalMin: 8, crews: [{ unit: 'فريق 1', counted: true }] },
      { number: 'I-2', type: 'مرض', status: 'closed', createdAt: NOW, bestArrivalMin: 12, crews: [{ unit: 'فريق 2', counted: true }] },
      { number: 'I-3', status: 'active', bestArrivalMin: 1, crews: [{ unit: 'خارج', counted: true }] }
    ] }) }
  };
}
function setup(overrides = {}) {
  const db = createFixture();
  grant(db, 'leader', 'region', 'R1');
  const scopeService = new RegionScopeService({ db, now: () => NOW });
  const base = sources();
  const readService = new RegionCommandReadService({
    scopeService, ...base,
    getActiveShift: async ({ sectorId }) => ({ id: sectorId === 'S1' ? 101 : 202, shift_name: 'مناوبة اختبار', shift_type: 'يوم', shift_date: '2026-11-14' }),
    now: () => NOW,
    ...overrides
  });
  const decisionCenter = new RegionDecisionCenterService({ readService, scopeService });
  return { db, readService, decisionCenter, actor: { id: 'leader', role: 'director' } };
}

function assertNoRawOperationalNumbers(value, path = 'root') {
  if (value && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'value') && Object.hasOwn(value, 'status') && Object.hasOwn(value, 'coverage')) {
    assert.ok(['ok', 'stale', 'partial', 'unavailable', 'unresolved', 'not_applicable'].includes(value.status), `${path}: invalid metric status`);
    if (value.value === 0) assert.equal(value.status, 'ok', `${path}: zero must be ok`);
    return assertNoRawOperationalNumbers(value.coverage, `${path}.coverage`);
  }
  if (typeof value === 'number') {
    if (/\.coverage\.(expected|available)$/.test(path)) return;
    assert.fail(`Raw operational number at ${path}: ${value}`);
  }
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoRawOperationalNumbers(v, `${path}.${i}`));
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoRawOperationalNumbers(v, `${path}.${k}`);
}

test('read service filters every owner result through sector centers and wraps all numbers', async () => {
  const { db, readService, actor } = setup();
  const detail = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  assert.equal(detail.sector.shiftId, '101');
  assert.equal(detail.sector.metrics.teamsTotal.value, 2);
  assert.equal(detail.sector.metrics.teamsReady.value, 1);
  assert.equal(detail.sector.metrics.vehiclesTotal.value, 2);
  assert.equal(detail.sector.metrics.incidentsTotal.value, 2);
  assert.equal(detail.sector.metrics.avgResponseMinutes.value, 10);
  assert.equal(detail.sector.decisionCount.value, 2);
  assertNoRawOperationalNumbers(detail);
  db.close();
});

test('each source failure becomes null/unavailable, never zero, including decisionCount', async () => {
  for (const failed of ['staffingService', 'vehicleService', 'reportService']) {
    const override = {};
    override[failed] = failed === 'staffingService' ? { deriveTeamReadiness: async () => { throw new Error('down'); } }
      : failed === 'vehicleService' ? { getState: async () => { throw new Error('down'); } }
        : { getIncidentSummary: async () => { throw new Error('down'); } };
    const { db, readService, actor } = setup(override);
    const detail = await readService.getSectorDetail({ actor, sectorId: 'S1' });
    const affected = Object.entries(detail.sector.metrics).filter(([, m]) => m.reasonCode === 'SOURCE_UNAVAILABLE');
    assert.ok(affected.length >= 2, failed);
    for (const [, m] of affected) assert.equal(m.value, null);
    assert.equal(detail.sector.decisionCount.value, null);
    assert.equal(detail.sector.decisionCount.status, 'unavailable');
    assertNoRawOperationalNumbers(detail);
    db.close();
  }
});

test('incident metrics stay unavailable when team-to-sector resolution is unavailable', async () => {
  const { db, readService, actor } = setup({ staffingService: { deriveTeamReadiness: async () => { throw new Error('down'); } } });
  const detail = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  for (const key of ['incidentsTotal', 'incidentsActive', 'avgResponseMinutes']) {
    assert.equal(detail.sector.metrics[key].value, null);
    assert.equal(detail.sector.metrics[key].reasonCode, 'TEAM_SCOPE_SOURCE_UNAVAILABLE');
  }
  assert.equal(detail.sector.incidents.length, 0);
  assert.equal(detail.sector.dataQuality.ReportService.status, 'unavailable');
  db.close();
});

test('no active shift is explicit and never becomes zero readiness', async () => {
  const { db, readService, actor } = setup({ getActiveShift: async () => null });
  const detail = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  assert.equal(detail.sector.metrics.teamsTotal.value, null);
  assert.equal(detail.sector.metrics.teamsTotal.reasonCode, 'NO_ACTIVE_SHIFT');
  assert.equal(detail.sector.metrics.centerCount.value, 2);
  db.close();
});

test('stale sources retain status and sourceAt rather than pretending to be current', async () => {
  const custom = sources();
  const original = custom.staffingService.deriveTeamReadiness;
  custom.staffingService.deriveTeamReadiness = async id => ({ ...(await original(id)), stale: true });
  const { db, readService, actor } = setup(custom);
  const detail = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  assert.equal(detail.sector.metrics.teamsTotal.status, 'stale');
  assert.equal(detail.sector.metrics.teamsTotal.sourceAt, NOW);
  db.close();
});

test('overview uses distinct sector shifts and regional incomplete totals are null/partial', async () => {
  const failing = { reportService: { getIncidentSummary: async () => { throw new Error('down'); } } };
  const { db, readService, actor } = setup(failing);
  const overview = await readService.getOverview({ actor, regionId: 'R1' });
  assert.equal(overview.sectors[0].shiftId, '101');
  assert.equal(overview.sectors[1].shiftId, '202');
  assert.equal(overview.totals.metrics.incidentsTotal.value, null);
  assert.equal(overview.totals.metrics.incidentsTotal.status, 'partial');
  assert.equal(overview.totals.metrics.teamsTotal.value, 3);
  assertNoRawOperationalNumbers(overview);
  db.close();
});

test('metric evidence exposes approved formula and wrapped numerator/denominator only', async () => {
  const { db, readService, actor } = setup();
  const evidence = await readService.getMetricEvidence({ actor, sectorId: 'S1', metricKey: 'readinessRate', metricVersion: '1.0.0' });
  assert.equal(evidence.metric.ownerService, 'StaffingEventsService');
  assert.equal(evidence.numerator.value, 1);
  assert.equal(evidence.denominator.value, 2);
  await assert.rejects(readService.getMetricEvidence({ actor, sectorId: 'S1', metricKey: 'invented', metricVersion: '1' }), e => e.code === 'METRIC_NOT_SUPPORTED');
  db.close();
});

test('operational team codes are additive display identities while internal team names stay unchanged', async () => {
  const custom = sources();
  custom.staffingService = { deriveTeamReadiness: async shiftId => ({ shiftId, teams: {
    'جنوب 1': { status: 'ready', center: 'مركز C1', activeCount: 2, requiredPersonnel: 2, lastDecision: { at: NOW } }
  }, workforce: {} }) };
  custom.reportService = { getIncidentSummary: async () => ({ incidents: [
    { number: 'I-CODE', status: 'active', createdAt: NOW, bestArrivalMin: 8, crews: [{ unit: 'جنوب 1', counted: true }] }
  ] }) };
  const { db, readService, actor } = setup({
    ...custom,
    getActiveShift: async () => ({ id: 101, shift_name: 'مناوبة ليلية', shift_type: 'ليلية', shift_date: '2026-11-15' })
  });
  const detail = await readService.getSectorDetail({ actor, sectorId: 'S1' });
  assert.equal(detail.sector.teams[0].name, 'جنوب 1');
  assert.equal(detail.sector.teams[0].operationalCode, 'R-3-2-1');
  assert.equal(detail.sector.teams[0].sectorName, 'قطاع جنوب الرياض');
  assert.equal(detail.sector.teams[0].teamNumber, '1');
  assert.equal(detail.sector.teams[0].shiftType, 'ليلية');
  assert.deepEqual(detail.sector.incidents[0].teams, ['جنوب 1']);
  assert.equal(detail.sector.incidents[0].teamIdentities[0].operationalCode, 'R-3-2-1');
  assertNoRawOperationalNumbers(detail);
  db.close();
});
