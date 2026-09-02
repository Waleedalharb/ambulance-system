'use strict';
// لقطة إنتاجية خفيفة (قراءة فقط): زمن نقاط Polling الحرجة على emsoperations.online
const BASE = 'https://emsoperations.online';
(async () => {
    const login = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: '4252', password: '4252' })
    });
    const lj = await login.json().catch(() => ({}));
    const token = lj.accessToken || lj.token;
    if (!token) { console.log('LOGIN_FAILED', login.status, JSON.stringify(lj).slice(0, 120)); process.exit(1); }
    console.log('login OK');
    const eps = ['/health', '/api/last-update', '/api/peak-data', '/api/current-shift', '/api/data', '/api/employees'];
    for (let round = 1; round <= 3; round++) {
        for (const ep of eps) {
            const t0 = Date.now();
            let status = 0, bytes = 0;
            try {
                const r = await fetch(BASE + ep, { headers: { Authorization: 'Bearer ' + token } });
                status = r.status;
                bytes = (await r.arrayBuffer()).byteLength;
            } catch (e) { }
            console.log(`prod ${ep}: ${Date.now() - t0}ms HTTP ${status} ${Math.round(bytes / 1024)}KB`);
        }
    }
})().catch(e => { console.error('fail:', e.message); process.exit(1); });
