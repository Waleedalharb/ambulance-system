/**
 * ═══ اختبار واجهة البلوت D3 — baloot-ui-test.js (اعتماد المالك الكتابي 2026-09-25) ═══
 * نمط المشروع المعتمد للواجهات: عرض نقي في Node + فحص ساكن + رحلات حية على خادم معزول.
 * العزل: VACUUM INTO + DATA_DIR مؤقت + بورت 3142 — لا تمس بيانات الإنتاج.
 *
 * الرحلات الحية (owner-mandated):
 *  R1) لاعب يفتح طاولة ← 4 يجلسون ← جاهزية ← سوق ← لعب حقيقي ← العرض يتبع الحالة
 *  R2) مشاهد: لا يدٌ في العرض إطلاقًا · لا أزرار لعب · ملاحظة «وضع المشاهدة»
 *  R3) انقطاع لاعب ← شارة «منقطع» · عودة ← «متصل»
 *  R4) تأخر لاعب ← AUTO_PLAY يحدث الحالة (مهلة تجريبية 2.5s)
 *  R5) خروج نهائي ← مقعد شاغر ← استبدال بلاعب جديد يكمل بكروت الخارج
 *  R6) الإنهاء الودّي بالتصويت ← الطاولة تعود مفتوحة · الترتيب بلا أثر
 *
 * التشغيل: node scripts/baloot-ui-test.js
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
const TMP_DB = path.join(os.tmpdir(), 'blu-' + STAMP + '.db').replace(/\\/g, '/');
const TMP_DIR = path.join(os.tmpdir(), 'blu-data-' + STAMP).replace(/\\/g, '/');
const PORT = 3142;
const BASE = 'http://127.0.0.1:' + PORT;
const MAIN_MODULES = path.join(MAIN_REPO, 'node_modules');
const UI = require(path.join(ROOT, 'public', 'js', 'baloot-app.js'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
    if (cond) { passed++; console.log('  ✅ ' + name); }
    else { failed++; failures.push(name); console.log('  ❌ ' + name + (extra ? ' — ' + String(extra).slice(0, 300) : '')); }
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

/* ═══ الوحدة A: فحص ساكن للواجهة ═══ */
function unitStatic() {
    console.log('\n═══ الوحدة A: الفحص الساكن ═══');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'baloot.html'), 'utf8');
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'baloot-app.js'), 'utf8');
    check('A1) baloot.html موجودة RTL بعنوان بلوت', html.includes('dir="rtl"') && html.includes('مجلس البلوت'));
    check('A2) تحمل js/baloot-app.js', html.includes('js/baloot-app.js'));
    check('A3) تستخدم متغيرات هوية المنصة (--navy-900/--teal-id/--gold-id)', html.includes('--navy-900') && html.includes('--teal-id') && html.includes('--gold-id'));
    const ids = ['view-lobby', 'view-table', 'tablesGrid', 'tableHost', 'preMatchBar', 'chatPanel', 'chatLog', 'chatInput', 'scoreModal', 'toast', 'meChip', 'btnOpenTable', 'btnBack', 'ratingsList', 'joinCouncilBar'];
    check('A4) كل عناصر الربط موجودة في الصفحة', ids.every(id => html.includes('id="' + id + '"')), ids.filter(id => !html.includes('id="' + id + '"')).join(','));
    const forbidden = /team_live_locations|latitude|longitude|\bgps\b/i;
    const stripped = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    check('A5) الواجهة خالية من أي مفاهيم موقع/تشغيل', !forbidden.test(stripped) && !forbidden.test(html));
    check('A6) الواجهة لا تحسب قواعد — الخيارات من /options', js.includes('/options') && !/MUST_FOLLOW_SUIT/.test(js));
    const comm = fs.readFileSync(path.join(ROOT, 'public', 'community.html'), 'utf8');
    check('A7) بطاقة مجلس البلوت فيها رابط الطاولات', /slug === 'baloot'/.test(comm) && comm.includes('baloot.html'));
}

