/**
 * ============================================================================
 * Shift Codes Configuration — رموز المناوبات
 * ============================================================================
 * 
 * Complete shift codes map extracted from the monthly Excel schedule analysis.
 * Contains all 28+ recognized codes with their display names, times, colors,
 * and status categories (دوام / إجازة / تدريب / راحة / تكميل).
 *
 * This file is the SINGLE SOURCE OF TRUTH for shift code definitions across
 * the frontend and backend. Keep it in sync with db/seed-shift-codes.js.
 *
 * Usage:
 *   <script type="module">
 *     import { SHIFT_CODES, getShiftByCode, isPresent } from './js/shift-codes-config.js';
 *   </script>
 *
 * Or via require() in Node.js:
 *   const { SHIFT_CODES, getShiftByCode, isPresent } = require('./public/js/shift-codes-config.js');
 * ============================================================================
 */

const SHIFT_CODES = [
  /* ── Day Shifts (دوام صباحي) ── */
  {
    code: 'D12',
    name: 'دوام 12 صباحاً',
    time_start: '05:00',
    time_end: '17:00',
    color: '#2563EB',
    status: 'دوام'
  },
  {
    code: 'D10',
    name: 'دوام 10 صباحاً',
    time_start: '05:00',
    time_end: '15:00',
    color: '#3B82F6',
    status: 'دوام'
  },
  {
    code: 'D11',
    name: 'دوام 11 صباحاً',
    time_start: '06:00',
    time_end: '17:00',
    color: '#2563EB',
    status: 'دوام'
  },
  {
    code: 'D8',
    name: 'دوام 8 صباحاً',
    time_start: '07:00',
    time_end: '15:00',
    color: '#60A5FA',
    status: 'دوام'
  },
  {
    code: 'D6',
    name: 'دوام 6 صباحاً',
    time_start: '08:00',
    time_end: '14:00',
    color: '#93C5FD',
    status: 'دوام'
  },

  /* ── Night Shifts (دوام ليلي) ── */
  {
    code: 'N12',
    name: 'دوام 12 ليلاً',
    time_start: '17:00',
    time_end: '05:00',
    color: '#1E40AF',
    status: 'دوام'
  },
  {
    code: 'N10',
    name: 'دوام 10 ليلاً',
    time_start: '17:00',
    time_end: '03:00',
    color: '#1E3A8A',
    status: 'دوام'
  },
  {
    code: 'N11',
    name: 'دوام 11 ليلاً',
    time_start: '18:00',
    time_end: '05:00',
    color: '#1E40AF',
    status: 'دوام'
  },
  {
    code: 'N8',
    name: 'دوام 8 ليلاً',
    time_start: '17:00',
    time_end: '01:00',
    color: '#3730A3',
    status: 'دوام'
  },
  {
    code: 'N6',
    name: 'دوام 6 ليلاً',
    time_start: '19:00',
    time_end: '01:00',
    color: '#4338CA',
    status: 'دوام'
  },

  /* ── Late Night Shifts (ليلية متأخرة) ── */
  {
    code: 'LN8',
    name: 'ليلية 8',
    time_start: '20:00',
    time_end: '04:00',
    color: '#312E81',
    status: 'دوام'
  },
  {
    code: 'LN10',
    name: 'ليلية 10',
    time_start: '18:00',
    time_end: '04:00',
    color: '#3730A3',
    status: 'دوام'
  },

  /* ── Overlap Shifts (أوفرلاب) ── */
  {
    code: 'O12',
    name: 'أوفرلاب 12',
    time_start: '08:00',
    time_end: '20:00',
    color: '#0891B2',
    status: 'دوام'
  },
  {
    code: 'O10',
    name: 'أوفرلاب 10',
    time_start: '09:00',
    time_end: '19:00',
    color: '#06B6D4',
    status: 'دوام'
  },
  {
    code: 'O6',
    name: 'أوفرلاب 6',
    time_start: '10:00',
    time_end: '16:00',
    color: '#22D3EE',
    status: 'دوام'
  },

  /* ── Mission / Field Duty (مهمة) ── */
  {
    code: 'M',
    name: 'مهمة',
    time_start: '00:00',
    time_end: '23:59',
    color: '#DC2626',
    status: 'دوام'
  },

  /* ── Training (تدريب) ── */
  {
    code: 'C',
    name: 'تدريب',
    time_start: '08:00',
    time_end: '16:00',
    color: '#9333EA',
    status: 'تدريب'
  },

  /* ── Assigned / Seconded (مكلف / تكميلي) ── */
  {
    code: 'ME',
    name: 'مكلف',
    time_start: '00:00',
    time_end: '23:59',
    color: '#D97706',
    status: 'تكميل'
  },
  {
    code: 'F',
    name: 'مكلف',
    time_start: '00:00',
    time_end: '23:59',
    color: '#B45309',
    status: 'تكميل'
  },

  /* ── Completion Shifts (تكميلية) ── */
  {
    code: 'CP8',
    name: 'تكميلية 8',
    time_start: '17:00',
    time_end: '01:00',
    color: '#F59E0B',
    status: 'تكميل'
  },
  {
    code: 'CP24',
    name: 'تكميلية 24',
    time_start: '05:00',
    time_end: '05:00',
    color: '#F97316',
    status: 'تكميل'
  },
  {
    code: 'CPD',
    name: 'تكميلية صباحية',
    time_start: '08:00',
    time_end: '20:00',
    color: '#FB923C',
    status: 'تكميل'
  },
  {
    code: 'CPN',
    name: 'تكميلية ليلية',
    time_start: '20:00',
    time_end: '08:00',
    color: '#EA580C',
    status: 'تكميل'
  },

  /* ── Vacation (إجازة) ── */
  {
    code: 'V',
    name: 'إجازة',
    time_start: null,
    time_end: null,
    color: '#EF4444',
    status: 'إجازة'
  },
  {
    code: 'VC',
    name: 'إجازة مرضية',
    time_start: null,
    time_end: null,
    color: '#F87171',
    status: 'إجازة'
  },
  {
    code: 'E',
    name: 'إجازة',
    time_start: null,
    time_end: null,
    color: '#EF4444',
    status: 'إجازة'
  },
  {
    code: 'EV',
    name: 'إجازة استثنائية',
    time_start: null,
    time_end: null,
    color: '#FCA5A5',
    status: 'إجازة'
  },

  /* ── Rest / Weekend Off (راحة) ── */
  {
    code: 'WO',
    name: 'Weekend Off',
    time_start: null,
    time_end: null,
    color: '#10B981',
    status: 'راحة'
  }
];

