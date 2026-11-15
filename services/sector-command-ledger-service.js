'use strict';

const crypto = require('crypto');
const { RegionCommandError } = require('./region-command-errors');
const GENESIS = '0'.repeat(64);
const EVENT_TYPES = new Set(['viewed', 'hierarchy_changed', 'scope_changed']);
const DETAIL_KEYS = new Set(['note', 'reason', 'source', 'versionLabel', 'reference', 'correlationId']);

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new RegionCommandError('INVALID_DETAILS', 'تفاصيل الحدث غير صالحة');
    return value;
  }
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key.normalize('NFC')] = canonicalize(value[key]);
    }
    return out;
  }
  throw new RegionCommandError('INVALID_DETAILS', 'تفاصيل الحدث غير صالحة');
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function hashEvent(entry) { return crypto.createHash('sha256').update(canonicalJson(entry), 'utf8').digest('hex'); }
function publicEntry(row) {
  return {
    id: row.id, sectorId: row.sector_id, sectorSeq: row.sector_seq,
    transactionId: row.transaction_id, eventType: row.event_type,
    actorUserId: row.actor_user_id, actorRoleAtEvent: row.actor_role_at_event,
    entityType: row.entity_type, entityId: row.entity_id, versionId: row.version_id,
    contentHash: row.content_hash, occurredAt: row.occurred_at,
    details: JSON.parse(row.details_json || '{}'), hashVersion: row.hash_version,
    previousHash: row.previous_hash, eventHash: row.event_hash
  };
}
function hashInput(row) {
  return {
    hashVersion: row.hash_version, id: row.id, sectorId: row.sector_id, sectorSeq: row.sector_seq,
    transactionId: row.transaction_id, eventType: row.event_type, actorUserId: row.actor_user_id,
    actorRoleAtEvent: row.actor_role_at_event, entityType: row.entity_type, entityId: row.entity_id,
    versionId: row.version_id, contentHash: row.content_hash, occurredAt: row.occurred_at,
    details: JSON.parse(row.details_json || '{}'), previousHash: row.previous_hash
  };
}

class SectorCommandLedgerService {
  constructor({ db, scopeService, now = () => new Date(), idFactory = () => crypto.randomUUID() }) {
    if (!db || !scopeService) throw new Error('SectorCommandLedgerService: db وscopeService مطلوبان');
    this.db = db;
    this.scopeService = scopeService;
    this.now = now;
    this.idFactory = idFactory;
  }

