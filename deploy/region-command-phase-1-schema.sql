PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS sectors (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES regions(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE(region_id, code)
);
CREATE INDEX IF NOT EXISTS idx_sectors_region_status ON sectors(region_id, status);

CREATE TABLE IF NOT EXISTS sector_centers (
  id TEXT PRIMARY KEY,
  sector_id TEXT NOT NULL REFERENCES sectors(id),
  center_id TEXT NOT NULL REFERENCES centers(id),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  ended_at TEXT,
  ended_by TEXT,
  end_reason TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_sector_centers_sector_period ON sector_centers(sector_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_sector_centers_center_period ON sector_centers(center_id, effective_from, effective_to);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sector_centers_current_center ON sector_centers(center_id) WHERE effective_to IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_sector_centers_no_overlap_insert
BEFORE INSERT ON sector_centers
WHEN EXISTS (
  SELECT 1 FROM sector_centers existing
  WHERE existing.center_id = NEW.center_id
    AND NEW.effective_from < COALESCE(existing.effective_to, '9999-12-31T23:59:59.999Z')
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > existing.effective_from
)
BEGIN SELECT RAISE(ABORT, 'SECTOR_CENTER_PERIOD_OVERLAP'); END;

CREATE TRIGGER IF NOT EXISTS trg_sector_centers_no_overlap_update
BEFORE UPDATE ON sector_centers
WHEN EXISTS (
  SELECT 1 FROM sector_centers existing
  WHERE existing.center_id = NEW.center_id AND existing.id <> OLD.id
    AND NEW.effective_from < COALESCE(existing.effective_to, '9999-12-31T23:59:59.999Z')
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > existing.effective_from
)
BEGIN SELECT RAISE(ABORT, 'SECTOR_CENTER_PERIOD_OVERLAP'); END;

CREATE TABLE IF NOT EXISTS user_access_scopes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('region', 'sector')),
  scope_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  reason TEXT,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX IF NOT EXISTS idx_user_scopes_user_period ON user_access_scopes(user_id, status, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_user_scopes_target ON user_access_scopes(scope_type, scope_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_scopes_current_target ON user_access_scopes(user_id, scope_type, scope_id) WHERE effective_to IS NULL;

CREATE TRIGGER IF NOT EXISTS trg_user_scopes_validate_region_insert
BEFORE INSERT ON user_access_scopes
WHEN NEW.scope_type = 'region' AND NOT EXISTS (SELECT 1 FROM regions WHERE id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'SCOPE_REGION_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS trg_user_scopes_validate_sector_insert
BEFORE INSERT ON user_access_scopes
WHEN NEW.scope_type = 'sector' AND NOT EXISTS (SELECT 1 FROM sectors WHERE id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'SCOPE_SECTOR_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS trg_user_scopes_validate_region_update
BEFORE UPDATE ON user_access_scopes
WHEN NEW.scope_type = 'region' AND NOT EXISTS (SELECT 1 FROM regions WHERE id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'SCOPE_REGION_NOT_FOUND'); END;
CREATE TRIGGER IF NOT EXISTS trg_user_scopes_validate_sector_update
BEFORE UPDATE ON user_access_scopes
WHEN NEW.scope_type = 'sector' AND NOT EXISTS (SELECT 1 FROM sectors WHERE id = NEW.scope_id)
BEGIN SELECT RAISE(ABORT, 'SCOPE_SECTOR_NOT_FOUND'); END;

CREATE TRIGGER IF NOT EXISTS trg_user_scopes_no_overlap_insert
BEFORE INSERT ON user_access_scopes
WHEN EXISTS (
  SELECT 1 FROM user_access_scopes existing
  WHERE existing.user_id = NEW.user_id AND existing.scope_type = NEW.scope_type AND existing.scope_id = NEW.scope_id
    AND NEW.effective_from < COALESCE(existing.effective_to, '9999-12-31T23:59:59.999Z')
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > existing.effective_from
)
BEGIN SELECT RAISE(ABORT, 'USER_SCOPE_PERIOD_OVERLAP'); END;
CREATE TRIGGER IF NOT EXISTS trg_user_scopes_no_overlap_update
BEFORE UPDATE ON user_access_scopes
WHEN EXISTS (
  SELECT 1 FROM user_access_scopes existing
  WHERE existing.user_id = NEW.user_id AND existing.scope_type = NEW.scope_type AND existing.scope_id = NEW.scope_id AND existing.id <> OLD.id
    AND NEW.effective_from < COALESCE(existing.effective_to, '9999-12-31T23:59:59.999Z')
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > existing.effective_from
)
BEGIN SELECT RAISE(ABORT, 'USER_SCOPE_PERIOD_OVERLAP'); END;

CREATE TABLE IF NOT EXISTS sector_command_counters (
  sector_id TEXT PRIMARY KEY REFERENCES sectors(id),
  next_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_seq >= 1)
);

CREATE TABLE IF NOT EXISTS sector_command_ledger (
  id TEXT PRIMARY KEY,
  sector_id TEXT NOT NULL REFERENCES sectors(id),
  sector_seq INTEGER NOT NULL CHECK (sector_seq >= 1),
  transaction_id TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('viewed', 'hierarchy_changed', 'scope_changed')),
  actor_user_id TEXT NOT NULL,
  actor_role_at_event TEXT,
  entity_type TEXT,
  entity_id TEXT,
  version_id TEXT,
  content_hash TEXT,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  hash_version INTEGER NOT NULL DEFAULT 1 CHECK (hash_version = 1),
  previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  UNIQUE(sector_id, sector_seq)
);
CREATE INDEX IF NOT EXISTS idx_sector_ledger_sector_time ON sector_command_ledger(sector_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS idx_sector_ledger_actor_time ON sector_command_ledger(actor_user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sector_ledger_entity ON sector_command_ledger(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sector_ledger_transaction ON sector_command_ledger(transaction_id);

CREATE TRIGGER IF NOT EXISTS trg_sector_ledger_no_update
BEFORE UPDATE ON sector_command_ledger
BEGIN SELECT RAISE(ABORT, 'SECTOR_LEDGER_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS trg_sector_ledger_no_delete
BEFORE DELETE ON sector_command_ledger
BEGIN SELECT RAISE(ABORT, 'SECTOR_LEDGER_APPEND_ONLY'); END;
