// ============================================
// Baloot Engine — index.js (sa-standard-1.0)
// آلة الحالات + applyAction — نقية وحتمية (Architecture §2/§3.3/§5)
// state + action → { state', events[] } — بلا DB/IO، الزمن والعشوائية مُحقونة
// أي حالة غير مغطاة هنا تُرفع كقرار — لا اجتهاد (توجيه المالك 2026-09-25)
// ============================================
'use strict';

const {
    deck32, shuffle, rngFor, isValidDeck, suitOf, rankOf, isTrump, powerOf
} = require('./cards');
const { RULESET, TEAM_OF, OTHER_TEAM } = require('./rules');
const { firstBidder, nextSeat, validateBid } = require('./bidding');
const { detectProjects, hasBalootCards, balootBlockedBy, resolveDeclarations } = require('./declarations');
const { trickWinner, toAbnatSun, toAbnatHokum, toAbnat, scoreHand } = require('./scoring');

function makeError(code, message) {
    const e = new Error(message); e.code = code; return e;
}

// ---------- إنشاء المباراة ----------
// seed إلزامي — الحتمية كاملة: نفس seed + نفس الأفعال = نفس المباراة حرفيًا (Architecture §3.3)
function createMatch({ seed, targetScore } = {}) {
    if (!Number.isInteger(seed)) throw makeError('SEED_REQUIRED', 'createMatch: seed عدد صحيح مطلوب');
    return {
        rulesetVersion: RULESET.version,
        seed: seed >>> 0,
        rngCounter: 0,
        targetScore: targetScore || RULESET.targetScore,
        scores: { A: 0, B: 0 },
        handNumber: 0,
        dealerSeat: 3, // أول START_HAND يجعل الموزّع 0 ويبدأ السوق من 1 (يمينه)
        status: 'awaiting_hand', // awaiting_hand | in_hand | finished
        winner: null,
        hand: null,
        seq: 0
    };
}

// ---------- التوزيع (ruleset §3) ----------
function startHand(s, events, testDeck) {
    const dealer = (s.dealerSeat + 1) % 4;
    s.dealerSeat = dealer;
    s.handNumber++;

    let deck;
    if (testDeck !== undefined) {
        // خطاف اختبارات فقط — الخدمة لا ترسله أبدًا؛ يمكّن اختبارات القواعد الحتمية
        if (!isValidDeck(testDeck)) throw makeError('TEST_DECK_INVALID', 'deck اختباري غير صالح');
        deck = testDeck.slice();
    } else {
        deck = shuffle(deck32(), rngFor(s.seed, s.rngCounter++));
    }

    const order = [1, 2, 3, 0].map((i) => (dealer + i) % 4); // يبدأ يمين الموزّع
    const hands = { 0: [], 1: [], 2: [], 3: [] };
    let idx = 0;
    for (let k = 0; k < 3; k++) for (const seat of order) hands[seat].push(deck[idx++]); // 3 لكل لاعب
    for (let k = 0; k < 2; k++) for (const seat of order) hands[seat].push(deck[idx++]); // +2 لكل لاعب
    const faceUpCard = deck[idx++];                                                          // ورقة المشترى
    const remaining = deck.slice(idx);                                                       // 11 ورقة

    s.hand = {
        phase: 'bidding1', // bidding1 | bidding2 | playing
        dealerSeat: dealer,
        hands, faceUpCard, faceUpHolder: null, remaining,
        bids: [], biddingTurn: firstBidder(dealer),
        contract: null,
        double: { multiplier: 1, chain: [], lastRaiserTeam: null, qahwa: false, qahwaTeam: null },
        declarations: { declared: {}, resolved: false, winnerTeam: null, winningProjects: [], tieBreak: null },
        baloot: {}, // seat → 'announced' | 'confirmed'
        tricks: [], currentTrick: [], turnSeat: null
    };
    s.status = 'in_hand';
    events.push({ type: 'hand_started', handNumber: s.handNumber, dealerSeat: dealer });
}

