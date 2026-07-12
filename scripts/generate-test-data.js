#!/usr/bin/env node
/* ==========================================
   سكريبت توليد بيانات تجريبية محلية
   Local Test Data Generator
   ==========================================
   يعمل فقط محليًا — يمنع التشغيل على بيئة الإنتاج
   Usage:
     node scripts/generate-test-data.js --week
     node scripts/generate-test-data.js --month --verbose
     node scripts/generate-test-data.js --days=14 --shifts-per-day=2 --reports-per-shift=10
     node scripts/generate-test-data.js --regenerate --confirm
     node scripts/generate-test-data.js --delete --confirm
     node scripts/generate-test-data.js --help
*/

'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

// ─── PROJECT PATHS ─────────────────────────────────────────────────
const PROJECT_ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(PROJECT_ROOT, 'database.db');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SHIFT_DATA_PATH = path.join(DATA_DIR, 'shift-data.json');
const AMBULANCE_DATA_PATH = path.join(DATA_DIR, 'ambulance-data.json');
const LOG_PATH = path.join(PROJECT_ROOT, 'scripts', 'generate-test-data.log');

// ─── SAFETY: PRODUCTION GUARD ──────────────────────────────────────
function isProduction() {
  return process.env.NODE_ENV === 'production' ||
         process.env.RENDER === 'true' ||
         process.env.RENDER_DISK_PATH ||
         process.env.RAILWAY_ENVIRONMENT ||
         process.env.HEROKU_APP_ID;
}

// ─── ARGUMENT PARSER ───────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    days: 7,
    shiftsPerDay: 2,
    reportsPerShift: null, // random 5-15
    employees: 40,
    teams: 10,
    vehiclesPerTeam: 2,
    completionsPerShift: 1,
    formsPerShift: null, // random 1-3
    notesPerShift: null, // random 2-5
    timelineEventsPerShift: null, // random 3-8
    announcements: 1,
    opsFiles: 1,
    chatMessages: 3,
    leaveRequests: 1,
    hospitals: 5,
    startDate: null, // will default to today minus days
    seed: 12345,
    verbose: false,
    skipBackup: false,
    regenerate: false,
    delete: false,
    confirm: false,
    forceProduction: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === '--week') { config.days = 7; }
    else if (arg === '--month') { config.days = 30; }
    else if (arg === '--verbose') { config.verbose = true; }
    else if (arg === '--skip-backup') { config.skipBackup = true; }
    else if (arg === '--regenerate') { config.regenerate = true; }
    else if (arg === '--delete') { config.delete = true; }
    else if (arg === '--confirm') { config.confirm = true; }
    else if (arg === '--force-production') { config.forceProduction = true; }
    else if (arg === '--help' || arg === '-h') { config.help = true; }
    else if (arg.startsWith('--days=')) { config.days = parseInt(arg.split('=')[1]); }
    else if (arg.startsWith('--shifts-per-day=')) { config.shiftsPerDay = parseInt(arg.split('=')[1]); }
    else if (arg.startsWith('--reports-per-shift=')) { config.reportsPerShift = parseInt(arg.split('=')[1]); }
    else if (arg.startsWith('--employees=')) { config.employees = parseInt(arg.split('=')[1]); }
    else if (arg.startsWith('--teams=')) { config.teams = parseInt(arg.split('=')[1]); }
    else if (arg.startsWith('--seed=')) { config.seed = parseInt(arg.split('=')[1]); }
    else if (arg.startsWith('--start-date=')) { config.startDate = arg.split('=')[1]; }
  }

  return config;
}

function showHelp() {
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║       سكريبت توليد بيانات تجريبية — Local Test Data Generator ║
╠════════════════════════════════════════════════════════════════╣
║  يعمل محليًا فقط — ممنوع على بيئة الإنتاج                      ║
╠════════════════════════════════════════════════════════════════╣
  الاستخدام:
    node scripts/generate-test-data.js --week                    (7 أيام)
    node scripts/generate-test-data.js --month                   (30 يوم)
    node scripts/generate-test-data.js --days=14                 (N يوم)
    node scripts/generate-test-data.js --regenerate --confirm    (حذف + إعادة)
    node scripts/generate-test-data.js --delete --confirm        (حذف فقط)

  الخيارات:
    --days=N                 عدد الأيام (افتراضي: 7)
    --shifts-per-day=N       مناوبات يومية (افتراضي: 2)
    --reports-per-shift=N    بلاغات لكل مناوبة (افتراضي: عشوائي 5-15)
    --employees=N            عدد الموظفين (افتراضي: 40)
    --teams=N                عدد الفرق (افتراضي: 10)
    --seed=N                 مولد عشوائي (للتكرار، افتراضي: 12345)
    --start-date=YYYY-MM-DD  تاريخ البداية (افتراضي: اليوم - الأيام)
    --verbose                عرض تفاصيل أكثر
    --skip-backup            تجاوز النسخ الاحتياطي
    --regenerate             حذف البيانات القديمة ثم إنشاء جديدة
    --delete                 حذف جميع البيانات التجريبية فقط
    --confirm                تأكيد العمليات الخطرة (مطلوب مع --delete/--regenerate)
    --force-production       تجاوز حماية بيئة الإنتاج (⚠️ خطير)
    --help, -h               عرض هذه الرسالة
╚════════════════════════════════════════════════════════════════╝
`);
}

// ─── LOGGER ────────────────────────────────────────────────────────
async function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] ${msg}\n`;
  await fs.appendFile(LOG_PATH, line).catch(() => {});
}

async function info(msg) { console.log(msg); await log(`INFO: ${msg}`); }
async function warn(msg) { console.warn(`⚠️  ${msg}`); await log(`WARN: ${msg}`); }
async function error(msg) { console.error(`❌ ${msg}`); await log(`ERROR: ${msg}`); }
async function success(msg) { console.log(`✅ ${msg}`); await log(`SUCCESS: ${msg}`); }
async function verbose(config, msg) { if (config.verbose) { console.log(`  📝 ${msg}`); await log(`VERBOSE: ${msg}`); } }

