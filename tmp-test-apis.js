const http = require('http');

function request(path, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request({ hostname: 'localhost', port: 3002, path, method }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', () => resolve({ status: 0, data: 'connection error' }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ status: 0, data: 'timeout' }); });
    req.end();
  });
}

(async () => {
  console.log('=== Testing APIs ===');
  
  const r1 = await request('/api/shift-status');
  console.log('GET /api/shift-status:', r1.status, r1.data.substring(0, 200));
  
  const r2 = await request('/api/shifts/archive?page=1&limit=20');
  console.log('GET /api/shifts/archive:', r2.status, r2.data.substring(0, 200));
  
  const r3 = await request('/api/shifts/executive-dashboard');
  console.log('GET /api/shifts/executive-dashboard:', r3.status, r3.data.substring(0, 200));
  
  console.log('=== Done ===');
  process.exit(0);
})();