/* ============================================================================
   Helper Functions
   ============================================================================ */

/**
 * Lookup a shift code by its code string (case-insensitive).
 * Returns the shift object or a fallback generic entry.
 */
function getShiftByCode(code) {
  if (!code) return null;
  const upper = code.toString().trim().toUpperCase();
  return SHIFT_CODES.find(s => s.code === upper) || {
    code: upper,
    name: `رمز غير معروف (${upper})`,
    time_start: null,
    time_end: null,
    color: '#6B7280',
    status: 'غير معروف'
  };
}

/**
 * Check if a shift code means the employee is PRESENT (حاضر).
 * Employees are considered absent if their shift code is one of the vacation/rest codes.
 */
function isPresent(code) {
  const shift = getShiftByCode(code);
  if (!shift) return true; // Unknown codes default to present
  const absentStatuses = ['إجازة', 'راحة'];
  return !absentStatuses.includes(shift.status);
}

/**
 * Get a display label for a shift code (e.g., "D12 — دوام 12 صباحاً").
 */
function getShiftLabel(code) {
  const shift = getShiftByCode(code);
  return shift ? `${shift.code} — ${shift.name}` : code;
}

/**
 * Get all shift codes grouped by status category.
 * Returns an object keyed by status.
 */
function getCodesByStatus() {
  return SHIFT_CODES.reduce((acc, s) => {
    if (!acc[s.status]) acc[s.status] = [];
    acc[s.status].push(s);
    return acc;
  }, {});
}

/**
 * Get all shift codes sorted by status then code.
 */
function getSortedCodes() {
  const statusOrder = ['دوام', 'تكميل', 'تدريب', 'إجازة', 'راحة', 'غير معروف'];
  return [...SHIFT_CODES].sort((a, b) => {
    const aIdx = statusOrder.indexOf(a.status);
    const bIdx = statusOrder.indexOf(b.status);
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.code.localeCompare(b.code);
  });
}

/**
 * Get a CSS style string for a shift code badge.
 */
function getShiftBadgeStyle(code) {
  const shift = getShiftByCode(code);
  if (!shift) return '';
  return `background-color: ${shift.color}20; color: ${shift.color}; border: 1px solid ${shift.color}40;`;
}

/* ============================================================================
   Exports (CommonJS + ES Module compatible)
   ============================================================================ */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHIFT_CODES,
    getShiftByCode,
    isPresent,
    getShiftLabel,
    getCodesByStatus,
    getSortedCodes,
    getShiftBadgeStyle
  };
}