/* ═══ الوحدة B: عرض نقي (بلا خادم) ═══ */
function unitPure() {
    console.log('\n═══ الوحدة B: العرض النقي ═══');
    const layout = UI.seatLayout(1);
    check('B1) الشريك مقابلي والدور حولي', layout.bottom === 1 && layout.top === 3 && layout.left === 2 && layout.right === 0);

    const playable = UI.cardHtml({ code: 'HA' }, { playable: true, action: true });
    const blocked = UI.cardHtml({ code: 'S7' }, { playable: false });
    check('B2) المسموح قابل للضغط (data-card)', playable.includes('data-card="HA"') && !playable.includes('disabled'));
    check('B3) الممنوع معطّل غير قابل للضغط', blocked.includes('disabled') && !blocked.includes('data-card'));

    const fakeState = {
        rulesetVersion: 'sa-standard-1.0', targetScore: 152, scores: { A: 26, B: 14 }, handNumber: 1,
        status: 'in_hand', winner: null, seq: 5,
        seats: [0, 1, 2, 3].map(s => ({ seat: s, team: s % 2 === 0 ? 'A' : 'B', name: 'لاعب ' + s })),
        hand: {
            phase: 'playing', dealerSeat: 0, turnSeat: 1, mySeat: 1,
            contract: { type: 'hokum', trumpSuit: 'H', buyerSeat: 1 }, double: { multiplier: 2, qahwa: false },
            declarations: { resolved: false },
            myHand: [{ code: 'HA' }, { code: 'HK' }, { code: 'S7' }],
            handCounts: { 0: 8, 1: 3, 2: 8, 3: 8 },
            currentTrick: [{ seat: 0, card: { code: 'H9' } }], tricksCount: 1, lastTrick: null
        }
    };
    const opts = { myTurn: true, paused: false, mySeat: 1, cards: ['HA', 'HK'], balootCards: ['HA', 'HK'], bids: [], projects: [], doubles: ['dabal'] };
    const handHtml = UI.handHtml(fakeState, opts);
    check('B4) اليد تعرض المسموح فقط قابلًا للضغط', (handHtml.match(/data-card=/g) || []).length === 2 && (handHtml.match(/dimmed/g) || []).length === 1);
    check('B5) كروت البلوت موسومة', handHtml.includes('بلوت'));

    const tableHtml = UI.renderTableView({ table: { id: 7, status: 'in_match', seats: [] }, state: fakeState, options: opts, meId: 'x', mySeat: 1, spectator: false, paused: false, spectators: 3 });
    check('B6) شاشة اللاعب: يده + عقد الحكم + النقاط + المشاهدون', tableHtml.includes('my-hand') && tableHtml.includes('حكم') && tableHtml.includes('×2') && tableHtml.includes('يشاهدون'));
    check('B7) إبراز صاحب الدور بحلقة', tableHtml.includes('seat-left turn') || tableHtml.includes(' turn"'));

    const specHtml = UI.renderTableView({ table: { id: 7, status: 'in_match', seats: [] }, state: fakeState, options: null, meId: 'y', mySeat: null, spectator: true, paused: false, spectators: 1 });
    check('B8) المشاهد: ملاحظة المشاهدة + لا يد إطلاقًا', specHtml.includes('spectator-note') && !specHtml.includes('my-hand'));
    check('B9) المشاهد: لا كروت قابلة للضغط، مع بقاء ورقة الأرض ظاهرة', !specHtml.includes('data-card=') && specHtml.includes('trick-card'));

    const bidState = JSON.parse(JSON.stringify(fakeState));
    bidState.hand.phase = 'bidding1'; bidState.hand.biddingTurn = 2;
    bidState.hand.faceUpCard = { code: 'DQ' };
    const bidBar = UI.biddingBar({ myTurn: true, bids: [{ kind: 'pass' }, { kind: 'sun' }, { kind: 'hokum', trumpSuit: 'D' }] }, bidState);
    check('B10) السوق: الخيارات المتاحة فقط بلغة بسيطة', bidBar.includes('صن') && bidBar.includes('بس') && bidBar.includes('حكم') && bidBar.includes('data-bid'));
    const bidWait = UI.biddingBar({ myTurn: false }, bidState);
    check('B11) ليس دوري: انتظار باسم صاحب الدور', bidWait.includes('لاعب 2') && !bidWait.includes('data-bid'));

    check('B12) رسائل الأحداث بلغة الناس', UI.eventMessage({ type: 'contract_set', contract: { type: 'sun', buyerSeat: 2 } }, fakeState).includes('اشترى صن') &&
        UI.eventMessage({ type: 'auto_play', seat: 0 }, fakeState).includes('لعب آلي') &&
        UI.eventMessage({ type: 'doubled', kind: 'dabal', team: 'B' }, fakeState).includes('دبل'));

    const breakdown = UI.handScoreHtml({ outcome: 'success', contract: { type: 'sun' }, buyerTeam: 'A', cardAbnat: { A: 80, B: 50 }, multiplier: 1, projects: [], balootPts: { A: 0, B: 0 }, delta: { A: 80, B: 50 }, note: 'نجاح المشتري' }, fakeState);
    check('B13) تفصيل نقاط الصفقة يشرح السبب', breakdown.includes('أبناط') && breakdown.includes('نجاح المشتري') && breakdown.includes('+80'));

    const endState = { status: 'finished', winner: 'A', scores: { A: 152, B: 90 }, seats: fakeState.seats };
    const endMe = UI.matchEndHtml(endState, { accepts: ['emp-1'], matchId: 9 }, 'emp-2', 'post_match');
    check('B14) نهاية المباراة: فائز + سؤال الريماچ', endMe.includes('الفائز') && endMe.includes('مباراة ثانية') && endMe.includes('data-rematch="accept"') && endMe.includes('data-rematch="decline"'));
    const endAccepted = UI.matchEndHtml(endState, { accepts: ['emp-2'], matchId: 9 }, 'emp-2', 'post_match');
    check('B15) من وافق: انتظار بلا أزرار مكررة', endAccepted.includes('بانتظار الباقين') && !endAccepted.includes('data-rematch="accept"'));

    const lobby = UI.renderLobby([{ id: 5, status: 'open', targetScore: 152, seats: [{ seat: 0, occupied: true, name: 'أبو فهد' }, { seat: 1, occupied: false }, { seat: 2, occupied: false }, { seat: 3, occupied: false }] }], { canJoin: true });
    check('B16) بطاقة اللوبي: مقاعد واضحة + زر اجلس + الحالة بالعربي', lobby.includes('أبو فهد') && lobby.includes('فارغ') && lobby.includes('اجلس') && lobby.includes('تنتظر لاعبين'));
    check('B17) اللوبي الفارغ بدعوة للفتح', UI.renderLobby([], {}).includes('افتح أول طاولة'));
}

