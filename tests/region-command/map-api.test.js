'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const createRegionCommandRouter = require('../../routes/region-command-routes');
const RegionScopeService = require('../../services/region-scope-service');
const { createFixture, grant, NOW } = require('./fixtures');

test('map API enforces authentication, permission and sector scope without leaking the rejected ID', async () => {
  const db = createFixture();
  grant(db, 'leader', 'sector', 'S1');
  const permissionService = { hasPermission: async id => id === 'leader' };
  const scopeService = new RegionScopeService({ db, permissionService, now: () => NOW });
  const readService = { getSectorMap: async ({ actor, sectorId }) => {
    const sector = await scopeService.assertCanReadSector(actor, sectorId);
    return { success: true, sector: { id: sector.id }, incidents: { items: [] }, centers: [] };
  } };
  const app = express();
  app.use('/api/region-command', createRegionCommandRouter({
    authenticate: (req, res, next) => {
      if (!req.headers.authorization) return res.status(401).json({ code: 'UNAUTHENTICATED' });
      req.user = { id: req.headers.authorization.slice(7), role: 'user' };
      next();
    },
    authorizePerm: key => async (req, res, next) => {
      if (!(await permissionService.hasPermission(req.user.id, req.user.role, key))) return res.status(403).json({ code: 'PERMISSION_DENIED' });
      next();
    },
    getServices: () => ({ readService, scopeService, permissionService })
  }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/region-command/sectors`;
  const request = async (path, user) => {
    const response = await fetch(base + path, { headers: user ? { authorization: `Bearer ${user}` } : {} });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/S1/map')).status, 401);
  assert.equal((await request('/S1/map', 'nobody')).status, 403);
  assert.equal((await request('/S1/map', 'leader')).status, 200);
  const forbidden = await request('/S2/map', 'leader');
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.code, 'SCOPE_FORBIDDEN');
  assert.ok(!JSON.stringify(forbidden.body).includes('S2'));
  await new Promise(resolve => server.close(resolve));
  db.close();
});
