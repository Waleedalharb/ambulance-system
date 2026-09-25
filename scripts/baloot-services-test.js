// ============================================
// Baloot Services — جناح التكامل (D3)
// يثبت أن Engine + SQLite + Queue + Timers يعملون معًا — لا وحدات منفردة.
// قاعدة مؤقتة معزولة (tmp) — لا تلمس data/ambulance.db إطلاقًا.
// التشغيل: node scripts/baloot-services-test.js
// ============================================
'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { createBalootTables, makeBalootStore } = require('../db');
const engine = require('../services/baloot/engine');
const BalootTimerService = require('../services/baloot/baloot-timer-service');
const BalootMatchService = require('../services/baloot/baloot-match-service');
const BalootTableService = require('../services/baloot/baloot-table-service');

// ---------- عدّادات ----------
let passed = 0, failed = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); passed++; console.log('  ✅ ' + name); }
    catch (e) { failed++; failures.push([name, e]); console.log('  ❌ ' + name + ' — ' + e.message); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'تحقق فاشل'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'قيمة غير متوقعة') + ` — متوقع <${b}> حصل <${a}>`); }
async function throwsAsync(fn, code) {
    try { await fn(); } catch (e) {
        if (code && e.code !== code) throw new Error(`كود خطأ غير متوقع: ${e.code} (المتوقع ${code})`);
        return;
    }
    throw new Error('كان يجب رفض الفعل: ' + code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- بيئة معزولة ----------
function makeEnv(file) {
    const raw = new Database(file);
    const store = makeBalootStore({
        get: async (sql, p = []) => raw.prepare(sql).get(...p) || null,
        all: async (sql, p = []) => raw.prepare(sql).all(...p),
        run: async (sql, p = []) => {
            const r = raw.prepare(sql).run(...p);
            return { id: r.lastInsertRowid, changes: r.changes };
        }
    });

    const gate = {
        calls: 0, deny: new Set(),
        async evaluate(user) {
            this.calls++;
            return this.deny.has(String(user.id))
                ? { allowRead: true, allowParticipation: false, reason: 'OPERATIONAL_DUTY' }
                : { allowRead: true, allowParticipation: true, reason: null };
        }
    };
    const moderation = {
        blocked: new Set(),
        async isBlockedEitherWay(a, b) { return this.blocked.has(`${a}|${b}`) || this.blocked.has(`${b}|${a}`); }
    };
    const broadcasts = [];
    const broadcast = (matchId, events) => broadcasts.push({ matchId, events });

    const timers = new BalootTimerService({ store });
    const matchService = new BalootMatchService({
        store, timers, broadcast,
        seedNext: (() => { let s = 1000; return () => s++; })(),
        turnTtlMs: 90, reconnectTtlMs: 110, replaceWindowTtlMs: 140
    });
    const tableService = new BalootTableService({
        store, matchService, timers, gate, moderation, broadcast,
        readyCheckTtlMs: 120, lobbyIdleTtlMs: 120
    });
    matchService.onMatchEnd = (matchId) => tableService.onMatchEnded(matchId);
    matchService.onMatchAbort = (matchId) => tableService.onMatchAborted(matchId);

    return { raw, store, gate, moderation, timers, matchService, tableService, broadcasts };
}

const U = (id) => ({ id, name: 'مستخدم ' + id });

// طاولة مكتملة الجاهزية مع مباراة نشطة — يعيد { tableId, matchId }
async function startMatch(env, ids = ['u1', 'u2', 'u3', 'u4']) {
    const table = await env.tableService.createTable(U(ids[0]), 1);
    for (let i = 0; i < 4; i++) await env.tableService.sit(U(ids[i]), table.id);
    let matchId = null;
    for (let i = 0; i < 4; i++) {
        const r = await env.tableService.confirmReady(U(ids[i]), table.id);
        if (r.matchStarted) matchId = r.matchId;
    }
    return { tableId: table.id, matchId };
}

// إكمال صفقة/مباراة آليًا عبر مسارات الخدمة نفسها (بس ثم صن من يمين الموزّع)
async function autoHand(env, matchId) {
    let state = await env.matchService._load(matchId);
    let guard = 0;
    while (state.status === 'in_hand' && state.hand && guard++ < 200) {
        const h = state.hand;
        if (h.phase === 'bidding1' || h.phase === 'bidding2') {
            const players = await env.store.getMatchPlayers(matchId);
            const bidder = players.find((p) => p.seat === h.biddingTurn);
            // يمين الموزّع يشتري صن دائمًا لضمان التقدم
            if (h.biddingTurn === (h.dealerSeat + 1) % 4) {
                await env.matchService.submit(matchId, bidder.user_id, `bid-${state.handNumber}`, 'BID', { kind: 'sun' });
            } else {
                await env.matchService.submit(matchId, bidder.user_id, `pass-${state.handNumber}-${h.biddingTurn}`, 'BID', { kind: 'pass' });
            }
        } else if (h.phase === 'playing') {
            await env.matchService._serverApply(matchId, { type: 'AUTO_PLAY', seat: h.turnSeat });
        }
        await sleep(5);
        state = await env.matchService._load(matchId);
    }
    return state;
}

// ============================================
async function main() {
    console.log('\n🃏 Baloot Services — جناح التكامل (Engine + SQLite + Queue + Timers)\n');
    const tmp = path.join(os.tmpdir(), `baloot-it-${Date.now()}.db`);
    const tmp2 = path.join(os.tmpdir(), `baloot-it2-${Date.now()}.db`);

    // ---------- البنية والتخزين ----------
    console.log('— البنية والتخزين —');

    await t('S01 إنشاء الجداول idempotent على قاعدة معزولة', async () => {
        const env = makeEnv(tmp);
        await createBalootTables((sql) => env.raw.exec(sql));
        await createBalootTables((sql) => env.raw.exec(sql)); // مرة ثانية — لا خطأ
        const tables = env.raw.prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'baloot_%'`).all();
        eq(tables.length, 7, 'سبع جداول baloot_*');
        env.raw.close();
    });

    await t('S02 لا جدول baloot_* يقرأ أو يشير إلى جدول تشغيلي (فحص DDL)', async () => {
        const env = makeEnv(tmp2);
        await createBalootTables((sql) => env.raw.exec(sql));
        const ddl = env.raw.prepare(
            `SELECT sql FROM sqlite_master WHERE name LIKE 'baloot_%'`).all().map((r) => r.sql).join('\n');
        for (const bad of ['shifts', 'teams', 'employees', 'team_live_locations', 'operational_', 'reports']) {
            ok(!ddl.includes(bad), `DDL نظيف من ${bad}`);
        }
        env.raw.close();
    });

    // ---------- اللوبي والجلوس ----------
    console.log('— اللوبي والجلوس (البوابة عند الجلوس فقط) —');

    await t('S03 فتح طاولة + جلوس 4 ← ready_check · البوابة استُدعيت 4 مرات فقط', async () => {
        const env = makeEnv(tmp);
        await createBalootTables((sql) => env.raw.exec(sql));
        const table = await env.tableService.createTable(U('u1'), 1);
        eq(table.status, 'open');
        for (const id of ['u1', 'u2', 'u3', 'u4']) await env.tableService.sit(U(id), table.id);
        const after = await env.store.getTable(table.id);
        eq(after.status, 'ready_check');
        eq(env.gate.calls, 4, 'استدعاء واحد لكل جلوس — لا أكثر');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S04 البوابة تمنع الجلوس عند OPERATIONAL_DUTY', async () => {
        const env = makeEnv(tmp);
        env.gate.deny.add('u9');
        const table = await env.tableService.createTable(U('u1'), 1);
        await throwsAsync(() => env.tableService.sit(U('u9'), table.id), 'GATE_DENIED');
        const seats = await env.store.getSeats(table.id);
        eq(seats.length, 0, 'لا مقعد بعد الرفض');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S05 الحظر المتبادل يمنع الجلوس مع محظور/حاظر', async () => {
        const env = makeEnv(tmp);
        const table = await env.tableService.createTable(U('u1'), 1);
        await env.tableService.sit(U('u1'), table.id);
        env.moderation.blocked.add('u1|u2');
        await throwsAsync(() => env.tableService.sit(U('u2'), table.id), 'BLOCKED');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S06 جاهزية الأربعة ← المباراة تبدأ والصفقة الأولى تُوزَّع خادميًا', async () => {
        const env = makeEnv(tmp);
        const { tableId, matchId } = await startMatch(env);
        const table = await env.store.getTable(tableId);
        eq(table.status, 'in_match');
        const match = await env.store.getMatch(matchId);
        eq(match.status, 'active');
        const state = await env.matchService._load(matchId);
        ok(state.hand, 'صفقة قائمة');
        eq(state.hand.hands[0].length, 5, 'خمس أوراق قبل حسم السوق');
        const actions = await env.store.getActions(matchId);
        eq(actions[0].type, 'START_HAND', 'أول فعل مسجل: بدء الصفقة الخادمي');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S07 من لم يؤكد الجاهزية خلال المهلة يعود مقعده فارغًا بلا حرج', async () => {
        const env = makeEnv(tmp);
        const table = await env.tableService.createTable(U('u1'), 1);
        for (const id of ['u1', 'u2', 'u3', 'u4']) await env.tableService.sit(U(id), table.id);
        await env.tableService.confirmReady(U('u1'), table.id);
        await env.tableService.confirmReady(U('u2'), table.id);
        await sleep(220); // ready_check = 120ms
        const after = await env.store.getTable(table.id);
        eq(after.status, 'open');
        const seats = await env.store.getSeats(table.id);
        eq(seats.length, 2, 'المؤكدون فقط بقوا');
        ok(seats.every((s) => !s.ready), 'الجاهزية صُفّرت');
        env.timers.shutdown(); env.raw.close();
    });

    // ---------- اللعب عبر الطابور ----------
    console.log('— اللعب: طابور متسلسل + Idempotency + سجل الحقيقة —');

    await t('S08 فعل لاعب يمر عبر المحرك ويُسجَّل بـ seq متسلسل', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        const state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        const r = await env.matchService.submit(matchId, bidder.user_id, 'a-1', 'BID', { kind: 'sun' });
        eq(r.ok, true);
        eq(r.seq, 2, 'seq بعد START_HAND');
        const after = await env.matchService._load(matchId);
        eq(after.hand.phase, 'playing');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S09 Idempotency حقيقي: نفس action_id مرتين ← نتيجة واحدة وتطبيق واحد', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        const state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        const r1 = await env.matchService.submit(matchId, bidder.user_id, 'same-id', 'BID', { kind: 'sun' });
        const r2 = await env.matchService.submit(matchId, bidder.user_id, 'same-id', 'BID', { kind: 'sun' });
        eq(r2.idempotent, true);
        eq(r2.seq, r1.seq);
        const actions = await env.store.getActions(matchId);
        eq(actions.length, 2, 'فعلان فقط: START_HAND + BID — لا ازدواج');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S10 تزامن: ضغطتان متزامنتان يحسمهما الطابور — تطبيق واحد صحيح فقط', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        let state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        await env.matchService.submit(matchId, bidder.user_id, 'bid-1', 'BID', { kind: 'sun' });
        state = await env.matchService._load(matchId);
        const turnUser = players.find((p) => p.seat === state.hand.turnSeat);
        const card = state.hand.hands[state.hand.turnSeat][0];
        const results = await Promise.allSettled([
            env.matchService.submit(matchId, turnUser.user_id, 'p-1', 'PLAY_CARD', { card }),
            env.matchService.submit(matchId, turnUser.user_id, 'p-2', 'PLAY_CARD', { card })
        ]);
        const succeeded = results.filter((r) => r.status === 'fulfilled').length;
        const rejected = results.filter((r) => r.status === 'rejected').length;
        eq(succeeded, 1, 'حركة واحدة تُقبل');
        eq(rejected, 1, 'والثانية تُرد بود');
        const after = await env.matchService._load(matchId);
        eq(after.hand.currentTrick.length, 1, 'ورقة واحدة على الأرض — لا ازدواج');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S11 العميل لا يحدد مقعده — الخادم يربط الفعل بمقعد اللاعب', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        const state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        // يحاول تمرير seat مختلفًا في الـ payload — يجب تجاهله
        const r = await env.matchService.submit(matchId, bidder.user_id, 'bid-x', 'BID', { kind: 'sun', seat: 3 });
        eq(r.ok, true);
        const after = await env.matchService._load(matchId);
        eq(after.hand.contract.buyerSeat, bidder.seat, 'المشتري = مقعد اللاعب الفعلي لا المُدعّى');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S12 غير الجالس لا يلعب، والمباراة المتوقفة ترفض اللعب', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        await throwsAsync(() => env.matchService.submit(matchId, 'outsider', 'x-1', 'BID', { kind: 'sun' }), 'NOT_SEATED');
        const players = await env.store.getMatchPlayers(matchId);
        await env.matchService.disconnect(matchId, players[0].user_id);
        await throwsAsync(
            () => env.matchService.submit(matchId, players[1].user_id, 'x-2', 'BID', { kind: 'sun' }),
            'MATCH_PAUSED');
        env.timers.shutdown(); env.raw.close();
    });

    // ---------- المؤقتات والحالات غير الطبيعية ----------
    console.log('— المؤقتات والانقطاع والاستبدال —');

    await t('S13 مهلة الدور ← لعب آلي محايد مسجل ومعلن (ruleset §11)', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        let state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        await env.matchService.submit(matchId, bidder.user_id, 'bid-t', 'BID', { kind: 'sun' });
        await sleep(250); // مهلة الدور 90ms
        const actions = await env.store.getActions(matchId);
        ok(actions.some((a) => a.type === 'AUTO_PLAY'), 'AUTO_PLAY مسجل في سجل الحقيقة');
        state = await env.matchService._load(matchId);
        ok(state.hand.currentTrick.length + state.hand.tricks.length > 0, 'اللعب تقدّم آليًا');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S14 انقطاع ← إيقاف أنيق وتعليق مهلة الدور · عودة ← استئناف كامل بنفس الكروت', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        let state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        await env.matchService.submit(matchId, bidder.user_id, 'bid-d', 'BID', { kind: 'sun' });
        state = await env.matchService._load(matchId);
        const turnSeat = state.hand.turnSeat;
        const turnUser = players.find((p) => p.seat === turnSeat);
        const cardsBefore = JSON.stringify(state.hand.hands[turnSeat]);

        await env.matchService.disconnect(matchId, turnUser.user_id);
        let row = await env.store.getMatch(matchId);
        eq(row.paused, 1, 'المباراة متوقفة بانتظار المنقطع');
        await sleep(200); // أطول من مهلة الدور — لو لم تُعلَّق لَلَعِب آليًا
        state = await env.matchService._load(matchId);
        eq(state.hand.currentTrick.length, 0, 'لا لعب آلي أثناء الإيقاف — اللعب وقف بأناقة');

        await env.matchService.reconnect(matchId, turnUser.user_id);
        row = await env.store.getMatch(matchId);
        eq(row.paused, 0, 'استؤنفت');
        state = await env.matchService._load(matchId);
        eq(JSON.stringify(state.hand.hands[turnSeat]), cardsBefore, 'نفس المقعد ونفس الكروت — استئناف لا بدء من جديد');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S15 انتهاء مهلة العودة ← مقعد خارج ← استبدال يكمل بكروته', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        let state = await env.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        await env.matchService.submit(matchId, bidder.user_id, 'bid-r', 'BID', { kind: 'sun' });
        const gateCallsBefore = env.gate.calls;

        await env.matchService.disconnect(matchId, players[1].user_id);
        await sleep(200); // reconnect = 110ms ← انتهت
        let row = await env.store.getMatch(matchId);
        ok(row.vote_state, 'نافذة استبدال مفتوحة');
        const outSeat = JSON.parse(row.vote_state).outSeat;
        eq(outSeat, players[1].seat);
        state = await env.matchService._load(matchId);
        const cardsOfSeat = JSON.stringify(state.hand.hands[outSeat]);

        // لاعب جديد من المجلس يجلس على المقعد الخارج — يمر بالبوابة (جلوس جديد)
        await env.tableService.sit(U('u-new'), row.table_id);
        eq(env.gate.calls, gateCallsBefore + 1, 'الاستبدال = جلوس جديد يمر بالبوابة');
        row = await env.store.getMatch(matchId);
        eq(row.paused, 0, 'استؤنفت بعد الاستبدال');
        const newPlayers = await env.store.getMatchPlayers(matchId);
        const repl = newPlayers.find((p) => p.seat === outSeat);
        eq(repl.user_id, 'u-new');
        eq(repl.joined_via, 'replacement');
        state = await env.matchService._load(matchId);
        eq(JSON.stringify(state.hand.hands[outSeat]), cardsOfSeat, 'المستبدل يكمل بكروت الخارج');
        // والمستبدل يستطيع اللعب فعلًا
        if (state.hand.turnSeat === outSeat) {
            const card = state.hand.hands[outSeat][0];
            const r = await env.matchService.submit(matchId, 'u-new', 'repl-play', 'PLAY_CARD', { card });
            eq(r.ok, true);
        }
        env.timers.shutdown(); env.raw.close();
    });

    await t('S16 لا استبدال خلال النافذة ← إنهاء ودّي «غير مكتملة» بلا خاسر ولا أثر على الترتيب', async () => {
        const env = makeEnv(tmp);
        const { matchId, tableId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        await env.matchService.disconnect(matchId, players[2].user_id);
        await sleep(350); // reconnect 110 + replace_window 140
        const row = await env.store.getMatch(matchId);
        eq(row.status, 'aborted');
        eq(row.outcome, 'aborted');
        const ratings = await env.store.getRatings();
        eq(ratings.length, 0, 'لا ترتيب من مباراة غير مكتملة');
        const table = await env.store.getTable(tableId);
        ok(['open', 'closed'].includes(table.status), 'الطاولة عادت أو أُغلقت بهدوء');
        const actions = await env.store.getActions(matchId);
        ok(actions.some((a) => a.type === 'ABORTED'), 'الإنهاء الودّي فعل مسجل');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S17 تصويت الجالسين المتبقين (2 من 3) يحسم الإنهاء الودّي فورًا', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const players = await env.store.getMatchPlayers(matchId);
        await env.matchService.disconnect(matchId, players[0].user_id);
        await sleep(200); // مقعد خارج
        await env.matchService.voteFriendlyAbort(matchId, players[1].user_id);
        let row = await env.store.getMatch(matchId);
        eq(row.status, 'active', 'صوت واحد لا يكفي');
        await env.matchService.voteFriendlyAbort(matchId, players[2].user_id);
        row = await env.store.getMatch(matchId);
        eq(row.status, 'aborted', 'الأغلبية حسمت');
        env.timers.shutdown(); env.raw.close();
    });

    // ---------- البقاء عبر Restart + الحقيقة في السجل ----------
    console.log('— البقاء عبر Restart وإثبات أن السجل هو الحقيقة —');

    await t('S18 إقلاع جديد: المهل الفائتة تُستهلك فورًا والقادمة تُسلَّح', async () => {
        const file = path.join(os.tmpdir(), `baloot-boot-${Date.now()}.db`);
        const env1 = makeEnv(file);
        await createBalootTables((sql) => env1.raw.exec(sql));
        let fired = null;
        env1.timers.register('turn', async (d) => { fired = d; });
        // مهلة فائتة (كأن الخادم توقف عنها) + مهلة قادمة
        await env1.store.insertDeadline({ matchId: 999, kind: 'turn', fireAt: Date.now() - 5000, payload: { seat: 2 } });
        await env1.store.insertDeadline({ matchId: 999, kind: 'turn', fireAt: Date.now() + 60000, payload: { seat: 3 } });

        // «إعادة تشغيل»: خدمة مؤقتات جديدة على القاعدة نفسها
        const timers2 = new BalootTimerService({ store: env1.store });
        let fired2 = null;
        timers2.register('turn', async (d) => { fired2 = d; });
        const boot = await timers2.onBoot();
        eq(boot.fired, 1, 'الفائتة استُهلكت فورًا');
        eq(boot.armed, 1, 'والقادمة سُلِّحت');
        eq(fired2.payload.seat, 2);
        const pending = await env1.store.pendingDeadlines();
        eq(pending.length, 1, 'الفائتة استُهلكت — لا إطلاق مزدوج');
        timers2.shutdown();
        env1.timers.shutdown(); env1.raw.close();
        fs.unlinkSync(file);
    });

    await t('S19 إعادة البناء من السجل = اللقطة تمامًا (السجل هو الحقيقة، اللقطة checkpoint)', async () => {
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        await autoHand(env, matchId); // صفقة كاملة بالأفعال المسجلة
        await sleep(30);              // START_HAND التلقائي للصفقة التالية
        const row = await env.store.getMatch(matchId);
        const snapshot = JSON.parse(row.snapshot_json);
        const replayed = await env.matchService.replayFromScratch(matchId);
        eq(JSON.stringify(replayed), JSON.stringify(snapshot),
            'البذرة + سجل الأفعال يعيدان الحالة حرفيًا');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S20 خدمة جديدة على القاعدة نفسها تكمل المباراة بعد «إعادة التشغيل»', async () => {
        const file = path.join(os.tmpdir(), `baloot-restart-${Date.now()}.db`);
        const env1 = makeEnv(file);
        await createBalootTables((sql) => env1.raw.exec(sql));
        const { matchId } = await startMatch(env1);
        const players = await env1.store.getMatchPlayers(matchId);
        let state = await env1.matchService._load(matchId);
        const bidder = players.find((p) => p.seat === state.hand.biddingTurn);
        await env1.matchService.submit(matchId, bidder.user_id, 'bid-restart', 'BID', { kind: 'sun' });
        env1.timers.shutdown(); // «توقف الخادم»
        env1.raw.close();

        // «إقلاع جديد»: خدمات جديدة كليًا على ملف القاعدة نفسه
        const env2 = makeEnv(file);
        await env2.timers.onBoot(); // إعادة تسليح المهل المعلقة
        const state2 = await env2.matchService._load(matchId); // من اللقطة/السجل — لا ذاكرة
        ok(state2.hand && state2.hand.phase === 'playing', 'الحالة استُعيدت كاملة بعد الإقلاع');
        const r = await env2.matchService.submit(
            matchId, players.find((p) => p.seat === state2.hand.turnSeat).user_id,
            'after-restart', 'PLAY_CARD', { card: state2.hand.hands[state2.hand.turnSeat][0] });
        eq(r.ok, true, 'المباراة تكمل بعد إعادة التشغيل كأن شيئًا لم يكن');
        env2.timers.shutdown(); env2.raw.close();
        fs.unlinkSync(file);
    });

    // ---------- المباراة الكاملة والترتيب والريماچ ----------
    console.log('— مباراة كاملة: نهاية ← ترتيب شرفي ← ريماچ —');

    await t('S21 مباراة كاملة إلى 152 عبر الخدمات + ترتيب شرفي مشتق + طاولة post_match', async () => {
        const env = makeEnv(tmp);
        const { matchId, tableId } = await startMatch(env);
        let match = await env.store.getMatch(matchId);
        let guard = 0;
        while (match.status === 'active' && guard++ < 40) {
            await autoHand(env, matchId);
            await sleep(30);
            match = await env.store.getMatch(matchId);
        }
        eq(match.status, 'finished', 'المباراة اكتملت');
        ok(match.outcome === 'A' || match.outcome === 'B');
        const table = await env.store.getTable(tableId);
        eq(table.status, 'post_match');
        const ratings = await env.store.getRatings();
        eq(ratings.length, 4, 'الأربعة في الترتيب');
        const winners = ratings.filter((r) => r.wins === 1);
        eq(winners.length, 2, 'فريق فائز = لاعبان');
        eq(winners[0].honor_points, 3);
        const losers = ratings.filter((r) => r.losses === 1);
        eq(losers.length, 2);
        const players = await env.store.getMatchPlayers(matchId);
        ok(players.every((p) => p.final_score !== null && p.outcome), 'نتائج اللاعبين مسجلة');
        // الريماچ: موافقة الأربعة ← مباراة جديدة بنفس المقاعد (قرار المالك)
        let rematchId = null;
        for (const id of ['u1', 'u2', 'u3', 'u4']) {
            const r = await env.tableService.rematchAccept(U(id), tableId);
            if (r.matchStarted) rematchId = r.matchId;
        }
        ok(rematchId && rematchId !== matchId, 'مباراة ثانية بدأت بالأربعة');
        const table2 = await env.store.getTable(tableId);
        eq(table2.status, 'in_match');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S22 رفض واحد يلغي الريماچ بهدوء وتعود الطاولة مفتوحة', async () => {
        const env = makeEnv(tmp);
        const { matchId, tableId } = await startMatch(env);
        let match = await env.store.getMatch(matchId);
        let guard = 0;
        while (match.status === 'active' && guard++ < 40) {
            await autoHand(env, matchId);
            await sleep(30);
            match = await env.store.getMatch(matchId);
        }
        await env.tableService.rematchAccept(U('u1'), tableId);
        await env.tableService.rematchDecline(U('u2'), tableId);
        const table = await env.store.getTable(tableId);
        eq(table.status, 'open', 'رفض واحد ألغى الريماچ');
        env.timers.shutdown(); env.raw.close();
    });

    await t('S23 العزل التشغيلي: البوابة لم تُستدعَ أثناء أي مباراة — عند الجلوس فقط (A8)', async () => {
        // عبر كل السيناريوهات السابقة: gate.calls = عدد الجلسات فقط.
        // هنا اختبار صريح: مباراة كاملة بلا أي استدعاء إضافي
        const env = makeEnv(tmp);
        const { matchId } = await startMatch(env);
        const callsAfterSitting = env.gate.calls;
        await autoHand(env, matchId);
        await sleep(30);
        eq(env.gate.calls, callsAfterSitting, 'صفر استدعاءات بوابة داخل المباراة');
        env.timers.shutdown(); env.raw.close();
    });

    // ============================================
    console.log(`\n========================================`);
    console.log(`النتيجة: ${passed} ناجح · ${failed} فاشل`);
    for (const f of [tmp, tmp2]) { try { fs.unlinkSync(f); } catch (_) {} }
    if (failed) {
        console.log('\nالفاشلات:');
        for (const [name, e] of failures) console.log(`  ❌ ${name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
        process.exit(1);
    }
    console.log('✅ جناح تكامل خدمات البلوت أخضر بالكامل\n');
    process.exit(0);
}

main().catch((e) => { console.error('انهيار الجناح:', e); process.exit(1); });
