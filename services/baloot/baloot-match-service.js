// ============================================
// BalootMatchService — D3 (Architecture Freeze §5/§6/§7)
// التزامن + Idempotency + سجل الحقيقة + توصية المحرك النقي.
// ❗ هذه الخدمة لا تحتوي أي منطق قواعد بلوت — كل فعل لعب يمر عبر المحرك النقي.
// ❗ لا تستدعي البوابة التشغيلية إطلاقًا — الجلوس شأن baloot-table-service فقط.
// ============================================
'use strict';

const crypto = require('crypto');
const engine = require('./engine');

// المهل (Architecture §7.2 — معلنة للمستخدم قبل أن تفاجئه)
const TURN_TTL_MS = 30 * 1000;
const RECONNECT_TTL_MS = 120 * 1000;
const REPLACE_WINDOW_TTL_MS = 60 * 1000;

function makeError(code, message) {
    const e = new Error(message); e.code = code; return e;
}

class BalootMatchService {
    /**
     * @param {object} deps
     * @param {object} deps.store    — makeBalootStore
     * @param {object} deps.timers   — BalootTimerService
     * @param {function} [deps.broadcast] — (matchId, events) hook للبث اللاحق (WS مرحلة لاحقة)
     * @param {function} [deps.onMatchEnd] — (matchId, {winner, reason}) hook لخدمة الطاولة
     * @param {function} [deps.onMatchAbort] — (matchId) hook
     * @param {function} [deps.seedNext] — مولّد البذرة (قابل للحقن في الاختبارات)
     */
    constructor({ store, timers, broadcast, onMatchEnd, onMatchAbort, seedNext,
        turnTtlMs, reconnectTtlMs, replaceWindowTtlMs }) {
        if (!store) throw new Error('BalootMatchService: store مطلوب');
        if (!timers) throw new Error('BalootMatchService: timers مطلوب');
        this.store = store;
        this.timers = timers;
        this.broadcast = broadcast || (() => {});
        this.onMatchEnd = onMatchEnd || (() => {});
        this.onMatchAbort = onMatchAbort || (() => {});
        this.seedNext = seedNext || (() => crypto.randomInt(0, 2 ** 31));
        // قيم المهل قابلة للحقن للاختبارات — الافتراضي من Architecture §7.2
        this.turnTtlMs = turnTtlMs ?? TURN_TTL_MS;
        this.reconnectTtlMs = reconnectTtlMs ?? RECONNECT_TTL_MS;
        this.replaceWindowTtlMs = replaceWindowTtlMs ?? REPLACE_WINDOW_TTL_MS;
        this._queues = new Map();  // matchId → Promise — طابور متسلسل مستقل لكل مباراة (A4)
        this._states = new Map();  // matchId → engineState (cache — مصدر الحقيقة هو السجل)

        // مهل المباراة توجَّه هنا
        this.timers.register('turn', (d) => this._onTurnTimeout(d));
        this.timers.register('reconnect', (d) => this._onReconnectExpired(d));
        this.timers.register('replace_window', (d) => this._onReplaceWindowExpired(d));
    }

    // ---------- الطابور المتسلسل لكل مباراة (A4) ----------
    _enqueue(matchId, fn) {
        const prev = this._queues.get(matchId) || Promise.resolve();
        const next = prev.then(fn, fn); // فشل سابق لا يكسر الطابور
        this._queues.set(matchId, next.catch(() => {}));
        return next;
    }

    // ---------- التحميل/الاستعادة ----------
    async _load(matchId) {
        const cached = this._states.get(matchId);
        if (cached) return cached;
        const row = await this.store.getMatch(matchId);
        if (!row || !row.snapshot_json) throw makeError('MATCH_NOT_FOUND', 'المباراة غير موجودة');
        const state = JSON.parse(row.snapshot_json);
        this._states.set(matchId, state);
        return state;
    }

    // إثبات «السجل هو الحقيقة»: إعادة بناء كاملة من البذرة + سجل الأفعال فقط
    async replayFromScratch(matchId) {
        const row = await this.store.getMatch(matchId);
        if (!row) throw makeError('MATCH_NOT_FOUND', 'المباراة غير موجودة');
        let state = engine.createMatch({ seed: row.seed, targetScore: undefined });
        const actions = await this.store.getActions(matchId);
        for (const a of actions) {
            if (!a.via_engine) continue;
            const r = engine.applyAction(state, JSON.parse(a.payload_json));
            state = r.state;
        }
        return state;
    }

