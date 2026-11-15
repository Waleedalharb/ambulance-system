'use strict';

const crypto = require('crypto');
const { metric, quality } = require('./region-command-read-service');
const { RegionCommandError } = require('./region-command-errors');

function itemId(ruleKey, sectorId, entityId, sourceVersion) {
  return crypto.createHash('sha256').update([ruleKey, sectorId, entityId, sourceVersion || 'none'].join('|')).digest('hex').slice(0, 32);
}

class RegionDecisionCenterService {
  constructor({ readService, scopeService }) {
    this.readService = readService;
    this.scopeService = scopeService;
    this.readService.decisionCenter = this;
  }

  deriveForSector(sector) {
    const items = [];
    const sourceVersion = `${sector.shiftId || 'no-shift'}:${sector.generatedAt}`;
    const add = (ruleKey, entityId, category, reasonCode, evidence) => {
      items.push({
        id: itemId(ruleKey, sector.id, entityId, sourceVersion), ruleKey,
        sectorId: sector.id, entityId: String(entityId), category,
        status: 'needs_review', reasonCode, sourceVersion, evidence
      });
    };
    for (const [owner, source] of Object.entries(sector.dataQuality || {})) {
      if (source.status === 'unavailable' || source.status === 'stale') add('source_quality', owner, 'data_quality', source.reasonCode || 'SOURCE_STALE', { ownerService: owner, sourceAt: source.sourceAt || null, status: source.status });
    }
    for (const team of sector.teams || []) {
      if (['missing', 'offline', 'pending'].includes(team.status)) add('team_readiness', team.name, 'staffing', `TEAM_${team.status.toUpperCase()}`, { center: team.center, status: team.status, shiftId: sector.shiftId });
    }
    for (const vehicle of sector.vehicles || []) {
      if (['breakdown', 'out_of_service'].includes(vehicle.status) || !vehicle.center) add('vehicle_readiness', vehicle.id, 'vehicles', vehicle.center ? `VEHICLE_${vehicle.status.toUpperCase()}` : 'VEHICLE_CENTER_UNRESOLVED', { center: vehicle.center || null, status: vehicle.status, shiftId: sector.shiftId });
    }
    const hasUnavailable = Object.values(sector.dataQuality || {}).some(q => q.status === 'unavailable');
    const count = hasUnavailable
      ? metric(null, { status: 'unavailable', reasonCode: 'SOURCE_UNAVAILABLE', coverage: quality(1, 0, 'unknown') })
      : metric(items.length, { sourceAt: sector.generatedAt, coverage: quality(1, 1, 'complete') });
    return { items, count };
  }

  async list({ actor, filters = {}, cursor = null, limit = 50 }) {
    const requested = filters.sectorId === undefined ? undefined : filters.sectorId;
    const sectors = await this.scopeService.assertAllSectorsAuthorized(actor, requested);
    const size = Math.max(1, Math.min(Number(limit) || 50, 100));
    let all = [];
    let complete = true;
    for (const sector of sectors) {
      const detail = await this.readService.getSectorDetail({ actor, sectorId: sector.id, includeDecisionCount: false });
      const derived = this.deriveForSector(detail.sector);
      if (derived.count.value === null) complete = false;
      all.push(...derived.items);
    }
    if (filters.category) all = all.filter(item => item.category === filters.category);
    if (filters.status) {
      if (filters.status !== 'needs_review') return { success: true, items: [], nextCursor: null, count: metric(0, { coverage: quality(1, 1, 'complete') }) };
      all = all.filter(item => item.status === filters.status);
    }
    all.sort((a, b) => a.sectorId.localeCompare(b.sectorId) || a.id.localeCompare(b.id));
    const offset = cursor === null || cursor === undefined || cursor === '' ? 0 : Number(cursor);
    if (!Number.isInteger(offset) || offset < 0) throw new RegionCommandError('INVALID_CURSOR', 'مؤشر الصفحة غير صالح');
    const items = all.slice(offset, offset + size);
    return {
      success: true, items, nextCursor: offset + size < all.length ? String(offset + size) : null,
      count: complete ? metric(all.length, { coverage: quality(1, 1, 'complete') }) : metric(null, { status: 'unavailable', reasonCode: 'SOURCE_UNAVAILABLE', coverage: quality(1, 0, 'unknown') })
    };
  }

  async getEvidence({ actor, itemId: id }) {
    if (!id || typeof id !== 'string') throw new RegionCommandError('INVALID_ITEM', 'معرف العنصر غير صالح');
    const listed = await this.list({ actor, filters: {}, limit: 100 });
    const item = listed.items.find(entry => entry.id === id);
    if (!item) throw new RegionCommandError('DECISION_ITEM_NOT_FOUND', 'عنصر المراجعة غير موجود أو انتهت صلاحيته', 404);
    await this.scopeService.assertCanReadSector(actor, item.sectorId);
    return { success: true, item };
  }
}

module.exports = RegionDecisionCenterService;
module.exports.RegionDecisionCenterService = RegionDecisionCenterService;
