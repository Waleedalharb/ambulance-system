'use strict';

const definitions = [
  ['sectorCount', 'عدد القطاعات', 'sector', 'RegionScopeService', 'scope.activeSectors'],
  ['centerCount', 'عدد المراكز', 'center', 'RegionScopeService', 'scope.effectiveCenters'],
  ['teamsTotal', 'إجمالي الفرق', 'team', 'StaffingEventsService', 'deriveTeamReadiness.teams'],
  ['teamsReady', 'الفرق الجاهزة', 'team', 'StaffingEventsService', 'deriveTeamReadiness.status=ready'],
  ['teamsMissing', 'الفرق الناقصة', 'team', 'StaffingEventsService', 'deriveTeamReadiness.status=missing'],
  ['teamsOffline', 'الفرق خارج الخدمة', 'team', 'StaffingEventsService', 'deriveTeamReadiness.status=offline'],
  ['teamsPending', 'فرق بانتظار التكميل', 'team', 'StaffingEventsService', 'deriveTeamReadiness.status=pending'],
  ['staffActive', 'الكادر الحاضر', 'person', 'StaffingEventsService', 'deriveTeamReadiness.activeCount'],
  ['staffRequired', 'الكادر المطلوب', 'person', 'StaffingEventsService', 'deriveTeamReadiness.requiredPersonnel'],
  ['readinessRate', 'جاهزية الفرق التشغيلية', 'percent', 'StaffingEventsService', 'readyTeams/requiredTeams*100'],
  ['vehiclesTotal', 'إجمالي المركبات', 'vehicle', 'VehicleEventsService', 'getState.entities'],
  ['vehiclesActive', 'المركبات العاملة', 'vehicle', 'VehicleEventsService', 'foldEvents.status=active'],
  ['incidentsTotal', 'إجمالي البلاغات', 'incident', 'ReportService', 'getIncidentSummary.incidents'],
  ['incidentsActive', 'البلاغات النشطة', 'incident', 'ReportService', 'getIncidentSummary.status=active'],
  ['avgResponseMinutes', 'متوسط زمن الوصول', 'minute', 'ReportService', 'mean(incident.bestArrivalMin)'],
  ['avgMubasharaMinutes', 'متوسط زمن المباشرة', 'minute', 'ReportService', 'mean(incident.bestMubasharaMin)'],
  ['decisionCount', 'عناصر تحتاج مراجعة', 'item', 'RegionDecisionCenterService', 'deriveNeedsReview']
];

const METRICS = Object.fromEntries(definitions.map(([key, label, unit, ownerService, formulaRef]) => [key, {
  key, version: '1.0.0', label, unit, ownerService, formulaRef,
  supportedView: ['current'], coverageRuleRef: 'region-command-quality-v1',
  officialStatus: 'approved'
}]));

function getMetric(key, version) {
  const metric = METRICS[key];
  if (!metric || (version && version !== metric.version)) return null;
  return metric;
}

module.exports = { METRICS, getMetric };
