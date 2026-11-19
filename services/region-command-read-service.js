'use strict';

const fs = require('fs');
const path = require('path');
const { RegionCommandError } = require('./region-command-errors');
const { getMetric, METRICS } = require('../config/region-command-metrics');
const TeamCode = require('../public/js/operational-team-code');

function withTeamIdentity(team, shiftType) {
  return { ...team, ...TeamCode.identityFields(team.name, shiftType) };
}
function incidentTeamViews(incident, teamNames, shiftType) {
  const seen = new Set();
  const identities = [];
  for (const crew of incident.crews || []) {
    if (!crew.counted || !teamNames.has(crew.unit) || seen.has(crew.unit)) continue;
    seen.add(crew.unit);
    identities.push(TeamCode.identityFields(crew.unit, shiftType));
  }
  return { teams: identities.map(identity => identity.name), teamIdentities: identities };
}

const COMPLETE = 'complete';
function quality(expected = null, available = null, status = 'unknown') {
  return { expected, available, status };
}
function metric(value, options = {}) {
  const status = options.status || 'ok';
  let finalValue = value;
  if (['unavailable', 'unresolved', 'not_applicable'].includes(status)) finalValue = null;
  if (status === 'partial' && options.allowPartialValue !== true) finalValue = null;
  if (finalValue === 0 && (status !== 'ok' || options.coverage && options.coverage.status !== COMPLETE)) finalValue = null;
  return {
    value: finalValue,
    status: finalValue === null && status === 'ok' ? 'not_applicable' : status,
    reasonCode: options.reasonCode || null,
    sourceAt: options.sourceAt || null,
    coverage: options.coverage || quality()
  };
}
function unavailable(reasonCode = 'SOURCE_UNAVAILABLE') {
  return metric(null, { status: 'unavailable', reasonCode });
}
function latest(values) {
  const valid = values.filter(Boolean).map(v => {
    if (typeof v === 'number') return new Date(v).toISOString();
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }).filter(Boolean).sort();
  return valid.length ? valid[valid.length - 1] : null;
}
function sourceStatus(sourceAt, stale) { return stale ? 'stale' : 'ok'; }
const RIYADH_DAY_FORMAT = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' });
function riyadhDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = RIYADH_DAY_FORMAT.formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function count(value, sourceAt, expected, available, options = {}) {
  const coverage = quality(expected, available, expected === null || available === null ? 'unknown' : available === expected ? COMPLETE : 'partial');
  if (coverage.status === 'partial') return metric(null, { status: 'partial', reasonCode: 'COVERAGE_INCOMPLETE', sourceAt, coverage });
  return metric(value, { sourceAt, coverage, status: options.stale ? 'stale' : 'ok' });
}
function timeAverage(incidents, key, sourceAt, stale = false) {
  if (!incidents.length) return metric(null, { status: 'not_applicable', reasonCode: 'NO_INCIDENTS', sourceAt, coverage: quality(0, 0, COMPLETE) });
  const values = incidents.map(i => i[key]).filter(v => typeof v === 'number' && Number.isFinite(v));
  const coverage = quality(incidents.length, values.length, values.length === incidents.length ? COMPLETE : 'partial');
  if (!values.length) return metric(null, { status: 'partial', reasonCode: 'RESPONSE_TIME_COVERAGE_INCOMPLETE', sourceAt, coverage });
  const value = Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10;
  // المتوسط المحسوب من الأزمنة المسجلة يبقى مفيدًا، بشرط إظهار تغطيته الناقصة
  // بجواره بدل إخفائه أو تقديمه كمتوسط مكتمل لكل البلاغات.
  return metric(value, {
    status: values.length === incidents.length ? (stale ? 'stale' : 'ok') : 'partial',
    reasonCode: values.length === incidents.length ? null : 'RESPONSE_TIME_COVERAGE_INCOMPLETE',
    sourceAt, coverage, allowPartialValue: true
  });
}
function crewKeepsTeamBusy(crew) {
  if (!crew || crew.withdrawn || crew.manualCancelled || crew.legacySnapshot) return false;
  return !['B', 'C', 'R'].includes(String(crew.cadUrs || '').toUpperCase());
}

// تصنيف البلاغات المطلوب في العرض الجغرافي يعتمد رمز ProQA المسجل في CAD فقط،
// دون استنتاج من النص الحر: 29/34 حوادث، 30 إصابات، 7 حرائق، 26 مرضية، و9 توقف قلب وتنفس.
function incidentCategory(code) {
  const match = String(code || '').trim().match(/^(\d{1,2})/);
  return match ? parseInt(match[1], 10) : null;
}
const INCIDENT_BREAKDOWN_BUCKETS = [
  { key: 'accidents', label: 'حوادث', test: category => category === 29 || category === 34 },
  { key: 'injuries', label: 'إصابات', test: category => category === 30 },
  { key: 'fires', label: 'حرائق', test: category => category === 7 },
  { key: 'medical', label: 'مرضية', test: category => category === 26 },
  { key: 'echo', label: 'إيكو — توقف قلب وتنفس', test: category => category === 9 }
];
function breakdownUnavailable(reasonCode) {
  return { status: 'unavailable', reasonCode, sourceAt: null, items: [] };
}

