'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const SectorCommandLedgerService = require('../../services/sector-command-ledger-service');
const RegionScopeService = require('../../services/region-scope-service');
const { createFixture, grant, NOW } = require('./fixtures');

function setup() {
  const db = createFixture();
  grant(db, 'leader', 'region', 'R1');
  grant(db, 'leader', 'region', 'R2');
  const scopeService = new RegionScopeService({ db, now: () => NOW });
  let tick = 0;
  const service = new SectorCommandLedgerService({ db, scopeService, now: () => new Date(Date.parse(NOW) + (++tick * 1000)) });
  return { db, service, actor: { id: 'leader', role: 'director', name: 'قائد اختبار' } };
}
const append = (service, actor, sectorId = 'S1') => service.append({ actor, sectorId, eventType: 'viewed', entity: { type: 'document', id: 'D1', versionId: 'V1', contentHash: 'a'.repeat(64) }, details: { note: '  اختبار  ', secret: 'drop-me' } });

test('hash chain starts at genesis and sectors remain independent', async () => {
  const { db, service, actor } = setup();
  const first = await append(service, actor);
  const second = await append(service, actor);
  const other = await append(service, actor, 'S3');
  assert.equal(first.sectorSeq, 1);
  assert.equal(first.previousHash, '0'.repeat(64));
  assert.match(first.eventHash, /^[a-f0-9]{64}$/);
  assert.equal(second.previousHash, first.eventHash);
  assert.equal(other.sectorSeq, 1);
  assert.equal(other.previousHash, '0'.repeat(64));
  assert.equal(first.actorUserId, 'leader');
  assert.deepEqual(first.details, { note: '  اختبار  ' });
  assert.equal((await service.verifySectorChain({ sectorId: 'S1' })).valid, true);
  db.close();
});

test('append-only triggers reject update and delete', async () => {
  const { db, service, actor } = setup();
  const entry = await append(service, actor);
  assert.throws(() => db.hdl.prepare('UPDATE sector_command_ledger SET details_json = ? WHERE id = ?').run('{}', entry.id), /SECTOR_LEDGER_APPEND_ONLY/);
  assert.throws(() => db.hdl.prepare('DELETE FROM sector_command_ledger WHERE id = ?').run(entry.id), /SECTOR_LEDGER_APPEND_ONLY/);
  db.close();
});

test('tampering, gaps and counter mismatches are detected', async () => {
  const { db, service, actor } = setup();
  await append(service, actor);
  await append(service, actor);
  db.hdl.exec('DROP TRIGGER trg_sector_ledger_no_update');
  db.hdl.prepare("UPDATE sector_command_ledger SET details_json = '{\"note\":\"tampered\"}' WHERE sector_seq = 1").run();
  assert.equal((await service.verifySectorChain({ sectorId: 'S1' })).code, 'EVENT_HASH_MISMATCH');
  db.hdl.prepare('UPDATE sector_command_ledger SET details_json = ? WHERE sector_seq = 1').run('{"note":"  اختبار  "}');
  db.hdl.prepare('UPDATE sector_command_counters SET next_seq = 99 WHERE sector_id = ?').run('S1');
  assert.equal((await service.verifySectorChain({ sectorId: 'S1' })).code, 'TRUNCATED_TAIL');
  db.close();
});

test('tail deletion fails as TRUNCATED_TAIL even when remaining hashes are valid', async () => {
  const { db, service, actor } = setup();
  await append(service, actor);
  await append(service, actor);
  await append(service, actor);
  const before = await service.verifySectorChain({ sectorId: 'S1' });
  assert.equal(before.valid, true);
  db.hdl.exec('DROP TRIGGER trg_sector_ledger_no_delete');
  db.hdl.prepare('DELETE FROM sector_command_ledger WHERE sector_id = ? AND sector_seq = 3').run('S1');
  const rows = db.hdl.prepare('SELECT * FROM sector_command_ledger WHERE sector_id = ? ORDER BY sector_seq').all('S1');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].previous_hash, rows[0].event_hash);
  const result = await service.verifySectorChain({ sectorId: 'S1' });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'TRUNCATED_TAIL');
  db.close();
});

test('concurrent append calls never duplicate sequence or fork the head', async () => {
  const { db, service, actor } = setup();
  const entries = await Promise.all(Array.from({ length: 30 }, () => append(service, actor)));
  assert.equal(new Set(entries.map(e => e.sectorSeq)).size, 30);
  const result = await service.verifySectorChain({ sectorId: 'S1' });
  assert.equal(result.valid, true);
  assert.equal(result.nextSeq, 31);
  db.close();
});

test('empty sector, forbidden event types and out-of-scope actor fail safely', async () => {
  const { db, service, actor } = setup();
  assert.deepEqual((await service.verifySectorChain({ sectorId: 'S2' })).code, 'EMPTY');
  await assert.rejects(service.append({ actor, sectorId: 'S1', eventType: 'signed' }), e => e.code === 'EVENT_TYPE_NOT_ALLOWED');
  await assert.rejects(service.append({ actor: { id: 'outsider' }, sectorId: 'S1', eventType: 'viewed' }), e => e.code === 'NO_ACTIVE_SCOPE');
  assert.equal(db.hdl.prepare('SELECT COUNT(*) AS n FROM sector_command_ledger').get().n, 0);
  db.close();
});
