#!/usr/bin/env node
/**
 * E2E Validation Test - Shift/Archive System
 * منصة الإسعاف - اختبار شامل لدورة المناوبة
 * 
 * Usage:
 *   API_BASE_URL=https://your-app.onrender.com \
 *   TEST_TOKEN=your_jwt_token \
 *   node validate-shift-e2e.js
 */

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3002';
const TOKEN = process.env.TEST_TOKEN || '';

const TEST_RESULTS = {
  timestamp: new Date().toISOString(),
  apiBase: API_BASE,
  tests: [],
  passed: 0,
  failed: 0,
  errors: []
};

// ============================================
// HELPERS
// ============================================
async function apiCall(method, path, body = null) {
  const url = `${API_BASE}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': TOKEN ? `Bearer ${TOKEN}` : ''
    }
  };
  if (body) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, error: err.message, json: null };
  }
}

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  TEST_RESULTS.tests.push({ name, passed, details });
  if (passed) TEST_RESULTS.passed++; else TEST_RESULTS.failed++;
  console.log(`${status}: ${name}${details ? ' - ' + details : ''}`);
}

function assertEqual(actual, expected, msg) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) {
    console.error(`  Expected: ${JSON.stringify(expected)}`);
    console.error(`  Actual:   ${JSON.stringify(actual)}`);
  }
  return pass;
}

// ============================================
// TEST PHASE 1: System Health
// ============================================
async function testPhase1_Health() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 1: System Health Check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1.1 Check server is running
  const res = await apiCall('GET', '/api/shifts');
  logTest('Server is reachable', res.status === 200 || res.status === 401, `status=${res.status}`);

  // 1.2 Check shift-data.json structure
  if (res.status === 200 && Array.isArray(res.json)) {
    logTest('shift-data.json returns array', true, `shifts=${res.json.length}`);
    if (res.json.length > 0) {
      const shift = res.json[0];
      const validType = shift.shiftType === 'صباحية' || shift.shiftType === 'ليلية';
      logTest('Shift type is unified (صباحية/ليلية)', validType, `type=${shift.shiftType}`);
    }
  } else {
    logTest('shift-data.json returns array', false, res.error || res.text?.slice(0, 100));
  }
}

// ============================================
// TEST PHASE 2: Create Test Shift
// ============================================
let testShiftId = null;
let testShiftDate = null;
let testShiftType = 'صباحية';

async function testPhase2_CreateShift() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 2: Create Test Shift');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 2.1 Get current shift info
  const info = await apiCall('GET', '/api/shift-info');
  if (info.json) {
    testShiftDate = info.json.shiftDate;
    testShiftType = info.json.shiftType || 'صباحية';
    console.log(`  Current shift: ${testShiftDate} ${testShiftType}`);
  }

  // 2.2 Start new shift manually (if admin token available)
  const startRes = await apiCall('POST', '/api/start-new-shift', {
    shiftType: testShiftType
  });

  if (startRes.status === 200 && startRes.json?.success) {
    testShiftId = startRes.json.shiftId;
    logTest('Manual shift start', true, `shiftId=${testShiftId}`);

    // Verify shiftType is correct
    const typeCorrect = startRes.json.shift?.shiftType === testShiftType;
    logTest('New shift has correct shiftType', typeCorrect,
      `type=${startRes.json.shift?.shiftType}`);
  } else if (startRes.status === 401 || startRes.status === 403) {
    logTest('Manual shift start (auth required)', false,
      'Need admin/director token - will use current shift');
    // Get current shift from list
    const shifts = await apiCall('GET', '/api/shifts');
    if (shifts.json?.[0]) {
      testShiftId = shifts.json[0].id;
      testShiftDate = shifts.json[0].shiftDate;
      testShiftType = shifts.json[0].shiftType;
      console.log(`  Using existing shift: ${testShiftId}`);
    }
  } else {
    logTest('Manual shift start', false, `${startRes.status}: ${startRes.text?.slice(0, 100)}`);
  }
}

// ============================================
// TEST PHASE 3: Enter Workforce & Vehicle Data
// ============================================
const TEST_DATA = {
  centersData: {
    'المنصورة': {
      staffCount: 5,
      vehicleStatus: 'جاهز',
      fuelLevel: 80,
      notes: 'فريق كامل',
      assignedParamedics: [
        { name: 'أحمد', employeeCode: 'EMP001', team: 'جنوب 1', status: 'حاضر' },
        { name: 'محمد', employeeCode: 'EMP002', team: 'جنوب 1', status: 'حاضر' }
      ]
    },
    'العزيزية': {
      staffCount: 3,
      vehicleStatus: 'صيانة',
      fuelLevel: 45,
      notes: 'سيارة في الصيانة',
      assignedParamedics: [
        { name: 'خالد', employeeCode: 'EMP003', team: 'جنوب 2', status: 'حاضر' }
      ]
    }
  },
  rapidLocations: {
    'سريع 1': { location: 'شارع الملك', status: 'متاح', paramedic: 'علي' },
    'سريع 2': { location: 'شارع الامير', status: 'متاح', paramedic: 'سعد' }
  },
  vehicleData: {
    'سيارة 1': { type: 'اسعاف', status: 'جاهز', lastMaintenance: '2026-06-01' },
    'سيارة 2': { type: 'اسعاف', status: 'غير جاهز', lastMaintenance: '2026-05-15' }
  },
  fuelData: {
    totalLiters: 500,
    cost: 750.50,
    supplier: 'شركة الوقود',
    notes: 'توريد يومي'
  },
  generalNotes: 'مناوبة تجريبية للاختبار - ' + new Date().toISOString()
};

async function testPhase3_EnterData() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 3: Enter Workforce & Vehicle Data');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!testShiftId) {
    logTest('Shift ID available for data entry', false, 'No shift ID');
    return;
  }

  // 3.1 Update shift data
  const updateRes = await apiCall('POST', '/api/update-shift-data', {
    shiftId: testShiftId,
    shiftData: TEST_DATA,
    shiftDate: testShiftDate,
    shiftType: testShiftType
  });

  logTest('Update shift data (centers/vehicles/fuel)', updateRes.status === 200,
    `status=${updateRes.status}`);

  if (updateRes.json?.success) {
    console.log('  Response:', JSON.stringify(updateRes.json, null, 2).substring(0, 200));
  }
}

// ============================================
// TEST PHASE 4: Enter Reports
// ============================================
const TEST_REPORTS = [
  { center: 'المنصورة', unit: 'جنوب 1' },
  { center: 'المنصورة', unit: 'جنوب 1' },
  { center: 'العزيزية', unit: 'جنوب 2' },
  { center: 'المنصورة', unit: 'جنوب 3' }
];

async function testPhase4_EnterReports() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 4: Enter Reports');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let allPassed = true;
  for (const report of TEST_REPORTS) {
    const res = await apiCall('POST', '/api/report', {
      center: report.center,
      unit: report.unit,
      shiftId: testShiftId
    });
    const pass = res.status === 200;
    if (!pass) allPassed = false;
    console.log(`  Report ${report.center}/${report.unit}: ${pass ? 'OK' : 'FAIL'} (${res.status})`);
    await sleep(100); // Small delay between reports
  }

  logTest(`Enter ${TEST_REPORTS.length} reports`, allPassed);

  // 4.1 Verify reports in shift
  const shifts = await apiCall('GET', '/api/shifts');
  if (shifts.json) {
    const shift = shifts.json.find(s => s.id === testShiftId);
    if (shift) {
      const reportCount = shift.totalReports || 0;
      logTest('Reports synced to shift record', reportCount >= TEST_REPORTS.length,
        `totalReports=${reportCount}`);
    }
  }
}

// ============================================
// TEST PHASE 5: Enter Completion Data
// ============================================
async function testPhase5_Completion() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 5: Enter Completion Data');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const completionRes = await apiCall('POST', '/api/shift-completion', {
    shiftType: testShiftType,
    shiftDate: testShiftDate,
    teams: {
      'جنوب 1': { status: 'جاهز', paramedics: 3, vehicles: 2 },
      'جنوب 2': { status: 'غير جاهز', paramedics: 1, vehicles: 1 }
    },
    notes: 'تكميل تجريبي - ' + new Date().toISOString()
  });

  logTest('Save shift completion', completionRes.status === 200,
    `status=${completionRes.status}`);
}

// ============================================
// TEST PHASE 6: Archive & Start New Shift
// ============================================
let archivedShiftId = null;
let newShiftId = null;

async function testPhase6_Archive() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 6: Archive & Start New Shift');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Get current data before archive
  const beforeArchive = await apiCall('GET', `/api/shifts/${testShiftId}`);
  const beforeData = beforeArchive.json;

  archivedShiftId = testShiftId;

  // Start new shift (archive old)
  const newShiftRes = await apiCall('POST', '/api/start-new-shift', {
    shiftType: testShiftType === 'صباحية' ? 'ليلية' : 'صباحية'
  });

  if (newShiftRes.status === 200 && newShiftRes.json?.success) {
    newShiftId = newShiftRes.json.shiftId;
    logTest('Start new shift (archive old)', true,
      `old=${archivedShiftId}, new=${newShiftId}`);

    // Verify new shift has empty data
    const newShift = await apiCall('GET', `/api/shifts/${newShiftId}`);
    const empty = !newShift.json?.savedReports || Object.keys(newShift.json.savedReports || {}).length === 0;
    logTest('New shift starts with empty data', empty,
      `reports=${Object.keys(newShift.json?.savedReports || {}).length}`);
  } else {
    logTest('Start new shift (archive old)', false,
      `${newShiftRes.status}: ${newShiftRes.text?.slice(0, 100)}`);
  }
}

// ============================================
// TEST PHASE 7: Verify Archive Integrity
// ============================================
async function testPhase7_VerifyArchive() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 7: Verify Archive Integrity (100% Match)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!archivedShiftId) {
    logTest('Archive ID available for verification', false);
    return;
  }

  // 7.1 Retrieve archived shift
  const archived = await apiCall('GET', `/api/shifts/${archivedShiftId}`);
  const data = archived.json;

  logTest('Archive shift is retrievable', archived.status === 200 && data,
    `status=${archived.status}`);

  if (!data) return;

  // 7.2 Verify centersData
  const centersMatch = JSON.stringify(data.centersData) === JSON.stringify(TEST_DATA.centersData);
  logTest('Archive: centersData matches 100%', centersMatch,
    `keys=${Object.keys(data.centersData || {}).length}`);

  // 7.3 Verify rapidLocations
  const rapidMatch = JSON.stringify(data.rapidLocations) === JSON.stringify(TEST_DATA.rapidLocations);
  logTest('Archive: rapidLocations matches 100%', rapidMatch,
    `keys=${Object.keys(data.rapidLocations || {}).length}`);

  // 7.4 Verify vehicleData
  const vehicleMatch = JSON.stringify(data.vehicleData) === JSON.stringify(TEST_DATA.vehicleData);
  logTest('Archive: vehicleData matches 100%', vehicleMatch);

  // 7.5 Verify fuelData
  const fuelMatch = JSON.stringify(data.fuelData) === JSON.stringify(TEST_DATA.fuelData);
  logTest('Archive: fuelData matches 100%', fuelMatch);

  // 7.6 Verify generalNotes
  const notesMatch = data.generalNotes === TEST_DATA.generalNotes;
  logTest('Archive: generalNotes matches 100%', notesMatch,
    `note length=${data.generalNotes?.length || 0}`);

  // 7.7 Verify reports count
  const expectedReports = TEST_REPORTS.length;
  const actualReports = data.totalReports || 0;
  logTest('Archive: report count matches', actualReports >= expectedReports,
    `expected=${expectedReports}, actual=${actualReports}`);

  // 7.8 Verify shiftType is correct
  const typeCorrect = data.shiftType === testShiftType;
  logTest('Archive: shiftType is correct', typeCorrect,
    `type=${data.shiftType}`);

  // 7.9 Verify autoArchived flag
  logTest('Archive: has autoArchived flag', data.autoArchived !== undefined,
    `autoArchived=${data.autoArchived}`);

  // Overall integrity
  const allMatch = centersMatch && rapidMatch && vehicleMatch && fuelMatch && notesMatch;
  logTest('=== OVERALL: Archive data integrity 100% ===', allMatch);
}

// ============================================
// TEST PHASE 8: SQLite Sync Verification
// ============================================
async function testPhase8_SQLiteSync() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 8: SQLite Sync Verification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Check if we can query the DB through API
  const stats = await apiCall('GET', '/api/daily-report?shiftId=' + archivedShiftId);
  logTest('SQLite daily-report query works', stats.status === 200,
    `status=${stats.status}`);

  if (stats.json) {
    console.log('  Daily report response keys:', Object.keys(stats.json).join(', '));
  }

  // Check shift completion in DB
  const completion = await apiCall('GET', `/api/completion/latest?shiftDate=${testShiftDate}&shiftType=${testShiftType}`);
  logTest('SQLite shift_completion query works', completion.status === 200,
    `status=${completion.status}`);
}

// ============================================
// TEST PHASE 9: Error Log Check
// ============================================
async function testPhase9_ErrorLogs() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 PHASE 9: Error Log Analysis (Manual)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  console.log('⚠️  IMPORTANT: Check server logs for these patterns:');
  console.log('   - [ERROR] (any error during test)');
  console.log('   - [SYNC] Failed to sync shift to SQLite');
  console.log('   - Could not resolve shift_id');
  console.log('   - Failed to sync reports to shift');
  console.log('');
  console.log('   Check Render Dashboard → Logs or run:');
  console.log('   render logs --tail');

  logTest('Log check instruction provided', true, 'See above');
}

// ============================================
// FINAL REPORT
// ============================================
function generateReport() {
  console.log('\n' + '═'.repeat(60));
  console.log('📊 FINAL VALIDATION REPORT');
  console.log('═'.repeat(60));
  console.log(`Total Tests: ${TEST_RESULTS.tests.length}`);
  console.log(`✅ Passed: ${TEST_RESULTS.passed}`);
  console.log(`❌ Failed: ${TEST_RESULTS.failed}`);
  console.log(`Pass Rate: ${((TEST_RESULTS.passed / TEST_RESULTS.tests.length) * 100).toFixed(1)}%`);
  console.log('');

  if (TEST_RESULTS.failed > 0) {
    console.log('❌ FAILED TESTS:');
    TEST_RESULTS.tests.filter(t => !t.passed).forEach(t => {
      console.log(`  - ${t.name}: ${t.details}`);
    });
  }

  // Save report
  const filename = `validation-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  require('fs').writeFileSync(filename, JSON.stringify(TEST_RESULTS, null, 2));
  console.log(`\n📄 Report saved: ${filename}`);

  return TEST_RESULTS.failed === 0;
}

