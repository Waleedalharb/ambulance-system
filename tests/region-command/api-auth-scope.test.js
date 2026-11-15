'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const createRegionCommandRouter = require('../../routes/region-command-routes');
const RegionScopeService = require('../../services/region-scope-service');
const RegionDecisionCenterService = require('../../services/region-decision-center-service');
const { createFixture, grant, NOW } = require('./fixtures');

async function setup() {
  const db = createFixture();
  grant(db, 'leader', 'region', 'R1');
  grant(db, 'sector', 'sector', 'S1');
  const permissions = new Map([
    ['leader', new Set(['region.command.view', 'region.audit.view'])],
    ['sector', new Set(['region.command.view'])],
    ['audit-only', new Set(['region.audit.view'])],
    ['star', new Set(['*'])]
  ]);
  const permissionService = { hasPermission: async (id, role, key) => permissions.has(id) && (permissions.get(id).has('*') || permissions.get(id).has(key)) };
  const scopeService = new RegionScopeService({ db, permissionService, now: () => NOW });
  let decisionReads = 0;
  const readService = {
    decisionCenter: null,
    getOverview: async ({ actor, regionId }) => {
      const resolved = await scopeService.resolveRegionSectors(actor, regionId);
      return { success: true, scope: { regionId: resolved.regionId }, sectors: resolved.sectors.map(s => ({ id: s.id })) };
    },
    getSectorDetail: async ({ actor, sectorId }) => {
      const sector = await scopeService.assertCanReadSector(actor, sectorId);
      decisionReads += 1;
      return { success: true, sector: { id: sector.id, generatedAt: NOW, shiftId: '1', dataQuality: {}, teams: [], vehicles: [] } };
    }
  };
  const decisionCenter = new RegionDecisionCenterService({ readService, scopeService });
  const services = { scopeService, readService, decisionCenter, permissionService, ledgerService: { list: async () => ({ entries: [], nextCursor: null }) } };
  const app = express();
  const authenticate = (req, res, next) => {
    if (!req.headers.authorization) return res.status(401).json({ code: 'UNAUTHENTICATED' });
    const id = req.headers.authorization.replace('Bearer ', '');
    req.user = { id, role: id === 'star' ? 'admin' : 'user', name: id };
    next();
  };
  const authorizePerm = key => async (req, res, next) => {
    if (!(await permissionService.hasPermission(req.user.id, req.user.role, key))) return res.status(403).json({ code: 'PERMISSION_DENIED' });
    next();
  };
  let enabled = true;
  app.use('/api/region-command', createRegionCommandRouter({ authenticate, authorizePerm, getServices: () => services, isEnabled: () => enabled }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/region-command`;
  const request = async (path, user) => {
    const response = await fetch(base + path, { headers: user ? { authorization: `Bearer ${user}` } : {} });
    return { status: response.status, body: await response.json() };
  };
  return { db, server, request, setEnabled: value => { enabled = value; }, decisionReads: () => decisionReads };
}

test('API enforces authentication, permission, active scope and feature flag', async () => {
  const ctx = await setup();
  assert.equal((await ctx.request('/context')).status, 401);
  assert.equal((await ctx.request('/context', 'nobody')).status, 403);
  assert.equal((await ctx.request('/overview', 'audit-only')).status, 403);
  assert.equal((await ctx.request('/overview?regionId=R1', 'star')).status, 403);
  const ok = await ctx.request('/overview?regionId=R1', 'leader');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.sectors.map(s => s.id), ['S1', 'S2']);
  ctx.setEnabled(false);
  assert.equal((await ctx.request('/context', 'leader')).status, 404);
  await new Promise(resolve => ctx.server.close(resolve));
  ctx.db.close();
});

test('mixed sector IDs fail as one request with no allowed-sector read', async () => {
  const ctx = await setup();
  const response = await ctx.request('/decision-center?sectorId=S1&sectorId=S3', 'leader');
  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'SCOPE_FORBIDDEN');
  assert.equal(ctx.decisionReads(), 0);
  assert.ok(!JSON.stringify(response.body).includes('S3'));
  const comma = await ctx.request('/decision-center?sectorId=S1%2CS2', 'leader');
  assert.equal(comma.status, 400);
  await new Promise(resolve => ctx.server.close(resolve));
  ctx.db.close();
});

test('sector leader receives only own sector and audit permission is independent', async () => {
  const ctx = await setup();
  const own = await ctx.request('/overview?regionId=R1', 'sector');
  assert.deepEqual(own.body.sectors.map(s => s.id), ['S1']);
  assert.equal((await ctx.request('/sectors/S2', 'sector')).status, 403);
  assert.equal((await ctx.request('/sectors/S1/ledger', 'sector')).status, 403);
  assert.equal((await ctx.request('/sectors/S1/ledger', 'leader')).status, 200);
  await new Promise(resolve => ctx.server.close(resolve));
  ctx.db.close();
});
