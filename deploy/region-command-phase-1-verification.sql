PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;

SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE name IN (
  'regions', 'sectors', 'sector_centers', 'user_access_scopes',
  'sector_command_counters', 'sector_command_ledger',
  'trg_sector_centers_no_overlap_insert', 'trg_sector_centers_no_overlap_update',
  'trg_user_scopes_no_overlap_insert', 'trg_user_scopes_no_overlap_update',
  'trg_sector_ledger_no_update', 'trg_sector_ledger_no_delete'
)
ORDER BY type, name;

EXPLAIN QUERY PLAN
SELECT s.id FROM sectors s
WHERE s.region_id = 'verification-only' AND s.status = 'active';
EXPLAIN QUERY PLAN
SELECT center_id FROM sector_centers
WHERE sector_id = 'verification-only' AND effective_from <= '9999-01-01T00:00:00.000Z'
  AND (effective_to IS NULL OR effective_to > '9999-01-01T00:00:00.000Z');
EXPLAIN QUERY PLAN
SELECT id FROM sector_command_ledger
WHERE sector_id = 'verification-only' ORDER BY occurred_at DESC, id DESC LIMIT 50;