  async append({ actor, sectorId, eventType, entity = {}, version = null, details = {}, transactionId = null }) {
    await this.scopeService.assertCanReadSector(actor, sectorId);
    if (!EVENT_TYPES.has(eventType)) throw new RegionCommandError('EVENT_TYPE_NOT_ALLOWED', 'نوع الحدث غير متاح في هذه المرحلة', 403);
    const cleanDetails = {};
    for (const [key, value] of Object.entries(details || {})) {
      if (!DETAIL_KEYS.has(key)) continue;
      if (['string', 'number', 'boolean'].includes(typeof value) || value === null) cleanDetails[key] = value;
    }
    const contentHash = entity.contentHash || (version && version.contentHash) || null;
    if (contentHash !== null && !/^[a-f0-9]{64}$/i.test(contentHash)) throw new RegionCommandError('INVALID_CONTENT_HASH', 'بصمة النسخة غير صالحة');
    const versionId = entity.versionId || (version && (version.id || version.versionId)) || null;
    const occurredAt = new Date(this.now()).toISOString();
    const id = this.idFactory();
    const result = this.db.tx.immediate((hdl) => {
      const counter = hdl.prepare('SELECT next_seq FROM sector_command_counters WHERE sector_id = ?').get(sectorId);
      const head = hdl.prepare('SELECT sector_seq, event_hash FROM sector_command_ledger WHERE sector_id = ? ORDER BY sector_seq DESC LIMIT 1').get(sectorId);
      const sectorSeq = counter ? counter.next_seq : 1;
      if ((head && sectorSeq !== head.sector_seq + 1) || (!head && sectorSeq !== 1)) throw new RegionCommandError('COUNTER_SEQUENCE_MISMATCH', 'تسلسل السجل القيادي غير متسق', 409);
      if (counter) hdl.prepare('UPDATE sector_command_counters SET next_seq = ? WHERE sector_id = ?').run(sectorSeq + 1, sectorId);
      else hdl.prepare('INSERT INTO sector_command_counters(sector_id, next_seq) VALUES (?, ?)').run(sectorId, sectorSeq + 1);
      const previousHash = head ? head.event_hash : GENESIS;
      const row = {
        hash_version: 1, id, sector_id: sectorId, sector_seq: sectorSeq, transaction_id: transactionId || null,
        event_type: eventType, actor_user_id: String(actor.id), actor_role_at_event: actor.role || null,
        entity_type: entity.type || null, entity_id: entity.id === undefined ? null : String(entity.id),
        version_id: versionId, content_hash: contentHash, occurred_at: occurredAt,
        details_json: canonicalJson(cleanDetails), previous_hash: previousHash
      };
      const eventHash = hashEvent(hashInput(row));
      hdl.prepare(`INSERT INTO sector_command_ledger(
        id, sector_id, sector_seq, transaction_id, event_type, actor_user_id, actor_role_at_event,
        entity_type, entity_id, version_id, content_hash, occurred_at, details_json,
        hash_version, previous_hash, event_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, row.sector_id, row.sector_seq, row.transaction_id, row.event_type, row.actor_user_id,
        row.actor_role_at_event, row.entity_type, row.entity_id, row.version_id, row.content_hash,
        row.occurred_at, row.details_json, row.hash_version, row.previous_hash, eventHash
      );
      return hdl.prepare('SELECT * FROM sector_command_ledger WHERE id = ?').get(id);
    });
    return publicEntry(result);
  }

  async list({ actor, sectorId, filters = {}, cursor = null, limit = 50 }) {
    await this.scopeService.assertCanReadSector(actor, sectorId);
    const size = Math.max(1, Math.min(Number(limit) || 50, 100));
    const clauses = ['sector_id = ?'];
    const params = [sectorId];
    if (filters.eventType) { clauses.push('event_type = ?'); params.push(filters.eventType); }
    if (filters.actorId) { clauses.push('actor_user_id = ?'); params.push(String(filters.actorId)); }
    if (filters.from) { clauses.push('occurred_at >= ?'); params.push(new Date(filters.from).toISOString()); }
    if (filters.to) { clauses.push('occurred_at < ?'); params.push(new Date(filters.to).toISOString()); }
    if (cursor !== null && cursor !== undefined && cursor !== '') {
      const parsed = Number(cursor);
      if (!Number.isInteger(parsed) || parsed < 1) throw new RegionCommandError('INVALID_CURSOR', 'مؤشر الصفحة غير صالح');
      clauses.push('sector_seq < ?'); params.push(parsed);
    }
    const rows = await this.db.all(`SELECT * FROM sector_command_ledger WHERE ${clauses.join(' AND ')} ORDER BY sector_seq DESC LIMIT ?`, [...params, size + 1]);
    const entries = rows.slice(0, size).map(publicEntry);
    return { entries, nextCursor: rows.length > size ? String(entries[entries.length - 1].sectorSeq) : null };
  }

  async getEntry({ actor, sectorId, entryId }) {
    await this.scopeService.assertCanReadSector(actor, sectorId);
    const row = await this.db.get('SELECT * FROM sector_command_ledger WHERE id = ? AND sector_id = ?', [entryId, sectorId]);
    if (!row) throw new RegionCommandError('LEDGER_ENTRY_NOT_FOUND', 'السجل المطلوب غير موجود', 404);
    return publicEntry(row);
  }

  async verifySectorChain({ sectorId }) {
    const [rows, counter] = await Promise.all([
      this.db.all('SELECT * FROM sector_command_ledger WHERE sector_id = ? ORDER BY sector_seq ASC', [sectorId]),
      this.db.get('SELECT next_seq FROM sector_command_counters WHERE sector_id = ?', [sectorId])
    ]);
    const fail = (code, sectorSeq = null) => ({ valid: false, code, sectorId, sectorSeq, checked: rows.length });
    if (!rows.length) {
      if (!counter) return { valid: true, code: 'EMPTY', sectorId, checked: 0, headHash: null };
      return counter.next_seq === 1 ? { valid: true, code: 'EMPTY', sectorId, checked: 0, headHash: null } : fail('COUNTER_SEQUENCE_MISMATCH');
    }
    if (!counter) return fail('COUNTER_SEQUENCE_MISMATCH');
    let previousHash = GENESIS;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.sector_seq !== index + 1) return fail('SEQUENCE_GAP', row.sector_seq);
      if (row.previous_hash !== previousHash) return fail('PREVIOUS_HASH_MISMATCH', row.sector_seq);
      if (row.hash_version !== 1 || hashEvent(hashInput(row)) !== row.event_hash) return fail('EVENT_HASH_MISMATCH', row.sector_seq);
      previousHash = row.event_hash;
    }
    const expected = rows[rows.length - 1].sector_seq + 1;
    if (counter.next_seq > expected) return fail('TRUNCATED_TAIL', rows[rows.length - 1].sector_seq);
    if (counter.next_seq !== expected) return fail('COUNTER_SEQUENCE_MISMATCH', rows[rows.length - 1].sector_seq);
    return { valid: true, code: 'OK', sectorId, checked: rows.length, headHash: previousHash, nextSeq: counter.next_seq };
  }
}

module.exports = SectorCommandLedgerService;
module.exports.SectorCommandLedgerService = SectorCommandLedgerService;
module.exports.canonicalJson = canonicalJson;
module.exports.hashEvent = hashEvent;
module.exports.GENESIS = GENESIS;
