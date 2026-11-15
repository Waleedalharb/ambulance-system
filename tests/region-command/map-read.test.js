'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RegionScopeService = require('../../services/region-scope-service');
const RegionCommandReadService = require('../../services/region-command-read-service');
const { createFixture, grant, NOW } = require('./fixtures');

function setup(overrides = {}) {
  const db = createFixture();
  grant(db, 'leader', 'region', 'R1');
  const scopeService = new RegionScopeService({ db, now: () => NOW });
  const centersGeoService = { getData: () => ({
    centers: { 'مركز C1': { center: [24.61, 46.75] }, 'مركز C2': { center: [24.62, 46.76] }, 'مركز C3': { center: [24.63, 46.77] } },
    nonGeographic: { 'مركز C4': 'غير جغرافي' }
  }) };
  const staffingService = { deriveTeamReadiness: async () => ({ teams: {
    'فريق 1': { center: 'مركز C1', status: 'ready' },
    'خارج': { center: 'مركز C3', status: 'ready' }
  } }) };
  const reportService = { getIncidentSummary: async () => ({ incidents: [
    { number: 'I-1', status: 'active', createdAt: NOW, lat: 24.611, lng: 46.751, crews: [{ unit: 'فريق 1', counted: true }] },
    { number: 'I-NO-GEO', status: 'active', createdAt: NOW, lat: null, lng: null, crews: [{ unit: 'فريق 1', counted: true }] },
    { number: 'I-OUT', status: 'active', createdAt: NOW, lat: 24.9, lng: 46.9, crews: [{ unit: 'خارج', counted: true }] }
  ] }) };
  const readService = new RegionCommandReadService({
    scopeService, staffingService, reportService, centersGeoService,
    vehicleService: { getState: async () => ({ entities: [] }) },
    getActiveShift: async () => ({ id: 101, shift_name: 'مناوبة اختبار' }), now: () => NOW,
    ...overrides
  });
  return { db, readService, actor: { id: 'leader', role: 'director' } };
}

test('sector map exposes only scoped real coordinates and preserves non-geographic centers honestly', async () => {
  const { db, readService, actor } = setup();
  const map = await readService.getSectorMap({ actor, sectorId: 'S1' });
  assert.deepEqual(map.incidents.items.map(item => item.id), ['I-1', 'I-NO-GEO']);
  assert.equal(map.incidents.items[0].lat, 24.611);
  assert.equal(map.incidents.items[1].coordinateStatus, 'unavailable');
  assert.equal(map.centers[0].lat, 24.61);
  assert.ok(!JSON.stringify(map).includes('I-OUT'));
  const other = await readService.getSectorMap({ actor, sectorId: 'S2' });
  assert.deepEqual(other.incidents.items.map(item => item.id), ['I-OUT']);
  await assert.rejects(readService.getSectorMap({ actor, sectorId: 'S3' }), error => error.code === 'SCOPE_FORBIDDEN');
  db.close();
});

test('map fails closed when team ownership is unavailable and never guesses incident scope', async () => {
  const { db, readService, actor } = setup({ staffingService: { deriveTeamReadiness: async () => { throw new Error('down'); } } });
  const map = await readService.getSectorMap({ actor, sectorId: 'S1' });
  assert.equal(map.incidents.status, 'unavailable');
  assert.equal(map.incidents.reasonCode, 'TEAM_SCOPE_SOURCE_UNAVAILABLE');
  assert.deepEqual(map.incidents.items, []);
  db.close();
});

test('missing center geo source does not invent coordinates or block scoped incident coordinates', async () => {
  const { db, readService, actor } = setup({ centersGeoService: { getData: () => null } });
  const map = await readService.getSectorMap({ actor, sectorId: 'S1' });
  assert.ok(map.centers.every(center => center.lat === null && center.coordinateStatus === 'unavailable'));
  assert.equal(map.incidents.items[0].lat, 24.611);
  assert.equal(map.sourceMeta[0].status, 'unavailable');
  db.close();
});

test('sector map carries operational team identities without changing incident team keys', async () => {
  const { db, readService, actor } = setup({
    staffingService: { deriveTeamReadiness: async () => ({ teams: {
      'جنوب 1': { center: 'مركز C1', status: 'ready' }
    } }) },
    reportService: { getIncidentSummary: async () => ({ incidents: [
      { number: 'I-CODE', status: 'active', createdAt: NOW, lat: 24.611, lng: 46.751, crews: [{ unit: 'جنوب 1', counted: true }] }
    ] }) },
    getActiveShift: async () => ({ id: 101, shift_name: 'مناوبة ليلية', shift_type: 'ليلية' })
  });
  const map = await readService.getSectorMap({ actor, sectorId: 'S1' });
  assert.deepEqual(map.incidents.items[0].teams, ['جنوب 1']);
  assert.equal(map.incidents.items[0].teamIdentities[0].operationalCode, 'R-3-2-1');
  assert.equal(map.incidents.items[0].teamIdentities[0].sectorName, 'قطاع جنوب الرياض');
  assert.equal(map.incidents.items[0].teamIdentities[0].teamNumber, '1');
  assert.equal(map.incidents.items[0].teamIdentities[0].shiftType, 'ليلية');
  db.close();
});
