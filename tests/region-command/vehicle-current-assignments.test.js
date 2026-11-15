'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const VehicleEventsService = require('../../services/vehicle-events-service');
const RegionCommandEventBridge = require('../../services/region-command-event-bridge');
const RegionScopeService = require('../../services/region-scope-service');
const { createFixture, grant, NOW } = require('./fixtures');

const assignment = {
  id: 1, shift_id: null, domain: 'vehicle', entity_id: 'V1', entity_name: 'مركبة 1',
  team_id: 'T1', center: 'مركز C1', event_type: 'assignment', status: null,
  created_at: '2026-11-14T08:00:00.000Z'
};
const status = {
  id: 2, shift_id: '101', domain: 'vehicle', entity_id: 'V1', entity_name: 'مركبة 1',
  team_id: null, center: null, event_type: 'status_change', status: 'active',
  created_at: '2026-11-14T09:00:00.000Z'
};

test('vehicle getState default remains shift-only while opt-in inherits the global open assignment', async () => {
  const service = new VehicleEventsService({
    engine: {},
    storage: {
      getOperationalEventsByShift: async () => [status],
      all: async () => [assignment, { ...assignment, id: 4, entity_id: 'V2', center: 'مركز C2' }]
    }
  });
  const legacy = await service.getState('101');
  assert.equal(legacy.entities[0].center, null);
  const current = await service.getState('101', { includeCurrentAssignments: true });
  assert.equal(current.entities.length, 1);
  assert.equal(current.entities[0].entityId, 'V1');
  assert.equal(current.entities[0].center, 'مركز C1');
  assert.equal(current.entities[0].teamId, 'T1');
  assert.equal(current.entities[0].open.find(event => event.status).status, 'active');
});

test('vehicle getState opt-in closes a global assignment without inventing a replacement center', async () => {
  const ended = { ...assignment, id: 3, event_type: 'assignment_end', center: 'مركز C1', created_at: '2026-11-14T10:00:00.000Z' };
  const service = new VehicleEventsService({
    engine: {},
    storage: {
      getOperationalEventsByShift: async () => [status],
      all: async () => [assignment, ended]
    }
  });
  const current = await service.getState('101', { includeCurrentAssignments: true });
  assert.equal(current.entities[0].center, 'مركز C1');
  assert.equal(current.entities[0].open.some(event => event.event_type === 'assignment'), false);
  assert.equal(current.entities[0].open.find(event => event.status).status, 'active');
});

test('vehicle SSE fallback includes open global assignments and excludes ended or unrelated sectors', async () => {
  const db = createFixture();
  db.hdl.exec(`CREATE TABLE operational_events (
    id INTEGER PRIMARY KEY, shift_id TEXT, domain TEXT, entity_id TEXT,
    event_type TEXT, center TEXT, created_at TEXT
  );`);
  const insert = db.hdl.prepare('INSERT INTO operational_events(id, shift_id, domain, entity_id, event_type, center, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(1, null, 'vehicle', 'V1', 'assignment', 'مركز C1', '2026-11-14T08:00:00.000Z');
  insert.run(2, null, 'vehicle', 'V2', 'assignment', 'مركز C2', '2026-11-14T08:01:00.000Z');
  insert.run(3, null, 'vehicle', 'V2', 'assignment_end', 'مركز C2', '2026-11-14T08:02:00.000Z');
  grant(db, 'leader', 'region', 'R1');
  grant(db, 'other', 'sector', 'S2');
  const permissionService = { hasPermission: async () => true };
  const scopeService = new RegionScopeService({ db, permissionService, now: () => NOW });
  const writes = [];
  const clients = [{ user: { id: 'leader' }, res: { writableEnded: false, write: data => writes.push(data), end() {} } }];
  const bridge = new RegionCommandEventBridge({
    db, scopeService, permissionService, getClients: () => clients,
    refreshActor: async () => ({ id: 'leader', role: 'director' }),
    isEnabled: () => true, now: () => NOW, logger: { error: () => {} }
  });
  const result = await bridge.afterOperationalCommit({ domain: 'vehicles', entity: { shiftId: '101' } });
  assert.equal(result.sent, 1);
  const events = writes.map(write => JSON.parse(write.replace(/^data: /, '').trim()));
  assert.deepEqual(events.map(event => event.sectorId), ['S1']);
  assert.equal(events.some(event => event.sectorId === 'S2'), false);
  db.close();
});