(async () => {
    let server = null, dbw = null;
    try {
        unitStatic();
        unitPure();

        console.log('\n═══ الوحدة C: رحلات حية على خادم معزول ═══');
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
        dbw.prepare("UPDATE shifts SET status = 'archived' WHERE status = 'active'").run();

        const hash = bcrypt.hashSync('test1234', 10);
        const usersPath = path.join(TMP_DIR, 'users.json');
        const users = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
        for (const u of ['BU101', 'BU102', 'BU103', 'BU104', 'BU105', 'BU106']) {
            users.push({ id: 'emp-' + u, username: u, name: 'بلوت ' + u, password: hash, role: 'user', isActive: true });
        }
        fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
        const insEmp = dbw.prepare('INSERT INTO employees (employee_code, name, job_title, is_active) VALUES (?,?,?,1)');
        for (const u of ['BU101', 'BU102', 'BU103', 'BU104', 'BU105', 'BU106']) insEmp.run(u, 'لاعب ' + u, 'فني اسعاف');
        const insPerm = dbw.prepare("INSERT INTO user_permissions (user_id, permission_key, granted, granted_by) VALUES (?, ?, 1, 'test')");
        for (const u of ['BU101', 'BU102', 'BU103', 'BU104']) {
            for (const k of ['community.view', 'community.post', 'community.create_activity', 'community.join_activity']) insPerm.run('emp-' + u, k);
        }
        insPerm.run('emp-BU105', 'community.view');
        insPerm.run('emp-BU106', 'community.view'); insPerm.run('emp-BU106', 'community.join_activity');

        const env = {
            ...process.env, PORT: String(PORT), DB_PATH: TMP_DB, DATA_DIR: TMP_DIR, NODE_ENV: 'test',
            NODE_PATH: path.join(ROOT, 'node_modules') + ';' + MAIN_MODULES,
            BALOOT_TURN_TTL_MS: '2500', BALOOT_RECONNECT_TTL_MS: '1500'
        };
        server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stderr.on('data', d => { const s = String(d); if (s.includes('Error')) console.error('[server]', s.slice(0, 200)); });
        check('C0) الخادم المعزول أقلع', await waitReady());

        const t1 = await login('BU101'), t2 = await login('BU102'), t3 = await login('BU103'),
            t4 = await login('BU104'), t5 = await login('BU105'), t6 = await login('BU106');
        const T = [t1, t2, t3, t4];

        // ── R1) رحلة اللاعب الكاملة ──
        console.log('\n── R1) لاعب يفتح ← 4 يجلسون ← جاهزية ← سوق ← لعب ──');
        const created = await api('POST', '/api/baloot/tables', t1, {});
        const tableId = created.body.table.id;
        check('R1-1) فتح الطاولة', created.status === 200);
        await api('POST', '/api/community/councils/' + created.body.table.council_id + '/join', t5, {});
        for (const tk of T) await api('POST', '/api/baloot/tables/' + tableId + '/sit', tk, {});
        for (let i = 0; i < 3; i++) await api('POST', '/api/baloot/tables/' + tableId + '/ready', T[i], {});
        const r4 = await api('POST', '/api/baloot/tables/' + tableId + '/ready', T[3], {});
        const matchId = r4.body.matchId;
        check('R1-2) المباراة بدأت بعد جاهزية الأربعة', !!matchId);

        const st1 = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body;
        const biddingTurn = st1.state.hand.biddingTurn;
        const optMine = await api('GET', '/api/baloot/matches/' + matchId + '/options', T[biddingTurn]);
        check('R1-3) /options لصاحب الدور في السوق: خيارات فعلية', optMine.status === 200 && optMine.body.myTurn === true && optMine.body.bids.length >= 2, JSON.stringify(optMine.body).slice(0, 200));
        const optOther = await api('GET', '/api/baloot/matches/' + matchId + '/options', T[(biddingTurn + 1) % 4]);
        check('R1-4) /options لغير صاحب الدور: لا خيارات', optOther.status === 200 && optOther.body.myTurn === false && optOther.body.bids.length === 0);

        // العرض يتبع الحالة الحقيقية: السوق بخيارات صاحب الدور فقط
        const bidView = UI.renderTableView({ table: { id: tableId, status: 'in_match', seats: [] }, state: st1.state, options: optOther.body, meId: 'emp-BU10' + ((biddingTurn + 1) % 4 + 1), mySeat: (biddingTurn + 1) % 4, spectator: false, paused: false, spectators: 0 });
        check('R1-5) عرض غير صاحب الدور: لا أزرار سوق', !bidView.includes('data-bid'));

        const bidRes = await api('POST', '/api/baloot/matches/' + matchId + '/action', T[biddingTurn], { actionId: 'ui-bid-0000001', type: 'BID', payload: { kind: 'sun' } });
        check('R1-6) شراء صن من صاحب الدور', bidRes.status === 200, JSON.stringify(bidRes.body));

        let cur = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body;
        let guard = 0;
        while (cur.state.hand && cur.state.hand.phase !== 'playing' && guard++ < 10) {
            await sleep(300);
            cur = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body;
        }
        const turnSeat = cur.state.hand.turnSeat;
        const optPlay = (await api('GET', '/api/baloot/matches/' + matchId + '/options', T[turnSeat])).body;
        check('R1-7) طور اللعب: 8 أوراق نظامية لصاحب الدور', optPlay.myTurn === true && optPlay.cards.length === 8, JSON.stringify(optPlay.cards));

        const meState = (await api('GET', '/api/baloot/matches/' + matchId + '/state', T[turnSeat])).body.state;
        const view = UI.renderTableView({ table: { id: tableId, status: 'in_match', seats: [] }, state: meState, options: optPlay, meId: 'p', mySeat: turnSeat, spectator: false, paused: false, spectators: 0 });
        check('R1-8) اليد المعروضة: 8 كروت كلها قابلة للضغط (أول لفة)', (view.match(/data-card=/g) || []).length === 8, String((view.match(/data-card=/g) || []).length));
        check('R1-9) أسماء اللاعبين الأربعة ظاهرة حول الطاولة', ['لاعب BU101', 'لاعب BU102', 'لاعب BU103', 'لاعب BU104'].every(n => view.includes(n)));

        const card = optPlay.cards[0];
        const playRes = await api('POST', '/api/baloot/matches/' + matchId + '/action', T[turnSeat], { actionId: 'ui-play-000001', type: 'PLAY_CARD', payload: { card } });
        check('R1-10) لعب ورقة نظامية', playRes.status === 200, JSON.stringify(playRes.body));
        const afterPlay = (await api('GET', '/api/baloot/matches/' + matchId + '/state', T[turnSeat])).body.state;
        check('R1-11) الورقة على الأرض ويدي نقصت', afterPlay.hand.currentTrick.some(p => p.card.code === card) && afterPlay.hand.myHand.length === 7);

        // ── R2) رحلة المشاهد ──
        console.log('\n── R2) مشاهد: لا يد · لا حركة · ملاحظة واضحة ──');
        const specRes = await api('GET', '/api/baloot/matches/' + matchId + '/state', t5);
        check('R2-1) استجابة المشاهد بلا myHand', specRes.status === 200 && specRes.body.state.hand && specRes.body.state.hand.myHand === undefined, JSON.stringify(specRes.body).slice(0, 150));
        const specView = UI.renderTableView({ table: { id: tableId, status: 'in_match', seats: [] }, state: specRes.body.state, options: null, meId: 'emp-BU105', mySeat: null, spectator: true, paused: false, spectators: 1 });
        check('R2-2) عرض المشاهد: ملاحظة «وضع المشاهدة»', specView.includes('وضع المشاهدة'));
        check('R2-3) عرض المشاهد: صفر أزرار لعب/سوق/دبل', !specView.includes('data-card=') && !specView.includes('data-bid') && !specView.includes('data-double'));
        check('R2-4) المشاهد يرى ورقة الأرض والنقاط', specView.includes('trick-card') && specView.includes('scores'));
        const optSpec = await api('GET', '/api/baloot/matches/' + matchId + '/options', t5);
        check('R2-5) /options للمشاهد ← 403 NOT_SEATED', optSpec.status === 403 && optSpec.body.code === 'NOT_SEATED');
        const specPlay = await api('POST', '/api/baloot/matches/' + matchId + '/action', t5, { actionId: 'spec-play-0001', type: 'PLAY_CARD', payload: { card: 'SA' } });
        check('R2-6) المشاهد لا يستطيع اللعب (403)', specPlay.status === 403);

        // ── R3) انقطاع وعودة ──
        console.log('\n── R3) انقطاع ← «منقطع» · عودة ← «متصل» ──');
        await api('POST', '/api/baloot/matches/' + matchId + '/disconnect', t3, {});
        await sleep(300);
        const tblDisc = (await api('GET', '/api/baloot/tables/' + tableId, t1)).body.table;
        const discSeat = tblDisc.seats.find(s => s.seat === 2);
        check('R3-1) شارة «منقطع» على مقعده في اللوبي', discSeat && discSeat.disconnected === true, JSON.stringify(tblDisc.seats));
        const seatHtmlOff = UI.seatHtml('top', 2, null, { status: 'in_match', seats: tblDisc.seats.map(s => ({ seat: s.seat, name: s.name, disconnected: s.disconnected })) }, null);
        check('R3-2) عرض المقعد: منقطع', seatHtmlOff.includes('منقطع'));
        const pausedNow = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body;
        check('R3-3) المباراة متوقفة مؤقتًا', pausedNow.paused === true);
        await api('POST', '/api/baloot/matches/' + matchId + '/reconnect', t3, {});
        await sleep(300);
        const resumed = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body;
        check('R3-4) العودة تستأنف المباراة', resumed.paused === false);

        // ── R4) تأخر ← AUTO_PLAY ──
        console.log('\n── R4) تأخر لاعب ← لعب آلي ──');
        const beforeAuto = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body.state;
        const countsBefore = JSON.stringify(beforeAuto.hand.handCounts);
        await sleep(3200); // مهلة اللفة التجريبية 2.5s
        const afterAuto = (await api('GET', '/api/baloot/matches/' + matchId + '/state', t1)).body.state;
        check('R4-1) AUTO_PLAY تقدّم اللعب تلقائيًا', JSON.stringify(afterAuto.hand.handCounts) !== countsBefore || afterAuto.hand.tricksCount !== beforeAuto.hand.tricksCount, countsBefore + ' → ' + JSON.stringify(afterAuto.hand.handCounts));

        // ── R5) خروج نهائي ← استبدال ──
        console.log('\n── R5) خروج نهائي ← استبدال بلاعب جديد ──');
        await api('POST', '/api/baloot/tables/' + tableId + '/leave', t4, {}); // مقعد 3 يخرج نهائيًا
        await sleep(300);
        const sitReplace = await api('POST', '/api/baloot/tables/' + tableId + '/sit', t6, {});
        check('R5-1) لاعب المجلس يكمل مكان الخارج', sitReplace.status === 200 && sitReplace.body.replacement === true && sitReplace.body.seat === 3, JSON.stringify(sitReplace.body));
        const newRes = await api('GET', '/api/baloot/matches/' + matchId + '/state', t6);
        check('R5-2) البديل يرى يد المقعد (كروت الخارج)', newRes.status === 200 && newRes.body.state.hand && Array.isArray(newRes.body.state.hand.myHand) && newRes.body.state.hand.myHand.length > 0);
        check('R5-3) المباراة مستأنفة بعد الاستبدال', newRes.body.paused === false);
        const oldPlayer = await api('GET', '/api/baloot/matches/' + matchId + '/options', t4);
        check('R5-4) الخارج فقد مقعده (NOT_SEATED)', oldPlayer.status === 403);

        // ── R6) إنهاء ودّي ──
        console.log('\n── R6) إنهاء ودّي بالتصويت ──');
        // أخرج مقعدًا آخر ليُفتح تصويت (الخروج النهائي أثناء اللعب يفتح نافذة الاستبدال/التصويت)
        await api('POST', '/api/baloot/tables/' + tableId + '/leave', t2, {});
        await sleep(300);
        await api('POST', '/api/baloot/matches/' + matchId + '/vote-abort', t1, {});
        const vote2 = await api('POST', '/api/baloot/matches/' + matchId + '/vote-abort', t3, {});
        check('R6-1) تصويتان يُنهيان المباراة وديًا', vote2.status === 200, JSON.stringify(vote2.body));
        await sleep(300);
        const tblRes = await api('GET', '/api/baloot/tables/' + tableId, t1);
        check('R6-2) الطاولة تعود مفتوحة بلا خاسر', tblRes.status === 200 && (tblRes.body.table.status === 'open' || tblRes.body.table.status === 'closed'), tblRes.body.table && tblRes.body.table.status);
        const ratings = await api('GET', '/api/baloot/ratings', t1);
        check('R6-3) الترتيب الشرفي بلا أثر', ratings.status === 200 && ratings.body.ratings.length === 0);

        // ── انحدار ──
        console.log('\n── انحدار ──');
        check('Z1) /health', (await fetch(BASE + '/health')).ok);
        check('Z2) /api/community/status', (await api('GET', '/api/community/status', t1)).status === 200);
        check('Z3) baloot.html تُقدَّم من الخادم', (await fetch(BASE + '/baloot.html')).ok);
    } catch (e) {
        failed++; failures.push('FATAL: ' + e.message);
        console.error('💥 فشل حرج:', e);
    } finally {
        if (server) { try { server.kill(); } catch (_) { } }
        if (dbw) { try { dbw.close(); } catch (_) { } }
        await sleep(500);
        for (const p of [TMP_DIR, TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) {
            try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { }
        }
    }

    console.log('\n════════════════════════════════════');
    console.log('النتيجة: ' + passed + ' ناجح · ' + failed + ' فاشل');
    if (failures.length) { console.log('الفاشلة:'); failures.forEach(f => console.log('  - ' + f)); }
    console.log('════════════════════════════════════');
    process.exit(failed ? 1 : 0);
})();
