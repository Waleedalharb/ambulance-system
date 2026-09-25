// ============================================
// BalootTableService — D3 (Architecture Freeze §2.1/§15)
// دورة حياة الطاولة: فتح ← جلوس ← جاهزية ← مباراة ← ريماچ/إغلاق.
// ❗ النقطة الوحيدة التي تستدعي البوابة التشغيلية في منظومة البلوت:
//    «الجلوس» (sit / استبدال عبر takeOutSeatProxy) — مرة واحدة، وبعدها
//    صفر استعلامات تشغيلية حتى نهاية المباراة (قرار مجمّد A8).
// ❗ لا منطق قواعد هنا — القواعد كلها في المحرك النقي عبر match-service.
// ============================================
'use strict';

const READY_CHECK_TTL_MS = 60 * 1000;   // مهلة تأكيد الجاهزية (Architecture §7.2)
const LOBBY_IDLE_TTL_MS = 30 * 60 * 1000; // خمول الطاولة المفتوحة

function makeError(code, message) {
    const e = new Error(message); e.code = code; return e;
}

class BalootTableService {
    /**
     * @param {object} deps
     * @param {object} deps.store        — makeBalootStore
     * @param {object} deps.matchService — BalootMatchService
     * @param {object} deps.timers       — BalootTimerService
     * @param {object} deps.gate         — CommunityOperationalGateService (جلوس فقط)
     * @param {object} deps.moderation   — CommunityModerationService (isBlockedEitherWay)
     * @param {function} [deps.broadcast]
     */
    constructor({ store, matchService, timers, gate, moderation, broadcast, readyCheckTtlMs, lobbyIdleTtlMs }) {
        if (!store) throw new Error('BalootTableService: store مطلوب');
        if (!matchService) throw new Error('BalootTableService: matchService مطلوب');
        if (!timers) throw new Error('BalootTableService: timers مطلوب');
        if (!gate) throw new Error('BalootTableService: gate مطلوب');
        if (!moderation) throw new Error('BalootTableService: moderation مطلوب');
        this.store = store;
        this.matchService = matchService;
        this.timers = timers;
        this.gate = gate;
        this.moderation = moderation;
        this.broadcast = broadcast || (() => {});
        this.readyCheckTtlMs = readyCheckTtlMs ?? READY_CHECK_TTL_MS;
        this.lobbyIdleTtlMs = lobbyIdleTtlMs ?? LOBBY_IDLE_TTL_MS;

        // مهل الطاولة توجَّه هنا
        this.timers.register('ready_check', (d) => this._onReadyCheckExpired(d));
        this.timers.register('lobby_idle', (d) => this._onLobbyIdle(d));
    }

    // ---------- فتح طاولة ----------
    async createTable(user, councilId) {
        const tableId = await this.store.createTable({
            councilId,
            rulesetVersion: 'sa-standard-1.0',
            targetScore: 152,
            createdBy: user.id
        });
        await this.timers.schedule({ tableId, kind: 'lobby_idle', ttlMs: this.lobbyIdleTtlMs });
        return this.store.getTable(tableId);
    }

