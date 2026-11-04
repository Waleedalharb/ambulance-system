-- P6 smart-import additive schema. No roster/month/account/coverage writes.
-- Apply only through scripts/migrate-schedule-p6.js after preflight and backup.

CREATE TABLE IF NOT EXISTS schedule_import_batches (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('xlsx','xls','xlsm','csv','pdf','png','jpg','jpeg')),
  mime_type TEXT,
  file_size INTEGER NOT NULL,
  month TEXT,
  status TEXT NOT NULL CHECK (status IN ('analyzed','mapped','validated','reviewed','imported')),
  initial_analysis_json TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  analysis_hash TEXT NOT NULL,
  mapping_json TEXT,
  version_id TEXT REFERENCES schedule_versions(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT,
  updated_at TEXT,
  imported_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_schedule_import_batches_month
  ON schedule_import_batches(month, status, created_at);
CREATE TABLE IF NOT EXISTS schedule_import_reviews (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES schedule_import_batches(id),
  issue_id TEXT,
  assignment_id TEXT,
  action TEXT NOT NULL,
  value_json TEXT,
  reason TEXT NOT NULL,
  analysis_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_import_reviews_batch
  ON schedule_import_reviews(batch_id, created_at, id);
CREATE TABLE IF NOT EXISTS schedule_import_templates (
  id TEXT PRIMARY KEY,
  signature TEXT UNIQUE NOT NULL,
  structure_map_json TEXT NOT NULL,
  source_batch_id TEXT NOT NULL REFERENCES schedule_import_batches(id),
  analysis_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS schedule_import_batches_source_immutable
  BEFORE UPDATE OF original_name, stored_path, file_sha256, format, file_size, created_by, created_at
  ON schedule_import_batches
  BEGIN SELECT RAISE(ABORT, 'smart import source is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_import_batches_no_delete
  BEFORE DELETE ON schedule_import_batches
  BEGIN SELECT RAISE(ABORT, 'smart import batch is retained'); END;
CREATE TRIGGER IF NOT EXISTS schedule_import_reviews_immutable_update
  BEFORE UPDATE ON schedule_import_reviews
  BEGIN SELECT RAISE(ABORT, 'smart import review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_import_reviews_immutable_delete
  BEFORE DELETE ON schedule_import_reviews
  BEGIN SELECT RAISE(ABORT, 'smart import review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_import_templates_immutable_update
  BEFORE UPDATE ON schedule_import_templates
  BEGIN SELECT RAISE(ABORT, 'smart import template is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_import_templates_immutable_delete
  BEFORE DELETE ON schedule_import_templates
  BEGIN SELECT RAISE(ABORT, 'smart import template is immutable'); END;
