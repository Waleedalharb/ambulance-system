'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RegionCommandEventBridge = require('../../services/region-command-event-bridge');
const RegionScopeService = require('../../services/region-scope-service');
const { createFixture, grant, NOW } = require('./fixtures');

function setup() {
  const db = createFixture();
  db.hdl.exec('CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT, center TEXT); CREATE TABLE operational_events (id INTEGER PRIMARY KEY, shift_id TEXT, domain TEXT, center TEXT); CREATE TABLE shift_team_status (shift_id TEXT, team_id TEXT, status TEXT);');
  db.hdl.prepare('INSERT INTO teams(id, name, center) VALUES (?, ?, ?)').run('T1', 'فريق 1', 'مركز C1');
  grant(db, 'leader', 'region', 'R1');
  grant(db, 'other', 'sector', 'S2');
  const permissions = new Map([
    ['leader', new Set(['region.command.view', 'region.audit.view'])],
    ['other', new Set(['region.command.view'])],
    ['star', new Set(['region.command.view', 'region.audit.view'])]
  ]);
  const accounts = new Map(['leader', 'other', 'star'].map(id => [id, { id, role: id === 'star' ? 'admin' : 'user', active: true }]));
  const permissionService = { hasPermission: async (id, role, key) => permissions.has(id) && permissions.get(id).has(key) };
  const scopeService = new RegionScopeService({ db, permissionService, now: () => NOW });
  const clients = [];
  let sequence = 0;
  const bridge = new RegionCommandEventBridge({
    db, scopeService, permissionService, getClients: () => clients,
    refreshActor: async client => {
      const account = accounts.get(client.user.id);
      return account && account.active ? { id: account.id, role: account.role } : null;
    },
    isEnabled: () => true, now: () => NOW, idFactory: () => `event-${++sequence}`,
    logger: { error: () => {} }
  });
  const addClient = (id, options = {}) => {
    const res = { writes: [], ended: false, writableEnded: false, write(data) { this.writes.push(data); }, end() { this.ended = true; this.writableEnded = true; } };
    const client = { user: { id, role: 'stale-role' }, res, tokenExpiresAt: Date.parse(NOW) + 3600000, ...options };
    clients.push(client);
    return client;
  };
  return { db, bridge, clients, addClient, permissions, accounts };
}
const event = client => client.res.writes.length ? JSON.parse(client.res.writes[0].replace(/^data: /, '').trim()) : null;

test('only currently authorized region and sector clients receive the scoped event', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  const other = ctx.addClient('other');
  const star = ctx.addClient('star');
  const result = await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'مركز C1' }, sourceVersion: 'v1' });
  assert.equal(result.sent, 1);
  assert.equal(event(leader).sectorId, 'S1');
  assert.equal(event(leader).type, 'region_command_changed');
  assert.equal(event(other), null);
  assert.equal(event(star), null);
  assert.ok(!JSON.stringify(event(leader)).includes('مركز C1'));
  ctx.db.close();
});

test('CAD team events resolve through teams.center and unresolved events are not guessed', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  const result = await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'CAD', unit: 'فريق 1' } });
  assert.equal(result.sent, 1);
  assert.equal(event(leader).sectorId, 'S1');
  const unresolved = await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'CAD', unit: 'مجهول' } });
  assert.equal(unresolved.unresolved, 1);
  assert.equal(leader.res.writes.length, 1);
  ctx.db.close();
});

test('permission and scope revocation stop later events without closing shared channel', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  ctx.permissions.get('leader').delete('region.command.view');
  await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'مركز C1' } });
  assert.equal(leader.res.writes.length, 0);
  assert.equal(leader.res.ended, false);
  ctx.permissions.get('leader').add('region.command.view');
  ctx.db.hdl.prepare('UPDATE user_access_scopes SET effective_to = ? WHERE user_id = ?').run('2026-01-01T00:00:00.000Z', 'leader');
  await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'مركز C1' } });
  assert.equal(leader.res.writes.length, 0);
  assert.equal(leader.res.ended, false);
  ctx.db.close();
});

test('disabled account and expired token close without receiving another event', async () => {
  const ctx = setup();
  const disabled = ctx.addClient('leader');
  ctx.accounts.get('leader').active = false;
  await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'مركز C1' } });
  assert.equal(disabled.res.ended, true);
  assert.equal(disabled.res.writes.length, 0);
  ctx.accounts.get('leader').active = true;
  const expired = ctx.addClient('leader', { tokenExpiresAt: Date.parse(NOW) - 1 });
  await ctx.bridge.afterOperationalCommit({ domain: 'incidents', entity: { center: 'مركز C1' } });
  assert.equal(expired.res.ended, true);
  assert.equal(expired.res.writes.length, 0);
  ctx.db.close();
});

test('audit revocation blocks ledger event but not overview event', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  ctx.permissions.get('leader').delete('region.audit.view');
  await ctx.bridge.afterOperationalCommit({ domain: 'ledger', entity: { center: 'مركز C1' } });
  assert.equal(leader.res.writes.length, 0);
  await ctx.bridge.afterOperationalCommit({ domain: 'staffing', entity: { center: 'مركز C1' } });
  assert.equal(leader.res.writes.length, 1);
  ctx.db.close();
});

test('client write failure does not fail the originating operational commit', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  leader.res.write = () => { throw new Error('socket closed'); };
  const result = await ctx.bridge.afterOperationalCommit({ domain: 'vehicles', entity: { center: 'مركز C1' } });
  assert.equal(result.sent, 0);
  assert.equal(result.error, undefined);
  ctx.db.close();
});

test('completion decisions resolve sectors from the decision table even without operational events', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  ctx.db.hdl.prepare('INSERT INTO shift_team_status(shift_id, team_id, status) VALUES (?, ?, ?)').run('101', 'فريق 1', 'ready');
  const result = await ctx.bridge.afterOperationalCommit({ domain: 'staffing', entity: { shiftId: '101' } });
  assert.equal(result.sent, 1);
  assert.equal(event(leader).sectorId, 'S1');
  ctx.db.close();
});

test('shift lifecycle reaches every authorized sector without guessing a center', async () => {
  const ctx = setup();
  const leader = ctx.addClient('leader');
  const other = ctx.addClient('other');
  const result = await ctx.bridge.afterOperationalCommit({ domain: 'shifts', entity: { shiftId: '101' } });
  assert.equal(result.sent, 3);
  assert.deepEqual(leader.res.writes.map(write => JSON.parse(write.replace(/^data: /, '').trim()).sectorId), ['S1', 'S2']);
  assert.equal(event(other).sectorId, 'S2');
  ctx.db.close();
});