// إكمال التوزيع بعد حسم السوق (ruleset §3-5):
// 3 أوراق لكل لاعب إلا حامل الورقة المكشوفة يأخذ 2 + الورقة (المشتري — أو شريكه في الأشكل)
function completeDealing(hand) {
    const holder = hand.contract.viaAshkal ? (hand.contract.buyerSeat + 2) % 4 : hand.contract.buyerSeat;
    hand.faceUpHolder = holder;
    const order = [1, 2, 3, 0].map((i) => (hand.dealerSeat + i) % 4);
    let idx = 0;
    for (const seat of order) {
        const n = seat === holder ? 2 : 3;
        for (let i = 0; i < n; i++) hand.hands[seat].push(hand.remaining[idx++]);
    }
    hand.hands[holder].push(hand.faceUpCard);
    hand.remaining = [];
}

// هل لاعب رمى أي ورقة في هذه الصفقة؟ (نافذة الإعلان تغلق بعدها — ruleset §7.3)
function playerHasPlayed(hand, seat) {
    if (hand.currentTrick.some((p) => p.seat === seat)) return true;
    return hand.tricks.some((t) => t.plays.some((p) => p.seat === seat));
}

// ---------- اللعب ----------
// اللعب الآلي عند التأخر (ruleset §11): أضعف ورقة من الزات المفتوح،
// وبدون زات: أضعف غير حكم — لا حكم آليًا إلا إذا كل الأوراق حكم. بلا إعلان ولا دبل.
function autoCardFor(hand, seat) {
    const cards = hand.hands[seat];
    const contract = hand.contract;
    if (hand.currentTrick.length > 0) {
        const led = suitOf(hand.currentTrick[0].card);
        const follow = cards.filter((c) => suitOf(c) === led);
        if (follow.length) return weakestOf(follow, contract);
    }
    const nonTrump = cards.filter((c) => !isTrump(c, contract));
    return weakestOf(nonTrump.length ? nonTrump : cards, contract);
}
function weakestOf(cards, contract) {
    return cards.slice().sort((a, b) => powerOf(a, contract) - powerOf(b, contract))[0];
}

// الأوراق المسموحة الآن (للواجهة والاختبارات — ruleset §6-3: الممنوع مطفأ بنيويًا)
function listLegalPlays(hand, seat) {
    if (!hand || hand.phase !== 'playing' || hand.turnSeat !== seat) return [];
    const cards = hand.hands[seat];
    if (hand.currentTrick.length === 0) return cards.slice();
    const led = suitOf(hand.currentTrick[0].card);
    const follow = cards.filter((c) => suitOf(c) === led);
    return follow.length ? follow : cards.slice();
}

