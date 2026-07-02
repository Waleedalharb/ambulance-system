/**
 * ============================================================================
 * Shift Codes Seed Script — سكربت إدخال رموز المناوبات
 * ============================================================================
 *
 * Seeds the `shift_codes` table in SQLite with all recognized shift codes.
 * Safe to run multiple times: skips codes that already exist.
 *
 * Usage (standalone):
 *   node db/seed-shift-codes.js
 *
 * Usage (from server.js):
 *   const seedShiftCodes = require('./db/seed-shift-codes');
 *   await seedShiftCodes(); // on first run or after schema creation
 *
 * Depends on: ./db.js (same module used by the main app)
 * ============================================================================
 */

const path = require('path');

// We need the db module. Try both paths since this file might be run from root or db/.
let db;
try {
  db = require('../db.js');
} catch (e) {
  try {
    db = require('./db.js');
  } catch (e2) {
    console.error('[SEED] Failed to load db.js module:', e2.message);
    process.exit(1);
  }
}

// ============================================================================
// Shift Codes Data — MUST stay in sync with public/js/shift-codes-config.js
// ============================================================================

const SHIFT_CODES_SEED = [
  /* Day Shifts */
  { code: 'D12', name: 'دوام 12 صباحاً', time_start: '05:00', time_end: '17:00', color: '#2563EB', status: 'دوام' },
  { code: 'D10', name: 'دوام 10 صباحاً', time_start: '05:00', time_end: '15:00', color: '#3B82F6', status: 'دوام' },
  { code: 'D11', name: 'دوام 11 صباحاً', time_start: '06:00', time_end: '17:00', color: '#2563EB', status: 'دوام' },
  { code: 'D8',  name: 'دوام 8 صباحاً',  time_start: '07:00', time_end: '15:00', color: '#60A5FA', status: 'دوام' },
  { code: 'D6',  name: 'دوام 6 صباحاً',  time_start: '08:00', time_end: '14:00', color: '#93C5FD', status: 'دوام' },

  /* Night Shifts */
  { code: 'N12', name: 'دوام 12 ليلاً', time_start: '17:00', time_end: '05:00', color: '#1E40AF', status: 'دوام' },
  { code: 'N10', name: 'دوام 10 ليلاً', time_start: '17:00', time_end: '03:00', color: '#1E3A8A', status: 'دوام' },
  { code: 'N11', name: 'دوام 11 ليلاً', time_start: '18:00', time_end: '05:00', color: '#1E40AF', status: 'دوام' },
  { code: 'N8',  name: 'دوام 8 ليلاً',  time_start: '17:00', time_end: '01:00', color: '#3730A3', status: 'دوام' },
  { code: 'N6',  name: 'دوام 6 ليلاً',  time_start: '19:00', time_end: '01:00', color: '#4338CA', status: 'دوام' },

  /* Late Night Shifts */
  { code: 'LN8',  name: 'ليلية 8',  time_start: '20:00', time_end: '04:00', color: '#312E81', status: 'دوام' },
  { code: 'LN10', name: 'ليلية 10', time_start: '18:00', time_end: '04:00', color: '#3730A3', status: 'دوام' },

  /* Overlap Shifts */
  { code: 'O12', name: 'أوفرلاب 12', time_start: '08:00', time_end: '20:00', color: '#0891B2', status: 'دوام' },
  { code: 'O10', name: 'أوفرلاب 10', time_start: '09:00', time_end: '19:00', color: '#06B6D4', status: 'دوام' },
  { code: 'O6',  name: 'أوفرلاب 6',  time_start: '10:00', time_end: '16:00', color: '#22D3EE', status: 'دوام' },

  /* Mission */
  { code: 'M', name: 'مهمة', time_start: '00:00', time_end: '23:59', color: '#DC2626', status: 'دوام' },

  /* Training */
  { code: 'C', name: 'تدريب', time_start: '08:00', time_end: '16:00', color: '#9333EA', status: 'تدريب' },

  /* Assigned / Seconded */
  { code: 'ME', name: 'مكلف', time_start: '00:00', time_end: '23:59', color: '#D97706', status: 'تكميل' },
  { code: 'F',  name: 'مكلف', time_start: '00:00', time_end: '23:59', color: '#B45309', status: 'تكميل' },

  /* Completion Shifts */
  { code: 'CP8',  name: 'تكميلية 8',        time_start: '17:00', time_end: '01:00', color: '#F59E0B', status: 'تكميل' },
  { code: 'CP24', name: 'تكميلية 24',       time_start: '05:00', time_end: '05:00', color: '#F97316', status: 'تكميل' },
  { code: 'CPD',  name: 'تكميلية صباحية',   time_start: '08:00', time_end: '20:00', color: '#FB923C', status: 'تكميل' },
  { code: 'CPN',  name: 'تكميلية ليلية',    time_start: '20:00', time_end: '08:00', color: '#EA580C', status: 'تكميل' },

  /* Vacation */
  { code: 'V',  name: 'إجازة',             time_start: null, time_end: null, color: '#EF4444', status: 'إجازة' },
  { code: 'VC', name: 'إجازة مرضية',       time_start: null, time_end: null, color: '#F87171', status: 'إجازة' },
  { code: 'E',  name: 'إجازة',             time_start: null, time_end: null, color: '#EF4444', status: 'إجازة' },
  { code: 'EV', name: 'إجازة استثنائية',   time_start: null, time_end: null, color: '#FCA5A5', status: 'إجازة' },

  /* Rest / Weekend Off */
  { code: 'WO', name: 'Weekend Off', time_start: null, time_end: null, color: '#10B981', status: 'راحة' }
];

