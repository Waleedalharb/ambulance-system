/**
 * ═══ اختبار EMS Baloot — D3: طبقة API + WebSocket (اعتماد المالك الكتابي 2026-09-25) ═══
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3141 — لا تمس بيانات الإنتاج.
 * النطاق: تكامل Engine + SQLite + Queue + Timers + HTTP + WS معًا (لا وحدات منفردة):
 *  - أمان: 401/403 على المسارات، ومواضيع WS بلا صلاحية/عضوية ← baloot_error.
 *  - دورة طاولة كاملة: فتح ← جلوس 4 ← جاهزية ← بدء مباراة (Server-Authoritative).
 *  - غرفة دردشة الطاولة (kind='table'): الجالس يكتب/يقرأ، المشاهد مرفوض.
 *  - WS: اشتراك ← لقطة فورية · لاعب يرى يده · مشاهد بلا أيدٍ (A7) · بث أحداث حي.
 *  - Idempotency عبر HTTP (نفس actionId ← نفس seq بلا أثر مضاعف).
 *  - أخطاء القواعد تصل بأكوادها العربية (NOT_YOUR_TURN / NOT_PLAYING_PHASE…).
 *  - مهلة الدور ← AUTO_PLAY خادمي يُبث (BALOOT_TTL تجريبي 2.5s).
 *  - انقطاع WS ← إيقاف مؤقت + مهلة عودة · عودة ← استئناف · انتهاء المهلة ←
 *    مقعد خارج + تصويت إنهاء ودّي ← مباراة «غير مكتملة» بلا أثر على الترتيب.
 *  - عزل ساكن: لا team_live_locations/GPS/موقع في خدمات البلوت.
 *  - انحدار: /health + /api/community/status.
 *
 * التشغيل: node scripts/baloot-api-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const MAIN_REPO = path.join('C:\\', 'projects', 'Ambulance Dispatch');
const SRC_DATA = path.join(MAIN_REPO, 'data');
const SRC_DB = path.join(SRC_DATA, 'ambulance.db');
const STAMP = Date.now();
const TMP_DB = path.join(os.tmpdir(), 'blt-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'blt-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3141;
const BASE = 'http://127.0.0.1:' + PORT;
const WS_URL = 'ws://127.0.0.1:' + PORT + '/ws';
const MAIN_MODULES = path.join(MAIN_REPO, 'node_modules');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 400) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitReady(tries = 60) {
    for (let i = 0; i < tries; i++) {
        try { const r = await fetch(BASE + '/health'); if (r.ok) return true; } catch (_) { }
        await sleep(1000);
    }
    return false;
}
async function login(u) {
    const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'test1234' }) });
    const b = await r.json();
    return b.accessToken || null;
}
async function api(method, p, tok, payload) {
    const r = await fetch(BASE + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
        body: payload ? JSON.stringify(payload) : undefined
    });
    let body = null; try { body = await r.json(); } catch (_) { }
    return { status: r.status, body };
}

// ═══ عميل WS تجريبي: سجل رسائل + انتظار شرط + keepalive (heartbeat الخادم 60s) ═══
const WebSocket = require(path.join(MAIN_MODULES, 'ws'));
const wsKeepalives = [];
function wsConnect(tok) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(WS_URL + '?token=' + tok);
        const client = {
            ws, messages: [],
            send(o) { ws.send(JSON.stringify(o)); },
            waitFor(pred, timeoutMs = 8000) {
                return new Promise((res) => {
                    const t0 = Date.now();
                    const iv = setInterval(() => {
                        const hit = client.messages.find(pred);
                        if (hit) { clearInterval(iv); res(hit); }
                        else if (Date.now() - t0 > timeoutMs) { clearInterval(iv); res(null); }
                    }, 50);
                });
            }
        };
        ws.on('message', (raw) => { try { client.messages.push(JSON.parse(String(raw))); } catch (_) { } });
        ws.on('open', () => {
            wsKeepalives.push(setInterval(() => { try { client.send({ type: 'ping' }); } catch (_) { } }, 15000));
            resolve(client);
        });
        ws.on('error', reject);
        setTimeout(() => reject(new Error('WS open timeout')), 8000);
    });
}

// فحص ساكن: عزل البلوت عن أي مفاهيم تشغيلية/موقع
function unitStaticIsolation() {
    console.log('\n═══ الوحدة A: العزل الساكن لخدمات البلوت ═══');
    const dir = path.join(ROOT, 'services', 'baloot');
    const files = [];
    (function walk(d) {
        for (const f of fs.readdirSync(d)) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (f.endsWith('.js')) files.push(p);
        }
    })(dir);
    const forbidden = /team_live_locations|latitude|longitude|\bgps\b|shift|assignment|roster/i;
    let clean = true;
    for (const f of files) {
        // نُزيل التعليقات قبل الفحص (قد تذكر الحدود سياقيًا)
        const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
        if (forbidden.test(src)) { clean = false; console.log('    ⚠️ ' + path.basename(f)); }
    }
    check('A1) خدمات البلوت خالية من أي مفاهيم تشغيلية/موقع (' + files.length + ' ملفات)', clean);
}

(async () => {
    let server = null;
    let dbw = null;
    try {
        unitStaticIsolation();

        console.log('\n═══ الوحدة B: إقلاع معزول + حسابات تجريبية ═══');
        const Database = require(path.join(MAIN_MODULES, 'better-sqlite3'));
        const bcrypt = require(path.join(MAIN_MODULES, 'bcryptjs'));

        const src = new Database(SRC_DB, { readonly: true });
        src.exec("VACUUM INTO '" + TMP_DB + "'");
        src.close();
        fs.mkdirSync(TMP_DIR, { recursive: true });
        for (const f of fs.readdirSync(SRC_DATA)) {
            if (f.endsWith('.json')) { try { fs.copyFileSync(path.join(SRC_DATA, f), path.join(TMP_DIR, f)); } catch (_) { } }
        }
        dbw = new Database(TMP_DB);
        dbw.pragma('journal_mode = WAL');
        // نفس عزل community-full: نسخة الإنتاج تحمل مناوبة active ← تُرشف في النسخة فقط
        dbw.prepare("UPDATE shifts SET status = 'archived' WHERE status = 'active'").run();

        const hash = bcrypt.hashSync('test1234', 10);
        const usersPath = path.join(TMP_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        for (const u of ['BL101', 'BL102', 'BL103', 'BL104', 'BL105', 'BL106', 'BL107']) {
            users.push({ id: 'emp-' + u, username: u, name: 'بلوت ' + u, password: hash, role: 'user', isActive: true });
        }
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));

        const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
        for (const u of ['BL101', 'BL102', 'BL103', 'BL104', 'BL105', 'BL106', 'BL107']) {
            insEmp.run(u, 'لاعب ' + u, 'فني اسعاف');
        }

        const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
        // BL101..BL104: لاعبون كاملون (view+post+create_activity+join_activity)
        for (const u of ['BL101', 'BL102', 'BL103', 'BL104']) {
            for (const k of ['community.view', 'community.post', 'community.create_activity', 'community.join_activity']) {
                insPerm.run('emp-' + u, k);
            }
        }
        // BL105: مشاهد (view فقط) · BL106: بلا منح · BL107: view+join (لاختبار TABLE_FULL وNOT_A_MEMBER)
        insPerm.run('emp-BL105', 'community.view');
        insPerm.run('emp-BL107', 'community.view'); insPerm.run('emp-BL107', 'community.join_activity');

        console.log('🧪 خادم معزول على ' + PORT + ' — Baloot API+WS');
        const env = {
            ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test',
            NODE_PATH: path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES,
            BALOOT_TURN_TTL_MS: '2500', BALOOT_RECONNECT_TTL_MS: '2000'
        };
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
        check('B0) الخادم المعزول أقلع', await waitReady());

        const t1 = await login('BL101'), t2 = await login('BL102'), t3 = await login('BL103'),
            t4 = await login('BL104'), t5 = await login('BL105'), t6 = await login('BL106'), t7 = await login('BL107');
        check('B1) تسجيل دخول السبعة', !!(t1 && t2 && t3 && t4 && t5 && t6 && t7));

        // ═══ الوحدة C: الأمان ═══
        console.log('\n═══ الوحدة C: الأمان (مصادقة + صلاحيات community.* القائمة) ═══');
        check('C1) tables بلا توكن ← 401', (await api('GET', '/api/baloot/tables', null)).status === 401);
        check('C2) tables بلا community.view ← 403', (await api('GET', '/api/baloot/tables', t6)).status === 403);
        const noCreate = await api('POST', '/api/baloot/tables', t5, {});
        check('C3) فتح طاولة بلا create_activity ← 403', noCreate.status === 403, 'status=' + noCreate.status);
        const noRate = await api('GET', '/api/baloot/ratings', t6);
        check('C4) ratings بلا view ← 403', noRate.status === 403);

        // ═══ الوحدة D: اللوبي ودورة الطاولة ═══
        console.log('\n═══ الوحدة D: اللوبي ← فتح ← جلوس ← جاهزية ← بدء ═══');
        const lobby0 = await api('GET', '/api/baloot/tables', t1);
        check('D1) اللوبي يعمل ويُنشئ مجلس البلوت كسولًا', lobby0.status === 200 && lobby0.body.councilId, JSON.stringify(lobby0.body).slice(0, 200));
        const councilId = lobby0.body.councilId;

        // المشاهد ينضم لمجلس البلوت عبر مسار D1 القائم (شرط المشاهدة)
        const joinCouncil = await api('POST', '/api/community/councils/' + councilId + '/join', t5, {});
        check('D2) المشاهد ينضم لمجلس البلوت عبر مسار D1', joinCouncil.status === 200, 'status=' + joinCouncil.status);

        const created = await api('POST', '/api/baloot/tables', t1, {});
        check('D3) فتح طاولة ← 200 + roomId', created.status === 200 && created.body.table && created.body.roomId, JSON.stringify(created.body).slice(0, 200));
        const tableId = created.body.table.id;
        const roomId = created.body.roomId;

        const lobby1 = await api('GET', '/api/baloot/tables', t5);
        check('D4) اللوبي يعرض الطاولة المفتوحة', lobby1.status === 200 && lobby1.body.tables.some(t => t.id === tableId && t.status === 'open'));

        const sit1 = await api('POST', '/api/baloot/tables/' + tableId + '/sit', t1, {});
        check('D5) جلوس المنشئ ← مقعد 0', sit1.status === 200 && sit1.body.seat === 0, JSON.stringify(sit1.body));
        const sitNoPerm = await api('POST', '/api/baloot/tables/' + tableId + '/sit', t5, {});
        check('D6) جلوس بلا join_activity ← 403', sitNoPerm.status === 403);
        await api('POST', '/api/baloot/tables/' + tableId + '/sit', t2, {});
        await api('POST', '/api/baloot/tables/' + tableId + '/sit', t3, {});
        const sit4 = await api('POST', '/api/baloot/tables/' + tableId + '/sit', t4, {});
        check('D7) اكتمال الأربعة ← مقعد 3', sit4.status === 200 && sit4.body.seat === 3, JSON.stringify(sit4.body));
        const sitFull = await api('POST', '/api/baloot/tables/' + tableId + '/sit', t7, {});
        check('D8) خامس على طاولة مكتملة ← 409/رفض', sitFull.status === 409 || sitFull.status === 403, 'status=' + sitFull.status);

        const tState = await api('GET', '/api/baloot/tables/' + tableId, t1);
        check('D9) الطاولة المكتملة ← ready_check + mySeat', tState.status === 200 && tState.body.table.status === 'ready_check' && tState.body.mySeat === 0, JSON.stringify(tState.body).slice(0, 250));

        await api('POST', '/api/baloot/tables/' + tableId + '/ready', t1, {});
        await api('POST', '/api/baloot/tables/' + tableId + '/ready', t2, {});
        await api('POST', '/api/baloot/tables/' + tableId + '/ready', t3, {});
        const ready4 = await api('POST', '/api/baloot/tables/' + tableId + '/ready', t4, {});
        check('D10) جاهزية الأربعة ← مباراة تبدأ', ready4.status === 200 && ready4.body.matchStarted === true && !!ready4.body.matchId, JSON.stringify(ready4.body));
        const matchId = ready4.body.matchId;

        // ═══ الوحدة E: غرفة دردشة الطاولة (kind='table' — امتداد §15) ═══
        console.log('\n═══ الوحدة E: دردشة الطاولة عبر مسارات D1 القائمة ═══');
        const chatSend = await api('POST', '/api/community/rooms/' + roomId + '/messages', t1, { content: 'بالتوفيق يا شباب 🃏' });
        check('E1) جالس يرسل في غرفة الطاولة ← 200', chatSend.status === 200, 'status=' + chatSend.status + ' ' + JSON.stringify(chatSend.body).slice(0, 150));
        const chatList = await api('GET', '/api/community/rooms/' + roomId + '/messages', t2);
        check('E2) جالس يقرأ رسائل الطاولة', chatList.status === 200 && JSON.stringify(chatList.body).includes('بالتوفيق'));
        const chatSpec = await api('GET', '/api/community/rooms/' + roomId + '/messages', t5);
        check('E3) مشاهد (ليس جالسًا) مرفوض من غرفة الطاولة ← 403', chatSpec.status === 403, 'status=' + chatSpec.status);

        // ═══ الوحدة F: WebSocket — اشتراك ولقطات وتفويض ═══
        console.log('\n═══ الوحدة F: WS — اشتراك + projection حسب الدور (A7) ═══');
        const w1 = await wsConnect(t1);
        const w5 = await wsConnect(t5);
        const w6 = await wsConnect(t6);
        const w7 = await wsConnect(t7);

        w1.send({ type: 'baloot_subscribe', topic: 'baloot:match:' + matchId });
        const sub1 = await w1.waitFor(m => m.type === 'baloot_subscribed');
        check('F1) لاعب يشترك في مباراته ← role=player', sub1 && sub1.role === 'player', JSON.stringify(sub1));
        const snap1 = await w1.waitFor(m => m.type === 'baloot_match' && m.state);
        check('F2) لقطة اللاعب الفورية فيها myHand', !!(snap1 && snap1.state && snap1.state.hand && Array.isArray(snap1.state.hand.myHand) && snap1.state.hand.myHand.length > 0), snap1 && snap1.state ? JSON.stringify(snap1.state.hand && snap1.state.hand.phase) : 'no snap');

        w5.send({ type: 'baloot_subscribe', topic: 'baloot:match:' + matchId });
        const sub5 = await w5.waitFor(m => m.type === 'baloot_subscribed');
        check('F3) مشاهد (عضو مجلس) يشترك ← role=spectator', sub5 && sub5.role === 'spectator', JSON.stringify(sub5));
        const snap5 = await w5.waitFor(m => m.type === 'baloot_match' && m.state);
        check('F4) لقطة المشاهد بلا myHand إطلاقًا', !!(snap5 && snap5.state && snap5.state.hand && snap5.state.hand.myHand === undefined && snap5.state.hand.handCounts), snap5 && snap5.state ? JSON.stringify(Object.keys(snap5.state.hand || {})) : 'no snap');

        w7.send({ type: 'baloot_subscribe', topic: 'baloot:match:' + matchId });
        const sub7 = await w7.waitFor(m => m.type === 'baloot_error' || m.type === 'baloot_subscribed');
        check('F5) غير عضو المجلس ← baloot_error NOT_A_MEMBER', sub7 && sub7.type === 'baloot_error' && sub7.code === 'NOT_A_MEMBER', JSON.stringify(sub7));

        w6.send({ type: 'baloot_subscribe', topic: 'baloot:lobby' });
        const sub6 = await w6.waitFor(m => m.type === 'baloot_error' || m.type === 'baloot_subscribed');
        check('F6) بلا community.view ← baloot_error PERMISSION_DENIED', sub6 && sub6.type === 'baloot_error' && sub6.code === 'PERMISSION_DENIED', JSON.stringify(sub6));

        // حالة HTTP للمشاهد: نفس العزل
        const stateSpec = await api('GET', '/api/baloot/matches/' + matchId + '/state', t5);
        check('F7) HTTP للمشاهد ← projection بلا أيدٍ', stateSpec.status === 200 && stateSpec.body.state.hand && stateSpec.body.state.hand.myHand === undefined, JSON.stringify(stateSpec.body).slice(0, 200));
        const stateNoMember = await api('GET', '/api/baloot/matches/' + matchId + '/state', t7);
        check('F8) HTTP لغير عضو المجلس ← 403', stateNoMember.status === 403);

        // ═══ الوحدة G: اللعب عبر HTTP + بث WS + Idempotency + مهلة الدور ═══
        console.log('\n═══ الوحدة G: فعل لعب HTTP ← بث WS ← idempotency ← AUTO_PLAY ═══');
        // السوق: طور bidding1 — فعل خاطئ أولًا (حتمي: لا مؤقت دور في السوق)
        const bidderState = snap1.state;
        const biddingTurn = bidderState.hand.biddingTurn;
        const turnTokens = { 0: t1, 1: t2, 2: t3, 3: t4 };
        const wrongBidder = turnTokens[(biddingTurn + 1) % 4];
        const wrongBid = await api('POST', '/api/baloot/matches/' + matchId + '/action', wrongBidder, { actionId: 'wrong-bid-0001', type: 'BID', payload: { kind: 'sun' } });
        check('G1) سوق من غير صاحب الدور ← 409 NOT_YOUR_TURN', wrongBid.status === 409 && wrongBid.body.code === 'NOT_YOUR_TURN', JSON.stringify(wrongBid.body));

        const playEarly = await api('POST', '/api/baloot/matches/' + matchId + '/action', turnTokens[biddingTurn], { actionId: 'early-card-001', type: 'PLAY_CARD', payload: { card: 'SA' } });
        check('G2) لعب ورقة أثناء السوق ← 409 NOT_PLAYING_PHASE', playEarly.status === 409 && playEarly.body.code === 'NOT_PLAYING_PHASE', JSON.stringify(playEarly.body));

        const bid = await api('POST', '/api/baloot/matches/' + matchId + '/action', turnTokens[biddingTurn], { actionId: 'bid-sun-000001', type: 'BID', payload: { kind: 'sun' } });
        check('G3) سوق نظامي (صن) ← 200', bid.status === 200 && bid.body.ok === true, JSON.stringify(bid.body));
        const bidAgain = await api('POST', '/api/baloot/matches/' + matchId + '/action', turnTokens[biddingTurn], { actionId: 'bid-sun-000001', type: 'BID', payload: { kind: 'sun' } });
        check('G4) نفس actionId ← idempotent بنفس seq', bidAgain.status === 200 && bidAgain.body.idempotent === true && bidAgain.body.seq === bid.body.seq, JSON.stringify(bidAgain.body));

        const evContract = await w5.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'contract_set' || e.type === 'bid'));
        check('G5) حدث السوق يصل المشاهد عبر WS', !!evContract);

        // طور اللعب: صاحب الدور يلعب ورقة نظامية (رد الزات إن وُجد)
        let cur = await api('GET', '/api/baloot/matches/' + matchId + '/state', turnTokens[0]);
        let guard = 0;
        while (cur.body.state.hand && cur.body.state.hand.phase !== 'playing' && guard++ < 10) {
            await sleep(300);
            cur = await api('GET', '/api/baloot/matches/' + matchId + '/state', turnTokens[0]);
        }
        check('G6) المباراة دخلت طور اللعب', cur.body.state.hand && cur.body.state.hand.phase === 'playing', cur.body.state.hand && cur.body.state.hand.phase);

        const turnSeat = cur.body.state.hand.turnSeat;
        const meState = (await api('GET', '/api/baloot/matches/' + matchId + '/state', turnTokens[turnSeat])).body.state;
        const trick = meState.hand.currentTrick;
        let card = meState.hand.myHand[0].code;
        if (trick.length > 0) {
            const led = trick[0].card.code[0];
            const follow = meState.hand.myHand.find(c => c.code[0] === led);
            if (follow) card = follow.code;
        }
        const play = await api('POST', '/api/baloot/matches/' + matchId + '/action', turnTokens[turnSeat], { actionId: 'play-card-00001', type: 'PLAY_CARD', payload: { card } });
        check('G7) لعب ورقة نظامية ← 200', play.status === 200 && play.body.ok === true, JSON.stringify(play.body));

        const evPlayed = await w5.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'card_played' && e.card === card));
        check('G8) card_played يصل المشاهد عبر WS (الورقة علنية على الأرض)', !!evPlayed);

        // مهلة الدور 2.5s (تجريبية) ← لعب آلي محايد معلن
        const evAuto = await w5.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'auto_play'), 10000);
        check('G9) مهلة الدور ← AUTO_PLAY خادمي يُبث', !!evAuto);

        // ═══ الوحدة H: انقطاع/عودة/إنهاء ودّي عبر WS الحقيقي ═══
        console.log('\n═══ الوحدة H: انقطاع WS ← إيقاف مؤقت · عودة ← استئناف · إنهاء ودّي ═══');
        const w3 = await wsConnect(t3);
        w3.send({ type: 'baloot_subscribe', topic: 'baloot:match:' + matchId });
        await w3.waitFor(m => m.type === 'baloot_subscribed');

        w3.ws.close(); // انقطاع فعلي من العميل
        const evDisc = await w1.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'player_disconnected'), 10000);
        check('H1) انقطاع WS لجالس ← player_disconnected يُبث', !!evDisc);
        const pausedState = await api('GET', '/api/baloot/matches/' + matchId + '/state', t1);
        check('H2) المباراة متوقفة مؤقتًا بعد الانقطاع', pausedState.status === 200 && pausedState.body.paused === true, JSON.stringify(pausedState.body).slice(0, 150));

        // عودة: اشتراك اللاعب المنقطع = reconnect (يبطل مهلة العودة)
        const w3b = await wsConnect(t3);
        w3b.send({ type: 'baloot_subscribe', topic: 'baloot:match:' + matchId });
        await w3b.waitFor(m => m.type === 'baloot_subscribed');
        const evRe = await w1.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'player_reconnected'), 10000);
        check('H3) عودة اللاعب ← player_reconnected + استئناف', !!evRe);
        const resumed = await api('GET', '/api/baloot/matches/' + matchId + '/state', t1);
        check('H4) المباراة مستأنفة بعد العودة', resumed.status === 200 && resumed.body.paused === false, JSON.stringify(resumed.body).slice(0, 150));

        // انقطاع بلا عودة: مهلة 2s ← مقعد خارج + تصويت
        w3b.ws.close();
        const evOut = await w1.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'seat_out'), 12000);
        check('H5) انتهاء مهلة العودة ← seat_out يُبث', !!evOut);

        const vote1 = await api('POST', '/api/baloot/matches/' + matchId + '/vote-abort', t1, {});
        check('H6) تصويت أول ← مسجل', vote1.status === 200 && vote1.body.ok === true, JSON.stringify(vote1.body));
        const vote2 = await api('POST', '/api/baloot/matches/' + matchId + '/vote-abort', t2, {});
        check('H7) تصويت ثانٍ ← إنهاء ودّي', vote2.status === 200, JSON.stringify(vote2.body));
        const evAbort = await w1.waitFor(m => m.type === 'baloot_match' && (m.events || []).some(e => e.type === 'match_aborted'), 8000);
        check('H8) match_aborted يُبث', !!evAbort);

        const tableAfter = await api('GET', '/api/baloot/tables/' + tableId, t1);
        check('H9) الطاولة تعود مفتوحة لمن بقي', tableAfter.status === 200 && tableAfter.body.table.status === 'open', JSON.stringify(tableAfter.body.table && tableAfter.body.table.status));

        const ratings = await api('GET', '/api/baloot/ratings', t1);
        check('H10) الإنهاء الودّي بلا أثر على الترتيب الشرفي', ratings.status === 200 && ratings.body.ratings.length === 0, JSON.stringify(ratings.body));

        // ═══ الوحدة I: انحدار ═══
        console.log('\n═══ الوحدة I: انحدار ═══');
        check('I1) /health يعمل', (await fetch(BASE + '/health')).ok);
        const commStatus = await api('GET', '/api/community/status', t1);
        check('I2) /api/community/status يعمل', commStatus.status === 200 && commStatus.body.success === true, 'status=' + commStatus.status);
        const centers = await api('GET', '/api/ops/centers', t1);
        check('I3) /api/ops/centers (مصادَق) يعمل', centers.status === 200, 'status=' + centers.status);

        for (const k of wsKeepalives) clearInterval(k);
        for (const c of [w1, w5, w6, w7]) { try { c.ws.close(); } catch (_) { } }
    } catch (e) {
        failed++; failures.push('FATAL: ' + e.message);
        console.error('💥 فشل حرج:', e);
    } finally {
        if (server) { try { server.kill(); } catch (_) { } }
        if (dbw) { try { dbw.close(); } catch (_) { } }
        await sleep(500);
        try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) { }
        try { fs.rmSync(TMP_DB, { force: true }); } catch (_) { }
        try { fs.rmSync(TMP_DB + '-wal', { force: true }); } catch (_) { }
        try { fs.rmSync(TMP_DB + '-shm', { force: true }); } catch (_) { }
    }

    console.log('\n════════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('════════════════════════════════════');
    process.exit(failed ? 1 : 0);
})();
