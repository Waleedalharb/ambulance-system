const BASE = 'http://localhost:3002';

async function testAPI(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(BASE + path, opts);
    const data = await res.json().catch(() => null);
    console.log(method, path, '=>', res.status, data ? (data.success ? 'SUCCESS' : 'FAIL') : 'NO JSON');
    return data;
  } catch (e) {
    console.log(method, path, '=> ERROR:', e.message);
    return null;
  }
}

(async () => {
  console.log('=== Testing APIs ===');
  
  // 1. Test shift-status (no auth needed for basic check)
  const status = await testAPI('/api/shift-status');
  
  // 2. Test shift-integrity
  if (status && status.shiftId) {
    await testAPI('/api/shift-integrity/' + status.shiftId);
    await testAPI('/api/shift-timeline/' + status.shiftId);
    await testAPI('/api/shift-snapshot/' + status.shiftId);
  }
  
  console.log('=== Done ===');
  process.exit(0);
})();