// ============================================================================
// Seed Logic
// ============================================================================

async function seedShiftCodes() {
  console.log('[SEED] Starting shift codes seed...');

  let dbOpenedHere = false;
  try {
    // If db is not already open, try to open it
    if (!db.get || typeof db.get !== 'function') {
      console.log('[SEED] DB not initialized, opening...');
      await db.openDb();
      dbOpenedHere = true;
    } else {
      // Test if connection is alive
      try {
        await db.get('SELECT 1;');
      } catch (e) {
        console.log('[SEED] DB connection not active, opening...');
        await db.openDb();
        dbOpenedHere = true;
      }
    }

    // Check if shift_codes table exists (it will be created by the backend schema)
    const tableCheck = await db.get(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='shift_codes';
    `);

    if (!tableCheck) {
      console.warn('[SEED] Table "shift_codes" does not exist yet. Skipping seed.');
      console.warn('[SEED] The backend schema worker must create the table first.');
      console.warn('[SEED] Run this script again after the backend schema is applied.');
      return { seeded: 0, skipped: SHIFT_CODES_SEED.length, reason: 'table_not_exists' };
    }

    // Check how many codes already exist
    const countRow = await db.get('SELECT COUNT(*) as count FROM shift_codes;');
    const existingCount = countRow ? countRow.count : 0;

    if (existingCount >= SHIFT_CODES_SEED.length) {
      console.log(`[SEED] All ${SHIFT_CODES_SEED.length} shift codes already exist (${existingCount} in DB). Skipping.`);
      return { seeded: 0, skipped: SHIFT_CODES_SEED.length, reason: 'already_seeded' };
    }

    // Insert missing codes (skip duplicates by code)
    let inserted = 0;
    let skipped = 0;

    for (const sc of SHIFT_CODES_SEED) {
      try {
        const existing = await db.get('SELECT id FROM shift_codes WHERE code = ?;', [sc.code]);
        if (existing) {
          skipped++;
          continue;
        }

        await db.run(
          `INSERT INTO shift_codes (code, name, time_start, time_end, color, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP);`,
          [sc.code, sc.name, sc.time_start, sc.time_end, sc.color, sc.status]
        );
        inserted++;
        console.log(`[SEED] Inserted: ${sc.code} — ${sc.name}`);
      } catch (err) {
        console.error(`[SEED] Failed to insert ${sc.code}:`, err.message);
        skipped++;
      }
    }

    console.log(`[SEED] Done. Inserted: ${inserted}, Skipped: ${skipped}`);
    return { seeded: inserted, skipped, reason: 'completed' };

  } catch (err) {
    console.error('[SEED] Fatal error during seed:', err.message);
    throw err;
  } finally {
    if (dbOpenedHere) {
      try {
        await db.closeDb();
        console.log('[SEED] DB connection closed.');
      } catch (e) {
        // ignore close errors
      }
    }
  }
}

// ============================================================================
// Standalone execution
// ============================================================================

if (require.main === module) {
  seedShiftCodes()
    .then(result => {
      if (result.reason === 'table_not_exists') {
        console.log('\n[SEED] ℹ️  The shift_codes table is not ready yet.');
        console.log('[SEED]    This is expected if the backend schema has not been applied.');
        console.log('[SEED]    Re-run this script after the database migration completes.');
        process.exit(0);
      }
      console.log('[SEED] Result:', result);
      process.exit(0);
    })
    .catch(err => {
      console.error('[SEED] Failed:', err.message);
      process.exit(1);
    });
}

// ============================================================================
// Module export
// ============================================================================

module.exports = { seedShiftCodes, SHIFT_CODES_SEED };
