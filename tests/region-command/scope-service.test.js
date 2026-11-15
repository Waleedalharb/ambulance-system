'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RegionScopeService = require('../../services/region-scope-service');
const { createFixture, grant, permissionStub, NOW } = require('./fixtures');

function setup() {
  const db = createFixture();
  const service = new RegionScopeService({ db, permissionService: permissionStub(), now: () => NOW });
  return { db, service };
}

test('region scope resolves current and future sectors without naming inference', async () => {
  const { db, service } = setup();
  grant(db, 'leader-r1', 'region', 'R1');
  db.hdl.prepare('INSERT INTO sectors(id, region_id, code, name, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('S4', 'R1', 'S4', 'قطاع مستقبلي', 'active', NOW);
  const result = await service.resolveRegionSectors({ id: 'leader-r1', role: 'user' }, 'R1');
  assert.deepEqual(result.sectors.map(s => s.id), ['S1', 'S2', 'S4']);
  db.close();
});

test('sector scope cannot read sibling or parent region as a regional aggregate', async () => {
  const { db, service } = setup();
  grant(db, 'leader-s1', 'sector', 'S1');
  assert.equal((await service.assertCanReadSector({ id: 'leader-s1' }, 'S1')).id, 'S1');
  await assert.rejects(service.assertCanReadSector({ id: 'leader-s1' }, 'S2'), e => e.code === 'SCOPE_FORBIDDEN' && e.statusCode === 403);
  const ownRegion = await service.resolveRegionSectors({ id: 'leader-s1' }, 'R1');
  assert.deepEqual(ownRegion.sectors.map(s => s.id), ['S1']);
  db.close();
});

test('expired, suspended, missing and star-without-scope all fail closed', async () => {
  const { db, service } = setup();
  grant(db, 'expired', 'region', 'R1', { to: '2026-01-01T00:00:00.000Z' });
  grant(db, 'suspended', 'sector', 'S1', { status: 'suspended' });
  for (const actor of [{ id: 'expired' }, { id: 'suspended' }, { id: 'missing' }, { id: 'admin', role: 'admin' }]) {
    await assert.rejects(service.assertCanReadSector(actor, 'S1'), e => e.code === 'NO_ACTIVE_SCOPE');
  }
  assert.equal(await service.canViewSector({ id: 'admin', role: 'admin' }, 'S1'), false);
  db.close();
});

test('mixed explicit request rejects entire request instead of silent filtering', async () => {
  const { db, service } = setup();
  grant(db, 'leader-s1', 'sector', 'S1');
  await assert.rejects(
    service.assertAllSectorsAuthorized({ id: 'leader-s1' }, ['S1', 'S2']),
    e => e.code === 'SCOPE_FORBIDDEN' && !/S2/.test(e.message)
  );
  assert.deepEqual((await service.assertAllSectorsAuthorized({ id: 'leader-s1' }, undefined)).map(s => s.id), ['S1']);
  await assert.rejects(service.assertAllSectorsAuthorized({ id: 'leader-s1' }, ['S1,S2']), e => e.code === 'INVALID_SECTOR');
  db.close();
});

test('center links are temporal and unmapped centers are never inferred', async () => {
  const { db, service } = setup();
  grant(db, 'leader-s1', 'sector', 'S1');
  const centers = await service.resolveSectorCenters({ id: 'leader-s1' }, 'S1');
  assert.deepEqual(centers.map(c => c.id), ['C1', 'C2']);
  db.hdl.prepare('UPDATE sector_centers SET effective_to = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', 'SC2');
  assert.deepEqual((await service.resolveSectorCenters({ id: 'leader-s1' }, 'S1')).map(c => c.id), ['C1']);
  db.close();
});