// ---------- النواة ----------
// applyAction(state, action) → { state, events }
// action: { type, seat?, ... } — أنواع: START_HAND | BID | DECLARE | PLAY_CARD | DOUBLE | AUTO_PLAY
function applyAction(state, action) {
    if (!state || !action || !action.type) throw makeError('ACTION_INVALID', 'فعل غير صالح');
    if (state.status === 'finished') throw makeError('MATCH_FINISHED', 'المباراة انتهت');

    const s = structuredClone(state);
    const events = [];
    const hand = s.hand;

    switch (action.type) {

        case 'START_HAND': { // فعل خادمي
            if (s.status !== 'awaiting_hand') throw makeError('HAND_ALREADY_RUNNING', 'الصفقة قائمة');
            startHand(s, events, action.deck); // action.deck: خطاف اختبارات فقط
            break;
        }

        case 'BID': {
            const res = validateBid(hand, { seat: action.seat, kind: action.kind, trumpSuit: action.trumpSuit });
            if (res.pass) {
                hand.bids.push({ seat: action.seat, kind: 'pass' });
                events.push({ type: 'bid', seat: action.seat, kind: 'pass' });
                if (hand.bids.length === 4) {
                    if (hand.phase === 'bidding1') {
                        hand.phase = 'bidding2';
                        hand.bids = [];
                        hand.biddingTurn = firstBidder(hand.dealerSeat);
                        events.push({ type: 'bidding_round2' });
                    } else {
                        // بس الجميع في الجولتين ← إعادة توزيع من الموزّع التالي (ruleset §3-6/§12)
                        s.hand = null;
                        s.status = 'awaiting_hand';
                        events.push({ type: 'redeal', handNumber: s.handNumber });
                    }
                } else {
                    hand.biddingTurn = nextSeat(action.seat);
                }
            } else {
                hand.contract = res.contract;
                hand.bids.push({ seat: action.seat, kind: action.kind });
                completeDealing(hand);
                hand.phase = 'playing';
                hand.turnSeat = firstBidder(hand.dealerSeat); // يمين الموزّع يبدأ اللعب (ruleset §3)
                events.push({ type: 'bid', seat: action.seat, kind: action.kind });
                events.push({ type: 'contract_set', contract: hand.contract, faceUpHolder: hand.faceUpHolder });
            }
            break;
        }

        case 'DECLARE': { // { seat, projects: [{type, suit?, rank?, topRank?}] }
            if (!hand || hand.phase !== 'playing') throw makeError('NOT_PLAYING_PHASE', 'لا إعلان خارج اللعب');
            const seat = action.seat;
            if (playerHasPlayed(hand, seat)) {
                throw makeError('DECLARATION_TOO_LATE', 'المشروع يُعلن قبل رمي ورقتك الأولى');
            }
            const detected = detectProjects(hand.hands[seat], hand.contract);
            const declared = hand.declarations.declared[seat] || [];
            const pool = detected.filter((d) => !declared.some((x) => sameProject(x, d)));
            for (const req of action.projects || []) {
                const hit = pool.find((d) =>
                    d.type === req.type &&
                    (req.suit === undefined || d.suit === req.suit) &&
                    (req.rank === undefined || d.rank === req.rank) &&
                    (req.topRank === undefined || d.topRank === req.topRank) &&
                    !declared.some((x) => sameProject(x, d)));
                if (!hit) throw makeError('PROJECT_NOT_FOUND', 'هذا المشروع غير موجود في يدك');
                declared.push(hit);
                events.push({ type: 'declaration_announced', seat, project: hit.type });
            }
            hand.declarations.declared[seat] = declared;
            break;
        }

        case 'PLAY_CARD': {
            applyPlay(s, events, action.seat, action.card, !!action.baloot, false);
            break;
        }

        case 'AUTO_PLAY': { // فعل خادمي عند انتهاء مهلة اللفة (ruleset §11)
            if (!hand || hand.phase !== 'playing') throw makeError('NOT_PLAYING_PHASE', 'لا لعب الآن');
            if (hand.turnSeat !== action.seat) throw makeError('NOT_YOUR_TURN', 'ليس دورك');
            const card = autoCardFor(hand, action.seat);
            events.push({ type: 'auto_play', seat: action.seat, card });
            applyPlay(s, events, action.seat, card, false, true);
            break;
        }

        case 'DOUBLE': { // { seat, kind: 'dabal'|'thri'|'fur'|'qahwa' } (ruleset §9)
            if (!hand || hand.phase !== 'playing') throw makeError('NOT_PLAYING_PHASE', 'لا دبل قبل اللعب');
            applyDouble(s, events, action.seat, action.kind);
            break;
        }

        default:
            throw makeError('ACTION_UNKNOWN', 'نوع فعل غير معروف: ' + action.type);
    }

    s.seq++;
    return { state: s, events };
}

function sameProject(a, b) {
    return a.type === b.type && a.suit === b.suit && a.rank === b.rank && a.topRank === b.topRank;
}

