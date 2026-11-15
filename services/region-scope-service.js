'use strict';

const { RegionCommandError } = require('./region-command-errors');

function isoNow(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new RegionCommandError('INVALID_DATE', 'تاريخ غير صالح', 400);
  return date.toISOString();
}

class RegionScopeService {
  constructor({ db, permissionService = null, now = () => new Date() }) {
    if (!db) throw new Error('RegionScopeService: db مطلوب');
    this.db = db;
    this.permissionService = permissionService;
    this.now = now;
  }

  _at(at) { return isoNow(at || this.now()); }

  async resolveActorScopes(actor, at) {
    if (!actor || actor.id === undefined || actor.id === null) {
      throw new RegionCommandError('UNAUTHENTICATED', 'مطلوب تسجيل الدخول', 401);
    }
    const time = this._at(at);
    const rows = await this.db.all(
      `SELECT id, scope_type, scope_id, effective_from, effective_to
       FROM user_access_scopes
       WHERE user_id = ? AND status = 'active' AND effective_from <= ?
         AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY scope_type, scope_id`, [String(actor.id), time, time]
    );
    if (!rows.length) throw new RegionCommandError('NO_ACTIVE_SCOPE', 'لا يوجد نطاق وصول فعال', 403);
    const regionIds = rows.filter(r => r.scope_type === 'region').map(r => r.scope_id);
    const sectorIds = rows.filter(r => r.scope_type === 'sector').map(r => r.scope_id);
    const [regions, sectors] = await Promise.all([
      regionIds.length ? this.db.all(`SELECT id FROM regions WHERE id IN (${regionIds.map(() => '?').join(',')}) AND status = 'active'`, regionIds) : [],
      sectorIds.length ? this.db.all(`SELECT id, region_id FROM sectors WHERE id IN (${sectorIds.map(() => '?').join(',')}) AND status = 'active'`, sectorIds) : []
    ]);
    const validRegions = new Set(regions.map(r => r.id));
    const validSectors = new Set(sectors.map(r => r.id));
    const scopes = rows.filter(r => r.scope_type === 'region' ? validRegions.has(r.scope_id) : validSectors.has(r.scope_id))
      .map(r => ({ type: r.scope_type, id: r.scope_id }));
    if (!scopes.length) throw new RegionCommandError('NO_ACTIVE_SCOPE', 'لا يوجد نطاق وصول فعال', 403);
    return scopes;
  }

  async _allowedSectors(actor, at) {
    const time = this._at(at);
    const scopes = await this.resolveActorScopes(actor, time);
    const regions = scopes.filter(s => s.type === 'region').map(s => s.id);
    const sectorIds = scopes.filter(s => s.type === 'sector').map(s => s.id);
    const clauses = [];
    const params = [];
    if (regions.length) { clauses.push(`(s.region_id IN (${regions.map(() => '?').join(',')}))`); params.push(...regions); }
    if (sectorIds.length) { clauses.push(`(s.id IN (${sectorIds.map(() => '?').join(',')}))`); params.push(...sectorIds); }
    if (!clauses.length) throw new RegionCommandError('NO_ACTIVE_SCOPE', 'لا يوجد نطاق وصول فعال', 403);
    const rows = await this.db.all(
      `SELECT s.id, s.region_id, s.code, s.name, s.status
       FROM sectors s JOIN regions r ON r.id = s.region_id
       WHERE s.status = 'active' AND r.status = 'active' AND (${clauses.join(' OR ')})
       ORDER BY s.region_id, s.code, s.id`, params
    );
    if (!rows.length) throw new RegionCommandError('NO_ACTIVE_SCOPE', 'لا يوجد نطاق وصول فعال', 403);
    return { scopes, sectors: rows, at: time };
  }

  async resolveRegionSectors(actor, regionId, at) {
    const allowed = await this._allowedSectors(actor, at);
    const target = regionId || (allowed.scopes.length === 1
      ? (allowed.scopes[0].type === 'region' ? allowed.scopes[0].id : allowed.sectors[0].region_id)
      : null);
    if (!target) throw new RegionCommandError('REGION_REQUIRED', 'معرف المنطقة مطلوب', 400);
    const permitted = allowed.scopes.some(s => s.type === 'region' && s.id === target)
      || allowed.sectors.some(s => s.region_id === target);
    if (!permitted) throw new RegionCommandError('SCOPE_FORBIDDEN', 'النطاق المطلوب غير مصرح به', 403);
    const sectors = allowed.sectors.filter(s => s.region_id === target);
    if (!sectors.length) throw new RegionCommandError('NO_ACTIVE_SCOPE', 'لا توجد قطاعات فعالة ضمن النطاق', 403);
    return { regionId: target, sectors, scopes: allowed.scopes, at: allowed.at };
  }

  async assertCanReadRegion(actor, regionId, at) {
    await this.resolveRegionSectors(actor, regionId, at);
    return true;
  }

  async assertCanReadSector(actor, sectorId, at) {
    if (!sectorId || typeof sectorId !== 'string') throw new RegionCommandError('INVALID_SECTOR', 'معرف القطاع غير صالح', 400);
    const allowed = await this._allowedSectors(actor, at);
    const sector = allowed.sectors.find(s => s.id === sectorId);
    if (!sector) throw new RegionCommandError('SCOPE_FORBIDDEN', 'القطاع المطلوب غير مصرح به', 403);
    return sector;
  }

  async assertAllSectorsAuthorized(actor, requestedIds, at) {
    const allowed = await this._allowedSectors(actor, at);
    if (requestedIds === undefined || requestedIds === null || (Array.isArray(requestedIds) && requestedIds.length === 0)) return allowed.sectors;
    const ids = Array.isArray(requestedIds) ? requestedIds : [requestedIds];
    if (ids.some(id => typeof id !== 'string' || !id || id.includes(','))) throw new RegionCommandError('INVALID_SECTOR', 'معرف القطاع غير صالح', 400);
    const unique = [...new Set(ids)];
    const byId = new Map(allowed.sectors.map(s => [s.id, s]));
    if (unique.some(id => !byId.has(id))) throw new RegionCommandError('SCOPE_FORBIDDEN', 'أحد القطاعات المطلوبة غير مصرح به', 403);
    return unique.map(id => byId.get(id));
  }

  async resolveSectorCenters(actor, sectorId, at) {
    const time = this._at(at);
    await this.assertCanReadSector(actor, sectorId, time);
    return this.db.all(
      `SELECT sc.id AS link_id, sc.center_id AS id, c.name, sc.effective_from, sc.effective_to
       FROM sector_centers sc JOIN centers c ON CAST(c.id AS TEXT) = sc.center_id
       WHERE sc.sector_id = ? AND sc.effective_from <= ? AND (sc.effective_to IS NULL OR sc.effective_to > ?)
       ORDER BY c.name, sc.center_id`, [sectorId, time, time]
    );
  }

  async canViewSector(actor, sectorId, permissionService = this.permissionService, at) {
    try {
      if (!permissionService || !(await permissionService.hasPermission(String(actor.id), actor.role, 'region.command.view'))) return false;
      await this.assertCanReadSector(actor, sectorId, at);
      return true;
    } catch (_) { return false; }
  }
}

module.exports = RegionScopeService;
module.exports.RegionScopeService = RegionScopeService;