    // ---------- إنشاء مباراة لطاولة مكتملة ----------
    async createMatchForTable(table, seats) {
        const seed = this.seedNext();
        const matchId = await this.store.createMatch({
            tableId: table.id, rulesetVersion: table.ruleset_version, seed
        });
        for (const s of seats) {
            await this.store.addMatchPlayer(matchId, s.seat, s.user_id, s.joined_via || 'original');
        }
        const state = engine.createMatch({ seed, targetScore: table.target_score });
        this._states.set(matchId, state);
        // أول صفقة تبدأ تلقائيًا من الخادم (Vision §1.4)
        await this._serverApply(matchId, { type: 'START_HAND' });
        return matchId;
    }

    // ---------- أفعال اللاعبين (BID/DECLARE/PLAY_CARD/DOUBLE) ----------
    // actionId (UUID من العميل) — Idempotency حقيقي بقيد UNIQUE (A5)
    async submit(matchId, userId, actionId, type, payload = {}) {
        return this._enqueue(matchId, async () => {
            const allowed = ['BID', 'DECLARE', 'PLAY_CARD', 'DOUBLE'];
            if (!allowed.includes(type)) throw makeError('ACTION_NOT_ALLOWED', 'نوع فعل غير مسموح من اللاعب');

            const idemKey = `${userId}:${actionId}`;
            const prev = await this.store.getActionByIdempotency(matchId, idemKey);
            if (prev) {
                return { ok: true, seq: prev.seq, idempotent: true, result: safeJson(prev.result_json) };
            }

            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') throw makeError('MATCH_NOT_ACTIVE', 'المباراة غير نشطة');
            if (row.paused) throw makeError('MATCH_PAUSED', 'المباراة متوقفة مؤقتًا بانتظار لاعب');

            const players = await this.store.getMatchPlayers(matchId);
            const me = players.find((p) => p.user_id === String(userId));
            if (!me) throw makeError('NOT_SEATED', 'لست جالسًا على هذه الطاولة');

            // المقعد من ربط الخادم — العميل لا يحدد مقعده (Server Authority)
            const action = { type, ...payload, seat: me.seat };
            const { seq } = await this._applyEngine(matchId, String(userId), idemKey, action);
            return { ok: true, seq, idempotent: false };
        });
    }