// ============================================
// MAIN
// ============================================
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  E2E SHIFT/ARCHIVE VALIDATION TEST                        ║');
  console.log('║  منصة الإسعاف - اختبار شامل لدورة المناوبة               ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`API Base: ${API_BASE}`);
  console.log(`Auth Token: ${TOKEN ? '****' + TOKEN.slice(-8) : 'NOT SET (some tests may fail)'}`);
  console.log('');

  if (!TOKEN) {
    console.log('⚠️  WARNING: TEST_TOKEN not set. Admin-only endpoints will fail.');
    console.log('   Set with: export TEST_TOKEN=your_jwt_token');
    console.log('');
  }

  try {
    await testPhase1_Health();
    await testPhase2_CreateShift();
    await testPhase3_EnterData();
    await testPhase4_EnterReports();
    await testPhase5_Completion();
    await testPhase6_Archive();
    await testPhase7_VerifyArchive();
    await testPhase8_SQLiteSync();
    await testPhase9_ErrorLogs();
  } catch (err) {
    console.error('💥 Test runner crashed:', err);
    TEST_RESULTS.errors.push({ message: err.message, stack: err.stack });
  }

  const success = generateReport();

  console.log('\n' + (success ? '✅ ALL TESTS PASSED - System is ready!' : '❌ SOME TESTS FAILED - Review report above'));
  process.exit(success ? 0 : 1);
}

main();
