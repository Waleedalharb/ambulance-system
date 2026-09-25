// ============================================
// BalootProjection — D3 (Architecture Freeze §A7/§11)
// Serializers لكل دور مشاهد: اللاعب يرى يده فقط، المشاهد لا يرى أي يد.
// الطاقم وترتيبه لا يغادران الخادم أبدًا (Anti-Tamper §11-1/2).
// ============================================
'use strict';

const { SUIT_AR, RANK_AR } = require('./engine/cards');

const cardAr = (c) => ({ code: c, suit: SUIT_AR[c[0]], rank: RANK_AR[c[1]] });

// حالة المباراة بصيغة آمنة لمقعد معيّن: يده كاملة + عدّادات أيدي الآخرين فقط
function forPlayer(engineState, seat, playersBySeat = {}) {
    const h = engineState.hand;
    const base = baseMatch(engineState, playersBySeat);
    if (!h) return { ...base, hand: null };
    return {
        ...base,
        hand: {
            phase: h.phase,
            dealerSeat: h.dealerSeat,
            biddingTurn: h.biddingTurn,
            faceUpCard: h.phase.startsWith('bidding') ? cardAr(h.faceUpCard) : null,
            bids: h.bids,
            contract: h.contract,
            double: h.double,
            declarations: publicDeclarations(h),
            myHand: h.hands[seat] ? h.hands[seat].map(cardAr) : [],
            handCounts: Object.fromEntries([0, 1, 2, 3].map((s) => [s, (h.hands[s] || []).length])),
            currentTrick: h.currentTrick.map((p) => ({ seat: p.seat, card: cardAr(p.card) })),
            tricksCount: h.tricks.length,
            lastTrick: h.tricks.length ? {
                winnerSeat: h.tricks[h.tricks.length - 1].winnerSeat,
                plays: h.tricks[h.tricks.length - 1].plays.map((p) => ({ seat: p.seat, card: cardAr(p.card) }))
            } : null,
            turnSeat: h.turnSeat,
            mySeat: seat
        }
    };
}

// المشاهد الصامت: الطاولة والأوراق المكشوفة على الأرض فقط — بلا أيدٍ إطلاقًا
function forSpectator(engineState, playersBySeat = {}) {
    const h = engineState.hand;
    const base = baseMatch(engineState, playersBySeat);
    if (!h) return { ...base, hand: null };
    return {
        ...base,
        hand: {
            phase: h.phase,
            dealerSeat: h.dealerSeat,
            contract: h.contract,
            double: h.double,
            declarations: publicDeclarations(h),
            handCounts: Object.fromEntries([0, 1, 2, 3].map((s) => [s, (h.hands[s] || []).length])),
            currentTrick: h.currentTrick.map((p) => ({ seat: p.seat, card: cardAr(p.card) })),
            tricksCount: h.tricks.length,
            turnSeat: h.turnSeat
        }
    };
}

function baseMatch(engineState, playersBySeat) {
    return {
        rulesetVersion: engineState.rulesetVersion,
        targetScore: engineState.targetScore,
        scores: engineState.scores,
        handNumber: engineState.handNumber,
        status: engineState.status,
        winner: engineState.winner,
        seq: engineState.seq,
        seats: [0, 1, 2, 3].map((s) => ({
            seat: s,
            team: s % 2 === 0 ? 'A' : 'B',
            name: playersBySeat[s] ? playersBySeat[s].name : null
        }))
    };
}

// المشاريع المكشوفة فقط — المُعلن قبل الكشف يبقى خاصًا بصاحبه
function publicDeclarations(hand) {
    if (!hand.declarations.resolved) return { resolved: false };
    return {
        resolved: true,
        winnerTeam: hand.declarations.winnerTeam,
        tieBreak: hand.declarations.tieBreak,
        projects: hand.declarations.winningProjects.map((p) => ({ seat: p.seat, type: p.project.type })),
        baloot: Object.entries(hand.baloot)
            .filter(([, st]) => st === 'confirmed')
            .map(([seat]) => Number(seat))
    };
}

// قائمة الطاولات في مجلس البلوت — بطاقة «تعال اجلس»
function lobbyTable(table, seats, namesByUser = {}) {
    return {
        id: table.id,
        status: table.status,
        rulesetVersion: table.ruleset_version,
        targetScore: table.target_score,
        seats: [0, 1, 2, 3].map((s) => {
            const row = seats.find((x) => x.seat === s);
            return {
                seat: s,
                occupied: !!row && row.seat_status === 'seated',
                name: row ? (namesByUser[row.user_id] || null) : null,
                disconnected: row ? !!row.disconnected : false
            };
        }),
        createdBy: table.created_by,
        createdAt: table.created_at
    };
}

module.exports = { forPlayer, forSpectator, lobbyTable, cardAr };