// تنفيذ نزول ورقة + حسم اللفة/الإعلانات/الصفقة/المباراة
function applyPlay(s, events, seat, card, balootFlag, isAuto) {
    const hand = s.hand;
    if (!hand || hand.phase !== 'playing') throw makeError('NOT_PLAYING_PHASE', 'لا لعب الآن');
    if (hand.turnSeat !== seat) throw makeError('NOT_YOUR_TURN', 'ليس دورك');
    if (!hand.hands[seat].includes(card)) throw makeError('CARD_NOT_IN_HAND', 'هذه الورقة ليست في يدك');

    // الرد بالزات إلزامي (ruleset §6-1)
    if (hand.currentTrick.length > 0) {
        const led = suitOf(hand.currentTrick[0].card);
        if (suitOf(card) !== led && hand.hands[seat].some((c) => suitOf(c) === led)) {
            throw makeError('MUST_FOLLOW_SUIT', 'لازم ترد بالزات');
        }
    }

    // البلوت (ruleset §7.1/§7.3): يُعلن مع أول ورقتي الشايب/بنت ويُثبَّت مع الثانية
    if (balootFlag) {
        if (isAuto) throw makeError('AUTO_NO_BALOOT', 'اللعب الآلي لا يعلن بلوت');
        validateBaloot(hand, seat, card);
        hand.baloot[seat] = 'announced';
        events.push({ type: 'baloot_announced', seat });
    }

    hand.hands[seat] = hand.hands[seat].filter((c) => c !== card);
    hand.currentTrick.push({ seat, card });
    events.push({ type: 'card_played', seat, card });

    // إثبات البلوت عند نزول الورقة الثانية من الزوج
    const contract = hand.contract;
    if (hand.baloot[seat] === 'announced' && contract.type === 'hokum' &&
        suitOf(card) === contract.trumpSuit && (rankOf(card) === 'K' || rankOf(card) === 'Q') &&
        !balootFlag) {
        // وصلنا هنا بعد الإعلان — لكن الإعلان نفسه كان مع الورقة الأولى؛ الإثبات مع الثانية
        hand.baloot[seat] = 'confirmed';
        events.push({ type: 'baloot_confirmed', seat });
    }

    if (hand.currentTrick.length < 4) {
        hand.turnSeat = nextSeat(seat);
        return;
    }

    // حسم اللفة (ruleset §5.3)
    const winner = trickWinner(hand.currentTrick, contract);
    hand.tricks.push({ plays: hand.currentTrick, winnerSeat: winner });
    hand.currentTrick = [];
    hand.turnSeat = winner; // آخذ اللفة يفتتح التالية
    events.push({ type: 'trick_won', trickNo: hand.tricks.length, winnerSeat: winner, winnerTeam: TEAM_OF(winner) });

    // كشف المشاريع بعد الدورة الأولى (ruleset §7.3)
    if (hand.tricks.length === 1) {
        const res = resolveDeclarations(hand.declarations.declared, hand.dealerSeat);
        hand.declarations.resolved = true;
        hand.declarations.winnerTeam = res.winnerTeam;
        hand.declarations.winningProjects = res.winningProjects;
        hand.declarations.tieBreak = res.tieBreak;
        events.push({
            type: 'declarations_revealed',
            winnerTeam: res.winnerTeam, tieBreak: res.tieBreak,
            projects: res.winningProjects.map((p) => ({ seat: p.seat, project: p.project.type }))
        });
    }

    if (hand.tricks.length < 8) return;

    // نهاية الصفقة — الحساب التفصيلي (ruleset §8)
    const result = scoreHand(hand);
    s.scores.A += result.delta.A;
    s.scores.B += result.delta.B;
    events.push({ type: 'hand_scored', handNumber: s.handNumber, detail: result.detail });

    // القهوة: من يربح الصفقة يربح المباراة كلها (ruleset §9 — حكم فقط، مُتحقق عند الفعل)
    if (hand.double.qahwa) {
        s.status = 'finished';
        s.winner = result.handWinnerTeam;
        s.handNumber;
        events.push({ type: 'match_ended', winner: s.winner, reason: 'qahwa', scores: { ...s.scores } });
    } else if (s.scores.A >= s.targetScore || s.scores.B >= s.targetScore) {
        s.status = 'finished';
        s.winner = s.scores.A >= s.targetScore ? 'A' : 'B';
        events.push({ type: 'match_ended', winner: s.winner, reason: 'target', scores: { ...s.scores } });
    } else {
        s.status = 'awaiting_hand';
    }
    s.hand = null;
}

// تحقق البلوت: حكم فقط، الورقة شايب/بنت الحكم، الزوج كامل في اليد،
// لا مانع ازدواج مع مية معلنة، ولا إعلان سابق (ruleset §7.1/§7.3)
function validateBaloot(hand, seat, card) {
    const contract = hand.contract;
    if (contract.type !== 'hokum') throw makeError('BALOOT_HOKUM_ONLY', 'البلوت في الحكم فقط');
    if (suitOf(card) !== contract.trumpSuit || (rankOf(card) !== 'K' && rankOf(card) !== 'Q')) {
        throw makeError('BALOOT_CARD_INVALID', 'البلوت = شايب وبنت الحكم');
    }
    if (!hasBalootCards(hand.hands[seat].concat([card]), contract)) {
        throw makeError('BALOOT_INCOMPLETE', 'البلوت يتطلب شايب وبنت الحكم معًا');
    }
    if (hand.baloot[seat]) throw makeError('BALOOT_ALREADY', 'البلوت أُعلن سلفًا');
    const declared = hand.declarations.declared[seat] || [];
    if (balootBlockedBy(declared, contract)) {
        throw makeError('BALOOT_BLOCKED_BY_MIYA', 'البلوت لا يُحسب ضمن مشروع مية مُعلن');
    }
}

