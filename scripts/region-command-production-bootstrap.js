'use strict';

const crypto = require('crypto');
const TeamCode = require('../public/js/operational-team-code.js');

const REGION_CODE = 'R';
const REGION_ID = 'REGION-RIYADH';
const REGION_NAME = 'منطقة الرياض';
const SECTOR_CODES = ['1', '2', '3', '4', '5'];

/**
 * تهيئة إنتاج مرة واحدة للحساب المعتمد. لا تحذف أو تغيّر أي ربط قائم.
 * المراكز تشتق حصرًا من teams.center بعد تحليل هوية الفرقة الرسمية.
 */
async function bootstrapRegionCommandProduction(db, { userId, now = () => new Date() } = {}) {
  if (!db || !db.tx || !db.tx.immediate) throw new Error('قاعدة SQLite المفتوحة مطلوبة');
  const normalizedUserId = String(userId || '').trim();
  if (!normalizedUserId) throw new Error('معرف حساب قائد المنطقة مطلوب');
  const at = now().toISOString();

  return db.tx.immediate((hdl) => {
    const user = hdl.prepare('SELECT user_id, role, is_active FROM users WHERE user_id = ?').get(normalizedUserId);
    if (!user || user.role !== 'admin' || user.is_active !== 1) {
      throw new Error('الحساب المعتمد غير موجود أو ليس مدير نظام نشطًا');
    }

    let region = hdl.prepare('SELECT id FROM regions WHERE code = ?').get(REGION_CODE);
    if (!region) {
      hdl.prepare('INSERT INTO regions(id, code, name, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(REGION_ID, REGION_CODE, REGION_NAME, 'active', at, 'region-bootstrap');
      region = { id: REGION_ID };
    }

    const sectorIds = new Map();
    for (const code of SECTOR_CODES) {
      const sectorId = `${region.id}-S${code}`;
      let sector = hdl.prepare('SELECT id FROM sectors WHERE region_id = ? AND code = ?').get(region.id, code);
      if (!sector) {
        hdl.prepare('INSERT INTO sectors(id, region_id, code, name, status, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(sectorId, region.id, code, TeamCode.sectors[code].sectorName, 'active', at, 'region-bootstrap');
        sector = { id: sectorId };
      }
      sectorIds.set(code, sector.id);
    }

    const teams = hdl.prepare('SELECT name, center FROM teams WHERE is_active = 1').all();
    const sectorCenters = new Map(SECTOR_CODES.map(code => [code, new Set()]));
    const unmappedTeams = [];
    for (const team of teams) {
      const identity = TeamCode.parseOperationalTeamCode(team.name) || TeamCode.identityFromTeamName(team.name, 'صباحية');
      if (!identity || !sectorIds.has(identity.sectorCode)) {
        unmappedTeams.push(team.name);
        continue;
      }
      const centerName = String(team.center || '').trim();
      if (!centerName || centerName === 'الفرق الإضافية') continue;
      sectorCenters.get(identity.sectorCode).add(centerName);
    }

    let linkedCenters = 0;
    for (const [code, centerNames] of sectorCenters) {
      for (const centerName of centerNames) {
        const center = hdl.prepare('SELECT id FROM centers WHERE name = ?').get(centerName);
        if (!center) throw new Error(`المركز المرتبط بالفرق غير موجود في centers: ${centerName}`);
        const current = hdl.prepare('SELECT sector_id FROM sector_centers WHERE center_id = ? AND effective_to IS NULL').get(String(center.id));
        if (current) {
          if (current.sector_id !== sectorIds.get(code)) {
            throw new Error(`المركز ${centerName} مرتبط حاليًا بقطاع آخر؛ لم يتم تجاوز الربط`);
          }
          continue;
        }
        hdl.prepare(`INSERT INTO sector_centers(
          id, sector_id, center_id, effective_from, effective_to, created_at, created_by
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)`).run(
          `SC-${crypto.randomUUID()}`, sectorIds.get(code), String(center.id), at, at, 'region-bootstrap'
        );
        linkedCenters += 1;
      }
    }

    let scope = hdl.prepare(`SELECT id, status FROM user_access_scopes
      WHERE user_id = ? AND scope_type = 'region' AND scope_id = ? AND effective_to IS NULL`)
      .get(normalizedUserId, region.id);
    if (scope && scope.status !== 'active') {
      hdl.prepare(`UPDATE user_access_scopes SET status = 'active', granted_by = ?, granted_at = ?, reason = ? WHERE id = ?`)
        .run('region-bootstrap', at, 'تفعيل قراءة منطقة الرياض للحساب المعتمد', scope.id);
    } else if (!scope) {
      hdl.prepare(`INSERT INTO user_access_scopes(
        id, user_id, scope_type, scope_id, status, effective_from, effective_to, granted_by, granted_at, reason
      ) VALUES (?, ?, 'region', ?, 'active', ?, NULL, ?, ?, ?)`).run(
        `SCOPE-${crypto.randomUUID()}`, normalizedUserId, region.id, at,
        'region-bootstrap', at, 'تفعيل قراءة منطقة الرياض للحساب المعتمد'
      );
    }

    return {
      userId: normalizedUserId,
      regionId: region.id,
      sectorIds: Object.fromEntries(sectorIds),
      linkedCenters,
      centerCounts: Object.fromEntries(SECTOR_CODES.map(code => [code, sectorCenters.get(code).size])),
      unmappedTeams
    };
  });
}

module.exports = { bootstrapRegionCommandProduction };
