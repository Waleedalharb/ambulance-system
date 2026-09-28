// ============================================
// Baloot Engine — bidding.js (sa-standard-1.0)
// آلة السوق: الجولتان، الصن/الحكم/بس/الأشكل (ruleset §4)
// ============================================
'use strict';

const { suitOf } = require('./cards');

// ترتيب السوق: يبدأ يمين الموزّع ويدور (ruleset §2.1/§4.1)
const firstBidder = (dealerSeat) => (dealerSeat + 1) % 4;
const nextSeat = (seat) => (seat + 1) % 4;

// من يملك الأشكل؟ الموزّع واللاعب على يساره فقط (ruleset §4.2)
function canAshkal(seat, dealerSeat) {
    return seat === dealerSeat || seat === (dealerSeat + 3) % 4;
}

function makeError(code, message) {
    const e = new Error(message); e.code = code; return e;
}

// تحقق فعل السوق — يعيد { contract } أو { pass: true } أو { redeal: true } عبر المُستدعي
// hand: { phase, biddingTurn, bids, faceUpCard, dealerSeat }
// action: { seat, kind: 'sun'|'hokum'|'pass'|'ashkal', trumpSuit? }
function validateBid(hand, action) {
    const { seat, kind } = action;
    if (hand.phase !== 'bidding1' && hand.phase !== 'bidding2') {
        throw makeError('NOT_BIDDING_PHASE', 'السوق انتهى');
    }
    if (hand.biddingTurn !== seat) {
        throw makeError('NOT_YOUR_TURN', 'ليس دورك في السوق');
    }
    if (kind === 'pass') return { pass: true };

    if (kind === 'sun') {
        return { contract: { type: 'sun', trumpSuit: null, buyerSeat: seat, viaAshkal: false } };
    }

    if (kind === 'hokum') {
        if (hand.phase === 'bidding1') {
            // الجولة الأولى: الحكم = زات الورقة المكشوفة حصرًا (ruleset §4.1)
            return { contract: { type: 'hokum', trumpSuit: suitOf(hand.faceUpCard), buyerSeat: seat, viaAshkal: false } };
        }
        // الجولة الثانية: أي زات مخالف للورقة المكشوفة يختاره المشتري (ruleset §4.2)
        const ts = action.trumpSuit;
        if (!ts || !['S', 'H', 'D', 'C'].includes(ts)) {
            throw makeError('TRUMP_SUIT_REQUIRED', 'حدّد زات الحكم');
        }
        if (ts === suitOf(hand.faceUpCard)) {
            throw makeError('TRUMP_SUIT_INVALID', 'الحكم في الجولة الثانية يجب أن يكون مخالفًا لزات الورقة المكشوفة');
        }
        return { contract: { type: 'hokum', trumpSuit: ts, buyerSeat: seat, viaAshkal: false } };
    }

    if (kind === 'ashkal') {
        if (hand.phase !== 'bidding2') throw makeError('ASHKAL_ROUND2_ONLY', 'الأشكل في الجولة الثانية فقط');
        if (!canAshkal(seat, hand.dealerSeat)) {
            throw makeError('ASHKAL_NOT_ALLOWED', 'الأشكل للموزّع أو اللاعب على يساره فقط');
        }
        // أشكل: الورقة المكشوفة للشريك المقابل، اللعب صن إجباري، والمُشكِّل هو المشتري (ruleset §4.2)
        return { contract: { type: 'sun', trumpSuit: null, buyerSeat: seat, viaAshkal: true } };
    }

    throw makeError('BID_KIND_INVALID', 'نوع سوق غير معروف');
}

module.exports = { firstBidder, nextSeat, canAshkal, validateBid };
