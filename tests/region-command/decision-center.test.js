'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RegionDecisionCenterService = require('../../services/region-decision-center-service');
const RegionScopeService = require('../../services/region-scope-service');
const { createFixture, grant, NOW } = require('./fixtures');

function setup(snapshot) {
  const db = createFixture();
  grant(db, 'leader', 'region', 'R1');
  const scopeService = new RegionScopeService({ db, now: () => NOW });
  const readService = {
    getSectorDetail: async ({ sectorId }) => ({ sector: { ...snapshot, id: sectorId } }),
    decisionCenter: null
  };
  const service = new RegionDecisionCenterService({ readService, scopeService });
  return { db, service, actor: { id: 'leader' } };
}
const base = {
  regionId: 'R1', shiftId: '101', generatedAt: NOW, dataQuality: {},
  teams: [{ name: 'فريق 1', center: 'مركز C1', status: 'pending' }],
  vehicles: [], incidents: []
};

test('derived items are stable, neutral and carry evidence without invented priority/dueAt', () => {
  const { db, service } = setup(base);
  const one = service.deriveForSector({ ...base, id: 'S1' });
  const two = service.deriveForSector({ ...base, id: 'S1' });
  assert.equal(one.items[0].id, two.items[0].id);
  assert.equal(one.items[0].status, 'needs_review');
  assert.equal(one.items[0].critical, undefined);
  assert.equal(one.items[0].dueAt, undefined);
  assert.equal(one.count.value, 1);
  db.close();
});

test('complete empty derivation is zero, failed source is null/unavailable', () => {
  const empty = { ...base, teams: [], vehicles: [] };
  const { db, service } = setup(empty);
  assert.equal(service.deriveForSector({ ...empty, id: 'S1' }).count.value, 0);
  const failed = { ...empty, dataQuality: { ReportService: { status: 'unavailable', reasonCode: 'SOURCE_UNAVAILABLE' } } };
  assert.equal(service.deriveForSector({ ...failed, id: 'S1' }).count.value, null);
  db.close();
});

test('mixed sector filter rejects the whole decision request and evidence cannot cross scope', async () => {
  const { db, service, actor } = setup(base);
  await assert.rejects(service.list({ actor, filters: { sectorId: ['S1', 'S3'] } }), e => e.code === 'SCOPE_FORBIDDEN');
  const list = await service.list({ actor, filters: { sectorId: 'S1' } });
  const evidence = await service.getEvidence({ actor, itemId: list.items[0].id });
  assert.equal(evidence.item.sectorId, 'S1');
  db.close();
});
