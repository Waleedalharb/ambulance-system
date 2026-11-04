-- P1–P3 additive schedule schema. No coverage values, account grants, or roster writes.
-- Apply only through scripts/migrate-schedule-p1-p3.js after its preflight and backup.

CREATE TABLE IF NOT EXISTS schedule_versions (
  id TEXT PRIMARY KEY,
  month TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  parent_version_id TEXT REFERENCES schedule_versions(id),
  reference_version_id TEXT REFERENCES schedule_versions(id),
  reference_content_hash TEXT,
  version_kind TEXT NOT NULL DEFAULT 'bootstrap_reference' CHECK (version_kind IN ('bootstrap_reference','generated_draft','correction')),
  status TEXT NOT NULL DEFAULT 'imported' CHECK (status IN ('imported','draft','ready_for_review','approved','published')),
  source_type TEXT NOT NULL,
  source_note TEXT,
  content_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  coverage_policy_version TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  approved_by TEXT,
  approved_at TEXT,
  published_by TEXT,
  published_at TEXT,
  UNIQUE(month, version_number)
);
CREATE INDEX IF NOT EXISTS idx_schedule_versions_reference
  ON schedule_versions(status, month, version_number);
CREATE TABLE IF NOT EXISTS schedule_gap_reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  gap_date TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT 'unresolved' CHECK (resolution IN ('unresolved','rest_confirmed','missing_data','out_of_scope','other_approved')),
  reason TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  UNIQUE(version_id, employee_id, gap_date)
);
CREATE INDEX IF NOT EXISTS idx_schedule_gap_reviews_version
  ON schedule_gap_reviews(version_id, resolution, employee_id, gap_date);
