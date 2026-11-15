'use strict';

const express = require('express');
const { RegionCommandError } = require('../services/region-command-errors');

function one(value, name) {
  if (Array.isArray(value)) throw new RegionCommandError('INVALID_PARAMETER', `معامل ${name} غير صالح`);
  return value;
}
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createRegionCommandRouter({ authenticate, authorizePerm, getServices, isEnabled = () => process.env.REGION_COMMAND_ENABLED === 'true' }) {
  const router = express.Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    if (!isEnabled()) return res.status(404).json({ success: false, code: 'FEATURE_DISABLED', error: 'المسار غير موجود' });
    next();
  });
  const view = authorizePerm('region.command.view');
  const audit = authorizePerm('region.audit.view');

  router.get('/context', view, asyncRoute(async (req, res) => {
    const services = getServices();
    const scopes = await services.scopeService.resolveActorScopes(req.user);
    const canViewLedger = await services.permissionService.hasPermission(String(req.user.id), req.user.role, 'region.audit.view');
    res.json({
      success: true,
      actor: { id: String(req.user.id), name: req.user.name || null },
      scopes,
      capabilities: { canViewCommand: true, canViewLedger, canViewTeamLocations: false },
      serverTime: new Date().toISOString()
    });
  }));

  router.get('/overview', view, asyncRoute(async (req, res) => {
    const regionId = one(req.query.regionId, 'regionId');
    const viewMode = one(req.query.view, 'view') || 'current';
    res.json(await getServices().readService.getOverview({ actor: req.user, regionId, view: viewMode }));
  }));

  router.get('/sectors/:id', view, asyncRoute(async (req, res) => {
    res.json(await getServices().readService.getSectorDetail({
      actor: req.user, sectorId: req.params.id,
      view: one(req.query.view, 'view') || 'current', shiftId: one(req.query.shiftId, 'shiftId') || null
    }));
  }));

  router.get('/sectors/:id/map', view, asyncRoute(async (req, res) => {
    res.json(await getServices().readService.getSectorMap({
      actor: req.user, sectorId: req.params.id,
      view: one(req.query.view, 'view') || 'current', shiftId: one(req.query.shiftId, 'shiftId') || null
    }));
  }));

  router.get('/decision-center', view, asyncRoute(async (req, res) => {
    const filters = {
      sectorId: req.query.sectorId,
      category: one(req.query.category, 'category'), status: one(req.query.status, 'status')
    };
    res.json(await getServices().decisionCenter.list({
      actor: req.user, filters, cursor: one(req.query.cursor, 'cursor'), limit: one(req.query.limit, 'limit') || 50
    }));
  }));

  router.get('/decision-center/:itemId/evidence', view, asyncRoute(async (req, res) => {
    res.json(await getServices().decisionCenter.getEvidence({ actor: req.user, itemId: req.params.itemId }));
  }));

  router.get('/sectors/:id/ledger', audit, asyncRoute(async (req, res) => {
    const result = await getServices().ledgerService.list({
      actor: req.user, sectorId: req.params.id,
      filters: {
        eventType: one(req.query.eventType, 'eventType'), actorId: one(req.query.actorId, 'actorId'),
        from: one(req.query.from, 'from'), to: one(req.query.to, 'to')
      }, cursor: one(req.query.cursor, 'cursor'), limit: one(req.query.limit, 'limit') || 50
    });
    res.json({ success: true, ...result });
  }));

  router.get('/sectors/:sectorId/ledger/:entryId', audit, asyncRoute(async (req, res) => {
    const entry = await getServices().ledgerService.getEntry({ actor: req.user, sectorId: req.params.sectorId, entryId: req.params.entryId });
    res.json({ success: true, entry });
  }));

  router.get('/metrics/:key/evidence', view, asyncRoute(async (req, res) => {
    res.json(await getServices().readService.getMetricEvidence({
      actor: req.user, sectorId: one(req.query.sectorId, 'sectorId'), metricKey: req.params.key,
      metricVersion: one(req.query.metricVersion, 'metricVersion'), view: one(req.query.view, 'view') || 'current',
      shiftId: one(req.query.shiftId, 'shiftId') || null
    }));
  }));

  router.use((err, req, res, next) => {
    const status = Number(err.statusCode) || 500;
    if (status >= 500) console.error('[RegionCommand] request failed:', err.message);
    res.status(status).json({
      success: false,
      code: err.code || 'INTERNAL_ERROR',
      error: status >= 500 ? 'تعذر إكمال الطلب' : err.message
    });
  });
  return router;
}

module.exports = createRegionCommandRouter;
module.exports.createRegionCommandRouter = createRegionCommandRouter;