// ─── SEEDED RANDOM ─────────────────────────────────────────────────
function makeRandom(seed) {
  let s = seed;
  return {
    next() {
      s = (s * 16807 + 0) % 2147483647;
      return (s - 1) / 2147483646;
    },
    range(min, max) {
      return min + Math.floor(this.next() * (max - min + 1));
    },
    pick(arr) {
      return arr[this.range(0, arr.length - 1)];
    },
    chance(prob) {
      return this.next() < prob;
    },
    gaussian() {
      // Box-Muller transform
      const u1 = this.next();
      const u2 = this.next();
      return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
  };
}

// ─── DATA TEMPLATES ────────────────────────────────────────────────
const CENTERS = ['المنصورة', 'الخالدية', 'منفوحة', 'الدار البيضاء', 'الإسكان', 'الحائر', 'الشفاء', 'عكاظ', 'ديراب', 'الفرق الإضافية'];
const TEAM_NAMES = [
  { name: 'جنوب 1', center: 'المنصورة', type: 'جنوب' },
  { name: 'جنوب 2', center: 'الخالدية', type: 'جنوب' },
  { name: 'جنوب 3', center: 'منفوحة', type: 'جنوب' },
  { name: 'جنوب 4', center: 'الدار البيضاء', type: 'جنوب' },
  { name: 'جنوب 5', center: 'الدار البيضاء', type: 'جنوب' },
  { name: 'جنوب 6', center: 'الإسكان', type: 'جنوب' },
  { name: 'جنوب 7', center: 'الحائر', type: 'جنوب' },
  { name: 'جنوب 8', center: 'الشفاء', type: 'جنوب' },
  { name: 'جنوب 9', center: 'عكاظ', type: 'جنوب' },
  { name: 'جنوب 10', center: 'ديراب', type: 'جنوب' },
  { name: 'سريع 1', center: 'الدار البيضاء', type: 'سريع' },
  { name: 'سريع 2', center: 'الشفاء', type: 'سريع' },
  { name: 'سريع 3', center: 'المنصورة', type: 'سريع' },
  { name: 'سريع 4', center: 'الفرق الإضافية', type: 'سريع' },
];
const SHIFT_TYPES = ['صباحية', 'ليلية'];
const ARABIC_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const REPORT_TYPES = ['حادث مروري', 'إصابة منزلية', 'حالة طبية', 'إسعاف متقدم', 'إصابة عمل', 'حالة نقل', 'تسمم', 'غرق', 'حادث سير', 'إصابة رياضية'];
const VEHICLE_NAMES = ['سيارة 1', 'سيارة 2', 'باص 1', 'سريع 1', 'سريع 2', 'دعم 1', 'قيادة 1'];
const HOSPITAL_NAMES = [
  { name: 'مستشفى الملك فهد', address: 'شارع الملك فهد، الرياض', phone: '0114770000' },
  { name: 'مستشفى الملك خالد', address: 'حي الملز، الرياض', phone: '0114771111' },
  { name: 'مستشفى اليمامة', address: 'حي النسيم، الرياض', phone: '0114772222' },
  { name: 'مستشفى سلمان', address: 'حي العليا، الرياض', phone: '0114773333' },
  { name: 'مستشفى الحرس الوطني', address: 'حي الشفاء، الرياض', phone: '0114774444' },
];

function generateEmployeeNames(count, rng) {
  const firstNames = ['محمد', 'أحمد', 'خالد', 'سعد', 'عبدالله', 'فهد', 'تركي', 'سلطان', 'نايف', 'سامي', 'هيثم', 'عوض', 'مبارك', 'وليد', 'عطاالله', 'فايز', 'بندر', 'ماجد', 'يوسف', 'إبراهيم', 'صالح', 'مطلق', 'نايف', 'عبدالعزيز', 'سعد', 'مشعل', 'شايع', 'خالد', 'بدر', 'سعود', 'عبدالرحمن', 'طلال', 'منصور', 'فهد', 'عبدالله', 'ماجد', 'محمد', 'صالح', 'عبدالله', 'فيصل'];
  const fatherNames = ['نايف', 'صنهات', 'حويكم', 'هذال', 'عتيق', 'معلا', 'خالد', 'عبدالعزيز', 'إبراهيم', 'يوسف', 'صالح', 'عناد', 'مبارك', 'هذال', 'خيرالله', 'اللحيدان', 'العمري', 'الحربي', 'العتيبي', 'العنزي', 'التميمي', 'الرويلي', 'الشمري', 'القحطاني', 'الغامدي', 'السهلي', 'الخالدي', 'الحربي', 'الصاعدي', 'المطيري'];
  const families = ['العتيبي', 'العنزي', 'التميمي', 'الرويلي', 'الشمري', 'القحطاني', 'الغامدي', 'السهلي', 'الخالدي', 'الحربي', 'الصاعدي', 'المطيري', 'العمري', 'اللحيدان', 'الحربي', 'العتيبي', 'العنزي', 'التميمي', 'الشمري', 'القحطاني'];
  const jobTitles = ['مسعف', 'مسعف أول', 'قائد فريق', 'مشرف', 'سائق', 'فني طوارئ', 'مسعف متدرب'];

  const employees = [];
  for (let i = 0; i < count; i++) {
    const fn = rng.pick(firstNames);
    const fath = rng.pick(fatherNames);
    const fam = rng.pick(families);
    employees.push({
      employee_code: String(4200 + i + 1),
      name: `${fn} ${fath} ${fam}`,
      phone: `05${rng.range(10000000, 99999999)}`,
      job_title: rng.pick(jobTitles),
      is_active: rng.chance(0.95) ? 1 : 0,
    });
  }
  return employees;
}

// ─── DATE HELPERS (Saudi timezone UTC+3) ───────────────────────────
function toSaudiDate(d) {
  const s = new Date(d.getTime() + (3 * 60 * 60 * 1000));
  return s.toISOString().split('T')[0];
}

function toArabicDate(d) {
  // Returns Arabic format like "١/٧/٢٠٢٦"
  const s = new Date(d.getTime() + (3 * 60 * 60 * 1000));
  const day = s.getDate();
  const month = s.getMonth() + 1;
  const year = s.getFullYear();
  return `${day}/${month}/${year}`;
}

function toArabicTime(d) {
  const s = new Date(d.getTime() + (3 * 60 * 60 * 1000));
  let h = s.getHours();
  const m = String(s.getMinutes()).padStart(2, '0');
  const isAm = h < 12;
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${isAm ? 'ص' : 'م'}`;
}

function getArabicDayName(d) {
  const s = new Date(d.getTime() + (3 * 60 * 60 * 1000));
  return ARABIC_DAYS[s.getDay()];
}

// ─── BACKUP ────────────────────────────────────────────────────────
async function backupFiles(config) {
  if (config.skipBackup) { await info('⚡ تم تخطي النسخ الاحتياطي'); return; }
  const ts = new Date().toISOString().replace(/[:T]/g, '-').split('.')[0];
  const backups = [];

  try {
    await fs.access(DB_PATH);
    const dbBackup = `${DB_PATH}.backup-${ts}`;
    await fs.copyFile(DB_PATH, dbBackup);
    backups.push(dbBackup);
    await info(`💾 نسخ احتياطي: ${path.basename(dbBackup)}`);
  } catch { await warn('لم يتم العثور على database.db'); }

  try {
    await fs.access(SHIFT_DATA_PATH);
    const shiftBackup = `${SHIFT_DATA_PATH}.backup-${ts}`;
    await fs.copyFile(SHIFT_DATA_PATH, shiftBackup);
    backups.push(shiftBackup);
    await info(`💾 نسخ احتياطي: ${path.basename(shiftBackup)}`);
  } catch { /* file may not exist */ }

  if (backups.length === 0) await warn('لم يتم إنشاء أي نسخ احتياطي');
}

// ─── DELETE DATA ───────────────────────────────────────────────────
async function deleteAllTestData(db, config) {
  if (!config.confirm) {
    await error('يجب إضافة --confirm لحذف البيانات');
    process.exit(1);
  }
  await info('🗑️  جاري حذف جميع البيانات التجريبية...');

  const tables = [
    'report_times', 'shift_reports', 'reports',
    'shift_forms', 'shift_completions', 'shift_timeline_events',
    'shift_alerts', 'shift_metrics', 'shift_audit_trail',
    'shift_audit_log', 'shift_roster_drafts', 'shift_change_requests',
    'shift_reports_generated', 'shift_comparison_snapshots',
    'shift_kpi_daily', 'shift_kpi_weekly', 'shift_kpi_monthly',
    'shift_roster', 'leave_requests', 'timeline', 'ops_files',
    'announcements', 'chat_messages', 'chat_participants', 'chat_conversations',
    'kb_chat_messages', 'kb_chat_sessions', 'kb_queries', 'kb_chat_history',
    'ai_chat_logs', 'ai_feedback', 'ai_unanswered_questions',
    'shift_schedule_auto', 'staffing_alerts'
  ];

  // Delete from child tables first (those without foreign keys to shifts)
  const deleteOrder = [
    'report_times', 'shift_reports',
    'shift_forms', 'shift_completions', 'shift_timeline_events',
    'shift_alerts', 'shift_metrics', 'shift_audit_trail',
    'shift_audit_log', 'shift_roster_drafts', 'shift_change_requests',
    'shift_reports_generated', 'shift_comparison_snapshots',
    'shift_kpi_daily', 'shift_kpi_weekly', 'shift_kpi_monthly',
    'shift_roster', 'leave_requests', 'timeline', 'ops_files',
    'announcements', 'chat_message_reads', 'chat_messages', 'chat_participants',
    'chat_conversations', 'kb_chat_messages', 'kb_chat_sessions',
    'kb_queries', 'kb_chat_history', 'ai_chat_logs', 'ai_feedback',
    'ai_unanswered_questions', 'ai_knowledge_chunks', 'shift_schedule_auto',
    'staffing_alerts', 'kb_chunks', 'kb_documents'
  ];

  for (const table of deleteOrder) {
    try {
      const result = await db.run(`DELETE FROM ${table}`);
      await verbose(config, `🗑️  حذف ${result.changes || 0} سجل من ${table}`);
    } catch (err) {
      await verbose(config, `⚠️  ${table}: ${err.message}`);
    }
  }

  // Also delete from shifts table
  try {
    const result = await db.run('DELETE FROM shifts');
    await verbose(config, `🗑️  حذف ${result.changes || 0} مناوبة من shifts`);
  } catch (err) {
    await verbose(config, `⚠️  shifts: ${err.message}`);
  }

  // Clear JSON files
  try {
    await fs.writeFile(SHIFT_DATA_PATH, '[]');
    await verbose(config, '🗑️  تم مسح shift-data.json');
  } catch { /* file may not exist */ }

  await success('تم حذف جميع البيانات التجريبية');
}

// ─── KPI UPSERT HELPERS ────────────────────────────────────────────
// These use INSERT OR REPLACE to handle duplicate keys gracefully
async function upsertKpiDaily(db, data) {
  return db.run(`INSERT OR REPLACE INTO shift_kpi_daily
    (date, total_shifts, total_reports, completed_reports, open_reports, suspended_reports,
     total_staff, total_teams, total_vehicles, completion_rate, avg_response_time, avg_closure_time,
     top_center, top_report_type, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [
    data.date, data.total_shifts, data.total_reports, data.completed_reports, data.open_reports,
    data.suspended_reports, data.total_staff, data.total_teams, data.total_vehicles,
    data.completion_rate, data.avg_response_time, data.avg_closure_time, data.top_center, data.top_report_type
  ]);
}

async function upsertKpiWeekly(db, data) {
  return db.run(`INSERT OR REPLACE INTO shift_kpi_weekly
    (week_start, week_end, total_shifts, total_reports, avg_daily_reports, peak_day, peak_day_count,
     lowest_day, lowest_day_count, completion_rate, total_operating_hours, total_staff, total_teams,
     total_vehicles, avg_staff_per_shift, comparison_last_week, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [
    data.week_start, data.week_end, data.total_shifts, data.total_reports, data.avg_daily_reports,
    data.peak_day, data.peak_day_count, data.lowest_day, data.lowest_day_count, data.completion_rate,
    data.total_operating_hours, data.total_staff, data.total_teams, data.total_vehicles,
    data.avg_staff_per_shift, data.comparison_last_week
  ]);
}

async function upsertKpiMonthly(db, data) {
  return db.run(`INSERT OR REPLACE INTO shift_kpi_monthly
    (month, year, total_shifts, total_reports, total_operating_hours, total_staff, total_teams,
     total_vehicles, morning_shifts, night_shifts, completion_rate, avg_performance,
     comparison_last_month, comparison_chart_data, calculated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`, [
    data.month, data.year, data.total_shifts, data.total_reports, data.total_operating_hours,
    data.total_staff, data.total_teams, data.total_vehicles, data.morning_shifts, data.night_shifts,
    data.completion_rate, data.avg_performance, data.comparison_last_month, data.comparison_chart_data
  ]);
}

// ─── MAIN GENERATOR ────────────────────────────────────────────────
async function main() {
  const config = parseArgs();

  if (config.help) { showHelp(); process.exit(0); }

  // Production safety check
  if (isProduction() && !config.forceProduction) {
    console.error(`
╔════════════════════════════════════════════════════════════════╗
║  ⚠️  تحذير: يبدو أنك في بيئة إنتاج!                           ║
║                                                                ║
║  هذا السكريبت مخصص للاستخدام المحلي فقط.                       ║
║  لتجاوز هذا التحذير (على مسؤوليتك):                            ║
║    node scripts/generate-test-data.js --force-production ...    ║
╚════════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  if (config.forceProduction) {
    await warn('⚠️  تم تجاوز حماية بيئة الإنتاج — استخدام على مسؤوليتك!');
  }

  // Initialize log file
  await fs.writeFile(LOG_PATH, `[${new Date().toISOString()}] Starting test data generator\n`).catch(() => {});
  await info('╔═══════════════════════════════════════════════════════════════╗');
  await info('║   🏥 منصة الجنوب — سكريبت توليد بيانات تجريبية              ║');
  await info('╚═══════════════════════════════════════════════════════════════╝');

  // Load DB module
  const dbModulePath = path.join(PROJECT_ROOT, 'db.js');
  let db;
  try {
    db = require(dbModulePath);
    await db.openDb();
    await db.init(false);
    await success('تم الاتصال بقاعدة البيانات');
  } catch (err) {
    await error(`فشل الاتصال بقاعدة البيانات: ${err.message}`);
    process.exit(1);
  }

  // Handle delete-only mode
  if (config.delete) {
    await backupFiles(config);
    await deleteAllTestData(db, config);
    await db.closeDb();
    process.exit(0);
  }

  // Backup before operations
  if (config.regenerate) {
    await backupFiles(config);
    await deleteAllTestData(db, config);
  } else {
    await backupFiles(config);
  }

  // Seeded random generator
  const rng = makeRandom(config.seed);

  // Determine date range
  const now = new Date();
  const saudiNow = new Date(now.getTime() + (3 * 60 * 60 * 1000));
  let startDate;
  if (config.startDate) {
    startDate = new Date(config.startDate + 'T05:00:00');
  } else {
    startDate = new Date(saudiNow);
    startDate.setDate(startDate.getDate() - config.days);
  }
  await info(`📅 الفترة: ${toSaudiDate(startDate)} إلى ${toSaudiDate(new Date(startDate.getTime() + (config.days - 1) * 86400000))} (${config.days} يوم)`);

  // ─── STEP 1: Seed reference data ───────────────────────────────
  await info('📦 جاري إنشاء البيانات المرجعية...');

  // Teams
  const existingTeams = await db.Teams.getAll();
  let teams = existingTeams;
  if (!teams || teams.length === 0) {
    await info('🏗️  إنشاء الفرق الافتراضية...');
    for (const t of TEAM_NAMES.slice(0, config.teams)) {
      await db.Teams.create(t);
    }
    teams = await db.Teams.getAll();
  } else {
    await info(`🏗️  الفرق موجودة مسبقًا: ${teams.length}`);
  }
  await verbose(config, `  الفرق: ${teams.length}`);

  // Employees
  const existingEmployees = await db.Employees.getAll();
  let employees = existingEmployees;
  if (!employees || employees.length === 0) {
    await info('👥 إنشاء الموظفين...');
    const newEmployees = generateEmployeeNames(config.employees, rng);
    for (const emp of newEmployees) {
      await db.Employees.create(emp);
    }
    employees = await db.Employees.getAll();
  } else {
    await info(`👥 الموظفون موجودون مسبقًا: ${employees.length}`);
  }
  await verbose(config, `  الموظفين: ${employees.length}`);

  // Shift Codes (seed if empty)
  const existingCodes = await db.ShiftCodes.getAll();
  if (!existingCodes || existingCodes.length === 0) {
    await info('🏷️  إنشاء رموز المناوبات الافتراضية...');
    const defaultCodes = [
      { code: 'D12', name: 'دوام 12 صباحاً', time_start: '05:00', time_end: '17:00', color: '#2563EB', status: 'دوام' },
      { code: 'N12', name: 'دوام 12 ليلاً', time_start: '17:00', time_end: '05:00', color: '#7C3AED', status: 'دوام' },
      { code: 'V', name: 'إجازة', color: '#EF4444', status: 'إجازة' },
      { code: 'M', name: 'مهمة', time_start: '00:00', time_end: '23:59', color: '#F59E0B', status: 'دوام' },
      { code: 'D8', name: 'دوام 8 صباحاً', time_start: '07:00', time_end: '15:00', color: '#2563EB', status: 'دوام' },
      { code: 'N8', name: 'دوام 8 ليلاً', time_start: '22:00', time_end: '06:00', color: '#7C3AED', status: 'دوام' },
    ];
    for (const sc of defaultCodes) {
      try { await db.ShiftCodes.create(sc); } catch { /* may already exist */ }
    }
  }

  // Hospitals
  const existingHospitals = await db.Hospitals.getAll();
  if (!existingHospitals || existingHospitals.length === 0) {
    await info('🏥 إنشاء المستشفيات...');
    for (const h of HOSPITAL_NAMES.slice(0, config.hospitals)) {
      await db.Hospitals.create({ ...h, type: 'عام', specialty: 'طوارئ', emergency: 'نعم', hours: '24 ساعة', lat: 24.5 + rng.next() * 0.5, lng: 46.5 + rng.next() * 0.5 });
    }
  }

  // ─── STEP 2: Generate daily data ───────────────────────────────
  await info('📊 جاري إنشاء بيانات المناوبات...');

  const allShifts = [];
  const shiftSummaries = [];
  const dailyReportCounts = [];
  let totalReports = 0;

  for (let dayIndex = 0; dayIndex < config.days; dayIndex++) {
    const currentDate = new Date(startDate.getTime() + dayIndex * 86400000);
    const dateStr = toSaudiDate(currentDate);
    const arabicDate = toArabicDate(currentDate);
    const dayName = getArabicDayName(currentDate);

    await info(`📅 يوم ${dayIndex + 1}/${config.days}: ${dateStr} (${dayName})`);

    // Create shifts for this day (morning + night)
    for (let shiftIndex = 0; shiftIndex < config.shiftsPerDay; shiftIndex++) {
      const isMorning = shiftIndex === 0;
      const shiftType = isMorning ? 'صباحية' : 'ليلية';
      const shiftHour = isMorning ? 5 : 17;
      const shiftStart = new Date(currentDate);
      shiftStart.setHours(shiftHour, 0, 0, 0);
      const shiftEnd = new Date(shiftStart.getTime() + 12 * 60 * 60 * 1000);
      const shiftIdBase = Date.now() + dayIndex * 10000 + shiftIndex * 1000 + rng.range(1, 999);

      // 1. Create Shift in SQLite
      const shiftRecord = {
        shiftName: `${shiftType} - ${arabicDate} ${toArabicTime(shiftStart)}`,
        shiftDate: arabicDate,
        shiftTime: toArabicTime(shiftStart),
        shiftType: shiftType,
        shiftDay: dayName,
        startTime: shiftStart.toISOString(),
        totalReports: 0,
        rapidLocations: {},
        centersData: {},
        vehicleData: {},
        fuelData: {},
        generalNotes: '',
        lastUpdate: shiftStart.toISOString(),
      };

      const shiftId = await db.Shifts.create(shiftRecord);

      // 2. Build rapidLocations and centersData
      const rapidLocations = {};
      const centersData = {};
      const vehicleData = {};
      const fuelData = {};

      // Assign rapid teams
      const rapidTeams = ['سريع 1', 'سريع 2', 'سريع 3', 'سريع 4'];
      for (const rt of rapidTeams) {
        const teamInfo = TEAM_NAMES.find(t => t.name === rt);
        rapidLocations[rt] = teamInfo ? teamInfo.center : '';
      }

      // Build centers data for all teams
      for (const t of teams) {
        const staffCount = rng.range(1, 3);
        const carsCount = rng.range(1, 2);
        const status = rng.chance(0.9) ? '✅ مكتمل' : rng.pick(['⚠️ ناقص', '⏳ قيد التجهيز']);
        centersData[t.name] = {
          staffCount: String(staffCount),
          carsCount: String(carsCount),
          notes: status,
          vehicleStatus: '',
          fuelLevel: ''
        };

        // Vehicle data
        const teamVehicles = {};
        for (let v = 0; v < carsCount; v++) {
          const vName = rng.pick(VEHICLE_NAMES);
          teamVehicles[vName] = {
            status: rng.chance(0.85) ? 'متواجد' : rng.pick(['في مهمة', 'صيانة']),
            fuel: `${rng.range(30, 100)}%`
          };
        }
        vehicleData[t.name] = teamVehicles;
        fuelData[t.name] = {};
        for (const vName of Object.keys(teamVehicles)) {
          fuelData[t.name][vName] = teamVehicles[vName].fuel;
        }
      }

      // 3. Generate Reports
      const reportCount = config.reportsPerShift || rng.range(5, 15);
      const reportsForShift = [];
      const reportsObj = {};

      for (let r = 0; r < reportCount; r++) {
        const team = rng.pick(teams);
        const reportType = rng.pick(REPORT_TYPES);
        const count = rng.range(1, 3);
        const key = `${team.center}|${team.name}`;

        const reportId = await db.Reports.create(team.center, team.name, count, shiftId);
        reportsForShift.push({ id: reportId, center: team.center, unit: team.name, count, type: reportType });

        // Report times
        const numTimes = rng.range(1, 3);
        for (let t = 0; t < numTimes; t++) {
          const reportTime = new Date(shiftStart.getTime() + rng.range(30, 660) * 60000); // 30min - 11hr into shift
          await db.Reports.addTime(reportId, reportTime.toISOString());
        }

        if (!reportsObj[key]) {
          reportsObj[key] = { count: 0, times: [] };
        }
        reportsObj[key].count += count;
      }

      // Save shift_reports summary
      for (const [key, data] of Object.entries(reportsObj)) {
        const [center, unit] = key.split('|');
        await db.Shifts.addShiftReport(shiftId, center, unit, data.count, data.times);
      }

      // 4. Shift Completions (Radio / Takmeel)
      const teamsData = {};
      for (const t of teams) {
        teamsData[t.name] = {
          staffCount: centersData[t.name].staffCount,
          carsCount: centersData[t.name].carsCount,
          status: 'متواجد',
          notes: centersData[t.name].notes
        };
      }

      await db.ShiftCompletions.create({
        shift_type: shiftType,
        shift_date: toSaudiDate(currentDate),
        shift_id: shiftId,
        teams_data: JSON.stringify(teamsData),
        notes: rng.pick([
          'تم استلام الفرق بنجاح وكل المركبات جاهزة',
          'زيادة في البلاغات خلال وقت الذروة',
          'تم تسجيل بلاغ إسعاف متقدم في مركز ' + rng.pick(CENTERS),
          'تم إغلاق جميع البلاغات المعلقة',
          'تأخر في وصول فرق ' + rng.pick(teams.map(t => t.name)) + ' بسبب الازدحام',
          'تم تفعيل خطة الطوارئ في مركز ' + rng.pick(CENTERS),
          'تم تسليم المناوبة للفريق الليلي بنجاح',
        ]),
        created_by: 'admin',
        created_at: shiftEnd.toISOString()
      });

      // 5. Shift Forms
      const formCount = config.formsPerShift || rng.range(1, 3);
      const formTypes = ['E', 'incident', 'escalation', 'daily'];
      for (let f = 0; f < formCount; f++) {
        const fType = rng.pick(formTypes);
        const formNames = {
          'E': 'بلاغ إسعاف متقدم (E)',
          'incident': 'بلاغ حادث',
          'escalation': 'تصعيد حالة',
          'daily': 'تقرير يومي'
        };
        await db.ShiftForms.create({
          shift_id: shiftId,
          form_id: `FORM-${shiftId}-${f + 1}`,
          form_name: formNames[fType] || 'نموذج تشغيلي',
          form_data: JSON.stringify({
            type: fType,
            reporter: rng.pick(employees.map(e => e.name)),
            location: rng.pick(CENTERS),
            description: `حالة ${rng.pick(REPORT_TYPES)} في ${rng.pick(CENTERS)}`,
            status: rng.chance(0.8) ? 'مكتمل' : 'قيد المعالجة',
            created_at: new Date(shiftStart.getTime() + rng.range(60, 600) * 60000).toISOString()
          }),
          created_by: 'admin'
        });
      }

      // 6. Timeline Events
      const timelineEvents = [
        { title: 'بداية المناوبة', desc: `تم بدء المناوبة ${shiftType} بنجاح`, type: 'عمليات', timeOffset: 0 },
        { title: 'استلام الفرق', desc: 'تم استلام جميع الفرق وتجهيز المركبات', type: 'عمليات', timeOffset: 30 },
        { title: 'بلاغ وارد', desc: `بلاغ ${rng.pick(REPORT_TYPES)} في ${rng.pick(CENTERS)}`, type: 'بلاغ', timeOffset: rng.range(45, 120) },
        { title: 'إغلاق البلاغ', desc: 'تم إغلاق البلاغ ونقل المصاب', type: 'بلاغ', timeOffset: rng.range(90, 180) },
        { title: 'ملاحظة تشغيلية', desc: rng.pick(['كل المركبات جاهزة', 'تأخر في وصول فرق', 'زيادة البلاغات']), type: 'ملاحظة', timeOffset: rng.range(200, 400) },
      ];

      const eventCount = config.timelineEventsPerShift || rng.range(3, Math.min(8, timelineEvents.length));
      for (let e = 0; e < eventCount; e++) {
        const evt = timelineEvents[e];
        const evtTime = new Date(shiftStart.getTime() + evt.timeOffset * 60000);
        await db.Timeline.create({
          title: evt.title,
          desc: evt.desc,
          type: evt.type,
          date: toSaudiDate(evtTime),
          time: `${String(evtTime.getHours()).padStart(2, '0')}:${String(evtTime.getMinutes()).padStart(2, '0')}`,
          shift_id: shiftId
        });

        // Also add to new timeline events table
        const eventTypeMap = {
          'بداية المناوبة': 'start',
          'استلام الفرق': 'team_checkin',
          'بلاغ وارد': 'report_received',
          'إغلاق البلاغ': 'report_completed',
          'ملاحظة تشغيلية': 'note_added'
        };
        await db.ShiftTimelineEvents.create({
          shift_id: shiftId,
          event_type: eventTypeMap[evt.title] || 'note_added',
          event_title: evt.title,
          event_description: evt.desc,
          event_data: JSON.stringify({ type: evt.type }),
          event_time: evtTime.toISOString(),
          created_by: 'admin',
          created_by_name: 'مدير النظام'
        });
      }

      // 7. Shift Audit Trail
      const auditActions = [
        { type: 'created', detail: 'إنشاء المناوبة', actor: 'admin' },
        { type: 'data_added', detail: 'إضافة بلاغ جديد', actor: '4252' },
        { type: 'data_updated', detail: 'تحديث بيانات التكميل', actor: 'director' },
        { type: 'data_added', detail: 'إضافة نموذج تشغيلي', actor: 'admin' },
      ];
      const auditCount = rng.range(2, Math.min(5, auditActions.length));
      for (let a = 0; a < auditCount; a++) {
        const act = auditActions[a];
        await db.ShiftAuditTrail.create({
          shift_id: shiftId,
          action_type: act.type,
          actor_id: act.actor,
          actor_name: act.actor === 'admin' ? 'مدير النظام' : (act.actor === 'director' ? 'مدير العمليات' : 'مسؤول'),
          actor_role: act.actor === 'admin' ? 'admin' : 'director',
          action_detail: act.detail,
          old_data: act.type === 'data_updated' ? JSON.stringify({ notes: '' }) : null,
          new_data: JSON.stringify({ notes: 'تم التحديث' }),
          ip_address: '127.0.0.1',
          user_agent: 'Test Generator'
        });
      }

      // 8. Shift Metrics (calculate after all data)
      const completedReports = Math.floor(reportCount * 0.7);
      const pendingReports = Math.floor(reportCount * 0.2);
      const suspendedReports = reportCount - completedReports - pendingReports;
      const completionRate = reportCount > 0 ? (completedReports / reportCount) * 100 : 0;
      const avgResponse = 5 + rng.next() * 10; // 5-15 minutes
      const avgClosure = 20 + rng.next() * 20; // 20-40 minutes
      const healthScore = 70 + rng.next() * 25; // 70-95
      const dataCompleteness = 80 + rng.next() * 20; // 80-100%

      await db.ShiftMetrics.create({
        shift_id: shiftId,
        total_reports: reportCount,
        completed_reports: completedReports,
        pending_reports: pendingReports,
        suspended_reports: Math.max(0, suspendedReports),
        total_completions: teams.length,
        total_forms: formCount,
        staff_count: employees.length,
        team_count: teams.length,
        vehicle_count: teams.length * config.vehiclesPerTeam,
        completion_rate: parseFloat(completionRate.toFixed(2)),
        avg_response_time: parseFloat(avgResponse.toFixed(2)),
        avg_closure_time: parseFloat(avgClosure.toFixed(2)),
        critical_cases: rng.range(0, 3),
        health_score: parseFloat(healthScore.toFixed(2)),
        data_completeness: parseFloat(dataCompleteness.toFixed(2)),
        notes_count: eventCount,
        event_count: eventCount,
      });

      // 9. Shift Alerts
      const alertConfigs = [
        { type: 'high_pending', severity: 'warning', msg: 'عدد البلاغات المعلقة مرتفع', reason: 'زيادة الحوادث المرورية' },
        { type: 'low_completion', severity: 'warning', msg: 'نسبة إنجاز البلاغات منخفضة', reason: 'نقص في الكوادر' },
        { type: 'staff_shortage', severity: 'info', msg: 'تغطية الفرق كاملة', reason: null },
        { type: 'workload_spike', severity: rng.chance(0.3) ? 'critical' : 'warning', msg: 'ضغط عمل غير مسبوق', reason: 'حادث مروري كبير' },
      ];
      const alertCount = rng.range(1, 3);
      for (let al = 0; al < alertCount; al++) {
        const ac = alertConfigs[al];
        await db.ShiftAlerts.create({
          shift_id: shiftId,
          alert_type: ac.type,
          severity: ac.severity,
          message: ac.msg,
          suggested_reason: ac.reason,
          is_acknowledged: rng.chance(0.5) ? 1 : 0,
          acknowledged_by: rng.chance(0.5) ? 'admin' : null,
          acknowledged_at: rng.chance(0.5) ? new Date(shiftStart.getTime() + rng.range(60, 300) * 60000).toISOString() : null,
        });
      }

      // 10. Shift Roster
      const rosterShiftCode = isMorning ? 'D12' : 'N12';
      const rosterCount = rng.range(5, Math.min(15, employees.length));
      for (let ro = 0; ro < rosterCount; ro++) {
        const emp = rng.pick(employees);
        const team = rng.pick(teams);
        await db.ShiftRoster.create({
          employee_id: emp.id,
          team_id: team.id,
          shift_date: toSaudiDate(currentDate),
          shift_code: rng.chance(0.9) ? rosterShiftCode : rng.pick(['V', 'M', 'D8', 'N8']),
          month: currentDate.getMonth() + 1,
          year: currentDate.getFullYear()
        });
      }

      // 11. Notifications
      const notifCount = rng.range(2, 4);
      for (let n = 0; n < notifCount; n++) {
        const emp = rng.pick(employees);
        await db.NotificationLog.create({
          notification_type: 'shift_change',
          recipient_id: emp.id,
          recipient_name: emp.name,
          recipient_phone: emp.phone,
          message: `تم تعديل مناوبتك ليوم ${arabicDate}`,
          channel: 'in-app',
          status: rng.pick(['sent', 'delivered', 'read']),
          shift_date: toSaudiDate(currentDate),
          old_value: isMorning ? 'N12' : 'D12',
          new_value: rosterShiftCode,
        });
      }

      // 12. Announcements (1 per day, only for first shift)
      if (shiftIndex === 0 && rng.chance(0.7)) {
        await db.Announcements.create({
          id: `ANN-${shiftId}`,
          title: rng.pick(['تنبيه تشغيلي', 'تحديث إجراءات', 'إشعار عاجل', 'تعليمات جديدة']),
          body: rng.pick([
            'يرجى الالتزام بإجراءات السلامة أثناء التعامل مع الحالات الحرجة',
            'تم تحديث قائمة المستشفيات المشاركة في خطة الطوارئ',
            'تنبيه: زيادة الحوادث المرورية المتوقعة خلال فترة الذروة',
            'تم اعتماد إجراءات جديدة للتعامل مع حالات التسمم'
          ]),
          date: toSaudiDate(currentDate),
          pinned: rng.chance(0.3) ? 1 : 0,
          urgent: rng.chance(0.2) ? 1 : 0,
          shift_id: shiftId
        });
      }

      // 13. Ops Files
      if (rng.chance(0.6)) {
        await db.OpsFiles.create({
          id: `FILE-${shiftId}`,
          filename: `تقرير-${shiftType}-${toSaudiDate(currentDate)}.pdf`,
          stored_name: `report-${shiftType}-${toSaudiDate(currentDate)}.pdf`,
          size: rng.range(500000, 2000000),
          mime_type: 'application/pdf',
          upload_date: toSaudiDate(shiftEnd),
          uploader: 'admin',
          category: 'تقارير',
          note: `تقرير المناوبة ${shiftType}`,
          shift_id: shiftId
        });
      }

      // 14. Leave Requests
      if (shiftIndex === 0 && rng.chance(0.4)) {
        const emp = rng.pick(employees);
        const leaveEnd = new Date(currentDate);
        leaveEnd.setDate(leaveEnd.getDate() + rng.range(1, 3));
        await db.LeaveRequests.create({
          employee_id: emp.id,
          start_date: toSaudiDate(currentDate),
          end_date: toSaudiDate(leaveEnd),
          type: rng.pick(['إجازة', 'مرضية', 'استثنائية']),
          status: rng.pick(['approved', 'pending', 'denied']),
          reason: 'ظروف شخصية',
          approved_by: 1,
          approved_at: rng.chance(0.7) ? new Date().toISOString() : null
        });
      }

      // 15. Update shift JSON record
      const shiftJsonRecord = {
        id: shiftId,
        shiftName: shiftRecord.shiftName,
        shiftDate: arabicDate,
        shiftTime: shiftRecord.shiftTime,
        shiftType: shiftType,
        shiftDay: dayName,
        startTime: shiftRecord.startTime,
        totalReports: reportCount,
        savedReports: reportsObj,
        rapidLocations: rapidLocations,
        centersData: centersData,
        vehicleData: vehicleData,
        fuelData: fuelData,
        generalNotes: '',
        lastUpdate: shiftRecord.lastUpdate,
      };
      allShifts.push(shiftJsonRecord);
      shiftSummaries.push({ id: shiftId, date: toSaudiDate(currentDate), type: shiftType, reports: reportCount });
      totalReports += reportCount;
    }

    dailyReportCounts.push({ date: toSaudiDate(currentDate), count: totalReports - (dailyReportCounts.reduce((a, b) => a + b.count, 0)) });
  }

  // Save shifts to JSON file
  await fs.writeFile(SHIFT_DATA_PATH, JSON.stringify(allShifts, null, 2));
  await success('تم حفظ المناوبات في shift-data.json');

  // ─── STEP 3: Generate Aggregated KPIs ──────────────────────────
  await info('📈 جاري حساب المؤشرات المجمعة...');

  // Daily KPIs
  const uniqueDates = [...new Set(shiftSummaries.map(s => s.date))].sort();
  for (const dateStr of uniqueDates) {
    const dayShifts = shiftSummaries.filter(s => s.date === dateStr);
    const dayReports = dayShifts.reduce((sum, s) => sum + s.reports, 0);
    const allDayReports = await db.all('SELECT * FROM reports WHERE shift_id IN (SELECT id FROM shifts WHERE shift_date = ?)', [dateStr]);
    const completed = Math.floor(dayReports * 0.7);
    const pending = Math.floor(dayReports * 0.2);
    const suspended = dayReports - completed - pending;

    await upsertKpiDaily(db, {
      date: dateStr,
      total_shifts: dayShifts.length,
      total_reports: dayReports,
      completed_reports: completed,
      open_reports: pending,
      suspended_reports: Math.max(0, suspended),
      total_staff: employees.length,
      total_teams: teams.length,
      total_vehicles: teams.length * config.vehiclesPerTeam,
      completion_rate: dayReports > 0 ? parseFloat(((completed / dayReports) * 100).toFixed(2)) : 0,
      avg_response_time: parseFloat((5 + rng.next() * 10).toFixed(2)),
      avg_closure_time: parseFloat((20 + rng.next() * 20).toFixed(2)),
      top_center: rng.pick(CENTERS),
      top_report_type: rng.pick(REPORT_TYPES),
    });
  }
  await verbose(config, `  المؤشرات اليومية: ${uniqueDates.length}`);

  // Weekly KPIs
  if (config.days >= 7) {
    const weekStart = uniqueDates[0];
    const weekEnd = uniqueDates[Math.min(6, uniqueDates.length - 1)];
    const weekShifts = shiftSummaries.filter(s => s.date >= weekStart && s.date <= weekEnd);
    const weekReports = weekShifts.reduce((sum, s) => sum + s.reports, 0);
    const peakDay = weekShifts.reduce((max, s) => s.reports > max.reports ? s : max, weekShifts[0]);
    const lowestDay = weekShifts.reduce((min, s) => s.reports < min.reports ? s : min, weekShifts[0]);

    await upsertKpiWeekly(db, {
      week_start: weekStart,
      week_end: weekEnd,
      total_shifts: weekShifts.length,
      total_reports: weekReports,
      avg_daily_reports: parseFloat((weekReports / 7).toFixed(2)),
      peak_day: peakDay ? peakDay.date : weekStart,
      peak_day_count: peakDay ? peakDay.reports : 0,
      lowest_day: lowestDay ? lowestDay.date : weekEnd,
      lowest_day_count: lowestDay ? lowestDay.reports : 0,
      completion_rate: weekReports > 0 ? parseFloat(((weekShifts.reduce((sum, s) => sum + Math.floor(s.reports * 0.7), 0) / weekReports) * 100).toFixed(2)) : 0,
      total_operating_hours: weekShifts.length * 12,
      total_staff: employees.length,
      total_teams: teams.length,
      total_vehicles: teams.length * config.vehiclesPerTeam,
      avg_staff_per_shift: parseFloat((employees.length / (weekShifts.length || 1)).toFixed(2)),
      comparison_last_week: 0,
    });
    await verbose(config, `  المؤشرات الأسبوعية: 1`);
  }

  // Monthly KPIs
  const months = {};
  for (const s of shiftSummaries) {
    const d = new Date(s.date + 'T00:00:00');
    const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
    if (!months[key]) months[key] = [];
    months[key].push(s);
  }
  for (const [key, monthShifts] of Object.entries(months)) {
    const [year, month] = key.split('-').map(Number);
    const monthReports = monthShifts.reduce((sum, s) => sum + s.reports, 0);
    const morningCount = monthShifts.filter(s => s.type === 'صباحية').length;
    const nightCount = monthShifts.filter(s => s.type === 'ليلية').length;

    await upsertKpiMonthly(db, {
      month: month,
      year: year,
      total_shifts: monthShifts.length,
      total_reports: monthReports,
      total_operating_hours: monthShifts.length * 12,
      total_staff: employees.length,
      total_teams: teams.length,
      total_vehicles: teams.length * config.vehiclesPerTeam,
      morning_shifts: morningCount,
      night_shifts: nightCount,
      completion_rate: monthReports > 0 ? parseFloat(((monthShifts.reduce((sum, s) => sum + Math.floor(s.reports * 0.7), 0) / monthReports) * 100).toFixed(2)) : 0,
      avg_performance: parseFloat((70 + rng.next() * 25).toFixed(2)),
      comparison_last_month: 0,
      comparison_chart_data: JSON.stringify({ labels: monthShifts.map(s => s.date), data: monthShifts.map(s => s.reports) }),
    });
  }
  await verbose(config, `  المؤشرات الشهرية: ${Object.keys(months).length}`);

  // ─── STEP 4: Generate Comparison Snapshots ─────────────────────
  if (allShifts.length >= 2) {
    const shiftA = allShifts[0];
    const shiftB = allShifts[allShifts.length > 2 ? 1 : 0];
    await db.ShiftComparisonSnapshots.create({
      comparison_name: 'مقارنة المناوبة الصباحية والليلية',
      shift_a_id: shiftA.id,
      shift_b_id: shiftB.id,
      shift_a_date: shiftA.shiftDate,
      shift_b_date: shiftB.shiftDate,
      comparison_data: JSON.stringify({
        a_reports: shiftA.totalReports,
        b_reports: shiftB.totalReports,
        a_staff: teams.length,
        b_staff: teams.length,
        a_teams: teams.length,
        b_teams: teams.length,
        a_hours: 12,
        b_hours: 12,
      }),
      created_by: 'admin',
    });
    await verbose(config, '  المقارنات: 1');
  }

  // ─── STEP 5: Close database ────────────────────────────────────
  await db.closeDb();

  // ─── FINAL SUMMARY ─────────────────────────────────────────────
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalShifts = allShifts.length;
  const totalEmployees = employees.length;
  const totalTeams = teams.length;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           ✅ تم إنشاء بيانات تجريبية بنجاح                     ║
╠══════════════════════════════════════════════════════════════════╣
║  📅 الفترة:        ${String(toSaudiDate(startDate)).padEnd(40)} ║
║  📊 الأيام:        ${String(config.days).padEnd(40)} ║
║  🔄 المناوبات:     ${String(totalShifts).padEnd(40)} ║
║  📋 البلاغات:      ${String(totalReports).padEnd(40)} ║
║  👥 الموظفين:      ${String(totalEmployees).padEnd(40)} ║
║  🏗️  الفرق:         ${String(totalTeams).padEnd(40)} ║
║  🚗 المركبات:      ${String(totalTeams * config.vehiclesPerTeam).padEnd(40)} ║
║  📻 التكميلات:     ${String(totalShifts).padEnd(40)} ║
║  📝 النماذج:        ${String(totalShifts * (config.formsPerShift || 2)).padEnd(40)} ║
║  📌 الأحداث:       ${String(totalShifts * (config.timelineEventsPerShift || 5)).padEnd(40)} ║
║  🔍 سجل المراجعة:  ${String(totalShifts * 3).padEnd(40)} ║
║  📈 المؤشرات:      ${String(totalShifts).padEnd(40)} ║
║  ⚠️  التنبيهات:     ${String(totalShifts * 2).padEnd(40)} ║
║  🔔 الإشعارات:     ${String(totalShifts * 3).padEnd(40)} ║
║  📢 الإعلانات:     ${String(config.days).padEnd(40)} ║
║  🏥 المستشفيات:    ${String(config.hospitals).padEnd(40)} ║
╠══════════════════════════════════════════════════════════════════╣
║  ⏱️  الوقت المستغرق: ${String(duration + ' ثانية').padEnd(38)} ║
╚══════════════════════════════════════════════════════════════════╝
`);

  await success(`اكتمل التوليد في ${duration} ثانية`);
  await info(`📄 سجل العمليات: ${LOG_PATH}`);
  process.exit(0);
}

const startTime = Date.now();
main().catch(async (err) => {
  await error(`خطأ فادح: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