    // ---------- «خياراتي الآن» — جسّ على المحرك النقي بلا تكرار قواعد ----------
    // applyAction يستنسخ الحالة داخليًا (structuredClone) — الجسّ بلا أي أثر جانبي.
    // الواجهة تعرض فقط ما يرجعه هذا المسار: المسموح واضح والممنوع غير معروض أصلًا.
    async optionsFor(matchId, userId) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row) throw makeError('MATCH_NOT_FOUND', 'المباراة غير موجودة');
            const players = await this.store.getMatchPlayers(matchId);
            const me = players.find((p) => p.user_id === String(userId));
            if (!me) throw makeError('NOT_SEATED', 'لست جالسًا على هذه الطاولة');
            const state = await this._load(matchId);
            const seat = me.seat;
            const out = {
                phase: state.hand ? state.hand.phase : state.status,
                status: row.status, paused: !!row.paused,
                mySeat: seat, myTurn: false,
                bids: [], cards: [], balootCards: [], projects: [], doubles: []
            };
            if (row.status !== 'active' || row.paused || !state.hand) return out;
            const hand = state.hand;
            const probe = (action) => {
                try { engine.applyAction(state, { ...action, seat }); return true; }
                catch (_) { return false; }
            };
            if ((hand.phase === 'bidding1' || hand.phase === 'bidding2') && hand.biddingTurn === seat) {
                out.myTurn = true;
                if (probe({ type: 'BID', kind: 'pass' })) out.bids.push({ kind: 'pass' });
                if (probe({ type: 'BID', kind: 'sun' })) out.bids.push({ kind: 'sun' });
                for (const ts of ['S', 'H', 'D', 'C']) {
                    if (probe({ type: 'BID', kind: 'hokum', trumpSuit: ts })) out.bids.push({ kind: 'hokum', trumpSuit: ts });
                }
                if (probe({ type: 'BID', kind: 'ashkal' })) out.bids.push({ kind: 'ashkal' });
            }
            if (hand.phase === 'playing') {
                if (hand.turnSeat === seat) {
                    out.myTurn = true;
                    out.cards = engine.listLegalPlays(hand, seat);
                    for (const c of out.cards) {
                        if (probe({ type: 'PLAY_CARD', card: c, baloot: true })) out.balootCards.push(c);
                    }
                }
                // المشاريع تُعلن قبل أول ورقة لي — الجسّ يفرض ذلك بنفسه
                const detected = engine.detectProjects(hand.hands[seat], hand.contract);
                const declared = hand.declarations.declared[seat] || [];
                for (const d of detected) {
                    const dup = declared.some((x) => x.type === d.type && x.suit === d.suit && x.rank === d.rank && x.topRank === d.topRank);
                    if (!dup && probe({ type: 'DECLARE', projects: [d] })) {
                        out.projects.push({ type: d.type, suit: d.suit, rank: d.rank, topRank: d.topRank });
                    }
                }
                // الدبلات لا تتطلب أن يكون دوري في اللعب (ruleset §9 — أثناء طور اللعب)
                for (const kind of ['dabal', 'thri', 'fur', 'qahwa']) {
                    if (probe({ type: 'DOUBLE', kind })) out.doubles.push(kind);
                }
            }
            return out;
        });
    }

    // ---------- أفعال الخادم (START_HAND / AUTO_PLAY) ----------
    async _serverApply(matchId, action) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') return null;
            return this._applyEngine(matchId, 'server', null, action);
        });
    }

    // ---------- النواة: محرك ← سجل ← لقطة ← أحداث ----------
    async _applyEngine(matchId, actorUserId, idemKey, action) {
        const state = await this._load(matchId);
        const r = engine.applyAction(state, action); // الرفض هنا = خطأ نظامي بود — لا يُسجَّل كفعل
        const newState = r.state;
        const events = r.events;

        const seq = await this.store.nextActionSeq(matchId);
        await this.store.appendAction({
            matchId, seq, actorUserId, type: action.type,
            payload: action, idempotencyKey: idemKey,
            result: { ok: true, seq }, viaEngine: true
        });
        await this.store.saveSnapshot(matchId, newState.seq, JSON.stringify(newState));
        this._states.set(matchId, newState);

        this.broadcast(matchId, events);
        await this._afterEvents(matchId, newState, events);
        return { seq, events };
    }

    // تسجيل فعل غير محركي (انقطاع/عودة/استبدال/تصويت/ريماچ) — في السجل نفسه
    async _logServiceAction(matchId, actorUserId, type, payload) {
        const seq = await this.store.nextActionSeq(matchId);
        await this.store.appendAction({
            matchId, seq, actorUserId, type, payload, viaEngine: false
        });
        return seq;
    }

    // ---------- ما بعد الأحداث: مهل + تدفق الصفقات + النهاية ----------
    async _afterEvents(matchId, state, events) {
        const row = await this.store.getMatch(matchId);

        for (const e of events) {
            if (e.type === 'hand_scored' && state.status === 'awaiting_hand') {
                // الصفقة التالية تلقائيًا (Vision §1.5) — فعل خادمي مسجل
                setImmediate(() => this._serverApply(matchId, { type: 'START_HAND' }).catch(() => {}));
            }
            if (e.type === 'redeal') {
                setImmediate(() => this._serverApply(matchId, { type: 'START_HAND' }).catch(() => {}));
            }
            if (e.type === 'match_ended') {
                await this.timers.cancel({ matchId });
                await this._finalizeMatch(matchId, state, e);
            }
        }

        // مهلة الدور: تُسلَّح فقط في طور اللعب وبلا إيقاف مؤقت
        if (state.status === 'in_hand' && state.hand && state.hand.phase === 'playing' && !row.paused) {
            await this.timers.cancel({ matchId, kinds: ['turn'] });
            await this.timers.schedule({
                matchId, kind: 'turn', ttlMs: this.turnTtlMs,
                payload: { seat: state.hand.turnSeat }
            });
        } else {
            await this.timers.cancel({ matchId, kinds: ['turn'] });
        }
    }

    async _finalizeMatch(matchId, state, endEvent) {
        const winner = endEvent.winner;
        await this.store.finishMatch(matchId, 'finished', winner);
        const players = await this.store.getMatchPlayers(matchId);
        for (const p of players) {
            const won = p.team === winner;
            await this.store.setMatchPlayerResult(matchId, p.seat, state.scores[p.team], won ? 'won' : 'lost');
            await this.store.bumpRating(p.user_id, won); // الترتيب الشرفي — read model مشتق
        }
        await this.onMatchEnd(matchId, { winner, reason: endEvent.reason, scores: state.scores });
    }

    // ---------- الانقطاع والعودة (Vision §1.8) ----------
    async disconnect(matchId, userId) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') return;
            const players = await this.store.getMatchPlayers(matchId);
            const me = players.find((p) => p.user_id === String(userId));
            if (!me) return;
            await this.store.setSeatFlags(row.table_id, me.seat, { disconnected: true });
            await this.store.setMatchPaused(matchId, true, 'disconnect');
            await this.timers.cancel({ matchId, kinds: ['turn'] });
            await this.timers.cancel({ matchId, kinds: ['reconnect'] });
            await this.timers.schedule({
                matchId, kind: 'reconnect', ttlMs: this.reconnectTtlMs,
                payload: { seat: me.seat, userId: String(userId) }
            });
            await this._logServiceAction(matchId, String(userId), 'DISCONNECT', { seat: me.seat });
            this.broadcast(matchId, [{ type: 'player_disconnected', seat: me.seat }]);
        });
    }

    async reconnect(matchId, userId) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') return;
            const players = await this.store.getMatchPlayers(matchId);
            const me = players.find((p) => p.user_id === String(userId));
            if (!me) return;
            await this.store.setSeatFlags(row.table_id, me.seat, { disconnected: false });
            await this.timers.cancel({ matchId, kinds: ['reconnect'] });
            await this.store.setMatchPaused(matchId, false, null);
            await this._logServiceAction(matchId, String(userId), 'RECONNECT', { seat: me.seat });
            // استئناف: إعادة تسليح مهلة الدور إن كان اللعب جاريًا
            const state = await this._load(matchId);
            if (state.status === 'in_hand' && state.hand && state.hand.phase === 'playing') {
                await this.timers.cancel({ matchId, kinds: ['turn'] });
                await this.timers.schedule({
                    matchId, kind: 'turn', ttlMs: this.turnTtlMs, payload: { seat: state.hand.turnSeat }
                });
            }
            this.broadcast(matchId, [{ type: 'player_reconnected', seat: me.seat }]);
        });
    }

    // انتهت مهلة العودة ← المقعد «خارج» + نافذة استبدال (Vision §1.8)
    async _onReconnectExpired({ matchId, payload }) {
        await this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || !row.paused) return; // عاد قبلها — لا شيء
            await this._markSeatOut(matchId, payload.seat, 'reconnect_expired');
        });
    }

    async _markSeatOut(matchId, seat, reason) {
        const row = await this.store.getMatch(matchId);
        if (!row || row.status !== 'active') return;
        await this.store.setSeatFlags(row.table_id, seat, { seatStatus: 'out' });
        await this.store.setVoteState(matchId, JSON.stringify({
            outSeat: seat, reason, votes: {}, openedAt: new Date().toISOString()
        }));
        await this.timers.schedule({
            matchId, kind: 'replace_window', ttlMs: this.replaceWindowTtlMs,
            payload: { seat }
        });
        await this._logServiceAction(matchId, 'server', 'SEAT_OUT', { seat, reason });
        this.broadcast(matchId, [{ type: 'seat_out', seat }]);
    }

    // خروج نهائي اختياري أثناء المباراة — نفس مسار انتهاء مهلة العودة
    async abandon(matchId, userId) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') throw makeError('MATCH_NOT_ACTIVE', 'لا مباراة نشطة');
            const players = await this.store.getMatchPlayers(matchId);
            const me = players.find((p) => p.user_id === String(userId));
            if (!me) throw makeError('NOT_SEATED', 'لست على هذه الطاولة');
            await this.store.setMatchPaused(matchId, true, 'abandon');
            await this.timers.cancel({ matchId, kinds: ['turn', 'reconnect'] });
            await this._logServiceAction(matchId, String(userId), 'ABANDON', { seat: me.seat });
            await this._markSeatOut(matchId, me.seat, 'abandon');
        });
    }

    // الاستبدال: لاعب من المجلس يكمل بكروت الخارج (Vision §1.8)
    // ❗ البوابة التشغيلية تحققت في table-service قبل استدعاء هذا المسار — جلوس جديد
    async takeOutSeat(matchId, seat, newUserId) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') throw makeError('MATCH_NOT_ACTIVE', 'المباراة غير نشطة');
            const vote = safeJson(row.vote_state);
            if (vote.outSeat !== seat) throw makeError('SEAT_NOT_OUT', 'هذا المقعد ليس شاغرًا للاستبدال');
            const players = await this.store.getMatchPlayers(matchId);
            if (players.some((p) => p.user_id === String(newUserId))) {
                throw makeError('ALREADY_SEATED', 'أنت جالس على هذه الطاولة');
            }
            await this.store.replaceMatchPlayerUser(matchId, seat, newUserId);
            await this.store.replaceSeatUser(row.table_id, seat, newUserId);
            await this.store.setVoteState(matchId, null);
            await this.timers.cancel({ matchId, kinds: ['replace_window'] });
            await this.store.setMatchPaused(matchId, false, null);
            await this._logServiceAction(matchId, String(newUserId), 'REPLACE', { seat });
            const state = await this._load(matchId);
            if (state.status === 'in_hand' && state.hand && state.hand.phase === 'playing') {
                await this.timers.cancel({ matchId, kinds: ['turn'] });
                await this.timers.schedule({
                    matchId, kind: 'turn', ttlMs: this.turnTtlMs, payload: { seat: state.hand.turnSeat }
                });
            }
            this.broadcast(matchId, [{ type: 'seat_replaced', seat }]);
        });
    }

    // تصويت الإنهاء الودّي: أغلبية الجالسين المتبقين (2 من 3) تحسم (Vision §1.8)
    async voteFriendlyAbort(matchId, userId) {
        return this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') throw makeError('MATCH_NOT_ACTIVE', 'المباراة غير نشطة');
            const vote = safeJson(row.vote_state);
            if (vote.outSeat === undefined) throw makeError('NO_VOTE_OPEN', 'لا تصويت مفتوحًا');
            const players = await this.store.getMatchPlayers(matchId);
            const me = players.find((p) => p.user_id === String(userId));
            if (!me || me.seat === vote.outSeat) throw makeError('VOTE_NOT_YOURS', 'التصويت للجالسين المتبقين');
            if (vote.votes[String(userId)]) return { ok: true, already: true };
            vote.votes[String(userId)] = 'abort';
            await this._logServiceAction(matchId, String(userId), 'ABORT_VOTE', { choice: 'abort', outSeat: vote.outSeat });
            if (Object.keys(vote.votes).length >= 2) {
                await this._abortMatch(matchId);
            } else {
                await this.store.setVoteState(matchId, JSON.stringify(vote));
            }
            return { ok: true };
        });
    }

    async _onReplaceWindowExpired({ matchId }) {
        await this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active') return;
            if (!row.vote_state) return; // تم الاستبدال
            await this._abortMatch(matchId); // لا استبدال خلال النافذة ← إنهاء ودّي تلقائي
        });
    }

    // الإنهاء الودّي: «غير مكتملة» بلا خاسر — لا أثر على الترتيب (Vision §1.8)
    async _abortMatch(matchId) {
        await this.timers.cancel({ matchId });
        await this.store.finishMatch(matchId, 'aborted', 'aborted');
        await this.store.setVoteState(matchId, null);
        await this._logServiceAction(matchId, 'server', 'ABORTED', {});
        this.broadcast(matchId, [{ type: 'match_aborted' }]);
        await this.onMatchAbort(matchId);
    }

    // ---------- مهلة الدور ← لعب آلي محايد معلن (ruleset §11) ----------
    async _onTurnTimeout({ matchId, payload }) {
        await this._enqueue(matchId, async () => {
            const row = await this.store.getMatch(matchId);
            if (!row || row.status !== 'active' || row.paused) return;
            const state = await this._load(matchId);
            if (!state.hand || state.hand.phase !== 'playing') return;
            if (state.hand.turnSeat !== payload.seat) return; // الدور تقدّم — مهلة قديمة
            await this._applyEngine(matchId, 'server', null, { type: 'AUTO_PLAY', seat: payload.seat });
        });
    }
}

function safeJson(s) {
    try { return JSON.parse(s || '{}'); } catch (_) { return {}; }
}

BalootMatchService.TURN_TTL_MS = TURN_TTL_MS;
BalootMatchService.RECONNECT_TTL_MS = RECONNECT_TTL_MS;
BalootMatchService.REPLACE_WINDOW_TTL_MS = REPLACE_WINDOW_TTL_MS;

module.exports = BalootMatchService;