CREATE TABLE IF NOT EXISTS schedule_continuity_snapshots (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES schedule_versions(id) ON DELETE CASCADE,
  snapshot_number INTEGER NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved')),
  source_content_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_by TEXT,
  approved_at TEXT,
  UNIQUE(version_id, snapshot_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_schedule_continuity_current
  ON schedule_continuity_snapshots(version_id) WHERE is_current = 1;
CREATE TABLE IF NOT EXISTS schedule_continuity_entries (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES schedule_continuity_snapshots(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  status TEXT NOT NULL CHECK (status IN ('resolved','no_reference','unresolved','excluded')),
  pattern_code TEXT,
  next_phase_index INTEGER,
  next_shift_code TEXT,
  team_id INTEGER REFERENCES teams(id),
  assignment_status TEXT NOT NULL DEFAULT 'unresolved' CHECK (assignment_status IN ('resolved','unresolved','not_applicable')),
  effective_date TEXT,
  state_version INTEGER NOT NULL DEFAULT 1,
  resolution_source TEXT NOT NULL CHECK (resolution_source IN ('derived','manual_reviewed','exclusion')),
  reason TEXT,
  UNIQUE(snapshot_id, employee_id)
);
CREATE INDEX IF NOT EXISTS idx_schedule_continuity_entries_snapshot
  ON schedule_continuity_entries(snapshot_id, status, employee_id);
CREATE TRIGGER IF NOT EXISTS schedule_versions_content_immutable
  BEFORE UPDATE OF month, version_number, parent_version_id, reference_version_id,
    reference_content_hash, version_kind, source_type, source_note, content_json,
    content_hash, coverage_policy_version, created_by, created_at, approved_by, approved_at
  ON schedule_versions
  WHEN OLD.status IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved schedule version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_versions_approved_no_delete
  BEFORE DELETE ON schedule_versions
  WHEN OLD.status IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved schedule version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_gap_reviews_immutable_update
  BEFORE UPDATE ON schedule_gap_reviews
  WHEN (SELECT status FROM schedule_versions WHERE id = OLD.version_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved gap review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_gap_reviews_immutable_delete
  BEFORE DELETE ON schedule_gap_reviews
  WHEN (SELECT status FROM schedule_versions WHERE id = OLD.version_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved gap review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_gap_reviews_immutable_insert
  BEFORE INSERT ON schedule_gap_reviews
  WHEN (SELECT status FROM schedule_versions WHERE id = NEW.version_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved gap review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_continuity_snapshots_immutable
  BEFORE UPDATE OF version_id, snapshot_number, is_current, status, source_content_hash, summary_json,
    created_by, created_at, approved_by, approved_at ON schedule_continuity_snapshots
  WHEN OLD.status = 'approved'
  BEGIN SELECT RAISE(ABORT, 'approved continuity snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_continuity_snapshots_immutable_delete
  BEFORE DELETE ON schedule_continuity_snapshots
  WHEN OLD.status = 'approved' OR
    (SELECT status FROM schedule_versions WHERE id = OLD.version_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved continuity snapshot is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_continuity_entries_immutable_update
  BEFORE UPDATE ON schedule_continuity_entries
  WHEN (SELECT v.status FROM schedule_versions v
    JOIN schedule_continuity_snapshots s ON s.version_id = v.id
    WHERE s.id = OLD.snapshot_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved continuity entry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_continuity_entries_immutable_delete
  BEFORE DELETE ON schedule_continuity_entries
  WHEN (SELECT v.status FROM schedule_versions v
    JOIN schedule_continuity_snapshots s ON s.version_id = v.id
    WHERE s.id = OLD.snapshot_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved continuity entry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_continuity_entries_immutable_insert
  BEFORE INSERT ON schedule_continuity_entries
  WHEN (SELECT v.status FROM schedule_versions v
    JOIN schedule_continuity_snapshots s ON s.version_id = v.id
    WHERE s.id = NEW.snapshot_id) IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved continuity entry is immutable'); END;

CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id TEXT PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id),
  scope_team_id INTEGER REFERENCES teams(id),
  exception_type TEXT NOT NULL CHECK (exception_type IN ('temporary_assignment','temporary_change','operational_note')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  effect_shift_code TEXT,
  effect_team_id INTEGER REFERENCES teams(id),
  reason TEXT NOT NULL,
  approval_source TEXT NOT NULL,
  approval_authority TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  document_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,
  CHECK ((employee_id IS NOT NULL AND scope_team_id IS NULL) OR (employee_id IS NULL AND scope_team_id IS NOT NULL)),
  CHECK (end_date >= start_date),
  CHECK ((exception_type = 'operational_note' AND effect_shift_code IS NULL AND effect_team_id IS NULL)
    OR (exception_type <> 'operational_note' AND (effect_shift_code IS NOT NULL OR effect_team_id IS NOT NULL)))
);
CREATE INDEX IF NOT EXISTS idx_schedule_exceptions_effect
  ON schedule_exceptions(status, start_date, end_date, employee_id, scope_team_id);
CREATE TABLE IF NOT EXISTS schedule_coverage_approvals (
  id TEXT PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  applicability TEXT NOT NULL CHECK (applicability IN ('required','not_applicable')),
  coverage_default_hash TEXT NOT NULL,
  coverage_overrides_hash TEXT NOT NULL,
  source TEXT NOT NULL,
  approval_authority TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS idx_schedule_coverage_approvals_team
  ON schedule_coverage_approvals(team_id, status, effective_from, effective_to);
CREATE TABLE IF NOT EXISTS schedule_generation_runs (
  id TEXT PRIMARY KEY,
  schedule_version_id TEXT UNIQUE REFERENCES schedule_versions(id),
  target_month TEXT NOT NULL,
  reference_version_id TEXT NOT NULL REFERENCES schedule_versions(id),
  reference_content_hash TEXT NOT NULL,
  reference_snapshot_id TEXT NOT NULL REFERENCES schedule_continuity_snapshots(id),
  base_run_id TEXT REFERENCES schedule_generation_runs(id),
  mode TEXT NOT NULL CHECK (mode IN ('initial','minimal_diff')),
  status TEXT NOT NULL CHECK (status IN ('draft','ready_for_review')),
  input_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  output_hash TEXT NOT NULL,
  coverage_policy_version TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_generation_runs_month
  ON schedule_generation_runs(target_month, created_at, mode);
CREATE TABLE IF NOT EXISTS schedule_generation_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES schedule_generation_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  shift_date TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id),
  shift_code TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('baseline','approved_leave','documented_exception','m5_gap_fill','preserved')),
  reason TEXT NOT NULL,
  leave_id INTEGER REFERENCES leave_requests(id),
  exception_id TEXT REFERENCES schedule_exceptions(id),
  affected INTEGER NOT NULL DEFAULT 1 CHECK (affected IN (0,1)),
  UNIQUE(run_id, employee_id, shift_date)
);
CREATE INDEX IF NOT EXISTS idx_schedule_generation_entries_coverage
  ON schedule_generation_entries(run_id, team_id, shift_date, shift_code);
CREATE TABLE IF NOT EXISTS schedule_generation_diffs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES schedule_generation_runs(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id),
  shift_date TEXT NOT NULL,
  before_team_id INTEGER,
  before_shift_code TEXT,
  after_team_id INTEGER,
  after_shift_code TEXT,
  change_type TEXT NOT NULL CHECK (change_type IN ('added','changed','removed')),
  reason TEXT NOT NULL,
  exception_id TEXT REFERENCES schedule_exceptions(id),
  UNIQUE(run_id, employee_id, shift_date)
);
CREATE TRIGGER IF NOT EXISTS schedule_generation_runs_immutable_update
  BEFORE UPDATE ON schedule_generation_runs
  BEGIN SELECT RAISE(ABORT, 'generation run is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_generation_runs_immutable_delete
  BEFORE DELETE ON schedule_generation_runs
  BEGIN SELECT RAISE(ABORT, 'generation run is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_generation_entries_immutable_update
  BEFORE UPDATE ON schedule_generation_entries
  BEGIN SELECT RAISE(ABORT, 'generation entry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_generation_entries_immutable_delete
  BEFORE DELETE ON schedule_generation_entries
  BEGIN SELECT RAISE(ABORT, 'generation entry is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_generation_diffs_immutable_update
  BEFORE UPDATE ON schedule_generation_diffs
  BEGIN SELECT RAISE(ABORT, 'generation diff is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_generation_diffs_immutable_delete
  BEFORE DELETE ON schedule_generation_diffs
  BEGIN SELECT RAISE(ABORT, 'generation diff is immutable'); END;

CREATE TRIGGER IF NOT EXISTS schedule_versions_lifecycle_lock
  BEFORE UPDATE ON schedule_versions
  WHEN OLD.status IN ('approved','published') AND
    NOT (OLD.status = 'approved' AND NEW.status = 'published')
  BEGIN SELECT RAISE(ABORT, 'approved schedule version is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_versions_lifecycle_guard
  BEFORE UPDATE ON schedule_versions
  WHEN OLD.status NOT IN ('approved','published') AND NOT (
    (OLD.status = 'imported' AND NEW.status IN ('imported','draft')) OR
    (OLD.status = 'draft' AND NEW.status IN ('draft','ready_for_review')) OR
    (OLD.status = 'ready_for_review' AND NEW.status IN ('draft','ready_for_review','approved'))
  )
  BEGIN SELECT RAISE(ABORT, 'invalid schedule version lifecycle transition'); END;
CREATE TRIGGER IF NOT EXISTS schedule_versions_review_metadata_immutable
  BEFORE UPDATE OF reviewed_by, reviewed_at ON schedule_versions
  WHEN OLD.status IN ('approved','published')
  BEGIN SELECT RAISE(ABORT, 'approved schedule review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_versions_publish_metadata_immutable
  BEFORE UPDATE OF published_by, published_at ON schedule_versions
  WHEN OLD.status = 'published'
  BEGIN SELECT RAISE(ABORT, 'published schedule version is immutable'); END;
CREATE TABLE IF NOT EXISTS schedule_lifecycle_reviews (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES schedule_versions(id),
  run_id TEXT NOT NULL REFERENCES schedule_generation_runs(id),
  content_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  current_input_hash TEXT NOT NULL,
  coverage_policy_version TEXT,
  ready INTEGER NOT NULL CHECK (ready IN (0,1)),
  blockers_json TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  shortages_json TEXT NOT NULL,
  conflicts_json TEXT NOT NULL,
  e4_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_schedule_lifecycle_reviews_version
  ON schedule_lifecycle_reviews(version_id, created_at, id);
CREATE TRIGGER IF NOT EXISTS schedule_lifecycle_reviews_immutable_update
  BEFORE UPDATE ON schedule_lifecycle_reviews
  BEGIN SELECT RAISE(ABORT, 'schedule lifecycle review is immutable'); END;
CREATE TRIGGER IF NOT EXISTS schedule_lifecycle_reviews_immutable_delete
  BEFORE DELETE ON schedule_lifecycle_reviews
  BEGIN SELECT RAISE(ABORT, 'schedule lifecycle review is immutable'); END;