class RegionCommandReadService {
  constructor({ scopeService, staffingService, vehicleService, reportService, centersGeoService = null, positioningService = null, getActiveShift, now = () => new Date() }) {
    if (!scopeService) throw new Error('RegionCommandReadService: scopeService مطلوب');
    this.scopeService = scopeService;
    this.staffingService = staffingService;
    this.vehicleService = vehicleService;
    this.reportService = reportService;
    this.centersGeoService = centersGeoService;
    this.positioningService = positioningService;
    this.getActiveShift = getActiveShift;
    this.now = now;
    this.decisionCenter = null;
    this._boundariesByName = undefined;
  }

  // حدود القطاعات المعتمدة من ملف GeoJSON محلي (data/sector-boundaries.geojson).
  // تُطابَق باسم القطاع فقط؛ أي قطاع بلا سجل يُعاد بلا حدود ولا يُختلق له مضلع.
  _sectorBoundary(sector) {
    if (this._boundariesByName === undefined) {
      this._boundariesByName = null;
      try {
        const file = path.join(__dirname, '..', 'data', 'sector-boundaries.geojson');
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const features = parsed && Array.isArray(parsed.features) ? parsed.features : [];
        const map = new Map();
        for (const feature of features) {
          const name = feature && feature.properties && feature.properties.name;
          const geometry = feature && feature.geometry;
          if (!name || !geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type)) continue;
          map.set(String(name).trim(), { type: 'Feature', properties: feature.properties, geometry });
        }
        this._boundariesByName = map;
      } catch (_) { this._boundariesByName = null; }
    }
    if (!this._boundariesByName || !sector || !sector.name) return null;
    return this._boundariesByName.get(String(sector.name).trim()) || null;
  }

  async _shift(sector, centers, requestedShiftId) {
    if (!this.getActiveShift) return { shift: null, error: 'SOURCE_UNAVAILABLE' };
    try {
      const shift = await this.getActiveShift({ sectorId: sector.id, centerIds: centers.map(c => c.id), centerNames: centers.map(c => c.name) });
      if (requestedShiftId && (!shift || String(shift.id) !== String(requestedShiftId))) {
        throw new RegionCommandError('SHIFT_NOT_IN_SCOPE', 'المناوبة المطلوبة غير متاحة ضمن القطاع الحالي', 403);
      }
      return { shift: shift || null, error: null };
    } catch (error) {
      if (error instanceof RegionCommandError) throw error;
      return { shift: null, error: 'SOURCE_UNAVAILABLE' };
    }
  }

  async _snapshot({ actor, sector, view = 'current', shiftId = null }) {
    if (view !== 'current') throw new RegionCommandError('UNSUPPORTED_VIEW', 'الوضع الزمني المطلوب غير مدعوم', 400);
    const centers = await this.scopeService.resolveSectorCenters(actor, sector.id);
    const centerNames = new Set(centers.map(c => c.name));
    const shiftResult = await this._shift(sector, centers, shiftId);
    const shift = shiftResult.shift;
    const currentShiftId = shift && shift.id !== undefined ? String(shift.id) : null;
    const generatedAt = new Date(this.now()).toISOString();
    const base = {
      id: sector.id, regionId: sector.region_id, code: sector.code, name: sector.name,
      status: 'complete', view, shiftId: currentShiftId, generatedAt,
      shift: shift ? { id: String(shift.id), name: shift.shift_name || shift.name || null, type: shift.shift_type || null, date: shift.shift_date || null } : null,
      centers: centers.map(c => ({ id: String(c.id), name: c.name })),
      teams: [], vehicles: [], incidents: [], metrics: {}, dataQuality: {}, sourceMeta: [],
      incidentBreakdown: breakdownUnavailable(shiftResult.error || 'NO_ACTIVE_SHIFT')
    };
    if (!currentShiftId) {
      const reason = shiftResult.error || 'NO_ACTIVE_SHIFT';
      for (const key of Object.keys(METRICS)) {
        if (!['sectorCount', 'centerCount', 'decisionCount'].includes(key)) base.metrics[key] = unavailable(reason);
      }
      base.metrics.centerCount = count(centers.length, null, centers.length, centers.length);
      base.metrics.teamsBusy = unavailable(reason);
      for (const owner of ['StaffingEventsService', 'VehicleEventsService', 'ReportService']) {
        base.dataQuality[owner] = { status: 'unavailable', reasonCode: reason, sourceAt: null };
        base.sourceMeta.push({ ownerService: owner, status: 'unavailable', reasonCode: reason, sourceAt: null });
      }
      return base;
    }

    const [staffing, vehicles, incidents] = await Promise.all([
      this._readSource('StaffingEventsService', () => this.staffingService && this.staffingService.deriveTeamReadiness(shift.id)),
      this._readSource('VehicleEventsService', () => this.vehicleService && (this.vehicleService.getBoard
        ? this.vehicleService.getBoard(shift.id)
        : this.vehicleService.getState(shift.id, { includeCurrentAssignments: true }))),
      this._readSource('ReportService', () => this.reportService && this.reportService.getIncidentSummary(shift.id))
    ]);
    base.metrics.centerCount = count(centers.length, null, centers.length, centers.length);

    let sectorTeams = [];
    if (!staffing.error) {
      const sourceAt = latest(Object.values(staffing.value.teams || {}).map(t => t.lastDecision && t.lastDecision.at));
      const allTeams = Object.entries(staffing.value.teams || {});
      sectorTeams = allTeams.filter(([, team]) => team.center && centerNames.has(team.center)).map(([name, team]) => ({
        name, center: team.center, status: team.status || 'pending',
        activeCount: team.activeCount, requiredPersonnel: team.requiredPersonnel,
        vehicleId: team.vehicleId === undefined || team.vehicleId === null ? null : String(team.vehicleId),
        vehicleStatus: team.vehicleStatus || null, lastDecisionAt: team.lastDecision && team.lastDecision.at || null
      }));
      const expected = sectorTeams.length;
      const available = sectorTeams.filter(t => typeof t.activeCount === 'number' && typeof t.requiredPersonnel === 'number').length;
      const status = sourceStatus(sourceAt, staffing.value.stale === true);
      const metricFor = (value, key) => count(value, sourceAt, expected, expected, { stale: status === 'stale' });
      base.metrics.teamsTotal = metricFor(expected);
      for (const [key, teamStatus] of [['teamsReady', 'ready'], ['teamsMissing', 'missing'], ['teamsOffline', 'offline'], ['teamsPending', 'pending']]) {
        base.metrics[key] = metricFor(sectorTeams.filter(t => t.status === teamStatus).length);
      }
      base.metrics.staffActive = count(sectorTeams.reduce((sum, t) => sum + (t.activeCount || 0), 0), sourceAt, expected, available, { stale: status === 'stale' });
      base.metrics.staffRequired = count(sectorTeams.reduce((sum, t) => sum + (t.requiredPersonnel || 0), 0), sourceAt, expected, available, { stale: status === 'stale' });
      const requiredTeams = sectorTeams.length;
      const readyTeams = sectorTeams.filter(t => t.status === 'ready').length;
      base.metrics.readinessRate = requiredTeams > 0
        ? count(Math.round(readyTeams / requiredTeams * 100), sourceAt, requiredTeams, requiredTeams, { stale: status === 'stale' })
        : metric(null, { status: 'not_applicable', reasonCode: 'NO_REQUIRED_TEAMS', sourceAt, coverage: quality(0, 0, COMPLETE) });
      base.teams = sectorTeams.map(team => withTeamIdentity({
        ...team,
        activeCount: count(team.activeCount, sourceAt, 1, typeof team.activeCount === 'number' ? 1 : 0, { stale: status === 'stale' }),
        requiredPersonnel: count(team.requiredPersonnel, sourceAt, 1, typeof team.requiredPersonnel === 'number' ? 1 : 0, { stale: status === 'stale' })
      }, shift.shift_type));
      base.dataQuality.StaffingEventsService = { status, reasonCode: null, sourceAt };
      base.sourceMeta.push({ ownerService: 'StaffingEventsService', status, sourceAt, shiftId: currentShiftId });
    } else {
      for (const key of ['teamsTotal', 'teamsReady', 'teamsMissing', 'teamsOffline', 'teamsPending', 'staffActive', 'staffRequired', 'readinessRate', 'operationalPressure']) base.metrics[key] = unavailable(staffing.error);
      base.dataQuality.StaffingEventsService = { status: 'unavailable', reasonCode: staffing.error, sourceAt: null };
      base.sourceMeta.push({ ownerService: 'StaffingEventsService', status: 'unavailable', reasonCode: staffing.error, sourceAt: null });
    }

    if (!vehicles.error) {
      const teamByVehicle = new Map(sectorTeams.filter(team => team.vehicleId).map(team => [String(team.vehicleId), team]));
      let withStatus;
      if (Array.isArray(vehicles.value.vehicles)) {
        // getBoard يشتق الحالة الحالية من كامل خط المركبة، حتى إن لم يتغير
        // وضعها خلال هذه المناوبة؛ getState وحده كان يعيد 0/0 في هذه الحالة.
        withStatus = vehicles.value.vehicles.map(vehicle => {
          const team = teamByVehicle.get(String(vehicle.id));
          return team && centerNames.has(team.center) ? {
            id: String(vehicle.id), name: vehicle.name || null, center: team.center,
            teamName: team.name, status: vehicle.status || null, sourceAt: vehicle.since || null
          } : null;
        }).filter(Boolean);
      } else {
        const entities = (vehicles.value.entities || []).filter(e => e.center && centerNames.has(e.center));
        withStatus = entities.map(e => {
          const open = Array.isArray(e.open) ? e.open : [];
          const statusEvent = [...open].reverse().find(event => event.status);
          return {
            id: String(e.entityId), name: e.entityName || null, center: e.center,
            status: statusEvent ? statusEvent.status : null,
            sourceAt: statusEvent && statusEvent.created_at || e.lastEvent && e.lastEvent.created_at || null
          };
        });
      }
      const sourceAt = latest(withStatus.map(v => v.sourceAt));
      base.metrics.vehiclesTotal = count(withStatus.length, sourceAt, withStatus.length, withStatus.length, { stale: vehicles.value.stale === true });
      base.metrics.vehiclesActive = count(withStatus.filter(v => v.status === 'active').length, sourceAt, withStatus.length, withStatus.length, { stale: vehicles.value.stale === true });
      base.vehicles = withStatus;
      const status = sourceStatus(sourceAt, vehicles.value.stale === true);
      base.dataQuality.VehicleEventsService = { status, reasonCode: null, sourceAt };
      base.sourceMeta.push({ ownerService: 'VehicleEventsService', status, sourceAt, shiftId: currentShiftId });
    } else {
      base.metrics.vehiclesTotal = unavailable(vehicles.error);
      base.metrics.vehiclesActive = unavailable(vehicles.error);
      base.dataQuality.VehicleEventsService = { status: 'unavailable', reasonCode: vehicles.error, sourceAt: null };
      base.sourceMeta.push({ ownerService: 'VehicleEventsService', status: 'unavailable', reasonCode: vehicles.error, sourceAt: null });
    }

    if (staffing.error) {
      // لا يمكن نسب البلاغ إلى القطاع بلا قائمة فرقه؛ الصفر هنا سيكون مضللًا.
      for (const key of ['incidentsTotal', 'incidentsActive', 'avgResponseMinutes', 'avgMubasharaMinutes', 'teamsBusy', 'operationalPressure']) base.metrics[key] = unavailable('TEAM_SCOPE_SOURCE_UNAVAILABLE');
      base.incidentBreakdown = breakdownUnavailable('TEAM_SCOPE_SOURCE_UNAVAILABLE');
      base.dataQuality.ReportService = { status: 'unavailable', reasonCode: 'TEAM_SCOPE_SOURCE_UNAVAILABLE', sourceAt: null };
      base.sourceMeta.push({ ownerService: 'ReportService', status: 'unavailable', reasonCode: 'TEAM_SCOPE_SOURCE_UNAVAILABLE', sourceAt: null });
    } else if (!incidents.error) {
      const teamNames = new Set(sectorTeams.map(t => t.name));
      const allIncidents = incidents.value.incidents || [];
      const relevant = allIncidents.filter(incident => (incident.crews || []).some(c => c.counted && teamNames.has(c.unit)));
      const sourceAt = latest(relevant.map(i => i.createdAt || i.cadCreatedAt));
      const incidentStale = incidents.value.stale === true;
      base.metrics.incidentsTotal = count(relevant.length, sourceAt, relevant.length, relevant.length, { stale: incidentStale });
      base.metrics.incidentsActive = count(relevant.filter(i => i.status === 'active').length, sourceAt, relevant.length, relevant.length, { stale: incidentStale });
      base.incidentBreakdown = {
        status: incidentStale ? 'stale' : 'ok', reasonCode: null, sourceAt,
        items: INCIDENT_BREAKDOWN_BUCKETS.map(bucket => {
          const bucketIncidents = relevant.filter(i => bucket.test(incidentCategory(i.code), i.code));
          return {
            key: bucket.key, label: bucket.label,
            total: count(bucketIncidents.length, sourceAt, bucketIncidents.length, bucketIncidents.length, { stale: incidentStale }),
            active: count(bucketIncidents.filter(i => i.status === 'active').length, sourceAt, bucketIncidents.length, bucketIncidents.length, { stale: incidentStale }),
            avgResponseMinutes: timeAverage(bucketIncidents, 'bestArrivalMin', sourceAt, incidentStale)
          };
        })
      };
      base.metrics.avgResponseMinutes = timeAverage(relevant, 'bestArrivalMin', sourceAt, incidents.value.stale === true);
      base.metrics.avgMubasharaMinutes = timeAverage(relevant, 'bestMubasharaMin', sourceAt, incidents.value.stale === true);
      base.incidents = relevant.map(i => ({
        id: String(i.number), code: i.code || null, type: i.type || null, status: i.status || 'active', severity: i.severity || null,
        createdAt: i.createdAt || i.cadCreatedAt || null, district: i.district || null,
        bestArrivalMin: typeof i.bestArrivalMin === 'number' ? metric(i.bestArrivalMin, { sourceAt, coverage: quality(1, 1, COMPLETE) }) : unavailable('RESPONSE_TIME_UNAVAILABLE'),
        bestMubasharaMin: typeof i.bestMubasharaMin === 'number' ? metric(i.bestMubasharaMin, { sourceAt, coverage: quality(1, 1, COMPLETE) }) : unavailable('RESPONSE_TIME_UNAVAILABLE'),
        ...incidentTeamViews(i, teamNames, shift.shift_type)
      }));

      // الترشيح الفعلي في CAD (بما فيه قبول الوحدة قبل تسجيل أول مرحلة)
      // يغيّر قابلية الفرقة للتكليف، لكنه لا يدخل عدّاد المشاركة أو الإنجاز.
      const busyByTeam = new Map();
      for (const incident of allIncidents) {
        if (incident.status !== 'active') continue;
        for (const crew of incident.crews || []) {
          if (!teamNames.has(crew.unit) || !crewKeepsTeamBusy(crew)) continue;
          if (!busyByTeam.has(crew.unit)) busyByTeam.set(crew.unit, []);
          busyByTeam.get(crew.unit).push(String(incident.number));
        }
      }
      const staffingSourceAt = base.metrics.teamsTotal.sourceAt;
      const staffingStale = base.metrics.teamsTotal.status === 'stale';
      base.teams = sectorTeams.map(team => {
        const activeIncidentIds = busyByTeam.get(team.name) || [];
        return withTeamIdentity({
          ...team, completionStatus: team.status,
          status: team.status === 'ready' && activeIncidentIds.length ? 'busy' : team.status,
          activeIncidentIds,
          activeCount: count(team.activeCount, staffingSourceAt, 1, typeof team.activeCount === 'number' ? 1 : 0, { stale: staffingStale }),
          requiredPersonnel: count(team.requiredPersonnel, staffingSourceAt, 1, typeof team.requiredPersonnel === 'number' ? 1 : 0, { stale: staffingStale })
        }, shift.shift_type);
      });
      const readyTeams = base.teams.filter(team => team.status === 'ready').length;
      const expected = base.teams.length;
      base.metrics.teamsReady = count(readyTeams, staffingSourceAt, expected, expected, { stale: staffingStale });
      base.metrics.teamsBusy = count([...busyByTeam.keys()].length, sourceAt, expected, expected, { stale: incidents.value.stale === true });
      base.metrics.readinessRate = expected > 0
        ? count(Math.round(readyTeams / expected * 100), staffingSourceAt, expected, expected, { stale: staffingStale })
        : metric(null, { status: 'not_applicable', reasonCode: 'NO_REQUIRED_TEAMS', sourceAt: staffingSourceAt, coverage: quality(0, 0, COMPLETE) });
      // الضغط التشغيلي: الفرق المشغولة في بلاغات من إجمالي فرق القطاع — يقيس
      // استنزاف القوة الكلية ولا يتضخم بانشغال الفرق كالقسمة على الجاهزة فقط.
      const busyTeamsCount = [...busyByTeam.keys()].length;
      base.metrics.operationalPressure = expected === 0
        ? metric(null, { status: 'not_applicable', reasonCode: 'NO_REQUIRED_TEAMS', sourceAt, coverage: quality(0, 0, COMPLETE) })
        : count(Math.round(busyTeamsCount / expected * 100), sourceAt, expected, expected, { stale: incidentStale });
      const status = sourceStatus(sourceAt, incidents.value.stale === true);
      base.dataQuality.ReportService = { status, reasonCode: null, sourceAt };
      base.sourceMeta.push({ ownerService: 'ReportService', status, sourceAt, shiftId: currentShiftId });
    } else {
      for (const key of ['incidentsTotal', 'incidentsActive', 'avgResponseMinutes', 'avgMubasharaMinutes', 'teamsBusy', 'operationalPressure']) base.metrics[key] = unavailable(incidents.error);
      base.incidentBreakdown = breakdownUnavailable(incidents.error);
      base.dataQuality.ReportService = { status: 'unavailable', reasonCode: incidents.error, sourceAt: null };
      base.sourceMeta.push({ ownerService: 'ReportService', status: 'unavailable', reasonCode: incidents.error, sourceAt: null });
    }
    base.status = Object.values(base.dataQuality).some(q => q.status === 'unavailable') ? 'partial'
      : Object.values(base.dataQuality).some(q => q.status === 'stale') ? 'stale' : 'complete';
    return base;
  }

  async _readSource(owner, reader) {
    try {
      if (!reader) throw new Error('missing');
      const value = await reader();
      if (!value) throw new Error('empty');
      return { owner, value, error: null };
    } catch (_) { return { owner, value: null, error: 'SOURCE_UNAVAILABLE' }; }
  }

  _mapCoordinate(value, limit) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
  }

  _positioningLayer({ positioning, staffing, teamNames, shift }) {
    if (staffing.error) return { status: 'unavailable', reasonCode: 'TEAM_SCOPE_SOURCE_UNAVAILABLE', sourceAt: null, items: [] };
    if (positioning.error) return { status: 'unavailable', reasonCode: positioning.error, sourceAt: null, items: [] };
    const now = new Date(this.now()).getTime();
    const items = (Array.isArray(positioning.value) ? positioning.value : []).filter(plan => {
      if (!plan || plan.status !== 'active' || String(plan.shiftId) !== String(shift.id) || plan.departureTime) return false;
      const units = [...(Array.isArray(plan.units) ? plan.units : []), plan.unit].map(unit => String(unit || '').trim());
      return units.some(unit => teamNames.has(unit));
    }).map(plan => {
      const units = [...new Set([...(Array.isArray(plan.units) ? plan.units : []), plan.unit]
        .map(unit => String(unit || '').trim()).filter(unit => teamNames.has(unit)))];
      const lat = this._mapCoordinate(plan.lat, 90);
      const lng = this._mapCoordinate(plan.lng, 180);
      const startAt = plan.startTime ? new Date(plan.startTime).getTime() : NaN;
      const temporalStatus = plan.arrivalTime ? 'arrived' : Number.isFinite(startAt) && startAt > now ? 'planned' : 'en_route';
      return {
        id: String(plan.id), title: plan.title || null, location: plan.location || null,
        planType: plan.planType || null, priority: plan.priority || null, status: plan.status,
        temporalStatus, startTime: plan.startTime || null, endTime: plan.endTime || null,
        arrivalTime: plan.arrivalTime || null, createdAt: plan.createdAt || null,
        lat, lng, coordinateStatus: lat !== null && lng !== null ? 'ok' : 'unavailable',
        reasonCode: lat !== null && lng !== null ? null : 'POSITIONING_COORDINATES_UNAVAILABLE',
        teams: units, teamIdentities: units.map(unit => TeamCode.identityFields(unit, shift.shift_type))
      };
    });
    return {
      status: 'ok', reasonCode: null,
      sourceAt: latest(items.flatMap(item => [item.createdAt, item.arrivalTime, item.startTime])), items
    };
  }

  async getSectorMap({ actor, sectorId, view = 'current', shiftId = null }) {
    if (view !== 'current') throw new RegionCommandError('UNSUPPORTED_VIEW', 'الوضع الزمني المطلوب غير مدعوم', 400);
    const sector = await this.scopeService.assertCanReadSector(actor, sectorId);
    const centers = await this.scopeService.resolveSectorCenters(actor, sector.id);
    const shiftResult = await this._shift(sector, centers, shiftId);
    const shift = shiftResult.shift;
    let geo = null;
    let geoError = null;
    try {
      geo = this.centersGeoService && this.centersGeoService.getData();
      if (!geo) geoError = 'CENTER_GEO_SOURCE_UNAVAILABLE';
    } catch (_) { geoError = 'CENTER_GEO_SOURCE_UNAVAILABLE'; }
    const mappedCenters = centers.map(center => {
      const source = geo && geo.centers && geo.centers[center.name];
      const pair = source && source.center;
      const valid = Array.isArray(pair) && pair.length === 2 &&
        typeof pair[0] === 'number' && Number.isFinite(pair[0]) && Math.abs(pair[0]) <= 90 &&
        typeof pair[1] === 'number' && Number.isFinite(pair[1]) && Math.abs(pair[1]) <= 180;
      const nonGeographic = !!(geo && geo.nonGeographic && Object.hasOwn(geo.nonGeographic, center.name));
      return {
        id: String(center.id), name: center.name,
        lat: valid ? pair[0] : null, lng: valid ? pair[1] : null,
        coordinateStatus: valid ? 'ok' : nonGeographic ? 'not_applicable' : 'unavailable',
        reasonCode: valid ? null : nonGeographic ? 'NON_GEOGRAPHIC_CENTER' : geoError || 'CENTER_COORDINATES_UNAVAILABLE'
      };
    });
    const base = {
      success: true, generatedAt: new Date(this.now()).toISOString(), view,
      sector: { id: sector.id, regionId: sector.region_id, code: sector.code, name: sector.name, boundary: this._sectorBoundary(sector) },
      shift: shift ? { id: String(shift.id), name: shift.shift_name || shift.name || null, type: shift.shift_type || null, date: shift.shift_date || null } : null,
      centers: mappedCenters,
      incidents: { status: 'unavailable', reasonCode: 'NO_ACTIVE_SHIFT', sourceAt: null, items: [] },
      positionings: { status: 'unavailable', reasonCode: 'NO_ACTIVE_SHIFT', sourceAt: null, items: [] },
      sourceMeta: [{ ownerService: 'CentersGeoService', status: geoError ? 'unavailable' : 'ok', reasonCode: geoError }]
    };
    if (!shift) {
      base.incidents.reasonCode = shiftResult.error || 'NO_ACTIVE_SHIFT';
      base.positionings.reasonCode = shiftResult.error || 'NO_ACTIVE_SHIFT';
      base.sourceMeta.push({ ownerService: 'PositioningService', status: 'unavailable', reasonCode: base.positionings.reasonCode });
      return base;
    }
    const [staffing, incidents, positioning] = await Promise.all([
      this._readSource('StaffingEventsService', () => this.staffingService && this.staffingService.deriveTeamReadiness(shift.id)),
      this._readSource('ReportService', () => this.reportService && this.reportService.getIncidentSummary(shift.id)),
      this._readSource('PositioningService', () => this.positioningService && this.positioningService.list())
    ]);
    base.sourceMeta.push(
      { ownerService: 'StaffingEventsService', status: staffing.error ? 'unavailable' : staffing.value.stale ? 'stale' : 'ok', reasonCode: staffing.error || null },
      { ownerService: 'ReportService', status: incidents.error ? 'unavailable' : incidents.value.stale ? 'stale' : 'ok', reasonCode: incidents.error || null }
    );
    const centerNames = new Set(centers.map(center => center.name));
    const teamNames = new Set(staffing.error ? [] : Object.entries(staffing.value.teams || {})
      .filter(([, team]) => team.center && centerNames.has(team.center)).map(([name]) => name));
    base.positionings = this._positioningLayer({ positioning, staffing, teamNames, shift });
    base.sourceMeta.push({
      ownerService: 'PositioningService', status: base.positionings.status,
      reasonCode: base.positionings.reasonCode, sourceAt: base.positionings.sourceAt
    });
    if (staffing.error || incidents.error) {
      base.incidents.reasonCode = staffing.error ? 'TEAM_SCOPE_SOURCE_UNAVAILABLE' : incidents.error;
      return base;
    }
    const relevant = (incidents.value.incidents || []).filter(incident =>
      (incident.crews || []).some(crew => crew.counted && teamNames.has(crew.unit)));
    const sourceAt = latest(relevant.map(incident => incident.createdAt || incident.cadCreatedAt));
    base.incidents = {
      status: staffing.value.stale || incidents.value.stale ? 'stale' : 'ok', reasonCode: null, sourceAt,
      items: relevant.map(incident => {
        const lat = typeof incident.lat === 'number' && Number.isFinite(incident.lat) && Math.abs(incident.lat) <= 90 ? incident.lat : null;
        const lng = typeof incident.lng === 'number' && Number.isFinite(incident.lng) && Math.abs(incident.lng) <= 180 ? incident.lng : null;
        return {
          id: String(incident.number), code: incident.code || null, type: incident.type || null, status: incident.status || 'active',
          severity: incident.severity || null, createdAt: incident.createdAt || incident.cadCreatedAt || null,
          district: incident.district || null, street: incident.street || null, lat, lng,
          coordinateStatus: lat !== null && lng !== null ? 'ok' : 'unavailable',
          ...incidentTeamViews(incident, teamNames, shift.shift_type)
        };
      })
    };
    return base;
  }

  async getSectorDetail({ actor, sectorId, view = 'current', shiftId = null, includeDecisionCount = true }) {
    const sector = await this.scopeService.assertCanReadSector(actor, sectorId);
    const snapshot = await this._snapshot({ actor, sector, view, shiftId });
    if (includeDecisionCount && this.decisionCenter) {
      const derived = this.decisionCenter.deriveForSector(snapshot);
      snapshot.decisionCount = derived.count;
      snapshot.decisions = derived.items;
    } else snapshot.decisionCount = unavailable('DECISION_SOURCE_NOT_REQUESTED');
    return { success: true, generatedAt: snapshot.generatedAt, view, sector: snapshot, sourceMeta: snapshot.sourceMeta };
  }

  _trendRange() {
    const now = new Date(this.now());
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = type => parts.find(item => item.type === type).value;
    const todayStart = Date.UTC(Number(part('year')), Number(part('month')) - 1, Number(part('day'))) - 3 * 3600000;
    const from = todayStart - 6 * 86400000;
    const dates = Array.from({ length: 7 }, (_, index) => new Date(from + index * 86400000 + 3 * 3600000).toISOString().slice(0, 10));
    return { from: new Date(from).toISOString(), to: now.toISOString(), bucket: 'day', dates };
  }

  _trendSeries(incidents, range, { stale = false, unresolvedTimeCount = 0 } = {}) {
    const incidentsByDay = new Map(range.dates.map(date => [date, []]));
    for (const incident of incidents) {
      const day = riyadhDateKey(incident.occurredAt);
      if (incidentsByDay.has(day)) incidentsByDay.get(day).push(incident);
    }
    const points = range.dates.map(date => {
      const daily = incidentsByDay.get(date);
      const sourceAt = latest(daily.map(incident => incident.occurredAt));
      return {
        date,
        incidentsTotal: count(daily.length, sourceAt, daily.length, daily.length, { stale }),
        avgResponseMinutes: timeAverage(daily, 'bestArrivalMin', sourceAt, stale),
        avgMubasharaMinutes: timeAverage(daily, 'bestMubasharaMin', sourceAt, stale)
      };
    });
    return {
      status: unresolvedTimeCount > 0 ? 'partial' : stale ? 'stale' : 'ok',
      reasonCode: unresolvedTimeCount > 0 ? 'HISTORY_TIME_COVERAGE_INCOMPLETE' : null,
      sourceAt: latest(incidents.map(incident => incident.occurredAt)),
      range: { from: range.from, to: range.to, bucket: range.bucket }, points,
      unresolvedTimeCount: count(unresolvedTimeCount, null, unresolvedTimeCount, unresolvedTimeCount)
    };
  }

  async _attachTrends(sectors, totals, actor) {
    const range = this._trendRange();
    const unavailableTrend = reason => ({
      status: 'unavailable', reasonCode: reason, sourceAt: null,
      range: { from: range.from, to: range.to, bucket: range.bucket }, points: [],
      unresolvedTimeCount: unavailable(reason)
    });
    const historical = await this._readSource('ReportService', () => this.reportService && this.reportService.getHistoricalSummary
      && this.reportService.getHistoricalSummary(Date.parse(range.from), Date.parse(range.to)));
    if (historical.error) {
      for (const sector of sectors) sector.trends = unavailableTrend(historical.error);
      totals.trends = unavailableTrend(historical.error);
      return;
    }
    const incidents = historical.value.incidents || [];
    const unresolvedTimeCount = historical.value.unresolvedTimeCount || 0;
    const regional = new Map();
    let availableSectors = 0;
    for (const sector of sectors) {
      let teamNames = [];
      try {
        teamNames = this.scopeService.resolveSectorTeamNames
          ? await this.scopeService.resolveSectorTeamNames(actor, sector.id, this.now())
          : sector.teams.map(team => team.name);
      } catch (_) { teamNames = sector.teams.map(team => team.name); }
      const names = new Set(teamNames);
      if (!names.size) {
        sector.trends = unavailableTrend('TEAM_SCOPE_SOURCE_UNAVAILABLE');
        continue;
      }
      const relevant = incidents.filter(incident => (incident.crews || []).some(crew => crew.counted && names.has(crew.unit)));
      sector.trends = this._trendSeries(relevant, range, { stale: historical.value.stale === true, unresolvedTimeCount });
      availableSectors++;
      for (const incident of relevant) regional.set(String(incident.shiftId) + '|' + String(incident.number), incident);
    }
    totals.trends = this._trendSeries([...regional.values()], range, { stale: historical.value.stale === true, unresolvedTimeCount });
    totals.trends.coverage = quality(sectors.length, availableSectors, availableSectors === sectors.length ? COMPLETE : 'partial');
    if (availableSectors !== sectors.length) {
      totals.trends.status = 'partial';
      totals.trends.reasonCode = 'REGION_COVERAGE_INCOMPLETE';
    }
  }

  async getOverview({ actor, regionId, view = 'current' }) {
    const resolved = await this.scopeService.resolveRegionSectors(actor, regionId);
    const sectors = [];
    for (const sector of resolved.sectors) {
      const snapshot = await this._snapshot({ actor, sector, view });
      if (this.decisionCenter) {
        const derived = this.decisionCenter.deriveForSector(snapshot);
        snapshot.decisionCount = derived.count;
        snapshot.decisions = derived.items;
      } else snapshot.decisionCount = unavailable('DECISION_SOURCE_UNAVAILABLE');
      sectors.push(snapshot);
    }
    const totals = { status: 'partial', metrics: this._totals(sectors) };
    totals.metrics.sectorCount = count(sectors.length, null, resolved.sectors.length, sectors.length);
    const allCenters = new Set(sectors.flatMap(s => s.centers.map(c => c.id)));
    totals.metrics.centerCount = count(allCenters.size, null, resolved.sectors.length, sectors.length);
    totals.status = Object.values(totals.metrics).every(m => m.status === 'ok' || m.status === 'not_applicable') ? 'complete' : 'partial';
    await this._attachTrends(sectors, totals, actor);
    return { success: true, generatedAt: new Date(this.now()).toISOString(), view, scope: { regionId: resolved.regionId }, sectors, totals, sourceMeta: sectors.flatMap(s => s.sourceMeta.map(m => ({ ...m, sectorId: s.id }))) };
  }

  _totals(sectors) {
    const keys = ['teamsTotal', 'teamsReady', 'teamsBusy', 'teamsMissing', 'teamsOffline', 'teamsPending', 'staffActive', 'staffRequired', 'vehiclesTotal', 'vehiclesActive', 'incidentsTotal', 'incidentsActive', 'decisionCount'];
    const out = {};
    for (const key of keys) {
      const values = sectors.map(s => s.metrics[key] || s.decisionCount).filter(Boolean);
      if (values.length !== sectors.length || values.some(v => v.value === null || !['ok', 'stale'].includes(v.status) || v.coverage.status !== COMPLETE)) {
        out[key] = metric(null, { status: 'partial', reasonCode: 'REGION_COVERAGE_INCOMPLETE', coverage: quality(sectors.length, values.filter(v => v.value !== null && v.coverage.status === COMPLETE).length, 'partial') });
      } else out[key] = count(values.reduce((sum, m) => sum + m.value, 0), latest(values.map(v => v.sourceAt)), sectors.length, sectors.length, { stale: values.some(v => v.status === 'stale') });
    }
    for (const key of ['avgResponseMinutes', 'avgMubasharaMinutes']) {
      const values = sectors.map(s => s.metrics[key]).filter(Boolean);
      const expected = values.reduce((sum, m) => sum + (m.coverage.expected || 0), 0);
      const available = values.reduce((sum, m) => sum + (m.coverage.available || 0), 0);
      const covered = values.filter(m => m.value !== null);
      if (expected === 0 && values.every(m => m.status === 'not_applicable')) {
        out[key] = metric(null, { status: 'not_applicable', reasonCode: 'NO_INCIDENTS', coverage: quality(0, 0, COMPLETE) });
      } else if (!available || covered.length !== values.length) {
        out[key] = metric(null, { status: 'partial', reasonCode: 'REGION_COVERAGE_INCOMPLETE', coverage: quality(expected, available, 'partial') });
      } else {
        const weighted = covered.reduce((sum, m) => sum + m.value * m.coverage.available, 0) / available;
        out[key] = metric(Math.round(weighted * 10) / 10, {
          status: available === expected && values.every(m => m.status !== 'partial') ? (values.some(m => m.status === 'stale') ? 'stale' : 'ok') : 'partial',
          reasonCode: available === expected ? null : 'RESPONSE_TIME_COVERAGE_INCOMPLETE',
          sourceAt: latest(values.map(m => m.sourceAt)), coverage: quality(expected, available, available === expected ? COMPLETE : 'partial'),
          allowPartialValue: true
        });
      }
    }
    const ready = out.teamsReady;
    const total = out.teamsTotal;
    out.readinessRate = ready.value === null || total.value === null
      ? metric(null, { status: 'partial', reasonCode: 'REGION_COVERAGE_INCOMPLETE', coverage: quality(sectors.length, 0, 'partial') })
      : total.value === 0 ? metric(null, { status: 'not_applicable', reasonCode: 'NO_REQUIRED_TEAMS', coverage: quality(0, 0, COMPLETE) })
        : count(Math.round(ready.value / total.value * 100), latest([ready.sourceAt, total.sourceAt]), total.value, total.value);
    return out;
  }

  async getMetricEvidence({ actor, sectorId, metricKey, metricVersion, view = 'current', shiftId = null }) {
    const definition = getMetric(metricKey, metricVersion);
    if (!definition || !definition.supportedView.includes(view)) throw new RegionCommandError('METRIC_NOT_SUPPORTED', 'المؤشر أو إصداره غير معتمد', 400);
    if (metricKey === 'decisionCount') throw new RegionCommandError('METRIC_NOT_SUPPORTED', 'دليل هذا المؤشر متاح عبر مركز القرار', 400);
    const detail = await this.getSectorDetail({ actor, sectorId, view, shiftId, includeDecisionCount: false });
    const value = detail.sector.metrics[metricKey] || unavailable('METRIC_NOT_APPLICABLE');
    return {
      success: true, metric: definition, value,
      numerator: metricKey === 'readinessRate' ? detail.sector.metrics.teamsReady : null,
      denominator: metricKey === 'readinessRate' ? detail.sector.metrics.teamsTotal : null,
      sectorId: detail.sector.id, shiftId: detail.sector.shiftId,
      sourceMeta: detail.sector.sourceMeta.filter(s => s.ownerService === definition.ownerService),
      warnings: value.reasonCode ? [value.reasonCode] : []
    };
  }
}

module.exports = RegionCommandReadService;
module.exports.RegionCommandReadService = RegionCommandReadService;
module.exports.metric = metric;
module.exports.quality = quality;
