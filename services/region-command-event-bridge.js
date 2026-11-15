'use strict';

const crypto = require('crypto');

class RegionCommandEventBridge {
  constructor({ db, scopeService, permissionService, getClients, refreshActor = null, isEnabled = () => process.env.REGION_COMMAND_ENABLED === 'true', now = () => new Date(), idFactory = () => crypto.randomUUID(), logger = console }) {
    this.db = db;
    this.scopeService = scopeService;
    this.permissionService = permissionService;
    this.getClients = getClients;
    this.refreshActor = refreshActor || this._refreshActor.bind(this);
    this.isEnabled = isEnabled;
    this.now = now;
    this.idFactory = idFactory;
    this.logger = logger;
  }

  async _refreshActor(client) {
    const id = client.user && client.user.id;
    let user = null;
    if (this.db.Users) {
      if (typeof this.db.Users.getByUserId === 'function') user = await this.db.Users.getByUserId(id);
      if (!user && typeof this.db.Users.getById === 'function') user = await this.db.Users.getById(id);
    }
    if (!user) user = await this.db.get('SELECT * FROM users WHERE user_id = ? LIMIT 1', [String(id)]);
    if (!user || !user.is_active) return null;
    return { id: String(user.user_id || user.id), name: user.name || user.username || null, role: user.role };
  }

  async _sectorsFromCenter(value, at) {
    if (!value || value === 'CAD') return [];
    return this.db.all(
      `SELECT s.id, s.region_id FROM sector_centers sc
       JOIN centers c ON CAST(c.id AS TEXT) = sc.center_id
       JOIN sectors s ON s.id = sc.sector_id AND s.status = 'active'
       WHERE (sc.center_id = ? OR c.name = ?) AND sc.effective_from <= ?
         AND (sc.effective_to IS NULL OR sc.effective_to > ?)`, [String(value), String(value), at, at]
    );
  }

  async _sectorsFromTeam(value, at) {
    if (!value) return [];
    const team = await this.db.get('SELECT center FROM teams WHERE CAST(id AS TEXT) = ? OR name = ? LIMIT 1', [String(value), String(value)]);
    return team && team.center ? this._sectorsFromCenter(team.center, at) : [];
  }

  async resolveSectors({ domain, entity }) {
    const at = new Date(this.now()).toISOString();
    if (entity.sectorId) {
      const rows = await this.db.all('SELECT id, region_id FROM sectors WHERE id = ? AND status = \'active\'', [String(entity.sectorId)]);
      if (rows.length) return rows;
    }
    // المناوبة نطاقها تشغيلي عام في EMS؛ لا تُنسب إلى مركز أو فريق واحد.
    // يبقى إرسالها مقيدًا بالصلاحية والنطاق الفعالين لكل عميل على حدة.
    if (domain === 'shifts') {
      return this.db.all(`SELECT s.id, s.region_id FROM sectors s
        JOIN regions r ON r.id = s.region_id AND r.status = 'active'
        WHERE s.status = 'active' ORDER BY s.id`);
    }
    let rows = await this._sectorsFromCenter(entity.center || entity.centerId, at);
    if (!rows.length) rows = await this._sectorsFromTeam(entity.team || entity.unit || entity.teamId || entity.team_id, at);
    const shiftId = entity.shiftId || entity.shift_id;
    if (!rows.length && shiftId && ['staffing', 'vehicles'].includes(domain)) {
      const eventDomain = domain === 'vehicles' ? 'vehicle' : 'staffing';
      const events = await this.db.all(
        `SELECT DISTINCT center FROM operational_events
         WHERE shift_id = ? AND domain = ? AND center IS NOT NULL AND center <> ''
         ORDER BY id DESC LIMIT 20`, [shiftId, eventDomain]
      );
      // قرارات ready/missing/offline تعيش في shift_team_status ولا تُلحق
      // operational_events؛ لذلك يجب حل مراكزها من teams.center أيضًا.
      if (domain === 'staffing') {
        try {
          const decisions = await this.db.all(
            `SELECT DISTINCT t.center FROM shift_team_status sts
             JOIN teams t ON t.name = sts.team_id
             WHERE sts.shift_id = ? AND t.center IS NOT NULL AND t.center <> ''`, [shiftId]
          );
          events.push(...decisions);
        } catch (_) { /* قاعدة قديمة بلا جدول القرارات: تبقى أحداث staffing مصدرًا */ }
      }
      if (domain === 'vehicles') {
        // vehicles_updated لا يحمل vehicleId؛ التعيين قد يكون عامًا بلا shift_id
        // بينما حالة المناوبة بلا center. أضف مراكز التعيينات المفتوحة فقط.
        const assignments = await this.db.all(
          `SELECT id, entity_id, event_type, center FROM operational_events
           WHERE domain = 'vehicle' AND event_type IN ('assignment', 'assignment_end')
             AND center IS NOT NULL AND center <> ''
           ORDER BY created_at ASC, id ASC`
        );
        const openByVehicle = new Map();
        for (const assignment of assignments) {
          if (assignment.event_type === 'assignment') openByVehicle.set(assignment.entity_id, assignment);
          else openByVehicle.delete(assignment.entity_id);
        }
        events.push(...openByVehicle.values());
      }
      const resolved = await Promise.all(events.map(e => this._sectorsFromCenter(e.center, at)));
      rows = resolved.flat();
    }
    const unique = new Map(rows.map(row => [row.id, row]));
    return [...unique.values()];
  }

