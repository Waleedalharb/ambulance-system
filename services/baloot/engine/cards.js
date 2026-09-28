// ============================================
// Baloot Engine — cards.js (sa-standard-1.0)
// نموذج الورق والقوة والقيم — نقي بلا DB/IO (Architecture §3.3)
// المرجع: BALOOT-RULESET.md §2.2 / §5 / §7.2 / §8.1
// ============================================
'use strict';

// الزاتات (ruleset §2.3): S=سبيت H=هاص D=ديمن C=شيريا
const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const RANKS = Object.freeze(['7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);

const SUIT_AR = Object.freeze({ S: 'سبيت', H: 'هاص', D: 'ديمن', C: 'شيريا' });
const RANK_AR = Object.freeze({ '7': '7', '8': '8', '9': '9', T: '10', J: 'ولد', Q: 'بنت', K: 'شايب', A: 'إكّه' });

const suitOf = (card) => card[0];
const rankOf = (card) => card[1];

// 32 ورقة — 4 زاتات × 8 قيم (ruleset §2.2)
function deck32() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push(s + r);
    return d;
}

// ترتيب قوة الصن (ruleset §5.1): إكّه > 10 > شايب > بنت > ولد > 9 > 8 > 7
const SUN_POWER = Object.freeze({ A: 8, T: 7, K: 6, Q: 5, J: 4, '9': 3, '8': 2, '7': 1 });
// ترتيب قوة زات الحكم (ruleset §5.2): ولد > 9 > إكّه > 10 > شايب > بنت > 8 > 7
const TRUMP_POWER = Object.freeze({ J: 8, '9': 7, A: 6, T: 5, K: 4, Q: 3, '8': 2, '7': 1 });
// ترتيب التسلسل للمشاريع (ruleset §7.2): إكّه > شايب > بنت > ولد > 10 > 9 > 8 > 7
const DECL_ORDER = Object.freeze({ A: 8, K: 7, Q: 6, J: 5, T: 4, '9': 3, '8': 2, '7': 1 });

// قيم الأوراق بالبنط الخام (ruleset §8.1)
const SUN_POINTS = Object.freeze({ A: 11, T: 10, K: 4, Q: 3, J: 2, '9': 0, '8': 0, '7': 0 });
const TRUMP_POINTS = Object.freeze({ J: 20, '9': 14, A: 11, T: 10, K: 4, Q: 3, '8': 0, '7': 0 });

function isTrump(card, contract) {
    return !!contract && contract.type === 'hokum' && suitOf(card) === contract.trumpSuit;
}

// قوة الورقة في اللعب الجاري (ruleset §5)
function powerOf(card, contract) {
    if (isTrump(card, contract)) return TRUMP_POWER[rankOf(card)];
    return SUN_POWER[rankOf(card)];
}

// قيمة الورقة الخام (ruleset §8.1) — في الحكم: زات الحكم فقط بقيم الحكم، والباقي بقيم الصن
function rawPoints(card, contract) {
    if (isTrump(card, contract)) return TRUMP_POINTS[rankOf(card)];
    return SUN_POINTS[rankOf(card)];
}

// مولّد عشوائية حتمي مُبذَّر (Architecture §3.3: RNG مُحقون — نفس seed = نفس النتيجة)
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// دالة توليد RNG لمرحلة معينة — حتمية من (seed, counter)
function rngFor(seed, counter) {
    return mulberry32(((seed >>> 0) ^ Math.imul((counter + 1) >>> 0, 2654435761)) >>> 0);
}

// خلط فيشر-ياتس حتمي
function shuffle(deck, rng) {
    const d = deck.slice();
    for (let i = d.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [d[i], d[j]] = [d[j], d[i]];
    }
    return d;
}

function isValidDeck(deck) {
    if (!Array.isArray(deck) || deck.length !== 32) return false;
    const set = new Set(deck);
    if (set.size !== 32) return false;
    for (const c of deck) {
        if (typeof c !== 'string' || c.length !== 2) return false;
        if (!SUITS.includes(c[0]) || !RANKS.includes(c[1])) return false;
    }
    return true;
}

module.exports = {
    SUITS, RANKS, SUIT_AR, RANK_AR,
    suitOf, rankOf, deck32,
    SUN_POWER, TRUMP_POWER, DECL_ORDER, SUN_POINTS, TRUMP_POINTS,
    isTrump, powerOf, rawPoints,
    mulberry32, rngFor, shuffle, isValidDeck
};