    // ---------- الجلوس — الاستدعاء الوحيد للبوابة التشغيلية ----------
    async sit(user, tableId, seat = null) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status === 'closed') throw makeError('TABLE_CLOSED', 'الطاولة مغلقة');
        if (table.status === 'in_match') {
            // أثناء المباراة لا جلوس إلا استبدال مقعد خارج — عبر matchService.takeOutSeat
            const match = await this.store.getActiveMatchForTable(tableId);
            if (!match || !match.vote_state) throw makeError('TABLE_IN_MATCH', 'الطاولة تلعب الآن — يمكنك المشاهدة');
            const vote = JSON.parse(match.vote_state);
            return this._sitReplacement(user, match, vote.outSeat);
        }
        if (table.status !== 'open' && table.status !== 'ready_check') {
            throw makeError('TABLE_NOT_OPEN', 'الطاولة غير متاحة للجلوس الآن');
        }

        const seats = await this.store.getSeats(tableId);
        if (seats.some((s) => s.user_id === String(user.id))) {
            throw makeError('ALREADY_SEATED', 'أنت جالس على هذه الطاولة');
        }

        // البوابة التشغيلية — مرة واحدة عند الجلوس فقط (A8 مجمّد)
        const g = await this.gate.evaluate(user);
        if (!g.allowParticipation) {
            const err = makeError('GATE_DENIED', 'لا يمكن الجلوس حاليًا');
            err.reason = g.reason; // OPERATIONAL_DUTY · ACTIVE_ASSIGNMENT · ATTENDANCE_STATE
            throw err;
        }

        // الحظر متبادل الأثر: من حظر/حُظر جالسًا لا يجلس معه (Architecture §15)
        for (const s of seats) {
            if (s.seat_status !== 'seated') continue;
            if (await this.moderation.isBlockedEitherWay(String(user.id), s.user_id)) {
                throw makeError('BLOCKED', 'لا يمكن الجلوس على هذه الطاولة');
            }
        }

        let targetSeat = seat;
        if (targetSeat == null) {
            const taken = new Set(seats.map((s) => s.seat));
            targetSeat = [0, 1, 2, 3].find((x) => !taken.has(x));
        }
        if (targetSeat === undefined || targetSeat < 0 || targetSeat > 3) {
            throw makeError('TABLE_FULL', 'الطاولة مكتملة');
        }
        if (seats.some((s) => s.seat === targetSeat && s.seat_status === 'seated')) {
            throw makeError('SEAT_TAKEN', 'هذا المقعد محجوز');
        }

        await this.store.sitSeat(tableId, targetSeat, user.id);
        this.broadcast(tableId, [{ type: 'seat_taken', seat: targetSeat }]);

        const after = await this.store.getSeats(tableId);
        const seated = after.filter((s) => s.seat_status === 'seated');
        if (seated.length === 4) {
            // اكتملت الطاولة ← فحص الجاهزية (Vision §1.4)
            await this.store.setTableStatus(tableId, 'ready_check');
            await this.timers.cancel({ tableId, kinds: ['lobby_idle'] });
            await this.timers.schedule({ tableId, kind: 'ready_check', ttlMs: this.readyCheckTtlMs });
            this.broadcast(tableId, [{ type: 'table_full' }]);
        }
        return { tableId, seat: targetSeat };
    }

    // جلوس استبدال أثناء مباراة — يمر بالبوابة أيضًا (جلوس جديد)
    async _sitReplacement(user, match, outSeat) {
        const g = await this.gate.evaluate(user);
        if (!g.allowParticipation) {
            const err = makeError('GATE_DENIED', 'لا يمكن الجلوس حاليًا');
            err.reason = g.reason;
            throw err;
        }
        const players = await this.store.getMatchPlayers(match.id);
        for (const p of players) {
            if (p.user_id === String(user.id)) continue;
            if (await this.moderation.isBlockedEitherWay(String(user.id), p.user_id)) {
                throw makeError('BLOCKED', 'لا يمكن الجلوس على هذه الطاولة');
            }
        }
        await this.matchService.takeOutSeat(match.id, outSeat, user.id);
        return { tableId: match.table_id, seat: outSeat, replacement: true };
    }

    // ---------- تأكيد الجاهزية ----------
    async confirmReady(user, tableId) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status !== 'ready_check') throw makeError('NO_READY_CHECK', 'لا فحص جاهزية الآن');
        const seats = await this.store.getSeats(tableId);
        const me = seats.find((s) => s.user_id === String(user.id) && s.seat_status === 'seated');
        if (!me) throw makeError('NOT_SEATED', 'لست جالسًا على هذه الطاولة');
        await this.store.setSeatReady(tableId, me.seat, true);
        this.broadcast(tableId, [{ type: 'player_ready', seat: me.seat }]);

        const after = await this.store.getSeats(tableId);
        const ready = after.filter((s) => s.seat_status === 'seated' && s.ready);
        if (ready.length === 4) {
            await this.timers.cancel({ tableId, kinds: ['ready_check'] });
            const matchId = await this.matchService.createMatchForTable(table, after);
            await this.store.setTableStatus(tableId, 'in_match');
            this.broadcast(tableId, [{ type: 'match_started', matchId }]);
            return { ready: true, matchStarted: true, matchId };
        }
        return { ready: true, matchStarted: false };
    }

    // من لم يؤكد خلال المهلة يُستبدل مقعده «فارغ» بلا حرج (Vision §1.4)
    async _onReadyCheckExpired({ tableId }) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status !== 'ready_check') return;
        const seats = await this.store.getSeats(tableId);
        for (const s of seats) {
            if (!s.ready) await this.store.removeSeat(tableId, s.seat);
        }
        // إعادة ضبط جاهزية الباقين والعودة للفتح
        const remaining = await this.store.getSeats(tableId);
        for (const s of remaining) await this.store.setSeatReady(tableId, s.seat, false);
        await this.store.setTableStatus(tableId, 'open');
        if (remaining.length) {
            await this.timers.schedule({ tableId, kind: 'lobby_idle', ttlMs: this.lobbyIdleTtlMs });
        } else {
            await this.store.setTableStatus(tableId, 'closed', { closedBy: 'system' });
        }
        this.broadcast(tableId, [{ type: 'ready_check_expired' }]);
    }

    // خمول الطاولة المفتوحة ← إغلاق هادئ (Architecture §7.2)
    async _onLobbyIdle({ tableId }) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status !== 'open') return;
        await this.store.setTableStatus(tableId, 'closed', { closedBy: 'system' });
    }

    // ---------- المغادرة ----------
    async leave(user, tableId) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status === 'closed') return;
        const seats = await this.store.getSeats(tableId);
        const me = seats.find((s) => s.user_id === String(user.id));
        if (!me) return;

        if (table.status === 'in_match') {
            // خروج نهائي أثناء اللعب ← مسار الاستبدال/الإنهاء الودّي (Vision §1.8)
            const match = await this.store.getActiveMatchForTable(tableId);
            if (match) await this.matchService.abandon(match.id, user.id);
            return { left: true, abandoned: true };
        }

        await this.store.removeSeat(tableId, me.seat);
        if (table.status === 'ready_check') {
            // مغادرة أثناء فحص الجاهزية تلغيه — يعود الباقون للفتح
            await this.timers.cancel({ tableId, kinds: ['ready_check'] });
            const remaining = await this.store.getSeats(tableId);
            for (const s of remaining) await this.store.setSeatReady(tableId, s.seat, false);
            await this.store.setTableStatus(tableId, 'open');
        }
        const remaining = await this.store.getSeats(tableId);
        if (remaining.length === 0) await this.store.setTableStatus(tableId, 'closed', { closedBy: 'system' });
        this.broadcast(tableId, [{ type: 'seat_left', seat: me.seat }]);
        return { left: true, abandoned: false };
    }

    // ---------- ما بعد المباراة: الريماچ (قرار المالك المثبَّت) ----------
    // لا تبدأ المباراة الجديدة إلا بموافقة الأربعة · رفض واحد يُلغي بهدوء
    async onMatchEnded(matchId) {
        const match = await this.store.getMatch(matchId);
        if (!match) return;
        await this.store.setTableStatus(match.table_id, 'post_match');
        await this.store.setRematchState(match.table_id, JSON.stringify({ accepts: [], matchId }));
        this.broadcast(match.table_id, [{ type: 'rematch_offered', matchId }]);
    }

    async onMatchAborted(matchId) {
        const match = await this.store.getMatch(matchId);
        if (!match) return;
        // إنهاء ودّي: الطاولة تعود مفتوحة لمن بقي — بلا خاسر وبلا حرج
        const seats = await this.store.getSeats(match.table_id);
        const seated = seats.filter((s) => s.seat_status === 'seated');
        if (!seated.length) {
            await this.store.setTableStatus(match.table_id, 'closed', { closedBy: 'system' });
        } else {
            await this.store.setTableStatus(match.table_id, 'open');
            await this.timers.schedule({ tableId: match.table_id, kind: 'lobby_idle', ttlMs: this.lobbyIdleTtlMs });
        }
        this.broadcast(match.table_id, [{ type: 'table_reopened' }]);
    }

    async rematchAccept(user, tableId) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status !== 'post_match') throw makeError('NO_REMATCH', 'لا عرض ريماچ الآن');
        const state = JSON.parse(table.rematch_state || '{}');
        const seats = await this.store.getSeats(tableId);
        const me = seats.find((s) => s.user_id === String(user.id));
        if (!me) throw makeError('NOT_SEATED', 'لست على هذه الطاولة');

        if (!state.accepts.includes(String(user.id))) state.accepts.push(String(user.id));
        await this.store.setRematchState(tableId, JSON.stringify(state));
        await this.matchService._logServiceAction(state.matchId, String(user.id), 'REMATCH_ACCEPT', { tableId });
        this.broadcast(tableId, [{ type: 'rematch_accepted', seat: me.seat, count: state.accepts.length }]);

        if (state.accepts.length === 4) {
            // موافقة الأربعة — طاولة ثانية بنفس المقاعد (Vision §1.6)
            const freshSeats = await this.store.getSeats(tableId);
            for (const s of freshSeats) await this.store.setSeatReady(tableId, s.seat, false);
            const matchId = await this.matchService.createMatchForTable(table, freshSeats);
            await this.store.setRematchState(tableId, null);
            await this.store.setTableStatus(tableId, 'in_match');
            this.broadcast(tableId, [{ type: 'match_started', matchId }]);
            return { accepted: true, matchStarted: true, matchId };
        }
        return { accepted: true, matchStarted: false };
    }

    async rematchDecline(user, tableId) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status !== 'post_match') return { declined: false };
        await this.store.setRematchState(tableId, null);
        await this.store.setTableStatus(tableId, 'open');
        const seats = await this.store.getSeats(tableId);
        for (const s of seats) await this.store.setSeatReady(tableId, s.seat, false);
        await this.timers.schedule({ tableId, kind: 'lobby_idle', ttlMs: this.lobbyIdleTtlMs });
        this.broadcast(tableId, [{ type: 'rematch_declined' }]);
        return { declined: true };
    }

    // ---------- إغلاق الطاولة ----------
    async closeTable(user, tableId) {
        const table = await this.store.getTable(tableId);
        if (!table || table.status === 'closed') return;
        if (table.created_by !== String(user.id)) throw makeError('NOT_CREATOR', 'صاحب الطاولة فقط يغلقها');
        if (table.status === 'in_match') throw makeError('TABLE_IN_MATCH', 'لا إغلاق أثناء اللعب');
        await this.timers.cancel({ tableId });
        await this.store.setTableStatus(tableId, 'closed', { closedBy: String(user.id) });
    }
}

BalootTableService.READY_CHECK_TTL_MS = READY_CHECK_TTL_MS;
BalootTableService.LOBBY_IDLE_TTL_MS = LOBBY_IDLE_TTL_MS;

module.exports = BalootTableService;