// الدبل وسلسلته (ruleset §9)
function applyDouble(s, events, seat, kind) {
    const hand = s.hand;
    const contract = hand.contract;
    const team = TEAM_OF(seat);
    const buyerTeam = TEAM_OF(contract.buyerSeat);
    const d = hand.double;

    switch (kind) {
        case 'dabal': {
            if (team === buyerTeam) throw makeError('DOUBLE_NOT_YOURS', 'الدبل من حق الفريق غير المشتري');
            if (d.multiplier !== 1) throw makeError('DOUBLE_CHAIN_INVALID', 'الدبل الأول فقط الآن');
            if (contract.type === 'sun') {
                // الصن: بعد تجاوز قيد المشتري 100 وقيد المُدبِّل دون 100 (ruleset §9/§14-د)
                if (!(s.scores[buyerTeam] > RULESET.double.sunMinBuyerScore &&
                      s.scores[team] < RULESET.double.sunMaxDoublerScore)) {
                    throw makeError('DOUBLE_SUN_LOCKED', 'الدبل في الصن بعد النشرة (100) فقط وقيدك دونه');
                }
            }
            d.multiplier = 2; d.chain.push({ kind: 'dabal', team }); d.lastRaiserTeam = team;
            break;
        }
        case 'thri': { // حكم فقط — من الفريق الذي وقّع عليه الدبل (المشتري)
            if (contract.type !== 'hokum') throw makeError('THRI_HOKUM_ONLY', 'الثري في الحكم فقط');
            if (team !== buyerTeam) throw makeError('THRI_NOT_YOURS', 'الثري من حق من وُقّع عليه الدبل');
            if (d.multiplier !== 2 || d.chain[d.chain.length - 1].kind !== 'dabal') {
                throw makeError('DOUBLE_CHAIN_INVALID', 'الثري بعد الدبل فقط');
            }
            d.multiplier = 3; d.chain.push({ kind: 'thri', team }); d.lastRaiserTeam = team;
            break;
        }
        case 'fur': { // من فريق الدبل الأول ردًّا على الثري
            if (d.multiplier !== 3 || d.chain[d.chain.length - 1].kind !== 'thri') {
                throw makeError('DOUBLE_CHAIN_INVALID', 'الفور بعد الثري فقط');
            }
            if (team !== d.chain[0].team) throw makeError('FUR_NOT_YOURS', 'الفور من حق فريق الدبل الأول');
            d.multiplier = 4; d.chain.push({ kind: 'fur', team }); d.lastRaiserTeam = team;
            break;
        }
        case 'qahwa': { // حكم فقط، مرة واحدة، من الفريق المتأخر في القيد — من يربح الصفقة يربح المباراة
            if (contract.type !== 'hokum') throw makeError('QAHWA_HOKUM_ONLY', 'القهوة في الحكم فقط');
            if (d.qahwa) throw makeError('QAHWA_ALREADY', 'القهوة وُضعت سلفًا');
            if (s.scores[team] >= s.scores[OTHER_TEAM(team)]) {
                throw makeError('QAHWA_TRAILING_ONLY', 'القهوة من حق الفريق المتأخر في القيد');
            }
            d.qahwa = true; d.qahwaTeam = team;
            break;
        }
        default:
            throw makeError('DOUBLE_KIND_INVALID', 'نوع دبل غير معروف');
    }
    events.push({ type: 'doubled', kind, team, multiplier: d.multiplier, qahwa: d.qahwa });
}

module.exports = {
    createMatch, applyAction,
    autoCardFor, listLegalPlays,
    // مكشوفة للاختبارات وللخدمة (projections لاحقًا)
    detectProjects, resolveDeclarations,
    trickWinner, toAbnatSun, toAbnatHokum, toAbnat, scoreHand,
    RULESET
};