  async afterOperationalCommit({ domain, entity = {}, occurredAt = null, sourceVersion = null }) {
    if (!this.isEnabled()) return { sent: 0, unresolved: 0 };
    try {
      const sectors = await this.resolveSectors({ domain, entity });
      if (!sectors.length) return { sent: 0, unresolved: 1 };
      let sent = 0;
      for (const sector of sectors) {
        const payload = {
          eventId: this.idFactory(), type: 'region_command_changed',
          regionId: sector.region_id, sectorId: sector.id,
          entityType: domain, entityId: entity.vehicleId || entity.vehicle_id || null,
          occurredAt: occurredAt || new Date(this.now()).toISOString(),
          changeVersion: sourceVersion === null || sourceVersion === undefined ? null : String(sourceVersion)
        };
        sent += await this._sendAuthorized(sector.id, payload, domain === 'ledger');
      }
      return { sent, unresolved: 0 };
    } catch (error) {
      this.logger.error('[RegionCommand SSE] event skipped:', error.message);
      return { sent: 0, unresolved: 0, error: 'BROADCAST_SKIPPED' };
    }
  }

  async afterScopeChange({ sectorId, occurredAt = null }) {
    return this.afterOperationalCommit({ domain: 'scope', entity: { sectorId }, occurredAt });
  }

  async _clientValid(client, sectorId, ledgerEvent) {
    if (!client || !client.res || !client.user || client.res.writableEnded) return { ok: false, close: true };
    if (client.tokenExpiresAt && new Date(this.now()).getTime() >= client.tokenExpiresAt) return { ok: false, close: true };
    if (client.tokenHash && this.db.TokenBlacklist && await this.db.TokenBlacklist.isBlacklisted(client.tokenHash)) return { ok: false, close: true };
    const actor = await this.refreshActor(client);
    if (!actor) return { ok: false, close: true };
    const command = await this.permissionService.hasPermission(String(actor.id), actor.role, 'region.command.view');
    if (!command) return { ok: false, close: false };
    if (ledgerEvent) {
      const audit = await this.permissionService.hasPermission(String(actor.id), actor.role, 'region.audit.view');
      if (!audit) return { ok: false, close: false };
    }
    const scoped = await this.scopeService.canViewSector(actor, sectorId, this.permissionService);
    return { ok: scoped, close: false };
  }

  async _sendAuthorized(sectorId, payload, ledgerEvent = false) {
    let sent = 0;
    const clients = [...(this.getClients() || [])];
    for (const client of clients) {
      try {
        const valid = await this._clientValid(client, sectorId, ledgerEvent);
        if (valid.close) {
          try { client.res.end(); } catch (_) { /* already closed */ }
          continue;
        }
        if (!valid.ok) continue;
        client.res.write('data: ' + JSON.stringify(payload) + '\n\n');
        sent += 1;
      } catch (error) {
        this.logger.error('[RegionCommand SSE] client check failed closed:', error.message);
      }
    }
    return sent;
  }
}

module.exports = RegionCommandEventBridge;
module.exports.RegionCommandEventBridge = RegionCommandEventBridge;
